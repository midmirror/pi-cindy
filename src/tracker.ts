/**
 * Pi 会话追踪器 —— 监听 Pi 生命周期，将状态变化同步到 store + device-link push。
 *
 * 消息落库/推送只在 tracker 完成（权威行）：maker:send / 输入队列注入只推状态信号，
 * 避免同一用户消息被 handler 与 tracker 双写双推。
 * push 时间戳一律 ISO 字符串（mobile 契约），会话运行态同步到 busy → presence-set。
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSession, updateSession, getSession, findSessionBySdkId, appendMessage } from "./store/session-store.js";
import type { DeviceLinkClient } from "./device-link/client.js";
import { inputQueueMarkRunning, getSteeringClientId } from "./handlers/maker.js";
import { captureRuntimeCtx } from "./runtime.js";
import { getInstanceId } from "./instance.js";
import { failPendingMailboxForSessions } from "./store/handoff-store.js";
import { consumeMailboxForSession } from "./handoff.js";

/** 被控端 push 截断标记（desktop dispatch.ts mergeRemoteAgentMeta 同名契约）：
 *  mobile preferCompleteMessage 据此不把截断行当完整内容、保留完整侧。 */
const REMOTE_CONTENT_TRUNCATED = "remoteContentTruncated";

function iso(v: number | null | undefined): string | null {
  return v == null ? null : new Date(v).toISOString();
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: unknown): b is { type: string; text?: string } =>
        !!b && typeof b === "object" && (b as { type: string }).type === "text"
        && typeof (b as { text?: unknown }).text === "string")
      .map((b) => (b as { text?: string }).text ?? "")
      .join("\n");
  }
  return "";
}

export function attachSessionTracker(
  pi: ExtensionAPI,
  getClient: () => DeviceLinkClient | null,
  getActiveId: () => string | null,
  setActiveId: (id: string | null) => void,
): void {
  pi.on("session_start", async (_event, ctx) => {
    // 捕获当前 pi 会话的运行时能力（modelRegistry / abort / compact / isIdle），
    // invoke handlers（maker.ts）据此派生 capabilities 与执行远程控制。
    // 必须在 client 检查之前：首次 session_start 时 relay 连接可能仍在途。
    captureRuntimeCtx(ctx);
    // 会话落库不依赖 relay client 就绪：session_start 时连接可能仍在途（index.ts
    // 的 ensureClient 与本节并发），若先判 client 再建会话，手机端 sessions:list
    // 会一直拉不到当前会话（真机复现：会话未落库 → 手机刷新不出）。
    // 先建会话 + setActiveId，push 在 client 就绪后自然可达。
    const sdkId = ctx.sessionManager.getSessionId();
    const cwd = ctx.cwd;

    let session = findSessionBySdkId(sdkId);
    if (!session) {
      session = createSession({
        sdkSessionId: sdkId,
        workingDir: cwd,
        title: `Pi — ${cwd.split("/").pop() || "session"}`,
        // 存纯 model id + providerId（mobile 契约：availableModels.id 匹配会话 model）
        model: ctx.model?.id ?? undefined,
        providerId: ctx.model?.provider ?? null,
        // 会话宿主标注：session_start 的进程即宿主（会话路由目标，见 v0.5.0 spec）
        hostInstanceId: getInstanceId(),
      });
    } else {
      updateSession(session.id, { status: "active", hostInstanceId: getInstanceId(), updatedAt: Date.now() });
    }
    setActiveId(session.id);
    // 会话激活即消费本会话滞留的 pending 邮箱行（M3）：acquire 时只消费当时 activeId，
    // 宿主非前台会话的滞留行靠这里在激活时补消费；重放经 requireActiveSession 门禁，
    // push 依赖 client 就绪（注入不依赖，见 spec §6）。
    await consumeMailboxForSession(session.id).catch(() => {});
    const c = getClient();
    if (!c) return;
    c.push("local-db:sessions:created", { sessionId: session.id });
    c.push("local-db:sessions:patched", { sessionId: session.id, patch: { status: "active" } });
  });

  // pi 模型切换 → 同步会话 model + 推送手机端（模型选择器实时镜像）。
  // 落库不依赖 client（standby 进程也更新共享库，手机端经 owner 读可见）；push 才判空。
  pi.on("model_select", async (event) => {
    const sid = getActiveId();
    if (!sid) return;
    const model = event?.model as { id?: string; provider?: string } | undefined;
    if (!model?.id) return;
    updateSession(sid, { model: model.id, providerId: model.provider ?? null });
    const c = getClient();
    if (!c) return;
    c.push("local-db:sessions:patched", { sessionId: sid, patch: { model: model.id } });
  });

  pi.on("message_end", async (event, ctx) => {
    const sid = getActiveId();
    if (!sid) return;
    // 落库不依赖 client（standby 进程消息也进共享库，手机端经 owner 读可见）；
    // push 才判 c。修：standby 进程消息曾不落库 → 会话永久空白。
    const session = getSession(sid);
    if (!session) return;

    if (event.message.role === "user") {
      const text = textOf(event.message.content);
      const clientId = getSteeringClientId(sid) ?? undefined;
      const m = appendMessage({ id: randomUUID(), sessionId: sid, role: "user", content: text, clientId, createdAt: Date.now() });
      const c = getClient();
      if (c) c.push("local-db:messages:created", { sessionId: sid, message: { id: m.id, clientId: clientId ?? null, sessionId: sid, role: "user", content: text, createdAt: iso(m.createdAt) } }, sid);
    }

    if (event.message.role === "assistant") {
      const text = textOf(event.message.content);
      const usage = event.message.usage;
      const m = appendMessage({
        id: randomUUID(), sessionId: sid, role: "assistant", content: text,
        model: event.message.model, provider: event.message.provider,
        usage: usage ? { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, totalTokens: usage.totalTokens } : undefined,
        stopReason: event.message.stopReason, createdAt: Date.now(),
      });
      // 单次 updateSession 合并用量更新（修：曾 2 次全文件读写 + 1 次多余 getSession 重读）
      let updated: ReturnType<typeof getSession> = session;
      if (usage) {
        updated = updateSession(sid, {
          totalTokenUsage: session.totalTokenUsage + usage.totalTokens,
          totalCostUsd: session.totalCostUsd + ((usage as { cost?: { total?: number } }).cost?.total ?? 0),
          contextTokens: usage.input + usage.cacheRead,
        });
      }
      const c = getClient();
      if (!c) return;
      // push 只带 500 字摘要 + remoteContentTruncated 标记（mobile 据此经 messages:list 拉全文，
      // 不标记会被当作完整内容永久截断显示）；store 始终存全量。
      const truncated = text.length > 500;
      const pushedContent = truncated ? text.slice(0, 500) : text;
      const pushedAgentMeta = truncated ? { [REMOTE_CONTENT_TRUNCATED]: true } : null;
      c.push("local-db:messages:created", {
        sessionId: sid,
        message: { id: m.id, clientId: m.clientId ?? null, sessionId: sid, role: "assistant", content: pushedContent, toolUseId: null, agentMeta: pushedAgentMeta, model: m.model, provider: m.provider, usage: m.usage, stopReason: m.stopReason, createdAt: iso(m.createdAt) },
      }, sid);
      if (updated) {
        c.push("usage:session-spend-changed", { sessionId: sid, totalCostUsd: updated.totalCostUsd }, sid);
        // mobile 读 payload.totalTokens（remoteSessionStore readNumber 'totalTokens'）
        c.push("usage:session-tokens-changed", { sessionId: sid, totalTokens: updated.totalTokenUsage }, sid);
      }
    }
  });

  pi.on("agent_settled", async () => {
    const sid = getActiveId();
    if (!sid) return;
    const session = getSession(sid);
    if (!session) return;
    // 正常收尾：写 lastTurnEndedAt，startedAt > endedAt 不再成立 → 中断判定熄灭（对齐 desktop）。
    // 落库不依赖 client；push/notify 才判 c。
    updateSession(sid, { lastTurnEndedAt: Date.now() });
    inputQueueMarkRunning(sid, false);
    const c = getClient();
    if (!c) return;
    c.setBusy(false);
    c.push("local-db:sessions:activity", { sessionId: sid, phase: "completed", compactDetail: "" }, sid);
    c.notify("session-done", session.title, sid, "Pi session completed");
  });

  pi.on("session_shutdown", async () => {
    const c = getClient();
    const sid = getActiveId();
    // 落库/归档不依赖 client（standby 进程会话也归档，防 active 空白会话永久堆积）；
    // push 才判 c。修：standby 的 c=null → 会话曾永不归档。
    if (sid) {
      // 优雅关闭：自己 pending 邮箱行标 failed（spec §7，M2）。顺序：先邮箱后清 host，
      // 防 pi resume 复用 sdk_session_id 复活后旧 pending 行被重放注入（已放弃的旧消息）。
      failPendingMailboxForSessions([sid]);
      updateSession(sid, { status: "archived", hostInstanceId: null });
      inputQueueMarkRunning(sid, false);
    }
    if (c && sid) {
      c.push("local-db:sessions:patched", { sessionId: sid, patch: { status: "archived" } });
      // 手机端用 maker:status-changed closed 置 running=false
      c.push("maker:status-changed", { sessionId: sid, status: "closed" }, sid);
    }
    c?.setBusy(false);
    setActiveId(null);
  });

  pi.on("turn_start", async () => {
    const sid = getActiveId();
    if (!sid) return;
    // activeTurnStartedAt 供「疑似中断」判定；userSendAt bump 广播 sessions:patched（项目分组收敛）。
    // 落库不依赖 client（standby 会话中断判定数据也完整）；push 才判 c。
    const now = Date.now();
    updateSession(sid, { userSendAt: now, activeTurnStartedAt: now });
    inputQueueMarkRunning(sid, true);
    const c = getClient();
    if (!c) return;
    c.push("local-db:sessions:patched", { sessionId: sid, patch: { userSendAt: iso(now) } }, sid);
    c.setBusy(true);
    c.push("local-db:sessions:activity", { sessionId: sid, phase: "running", compactDetail: "" }, sid);
  });
}

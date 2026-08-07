/**
 * invoke 路由 —— 将手机端 IPC channel dispatch 到对应 handler。
 * 模拟 Cindy Desktop invoke-registry。不支持的 channel 抛 CHANNEL_NOT_ALLOWED。
 */
import * as sessions from "./sessions.js";
import * as messages from "./messages.js";
import * as maker from "./maker.js";
import * as system from "./system.js";
import * as fsBrowse from "./fs-browse.js";
import { getSession, updateSession } from "../store/session-store.js";
import { upsertMailbox, listPendingMailbox, failPendingMailboxForSessions } from "../store/handoff-store.js";
import { getInstanceId, instanceAlive } from "../instance.js";

const ALLOWED = new Set([
  "maker:create-session", "maker:close-session", "maker:abort-session",
  "maker:send", "maker:steer", "maker:list-active",
  "maker:any-session-in-turn", "maker:session-in-turn",
  "maker:resolve-interaction", "maker:get-pending-interactions",
  "maker:set-model", "maker:set-effort", "maker:set-permission-mode", "maker:set-fast-mode", "maker:set-plan-mode",
  "maker:get-capabilities", "maker:list-available-agents",
  // 输入队列（当前手机端会话页发送/停止/转向的唯一路径，见 mobile app/sessions/[sessionId].tsx）
  "maker:input:enqueue", "maker:input:stop", "maker:input:steer", "maker:input:get-projection",
  "maker:input:compact", "maker:input:resume", "maker:input:retry-last-error",
  "maker:input:clear-error", "maker:input:remove", "maker:input:update-text",
  "maker:input:update-content", "maker:input:move", "maker:input:set-expanded",
  "maker:input:set-interaction-lock", "maker:input:set-edit-lock", "maker:input:clear-session",
  // 手机端模型选择器辅助接口（provider 目录 / 价格 / 网关 key）
  "maker:provider:list", "maker:usage:model-pricing", "maker:api-key:present",
  "local-db:sessions:list", "local-db:sessions:get",
  "local-db:messages:list", "local-db:messages:around", "local-db:messages:around-client-id",
  "local-db:recent-workdirs:list",
  "local-db:sessions:patch-meta", "local-db:sessions:interrupted-pending",
  "local-db:sessions:ack-interrupted",
  "device-link:subscribe", "device-link:unsubscribe",
  "maker:agent:status", "maker:agent:binary-version",
  "maker:auth:get-state", "maker:get-context-usage",
  "maker:generate-title", "maker:regenerate-title",
  "maker:message:delete", "local-db:messages:dismiss-error",
  "git-context:get-for-session", "git-context:pr-refs:list", "git-context:pr-status",
  // 手机端常调、desktop 有实现（device-link allowlist 内含 fs 浏览）的系统级 channel；
  // 摘除会致 CHANNEL_NOT_ALLOWED 刷屏 + 手机端功能缺失（见 handlers/system.ts 契约说明）
  "maker:goal:get-status", "maker:schedule:list",
  "notification:clear-session-attention",
  "fs:stat-path",
]);

export interface InvokeContext {
  pi: any;
  push: (channel: string, data: unknown, sessionId?: string) => void;
  activeSessions: Map<string, any>;
  /** 当前前台 Pi 会话 id（非前台会话拒绝发送类操作，防注入串会话）。 */
  activeId?: () => string | null;
  /** 定向接管（index.ts 注入 arbiter.handoffTo）；缺省 = 无接管能力（单进程测试/未接线）。 */
  handoffTo?: (instanceId: string) => Promise<boolean>;
  /** awaiting-handoff 期间 true（防重复 CAS）。 */
  handoffPending?: () => boolean;
  /** 目标实例是否已连续未认领交接（假活熔断，M4）：true → 按死宿主 fail-fast，不发起 handoff。 */
  handoffStruck?: (instanceId: string) => boolean;
}

let ctx: InvokeContext | null = null;
export function setInvokeContext(c: InvokeContext) { ctx = c; }
export function getInvokeContext(): InvokeContext { if (!ctx) throw new Error("Invoke context not init"); return ctx; }

/**
 * 进程本地类 channel：按会话宿主路由；其余 owner 从共享 DB 直接答（见 spec §4）。
 * 集合 = 会话路由 spec 的 SESSION_LOCAL 集（进程本地输入队列 / 会话操作 / 会话配置），
 * 与 router 的 ALLOWED 子集严格对应——不在该集的 channel 不参与路由。
 */
const SESSION_LOCAL = new Set([
  "maker:input:enqueue", "maker:input:stop", "maker:input:steer", "maker:input:get-projection",
  "maker:input:compact", "maker:input:resume", "maker:input:retry-last-error",
  "maker:input:clear-error", "maker:input:remove", "maker:input:update-text",
  "maker:input:update-content", "maker:input:move", "maker:input:set-expanded",
  "maker:input:set-interaction-lock", "maker:input:set-edit-lock", "maker:input:clear-session",
  "maker:send", "maker:steer", "maker:abort-session", "maker:close-session",
  "maker:set-model", "maker:set-effort", "maker:set-permission-mode", "maker:set-fast-mode",
]);

/** 从邮箱 pending 行合成投影（对齐现有 inputProjection 形状，零新字段——mobile 契约不变）。 */
function syntheticProjection(sid: string): Record<string, unknown> {
  const rows = listPendingMailbox(sid);
  const pendingQueue = rows
    .filter((r) => r.kind === "maker:input:enqueue" || r.kind === "maker:input:steer")
    .map((r) => { try { return (JSON.parse(r.payload)[1] as unknown); } catch { return null; } })
    .filter(Boolean);
  const steeringIds = rows.filter((r) => r.kind === "maker:input:steer")
    .map((r) => { try { const it = JSON.parse(r.payload)[1]; return it?.clientId; } catch { return null; } })
    .filter((x): x is string => typeof x === "string");
  return {
    sessionId: sid,
    pendingQueue,
    steeringQueueClientIds: steeringIds,
    queuePaused: false,
    queueExpanded: false,
    queueInteractionLocks: [],
    queueEditLocks: [],
    queueAbortPending: rows.some((r) => r.kind === "maker:input:stop"),
    error: null,
    recovery: null,
    errorRetryText: null,
    credentialSwitchWait: null,
  };
}

function itemClientId(channel: string, args: unknown[]): string | null {
  if (channel === "maker:input:enqueue" || channel === "maker:input:steer") {
    const item = (args[1] ?? null) as { clientId?: unknown } | null;
    return item && typeof item.clientId === "string" ? item.clientId : null;
  }
  return null;
}

/**
 * SESSION_LOCAL 路由判定：按会话宿主三分支。
 *   host==我     → handled=false（走本地 handler，现状语义）
 *   get-projection → 合成投影（只读，不落邮箱不接管，spec §4 例外）
 *   host==null   → NOT_FOUND（明确文案：无活宿主）
 *   host 死      → 清 host + 邮箱 failed + error 投影
 *   host 活      → 邮箱落行 + 定向接管（awaiting 期间不重复 CAS）+ 合成投影
 */
async function routeSessionLocal(channel: string, args: unknown[]): Promise<{ handled: boolean; result?: unknown }> {
  const sid = args[0];
  if (typeof sid !== "string" || !sid) return { handled: false };
  const ctx = getInvokeContext();
  const myId = getInstanceId();
  const s = getSession(sid);
  if (!s) return { handled: false }; // 本地 handler 抛 NOT_FOUND（现状语义）
  const host = s.hostInstanceId ?? null;
  if (host === myId) return { handled: false };
  // 非投影类 channel（send/steer/abort-session/close-session/set-model...）路由响应
  // 必须与本地 handler 同形状 {ok:true}（spec §6，H2）；投影类只含 maker:input:*。
  const isInputChannel = channel.startsWith("maker:input:");
  if (host == null) {
    // unhosted（手机端 create-session / 宿主已退出）：契约码 NOT_FOUND，文案明确
    throw Object.assign(new Error(`Session ${String(sid).slice(0, 8)} has no live agent on this device`), { code: "NOT_FOUND" });
  }
  const alive = instanceAlive(host);
  const struck = alive && (ctx.handoffStruck?.(host) ?? false);
  if (!alive || struck) {
    // 死/假活宿主：清 host + 邮箱 failed；input:* 回 error 投影（复用 error 字段），
    // 非投影类抛 invoke error（与本地 handler 失败路径同形状——路由层统一抛错）。
    failPendingMailboxForSessions([sid]);
    updateSession(sid, { hostInstanceId: null });
    if (isInputChannel) {
      const p = syntheticProjection(sid);
      p.error = "session host unavailable";
      return { handled: true, result: p };
    }
    throw Object.assign(new Error("session host unavailable"), { code: "NOT_FOUND" });
  }
  // get-projection 只读例外（在 host 判定之后）：合成投影，不落邮箱、不接管（spec §4）。
  // 顺序敏感（M1）：必须在 unhosted/死宿主分支之后——手机端轮询 unhosted 会话应得
  // NOT_FOUND、死宿主会话应得 error 投影，而非空队列静默无错。
  if (channel === "maker:input:get-projection") {
    return { handled: true, result: syntheticProjection(sid) };
  }
  // 活宿主：邮箱落行 + 定向接管（awaiting/熔断期间不重复 CAS）+ 合成响应
  upsertMailbox(sid, itemClientId(channel, args), channel, args);
  if (!ctx.handoffPending?.() && ctx.handoffTo) {
    void ctx.handoffTo(host).catch(() => {});
  }
  if (isInputChannel) return { handled: true, result: syntheticProjection(sid) };
  return { handled: true, result: { ok: true } };
}

export async function routeInvoke(channel: string, args: unknown[]): Promise<unknown> {
  if (!ALLOWED.has(channel)) throw Object.assign(new Error(`Channel not allowed: ${channel}`), { code: "CHANNEL_NOT_ALLOWED" });
  if (SESSION_LOCAL.has(channel)) {
    const routed = await routeSessionLocal(channel, args);
    if (routed.handled) return routed.result;
  }
  switch (channel) {
    case "local-db:sessions:list": return sessions.list(args);
    case "local-db:sessions:get": return sessions.get(args);
    case "local-db:sessions:patch-meta": return sessions.patchMeta(args);
    case "local-db:sessions:interrupted-pending": return sessions.interruptedPending(args);
    case "local-db:sessions:ack-interrupted": return sessions.ackInterrupted(args);
    case "local-db:recent-workdirs:list": return sessions.recentWorkdirs(args);
    case "local-db:messages:list": return messages.list(args);
    case "local-db:messages:around": return messages.around(args);
    case "local-db:messages:around-client-id": return messages.aroundByClientId(args);
    case "local-db:messages:dismiss-error": return messages.dismissError(args);
    case "maker:message:delete": return messages.deleteMsg(args);
    case "device-link:subscribe": case "device-link:unsubscribe": return { ok: true };
    case "maker:input:enqueue": return maker.inputEnqueue(args);
    case "maker:input:stop": return maker.inputStop(args);
    case "maker:input:steer": return maker.inputSteer(args);
    case "maker:input:get-projection": return maker.inputGetProjection(args);
    case "maker:input:compact": return maker.inputCompact(args);
    case "maker:input:resume": return maker.inputResume(args);
    case "maker:input:retry-last-error": return maker.inputRetryLastError(args);
    case "maker:input:clear-error": return maker.inputClearError(args);
    case "maker:input:remove": return maker.inputRemove(args);
    case "maker:input:update-text": return maker.inputUpdateText(args);
    case "maker:input:update-content": return maker.inputUpdateContent(args);
    case "maker:input:move": return maker.inputMove(args);
    case "maker:input:set-expanded": return maker.inputSetExpanded(args);
    case "maker:input:set-interaction-lock": return maker.inputSetInteractionLock(args);
    case "maker:input:set-edit-lock": return maker.inputSetEditLock(args);
    case "maker:input:clear-session": return maker.inputClearSession(args);
    case "maker:provider:list": return maker.providerList(args);
    case "maker:usage:model-pricing": return maker.usageModelPricing(args);
    case "maker:api-key:present": return maker.apiKeyPresent(args);
    case "maker:create-session": return maker.createSessionHandler(args);
    case "maker:close-session": return maker.closeSession(args);
    case "maker:abort-session": return maker.abortSession(args);
    case "maker:send": return maker.send(args);
    case "maker:steer": return maker.steer(args);
    case "maker:list-active": return maker.listActive(args);
    case "maker:any-session-in-turn": return maker.anySessionInTurn(args);
    case "maker:session-in-turn": return maker.sessionInTurn(args);
    case "maker:resolve-interaction": return maker.resolveInteraction(args);
    case "maker:get-pending-interactions": return maker.getPendingInteractions(args);
    case "maker:set-model": return maker.setModel(args);
    case "maker:set-effort": return maker.setEffort(args);
    case "maker:set-permission-mode": return maker.setPermissionMode(args);
    case "maker:set-fast-mode": return maker.setFastMode(args);
    case "maker:get-capabilities": return maker.getCapabilities(args);
    case "maker:set-plan-mode": return { ok: true };
    case "maker:list-available-agents": return maker.listAvailableAgents(args);
    case "maker:agent:status": return maker.agentStatus(args);
    case "maker:agent:binary-version": return maker.agentBinaryVersion(args);
    case "maker:auth:get-state": return maker.authGetState(args);
    case "maker:get-context-usage": return maker.getContextUsage(args);
    case "maker:generate-title": case "maker:regenerate-title": return maker.generateTitle(args);
    case "git-context:get-for-session": case "git-context:pr-refs:list": case "git-context:pr-status":
      return { prRefs: [], currentBranch: null };
    case "maker:goal:get-status": return system.goalStatus(args);
    case "maker:schedule:list": return system.scheduleList(args);
    case "notification:clear-session-attention": return system.clearAttention(args);
    case "fs:stat-path": return fsBrowse.statPath(args);
    default: throw Object.assign(new Error(`Unhandled: ${channel}`), { code: "CHANNEL_NOT_ALLOWED" });
  }
}

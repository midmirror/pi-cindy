/**
 * Maker 操作 invoke handler —— maker:*
 * 对接 Pi extension API。
 *
 * 输入队列（maker:input:*）是手机端会话页发送/停止/转向的唯一路径
 * （mobile app/sessions/[sessionId].tsx 全部走 input.enqueue/stop/steer），
 * 按 desktop input-queue 投影语义实现：pendingQueue + steeringQueueClientIds +
 * queueAbortPending + error 字段，变更经 `maker:input:projection` push 回流。
 * 队列为内存态（扩展重载即清空；手机端打开会话时经 get-projection 重新拉取）。
 *
 * 2026-08-06 修复（对齐 mobile 消费方契约）：
 *  - get-capabilities 输出 mobile 契约形状（availableModels/effortLevels/permissionModes/
 *    hasFastMode/planMode 对象），模型清单从 pi modelRegistry 派生；
 *  - list-available-agents 返回 MobileAgentKind[]（原 {agents:[...]} 手机端解析为空）；
 *  - pi.sendUserMessage 返回 void：去掉 .catch() 链（原同步抛 TypeError 致 enqueue 报错），
 *    注入前先 apply item.model/effort（setModel/setThinkingLevel）；
 *  - stop/abort 改走 ctx.abort（ExtensionAPI 顶层无 abort，pi().abort?.() 恒 undefined）；
 *  - 补齐手机端常规路径的其余 input 通道（compact/resume/remove/update/move/clear 等）。
 */
import { randomUUID } from "node:crypto";
import { createSession, getSession, updateSession, listSessions } from "../store/session-store.js";
import { getInvokeContext } from "./router.js";
import {
  getRuntimeModels, getCurrentModel, getRuntimeContextUsage, getScopedThinkingLevel,
  providerDisplayName,
  abortRuntime, isRuntimeIdle, compactRuntime,
  resolvePiModel, effortsForModel, normalizeEffort,
  EFFORT_DISPLAY_NAMES, PI_EFFORTS,
} from "../runtime.js";

function pi(): any { return getInvokeContext().pi; }
function push(ch: string, data: unknown, sid?: string) { getInvokeContext().push(ch, data, sid); }

function isoNow(): string { return new Date().toISOString(); }

/** 手机端 QueuedRemoteMessage 的投影（mobile src/session/types.ts 必填字段子集）。 */
export interface QueuedRemoteMessage {
  clientId: string;
  text: string;
  persistedContent?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  workingDir?: string;
  createOpts?: Record<string, unknown>;
  /** mobile isQueuedRemoteMessage 校验必填：chatMessage 记录（role === "user"）。 */
  chatMessage?: { clientId: string; role: "user"; content: string; createdAt?: string } & Record<string, unknown>;
}

interface QueueEntry {
  item: QueuedRemoteMessage;
  queuedAt: number;
}

function readQueueItem(raw: unknown): QueuedRemoteMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.clientId !== "string" || typeof o.text !== "string") return null;
  // 附件（files / images）Pi 被控端不支持：显式报错而非静默丢弃（否则手机端显示已发送但内容缺失）。
  const cm = o.chatMessage && typeof o.chatMessage === "object" ? o.chatMessage as Record<string, unknown> : null;
  const files = Array.isArray(o.files) ? o.files : (Array.isArray(cm?.files) ? cm?.files : null);
  const images = Array.isArray(cm?.images) ? cm?.images : null;
  if ((files && files.length > 0) || (images && images.length > 0)) {
    throw Object.assign(new Error("Attachments (files/images) are not supported on Pi host"), { code: "INVALID_PARAMS" });
  }
  const item: QueuedRemoteMessage = { clientId: o.clientId, text: o.text };
  if (typeof o.persistedContent === "string") item.persistedContent = o.persistedContent;
  if (typeof o.model === "string") item.model = o.model;
  if (typeof o.effort === "string") item.effort = o.effort;
  if (typeof o.permissionMode === "string") item.permissionMode = o.permissionMode;
  if (typeof o.workingDir === "string") item.workingDir = o.workingDir;
  if (o.createOpts && typeof o.createOpts === "object") item.createOpts = o.createOpts as Record<string, unknown>;
  // chatMessage 必须透传：mobile isQueuedRemoteMessage 校验 chatMessage.role === "user"，
  // 缺失则投影 pendingQueue 整段被过滤、队列 UI 空白。
  if (cm && typeof cm.clientId === "string" && cm.role === "user" && typeof cm.content === "string") {
    const chatMsg = { clientId: cm.clientId, role: "user", content: cm.content } as NonNullable<QueuedRemoteMessage["chatMessage"]>;
    if (typeof cm.createdAt === "string") chatMsg.createdAt = cm.createdAt;
    item.chatMessage = chatMsg;
  }
  return item;
}

function invalidParams(message: string): never {
  throw Object.assign(new Error(message), { code: "INVALID_PARAMS" });
}

// ---------- 输入队列状态（内存态） ----------

/** sessionId → 待发送队列。 */
const queues = new Map<string, QueueEntry[]>();
/** sessionId → 正在注入 agent 的 clientId（steering）。 */
const steeringClientIdBySession = new Map<string, string>();
/** sessionId → 已请求中断（abort 在途）。 */
const abortPending = new Set<string>();
/** sessionId → agent 是否正在运行（tracker turn_start / agent_settled 维护）。 */
const running = new Set<string>();
/** sessionId → 最近一次注入错误（投递给手机端投影）。 */
const queueErrors = new Map<string, string>();
/** sessionId → queuePaused / queueExpanded 展示态（内存态，投影用）。 */
const queuePaused = new Set<string>();
const queueExpanded = new Set<string>();

/**
 * 近期已受理 enqueue/steer clientId 环形窗口（弱网重发防线，对齐 desktop
 * RECENT_ENQUEUED_CLIENT_IDS）：同 (session, clientId) 重发直接 no-op，防双注入。
 * 窗口 32 条/session，超限滚动淘汰；inputClearSession 清空。
 */
const recentClientIds = new Map<string, string[]>();
function isRecentClientId(sid: string, cid: string): boolean {
  return (recentClientIds.get(sid) ?? []).includes(cid);
}
function rememberClientId(sid: string, cid: string): void {
  const arr = recentClientIds.get(sid) ?? [];
  arr.push(cid);
  if (arr.length > 32) arr.shift();
  recentClientIds.set(sid, arr);
}

function inputProjection(sid: string): Record<string, unknown> {
  const steeringClientId = steeringClientIdBySession.get(sid);
  return {
    sessionId: sid,
    pendingQueue: (queues.get(sid) ?? []).map((e) => e.item),
    steeringQueueClientIds: steeringClientId ? [steeringClientId] : [],
    queuePaused: queuePaused.has(sid),
    queueExpanded: queueExpanded.has(sid),
    queueInteractionLocks: [],
    queueEditLocks: [],
    queueAbortPending: abortPending.has(sid),
    error: queueErrors.get(sid) ?? null,
    recovery: null,
    errorRetryText: null,
    credentialSwitchWait: null,
  };
}

function pushProjection(sid: string): Record<string, unknown> {
  const p = inputProjection(sid);
  push("maker:input:projection", p, sid);
  return p;
}

/** tracker 调用：turn_start → running=true；agent_settled → running=false 并冲刷队列。 */
export function inputQueueMarkRunning(sid: string, isRunning: boolean): void {
  if (isRunning) {
    running.add(sid);
    queueErrors.delete(sid);
    return;
  }
  running.delete(sid);
  abortPending.delete(sid);
  steeringClientIdBySession.delete(sid);
  inputQueueFlush(sid);
}

/**
 * 正在注入（steering）的 queue item clientId。tracker message_end 落库用户消息时透传，
 * mobile isFirstMessageApplied 靠 clientId 匹配「消息已应用」，缺失会误判未应用导致重发。
 */
export function getSteeringClientId(sid: string): string | null {
  return steeringClientIdBySession.get(sid) ?? null;
}

/** 队列非空且 agent 空闲时，注入下一条（应用模型/effort 后 sendUserMessage）。 */
export function inputQueueFlush(sid: string): void {
  const q = queues.get(sid);
  if (!q || q.length === 0 || running.has(sid) || queuePaused.has(sid)) return;
  const entry = q.shift()!;
  if (q.length === 0) queues.delete(sid);
  steeringClientIdBySession.set(sid, entry.item.clientId);
  pushProjection(sid);
  void (async () => {
    try {
      // 模型/effort 是提示：解析失败不阻塞发送（手机端草稿可能与 pi 目录不同步）。
      if (entry.item.model) {
        const m = resolvePiModel(entry.item.model);
        if (m) await pi().setModel?.(m);
      }
      if (entry.item.effort) {
        pi().setThinkingLevel?.(normalizeEffort(entry.item.effort));
      }
      // pi.sendUserMessage 返回 void（同步注入），无 Promise 可 await/catch。
      pi().sendUserMessage?.(entry.item.text, { deliverAs: "followUp" });
    } catch (err: any) {
      queueErrors.set(sid, err?.message ?? String(err));
      steeringClientIdBySession.delete(sid);
      pushProjection(sid);
    }
  })();
}

// ---------- maker:input:* handlers ----------

/** Pi 同时只有前台一个会话可注入；非前台会话（历史/泄漏行）拒绝，防串上下文。 */
function requireActiveSession(sid: string): void {
  const activeId = getInvokeContext().activeId?.() ?? null;
  if (activeId !== sid) {
    throw Object.assign(new Error(`Session ${String(sid).slice(0, 8)} is not the active Pi session`), { code: "NOT_FOUND" });
  }
}

/** userSendAt bump 广播 sessions:patched（desktop touchUserSendInDb 语义：mobile 项目分组收敛）。 */
function touchUserSend(sid: string): void {
  updateSession(sid, { userSendAt: Date.now() });
  push("local-db:sessions:patched", { sessionId: sid, patch: { userSendAt: new Date().toISOString() } }, sid);
}

export async function inputEnqueue(args: unknown[]) {
  const sid = args[0] as string;
  const item = readQueueItem(args[1]);
  if (!sid) invalidParams("sessionId required");
  if (!item) invalidParams("invalid queue item");
  requireActiveSession(sid);
  const s = getSession(sid);
  if (!s) throw Object.assign(new Error("Not found"), { code: "NOT_FOUND" });
  // 弱网重发防线：同 clientId 重发 no-op（防双注入），仅在确认会话存在后记入。
  // 顺序敏感（L1）：remember 必须等 touchUserSend（DB 写，可能抛错）成功后再记——
  // 先记后写若写失败，重发同 clientId 会被 no-op，消息丢失。
  if (item.clientId && isRecentClientId(sid, item.clientId)) {
    return pushProjection(sid);
  }
  touchUserSend(sid);
  const q = queues.get(sid) ?? [];
  q.push({ item, queuedAt: Date.now() });
  queues.set(sid, q);
  inputQueueFlush(sid);
  if (item.clientId) rememberClientId(sid, item.clientId);
  return pushProjection(sid);
}

export async function inputStop(args: unknown[]) {
  const sid = args[0] as string;
  if (!sid) invalidParams("sessionId required");
  const opts = (args[1] && typeof args[1] === "object" ? args[1] : {}) as { keepQueue?: boolean; pauseQueue?: boolean };
  abortPending.add(sid);
  abortRuntime();
  // 对齐 desktop inputCoordinator.stop：keepQueue=false 时清空待发队列；pauseQueue 置暂停态（resume 恢复）
  if (opts.keepQueue !== true) {
    queues.delete(sid);
    steeringClientIdBySession.delete(sid);
    queueErrors.delete(sid);
  }
  if (opts.pauseQueue === true) queuePaused.add(sid);
  // 空闲时 abort 无 turn 可断：立即清 abortPending，避免投影卡「停止中」直到下次 turn（修 inputStop 卡死）
  if (isRuntimeIdle()) abortPending.delete(sid);
  return pushProjection(sid);
}

export async function inputSteer(args: unknown[]) {
  const sid = args[0] as string;
  const item = readQueueItem(args[1]);
  if (!sid) invalidParams("sessionId required");
  if (!item) invalidParams("invalid queue item");
  requireActiveSession(sid);
  if (item.text === "stop" || item.text === "interrupt" || (args[2] as { type?: string } | undefined)?.type === "stop") {
    abortPending.add(sid);
    abortRuntime();
    if (isRuntimeIdle()) abortPending.delete(sid);
  } else {
    // 弱网重发防线：同 clientId steer 重发 no-op
    if (item.clientId && isRecentClientId(sid, item.clientId)) {
      return pushProjection(sid);
    }
    touchUserSend(sid);
    steeringClientIdBySession.set(sid, item.clientId);
    pushProjection(sid);
    if (item.clientId) rememberClientId(sid, item.clientId);
    try {
      if (item.model) {
        const m = resolvePiModel(item.model);
        if (m) await pi().setModel?.(m);
      }
      if (item.effort) pi().setThinkingLevel?.(normalizeEffort(item.effort));
      pi().sendUserMessage?.(item.text, { deliverAs: "steer" });
    } catch {}
  }
  return pushProjection(sid);
}

export async function inputGetProjection(args: unknown[]) {
  const sid = args[0] as string;
  if (!sid) invalidParams("sessionId required");
  return inputProjection(sid);
}

export async function inputCompact(args: unknown[]) {
  const sid = args[0] as string;
  if (!sid) invalidParams("sessionId required");
  compactRuntime();
  return pushProjection(sid);
}

export async function inputResume(args: unknown[]) {
  const sid = args[0] as string;
  if (!sid) invalidParams("sessionId required");
  queuePaused.delete(sid);
  queueErrors.delete(sid);
  inputQueueFlush(sid);
  return pushProjection(sid);
}

export async function inputRetryLastError(args: unknown[]) {
  const sid = args[0] as string;
  if (!sid) invalidParams("sessionId required");
  queueErrors.delete(sid);
  abortPending.delete(sid);
  inputQueueFlush(sid);
  return pushProjection(sid);
}

export async function inputClearError(args: unknown[]) {
  const sid = args[0] as string;
  if (!sid) invalidParams("sessionId required");
  queueErrors.delete(sid);
  return pushProjection(sid);
}

export async function inputRemove(args: unknown[]) {
  const sid = args[0] as string;
  const clientId = args[1] as string;
  if (!sid) invalidParams("sessionId required");
  const q = queues.get(sid);
  if (q) {
    const next = q.filter((e) => e.item.clientId !== clientId);
    if (next.length === 0) queues.delete(sid); else queues.set(sid, next);
  }
  return pushProjection(sid);
}

export async function inputUpdateText(args: unknown[]) {
  const sid = args[0] as string;
  const clientId = args[1] as string;
  const text = args[2] as string;
  if (!sid) invalidParams("sessionId required");
  if (typeof text !== "string") invalidParams("text required");
  const q = queues.get(sid);
  if (q) {
    for (const e of q) if (e.item.clientId === clientId) e.item.text = text;
  }
  return pushProjection(sid);
}

export async function inputUpdateContent(args: unknown[]) {
  const sid = args[0] as string;
  const clientId = args[1] as string;
  const item = readQueueItem(args[2]);
  if (!sid) invalidParams("sessionId required");
  const q = queues.get(sid);
  if (q && item) {
    for (const e of q) if (e.item.clientId === clientId) e.item = { ...e.item, ...item };
  }
  return pushProjection(sid);
}

export async function inputMove(args: unknown[]) {
  const sid = args[0] as string;
  const clientId = args[1] as string;
  const targetIndex = Number(args[2]);
  if (!sid) invalidParams("sessionId required");
  const q = queues.get(sid);
  if (q && Number.isFinite(targetIndex)) {
    const idx = q.findIndex((e) => e.item.clientId === clientId);
    if (idx >= 0) {
      const [entry] = q.splice(idx, 1);
      q.splice(Math.max(0, Math.min(targetIndex, q.length)), 0, entry);
    }
  }
  return pushProjection(sid);
}

export async function inputSetExpanded(args: unknown[]) {
  const sid = args[0] as string;
  const expanded = args[1] === true;
  if (!sid) invalidParams("sessionId required");
  if (expanded) queueExpanded.add(sid); else queueExpanded.delete(sid);
  return pushProjection(sid);
}

export async function inputSetInteractionLock(_args: unknown[]) { return inputProjection(_args[0] as string); }
export async function inputSetEditLock(_args: unknown[]) { return inputProjection(_args[0] as string); }

export async function inputClearSession(args: unknown[]) {
  const sid = args[0] as string;
  if (!sid) invalidParams("sessionId required");
  queues.delete(sid);
  steeringClientIdBySession.delete(sid);
  abortPending.delete(sid);
  queueErrors.delete(sid);
  queuePaused.delete(sid);
  queueExpanded.delete(sid);
  recentClientIds.delete(sid);
  return pushProjection(sid);
}

// ---------- 会话生命周期 ----------

export async function createSessionHandler(args: unknown[]) {
  const opts = args[0] && typeof args[0] === "object" ? (args[0] as Record<string, unknown>) : {};
  const models = getRuntimeModels();
  const defaultModel = models[0]?.id ?? "claude-sonnet-4-5";
  // mobile 预生成 id 必须透传（对齐 maker-core 幂等语义）：乐观行/路由/订阅全 keyed by 该 id，
  // 被控端另起 id 会让 mobile 抛 sessionIdNotAdopted 确定性失败。已存在同 id 会话 → 幂等复用。
  const requestedId = typeof opts.id === "string" && opts.id ? opts.id : undefined;
  const existing = requestedId ? getSession(requestedId) : null;
  const s = existing ?? createSession({
    id: requestedId,
    workingDir: typeof opts.workingDir === "string" ? opts.workingDir : undefined,
    workspaceKind: opts.workspaceKind === "dialogue" ? "dialogue" : "project",
    model: typeof opts.model === "string" ? opts.model : defaultModel,
    effort: typeof opts.effort === "string" ? opts.effort : "high",
    permissionMode: typeof opts.permissionMode === "string" ? opts.permissionMode : "ask",
    providerId: typeof opts.providerId === "string" ? opts.providerId : (models[0]?.provider ?? null),
  });
  if (!existing) push("local-db:sessions:created", { sessionId: s.id });
  // mobile normalizeCreateSessionResult 读 sessionId/agentKind/workDir
  return { sessionId: s.id, agentKind: "pi", workDir: s.workingDir ?? null };
}

export async function closeSession(args: unknown[]) {
  const sid = args[0] as string;
  updateSession(sid, { status: "archived" });
  queues.delete(sid);
  steeringClientIdBySession.delete(sid);
  abortPending.delete(sid);
  running.delete(sid);
  queueErrors.delete(sid);
  push("local-db:sessions:patched", { sessionId: sid, patch: { status: "archived" } });
  // 手机端用 maker:status-changed 的 closed 置 running=false（remoteSessionStore.ts:2089-2093）
  push("maker:status-changed", { sessionId: sid, status: "closed" }, sid);
  return { ok: true };
}

export async function abortSession(args: unknown[]) {
  const sid = args[0] as string;
  abortPending.add(sid);
  abortRuntime();
  return { ok: true };
}

function extractText(content: unknown): string {
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

export async function send(args: unknown[]) {
  const sid = args[0] as string;
  const msg = args[1] && typeof args[1] === "object" ? (args[1] as Record<string, unknown>) : {};
  const text = extractText(msg.content);
  if (!text) invalidParams("empty message");
  requireActiveSession(sid);
  touchUserSend(sid);
  // 状态推送走手机端消费的 sessions:activity（maker:event 的 status_changed 手机端不消费，
  // 参考 remoteSessionStore.applyMakerEvent 无该分支）；消息权威行由 tracker message_end 落库推送。
  push("local-db:sessions:activity", { sessionId: sid, phase: "running", compactDetail: "" }, sid);
  try {
    pi().sendUserMessage?.(text, { deliverAs: "followUp" });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    push("local-db:sessions:activity", { sessionId: sid, phase: "error", compactDetail: detail }, sid);
  }
  return { ok: true };
}

export async function steer(args: unknown[]) {
  const sid = args[0] as string;
  const action = args[1] && typeof args[1] === "object" ? (args[1] as Record<string, unknown>) : {};
  if (action.type === "stop" || action.type === "interrupt") {
    abortRuntime();
    if (isRuntimeIdle()) abortPending.delete(sid);
  } else if (typeof action.text === "string" && action.text) {
    requireActiveSession(sid);
    touchUserSend(sid);
    try {
      pi().sendUserMessage?.(action.text, { deliverAs: "steer" });
    } catch {}
  }
  return { ok: true };
}

export async function listActive(_args: unknown[]) {
  // 对齐 desktop maker:list-active 形状：{sessionId, agentKind, workDir, capabilities, isTurnRunning}
  return listSessions({ status: "active" }).map(s => ({
    sessionId: s.id,
    agentKind: "pi",
    workDir: s.workingDir ?? null,
    capabilities: undefined,
    isTurnRunning: !isRuntimeIdle(),
  }));
}

export async function anySessionInTurn(_args: unknown[]) {
  return { inTurn: listSessions({ status: "active" }).length > 0 };
}

export async function sessionInTurn(args: unknown[]) {
  const s = getSession(args[0] as string);
  return { inTurn: s?.status === "active" };
}

export async function resolveInteraction(_args: unknown[]) { return { ok: true }; }
export async function getPendingInteractions(_args: unknown[]) { return []; }

export async function setModel(args: unknown[]) {
  const [sid, model] = args as [string, string];
  const providerId = typeof args[2] === "string" ? args[2] : undefined;
  if (!sid || !model) invalidParams("sessionId and model required");
  const resolved = resolvePiModel(model, providerId);
  if (!resolved) {
    throw Object.assign(new Error(`Model not available: ${model}`), { code: "NOT_FOUND" });
  }
  updateSession(sid, { model, providerId: providerId ?? resolved.provider });
  push("local-db:sessions:patched", { sessionId: sid, patch: { model } });
  try {
    const ok = await pi().setModel?.(resolved);
    if (ok === false) {
      throw Object.assign(new Error(`No API key for model ${model}`), { code: "MODEL_UNAVAILABLE" });
    }
  } catch (err: any) {
    if (err?.code === "MODEL_UNAVAILABLE") throw err;
    // pi.setModel 抛错（如模型不可用）不阻断，会话元数据已更新
  }
  return { ok: true };
}

export async function setEffort(args: unknown[]) {
  const [sid, effort] = args as [string, string];
  if (!sid || !effort) invalidParams("sessionId and effort required");
  updateSession(sid, { effort });
  push("local-db:sessions:patched", { sessionId: sid, patch: { effort } });
  try { pi().setThinkingLevel?.(normalizeEffort(effort)); } catch {}
  return { ok: true };
}

export async function setPermissionMode(args: unknown[]) {
  const [sid, mode] = args as [string, string];
  if (!sid || !mode) invalidParams("sessionId and mode required");
  updateSession(sid, { permissionMode: mode });
  push("local-db:sessions:patched", { sessionId: sid, patch: { permissionMode: mode } });
  return { ok: true };
}

export async function setFastMode(args: unknown[]) {
  const [sid, fast] = args as [string, boolean];
  updateSession(sid, { fastMode: fast === true });
  push("local-db:sessions:patched", { sessionId: sid, patch: { fastMode: fast === true } });
  return { ok: true };
}

/**
 * 手机端 MobileAgentCapabilities 契约（maker-shared/src/agentCapabilities.ts）：
 * availableModels=ModelDescriptor[] / effortLevels=EffortDescriptor[] /
 * permissionModes={id,displayName}[] / hasFastMode / planMode:{supported} /
 * supportsSessionAgentSwitch。模型清单从 pi modelRegistry 派生：
 *   - 白名单（--models / enabledModels → scopedModels）非空 → 只列白名单；
 *   - 未配置白名单 → 全量 getAvailable()，按 id 首见去重（对齐 desktop mergeCapabilityList）；
 *   - displayName 前缀 provider 展示名（同 id 多 provider 时可区分）。
 */
export async function getCapabilities(_args: unknown[]) {
  const models = getRuntimeModels();
  const seen = new Set<string>();
  const availableModels: Record<string, unknown>[] = [];
  for (const m of models) {
    if (!m || typeof m.id !== "string" || seen.has(m.id)) continue;
    seen.add(m.id);
    const efforts = effortsForModel(m);
    const effortDisplayNames: Record<string, string> = {};
    for (const e of efforts) effortDisplayNames[e] = EFFORT_DISPLAY_NAMES[e] ?? e;
    const base = typeof m.name === "string" && m.name ? m.name : m.id;
    const pn = providerDisplayName(m.provider);
    // name 已含 provider 名则不重复拼接（如 "Anthropic Claude X"）
    const displayName = pn && !base.toLowerCase().startsWith(pn.toLowerCase())
      ? `${pn} ${base}`
      : base;
    // 白名单 pin 了 thinkingLevel → 作该模型默认 effort（对齐 /scoped-models 语义）
    const pinned = getScopedThinkingLevel(m.id);
    const defaultEffort = pinned && pinned !== "off" && efforts.includes(pinned)
      ? pinned
      : efforts.includes("high") ? "high" : (efforts[0] ?? null);
    availableModels.push({
      id: m.id,
      displayName,
      description: undefined,
      contextWindow: m.contextWindow ?? 200000,
      efforts,
      effortDisplayNames,
      defaultEffort,
      supportsFastMode: false,
    });
  }
  return {
    switchModel: { supported: true },
    availableModels,
    hasFastMode: false,
    effort: { supported: true },
    effortLevels: PI_EFFORTS.map((e) => ({
      id: e,
      displayName: EFFORT_DISPLAY_NAMES[e],
      description: undefined,
    })),
    reasoningDisplay: [],
    permissionModes: [
      { id: "ask", displayName: "Ask" },
      { id: "auto", displayName: "Auto" },
      { id: "bypassPermissions", displayName: "Bypass" },
    ],
    setPermissionModeMidSession: { supported: false, reason: "not-implemented" },
    multimodal: {
      text: { supported: true },
      image: { supported: false, reason: "not-implemented" },
      file: { supported: false, reason: "not-implemented" },
    },
    fork: { supported: false, reason: "not-implemented" },
    rewind: { supported: false, reason: "not-implemented" },
    sessionTree: { supported: false, reason: "not-implemented" },
    abort: { supported: true },
    sameTurnSteer: { supported: true },
    memory: { supported: false, reason: "not-implemented" },
    extraDirs: { supported: false, reason: "not-implemented" },
    sessionHtmlExport: { supported: true },
    manualCompact: { supported: true },
    planMode: { supported: false, reason: "not-implemented" },
    supportsSessionAgentSwitch: false,
  };
}

/** 手机端契约：MobileAgentKind[]（原返回 {agents:[...]}，手机端解析为空数组）。 */
export async function listAvailableAgents(_args: unknown[]) {
  return ["pi"];
}

export async function agentStatus(_args: unknown[]) {
  const active = listSessions({ status: "active" });
  return { connected: true, busy: active.length > 0 || !isRuntimeIdle(), sessionCount: active.length };
}

export async function agentBinaryVersion(_args: unknown[]) { return { version: "pi-1.0.0" }; }
export async function authGetState(_args: unknown[]) {
  return { authenticated: true, identity: "pi-user", authSource: "oauth" };
}

export async function getContextUsage(args: unknown[]) {
  const runtime = getRuntimeContextUsage() as { tokens?: number; contextTokens?: number; totalTokens?: number; window?: number; contextWindow?: number; limit?: number } | null | undefined;
  const s = (args[0] as string) ? getSession(args[0] as string) : null;
  const tokens = runtime?.tokens ?? runtime?.contextTokens ?? runtime?.totalTokens ?? s?.contextTokens ?? 0;
  const window = runtime?.window ?? runtime?.contextWindow ?? runtime?.limit ?? s?.contextWindow ?? 200000;
  return { contextTokens: tokens, contextWindow: window, usageRatio: window > 0 ? tokens / window : 0 };
}

export async function generateTitle(args: unknown[]) {
  // 兼容两种调用：args[0] 为 sessionId 字符串（老）或 { sessionId }（maker:regenerate-title）
  const first = args[0];
  const sid = typeof first === "string" ? first : (first && typeof first === "object" ? (first as Record<string, unknown>).sessionId as string : undefined);
  if (!sid) invalidParams("sessionId required");
  const title = `Pi Session ${sid.slice(0, 8)}`;
  updateSession(sid, { title });
  push("local-db:sessions:patched", { sessionId: sid, patch: { title } });
  return { title };
}
// get-session-tree / navigate-session-tree 已摘除：Pi 无原生分支树 API，伪造单节点树会让手机端
// 把假数据当真实分支渲染（对齐 mobile piSessionTreeModel 形状校验）；能力位 sessionTree 置 false。

// ---------- provider / usage（手机端模型选择器辅助，容忍性接口） ----------

/** 手机端 provider-aware 模式数据源；pi 无目录 → 返回空，手机端回退 capabilities 扁平列表。 */
export async function providerList(_args: unknown[]) {
  return { providers: [], modelVisibilityOverrides: {} };
}

export async function usageModelPricing(_args: unknown[]) { return {}; }
export async function apiKeyPresent(_args: unknown[]) { return { present: false }; }

// ---------- 手机端 `/` palette 三源（list-agent-commands / list-agent-skills / list-desktop-commands） ----------
//
// mobile 契约（packages/maker-shared/src/composerPalette.ts + mobileMakerTransport.ts）：
//   - maker:list-agent-commands → {success, commands?: MobileSlashCommand[]}，kind='agent-builtin'
//   - maker:list-agent-skills   → {success, skills?: MobileSlashCommand[]}，kind='agent-skill'（source 'user'|'skill'）
//   - maker:list-desktop-commands → {success, commands?: MobileSlashCommand[]}，kind='desktop'
// 失败一律返回 {success:false,error,...}（desktop register.ts 形状），不抛 invoke error——
// 手机端 withTransientRemoteRetry 遇 invoke reject 会重试，把确定性失败当瞬态刷屏。
//
// 数据源 = pi 顶层 pi.getCommands()（ExtensionAPI）：当前会话已注册的扩展命令
// （source='extension'）+ prompt templates（source='prompt'）+ skills（source='skill'，
// name 带 `skill:` 前缀，与 pi 侧 _expandSkillCommand 的 /skill:name 识别一致）。
// 映射对齐 desktop 语义：agent 层能力（扩展命令）→ agent-builtin；用户/项目层
// （templates + skills）→ agent-skill。参数 [agentKind, opts] 忽略（pi-cindy 单 agent）。

interface PiSlashEntry {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: { path?: string; scope?: string };
}

function piSlashCommands(): PiSlashEntry[] {
  try {
    const piApi = pi();
    const getCommands = piApi?.getCommands;
    const rows = typeof getCommands === "function" ? getCommands() : null;
    if (!Array.isArray(rows)) return [];
    // 逐行过滤非对象行（修：曾整体 cast，单行 null 会让下游 .filter 抛 TypeError →
    // 整面板 error。数据源为本机 pi API 可信，防御性过滤即可）。
    return (rows as unknown[]).filter((r): r is PiSlashEntry => !!r && typeof r === "object");
  } catch {
    return []; // getCommands 不可用（老 pi）→ 空清单，不阻断 palette
  }
}

function slashListPayload(kind: "builtin" | "skill") {
  const rows = piSlashCommands();
  if (kind === "builtin") {
    const commands = rows
      .filter((c) => c.source === "extension")
      .map((c) => ({
        kind: "agent-builtin" as const,
        name: c.name,
        description: c.description ?? "",
      }));
    return { success: true as const, commands };
  }
  const skills = rows
    .filter((c) => c.source === "prompt" || c.source === "skill")
    .map((c) => ({
      kind: "agent-skill" as const,
      name: c.name,
      description: c.description ?? "",
      // mobile ComposerSlashCommand.source 联合类型只有 'user' | 'skill'；pi prompt → user
      source: c.source === "skill" ? ("skill" as const) : ("user" as const),
      path: c.sourceInfo?.path ?? undefined,
      scope: c.sourceInfo?.scope ?? undefined,
      enabled: true,
    }));
  return { success: true as const, skills };
}

/** 手机端 `/` palette agent-builtin 源：pi 已注册扩展命令（如 /cindy-status）。 */
export async function listAgentCommands(_args: unknown[]) {
  try {
    return slashListPayload("builtin");
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { success: false, error, commands: [] };
  }
}

/** 手机端 `/` palette agent-skill 源：pi prompt templates + skills（发送即 /skill:name）。 */
export async function listAgentSkills(_args: unknown[]) {
  try {
    return slashListPayload("skill");
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { success: false, error, skills: [] };
  }
}

/** desktop 自有命令（main 进程 DesktopCommandRegistry，如 /learn）；pi-cindy 无 → 空。 */
export async function listDesktopCommands(_args: unknown[]) {
  return { success: true, commands: [] };
}

/**
 * 消息相关 invoke handler —— local-db:messages:*
 *
 * 契约（对齐 desktop localDb/ipc/messages.ts + mobile 消费方）：
 *  - `messages:list(sessionId, {limit, before, beforeTs, after})`：before/after 为消息 ID
 *    游标（先按 id 解析到行再取窗口）；**输出恒为降序（最新在前）**——desktop 对 after
 *    游标先 ASC 取窗再 reverse，两分支输出一致；beforeTs 为毫秒时间戳兜底；clearedAt 边界。
 *  - `messages:around(sessionId, messageId, {radius})`：以消息为锚取前后窗口，
 *    `[...before.reverse(), anchor, ...after]` 升序输出，radius 默认 60 / 上限 200。
 *  - `messages:around-client-id(sessionId, clientId, {radius, contentCharLimit})`：
 *    以 clientId 锚定，同上；contentCharLimit 截断正文（引用上下文用）。
 *  - 行输出带 clientId / agentMeta（mobile 合并与去重依赖）。
 */
import { listMessages, deleteMessage, getSession, deleteMessageByClientId } from "../store/session-store.js";
import type { PiMessageMeta } from "../types.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const AROUND_DEFAULT_RADIUS = 60;
const AROUND_MAX_RADIUS = 200;

function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(n), 1), MAX_LIMIT);
}

function clampRadius(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return AROUND_DEFAULT_RADIUS;
  return Math.min(Math.max(Math.floor(n), 0), AROUND_MAX_RADIUS);
}

function iso(v: number | null | undefined): string | null {
  return v == null ? null : new Date(v).toISOString();
}

function mapMessage(m: PiMessageMeta) {
  return {
    id: m.id, clientId: m.clientId ?? null, sessionId: m.sessionId, role: m.role, content: m.content,
    toolUseId: null, agentMeta: null,
    model: m.model, provider: m.provider, usage: m.usage,
    stopReason: m.stopReason, createdAt: iso(m.createdAt),
  };
}

/** 升序行列表 → 取「最新 limit 条」并反转为降序（对齐 desktop DESC 输出契约）。 */
function newestWindow(ms: PiMessageMeta[], limit: number) {
  return ms.slice(-limit).reverse();
}

/** 升序行列表 → 取「最旧 limit 条」并反转为降序（desktop after 游标分支语义）。 */
function oldestWindowReversed(ms: PiMessageMeta[], limit: number) {
  return ms.slice(0, limit).reverse();
}

export async function list(args: unknown[]) {
  const sid = args[0] as string;
  const opts = (args[1] && typeof args[1] === "object" ? args[1] : {}) as Record<string, unknown>;
  const limit = clampLimit(opts.limit);
  const before = typeof opts.before === "string" ? opts.before : undefined;
  const beforeTs = typeof opts.beforeTs === "number" && Number.isFinite(opts.beforeTs) ? opts.beforeTs : undefined;
  const after = typeof opts.after === "string" ? opts.after : undefined;

  let ms = listMessages(sid); // 升序（createdAt）
  let afterMode = false;
  if (before) {
    const idx = ms.findIndex((m) => m.id === before);
    if (idx >= 0) ms = ms.slice(0, idx); // 严格早于游标行
  } else if (beforeTs !== undefined) {
    ms = ms.filter((m) => m.createdAt < beforeTs!);
  } else if (after) {
    const idx = ms.findIndex((m) => m.id === after);
    if (idx >= 0) ms = ms.slice(idx + 1); // 严格晚于游标行
    afterMode = true;
  }
  // 会话已 /clear：过滤 clearedAt 之前的旧消息（对齐 desktop clearedAt 边界）
  const session = getSession(sid);
  if (session?.clearedAt != null) ms = ms.filter((m) => m.createdAt > session.clearedAt!);
  // 输出恒降序：after 分支取窗口最旧端反转，其余取最新端反转（对齐 desktop orderBy/reverse）
  const rows = afterMode ? oldestWindowReversed(ms, limit) : newestWindow(ms, limit);
  return rows.map(mapMessage);
}

export async function around(args: unknown[]) {
  const sid = args[0] as string;
  const mid = args[1] as string;
  const opts = (args[2] && typeof args[2] === "object" ? args[2] : {}) as Record<string, unknown>;
  const radius = clampRadius(opts.radius);
  const all = listMessages(sid);
  const session = getSession(sid);
  if (!session) throw Object.assign(new Error("Session not found"), { code: "NOT_FOUND" });
  const clearedAt = session.clearedAt ?? null;
  // 锚点与窗口都按 clearedAt 边界过滤（对齐 desktop：锚点查询也带 visibleConds）
  const visible = clearedAt == null ? all : all.filter((m) => m.createdAt > clearedAt!);
  const anchorIdx = visible.findIndex((m) => m.id === mid);
  if (anchorIdx < 0) throw Object.assign(new Error("Message not found"), { code: "NOT_FOUND" });
  const anchor = visible[anchorIdx];
  const before = visible.slice(0, anchorIdx).slice(-radius);
  const after = visible.slice(anchorIdx + 1).slice(0, radius);
  return [...before, anchor, ...after].map(mapMessage);
}

export async function aroundByClientId(args: unknown[]) {
  const sid = args[0] as string;
  const cid = args[1] as string;
  const opts = (args[2] && typeof args[2] === "object" ? args[2] : {}) as Record<string, unknown>;
  const radius = clampRadius(opts.radius);
  const contentCharLimit = typeof opts.contentCharLimit === "number" && Number.isInteger(opts.contentCharLimit)
    ? Math.min(Math.max(opts.contentCharLimit, 1), 8000)
    : null;
  const all = listMessages(sid);
  const session = getSession(sid);
  if (!session) throw Object.assign(new Error("Session not found"), { code: "NOT_FOUND" });
  const clearedAt = session.clearedAt ?? null;
  const visible = clearedAt == null ? all : all.filter((m) => m.createdAt > clearedAt!);
  const visibleAnchorIdx = visible.findIndex((m) => m.clientId === cid);
  if (visibleAnchorIdx < 0) throw Object.assign(new Error("Message not found"), { code: "NOT_FOUND" });
  const anchor = visible[visibleAnchorIdx];
  const before = visible.slice(0, visibleAnchorIdx).slice(-radius);
  const after = visible.slice(visibleAnchorIdx + 1).slice(0, radius);
  const rows = [...before, anchor, ...after];
  if (contentCharLimit != null) {
    for (const m of rows) {
      if (m.content.length > contentCharLimit) m.content = m.content.slice(0, contentCharLimit);
    }
  }
  return rows.map(mapMessage);
}

export async function dismissError(_args: unknown[]) { return { ok: true }; }

export async function deleteMsg(args: unknown[]) {
  const sid = args[0] as string;
  const id = args[1] as string;
  // 兼容按 id 或按 clientId 删除（desktop message:delete 语义）
  return { ok: deleteMessage(sid, id) || deleteMessageByClientId(sid, id) };
}

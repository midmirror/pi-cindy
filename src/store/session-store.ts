/**
 * 本地会话/消息存储 —— SQLite 实现（node:sqlite）
 * 模拟 Cindy Desktop localDb sessions 表 + messages 表的语义。
 * 对外导出签名与 JSON 版完全一致（handler 层零改动）。
 * 多进程共享同一 db 文件：WAL + 单行写，并发安全。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PiSessionMeta, PiMessageMeta } from "../types.js";
import { getStmt, DATA_DIR } from "./db.js";

// 会话/消息 id 白名单：UUID / cuid 字符集，阻断路径穿越（保留 JSON 版防御语义，
// 虽 SQLite 无文件路径，但 handler 层校验与参数错误码契约需保持）。
const SID_RE = /^[A-Za-z0-9-]{1,64}$/;
function requireSafeSid(sid: string): string {
  if (typeof sid !== "string" || !SID_RE.test(sid)) {
    throw Object.assign(new Error(`invalid sessionId: ${String(sid).slice(0, 40)}`), { code: "INVALID_PARAMS" });
  }
  return sid;
}

/** 会话行 → PiSessionMeta（列名 snake_case → 字段 camelCase）。 */
function rowToSession(r: Record<string, unknown>): PiSessionMeta {
  const n = (v: unknown, d = 0): number => (typeof v === "number" ? v : d);
  const s: PiSessionMeta = {
    id: String(r.id), title: String(r.title ?? "New Pi Session"),
    workingDir: r.working_dir == null ? "" : String(r.working_dir),
    workspaceKind: (r.workspace_kind as "project" | "dialogue") ?? "project",
    model: String(r.model ?? "claude-sonnet-4-6"), effort: String(r.effort ?? "high"),
    permissionMode: String(r.permission_mode ?? "ask"),
    status: (r.status as "active" | "archived" | "deleted") ?? "active",
    sdkSessionId: r.sdk_session_id == null ? undefined : String(r.sdk_session_id),
    totalTokenUsage: n(r.total_token_usage), totalCostUsd: n(r.total_cost_usd),
    totalCostAmount: n(r.total_cost_amount), totalCostCurrency: r.total_cost_currency == null ? undefined : (r.total_cost_currency as "CNY" | "USD"),
    totalCostIsApproximate: !!r.total_cost_is_approximate,
    contextTokens: n(r.context_tokens), contextWindow: n(r.context_window),
    fastMode: !!r.fast_mode, planModeEnabled: !!r.plan_mode_enabled,
    clearedAt: r.cleared_at == null ? null : n(r.cleared_at),
    pinnedAt: r.pinned_at == null ? null : n(r.pinned_at),
    hostInstanceId: r.host_instance_id == null ? null : String(r.host_instance_id),
    summary: r.summary == null ? null : String(r.summary),
    providerId: r.provider_id == null ? null : String(r.provider_id),
    agentKind: String(r.agent_kind ?? "pi"),
    userSendAt: r.user_send_at == null ? null : n(r.user_send_at),
    createdAt: n(r.created_at), updatedAt: n(r.updated_at),
    activeTurnStartedAt: r.active_turn_started_at == null ? null : n(r.active_turn_started_at),
    lastTurnEndedAt: r.last_turn_ended_at == null ? null : n(r.last_turn_ended_at),
  };
  return s;
}

/** 消息行 → PiMessageMeta（agent_meta JSON 反序列化）。 */
function rowToMessage(r: Record<string, unknown>): PiMessageMeta {
  let agentMeta: Record<string, unknown> | null = null;
  try { if (r.agent_meta != null) agentMeta = JSON.parse(String(r.agent_meta)); } catch { /* ok */ }
  const m: PiMessageMeta = {
    id: String(r.id), sessionId: String(r.session_id),
    role: r.role as PiMessageMeta["role"],
    clientId: r.client_id == null ? undefined : String(r.client_id),
    content: String(r.content), createdAt: Number(r.created_at),
  };
  if (agentMeta) {
    if (typeof agentMeta.model === "string") m.model = agentMeta.model;
    if (typeof agentMeta.provider === "string") m.provider = agentMeta.provider;
    if (agentMeta.usage && typeof agentMeta.usage === "object") m.usage = agentMeta.usage as PiMessageMeta["usage"];
    if (typeof agentMeta.stopReason === "string") m.stopReason = agentMeta.stopReason;
  }
  return m;
}

function agentMetaOf(m: PiMessageMeta): string | null {
  if (m.model == null && m.provider == null && m.usage == null && m.stopReason == null) return null;
  return JSON.stringify({ model: m.model ?? null, provider: m.provider ?? null, usage: m.usage ?? null, stopReason: m.stopReason ?? null });
}

// Session CRUD
export function createSession(p: Partial<PiSessionMeta> = {}): PiSessionMeta {
  const now = Date.now();
  const s: PiSessionMeta = {
    id: p.id ?? randomUUID(), title: p.title ?? "New Pi Session",
    workingDir: p.workingDir ?? process.cwd(), workspaceKind: p.workspaceKind ?? "project",
    model: p.model ?? "claude-sonnet-4-6", effort: p.effort ?? "high",
    permissionMode: p.permissionMode ?? "ask", status: "active",
    sdkSessionId: p.sdkSessionId, totalTokenUsage: 0, totalCostUsd: 0,
    totalCostAmount: 0, totalCostIsApproximate: false,
    contextTokens: 0, contextWindow: p.contextWindow ?? 200000,
    fastMode: false, planModeEnabled: false, clearedAt: null, pinnedAt: null,
    summary: null, providerId: p.providerId ?? null, agentKind: "pi",
    userSendAt: null, createdAt: now, updatedAt: now,
    activeTurnStartedAt: null, lastTurnEndedAt: null, hostInstanceId: p.hostInstanceId ?? null,
  };
  getStmt(`INSERT INTO sessions (
    id, title, working_dir, workspace_kind, model, effort, permission_mode, status,
    host_instance_id, sdk_session_id, total_token_usage, total_cost_usd, total_cost_amount, total_cost_currency,
    total_cost_is_approximate, context_tokens, context_window, fast_mode, plan_mode_enabled,
    provider_id, agent_kind, summary, pinned_at, cleared_at, user_send_at,
    active_turn_started_at, last_turn_ended_at, created_at, updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
    .run(s.id, s.title, s.workingDir, s.workspaceKind, s.model, s.effort, s.permissionMode, s.status,
      s.hostInstanceId ?? null, s.sdkSessionId ?? null, s.totalTokenUsage, s.totalCostUsd, s.totalCostAmount, s.totalCostCurrency ?? null,
      s.totalCostIsApproximate ? 1 : 0, s.contextTokens, s.contextWindow, s.fastMode ? 1 : 0, s.planModeEnabled ? 1 : 0,
      s.providerId, s.agentKind, s.summary, s.pinnedAt, s.clearedAt, s.userSendAt,
      s.activeTurnStartedAt, s.lastTurnEndedAt, s.createdAt, s.updatedAt);
  return s;
}

export function getSession(id: string): PiSessionMeta | null {
  const row = getStmt("SELECT * FROM sessions WHERE id = ?").get(requireSafeSid(id)) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : null;
}

export function listSessions(f?: { status?: string; workingDir?: string }): PiSessionMeta[] {
  let sql = "SELECT * FROM sessions";
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f?.status) { where.push("status = ?"); params.push(f.status); }
  else { where.push("status != 'deleted'"); }
  if (f?.workingDir) { where.push("working_dir = ?"); params.push(f.workingDir); }
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY updated_at DESC";
  const rows = getStmt(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/** camelCase 字段 → snake_case 列（updateSession 定点 SET 用；id/createdAt/updatedAt 除外）。 */
const COL_OF: Record<string, string> = {
  title: "title", workingDir: "working_dir", workspaceKind: "workspace_kind", model: "model",
  effort: "effort", permissionMode: "permission_mode", status: "status",
  sdkSessionId: "sdk_session_id", totalTokenUsage: "total_token_usage",
  totalCostUsd: "total_cost_usd", totalCostAmount: "total_cost_amount",
  totalCostCurrency: "total_cost_currency", totalCostIsApproximate: "total_cost_is_approximate",
  contextTokens: "context_tokens", contextWindow: "context_window", fastMode: "fast_mode",
  planModeEnabled: "plan_mode_enabled", providerId: "provider_id", agentKind: "agent_kind",
  summary: "summary", pinnedAt: "pinned_at", clearedAt: "cleared_at", userSendAt: "user_send_at",
  activeTurnStartedAt: "active_turn_started_at", lastTurnEndedAt: "last_turn_ended_at",
  hostInstanceId: "host_instance_id",
};

/** 字段值 → SQL 列值：布尔列转 0/1，其余原样（null/undefined → NULL）。 */
function sqlValue(k: string, v: unknown): string | number | null {
  if (k === "totalCostIsApproximate" || k === "fastMode" || k === "planModeEnabled") return v ? 1 : 0;
  if (v == null) return null;
  return typeof v === "boolean" ? (v ? 1 : 0) : (v as string | number);
}

/** 定点列 UPDATE：只写 patch 涉及的列 + updated_at，不做整行 read-modify-write。
 *  修：曾 getSession → 全行 merge → 28 列整行 UPDATE——多进程共享库下 standby 的
 *  tracker 写（token/lastTurnEndedAt/archived）与 owner 的 mobile patch（title/
 *  pinnedAt/status）并发同行，last-writer 用陈旧快照吞掉对方字段。定点 SET 后不同列
 *  的并发写互不覆盖；updated_at 谁后写归谁（列表按活动排序的预期语义）。 */
export function updateSession(id: string, patch: Partial<PiSessionMeta>): PiSessionMeta | null {
  requireSafeSid(id);
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = COL_OF[k];
    if (!col) continue; // id/createdAt/updatedAt 等内部列：不参与外部 patch
    sets.push(`${col} = ?`);
    vals.push(sqlValue(k, v));
  }
  const now = Date.now();
  sets.push("updated_at = ?");
  vals.push(now);
  vals.push(id);
  const r = getStmt(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  if (Number(r.changes) === 0) return null;
  return getSession(id);
}

export function patchSessionMeta(id: string, patch: Record<string, unknown>): PiSessionMeta | null {
  // 对齐 desktop local-db:sessions:patch-meta：仅 status / title / pinnedAt，
  // 字段白名单 + status 枚举校验（与 JSON 版逻辑一致）。
  const allowed = new Set(["status", "title", "pinnedAt"]);
  const f: Partial<PiSessionMeta> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.has(k)) {
      throw Object.assign(new Error(`field not allowed in patch-meta: ${k}`), { code: "INVALID_PARAMS" });
    }
    if (k === "status" && v !== "active" && v !== "archived" && v !== "deleted") {
      throw Object.assign(new Error(`invalid status: ${String(v)}`), { code: "INVALID_PARAMS" });
    }
    if (k === "title" && typeof v !== "string") {
      throw Object.assign(new Error("title must be a string"), { code: "INVALID_PARAMS" });
    }
    if (k === "pinnedAt" && v !== null && typeof v !== "string") {
      throw Object.assign(new Error("pinnedAt must be a string or null"), { code: "INVALID_PARAMS" });
    }
    (f as Record<string, unknown>)[k] = v === null ? null : (k === "pinnedAt" ? Date.parse(v as string) : v);
  }
  return updateSession(id, f);
}

export function findSessionBySdkId(sdkSessionId: string): PiSessionMeta | null {
  const row = getStmt("SELECT * FROM sessions WHERE sdk_session_id = ?").get(sdkSessionId) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : null;
}

export function deleteSession(id: string): void {
  requireSafeSid(id);
  getStmt("DELETE FROM messages WHERE session_id = ?").run(id);
  getStmt("DELETE FROM sessions WHERE id = ?").run(id);
}

// Message CRUD
// 幂等语义：同 (session_id, client_id) 重复 append 静默丢弃（ON CONFLICT DO NOTHING，
// 对齐 desktop messages 表 UNIQUE 索引；mobile 重试防重）。注意：同 id 不同 clientId
// 会触发 PK 冲突抛 SQLITE_CONSTRAINT（UUID 碰撞概率可忽略；JSON 版静默接受，语义差异）。
export function appendMessage(msg: PiMessageMeta): PiMessageMeta {
  requireSafeSid(msg.sessionId);
  getStmt(`INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, agent_kind, created_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(session_id, client_id) DO NOTHING`)
    .run(msg.id, msg.clientId ?? null, msg.sessionId, msg.role, msg.content, agentMetaOf(msg), "pi", msg.createdAt);
  return msg;
}

export function listMessages(
  sid: string,
  opts?: { limit?: number; before?: number; after?: number },
): PiMessageMeta[] {
  requireSafeSid(sid);
  const params: (string | number)[] = [sid];
  let sql = "SELECT * FROM messages WHERE session_id = ?";
  if (opts?.after) { sql += " AND created_at > ?"; params.push(opts.after); }
  if (opts?.before) { sql += " AND created_at < ?"; params.push(opts.before); }
  if (opts?.limit && opts.limit > 0) {
    // 取「最新 limit 条」：倒序取 limit 再反转（对齐 JSON 版 slice(-limit) 升序语义）
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(opts.limit);
    const rows = getStmt(sql).all(...params) as Record<string, unknown>[];
    return rows.reverse().map(rowToMessage);
  }
  sql += " ORDER BY created_at ASC";
  const rows = getStmt(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

export function deleteMessage(sid: string, msgId: string): boolean {
  requireSafeSid(sid);
  const r = getStmt("DELETE FROM messages WHERE id = ? AND session_id = ?").run(msgId, sid);
  return r.changes > 0;
}

export function deleteMessageByClientId(sid: string, clientId: string): boolean {
  requireSafeSid(sid);
  const r = getStmt("DELETE FROM messages WHERE client_id = ? AND session_id = ?").run(clientId, sid);
  return r.changes > 0;
}

export function getMessageCount(sid: string): number {
  requireSafeSid(sid);
  const row = getStmt("SELECT COUNT(*) AS c FROM messages WHERE session_id = ?").get(sid) as { c: number };
  return Number(row.c);
}

export function getInterruptedSessions(): PiSessionMeta[] {
  const rows = getStmt(`SELECT * FROM sessions WHERE status = 'active'
    AND active_turn_started_at IS NOT NULL
    AND (last_turn_ended_at IS NULL OR active_turn_started_at > last_turn_ended_at)`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToSession);
}

export function loadOrCreateDeviceId(): string {
  const f = path.join(DATA_DIR, "device-id");
  try { return fs.readFileSync(f, "utf8").trim(); } catch {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const id = randomUUID();
    fs.writeFileSync(f, id, { mode: 0o600 });
    return id;
  }
}

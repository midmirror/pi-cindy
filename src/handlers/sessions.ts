/**
 * 会话相关 invoke handler —— local-db:sessions:*
 * 参数与返回对齐 desktop localDb ipc（sessions:list 位置参数 [limit, status, options]；
 * 时间戳为 ISO 字符串，mobile 契约 RemoteSession.createdAt 等为 string 并走 localeCompare）。
 */
import { listSessions, getSession, patchSessionMeta, getInterruptedSessions, updateSession } from "../store/session-store.js";
import type { PiSessionMeta } from "../types.js";

const DEFAULT_LIST_LIMIT = 20;

function clampLimit(raw: unknown, fallback: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 200);
}

/** 毫秒 → ISO 字符串；null/undefined 保持 null（mobile 契约 string | null）。 */
function iso(v: number | null | undefined): string | null {
  return v == null ? null : new Date(v).toISOString();
}

function mapSession(s: PiSessionMeta) {
  return {
    id: s.id, title: s.title, workingDir: s.workingDir, workspaceKind: s.workspaceKind,
    model: s.model, effort: s.effort, permissionMode: s.permissionMode, status: s.status,
    sdkSessionId: s.sdkSessionId, totalTokenUsage: s.totalTokenUsage, totalCostUsd: s.totalCostUsd,
    totalCostAmount: s.totalCostAmount, totalCostCurrency: s.totalCostCurrency,
    totalCostIsApproximate: s.totalCostIsApproximate, contextTokens: s.contextTokens,
    contextWindow: s.contextWindow, fastMode: s.fastMode, planModeEnabled: s.planModeEnabled,
    clearedAt: iso(s.clearedAt), pinnedAt: iso(s.pinnedAt), summary: s.summary,
    providerId: s.providerId, agentKind: s.agentKind, userSendAt: iso(s.userSendAt),
    // mobile 契约：activeTurnStartedAt/lastTurnEndedAt 为 unix 毫秒 number（非 ISO）
    activeTurnStartedAt: s.activeTurnStartedAt, lastTurnEndedAt: s.lastTurnEndedAt,
    createdAt: iso(s.createdAt), updatedAt: iso(s.updatedAt),
  };
}

export async function list(args: unknown[]) {
  // 位置参数 [limit, status, options]（mobile app/devices/[deviceId].tsx 与
  // desktop localDb/ipc/sessions.ts 同构）
  const limit = clampLimit(args[0], DEFAULT_LIST_LIMIT);
  const status = args[1];
  const options = args[2] && typeof args[2] === "object" ? (args[2] as Record<string, unknown>) : {};
  const statusFilter = status === "active" || status === "archived" ? status : null;
  const includePinned = options.includePinned === true;

  const rows = listSessions(statusFilter ? { status: statusFilter } : undefined);
  let result;
  if (includePinned) {
    // 置顶会话不受 cap 限制、优先展示（对齐 desktop includePinned 合并语义）。
    const pinned = rows.filter((s) => s.pinnedAt != null);
    const base = rows.slice(0, limit);
    const pinnedIds = new Set(pinned.map((s) => s.id));
    result = [...pinned, ...base.filter((s) => !pinnedIds.has(s.id))];
  } else {
    result = rows.slice(0, limit);
  }
  return result.map(mapSession);
}

export async function get(args: unknown[]) {
  const s = getSession(args[0] as string);
  if (!s) throw Object.assign(new Error("Not found"), { code: "NOT_FOUND" });
  return mapSession(s);
}

export async function patchMeta(args: unknown[]) {
  const s = patchSessionMeta(args[0] as string, (args[1] ?? {}) as Record<string, unknown>);
  if (!s) throw Object.assign(new Error("Not found"), { code: "NOT_FOUND" });
  return { id: s.id, title: s.title, status: s.status, pinnedAt: iso(s.pinnedAt), summary: s.summary, updatedAt: iso(s.updatedAt) };
}

export async function interruptedPending(_args: unknown[]) {
  return getInterruptedSessions().map(s => s.id);
}

export async function ackInterrupted(args: unknown[]) {
  // 「忽略」= 写一次正常收尾时刻，startedAt > endedAt 不再成立（对齐 desktop ackSessionTurnEndedDurable）
  const sid = args[0] as string;
  updateSession(sid, { lastTurnEndedAt: Date.now() });
  return { ok: true };
}

export async function recentWorkdirs(_args: unknown[]) {
  const dirs = new Map<string, number>();
  for (const s of listSessions()) {
    if (s.workingDir) dirs.set(s.workingDir, (dirs.get(s.workingDir) ?? 0) + 1);
  }
  return Array.from(dirs.entries()).sort((a, b) => b[1] - a[1]).map(([path, c]) => ({ path, sessionCount: c }));
}

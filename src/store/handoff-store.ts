/**
 * 邮箱 —— 跨进程 invoke 转发（owner 落行 → 宿主接管后本地重放）。
 * 幂等：UNIQUE(session_id, client_id)；动作类行（无 clientId）不合并（本身幂等）。
 * 宿主死亡清理：clearHostAndArchiveForInstance 一次性清 host/归档/标 failed/删实例行。
 * 实现注意：清 host 与标 failed 的顺序必须「先邮箱后会话」——邮箱 UPDATE 的子查询
 * （SELECT id FROM sessions WHERE host_instance_id=?）依赖 host 旧值，先清 host 会
 * 让子查询命中 0 行、pending 邮箱行漏标 failed（计划稿顺序写反，已修正）。
 */
import { getStmt } from "./db.js";

export interface MailboxRow {
  id: number; sessionId: string; clientId: string | null;
  kind: string; payload: string;
  status: "pending" | "consumed" | "failed";
  createdAt: number;
}

function rowToMailbox(r: Record<string, unknown>): MailboxRow {
  return {
    id: Number(r.id), sessionId: String(r.session_id),
    clientId: r.client_id == null ? null : String(r.client_id),
    kind: String(r.kind), payload: String(r.payload),
    status: (r.status as MailboxRow["status"]), createdAt: Number(r.created_at),
  };
}

export function upsertMailbox(sessionId: string, clientId: string | null, kind: string, payload: unknown[]): void {
  getStmt("INSERT INTO cindy_handoff_mailbox (session_id, client_id, kind, payload, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?) ON CONFLICT(session_id, client_id) DO NOTHING")
    .run(sessionId, clientId, kind, JSON.stringify(payload), Date.now());
}

export function listPendingMailbox(sessionId: string): MailboxRow[] {
  const rows = getStmt("SELECT * FROM cindy_handoff_mailbox WHERE session_id = ? AND status = 'pending' ORDER BY created_at, id").all(sessionId) as Record<string, unknown>[];
  return rows.map(rowToMailbox);
}

export function deleteMailbox(id: number): void {
  getStmt("DELETE FROM cindy_handoff_mailbox WHERE id = ?").run(id);
}

export function failPendingMailboxForSessions(sessionIds: string[]): void {
  if (sessionIds.length === 0) return;
  const placeholders = sessionIds.map(() => "?").join(",");
  getStmt(`UPDATE cindy_handoff_mailbox SET status = 'failed' WHERE status = 'pending' AND session_id IN (${placeholders})`).run(...sessionIds);
}

export function clearHostAndArchiveForInstance(instanceId: string): void {
  const now = Date.now();
  // 顺序敏感：先标邮箱 failed（子查询读 host 旧值）→ 再清 host → 最后删实例行
  getStmt("UPDATE cindy_handoff_mailbox SET status = 'failed' WHERE status = 'pending' AND session_id IN (SELECT id FROM sessions WHERE host_instance_id = ?)").run(instanceId);
  getStmt("UPDATE sessions SET host_instance_id = NULL, status = 'archived', updated_at = ? WHERE host_instance_id = ?").run(now, instanceId);
  getStmt("DELETE FROM cindy_instances WHERE instance_id = ?").run(instanceId);
}

export function purgeFailedMailbox(before: number): void {
  getStmt("DELETE FROM cindy_handoff_mailbox WHERE status = 'failed' AND created_at < ?").run(before);
}

/** 滞留 pending 行 TTL 兜底（M3）：创建超过阈值仍未被消费的 pending 行标 failed。
 *  正常路径（活宿主接管 → 消费）远快于阈值；命中的是「宿主不活跃/会话已归档/未激活」
 *  等无法消费的滞留行——标 failed 后由 purgeFailedMailbox 超时删除，防止邮箱无限增长。 */
export function failStalePendingMailbox(before: number): void {
  getStmt("UPDATE cindy_handoff_mailbox SET status = 'failed' WHERE status = 'pending' AND created_at < ?").run(before);
}

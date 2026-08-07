/**
 * 邮箱消费 + 宿主清理扫描。
 * 消费：宿主接管后把邮箱 pending 行逐条本地 routeInvoke 重放（复用全部 handler）；
 * 成功删行，失败不标 consumed（对齐 desktop agentHandoff：peek 失败不缓存 null，
 * 否则交接永久丢失）。清理：心跳陈旧 + pid 探活失败的实例 → 清 host/归档/标 failed/删实例行。
 */
import { getSession } from "./store/session-store.js";
import { listPendingMailbox, deleteMailbox, clearHostAndArchiveForInstance } from "./store/handoff-store.js";
import { routeInvoke } from "./handlers/router.js";
import { getStmt } from "./store/db.js";
import { instanceAlive } from "./instance.js";

export async function consumeMailboxForSession(sessionId: string): Promise<void> {
  const rows = listPendingMailbox(sessionId);
  for (const row of rows) {
    try {
      let args: unknown[] = [];
      try { const p = JSON.parse(row.payload); if (Array.isArray(p)) args = p; } catch { /* 损坏 payload：跳过该行 */ }
      await routeInvoke(row.kind, args);
      deleteMailbox(row.id);
    } catch { /* 重放失败：行保留，下轮/下次 acquire 重试 */ }
  }
}

export function sweepStaleInstances(now: number = Date.now(), staleMs: number = 30_000): void {
  // 1) 死实例清理：cindy_instances 心跳过期 + pid 死 → 归档其会话
  const stale = getStmt("SELECT instance_id FROM cindy_instances").all() as { instance_id: string }[];
  for (const { instance_id } of stale) {
    if (!instanceAlive(instance_id, now, staleMs)) {
      clearHostAndArchiveForInstance(instance_id);
    }
  }
  // 2) 孤儿 active 会话清理（修：死实例行被 releaseInstance 优雅删除后，路径 1 遍历
  //    cindy_instances 看不到它 → 其会话 host 指向不存在的实例、status 永为 active →
  //    手机端 sessions:list "active" 堆积死会话）。按会话反查：active 会话的 host 不在
  //    活实例 → 归档；host 已空（router 死宿主路径只清 host 不归档）→ 归档。
  //    当前进程的会话 host=本进程活实例（心跳新鲜）→ 不受影响；pi 重启 resume 同会话
  //    由 tracker session_start 重新激活（host=当前实例），不误伤。
  const rows = getStmt("SELECT id, host_instance_id FROM sessions WHERE status = 'active'").all() as { id: string; host_instance_id: string | null }[];
  for (const row of rows) {
    if (row.host_instance_id == null) {
      getStmt("UPDATE sessions SET status = 'archived', updated_at = ? WHERE id = ?").run(now, row.id);
      continue;
    }
    if (!instanceAlive(row.host_instance_id, now, staleMs)) {
      clearHostAndArchiveForInstance(row.host_instance_id);
    }
  }
}

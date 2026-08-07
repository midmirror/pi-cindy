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
  const stale = getStmt("SELECT instance_id FROM cindy_instances").all() as { instance_id: string }[];
  for (const { instance_id } of stale) {
    if (!instanceAlive(instance_id, now, staleMs)) {
      clearHostAndArchiveForInstance(instance_id);
    }
  }
}

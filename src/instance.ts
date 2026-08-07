/**
 * 实例身份与心跳 —— 每 pi 进程扩展的跨进程身份。
 * instanceId：进程生命周期单例 UUID（会话宿主标注 / 定向接管目标用）。
 * 心跳：登录后（随仲裁器）每 10s 续写 cindy_instances；登出/退出停写。
 * 活体判定：心跳新鲜 → 活；心跳过期 + pid 探活失败 → 死（pid 仅加速信号，
 * 心跳仍是主判据——GC 停顿 / IO 抖动不误杀；Windows pid 复用风险由心跳主判据兜底）。
 */
import { randomUUID } from "node:crypto";
import { getStmt } from "./store/db.js";

let instanceId: string | null = null;

export function getInstanceId(): string {
  if (!instanceId) instanceId = randomUUID();
  return instanceId;
}

export function registerInstance(): void {
  getStmt("INSERT INTO cindy_instances (instance_id, pid, label, heartbeat_at) VALUES (?, ?, ?, ?) ON CONFLICT(instance_id) DO UPDATE SET pid = excluded.pid, heartbeat_at = excluded.heartbeat_at")
    .run(getInstanceId(), process.pid, "pi-cindy", Date.now());
}

export function heartbeatInstance(): void {
  getStmt("UPDATE cindy_instances SET heartbeat_at = ? WHERE instance_id = ?").run(Date.now(), getInstanceId());
}

export function releaseInstance(): void {
  getStmt("DELETE FROM cindy_instances WHERE instance_id = ?").run(getInstanceId());
}

export function instanceAlive(instanceId: string, now: number = Date.now(), staleMs: number = 30_000): boolean {
  const row = getStmt("SELECT pid, heartbeat_at FROM cindy_instances WHERE instance_id = ?").get(instanceId) as { pid: number; heartbeat_at: number } | undefined;
  if (!row) return false;
  if (now - row.heartbeat_at <= staleMs) return true;
  // 心跳硬上限（M5）：>2×staleMs 无论 pid 判死 —— pid 被复用（死宿主 pid 被同用户进程
  // 占走）或事件循环挂死时 pid 探活会恒判活，心跳无上限则幽灵行永不清除，
  // 每消息一轮接管循环。挂死宿主最坏 2×staleMs 后被清理，期间由 handoff 熔断（M4）兜底。
  if (now - row.heartbeat_at > staleMs * 2) return false;
  try { process.kill(row.pid, 0); return true; } catch { return false; }
}

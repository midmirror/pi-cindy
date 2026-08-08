/**
 * 跨进程 refresh 互斥锁（EXPERIENCE #23 / #46 遗留技术债）。
 *
 * 问题：多 pi 进程 / 热重载叠加时，多个进程可能并发用同一 refresh token 调
 * /api/auth/refresh。服务端对 refresh token 是**轮换式**的（发新 token 即失效旧
 * token）——两个进程同时用旧 token 刷新，第一个成功并轮换，第二个再用旧 token
 * 会被服务端拒（rotation 竞争）→ 401 INVALID_REFRESH_TOKEN → 误判「家族已死」
 * 清会话强制重登。
 *
 * 方案：refresh 前拿跨进程互斥锁（SQLite 单行锁，与 device_link_ownership 同源
 * 的 CAS 思路），后到者等锁 → 锁内**重读 session.enc**（此时可能已被先到进程
 * 轮换落盘新 token）→ 用新 token 刷新 → 释放。任何时刻只有一个进程在刷新，
 * 且绝不用进锁前的陈旧 token。
 *
 * 双层互斥：
 * - **进程内**：promise-chain 串行（tail）——同进程并发调用严格排队，杜绝同进程
 *   多实例（热重载后旧/新实例）并发刷新；认证层另有 refreshInFlight 单飞，这里是
 *   基础设施级的自洽兜底（不依赖调用方自觉）。
 * - **进程间**：SQLite 单行锁 CAS。owner_pid 相同（同进程）可覆盖——服务于热重载
 *   幽灵锁恢复（旧实例在刷新中途崩溃/泄漏，同 pid 新实例立即接管，不等 stale）；
 *   不同 pid 互斥，靠 locked_at 过期（LOCK_STALE_MS）处理持锁进程崩溃。
 *
 * 锁仅护「refresh 这个短网络操作」，不护长事务；持锁跨 await 但持有窗口=一次
 * HTTP 往返（秒级）。db 不可用（老 Node / db 损坏）时跳过锁直接执行（best
 * effort 退化，不因锁阻塞认证链路）。
 */
import { getDb, getStmt } from "../store/db.js";
import { dbgLog } from "../dbg.js";

/** 锁持有者崩溃后的 stale 阈值：一次 refresh 网络往返正常 <5s，30s 足留余量。 */
const LOCK_STALE_MS = 30_000;
/** 抢锁轮询间隔。 */
const LOCK_POLL_MS = 100;
/** 等锁总超时：超时放弃锁直接执行（best effort），防极端情况下认证永久卡死。 */
const LOCK_TIMEOUT_MS = 15_000;

const ENSURE_ROW = "INSERT OR IGNORE INTO refresh_lock (id) VALUES (1)";
// owner_pid = ?（第 4 参 = 自己 pid）允许同进程覆盖：热重载幽灵锁立即接管。
const GRAB = `
  UPDATE refresh_lock
  SET owner_pid = ?, owner_label = ?, locked_at = ?
  WHERE id = 1 AND (owner_pid IS NULL OR owner_pid = ? OR ? - locked_at > ?)
`;
// 释放只清自己的锁（owner_pid 匹配），不误清他人抢占的锁。
const RELEASE = `
  UPDATE refresh_lock SET owner_pid = NULL, owner_label = NULL, locked_at = NULL
  WHERE id = 1 AND owner_pid = ?
`;

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

/** 进程内串行链：同进程并发 withRefreshLock 严格排队（进程内单飞的基础设施兜底）。 */
let tail: Promise<unknown> = Promise.resolve();

/**
 * 持跨进程锁执行 fn；锁内 fn 必须自行重读 session.enc（跨进程竞争时可能已被
 * 他进程轮换），绝不用进锁前的陈旧 token。
 */
export function withRefreshLock<T>(fn: () => Promise<T>, label = "refresh"): Promise<T> {
  const run = tail.then(() => doRefreshLock(fn, label));
  tail = run.then(() => undefined, () => undefined); // 吞错续链，防调用方异常断链
  return run;
}

async function doRefreshLock<T>(fn: () => Promise<T>, label: string): Promise<T> {
  try { getDb(); } catch { return fn(); } // db 不可用 → 跳过锁（best effort）
  try {
    getStmt(ENSURE_ROW).run();
  } catch { return fn(); } // 锁表初始化失败 → 跳过锁
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let acquired = false;
  for (;;) {
    const now = Date.now();
    try {
      const res = getStmt(GRAB).run(process.pid, label, now, process.pid, now, LOCK_STALE_MS);
      if (res.changes === 1) { acquired = true; break; }
    } catch { return fn(); } // 锁操作失败 → 跳过锁
    if (Date.now() >= deadline) {
      dbgLog(`auth refresh lock timeout — proceeding without lock (best effort) pid=${process.pid}`);
      break;
    }
    await sleep(LOCK_POLL_MS);
  }
  try {
    return await fn();
  } finally {
    if (acquired) {
      try { getStmt(RELEASE).run(process.pid); } catch { /* 锁释放失败：交给 stale 过期 */ }
    }
  }
}

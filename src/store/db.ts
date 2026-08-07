/**
 * SQLite 数据层 —— 单例 + schema DDL。
 * 对齐 desktop localDb schema（裁剪：只留 sessions / messages / device_link_ownership 三表）。
 * node:sqlite 内置（Node 22.23+，零原生依赖）；WAL 多进程并发读安全，busy_timeout 处理写锁竞争。
 *
 * 兼容性：node:sqlite 自 Node 22.5 引入（22.23 起稳定），老版本不存在该内建模块。
 * 顶层不做静态 import（老 Node 会在模块加载即崩，拖垮整个扩展），改为 getDb 内懒加载，
 * 失败抛出带当前 Node 版本的可读错误；package.json engines 同步声明下限。
 */
import type { DatabaseSync as DatabaseSyncType, StatementSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbgLog } from "../dbg.js";

export const DATA_DIR = process.env.PI_CINDY_DATA_DIR
  ?? path.join(os.homedir(), ".pi", "cindy-sync");
const DB_FILE = path.join(DATA_DIR, "pi-cindy.db");
const WAL_FILE = `${DB_FILE}-wal`;
const SHM_FILE = `${DB_FILE}-shm`;

const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'New Maker',
  working_dir TEXT,
  workspace_kind TEXT NOT NULL DEFAULT 'project',
  model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
  effort TEXT NOT NULL DEFAULT 'high',
  permission_mode TEXT NOT NULL DEFAULT 'ask',
  status TEXT NOT NULL DEFAULT 'active',
  host_instance_id TEXT,
  sdk_session_id TEXT,
  total_token_usage INTEGER NOT NULL DEFAULT 0,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  total_cost_amount REAL NOT NULL DEFAULT 0,
  total_cost_currency TEXT,
  total_cost_is_approximate INTEGER NOT NULL DEFAULT 0,
  context_tokens INTEGER NOT NULL DEFAULT 0,
  context_window INTEGER NOT NULL DEFAULT 0,
  fast_mode INTEGER NOT NULL DEFAULT 0,
  plan_mode_enabled INTEGER NOT NULL DEFAULT 0,
  provider_id TEXT,
  agent_kind TEXT NOT NULL DEFAULT 'pi',
  summary TEXT,
  pinned_at INTEGER,
  cleared_at INTEGER,
  user_send_at INTEGER,
  active_turn_started_at INTEGER,
  last_turn_ended_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  client_id TEXT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  agent_meta TEXT,
  agent_kind TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);
CREATE TABLE IF NOT EXISTS device_link_ownership (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  owner_label TEXT,
  heartbeat_at INTEGER NOT NULL,
  handoff_to TEXT,
  handoff_expires_at INTEGER
);
CREATE TABLE IF NOT EXISTS cindy_instances (
  instance_id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  label TEXT,
  heartbeat_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cindy_handoff_mailbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  client_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_mailbox_session_status ON cindy_handoff_mailbox(session_id, status);
`;

let db: DatabaseSyncType | null = null;

/**
 * node:sqlite 懒加载：老 Node（<22.5）无此内建模块，静态 import 会在模块加载即抛
 * ERR_UNKNOWN_BUILTIN_MODULE，拖垮整个扩展；懒加载把失败收敛到首次 getDb，错误信息
 * 带当前 Node 版本便于诊断。
 */
function loadDatabaseSync(): typeof DatabaseSyncType {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("node:sqlite").DatabaseSync as typeof DatabaseSyncType;
  } catch (err) {
    throw new Error(
      `node:sqlite 不可用（需要 Node >= 22.23，当前 ${process.version}）：`
      + `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * 安全加固：本地 SQLite 库承载全量会话 / 消息内容（messages.content），收紧文件权限到
 * 仅属主可读写（0600），避免多用户机器上同机其他用户按 umask 读到明文对话。
 * 对齐 desktop betterSqliteFactory 的 restrictDbFilePermissions 语义：
 * - win32 无 POSIX mode 位，chmod 近似 no-op，直接跳过；
 * - 全程 best-effort：失败只静默跳过不阻断（文件被并发删除 / 权限被回收等）；
 * - 每次 open 前后各收敛一次：既有 0644 旧库在首次调用即被收敛；
 * - WAL 的 -wal / -shm 边车**只**在创建时刻继承主库 mode，此后对主库 chmod 不传播
 *   （修：曾只 chmod 主库，全新安装的 -wal/-shm 以 umask 0644 落盘，未 checkpoint 帧
 *   同机可读）。故主库、-wal、-shm 一并收敛；边车可能尚未创建（ENOENT 静默吞掉）。
 */
function restrictDbFilePermissions(): void {
  if (process.platform === "win32") return;
  for (const f of [DB_FILE, WAL_FILE, SHM_FILE]) {
    try { fs.chmodSync(f, 0o600); } catch { /* 权限设置失败 / 文件尚不存在：不阻断 */ }
  }
}

/**
 * 打开数据库并建 schema；损坏库隔离重建（修：曾无恢复路径——损坏库让 getDb 抛错，
 * store 全挂、扩展不可用；JSON 版有 .corrupt-<ts> 改名保留语义，SQLite 版对齐之）。
 * 隔离覆盖 open + PRAGMA + DDL + quick_check 全程（修：曾只包 open+PRAGMA，损坏在 DDL
 * exec 期暴露会逃出隔离；且损坏判据漏了 SQLITE_NOTADB 的 "file is not a database"；
 * 页面级损坏 header 完好、首查才炸——open 期 PRAGMA quick_check 全表扫描检测，失败
 * 同样隔离重建）。
 * 仅对损坏类错误隔离（corrupt/malformed/not a database），权限 / 磁盘错误等原样抛出。
 * 已知局限：进程运行期间发生的页面损坏（运行中磁盘位翻转等，极罕见）仍从查询冒泡到
 * handler 层报 invoke-error——完整覆盖需查询层拦截，成本过高不做。
 */
function openDatabase(): DatabaseSyncType {
  const DatabaseSync = loadDatabaseSync();
  const attempt = (): DatabaseSyncType => {
    const d = new DatabaseSync(DB_FILE);
    d.exec("PRAGMA journal_mode = WAL");
    d.exec("PRAGMA busy_timeout = 3000");
    d.exec(DDL);
    // 既有库补列（CREATE TABLE IF NOT EXISTS 不会给旧表补列）：幂等，列已存在时抛错被吞
    for (const sql of [
      "ALTER TABLE sessions ADD COLUMN host_instance_id TEXT",
      "ALTER TABLE device_link_ownership ADD COLUMN handoff_to TEXT",
      "ALTER TABLE device_link_ownership ADD COLUMN handoff_expires_at INTEGER",
    ]) {
      try { d.exec(sql); } catch { /* 列已存在 → 幂等跳过 */ }
    }
    // 页面级损坏检测：quick_check 只读全表扫描（本地库 MB 级，开销可忽略）；
    // 失败消息必须带 corrupt 字样才能命中外层隔离判据
    const qc = d.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
    const bad = qc.filter((r) => r.quick_check !== "ok");
    if (bad.length > 0) {
      d.close();
      throw new Error(`db corrupt (quick_check): ${bad.map((r) => r.quick_check).join("; ")}`);
    }
    return d;
  };
  try {
    return attempt();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/corrupt|malformed|not a database/i.test(msg)) throw err;
    // 隔离损坏库（主库 + 边车一并改名保留现场），重建全新库；迁移层 db 非空即跳过，
    // 不重复导入旧数据——损坏库数据本已不可信，保留备份供人工恢复。
    dbgLog(`db corrupt (${msg}) — quarantining ${path.basename(DB_FILE)} and recreating`);
    const backup = `${DB_FILE}.corrupt-${Date.now()}`;
    for (const f of [DB_FILE, WAL_FILE, SHM_FILE]) {
      try { fs.renameSync(f, `${backup}-${path.basename(f).replace("pi-cindy.db", "db")}`); } catch { /* ok */ }
    }
    return attempt();
  }
}

/**
 * 打开（首次）或复用单例。返回前不重复 chmod（mode 不会自发变化；仅在 open 路径收敛，
 * 修：曾每次调用 chmodSync，消息热路径 5-6 次/条 + 仲裁 tick 白白付同步 syscall）。
 */
export function getDb(): DatabaseSyncType {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 打开前先收敛既有库：若打开成功后再 chmod，损坏/早退路径会把 0644 旧库原样留在盘上。
  // 文件尚不存在时 ENOENT 被静默吞掉，全新安装此调用为 no-op。
  restrictDbFilePermissions();
  const d = openDatabase();
  // 打开成功后再收敛一次：覆盖本次刚创建的新库（对齐 desktop betterSqliteFactory）。
  restrictDbFilePermissions();
  db = d;
  // JSON→SQLite 一次性迁移接线：db 已 open + DDL 已就绪，首次 getDb 后触发。
  // 延迟 require 避免 db.ts ↔ migration.ts 循环依赖（migration.ts 只 import getDb/DATA_DIR）。
  // 迁移幂等（migration_done / db 非空 / sessions.json 缺失均跳过），失败 fail-open 仅告警。
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { runMigrationIfNeeded } = require("./migration.js");
    runMigrationIfNeeded();
  } catch (e) {
    dbgLog(`migration wiring failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return d;
}

/**
 * 语句缓存：node:sqlite 无内置 prepare 缓存，每次 db.prepare 都重新编译 SQL。
 * 热路径（appendMessage / getSession / updateSession / 仲裁 CAS）每调用 re-prepare，
 * CPU/GC 白耗。按 SQL 文本缓存 StatementSync，closeDb 时一并失效。
 */
const stmtCache = new Map<string, StatementSync>();
export function getStmt(sql: string): StatementSync {
  const d = getDb();
  let s = stmtCache.get(sql);
  if (!s) {
    s = d.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

export function closeDb(): void {
  try { db?.close(); } catch { /* ok */ }
  db = null;
  stmtCache.clear();
}

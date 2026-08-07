/**
 * JSON → SQLite 一次性迁移（fail-open）。
 * 触发：sessions.json 存在（旧数据）且 db 为空且无 migration_done 标记。
 * 迁移后旧 JSON 保留不删（安全网）；migration_done 标记防重复导入。
 */
import fs from "node:fs";
import path from "node:path";
import { getDb, getStmt, DATA_DIR } from "./db.js";

const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const MESSAGES_DIR = path.join(DATA_DIR, "messages");
const DONE_FILE = path.join(DATA_DIR, "migration_done");

// 旧 JSON 会话为无类型历史数据（旧 JSON 版 store 产物），迁移层按宽松类型处理。
interface OldStore { sessions: Record<string, any>; }

export function runMigrationIfNeeded(): boolean {
  try {
    if (fs.existsSync(DONE_FILE)) return false;
    if (!fs.existsSync(SESSIONS_FILE)) return false;
    const store: OldStore = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
    const db = getDb();
    const cnt = getStmt("SELECT COUNT(*) AS c FROM sessions").get() as { c: number };
    if (Number(cnt.c) > 0) {
      // db 非空：正常跳过。但 getDb() 内的迁移接线可能在本次调用里已跑完迁移
      // （接线延迟 require runMigrationIfNeeded → 嵌套执行已导入并写 migration_done），
      // 此时应如实返回 true（迁移确实发生了），否则返回 false（存量数据，跳过）。
      return fs.existsSync(DONE_FILE);
    }
    const insertS = getStmt(`INSERT OR IGNORE INTO sessions (
      id, title, working_dir, workspace_kind, model, effort, permission_mode, status,
      sdk_session_id, total_token_usage, total_cost_usd, total_cost_amount, total_cost_currency,
      total_cost_is_approximate, context_tokens, context_window, fast_mode, plan_mode_enabled,
      provider_id, agent_kind, summary, pinned_at, cleared_at, user_send_at,
      active_turn_started_at, last_turn_ended_at, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertM = getStmt(`INSERT OR IGNORE INTO messages (id, client_id, session_id, role, content, agent_meta, agent_kind, created_at)
      VALUES (?,?,?,?,?,?,?,?)`);
    // 单事务批量导入（修：曾 autocommit 逐行提交——WAL fsync 每行一次 + 中途崩溃留半库；
    // 事务 + INSERT OR IGNORE 幂等，失败 ROLLBACK 后由 migration_done 缺失触发重跑）。
    db.exec("BEGIN");
    try {
      for (const s of Object.values(store.sessions)) {
        insertS.run(
          s.id, s.title ?? "New Pi Session", s.workingDir ?? "", s.workspaceKind ?? "project",
          s.model ?? "claude-sonnet-4-6", s.effort ?? "high", s.permissionMode ?? "ask", s.status ?? "active",
          s.sdkSessionId ?? null, s.totalTokenUsage ?? 0, s.totalCostUsd ?? 0, s.totalCostAmount ?? 0, s.totalCostCurrency ?? null,
          s.totalCostIsApproximate ? 1 : 0, s.contextTokens ?? 0, s.contextWindow ?? 200000, s.fastMode ? 1 : 0, s.planModeEnabled ? 1 : 0,
          s.providerId ?? null, s.agentKind ?? "pi", s.summary ?? null, s.pinnedAt ?? null, s.clearedAt ?? null, s.userSendAt ?? null,
          s.activeTurnStartedAt ?? null, s.lastTurnEndedAt ?? null, s.createdAt ?? Date.now(), s.updatedAt ?? Date.now(),
        );
        const msgsFile = path.join(MESSAGES_DIR, `${String(s.id)}.json`);
        if (fs.existsSync(msgsFile)) {
          const msgs = JSON.parse(fs.readFileSync(msgsFile, "utf8")) as any[];
          for (const m of msgs) {
            // 旧 JSON 版把 model/provider/usage/stopReason 平铺在消息顶层；SQLite 版
            // 存 agent_meta JSON（rowToMessage 从中还原），迁移时打包保留，避免丢 model。
            let meta: string | null = null;
            if (m.model != null || m.provider != null || m.usage != null || m.stopReason != null) {
              meta = JSON.stringify({ model: m.model ?? null, provider: m.provider ?? null, usage: m.usage ?? null, stopReason: m.stopReason ?? null });
            }
            insertM.run(m.id, m.clientId ?? null, m.sessionId ?? s.id, m.role ?? "user", m.content ?? "", meta, "pi", m.createdAt ?? Date.now());
          }
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      // 中途失败：回滚整批（避免半库 + migration_done 双态不一致），交外层 fail-open
      try { db.exec("ROLLBACK"); } catch { /* ok */ }
      throw err;
    }
    fs.writeFileSync(DONE_FILE, String(Date.now()), { mode: 0o600 });
    return true;
  } catch (err) {
    // fail-open：迁移失败不阻断启动，store 回退 JSON 兜底（db.ts 见 Step 4）
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { dbgLog } = require("../dbg.js");
      dbgLog(`migration failed: ${err instanceof Error ? err.message : String(err)}`);
    } catch { /* ok */ }
    return false;
  }
}

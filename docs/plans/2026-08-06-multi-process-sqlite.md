# pi-cindy 多进程共存 + SQLite 化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 多个 pi 进程共享同一数据目录时互不踢下线（单持有者仲裁），会话/消息存储从 JSON 迁移到 SQLite（多进程并发写安全），手机端可见全部会话、可操作持有者。

**Architecture:** copy desktop `ownership.ts` 的单持有者仲裁（SQLite 单行表 CAS + 5s 心跳/15s 接管），同一时刻只有一台 pi 进程连 relay。`session-store.ts` 内部实现从 JSON 文件换成 node:sqlite（`DatabaseSync`），对外函数签名不变（tracker/maker/sessions/messages handlers 零改动）。启动时 JSON→SQLite 一次性迁移（fail-open，旧文件保留）。

**Tech Stack:** Node 22.23+（内置 `node:sqlite`，零原生依赖）、TypeScript strict + NodeNext、jiti 测试加载器、现有 `ws` 依赖。

**Spec:** `docs/specs/2026-08-06-multi-process-sqlite-design.md`（本计划依据，已评审通过）

## Global Constraints

- node:sqlite 仅用基础 CRUD/索引（`DatabaseSync` / `prepare().run()/get()/all()`），不依赖实验性扩展 API
- **首步验证 pi 进程内 `require('node:sqlite')` 可用**；不可用则停下报告（备选 better-sqlite3，需用户重决）
- `session-store.ts` 对外导出签名不变：`createSession / getSession / listSessions / updateSession / patchSessionMeta / findSessionBySdkId / deleteSession / appendMessage / listMessages / deleteMessage / deleteMessageByClientId / getMessageCount / getInterruptedSessions / loadOrCreateDeviceId`
- 迁移失败 fail-open：保留 JSON store 可读，不阻断启动
- 旧 JSON 文件迁移后**不删**（安全网）
- `session.enc`（token）与 `device-id` 保持文件形式，不动
- 测试隔离：`PI_CINDY_DATA_DIR` 指向临时目录 → 临时 db 文件
- 现有 125 冒烟断言必须全绿（handler 契约不变）
- 双门禁：`npm test` + `npm run typecheck`（strict）

---

### Task 1: 验证 pi 进程内 node:sqlite 可用性

**Files:**
- Create: `tests/node-sqlite-probe.test.js`

**Interfaces:**
- Consumes: 无（环境探测）
- Produces: 无（通过/失败结论，决定后续全部任务是否可行）

- [ ] **Step 1: 写探测脚本**

```js
// tests/node-sqlite-probe.test.js
// 探测 pi 运行时环境（同 jiti 加载链）能否 require node:sqlite。
// 注意：必须在 pi 进程内跑（npx pi -e . -c 触发加载），不是 shell node。
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { interopDefault: true });
try {
  const { DatabaseSync } = jiti('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('probe-ok');
  const row = db.prepare('SELECT v FROM t').all()[0];
  console.log('NODE_SQLITE_PROBE:', row.v);
  if (row.v !== 'probe-ok') process.exit(1);
} catch (err) {
  console.error('NODE_SQLITE_PROBE FAILED:', err.message);
  process.exit(2);
}
```

- [ ] **Step 2: 在 pi 进程内运行探测**

```bash
cd ~/.agents/agent-configs/pi/extensions/pi-cindy
npx pi -e . -c "echo probe" 2>&1 | head -20
```

Expected: 输出包含 `NODE_SQLITE_PROBE: probe-ok`。（若 pi 进程内 node < 22.5 或 jiti 无法加载 `node:sqlite`，此步 FAIL → 停下，改用 better-sqlite3 方案需用户重决。）

- [ ] **Step 3: 同时用 shell node 对照**

```bash
node tests/node-sqlite-probe.test.js
```

Expected: `NODE_SQLITE_PROBE: probe-ok`（shell node 22.23 已实测可用，作为对照基线）。

- [ ] **Step 4: 提交**

```bash
cd ~/.agents
git add agent-configs/pi/extensions/pi-cindy/tests/node-sqlite-probe.test.js
git commit -m "test(pi-cindy): node:sqlite 可用性探测"
```

---

### Task 2: SQLite 数据层（db.ts）— schema DDL + WAL/busy_timeout

**Files:**
- Create: `src/store/db.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `getDb(): DatabaseSync` — 单例，打开 `DATA_DIR/pi-cindy.db`，WAL + `busy_timeout(3000)`，`CREATE TABLE IF NOT EXISTS` 三张表
  - `closeDb(): void` — 测试/退出时关闭
  - `DATA_DIR` 派生逻辑与 `session-store.ts` 现有保持一致（`PI_CINDY_DATA_DIR` ?? `~/.pi/cindy-sync`）

- [ ] **Step 1: 写 db.ts（含完整 DDL）**

```ts
/**
 * SQLite 数据层 —— 单例 + schema DDL。
 * 对齐 desktop localDb schema（裁剪：只留 sessions / messages / device_link_ownership 三表）。
 * node:sqlite 内置（Node 22.23+），零原生依赖；WAL 多进程并发读安全，busy_timeout 处理写锁竞争。
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DATA_DIR = process.env.PI_CINDY_DATA_DIR
  ?? path.join(os.homedir(), ".pi", "cindy-sync");
const DB_FILE = path.join(DATA_DIR, "pi-cindy.db");

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
  heartbeat_at INTEGER NOT NULL
);
`;

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const d = new DatabaseSync(DB_FILE);
  d.exec("PRAGMA journal_mode = WAL");
  d.exec("PRAGMA busy_timeout = 3000");
  d.exec(DDL);
  db = d;
  return d;
}

export function closeDb(): void {
  try { db?.close(); } catch { /* ok */ }
  db = null;
}
```

- [ ] **Step 2: 验证 DDL 可执行 + 三表创建**

```bash
cd ~/.agents/agent-configs/pi/extensions/pi-cindy
PI_CINDY_DATA_DIR=$(mktemp -d) node -e "
const { getDb, closeDb } = require('./src/store/db.ts').default ?? require('./src/store/db.ts');
" 2>&1 | head -5
```

Expected: 无报错。若 jiti 直调 TS 不便，用 `npx jiti -e "const {getDb}=require('./src/store/db.ts'); getDb().exec('SELECT 1'); console.log('DDL OK')"`（若 jiti CLI 不可用，此验证并入 Task 4 的 store 测试，不单独阻塞）。

- [ ] **Step 3: 提交**

```bash
cd ~/.agents
git add agent-configs/pi/extensions/pi-cindy/src/store/db.ts
git commit -m "feat(pi-cindy): SQLite 数据层（三表 DDL + WAL/busy_timeout）"
```

---

### Task 3: session-store 迁移 JSON → SQLite（对外签名不变）

**Files:**
- Modify: `src/store/session-store.ts`（整体重写内部实现，保留导出签名与注释头）
- Create: `tests/store-sqlite.test.js`

**Interfaces:**
- Consumes: `getDb()` / `closeDb()`（Task 2）
- Produces: 保持现有 14 个导出函数，签名与返回类型与 JSON 版完全一致（见 Global Constraints 列表）。handler 层（tracker/maker/sessions/messages）零改动。

**字段映射**（PiSessionMeta ↔ sessions 列）：
- 数字/布尔/字符串直映射；null → SQL NULL；`createdAt/updatedAt/pinnedAt/clearedAt/userSendAt/activeTurnStartedAt/lastTurnEndedAt` → INTEGER unix ms
- messages: `agentMeta` 存 `JSON.stringify({model, provider, usage, stopReason})`，读回反序列化；`clientId` 无则 NULL

- [ ] **Step 1: 写失败的 store 测试（先锁现有行为）**

```js
// tests/store-sqlite.test.js
// SQLite store 行为测试：覆盖 session-store 全部导出，与 JSON 版语义一致。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJiti } = require('jiti');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cindy-sqlite-'));
process.env.PI_CINDY_DATA_DIR = DATA_DIR;
const jiti = createJiti(__filename, { interopDefault: true });
const store = jiti(path.join(__dirname, '..', 'src', 'store', 'session-store.ts'));

let failures = 0;
function assert(cond, name, extra) {
  if (cond) { console.log('  ok:', name); }
  else { failures++; console.error('  FAIL:', name, extra ?? ''); }
}

(async () => {
  // create/get/update/list
  const s = store.createSession({ model: 'deepseek-v4-flash', workingDir: '/tmp/proj' });
  assert(s.id && s.status === 'active' && s.model === 'deepseek-v4-flash', 'createSession 形状');
  assert(store.getSession(s.id)?.title === s.title, 'getSession 命中');
  assert(store.getSession('no-such') === null, 'getSession miss → null');
  const upd = store.updateSession(s.id, { status: 'archived', totalTokenUsage: 42 });
  assert(upd?.status === 'archived' && upd?.totalTokenUsage === 42, 'updateSession 生效');
  assert(store.listSessions({ status: 'archived' }).length === 1, 'listSessions 按 status 过滤');
  assert(store.listSessions({ status: 'active' }).length === 0, 'listSessions active 为空');
  assert(store.listSessions().length === 1, 'listSessions 默认排除 deleted');

  // patchSessionMeta 白名单
  const pm = store.patchSessionMeta(s.id, { title: 'New Title', pinnedAt: '2026-08-06T00:00:00.000Z' });
  assert(pm?.title === 'New Title' && pm?.pinnedAt !== null, 'patchSessionMeta title/pinnedAt');
  let rejected = false;
  try { store.patchSessionMeta(s.id, { model: 'x' }); } catch (e) { rejected = e.code === 'INVALID_PARAMS'; }
  assert(rejected, 'patchSessionMeta 白名单拒绝 model');
  try { store.patchSessionMeta(s.id, { status: 'bogus' }); } catch (e) { rejected = e.code === 'INVALID_PARAMS'; }
  assert(rejected, 'patchSessionMeta 拒绝非法 status');

  // findSessionBySdkId
  const s2 = store.createSession({ sdkSessionId: 'sdk-abc' });
  assert(store.findSessionBySdkId('sdk-abc')?.id === s2.id, 'findSessionBySdkId 命中');
  assert(store.findSessionBySdkId('nope') === null, 'findSessionBySdkId miss');

  // messages: append/list/delete/deleteByClientId/count
  const m1 = store.appendMessage({ id: 'm-1', sessionId: s.id, role: 'user', content: 'hi', clientId: 'c-1', createdAt: 1000 });
  const m2 = store.appendMessage({ id: 'm-2', sessionId: s.id, role: 'assistant', content: 'yo', createdAt: 2000, usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, totalTokens: 6 }, stopReason: 'end_turn' });
  assert(store.getMessageCount(s.id) === 2, 'getMessageCount');
  const asc = store.listMessages(s.id);
  assert(asc.length === 2 && asc[0].id === 'm-1' && asc[1].content === 'yo', 'listMessages 升序 + usage 还原');
  assert(asc[1].usage?.totalTokens === 6 && asc[1].stopReason === 'end_turn', 'usage/stopReason 经 agentMeta 还原');
  assert(store.listMessages(s.id, { after: 1000 }).length === 1, 'listMessages after 游标');
  assert(store.listMessages(s.id, { before: 2000 }).length === 1, 'listMessages before 游标');
  assert(store.listMessages(s.id, { limit: 1 }).length === 1, 'listMessages limit');
  assert(store.deleteMessage(s.id, 'm-1') === true, 'deleteMessage');
  assert(store.deleteMessage(s.id, 'm-1') === false, 'deleteMessage 幂等 miss');
  const m3 = store.appendMessage({ id: 'm-3', sessionId: s.id, role: 'user', content: 'bye', clientId: 'c-3', createdAt: 3000 });
  assert(store.deleteMessageByClientId(s.id, 'c-3') === true, 'deleteMessageByClientId');
  assert(store.deleteMessageByClientId(s.id, 'c-3') === false, 'deleteMessageByClientId miss');

  // getInterruptedSessions（activeTurnStartedAt > lastTurnEndedAt 判定）
  const s3 = store.createSession({});
  store.updateSession(s3.id, { activeTurnStartedAt: 5000 });
  assert(store.getInterruptedSessions().map(x => x.id).includes(s3.id), 'getInterruptedSessions 命中 startedAt>endedAt');
  store.updateSession(s3.id, { lastTurnEndedAt: 6000 });
  assert(!store.getInterruptedSessions().map(x => x.id).includes(s3.id), 'getInterruptedSessions 收尾后熄灭');

  // deleteSession 级联删消息
  const s4 = store.createSession({});
  store.appendMessage({ id: 'mx', sessionId: s4.id, role: 'user', content: 'x', createdAt: 1 });
  store.deleteSession(s4.id);
  assert(store.getSession(s4.id) === null && store.getMessageCount(s4.id) === 0, 'deleteSession 级联');

  // loadOrCreateDeviceId 稳定
  const d1 = store.loadOrCreateDeviceId();
  const d2 = store.loadOrCreateDeviceId();
  assert(d1 === d2 && d1.length > 10, 'loadOrCreateDeviceId 幂等');

  // requireSafeSid 路径穿越防护（非法 sid 拒绝，不碰文件系统）
  let traversal = false;
  try { store.appendMessage({ id: 'z', sessionId: '../../etc/passwd', role: 'user', content: 'x', createdAt: 1 }); } catch (e) { traversal = e.code === 'INVALID_PARAMS'; }
  assert(traversal, '非法 sessionId 拒绝（INVALID_PARAMS）');

  console.log(failures === 0 ? `\nALL PASS (${new Date().toLocaleTimeString()})` : `\n${failures} FAILURES`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(1); });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ~/.agents/agent-configs/pi/extensions/pi-cindy && node tests/store-sqlite.test.js`
Expected: FAIL（`Cannot find module ... session-store.ts` 或断言失败——JSON 版 store 仍按 `messages/<sid>.json` 存，多数断言可能仍过，但 `usage/stopReason` 还原与级联删除语义需 SQLite 化后验证）。

- [ ] **Step 3: 重写 session-store.ts 为 SQLite 实现**

```ts
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
import { getDb, DATA_DIR } from "./db.js";

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
    activeTurnStartedAt: null, lastTurnEndedAt: null,
  };
  const db = getDb();
  db.prepare(`INSERT INTO sessions (
    id, title, working_dir, workspace_kind, model, effort, permission_mode, status,
    sdk_session_id, total_token_usage, total_cost_usd, total_cost_amount, total_cost_currency,
    total_cost_is_approximate, context_tokens, context_window, fast_mode, plan_mode_enabled,
    provider_id, agent_kind, summary, pinned_at, cleared_at, user_send_at,
    active_turn_started_at, last_turn_ended_at, created_at, updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
    .run(s.id, s.title, s.workingDir, s.workspaceKind, s.model, s.effort, s.permissionMode, s.status,
      s.sdkSessionId ?? null, s.totalTokenUsage, s.totalCostUsd, s.totalCostAmount, s.totalCostCurrency ?? null,
      s.totalCostIsApproximate ? 1 : 0, s.contextTokens, s.contextWindow, s.fastMode ? 1 : 0, s.planModeEnabled ? 1 : 0,
      s.providerId, s.agentKind, s.summary, s.pinnedAt, s.clearedAt, s.userSendAt,
      s.activeTurnStartedAt, s.lastTurnEndedAt, s.createdAt, s.updatedAt);
  return s;
}

export function getSession(id: string): PiSessionMeta | null {
  const row = getDb().prepare("SELECT * FROM sessions WHERE id = ?").get(requireSafeSid(id)) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : null;
}

export function listSessions(f?: { status?: string; workingDir?: string }): PiSessionMeta[] {
  let sql = "SELECT * FROM sessions";
  const where: string[] = [];
  const params: unknown[] = [];
  if (f?.status) { where.push("status = ?"); params.push(f.status); }
  else { where.push("status != 'deleted'"); }
  if (f?.workingDir) { where.push("working_dir = ?"); params.push(f.workingDir); }
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY updated_at DESC";
  const rows = getDb().prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

export function updateSession(id: string, patch: Partial<PiSessionMeta>): PiSessionMeta | null {
  requireSafeSid(id);
  const cur = getSession(id);
  if (!cur) return null;
  const merged: PiSessionMeta = { ...cur, ...patch, updatedAt: Date.now() };
  const db = getDb();
  db.prepare(`UPDATE sessions SET
    title=?, working_dir=?, workspace_kind=?, model=?, effort=?, permission_mode=?, status=?,
    sdk_session_id=?, total_token_usage=?, total_cost_usd=?, total_cost_amount=?, total_cost_currency=?,
    total_cost_is_approximate=?, context_tokens=?, context_window=?, fast_mode=?, plan_mode_enabled=?,
    provider_id=?, agent_kind=?, summary=?, pinned_at=?, cleared_at=?, user_send_at=?,
    active_turn_started_at=?, last_turn_ended_at=?, created_at=?, updated_at=?
    WHERE id = ?`)
    .run(merged.title, merged.workingDir, merged.workspaceKind, merged.model, merged.effort, merged.permissionMode, merged.status,
      merged.sdkSessionId ?? null, merged.totalTokenUsage, merged.totalCostUsd, merged.totalCostAmount, merged.totalCostCurrency ?? null,
      merged.totalCostIsApproximate ? 1 : 0, merged.contextTokens, merged.contextWindow, merged.fastMode ? 1 : 0, merged.planModeEnabled ? 1 : 0,
      merged.providerId, merged.agentKind, merged.summary, merged.pinnedAt, merged.clearedAt, merged.userSendAt,
      merged.activeTurnStartedAt, merged.lastTurnEndedAt, merged.createdAt, merged.updatedAt, id);
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
  const row = getDb().prepare("SELECT * FROM sessions WHERE sdk_session_id = ?").get(sdkSessionId) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : null;
}

export function deleteSession(id: string): void {
  requireSafeSid(id);
  getDb().prepare("DELETE FROM messages WHERE session_id = ?").run(id);
  getDb().prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

// Message CRUD
export function appendMessage(msg: PiMessageMeta): PiMessageMeta {
  requireSafeSid(msg.sessionId);
  getDb().prepare(`INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, agent_kind, created_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(session_id, client_id) DO NOTHING`)
    .run(msg.id, msg.clientId ?? null, msg.sessionId, msg.role, msg.content, agentMetaOf(msg), "pi", msg.createdAt);
  return msg;
}

export function listMessages(
  sid: string,
  opts?: { limit?: number; before?: number; after?: number },
): PiMessageMeta[] {
  requireSafeSid(sid);
  const params: unknown[] = [sid];
  let sql = "SELECT * FROM messages WHERE session_id = ?";
  if (opts?.after) { sql += " AND created_at > ?"; params.push(opts.after); }
  if (opts?.before) { sql += " AND created_at < ?"; params.push(opts.before); }
  if (opts?.limit && opts.limit > 0) {
    // 取「最新 limit 条」：倒序取 limit 再反转（对齐 JSON 版 slice(-limit) 升序语义）
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(opts.limit);
    const rows = getDb().prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.reverse().map(rowToMessage);
  }
  sql += " ORDER BY created_at ASC";
  const rows = getDb().prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

export function deleteMessage(sid: string, msgId: string): boolean {
  requireSafeSid(sid);
  const r = getDb().prepare("DELETE FROM messages WHERE id = ? AND session_id = ?").run(msgId, sid);
  return r.changes > 0;
}

export function deleteMessageByClientId(sid: string, clientId: string): boolean {
  requireSafeSid(sid);
  const r = getDb().prepare("DELETE FROM messages WHERE client_id = ? AND session_id = ?").run(clientId, sid);
  return r.changes > 0;
}

export function getMessageCount(sid: string): number {
  requireSafeSid(sid);
  const row = getDb().prepare("SELECT COUNT(*) AS c FROM messages WHERE session_id = ?").get(sid) as { c: number };
  return Number(row.c);
}

export function getInterruptedSessions(): PiSessionMeta[] {
  const rows = getDb().prepare(`SELECT * FROM sessions WHERE status = 'active'
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
```

- [ ] **Step 4: 跑 store 测试确认通过**

Run: `cd ~/.agents/agent-configs/pi/extensions/pi-cindy && node tests/store-sqlite.test.js`
Expected: `ALL PASS`，0 failures。

- [ ] **Step 5: 跑现有冒烟测试确认 handler 契约未破**

Run: `cd ~/.agents/agent-configs/pi/extensions/pi-cindy && npm test`
Expected: 125 passed, 0 failed。（冒烟测试用 `PI_CINDY_DATA_DIR` 隔离，自动走新 SQLite store。）

- [ ] **Step 6: typecheck**

Run: `cd ~/.agents/agent-configs/pi/extensions/pi-cindy && npm run typecheck`
Expected: 无错误输出，exit 0。

- [ ] **Step 7: 提交**

```bash
cd ~/.agents
git add agent-configs/pi/extensions/pi-cindy/src/store/session-store.ts agent-configs/pi/extensions/pi-cindy/tests/store-sqlite.test.js
git commit -m "feat(pi-cindy): session-store JSON→SQLite（对外签名不变，handler 零改动）"
```

---

### Task 4: JSON → SQLite 一次性迁移（migration.ts）

**Files:**
- Create: `src/store/migration.ts`
- Modify: `src/store/db.ts`（getDb 内或独立调用点触发迁移）

**Interfaces:**
- Consumes: `getDb()`（Task 2）、`createSession/appendMessage` 或直接 SQL（Task 3）
- Produces: `runMigrationIfNeeded(): boolean` — 返回是否执行了迁移（供日志/测试断言）

**迁移语义**：
- 触发条件：`sessions.json` 存在（有旧数据）且 `pi-cindy.db` 为空（`SELECT COUNT(*) FROM sessions` = 0）且 `migration_done` 标记不存在
- 流程：读 JSON → `INSERT OR IGNORE` 会话 + 各会话消息 → 写 `DATA_DIR/migration_done`（内容=时间戳）→ 返回 true
- 失败 → fail-open：catch 记 dbgLog 告警，返回 false，store 继续用 SQLite（空库）或 JSON 兜底（见 Step 4 决策）
- 幂等：`migration_done` 存在即跳过；db 非空即跳过
- 旧 JSON 文件保留不删

- [ ] **Step 1: 写迁移失败测试（无旧数据时 no-op）**

```js
// tests/migration.test.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJiti } = require('jiti');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cindy-migrate-'));
process.env.PI_CINDY_DATA_DIR = DATA_DIR;
const jiti = createJiti(__filename, { interopDefault: true });
const migration = jiti(path.join(__dirname, '..', 'src', 'store', 'migration.ts'));
const store = jiti(path.join(__dirname, '..', 'src', 'store', 'session-store.ts'));

let failures = 0;
function assert(cond, name, extra) { if (cond) { console.log('  ok:', name); } else { failures++; console.error('  FAIL:', name, extra ?? ''); } }

(async () => {
  // 无旧 JSON → 不迁移
  const did = migration.runMigrationIfNeeded();
  assert(did === false, '无旧数据不迁移');

  // 制造旧 JSON 数据（模拟 JSON 版 store 产物）
  fs.mkdirSync(path.join(DATA_DIR, 'messages'), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'sessions.json'), JSON.stringify({
    sessions: {
      'sess-old-1': {
        id: 'sess-old-1', title: 'Old Session', workingDir: '/tmp/old', workspaceKind: 'project',
        model: 'deepseek-v4-flash', effort: 'high', permissionMode: 'ask', status: 'active',
        sdkSessionId: 'sdk-old', totalTokenUsage: 10, totalCostUsd: 0.1, totalCostAmount: 0.7,
        totalCostCurrency: 'CNY', totalCostIsApproximate: false, contextTokens: 100, contextWindow: 200000,
        fastMode: false, planModeEnabled: false, clearedAt: null, pinnedAt: null, summary: null,
        providerId: 'deepseek', agentKind: 'pi', userSendAt: null, createdAt: 1000, updatedAt: 2000,
        activeTurnStartedAt: null, lastTurnEndedAt: null,
      },
    },
  }, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, 'messages', 'sess-old-1.json'), JSON.stringify([
    { id: 'om-1', sessionId: 'sess-old-1', role: 'user', content: 'hello old', createdAt: 1000 },
    { id: 'om-2', sessionId: 'sess-old-1', role: 'assistant', content: 'hi', model: 'deepseek-v4-flash', createdAt: 2000 },
  ]));

  // 新 db 为空 → 迁移执行
  const did2 = migration.runMigrationIfNeeded();
  assert(did2 === true, '旧数据触发迁移');
  const sess = store.getSession('sess-old-1');
  assert(sess?.title === 'Old Session' && sess?.totalCostCurrency === 'CNY', '会话迁移字段');
  assert(store.getMessageCount('sess-old-1') === 2, '消息迁移数量');
  const msgs = store.listMessages('sess-old-1');
  assert(msgs[0].content === 'hello old' && msgs[1].model === 'deepseek-v4-flash', '消息迁移内容+model');
  assert(fs.existsSync(path.join(DATA_DIR, 'sessions.json')), '旧 JSON 保留');
  assert(fs.existsSync(path.join(DATA_DIR, 'migration_done')), 'migration_done 标记写入');

  // 幂等：再跑不重复
  const did3 = migration.runMigrationIfNeeded();
  assert(did3 === false, '二次运行 no-op（标记存在）');

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(1); });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ~/.agents/agent-configs/pi/extensions/pi-cindy && node tests/migration.test.js`
Expected: FAIL（`migration.ts` 不存在 → require 报错）。

- [ ] **Step 3: 实现 migration.ts**

```ts
/**
 * JSON → SQLite 一次性迁移（fail-open）。
 * 触发：sessions.json 存在（旧数据）且 db 为空且无 migration_done 标记。
 * 迁移后旧 JSON 保留不删（安全网）；migration_done 标记防重复导入。
 */
import fs from "node:fs";
import path from "node:path";
import { getDb, DATA_DIR } from "./db.js";

const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const MESSAGES_DIR = path.join(DATA_DIR, "messages");
const DONE_FILE = path.join(DATA_DIR, "migration_done");

interface OldStore { sessions: Record<string, Record<string, unknown>>; }

export function runMigrationIfNeeded(): boolean {
  try {
    if (fs.existsSync(DONE_FILE)) return false;
    if (!fs.existsSync(SESSIONS_FILE)) return false;
    const db = getDb();
    const cnt = db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number };
    if (Number(cnt.c) > 0) return false;
    const store: OldStore = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
    const insertS = db.prepare(`INSERT OR IGNORE INTO sessions (
      id, title, working_dir, workspace_kind, model, effort, permission_mode, status,
      sdk_session_id, total_token_usage, total_cost_usd, total_cost_amount, total_cost_currency,
      total_cost_is_approximate, context_tokens, context_window, fast_mode, plan_mode_enabled,
      provider_id, agent_kind, summary, pinned_at, cleared_at, user_send_at,
      active_turn_started_at, last_turn_ended_at, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertM = db.prepare(`INSERT OR IGNORE INTO messages (id, client_id, session_id, role, content, agent_meta, agent_kind, created_at)
      VALUES (?,?,?,?,?,?,?,?)`);
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
        const msgs = JSON.parse(fs.readFileSync(msgsFile, "utf8")) as Record<string, unknown>[];
        for (const m of msgs) {
          insertM.run(m.id, m.clientId ?? null, m.sessionId ?? s.id, m.role ?? "user", m.content ?? "", null, "pi", m.createdAt ?? Date.now());
        }
      }
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
```

- [ ] **Step 4: db.ts 接线迁移 + 迁移失败回退 JSON**

在 `src/store/db.ts` 末尾追加（getDb 首次调用后触发迁移；迁移失败时让 session-store 回落 JSON 需通过环境信号，此处用「迁移失败 → 删除 db 文件 + 抛错让上层走 JSON 兜底」太激进，改为：迁移失败仅告警，SQLite 空库继续跑——新会话正常，旧数据手机端暂不可见，靠 migration_done 缺失下次启动重试）：

```ts
// 迁移接线（放在 getDb() 首次建库后、DDL 之后）：
// 在 getDb() 内 DDL 执行后追加：
//   runMigrationIfNeeded();
// 但 runMigrationIfNeeded 依赖 db 已 open，且在 session-store 首次读写前完成。
// 实现：getDb() 结尾加：
//   const { runMigrationIfNeeded } = require("./migration.js");
//   runMigrationIfNeeded();
// （require 延迟，避免 db.ts ↔ migration.ts 循环依赖；migration.ts 只 import db.ts 的 getDb/DATA_DIR）
```

- [ ] **Step 5: 跑迁移测试确认通过**

Run: `cd ~/.agents/agent-configs/pi/extensions/pi-cindy && node tests/migration.test.js`
Expected: `ALL PASS`。

- [ ] **Step 6: 全量测试 + typecheck**

Run: `cd ~/.agents/agent-configs/pi/extensions/pi-cindy && npm test && npm run typecheck`
Expected: 125 passed + 无类型错误。

- [ ] **Step 7: 提交**

```bash
cd ~/.agents
git add agent-configs/pi/extensions/pi-cindy/src/store/migration.ts agent-configs/pi/extensions/pi-cindy/src/store/db.ts agent-configs/pi/extensions/pi-cindy/tests/migration.test.js
git commit -m "feat(pi-cindy): JSON→SQLite 一次性迁移（fail-open + migration_done 幂等）"
```

---

### Task 5: 单持有者仲裁（ownership.ts，copy desktop 适配 node:sqlite）

**Files:**
- Create: `src/ownership.ts`
- Create: `tests/ownership.test.js`
- Modify: `src/index.ts`（接线）

**Interfaces:**
- Consumes: `getDb()`（Task 2）
- Produces:
  - `class DeviceLinkOwnershipArbiter`（copy desktop `ownership.ts` 的 `DeviceLinkOwnershipArbiter` 类 + store 接口，`createDbClientOwnershipStore` 换成 `createSqliteOwnershipStore(db)`）
  - `createSqliteOwnershipStore(db): OwnershipStore` — read/tryInsert/tryTakeover/renew/release 5 方法，SQL 与 desktop `createDbClientOwnershipStore` 逐字一致（单行表 id=1 CAS）
  - `start(ownerPid, ownerLabel, { onAcquire, onDemote, onStandbyChanged }): void`
  - `stop(): Promise<void>`
  - `isOwner() / isStandby(): boolean`

**copy 来源**：`/home/mellow/文档/codes/github/cindy/apps/desktop/src/main/device-link/ownership.ts`（563 行，本仓已 checkout 该文件）。copy `DeviceLinkOwnershipArbiter` 类 + 接口定义原样（去掉 desktop 的 logger → 用 `src/dbg.ts` 的 `dbgLog`），store 实现换 SQLite。

- [ ] **Step 1: 先读 desktop 原文件**

```bash
cat /home/mellow/文档/codes/github/cindy/apps/desktop/src/main/device-link/ownership.ts
```

（本会话已读全文：仲裁类 `DeviceLinkOwnershipArbiter`、接口 `OwnershipStore`/`OwnershipRow`/`OwnershipIdentity`、默认参数 heartbeatMs=5000/staleMs=15000/storeRetryMs=500/opTimeoutMs=heartbeatMs、`createDbClientOwnershipStore`。copy 时保持类逻辑一字不改，只换 store 实现 + logger。）

- [ ] **Step 2: 写仲裁测试（copy desktop ownership.test.ts 语义，node:sqlite 版）**

```js
// tests/ownership.test.js
// 仲裁测试：SQLite 单行表 CAS 语义 + 单持有者/接管/让位（copy desktop ownership.test.ts 语义适配 node:sqlite）。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJiti } = require('jiti');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cindy-owner-'));
process.env.PI_CINDY_DATA_DIR = DATA_DIR;
const jiti = createJiti(__filename, { interopDefault: true });
const dbMod = jiti(path.join(__dirname, '..', 'src', 'store', 'db.ts'));
const ownerMod = jiti(path.join(__dirname, '..', 'src', 'ownership.ts'));
const { createSqliteOwnershipStore, DeviceLinkOwnershipArbiter } = ownerMod;

let failures = 0;
function assert(cond, name, extra) { if (cond) { console.log('  ok:', name); } else { failures++; console.error('  FAIL:', name, extra ?? ''); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // store CAS 语义（同 desktop createDbClientOwnershipStore 测试）
  const db = dbMod.getDb();
  const store = createSqliteOwnershipStore(db);
  const id1 = { ownerId: 'o-1', ownerPid: 111, ownerLabel: 'a' };
  const id2 = { ownerId: 'o-2', ownerPid: 222, ownerLabel: 'b' };
  assert((await store.read()) === null, '空表 read → null');
  assert(await store.tryInsert(id1, 1000), 'tryInsert 首次成功');
  assert(!(await store.tryInsert(id2, 2000)), 'tryInsert 二次失败（单行）');
  assert((await store.read())?.ownerId === 'o-1', 'read 返回 o-1');
  assert(await store.renew('o-1', 3000), 'renew 属主成功');
  assert(!(await store.renew('o-2', 3000)), 'renew 非属主失败');
  // CAS 接管：heartbeat 必须匹配
  const row = await store.read();
  assert(!(await store.tryTakeover({ ownerId: 'o-1', heartbeatAt: 9999 }, id2, 4000)), 'takeover heartbeat 不匹配失败');
  assert(await store.tryTakeover({ ownerId: 'o-1', heartbeatAt: row.heartbeatAt }, id2, 4000), 'takeover CAS 成功');
  assert((await store.read())?.ownerId === 'o-2', '接管后 o-2 持有');
  await store.release('o-2');
  assert((await store.read()) === null, 'release 清空');

  // 仲裁器：first-wins 单持有者
  const eventsA = [], eventsB = [];
  const arbA = new DeviceLinkOwnershipArbiter({
    getStore: () => createSqliteOwnershipStore(dbMod.getDb()),
    instance: { ownerPid: 111, ownerLabel: 'a' },
    onAcquire: () => eventsA.push('acquire'),
    onDemote: () => eventsA.push('demote'),
    heartbeatMs: 20, staleMs: 100, storeRetryMs: 5, opTimeoutMs: 20,
  });
  const arbB = new DeviceLinkOwnershipArbiter({
    getStore: () => createSqliteOwnershipStore(dbMod.getDb()),
    instance: { ownerPid: 222, ownerLabel: 'b' },
    onAcquire: () => eventsB.push('acquire'),
    onDemote: () => eventsB.push('demote'),
    heartbeatMs: 20, staleMs: 100, storeRetryMs: 5, opTimeoutMs: 20,
  });
  arbA.start();
  arbB.start();
  await sleep(120);
  const ownerIsA = eventsA.filter(e => e === 'acquire').length === 1 && eventsB.filter(e => e === 'acquire').length === 0;
  assert(ownerIsA, 'first-wins：A 持有、B 待命');
  assert(arbA.isOwner() && !arbB.isOwner(), 'isOwner 状态正确');
  assert(arbB.isStandby(), 'B 待命态');

  // 持有者停止 → B 接管
  await arbA.stop();
  await sleep(150);
  assert(eventsB.filter(e => e === 'acquire').length >= 1, 'A 退出后 B 接管');

  // 接管：A 心跳停止（不 stop，模拟崩溃）→ B 在 staleMs 后接管
  // 注：A 已 stop；此场景用第三个仲裁器验证 stale 接管
  const eventsC = [];
  const arbC = new DeviceLinkOwnershipArbiter({
    getStore: () => createSqliteOwnershipStore(dbMod.getDb()),
    instance: { ownerPid: 333, ownerLabel: 'c' },
    onAcquire: () => eventsC.push('acquire'),
    heartbeatMs: 20, staleMs: 100, storeRetryMs: 5, opTimeoutMs: 20,
  });
  arbC.start();
  await sleep(250);
  assert(eventsC.filter(e => e === 'acquire').length >= 1, 'B 停止后 C 在 staleMs 窗口接管');

  await Promise.all([arbB.stop(), arbC.stop()]);
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(1); });
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd ~/.agents/agent-configs/pi/extensions/pi-cindy && node tests/ownership.test.js`
Expected: FAIL（`ownership.ts` 不存在）。

- [ ] **Step 4: copy desktop 仲裁类 + 换 store 实现**

```bash
# 从 cindy 参考仓 copy 仲裁类主体（接口 + 类 + 默认参数原样），
# 替换：createLogger → dbgLog；删除 DbClient 版 store，新增 SQLite 版：
```

`src/ownership.ts` 关键结构（类体逐字 copy desktop `DeviceLinkOwnershipArbiter`，此处列差异点与 store 实现）：

```ts
// src/ownership.ts（copy desktop ownership.ts，改动点注释）
// 1. import { dbgLog } from "./dbg.js" 替代 desktop createLogger（log.info/warn/error → dbgLog 或 console）
// 2. 接口 OwnershipStore/OwnershipRow/OwnershipIdentity 原样 copy
// 3. 类 DeviceLinkOwnershipArbiter 原样 copy（含 DEFAULT_HEARTBEAT_MS=5000 等默认参数）
// 4. store 实现换 SQLite：

export interface OwnershipDbAccess {
  queryOne<T = unknown>(sql: string, params?: unknown[]): T | undefined;
  exec(sql: string, params?: unknown[]): { changes: number };
}

/** node:sqlite 适配（DatabaseSync 已 open，WAL + busy_timeout 由 db.ts 保证）。 */
export function createSqliteOwnershipStore(db: {
  prepare: (sql: string) => {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number | bigint };
  };
}): OwnershipStore {
  return {
    async read(): Promise<OwnershipRow | null> {
      const row = db.prepare(
        "SELECT owner_id, owner_pid, heartbeat_at FROM device_link_ownership WHERE id = 1",
      ).get() as { owner_id: string; owner_pid: number; heartbeat_at: number } | undefined;
      if (!row) return null;
      return { ownerId: row.owner_id, ownerPid: row.owner_pid, heartbeatAt: row.heartbeat_at };
    },
    async tryInsert(identity, now): Promise<boolean> {
      const r = db.prepare(
        "INSERT INTO device_link_ownership (id, owner_id, owner_pid, owner_label, heartbeat_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
      ).run(identity.ownerId, identity.ownerPid, identity.ownerLabel, now);
      return Number(r.changes) > 0;
    },
    async tryTakeover(expected, identity, now): Promise<boolean> {
      const r = db.prepare(
        "UPDATE device_link_ownership SET owner_id = ?, owner_pid = ?, owner_label = ?, heartbeat_at = ? WHERE id = 1 AND owner_id = ? AND heartbeat_at = ?",
      ).run(identity.ownerId, identity.ownerPid, identity.ownerLabel, now, expected.ownerId, expected.heartbeatAt);
      return Number(r.changes) > 0;
    },
    async renew(ownerId, now): Promise<boolean> {
      const r = db.prepare("UPDATE device_link_ownership SET heartbeat_at = ? WHERE id = 1 AND owner_id = ?").run(now, ownerId);
      return Number(r.changes) > 0;
    },
    async release(ownerId): Promise<void> {
      await db.prepare("DELETE FROM device_link_ownership WHERE id = 1 AND owner_id = ?").run(ownerId);
    },
  };
}
```

- [ ] **Step 5: 跑仲裁测试确认通过**

Run: `cd ~/.agents/agent-configs/pi/extensions/pi-cindy && node tests/ownership.test.js`
Expected: `ALL PASS`。

- [ ] **Step 6: typecheck**

Run: `cd ~/.agents/agent-configs/pi/extensions/pi-cindy && npm run typecheck`
Expected: 无错误，exit 0。

- [ ] **Step 7: 提交**

```bash
cd ~/.agents
git add agent-configs/pi/extensions/pi-cindy/src/ownership.ts agent-configs/pi/extensions/pi-cindy/tests/ownership.test.js
git commit -m "feat(pi-cindy): 单持有者仲裁（copy desktop ownership.ts，SQLite 单行表 CAS）"
```

---

### Task 6: index.ts 接线仲裁（owner 连 relay / standby 待命）

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `DeviceLinkOwnershipArbiter` / `createSqliteOwnershipStore`（Task 5）、`getDb()`（Task 2）
- Produces: 无（接线变更）

**改造点**：
- `ensureClient()` 加持有者门禁：`if (!ownershipArbiter.isOwner()) return null;`
- 模块级单例仲裁器：登录后 `start()`，登出/退出 `stop()`
- `onAcquire` → 触发 `ensureClient()`（连 relay）；`onDemote` → `client.disconnect()`
- `/cindy-status` 显示 `owner` / `standby (pid=<持有者 pid>)`

- [ ] **Step 1: 读 index.ts 全貌确认接线点**

```bash
cat ~/.agents/agent-configs/pi/extensions/pi-cindy/src/index.ts
```

（本会话已读 50-105 行：`ensureClient` 单例、`session_start` 自动重连、`session_shutdown` 断连、5 命令注册。接线点：`ensureClient` 内部开头 + `session_start` handler + `/cindy-login` + `/cindy-logout`。）

- [ ] **Step 2: 加仲裁器单例 + ensureClient 门禁**

在 `index.ts` 顶部（client 变量附近）加：

```ts
import { DeviceLinkOwnershipArbiter, createSqliteOwnershipStore } from "./ownership.js";
import { getDb } from "./store/db.js";

// 单持有者仲裁：同一时刻只有一台 pi 进程连 relay（4409 根除）。
// 登录后 start()；登出/退出 stop()。onAcquire 才连，onDemote 断开。
let arbiter: DeviceLinkOwnershipArbiter | null = null;
function startArbiter(): void {
  if (arbiter) return;
  arbiter = new DeviceLinkOwnershipArbiter({
    getStore: () => createSqliteOwnershipStore(getDb()),
    instance: { ownerPid: process.pid, ownerLabel: "pi-cindy" },
    onAcquire: () => {
      lastIssue = null;
      ensureClient().catch(() => {});
    },
    onDemote: () => {
      client?.disconnect(); client = null;
    },
  });
  arbiter.start();
}
async function stopArbiter(): Promise<void> {
  if (!arbiter) return;
  const a = arbiter; arbiter = null;
  await a.stop();
}
```

`ensureClient()` 开头加门禁（在 `if (client?.isConnected()) return client;` 之后）：

```ts
// 待命实例不连 relay（单持有者仲裁）：只有持有者建立 WS 连接。
if (arbiter && !arbiter.isOwner()) return null;
```

- [ ] **Step 3: session_start 自动重连 → 需持有者才连**

`session_start` handler 改：先 `startArbiter()`（参与仲裁），再按 `isOwner()` 决定是否 `ensureClient()`：

```ts
pi.on("session_start", async (_event, ctx) => {
  statusCtx = ctx;
  if (isLoggedIn()) {
    try {
      startArbiter();
      if (arbiter?.isOwner()) {
        await ensureClient();
        ctx.ui.notify("Cindy: connected", "info");
        ctx.ui.setStatus("cindy", "Cindy: relay connected");
      } else {
        ctx.ui.setStatus("cindy", "Cindy: standby (另一实例持有连接)");
      }
    } catch {}
  }
});
```

- [ ] **Step 4: /cindy-login 与 /cindy-logout 接线**

`/cindy-login` 成功路径：`startArbiter(); if (arbiter?.isOwner()) await ensureClient(realm);`
`/cindy-logout`：`await stopArbiter();` 放在 `client?.disconnect(); client = null;` 之后。

- [ ] **Step 5: /cindy-status 显示仲裁状态**

status handler 加：
```ts
if (arbiter) {
  status += arbiter.isOwner() ? "\n仲裁: owner (持有 relay 连接)" : "\n仲裁: standby (另一实例持有)";
}
```

- [ ] **Step 6: 冒烟测试 + typecheck**

Run: `cd ~/.agents/agent-configs/pi/extensions/pi-cindy && npm test && npm run typecheck`
Expected: 125 passed（冒烟测试不触发仲裁器——`index.ts` 不在 handler 层测试路径；如触发则断言不变）+ 无类型错误。

- [ ] **Step 7: 真机冒烟（可选，若有条件）**

```bash
# 双 pi 进程同数据目录，验证一 owner 一 standby、无 4409
# 手动验证（需真实登录态，本步骤在桌面环境跑）：
cd ~/.agents/agent-configs/pi/extensions/pi-cindy
PI_CINDY_DEBUG=1 npx pi -e . -c "/cindy-status"  # 进程1（应 owner）
PI_CINDY_DEBUG=1 npx pi -e . -c "/cindy-status"  # 进程2（应 standby）
```

Expected: 进程1 显示 owner，进程2 显示 standby，relay-debug.log 无 4409 循环。

- [ ] **Step 8: 提交**

```bash
cd ~/.agents
git add agent-configs/pi/extensions/pi-cindy/src/index.ts
git commit -m "feat(pi-cindy): 仲裁接线（owner 连 relay / standby 待命，4409 根除）"
```

---

### Task 7: 双进程集成测试 + 文档收尾

**Files:**
- Create: `tests/multi-process.test.js`
- Modify: `docs/HANDOFF.md` / `docs/CHANGELOG.md` / `docs/EXPERIENCE.md`

**Interfaces:**
- Consumes: Task 3-6 全部产物
- Produces: 无（验证 + 文档）

- [ ] **Step 1: 双进程集成测试（同库两进程：一 owner 一 standby，无互踢）**

```js
// tests/multi-process.test.js
// 双进程集成：子进程 fork 两个 node 进程，各自 open 同一 db 文件，
// 验证单持有者仲裁跨进程生效（非单元测试单例模拟）。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cindy-multi-'));

const workerSrc = `
const { createJiti } = require(${JSON.stringify(require.resolve('jiti'))});
process.env.PI_CINDY_DATA_DIR = ${JSON.stringify(DATA_DIR)};
const jiti = createJiti(__filename, { interopDefault: true });
const { getDb } = jiti(${JSON.stringify(path.join(__dirname, '..', 'src', 'store', 'db.ts'))});
const { DeviceLinkOwnershipArbiter, createSqliteOwnershipStore } = jiti(${JSON.stringify(path.join(__dirname, '..', 'src', 'ownership.ts'))});
const arb = new DeviceLinkOwnershipArbiter({
  getStore: () => createSqliteOwnershipStore(getDb()),
  instance: { ownerPid: process.pid, ownerLabel: process.argv[1] },
  onAcquire: () => { console.log(process.argv[1] + ' ACQUIRED'); },
  heartbeatMs: 30, staleMs: 200, storeRetryMs: 10, opTimeoutMs: 30,
});
arb.start();
setTimeout(() => { console.log(process.argv[1] + ' STOP'); arb.stop().then(() => process.exit(0)); }, 1000);
`;

function runWorker(label) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['-e', workerSrc, label], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('close', () => resolve(out));
  });
}

(async () => {
  // 双进程同库：A 先起（应 owner），B 后起（应 standby）
  const pA = spawn(process.execPath, ['-e', workerSrc, 'A'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let outA = '';
  pA.stdout.on('data', (d) => { outA += d.toString(); });
  await new Promise((r) => setTimeout(r, 150)); // A 已认领
  const outB = await runWorker('B');
  const linesB = outB.split('\n').filter(Boolean);
  const aAcquired = outA.includes('A ACQUIRED');
  const bStandby = !outB.includes('B ACQUIRED');
  const bStopped = linesB.some((l) => l.includes('B STOP'));
  console.log('A:', outA.trim());
  console.log('B:', outB.trim());
  let failures = 0;
  if (!aAcquired) { failures++; console.error('FAIL: A 应 acquire'); }
  if (!bStandby) { failures++; console.error('FAIL: B 应 standby（不 acquire）'); }
  if (!bStopped) { failures++; console.error('FAIL: B 应正常退出'); }
  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(1); });
```

- [ ] **Step 2: 跑双进程测试**

Run: `cd ~/.agents/agent-configs/pi/extensions/pi-cindy && node tests/multi-process.test.js`
Expected: `A: A ACQUIRED` + `B: B STOP`（无 B ACQUIRED）→ `ALL PASS`。

- [ ] **Step 3: 全量门禁**

Run: `cd ~/.agents/agent-configs/pi/extensions/pi-cindy && npm test && npm run typecheck`
Expected: 125 + 新测试全绿，typecheck 无错误。

- [ ] **Step 4: 更新 CHANGELOG.md（0.3.0 或 0.2.1，按 HANDOFF 版本规则）**

CHANGELOG 加：

```markdown
## [0.3.0] — 2026-08-06 · 未打 tag

### Added

- 单持有者仲裁（`src/ownership.ts`，copy desktop ownership.ts）：SQLite 单行表
  `device_link_ownership` CAS，first-wins；同一时刻只有一台 pi 进程连 relay，
  其余 standby；5s 心跳续期 / 15s 过期接管 / 退出秒级接管（多 pi 进程共享
  同一数据目录不再 4409 互踢）
- 会话/消息存储 JSON → SQLite（`src/store/db.ts` + `session-store.ts`）：
  node:sqlite（Node 22.23 内置，零原生依赖），WAL + busy_timeout(3000)，
  sessions/messages/device_link_ownership 三表（裁剪自 desktop localDb schema）；
  对外函数签名不变，handler 层零改动；多进程并发写安全（行级写取代整个文件
  last-writer-wins）
- JSON→SQLite 一次性迁移（`src/store/migration.ts`）：fail-open，migration_done
  标记幂等，旧 JSON 保留不删

### Changed

- `/cindy-status` 显示仲裁状态（owner / standby + 持有者）
- `ensureClient` 持有者门禁：standby 实例不建立 relay 连接
```

- [ ] **Step 5: 更新 HANDOFF.md（已完成块快照 + 未完成块路线图）**

HANDOFF 已完成块加：

```markdown
### 2026-08-06 · 多进程共存 + SQLite 化（v0.3.0，spec: docs/specs/2026-08-06-multi-process-sqlite-design.md）

- [x] 单持有者仲裁：copy desktop ownership.ts（SQLite 单行表 CAS），同数据目录多 pi
      进程一 owner 一 standby，4409 互踢根除
- [x] session-store JSON→SQLite（node:sqlite 零依赖，对外签名不变，handler 零改动）
- [x] JSON→SQLite 一次性迁移（fail-open + migration_done 幂等，旧文件保留）
```

未完成块加（P3）：

```markdown
### P3：进阶功能（目标 v0.3.0+）

- [ ] 双进程真机验证（双 pi 进程 + 手机端设备列表/会话可见性实机确认）
- [ ] 旧 JSON 文件人工确认后清理
```

- [ ] **Step 6: 更新 EXPERIENCE.md（新条目 #25）**

```markdown
### 25. 「多进程共享数据」优先对齐 desktop 已解决场景，不自己发明锁

多 pi 进程同数据目录互踢（4409）不是新问题 —— desktop 端早解决
（device-link/ownership.ts 单持有者仲裁）。照搬思路：SQLite 单行表做
跨进程互斥凭据（first-wins + CAS 续期 + stale 接管），比自造 mkdir 原子锁
更硬（CAS 语义、busy_timeout 兜底、已有 586 行测试可平移）。教训：遇到
「多进程/多实例并发」类需求，先查 desktop 同仓实现，copy 而非发明。
```

- [ ] **Step 7: 提交**

```bash
cd ~/.agents
git add agent-configs/pi/extensions/pi-cindy/tests/multi-process.test.js agent-configs/pi/extensions/pi-cindy/docs/
git commit -m "feat(pi-cindy): 双进程集成测试 + v0.3.0 文档收尾"
```

---

## Self-Review 记录

- **Spec 覆盖**：单持有者仲裁 → Task 5/6；SQLite 三表 → Task 2；store 迁移 → Task 3；JSON→SQLite 迁移 → Task 4；并发语义（WAL/busy_timeout/行级写）→ Task 2/3；测试策略 → Task 2-7；YAGNI 排除项 → 无对应任务（正确，不做）；验证标准 → Task 6 Step 7 / Task 7。✓
- **占位符扫描**：无 TBD/TODO；Task 6 Step 1「读 index.ts 全貌」是确认步骤非占位；Task 5 Step 1「cat 原文件」是 copy 前置。✓
- **类型一致性**：`createSqliteOwnershipStore(db)` 签名在 Task 5 定义、Task 6 使用一致；`runMigrationIfNeeded()` 在 Task 4 定义/测试使用一致；store 导出 14 函数名与 Global Constraints 一致。✓

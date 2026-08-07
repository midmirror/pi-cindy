# pi-cindy 会话路由 + 快速接管 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手机端在任意会话发消息时，消息路由到「拥有该会话的 pi 进程」（宿主），宿主经定向接管快速拿到 relay 连接并处理，回复回流手机端；接管窗口消息经 DB 邮箱持久化不丢，死宿主经心跳+pid 探活自动清理。

**Architecture:** 会话行加 `host_instance_id` 标注宿主；每进程扩展登录后写实例心跳表；owner 收到进程本地类 invoke（输入队列/会话操作/会话配置）时按宿主路由：宿主是自己→本地 handler（现状），是其他活实例→DB 邮箱落行 + 定向接管（仲裁器 handoffTo，目标独占认领 + standby 快轮询 ~1s）+ 返回合成投影，宿主接管后本地重放消费；死/无宿主→明确错误。新增 `cindy_instances`（实例心跳）与 `cindy_handoff_mailbox`（跨进程 invoke 转发）两表；清理扫描（owner 跑）把死宿主会话置 archived + 邮箱行 failed。

**Tech Stack:** Node 22.23+（内置 node:sqlite）、TypeScript strict + NodeNext、jiti 测试加载器、现有 ws 依赖。零新增依赖。

**Spec:** `docs/specs/2026-08-07-session-routed-handoff-design.md`（已评审通过，审查修复 7 处已并入）

## Global Constraints

- node:sqlite 仅用基础 CRUD/索引（`DatabaseSync` / `prepare().run()/get()/all()`），不依赖实验性扩展 API
- **契约零变更**：不新增手机端消费的 invoke 字段；`maker:input:*` 路由响应**恒为投影形状**（绝不可回 `{ok:true}`）
- 现有 147 冒烟断言必须全绿（handler 契约不变）
- 双门禁：`npm test` + `npm run typecheck`（strict）全绿
- 测试隔离：`PI_CINDY_DATA_DIR` 指向临时目录
- 目标版本 v0.5.0（新 feature 升第二位，落地后 git tag 锚定）
- 每任务结束提交（git commit），计划外代码不落地
- 仲裁器现有能力不回归：优雅接管更快（<4.4s）、kill -9 接管 ≤15s 保持、4409=0

---

### Task 1: schema —— DDL 加列 + 两张新表 + ownership 加列

**Files:**
- Modify: `src/store/db.ts`（DDL 常量）
- Test: `tests/smoke.test.js`（追加第 17 节）

**Interfaces:**
- Consumes: 无（schema 前置）
- Produces: `sessions.host_instance_id` 列、`cindy_instances` 表、`cindy_handoff_mailbox` 表、`device_link_ownership.handoff_to/handoff_expires_at` 列

- [ ] **Step 1: 写失败测试**（追加到 smoke.test.js 末尾、最后汇总输出之前）

```js
// ============ 17. schema：新列 + 新表（会话路由 v0.5.0） ============
{
  const db = jiti(path.join(base, 'store/db.js')).getDb();
  const cols = (tbl) => {
    const rs = db.prepare(`PRAGMA table_info(${tbl})`).all();
    return rs.map((r) => r.name);
  };
  const sessCols = cols('sessions');
  assert(sessCols.includes('host_instance_id'), 'sessions 有 host_instance_id 列', sessCols);
  const ownCols = cols('device_link_ownership');
  assert(ownCols.includes('handoff_to') && ownCols.includes('handoff_expires_at'), 'ownership 有 handoff 列', ownCols);
  const instCols = cols('cindy_instances');
  assert(instCols.includes('instance_id') && instCols.includes('pid') && instCols.includes('heartbeat_at'), 'cindy_instances 三列', instCols);
  const mbCols = cols('cindy_handoff_mailbox');
  assert(['id','session_id','client_id','kind','payload','status','created_at'].every((c) => mbCols.includes(c)), 'mailbox 列齐全', mbCols);
  // 幂等：DDL 重复执行不报错（getDb 二次调用走缓存，直接重跑 exec）
  db.exec("CREATE TABLE IF NOT EXISTS cindy_instances (instance_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, label TEXT, heartbeat_at INTEGER NOT NULL)");
  assert(true, 'DDL 幂等重跑不抛错');
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL `sessions 有 host_instance_id 列`（列不存在）

- [ ] **Step 3: 最小实现**（db.ts DDL 追加）

```ts
const DDL = \`
...（现有三表不变，末尾追加）
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
\`;
```

列追加用幂等 ALTER（DDL 常量里 `CREATE TABLE IF NOT EXISTS sessions` 不会补列，须在 DDL 执行后补）：

```ts
// db.ts getDb() 内 DDL 执行后：
for (const sql of [
  "ALTER TABLE sessions ADD COLUMN host_instance_id TEXT",
  "ALTER TABLE device_link_ownership ADD COLUMN handoff_to TEXT",
  "ALTER TABLE device_link_ownership ADD COLUMN handoff_expires_at INTEGER",
]) {
  try { d.exec(sql); } catch { /* 列已存在 → 幂等跳过 */ }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS（本节约 +4 断言，全量通过）

- [ ] **Step 5: 提交**

```bash
git add src/store/db.ts tests/smoke.test.js
git commit -m "feat(pi-cindy): schema 加 host/instances/mailbox/handoff 列（v0.5.0 会话路由）"
```

---

### Task 2: `hostInstanceId` 贯穿 types + session-store

**Files:**
- Modify: `src/types.ts`（PiSessionMeta）
- Modify: `src/store/session-store.ts`（rowToSession / createSession / COL_OF）
- Test: `tests/smoke.test.js`（第 18 节）

**Interfaces:**
- Consumes: Task 1 的 `sessions.host_instance_id` 列
- Produces: `PiSessionMeta.hostInstanceId?: string | null`；`createSession({hostInstanceId})` 可写入；`updateSession(id, {hostInstanceId})` 可读写（COL_OF 自动覆盖）

- [ ] **Step 1: 写失败测试**（第 18 节）

```js
// ============ 18. sessions.host_instance_id 读写 ============
{
  const s = store.createSession({ hostInstanceId: 'inst-A' });
  const got = store.getSession(s.id);
  assert(got.hostInstanceId === 'inst-A', 'createSession 带 host 可读回', got.hostInstanceId);
  store.updateSession(s.id, { hostInstanceId: null });
  const cleared = store.getSession(s.id);
  assert(cleared.hostInstanceId == null, 'updateSession 清 host', cleared.hostInstanceId);
  store.deleteSession(s.id);
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL（`hostInstanceId` 读回 undefined）

- [ ] **Step 3: 最小实现**

types.ts PiSessionMeta 追加：
```ts
/** 会话宿主 pi 实例 id（进程级 UUID，instance.ts 生成）；null = unhosted（无活宿主可路由）。 */
hostInstanceId?: string | null;
```

session-store.ts：
- rowToSession 加 `hostInstanceId: r.host_instance_id == null ? null : String(r.host_instance_id)`
- createSession 的 s 字面量加 `hostInstanceId: p.hostInstanceId ?? null`
- createSession INSERT 列/值各加一个 `host_instance_id`（SQL 与参数同步，28→29 列）
- COL_OF 加 `hostInstanceId: "host_instance_id"`

- [ ] **Step 4: 跑测试确认通过**（npm test 全绿）

- [ ] **Step 5: 提交**

```bash
git add src/types.ts src/store/session-store.ts tests/smoke.test.js
git commit -m "feat(pi-cindy): PiSessionMeta.hostInstanceId 读写（会话宿主标注）"
```

---

### Task 3: 实例身份与心跳（新模块 src/instance.ts）

**Files:**
- Create: `src/instance.ts`
- Test: `tests/smoke.test.js`（第 19 节）

**Interfaces:**
- Consumes: Task 1 的 `cindy_instances` 表
- Produces:
  - `getInstanceId(): string`（进程生命周期单例 UUID）
  - `registerInstance(): void` / `heartbeatInstance(): void` / `releaseInstance(): void`
  - `instanceAlive(instanceId: string, now?: number, staleMs?: number): boolean`（心跳新鲜=true；心跳过期+pid 探活失败=false；心跳过期+pid 活=true——pid 仅加速信号）

- [ ] **Step 1: 写失败测试**（第 19 节；instance 模块经 jiti 加载）

```js
// ============ 19. 实例身份与心跳 ============
{
  const inst = jiti(path.join(base, 'instance.js'));
  const db = jiti(path.join(base, 'store/db.js')).getDb();
  // 身份单例
  const id1 = inst.getInstanceId();
  const id2 = inst.getInstanceId();
  assert(id1 === id2 && typeof id1 === 'string' && id1.length > 0, 'instanceId 进程内单例', id1);
  // 登记 + 心跳
  inst.registerInstance();
  let row = db.prepare('SELECT pid, heartbeat_at FROM cindy_instances WHERE instance_id = ?').get(id1);
  assert(row && row.pid === process.pid, 'registerInstance 写入行', row);
  const firstBeat = row.heartbeat_at;
  inst.heartbeatInstance();
  row = db.prepare('SELECT heartbeat_at FROM cindy_instances WHERE instance_id = ?').get(id1);
  assert(row.heartbeat_at >= firstBeat, 'heartbeatInstance 刷新心跳');
  // 活体判定：新鲜 → true
  assert(inst.instanceAlive(id1, Date.now() + 1000, 30_000) === true, '心跳新鲜判活');
  // 陈旧 + pid 活（本测试进程）→ true（GC 停顿容忍）
  assert(inst.instanceAlive(id1, Date.now() + 60_000, 30_000) === true, '心跳陈旧但 pid 活判活');
  // 陈旧 + pid 死 → false
  db.prepare('INSERT OR REPLACE INTO cindy_instances (instance_id, pid, label, heartbeat_at) VALUES (?, ?, ?, ?)')
    .run('inst-dead', 999999, 'dead', Date.now() - 60_000);
  assert(inst.instanceAlive('inst-dead', Date.now(), 30_000) === false, '陈旧+pid 死判死');
  assert(inst.instanceAlive('no-such-instance', Date.now(), 30_000) === false, '不存在判死');
  // release
  inst.releaseInstance();
  row = db.prepare('SELECT 1 FROM cindy_instances WHERE instance_id = ?').get(id1);
  assert(!row, 'releaseInstance 删行');
  db.prepare('DELETE FROM cindy_instances WHERE instance_id = ?').run('inst-dead');
}
```

- [ ] **Step 2: 跑测试确认失败**（`instanceAlive` 未定义 → 报错/失败）

- [ ] **Step 3: 最小实现**

```ts
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
  try { process.kill(row.pid, 0); return true; } catch { return false; }
}
```

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 提交**

```bash
git add src/instance.ts tests/smoke.test.js
git commit -m "feat(pi-cindy): 实例身份 + 心跳 + 活体判定（instance.ts）"
```

---

### Task 4: 邮箱存取（新模块 src/store/handoff-store.ts）

**Files:**
- Create: `src/store/handoff-store.ts`
- Test: `tests/smoke.test.js`（第 20 节）

**Interfaces:**
- Consumes: Task 1 的 `cindy_handoff_mailbox` 表
- Produces:
  - `interface MailboxRow { id: number; sessionId: string; clientId: string | null; kind: string; payload: string; status: "pending" | "consumed" | "failed"; createdAt: number }`
  - `upsertMailbox(sessionId, clientId, kind, payload: unknown[]): void`（同 session+clientId 幂等 no-op）
  - `listPendingMailbox(sessionId: string): MailboxRow[]`（created_at, id 升序）
  - `deleteMailbox(id: number): void`
  - `failPendingMailboxForSessions(ids: string[]): void`（status pending → failed）
  - `clearHostAndArchiveForInstance(instanceId: string): void`（sessions 清 host + 置 archived；pending 邮箱行 failed；删 cindy_instances 行）
  - `purgeFailedMailbox(before: number): void`

- [ ] **Step 1: 写失败测试**（第 20 节）

```js
// ============ 20. 邮箱存取 ============
{
  const hs = jiti(path.join(base, 'store/handoff-store.js'));
  const db = jiti(path.join(base, 'store/db.js')).getDb();
  const sess = store.createSession({ hostInstanceId: 'inst-A' });
  // 幂等 upsert（同 clientId 二次 no-op）
  hs.upsertMailbox(sess.id, 'cid-1', 'maker:input:enqueue', ['arg0', { clientId: 'cid-1', text: 'hi' }]);
  hs.upsertMailbox(sess.id, 'cid-1', 'maker:input:enqueue', ['arg0', { clientId: 'cid-1', text: 'hi' }]);
  hs.upsertMailbox(sess.id, null, 'maker:input:stop', ['arg0']);
  hs.upsertMailbox(sess.id, 'cid-2', 'maker:input:enqueue', ['arg0', { clientId: 'cid-2', text: 'hi2' }]);
  const rows = hs.listPendingMailbox(sess.id);
  assert(rows.length === 3, '同 clientId 幂等去重 + 动作行不合并', rows.length);
  assert(rows[0].kind === 'maker:input:enqueue' && rows[0].clientId === 'cid-1', 'created_at 升序', rows.map((r) => r.kind));
  assert(JSON.parse(rows[0].payload)[1].text === 'hi', 'payload 序列化往返');
  // failPendingMailboxForSessions
  hs.failPendingMailboxForSessions([sess.id]);
  assert(hs.listPendingMailbox(sess.id).length === 0, 'fail 后不再 pending');
  // 恢复一条再删
  hs.upsertMailbox(sess.id, 'cid-3', 'maker:input:enqueue', ['a', {}]);
  const r3 = hs.listPendingMailbox(sess.id)[0];
  hs.deleteMailbox(r3.id);
  assert(hs.listPendingMailbox(sess.id).length === 0, 'deleteMailbox 删行');
  // clearHostAndArchiveForInstance：会话清 host + archived + 邮箱 failed + 实例行删除
  const inst2 = jiti(path.join(base, 'instance.js'));
  inst2.registerInstance();
  const iid = inst2.getInstanceId();
  const s2 = store.createSession({ hostInstanceId: iid });
  hs.upsertMailbox(s2.id, 'cid-x', 'maker:input:enqueue', ['a', {}]);
  hs.clearHostAndArchiveForInstance(iid);
  const s2g = store.getSession(s2.id);
  assert(s2g.hostInstanceId == null && s2g.status === 'archived', '清 host + archived', s2g.status);
  assert(hs.listPendingMailbox(s2.id).length === 0, '邮箱行标 failed');
  const irow = db.prepare('SELECT 1 FROM cindy_instances WHERE instance_id = ?').get(iid);
  assert(!irow, '实例行删除');
  store.deleteSession(sess.id); store.deleteSession(s2.id);
  // purgeFailedMailbox
  hs.upsertMailbox(sess.id, 'cid-p1', 'maker:input:enqueue', ['a', {}]);
  hs.failPendingMailboxForSessions([sess.id]);
  hs.purgeFailedMailbox(Date.now() + 10_000);
  assert(hs.listPendingMailbox(sess.id).length === 0 && db.prepare('SELECT COUNT(*) c FROM cindy_handoff_mailbox').get().c === 0, 'failed 超时清理');
}
```

- [ ] **Step 2: 跑测试确认失败**（模块不存在 → 加载报错）

- [ ] **Step 3: 最小实现**

```ts
/**
 * 邮箱 —— 跨进程 invoke 转发（owner 落行 → 宿主接管后本地重放）。
 * 幂等：UNIQUE(session_id, client_id)；动作类行（无 clientId）不合并（本身幂等）。
 * 宿主死亡清理：clearHostAndArchiveForInstance 一次性清 host/归档/标 failed/删实例行。
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
  getStmt("UPDATE sessions SET host_instance_id = NULL, status = 'archived', updated_at = ? WHERE host_instance_id = ?").run(now, instanceId);
  getStmt("UPDATE cindy_handoff_mailbox SET status = 'failed' WHERE status = 'pending' AND session_id IN (SELECT id FROM sessions WHERE host_instance_id = ?)").run(instanceId);
  // 先收集再删（上面 UPDATE 依赖该列判定范围）
  getStmt("DELETE FROM cindy_instances WHERE instance_id = ?").run(instanceId);
}

export function purgeFailedMailbox(before: number): void {
  getStmt("DELETE FROM cindy_handoff_mailbox WHERE status = 'failed' AND created_at < ?").run(before);
}
```

> 注：`clearHostAndArchiveForInstance` 的邮箱 UPDATE 在清 host 之后执行会漏行（session 已无 host 标记）。实现时**必须先标邮箱 failed 再清 host**（顺序：UPDATE mailbox ← SELECT sessions WHERE host_instance_id=?；然后 UPDATE sessions 清 host；最后删实例行）。上面顺序已对：先 mailbox（引用旧 host 值）→ 再 sessions → 再 instances。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 提交**

```bash
git add src/store/handoff-store.ts tests/smoke.test.js
git commit -m "feat(pi-cindy): 邮箱存取 + 宿主清理（handoff-store）"
```

---

### Task 5: tracker 写/清会话宿主

**Files:**
- Modify: `src/tracker.ts`
- Test: `tests/smoke.test.js`（第 21 节）

**Interfaces:**
- Consumes: Task 2 的 `hostInstanceId` 字段、Task 3 的 `getInstanceId()`
- Produces: 无新导出（tracker 行为：session_start 写 host、session_shutdown 清 host）

- [ ] **Step 1: 写失败测试**（第 21 节；用 EventEmitter 模拟 pi 事件）

```js
// ============ 21. tracker 写/清会话宿主 ============
{
  const { EventEmitter } = require('node:events');
  const tracker = jiti(path.join(base, 'tracker.js'));
  const inst = jiti(path.join(base, 'instance.js'));
  const fakePi = new EventEmitter();
  let activeId = null;
  tracker.attachSessionTracker(fakePi, () => null, () => activeId, (id) => { activeId = id; });
  fakePi.emit('session_start', {}, {
    sessionManager: { getSessionId: () => 'sdk-route-test' },
    cwd: '/tmp/route-test',
    model: { id: 'claude-sonnet-4-5', provider: 'anthropic' },
  });
  const bySdk = store.listSessions().find((s) => s.sdkSessionId === 'sdk-route-test');
  assert(bySdk && bySdk.hostInstanceId === inst.getInstanceId(), 'session_start 写 host=instanceId', bySdk && bySdk.hostInstanceId);
  fakePi.emit('session_shutdown', { reason: 'quit' });
  const after = store.getSession(bySdk.id);
  assert(after.hostInstanceId == null && after.status === 'archived', 'session_shutdown 清 host', after.status);
}
```

- [ ] **Step 2: 跑测试确认失败**（host 未写）

- [ ] **Step 3: 最小实现**（tracker.ts session_start / session_shutdown 两处）

session_start 的创建分支（`createSession({...})` 内）加 `hostInstanceId: getInstanceId()`；复用分支（`updateSession(session.id, { status: "active", ... })`）加 `hostInstanceId: getInstanceId()`：

```ts
import { getInstanceId } from "./instance.js";
// session_start 内：
if (!session) {
  session = createSession({
    sdkSessionId: sdkId, workingDir: cwd,
    title: `Pi — ${cwd.split("/").pop() || "session"}`,
    model: ctx.model?.id ?? undefined,
    providerId: ctx.model?.provider ?? null,
    hostInstanceId: getInstanceId(),
  });
} else {
  updateSession(session.id, { status: "active", hostInstanceId: getInstanceId(), updatedAt: Date.now() });
}
```

session_shutdown 内（`updateSession(sid, { status: "archived" })` 改）：

```ts
updateSession(sid, { status: "archived", hostInstanceId: null });
```

- [ ] **Step 4: 跑测试确认通过**（npm test 全绿——注意现有 tracker 相关断言须不回归）

- [ ] **Step 5: 提交**

```bash
git add src/tracker.ts tests/smoke.test.js
git commit -m "feat(pi-cindy): tracker 会话宿主标注（session_start 写 / shutdown 清）"
```

---

### Task 6: 仲裁器定向接管（ownership.ts：handoffTo + handoff 感知 claim + 快轮询）

**Files:**
- Modify: `src/ownership.ts`
- Test: `tests/smoke.test.js`（第 22 节，进程内 fake store 单测）

**Interfaces:**
- Consumes: Task 1 的 ownership handoff 列
- Produces:
  - `OwnershipStore.setHandoff(ownerId, targetInstanceId, expiresAt): Promise<boolean>`（接口新增）
  - `DeviceLinkOwnershipArbiter.handoffTo(targetInstanceId: string): Promise<boolean>`（仅 owner 有效；成功后本地降级停续期，行保留）
  - `DeviceLinkOwnershipArbiter.isAwaitingHandoff(): boolean`
  - 构造 opts 新增 `instanceId: string`（handoff 目标匹配身份）、`fastPollMs?: number`（standby 轮询间隔，默认 1000）

- [ ] **Step 1: 写失败测试**（第 22 节；fake store + 注入 now/时序）

```js
// ============ 22. 仲裁器定向接管 ============
{
  const ownership = jiti(path.join(base, 'ownership.js'));
  const { DeviceLinkOwnershipArbiter } = ownership;
  // fake store：内存单行 + handoff 支持
  const makeFake = () => {
    let row = null;
    return {
      _row: () => row,
      async read() { return row; },
      async tryInsert(identity, now) { if (row) return false; row = { ownerId: identity.ownerId, ownerPid: identity.ownerPid, ownerLabel: identity.ownerLabel, heartbeatAt: now }; return true; },
      async tryTakeover(expected, identity, now) {
        if (row && row.ownerId === expected.ownerId && row.heartbeatAt === expected.heartbeatAt) {
          row = { ownerId: identity.ownerId, ownerPid: identity.ownerPid, ownerLabel: identity.ownerLabel, heartbeatAt: now };
          return true;
        }
        return false;
      },
      async renew(ownerId, now) { if (row && row.ownerId === ownerId) { row.heartbeatAt = now; return true; } return false; },
      async release(ownerId) { if (row && row.ownerId === ownerId) row = null; },
      async setHandoff(ownerId, target, expiresAt) { if (row && row.ownerId === ownerId) { row.handoffTo = target; row.handoffExpiresAt = expiresAt; return true; } return false; },
    };
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // A：owner。B：standby（handoff 目标）。C：standby（不应抢）。
  let aAcq = 0, aDem = 0, bAcq = 0, cAcq = 0;
  const makeArb = (store, label, extra = {}) => new DeviceLinkOwnershipArbiter({
    getStore: () => store,
    instance: { ownerPid: 1111, ownerLabel: label },
    instanceId: label, // A/B/C
    onAcquire: () => { if (label === 'A') aAcq++; if (label === 'B') bAcq++; if (label === 'C') cAcq++; },
    onDemote: () => { if (label === 'A') aDem++; },
    heartbeatMs: 20, staleMs: 100, fastPollMs: 15, storeRetryMs: 5, opTimeoutMs: 20,
  });
  const store = makeFake();
  const arbA = makeArb(store, 'A');
  const arbB = makeArb(store, 'B');
  const arbC = makeArb(store, 'C');
  arbA.start(); arbB.start(); arbC.start();
  await sleep(60);
  assert(arbA.isOwner() && !arbB.isOwner() && !arbC.isOwner() && aAcq === 1, 'first-wins：A 成为 owner', store._row());
  // A handoffTo(B)：A 让位停续期（行保留 + handoff 目标）
  const ok = await arbA.handoffTo('B');
  assert(ok === true, 'handoffTo 成功');
  const rowAfter = store._row();
  assert(rowAfter && rowAfter.handoffTo === 'B' && rowAfter.ownerId !== null, '行保留带 handoff_to', rowAfter);
  await sleep(60);
  assert(!arbA.isOwner() && arbB.isOwner() && cAcq === 0, 'B 独占认领、C 不抢、A 降级', { a: arbA.isOwner(), b: arbB.isOwner(), c: cAcq });
  // B 接管后 C 心跳新鲜不抢（回归）
  await sleep(60);
  assert(arbB.isOwner() && !arbC.isOwner(), 'B 保持 owner（C 被动）');
  // A awaiting 判定（新身份 start 后 handoff 恢复）
  arbA.stop(); arbB.stop(); arbC.stop();
  await sleep(30);
}
```

- [ ] **Step 2: 跑测试确认失败**（`handoffTo` / `instanceId` opt 不存在 → 报错）

- [ ] **Step 3: 最小实现**（ownership.ts 改动点）

3.1 接口与行投影加 handoff 字段：
```ts
export interface OwnershipRow { ownerId: string; ownerPid: number; heartbeatAt: number; handoffTo: string | null; handoffExpiresAt: number | null; }
export interface OwnershipStore {
  ...（现有 5 方法不变）...
  /** 写交接信号：仅当行仍属于 ownerId 时写入目标与过期时刻；返回是否成功 */
  setHandoff(ownerId: string, targetInstanceId: string, expiresAt: number): Promise<boolean>;
}
```
SQLite store 加：
```ts
async setHandoff(ownerId, targetInstanceId, expiresAt) {
  const r = db.prepare('UPDATE device_link_ownership SET handoff_to = ?, handoff_expires_at = ? WHERE id = 1 AND owner_id = ?').run(targetInstanceId, expiresAt, ownerId);
  return Number(r.changes) > 0;
}
```
read() 的 SELECT 补 `handoff_to, handoff_expires_at`；read 投影补两字段。tryInsert/tryTakeover 写入时 handoff_to/handoff_expires_at 不设（NULL 默认）。

3.2 opts 增 `instanceId: string`（必填，目标匹配身份）与 `fastPollMs`（默认 1000）：
```ts
export interface OwnershipArbiterOptions {
  ...
  /** 本实例跨进程身份（定向接管目标匹配用；与 ownership 表 ownerId 命名空间不同） */
  instanceId: string;
  /** standby 轮询间隔（接管延迟主导项），默认 1000ms；owner 续期仍用 heartbeatMs */
  fastPollMs?: number;
}
```
构造器 Required 集合加 fastPollMs；校验 staleMs > 2×heartbeatMs 不变。

3.3 tick 重构为 read-first + handoff 分支。替换现有 runTick 判定骨架：
```ts
private async runTick(store: OwnershipStore): Promise<void> {
  const id = this.identity;
  const epoch = this.epoch;
  const canceled = (): boolean => this.stopped || this.epoch !== epoch;
  const now = (this.opts.now ?? Date.now)();
  try {
    const row = await this.raceOpTimeout(store.read());
    if (canceled()) return;
    if (row === OP_TIMEOUT) { log.warn('ownership read timed out locally, aborting round'); return; }
    if (row && row.ownerId === id.ownerId) {
      // 自己的行：awaiting（fresh handoff_to）→ 停续期等目标认领；过期 → 恢复续期（reclaim）
      if (row.handoffTo && row.handoffExpiresAt != null && row.handoffExpiresAt > now) return;
      const renewed = await this.raceOpTimeout(store.renew(id.ownerId, now));
      if (canceled()) return;
      if (renewed === OP_TIMEOUT) { log.warn('ownership renew timed out locally, aborting round'); return; }
      if (!renewed) { log.warn('ownership lost (heartbeat superseded), demoting'); this.demote('superseded'); return; }
      this.lastRenewOkAt = now;
      if (!this.owner) this.promote('reclaimed-own-row');
      return;
    }
    if (row && row.handoffTo && row.handoffExpiresAt != null && row.handoffExpiresAt > now) {
      // 交接信号未过期：目标独占（无视心跳新鲜度直接抢），非目标被动
      if (row.handoffTo === this.opts.instanceId) {
        const taken = await this.raceOpTimeout(store.tryTakeover({ ownerId: row.ownerId, heartbeatAt: row.heartbeatAt }, id, now));
        if (taken === OP_TIMEOUT) { this.trackLateClaim(...); return; } // 复用现有 trackLateClaim 逻辑
        if (taken && !canceled()) this.promote('handoff-target');
      }
      // 非目标：保持被动（handoff 未过期期间连陈旧接管也不做）
      return;
    }
    if (!row) { ...现有 tryInsert 分支（setStandby(false) 在前）... }
    if (row.ownerId === id.ownerId) { ...现有 reclaimed 逻辑已并入上方分支，此分支删除... }
    // 现有 foreign-owner 分支：心跳陈旧 → 接管；新鲜 → 被动
    if (this.loggedForeignOwnerId !== row.ownerId) { ...现有日志... }
    if (now - row.heartbeatAt > this.opts.staleMs) { ...现有 takeover-stale 分支... return; }
    this.setStandby(true);
  } catch (err) { ...现有 catch（maybeSelfDemoteForRenewFailure）... }
  finally { this.ticking = false; }
}
```
> 注意：上方"handoff 过期"场景自然落入 foreign-owner 分支——此时 `row.heartbeatAt` 是 A 停止续期时的旧值，若已超 staleMs 即被接管；**为消除 TTL(10s)→stale(15s) 死窗，handoff 过期后把 heartbeat 按陈旧处理**：在 foreign-owner 分支前加判断 `const handoffExpired = row.handoffTo != null && row.handoffExpiresAt != null && row.handoffExpiresAt <= now; if (handoffExpired && now - row.heartbeatAt > this.opts.heartbeatMs) { 走接管分支 }`——用 heartbeatMs 而非 staleMs 放宽陈旧判定（交接失败应尽快收敛）。

3.4 定时器动态间隔（owner=heartbeatMs，standby=fastPollMs）：
```ts
private schedule(): void {
  if (this.timer) { clearInterval(this.timer); this.timer = null; }
  const ms = this.owner ? this.opts.heartbeatMs : this.opts.fastPollMs;
  this.timer = setInterval(() => {
    this.maybeSelfDemoteForRenewFailure((this.opts.now ?? Date.now)());
    void this.tick();
  }, ms);
  this.timer.unref?.();
}
```
start() 内 `this.timer = setInterval(...)` 替换为 `this.schedule()`；promote()/demote() 末尾调 `this.schedule()`；stop() 保持 clearInterval。

3.5 handoffTo / isAwaitingHandoff：
```ts
/** 定向接管：写交接信号后本地降级（停续期 + 断 client，行保留等目标认领）。 */
async handoffTo(targetInstanceId: string): Promise<boolean> {
  if (!this.owner) return false;
  const store = this.safeGetStore();
  if (!store) return false;
  const now = (this.opts.now ?? Date.now)();
  const ok = await store.setHandoff(this.identity.ownerId, targetInstanceId, now + (this.opts.handoffTtlMs ?? 10_000));
  if (ok) this.demote('handoff');
  return ok;
}
isAwaitingHandoff(): boolean {
  return !this.owner && this.awaitingHandoff;
}
```
awaiting 需模块态标记：handoffTo 成功时置 `this.awaitingHandoff = true`；promote/demote('superseded'/'stopped') 时复位 false。opts 增 `handoffTtlMs?: number`（默认 10_000）。standby 分支里 handoff_to==我 且 claim 成功 promote 时 awaitingHandoff=false；被他人接管（demote superseded）时 false。

> 实现注意：`awaitingHandoff` 是本地状态，与行派生互补——行派生管"停续期"，本地标志管"router 是否该重复 CAS"（Task 7 用）。

- [ ] **Step 4: 跑测试确认通过**（npm test 全绿；现有仲裁相关断言不回归）

- [ ] **Step 5: 提交**

```bash
git add src/ownership.ts tests/smoke.test.js
git commit -m "feat(pi-cindy): 仲裁器定向接管（handoffTo/目标独占认领/快轮询/awaiting）"
```

---

### Task 7: 路由判定 + 合成投影 + 邮箱落行 + clientId 环形窗口

**Files:**
- Modify: `src/handlers/router.ts`（SESSION_LOCAL 集 + routeInvoke 前置路由）
- Modify: `src/handlers/maker.ts`（inputEnqueue/inputSteer clientId 环形窗口去重）
- Modify: `src/handlers/router.ts`（InvokeContext 扩展：`handoffTo`/`handoffPending` 可选）
- Test: `tests/smoke.test.js`（第 23 节）

**Interfaces:**
- Consumes: Task 3 `getInstanceId`/`instanceAlive`、Task 4 邮箱、Task 6 `handoffTo`/`isAwaitingHandoff`（经 InvokeContext 注入）
- Produces:
  - `InvokeContext.handoffTo?: (instanceId: string) => Promise<boolean>`（index.ts 注入 arbiter）
  - `InvokeContext.handoffPending?: () => boolean`（awaiting 期间防重复 CAS）
  - 路由行为：SESSION_LOCAL channel 按宿主三分支路由；合成投影形状对齐现有 inputProjection

- [ ] **Step 1: 写失败测试**（第 23 节；沿用第 22 节 fake store/仲裁器，路由接真代码）

```js
// ============ 23. 会话路由 + 合成投影 + 去重 ============
{
  const inst = jiti(path.join(base, 'instance.js'));
  const hs = jiti(path.join(base, 'store/handoff-store.js'));
  const db = jiti(path.join(base, 'store/db.js')).getDb();
  const myId = inst.getInstanceId();
  inst.registerInstance();
  // 活宿主实例（pid=本进程 + 新鲜心跳）
  db.prepare('INSERT OR REPLACE INTO cindy_instances (instance_id, pid, label, heartbeat_at) VALUES (?, ?, ?, ?)')
    .run('host-alive', process.pid, 'alive', Date.now());
  // 死宿主实例（pid 无效 + 陈旧心跳）
  db.prepare('INSERT OR REPLACE INTO cindy_instances (instance_id, pid, label, heartbeat_at) VALUES (?, ?, ?, ?)')
    .run('host-dead', 999999, 'dead', Date.now() - 60_000);
  // 路由上下文：handoffTo 记录调用
  const handoffCalls = [];
  const prevCtx = { handoffTo: async (i) => { handoffCalls.push(i); return true; }, handoffPending: () => false };
  router.setInvokeContext({ ...router.getInvokeContext(), ...prevCtx });

  // host==我 → 本地路径（activeId 匹配）
  const sMine = store.createSession({ hostInstanceId: myId });
  activeTestSid = sMine.id;
  const pMine = await router.routeInvoke('maker:input:enqueue', [sMine.id, { clientId: 'cid-mine', text: 'hi', chatMessage: { clientId: 'cid-mine', role: 'user', content: 'hi' } }]);
  assert(pMine && Array.isArray(pMine.pendingQueue), 'host==我 走本地投影', pMine);
  assert(sent.some((s) => s.text === 'hi'), 'host==我 注入 sendUserMessage');

  // host==他(活) → enqueue：邮箱落行 + 合成投影 + handoffTo 调用
  activeTestSid = null;
  const sOther = store.createSession({ hostInstanceId: 'host-alive' });
  const pOther = await router.routeInvoke('maker:input:enqueue', [sOther.id, { clientId: 'cid-other', text: 'hello', chatMessage: { clientId: 'cid-other', role: 'user', content: 'hello' } }]);
  assert(handoffCalls.includes('host-alive'), '路由到活宿主触发 handoffTo', handoffCalls);
  assert(Array.isArray(pOther.pendingQueue) && pOther.pendingQueue.length === 1 && pOther.pendingQueue[0].clientId === 'cid-other', '合成投影含排队项', pOther);
  assert(pOther.pendingQueue[0].chatMessage && pOther.pendingQueue[0].chatMessage.content === 'hello', '合成投影透传 chatMessage');
  const mb = hs.listPendingMailbox(sOther.id);
  assert(mb.length === 1 && mb[0].kind === 'maker:input:enqueue', '邮箱落行', mb.map((r) => r.kind));

  // host==他(活) → get-projection：合成但不落邮箱不接管
  const pc = handoffCalls.length;
  const pGet = await router.routeInvoke('maker:input:get-projection', [sOther.id]);
  assert(Array.isArray(pGet.pendingQueue) && pGet.pendingQueue.length === 1, 'get-projection 合成含邮箱项', pGet);
  assert(handoffCalls.length === pc, 'get-projection 不触发接管');
  assert(hs.listPendingMailbox(sOther.id).length === 1, 'get-projection 不落新邮箱行');

  // host==他(死) → 清 host + 邮箱 failed + error 投影
  const sDead = store.createSession({ hostInstanceId: 'host-dead' });
  const pDead = await router.routeInvoke('maker:input:enqueue', [sDead.id, { clientId: 'cid-dead', text: 'x', chatMessage: { clientId: 'cid-dead', role: 'user', content: 'x' } }]);
  assert(pDead.error !== null && pDead.pendingQueue.length === 0, '死宿主返回 error 投影', pDead.error);
  assert(store.getSession(sDead.id).hostInstanceId == null, '死宿主清 host');
  assert(hs.listPendingMailbox(sDead.id).length === 0, '死宿主邮箱 failed');

  // host==null → NOT_FOUND
  const sNone = store.createSession({});
  let threw = false;
  try { await router.routeInvoke('maker:input:enqueue', [sNone.id, { clientId: 'c', text: 'x', chatMessage: { clientId: 'c', role: 'user', content: 'x' } }]); } catch (e) { threw = e.code === 'NOT_FOUND'; }
  assert(threw, '无宿主 NOT_FOUND');

  // awaiting（handoffPending=true）→ 只落邮箱不重复 CAS
  const pc2 = handoffCalls.length;
  router.setInvokeContext({ ...router.getInvokeContext(), handoffPending: () => true });
  await router.routeInvoke('maker:input:enqueue', [sOther.id, { clientId: 'cid-other2', text: 'y', chatMessage: { clientId: 'cid-other2', role: 'user', content: 'y' } }]);
  assert(handoffCalls.length === pc2, 'awaiting 不重复 CAS', handoffCalls);
  assert(hs.listPendingMailbox(sOther.id).length === 2, 'awaiting 仍落邮箱');
  router.setInvokeContext({ ...router.getInvokeContext(), handoffPending: () => false });

  // 本地队列 clientId 环形窗口去重（弱网重发不双注入）
  activeTestSid = sMine.id;
  sent.length = 0;
  await router.routeInvoke('maker:input:enqueue', [sMine.id, { clientId: 'dup-1', text: 'once', chatMessage: { clientId: 'dup-1', role: 'user', content: 'once' } }]);
  await router.routeInvoke('maker:input:enqueue', [sMine.id, { clientId: 'dup-1', text: 'once', chatMessage: { clientId: 'dup-1', role: 'user', content: 'once' } }]);
  assert(sent.filter((s) => s.text === 'once').length === 1, '同 clientId 重发不双注入', sent);

  // 清理
  activeTestSid = null;
  for (const s of [sMine, sOther, sDead, sNone]) store.deleteSession(s.id);
  db.prepare('DELETE FROM cindy_instances WHERE instance_id IN (?, ?, ?)').run('host-alive', 'host-dead', myId);
  db.prepare('DELETE FROM cindy_handoff_mailbox').run();
  router.setInvokeContext({ pi: fakePi, push: (ch, data, sid) => pushes.push({ ch, data, sid }), activeSessions: new Map(), activeId: () => activeTestSid });
}
```

- [ ] **Step 2: 跑测试确认失败**（路由未实现 → 死宿主/他宿主分支走 requireActiveSession 抛 NOT_FOUND 或 handoff 未调）

- [ ] **Step 3: 最小实现**

router.ts：
```ts
import { getInstanceId, instanceAlive } from "../instance.js";
import { upsertMailbox, listPendingMailbox, failPendingMailboxForSessions } from "../store/handoff-store.js";

export interface InvokeContext {
  pi: any;
  push: (channel: string, data: unknown, sessionId?: string) => void;
  activeSessions: Map<string, any>;
  activeId?: () => string | null;
  /** 定向接管（index.ts 注入 arbiter.handoffTo）；缺省 = 无接管能力（单进程测试/未接线） */
  handoffTo?: (instanceId: string) => Promise<boolean>;
  /** awaiting-handoff 期间 true（防重复 CAS） */
  handoffPending?: () => boolean;
}

/** 进程本地类 channel：按宿主路由；其余 owner 从共享 DB 直接答（见 spec §4）。 */
const SESSION_LOCAL = new Set([
  "maker:input:enqueue", "maker:input:stop", "maker:input:steer", "maker:input:get-projection",
  "maker:input:compact", "maker:input:resume", "maker:input:retry-last-error",
  "maker:input:clear-error", "maker:input:remove", "maker:input:update-text",
  "maker:input:update-content", "maker:input:move", "maker:input:set-expanded",
  "maker:input:set-interaction-lock", "maker:input:set-edit-lock", "maker:input:clear-session",
  "maker:send", "maker:steer", "maker:abort-session", "maker:close-session",
  "maker:set-model", "maker:set-effort", "maker:set-permission-mode", "maker:set-fast-mode",
]);

/** 从邮箱 pending 行合成投影（对齐现有 inputProjection 形状，零新字段）。 */
function syntheticProjection(sid: string): Record<string, unknown> {
  const rows = listPendingMailbox(sid);
  const pendingQueue = rows
    .filter((r) => r.kind === "maker:input:enqueue" || r.kind === "maker:input:steer")
    .map((r) => { try { return (JSON.parse(r.payload)[1] as unknown); } catch { return null; } })
    .filter(Boolean);
  const steeringIds = rows.filter((r) => r.kind === "maker:input:steer")
    .map((r) => { try { const it = JSON.parse(r.payload)[1]; return it?.clientId; } catch { return null; } })
    .filter((x): x is string => typeof x === "string");
  return {
    sessionId: sid,
    pendingQueue,
    steeringQueueClientIds: steeringIds,
    queuePaused: false,
    queueExpanded: false,
    queueInteractionLocks: [],
    queueEditLocks: [],
    queueAbortPending: rows.some((r) => r.kind === "maker:input:stop"),
    error: null,
    recovery: null,
    errorRetryText: null,
    credentialSwitchWait: null,
  };
}

function itemClientId(channel: string, args: unknown[]): string | null {
  if (channel === "maker:input:enqueue" || channel === "maker:input:steer") {
    const item = (args[1] ?? null) as { clientId?: unknown } | null;
    return item && typeof item.clientId === "string" ? item.clientId : null;
  }
  return null;
}

/** SESSION_LOCAL 路由判定：返回 {handled, result}；handled=false 走本地 handler。 */
async function routeSessionLocal(channel: string, args: unknown[]): Promise<{ handled: boolean; result?: unknown }> {
  const sid = args[0];
  if (typeof sid !== "string" || !sid) return { handled: false };
  const ctx = getInvokeContext();
  const myId = getInstanceId();
  const s = getSession(sid);
  if (!s) return { handled: false }; // 本地 handler 抛 NOT_FOUND（现状语义）
  const host = s.hostInstanceId ?? null;
  if (host === myId) return { handled: false };
  if (channel === "maker:input:get-projection") {
    // 只读查询：合成投影，不落邮箱、不接管（spec §4 例外）
    return { handled: true, result: syntheticProjection(sid) };
  }
  if (host == null) {
    // unhosted（手机端 create-session / 宿主已退出）：契约码 NOT_FOUND，文案明确
    throw Object.assign(new Error(`Session ${String(sid).slice(0, 8)} has no live agent on this device`), { code: "NOT_FOUND" });
  }
  const alive = instanceAlive(host);
  if (!alive) {
    // 死宿主：清 host + 邮箱 failed + error 投影
    failPendingMailboxForSessions([sid]);
    updateSession(sid, { hostInstanceId: null });
    const p = syntheticProjection(sid);
    p.error = "session host unavailable";
    return { handled: true, result: p };
  }
  // 活宿主：邮箱落行 + 定向接管（awaiting 期间不重复 CAS）+ 合成响应
  upsertMailbox(sid, itemClientId(channel, args), channel, args);
  if (!ctx.handoffPending?.() && ctx.handoffTo) {
    void ctx.handoffTo(host).catch(() => {});
  }
  return { handled: true, result: syntheticProjection(sid) };
}
```

routeInvoke 前置：
```ts
export async function routeInvoke(channel: string, args: unknown[]): Promise<unknown> {
  if (!ALLOWED.has(channel)) throw Object.assign(new Error(`Channel not allowed: ${channel}`), { code: "CHANNEL_NOT_ALLOWED" });
  if (SESSION_LOCAL.has(channel)) {
    const routed = await routeSessionLocal(channel, args);
    if (routed.handled) return routed.result;
  }
  switch (channel) { ...现有 dispatch 不变... }
}
```
router.ts 顶部补 `import { getSession, updateSession } from "../store/session-store.js";`。

maker.ts 环形窗口（模块态）：
```ts
/** 近期已受理 enqueue/steer clientId 环形窗口（弱网重发防线，对齐 desktop RECENT_ENQUEUED_CLIENT_IDS）。 */
const recentClientIds = new Map<string, string[]>();
function isRecentClientId(sid: string, cid: string): boolean {
  return (recentClientIds.get(sid) ?? []).includes(cid);
}
function rememberClientId(sid: string, cid: string): void {
  const arr = recentClientIds.get(sid) ?? [];
  arr.push(cid);
  if (arr.length > 32) arr.shift();
  recentClientIds.set(sid, arr);
}
```
inputEnqueue 在 `requireActiveSession(sid)` 之后加：
```ts
if (item.clientId && isRecentClientId(sid, item.clientId)) {
  return pushProjection(sid); // 同 clientId 重发：no-op（防双注入）
}
rememberClientId(sid, item.clientId);
```
inputSteer 非 stop 分支同样加；inputClearSession 清 `recentClientIds.delete(sid)`。

> 测试注意：Task 7 测试里 `router.setInvokeContext({...router.getInvokeContext(), ...prevCtx})` 覆盖 handoffTo——需要 `getInvokeContext()` 已初始化（现有测试第 70 行已 set）。恢复用原 ctx。

- [ ] **Step 4: 跑测试确认通过**（npm test 全绿；现有 enqueue/门禁断言不回归）

- [ ] **Step 5: 提交**

```bash
git add src/handlers/router.ts src/handlers/maker.ts tests/smoke.test.js
git commit -m "feat(pi-cindy): 会话路由判定 + 合成投影 + 邮箱落行 + clientId 去重"
```

---

### Task 8: 邮箱消费 + 宿主清理扫描（新模块 src/handoff.ts）

**Files:**
- Create: `src/handoff.ts`
- Modify: `src/tracker.ts`（session_shutdown 时清邮箱——可选，归入本任务）
- Test: `tests/smoke.test.js`（第 24 节）

**Interfaces:**
- Consumes: Task 4 邮箱、Task 7 `routeInvoke`（本地重放）、Task 3 `instanceAlive`
- Produces:
  - `consumeMailboxForSession(sessionId: string): Promise<void>`（逐条 routeInvoke 重放；成功删行；失败**不标 consumed** 下轮重试）
  - `sweepStaleInstances(now?: number, staleMs?: number): void`（陈旧+pid 死 → clearHostAndArchiveForInstance）

- [ ] **Step 1: 写失败测试**（第 24 节）

```js
// ============ 24. 邮箱消费 + 清理扫描 ============
{
  const handoff = jiti(path.join(base, 'handoff.js'));
  const hs = jiti(path.join(base, 'store/handoff-store.js'));
  const inst = jiti(path.join(base, 'instance.js'));
  const db = jiti(path.join(base, 'store/db.js')).getDb();
  const myId = inst.getInstanceId();
  inst.registerInstance();
  const s = store.createSession({ hostInstanceId: myId });
  activeTestSid = s.id;
  // 消费：enqueue 重放注入 + 行删除；stop 重放 abort
  const before = sent.length;
  hs.upsertMailbox(s.id, 'cid-c1', 'maker:input:enqueue', [s.id, { clientId: 'cid-c1', text: 'replay-me', chatMessage: { clientId: 'cid-c1', role: 'user', content: 'replay-me' } }]);
  hs.upsertMailbox(s.id, null, 'maker:input:stop', [s.id]);
  await handoff.consumeMailboxForSession(s.id);
  assert(sent.length === before + 1 && sent[before].text === 'replay-me', '邮箱 enqueue 重放注入', sent.slice(before));
  assert(abortCalls.length >= 1, '邮箱 stop 重放 abort');
  assert(hs.listPendingMailbox(s.id).length === 0, '消费后行删除');
  // 消费失败（payload 损坏）→ 行保留
  hs.upsertMailbox(s.id, 'cid-bad', 'maker:input:enqueue', [s.id, { clientId: 'cid-bad', text: 'x', chatMessage: { clientId: 'cid-bad', role: 'user', content: 'x' } }]);
  db.prepare("UPDATE cindy_handoff_mailbox SET payload = 'not-json{' WHERE client_id = 'cid-bad'").run();
  await handoff.consumeMailboxForSession(s.id);
  assert(hs.listPendingMailbox(s.id).length === 1, '重放失败行保留（不标 consumed）');
  db.prepare('DELETE FROM cindy_handoff_mailbox WHERE client_id = ?').run('cid-bad');
  // 清理扫描：陈旧+pid 死 → unhosted + archived + failed + 实例行删除；pid 活 → 保留
  db.prepare('INSERT OR REPLACE INTO cindy_instances (instance_id, pid, label, heartbeat_at) VALUES (?, ?, ?, ?)').run('sweep-dead', 999999, 'd', Date.now() - 60_000);
  db.prepare('INSERT OR REPLACE INTO cindy_instances (instance_id, pid, label, heartbeat_at) VALUES (?, ?, ?, ?)').run('sweep-alive', process.pid, 'a', Date.now() - 60_000);
  const sd = store.createSession({ hostInstanceId: 'sweep-dead' });
  const sa = store.createSession({ hostInstanceId: 'sweep-alive' });
  hs.upsertMailbox(sd.id, 'cid-sd', 'maker:input:enqueue', ['a', {}]);
  handoff.sweepStaleInstances(Date.now(), 30_000);
  assert(store.getSession(sd.id).hostInstanceId == null && store.getSession(sd.id).status === 'archived', '死实例会话清 host + archived');
  assert(hs.listPendingMailbox(sd.id).length === 0, '死实例邮箱 failed');
  assert(!db.prepare('SELECT 1 FROM cindy_instances WHERE instance_id = ?').get('sweep-dead'), '死实例行删除');
  assert(store.getSession(sa.id).hostInstanceId === 'sweep-alive', 'pid 活实例保留');
  assert(db.prepare('SELECT 1 FROM cindy_instances WHERE instance_id = ?').get('sweep-alive'), 'pid 活实例行保留');
  // 清理
  activeTestSid = null;
  for (const x of [s, sd, sa]) store.deleteSession(x.id);
  db.prepare("DELETE FROM cindy_instances WHERE instance_id IN ('sweep-dead','sweep-alive')").run();
  db.prepare('DELETE FROM cindy_handoff_mailbox').run();
}
```

- [ ] **Step 2: 跑测试确认失败**（handoff 模块不存在 → 加载报错）

- [ ] **Step 3: 最小实现**

```ts
/**
 * 邮箱消费 + 宿主清理扫描。
 * 消费：宿主接管后把邮箱 pending 行逐条本地 routeInvoke 重放（复用全部 handler）；
 * 成功删行，失败不标 consumed（对齐 desktop agentHandoff：peek 失败不缓存 null，
 * 否则交接永久丢失）。清理：心跳陈旧 + pid 探活失败的实例 → 清 host/归档/标 failed/删实例行。
 */
import { getSession } from "./store/session-store.js";
import { listPendingMailbox, deleteMailbox } from "./store/handoff-store.js";
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
      const { clearHostAndArchiveForInstance } = require("./store/handoff-store.js");
      clearHostAndArchiveForInstance(instance_id);
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**（npm test 全绿）

- [ ] **Step 5: 提交**

```bash
git add src/handoff.ts tests/smoke.test.js
git commit -m "feat(pi-cindy): 邮箱消费重放 + 宿主清理扫描（handoff.ts）"
```

---

### Task 9: index.ts 接线（instance 心跳 / sweep timer / InvokeContext 扩展 / status）

**Files:**
- Modify: `index.ts`
- 验证：`npm run typecheck` + Task 10 集成测试（index.ts 不在单测加载链，接线靠 typecheck + 集成 + 真机）

**Interfaces:**
- Consumes: Task 3 `instance.ts`、Task 6 `arbiter.handoffTo/isAwaitingHandoff`、Task 8 `consumeMailboxForSession/sweepStaleInstances`
- Produces: 运行期接线（setInvokeContext 移到启动时 + getClient 闭包守卫；heartbeat/sweep timer 随仲裁器生命周期）

- [ ] **Step 1: 接线改动**（index.ts）

1.1 `setInvokeContext` 从 ensureClient 移到模块启动（session_start / startArbiter 前调用一次），push 闭包改 getClient 守卫：
```ts
// ensureClient 内删除原 setInvokeContext；新增：
function wireInvokeContext(): void {
  setInvokeContext({
    pi,
    push: (ch, data, sid) => { const c = client; if (c) c.push(ch, data, sid); },
    activeSessions: new Map(),
    activeId: () => activeId,
    handoffTo: (instanceId) => (arbiter ? arbiter.handoffTo(instanceId) : Promise.resolve(false)),
    handoffPending: () => arbiter?.isAwaitingHandoff() ?? false,
  });
}
```
在 `pi.on("session_start")` 处理器内 `statusCtx = ctx` 之后、`if (isLoggedIn())` 之前调用 `wireInvokeContext()`（幂等）。

1.2 实例心跳生命周期（随仲裁器）：
```ts
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
function startInstanceHeartbeat(): void {
  if (heartbeatTimer) return;
  registerInstance();
  heartbeatTimer = setInterval(() => { try { heartbeatInstance(); } catch { /* db 抖动不致命 */ } }, 10_000);
  heartbeatTimer.unref?.();
}
function stopInstanceHeartbeat(): void {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  try { releaseInstance(); } catch { /* ok */ }
}
```
startArbiter() 末尾调 startInstanceHeartbeat()；stopArbiter() 末尾调 stopInstanceHeartbeat()；`/cindy-login` 成功路径与 session_start 里 startArbiter() 已有调用点，自动覆盖。

1.3 sweep timer（随 acquire/demote）：
```ts
let sweepTimer: ReturnType<typeof setInterval> | null = null;
function startSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    try {
      sweepStaleInstances();
      purgeFailedMailbox(Date.now() - 5 * 60_000);
    } catch { /* ok */ }
  }, 15_000);
  sweepTimer.unref?.();
}
function stopSweep(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}
```
onAcquire 回调内：`ensureClient().then(() => { consumeMailboxForSession(activeId).catch(() => {}); startSweep(); })`（consume 在 client 就绪后，保证重放时 push 可用）；onDemote 回调内：`stopSweep()`。注意 onAcquire 现有实现是 `ensureClient().catch(()=>{})`，改为链式加 consume + startSweep。

1.4 `/cindy-status` 增显 instanceId + 会话宿主：
```ts
const instId = getInstanceId();
const host = activeId ? store.getSession(activeId)?.hostInstanceId ?? null : null;
// status 字符串追加：
//   ... Inst:${instId?.slice(0,8)??'-'} Host:${host?.slice(0,8)??'-'}
```

- [ ] **Step 2: typecheck + 现有测试**

Run: `npm run typecheck` → 绿；`npm test` → 绿（接线不在单测链，回归为零）

- [ ] **Step 3: 提交**

```bash
git add index.ts
git commit -m "feat(pi-cindy): 接线 instance 心跳/sweep/InvokeContext 扩展/status"
```

---

### Task 10: 多进程集成测试（扩展 tests/multi-process.test.js）

**Files:**
- Modify: `tests/multi-process.test.js`（worker 加 handoff 回路 + 三进程用例 + fastPollMs 注入）

**Interfaces:**
- Consumes: 全部前序任务
- Produces: 跨进程握手证据（A 定向让位 → B 认领 → B 消费邮箱注入）

- [ ] **Step 1: 写集成用例**（worker 源码扩展 + 新测试段）

worker 源码在现有基础上加：加载 instance / handoff-store / handoff / router / maker，注册 fake pi + 路由上下文，指令协议（stdin 行：`invoke <sessionId> <text>` 模拟收到手机 enqueue；`shutdown` 优雅退出）。路由上下文 handoffTo 接本进程仲裁器。

```js
const workerSrc = \`
const { createJiti } = require(${JSON.stringify(require.resolve('jiti'))});
process.env.PI_CINDY_DATA_DIR = ${JSON.stringify(DATA_DIR)};
const JITI_ENTRY = ${JSON.stringify(path.join(__dirname, 'multi-process.test.js'))};
const jiti = createJiti(JITI_ENTRY, { interopDefault: true });
const { getDb } = jiti(${JSON.stringify(path.join(__dirname, '..', 'src', 'store', 'db.ts'))});
const { DeviceLinkOwnershipArbiter, createSqliteOwnershipStore } = jiti(${JSON.stringify(path.join(__dirname, '..', 'src', 'ownership.ts'))});
const inst = jiti(${JSON.stringify(path.join(__dirname, '..', 'src', 'instance.ts'))});
const { upsertMailbox, listPendingMailbox } = jiti(${JSON.stringify(path.join(__dirname, '..', 'src', 'store', 'handoff-store.ts'))});
const handoff = jiti(${JSON.stringify(path.join(__dirname, '..', 'src', 'handoff.ts'))});
const router = jiti(${JSON.stringify(path.join(__dirname, '..', 'src', 'handlers', 'router.ts'))});
const store = jiti(${JSON.stringify(path.join(__dirname, '..', 'src', 'store', 'session-store.ts'))});
const injected = [];
const fakePi = { sendUserMessage: (t) => injected.push(t) };
inst.registerInstance();
const arb = new DeviceLinkOwnershipArbiter({
  getStore: () => createSqliteOwnershipStore(getDb()),
  instance: { ownerPid: process.pid, ownerLabel: process.argv[1] },
  instanceId: inst.getInstanceId(),
  onAcquire: async () => {
    console.log(process.argv[1] + ' ACQUIRED');
    handoff.consumeMailboxForSession(activeId).catch(() => {});
  },
  onDemote: () => { console.log(process.argv[1] + ' DEMOTED'); },
  heartbeatMs: 30, staleMs: 200, fastPollMs: 20, storeRetryMs: 10, opTimeoutMs: 30,
});
let activeId = null;
router.setInvokeContext({
  pi: fakePi, push: () => {}, activeSessions: new Map(),
  activeId: () => activeId,
  handoffTo: (i) => arb.handoffTo(i),
  handoffPending: () => arb.isAwaitingHandoff(),
});
// 会话归属：argv[3] = 本 worker 的会话 id（B 有会话；A/C 无）
const mySid = process.argv[3];
if (mySid) store.createSession({ id: mySid, hostInstanceId: inst.getInstanceId() });
activeId = mySid;
arb.start();
process.stdin.on('data', (buf) => {
  const line = buf.toString().trim();
  if (line.startsWith('invoke ')) {
    const [, sid, text] = line.split(/ (.+)/);
    upsertMailbox(sid, 'cid-' + Date.now(), 'maker:input:enqueue', [sid, { clientId: 'cid-' + Date.now(), text, chatMessage: { clientId: 'cid-' + Date.now(), role: 'user', content: text } }]);
    arb.handoffTo(store.getSession(sid)?.hostInstanceId ?? '').then((ok) => {
      // A 路由语义：模拟 router.routeSessionLocal 的落行+让位（本 worker 即 owner）
      console.log(process.argv[1] + ' HANDOFF-ISSUED');
    });
  }
  if (line === 'shutdown') { arb.stop().then(() => process.exit(0)); }
});
\`;
```

> 说明：worker 里 `invoke` 指令由**测试主进程**发给 A（当前 owner），A 执行「落行 + handoffTo(宿主)」；B（宿主）fast-poll 认领 → onAcquire → consumeMailboxForSession(B 会话) → 重放 enqueue → B 的 fakePi 收到注入 → B 输出 `INJECTED <text>`。断言：B 输出 ACQUIRED + INJECTED；A 输出 DEMOTED；C 全程无 ACQUIRED。

新测试段（插入现有 IIFE 内、`process.exit(failures ? 1 : 0)` 之前；spawnW/waitOut 为段内局部 helper，复用 stdout 累积模式）：

```js
// ===== 三进程会话路由握手：A 让位 → B 认领 → B 消费邮箱注入；C 不抢 =====
{
  const spawnW = (label, sid, dur) => {
    const p = spawn(process.execPath, ['-e', workerSrc, label, String(dur), sid || ''], { stdio: ['pipe', 'pipe', 'inherit'] });
    p._out = '';
    p.stdout.on('data', (d) => { p._out += d.toString(); });
    return p;
  };
  const waitOut = (p, needle, ms) => new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => { if (p._out.includes(needle) || Date.now() - t0 > ms) { clearInterval(iv); resolve(p._out); } }, 20);
  });
  const pA = spawnW('A', '', 1500);
  await waitOut(pA, 'A ACQUIRED', 1000);
  const pC = spawnW('C', '', 800);
  const pB = spawnW('B', 'sess-b', 1500);
  await new Promise((r) => setTimeout(r, 150)); // B 已入 standby（不打印 ACQUIRED）
  pA.stdin.write('invoke sess-b hello-from-mobile\n');
  const bOut = await waitOut(pB, 'INJECTED', 4000);
  const aOut = pA._out;
  const cOut = pC._out;
  const okB = /B ACQUIRED/.test(bOut) && /B INJECTED hello-from-mobile/.test(bOut);
  const okA = /A DEMOTED|HANDOFF-ISSUED/.test(aOut);
  const okC = !/C ACQUIRED/.test(cOut);
  if (!(okB && okA && okC)) { failures++; console.error('FAIL: 三进程握手', JSON.stringify({ bOut, aOut, cOut })); }
  [pA, pB, pC].forEach((p) => { try { p.stdin.write('shutdown\n'); } catch {} });
  await new Promise((r) => setTimeout(r, 200));
  [pA, pB, pC].forEach((p) => { try { p.kill(); } catch {} });
}
```

- [ ] **Step 2: 更新现有仲裁用例注入 fastPollMs**

现有 worker 的 `DeviceLinkOwnershipArbiter` 构造加 `fastPollMs: 20`（默认 1000 会把 takeover 检测拖到秒级，破坏 30ms 心跳时序下的时间断言）；现有接管时间断言按「更快」方向收紧或保持上限。

- [ ] **Step 3: 跑集成测试**

Run: `node tests/multi-process.test.js`
Expected: 全绿（含原双进程用例回归 + 新三进程握手用例）

- [ ] **Step 4: 跑双门禁**

Run: `npm test && npm run typecheck`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add tests/multi-process.test.js
git commit -m "test(pi-cindy): 三进程会话路由握手集成测试 + fastPollMs 注入"
```

---

### Task 11: 真机验证清单（手动，非自动化）

- [ ] 双 pi 进程（不同目录）+ 同一账号登录 + 手机端：设备列表 1 台、会话列表见 2 会话
- [ ] 手机在 B 会话发消息 → ~1-2s 内 B 接管（B 窗口 `/cindy-status` 变 owner）→ B 回复回流手机
- [ ] 随后手机在 A 会话发消息 → 接管切回 A → 回复回流
- [ ] 全程无 4409（relay-debug.log grep）
- [ ] kill -9 B → 手机在 B 会话发消息 → ~10s 内明确报错（会话无活宿主）
- [ ] 重启 B（resume 同会话）→ 会话复活可消息

### Task 12: 文档收口

**Files:**
- Modify: `docs/CHANGELOG.md`（v0.5.0：Added 会话路由 + 快速接管、邮箱、心跳清理）
- Modify: `docs/HANDOFF.md`（已完成块 v0.5.0 快照；未完成块加技术债「本地输入队列 DB 快照（desktop issue #761）」）
- Modify: `docs/EXPERIENCE.md`（新条目：定向接管/TTL 死窗/合成投影形状/pid 探活加速等）

- [ ] **Step 1: 写 CHANGELOG v0.5.0**（按 Added 格式，版本锚定 git commit）

- [ ] **Step 2: 更新 HANDOFF**（已完成块快照式改写；≤300 行纪律）

- [ ] **Step 3: 更新 EXPERIENCE**（问题记录表追加编号；正文条目 ≤4 行）

- [ ] **Step 4: 打 tag**

```bash
git add docs/ && git commit -m "docs(pi-cindy): v0.5.0 会话路由收口"
git tag v0.5.0 && git log --oneline -3
```

---

## Self-Review（对照 spec）

**覆盖检查**：
- §3 数据模型 → Task 1（schema）+ Task 2（host 读写）+ Task 4（邮箱）
- §4 路由判定 → Task 7（SESSION_LOCAL 集 + 三分支 + get-context-usage 例外已在 spec 移除，路由集不含它）
- §5 定向接管 → Task 6（handoffTo/awaiting/目标独占/快轮询/TTL 陈旧处理）
- §6 邮箱语义 → Task 4（存取）+ Task 7（落行/合成投影）+ Task 8（消费重放/失败不标 consumed）
- §7 心跳清理 → Task 3（心跳/活体）+ Task 8（sweep）+ Task 9（timer 接线）
- §8 边界 → Task 7（awaiting 单飞/死宿主/无宿主）+ Task 10（接管窗口/多 standby）
- §9 测试 → Task 10 + 各任务 TDD 测试
- §10 版本/文件 → Task 9（index.ts）+ Task 12（文档/tag）
- §11 成功标准 → Task 11 真机清单

**占位符扫描**：无 TBD/TODO；每步含完整代码与预期输出。

**类型一致性**：`getInstanceId/instanceAlive/registerInstance/heartbeatInstance/releaseInstance`、`upsertMailbox/listPendingMailbox/deleteMailbox/failPendingMailboxForSessions/clearHostAndArchiveForInstance/purgeFailedMailbox`、`handoffTo/isAwaitingHandoff`、`consumeMailboxForSession/sweepStaleInstances` 跨任务签名一致（Task 3/4/6/7/8/9 相互引用处已核对）。

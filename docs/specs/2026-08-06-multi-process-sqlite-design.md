# pi-cindy 多进程共存（不互踢）+ SQLite 化 · 设计

> 日期：2026-08-06 · 状态：设计已确认（待实施）
> 背景：用户在多个项目目录各开一个 pi 进程，要求所有进程都能与 Cindy 服务端/手机端同步，
> 会话以会话区分（非设备区分），且互不踢下线。

## 1. 问题与约束

**现状**：
- 所有 pi 进程共享 `~/.pi/cindy-sync/`（同一 deviceId + 同一 JSON store）
- relay 服务端对同 `(userId, deviceId)` 是 **last-wins 顶号语义**：同 deviceId 双连接必 4409 互踢（30s 慢重连只是缓解）
- JSON store（`sessions.json` 整个文件 + 每会话 `messages/<sid>.json`）多进程写互相覆盖（last-writer-wins 丢会话）

**硬约束**（协议层行为，客户端改不了）：同 deviceId 多进程**同时**连 relay 物理不可能 → 必须**单持有者**：同一时刻只有一台进程连 relay，其余待命。

**用户需求**（已确认）：
- 同一设备（不识别成不同设备）
- 会话区分（手机端看到全部会话，但只能操作持有者的会话）
- 不互踢

**参考**：desktop 已解决完全相同问题（`apps/desktop/src/main/device-link/ownership.ts`，563 行单持有者仲裁 + SQLite 单行表 CAS）。desktop store 本就是 SQLite（`<userData>/cindy-<userId>.db`，better-sqlite3 + drizzle）。**本设计对齐 desktop 架构**，用户已确认全量 SQLite 化。

## 2. 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| SQLite | **node:sqlite（Node 内置 `DatabaseSync`）** | Node 22.23 实测可用；零原生依赖（better-sqlite3 需装 prebuilt，desktop 用但 extension 环境多一层依赖链）；同步 API 与 better-sqlite3 同形，仲裁逻辑可平移 |
| 仲裁凭据 | SQLite 单行表 `device_link_ownership`（copy desktop） | CAS 语义硬，跨进程互斥由 SQLite 文件锁保证；替代早期考虑的 mkdir 原子锁（CAS 弱） |
| 仲裁类 | **copy `ownership.ts` 的 `DeviceLinkOwnershipArbiter`** | 该类设计上就是「纯逻辑 + store 依赖注入」，与传输层解耦，可原样搬运（logger 换 `dbgLog`） |
| 会话/消息存储 | SQLite `sessions` + `messages` 两表（裁剪自 desktop schema） | 多进程并发写天然安全（WAL + 单写者串行化），手机端读库见全部会话 |

**风险**：node:sqlite 实验性（Node 22.23 有 ExperimentalWarning，API 可能变化）。缓解：只用基础 CRUD/索引，不依赖实验性扩展；desktop 用 better-sqlite3 不冲突（两套独立）。**实施首步验证 pi 进程内 `require('node:sqlite')` 可用**（当前实测是 shell node，pi 进程内版本待验）；不可用则回退 better-sqlite3。

## 3. Schema（裁剪自 desktop localDb/schema.ts）

单库文件：`~/.pi/cindy-sync/pi-cindy.db`

```sql
-- 1. sessions：PiSessionMeta 字段 = desktop sessions 子集
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'New Maker',
  working_dir TEXT,
  workspace_kind TEXT NOT NULL DEFAULT 'project',
  model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
  effort TEXT NOT NULL DEFAULT 'high',
  permission_mode TEXT NOT NULL DEFAULT 'ask',
  status TEXT NOT NULL DEFAULT 'active',            -- active/archived/deleted
  sdk_session_id TEXT,
  total_token_usage INTEGER NOT NULL DEFAULT 0,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  total_cost_amount REAL NOT NULL DEFAULT 0,
  total_cost_currency TEXT,                          -- CNY/USD
  total_cost_is_approximate INTEGER NOT NULL DEFAULT 0,
  context_tokens INTEGER NOT NULL DEFAULT 0,
  context_window INTEGER NOT NULL DEFAULT 0,
  fast_mode INTEGER NOT NULL DEFAULT 0,
  -- pi 专属（JSON store 已有，desktop 无对应列）
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

-- 2. messages：对齐 desktop 索引设计（唯一 (sessionId, clientId)、游标走 createdAt）
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  client_id TEXT,                                  -- 可 NULL（pi 自身消息无 clientId；SQLite UNIQUE 不冲突 NULL）
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                               -- user/assistant/tool/system（宽松 TEXT，无 CHECK，兼容扩枚举）
  content TEXT NOT NULL,                            -- JSON string
  agent_meta TEXT,                                  -- JSON string（usage/model/stopReason 等）
  agent_kind TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, client_id),
  INDEX idx_messages_session_created (session_id, created_at)
);

-- 3. device_link_ownership：desktop 原样（单行 + CAS）
CREATE TABLE device_link_ownership (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  owner_label TEXT,
  heartbeat_at INTEGER NOT NULL
);
```

**裁剪说明**：
- `messages.role` 用宽松 TEXT（desktop 11 种枚举，pi 只用 4 种；无 CHECK 兼容未来）
- 丢弃 desktop 中 pi 不需要的表：orca 团队/worker、wechat 同步/收件箱、schedules、goals、usage 快照、media、PR refs、migration 元数据（迁移用文件标记，见下）
- desktop 的 drizzle-orm 定义不搬（pi 无 drizzle 依赖），用手写 DDL + `DatabaseSync.prepare().run()`

## 4. 数据迁移（JSON → SQLite，一次性）

- 启动检测：`sessions.json` 或 `messages/` 存在且 `pi-cindy.db` 为空 → 导入
- 流程：读 JSON → `INSERT OR IGNORE` 会话 + 消息 → 写 `migration_done` 标记文件（独立文件，不引入 meta 表）→ **旧 JSON 文件保留不删**（安全网，人工验证后手动清理）
- 失败 → fail-open：保留 JSON store 可读，日志告警（dbgLog），不阻断启动
- `session.enc`（token）、`device-id` 保持文件形式不动

## 5. 仲裁接线（index.ts + 新 src/ownership.ts）

```
pi 进程启动
  └─ ownership.start()               ← 参与仲裁（幂等）
       ├─ first-wins 认领 → 持有者 → onAcquire → ensureClient() 连 relay
       └─ 待命 → 不连 relay（4409 根因消除：同一时刻只有一台连）
  每 5s tick（持有者 CAS 续期 / 待命轮询心跳）
  持有者心跳超 15s 未续（崩溃/卡死）→ 待命 CAS 接管 → onAcquire
  正常退出/登出 → stop() 释放行 → 幸存实例秒级接管
```

- `ensureClient()` 改造：持有者专属；待命实例调用返回 null/standby 态，`tracker` push 判空逻辑不变（待命不推）
- `/cindy-status` 显示 `owner` / `standby` + 持有者 PID
- 移动端 `presence-changed` 只由持有者发出 → 会话壳/消息/回传流不漂移（对齐 desktop「会话壳建在 A、消息发到 B、回传流丢失」的防漂移目标）

**参数**（对齐 desktop 默认）：heartbeatMs=5000，staleMs=15000（> 2×heartbeat 留 GC/IO 余量），storeRetryMs=500，opTimeoutMs=heartbeatMs。有效性判定只靠心跳新鲜度 + 行是否存在（不用 PID 探活，防 Windows PID 复用误判）。

## 6. 并发语义

- SQLite WAL 模式：多进程并发读安全，单写者串行化
- `sessions` 表：各进程写自己的会话行（`INSERT OR IGNORE` / 单行 `UPDATE`），互不覆盖（相对 JSON 整个文件 last-writer-wins 质变）
- `messages` 表：`(session_id, client_id)` 唯一索引幂等，跨进程不重复
- 手机端经持有者 `sessions:list` / `messages:list` 读库 → 见所有进程的会话（可见全部）；操作只落持有者自己的会话（可操作持有者）
- SQLITE_BUSY → `busy_timeout` 3000ms 重试；仲裁 CAS 失败 = 常规状态流转，不报错

## 7. 测试策略

- copy `ownership.test.ts` 适配 node:sqlite：`:memory:` 库跑 CAS 语义（read/tryInsert/tryTakeover/renew/release 5 方法）
- store 层测试：JSON→SQLite 迁移正确性（fixture 数据 + 迁移幂等：重复启动不重复导入）
- 冒烟测试改隔离：`PI_CINDY_DATA_DIR` 指向临时目录 → 临时 db 文件
- 双进程集成冒烟：两进程同库，一持有者一待命，断言无 4409、待命不连 relay、崩溃接管（模拟 stale 心跳）
- 现有 125 断言全部保持通过（JSON store 接口换 SQLite 实现，handler 契约不变）

## 8. 不做（YAGNI）

- 跨进程会话操作路由（手机端操作被动进程的会话）—— 用户明确只要「可见全部、可操作持有者」
- better-sqlite3（保持零原生依赖）
- 旧 JSON 文件自动删除（人工确认后清）
- 会话实时同步（被动进程的会话变更经持有者 push）—— 手机端拉取时可见即可

## 9. 文件改动清单

```
~/.pi/agent/extensions/pi-cindy/
├── src/
│   ├── ownership.ts          ← 新增：仲裁类（copy desktop，store 换 node:sqlite）
│   ├── store/db.ts           ← 新增：node:sqlite 单例 + schema DDL + WAL/busy_timeout
│   ├── store/session-store.ts← 改造：JSON 文件 → SQLite 读写 + 迁移逻辑
│   ├── store/migration.ts    ← 新增：JSON→SQLite 一次性迁移
│   ├── handlers/router.ts    ← 不动（契约不变）
│   └── index.ts              ← 接线：ownership.start() 包 ensureClient()
├── tests/
│   ├── smoke.test.js         ← 改造：临时 db 隔离
│   └── ownership.test.ts     ← 新增：copy desktop 适配 node:sqlite
└── docs/
    ├── HANDOFF.md / CHANGELOG.md / EXPERIENCE.md  ← 收尾更新
```

## 10. 验证标准

- 双 pi 进程同数据目录：一个持有者连 relay（手机端可见），一个待命，无 4409 循环
- 手机端 sessions:list 可见两进程的会话
- 手机端操作持有者的会话正常（enqueue/回复回流）
- 杀掉持有者进程 → 15s 内待命接管，手机端自动重连成功
- `npm test` + `npm run typecheck` 全绿（含迁移 + 仲裁新测试）

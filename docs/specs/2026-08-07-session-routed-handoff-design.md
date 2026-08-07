# pi-cindy 会话路由 + 快速接管 · 设计

> 日期：2026-08-07 · 状态：设计已确认（待实施）
> 背景：多 pi 进程共享同一数据目录/deviceId 时，目前手机端**只能操作持有者（owner）的当前活跃会话**。
> 需求（已确认）：手机端在**任意会话**发消息时，消息路由到「拥有该会话的 pi 进程」（宿主），宿主快速接管
> relay 并处理，回复回流手机端。手机端零改动。

## 1. 问题与约束

**现状**（v0.4.0）：
- 单持有者仲裁（`ownership.ts`）：多 pi 进程共享 `~/.pi/cindy-sync/`（同 deviceId），仅 owner 连 relay，
  standby 不连。切换/故障接管已真机验证（优雅 4.4s / kill -9 14.1s，link 无缝继承，4409=0）
- 每进程 tracker 把自己的活跃会话落库（standby 也落，`status: active` 可多行）；session-store 全 SQLite 共享
- `requireActiveSession` 门禁（`handlers/maker.ts`）：enqueue/steer/send 只放行 owner 的 `activeId` 会话，
  其余一律 `NOT_FOUND` → **手机端在非 owner 会话发消息必失败**

**硬约束**（协议层，客户端改不了）：同 deviceId 多进程同时连 relay 物理不可能 → 任何方案必须保持
「单持有者，同一时刻只有一台进程连 relay」。

**用户需求**（已确认）：
- 机制：**会话路由 + 快速接管**（非 IPC 代理、非独立设备）
- 可靠性：**邮箱持久化 + 心跳清理**（接管窗口消息不丢；死宿主自动清理）

## 2. 核心概念

| 概念 | 定义 |
|---|---|
| 实例（instance） | 一个 pi 进程内扩展的运行时身份：进程生命周期一个 UUID（`instanceId`），登录后登记心跳 |
| 宿主（host） | 会话行 `host_instance_id`：创建该会话的 pi 进程。`session_start` 写入、`session_shutdown` 清空 |
| 邮箱（mailbox） | 跨进程 invoke 转发表：owner 收到非本进程会话的进程本地类 invoke → 落行 → 宿主接管后**本地重放** |
| 定向接管（targeted handoff） | 交接信号只写给目标实例；目标无视心跳新鲜度直接认领，其余 standby 不抢 |

## 3. 数据模型

**3.1 `sessions` 加列**
```sql
ALTER TABLE sessions ADD COLUMN host_instance_id TEXT;  -- NULL = unhosted
```

**3.2 新表 `cindy_instances`**（每进程活体打卡）
```sql
CREATE TABLE IF NOT EXISTS cindy_instances (
  instance_id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  label TEXT,
  heartbeat_at INTEGER NOT NULL
);
```
- 每进程扩展**登录后**（随 `arbiter.start()`）登记行；每 **10s** 续心跳；登出/退出停写（行留待过期清理）

**3.3 新表 `cindy_handoff_mailbox`**（跨进程 invoke 转发）
```sql
CREATE TABLE IF NOT EXISTS cindy_handoff_mailbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  client_id TEXT,
  kind TEXT NOT NULL,          -- channel 名（如 maker:input:enqueue / maker:input:stop / maker:set-model）
  payload TEXT NOT NULL,       -- args JSON
  status TEXT NOT NULL DEFAULT 'pending',  -- pending / consumed / failed
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, client_id)
);
```
- `UNIQUE(session_id, client_id)` 幂等：手机端重试同 clientId 不重复落（对齐 EXPERIENCE #33 幂等语义）
- 无 clientId 的动作类行（stop/compact/set-model）不做去重——本身幂等，重复重放无害

**3.4 `device_link_ownership` 加列**（交接信号）
```sql
ALTER TABLE device_link_ownership ADD COLUMN handoff_to TEXT;
ALTER TABLE device_link_ownership ADD COLUMN handoff_expires_at INTEGER;
```

建表/加列全部幂等（`IF NOT EXISTS` / try-catch），沿用 db.ts DDL 无迁移框架的现状模式。

## 4. 路由判定（owner 收到 invoke 时）

**进程本地类 channel**（需按宿主路由；其余 owner 从共享 DB 直接答）：

| 组 | channel |
|---|---|
| 输入队列 | `maker:input:enqueue/stop/steer/get-projection/compact/resume/retry-last-error/clear-error/remove/update-text/update-content/move/set-expanded/set-interaction-lock/set-edit-lock/clear-session`（17 个） |
| 会话操作 | `maker:send` / `maker:steer` / `maker:abort-session` / `maker:close-session` |
| 会话配置 | `maker:set-model` / `maker:set-effort` / `maker:set-permission-mode` / `maker:set-fast-mode` |

> `maker:get-context-usage` **不移入路由集**：owner 从 DB 会话行直接回答（context_tokens 已由宿主 tracker 在 message_end 维护，近似够用）；路由它会导致手机端轮询一次就触发一次接管（会话页周期性轮询 → 接管风暴）。准确值在宿主成为 owner 后天然得到。

**判定规则**（channel ∈ 进程本地集 且 args[0] 为 sessionId）：

```
host == 我        → 本地 handler（现状路径；requireActiveSession 语义保持）
host == 他(活)    → 邮箱落行 + 定向接管 + 返回合成响应
host == 他(死)    → 清 host + 邮箱行标 failed + 返回 error 投影（复用现有 error 字段）
host == NULL      → NOT_FOUND（现状语义）
```

- **宿主活体预检**：路由前读 `cindy_instances[host].heartbeat_at`，过期（>30s）直接走「他(死)」分支，
  不发起定向接管（消灭大部分死目标竞态）
- **例外**：`maker:input:get-projection` 是只读查询，host==他(活) 时不落邮箱、不发起接管，直接由 owner
  从邮箱 pending 行合成投影返回（见 §6）
- 非进程本地 channel（`local-db:*`、`maker:get-capabilities`、`device-link:subscribe` 等）→ 本地 handler 不变

## 5. 定向接管（仲裁器改动，最小集）

新 API `arbiter.handoffTo(instanceId): Promise<boolean>`（仅 owner 调）：
1. CAS 写自己行 `SET handoff_to=?, handoff_expires_at=now+10s WHERE id=1 AND owner_id=me`
2. 成功 → 本地降级：**停止续期 + 断开 client**（不释放行）——避免目标认领后本实例仍活着 → 双连接 4409
   （现 onDemote 只断 client 不删行，语义可复用）

「awaiting-handoff」态**由行派生**（own 行带未过期 handoff_to），无需额外状态：
- owner 续期路径：读到自己行带未过期 handoff_to → 跳过续期；过期 → 恢复续期（reclaim，覆盖「唯一进程 self-handoff 后无人接管」自愈）
- awaiting 期间**跳过** maybeSelfDemoteForRenewFailure（无续期是预期，非故障，避免 10s 后误降级日志噪音）

standby 判定（读行后分支）：
- `handoff_to==我 && 未过期` → **无视心跳新鲜度直接 tryTakeover**（覆盖「健康持有者主动让位」）
- `handoff_to==他 && 未过期` → 保持被动不抢（防第三实例 C 偷跑，保证目标必赢）
- 过期/无 → 回落现有 first-wins 语义（防目标死导致永久卡死）。**过期时按 heartbeat 陈旧处理**
  （无视心跳新鲜度允许接管）：消除 TTL(10s) → heartbeat-stale(15s) 之间的 5s 死窗

owner 续期路径：读到自己行带**未过期** handoff_to → 跳过续期（awaiting）；过期 → 恢复续期（reclaim，
覆盖「唯一进程 self-handoff 后无人接管」自愈）。

**standby 快轮询**：standby 期间定时器 **1s**（仅单条 SELECT 只读 + 可能的 claim）；owner 保持 **5s** 续期节奏。
接管延迟由 5s 压到 ~1s。⚠️ 现有 `tests/multi-process.test.js` 断言 5s 心跳节奏与 4.4s 接管时延，
本改动后需同步更新（预期：接管更快，owner 节奏不变）。

## 6. 邮箱语义 = 跨进程 invoke 重放

- **落行**：owner A 收到宿主为 B 的进程本地 invoke → `INSERT (session_id, client_id, kind=channel, payload=args)` →
  定向接管 B → 同步返回**合成响应**
- **合成响应**（复用标准投影形状，**零新增契约字段**）：
  - **所有 `maker:input:*` 路由响应统一返回合成投影**（对齐现有 handler 返回形状，绝不回 `{ok:true}`——
    手机端把 input:* 响应当投影解析）：`pendingQueue=[排队中的 enqueue/steer 项]`（含 chatMessage，对齐
    EXPERIENCE #36）+ steeringQueueClientIds/queueAbortPending 等反映路由动作 + 其余字段空态
    （queuePaused:false / error:null 等）→ 手机端显示「排队中」
  - 非投影类（send/abort-session/close-session/set-model 等）→ 返回与本地 handler 同形状响应
    （如 `{ok:true}`）
  - `maker:input:get-projection` → 从邮箱 pending 行合成投影（不进邮箱，读查询无需重放）
- **本地队列 clientId 去重**（对齐 desktop RECENT_ENQUEUED_CLIENT_IDS 环形窗口）：现 maker.ts 无去重，
  弱网重发同 clientId 会双注入（邮箱 UNIQUE 只盖 pending 阶段，消费后失去保护）；
  加 per-session 近期 clientId 环形窗口（容量 ~32），入队前判重
- **消费**：B 接管成功（onAcquire）即消费 → `SELECT pending WHERE session_id=我.active ORDER BY created_at` →
  逐条 `routeInvoke(kind, payload)` **本地重放**（复用全部现有 handler，无新执行逻辑）→ 标 consumed 即删；
  注入不依赖 client 就绪（push 在 client 连上后自然可达）
  - **读失败不标 consumed**（对齐 desktop agentHandoff 教训：peek 失败绝不缓存 null，否则交接永久丢失）——
    重试窗口内可重读；邮箱全 DB 化，重启后确定性重建
  - **消费后 delete 前崩溃 → 罕见双注入**（对齐 desktop：内存先标、DB 尽力——消息丢失比重复更糟；
    自限：宿主重启后新 session/新 instance，旧会话邮箱行由清理扫描兜底）
  - enqueue/steer → 注入 inputQueue（走现有 inputQueueFlush）；stop → abortRuntime；set-model → setModel…天然统一
- **响应不对称**：A 已同步回手机端；B 的重放不回响应（手机端经 B 后续 push / 重新 get-projection 取真实值）

## 7. 心跳与清理

| 项 | 值 |
|---|---|
| 实例心跳间隔 | 10s（随 arbiter 生命周期：start 登记，stop 停写） |
| 实例过期阈值 | 30s（>3 拍）；**pid 探活加速**：心跳 stale 且 `process.kill(pid,0)` 判死 → 立即判过期（宿主死错误延迟 30s→~10s；心跳仍主判据，pid 仅加速信号，防 Windows pid 复用） |
| 交接 TTL | 10s |
| 邮箱 failed 保留 | 5 分钟（供投影显示 error），超时删除 |

- **清理扫描**（仅 owner 跑，~15s 独立 timer；onAcquire 起、onDemote 停）：
  - `cindy_instances` 心跳过期（+pid 探活加速）→ 名下 sessions 清 `host_instance_id` **并置 `status: archived`**
    （手机端侧栏自动隐藏死会话，防堆积；pi resume 同 sdk_session_id 时 tracker 复用行自动复活）+
    名下 pending 邮箱行标 failed
- `session_shutdown`（优雅）：清自己名下 host + 自己 pending 邮箱行标 failed
- failed 行 → 手机端下次 get-projection 经 error 字段可见（复用，无新字段）

## 8. 边界与失败场景

| 场景 | 行为 |
|---|---|
| 接管窗口新消息（A 已让位、B 未接管） | 新 owner 收 invoke → 按 host 路由 → 邮箱 UNIQUE 幂等去重 → 可能再定向接管（≤2 跳） |
| 并发定向接管（A awaiting 时又来 B 之外会话的消息） | awaiting 期间路由到的 invoke **只落邮箱、不重复 CAS**（handoffTo 单飞）；收敛：B claim 后，下一条消息由 B 按宿主路由再接管（≤2 跳），不产生握手风暴 |
| 交替 A↔B 发消息 | 每消息一次接管（~1-2s + 一次 relay 重连，无缝，P3 已验证 4409=0）；无冷却，消息必须由宿主处理 |
| 宿主 kill -9 | 心跳 30s 过期（pid 探活加速 ~10s）→ 会话 unhosted + 邮箱 failed；期间消息报明确错误（预检 + 扫描双路径） |
| 宿主未登录 Cindy | 无心跳 → 预检即 fail-fast，不发起接管 |
| 无宿主会话（手机端 create-session 创建） | 进程本地 invoke → NOT_FOUND（现状语义）；DB 类 channel 正常。**对照桌面端**：桌面可对未运行会话懒创建 live agent、对 archived 乐观 auto-unarchive（register.ts:8684/9949）——pi 进程级单会话学不了，会话复活靠 pi resume 时 tracker `findSessionBySdkId` 复用行（已支持）；NOT_FOUND 的 message 文案明确「会话无活动 agent」，契约码不变 |
| 新老版本扩展混跑 | 老进程不写 host/心跳 → 其会话视为 unhosted → 消息报错；升级后一致即恢复。可接受，文档注明 |
| `maker:list-active` / `agent:status` 的 isTurnRunning/busy | 沿用现状：owner 本地 runtime 近似值（非本进程会话不精确）。已知局限，不做本期范围 |

## 9. 测试计划

1. **单测**（handler 层，`PI_CINDY_DATA_DIR` 隔离）：
   - 路由判定三分支（host==我 / 他活 / 他死 / NULL）
   - 邮箱 upsert 幂等（同 clientId）、消费重放（enqueue 注入 / stop abort / set-model）
   - 合成投影形状对齐 mobile 契约（含 chatMessage）
   - 仲裁：handoffTo 让位、target 独占认领、非 target 被动、TTL 过期回落（含 heartbeat 陈旧处理）、
     awaiting 不续期、awaiting 期间 handoffTo 单飞
   - 心跳清理（stale → unhosted + archived + failed）
   - 本地队列 clientId 环形窗口去重（弱网重发不双注入）
2. **多进程集成**（扩展 `tests/multi-process.test.js`，真跨进程）：
   - 三进程（owner A / standby B / C）：A 收 B 会话 enqueue → 定向接管 → B claim + 消费邮箱 + 注入落库
   - B kill -9 → 心跳过期清理路径
   - 现有仲裁测试（心跳节奏/优雅接管/kill -9 接管）回归更新
3. **真机**（最后）：双 pi 进程 + 手机，B 会话发消息 → ≤2s 接管 → B 回复回流；全程 4409=0

## 10. 版本与改动范围

- 目标 **v0.5.0**（新功能，升第二位；落地后 git tag 锚定）
- 改动文件：
  - `src/store/db.ts`（DDL：加列 + 2 新表 + ownership 加列，全幂等）
  - `src/store/session-store.ts` + 新 `src/store/handoff-store.ts`（host / instances / mailbox 存取）
  - `src/ownership.ts`（handoffTo + awaiting 态 + standby 快轮询 + handoff 感知 claim）
  - 新 `src/instance.ts`（instanceId 单例 + 心跳循环，随 arbiter 生命周期）
  - `src/tracker.ts`（session_start 写 host / shutdown 清 host）
  - `src/handlers/router.ts`（进程本地集路由判定前置）+ `src/handlers/maker.ts`（合成投影）
  - `src/handoff.ts`（邮箱读写/消费/清理扫描 + 路由助手）
  - `index.ts`（instance 心跳接线 + 清理 timer 随 acquire/demote 启停）
  - `/cindy-status` 增显 instanceId + 当前会话宿主（诊断）
- 文档：CHANGELOG（Added）、HANDOFF（已完成/未完成）、EXPERIENCE（新条目）

**技术债（随版本消化，对齐 desktop）**：
- 本地输入队列 DB 快照（desktop issue #761 `agentInputQueueSnapshots`：pendingQueue 持久化，重启恢复为暂停队列）——
  当前邮箱只保「接管窗口」消息，宿主自身 owner 期间的内存队列崩溃即丢；
  v0.6.0+ 候选：复用邮箱表或独立快照表存本进程 active 会话队列

## 11. 成功标准

- [ ] 双进程 + 真机：B 会话发消息 → ≤2s 接管 → 回复回流；全程无 4409
- [ ] 接管窗口 enqueue 不丢（邮箱落库 → B 消费注入）
- [ ] B kill -9：会话 unhosted（pid 探活加速 ~10s / 心跳兜底 ≤30s）；期间消息报明确错误不卡死
- [ ] 仲裁器现有能力不回归：优雅接管更快（<4.4s）、kill -9 接管 ≤15s 保持
- [ ] 手机端零改动，无新增 invoke 契约字段
- [ ] `npm test` + `npm run typecheck` 全绿

## 12. 桌面端调查参照（本设计改进来源）

- `apps/desktop/src/main/maker-ipc/register.ts:8684` — GET_CONTEXT_USAGE 未运行会话用 createOpts 懒创建 live agent（pi 架构学不了）
- `register.ts:9945-9949` — enqueue 门禁只拦缺失/删除，archived 放行 + 乐观 auto-unarchive
- `apps/desktop/src/main/device-link/crossProcessLock.ts` — mtime 陈旧 + `process.kill(pid,0)` 判死才接管（本设计 §7 pid 探活加速来源）
- `apps/desktop/src/main/localDb/agentInputQueueSnapshots.ts`（issue #761）— pendingQueue 持久化崩溃恢复（技术债条目来源）
- `apps/desktop/src/main/maker-ipc/agentHandoff.ts` + `agentHandoffPendingSingleton.ts` — 「peek 失败不缓存 null」+ 内存态/DB 确定性重建（本设计 §6 消费不标 consumed 来源）
- `apps/desktop/src/shared/agentInputQueue.ts` — 投影字段缺省回落语义（合成投影照现有形状即可）

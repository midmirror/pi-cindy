# Changelog

> 2026-08-08 · 独立仓化（fresh history）后**仅 `v0.5.1` tag 存活**；v0.1.0 / v0.2.0 / v0.5.0 的
> tag 与全部旧 commit 随历史重写丢失（`git cat-file` 不可寻址），旧版本标题中的 commit 锚定
> 仅供参考。规划不在此记录（见 HANDOFF 未完成块）。

## [Unreleased] — 2026-08-08 · 开源发布准备 + 稳定性跟进

### Fixed

- **子 agent（Agent 工具）会话不再同步到手机端**（用户需求）：pi-subagents 用
  `createAgentSession` + `SessionManager.inMemory()` 在主进程内建子会话，`bindExtensions`
  会为子会话建独立 extension runner 并重新 emit `session_start` —— 此前子 agent 会话被
  落库并 push 到手机（会话列表噪音），且子 agent 实例 `startArbiter()` 会
  `takeOverProcessArbiter` 停掉主实例仲裁器 → 主实例被降级断 relay。修复：`isSubagentCtx`
  （`ctx.sessionManager.isPersisted() === false` 判定）在 tracker 与 index 的 `session_start`
  前置守卫——子 agent 不落库、不 setActiveId、不推手机、不参与仲裁/不连 relay；子 agent
  runner 的 activeId 恒 null，其消息/归档/推送自然跳过，主会话 activeId 与消息流不受污染。
  判定缺省保守（`isPersisted` 缺失/配置 `persistSession` 的自定义 agent 不过滤）。
  冒烟 19.7 +10（独立子 runner 模拟：不落库/不占 activeId/不推/消息不落主会话/shutdown
  不归档不清 activeId/主会话消息回归）

- **冒烟测试删真实登录态**（EXPERIENCE #45）：`token-store.ts` 硬编码 `~/.pi/cindy-sync`，
  不走 `PI_CINDY_DATA_DIR`——冒烟测试 20b 段（logout → saveSession → 畸形×3 → 401）的
  clearSession/saveSession 全部作用在真实 `session.enc`，**每次 `npm test` 删真实登录态**，
  pi 重启即“登录态丢了需重新登录”。修复：token-store 与 db.ts 同源尊重 `PI_CINDY_DATA_DIR`；
  dbg.ts 同步尊重（此前测试进程 mock 端点日志写进真实 relay-debug.log 污染排查）；auth-client
  refresh 全路径补 dbgLog（ok / malformed n/3 / 401 clearing session / failed）——clearSession
  首次可查因；冒烟加隔离回归断言（真实 session.enc 字节快照前后比对，路径同源引用
  token-store.DEFAULT_DIR）。冒烟隔离回归断言 +3

### Added

- **手机端 `/` palette 三源补全**（`maker:list-agent-commands` / `maker:list-agent-skills` /
  `maker:list-desktop-commands`）：此前三 channel 均不在 invoke allowlist，手机端打开 `/` 命令
  面板即 `CHANNEL_NOT_ALLOWED: maker:list-agent-commands`（parallel 拉取，任一 reject 即错误顶掉
  palette）。数据源 = pi 顶层 `pi.getCommands()`（ExtensionAPI）：扩展命令（source='extension'）→
  agent-builtin；prompt templates + skills → agent-skill（pi prompt 映射 source='user'，skill 映射
  'skill'，名保留 `skill:` 前缀对齐 pi `_expandSkillCommand` 的 /skill:name 识别）；desktop 命令
  返回空清单（pi-cindy 无 main 进程命令）。失败容错为空清单（success:true）——getCommands 缺失/
  抛错（老 pi）时手机端得空面板而非错误。契约对齐 mobile composerPalette 三源形状
  （packages/maker-shared/src/composerPalette.ts）；冒烟 palette 断言 +11（三源形状 +
  getCommands 缺失/抛错容错空清单）

- **已发布 npm**：`pi-cindy@0.5.1` 公开（`npm view` 可见，tarball 108 文件）；pi.dev 包市场自动抓取（`pi-package` keyword）；本地验证 `pi -e npm:pi-cindy` 安装加载正常（与 symlink 本地版同名工具冲突属预期，正式安装前需移除旧链接）
- `LICENSE`（Apache-2.0）+ `NOTICE`（上游 makecindy/cindy 派生声明）
- `README.md`（安装/使用/开发/架构/已知限制）、`.github/workflows/ci.yml`（Node 22：npm ci + test + typecheck）
- `.gitignore`（node_modules / *.log / .pi-loop.json.lock）
- **npm 发布管线**：`tsconfig.build.json`（tsc 编译 dist + d.ts + sourcemap）、`npm run build`、`prepublishOnly` 门禁（build + test + typecheck）、`keywords: ["pi-package"]`、`files` 白名单、`peerDependencies`（pi-coding-agent / typebox，不 bundle）、manifest 指向 `./dist/index.js`；`npm pack` 验证 108 文件 / 222.9 kB，dist 版注册 10 项与源码版一致

### Changed

- package.json：去 `private`，补 `license` / `author` / `repository` 字段
- 独立仓库化：`git init` 新仓（fresh history，不带旧仓含明文凭据历史），`~/.agents` 改为子模块引用（gitlink）；提交者信息固定 `midmirror <midmirror@live.com>`
- 移除 `docs/pi-remaining-work.md`（遗留文件，属 pi-live/sandbox 分支）；AGENTS.md 引用同步清理

### Removed

- `docs/pi-remaining-work.md`（遗留文件，非本项目文档）

### Security

- HANDOFF 内嵌真实 userId 脱敏（`<redacted>`）

## [0.5.2] — 2026-08-08 · review-swarm 跟进修复

### Fixed

- **连续畸形 token 响应累计清除**（修：仅「跳过落盘」→ 服务端持续异常时每轮刷新全量往返拿
  垃圾、无限静默失败且无重登提示）：`getAccessToken` 新增连续畸形计数
  （`consecutiveMalformedCount`），单次畸形仍保留好 token 不落盘；连续 3 次 → 同 401 处理
  clearSession 强制重登；成功刷新 / 401 / 登出均复位计数。冒烟畸形计数断言 +6（第 1/2 次畸形
  保留会话、第 3 次清会话、401 复位后 2 连畸形不触发清除）
- **review 二轮跟进修复**（EXPERIENCE #46，review-swarm 四审结论落地）：
  - `savePair`（登录/换码入口）复位畸形计数 + bump cacheGeneration——旧 streak 残留会让
    重登后首刷畸形即误触上限清新会话；登录与在途刷新并发时旧刷新会覆盖新会话
  - 畸形×3 清除路径同步清 cachedToken/cachedExp（与 401 分支对称，状态一致性收口）
  - refresh failed 日志脱敏：只打 code/status 或错误类型，不打 err.message（AuthApiError
    含服务端响应体，错误回显请求体时 token/deviceId 泄进 relay-debug.log）
  - palette 行级防御：getCommands 返回行过滤非对象（单行 null 曾致整面板 error）；
    冒烟 null 行过滤 +2 断言
  - token-store 导出 `DEFAULT_DIR`，冒烟真实 session.enc 快照路径同源引用（防 DIR 逻辑
    迁移后快照静默校验错路径）
  - 冒烟补成功刷新复位计数测试（Date.now 假跳过期强制走刷新，+3 断言）
  - 契约对证参考仓 mobile：`ComposerSlashCommand.scope?: string` 未定型联合，pi 的
    user/project/temporary 透传安全；`source: 'user'|'skill'` 映射与 prompt→user 一致；
    三源结果形状 `{success,error?,commands?/skills?}` 吻合——M2 无代码改动
- **isValidTokenPair 守卫类型收窄**（修：`pair is TokenPair` 声称校验了必填的 membership
  但从未检查——类型撒谎，未来消费方 `pair.membership.id` 会 TypeError）：新增 `AuthTokenPair`
  （仅 accessToken/refreshToken 两个实际消费字段），守卫返回类型收窄为该形状；注释明确
  membership 不在守卫范围（本仓无消费方 + 刷新/换码响应可能不含）；`refreshToken()` / `savePair` /
  登录路径 cast 同步收窄
- **runTick 死分支清理**（修：未过期 handoff 已在 runTick 前段 return，`handoffFresh ? false`
  永不可达）：`staleForTakeover` 简化为 sameProcessLease → handoffExpired → staleMs 三级判定，
  注释说明流到该处的交接信号只可能过期/缺失
- **仲裁器注册表 last-wins 语义注释**：`registerProcessArbiter` 文档注明注册表按进程全局互斥——
  同进程多 pi 会话时后 startArbiter 者接管，最终单活仲裁器持有 device-link；个人桥接模型下
  为预期行为
- **ownership 测试断言修正**（修：`arbD.isStandby() === false` 恒真——stop() 已置 standby
  false，第二项死代码）：改验 DB 行 owner 未被抢回 + eventsD 无新增 acquire

## [0.5.1] — 2026-08-07 · review-swarm 四审 H/M 修复

### Fixed

- **热重载泄漏根治（单实例误报 standby 永久化）**：扩展热重载（/reload / 会话切换重建
  extension runner）重执行模块，旧实例的仲裁器定时器不保证被清理 → 同进程累积多个泄漏
  仲裁器，旧实例持续续期「同 pid 幽灵租约」，新实例永久 standby（真机复现：9+ 泄漏
  仲裁器共存，设备离线但 lease 恒新鲜无人接管）。双管齐下：①`runTick` 新增
  `sameProcessLease` 判定——`row.ownerPid === process.pid` 且非己 ownerId 的租约视为
  重载幽灵，无有效交接信号即 CAS 立即接管（不等 staleMs，幽灵永不过期）；②进程级仲裁器
  注册表（`takeOverProcessArbiter`/`registerProcessArbiter`/`releaseProcessArbiter`，
  globalThis 跨模块实例存活）——后进者先 dispose 旧 bundle（停仲裁器 + sweep + 实例
  心跳，不关 DB），任意时刻只一个活仲裁器，杜绝互抢翻转。跨进程互斥仍由 SQLite 单行
  CAS 保证。测试：ownership 30 断言（同 pid 幽灵立即接管 <2s / 注册表 takeOver 幂等 /
  重载模拟 A 停 B 接无翻转），`npm test` 纳入 ownership.test.js
- **token 对防御性校验（畸形刷新响应不落盘）**：刷新/登录响应无条件写 session.enc——
  服务端异常或端点漂移时返回畸形 token（真机复现 refreshToken="rt" 2 字符）直接把好
  token 冲掉 → 永久 401 INVALID_REFRESH_TOKEN 只能重登。新增 `isValidTokenPair`（access/
  refresh token ≥16 字符），`getAccessToken` 畸形响应返回 null 不落盘、401
  INVALID_REFRESH_TOKEN 自动 clearSession（瞬态网络错误不清，防断网误登出）；`savePair`
  登录/换码同样拒绝畸形 pair。测试：冒烟 241→249 断言（短/缺/null token 判无效、畸形
  刷新不覆盖 session.enc、401 清会话）
- **死宿主会话清理补洞（手机端列表堆积死会话）**：`sweepStaleInstances` 原只遍历
  `cindy_instances`——死实例行被 `releaseInstance` 优雅删除后 sweep 看不到它，其 active
  会话 host 指向不存在的实例、status 永为 active；router 死宿主路径也只清 host 不归档
  → 手机端 sessions:list "active" 堆积死会话。修复：sweep 增加**按会话反查**——active
  会话的 host 不在活实例 → 归档；host 已空 → 归档；当前活实例会话不受影响。测试：冒烟
  249→252 断言（host=已删死实例归档 / host=空归档 / 活实例保留）
- **H1 交接过期回落清 handoff**：`renew` 用 CASE 条件清过期 handoff_to/handoff_expires_at
  （新鲜保留）。此前 reclaim 后行上残留过期 handoff → standby 永久按 heartbeatMs 放宽陈旧阈值
  → 健康 owner 被误抢（flap）。单测 26b（真实 sqlite store：无人认领→A 收回→字段清空→C 不抢）
- **H2 路由响应形状**：非投影类 channel（send/steer/abort-session/close-session/set-model/
  set-effort/set-permission-mode/set-fast-mode）路由返回本地同形状 `{ok:true}`；死宿主非投影类
  抛 invoke error（NOT_FOUND）。此前一律回合成投影 → 手机端 ok===undefined 误判失败
- **M1 get-projection 错误可见**：特判移到 unhosted/死宿主分支之后——unhosted 会话
  get-projection → NOT_FOUND；死宿主 → error 投影（不再静默空队列）
- **M2 优雅关闭清邮箱**：session_shutdown 先标自己 pending 邮箱行 failed（防 pi resume 复活后
  旧消息重放注入）
- **M3 邮箱滞留闭环**：session_start 激活即消费本会话 pending 行（acquire 只消费当时 activeId）；
  owner sweep 加 pending 行 10min TTL → failed（无法消费的滞留行不无限堆积）
- **M4 假活宿主熔断**：未认领交接记 strike（TTL 内目标未 claim → 命中），router 对 struck 宿主
  fail-fast（不发起 handoff），5min 自动衰减；挂死宿主不再每消息一轮 10s 接管循环
- **M5 心跳硬上限**：instanceAlive 心跳 >2×staleMs 无论 pid 判死（pid 复用幽灵 / 挂死兜底）
- **M6 集成测试走真实路由**：multi-process worker invoke 改经 `router.routeInvoke`（此前直调
  upsertMailbox+handoffTo 绕过路由语义）；断言收紧（必须 DEMOTED、无 ROUTE-ERR、接管 ≤2s）；
  `npm test` 纳入 multi-process
- 本地队列 clientId 环形窗口：remember 移到落库后（DB 写失败不吞重发），无 clientId 不记窗口
- 测试：冒烟 218→241 断言（26b H1/M4、H2 形状、M1 重排、M2 shutdown 清邮箱、M3 激活消费+
  TTL、M5 硬上限）

## [0.5.0] — 2026-08-07 · 未打 tag（旧仓锚定已失效）

### Added

- **会话路由 + 快速接管**（spec: `docs/specs/2026-08-07-session-routed-handoff-design.md`）：
  手机端在任意会话发消息 → 消息路由到「拥有该会话的 pi 进程」（宿主）：
  - 宿主标注：`sessions.host_instance_id`（tracker session_start 写 / shutdown 清，
    instance.ts 进程级 UUID）；`cindy_instances` 实例心跳表（10s 续写，随仲裁器生命周期启停）
  - 路由判定（router.ts SESSION_LOCAL 集）：host==我 → 本地 handler（现状语义）；host==null →
    NOT_FOUND；host 活 → 邮箱落行 + 定向接管 + 合成投影；host 死 → 清 host/邮箱 failed +
    error 投影；get-projection 只读合成（不落邮箱不接管）
  - 定向接管（ownership.ts）：`handoffTo(targetInstanceId)` 写交接信号（TTL 10s）后本地让位
    停续期（行保留）；目标实例 fastPoll（默认 1s）独占认领（无视心跳新鲜度），非目标被动；
    交接过期按 heartbeatMs 放宽陈旧判定（消除 TTL→stale 死窗）；`isAwaitingHandoff()` 防重复
    CAS；tryTakeover 认领即清 handoff 字段（防目标把自家行误判 awaiting 自损）
  - 邮箱（`cindy_handoff_mailbox`）：跨进程 invoke 转发，UNIQUE(session_id, client_id) 幂等
    落行；宿主接管后 `consumeMailboxForSession` 本地重放（成功删行、失败不标 consumed 下轮
    重试）；owner 15s sweep 清理死宿主（清 host/归档/标 failed/删实例行）+ failed 行 5min 超时清理
  - 本地输入队列 clientId 环形窗口去重（同 (session, clientId) 重发 no-op，弱网防线，
    对齐 desktop RECENT_ENQUEUED_CLIENT_IDS）
- index.ts 接线：`wireInvokeContext`（push 闭包动态读 client，连接重建不丢推送；handoffTo/
  handoffPending 注入 router）；instance 心跳 + 死宿主 sweep timer 随仲裁器生命周期；
  `/cindy-status` 增 Inst/Host
- 测试：冒烟 167→218 断言（schema 列/表、host 读写、实例心跳活体、邮箱存取+宿主清理、
  仲裁 handoff 三实例、路由三分支+awaiting+环形去重、邮箱消费+损坏保留、sweep 死/活实例）；
  三进程集成握手（A 让位 → B 独占认领 → B 消费邮箱注入，C 全程不抢；`fastPollMs` 注入）

### Fixed

- plan 稿代码 bug：`clearHostAndArchiveForInstance` 顺序（必须先标邮箱 failed 再清 host——
  邮箱 UPDATE 的子查询依赖 host_instance_id 旧值，反序漏标 pending 行永久滞留）
- @types/node lock 陈旧 20.19.43（无 node:sqlite 类型，typecheck 恒红）→ 22.20.1，
  双门禁恢复全绿（package.json 本就声明 ^22.20.1，lock 被镜像解析落后）
- 集成测试 worker stdin 解析：`split(/ (.+)/)` 吞掉剩余整串 → sid 带空格 INVALID_PARAMS →
  worker 崩、场景静默失败；改先切前缀再按首空格分

## [0.4.0] — 2026-08-07 · 未打 tag

### Added

- 被控授权门禁（对齐 desktop settings-store + dispatch.ts + index.ts）：
  `src/store/settings-store.ts`（remoteControlEnabled 全局开关 + revokedControllers 逐设备黑名单，
  JSON 原子写 + 0600）；link-open / device-link:subscribe / 通用 invoke 三入口门禁
  （REMOTE_DISABLED / ACCESS_REVOKED 终态错误，link-open 撤销场景发 link-close('revoked') 明确信号）
- 命令：`/cindy-revoke <deviceId>`（入黑名单 + 踢断）、`/cindy-restore <deviceId>`（移除 +
  presence 广播让控制端重试订阅恢复）、`/cindy-remote [on|off]`（全局开关，关闭即断开全部控制端）；
  `/cindy-status` 显示 Remote 开关 + 撤销名单数
- client 能力方法：closeLink(reason) / sendPresence(partial) / disconnectAllControllers(reason)
  （对齐 desktop closeLink inbound 语义 + restoreController presence 信号）
- 测试 133→147 断言：settings 读写/原子写无 tmp 残留、remote off 三入口拒绝、revoked
  link-open 不回 accept + 发 link-close(revoked)、revoked subscribe/invoke → ACCESS_REVOKED、
  restore 后放行 + 正常 link-accept

### Fixed

- **review 二轮修复（2026-08-07 二次复核 60b8c86）**：
  - 回归：会话切换（new/fork/resume）/`/cindy-disconnect` 后 relay 不重连（仲裁器已在
    运行 → startArbiter 早退 + onAcquire 不触发 → ensureClient 无人调用）：
    `ensureAndNotify()` 统一补连路径，session_start/登录流在持有者状态下直接补连
  - F6 补全：页面级损坏（header 完好）→ open 期 `PRAGMA quick_check` 全表扫描检测，
    失败隔离重建（含 -wal/-shm）；判据补 `not a database`（SQLITE_NOTADB 实测消息）；
    DDL exec 移入隔离范围。store-sqlite 测试 +2
  - F7 补全：settings 非 ENOENT 读错误（EACCES 等）改 fail-closed（曾 fail-open）；
    损坏基座上执行更新时 dbgLog 明示 fail-closed 被持久化（/cindy-revoke 意外关 Remote
    可观测，/cindy-remote on 自愈）

- **review 修复批次（2026-08-07 四 reviewer 评审 72924b5）**：
  - 跨进程 revoke/remote-off 失效（standby 写 settings 但 owner 不感知 → 被撤销控制器持续收 push）：
    client 新增 `sweepRevokedControllers()`，持有者 2s 轮询重扫（revoked → link-close('revoked')，
    remote off → 全部 toggle-off）；revoke/remote 命令 standby 场景提示「≤2s 内生效」
  - WAL 边车权限泄漏（全新安装 -wal/-shm 按 umask 0644 落盘，未 checkpoint 帧同机可读）：
    `restrictDbFilePermissions` 覆盖主库 + -wal + -shm（SQLite 边车只在创建时刻继承主库 mode）
  - settings.json 损坏 fail-open（黑名单静默失效、已撤销控制器重新武装）→ fail-closed（remote 关），
    命令路径重写自愈；缺失文件仍回落默认值
  - settings 跨进程写竞态（固定 `.tmp` 名互相覆盖 + 锁外 RMW 丢键）→ pid 后缀 tmp + 锁文件
    （20ms×50 重试 + 2s 陈旧接管，超时退化为 last-writer-wins）
  - 冷启动状态线说谎（startArbiter 后同步 `isOwner()` 恒 false，单实例误报 standby）：
    session_start/login/connect 全部改由仲裁回调驱动（onAcquire/onStandbyChanged/onDemote），
    `/cindy-connect` 经 `waitForOwnership(8s)` 判定
  - updateSession 整行 read-modify-write 丢并发更新（多进程共享库同行不同列互相覆盖）→
    定点列 UPDATE（`SET col = ?` 只写 patch 列 + updated_at），计数器语义不变
  - 协议 mismatch 无用户信号（`/cindy-status` 只显 Relay:❌）→ `isProtocolMismatch()` +
    lastIssue `protocol-mismatch` 状态展示
  - db 损坏无恢复路径 → open 失败隔离改名 `pi-cindy.db.corrupt-<ts>`（含 -wal/-shm）重建
  - node:sqlite 运行时下限未强制（Node <22.23 模块加载即崩整个扩展）→ package.json
    `engines: node >=22.23` + db.ts 懒加载（失败带当前版本可读错误）
  - closeDb 从不调用（WAL 不 checkpoint + ownershipStore 缓存死句柄）→ stopArbiter 收尾
    closeDb + 语句缓存失效 + ownershipStore 置空
  - 热路径 churn：getDb 每次 chmodSync（移除，仅 open 路径收敛）+ 每调用 re-prepare
    （`getStmt` 语句缓存，session-store/ownership/migration 统一走）
  - 迁移逐行 autocommit → 单事务批量（失败 ROLLBACK，migration_done 缺失重跑）
  - 测试 147→167：settings 损坏 fail-closed / 锁与 tmp 无残留 / sweep 断开撤销与禁用 /
    定点 UPDATE 列级互不覆盖 / subscribe 成功形状 `result:{ok:true}` 钉线 /
    protocol mismatch 拒上线（真实 ws 握手）/ notify 能力位门禁（无声明不发、有声明发）

- hello-ack `serverProtocolVersion` 未校验（技术债）：对齐参考 client.ts 防御性二道闸——
  mismatch → 拒上线 + protocolMismatch 标志停重连（不复用 authFailed 的“请重新登录”文案）；
  实测 server v1 = PROTOCOL_VERSION，校验不误伤
- notify 能力位门禁缺失（技术债）：检出 cindy-protocol 子模块获 `SERVER_CAPABILITY_NOTIFY = 'notify'`
  （参考仓 `.gitmodules`），client.notify 加 capability gate——hello-ack.capabilities 未声明不发
  （对齐协议仓 §notify：旧 server 对未知 kind 静默黑洞）

### Removed

- 旧 JSON 孤儿数据清理：`~/.pi/cindy-sync/sessions.json` + `messages/`（27 会话/669 消息，
  8/5-8/6 白天 JSON 时代遗留）。确认：SQLite 已完全接管（store 零 JSON 引用 + db 承载当前会话），
  旧数据因迁移触发条件 `db 为空` 从未导入（见 EXPERIENCE #27），与 db 无重叠、代码不再读、
  手机端从未可见；用户确认后直接删除

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

### Fixed

- standby 进程空白会话根除（多进程仲裁后 `getClient()=null`，tracker 各 handler 的
  `if (!c || !sid) return` 曾挡在落库之前 → standby 会话消息不落库 + shutdown 不归档，
  active 空白会话在手机端刷屏）：6 处 handler（model_select/message_end/
  agent_settled/session_shutdown/turn_start）落库与 push 解耦，落库不依赖 client，
  push 才判空；standby 真实会话数据完整落共享库，shutdown 正常归档。测试 125→133
- SQLite db 文件权限收敛 0600（含全部对话内容；曾 0644 world-readable，相对 JSON 版
  0o600 与 desktop betterSqliteFactory 均为回归）；每次 getDb 幂等收敛存量库
- ensureClient 连接后复检持有者身份：onAcquire → connect 在途时被 demote/登出 →
  连接建立后无持有者复检的僵尸连接（standby 持活连接会 4409 踢真 owner）；IIFE 捕获
  仲裁器引用（stopArbiter 置 null 后仍可复检）；session_shutdown reason quit/reload →
  stopArbiter 释放持有权（同伴 ≤5s 接管）；命令路径 stale ctx 守卫（safeSetStatus）

## [0.2.0] — 2026-08-06 · 旧仓 tag `v0.2.0`（commit `690f817`，已不可寻址；P1 真机补测全过）

### Added

- 端点热更新（`src/endpoints.ts`）：启动/登录时从 Cindy CDN 拉取客户端端点清单
  （`https://hotfix.{cindy.app|cindy.com.cn}/cindy/endpoint.json`），解析/校验对齐参考仓
  `parseClientEndpointManifest` 严格语义（schemaVersion ≤1、协议白名单、无 URL 凭据、
  尾斜杠归一、缺失字段补 `''`、未知字段忽略）；所有端点消费方（auth refresh/登录/登出、
  relay WS URL）改为 `getEndpoint()` 动态读取，清单覆盖烘焙默认。拉取失败保留烘焙值
  + 日志，不阻断（extension 与 desktop packaged 阻断语义的差异见 EXPERIENCE）
- RFC 8252 loopback 回调回落（`src/auth/loopback.ts`）：`authDesktopCallbackUrl` 为空时
  本机起随机端口 HTTP server（路径 `/auth/callback`，state 校验防抢先消费授权码）
  接收浏览器回调换 token；托管回调轮询保持为主路径（清单字段同时是灰度/回滚开关）
- `binding_required` 全流程：`requestBindingCode`（`/api/auth/binding/request-code`）
  + `verifyBinding`（`/api/auth/binding/verify`）走通，`/cindy-login` email 流程绑定
  交互（收集联系方式 → 验证码 → 绑定 → 续 select_account/ok）
- 补 `locale` 参数（requestEmailCode/requestBindingCode + authorize `ui_locale`），
  从 `CINDY_LOCALE`/系统 LANG 解析，缺省 `en`（对齐参考仓 SUPPORTED_LOCALES）
- `src/dbg.ts`：relay-debug.log 排障日志抽为共享模块（client.ts 私有 → 全模块可复用于端点热更新等）
- 测试 80→113 断言：清单解析严格语义（9 用例）、CDN 拉取覆盖/失败保留、loopback
  纯函数 + 端到端 listener、binding 请求形状

### Changed

- `DEFAULT_ENDPOINTS` 语义改为烘焙默认（自举），生效端点以清单覆盖为准
- 社交登录 authorize URL 增加 `ui_locale`（对齐参考仓 buildAuthorizeUrl）
- `/cindy-status` 增加 Models 数显示（诊断用，`getRuntimeModels().length`）

### Fixed

- 端点硬编码：relay/登录/登出/refresh 全部改为运行时生效端点（清单可远程改址，重启生效）
- relay-error 刷屏：握手后 `DEVICE_OFFLINE` 等 relay-error 帧不再每帧 `console.error`，
  改进排障日志 + `onRelayError` 回调；离线体现在 status line（`Cindy: device offline (code)`），
  业务帧到达自动清回在线
- 手机端常调 channel 被 allowlist 拒绝（CHANNEL_NOT_ALLOWED 刷屏 + 手机端功能缺失）：
  恢复 `maker:goal:get-status`（恒 null）、`maker:schedule:list`（恒 []）、
  `notification:clear-session-attention`（no-op）三个系统级 channel（`src/handlers/system.ts`，
  返回形状对齐 desktop 空态）；新增 `fs:stat-path`（`src/handlers/fs-browse.ts`，
  expandHome + stat → `{kind: dir|file|missing, resolvedPath}`，对齐 desktop fsBrowse 契约，
  该 channel 在 device-link allowlist 内设计上即允许被控端执行）；测试 119→125 断言

## [0.1.0] — 2026-08-06 · 旧仓 tag `v0.1.0`（已不可寻址）

首个可交付版本（早期版本号从 0.1 起）：扩展骨架 + 三轮评审/真机修复全部落地，`npm test` + `npm run typecheck`（strict）双门禁绿。

### Added

- 扩展骨架：`/cindy-login|logout|status|connect|disconnect` 5 命令 + 2 工具；device-link WebSocket 客户端（hello/link-open/invoke/push/notify/ping）
- invoke 路由：58 channel allowlist，dispatch 到会话/消息/maker handlers
- `maker:input:*` 输入队列 16 通道（enqueue/stop/steer/get-projection + projection push 回流）+ 12 个常规 input 通道（compact/resume/remove/update/move/set-expanded/...）
- capabilities 输出 mobile 契约形状 + 模型白名单过滤（`scopedModels`，pin 作 defaultEffort）+ provider 前缀 + id 去重
- provider 辅助接口：`provider:list` / `usage:model-pricing` / `api-key:present`
- PKCE 登录（google/apple/email + `select_account` + `binding_required` 明确报错）、AES-256-GCM token 存储、`model_select` 事件同步推送
- `src/runtime.ts`：session_start 捕获 ctx 能力（modelRegistry/abort/compact/isIdle），供 invoke handlers 使用
- 测试纳入仓库管理：`tests/smoke.test.js`（冒烟全绿，`PI_CINDY_DATA_DIR` 隔离）+ `npm run typecheck` 门禁
- 文档规范：`AGENTS.md` / `CHANGELOG.md` / `docs/EXPERIENCE.md` / 重构后的 `docs/HANDOFF.md`

### Changed

- 时间戳输出统一 ISO 字符串（mobile 契约；store 内部仍存毫秒）
- `messages:list` 恒降序 + id 游标窗口（`beforeTs` 毫秒兜底）；新增 `messages:around` / `around-client-id`（radius 60/200 钳制）
- 会话 model 存纯 id + providerId 分离（不再拼 `provider/id`）；createSession 默认模型回落 registry 首模型
- push 按订阅表 + topic 路由（`topicForPush`：列表级 → `sessions`，会话级 → `session:<id>`），只发订阅者
- 消息落库/推送带 `clientId`；assistant push 截断打 `agentMeta.remoteContentTruncated`
- `usage:session-tokens-changed` key 改 `totalTokens`
- session_shutdown 顺序：tracker 先归档/推送，index 再断开 relay
- 中断语义对齐 desktop（activeTurnStartedAt/lastTurnEndedAt 判定）；inputStop 支持 opts（keepQueue/pauseQueue）
- 落库与权威推送只在 tracker 完成，handler 只推状态信号 + 更新 userSendAt（消除双写双推）
- 摘除伪造 `get-session-tree` / `navigate-session-tree`（能力位 `sessionTree:false`）；`list-available-agents` 返回 `["pi"]`

### Fixed

- post-handshake 帧全丢（message 监听器存活整个 socket 生命周期；hello-ack 只切状态）
- enqueue 同步调用 TypeError（`pi.sendUserMessage` 返回 void，改 try/catch）+ 注入前 apply model/effort
- stop/中断/压缩静默 no-op（顶层无 abort，改走 `src/runtime.ts` 捕获的 ctx 动作）
- disconnect/logout/session_shutdown 失效 5s 复活（stopped 标志 + settle 在途握手）
- cn 账号连 global relay 401 死循环（realm 从落盘会话派生）；同 deviceId 双连接 4409 互踢（替换前 disconnect + single-flight）
- 握手 watchdog 保持到 hello-ack/relay-error；坏 token 指数退避 1s→30s + 401 停止重连
- `sessions:list` 位置参数 + clampLimit(20) + status 过滤；`regenerate-title` 兼容 `{sessionId}` 对象
- 队列投影透传 `chatMessage`（附件显式拒绝而非静默丢弃）；`maker:event` 死推送移除
- patch-meta 字段白名单 + 校验；logout 按 realm 选端点；hello 报真实 busy + presence-set 同步
- store 原子写（tmp+rename）、损坏文件保留改名、sessionId 白名单防路径穿越
- auth refresh single-flight + logout 代数失效（防轮转竞争 / 登出后在途刷新写回）
- `session_start` 会话不落库：tracker 建会话依赖 relay client 就绪，client 未就绪时
  `if (!c) return` 导致当前会话永不落库 → 手机端 `sessions:list "active"` 恒空、刷新
  不出会话（真机复现）。改：建会话 + setActiveId 前置，push 才判空（EXPERIENCE #22）
- 测试 113→119 断言：新增 tracker 事件测试（client 未就绪仍落库 active / 就绪后推
  sessions:created / 已归档会话再 start 恢复 active）

### Security

- token 存储威胁模型文档化（真实边界 0600；更强保护需 OS keyring）
- `relay-debug.log` 0600 + 1MB 截断 + 真开关（删文件即关，`PI_CINDY_DEBUG=1` 兜底）
- 移除提交树中的明文凭据（telegram-cli session 二进制 + opencode.json 含 API token；token 应尽快轮换）

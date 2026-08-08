# pi-cindy 踩坑与迭代经验

> 踩坑与迭代经验**唯一源**。编号条目（1..N）：同义改写原条目，编号不重排；
> 过时条目 ~~删除线~~ + 日期。来源：三轮评审/真机验证沉淀（原 ISSUES.md 经验教训 #1-13 迁移于此）。

**文档分工**：
- 附录「问题记录」 = 根因/修复/验证表（#1-62，原 ISSUES.md 并入）
- `CHANGELOG.md` = 版本化变更流水（按版本 Added/Changed/Fixed/...）
- `HANDOFF.md` = 交付状态（工作背景/已完成/未完成）
- 本文件 = **可迁移的踩坑 + 迭代经验**（为什么 / 怎么避免）

---

## 踩坑

### 1. 协议契约以「对端消费方源码」为准，不以扩展自身理解为准

三次 P0 都是「想当然 vs 手机端实际」落差：手机端会话页**只**调 `maker:input:*`（`maker:send` 已废弃）；时间戳是 ISO 字符串走 `localeCompare`（毫秒数字直接崩渲染）；`before/after` 是消息 ID 游标不是时间戳。

**方法**：对齐前先在参考仓 grep 手机端实际调用（`mobileMakerTransport.ts`、`remoteSessionStore.ts`、`app/sessions/[sessionId].tsx`），再对照 desktop 实现确认语义，最后才动手。（问题记录 #1-3）

### 2. 「修复」不等于「修好」：链路改动必须有帧级测试

工作区那轮修复（onReady 提前 + readyHandler 转发）方向对，但没删 `ws.off` —— else 分支成死代码，功能从「重连后死」退化成「首连即死」。真机只验证到 hello-ack，**握手成功 ≠ 业务帧可达**，所以没暴露。

**方法**：链路类改动必须配帧级冒烟测试（模拟 relay 全覆盖 hello-ack 后 link-open/invoke/subscribe/push/presence/disconnect/401/watchdog）。参考仓 `packages/device-link/src/__tests__/` 是现成模板。（问题记录 #1）

### 3. 参考实现具体函数是最高优先级证据

`getHello`（busy 语义）、`sendPush`（恒带 dst）、`sendNotify`（能力位门禁）、`topicForPush`（路由规则）、`sendPresence`（presence-set）、`mobileNotify.ts`（deepLink 格式）、`patchSessionMetaInDb`（字段白名单）——每个修复点都能在参考仓找到**同名同语义**实现。先找到它再决定改什么；找不到（如协议常量在未检出子模块）就文档化而不是猜。（问题记录 #11-19）

### 4. 位置参数/返回形态以 desktop ipc handler 签名为准

`sessions:list(limit, status, options)`、`messages:list(sessionId, opts{limit,before,beforeTs,after})`——参数形态、clamp 上限（list 20 / 消息 50-100）、默认值都抄 desktop `localDb/ipc/*.ts`，扩展侧零发明。（问题记录 #9-10）

### 5. 并发评审时锚定提交版本，标注工作区差异

评审期间工作区被并发修改，reviewer 读到新旧混合状态。聚合时以提交版本为基准、逐条核对工作区是否已修：避免重复上报用户已修问题，也避免把工作区「假修复」当真（#1 就是工作区看似修了实则没修）。（问题记录 #33-56 评审背景）

### 6. 消息双写双推的坑

`maker:send` 与 tracker `message_end` 都 appendMessage + push 用户消息 → 同内容不同 id 两行。**落库与权威推送只在 tracker 完成**，handler 只推状态信号（sessions:activity）+ 更新 userSendAt。（问题记录 #19 关联）

### 7. 主动断开与自动重连必须互斥

disconnect → close 事件 → 重连的异步时序是经典坑。任何「主动断开」路径都要有 stopped 标志并在 close handler 检查，同时 settle 在途握手，否则 logout 变复活、断连变幽灵连接。（问题记录 #4）

### 8. ExtensionAPI 与 ExtensionContext 的 API 面差异：先查 d.ts 接口面

顶层 `pi`（ExtensionAPI）**没有** `abort/compact/isIdle/getContextUsage/modelRegistry`——只在 session 的 ExtensionContext 上。`pi().abort?.()` 是**静默 no-op**（不报错不崩溃，调用方以为中断了实际没发生）；`pi.sendUserMessage` 返回 **void**（非 Promise），`.catch()` 链在 void 上同步抛 TypeError。

**方法**：写扩展调用前先读 `dist/core/extensions/types.d.ts` 接口面（ExtensionAPI vs ExtensionContext），确认方法存在性 + 返回类型；需要 ctx 能力时在 `session_start` 捕获一次，与 client 生命周期解耦（本扩展 `src/runtime.ts`）。（问题记录 #21-22）

### 9. capabilities 契约是「静默空」陷阱

`normalizeMobileAgentCapabilities` 只读固定字段名（`availableModels`/`effortLevels`/`permissionModes`/`hasFastMode`/`planMode.supported`）。缺字段 → 空数组，**不报错不崩溃**。返回「看起来对」的字段（`availableAgents`/裸字符串数组/布尔 `planMode`）等于没实现——模型选择器、effort 下拉、Fast 开关全部静默失效。

**方法**：改 capabilities 前对照 `packages/maker-shared/src/agentCapabilities.ts` normalize 字段清单 + `buildSessionRuntimeOptions` 消费路径，逐一核对；测试里跑一次 normalize 断言非空。（问题记录 #20）

### 10. 真机日志（relay-debug.log）是最快的排查入口

手机端卡死时先 grep 日志看**实际走到哪一步**：本次显示手机只发 `get-capabilities` + `provider:list`、从未发 enqueue → 问题在发送之前（模型解析被卡），不是发送链路坏了。每次 invoke 都有 channel + args 记录，`grep -n "input:enqueue|provider:list|CHANNEL_NOT_ALLOWED"` 即可还原手机端完整调用序列。（问题记录 #20-29）

### 11. 测试入库 + 数据隔离

首版临时冒烟测试直接写真实 `~/.pi/cindy-sync`（污染用户数据）。`PI_CINDY_DATA_DIR` 环境变量覆盖 store 数据目录，测试写 `mkdtemp` 临时目录跑完清理；jiti 作为 devDep 与 pi 运行时同版本（测试与扩展同一 TS 加载器）；`npm test` / `npm run typecheck`（strict）双门禁。**临时测试不持久化 = 白写，要么入库要么删。**（问题记录 #30-32）

### 12. 注释说对了不算实现对了：分页「返回顺序」是契约的一部分

`messages:list` 注释明写「恒返回降序窗口」，实现却是 `slice(-limit)` 升序——矛盾活过了前两轮修复。mobile `historyWindowGap.ts` 按「最新在前、页尾最旧」**计算下一页游标**，顺序错了分页全错（不崩、静默错）。after 游标分支更隐蔽：desktop 先 ASC 取窗再 reverse，**两分支输出都是降序**，光看单分支容易抄错。

**方法**：分页/游标类契约先读 desktop 完整实现（含 orderBy + reverse 两段），再读 mobile 消费侧对顺序的显式依赖，最后写测试锁死每个分支的输出序。自查：注释说「恒降序」就去断言降序，实现与注释不一致本身就是 bug 信号。（问题记录 #34）

### 13. 乐观更新管线的 id 契约：预生成 id 必须被采纳

mobile 新建会话走乐观管线：**手机端预生成 session id**，乐观行/路由/订阅从一开始用最终 id。被控端不采纳（自造 UUID）→ mobile 抛 `sessionIdNotAdopted` **确定性失败**。desktop maker-core 对传入 id 幂等（active 复用 / storage 命中跳过 insert），这是「支持乐观更新」的最低要求。返回形状同理：mobile 只读 `normalizeCreateSessionResult` 字段（sessionId/agentKind/workDir）。

**方法**：任何被控端 handler 返回，先找 mobile 侧对应 normalize/validate 函数逐字段对照；「接受预生成 id + 幂等」是移动端乐观更新通用契约。（问题记录 #33）

---

## 迭代经验

### 14. review-swarm 对拍参考实现是契约类扩展的最高效审查方式

4 个 reviewer 并行（意图回归/安全隐私/性能可靠性/契约覆盖）对照参考仓，产出 ~25 finding、过滤 23 条有效（3 P0/7 P1）。对拍（diff 参考实现同名函数）比纯逻辑审查更能抓契约缺口——本扩展两轮评审共修复 #1-56，全部有参考仓对应函数背书。

### 15. 真机验证要「走到业务路径」，不止握手成功

登录验证通过 ≠ 功能可用。真机必须走到：会话列表同步 → 会话页打开 → 模型选择 → 发消息 → 回复回流。每次只验证握手，契约错（输入队列架构、ISO 时间戳）要等真机才爆。**能真机的功能优先真机，别等 mock 层自我感觉良好。**

### 16. 修复优先级：先修「静默失效」类，再修「显式报错」类

「选不了模型」「发消息收不到」这类静默空/静默 no-op 比显式报错危害大得多——用户看到的是功能消失，日志毫无线索（normalize 缺字段不报错、`pi().abort?.()` 恒 undefined）。排查顺序：真机日志还原调用序列 → 找静默 no-op 点 → 补契约形状测试。

### 17. 文档与实现必须同轮校验

注释/文档描述与实现矛盾本身就是 bug 信号（#12 分页顺序、#21 `sendUserMessage` 返回类型）。改代码时同步改注释；评审时抽查「注释断言 vs 测试断言」是否一致。

### 18. 端点热更新：extension 不复制 desktop 的「阻断式」清单语义

desktop packaged 语义 = 清单拉取失败/非法 → 启动阻断 + 重试，无缓存无烘焙兜底
（`clientEndpoints.ts` 注释原话「任何本地兜底都会把非空 CDN 配置错误静默掩盖」）。但那是
**正式包**约束——阻断整个 Pi 启动对 extension 不可接受。本扩展取舍：拉取失败保留烘焙默认
+ relay-debug.log 记录，不抛出；不做落盘缓存（避免缓存文件被其他进程写 → 信任面，拉取失败
直接退回烘焙值）。差异有意保留，改动前先读参考仓 `clientEndpointsService.ts` 宿主职责划分。

### 19. 清单 region 字段 vs expectedRegion 校验

参考 `parseClientEndpointManifest` 支持 expectedRegion 校验（region 不匹配整份拒绝），但线上
CDN 清单**没有 region 字段**（region 可选，缺失即 null）——若传 expectedRegion 会把全部合法
清单整份拒绝。本扩展不做 region 校验；region 由 hotfix base 域名归属确定（cn→hotfix.cindy.com.cn、
global→hotfix.cindy.app）。

### 20. 共享代码抽模块 + 测试顺序副作用

dbgLog 曾私有于 client.ts，端点热更新想打同一日志 → 差点复制一份。正确：抽 `src/dbg.ts`
单实现共享。测试注意：refreshEndpoints 会覆盖全局生效端点，后续断言硬编码 host 会挂
（实测 binding URL 断言失败）——断言用 `getEndpoint()` 生效值而非字面量。

### 21. 非致命错误帧要「状态化」而非「输出化」

握手后的 relay-error（DEVICE_OFFLINE 等）非致命、连接不杀，但曾每帧 `console.error` →
手机端每次操作触发一次就在日志/界面刷一行，排障价值低、噪音大。改法：进排障日志
（dbgLog）+ `onRelayError` 回调，上层只在 status line 反映（离线/在线，业务帧到达自动
清回）；只有握手期 relay-error 才升级为连接失败。教训：非致命事件按「状态机 + 日志」
处理，不按「错误输出」处理。

### 22. 落库不依赖「连接就绪」：session_start 并发时序的静默丢失

真机复现：手机刷新不出会话。index 的 session_start（ensureClient，网络慢）与 tracker
的 session_start（建会话）并发，tracker 先跑时 client 仍 null，旧 `if (!c) return` →
会话永不落库、`sessions:list "active"` 恒空且无报错（静默失效比显式错误难发现）。改法：
建会话 + setActiveId 前置，push 才判空；链路改动必配事件级测试。

### 23. 真实 token 上跑诊断脚本会误杀 refresh token：并发 refresh 家族撤销

真实数据目录写临时脚本调 `getAccessToken`，与运行中 pi 进程并发 refresh 同一 token →
auth rotation 竞态，家族被撤销（401 INVALID_REFRESH_TOKEN），连接靠缓存 access token
苟活，过期须重登。方法：① 诊断脚本不调 refresh 系函数（验证 token 用只读解码看 exp）；
② 单飞只护单进程，跨进程并发 refresh 是设计风险；③ 副作用型验证一律隔离目录跑。

### 24. allowlist 精简不等于安全：手机端实际调用的 channel 必须对齐 desktop device-link 白名单

真机打开会话页/项目选择器，日志刷 `CHANNEL_NOT_ALLOWED`：`maker:goal:get-status`（手机轮询
goal 状态）、`maker:schedule:list`（轮询）、`notification:clear-session-attention`（清 attention）、
`fs:stat-path`（项目路径 stat）。前三个是「desktop 有实现、Pi 无对应功能」——摘除导致手机端
功能缺失 + 每帧报错刷屏，返回 desktop 空态即可（null / [] / void，mobile normalize 兼容）。
`fs:stat-path` 更关键：参考仓注释明写「channel 已在 device-link allowlist 内（经隧道在被控端
执行）」——**它设计上就允许被控端远程执行**，摘除是偏离契约。方法：删 channel 前先 grep 参考仓
确认 desktop 是否在 device-link allowlist（`ipcMain.handle` 注册 + 注释），再确认手机端是否实际
调用（relay-debug.log `CHANNEL_NOT_ALLOWED` 即直接证据）；「精简」应以消费方调用面为准，
不是以扩展自己实现面为准。

### 25. 「多进程共享数据」优先对齐 desktop 已解决场景，不自己发明锁

多 pi 进程同数据目录互踢（4409）不是新问题 —— desktop 端早解决
（device-link/ownership.ts 单持有者仲裁）。照搬思路：SQLite 单行表做
跨进程互斥凭据（first-wins + CAS 续期 + stale 接管），比自造 mkdir 原子锁
更硬（CAS 语义、busy_timeout 兜底、已有 586 行测试可平移）。教训：遇到
「多进程/多实例并发」类需求，先查 desktop 同仓实现，copy 而非发明。

### 26. 仲裁引入后：落库与推送必须解耦（standby 进程消息不落库 = 空白会话）

多进程仲裁后，standby 进程 `getClient()` 恒 null。tracker 原有代码把
`if (!c || !sid) return` 放在 handler 最前（v0.2 时 client 未就绪也跳过的防御）——
仲裁化后 standby 永远命中这个 early-return：消息不落库、shutdown 不归档，
每次 session_start 又建新会话 → 手机端刷屏一堆 active 空白会话。真机暴露。

**方法**：落库（写共享库）与推送（relay）是两件事，拆开判空——落库不依赖
client，push 才判 c。教训：任何「消息处理」handler 的结构应是
「先持久化，再判连接性推不推」，而不是「连接不存在就整体跳过」；
否则多进程/降级场景下本地状态会静默缺失，且无报错（比显式错误更难查）。

### 27. 「一次性迁移」的触发条件写死 `db 为空`：存量 db 让旧数据永久孤儿化

v0.3.0 JSON→SQLite 迁移的触发条件是 `sessions.json 存在 && db 为空 && 无 migration_done`。
SQLite 化上线当次，tracker 在迁移检查前先写了会话 → db 非空 → 迁移**静默跳过**，
`migration_done` 也不写。此后 27 会话/669 消息的旧 JSON 永远孤悬在外：代码不读、
手机端看不到、迁移也不再触发。清理旧 JSON 时对比才发现（id 全集不重叠）。

**方法**：迁移判定不应是「db 是否为空」这种脆弱代理，而应是「导入目标是否已含
源数据 id」（按 id 全集对比 / 幂等 INSERT OR IGNORE 后核对计数）；上线首日就要
验证迁移确实发生（对比源/目标行数与 id 交集）。教训：fail-open + 幂等标记≠真的
跑过——「迁移过吗」要能直接查询，不能靠条件隐式推断。

### 28. 未检出子模块里的协议常量：检出后即解锁能力位门禁，不必长期“文档化保留”

`SERVER_CAPABILITY_NOTIFY` 定义在 cindy-protocol 子模块（参考仓 `.gitmodules`），
此前未检出 → pi-cindy 的 notify 无条件发送（靠 relay-error 兜底）。技术债记录说
「留待子模块检出」——本次 `git submodule update --init cindy-protocol` 检出后
秒拿值 `'notify'`，client.notify 加 capability gate，双向确认：server 声明了才发，
旧 server 空集不发。同批确认 `PROTOCOL_VERSION = 1`（与 pi-cindy 一致，
hello-ack 版本校验不会误伤）。

**方法**：参考仓子模块是协议常量的唯一事实源；遇到「常量不可得」先试
`git submodule update --init`（几秒），拿到真实值比文档化兜底更可靠。

### 29. SQLite WAL 边车权限只在创建时刻继承主库 mode：chmod 主库不传播

`restrictDbFilePermissions` 只 chmod 主库文件。WAL 的 `-wal`/`-shm` 边车**仅在创建时刻**
复制主库 mode——全新安装：`new DatabaseSync` 建主库（umask 0644）→ `PRAGMA journal_mode=WAL`
写建边车（0644）→ 之后 chmod 主库 0600 对边车无效，未 checkpoint 帧（最近对话内容）
同机可读且崩溃后持久。评审发现，注释「边车继承主库权限」只在创建时刻成立。

**方法**：chmod 时主库 + `-wal` + `-shm` 一并收敛（边车可能未创建，ENOENT 静默吞）；
权限类修复要连「SQLite 会额外建哪些文件」一起想。

### 30. 多进程授权门禁必须轮询兜底：standby 改 settings，owner 无同步信号

`/cindy-revoke`/`/cindy-remote off` 在 standby 进程执行：settings.json 是共享文件能写，
但 `client?.closeLink/disconnectAllControllers` 是 no-op（standby 无 client）；owner 的
link-open 门禁只在**建立时**读黑名单、push 路径完全无门禁 → 被撤销控制器持续收到会话内容。
单进程场景命令自洽，多进程场景（v0.3.0 核心）静默失效。

**方法**：授权状态这类「跨进程共享、owner 才生效」的变更，owner 侧加定时重扫兜底
（`sweepRevokedControllers` 2s 轮询：revoked → link-close('revoked')，remote off → 全部
toggle-off）；push 路径不加每帧读文件的门禁（热路径），轮询足够。

### 31. startArbiter() 后同步判 isOwner() 恒 false：异步 tick 的时序陷阱

`arbiter.start()` 的首次 tick 是 `void this.tick()`（async），promote 在 microtask 之后——
紧接着的 `if (arbiter?.isOwner())` 永远 false。后果：单实例冷启动也显示
「standby (另一实例持有连接)」，`/cindy-connect` 在 `ensureClient()` 返回 null 后仍 notify
「Connected」（假在线）。功能靠 onAcquire 自愈，但状态线说谎、命令给错误反馈。

**方法**：状态展示/命令判定一律由仲裁回调驱动（onAcquire→owner、onStandbyChanged(true)→standby、
onDemote→非 owner），需要「等结果」的命令用 waitForOwnership(timeout) promise；不要同步轮询
异步状态的瞬时值。

### 32. 多进程共享库下「整行 read-modify-write」= 丢更新；node:sqlite 有版本门槛

两条独立教训同批修：
1. `updateSession` 曾 getSession → 全行 merge → 28 列 UPDATE：多进程共享库下 standby 的
   tracker 写（token/lastTurnEndedAt/archived）与 owner 的 mobile patch（title/pinnedAt/status）
   并发同行，last-writer 用陈旧快照覆盖对方字段。定点列 UPDATE（只 SET patch 列 + updated_at）
   后不同列并发写互不覆盖。多进程共享数据的写路径一律避免整行 RMW。
2. `node:sqlite` 自 Node 22.5 引入、22.23 稳定：顶层 `import { DatabaseSync } from "node:sqlite"`
   在老 Node 上模块加载即抛 ERR_UNKNOWN_BUILTIN_MODULE，整个扩展不可用（比 JSON 版更糟——
   JSON 版无版本要求，属升级回退）。顶层不做静态 import，getDb 内懒加载失败抛带版本的可读错误，
   package.json `engines` 同步声明下限。

### 33. 回调驱动状态改写必须重查「仲裁器已在运行」路径：session_start 重连曾依赖副作用

F3 把状态线从「startArbiter 后同步判 isOwner」改成回调驱动后，引入回归：`session_shutdown`
(new/fork/resume) 清空 client，但仲裁器仍在运行 → 下一次 `session_start` 的 `startArbiter()`
早退（`if (arbiter) return`）、`onAcquire` 也不再触发 → `ensureClient` 无人调用，relay 保持
离线直到手动 `/cindy-connect`。二轮 review 抓到（真实缺陷，非理论）。

**方法**：把「仲裁器生命周期启动」与「每次会话重连」解耦——启动只做一次，但重连动作要在
session_start/登录流里对「持有者」主动补连（`ensureAndNotify()` 统一 onAcquire 与既有
持有者两条路径）。凡把逻辑从「调用处内联」改成「回调驱动」，都要穷举回调不再触发的路径。

### 34. SQLite 损坏恢复：覆盖链 open→PRAGMA→DDL→quick_check，判据含 "not a database"

损坏库隔离重建（改名 `.corrupt-<ts>` 保留现场 + 重建）若只包 `new DatabaseSync`，三个坑：
①SQLITE_NOTADB 的消息是 **"file is not a database"**，`/corrupt|malformed/` 判据不命中 →
最常见损坏类逃逸；②DDL exec 在隔离块外 → 建表期暴露的损坏照样逃逸；③页面级损坏 header
完好，open 不炸、**首查才炸** → 需要 open 期 `PRAGMA quick_check` 全表扫描主动探测
（本地库 MB 级，开销可忽略）。quick_check 失败消息要带 `corrupt` 字样才能命中外层判据。
已知残余：运行中发生的页面损坏仍从查询冒泡（完整覆盖需查询层拦截，成本过高，文档化即可）。

---

### 35. 定向接管的核心是「让位语义」而非「抢」

handoffTo = 写交接信号（TTL 10s）+ 本地降级停续期（行保留等目标认领），目标实例才按 fastPoll
（1s）独占认领。若做成「目标直接抢」，TTL→stale 死窗（10s→15s）会让下一任接管整体延迟一个
staleMs；交接过期后按 heartbeatMs（而非 staleMs）放宽陈旧判定收敛。**认领必须清 handoff 字段**
（tryTakeover SET handoff_to=NULL）——否则目标接管后读到「自己的行 + fresh handoff_to」会误判为
awaiting 停续期 → 行过期 → 第三方接管（自损）。

### 36. 跨进程邮箱语义：落行归 owner、重放归宿主、失败不标 consumed

owner 落行（UNIQUE(session_id, client_id) 幂等）+ 定向接管；宿主接管后本地重放，失败不标
consumed（对齐 desktop agentHandoff peek 语义——否则交接永久丢失）。清理顺序敏感：
`clearHostAndArchiveForInstance` 必须先标邮箱 failed 再清 host（邮箱 UPDATE 的子查询依赖
host_instance_id 旧值，反序漏标 pending 行永久滞留）。合成投影必须复用现有 inputProjection 形状
零新字段——mobile isQueuedRemoteMessage 校验缺 chatMessage 会过滤掉整段 pendingQueue。

### 37. pid 探活只是加速信号，心跳是主判据

心跳新鲜 → 活；心跳过期 + pid 死 → 死；心跳过期 + pid 活 → 仍判活（GC 停顿 / IO 抖动不误杀）。
Windows pid 复用风险由心跳主判据兜底。

### 38. 跨进程测试 worker 崩 = 场景静默失败，先修解析再谈时序

`line.split(/ (.+)/)` 会吞掉剩余整串（capture 含首个空格后的全部）→ sid 带空格
INVALID_PARAMS → worker 未捕获异常退出 → 后续断言全崩但看不出谁崩。先切前缀再按首空格分；
worker 顶层加 try/catch 打标签日志。

### 39. 交接过期回落：renew 必须清过期 handoff 字段，且 reclaim 与 standby 放宽接管是竞态（自愈路径别带 C）

renew 只更 heartbeat 不清 handoff → reclaim 后行上残留过期 handoff_to → 所有 standby 永久走
handoffExpired→heartbeatMs 放宽阈值 → 健康 owner 被误抢（安全余量静默减半）。修：renew 用
CASE 条件清**过期** handoff（新鲜保留，不破坏「读行后 handoffTo 写入」竞态）。另：TTL 过期瞬间
owner reclaim 与 standby 放宽接管是真实竞态（谁先 CAS 谁赢，单 owner 收敛）——单测自愈路径
必须**不启动** standby（只有 A），否则断言 A 收回会随定时器相位漂移失败。

### 40. 死宿主预检对只读 get-projection 同样清 host + 标 failed：测试用会话要分离

dead-host 分支（清 host/邮箱 failed）对**所有** input:* 生效，包括只读 get-projection。
测试先 get-projection 再 enqueue 同一死宿主会话 → 第二次已是 unhosted → NOT_FOUND（看起来
像路由 bug，实为预检清理）。测试断言死宿主各分支用独立会话；get-projection 后补一条
「清 host 后 → NOT_FOUND」正是 M1 契约（错误可见，不静默空队列）。

---

### 41. 扩展热重载会泄漏旧模块实例的仲裁器定时器：同 pid 幽灵租约让新实例永久 standby

pi 的 `/reload`（`session.reload`）→ `resourceLoader.reload()` → `clearExtensionCache()`
→ 扩展模块**重执行**（新模块实例），但旧实例的 `setInterval` 不保证被清理（依赖
session_shutdown 事件送达 + 旧模块 stopArbiter 完整执行，任何一环失败即泄漏）。真机复现：
一次会话内 9+ 泄漏仲裁器同进程共存，最早那个持续续期所有权行（heartbeat 恒新鲜），
新实例看到「同 pid、非己 ownerId」的租约 → 永远 standby——`/cindy-status` 显示
「standby (另一实例持有连接)」但机器上根本没有第二个 pi 进程；且持有者是幽灵（无 relay
连接），手机端实际 DEVICE_OFFLINE。DB 里 lease 新鲜 + 无 relay socket + 日志停写
三症状同时出现即本场景。

**方法**：双管齐下，缺一不可：①`runTick` 的 standby 分支加 `sameProcessLease` 判定
（`row.ownerPid === process.pid` 且非己 → 重载幽灵租约，无有效交接信号即 CAS 立即接管，
不等 staleMs——幽灵会持续续期，等 staleMs 永远等不到）；②进程级仲裁器注册表
（globalThis，跨模块实例存活）：新模块 `startArbiter` 先 `takeOverProcessArbiter` 取走旧
bundle 并 `dispose`（停仲裁器 + sweep + 实例心跳，**不关 DB**——新实例还要用），再注册
自己的。①单独用会互抢翻转（两个活仲裁器互相接管），②单独用挡不住「新实例刚启动、
旧实例还没停」窗口内的误判——两者配合才安全。跨进程互斥仍由 SQLite 单行 CAS 保证，
注册表按进程隔离。

---

### 42. 刷新/登录响应的 token 对必须防御性校验：畸形响应直接覆盖 session.enc = 永久登出

真机复现：运行中刷新响应返回 `refreshToken: "rt"`（2 字符，服务端异常/端点漂移时），
代码无条件 `saveSession` 落盘 → 好 token 被垃圾冲掉 → 此后所有刷新 401
INVALID_REFRESH_TOKEN → relay 永不连接，只能手动重新登录。排查特征：`/cindy-status`
显示连接失败但登录态仍在（session.enc 存在）、`curl` 直测 refresh 端点 401、解密
session.enc 看到短 token。

**方法**：①新增 `isValidTokenPair`（access/refresh token 均为 ≥16 字符的非空串）——
畸形响应在 `getAccessToken` 返回 null **不落盘**（保留现状，靠重登恢复），`savePair`
登录/换码路径同样拒绝；②401 INVALID_REFRESH_TOKEN 判定为「token 家族已死」→
自动 `clearSession()` 让 isLoggedIn() 变 false，UI 进入登出态提示重登（瞬态网络错误
fetch failed / timeout 不清——避免断网误登出）。诊断命令：解密 session.enc 看 token
长度 + 直测 `/api/auth/refresh`。

---

### 43. 死宿主清理必须按会话反查：实例行被删后，sweep 遍历 cindy_instances 永远看不到孤儿会话

真机复现：手机端 sessions:list "active" 显示 12 个会话，实际只有 1 个是当前活进程的——
其余 10 个 host 指向已死实例（1451a4cf）、1 个 host 已空。死实例行为何消失？优雅退出/重载
路径 `releaseInstance` 只 DELETE 实例行不归档会话；而 `sweepStaleInstances` 只遍历
`cindy_instances` → 实例行没了 → sweep 永远扫不到它 → 其会话永久 active。router 死宿主
路径（host 死 → 清 host + 邮箱 failed）也**只清 host 不归档** → host=NULL 的 active 孤儿。
两层漏网让死会话无限堆积。

**方法**：sweep 增加按会话反查（不依赖实例行存在）：`SELECT id, host_instance_id FROM
sessions WHERE status='active'`——host 不在活实例（含实例行已删）→ `clearHostAndArchive
ForInstance(host)`；host 已空 → 直接标 archived。当前进程会话 host=本进程活实例不受影响；
pi 重启 resume 由 tracker session_start 重新激活。诊断：查 `sessions` 的 status + host 分布
对比 `cindy_instances` 活实例。

### 44. 手机端 `/` palette 是三 channel 并行拉取，缺一路即 CHANNEL_NOT_ALLOWED 顶掉整个命令面板

真机复现：手机端打开 `/` 命令面板直接显示 `channel not allowed maker:list-agent-commands`。
根因：`[sessionId].tsx` / `new.tsx` 用 `Promise.all` 并行拉 `list-agent-commands` +
`list-agent-skills`（+ sessionId 页还有 `list-desktop-commands`），三路全是 invoke channel
——任一 reject（CHANNEL_NOT_ALLOWED 是 invoke error，不是 `{success:false}` 响应）→
withTransientRemoteRetry 重试 + palette 错误文案顶掉缓存行。契约（composerPalette.ts）：
builtin=`{kind:'agent-builtin',name,description}`、skill=`{kind:'agent-skill',name,description?,
source:'user'|'skill',path?,scope?,enabled?}`、desktop=`{kind:'desktop',...}`；失败必须返回
`{success:false,error,...}` 而非抛 invoke error（invoke reject 会触发重试刷屏）。

**方法**：数据源用 pi 顶层 `pi.getCommands()`（ExtensionAPI 同步方法，返回当前会话已注册
extension 命令 + prompt templates + skills，信任/重载状态与 pi 一致——比自研扫目录准）：
extension→agent-builtin；prompt+skill→agent-skill（pi prompt 映射 source='user'，skill 映射
'skill'，名保留 `skill:` 前缀对齐 pi `_expandSkillCommand` 的 /skill:name 识别）；desktop 空清单
（pi-cindy 无 main 进程命令）。getCommands 缺失/抛错（老 pi）→ 容错空清单 success:true，
手机端得空面板而非错误。（问题记录 #62）

### 45. 测试隔离只覆盖了 SQLite，token-store 硬编码真实路径 —— 每次 npm test 删真实登录态

用户报“每次启动 pi 登录态都丢，需重新登录”。排查 relay-debug.log 无 auth 痕迹（auth 本不
打日志），但发现冒烟测试 20b 段（token 防御校验）的 logout/saveSession/畸形/401 全链路操作
作用在**真实 `~/.pi/cindy-sync/session.enc`**：token-store.ts 的 DIR 硬编码，不走
`PI_CINDY_DATA_DIR`（db.ts/session-store 都走，唯独 token 漏网）；测试文件头注释宣称
“store 隔离”实际只有 SQLite 隔离。真实时间线：17:51 登录成功 → 17:54 跑测试 → 设备离线 →
session.enc 消失。同理 dbg.ts 也硬编码日志路径，测试进程把 mock 端点（auth-cn.test）日志
写进真实 relay-debug.log，干扰排查（日志里 16:17/17:42/17:54 的 test 端点行全是测试）。

**方法**：① token-store.ts DIR 改 `PI_CINDY_DATA_DIR ?? ~/.pi/cindy-sync`（与 db.ts 同源），
测试隔离目录内自由写删 session.enc；② dbg.ts 同样尊重 PI_CINDY_DATA_DIR（测试日志不再
污染真实）；③ auth-client refresh 全路径补 dbgLog（refresh ok / malformed n/3 / 401
clearing session / failed）——此前 clearSession 无任何日志，删因只能靠猜；④ 冒烟测试加
隔离回归断言：8 段快照真实 session.enc 字节，20b 段尾比对（存在性 + 内容），任何写/删
即失败。教训：**“隔离”是每类存储的承诺，不是目录的一个开关**——新增持久化路径时必须
同步检查测试是否可达真实路径（db.ts / token-store / dbg.ts / settings-store 四处同源）。

### 46. review-swarm 四审二轮：高置信度问题清单与落地（含契约对证参考仓结论）

v0.5.2 未提交变更经 review-swarm 四路审阅（意图回归/安全隐私/性能可靠/契约覆盖）后，
高置信度问题全部修复，均在本轮：

- **savePair 不复位畸形计数**（M1）：计数仅成功/401/登出复位，登录/换码入口（savePair）
  漏——旧 streak 残留时重登后首刷畸形即误触上限清掉新会话。修：savePair 复位计数。
  教训：**模块级状态计数器的复位点必须与计数增长点同源枚举**（增长在 refresh 闭包，
  复位却散落四处，漏一处即成隐性状态泄漏）。
- **savePair 不 bump cacheGeneration**（L6，同进程 refresh 竞态）：登录与在途刷新并发时，
  旧刷新完成会覆盖新会话。修：savePair bump cacheGeneration（与 logout 同语义）。
  跨进程版本仍开放（未完成块：refresh 互斥）。
- **畸形×3 清会话不清内存缓存**（L1）：与 401 分支不对称。实际无服务窗口（刷新只在缓存
  过期后发起，×3 时缓存必已过期），纯一致性收口。修：置空 cachedToken/cachedExp。
- **dbgLog 失败分支打 err.message**（L3）：AuthApiError.message = 服务端响应体前 200 字符，
  错误响应若回显请求体（refreshToken/deviceId 在 POST body 里）会泄进 relay-debug.log。
  修：只打 code/status 或错误类型。教训：**日志字段要先问“这段文本哪来的”，响应体
  回显是 token 泄密常见路径**。
- **palette 行级零校验**（L4）：getCommands 返回行整体 cast，单行 null 致 .filter TypeError
  → 整面板 error。修：逐行过滤非对象。
- **测试路径硬编码**（L5）：真实 session.enc 快照路径硬编码 `~/.pi/cindy-sync`，DIR 逻辑
  一旦迁移快照静默校验错路径恒过。修：token-store 导出 DEFAULT_DIR，测试同源引用。
  教训：**测试里“真实路径”必须从被测模块导出，不能手抄**。
- **契约对证（M2）结论：无代码改动**。参考仓
  `/home/mellow/文档/codes/github/cindy`：`ComposerSlashCommand.scope?: string` 是未定型
  字符串（非联合），pi 的 user/project/temporary 透传安全；`source: 'user'|'skill'` 联合与
  prompt→user 映射一致；三源结果形状 `{success,error?,commands?/skills?}` 与实现吻合。
- 冒烟断言：260→285（palette +13、畸形 +9、隔离 +3；null 行 +2、成功复位 +3 在本轮）。
  未落地项：畸形计数无时间窗（L2，review 二轮提议）——刷新节奏约每小时一次，3 连 ≈ 持续
  故障，跨天累计需服务器每次刷新窗口都畸形，概率低；加窗属设计取舍，暂不改，留作已知局限。
  multi-process.test.js 偶发超时（场景2 接管 ≤2s 计时敏感，机器负载下 flake，standalone
  重跑全绿）——非本 diff 引入，未处理。

### 47. 子 agent（Agent 工具）会话：独立 runner 重新实例化扩展 + 仲裁器劫持

pi-subagents 用 `createAgentSession` + `SessionManager.inMemory()` 在主进程内建子会话，
`bindExtensions` 为子会话建独立 extension runner 并**重新 emit session_start** —— 本扩展在
子 agent 会话里再次实例化，tracker 曾把子会话落库推手机（会话列表噪音）；且子 agent 实例
`startArbiter()` 会 `takeOverProcessArbiter` 停掉主实例仲裁器 → 主实例降级断 relay。
**判定信号**：`ctx.sessionManager.isPersisted() === false`（主会话恒持久，in-memory 只出现在
SDK 子会话；配置 `persistSession` 的自定义 agent 除外，接受漏判）。
**教训**：任何 `session_start` 处理器都要考虑子 agent 场景（独立 runner 重入）；子 agent
的 activeId 保持 null 后，其消息/归档/推送自然跳过，无需逐事件过滤。

---

## 附录：问题记录（原 ISSUES.md #1-62）

> 2026-08-06 · ISSUES.md 已删除并入本文件。问题表为历史快照（根因/修复/验证），
> 教训类内容见上文踩坑 #1-45；本附录保留细节供回溯。
> 2026-08-07 · 追加 #57-61（会话路由 v0.5.0）。2026-08-08 · 追加 #62（palette，见踩坑 #44）。

# pi-cindy 问题与经验记录

> 2026-08-06 · 三轮：① review-swarm 评审（commit 105be51 vs cindy 参考实现）+ 全量高置信修复；② 真机验证暴露问题（选不了模型 / 发消息收不到）+ 修复，测试入库；③ review-swarm 对拍提交版（6e95b4c）剩余契约缺口 + 可靠性/安全修复（#33-56）

## 评审背景

> ⚠️ 2026-08-06 · 评审期间 git 历史经 squash 改写，`105be51`/`105be5165c`/`6e95b4c` 均不可寻址（`git cat-file` 失败）。当前可复核基线 = `f620fd5`（feat: pi-cindy 全量提交，含三轮修复后代码，`git tag v0.1.0` 锚定）。下文旧 hash 仅保留历史描述。

对 `105be5165c`（feat: pi-cindy）做只读 review-swarm：4 个 reviewer（意图回归 / 安全隐私 / 性能可靠性 / 契约覆盖）并行对照 `/home/mellow/文档/codes/github/cindy` 参考实现，产出 ~25 条 finding，过滤后 23 条有效，其中 3 条 P0、7 条 P1。随后按「修复所有高置信度问题」目标全部落地并验证。

核心结论：**扩展骨架与协议核心（信封格式、端点、认证流、hello、WS 路径、push 频道名）对齐良好，但与当前手机端 App 不兼容**——手机端已全面切换到输入队列架构、时间戳契约是 ISO 字符串，这两点让核心功能（发消息、列表渲染）直接失效。

---

## 已解决问题（按严重度）

### P0：功能不可用

| # | 问题 | 根因 | 修复 | 验证 |
|---|---|---|---|---|
| 1 | **post-handshake 帧全丢**：手机端 link-open 无 link-accept、invoke 全超时，被控功能瘫痪 | `ws.off("message", onMsg)` 在 hello-ack 分支摘掉唯一消息监听器；else 分支的 `readyHandler` 转发不可达（死代码）。提交版：onReady 在 connect 后挂 socket，首连可用、重连后死；工作区"修复"只改了挂载时机没删 `ws.off`，**首连即死** | message 监听器存活整个 socket 生命周期；hello-ack 只切状态（重复 ack 防御性忽略）；业务帧统一走 `readyHandler` | 冒烟：link-open→link-accept、invoke→result 均达 |
| 2 | **手机端发消息/停止/转向全挂** | 手机端会话页（`app/sessions/[sessionId].tsx`）**只**用 `maker:input:enqueue/stop/steer/get-projection`，扩展只实现 legacy `maker:send/steer/abort` → `CHANNEL_NOT_ALLOWED` → 消息进 outbox 失败态 | 实现输入队列：pendingQueue + steeringQueueClientIds + queueAbortPending + error 投影；`maker:input:projection` push 回流；空闲立即注入、运行中排队、agent_settled 冲刷 | 冒烟：空闲注入/排队/flush/stop 全过 |
| 3 | **会话/消息列表渲染崩溃** | 时间戳输出 `Date.now()` 毫秒数字；mobile 契约 `RemoteSession.createdAt` 等为 `string`，排序走 `.localeCompare()` → TypeError | sessions/messages 输出层统一 `new Date(n).toISOString()`；store 内部仍存毫秒 | 冒烟：list 输出全部 ISO 字符串 |

### P1：连接生命周期

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| 4 | `/cindy-logout`、`/cindy-disconnect`、`session_shutdown` 失效，5s 自动复活 | close 事件异步晚于 `disconnect()`，其 handler 无条件 `scheduleReconnect(5s)`；无 stopped 标志（参考 `client.ts:1247` 有守卫） | `stopped` 标志：disconnect 置位，close handler / scheduleReconnect 均检查；stopped 时 close 同时 settle 在途 connect promise |
| 5 | cn 账号连 global relay 401 死循环 | `ensureClient()` 默认 realm "global"，session_start 自动重连不传存储 realm；`getAccessToken` 缓存不区分 realm | realm 从 `loadSession()?.realm` 派生 |
| 6 | 同 deviceId 双连接 4409 互踢 | `ensureClient` 替换 `client` 前不 disconnect 旧实例；并发调用无 single-flight | 替换前 `disconnect()` + 模块级 `ensurePromise` 单飞 |
| 7 | relay 不回 hello-ack 时 `connect()` 永久挂起 | 握手超时在 `ws.on("open")` 即清 | watchdog 保持到 hello-ack/relay-error；超时 close（走重连路径）+ reject |
| 8 | 坏 token 无限 5s 重连风暴 | 固定 5s 无退避无逃生；401 后 `getToken` 返 null → reject → 又 schedule | 指数退避 1s→30s + jitter；401/403/4401 停止重连 + `onAuthFailed` 上报（`/cindy-status` 显示） |
| 9 | `sessions:list` 无界返回、status 过滤失效 | 手机端按位置传 `[limit, status, {includePinned}]`，扩展把 `args[0]`（数字）当 filter 对象 | 位置参数 + clampLimit(20) + status 枚举过滤 + 置顶合并 |
| 10 | 加载更早消息/补尾部返回空 | `before/after` 是**消息 ID 游标**（desktop 先查行定位），扩展当毫秒时间戳比（UUID vs number → NaN） | 按 id 解析到行取窗口；`beforeTs` 毫秒兜底；clearedAt 边界 |

### P2：契约与安全

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| 11 | push 双发 + 广播 + 无 topic 路由 | 逐 controller 发 + 无 dst 广播（参考从不发无 dst 业务帧）；无视 sessionId 参数 | `device-link:subscribe/unsubscribe` 真实管理订阅表；`topicForPush` 路由（列表级→`sessions`，会话级→`session:<id>`），只发订阅者 |
| 12 | 通知点击导航失效 | deepLink `cindy://devices/{id}/sessions/{sid}`；desktop 用 scheme 无关路径 `/sessions/{sid}?deviceId={id}`（`mobileNotify.ts:58`） | 对齐 desktop 路径格式 |
| 13 | relay-debug.log 隐私泄漏 | `appendFileSync` 默认 0644 全用户可读、不轮转、记录消息正文；"删文件即关"不成立（append 重建） | 0600 + chmod 收敛存量 + 1MB 截断 + 真开关（删文件即关，`PI_CINDY_DEBUG=1` 兜底） |
| 14 | `maker:event` 状态推送是死推送 | 手机端 `applyMakerEvent` 无 `status_changed` 分支，payload 形态不符（期望 `{sessionId, event, persistId}`） | 改推手机端消费的 `local-db:sessions:activity` + `maker:status-changed`(closed) |
| 15 | `patch-meta` 越界 | 允许 4 字段含 `summary`、无 status 枚举/title 类型校验；参考仅 status(枚举)/title/pinnedAt | 字段白名单 + 校验，非法抛 `INVALID_PARAMS` |
| 16 | logout 登出错区 | 恒打 global 端点，cn 会话登出无效 | 按 `loadSession().realm` 选端点 |
| 17 | busy 恒空闲 | hello `busy:false` 硬编码、无 presence-set | `setBusy()` → presence-set；turn_start/agent_settled 同步；hello 报真实 busy |
| 18 | token 加密 = 混淆 | key = sha256(hostname:username)，无秘密材料，本机可复现 | 文档化威胁模型：真实边界是 0600，更强保护需 OS keyring |
| 19 | 每消息 3 次全文件同步 IO | message_end 里 appendMessage + 2×updateSession + getSession 重读 | 合并为单次 updateSession，用返回值，去掉重读 |

---

## 真机验证暴露的问题（2026-08-06 晚，手机同步会话列表后「选不了模型 + 发消息电脑收不到」）

### 背景

上一轮修复后真机可同步会话列表（push/sessions:list 通），但会话页卡在两处：**模型选择器空**、**发送的消息电脑收不到**。`relay-debug.log` 关键证据：手机端会话页只走到 `get-capabilities` + `provider:list`，**从未发出过 `maker:input:enqueue`** —— 发送被前置步骤（模型解析）卡死，而非发送本身坏了。

### P0：功能不可用

| # | 问题 | 根因 | 修复 | 验证 |
|---|---|---|---|---|
| 20 | **手机选不了模型** | `get-capabilities` 返回字段与 mobile `normalizeMobileAgentCapabilities` 完全不符：缺 `availableModels`/`effortLevels`、`permissionModes` 是裸字符串数组、`planMode` 是布尔。normalize 读固定字段名，缺字段 → 空数组，**不报错不崩溃，静默空** | 输出 mobile 契约形状（ModelDescriptor[]/EffortDescriptor[]/{id,displayName}[]/hasFastMode/planMode:{supported}/supportsSessionAgentSwitch:false）；模型清单从 `ctx.modelRegistry.getAvailable()` 派生 | 冒烟：normalize 各字段非空、形状正确 |
| 21 | **手机发消息电脑收不到** | 双因叠加：① `pi.sendUserMessage` 返回 **void**（非 Promise），`inputQueueFlush` 里 `.catch()` 链在 void 上**同步抛 TypeError** → enqueue invoke 报错 → 手机 outbox 失败态（消息可能已注入 → 双发风险）；② 模型选不了（#20）把发送流程卡在前置 | ① try/catch 包同步调用，注入前 apply item.model/effort（setModel/setThinkingLevel，解析失败不阻塞）；② 修 #20 | 真机：enqueue "来自手机" → 落库 + agent 回复 + 会话 model 变 deepseek-v4-flash |
| 22 | **stop/中断/压缩无效** | ExtensionAPI 顶层**没有** `abort/compact/isIdle/getContextUsage/modelRegistry`（只在 session 的 ExtensionContext 上），`pi().abort?.()` 恒 undefined 静默 no-op | 新模块 `src/runtime.ts`：tracker `session_start` 捕获 ctx 动作（**在 client 检查之前**，首次连接在途不丢）；stop/steer/abort 走 `abortRuntime()` | 冒烟：inputStop/abortSession 触发 ctx.abort |
| 23 | **list-available-agents 返回形状错** | 返回 `{agents:[...]}`；mobile 契约是 `MobileAgentKind[]`（数组，desktop `maker.listAvailableAgents()` 返回 `AgentKind[]`） | 返回 `["pi"]` | 冒烟：数组 + 长度 1 |

### P1：契约与展示

| # | 问题 | 根因 | 修复 | 验证 |
|---|---|---|---|---|
| 24 | **会话 model 存 `provider/id` 拼接** | tracker 存 `${provider}/${id}`，与 `availableModels.id`（纯 id）不匹配 → `currentModel` 恒 null → 会话打开后模型选择器无选中行 | 存 `ctx.model.id` + `providerId` 分离；新增 `model_select` 事件 → 同步 sessions:patched 推送 | 冒烟/真机：会话 model 与 availableModels.id 匹配 |
| 25 | **createSession 默认模型是假 id** | 硬编码 `claude-sonnet-4-6`（不存在） | 回落 modelRegistry 首模型 | 冒烟 |
| 26 | **regenerate-title 参数崩** | `args[0]` 是 `{sessionId}` 对象，原 `sid.slice(0,8)` 抛 TypeError | 兼容字符串/对象两种调用 | 冒烟 |
| 27 | **其余 input 通道缺失** | 手机端常规路径还调 `compact/resume/retry-last-error/clear-error/remove/update-text/update-content/move/set-expanded/set-interaction-lock/set-edit-lock/clear-session` → `CHANNEL_NOT_ALLOWED` | 全部实现：remove/update/move/clear 真实队列操作，compact 走 ctx.compact，锁 no-op，均返回投影 | 冒烟：move/updateText/remove/setExpanded/compact/clearSession |
| 28 | **provider 目录辅助接口缺失** | `maker:provider:list`/`usage:model-pricing`/`api-key:present` → `CHANNEL_NOT_ALLOWED`（日志噪音 + 模型选择器 provider 探测依赖） | provider:list 返回空 providers（手机端 0 供应商时**设计内**回退 capabilities 扁平列表）；pricing 返回 {}；api-key 返回 {present:false} | 冒烟：router 可达、不报错 |

### 需求项

| # | 问题 | 根因 | 修复 | 验证 |
|---|---|---|---|---|
| 29 | **模型列表过多 + 无区分度** | 全量 `getAvailable()` 含同 id 多 provider 重复条目；displayName 无 provider，同名难区分 | 白名单（`ctx.scopedModels`，--models/enabledModels）非空 → **只列白名单**（pin 的 thinkingLevel 作该模型 defaultEffort）；未配置 → 全量按 id 首见去重；displayName 前缀 provider 展示名（name 已含则不重复拼） | 冒烟：白名单 2 条 / 全量去重 5→4 / 前缀不重复 |

### 测试管理

| # | 项 | 说明 |
|---|---|---|
| 30 | **冒烟测试入库** | `tests/smoke.test.js`（45 断言）合并本会话全部用例；`npm test` 运行；jiti devDep 与 pi 运行时同版本（2.7.0） |
| 31 | **store 测试隔离** | `session-store.ts` 支持 `PI_CINDY_DATA_DIR` 环境变量；测试写临时目录，不污染真实 `~/.pi/cindy-sync`（首版临时测试真写过真实 store） |
| 32 | **typecheck 真实化** | `tsconfig.json`（strict + NodeNext + noEmit）+ devDeps `@earendil-works/pi-coding-agent@0.83.0`/`typebox`；`npm run typecheck` 零错误 |

---

## 第三轮评审修复（2026-08-06，review-swarm 对拍提交版 6e95b4c vs cindy 参考实现）

### 背景

第二轮修复落地后对提交版（6e95b4c，即 105be51 之后的正式提交，现已不可寻址，见上方注记）做只读 review-swarm。前两轮修的是「首连即死/发送路径/模型选择」，本轮暴露的是一批**提交版里没被前两轮覆盖的契约缺口**：手机端乐观管线依赖的 id 透传、分页返回顺序、消息 clientId、队列投影完整字段、push 截断标记；加上可靠性/安全层（半开连接、原子写、路径穿越、无限重连）。4 个 reviewer + 主 agent 对拍 mobile 消费方源码逐一验证后全部落地，测试 45→79 断言。

### P0：功能不可用

| # | 问题 | 根因 | 修复 | 验证 |
|---|---|---|---|---|
| 33 | **手机端新建会话必失败** | mobile `newSessionCreation.ts:594` 预生成 session id 传 `createSession(opts.id)` 并要求被控端采纳（乐观行/路由/订阅全 keyed by 该 id），不符即抛 `sessionIdNotAdopted` 确定性失败；扩展自造 randomUUID 忽略 opts.id | create-session 透传 `opts.id`（同 id 幂等复用，对齐 maker-core）；返回 `{sessionId, agentKind, workDir}`（对齐 `normalizeCreateSessionResult`） | 冒烟：同 id 二次调用幂等、只推一次 sessions:created |
| 34 | **手机端历史分页/翻页全错** | `messages:list` 契约是 `ORDER BY createdAt DESC`（最新在前）；扩展返回升序——注释写了「desktop 恒返回降序」实现却是 `slice(-limit)` 升序，注释与实现自相矛盾。mobile `historyWindowGap.ts:147` 明确「必须保持服务端返回顺序…最新在前、页尾最旧」，分页游标按此计算 | 输出恒降序：before/默认取最新窗口反转；after 游标分支对齐 desktop（ASC 取最旧端再反转） | 冒烟：默认/limit/before/after/beforeTs 五分支序全对 |

### P1：契约

| # | 问题 | 根因 | 修复 | 验证 |
|---|---|---|---|---|
| 35 | **`messages:around` / `around-client-id` 通道缺失** | mobile `mobileMakerTransport.ts:629-631`（消息引用跳转、回绕加载）、`sessionReferences.ts:659` 调用；扩展 ALLOWED 无 → `CHANNEL_NOT_ALLOWED` | 实现两通道：锚点（id/clientId）+ radius 前后窗口（默认 60/上限 200）+ clearedAt 边界 + contentCharLimit 截断；锚点缺失抛 NOT_FOUND（对齐 desktop throwIpcError） | 冒烟：radius=1 三行锚点窗口、router 可达、缺锚点 NOT_FOUND |
| 36 | **队列投影 pendingQueue 整段被过滤 → 手机队列 UI 空** | mobile `isQueuedRemoteMessage`（inputProjection.ts:297-307）校验 `clientId/text/persistedContent/model/workingDir/createOpts/chatMessage.role==='user'` 全字段；扩展投影项只有 clientId+text → 全被 `readQueuedMessages` 丢弃 | `readQueueItem` 透传 persistedContent/model/effort/permissionMode/workingDir/createOpts/**chatMessage**；附件（files/images）显式抛 INVALID_PARAMS 而非静默丢弃 | 冒烟：投影项过 isQueuedRemoteMessage 全字段校验；附件拒绝且不注入 |
| 37 | **消息落库/推送缺 `clientId` → mobile 误判「消息未应用」** | mobile `isFirstMessageApplied` 按 clientId 匹配本地行/投影/消息列表；扩展 appendMessage 用新 randomUUID、无 clientId → 三路全不中 → 首条消息被当失败处理（重发风险）；desktop 落库带 clientId 且 `(sessionId, clientId)` 唯一索引幂等 | PiMessageMeta 加 clientId；tracker message_end(user) 从 `getSteeringClientId(sid)` 透传（队列注入的 item clientId）；messages:list/around/push 输出带 clientId | 冒烟：list 输出 clientId 字段 |
| 38 | **assistant push 截断被 mobile 当完整内容** | push 只带 `text.slice(0,500)` 且无截断标记；mobile `preferCompleteMessage` 只对 `agentMeta.remoteContentTruncated === true` 的行保留完整侧/触发按需拉全文（desktop dispatch.ts:1830 同名契约）→ 手机端永久显示截断 | 截断时 push `agentMeta: { remoteContentTruncated: true }`；store 仍存全量 | 冒烟：截断分支带标记 |
| 39 | **`usage:session-tokens-changed` key 错** | 推送 `{sessionId, totalTokenUsage}`；mobile `remoteSessionStore.ts:2161` 读 `payload.totalTokens` → 恒 null → token 芯片永不更新 | key 改 `totalTokens`（spend-changed 的 totalCostUsd 本就正确） | 冒烟/代码核对 |
| 40 | **session_shutdown 泄漏 active 会话** | index.ts 注册 disconnect+null **在** attachSessionTracker 之前；Pi 按注册序 await → tracker 的归档/推送（sessions:patched archived、maker:status-changed closed）拿 null client 全跳过 → 每次 `/new`/`/resume` 留一行 active | 注册顺序反转：tracker 先归档推送，index 再断开 | 冒烟：注册序（代码结构） |
| 41 | **inputStop 忽略 opts + 空闲卡死** | mobile `stopOptionsForProjection` = 有队列时 `{keepQueue:true, pauseQueue:true}`；扩展只 abort + 置 abortPending，且空闲时 abortPending 无人清（等 agent_settled）→ 投影卡「停止中」 | opts 支持：keepQueue 保留队列、pauseQueue 置暂停态（resume 恢复）、无 keepQueue 清队列；`isRuntimeIdle()` 时立即清 abortPending | 冒烟：keepQueue/pauseQueue/resume/空闲清 |
| 42 | **enqueue/steer/send 注入串会话** | 扩展从不归档（#40 泄漏）+ 所有行 status active → mobile 可对任意历史会话 enqueue；`sendUserMessage` 只注入 Pi **当前前台**会话 → 消息进错会话、行记在目标 sid 下 | InvokeContext 加 `activeId`；enqueue/steer/send 校验 sid === 前台会话，否则 NOT_FOUND | 冒烟：非前台拒绝、前台通过 |
| 43 | **interrupted-pending 恒报「疑似中断」** | `getInterruptedSessions` 用 `userSendAt != null` 当中断信号；turn_start 置 userSendAt、agent_settled 不清 → 每个用过会话永真。desktop 语义 = `activeTurnStartedAt > lastTurnEndedAt` 且仅启动首拉消费 | PiSessionMeta 加 activeTurnStartedAt/lastTurnEndedAt；turn_start 置 startedAt、agent_settled 置 endedAt；ackInterrupted 写 endedAt 消化；mapSession 透传两字段（unix 毫秒 number，非 ISO） | 冒烟：正常不命中 / startedAt 无 endedAt 命中 / endedAt 后熄灭 |

### P2：可靠性/安全

| # | 问题 | 根因 | 修复 | 验证 |
|---|---|---|---|---|
| 44 | **半开连接僵尸** | 只发 ping 不数 pong（`case "pong": break` 丢弃）；睡眠/NAT 超时/切网无 close 事件 → connected 恒 true、mobile 看到在线但 invoke 全超时、push 无限堆积 | pong 计数：连续 3 次未收 pong → `ws.terminate()` 走重连（对齐参考 startHeartbeat pongMissLimit） | 代码核对 |
| 45 | **握手后 relay-error 致命化** | 消息监听器对任何 relay-error 都 `ws.close()` + reject → 单帧错误（如超限）杀整连接；参考按 pending 请求处理不杀连接 | 握手期 relay-error 才终止；已握手后路由给 handler 记录 | 代码核对 |
| 46 | **迟到 socket 事件覆盖新连接** | `doConnect` 替换旧 socket 后，旧 close/error 异步落地到共享 `this` → connected=false、清空新连接的 controllers/subscriptions、触发多余重连（参考 connEpoch 守卫） | connEpoch 代数：closeSocket 自增、doConnect 在 closeSocket 后捕获新代数，旧事件按代数丢弃；stopped 优先 settle 在途握手 | 冒烟：断连/重连路径（帧级模拟） |
| 47 | **token 刷新失败无限重连** | 刷新失败 `getAccessToken` 返 null → `doConnect` 抛「No access token」→ `scheduleReconnect` catch 无条件再排 → 30s 循环永续；authFailed 只在 ws 层 401 置位，刷新层失败不置位、onAuthFailed 不触发 | token 缺失即置 authFailed + onAuthFailed；scheduleReconnect catch 检查 authFailed 停止 | 冒烟（帧级模拟 401 路径） |
| 48 | **refresh 无 single-flight + logout 竞态** | 并发 getAccessToken 并行刷新同一 refreshToken → 轮转竞争（第一个消耗旧 RT、第二个被拒）；logout 后**在途**刷新完成会把 session.enc 写回 → 登出变复活 | 模块级 refreshInFlight 复用；cacheGeneration 代数：logout 递增，刷新完成时代数不符不落盘 | 代码核对 |
| 49 | **崩溃静默清空 store** | `saveStore/saveMsgs` 直写活文件，kill -9/断电中断 → 半写 JSON；`loadStore/loadMsgs` catch 后返回空 → 从空 store 静默重启，全部会话/消息丢失 | 原子写（tmp + rename）；解析失败把损坏文件改名 `.corrupt-<ts>` 保留，不静默覆盖 | 冒烟：无残留 tmp、文件完整 |
| 50 | **sessionId 路径穿越** | `msgsFile(sid)` = `path.join(MESSAGES_DIR, sid+'.json')`，sid 来自不可信 invoke 入参；`../../x` 可读写任意 .json（参考是 SQLite 无此攻击面） | `requireSafeSid`：`^[A-Za-z0-9-]{1,64}$` 白名单，非法抛 INVALID_PARAMS；listMessages/messages:list 全走该闸口 | 冒烟：`../../etc/passwd` 拒绝 |
| 51 | **get-session-tree 伪造数据** | 无 Pi 原生分支树 API，返回单节点假树 + navigate no-op；mobile `piSessionTreeModel` 过形状校验后把假数据当真分支渲染 | 摘除两通道 + 能力位 `sessionTree: {supported:false}`（mobile 隐藏入口）；DESIGN.md 同步 | 冒烟：router 拒绝 CHANNEL_NOT_ALLOWED |
| 52 | **list-active 形状不符** | 返回 `[{sessionId, workingDir}]`；mobile `MobileActiveSessionSnapshot` 期望 `{sessionId, agentKind, workDir, capabilities, isTurnRunning}`（desktop register.ts:10936 同形） | 补 agentKind:'pi'/capabilities/isTurnRunning（isRuntimeIdle 派生） | 冒烟：形状断言 |
| 53 | **附件静默丢弃** | `readQueueItem` 只留 text，files/images 被丢 → 手机显示已发送、内容缺失 | 显式抛 `INVALID_PARAMS("Attachments are not supported on Pi host")`，手机端可见错误 | 冒烟：附件拒绝 |
| 54 | **stray 文件入提交** | 提交夹带 `cli-configs/telegram-cli/session.session`（二进制凭据，每次 telegram-cli 运行都变）+ `CodingPlan/opencode.json`（**含明文 `sk-` API token**） | 两者从提交树移除（session.session 恢复父版本、opencode.json 删除）；⚠️ token 已进 git 历史，建议轮换 + 如需要 `git filter-repo` 清史 | git status 核对 |
| 55 | **userSendAt bump 不广播** | turn_start/输入路径只更新本地 store；mobile 会话→项目分组靠 `sessions:patched {userSendAt}` 收敛（desktop touchUserSendInDb 广播），不推则分组停旧值 | touchUserSend() 广播 patched；tracker turn_start 同推 | 冒烟：push 记录断言 |

### 测试管理

| # | 项 | 说明 |
|---|---|---|
| 56 | **测试扩展 45→79 断言** | 新增：create-session id 幂等/返回形状、messages DESC 五分支、around 窗口/顺序、投影 chatMessage 全字段、stop opts（keepQueue/pauseQueue/空闲清）、前台会话门禁、附件拒绝、中断语义、路径穿越、原子写无残留 tmp |
| 57 | **会话路由 v0.5.0** | 手机消息路由到会话宿主：host 四态（我/活/死/无）+ 邮箱落行 + 定向接管 + 合成投影；三进程集成握手验证 A 让位→B 认领→B 消费邮箱注入，C 全程不抢（冒烟 167→218 + 集成 ALL PASS） |
| 58 | **交接 TTL 死窗** | handoff 过期后按 heartbeatMs（非 staleMs）放宽陈旧判定，避免 TTL(10s)→stale(15s) 接管延迟；tryTakeover 认领即清 handoff 字段防目标自损 |
| 59 | **邮箱清理顺序** | clearHostAndArchiveForInstance 必须先标邮箱 failed 再清 host（子查询依赖 host 旧值）；反序 pending 行永久滞留（plan 稿代码即反序，已修） |
| 60 | **合成投影形状** | 复用现有 inputProjection 零新字段；get-projection 只读合成（不落邮箱不接管）；chatMessage 必须透传否则 mobile isQueuedRemoteMessage 过滤整段队列 |
| 61 | **集成测试 worker stdin 解析** | `split(/ (.+)/)` 吞剩余整串 → sid 带空格 INVALID_PARAMS → worker 未捕获异常退出 → 场景静默失败；改先切前缀再按首空格分 |
| 62 | **手机端 `/` palette CHANNEL_NOT_ALLOWED** | 三源 channel（list-agent-commands/list-agent-skills/list-desktop-commands）不在 invoke allowlist，Promise.all 任一 reject 即错误顶掉面板 | 用 pi.getCommands() 映射三源（extension→builtin；prompt+skill→skill）；失败容错空清单，契约形状对齐 composerPalette.ts | 冒烟 palette 断言 +11（三源形状 + getCommands 缺失/抛错容错）；typecheck 绿 |

---

## 未修（有意保留）

> ~~2026-08-08 · 整表已全部解决，表删除~~：notify 能力位门禁（见踩坑 #28）、controller 撤销/
> 远程禁用门禁（见踩坑 #27/#30）、request-code/verify-code locale（CHANGELOG v0.2.0）、
> hello-ack serverProtocolVersion 校验（CHANGELOG v0.4.0）。详情见对应条目/CHANGELOG，正文不再引用。

---
---

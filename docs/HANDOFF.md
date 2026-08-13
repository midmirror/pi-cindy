# pi-cindy HANDOFF

> 2026-08-14 · 状态：**v0.5.2 已发布**；工作树含未发版工作（跨进程 refresh 互斥 + 状态栏产品化，
> 见已完成块 08-09/08-14 条目）。冒烟 297 断言 + ownership + 三进程集成全绿，双门禁绿。
> 独立仓化后仅 `v0.5.1` tag 存活（更早 tag/commit 随 fresh history 丢失）；P3 双进程真机验证 ✅（08-07）。

## 工作背景

- **项目目标**：Pi extension 模拟 Cindy Desktop 被控端（device-link sync），使 Cindy 手机端可浏览/操作 Pi 会话（会话列表、选模型、发消息、停止/转向、压缩等）。
- **关键决策**：模拟 Desktop（不改手机端）；SQLite 存储（v0.3.0 起，node:sqlite，此前为 JSON 文件存储）；PKCE 登录；invoke allowlist 精简；落库与权威推送只在 tracker 完成；协议契约以手机端消费方源码为准（详见 `AGENTS.md` Must-know，勿推翻）。
- **与上游对应关系**：参考实现 = cindy 开源仓库（desktop 端 `apps/desktop` + `packages/device-link` + `packages/maker-shared`）；手机端契约以 mobile 侧 normalize/validate 函数为准。端点、信封格式、hello、WS 路径、push 频道名均对齐（参考仓本机路径不固定，见下文端点查找方法）。
- **文档分工**：本文件 = 交付状态与待办；`EXPERIENCE.md` = 踩坑与迭代经验 + 问题记录附录（唯一源，#1-45 + 表 #1-62）；`CHANGELOG.md` = 版本化变更流水。

## 已完成

### 2026-08-05 · 扩展骨架 + 登录链路

- [x] pi extension 可被加载（symlink）；模块全部完成（类型/device-link 客户端/invoke 路由/会话消息
      handlers/PKCE 登录/AES token 存储/JSON 会话存储/生命周期追踪/入口 5 命令 + 2 工具）
- [x] 端点修正（P0）：`auth.cindy.app`（global）/ `auth.cindy.com.cn`（cn）；WS 认证 header Bearer token
- [x] **真机登录验证通过**（Google 登录 → poll → token 兑换 → session.enc → relay 握手 hello-ack 秒回）；
      登录链路修复（poll 错误不吞/onReady 前置/4409 慢重连/状态持久显示）；`/cindy-login [cn|global] [google|apple|email]`
      含 email 验证码/binding_required/select_account/provider 不可用明确报错

### 2026-08-06 · 评审修复第一轮（#1-19，review-swarm 对拍 105be51）

- [x] P0：post-handshake 帧全丢（#1，message 监听器存活整个 socket 生命周期）；`maker:input:*` 输入队列实现（#2）；时间戳 ISO 字符串（#3）
- [x] P1 连接生命周期：#4 stopped 标志（disconnect 生效）、#5 realm 派生、#6 single-flight + 替换前 disconnect、#7 握手 watchdog、#8 指数退避 + 401 停止重连、#9 sessions:list 位置参数 + clampLimit(20)、#10 消息 ID 游标
- [x] P2 契约与安全：#11 订阅表 + topic 路由、#12 deepLink 对齐 desktop 路径、#13 relay-debug.log 0600 + 1MB 截断 + 真开关、#14 maker:event 死推送移除、#15 patch-meta 字段白名单、#16 logout 按 realm、#17 busy→presence-set、#18 token 威胁模型文档化、#19 单次 updateSession

### 2026-08-06 · 真机问题修复（#20-29，手机同步会话列表后「选不了模型 + 发消息收不到」）

- [x] get-capabilities 输出 mobile 契约形状（#20，模型从 `ctx.modelRegistry` 派生）；list-available-agents 返回 `["pi"]`（#23）
- [x] enqueue 必失败修复（#21，`pi.sendUserMessage` 返回 void，改 try/catch，注入前 apply model/effort）
- [x] stop/abort 改走 `ctx.abort`（#22，新模块 `src/runtime.ts` 在 session_start 捕获 ctx 动作）
- [x] 补齐 12 个 input 通道（#27）；provider 辅助接口（#28）；会话 model 存纯 id + providerId 分离（#24 + `model_select` 事件）；createSession 默认模型回落 registry 首模型（#25）；regenerate-title 兼容对象参数（#26）；模型白名单过滤 + 去重（#29）
- [x] **真机验证通过**：手机 enqueue "来自手机" → 落库 + agent 回复 + 会话 model 变 deepseek-v4-flash

### 2026-08-06 · 测试纳入仓库管理（#30-32）

- [x] `npm test`（handler 层冒烟，`PI_CINDY_DATA_DIR` mkdtemp 隔离，45 断言）+ `npm run typecheck`（strict）双门禁入库

### 2026-08-06 · 评审修复第三轮（#33-56，review-swarm 对拍提交版 6e95b4c）

- [x] 契约：#33 create-session 透传 mobile 预生成 id（幂等，返回 `{sessionId, agentKind, workDir}`）、#34 messages:list 恒降序、#35 messages:around / around-client-id、#36 队列投影透传 chatMessage（附件显式拒绝）、#37 消息带 clientId、#38 截断打 remoteContentTruncated、#39 totalTokens、#52 list-active 形状、#53 附件显式拒绝
- [x] 语义：#40 session_shutdown 顺序（tracker 先归档再断开）、#41 inputStop opts（keepQueue/pauseQueue）、#42 前台会话门禁（activeId）、#43 中断语义对齐 desktop
- [x] 可靠性/安全：#44-47 pong-miss 判死、relay-error 非致命、connEpoch 防迟到事件、token 失效停重连；#48 auth refresh single-flight + logout 代数失效；#49-50 原子写 + 路径穿越防护；#51 摘除伪造 session-tree；#54 revert 明文凭据提交；#56 测试扩至 79 断言
- [x] 测试：79 断言（id 幂等/DESC/around/chatMessage 透传/stop opts/会话门禁/附件拒绝/中断语义/路径穿越）

### 2026-08-06 · P2 编码项（端点热更新 + loopback 降级 + binding 流程，目标 v0.2.0，提交 `d30e7f0`）

- [x] **端点热更新**（`src/endpoints.ts`）：登录/连接时拉 CDN 清单覆盖烘焙默认；全部端点消费方改
      `getEndpoint()` 动态读取；拉取失败保留烘焙 + 日志不阻断（差异见 EXPERIENCE #18）
- [x] **RFC 8252 loopback 降级**（`src/auth/loopback.ts`）：callbackUrl 为空时起随机端口 HTTP server 收回调
      （`/auth/callback` + state 校验）；托管回调保持主路径
- [x] **binding_required 全流程**：`requestBindingCode` + `verifyBinding` 走通，email 流程完整绑定交互
- [x] 补 locale（requestEmailCode/requestBindingCode + `ui_locale`）；`src/dbg.ts` 抽共享排障日志
- [x] **relay-error 状态化**：握手后 DEVICE_OFFLINE 等改 dbgLog + onRelayError 回调，status line 显离线/在线；
      `/cindy-status` 增 Models 数
- [x] 测试 80→113 断言（清单解析/CDN 覆盖/loopback/binding）+ typecheck 绿

### 2026-08-06 · P1 真机首轮（会话不落库修复 + 双实例验证）

- [x] **修「手机刷新不出会话」**：tracker `session_start` 曾依赖 relay client 就绪，未就绪即
      return → 当前会话永不落库。改：建会话 + setActiveId 前置，push 后移判空（EXPERIENCE #22）；113→119 断言
- [x] **真机验证通过**：手机端已能拉取 `709583bd` 会话 + 打开会话页（messages:list /
  get-pending-interactions / get-projection 到达）；双实例同 deviceId 冲突：B 顶替 A 被
  4409、无互踢死循环（A 走 30s 慢重连）
- [x] **发现 refresh token 家族撤销**：真实数据目录上诊断脚本与运行中进程并发 refresh
  同一 refresh token → auth 401 INVALID_REFRESH_TOKEN，需重新登录（EXPERIENCE #23）

### 2026-08-06 · P1 真机第二轮（push 复测 + 手机端常调 channel 补全）

- [x] **push 复测通过（全链路）**：手机 enqueue「来自手机」→ invoke 到达（22:35:08）→
  落库带 clientId（`mobile-mshmb2do-d8na0lsx`）→ agent 回复回流（本会话即证据）；
  iPhone 订阅 `session:<id>` + `sessions` topic（22:34:24）正常；出站 push 不打日志，
  手机 UI 实时收回复即证据。token 无需重登（`loggedIn:true`，上轮误杀已自愈）
- [x] **补手机端常调 4 channel**（`src/handlers/system.ts` + `fs-browse.ts`）：
  `maker:goal:get-status`→null、`maker:schedule:list`→[]、
  `notification:clear-session-attention`→no-op（返回形状对齐 desktop 空态）；
  `fs:stat-path`→expandHome+stat `{kind, resolvedPath}`（desktop device-link allowlist
  设计上允许被控端执行）；测试 119→125 断言（EXPERIENCE #24）

### 2026-08-06 · P1 收口（v0.2.0 tag）

- [x] **双端 logout 后重登验证通过**：手机端 logout + pi-cindy logout 均执行，两边重新登录
  成功（`/cindy-login global google`）；新 token 家族生效，重启后连接恢复（22:43 hello-ack
  userId=<redacted>，iPhone 重新订阅 + 拉会话列表）
- [x] **新代码生效验证**：重启后零 CHANNEL_NOT_ALLOWED（旧代码 22:38 报错为重启前残留），
  `maker:schedule:list` 成功返回 []（新 router 处理）
- [x] 打 **v0.2.0 tag**（commit `690f817`）

### 2026-08-06 · 多进程共存 + SQLite 化（v0.3.0，spec: docs/specs/2026-08-06-multi-process-sqlite-design.md）

- [x] 单持有者仲裁：copy desktop ownership.ts（SQLite 单行表 CAS），同数据目录多 pi
      进程一 owner 一 standby，4409 互踢根除
- [x] session-store JSON→SQLite（node:sqlite 零依赖，对外签名不变，handler 零改动）
- [x] JSON→SQLite 一次性迁移（fail-open + migration_done 幂等，旧文件保留）
- [x] 双进程集成测试（tests/multi-process.test.js）：真跨进程（spawn 两 node 子进程
      同 db 文件）验证一 owner 一 standby、standby 在持有者存活期间不接管

### 2026-08-07 · 技术债清零 + 旧 JSON 清理（v0.4.0，未打 tag）

- [x] **hello-ack `serverProtocolVersion` 校验**：对齐参考 client.ts 防御性二道闸，mismatch 拒上线
  + protocolMismatch 标志停重连（不复用 authFailed 文案）；实测 server v1 与本地一致不误伤
- [x] **notify 能力位门禁**：`git submodule update --init cindy-protocol` 检出子模块获
  `SERVER_CAPABILITY_NOTIFY='notify'`（参考仓 .gitmodules），client.notify 加 capability gate
- [x] **controller 撤销/远程禁用门禁**（对齐 desktop settings-store + dispatch + index）：
  `src/store/settings-store.ts`（remoteControlEnabled + revokedControllers，JSON 原子写 0600）；
  link-open/subscribe/invoke 三入口门禁（REMOTE_DISABLED / ACCESS_REVOKED，link-open 撤销发
  link-close('revoked')）；`/cindy-revoke|restore|remote` 命令 + status 显示；测试 133→147 断言
- [x] **旧 JSON 孤儿数据清理**：确认 SQLite 已完全接管（store 零 JSON 引用 + db 承载当前会话），
  迁移从未触发（db 非空跳过，EXPERIENCE #27）→ 27 会话/669 消息无主；用户确认后删除
  sessions.json + messages/；数据目录仅剩 SQLite + device-id + session.enc + 日志

### 2026-08-07 · P3 双进程真机验证（v0.4.0 后，5s 心跳/15s 过期/退出秒级释放）

- [x] **双实例 + 手机端全流程**：A owner / B standby（`standing by — will not connect to relay`）；
  手机设备列表恒 1 台、会话列表 2 会话；standby 会话正常落库（created = 启动时刻，与 standby 日志同秒）
- [x] **故障切换双路径实测**：优雅退出 4.4s 接管（release→claim→hello-ack；transportStreamId 不变，
  手机无需重连，link 无缝继承）；`kill -9` 后 14.1s 过期接管（`takeover-stale(prev pid=…)`，spec ≤15s）；
  全程 4409 = 0
- [x] **心跳节奏实测**：16s 墙钟 → heartbeat_at +15.03s（5s/拍 ×3），与实现参数一致；A 重启直接 standby
  无互踢；硬杀残留 stale 行由下次接管自愈（测试收尾手动清行恢复基线，session 25 条保留）

### 2026-08-07 · 会话路由 + 快速接管（v0.5.0，spec: docs/specs/2026-08-07-session-routed-handoff-design.md）

- [x] **宿主标注 + 实例心跳**：`sessions.host_instance_id`（tracker session_start 写 / shutdown 清，
      instance.ts 进程级 UUID）；`cindy_instances` 心跳表（10s 续写，随仲裁器启停）
- [x] **路由判定**（router.ts SESSION_LOCAL 集）：host==我 → 本地 handler；host==null → NOT_FOUND；
      host 活 → 邮箱落行 + 定向接管 + 合成投影；host 死 → 清 host/邮箱 failed + error 投影；
      get-projection 只读合成（不落邮箱不接管）
- [x] **定向接管**（ownership.ts）：handoffTo 写交接信号（TTL 10s）后让位停续期；目标 fastPoll
      （默认 1s）独占认领；交接过期按 heartbeatMs 收敛；tryTakeover 认领清 handoff 字段防自损
- [x] **DB 邮箱**（cindy_handoff_mailbox）：UNIQUE(session_id, client_id) 幂等落行；宿主接管后
      本地重放（失败不标 consumed）；owner 15s sweep 死宿主清理 + failed 5min 清理
- [x] **clientId 环形窗口去重**（同 (session, clientId) 重发 no-op）+ index.ts 接线（wireInvokeContext /
      heartbeat·sweep timer / status Inst:Host）
- [x] **测试**：冒烟 167→218 断言 + 三进程集成握手（A 让位→B 认领→B 消费注入，C 不抢）；
      typecheck + 全部测试文件绿；v0.5.0 tag 锚定

### 2026-08-07 · 热重载泄漏根治（单实例误报 standby 永久化，EXPERIENCE #41）

- [x] **根因**：pi 扩展热重载（/reload / 会话切换重建 runner）重执行模块，旧实例仲裁器定时器
      泄漏 → 同进程 9+ 仲裁器共存，旧实例持续续期「同 pid 幽灵租约」，新实例永久 standby
      （`/cindy-status` 显示「standby (另一实例持有连接)」但无第二 pi 进程；手机端 DEVICE_OFFLINE）
- [x] **修复**：①`runTick` 新增 `sameProcessLease` 判定——`owner_pid === process.pid` 且非己
      ownerId 的租约视为重载幽灵，无有效交接信号即 CAS 立即接管（不等 staleMs）；②进程级仲裁器
      注册表（globalThis）：`takeOverProcessArbiter`/`registerProcessArbiter`/
      `releaseProcessArbiter`，新模块 startArbiter 先 dispose 旧 bundle（停仲裁器 + sweep + 实例
      心跳，不关 DB）再注册自己的，任意时刻只一个活仲裁器
- [x] **测试**：ownership 测试 16→30 断言（同 pid 幽灵立即接管 <2s / 注册表 takeOver 幂等 / 重载
      模拟 A 停 B 接无翻转）；`npm test` 纳入 ownership.test.js（此前只跑 smoke + multi-process）
- [x] **token 对防御性校验**（EXPERIENCE #42）：`isValidTokenPair`（≥16 字符）——畸形刷新/登录
      响应不落盘（真机复现 refreshToken="rt" 覆盖好 token → 永久 401）；401 INVALID_REFRESH_TOKEN
      自动 clearSession（瞬态网络错误不清）。冒烟 241→249 断言
- [x] **真机验证**（重启后）：单进程无幽灵仲裁器；同 pid 幽灵租约立即接管；坏 token 由新代码
      自动清会话（session.enc 已删）→ 需重新登录恢复连接
- [x] **死宿主会话清理补洞**（EXPERIENCE #43）：sweep 按会话反查（host 不在活实例/已空 →
      归档），手机端列表不再堆积死会话。真机：12 active → 1 active（仅当前活进程会话）；
      冒烟 249→252 断言
- [x] **手机端 `/` palette 三源补全**（EXPERIENCE #44）：手机 `/` 命令面板报
      `channel not allowed maker:list-agent-commands`——三源 channel（list-agent-commands /
      list-agent-skills / list-desktop-commands）全缺 allowlist，Promise.all 任一 reject 即错误
      顶掉面板。数据源 = pi.getCommands()（extension→agent-builtin；prompt+skill→agent-skill，
      skill 名保留 `skill:` 前缀；desktop 空清单），失败容错空清单不报错。冒烟 palette 断言 +11

### 2026-08-08 · 登录态丢失根因修复（EXPERIENCE #45）

- [x] **根因**：token-store.ts 硬编码 `~/.pi/cindy-sync`，不走 PI_CINDY_DATA_DIR——冒烟测试
      20b 段的 logout/畸形/401 全链路 clearSession 作用在**真实 session.enc**，每次 npm test
      删真实登录态；dbg.ts 同病（测试日志污染真实 relay-debug.log）。
- [x] **修复**：token-store + dbg.ts 均尊重 PI_CINDY_DATA_DIR（与 db.ts 同源）；auth-client
      refresh 全路径 dbgLog（clearSession 首次可查因）；冒烟加真实 session.enc 字节快照隔离
      回归断言（路径同源引用 token-store.DEFAULT_DIR）；冒烟隔离断言 +3 + typecheck 双门禁绿。
- [x] 遗留：跨进程并发 refresh 家族撤销（EXPERIENCE #23 设计风险）未治——单机单实例不受影响，
      多 pi 窗口/热重载叠加时仍可能触发，需跨进程 refresh 互斥（见未完成）。同进程版本（登录与
      在途刷新并发）已在 review 二轮用 savePair bump cacheGeneration 关闭（EXPERIENCE #46）

### 2026-08-08 · review-swarm 四审跟进 + 开源发布（v0.5.1 / v0.5.2，npm 已发布）

- [x] **v0.5.1 四审 H/M 修复**：H1 交接过期回落清 handoff（renew CASE 条件清）、H2 路由响应
      形状（非投影类回 `{ok:true}`，死宿主抛 NOT_FOUND）、M1 get-projection 错误可见（unhosted
      → NOT_FOUND）、M2 优雅关闭清邮箱、M3 邮箱滞留闭环（激活消费 + 10min TTL）、M4 假活宿主
      熔断（未认领 strike）、M5 心跳硬上限（>2×staleMs 判死）、M6 集成测试走真实路由；冒烟
      218→241 断言
- [x] **v0.5.2**：连续畸形 token 累计清除（3 连 → clearSession 强制重登）、isValidTokenPair
      守卫类型收窄（AuthTokenPair）、runTick 死分支清理、仲裁器注册表 last-wins 注释、
      ownership 测试断言修正（去死代码）
- [x] **v0.5.2 review 二轮**（EXPERIENCE #46，四审高置信度问题全部落地）：savePair 复位畸形
      计数 + bump cacheGeneration（登录与在途刷新并发竞态关闭）；畸形×3 清内存缓存对称；
      refresh failed 日志脱敏（code/status 替代响应体）；palette null 行过滤；DEFAULT_DIR 导出
      同源引用；冒烟补成功复位 + null 行测试。契约对证参考仓（M2）：scope?: string 未定型
      联合透传安全，三源结果形状吻合，无改动。冒烟 260→285 断言（palette +13、畸形 +9、
      隔离 +3）
- [x] **开源发布**：npm 发布 `pi-cindy@0.5.1`（tsconfig.build + dist + prepublishOnly 门禁 +
      peerDeps，tarball 108 文件）；**独立仓化**（fresh history，旧仓含明文凭据历史不带入，
      `~/.agents` 改子模块 gitlink）；LICENSE/NOTICE/README/.github CI；HANDOFF 内嵌 userId
      脱敏 `<redacted>`
- [x] 细节与断言流水见 CHANGELOG [0.5.1] / [0.5.2] / [Unreleased]（本块只留结论）

### 2026-08-09 · 跨进程 refresh 互斥落地（技术债 #23/#46 清零）

- [x] **跨进程 refresh 互斥**（`src/auth/refresh-lock.ts`，双层互斥）：多 pi 进程 / 热重载叠加时
      并发 refresh 同一 refresh token → 服务端轮换竞争 → 家族撤销 401 → 误清会话。①进程内
      promise-chain 串行（基础设施级单飞，不依赖调用方）；②进程间 SQLite 单行锁 `refresh_lock`
      （CAS，与 ownership 同源）——不同 pid 互斥、崩溃靠 30s stale 抢占、同 pid 热重载幽灵锁
      立即接管。**锁内重读 session.enc**（可能已被他进程轮换），绝不用进锁前陈旧 token。
      db 不可用/锁超时跳锁 best-effort。锁表入 db DDL 第 6 表；ownership 锁语义测试 +5
      （并发互斥最大并发=1 / 崩溃 stale 抢占 / 同 pid 热重载覆盖 / 他进程持锁释放后接管 /
      释放只清自己锁）；冒烟 20b 段走锁内重读路径无回归（290 断言，EXPERIENCE #48）

### 2026-08-14 · 状态栏文案产品化 + 中英切换（review-swarm 四审，PR #9）

- [x] **5 态双语状态表**（`已连接 / 其他Pi已连接 / 离线 / 协议不兼容 / 遥控已关闭`，
      en: Connected / Another Pi instance connected / Offline / Protocol mismatch /
      Remote control off）；技术细节（错误码/协议原因）移入 lastIssue 由 `/cindy-status` 展示
- [x] **`/cindy-status-lang [zh|en]`**：语言偏好持久化到独立 `ui-prefs.json`（0600 原子写，
      不进 device-link 语义 settings.json——决策记录 `docs/decisions/2026-08-14-status-lang-prefs.md`），
      默认跟随系统 locale（zh 前缀判断兼容 zh-TW/HK）；`loaded` 哨兵进程内缓存，markOnline
      每业务帧零读盘（验证：100 次调用 1 次读盘）
- [x] 认证失败（token 失效）归「离线」——此前只写 lastIssue，状态栏残留「已连接」假象；
      合并「持有权已让出」（handoff/renew 过渡归离线）；遥控关闭不被业务帧覆盖（remoteEnabled 门禁）；
      relay-error 日志白名单（code/message）
- [x] 冒烟 289→297 断言（M4 语言偏好：locale 跟随/缓存/显式优先/0600/env 还原）；typecheck + lint 绿；
      PR #9（feat/status-bar-productization）

## 未完成

### P1：会话路由真机验证清单（v0.5.0 已发布；自动化已覆盖握手，真机待跑）

- [ ] 双 pi 进程（不同目录）+ 同一账号登录 + 手机端：设备列表 1 台、会话列表见 2 会话
- [ ] 手机在 B 会话发消息 → ~1-2s 内 B 接管（B 窗口 `/cindy-status` 变 owner）→ B 回复回流手机
- [ ] 随后手机在 A 会话发消息 → 接管切回 A → 回复回流；全程无 4409（relay-debug.log grep）
- [ ] kill -9 B → 手机在 B 会话发消息 → ~10s 内明确报错（会话无活宿主）
- [ ] 重启 B（resume 同会话）→ 会话复活可消息

> apple/email 登录未单独真机验证（google 已通；binding/loopback 单测覆盖）——需要时补验。

### 技术债（随版本消化）

- [ ] **本地输入队列 DB 快照**（desktop issue #761）：pi-cindy 输入队列为内存态，扩展重载/进程重启即清空；
      desktop 有 DB 持久化输入队列快照。手机端依赖 get-projection 重拉，快照化后重启不丢队列态。
      当前为已知局限（v0.5.0 范围外）。

---

## 端点查找方法

```bash
# Cindy 源码 dev 配置 / 桌面端缓存 / 运行日志（三路任选）
cat ~/Documents/Code/Playground/cindy/config/endpoint.global.json
find ~/.config ~/Library/Application\ Support -path "*/cindy/*" -name "*.json" 2>/dev/null | head -20
grep -r "endpoint" ~/Library/Application\ Support/cindy/logs/ 2>/dev/null | head -5
```

---

## 文件索引

```
~/.pi/agent/extensions/pi-cindy/          # symlink
~/.agents/agent-configs/pi/extensions/pi-cindy/  # 实际路径
├── AGENTS.md             # 规范：Commands / Must-know / HANDOFF 维护规范
├── index.ts              # 入口：9 命令（login/logout/status/status-lang/connect/disconnect/remote/revoke/restore）+ 2 工具
├── package.json          # scripts: test / typecheck / build（prepublishOnly 门禁）
├── tsconfig.json         # strict + NodeNext（+ tsconfig.build.json 发布编译）
├── tests/                # npm test = smoke + ownership + multi-process
│   ├── smoke.test.js       # 297 断言冒烟（handler 层）
│   ├── ownership.test.js   # 仲裁/热重载/交接（31 断言）
│   ├── multi-process.test.js # 三进程集成（真跨进程 worker）
│   └── store-sqlite / migration / node-sqlite-probe（辅助）
├── docs/AGENTS.md → 见仓库根
├── docs/DESIGN.md        # 设计方案（架构/协议/端点/数据流）
├── docs/HANDOFF.md       # 本文件 — 交付状态（工作背景/已完成/未完成）
├── docs/CHANGELOG.md     # 版本化变更记录
├── docs/EXPERIENCE.md    # 踩坑与迭代经验 + 问题记录附录（唯一源）
└── src/
    ├── types.ts          # 端点烘焙默认（DEFAULT_ENDPOINTS，生效值以清单覆盖为准）
    ├── endpoints.ts      # 端点热更新：CDN 清单解析 + 动态 getEndpoint
    ├── dbg.ts            # 共享排障日志（relay-debug.log）
    ├── runtime.ts        # Pi 运行态快照（ctx 能力捕获）
    ├── tracker.ts
    ├── ownership.ts      # 单持有者仲裁（SQLite 单行 CAS + 定向接管 handoffTo）
    ├── instance.ts       # 进程级实例 UUID + cindy_instances 心跳
    ├── handoff.ts        # 定向接管让位/认领逻辑
    ├── auth/auth-client.ts
    ├── auth/loopback.ts  # RFC 8252 loopback 回调（callbackUrl 为空时的登录回落）
    ├── auth/refresh-lock.ts # 跨进程 refresh 互斥锁（进程内串行 + SQLite 单行锁）
    ├── device-link/client.ts
    ├── handlers/router.ts  # invoke 路由（65 channel allowlist + SESSION_LOCAL 宿主路由）
    ├── handlers/{sessions,messages,maker,system,fs-browse}.ts
    ├── store/db.ts       # SQLite（node:sqlite，WAL + busy_timeout，6 表）
    ├── store/token-store.ts
    ├── store/session-store.ts
    ├── store/settings-store.ts # 授权黑名单/全局开关（JSON 原子写 0600）
    ├── store/ui-prefs-store.ts # 状态栏语言偏好（JSON 原子写 0600 + 进程内缓存）
    ├── store/handoff-store.ts  # DB 邮箱（cindy_handoff_mailbox）
    └── store/migration.ts      # JSON→SQLite 一次性迁移
```

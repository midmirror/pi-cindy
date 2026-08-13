# AGENTS.md

pi-cindy：Pi extension 模拟 Cindy Desktop 被控端（device-link sync），Cindy 手机端浏览/操作 Pi 会话。
TypeScript strict + NodeNext，`ws` 依赖，构建于 @earendil-works/pi-coding-agent ExtensionAPI。

## Commands

```sh
npm test             # 冒烟（smoke + ownership + multi-process，PI_CINDY_DATA_DIR 隔离数据；必须全绿）
npm run typecheck    # tsc --noEmit（strict，必须绿）
npm run lint         # eslint flat config + typescript-eslint recommended（必须绿）
npm run coverage     # c8 smoke 基线 82% statements（CI 出报告，勿显著下降）
npm run format       # prettier 本地可选（配置对齐现有风格；不 gate CI，勿全仓重排刷 diff）

# 手动验证（无 UI 环境）
cd ~/.agents/agent-configs/pi/extensions/pi-cindy && npx pi -e . -c "/cindy-status"   # 加载扩展 + 看状态
# 数据目录可覆盖（测试/隔离用）
PI_CINDY_DATA_DIR=/tmp/cindy-test npx pi -e . -c "/cindy-login global"
```

## Must-know

- **契约源 = 对端消费方源码，不是扩展自身理解**：手机端契约以参考仓 mobile 侧 normalize/validate
  函数为准（`normalizeMobileAgentCapabilities`、`normalizeCreateSessionResult`、`historyWindowGap`），
  语义以 desktop ipc handler 签名为准（`localDb/ipc/*.ts`）。改任何 handler 返回/参数前先 grep
  参考仓消费方。参考仓 = cindy 开源仓库（desktop 端 `apps/desktop` + `packages/device-link` +
  `packages/maker-shared`）；本机路径不固定，定位方法见 `docs/HANDOFF.md` 端点查找方法。
- **端点烘焙默认在 `src/types.ts` `DEFAULT_ENDPOINTS`**：`auth.cindy.app`（global）/ `auth.cindy.com.cn`（cn）；
  **生效值以 CDN 清单覆盖为准**（`src/endpoints.ts` `getEndpoint()`，启动/登录时从 hotfix CDN 拉取，
  失败保留烘焙 + 日志不阻断）。device-link REST base 在客户端内转 `wss://.../api/device-link/ws`。
  realm 一律从落盘会话派生，不硬编码。
- **协议**：envelope 帧（hello/link-open/invoke/push/notify/ping），WS 认证 header
  `Authorization: Bearer <token>`；invoke 走 router 65 channel allowlist；push 按订阅表 + topic 路由。
  位置参数/返回形状以 desktop 签名为准（见 EXPERIENCE #1/4）。
- **ExtensionAPI ≠ ExtensionContext**：顶层 `pi` 无 `abort/compact/isIdle/modelRegistry`（静默 no-op），
  `pi.sendUserMessage` 返回 void 非 Promise。ctx 能力在 `session_start` 由 `src/runtime.ts` 捕获一次。
- **存储**：token AES-256-GCM 存 `session.enc`（key 从 hostname+username 派生，真实边界是 0600，勿宣称加密强于本机隔离）；
  会话/消息/所有权全走 SQLite `pi-cindy.db`（node:sqlite **需要 Node ≥22.23**，package.json engines 强制，
  WAL + busy_timeout，主库/-wal/-shm 均收敛 0600；sessions/messages/device_link_ownership/
  cindy_instances/cindy_handoff_mailbox/refresh_lock 六表，所有权 CAS 单行表、refresh 互斥锁单行表）；
  settings JSON 原子写（跨进程锁 + pid 后缀 tmp）+ 0600，损坏 fail-closed（remote 关）；`PI_CINDY_DATA_DIR` 覆盖数据目录。
  UI 偏好（状态栏语言）独立 `ui-prefs.json`（0600 原子写 + 进程内缓存，不进 device-link 语义 settings.json）。
- **多进程授权门禁**：standby 进程执行 revoke/remote-off 只写共享 settings，owner 无法被同步通知——
  持有者 2s 轮询 sweep（`client.sweepRevokedControllers`）兜底断开被撤销/禁用控制器；仲裁状态线只由
  onAcquire/onStandbyChanged/onDemote 回调驱动（startArbiter 后同步 isOwner() 恒 false，勿用）。
- **日志**：`relay-debug.log` 0600 + 1MB 截断，删文件即关（`PI_CINDY_DEBUG=1` 兜底）。排查手机端
  问题先 grep 此日志还原调用序列（EXPERIENCE #10）。
- **已定决策，勿推翻**：模拟 Cindy Desktop（不改手机端）；SQLite 存储（v0.3.0 起，node:sqlite；JSON 时代数据已清理）；
  PKCE 登录（不依赖 Electron safeStorage）；invoke allowlist 精简；落库与权威推送只在 tracker 完成。
- **测试纪律**：链路/契约改动必须有冒烟测试覆盖（模拟 relay 帧级用例）；临时测试不持久化 = 白写。
  冒烟断言基线 290+，改动**禁净删断言**（等价重构除外）。多进程测试（multi-process）禁固定
  sleep 猜时序——worker 经 jiti 编译 TS 可能晚于就绪，必须等 worker 的 READY 信号再发消息
  （CI 高负载已多次踩坑，见 CHANGELOG v0.5.2）。
- **真机验证**：登录成功 ≠ 功能可用；必须走到业务路径（会话列表 → 会话页 → 选模型 → 发消息 → 回复回流）。

## 工程门禁（自动化强制，勿绕过）

- **CI 全绿 = `npm test` + `npm run typecheck` + `npm run lint` + `npm run coverage` + commitlint**
  （`.github/workflows/ci.yml`）。禁删/弱化 CI 步骤（去 lint/coverage = 腐化）。
- **commitlint + husky**：commit 必须 Conventional Commits；**禁 `git commit/push --no-verify` 绕过**。
- **依赖解析**：禁 `npm ci --legacy-peer-deps` / `--force` 绕过 ERESOLVE——依赖问题应修 lock 或
  等 dependabot；lock 只由 `npm i` 或 dependabot 生成，禁手改 package-lock.json。
- **新依赖纪律**：typescript / @types/node 的 major 升级**禁手动**（typescript-eslint peer 上限
  `<6.1.0`；@types/node 跟随 Node 22 运行时；dependabot 已 ignore），需显式评估；新依赖检查
  Apache-2.0 兼容 + NOTICE 同步。

## 禁止操作（腐化红线）

- **禁直推 main**：分支保护（test + commitlint 必需，strict）已开，改动一律走 PR + squash merge。
- **禁关闭/放宽分支保护、禁把 merge 策略改回 merge commit/rebase**（当前 squash-only + delete-branch）。
- **发版固定流程**：改 CHANGELOG 版本块 → bump package.json version → `git tag vX.Y.Z` → push tag
  （`.github/workflows/release.yml` 自动发布 npm + 建 Release，notes 从 CHANGELOG 对应版本条目提取；
  自动发布依赖 repo secret `NPM_TOKEN`，granular token 需 publish 权限 + bypass 2FA，过期需更新）。
  **禁手建 Release、禁改 release.yml 提取逻辑**；CHANGELOG 版本条目必须与 tag 一一对应
  （条目不匹配 = Release 空 notes）；tag 必须与 package.json version 一致（不匹配 publish 自动中止）。
- **日志安全**：禁落 token/响应体（refresh 已脱敏，防回归）；文件权限 0600 勿放宽，
  session.enc 密钥派生逻辑勿改弱。

## HANDOFF 维护规范

**HANDOFF.md 职责范围（只写这些，其余一律不进）**：

| 块 | 内容 | 纪律 |
|---|---|---|
| 工作背景 | 项目目标、关键决策、与上游对应关系 | 稳定，勿推翻 |
| 已完成 | 实现 + 验证结果 | 写成**当时快照**（日期+数据），后续变化改写，不追加"又发现" |
| 未完成 | 路线图（带目标版本）+ 遗留技术债 | 路线图唯一事实源 |

**与 CHANGELOG / EXPERIENCE 分工（防重复）**：
- 行为变更/修复/新增/删除/安全 → **只写 CHANGELOG**（按版本 Added/Changed/Fixed/Removed/Security）；
  HANDOFF 不记录变更流水。命令改动 → 更新本节 Commands。
- 问题根因/修复/验证细节 + 踩坑与迭代经验 → **只写 EXPERIENCE.md**（踩坑编号条目 + 附录问题记录表
  #1-62；HANDOFF 引用编号不复制正文）。
- **版本号规则**：新 feature/重构升级第二位（0.1.0 → 0.2.0），bugfix 升级第三位
  （0.1.0 → 0.1.1）；版本用 git tag 锚定（未打 tag 用 commit 锚定）；目标版本写在 HANDOFF 未完成块。

**更新纪律**：
- **规模上限**：AGENTS.md / HANDOFF.md 各 ≤300 行；超限先移除低价值内容，或迁移到 EXPERIENCE.md / DESIGN.md（原处留指针）。
- **EXPERIENCE.md 保鲜**：条目必须对后续迭代有用；漂移/过时/矛盾内容及时清理更新（过时条目 ~~删除线~~ + 日期，正文不再引用）。
- "完成了 X / 修了 Y" → 只进 CHANGELOG 对应版本；HANDOFF 只留"为什么这样做 / 怎么避免"（进 EXPERIENCE）。
- "实测结果" → 已完成块快照式改写，禁止 append。
- "将来要做" → 未完成块路线图；落地后从路线图移到 CHANGELOG 对应版本条目。
- 每条 ≤5 行（踩坑 ≤4 行）；任务收尾统一更新，不边做边 append。

## Docs

- `docs/HANDOFF.md` — 工作背景 / 已完成 / 未完成（改代码前必读，尤其未完成块路线图）
- `docs/CHANGELOG.md` — 版本化变更记录（版本用 git tag/commit 锚定；规划不重复，见 HANDOFF 未完成块）
- `docs/EXPERIENCE.md` — 踩坑与迭代经验 + 问题记录附录（唯一源，编号 #1-45 + 表 #1-62；改协议/契约/链路前必读）
- `docs/DESIGN.md` — 设计方案（架构、协议、端点、数据流）
- `LICENSE` / `NOTICE` — Apache-2.0 与上游派生声明（makecindy/cindy）；`README.md` — 用户入口文档

# Contributing to pi-cindy

感谢你考虑为 pi-cindy 贡献。这是一个小项目，但契约复杂——请先读本文档再动手。

## 项目是什么

pi-cindy 是 Pi 的 extension，模拟 Cindy Desktop 被控端接入 device-link 链路，让 Cindy 手机端浏览/操作 Pi 会话。核心：SQLite 本地存储、单持有者仲裁（多进程）、按会话路由的消息邮箱、PKCE 登录。

**契约源是上游消费方源码，不是本仓自身理解**：手机端契约以 [makecindy/cindy](https://github.com/makecindy/cindy) mobile 侧 normalize/validate 函数为准，语义以 desktop ipc handler 签名为准。改任何 handler 返回/参数前，先 grep 参考仓消费方，确认改动不破坏手机端。

## 开发环境

- Node ≥ 22.23（依赖内置 `node:sqlite`，experimental API）
- npm

```sh
git clone git@github.com:midmirror/pi-cindy.git
cd pi-cindy
npm install
# 本地加载扩展（可选，真机验证用）
ln -s "$PWD" ~/.pi/agent/extensions/pi-cindy
```

## 常用命令

```sh
npm test            # 冒烟（290 断言，PI_CINDY_DATA_DIR 隔离）+ 多进程集成
npm run typecheck   # tsc --noEmit（strict，必须绿）
npm run build       # 构建 dist（发布用）
```

## 测试纪律

- **链路/契约改动必须有冒烟测试覆盖**（模拟 relay 帧级用例）。临时测试不持久化 = 白写。
- 测试默认隔离：`PI_CINDY_DATA_DIR` 指向临时目录，禁止读写真实数据目录（会删用户登录态）。
- 多进程测试（`tests/multi-process.test.js`）对时序敏感：worker 经 jiti 编译 TS 可能晚于就绪，**必须等 worker 的 READY 信号再发消息**，不要用固定 sleep 猜时序。
- 真机验证（登录成功 ≠ 功能可用）：必须走业务路径——登录 → 会话列表 → 会话页 → 选模型 → 发消息 → 回复回流。

## Commit 规范

Conventional Commits（`@commitlint/config-conventional`），husky 本地强制：

- `feat:` / `fix:` / `docs:` / `refactor:` / `test:` / `chore:` 等
- subject 可用中文描述（可混英文术语），`subject-case` 规则已关闭
- header ≤ 100 字符，body 行 ≤ 100 字符

```sh
fix: 邮箱消费竞态——认领后重放失败不重试

（原因 + 修复 + 验证，body 空行分隔）
```

## 文档纪律

- 行为变更/修复/新增/删除/安全 → **只写 `docs/CHANGELOG.md`**（对应版本条目）
- 问题根因/修复细节/踩坑经验 → **只写 `docs/EXPERIENCE.md`**（编号条目）
- 架构决策 → `docs/DESIGN.md`；交付状态 → `docs/HANDOFF.md`
- 版本规则：feature/重构升第二位（0.5.0 → 0.6.0），bugfix 升第三位（0.5.1 → 0.5.2）

## 提交 PR

1. 开一个描述性 issue（或从现有 issue 认领）
2. fork + 分支，改动 + 测试 + 文档（按上文纪律）
3. PR 描述写清：动机、变更点、测试证据（`npm test` / `npm run typecheck` 输出）、真机验证结果
4. CI 必须全绿（test + typecheck + commitlint）

## 提 issue

- 用 issue 模板（bug / feature），缺失信息会被要求补齐
- 排障类问题先开 `PI_CINDY_DEBUG=1` 复现，附 `relay-debug.log` 关键段
- 协议/兼容性问题注明 Cindy 上游版本与参考仓 commit

# pi-cindy

> Pi extension 模拟 Cindy Desktop 被控端（device-link sync），让 Cindy 手机端浏览/操作 Pi 会话。

[Cindy](https://cindy.app/) 是一个开源 AI agent（[makecindy/cindy](https://github.com/makecindy/cindy)，Apache-2.0）。本扩展模拟其 Desktop 被控端接入 device-link 链路：手机端登录 Cindy 后，即可查看你的 Pi 会话列表、打开会话、选择模型、发送消息、停止/转向/压缩会话。

## 特性

- **会话同步**：当前 Pi 会话自动落库（SQLite），手机端可拉取列表/打开会话页
- **双向消息**：手机 enqueue → 注入 Pi → agent 回复回流手机；`maker:input:*` 输入队列 16 通道 + projection 回流
- **会话路由**：多 Pi 进程共享同一账号时，消息按会话路由到宿主实例（邮箱 + 定向接管，~1-2s）
- **被控授权门禁**：`/cindy-revoke` / `/cindy-remote` 控制手机端访问（对齐 Desktop settings-store）
- **PKCE 登录**：google/apple/email，RFC 8252 loopback 回调降级，token AES-256-GCM 本地加密存储
- **端点热更新**：启动/登录时从 Cindy CDN 拉取端点清单，覆盖烘焙默认值

## 安装

依赖 **Node ≥ 22.23**（使用内置 `node:sqlite`）。作为 pi extension 安装：

```sh
# 从 pi.dev 包市场（npm）
pi install npm:pi-cindy

# 或从源码
git clone git@github.com:midmirror/pi-cindy.git
cd pi-cindy
bash install.sh                    # npm install --omit=dev
ln -s "$PWD" ~/.pi/agent/extensions/pi-cindy
```

## 使用

```sh
/cindy-login [cn|global] [google|apple|email]   # 登录（首次必需）
/cindy-status                                    # 查看连接/仲裁/模型状态
/cindy-connect                                   # 手动建立 relay 连接
/cindy-disconnect                                # 断开
/cindy-logout                                    # 登出
/cindy-revoke <deviceId>                         # 拉黑某手机控制端
/cindy-restore <deviceId>                        # 恢复某手机控制端
/cindy-remote [on|off]                           # 全局远程控制开关
```

登录成功后，手机端 Cindy app → 设备列表即可看到本机，可浏览/操作会话。

排障：`PI_CINDY_DEBUG=1` 开启 `relay-debug.log`（0600，1MB 截断）。

## 开发

```sh
npm test          # 冒烟测试（241 断言，PI_CINDY_DATA_DIR 隔离）+ 三进程集成测试
npm run typecheck # tsc --noEmit（strict）
```

真机验证（业务路径）需真实账号：登录 → 会话列表 → 会话页 → 选模型 → 发消息 → 回复回流。

## 架构

```
index.ts           入口：8 命令 + 2 工具 + invoke 路由接线
src/device-link/   WS 客户端（envelope 帧 / hello / invoke / push / ping）
src/handlers/      会话/消息/maker/system/fs 各 channel handler（58 channel allowlist）
src/tracker.ts     会话生命周期追踪（落库与权威推送唯一入口）
src/ownership.ts   单持有者仲裁（SQLite CAS，多进程互不踢线）
src/handoff.ts     会话路由：DB 邮箱 + 定向接管 + 合成投影
src/store/         SQLite 存储（sessions/messages/ownership/handoff/instances）
src/endpoints.ts   端点热更新（CDN 清单覆盖烘焙默认）
src/auth/          PKCE 登录 + loopback 回调
```

详细设计见 `docs/DESIGN.md`、`docs/HANDOFF.md`、`docs/CHANGELOG.md`。

## 已知限制

- **输入队列为内存态**（对齐 desktop issue #761）：扩展进程重启即清空，手机端依赖 `get-projection` 重拉兜底
- `node:sqlite` 为 Node experimental API（≥22.23 可用），API 面可能随 Node 版本演进
- 邮箱验证码登录需手动输入（无 IMAP 自动读取）
- 协议/契约以 Cindy 上游 desktop/mobile 源码为准，上游变更可能导致不兼容，升级前先读 `docs/EXPERIENCE.md`

## 许可

Apache License 2.0。部分代码与协议对齐派生自 [makecindy/cindy](https://github.com/makecindy/cindy)（Apache-2.0），详见 `NOTICE`。

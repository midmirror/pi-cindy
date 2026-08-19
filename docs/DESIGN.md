# pi-cindy 设计方案

## 概述

`pi-cindy` 是一个 Pi extension，在 Pi 进程内启动 device-link 客户端，**模拟 Cindy Desktop 被控端**，使 Cindy 手机端可以浏览和控制 Pi 会话——无需 Cindy Desktop 运行，无需修改手机端代码。

## 架构

```
┌──────────────────────────────────────────────────┐
│  Pi Extension (pi-cindy)                         │
│                                                  │
│  index.ts ── 注册命令 + 生命周期                  │
│     │                                            │
│     ├── tracker.ts ── Pi 事件 → store + push     │
│     ├── DeviceLinkClient ── WebSocket relay      │
│     ├── handlers/router.ts ── invoke dispatch    │
│     ├── handlers/sessions.ts ── session CRUD     │
│     ├── handlers/messages.ts ── message CRUD     │
│     ├── handlers/maker.ts ── agent control       │
│     ├── auth/auth-client.ts ── PKCE login        │
│     ├── store/session-store.ts ── JSON 存储      │
│     └── store/token-store.ts ── AES 加密 token   │
└──────────────┬───────────────────────────────────┘
               │ WSS (device-link relay)
               ▼
┌──────────────────────────┐
│  Device-Link Relay       │
│  (哑中继，同账号路由)     │
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐
│  Cindy Mobile            │
│  - 浏览 Pi 会话列表       │
│  - 查看消息               │
│  - 发消息/中断           │
│  - 切换模型/effort       │
└──────────────────────────┘
```

## 核心设计决策

### 1. 模拟 Cindy Desktop（不修改手机端）

| 决策 | 原因 |
|---|---|
| `platform = darwin/linux` | 手机端按 platform 字段识别设备类型 |
| `remoteControlEnabled = true` | 手机端 connect 按钮依赖此开关 |
| 相同的 push channel 名 | `local-db:sessions:patched` 等与桌面端完全一致 |
| 相同的 hello 帧格式 | deviceName、appVersion、deviceInfo 等字段对齐 |

### 2. SQLite 本地库（v0.3.0 起；此前为 JSON 文件存储）

`node:sqlite`（Node 22.23+ 内置，零原生依赖 —— 规避了 `better-sqlite3` 需预编译二进制的问题）。

- 单文件: `~/.pi/cindy-sync/pi-cindy.db`（sessions / messages / device_link_ownership 三表，
  WAL + busy_timeout(3000)，多进程并发写安全；主库/-wal/-shm 权限统一收敛 0600；
  open 期 PRAGMA quick_check 检测页面级损坏，失败隔离改名 `.corrupt-<ts>` 重建）
- 所有权: `device_link_ownership` 单行表 CAS（一 owner 一 standby，5s 心跳 / 15s 过期接管 / 退出秒级释放）
- Token: `~/.pi/cindy-sync/session.enc`（AES-256-GCM 加密，key 从 hostname+username 派生；
  含 refresh token + access token 磁盘缓存（`accessToken`/`accessExpiresAt`，启动未过期则零网络直连））
- settings: `settings.json` JSON 原子写（跨进程锁 + pid 后缀 tmp）+ 0600；
  损坏/不可读 fail-closed（remote 关），缺失文件回落默认
- 旧 JSON（sessions.json + messages/）v0.4.0 已清理（见 CHANGELOG）

### 3. PKCE 登录（不依赖 Electron safeStorage）

- `code_verifier` → SHA256 → `code_challenge`（PKCE）
- `pollSecret` → SHA256 → `client_state`（托管回调安全拆分）
- 系统浏览器打开 authorization URL
- 轮询 `/api/auth/desktop/callback/poll` 获取授权码
- 兑换 `/api/auth/token` 获取 access/refresh token
- refresh token + access token 缓存（含 exp）用 AES-256-GCM 加密落盘，key 从 hostname+username 派生；
  进程启动时 access token 未过期（留 60s 余量）则零网络直连 relay，过期才走 refresh
- 畸形 refresh token（<16 字符，服务端异常垃圾值）启动时免网络快速失败——不发请求直接清会话提示重登

### 4. invoke allowlist 精简（62 channel）

完整 allowlist 有 100+ channel，只实现 62 个（唯一事实源：`src/handlers/router.ts` `ALLOWED`）。
覆盖：会话生命周期 / 会话·消息查询 / 输入队列（maker:input:* 16 通道）/ 运行时设置 / 能力·状态 /
订阅 / 系统级常调（goal:get-status、schedule:list 等）/ fs 浏览（fs:stat-path）。

不支持: scheduler, orca, rewind, worktree, file-browser, voice, learn, contacts, telegram 等。
会话树: 不支持（Pi 无原生分支树 API；能力位 `sessionTree: false`，手机端不展示入口）。

## 通讯协议

### device-link 帧流程

```
Phone                    Relay                    Pi (pi-cindy)
  │                        │                        │
  │──── hello ────────────►│                        │
  │◄─── hello-ack ────────│                        │
  │                        │◄── hello ─────────────│  platform: linux
  │                        │─── hello-ack ────────►│  deviceId assigned
  │                        │                        │
  │── link-open ──────────►│── link-open ──────────►│
  │                        │◄─ link-accept ────────│  allowlistHash
  │◄─ link-accept ────────│                        │
  │                        │                        │
  │── invoke (subscribe) ─►│── invoke (subscribe) ─►│  topic: sessions
  │                        │◄─ invoke-result ──────│  { ok: true }
  │                        │                        │
  │── invoke (list) ──────►│── invoke (list) ──────►│  local-db:sessions:list
  │                        │◄─ invoke-result ──────│  [session1, ...]
  │                        │                        │
  │                        │◄── push ──────────────│  local-db:messages:created
  │◄── push ──────────────│                        │  { sessionId, message }
```

### 认证流程

```
Pi Extension              Auth Server              Browser
     │                        │                       │
     │ GET /api/auth/providers│                       │
     │◄─── { social, email }  │                       │
     │                        │                       │
     │ 生成 PKCE + pollSecret │                       │
     │                        │                       │
     │ 打开浏览器 ──────────────────────────────────►│
     │                        │◄── 用户授权 ──────────│
     │                        │                       │
     │ POST /api/auth/desktop/callback/poll           │
     │◄─── { status: "ok", code }                    │
     │                        │                       │
     │ POST /api/auth/token   │                       │
     │◄─── { accessToken, refreshToken, membership }  │
     │                        │                       │
     │ 持久化 refreshToken + accessToken 缓存          │
     │（accessExpiresAt 落盘；启动未过期零网络直连）   │
```

## 文件结构

```
pi-cindy/
├── index.ts                  # 入口: 命令注册 + 生命周期
├── package.json              # ws 依赖
├── install.sh                # npm install 脚本
├── docs/
│   └── DESIGN.md             # 本文件
├── src/
│   ├── types.ts              # Cindy protocol 类型（从 cindy-protocol 复制）
│   ├── tracker.ts            # Pi 生命周期 → store + push
│   ├── auth/
│   │   └── auth-client.ts    # PKCE 登录 + token refresh
│   ├── device-link/
│   │   └── client.ts         # WebSocket 客户端
│   ├── store/
│   │   ├── token-store.ts    # AES-256-GCM token 存储
│   │   └── session-store.ts  # JSON 文件会话/消息存储
│   └── handlers/
│       ├── router.ts         # Invoke 路由 + allowlist
│       ├── sessions.ts       # local-db:sessions:* handler
│       ├── messages.ts       # local-db:messages:* handler
│       └── maker.ts          # maker:* handler
```

## 使用方法

### 安装

```bash
cd ~/.pi/agent/extensions/pi-cindy
npm install
```

### 命令

| 命令 | 描述 |
|---|---|
| `/cindy-login [cn\|global]` | 登录 Cindy 账号（默认 global） |
| `/cindy-logout` | 登出 |
| `/cindy-status` | 查看连接状态 |
| `/cindy-connect` | 手动连接 relay |
| `/cindy-disconnect` | 断开 relay |

### 工具（LLM 可调用）

| 工具 | 描述 |
|---|---|
| `cindy_sync_status` | 查询同步状态 |
| `cindy_send_notification` | 向手机端发送通知 |

## 端点配置

默认端点内置在 `src/types.ts`，实际生产地址需从 Cindy endpoint manifest CDN 获取。

| Region | auth | device-link |
|---|---|---|
| cn | `https://auth.cindy.xd-inc.com` | `wss://device-link.cindy.xd-inc.com` |
| global | `https://auth.cindy.ai` | `wss://device-link.cindy.ai` |

## 数据流

### 会话创建

1. Pi 启动 → `session_start` 事件 → tracker 调用 `createSession()`
2. 写入 `sessions.json`，推 `local-db:sessions:created`
3. 手机端收到 push → 列表刷新 → 显示新会话

### 消息同步

1. Pi agent 回复 → `message_end` 事件 → tracker 调用 `appendMessage()`
2. 写入 `messages/<sid>.json`，推 `local-db:messages:created`
3. 手机端收到 push → 消息流实时更新

### 远程控制

1. 手机端发 `maker:send` → relay 转发 → pi-cindy `routeInvoke()`
2. handler 调用 `pi.sendUserMessage()` 注入 Pi agent
3. 手机端发 `maker:abort-session` → handler 调用 `pi.abort()`

## 待完善

1. ✅ 端点热更新：`src/endpoints.ts` 从 CDN 拉取清单覆盖烘焙默认（2026-08-06 完成，见 CHANGELOG 0.2.0）
2. ✅ authDesktopCallbackUrl 托管回调为主路径（清单字段同时是灰度/回滚开关）；
   为空时回落 RFC 8252 loopback（`src/auth/loopback.ts`，2026-08-06 完成）
3. **消息内容完整同步**: 当前 assistant 消息只推前 500 字符摘要作为 push payload，完整内容通过 `messages:list` 按需拉取
4. **更精确的 topic 路由**: 当前 push 广播给所有 controller + 所有设备，未按 session topic 精确路由
5. **dismissError / resolveInteraction**: 当前为占位实现，Pi 无完整交互审批机制
6. **性能优化**: 大量消息时 JSON 文件读写效率低于 SQLite；可后续迁移到 better-sqlite3

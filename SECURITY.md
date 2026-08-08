# Security Policy

## 报告漏洞

请**不要**在公开 issue 中披露安全漏洞。优先通过 GitHub 私有漏洞报告（Security → Report a vulnerability）提交，或发邮件至 **midmirror@live.com**。

报告请包含：

- 影响版本（npm 版本 / git commit）
- 漏洞类型与严重性评估
- 复现步骤（尽量最小化）
- 实际影响（如涉及 token/凭据泄露，说明泄露面）

## 期望响应

- 24 小时内确认收到
- 常规漏洞 7 天内给修复计划
- 高危（token 泄露 / 未授权远程控制）优先处理

## 安全边界说明

pi-cindy 的威胁模型是**单机隔离**，不承诺超越本机权限边界的安全性：

- token 以 AES-256-GCM 加密存于 `session.enc`，密钥从 hostname+username 派生——真实边界是本机文件权限 0600，**不**宣称加密强于本机隔离（本机同用户进程可读）
- SQLite 数据（会话/消息/所有权/邮箱/实例）均收敛 0600 权限
- `relay-debug.log` 0600 + 1MB 截断，日志不落 token/响应体
- 远程控制可被 `/cindy-revoke <deviceId>` 与 `/cindy-remote off` 关闭（standby 进程经共享 settings + owner 轮询 sweep 兜底）

## 已知边界（非漏洞）

- 输入队列为内存态（进程重启清空，对齐上游 desktop issue #761）
- `node:sqlite` 为 Node experimental API，API 面可能随 Node 版本演进
- 协议以 Cindy 上游为准，上游变更可能导致不兼容

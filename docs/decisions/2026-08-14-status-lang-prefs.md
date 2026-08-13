# 决策：状态栏语言偏好独立存储（ui-prefs.json）

状态：已实施
类别：architecture

## 背景

状态栏文案产品化需要中英双语切换（`/cindy-status-lang [zh|en]`），语言偏好需持久化。
存储位置有多个候选，且与既有 `settings.json`（device-link 语义）相邻。

## 决策

语言偏好存独立文件 `DATA_DIR/ui-prefs.json`（`src/store/ui-prefs-store.ts`）：
0600 原子写（tmp+pid 后缀 rename）+ `loaded` 哨兵进程内缓存（markOnline 每业务帧零读盘）；
默认跟随系统 locale（zh 前缀判断，兼容 zh-TW/HK）。不进入 device-link 语义的 `settings.json`。

## 已考虑的替代方案

### 1. 复用 settings.json 加 `statusLang` 字段（落选）

省一个文件 + 复用既有跨进程锁机制。落选理由：`settings.json` 是 **device-link 语义文件**，
对齐 desktop settings-store 契约（`remoteControlEnabled` + `revokedControllers`，跨进程共享、
mobile 端授权门禁依赖），UI 偏好混入会污染契约边界；且跨进程共享下任一实例改语言影响所有
实例，而状态栏是本进程 UI，跨进程一致无收益。

### 2. 环境变量（如 CINDY_LOCALE）（落选）

零存储成本，且 `resolveSystemLocale` 已支持 CINDY_LOCALE 覆盖。落选理由：不持久化
（用户每次会话要重设）、不可发现（无命令入口）、多实例无法各自设置。

### 3. 仅内存不持久化（落选）

实现最简。落选理由：语言偏好是稳定用户偏好，重启丢失后 `/cindy-status-lang` 设置无意义。

## 后果

- 语言偏好跨进程一致性弱化：另一进程写 ui-prefs.json 不刷新本进程状态栏（新进程/缓存失效后生效）——状态栏是本进程 UI，接受
- 写失败（EACCES/ENOSPC）：`setStatusLang` 清理 tmp 后抛出，命令 handler catch + notify
- 损坏/缺失回落系统 locale（fail-soft：语言偏好无安全含义，不 fail-closed）

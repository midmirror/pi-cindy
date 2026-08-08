/**
 * 排障日志（共享）—— relay-debug.log。
 *
 * 开启方式：`touch ~/.pi/cindy-sync/relay-debug.log` 或设环境变量 `PI_CINDY_DEBUG=1`；
 * 删除文件即关闭（不再被 append 自动重建）。文件权限 0600，超过 1MB 截断重写。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = process.env.PI_CINDY_DATA_DIR
  ?? path.join(os.homedir(), ".pi", "cindy-sync");
const DEBUG_LOG = path.join(DATA_DIR, "relay-debug.log");
const DEBUG_LOG_MAX_BYTES = 1024 * 1024;

export function dbgLog(msg: string): void {
  try {
    if (!process.env.PI_CINDY_DEBUG && !fs.existsSync(DEBUG_LOG)) return;
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    if (fs.existsSync(DEBUG_LOG) && fs.statSync(DEBUG_LOG).size > DEBUG_LOG_MAX_BYTES) {
      fs.truncateSync(DEBUG_LOG, 0);
    }
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 });
    fs.chmodSync(DEBUG_LOG, 0o600); // 存量文件（早期 0644 创建）收敛权限
  } catch { /* 日志失败不影响主流程 */ }
}

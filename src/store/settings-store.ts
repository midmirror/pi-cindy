/**
 * 设备设置存储 —— remoteControlEnabled + revokedControllers（逐设备访问黑名单）。
 * 对齐 desktop settings-store.ts 语义（裁剪：无 keepAwake / 词典同步等扩展项）。
 * JSON 原子写（tmp+rename）+ 0600；门禁侧每次读文件（settings 极小，一致性优先于 IO）。
 *
 * 多进程安全（v0.3.0 起多 pi 进程共享数据目录，settings 是跨进程共享文件）：
 * - 写路径带锁文件 + pid 后缀 tmp（修：曾固定 `settings.json.tmp` + 锁外 read-modify-write，
 *   并发写互相覆盖 tmp、丢键）。
 * - 损坏文件 fail-closed（修：曾 fail-open 回落 remoteControlEnabled=true + 空黑名单，
 *   已撤销控制器静默重新武装）。缺失文件（全新安装）回落默认值。
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./db.js";
import { dbgLog } from "../dbg.js";

const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const LOCK_FILE = `${SETTINGS_FILE}.lock`;
/** 锁竞争重试：20ms × 50 ≈ 1s；超时放弃加锁（仍原子写，退化为 last-writer-wins）。 */
const LOCK_RETRY_MS = 20;
const LOCK_RETRIES = 50;
/** 锁文件超过该时长视为残留（写进程崩溃遗留），强制接管。 */
const LOCK_STALE_MS = 2_000;

export interface DeviceLinkSettings {
  /** 全局被控开关：false 时全部控制端被拒（REMOTE_DISABLED）。 */
  remoteControlEnabled: boolean;
  /** 逐设备访问黑名单：被撤销访问权限的控制端 deviceId 列表。 */
  revokedControllers: string[];
}

const DEFAULTS: DeviceLinkSettings = { remoteControlEnabled: true, revokedControllers: [] };

function defaults(): DeviceLinkSettings {
  return { ...DEFAULTS, revokedControllers: [...DEFAULTS.revokedControllers] };
}

/**
 * 内部读取：带 degraded 标志——true 表示文件损坏/不可读，返回 fail-closed 基座
 * （remoteControlEnabled=false）。写路径据此记录可观测告警：在损坏基座上执行
 * /cindy-revoke 等更新会把 fail-closed 的 remote=false 一并持久化（安全方向，
 * 但用户应知道为什么 Remote 关了）。
 */
function readSettingsRaw(): { settings: DeviceLinkSettings; degraded: boolean } {
  let raw: string;
  try {
    raw = fs.readFileSync(SETTINGS_FILE, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { settings: defaults(), degraded: false }; // 缺失（全新安装）→ 默认值
    // 其它读取错误（EACCES/权限回收等）：文件内容不可得 = 意图不可知 → fail-closed
    // （修：曾与 ENOENT 同栏 fail-open，黑名单静默失效）
    dbgLog(`settings unreadable (${code ?? (err instanceof Error ? err.message : String(err))}) — failing closed`);
    return { settings: { remoteControlEnabled: false, revokedControllers: [] }, degraded: true };
  }
  try {
    const o = JSON.parse(raw) as Partial<DeviceLinkSettings>;
    return {
      settings: {
        remoteControlEnabled: o.remoteControlEnabled !== false, // 缺省 true（保持兼容）
        revokedControllers: Array.isArray(o.revokedControllers)
          ? o.revokedControllers.filter((x): x is string => typeof x === "string")
          : [],
      },
      degraded: false,
    };
  } catch {
    // 损坏：fail-closed——黑名单/开关意图不可知时禁止被控（修：曾 fail-open 重新武装
    // 已撤销控制器）。/cindy-remote on 等命令路径重写文件后可自愈；缺失文件不受影响。
    dbgLog(`settings.json corrupt — failing closed (remote control disabled): ${SETTINGS_FILE}`);
    return { settings: { remoteControlEnabled: false, revokedControllers: [] }, degraded: true };
  }
}

export function readDeviceLinkSettings(): DeviceLinkSettings {
  return readSettingsRaw().settings;
}

/** 同步睡眠（Atomics.wait 主线程安全，避免忙等烧 CPU）。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 跨进程写锁：`wx` 独占创建锁文件，争用重试 + 陈旧锁接管。
 * 无锁路径兜底（超时）：仍原子写，最坏 last-writer-wins。
 */
function withSettingsLock<T>(fn: () => T): T {
  let fd: number | null = null;
  for (let i = 0; i < LOCK_RETRIES; i++) {
    try {
      fd = fs.openSync(LOCK_FILE, "wx", 0o600);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // 陈旧锁（写进程崩溃遗留）：超龄直接接管
      try {
        const st = fs.statSync(LOCK_FILE);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          try { fs.unlinkSync(LOCK_FILE); } catch { /* ok */ }
          continue;
        }
      } catch { continue; } // stat 失败（锁已被删）：下一轮重试
      sleepSync(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ok */ }
      try { fs.unlinkSync(LOCK_FILE); } catch { /* ok */ }
    }
  }
}

/**
 * 锁内基于盘上最新值追加/移除（对齐 desktop updateDeviceLinkSetting：不得锁外预计算整数组）。
 * tmp 名带 pid：并发写各自独立 tmp，rename 互不覆盖。
 */
export function updateDeviceLinkSetting<K extends keyof DeviceLinkSettings>(
  key: K,
  updater: (latest: DeviceLinkSettings[K]) => DeviceLinkSettings[K],
): DeviceLinkSettings {
  return withSettingsLock(() => {
    const { settings: cur, degraded } = readSettingsRaw();
    const next: DeviceLinkSettings = { ...cur, [key]: updater(cur[key]) };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${SETTINGS_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, SETTINGS_FILE);
    if (degraded) {
      // 在损坏/不可读基座上更新：fail-closed 的 remote=false 被一并持久化（安全方向）。
      // 明示出来——用户跑 /cindy-revoke 可能意外看到 Remote 变 off。
      dbgLog(`settings base was corrupt/unreadable — update persisted fail-closed defaults; run /cindy-remote on to re-enable`);
    }
    return next;
  });
}

/** 该控制端是否在撤销黑名单内（对齐 desktop isControllerRevoked）。 */
export function isControllerRevoked(deviceId: string): boolean {
  return readDeviceLinkSettings().revokedControllers.includes(deviceId);
}

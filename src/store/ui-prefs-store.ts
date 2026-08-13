/**
 * UI 偏好存储 —— 目前仅状态栏语言（statusLang）。
 * 与 settings.json（device-link 语义，对齐 desktop 契约，跨进程共享）分离：
 * 语言是本地 UI 偏好，不参与设备控制契约，独立文件避免污染 device-link settings。
 * JSON 原子写（tmp+rename）+ 0600；缺失/损坏回落跟随系统 locale（fail-soft：
 * 语言偏好丢失无安全含义，不 fail-closed）。
 *
 * 性能（v0.6.0）：显式设置值进程内缓存——markOnline 每业务帧调 readStatusLang，
 * 不能每帧读盘；无显式设置时走 env 解析（纯内存无 I/O）。跨进程显式变更仅
 * 新进程/缓存失效后生效：状态栏是本进程 UI，另一进程写文件不会刷新本进程状态条，
 * "逐帧读盘保跨进程一致性"不划算。
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./db.js";
import { dbgLog } from "../dbg.js";
import { resolveSystemLocale } from "../auth/auth-client.js";

const PREFS_FILE = path.join(DATA_DIR, "ui-prefs.json");

export type StatusLang = "zh" | "en";

interface UiPrefs {
  /** 显式设置的状态栏语言；缺省时跟随系统 locale。 */
  statusLang?: StatusLang;
}

/** 显式设置值的进程内缓存；loaded 区分「未加载」与「无显式设置」——后者仍需缓存
 *  结果（env 解析），否则每次读盘（markOnline 每帧调用即热路径 I/O）。 */
let cachedExplicit: StatusLang | null = null;
let loaded = false;

/** 系统 locale 是否中文（resolveSystemLocale 回落 'en'；env 直通值可能为 zh-TW/zh-HK）。 */
function systemPrefersZh(): boolean {
  const locale = resolveSystemLocale();
  return locale === "zh-CN" || locale.startsWith("zh");
}

/** 盘上显式设置值；缺失/损坏/无有效字段返回 null（不缓存失败态，下次重读）。 */
function readExplicitStatusLang(): StatusLang | null {
  try {
    const raw = fs.readFileSync(PREFS_FILE, "utf8");
    const o = JSON.parse(raw) as Partial<UiPrefs>;
    if (o.statusLang === "zh" || o.statusLang === "en") return o.statusLang;
    return null; // 文件存在但无有效字段
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      dbgLog(`ui-prefs unreadable/corrupt — falling back to system locale: ${String(code ?? err)}`);
    }
    return null; // ENOENT（全新安装）与损坏统一回落
  }
}

/**
 * 当前状态栏语言：显式设置优先（进程内缓存，零 I/O），否则跟随系统 locale（env 解析，无 I/O）。
 */
export function readStatusLang(): StatusLang {
  if (loaded) return cachedExplicit ?? (systemPrefersZh() ? "zh" : "en");
  loaded = true;
  cachedExplicit = readExplicitStatusLang();
  return cachedExplicit ?? (systemPrefersZh() ? "zh" : "en");
}

/** 显式设置状态栏语言并持久化（tmp+rename 原子写，无跨进程锁——语言无并发语义）。
 *  写失败：清理 tmp 后抛出，由调用方（命令 handler）提示用户。 */
export function setStatusLang(lang: StatusLang): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${PREFS_FILE}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ statusLang: lang }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, PREFS_FILE);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* rename 已移动或从未创建 */ }
  }
  cachedExplicit = lang;
  loaded = true;
}

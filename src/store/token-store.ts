/**
 * Token 持久化 —— AES-256-GCM 加密，key 从 hostname+username 派生
 * 不依赖 Electron safeStorage。
 *
 * 威胁模型说明：派生 key 不含秘密材料（hostname:username 本机可复现），
 * 加密的实际保护边界是文件权限 0600 —— 防「其他本地用户/跨机器拷贝」，
 * 不防同用户进程（同用户可读 ~/.pi 目录）。与 desktop safeStorage 的
 * 系统级密钥环保护不同，如需更强保护应迁移 OS keyring（libsecret 等）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AuthSessionRecord } from "../types.js";

// 尊重 PI_CINDY_DATA_DIR（与 db.ts DATA_DIR 同源）：测试/隔离环境把 session.enc
// 与 SQLite 一起放进隔离目录，绝不触碰真实登录态。此前硬编码 ~/.pi/cindy-sync
// 导致冒烟测试的 logout()/saveSession()/clearSession() 全部作用在真实 session.enc
// 上——每次 npm test 都删真实登录态（EXPERIENCE #45）。
/** 无环境覆盖时的默认数据目录（导出供测试快照同源引用，防路径迁移后测试静默校验错路径）。 */
export const DEFAULT_DIR = path.join(os.homedir(), ".pi", "cindy-sync");
const DIR = process.env.PI_CINDY_DATA_DIR ?? DEFAULT_DIR;
const FILE = path.join(DIR, "session.enc");

function ensureDir() { fs.mkdirSync(DIR, { recursive: true }); }

function deriveKey(): Buffer {
  const seed = `${os.hostname()}:${os.userInfo().username}:pi-cindy-v1`;
  return crypto.createHash("sha256").update(seed).digest();
}

function encrypt(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let enc = cipher.update(plaintext, "utf8", "hex");
  enc += cipher.final("hex");
  const tag = cipher.getAuthTag();
  return JSON.stringify({ iv: iv.toString("hex"), tag: tag.toString("hex"), data: enc });
}

function decrypt(raw: string): string {
  const key = deriveKey();
  const { iv, tag, data } = JSON.parse(raw);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  let dec = decipher.update(data, "hex", "utf8");
  dec += decipher.final("utf8");
  return dec;
}

export function saveSession(session: AuthSessionRecord): void {
  ensureDir();
  fs.writeFileSync(FILE, encrypt(JSON.stringify(session)), { mode: 0o600 });
}

export function loadSession(): AuthSessionRecord | null {
  try { return JSON.parse(decrypt(fs.readFileSync(FILE, "utf8"))); } catch { return null; }
}

export function clearSession(): void {
  try { fs.unlinkSync(FILE); } catch { /* ok */ }
}

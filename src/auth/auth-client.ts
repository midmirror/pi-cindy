/**
 * Cindy 认证客户端 —— PKCE + 托管回调流程
 * 复制自 @cindy/auth-client 核心逻辑，适配 Node.js 环境。
 */
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { saveSession, loadSession, clearSession } from "../store/token-store.js";
import { getEndpoint } from "../endpoints.js";
import { startLoopbackListener } from "./loopback.js";
import { dbgLog } from "../dbg.js";
import { type TokenPair } from "../types.js";

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function b64url(buf: Buffer) { return buf.toString("base64url"); }

// ---------- 类型 ----------

export type SocialProvider = "apple" | "google";

export interface ProviderConfig {
  region: string;
  social: string[];
  email: boolean;
  phone: boolean;
}

export interface AccountSummary {
  id: string;
  displayName: string;
  email: string | null;
  kind: string;
  role: string;
  orgName: string | null;
}

export type EmailLoginOutcome =
  | { status: "ok"; pair: TokenPair }
  | { status: "select_account"; loginTicket: string; accounts: AccountSummary[] }
  | { status: "binding_required"; bindType: "phone" | "email"; bindTicket: string };

export class AuthApiError extends Error {
  constructor(public code: string, public statusCode: number, message: string) {
    super(message); this.name = "AuthApiError";
  }
}

/**
 * 刷新/登录响应的 token 对防御性校验（修：曾无条件落盘——服务端异常或端点漂移时
 * 返回畸形 token（真机复现 refreshToken="rt"），直接覆盖 session.enc 把好 token
 * 冲掉 → 永久 401 INVALID_REFRESH_TOKEN，只能重新登录）。真实 refresh token 是
 * 长串（JWT/opaque），<16 字符必然是垃圾，拒绝保存。
 *
 * 守卫只断言实际落盘/缓存消费的字段（accessToken + refreshToken），**不校验**
 * TokenPair.membership——本仓无 membership 消费方（grep 验证），且刷新/换码响应
 * 可能不含该字段；返回类型收窄为 AuthTokenPair 而非 TokenPair，避免类型撒谎。
 */
export interface AuthTokenPair {
  accessToken: string;
  refreshToken: string;
}
export function isValidTokenPair(pair: unknown): pair is AuthTokenPair {
  if (!pair || typeof pair !== "object") return false;
  const p = pair as Record<string, unknown>;
  return typeof p.accessToken === "string" && p.accessToken.length >= 16
    && typeof p.refreshToken === "string" && p.refreshToken.length >= 16;
}

/** 连续畸形刷新响应计数：单次畸形只跳过落盘；达到上限判定「服务端持续异常」→ 清会话强制重登。 */
let consecutiveMalformedCount = 0;
/** 连续畸形响应上限（配合 isValidTokenPair）。 */
const MALFORMED_RESPONSE_LIMIT = 3;

async function apiFetch(baseUrl: string, path: string, opts: {
  method?: string; body?: unknown; token?: string; timeoutMs?: number;
} = {}): Promise<unknown> {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetch(url, {
      method: opts.method ?? (opts.body ? "POST" : "GET"),
      headers, body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let code = "UNKNOWN";
      try { const e = JSON.parse(text); code = e.error?.code || e.code || `HTTP_${res.status}`; } catch {}
      throw new AuthApiError(code, res.status, text.slice(0, 200));
    }
    return res.json();
  } finally { clearTimeout(timeout); }
}

// Token 缓存
let cachedToken: string | null = null;
let cachedExp = 0;
/** 缓存代数：logout 递增，在途 refresh 完成时代数不匹配则不落盘（防登出后被在途刷新重新写回）。 */
let cacheGeneration = 0;
/** 在途 refresh promise：并发 getAccessToken 复用同一次刷新，防 refresh-token 轮转竞争（对齐 desktop authManager）。 */
let refreshInFlight: Promise<string | null> | null = null;

export async function getAccessToken(realm: "cn" | "global" = "global"): Promise<string | null> {
  if (cachedToken && Date.now() < cachedExp - 60_000) return cachedToken;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const session = loadSession();
    if (!session) return null;
    const r = session.realm || realm;
    const gen = cacheGeneration;
    try {
      const pair = await refreshToken(r, session.refreshToken);
      if (gen !== cacheGeneration) return null; // 期间已登出：不写回
      // 畸形响应不落盘（见 isValidTokenPair）：保留现状，靠重新登录恢复
      if (!isValidTokenPair(pair)) {
        // 单次畸形只跳过落盘（保留好 token，等下次刷新）；连续 N 次 → 服务端持续异常，
        // 同 401 处理：清会话强制重新登录（否则每轮刷新都全量往返拿垃圾、静默失败无恢复路径）。
        consecutiveMalformedCount += 1;
        dbgLog(`auth refresh malformed (${r}) ${consecutiveMalformedCount}/${MALFORMED_RESPONSE_LIMIT} — keep session`);
        if (consecutiveMalformedCount >= MALFORMED_RESPONSE_LIMIT) {
          consecutiveMalformedCount = 0;
          // 与 401 分支对称：内存缓存一并失效。此时缓存必已过期（刷新只在缓存过期后
          // 才发起），清空是状态一致性收口，不改变既有服务窗口。
          cachedToken = null; cachedExp = 0;
          dbgLog(`auth refresh malformed x${MALFORMED_RESPONSE_LIMIT} (${r}) — clearing session (server persistently broken)`);
          clearSession();
        }
        return null;
      }
      consecutiveMalformedCount = 0; // 成功刷新：计数复位
      saveSession({ version: 1, realm: r, refreshToken: pair.refreshToken });
      dbgLog(`auth refresh ok (${r})`);
      cachedToken = pair.accessToken;
      try {
        const payload = JSON.parse(Buffer.from(pair.accessToken.split(".")[1], "base64url").toString());
        cachedExp = payload.exp * 1000;
      } catch { cachedExp = Date.now() + 3600_000; }
      return cachedToken;
    } catch (err) {
      cachedToken = null;
      cachedExp = 0;
      // refresh token 家族已失效（撤销/轮换被拒）：清会话强制重新登录。
      // 瞬态网络错误（fetch failed / timeout）不清——避免断网误登出。
      if (err instanceof AuthApiError
        && (err.code === "INVALID_REFRESH_TOKEN" || err.statusCode === 401)) {
        consecutiveMalformedCount = 0; // 会话已清，计数归零
        dbgLog(`auth refresh 401 (${r}) code=${err.code} status=${err.statusCode} — clearing session (token family revoked)`);
        clearSession();
      } else {
        // 只打 code/status 或错误类型，不打 err.message——AuthApiError.message 是服务端
        // 响应体前 200 字符，错误响应若回显请求体（含 refreshToken/deviceId）会泄进
        // relay-debug.log（EXPERIENCE #46）。
        if (err instanceof AuthApiError) {
          dbgLog(`auth refresh failed (${r}) code=${err.code} status=${err.statusCode}`);
        } else {
          dbgLog(`auth refresh failed (${r}) type=${(err as Error)?.constructor?.name ?? "unknown"}`);
        }
      }
      return null;
    }
  })();
  try { return await refreshInFlight; }
  finally { refreshInFlight = null; }
}

/** 解析系统 locale（对齐参考仓 shared/locale 的 SUPPORTED_LOCALES；缺省回落 'en'）。 */
export function resolveSystemLocale(): string {
  const fromEnv = process.env.CINDY_LOCALE;
  if (fromEnv) return fromEnv;
  const lang = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "";
  const m = lang.match(/^([a-z]{2})[_-]/i);
  if (m) {
    const code = m[1].toLowerCase();
    if (code === "zh") return "zh-CN";
    if (code === "ja") return "ja";
    if (code === "ko") return "ko";
    return "en";
  }
  return "en";
}

async function refreshToken(realm: "cn" | "global", refreshToken: string): Promise<AuthTokenPair> {
  const baseUrl = getEndpoint(realm, "authApiBaseUrl");
  const deviceId = getDeviceId();
  return apiFetch(baseUrl, "/api/auth/refresh", {
    method: "POST",
    body: { refreshToken, deviceId },
  }) as Promise<AuthTokenPair>;
}

/** 拉取当前区域的可用登录方式（social 列表 + email/phone 开关）。 */
export async function getProviders(realm: "cn" | "global"): Promise<ProviderConfig> {
  const baseUrl = getEndpoint(realm, "authApiBaseUrl");
  return await apiFetch(baseUrl, "/api/auth/providers") as ProviderConfig;
}

function savePair(realm: "cn" | "global", pair: AuthTokenPair) {
  // 登录/换码响应同样防御性校验：畸形 pair 不落盘（防止 session.enc 被垃圾 token 冲掉）
  if (!isValidTokenPair(pair)) {
    throw new AuthApiError("INVALID_TOKEN_RESPONSE", 502, "auth 响应缺少有效 token 对");
  }
  consecutiveMalformedCount = 0; // 新 token 族 = 新计数起点（修：曾残留旧 streak，重登后首刷畸形即误触上限清会话）
  cacheGeneration += 1; // 使在途 refresh 结果失效（修：登录/换码与在途刷新并发时旧刷新会覆盖新会话）
  saveSession({ version: 1, realm, refreshToken: pair.refreshToken });
  cachedToken = pair.accessToken;
  try {
    const payload = JSON.parse(Buffer.from(pair.accessToken.split(".")[1], "base64url").toString());
    cachedExp = payload.exp * 1000;
  } catch { cachedExp = Date.now() + 3600_000; }
}

function assertSocialAvailable(providers: ProviderConfig, provider: SocialProvider): void {
  if (!providers.social.includes(provider)) {
    throw new AuthApiError(
      "PROVIDER_UNAVAILABLE", 400,
      `Social provider "${provider}" not available in ${providers.region} region (available: ${providers.social.join(", ") || "none"})`,
    );
  }
}

/**
 * 社交登录（PKCE + 托管回调轮询）。provider 显式指定，不再默认取 social[0]。
 * email 登录走 requestEmailCode + completeEmailLogin，不经此函数。
 */
export async function login(realm: "cn" | "global", provider: SocialProvider): Promise<void> {
  const baseUrl = getEndpoint(realm, "authApiBaseUrl");
  const deviceId = getDeviceId();

  const providers = await getProviders(realm);
  assertSocialAvailable(providers, provider);
  const codeVerifier = b64url(crypto.randomBytes(32));
  const codeChallenge = b64url(crypto.createHash("sha256").update(codeVerifier).digest());
  const pollSecret = b64url(crypto.randomBytes(32));
  const clientState = b64url(crypto.createHash("sha256").update(pollSecret).digest());

  const authorizeUrl = new URL(`${baseUrl}/api/auth/social/${provider}/authorize`);
  authorizeUrl.searchParams.set("client_type", "desktop");
  authorizeUrl.searchParams.set("device_id", deviceId);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("client_state", clientState);
  const locale = resolveSystemLocale();
  authorizeUrl.searchParams.set("ui_locale", locale);

  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";

  // 托管回调（callbackUrl 非空）→ 轮询 auth-server 取码；空 → RFC 8252 loopback 回落
  // （对齐参考 authManager.openSystemBrowserAuthorization 的分流；callbackUrl 同时是
  //  灰度/回滚开关：服务端出问题时清空清单字段即回退 loopback）。
  const cb = getEndpoint(realm, "authDesktopCallbackUrl");
  if (cb) {
    authorizeUrl.searchParams.set("redirect_uri", cb);
  } else {
    // 先起 listener 拿端口，再开浏览器（对齐 openLoopbackBrowserAuthorization 的顺序）。
    const listener = await startLoopbackListener(clientState, 300_000);
    authorizeUrl.searchParams.set("redirect_uri", listener.redirectUri);
    exec(`${cmd} "${authorizeUrl.toString()}"`);
    const lr = await listener.result;
    if (!("code" in lr)) {
      throw new Error(`Login failed: loopback ${lr.error}`);
    }
    const pair = await apiFetch(baseUrl, "/api/auth/token", {
      method: "POST",
      body: { grantType: "authorization_code", code: lr.code, codeVerifier, deviceId },
    }) as AuthTokenPair;
    savePair(realm, pair);
    return;
  }

  exec(`${cmd} "${authorizeUrl.toString()}"`);

  let code: string | null = null;
  const start = Date.now();
  let consecutiveFailures = 0;
  while (!code && Date.now() - start < 300_000) {
    await sleep(2000);
    let poll: { status: string; code?: string; error?: string };
    try {
      poll = await apiFetch(baseUrl, "/api/auth/desktop/callback/poll", {
        method: "POST", body: { pollSecret, deviceId },
      }) as { status: string; code?: string; error?: string };
      consecutiveFailures = 0;
    } catch (err) {
      // 服务端明确拒绝(AuthApiError) = 定论,立即失败;传输层抖动(TypeError 等)累计 8 次才放弃,
      // 与 desktop 的连续失败预算对齐。
      if (err instanceof AuthApiError) throw err;
      consecutiveFailures += 1;
      if (consecutiveFailures >= 8) throw new Error(`Login failed: poll error (${(err as Error)?.message ?? String(err)})`);
      continue;
    }
    if (poll.status === "ok" && poll.code) { code = poll.code; break; }
    // 定论状态不再吞掉:立即报错,而不是干等到 5 分钟超时。
    if (poll.status === "expired") throw new Error("Login failed: authorization expired, please retry");
    if (poll.status === "error") throw new Error(`Login failed: ${poll.error ?? "authorization error"}`);
  }
  if (!code) throw new Error("Login timed out");

  const pair = await apiFetch(baseUrl, "/api/auth/token", {
    method: "POST",
    body: { grantType: "authorization_code", code, codeVerifier, deviceId },
  }) as AuthTokenPair;

  savePair(realm, pair);
}

/** 发送邮箱验证码（带 locale，对齐参考 auth-client requestEmailCode）。 */
export async function requestEmailCode(realm: "cn" | "global", email: string): Promise<void> {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthApiError("INVALID_EMAIL", 400, "Invalid email address");
  }
  const baseUrl = getEndpoint(realm, "authApiBaseUrl");
  await apiFetch(baseUrl, "/api/auth/email/request-code", {
    method: "POST",
    body: { email, locale: resolveSystemLocale() },
  });
}

function parseEmailOutcome(raw: any): EmailLoginOutcome {
  if (!raw || typeof raw !== "object") {
    throw new AuthApiError("INVALID_RESPONSE", 0, "Unexpected verify-code response");
  }
  switch (raw.status) {
    case "ok":
      return { status: "ok", pair: raw };
    case "select_account": {
      const accounts: AccountSummary[] = (raw.accounts ?? []).map((a: any) => ({
        id: a.id, displayName: a.displayName, email: a.email ?? null,
        kind: a.kind, role: a.role, orgName: a.orgName ?? null,
      }));
      return { status: "select_account", loginTicket: raw.loginTicket, accounts };
    }
    case "binding_required":
      return { status: "binding_required", bindType: raw.bindType, bindTicket: raw.bindTicket };
    default:
      throw new AuthApiError("INVALID_RESPONSE", 0, `Unexpected verify-code status: ${raw.status}`);
  }
}

/** 用邮箱+验证码完成登录；可能返回 select_account 需要二次选择账号。 */
export async function completeEmailLogin(
  realm: "cn" | "global", email: string, code: string,
): Promise<EmailLoginOutcome> {
  const baseUrl = getEndpoint(realm, "authApiBaseUrl");
  const deviceId = getDeviceId();
  const raw = await apiFetch(baseUrl, "/api/auth/email/verify-code", {
    method: "POST",
    body: { email, code, deviceId, clientType: "desktop" },
  });
  const outcome = parseEmailOutcome(raw);
  if (outcome.status === "ok") savePair(realm, outcome.pair);
  return outcome;
}

/** select_account 二次选择账号。 */
export async function selectAccount(
  realm: "cn" | "global", loginTicket: string, accountId: string,
): Promise<EmailLoginOutcome> {
  const baseUrl = getEndpoint(realm, "authApiBaseUrl");
  const deviceId = getDeviceId();
  const raw = await apiFetch(baseUrl, "/api/auth/select-account", {
    method: "POST",
    body: { loginTicket, accountId, deviceId },
  });
  const outcome = parseEmailOutcome(raw);
  if (outcome.status === "ok") savePair(realm, outcome.pair);
  return outcome;
}

/**
 * 绑定验证码发送（账号需绑定场景，对齐参考 auth-client requestBindingCode）。
 * bindType 从 binding_required outcome 的 bindType 字段来（"email" | "phone"）。
 */
export async function requestBindingCode(
  realm: "cn" | "global",
  bindTicket: string,
  bindType: "email" | "phone",
  contact: string,
): Promise<void> {
  const baseUrl = getEndpoint(realm, "authApiBaseUrl");
  await apiFetch(baseUrl, "/api/auth/binding/request-code", {
    method: "POST",
    body: { bindTicket, [bindType]: contact, locale: resolveSystemLocale() },
  });
}

/** 验证绑定并完成登录；可能继续返回 select_account / binding_required（复用 parseEmailOutcome）。 */
export async function verifyBinding(
  realm: "cn" | "global",
  bindTicket: string,
  bindType: "email" | "phone",
  contact: string,
  code: string,
): Promise<EmailLoginOutcome> {
  const baseUrl = getEndpoint(realm, "authApiBaseUrl");
  const deviceId = getDeviceId();
  const raw = await apiFetch(baseUrl, "/api/auth/binding/verify", {
    method: "POST",
    body: { bindTicket, [bindType]: contact, code, deviceId },
  });
  const outcome = parseEmailOutcome(raw);
  if (outcome.status === "ok") savePair(realm, outcome.pair);
  return outcome;
}

export async function logout(): Promise<void> {
  const token = cachedToken;
  const session = loadSession();
  cacheGeneration += 1; // 使在途 refresh 结果失效（不落盘）
  cachedToken = null; cachedExp = 0; clearSession();
  consecutiveMalformedCount = 0; // 登出即全新起点
  if (token && session) {
    // 按会话实际 realm 登出（修：曾恒打 global 端点，cn 会话登出错区）
    const baseUrl = getEndpoint(session.realm, "authApiBaseUrl");
    try {
      await apiFetch(baseUrl, "/api/auth/logout", {
        method: "POST", body: {}, token,
      });
    } catch { /* ok */ }
  }
}

export function isLoggedIn(): boolean { return loadSession() !== null; }

export function getDeviceId(): string {
  const { loadOrCreateDeviceId } = require("../store/session-store.js");
  return loadOrCreateDeviceId();
}

/**
 * 端点热更新 —— 从 Cindy CDN 拉取客户端端点清单（`<hotfix CDN base>/endpoint.json`）。
 *
 * 契约源：参考仓 `packages/maker-shared/src/clientEndpoints.ts`（解析/校验语义）
 * + `apps/desktop/src/main/clientEndpointsService.ts`（宿主加载）。本模块只做
 * 纯逻辑解析（无 IO），fetch 在 `refreshEndpoints()`。
 *
 * 语义对齐参考：
 *  - 清单即唯一事实源：非空 endpoint 值必须合法（URL 可解析、协议白名单、无凭据），
 *    非法值整份拒绝（配置错要炸出来，不静默猜测）；
 *  - 字段缺失/空白 → 解析为 `''` 不阻断；未知字段忽略（向前兼容）；尾斜杠归一；
 *  - schemaVersion 缺失/非正整数/大于支持版本 → 整份拒绝；
 *  - 与 desktop packaged 的差异（有意保留，见 EXPERIENCE）：extension 场景拉取
 *    失败**不阻断**（烘焙默认值兜底 + relay-debug.log 记录），而非弹错误框要求重试
 *    —— 阻断整个 Pi 启动对 extension 不可接受；desktop 的「缓存回退」同样不采用
 *    （避免缓存文件被写导致的信任面，拉取失败直接退回烘焙值）。
 */
import { DEFAULT_ENDPOINTS } from "./types.js";
import { dbgLog } from "./dbg.js";

export type EndpointRealm = "cn" | "global";

/** 清单字段全集（对齐参考仓 CLIENT_ENDPOINT_KEYS）；不消费的字段也解析，保持严格语义。 */
export const CLIENT_ENDPOINT_KEYS = [
  "authApiBaseUrl",
  "authDesktopCallbackUrl",
  "deviceLinkApiBaseUrl",
  "oauthBrokerApiBaseUrl",
  "ossApiBaseUrl",
  "heartbeatUrl",
  "telegramHookWsUrl",
  "xHookWsUrl",
  "slackHookWsUrl",
  "websiteUrl",
  "modelAccessApiBaseUrl",
  "voiceApiBaseUrl",
  "githubApiBaseUrl",
  "skillhubApiBaseUrl",
  "pluginApiBaseUrl",
  "cdnBaseUrl",
  "mobileUpdateBaseUrl",
] as const;
export type ClientEndpointKey = (typeof CLIENT_ENDPOINT_KEYS)[number];
export type EndpointMap = Record<string, string>;

/** 支持的最高 schemaVersion（对齐参考仓 CLIENT_ENDPOINTS_SCHEMA_VERSION）。 */
export const CLIENT_ENDPOINTS_SCHEMA_VERSION = 1;

/** 烘焙 hotfix CDN 基址（自举用；参考仓 dev 模式读仓内正本，packaged 走 CDN）。 */
export const MANIFEST_BASE_URLS: Record<EndpointRealm, string> = {
  cn: "https://hotfix.cindy.com.cn/cindy",
  global: "https://hotfix.cindy.app/cindy",
};
const MANIFEST_FILE_NAME = "endpoint.json";

/** 各字段允许的 URL 协议白名单（对齐参考仓 FIELD_PROTOCOLS）。 */
const FIELD_PROTOCOLS: Record<string, readonly string[]> = {
  authApiBaseUrl: ["https:"],
  authDesktopCallbackUrl: ["https:"],
  deviceLinkApiBaseUrl: ["https:"],
  oauthBrokerApiBaseUrl: ["https:"],
  ossApiBaseUrl: ["https:"],
  heartbeatUrl: ["https:"],
  telegramHookWsUrl: ["wss:"],
  xHookWsUrl: ["wss:"],
  slackHookWsUrl: ["wss:"],
  websiteUrl: ["https:"],
  modelAccessApiBaseUrl: ["https:"],
  voiceApiBaseUrl: ["https:"],
  githubApiBaseUrl: ["https:"],
  skillhubApiBaseUrl: ["https:"],
  pluginApiBaseUrl: ["https:"],
  cdnBaseUrl: ["https:"],
  mobileUpdateBaseUrl: ["https:"],
};

// 去尾部斜杠（不用 /\/+$/ 正则，避免超长 '/' 串 O(n²) 回溯）。
function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0x2f) end -= 1;
  return s.slice(0, end);
}

export type ParseManifestResult =
  | { ok: true; endpoints: EndpointMap }
  | { ok: false; reason: string };

/**
 * 解析并校验一份清单原文。纯函数，输入任意文本不抛出。
 * 端点缺失/空白写入 `''` 继续；非空值校验 URL、协议与凭据。
 */
export function parseClientEndpointManifest(rawText: string): ParseManifestResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not-an-object" };
  }
  const record = parsed as Record<string, unknown>;

  const schemaVersion = record.schemaVersion;
  if (
    typeof schemaVersion !== "number" ||
    !Number.isInteger(schemaVersion) ||
    schemaVersion < 1
  ) {
    return { ok: false, reason: "invalid-schema-version" };
  }
  if (schemaVersion > CLIENT_ENDPOINTS_SCHEMA_VERSION) {
    return { ok: false, reason: `unsupported-schema-version:${schemaVersion}` };
  }

  const endpoints: EndpointMap = {};
  for (const key of CLIENT_ENDPOINT_KEYS) {
    const raw = record[key];
    if (raw === undefined || (typeof raw === "string" && !raw.trim())) {
      endpoints[key] = "";
      continue;
    }
    if (typeof raw !== "string") {
      return { ok: false, reason: `invalid-field:${key}` };
    }
    const normalized = trimTrailingSlashes(raw.trim());
    let url: URL;
    try {
      url = new URL(normalized);
    } catch {
      return { ok: false, reason: `invalid-field:${key}` };
    }
    if (!FIELD_PROTOCOLS[key].includes(url.protocol)) {
      return { ok: false, reason: `invalid-protocol:${key}` };
    }
    if (url.username || url.password) {
      return { ok: false, reason: `credentials-in-url:${key}` };
    }
    endpoints[key] = normalized;
  }

  // 可选 review 字段：存在但非 string 视为配置错（对齐参考仓）；缺失即忽略。
  const rawReview = record.review;
  if (rawReview !== undefined && typeof rawReview !== "string") {
    return { ok: false, reason: "invalid-field:review" };
  }

  return { ok: true, endpoints };
}

// ---------- 生效端点（烘焙默认 + 清单覆盖） ----------

/** 解析成功后的清单覆盖（按 region）；未拉取/失败时为空 → 全走烘焙默认。 */
const overrides: Partial<Record<EndpointRealm, EndpointMap>> = {};

/** 当前生效端点：清单覆盖优先，缺失字段回落到烘焙默认。 */
export function getEndpoint(realm: EndpointRealm, key: string): string {
  const ov = overrides[realm];
  const baked = DEFAULT_ENDPOINTS[realm];
  return (ov && ov[key]) || baked[key] || "";
}

let refreshInFlight: Promise<void> | null = null;


async function fetchManifest(realm: EndpointRealm): Promise<ParseManifestResult> {
  const url = `${MANIFEST_BASE_URLS[realm]}/${MANIFEST_FILE_NAME}`;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15_000); // 对齐参考 ATTEMPT_TIMEOUT_MS
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    const text = await res.text();
    return parseClientEndpointManifest(text);
  } catch (err) {
    return { ok: false, reason: (err as Error)?.name === "AbortError" ? "timeout" : "fetch-failed" };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 拉取两个 region 的清单并替换生效端点。single-flight；失败保留烘焙默认 + 日志，
 * 不抛出（extension 不阻断）。调用方可 fire-and-forget 或 await（内部带超时）。
 */
export function refreshEndpoints(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const results = await Promise.all([
      fetchManifest("cn"),
      fetchManifest("global"),
    ]);
    const realms: EndpointRealm[] = ["cn", "global"];
    realms.forEach((realm, i) => {
      const r = results[i];
      if (r.ok) {
        overrides[realm] = r.endpoints;
        dbgLog(`endpoints refreshed (${realm}): auth=${r.endpoints.authApiBaseUrl || "(empty)"} device-link=${r.endpoints.deviceLinkApiBaseUrl || "(empty)"}`);
      } else {
        dbgLog(`endpoints refresh failed (${realm}): ${r.reason} — using baked defaults`);
      }
    });
  })().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

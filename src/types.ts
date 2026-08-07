/**
 * pi-cindy: 从 @cindy/device-link-protocol + @cindy/device-link 复制的类型
 *
 * 不能直接 import Cindy 包（不在同一 workspace），所以复制必要类型。
 * 只复制 device-link 核心类型。
 */
export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;

export type EnvelopeKind =
  | "hello" | "hello-ack" | "presence-set" | "presence-changed"
  | "ping" | "pong" | "notify"
  | "link-open" | "link-accept" | "link-close"
  | "invoke" | "invoke-result" | "push"
  | "relay-error";

export interface Envelope {
  v: number; kind: EnvelopeKind; id?: string;
  src?: string; dst?: string; payload?: unknown;
}

export type RelayErrorCode =
  | "DEVICE_OFFLINE" | "REMOTE_DISABLED" | "VERSION_MISMATCH"
  | "PAYLOAD_TOO_LARGE" | "RATE_LIMITED" | "BAD_REQUEST" | "INTERNAL";

export interface HelloPayload {
  deviceName: string; platform: string; appVersion: string;
  remoteControlEnabled: boolean; busy: boolean; deviceInfo?: DeviceInfo;
}
export interface HelloAckPayload {
  serverProtocolVersion: number; deviceId: string; userId: string; capabilities?: string[];
}
export interface DeviceInfo {
  cpuLabel?: string; memoryGb?: number; osVersion?: string; modelLabel?: string;
}
export interface PresenceSnapshot {
  deviceId: string; online: boolean; deviceName: string;
  selfName?: string | null; deviceInfo?: DeviceInfo | null;
  platform: string; appVersion: string; lastSeenAt: number;
  remoteControlEnabled: boolean; busy: boolean;
}
/** presence-set 部分更新：busy / remoteControlEnabled 变更即时广播（对齐 desktop sendPresence）。 */
export interface PresenceSetPayload {
  busy?: boolean;
  remoteControlEnabled?: boolean;
}
export type NotifyCategory = "session-done" | "session-error" | "session-needs-reply";
export interface NotifyPayload {
  category: NotifyCategory; title: string; body?: string;
  deepLink: string; collapseId: string; targetDeviceId?: string;
}

// 隧道层
export interface LinkOpenPayload {
  controllerName: string; protocolVersion: number; appVersion: string;
  capabilities?: string[]; transportStreamId?: string; transportBaseSeq?: number;
}
export interface LinkAcceptPayload {
  appVersion: string; allowlistHash: string;
  capabilities?: string[]; transportStreamId?: string; transportBaseSeq?: number;
}
export interface LinkClosePayload { reason: string; }
export interface InvokePayload { channel: string; args: unknown[]; }
export type DeviceLinkErrorCode = RelayErrorCode
  | "CHANNEL_NOT_ALLOWED" | "ACCESS_REVOKED" | "INVOKE_TIMEOUT"
  | "LINK_NOT_OPEN" | "NOT_CONNECTED" | "BACKPRESSURE"
  | "MEDIA_FETCH_FAILED" | "VOICE_TRANSCRIBE_FAILED";
export type InvokeResultPayload =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: DeviceLinkErrorCode | "IPC_ERROR"; message: string } };
export interface PushOwnerStamp { dataOwnerId: string | null; ownerGeneration: number; }
export interface PushPayload { channel: string; payload: unknown; ownerStamp?: PushOwnerStamp; }

// Pi 内部
export interface PiSessionMeta {
  id: string; title: string; workingDir: string;
  workspaceKind: "project" | "dialogue"; model: string; effort: string;
  permissionMode: string; status: "active" | "archived" | "deleted";
  sdkSessionId?: string; totalTokenUsage: number; totalCostUsd: number;
  totalCostAmount: number; totalCostCurrency?: "CNY" | "USD";
  totalCostIsApproximate: boolean; contextTokens: number; contextWindow: number;
  fastMode: boolean; planModeEnabled: boolean; clearedAt: number | null;
  pinnedAt: number | null; summary: string | null; providerId: string | null;
  agentKind: string; userSendAt: number | null; createdAt: number; updatedAt: number;
  /** 上次 turn 开始时间（毫秒）；与 lastTurnEndedAt 配合判定「疑似中断」（对齐 desktop activeTurn 语义）。 */
  activeTurnStartedAt: number | null;
  /** 上次 turn 正常收尾时间（毫秒）；null = 从未完整收尾。 */
  lastTurnEndedAt: number | null;
  /** 会话宿主 pi 实例 id（进程级 UUID，instance.ts 生成）；null = unhosted（无活宿主可路由）。 */
  hostInstanceId?: string | null;
}
export interface PiMessageMeta {
  id: string; sessionId: string; role: "user" | "assistant" | "tool" | "system";
  /** 发送侧客户端生成的幂等 id（mobile enqueue 项透传）；Pi 自身消息无 → 缺省。 */
  clientId?: string; content: string; model?: string; provider?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
  stopReason?: string; createdAt: number;
}

// Auth
export interface AuthSessionRecord { version: 1; realm: "cn" | "global"; refreshToken: string; }
export interface TokenPair {
  accessToken: string; refreshToken: string;
  membership: { id: string; passportId?: string; kind: "personal" | "org";
    role: "owner" | "admin" | "member"; displayName: string;
    email: string | null; orgId: string | null; orgName: string | null; };
}

// 端点
export const DEFAULT_ENDPOINTS: Record<string, Record<string, string>> = {
  cn: {
    authApiBaseUrl: "https://auth.cindy.com.cn",
    authDesktopCallbackUrl: "https://auth.cindy.com.cn/api/auth/desktop/callback",
    deviceLinkApiBaseUrl: "https://device-link.cindy.com.cn",
    modelAccessApiBaseUrl: "https://model-access.cindy.com.cn",
    websiteUrl: "https://cindy.com.cn",
  },
  global: {
    authApiBaseUrl: "https://auth.cindy.app",
    authDesktopCallbackUrl: "https://auth.cindy.app/api/auth/desktop/callback",
    deviceLinkApiBaseUrl: "https://device-link.cindy.app",
    modelAccessApiBaseUrl: "https://model-access.cindy.app",
    websiteUrl: "https://cindy.app",
  },
};

/**
 * device-link WebSocket 客户端 —— 模拟 Cindy Desktop 被控端
 * 连接 relay server，以 desktop 身份注册，处理 link-open / invoke 帧。
 *
 * 与参考实现 @cindy/device-link 对齐的关键点：
 *  - message 监听器存活整个 socket 生命周期（hello-ack 只做状态切换，不 off 监听）；
 *  - disconnect() 置 stopped，close 事件不再重连（参考 client.ts:1247 的 stopped 守卫）；
 *  - 握手 watchdog 保持到 hello-ack / relay-error，避免 connect() 永久挂起；
 *  - 重连指数退避 1s→30s + jitter；4409 慢重连；401/403 停止重连并上报；
 *  - push 按 topic 路由到订阅者（参考 topics.ts topicForPush + dispatch 转发），不发无 dst 广播；
 *  - notify 深链用 scheme 无关路径 /sessions/{sid}?deviceId={id}（对齐 desktop mobileNotify.ts）。
 */
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import os from "node:os";
import {
  PROTOCOL_VERSION, MAX_FRAME_BYTES,
  type Envelope, type HelloPayload, type HelloAckPayload,
  type LinkAcceptPayload, type LinkClosePayload, type InvokePayload, type InvokeResultPayload,
  type PushPayload, type PresenceSetPayload,
} from "../types.js";
import { readDeviceLinkSettings, isControllerRevoked } from "../store/settings-store.js";

const APP_VERSION = "0.0.0-pi";
/** hello-ack.capabilities: server 支持 notify 帧（来源 cindy-protocol/packages/device-link-protocol）。 */
const SERVER_CAPABILITY_NOTIFY = "notify";
const PING_MS = 20_000;
/** 连续未收 pong 的 ping 数上限（20s × 3 ≈ 60s 判死，对齐参考 startHeartbeat 的 pongMissLimit）。 */
const PONG_MISS_LIMIT = 3;
/** 从 socket 创建到 hello-ack 的握手上限（参考 client.ts 握手 watchdog 15s）。 */
const HANDSHAKE_TIMEOUT_MS = 15_000;
/** 重连退避：1s 起、30s 封顶，指数 + jitter（参考 client.ts:1246-1258）。 */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** 4409 = 同 deviceId 新连接顶替本连接：慢重连等待新连接释放，避免互踢死循环。 */
const RECONNECT_4409_MS = 30_000;
const WS_PATH = "/api/device-link/ws";

import { dbgLog } from "../dbg.js";

/** 会话列表级 / 账号级 push channel → `sessions` topic（对齐 topics.ts SESSION_LIST_CHANNELS）。 */
const SESSION_LIST_CHANNELS: Record<string, true> = {
  "local-db:sessions:created": true,
  "local-db:sessions:patched": true,
  "local-db:session:error-persisted": true,
  "local-db:sessions:activity": true,
  "usage:session-spend-changed": true,
  "usage:session-tokens-changed": true,
};

/**
 * push 路由：channel + payload 算出 topic（对齐 topics.ts topicForPush）。
 * 列表级 → `sessions`；其余 session-scoped → `session:<id>`；取不到 session 标识 → null（丢弃不转发）。
 */
function topicForPush(channel: string, data: unknown, sessionId?: string): string | null {
  if (SESSION_LIST_CHANNELS[channel]) return "sessions";
  const sid = sessionId
    ?? (data && typeof data === "object" && typeof (data as Record<string, unknown>).sessionId === "string"
      ? (data as Record<string, unknown>).sessionId
      : null);
  return sid ? `session:${sid}` : null;
}

function isSubscriptionTopic(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === "sessions") return true;
  if (value.startsWith("session:")) return value.length > "session:".length;
  if (value.startsWith("fs-watch:")) return value.length > "fs-watch:".length;
  return false;
}

export class DeviceLinkClient {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<void> | null = null;
  /** 连接代数：替换/关闭 socket 时递增，旧 socket 的迟到事件按代数丢弃（参考 connEpoch 守卫）。 */
  private connEpoch = 0;
  /** 连续未收到 pong 的 ping 数；超过阈值判半开死链强制重连（对齐参考 startHeartbeat）。 */
  private pongMisses = 0;
  /** 主动断开后不再重连（参考 client.ts stopped 守卫）。 */
  private stopped = false;
  private connected = false;
  private controllers = new Set<string>();
  /** controllerDeviceId → 已订阅 topic 集合（device-link:subscribe 管理）。 */
  private subscriptions = new Map<string, Set<string>>();
  private readyHandler: ((env: Envelope) => void) | null = null;
  private serverCapabilities: string[] = [];
  private busy = false;
  private reconnectAttempts = 0;
  /** 认证失败（401/403/4401）后置位：停止重连，供上层提示重新登录。 */
  private authFailed = false;
  /** 协议版本不一致（hello-ack 的 serverProtocolVersion ≠ PROTOCOL_VERSION）：终态，停止重连。 */
  private protocolMismatch = false;
  public userId: string | null = null;
  public assignedDeviceId: string | null = null;
  /** 认证失败回调（token 失效 / 被登出），上层据此提示重新登录。 */
  public onAuthFailed: (() => void) | null = null;
  /**
   * 握手后的 relay-error 回调（非致命，连接不杀）。上层用于状态展示——
   * 如 DEVICE_OFFLINE 应体现在 status line，而非每帧刷错误输出。
   */
  public onRelayError: ((payload: unknown) => void) | null = null;

  constructor(
    private relayUrl: string,
    private getToken: () => Promise<string | null>,
    private onInvoke: (channel: string, args: unknown[], src: string) => Promise<unknown>,
    private deviceId: string,
  ) {}

  /** 构造 WS URL：http→ws / https→wss + /api/device-link/ws */
  private get wsUrl(): string {
    return this.relayUrl.replace(/^http/, "ws") + WS_PATH;
  }

  /** single-flight connect：重复调用复用同一在途握手。 */
  async connect(): Promise<void> {
    if (this.stopped) throw new Error("Client stopped");
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect().finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  private async doConnect(): Promise<void> {
    const token = await this.getToken();
    if (this.stopped) throw new Error("Client stopped");
    if (!token) {
      // 刷新失败（token 撤销/网络）→ 标记认证失败并停止重连（修：曾静默无限重连循环）
      this.authFailed = true;
      this.onAuthFailed?.();
      throw new Error("No access token");
    }
    const url = this.wsUrl;
    dbgLog(`connect → ${url}`);

    // 替换前关闭旧 socket（若有），避免同 deviceId 双连接被 relay 4409 互踢。
    this.closeSocket();
    // 代数必须在 closeSocket（自增）之后捕获：新 socket 的迟到事件按 connEpoch 判定。
    const epoch = ++this.connEpoch;
    this.pongMisses = 0;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => { if (!settled) { settled = true; reject(err); } };
      const done = () => { if (!settled) { settled = true; resolve(); } };

      let ws: WebSocket | null = null;
      try {
        ws = new WebSocket(url, {
          headers: { Authorization: `Bearer ${token}` },
          maxPayload: MAX_FRAME_BYTES,
        });
      } catch (err) { fail(err as Error); return; }
      this.ws = ws;

      // 握手 watchdog：保持到 hello-ack / relay-error；超时 close（触发 close → 重连路径）。
      const timeout = setTimeout(() => {
        dbgLog("handshake timeout, closing");
        try { ws?.close(); } catch {}
        fail(new Error("Handshake timeout"));
      }, HANDSHAKE_TIMEOUT_MS);

      ws.on("open", () => {
        dbgLog("ws open, sending hello");
        const payload: HelloPayload = {
          deviceName: `Pi — ${os.hostname()}`,
          platform: process.platform,
          appVersion: APP_VERSION,
          remoteControlEnabled: true,
          // 报当前真实 busy（参考 desktop getHello 的 helloBusy 语义，重连时不再丢 busy 状态）
          busy: this.busy,
          deviceInfo: {
            cpuLabel: os.cpus()[0]?.model,
            memoryGb: Math.round(os.totalmem() / 1024 ** 3),
            osVersion: os.release(),
          },
        };
        ws?.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: "hello", id: randomUUID(), payload }));
      });

      // 持久消息监听：hello-ack 只切换状态，绝不 off（修复 post-handshake 帧全丢）。
      ws.on("message", (raw: WebSocket.Data) => {
        if (epoch !== this.connEpoch) return; // 旧 socket 迟到帧：丢弃
        let env: Envelope;
        try { env = JSON.parse(raw.toString()) as Envelope; } catch { return; }
        if (env.kind === "pong") {
          this.pongMisses = 0;
          return;
        }
        if (env.kind === "hello-ack") {
          if (this.connected) {
            // 重复 hello-ack（已在线）：防御性忽略（参考 client.ts duplicate hello-ack 分支）。
            dbgLog("duplicate hello-ack ignored");
            return;
          }
          const ack = env.payload as HelloAckPayload;
          // 协议版本不一致 → 拒上线（对齐参考 client.ts hello-ack 防御性二道闸：
          // mismatch 是终态——client 与 server 协商不一致，重连无意义，置标志停重连）。
          if (typeof ack.serverProtocolVersion === "number" && ack.serverProtocolVersion !== PROTOCOL_VERSION) {
            dbgLog(`device-link protocol mismatch: server v${ack.serverProtocolVersion}, client v${PROTOCOL_VERSION}; staying offline`);
            this.protocolMismatch = true;
            clearTimeout(timeout);
            try { ws?.close(); } catch {}
            fail(new Error(`DeviceLink protocol mismatch: server v${ack.serverProtocolVersion}, client v${PROTOCOL_VERSION}`));
            return;
          }
          this.assignedDeviceId = ack.deviceId;
          this.userId = ack.userId;
          this.serverCapabilities = ack.capabilities ?? [];
          this.authFailed = false;
          this.reconnectAttempts = 0;
          clearTimeout(timeout);
          this.startPing();
          this.connected = true;
          dbgLog(`hello-ack userId=${ack.userId} deviceId=${ack.deviceId} protocol=v${ack.serverProtocolVersion}`);
          done();
          return;
        }
        if (env.kind === "relay-error") {
          dbgLog(`relay-error ${JSON.stringify(env.payload)}`);
          if (!this.connected) {
            // 握手期 relay 拒绝：终止本次握手
            clearTimeout(timeout);
            try { ws?.close(); } catch {}
            fail(new Error(`Relay error: ${JSON.stringify(env.payload)}`));
          }
          // 已握手后的 relay-error 非致命：路由给 handler 记录（参考实现按 pending 请求处理，不杀连接）
          this.readyHandler?.(env);
          return;
        }
        // 业务帧（link-open / invoke / push / presence-changed …）
        this.readyHandler?.(env);
      });

      ws.on("error", (err: Error) => {
        dbgLog(`ws error: ${err.message}`);
        // 主动断开：settle 在途握手，避免 connect() 永久挂起
        if (this.stopped) { fail(new Error("Client stopped")); return; }
        if (epoch !== this.connEpoch) return;
        // ws 库对 HTTP 401/403 upgrade 拒绝报 "Unexpected server response: 401"。
        if (/401|403/.test(err.message)) this.authFailed = true;
        fail(err);
      });

      ws.on("close", (code: number) => {
        dbgLog(`ws close code=${code}`);
        clearTimeout(timeout);
        if (this.stopped) {
          // 主动断开：settle 在途握手（否则 disconnect 中断握手会让 connect() 永久挂起）
          fail(new Error("Client stopped"));
          return;
        }
        if (epoch !== this.connEpoch) return;
        this.connected = false;
        this.stopPing();
        // 断开 = 所有控制链路与订阅失效（重连后手机端会重新 link-open / subscribe）。
        this.controllers.clear();
        this.subscriptions.clear();
        if (this.authFailed || this.protocolMismatch || code === 4401 || code === 4403) {
          dbgLog(this.protocolMismatch ? "protocol mismatch, stop reconnecting" : "auth failed, stop reconnecting");
          if (this.protocolMismatch) return;
          this.onAuthFailed?.();
          return;
        }
        if (code === 4409) { this.scheduleReconnect(RECONNECT_4409_MS); return; }
        this.scheduleReconnect();
      });
    });
  }

  // 注册消息处理器。可在 connect() 之前调用(握手期的业务帧也会路由进来)。
  onReady(handler: (env: Envelope) => void): void {
    this.readyHandler = handler;
  }

  // 处理 inbound 帧（link-open / invoke / presence 等）
  async handleEnvelope(env: Envelope): Promise<void> {
    if (env.kind === "invoke") {
      const inv = env.payload as InvokePayload;
      dbgLog(`← invoke ${inv?.channel} src=${env.src ?? "?"} args=${JSON.stringify(inv?.args)?.slice(0, 200)}`);
    } else {
      dbgLog(`← ${env.kind} src=${env.src ?? "-"} payload=${JSON.stringify(env.payload)?.slice(0, 200)}`);
    }
    switch (env.kind) {
      case "pong": break;
      case "relay-error":
        // 非致命：只进排障日志 + 通知上层状态（不 console.error 刷屏；参考实现按 pending 请求处理）
        dbgLog(`relay-error ${JSON.stringify(env.payload)}`);
        this.onRelayError?.(env.payload);
        break;
      case "link-open": {
        const src = env.src ?? "";
        // 被控授权门禁（对齐 desktop dispatch.ts handleLinkOpen）:
        // 1) 全局开关关闭 → 静默不 accept（server 已是第一道闸，真到这里说明状态不一致）;
        // 2) 逐设备黑名单 → 发 link-close('revoked') 明确信号（控制端据此标记「已撤销」），不接受。
        if (!readDeviceLinkSettings().remoteControlEnabled) {
          dbgLog(`link-open from ${src} rejected: remote control disabled`);
          break;
        }
        if (isControllerRevoked(src)) {
          dbgLog(`link-open from ${src} rejected: access revoked`);
          this.closeLink(src, "revoked");
          break;
        }
        dbgLog(`link-open from ${src}: ${JSON.stringify(env.payload)}`);
        this.controllers.add(src);
        this.sendEnvelope({
          v: PROTOCOL_VERSION, kind: "link-accept", id: env.id, dst: src,
          payload: { appVersion: APP_VERSION, allowlistHash: "00000000", capabilities: [] } as LinkAcceptPayload,
        });
        dbgLog(`→ link-accept to ${src}`);
        break;
      }
      case "link-close": {
        if (env.src) {
          dbgLog(`link-close from ${env.src}`);
          this.controllers.delete(env.src);
          this.subscriptions.delete(env.src);
        }
        break;
      }
      case "invoke": {
        const inv = env.payload as InvokePayload;
        if (!inv?.channel) return;
        const src = env.src ?? "";
        // 订阅控制帧在被控端 dispatch 前拦截（对齐 desktop dispatch.ts 语义），不进通用路由。
        if (inv.channel === "device-link:subscribe") {
          const sub = this.handleSubscribe(src, inv.args ?? []);
          this.sendEnvelope({
            v: PROTOCOL_VERSION, kind: "invoke-result", id: env.id, dst: src,
            payload: sub.error
              ? { ok: false, error: sub.error }
              : { ok: true, result: sub.result },
          });
          return;
        }
        if (inv.channel === "device-link:unsubscribe") {
          const ok = this.handleUnsubscribe(src, inv.args ?? []);
          this.sendEnvelope({
            v: PROTOCOL_VERSION, kind: "invoke-result", id: env.id, dst: src,
            payload: { ok: true, result: ok },
          });
          return;
        }
        // 被控授权门禁（对齐 desktop currentRemoteInvokeAdmissionFailure）:
        // server 已 gate 转发，这里二次兜底（REMOTE_DISABLED / ACCESS_REVOKED 终态）。
        try {
          if (!readDeviceLinkSettings().remoteControlEnabled) {
            throw Object.assign(new Error("remote control disabled"), { code: "REMOTE_DISABLED" });
          }
          if (isControllerRevoked(src)) {
            throw Object.assign(new Error("access revoked by target device"), { code: "ACCESS_REVOKED" });
          }
          const result = await this.onInvoke(inv.channel, inv.args ?? [], src);
          this.sendEnvelope({
            v: PROTOCOL_VERSION, kind: "invoke-result", id: env.id, dst: src,
            payload: { ok: true, result },
          });
        } catch (err: any) {
          dbgLog(`→ invoke-result ERROR channel=${inv.channel} code=${err.code ?? "IPC_ERROR"} msg=${err.message}`);
          this.sendEnvelope({
            v: PROTOCOL_VERSION, kind: "invoke-result", id: env.id, dst: src,
            payload: {
              ok: false,
              error: { code: err.code ?? "IPC_ERROR", message: err.message ?? "Unknown error" },
            },
          });
        }
        break;
      }
    }
  }

  /** subscribe 帧：args[0] = { topics, controllerName?, capabilities? }（对齐 desktop dispatch.ts）。
   *  门禁在前：全局开关 / 逐设备黑名单 → 返回终态错误（REMOTE_DISABLED / ACCESS_REVOKED）。 */
  private handleSubscribe(src: string, args: unknown[]): { ok: boolean; result?: unknown; error?: { code: string; message: string } } {
    if (!readDeviceLinkSettings().remoteControlEnabled) {
      return { ok: false, error: { code: "REMOTE_DISABLED", message: "remote control disabled" } };
    }
    if (isControllerRevoked(src)) {
      return { ok: false, error: { code: "ACCESS_REVOKED", message: "access revoked by target device" } };
    }
    const o = args[0] && typeof args[0] === "object"
      ? (args[0] as { topics?: unknown })
      : {};
    const topics = Array.isArray(o.topics) ? o.topics.filter(isSubscriptionTopic) : [];
    if (topics.length > 0) {
      const set = this.subscriptions.get(src) ?? new Set<string>();
      for (const t of topics) set.add(t);
      this.subscriptions.set(src, set);
    }
    dbgLog(`subscribe ${src} topics=${JSON.stringify(topics)}`);
    return { ok: true, result: { ok: true } };
  }

  private handleUnsubscribe(src: string, args: unknown[]): { ok: boolean } {
    const o = args[0] && typeof args[0] === "object"
      ? (args[0] as { topics?: unknown })
      : {};
    const topics = Array.isArray(o.topics) ? o.topics.filter(isSubscriptionTopic) : [];
    const set = this.subscriptions.get(src);
    if (set) {
      for (const t of topics) set.delete(t);
      if (set.size === 0) this.subscriptions.delete(src);
    }
    dbgLog(`unsubscribe ${src} topics=${JSON.stringify(topics)}`);
    return { ok: true };
  }

  /**
   * 撤销/关闭控制链路：向对端发 link-close（reason 对齐 desktop：revoked / toggle-off / shutdown）。
   * 同时清理本端控制链路与订阅状态（对齐 desktop closeLink 的 inbound 语义）。
   */
  closeLink(dst: string, reason: string): void {
    this.controllers.delete(dst);
    this.subscriptions.delete(dst);
    this.sendEnvelope({
      v: PROTOCOL_VERSION, kind: "link-close", id: randomUUID(), dst,
      payload: { reason } as LinkClosePayload,
    });
    dbgLog(`→ link-close(${reason}) to ${dst}`);
  }

  /**
   * 被控端：对当前控制链路重扫授权门禁——新被撤销 / 全局关闭时断开（对齐 desktop
   * purgeRevokedController / disconnectAllControllers 语义）。
   * 多进程场景必需：standby 进程执行 /cindy-revoke 或 /cindy-remote off 只写共享
   * settings.json，owner 进程无法被同步通知（push 路径无门禁），靠此轮询兜底
   * （index.ts 持有者定时调用，2s 节奏）。
   */
  sweepRevokedControllers(): void {
    const settings = readDeviceLinkSettings();
    if (!settings.remoteControlEnabled) {
      this.disconnectAllControllers("toggle-off");
      return;
    }
    for (const src of [...this.controllers]) {
      if (settings.revokedControllers.includes(src)) this.closeLink(src, "revoked");
    }
  }

  /** 按 topic 路由推送：只发给订阅了该 topic 的控制端（对齐 desktop getControllersForTopic 转发）。 */
  push(channel: string, data: unknown, sessionId?: string): void {
    if (!this.connected) return;
    const topic = topicForPush(channel, data, sessionId);
    if (!topic) return;
    const pl: PushPayload = { channel, payload: data };
    for (const [dst, topics] of this.subscriptions) {
      if (topics.has(topic)) {
        this.sendEnvelope({ v: PROTOCOL_VERSION, kind: "push", id: randomUUID(), dst, payload: pl });
      }
    }
  }

  /**
   * 请求 server 给本账号已注册推送 token 的移动设备发系统推送（fire-and-forget）。
   * 注意：参考实现 sendNotify 以 hello-ack 的 SERVER_CAPABILITY_NOTIFY 能力位为门禁；
   * 该常量定义在 cindy-protocol 子模块（本仓库未检出），故暂不设门禁，靠 relay-error 兜底记录。
   */
  notify(category: "session-done" | "session-error" | "session-needs-reply",
         title: string, sessionId: string, body?: string): void {
    if (!this.connected || !this.assignedDeviceId) return;
    // capability gate（对齐协议仓 device-link-protocol.md §notify）：hello-ack.capabilities
    // 含 SERVER_CAPABILITY_NOTIFY 才可发送；旧 server 对未知 kind 静默丢弃（黑洞），
    // 无该声明不得发。常量值 'notify' 来自 cindy-protocol 子模块（此前未检出不可得，见 EXPERIENCE 未修项）。
    if (!this.serverCapabilities.includes(SERVER_CAPABILITY_NOTIFY)) {
      dbgLog("notify skipped: server lacks SERVER_CAPABILITY_NOTIFY capability");
      return;
    }
    this.sendEnvelope({
      v: PROTOCOL_VERSION, kind: "notify", id: randomUUID(),
      payload: {
        category,
        title: title.slice(0, 120),
        body: body?.slice(0, 240),
        // scheme 无关应用内路径（对齐 desktop mobileNotify.ts buildSessionNotifyPayload）
        deepLink: `/sessions/${encodeURIComponent(sessionId)}?deviceId=${encodeURIComponent(this.assignedDeviceId)}`,
        collapseId: `session-${sessionId}`,
      },
    });
  }

  /** 更新本地 busy 并在在线时即时 presence-set（对齐 desktop sendPresence）。 */
  setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    if (this.connected) {
      this.sendEnvelope({
        v: PROTOCOL_VERSION, kind: "presence-set", id: randomUUID(),
        payload: { busy } as PresenceSetPayload,
      });
    }
  }

  /** 广播 presence 部分更新（对齐 desktop sendPresence：restoreController 用
   *  remoteControlEnabled 信号让控制端重试订阅 → 自动恢复）。 */
  sendPresence(payload: Partial<PresenceSetPayload>): void {
    if (!this.connected) return;
    this.sendEnvelope({ v: PROTOCOL_VERSION, kind: "presence-set", id: randomUUID(), payload });
  }

  /** 被控端：一键断开当前所有控制链路（对齐 desktop disconnectAllControllers）。 */
  disconnectAllControllers(reason: string): void {
    for (const src of [...this.controllers]) this.closeLink(src, reason);
  }

  isConnected(): boolean { return this.connected; }
  hasControllers(): boolean { return this.controllers.size > 0; }
  isAuthFailed(): boolean { return this.authFailed; }
  /** 协议版本不一致（终态，停止重连）——供上层 status line 展示原因。 */
  isProtocolMismatch(): boolean { return this.protocolMismatch; }

  /** 主动断开：stopped 后 close 事件不再触发重连。 */
  disconnect(): void {
    this.stopped = true;
    this.connected = false;
    this.stopPing();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.closeSocket();
  }

  private closeSocket(): void {
    const ws = this.ws;
    this.ws = null;
    this.connEpoch += 1; // 旧 socket 的迟到 close/error 事件不再影响新连接状态
    if (ws) {
      try { ws.close(); } catch {}
    }
  }

  private sendEnvelope(env: Envelope): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const raw = JSON.stringify(env);
    if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) {
      dbgLog(`DROP frame > ${MAX_FRAME_BYTES}B: kind=${env.kind} id=${env.id}`);
      return;
    }
    this.ws.send(raw);
  }

  private startPing(): void {
    this.stopPing();
    this.pongMisses = 0;
    this.pingTimer = setInterval(() => {
      // 半开连接（睡眠/NAT 超时/切网）无 close 事件：连续 PONG_MISS_LIMIT 次未收 pong → 强制断开走重连
      if (this.pongMisses >= PONG_MISS_LIMIT) {
        dbgLog(`pong miss x${this.pongMisses}, terminating half-open socket`);
        this.ws?.terminate();
        return;
      }
      this.sendEnvelope({ v: PROTOCOL_VERSION, kind: "ping", id: randomUUID() });
      this.pongMisses += 1;
    }, PING_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  /** 指数退避 + jitter：1s → 2s → 4s → … → 30s 封顶（参考 client.ts 保退避热语义）。 */
  private scheduleReconnect(delayMs?: number): void {
    if (this.stopped || this.reconnectTimer) return;
    if (delayMs === undefined) {
      const exp = Math.min(this.reconnectAttempts, 5);
      const base = Math.min(RECONNECT_MIN_MS * 2 ** exp, RECONNECT_MAX_MS);
      delayMs = Math.round(base * (0.7 + Math.random() * 0.3));
    }
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // 认证失败（token 撤销/刷新失败）后不再重连（doConnect 已置 authFailed + onAuthFailed）
      this.connect().catch(() => { if (!this.authFailed) this.scheduleReconnect(); });
    }, delayMs);
  }
}

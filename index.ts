/**
 * pi-cindy extension —— 入口
 *
 * 在 Pi 进程内启动 Cindy device-link 客户端，模拟 Cindy Desktop 被控端，
 * 使 Cindy 手机端可以浏览和操作 Pi 会话。
 *
 * 命令:
 *   /cindy-login [cn|global]  — 登录 Cindy 账号
 *   /cindy-logout             — 登出
 *   /cindy-status             — 查看连接状态
 *   /cindy-connect            — 手动连接 relay
 *   /cindy-disconnect         — 断开 relay
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DeviceLinkClient } from "./src/device-link/client.js";
import {
  login, logout, getAccessToken, isLoggedIn,
  getProviders, requestEmailCode, completeEmailLogin, selectAccount,
  requestBindingCode, verifyBinding,
  type SocialProvider,
} from "./src/auth/auth-client.js";
import { loadOrCreateDeviceId, getSession } from "./src/store/session-store.js";
import { loadSession } from "./src/store/token-store.js";
import { routeInvoke, setInvokeContext } from "./src/handlers/router.js";
import { attachSessionTracker, isSubagentCtx } from "./src/tracker.js";
import { getRuntimeModels } from "./src/runtime.js";
import { getEndpoint, refreshEndpoints } from "./src/endpoints.js";
import {
  DeviceLinkOwnershipArbiter, createSqliteOwnershipStore,
  takeOverProcessArbiter, registerProcessArbiter, releaseProcessArbiter,
  type ProcessArbiterBundle,
} from "./src/ownership.js";
import { getStmt, closeDb } from "./src/store/db.js";
import { readDeviceLinkSettings, updateDeviceLinkSetting } from "./src/store/settings-store.js";
import { getInstanceId, registerInstance, heartbeatInstance, releaseInstance } from "./src/instance.js";
import { consumeMailboxForSession, sweepStaleInstances } from "./src/handoff.js";
import { purgeFailedMailbox, failStalePendingMailbox } from "./src/store/handoff-store.js";

export default function (pi: ExtensionAPI) {
  let client: DeviceLinkClient | null = null;
  let ensurePromise: Promise<DeviceLinkClient | null> | null = null;
  let activeId: string | null = null;
  /** 最近一次连接问题（认证失败等），供 /cindy-status 与工具展示。 */
  let lastIssue: string | null = null;
  /** status line 更新句柄（session_start 捕获；无会话时静默 no-op）。 */
  let statusCtx: ExtensionContext | null = null;
  /** 待触发的一次性连接成功 notify（login/session_start 设置，onAcquire 消费；ctx 失效守卫在闭包内）。 */
  let pendingNotify: (() => void) | null = null;

  /**
   * invoke 路由上下文接线（幂等）。push 闭包动态读 `client` 变量：连接重建/替换后
   * 仍指向当前实例（修：曾 ensureClient 内按旧 c 绑定，连接替换后 push 落到已断开实例）。
   * 路由上下文在 session_start 与 ensureClient 各接线一次：登录先于会话启动时
   * ensureClient 保证 ctx 非空（routeInvoke 依赖），会话启动保证 await 竞态前已就绪。
   */
  function wireInvokeContext(): void {
    setInvokeContext({
      pi,
      push: (ch, data, sid) => { const c = client; if (c) c.push(ch, data, sid); },
      activeSessions: new Map(),
      activeId: () => activeId,
      handoffTo: (instanceId) => (arbiter ? arbiter.handoffTo(instanceId) : Promise.resolve(false)),
      handoffPending: () => arbiter?.isAwaitingHandoff() ?? false,
      handoffStruck: (instanceId) => arbiter?.isHandoffStruck(instanceId) ?? false,
    });
  }

  /**
   * 单持有者仲裁（Task 6）：多 pi 进程共享同一数据目录时，只有持有者（owner）
   * 连 relay，其余待命（standby），根除 4409 互踢。登录后 start() 参与仲裁；
   * 登出 stop() 释放。onAcquire 才连 relay，onDemote 断开。
   * 状态线完全由回调驱动（修：曾 startArbiter() 后同步判 isOwner() 恒 false，
   * 单实例冷启动误报 standby）。
   */
  let arbiter: DeviceLinkOwnershipArbiter | null = null;
  /** 本模块实例注册的进程级 bundle（stopArbiter 退租时按同一引用注销）。 */
  let arbiterBundle: ProcessArbiterBundle | null = null;
  /**
   * 缓存 ownership store（跨 tick 复用；prepare 走 getStmt 语句缓存——
   * 修：曾注释声称缓存 store 即免 re-prepare，实际每 op 仍 db.prepare）。
   */
  let ownershipStore: ReturnType<typeof createSqliteOwnershipStore> | null = null;
  /** 授权门禁重扫定时器（持有者专属）：standby 进程改 settings 后 owner 靠它兜底断开被撤销/禁用的控制器。 */
  const SWEEP_MS = 2_000;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** 死宿主清理扫描定时器（持有者专属，15s）：陈旧+pid 死实例 → 清 host/归档/邮箱 failed。 */
  const STALE_SWEEP_MS = 15_000;
  let staleSweepTimer: ReturnType<typeof setInterval> | null = null;
  /** 实例心跳定时器（随仲裁器生命周期）：登录后每 10s 续写 cindy_instances，登出/退出停写。 */
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** waitForOwnership 等待者：仲裁结果确定时逐一结算（onAcquire→owner / onStandbyChanged(true)→standby / onDemote→非 owner）。 */
  let ownershipWaiters: Array<(owner: boolean) => void> = [];

  function settleOwnership(owner: boolean): void {
    const ws = ownershipWaiters;
    ownershipWaiters = [];
    for (const w of ws) w(owner);
  }

  /** 等待仲裁结果（当前实例是/否成为持有者）；可带超时（超时按现状回落，不悬挂）。 */
  function waitForOwnership(timeoutMs?: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (arbiter?.isOwner()) { resolve(true); return; }
      if (arbiter?.isStandby()) { resolve(false); return; }
      const w = (owner: boolean) => { resolve(owner); };
      ownershipWaiters.push(w);
      if (timeoutMs) {
        setTimeout(() => {
          const i = ownershipWaiters.indexOf(w);
          if (i >= 0) ownershipWaiters.splice(i, 1);
          resolve(arbiter?.isOwner() ?? false);
        }, timeoutMs).unref?.();
      }
    });
  }

  function startSweep(): void {
    if (sweepTimer) return;
    sweepTimer = setInterval(() => { client?.sweepRevokedControllers(); }, SWEEP_MS);
    sweepTimer.unref?.();
  }

  function stopSweep(): void {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  }

  function startStaleSweep(): void {
    if (staleSweepTimer) return;
    staleSweepTimer = setInterval(() => {
      try {
        sweepStaleInstances();
        // 滞留 pending 行 TTL（M3 兜底）：超过 10 分钟未消费 → failed → 随 failed 清理删除
        failStalePendingMailbox(Date.now() - 10 * 60_000);
        purgeFailedMailbox(Date.now() - 5 * 60_000);
      } catch { /* db 抖动不致命 */ }
    }, STALE_SWEEP_MS);
    staleSweepTimer.unref?.();
  }

  function stopStaleSweep(): void {
    if (staleSweepTimer) { clearInterval(staleSweepTimer); staleSweepTimer = null; }
  }

  function startInstanceHeartbeat(): void {
    if (heartbeatTimer) return;
    registerInstance();
    heartbeatTimer = setInterval(() => { try { heartbeatInstance(); } catch { /* db 抖动不致命 */ } }, 10_000);
    heartbeatTimer.unref?.();
  }

  function stopInstanceHeartbeat(): void {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    try { releaseInstance(); } catch { /* db 可能已关 */ }
  }

  function startArbiter(): void {
    if (arbiter) return;
    ownershipStore ??= createSqliteOwnershipStore({ prepare: getStmt });
    // 扩展热重载泄漏根治（真机复现：reload 后 9+ 泄漏仲裁器同进程共存，旧实例持续
    // 续期，新实例被同 pid 幽灵租约永久挡在 standby）。进程级注册表后进者 dispose
    // 先进者：先取走旧 bundle 停掉（停表 + 释放租约），再注册自己的。任意时刻只有
    // 一个活仲裁器；跨进程互斥仍由 SQLite 单行 CAS 保证。
    const prev = takeOverProcessArbiter("device-link");
    if (prev) {
      // 不 await：新实例的认领不应被旧实例的释放拖住。旧 arbiter.stop() 同步停表，
      // 释放（DELETE）与后续认领幂等（ownerId 不同不互删）；即使释放晚到，新实例
      // 的 sameProcessLease 路径会按 CAS 立即接管。
      void prev.dispose().catch((err) => {
        console.error("[pi-cindy] dispose stale arbiter failed", err);
      });
    }
    const newArbiter = new DeviceLinkOwnershipArbiter({
      getStore: () => ownershipStore as ReturnType<typeof createSqliteOwnershipStore>,
      instance: { ownerPid: process.pid, ownerLabel: "pi-cindy" },
      onAcquire: () => {
        lastIssue = null;
        startSweep();
        startStaleSweep();
        safeSetStatus("Cindy: relay connected");
        ensureAndNotify();
        // 接管后消费本进程会话的邮箱（client 就绪后，保证重放路径 push 可用）
        ensureClient()
          .then(() => { try { consumeMailboxForSession(activeId ?? ""); } catch { /* ok */ } })
          .catch(() => {});
        settleOwnership(true);
      },
      onDemote: () => {
        client?.disconnect();
        client = null;
        stopSweep();
        stopStaleSweep();
        // 登出/退出（stopArbiter 已置 arbiter=null）不刷状态；superseded 已由
        // onStandbyChanged(true) 展示 standby，这里只覆盖「无人接手」的降级
        if (arbiter && !arbiter.isStandby()) {
          safeSetStatus("Cindy: relay offline（持有权已让出）");
        }
        settleOwnership(false);
      },
      onStandbyChanged: (standby) => {
        if (standby) {
          safeSetStatus("Cindy: standby (另一实例持有连接)");
          settleOwnership(false);
        }
      },
    });
    arbiter = newArbiter;
    arbiterBundle = {
      arbiter: newArbiter,
      // 只停本模块实例的定时器（仲裁器 + sweep + 实例心跳），不关 DB：新模块实例
      // 的 startArbiter 仍要用共享 SQLite。closeDb 只发生在 quit 退出路径。
      dispose: async () => {
        stopSweep();
        stopStaleSweep();
        stopInstanceHeartbeat();
        await newArbiter.stop();
      },
    };
    registerProcessArbiter("device-link", arbiterBundle);
    newArbiter.start();
    startInstanceHeartbeat();
  }

  async function stopArbiter(): Promise<void> {
    if (!arbiter) return;
    const a = arbiter;
    arbiter = null;
    // 退租：注销本模块实例注册的 bundle（若已被后进者 takeOver，这里 no-op）
    if (arbiterBundle) {
      releaseProcessArbiter("device-link", arbiterBundle);
      arbiterBundle = null;
    }
    stopSweep();
    stopStaleSweep();
    await a.stop();
    // 释放实例心跳（DELETE cindy_instances）后再关 DB：closeDb 后 release 会对已关句柄抛错
    stopInstanceHeartbeat();
    // 释放 DB 句柄 + 失效语句缓存（修：曾从不 closeDb——WAL 不 checkpoint；
    // 且模块级 ownershipStore 缓存死句柄，closeDb 后仲裁操作会对已关句柄抛错）
    ownershipStore = null;
    closeDb();
  }

  /**
   * 安全更新 status line。statusCtx 在会话替换/重载（newSession/fork/
   * switchSession/reload）后会被 Pi invalidate，届时访问 statusCtx.ui 直接抛错；
   * 而 relay 是长活 WebSocket，帧到达回调可能在失效后的任意时刻触发（真实崩溃：
   * markOnline → get ui → assertActive 抛 stale ctx → 冒泡到 ws receiver 同步栈 →
   * uncaughtException 退出）。stale 时静默丢弃即可，新会话的 session_start 会重新捕获。
   */
  const safeSetStatus = (text: string | undefined) => {
    try {
      statusCtx?.ui.setStatus("cindy", text);
    } catch {
      // ctx stale（session replaced/reloaded）→ 丢弃；异常绝不允许逃出 ws 回调
    }
  };

  /** relay 报设备离线等非致命错误 → 状态 line 展示，不刷错误输出。 */
  const markOffline = (payload: unknown) => {
    const code = (payload as any)?.code ?? "RELAY_ERROR";
    lastIssue = `relay:${code}`;
    safeSetStatus(`Cindy: device offline (${code})`);
  };
  /** 业务帧到达 = 设备在线可操作 → 清回在线状态。 */
  const markOnline = () => {
    if (lastIssue?.startsWith("relay:")) lastIssue = null;
    safeSetStatus("Cindy: relay connected");
  };

  async function ensureClient(realmArg: "cn" | "global" = "global"): Promise<DeviceLinkClient | null> {
    if (client?.isConnected()) return client;
    // 待命实例不连 relay（单持有者仲裁）：只有持有者建立 WS 连接。
    if (arbiter && !arbiter.isOwner()) return null;
    if (ensurePromise) return ensurePromise;
    ensurePromise = (async () => {
      // 捕获本次启动时的仲裁器引用：await 期间 stopArbiter 会把模块级 arbiter 置
      // null，连接后的持有者复检必须针对捕获对象（其 owner 标志在 stop() 内同步降级）。
      const a = arbiter;
      // realm 以落盘会话为准：cn 账号连 cn relay，global 账号连 global relay
      // （修：session_start 自动重连曾硬编码 global，cn token 发到 global relay 401 死循环）
      const session = loadSession();
      const realm: "cn" | "global" = session?.realm ?? realmArg;
      const token = await getAccessToken(realm);
      if (!token) throw new Error("Not logged in. Use /cindy-login.");
      const deviceId = loadOrCreateDeviceId();
      const relayUrl = getEndpoint(realm, "deviceLinkApiBaseUrl");
      // 替换前断开旧实例（含其在途重连），避免同 deviceId 双连接被 relay 4409 互踢
      if (client) { client.disconnect(); client = null; }
      const c = new DeviceLinkClient(relayUrl, () => getAccessToken(realm), routeInvoke, deviceId);
      client = c;
      c.onAuthFailed = () => {
        lastIssue = `auth-failed (${realm}): token 失效，请 /cindy-login 重新登录`;
      };
      // relay-error（DEVICE_OFFLINE 等）非致命：状态 line 体现，不持续错误输出
      c.onRelayError = markOffline;
      wireInvokeContext();
      // 先挂 ready 处理器再 connect：不丢失 hello-ack 之后的首批帧（presence-changed 等）
      c.onReady((env) => {
        // 业务帧到达（link-open/push/presence…）= 设备在线，清掉 relay 离线状态
        if (env.kind !== "relay-error" && env.kind !== "pong") markOnline();
        c.handleEnvelope(env).catch((e) => console.error("[pi-cindy] handleEnvelope:", e));
      });
      await c.connect();
      // 连接建立期间可能被降级/登出（onDemote/stopArbiter 竞态）：复检持有者身份，
      // 非 owner 立即断开，杜绝僵尸连接（standby 实例持有活连接会 4409 踢真 owner）
      if (a && !a.isOwner()) { c.disconnect(); client = null; return null; }
      lastIssue = null;
      return c;
    })().finally(() => { ensurePromise = null; });
    return ensurePromise;
  }

  /**
   * 补连 + 一次性 notify（onAcquire 与「仲裁器已在运行」的会话切换/重连共用）。
   * 修：曾只有 onAcquire 调 ensureClient——session_shutdown(new/fork/resume) 清空
   * client 后仲裁器仍在，下一次 session_start 的 startArbiter() 早退 → relay 永不重连，
   * 只能手动 /cindy-connect。
   */
  function ensureAndNotify(): void {
    ensureClient()
      .then(() => {
        const notify = pendingNotify;
        pendingNotify = null;
        try { notify?.(); } catch { /* ctx stale */ }
      })
      .catch((err) => {
        if (client?.isProtocolMismatch()) {
          // 协议版本不一致是终态（client 停止重连）：给出与 authFailed 不同的明确信号
          lastIssue = "protocol-mismatch: server 协议版本不一致，已停止重连";
          safeSetStatus("Cindy: protocol mismatch（server 协议版本不一致，已停止重连）");
        } else if (client?.isAuthFailed()) {
          // onAuthFailed 已设 lastIssue（token 失效 → 提示重新登录）
        } else {
          lastIssue = `connect-failed: ${err instanceof Error ? err.message : String(err)}`;
          safeSetStatus("Cindy: relay 连接失败");
        }
      });
  }

  // 自动重连（登录态下每次 session_start 拉起仲裁 + 连接，状态线由仲裁回调驱动）
  pi.on("session_start", async (_event, ctx) => {
    // 子 agent（Agent 工具）会话：不设 statusCtx、不参与仲裁、不连 relay。
    // 否则子 agent 实例会 startArbiter() → takeOverProcessArbiter 停掉主实例仲裁器 →
    // 主实例被降级、relay 断开（用户手机端偶发断连的根源之一）。
    if (isSubagentCtx(ctx)) return;
    statusCtx = ctx; // 供 onRelayError/状态更新使用（status line 更新句柄）
    wireInvokeContext(); // 路由上下文幂等接线（await 竞态前就绪）
    if (isLoggedIn()) {
      pendingNotify = () => { try { ctx.ui.notify("Cindy: connected", "info"); } catch { /* 静默吞错：notify/close/parse 容错 */ } };
      // 先参与仲裁再连 relay：只有持有者建连接，其余待命（不连，等接管回调）。
      // 修：曾 startArbiter() 后同步判 isOwner() 恒 false——单实例也误报 standby。
      startArbiter();
      // 仲裁器已在运行（会话切换 new/fork/resume、/cindy-disconnect 后）：
      // startArbiter 早退、onAcquire 不会再触发 → 持有者需主动补连（修回归）
      if (arbiter?.isOwner()) ensureAndNotify();
    }
  });

  attachSessionTracker(pi, () => client, () => activeId, (id) => { activeId = id; });

  // session_shutdown 必须注册在 tracker 之后：Pi 按注册序 await 事件处理器，
  // tracker 先归档 + 推送（sessions:patched archived / maker:status-changed closed），
  // 本处理器再断开 relay——顺序反了会导致归档/推送被跳过、会话泄漏为 active。
  pi.on("session_shutdown", async (event) => {
    client?.disconnect(); client = null;
    // quit/reload：释放持有权让同伴 ≤5s 接管（进程退出 / runtime 重建不再续期心跳）；
    // new/fork/resume：仅会话切换，登录态保留，继续参与仲裁（session_start 会重建连接）。
    if (event.reason === "quit" || event.reason === "reload") { await stopArbiter(); }
  });

  // 命令
  pi.registerCommand("cindy-login", {
    description: "Login to Cindy: /cindy-login [cn|global] [google|apple|email]",
    handler: async (args, ctx) => {
      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const realmRaw = tokens[0] ?? "global";
      if (realmRaw !== "cn" && realmRaw !== "global") {
        ctx.ui.notify("Usage: /cindy-login [cn|global] [google|apple|email]", "error");
        return;
      }
      const realm: "cn" | "global" = realmRaw;
      const providerArg = tokens[1];

      // 端点热更新：登录前拉一次 CDN 清单（失败保留烘焙默认，不阻断登录）
      await refreshEndpoints().catch(() => {});

      try {
        const providers = await getProviders(realm);
        const social = providers.social.filter(p => p === "apple" || p === "google") as SocialProvider[];

        // 解析登录方式：显式参数 > 交互选择 > 默认
        let method: SocialProvider | "email";
        if (providerArg === "email") {
          if (!providers.email) throw new Error(`Email login not available in ${realm} region`);
          method = "email";
        } else if (providerArg === "apple" || providerArg === "google") {
          if (!social.includes(providerArg)) throw new Error(`"${providerArg}" not available in ${realm} region (social: ${social.join(", ") || "none"})`);
          method = providerArg;
        } else if (providerArg) {
          ctx.ui.notify(`Unknown provider "${providerArg}". Available: ${[...social, ...(providers.email ? ["email"] : [])].join(", ")}`, "error");
          return;
        } else if (ctx.hasUI) {
          const options = [...social.map(p => `social: ${p}`), ...(providers.email ? ["email"] : [])];
          if (options.length === 0) throw new Error(`No login method available in ${realm} region`);
          const picked = await ctx.ui.select(`Cindy login (${realm}) — choose method`, options);
          if (!picked) { ctx.ui.notify("Login cancelled", "info"); return; }
          method = picked === "email" ? "email" : (picked.replace("social: ", "") as SocialProvider);
        } else {
          // 无 UI（RPC/print）：默认 google，其次 social[0]
          if (social.includes("google")) method = "google";
          else if (social[0]) method = social[0];
          else if (providers.email) method = "email";
          else throw new Error(`No login method available in ${realm} region`);
        }

        // 邮箱登录：验证码 + 可选账号选择，全交互式
        if (method === "email") {
          const email = await ctx.ui.input("Cindy email", "you@example.com");
          if (!email) { ctx.ui.notify("Login cancelled", "info"); return; }
          await requestEmailCode(realm, email.trim());
          ctx.ui.notify(`Verification code sent to ${email.trim()}`, "info");
          const code = await ctx.ui.input("Verification code", "6-digit code");
          if (!code) { ctx.ui.notify("Login cancelled", "info"); return; }
          let outcome = await completeEmailLogin(realm, email.trim(), code.trim());
          // binding_required：账号需绑定（bindType=email|phone，对齐 mobile reduceAuthFlow
          // 的 request-binding-code → verify-binding 两段交互）
          if (outcome.status === "binding_required") {
            ctx.ui.notify(`Account needs ${outcome.bindType} binding`, "info");
            const contactLabel = outcome.bindType === "email" ? "Binding email" : "Binding phone number";
            const contact = await ctx.ui.input(contactLabel, outcome.bindType === "email" ? "you@example.com" : "phone number");
            if (!contact) { ctx.ui.notify("Login cancelled", "info"); return; }
            await requestBindingCode(realm, outcome.bindTicket, outcome.bindType, contact.trim());
            ctx.ui.notify(`Binding code sent to ${contact.trim()}`, "info");
            const bcode = await ctx.ui.input("Binding code", "6-digit code");
            if (!bcode) { ctx.ui.notify("Login cancelled", "info"); return; }
            outcome = await verifyBinding(realm, outcome.bindTicket, outcome.bindType, contact.trim(), bcode.trim());
          }
          // select_account：二次选择账号（completeEmailLogin 或 verifyBinding 后均可能）
          if (outcome.status === "select_account") {
            const labels = outcome.accounts.map(a =>
              `${a.displayName}${a.email ? ` <${a.email}>` : ""}${a.orgName ? ` [${a.orgName}]` : ""}`,
            );
            const pickedLabel = await ctx.ui.select("Choose account", labels);
            if (!pickedLabel) { ctx.ui.notify("Login cancelled", "info"); return; }
            const idx = labels.indexOf(pickedLabel);
            if (idx < 0) throw new Error("Unexpected account selection");
            outcome = await selectAccount(realm, outcome.loginTicket, outcome.accounts[idx].id);
          }
          if (outcome.status === "ok") {
            ctx.ui.notify("Cindy login OK!", "info");
            pendingNotify = () => { try { ctx.ui.notify("Cindy: relay connected", "info"); } catch { /* 静默吞错：notify/close/parse 容错 */ } };
            startArbiter(); // 仲裁回调（onAcquire）负责连 relay + 状态
            if (arbiter?.isOwner()) ensureAndNotify(); // 已在运行（重登录）：直接补连
            return;
          }
          if (outcome.status === "binding_required") {
            ctx.ui.notify(`Login failed: binding still required (${outcome.bindType})`, "error");
            return;
          }
          ctx.ui.notify("Login failed: unexpected outcome", "error");
          return;
        }

        // 社交登录：开浏览器 + 托管回调轮询
        ctx.ui.notify(`Opening browser for ${method} login (${realm})...`, "info");
        await login(realm, method);
        ctx.ui.notify("Cindy login OK!", "info");
        pendingNotify = () => { try { ctx.ui.notify("Cindy: relay connected", "info"); } catch { /* 静默吞错：notify/close/parse 容错 */ } };
        startArbiter(); // 仲裁回调（onAcquire）负责连 relay + 状态
        if (arbiter?.isOwner()) ensureAndNotify(); // 已在运行（重登录）：直接补连
      } catch (e: any) {
        ctx.ui.notify(`Login failed: ${e.message}`, "error");
      }
    },
  });

  pi.registerCommand("cindy-logout", {
    description: "Logout from Cindy",
    handler: async (_args, ctx) => { client?.disconnect(); client = null; await stopArbiter(); await logout(); ctx.ui.notify("Logged out", "info"); ctx.ui.setStatus("cindy", undefined); },
  });

  pi.registerCommand("cindy-status", {
    description: "Show Cindy sync status",
    handler: async (_args, ctx) => {
      const loggedIn = isLoggedIn();
      const connected = client?.isConnected() ?? false;
      const hasCtrl = client?.hasControllers() ?? false;
      const userId = client?.userId ?? null;
      const deviceId = client?.assignedDeviceId ?? null;
      const diagModels = getRuntimeModels().length;
      const settings = readDeviceLinkSettings();
      const instId = getInstanceId();
      const host = activeId ? (getSession(activeId)?.hostInstanceId ?? null) : null;
      let status = `Login:${loggedIn?"✅":"❌"} Relay:${connected?"✅":"❌"} Mobile:${hasCtrl?"📱":"💤"} User:${userId?.slice(0,8)??"-"} Device:${deviceId?.slice(0,8)??"-"} Session:${activeId??"none"} Models:${diagModels} Inst:${instId.slice(0,8)} Host:${host ? host.slice(0,8) : "-"} Remote:${settings.remoteControlEnabled?"on":"off"}${settings.revokedControllers.length ? ` Revoked:${settings.revokedControllers.length}` : ""}${lastIssue ? ` | ${lastIssue}` : ""}`;
      if (arbiter) {
        status += arbiter.isOwner() ? "\n仲裁: owner (持有 relay 连接)" : "\n仲裁: standby (另一实例持有)";
      }
      ctx.ui.notify(status, loggedIn ? "info" : "warning");
    },
  });

  pi.registerCommand("cindy-remote", {
    description: "Toggle remote control: /cindy-remote [on|off]",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      if (arg !== "on" && arg !== "off") {
        const cur = readDeviceLinkSettings().remoteControlEnabled;
        ctx.ui.notify(`Remote control: ${cur ? "on" : "off"}（用法: /cindy-remote [on|off]）`, "info");
        return;
      }
      const enabled = arg === "on";
      updateDeviceLinkSetting("remoteControlEnabled", () => enabled);
      if (!enabled) client?.disconnectAllControllers("toggle-off");
      ctx.ui.notify(
        !enabled && arbiter && !arbiter.isOwner()
          ? "Remote control disabled（standby：持有者 ≤2s 内断开全部控制端）"
          : `Remote control ${enabled ? "enabled" : "disabled"}`,
        "info",
      );
      safeSetStatus(enabled ? "Cindy: relay connected" : "Cindy: remote control off");
    },
  });

  pi.registerCommand("cindy-revoke", {
    description: "Revoke a controller device: /cindy-revoke <deviceId>",
    handler: async (args, ctx) => {
      const deviceId = (args ?? "").trim();
      if (!deviceId) { ctx.ui.notify("Usage: /cindy-revoke <deviceId>", "error"); return; }
      updateDeviceLinkSetting("revokedControllers", (latest) =>
        latest.includes(deviceId) ? latest : [...latest, deviceId]);
      client?.closeLink(deviceId, "revoked");
      ctx.ui.notify(
        arbiter && !arbiter.isOwner()
          ? `Access revoked for ${deviceId.slice(0, 8)}（standby：持有者 ≤2s 内断开）`
          : `Access revoked for ${deviceId.slice(0, 8)}（/cindy-restore 恢复）`,
        "info",
      );
    },
  });

  pi.registerCommand("cindy-restore", {
    description: "Restore a controller device: /cindy-restore <deviceId>",
    handler: async (args, ctx) => {
      const deviceId = (args ?? "").trim();
      if (!deviceId) { ctx.ui.notify("Usage: /cindy-restore <deviceId>", "error"); return; }
      const s = updateDeviceLinkSetting("revokedControllers", (latest) =>
        latest.filter((id) => id !== deviceId));
      // 恢复后无法直接通知已断开的控制端，发一次 presence 广播 → 控制端重新评估 → 重试订阅恢复
      client?.sendPresence({ remoteControlEnabled: s.remoteControlEnabled });
      ctx.ui.notify(s.revokedControllers.includes(deviceId)
        ? `Restore failed: ${deviceId.slice(0, 8)} not in revoked list`
        : `Access restored for ${deviceId.slice(0, 8)}`, "info");
    },
  });

  pi.registerCommand("cindy-connect", {
    description: "Connect to Cindy device-link relay",
    handler: async (_args, ctx) => {
      if (!isLoggedIn()) { ctx.ui.notify("Not logged in. /cindy-login first.", "error"); return; }
      // 待命实例禁止连 relay：只有持有者建连接。等仲裁结果再判定——
      // 修：曾 startArbiter() 后同步 isOwner() 恒 false，冷启动必误报 standby。
      startArbiter();
      const owner = await waitForOwnership(8000);
      if (!owner) {
        ctx.ui.notify("Standby: 另一实例持有 relay 连接（单持有者仲裁）", "warning");
        return;
      }
      try {
        const c = await ensureClient();
        if (!c) { ctx.ui.notify("Connect cancelled: 连接期间持有权被接管", "warning"); return; }
        try { ctx.ui.notify("Connected", "info"); } catch { /* 静默吞错：notify/close/parse 容错 */ }
        safeSetStatus("Cindy: relay connected");
      } catch (e: any) { ctx.ui.notify(`Connect failed: ${e.message}`, "error"); }
    },
  });

  pi.registerCommand("cindy-disconnect", {
    description: "Disconnect from relay",
    handler: async (_args, ctx) => { client?.disconnect(); client = null; ctx.ui.notify("Disconnected", "info"); ctx.ui.setStatus("cindy", undefined); },
  });

  // 工具
  pi.registerTool({
    name: "cindy_sync_status",
    label: "Cindy Sync Status",
    description: "Check Cindy session sync status",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: JSON.stringify({
        loggedIn: isLoggedIn(), connected: client?.isConnected() ?? false,
        mobileControl: client?.hasControllers() ?? false, activeSession: activeId,
      }) }], details: {} };
    },
  });

  pi.registerTool({
    name: "cindy_send_notification",
    label: "Send Notification",
    description: "Send push notification to Cindy mobile app",
    parameters: Type.Object({
      title: Type.String({ description: "Notification title" }),
      body: Type.Optional(Type.String()),
      category: Type.Optional(Type.String({ description: "session-done, session-error, or session-needs-reply" })),
    }),
    async execute(_id, params) {
      if (!client?.isConnected()) return { content: [{ type: "text", text: "Not connected to relay" }], details: {} };
      client.notify((params.category as any) ?? "session-done", params.title, activeId ?? "unknown", params.body);
      return { content: [{ type: "text", text: "Notification sent" }], details: {} };
    },
  });
}

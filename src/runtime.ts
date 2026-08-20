/**
 * Pi 运行态快照 —— tracker 在 session_start 捕获，供 invoke handlers 使用。
 *
 * ExtensionAPI 顶层没有 modelRegistry / abort / compact / isIdle（这些只在
 * ExtensionContext 上），因此必须经 session 上下文捕获一次并缓存为模块态。
 * 扩展重载（session_start 重来）会重新捕获，不需要跨会话持久。
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** pi thinking levels（去掉 "off"）—— mobile Effort 契约的子集。 */
export const PI_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PiEffort = (typeof PI_EFFORTS)[number];

export const EFFORT_DISPLAY_NAMES: Record<string, string> = {
  minimal: "Minimal", low: "Low", medium: "Medium",
  high: "High", xhigh: "XHigh", max: "Max",
};

interface RuntimeSnapshot {
  models: any[];
  /** pi 白名单（--models / enabledModels 匹配结果）；空 = 未配置 → 回退全量。 */
  scopedModels: readonly { model: any; thinkingLevel?: string }[];
  /** provider id → 展示名（模型 displayName 前缀）。 */
  providerNames: Map<string, string>;
  abort: (() => void) | null;
  isIdle: (() => boolean) | null;
  compact: ((opts?: unknown) => void) | null;
  getContextUsage: (() => unknown) | null;
  currentModel: any | null;
}

let snap: RuntimeSnapshot = {
  models: [], scopedModels: [], providerNames: new Map(),
  abort: null, isIdle: null, compact: null,
  getContextUsage: null, currentModel: null,
};

/** tracker session_start 调用：捕获当前 pi 会话的运行时能力。 */
export function captureRuntimeCtx(ctx: ExtensionContext): void {
  let models: any[];
  try { models = ctx.modelRegistry?.getAvailable?.() ?? []; } catch { models = []; }
  let scoped: readonly { model: any; thinkingLevel?: string }[];
  try { scoped = (ctx.scopedModels ?? []) as never; } catch { scoped = []; }
  const providerNames = new Map<string, string>();
  try {
    for (const id of ctx.modelRegistry?.getRegisteredProviderIds?.() ?? []) {
      providerNames.set(id, ctx.modelRegistry.getProviderDisplayName(id));
    }
  } catch { /* 部分 provider 无展示名时回退 id */ }
  snap = {
    models,
    scopedModels: scoped,
    providerNames,
    abort: typeof ctx.abort === "function" ? () => { try { ctx.abort(); } catch { /* noop */ } } : null,
    isIdle: typeof ctx.isIdle === "function"
      ? () => { try { return ctx.isIdle(); } catch { return true; } }
      : null,
    compact: typeof ctx.compact === "function"
      ? (o) => { try { ctx.compact(o as never); } catch { /* noop */ } }
      : null,
    getContextUsage: typeof ctx.getContextUsage === "function"
      ? () => { try { return ctx.getContextUsage(); } catch { return undefined; } }
      : null,
    currentModel: ctx.model ?? null,
  };
}

/**
 * 模型清单：白名单非空 → 只返回白名单；未配置白名单 → 全量（getAvailable）。
 */
export function getRuntimeModels(): any[] {
  if (snap.scopedModels.length > 0) {
    return snap.scopedModels.map((s) => s?.model).filter(Boolean);
  }
  return snap.models;
}

export function getScopedThinkingLevel(modelId: string): string | null {
  for (const s of snap.scopedModels) {
    if (s?.model?.id === modelId && s.thinkingLevel) return s.thinkingLevel;
  }
  return null;
}

/** provider id → 展示名（缺省回退 id）。 */
export function providerDisplayName(providerId: string): string {
  return snap.providerNames.get(providerId) ?? providerId;
}

export function getCurrentModel(): any | null { return snap.currentModel; }

/** 中断当前 pi 会话（手机端 stop / abort 的唯一有效路径）。 */
export function abortRuntime(): void { snap.abort?.(); }
export function isRuntimeIdle(): boolean { return snap.isIdle ? snap.isIdle() : true; }
export function compactRuntime(): void { snap.compact?.(); }
export function getRuntimeContextUsage(): unknown { return snap.getContextUsage?.(); }

/**
 * 按模型 id（可选 provider 收窄）解析 pi 模型。
 *
 * 解析优先级（对齐 desktop per-session provider 路由语义）：
 *  1. 白名单（scopedModels，enabledModels/--models 匹配结果）内 provider+id 精确匹配；
 *  2. 白名单内纯 id 匹配（同 id 只可能命中白名单内那条）；
 *  3. 全量 provider+id 精确匹配；
 *  4. 全量纯 id 首见。
 * 白名单优先是修同 id 跨 provider 歧义的关键：手机端模型选择器只列白名单
 * （getRuntimeModels），发送侧必须解析回白名单内那条，否则全量首见可能命中
 * 同名但未启用的 provider（如 openrouter 的 deepseek 与 commandcode-goat 的
 * deepseek，前者 402 余额不足）。
 */
export function resolvePiModel(modelId: string, providerId?: string): any | undefined {
  const scoped = snap.scopedModels.map((s) => s?.model).filter(Boolean);
  if (scoped.length > 0) {
    if (providerId) {
      const byProvider = scoped.find((m) => m.id === modelId && m.provider === providerId);
      if (byProvider) return byProvider;
    }
    const bare = scoped.find((m) => m.id === modelId);
    if (bare) return bare;
  }
  const models = snap.models;
  if (providerId) {
    const byProvider = models.find((m) => m.id === modelId && m.provider === providerId);
    if (byProvider) return byProvider;
  }
  return models.find((m) => m.id === modelId);
}

/**
 * 该模型支持的 effort 档。pi 非 reasoning 模型不支持 thinking → 空数组
 * （mobile 契约：空 efforts = 不支持 effort 切换，如 Haiku）。
 * thinkingLevelMap 中值为 null/undefined 的档视为不支持（pi-ai 语义）。
 */
export function effortsForModel(m: any): string[] {
  if (!m || m.reasoning !== true) return [];
  const map = m.thinkingLevelMap as Record<string, unknown> | undefined;
  if (map && typeof map === "object") {
    return PI_EFFORTS.filter((lvl) => {
      const v = map[lvl];
      return v !== null && v !== undefined && v !== false;
    });
  }
  return [...PI_EFFORTS];
}

/** 把 mobile effort id（可能含 pi 没有的 ultra）收敛到 pi thinking level。 */
export function normalizeEffort(effort: string): string {
  if (PI_EFFORTS.includes(effort as PiEffort)) return effort;
  if (effort === "ultra") return "max";
  return "high";
}

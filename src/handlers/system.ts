/**
 * 系统级 invoke handler —— 手机端常调、desktop 有实现但 Pi host 无对应功能的 channel。
 *
 * 契约源 = 对端消费方源码（手机端 normalize/validate + desktop ipc 签名）：
 *  - maker:goal:get-status    → GoalStatusPayload | null（desktop 无 goal 时返回 null，mobile
 *    useGoalStatus hook 兼容 null；Pi host 无 goal 概念，恒 null）
 *  - maker:schedule:list      → Schedule[]（desktop scheduler.list 空时返回 []；Pi 无 scheduler）
 *  - notification:clear-session-attention → void（desktop 只清 attention 标记，Pi 无该状态）
 *
 * 这些 channel 曾在 allowlist 精简时被摘除；手机端打开会话/项目选择器会实际调用，
 * 摘除导致 CHANNEL_NOT_ALLOWED 刷屏 + 手机端功能缺失（goal 状态、attention 清除、
 * 项目路径 stat）。按「契约以消费方为准」恢复，返回形状对齐 desktop 空态。
 */
export function goalStatus(_args: unknown[]): null {
  // Pi 无 goal host；desktop getStatus 无 controller 时也返回 null。
  return null;
}

export function scheduleList(_args: unknown[]): unknown[] {
  // Pi 无 scheduler；desktop scheduler.list 无数据时返回 []。
  return [];
}

export function clearAttention(_args: unknown[]): void {
  // desktop 仅清会话 attention 标记（appBadgeService），Pi 无 badge/attention 状态 → no-op。
}

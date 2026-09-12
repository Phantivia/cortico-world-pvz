import type { PvzNativeAction } from './protocol.ts';

// Base result envelope: Zen toolbar setup followed by the native effect check.
// Batch actions extend it with their scale-specific execution budget.
export const PVZ_NATIVE_TERMINAL_RESULT_BUDGET_MS = 20_000;
export const PVZ_NATIVE_ACK_BUDGET_MS = 5000;
export const PVZ_NATIVE_CONTROL_RESULT_BUDGET_MS = 5000;
export const PVZ_NATIVE_COLLECT_VERIFY_PER_ITEM_MS = 1500;
export const PVZ_NATIVE_COLLECT_CURSOR_ATTEMPTS = 4;
export const PVZ_NATIVE_COLLECT_CLICK_MS = 18;
export const PVZ_NATIVE_COLLECT_TRANSITION_GRACE_MS = 2000;
export const PVZ_NATIVE_CURSOR_MAX_SPEED_BUDGET_MS = 500;
export const PVZ_NATIVE_WHACK_CURSOR_ATTEMPTS = 4;
export const PVZ_NATIVE_WHACK_REACTION_MAX_MS = 160;
export const PVZ_NATIVE_WHACK_VERIFY_MS = 120;
export const PVZ_NATIVE_WHACK_INPUT_GRACE_MS = 200;

export function pvzCollectExecutionBudgetMs(
  count: number,
  cursorMaxMs: number,
  minimumMs: number,
): number {
  return Math.max(
    minimumMs,
    count * (
      PVZ_NATIVE_COLLECT_CURSOR_ATTEMPTS
        * Math.max(cursorMaxMs, PVZ_NATIVE_CURSOR_MAX_SPEED_BUDGET_MS)
      + PVZ_NATIVE_COLLECT_VERIFY_PER_ITEM_MS
      + PVZ_NATIVE_COLLECT_CLICK_MS
    )
      + PVZ_NATIVE_COLLECT_TRANSITION_GRACE_MS,
  );
}

export function pvzWhackExecutionBudgetMs(
  count: number,
  cursorMaxMs: number,
  minimumMs: number,
): number {
  return Math.max(
    minimumMs,
    count * (
      PVZ_NATIVE_WHACK_CURSOR_ATTEMPTS
        * Math.max(cursorMaxMs, PVZ_NATIVE_CURSOR_MAX_SPEED_BUDGET_MS)
      + PVZ_NATIVE_WHACK_REACTION_MAX_MS
      + PVZ_NATIVE_WHACK_VERIFY_MS
      + PVZ_NATIVE_WHACK_INPUT_GRACE_MS
    ),
  );
}

export function pvzActionAckBudgetMs(): number {
  return PVZ_NATIVE_ACK_BUDGET_MS;
}

export function pvzActionNativeResultBudgetMs(
  kind: PvzNativeAction['kind'],
  scaledExecutionMs: number,
  nativeResultMs = PVZ_NATIVE_TERMINAL_RESULT_BUDGET_MS,
): number {
  if (kind === 'cancel') {
    return Math.min(nativeResultMs, PVZ_NATIVE_CONTROL_RESULT_BUDGET_MS);
  }
  return scaledExecutionMs > 0
    ? Math.max(nativeResultMs, scaledExecutionMs)
    : nativeResultMs;
}

export function pvzActionCompletionBudgetMs(
  kind: PvzNativeAction['kind'],
  stateVerificationMs: number,
  scaledExecutionMs = 0,
  nativeResultMs = PVZ_NATIVE_TERMINAL_RESULT_BUDGET_MS,
): number {
  return pvzActionAckBudgetMs()
    + pvzActionNativeResultBudgetMs(kind, scaledExecutionMs, nativeResultMs)
    + stateVerificationMs;
}

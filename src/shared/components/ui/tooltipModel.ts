export const TOOLTIP_POINTER_DELAY_MS = 2_000

/** Position the measured tooltip inside the viewport, preferring the trigger's right side. */
export function placeTooltip(rect: { left: number; right: number; top: number; height: number },
  viewport: { width: number; height: number },
  content: { width: number; height: number }): { left: number; top: number; side: 'left' | 'right' | 'none' } {
  const width = Math.min(content.width, Math.max(0, viewport.width - 16))
  const height = Math.min(content.height, Math.max(0, viewport.height - 16))
  const right = rect.right + 10
  const leftCandidate = rect.left - width - 10
  const side = right + width <= viewport.width - 8 ? 'right'
    : leftCandidate >= 8 ? 'left' : 'none'
  const left = side === 'left' ? leftCandidate : Math.max(8, Math.min(right, viewport.width - width - 8))
  const top = Math.max(8 + height / 2,
    Math.min(rect.top + rect.height / 2, viewport.height - 8 - height / 2))
  return { left, top, side }
}

export interface TooltipVisibilityState {
  visible: boolean
  pointerPending: boolean
}

export type TooltipVisibilityAction =
  | { type: 'pointer-enter' }
  | { type: 'pointer-delay-elapsed' }
  | { type: 'pointer-leave' | 'focus' | 'blur' | 'escape' | 'unmount' }

export function reduceTooltipVisibility(
  state: TooltipVisibilityState,
  action: TooltipVisibilityAction,
): TooltipVisibilityState {
  if (action.type === 'pointer-enter') return { visible: state.visible, pointerPending: !state.visible }
  if (action.type === 'pointer-delay-elapsed' || action.type === 'focus') return { visible: true, pointerPending: false }
  return { visible: false, pointerPending: false }
}

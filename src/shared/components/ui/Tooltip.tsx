import * as React from 'react'
import { createPortal } from 'react-dom'

import {
  TOOLTIP_POINTER_DELAY_MS,
  placeTooltip,
  reduceTooltipVisibility,
  type TooltipVisibilityState,
} from './tooltipModel.ts'

export { TOOLTIP_POINTER_DELAY_MS, reduceTooltipVisibility } from './tooltipModel.ts'
export type { TooltipVisibilityAction, TooltipVisibilityState } from './tooltipModel.ts'

interface TooltipProps {
  content: string
  children: React.ReactNode
}

export function Tooltip({ content, children }: TooltipProps): JSX.Element {
  const [state, setState] = React.useState<TooltipVisibilityState>({ visible: false, pointerPending: false })
  const [coords, setCoords] = React.useState<ReturnType<typeof placeTooltip>>({ left: 0, top: 0, side: 'none' })
  const triggerRef = React.useRef<HTMLSpanElement>(null)
  const tooltipRef = React.useRef<HTMLDivElement>(null)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const reactId = React.useId()
  const tooltipId = React.useMemo(() => `modly-tooltip-${reactId.replace(/[^A-Za-z0-9_-]/g, '')}`, [reactId])

  const clearPointerTimer = React.useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])
  const measure = React.useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const contentRect = tooltipRef.current?.getBoundingClientRect()
    setCoords(placeTooltip(rect, { width: window.innerWidth, height: window.innerHeight },
      { width: contentRect?.width ?? 220, height: contentRect?.height ?? 40 }))
  }, [])
  const hide = React.useCallback((type: 'pointer-leave' | 'blur' | 'escape' | 'unmount') => {
    clearPointerTimer()
    setState((current) => reduceTooltipVisibility(current, { type }))
  }, [clearPointerTimer])

  React.useEffect(() => () => {
    clearPointerTimer()
  }, [clearPointerTimer])
  React.useLayoutEffect(() => {
    if (!state.visible) return
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [state.visible, content, measure])

  const child = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, describeTrigger(children, tooltipId))
    : <span tabIndex={0} aria-describedby={tooltipId}>{children}</span>

  return (
    <>
      <span
        ref={triggerRef}
        className="inline-flex"
        onPointerEnter={() => {
          clearPointerTimer()
          setState((current) => reduceTooltipVisibility(current, { type: 'pointer-enter' }))
          timerRef.current = setTimeout(() => {
            timerRef.current = null
            measure()
            setState((current) => reduceTooltipVisibility(current, { type: 'pointer-delay-elapsed' }))
          }, TOOLTIP_POINTER_DELAY_MS)
        }}
        onPointerLeave={() => hide('pointer-leave')}
        onFocus={() => {
          clearPointerTimer()
          measure()
          setState((current) => reduceTooltipVisibility(current, { type: 'focus' }))
        }}
        onBlur={(event) => {
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
          hide('blur')
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') hide('escape')
        }}
      >
        {child}
      </span>

      {state.visible && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={tooltipRef}
              id={tooltipId}
              role="tooltip"
              className="fixed z-[9999] pointer-events-none"
              style={{ left: coords.left, top: coords.top, maxWidth: 'calc(100vw - 16px)', transform: 'translateY(-50%)' }}
            >
              {coords.side === 'left' ? <>
                <div aria-hidden="true" className="absolute left-full top-1/2 -translate-y-1/2 border-[5px] border-transparent border-l-zinc-700/80" />
                <div aria-hidden="true" className="absolute left-full top-1/2 -translate-x-px -translate-y-1/2 border-[5px] border-transparent border-l-zinc-900" />
              </> : coords.side === 'right' ? <>
                <div aria-hidden="true" className="absolute right-full top-1/2 -translate-y-1/2 border-[5px] border-transparent border-r-zinc-700/80" />
                <div aria-hidden="true" className="absolute right-full top-1/2 translate-x-px -translate-y-1/2 border-[5px] border-transparent border-r-zinc-900" />
              </> : null}
              <div className="max-w-[220px] max-h-[calc(100dvh-16px)] overflow-y-auto rounded-lg border border-zinc-700/80 bg-zinc-900 px-3 py-2 shadow-xl">
                <p className="whitespace-normal break-words text-xs leading-relaxed text-zinc-300">{content}</p>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

function describeTrigger(
  child: React.ReactElement,
  tooltipId: string,
): Record<string, unknown> {
  const existing = typeof child.props === 'object' && child.props !== null
    ? (child.props as Record<string, unknown>)['aria-describedby']
    : undefined
  const describedBy = typeof existing === 'string' && existing.trim()
    ? `${existing.trim()} ${tooltipId}`
    : tooltipId
  const nativeFocusable = typeof child.type === 'string'
    && ['button', 'a', 'input', 'select', 'textarea', 'summary'].includes(child.type)
  const currentTabIndex = typeof child.props === 'object' && child.props !== null
    ? (child.props as Record<string, unknown>).tabIndex
    : undefined
  return {
    'aria-describedby': describedBy,
    ...(!nativeFocusable && currentTabIndex === undefined ? { tabIndex: 0 } : {}),
  }
}

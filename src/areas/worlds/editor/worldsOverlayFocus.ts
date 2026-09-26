import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

import type { WorldsWorkbenchDock } from './worldsUiStore.ts'
import { getWorldsDockFocusFallbackSelector, resolveWorldsFocusTrapIndex, shouldIncludeWorldsFocusCandidate } from './worldsWorkbenchModel.ts'

const WORLDS_OVERLAY_FOCUS_SELECTOR = [
  'button:not(:disabled)',
  'select:not(:disabled)',
  'input:not(:disabled)',
  'textarea:not(:disabled)',
  'a[href]',
  'summary:not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function trapWorldsOverlayFocus(event: Pick<ReactKeyboardEvent<HTMLDivElement>, 'currentTarget' | 'shiftKey' | 'preventDefault'>, activeElement: Element | null = document.activeElement): void {
  const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(WORLDS_OVERLAY_FOCUS_SELECTOR)]
    .filter(isWorldsVisibleFocusTarget)
  const currentIndex = focusable.findIndex((element) => element === activeElement)
  const nextIndex = resolveWorldsFocusTrapIndex(focusable.length, currentIndex, event.shiftKey)
  if (nextIndex === null) return
  event.preventDefault()
  focusable[nextIndex]?.focus()
}

function isWorldsVisibleFocusTarget(element: HTMLElement | null): element is HTMLElement {
  if (!element || !element.isConnected) return false
  // Closed details bodies can retain client rects despite being unfocusable.
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.tagName !== 'DETAILS' || ancestor.hasAttribute('open')) continue
    const summary = [...ancestor.children].find((child) => child.tagName === 'SUMMARY')
    if (!summary?.contains(element)) return false
  }
  return shouldIncludeWorldsFocusCandidate({
    ariaHidden: element.getAttribute('aria-hidden') === 'true',
    withinInert: !!element.closest('[inert]'),
    clientRectCount: element.getClientRects().length,
  })
}

export function restoreWorldsDockFocus(
  root: HTMLElement | null,
  trigger: HTMLElement | null,
  dock: WorldsWorkbenchDock,
): void {
  if (!root) return
  const fallbackRoot = root.querySelector<HTMLElement>(getWorldsDockFocusFallbackSelector(dock))
  const fallback = fallbackRoot?.matches(WORLDS_OVERLAY_FOCUS_SELECTOR) && isWorldsVisibleFocusTarget(fallbackRoot)
    ? fallbackRoot
    : fallbackRoot?.querySelector<HTMLElement>(WORLDS_OVERLAY_FOCUS_SELECTOR) ?? null
  const projectFallback = root.querySelector<HTMLElement>(
    '.worlds-project-bar select:not(:disabled), .worlds-project-bar button:not(:disabled)',
  )
  const target = [trigger, fallback, projectFallback].find(isWorldsVisibleFocusTarget)
  target?.focus()
}

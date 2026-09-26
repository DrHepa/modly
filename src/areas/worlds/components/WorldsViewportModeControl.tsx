import { useEffect, useId, useMemo, useRef, type KeyboardEvent } from 'react'

import { Tooltip } from '../../../shared/components/ui/Tooltip.tsx'
import {
  WORLD_RUN_GROUND_FALLBACK_LABEL,
  WORLDS_VIEWPORT_CONTROL_MODES,
  resolveWorldsViewportModeShortcut,
  type WorldsViewportControlMode,
} from '../worldCameraNavigation.ts'

export interface WorldsViewportModeControlProps {
  mode: WorldsViewportControlMode
  status: string
  pointerLocked?: boolean
  onModeChange: (mode: WorldsViewportControlMode) => void
  onFrameScene: () => void
}

const MODE_COPY: Record<WorldsViewportControlMode, { label: string; tooltip: string; icon: JSX.Element }> = {
  inspect: {
    label: 'Inspect',
    tooltip: 'Inspect (1) — Orbit, pan, select, and edit',
    icon: <path d="M5 4l9 5-4 1.4 3 5.2-2.2 1.2-3-5.2L5 15V4z" />,
  },
  fly: {
    label: 'Fly',
    tooltip: 'Fly (2) — Free 6DOF; click viewport to capture pointer',
    icon: <path d="M3 11l16-7-5 16-3-6-8-3zm8.5 1.5l1.4 2.8 1.9-6-5.7 2.5 2.4.7z" />,
  },
  run: {
    label: 'Run',
    tooltip: 'Run (3) — Grounded editor navigation; does not start Play',
    icon: <path d="M10 4a2 2 0 114 0 2 2 0 01-4 0zm1.3 3.2l3.7.9 2 3.4-1.9 1.1-1.4-2.3-1.1-.3-.9 3 2.3 2.8-1.7 1.5-3-3.5.9-3.3-1.8 1.2-1.7 2.7-1.9-1.2 2.1-3.3 4.4-2.7z" />,
  },
}

const focusClass = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300'

function modeIndex(mode: WorldsViewportControlMode): number {
  return WORLDS_VIEWPORT_CONTROL_MODES.indexOf(mode)
}

export function WorldsViewportModeControl({ mode, status, pointerLocked = false, onModeChange, onFrameScene }: WorldsViewportModeControlProps): JSX.Element {
  const statusId = useId()
  const modes = useMemo(() => [...WORLDS_VIEWPORT_CONTROL_MODES], [])
  const modeButtons = useRef<Partial<Record<WorldsViewportControlMode, HTMLButtonElement | null>>>({})
  const modeButtonsOwnFocus = useRef(false)
  const groundFallbackActive = mode === 'run' && status.includes(WORLD_RUN_GROUND_FALLBACK_LABEL)

  const selectAndFocusMode = (nextMode: WorldsViewportControlMode) => {
    onModeChange(nextMode)
    const button = modeButtons.current[nextMode]
    if (button) button.focus()
  }

  useEffect(() => {
    if (modeButtonsOwnFocus.current) modeButtons.current[mode]?.focus()
  }, [mode])

  const handleRadioKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentMode: WorldsViewportControlMode) => {
    const shortcutMode = resolveWorldsViewportModeShortcut(event.code)
    if (shortcutMode) {
      event.preventDefault()
      event.stopPropagation()
      selectAndFocusMode(shortcutMode)
      return
    }
    const currentIndex = modeIndex(currentMode)
    const nextMode = event.key === 'ArrowRight' || event.key === 'ArrowDown'
      ? modes[(currentIndex + 1) % modes.length]
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        ? modes[(currentIndex + modes.length - 1) % modes.length]
        : event.key === 'Home'
          ? 'inspect'
          : event.key === 'End'
            ? 'run'
            : null
    if (!nextMode) return
    event.preventDefault()
    event.stopPropagation()
    selectAndFocusMode(nextMode)
  }

  return (
    <div className="pointer-events-none absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2">
      <div
        role="radiogroup"
        aria-label="Editor navigation mode"
        aria-describedby={statusId}
        className="pointer-events-auto flex items-center gap-1 rounded-2xl border border-zinc-700/70 bg-zinc-950/80 p-1 text-xs text-zinc-200 shadow-xl backdrop-blur"
      >
        {modes.map((candidate) => {
          const active = candidate === mode
          const copy = MODE_COPY[candidate]
          return (
            <Tooltip key={candidate} content={copy.tooltip}>
              <button
                ref={(element) => { modeButtons.current[candidate] = element }}
                type="button"
                role="radio"
                aria-checked={active}
                tabIndex={active ? 0 : -1}
                aria-label={copy.tooltip}
                className={`inline-flex min-h-9 min-w-9 items-center justify-center gap-1.5 rounded-xl border px-2.5 py-1 font-medium transition ${focusClass} ${active ? 'border-sky-300 bg-sky-400/20 text-sky-100 shadow-[0_0_0_1px_rgba(125,211,252,0.28)]' : 'border-transparent text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800/80 hover:text-zinc-50'}`}
                onClick={() => onModeChange(candidate)}
                onFocus={() => { modeButtonsOwnFocus.current = true }}
                onBlur={(event) => {
                  const focusRemainsOnMode = Object.values(modeButtons.current)
                    .some((button) => button === event.relatedTarget)
                  if (!focusRemainsOnMode) modeButtonsOwnFocus.current = false
                }}
                onKeyDown={(event) => handleRadioKeyDown(event, candidate)}
              >
                <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 fill-current">{copy.icon}</svg>
                <span>{copy.label}</span>
              </button>
            </Tooltip>
          )
        })}
      </div>
      <Tooltip content="Frame scene — return to Inspect and fit the scene">
        <button
          type="button"
          aria-label="Frame scene"
          className={`pointer-events-auto inline-flex min-h-9 min-w-9 items-center justify-center rounded-2xl border border-zinc-700/70 bg-zinc-950/80 text-zinc-100 shadow-xl backdrop-blur transition hover:border-sky-400/70 hover:text-sky-100 ${focusClass}`}
          onClick={onFrameScene}
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 fill-current"><path d="M4 4h4v2H6v2H4V4zm8 0h4v4h-2V6h-2V4zM4 12h2v2h2v2H4v-4zm10 0h2v4h-4v-2h2v-2zM8 8h4v4H8V8z" /></svg>
        </button>
      </Tooltip>
      {groundFallbackActive ? (
        <span
          aria-hidden="true"
          className="rounded-full border border-amber-400/50 bg-amber-400/10 px-2 py-1 text-[11px] font-medium text-amber-100 shadow-lg backdrop-blur"
        >Ground-only</span>
      ) : null}
      <div
        id={statusId}
        role="status"
        aria-live="polite"
        data-pointer-locked={pointerLocked ? 'true' : 'false'}
        className="sr-only"
      >
        {status}
      </div>
    </div>
  )
}

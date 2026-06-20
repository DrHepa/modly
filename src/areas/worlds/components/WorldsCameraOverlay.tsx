import {
  getWorldsCameraSpeedLabel,
  WORLD_CAMERA_SPEED_PRESETS,
} from '../worldCameraNavigation.ts'

export const WORLD_VIEWER_CAMERA_OVERLAY = {
  placement: 'compact-in-canvas-overlay',
  sidePanel: false,
  labels: {
    speed: 'Movement speed',
    reset: 'Reset camera',
    help: 'Camera and keyboard movement help',
  },
  helpText: 'Left-drag look · Right-drag pan · Wheel zoom · WASD/Arrows move · Space/E up · Q/Shift down',
} as const

export interface WorldsCameraOverlayProps {
  speed: number
  onSpeedChange: (speed: number) => void
  onResetCamera: () => void
  helpText?: string
}

const controlFocusClass = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400'

export function WorldsCameraOverlay({
  speed,
  onSpeedChange,
  onResetCamera,
  helpText = WORLD_VIEWER_CAMERA_OVERLAY.helpText,
}: WorldsCameraOverlayProps): JSX.Element {
  return (
    <div
      className="absolute left-3 top-14 z-10 flex max-w-[min(38rem,calc(100%-1.5rem))] flex-wrap items-center gap-1 rounded-2xl border border-zinc-700/70 bg-zinc-950/75 p-1 text-xs text-zinc-200 shadow-xl backdrop-blur"
      aria-label="Camera navigation controls"
    >
      <label className="flex items-center gap-1 rounded-full border border-zinc-700/70 px-2 py-1 text-zinc-200">
        <span>Speed</span>
        <select
          className={`bg-transparent text-zinc-100 ${controlFocusClass}`}
          aria-label={WORLD_VIEWER_CAMERA_OVERLAY.labels.speed}
          value={speed}
          onChange={(event) => onSpeedChange(Number(event.currentTarget.value))}
        >
          {WORLD_CAMERA_SPEED_PRESETS.map((preset) => (
            <option key={preset} value={preset} className="bg-zinc-950 text-zinc-100">
              {getWorldsCameraSpeedLabel(preset)}
            </option>
          ))}
        </select>
      </label>

      <button
        type="button"
        className={`rounded-full border border-zinc-700/70 px-2.5 py-1 text-zinc-100 ${controlFocusClass}`}
        aria-label={WORLD_VIEWER_CAMERA_OVERLAY.labels.reset}
        onClick={onResetCamera}
      >
        Reset camera
      </button>

      <span id="worlds-camera-help" className="px-2 py-1 text-zinc-300" aria-label={WORLD_VIEWER_CAMERA_OVERLAY.labels.help}>
        {helpText}
      </span>
    </div>
  )
}

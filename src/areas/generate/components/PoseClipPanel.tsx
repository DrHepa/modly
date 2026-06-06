import { MIN_POSE_CLIP_DURATION_SECONDS, MIN_POSE_CLIP_FPS, type PoseClipKeyframe } from '../poseClipPlan.ts'
import type { PoseClipRotationAxis } from '../poseClipPreview.ts'
import type { RigDisplayNamingResult } from '../rigDisplayNames.ts'
import type { RigBoneId, RigBoneNode, RigSkeletonSummary } from '../rigSkeleton.ts'

export type PoseClipPreviewState = 'idle' | 'playing' | 'paused'
export type PoseClipSaveState = 'idle' | 'saving' | 'saved' | 'error'
export type PoseClipLoadState = 'idle' | 'loading' | 'loaded' | 'error'
export type PoseClipWarningKind = 'missing-sidecar' | 'invalid-sidecar' | 'incompatible-sidecar' | 'unavailable-target'
export type PoseClipDrawerMode = 'expanded' | 'minimized'

export interface PoseClipPanelWarning {
  kind: PoseClipWarningKind
  message: string
}

export interface PoseClipPanelProps {
  summary?: RigSkeletonSummary
  selectedBoneId?: RigBoneId
  rigDisplayNames?: RigDisplayNamingResult
  keyframes: readonly PoseClipKeyframe[]
  selectedKeyframeId?: string
  currentTimeSeconds: number
  durationSeconds: number
  fps: number
  previewState: PoseClipPreviewState
  saveState: PoseClipSaveState
  loadState: PoseClipLoadState
  warnings?: readonly PoseClipPanelWarning[]
  saveError?: string
  loadError?: string
  rotationStepDegrees?: number
  drawerMode?: PoseClipDrawerMode
  onDrawerModeChange?: (drawerMode: PoseClipDrawerMode) => void
  onCurrentTimeChange: (timeSeconds: number) => void
  onClipMetadataChange: (metadata: { durationSeconds?: number; fps?: number }) => void
  onCaptureKeyframe: (boneId: RigBoneId, timeSeconds: number) => void
  onCaptureAndAdvance: (boneId: RigBoneId) => void
  onSelectKeyframe: (keyframeId: string, boneId: RigBoneId) => void
  onDeleteKeyframe: (keyframeId: string, boneId: RigBoneId) => void
  onUpdateSelectedKeyframe: (keyframeId: string, boneId: RigBoneId) => void
  onDeleteSelectedKeyframe: (keyframeId: string, boneId: RigBoneId) => void
  onMoveSelectedKeyframe: (keyframeId: string, timeSeconds: number) => void
  onShiftSelectedKeyframe: (keyframeId: string, deltaSeconds: number) => void
  onDuplicateSelectedKeyframe: (keyframeId: string) => void
  onPreviewPlay: () => void
  onPreviewPause: () => void
  onPreviewReset: () => void
  onRotateSelectedTarget: (boneId: RigBoneId, axis: PoseClipRotationAxis, degreesDelta: number) => void
  onResetSelectedTarget: (boneId: RigBoneId) => void
  onSaveSidecar: () => void
  onLoadSidecar: () => void
}

export function PoseClipPanel({
  summary,
  selectedBoneId,
  keyframes,
  currentTimeSeconds,
  durationSeconds,
  previewState,
  saveState,
  loadState,
  rotationStepDegrees = 10,
  onCurrentTimeChange,
  onCaptureKeyframe,
  onPreviewPlay,
  onPreviewPause,
  onPreviewReset,
  onRotateSelectedTarget,
  onResetSelectedTarget,
  onSaveSidecar,
  onLoadSidecar,
}: PoseClipPanelProps): JSX.Element {
  const selectedBone = findBone(summary, selectedBoneId)
  const orderedKeyframes = [...keyframes].sort((left, right) => left.timeSeconds - right.timeSeconds || left.id.localeCompare(right.id))
  const canUseTarget = Boolean(selectedBone)
  const previewToggle = previewState === 'playing'
    ? { title: 'Pause Pose/Clip preview', label: 'Pause Pose/Clip preview', onClick: onPreviewPause, text: 'Pause' }
    : { title: 'Play Pose/Clip preview', label: 'Play Pose/Clip preview', onClick: onPreviewPlay, text: 'Play' }
  const helpId = 'pose-clip-target-help'
  const actions = (
    <>
      {(['x', 'y', 'z'] as const).flatMap((axis) => [
        <button key={`${axis}-negative`} type="button" title={`Rotate selected target -${axis.toUpperCase()}`} aria-label={`Rotate selected target -${axis.toUpperCase()}`} aria-describedby={!canUseTarget ? helpId : undefined} disabled={!canUseTarget} onClick={() => { if (selectedBone) onRotateSelectedTarget(selectedBone.boneId, axis, -rotationStepDegrees) }} className={smallButtonClassName}>-{axis.toUpperCase()}</button>,
        <button key={`${axis}-positive`} type="button" title={`Rotate selected target +${axis.toUpperCase()}`} aria-label={`Rotate selected target +${axis.toUpperCase()}`} aria-describedby={!canUseTarget ? helpId : undefined} disabled={!canUseTarget} onClick={() => { if (selectedBone) onRotateSelectedTarget(selectedBone.boneId, axis, rotationStepDegrees) }} className={smallButtonClassName}>+{axis.toUpperCase()}</button>,
      ])}
      <button type="button" title="Reset selected target pose" aria-label="Reset selected target pose" aria-describedby={!canUseTarget ? helpId : undefined} disabled={!canUseTarget} onClick={() => { if (selectedBone) onResetSelectedTarget(selectedBone.boneId) }} className={controlButtonClassName}>Reset target</button>
      <button type="button" title="Capture pose keyframe" aria-label="Capture pose keyframe" aria-describedby={!canUseTarget ? helpId : undefined} disabled={!canUseTarget} onClick={() => { if (selectedBone) onCaptureKeyframe(selectedBone.boneId, currentTimeSeconds) }} className={controlButtonClassName}>Capture keyframe at {formatTime(currentTimeSeconds)}</button>
      <label className="flex min-w-40 items-center gap-2 text-xs text-zinc-300">
        <span>Current time</span>
        <input type="range" title="Current time scrubber" aria-label="Current time scrubber" min={0} max={normalizeDuration(durationSeconds)} step="0.001" value={clampTime(currentTimeSeconds, durationSeconds)} onChange={(event) => onCurrentTimeChange(clampTime(event.currentTarget.valueAsNumber, durationSeconds))} className="w-28 accent-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300" />
      </label>
      <span className="rounded-full border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300">{formatTime(currentTimeSeconds)} / {formatTime(durationSeconds)}</span>
      <button type="button" title={previewToggle.title} aria-label={previewToggle.label} disabled={orderedKeyframes.length === 0} onClick={previewToggle.onClick} className={controlButtonClassName}>{previewToggle.text}</button>
      <button type="button" title="Reset Pose/Clip preview" aria-label="Reset Pose/Clip preview" onClick={onPreviewReset} className={controlButtonClassName}>Reset</button>
      <button type="button" title="Save pose clip sidecar" aria-label="Save pose clip sidecar" disabled={saveState === 'saving'} onClick={onSaveSidecar} className={controlButtonClassName}>{saveState === 'saving' ? 'Saving sidecar' : saveState === 'saved' ? 'Sidecar saved' : 'Save sidecar'}</button>
      <button type="button" title="Load pose clip sidecar" aria-label="Load pose clip sidecar" disabled={loadState === 'loading'} onClick={onLoadSidecar} className={controlButtonClassName}>{loadState === 'loading' ? 'Loading sidecar' : loadState === 'loaded' ? 'Sidecar loaded' : 'Load sidecar'}</button>
    </>
  )

  return (
    <aside aria-label="Pose/Clip action rail" className="flex w-full items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-950/90 px-3 py-2 text-sm text-zinc-200 shadow-2xl shadow-black/40">
      <section role="region" aria-label="Pose/Clip controls" className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-300">Pose/Clip</span>
        {!canUseTarget ? <span id={helpId} className="sr-only">Select a Rig Editor target before using target actions.</span> : null}
        {actions}
      </section>
    </aside>
  )
}

const controlButtonClassName = 'rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm font-medium text-zinc-100 transition hover:border-cyan-400/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:opacity-60'
const smallButtonClassName = 'rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-200 transition hover:border-cyan-400/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:opacity-60'

function findBone(summary: RigSkeletonSummary | undefined, boneId: RigBoneId | undefined): RigBoneNode | undefined {
  if (!summary || !boneId) return undefined
  return summary.bones.find((bone) => bone.boneId === boneId)
}

function formatTime(timeSeconds: number): string {
  return `${Math.max(0, timeSeconds).toFixed(2)}s`
}

function normalizeDuration(durationSeconds: number): number {
  return Number.isFinite(durationSeconds) ? Math.max(durationSeconds, MIN_POSE_CLIP_DURATION_SECONDS) : MIN_POSE_CLIP_DURATION_SECONDS
}

function clampTime(timeSeconds: number, durationSeconds: number): number {
  if (!Number.isFinite(timeSeconds)) return 0
  return Math.min(Math.max(timeSeconds, 0), normalizeDuration(durationSeconds))
}

void MIN_POSE_CLIP_FPS

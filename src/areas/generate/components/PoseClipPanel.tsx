import { MIN_POSE_CLIP_DURATION_SECONDS, type PoseClipKeyframe } from '../poseClipPlan.ts'
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
  /** Source-backed IO capabilities are owned by the Viewer, not inferred here. */
  canSaveSidecar?: boolean
  canLoadSidecar?: boolean
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
  canSaveSidecar = false,
  canLoadSidecar = false,
  saveState,
  loadState,
  warnings = [],
  saveError,
  loadError,
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
  const hasRig = Boolean(summary?.hasRig)
  const selectedBone = hasRig ? findBone(summary, selectedBoneId) : undefined
  const busy = saveState === 'saving' || loadState === 'loading'
  const canEdit = hasRig && !busy
  const canUseTarget = Boolean(selectedBone) && canEdit
  const canRotate = canUseTarget && Number.isFinite(rotationStepDegrees)
  const canCapture = canUseTarget && Number.isFinite(currentTimeSeconds)
  const canPreview = canEdit && keyframes.some(keyframe => Boolean(findBone(summary, keyframe.boneId)))
  const canSave = canEdit && canSaveSidecar
  const canLoad = canEdit && canLoadSidecar
  const previewToggle = previewState === 'playing'
    ? { title: 'Pause Pose/Clip preview', label: 'Pause Pose/Clip preview', onClick: () => { if (!busy) onPreviewPause() }, text: 'Pause' }
    : { title: 'Play Pose/Clip preview', label: 'Play Pose/Clip preview', onClick: () => { if (canPreview) onPreviewPlay() }, text: 'Play' }
  const helpId = 'pose-clip-target-help'
  const actions = (
    <>
      {(['x', 'y', 'z'] as const).flatMap((axis) => [
        <button key={`${axis}-negative`} type="button" title={`Rotate selected target -${axis.toUpperCase()}`} aria-label={`Rotate selected target -${axis.toUpperCase()}`} aria-describedby={!canRotate ? helpId : undefined} disabled={!canRotate} onClick={() => { if (canRotate && selectedBone) onRotateSelectedTarget(selectedBone.boneId, axis, -rotationStepDegrees) }} className={smallButtonClassName}>-{axis.toUpperCase()}</button>,
        <button key={`${axis}-positive`} type="button" title={`Rotate selected target +${axis.toUpperCase()}`} aria-label={`Rotate selected target +${axis.toUpperCase()}`} aria-describedby={!canRotate ? helpId : undefined} disabled={!canRotate} onClick={() => { if (canRotate && selectedBone) onRotateSelectedTarget(selectedBone.boneId, axis, rotationStepDegrees) }} className={smallButtonClassName}>+{axis.toUpperCase()}</button>,
      ])}
      <button type="button" title="Reset selected target pose" aria-label="Reset selected target pose" aria-describedby={!canUseTarget ? helpId : undefined} disabled={!canUseTarget} onClick={() => { if (canUseTarget && selectedBone) onResetSelectedTarget(selectedBone.boneId) }} className={controlButtonClassName}>Reset target</button>
      <button type="button" title="Capture pose keyframe" aria-label="Capture pose keyframe" aria-describedby={!canCapture ? helpId : undefined} disabled={!canCapture} onClick={() => { if (canCapture && selectedBone) onCaptureKeyframe(selectedBone.boneId, currentTimeSeconds) }} className={controlButtonClassName}>Capture keyframe at {formatTime(currentTimeSeconds)}</button>
      <label className="flex min-w-40 items-center gap-2 text-xs text-zinc-300">
        <span>Current time</span>
        <input type="range" title="Current time scrubber" aria-label="Current time scrubber" min={0} max={normalizeDuration(durationSeconds)} step="0.001" value={clampTime(currentTimeSeconds, durationSeconds)} disabled={!canEdit} onChange={(event) => { if (canEdit && Number.isFinite(event.currentTarget.valueAsNumber)) onCurrentTimeChange(clampTime(event.currentTarget.valueAsNumber, durationSeconds)) }} className="w-28 accent-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300" />
      </label>
      <span className="rounded-full border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300">{formatTime(currentTimeSeconds)} / {formatTime(durationSeconds)}</span>
      <button type="button" title={previewToggle.title} aria-label={previewToggle.label} disabled={busy || (previewState !== 'playing' && !canPreview)} onClick={previewToggle.onClick} className={controlButtonClassName}>{previewToggle.text}</button>
      <button type="button" title="Reset Pose/Clip preview" aria-label="Reset Pose/Clip preview" disabled={busy} onClick={() => { if (!busy) onPreviewReset() }} className={controlButtonClassName}>Reset</button>
      <button type="button" title="Save pose clip sidecar" aria-label="Save pose clip sidecar" disabled={!canSave} onClick={() => { if (canSave) onSaveSidecar() }} className={controlButtonClassName}>{saveState === 'saving' ? 'Saving sidecar' : saveState === 'saved' ? 'Sidecar saved' : 'Save sidecar'}</button>
      <button type="button" title="Load pose clip sidecar" aria-label="Load pose clip sidecar" disabled={!canLoad} onClick={() => { if (canLoad) onLoadSidecar() }} className={controlButtonClassName}>{loadState === 'loading' ? 'Loading sidecar' : loadState === 'loaded' ? 'Sidecar loaded' : 'Load sidecar'}</button>
    </>
  )

  return (
    <aside aria-label="Pose/Clip action rail" className="flex w-full items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-950/90 px-3 py-2 text-sm text-zinc-200 shadow-2xl shadow-black/40">
      <section role="region" aria-label="Pose/Clip controls" className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-300">Pose/Clip</span>
        {!canRotate || !canCapture ? <span id={helpId} role="status" className="text-xs text-amber-100">{busy ? 'Sidecar operation in progress.' : !selectedBone ? 'Select a target in Rig Editor.' : 'Use finite time and rotation values.'}</span> : null}
        {actions}
        {warnings.map((warning, index) => <span key={`${warning.kind}-${index}`} role="status" className="text-xs text-amber-100">{warning.message}</span>)}
        {saveState === 'error' ? <span role="alert" className="text-xs text-red-200">{saveError || 'Pose clip could not be saved. Try again.'}</span> : null}
        {loadState === 'error' ? <span role="alert" className="text-xs text-red-200">{loadError || 'Pose clip could not be loaded. Try again.'}</span> : null}
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

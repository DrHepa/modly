import { MIN_POSE_CLIP_DURATION_SECONDS, MIN_POSE_CLIP_FPS, type PoseClipKeyframe } from '../poseClipPlan.ts'
import type { PoseClipRotationAxis } from '../poseClipPreview.ts'
import { resolveRigDisplayName, type RigDisplayNamingResult } from '../rigDisplayNames.ts'
import type { RigBoneId, RigBoneNode, RigSkeletonSummary } from '../rigSkeleton.ts'
import { RigTargetBrowser } from './RigTargetBrowser'

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
  onSelectBone: (boneId: RigBoneId) => void
}

export function PoseClipPanel({
  summary,
  selectedBoneId,
  rigDisplayNames,
  keyframes,
  selectedKeyframeId,
  currentTimeSeconds,
  durationSeconds,
  fps,
  previewState,
  saveState,
  loadState,
  warnings = [],
  saveError,
  loadError,
  rotationStepDegrees = 10,
  drawerMode = 'expanded',
  onDrawerModeChange,
  onCurrentTimeChange,
  onClipMetadataChange,
  onCaptureKeyframe,
  onCaptureAndAdvance,
  onSelectKeyframe,
  onDeleteKeyframe,
  onUpdateSelectedKeyframe,
  onDeleteSelectedKeyframe,
  onMoveSelectedKeyframe,
  onShiftSelectedKeyframe,
  onDuplicateSelectedKeyframe,
  onPreviewPlay,
  onPreviewPause,
  onPreviewReset,
  onRotateSelectedTarget,
  onResetSelectedTarget,
  onSaveSidecar,
  onLoadSidecar,
  onSelectBone,
}: PoseClipPanelProps): JSX.Element {
  const hasRig = Boolean(summary?.hasRig)
  const selectedBone = findBone(summary, selectedBoneId)
  const selectedDisplayName = selectedBone ? resolveRigDisplayName(selectedBone, rigDisplayNames) : undefined
  const selectedTargetUnavailable = Boolean(hasRig && selectedBoneId && !selectedBone)
  const canCapture = Boolean(selectedBone)
  const orderedKeyframes = [...keyframes].sort((left, right) => left.timeSeconds - right.timeSeconds || left.id.localeCompare(right.id))
  const selectedKeyframe = selectedKeyframeId ? orderedKeyframes.find((keyframe) => keyframe.id === selectedKeyframeId) : undefined
  const selectedKeyframeBone = findBone(summary, selectedKeyframe?.boneId)
  const hasSelectedKeyframeActions = Boolean(hasRig && selectedBone && selectedKeyframe && selectedKeyframeBone)
  const frameStepSeconds = 1 / Math.max(normalizeFps(fps), MIN_POSE_CLIP_FPS)
  const previewToggle = previewState === 'playing'
    ? { title: 'Pause Pose/Clip preview', label: 'Pause Pose/Clip preview', onClick: onPreviewPause }
    : { title: 'Play Pose/Clip preview', label: 'Play Pose/Clip preview', onClick: onPreviewPlay }
  const keyframeSummary = `${orderedKeyframes.length} ${orderedKeyframes.length === 1 ? 'keyframe' : 'keyframes'}`

  if (drawerMode === 'minimized') {
    return (
      <aside aria-label="Pose/Clip minimized summary rail" className="flex w-full items-center justify-between gap-3 rounded-2xl border border-zinc-800 bg-zinc-950/90 px-3 py-2 text-sm text-zinc-200 shadow-2xl shadow-black/40">
        <section role="region" aria-label="Pose/Clip minimized expert controls" className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-300">Pose/Clip</span>
          {!selectedBone ? <span id="pose-clip-minimized-rotation-help" className="text-xs text-amber-100">Select a rig target to enable local rotation controls.</span> : null}
          <button type="button" title="Rotate selected target -X" aria-label="Rotate selected target -X" aria-describedby={!selectedBone ? 'pose-clip-minimized-rotation-help' : undefined} disabled={!selectedBone} onClick={() => { if (selectedBone) onRotateSelectedTarget(selectedBone.boneId, 'x', -rotationStepDegrees) }} className={smallButtonClassName}>-X</button>
          <button type="button" title="Rotate selected target +X" aria-label="Rotate selected target +X" aria-describedby={!selectedBone ? 'pose-clip-minimized-rotation-help' : undefined} disabled={!selectedBone} onClick={() => { if (selectedBone) onRotateSelectedTarget(selectedBone.boneId, 'x', rotationStepDegrees) }} className={smallButtonClassName}>+X</button>
          <button type="button" title="Rotate selected target -Y" aria-label="Rotate selected target -Y" aria-describedby={!selectedBone ? 'pose-clip-minimized-rotation-help' : undefined} disabled={!selectedBone} onClick={() => { if (selectedBone) onRotateSelectedTarget(selectedBone.boneId, 'y', -rotationStepDegrees) }} className={smallButtonClassName}>-Y</button>
          <button type="button" title="Rotate selected target +Y" aria-label="Rotate selected target +Y" aria-describedby={!selectedBone ? 'pose-clip-minimized-rotation-help' : undefined} disabled={!selectedBone} onClick={() => { if (selectedBone) onRotateSelectedTarget(selectedBone.boneId, 'y', rotationStepDegrees) }} className={smallButtonClassName}>+Y</button>
          <button type="button" title="Rotate selected target -Z" aria-label="Rotate selected target -Z" aria-describedby={!selectedBone ? 'pose-clip-minimized-rotation-help' : undefined} disabled={!selectedBone} onClick={() => { if (selectedBone) onRotateSelectedTarget(selectedBone.boneId, 'z', -rotationStepDegrees) }} className={smallButtonClassName}>-Z</button>
          <button type="button" title="Rotate selected target +Z" aria-label="Rotate selected target +Z" aria-describedby={!selectedBone ? 'pose-clip-minimized-rotation-help' : undefined} disabled={!selectedBone} onClick={() => { if (selectedBone) onRotateSelectedTarget(selectedBone.boneId, 'z', rotationStepDegrees) }} className={smallButtonClassName}>+Z</button>
          <button
            type="button"
            title="Capture pose keyframe"
            aria-label="Capture pose keyframe"
            aria-describedby={!canCapture ? 'pose-clip-minimized-capture-help' : undefined}
            className={controlButtonClassName}
            disabled={!canCapture}
            onClick={() => {
              if (selectedBone) onCaptureKeyframe(selectedBone.boneId, currentTimeSeconds)
            }}
          >
            Capture keyframe at {formatTime(currentTimeSeconds)}
          </button>
          {!canCapture ? <span id="pose-clip-minimized-capture-help" role="status" className="text-xs text-amber-100">Select a rig target to enable capture.</span> : null}
          <label className="flex min-w-40 items-center gap-2 text-xs text-zinc-300">
            <span>Current time</span>
            <input
              type="range"
              title="Current time scrubber"
              aria-label="Current time scrubber"
              min={0}
              max={normalizeDuration(durationSeconds)}
              step="0.001"
              value={clampTime(currentTimeSeconds, durationSeconds)}
              onChange={(event) => onCurrentTimeChange(clampTime(event.currentTarget.valueAsNumber, durationSeconds))}
              className="w-28 accent-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
            />
          </label>
          <span className="rounded-full border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300">{formatTime(currentTimeSeconds)} / {formatTime(durationSeconds)}</span>
          <button type="button" title={previewToggle.title} aria-label={previewToggle.label} disabled={orderedKeyframes.length === 0} onClick={previewToggle.onClick} className={controlButtonClassName}>
            {previewState === 'playing' ? 'Pause' : 'Play'}
          </button>
          <button type="button" title="Reset Pose/Clip preview" aria-label="Reset Pose/Clip preview" onClick={onPreviewReset} className={controlButtonClassName}>
            Reset
          </button>
          <button type="button" title="Save pose clip sidecar" aria-label="Save pose clip sidecar" disabled={saveState === 'saving'} onClick={onSaveSidecar} className={controlButtonClassName}>
            {saveState === 'saving' ? 'Saving sidecar' : saveState === 'saved' ? 'Sidecar saved' : 'Save sidecar'}
          </button>
          <button type="button" title="Load pose clip sidecar" aria-label="Load pose clip sidecar" disabled={loadState === 'loading'} onClick={onLoadSidecar} className={controlButtonClassName}>
            {loadState === 'loading' ? 'Loading sidecar' : loadState === 'loaded' ? 'Sidecar loaded' : 'Load sidecar'}
          </button>
        </section>
        <button
          type="button"
          title="Expand Pose/Clip drawer"
          aria-label="Expand Pose/Clip drawer"
          onClick={() => onDrawerModeChange?.('expanded')}
          className="shrink-0 rounded-lg border border-cyan-400/50 bg-cyan-500/15 px-3 py-1.5 text-xs font-medium text-cyan-50 transition hover:bg-cyan-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
        >
          Expand
        </button>
      </aside>
    )
  }

  return (
    <aside aria-label="Pose/Clip compact minimizable bottom drawer" className="flex max-h-[34vh] w-full flex-col gap-2 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/90 p-3 text-sm text-zinc-200 shadow-2xl shadow-black/40">
      <header className="flex shrink-0 items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-xs uppercase tracking-[0.2em] text-cyan-300">Pose/Clip</p>
          <h2 className="text-base font-semibold text-white">Pose/Clip authoring</h2>
          <p className="text-xs leading-5 text-zinc-400">
            Compact drawer · {keyframeSummary}. Create a small generated pose clip without changing the source GLB.
          </p>
        </div>
        <button
          type="button"
          title="Minimize Pose/Clip drawer"
          aria-label="Minimize Pose/Clip drawer"
          onClick={() => onDrawerModeChange?.('minimized')}
          className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs font-medium text-zinc-100 transition hover:border-cyan-400/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
        >
          Minimize
        </button>
      </header>

      {!hasRig ? <NoRigState /> : null}
      {selectedTargetUnavailable ? <UnavailableTargetState /> : null}
      {warnings.length > 0 ? <WarningList warnings={warnings} /> : null}

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <div className="space-y-3">
          <section
            role="region"
            aria-label="Pose editing workbench"
            className="grid gap-2 rounded-2xl border border-cyan-400/20 bg-cyan-950/10 p-2 lg:grid-cols-[minmax(17rem,0.9fr)_minmax(22rem,1.1fr)]"
          >
            <div className="space-y-2">
              {summary?.hasRig ? (
                <CompactSection title="1. Choose a rig target" ariaLabel="Pose/Clip target selection section">
                  <>
                    <div className="mb-2 px-1">
                      <h3 className="text-sm font-medium text-zinc-100">Target browser</h3>
                      <p className="text-xs text-zinc-500">Start by selecting the rig target you want to pose and capture.</p>
                    </div>
                    <RigTargetBrowser summary={summary} selectedBoneId={selectedBoneId} effectiveNaming={rigDisplayNames} onSelectBone={onSelectBone} />
                  </>
                </CompactSection>
              ) : null}

              <section aria-label="Selected Pose/Clip target" className="rounded-xl border border-cyan-400/30 bg-cyan-950/20 p-2 shadow-inner shadow-cyan-950/20">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-sm font-medium text-white">Selected target</h3>
                    {selectedBone ? (
                      <>
                        <p className="truncate text-sm text-zinc-100">{selectedDisplayName?.label || 'Unnamed bone'}</p>
                        <p className="text-xs text-zinc-300">Name source: {formatNameProvenance(selectedDisplayName?.provenance ?? 'raw')}</p>
                        <p className="text-xs text-zinc-300">Original name: {selectedBone.originalName || 'Unnamed bone'}</p>
                        <p className="break-all text-[11px] text-zinc-400">Stable id: {selectedBone.boneId}</p>
                        <p className="text-xs text-zinc-400">Path: {selectedBone.path.join(' / ')}</p>
                      </>
                    ) : (
                      <p className="text-sm text-zinc-300">Select a rig target to capture a keyframe.</p>
                    )}
                  </div>
                  <span className="shrink-0 rounded-full border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-zinc-300">
                    {formatTime(currentTimeSeconds)} / {formatTime(durationSeconds)}
                  </span>
                </div>
                <p className="mt-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-2 py-1.5 text-xs text-zinc-300">
                  Next, adjust the pose and capture it before checking playback.
                </p>
              </section>
            </div>

            <div className="space-y-2">
              <CompactSection title="2. Adjust the selected pose" ariaLabel="Pose/Clip pose controls section">
                <section aria-label="Rotate selected target" className="rounded-xl border border-cyan-400/30 bg-zinc-900/40 p-2">
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-medium text-zinc-100">Rotate selected target</h3>
                      <p className="text-xs text-zinc-500">Use small local rotations before capturing a keyframe.</p>
                    </div>
                    <span className="rounded-full bg-zinc-950 px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-zinc-400">Step: {formatDegrees(rotationStepDegrees)}</span>
                  </div>
                  {!selectedBone ? <p id="pose-clip-rotation-help" className="mb-2 text-xs text-amber-100">Select a rig target to enable local rotation controls.</p> : null}
                  <div className="grid grid-cols-3 gap-1.5">
                    {(['x', 'y', 'z'] as const).map((axis) => (
                      <div key={axis} className="grid grid-cols-2 gap-1 rounded-lg border border-zinc-800 bg-zinc-950/60 p-1" aria-label={`Local ${axis.toUpperCase()} rotation controls`}>
                        <button
                          type="button"
                          title={`Rotate selected target -${axis.toUpperCase()}`}
                          aria-label={`Rotate selected target -${axis.toUpperCase()}`}
                          aria-describedby={!selectedBone ? 'pose-clip-rotation-help' : undefined}
                          disabled={!selectedBone}
                          onClick={() => {
                            if (selectedBone) onRotateSelectedTarget(selectedBone.boneId, axis, -rotationStepDegrees)
                          }}
                          className={smallButtonClassName}
                        >
                          -{axis.toUpperCase()}
                        </button>
                        <button
                          type="button"
                          title={`Rotate selected target +${axis.toUpperCase()}`}
                          aria-label={`Rotate selected target +${axis.toUpperCase()}`}
                          aria-describedby={!selectedBone ? 'pose-clip-rotation-help' : undefined}
                          disabled={!selectedBone}
                          onClick={() => {
                            if (selectedBone) onRotateSelectedTarget(selectedBone.boneId, axis, rotationStepDegrees)
                          }}
                          className={smallButtonClassName}
                        >
                          +{axis.toUpperCase()}
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    title="Reset selected target pose"
                    aria-label="Reset selected target pose"
                    aria-describedby={!selectedBone ? 'pose-clip-rotation-help' : undefined}
                    disabled={!selectedBone}
                    onClick={() => {
                      if (selectedBone) onResetSelectedTarget(selectedBone.boneId)
                    }}
                    className={`${controlButtonClassName} mt-2 w-full`}
                  >
                    Reset selected/current pose
                  </button>
                </section>
              </CompactSection>

              <CompactSection title="3. Capture keyframe" ariaLabel="Pose/Clip timeline capture section">
                <section aria-label="Pose/Clip timeline controls" className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-2">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-zinc-100">Timeline controls</h3>
              <p className="text-xs text-zinc-500">Scrub, set timing metadata, and capture without changing the source GLB.</p>
            </div>
            <span className="rounded-full bg-zinc-950 px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-zinc-400">{formatTime(currentTimeSeconds)}</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_6rem]">
            <label className="space-y-1 text-xs text-zinc-300">
              <span>Current time</span>
              <input
                type="range"
                title="Current time scrubber"
                aria-label="Current time scrubber"
                min={0}
                max={normalizeDuration(durationSeconds)}
                step="0.001"
                value={clampTime(currentTimeSeconds, durationSeconds)}
                onChange={(event) => onCurrentTimeChange(clampTime(event.currentTarget.valueAsNumber, durationSeconds))}
                className="w-full accent-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
              />
            </label>
            <label className="space-y-1 text-xs text-zinc-300">
              <span>Seconds</span>
              <input
                type="number"
                title="Current time seconds"
                aria-label="Current time seconds"
                min={0}
                max={normalizeDuration(durationSeconds)}
                step="0.001"
                value={clampTime(currentTimeSeconds, durationSeconds)}
                onChange={(event) => onCurrentTimeChange(clampTime(event.currentTarget.valueAsNumber, durationSeconds))}
                className={numberInputClassName}
              />
            </label>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="space-y-1 text-xs text-zinc-300">
              <span>Duration</span>
              <input
                type="number"
                title="Duration seconds"
                aria-label="Duration seconds"
                min={MIN_POSE_CLIP_DURATION_SECONDS}
                step="0.001"
                value={normalizeDuration(durationSeconds)}
                onChange={(event) => onClipMetadataChange({ durationSeconds: normalizeDuration(event.currentTarget.valueAsNumber) })}
                className={numberInputClassName}
              />
            </label>
            <label className="space-y-1 text-xs text-zinc-300">
              <span>FPS</span>
              <input
                type="number"
                title="Frames per second"
                aria-label="Frames per second"
                min={MIN_POSE_CLIP_FPS}
                step="1"
                value={normalizeFps(fps)}
                onChange={(event) => onClipMetadataChange({ fps: normalizeFps(event.currentTarget.valueAsNumber) })}
                className={numberInputClassName}
              />
            </label>
          </div>
          <button
            type="button"
            title="Capture pose keyframe"
            aria-label="Capture pose keyframe"
            aria-describedby={!canCapture ? 'pose-clip-capture-help' : undefined}
            className="mt-3 w-full rounded-lg border border-cyan-400/40 bg-cyan-500/15 px-3 py-2 text-sm font-medium text-cyan-50 transition hover:bg-cyan-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:bg-zinc-900 disabled:text-zinc-500"
            disabled={!canCapture}
            onClick={() => {
              if (selectedBone) onCaptureKeyframe(selectedBone.boneId, currentTimeSeconds)
            }}
          >
            Capture keyframe at {formatTime(currentTimeSeconds)}
          </button>
          {!selectedBone ? <p id="pose-clip-capture-help" role="status" className="mt-2 text-xs text-amber-100">Select a rig target to enable capture and advance.</p> : null}
          <button
            type="button"
            title="Capture & advance selected target"
            aria-label="Capture & advance selected target"
            aria-describedby={!canCapture ? 'pose-clip-capture-help' : undefined}
            disabled={!canCapture}
            onClick={() => {
              if (selectedBone) onCaptureAndAdvance(selectedBone.boneId)
            }}
            className={`${controlButtonClassName} mt-3 w-full`}
          >
            Capture & advance
          </button>
        </section>
      </CompactSection>
            </div>
          </section>

      <section aria-label="Pose/Clip preview controls" className="rounded-xl border border-cyan-400/25 bg-zinc-900/50 p-3">
        <div className="mb-3">
          <h3 className="text-sm font-medium text-zinc-100">Pose/Clip preview</h3>
          <p className="text-xs text-zinc-500">These controls preview only the generated pose clip. The left rail GLTF animation controls stay separate.</p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <button type="button" title={previewToggle.title} aria-label={previewToggle.label} aria-describedby={orderedKeyframes.length === 0 ? 'pose-clip-preview-help' : undefined} disabled={orderedKeyframes.length === 0} onClick={previewToggle.onClick} className={controlButtonClassName}>
            {previewState === 'playing' ? 'Pause' : 'Play'}
          </button>
          <button type="button" title="Reset Pose/Clip preview" aria-label="Reset Pose/Clip preview" onClick={onPreviewReset} className={controlButtonClassName}>
            Reset
          </button>
          <span className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-center text-xs text-zinc-400" aria-label="Pose/Clip preview state">
            {formatPreviewState(previewState)}
          </span>
        </div>
        {orderedKeyframes.length === 0 ? <p id="pose-clip-preview-help" role="status" className="mt-2 text-xs text-amber-100">Capture a keyframe to enable Pose/Clip preview playback.</p> : null}
      </section>

          <div className="grid gap-3 lg:grid-cols-[minmax(18rem,0.85fr)_minmax(24rem,1.15fr)]">
            <div className="space-y-3">
      <CompactSection title="4. Save or load sidecar" ariaLabel="Pose/Clip sidecar section">
      <section aria-label="Pose/Clip sidecar actions" className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
        <h3 className="text-sm font-medium text-zinc-100">Sidecar file</h3>
        <p className="mt-1 text-xs text-zinc-500">Save or load the editable `.pose-clip.v1.json` sidecar. This MVP does not export an embedded animation into the GLB.</p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" title="Save pose clip sidecar" aria-label="Save pose clip sidecar" disabled={saveState === 'saving'} onClick={onSaveSidecar} className={controlButtonClassName}>
            {saveState === 'saving' ? 'Saving sidecar' : saveState === 'saved' ? 'Sidecar saved' : 'Save sidecar'}
          </button>
          <button type="button" title="Load pose clip sidecar" aria-label="Load pose clip sidecar" disabled={loadState === 'loading'} onClick={onLoadSidecar} className={controlButtonClassName}>
            {loadState === 'loading' ? 'Loading sidecar' : loadState === 'loaded' ? 'Sidecar loaded' : 'Load sidecar'}
          </button>
        </div>
        {saveState === 'error' && saveError ? <p role="status" className="mt-2 text-xs text-red-200">{saveError}</p> : null}
        {loadState === 'error' && loadError ? <p role="status" className="mt-2 text-xs text-red-200">{loadError}</p> : null}
      </section>
      </CompactSection>

      <CompactSection title="5. Review captured keyframes" ariaLabel="Pose/Clip keyframe review section">
      <section aria-label="Pose/Clip timeline" className="min-h-0 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium text-zinc-100">Timeline keyframes</h3>
            <p className="text-xs text-zinc-500">Rows show labels for people; actions still use stable bone ids.</p>
          </div>
          <span className="rounded-full bg-zinc-950 px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-zinc-400">{orderedKeyframes.length} keys</span>
        </div>
        {orderedKeyframes.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-700 p-3 text-xs text-zinc-400">No keyframes yet. Select a target, adjust the pose in the viewer, then capture the first keyframe.</p>
        ) : (
          <ol className="max-h-72 space-y-2 overflow-y-auto pr-1" aria-label="Captured Pose/Clip keyframes">
            {orderedKeyframes.map((keyframe) => {
              const bone = findBone(summary, keyframe.boneId)
              const displayName = bone ? resolveRigDisplayName(bone, rigDisplayNames) : undefined
              const label = displayName?.label ?? 'Unavailable target'
              const originalName = bone?.originalName ?? keyframe.boneId
              return (
                <li key={keyframe.id} aria-current={keyframe.id === selectedKeyframeId ? 'time' : undefined} className={`rounded-lg border p-3 ${keyframe.id === selectedKeyframeId ? 'border-cyan-400/60 bg-cyan-950/30' : 'border-zinc-800 bg-zinc-950/70'}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-zinc-100">{formatTime(keyframe.timeSeconds)} · {label}</p>
                      {keyframe.id === selectedKeyframeId ? <p className="text-xs font-medium text-cyan-200">Selected keyframe: {keyframe.id}</p> : null}
                      <p className="text-xs text-zinc-400">Original name: {originalName}</p>
                      <p className="break-all text-[11px] text-zinc-500">{keyframe.boneId}</p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button type="button" aria-label={`Select keyframe ${keyframe.id}`} title={`Select keyframe ${keyframe.id}`} className={smallButtonClassName} onClick={() => onSelectKeyframe(keyframe.id, keyframe.boneId)}>
                        Select
                      </button>
                      <button type="button" aria-label={`Delete keyframe ${keyframe.id}`} title={`Delete keyframe ${keyframe.id}`} className={smallButtonClassName} onClick={() => onDeleteKeyframe(keyframe.id, keyframe.boneId)}>
                        Delete
                      </button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </section>
      </CompactSection>
            </div>

            <div className="space-y-3">
      <CompactSection title="Selected keyframe actions" ariaLabel="Pose/Clip selected keyframe actions section">
        <section aria-label="Selected keyframe actions" className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-zinc-100">Selected keyframe actions</h3>
              <p className="text-xs text-zinc-500">Update from the current pose/time, move one frame, duplicate, or delete.</p>
            </div>
            <span className="rounded-full bg-zinc-950 px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-zinc-400">Step {formatTime(frameStepSeconds)}</span>
          </div>
          {!hasSelectedKeyframeActions ? <p id="pose-clip-selected-keyframe-help" role="status" className="mb-3 text-xs text-amber-100">Select a keyframe to enable update, delete, move, and duplicate.</p> : null}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <button type="button" title="Update selected keyframe" aria-label="Update selected keyframe" aria-describedby={!hasSelectedKeyframeActions ? 'pose-clip-selected-keyframe-help' : undefined} disabled={!hasSelectedKeyframeActions} onClick={() => { if (selectedKeyframe && selectedKeyframeBone) onUpdateSelectedKeyframe(selectedKeyframe.id, selectedKeyframeBone.boneId) }} className={controlButtonClassName}>Update</button>
            <button type="button" title="Delete selected keyframe" aria-label="Delete selected keyframe" aria-describedby={!hasSelectedKeyframeActions ? 'pose-clip-selected-keyframe-help' : undefined} disabled={!hasSelectedKeyframeActions} onClick={() => { if (selectedKeyframe && selectedKeyframeBone) onDeleteSelectedKeyframe(selectedKeyframe.id, selectedKeyframeBone.boneId) }} className={controlButtonClassName}>Delete</button>
            <button type="button" title="Move selected keyframe backward one frame" aria-label="Move selected keyframe backward one frame" aria-describedby={!hasSelectedKeyframeActions ? 'pose-clip-selected-keyframe-help' : undefined} disabled={!hasSelectedKeyframeActions} onClick={() => { if (selectedKeyframe) onShiftSelectedKeyframe(selectedKeyframe.id, -frameStepSeconds) }} className={controlButtonClassName}>-1 frame</button>
            <button type="button" title="Move selected keyframe forward one frame" aria-label="Move selected keyframe forward one frame" aria-describedby={!hasSelectedKeyframeActions ? 'pose-clip-selected-keyframe-help' : undefined} disabled={!hasSelectedKeyframeActions} onClick={() => { if (selectedKeyframe) onShiftSelectedKeyframe(selectedKeyframe.id, frameStepSeconds) }} className={controlButtonClassName}>+1 frame</button>
            <button type="button" title="Duplicate selected keyframe" aria-label="Duplicate selected keyframe" aria-describedby={!hasSelectedKeyframeActions ? 'pose-clip-selected-keyframe-help' : undefined} disabled={!hasSelectedKeyframeActions} onClick={() => { if (selectedKeyframe) onDuplicateSelectedKeyframe(selectedKeyframe.id) }} className={controlButtonClassName}>Duplicate</button>
            <button type="button" title="Move selected keyframe to current time" aria-label="Move selected keyframe to current time" aria-describedby={!hasSelectedKeyframeActions ? 'pose-clip-selected-keyframe-help' : undefined} disabled={!hasSelectedKeyframeActions} onClick={() => { if (selectedKeyframe) onMoveSelectedKeyframe(selectedKeyframe.id, clampTime(currentTimeSeconds, durationSeconds)) }} className={controlButtonClassName}>Move to time</button>
          </div>
        </section>
      </CompactSection>
            </div>
          </div>
      </div>
      </div>
    </aside>
  )
}

const controlButtonClassName = 'rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm font-medium text-zinc-100 transition hover:border-cyan-400/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:opacity-60'
const smallButtonClassName = 'rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-200 transition hover:border-cyan-400/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300'
const numberInputClassName = 'w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:opacity-60'

function CompactSection({ title, ariaLabel, children }: { title: string; ariaLabel: string; children: JSX.Element }): JSX.Element {
  return (
    <details open aria-label={ariaLabel} className="group rounded-xl border border-zinc-800 bg-zinc-900/30 p-2">
      <summary className="cursor-pointer list-none rounded-lg px-2 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">
        <h3 className="inline text-xs font-semibold uppercase tracking-[0.14em] text-zinc-300">{title}</h3>
      </summary>
      <div className="mt-2 max-h-72 overflow-y-auto pr-1">
        {children}
      </div>
    </details>
  )
}

function NoRigState(): JSX.Element {
  return (
    <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100">
      <p className="font-medium text-amber-50">No rig target available</p>
      <p>Load a rigged character GLB to capture pose keyframes. The panel stays ready so you can still load an existing sidecar later.</p>
    </div>
  )
}

function UnavailableTargetState(): JSX.Element {
  return (
    <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100">
      <p className="font-medium text-amber-50">Selected target unavailable</p>
      <p>The saved sidecar points to a bone that is not in this rig. Choose another target or load a compatible sidecar.</p>
    </div>
  )
}

function WarningList({ warnings }: { warnings: readonly PoseClipPanelWarning[] }): JSX.Element {
  return (
    <div role="status" className="space-y-1 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100">
      <p className="font-medium text-amber-50">Sidecar note — editing can continue</p>
      {warnings.map((warning) => <p key={`${warning.kind}:${warning.message}`}>{warning.message}</p>)}
    </div>
  )
}

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

function normalizeFps(fps: number): number {
  return Number.isFinite(fps) ? Math.max(fps, MIN_POSE_CLIP_FPS) : MIN_POSE_CLIP_FPS
}

function clampTime(timeSeconds: number, durationSeconds: number): number {
  if (!Number.isFinite(timeSeconds)) return 0
  return Math.min(Math.max(timeSeconds, 0), normalizeDuration(durationSeconds))
}

function formatDegrees(degrees: number): string {
  return `${Number.isFinite(degrees) ? degrees : 0}°`
}

function formatPreviewState(previewState: PoseClipPreviewState): string {
  if (previewState === 'playing') return 'Playing'
  if (previewState === 'paused') return 'Paused'
  return 'Ready'
}

function formatNameProvenance(provenance: 'manual' | 'unirig' | 'raw'): string {
  return provenance === 'unirig' ? 'UniRig' : provenance
}

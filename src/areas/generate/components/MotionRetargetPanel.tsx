import { DEFAULT_MOTION_RETARGET_CORRECTIONS, normalizeMotionRetargetCorrections, type MotionRetargetCorrectionsV1, type MotionRetargetMappingEntry, type MotionRetargetPreviewKind, type MotionRetargetSession } from '../motionRetargetPlan.ts'
import type { RigSkeletonSummary } from '../rigSkeleton.ts'

export interface MotionRetargetPanelProps {
  summary?: RigSkeletonSummary
  session?: MotionRetargetSession
  selectedSourceBoneId?: string
  selectedMapping?: MotionRetargetMappingEntry
  warnings?: readonly string[]
  saveDisabledReason?: string
  exportDisabledReason?: string
  saveState?: 'idle' | 'saving' | 'saved' | 'error'
  loadState?: 'idle' | 'loading' | 'loaded' | 'error'
  exportState?: 'idle' | 'exporting' | 'exported' | 'error'
  previewState?: 'idle' | 'playing' | 'paused'
  saveMessage?: string
  loadMessage?: string
  exportMessage?: string
  previewDisabledReason?: string
  previewCurrentTimeSeconds?: number
  previewDurationSeconds?: number
  corrections?: MotionRetargetCorrectionsV1
  correctionMessage?: string
  correctionDirty?: boolean
  animationPlaybackAvailable?: boolean
  animationPlaybackActive?: boolean
  artifactLinks?: readonly MotionRetargetArtifactLink[]
  onSelectSourceBone: (sourceBoneId: string) => void
  onChangeMapping: (sourceBoneId: string, targetBoneId?: string) => void
  onSelectPreview: (selectedPreview: MotionRetargetPreviewKind) => void
  onSaveSidecar: () => void
  onLoadSidecar: () => void
  onExportPoseClipCompanion: () => void
  onOpenArtifact?: (artifact: MotionRetargetArtifactLink) => void
  onDownloadArtifact?: (artifact: MotionRetargetArtifactLink) => void
  onPlayPreview: () => void
  onPausePreview: () => void
  onResetPreview: () => void
  onScrubPreview: (timeSeconds: number) => void
  onChangeCorrections?: (corrections: MotionRetargetCorrectionsV1) => void
  onToggleAnimationPlayback?: () => void
}

export interface MotionRetargetArtifactLink {
  key: string
  label: string
  workspacePath: string
  downloadName?: string
}

export interface MotionRetargetPanelMappingRow {
  sourceBoneId: string
  sourceLabel: string
  sourceMetaText?: string
  selectedTargetBoneId?: string
  warnings: readonly string[]
  options: Array<{
    targetBoneId?: string
    label: string
  }>
}

export type MotionRetargetPanelReadinessTone = 'ready' | 'warning' | 'blocked'

export interface MotionRetargetPanelReadinessState {
  label: string
  tone: MotionRetargetPanelReadinessTone
  description: string
}

export interface MotionRetargetPanelReadinessPresentation {
  states: MotionRetargetPanelReadinessState[]
  summary: string
  diagnostics: string[]
}

export function MotionRetargetPanel({
  summary,
  session,
  selectedSourceBoneId,
  selectedMapping,
  warnings = [],
  saveDisabledReason,
  exportDisabledReason,
  saveState = 'idle',
  loadState = 'idle',
  exportState = 'idle',
  previewState = 'idle',
  saveMessage,
  loadMessage,
  exportMessage,
  previewDisabledReason,
  previewCurrentTimeSeconds = 0,
  previewDurationSeconds = 0,
  corrections = DEFAULT_MOTION_RETARGET_CORRECTIONS,
  correctionMessage,
  correctionDirty = false,
  animationPlaybackAvailable = false,
  animationPlaybackActive = false,
  artifactLinks = [],
  onSelectSourceBone,
  onChangeMapping,
  onSelectPreview,
  onSaveSidecar,
  onLoadSidecar,
  onExportPoseClipCompanion,
  onOpenArtifact,
  onDownloadArtifact,
  onPlayPreview,
  onPausePreview,
  onResetPreview,
  onScrubPreview,
  onChangeCorrections = () => undefined,
  onToggleAnimationPlayback,
}: MotionRetargetPanelProps): JSX.Element {
  if (!summary?.hasRig) {
    return (
      <aside aria-label="Motion Retarget empty state" className="rounded-2xl border border-zinc-800 bg-zinc-950/90 p-4 text-sm text-zinc-300">
        <h2 className="text-lg font-semibold text-white">No rig for Motion Retarget</h2>
        <p>Load a rigged character to inspect a Kimodo retarget session.</p>
      </aside>
    )
  }

  const boneCountLabel = summary.stats.boneCount === 1 ? '1 bone' : `${summary.stats.boneCount} bones`
  const mappingRows = resolveMotionRetargetPanelMappingRows(session, summary)
  const hasScrollableContent = Boolean(session || warnings.length > 0)
  const canUseAnimatedPlayback = Boolean(previewDisabledReason && animationPlaybackAvailable && session?.selectedPreview === 'animated-glb')
  const activeResetTargetsAnimatedGlb = Boolean(animationPlaybackAvailable && session?.selectedPreview === 'animated-glb')
  const previewPlaybackDisabled = Boolean(previewDisabledReason) && !canUseAnimatedPlayback
  const previewResetDisabled = Boolean(previewDisabledReason) && !activeResetTargetsAnimatedGlb
  const previewPlaybackLabel = canUseAnimatedPlayback
    ? (animationPlaybackActive ? 'Pause animated GLB' : 'Play animated GLB')
    : (previewState === 'playing' ? 'Pause motion retarget preview' : 'Play motion retarget preview')
  const previewPlaybackText = canUseAnimatedPlayback
    ? (animationPlaybackActive ? 'Pause animated GLB' : 'Play animated GLB')
    : (previewState === 'playing' ? 'Pause preview' : 'Play preview')
  const previewResetLabel = activeResetTargetsAnimatedGlb ? 'Reset animated GLB playback' : 'Reset motion retarget preview'
  const previewResetText = activeResetTargetsAnimatedGlb ? 'Reset animated GLB' : 'Reset preview'
  const readiness = resolveMotionRetargetPanelReadiness({
    session,
    warnings,
    previewDisabledReason,
    animationPlaybackAvailable,
  })
  const panelWarnings = readiness.diagnostics
  const handlePreviewPlayback = canUseAnimatedPlayback
    ? (onToggleAnimationPlayback ?? (() => undefined))
    : (previewState === 'playing' ? onPausePreview : onPlayPreview)

  return (
    <aside aria-label="Motion Retarget panel" className="flex h-full min-h-0 max-h-full flex-col gap-4 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/90 p-4 text-sm text-zinc-200 shadow-2xl shadow-black/40">
      <header>
        <p className="text-xs uppercase tracking-[0.2em] text-fuchsia-300">Motion Retarget</p>
        <h2 className="text-lg font-semibold text-white">Motion Retarget</h2>
        <p className="text-xs text-zinc-400">{boneCountLabel} · renderer-owned session state</p>
      </header>

      <div
        aria-label="Scrollable Motion Retarget content"
        tabIndex={hasScrollableContent ? 0 : -1}
        className="min-h-0 flex-1 overflow-y-auto pr-1"
      >
        <div className="space-y-4 pb-6">
          <section aria-label="Motion Retarget readiness" className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
            <div>
              <p className="text-sm font-medium text-white">Motion status</p>
              <p className="mt-1 text-xs text-zinc-300">{readiness.summary}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {readiness.states.map((state) => (
                <span key={state.label} title={state.description} className={resolveMotionRetargetReadinessChipClassName(state.tone)}>
                  {state.label}
                </span>
              ))}
            </div>
            {panelWarnings.length > 0 ? (
              <details className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-2 text-xs text-zinc-300">
                <summary className="cursor-pointer text-zinc-200">Developer diagnostics</summary>
                <div className="mt-2 space-y-1 text-amber-100">
                  {panelWarnings.map((warning) => <p key={warning}>{warning}</p>)}
                </div>
              </details>
            ) : null}
          </section>

          {!session ? (
            <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 text-sm text-zinc-300">
              <p className="font-medium text-zinc-100">No Kimodo motion session loaded yet</p>
              <p className="mt-1 text-xs text-zinc-400">Run a Kimodo animate mesh workflow or select its result to inspect retarget readiness.</p>
            </section>
          ) : (
            <>
          <section aria-label="Preview asset" className="space-y-2 rounded-xl border border-fuchsia-400/20 bg-fuchsia-950/10 p-3">
            <p className="text-sm font-medium text-white">Preview asset</p>
            <div className="flex flex-wrap gap-2">
              <PreviewButton
                active={session.selectedPreview === 'animated-glb'}
                disabled={!session.artifact.animatedGlbWorkspacePath}
                title="Animated GLB"
                onClick={() => onSelectPreview('animated-glb')}
              />
              <PreviewButton
                active={session.selectedPreview === 'preview-glb'}
                disabled={!session.artifact.previewGlbWorkspacePath}
                title="Preview GLB"
                onClick={() => onSelectPreview('preview-glb')}
              />
            </div>
          </section>

          <section className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
            <div>
              <p className="text-sm font-medium text-white">Local rotation-only preview</p>
              <p className="mt-1 text-xs text-zinc-400">Scrub local quaternion preview without mutating the source GLB or bind pose.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                aria-label={previewPlaybackLabel}
                title={previewPlaybackLabel}
                disabled={previewPlaybackDisabled}
                onClick={handlePreviewPlayback}
                className={chipClassName}
              >
                {previewPlaybackText}
              </button>
              <button
                type="button"
                aria-label={previewResetLabel}
                title={previewResetLabel}
                disabled={previewResetDisabled}
                onClick={onResetPreview}
                className={chipClassName}
              >
                {previewResetText}
              </button>
            </div>
            <label className="block space-y-1 text-xs text-zinc-300">
              <span>Preview time</span>
              <input
                type="range"
                min={0}
                max={Math.max(previewDurationSeconds, 0)}
                step={previewDurationSeconds > 0 ? Math.min(1 / 60, previewDurationSeconds) : 0.001}
                value={Math.min(previewCurrentTimeSeconds, Math.max(previewDurationSeconds, 0))}
                disabled={Boolean(previewDisabledReason)}
                aria-label="Motion retarget preview time"
                onChange={(event) => onScrubPreview(Number(event.target.value))}
                className="w-full accent-fuchsia-400"
              />
            </label>
            {previewDisabledReason ? <p className="text-xs text-amber-200">{previewDisabledReason}</p> : null}
          </section>

          <section aria-label="Adaptive correction" className="space-y-3 rounded-xl border border-cyan-400/20 bg-cyan-950/10 p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-white">Adaptive correction</p>
                <p className="mt-1 text-xs text-zinc-400">Preview correction adjusts runtime root motion and the saved sidecar only. It does not mutate the GLB, skeleton, bind pose, weights, materials, or stored transforms.</p>
              </div>
              {correctionDirty ? <span className="rounded-full border border-amber-400/40 bg-amber-500/10 px-2 py-1 text-[0.65rem] uppercase tracking-[0.16em] text-amber-100">Unsaved</span> : null}
            </div>
            <div className="grid gap-2">
              <label className="block space-y-1 text-xs text-zinc-300">
                <span>Root translation</span>
                <select
                  aria-label="Root translation correction policy"
                  value={corrections.rootTranslationPolicy}
                  onChange={(event) => onChangeCorrections(normalizeMotionRetargetCorrections({ ...corrections, rootTranslationPolicy: event.target.value as MotionRetargetCorrectionsV1['rootTranslationPolicy'] }))}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
                >
                  <option value="solver">Solver root</option>
                  <option value="in_place">Zero root / in place</option>
                  <option value="preserve_scaled_npz">Preserve scaled NPZ root</option>
                </select>
              </label>
              <label className="block space-y-1 text-xs text-zinc-300">
                <span>Root motion scale</span>
                <input
                  type="number"
                  min={0}
                  max={3}
                  step={0.05}
                  value={corrections.rootMotionScale}
                  aria-label="Root motion scale"
                  onChange={(event) => handleMotionRetargetCorrectionNumberChange({ field: 'rootMotionScale', value: event.target.value, corrections, onChangeCorrections })}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
                />
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(['x', 'y', 'z'] as const).map((axis) => (
                  <label key={axis} className="block space-y-1 text-xs text-zinc-300">
                    <span>Root offset {axis.toUpperCase()}</span>
                    <input
                      type="number"
                      step={0.05}
                      value={corrections.rootOffset[axis]}
                      aria-label={`Root offset ${axis.toUpperCase()}`}
                      onChange={(event) => handleMotionRetargetCorrectionVectorChange({ axis, value: event.target.value, corrections, onChangeCorrections })}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-zinc-100"
                    />
                  </label>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" aria-label="Preview correction before" aria-pressed={corrections.previewMode === 'before'} onClick={() => onChangeCorrections(normalizeMotionRetargetCorrections({ ...corrections, previewMode: 'before' }))} className={corrections.previewMode === 'before' ? activeChipClassName : chipClassName}>Before</button>
              <button type="button" aria-label="Preview correction after" aria-pressed={corrections.previewMode !== 'before'} onClick={() => onChangeCorrections(normalizeMotionRetargetCorrections({ ...corrections, previewMode: 'after' }))} className={corrections.previewMode !== 'before' ? activeChipClassName : chipClassName}>After</button>
              <button type="button" aria-label="Reset adaptive correction" onClick={() => handleMotionRetargetCorrectionReset({ onChangeCorrections })} className={chipClassName}>Reset correction</button>
              <button type="button" aria-label="Save correction" title="Save correction" disabled={Boolean(saveDisabledReason) || saveState === 'saving'} onClick={onSaveSidecar} className={chipClassName}>Save correction</button>
            </div>
            <p className="text-xs text-zinc-400">Adaptive correction changes the preview and sidecar only; coherent/export-ready still depends on solver validation.</p>
            {correctionMessage ? <p className={correctionDirty ? 'text-xs text-amber-200' : 'text-xs text-zinc-300'}>{correctionMessage}</p> : null}
          </section>

          <section className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
            <div>
              <p className="text-sm font-medium text-white">Session sidecar</p>
              <p className="mt-1 text-xs text-zinc-400">Save or reload the renderer-owned Motion Retarget session via Electron sidecars.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                aria-label="Save motion retarget sidecar"
                title="Save motion retarget sidecar"
                disabled={Boolean(saveDisabledReason) || saveState === 'saving'}
                onClick={onSaveSidecar}
                className={chipClassName}
              >
                Save motion retarget sidecar
              </button>
              <button
                type="button"
                aria-label="Load motion retarget sidecar"
                title="Load motion retarget sidecar"
                disabled={loadState === 'loading'}
                onClick={onLoadSidecar}
                className={chipClassName}
              >
                Load motion retarget sidecar
              </button>
            </div>
            {saveDisabledReason ? <p className="text-xs text-amber-200">{saveDisabledReason}</p> : null}
            {saveMessage ? <p className="text-xs text-zinc-300">{saveMessage}</p> : null}
            {loadMessage ? <p className="text-xs text-zinc-300">{loadMessage}</p> : null}
          </section>

          <section className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
            <div>
              <p className="text-sm font-medium text-white">Pose/Clip companion</p>
              <p className="mt-1 text-xs text-zinc-400">Write an additive Pose/Clip v1 companion sidecar without overwriting authored Pose/Clip files.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                aria-label="Export Pose/Clip companion"
                title="Export Pose/Clip companion"
                disabled={Boolean(exportDisabledReason) || exportState === 'exporting'}
                onClick={onExportPoseClipCompanion}
                className={chipClassName}
              >
                Export Pose/Clip companion
              </button>
            </div>
            {exportDisabledReason ? <p className="text-xs text-amber-200">{exportDisabledReason}</p> : null}
            {exportMessage ? <p className="text-xs text-zinc-300">{exportMessage}</p> : null}
          </section>

          {artifactLinks.length > 0 ? (
            <section className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
              <div>
                <p className="text-sm font-medium text-white">Kimodo artifacts</p>
                <p className="mt-1 text-xs text-zinc-400">Open or download trusted Kimodo bundle artifacts through renderer-owned Electron actions.</p>
              </div>
              <div className="space-y-2">
                {artifactLinks.map((artifactLink) => (
                  <div key={artifactLink.key} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
                    <p className="text-xs text-zinc-200">{artifactLink.label}</p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        aria-label={`Open ${artifactLink.label}`}
                        title={`Open ${artifactLink.label}`}
                        onClick={() => onOpenArtifact?.(artifactLink)}
                        className={chipClassName}
                      >
                        Open {artifactLink.label}
                      </button>
                      <button
                        type="button"
                        aria-label={`Download ${artifactLink.label}`}
                        title={`Download ${artifactLink.label}`}
                        onClick={() => onDownloadArtifact?.(artifactLink)}
                        className={chipClassName}
                      >
                        Download {artifactLink.label}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
            <p className="text-sm font-medium text-white">Source bones</p>
            <div className="flex flex-wrap gap-2">
              {session.sourceBones.map((sourceBone) => (
                <button
                  key={sourceBone.sourceBoneId}
                  type="button"
                  title={`Select source bone ${sourceBone.label}`}
                  aria-pressed={selectedSourceBoneId === sourceBone.sourceBoneId}
                  onClick={() => onSelectSourceBone(sourceBone.sourceBoneId)}
                  className={selectedSourceBoneId === sourceBone.sourceBoneId ? activeChipClassName : chipClassName}
                >
                  {sourceBone.label}
                </button>
              ))}
            </div>
          </section>

          {mappingRows.length > 0 ? (
            <section className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
              <div>
                <p className="text-sm font-medium text-white">Manual mapping</p>
                <p className="mt-1 text-xs text-zinc-400">Map each Kimodo source bone to zero or one target rig bone.</p>
                <p className="mt-1 text-xs text-amber-200">Manual mapping edits affect only this local preview, session sidecar, and future companion exports. They do not rewrite the already generated animated GLB.</p>
              </div>

              <div className="space-y-3">
                {mappingRows.map((row) => (
                  <label key={row.sourceBoneId} className="block space-y-1">
                    <div className="flex items-center justify-between gap-3">
                      <button
                        type="button"
                        title={`Select source bone ${row.sourceLabel}`}
                        aria-pressed={selectedSourceBoneId === row.sourceBoneId}
                        onClick={() => onSelectSourceBone(row.sourceBoneId)}
                        className={selectedSourceBoneId === row.sourceBoneId ? activeChipClassName : chipClassName}
                      >
                        {row.sourceLabel}
                      </button>
                      {row.sourceMetaText ? <span className="text-xs text-zinc-400">{row.sourceMetaText}</span> : null}
                    </div>
                    <span className="sr-only">Target rig bone for {row.sourceLabel}</span>
                    <select
                      aria-label={`Target rig bone for ${row.sourceLabel}`}
                      value={row.selectedTargetBoneId ?? ''}
                      onChange={(event) => handleMotionRetargetMappingChange({
                        sourceBoneId: row.sourceBoneId,
                        value: event.target.value,
                        onSelectSourceBone,
                        onChangeMapping,
                      })}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
                    >
                      {row.options.map((option) => (
                        <option key={option.targetBoneId ?? '__unmapped__'} value={option.targetBoneId ?? ''}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    {row.warnings.length > 0 ? (
                      <div role="status" className="space-y-1 text-xs text-amber-200">
                        {row.warnings.map((warning) => <p key={warning}>{warning}</p>)}
                      </div>
                    ) : null}
                  </label>
                ))}
              </div>
            </section>
          ) : session.sourceBones.length === 0 ? (
            <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 text-xs text-zinc-400">
              Diagnostics-only inspection is available until Kimodo exports source bone metadata.
            </section>
          ) : null}

          {selectedMapping ? (
            <section className="space-y-1 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
              <p className="text-sm font-medium text-white">Selected mapping</p>
              <p className="text-sm text-zinc-100">{selectedMapping.targetLabel ?? 'Unmapped target'}</p>
              <p className="text-xs text-zinc-400">Name source: {selectedMapping.targetLabelProvenance ?? 'raw'}</p>
            </section>
          ) : null}
            </>
          )}
        </div>
      </div>
    </aside>
  )
}

export function resolveMotionRetargetPanelMappingRows(
  session?: MotionRetargetSession,
  summary?: RigSkeletonSummary,
): MotionRetargetPanelMappingRow[] {
  if (!session || session.sourceBones.length === 0) return []

  const targetBones = session.targetBones?.length
    ? session.targetBones.map((targetBone) => ({ boneId: targetBone.boneId, label: targetBone.label }))
    : (summary?.bones ?? []).map((bone) => ({ boneId: bone.boneId, label: bone.label }))
  const sourceWarnings = session.diagnostics?.sourceWarnings ?? {}

  const options = [
    { targetBoneId: undefined, label: 'Unmapped target' },
    ...targetBones.map((targetBone) => ({
      targetBoneId: targetBone.boneId,
      label: targetBone.label,
    })),
  ]

  return session.sourceBones.map((sourceBone) => ({
    sourceBoneId: sourceBone.sourceBoneId,
    sourceLabel: sourceBone.label,
    sourceMetaText: formatMotionRetargetSourceMeta(sourceBone.role, sourceBone.chain),
    selectedTargetBoneId: session.mappings[sourceBone.sourceBoneId]?.targetBoneId,
    warnings: sourceWarnings[sourceBone.sourceBoneId] ?? [],
    options,
  }))
}

export function compactMotionRetargetPanelWarnings(warnings: readonly string[]): string[] {
  let acceptedRoleDriftCount = 0
  let missingOptionalTrackCount = 0
  const compacted: string[] = []

  for (const warning of warnings) {
    if (isAcceptedRoleDriftWarning(warning)) {
      acceptedRoleDriftCount += 1
      continue
    }
    if (isMissingOptionalTrackWarning(warning)) {
      missingOptionalTrackCount += 1
      continue
    }
    if (!compacted.includes(warning)) compacted.push(warning)
  }

  return [
    acceptedRoleDriftCount > 0
      ? `Accepted ${acceptedRoleDriftCount} Kimodo target tracks with local role metadata drift; stable bone identity was used for local preview/session export.`
      : undefined,
    missingOptionalTrackCount > 0
      ? `${missingOptionalTrackCount} optional Kimodo target tracks are not present in the local rig and were skipped for the partial local preview/export.`
      : undefined,
    ...compacted,
  ].filter((warning): warning is string => Boolean(warning))
}

export function resolveMotionRetargetPanelReadiness({
  session,
  warnings,
  previewDisabledReason,
  animationPlaybackAvailable = false,
}: {
  session?: MotionRetargetSession
  warnings?: readonly string[]
  previewDisabledReason?: string
  animationPlaybackAvailable?: boolean
}): MotionRetargetPanelReadinessPresentation {
  const diagnostics = compactMotionRetargetPanelWarnings(warnings ?? [])
  const playbackAvailable = Boolean(animationPlaybackAvailable || session?.unlockReadiness.playbackAvailable || session?.artifact.animatedGlbWorkspacePath || session?.artifact.previewGlbWorkspacePath)
  const adaptiveCorrectionAvailable = Boolean(session?.exportReadiness.canSaveSidecar)
  const companionExportAvailable = Boolean(session?.exportReadiness.canExportPoseClip)
  const needsSolverAttention = hasMotionRetargetSolverAttention(diagnostics, session)
  const coherentExportReady = Boolean(session?.exportReadiness.coherentExportReady ?? (session && !needsSolverAttention))
  const states: MotionRetargetPanelReadinessState[] = [
    playbackAvailable
      ? { label: 'Playable', tone: 'ready', description: 'Animated or preview GLB playback is available.' }
      : { label: 'Playable', tone: 'blocked', description: 'Playback is unavailable until Kimodo provides a previewable GLB.' },
    adaptiveCorrectionAvailable
      ? { label: 'Adaptive correction', tone: 'ready', description: 'Adaptive correction sidecar controls are available, but they do not prove solver coherence.' }
      : { label: 'Adaptive correction', tone: 'blocked', description: 'Adaptive correction controls need source bone metadata before they can be used.' },
    companionExportAvailable
      ? { label: 'Companion export', tone: 'ready', description: 'Pose/Clip companion sidecar export is available as corrective metadata.' }
      : { label: 'Companion export', tone: 'blocked', description: 'Pose/Clip companion sidecar export needs a trusted local mapping payload first.' },
    coherentExportReady
      ? { label: 'Coherent/export-ready', tone: 'ready', description: 'Basis, root, and visual evidence currently support coherent solver/export readiness.' }
      : { label: 'Coherent/export-ready', tone: 'blocked', description: 'Coherent solver/export readiness is blocked until basis, root, and visual evidence are valid.' },
  ]

  if (needsSolverAttention) {
    states.push({ label: 'Solver needs attention', tone: 'warning', description: 'Kimodo solver needs attention; visual quality is not yet validated.' })
  }

  return {
    states,
    summary: resolveMotionRetargetReadinessSummary({ playbackAvailable, adaptiveCorrectionAvailable, companionExportAvailable, coherentExportReady, needsSolverAttention, previewDisabledReason }),
    diagnostics,
  }
}

function resolveMotionRetargetReadinessSummary({
  playbackAvailable,
  adaptiveCorrectionAvailable,
  companionExportAvailable,
  coherentExportReady,
  needsSolverAttention,
  previewDisabledReason,
}: {
  playbackAvailable: boolean
  adaptiveCorrectionAvailable: boolean
  companionExportAvailable: boolean
  coherentExportReady: boolean
  needsSolverAttention: boolean
  previewDisabledReason?: string
}): string {
  if (!coherentExportReady && adaptiveCorrectionAvailable) return 'Adaptive correction is available, but coherent/export-ready remains blocked by solver evidence.'
  if (needsSolverAttention) return 'Kimodo solver needs attention; visual quality is not yet validated.'
  if (playbackAvailable && adaptiveCorrectionAvailable && companionExportAvailable && coherentExportReady) return 'Ready for playback, adaptive correction sidecar edits, companion export, and coherent solver/export handoff.'
  if (playbackAvailable && previewDisabledReason) return 'Playable animated GLB is available; local retarget editing needs additional trusted metadata.'
  if (playbackAvailable) return 'Playable preview is available; manual tools remain secondary until readiness metadata is complete.'
  return 'Kimodo retarget readiness is waiting for a previewable GLB and trusted metadata.'
}

function hasMotionRetargetSolverAttention(diagnostics: readonly string[], session?: MotionRetargetSession): boolean {
  const diagnosticText = diagnostics.join('\n').toLowerCase()
  const visualQualityStatus = String(session?.artifact.diagnostics.visualQualityStatus ?? '').toLowerCase()
  return /invalid_basis|basis\/invalid|basis\/not_correction_eligible|visual_quality|not validated|not_validated|root-motion correctness is deferred/i.test(diagnosticText)
    || visualQualityStatus === 'warning'
    || visualQualityStatus === 'not_validated'
    || visualQualityStatus === 'preview-only'
}

function resolveMotionRetargetReadinessChipClassName(tone: MotionRetargetPanelReadinessTone): string {
  if (tone === 'ready') return 'rounded-full border border-emerald-400/40 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-100'
  if (tone === 'warning') return 'rounded-full border border-amber-400/40 bg-amber-500/10 px-3 py-1 text-xs text-amber-100'
  return 'rounded-full border border-zinc-600 bg-zinc-950 px-3 py-1 text-xs text-zinc-300'
}

function isAcceptedRoleDriftWarning(warning: string): boolean {
  return /^Kimodo target track ".+" accepted exact local identity(?: for role ".+")?; local role metadata (?:is missing|".+" differs from Kimodo role ".+")\.$/.test(warning)
}

function isMissingOptionalTrackWarning(warning: string): boolean {
  return /^Kimodo target track ".+" is missing local target for node index \d+\.$/.test(warning)
}

function formatMotionRetargetSourceMeta(role?: string, chain?: string): string | undefined {
  const segments = [
    role ? `Role: ${formatMotionRetargetToken(role)}` : undefined,
    chain ? `Chain: ${formatMotionRetargetToken(chain)}` : undefined,
  ].filter((segment): segment is string => Boolean(segment))
  return segments.length > 0 ? segments.join(' · ') : undefined
}

function formatMotionRetargetToken(value: string): string {
  return value.trim().replace(/[_-]+/g, ' ')
}

export function handleMotionRetargetMappingChange({
  sourceBoneId,
  value,
  onSelectSourceBone,
  onChangeMapping,
}: {
  sourceBoneId: string
  value: string
  onSelectSourceBone: (sourceBoneId: string) => void
  onChangeMapping: (sourceBoneId: string, targetBoneId?: string) => void
}): void {
  onSelectSourceBone(sourceBoneId)
  onChangeMapping(sourceBoneId, value || undefined)
}

export function handleMotionRetargetCorrectionNumberChange({
  field,
  value,
  corrections,
  onChangeCorrections,
}: {
  field: 'rootMotionScale'
  value: string
  corrections: MotionRetargetCorrectionsV1
  onChangeCorrections: (corrections: MotionRetargetCorrectionsV1) => void
}): void {
  onChangeCorrections(normalizeMotionRetargetCorrections({ ...corrections, [field]: Number(value) }))
}

export function handleMotionRetargetCorrectionVectorChange({
  axis,
  value,
  corrections,
  onChangeCorrections,
}: {
  axis: 'x' | 'y' | 'z'
  value: string
  corrections: MotionRetargetCorrectionsV1
  onChangeCorrections: (corrections: MotionRetargetCorrectionsV1) => void
}): void {
  onChangeCorrections(normalizeMotionRetargetCorrections({
    ...corrections,
    rootOffset: { ...corrections.rootOffset, [axis]: Number(value) },
  }))
}

export function handleMotionRetargetCorrectionReset({
  onChangeCorrections,
}: {
  onChangeCorrections: (corrections: MotionRetargetCorrectionsV1) => void
}): void {
  onChangeCorrections(structuredClone(DEFAULT_MOTION_RETARGET_CORRECTIONS))
}

function PreviewButton({
  active,
  disabled,
  title,
  onClick,
}: {
  active: boolean
  disabled: boolean
  title: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={active ? activeChipClassName : chipClassName}
    >
      {title}
    </button>
  )
}

const chipClassName = 'rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 transition hover:border-fuchsia-400/60 hover:text-white disabled:cursor-not-allowed disabled:opacity-50'
const activeChipClassName = 'rounded-lg border border-fuchsia-400/60 bg-fuchsia-500/15 px-3 py-1.5 text-xs text-fuchsia-50 transition disabled:cursor-not-allowed disabled:opacity-50'

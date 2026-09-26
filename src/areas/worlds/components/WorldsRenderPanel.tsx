import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import type { WorldRenderFps, WorldRenderPreset } from '../../../shared/types/worldRenders.ts'
import { Tooltip } from '../../../shared/components/ui/Tooltip.tsx'
import {
  canCancelWorldRenderJob,
  createWorldRenderUiController,
  describeWorldRenderJob,
  worldRenderProgressPercent,
  type WorldRenderUiController,
} from '../editor/worldRenderUiController.ts'

const RENDER_PRESETS = Object.freeze({
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '2160p': { width: 3840, height: 2160 },
} as const)

type RenderPresetName = keyof typeof RENDER_PRESETS

export interface WorldsRenderPanelProps {
  projectKey: string
  revision: number
  sceneId: string
  sequenceId: string
  fps: WorldRenderFps
  disabled?: boolean
  onBeforeStart(): void
  onRefreshProject(): void
  controller?: WorldRenderUiController
}

export function WorldsRenderPanel({
  projectKey,
  revision,
  sceneId,
  sequenceId,
  fps,
  disabled = false,
  onBeforeStart,
  onRefreshProject,
  controller: providedController,
}: WorldsRenderPanelProps): JSX.Element {
  const beforeStartRef = useRef(onBeforeStart)
  beforeStartRef.current = onBeforeStart
  const ownedController = useMemo(() => createWorldRenderUiController({
    beforeStart: () => beforeStartRef.current(),
  }), [])
  const controller = providedController ?? ownedController
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const [presetName, setPresetName] = useState<RenderPresetName>('1080p')
  const dimensions = RENDER_PRESETS[presetName]
  const preset = useMemo<WorldRenderPreset>(() => ({ ...dimensions, fps }), [dimensions, fps])

  useEffect(() => {
    void controller.open({ projectKey, revision, sceneId, sequenceId, preset })
  }, [controller, fps, preset.height, preset.width, projectKey, revision, sceneId, sequenceId])

  useEffect(() => () => {
    if (!providedController) ownedController.dispose()
  }, [ownedController, providedController])

  const job = state.job
  const description = job ? describeWorldRenderJob(job) : null
  const active = Boolean(job && !['cancelled', 'interrupted', 'failed', 'partial', 'succeeded', 'recovery_failed'].includes(job.status))
  const progress = job ? worldRenderProgressPercent(job.progress) : 0
  const busy = state.loading || state.action !== 'idle'
  const renderDisabled = disabled || busy || active || !sequenceId

  return <section className="worlds-render-panel" aria-label="Render">
    <label className="worlds-render-panel__preset">
      <span>Preset</span>
      <select aria-label="Render preset" value={presetName} disabled={disabled || busy || active} onChange={(event) => setPresetName(event.currentTarget.value as RenderPresetName)}>
        {Object.keys(RENDER_PRESETS).map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
    </label>
    <Tooltip content="Render sequence">
      <button type="button" className="worlds-compact-button worlds-button--primary" aria-label="Render sequence" disabled={renderDisabled} onClick={() => { void controller.start() }}>
        {state.action === 'creating' ? 'Starting' : 'Render'}
      </button>
    </Tooltip>
    <div className={`worlds-render-panel__state${description ? ` is-${description.tone}` : ''}`} aria-live="polite" aria-atomic="true">
      {state.loading ? <span>Loading</span> : description ? <>
        <strong>{description.label}</strong>
        <span className="worlds-render-panel__detail">{description.detail}</span>
      </> : <span>Ready · {fps} fps</span>}
      {active && job ? <progress className="worlds-render-panel__progress" aria-label={`Render progress ${progress}%`} max={100} value={progress}>{progress}%</progress> : null}
      {state.error ? <span className="worlds-render-panel__error" role="alert">{state.error.message}</span> : null}
    </div>
    {job && canCancelWorldRenderJob(job) ? <Tooltip content="Cancel render">
      <button type="button" className="worlds-compact-button" aria-label="Cancel render" disabled={busy} onClick={() => { void controller.cancel() }}>Cancel</button>
    </Tooltip> : null}
    {description?.retry ? <Tooltip content="Retry render">
      <button type="button" className="worlds-icon-button" aria-label="Retry render" disabled={disabled || busy} onClick={() => { void controller.retry() }}>↻</button>
    </Tooltip> : null}
    {state.error?.code === 'revision_conflict' ? <Tooltip content="Refresh project">
      <button type="button" className="worlds-compact-button" aria-label="Refresh project" disabled={busy} onClick={onRefreshProject}>Refresh</button>
    </Tooltip> : null}
    {job && description && !active ? <Tooltip content="Remove render job">
      <button type="button" className="worlds-icon-button" aria-label="Remove render job" disabled={busy} onClick={() => { void controller.delete() }}>×</button>
    </Tooltip> : null}
  </section>
}

export default WorldsRenderPanel

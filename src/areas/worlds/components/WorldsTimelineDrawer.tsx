import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import { Tooltip } from '../../../shared/components/ui/Tooltip.tsx'
import {
  WORLD_SEQUENCE_FPS_VALUES,
  normalizeWorldRationalTime,
  worldRationalTimeToSeconds,
  type WorldSequenceFps,
} from '../cinematic/worldRationalTime.ts'
import { getWorldComponentDefinition, type WorldComponent } from '../core/worldComponentRegistry.ts'
import type { WorldCommand } from '../core/worldCommands.ts'
import type {
  WorldPropertyValue,
  WorldProjectSnapshotV1,
  WorldRationalTime,
  WorldSceneDocumentV1,
  WorldSequenceTrack,
  WorldTransform,
  WorldVector3,
} from '../core/worldModel.ts'
import { isWorldCanonicalId } from '../core/worldValidationLimits.ts'
import type { WorldTimelinePreviewState } from '../editor/worldTimelinePreview.ts'
import {
  buildAddWorldSequenceKeyframeCommand,
  buildAddWorldSequenceTrackCommand,
  buildCreateWorldSequenceCommand,
  buildEditWorldSequenceKeyframeCommand,
  buildMoveWorldSequenceKeyframeCommand,
  buildRemoveWorldSequenceCommand,
  buildRemoveWorldSequenceKeyframeCommand,
  buildRemoveWorldSequenceTrackCommand,
  buildReorderWorldSequenceTrackCommand,
  deriveWorldTimelineId,
  snapWorldTimelineTime,
  type WorldSequenceKeyframe,
} from '../editor/worldTimelineModel.ts'
import { createWorldUiTransactionId } from '../editor/useWorldEditorController.ts'
import WorldsRenderPanel from './WorldsRenderPanel.tsx'

const TRACK_TYPES = ['transform', 'camera', 'light', 'property', 'animation', 'audio', 'event'] as const
type WorldTimelineTrackType = typeof TRACK_TYPES[number]

const TRACK_LABELS: Record<WorldTimelineTrackType, string> = {
  transform: 'Transform',
  camera: 'Camera',
  light: 'Light',
  property: 'Property',
  animation: 'Animation',
  audio: 'Audio',
  event: 'Event',
}

export interface WorldTimelineTrackDraft {
  readonly type: WorldTimelineTrackType
  readonly entityId?: string
  readonly componentId?: string
  readonly property?: string
}

export interface WorldsTimelineDrawerProps {
  projectKey: string
  snapshot: WorldProjectSnapshotV1
  scene: WorldSceneDocumentV1
  previewState: WorldTimelinePreviewState
  disabled?: boolean
  initialOpen?: boolean
  onCommands(commands: WorldCommand[], scope: string): void
  onPreviewPlay(sequenceId: string, fps: WorldSequenceFps, time: WorldRationalTime): void
  onPreviewPause(): void
  onPreviewStop(): void
  onPreviewSeek(sequenceId: string, fps: WorldSequenceFps, time: WorldRationalTime): void
  onRefreshProject(): void
  onError(message: string): void
}

interface KeyframeDraftState {
  channel: keyof WorldTransform
  scalar: string
  text: string
  boolean: boolean
  vector: [string, string, string]
  interpolation: 'step' | 'linear' | 'cubic'
}

const DEFAULT_KEYFRAME_DRAFT: KeyframeDraftState = {
  channel: 'position',
  scalar: '1',
  text: 'event:marker',
  boolean: true,
  vector: ['0', '0', '0'],
  interpolation: 'linear',
}

export function WorldsTimelineDrawer({
  projectKey,
  snapshot,
  scene,
  previewState,
  disabled = false,
  initialOpen = false,
  onCommands,
  onPreviewPlay,
  onPreviewPause,
  onPreviewStop,
  onPreviewSeek,
  onRefreshProject,
  onError,
}: WorldsTimelineDrawerProps): JSX.Element {
  const [open, setOpen] = useState(initialOpen)
  const [sequenceId, setSequenceId] = useState(() => scene.sequences[0]?.id ?? '')
  const [fps, setFps] = useState<WorldSequenceFps>(30)
  const [playheadFrame, setPlayheadFrame] = useState(0)
  const [selectedTrackId, setSelectedTrackId] = useState(() => scene.sequences[0]?.tracks[0]?.id ?? '')
  const [selectedKeyframeId, setSelectedKeyframeId] = useState('')
  const [trackDraftOpen, setTrackDraftOpen] = useState(false)
  const [trackDraft, setTrackDraft] = useState<WorldTimelineTrackDraft>(() => createDefaultTrackDraft(scene, 'transform'))
  const [keyframeDraft, setKeyframeDraft] = useState<KeyframeDraftState>(DEFAULT_KEYFRAME_DRAFT)

  const sequence = scene.sequences.find((candidate) => candidate.id === sequenceId) ?? scene.sequences[0] ?? null
  const selectedTrack = sequence?.tracks.find((track) => track.id === selectedTrackId) ?? sequence?.tracks[0] ?? null
  const selectedKeyframe = selectedTrack?.keyframes.find((keyframe) => keyframe.id === selectedKeyframeId) ?? null
  const maximumFrame = sequence ? worldTimelineDurationFrameCount(sequence.duration, fps) : 0
  const previewFrame = previewState.frame?.sceneId === scene.sceneId && previewState.frame.sequenceId === sequence?.id
    ? previewState.frame
    : null
  const visiblePlayheadFrame = previewFrame ? worldTimelineFrameIndex(previewFrame.time, fps) : Math.min(playheadFrame, maximumFrame)
  const playheadTime = sequence
    ? snapWorldTimelineTime({ numerator: visiblePlayheadFrame, denominator: fps }, fps, sequence.duration)
    : { numerator: 0, denominator: 1 }
  const previewPlaying = previewState.lifecycle === 'playing' && !!previewFrame
  const context = useMemo(() => ({ snapshot, sceneId: scene.sceneId }), [scene.sceneId, snapshot])

  useEffect(() => {
    const nextSequence = scene.sequences.find((candidate) => candidate.id === sequenceId) ?? scene.sequences[0] ?? null
    if ((nextSequence?.id ?? '') !== sequenceId) setSequenceId(nextSequence?.id ?? '')
    if (!nextSequence) {
      setSelectedTrackId('')
      setSelectedKeyframeId('')
      setPlayheadFrame(0)
    }
  }, [scene.sceneId, scene.sequences, sequenceId])

  useEffect(() => {
    const nextTrack = sequence?.tracks.find((track) => track.id === selectedTrackId) ?? sequence?.tracks[0] ?? null
    if ((nextTrack?.id ?? '') !== selectedTrackId) setSelectedTrackId(nextTrack?.id ?? '')
    if (!nextTrack?.keyframes.some((keyframe) => keyframe.id === selectedKeyframeId)) setSelectedKeyframeId('')
  }, [selectedKeyframeId, selectedTrackId, sequence])

  useEffect(() => {
    if (!selectedTrack) return
    setKeyframeDraft(createKeyframeDraftState(scene, selectedTrack, selectedKeyframe))
  }, [scene, selectedKeyframe, selectedTrack])

  const issue = (caught: unknown, fallback: string) => onError(caught instanceof Error ? caught.message : fallback)
  const dispatch = (command: WorldCommand, scope: string) => onCommands([command], scope)
  const createSequence = () => {
    try {
      const seed = createWorldUiTransactionId('timeline-sequence')
      dispatch(buildCreateWorldSequenceCommand(context, {
        id: deriveWorldTimelineId('sequence', seed),
        name: `Sequence ${scene.sequences.length + 1}`,
        duration: { numerator: 5, denominator: 1 },
      }), 'timeline-create-sequence')
    } catch (caught) { issue(caught, 'Sequence could not be created.') }
  }
  const removeSequence = () => {
    if (!sequence) return
    onPreviewStop()
    try { dispatch(buildRemoveWorldSequenceCommand(context, sequence.id), 'timeline-remove-sequence') }
    catch (caught) { issue(caught, 'Sequence could not be deleted.') }
  }
  const addTrack = (draft = trackDraft) => {
    if (!sequence) return
    const seed = createWorldUiTransactionId('timeline-track')
    const track = createWorldTimelineTrackFromDraft(scene, draft, deriveWorldTimelineId('track', seed))
    if (!track) return onError('Choose a compatible Timeline target.')
    try {
      dispatch(buildAddWorldSequenceTrackCommand(context, sequence.id, track), 'timeline-add-track')
      setTrackDraftOpen(false)
    } catch (caught) { issue(caught, 'Track could not be added.') }
  }
  const removeTrack = (track: WorldSequenceTrack) => {
    if (!sequence) return
    try { dispatch(buildRemoveWorldSequenceTrackCommand(context, sequence.id, track.id), 'timeline-remove-track') }
    catch (caught) { issue(caught, 'Track could not be removed.') }
  }
  const reorderTrack = (track: WorldSequenceTrack, direction: -1 | 1) => {
    if (!sequence) return
    const index = sequence.tracks.findIndex((candidate) => candidate.id === track.id)
    const toIndex = index + direction
    if (index < 0 || toIndex < 0 || toIndex >= sequence.tracks.length) return
    try { dispatch(buildReorderWorldSequenceTrackCommand(context, sequence.id, track.id, toIndex), 'timeline-reorder-track') }
    catch (caught) { issue(caught, 'Track could not be reordered.') }
  }
  const createKeyframe = () => {
    if (!sequence || !selectedTrack) return
    const seed = createWorldUiTransactionId('timeline-keyframe')
    const keyframe = createWorldTimelineKeyframeFromDraft(
      scene,
      selectedTrack,
      deriveWorldTimelineId('keyframe', seed),
      playheadTime,
      keyframeDraft,
    )
    if (!keyframe) return onError('Enter a valid keyframe value.')
    try { dispatch(buildAddWorldSequenceKeyframeCommand(context, sequence.id, selectedTrack.id, keyframe, fps), 'timeline-add-keyframe') }
    catch (caught) { issue(caught, 'Keyframe could not be added.') }
  }
  const updateKeyframe = () => {
    if (!sequence || !selectedTrack || !selectedKeyframe) return
    const candidate = createWorldTimelineKeyframeFromDraft(
      scene,
      selectedTrack,
      selectedKeyframe.id,
      selectedKeyframe.time,
      keyframeDraft,
      selectedKeyframe,
    )
    if (!candidate) return onError('Enter a valid keyframe value.')
    try {
      const patch = selectedTrack.type === 'event'
        ? { eventId: (candidate as Extract<WorldSequenceKeyframe, { eventId: string }>).eventId, interpolation: 'step' as const }
        : { value: (candidate as Exclude<WorldSequenceKeyframe, { eventId: string }>).value, interpolation: candidate.interpolation ?? null }
      dispatch(buildEditWorldSequenceKeyframeCommand(context, sequence.id, selectedTrack.id, selectedKeyframe.id, patch, fps), 'timeline-edit-keyframe')
    } catch (caught) { issue(caught, 'Keyframe could not be updated.') }
  }
  const moveKeyframe = () => {
    if (!sequence || !selectedTrack || !selectedKeyframe) return
    try {
      dispatch(buildMoveWorldSequenceKeyframeCommand(context, sequence.id, selectedTrack.id, selectedKeyframe.id, { time: playheadTime, fps }), 'timeline-move-keyframe')
    } catch (caught) { issue(caught, 'Keyframe could not be moved.') }
  }
  const removeKeyframe = () => {
    if (!sequence || !selectedTrack || !selectedKeyframe) return
    try { dispatch(buildRemoveWorldSequenceKeyframeCommand(context, sequence.id, selectedTrack.id, selectedKeyframe.id), 'timeline-remove-keyframe') }
    catch (caught) { issue(caught, 'Keyframe could not be removed.') }
  }
  const seek = (frame: number) => {
    if (!sequence) return
    const boundedFrame = Math.max(0, Math.min(maximumFrame, frame))
    setPlayheadFrame(boundedFrame)
    onPreviewSeek(sequence.id, fps, snapWorldTimelineTime({ numerator: boundedFrame, denominator: fps }, fps, sequence.duration))
  }
  const stop = () => {
    setPlayheadFrame(0)
    onPreviewStop()
  }
  const toggleOpen = () => {
    if (open) stop()
    setOpen((value) => !value)
  }

  return (
    <section
      className={`worlds-timeline${open ? ' is-open' : ''}`}
      aria-label="World timeline"
      onKeyDown={(event) => handleTimelineKeyboard(event, {
        disabled: disabled || !sequence,
        playing: previewPlaying,
        play: () => sequence && onPreviewPlay(sequence.id, fps, playheadTime),
        pause: onPreviewPause,
        stop,
        seekFrame: (offset) => seek(visiblePlayheadFrame + offset),
      })}
    >
      <header className="worlds-timeline__bar">
        <Tooltip content={open ? 'Collapse Timeline' : 'Open Timeline'}>
          <button type="button" className="worlds-icon-button" aria-label={open ? 'Collapse Timeline' : 'Open Timeline'} aria-expanded={open} onClick={toggleOpen}>{open ? '⌄' : '⌃'}</button>
        </Tooltip>
        <strong>Timeline</strong>
        {open ? <>
          <label className="worlds-timeline__select"><span>Sequence</span><select aria-label="Sequence" disabled={disabled || scene.sequences.length === 0} value={sequence?.id ?? ''} onChange={(event) => {
            stop()
            setSequenceId(event.currentTarget.value)
            setSelectedTrackId('')
            setSelectedKeyframeId('')
          }}>
            {scene.sequences.length === 0 ? <option value="">No sequences</option> : scene.sequences.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select></label>
          <Tooltip content="Create sequence"><button type="button" className="worlds-icon-button" aria-label="Create sequence" disabled={disabled} onClick={createSequence}>＋</button></Tooltip>
          <Tooltip content="Delete sequence"><button type="button" className="worlds-icon-button" aria-label="Delete sequence" disabled={disabled || !sequence} onClick={removeSequence}>−</button></Tooltip>
          <span className="worlds-timeline__divider" />
          <Tooltip content={previewPlaying ? 'Pause preview' : 'Preview sequence'}>
            <button type="button" className="worlds-icon-button worlds-timeline__play" aria-label={previewPlaying ? 'Pause preview' : 'Preview sequence'} disabled={disabled || !sequence} onClick={() => {
              if (!sequence) return
              if (previewPlaying) onPreviewPause()
              else onPreviewPlay(sequence.id, fps, playheadTime)
            }}>{previewPlaying ? 'Ⅱ' : '▶'}</button>
          </Tooltip>
          <Tooltip content="Stop and rewind"><button type="button" className="worlds-icon-button" aria-label="Stop and rewind preview" disabled={!previewFrame} onClick={stop}>■</button></Tooltip>
          <span className="worlds-timeline__time" aria-live="off">{formatWorldTimelineTime(playheadTime)} / {sequence ? formatWorldTimelineTime(sequence.duration) : '0.00s'}</span>
          <label className="worlds-timeline__fps"><span>FPS</span><select aria-label="Frames per second" disabled={disabled || !sequence} value={fps} onChange={(event) => {
            const next = Number(event.currentTarget.value) as WorldSequenceFps
            setFps(next)
            setPlayheadFrame(0)
            onPreviewStop()
          }}>{WORLD_SEQUENCE_FPS_VALUES.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          {sequence ? <WorldsRenderPanel
            projectKey={projectKey}
            revision={snapshot.project.revision}
            sceneId={scene.sceneId}
            sequenceId={sequence.id}
            fps={fps}
            disabled={disabled}
            onBeforeStart={stop}
            onRefreshProject={onRefreshProject}
          /> : null}
        </> : <span className="worlds-timeline__summary">{scene.sequences.length} seq</span>}
      </header>

      {open ? <div className="worlds-timeline__content">
        <div className="worlds-timeline__tracks" aria-label="Sequence tracks">
          <div className="worlds-timeline__section-heading"><span>Tracks</span><Tooltip content="Add track"><button type="button" className="worlds-icon-button" aria-label="Add track" disabled={disabled || !sequence} onClick={() => setTrackDraftOpen((value) => !value)}>＋</button></Tooltip></div>
          {trackDraftOpen && sequence ? <TrackDraftEditor scene={scene} draft={trackDraft} onDraft={setTrackDraft} onAdd={addTrack} onCancel={() => setTrackDraftOpen(false)} /> : null}
          <div className="worlds-timeline__track-list">
            {sequence?.tracks.length ? sequence.tracks.map((track, index) => {
              const label = describeWorldTimelineTrack(scene, track)
              return <div key={track.id} className={`worlds-timeline__track${selectedTrack?.id === track.id ? ' is-selected' : ''}`} onKeyDown={(event) => {
                if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
                event.preventDefault()
                reorderTrack(track, event.key === 'ArrowUp' ? -1 : 1)
              }}>
                <button type="button" className="worlds-timeline__track-name" aria-label={`Select ${label} track`} aria-pressed={selectedTrack?.id === track.id} onClick={() => {
                  setSelectedTrackId(track.id)
                  setSelectedKeyframeId('')
                }}><span>{TRACK_LABELS[track.type]}</span><small>{label}</small></button>
                <Tooltip content="Move track up"><button type="button" className="worlds-icon-button" aria-label={`Move ${TRACK_LABELS[track.type]} up`} disabled={disabled || index === 0} onClick={() => reorderTrack(track, -1)}>↑</button></Tooltip>
                <Tooltip content="Move track down"><button type="button" className="worlds-icon-button" aria-label={`Move ${TRACK_LABELS[track.type]} down`} disabled={disabled || index === sequence.tracks.length - 1} onClick={() => reorderTrack(track, 1)}>↓</button></Tooltip>
                <Tooltip content="Remove track"><button type="button" className="worlds-icon-button" aria-label={`Remove ${TRACK_LABELS[track.type]} track`} disabled={disabled} onClick={() => removeTrack(track)}>×</button></Tooltip>
              </div>
            }) : <p className="worlds-muted">Add a track.</p>}
          </div>
        </div>

        <div className="worlds-timeline__editor">
          <div className="worlds-timeline__scrub">
            <input aria-label="Timeline playhead" type="range" min={0} max={Math.max(0, maximumFrame)} step={1} value={visiblePlayheadFrame} disabled={disabled || !sequence} onChange={(event) => seek(Number(event.currentTarget.value))} />
            <div className="worlds-timeline__markers" aria-label="Keyframes">
              {selectedTrack?.keyframes.map((keyframe) => <button key={keyframe.id} type="button" className={`worlds-timeline__marker${selectedKeyframe?.id === keyframe.id ? ' is-selected' : ''}`} aria-label={`Keyframe at ${formatWorldTimelineTime(keyframe.time)}`} style={{ left: `${worldTimelineMarkerPercent(keyframe.time, sequence!.duration)}%` }} onClick={() => setSelectedKeyframeId(keyframe.id)} />)}
            </div>
          </div>
          {selectedTrack ? <div className="worlds-timeline__key-editor">
            <div className="worlds-timeline__section-heading"><span>{TRACK_LABELS[selectedTrack.type]}</span><small>{selectedKeyframe ? formatWorldTimelineTime(selectedKeyframe.time) : 'New key'}</small></div>
            <KeyframeDraftEditor scene={scene} track={selectedTrack} value={keyframeDraft} onValue={setKeyframeDraft} />
            <div className="worlds-timeline__key-actions">
              <button type="button" className="worlds-compact-button worlds-button--primary" disabled={disabled} onClick={createKeyframe}>Add key</button>
              <button type="button" className="worlds-compact-button" disabled={disabled || !selectedKeyframe} onClick={updateKeyframe}>Update</button>
              <button type="button" className="worlds-compact-button" disabled={disabled || !selectedKeyframe} onClick={moveKeyframe}>Move here</button>
              <button type="button" className="worlds-compact-button" disabled={disabled || !selectedKeyframe} onClick={removeKeyframe}>Remove</button>
            </div>
          </div> : <p className="worlds-muted">Select a track.</p>}
          {previewFrame?.markers.length ? <div className="worlds-timeline__events" role="status" aria-live="polite">Event · {previewFrame.markers.map((marker) => marker.eventId).join(', ')}</div> : null}
        </div>
      </div> : null}
    </section>
  )
}

function TrackDraftEditor({ scene, draft, onDraft, onAdd, onCancel }: {
  scene: WorldSceneDocumentV1
  draft: WorldTimelineTrackDraft
  onDraft(value: WorldTimelineTrackDraft): void
  onAdd(draft: WorldTimelineTrackDraft): void
  onCancel(): void
}): JSX.Element {
  const entities = compatibleEntities(scene, draft.type)
  const selectedEntity = entities.find((entity) => entity.id === draft.entityId) ?? entities[0] ?? null
  const components = compatibleComponents(selectedEntity?.components ?? [], draft.type)
  const selectedComponent = components.find((component) => component.id === draft.componentId) ?? components[0] ?? null
  const properties = selectedComponent ? compatibleProperties(selectedComponent) : []
  const selectedProperty = properties.includes(draft.property ?? '') ? draft.property : properties[0]
  const normalized = normalizeTrackDraft(draft.type, selectedEntity?.id, selectedComponent?.id, selectedProperty)
  const valid = createWorldTimelineTrackFromDraft(scene, normalized, 'track:draft-check') !== null
  return <div className="worlds-timeline__track-draft">
    <label><span>Type</span><select aria-label="Track type" value={draft.type} onChange={(event) => onDraft(createDefaultTrackDraft(scene, event.currentTarget.value as WorldTimelineTrackType))}>{TRACK_TYPES.map((type) => <option key={type} value={type}>{TRACK_LABELS[type]}</option>)}</select></label>
    {draft.type !== 'event' ? <label><span>Entity</span><select aria-label="Track entity" value={selectedEntity?.id ?? ''} onChange={(event) => onDraft(normalizeTrackDraft(draft.type, event.currentTarget.value, undefined, undefined))}>{entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}</option>)}</select></label> : null}
    {requiresComponent(draft.type) ? <label><span>Component</span><select aria-label="Track component" value={selectedComponent?.id ?? ''} onChange={(event) => onDraft(normalizeTrackDraft(draft.type, selectedEntity?.id, event.currentTarget.value, undefined))}>{components.map((component) => <option key={component.id} value={component.id}>{describeComponentTarget(component)}</option>)}</select></label> : null}
    {draft.type === 'property' ? <label><span>Property</span><select aria-label="Track property" value={selectedProperty ?? ''} onChange={(event) => onDraft(normalizeTrackDraft(draft.type, selectedEntity?.id, selectedComponent?.id, event.currentTarget.value))}>{properties.map((property) => <option key={property} value={property}>{property}</option>)}</select></label> : null}
    <div className="worlds-timeline__draft-actions"><button type="button" className="worlds-compact-button worlds-button--primary" disabled={!valid} onClick={() => onAdd(normalized)}>Add</button><button type="button" className="worlds-compact-button" onClick={onCancel}>Cancel</button></div>
  </div>
}

function KeyframeDraftEditor({ scene, track, value, onValue }: {
  scene: WorldSceneDocumentV1
  track: WorldSequenceTrack
  value: KeyframeDraftState
  onValue(value: KeyframeDraftState): void
}): JSX.Element {
  const continuous = track.type === 'transform' || track.type === 'light' || (track.type === 'property' && worldTimelinePropertyKind(scene, track) !== 'boolean' && worldTimelinePropertyKind(scene, track) !== 'string')
  const kind = worldTimelineTrackValueKind(scene, track)
  return <div className="worlds-timeline__key-fields">
    {track.type === 'transform' ? <label><span>Channel</span><select aria-label="Transform channel" value={value.channel} onChange={(event) => onValue({ ...value, channel: event.currentTarget.value as keyof WorldTransform })}><option value="position">Position</option><option value="rotation">Rotation</option><option value="scale">Scale</option></select></label> : null}
    {kind === 'vector' ? <fieldset className="worlds-timeline__vector"><legend>Value</legend>{(['X', 'Y', 'Z'] as const).map((axis, index) => <label key={axis}><span>{axis}</span><input aria-label={`${axis} value`} type="number" step="0.01" value={value.vector[index]} onChange={(event) => {
      const vector = [...value.vector] as [string, string, string]
      vector[index] = event.currentTarget.value
      onValue({ ...value, vector })
    }} /></label>)}</fieldset> : null}
    {kind === 'number' ? <label><span>Value</span><input aria-label="Keyframe value" type="number" step="0.01" value={value.scalar} onChange={(event) => onValue({ ...value, scalar: event.currentTarget.value })} /></label> : null}
    {kind === 'boolean' ? <label><span>Value</span><select aria-label="Keyframe value" value={value.boolean ? 'true' : 'false'} onChange={(event) => onValue({ ...value, boolean: event.currentTarget.value === 'true' })}><option value="true">On</option><option value="false">Off</option></select></label> : null}
    {kind === 'string' || kind === 'event' ? <label><span>{kind === 'event' ? 'Event' : 'Value'}</span><input aria-label={kind === 'event' ? 'Event identifier' : 'Keyframe value'} type="text" value={value.text} onChange={(event) => onValue({ ...value, text: event.currentTarget.value })} /></label> : null}
    {continuous ? <label><span>Curve</span><select aria-label="Keyframe interpolation" value={value.interpolation} onChange={(event) => onValue({ ...value, interpolation: event.currentTarget.value as KeyframeDraftState['interpolation'] })}><option value="step">Step</option><option value="linear">Linear</option><option value="cubic">Cubic</option></select></label> : null}
  </div>
}

export function createWorldTimelineTrackFromDraft(
  scene: WorldSceneDocumentV1,
  draft: WorldTimelineTrackDraft,
  id: string,
): WorldSequenceTrack | null {
  if (!isWorldCanonicalId(id)) return null
  if (draft.type === 'event') return { id, type: 'event', keyframes: [] }
  const entity = scene.entities.find((candidate) => candidate.id === draft.entityId)
  if (!entity) return null
  if (draft.type === 'transform') return { id, type: 'transform', entityId: entity.id, keyframes: [] }
  if (draft.type === 'camera') {
    return entity.components.some((component) => component.type === 'camera')
      ? { id, type: 'camera', entityId: entity.id, keyframes: [] }
      : null
  }
  const component = entity.components.find((candidate) => candidate.id === draft.componentId)
  if (!component) return null
  if (draft.type === 'light') return component.type === 'light'
    ? { id, type: 'light', entityId: entity.id, componentId: component.id, property: 'intensity', keyframes: [] }
    : null
  if (draft.type === 'animation') return component.type === 'animation-player'
    ? { id, type: 'animation', entityId: entity.id, componentId: component.id, keyframes: [] }
    : null
  if (draft.type === 'audio') return component.type === 'audio-source'
    ? { id, type: 'audio', entityId: entity.id, componentId: component.id, keyframes: [] }
    : null
  if (!draft.property || !compatibleProperties(component).includes(draft.property)) return null
  return { id, type: 'property', entityId: entity.id, componentId: component.id, property: draft.property, keyframes: [] }
}

function createWorldTimelineKeyframeFromDraft(
  scene: WorldSceneDocumentV1,
  track: WorldSequenceTrack,
  id: string,
  time: WorldRationalTime,
  draft: KeyframeDraftState,
  existingKeyframe: WorldSequenceKeyframe | null = null,
): WorldSequenceKeyframe | null {
  if (!isWorldCanonicalId(id)) return null
  const normalizedTime = normalizeWorldRationalTime(time)
  if (track.type === 'event') return isWorldCanonicalId(draft.text)
    ? { id, time: normalizedTime, interpolation: 'step', eventId: draft.text }
    : null
  if (track.type === 'camera' || track.type === 'animation' || track.type === 'audio') {
    return { id, time: normalizedTime, interpolation: 'step', value: draft.boolean }
  }
  const interpolation = draft.interpolation
  if (track.type === 'transform') {
    const vector = parseVectorDraft(draft.vector)
    const existingValue = existingKeyframe && 'value' in existingKeyframe ? existingKeyframe.value : null
    return vector ? {
      id,
      time: normalizedTime,
      interpolation,
      value: mergeWorldTimelineTransformKeyframeValue(existingValue, draft.channel, vector),
    } : null
  }
  if (track.type === 'light') {
    const number = Number(draft.scalar)
    return Number.isFinite(number) ? { id, time: normalizedTime, interpolation, value: number } : null
  }
  const kind = worldTimelinePropertyKind(scene, track)
  let propertyValue: WorldPropertyValue | null = null
  if (kind === 'number') {
    const number = Number(draft.scalar)
    if (Number.isFinite(number)) propertyValue = number
  } else if (kind === 'boolean') propertyValue = draft.boolean
  else if (kind === 'string') propertyValue = draft.text
  else if (kind === 'vector') propertyValue = parseVectorDraft(draft.vector)
  if (propertyValue === null) return null
  const discrete = typeof propertyValue === 'boolean' || typeof propertyValue === 'string'
  return { id, time: normalizedTime, interpolation: discrete ? 'step' : interpolation, value: propertyValue } as WorldSequenceKeyframe
}

export function mergeWorldTimelineTransformKeyframeValue(
  raw: unknown,
  channel: keyof WorldTransform,
  vector: readonly [number, number, number],
): Partial<WorldTransform> {
  const existing = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Partial<WorldTransform>
    : {}
  const preserved: Partial<WorldTransform> = {
    ...(isWorldTimelineVector(existing.position) ? { position: [...existing.position] } : {}),
    ...(isWorldTimelineVector(existing.rotation) ? { rotation: [...existing.rotation] } : {}),
    ...(isWorldTimelineVector(existing.scale) ? { scale: [...existing.scale] } : {}),
  }
  return { ...preserved, [channel]: [...vector] }
}

function isWorldTimelineVector(value: unknown): value is [number, number, number] {
  return Array.isArray(value)
    && value.length === 3
    && value.every((component) => typeof component === 'number' && Number.isFinite(component))
}

function createDefaultTrackDraft(scene: WorldSceneDocumentV1, type: WorldTimelineTrackType): WorldTimelineTrackDraft {
  const entity = compatibleEntities(scene, type)[0]
  const component = compatibleComponents(entity?.components ?? [], type)[0]
  return normalizeTrackDraft(type, entity?.id, component?.id, component ? compatibleProperties(component)[0] : undefined)
}

function normalizeTrackDraft(type: WorldTimelineTrackType, entityId?: string, componentId?: string, property?: string): WorldTimelineTrackDraft {
  return {
    type,
    ...(type === 'event' ? {} : entityId ? { entityId } : {}),
    ...(requiresComponent(type) && componentId ? { componentId } : {}),
    ...(type === 'property' && property ? { property } : {}),
  }
}

function compatibleEntities(scene: WorldSceneDocumentV1, type: WorldTimelineTrackType): WorldSceneDocumentV1['entities'] {
  if (type === 'event') return []
  if (type === 'transform') return scene.entities
  if (type === 'camera') return scene.entities.filter((entity) => entity.components.some((component) => component.type === 'camera'))
  return scene.entities.filter((entity) => compatibleComponents(entity.components, type).length > 0)
}

function compatibleComponents(components: readonly WorldComponent[], type: WorldTimelineTrackType): WorldComponent[] {
  if (type === 'light') return components.filter((component) => component.type === 'light')
  if (type === 'animation') return components.filter((component) => component.type === 'animation-player')
  if (type === 'audio') return components.filter((component) => component.type === 'audio-source')
  if (type === 'property') return components.filter((component) => compatibleProperties(component).length > 0)
  return []
}

function compatibleProperties(component: WorldComponent): string[] {
  return [...(getWorldComponentDefinition(component.type)?.writableProperties ?? [])]
    .filter((property) => readComponentProperty(component, property) !== undefined || (component.type === 'collider' && (property === 'collisionLayer' || property === 'collisionMask')))
}

function requiresComponent(type: WorldTimelineTrackType): boolean {
  return type === 'light' || type === 'property' || type === 'animation' || type === 'audio'
}

function describeWorldTimelineTrack(scene: WorldSceneDocumentV1, track: WorldSequenceTrack): string {
  if (track.type === 'event') return 'Markers'
  const entity = scene.entities.find((candidate) => candidate.id === track.entityId)
  if (track.type === 'transform' || track.type === 'camera') return entity?.name ?? track.entityId
  return `${entity?.name ?? track.entityId} · ${track.type === 'property' ? track.property : describeComponentTarget(entity?.components.find((component) => component.id === track.componentId) ?? null)}`
}

function describeComponentTarget(component: WorldComponent | null): string {
  if (!component) return 'Unavailable'
  const definition = getWorldComponentDefinition(component.type)
  const resourceId = 'resourceId' in component ? component.resourceId : null
  const resource = resourceId ?? null
  return `${definition?.label ?? component.type}${resource ? ` · ${resource}` : ''}`
}

function createKeyframeDraftState(
  scene: WorldSceneDocumentV1,
  track: WorldSequenceTrack,
  keyframe: WorldSequenceKeyframe | null,
): KeyframeDraftState {
  const next = { ...DEFAULT_KEYFRAME_DRAFT, vector: [...DEFAULT_KEYFRAME_DRAFT.vector] as [string, string, string] }
  if (!keyframe) {
    const base = readWorldTimelineTrackBaseValue(scene, track)
    return populateKeyframeDraft(next, track, base)
  }
  if (track.type === 'event') return { ...next, text: (keyframe as Extract<WorldSequenceKeyframe, { eventId: string }>).eventId, interpolation: 'step' }
  return populateKeyframeDraft(next, track, (keyframe as Exclude<WorldSequenceKeyframe, { eventId: string }>).value, keyframe.interpolation)
}

function populateKeyframeDraft(
  state: KeyframeDraftState,
  track: WorldSequenceTrack,
  raw: unknown,
  interpolation?: 'step' | 'linear' | 'cubic',
): KeyframeDraftState {
  const next = { ...state, interpolation: interpolation ?? (track.type === 'camera' || track.type === 'animation' || track.type === 'audio' ? 'step' : 'linear') }
  if (track.type === 'transform' && raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const transform = raw as Partial<WorldTransform>
    const channel = (['position', 'rotation', 'scale'] as const).find((candidate) => transform[candidate]) ?? 'position'
    const vector = transform[channel] ?? [0, 0, 0]
    return { ...next, channel, vector: vector.map(String) as [string, string, string] }
  }
  if (Array.isArray(raw) && raw.length === 3) return { ...next, vector: raw.map(String) as [string, string, string] }
  if (typeof raw === 'number') return { ...next, scalar: String(raw) }
  if (typeof raw === 'boolean') return { ...next, boolean: raw, interpolation: 'step' }
  if (typeof raw === 'string') return { ...next, text: raw, interpolation: 'step' }
  return next
}

function readWorldTimelineTrackBaseValue(scene: WorldSceneDocumentV1, track: WorldSequenceTrack): unknown {
  if (track.type === 'event') return 'event:marker'
  const entity = scene.entities.find((candidate) => candidate.id === track.entityId)
  if (!entity) return null
  if (track.type === 'transform') return entity.transform
  if (track.type === 'camera') return entity.components.find((component) => component.type === 'camera')?.primary ?? false
  const component = entity.components.find((candidate) => candidate.id === track.componentId)
  if (!component) return null
  if (track.type === 'animation' || track.type === 'audio') return component.type === 'animation-player' || component.type === 'audio-source' ? component.autoplay : false
  return readComponentProperty(component, track.property)
}

function readComponentProperty(component: WorldComponent, property: string): unknown {
  let current: unknown = component
  for (const segment of property.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  if (current === undefined && component.type === 'collider' && property === 'collisionLayer') return 1
  if (current === undefined && component.type === 'collider' && property === 'collisionMask') return 0xffff
  return current
}

function worldTimelineTrackValueKind(scene: WorldSceneDocumentV1, track: WorldSequenceTrack): 'number' | 'boolean' | 'string' | 'vector' | 'event' {
  if (track.type === 'event') return 'event'
  if (track.type === 'transform') return 'vector'
  if (track.type === 'camera' || track.type === 'animation' || track.type === 'audio') return 'boolean'
  if (track.type === 'light') return 'number'
  return worldTimelinePropertyKind(scene, track)
}

function worldTimelinePropertyKind(scene: WorldSceneDocumentV1, track: Extract<WorldSequenceTrack, { type: 'property' }> | WorldSequenceTrack): 'number' | 'boolean' | 'string' | 'vector' {
  if (track.type !== 'property') return 'number'
  const value = readWorldTimelineTrackBaseValue(scene, track)
  if (Array.isArray(value)) return 'vector'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'string') return 'string'
  return 'number'
}

function parseVectorDraft(value: readonly string[]): WorldVector3 | null {
  const numbers = value.map(Number)
  return numbers.length === 3 && numbers.every(Number.isFinite) ? numbers as WorldVector3 : null
}

function worldTimelineDurationFrameCount(duration: WorldRationalTime, fps: WorldSequenceFps): number {
  const normalized = normalizeWorldRationalTime(duration)
  const numerator = BigInt(normalized.numerator) * BigInt(fps)
  const denominator = BigInt(normalized.denominator)
  const frames = numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator
  if (frames > BigInt(1_000_000)) return 1_000_000
  return Number(frames)
}

function worldTimelineFrameIndex(time: WorldRationalTime, fps: WorldSequenceFps): number {
  const normalized = normalizeWorldRationalTime(time)
  return Math.round(normalized.numerator * fps / normalized.denominator)
}

function worldTimelineMarkerPercent(time: WorldRationalTime, duration: WorldRationalTime): number {
  const seconds = worldRationalTimeToSeconds(time)
  const total = worldRationalTimeToSeconds(duration)
  return total <= 0 ? 0 : Math.min(100, Math.max(0, seconds / total * 100))
}

function formatWorldTimelineTime(time: WorldRationalTime): string {
  return `${worldRationalTimeToSeconds(time).toFixed(2)}s`
}

function handleTimelineKeyboard(event: ReactKeyboardEvent<HTMLElement>, actions: {
  disabled: boolean
  playing: boolean
  play(): void
  pause(): void
  stop(): void
  seekFrame(offset: number): void
}): void {
  const target = event.target
  if (target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(target.tagName)) return
  if (actions.disabled) return
  if (event.key === ' ') {
    event.preventDefault()
    if (actions.playing) actions.pause()
    else actions.play()
  } else if (event.key === 'Home') {
    event.preventDefault()
    actions.stop()
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault()
    actions.seekFrame(event.key === 'ArrowLeft' ? -1 : 1)
  }
}

export default WorldsTimelineDrawer

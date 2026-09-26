import { Component, lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import { Tooltip } from '../../../shared/components/ui/Tooltip.tsx'
import {
  createDefaultWorldComponent,
  getWorldComponentDefinition,
  type WorldBehaviorAction,
  type WorldBehaviorBinding,
  type WorldBehaviorComponent,
  type WorldComponent,
  type WorldComponentType,
  type WorldInspectorFieldDescriptor,
} from '../core/worldComponentRegistry.ts'
import type { WorldCommand } from '../core/worldCommands.ts'
import type { WorldInputBinding, WorldProjectSnapshotV1, WorldSceneDocumentV1, WorldTransform } from '../core/worldModel.ts'
import {
  buildAddAxis2dInputActionCommands,
  buildAddButtonInputActionCommands,
  buildAddAdvancedColliderCommands,
  buildAddPrimitiveColliderCommands,
  buildAttachAudioSourceCommands,
  buildCharacterControllerPresetCommands,
  buildComponentPresetCommands,
  buildRemoveInputActionCommands,
  buildRemoveWorldComponentCommands,
  buildRenameInputActionCommands,
  buildSetPrimaryComponentCommands,
  buildUpdateInputBindingCommands,
  buildWorldGltfAnimationCommands,
  describeWorldGltfAnimationClips,
  getCompatibleWorldGltfAnimationResources,
  getWorldGltfAnimationModel,
  createCompatibleWorldBehaviorAction,
  createCompatibleWorldBehaviorEvent,
  getCompatibleWorldBehaviorActionTypes,
  getCompatibleWorldBehaviorEventTypes,
  getEligibleWorldColliderSourceResources,
  getWorldLivePropertyTargets,
  replaceWorldRigidBodyComponent,
  replaceWorldColliderComponent,
  replaceWorldBehaviorComponent,
  resolveDefaultWorldColliderSourceResourceId,
  type WorldAdvancedColliderShape,
  type WorldBehaviorAuthoringActionType,
  type WorldBehaviorAuthoringEventType,
  type WorldComponentPreset,
  type WorldCharacterPresetInputs,
  type WorldGltfAnimationOwner,
  type WorldGltfAnimationSelection,
  type WorldGltfClipDescriptor,
} from '../editor/worldAuthoringModel.ts'
import {
  buildPatchEntityTransformsCommands,
  createDeterministicWorldEditorIdentityGenerator,
} from '../editor/worldEditorCommandBuilders.ts'
import {
  buildInspectorComponentReplacement,
  getVisibleWorldInspectorFields,
  isWorldEntityEffectivelyLocked,
  parseWorldInspectorNumber,
  readComponentProperty,
  snapWorldInspectorValue,
} from '../editor/worldsWorkbenchModel.ts'
import { createWorldUiTransactionId } from '../editor/useWorldEditorController.ts'
import type { WorldEditorDispatchAuthority } from '../editor/worldEditorController.ts'
import type { WorldEditorTransformAdmission, WorldEditorTransformGesture } from '../editor/worldEditorTransformAdmission.ts'
import { createWorldWorkspaceUrl } from '../worldWorkspaceUrl.ts'
import type { WorldsTransformMode } from './WorldsTransformToolbar.tsx'

function replaceControlCharacters(value: string, replacement: string): string {
  let sanitized = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    sanitized += code <= 0x1f || code === 0x7f ? replacement : value[index]
  }
  return sanitized
}

export interface WorldsInspectorProps {
  projectKey: string
  snapshot: WorldProjectSnapshotV1
  scene: WorldSceneDocumentV1
  selectedEntityIds: readonly string[]
  activeEntityId: string | null
  snapEnabled: boolean
  snapIncrement: number
  onSnap(enabled: boolean, increment?: number): void
  transformPending?: boolean
  transformAdmission?: WorldEditorTransformAdmission
  viewportTools?: {
    entityId: string
    mode: WorldsTransformMode | null
    baseScene: boolean
    disabled: boolean
    onModeChange(mode: WorldsTransformMode | null): void
    onToggleBaseSceneItem(entityId: string): void
  }
  apiUrl?: string
  animationDisabled?: boolean
  isAnimationOwnerCurrent?(owner: WorldGltfAnimationOwner): boolean
  onCommands(commands: WorldCommand[], scope: string, authority?: WorldEditorDispatchAuthority): boolean | Promise<boolean> | void
  onError(message: string): void
}

const EDITOR_COMPONENT_TYPES = ['renderable', 'camera', 'light', 'collider', 'rigid-body', 'character-controller', 'animation-player', 'audio-source', 'audio-listener', 'trigger', 'behavior'] as const satisfies readonly WorldComponentType[]
const GENERIC_COMPONENT_TYPES = ['renderable', 'camera', 'light'] as const satisfies readonly WorldComponentType[]
type InspectorCommitResult = boolean | Promise<boolean | void> | void

export function WorldsInspector({
  projectKey,
  snapshot,
  scene,
  selectedEntityIds,
  activeEntityId,
  snapEnabled,
  snapIncrement,
  onSnap,
  transformPending = false,
  transformAdmission,
  viewportTools,
  apiUrl = '',
  animationDisabled = false,
  isAnimationOwnerCurrent,
  onCommands,
  onError,
}: WorldsInspectorProps): JSX.Element {
  const selected = scene.entities.filter((entity) => selectedEntityIds.includes(entity.id))
  const active = selected.find((entity) => entity.id === activeEntityId) ?? selected.at(-1) ?? null
  const locked = selected.some((entity) => isWorldEntityEffectivelyLocked(scene.entities, entity.id))
  const animationModel = active ? getWorldGltfAnimationModel(snapshot, scene.sceneId, active.id) : null
  const eligibleColliderSources = getEligibleWorldColliderSourceResources(snapshot)
  const selectedDefaultColliderSourceId = active ? resolveDefaultWorldColliderSourceResourceId(snapshot, scene.sceneId, active.id) : null
  const eligibleColliderSourceIds = new Set(eligibleColliderSources.map((resource) => resource.id))
  const advancedColliderContextKey = JSON.stringify([projectKey, scene.sceneId, active?.id ?? ''])
  const [advancedColliderSource, setAdvancedColliderSource] = useState<{ contextKey: string; resourceId: string; explicit: boolean }>({
    contextKey: advancedColliderContextKey,
    resourceId: '',
    explicit: false,
  })
  const contextSource = advancedColliderSource.contextKey === advancedColliderContextKey ? advancedColliderSource : null
  const explicitColliderSourceId = contextSource?.explicit ? contextSource.resourceId : null
  const activeAdvancedColliderSourceId = explicitColliderSourceId !== null
    ? (eligibleColliderSourceIds.has(explicitColliderSourceId) ? explicitColliderSourceId : '')
    : (selectedDefaultColliderSourceId && eligibleColliderSourceIds.has(selectedDefaultColliderSourceId) ? selectedDefaultColliderSourceId : '')
  useEffect(() => {
    setAdvancedColliderSource({ contextKey: advancedColliderContextKey, resourceId: '', explicit: false })
  }, [advancedColliderContextKey])

  if (!active) {
    return (
      <div className="worlds-dock-panel" aria-label="Scene inspector">
        <header className="worlds-dock-header"><div><span>Inspector</span><small>Scene</small></div></header>
        <InspectorSection heading="Environment">
          <ColorCommitField
            label="Background"
            value={scene.environment.backgroundColor}
            onCommit={(value) => onCommands([{
              type: 'set-scene-environment', sceneId: scene.sceneId,
              environment: { ...structuredClone(scene.environment), backgroundColor: value as `#${string}` },
            }], 'environment-color')}
          />
          <NumericCommitField
            label="Ambient"
            value={scene.environment.ambientIntensity}
            min={0}
            step={0.1}
            onCommit={(value) => onCommands([{
              type: 'set-scene-environment', sceneId: scene.sceneId,
              environment: { ...structuredClone(scene.environment), ambientIntensity: value },
            }], 'environment-ambient')}
          />
        </InspectorSection>
        <ProjectInputsEditor snapshot={snapshot} onCommands={onCommands} onError={onError} />
      </div>
    )
  }

  const commitTransform = (group: keyof WorldTransform, axis: 0 | 1 | 2, displayValue: number, gesture: WorldEditorTransformGesture | null) => {
    if (locked) return onError('Locked entities cannot be edited.')
    if (gesture && !transformAdmission?.release(gesture)) {
      onError('Transform is no longer current.')
      return false
    }
    const value = group === 'rotation' ? displayValue * Math.PI / 180 : snapWorldInspectorValue(displayValue, { enabled: snapEnabled, increment: snapIncrement })
    const updates = selected.map((entity) => {
      const transform = structuredClone(entity.transform)
      transform[group][axis] = value
      return { entityId: entity.id, transform }
    })
    try {
      const authority = gesture ? {
        projectKey: gesture.projectKey,
        projectId: gesture.projectId,
        baseRevision: gesture.baseRevision,
        activeSceneId: gesture.sceneId,
      } : undefined
      const result = Promise.resolve(onCommands(buildPatchEntityTransformsCommands(gesture?.snapshot ?? snapshot, scene.sceneId, updates), 'inspector-transform', authority))
      if (gesture) result.finally(() => transformAdmission?.finish(gesture))
      return result
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Transform is invalid.')
      if (gesture) transformAdmission?.finish(gesture)
      return false
    }
  }

  const commitComponent = (component: WorldComponent, property: string, value: unknown) => {
    if (locked) {
      onError('Locked entities cannot be edited.')
      return false
    }
    try {
      if (component.type === 'collider') {
        const patch: Parameters<typeof replaceWorldColliderComponent>[4] = property === 'shape' && (value === 'convex' || value === 'mesh')
          ? { shape: value, resourceId: component.shape === 'convex' || component.shape === 'mesh' ? component.resourceId : (activeAdvancedColliderSourceId || undefined) }
          : { [property]: value }
        return onCommands(replaceWorldColliderComponent(snapshot, scene.sceneId, active.id, component.id, patch), 'inspector-collider')
      }
      if (component.type === 'rigid-body') {
        return onCommands(replaceWorldRigidBodyComponent(snapshot, scene.sceneId, active.id, component.id, { [property]: value }), 'inspector-rigid-body')
      }
      const replacement = buildInspectorComponentReplacement(component, property, value)
      return onCommands([{
        type: 'replace-component', sceneId: scene.sceneId, entityId: active.id,
        componentId: component.id, component: replacement,
      }], `inspector-${component.type}`)
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Component value is invalid.')
      return false
    }
  }

  const builderContext = (scope: string) => ({
    snapshot,
    projectKey,
    activeSceneId: scene.sceneId,
    identities: createDeterministicWorldEditorIdentityGenerator(createWorldUiTransactionId(scope)),
  })

  const addBasicComponent = (type: Extract<WorldComponentType, 'renderable' | 'camera' | 'light'>) => {
    if (locked) return onError('Locked entities cannot be edited.')
    try {
      const seed = createWorldUiTransactionId(`add-${type}`)
      const id = createDeterministicWorldEditorIdentityGenerator(seed).nextId('component', `${active.id}:${type}`)
      let component = createDefaultWorldComponent(type, id)
      if (component.type === 'renderable') {
        const model = snapshot.project.resources.find((resource) => resource.type === 'model')
        if (!model) throw new Error('Add a model asset before Renderable.')
        component = { ...component, resourceId: model.id }
      }
      onCommands([{ type: 'add-component', sceneId: scene.sceneId, entityId: active.id, component }], `add-${type}`)
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Component could not be added.')
    }
  }

  const addPreset = (preset: WorldComponentPreset) => {
    if (locked) return onError('Locked entities cannot be edited.')
    try {
      onCommands(buildComponentPresetCommands(builderContext(`add-${preset}`), active.id, preset), `add-${preset}`)
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Component preset could not be added.')
    }
  }

  const addPrimitiveCollider = (shape: 'sphere' | 'capsule') => {
    if (locked) return onError('Locked entities cannot be edited.')
    try {
      onCommands(buildAddPrimitiveColliderCommands(builderContext(`add-${shape}-collider`), active.id, { shape }), `add-${shape}-collider`)
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Collider could not be added.')
    }
  }

  const addAdvancedCollider = (shape: WorldAdvancedColliderShape) => {
    if (locked) return onError('Locked entities cannot be edited.')
    if (!activeAdvancedColliderSourceId) return onError('Choose a mesh source for this collider.')
    try {
      onCommands(buildAddAdvancedColliderCommands(builderContext(`add-${shape}-collider`), active.id, { shape, resourceId: activeAdvancedColliderSourceId }), `add-${shape}-collider`)
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Collider could not be added.')
    }
  }

  const addAudioSource = () => {
    const resource = snapshot.project.resources.find((candidate) => candidate.type === 'audio')
    if (!resource) return onError('Attach a workspace audio asset first.')
    try {
      onCommands(buildAttachAudioSourceCommands(builderContext('add-audio-source'), active.id, {
        workspacePath: resource.workspacePath,
        format: resource.format,
        name: resource.name,
      }), 'add-audio-source')
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Audio source could not be added.')
    }
  }

  const removeComponent = (component: WorldComponent) => {
    if (locked) return onError('Locked entities cannot be edited.')
    try {
      onCommands(buildRemoveWorldComponentCommands(snapshot, scene.sceneId, active.id, component.id), `remove-${component.type}`)
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Component could not be removed.')
    }
  }

  const makePrimary = (component: WorldComponent) => {
    if (locked) return onError('Locked entities cannot be edited.')
    try {
      onCommands(buildSetPrimaryComponentCommands(snapshot, scene.sceneId, active.id, component.id), `primary-${component.type}`)
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Primary component could not be changed.')
    }
  }

  return (
    <div className="worlds-dock-panel" aria-label="Entity inspector">
      <header className="worlds-dock-header">
        <div><span>Inspector</span><small>{selected.length > 1 ? `${selected.length} selected` : active.name}</small></div>
      </header>
      <div className="worlds-inspector-scroll">
        {locked ? <p role="status" className="worlds-lock-notice">Locked</p> : null}
        <InspectorSection heading="Transform">
          {viewportTools?.entityId === active.id && active.enabled && active.components.some((component) => component.type === 'renderable' && component.enabled && component.visible) ? (
            <div role="toolbar" aria-label="Selected entity viewport tools" className="worlds-component-buttons mb-2">
              {(['translate', 'rotate', 'scale'] as const).map((mode, index) => {
                const copy = ['Move', 'Rotate', 'Scale'][index]
                return <Tooltip key={mode} content={`${copy} selected asset`}>
                  <button type="button" className="worlds-authoring-action aria-pressed:border-violet-400 aria-pressed:bg-violet-600 aria-pressed:text-white disabled:opacity-40" aria-label={`${copy} selected asset`} aria-pressed={viewportTools.mode === mode} disabled={locked || transformPending || viewportTools.disabled} onClick={() => {
                    if (!locked && !transformPending && !viewportTools.disabled) viewportTools.onModeChange(viewportTools.mode === mode ? null : mode)
                  }}>{copy}</button>
                </Tooltip>
              })}
              <Tooltip content={viewportTools.baseScene ? 'Unset selected asset as base world' : 'Set selected asset as base world'}>
                <button type="button" className="worlds-authoring-action aria-pressed:border-emerald-400 aria-pressed:bg-emerald-500/15 aria-pressed:text-emerald-200 disabled:opacity-40" aria-label={viewportTools.baseScene ? 'Unset selected asset as base world' : 'Set selected asset as base world'} aria-pressed={viewportTools.baseScene} disabled={locked || transformPending || viewportTools.disabled} onClick={() => {
                  if (!locked && !transformPending && !viewportTools.disabled) viewportTools.onToggleBaseSceneItem(active.id)
                }}>Base</button>
              </Tooltip>
            </div>
          ) : null}
          <div className="worlds-snap-row">
            <label><input type="checkbox" checked={snapEnabled} onChange={(event) => onSnap(event.currentTarget.checked)} />Snap</label>
            <NumericCommitField label="Step" value={snapIncrement} min={0.0001} step={0.1} disabled={!snapEnabled} onCommit={(value) => onSnap(true, value)} />
          </div>
          {transformPending ? <p role="status" aria-live="polite" className="worlds-empty-copy">Saving transform…</p> : null}
          <TransformRow label="Position" unit="m" transform={active.transform.position} disabled={locked || transformPending} onBegin={() => transformAdmission?.begin('inspector', selected.map((entity) => entity.id)) ?? null} onCancel={(gesture) => transformAdmission?.cancel(gesture)} onCommit={(axis, value, gesture) => commitTransform('position', axis, value, gesture)} />
          <TransformRow label="Rotation" unit="°" transform={active.transform.rotation.map((value) => value * 180 / Math.PI) as [number, number, number]} disabled={locked || transformPending} onBegin={() => transformAdmission?.begin('inspector', selected.map((entity) => entity.id)) ?? null} onCancel={(gesture) => transformAdmission?.cancel(gesture)} onCommit={(axis, value, gesture) => commitTransform('rotation', axis, value, gesture)} />
          <TransformRow label="Scale" unit="×" transform={active.transform.scale} disabled={locked || transformPending} onBegin={() => transformAdmission?.begin('inspector', selected.map((entity) => entity.id)) ?? null} onCancel={(gesture) => transformAdmission?.cancel(gesture)} onCommit={(axis, value, gesture) => commitTransform('scale', axis, value, gesture)} />
        </InspectorSection>

        {active.components.filter((component) => EDITOR_COMPONENT_TYPES.includes(component.type as never)).map((component) => {
          const definition = getWorldComponentDefinition(component.type)
          if (!definition) return null
          return (
            <InspectorSection
              key={JSON.stringify([projectKey, snapshot.project.projectId, scene.sceneId, active.id, component.id, component.type])}
              heading={definition.label}
              actions={(
                <Tooltip content={`Remove ${definition.label}`}>
                  <button type="button" className="worlds-inspector-remove worlds-authoring-action" aria-label={`Remove ${definition.label}`} disabled={locked} onClick={() => removeComponent(component)}>×</button>
                </Tooltip>
              )}
            >
              {GENERIC_COMPONENT_TYPES.includes(component.type as never) ? getVisibleWorldInspectorFields(component)
                .filter((field) => field.property !== 'primary')
                .map((field) => (
                  <ComponentField
                    key={field.property}
                    component={component}
                    field={field}
                    disabled={locked || field.control === 'resource'}
                    onCommit={(value) => commitComponent(component, field.property, value)}
                  />
                )) : (
                  <ComponentAuthoringFields
                    snapshot={snapshot}
                    scene={scene}
                    entityId={active.id}
                    component={component}
                    disabled={locked}
                    onCommit={(property, value) => commitComponent(component, property, value)}
                    onBehavior={(replacement) => {
                      try {
                        onCommands(replaceWorldBehaviorComponent(snapshot, scene.sceneId, active.id, component.id, replacement), 'behavior')
                      } catch (error) {
                        onError(error instanceof Error ? error.message : 'Behavior is invalid.')
                      }
                    }}
                    onError={onError}
                  />
                )}
              {component.type === 'camera' ? (
                <button type="button" className="worlds-button worlds-authoring-action" aria-label="Make primary camera" disabled={locked || component.primary} onClick={() => makePrimary(component)}>
                  {component.primary ? 'Primary camera' : 'Make primary'}
                </button>
              ) : null}
              {component.type === 'audio-listener' ? (
                <button type="button" className="worlds-button worlds-authoring-action" aria-label="Make primary audio listener" disabled={locked || component.primary} onClick={() => makePrimary(component)}>
                  {component.primary ? 'Primary listener' : 'Make primary'}
                </button>
              ) : null}
            </InspectorSection>
          )
        })}

        <WorldGltfAnimationSection
          key={JSON.stringify([projectKey, snapshot.project.projectId, snapshot.project.revision, scene.sceneId, active.id, animationModel?.id, animationModel?.workspacePath, apiUrl, animationDisabled, locked, selected.length])}
          projectKey={projectKey} snapshot={snapshot} scene={scene} entityId={active.id} apiUrl={apiUrl}
          disabled={animationDisabled || locked || selected.length !== 1}
          isOwnerCurrent={isAnimationOwnerCurrent} onCommands={onCommands} onError={onError}
        />
        <InspectorSection heading="Add component">
          <div className="worlds-component-buttons">
            {!active.components.some((component) => component.type === 'renderable') ? <AuthoringButton label="Renderable" disabled={locked} onClick={() => addBasicComponent('renderable')} /> : null}
            {!active.components.some((component) => component.type === 'camera') ? <AuthoringButton label="Camera" disabled={locked} onClick={() => addBasicComponent('camera')} /> : null}
            {!active.components.some((component) => component.type === 'light') ? <AuthoringButton label="Light" disabled={locked} onClick={() => addBasicComponent('light')} /> : null}
            <AuthoringButton label="Box Collider" disabled={locked} onClick={() => addPreset('box-collider')} />
            <AuthoringButton label="Sphere Collider" disabled={locked} onClick={() => addPrimitiveCollider('sphere')} />
            <AuthoringButton label="Capsule Collider" disabled={locked} onClick={() => addPrimitiveCollider('capsule')} />
            <AuthoringButton label="Convex Hull" disabled={locked || !activeAdvancedColliderSourceId} onClick={() => addAdvancedCollider('convex')} />
            <AuthoringButton label="Static Mesh" disabled={locked || !activeAdvancedColliderSourceId} onClick={() => addAdvancedCollider('mesh')} />
            {!active.components.some((component) => component.type === 'rigid-body') ? <>
              <AuthoringButton label="Dynamic Body" disabled={locked} onClick={() => addPreset('dynamic-body')} />
              <AuthoringButton label="Fixed Body" disabled={locked} onClick={() => addPreset('fixed-body')} />
            </> : null}
            <AuthoringButton label="Trigger" disabled={locked} onClick={() => addPreset('trigger')} />
            {!active.components.some((component) => component.type === 'audio-listener') ? <AuthoringButton label="Audio Listener" disabled={locked} onClick={() => addPreset('audio-listener')} /> : null}
            {snapshot.project.resources.some((resource) => resource.type === 'audio') ? <AuthoringButton label="Audio Source" disabled={locked} onClick={addAudioSource} /> : null}
            <AuthoringButton label="Behavior" disabled={locked} onClick={() => addPreset('behavior')} />
          </div>
          {eligibleColliderSources.length > 0 ? (
            <SelectField
              label="Mesh source"
              value={activeAdvancedColliderSourceId}
              disabled={locked}
              options={[
                { value: '', label: 'Choose source' },
                ...eligibleColliderSources.map((resource) => ({ value: resource.id, label: `${resource.name} · ${resource.format.toUpperCase()}` })),
              ]}
              onCommit={(resourceId) => setAdvancedColliderSource({ contextKey: advancedColliderContextKey, resourceId, explicit: true })}
            />
          ) : null}
          {!active.components.some((component) => component.type === 'character-controller') ? (
            <CharacterPresetEditor key={active.id} snapshot={snapshot} disabled={locked} onAdd={(inputs) => {
              if (locked) return onError('Locked entities cannot be edited.')
              try {
                onCommands(buildCharacterControllerPresetCommands(builderContext('add-character'), active.id, inputs), 'add-character')
              } catch (error) {
                onError(error instanceof Error ? error.message : 'Character could not be added.')
              }
            }} />
          ) : null}
        </InspectorSection>
        <ProjectInputsEditor snapshot={snapshot} onCommands={onCommands} onError={onError} />
      </div>
    </div>
  )
}

function InspectorSection({ heading, actions, children }: { heading: string; actions?: ReactNode; children: ReactNode }): JSX.Element {
  return <section className="worlds-inspector-section"><div className="worlds-inspector-section__heading"><h3>{heading}</h3>{actions}</div>{children}</section>
}

function WorldGltfAnimationSection({ projectKey, snapshot, scene, entityId, apiUrl, disabled, isOwnerCurrent, onCommands, onError }: {
  projectKey: string
  snapshot: WorldProjectSnapshotV1
  scene: WorldSceneDocumentV1
  entityId: string
  apiUrl: string
  disabled: boolean
  isOwnerCurrent?: (owner: WorldGltfAnimationOwner) => boolean
  onCommands: WorldsInspectorProps['onCommands']
  onError: WorldsInspectorProps['onError']
}): JSX.Element {
  const model = getWorldGltfAnimationModel(snapshot, scene.sceneId, entityId)
  const owner: WorldGltfAnimationOwner | null = model ? {
    projectKey, projectId: snapshot.project.projectId, baseRevision: snapshot.project.revision,
    sceneId: scene.sceneId, entityId, modelResourceId: model.id, modelWorkspacePath: model.workspacePath,
  } : null
  const ownerKey = JSON.stringify(owner)
  const [requested, setRequested] = useState(false)
  const [clips, setClips] = useState<WorldGltfClipDescriptor[] | null>(null)
  const [clipId, setClipId] = useState('')
  const [resourceId, setResourceId] = useState('')
  const [pending, setPending] = useState(false)
  const inFlight = useRef(false)
  const live = useRef({ mounted: true, ownerKey, disabled, isOwnerCurrent })
  live.current.ownerKey = ownerKey
  live.current.disabled = disabled
  live.current.isOwnerCurrent = isOwnerCurrent
  useEffect(() => {
    live.current.mounted = true
    return () => { live.current.mounted = false }
  }, [])
  const current = useCallback(() => !!owner && live.current.mounted && !live.current.disabled
    && live.current.ownerKey === ownerKey && (live.current.isOwnerCurrent?.(owner) ?? true), [ownerKey])
  const receive = useCallback((loaded: WorldGltfClipDescriptor[]) => {
    if (current()) setClips(loaded)
  }, [current])
  const resources = getCompatibleWorldGltfAnimationResources(snapshot, scene.sceneId, entityId)
  const player = scene.entities.find((entity) => entity.id === entityId)?.components.find((component) => component.type === 'animation-player')
  const selectedClip = clips?.find((clip) => `clip:${clip.clipIndex}` === clipId)
  const selection: WorldGltfAnimationSelection | null = resourceId && resources.some((resource) => resource.id === resourceId)
    ? { kind: 'resource', resourceId }
    : selectedClip?.available ? { kind: 'clip', clip: selectedClip } : null
  const commit = async (operation: 'create' | 'add' | 'rebind') => {
    if (!current() || !owner || !selection || inFlight.current) return onError('Animation selection is no longer current.')
    inFlight.current = true
    setPending(true)
    try {
      const commands = buildWorldGltfAnimationCommands({ snapshot, projectKey, activeSceneId: scene.sceneId,
        identities: createDeterministicWorldEditorIdentityGenerator(createWorldUiTransactionId('animation')),
      }, owner, selection, operation)
      if (!current()) return onError('Animation selection is no longer current.')
      if (commands.length > 0) await onCommands(commands, `animation-${operation}`, {
        projectKey: owner.projectKey, projectId: owner.projectId, baseRevision: owner.baseRevision, activeSceneId: owner.sceneId,
      })
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Animation could not be authored.')
    } finally {
      inFlight.current = false
      if (live.current.mounted) setPending(false)
    }
  }
  const unavailable = disabled || pending || !model
  return <InspectorSection heading="Animation">
    {model && owner ? <>
      <Tooltip content="Read clips from this model; source order changes when the model file is replaced.">
        <button type="button" className="worlds-button worlds-authoring-action" aria-label="Load animation clips" disabled={unavailable || requested} onClick={() => {
          if (!current()) return onError('Animation selection is no longer current.')
          setRequested(true)
        }}>Load clips</button>
      </Tooltip>
      {requested ? <GltfClipCatalogBoundary>
        <Suspense fallback={<p role="status" className="worlds-empty-copy">Loading clips…</p>}>
          <BorrowedGltfClipCatalog url={createWorldWorkspaceUrl(apiUrl, model.workspacePath)} onLoaded={receive} />
        </Suspense>
      </GltfClipCatalogBoundary> : null}
      {clips?.length === 0 ? <p role="status" className="worlds-empty-copy">No animation clips</p> : null}
      {clips && clips.length > 0 ? <label className="worlds-property-row"><span>Clip</span>
        <select aria-label="Animation clip" value={clipId} disabled={unavailable} onChange={(event) => {
          if (!current()) return
          setClipId(event.currentTarget.value); setResourceId('')
        }}><option value="">Choose clip</option>{clips.map((clip) => <option key={clip.clipIndex} value={`clip:${clip.clipIndex}`} disabled={!clip.available}>
          {`${replaceControlCharacters(clip.name, ' ').trim().slice(0, 72) || 'Unnamed'} · ${clip.clipIndex + 1}${clip.available ? '' : ' · Unavailable'}`}
        </option>)}</select>
      </label> : null}
      {resources.length > 0 ? <label className="worlds-property-row"><span>Resource</span>
        <select aria-label="Animation resource" value={resourceId} disabled={unavailable} onChange={(event) => {
          if (!current()) return
          setResourceId(event.currentTarget.value); setClipId('')
        }}><option value="">Choose animation</option>{resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name.slice(0, 72)} · {resource.id}</option>)}</select>
      </label> : null}
      <div className="worlds-component-buttons">
        <Tooltip content="Create a shared animation resource without adding a player."><button type="button" className="worlds-button worlds-authoring-action" aria-label="Create animation" disabled={unavailable || selection?.kind !== 'clip'} onClick={() => { void commit('create') }}>Create</button></Tooltip>
        {player ? <Tooltip content="Assign this animation while preserving player settings."><button type="button" className="worlds-button worlds-authoring-action" aria-label="Assign animation" disabled={unavailable || !selection || (selection.kind === 'resource' && selection.resourceId === player.resourceId)} onClick={() => { void commit('rebind') }}>Assign</button></Tooltip>
          : <Tooltip content={selection?.kind === 'resource' ? 'Add a player for this shared animation.' : 'Create the animation and add its player together.'}><button type="button" className="worlds-button worlds-authoring-action" aria-label={selection?.kind === 'resource' ? 'Add Animation Player' : 'Create animation and add player'} disabled={unavailable || !selection} onClick={() => { void commit('add') }}>{selection?.kind === 'resource' ? 'Add player' : 'Create + Add'}</button></Tooltip>}
      </div>
    </> : <p className="worlds-empty-copy">Select an enabled GLB or GLTF model.</p>}
  </InspectorSection>
}

/** Cache borrower: no cached scene, geometry, material or clip is disposed or evicted here. */
const BorrowedGltfClipCatalog = lazy(async () => {
  const { useGLTF } = await import('@react-three/drei/core/Gltf.js')
  function Catalog({ url, onLoaded }: { url: string; onLoaded(clips: WorldGltfClipDescriptor[]): void }): null {
    const gltf = useGLTF(url)
    useEffect(() => { onLoaded(describeWorldGltfAnimationClips(gltf.animations)) }, [gltf.animations, onLoaded])
    return null
  }
  return { default: Catalog }
})

class GltfClipCatalogBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  render(): ReactNode { return this.state.failed ? <p role="alert" className="worlds-inline-error">Clips could not load</p> : this.props.children }
}

function AuthoringButton({ label, disabled, onClick }: { label: string; disabled: boolean; onClick(): void }): JSX.Element {
  return (
    <Tooltip content={`Add ${label}`}>
      <button type="button" className="worlds-button worlds-authoring-action" aria-label={`Add ${label}`} disabled={disabled} onClick={onClick}>{label}</button>
    </Tooltip>
  )
}

function CharacterPresetEditor({ snapshot, disabled, onAdd }: {
  snapshot: WorldProjectSnapshotV1
  disabled: boolean
  onAdd(inputs: WorldCharacterPresetInputs): void
}): JSX.Element {
  const [move, setMove] = useState('')
  const [jump, setJump] = useState('')
  return <details className="worlds-input-action">
    <summary>Character</summary>
    <SelectField label="Move input" value={move} disabled={disabled} options={[
      { value: '', label: 'New WASD input' },
      ...snapshot.project.inputActions.filter((action) => action.valueType === 'axis2d').map((action) => ({ value: action.id, label: action.name })),
    ]} onCommit={setMove} />
    <SelectField label="Jump input" value={jump} disabled={disabled} options={[
      { value: '', label: 'New Space input' }, { value: 'none', label: 'None' },
      ...snapshot.project.inputActions.filter((action) => action.valueType === 'button').map((action) => ({ value: `existing:${action.id}`, label: action.name })),
    ]} onCommit={setJump} />
    <AuthoringButton label="Character" disabled={disabled} onClick={() => onAdd({
      ...(move ? { moveActionId: move } : {}),
      ...(jump ? { jumpActionId: jump === 'none' ? null : jump.slice('existing:'.length) } : {}),
    })} />
  </details>
}

function TransformRow({
  label,
  unit,
  transform,
  disabled,
  onBegin,
  onCancel,
  onCommit,
}: {
  label: string
  unit: string
  transform: [number, number, number]
  disabled: boolean
  onBegin(): WorldEditorTransformGesture | null
  onCancel(gesture: WorldEditorTransformGesture): void
  onCommit(axis: 0 | 1 | 2, value: number, gesture: WorldEditorTransformGesture | null): boolean | Promise<boolean | void> | void
}): JSX.Element {
  return (
    <fieldset className="worlds-vector-field" disabled={disabled}>
      <legend>{label} <span>{unit}</span></legend>
      {(['X', 'Y', 'Z'] as const).map((axis, index) => (
        <NumericCommitField key={axis} label={axis} value={transform[index]} step={0.1} compact onBegin={onBegin} onCancel={onCancel} onCommit={(value, gesture) => onCommit(index as 0 | 1 | 2, value, gesture)} />
      ))}
    </fieldset>
  )
}

function ComponentAuthoringFields({
  snapshot,
  scene,
  entityId,
  component,
  disabled,
  onCommit,
  onBehavior,
  onError,
}: {
  snapshot: WorldProjectSnapshotV1
  scene: WorldSceneDocumentV1
  entityId: string
  component: WorldComponent
  disabled: boolean
  onCommit(property: string, value: unknown): InspectorCommitResult
  onBehavior(component: WorldBehaviorComponent): void
  onError(message: string): void
}): JSX.Element | null {
  if (component.type === 'collider') {
    const referencedByTrigger = scene.entities.some((entity) => entity.components.some((candidate) => candidate.type === 'trigger' && candidate.colliderComponentId === component.id))
    const requiredByCharacter = scene.entities.some((entity) => entity.components.some((candidate) => candidate.type === 'character-controller' && candidate.enabled && candidate.colliderComponentId === component.id))
    if (component.shape !== 'box' && component.shape !== 'sphere' && component.shape !== 'capsule' && component.shape !== 'convex' && component.shape !== 'mesh') {
      return <>
        <p className="worlds-empty-copy">Legacy collider · view only</p>
      </>
    }
    const sourceOptions = getEligibleWorldColliderSourceResources(snapshot).map((resource) => ({ value: resource.id, label: `${resource.name} · ${resource.format.toUpperCase()}` }))
    return <>
      <SelectField label="Shape" value={component.shape} disabled={disabled} options={[
        { value: 'box', label: 'Box' },
        { value: 'sphere', label: 'Sphere' },
        { value: 'capsule', label: 'Capsule' },
        { value: 'convex', label: 'Convex hull' },
        { value: 'mesh', label: 'Static mesh' },
      ]} onCommit={(value) => onCommit('shape', value)} />
      <ToggleField label="Enabled" value={component.enabled} disabled={disabled || requiredByCharacter} onCommit={(value) => onCommit('enabled', value)} />
      <ToggleField label="Sensor" value={component.sensor} disabled={disabled || referencedByTrigger || requiredByCharacter} onCommit={(value) => onCommit('sensor', value)} />
      {component.shape === 'box' ? <VectorCommitField label="Half extents" unit="m" value={component.halfExtents} min={0.001} disabled={disabled} onCommit={(value) => onCommit('halfExtents', value)} /> : component.shape === 'sphere' ? (
        <NumericCommitField label="Radius" unit="m" value={component.radius} min={0.001} step={0.05} disabled={disabled} onCommit={(value) => onCommit('radius', value)} />
      ) : component.shape === 'capsule' ? <>
        <NumericCommitField label="Radius" unit="m" value={component.radius} min={0.001} step={0.05} disabled={disabled} onCommit={(value) => onCommit('radius', value)} />
        <NumericCommitField label="Half height" unit="m" value={component.halfHeight} min={0.001} step={0.05} disabled={disabled} onCommit={(value) => onCommit('halfHeight', value)} />
      </> : (
        <SelectField
          label="Geometry source"
          value={component.resourceId}
          disabled={disabled}
          options={sourceOptions}
          onCommit={(value) => onCommit('resourceId', value)}
        />
      )}
      <NumericCommitField label="Friction" value={component.friction} min={0} step={0.01} disabled={disabled} onCommit={(value) => onCommit('friction', value)} />
      <NumericCommitField label="Restitution" value={component.restitution} min={0} max={1} step={0.01} disabled={disabled} onCommit={(value) => onCommit('restitution', value)} />
      <NumericCommitField label="Layer" value={component.collisionLayer ?? 1} min={0} max={0xffff} step={1} disabled={disabled} onCommit={(value) => onCommit('collisionLayer', Math.round(value))} />
      <NumericCommitField label="Mask" value={component.collisionMask ?? 0xffff} min={0} max={0xffff} step={1} disabled={disabled} onCommit={(value) => onCommit('collisionMask', Math.round(value))} />
    </>
  }
  if (component.type === 'rigid-body') {
    const requiredByCharacter = scene.entities.find((entity) => entity.id === entityId)?.components.some((candidate) => candidate.type === 'character-controller' && candidate.enabled) ?? false
    return <>
      <ToggleField label="Enabled" value={component.enabled} disabled={disabled || requiredByCharacter} onCommit={(value) => onCommit('enabled', value)} />
      <SelectField label="Type" value={component.bodyType} disabled={disabled || requiredByCharacter} options={[
        { value: 'fixed', label: 'Fixed' }, { value: 'dynamic', label: 'Dynamic' },
        { value: 'kinematic-position', label: 'Kinematic position' }, { value: 'kinematic-velocity', label: 'Kinematic velocity' },
      ]} onCommit={(value) => onCommit('bodyType', value)} />
      {requiredByCharacter ? <p className="worlds-empty-copy">Disable Character to change body type.</p> : null}
      {component.bodyType === 'dynamic' ? <>
        <NumericCommitField label="Gravity" unit="×" value={component.gravityScale} step={0.1} disabled={disabled} onCommit={(value) => onCommit('gravityScale', value)} />
        <NumericCommitField label="Linear damping" value={component.linearDamping} min={0} step={0.01} disabled={disabled} onCommit={(value) => onCommit('linearDamping', value)} />
        <NumericCommitField label="Angular damping" value={component.angularDamping} min={0} step={0.01} disabled={disabled} onCommit={(value) => onCommit('angularDamping', value)} />
        <ToggleField label="Can sleep" value={component.canSleep} disabled={disabled} onCommit={(value) => onCommit('canSleep', value)} />
      </> : null}
    </>
  }
  if (component.type === 'character-controller') {
    const colliders = scene.entities.find((entity) => entity.id === entityId)?.components.filter((candidate): candidate is Extract<WorldComponent, { type: 'collider' }> => (
      candidate.type === 'collider' && candidate.enabled && candidate.purpose === 'simulation' && !candidate.sensor
    )) ?? []
    return <>
      <ToggleField label="Enabled" value={component.enabled} disabled={disabled} onCommit={(value) => onCommit('enabled', value)} />
      <SelectField label="Collider" value={component.colliderComponentId} disabled={disabled} options={colliders.map((collider, index) => ({ value: collider.id, label: `${colliderShapeLabel(collider)} ${index + 1}` }))} onCommit={(value) => onCommit('colliderComponentId', value)} />
      <SelectField label="Move input" value={component.moveActionId} disabled={disabled} options={snapshot.project.inputActions.filter((action) => action.valueType === 'axis2d').map((action) => ({ value: action.id, label: action.name }))} onCommit={(value) => onCommit('moveActionId', value)} />
      <SelectField label="Jump input" value={component.jumpActionId ?? ''} disabled={disabled} options={[
        { value: '', label: 'None' },
        ...snapshot.project.inputActions.filter((action) => action.valueType === 'button').map((action) => ({ value: action.id, label: action.name })),
      ]} onCommit={(value) => onCommit('jumpActionId', value || null)} />
      <NumericCommitField label="Speed" unit="m/s" value={component.speed} min={0} step={0.1} disabled={disabled} onCommit={(value) => onCommit('speed', value)} />
      <NumericCommitField label="Jump speed" unit="m/s" value={component.jumpSpeed} min={0} step={0.1} disabled={disabled} onCommit={(value) => onCommit('jumpSpeed', value)} />
      <NumericCommitField label="Max slope" unit="°" value={component.maxSlopeDegrees} min={0} max={90} step={1} disabled={disabled} onCommit={(value) => onCommit('maxSlopeDegrees', value)} />
    </>
  }
  if (component.type === 'audio-listener') {
    return <ToggleField label="Enabled" value={component.enabled} disabled={disabled} onCommit={(value) => onCommit('enabled', value)} />
  }
  if (component.type === 'animation-player') {
    const resource = snapshot.project.resources.find((candidate) => candidate.id === component.resourceId)
    return <>
      <ToggleField label="Enabled" value={component.enabled} disabled={disabled} onCommit={(value) => onCommit('enabled', value)} />
      <div className="worlds-property-row"><span>Animation</span><code>{resource?.name ?? component.resourceId}</code></div>
      <ToggleField label="Autoplay" value={component.autoplay} disabled={disabled} onCommit={(value) => onCommit('autoplay', value)} />
      <ToggleField label="Loop" value={component.loop} disabled={disabled} onCommit={(value) => onCommit('loop', value)} />
      <NumericCommitField label="Speed" unit="×" value={component.speed} step={0.1} disabled={disabled} onCommit={(value) => onCommit('speed', value)} />
    </>
  }
  if (component.type === 'audio-source') {
    const resource = snapshot.project.resources.find((candidate) => candidate.id === component.resourceId)
    return <>
      <ToggleField label="Enabled" value={component.enabled} disabled={disabled} onCommit={(value) => onCommit('enabled', value)} />
      <div className="worlds-property-row"><span>Audio</span><code>{resource?.name ?? component.resourceId}</code></div>
      <ToggleField label="Autoplay" value={component.autoplay} disabled={disabled} onCommit={(value) => onCommit('autoplay', value)} />
      <ToggleField label="Loop" value={component.loop} disabled={disabled} onCommit={(value) => onCommit('loop', value)} />
      <NumericCommitField label="Volume" value={component.volume} min={0} max={1} step={0.01} disabled={disabled} onCommit={(value) => onCommit('volume', value)} />
      <ToggleField label="Spatial" value={component.spatial} disabled={disabled} onCommit={(value) => onCommit('spatial', value)} />
      {component.spatial ? <NumericCommitField label="Max distance" unit="m" value={component.maxDistance} min={0.01} step={0.1} disabled={disabled} onCommit={(value) => onCommit('maxDistance', value)} /> : null}
    </>
  }
  if (component.type === 'trigger') {
    const entity = scene.entities.find((candidate) => candidate.id === entityId)
    const sensors = entity?.components.filter((candidate): candidate is Extract<WorldComponent, { type: 'collider' }> => (
      candidate.type === 'collider' && candidate.enabled && candidate.purpose === 'simulation' && candidate.sensor
    )) ?? []
    return <>
      <ToggleField label="Enabled" value={component.enabled} disabled={disabled} onCommit={(value) => onCommit('enabled', value)} />
      <SelectField label="Collider" value={component.colliderComponentId} disabled={disabled} options={sensors.map((sensor, index) => ({ value: sensor.id, label: `${colliderShapeLabel(sensor)} sensor ${index + 1}` }))} onCommit={(value) => onCommit('colliderComponentId', value)} />
      <ToggleField label="Once" value={component.once} disabled={disabled} onCommit={(value) => onCommit('once', value)} />
      <TextCommitField label="Tags" value={component.targetTags.join(', ')} disabled={disabled} onCommit={(value) => onCommit('targetTags', [...new Set(value.split(',').map((tag) => tag.trim()).filter(Boolean))])} />
    </>
  }
  if (component.type === 'behavior') {
    return <BehaviorEditor snapshot={snapshot} scene={scene} component={component} disabled={disabled} onCommit={onBehavior} onError={onError} />
  }
  return null
}

function ToggleField({ label, value, disabled, onCommit }: { label: string; value: boolean; disabled: boolean; onCommit(value: boolean): void }): JSX.Element {
  return <label className="worlds-property-row"><span>{label}</span><input type="checkbox" checked={value} disabled={disabled} onChange={(event) => onCommit(event.currentTarget.checked)} /></label>
}

function SelectField({
  label, value, options, disabled, onCommit,
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  disabled: boolean
  onCommit(value: string): void
}): JSX.Element {
  return <label className="worlds-property-row"><span>{label}</span><select value={value} disabled={disabled || options.length === 0} onChange={(event) => onCommit(event.currentTarget.value)}>
    {!options.some((option) => option.value === value) ? <option value={value} disabled>Unavailable selection</option> : null}
    {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select></label>
}

function VectorCommitField({
  label, unit, value, min, disabled, onCommit,
}: {
  label: string
  unit?: string
  value: [number, number, number]
  min?: number
  disabled: boolean
  onCommit(value: [number, number, number]): InspectorCommitResult
}): JSX.Element {
  return (
    <fieldset className="worlds-vector-field" disabled={disabled}>
      <legend>{label}{unit ? <span>{unit}</span> : null}</legend>
      {(['X', 'Y', 'Z'] as const).map((axis, index) => (
        <NumericCommitField key={axis} label={axis} value={value[index]} min={min} step={0.1} compact onCommit={(next) => {
          const result = [...value] as [number, number, number]
          result[index] = next
          return onCommit(result)
        }} />
      ))}
    </fieldset>
  )
}

function ProjectInputsEditor({
  snapshot,
  onCommands,
  onError,
}: {
  snapshot: WorldProjectSnapshotV1
  onCommands(commands: WorldCommand[], scope: string): void
  onError(message: string): void
}): JSX.Element {
  const [newName, setNewName] = useState('Action')
  const [newControl, setNewControl] = useState('Space')
  const actions = snapshot.project.inputActions.filter((action) => action.valueType === 'button' || action.valueType === 'axis2d')
  const run = (factory: () => WorldCommand[], scope: string) => {
    try { onCommands(factory(), scope) } catch (error) { onError(error instanceof Error ? error.message : 'Input action is invalid.') }
  }
  return (
    <InspectorSection heading="Project inputs">
      <div className="worlds-input-actions">
        {actions.map((action) => {
          return (
            <fieldset key={action.id} className="worlds-input-action">
              <legend>{action.name} · {action.valueType === 'axis2d' ? '2D axis' : 'Button'}</legend>
              <TextCommitField label="Name" value={action.name} disabled={false} onCommit={(name) => run(
                () => buildRenameInputActionCommands(snapshot, action.id, name), 'input-rename',
              )} />
              {action.bindings.map((binding, index) => <InputBindingEditor key={index} binding={binding} index={index} onCommit={(next) => run(
                () => buildUpdateInputBindingCommands(snapshot, action.id, index, next), 'input-binding',
              )} />)}
              <Tooltip content={`Remove ${action.name}`}>
                <button type="button" className="worlds-button worlds-authoring-action" aria-label={`Remove input ${action.name}`} onClick={() => run(() => buildRemoveInputActionCommands(snapshot, action.id), 'input-remove')}>Remove</button>
              </Tooltip>
            </fieldset>
          )
        })}
        <div className="worlds-input-action is-new">
          <label className="worlds-property-row"><span>Name</span><input value={newName} onChange={(event) => setNewName(event.currentTarget.value)} /></label>
          <label className="worlds-property-row"><span>Keyboard code</span><input value={newControl} placeholder="Space or KeyN" onChange={(event) => setNewControl(event.currentTarget.value)} /></label>
          <Tooltip content="Add button input">
            <button type="button" className="worlds-button worlds-authoring-action" aria-label="Add button input" onClick={() => run(() => buildAddButtonInputActionCommands(
              snapshot,
              createDeterministicWorldEditorIdentityGenerator(createWorldUiTransactionId('input-add')),
              { name: newName, control: newControl },
            ), 'input-add')}>Add input</button>
          </Tooltip>
          <Tooltip content="Add 2D axis with WASD bindings">
            <button type="button" className="worlds-button worlds-authoring-action" aria-label="Add axis2d input" onClick={() => run(() => buildAddAxis2dInputActionCommands(
              snapshot,
              createDeterministicWorldEditorIdentityGenerator(createWorldUiTransactionId('axis-input-add')),
              { name: newName },
            ), 'axis-input-add')}>Add 2D axis</button>
          </Tooltip>
        </div>
      </div>
    </InspectorSection>
  )
}

function InputBindingEditor({ binding, index, onCommit }: {
  binding: WorldInputBinding
  index: number
  onCommit(binding: WorldInputBinding): void
}): JSX.Element {
  return <fieldset className="worlds-input-action">
    <legend>Binding {index + 1} · {binding.device}</legend>
    <TextCommitField label={binding.device === 'keyboard' ? 'Keyboard code' : 'Control'} value={binding.control} disabled={false}
      onCommit={(control) => onCommit({ ...binding, control })} />
    {binding.kind === 'axis2d' ? <>
      <SelectField label="Target axis" value={binding.targetAxis} disabled={false} options={[{ value: 'x', label: 'X · right' }, { value: 'y', label: 'Y · forward' }]} onCommit={(value) => {
        if (value === 'x' || value === 'y') onCommit({ ...binding, targetAxis: value })
      }} />
      <NumericCommitField label="Scale" value={binding.scale ?? 1} step={1} onCommit={(scale) => onCommit({ ...binding, scale })} />
    </> : null}
  </fieldset>
}

function BehaviorEditor({
  snapshot,
  scene,
  component,
  disabled,
  onCommit,
  onError,
}: {
  snapshot: WorldProjectSnapshotV1
  scene: WorldSceneDocumentV1
  component: WorldBehaviorComponent
  disabled: boolean
  onCommit(component: WorldBehaviorComponent): void
  onError(message: string): void
}): JSX.Element {
  const eventTypes = getCompatibleWorldBehaviorEventTypes(snapshot, scene.sceneId)
  const actionTypes = getCompatibleWorldBehaviorActionTypes(snapshot, scene.sceneId).filter((type) => type !== 'play-animation')
  const replaceBinding = (index: number, binding: WorldBehaviorBinding) => {
    const bindings = component.bindings.map((candidate, candidateIndex) => candidateIndex === index ? binding : structuredClone(candidate))
    onCommit({ ...structuredClone(component), bindings })
  }
  const removeBinding = (index: number) => onCommit({ ...structuredClone(component), bindings: component.bindings.filter((_, candidateIndex) => candidateIndex !== index).map((binding) => structuredClone(binding)) })
  const moveBinding = (from: number, to: number) => {
    if (to < 0 || to >= component.bindings.length) return
    const bindings = component.bindings.map((binding) => structuredClone(binding))
    const [binding] = bindings.splice(from, 1)
    if (!binding) return
    bindings.splice(to, 0, binding)
    onCommit({ ...structuredClone(component), bindings })
  }
  const addBinding = () => {
    const type = eventTypes[0]
    if (!type) return onError('Add a compatible input or trigger first.')
    const used = new Set(component.bindings.map((binding) => binding.id))
    const identities = createDeterministicWorldEditorIdentityGenerator(createWorldUiTransactionId('behavior-binding'))
    let id = identities.nextId('binding', `${component.id}:${component.bindings.length}`)
    for (let attempt = 0; used.has(id) && attempt < 128; attempt += 1) id = identities.nextId('binding', `${component.id}:${attempt}`)
    if (used.has(id)) return onError('Behavior binding identity could not be allocated.')
    const binding: WorldBehaviorBinding = { id, event: createCompatibleWorldBehaviorEvent(snapshot, scene.sceneId, type), actions: [] }
    onCommit({ ...structuredClone(component), bindings: [...component.bindings.map((candidate) => structuredClone(candidate)), binding] })
  }
  return <>
    <ToggleField label="Enabled" value={component.enabled} disabled={disabled} onCommit={(enabled) => onCommit({ ...structuredClone(component), enabled })} />
    <div className="worlds-behavior-bindings">
      {component.bindings.map((binding, index) => (
        <div
          key={binding.id}
          className="worlds-behavior-binding"
          tabIndex={disabled ? -1 : 0}
          aria-label={`Behavior binding ${index + 1}`}
          onKeyDown={(event) => {
            if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
            event.preventDefault()
            moveBinding(index, index + (event.key === 'ArrowUp' ? -1 : 1))
          }}
        >
          <span className="sr-only">Alt+ArrowUp / Alt+ArrowDown reorders this binding.</span>
          <div className="worlds-behavior-binding__bar">
            <strong>Rule {index + 1}</strong>
            <button type="button" className="worlds-authoring-action" aria-label={`Move rule ${index + 1} up`} disabled={disabled || index === 0} onClick={() => moveBinding(index, index - 1)}>↑</button>
            <button type="button" className="worlds-authoring-action" aria-label={`Move rule ${index + 1} down`} disabled={disabled || index === component.bindings.length - 1} onClick={() => moveBinding(index, index + 1)}>↓</button>
            <button type="button" className="worlds-authoring-action" aria-label={`Remove rule ${index + 1}`} disabled={disabled} onClick={() => removeBinding(index)}>×</button>
          </div>
          <BehaviorEventEditor
            snapshot={snapshot}
            scene={scene}
            event={binding.event}
            eventTypes={eventTypes}
            disabled={disabled}
            onCommit={(nextEvent) => replaceBinding(index, { ...structuredClone(binding), event: nextEvent })}
          />
          <div className="worlds-behavior-actions">
            {binding.actions.map((action, actionIndex) => (
              <BehaviorActionEditor
                key={`${binding.id}:${actionIndex}`}
                snapshot={snapshot}
                scene={scene}
                action={action}
                actionTypes={actionTypes}
                disabled={disabled}
                onCommit={(nextAction) => replaceBinding(index, {
                  ...structuredClone(binding),
                  actions: binding.actions.map((candidate, candidateIndex) => candidateIndex === actionIndex ? nextAction : structuredClone(candidate)),
                })}
                onRemove={() => replaceBinding(index, {
                  ...structuredClone(binding), actions: binding.actions.filter((_, candidateIndex) => candidateIndex !== actionIndex).map((candidate) => structuredClone(candidate)),
                })}
              />
            ))}
            {actionTypes.length > 0 ? (
              <button type="button" className="worlds-button worlds-authoring-action" aria-label="Add action" disabled={disabled} onClick={() => replaceBinding(index, {
                ...structuredClone(binding),
                actions: [...binding.actions.map((candidate) => structuredClone(candidate)), createCompatibleWorldBehaviorAction(snapshot, scene.sceneId, actionTypes[0]!)],
              })}>Add action</button>
            ) : <p className="worlds-empty-copy">Add a compatible target first.</p>}
          </div>
        </div>
      ))}
      <button type="button" className="worlds-button worlds-authoring-action" aria-label="Add rule" disabled={disabled} onClick={addBinding}>Add rule</button>
    </div>
  </>
}

function BehaviorEventEditor({
  snapshot, scene, event, eventTypes, disabled, onCommit,
}: {
  snapshot: WorldProjectSnapshotV1
  scene: WorldSceneDocumentV1
  event: WorldBehaviorBinding['event']
  eventTypes: WorldBehaviorAuthoringEventType[]
  disabled: boolean
  onCommit(event: WorldBehaviorBinding['event']): void
}): JSX.Element {
  return <div className="worlds-behavior-editor">
    <SelectField label="Event" value={event.type} disabled={disabled} options={eventTypes.map((type) => ({ value: type, label: behaviorEventLabel(type) }))} onCommit={(value) => onCommit(createCompatibleWorldBehaviorEvent(snapshot, scene.sceneId, value as WorldBehaviorAuthoringEventType))} />
    {event.type === 'input' ? <>
      <SelectField label="Input" value={event.actionId} disabled={disabled} options={snapshot.project.inputActions.filter((action) => action.valueType === 'button').map((action) => ({ value: action.id, label: action.name }))} onCommit={(actionId) => onCommit({ ...event, actionId })} />
      <SelectField label="Phase" value={event.phase} disabled={disabled} options={[
        { value: 'pressed', label: 'Pressed' }, { value: 'released', label: 'Released' }, { value: 'held', label: 'Held' },
      ]} onCommit={(phase) => onCommit({ ...event, phase: phase as 'pressed' | 'released' | 'held' })} />
    </> : null}
    {event.type === 'trigger-enter' || event.type === 'trigger-exit' ? (
      <SelectField label="Trigger" value={event.triggerComponentId} disabled={disabled} options={compatibleTriggers(scene).map((target) => ({ value: target.componentId, label: target.label }))} onCommit={(triggerComponentId) => onCommit({ ...event, triggerComponentId })} />
    ) : null}
    {event.type === 'timer' ? <>
      <NumericCommitField label="Delay" unit="s" value={event.delaySeconds} min={0} step={0.1} disabled={disabled} onCommit={(delaySeconds) => onCommit({ ...event, delaySeconds })} />
      <ToggleField label="Repeat" value={event.repeat} disabled={disabled} onCommit={(repeat) => onCommit({ ...event, repeat })} />
    </> : null}
  </div>
}

function BehaviorActionEditor({
  snapshot, scene, action, actionTypes, disabled, onCommit, onRemove,
}: {
  snapshot: WorldProjectSnapshotV1
  scene: WorldSceneDocumentV1
  action: WorldBehaviorAction
  actionTypes: WorldBehaviorAuthoringActionType[]
  disabled: boolean
  onCommit(action: WorldBehaviorAction): void
  onRemove(): void
}): JSX.Element {
  if (action.type === 'play-animation') {
    return <div className="worlds-behavior-action"><span>Legacy animation action · view only</span><button type="button" className="worlds-authoring-action" disabled={disabled} onClick={onRemove}>Remove</button></div>
  }
  const audioSources = compatibleAudioSources(scene)
  const dynamicBodies = compatibleDynamicBodies(scene)
  const propertyTargets = getWorldLivePropertyTargets(snapshot, scene.sceneId)
  return <div className="worlds-behavior-action">
    <div className="worlds-behavior-action__bar">
      <SelectField label="Action" value={action.type} disabled={disabled} options={actionTypes.map((type) => ({ value: type, label: behaviorActionLabel(type) }))} onCommit={(value) => onCommit(createCompatibleWorldBehaviorAction(snapshot, scene.sceneId, value as WorldBehaviorAuthoringActionType))} />
      <button type="button" className="worlds-authoring-action" aria-label="Remove action" disabled={disabled} onClick={onRemove}>×</button>
    </div>
    {action.type === 'set-visibility' ? <>
      <SelectField label="Target" value={action.entityId} disabled={disabled} options={scene.entities.filter((entity) => entity.components.some((component) => component.type === 'renderable')).map((entity) => ({ value: entity.id, label: entity.name }))} onCommit={(entityId) => onCommit({ ...action, entityId })} />
      <ToggleField label="Visible" value={action.visible} disabled={disabled} onCommit={(visible) => onCommit({ ...action, visible })} />
    </> : null}
    {action.type === 'set-component-property' ? <>
      <SelectField label="Property" value={`${action.componentId}:${action.property}`} disabled={disabled} options={propertyTargets.map((target) => ({ value: `${target.componentId}:${target.property}`, label: `${target.entityName} · ${target.componentLabel} · ${target.property}` }))} onCommit={(key) => {
        const target = propertyTargets.find((candidate) => `${candidate.componentId}:${candidate.property}` === key)
        if (target) onCommit({ type: 'set-component-property', entityId: target.entityId, componentId: target.componentId, componentType: target.componentType, property: target.property, value: structuredClone(target.value) })
      }} />
      <BehaviorPropertyValueEditor action={action} disabled={disabled} onCommit={onCommit} />
    </> : null}
    {action.type === 'play-audio' || action.type === 'stop-audio' ? (
      <SelectField label="Source" value={action.componentId} disabled={disabled} options={audioSources.map((target) => ({ value: target.componentId, label: target.label }))} onCommit={(componentId) => {
        const target = audioSources.find((candidate) => candidate.componentId === componentId)
        if (target) onCommit({ ...action, entityId: target.entityId, componentId })
      }} />
    ) : null}
    {action.type === 'apply-impulse' ? <>
      <SelectField label="Target" value={action.entityId} disabled={disabled} options={dynamicBodies.map((target) => ({ value: target.entityId, label: target.label }))} onCommit={(entityId) => onCommit({ ...action, entityId })} />
      <VectorCommitField label="Impulse" value={action.impulse} disabled={disabled} onCommit={(impulse) => onCommit({ ...action, impulse })} />
    </> : null}
    {action.type === 'change-scene' ? <SelectField label="Scene" value={action.sceneId} disabled={disabled} options={snapshot.project.scenes.map((candidate) => ({ value: candidate.id, label: candidate.name }))} onCommit={(sceneId) => onCommit({ ...action, sceneId })} /> : null}
  </div>
}

function BehaviorPropertyValueEditor({ action, disabled, onCommit }: { action: Extract<WorldBehaviorAction, { type: 'set-component-property' }>; disabled: boolean; onCommit(action: WorldBehaviorAction): void }): JSX.Element {
  if (typeof action.value === 'boolean') return <ToggleField label="Value" value={action.value} disabled={disabled} onCommit={(value) => onCommit({ ...action, value })} />
  if (typeof action.value === 'number') return <NumericCommitField label="Value" value={action.value} disabled={disabled} onCommit={(value) => onCommit({ ...action, value })} />
  if (Array.isArray(action.value)) return <VectorCommitField label="Value" value={action.value} disabled={disabled} onCommit={(value) => onCommit({ ...action, value })} />
  if (/^#[0-9a-f]{6}$/i.test(action.value)) return <ColorCommitField label="Value" value={action.value} disabled={disabled} onCommit={(value) => onCommit({ ...action, value })} />
  return <TextCommitField label="Value" value={action.value} disabled={disabled} onCommit={(value) => onCommit({ ...action, value })} />
}

function compatibleTriggers(scene: WorldSceneDocumentV1): Array<{ componentId: string; label: string }> {
  return scene.entities.flatMap((entity) => entity.enabled ? entity.components.flatMap((component) => {
    if (component.type !== 'trigger' || !component.enabled) return []
    const sensor = entity.components.find((candidate) => candidate.id === component.colliderComponentId)
    return sensor?.type === 'collider' && sensor.enabled && sensor.purpose === 'simulation' && sensor.sensor
      ? [{ componentId: component.id, label: `${entity.name} · Trigger` }]
      : []
  }) : [])
}

function compatibleAudioSources(scene: WorldSceneDocumentV1): Array<{ entityId: string; componentId: string; label: string }> {
  return scene.entities.flatMap((entity) => entity.enabled ? entity.components.flatMap((component, index) => component.type === 'audio-source' && component.enabled
    ? [{ entityId: entity.id, componentId: component.id, label: `${entity.name} · Audio ${index + 1}` }]
    : []) : [])
}

function compatibleDynamicBodies(scene: WorldSceneDocumentV1): Array<{ entityId: string; label: string }> {
  return scene.entities.filter((entity) => entity.enabled && entity.components.some((component) => component.type === 'rigid-body' && component.enabled && component.bodyType === 'dynamic'))
    .map((entity) => ({ entityId: entity.id, label: entity.name }))
}

function colliderShapeLabel(collider: Extract<WorldComponent, { type: 'collider' }>): string {
  if (collider.shape === 'box') return 'Box'
  if (collider.shape === 'sphere') return 'Sphere'
  if (collider.shape === 'capsule') return 'Capsule'
  if (collider.shape === 'convex') return 'Convex hull'
  if (collider.shape === 'mesh') return 'Static mesh'
  return 'Legacy collider'
}

function behaviorEventLabel(type: WorldBehaviorAuthoringEventType): string {
  if (type === 'trigger-enter') return 'Trigger enter'
  if (type === 'trigger-exit') return 'Trigger exit'
  return type === 'input' ? 'Input' : type === 'timer' ? 'Timer' : 'Start'
}

function behaviorActionLabel(type: WorldBehaviorAuthoringActionType): string {
  if (type === 'set-visibility') return 'Visibility'
  if (type === 'set-component-property') return 'Property'
  if (type === 'play-audio') return 'Play audio'
  if (type === 'stop-audio') return 'Stop audio'
  if (type === 'apply-impulse') return 'Apply impulse'
  if (type === 'change-scene') return 'Change scene'
  return 'Animation'
}

function ComponentField({
  component,
  field,
  disabled,
  onCommit,
}: {
  component: WorldComponent
  field: WorldInspectorFieldDescriptor
  disabled: boolean
  onCommit(value: unknown): InspectorCommitResult
}): JSX.Element {
  const value = readComponentProperty(component, field.property)
  if (field.control === 'toggle') {
    return <label className="worlds-property-row"><span>{field.label}</span><input type="checkbox" checked={value === true} disabled={disabled} onChange={(event) => onCommit(event.currentTarget.checked)} /></label>
  }
  if (field.control === 'select' && field.options) {
    return (
      <label className="worlds-property-row"><span>{field.label}</span>
        <select value={String(value ?? '')} disabled={disabled} onChange={(event) => onCommit(coerceOption(event.currentTarget.value, field))}>
          {field.options.map((option) => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}
        </select>
      </label>
    )
  }
  if (field.control === 'color' && typeof value === 'string') {
    return <ColorCommitField label={field.label} value={value} disabled={disabled} onCommit={onCommit} />
  }
  if (field.control === 'number' && typeof value === 'number') {
    return <NumericCommitField label={field.label} unit={formatUnit(field.unit)} value={value} min={field.min} max={field.max} step={field.step} disabled={disabled} onCommit={onCommit} />
  }
  return <div className="worlds-property-row"><span>{field.label}</span><code>{String(value ?? '—')}</code></div>
}

function NumericCommitField({
  label,
  unit,
  value,
  min,
  max,
  step,
  disabled = false,
  compact = false,
  onBegin,
  onCancel,
  onCommit,
}: {
  label: string
  unit?: string
  value: number
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  compact?: boolean
  onBegin?: () => WorldEditorTransformGesture | null
  onCancel?: (gesture: WorldEditorTransformGesture) => void
  onCommit(value: number, gesture: WorldEditorTransformGesture | null): boolean | Promise<boolean | void> | void
}): JSX.Element {
  const [draft, setDraft] = useState(String(roundForField(value)))
  const [error, setError] = useState<string | null>(null)
  const errorId = useId()
  const editGenerationRef = useRef(0)
  const committingRef = useRef<number | null>(null)
  const canonicalValueRef = useRef(value)
  useLayoutEffect(() => { canonicalValueRef.current = value }, [value])
  const gestureRef = useRef<WorldEditorTransformGesture | null>(null)
  const onCancelRef = useRef(onCancel)
  useEffect(() => { onCancelRef.current = onCancel }, [onCancel])
  useEffect(() => () => {
    editGenerationRef.current += 1
    if (gestureRef.current) onCancelRef.current?.(gestureRef.current)
    gestureRef.current = null
  }, [])
  useEffect(() => {
    if (committingRef.current !== null && editGenerationRef.current !== committingRef.current) return
    editGenerationRef.current += 1
    setDraft(String(roundForField(value)))
    setError(null)
  }, [value])
  const reconcile = (generation: number) => {
    if (editGenerationRef.current !== generation) return
    editGenerationRef.current += 1
    setDraft(String(roundForField(canonicalValueRef.current)))
    setError(null)
  }
  const commit = () => {
    if (committingRef.current !== null) return
    const parsed = parseWorldInspectorNumber(draft, { min, max })
    if (!parsed.success) {
      if (gestureRef.current) onCancel?.(gestureRef.current)
      gestureRef.current = null
      setError(parsed.error)
      return
    }
    setDraft(String(roundForField(parsed.value)))
    setError(null)
    if (parsed.value === value) {
      if (gestureRef.current) onCancel?.(gestureRef.current)
      gestureRef.current = null
      return
    }
    const generation = editGenerationRef.current
    committingRef.current = generation
    const gesture = gestureRef.current
    gestureRef.current = null
    Promise.resolve(onCommit(parsed.value, gesture)).then((accepted) => {
      if (accepted === false) reconcile(generation)
    }).catch(() => {
      reconcile(generation)
    }).finally(() => {
      committingRef.current = null
    })
  }
  return (
    <label className={compact ? 'worlds-number-field is-compact' : 'worlds-property-row worlds-number-field'}>
      <span>{label}{unit ? <small>{unit}</small> : null}</span>
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        step={step ?? 'any'}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onFocus={() => { if (!gestureRef.current) gestureRef.current = onBegin?.() ?? null }}
        onChange={(event) => { editGenerationRef.current += 1; setDraft(event.currentTarget.value); setError(null) }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          else if (event.key === 'Escape') {
            event.preventDefault()
            editGenerationRef.current += 1
            setDraft(String(roundForField(value)))
            setError(null)
            if (gestureRef.current) onCancel?.(gestureRef.current)
            gestureRef.current = null
          }
        }}
      />
      {error ? <small id={errorId} className="worlds-field-error">{error}</small> : null}
    </label>
  )
}

function TextCommitField({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string
  value: string
  disabled: boolean
  onCommit(value: string): void
}): JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    const next = draft.trim()
    if (next && next !== value) onCommit(next)
    else if (!next) setDraft(value)
  }
  return (
    <label className="worlds-property-row">
      <span>{label}</span>
      <input
        type="text"
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          else if (event.key === 'Escape') { event.preventDefault(); setDraft(value) }
        }}
      />
    </label>
  )
}

function ColorCommitField({ label, value, disabled = false, onCommit }: { label: string; value: string; disabled?: boolean; onCommit(value: string): void }): JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <label className="worlds-property-row worlds-color-field">
      <span>{label}</span>
      <input type="color" value={draft} disabled={disabled} onChange={(event) => setDraft(event.currentTarget.value)} onBlur={() => { if (draft !== value) onCommit(draft) }} />
      <code>{draft}</code>
    </label>
  )
}

function coerceOption(value: string, field: WorldInspectorFieldDescriptor): string | number | boolean {
  const option = field.options?.find((candidate) => String(candidate.value) === value)
  return option?.value ?? value
}

function formatUnit(unit: WorldInspectorFieldDescriptor['unit']): string | undefined {
  switch (unit) {
    case 'meters': return 'm'
    case 'degrees': return '°'
    case 'radians': return 'rad'
    case 'seconds': return 's'
    case 'multiplier': return '×'
    case 'normalized': return '0–1'
    case 'bitmask': return 'bits'
    default: return undefined
  }
}

function roundForField(value: number): number {
  return Number(value.toPrecision(8))
}

export default WorldsInspector

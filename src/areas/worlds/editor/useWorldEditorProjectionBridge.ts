import type { WorldEditorActiveContext } from './worldEditorCommandPort.ts'
import type {
  WorldEditorControllerResult,
  WorldEditorDispatchAuthority,
  WorldEditorDispatchRequest,
  WorldEditorDispatchSuccess,
} from './worldEditorController.ts'
import { projectWorldScene, type WorldSceneProjection } from './worldEditorProjection.ts'
import { buildPatchEntityTransformsCommands } from './worldEditorCommandBuilders.ts'
import type { WorldGraphicsProfile, WorldProjectSnapshotV1, WorldTransform } from '../core/worldModel.ts'
import type { WorldSceneItem } from '../worldRenderableResolver.ts'
import type { WorldCollisionSurface } from '../worldsCollisionSurfaces.ts'
import type { WorldsViewportEnvironment, WorldsViewportLight } from '../worldsViewportTypes.ts'
import { Euler, Matrix4, Quaternion, Vector3 } from 'three'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { WorldsTransformCommitMeta, WorldsTransformGestureToken, WorldsViewerProps } from '../components/WorldsViewer.tsx'
import type { WorldEditorController, WorldEditorControllerState } from './worldEditorController.ts'
import { useWorldsSceneStore } from '../worldsSceneStore.ts'
import { useWorldsUiStore } from './worldsUiStore.ts'
import { buildWorldTreeMutationCommands, isWorldEntityEffectivelyLocked } from './worldsWorkbenchModel.ts'
import { createWorldUiTransactionId } from './useWorldEditorController.ts'
import type { WorldEditorTransformAdmission, WorldEditorTransformGesture } from './worldEditorTransformAdmission.ts'
import { createWorldWorkspaceUrl } from '../worldWorkspaceUrl.ts'
import type { WorldEditorRunCollisionInput } from './worldEditorRunCollision.ts'

export { createWorldWorkspaceUrl } from '../worldWorkspaceUrl.ts'

export interface WorldEditorViewportProjection {
  canonical: WorldSceneProjection
  items: WorldSceneItem[]
  collisionSurfaces: WorldCollisionSurface[]
  environment: WorldsViewportEnvironment
  lights: WorldsViewportLight[]
  useStudioLights: boolean
  initialView: WorldSceneProjection['initialView']
  graphicsProfile: WorldGraphicsProfile
  warnings: string[]
}

export type ProjectWorldEditorViewportResult =
  | { success: true; value: WorldEditorViewportProjection }
  | { success: false; issues: { code: string; path: string; message: string }[] }

export function projectWorldEditorViewport(
  snapshot: WorldProjectSnapshotV1,
  sceneId: string,
  apiUrl: string,
): ProjectWorldEditorViewportResult {
  const projected = projectWorldScene(snapshot, sceneId, (workspacePath) => createWorldWorkspaceUrl(apiUrl, workspacePath))
  if (!projected.success) return projected
  const canonical = projected.value
  const graphicsProfile = snapshot.project.graphicsProfiles.find((profile) => profile.id === snapshot.project.activeGraphicsProfileId)
  if (!graphicsProfile) {
    return { success: false, issues: [{ code: 'graphics-profile-missing', path: 'project.activeGraphicsProfileId', message: `Active graphics profile ${snapshot.project.activeGraphicsProfileId} is unavailable.` }] }
  }
  const lights = canonical.lights
    .filter((light) => light.effectiveEnabled)
    .map((light): WorldsViewportLight => ({
      entityId: light.entityId,
      component: structuredClone(light.component),
      transform: structuredClone(light.worldTransform),
    }))
  return {
    success: true,
    value: {
      canonical,
      items: canonical.viewerItems.map((item): WorldSceneItem => ({
        id: item.entityId,
        workspacePath: item.workspacePath,
        url: item.url,
        kind: item.kind,
        role: item.role,
        visible: item.visible,
        transform: structuredClone(item.transform),
        material: structuredClone(item.material),
        castShadow: item.castShadow,
        receiveShadow: item.receiveShadow,
        ...(item.animation ? { animation: structuredClone(item.animation) } : {}),
      })),
      collisionSurfaces: canonical.editorNavigationSurfaces
        .filter((surface) => surface.effectiveEnabled)
        .map(projectNavigationSurface),
      environment: structuredClone(canonical.environment),
      lights,
      useStudioLights: lights.length === 0,
      graphicsProfile: structuredClone(graphicsProfile),
      initialView: canonical.initialView ? structuredClone(canonical.initialView) : null,
      warnings: [...canonical.warnings],
    },
  }
}

function projectNavigationSurface(surface: WorldSceneProjection['editorNavigationSurfaces'][number]): WorldCollisionSurface {
  const common = {
    id: surface.componentId,
    label: surface.componentId,
    sidedness: surface.surface.sidedness,
    transform: structuredClone(surface.worldTransform),
  }
  if (surface.surface.shape === 'rect-surface') {
    return {
      ...common,
      shape: 'rect',
      preset: surface.surface.legacyPreset ?? 'rectangle',
      geometry: { halfWidth: surface.surface.halfExtents[0], halfHeight: surface.surface.halfExtents[1] },
    }
  }
  return {
    ...common,
    shape: 'tri',
    preset: 'triangle',
    geometry: { vertices: structuredClone(surface.surface.vertices) },
  }
}

export interface CommitWorldProjectionTransformsOptions {
  context: WorldEditorActiveContext
  updates: readonly { entityId: string; transform: WorldTransform }[]
  transactionId: string
  dispatch: (
    request: WorldEditorDispatchRequest,
    authority: WorldEditorDispatchAuthority,
  ) => Promise<WorldEditorControllerResult<WorldEditorDispatchSuccess>>
  rollback: () => void
}

export async function commitWorldProjectionTransforms(
  options: CommitWorldProjectionTransformsOptions,
): Promise<WorldEditorControllerResult<WorldEditorDispatchSuccess>> {
  try {
    const commands = buildPatchEntityTransformsCommands(
      options.context.snapshot,
      options.context.activeSceneId,
      convertWorldTransformsToLocal(options.context.snapshot, options.context.activeSceneId, options.updates),
    )
    const result = await options.dispatch({
      transactionId: options.transactionId,
      origin: 'ui',
      commands,
    }, {
      projectKey: options.context.projectKey,
      projectId: options.context.projectId,
      baseRevision: options.context.baseRevision,
      activeSceneId: options.context.activeSceneId,
    })
    if (!result.ok) options.rollback()
    return result
  } catch (error) {
    options.rollback()
    return {
      ok: false,
      error: {
        code: 'invalid_command',
        message: error instanceof Error ? error.message : 'Transform could not be committed.',
        retryable: false,
      },
    }
  }
}

export function convertWorldTransformsToLocal(
  snapshot: WorldProjectSnapshotV1,
  sceneId: string,
  updates: readonly { entityId: string; transform: WorldTransform }[],
): Array<{ entityId: string; transform: WorldTransform }> {
  const scene = snapshot.scenes.find((candidate) => candidate.sceneId === sceneId)
  if (!scene) throw new Error(`Scene ${sceneId} does not exist.`)
  const byId = new Map(scene.entities.map((entity) => [entity.id, entity]))
  const updateById = new Map(updates.map((update) => [update.entityId, update.transform]))
  const worldMatrices = new Map<string, Matrix4>()
  const resolving = new Set<string>()
  const resolveWorld = (entityId: string): Matrix4 => {
    const cached = worldMatrices.get(entityId)
    if (cached) return cached
    const entity = byId.get(entityId)
    if (!entity || resolving.has(entityId)) throw new Error(`Entity ${entityId} hierarchy is invalid.`)
    resolving.add(entityId)
    const authoredWorld = updateById.get(entityId)
    const local = composeWorldTransform(entity.transform)
    const world = authoredWorld
      ? composeWorldTransform(authoredWorld)
      : entity.parentId ? resolveWorld(entity.parentId).clone().multiply(local) : local
    resolving.delete(entityId)
    worldMatrices.set(entityId, world)
    return world
  }
  return updates.map((update) => {
    const entity = byId.get(update.entityId)
    if (!entity) throw new Error(`Entity ${update.entityId} does not exist.`)
    if (!entity.parentId) return { entityId: update.entityId, transform: structuredClone(update.transform) }
    const parentWorld = resolveWorld(entity.parentId)
    const local = parentWorld.clone().invert().multiply(composeWorldTransform(update.transform))
    return { entityId: update.entityId, transform: decomposeWorldTransform(local) }
  })
}

function composeWorldTransform(transform: WorldTransform): Matrix4 {
  return new Matrix4().compose(
    new Vector3(...transform.position),
    new Quaternion().setFromEuler(new Euler(...transform.rotation, 'XYZ')),
    new Vector3(...transform.scale),
  )
}

function decomposeWorldTransform(matrix: Matrix4): WorldTransform {
  const position = new Vector3()
  const rotation = new Quaternion()
  const scale = new Vector3()
  matrix.decompose(position, rotation, scale)
  const euler = new Euler().setFromQuaternion(rotation, 'XYZ')
  return {
    position: [cleanNumber(position.x), cleanNumber(position.y), cleanNumber(position.z)],
    rotation: [cleanNumber(euler.x), cleanNumber(euler.y), cleanNumber(euler.z)],
    scale: [cleanNumber(scale.x), cleanNumber(scale.y), cleanNumber(scale.z)],
  }
}

function cleanNumber(value: number): number {
  return Object.is(value, -0) || Math.abs(value) < 1e-12 ? 0 : value
}

export interface UseWorldEditorProjectionBridgeOptions {
  controller: WorldEditorController
  state: WorldEditorControllerState
  apiUrl: string
  viewportCommitAuthority: WorldEditorViewportCommitAuthority
  viewportCommitLease: WorldEditorViewportCommitLease
  transformAdmission?: WorldEditorTransformAdmission
  onError(message: string): void
}

export interface UseWorldEditorProjectionBridgeResult {
  projection: WorldEditorViewportProjection | null
  issues: string[]
  viewerProps: WorldsViewerProps
}

export function shouldSynchronizeLegacyWorldProjection(
  projection: WorldEditorViewportProjection | null,
): projection is WorldEditorViewportProjection {
  return projection !== null
}

export interface WorldEditorViewportCommitLease {
  readonly generation: number
}


export interface WorldEditorViewportCommitAuthority {
  issue(): WorldEditorViewportCommitLease
  revoke(): void
  isCurrent(lease: WorldEditorViewportCommitLease): boolean
}

export function createWorldEditorViewportCommitAuthority(): WorldEditorViewportCommitAuthority {
  let generation = 0
  let current: WorldEditorViewportCommitLease | null = null
  return {
    issue() {
      current = Object.freeze({ generation: generation += 1 })
      return current
    },
    revoke() {
      current = null
    },
    isCurrent(lease) {
      return current === lease
    },
  }
}

export function runWorldEditorViewportCommit<T>(
  authority: WorldEditorViewportCommitAuthority,
  lease: WorldEditorViewportCommitLease,
  commit: () => T,
): T | undefined {
  if (!authority.isCurrent(lease)) return undefined
  return commit()
}

export function createWorldEditorViewportSelectionHandler(
  selectedEntityIds: readonly string[],
  setSelection: (entityIds: readonly string[], activeEntityId?: string | null) => void,
): NonNullable<WorldsViewerProps['onSelectItem']> {
  return (entityId, options) => {
    if (!entityId) {
      if (!options?.toggle) setSelection([])
      return
    }
    if (options?.toggle) {
      const next = selectedEntityIds.includes(entityId)
        ? selectedEntityIds.filter((id) => id !== entityId)
        : [...selectedEntityIds, entityId]
      setSelection(next, entityId)
    } else if (options?.preserveSelection && selectedEntityIds.includes(entityId)) {
      setSelection(selectedEntityIds, entityId)
    } else setSelection([entityId], entityId)
  }
}

export function useWorldEditorProjectionBridge({
  controller,
  state,
  apiUrl,
  viewportCommitAuthority,
  viewportCommitLease,
  transformAdmission,
  onError,
}: UseWorldEditorProjectionBridgeOptions): UseWorldEditorProjectionBridgeResult {
  const selectedEntityIds = useWorldsUiStore((value) => value.selectedEntityIds)
  const activeEntityId = useWorldsUiStore((value) => value.activeEntityId)
  const transformMode = useWorldsUiStore((value) => value.transformMode)
  const setSelection = useWorldsUiStore((value) => value.setSelection)
  const setTransformMode = useWorldsUiStore((value) => value.setTransformMode)
  const onSceneItemAnchorChange = useCallback<NonNullable<WorldsViewerProps['onSceneItemAnchorChange']>>((itemId, anchor) => {
    useWorldsSceneStore.getState().setSceneItemAnchor(itemId, anchor)
  }, [])
  const [projectionEpoch, setProjectionEpoch] = useState(0)
  const projected = useMemo(() => {
    if (!state.session || !state.activeSceneId) return null
    return projectWorldEditorViewport(state.session.snapshot, state.activeSceneId, apiUrl)
  }, [apiUrl, projectionEpoch, state.activeSceneId, state.session])
  const projection = projected?.success ? projected.value : null
  const runCollisionInput = useMemo<WorldEditorRunCollisionInput | undefined>(() => {
    if (!state.session || !state.activeSceneId) return undefined
    const snapshot = state.session.snapshot
    const sceneId = state.activeSceneId
    const projectKey = state.projectKey
    const editorEpoch = state.editorEpoch
    return { snapshot, sceneId, apiUrl, isCurrent: () => {
      const current = controller.getState()
      return viewportCommitAuthority.isCurrent(viewportCommitLease) && current.lifecycle === 'ready'
        && current.projectKey === projectKey && current.editorEpoch === editorEpoch && current.activeSceneId === sceneId
        && current.session?.snapshot.project.revision === snapshot.project.revision
    } }
  }, [apiUrl, controller, state.activeSceneId, state.editorEpoch, state.projectKey, state.session, viewportCommitAuthority, viewportCommitLease])
  const issues = projected && !projected.success ? projected.issues.map((issue) => issue.message) : []

  const syncLegacyProjection = useCallback((value: WorldEditorViewportProjection | null) => {
    if (!shouldSynchronizeLegacyWorldProjection(value)) return
    const store = useWorldsSceneStore.getState()
    const visibleIds = new Set(value.items.map((item) => item.id))
    const selectedSceneItemIds = selectedEntityIds.filter((id) => visibleIds.has(id))
    const selectedSceneItemId = activeEntityId && visibleIds.has(activeEntityId)
      ? activeEntityId
      : selectedSceneItemIds.at(-1) ?? null
    store.setScene({
      sceneItems: structuredClone(value.items),
      collisionSurfaces: structuredClone(value.collisionSurfaces),
      initialView: value.initialView ? structuredClone(value.initialView) : null,
      selectedSceneItemId,
      selectedSceneItemIds,
      selectedCollisionSurfaceId: null,
      pendingSurfacePlacementItemId: null,
    })
  }, [activeEntityId, selectedEntityIds])

  const rollbackProjection = useCallback(() => {
    syncLegacyProjection(projection)
    setProjectionEpoch((epoch) => epoch + 1)
  }, [projection, syncLegacyProjection])

  useEffect(() => {
    syncLegacyProjection(projection)
  }, [projection, syncLegacyProjection])

  useEffect(() => {
    if (!projection) return
    const validIds = new Set(projection.canonical.entities.map((entity) => entity.id))
    const validSelection = selectedEntityIds.filter((id) => validIds.has(id))
    if (validSelection.length !== selectedEntityIds.length) setSelection(validSelection)
  }, [projection, selectedEntityIds, setSelection])

  const commitTransforms = useCallback((updates: readonly { entityId: string; transform: WorldTransform }[], meta?: WorldsTransformCommitMeta) => {
    if (meta && meta.gesture === null) {
      syncLegacyProjection(null)
      onError('Transform is not available in the current viewport.')
      return
    }
    const providedGesture = meta?.gesture as WorldEditorTransformGesture | null | undefined
    const gesture = providedGesture ?? transformAdmission?.begin('viewport', updates.map((update) => update.entityId)) ?? null
    if (!gesture) {
      syncLegacyProjection(projection)
      onError('Wait for the current transform to finish.')
      return
    }
    if (!transformAdmission?.release(gesture)) {
      syncLegacyProjection(projection)
      onError('Transform is no longer current.')
      return
    }
    const committed = runWorldEditorViewportCommit(viewportCommitAuthority, gesture.viewportLease, () => {
      if (!transformAdmission.isCurrent(gesture)) return
      const current = controller.getState()
      if (!current.projectKey || !current.session || !current.activeSceneId) {
        transformAdmission.finish(gesture)
        return
      }
      const scene = current.session.snapshot.scenes.find((candidate) => candidate.sceneId === current.activeSceneId)
      const locked = scene && updates.find((update) => isWorldEntityEffectivelyLocked(scene.entities, update.entityId))
      if (locked) {
        syncLegacyProjection(projection)
        onError('Locked entities cannot be transformed.')
        transformAdmission.finish(gesture)
        return
      }
      const context: WorldEditorActiveContext = {
        projectKey: gesture.projectKey,
        projectId: gesture.projectId,
        baseRevision: gesture.baseRevision,
        activeSceneId: gesture.sceneId,
        snapshot: gesture.snapshot,
      }
      return commitWorldProjectionTransforms({
        context,
        updates,
        transactionId: createWorldUiTransactionId('viewport-transform'),
        dispatch: (request, authority) => controller.dispatchCommands(request, authority),
        rollback: rollbackProjection,
      }).then((result) => {
        if (!result.ok) onError(result.error.message)
      }).finally(() => {
        transformAdmission.finish(gesture)
      })
    })
    if (committed === undefined) {
      transformAdmission.finish(gesture)
      syncLegacyProjection(projection)
      onError('Transform is no longer current.')
    }
  }, [controller, onError, projection, rollbackProjection, syncLegacyProjection, transformAdmission, viewportCommitAuthority])

  const removeItem = useCallback((entityId: string | null) => {
    if (!entityId) return
    const current = controller.getState()
    if (!current.projectKey || !current.session || !current.activeSceneId) return
    try {
      const commands = buildWorldTreeMutationCommands(current.session.snapshot, current.activeSceneId, { type: 'delete', entityIds: [entityId] })
      void controller.dispatchCommands({ transactionId: createWorldUiTransactionId('viewport-delete'), origin: 'ui', commands }, {
        projectKey: current.projectKey,
        projectId: current.session.snapshot.project.projectId,
        baseRevision: current.session.snapshot.project.revision,
        activeSceneId: current.activeSceneId,
      }).then((result) => {
        if (!result.ok) onError(result.error.message)
        else setSelection(selectedEntityIds.filter((id) => id !== entityId))
      })
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Entity could not be deleted.')
    }
  }, [controller, onError, selectedEntityIds, setSelection])

  const toggleBaseRole = useCallback((entityId: string | null) => {
    if (!entityId) return
    const current = controller.getState()
    if (!current.projectKey || !current.session || !current.activeSceneId) return
    const scene = current.session.snapshot.scenes.find((candidate) => candidate.sceneId === current.activeSceneId)
    const entity = scene?.entities.find((candidate) => candidate.id === entityId)
    if (!entity || (scene && isWorldEntityEffectivelyLocked(scene.entities, entityId))) {
      onError('Locked entities cannot change role.')
      return
    }
    const tags = entity.tags.includes('modly:base-scene')
      ? entity.tags.filter((tag) => tag !== 'modly:base-scene')
      : [...entity.tags, 'modly:base-scene']
    void controller.dispatchCommands({
      transactionId: createWorldUiTransactionId('base-role'),
      origin: 'ui',
      commands: [{ type: 'patch-entity', sceneId: current.activeSceneId, entityId, patch: { tags } }],
    }, {
      projectKey: current.projectKey,
      projectId: current.session.snapshot.project.projectId,
      baseRevision: current.session.snapshot.project.revision,
      activeSceneId: current.activeSceneId,
    }).then((result) => { if (!result.ok) onError(result.error.message) })
  }, [controller, onError])

  const viewerItemIds = new Set(projection?.items.map((item) => item.id) ?? [])
  const viewerSelection = selectedEntityIds.filter((id) => viewerItemIds.has(id))
  const viewerActive = activeEntityId && viewerItemIds.has(activeEntityId) ? activeEntityId : viewerSelection.at(-1) ?? null
  return {
    projection,
    issues,
    viewerProps: {
      project: state.session?.snapshot.project ?? { schema: 'modly.world-project.v1', projectId: 'project:unavailable', name: 'Unavailable', revision: 0, resources: [], scenes: [], startSceneId: 'scene:unavailable', inputActions: [], graphicsProfiles: [{ id: 'graphics:unavailable', name: 'Unavailable', renderScale: 1, shadowQuality: 'off', antialiasing: 'off' }], activeGraphicsProfileId: 'graphics:unavailable' },
      items: projection?.items ?? [],
      collisionSurfaces: projection?.collisionSurfaces ?? [],
      runCollisionInput,
      initialView: projection?.initialView ?? undefined,
      environment: projection?.environment,
      lights: projection?.lights ?? [],
      useStudioLights: projection?.useStudioLights ?? true,
      selectedItemId: viewerActive,
      selectedItemIds: viewerSelection,
      transformMode,
      transformPending: transformAdmission?.pending ?? false,
      transformStatus: transformAdmission?.pending ? 'Saving transform…' : null,
      collisionEditMode: false,
      onSelectItem: createWorldEditorViewportSelectionHandler(selectedEntityIds, setSelection),
      onTransformModeChange: setTransformMode,
      onTransformGestureBegin: (entityIds) => transformAdmission?.begin('viewport', entityIds) ?? null,
      onTransformGestureCancel: (gesture) => transformAdmission?.cancel(gesture as WorldEditorTransformGesture),
      onTransformItem: (entityId, transform, meta) => commitTransforms([{ entityId, transform }], meta),
      onTransformItems: (updates, meta) => commitTransforms(updates.map((update) => ({ entityId: update.itemId, transform: update.transform })), meta),
      onRemoveItem: removeItem,
      onToggleBaseSceneItem: toggleBaseRole,
      onSceneItemAnchorChange,
    },
  }
}

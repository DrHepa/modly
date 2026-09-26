import type { SceneArtifactManifestInitialView } from '../../../shared/types/artifacts.ts'
import type { WorldSceneItem } from '../worldRenderableResolver.ts'
import type { WorldCollisionSurface } from '../worldsCollisionSurfaces.ts'
import { appendWorldSceneItem, shouldPendingWorldsSurfacePlacement } from '../worldsScenePlacement.ts'
import { useWorldsSceneStore } from '../worldsSceneStore.ts'

export interface LegacyWorldsCommandBridgeState {
  sceneItems: WorldSceneItem[]
  collisionSurfaces: WorldCollisionSurface[]
  sceneItemAnchors: Record<string, [number, number, number]>
  selectedSceneItemId: string | null
  initialView?: SceneArtifactManifestInitialView | null
}

export interface LegacyWorldsSceneReplacement {
  sceneItems: WorldSceneItem[]
  collisionSurfaces: WorldCollisionSurface[]
  initialView: SceneArtifactManifestInitialView | null
}

export interface LegacyWorldsStoreAdapter {
  getState(): LegacyWorldsCommandBridgeState
  setScene(value: {
    sceneItems: WorldSceneItem[]
    collisionSurfaces: WorldCollisionSurface[]
    selectedSceneItemId: string | null
    selectedSceneItemIds?: string[]
    selectedCollisionSurfaceId?: string | null
    pendingSurfacePlacementItemId?: string | null
    initialView?: SceneArtifactManifestInitialView | null
  }): void
}

export interface LegacyWorldsCommandBridge {
  appendRenderable(item: WorldSceneItem): Promise<{ accepted: true; mode: 'legacy' }>
  replaceScene(scene: LegacyWorldsSceneReplacement): Promise<{ accepted: true; mode: 'legacy' }>
}

export interface LegacyWorldsReadableCommandBridge extends LegacyWorldsCommandBridge {
  readScene(): LegacyWorldsSceneReplacement
}

export function createLegacyWorldsCommandBridge(adapter: LegacyWorldsStoreAdapter = defaultLegacyWorldsStoreAdapter): LegacyWorldsReadableCommandBridge {
  return Object.freeze({
    readScene() {
      const current = adapter.getState()
      return deepFreeze({
        sceneItems: structuredClone(current.sceneItems),
        collisionSurfaces: structuredClone(current.collisionSurfaces),
        initialView: current.initialView ? structuredClone(current.initialView) : null,
      })
    },
    async appendRenderable(item: WorldSceneItem) {
      const current = adapter.getState()
      const appended = appendWorldSceneItem(current.sceneItems, structuredClone(item), {
        sceneItemAnchors: current.sceneItemAnchors,
        selectedSceneItemId: current.selectedSceneItemId,
      })
      adapter.setScene({
        ...appended,
        collisionSurfaces: structuredClone(current.collisionSurfaces),
        pendingSurfacePlacementItemId: shouldPendingWorldsSurfacePlacement(current.sceneItems, item)
          ? appended.selectedSceneItemId
          : null,
      })
      return Object.freeze({ accepted: true as const, mode: 'legacy' as const })
    },
    async replaceScene(scene: LegacyWorldsSceneReplacement) {
      const selectedSceneItemId = scene.sceneItems.find((item) => item.visible)?.id ?? null
      adapter.setScene({
        sceneItems: structuredClone(scene.sceneItems),
        collisionSurfaces: structuredClone(scene.collisionSurfaces),
        selectedSceneItemId,
        selectedSceneItemIds: selectedSceneItemId ? [selectedSceneItemId] : [],
        selectedCollisionSurfaceId: null,
        pendingSurfacePlacementItemId: null,
        initialView: scene.initialView ? structuredClone(scene.initialView) : null,
      })
      return Object.freeze({ accepted: true as const, mode: 'legacy' as const })
    },
  })
}

const defaultLegacyWorldsStoreAdapter: LegacyWorldsStoreAdapter = {
  getState() {
    const state = useWorldsSceneStore.getState()
    return {
      sceneItems: state.sceneItems,
      collisionSurfaces: state.collisionSurfaces,
      sceneItemAnchors: state.sceneItemAnchors,
      selectedSceneItemId: state.selectedSceneItemId,
      initialView: state.initialView,
    }
  },
  setScene(value) {
    useWorldsSceneStore.getState().setScene(value)
  },
}

export const legacyWorldsCommandBridge: LegacyWorldsReadableCommandBridge = createLegacyWorldsCommandBridge()

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.values(value as Record<string, unknown>).forEach(deepFreeze)
  return Object.freeze(value)
}

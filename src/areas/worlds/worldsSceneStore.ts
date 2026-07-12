import { create } from 'zustand'

import type { SceneArtifactManifestInitialView } from '../../shared/types/artifacts.ts'
import type { WorldsTransformMode } from './components/WorldsTransformToolbar.tsx'
import type { WorldSceneItem } from './worldRenderableResolver.ts'
import type { WorldCollisionSurface } from './worldsCollisionSurfaces.ts'
import { normalizeWorldCollisionSurface } from './worldsCollisionSurfaces.ts'

export interface WorldsSceneState {
  sceneItems: WorldSceneItem[]
  collisionSurfaces: WorldCollisionSurface[]
  initialView: SceneArtifactManifestInitialView | null
  selectedSceneItemId: string | null
  selectedSceneItemIds: string[]
  pendingSurfacePlacementItemId: string | null
  collisionEditMode: boolean
  selectedCollisionSurfaceId: string | null
  transformMode: WorldsTransformMode | null
  sceneItemAnchors: Record<string, [number, number, number]>
  setScene: (scene: Pick<WorldsSceneState, 'sceneItems' | 'collisionSurfaces' | 'selectedSceneItemId'> & Partial<Pick<WorldsSceneState, 'initialView' | 'selectedSceneItemIds' | 'selectedCollisionSurfaceId' | 'pendingSurfacePlacementItemId'>>) => void
  setSelectedSceneItemId: (itemId: string | null, options?: { preserveSelection?: boolean }) => void
  toggleSelectedSceneItemId: (itemId: string) => void
  setCollisionEditMode: (enabled: boolean) => void
  setSelectedCollisionSurfaceId: (surfaceId: string | null) => void
  setTransformMode: (mode: WorldsTransformMode | null) => void
  setPendingSurfacePlacementItemId: (itemId: string | null) => void
  clearPendingSurfacePlacementItemId: () => void
  setSceneItemAnchor: (itemId: string, anchor: [number, number, number] | null) => void
  clearTransformMode: () => void
}

function resolveValidPendingSurfacePlacementItemId(
  sceneItems: WorldSceneItem[],
  pendingItemId: string | null | undefined,
): string | null {
  if (!pendingItemId) return null
  const item = sceneItems.find((sceneItem) => sceneItem.id === pendingItemId)
  if (!item || item.role === 'base-scene') return null
  return pendingItemId
}

function normalizeWorldCollisionSurfaces(surfaces: WorldCollisionSurface[]): WorldCollisionSurface[] {
  const normalized: WorldCollisionSurface[] = []
  const seenIds = new Set<string>()
  for (const surface of surfaces) {
    const nextSurface = normalizeWorldCollisionSurface(surface)
    if (!nextSurface || seenIds.has(nextSurface.id)) continue
    seenIds.add(nextSurface.id)
    normalized.push(nextSurface)
  }
  return normalized
}

export function normalizeWorldsSelectedSceneItemIds(
  sceneItems: WorldSceneItem[],
  selectedSceneItemId: string | null,
  selectedSceneItemIds: string[] = [],
): string[] {
  const visibleItemIds = new Set(sceneItems.filter((item) => item.visible).map((item) => item.id))
  const deduped = selectedSceneItemIds.filter((itemId, index) => selectedSceneItemIds.indexOf(itemId) === index && visibleItemIds.has(itemId))
  if (selectedSceneItemId && visibleItemIds.has(selectedSceneItemId) && !deduped.includes(selectedSceneItemId)) {
    deduped.push(selectedSceneItemId)
  }
  return deduped
}

export function toggleWorldsSelectedSceneItem(
  selectedSceneItemIds: string[],
  selectedSceneItemId: string | null,
  itemId: string,
): { selectedSceneItemIds: string[]; selectedSceneItemId: string | null } {
  if (selectedSceneItemIds.includes(itemId)) {
    const nextSelectedSceneItemIds = selectedSceneItemIds.filter((value) => value !== itemId)
    return {
      selectedSceneItemIds: nextSelectedSceneItemIds,
      selectedSceneItemId: selectedSceneItemId === itemId ? nextSelectedSceneItemIds.at(-1) ?? null : selectedSceneItemId,
    }
  }

  return {
    selectedSceneItemIds: [...selectedSceneItemIds, itemId],
    selectedSceneItemId: itemId,
  }
}

export const useWorldsSceneStore = create<WorldsSceneState>((set) => ({
  sceneItems: [],
  collisionSurfaces: [],
  initialView: null,
  selectedSceneItemId: null,
  selectedSceneItemIds: [],
  pendingSurfacePlacementItemId: null,
  collisionEditMode: false,
  selectedCollisionSurfaceId: null,
  transformMode: null,
  sceneItemAnchors: {},
  setScene: (scene) => set((state) => {
    const collisionSurfaces = normalizeWorldCollisionSurfaces(scene.collisionSurfaces)
    const selectedSceneItemIds = normalizeWorldsSelectedSceneItemIds(
      scene.sceneItems,
      scene.selectedSceneItemId,
      scene.selectedSceneItemIds ?? state.selectedSceneItemIds,
    )
    const selectedSceneItemId = scene.selectedSceneItemId && selectedSceneItemIds.includes(scene.selectedSceneItemId)
      ? scene.selectedSceneItemId
      : selectedSceneItemIds.at(-1) ?? null
    const selectedCollisionSurfaceId = scene.selectedCollisionSurfaceId
      ? collisionSurfaces.some((surface) => surface.id === scene.selectedCollisionSurfaceId) ? scene.selectedCollisionSurfaceId : null
      : state.selectedCollisionSurfaceId && collisionSurfaces.some((surface) => surface.id === state.selectedCollisionSurfaceId)
        ? state.selectedCollisionSurfaceId
        : null
    const pendingSurfacePlacementItemId = resolveValidPendingSurfacePlacementItemId(
      scene.sceneItems,
      scene.pendingSurfacePlacementItemId !== undefined
      ? scene.pendingSurfacePlacementItemId
      : state.pendingSurfacePlacementItemId,
    )

    return {
      sceneItems: scene.sceneItems,
      collisionSurfaces,
      initialView: scene.initialView === undefined ? state.initialView : scene.initialView,
      selectedSceneItemId,
      selectedSceneItemIds,
      pendingSurfacePlacementItemId,
      selectedCollisionSurfaceId,
      transformMode: state.transformMode,
    }
  }),
  setSelectedSceneItemId: (itemId, options) => set((state) => ({
    selectedSceneItemId: itemId,
      selectedSceneItemIds: itemId && options?.preserveSelection && state.selectedSceneItemIds.includes(itemId)
        ? state.selectedSceneItemIds
        : itemId ? [itemId] : [],
    selectedCollisionSurfaceId: itemId ? null : state.selectedCollisionSurfaceId,
    transformMode: state.transformMode,
  })),
  toggleSelectedSceneItemId: (itemId) => set((state) => {
    const nextSelection = toggleWorldsSelectedSceneItem(state.selectedSceneItemIds, state.selectedSceneItemId, itemId)
    return {
      ...nextSelection,
      selectedCollisionSurfaceId: null,
      transformMode: state.transformMode,
    }
  }),
  setCollisionEditMode: (enabled) => set({ collisionEditMode: enabled }),
  setSelectedCollisionSurfaceId: (surfaceId) => set({ selectedCollisionSurfaceId: surfaceId }),
  setTransformMode: (mode) => set({ transformMode: mode }),
  setPendingSurfacePlacementItemId: (itemId) => set((state) => ({
    pendingSurfacePlacementItemId: resolveValidPendingSurfacePlacementItemId(state.sceneItems, itemId),
  })),
  clearPendingSurfacePlacementItemId: () => set({ pendingSurfacePlacementItemId: null }),
  setSceneItemAnchor: (itemId, anchor) => set((state) => {
    const current = state.sceneItemAnchors[itemId]
    if (anchor && current && current.every((value, index) => value === anchor[index])) return state
    const nextAnchors = { ...state.sceneItemAnchors }
    if (anchor) nextAnchors[itemId] = anchor
    else delete nextAnchors[itemId]
    return { sceneItemAnchors: nextAnchors }
  }),
  clearTransformMode: () => set({ transformMode: null }),
}))

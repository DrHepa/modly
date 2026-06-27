import { create } from 'zustand'

import type { WorldsTransformMode } from './components/WorldsTransformToolbar.tsx'
import type { WorldSceneItem } from './worldRenderableResolver.ts'

export interface WorldsSceneState {
  sceneItems: WorldSceneItem[]
  selectedSceneItemId: string | null
  selectedSceneItemIds: string[]
  transformMode: WorldsTransformMode | null
  sceneItemAnchors: Record<string, [number, number, number]>
  setScene: (scene: Pick<WorldsSceneState, 'sceneItems' | 'selectedSceneItemId'> & Partial<Pick<WorldsSceneState, 'selectedSceneItemIds'>>) => void
  setSelectedSceneItemId: (itemId: string | null, options?: { preserveSelection?: boolean }) => void
  toggleSelectedSceneItemId: (itemId: string) => void
  setTransformMode: (mode: WorldsTransformMode | null) => void
  setSceneItemAnchor: (itemId: string, anchor: [number, number, number] | null) => void
  clearTransformMode: () => void
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
  selectedSceneItemId: null,
  selectedSceneItemIds: [],
  transformMode: null,
  sceneItemAnchors: {},
  setScene: (scene) => set((state) => {
    const selectedSceneItemIds = normalizeWorldsSelectedSceneItemIds(
      scene.sceneItems,
      scene.selectedSceneItemId,
      scene.selectedSceneItemIds ?? state.selectedSceneItemIds,
    )
    const selectedSceneItemId = scene.selectedSceneItemId && selectedSceneItemIds.includes(scene.selectedSceneItemId)
      ? scene.selectedSceneItemId
      : selectedSceneItemIds.at(-1) ?? null

    return {
      sceneItems: scene.sceneItems,
      selectedSceneItemId,
      selectedSceneItemIds,
      transformMode: selectedSceneItemId ? state.transformMode : null,
    }
  }),
  setSelectedSceneItemId: (itemId, options) => set((state) => ({
    selectedSceneItemId: itemId,
    selectedSceneItemIds: itemId && options?.preserveSelection && state.selectedSceneItemIds.includes(itemId)
      ? state.selectedSceneItemIds
      : itemId ? [itemId] : [],
    transformMode: itemId ? state.transformMode : null,
  })),
  toggleSelectedSceneItemId: (itemId) => set((state) => {
    const nextSelection = toggleWorldsSelectedSceneItem(state.selectedSceneItemIds, state.selectedSceneItemId, itemId)
    return {
      ...nextSelection,
      transformMode: nextSelection.selectedSceneItemId ? state.transformMode : null,
    }
  }),
  setTransformMode: (mode) => set({ transformMode: mode }),
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

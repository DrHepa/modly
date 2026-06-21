import { create } from 'zustand'

import type { WorldsTransformMode } from './components/WorldsTransformToolbar.tsx'
import type { WorldSceneItem } from './worldRenderableResolver.ts'

export interface WorldsSceneState {
  sceneItems: WorldSceneItem[]
  selectedSceneItemId: string | null
  transformMode: WorldsTransformMode | null
  sceneItemAnchors: Record<string, [number, number, number]>
  setScene: (scene: Pick<WorldsSceneState, 'sceneItems' | 'selectedSceneItemId'>) => void
  setSelectedSceneItemId: (itemId: string | null) => void
  setTransformMode: (mode: WorldsTransformMode | null) => void
  setSceneItemAnchor: (itemId: string, anchor: [number, number, number] | null) => void
  clearTransformMode: () => void
}

export const useWorldsSceneStore = create<WorldsSceneState>((set) => ({
  sceneItems: [],
  selectedSceneItemId: null,
  transformMode: null,
  sceneItemAnchors: {},
  setScene: (scene) => set({ sceneItems: scene.sceneItems, selectedSceneItemId: scene.selectedSceneItemId }),
  setSelectedSceneItemId: (itemId) => set((state) => ({ selectedSceneItemId: itemId, transformMode: itemId ? state.transformMode : null })),
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

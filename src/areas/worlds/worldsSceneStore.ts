import { create } from 'zustand'

import type { WorldsTransformMode } from './components/WorldsTransformToolbar.tsx'
import type { WorldSceneItem } from './worldRenderableResolver.ts'

export interface WorldsSceneState {
  sceneItems: WorldSceneItem[]
  selectedSceneItemId: string | null
  transformMode: WorldsTransformMode | null
  setScene: (scene: Pick<WorldsSceneState, 'sceneItems' | 'selectedSceneItemId'>) => void
  setSelectedSceneItemId: (itemId: string | null) => void
  setTransformMode: (mode: WorldsTransformMode | null) => void
  clearTransformMode: () => void
}

export const useWorldsSceneStore = create<WorldsSceneState>((set) => ({
  sceneItems: [],
  selectedSceneItemId: null,
  transformMode: null,
  setScene: (scene) => set({ sceneItems: scene.sceneItems, selectedSceneItemId: scene.selectedSceneItemId }),
  setSelectedSceneItemId: (itemId) => set((state) => ({ selectedSceneItemId: itemId, transformMode: itemId ? state.transformMode : null })),
  setTransformMode: (mode) => set({ transformMode: mode }),
  clearTransformMode: () => set({ transformMode: null }),
}))

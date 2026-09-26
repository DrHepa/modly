import { create } from 'zustand'

import type { WorldsTransformMode } from '../components/WorldsTransformToolbar.tsx'

export type WorldsWorkbenchDock = 'scene' | 'assets' | 'inspector'

export interface WorldsUiState {
  selectedEntityIds: string[]
  activeEntityId: string | null
  expandedEntityIds: string[]
  focusedTreeEntityId: string | null
  activeLeftDock: 'scene' | 'assets'
  overlayDock: WorldsWorkbenchDock | null
  transformMode: WorldsTransformMode | null
  snapEnabled: boolean
  snapIncrement: number
  setSelection(entityIds: readonly string[], activeEntityId?: string | null): void
  setExpandedEntityIds(entityIds: readonly string[]): void
  setFocusedTreeEntityId(entityId: string | null): void
  setActiveLeftDock(dock: 'scene' | 'assets'): void
  setOverlayDock(dock: WorldsWorkbenchDock | null): void
  setTransformMode(mode: WorldsTransformMode | null): void
  setSnap(enabled: boolean, increment?: number): void
  resetForScene(): void
}

export const useWorldsUiStore = create<WorldsUiState>((set) => ({
  selectedEntityIds: [],
  activeEntityId: null,
  expandedEntityIds: [],
  focusedTreeEntityId: null,
  activeLeftDock: 'scene',
  overlayDock: null,
  transformMode: 'translate',
  snapEnabled: false,
  snapIncrement: 0.5,
  setSelection: (entityIds, activeEntityId) => set(() => {
    const selectedEntityIds = [...new Set(entityIds)]
    const active = activeEntityId === undefined ? selectedEntityIds.at(-1) ?? null : activeEntityId
    return {
      selectedEntityIds,
      activeEntityId: active && selectedEntityIds.includes(active) ? active : selectedEntityIds.at(-1) ?? null,
    }
  }),
  setExpandedEntityIds: (entityIds) => set({ expandedEntityIds: [...new Set(entityIds)] }),
  setFocusedTreeEntityId: (entityId) => set({ focusedTreeEntityId: entityId }),
  setActiveLeftDock: (dock) => set({ activeLeftDock: dock }),
  setOverlayDock: (dock) => set((state) => ({ overlayDock: state.overlayDock === dock ? null : dock })),
  setTransformMode: (mode) => set({ transformMode: mode }),
  setSnap: (enabled, increment) => set((state) => ({
    snapEnabled: enabled,
    snapIncrement: increment !== undefined && Number.isFinite(increment) && increment > 0 ? increment : state.snapIncrement,
  })),
  resetForScene: () => set({
    selectedEntityIds: [], activeEntityId: null, focusedTreeEntityId: null,
    expandedEntityIds: [], overlayDock: null,
  }),
}))

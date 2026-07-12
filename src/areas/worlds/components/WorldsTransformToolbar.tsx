import { useState, type ReactNode } from 'react'

import type { WorldSceneItem } from '../worldRenderableResolver.ts'
import type { WorldCollisionSurface, WorldCollisionSurfacePreset } from '../worldsCollisionSurfaces.ts'

export type WorldsTransformMode = 'translate' | 'rotate' | 'scale'

interface WorldsTransformToolbarProps {
  items?: WorldSceneItem[]
  collisionSurfaces?: WorldCollisionSurface[]
  selectedItemId: string | null
  selectedItemIds?: string[]
  collisionEditMode?: boolean
  selectedCollisionSurfaceId?: string | null
  mode: WorldsTransformMode | null
  onSelectItem?: (itemId: string | null, options?: { preserveSelection?: boolean }) => void
  onModeChange: (mode: WorldsTransformMode | null) => void
  onRemoveItem?: (itemId: string | null) => void
  onRemoveCollisionSurface?: (surfaceId: string | null) => void
  onToggleBaseSceneItem?: (itemId: string | null) => void
  onAddCollisionSurface?: (preset?: WorldCollisionSurfacePreset) => void
  onCollisionEditModeChange?: (enabled: boolean) => void
  onSelectCollisionSurface?: (surfaceId: string | null) => void
}

const COLLISION_SURFACE_PRESETS: { value: WorldCollisionSurfacePreset; label: string }[] = [
  { value: 'rectangle', label: 'Rectangle' },
  { value: 'square', label: 'Square' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'wall', label: 'Wall' },
  { value: 'floor', label: 'Floor' },
  { value: 'ramp', label: 'Ramp' },
]

const TRANSFORM_MODES: { mode: WorldsTransformMode; label: string; icon: ReactNode }[] = [
  {
    mode: 'translate',
    label: 'Move selected asset',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3v18" />
        <path d="M5 10l7-7 7 7" />
        <path d="M3 12h18" />
        <path d="M14 5l7 7-7 7" />
      </svg>
    ),
  },
  {
    mode: 'rotate',
    label: 'Rotate selected asset',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 12a8 8 0 0 1 13.66-5.66" />
        <path d="M18 3v4h-4" />
        <path d="M20 12a8 8 0 0 1-13.66 5.66" />
        <path d="M6 21v-4h4" />
      </svg>
    ),
  },
  {
    mode: 'scale',
    label: 'Scale selected asset',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 20L20 4" />
        <path d="M14 4h6v6" />
        <path d="M10 20H4v-6" />
      </svg>
    ),
  },
]

export function WorldsTransformToolbar({
  items = [],
  collisionSurfaces = [],
  selectedItemId,
  selectedItemIds = [],
  collisionEditMode = false,
  selectedCollisionSurfaceId = null,
  mode,
  onSelectItem = () => undefined,
  onModeChange,
  onRemoveItem = () => undefined,
  onRemoveCollisionSurface = () => undefined,
  onToggleBaseSceneItem = () => undefined,
  onAddCollisionSurface = () => undefined,
  onCollisionEditModeChange = () => undefined,
  onSelectCollisionSurface = () => undefined,
}: WorldsTransformToolbarProps): JSX.Element | null {
  const visibleItems = items.filter((item) => item.visible)
  const [collisionPreset, setCollisionPreset] = useState<WorldCollisionSurfacePreset>('rectangle')
  if (visibleItems.length === 0 && collisionSurfaces.length === 0) return null

  const selectedItem = selectedItemId ? visibleItems.find((item) => item.id === selectedItemId) ?? null : null
  const selectedItemCount = selectedItemIds.length
  const selectedCollisionSurface = selectedCollisionSurfaceId ? collisionSurfaces.find((surface) => surface.id === selectedCollisionSurfaceId) ?? null : null
  const hasCollisionSurfaces = collisionSurfaces.length > 0
  const activeTarget = resolveWorldsTransformToolbarTarget({
    collisionEditMode,
    selectedItem,
    selectedCollisionSurface,
  })

  return (
    <div
      role="toolbar"
      aria-label="World asset transform controls"
      className="absolute right-4 top-1/2 z-20 flex max-w-[min(18rem,calc(100vw-2rem))] -translate-y-1/2 flex-col gap-2 rounded-2xl border border-zinc-700/50 bg-zinc-950/78 p-2 shadow-[0_8px_30px_rgba(0,0,0,0.28)] backdrop-blur-md"
    >
      <label className="flex flex-col gap-1 text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-zinc-500">
        Scene assets
        {selectedItemCount > 1 ? <span className="text-[0.6rem] normal-case tracking-normal text-zinc-400">{selectedItemCount} selected, transforms use the active item as the pivot</span> : null}
        <select
          value={selectedItemId ?? ''}
          aria-label="Select world asset"
          onChange={(event) => onSelectItem(event.currentTarget.value || null, { preserveSelection: true })}
          className="w-56 rounded-xl border border-zinc-700/70 bg-zinc-900/90 px-2.5 py-2 text-xs font-medium normal-case tracking-normal text-zinc-100 outline-none transition focus:border-violet-400 focus:ring-2 focus:ring-violet-500/30"
        >
          <option value="">Select asset…</option>
          {visibleItems.map((item, index) => (
            <option key={item.id} value={item.id}>{formatWorldSceneItemLabel(item, index)}</option>
          ))}
        </select>
      </label>

      <button
        type="button"
        title={selectedItem ? (selectedItem.role === 'base-scene' ? 'Unset selected asset as a base world' : 'Set selected asset as a base world') : 'Select an asset to mark as a base world'}
        aria-label={selectedItem?.role === 'base-scene' ? 'Unset selected asset as base world' : 'Set selected asset as base world'}
        aria-pressed={selectedItem?.role === 'base-scene'}
        disabled={!selectedItem}
        onClick={() => onToggleBaseSceneItem(selectedItemId)}
        className={`flex items-center justify-between gap-2 rounded-xl border px-2.5 py-2 text-left text-[10px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:opacity-40 ${
          selectedItem?.role === 'base-scene'
            ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-200'
            : 'border-zinc-700/70 bg-zinc-900/70 text-zinc-300 hover:border-violet-400/50 hover:bg-violet-500/10 disabled:hover:border-zinc-700/70 disabled:hover:bg-zinc-900/70'
        }`}
      >
        <span>{selectedItem?.role === 'base-scene' ? 'Base world' : 'Set as base'}</span>
        <span className="text-[9px] font-medium text-zinc-500">relative placement</span>
      </button>

      <div className="flex items-center gap-1">
        <label className="sr-only" htmlFor="worlds-collision-preset">Collision surface preset</label>
        <select
          id="worlds-collision-preset"
          value={collisionPreset}
          aria-label="Collision surface preset"
          onChange={(event) => setCollisionPreset(event.currentTarget.value as WorldCollisionSurfacePreset)}
          className="min-w-0 flex-1 rounded-lg border border-zinc-700/70 bg-zinc-900/90 px-2 py-1.5 text-[10px] font-semibold text-zinc-100 outline-none transition focus:border-violet-400 focus:ring-2 focus:ring-violet-500/30 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {COLLISION_SURFACE_PRESETS.map((preset) => (
            <option key={preset.value} value={preset.value}>{preset.label}</option>
          ))}
        </select>
        <button
          type="button"
          title="Add a world collision surface"
          aria-label="Add collision surface"
          onClick={() => onAddCollisionSurface(collisionPreset)}
          className="rounded-lg border border-zinc-700/70 px-2 py-1.5 text-[10px] font-semibold text-zinc-200 transition-colors hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Add collision surface
        </button>
        <button
          type="button"
          title={hasCollisionSurfaces ? 'Show world collision surfaces' : 'Add a collision surface to edit collisions'}
          aria-label="Edit collision surfaces"
          aria-pressed={collisionEditMode}
          disabled={!hasCollisionSurfaces}
          onClick={() => onCollisionEditModeChange(!collisionEditMode)}
          className={`rounded-lg px-2 py-1.5 text-[10px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:opacity-40 ${
            collisionEditMode ? 'bg-violet-600 text-white' : 'bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800'
          }`}
        >
          Edit surfaces
        </button>
      </div>

      {hasCollisionSurfaces ? (
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1 text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-zinc-500">
            Collision surface
            <select
              value={selectedCollisionSurfaceId ?? ''}
              aria-label="Select collision surface"
              disabled={!collisionEditMode}
              onChange={(event) => onSelectCollisionSurface(event.currentTarget.value || null)}
              className="w-56 rounded-xl border border-zinc-700/70 bg-zinc-900/90 px-2.5 py-2 text-xs font-medium normal-case tracking-normal text-zinc-100 outline-none transition focus:border-violet-400 focus:ring-2 focus:ring-violet-500/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <option value="">Select surface…</option>
              {collisionSurfaces.map((surface, index) => (
                <option key={surface.id} value={surface.id}>{surface.label ?? `Surface ${index + 1}`}</option>
              ))}
            </select>
          </label>
          {collisionEditMode ? <p className="text-[10px] text-zinc-400">World collision surfaces use the same move, rotate, and scale gizmo as scene assets.</p> : null}
        </div>
      ) : null}

      <div className="flex items-center gap-1">
        {TRANSFORM_MODES.map((entry) => {
          const hasTransformTarget = activeTarget !== 'none'
          const title = activeTarget === 'collision-surface'
            ? `${entry.label.replace('asset', 'collision surface')}`
            : activeTarget === 'asset'
              ? entry.label
              : 'Select an asset or collision surface to transform'
          return (
            <button
              key={entry.mode}
              type="button"
              title={title}
              aria-label={entry.label}
              aria-pressed={mode === entry.mode}
              disabled={!hasTransformTarget}
              onClick={() => onModeChange(mode === entry.mode ? null : entry.mode)}
              className={`relative flex h-8 w-8 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:opacity-40 ${
                mode === entry.mode ? 'bg-violet-600 text-white' : 'text-zinc-400 hover:bg-zinc-700/60 hover:text-zinc-200 disabled:hover:bg-transparent disabled:hover:text-zinc-400'
              }`}
            >
              {entry.icon}
            </button>
          )
        })}
        <button
          type="button"
          title={activeTarget === 'collision-surface'
            ? 'Remove selected collision surface'
            : activeTarget === 'asset'
              ? 'Remove selected asset from scene'
              : 'Select an asset or collision surface to remove'}
          aria-label={activeTarget === 'collision-surface' ? 'Remove selected collision surface' : 'Remove selected asset'}
          disabled={activeTarget === 'none'}
          onClick={() => {
            if (activeTarget === 'collision-surface') onRemoveCollisionSurface(selectedCollisionSurfaceId)
            else if (activeTarget === 'asset') onRemoveItem(selectedItemId)
          }}
          className="ml-1 flex h-8 items-center justify-center rounded-lg border border-red-500/20 px-2 text-xs font-semibold text-red-200 transition-colors hover:border-red-400/50 hover:bg-red-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-red-500/20 disabled:hover:bg-transparent"
        >
          {activeTarget === 'collision-surface' ? 'Remove surface' : 'Remove'}
        </button>
      </div>
    </div>
  )
}

export function resolveWorldsTransformToolbarTarget({
  collisionEditMode,
  selectedItem,
  selectedCollisionSurface,
}: {
  collisionEditMode: boolean
  selectedItem: WorldSceneItem | null
  selectedCollisionSurface: WorldCollisionSurface | null
}): 'collision-surface' | 'asset' | 'none' {
  if (collisionEditMode && selectedCollisionSurface) return 'collision-surface'
  if (selectedItem) return 'asset'
  return 'none'
}

export function formatWorldSceneItemLabel(item: Pick<WorldSceneItem, 'workspacePath' | 'id' | 'role'>, index: number): string {
  const fileName = item.workspacePath.split('/').at(-1) || item.id
  const roleSuffix = item.role === 'base-scene' ? ' · base' : ''
  return `${index + 1}. ${fileName}${roleSuffix}`
}

export default WorldsTransformToolbar

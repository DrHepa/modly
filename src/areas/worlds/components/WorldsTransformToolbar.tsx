import { useState, type ReactNode } from 'react'

import type { WorldSceneItem } from '../worldRenderableResolver.ts'
import type { WorldCollisionZone, WorldCollisionZonePreset } from '../worldsCollisionZones.ts'

export type WorldsTransformMode = 'translate' | 'rotate' | 'scale'

interface WorldsTransformToolbarProps {
  items?: WorldSceneItem[]
  collisionZones?: WorldCollisionZone[]
  selectedItemId: string | null
  selectedItemIds?: string[]
  collisionEditMode?: boolean
  selectedCollisionZoneId?: string | null
  mode: WorldsTransformMode | null
  onSelectItem?: (itemId: string | null, options?: { preserveSelection?: boolean }) => void
  onModeChange: (mode: WorldsTransformMode | null) => void
  onRemoveItem?: (itemId: string | null) => void
  onRemoveCollisionZone?: (zoneId: string | null) => void
  onToggleBaseSceneItem?: (itemId: string | null) => void
  onAddCollisionZone?: (preset?: WorldCollisionZonePreset) => void
  onCollisionEditModeChange?: (enabled: boolean) => void
  onSelectCollisionZone?: (zoneId: string | null) => void
}

const COLLISION_ZONE_PRESETS: { value: WorldCollisionZonePreset; label: string }[] = [
  { value: 'wall', label: 'Wall' },
  { value: 'blocker', label: 'Blocker' },
  { value: 'floor-zone', label: 'Floor zone' },
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
  collisionZones = [],
  selectedItemId,
  selectedItemIds = [],
  collisionEditMode = false,
  selectedCollisionZoneId = null,
  mode,
  onSelectItem = () => undefined,
  onModeChange,
  onRemoveItem = () => undefined,
  onRemoveCollisionZone = () => undefined,
  onToggleBaseSceneItem = () => undefined,
  onAddCollisionZone = () => undefined,
  onCollisionEditModeChange = () => undefined,
  onSelectCollisionZone = () => undefined,
}: WorldsTransformToolbarProps): JSX.Element | null {
  const visibleItems = items.filter((item) => item.visible)
  const [collisionPreset, setCollisionPreset] = useState<WorldCollisionZonePreset>('blocker')
  if (visibleItems.length === 0 && collisionZones.length === 0) return null

  const selectedItem = selectedItemId ? visibleItems.find((item) => item.id === selectedItemId) ?? null : null
  const selectedItemCount = selectedItemIds.length
  const selectedCollisionZone = selectedCollisionZoneId ? collisionZones.find((zone) => zone.id === selectedCollisionZoneId) ?? null : null
  const hasCollisionZones = collisionZones.length > 0
  const activeTarget = resolveWorldsTransformToolbarTarget({
    collisionEditMode,
    selectedItem,
    selectedCollisionZone,
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
        <label className="sr-only" htmlFor="worlds-collision-preset">Collision zone preset</label>
        <select
          id="worlds-collision-preset"
          value={collisionPreset}
          aria-label="Collision zone preset"
          onChange={(event) => setCollisionPreset(event.currentTarget.value as WorldCollisionZonePreset)}
          className="min-w-0 flex-1 rounded-lg border border-zinc-700/70 bg-zinc-900/90 px-2 py-1.5 text-[10px] font-semibold text-zinc-100 outline-none transition focus:border-violet-400 focus:ring-2 focus:ring-violet-500/30 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {COLLISION_ZONE_PRESETS.map((preset) => (
            <option key={preset.value} value={preset.value}>{preset.label}</option>
          ))}
        </select>
        <button
          type="button"
          title="Add a world collision zone"
          aria-label="Add collision zone"
          onClick={() => onAddCollisionZone(collisionPreset)}
          className="rounded-lg border border-zinc-700/70 px-2 py-1.5 text-[10px] font-semibold text-zinc-200 transition-colors hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Add collision zone
        </button>
        <button
          type="button"
          title={hasCollisionZones ? 'Show world collision zones' : 'Add a collision zone to edit collisions'}
          aria-label="Edit collision zones"
          aria-pressed={collisionEditMode}
          disabled={!hasCollisionZones}
          onClick={() => onCollisionEditModeChange(!collisionEditMode)}
          className={`rounded-lg px-2 py-1.5 text-[10px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:opacity-40 ${
            collisionEditMode ? 'bg-violet-600 text-white' : 'bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800'
          }`}
        >
          Edit zones
        </button>
      </div>

      {hasCollisionZones ? (
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1 text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-zinc-500">
            Collision zone
            <select
              value={selectedCollisionZoneId ?? ''}
              aria-label="Select collision zone"
              disabled={!collisionEditMode}
              onChange={(event) => onSelectCollisionZone(event.currentTarget.value || null)}
              className="w-56 rounded-xl border border-zinc-700/70 bg-zinc-900/90 px-2.5 py-2 text-xs font-medium normal-case tracking-normal text-zinc-100 outline-none transition focus:border-violet-400 focus:ring-2 focus:ring-violet-500/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <option value="">Select zone…</option>
              {collisionZones.map((zone, index) => (
                <option key={zone.id} value={zone.id}>{zone.label ?? `Zone ${index + 1}`}</option>
              ))}
            </select>
          </label>
          {collisionEditMode ? <p className="text-[10px] text-zinc-400">World collision zones use the same move, rotate, and scale gizmo as scene assets.</p> : null}
        </div>
      ) : null}

      <div className="flex items-center gap-1">
        {TRANSFORM_MODES.map((entry) => {
          const hasTransformTarget = activeTarget !== 'none'
          const title = activeTarget === 'collision-zone'
            ? `${entry.label.replace('asset', 'collision zone')}`
            : activeTarget === 'asset'
              ? entry.label
              : 'Select an asset or collision zone to transform'
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
          title={activeTarget === 'collision-zone'
            ? 'Remove selected collision zone'
            : activeTarget === 'asset'
              ? 'Remove selected asset from scene'
              : 'Select an asset or collision zone to remove'}
          aria-label={activeTarget === 'collision-zone' ? 'Remove selected collision zone' : 'Remove selected asset'}
          disabled={activeTarget === 'none'}
          onClick={() => {
            if (activeTarget === 'collision-zone') onRemoveCollisionZone(selectedCollisionZoneId)
            else if (activeTarget === 'asset') onRemoveItem(selectedItemId)
          }}
          className="ml-1 flex h-8 items-center justify-center rounded-lg border border-red-500/20 px-2 text-xs font-semibold text-red-200 transition-colors hover:border-red-400/50 hover:bg-red-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-red-500/20 disabled:hover:bg-transparent"
        >
          {activeTarget === 'collision-zone' ? 'Remove zone' : 'Remove'}
        </button>
      </div>
    </div>
  )
}

export function resolveWorldsTransformToolbarTarget({
  collisionEditMode,
  selectedItem,
  selectedCollisionZone,
}: {
  collisionEditMode: boolean
  selectedItem: WorldSceneItem | null
  selectedCollisionZone: WorldCollisionZone | null
}): 'collision-zone' | 'asset' | 'none' {
  if (collisionEditMode && selectedCollisionZone) return 'collision-zone'
  if (selectedItem) return 'asset'
  return 'none'
}

export function formatWorldSceneItemLabel(item: Pick<WorldSceneItem, 'workspacePath' | 'id' | 'role'>, index: number): string {
  const fileName = item.workspacePath.split('/').at(-1) || item.id
  const roleSuffix = item.role === 'base-scene' ? ' · base' : ''
  return `${index + 1}. ${fileName}${roleSuffix}`
}

export default WorldsTransformToolbar

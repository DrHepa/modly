import type { ReactNode } from 'react'

import type { WorldSceneItem } from '../worldRenderableResolver.ts'

export type WorldsTransformMode = 'translate' | 'rotate' | 'scale'

interface WorldsTransformToolbarProps {
  items?: WorldSceneItem[]
  selectedItemId: string | null
  selectedItemIds?: string[]
  mode: WorldsTransformMode | null
  onSelectItem?: (itemId: string | null, options?: { preserveSelection?: boolean }) => void
  onModeChange: (mode: WorldsTransformMode | null) => void
  onRemoveItem?: (itemId: string | null) => void
  onToggleBaseSceneItem?: (itemId: string | null) => void
}

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
  selectedItemId,
  selectedItemIds = [],
  mode,
  onSelectItem = () => undefined,
  onModeChange,
  onRemoveItem = () => undefined,
  onToggleBaseSceneItem = () => undefined,
}: WorldsTransformToolbarProps): JSX.Element | null {
  const visibleItems = items.filter((item) => item.visible)
  if (visibleItems.length === 0) return null

  const selectedItem = selectedItemId ? visibleItems.find((item) => item.id === selectedItemId) ?? null : null
  const selectedItemCount = selectedItemIds.length

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
        {TRANSFORM_MODES.map((entry) => {
          const disabled = !selectedItem
          return (
            <button
              key={entry.mode}
              type="button"
              title={selectedItem ? entry.label : 'Select an asset to transform'}
              aria-label={entry.label}
              aria-pressed={mode === entry.mode}
              disabled={disabled}
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
          title={selectedItem ? 'Remove selected asset from scene' : 'Select an asset to remove'}
          aria-label="Remove selected asset"
          disabled={!selectedItem}
          onClick={() => onRemoveItem(selectedItemId)}
          className="ml-1 flex h-8 items-center justify-center rounded-lg border border-red-500/20 px-2 text-xs font-semibold text-red-200 transition-colors hover:border-red-400/50 hover:bg-red-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-red-500/20 disabled:hover:bg-transparent"
        >
          Remove
        </button>
      </div>
    </div>
  )
}

export function formatWorldSceneItemLabel(item: Pick<WorldSceneItem, 'workspacePath' | 'id' | 'role'>, index: number): string {
  const fileName = item.workspacePath.split('/').at(-1) || item.id
  const roleSuffix = item.role === 'base-scene' ? ' · base' : ''
  return `${index + 1}. ${fileName}${roleSuffix}`
}

export default WorldsTransformToolbar

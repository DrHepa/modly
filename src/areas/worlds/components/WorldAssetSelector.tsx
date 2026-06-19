import type { WorldAssetLibraryRenderable } from '../worldAssetLibraryService.ts'

export interface WorldAssetSelectorProps {
  open: boolean
  assets: WorldAssetLibraryRenderable[]
  selectedAssetId: string | null
  loading: boolean
  opening: boolean
  error: string | null
  onToggle: () => void
  onClose: () => void
  onRefresh: () => void
  onSelectAsset: (assetId: string) => void
  onOpenSelected: () => void
}

type WorldAssetScopeGroup = {
  sourceScope: WorldAssetLibraryRenderable['sourceScope']
  label: string
  assets: WorldAssetLibraryRenderable[]
}

const SOURCE_SCOPE_LABELS = {
  workflows: 'Workflows',
  exports: 'Exports',
} as const satisfies Record<WorldAssetLibraryRenderable['sourceScope'], string>

export function WorldAssetSelector({
  open,
  assets,
  selectedAssetId,
  loading,
  opening,
  error,
  onToggle,
  onClose,
  onRefresh,
  onSelectAsset,
  onOpenSelected,
}: WorldAssetSelectorProps): JSX.Element {
  const selectedAsset = assets.find((asset) => asset.id === selectedAssetId) ?? null
  const groups = groupWorldAssetsByScope(assets)
  const openDisabled = !selectedAsset?.openable || loading || opening
  const selectedMessage = selectedAsset
    ? describeWorldAssetOpenability(selectedAsset)
    : assets.length === 0
      ? 'No renderable workflow assets are indexed yet.'
      : 'Select an asset to open it in Worlds.'

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400
          ${open
            ? 'border-zinc-600 bg-zinc-700 text-zinc-100'
            : 'border-zinc-700/70 bg-zinc-900/85 text-zinc-300 hover:border-zinc-600 hover:text-zinc-100'
          }`}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
          <path d="M4 6h16" />
          <path d="M4 12h16" />
          <path d="M4 18h10" />
        </svg>
        Open asset
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="World asset selector"
          className="absolute left-0 top-full z-50 mt-1 flex w-[320px] max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-xl border border-zinc-700/60 bg-zinc-900/95 p-3 text-zinc-200 shadow-xl backdrop-blur"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">World assets</p>
              <p className="text-xs text-zinc-300">Open supported workflow renderables in Worlds.</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-zinc-800 px-2 py-1 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
            >
              Close
            </button>
          </div>

          <button
            type="button"
            onClick={onRefresh}
            disabled={loading || opening}
            className="self-start rounded-lg bg-zinc-800 px-2.5 py-1.5 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-700 disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
          >
            {loading ? 'Loading assets…' : 'Refresh assets'}
          </button>

          {loading ? (
            <p role="status" className="text-xs text-zinc-400">Loading workspace assets…</p>
          ) : groups.length === 0 ? (
            <p role="status" className="text-xs text-zinc-500">No renderable workflow assets are indexed yet.</p>
          ) : (
            <div role="list" aria-label="World asset options" className="max-h-64 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/45">
              {groups.map((group) => (
                <section key={group.sourceScope} role="group" aria-label={`${group.label} world assets`} className="border-b border-zinc-800 last:border-b-0">
                  <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-400">{group.label}</div>
                  {group.assets.map((asset) => {
                    const selected = asset.id === selectedAssetId
                    return (
                      <button
                        key={asset.id}
                        type="button"
                        role="listitem"
                        aria-pressed={selected}
                        aria-label={`Select world asset ${asset.name}`}
                        onClick={() => onSelectAsset(asset.id)}
                        className={`w-full border-t border-zinc-800 px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400
                          ${selected ? 'bg-violet-500/10 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800/80'}`}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-xs font-medium">{asset.name}</span>
                          <span className="shrink-0 text-[10px] uppercase tracking-wider text-zinc-500">{asset.type}</span>
                        </span>
                        <span className="mt-1 block text-[11px] text-zinc-500">{asset.openable ? 'Ready' : 'Unsupported'}</span>
                      </button>
                    )
                  })}
                </section>
              ))}
            </div>
          )}

          <p className="rounded-lg border border-zinc-800 bg-zinc-950/45 px-3 py-2 text-[11px] text-zinc-400">{selectedMessage}</p>
          {error ? <p role="alert" className="text-[11px] text-amber-300">{error}</p> : null}

          <button
            type="button"
            onClick={onOpenSelected}
            disabled={openDisabled}
            className="rounded-lg bg-violet-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-violet-500 disabled:bg-zinc-700 disabled:text-zinc-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
          >
            {opening ? 'Opening…' : 'Open selected asset'}
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function groupWorldAssetsByScope(assets: WorldAssetLibraryRenderable[]): WorldAssetScopeGroup[] {
  return (Object.keys(SOURCE_SCOPE_LABELS) as WorldAssetLibraryRenderable['sourceScope'][])
    .map((sourceScope) => ({
      sourceScope,
      label: SOURCE_SCOPE_LABELS[sourceScope],
      assets: assets.filter((asset) => asset.sourceScope === sourceScope),
    }))
    .filter((group) => group.assets.length > 0)
}

export function describeWorldAssetOpenability(asset: WorldAssetLibraryRenderable): string {
  if (asset.openable) return 'Ready to open in Worlds.'
  return 'Unsupported in Worlds.'
}

export default WorldAssetSelector

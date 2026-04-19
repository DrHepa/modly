import type { AnyExtension } from '@shared/types/electron.d'
import type { ModelOwnershipCapabilityState } from '@areas/models/modelOwnershipState'
export type { AnyExtension as Extension }
export type { ExtensionNode } from '@shared/types/electron.d'

import {
  DownloadMap,
  ICONS,
  IOBadge,
  NodeInstallControl,
  StatusBadge,
  TypePill,
  extInstallSummary,
  getNodeState,
} from './extensionShared'

interface Props {
  ext:              AnyExtension
  installedIds:     string[]
  downloading:      Record<string, { percent: number; file?: string; fileIndex?: number; totalFiles?: number }>
  ownershipStateById?: Record<string, ModelOwnershipCapabilityState>
  loadError?:       string
  disabled?:        boolean
  onInstall:        (node: ExtensionNode, fullId: string) => void
  onInstallAll:     (ext: AnyExtension) => void
  onPauseDownload:  (fullId: string) => void
  onCancelDownload: (fullId: string) => void
  onOpen:           (ext: AnyExtension) => void
}

export function ExtensionCard({
  ext, installedIds, downloading, loadError, disabled,
  onInstall, onInstallAll, onPauseDownload, onCancelDownload, onOpen,
}: Props): JSX.Element {
  const isModel = ext.type === 'model'
  const isLocal = typeof ext.source === 'string' && ext.source.startsWith('local://')
  const { total, done, installing, hasAvailable } = extInstallSummary(ext, installedIds, downloading)

export function ExtensionCard({ ext, installedIds, downloading, ownershipStateById, loadError, disabled, onInstall, onUninstall, onUninstallNode, onRepaired }: Props): JSX.Element {
  const [repairing,   setRepairing]   = useState(false)
  const [repairError, setRepairError] = useState<string | null>(null)

  const badge = TYPE_BADGE[ext.type] ?? TYPE_BADGE.model

  async function handleRepair() {
    setRepairing(true)
    setRepairError(null)
    const result = await window.electron.extensions.repair(ext.id)
    setRepairing(false)
    if (result.success) {
      onRepaired?.()
    } else {
      setRepairError(result.error ?? 'Repair failed')
    }
  }

  let status: JSX.Element
  if (loadError) {
    status = <StatusBadge tone="amber">Load error</StatusBadge>
  } else if (installing) {
    status = <StatusBadge tone="violet">Installing…</StatusBadge>
  } else if (!isModel) {
    status = <StatusBadge tone="green">Ready</StatusBadge>
  } else if (done === total) {
    status = <StatusBadge tone="green">All nodes ready</StatusBadge>
  } else {
    status = <StatusBadge tone="amber">{done}/{total} nodes installed</StatusBadge>
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleOpen}
      onKeyDown={handleKey}
      aria-label={`${ext.name} — open details`}
      className="relative flex flex-col min-h-[218px] p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800 overflow-hidden cursor-pointer transition-all duration-150 hover:bg-zinc-900 hover:border-zinc-700 hover:-translate-y-0.5 hover:shadow-[0_14px_30px_-14px_rgba(0,0,0,0.7)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className={`shrink-0 w-10 h-10 p-2.5 rounded-[11px] bg-zinc-800 ring-1 ring-inset ring-zinc-700/50 ${isModel ? 'text-accent-light' : 'text-emerald-400'}`}>
          {isModel ? ICONS.spark : ICONS.cube}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-zinc-100 truncate">{ext.name}</span>
            <TypePill type={ext.type} />
          </div>
          <div className="flex items-center gap-1.5 mt-1 text-[11px] text-zinc-600 flex-wrap">
            {ext.version && <span className="font-mono text-zinc-500">v{ext.version}</span>}
            {ext.version && ext.author && <span className="opacity-50">·</span>}
            {ext.author && <span>{ext.author}</span>}
            {ext.trusted && (
              <>
                <span className="opacity-50">·</span>
                <span className="inline-flex items-center gap-1 text-zinc-500">
                  <span className="w-[11px] h-[11px] text-accent-light">{ICONS.shield}</span>
                  Official
                </span>
              </>
            )}
            {isLocal && (
              <>
                <span className="opacity-50">·</span>
                <span className="text-orange-400/80">Local</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Description */}
      <p className="mt-3 text-xs leading-5 text-zinc-500 line-clamp-2 min-h-[2.5rem]">
        {ext.description?.trim() || '—'}
      </p>

      {/* Load error */}
      {loadError && (
        <div className="mt-2 px-2.5 py-1.5 rounded-lg bg-red-950/30 border border-red-800/30">
          <p className="text-[10px] text-red-400 line-clamp-1 break-all">{loadError}</p>
        </div>
      )}

      {/* Nodes */}
      {ext.nodes.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {ext.nodes.map((node) => {
            const fullId        = `${ext.id}/${node.id}`
            const hasWeights    = !!node.hfRepo
            const ownershipState = ownershipStateById?.[fullId]
            const installed     = !hasWeights || ownershipState?.downloaded || installedIds.includes(fullId)
            const dlInfo        = downloading[fullId]
            const isDownloading = dlInfo !== undefined
            const ownerDownloading = ownershipState?.isOwnerDownloading ?? false
            const dlPercent     = dlInfo?.percent ?? 0
            const dlFile        = dlInfo?.file?.split('/').pop()
            const dlFileIndex   = dlInfo?.fileIndex
            const dlTotalFiles  = dlInfo?.totalFiles
            const installDisabled = Boolean(disabled || ownershipState?.installDisabled)
            const deleteDisabled = Boolean(disabled || ownershipState?.deleteDisabled)
            const deleteTitle = ownershipState?.warning ?? (disabled ? 'Cannot delete while another action is in progress' : 'Remove owner-scoped model weights')
            const downloadTitle = ownershipState?.warning ?? (disabled ? 'Another action is already in progress' : `Download ${node.name} weights`)

            return (
              <div key={node.id} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                {/* Node name */}
                <span className="text-[11px] text-zinc-400 font-medium shrink-0 truncate" style={{ maxWidth: '5rem' }}>
                  {node.name}
                </span>

                {/* I/O types */}
                <div className="flex items-center gap-1 shrink-0">
                  <span className="text-[9px] text-zinc-600">{node.input}</span>
                  <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-700 shrink-0">
                    <path d="M5 12h14M13 6l6 6-6 6"/>
                  </svg>
                  <span className="text-[9px] text-zinc-600">{node.output}</span>
                </div>

                {/* Status (only for nodes that need model weights) */}
                <div className="flex-1 min-w-0">
                  {!hasWeights ? (
                    <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-950/40 border border-emerald-800/30">
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-emerald-400 shrink-0">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                      <span className="text-[10px] font-semibold text-emerald-400">Ready</span>
                    </div>
                  ) : isDownloading ? (
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-zinc-500 truncate max-w-[100px]" title={dlFile}>
                          {dlFile ?? 'Downloading…'}
                        </span>
                        <span className="text-[10px] font-mono text-zinc-400 shrink-0 ml-1">
                          {dlFileIndex && dlTotalFiles ? `${dlFileIndex}/${dlTotalFiles} · ${dlPercent}%` : `${dlPercent}%`}
                        </span>
                      </div>
                      <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-accent transition-all duration-300"
                          style={{ width: `${dlPercent}%` }}
                        />
                      </div>
                    </div>
                  ) : installed ? (
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-emerald-950/40 border border-emerald-800/30">
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-emerald-400 shrink-0">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                      <span className="text-[10px] font-semibold text-emerald-400 flex-1 truncate">{node.name}</span>
                      {ownershipState?.badges.map((badge) => (
                        <span
                          key={badge}
                          className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-md bg-sky-950/40 border border-sky-800/30 text-[9px] font-semibold text-sky-300"
                        >
                          {badge}
                        </span>
                      ))}
                      {onUninstallNode && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onUninstallNode(fullId) }}
                          disabled={deleteDisabled}
                          title={deleteTitle}
                          className="shrink-0 text-emerald-700 hover:text-red-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                          </svg>
                        </button>
                      )}
                    </div>
                  ) : isDownloading ? (
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-zinc-500 truncate max-w-[100px]" title={dlFile}>
                          {dlFile ?? 'Downloading…'}
                        </span>
                        <span className="text-[10px] font-mono text-zinc-400 shrink-0 ml-1">
                          {dlFileIndex && dlTotalFiles ? `${dlFileIndex}/${dlTotalFiles} · ${dlPercent}%` : `${dlPercent}%`}
                        </span>
                      </div>
                      <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-accent transition-all duration-300"
                          style={{ width: `${dlPercent}%` }}
                        />
                      </div>
                    </div>
                  ) : ownerDownloading ? (
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-sky-950/30 border border-sky-800/30">
                      <div className="w-2 h-2 rounded-full border border-sky-400/40 border-t-sky-200 animate-spin shrink-0" />
                      <span className="text-[10px] font-semibold text-sky-300 truncate">Shared download in progress</span>
                    </div>
                  ) : (
                    <button
                      onClick={() => !installDisabled && onInstall(node, fullId)}
                      disabled={installDisabled}
                      title={downloadTitle}
                      className={`w-full flex items-center justify-center gap-1 px-2 py-1 rounded-lg border text-[10px] font-semibold transition-all ${
                        !installDisabled
                          ? 'bg-accent/15 border-accent/25 text-accent-light hover:bg-accent/25 hover:border-accent/40 cursor-pointer'
                          : 'bg-zinc-800/40 border-zinc-700/30 text-zinc-600 cursor-not-allowed'
                      }`}
                    >
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                      </svg>
                      Download
                    </button>
                  )}
                </div>
                </div>

                {ownershipState?.warning && hasWeights && (
                  <div className="ml-auto w-[calc(100%-7rem)] flex items-start gap-1.5 px-2 py-1 rounded-lg bg-amber-950/20 border border-amber-900/30">
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-300 shrink-0 mt-px">
                      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    <p className="text-[10px] text-amber-200/90 leading-relaxed">{ownershipState.warning}</p>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Footer */}
      <div className="mt-auto pt-3 flex items-center justify-between gap-2">
        {status}
        {isModel && hasAvailable && !installing && (
          <button
            onClick={(e) => { e.stopPropagation(); onInstallAll(ext) }}
            disabled={disabled}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-accent/15 text-accent-light ring-1 ring-inset ring-accent/30 hover:bg-accent hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-accent/15 disabled:hover:text-accent-light"
          >
            <span className="w-3 h-3">{ICONS.download}</span>
            Install all
          </button>
        )}
      </div>
    </div>
  )
}

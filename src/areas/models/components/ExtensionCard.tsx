import { useState } from 'react'
import type { AnyExtension, ModelDownloadFailure, RuntimeReadiness, RuntimeReadinessAction, RuntimeReadinessDetails } from '@shared/types/electron.d'
import type { ModelOwnershipCapabilityState } from '@areas/models/modelOwnershipState'
export type { AnyExtension as Extension }
export type { ExtensionNode } from '@shared/types/electron.d'

type RuntimeReadinessActionIntent = 'show_modal' | 'confirm_then_dispatch' | 'dispatch' | 'disabled'
type RuntimeReadinessModalState = {
  mode: 'details' | 'guidance' | 'confirmation'
  title: string
  action?: RuntimeReadinessAction
  modelId: string
  details?: RuntimeReadinessDetails
  guidance?: string
}

interface Props {
  ext:              AnyExtension
  installedIds:     string[]
  downloading:      Record<string, { percent: number; file?: string; fileIndex?: number; totalFiles?: number; repoIndex?: number; totalRepos?: number; status?: string }>
  downloadFailures?: Record<string, ModelDownloadFailure>
  ownershipStateById?: Record<string, ModelOwnershipCapabilityState>
  runtimeReadinessById?: Record<string, RuntimeReadiness | undefined>
  loadError?:       string
  disabled?:        boolean
  onInstall:        (node: import('@shared/types/electron.d').ExtensionNode, fullId: string) => void
  onUninstall:      (extId: string) => void
  onUninstallNode?: (fullId: string) => void
  onRepaired?:      () => void
  onRuntimeReadinessAction?: (modelId: string, action: RuntimeReadinessAction) => Promise<{ success: boolean; error?: string }> | { success: boolean; error?: string }
}

export function ExtensionCard({
  ext, installedIds, downloading, loadError, disabled,
  onInstall, onInstallAll, onPauseDownload, onCancelDownload, onOpen,
}: Props): JSX.Element {
  const isModel = ext.type === 'model'
  const isLocal = typeof ext.source === 'string' && ext.source.startsWith('local://')
  const { total, done, installing, hasAvailable } = extInstallSummary(ext, installedIds, downloading)

export function ExtensionCard({ ext, installedIds, downloading, downloadFailures, ownershipStateById, runtimeReadinessById, loadError, disabled, onInstall, onUninstall, onUninstallNode, onRepaired, onRuntimeReadinessAction }: Props): JSX.Element {
  const [repairing,   setRepairing]   = useState(false)
  const [repairError, setRepairError] = useState<string | null>(null)
  const [runtimeModal, setRuntimeModal] = useState<RuntimeReadinessModalState | null>(null)

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

  async function handleRuntimeReadinessAction(modelId: string, action: RuntimeReadinessAction, readiness: RuntimeReadiness) {
    const intent = resolveRuntimeReadinessActionIntent(action)
    if (intent === 'disabled') return

    if (intent === 'show_modal') {
      const details = filterRuntimeReadinessDetailsForDisplay(readiness.details)
      setRuntimeModal({
        mode: action.kind === 'show_guidance' ? 'guidance' : 'details',
        title: action.label,
        modelId,
        action,
        details,
        guidance: action.guidance ?? details.guidance,
      })
      return
    }

    if (intent === 'confirm_then_dispatch') {
      setRuntimeModal({
        mode: 'confirmation',
        title: action.confirmation?.title ?? action.label,
        modelId,
        action,
        guidance: action.confirmation?.body ?? action.guidance,
      })
      return
    }

    await onRuntimeReadinessAction?.(modelId, action)
  }

  async function confirmRuntimeReadinessAction() {
    if (!runtimeModal?.action) return
    const { modelId, action } = runtimeModal
    setRuntimeModal(null)
    await onRuntimeReadinessAction?.(modelId, action)
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
            const runtimeReadiness = runtimeReadinessById?.[fullId]
            const runtimeLabel = runtimeReadiness?.ok ? null : resolveRuntimeReadinessLabel(runtimeReadiness)
            const visibleRuntimeActions = (runtimeReadiness?.actions ?? []).filter((action) => (
              action.kind === 'open_external_url' || action.kind === 'refresh_readiness'
            ))
            const hasHttpsDownloads = Boolean(node.httpsDownloads?.length)
            const hasWeights    = Boolean(hasHttpsDownloads || node.hfDownloads?.length || node.hfRepo)
            const ownershipState = ownershipStateById?.[fullId]
            const installed     = !hasWeights || ownershipState?.downloaded || (!hasHttpsDownloads && installedIds.includes(fullId))
            const runtimeReadinessCheckFailed = runtimeReadiness?.machine_code === 'checking_failed' || runtimeReadiness?.machine_code === 'check_failed'
            const showRuntimeReadinessAsStatus = Boolean(runtimeLabel && !runtimeReadinessCheckFailed && (!hasWeights || installed))
            const dlInfo        = downloading[fullId]
            const isDownloading = dlInfo !== undefined
            const ownerDownloading = ownershipState?.isOwnerDownloading ?? false
            const dlPercent     = dlInfo?.percent ?? 0
            const dlFile        = dlInfo?.file?.split('/').pop()
            const dlFileIndex   = dlInfo?.fileIndex
            const dlTotalFiles  = dlInfo?.totalFiles
            const dlRepoIndex   = dlInfo?.repoIndex
            const dlTotalRepos  = dlInfo?.totalRepos
            const downloadFailure = downloadFailures?.[fullId]
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
                  {showRuntimeReadinessAsStatus ? (
                    <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-zinc-800/50 border border-zinc-700/40">
                      <span className="text-[10px] font-semibold text-zinc-300">{runtimeLabel}</span>
                    </div>
                  ) : !hasWeights ? (
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
                          {`${dlRepoIndex && dlTotalRepos ? `R${dlRepoIndex}/${dlTotalRepos} · ` : ''}${dlFileIndex && dlTotalFiles ? `${dlFileIndex}/${dlTotalFiles} · ` : ''}${dlPercent}%`}
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
                          {`${dlRepoIndex && dlTotalRepos ? `R${dlRepoIndex}/${dlTotalRepos} · ` : ''}${dlFileIndex && dlTotalFiles ? `${dlFileIndex}/${dlTotalFiles} · ` : ''}${dlPercent}%`}
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
                  ) : downloadFailure?.retryable === false ? (
                    <div
                      aria-label="Download unavailable"
                      className="w-full flex items-center justify-center px-2 py-1 rounded-lg border bg-red-950/20 border-red-800/30 text-[10px] font-semibold text-red-300"
                    >
                      Download unavailable
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
                      {downloadFailure ? 'Retry' : 'Download'}
                    </button>
                  )}
                </div>
                </div>

                {downloadFailure && !isDownloading && !installed && (
                  <div role="alert" className="flex items-start gap-1.5 px-2.5 py-2 rounded-lg bg-red-950/30 border border-red-800/30">
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400 shrink-0 mt-px">
                      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    <div className="min-w-0">
                      <p className="text-[10px] font-semibold text-red-300">
                        {downloadFailure.stage}: {downloadFailure.message}
                      </p>
                      {downloadFailure.file && (
                        <p className="text-[9px] text-red-400/80 truncate" title={downloadFailure.file}>
                          {downloadFailure.file}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {runtimeLabel && visibleRuntimeActions.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pl-0.5">
                    {visibleRuntimeActions.map((action) => (
                      <button
                        key={action.id}
                        onClick={() => {
                          if (!runtimeReadiness) return
                          handleRuntimeReadinessAction(fullId, action, runtimeReadiness)
                        }}
                        disabled={Boolean(action.disabled || disabled)}
                        title={action.disabled ? action.reason : action.guidance}
                        className="px-2 py-1 rounded-md bg-zinc-800/70 border border-zinc-700/50 text-[10px] font-semibold text-zinc-300 hover:bg-zinc-700/70 disabled:opacity-50 disabled:cursor-not-allowed"
                      >{action.label}</button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {runtimeModal && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="absolute inset-0 bg-zinc-950/70" onClick={() => setRuntimeModal(null)} />
          <div className="relative w-96 rounded-2xl bg-zinc-900 border border-zinc-700 shadow-2xl p-5 flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-zinc-100">{runtimeModal.title}</h2>
            {runtimeModal.guidance && <p className="text-xs text-zinc-400 leading-relaxed">{runtimeModal.guidance}</p>}
            {runtimeModal.details && Object.keys(runtimeModal.details).length > 0 && <RuntimeReadinessDetailsPanel details={runtimeModal.details} />}
            <div className="flex gap-2 pt-2">
              <button onClick={() => setRuntimeModal(null)} className="flex-1 py-2 rounded-lg bg-zinc-800 text-xs text-zinc-300">Cancel</button>
              {runtimeModal.mode === 'confirmation' && (
                <button onClick={confirmRuntimeReadinessAction} className="flex-1 py-2 rounded-lg bg-accent text-xs font-semibold text-white">
                  {runtimeModal.action?.confirmation?.confirm_label ?? runtimeModal.action?.label ?? 'Continue'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function RuntimeReadinessDetailsPanel({ details }: { details: RuntimeReadinessDetails }): JSX.Element {
  const entries = [
    ...Object.entries(details.diagnostics ?? {}),
    ...Object.entries(details.evidence ?? {}),
  ]

  return (
    <div className="flex flex-col gap-1.5 px-2.5 py-2 rounded-lg bg-zinc-900/70 border border-zinc-800/70">
      {details.title && <p className="text-[10px] font-semibold text-zinc-300">{details.title}</p>}
      {details.summary && <p className="text-[10px] text-zinc-500 leading-relaxed">{details.summary}</p>}
      {details.guidance && <p className="text-[10px] text-zinc-500 leading-relaxed">{details.guidance}</p>}
      {entries.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
          {entries.map(([key, value]) => (
            <div key={`${key}:${value}`} className="contents">
              <dt className="text-[9px] text-zinc-600 font-mono">{key}</dt>
              <dd className="text-[9px] text-zinc-400 font-mono break-all">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

export function resolveRuntimeReadinessActionIntent(action: RuntimeReadinessAction): RuntimeReadinessActionIntent {
  if (action.disabled) return 'disabled'
  if (action.kind === 'show_guidance' || action.kind === 'show_details') return 'show_modal'
  if (action.kind === 'open_external_url' && (action.requires_confirmation || action.safety === 'confirm')) return 'confirm_then_dispatch'
  return 'dispatch'
}

export function filterRuntimeReadinessDetailsForDisplay(details: RuntimeReadinessDetails | undefined): RuntimeReadinessDetails {
  if (!details) return {}
  const filtered: RuntimeReadinessDetails = {}
  if (details.title && isSafeReadinessText(details.title, 240)) filtered.title = details.title
  if (details.summary && isSafeReadinessText(details.summary, 2_000)) filtered.summary = details.summary
  if (details.guidance && isSafeReadinessText(details.guidance, 2_000)) filtered.guidance = details.guidance

  const diagnostics = filterRuntimeReadinessDiagnosticMap(details.diagnostics)
  const evidence = filterRuntimeReadinessDiagnosticMap(details.evidence)
  if (Object.keys(diagnostics).length > 0) filtered.diagnostics = diagnostics
  if (Object.keys(evidence).length > 0) filtered.evidence = evidence
  return filtered
}

const SAFE_RUNTIME_DETAIL_KEYS = new Set([
  'runtime_source',
  'runtime_name',
  'runtime_version',
  'runtime_version_supported',
  'supported_versions',
  'platform_supported',
  'platform_key',
  'auth_state',
  'entitlement_state',
  'extension_setup_state',
  'extension_import_state',
  'codex_app_server_state',
  'readiness_source',
  'diagnostic_status',
  'last_checked_at',
])

function filterRuntimeReadinessDiagnosticMap(map: Record<string, string> | undefined): Record<string, string> {
  if (!map) return {}
  const filtered: Record<string, string> = {}
  for (const [key, value] of Object.entries(map)) {
    if (SAFE_RUNTIME_DETAIL_KEYS.has(key) && isSafeReadinessText(value, 240)) {
      filtered[key] = value
    }
  }
  return filtered
}

function isSafeReadinessText(value: string, maxLength: number): boolean {
  const text = value.trim()
  return Boolean(text) && text.length <= maxLength && !/\.\.|token\s*=|secret|api[_-]?key|raw output|command output|\b[A-Z_]{3,}=|(?:^|\s)(?:\/[\w.-]+){2,}|[A-Za-z]:\\/i.test(text)
}

function resolveRuntimeReadinessLabel(readiness?: RuntimeReadiness): string | null {
  if (!readiness) return null
  if (readiness.machine_code === 'unsupported_contract') return null
  if (readiness.label_hint) return readiness.label_hint
  if (readiness.ok || readiness.machine_code === 'ready') return 'Ready'

  switch (readiness.machine_code) {
    case 'preflight/codex_missing': return 'Setup Codex'
    case 'preflight/not_authenticated':
    case 'preflight/no_entitlement': return 'Login'
    case 'preflight/unsupported_version': return 'Update Codex'
    case 'preflight/unsupported_platform': return 'Unsupported'
    case 'checking_failed': return 'Checking failed'
    default: return null
  }
}

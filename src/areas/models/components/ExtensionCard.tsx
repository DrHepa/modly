import { useEffect, useId, useRef, useState } from 'react'
import type { AnyExtension, RuntimeReadiness, RuntimeReadinessAction, RuntimeReadinessDetails } from '@shared/types/electron.d'
import type { ModelOwnershipCapabilityState } from '../modelOwnershipState'
import type { ExtensionNode } from '@shared/types/electron.d'
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
  downloading:      DownloadMap
  ownershipStateById?: Record<string, ModelOwnershipCapabilityState>
  runtimeReadinessById?: Record<string, RuntimeReadiness | undefined>
  runtimeReadinessActionLoadingById?: Record<string, boolean>
  runtimeReadinessActionErrorById?: Record<string, string | null>
  loadError?:       string
  disabled?:        boolean
  onInstall:        (node: ExtensionNode, fullId: string) => void
  onInstallAll:     (ext: AnyExtension) => void
  onPauseDownload:  (fullId: string) => void
  onCancelDownload: (fullId: string) => void
  onOpen:           (ext: AnyExtension) => void
  onRuntimeReadinessAction?: (modelId: string, action: RuntimeReadinessAction) => Promise<{ success: boolean; error?: string }> | { success: boolean; error?: string }
}

export function ExtensionCard({
  ext, installedIds, downloading, ownershipStateById, runtimeReadinessById, loadError, disabled,
  runtimeReadinessActionLoadingById, runtimeReadinessActionErrorById,
  onInstall, onInstallAll, onPauseDownload, onCancelDownload, onOpen, onRuntimeReadinessAction,
}: Props): JSX.Element {
  const [runtimeModal, setRuntimeModal] = useState<RuntimeReadinessModalState | null>(null)
  useEffect(() => { setRuntimeModal(null) }, [ext, runtimeReadinessById])
  const isModel = ext.type === 'model'
  const isLocal = typeof ext.source === 'string' && ext.source.startsWith('local://')
  const { total, done, installing, hasAvailable } = extInstallSummary(ext, installedIds, downloading)

  const handleOpen = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    onOpen(ext)
  }
  const handleKey = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpen(ext)
    }
  }

  async function handleRuntimeReadinessAction(modelId: string, action: RuntimeReadinessAction, readiness: RuntimeReadiness) {
    const intent = resolveRuntimeReadinessActionIntent(action)
    if (intent === 'disabled' || disabled || runtimeReadinessActionLoadingById?.[`${modelId}:${action.id}`]) return

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
    if (disabled || action.disabled || runtimeReadinessActionLoadingById?.[`${modelId}:${action.id}`]
        || !runtimeReadinessById?.[modelId]?.actions?.includes(action)) return
    await onRuntimeReadinessAction?.(modelId, action)
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
            const fullId = `${ext.id}/${node.id}`
            const state = getNodeState(ext.id, node, installedIds, downloading)
            const ownership = ownershipStateById?.[fullId]
            const capabilityId = node.capabilityId ?? fullId
            const runtimeReadiness = runtimeReadinessById?.[capabilityId]
            const runtimeLabel = resolveRuntimeReadinessLabel(runtimeReadiness)
            const runtimeDetails = filterRuntimeReadinessDetailsForDisplay(runtimeReadiness?.details)
            return (
              <div
                key={node.id}
                className="flex flex-wrap items-center justify-between gap-2.5 px-2.5 py-1.5 rounded-lg bg-white/[0.02] border border-zinc-800"
              >
                <div className="flex flex-col gap-1 min-w-0 items-start">
                  <span className="text-xs font-medium text-zinc-200 truncate max-w-full">
                    {node.name}
                    {isModel && node.weightVariants && (
                      <span className="font-normal text-zinc-500"> · {node.weightVariants.options.length} variants</span>
                    )}
                  </span>
                  <IOBadge node={node} />
                  {isModel && runtimeLabel && (
                    <span role="status" aria-label={`Runtime: ${runtimeLabel}`} className="text-[10px] text-zinc-300">
                      Runtime: <span>{runtimeLabel}</span>
                    </span>
                  )}
                  {ownership?.sharedOwner && <span className="text-[10px] text-sky-300" title={ownership.warning ?? undefined}>Shared weights</span>}
                  {ownership?.warning && <p className="text-[10px] text-amber-300 leading-relaxed">{ownership.warning}</p>}
                </div>
                {isModel && (
                  <div className="shrink-0">
                    <NodeInstallControl
                      state={state}
                      disabled={disabled || Boolean(ownership?.isOwnerDownloading && state.kind !== 'downloading')}
                      onInstall={() => onInstall(node, fullId)}
                      onPause={() => onPauseDownload(fullId)}
                      onResume={() => onInstall(node, fullId)}
                      onCancel={() => onCancelDownload(fullId)}
                    />
                  </div>
                )}

                {isModel && runtimeReadiness?.machine_code !== 'unsupported_contract' && runtimeReadiness?.actions && runtimeReadiness.actions.length > 0 && (
                  <div className="w-full flex flex-wrap gap-1.5 pl-0.5">
                    {runtimeReadiness.actions.map((action) => (
                      <button
                        key={action.id}
                        onClick={(event) => { event.stopPropagation(); void handleRuntimeReadinessAction(capabilityId, action, runtimeReadiness) }}
                        disabled={Boolean(action.disabled || disabled || runtimeReadinessActionLoadingById?.[`${capabilityId}:${action.id}`])}
                        aria-busy={runtimeReadinessActionLoadingById?.[`${capabilityId}:${action.id}`] || undefined}
                        title={action.disabled ? action.reason : action.kind === 'refresh_readiness'
                          ? 'Refresh status; backend checks may be cached for up to 30 seconds.' : action.guidance}
                        className="px-2 py-1 rounded-md bg-zinc-800/70 border border-zinc-700/50 text-[10px] font-semibold text-zinc-300 hover:bg-zinc-700/70 disabled:opacity-50 disabled:cursor-not-allowed"
                      >{action.label}</button>
                    ))}
                    {runtimeReadiness.actions.map((action) => {
                      const error = runtimeReadinessActionErrorById?.[`${capabilityId}:${action.id}`]
                      return error ? <p key={`error:${action.id}`} role="alert" className="w-full text-xs text-amber-300">{error}</p> : null
                    })}
                  </div>
                )}

                {isModel && runtimeReadiness?.machine_code !== 'unsupported_contract' && Object.keys(runtimeDetails).length > 0 && (
                  <RuntimeReadinessDetailsPanel details={runtimeDetails} />
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

      {runtimeModal && (
        <RuntimeReadinessDialog modal={runtimeModal} disabled={disabled}
          onClose={() => setRuntimeModal(null)} onConfirm={confirmRuntimeReadinessAction} />
      )}
    </div>
  )
}

export function RuntimeReadinessDialog({ modal, disabled, onClose, onConfirm }: {
  modal: RuntimeReadinessModalState
  disabled?: boolean
  onClose: () => void
  onConfirm: () => void
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => { dialog?.close() }
  }, [])
  return (
    <dialog ref={dialogRef} aria-labelledby={titleId} aria-modal="true" onCancel={onClose}
      onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}
      className="w-96 max-w-[90vw] max-h-[85vh] overflow-auto rounded-2xl bg-zinc-900 border border-zinc-700 shadow-2xl p-5 backdrop:bg-zinc-950/70">
      <h2 id={titleId} className="text-sm font-semibold text-zinc-100">{modal.title}</h2>
      {modal.guidance && <p className="mt-3 text-xs text-zinc-400 leading-relaxed">{modal.guidance}</p>}
      {modal.details && <RuntimeReadinessDetailsPanel details={modal.details} />}
      <div className="flex gap-2 pt-3">
        <button autoFocus onClick={onClose} className="flex-1 py-2 rounded-lg bg-zinc-800 text-xs text-zinc-300">Cancel</button>
        {modal.mode === 'confirmation' && (
          <button disabled={disabled} onClick={onConfirm} className="flex-1 py-2 rounded-lg bg-accent text-xs font-semibold text-white disabled:opacity-50">
            {modal.action?.confirmation?.confirm_label ?? modal.action?.label ?? 'Continue'}
          </button>
        )}
      </div>
    </dialog>
  )
}

function RuntimeReadinessDetailsPanel({ details }: { details: RuntimeReadinessDetails }): JSX.Element {
  const entries = [
    ...Object.entries(details.diagnostics ?? {}),
    ...Object.entries(details.evidence ?? {}),
  ]

  return (
    <div className="w-full flex flex-col gap-1.5 px-2.5 py-2 rounded-lg bg-zinc-900/70 border border-zinc-800/70">
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
  if (action.kind !== 'open_external_url' && action.kind !== 'refresh_readiness') return 'disabled'
  if (action.requires_confirmation || action.safety === 'confirm') return 'confirm_then_dispatch'
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

function isSafeReadinessText(value: unknown, maxLength: number): value is string {
  if (typeof value !== 'string') return false
  const text = value.trim()
  return Boolean(text) && text.length <= maxLength && !/\.\.|token\s*=|secret|api[_-]?key|raw output|command output|\b[A-Z_]{3,}=|(?:^|\s)(?:\/[\w.-]+){2,}|\b[A-Za-z]:[\\/]/i.test(text)
}

function resolveRuntimeReadinessLabel(readiness?: RuntimeReadiness): string | null {
  if (!readiness) return null
  if (readiness.machine_code === 'unsupported_contract') return null
  if (readiness.stale) return 'Checking failed (stale)'
  if (readiness.label_hint) return readiness.label_hint
  if (readiness.ok || readiness.machine_code === 'ready') return 'Ready'

  switch (readiness.machine_code) {
    case 'preflight/codex_missing': return 'Setup Codex'
    case 'preflight/not_authenticated':
    case 'preflight/no_entitlement': return 'Login'
    case 'preflight/unsupported_version': return 'Update Codex'
    case 'preflight/unsupported_platform': return 'Unsupported'
    case 'checking_failed': return 'Checking failed'
    case 'check_failed': return 'Checking failed'
    default: return null
  }
}

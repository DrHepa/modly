import { create } from 'zustand'
import { collectModelOwnershipMetadata, collectReadyOwnerIds } from '../../areas/models/modelOwnershipState'
import type { ModelExtension, ProcessExtension, AnyExtension, ExtensionInstallResult, ExtensionInstallProgress, InstalledExtensionResult, RuntimeReadiness, RuntimeReadinessAction, RuntimeReadinessDetails } from '@shared/types/electron.d'

const RUNTIME_READINESS_TTL_MS = 30_000
const MAX_ACTIONS = 5
const ACTION_ID_RE = /^[a-z0-9._:-]{1,80}$/
const ALLOWED_DIAGNOSTIC_KEYS = new Set([
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

type RuntimeReadinessCacheEntry = RuntimeReadiness & { received_at?: number }

// ─── Re-exports for consumers ─────────────────────────────────────────────────

export type { ModelExtension, ProcessExtension, AnyExtension }


export type InstallStep = ExtensionInstallProgress['step']
export type InstallProgress = ExtensionInstallProgress
export type InstallResult = ExtensionInstallResult

// ─── Store ────────────────────────────────────────────────────────────────────

interface ExtensionsStore {
  modelExtensions:   ModelExtension[]
  processExtensions: ProcessExtension[]
  readyOwnerIds: string[]
  refreshModelOwnership: (extensions?: ModelExtension[]) => Promise<void>
  loading:           boolean
  installProgress:   InstallProgress | null
  installError:      string | null
  installResult:     InstallResult | null
  loadErrors:        Record<string, string>
  /** Installed weight variant ids, keyed by "ext_id/node_id", for nodes that declare variants */
  installedWeightVariants: Record<string, string[]>
  runtimeReadinessById: Record<string, RuntimeReadinessCacheEntry>
  runtimeReadinessLoadingById: Record<string, boolean>
  runtimeReadinessActionLoadingById: Record<string, boolean>
  runtimeReadinessActionErrorById: Record<string, string | null>

  loadExtensions:    () => Promise<void>
  refreshInstalledWeightVariants: () => Promise<void>
  installFromGitHub: (url: string) => Promise<InstallResult>
  installFromLocal:  () => Promise<{ success: boolean; error?: string; cancelled?: boolean; needsRepair?: boolean }>
  uninstall:         (extensionId: string) => Promise<{ success: boolean; error?: string }>
  reload:            () => Promise<void>
  ensureRuntimeReadiness: (modelIds: string[], options?: { force?: boolean }) => Promise<void>
  invalidateRuntimeReadiness: () => void
  runRuntimeReadinessAction: (
    modelId: string,
    action: RuntimeReadinessAction,
    options?: { dispatch?: (action: RuntimeReadinessAction) => Promise<{ success: boolean; error?: string }> },
  ) => Promise<{ success: boolean; error?: string }>
  clearInstallState: () => void
}

export function partitionExtensionsByType(list: AnyExtension[]): {
  modelExtensions: ModelExtension[]
  processExtensions: ProcessExtension[]
} {
  return {
    modelExtensions: list.filter((extension): extension is ModelExtension =>
      extension.type === 'model',
    ),
    processExtensions: list.filter((extension): extension is ProcessExtension =>
      extension.type === 'process',
    ),
  }
}

let runtimeReadinessEpoch = 0
const runtimeReadinessInFlight = new Map<string, Promise<void>>()

export const useExtensionsStore = create<ExtensionsStore>((set, get) => ({
  modelExtensions:   [],
  processExtensions: [],
  readyOwnerIds: [],
  loading:           false,
  installProgress:   null,
  installError:      null,
  installResult:     null,
  loadErrors:        {},
  installedWeightVariants: {},
  runtimeReadinessById: {},
  runtimeReadinessLoadingById: {},
  runtimeReadinessActionLoadingById: {},
  runtimeReadinessActionErrorById: {},

  // ── Load list ──────────────────────────────────────────────────────────────

  async loadExtensions() {
    get().invalidateRuntimeReadiness()
    set({ loading: true })
    try {
      const list = (await window.electron.extensions.list()) as AnyExtension[]
      const extensions = partitionExtensionsByType(list)
      set({
        ...extensions,
        loading:           false,
      })
      await Promise.all([get().refreshInstalledWeightVariants(), get().refreshModelOwnership()])
      // Optional diagnostics must not delay installed/download-state recovery.
      void get().ensureRuntimeReadiness(collectRuntimeReadinessModelIds(extensions.modelExtensions))
    } catch {
      set({ loading: false })
    }
  },

  async refreshModelOwnership(extensions) {
    const currentExtensions = get().modelExtensions
    const modelExtensions = extensions ?? currentExtensions
    const metadata = collectModelOwnershipMetadata(modelExtensions)
    const ready = await Promise.all(metadata.map(async (capability) => {
      try { return await window.electron.model.isDownloaded(capability.capabilityId) ? capability.capabilityId : null }
      catch { return null }
    }))
    // Ignore stale results if an install/uninstall replaced the model list.
    if (currentExtensions !== get().modelExtensions) return
    set({ readyOwnerIds: collectReadyOwnerIds(metadata, ready.filter((id): id is string => id !== null)) })
  },

  async refreshInstalledWeightVariants() {
    const entries = await Promise.all(
      get().modelExtensions.flatMap((ext) => ext.nodes
        .filter((node) => node.weightVariants)
        .map(async (node) => {
          const fullId = `${ext.id}/${node.id}`
          return [fullId, await window.electron.model.installedWeightVariants(fullId)] as const
        })),
    )
    // A node whose state could not be read stays absent: undefined reads as "unknown",
    // which the UI keeps neutral, while [] would claim no variant is installed.
    set({
      installedWeightVariants: Object.fromEntries(
        entries.filter((entry): entry is readonly [string, string[]] => entry[1] !== null),
      ),
    })
  },

  // ── Install from GitHub ────────────────────────────────────────────────────

  async installFromGitHub(url: string) {
    get().invalidateRuntimeReadiness()
    set({ installProgress: { step: 'downloading', percent: 0, success: false }, installError: null, installResult: null })

    window.electron.extensions.onInstallProgress((data) => {
      const progress = data as InstallProgress

      if (progress.step === 'error' && progress.status !== 'partial') {
        set({ installProgress: null, installError: progress.message ?? progress.error ?? 'Unknown error' })
      } else {
        set({ installProgress: progress })
      }
    })

    try {
      const result = normalizeInstallResult(await window.electron.extensions.installFromGitHub(url))
      const installedExtensions = result.installed.map((entry) => entry.extension)

      if (result.success && installedExtensions.length > 0) {
        const shouldRefreshOwnership = installedExtensions.some((extension) => extension.type === 'model')
        const mergedCollections = mergeInstalledExtensions({
          modelExtensions: get().modelExtensions,
          processExtensions: get().processExtensions,
          installed: installedExtensions,
        })

        set({
          ...mergedCollections,
          installProgress: buildDoneInstallProgress(result),
          installError: null,
          installResult: result,
        })

        if (shouldRefreshOwnership) {
          await get().refreshModelOwnership(mergedCollections.modelExtensions)
          await get().refreshInstalledWeightVariants()
        }
      } else if (result.success) {
        set({
          installProgress: buildDoneInstallProgress(result),
          installError: null,
          installResult: result,
        })
      } else {
        set({ installProgress: null, installError: result.error ?? 'Installation failed', installResult: result })
      }

      return result
    } catch (err) {
      const error = String(err)
      const result: InstallResult = {
        success: false,
        status: 'error',
        installed: [],
        failed: [],
        warnings: [],
        reloaded: false,
        error,
      }

      set({ installProgress: null, installError: error, installResult: result })
      return result
    } finally {
      window.electron.extensions.offInstallProgress()
    }
  },

  // ── Install from local folder ──────────────────────────────────────────────

  async installFromLocal() {
    get().invalidateRuntimeReadiness()
    const result = await installExtension(() => window.electron.extensions.installFromLocal(), set)
    // If user cancelled the folder picker, treat as a no-op (not an error)
    if ((result as any).cancelled) {
      set({ installProgress: null, installError: null, installResult: null })
      return { success: false, cancelled: true }
    }
    await get().refreshModelOwnership()
    return result
  },

  // ── Uninstall ──────────────────────────────────────────────────────────────

  async uninstall(extensionId: string) {
    get().invalidateRuntimeReadiness()
    const result = await window.electron.extensions.uninstall(extensionId)
    if (result.success) {
      set((state) => ({
        modelExtensions:   state.modelExtensions.filter((e)   => e.id !== extensionId),
        processExtensions: state.processExtensions.filter((e) => e.id !== extensionId),
      }))
    }
    await get().refreshModelOwnership()
    return result
  },

  // ── Reload (rescan extensions dir + Python registry) ──────────────────────

  async reload() {
    get().invalidateRuntimeReadiness()
    const result = await window.electron.extensions.reload()
    if (result.success) {
      set({ loadErrors: result.errors ?? {} })
    }
    await get().loadExtensions()
  },

  invalidateRuntimeReadiness() {
    runtimeReadinessEpoch += 1
    runtimeReadinessInFlight.clear()
    set({ runtimeReadinessById: {}, runtimeReadinessLoadingById: {}, runtimeReadinessActionLoadingById: {}, runtimeReadinessActionErrorById: {} })
  },

  async ensureRuntimeReadiness(modelIds, options) {
    const epoch = runtimeReadinessEpoch
    const modelExtensions = get().modelExtensions
    const now = Date.now()
    const uniqueIds = [...new Set(modelIds.map((id) => id.trim()).filter(Boolean))]
    const waits = uniqueIds.flatMap((id) => {
      const pending = runtimeReadinessInFlight.get(id)
      return pending ? [pending] : []
    })
    const idsToFetch = uniqueIds.filter((id) => {
      if (runtimeReadinessInFlight.has(id)) return false
      const cached = get().runtimeReadinessById[id]
      return options?.force || !cached?.received_at || now - cached.received_at >= RUNTIME_READINESS_TTL_MS
    })

    if (idsToFetch.length === 0) {
      await Promise.all(waits)
      return
    }
    const isCurrent = () => epoch === runtimeReadinessEpoch && modelExtensions === get().modelExtensions
    set((state) => ({
      runtimeReadinessLoadingById: {
        ...state.runtimeReadinessLoadingById,
        ...Object.fromEntries(idsToFetch.map((id) => [id, true])),
      },
    }))
    // Publish per-id ownership before even a synchronous IPC failure can settle.
    const run = Promise.resolve().then(async () => {
      try {
        const result = await window.electron.model.runtimeReadiness(idsToFetch)
        if (!isCurrent()) return
        const receivedAt = Date.now()
        set((state) => ({
          runtimeReadinessById: mergeRuntimeReadinessResponse(state.runtimeReadinessById, idsToFetch, result.models, result.success, receivedAt),
        }))
      } catch {
        if (!isCurrent()) return
        const receivedAt = Date.now()
        set((state) => ({
          runtimeReadinessById: mergeRuntimeReadinessResponse(state.runtimeReadinessById, idsToFetch, {}, false, receivedAt),
        }))
      } finally {
        if (isCurrent()) set((state) => ({
          runtimeReadinessLoadingById: {
            ...state.runtimeReadinessLoadingById,
            ...Object.fromEntries(idsToFetch.map((id) => [id, false])),
          },
        }))
        for (const id of idsToFetch) {
          if (runtimeReadinessInFlight.get(id) === run) runtimeReadinessInFlight.delete(id)
        }
      }
    })

    for (const id of idsToFetch) runtimeReadinessInFlight.set(id, run)
    await Promise.all([...waits, run])
  },

  async runRuntimeReadinessAction(modelId, action, options) {
    const sanitized = sanitizeRuntimeReadinessActions([action])[0]
    if (!sanitized || sanitized.disabled || typeof modelId !== 'string'
        || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(modelId)
        || !['refresh_readiness', 'open_external_url'].includes(sanitized.kind)) {
      return { success: false, error: 'Runtime readiness action is unavailable.' }
    }
    action = sanitized
    const actionKey = buildRuntimeReadinessActionKey(modelId, action.id)
    if (get().runtimeReadinessActionLoadingById[actionKey]) {
      return { success: false, error: 'Runtime readiness action is already running.' }
    }
    const epoch = runtimeReadinessEpoch
    const extensions = get().modelExtensions
    const isCurrent = () => epoch === runtimeReadinessEpoch && extensions === get().modelExtensions
    set((state) => ({
      runtimeReadinessActionLoadingById: { ...state.runtimeReadinessActionLoadingById, [actionKey]: true },
      runtimeReadinessActionErrorById: { ...state.runtimeReadinessActionErrorById, [actionKey]: null },
    }))

    try {
      let result: { success: boolean; error?: string }
      if (action.kind === 'refresh_readiness') {
        // Force bypasses only the renderer cache, not the backend diagnostic TTL.
        await get().ensureRuntimeReadiness([modelId], { force: true })
        const readiness = get().runtimeReadinessById[modelId]
        result = isCurrent() && readiness && !readiness.stale
          && !['check_failed', 'checking_failed'].includes(readiness.machine_code)
          ? { success: true }
          : { success: false, error: 'Runtime readiness check failed.' }
      } else if (options?.dispatch) {
        result = normalizeRuntimeReadinessActionResult(await options.dispatch(action))
        if (isCurrent() && (action.refresh_after === 'always' || (action.refresh_after === 'success' && result.success))) {
          await get().ensureRuntimeReadiness([modelId], { force: true })
        }
      } else {
        result = { success: false, error: 'Runtime readiness action requires explicit UI dispatch.' }
      }

      if (!isCurrent()) return { success: false, error: 'Runtime readiness action is no longer current.' }
      set((state) => ({
        runtimeReadinessActionErrorById: {
          ...state.runtimeReadinessActionErrorById,
          [actionKey]: result.success ? null : sanitizeRuntimeActionError(result.error),
        },
      }))
      return result.success ? { success: true } : { success: false, error: sanitizeRuntimeActionError(result.error) }
    } catch {
      const result = { success: false, error: 'Runtime readiness action failed.' }
      if (isCurrent()) set((state) => ({
        runtimeReadinessActionErrorById: {
          ...state.runtimeReadinessActionErrorById,
          [actionKey]: result.error,
        },
      }))
      return result
    } finally {
      if (isCurrent()) set((state) => ({
        runtimeReadinessActionLoadingById: { ...state.runtimeReadinessActionLoadingById, [actionKey]: false },
      }))
    }
  },

  // ── Helpers ────────────────────────────────────────────────────────────────

  clearInstallState() {
    set({ installProgress: null, installError: null, installResult: null })
  },
}))

async function installExtension(
  invoke: () => Promise<{
    success: boolean
    error?: string
    extension?: AnyExtension
    extensionId?: string
    needsRepair?: boolean
  }>,
  set: (partial: Partial<ExtensionsStore> | ((state: ExtensionsStore) => Partial<ExtensionsStore>)) => void,
) {
    set({ installProgress: { step: 'downloading', percent: 0 }, installError: null, installResult: null })

    window.electron.extensions.onInstallProgress((data) => {
      if (data.step === 'error') {
        set({ installProgress: null, installError: data.message ?? 'Unknown error' })
      } else {
        set({ installProgress: data as InstallProgress })
      }
    })

    try {
      const result = await invoke()

      if (result.success && result.extension) {
        const ext = result.extension as AnyExtension
        set((state) => {
          if (ext.type === 'process') {
            const filtered = state.processExtensions.filter((e) => e.id !== ext.id)
            return {
              processExtensions: [...filtered, ext],
              modelExtensions: state.modelExtensions.filter((e) => e.id !== ext.id),
              installProgress:   { step: 'done', extensionId: result.extensionId },
              installError:      null,
            }
          } else {
            const filtered = state.modelExtensions.filter((e) => e.id !== ext.id)
            return {
              modelExtensions: [...filtered, ext],
              processExtensions: state.processExtensions.filter((e) => e.id !== ext.id),
              installProgress: { step: 'done', extensionId: result.extensionId },
              installError:    null,
            }
          }
        })
      } else if (result.needsRepair && result.extension) {
        const ext = result.extension as AnyExtension
        const error = result.error ?? 'Extension setup is incomplete. Click Repair and retry.'
        set((state) => ({
          modelExtensions: ext.type === 'model'
            ? [...state.modelExtensions.filter((entry) => entry.id !== ext.id), ext]
            : state.modelExtensions.filter((entry) => entry.id !== ext.id),
          processExtensions: ext.type === 'process'
            ? [...state.processExtensions.filter((entry) => entry.id !== ext.id), ext]
            : state.processExtensions.filter((entry) => entry.id !== ext.id),
          loadErrors: { ...state.loadErrors, [ext.id]: error },
          installProgress: null,
          installError: error,
        }))
      } else {
        set({ installProgress: null, installError: result.error ?? 'Installation failed' })
      }

      return result
    } catch (err) {
      const error = String(err)
      set({ installProgress: null, installError: error })
      return { success: false, error }
    } finally {
      window.electron.extensions.offInstallProgress()
    }
}

function normalizeInstallResult(result: ExtensionInstallResult): Required<Pick<ExtensionInstallResult, 'success' | 'status' | 'installed' | 'failed' | 'warnings' | 'reloaded'>> & ExtensionInstallResult {
  const installed = result.installed?.length
    ? result.installed
    : result.success && result.extension
      ? [{
        extensionId: result.extensionId ?? result.extension.id,
        extension: result.extension,
        status: 'success',
      } satisfies InstalledExtensionResult]
      : []

  const failed = result.failed ?? []
  const warnings = result.warnings ?? []
  const reloaded = result.reloaded ?? (result.success && installed.length > 0)
  const status = result.status ?? (result.success ? 'success' : 'error')

  return {
    ...result,
    status,
    installed,
    failed,
    warnings,
    reloaded,
    extensionId: result.extensionId ?? installed[0]?.extensionId,
    extension: result.extension ?? (installed.length === 1 ? installed[0]?.extension : undefined),
    error: result.error ?? (status === 'error' ? 'Installation failed' : failed[0]?.error),
  }
}

function mergeInstalledExtensions({
  modelExtensions,
  processExtensions,
  installed,
}: {
  modelExtensions: ModelExtension[]
  processExtensions: ProcessExtension[]
  installed: AnyExtension[]
}): {
  modelExtensions: ModelExtension[]
  processExtensions: ProcessExtension[]
} {
  const nextModelExtensions = [...modelExtensions]
  const nextProcessExtensions = [...processExtensions]
  let modelsChanged = false
  let processesChanged = false

  for (const extension of installed) {
    if (extension.type === 'model') {
      const other = nextProcessExtensions.findIndex((entry) => entry.id === extension.id)
      if (other >= 0) { nextProcessExtensions.splice(other, 1); processesChanged = true }
      upsertExtension(nextModelExtensions, extension)
      modelsChanged = true
      continue
    }

    const other = nextModelExtensions.findIndex((entry) => entry.id === extension.id)
    if (other >= 0) { nextModelExtensions.splice(other, 1); modelsChanged = true }
    upsertExtension(nextProcessExtensions, extension)
    processesChanged = true
  }

  return {
    modelExtensions: modelsChanged ? nextModelExtensions : modelExtensions,
    processExtensions: processesChanged ? nextProcessExtensions : processExtensions,
  }
}

function upsertExtension<T extends AnyExtension>(extensions: T[], extension: T): void {
  const existingIndex = extensions.findIndex((candidate) => candidate.id === extension.id)

  if (existingIndex >= 0) {
    extensions[existingIndex] = extension
    return
  }

  extensions.push(extension)
}

function buildDoneInstallProgress(result: Required<Pick<ExtensionInstallResult, 'status' | 'installed' | 'failed'>> & ExtensionInstallResult): InstallProgress {
  const isLegacyCompatibleSuccess = result.status === 'success' && result.installed.length === 1 && result.failed.length === 0

  return {
    success: result.success,
    step: 'done',
    status: result.status,
    completedChildren: result.installed.length,
    totalChildren: result.installed.length + result.failed.length,
    ...(isLegacyCompatibleSuccess && result.extensionId ? { extensionId: result.extensionId } : {}),
    ...(result.status === 'error' && result.error ? { message: result.error } : {}),
  }
}

function collectRuntimeReadinessModelIds(modelExtensions: ModelExtension[]): string[] {
  return modelExtensions.flatMap((extension) => extension.nodes.map((node) => node.capabilityId ?? `${extension.id}/${node.id}`))
}

function mergeRuntimeReadinessResponse(
  previous: Record<string, RuntimeReadinessCacheEntry>,
  requestedIds: string[],
  models: Record<string, RuntimeReadiness>,
  success: boolean,
  receivedAt: number,
): Record<string, RuntimeReadinessCacheEntry> {
  const next = { ...previous }
  for (const id of requestedIds) {
    const readiness = models[id]
    if (success && readiness) {
      next[id] = { ...sanitizeRuntimeReadiness(readiness), received_at: receivedAt }
      continue
    }

    const cached = previous[id]
    next[id] = !success && cached
      ? { ...cached, stale: true, received_at: receivedAt }
      : createCheckingFailedReadiness(receivedAt)
  }

  return next
}

function buildRuntimeReadinessActionKey(modelId: string, actionId: string): string {
  return `${modelId}:${actionId}`
}

function normalizeRuntimeReadinessActionResult(value: unknown): { success: boolean; error?: string } {
  return isReadinessObject(value) && value.success === true
    ? { success: true }
    : { success: false, error: sanitizeRuntimeActionError(isReadinessObject(value) ? value.error : undefined) }
}

function sanitizeRuntimeActionError(error: unknown): string {
  return typeof error === 'string' && error.trim() && !containsUnsafeText(error)
    ? error.trim().slice(0, 240)
    : 'Runtime readiness action failed.'
}

function sanitizeRuntimeReadiness(readiness: RuntimeReadiness): RuntimeReadiness {
  const actions = sanitizeRuntimeReadinessActions(readiness.actions)
  const details = sanitizeRuntimeReadinessDetails(readiness.details)
  return {
    ...readiness,
    ...(actions.length > 0 ? { actions } : { actions: undefined }),
    ...(details ? { details } : { details: undefined }),
  }
}

function sanitizeRuntimeReadinessActions(actions: unknown): RuntimeReadinessAction[] {
  if (!Array.isArray(actions)) return []
  return actions
    .map((action): RuntimeReadinessAction | undefined => {
      if (!isReadinessObject(action) || typeof action.id !== 'string' || !ACTION_ID_RE.test(action.id)) return undefined
      if (typeof action.kind !== 'string' || !['show_guidance', 'show_details', 'open_external_url', 'refresh_readiness'].includes(action.kind)) return undefined
      if (typeof action.safety !== 'string' || !['manual', 'non_destructive', 'confirm'].includes(action.safety)) return undefined
      if (!isSafeText(action.label, 240)) return undefined
      if (action.reason !== undefined && !isSafeText(action.reason, 2_000)) return undefined
      if (action.guidance !== undefined && !isSafeText(action.guidance, 2_000)) return undefined
      if (action.docs_url !== undefined && !isSafeHttpsUrl(action.docs_url)) return undefined
      if (action.kind === 'open_external_url' && !action.docs_url) return undefined
      const confirmation = isReadinessObject(action.confirmation) ? action.confirmation : undefined
      return {
        id: action.id, label: action.label.trim(),
        kind: action.kind as RuntimeReadinessAction['kind'], safety: action.safety as RuntimeReadinessAction['safety'],
        ...(action.disabled === true ? { disabled: true } : {}),
        ...(action.requires_confirmation === true ? { requires_confirmation: true } : {}),
        ...(typeof action.reason === 'string' ? { reason: action.reason } : {}),
        ...(typeof action.guidance === 'string' ? { guidance: action.guidance } : {}),
        ...(typeof action.docs_url === 'string' ? { docs_url: action.docs_url } : {}),
        ...(['always', 'success', 'never'].includes(action.refresh_after as string)
          ? { refresh_after: action.refresh_after as RuntimeReadinessAction['refresh_after'] } : {}),
        ...(confirmation && isSafeText(confirmation.title, 240) && isSafeText(confirmation.body, 2_000) && isSafeText(confirmation.confirm_label, 240)
          ? { confirmation: { title: confirmation.title, body: confirmation.body, confirm_label: confirmation.confirm_label } } : {}),
      }
    })
    .filter((action): action is RuntimeReadinessAction => Boolean(action))
    .slice(0, MAX_ACTIONS)
}

function sanitizeRuntimeReadinessDetails(details: RuntimeReadiness['details']): RuntimeReadinessDetails | undefined {
  if (!isReadinessObject(details)) return undefined
  const sanitized: RuntimeReadinessDetails = {}
  if (details.title && isSafeText(details.title, 240)) sanitized.title = details.title
  if (details.summary && isSafeText(details.summary, 2_000)) sanitized.summary = details.summary
  if (details.guidance && isSafeText(details.guidance, 2_000)) sanitized.guidance = details.guidance
  const evidence = sanitizeDiagnosticMap(details.evidence)
  const diagnostics = sanitizeDiagnosticMap(details.diagnostics)
  if (Object.keys(evidence).length > 0) sanitized.evidence = evidence
  if (Object.keys(diagnostics).length > 0) sanitized.diagnostics = diagnostics
  return Object.keys(sanitized).length > 0 ? sanitized : undefined
}

function sanitizeDiagnosticMap(map: unknown): Record<string, string> {
  if (!isReadinessObject(map)) return {}
  const sanitized: Record<string, string> = {}
  for (const [key, value] of Object.entries(map)) {
    if (ALLOWED_DIAGNOSTIC_KEYS.has(key) && isSafeText(value, 240)) {
      sanitized[key] = value
    }
  }
  return sanitized
}

function isSafeHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

function isSafeText(value: unknown, maxLength: number): value is string {
  if (typeof value !== 'string') return false
  const text = value.trim()
  return Boolean(text) && text.length <= maxLength && !containsUnsafeText(text)
}

function containsUnsafeText(value: string): boolean {
  return /\.\.|token\s*=|secret|api[_-]?key|raw output|command output|\b[A-Z_]{3,}=|(?:^|\s)(?:\/[\w.-]+){2,}|\b[A-Za-z]:[\\/]/i.test(value)
}

function isReadinessObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function createCheckingFailedReadiness(receivedAt: number): RuntimeReadinessCacheEntry {
  return {
    ok: false,
    machine_code: 'checking_failed',
    label_hint: 'Checking failed',
    checked_at: new Date(receivedAt).toISOString(),
    received_at: receivedAt,
  }
}

import { create } from 'zustand'
import type {
  AnyExtension,
  ExtensionInstallProgress,
  ExtensionInstallResult,
  InstalledExtensionResult,
  ModelExtension,
  ProcessExtension,
  RuntimeReadiness,
} from '../types/electron.d'
import { collectModelOwnershipMetadata, collectReadyOwnerIds } from '../../areas/models/modelOwnershipState.ts'

const RUNTIME_READINESS_TTL_MS = 30_000

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
  readyOwnerIds:     string[]
  loading:           boolean
  installProgress:   InstallProgress | null
  installError:      string | null
  installResult:     InstallResult | null
  loadErrors:        Record<string, string>
  runtimeReadinessById: Record<string, RuntimeReadinessCacheEntry>
  runtimeReadinessLoadingById: Record<string, boolean>

  loadExtensions:    () => Promise<void>
  installFromGitHub: (url: string) => Promise<InstallResult>
  uninstall:         (extensionId: string) => Promise<{ success: boolean; error?: string }>
  reload:            () => Promise<void>
  refreshModelOwnership: (extensions?: ModelExtension[]) => Promise<void>
  ensureRuntimeReadiness: (modelIds: string[], options?: { force?: boolean }) => Promise<void>
  clearInstallState: () => void
}

const runtimeReadinessInFlight = new Map<string, Promise<void>>()

export const useExtensionsStore = create<ExtensionsStore>((set, get) => ({
  modelExtensions:   [],
  processExtensions: [],
  readyOwnerIds:     [],
  loading:           false,
  installProgress:   null,
  installError:      null,
  installResult:     null,
  loadErrors:        {},
  runtimeReadinessById: {},
  runtimeReadinessLoadingById: {},

  // ── Load list ──────────────────────────────────────────────────────────────

  async loadExtensions() {
    set({ loading: true })
    try {
      const list = (await window.electron.extensions.list()) as AnyExtension[]
      const modelExtensions = list.filter((e): e is ModelExtension => e.type === 'model')
      const processExtensions = list.filter((e): e is ProcessExtension => e.type === 'process')
      const downloaded = await window.electron.model.listDownloaded()
      const readyOwnerIds = collectReadyOwnerIds(collectModelOwnershipMetadata(modelExtensions), downloaded.map((model) => model.id))

      set({
        modelExtensions,
        processExtensions,
        readyOwnerIds,
        loading:           false,
      })
      await get().ensureRuntimeReadiness(collectRuntimeReadinessModelIds(modelExtensions))
    } catch {
      set({ loading: false, readyOwnerIds: [] })
    }
  },

  // ── Install from GitHub ────────────────────────────────────────────────────

  async installFromGitHub(url: string) {
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

  // ── Uninstall ──────────────────────────────────────────────────────────────

  async uninstall(extensionId: string) {
    const result = await window.electron.extensions.uninstall(extensionId)
    if (result.success) {
      set((state) => ({
        modelExtensions:   state.modelExtensions.filter((e)   => e.id !== extensionId),
        processExtensions: state.processExtensions.filter((e) => e.id !== extensionId),
      }))
      await get().refreshModelOwnership()
    }
    return result
  },

  // ── Reload (rescan extensions dir + Python registry) ──────────────────────

  async reload() {
    const result = await window.electron.extensions.reload()
    if (result.success) {
      set({ loadErrors: result.errors ?? {} })
    }
    await get().loadExtensions()
    await get().ensureRuntimeReadiness(collectRuntimeReadinessModelIds(get().modelExtensions), { force: true })
  },

  async refreshModelOwnership(extensions) {
    const modelExtensions = extensions ?? get().modelExtensions
    const downloaded = await window.electron.model.listDownloaded()
    const readyOwnerIds = collectReadyOwnerIds(collectModelOwnershipMetadata(modelExtensions), downloaded.map((model) => model.id))
    set({ readyOwnerIds })
  },

  async ensureRuntimeReadiness(modelIds, options) {
    const now = Date.now()
    const uniqueIds = [...new Set(modelIds.map((id) => id.trim()).filter(Boolean))]
    const idsToFetch = uniqueIds.filter((id) => {
      if (options?.force) return true
      const cached = get().runtimeReadinessById[id]
      return !cached?.received_at || now - cached.received_at >= RUNTIME_READINESS_TTL_MS
    })

    if (idsToFetch.length === 0) return

    const cacheKey = idsToFetch.slice().sort().join('\0')
    const existing = runtimeReadinessInFlight.get(cacheKey)
    if (existing) return existing

    const run = (async () => {
      set((state) => ({
        runtimeReadinessLoadingById: {
          ...state.runtimeReadinessLoadingById,
          ...Object.fromEntries(idsToFetch.map((id) => [id, true])),
        },
      }))

      try {
        const result = await window.electron.model.runtimeReadiness(idsToFetch)
        const receivedAt = Date.now()
        set((state) => ({
          runtimeReadinessById: mergeRuntimeReadinessResponse(state.runtimeReadinessById, idsToFetch, result.models, result.success, receivedAt),
        }))
      } catch {
        const receivedAt = Date.now()
        set((state) => ({
          runtimeReadinessById: mergeRuntimeReadinessResponse(state.runtimeReadinessById, idsToFetch, {}, false, receivedAt),
        }))
      } finally {
        set((state) => ({
          runtimeReadinessLoadingById: {
            ...state.runtimeReadinessLoadingById,
            ...Object.fromEntries(idsToFetch.map((id) => [id, false])),
          },
        }))
        runtimeReadinessInFlight.delete(cacheKey)
      }
    })()

    runtimeReadinessInFlight.set(cacheKey, run)
    return run
  },

  // ── Helpers ────────────────────────────────────────────────────────────────

  clearInstallState() {
    set({ installProgress: null, installError: null, installResult: null })
  },
}))

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
      upsertExtension(nextModelExtensions, extension)
      modelsChanged = true
      continue
    }

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
    if (readiness) {
      next[id] = { ...readiness, received_at: receivedAt }
      continue
    }

    if (!success) {
      const cached = previous[id]
      next[id] = cached
        ? { ...cached, stale: true, received_at: receivedAt }
        : createCheckingFailedReadiness(receivedAt)
    }
  }

  return next
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

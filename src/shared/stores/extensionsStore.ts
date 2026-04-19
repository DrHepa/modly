import { create } from 'zustand'
import { collectModelOwnershipMetadata, collectReadyOwnerIds } from '../../areas/models/modelOwnershipState'
import type { ModelExtension, ProcessExtension, AnyExtension, ExtensionInstallResult, ExtensionInstallProgress, InstalledExtensionResult } from '@shared/types/electron.d'

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

  loadExtensions:    () => Promise<void>
  refreshInstalledWeightVariants: () => Promise<void>
  installFromGitHub: (url: string) => Promise<InstallResult>
  installFromLocal:  () => Promise<{ success: boolean; error?: string; cancelled?: boolean; needsRepair?: boolean }>
  uninstall:         (extensionId: string) => Promise<{ success: boolean; error?: string }>
  reload:            () => Promise<void>
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

  // ── Load list ──────────────────────────────────────────────────────────────

  async loadExtensions() {
    set({ loading: true })
    try {
      const list = (await window.electron.extensions.list()) as AnyExtension[]
      const extensions = partitionExtensionsByType(list)
      set({
        ...extensions,
        loading:           false,
      })
      await Promise.all([get().refreshInstalledWeightVariants(), get().refreshModelOwnership()])
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
    const result = await window.electron.extensions.reload()
    if (result.success) {
      set({ loadErrors: result.errors ?? {} })
    }
    await get().loadExtensions()
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

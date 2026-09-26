import type { ProcessInput } from '../../src/shared/types/electron.d'
import { runProcessExtensionWithDeps } from './run-process-handler'
import { ipcMain, BrowserWindow, Notification, dialog, app, shell, type IpcMainInvokeEvent } from 'electron'
import { installGitHubExtensionRepo } from './github-extension-install'
import { autoUpdater } from 'electron-updater'
import { basename, dirname, join } from 'path'
import { rm as rmAsync, readFile, writeFile, mkdir, readdir, rename, cp, symlink, lstat, copyFile, realpath } from 'fs/promises'
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import axios from 'axios'
import * as os from 'os'
import { promisify } from 'util'
import { PythonBridge, API_BASE_URL } from './python-bridge'
import {
  listDownloadedModels,
  isModelDownloaded,
  downloadModelFromHF,
  downloadModelSourcesFromHF,
  type DownloadProgress,
  downloadModelAssetsFromHF,
  downloadModelAssetsFromHttps,
  ModelAssetDownloadError,
} from './model-downloader'
import {
  legacyDownloadSteps,
  privateModelStorageId,
  resolveInstalledExtensionSharedWeightGroups,
  resolveInstalledModelDownloadPlan,
} from './model-download-plan'
import {
  areModelSourcesDownloaded,
  areModelSourcesDownloadedAtRoot,
  areWeightGroupSourcesDownloaded,
  installedWeightVariants,
  listWeightVariantFiles,
  modelHasLocalData,
  removePartialDownloadArtifacts,
  resolveExtensionModelRoot,
  resolveModelRoot,
  resolveWeightGroupRoot,
  resolveWeightStorageRoot,
  weightStorageHasLocalData,
} from './model-sources'
import { getCanonicalModelPath, isOwnedModelDownloaded, listDownloadedModelCapabilities, mapDownloadProgressToCapability, resolveModelOwnership, type ModelOwnershipDescriptor } from './model-ownership'
import { parseLegacyModelDownloadPayload as parseLegacyModelDownloadPayloadContract } from './model-download-ipc-contract'
import { getSettings, setSettings } from './settings-store'
import { checkSetupNeeded, markSetupDone, runFullSetup, getVenvPythonExe, ensureSslPatch } from './python-setup'
import { logger } from './logger'
import { getProcessRunner, getPythonProcessRunner, getExtPythonExe, terminateProcessRunner, terminateAllProcessRunners } from './process-runner'
import { getBuiltinExtensionsDir } from './builtin-sync'
import { activeExtensionInstalls, listAgentCapabilities, listVisibleExtensions, listVisibleExtensionsDetailed, resolveGovernedAgentProcessTarget, parseExtensionManifest, type ParsedManifest } from './automation-capabilities'
import { getAutomationCapabilities } from './automation-capabilities-service'
import { importWorkflowAvoidingIdCollision, listStoredWorkflows, saveWorkflowWithBackup } from './workflow-files.ts'
import { fetchTrustedRepos } from './trusted-repos'
import type { WorldsSceneManifestWriteRequest, WorldsSceneManifestWriteResult } from '../../src/shared/types/electron.d'
import { parseManifestForInstall } from './github-extension-install'
import { createRuntimeReadinessActionHandler, fetchRuntimeReadinessWithHealthGate } from './model-runtime-readiness'
import { spawn, execFile } from 'child_process'
import {
  assertSafeExtensionId,
  assertSafeOwnershipSegment,
  buildExtensionBackupPath,
  resolveExtensionPathWithinRoot,
} from './extension-path-guard'
import { detectGpuInfo, describeGpuInfo, torchFlavorFor, type GpuInfo } from './gpu-detect'
import { SETUP_LAUNCHER_SOURCE } from './setup-launcher'
import {
  assertCompatibleExtensionUpdateType,
  expectedModelIds,
  markExtensionInstallationInterrupted,
  validateExtensionQuarantinePayload,
  validateExtensionReloadPayload,
  validateInstallManifest,
} from './extension-install-utils'
import {
  clearExtensionRegistrationTransaction,
  cleanupValidatedExtensionBackups,
  removeExtensionWithBackups,
  renameWithRetry as renameExtensionWithRetry,
  restoreExtensionBackup,
  rmWithRetry as removeExtensionWithRetry,
  runExtensionRegistrationValidationTransaction,
  runExtensionRepairTransaction,
  type ExtensionRegistrationValidationCapability,
} from './extension-install-recovery'
import { registerWorkspaceAssetLibraryIpcHandlers } from './artifact-registry-service'
import { updatesSupported } from './updater'
import { ModelWeightOperations } from './model-weight-operations'
import { readLocalFileBase64 } from './bounded-file-reader'
import { encryptSecret, decryptSecret } from './secure-store'
import { getHfToken, initHfToken, setHfToken } from './hf-token'
import { registerArtifactRegistryIpcHandlers } from './artifact-registry-service'
import { isSceneManifestRecord, resolveSafeWorkspaceJsonPath } from './worlds-scene-manifest-path'
import { writeWorldsSceneManifest } from './worlds-scene-manifest-writer'
import { importVideoInputToWorkspace } from './video-input-import'
import { AgentSessionStore } from './agent-session-store'
import { AgentActionsService, AgentActionsServiceError } from './agent-actions-service'
import { registerAgentActionsIpcHandlers } from './agent-actions-ipc'
import { WorkspaceAgentArtifactVerifier } from './agent-artifact-verifier'
import type { AgentOllamaModelSelectionV1, AgentOllamaModelSnapshotV1 } from '../../src/shared/types/agentActions.ts'
import {
  AgentMcpBrokerError,
  agentMcpWorkspaceStagingRoot,
  createAgentMcpExecutor,
  createAgentMcpSandboxReadiness,
} from './agent-mcp-broker'
import {
  AgentProcessExecutorError,
  createAgentProcessExecutor,
} from './agent-process-executor'
import { RendererFilesystemAccess } from './renderer-filesystem-access'
import { createDefaultAgentHostRuntimeRegistry } from './agent-host-runtime'
import { createAgentModelAccessRuntime } from './agent-model-access-runtime'
import { createSharedAgentCapabilityResolver } from './agent-capability-resolver'
import { AgentSkillContextAuthority } from './agent-skill-context-authority'
import { registerAgentSkillContextsIpcHandlers } from './agent-skill-contexts-ipc'
import { bindAgentSkillSet } from './agent-skills-manifest'
import { AgentWorkflowAuthority, validateAgentWorkspaceSource } from './agent-workflow-authority'
import { registerAgentWorkflowsIpcHandlers } from './agent-workflows-ipc'
import { WorldProjectRepository } from './world-project-repository'
import { registerWorldProjectsIpcHandlers } from './world-projects-ipc'
import { WorldsCliTransport, worldsCliRuntimeDir, type WorldsCliEditorScope } from './worlds-cli-transport'
import { registerWorldsCliIpcHandlers, registerWorldsCliEditorContextBroker, confirmWorldsCliEditLease, displayWorldsCliCode } from './worlds-cli-ipc'
import { registerWorldsCliReadinessBroker } from './worlds-cli-readiness-broker'
import { registerWorldsCliDirectEditBroker } from './worlds-cli-direct-edit-broker'
import { createWorldsCliDirectEditDispatch } from './worlds-cli-direct-edit-dispatch'
import { getMainWindowDocumentEpoch, isTrustedWorldsCliSender } from './worlds-cli-window-trust'
import { WorldRenderOutputRepository } from './world-render-output-repository'
import { WorldRenderBrowserExecutor } from './world-render-browser-executor'
import {
  createPackagedWorldFfmpegFallback,
  type WorldFfmpegSpawn,
} from './world-render-ffmpeg-encoder'
import { WorldRenderJobService } from './world-render-job-service'
import { initializeWorldRenderSubsystem } from './world-render-composition'
import { registerWorldRendersIpcHandlers } from './world-renders-ipc'

type WindowGetter = () => BrowserWindow | null
const pExecFile = promisify(execFile)

function agentProcessPrivateTempRoot(userDataDir: string): string {
  return join(userDataDir, 'agent-process-private')
}

function agentProcessRuntimeSnapshotRoot(userDataDir: string): string {
  return join(userDataDir, 'agent-process-runtime-snapshots')
}

function agentModelAccessRoot(userDataDir: string): string {
  return join(userDataDir, 'agent-model-access')
}

// ─── Run an extension's setup.py directly (no FastAPI needed) ─────────────────

function runExtensionSetup(
  extDir: string,
  gpu:    GpuInfo,
  onLog?: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const userData  = app.getPath('userData')
    ensureSslPatch(userData)
    const pythonExe = getVenvPythonExe(userData)
    const setupPy   = join(extDir, 'setup.py')

    // Shared pip wheel cache: a failed setup retried later reuses the multi-GB
    // torch wheels instead of re-downloading them (see issue #223). Extension
    // setup.py scripts that pass --no-cache-dir get it stripped by the launcher.
    const pipCacheDir = join(getSettings(userData).dependenciesDir, 'pip-cache')
    try { mkdirSync(pipCacheDir, { recursive: true }) } catch { /* pip creates it too */ }

    const torchFlavor = torchFlavorFor(gpu.accelerator)
    const args = JSON.stringify({
      python_exe: pythonExe,
      ext_dir: extDir,
      gpu_sm: gpu.sm,
      cuda_version: gpu.cudaVersion,
      accelerator: gpu.accelerator,
      // Extensions that know about AMD branch on torch_flavor (the official
      // hunyuan3d-mini one does). Those that don't get corrected by the ROCm
      // shim in setup-launcher.ts instead.
      torch_flavor: torchFlavor,
      gfx_target: gpu.gfxTarget ?? '',
      torch_index_url: gpu.torchIndexUrl ?? '',
      platform: process.platform,
      arch: process.arch,
    })
    const launcher = SETUP_LAUNCHER_SOURCE
    // The rewrite decision itself is made in gpu-detect.ts (and unit-tested
    // there); the launcher above only applies what these carry.
    const proc = spawn(pythonExe, ['-c', launcher, setupPy, args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env:   {
        ...process.env,
        PIP_CACHE_DIR:         pipCacheDir,
        MODLY_TORCH_FLAVOR:    torchFlavor,
        MODLY_TORCH_INDEX_URL: gpu.torchIndexUrl ?? '',
        MODLY_TORCH_SPECS:     JSON.stringify(gpu.torchSpecs ?? []),
      },
    })

    const handleLine = (line: string) => { if (line) onLog?.(line) }

    let stderr = ''
    proc.stdout?.on('data', (d: Buffer) => d.toString().split('\n').forEach(handleLine))
    proc.stderr?.on('data', (d: Buffer) => {
      const s = d.toString()
      stderr += s
      s.split('\n').forEach(handleLine)
    })

    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`setup.py exited with code ${code}\n${stderr.slice(-2000)}`))
    })
    proc.on('error', reject)
  })
}

function modelAssetDownloadResult(error: unknown) {
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof ModelAssetDownloadError ? { failure: error.failure } : {}),
  }
}

function createFallbackOwnership(modelId: string): ModelOwnershipDescriptor {
  const [bundleId = modelId] = modelId.split('/')
  return {
    capabilityId: modelId,
    bundleId,
    weightOwnerId: modelId,
    sharedOwner: false,
    legacyPaths: [modelId],
  }
}

async function listModelExtensions(userData: string) {
  return listVisibleExtensions({
    builtinDir: getBuiltinExtensionsDir(),
    userExtensionsDir: getSettings(userData).extensionsDir,
    trustedRepos: new Set(),
  })
}

async function resolveOwnershipContext(userData: string, capabilityId: string) {
  const extensions = await listModelExtensions(userData)
  const ownership = resolveModelOwnership(extensions, capabilityId) ?? createFallbackOwnership(capabilityId)
  const siblingCapabilityIds = extensions
    .filter((extension) => extension.type === 'model')
    .flatMap((extension) => extension.nodes.map((node) => node.capabilityId ?? `${extension.id}/${node.id}`))
    .filter((candidateCapabilityId) => candidateCapabilityId !== capabilityId)
    .filter((candidateCapabilityId) => {
      const candidateOwnership = resolveModelOwnership(extensions, candidateCapabilityId)
      return candidateOwnership?.weightOwnerId === ownership.weightOwnerId
    })

  return { extensions, ownership, siblingCapabilityIds }
}

const rmWithRetry = (path: string, label: string) =>
  removeExtensionWithRetry(path, label, logger)
const renameWithRetry = (from: string, to: string, label: string) =>
  renameExtensionWithRetry(from, to, label, logger)

async function resolveCurrentOllamaModel(expected: AgentOllamaModelSnapshotV1): Promise<unknown> {
  const response = await axios.get(`${expected.endpoint}/api/tags`, {
    timeout: 5_000,
    maxRedirects: 0,
    validateStatus: (status) => status === 200,
  })
  const payload = response.data
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { models?: unknown }).models)) return null
  const model = (payload as { models: unknown[] }).models.find((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false
    const record = candidate as { name?: unknown, model?: unknown }
    return record.name === expected.model || record.model === expected.model
  })
  if (!model || typeof model !== 'object') return null
  const digest = (model as { digest?: unknown }).digest
  return {
    provider: 'ollama',
    endpoint: expected.endpoint,
    model: expected.model,
    digest,
  }
}

async function resolveSelectedOllamaModel(selection: AgentOllamaModelSelectionV1): Promise<unknown> {
  return resolveCurrentOllamaModel({
    ...selection,
    digest: `sha256:${'0'.repeat(64)}`,
  })
}

export interface IpcHandlersLifecycle {
  shutdown(): Promise<void>
}

export async function setupIpcHandlers(pythonBridge: PythonBridge, getWindow: WindowGetter, trustedRendererUrl: string): Promise<IpcHandlersLifecycle> {
  type ActiveDownload = {
    progress: DownloadProgress & { variantId?: string }
    done: Promise<void>
    finish: () => void
    targetRoots: string[]
    currentTargetId?: string
    stopRequested?: 'pause' | 'cancel'
  }
  const activeDownloads = new Map<string, ActiveDownload>()
  const getWorldsWorkspaceRoot = () => getSettings(app.getPath('userData')).workspaceDir
  const isTrustedMainFrameSender = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false
    const event = value as IpcMainInvokeEvent
    const window = getWindow()
    return Boolean(window && !window.isDestroyed()
      && event.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame)
  }
  const worldProjectRepository = new WorldProjectRepository({
    getWorkspaceRoot: getWorldsWorkspaceRoot,
  })
  registerWorldProjectsIpcHandlers(ipcMain, worldProjectRepository, {
    isTrustedSender: isTrustedMainFrameSender,
  })
  const captureWorldsCliTrust = () => {
    const window = getWindow()
    if (!window || !isTrustedWorldsCliSender({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, window, trustedRendererUrl)) return null
    return { window, contents: window.webContents, frame: window.webContents.mainFrame,
      documentUrl: trustedRendererUrl, documentEpoch: getMainWindowDocumentEpoch(window.webContents), workspaceRoot: getWorldsWorkspaceRoot() }
  }
  const editorBroker = registerWorldsCliEditorContextBroker(ipcMain, { getWindow, trustedRendererUrl })
  const readinessBroker = registerWorldsCliReadinessBroker(ipcMain, { getWindow, trustedRendererUrl })
  const directEditBroker = registerWorldsCliDirectEditBroker(ipcMain, {
    getWindow,
    trustedRendererUrl,
    getWorkspaceRoot: getWorldsWorkspaceRoot,
    readiness: readinessBroker,
    repository: worldProjectRepository,
  })
  let worldsCliTransport: WorldsCliTransport | null = null
  const dispatchWorldsCliDirectEdit = createWorldsCliDirectEditDispatch(() => worldsCliTransport, directEditBroker)
  const readWorldsCliScope = async (): Promise<WorldsCliEditorScope | null> => {
    const trust = captureWorldsCliTrust()
    if (!trust) return null
    const intent = await editorBroker.request()
    if (!intent || !captureWorldsCliTrust() || getMainWindowDocumentEpoch(trust.contents) !== trust.documentEpoch
      || getWindow() !== trust.window || trust.frame !== trust.contents.mainFrame) return null
    try {
      const canonicalWorkspace = await realpath(trust.workspaceRoot)
      const opened = await worldProjectRepository.open({ projectKey: intent.projectKey })
      if (!opened.ok || opened.value.status !== 'ready' || opened.value.snapshot.project.projectId !== intent.projectId
        || opened.value.snapshot.project.revision !== intent.revision
        || !opened.value.snapshot.project.scenes.some((scene) => scene.id === intent.sceneId)
        || await realpath(trust.workspaceRoot) !== canonicalWorkspace || getWindow() !== trust.window
        || getMainWindowDocumentEpoch(trust.contents) !== trust.documentEpoch) return null
      return { ...intent, trust, canonicalWorkspace }
    } catch { return null }
  }
  if (process.platform === 'linux') {
    try {
      const created = new WorldsCliTransport({ repository: worldProjectRepository, runtimeDir: worldsCliRuntimeDir(),
        captureTrust: captureWorldsCliTrust, activeEditorScope: readWorldsCliScope,
        dispatchDirectEditProposal: dispatchWorldsCliDirectEdit,
        onPairRequest: async (isLive) => {
          const transport = worldsCliTransport
          const scope = await readWorldsCliScope()
          if (!isLive() || !scope || !transport) return { ok: false }
          const window = scope.trust.window as BrowserWindow
          const nativeDialog = { showMessageBox: (owner: Parameters<typeof confirmWorldsCliEditLease>[0], options: {
            type: 'question' | 'info'; title: string; message: string; detail: string; buttons: string[];
            defaultId: number; cancelId: number; noLink: boolean
          }) => dialog.showMessageBox(owner as BrowserWindow, options) }
          if (!await confirmWorldsCliEditLease(window, nativeDialog, { ...scope, mode: 'edit' }) || !isLive()) return { ok: false }
          const fresh = await readWorldsCliScope()
          if (!fresh || fresh.editorEpoch !== scope.editorEpoch || fresh.revision !== scope.revision
            || fresh.sceneId !== scope.sceneId || fresh.projectKey !== scope.projectKey || !isLive()) return { ok: false }
          const pairing = await transport.beginPairing(scope, isLive)
          if (!isLive() || !await displayWorldsCliCode(window, nativeDialog, pairing.code)) { transport.revokeSession(); return { ok: false } }
          const verified = await readWorldsCliScope()
          if (!verified || verified.revision !== scope.revision || verified.sceneId !== scope.sceneId
            || verified.editorEpoch !== scope.editorEpoch || !isLive()) { transport.revokeSession(); return { ok: false } }
          return { ok: true }
        },
      })
      worldsCliTransport = created
      // Inert until explicit native consent: only pair.request may be sent without a session.
      void created.startListening().catch((error) => logger.warn(`Worlds CLI socket unavailable: ${error instanceof Error ? error.message : String(error)}`))
    } catch (error) { logger.warn(`Worlds CLI disabled: ${error instanceof Error ? error.message : String(error)}`) }
  }
  editorBroker.onLeave(() => {
    directEditBroker.cancelActive('editor_left')
    readinessBroker.editorLeft()
    worldsCliTransport?.revokeSession()
  })
  const worldsCliControls = registerWorldsCliIpcHandlers(ipcMain, {
    getStatus() { return worldsCliTransport?.getStatus() ?? { running: false, paired: false, expired: false, pairingPending: false, pairingId: null, sessionExpiresAt: null } },
    async revoke() {
      directEditBroker.cancelActive('revoke')
      readinessBroker.editorLeft()
      worldsCliTransport?.revokeSession()
    },
    async listPending() { return worldsCliTransport?.listPending() ?? { ok: false, code: 'UNAVAILABLE' } },
    async getReview(request) { return worldsCliTransport?.getReview(request) ?? { ok: false, code: 'UNAVAILABLE' } },
    async reject(request) { return worldsCliTransport?.reject(request) ?? { ok: false, code: 'UNAVAILABLE' } },
    async apply(request, confirm, assertIntentLive) { return worldsCliTransport?.apply(request, confirm, assertIntentLive) ?? { ok: false, code: 'UNAVAILABLE' } },
  }, {
    getWindow,
    trustedRendererUrl,
    dialog: { showMessageBox: (window, options) => dialog.showMessageBox(window as BrowserWindow, options) },
  })
  const worldRenderOutputRepository = new WorldRenderOutputRepository({
    getWorkspaceRoot: getWorldsWorkspaceRoot,
  })
  const worldRenderBrowserExecutor = new WorldRenderBrowserExecutor({
    outputRepository: worldRenderOutputRepository,
    assembleWithFfmpeg: createPackagedWorldFfmpegFallback({
      resourcesPath: process.resourcesPath,
      platform: process.platform,
      arch: process.arch,
      authority: worldRenderOutputRepository,
      spawnProcess: spawn as unknown as WorldFfmpegSpawn,
      environment: process.env,
    }),
  })
  const worldRenderJobService = new WorldRenderJobService({
    projectReader: worldProjectRepository,
    outputRepository: worldRenderOutputRepository,
    executor: worldRenderBrowserExecutor,
    maxConcurrentJobs: 1,
  })
  const worldRenderSubsystem = await initializeWorldRenderSubsystem({
    service: worldRenderJobService,
    executor: worldRenderBrowserExecutor,
  })
  registerWorldRendersIpcHandlers(ipcMain, worldRenderSubsystem.api, {
    isTrustedSender: isTrustedMainFrameSender,
  })
  const rendererFilesystemAccess = new RendererFilesystemAccess({
    getConfiguredRoots: () => {
      const settings = getSettings(app.getPath('userData'))
      return {
        modelsDir: settings.modelsDir,
        workspaceDir: settings.workspaceDir,
        workflowsDir: settings.workflowsDir,
        extensionsDir: settings.extensionsDir,
      }
    },
    getProtectedRoots: () => {
      const userDataDir = app.getPath('userData')
      return {
        userDataDir,
        agentPrivateTempDir: agentProcessPrivateTempRoot(userDataDir),
        agentRuntimeSnapshotDir: agentProcessRuntimeSnapshotRoot(userDataDir),
        agentWorkspaceStagingDir: agentMcpWorkspaceStagingRoot(getSettings(userDataDir).workspaceDir),
        agentModelAccessDir: agentModelAccessRoot(userDataDir),
      }
    },
  })
  const agentSessionStore = new AgentSessionStore({ rootDir: join(app.getPath('userData'), 'agent-sessions') })
  void agentSessionStore.list().catch((error) => logger.warn(`Agent session startup maintenance failed: ${error instanceof Error ? error.message : String(error)}`))
  ipcMain.handle('agentSessions:list', () => agentSessionStore.list())
  ipcMain.handle('agentSessions:create', (_event, request) => agentSessionStore.create(request))
  ipcMain.handle('agentSessions:read', (_event, request) => agentSessionStore.read(request))
  ipcMain.handle('agentSessions:activate', (_event, request) => agentSessionStore.activate(request))
  ipcMain.handle('agentSessions:rename', (_event, request) => agentSessionStore.rename(request))
  ipcMain.handle('agentSessions:delete', (_event, request) => agentSessionStore.delete(request))
  ipcMain.handle('agentSessions:appendMessage', (_event, request) => agentSessionStore.appendMessage(request))
  ipcMain.handle('agentSessions:addAttachment', (_event, request) => agentSessionStore.addAttachment(request))
  ipcMain.handle('agentSessions:removeAttachment', (_event, request) => agentSessionStore.removeAttachment(request))
  ipcMain.handle('agentSessions:readAttachment', (_event, request) => agentSessionStore.readAttachment(request))
  const weightOperations = new ModelWeightOperations()
  // Paused/error sessions retain their original paths even after settings change.
  const interruptedTargets = new Map<string, string[]>()
  const notifyWeightChange = () => {
    getWindow()?.webContents.send('model:weightsChanged')
  }
  // No backend listening means no Python process can hold the weight files
  // open, so deletion is safe. A backend that answers (or times out) is not.
  const backendUnreachable = (err: unknown): boolean => {
    if (!axios.isAxiosError(err) || err.response) return false
    const cause = (err as { cause?: { code?: string } }).cause
    return err.code === 'ECONNREFUSED' || cause?.code === 'ECONNREFUSED'
  }
  async function unloadForRemoval(modelIds: string[]) {
    for (const id of modelIds) {
      try {
        const response = await axios.post(
          `${API_BASE_URL}/model/unload/${encodeURIComponent(id)}`, {}, { timeout: 40_000 },
        )
        if (response.data?.unloaded !== true) throw new Error('Model unload was not confirmed; weights were preserved')
      } catch (err) {
        if (backendUnreachable(err)) return
        throw err
      }
    }
  }
  // Unload only this extension's generators, not every model in the app.
  async function unloadExtensionForRemoval(extensionId: string) {
    let modelIds: string[]
    try {
      const { data } = await axios.get<{ id: string }[]>(`${API_BASE_URL}/model/all`, { timeout: 10_000 })
      modelIds = data.map((model) => model.id).filter((id) => id.startsWith(`${extensionId}/`))
    } catch (err) {
      if (backendUnreachable(err)) return
      throw err
    }
    await unloadForRemoval(modelIds)
  }
  const resolveModelPlan = (modelId: unknown) => resolveInstalledModelDownloadPlan({
    modelId,
    userExtensionsDir: getSettings(app.getPath('userData')).extensionsDir,
    builtinExtensionsDir: getBuiltinExtensionsDir(),
    blockedExtensionIds: activeExtensionInstalls,
  })
  const ownerPeers = (plan: Awaited<ReturnType<typeof resolveModelPlan>>) =>
    plan.ownership?.legacyPaths.filter((id) => id !== plan.modelId) ?? []
  const ownerDeleteWarning = (plan: Awaited<ReturnType<typeof resolveModelPlan>>) =>
    `Delete is owner-scoped for '${plan.ownership?.weightOwnerId}' and still referenced by: ${ownerPeers(plan).join(', ')}`
  function planDownloaded(modelsDir: string, plan: Awaited<ReturnType<typeof resolveModelPlan>>) {
    const storageId = privateModelStorageId(modelsDir, plan)
    if (plan.kind === 'multi-source') {
      const privateReady = plan.sources.length === 0 || areModelSourcesDownloaded(modelsDir, storageId, plan.sources)
      return privateReady && plan.sharedGroups.every((group) => areWeightGroupSourcesDownloaded(modelsDir, plan.extensionId, group))
    }
    if (plan.kind === 'hf-assets' || plan.kind === 'https-assets') {
      return plan.ownership ? isOwnedModelDownloaded(modelsDir, plan.ownership) : false
    }
    return isModelDownloaded(modelsDir, storageId, plan.downloadCheck)
      && (!plan.weightVariants || installedWeightVariants(modelsDir, storageId, plan.weightVariants).length > 0)
  }
  const LOCKED_MODEL_FILES_ERROR = 'Model files are still locked after several attempts. Close any programs using the model and try again.'

  const agentWorkflowAuthority = new AgentWorkflowAuthority({
    commitIfOriginSessionActive: (originSessionId, operation) => agentSessionStore.commitIfActive(originSessionId, operation),
    discoverExtensions: async () => {
      const userData = app.getPath('userData')
      return listVisibleExtensionsDetailed({
        builtinDir: getBuiltinExtensionsDir(),
        userExtensionsDir: getSettings(userData).extensionsDir,
        trustedRepos: await fetchTrustedRepos(),
      })
    },
    getWorkflowsDir: () => getSettings(app.getPath('userData')).workflowsDir,
    validateWorkspaceSource: (source) => validateAgentWorkspaceSource(
      getSettings(app.getPath('userData')).workspaceDir,
      source,
    ),
  })
  registerAgentWorkflowsIpcHandlers(ipcMain, agentWorkflowAuthority)

  const mcpSandboxReadiness = createAgentMcpSandboxReadiness({
    getWorkspaceRoot: () => getSettings(app.getPath('userData')).workspaceDir,
  })
  const agentHostRuntimes = createDefaultAgentHostRuntimeRegistry()
  const agentModelAccess = createAgentModelAccessRuntime({
    root: agentModelAccessRoot(app.getPath('userData')),
  })
  const sharedAgentCapabilityResolver = createSharedAgentCapabilityResolver({
    discoverCapabilities: listAgentCapabilities,
    getBuiltinDir: getBuiltinExtensionsDir,
    getUserExtensionsDir: () => getSettings(app.getPath('userData')).extensionsDir,
    fetchTrustedRepos,
    hostRuntimes: agentHostRuntimes,
    mcpSandboxReadiness,
    processPythonSandboxReadiness: () => mcpSandboxReadiness('artifact-v1'),
    processModelAccessReadiness: (declaration) => agentModelAccess.readiness(declaration),
    processPythonExecutable: () => getVenvPythonExe(app.getPath('userData')),
  })
  const agentSkillContextAuthority = new AgentSkillContextAuthority({
    resolveCapabilitiesWithSkillBindings: sharedAgentCapabilityResolver.withPrivateSkillBindings,
    rebindSkillSet: (binding) => bindAgentSkillSet(binding.extensionDir, binding.bound.declaration),
    commitIfOriginSessionActive: (originSessionId, operation) => agentSessionStore.commitIfActive(originSessionId, operation),
  })
  registerAgentSkillContextsIpcHandlers(ipcMain, agentSkillContextAuthority, {
    isTrustedSender: isTrustedMainFrameSender,
  })
  const processExecutor = createAgentProcessExecutor({
    getWorkspaceRoot: () => getSettings(app.getPath('userData')).workspaceDir,
    getPrivateTempRoot: () => agentProcessPrivateTempRoot(app.getPath('userData')),
    resolveTarget: async (capabilityId) => {
      const userData = app.getPath('userData')
      return resolveGovernedAgentProcessTarget({
        builtinDir: getBuiltinExtensionsDir(),
        userExtensionsDir: getSettings(userData).extensionsDir,
        trustedRepos: await fetchTrustedRepos(),
        processPythonExecutable: () => getVenvPythonExe(userData),
      }, capabilityId)
    },
    resolveCurrentModel: resolveCurrentOllamaModel,
    resolvePythonExecutable: () => getVenvPythonExe(app.getPath('userData')),
    getRuntimeSnapshotRoot: () => agentProcessRuntimeSnapshotRoot(app.getPath('userData')),
    pythonSandboxReadiness: () => mcpSandboxReadiness('artifact-v1'),
    modelAccessReadiness: (declaration) => agentModelAccess.readiness(declaration),
    acquireModelAccess: (input) => agentModelAccess.acquire(input),
  })
  const agentActionsService = new AgentActionsService({
    resolveCapabilities: sharedAgentCapabilityResolver.forAgentActions,
    resolveCurrentModel: resolveCurrentOllamaModel,
    artifactVerifier: new WorkspaceAgentArtifactVerifier({
      getWorkspaceRoot: () => getSettings(app.getPath('userData')).workspaceDir,
    }),
    ensureExecutorReady: async (capability) => {
      if (capability.execution?.kind === 'mcp_tool') {
        const profile = capability.execution.artifacts?.profile
        if (!profile || !await mcpSandboxReadiness(profile)) {
          throw new AgentActionsServiceError('sandbox_unavailable')
        }
        return
      }
      if (capability.execution?.kind === 'process') {
        try {
          await processExecutor.ensureReady(capability)
          return
        } catch (error) {
          if (error instanceof AgentProcessExecutorError && error.code === 'capability_stale') {
            throw new AgentActionsServiceError('capability_stale', error)
          }
          throw new AgentActionsServiceError('executor_unavailable', error)
        }
      }
      throw new AgentActionsServiceError('executor_unavailable')
    },
    executor: async (request) => {
      if (request.capability.execution?.kind === 'process') {
        try {
          return await processExecutor.execute(request)
        } catch (error) {
          if (!(error instanceof AgentProcessExecutorError)) throw error
          if (error.code === 'unsupported_capability' || error.code === 'runtime_unavailable'
            || error.code === 'model_binding_unavailable') {
            throw new AgentActionsServiceError('executor_unavailable', error)
          }
          if (error.code === 'capability_stale') throw new AgentActionsServiceError('capability_stale', error)
          if (error.code === 'model_stale') throw new AgentActionsServiceError('model_stale', error)
          if (error.code === 'invalid_arguments') throw new AgentActionsServiceError('invalid_arguments', error)
          if (error.code === 'artifact_too_large') throw new AgentActionsServiceError('artifact_too_large', error)
          if (error.code === 'invalid_artifact') throw new AgentActionsServiceError('invalid_artifact', error)
          throw new AgentActionsServiceError('execution_failed', error)
        }
      }
      if (request.capability.execution?.kind !== 'mcp_tool') {
        throw new AgentActionsServiceError('executor_unavailable')
      }
      try {
        const userData = app.getPath('userData')
        const mcpExecutor = createAgentMcpExecutor({
          discovery: {
            builtinDir: getBuiltinExtensionsDir(),
            userExtensionsDir: getSettings(userData).extensionsDir,
            hostRuntimes: agentHostRuntimes,
          },
          getWorkspaceRoot: () => getSettings(userData).workspaceDir,
          sandboxReadiness: mcpSandboxReadiness,
        })
        return await mcpExecutor(request)
      } catch (error) {
        if (!(error instanceof AgentMcpBrokerError)) throw error
        if (error.code === 'unsupported_capability') throw new AgentActionsServiceError('executor_unavailable', error)
        if (error.code === 'capability_stale') throw new AgentActionsServiceError('capability_stale', error)
        if (error.code === 'invalid_arguments') throw new AgentActionsServiceError('invalid_arguments', error)
        if (error.code === 'sandbox_unavailable') throw new AgentActionsServiceError('sandbox_unavailable', error)
        if (error.code === 'artifact_too_large') throw new AgentActionsServiceError('artifact_too_large', error)
        throw new AgentActionsServiceError('execution_failed', error)
      }
    },
  })
  registerAgentActionsIpcHandlers(ipcMain, agentActionsService, {
    resolveSelectedModel: resolveSelectedOllamaModel,
  })

  const handleStructuredModelAssetDownload = async (
    event: IpcMainInvokeEvent,
    payload: unknown,
    downloader: typeof downloadModelAssetsFromHF | typeof downloadModelAssetsFromHttps,
  ) => {
    let modelId: string
    try {
      modelId = parseLegacyModelDownloadPayloadContract(payload).modelId
    } catch (error) {
      return modelAssetDownloadResult(new ModelAssetDownloadError({
        code: 'invalid_model_id',
        stage: 'request',
        message: error instanceof Error ? error.message : 'Invalid model asset download modelId',
        retryable: false,
      }))
    }

    if (activeDownloads.has(modelId)) {
      return modelAssetDownloadResult(new ModelAssetDownloadError({
        code: 'download_in_progress',
        stage: 'request',
        message: `Model asset download is already in progress for ${modelId}`,
        retryable: false,
      }))
    }

    let targetRoots: string[]
    let targetOwnerId: string
    let release: () => void
    try {
      const extensionId = modelId.split('/')[0]
      if (activeExtensionInstalls.has(extensionId)) {
        throw new Error(`Extension "${extensionId}" is being installed or repaired`)
      }
      const { ownership } = await resolveOwnershipContext(app.getPath('userData'), modelId)
      targetOwnerId = ownership.weightOwnerId
      const modelsDir = getSettings(app.getPath('userData')).modelsDir
      targetRoots = [...new Set([ownership.weightOwnerId, ...ownership.legacyPaths])]
        .map((id) => resolveModelRoot(modelsDir, id))
      if (activeDownloads.has(modelId)) {
        return modelAssetDownloadResult(new ModelAssetDownloadError({
          code: 'download_in_progress',
          stage: 'request',
          message: `Model asset download is already in progress for ${modelId}`,
          retryable: false,
        }))
      }
      release = weightOperations.acquire(`downloading ${modelId}`, targetRoots)
    } catch (error) {
      return modelAssetDownloadResult(error)
    }

    let finish!: () => void
    const done = new Promise<void>((resolveDone) => { finish = resolveDone })
    const active: ActiveDownload = {
      progress: { percent: 0, status: 'preparing' }, done, finish, targetRoots,
    }
    activeDownloads.set(modelId, active)
    interruptedTargets.set(modelId, targetRoots)
    try {
      active.currentTargetId = targetOwnerId!
      await downloader(modelId, targetOwnerId!, (progress) => {
        if (progress.paused) active.stopRequested = 'pause'
        if (progress.cancelled) active.stopRequested = 'cancel'

        active.progress = progress
        event.sender.send(
          'model:downloadProgress',
          mapDownloadProgressToCapability(modelId, progress),
        )
      })
      if (active.stopRequested) return { success: false, paused: active.stopRequested === 'pause', cancelled: active.stopRequested === 'cancel' }
      interruptedTargets.delete(modelId)
      return { success: true }
    } catch (error) {
      return modelAssetDownloadResult(error)
    } finally {
      if (activeDownloads.get(modelId) === active) activeDownloads.delete(modelId)
      release()
      active.finish()
      notifyWeightChange()
    }
  }

  // Logging from renderer
  ipcMain.on('log:error', (_event, message: string) => logger.error(`[Renderer] ${message}`))
  ipcMain.handle('log:getPath', () => join(app.getPath('userData'), 'logs', 'modly.log'))
  ipcMain.handle('log:readAll', async (_event, session?: string) => {
    const logsDir = join(app.getPath('userData'), 'logs')
    const dir = session ? join(logsDir, 'sessions', session) : logsDir
    const files = ['modly.log', 'errors.log', 'runtime.log']
    const result: Record<string, string> = {}
    for (const file of files) {
      try {
        const filePath = join(dir, file)
        result[file] = existsSync(filePath) ? await readFile(filePath, 'utf-8') : ''
      } catch {
        result[file] = ''
      }
    }
    return result
  })
  ipcMain.handle('log:listSessions', () => {
    const sessionsDir = join(app.getPath('userData'), 'logs', 'sessions')
    if (!existsSync(sessionsDir)) return []
    try {
      return readdirSync(sessionsDir)
        .filter(f => statSync(join(sessionsDir, f)).isDirectory())
        .sort()
        .reverse()
    } catch {
      return []
    }
  })

  // Secure storage — OS-level encryption (Keychain/DPAPI/libsecret) for secrets
  // the renderer would otherwise have to keep in plain-text localStorage (API keys).
  ipcMain.handle('secure:encrypt', (_, plainText: string) => encryptSecret(plainText))
  ipcMain.handle('secure:decrypt', (_, stored: string) => decryptSecret(stored))

  // Window controls (frameless window)
  ipcMain.on('window:minimize', () => getWindow()?.minimize())
  ipcMain.on('window:maximize', () => {
    const win = getWindow()
    if (!win) return
    win.isMaximized() ? win.restore() : win.maximize()
  })
  ipcMain.on('window:close', () => getWindow()?.close())
  ipcMain.handle('window:isMaximized', () => getWindow()?.isMaximized() ?? false)

  // Native OS notification (Windows toast / macOS Notification Center / Linux),
  // for events the user wants to know about even when the window is minimized or
  // behind other apps — e.g. a generation or workflow run finishing. Routed through
  // the main process rather than the renderer's own Notification API so it works
  // the same way regardless of focus and carries the app's own icon.
  ipcMain.handle('notifications:show', (_event, title: string, body: string) => {
    if (!Notification.isSupported()) return { success: false, error: 'Notifications not supported' }
    const notification = new Notification({
      title,
      body,
      icon: join(__dirname, '../../resources/icons/icon.png'),
    })
    notification.on('click', () => {
      const win = getWindow()
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
    notification.show()
    return { success: true }
  })

  // Setup handlers — skipped in dev (uses .venv instead of python-embed)
  ipcMain.handle('setup:check', async () => {
    const userData = app.getPath('userData')
    const defaultDataDir = join(app.getPath('documents'), 'Modly')
    return {
      needed: checkSetupNeeded(userData),
      defaultDataDir,
      platform: process.platform,
      arch: process.arch,
    }
  })

  ipcMain.handle('setup:saveDataDir', async (_event, { baseDir }: { baseDir: string }) => {
    const userData = app.getPath('userData')
    setSettings(userData, {
      modelsDir:        join(baseDir, 'models'),
      workspaceDir:     join(baseDir, 'workspace'),
      workflowsDir:     join(baseDir, 'workflows'),
      extensionsDir:    join(baseDir, 'extensions'),
      dependenciesDir:  join(baseDir, 'dependencies'),
      agentDir:         join(baseDir, 'agent'),
    })
  })

  ipcMain.handle('setup:run', async () => {
    const userData = app.getPath('userData')
    const win = getWindow()
    if (!win) return { success: false, error: 'No window available' }
    try {
      await runFullSetup(win, userData)
      markSetupDone(userData)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // Python bridge
  ipcMain.handle('python:start', async () => {
    try {
      await pythonBridge.start()
      return { success: true, port: pythonBridge.getPort() }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('python:status', () => ({
    ready: pythonBridge.isReady(),
    apiUrl: API_BASE_URL
  }))

  // File system
  ipcMain.handle('fs:selectImage', async () => {
    const win = getWindow()
    if (!win) return null

    const result = await dialog.showOpenDialog(win, {
      title: 'Select an image',
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
      properties: ['openFile']
    })

    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('fs:selectVideo', async () => {
    const win = getWindow()
    if (!win) return null

    const result = await dialog.showOpenDialog(win, {
      title: 'Select a video',
      filters: [{ name: 'Videos', extensions: ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi'] }],
      properties: ['openFile']
    })

    const sourcePath = result.filePaths[0]
    if (result.canceled || !sourcePath) return null

    const workspaceDir = getSettings(app.getPath('userData')).workspaceDir
    return await importVideoInputToWorkspace({ sourcePath, workspaceDir })
  })

  ipcMain.handle('fs:selectMeshFile', async () => {
    const win = getWindow()
    if (!win) return null

    const result = await dialog.showOpenDialog(win, {
      title: 'Select a 3D mesh file',
      filters: [{ name: '3D Mesh', extensions: ['glb', 'obj', 'stl', 'ply', 'splat'] }],
      properties: ['openFile']
    })

    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('fs:selectSceneFile', async (event) => {
    const win = getWindow()
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return null

    const result = await dialog.showOpenDialog(win, {
      title: 'Select a scene manifest',
      filters: [{ name: 'Scene manifest', extensions: ['json'] }],
      properties: ['openFile']
    })

    if (getWindow() !== win || win.isDestroyed() || event.sender !== win.webContents) return null
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  ipcMain.handle('fs:saveModel', async (_, defaultName: string) => {
    const win = getWindow()
    if (!win) return null

    const result = await dialog.showSaveDialog(win, {
      title: 'Save 3D Model',
      defaultPath: defaultName,
      filters: [
        { name: 'OBJ', extensions: ['obj'] },
        { name: 'GLB', extensions: ['glb'] },
        { name: 'STL', extensions: ['stl'] }
      ]
    })

    return result.canceled ? null : result.filePath
  })

  ipcMain.handle('fs:savePath', async (_, args: { filters: { name: string; extensions: string[] }[]; defaultPath?: string }) => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showSaveDialog(win, {
      title:       'Choose output path',
      filters:     args.filters,
      defaultPath: args.defaultPath,
    })
    return result.canceled ? null : result.filePath
  })

  ipcMain.handle('model:unloadAll', async (): Promise<{ success: boolean; error?: string }> => {
    try {
      await axios.post(`${API_BASE_URL}/model/unload-all`, {}, { timeout: 10_000 })
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('model:runtimeReadiness', async (_event, modelIds: string[]) => {
    return fetchRuntimeReadinessWithHealthGate(modelIds, { apiBaseUrl: API_BASE_URL })
  })

  ipcMain.handle('model:runtimeReadinessAction', async (_event, action: unknown) => {
    const handler = createRuntimeReadinessActionHandler({
      openExternal: (url) => shell.openExternal(url),
    })
    return handler(action)
  })

  ipcMain.handle('model:delete', async (_, modelId: string): Promise<{ success: boolean; error?: string; warning?: string; skipped?: boolean }> => {
    if (activeDownloads.has(modelId)) {
      return { success: false, error: 'Cannot remove model weights while their download is active' }
    }
    let targets: string[]
    try {
      const { ownership, siblingCapabilityIds } = await resolveOwnershipContext(app.getPath('userData'), modelId)
      const structured = Boolean(ownership.httpsDownloads?.length || ownership.hfDownloads?.length)
      const plan = structured ? null : await resolveModelPlan(modelId)
      const peers = plan ? ownerPeers(plan) : siblingCapabilityIds
      if (peers.length > 0) {
        const warning = plan ? ownerDeleteWarning(plan)
          : `Delete is owner-scoped for '${ownership.weightOwnerId}' and still referenced by: ${peers.join(', ')}`
        return { success: false, error: warning, warning, skipped: true }
      }
      const modelsDir = getSettings(app.getPath('userData')).modelsDir
      const owner = plan ? plan.ownership : ownership
      targets = [...new Set(owner
        ? [owner.weightOwnerId, ...owner.legacyPaths]
        : [modelId])].map((id) => resolveModelRoot(modelsDir, id))
    } catch (err) {
      return { success: false, error: String(err) }
    }

    try {
      const removed = await weightOperations.remove(
        targets, () => unloadForRemoval([modelId]), async (): Promise<Awaited<ReturnType<typeof rmWithRetry>>> => {
          for (const target of targets) {
            const result = await rmWithRetry(target, 'model-delete')
            if (!result.ok) return result
          }
          return { ok: true }
        },
      )
      notifyWeightChange()
      return removed.ok ? { success: true } : {
        success: false, error: removed.locked ? 'Model files are still locked. Try again after closing the model.' : String(removed.error),
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('model:deleteWeightVariant', async (_, modelId: string, variantId: string): Promise<{ success: boolean; error?: string }> => {
    if (activeDownloads.has(modelId)) {
      return { success: false, error: 'Cannot remove model weights while their download is active' }
    }
    try {
      const plan = await resolveModelPlan(modelId)
      if (ownerPeers(plan).length > 0) return { success: false, error: ownerDeleteWarning(plan) }
      const variant = plan.kind === 'legacy'
        ? plan.weightVariants?.options.find((option) => option.id === variantId)
        : undefined
      if (!variant) throw new Error(`Model node "${modelId}" has no weight variant "${String(variantId)}"`)
      const modelsDir = getSettings(app.getPath('userData')).modelsDir
      const storageId = privateModelStorageId(modelsDir, plan)
      const reservedIds = plan.ownership
        ? [...new Set([plan.ownership.weightOwnerId, ...plan.ownership.legacyPaths])]
        : [modelId]
      // Reserve every alias before unload and pin the selected storage path:
      // a canonical download must not race deletion from a legacy directory.
      const removed = await weightOperations.remove(
        reservedIds.map((id) => resolveModelRoot(modelsDir, id)),
        () => unloadForRemoval([modelId]),
        async (): Promise<Awaited<ReturnType<typeof rmWithRetry>>> => {
          for (const file of await listWeightVariantFiles(modelsDir, storageId, variant)) {
            const result = await rmWithRetry(file, 'model-variant-delete')
            if (!result.ok) return result
          }
          return { ok: true }
        },
      )
      notifyWeightChange()
      if (removed.ok) return { success: true }
      return { success: false, error: removed.locked ? LOCKED_MODEL_FILES_ERROR : String(removed.error) }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('model:showInFolder', async (_, modelId: string) => {
    const modelsDir = getSettings(app.getPath('userData')).modelsDir
    let modelDir: string
    try {
      const { ownership } = await resolveOwnershipContext(app.getPath('userData'), modelId)
      modelDir = ownership.httpsDownloads?.length || ownership.hfDownloads?.length
        ? getCanonicalModelPath(modelsDir, ownership)
        : resolveModelRoot(modelsDir, privateModelStorageId(modelsDir, await resolveModelPlan(modelId)))
    } catch {
      // Preserve exploration of old flat folders even without an installed extension.
      modelDir = modelId.includes('/') ? resolveModelRoot(modelsDir, modelId) : resolveExtensionModelRoot(modelsDir, modelId)
    }
    if (existsSync(modelDir)) await shell.openPath(modelDir)
  })

  // Read local file → base64 (bypasses file:// restrictions in the renderer)
  ipcMain.handle('fs:readFileBase64', (_, filePath: string) => readLocalFileBase64(filePath))

  ipcMain.handle('fs:readScreenshotDataUrl', async (_, filename: string) => {
    const filePath = app.isPackaged
      ? join(process.resourcesPath, 'screenshots', filename)
      : join(app.getAppPath(), 'src/assets', filename)
    const buffer = await readFile(filePath)
    return `data:image/png;base64,${buffer.toString('base64')}`
  })

  // Model management
  ipcMain.handle('model:listDownloaded', async () => {
    const settings = getSettings(app.getPath('userData'))
    const extensions = await listVisibleExtensions({
      builtinDir: getBuiltinExtensionsDir(), userExtensionsDir: settings.extensionsDir, trustedRepos: new Set(),
    })
    const models = extensions.filter((extension) => extension.type === 'model' && !extension.corrupted)
    if (models.length === 0) return listDownloadedModels(settings.modelsDir)
    // Directory presence supplies size only, never source/group/variant readiness.
    const sizes = new Map(listDownloadedModelCapabilities(settings.modelsDir, models).map((candidate) => [candidate.id, candidate.size_gb]))
    const ready = await Promise.all(models.flatMap((extension) => extension.nodes.map(async (node) => {
      const id = `${extension.id}/${node.id}`
      try {
        const ownership = resolveModelOwnership(models, id)
        const requiresUpstreamPlan = Boolean(node.hasModelSources || node.weightGroups?.length || node.weightVariants)
        const downloaded = ownership && (ownership.httpsDownloads?.length || ownership.hfDownloads?.length)
          ? isOwnedModelDownloaded(settings.modelsDir, ownership)
            && (!requiresUpstreamPlan || planDownloaded(settings.modelsDir, await resolveModelPlan(id)))
          : planDownloaded(settings.modelsDir, await resolveModelPlan(id))
        return downloaded ? { id, name: node.name, size_gb: sizes.get(id) ?? 0 } : null
      } catch { return null }
    })))
    return ready.filter((candidate) => candidate !== null)
  })

  ipcMain.handle('model:isDownloaded', async (_, modelId: string): Promise<boolean> => {
    try {
      const userData = app.getPath('userData')
      const { ownership, extensions } = await resolveOwnershipContext(userData, modelId)
      if (ownership.httpsDownloads?.length || ownership.hfDownloads?.length) {
        const node = extensions.flatMap((extension) => extension.type === 'model'
          ? extension.nodes.filter((candidate) => (candidate.capabilityId ?? `${extension.id}/${candidate.id}`) === modelId)
          : [])[0]
        const requiresUpstreamPlan = Boolean(node?.hasModelSources || node?.weightGroups?.length || node?.weightVariants)
        const modelsDir = getSettings(userData).modelsDir
        return isOwnedModelDownloaded(modelsDir, ownership)
          && (!requiresUpstreamPlan || planDownloaded(modelsDir, await resolveModelPlan(modelId)))
      }
      return planDownloaded(getSettings(userData).modelsDir, await resolveModelPlan(modelId))
    } catch {
      return false
    }
  })

  // null means "unknown" (unreadable plan, or a node without variants) — the renderer
  // must not read an empty array as "no variant installed".
  ipcMain.handle('model:installedWeightVariants', async (_, modelId: string): Promise<string[] | null> => {
    try {
      const plan = await resolveModelPlan(modelId)
      return plan.kind === 'legacy' && plan.weightVariants
        ? installedWeightVariants(getSettings(app.getPath('userData')).modelsDir, privateModelStorageId(getSettings(app.getPath('userData')).modelsDir, plan), plan.weightVariants)
        : null
    } catch {
      return null
    }
  })

  ipcMain.handle('model:hasLocalData', async (_, modelId: string): Promise<boolean> => {
    try {
      const { ownership } = await resolveOwnershipContext(app.getPath('userData'), modelId)
      const owner = ownership.httpsDownloads?.length || ownership.hfDownloads?.length
        ? ownership : (await resolveModelPlan(modelId)).ownership
      const modelsDir = getSettings(app.getPath('userData')).modelsDir
      const ids = owner ? [owner.weightOwnerId, ...owner.legacyPaths] : [modelId]
      return ids.some((id) => modelHasLocalData(modelsDir, id))
    } catch {
      return false
    }
  })

  ipcMain.handle('model:sharedGroups', async (_, extensionId: string) => {
    try {
      const groups = await resolveInstalledExtensionSharedWeightGroups({
        extensionId,
        userExtensionsDir: getSettings(app.getPath('userData')).extensionsDir,
        builtinExtensionsDir: getBuiltinExtensionsDir(),
        blockedExtensionIds: activeExtensionInstalls,
      })
      const modelsDir = getSettings(app.getPath('userData')).modelsDir
      return groups.map((group) => ({
        id: group.id,
        targetId: group.targetId,
        dependentModelIds: group.dependentModelIds,
        downloaded: areWeightGroupSourcesDownloaded(modelsDir, extensionId, group),
        hasLocalData: weightStorageHasLocalData(modelsDir, group.targetId),
      }))
    } catch {
      return []
    }
  })

  ipcMain.handle('model:deleteSharedGroup', async (
    _,
    extensionId: string,
    groupId: string,
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      const groups = await resolveInstalledExtensionSharedWeightGroups({
        extensionId,
        userExtensionsDir: getSettings(app.getPath('userData')).extensionsDir,
        builtinExtensionsDir: getBuiltinExtensionsDir(),
        blockedExtensionIds: activeExtensionInstalls,
      })
      const group = groups.find((candidate) => candidate.id === groupId)
      if (!group) return { success: false, error: `Unknown shared weight group: ${groupId}` }
      const groupRoot = resolveWeightGroupRoot(
        getSettings(app.getPath('userData')).modelsDir,
        extensionId,
        group.id,
      )
      const removed = await weightOperations.remove(
        [groupRoot],
        () => unloadForRemoval(group.dependentModelIds),
        () => rmWithRetry(groupRoot, 'shared-model-delete'),
      )
      notifyWeightChange()
      if (removed.ok) return { success: true }
      return {
        success: false,
        error: removed.locked
          ? 'Shared model files are still locked. Close any programs using them and try again.'
          : String(removed.error),
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('model:deleteExtensionWeights', async (
    _,
    extensionId: string,
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      const safeExtensionId = assertSafeExtensionId(extensionId)
      if ([...activeDownloads.keys()].some((modelId) => modelId.split('/', 1)[0] === safeExtensionId)) {
        return { success: false, error: 'Cannot remove extension weights while a download is active' }
      }
      const extensionRoot = resolveExtensionModelRoot(
        getSettings(app.getPath('userData')).modelsDir,
        safeExtensionId,
      )
      const removed = await weightOperations.remove(
        [extensionRoot],
        () => unloadExtensionForRemoval(safeExtensionId),
        () => rmWithRetry(extensionRoot, 'extension-model-delete'),
      )
      notifyWeightChange()
      if (removed.ok) return { success: true }
      return {
        success: false,
        error: removed.locked
          ? 'Extension model files are still locked. Close any programs using them and try again.'
          : String(removed.error),
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('model:activeDownloads', () =>
    [...activeDownloads.entries()].map(([modelId, active]) => ({ capabilityId: modelId, modelId, ...active.progress }))
  )

  ipcMain.handle('model:downloadAssets', (event, payload: unknown) => (
    handleStructuredModelAssetDownload(
      event,
      payload,
      downloadModelAssetsFromHF,
    )
  ))

  ipcMain.handle('model:downloadHttpsAssets', (event, payload: unknown) => (
    handleStructuredModelAssetDownload(
      event,
      payload,
      downloadModelAssetsFromHttps,
    )
  ))

  const downloadInstalledModel = async (
    event: IpcMainInvokeEvent,
    modelId: string,
    requestedVariantId?: string | null,
  ) => {
    if (activeDownloads.has(modelId)) {
      return { success: false, error: 'Download already in progress' }
    }
    const variantId = requestedVariantId ?? undefined
    let plan: Awaited<ReturnType<typeof resolveInstalledModelDownloadPlan>>
    let legacySteps: ReturnType<typeof legacyDownloadSteps> = []
    try {
      plan = await resolveModelPlan(modelId)
      if (plan.kind === 'multi-source') {
        if (variantId !== undefined) throw new Error(`Model node "${modelId}" does not declare weight variants`)
      } else if (plan.kind === 'legacy') {
        // Shared files first (every variant excluded), then the requested variant.
        legacySteps = legacyDownloadSteps(plan, variantId)
      } else {
        if (variantId !== undefined) throw new Error(`Model node "${modelId}" does not declare weight variants`)
        return handleStructuredModelAssetDownload(event, { modelId }, plan.kind === 'hf-assets' ? downloadModelAssetsFromHF : downloadModelAssetsFromHttps)
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
    if (activeDownloads.has(modelId)) {
      return { success: false, error: 'Download already in progress' }
    }

    const modelsDir = getSettings(app.getPath('userData')).modelsDir
    const privateTargetId = plan.ownership?.weightOwnerId ?? modelId
    const allTargets = plan.kind === 'multi-source'
      ? [
          ...plan.sharedGroups.map((group) => ({
            targetId: group.targetId,
            label: `Shared · ${group.id}`,
            sources: group.sources,
          })),
          ...(plan.sources.length > 0 ? [{
            targetId: privateTargetId,
            label: 'Node-specific',
            sources: plan.sources,
          }] : []),
        ]
      : []
    const targetRoots = plan.kind === 'multi-source'
      ? allTargets.map((target) => resolveWeightStorageRoot(modelsDir, target.targetId))
      : [resolveModelRoot(modelsDir, privateTargetId)]
    let release: () => void
    try {
      release = weightOperations.acquire(`downloading ${modelId}`, targetRoots)
    } catch (err) {
      return { success: false, error: String(err) }
    }
    const managedTargets = allTargets.filter((target) => !areModelSourcesDownloadedAtRoot(
      resolveWeightStorageRoot(modelsDir, target.targetId), target.sources,
    ))

    let finish!: () => void
    const done = new Promise<void>((resolveDone) => { finish = resolveDone })
    const active: ActiveDownload = { progress: { percent: 0, variantId }, done, finish, targetRoots }
    activeDownloads.set(modelId, active)
    interruptedTargets.set(modelId, targetRoots)
    try {
      const onProgress = (progress: DownloadProgress) => {
        active.progress = { ...progress, variantId }
        event.sender.send('model:downloadProgress', { capabilityId: modelId, modelId, variantId, ...progress })
      }
      if (plan.kind === 'multi-source') {
        if (managedTargets.length === 0) {
          onProgress({ percent: 100 })
        }
        for (const [index, target] of managedTargets.entries()) {
          if (active.stopRequested) throw new Error(`Model download ${active.stopRequested === 'pause' ? 'paused' : 'cancelled'}`)
          active.currentTargetId = target.targetId
          await downloadModelSourcesFromHF(modelId, target.targetId, (progress) => {
            if (progress.paused) active.stopRequested = 'pause'
            if (progress.cancelled) active.stopRequested = 'cancel' 
            const aggregatePercent = Math.min(
              99,
              Math.round(((index + progress.percent / 100) / managedTargets.length) * 100),
            )
            onProgress({
              ...progress,
              percent: aggregatePercent,
              status: progress.status ? `${target.label} · ${progress.status}` : target.label,
            })
          })
          notifyWeightChange()
        }
        if (active.stopRequested) throw new Error(`Model download ${active.stopRequested === 'pause' ? 'paused' : 'cancelled'}`)
        if (managedTargets.length > 0) onProgress({ percent: 100, status: 'done' })
      } else if (plan.kind === 'legacy') {
        active.currentTargetId = privateTargetId
        // Shared files and the variant are separate passes sharing one 0-100 bar.
        for (const [index, step] of legacySteps.entries()) {
          if (active.stopRequested) throw new Error(`Model download ${active.stopRequested === 'pause' ? 'paused' : 'cancelled'}`)
          await downloadModelFromHF(
            plan.repoId,
            modelId,
            (progress) => {
              if (progress.paused) active.stopRequested = 'pause'
              if (progress.cancelled) active.stopRequested = 'cancel'
              onProgress({ ...progress, percent: Math.round((index * 100 + progress.percent) / legacySteps.length) })
            },
            step.skipPrefixes,
            step.includePrefixes,
          )
        }
      }
      if (active.stopRequested) throw new Error(`Model download ${active.stopRequested === 'pause' ? 'paused' : 'cancelled'}`)
      interruptedTargets.delete(modelId)
      return { success: true }
    } catch (err: any) {
      const message = err?.message ?? String(err)
      if (message.includes('paused')) {
        event.sender.send('model:downloadProgress', { capabilityId: modelId, modelId, variantId, percent: 0, status: 'paused', paused: true })
        return { success: false, paused: true }
      }
      if (message.includes('cancelled')) {
        event.sender.send('model:downloadProgress', { capabilityId: modelId, modelId, variantId, percent: 0, status: 'cancelled', cancelled: true })
        return { success: false, cancelled: true }
      }
      return { success: false, error: String(err) }
    } finally {
      if (activeDownloads.get(modelId) === active) activeDownloads.delete(modelId)
      release()
      active.finish()
      notifyWeightChange()
    }
  }
  ipcMain.handle('model:download', downloadInstalledModel)
  ipcMain.handle('model:downloadSources', async (event, payload: unknown) => {
    try {
      const { modelId } = parseLegacyModelDownloadPayloadContract(payload)
      const plan = await resolveModelPlan(modelId)
      if (plan.kind !== 'multi-source') throw new Error(`Model node "${modelId}" does not declare model_sources`)
      return downloadInstalledModel(event, modelId)
    } catch (error) { return modelAssetDownloadResult(error) }
  })

  ipcMain.handle('model:pauseDownload', async (_, modelId: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const active = activeDownloads.get(modelId)
      const targetId = active?.currentTargetId
      if (!active || !targetId) return { success: false, error: 'No active download target' }
      active.stopRequested = 'pause'
      await axios.post(`${API_BASE_URL}/model/hf-download/pause`, null, {
        params: { model_id: targetId },
        timeout: 5000,
      })
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('model:cancelDownload', async (_, modelId: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const active = activeDownloads.get(modelId)
      if (active) active.stopRequested = 'cancel'
      if (active?.currentTargetId) {
        await axios.post(`${API_BASE_URL}/model/hf-download/cancel`, null, {
          params: { model_id: active.currentTargetId },
          timeout: 5000,
        })
      }
      if (active) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            active.done,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Timed out waiting for the download to stop')), 30_000)
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
      }
      const roots = active?.targetRoots ?? interruptedTargets.get(modelId) ?? [resolveModelRoot(
        getSettings(app.getPath('userData')).modelsDir, (await resolveModelPlan(modelId)).ownership?.weightOwnerId ?? modelId,
      )]
      // Another sibling may have resumed these targets after our session stopped.
      const release = weightOperations.acquire(`cancelling ${modelId}`, roots)
      try {
        await Promise.all(roots.map((root) => removePartialDownloadArtifacts(root)))
        interruptedTargets.delete(modelId)
      } finally {
        release()
        notifyWeightChange()
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // Export mesh to GLB / STL / OBJ
  ipcMain.handle('model:export', async (_, { outputUrl, format }: { outputUrl: string; format: string }) => {
    const win = getWindow()
    if (!win) return { success: false, error: 'No window' }

    const meshPath = outputUrl.replace(/^\/workspace\//, '')
    const baseName = meshPath.split('/').pop()?.replace(/\.\w+$/, '') ?? 'model'

    const result = await dialog.showSaveDialog(win, {
      title: 'Export 3D Model',
      defaultPath: `${baseName}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    })
    if (result.canceled || !result.filePath) return { success: false }

    try {
      const response = await axios.get(
        `${API_BASE_URL}/export/${format}?path=${encodeURIComponent(meshPath)}`,
        { responseType: 'arraybuffer' }
      )
      await writeFile(result.filePath, Buffer.from(response.data as ArrayBuffer))
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // Shell
  ipcMain.handle('shell:openExternal', (_, url: string) => shell.openExternal(url))

  // Open a model in OrcaSlicer via its orcaslicer://open?file=<url> deeplink.
  //
  // The returned error only covers the shell refusing the call outright. It is
  // NOT an install check: on Windows an unregistered scheme still makes
  // ShellExecuteEx succeed — the OS shows its own "You'll need a new app to open
  // this orcaslicer link" dialog and this resolves with success. Detecting a
  // missing OrcaSlicer would take a per-platform handler probe (registry on
  // Windows), so the renderer must not promise the user that it knows.
  ipcMain.handle('slicer:open', async (_, url: string): Promise<{ success: boolean; error?: string }> => {
    if (typeof url !== 'string' || !url.startsWith('orcaslicer://')) {
      return { success: false, error: 'slicer:open requires an orcaslicer:// URL' }
    }
    try {
      await shell.openExternal(url)
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // App info
  // System memory (used/available/total bytes).
  // On macOS, matches Activity Monitor's "Memory Used":
  //     used = wired + active + compressed.
  ipcMain.handle('system:memory', async () => {
    const total = os.totalmem()

    if (process.platform === 'darwin') {
      try {
        const { stdout } = await pExecFile('vm_stat', [])
        const pageSizeMatch = stdout.match(/page size of (\d+) bytes/)
        const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1]!, 10) : 16384

        const pagesFor = (label: string): number => {
          const m = stdout.match(new RegExp(`${label}:\\s+(\\d+)`))
          return m ? parseInt(m[1]!, 10) : 0
        }

        const active = pagesFor('Pages active')
        const wired = pagesFor('Pages wired down')
        const compressed = pagesFor('Pages occupied by compressor')

        const used = (active + wired + compressed) * pageSize
        const available = Math.max(0, total - used)
        return { total, used, available }
      } catch {
        // Fall back to total - free outside Activity Monitor semantics.
      }
    }

    const free = os.freemem()
    return { total, used: total - free, available: free }
  })

  ipcMain.handle('app:info', () => ({
    version:   app.getVersion(),
    userData:  app.getPath('userData'),
    modelsDir: getSettings(app.getPath('userData')).modelsDir,
    apiUrl:    API_BASE_URL,
    platform:  process.platform,
    arch:      process.arch,
  }))

  // Settings — decrypt the HF token (migrating a legacy plaintext one) and seed
  // it into the main-process env at startup.
  {
    const token = initHfToken(app.getPath('userData'))
    if (token) {
      process.env['HUGGING_FACE_HUB_TOKEN'] = token
      process.env['HF_TOKEN']               = token
    }
  }

  ipcMain.handle('settings:get', () => {
    // hfToken is stored encrypted — hand the renderer the usable value.
    return { ...getSettings(app.getPath('userData')), hfToken: getHfToken() }
  })

  ipcMain.handle('settings:set', async (_event, patch: { modelsDir?: string; workspaceDir?: string; extensionsDir?: string; hfToken?: string }) => {
    if (patch.modelsDir !== undefined && weightOperations.busy) {
      throw new Error('Cannot change model storage while model weights are busy')
    }
    const { hfToken, ...dirs } = patch
    setSettings(app.getPath('userData'), dirs)
    // Keep main-process env in sync so child processes spawned after token change inherit it
    if (hfToken !== undefined) {
      setHfToken(app.getPath('userData'), hfToken)
      process.env['HUGGING_FACE_HUB_TOKEN'] = hfToken
      process.env['HF_TOKEN']               = hfToken
      // Also push the token into the live FastAPI process env so extension
      // subprocesses spawned by ExtensionProcess._build_env() pick it up
      // without requiring a full app restart.
      try {
        await axios.post(`${API_BASE_URL}/settings/hf-token`, { token: hfToken }, { timeout: 3000 })
      } catch { /* FastAPI may not be running yet — ignore */ }
    }
    return { ...getSettings(app.getPath('userData')), hfToken: getHfToken() }
  })

  // Directory picker
  ipcMain.handle('fs:selectDirectory', async (_event, defaultPath?: string) => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      ...(defaultPath && { defaultPath }),
    })
    if (result.canceled || !result.filePaths[0]) return null
    try {
      return await rendererFilesystemAccess.grantSelectedDirectory(result.filePaths[0])
    } catch {
      return null
    }
  })

  // Cache clear — deletes and recreates the gen-cache folder
  // NOTE: userData/cache (lowercase) = Chromium disk cache on Windows (case-insensitive)
  //       → use a dedicated subfolder to avoid collision
  ipcMain.handle('cache:clear', async () => {
    const cacheDir = join(app.getPath('userData'), 'gen-cache')
    try {
      if (existsSync(cacheDir)) {
        await rmAsync(cacheDir, { recursive: true, force: true })
      }
      await mkdir(cacheDir, { recursive: true })
      return { success: true }
    } catch (err) {
      console.error('[cache:clear] error:', err)
      return { success: false, error: String(err) }
    }
  })

  // Workspace filesystem-based persistence
  const workspacePath = (...parts: string[]) =>
    join(getSettings(app.getPath('userData')).workspaceDir, ...parts)

  registerWorkspaceAssetLibraryIpcHandlers({
    ipcMain,
    getWorkspaceDir: () => getSettings(app.getPath('userData')).workspaceDir,
  })
  registerArtifactRegistryIpcHandlers({
    ipcMain,
    getWorkspaceDir: () => getSettings(app.getPath('userData')).workspaceDir,
    showSaveDialog: async ({ defaultPath, title }) => {
      const win = getWindow()
      const result = await dialog.showSaveDialog(win!, {
        title,
        defaultPath,
      })
      return { canceled: result.canceled, filePath: result.filePath }
    },
  })

  ipcMain.handle('workspace:worlds:writeSceneManifest', async (event, request: WorldsSceneManifestWriteRequest): Promise<WorldsSceneManifestWriteResult> => {
    if (!isTrustedMainFrameSender(event)) {
      return { success: false, error: 'Worlds scene manifest request is unauthorized.' }
    }
    const workspaceDir = getSettings(app.getPath('userData')).workspaceDir
    return writeWorldsSceneManifest(workspaceDir, request)
  })

  ipcMain.handle('workspace:listCollections', async () => {
    const base = workspacePath()
    await mkdir(base, { recursive: true })
    const entries = await readdir(base, { withFileTypes: true })
    return entries.filter(e => e.isDirectory()).map(e => e.name)
  })

  ipcMain.handle('workspace:createCollection', async (_, name: string) => {
    await mkdir(workspacePath(name), { recursive: true })
  })

  ipcMain.handle('workspace:renameCollection', async (_, { oldName, newName }: { oldName: string; newName: string }) => {
    await rename(workspacePath(oldName), workspacePath(newName))
  })

  ipcMain.handle('workspace:deleteCollection', async (_, name: string) => {
    await rmAsync(workspacePath(name), { recursive: true, force: true })
  })

  ipcMain.handle('workspace:listJobs', async (_, collection: string) => {
    try {
      const files = await readdir(workspacePath(collection))
      const metas = files.filter(f => f.endsWith('.meta.json'))
      return Promise.all(metas.map(async f => {
        const raw = await readFile(workspacePath(collection, f), 'utf-8')
        return JSON.parse(raw)
      }))
    } catch { return [] }
  })

  ipcMain.handle('workspace:saveJobMeta', async (_, { collection, filename, meta }: { collection: string; filename: string; meta: unknown }) => {
    const metaFile = filename.replace(/\.glb$/, '.meta.json')
    await writeFile(workspacePath(collection, metaFile), JSON.stringify(meta, null, 2), 'utf-8')
  })

  ipcMain.handle('workspace:deleteJob', async (_, { collection, filename }: { collection: string; filename: string }) => {
    await rmAsync(workspacePath(collection, filename), { force: true })
    await rmAsync(workspacePath(collection, filename.replace(/\.glb$/, '.meta.json')), { force: true })
  })

  // Directory utilities for settings
  ipcMain.handle('fs:listDir', async (_, dirPath: string) => {
    try {
      const safeDirectory = await rendererFilesystemAccess.resolveListDirectory(dirPath)
      const entries = await readdir(safeDirectory, { withFileTypes: true })
      return entries.filter(e => e.isDirectory()).map(e => e.name)
    } catch {
      return []
    }
  })

  // List files (not directories) in a folder, optionally filtered by extension.
  // `extensions` are lowercase without the dot (e.g. ['txt', 'png']).
  ipcMain.handle('fs:listFiles', async (_, dirPath: string, extensions?: string[]) => {
    try {
      if (extensions !== undefined && (!Array.isArray(extensions) || extensions.length > 32
        || extensions.some((extension) => typeof extension !== 'string' || !/^[.]?[a-z0-9]{1,16}$/i.test(extension)))) {
        return []
      }
      const safeDirectory = await rendererFilesystemAccess.resolveListFiles(dirPath)
      const wanted = extensions?.map(e => e.toLowerCase().replace(/^\./, ''))
      const entries = await readdir(safeDirectory, { withFileTypes: true })
      return entries
        .filter(e => e.isFile())
        .map(e => e.name)
        .filter(name => {
          if (!wanted || wanted.length === 0) return true
          const ext = name.split('.').pop()?.toLowerCase() ?? ''
          return wanted.includes(ext)
        })
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    } catch {
      return []
    }
  })

  // Text-file picker for the standalone Load Prompt node.
  ipcMain.handle('fs:selectTextFile', async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Select a prompt text file',
      filters: [{ name: 'Text', extensions: ['txt', 'md', 'prompt'] }],
      properties: ['openFile'],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // Add a local GGUF to the agent's models folder. Picking and copying both
  // happen here, so the renderer never hands main an arbitrary path to copy.
  ipcMain.handle('agent:addModel', async (): Promise<{ success: boolean; cancelled?: boolean; fileName?: string; error?: string }> => {
    const win = getWindow()
    if (!win) return { success: false, error: 'No window available' }
    const result = await dialog.showOpenDialog(win, {
      title: 'Add a model',
      filters: [{ name: 'GGUF model', extensions: ['gguf'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return { success: false, cancelled: true }

    const src      = result.filePaths[0]
    const fileName = basename(src)
    if (!fileName.toLowerCase().endsWith('.gguf')) return { success: false, error: 'Only .gguf files can be added.' }

    const modelsDir = join(getSettings(app.getPath('userData')).agentDir, 'models')
    const dest      = join(modelsDir, fileName)
    if (existsSync(dest)) return { success: false, error: `"${fileName}" is already in your models.` }

    // Copied under a temporary name first: the API lists every *.gguf in the
    // folder, so a multi-GB copy in progress would otherwise show up as a model.
    const partial = `${dest}.part`
    try {
      await mkdir(modelsDir, { recursive: true })
      await copyFile(src, partial)
      await rename(partial, dest)
      return { success: true, fileName }
    } catch (err) {
      await rmAsync(partial, { force: true }).catch(() => {})
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('fs:moveDirectory', async (_, request: { src: string; dest: string }) => {
    try {
      const { src, dest } = await rendererFilesystemAccess.resolveMoveDirectory(request)
      await cp(src, dest, { recursive: true, force: false, errorOnExist: true })
      await rmAsync(src, { recursive: true, force: false })
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('fs:deleteDirectory', async (_, dirPath: string) => {
    try {
      const safeDirectory = await rendererFilesystemAccess.resolveDeleteDirectory(dirPath)
      await rmAsync(safeDirectory, { recursive: true, force: true })
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  async function reloadAndValidateModelExtension(
    manifest: ParsedManifest,
    extensionId: string,
    validationCapability?: ExtensionRegistrationValidationCapability,
  ): Promise<void> {
    const expectedIds = expectedModelIds({ ...manifest, id: extensionId })
    if (expectedIds.length === 0) return

    let payload: unknown
    try {
      const response = await axios.post(
        `${API_BASE_URL}/extensions/reload`,
        validationCapability ? { validationCapability } : {},
        { timeout: 10_000 },
      )
      payload = response.data
    } catch (err) {
      throw new Error(
        `Could not validate runtime registration for extension "${extensionId}": ${String(err)}`,
      )
    }
    validateExtensionReloadPayload(payload, extensionId, expectedIds)
  }

  async function quarantineModelExtensionRuntime(
    manifest: ParsedManifest,
    extensionId: string,
  ): Promise<void> {
    const forbiddenIds = expectedModelIds({ ...manifest, id: extensionId })
    if (forbiddenIds.length === 0) return

    let payload: unknown
    try {
      const response = await axios.post(
        `${API_BASE_URL}/extensions/reload`,
        {},
        { timeout: 10_000 },
      )
      payload = response.data
    } catch (err) {
      throw new Error(
        `Could not quarantine runtime registration for extension "${extensionId}": `
        + `${String(err)}`,
      )
    }
    validateExtensionQuarantinePayload(payload, extensionId, forbiddenIds)
  }

  async function rollbackFailedExtensionUpdate(
    extensionsDir: string,
    destinationDir: string,
    backupDir: string,
    extensionId: string,
    originalFailure: unknown,
  ): Promise<never> {
    const restored = await restoreExtensionBackup(destinationDir, backupDir, logger)
    if (!restored.ok) {
      throw new Error(
        `Extension update failed, and Modly could not restore the previous version `
        + `during ${restored.stage}: ${String(restored.error)}. `
        + `Restart Modly to retry recovery. Original failure: ${String(originalFailure)}`,
      )
    }

    const stateCleared = await clearExtensionRegistrationTransaction(
      extensionsDir,
      extensionId,
      logger,
    )
    if (!stateCleared.ok) {
      throw new Error(
        `Extension update failed and the previous version was restored, but Modly `
        + `could not clear recovery state during ${stateCleared.stage}: `
        + `${String(stateCleared.error)}. Original failure: ${String(originalFailure)}`,
      )
    }

    try {
      const previousManifest = JSON.parse(
        await readFile(join(destinationDir, 'manifest.json'), 'utf-8'),
      ) as ParsedManifest
      if (previousManifest.type !== 'process') {
        await reloadAndValidateModelExtension(previousManifest, extensionId)
      }
    } catch (reloadError) {
      throw new Error(
        `Extension update failed and the previous version was restored on disk, `
        + `but Modly could not reload it: ${String(reloadError)}. `
        + `Original failure: ${String(originalFailure)}`,
      )
    }

    throw new Error(
      `Extension update failed before runtime registration could be committed, `
      + `so the previous version was restored. `
      + `${String(originalFailure)}`,
    )
  }

  async function cleanupValidatedBackupsOrThrow(
    extensionsDir: string,
    extensionId: string,
  ): Promise<void> {
    const cleaned = await cleanupValidatedExtensionBackups(extensionsDir, extensionId, logger)
    if (!cleaned.ok) {
      throw new Error(
        `Runtime registration succeeded, but Modly could not finish removing the previous `
        + `extension backup during ${cleaned.stage}: ${String(cleaned.error)}. `
        + `Restart Modly to retry the validated cleanup.`,
      )
    }
  }

  // Extensions — reads user extensions directory + built-in extensions directory
  ipcMain.handle('extensions:list', async () => {
    const userData      = app.getPath('userData')
    const extensionsDir = getSettings(userData).extensionsDir
    const builtinDir    = getBuiltinExtensionsDir()

    const trustedRepos = await fetchTrustedRepos()

    return listVisibleExtensions({ builtinDir, userExtensionsDir: extensionsDir, trustedRepos })
  })

  ipcMain.handle('automation:capabilities', () => getAutomationCapabilities())

  ipcMain.handle('agentCapabilities:list', sharedAgentCapabilityResolver.forRendererIpc)

  // Bundle discovery wraps the same transactional install and setup contract.
  ipcMain.handle('extensions:installFromGitHub', async (_event, githubUrl: string) => {
    const builtinDir = getBuiltinExtensionsDir()
    const builtinExtensionIds = new Set(existsSync(builtinDir)
      ? readdirSync(builtinDir).filter((entry) => statSync(join(builtinDir, entry)).isDirectory())
      : [])
    return installGitHubExtensionRepo({
      githubUrl,
      extensionsDir: getSettings(app.getPath('userData')).extensionsDir,
      builtinExtensionIds,
      trustedRepos: await fetchTrustedRepos(),
      emitProgress: (progress) => getWindow()?.webContents.send('extensions:installProgress', progress),
      operations: {
        terminateProcessRunner,
        async runExtensionSetup({ destinationDir, onLog }) {
          const gpu = await detectGpuInfo({ onLog: (line) => logger.info(line) })
          logger.info(`[ext-setup] ${describeGpuInfo(gpu)}`)
          await runExtensionSetup(destinationDir, gpu, (line) => {
            logger.info(`[ext-setup] ${line}`)
            onLog?.(line)
          })
        },
        async reloadExtensions(validationCapabilities) {
          const { data } = await axios.post(
            `${API_BASE_URL}/extensions/reload`,
            validationCapabilities.length ? { validationCapabilities } : {},
            { timeout: 10_000 },
          )
          return data
        },
      },
    })
  })

  // Uninstall an extension — built-ins cannot be uninstalled
  ipcMain.handle('extensions:uninstall', async (_, extensionId: string) => {
    try {
      if ([...activeDownloads.keys()].some((modelId) => modelId.split('/', 1)[0] === extensionId)) {
        return { success: false, error: 'Cannot uninstall an extension while its model download is active' }
      }
      // Corrupted folders can carry arbitrary names (manual copies, failed
      // unzips), so only enforce root confinement for the deletion path. The
      // strict id pattern still guards the built-in check — a non-conforming
      // name can never be a built-in.
      const extensionsDir = getSettings(app.getPath('userData')).extensionsDir

      let safeExtensionId: string | undefined
      try {
        safeExtensionId = assertSafeExtensionId(extensionId)
        if (existsSync(resolveExtensionPathWithinRoot(getBuiltinExtensionsDir(), safeExtensionId))) {
          return { success: false, error: `"${safeExtensionId}" is a built-in extension and cannot be uninstalled.` }
        }
      } catch { /* non-conforming folder name → not a built-in */ }

      if (safeExtensionId) {
        const extensionRoot = resolveExtensionModelRoot(getSettings(app.getPath('userData')).modelsDir, safeExtensionId)
        const ownerId = safeExtensionId
        const weightsRemoved = await weightOperations.remove(
          [extensionRoot],
          () => unloadExtensionForRemoval(ownerId),
          () => rmWithRetry(extensionRoot, 'extension-model-delete'),
        )
        if (!weightsRemoved.ok) return { success: false, error: String(weightsRemoved.error) }
        notifyWeightChange()
      }

      // Terminate process runner if it's a process extension
      terminateProcessRunner(extensionId)

      const removed = await removeExtensionWithBackups(
        extensionsDir,
        String(extensionId),
        logger,
      )
      if (!removed.ok) {
        return {
          success: false,
          error: removed.locked
            ? `Could not delete the extension ${removed.stage === 'backup' ? 'backup' : 'folder'} `
              + '— a file inside it is locked (antivirus or a running process). '
              + 'Close what might be using it and try again.'
            : `Could not uninstall the extension during ${removed.stage}: ${String(removed.error)}`,
        }
      }
      // Hot-reload Python so it stops using the deleted model extension
      try {
        await axios.post(`${API_BASE_URL}/extensions/reload`, {}, { timeout: 10_000 })
      } catch { /* ignore if Python is not running */ }
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // Re-run setup.py for a model extension (creates the venv if missing)
  ipcMain.handle('extensions:repair', async (_, extensionId: string) => {
    try {
      const safeExtensionId = assertSafeExtensionId(extensionId)
      const extensionsDir = getSettings(app.getPath('userData')).extensionsDir
      const extDir = resolveExtensionPathWithinRoot(extensionsDir, safeExtensionId)
      if (!existsSync(join(extDir, 'setup.py'))) {
        return { success: false, error: 'setup.py is missing from the extension folder — the install looks incomplete. Uninstall the extension and install it again.' }
      }
      const manifestRaw = await readFile(join(extDir, 'manifest.json'), 'utf-8')
      const manifest = JSON.parse(manifestRaw) as ParsedManifest
      const { isProcess } = validateInstallManifest(
        manifest,
        {
          hasEntryFile: (candidate) => existsSync(join(extDir, candidate)),
          hasGeneratorFile: () => existsSync(join(extDir, 'generator.py')),
        },
        'extension folder',
      )
      const gpu = await detectGpuInfo({ onLog: (line) => logger.info(line) })
      logger.info(`[ext-repair] ${describeGpuInfo(gpu)}`)
      await runExtensionRepairTransaction(
        {
          extensionsDir,
          extensionId: safeExtensionId,
          destinationDir: extDir,
          suffix: String(Date.now()),
          quarantine: async () => {
            terminateProcessRunner(safeExtensionId)
            if (!isProcess) {
              await quarantineModelExtensionRuntime(manifest, safeExtensionId)
            }
          },
          setup: () => runExtensionSetup(
            extDir,
            gpu,
            (line) => logger.info(`[ext-repair] ${line}`),
          ),
          validate: async (validationCapability) => {
            if (!isProcess) {
              await reloadAndValidateModelExtension(
                manifest,
                safeExtensionId,
                validationCapability,
              )
            }
          },
        },
        logger,
      )
      return { success: true }
    } catch (err: any) {
      return { success: false, error: `Repair failed: ${err?.message ?? err}` }
    }
  })

  // Install a local extension by creating a symlink/junction to a local folder
  ipcMain.handle('extensions:installFromLocal', async () => {
    const win  = getWindow()
    const emit = (data: object) => win?.webContents.send('extensions:installProgress', data)

    // 1. Open folder picker
    const pickResult = await dialog.showOpenDialog(win!, {
      title:      'Select local extension folder',
      properties: ['openDirectory'],
    })
    if (pickResult.canceled || pickResult.filePaths.length === 0) {
      return { success: false, cancelled: true }
    }
    const localPath = pickResult.filePaths[0]

    try {
      emit({ step: 'validating' })

      // 2. Read and validate manifest.json
      const manifestPath = join(localPath, 'manifest.json')
      if (!existsSync(manifestPath)) {
        throw new Error('manifest.json not found in the selected folder')
      }
      const manifestRaw = await readFile(manifestPath, 'utf-8')
      const manifest    = JSON.parse(manifestRaw) as ParsedManifest

      const { id: rawManifestId, isProcess } = validateInstallManifest(
        manifest,
        {
          hasEntryFile:     (candidate) => existsSync(join(localPath, candidate)),
          hasGeneratorFile: ()          => existsSync(join(localPath, 'generator.py')),
        },
        'local folder',
      )
      const extensionId = assertSafeExtensionId(rawManifestId)
      const trustedRepos = await fetchTrustedRepos()
      const annotatedManifest = { ...manifest, source: `local://${localPath}` }
      const ext = parseManifestForInstall(annotatedManifest, extensionId, trustedRepos)

      // 3. Create symlink / junction in extensionsDir
      const userData      = app.getPath('userData')
      const extensionsDir = getSettings(userData).extensionsDir
      await mkdir(extensionsDir, { recursive: true })

      const linkPath = resolveExtensionPathWithinRoot(extensionsDir, extensionId)
      const installSuffix = String(Date.now())
      let backupDir: string | null = null

      // Inspect an existing local link without mutating it. The host-side
      // pending transaction is created before the link is ever parked or
      // replaced, so a crash cannot expose the new target as validated.
      if (existsSync(linkPath)) {
        const currentManifestPath = join(linkPath, 'manifest.json')
        if (!existsSync(currentManifestPath)) {
          throw new Error(
            `Cannot safely replace local extension "${extensionId}" because its existing `
            + 'manifest.json is missing. Uninstall it first.',
          )
        }
        const currentManifest = JSON.parse(
          await readFile(currentManifestPath, 'utf-8'),
        ) as ParsedManifest
        assertCompatibleExtensionUpdateType(currentManifest, manifest)

        const linkStat = await lstat(linkPath)
        if (!linkStat.isSymbolicLink() && !(process.platform === 'win32' && linkStat.isDirectory())) {
          throw new Error(
            `A non-symlink folder named "${extensionId}" already exists in `
            + 'extensionsDir. Remove it first.',
          )
        }
        backupDir = buildExtensionBackupPath(extensionsDir, extensionId, installSuffix)
      }

      try {
        await runExtensionRegistrationValidationTransaction(
          {
            extensionsDir,
            extensionId,
            suffix: installSuffix,
            quarantine: async () => {
              terminateProcessRunner(extensionId)
              if (!isProcess) {
                await quarantineModelExtensionRuntime(manifest, extensionId)
              }
            },
            activate: async () => {
              emit({ step: 'setting_up', message: 'Linking local folder…' })
              if (backupDir) {
                const parked = await renameWithRetry(linkPath, backupDir, 'ext-local')
                if (!parked.ok) {
                  throw new Error(
                    `Could not preserve the previous local extension: `
                    + `${String(parked.error)}`,
                  )
                }
              }

              if (process.platform === 'win32') {
                // Windows: junction (no elevation needed, works for directories)
                await symlink(localPath, linkPath, 'junction')
              } else {
                // macOS / Linux: standard symlink
                await symlink(localPath, linkPath)
              }

              // The sentinel lives in the linked source folder. Runtime
              // registration is still pending externally until validation.
              await writeFile(join(linkPath, '.modly-local'), localPath, 'utf-8')
            },
            validate: async (validationCapability) => {
              if (!isProcess) {
                await reloadAndValidateModelExtension(
                  manifest,
                  extensionId,
                  validationCapability,
                )
              }
            },
          },
          logger,
        )
      } catch (err) {
        if (backupDir && existsSync(backupDir)) {
          await rollbackFailedExtensionUpdate(
            extensionsDir,
            linkPath,
            backupDir,
            extensionId,
            err,
          )
        }

        // Local links intentionally do not run setup. A fresh model that
        // cannot register remains linked, externally quarantined, and visible
        // only as a Repairable entry.
        if (!isProcess && existsSync(linkPath)) {
          const error = (
            `The local extension was linked, but it is not runtime-ready. `
            + `Click 'Repair' on its extension card, then retry. ${String(err)}`
          )
          emit({ step: 'error', extensionId, message: error })
          return {
            success: false,
            needsRepair: true,
            error,
            extensionId,
            extension: markExtensionInstallationInterrupted(ext, true),
            localPath,
          }
        }
        throw err
      }

      emit({ step: 'done', extensionId })
      return { success: true, extensionId, extension: ext, localPath }

    } catch (err) {
      emit({ step: 'error', message: String(err) })
      return { success: false, error: String(err) }
    }
  })

  // Trigger Python extension reload (without touching the filesystem)
  ipcMain.handle('extensions:reload', async () => {
    terminateAllProcessRunners()
    try {
      const res = await axios.post(`${API_BASE_URL}/extensions/reload`, {}, { timeout: 10_000 })
      return { success: true, errors: (res.data as { errors?: Record<string, string> }).errors ?? {} }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // Run a process extension in an isolated worker thread
  ipcMain.handle('extensions:runProcess', async (_, extensionId: string, input: ProcessInput, params: Record<string, unknown>) => {
    return runProcessExtensionWithDeps({
      extensionId,
      input,
      params,
      getUserDataPath: () => app.getPath('userData'),
      getTempPath: () => app.getPath('temp'),
      getSettings,
      getBuiltinExtensionsDir,
      getExtPythonExe,
      getVenvPythonExe,
      getProcessRunner,
      getPythonProcessRunner,
    })
  })

  // Terminate all process runners on app quit
  app.on('before-quit', () => terminateAllProcessRunners())

  // Auto-updater
  ipcMain.handle('updater:check', async () => {
    if (!app.isPackaged || !updatesSupported) return { success: false }
    try {
      await autoUpdater.checkForUpdates()
      return { success: true }
    } catch (err) {
      logger.error(`[updater:check] ${err}`)
      return { success: false }
    }
  })

  ipcMain.handle('updater:quitAndInstall', () => {
    if (!updatesSupported) return
    app.removeAllListeners('window-all-closed')
    BrowserWindow.getAllWindows().forEach(w => w.destroy())
    autoUpdater.quitAndInstall(true, true)
  })

  // Update FastAPI paths at runtime (without restarting)
  ipcMain.handle('api:updatePaths', async (_event, patch: { modelsDir?: string; workspaceDir?: string; extensionsDir?: string }) => {
    try {
      if (patch.modelsDir !== undefined && weightOperations.busy) {
        throw new Error('Cannot change model storage while model weights are busy')
      }
      await axios.post(`${API_BASE_URL}/settings/paths`, {
        models_dir:     patch.modelsDir,
        workspace_dir:  patch.workspaceDir,
        extensions_dir: patch.extensionsDir,
      })
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── Workflows ────────────────────────────────────────────────────────────

  function workflowsDir(): string {
    const dir = getSettings(app.getPath('userData')).workflowsDir
    if (!existsSync(dir)) require('fs').mkdirSync(dir, { recursive: true })
    return dir
  }

  ipcMain.handle('workflows:list', async () => {
    const dir = workflowsDir()
    const result = await listStoredWorkflows(dir)
    if (result.diagnostics.filenameIdMismatches.length > 0 || result.diagnostics.duplicateIds.length > 0 || result.diagnostics.corruptedFiles.length > 0) {
      logger.warn(`Workflow list diagnostics: ${JSON.stringify(result.diagnostics)}`)
    }
    return result.workflows
  })

  ipcMain.handle('workflows:save', async (_, workflow: { id: string; [key: string]: unknown }) => {
    return saveWorkflowWithBackup(workflowsDir(), workflow)
  })

  ipcMain.handle('workflows:delete', async (_, id: string) => {
    try {
      await rmAsync(join(workflowsDir(), `${id}.json`), { force: true })
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('workflows:import', async () => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win!, {
      title: 'Import Workflow',
      filters: [{ name: 'Workflow', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return { success: false }
    return importWorkflowAvoidingIdCollision(workflowsDir(), result.filePaths[0])
  })

  ipcMain.handle('workflows:export', async (_, workflow: { id: string; name?: string; [key: string]: unknown }) => {
    const win = getWindow()
    const result = await dialog.showSaveDialog(win!, {
      title: 'Export Workflow',
      defaultPath: `${workflow.name ?? workflow.id}.json`,
      filters: [{ name: 'Workflow', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return { success: false }
    try {
      await writeFile(result.filePath, JSON.stringify(workflow, null, 2), 'utf-8')
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  return {
    shutdown: async () => {
      try {
        try {
          await directEditBroker.shutdown()
          editorBroker.shutdown()
          readinessBroker.shutdown()
          await worldsCliControls.shutdown()
          await worldsCliTransport?.revoke()
        }
        finally { await worldRenderSubsystem.shutdown() }
      } finally {
        try {
          await agentActionsService.shutdown()
        } finally {
          await agentModelAccess.shutdown()
        }
      }
    },
  }
}

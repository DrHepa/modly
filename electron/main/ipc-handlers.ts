import { ipcMain, BrowserWindow, dialog, app, shell, type IpcMainInvokeEvent } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'path'
import { rm as rmAsync, readFile, writeFile, mkdir, readdir, rename, cp, symlink, lstat, realpath } from 'fs/promises'
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import * as os from 'os'
import { promisify } from 'util'
import axios from 'axios'
import { PythonBridge, API_BASE_URL } from './python-bridge'
import {
  listDownloadedModels,
  downloadModelFromHF,
  downloadModelSourcesFromHF,
  downloadModelAssetsFromHF,
  downloadModelAssetsFromHttps,
  ModelAssetDownloadError,
} from './model-downloader'
import {
  createOwnerScopedDeletePlan,
  createExtensionUninstallCleanupPlan,
  deleteOwnedModelPaths,
  isOwnedModelDownloaded,
  listDownloadedModelCapabilities,
  mapDownloadProgressToCapability,
  resolveModelOwnership,
  resolveShowInFolderPath,
  type ModelOwnershipDescriptor,
} from './model-ownership'
import { resolveInstalledModelDownloadPlan } from './model-download-plan'
import { parseLegacyModelDownloadPayload as parseLegacyModelDownloadPayloadContract } from './model-download-ipc-contract'
import {
  areModelSourcesDownloaded,
  areWeightGroupSourcesDownloaded,
  modelHasLocalData,
  normalizeModelSources,
  removePartialDownloadArtifacts,
  resolveModelRoot,
  resolveWeightGroupRoot,
} from './model-sources'
import { getSettings, setSettings } from './settings-store'
import { checkSetupNeeded, markSetupDone, runFullSetup, getVenvPythonExe, ensureSslPatch } from './python-setup'
import { logger } from './logger'
import { getProcessRunner, getPythonProcessRunner, getExtPythonExe, terminateProcessRunner, terminateAllProcessRunners } from './process-runner'
import { getBuiltinExtensionsDir } from './builtin-sync'
import {
  listAgentCapabilities,
  listVisibleExtensions,
  listVisibleExtensionsDetailed,
  resolveGovernedAgentProcessTarget,
  type ParsedManifest,
} from './automation-capabilities'
import { getAutomationCapabilities } from './automation-capabilities-service'
import { importWorkflowAvoidingIdCollision, listStoredWorkflows, saveWorkflowWithBackup } from './workflow-files.ts'
import { spawn, execFile } from 'child_process'
import { validateInstallManifest } from './extension-install-utils'
import { fetchTrustedRepos } from './trusted-repos'
import type { ProcessInput, WorldsSceneManifestWriteRequest, WorldsSceneManifestWriteResult } from '../../src/shared/types/electron.d'
import { runProcessExtensionWithDeps } from './run-process-handler'
import { installGitHubExtensionRepo, parseManifestForInstall } from './github-extension-install'
import { createRuntimeReadinessActionHandler, fetchRuntimeReadinessWithHealthGate } from './model-runtime-readiness'
import { assertSafeExtensionId, assertSafeOwnershipSegment, resolveExtensionPathWithinRoot } from './extension-path-guard'
import { registerArtifactRegistryIpcHandlers } from './artifact-registry-service'
import { updatesSupported } from './updater'
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

// ─── GPU detect (best-effort, no Python required) ─────────────────────────────

interface GpuInfo {
  sm: number
  cudaVersion: number
  accelerator: 'cuda' | 'mps' | 'cpu'
}

function detectGpuInfo(): Promise<GpuInfo> {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return Promise.resolve({ sm: 0, cudaVersion: 0, accelerator: 'mps' })
  }

  return new Promise((resolve) => {
    // Query compute cap + driver version in one call
    const proc = spawn('nvidia-smi', ['--query-gpu=compute_cap,driver_version', '--format=csv,noheader'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    proc.on('close', (code) => {
      if (code === 0) {
        const line   = out.trim().split('\n')[0].trim()        // e.g. "8.6, 551.61"
        const parts  = line.split(',').map(s => s.trim())
        const sm     = Math.round(parseFloat(parts[0] ?? '') * 10)  // → 86
        // Derive max supported CUDA version from driver version
        // Driver ≥ 520 → CUDA 11.8, ≥ 525 → 12.0, ≥ 530 → 12.1, ≥ 535 → 12.2,
        // ≥ 545 → 12.3, ≥ 550 → 12.4, ≥ 555 → 12.5, ≥ 560 → 12.6
        const driverMajor = parseInt((parts[1] ?? '').split('.')[0] ?? '0', 10)
        let cudaVersion = 118  // safe minimum
        if      (driverMajor >= 570) cudaVersion = 128  // Blackwell (RTX 50xx, sm_120)
        else if (driverMajor >= 560) cudaVersion = 126
        else if (driverMajor >= 555) cudaVersion = 125
        else if (driverMajor >= 550) cudaVersion = 124
        else if (driverMajor >= 545) cudaVersion = 123
        else if (driverMajor >= 535) cudaVersion = 122
        else if (driverMajor >= 530) cudaVersion = 121
        else if (driverMajor >= 525) cudaVersion = 120
        else if (driverMajor >= 520) cudaVersion = 118
        resolve({ sm: isNaN(sm) ? 86 : sm, cudaVersion, accelerator: 'cuda' })
      } else {
        resolve({ sm: 0, cudaVersion: 0, accelerator: 'cpu' })
      }
    })
    proc.on('error', () => resolve({ sm: 0, cudaVersion: 0, accelerator: 'cpu' }))
  })
}

// ─── Run an extension's setup.py directly (no FastAPI needed) ─────────────────

function runExtensionSetup(
  extDir:      string,
  gpuSm:       number,
  cudaVersion: number,
  onLog?:      (line: string) => void,
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

    const accelerator = process.platform === 'darwin' && process.arch === 'arm64' ? 'mps' : gpuSm > 0 ? 'cuda' : 'cpu'
    const args = JSON.stringify({
      python_exe: pythonExe,
      ext_dir: extDir,
      gpu_sm: gpuSm,
      cuda_version: cudaVersion,
      accelerator,
      platform: process.platform,
      arch: process.arch,
    })
    const launcher = `
import runpy
import subprocess
import sys

setup_py = sys.argv[1]
setup_args = sys.argv[2:]

_original_run = subprocess.run
_original_check_call = subprocess.check_call
_original_check_output = subprocess.check_output

def _is_cuda_torch_index(value):
    return isinstance(value, str) and value.startswith("https://download.pytorch.org/whl/cu")

def _mentions_torch(command):
    if not isinstance(command, (list, tuple)):
        return False
    return any(str(part).startswith(("torch==", "torchvision==", "torchaudio==")) for part in command)

def _rewrite_command(command):
    if sys.platform != "darwin" or not _mentions_torch(command):
        return command
    if not isinstance(command, (list, tuple)):
        return command

    rewritten = []
    changed = False
    i = 0
    while i < len(command):
        part = command[i]
        text = str(part)
        if text in ("--index-url", "-i", "--extra-index-url") and i + 1 < len(command) and _is_cuda_torch_index(str(command[i + 1])):
            changed = True
            i += 2
            continue
        if text.startswith("--index-url=") or text.startswith("--extra-index-url="):
            value = text.split("=", 1)[1]
            if _is_cuda_torch_index(value):
                changed = True
                i += 1
                continue
        rewritten.append(part)
        i += 1

    if changed:
        print("[Modly setup compat] Removed CUDA-only PyTorch index on macOS; pip will use macOS wheels.", file=sys.stderr)
        return rewritten
    return command

def _is_pip_command(command):
    if not isinstance(command, (list, tuple)):
        return False
    return any("pip" in str(part).lower() for part in command[:3])

def _strip_no_cache(command):
    # Extension setup scripts often hardcode --no-cache-dir, which forces pip to
    # re-download multi-GB wheels on every retry. Modly provides a shared cache
    # via PIP_CACHE_DIR, so drop the flag and let pip use it.
    if not _is_pip_command(command):
        return command
    if not any(str(part) == "--no-cache-dir" for part in command):
        return command
    print("[Modly setup compat] Removed --no-cache-dir so pip reuses the shared wheel cache.", file=sys.stderr)
    return [part for part in command if str(part) != "--no-cache-dir"]

def _transform_command(command):
    return _strip_no_cache(_rewrite_command(command))

def _patched_run(*args, **kwargs):
    args = list(args)
    if args:
        args[0] = _transform_command(args[0])
    return _original_run(*args, **kwargs)

def _patched_check_call(*args, **kwargs):
    args = list(args)
    if args:
        args[0] = _transform_command(args[0])
    return _original_check_call(*args, **kwargs)

def _patched_check_output(*args, **kwargs):
    args = list(args)
    if args:
        args[0] = _transform_command(args[0])
    return _original_check_output(*args, **kwargs)

subprocess.run = _patched_run
subprocess.check_call = _patched_check_call
subprocess.check_output = _patched_check_output

sys.argv = [setup_py] + setup_args
runpy.run_path(setup_py, run_name="__main__")
`
    const proc = spawn(pythonExe, ['-c', launcher, setupPy, args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env:   { ...process.env, PIP_CACHE_DIR: pipCacheDir },
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

function listBuiltinExtensionIds(): Set<string> {
  const builtinDir = getBuiltinExtensionsDir()
  if (!existsSync(builtinDir)) return new Set()

  try {
    return new Set(
      readdirSync(builtinDir)
        .filter((entry) => statSync(join(builtinDir, entry)).isDirectory()),
    )
  } catch {
    return new Set()
  }
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
  type TrackedDownloadProgress = { percent: number; file?: string; fileIndex?: number; totalFiles?: number; repoIndex?: number; totalRepos?: number; status?: string; paused?: boolean; cancelled?: boolean; bytesDownloaded?: number; totalBytes?: number; stalledSeconds?: number }
  type LocalDownloadControl = { pause: boolean; cancel: boolean }
  const activeDownloads = new Map<string, TrackedDownloadProgress>()
  const activeDownloadSettlements = new Map<string, Promise<void>>()
  const localDownloadControls = new Map<string, LocalDownloadControl>()
  // A multi-group install is intentionally serialized. Track only the target
  // whose request is currently in flight so pause/cancel cannot create a
  // backend control for a later group and poison that group's future download.
  const activeWeightTargets = new Map<string, string>()
  const localDownloadControl = (modelId: string): LocalDownloadControl => {
    const existing = localDownloadControls.get(modelId)
    if (existing) return existing
    const created = { pause: false, cancel: false }
    localDownloadControls.set(modelId, created)
    return created
  }
  const aliasLocalDownloadControl = (alias: string, control: LocalDownloadControl): void => {
    localDownloadControls.set(alias, control)
  }
  const findLocalDownloadControl = (keys: readonly string[]): LocalDownloadControl | undefined => {
    for (const key of keys) {
      const control = localDownloadControls.get(key)
      if (control) return control
    }
    return undefined
  }
  const clearLocalDownloadControlAliases = (keys: readonly string[], control: LocalDownloadControl): void => {
    for (const key of keys) {
      if (localDownloadControls.get(key) === control) localDownloadControls.delete(key)
    }
  }
  const beginPendingDownloadSettlement = (modelId: string): (() => void) => {
    let release!: () => void
    const settled = new Promise<void>((resolve) => { release = resolve })
    activeDownloadSettlements.set(modelId, settled)
    return () => {
      if (activeDownloadSettlements.get(modelId) === settled) {
        activeDownloadSettlements.delete(modelId)
      }
      release()
    }
  }
  const runTrackedModelDownload = async (modelId: string, task: () => Promise<void>): Promise<void> => {
    const release = beginPendingDownloadSettlement(modelId)
    try {
      await task()
    } finally {
      release()
    }
  }
  const activeDownloadKeysForOwnership = (ownership: ModelOwnershipDescriptor, siblingCapabilityIds: string[] = []): string[] => (
    [ownership.capabilityId, ownership.weightOwnerId, ...ownership.legacyPaths, ...siblingCapabilityIds]
      .filter((value, index, values) => values.indexOf(value) === index)
      .filter((value) => activeDownloads.has(value) || activeDownloadSettlements.has(value))
  )
  const waitForActiveDownloadSettlement = async (modelId: string): Promise<void> => {
    const settled = activeDownloadSettlements.get(modelId)
    if (settled) await settled
  }
  const downloadInProgressError = (modelId: string, ownerId: string, activeKeys: string[]) => modelAssetDownloadResult(new ModelAssetDownloadError({
    code: 'download_in_progress',
    stage: 'request',
    message: `Model asset download is already in progress for owner ${ownerId}; requested ${modelId}, active ${activeKeys.join(', ')}`,
    retryable: true,
  }))
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

    const userData = app.getPath('userData')
    const control = localDownloadControl(modelId)
    activeDownloads.set(modelId, { percent: 0, status: 'preparing' })
    let ownership: ModelOwnershipDescriptor | undefined
    let siblingCapabilityIds: string[]
    try {
      await runTrackedModelDownload(modelId, async () => {
        const context = await resolveOwnershipContext(userData, modelId)
        ownership = context.ownership
        siblingCapabilityIds = context.siblingCapabilityIds
        const owner = ownership
        aliasLocalDownloadControl(owner.weightOwnerId, control)
        activeDownloads.delete(modelId)

        const activeOwnerDownloads = activeDownloadKeysForOwnership(owner, siblingCapabilityIds)
          .filter((activeId) => activeId !== modelId)
        if (activeOwnerDownloads.length > 0) {
          throw new ModelAssetDownloadError({
            code: 'download_in_progress',
            stage: 'request',
            message: `Model asset download is already in progress for owner ${owner.weightOwnerId}; requested ${modelId}, active ${activeOwnerDownloads.join(', ')}`,
            retryable: true,
          })
        }
        if (control.cancel) {
          activeDownloads.set(owner.weightOwnerId, { percent: 0, status: 'cancelled', cancelled: true })
          event.sender.send('model:downloadProgress', mapDownloadProgressToCapability(modelId, { percent: 0, status: 'cancelled', cancelled: true }))
          return
        }
        if (control.pause) {
          activeDownloads.set(owner.weightOwnerId, { percent: 0, status: 'paused', paused: true })
          event.sender.send('model:downloadProgress', mapDownloadProgressToCapability(modelId, { percent: 0, status: 'paused', paused: true }))
          return
        }

        activeDownloads.set(owner.weightOwnerId, { percent: 0, status: 'preparing' })
        await runTrackedModelDownload(owner.weightOwnerId, () => downloader(modelId, owner.weightOwnerId, (progress) => {
          activeDownloads.set(owner.weightOwnerId, progress)
          event.sender.send(
            'model:downloadProgress',
            mapDownloadProgressToCapability(modelId, progress),
          )
        }))
      })
      return { success: true }
    } catch (error) {
      return modelAssetDownloadResult(error)
    } finally {
      activeDownloads.delete(modelId)
      if (typeof ownership !== 'undefined') activeDownloads.delete(ownership.weightOwnerId)
      clearLocalDownloadControlAliases(
        typeof ownership !== 'undefined' ? [modelId, ownership.weightOwnerId, ...ownership.legacyPaths] : [modelId],
        control,
      )
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

  // Window controls (frameless window)
  ipcMain.on('window:minimize', () => getWindow()?.minimize())
  ipcMain.on('window:maximize', () => {
    const win = getWindow()
    if (!win) return
    if (win.isMaximized()) {
      win.restore()
      return
    }
    win.maximize()
  })
  ipcMain.on('window:close', () => getWindow()?.close())
  ipcMain.handle('window:isMaximized', () => getWindow()?.isMaximized() ?? false)

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

  ipcMain.handle('fs:selectSceneFile', async () => {
    const win = getWindow()
    if (!win) return null

    const result = await dialog.showOpenDialog(win, {
      title: 'Select a scene manifest',
      filters: [{ name: 'Scene manifest', extensions: ['json'] }],
      properties: ['openFile']
    })

    return result.canceled ? null : result.filePaths[0]
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

  ipcMain.handle('model:delete', async (_, modelId: string): Promise<{ success: boolean; error?: string }> => {
    const userData = app.getPath('userData')
    const modelsDir = getSettings(userData).modelsDir
    const { ownership, siblingCapabilityIds } = await resolveOwnershipContext(userData, modelId)
    const deletePlan = createOwnerScopedDeletePlan(modelsDir, ownership, siblingCapabilityIds)
    const activeOwnerDownloads = activeDownloadKeysForOwnership(ownership, siblingCapabilityIds)
    if (activeOwnerDownloads.length > 0) {
      return { success: false, error: `Cannot delete model weights while download is active for: ${activeOwnerDownloads.join(', ')}` }
    }

    if (deletePlan.mode === 'blocked') {
      return { success: true, warning: deletePlan.warning, skipped: true } as { success: boolean; error?: string }
    }
    try {
      await axios.post(`${API_BASE_URL}/model/unload/${encodeURIComponent(modelId)}`, {}, { timeout: 10_000 })
      // Give the OS a moment to release file locks (Windows holds handles briefly after close)
      await new Promise(resolve => setTimeout(resolve, 1_500))
    } catch {
      // Unload failed (model may not be loaded) — still attempt deletion
    }
    try {
      await deleteOwnedModelPaths(modelsDir, deletePlan.targets)
      return { success: true, warning: deletePlan.warning } as { success: boolean; error?: string }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('model:showInFolder', async (_, modelId: string) => {
    const userData = app.getPath('userData')
    const modelsDir = getSettings(userData).modelsDir
    const { ownership } = await resolveOwnershipContext(userData, modelId)
    const activePath = resolveShowInFolderPath(modelsDir, ownership)
    if (activePath && existsSync(activePath)) {
      shell.openPath(activePath)
    }
  })

  // Read local file → base64 (bypasses file:// restrictions in the renderer)
  ipcMain.handle('fs:readFileBase64', async (_, filePath: string) => {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      throw new Error('fs:readFileBase64 requires a non-empty file path')
    }
    const buffer = await readFile(filePath)
    return buffer.toString('base64')
  })

  ipcMain.handle('fs:readScreenshotDataUrl', async (_, filename: string) => {
    const filePath = app.isPackaged
      ? join(process.resourcesPath, 'screenshots', filename)
      : join(app.getAppPath(), 'src/assets', filename)
    const buffer = await readFile(filePath)
    return `data:image/png;base64,${buffer.toString('base64')}`
  })

  // Model management
  ipcMain.handle('model:listDownloaded', async () => {
    const userData = app.getPath('userData')
    const modelsDir = getSettings(userData).modelsDir
    const extensions = await listModelExtensions(userData)
    const downloadedById = new Map(
      listDownloadedModelCapabilities(modelsDir, extensions).map((model) => [model.id, model]),
    )

    for (const extension of extensions) {
      if (extension.type !== 'model') continue
      for (const node of extension.nodes) {
        const capabilityId = node.capabilityId ?? `${extension.id}/${node.id}`
        const collected = downloadedById.get(capabilityId)
        // Private-only readiness is provisional for a source-managed capability.
        if (node.hasModelSources) downloadedById.delete(capabilityId)
        try {
          const plan = await resolveInstalledModelDownloadPlan({
            modelId: capabilityId,
            userExtensionsDir: getSettings(userData).extensionsDir,
            builtinExtensionsDir: getBuiltinExtensionsDir(),
          })
          if (plan.kind !== 'multi-source') continue
          downloadedById.delete(capabilityId)
          const { ownership } = await resolveOwnershipContext(userData, capabilityId)
          const privateReady = plan.sources.length === 0
            || areModelSourcesDownloaded(modelsDir, ownership.weightOwnerId, plan.sources)
          const sharedReady = plan.sharedGroups.every((group) => (
            areWeightGroupSourcesDownloaded(modelsDir, plan.extensionId, group)
          ))
          if (!privateReady || !sharedReady) continue
          downloadedById.set(capabilityId, collected ?? { id: capabilityId, name: node.name, size_gb: 0 })
        } catch {
          // Source-managed entries fail closed; legacy collector rows survive.
        }
      }
    }

    return downloadedById.size > 0 ? [...downloadedById.values()] : listDownloadedModels(modelsDir)
  })

  ipcMain.handle('model:isDownloaded', async (_, modelId: string): Promise<boolean> => {
    const userData = app.getPath('userData')
    const modelsDir = getSettings(userData).modelsDir
    try {
      const plan = await resolveInstalledModelDownloadPlan({
        modelId,
        userExtensionsDir: getSettings(userData).extensionsDir,
        builtinExtensionsDir: getBuiltinExtensionsDir(),
      })
      if (plan.kind === 'multi-source') {
        const { ownership } = await resolveOwnershipContext(userData, modelId)
        const privateReady = plan.sources.length === 0
          || areModelSourcesDownloaded(modelsDir, ownership.weightOwnerId, plan.sources)
        return privateReady && plan.sharedGroups.every((group) => (
          areWeightGroupSourcesDownloaded(modelsDir, plan.extensionId, group)
        ))
      }
    } catch {
      // Fall through to existing ownership/read-through semantics.
    }
    const { ownership } = await resolveOwnershipContext(userData, modelId)
    const ownedDownloaded = isOwnedModelDownloaded(modelsDir, ownership)
    return ownedDownloaded
  })

  ipcMain.handle('model:hasLocalData', async (_, modelId: string): Promise<boolean> => {
    try {
      const userData = app.getPath('userData')
      const { ownership } = await resolveOwnershipContext(userData, modelId)
      return modelHasLocalData(getSettings(userData).modelsDir, ownership.weightOwnerId)
    } catch {
      return false
    }
  })

  ipcMain.handle('model:activeDownloads', () =>
    [...activeDownloads.entries()].map(([modelId, progress]) => ({ modelId, ...progress }))
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

  ipcMain.handle('model:downloadSources', async (event, payload: unknown) => {
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

    // Reject before replacing this capability's pending reservation/control.
    if (activeDownloads.has(modelId) || activeDownloadSettlements.has(modelId)) {
      return downloadInProgressError(modelId, activeWeightTargets.get(modelId) ?? modelId, [modelId])
    }
    const userData = app.getPath('userData')
    const control = localDownloadControl(modelId)
    activeDownloads.set(modelId, { percent: 0, status: 'preparing' })
    const releasePendingDownload = beginPendingDownloadSettlement(modelId)
    try {
      const { ownership, siblingCapabilityIds } = await resolveOwnershipContext(userData, modelId)
      activeDownloads.delete(modelId)
      if (control.cancel) return { success: true }
      if (control.pause) return { success: true }
      const activeOwnerDownloads = activeDownloadKeysForOwnership(ownership, siblingCapabilityIds)
        .filter((activeId) => activeId !== modelId)
      if (activeOwnerDownloads.length > 0) {
        return downloadInProgressError(modelId, ownership.weightOwnerId, activeOwnerDownloads)
      }

      const plan = await resolveInstalledModelDownloadPlan({
        modelId,
        userExtensionsDir: getSettings(userData).extensionsDir,
        builtinExtensionsDir: getBuiltinExtensionsDir(),
      })
      if (plan.kind !== 'multi-source') {
        return modelAssetDownloadResult(new ModelAssetDownloadError({
          code: 'assets_not_declared',
          stage: 'validate',
          message: `Model node ${modelId} does not declare model_sources`,
          retryable: false,
        }))
      }

      const downloadPlans = [
        ...plan.sharedGroups.map((group) => ({ targetId: group.targetId, sources: group.sources })),
        ...(plan.sources.length > 0 ? [{ targetId: ownership.weightOwnerId, sources: plan.sources }] : []),
      ]
      const activePlanDownloads = downloadPlans
        .map((item) => item.targetId)
        .filter((targetId) => targetId !== modelId) // The current request owns this pending reservation.
        .filter((targetId) => activeDownloads.has(targetId) || activeDownloadSettlements.has(targetId))
      if (activePlanDownloads.length > 0) {
        return downloadInProgressError(modelId, ownership.weightOwnerId, activePlanDownloads)
      }
      for (const [index, downloadPlan] of downloadPlans.entries()) {
        if (control.cancel || control.pause) return { success: true }
        if (downloadPlan.targetId.includes('/_shared/')) {
          const group = plan.sharedGroups.find((candidate) => candidate.targetId === downloadPlan.targetId)!
          if (areWeightGroupSourcesDownloaded(getSettings(userData).modelsDir, plan.extensionId, group)) continue
        } else if (areModelSourcesDownloaded(getSettings(userData).modelsDir, ownership.weightOwnerId, plan.sources)) {
          continue
        }
        // Earlier transfers await I/O, so acquire each target again at its start.
        // No await may separate this check from the reservation below.
        if (downloadPlan.targetId !== modelId
          && (activeDownloads.has(downloadPlan.targetId) || activeDownloadSettlements.has(downloadPlan.targetId))) {
          return downloadInProgressError(modelId, ownership.weightOwnerId, [downloadPlan.targetId])
        }
        activeWeightTargets.set(modelId, downloadPlan.targetId)
        activeDownloads.set(downloadPlan.targetId, { percent: 0, status: 'preparing' })
        aliasLocalDownloadControl(downloadPlan.targetId, control)
        await runTrackedModelDownload(downloadPlan.targetId, () => downloadModelSourcesFromHF(modelId, downloadPlan.targetId, downloadPlan.sources, (progress) => {
          const overall = {
            ...progress,
            percent: Math.round(((index + progress.percent / 100) / Math.max(1, downloadPlans.length)) * 100),
          }
          activeDownloads.set(downloadPlan.targetId, progress)
          event.sender.send('model:downloadProgress', mapDownloadProgressToCapability(modelId, overall))
        }))
        activeDownloads.delete(downloadPlan.targetId)
        clearLocalDownloadControlAliases([downloadPlan.targetId], control)
        activeWeightTargets.delete(modelId)
      }
      return { success: true }
    } catch (error) {
      return modelAssetDownloadResult(error)
    } finally {
      const activeWeightTarget = activeWeightTargets.get(modelId)
      if (activeWeightTarget && localDownloadControls.get(activeWeightTarget) === control) {
        activeDownloads.delete(activeWeightTarget)
      }
      clearLocalDownloadControlAliases(activeWeightTarget ? [activeWeightTarget] : [], control)
      activeWeightTargets.delete(modelId)
      if (localDownloadControls.get(modelId) === control) activeDownloads.delete(modelId)
      clearLocalDownloadControlAliases([modelId], control)
      releasePendingDownload()
    }
  })

  ipcMain.handle('model:download', async (event, payload: unknown) => {
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
    const userData = app.getPath('userData')
    const control = localDownloadControl(modelId)
    activeDownloads.set(modelId, { percent: 0, status: 'preparing' })
    const releasePendingDownload = beginPendingDownloadSettlement(modelId)
    let activeOwnerId: string | null = null
    try {
      const { ownership, siblingCapabilityIds } = await resolveOwnershipContext(userData, modelId)
      activeOwnerId = ownership.weightOwnerId
      aliasLocalDownloadControl(activeOwnerId, control)
      activeDownloads.delete(modelId)
      if (control.cancel) return { success: true }
      if (control.pause) return { success: true }
      const activeOwnerDownloads = activeDownloadKeysForOwnership(ownership, siblingCapabilityIds)
        .filter((activeId) => activeId !== modelId)
      if (activeOwnerDownloads.length > 0) {
        return downloadInProgressError(modelId, ownership.weightOwnerId, activeOwnerDownloads)
      }

      const plan = await resolveInstalledModelDownloadPlan({
        modelId,
        userExtensionsDir: getSettings(userData).extensionsDir,
        builtinExtensionsDir: getBuiltinExtensionsDir(),
      })
      if (plan.kind !== 'legacy') {
        return modelAssetDownloadResult(new ModelAssetDownloadError({
          code: 'legacy_download_not_applicable',
          stage: 'validate',
          message: `Model node ${modelId} does not declare a legacy hf_repo download`,
          retryable: false,
        }))
      }
      const request = parseLegacyModelDownloadPayloadContract(payload)
      if ((request.repoId !== undefined && request.repoId !== plan.repoId)
        || (request.skipPrefixes !== undefined && JSON.stringify(request.skipPrefixes) !== JSON.stringify(plan.skipPrefixes ?? []))
        || (request.includePrefixes !== undefined && JSON.stringify(request.includePrefixes) !== JSON.stringify(plan.includePrefixes ?? []))) {
        throw new ModelAssetDownloadError({ code: 'source_plan_invalid', stage: 'validate', message: `Model node ${modelId} download payload does not match its installed manifest`, retryable: false })
      }
      activeDownloads.set(ownership.weightOwnerId, { percent: 0 })
      await runTrackedModelDownload(ownership.weightOwnerId, () => downloadModelFromHF(plan.repoId, modelId, (progress) => {
        activeDownloads.set(ownership.weightOwnerId, progress)
        event.sender.send('model:downloadProgress', mapDownloadProgressToCapability(modelId, progress))
      }, plan.skipPrefixes, plan.includePrefixes))
      return { success: true }
    } catch (err) {
      return modelAssetDownloadResult(err)
    } finally {
      activeDownloads.delete(modelId)
      if (activeOwnerId) activeDownloads.delete(activeOwnerId)
      clearLocalDownloadControlAliases(
        activeOwnerId ? [modelId, activeOwnerId] : [modelId],
        control,
      )
      releasePendingDownload()
    }
  })

  ipcMain.handle('model:pauseDownload', async (_, modelId: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const userData = app.getPath('userData')
      const { ownership } = await resolveOwnershipContext(userData, modelId)
      const control = findLocalDownloadControl([modelId, ownership.weightOwnerId, ...ownership.legacyPaths])
      if (control) control.pause = true
      const targets = [activeWeightTargets.get(modelId) ?? ownership.weightOwnerId]
      await Promise.all(targets.map((targetId) => axios.post(`${API_BASE_URL}/model/hf-download/pause`, null, {
        params: { model_id: targetId }, timeout: 5000,
      })))
      await waitForActiveDownloadSettlement(modelId)
      await waitForActiveDownloadSettlement(ownership.weightOwnerId)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('model:cancelDownload', async (_, modelId: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const userData = app.getPath('userData')
      const { ownership } = await resolveOwnershipContext(userData, modelId)
      const keys = [modelId, ownership.weightOwnerId, ...ownership.legacyPaths]
      const hadOwnerSettlement = keys.some((key) => activeDownloadSettlements.has(key))
      const control = findLocalDownloadControl(keys) ?? localDownloadControl(modelId)
      control.cancel = true
      const targets = [activeWeightTargets.get(modelId) ?? ownership.weightOwnerId]
      await Promise.all(targets.map((targetId) => axios.post(`${API_BASE_URL}/model/hf-download/cancel`, null, {
        params: { model_id: targetId }, timeout: 5000,
      })))
      await waitForActiveDownloadSettlement(modelId)
      await waitForActiveDownloadSettlement(ownership.weightOwnerId)
      if (hadOwnerSettlement) {
        const modelDir = resolveModelRoot(getSettings(userData).modelsDir, ownership.weightOwnerId)
        await removePartialDownloadArtifacts(modelDir)
      }
      for (const targetId of targets) {
        const parts = targetId.split('/')
        if (parts.length === 3 && parts[1] === '_shared') {
          await removePartialDownloadArtifacts(resolveWeightGroupRoot(getSettings(userData).modelsDir, parts[0], parts[2]))
        }
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

  // Settings — seed HF token into main-process env at startup
  {
    const initialToken = getSettings(app.getPath('userData')).hfToken ?? ''
    if (initialToken) {
      process.env['HUGGING_FACE_HUB_TOKEN'] = initialToken
      process.env['HF_TOKEN']               = initialToken
    }
  }

  ipcMain.handle('settings:get', () => {
    return getSettings(app.getPath('userData'))
  })

  ipcMain.handle('settings:set', async (_event, patch: { modelsDir?: string; workspaceDir?: string; extensionsDir?: string; hfToken?: string }) => {
    const updated = setSettings(app.getPath('userData'), patch)
    // Keep main-process env in sync so child processes spawned after token change inherit it
    if (patch.hfToken !== undefined) {
      process.env['HUGGING_FACE_HUB_TOKEN'] = patch.hfToken
      process.env['HF_TOKEN']               = patch.hfToken
      // Also push the token into the live FastAPI process env so extension
      // subprocesses spawned by ExtensionProcess._build_env() pick it up
      // without requiring a full app restart.
      try {
        await axios.post(`${API_BASE_URL}/settings/hf-token`, { token: patch.hfToken }, { timeout: 3000 })
      } catch { /* FastAPI may not be running yet — ignore */ }
    }
    return updated
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

  // Extensions — reads user extensions directory + built-in extensions directory
  ipcMain.handle('extensions:list', async () => {
    const userData      = app.getPath('userData')
    const extensionsDir = getSettings(userData).extensionsDir
    const builtinDir    = getBuiltinExtensionsDir()

    const trustedRepos = await fetchTrustedRepos()

    return listVisibleExtensions({
      builtinDir,
      userExtensionsDir: extensionsDir,
      trustedRepos,
    })
  })

  ipcMain.handle('automation:capabilities', () => getAutomationCapabilities())

  ipcMain.handle('agentCapabilities:list', sharedAgentCapabilityResolver.forRendererIpc)

  // Install an extension from a GitHub repo URL
  ipcMain.handle('extensions:installFromGitHub', async (event, githubUrl: string) => {
    const win = getWindow()
    const trustedRepos = await fetchTrustedRepos()
    return installGitHubExtensionRepo({
      githubUrl,
      extensionsDir: getSettings(app.getPath('userData')).extensionsDir,
      builtinExtensionIds: listBuiltinExtensionIds(),
      trustedRepos,
      emitProgress: (data) => {
        win?.webContents.send('extensions:installProgress', data)
      },
      operations: {
        async runExtensionSetup({ destinationDir, onLog }) {
          const { sm: gpuSm, cudaVersion } = await detectGpuInfo()
          await runExtensionSetup(destinationDir, gpuSm, cudaVersion, (line) => {
            logger.info(`[ext-setup] ${line}`)
            onLog?.(line)
          })
        },
        async reloadExtensions() {
          await axios.post(`${API_BASE_URL}/extensions/reload`, {}, { timeout: 10_000 })
        },
      },
    })
  })

  // Uninstall an extension — built-ins cannot be uninstalled
  ipcMain.handle('extensions:uninstall', async (_, extensionId: string) => {
    const userData      = app.getPath('userData')
    const safeExtensionId = assertSafeExtensionId(extensionId)
    const builtinPath   = resolveExtensionPathWithinRoot(getBuiltinExtensionsDir(), safeExtensionId)
    if (existsSync(builtinPath)) {
      return { success: false, error: `"${safeExtensionId}" is a built-in extension and cannot be uninstalled.` }
    }

    const extensionsDir = getSettings(userData).extensionsDir
    const extPath       = resolveExtensionPathWithinRoot(extensionsDir, safeExtensionId)
    try {
      const { extensions } = await resolveOwnershipContext(userData, safeExtensionId)
      const cleanupPlans = createExtensionUninstallCleanupPlan(getSettings(userData).modelsDir, extensions, safeExtensionId)
      const activeExtensionDownloads = extensions
        .filter((extension) => extension.type === 'model' && extension.id === safeExtensionId)
        .flatMap((extension) => extension.nodes.map((node) => {
          const capabilityId = node.capabilityId ?? `${extension.id}/${node.id}`
          const ownership = resolveModelOwnership(extensions, capabilityId) ?? createFallbackOwnership(capabilityId)
          return activeDownloadKeysForOwnership(ownership)
        }))
      if (activeExtensionDownloads.length > 0) {
        return { success: false, error: `Cannot uninstall extension while model download is active for: ${Array.from(new Set(activeExtensionDownloads)).join(', ')}` }
      }

      // Terminate process runner if it's a process extension
      terminateProcessRunner(safeExtensionId)

      for (const extension of extensions) {
        if (extension.type !== 'model' || extension.id !== safeExtensionId) continue
        for (const node of extension.nodes) {
          const capabilityId = node.capabilityId ?? `${extension.id}/${node.id}`
          try {
            await axios.post(`${API_BASE_URL}/model/unload/${encodeURIComponent(capabilityId)}`, {}, { timeout: 5000 })
          } catch {
            // best effort
          }
        }
      }

      for (const cleanupPlan of cleanupPlans) {
        await deleteOwnedModelPaths(getSettings(userData).modelsDir, cleanupPlan.targets)
      }
      await rmAsync(extPath, { recursive: true, force: true })
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
      const extDir = resolveExtensionPathWithinRoot(getSettings(app.getPath('userData')).extensionsDir, safeExtensionId)
      if (!existsSync(join(extDir, 'setup.py'))) {
        return { success: false, error: 'setup.py is missing from the extension folder — the install looks incomplete. Uninstall the extension and install it again.' }
      }
      const { sm: gpuSm, cudaVersion } = await detectGpuInfo()
      await runExtensionSetup(extDir, gpuSm, cudaVersion, (line) => logger.info(`[ext-repair] ${line}`))
      try {
        await axios.post(`${API_BASE_URL}/extensions/reload`, {}, { timeout: 10_000 })
      } catch { /* ignore if Python is not running yet */ }
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

      const { id: rawManifestId } = validateInstallManifest(
        manifest,
        {
          hasEntryFile:     (candidate) => existsSync(join(localPath, candidate)),
          hasGeneratorFile: ()          => existsSync(join(localPath, 'generator.py')),
        },
        'local folder',
      )
      const extensionId = assertSafeExtensionId(rawManifestId)
      const annotatedManifest = { ...manifest, source: `local://${localPath}` }
      const ext = parseManifestForInstall(annotatedManifest, extensionId, new Set())

      // 3. Create symlink / junction in extensionsDir
      const userData      = app.getPath('userData')
      const extensionsDir = getSettings(userData).extensionsDir
      await mkdir(extensionsDir, { recursive: true })

      const linkPath = resolveExtensionPathWithinRoot(extensionsDir, extensionId)

      // Remove any existing symlink/dir at that location
      if (existsSync(linkPath)) {
        // Check if it's already linked to the same path
        try {
          const stat = await lstat(linkPath)
          if (stat.isSymbolicLink() || (process.platform === 'win32' && stat.isDirectory())) {
            await rmAsync(linkPath, { recursive: true, force: true })
          } else {
            throw new Error(`A non-symlink folder named "${extensionId}" already exists in extensionsDir. Remove it first.`)
          }
        } catch (e: any) {
          if (e.message?.includes('already exists')) throw e
          await rmAsync(linkPath, { recursive: true, force: true })
        }
      }

      emit({ step: 'setting_up', message: 'Linking local folder…' })

      if (process.platform === 'win32') {
        // Windows: junction (no elevation needed, works for directories)
        await symlink(localPath, linkPath, 'junction')
      } else {
        // macOS / Linux: standard symlink
        await symlink(localPath, linkPath)
      }

      // Write sentinel so extensions:list can detect this as a local extension
      // The sentinel lives in the linked folder (= the original local folder), so
      // it persists even if Modly is restarted. The content is the absolute path.
      await writeFile(join(linkPath, '.modly-local'), localPath, 'utf-8')

      // 4. Hot-reload Python registry so it picks up the new extension
      try {
        await axios.post(`${API_BASE_URL}/extensions/reload`, {}, { timeout: 10_000 })
      } catch { /* Python might not be running yet */ }

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

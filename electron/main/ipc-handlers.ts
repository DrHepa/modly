import { ipcMain, BrowserWindow, dialog, app, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'path'
import { rm as rmAsync, readFile, writeFile, mkdir, readdir, rename, cp, symlink, lstat } from 'fs/promises'
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import axios from 'axios'
import { PythonBridge, API_BASE_URL } from './python-bridge'
import {
  isModelDownloaded,
  listDownloadedModels,
  downloadModelFromHF,
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
import { getSettings, setSettings } from './settings-store'
import { checkSetupNeeded, markSetupDone, runFullSetup, getVenvPythonExe, ensureSslPatch } from './python-setup'
import { logger } from './logger'
import { getProcessRunner, getPythonProcessRunner, getExtPythonExe, terminateProcessRunner, terminateAllProcessRunners } from './process-runner'
import { getBuiltinExtensionsDir } from './builtin-sync'
import { listVisibleExtensions } from './automation-capabilities'
import { getAutomationCapabilities } from './automation-capabilities-service'
import { spawn } from 'child_process'
import { fetchTrustedRepos } from './trusted-repos'
import type { ProcessInput } from '../../src/shared/types/electron.d'
import { runProcessExtensionWithDeps } from './run-process-handler'
import { installGitHubExtensionRepo } from './github-extension-install'
import { fetchRuntimeReadinessWithHealthGate } from './model-runtime-readiness'

type WindowGetter = () => BrowserWindow | null
const pExecFile = promisify(execFile)

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

export function setupIpcHandlers(pythonBridge: PythonBridge, getWindow: WindowGetter): void {
  // Reconcile leftovers of interrupted installs. No install can be in flight
  // this early in the app's life, so anything matching is stale:
  //  - staging dirs → discard (never the only copy of anything)
  //  - extension dir still carrying the incomplete marker + a backup exists
  //    → the install crashed mid-setup: put the previous version back
  //  - backup dirs → restore if the extension folder is gone, else discard
  void (async () => {
    try {
      const extensionsDir = getSettings(app.getPath('userData')).extensionsDir
      const entries = await readdir(extensionsDir, { withFileTypes: true })
      const names   = entries.map((e) => e.name)

      await Promise.allSettled(
        names
          .filter((n) => n.startsWith(EXT_STAGING_PREFIX))
          .map((n) => rmWithRetry(join(extensionsDir, n), 'ext-cleanup')),
      )

      // Newest backup first, so the most recent good version wins a restore
      const backups = names.filter((n) => n.startsWith(EXT_BACKUP_PREFIX)).sort().reverse()
      for (const name of backups) {
        const backupPath = join(extensionsDir, name)
        const parsed = parseExtensionBackupName(name)
        if (!parsed) { await rmWithRetry(backupPath, 'ext-cleanup'); continue }

        const destDir        = join(extensionsDir, parsed.extensionId)
        const destIncomplete = existsSync(join(destDir, EXT_INCOMPLETE_MARKER))
        if (existsSync(destDir) && !destIncomplete) {
          // Install completed; only the backup's own cleanup had failed
          await rmWithRetry(backupPath, 'ext-cleanup')
          continue
        }
        // Crash mid-swap or mid-setup: this backup is the last good copy
        if (destIncomplete) {
          const removed = await rmWithRetry(destDir, 'ext-restore')
          if (!removed.ok) continue   // keep the backup; retried next launch
        }
        const restored = await renameWithRetry(backupPath, destDir, 'ext-restore')
        if (restored.ok) logger.info(`[ext-restore] restored "${parsed.extensionId}" from ${name}`)
      }
    } catch { /* best-effort; extensionsDir may not exist yet */ }
  })()

  const activeDownloads = new Map<string, { percent: number; file?: string; fileIndex?: number; totalFiles?: number }>()
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

  ipcMain.handle('model:delete', async (_, modelId: string): Promise<{ success: boolean; error?: string }> => {
    const userData = app.getPath('userData')
    const modelsDir = getSettings(userData).modelsDir
    const { ownership, siblingCapabilityIds } = await resolveOwnershipContext(userData, modelId)
    const deletePlan = createOwnerScopedDeletePlan(modelsDir, ownership, siblingCapabilityIds)

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
      await deleteOwnedModelPaths(deletePlan.targets)
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
    const downloaded = listDownloadedModelCapabilities(modelsDir, extensions)
    return downloaded.length > 0 ? downloaded : listDownloadedModels(modelsDir)
  })

  ipcMain.handle('model:isDownloaded', async (_, modelId: string): Promise<boolean> => {
    const userData = app.getPath('userData')
    const modelsDir = getSettings(userData).modelsDir
    const { ownership } = await resolveOwnershipContext(userData, modelId)
    return isOwnedModelDownloaded(modelsDir, ownership) || isModelDownloaded(modelsDir, modelId)
  })

  ipcMain.handle('model:activeDownloads', () =>
    [...activeDownloads.entries()].map(([modelId, progress]) => ({ modelId, ...progress }))
  )

  ipcMain.handle('model:download', async (event, { repoId, modelId, skipPrefixes }: { repoId: string; modelId: string; skipPrefixes?: string[] }) => {
    const userData = app.getPath('userData')
    const { ownership } = await resolveOwnershipContext(userData, modelId)
    try {
      activeDownloads.set(modelId, { percent: 0 })
      await downloadModelFromHF(repoId, ownership.weightOwnerId, (progress) => {
        activeDownloads.set(modelId, progress)
        event.sender.send('model:downloadProgress', mapDownloadProgressToCapability(modelId, progress))
      }, skipPrefixes)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    } finally {
      activeDownloads.delete(modelId)
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
    return result.canceled ? null : result.filePaths[0]
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
      const entries = await readdir(dirPath, { withFileTypes: true })
      return entries.filter(e => e.isDirectory()).map(e => e.name)
    } catch {
      return []
    }
  })

  // List files (not directories) in a folder, optionally filtered by extension.
  // `extensions` are lowercase without the dot (e.g. ['txt', 'png']).
  ipcMain.handle('fs:listFiles', async (_, dirPath: string, extensions?: string[]) => {
    try {
      const wanted = extensions?.map(e => e.toLowerCase().replace(/^\./, ''))
      const entries = await readdir(dirPath, { withFileTypes: true })
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

  ipcMain.handle('fs:moveDirectory', async (_, { src, dest }: { src: string; dest: string }) => {
    try {
      await mkdir(dest, { recursive: true })
      await cp(src, dest, { recursive: true })
      await rmAsync(src, { recursive: true, force: true })
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('fs:deleteDirectory', async (_, dirPath: string) => {
    const userData = app.getPath('userData')
    const settings = getSettings(userData)
    const allowedRoots = [
      settings.modelsDir,
      settings.workspaceDir,
      settings.extensionsDir,
      join(userData, 'gen-cache'),
    ]
    const resolved = join(dirPath)
    const isAllowed = allowedRoots.some((root) => resolved.startsWith(root))
    if (!isAllowed) {
      return { success: false, error: 'Path is outside allowed directories' }
    }
    try {
      await rmAsync(resolved, { recursive: true, force: true })
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
    try {
      const { extensions } = await resolveOwnershipContext(userData, extensionId)
      const cleanupPlans = createExtensionUninstallCleanupPlan(getSettings(userData).modelsDir, extensions, extensionId)

      // Terminate process runner if it's a process extension
      terminateProcessRunner(extensionId)

      for (const extension of extensions) {
        if (extension.type !== 'model' || extension.id !== extensionId) continue
        for (const node of extension.nodes) {
          const capabilityId = node.capabilityId ?? `${extension.id}/${node.id}`
          try {
            await axios.post(`${API_BASE_URL}/model/unload/${encodeURIComponent(capabilityId)}`, {}, { timeout: 5000 })
          } catch {
            // best effort
          }
        }
      }

      await rmAsync(extPath, { recursive: true, force: true })
      for (const cleanupPlan of cleanupPlans) {
        await deleteOwnedModelPaths(cleanupPlan.targets)
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

      const trustedRepos = await fetchTrustedRepos()
      // Build manifest with localPath marker so the UI can identify local extensions
      const annotatedManifest = { ...manifest, source: `local://${localPath}` }
      const ext = parseExtensionManifest(annotatedManifest, extensionId, trustedRepos)
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
    const files = readdirSync(dir).filter(f => f.endsWith('.json'))
    const workflows = []
    for (const file of files) {
      try {
        const raw = await readFile(join(dir, file), 'utf-8')
        workflows.push(JSON.parse(raw))
      } catch { /* skip corrupted files */ }
    }
    return workflows.sort((a: { updatedAt?: string }, b: { updatedAt?: string }) =>
      (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
    )
  })

  ipcMain.handle('workflows:save', async (_, workflow: { id: string; [key: string]: unknown }) => {
    try {
      const path = join(workflowsDir(), `${workflow.id}.json`)
      await writeFile(path, JSON.stringify(workflow, null, 2), 'utf-8')
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
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
    try {
      const raw = await readFile(result.filePaths[0], 'utf-8')
      const workflow = JSON.parse(raw)
      if (!workflow.id || !workflow.nodes) return { success: false, error: 'Invalid workflow file' }
      await writeFile(join(workflowsDir(), `${workflow.id}.json`), JSON.stringify(workflow, null, 2), 'utf-8')
      return { success: true, workflow }
    } catch (err) {
      return { success: false, error: String(err) }
    }
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
}

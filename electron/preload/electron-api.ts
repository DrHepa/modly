import type { HumanoidDraftSidecarReadRequest, HumanoidDraftSidecarReadResult, HumanoidDraftSidecarV1, HumanoidPromotionMethod, HumanoidPromotionSidecarReadRequest, HumanoidPromotionSidecarReadResult, HumanoidPromotionSidecarV1, HumanoidPromotionSidecarWriteRequest, HumanoidPromotionSidecarWriteResult, AnyExtension, VideoInputSelection, ExtensionInstallResult, ExtensionInstallProgress, ProcessInput, ProcessResult, RuntimeReadinessResponse, RuntimeReadinessAction, RuntimeReadinessActionResult, ArtifactRegistryReadRequest, ArtifactRegistryReadResult, ArtifactRegistryWriteRequest, ArtifactRegistryWriteResult, EditedSceneArtifactWriteRequest, EditedSceneArtifactWriteResult, LandmarkSidecarWriteRequest, LandmarkSidecarWriteResult, PoseClipSidecarReadRequest, PoseClipSidecarReadResult, PoseClipSidecarWriteRequest, PoseClipSidecarWriteResult, RigMetaSidecarReadRequest, RigMetaSidecarReadResult, RigRenameSidecarReadRequest, RigRenameSidecarReadResult, RigRenameSidecarWriteRequest, RigRenameSidecarWriteResult, MotionRetargetSidecarReadRequest, MotionRetargetSidecarReadResult, MotionRetargetSidecarWriteRequest, MotionRetargetSidecarWriteResult, WorkspaceArtifactDownloadRequest, WorkspaceArtifactDownloadResult, WorkspaceArtifactPreviewRequest, WorkspaceArtifactPreviewResult, WorldsSceneManifestWriteRequest, WorldsSceneManifestWriteResult } from '../../src/shared/types/electron.d'
import { invokeExtensionsRunProcess } from './run-process-ipc'
import type { AutomationCapabilitiesResponse } from '../../src/shared/types/electron'
import type {
  AssetLibraryListResult,
  AssetLibraryOpenRequest,
  AssetLibraryOpenResult,
  AssetLibraryReadRequest,
  AssetLibraryReadResult,
} from '../../src/shared/types/assetLibrary'
import type { AgentSession, AgentSessionActivateRequest, AgentSessionAddAttachmentRequest, AgentSessionAppendMessageRequest, AgentSessionCreateRequest, AgentSessionDeleteRequest, AgentSessionListResult, AgentSessionReadAttachmentRequest, AgentSessionReadRequest, AgentSessionRemoveAttachmentRequest, AgentSessionRenameRequest } from '../../src/shared/types/agentSessions.ts'

export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: (...args: unknown[]) => void): void
  removeAllListeners(channel: string): void
}

export interface WebFrameLike {
  setZoomFactor(factor: number): void
}

export type WebUtilsLike = Pick<typeof import('electron').webUtils, 'getPathForFile'>

export type ElectronApiDependencies = {
  ipcRenderer: IpcRendererLike
  webFrame: WebFrameLike
  webUtils?: WebUtilsLike
}

function assertWebFrame(webFrame: WebFrameLike | undefined): asserts webFrame is WebFrameLike {
  if (typeof webFrame?.setZoomFactor !== 'function') {
    throw new TypeError('createElectronApi requires Electron webFrame.setZoomFactor')
  }
}

export function createElectronApi(
  dependencies: ElectronApiDependencies | IpcRendererLike,
  legacyWebFrame?: WebFrameLike,
  legacyWebUtils?: WebUtilsLike,
) {
  const { ipcRenderer, webFrame, webUtils } = 'ipcRenderer' in dependencies
    ? dependencies
    : { ipcRenderer: dependencies, webFrame: legacyWebFrame, webUtils: legacyWebUtils }
  assertWebFrame(webFrame)

  return {
    automation: {
      capabilities: (): Promise<AutomationCapabilitiesResponse> =>
        ipcRenderer.invoke('automation:capabilities') as Promise<AutomationCapabilitiesResponse>,
    },

    agentSessions: {
      list: (): Promise<AgentSessionListResult> => ipcRenderer.invoke('agentSessions:list') as Promise<AgentSessionListResult>,
      create: (request: AgentSessionCreateRequest): Promise<AgentSession> => ipcRenderer.invoke('agentSessions:create', request) as Promise<AgentSession>,
      read: (request: AgentSessionReadRequest): Promise<AgentSession> => ipcRenderer.invoke('agentSessions:read', request) as Promise<AgentSession>,
      activate: (request: AgentSessionActivateRequest): Promise<AgentSessionListResult> => ipcRenderer.invoke('agentSessions:activate', request) as Promise<AgentSessionListResult>,
      rename: (request: AgentSessionRenameRequest): Promise<AgentSession> => ipcRenderer.invoke('agentSessions:rename', request) as Promise<AgentSession>,
      delete: (request: AgentSessionDeleteRequest): Promise<AgentSessionListResult> => ipcRenderer.invoke('agentSessions:delete', request) as Promise<AgentSessionListResult>,
      appendMessage: (request: AgentSessionAppendMessageRequest): Promise<AgentSession> => ipcRenderer.invoke('agentSessions:appendMessage', request) as Promise<AgentSession>,
      addAttachment: (request: AgentSessionAddAttachmentRequest): Promise<AgentSession> => ipcRenderer.invoke('agentSessions:addAttachment', request) as Promise<AgentSession>,
      removeAttachment: (request: AgentSessionRemoveAttachmentRequest): Promise<AgentSession> => ipcRenderer.invoke('agentSessions:removeAttachment', request) as Promise<AgentSession>,
      readAttachment: (request: AgentSessionReadAttachmentRequest): Promise<Uint8Array> => ipcRenderer.invoke('agentSessions:readAttachment', request) as Promise<Uint8Array>,
    },

    // Window controls
    window: {
      minimize:     () => ipcRenderer.send('window:minimize'),
      maximize:     () => ipcRenderer.send('window:maximize'),
      close:        () => ipcRenderer.send('window:close'),
      isMaximized:  () => ipcRenderer.invoke('window:isMaximized') as Promise<boolean>,
      onMaximizeChange: (cb: (isMaximized: boolean) => void) => {
        ipcRenderer.on('window:maximizeChanged', (_event, isMaximized) => cb(Boolean(isMaximized)))
      },
      offMaximizeChange: () => ipcRenderer.removeAllListeners('window:maximizeChanged'),
    },

    // Native OS notifications (Windows toast / macOS Notification Center / Linux)
    notifications: {
      show: (title: string, body: string): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke('notifications:show', title, body) as Promise<{ success: boolean; error?: string }>,
    },

    // Renderer UI (zoom whole page — scales every px/rem consistently)
    ui: { setZoomFactor: (factor: number) => webFrame.setZoomFactor(factor) },

    // Shell utilities
    shell: { openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url) },

    // Slicer integration — open a model in OrcaSlicer via its deeplink
    slicer: {
      open: (url: string): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke('slicer:open', url) as Promise<{ success: boolean; error?: string }>,
    },

    // System info
    system: {
      memory: (): Promise<{ total: number; used: number; available: number }> =>
        ipcRenderer.invoke('system:memory') as Promise<{ total: number; used: number; available: number }>,
    },

    // Python / FastAPI bridge
    python: {
      start:     (): Promise<{ success: boolean; port?: number; error?: string }> =>
        ipcRenderer.invoke('python:start') as Promise<{ success: boolean; port?: number; error?: string }>,
      status:    (): Promise<{ ready: boolean; apiUrl: string }> =>
        ipcRenderer.invoke('python:status') as Promise<{ ready: boolean; apiUrl: string }>,
      onCrashed: (cb: (data: { code: number | null }) => void) => {
        ipcRenderer.on('python:crashed', (_event, data) => cb(data as { code: number | null }))
      },
      offCrashed: () => ipcRenderer.removeAllListeners('python:crashed'),
      onLog:  (cb: (line: string) => void) => {
        ipcRenderer.on('python:log', (_event, line) => cb(line as string))
      },
      offLog: () => ipcRenderer.removeAllListeners('python:log'),
    },

    // File system dialogs + local file reading
    fs: {
      getPathForFile:    (file: Parameters<WebUtilsLike['getPathForFile']>[0]): string => {
        if (typeof webUtils?.getPathForFile !== 'function') {
          throw new TypeError('createElectronApi requires Electron webUtils.getPathForFile')
        }
        return webUtils.getPathForFile(file)
      },
      selectImage:       (): Promise<string | null> =>
        ipcRenderer.invoke('fs:selectImage') as Promise<string | null>,
      selectVideo:       (): Promise<VideoInputSelection | null> =>
        ipcRenderer.invoke('fs:selectVideo') as Promise<VideoInputSelection | null>,
      selectMeshFile:    (): Promise<string | null> =>
        ipcRenderer.invoke('fs:selectMeshFile') as Promise<string | null>,
      selectSceneFile:   (): Promise<string | null> =>
        ipcRenderer.invoke('fs:selectSceneFile') as Promise<string | null>,
      saveModel:         (defaultName: string): Promise<string | null> =>
        ipcRenderer.invoke('fs:saveModel', defaultName) as Promise<string | null>,
      readFileBase64:    (filePath: string): Promise<string> =>
        ipcRenderer.invoke('fs:readFileBase64', filePath) as Promise<string>,
      selectDirectory:   (defaultPath?: string): Promise<string | null> =>
        ipcRenderer.invoke('fs:selectDirectory', defaultPath) as Promise<string | null>,
      savePath:          (args: { filters: { name: string; extensions: string[] }[]; defaultPath?: string }): Promise<string | null> =>
        ipcRenderer.invoke('fs:savePath', args) as Promise<string | null>,
      listDir:           (dirPath: string): Promise<string[]> =>
        ipcRenderer.invoke('fs:listDir', dirPath) as Promise<string[]>,
      listFiles:         (dirPath: string, extensions?: string[]): Promise<string[]> =>
        ipcRenderer.invoke('fs:listFiles', dirPath, extensions) as Promise<string[]>,
      selectTextFile:    (): Promise<string | null> =>
        ipcRenderer.invoke('fs:selectTextFile') as Promise<string | null>,
      moveDirectory:     (args: { src: string; dest: string }): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke('fs:moveDirectory', args) as Promise<{ success: boolean; error?: string }>,
      deleteDirectory:   (dirPath: string): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke('fs:deleteDirectory', dirPath) as Promise<{ success: boolean; error?: string }>,
      readScreenshotDataUrl: (filename: string): Promise<string> =>
        ipcRenderer.invoke('fs:readScreenshotDataUrl', filename) as Promise<string>,
    },

    // Secure storage — OS-level encryption for secrets (API keys, …)
    secureStore: {
      encrypt: (plainText: string): Promise<string> => ipcRenderer.invoke('secure:encrypt', plainText) as Promise<string>,
      // null = one of our blobs that couldn't be decrypted here (different OS
      // user/machine). Never the ciphertext — see secure-store.ts.
      decrypt: (stored: string): Promise<string | null> => ipcRenderer.invoke('secure:decrypt', stored) as Promise<string | null>,
    },

    // Agent — local LLM models
    agent: {
      // Opens a file picker and copies the chosen .gguf into the agent's models folder.
      addModel: (): Promise<{ success: boolean; cancelled?: boolean; fileName?: string; error?: string }> =>
        ipcRenderer.invoke('agent:addModel') as Promise<{ success: boolean; cancelled?: boolean; fileName?: string; error?: string }>,
    },

    // Settings
    settings: {
      get: (): Promise<{ modelsDir: string; workspaceDir: string; workflowsDir: string; extensionsDir: string; hfToken?: string }> =>
        ipcRenderer.invoke('settings:get') as Promise<{ modelsDir: string; workspaceDir: string; workflowsDir: string; extensionsDir: string; hfToken?: string }>,
      set: (patch: { modelsDir?: string; workspaceDir?: string; workflowsDir?: string; extensionsDir?: string; hfToken?: string }): Promise<{ modelsDir: string; workspaceDir: string; workflowsDir: string; extensionsDir: string; hfToken?: string }> =>
        ipcRenderer.invoke('settings:set', patch) as Promise<{ modelsDir: string; workspaceDir: string; workflowsDir: string; extensionsDir: string; hfToken?: string }>,
    },

    // Cache
    cache: {
      clear: (): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke('cache:clear') as Promise<{ success: boolean; error?: string }>,
    },

    // API helpers (calls FastAPI from the main process)
    api: {
      updatePaths: (patch: { modelsDir?: string; workspaceDir?: string; extensionsDir?: string }): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke('api:updatePaths', patch) as Promise<{ success: boolean; error?: string }>,
    },

    // Automation mesh dispatch into the mounted Generate viewer.
    scene: {
      onImportMesh: (cb: (payload: { meshPath: string; url: string; displayName: string }) => void) => { ipcRenderer.on('scene:importMesh', (_event, payload) => cb(payload as { meshPath: string; url: string; displayName: string })) },
      offImportMesh: () => ipcRenderer.removeAllListeners('scene:importMesh'),
    },

    // Model management
    model: {
      export:         (args: { outputUrl: string; format: string }) => ipcRenderer.invoke('model:export', args),
      listDownloaded: () => ipcRenderer.invoke('model:listDownloaded'),
      isDownloaded:   (modelId: string) => ipcRenderer.invoke('model:isDownloaded', modelId),
      hasLocalData:    (modelId: string) => ipcRenderer.invoke('model:hasLocalData', modelId),
      sharedGroups:    (extensionId: string) => ipcRenderer.invoke('model:sharedGroups', extensionId),
      download:       (modelId: string, variantId?: string) => (variantId === undefined
        ? ipcRenderer.invoke('model:download', modelId)
        : ipcRenderer.invoke('model:download', modelId, variantId)),
      pauseDownload:  (modelId: string) => ipcRenderer.invoke('model:pauseDownload', modelId),
      cancelDownload: (modelId: string) => ipcRenderer.invoke('model:cancelDownload', modelId),
      delete:         (modelId: string) => ipcRenderer.invoke('model:delete', modelId),
      deleteSharedGroup: (extensionId: string, groupId: string) => ipcRenderer.invoke('model:deleteSharedGroup', extensionId, groupId),
      deleteExtensionWeights: (extensionId: string) => ipcRenderer.invoke('model:deleteExtensionWeights', extensionId),
      installedWeightVariants: (modelId: string) => ipcRenderer.invoke('model:installedWeightVariants', modelId),
      deleteWeightVariant: (modelId: string, variantId: string) => ipcRenderer.invoke('model:deleteWeightVariant', modelId, variantId),
      unloadAll:      () => ipcRenderer.invoke('model:unloadAll'),
      showInFolder:   (modelId: string) => ipcRenderer.invoke('model:showInFolder', modelId),
      runtimeReadiness: (modelIds: string[]): Promise<RuntimeReadinessResponse> =>
        ipcRenderer.invoke('model:runtimeReadiness', modelIds) as Promise<RuntimeReadinessResponse>,
      runtimeReadinessAction: (action: RuntimeReadinessAction): Promise<RuntimeReadinessActionResult> =>
        ipcRenderer.invoke('model:runtimeReadinessAction', action) as Promise<RuntimeReadinessActionResult>,
      activeDownloads: (): Promise<{ modelId: string; capabilityId?: string; variantId?: string; percent: number; file?: string; fileIndex?: number; totalFiles?: number }[]> =>
        ipcRenderer.invoke('model:activeDownloads') as Promise<{ modelId: string; capabilityId?: string; variantId?: string; percent: number; file?: string; fileIndex?: number; totalFiles?: number }[]>,
      onProgress:     (cb: (data: {
        modelId: string
        capabilityId?: string
        variantId?: string
        percent: number
        file?: string
        fileIndex?: number
        totalFiles?: number
        repoIndex?: number
        totalRepos?: number
        status?: string
        bytesDownloaded?: number
        totalBytes?: number
        stalledSeconds?: number
        paused?: boolean
        cancelled?: boolean
      }) => void) => {
        ipcRenderer.on('model:downloadProgress', (_event, data) => cb(data as {
          modelId: string
          capabilityId?: string
          variantId?: string
          percent: number
          file?: string
          fileIndex?: number
          totalFiles?: number
          repoIndex?: number
          totalRepos?: number
          status?: string
          bytesDownloaded?: number
          totalBytes?: number
          stalledSeconds?: number
          paused?: boolean
          cancelled?: boolean
        }))
      },
      offProgress:    () => ipcRenderer.removeAllListeners('model:downloadProgress'),
      onWeightsChanged: (cb: () => void) => ipcRenderer.on('model:weightsChanged', cb),
      offWeightsChanged: () => ipcRenderer.removeAllListeners('model:weightsChanged'),
      downloadAssets:      (modelId: string) => ipcRenderer.invoke('model:downloadAssets', { modelId }),
      downloadHttpsAssets: (modelId: string) => ipcRenderer.invoke('model:downloadHttpsAssets', { modelId }),
    },

    // App metadata
    app: {
      info: (): Promise<{ version: string; userData: string; modelsDir: string; apiUrl: string; platform: string; arch: string }> =>
        ipcRenderer.invoke('app:info') as Promise<{ version: string; userData: string; modelsDir: string; apiUrl: string; platform: string; arch: string }>,
      onError:  (cb: (message: string) => void) => {
        ipcRenderer.on('app:error', (_event, message) => cb(message as string))
      },
      offError: () => ipcRenderer.removeAllListeners('app:error'),
    },

    // Logging
    log: {
      error:   (message: string) => ipcRenderer.send('log:error', message),
      getPath: (): Promise<string> => ipcRenderer.invoke('log:getPath') as Promise<string>,
      readAll: (session?: string): Promise<Record<string, string>> => ipcRenderer.invoke('log:readAll', session) as Promise<Record<string, string>>,
      listSessions: (): Promise<string[]> => ipcRenderer.invoke('log:listSessions') as Promise<string[]>,
    },

    // Workspace filesystem-based persistence
    workspace: {
      listCollections: (): Promise<string[]> =>
        ipcRenderer.invoke('workspace:listCollections') as Promise<string[]>,
      createCollection: (name: string): Promise<void> =>
        ipcRenderer.invoke('workspace:createCollection', name) as Promise<void>,
      renameCollection: (oldName: string, newName: string): Promise<void> =>
        ipcRenderer.invoke('workspace:renameCollection', { oldName, newName }) as Promise<void>,
      deleteCollection: (name: string): Promise<void> =>
        ipcRenderer.invoke('workspace:deleteCollection', name) as Promise<void>,
      listJobs: (collection: string): Promise<unknown[]> =>
        ipcRenderer.invoke('workspace:listJobs', collection) as Promise<unknown[]>,
      saveJobMeta: (collection: string, filename: string, meta: unknown): Promise<void> =>
        ipcRenderer.invoke('workspace:saveJobMeta', { collection, filename, meta }) as Promise<void>,
      deleteJob: (collection: string, filename: string): Promise<void> =>
        ipcRenderer.invoke('workspace:deleteJob', { collection, filename }) as Promise<void>,
      worlds: {
        writeSceneManifest: (request: WorldsSceneManifestWriteRequest): Promise<WorldsSceneManifestWriteResult> => ipcRenderer.invoke('workspace:worlds:writeSceneManifest', request) as Promise<WorldsSceneManifestWriteResult>,
      },
      artifacts: {
        writeSidecar: (request: ArtifactRegistryWriteRequest): Promise<ArtifactRegistryWriteResult> => ipcRenderer.invoke('workspace:artifact:writeSidecar', request) as Promise<ArtifactRegistryWriteResult>,
        readSidecar: (request: ArtifactRegistryReadRequest): Promise<ArtifactRegistryReadResult> => ipcRenderer.invoke('workspace:artifact:readSidecar', request) as Promise<ArtifactRegistryReadResult>,
        writeEditedSceneArtifact: (request: EditedSceneArtifactWriteRequest): Promise<EditedSceneArtifactWriteResult> => ipcRenderer.invoke('workspace:artifact:writeEditedSceneArtifact', request) as Promise<EditedSceneArtifactWriteResult>,
        writeLandmarkSidecar: (request: LandmarkSidecarWriteRequest): Promise<LandmarkSidecarWriteResult> => ipcRenderer.invoke('workspace:artifact:writeLandmarkSidecar', request) as Promise<LandmarkSidecarWriteResult>,
        readHumanoidDraftSidecar: (request: HumanoidDraftSidecarReadRequest): Promise<HumanoidDraftSidecarReadResult> => ipcRenderer.invoke('workspace:artifact:readHumanoidDraftSidecar', request) as Promise<HumanoidDraftSidecarReadResult>,
        writeHumanoidPromotionSidecar: (request: HumanoidPromotionSidecarWriteRequest): Promise<HumanoidPromotionSidecarWriteResult> => ipcRenderer.invoke('workspace:artifact:writeHumanoidPromotionSidecar', request) as Promise<HumanoidPromotionSidecarWriteResult>,
        readHumanoidPromotionSidecar: (request: HumanoidPromotionSidecarReadRequest): Promise<HumanoidPromotionSidecarReadResult> => ipcRenderer.invoke('workspace:artifact:readHumanoidPromotionSidecar', request) as Promise<HumanoidPromotionSidecarReadResult>,
        writeMotionRetargetSidecar: (request: MotionRetargetSidecarWriteRequest): Promise<MotionRetargetSidecarWriteResult> => ipcRenderer.invoke('workspace:artifact:writeMotionRetargetSidecar', request) as Promise<MotionRetargetSidecarWriteResult>,
        readMotionRetargetSidecar: (request: MotionRetargetSidecarReadRequest): Promise<MotionRetargetSidecarReadResult> => ipcRenderer.invoke('workspace:artifact:readMotionRetargetSidecar', request) as Promise<MotionRetargetSidecarReadResult>,
        previewWorkspaceArtifact: (request: WorkspaceArtifactPreviewRequest): Promise<WorkspaceArtifactPreviewResult> => ipcRenderer.invoke('workspace:artifact:previewWorkspaceArtifact', request) as Promise<WorkspaceArtifactPreviewResult>,
        downloadWorkspaceArtifact: (request: WorkspaceArtifactDownloadRequest): Promise<WorkspaceArtifactDownloadResult> => ipcRenderer.invoke('workspace:artifact:downloadWorkspaceArtifact', request) as Promise<WorkspaceArtifactDownloadResult>,
        writePoseClipSidecar: (request: PoseClipSidecarWriteRequest): Promise<PoseClipSidecarWriteResult> => ipcRenderer.invoke('workspace:artifact:writePoseClipSidecar', request) as Promise<PoseClipSidecarWriteResult>,
        readPoseClipSidecar: (request: PoseClipSidecarReadRequest): Promise<PoseClipSidecarReadResult> => ipcRenderer.invoke('workspace:artifact:readPoseClipSidecar', request) as Promise<PoseClipSidecarReadResult>,
        writeRigRenameSidecar: (request: RigRenameSidecarWriteRequest): Promise<RigRenameSidecarWriteResult> => ipcRenderer.invoke('workspace:artifact:writeRigRenameSidecar', request) as Promise<RigRenameSidecarWriteResult>,
        readRigRenameSidecar: (request: RigRenameSidecarReadRequest): Promise<RigRenameSidecarReadResult> => ipcRenderer.invoke('workspace:artifact:readRigRenameSidecar', request) as Promise<RigRenameSidecarReadResult>,
        readRigMetaSidecar: (request: RigMetaSidecarReadRequest): Promise<RigMetaSidecarReadResult> => ipcRenderer.invoke('workspace:artifact:readRigMetaSidecar', request) as Promise<RigMetaSidecarReadResult>,
      },
      library: {
        list: (): Promise<AssetLibraryListResult> => ipcRenderer.invoke('workspace:library:list') as Promise<AssetLibraryListResult>,
        read: (request: AssetLibraryReadRequest): Promise<AssetLibraryReadResult> => ipcRenderer.invoke('workspace:library:read', request) as Promise<AssetLibraryReadResult>,
        open: (request: AssetLibraryOpenRequest): Promise<AssetLibraryOpenResult> => ipcRenderer.invoke('workspace:library:open', request) as Promise<AssetLibraryOpenResult>,
      },
    },

    // Extensions
    extensions: {
      list: (): Promise<AnyExtension[]> =>
        ipcRenderer.invoke('extensions:list') as Promise<AnyExtension[]>,

      installFromGitHub: (url: string): Promise<ExtensionInstallResult> =>
        ipcRenderer.invoke('extensions:installFromGitHub', url) as Promise<ExtensionInstallResult>,

      installFromLocal: (): Promise<ExtensionInstallResult & { cancelled?: boolean; needsRepair?: boolean; localPath?: string }> =>
        ipcRenderer.invoke('extensions:installFromLocal') as Promise<ExtensionInstallResult & { cancelled?: boolean; needsRepair?: boolean; localPath?: string }>,

      uninstall: (extensionId: string): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke('extensions:uninstall', extensionId) as Promise<{ success: boolean; error?: string }>,

      repair: (extensionId: string): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke('extensions:repair', extensionId) as Promise<{ success: boolean; error?: string }>,

      reload: (): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke('extensions:reload') as Promise<{ success: boolean; error?: string }>,

      runProcess: (
        extensionId: string,
        input:       ProcessInput,
        params:      Record<string, unknown>,
      ): Promise<{ success: boolean; result?: { filePath?: string; text?: string }; error?: string }> =>
        invokeExtensionsRunProcess((...args) => ipcRenderer.invoke(...args) as Promise<{ success: boolean; result?: ProcessResult; error?: string }>, extensionId, input, params),

      onInstallProgress: (cb: (data: ExtensionInstallProgress) => void) => {
        ipcRenderer.on('extensions:installProgress', (_event, data) => cb(data as ExtensionInstallProgress))
      },
      offInstallProgress: () => ipcRenderer.removeAllListeners('extensions:installProgress'),
    },

    // Workflows
    workflows: {
      list:   ():                                              Promise<unknown[]>                            => ipcRenderer.invoke('workflows:list') as Promise<unknown[]>,
      save:   (workflow: { id: string; [key: string]: unknown }): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('workflows:save', workflow) as Promise<{ success: boolean; error?: string }>,
      delete: (id: string):                                   Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('workflows:delete', id) as Promise<{ success: boolean; error?: string }>,
      import: ():                                             Promise<{ success: boolean; error?: string; workflow?: unknown }> => ipcRenderer.invoke('workflows:import') as Promise<{ success: boolean; error?: string; workflow?: unknown }>,
      export: (workflow: { id: string; name?: string; [key: string]: unknown }): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('workflows:export', workflow) as Promise<{ success: boolean; error?: string }>,
    },

    // Auto-updater
    updater: {
      check: (): Promise<{ success: boolean }> =>
        ipcRenderer.invoke('updater:check') as Promise<{ success: boolean }>,
      quitAndInstall: (): Promise<void> =>
        ipcRenderer.invoke('updater:quitAndInstall') as Promise<void>,
      onApplying: (cb: (data: { version: string }) => void) => {
        ipcRenderer.on('updater:applying', (_event, data) => cb(data as { version: string }))
      },
      offApplying: () => ipcRenderer.removeAllListeners('updater:applying'),
      onMajorMinorAvailable: (cb: (data: { version: string }) => void) => {
        ipcRenderer.on('updater:major-minor-available', (_event, data) => cb(data as { version: string }))
      },
      offMajorMinorAvailable: () => ipcRenderer.removeAllListeners('updater:major-minor-available'),
    },

    // First-run setup
    setup: {
      check:        (): Promise<{ needed: boolean; defaultDataDir: string; platform: string; arch: string }> =>
        ipcRenderer.invoke('setup:check') as Promise<{ needed: boolean; defaultDataDir: string; platform: string; arch: string }>,
      run:          (): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke('setup:run') as Promise<{ success: boolean; error?: string }>,
      saveDataDir:  (baseDir: string): Promise<void> =>
        ipcRenderer.invoke('setup:saveDataDir', { baseDir }) as Promise<void>,
      onProgress:  (cb: (data: { step: string; percent: number; currentPackage?: string }) => void) => {
        ipcRenderer.on('setup:progress', (_event, data) => cb(data as { step: string; percent: number; currentPackage?: string }))
      },
      offProgress: () => ipcRenderer.removeAllListeners('setup:progress'),
      onComplete:  (cb: () => void) => {
        ipcRenderer.on('setup:complete', () => cb())
      },
      offComplete: () => ipcRenderer.removeAllListeners('setup:complete'),
      onError:     (cb: (data: { message: string }) => void) => {
        ipcRenderer.on('setup:error', (_event, data) => cb(data as { message: string }))
      },
      offError:    () => ipcRenderer.removeAllListeners('setup:error'),
    },
  }
}

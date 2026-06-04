import type { AnyExtension, ArtifactRegistryReadRequest, ArtifactRegistryReadResult, ArtifactRegistryWriteRequest, ArtifactRegistryWriteResult, EditedSceneArtifactWriteRequest, EditedSceneArtifactWriteResult, ExtensionInstallProgress, ExtensionInstallResult, LandmarkSidecarWriteRequest, LandmarkSidecarWriteResult, MotionRetargetSidecarReadRequest, MotionRetargetSidecarReadResult, MotionRetargetSidecarWriteRequest, MotionRetargetSidecarWriteResult, PoseClipSidecarReadRequest, PoseClipSidecarReadResult, PoseClipSidecarWriteRequest, PoseClipSidecarWriteResult, ProcessInput, RigMetaSidecarReadRequest, RigMetaSidecarReadResult, RigRenameSidecarReadRequest, RigRenameSidecarReadResult, RigRenameSidecarWriteRequest, RigRenameSidecarWriteResult, RuntimeReadinessAction, RuntimeReadinessActionResult, RuntimeReadinessResponse, WorkspaceArtifactDownloadRequest, WorkspaceArtifactDownloadResult, WorkspaceArtifactPreviewRequest, WorkspaceArtifactPreviewResult } from '../../src/shared/types/electron.d'
import { invokeExtensionsRunProcess } from './run-process-ipc.ts'

export type IpcRendererLike = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: (...args: unknown[]) => void): void
  removeAllListeners(channel: string): void
}

export function createElectronApi(ipcRenderer: IpcRendererLike) {
  return {
    window: {
      minimize: () => ipcRenderer.send('window:minimize'),
      maximize: () => ipcRenderer.send('window:maximize'),
      close:    () => ipcRenderer.send('window:close')
    },
    shell: {
      openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
    },
    python: {
      start:     (): Promise<{ success: boolean; port?: number; error?: string }> => ipcRenderer.invoke('python:start') as Promise<{ success: boolean; port?: number; error?: string }>,
      status:    (): Promise<{ ready: boolean; apiUrl: string }> => ipcRenderer.invoke('python:status') as Promise<{ ready: boolean; apiUrl: string }>,
      onCrashed: (cb: (data: { code: number | null }) => void) => { ipcRenderer.on('python:crashed', (_event, data) => cb(data as { code: number | null })) },
      offCrashed: () => ipcRenderer.removeAllListeners('python:crashed'),
      onLog:  (cb: (line: string) => void) => { ipcRenderer.on('python:log', (_event, line) => cb(String(line))) },
      offLog: () => ipcRenderer.removeAllListeners('python:log')
    },
    fs: {
      selectImage:       (): Promise<string | null> => ipcRenderer.invoke('fs:selectImage') as Promise<string | null>,
      selectMeshFile:    (): Promise<string | null> => ipcRenderer.invoke('fs:selectMeshFile') as Promise<string | null>,
      saveModel:         (defaultName: string): Promise<string | null> => ipcRenderer.invoke('fs:saveModel', defaultName) as Promise<string | null>,
      readFileBase64:    (filePath: string): Promise<string> => ipcRenderer.invoke('fs:readFileBase64', filePath) as Promise<string>,
      selectDirectory:   (): Promise<string | null> => ipcRenderer.invoke('fs:selectDirectory') as Promise<string | null>,
      savePath:          (args: { filters: { name: string; extensions: string[] }[]; defaultPath?: string }): Promise<string | null> => ipcRenderer.invoke('fs:savePath', args) as Promise<string | null>,
      listDir:           (dirPath: string): Promise<string[]> => ipcRenderer.invoke('fs:listDir', dirPath) as Promise<string[]>,
      moveDirectory:     (args: { src: string; dest: string }): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('fs:moveDirectory', args) as Promise<{ success: boolean; error?: string }>,
      deleteDirectory:   (dirPath: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('fs:deleteDirectory', dirPath) as Promise<{ success: boolean; error?: string }>,
      readScreenshotDataUrl: (filename: string): Promise<string> => ipcRenderer.invoke('fs:readScreenshotDataUrl', filename) as Promise<string>,
    },
    settings: {
      get: (): Promise<{ modelsDir: string; workspaceDir: string; workflowsDir: string; extensionsDir: string; hfToken?: string }> => ipcRenderer.invoke('settings:get') as Promise<{ modelsDir: string; workspaceDir: string; workflowsDir: string; extensionsDir: string; hfToken?: string }>,
      set: (patch: { modelsDir?: string; workspaceDir?: string; workflowsDir?: string; extensionsDir?: string; hfToken?: string }) => ipcRenderer.invoke('settings:set', patch) as Promise<{ modelsDir: string; workspaceDir: string; workflowsDir: string; extensionsDir: string; hfToken?: string }>,
    },
    cache: { clear: (): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('cache:clear') as Promise<{ success: boolean; error?: string }> },
    api: { updatePaths: (patch: { modelsDir?: string; workspaceDir?: string; extensionsDir?: string }): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('api:updatePaths', patch) as Promise<{ success: boolean; error?: string }> },
    automation: { capabilities: () => ipcRenderer.invoke('automation:capabilities') },
    scene: {
      onImportMesh: (cb: (payload: { meshPath: string; url: string; displayName: string }) => void) => { ipcRenderer.on('scene:importMesh', (_event, payload) => cb(payload as { meshPath: string; url: string; displayName: string })) },
      offImportMesh: () => ipcRenderer.removeAllListeners('scene:importMesh'),
    },
    model: {
      export:         (args: { outputUrl: string; format: string }) => ipcRenderer.invoke('model:export', args),
      listDownloaded: () => ipcRenderer.invoke('model:listDownloaded'),
      isDownloaded:   (modelId: string) => ipcRenderer.invoke('model:isDownloaded', modelId),
      download:       (repoId: string, modelId: string, skipPrefixes?: string[]) => ipcRenderer.invoke('model:download', { repoId, modelId, skipPrefixes }),
      delete:         (modelId: string) => ipcRenderer.invoke('model:delete', modelId),
      unloadAll:      () => ipcRenderer.invoke('model:unloadAll'),
      showInFolder:   (modelId: string) => ipcRenderer.invoke('model:showInFolder', modelId),
      runtimeReadiness: (modelIds: string[]): Promise<RuntimeReadinessResponse> => ipcRenderer.invoke('model:runtimeReadiness', modelIds) as Promise<RuntimeReadinessResponse>,
      runtimeReadinessAction: (action: RuntimeReadinessAction): Promise<RuntimeReadinessActionResult> => ipcRenderer.invoke('model:runtimeReadinessAction', action) as Promise<RuntimeReadinessActionResult>,
      onProgress:     (cb: (data: { capabilityId: string; modelId?: string; percent: number; file?: string; fileIndex?: number; totalFiles?: number; status?: string }) => void) => { ipcRenderer.on('model:downloadProgress', (_event, data) => cb(data as { capabilityId: string; modelId?: string; percent: number; file?: string; fileIndex?: number; totalFiles?: number; status?: string })) },
      offProgress:    () => ipcRenderer.removeAllListeners('model:downloadProgress')
    },
    app: {
      info: (): Promise<{ version: string; userData: string; modelsDir: string; apiUrl: string }> => ipcRenderer.invoke('app:info') as Promise<{ version: string; userData: string; modelsDir: string; apiUrl: string }>,
      onError:  (cb: (message: string) => void) => { ipcRenderer.on('app:error', (_event, message) => cb(String(message))) },
      offError: () => ipcRenderer.removeAllListeners('app:error'),
    },
    log: {
      error:   (message: string) => ipcRenderer.send('log:error', message),
      getPath: (): Promise<string> => ipcRenderer.invoke('log:getPath') as Promise<string>,
      readAll: (session?: string): Promise<Record<string, string>> => ipcRenderer.invoke('log:readAll', session) as Promise<Record<string, string>>,
      listSessions: (): Promise<string[]> => ipcRenderer.invoke('log:listSessions') as Promise<string[]>,
    },
    workspace: {
      listCollections: (): Promise<string[]> => ipcRenderer.invoke('workspace:listCollections') as Promise<string[]>,
      createCollection: (name: string): Promise<void> => ipcRenderer.invoke('workspace:createCollection', name) as Promise<void>,
      renameCollection: (oldName: string, newName: string): Promise<void> => ipcRenderer.invoke('workspace:renameCollection', { oldName, newName }) as Promise<void>,
      deleteCollection: (name: string): Promise<void> => ipcRenderer.invoke('workspace:deleteCollection', name) as Promise<void>,
      listJobs: (collection: string): Promise<unknown[]> => ipcRenderer.invoke('workspace:listJobs', collection) as Promise<unknown[]>,
      saveJobMeta: (collection: string, filename: string, meta: unknown): Promise<void> => ipcRenderer.invoke('workspace:saveJobMeta', { collection, filename, meta }) as Promise<void>,
      deleteJob: (collection: string, filename: string): Promise<void> => ipcRenderer.invoke('workspace:deleteJob', { collection, filename }) as Promise<void>,
      artifacts: {
        writeSidecar: (request: ArtifactRegistryWriteRequest): Promise<ArtifactRegistryWriteResult> => ipcRenderer.invoke('workspace:artifact:writeSidecar', request) as Promise<ArtifactRegistryWriteResult>,
        readSidecar: (request: ArtifactRegistryReadRequest): Promise<ArtifactRegistryReadResult> => ipcRenderer.invoke('workspace:artifact:readSidecar', request) as Promise<ArtifactRegistryReadResult>,
        writeEditedSceneArtifact: (request: EditedSceneArtifactWriteRequest): Promise<EditedSceneArtifactWriteResult> => ipcRenderer.invoke('workspace:artifact:writeEditedSceneArtifact', request) as Promise<EditedSceneArtifactWriteResult>,
        writeLandmarkSidecar: (request: LandmarkSidecarWriteRequest): Promise<LandmarkSidecarWriteResult> => ipcRenderer.invoke('workspace:artifact:writeLandmarkSidecar', request) as Promise<LandmarkSidecarWriteResult>,
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
    },
    extensions: {
      list: (): Promise<AnyExtension[]> => ipcRenderer.invoke('extensions:list') as Promise<AnyExtension[]>,
      installFromGitHub: (url: string): Promise<ExtensionInstallResult> => ipcRenderer.invoke('extensions:installFromGitHub', url) as Promise<ExtensionInstallResult>,
      uninstall: (extensionId: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('extensions:uninstall', extensionId) as Promise<{ success: boolean; error?: string }>,
      repair: (extensionId: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('extensions:repair', extensionId) as Promise<{ success: boolean; error?: string }>,
      reload: (): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('extensions:reload') as Promise<{ success: boolean; error?: string }>,
      runProcess: (extensionId: string, input: ProcessInput, params: Record<string, unknown>) => invokeExtensionsRunProcess(
        (channel, targetExtensionId, targetInput, targetParams) => ipcRenderer.invoke(channel, targetExtensionId, targetInput, targetParams) as Promise<{ success: boolean; result?: import('../../src/shared/types/electron.d').ProcessResult; error?: string }>,
        extensionId,
        input,
        params,
      ),
      onInstallProgress: (cb: (data: ExtensionInstallProgress) => void) => { ipcRenderer.on('extensions:installProgress', (_event, data) => cb(data as ExtensionInstallProgress)) },
      offInstallProgress: () => ipcRenderer.removeAllListeners('extensions:installProgress'),
    },
    workflows: {
      list:   (): Promise<unknown[]> => ipcRenderer.invoke('workflows:list') as Promise<unknown[]>,
      save:   (workflow: { id: string; [key: string]: unknown }): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('workflows:save', workflow) as Promise<{ success: boolean; error?: string }>,
      delete: (id: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('workflows:delete', id) as Promise<{ success: boolean; error?: string }>,
      import: (): Promise<{ success: boolean; error?: string; workflow?: unknown }> => ipcRenderer.invoke('workflows:import') as Promise<{ success: boolean; error?: string; workflow?: unknown }>,
      export: (workflow: { id: string; name?: string; [key: string]: unknown }): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('workflows:export', workflow) as Promise<{ success: boolean; error?: string }>,
    },
    updater: {
      check: (): Promise<{ success: boolean }> => ipcRenderer.invoke('updater:check') as Promise<{ success: boolean }>,
      quitAndInstall: (): Promise<void> => ipcRenderer.invoke('updater:quitAndInstall') as Promise<void>,
      onApplying: (cb: (data: { version: string }) => void) => { ipcRenderer.on('updater:applying', (_event, data) => cb(data as { version: string })) },
      offApplying: () => ipcRenderer.removeAllListeners('updater:applying'),
      onMajorMinorAvailable: (cb: (data: { version: string }) => void) => { ipcRenderer.on('updater:major-minor-available', (_event, data) => cb(data as { version: string })) },
      offMajorMinorAvailable: () => ipcRenderer.removeAllListeners('updater:major-minor-available'),
    },
    setup: {
      check:        (): Promise<{ needed: boolean; defaultDataDir: string }> => ipcRenderer.invoke('setup:check') as Promise<{ needed: boolean; defaultDataDir: string }>,
      run:          (): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('setup:run') as Promise<{ success: boolean; error?: string }>,
      saveDataDir:  (baseDir: string): Promise<void> => ipcRenderer.invoke('setup:saveDataDir', { baseDir }) as Promise<void>,
      onProgress:  (cb: (data: { step: string; percent: number; currentPackage?: string }) => void) => { ipcRenderer.on('setup:progress', (_e, data) => cb(data as { step: string; percent: number; currentPackage?: string })) },
      offProgress: () => ipcRenderer.removeAllListeners('setup:progress'),
      onComplete:  (cb: () => void) => { ipcRenderer.on('setup:complete', () => cb()) },
      offComplete: () => ipcRenderer.removeAllListeners('setup:complete'),
      onError:     (cb: (data: { message: string }) => void) => { ipcRenderer.on('setup:error', (_e, data) => cb(data as { message: string })) },
      offError:    () => ipcRenderer.removeAllListeners('setup:error'),
    }
  }
}

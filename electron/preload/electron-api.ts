import type { AnyExtension, ArtifactRegistryReadRequest, ArtifactRegistryReadResult, ArtifactRegistryWriteRequest, ArtifactRegistryWriteResult, AssetLibraryListResult, AssetLibraryOpenRequest, AssetLibraryOpenResult, AssetLibraryReadRequest, AssetLibraryReadResult, EditedSceneArtifactWriteRequest, EditedSceneArtifactWriteResult, ExtensionInstallProgress, ExtensionInstallResult, HumanoidDraftSidecarReadRequest, HumanoidDraftSidecarReadResult, HumanoidPromotionSidecarReadRequest, HumanoidPromotionSidecarReadResult, HumanoidPromotionSidecarWriteRequest, HumanoidPromotionSidecarWriteResult, LandmarkSidecarWriteRequest, LandmarkSidecarWriteResult, ModelDownloadProgress, MotionRetargetSidecarReadRequest, MotionRetargetSidecarReadResult, MotionRetargetSidecarWriteRequest, MotionRetargetSidecarWriteResult, PoseClipSidecarReadRequest, PoseClipSidecarReadResult, PoseClipSidecarWriteRequest, PoseClipSidecarWriteResult, ProcessInput, RigMetaSidecarReadRequest, RigMetaSidecarReadResult, RigRenameSidecarReadRequest, RigRenameSidecarReadResult, RigRenameSidecarWriteRequest, RigRenameSidecarWriteResult, RuntimeReadinessAction, RuntimeReadinessActionResult, RuntimeReadinessResponse, VideoInputSelection, WorkspaceArtifactDownloadRequest, WorkspaceArtifactDownloadResult, WorkspaceArtifactPreviewRequest, WorkspaceArtifactPreviewResult, WorldsSceneManifestWriteRequest, WorldsSceneManifestWriteResult } from '../../src/shared/types/electron.d'
import type { AgentSession, AgentSessionActivateRequest, AgentSessionAddAttachmentRequest, AgentSessionAppendMessageRequest, AgentSessionCreateRequest, AgentSessionDeleteRequest, AgentSessionListResult, AgentSessionReadAttachmentRequest, AgentSessionReadRequest, AgentSessionRemoveAttachmentRequest, AgentSessionRenameRequest } from '../../src/shared/types/agentSessions.ts'
import type { AgentActionDecisionRequest, AgentActionListResult, AgentActionMutationResult, AgentActionProposeRequest, AgentActionSessionGetRequest, AgentActionSessionRequest, AgentCapabilityInventoryResult, AgentModelLeaseRequest, AgentModelLeaseResult, AgentSkillContextResolveRequestV1, AgentSkillContextResolveResultV1 } from '../../src/shared/types/agentActions.ts'
import type { AgentWorkflowCreateRequest, AgentWorkflowCreateResult } from '../../src/shared/types/agentWorkflows.ts'
import {
  WORLD_PROJECT_CHANNELS,
  type WorldProjectCommandRequest,
  type WorldProjectCommandResult,
  type WorldProjectCreateRequest,
  type WorldProjectCreateResult,
  type WorldProjectDeleteRequest,
  type WorldProjectDeleteResult,
  type WorldProjectKeyRequest,
  type WorldProjectListResult,
  type WorldProjectOpenResult,
  type WorldProjectAiPreviewRequest,
  type WorldProjectAiPreviewResult,
  type WorldProjectAiDiscardRequest,
  type WorldProjectResult,
  type WorldsCliApi,
  type WorldsCliDirectEditReadinessRequest,
  type WorldsCliDirectEditAdoption,
  type WorldsCliDirectEditCorrelation,
  type WorldsCliDirectEditRequest,
} from '../../src/shared/types/worldProjects.ts'
import {
  WORLD_RENDER_CHANNELS,
  type WorldRenderCancelRequest,
  type WorldRenderCancelResult,
  type WorldRenderCreateRequest,
  type WorldRenderCreateResult,
  type WorldRenderDeleteRequest,
  type WorldRenderDeleteResult,
  type WorldRenderGetResult,
  type WorldRenderJobKeyRequest,
  type WorldRenderListResult,
} from '../../src/shared/types/worldRenders.ts'
import { invokeExtensionsRunProcess } from './run-process-ipc.ts'

export type IpcRendererLike = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: (...args: unknown[]) => void): void
  removeAllListeners(channel: string): void
}

export type WebFrameLike = {
  setZoomFactor(factor: number): void
}

export type ElectronApiDependencies = {
  ipcRenderer: IpcRendererLike
  webFrame: WebFrameLike
}

function assertWebFrame(webFrame: WebFrameLike): void {
  if (typeof webFrame?.setZoomFactor !== 'function') {
    throw new TypeError('createElectronApi requires Electron webFrame.setZoomFactor')
  }
}

export function createElectronApi({ ipcRenderer, webFrame }: ElectronApiDependencies) {
  assertWebFrame(webFrame)

  return {
    agentActions: {
      leaseModel: (request: AgentModelLeaseRequest): Promise<AgentModelLeaseResult> => ipcRenderer.invoke('agentActions:leaseModel', request) as Promise<AgentModelLeaseResult>,
      propose: (request: AgentActionProposeRequest): Promise<AgentActionMutationResult> => ipcRenderer.invoke('agentActions:propose', request) as Promise<AgentActionMutationResult>,
      get: (request: AgentActionSessionGetRequest): Promise<AgentActionMutationResult> => ipcRenderer.invoke('agentActions:get', request) as Promise<AgentActionMutationResult>,
      list: (request: AgentActionSessionRequest): Promise<AgentActionListResult> => ipcRenderer.invoke('agentActions:list', request) as Promise<AgentActionListResult>,
      decide: (request: AgentActionDecisionRequest): Promise<AgentActionMutationResult> => ipcRenderer.invoke('agentActions:decide', request) as Promise<AgentActionMutationResult>,
      execute: (request: AgentActionSessionGetRequest): Promise<AgentActionMutationResult> => ipcRenderer.invoke('agentActions:execute', request) as Promise<AgentActionMutationResult>,
      cancel: (request: AgentActionSessionGetRequest): Promise<AgentActionMutationResult> => ipcRenderer.invoke('agentActions:cancel', request) as Promise<AgentActionMutationResult>,
    },
    agentCapabilities: {
      list: (): Promise<AgentCapabilityInventoryResult> => ipcRenderer.invoke('agentCapabilities:list') as Promise<AgentCapabilityInventoryResult>,
      resolveSkillContexts: (request: AgentSkillContextResolveRequestV1): Promise<AgentSkillContextResolveResultV1> => ipcRenderer.invoke('agentCapabilities:resolveSkillContexts', request) as Promise<AgentSkillContextResolveResultV1>,
    },
    agentWorkflows: {
      create: (request: AgentWorkflowCreateRequest): Promise<AgentWorkflowCreateResult> => ipcRenderer.invoke('agentWorkflows:create', request) as Promise<AgentWorkflowCreateResult>,
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
    window: {
      minimize: () => ipcRenderer.send('window:minimize'),
      maximize: () => ipcRenderer.send('window:maximize'),
      close:    () => ipcRenderer.send('window:close'),
      isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized') as Promise<boolean>,
      onMaximizeChange: (cb: (isMaximized: boolean) => void) => {
        ipcRenderer.on('window:maximizeChanged', (_event, isMaximized) => cb(Boolean(isMaximized)))
      },
      offMaximizeChange: () => ipcRenderer.removeAllListeners('window:maximizeChanged'),
    },
    ui: {
      setZoomFactor: (factor: number) => webFrame.setZoomFactor(factor),
    },
    shell: {
      openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
    },
    system: {
      memory: (): Promise<{ total: number; used: number; available: number }> => ipcRenderer.invoke('system:memory') as Promise<{ total: number; used: number; available: number }>,
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
      selectVideo:       (): Promise<VideoInputSelection | null> => ipcRenderer.invoke('fs:selectVideo') as Promise<VideoInputSelection | null>,
      selectMeshFile:    (): Promise<string | null> => ipcRenderer.invoke('fs:selectMeshFile') as Promise<string | null>,
      selectSceneFile:   (): Promise<string | null> => ipcRenderer.invoke('fs:selectSceneFile') as Promise<string | null>,
      saveModel:         (defaultName: string): Promise<string | null> => ipcRenderer.invoke('fs:saveModel', defaultName) as Promise<string | null>,
      readFileBase64:    (filePath: string): Promise<string> => ipcRenderer.invoke('fs:readFileBase64', filePath) as Promise<string>,
      selectDirectory:   (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('fs:selectDirectory', defaultPath) as Promise<string | null>,
      savePath:          (args: { filters: { name: string; extensions: string[] }[]; defaultPath?: string }): Promise<string | null> => ipcRenderer.invoke('fs:savePath', args) as Promise<string | null>,
      listDir:           (dirPath: string): Promise<string[]> => ipcRenderer.invoke('fs:listDir', dirPath) as Promise<string[]>,
      listFiles:         (dirPath: string, extensions?: string[]): Promise<string[]> => ipcRenderer.invoke('fs:listFiles', dirPath, extensions) as Promise<string[]>,
      selectTextFile:    (): Promise<string | null> => ipcRenderer.invoke('fs:selectTextFile') as Promise<string | null>,
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
      hasLocalData:    (modelId: string) => ipcRenderer.invoke('model:hasLocalData', modelId),
      download:       (repoId: string, modelId: string, skipPrefixes?: string[], includePrefixes?: string[]) => ipcRenderer.invoke('model:download', { repoId, modelId, skipPrefixes, includePrefixes }),
      downloadAssets:      (modelId: string) => ipcRenderer.invoke('model:downloadAssets', { modelId }),
      downloadSources:     (modelId: string) => ipcRenderer.invoke('model:downloadSources', { modelId }),
      downloadHttpsAssets: (modelId: string) => ipcRenderer.invoke('model:downloadHttpsAssets', { modelId }),
      delete:              (modelId: string) => ipcRenderer.invoke('model:delete', modelId),
      pauseDownload:       (modelId: string) => ipcRenderer.invoke('model:pauseDownload', modelId),
      cancelDownload:      (modelId: string) => ipcRenderer.invoke('model:cancelDownload', modelId),
      unloadAll:      () => ipcRenderer.invoke('model:unloadAll'),
      showInFolder:   (modelId: string) => ipcRenderer.invoke('model:showInFolder', modelId),
      runtimeReadiness: (modelIds: string[]): Promise<RuntimeReadinessResponse> => ipcRenderer.invoke('model:runtimeReadiness', modelIds) as Promise<RuntimeReadinessResponse>,
      runtimeReadinessAction: (action: RuntimeReadinessAction): Promise<RuntimeReadinessActionResult> => ipcRenderer.invoke('model:runtimeReadinessAction', action) as Promise<RuntimeReadinessActionResult>,
      onProgress:     (cb: (data: ModelDownloadProgress) => void) => { ipcRenderer.on('model:downloadProgress', (_event, data) => cb(data as ModelDownloadProgress)) },
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
      library: {
        list: (): Promise<AssetLibraryListResult> => ipcRenderer.invoke('workspace:library:list') as Promise<AssetLibraryListResult>,
        read: (request: AssetLibraryReadRequest): Promise<AssetLibraryReadResult> => ipcRenderer.invoke('workspace:library:read', request) as Promise<AssetLibraryReadResult>,
        open: (request: AssetLibraryOpenRequest): Promise<AssetLibraryOpenResult> => ipcRenderer.invoke('workspace:library:open', request) as Promise<AssetLibraryOpenResult>,
      },
      worlds: {
        writeSceneManifest: (request: WorldsSceneManifestWriteRequest): Promise<WorldsSceneManifestWriteResult> => ipcRenderer.invoke('workspace:worlds:writeSceneManifest', request) as Promise<WorldsSceneManifestWriteResult>,
        cli: {
          onContextRequest: (callback) => {
            ipcRenderer.removeAllListeners('workspace:worlds:cli:contextRequest')
            ipcRenderer.on('workspace:worlds:cli:contextRequest', (_event, nonce) => {
              if (typeof nonce === 'string' && /^([a-f0-9]{48})$/.test(nonce)) callback(nonce)
            })
            return () => ipcRenderer.removeAllListeners('workspace:worlds:cli:contextRequest')
          },
          respondContext: (value) => ipcRenderer.invoke('workspace:worlds:cli:contextResponse', value),
          editorLeft: () => ipcRenderer.invoke('workspace:worlds:cli:editorLeft'),
          onDirectEditReadinessRequest: (callback) => {
            ipcRenderer.removeAllListeners('workspace:worlds:cli:directEditReadinessRequest')
            ipcRenderer.on('workspace:worlds:cli:directEditReadinessRequest', (_event, value) => {
              if (isWorldsCliReadinessRequest(value)) callback(value)
            })
            return () => ipcRenderer.removeAllListeners('workspace:worlds:cli:directEditReadinessRequest')
          },
          respondDirectEditReadiness: (value) => ipcRenderer.invoke('workspace:worlds:cli:directEditReadinessResponse', value),
          cancelDirectEditReadiness: (value) => ipcRenderer.invoke('workspace:worlds:cli:directEditReadinessCancel', value),
          onDirectEditRequest: (callback) => {
            ipcRenderer.removeAllListeners('workspace:worlds:cli:directEditRequest')
            ipcRenderer.on('workspace:worlds:cli:directEditRequest', (_event, value) => {
              if (isWorldsCliDirectEditRequest(value)) callback(value)
            })
            return () => ipcRenderer.removeAllListeners('workspace:worlds:cli:directEditRequest')
          },
          commitDirectEdit: (value) => isWorldsCliDirectEditCommit(value)
            ? ipcRenderer.invoke('workspace:worlds:cli:directEditCommit', value)
            : Promise.resolve({ ok: false, code: 'INVALID_REQUEST' }),
          cancelDirectEdit: (value) => isWorldsCliDirectEditCancel(value)
            ? ipcRenderer.invoke('workspace:worlds:cli:directEditCancel', value)
            : Promise.resolve({ ok: false, code: 'INVALID_REQUEST' }),
          adoptDirectEdit: (value) => isWorldsCliDirectEditAdoption(value)
            ? ipcRenderer.invoke('workspace:worlds:cli:directEditAdopt', value)
            : Promise.resolve({ ok: false, code: 'INVALID_REQUEST' }),
          status: () => ipcRenderer.invoke('workspace:worlds:cli:status'),
          revoke: () => ipcRenderer.invoke('workspace:worlds:cli:revoke'),
          listPending: () => ipcRenderer.invoke('workspace:worlds:cli:listPending'),
          getReview: (request) => ipcRenderer.invoke('workspace:worlds:cli:getReview', request),
          reject: (request) => ipcRenderer.invoke('workspace:worlds:cli:reject', request),
          apply: (request) => ipcRenderer.invoke('workspace:worlds:cli:apply', request),
          cancelApplyIntent: (request) => ipcRenderer.invoke('workspace:worlds:cli:cancelApplyIntent', request),
        } as WorldsCliApi,
        projects: {
          create: (request: WorldProjectCreateRequest): Promise<WorldProjectCreateResult> => ipcRenderer.invoke(WORLD_PROJECT_CHANNELS.create, request) as Promise<WorldProjectCreateResult>,
          list: (): Promise<WorldProjectListResult> => ipcRenderer.invoke(WORLD_PROJECT_CHANNELS.list) as Promise<WorldProjectListResult>,
          open: (request: WorldProjectKeyRequest): Promise<WorldProjectOpenResult> => ipcRenderer.invoke(WORLD_PROJECT_CHANNELS.open, request) as Promise<WorldProjectOpenResult>,
          previewCommands: (request: WorldProjectCommandRequest): Promise<WorldProjectCommandResult> => ipcRenderer.invoke(WORLD_PROJECT_CHANNELS.previewCommands, request) as Promise<WorldProjectCommandResult>,
          applyCommands: (request: WorldProjectCommandRequest): Promise<WorldProjectCommandResult> => ipcRenderer.invoke(WORLD_PROJECT_CHANNELS.applyCommands, request) as Promise<WorldProjectCommandResult>,
          previewAi: (request: WorldProjectAiPreviewRequest): Promise<WorldProjectAiPreviewResult> => ipcRenderer.invoke(WORLD_PROJECT_CHANNELS.previewAi, request) as Promise<WorldProjectAiPreviewResult>,
          discardAi: (request: WorldProjectAiDiscardRequest): Promise<WorldProjectResult<{ discarded: true }>> => ipcRenderer.invoke(WORLD_PROJECT_CHANNELS.discardAi, request) as Promise<WorldProjectResult<{ discarded: true }>>,
          delete: (request: WorldProjectDeleteRequest): Promise<WorldProjectDeleteResult> => ipcRenderer.invoke(WORLD_PROJECT_CHANNELS.delete, request) as Promise<WorldProjectDeleteResult>,
        },
        renders: {
          create: (request: WorldRenderCreateRequest): Promise<WorldRenderCreateResult> => ipcRenderer.invoke(WORLD_RENDER_CHANNELS.create, request) as Promise<WorldRenderCreateResult>,
          list: (): Promise<WorldRenderListResult> => ipcRenderer.invoke(WORLD_RENDER_CHANNELS.list) as Promise<WorldRenderListResult>,
          get: (request: WorldRenderJobKeyRequest): Promise<WorldRenderGetResult> => ipcRenderer.invoke(WORLD_RENDER_CHANNELS.get, request) as Promise<WorldRenderGetResult>,
          cancel: (request: WorldRenderCancelRequest): Promise<WorldRenderCancelResult> => ipcRenderer.invoke(WORLD_RENDER_CHANNELS.cancel, request) as Promise<WorldRenderCancelResult>,
          delete: (request: WorldRenderDeleteRequest): Promise<WorldRenderDeleteResult> => ipcRenderer.invoke(WORLD_RENDER_CHANNELS.delete, request) as Promise<WorldRenderDeleteResult>,
        },
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
    },
    extensions: {
      list: (): Promise<AnyExtension[]> => ipcRenderer.invoke('extensions:list') as Promise<AnyExtension[]>,
      installFromGitHub: (url: string): Promise<ExtensionInstallResult> => ipcRenderer.invoke('extensions:installFromGitHub', url) as Promise<ExtensionInstallResult>,
      installFromLocal: (): Promise<ExtensionInstallResult & { cancelled?: boolean; localPath?: string }> => ipcRenderer.invoke('extensions:installFromLocal') as Promise<ExtensionInstallResult & { cancelled?: boolean; localPath?: string }>,
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

function isWorldsCliReadinessRequest(value: unknown): value is WorldsCliDirectEditReadinessRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).sort().join(',') === 'baseRevision,editorEpoch,expiresAt,intentId,nonce,projectId,projectKey,sceneId'
    && typeof record.nonce === 'string' && /^[a-f0-9]{48}$/.test(record.nonce)
    && typeof record.intentId === 'string' && /^intent_[a-f0-9]{48}$/.test(record.intentId)
    && typeof record.projectKey === 'string' && /^world-[a-f0-9]{32}$/.test(record.projectKey)
    && typeof record.projectId === 'string' && /^project:[A-Za-z0-9:_-]{1,128}$/.test(record.projectId)
    && typeof record.sceneId === 'string' && /^scene:[A-Za-z0-9:_-]{1,128}$/.test(record.sceneId)
    && Number.isSafeInteger(record.baseRevision) && (record.baseRevision as number) >= 0
    && Number.isSafeInteger(record.editorEpoch) && (record.editorEpoch as number) >= 0
    && Number.isSafeInteger(record.expiresAt) && (record.expiresAt as number) > 0
}

function isWorldsCliDirectEditRequest(value: unknown): value is WorldsCliDirectEditRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const record = value as Record<string, unknown>
    return Object.keys(record).sort().join(',') === 'baseRevision,editIntent,editorEpoch,expiresAt,nonce,projectId,projectKey,sceneId'
      && typeof record.nonce === 'string' && /^[a-f0-9]{48}$/.test(record.nonce)
      && typeof record.editIntent === 'string' && /^edit_[a-f0-9]{48}$/.test(record.editIntent)
      && typeof record.projectKey === 'string' && /^world-[a-f0-9]{32}$/.test(record.projectKey)
      && typeof record.projectId === 'string' && /^project:[A-Za-z0-9:_-]{1,128}$/.test(record.projectId)
      && typeof record.sceneId === 'string' && /^scene:[A-Za-z0-9:_-]{1,128}$/.test(record.sceneId)
      && Number.isSafeInteger(record.baseRevision) && (record.baseRevision as number) >= 0
      && Number.isSafeInteger(record.editorEpoch) && (record.editorEpoch as number) >= 0
      && Number.isSafeInteger(record.expiresAt) && (record.expiresAt as number) > 0
  } catch { return false }
}

function isWorldsCliDirectEditCommit(value: unknown): value is WorldsCliDirectEditCorrelation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const record = value as Record<string, unknown>
    return Object.keys(record).sort().join(',') === 'editIntent,nonce'
      && typeof record.nonce === 'string' && /^[a-f0-9]{48}$/.test(record.nonce)
      && typeof record.editIntent === 'string' && /^edit_[a-f0-9]{48}$/.test(record.editIntent)
  } catch { return false }
}

function isWorldsCliDirectEditCancel(value: unknown): value is WorldsCliDirectEditCorrelation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const record = value as Record<string, unknown>
    return Object.keys(record).sort().join(',') === 'editIntent,nonce'
      && typeof record.nonce === 'string' && /^[a-f0-9]{48}$/.test(record.nonce)
      && typeof record.editIntent === 'string' && /^edit_[a-f0-9]{48}$/.test(record.editIntent)
  } catch { return false }
}

function isWorldsCliDirectEditAdoption(value: unknown): value is WorldsCliDirectEditAdoption {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const record = value as Record<string, unknown>
    return Object.keys(record).sort().join(',') === 'editIntent,newRevision,nonce,snapshotSha256,transactionId'
      && typeof record.nonce === 'string' && /^[a-f0-9]{48}$/.test(record.nonce)
      && typeof record.editIntent === 'string' && /^edit_[a-f0-9]{48}$/.test(record.editIntent)
      && typeof record.transactionId === 'string' && /^[a-f0-9]{32}$/.test(record.transactionId)
      && Number.isSafeInteger(record.newRevision) && (record.newRevision as number) >= 1
      && typeof record.snapshotSha256 === 'string' && /^[a-f0-9]{64}$/.test(record.snapshotSha256)
  } catch { return false }
}

// Type declarations for the Electron API exposed via preload
export {}

import type {
  AssetLibraryListResult,
  AssetLibraryOpenRequest,
  AssetLibraryOpenResult,
  AssetLibraryReadRequest,
  AssetLibraryReadResult,
} from './assetLibrary'

// ─── Extension types ──────────────────────────────────────────────────────────

export interface ExtensionNode {
  id:               string
  name:             string
  input:            'image' | 'text' | 'mesh'
  output:           'image' | 'text' | 'mesh'
  inputs?:          ProcessPort[]
  paramsSchema:     RawParamSchema[]
  hfRepo?:          string
  downloadCheck?:   string
  hfSkipPrefixes?:  string[]
  capabilityId?:    string
  bundleId?:        string
  weightOwnerId?:   string
  sharedOwner?:     boolean
  legacyPaths?:     string[]
}

export interface ModelOwnershipMetadata {
  capabilityId: string
  bundleId: string
  weightOwnerId: string
  sharedOwner: boolean
  legacyPaths: string[]
}

export interface ProcessPort {
  name:     string
  label?:   string
  type:     'image' | 'text' | 'mesh'
  required?: boolean
}

export interface NamedProcessInput {
  type:         'image' | 'text' | 'mesh'
  filePath?:    string
  text?:        string
  sourceNodeId: string
}

export interface ModelExtension {
  type:         'model'
  id:           string
  name:         string
  version?:     string
  description?: string
  author?:      string
  trusted:      boolean
  builtin:      boolean
  source?:      string
  localPath?:   string
  nodes:        ExtensionNode[]
  /** Folder exists but is not a loadable extension — see manifestError */
  corrupted?:   boolean
  /** Why the folder is corrupted: manifest gone, manifest unparseable, or install never completed */
  manifestError?: 'missing' | 'invalid' | 'incomplete'
}

export type WorkflowPickerIntent = 'image' | 'mesh' | 'directory' | 'save-path' | 'generic-file'

export interface WorkflowParamFilter {
  name: string
  extensions: string[]
}

export interface WorkflowParamOption {
  value: number | string
  label: string
}

interface WorkflowParamSchemaBase {
  id:       string
  label:    string
  tooltip?: string
  show_if?: Record<string, boolean | number | string | (boolean | number | string)[]>
}

export interface SelectParamSchema extends WorkflowParamSchemaBase {
  type: 'select'
  default: number | string
  options?: WorkflowParamOption[]
}

export interface IntParamSchema extends WorkflowParamSchemaBase {
  type: 'int'
  default: number
  min?:     number
  max?:     number
  step?:    number
}

export interface FloatParamSchema extends WorkflowParamSchemaBase {
  type: 'float'
  default: number
  min?: number
  max?: number
  step?: number
}

export interface StringParamSchema extends WorkflowParamSchemaBase {
  type: 'string'
  default: string
  pickerIntent?: WorkflowPickerIntent
  filters?: WorkflowParamFilter[]
}

export interface BooleanParamSchema extends WorkflowParamSchemaBase {
  type: 'boolean'
  default: boolean
}

export interface UnsupportedParamSchema extends WorkflowParamSchemaBase {
  type: 'unsupported'
  default: ''
  reason: string
  rawType?: string
}

export type RawParamSchema =
  | SelectParamSchema
  | IntParamSchema
  | FloatParamSchema
  | StringParamSchema
  | BooleanParamSchema
  | Record<string, unknown>

export type ParamSchema =
  | SelectParamSchema
  | IntParamSchema
  | FloatParamSchema
  | StringParamSchema
  | BooleanParamSchema
  | UnsupportedParamSchema

export interface ProcessExtension {
  type:         'process'
  id:           string
  name:         string
  version?:     string
  description?: string
  author?:      string
  trusted:      boolean
  builtin:      boolean
  source?:      string
  localPath?:   string
  entry:        string
  nodes:        ExtensionNode[]
  /** Folder exists but is not a loadable extension — see manifestError */
  corrupted?:   boolean
  /** Why the folder is corrupted: manifest gone, manifest unparseable, or install never completed */
  manifestError?: 'missing' | 'invalid' | 'incomplete'
}

export type AnyExtension = ModelExtension | ProcessExtension

export interface RuntimeReadiness {
  ok: boolean
  machine_code: string
  label_hint?: 'Ready' | 'Setup Codex' | 'Login' | 'Update Codex' | 'Unsupported' | 'Checking failed'
  reason?: string
  evidence?: Record<string, unknown>
  actions?: RuntimeReadinessAction[]
  details?: RuntimeReadinessDetails
  checked_at: string
  stale?: boolean
}

export type RuntimeReadinessActionKind = 'show_guidance' | 'show_details' | 'open_external_url' | 'refresh_readiness'
export type RuntimeReadinessActionSafety = 'manual' | 'non_destructive' | 'confirm'

export interface RuntimeReadinessAction {
  id: string
  kind: RuntimeReadinessActionKind
  label: string
  disabled?: boolean
  reason?: string
  guidance?: string
  docs_url?: string
  requires_confirmation?: boolean
  confirmation?: { title: string; body: string; confirm_label: string }
  refresh_after?: 'always' | 'success' | 'never'
  safety: RuntimeReadinessActionSafety
}

export interface RuntimeReadinessDetails {
  title?: string
  summary?: string
  evidence?: Record<string, string>
  diagnostics?: Record<string, string>
  guidance?: string
}

export interface RuntimeReadinessActionResult {
  success: boolean
  error?: string
}

export interface RuntimeReadinessResponse {
  success: boolean
  models: Record<string, RuntimeReadiness>
  error?: string
}

export type ExtensionInstallStatus = 'success' | 'partial' | 'error'
export type ExtensionInstallFailureStage = 'download' | 'extract' | 'validate' | 'commit' | 'setup' | 'npm' | 'reload' | string

export interface InstalledExtensionResult {
  extensionId: string
  extension: AnyExtension
  status: Extract<ExtensionInstallStatus, 'success' | 'partial'>
}

export interface FailedExtensionResult {
  extensionId: string
  stage: ExtensionInstallFailureStage
  error: string
}

export interface ExtensionInstallResult {
  success: boolean
  status?: ExtensionInstallStatus
  installed?: InstalledExtensionResult[]
  failed?: FailedExtensionResult[]
  warnings?: string[]
  reloaded?: boolean
  error?: string
  extensionId?: string
  extension?: AnyExtension
}

export interface ExtensionInstallProgress extends ExtensionInstallResult {
  step: 'downloading' | 'extracting' | 'validating' | 'setting_up' | 'child_result' | 'done' | 'error'
  percent?: number
  message?: string
  completedChildren?: number
  totalChildren?: number
}

// ─── Process runner types ─────────────────────────────────────────────────────

export interface ProcessInput {
  filePath?: string
  text?:     string
  /** Per-slot texts for multi-text-input nodes (index = target handle slot). */
  texts?:    (string | undefined)[]
  nodeId?:   string
  inputs?:   Record<string, NamedProcessInput>
}

export interface ProcessResult {
  filePath?: string
  text?:     string
}

export interface WFNodeData {
  [key: string]: unknown
  extensionId?:    string
  inputType?:      'image' | 'text'
  enabled:         boolean
  showInGenerate?: boolean
  iterations?:     number   // While container: auto-loop N times (omit/0 = manual only)
  params:          Record<string, unknown>
  // React Flow requires node data to satisfy Record<string, unknown>.
  [key: string]:   unknown
}

export interface WFNode {
  id:        string
  type:      string
  position:  { x: number; y: number }
  data:      WFNodeData
  // Sub-flow / group support (While container)
  parentId?: string
  extent?:   'parent'
  width?:    number
  height?:   number
  style?:    Record<string, unknown>
}

export interface WFEdge {
  id:            string
  source:        string
  target:        string
  sourceHandle?: string | null
  targetHandle?: string | null
}

export interface Workflow {
  id:          string
  name:        string
  description: string
  /** Display folder in the workflow browser (no folder = root) */
  folder?:     string
  /** Pinned in the workflow browser's Bookmarks section */
  bookmarked?: boolean
  nodes:       WFNode[]
  edges:       WFEdge[]
  createdAt:   string
  updatedAt:   string
}

export type AutomationCapabilitySource = 'backend-runtime' | 'electron-manifest' | 'ui-only'

export interface AutomationModelCapability {
  kind: 'model'
  source: 'backend-runtime'
  id: string
  name: string
  description?: string
  version?: string
  hf_repo?: string
  tags?: string[]
  downloaded?: boolean
  loaded?: boolean
  active?: boolean
  vram_gb?: number
  params_schema: unknown
}

export interface AutomationProcessCapability {
  kind: 'process'
  source: 'electron-manifest'
  id: string
  extension_id: string
  node_id: string
  name: string
  extension_name: string
  description?: string
  version?: string
  builtin: boolean
  trusted: boolean
  entry: string
  input?: 'image' | 'text' | 'mesh'
  output?: 'image' | 'text' | 'mesh'
  inputs?: ProcessPort[]
  params_schema?: unknown
  ready?: boolean | null
}

export interface AutomationUiOnlyCapability {
  kind: 'ui_only'
  source: 'ui-only'
  id: string
  type?: string
  label: string
  reason: string
}

export interface AutomationCapabilityError {
  source: 'backend-runtime' | 'electron-manifest'
  code: string
  message: string
  retryable: boolean
  context?: Record<string, unknown>
}

export interface AutomationCapabilitiesResponse {
  /**
   * Canonical contrato compartido entre `window.electron.automation.capabilities()`
   * y el bridge HTTP localhost `GET /automation/capabilities`.
   *
   * Mantiene el ownership en Electron main y describe sólo el surface read-only del MVP:
   * no implica writes, workflow management, process execution ni soporte headless para
   * operaciones exclusivas de Electron/UI.
   */
  backend_ready: boolean
  models: AutomationModelCapability[]
  processes: AutomationProcessCapability[]
  scene: {
    import_mesh: {
      supported: true
      route: '/scene/import-mesh'
      allowed_extensions: string[]
      extensions: string[]
    }
  }
  excluded: {
    ui_only_nodes: AutomationUiOnlyCapability[]
  }
  errors?: AutomationCapabilityError[]
}

declare global {
  interface Window {
    electron: {
      shell: {
        openExternal: (url: string) => Promise<void>
      }
      system: {
        memory: () => Promise<{ total: number; used: number; available: number }>
      }
      window: {
        minimize:          () => void
        maximize:          () => void
        close:             () => void
        isMaximized:       () => Promise<boolean>
        onMaximizeChange:  (cb: (isMaximized: boolean) => void) => void
        offMaximizeChange: () => void
      }
      ui: {
        setZoomFactor: (factor: number) => void
      }
      python: {
        start:     () => Promise<{ success: boolean; port?: number; error?: string }>
        status:    () => Promise<{ ready: boolean; apiUrl: string }>
        onCrashed: (cb: (data: { code: number | null }) => void) => void
        offCrashed: () => void
        onLog:  (cb: (line: string) => void) => void
        offLog: () => void
      }
      fs: {
        selectImage:     () => Promise<string | null>
        selectMeshFile:  () => Promise<string | null>
        saveModel:       (defaultName: string) => Promise<string | null>
        readFileBase64:  (filePath: string) => Promise<string>
        selectDirectory: (defaultPath?: string) => Promise<string | null>
        savePath:        (args: { filters: { name: string; extensions: string[] }[]; defaultPath?: string }) => Promise<string | null>
        listDir:         (dirPath: string) => Promise<string[]>
        listFiles:       (dirPath: string, extensions?: string[]) => Promise<string[]>
        selectTextFile:  () => Promise<string | null>
        moveDirectory:   (args: { src: string; dest: string }) => Promise<{ success: boolean; error?: string }>
        deleteDirectory: (dirPath: string) => Promise<{ success: boolean; error?: string }>
        readScreenshotDataUrl: (filename: string) => Promise<string>
      }
      settings: {
        get: () => Promise<{ modelsDir: string; workspaceDir: string; workflowsDir: string; extensionsDir: string; hfToken?: string }>
        set: (patch: { modelsDir?: string; workspaceDir?: string; workflowsDir?: string; extensionsDir?: string; hfToken?: string }) => Promise<{ modelsDir: string; workspaceDir: string; workflowsDir: string; extensionsDir: string; hfToken?: string }>
      }
      cache: {
        clear: () => Promise<{ success: boolean; error?: string }>
      }
      api: {
        updatePaths: (patch: { modelsDir?: string; workspaceDir?: string; extensionsDir?: string }) => Promise<{ success: boolean; error?: string }>
      }
      automation: {
        capabilities: () => Promise<AutomationCapabilitiesResponse>
      }
      scene: {
        onImportMesh: (cb: (payload: { meshPath: string; url: string; displayName: string }) => void) => void
        offImportMesh: () => void
      }
      model: {
        export:         (args: { outputUrl: string; format: string }) => Promise<{ success: boolean; error?: string }>
        listDownloaded: () => Promise<{ id: string; name: string; size_gb: number }[]>
        isDownloaded:   (modelId: string) => Promise<boolean>
        download:       (repoId: string, modelId: string, skipPrefixes?: string[]) => Promise<{ success: boolean; error?: string }>
        delete:         (modelId: string) => Promise<{ success: boolean; error?: string; warning?: string; skipped?: boolean }>
        unloadAll:      () => Promise<{ success: boolean; error?: string }>
        showInFolder:   (modelId: string) => Promise<void>
        runtimeReadiness: (modelIds: string[]) => Promise<RuntimeReadinessResponse>
        runtimeReadinessAction: (action: RuntimeReadinessAction) => Promise<RuntimeReadinessActionResult>
        onProgress:     (cb: (data: { capabilityId: string; modelId?: string; percent: number; file?: string; fileIndex?: number; totalFiles?: number; status?: string }) => void) => void
        offProgress:    () => void
      }
      app: {
        info: () => Promise<{
          version:   string
          userData:  string
          modelsDir: string
          apiUrl:    string
          platform:  string
          arch:      string
        }>
        onError:  (cb: (message: string) => void) => void
        offError: () => void
      }
      log: {
        error:   (message: string) => void
        getPath: () => Promise<string>
        readAll: (session?: string) => Promise<Record<string, string>>
        listSessions: () => Promise<string[]>
      }
      workspace: {
        listCollections: () => Promise<string[]>
        createCollection: (name: string) => Promise<void>
        renameCollection: (oldName: string, newName: string) => Promise<void>
        deleteCollection: (name: string) => Promise<void>
        listJobs: (collection: string) => Promise<unknown[]>
        saveJobMeta: (collection: string, filename: string, meta: unknown) => Promise<void>
        deleteJob: (collection: string, filename: string) => Promise<void>
        library: {
          list: () => Promise<AssetLibraryListResult>
          read: (request: AssetLibraryReadRequest) => Promise<AssetLibraryReadResult>
          open: (request: AssetLibraryOpenRequest) => Promise<AssetLibraryOpenResult>
        }
      }
      setup: {
        check:        () => Promise<{ needed: boolean; defaultDataDir: string; platform: string; arch: string }>
        run:          () => Promise<{ success: boolean; error?: string }>
        saveDataDir:  (baseDir: string) => Promise<void>
        onProgress:   (cb: (data: { step: string; percent: number; currentPackage?: string }) => void) => void
        offProgress:  () => void
        onComplete:   (cb: () => void) => void
        offComplete:  () => void
        onError:      (cb: (data: { message: string }) => void) => void
        offError:     () => void
      }
      workflows: {
        list:   () => Promise<Workflow[]>
        save:   (workflow: Workflow) => Promise<{ success: boolean; error?: string }>
        delete: (id: string)        => Promise<{ success: boolean; error?: string }>
        import: ()                  => Promise<{ success: boolean; error?: string; workflow?: Workflow }>
        export: (workflow: Workflow) => Promise<{ success: boolean; error?: string }>
      }
      updater: {
        check:                 () => Promise<{ success: boolean }>
        quitAndInstall:        () => Promise<void>
        onApplying:            (cb: (data: { version: string }) => void) => void
        offApplying:           () => void
        onMajorMinorAvailable: (cb: (data: { version: string }) => void) => void
        offMajorMinorAvailable: () => void
      }
      extensions: {
        list:              () => Promise<AnyExtension[]>
        installFromGitHub: (url: string) => Promise<ExtensionInstallResult>
        uninstall:   (extensionId: string) => Promise<{ success: boolean; error?: string }>
        repair:      (extensionId: string) => Promise<{ success: boolean; error?: string }>
        reload:      () => Promise<{ success: boolean; error?: string; errors?: Record<string, string> }>
        runProcess:  (extensionId: string, input: ProcessInput, params: Record<string, unknown>) => Promise<{ success: boolean; result?: ProcessResult; error?: string }>
        onInstallProgress: (cb: (data: ExtensionInstallProgress) => void) => void
        offInstallProgress: () => void
      }
    }
  }
}

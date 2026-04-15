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
  input:            string
  inputs?:          string[] | ProcessPort[]   // positional slots or explicit named ports
  inputLabels?:     string[]   // display labels per input slot (e.g. positive/negative)
  output:           string
  paramsSchema:     RawParamSchema[]
  paramDefaults?:   Record<string, boolean | number | string>
  hfRepo?:          string
  downloadCheck?:   string
  hfSkipPrefixes?:  string[]
  hfIncludePrefixes?: string[]
  hasModelSources?: boolean
  weightGroups?:    string[]
  weightVariants?:  WeightVariantsInfo
}

export interface WeightVariantsInfo {
  param:   string   // params_schema id whose value selects the variant
  default: string
  options: { id: string; label: string; sizeGb?: number; vramGb?: number }[]
}

export interface SharedWeightGroup {
  id: string
  dependentNodeIds: string[]
}

export interface ProcessPort {
  name:     string
  type:     string
  required?: boolean
}

export interface NamedProcessInput {
  type:         string
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
  weightGroups?: SharedWeightGroup[]
  /** Folder exists but is not a loadable extension — see manifestError */
  corrupted?:   boolean
  /** Why the folder is corrupted: manifest gone, manifest unparseable, or install never completed */
  manifestError?: 'missing' | 'invalid' | 'incomplete'
}

export type PickerIntent = 'folder' | 'image' | 'mesh' | 'text'

export type WorkflowPickerIntent = PickerIntent | 'directory' | 'save-path' | 'generic-file'

export interface WorkflowParamFilter {
  name: string
  extensions: string[]
}

export interface WorkflowParamOption {
  value: number | string
  label: string
}

interface WorkflowParamSchemaBase {
  id: string
  label: string
  tooltip?: string
  show_if?: Record<string, boolean | number | string | (boolean | number | string)[]>
  // Kept on the common shape for existing picker/variant metadata consumers.
  pickerIntent?: WorkflowPickerIntent
  picker_intent?: WorkflowPickerIntent
  options?: WorkflowParamOption[]
}

export interface SelectParamSchema extends WorkflowParamSchemaBase {
  type: 'select'
  default: number | string
}

export interface IntParamSchema extends WorkflowParamSchemaBase {
  type: 'int'
  default: number
  min?: number
  max?: number
  step?: number
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
  filters?: WorkflowParamFilter[]
}

export interface FileSelectParamSchema extends WorkflowParamSchemaBase {
  type: 'file-select'
  default: string
  dir_from?: string
  extensions?: string[]
}

export interface BooleanParamSchema extends WorkflowParamSchemaBase {
  type: 'boolean'
  default: boolean
}

export interface UnsupportedParamSchema extends WorkflowParamSchemaBase {
  type: 'unsupported'
  // The runner consumes defaults independently of whether this UI can edit them.
  default: unknown
  reason: string
  rawType?: string
}

export type ParamSchema =
  | SelectParamSchema
  | IntParamSchema
  | FloatParamSchema
  | StringParamSchema
  | FileSelectParamSchema
  | BooleanParamSchema
  | UnsupportedParamSchema

export type RawParamSchema = ParamSchema | Record<string, unknown>

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
  input?: string
  inputs?: string[] | ProcessPort[]
  input_labels?: string[]
  output?: string
  param_defaults?: Record<string, unknown>
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
   * Read-only capability discovery owned by Electron main. Manifest presence does
   * not establish runtime readiness or support for UI-only/headless operations.
   */
  backend_ready: boolean
  models: AutomationModelCapability[]
  processes: AutomationProcessCapability[]
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
      slicer: {
        open: (url: string) => Promise<{ success: boolean; error?: string }>
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
      notifications: {
        show: (title: string, body: string) => Promise<{ success: boolean; error?: string }>
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
        getPathForFile:  (file: File) => string
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
      /** decrypt returns null when the stored blob can't be decrypted here. */
      secureStore: {
        encrypt: (plainText: string) => Promise<string>
        decrypt: (stored: string) => Promise<string | null>
      }
      agent: {
        /** Opens a file picker and copies the chosen .gguf into the agent's models folder. */
        addModel: () => Promise<{ success: boolean; cancelled?: boolean; fileName?: string; error?: string }>
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
      model: {
        export:         (args: { outputUrl: string; format: string }) => Promise<{ success: boolean; error?: string }>
        listDownloaded: () => Promise<{ id: string; name: string; size_gb: number }[]>
        activeDownloads: () => Promise<{ modelId: string; variantId?: string; percent: number; file?: string; fileIndex?: number; totalFiles?: number }[]>
        isDownloaded:   (modelId: string) => Promise<boolean>
        hasLocalData:    (modelId: string) => Promise<boolean>
        sharedGroups:    (extensionId: string) => Promise<SharedWeightGroupState[]>
        download:       (modelId: string, variantId?: string) => Promise<{ success: boolean; error?: string; paused?: boolean; cancelled?: boolean }>
        pauseDownload:  (modelId: string) => Promise<{ success: boolean; error?: string }>
        cancelDownload: (modelId: string) => Promise<{ success: boolean; error?: string }>
        delete:         (modelId: string) => Promise<{ success: boolean; error?: string }>
        deleteSharedGroup: (extensionId: string, groupId: string) => Promise<{ success: boolean; error?: string }>
        deleteExtensionWeights: (extensionId: string) => Promise<{ success: boolean; error?: string }>
        /** Installed variant ids, or null when the node's install state could not be read */
        installedWeightVariants: (modelId: string) => Promise<string[] | null>
        deleteWeightVariant: (modelId: string, variantId: string) => Promise<{ success: boolean; error?: string }>
        unloadAll:      () => Promise<{ success: boolean; error?: string }>
        showInFolder:   (modelId: string) => Promise<void>
        onProgress:     (cb: (data: {
          modelId: string
          variantId?: string
          percent: number
          file?: string
          fileIndex?: number
          totalFiles?: number
          status?: string
          bytesDownloaded?: number
          totalBytes?: number
          stalledSeconds?: number
          paused?: boolean
          cancelled?: boolean
        }) => void) => void
        offProgress:    () => void
        onWeightsChanged: (cb: () => void) => void
        offWeightsChanged: () => void
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
        installFromGitHub: (url: string) => Promise<{
          success:      boolean
          error?:       string
          cancelled?:   boolean
          extensionId?: string
          extension?:   AnyExtension
        }>
        installFromLocal:  () => Promise<{
          success:      boolean
          error?:       string
          cancelled?:   boolean
          needsRepair?: boolean
          extensionId?: string
          extension?:   AnyExtension
          localPath?:   string
        }>
        uninstall:   (extensionId: string) => Promise<{ success: boolean; error?: string }>
        repair:      (extensionId: string) => Promise<{ success: boolean; error?: string }>
        reload:      () => Promise<{ success: boolean; error?: string; errors?: Record<string, string> }>
        runProcess:  (extensionId: string, input: ProcessInput, params: Record<string, unknown>) => Promise<{ success: boolean; result?: ProcessResult; error?: string }>
        onInstallProgress: (cb: (data: {
          step:          'downloading' | 'extracting' | 'validating' | 'setting_up' | 'done' | 'error'
          percent?:      number
          extensionId?:  string
          message?:      string
        }) => void) => void
        offInstallProgress: () => void
      }
    }
  }
}

export interface SharedWeightGroupState {
  id: string
  targetId: string
  dependentModelIds: string[]
  downloaded: boolean
  hasLocalData: boolean
}

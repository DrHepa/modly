// Type declarations for the Electron API exposed via preload
import type { ArtifactRef, ArtifactSidecar } from './artifacts'
import type { AssetLibraryListResult, AssetLibraryOpenRequest, AssetLibraryOpenResult, AssetLibraryReadRequest, AssetLibraryReadResult } from './assetLibrary.ts'
import type { LandmarkSidecarV1 } from '../../areas/workflows/landmarks.ts'
import type { KimodoMotionArtifact } from '../../areas/generate/kimodoMotionAdapter.ts'
import type { MotionRetargetCorrectionIdentityV1, MotionRetargetCorrectionsV1, MotionRetargetSourceBone, MotionRetargetSessionSnapshot } from '../../areas/generate/motionRetargetPlan.ts'

export type {
  ArtifactKind,
  ArtifactLineage,
  ArtifactRef,
  ArtifactSidecar,
  ArtifactSubstitutionPoint,
  ArtifactSubstitution,
  ArtifactSubstitutionStatus,
  ArtifactVersion,
  ArtifactVersionRole,
  LegacyArtifactPayload,
} from './artifacts'

export type {
  AssetCapability,
  AssetEntryState,
  AssetLibraryEntry,
  AssetLibraryListRequest,
  AssetLibraryListResult,
  AssetLibraryOpenRequest,
  AssetLibraryOpenResult,
  AssetLibraryPreviewKind,
  AssetLibraryReadRequest,
  AssetLibraryReadResult,
} from './assetLibrary.ts'

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
  automation?:      CapabilityAutomationMetadata
}

export interface CapabilityPauseMetadata {
  supported: boolean
  checkpoint?: 'interactive'
}

export interface CapabilitySubstitutionMetadata {
  supported: boolean
  artifactKinds?: ('image' | 'text' | 'mesh')[]
  boundary?: 'ui_only' | 'electron'
  headless?: boolean
}

export interface CapabilityAutomationMetadata {
  boundary: 'electron' | 'ui_only'
  headless: boolean
  pause: CapabilityPauseMetadata
  substitution: CapabilitySubstitutionMetadata
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

export interface ParamUiHints {
  control?: string
  collapsed?: boolean
  order?: number
  help?: string
}

interface WorkflowParamSchemaBase {
  id:       string
  label:    string
  tooltip?: string
  advanced?: boolean
  group?:    string
  ui?:       ParamUiHints
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
  outputType?: 'image' | 'text' | 'mesh'
  artifact?: ArtifactRef
}

export interface ArtifactRegistryReadResult {
  success: boolean
  sidecar?: ArtifactSidecar
  error?: string
}

export interface ArtifactRegistryReadRequest {
  workspacePath: string
}

export interface ArtifactRegistryWriteRequest extends ArtifactRegistryReadRequest {
  artifactId: string
  metadata: Record<string, unknown>
}

export interface ArtifactRegistryWriteResult {
  success: boolean
  sidecar?: ArtifactSidecar
  sidecarPath?: string
  error?: string
}

export interface EditedSceneArtifactWriteRequest {
  glbWorkspacePath: string
  sidecarWorkspacePath: string
  sourceWorkspacePath: string
  bytes: Uint8Array | ArrayBuffer
  metadata: Record<string, unknown>
}

export interface LandmarkSidecarWriteRequest {
  sidecarWorkspacePath: string
  sourceWorkspacePath: string
  sidecar: LandmarkSidecarV1
}

export type PoseClipRigBoneId = string

export interface PoseClipVector3 {
  x: number
  y: number
  z: number
}

export interface PoseClipQuaternion extends PoseClipVector3 {
  w: number
}

export interface PoseClipMetadata {
  id: string
  name: string
  durationSeconds: number
  fps: number
}

export interface PoseClipSidecarV1 {
  schema: 'modly.pose-clip'
  version: 1
  createdAt: string
  source: {
    workspacePath: string
    artifactId?: string
    versionId?: string
  }
  skeletonContextId: string
  clip: PoseClipMetadata
  skeleton: {
    rootBoneIds: PoseClipRigBoneId[]
    boneCount: number
    bones: Array<{
      boneId: PoseClipRigBoneId
      label: string
      originalName: string
      path: string[]
    }>
  }
  keyframes: Array<{
    id: string
    timeSeconds: number
    boneId: PoseClipRigBoneId
    rotation: PoseClipQuaternion
    translation?: PoseClipVector3
    scale?: PoseClipVector3
  }>
}

export interface PoseClipSidecarWriteRequest {
  sidecarWorkspacePath: string
  sourceWorkspacePath: string
  sidecar: PoseClipSidecarV1
}

export interface PoseClipSidecarReadRequest {
  sidecarWorkspacePath: string
  legacySidecarWorkspacePath?: string
  sourceWorkspacePath: string
}

export interface MotionRetargetSidecarV1 {
  schema: 'modly.motion-retarget'
  version: 1
  createdAt: string
  source: {
    workspacePath: string
    artifactId?: string
    versionId?: string
  }
  identity?: MotionRetargetCorrectionIdentityV1
  artifact: KimodoMotionArtifact
  sourceBones: MotionRetargetSourceBone[]
  session: MotionRetargetSessionSnapshot
  corrections?: MotionRetargetCorrectionsV1
  warnings: string[]
  poseClip?: PoseClipMetadata
}

export interface MotionRetargetSidecarWriteRequest {
  sidecarWorkspacePath: string
  sourceWorkspacePath: string
  sidecar: MotionRetargetSidecarV1
}

export interface MotionRetargetSidecarReadRequest {
  sidecarWorkspacePath: string
  sourceWorkspacePath: string
}

export interface HumanoidSidecarArtifactRef {
  workspacePath: string
}

export interface HumanoidDraftSidecarV1 {
  schema: 'modly.humanoid-draft.v1'
  version: 1
  source: HumanoidSidecarArtifactRef
  output: HumanoidSidecarArtifactRef
  meshOutputSha256: string
  rigmetaSha256: string
  draftSha256: string
  trust: {
    status: 'draft'
    reasons: string[]
    trusted?: false
  }
  provenance: {
    producer: string
    runId?: string
    extensionId?: string
    createdAt: string
  }
  assignments: {
    roles: Record<string, unknown>
    chains: Record<string, unknown>
  }
  confidence: {
    byRole?: Record<string, unknown>
    overall: number
  }
  completeness: {
    requiredRolesMissing: string[]
    score: number
  }
  diagnostics: string[]
}

export type HumanoidPromotionMethod = 'viewer3d' | 'workflow-wait' | 'add-to-scene' | 'import'

export interface HumanoidPromotionSidecarV1 {
  schema: 'modly.humanoid-promotion.v1'
  version: 1
  promotionId: string
  supersedesPromotionId?: string
  source: HumanoidSidecarArtifactRef
  output: HumanoidSidecarArtifactRef
  meshOutputSha256: string
  rigmetaSha256: string
  draftSha256: string
  draftSchema: 'modly.humanoid-draft.v1'
  promotedAssignments: {
    roles: Record<string, unknown>
    chains: Record<string, unknown>
  }
  provenance: {
    basis: 'modly.humanoid-draft.v1'
    trustStatus: 'manual_confirmed'
  }
  audit: {
    confirmedBy: string
    confirmedByLabel?: string
    createdAt: string
    method: HumanoidPromotionMethod
    rationale: string
  }
}

export interface HumanoidDraftSidecarReadRequest {
  meshWorkspacePath: string
}

export interface HumanoidPromotionSidecarWriteRequest {
  meshWorkspacePath: string
  sidecar: HumanoidPromotionSidecarV1
}

export interface HumanoidPromotionSidecarReadRequest {
  meshWorkspacePath: string
}

export type HumanoidDraftSidecarReadResult =
  | {
      success: true
      status: 'found'
      sidecarWorkspacePath: string
      sidecar: HumanoidDraftSidecarV1
    }
  | {
      success: true
      status: 'not-found'
      sidecarWorkspacePath: string
    }
  | {
      success: true
      status: 'stale'
      sidecarWorkspacePath: string
      sidecar: HumanoidDraftSidecarV1
      staleReasons: string[]
    }
  | {
      success: false
      status: 'invalid' | 'error'
      sidecarWorkspacePath?: string
      error: string
    }

export type HumanoidPromotionSidecarWriteResult =
  | {
      success: true
      sidecarWorkspacePath: string
      sidecar: HumanoidPromotionSidecarV1
    }
  | {
      success: false
      error: string
    }

export type HumanoidPromotionSidecarReadResult =
  | {
      success: true
      status: 'found'
      sidecarWorkspacePath: string
      sidecar: HumanoidPromotionSidecarV1
    }
  | {
      success: true
      status: 'not-found'
      sidecarWorkspacePath: string
    }
  | {
      success: true
      status: 'stale'
      sidecarWorkspacePath: string
      sidecar: HumanoidPromotionSidecarV1
      staleReasons: string[]
    }
  | {
      success: false
      status: 'invalid' | 'error'
      sidecarWorkspacePath?: string
      error: string
    }

export interface WorkspaceArtifactPreviewRequest {
  workspacePath: string
}

export type WorkspaceArtifactPreviewResult =
  | {
      success: true
      status: 'text'
      workspacePath: string
      displayName: string
      content: string
      byteLength: number
      truncated: boolean
    }
  | {
      success: true
      status: 'binary'
      workspacePath: string
      displayName: string
      byteLength: number
      binaryKind: string
      message: string
    }
  | {
      success: true
      status: '3d-model'
      workspacePath: string
      displayName: string
      viewerKind: 'glb' | 'gltf'
    }
  | {
      success: false
      error: string
    }

export interface WorkspaceArtifactDownloadRequest {
  workspacePath: string
  suggestedName?: string
}

export type WorkspaceArtifactDownloadResult =
  | {
      success: true
      status: 'saved'
      workspacePath: string
      targetPath: string
    }
  | {
      success: true
      status: 'cancelled'
      workspacePath: string
    }
  | {
      success: false
      error: string
    }

export interface RigRenameSidecarV1 {
  schema: 'modly.rig.rename-plan'
  version: 1
  createdAt: string
  source: {
    workspacePath: string
    artifactId?: string
    versionId?: string
  }
  skeletonContextId: string
  skeleton: {
    rootBoneIds: string[]
    boneCount: number
    bones: Array<{
      boneId: string
      oldLabel: string
      originalName: string
      path: string[]
    }>
  }
  aliases: Record<string, { oldLabel: string; alias: string }>
}

export interface RigRenameSidecarWriteRequest {
  sidecarWorkspacePath: string
  sourceWorkspacePath: string
  sidecar: RigRenameSidecarV1
}

export interface RigRenameSidecarReadRequest {
  sidecarWorkspacePath: string
  sourceWorkspacePath: string
}

export interface RigMetaSidecarReadRequest {
  sourceWorkspacePath: string
}

export type RigMetaNamingSource = 'semantic_candidates' | 'humanoid_contract' | 'humanoid_draft' | 'humanoid_promotion'

export interface RigMetaNamingEntry {
  label: string
  source: RigMetaNamingSource
}

export type RigMetaNamingMap = Record<string, RigMetaNamingEntry>

export type LandmarkSidecarWriteResult =
  | {
      success: true
      sidecarWorkspacePath: string
      sidecar: LandmarkSidecarV1
    }
  | {
      success: false
      error: string
    }

export type PoseClipSidecarWriteResult =
  | {
      success: true
      sidecarWorkspacePath: string
      sidecar: PoseClipSidecarV1
    }
  | {
      success: false
      error: string
    }

export type PoseClipSidecarReadResult =
  | {
      success: true
      status: 'found'
      sidecarWorkspacePath: string
      sidecar: PoseClipSidecarV1
    }
  | {
      success: true
      status: 'not-found'
      sidecarWorkspacePath: string
    }
  | {
      success: false
      status: 'invalid' | 'error'
      sidecarWorkspacePath?: string
      error: string
    }

export type MotionRetargetSidecarWriteResult =
  | {
      success: true
      sidecarWorkspacePath: string
      sidecar: MotionRetargetSidecarV1
    }
  | {
      success: false
      error: string
    }

export type MotionRetargetSidecarReadResult =
  | {
      success: true
      status: 'found'
      sidecarWorkspacePath: string
      sidecar: MotionRetargetSidecarV1
    }
  | {
      success: true
      status: 'not-found'
      sidecarWorkspacePath: string
    }
  | {
      success: false
      status: 'invalid' | 'error'
      sidecarWorkspacePath?: string
      error: string
    }

export type RigRenameSidecarWriteResult =
  | {
      success: true
      sidecarWorkspacePath: string
      sidecar: RigRenameSidecarV1
    }
  | {
      success: false
      error: string
    }

export type RigRenameSidecarReadResult =
  | {
      success: true
      status: 'found'
      sidecarWorkspacePath: string
      sidecar: RigRenameSidecarV1
    }
  | {
      success: true
      status: 'not-found'
      sidecarWorkspacePath: string
    }
  | {
      success: false
      status: 'invalid' | 'error'
      error: string
    }

export type RigMetaSidecarReadResult =
  | {
      success: true
      status: 'found'
      rigMetaWorkspacePath: string
      rigMeta: unknown
      namingByBoneId: RigMetaNamingMap
      warnings: string[]
    }
  | {
      success: true
      status: 'not-found'
      rigMetaWorkspacePath: string
    }
  | {
      success: false
      status: 'invalid'
      rigMetaWorkspacePath?: string
      message: string
    }

export type EditedSceneArtifactWriteResult =
  | {
      success: true
      glbWorkspacePath: string
      sidecarWorkspacePath: string
      metadata: Record<string, unknown>
    }
  | {
      success: false
      error: string
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
  automation?: CapabilityAutomationMetadata
  ready?: boolean | null
}

export interface AutomationUiOnlyCapability {
  kind: 'ui_only'
  source: 'ui-only'
  id: string
  type?: string
  label: string
  reason: string
  automation?: CapabilityAutomationMetadata
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
        artifacts: {
          writeSidecar: (request: ArtifactRegistryWriteRequest) => Promise<ArtifactRegistryWriteResult>
          readSidecar: (request: ArtifactRegistryReadRequest) => Promise<ArtifactRegistryReadResult>
          writeEditedSceneArtifact: (request: EditedSceneArtifactWriteRequest) => Promise<EditedSceneArtifactWriteResult>
          writeLandmarkSidecar: (request: LandmarkSidecarWriteRequest) => Promise<LandmarkSidecarWriteResult>
          readHumanoidDraftSidecar: (request: HumanoidDraftSidecarReadRequest) => Promise<HumanoidDraftSidecarReadResult>
          writeHumanoidPromotionSidecar: (request: HumanoidPromotionSidecarWriteRequest) => Promise<HumanoidPromotionSidecarWriteResult>
          readHumanoidPromotionSidecar: (request: HumanoidPromotionSidecarReadRequest) => Promise<HumanoidPromotionSidecarReadResult>
          writeMotionRetargetSidecar: (request: MotionRetargetSidecarWriteRequest) => Promise<MotionRetargetSidecarWriteResult>
          readMotionRetargetSidecar: (request: MotionRetargetSidecarReadRequest) => Promise<MotionRetargetSidecarReadResult>
          previewWorkspaceArtifact: (request: WorkspaceArtifactPreviewRequest) => Promise<WorkspaceArtifactPreviewResult>
          downloadWorkspaceArtifact: (request: WorkspaceArtifactDownloadRequest) => Promise<WorkspaceArtifactDownloadResult>
          writePoseClipSidecar: (request: PoseClipSidecarWriteRequest) => Promise<PoseClipSidecarWriteResult>
          readPoseClipSidecar: (request: PoseClipSidecarReadRequest) => Promise<PoseClipSidecarReadResult>
          writeRigRenameSidecar: (request: RigRenameSidecarWriteRequest) => Promise<RigRenameSidecarWriteResult>
          readRigRenameSidecar: (request: RigRenameSidecarReadRequest) => Promise<RigRenameSidecarReadResult>
          readRigMetaSidecar: (request: RigMetaSidecarReadRequest) => Promise<RigMetaSidecarReadResult>
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

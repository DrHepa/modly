import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, relative, resolve as resolvePath } from 'node:path'

import type { ArtifactRegistryReadResult, ArtifactRegistryWriteResult, ArtifactSidecar, EditedSceneArtifactWriteRequest, EditedSceneArtifactWriteResult, HumanoidDraftSidecarReadResult, HumanoidDraftSidecarV1, HumanoidPromotionSidecarReadResult, HumanoidPromotionSidecarV1, HumanoidPromotionSidecarWriteRequest, HumanoidPromotionSidecarWriteResult, LandmarkSidecarWriteRequest, LandmarkSidecarWriteResult, MotionRetargetSidecarReadResult, MotionRetargetSidecarV1, MotionRetargetSidecarWriteRequest, MotionRetargetSidecarWriteResult, RigMetaSidecarReadResult, RigRenameSidecarV1, RigRenameSidecarWriteRequest, RigRenameSidecarWriteResult, WorkspaceArtifactPreviewRequest, WorkspaceArtifactPreviewResult, WorkspaceArtifactDownloadResult } from '../../src/shared/types/electron.d'
import type { ArtifactKind } from '../../src/shared/types/artifacts.ts'
import type { AssetCapability, AssetEntryState, AssetLibraryEntry, AssetLibraryListResult, AssetLibraryManifestCapability, AssetLibraryManifestRef, AssetLibraryOpenResult, AssetLibraryPreviewKind, AssetLibraryPreviewPayload, AssetLibraryReadResult, AssetLibrarySourceLink, AssetLibrarySourceScope } from '../../src/shared/types/assetLibrary.ts'

const SIDECAR_SUFFIX = '.artifact.json'
const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/
const LANDMARK_SIDECAR_PREFIX = 'Workflows/landmarks/'
const LANDMARK_SIDECAR_SUFFIX = '.landmarks.v1.json'
const RIG_RENAME_SIDECAR_PREFIX = 'Workflows/rig-edits/'
const RIG_RENAME_SIDECAR_SUFFIX = '.rig.v1.json'
const MOTION_RETARGET_SIDECAR_PREFIX = 'Workflows/motion-retarget/'
const MOTION_RETARGET_SIDECAR_SUFFIX = '.motion-retarget.v1.json'
const POSE_CLIP_SIDECAR_PREFIX = 'Workflows/pose-clips/'
const POSE_CLIP_SIDECAR_SUFFIX = '.pose-clip.v1.json'
const RIGMETA_MESH_EXTENSION_PATTERN = /\.(glb|gltf)$/i
const HUMANOID_DRAFT_SCHEMA = 'modly.humanoid-draft.v1'
const HUMANOID_PROMOTION_SCHEMA = 'modly.humanoid-promotion.v1'
const HUMANOID_DRAFT_SIDECAR_SUFFIX = '.humanoid-draft.v1.json'
const HUMANOID_PROMOTION_SIDECAR_SUFFIX = '.humanoid-promotion.v1.json'
const HUMANOID_PROMOTION_CONFIRMED_BY_PATTERN = /^modly:user:[a-z0-9._-]+:[A-Za-z0-9._-]+$/
const HUMANOID_PROMOTION_METHODS = new Set(['viewer3d', 'workflow-wait', 'add-to-scene', 'import'])
const SUPPORTED_RIGMETA_SCHEMA_VALUES = new Set([
  'modly.rigmeta',
  'modly.unirig.rigmeta',
  'unirig.rigmeta',
])
const REQUIRED_LANDMARK_IDS = ['left_shoulder', 'right_shoulder', 'hip', 'left_knee', 'right_knee'] as const
const REQUIRED_LANDMARK_ID_SET = new Set<string>(REQUIRED_LANDMARK_IDS)
const ENCODED_WORKSPACE_ESCAPE_PATTERN = /%2e|%2f|%5c/i
const ASSET_LIBRARY_INTERNAL_SUFFIXES = [SIDECAR_SUFFIX, '.rigmeta.json', HUMANOID_DRAFT_SIDECAR_SUFFIX, HUMANOID_PROMOTION_SIDECAR_SUFFIX] as const
const ASSET_LIBRARY_SCOPED_ROOTS = ['Workflows', 'Exports'] as const
const ASSET_LIBRARY_MESH_EXTENSIONS = new Set(['glb', 'gltf', 'obj', 'stl', 'ply'])
const ASSET_LIBRARY_INTERNAL_DIRECTORY_NAMES = new Set(['tmp', 'temp', 'cache'])
const ASSET_LIBRARY_MANIFEST_SCHEMA_CAPABILITIES: Record<string, AssetLibraryManifestCapability> = {
  'modly.generated-world.v1': 'generated-world',
  'modly.scene-manifest.v1': 'scene-manifest',
}

export interface AssetLibraryClassificationCandidate {
  workspacePath: string
  artifactKind?: ArtifactKind
  previewKind?: AssetLibraryPreviewKind
  evidence?: {
    rigMeta?: boolean
    humanoidDraft?: boolean
    humanoidPromotion?: boolean
    motionRetargetSidecar?: boolean
    poseClipSidecar?: boolean
    landmarkSidecar?: boolean
    manifestCapability?: AssetLibraryManifestCapability
    embeddedSkins?: boolean
    embeddedAnimations?: boolean
    intrinsicMotionFile?: boolean
  }
}

export interface AssetLibraryClassification {
  capability?: AssetCapability
  state: AssetEntryState
}

export interface NormalizeAssetLibraryReadRequestInput {
  workspaceDir: string
  workspacePath: string
  sourceWorkspacePath?: string
  indexedSourceWorkspacePath?: string
}

export interface NormalizedWorkspaceArtifactPath {
  workspacePath: string
  absolutePath: string
}

export interface ArtifactRegistryReadRequest {
  workspaceDir: string
  workspacePath: string
}

export interface WorkspaceAssetLibraryListServiceRequest {
  workspaceDir: string
}

export interface WorkspaceAssetLibraryReadServiceRequest {
  workspaceDir: string
  workspacePath: string
  sourceWorkspacePath?: string
}

export interface ArtifactRegistryWriteRequest extends ArtifactRegistryReadRequest {
  artifactId: string
  metadata: Record<string, unknown>
}

export interface EditedSceneArtifactWriteServiceRequest extends EditedSceneArtifactWriteRequest {
  workspaceDir: string
}

export interface LandmarkSidecarWriteServiceRequest extends Omit<LandmarkSidecarWriteRequest, 'sidecar'> {
  workspaceDir: string
  sidecar: unknown
}

export interface RigRenameSidecarWriteServiceRequest extends Omit<RigRenameSidecarWriteRequest, 'sidecar'> {
  workspaceDir: string
  sidecar: unknown
}

export interface RigRenameSidecarReadServiceRequest {
  workspaceDir: string
  sidecarWorkspacePath: string
  sourceWorkspacePath: string
}

export interface PoseClipSidecarWriteServiceRequest {
  workspaceDir: string
  sidecarWorkspacePath: string
  sourceWorkspacePath: string
  sidecar: unknown
}

export interface PoseClipSidecarReadServiceRequest {
  workspaceDir: string
  sidecarWorkspacePath: string
  legacySidecarWorkspacePath?: string
  sourceWorkspacePath: string
}

export interface MotionRetargetSidecarWriteServiceRequest extends Omit<MotionRetargetSidecarWriteRequest, 'sidecar'> {
  workspaceDir: string
  sidecar: unknown
}

export interface MotionRetargetSidecarReadServiceRequest {
  workspaceDir: string
  sidecarWorkspacePath: string
  sourceWorkspacePath: string
}

export interface RigMetaSidecarReadServiceRequest {
  workspaceDir: string
  sourceWorkspacePath: string
}

export interface HumanoidDraftSidecarReadServiceRequest {
  workspaceDir: string
  meshWorkspacePath: string
}

export interface HumanoidPromotionSidecarWriteServiceRequest extends Omit<HumanoidPromotionSidecarWriteRequest, 'sidecar'> {
  workspaceDir: string
  sidecar: unknown
}

export interface HumanoidPromotionSidecarReadServiceRequest {
  workspaceDir: string
  meshWorkspacePath: string
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

export type PoseClipSidecarReadResult =
  | {
      success: true
      status: 'found'
      sidecarWorkspacePath: string
      sidecar: unknown
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

export type PoseClipSidecarWriteResult =
  | {
      success: true
      sidecarWorkspacePath: string
      sidecar: unknown
    }
  | {
      success: false
      error: string
    }

export type LocalMotionRetargetSidecarReadResult = MotionRetargetSidecarReadResult

export type LocalMotionRetargetSidecarWriteResult = MotionRetargetSidecarWriteResult

export interface ArtifactRegistryIpcMainLike {
  handle(channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>): void
}

export interface ArtifactRegistryIpcRegistrationDeps {
  ipcMain: ArtifactRegistryIpcMainLike
  getWorkspaceDir: () => string
  showSaveDialog?: (options: { defaultPath?: string, title?: string }) => Promise<{ canceled: boolean, filePath?: string }>
}

export interface WorkspaceArtifactPreviewServiceRequest extends WorkspaceArtifactPreviewRequest {
  workspaceDir: string
  maxBytes?: number
}

export interface WorkspaceArtifactDownloadServiceRequest {
  workspaceDir: string
  workspacePath: string
  suggestedName?: string
  showSaveDialog: (options: { defaultPath?: string, title?: string }) => Promise<{ canceled: boolean, filePath?: string }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWindowsAbsolutePath(candidate: string): boolean {
  return WINDOWS_ABSOLUTE_PATH.test(candidate) || candidate.startsWith('\\\\')
}

function normalizeWorkspaceSeparators(workspacePath: string): string {
  return workspacePath.replace(/\\/g, '/')
}

function assertSafeWorkspacePathInput(workspacePath: string): string {
  const normalized = normalizeWorkspaceSeparators(workspacePath.trim())
  if (!normalized || normalized === '.') {
    throw new Error('Artifact workspace path must be workspace-relative and non-empty')
  }
  if (ENCODED_WORKSPACE_ESCAPE_PATTERN.test(normalized)) {
    throw new Error('Artifact workspace path must not contain encoded path escapes')
  }
  if (isAbsolute(normalized) || isWindowsAbsolutePath(workspacePath)) {
    throw new Error('Artifact workspace path must not be absolute')
  }
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '..')) {
    throw new Error('Artifact workspace path must not contain traversal segments')
  }
  return segments.filter((segment) => segment !== '' && segment !== '.').join('/')
}

export function classifyAssetLibraryCandidate(candidate: AssetLibraryClassificationCandidate): AssetLibraryClassification {
  const evidence = candidate.evidence ?? {}
  const meshCandidate = isSupportedAssetLibraryMeshPath(candidate.workspacePath)

  if (evidence.manifestCapability) {
    return { capability: evidence.manifestCapability, state: 'ready' }
  }

  if (evidence.landmarkSidecar) {
    return { capability: 'landmarks-sidecar', state: 'ready' }
  }

  if (evidence.motionRetargetSidecar || evidence.poseClipSidecar) {
    return { capability: 'animation-motion', state: 'ready' }
  }

  if (evidence.intrinsicMotionFile) {
    return { capability: 'animation-motion', state: 'ready' }
  }

  if (candidate.artifactKind === 'mesh' || meshCandidate) {
    if (evidence.rigMeta || evidence.humanoidDraft || evidence.humanoidPromotion) {
      return { capability: 'rigged-mesh', state: 'ready' }
    }
    if (evidence.embeddedAnimations) {
      return { capability: 'animation-motion', state: 'ready' }
    }
    if (evidence.embeddedSkins) {
      return { capability: 'rigged-mesh', state: 'ready' }
    }
    return { capability: 'mesh', state: 'ready' }
  }

  if (candidate.previewKind === '3d-model' || candidate.previewKind === 'none') {
    return { capability: undefined, state: 'unknown-metadata' }
  }

  return { capability: undefined, state: 'unsupported' }
}

export function normalizeAssetLibraryReadRequest(input: NormalizeAssetLibraryReadRequestInput): { workspacePath: string, sourceWorkspacePath?: string } {
  const workspacePath = normalizeWorkspaceArtifactPath(input.workspaceDir, input.workspacePath).workspacePath
  const sourceWorkspacePath = input.sourceWorkspacePath
    ? normalizeWorkspaceArtifactPath(input.workspaceDir, input.sourceWorkspacePath).workspacePath
    : undefined
  const indexedSourceWorkspacePath = input.indexedSourceWorkspacePath
    ? normalizeWorkspaceArtifactPath(input.workspaceDir, input.indexedSourceWorkspacePath).workspacePath
    : undefined

  if (sourceWorkspacePath && indexedSourceWorkspacePath && sourceWorkspacePath !== indexedSourceWorkspacePath) {
    throw new Error('Asset library source link does not match the indexed source workspace path')
  }

  if (sourceWorkspacePath && sourceWorkspacePath === workspacePath) {
    throw new Error('Asset library source link must not point at the entry workspace path')
  }

  return {
    workspacePath,
    ...(sourceWorkspacePath ? { sourceWorkspacePath } : {}),
  }
}

function shouldSkipWorkspaceAssetLibraryPath(workspacePath: string): boolean {
  return hasInternalWorkspaceAssetLibraryDirectory(workspacePath)
    || ASSET_LIBRARY_INTERNAL_SUFFIXES.some((suffix) => workspacePath.endsWith(suffix))
}

function deriveAssetLibrarySourceScope(workspacePath: string): AssetLibrarySourceScope {
  return normalizeWorkspaceSeparators(workspacePath).startsWith('Exports/') ? 'exports' : 'workflows'
}

function isInternalWorkspaceAssetLibraryDirectoryName(segment: string): boolean {
  const normalizedSegment = segment.trim().toLocaleLowerCase()
  return normalizedSegment.startsWith('.') || ASSET_LIBRARY_INTERNAL_DIRECTORY_NAMES.has(normalizedSegment)
}

function hasInternalWorkspaceAssetLibraryDirectory(workspacePath: string): boolean {
  const segments = normalizeWorkspaceSeparators(workspacePath).split('/').filter(Boolean)
  return segments.slice(1, -1).some(isInternalWorkspaceAssetLibraryDirectoryName)
}

function isSupportedAssetLibraryMeshPath(workspacePath: string): boolean {
  return ASSET_LIBRARY_MESH_EXTENSIONS.has(resolveWorkspaceArtifactExtension(workspacePath))
}

function resolveAssetLibraryPreviewKind(workspacePath: string): AssetLibraryPreviewKind {
  const extension = resolveWorkspaceArtifactExtension(workspacePath)
  if (extension === 'glb' || extension === 'gltf') return '3d-model'
  if (isWorkspaceArtifactTextPreviewExtension(extension)) return 'text'
  return extension ? 'binary' : 'none'
}

function isArtifactKind(value: unknown): value is ArtifactKind {
  return value === 'image' || value === 'text' || value === 'mesh'
}

function isAssetLibraryManifestCapability(value: unknown): value is AssetLibraryManifestCapability {
  return value === 'generated-world' || value === 'scene-manifest'
}

async function listWorkspaceFilePaths(workspaceDir: string): Promise<string[]> {
  const root = resolvePath(workspaceDir)
  const results: string[] = []

  for (const scopedRoot of ASSET_LIBRARY_SCOPED_ROOTS) {
    const scopedRootPaths = await listWorkspaceFilePathsWithinRoot(root, scopedRoot)
    results.push(...scopedRootPaths)
  }

  return results.sort((left, right) => left.localeCompare(right))
}

async function listWorkspaceFilePathsWithinRoot(workspaceRoot: string, scopedRoot: string): Promise<string[]> {
  const results: string[] = []
  const pending = [scopedRoot]

  while (pending.length > 0) {
    const relativeDir = pending.pop() ?? scopedRoot
    const absoluteDir = resolvePath(workspaceRoot, ...relativeDir.split('/'))
    const entries = await readWorkspaceDirectoryEntries(absoluteDir)
    if (!entries) continue

    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (isInternalWorkspaceAssetLibraryDirectoryName(entry.name)) {
          continue
        }
        pending.push(relativePath)
        continue
      }
      if (entry.isFile()) {
        results.push(normalizeWorkspaceSeparators(relativePath))
      }
    }
  }

  return results
}

async function readWorkspaceDirectoryEntries(absoluteDir: string) {
  try {
    return await readdir(absoluteDir, { withFileTypes: true })
  } catch (error) {
    if (isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null
    throw error
  }
}

async function readJsonRecordIfPresent(absolutePath: string): Promise<{ status: 'found', value: unknown } | { status: 'not-found' } | { status: 'invalid', error: string }> {
  try {
    return { status: 'found', value: JSON.parse(await readFile(absolutePath, 'utf-8')) }
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return { status: 'not-found' }
    if (error instanceof SyntaxError) return { status: 'invalid', error: error.message }
    throw error
  }
}

interface IntrinsicAssetLibraryEvidence {
  embeddedSkins: boolean
  embeddedAnimations: boolean
  intrinsicMotionFile: boolean
  warnings: string[]
}

async function readIntrinsicAssetLibraryEvidence(workspaceDir: string, workspacePath: string, previewKind: AssetLibraryPreviewKind): Promise<IntrinsicAssetLibraryEvidence> {
  const extension = resolveWorkspaceArtifactExtension(workspacePath)

  if (extension === 'bvh' || extension === 'npz') {
    return {
      embeddedSkins: false,
      embeddedAnimations: false,
      intrinsicMotionFile: true,
      warnings: [],
    }
  }

  if (previewKind !== '3d-model') {
    return {
      embeddedSkins: false,
      embeddedAnimations: false,
      intrinsicMotionFile: false,
      warnings: [],
    }
  }

  try {
    const absolutePath = normalizeWorkspaceArtifactPath(workspaceDir, workspacePath).absolutePath
    const parsed = extension === 'gltf'
      ? JSON.parse(await readFile(absolutePath, 'utf-8'))
      : extension === 'glb'
        ? parseGlbJsonChunk(await readFile(absolutePath))
        : null

    if (!isRecord(parsed)) {
      return {
        embeddedSkins: false,
        embeddedAnimations: false,
        intrinsicMotionFile: false,
        warnings: [],
      }
    }

    return {
      embeddedSkins: Array.isArray(parsed.skins) && parsed.skins.length > 0,
      embeddedAnimations: Array.isArray(parsed.animations) && parsed.animations.length > 0,
      intrinsicMotionFile: false,
      warnings: [],
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      embeddedSkins: false,
      embeddedAnimations: false,
      intrinsicMotionFile: false,
      warnings: isSupportedAssetLibraryMeshPath(workspacePath)
        ? [`Failed to inspect intrinsic GLB/GLTF evidence for ${workspacePath}: ${message}`]
        : [],
    }
  }
}

function parseGlbJsonChunk(buffer: Buffer): unknown {
  if (buffer.length < 20) {
    throw new Error('GLB file is too small to contain a JSON chunk')
  }

  if (buffer.readUInt32LE(0) !== 0x46546c67) {
    throw new Error('Invalid GLB magic header')
  }

  const version = buffer.readUInt32LE(4)
  if (version !== 2) {
    throw new Error(`Unsupported GLB version ${version}`)
  }

  const declaredLength = buffer.readUInt32LE(8)
  if (declaredLength > buffer.length) {
    throw new Error('GLB declared length exceeds file size')
  }

  const chunkLength = buffer.readUInt32LE(12)
  const chunkType = buffer.readUInt32LE(16)
  if (chunkType !== 0x4e4f534a) {
    throw new Error('First GLB chunk is not JSON')
  }

  const chunkStart = 20
  const chunkEnd = chunkStart + chunkLength
  if (chunkEnd > buffer.length) {
    throw new Error('GLB JSON chunk exceeds file size')
  }

  const jsonText = buffer.subarray(chunkStart, chunkEnd).toString('utf-8').replace(/\0+$/u, '').trimEnd()
  if (!jsonText) {
    throw new Error('GLB JSON chunk is empty')
  }

  return JSON.parse(jsonText)
}

function extractAssetLibraryMetadataRecord(sidecar: ArtifactSidecar | undefined): Record<string, unknown> | undefined {
  return sidecar && isRecord(sidecar.metadata) ? sidecar.metadata : undefined
}

function extractAssetLibraryArtifactKind(metadata: Record<string, unknown> | undefined): ArtifactKind | undefined {
  if (!metadata) return undefined
  if (isArtifactKind(metadata.artifactKind)) return metadata.artifactKind
  if (isArtifactKind(metadata.kind)) return metadata.kind
  if (isRecord(metadata.artifact) && isArtifactKind(metadata.artifact.kind)) return metadata.artifact.kind
  return undefined
}

function extractAssetLibraryVersionId(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return undefined
  if (isNonEmptyString(metadata.versionId)) return metadata.versionId
  if (isRecord(metadata.artifact) && isNonEmptyString(metadata.artifact.versionId)) return metadata.artifact.versionId
  return undefined
}

function extractAssetLibraryProvenance(metadata: Record<string, unknown> | undefined): AssetLibraryEntry['provenance'] | undefined {
  if (!metadata) return undefined
  const provenance = isRecord(metadata.provenance)
    ? metadata.provenance
    : isRecord(metadata.artifact) && isRecord(metadata.artifact.provenance)
      ? metadata.artifact.provenance
      : undefined
  if (!provenance || !isNonEmptyString(provenance.workflowId) || !isNonEmptyString(provenance.workflowNodeId)) return undefined
  return {
    workflowId: provenance.workflowId,
    workflowNodeId: provenance.workflowNodeId,
    ...(isNonEmptyString(provenance.extensionId) ? { extensionId: provenance.extensionId } : {}),
    ...(isNonEmptyString(provenance.extensionNodeId) ? { extensionNodeId: provenance.extensionNodeId } : {}),
  }
}

function extractAssetLibraryDisplayName(metadata: Record<string, unknown> | undefined, workspacePath: string): string {
  if (metadata) {
    if (isNonEmptyString(metadata.displayName)) return metadata.displayName
    if (isNonEmptyString(metadata.title)) return metadata.title
    if (isNonEmptyString(metadata.label)) return metadata.label
    if (isRecord(metadata.assetLibrary)) {
      if (isNonEmptyString(metadata.assetLibrary.title)) return metadata.assetLibrary.title
      if (isNonEmptyString(metadata.assetLibrary.displayName)) return metadata.assetLibrary.displayName
    }
  }
  return basename(workspacePath)
}

function extractAssetLibraryWarnings(metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) return []
  const warnings = metadata.warnings
  return isStringArray(warnings) ? warnings : []
}

function extractAssetLibraryMetadataSource(metadata: Record<string, unknown> | undefined): AssetLibrarySourceLink | undefined {
  if (!metadata || !isRecord(metadata.source)) return undefined
  const source = metadata.source
  if (!isWorkspaceRelativeString(source.workspacePath) && !isNonEmptyString(source.assetId) && !isNonEmptyString(source.versionId)) return undefined
  return {
    relation: 'derived-from',
    ...(isWorkspaceRelativeString(source.workspacePath) ? { workspacePath: source.workspacePath } : {}),
    ...(isNonEmptyString(source.assetId) ? { assetId: source.assetId } : {}),
    ...(isNonEmptyString(source.versionId) ? { versionId: source.versionId } : {}),
    ...(!isWorkspaceRelativeString(source.workspacePath) ? { degraded: true } : {}),
  }
}

function extractManifestRefFromMetadata(metadata: Record<string, unknown> | undefined, workspacePath: string): AssetLibraryManifestRef | undefined {
  if (!metadata || !isRecord(metadata.assetLibrary) || !isAssetLibraryManifestCapability(metadata.assetLibrary.capability)) return undefined
  return {
    capability: metadata.assetLibrary.capability,
    workspacePath,
    ...(isNonEmptyString(metadata.assetLibrary.schema) ? { schema: metadata.assetLibrary.schema } : {}),
    ...(isNonEmptyString(metadata.assetLibrary.title) ? { title: metadata.assetLibrary.title } : {}),
  }
}

function extractManifestRefFromRecord(record: unknown, workspacePath: string): AssetLibraryManifestRef | undefined {
  if (!isRecord(record)) return undefined
  if (isRecord(record.assetLibrary) && isAssetLibraryManifestCapability(record.assetLibrary.capability)) {
    return {
      capability: record.assetLibrary.capability,
      workspacePath,
      ...(isNonEmptyString(record.assetLibrary.schema) ? { schema: record.assetLibrary.schema } : {}),
      ...(isNonEmptyString(record.assetLibrary.title) ? { title: record.assetLibrary.title } : {}),
    }
  }
  if (isAssetLibraryManifestCapability(record.capability)) {
    return {
      capability: record.capability,
      workspacePath,
      ...(isNonEmptyString(record.schema) ? { schema: record.schema } : {}),
      ...(isNonEmptyString(record.title) ? { title: record.title } : {}),
    }
  }
  if (isNonEmptyString(record.schema)) {
    const capability = ASSET_LIBRARY_MANIFEST_SCHEMA_CAPABILITIES[record.schema]
    if (capability) {
      return {
        capability,
        workspacePath,
        schema: record.schema,
        ...(isNonEmptyString(record.title) ? { title: record.title } : {}),
      }
    }
  }
  return undefined
}

function mergeManifestRefs(primary: AssetLibraryManifestRef | undefined, secondary: AssetLibraryManifestRef | undefined): AssetLibraryManifestRef | undefined {
  if (!primary) return secondary
  if (!secondary) return primary
  return {
    capability: primary.capability,
    workspacePath: primary.workspacePath,
    ...(primary.schema ?? secondary.schema ? { schema: primary.schema ?? secondary.schema } : {}),
    ...(primary.title ?? secondary.title ? { title: primary.title ?? secondary.title } : {}),
  }
}

async function readArtifactRegistrySidecarForLibrary(workspaceDir: string, workspacePath: string): Promise<{ sidecar?: ArtifactSidecar, warnings: string[] }> {
  const sidecarPath = normalizeWorkspaceArtifactPath(workspaceDir, getArtifactSidecarWorkspacePath(workspacePath))
  const result = await readJsonRecordIfPresent(sidecarPath.absolutePath)
  if (result.status === 'not-found') return { warnings: [] }
  if (result.status === 'invalid') return { warnings: [`Invalid artifact registry sidecar JSON for ${workspacePath}: ${result.error}`] }
  if (!isRecord(result.value) || !isNonEmptyString(result.value.artifactId) || !isWorkspaceRelativeString(result.value.workspacePath) || !isRecord(result.value.metadata)) {
    return { warnings: [`Invalid artifact registry sidecar payload for ${workspacePath}`] }
  }
  if (result.value.workspacePath !== workspacePath) {
    return { warnings: [`Artifact registry sidecar workspacePath mismatch for ${workspacePath}`] }
  }
  return {
    sidecar: {
      artifactId: result.value.artifactId,
      workspacePath: result.value.workspacePath,
      metadata: result.value.metadata,
    },
    warnings: [],
  }
}

async function readLandmarkLibraryState(workspaceDir: string, workspacePath: string): Promise<{ source?: AssetLibrarySourceLink, warnings: string[] }> {
  const absolutePath = normalizeWorkspaceArtifactPath(workspaceDir, workspacePath).absolutePath
  const parsed = await readJsonRecordIfPresent(absolutePath)
  if (parsed.status !== 'found' || !isRecord(parsed.value) || !isRecord(parsed.value.target)) {
    return { warnings: parsed.status === 'invalid' ? [`Invalid landmark sidecar JSON for ${workspacePath}: ${parsed.error}`] : [] }
  }
  const sourceWorkspacePath = typeof parsed.value.target.meshPath === 'string' ? parsed.value.target.meshPath : ''
  const validationErrors = validateLandmarkSidecarV1Payload(parsed.value, workspacePath, sourceWorkspacePath)
  if (validationErrors.length > 0) return { warnings: [`Invalid landmark sidecar payload for ${workspacePath}: ${validationErrors.join(', ')}`] }
  return {
    source: {
      relation: 'sidecar-source',
      ...(isWorkspaceRelativeString(parsed.value.target.meshPath) ? { workspacePath: parsed.value.target.meshPath } : { degraded: true }),
      ...(isNonEmptyString(parsed.value.target.artifactId) ? { assetId: parsed.value.target.artifactId } : {}),
      ...(isNonEmptyString(parsed.value.target.versionId) ? { versionId: parsed.value.target.versionId } : {}),
      ...(!isWorkspaceRelativeString(parsed.value.target.meshPath) ? { degraded: true } : {}),
    },
    warnings: [],
  }
}

async function readPoseClipLibraryState(workspaceDir: string, workspacePath: string): Promise<{ source?: AssetLibrarySourceLink, warnings: string[] }> {
  const absolutePath = normalizeWorkspaceArtifactPath(workspaceDir, workspacePath).absolutePath
  const parsed = await readJsonRecordIfPresent(absolutePath)
  if (parsed.status !== 'found' || !isRecord(parsed.value) || !isRecord(parsed.value.source)) {
    return { warnings: parsed.status === 'invalid' ? [`Invalid pose clip sidecar JSON for ${workspacePath}: ${parsed.error}`] : [] }
  }
  const sourceWorkspacePath = typeof parsed.value.source.workspacePath === 'string' ? parsed.value.source.workspacePath : ''
  const validationErrors = validatePoseClipSidecarV1Payload(parsed.value, sourceWorkspacePath)
  if (validationErrors.length > 0) return { warnings: [`Invalid pose clip sidecar payload for ${workspacePath}: ${validationErrors.join(', ')}`] }
  return {
    source: {
      relation: 'sidecar-source',
      ...(isWorkspaceRelativeString(parsed.value.source.workspacePath) ? { workspacePath: parsed.value.source.workspacePath } : { degraded: true }),
      ...(isNonEmptyString(parsed.value.source.artifactId) ? { assetId: parsed.value.source.artifactId } : {}),
      ...(isNonEmptyString(parsed.value.source.versionId) ? { versionId: parsed.value.source.versionId } : {}),
      ...(!isWorkspaceRelativeString(parsed.value.source.workspacePath) ? { degraded: true } : {}),
    },
    warnings: [],
  }
}

async function readMotionRetargetLibraryState(workspaceDir: string, workspacePath: string): Promise<{ source?: AssetLibrarySourceLink, warnings: string[] }> {
  const absolutePath = normalizeWorkspaceArtifactPath(workspaceDir, workspacePath).absolutePath
  const parsed = await readJsonRecordIfPresent(absolutePath)
  if (parsed.status !== 'found' || !isRecord(parsed.value) || !isRecord(parsed.value.source)) {
    return { warnings: parsed.status === 'invalid' ? [`Invalid motion retarget sidecar JSON for ${workspacePath}: ${parsed.error}`] : [] }
  }
  const sourceWorkspacePath = typeof parsed.value.source.workspacePath === 'string' ? parsed.value.source.workspacePath : ''
  const validationErrors = validateMotionRetargetSidecarV1Payload(parsed.value, sourceWorkspacePath)
  if (validationErrors.length > 0) return { warnings: [`Invalid motion retarget sidecar payload for ${workspacePath}: ${validationErrors.join(', ')}`] }
  return {
    source: {
      relation: 'sidecar-source',
      ...(isWorkspaceRelativeString(parsed.value.source.workspacePath) ? { workspacePath: parsed.value.source.workspacePath } : { degraded: true }),
      ...(isNonEmptyString(parsed.value.source.artifactId) ? { assetId: parsed.value.source.artifactId } : {}),
      ...(isNonEmptyString(parsed.value.source.versionId) ? { versionId: parsed.value.source.versionId } : {}),
      ...(!isWorkspaceRelativeString(parsed.value.source.workspacePath) ? { degraded: true } : {}),
    },
    warnings: isRecord(parsed.value.artifact) && isRecord(parsed.value.artifact.diagnostics) && isStringArray(parsed.value.artifact.diagnostics.warnings)
      ? parsed.value.artifact.diagnostics.warnings
      : [],
  }
}

async function buildWorkspaceAssetLibraryEntry(workspaceDir: string, workspacePath: string): Promise<AssetLibraryEntry | null> {
  if (shouldSkipWorkspaceAssetLibraryPath(workspacePath)) return null

  const sourceScope = deriveAssetLibrarySourceScope(workspacePath)
  const previewKind = resolveAssetLibraryPreviewKind(workspacePath)
  const { sidecar, warnings: sidecarWarnings } = await readArtifactRegistrySidecarForLibrary(workspaceDir, workspacePath)
  const metadata = extractAssetLibraryMetadataRecord(sidecar)
  const manifestFromMetadata = extractManifestRefFromMetadata(metadata, workspacePath)
  const manifestRecord = previewKind === 'text' && resolveWorkspaceArtifactExtension(workspacePath) === 'json'
    ? await readJsonRecordIfPresent(normalizeWorkspaceArtifactPath(workspaceDir, workspacePath).absolutePath)
    : { status: 'not-found' as const }
  const manifestFromRecord = manifestRecord.status === 'found' ? extractManifestRefFromRecord(manifestRecord.value, workspacePath) : undefined

  const motionState = workspacePath.startsWith(MOTION_RETARGET_SIDECAR_PREFIX) && workspacePath.endsWith(MOTION_RETARGET_SIDECAR_SUFFIX)
    ? await readMotionRetargetLibraryState(workspaceDir, workspacePath)
    : { warnings: [] as string[] }
  const poseClipState = workspacePath.startsWith(POSE_CLIP_SIDECAR_PREFIX) && workspacePath.endsWith(POSE_CLIP_SIDECAR_SUFFIX)
    ? await readPoseClipLibraryState(workspaceDir, workspacePath)
    : { warnings: [] as string[] }
  const landmarkState = workspacePath.startsWith(LANDMARK_SIDECAR_PREFIX) && workspacePath.endsWith(LANDMARK_SIDECAR_SUFFIX)
    ? await readLandmarkLibraryState(workspaceDir, workspacePath)
    : { warnings: [] as string[] }

  const rigMetaState = previewKind === '3d-model' ? await readRigMetaSidecar({ workspaceDir, sourceWorkspacePath: workspacePath }) : null
  const humanoidDraftState = previewKind === '3d-model' ? await readHumanoidDraftSidecar({ workspaceDir, meshWorkspacePath: workspacePath }) : null
  const humanoidPromotionState = previewKind === '3d-model' ? await readHumanoidPromotionSidecar({ workspaceDir, meshWorkspacePath: workspacePath }) : null
  const intrinsicEvidence = await readIntrinsicAssetLibraryEvidence(workspaceDir, workspacePath, previewKind)

  const classification = classifyAssetLibraryCandidate({
    workspacePath,
    artifactKind: extractAssetLibraryArtifactKind(metadata),
    previewKind,
    evidence: {
      rigMeta: rigMetaState?.success === true && rigMetaState.status === 'found',
      humanoidDraft: humanoidDraftState?.success === true && humanoidDraftState.status !== 'not-found',
      humanoidPromotion: humanoidPromotionState?.success === true && humanoidPromotionState.status !== 'not-found',
      motionRetargetSidecar: motionState.source !== undefined,
      poseClipSidecar: poseClipState.source !== undefined,
      landmarkSidecar: landmarkState.source !== undefined,
      manifestCapability: manifestFromMetadata?.capability ?? manifestFromRecord?.capability,
      embeddedSkins: intrinsicEvidence.embeddedSkins,
      embeddedAnimations: intrinsicEvidence.embeddedAnimations,
      intrinsicMotionFile: intrinsicEvidence.intrinsicMotionFile,
    },
  })

  const warnings = [
    ...extractAssetLibraryWarnings(metadata),
    ...sidecarWarnings,
    ...(manifestRecord.status === 'invalid' ? [`Invalid manifest JSON for ${workspacePath}: ${manifestRecord.error}`] : []),
    ...motionState.warnings,
    ...poseClipState.warnings,
    ...landmarkState.warnings,
    ...(rigMetaState?.success === true && rigMetaState.status === 'found' ? rigMetaState.warnings : []),
    ...intrinsicEvidence.warnings,
  ]

  const source = motionState.source
    ?? poseClipState.source
    ?? landmarkState.source
    ?? extractAssetLibraryMetadataSource(metadata)
    ?? (rigMetaState?.success === true && rigMetaState.status === 'found' && isRecord(rigMetaState.rigMeta) && isRecord(rigMetaState.rigMeta.source) && isWorkspaceRelativeString(rigMetaState.rigMeta.source.workspacePath)
      ? { relation: 'derived-from', workspacePath: rigMetaState.rigMeta.source.workspacePath }
      : undefined)

  const manifest = mergeManifestRefs(manifestFromMetadata, manifestFromRecord)

  const displayName = manifest?.title
    ?? extractAssetLibraryDisplayName(metadata, workspacePath)

  return {
    id: sidecar?.artifactId ?? workspacePath,
    workspacePath,
    displayName,
    sourceScope,
    ...(classification.capability ? { capability: classification.capability } : {}),
    state: classification.state,
    ...(sidecar?.artifactId ? { artifactId: sidecar.artifactId } : {}),
    ...(extractAssetLibraryVersionId(metadata) ? { versionId: extractAssetLibraryVersionId(metadata) } : {}),
    ...(extractAssetLibraryProvenance(metadata) ? { provenance: extractAssetLibraryProvenance(metadata) } : {}),
    ...(source ? { source } : {}),
    ...(manifest ? { manifest } : {}),
    previewKind,
    warnings: [...new Set(warnings)],
  }
}

function mapWorkspaceArtifactPreviewToLibraryPayload(result: Extract<WorkspaceArtifactPreviewResult, { success: true }>): AssetLibraryPreviewPayload {
  if (result.status === '3d-model') return { kind: '3d-model', viewerKind: result.viewerKind }
  if (result.status === 'text') {
    return {
      kind: 'text',
      content: result.content,
      byteLength: result.byteLength,
      truncated: result.truncated,
    }
  }
  if (result.status === 'binary') {
    return {
      kind: 'binary',
      binaryKind: result.binaryKind,
      byteLength: result.byteLength,
      message: result.message,
    }
  }
  return { kind: 'none' }
}

export async function listWorkspaceAssetLibrary(request: WorkspaceAssetLibraryListServiceRequest): Promise<AssetLibraryListResult> {
  try {
    const entries = await listWorkspaceFilePaths(request.workspaceDir)
    const projected = await Promise.all(entries.map((workspacePath) => buildWorkspaceAssetLibraryEntry(request.workspaceDir, workspacePath)))
    return {
      success: true,
      entries: projected.filter((entry): entry is AssetLibraryEntry => entry !== null && entry.state !== 'unsupported'),
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function readWorkspaceAssetLibraryEntry(request: WorkspaceAssetLibraryReadServiceRequest): Promise<AssetLibraryReadResult> {
  try {
    const entry = await buildWorkspaceAssetLibraryEntry(request.workspaceDir, normalizeWorkspaceArtifactPath(request.workspaceDir, request.workspacePath).workspacePath)
    if (!entry) {
      throw new Error('Asset library entry was not found')
    }
    const normalizedRequest = normalizeAssetLibraryReadRequest({
      workspaceDir: request.workspaceDir,
      workspacePath: entry.workspacePath,
      sourceWorkspacePath: request.sourceWorkspacePath,
      indexedSourceWorkspacePath: entry.source?.workspacePath,
    })
    const previewResult = await previewWorkspaceArtifact({ workspaceDir: request.workspaceDir, workspacePath: normalizedRequest.workspacePath })
    if (previewResult.success !== true) {
      throw new Error(previewResult.error)
    }
    const preview = mapWorkspaceArtifactPreviewToLibraryPayload(previewResult)
    return { success: true, entry, preview }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function openWorkspaceAssetLibraryEntry(request: WorkspaceAssetLibraryReadServiceRequest): Promise<AssetLibraryOpenResult> {
  try {
    const readResult = await readWorkspaceAssetLibraryEntry(request)
    if (readResult.success !== true) return readResult
    if (readResult.entry.state !== 'ready' || !readResult.entry.capability) {
      throw new Error('Asset library open requires a ready supported asset')
    }
    return { success: true, entry: readResult.entry }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function normalizeWorkspaceArtifactPath(workspaceDir: string, workspacePath: string): NormalizedWorkspaceArtifactPath {
  const safeWorkspacePath = assertSafeWorkspacePathInput(workspacePath)
  const resolvedWorkspace = resolvePath(workspaceDir)
  const absolutePath = resolvePath(resolvedWorkspace, ...safeWorkspacePath.split('/'))
  const relativePath = normalizeWorkspaceSeparators(relative(resolvedWorkspace, absolutePath))

  if (relativePath === '..' || relativePath.startsWith('../') || isAbsolute(relativePath)) {
    throw new Error('Artifact workspace path escapes the configured workspace')
  }

  return {
    workspacePath: safeWorkspacePath,
    absolutePath,
  }
}

export function getArtifactSidecarWorkspacePath(workspacePath: string): string {
  return `${normalizeWorkspaceSeparators(workspacePath)}${SIDECAR_SUFFIX}`
}

function resolveSidecarPath(workspaceDir: string, workspacePath: string): NormalizedWorkspaceArtifactPath {
  const assetPath = normalizeWorkspaceArtifactPath(workspaceDir, workspacePath)
  return normalizeWorkspaceArtifactPath(workspaceDir, getArtifactSidecarWorkspacePath(assetPath.workspacePath))
}

function parseReadPayload(payload: unknown, workspaceDir: string): ArtifactRegistryReadRequest {
  if (!isRecord(payload) || typeof payload.workspacePath !== 'string') {
    throw new Error('Artifact registry read requires a workspacePath string')
  }
  return { workspaceDir, workspacePath: payload.workspacePath }
}

function parseWorkspaceAssetLibraryListPayload(payload: unknown, workspaceDir: string): WorkspaceAssetLibraryListServiceRequest {
  if (payload !== undefined && payload !== null && (!isRecord(payload) || Object.keys(payload).length > 0)) {
    throw new Error('Workspace asset library list does not accept a payload')
  }
  return { workspaceDir }
}

function parseWorkspaceAssetLibraryReadPayload(payload: unknown, workspaceDir: string): WorkspaceAssetLibraryReadServiceRequest {
  if (!isRecord(payload) || typeof payload.workspacePath !== 'string') {
    throw new Error('Workspace asset library read requires a workspacePath string')
  }
  return {
    workspaceDir,
    workspacePath: payload.workspacePath,
    ...(typeof payload.sourceWorkspacePath === 'string' ? { sourceWorkspacePath: payload.sourceWorkspacePath } : {}),
  }
}

function parseWritePayload(payload: unknown, workspaceDir: string): ArtifactRegistryWriteRequest {
  if (!isRecord(payload) || typeof payload.workspacePath !== 'string' || typeof payload.artifactId !== 'string' || !isRecord(payload.metadata)) {
    throw new Error('Artifact registry write requires workspacePath, artifactId, and metadata')
  }
  return {
    workspaceDir,
    workspacePath: payload.workspacePath,
    artifactId: payload.artifactId,
    metadata: payload.metadata,
  }
}

function isBytesLike(value: unknown): value is ArrayBuffer | Uint8Array {
  return value instanceof ArrayBuffer || value instanceof Uint8Array
}

function parseEditedSceneArtifactPayload(payload: unknown, workspaceDir: string): EditedSceneArtifactWriteServiceRequest {
  if (
    !isRecord(payload)
    || typeof payload.glbWorkspacePath !== 'string'
    || typeof payload.sidecarWorkspacePath !== 'string'
    || typeof payload.sourceWorkspacePath !== 'string'
    || !isBytesLike(payload.bytes)
    || !isRecord(payload.metadata)
  ) {
    throw new Error('Edited scene artifact write requires glbWorkspacePath, sidecarWorkspacePath, sourceWorkspacePath, bytes, and metadata')
  }

  return {
    workspaceDir,
    glbWorkspacePath: payload.glbWorkspacePath,
    sidecarWorkspacePath: payload.sidecarWorkspacePath,
    sourceWorkspacePath: payload.sourceWorkspacePath,
    bytes: payload.bytes,
    metadata: payload.metadata,
  }
}

function parseLandmarkSidecarPayload(payload: unknown, workspaceDir: string): LandmarkSidecarWriteServiceRequest {
  if (
    !isRecord(payload)
    || typeof payload.sidecarWorkspacePath !== 'string'
    || typeof payload.sourceWorkspacePath !== 'string'
    || !isRecord(payload.sidecar)
  ) {
    throw new Error('Landmark sidecar write requires sidecarWorkspacePath, sourceWorkspacePath, and sidecar')
  }

  return {
    workspaceDir,
    sidecarWorkspacePath: payload.sidecarWorkspacePath,
    sourceWorkspacePath: payload.sourceWorkspacePath,
    sidecar: payload.sidecar,
  }
}

function parseRigRenameSidecarPayload(payload: unknown, workspaceDir: string): RigRenameSidecarWriteServiceRequest {
  if (
    !isRecord(payload)
    || typeof payload.sidecarWorkspacePath !== 'string'
    || typeof payload.sourceWorkspacePath !== 'string'
    || !isRecord(payload.sidecar)
  ) {
    throw new Error('Rig rename sidecar write requires sidecarWorkspacePath, sourceWorkspacePath, and sidecar')
  }

  return {
    workspaceDir,
    sidecarWorkspacePath: payload.sidecarWorkspacePath,
    sourceWorkspacePath: payload.sourceWorkspacePath,
    sidecar: payload.sidecar,
  }
}

function parseRigRenameSidecarReadPayload(payload: unknown, workspaceDir: string): RigRenameSidecarReadServiceRequest {
  if (
    !isRecord(payload)
    || typeof payload.sidecarWorkspacePath !== 'string'
    || typeof payload.sourceWorkspacePath !== 'string'
  ) {
    throw new Error('Rig rename sidecar read requires sidecarWorkspacePath and sourceWorkspacePath')
  }

  return {
    workspaceDir,
    sidecarWorkspacePath: payload.sidecarWorkspacePath,
    sourceWorkspacePath: payload.sourceWorkspacePath,
  }
}

function parsePoseClipSidecarPayload(payload: unknown, workspaceDir: string): PoseClipSidecarWriteServiceRequest {
  if (
    !isRecord(payload)
    || typeof payload.sidecarWorkspacePath !== 'string'
    || typeof payload.sourceWorkspacePath !== 'string'
    || !isRecord(payload.sidecar)
  ) {
    throw new Error('Pose clip sidecar write requires sidecarWorkspacePath, sourceWorkspacePath, and sidecar')
  }

  return {
    workspaceDir,
    sidecarWorkspacePath: payload.sidecarWorkspacePath,
    sourceWorkspacePath: payload.sourceWorkspacePath,
    sidecar: payload.sidecar,
  }
}

function parsePoseClipSidecarReadPayload(payload: unknown, workspaceDir: string): PoseClipSidecarReadServiceRequest {
  if (
    !isRecord(payload)
    || typeof payload.sidecarWorkspacePath !== 'string'
    || typeof payload.sourceWorkspacePath !== 'string'
  ) {
    throw new Error('Pose clip sidecar read requires sidecarWorkspacePath and sourceWorkspacePath')
  }

  return {
    workspaceDir,
    sidecarWorkspacePath: payload.sidecarWorkspacePath,
    legacySidecarWorkspacePath: typeof payload.legacySidecarWorkspacePath === 'string' ? payload.legacySidecarWorkspacePath : undefined,
    sourceWorkspacePath: payload.sourceWorkspacePath,
  }
}

function parseMotionRetargetSidecarPayload(payload: unknown, workspaceDir: string): MotionRetargetSidecarWriteServiceRequest {
  if (
    !isRecord(payload)
    || typeof payload.sidecarWorkspacePath !== 'string'
    || typeof payload.sourceWorkspacePath !== 'string'
    || !isRecord(payload.sidecar)
  ) {
    throw new Error('Motion retarget sidecar write requires sidecarWorkspacePath, sourceWorkspacePath, and sidecar')
  }

  return {
    workspaceDir,
    sidecarWorkspacePath: payload.sidecarWorkspacePath,
    sourceWorkspacePath: payload.sourceWorkspacePath,
    sidecar: payload.sidecar,
  }
}

function parseMotionRetargetSidecarReadPayload(payload: unknown, workspaceDir: string): MotionRetargetSidecarReadServiceRequest {
  if (
    !isRecord(payload)
    || typeof payload.sidecarWorkspacePath !== 'string'
    || typeof payload.sourceWorkspacePath !== 'string'
  ) {
    throw new Error('Motion retarget sidecar read requires sidecarWorkspacePath and sourceWorkspacePath')
  }

  return {
    workspaceDir,
    sidecarWorkspacePath: payload.sidecarWorkspacePath,
    sourceWorkspacePath: payload.sourceWorkspacePath,
  }
}

function parseRigMetaSidecarReadPayload(payload: unknown, workspaceDir: string): RigMetaSidecarReadServiceRequest {
  if (!isRecord(payload) || typeof payload.sourceWorkspacePath !== 'string') {
    throw new Error('Rigmeta sidecar read requires sourceWorkspacePath')
  }

  return {
    workspaceDir,
    sourceWorkspacePath: payload.sourceWorkspacePath,
  }
}

function parseHumanoidDraftSidecarReadPayload(payload: unknown, workspaceDir: string): HumanoidDraftSidecarReadServiceRequest {
  if (!isRecord(payload) || typeof payload.meshWorkspacePath !== 'string') {
    throw new Error('Humanoid draft sidecar read requires meshWorkspacePath')
  }

  return {
    workspaceDir,
    meshWorkspacePath: payload.meshWorkspacePath,
  }
}

function parseHumanoidPromotionSidecarWritePayload(payload: unknown, workspaceDir: string): HumanoidPromotionSidecarWriteServiceRequest {
  if (!isRecord(payload) || typeof payload.meshWorkspacePath !== 'string' || !isRecord(payload.sidecar)) {
    throw new Error('Humanoid promotion sidecar write requires meshWorkspacePath and sidecar')
  }

  return {
    workspaceDir,
    meshWorkspacePath: payload.meshWorkspacePath,
    sidecar: payload.sidecar,
  }
}

function parseHumanoidPromotionSidecarReadPayload(payload: unknown, workspaceDir: string): HumanoidPromotionSidecarReadServiceRequest {
  if (!isRecord(payload) || typeof payload.meshWorkspacePath !== 'string') {
    throw new Error('Humanoid promotion sidecar read requires meshWorkspacePath')
  }

  return {
    workspaceDir,
    meshWorkspacePath: payload.meshWorkspacePath,
  }
}

function parseWorkspaceArtifactPreviewPayload(payload: unknown, workspaceDir: string): WorkspaceArtifactPreviewServiceRequest {
  if (!isRecord(payload) || typeof payload.workspacePath !== 'string') {
    throw new Error('Workspace artifact preview requires workspacePath')
  }

  return {
    workspaceDir,
    workspacePath: payload.workspacePath,
  }
}

function parseWorkspaceArtifactDownloadPayload(
  payload: unknown,
  workspaceDir: string,
  showSaveDialog: WorkspaceArtifactDownloadServiceRequest['showSaveDialog'],
): WorkspaceArtifactDownloadServiceRequest {
  if (!isRecord(payload) || typeof payload.workspacePath !== 'string') {
    throw new Error('Workspace artifact download requires workspacePath')
  }

  return {
    workspaceDir,
    workspacePath: payload.workspacePath,
    suggestedName: typeof payload.suggestedName === 'string' ? payload.suggestedName : undefined,
    showSaveDialog,
  }
}

function toByteBuffer(bytes: ArrayBuffer | Uint8Array): Buffer {
  return bytes instanceof Uint8Array
    ? Buffer.from(bytes)
    : Buffer.from(new Uint8Array(bytes))
}

function assertEditedArtifactPathExtensions(glbWorkspacePath: string, sidecarWorkspacePath: string): void {
  if (!glbWorkspacePath.endsWith('.glb')) {
    throw new Error('Edited scene artifact GLB path must end with .glb')
  }
  if (!sidecarWorkspacePath.endsWith('.json')) {
    throw new Error('Edited scene artifact sidecar path must end with .json')
  }
}

function resolveWorkspaceArtifactExtension(workspacePath: string): string {
  const filename = basename(workspacePath).toLowerCase()
  const match = filename.match(/\.([a-z0-9]+)$/i)
  return match?.[1] ?? ''
}

function isWorkspaceArtifactTextPreviewExtension(extension: string): boolean {
  return new Set(['json', 'bvh', 'txt', 'log', 'md', 'csv', 'yaml', 'yml']).has(extension)
}

function resolveWorkspaceArtifactBinaryKind(extension: string): string {
  if (extension === 'npz') return 'npz'
  return extension || 'binary'
}

function assertEditedArtifactPrefix(glbWorkspacePath: string, sidecarWorkspacePath: string): void {
  if (!glbWorkspacePath.startsWith('Workflows/edited/') || !sidecarWorkspacePath.startsWith('Workflows/edited/')) {
    throw new Error('Edited scene artifact paths must stay under Workflows/edited/')
  }
}

function assertLandmarkSidecarPath(sidecarWorkspacePath: string): void {
  if (!sidecarWorkspacePath.startsWith(LANDMARK_SIDECAR_PREFIX)) {
    throw new Error('Landmark sidecar path must stay under Workflows/landmarks/')
  }
  if (!sidecarWorkspacePath.endsWith(LANDMARK_SIDECAR_SUFFIX)) {
    throw new Error('Landmark sidecar path must end with .landmarks.v1.json')
  }
}

function assertRigRenameSidecarPath(sidecarWorkspacePath: string): void {
  if (!sidecarWorkspacePath.startsWith(RIG_RENAME_SIDECAR_PREFIX)) {
    throw new Error('Rig rename sidecar path must stay under Workflows/rig-edits/')
  }
  if (!sidecarWorkspacePath.endsWith(RIG_RENAME_SIDECAR_SUFFIX)) {
    throw new Error('Rig rename sidecar path must end with .rig.v1.json')
  }
}

function assertPoseClipSidecarPath(sidecarWorkspacePath: string): void {
  if (!sidecarWorkspacePath.startsWith(POSE_CLIP_SIDECAR_PREFIX)) {
    throw new Error('Pose clip sidecar path must stay under Workflows/pose-clips/')
  }
  if (!sidecarWorkspacePath.endsWith(POSE_CLIP_SIDECAR_SUFFIX)) {
    throw new Error('Pose clip sidecar path must end with .pose-clip.v1.json')
  }
}

function isLegacyBasenamePoseClipSidecarPath(sidecarWorkspacePath: string, sourceWorkspacePath: string): boolean {
  const sidecarName = basename(sidecarWorkspacePath)
  if (!sidecarName.endsWith(POSE_CLIP_SIDECAR_SUFFIX)) return false
  const sidecarStem = sidecarName.slice(0, -POSE_CLIP_SIDECAR_SUFFIX.length)
  const sourceName = basename(sourceWorkspacePath).replace(/\.[^.]+$/, '')
  return sidecarStem === sourceName
}

function assertMotionRetargetSidecarPath(sidecarWorkspacePath: string): void {
  if (!sidecarWorkspacePath.startsWith(MOTION_RETARGET_SIDECAR_PREFIX)) {
    throw new Error('Motion retarget sidecar path must stay under Workflows/motion-retarget/')
  }
  if (!sidecarWorkspacePath.endsWith(MOTION_RETARGET_SIDECAR_SUFFIX)) {
    throw new Error('Motion retarget sidecar path must end with .motion-retarget.v1.json')
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function validateLandmarkPoint(value: unknown): string[] {
  if (!isRecord(value)) return ['invalid_landmark']

  const id = typeof value.id === 'string' && value.id.length > 0 ? value.id : '<unknown>'
  const errors: string[] = []
  if (!REQUIRED_LANDMARK_ID_SET.has(id)) errors.push(`invalid_landmark_id:${id}`)
  if (typeof value.name !== 'string' || value.name.length === 0) errors.push(`invalid_landmark_name:${id}`)
  if (!isRecord(value.world) || !isFiniteNumber(value.world.x) || !isFiniteNumber(value.world.y) || !isFiniteNumber(value.world.z)) {
    errors.push(`invalid_landmark_world:${id}`)
  }
  if (value.confidence !== 1) errors.push(`invalid_landmark_confidence:${id}`)
  if (value.source !== 'manual') errors.push(`invalid_landmark_source:${id}`)
  if (value.objectName !== undefined && typeof value.objectName !== 'string') errors.push(`invalid_landmark_object_name:${id}`)
  return errors
}

/**
 * Electron main intentionally keeps a minimal LandmarkSidecarV1-compatible validator
 * instead of importing renderer workflow helpers at runtime. This preserves the
 * Electron boundary while still rejecting malformed external IPC payloads.
 */
function validateLandmarkSidecarV1Payload(value: unknown, expectedSidecarPath: string, sourceWorkspacePath: string): string[] {
  if (!isRecord(value)) return ['invalid_sidecar']

  const errors: string[] = []
  if (value.schema !== 'modly.landmarks') errors.push('invalid_schema')
  if (value.version !== 1) errors.push('invalid_version')
  if (typeof value.createdAt !== 'string' || value.createdAt.length === 0) errors.push('invalid_created_at')
  if (typeof value.runId !== 'string' || value.runId.length === 0) errors.push('invalid_run_id')
  if (typeof value.nodeId !== 'string' || value.nodeId.length === 0) errors.push('invalid_node_id')
  if (value.sidecarPath !== expectedSidecarPath) errors.push('invalid_sidecar_path')

  if (!isRecord(value.target)) {
    errors.push('invalid_target')
  } else {
    if (typeof value.target.artifactId !== 'string' || value.target.artifactId.length === 0) errors.push('invalid_target_artifact_id')
    if (typeof value.target.versionId !== 'string' || value.target.versionId.length === 0) errors.push('invalid_target_version_id')
    if (value.target.kind !== 'mesh') errors.push('invalid_target_kind')
    if (value.target.meshPath !== sourceWorkspacePath) errors.push('invalid_target_mesh_path')
  }

  if (!isRecord(value.artifacts)) {
    errors.push('invalid_artifacts')
  } else {
    if (value.artifacts.sidecarRole !== 'landmarks-sidecar') errors.push('invalid_sidecar_role')
    if (typeof value.artifacts.targetArtifactId !== 'string' || value.artifacts.targetArtifactId.length === 0) errors.push('invalid_target_artifact_id')
    if (typeof value.artifacts.targetVersionId !== 'string' || value.artifacts.targetVersionId.length === 0) errors.push('invalid_target_version_id')
  }

  const landmarks = Array.isArray(value.landmarks) ? value.landmarks : []
  if (!Array.isArray(value.landmarks)) errors.push('invalid_landmarks')

  const seenIds = new Set<string>()
  for (const landmark of landmarks) {
    if (isRecord(landmark) && typeof landmark.id === 'string') {
      if (seenIds.has(landmark.id)) errors.push(`duplicate_landmark:${landmark.id}`)
      seenIds.add(landmark.id)
    }
    errors.push(...validateLandmarkPoint(landmark))
  }
  for (const requiredId of REQUIRED_LANDMARK_IDS) {
    if (!seenIds.has(requiredId)) errors.push(`missing_required_landmark:${requiredId}`)
  }

  return errors
}

/**
 * Main-process validator for the renderer-built RigRenameSidecarV1 payload.
 * It validates the sidecar-only persistence boundary without importing renderer
 * runtime code into Electron main.
 */
function validateRigRenameSidecarV1Payload(value: unknown, _sourceWorkspacePath: string): string[] {
  if (!isRecord(value)) return ['invalid_sidecar']

  const errors: string[] = []
  if (value.schema !== 'modly.rig.rename-plan') errors.push('invalid_schema')
  if (value.version !== 1) errors.push('invalid_version')
  if (typeof value.createdAt !== 'string' || value.createdAt.length === 0) errors.push('invalid_created_at')
  if (typeof value.skeletonContextId !== 'string' || value.skeletonContextId.length === 0) errors.push('invalid_skeleton_context_id')

  if (!isRecord(value.source)) {
    errors.push('invalid_source')
  } else {
    if (!isWorkspaceRelativeString(value.source.workspacePath)) errors.push('invalid_source_workspacePath')
    if (value.source.artifactId !== undefined && typeof value.source.artifactId !== 'string') errors.push('invalid_source_artifact_id')
    if (value.source.versionId !== undefined && typeof value.source.versionId !== 'string') errors.push('invalid_source_version_id')
  }

  if (!isRecord(value.skeleton)) {
    errors.push('invalid_skeleton')
  } else {
    if (!Array.isArray(value.skeleton.rootBoneIds) || value.skeleton.rootBoneIds.some((id) => typeof id !== 'string' || id.length === 0)) errors.push('invalid_skeleton_root_bone_ids')
    if (typeof value.skeleton.boneCount !== 'number' || !Number.isInteger(value.skeleton.boneCount) || value.skeleton.boneCount < 1) errors.push('invalid_skeleton_bone_count')
    if (!Array.isArray(value.skeleton.bones) || value.skeleton.bones.length === 0) {
      errors.push('invalid_skeleton_bones')
    } else {
      for (const bone of value.skeleton.bones) {
        if (!isRecord(bone) || typeof bone.boneId !== 'string' || bone.boneId.length === 0) errors.push('invalid_skeleton_bone')
        if (!isRecord(bone) || typeof bone.oldLabel !== 'string' || bone.oldLabel.length === 0) errors.push('invalid_skeleton_bone_old_label')
        if (!isRecord(bone) || typeof bone.originalName !== 'string') errors.push('invalid_skeleton_bone_original_name')
        if (!isRecord(bone) || !Array.isArray(bone.path) || bone.path.some((segment) => typeof segment !== 'string')) errors.push('invalid_skeleton_bone_path')
      }
    }
  }

  if (!isRecord(value.aliases) || Object.keys(value.aliases).length === 0) {
    errors.push('invalid_aliases')
  } else {
    for (const [boneId, aliasEntry] of Object.entries(value.aliases)) {
      if (boneId.length === 0 || !isRecord(aliasEntry)) {
        errors.push('invalid_alias_entry')
        continue
      }
      if (typeof aliasEntry.oldLabel !== 'string' || aliasEntry.oldLabel.length === 0) errors.push(`invalid_alias_old_label:${boneId}`)
      if (typeof aliasEntry.alias !== 'string' || aliasEntry.alias.trim().length === 0) errors.push(`invalid_alias:${boneId}`)
    }
  }

  return errors
}

async function validateRigRenameSidecarSourceLineage(
  workspaceDir: string,
  expectedSourceWorkspacePath: string,
  sidecar: RigRenameSidecarV1,
): Promise<string[]> {
  if (sidecar.source.workspacePath === expectedSourceWorkspacePath) return []

  const rigMetaWorkspacePath = createRigMetaWorkspacePath(expectedSourceWorkspacePath)
  if (!rigMetaWorkspacePath) {
    return ['invalid_source_workspacePath']
  }

  try {
    const rigMetaPath = normalizeWorkspaceArtifactPath(workspaceDir, rigMetaWorkspacePath)
    const parsedRigMeta = JSON.parse(await readFile(rigMetaPath.absolutePath, 'utf-8'))
    const validationErrors = validateRigMetaPayload(parsedRigMeta, expectedSourceWorkspacePath)
    if (validationErrors.length > 0) {
      return ['invalid_source_workspacePath']
    }

    const lineageSourceWorkspacePath = isRecord(parsedRigMeta.source) && typeof parsedRigMeta.source.workspacePath === 'string'
      ? parsedRigMeta.source.workspacePath
      : null

    return lineageSourceWorkspacePath === sidecar.source.workspacePath ? [] : ['invalid_source_workspacePath']
  } catch {
    return ['invalid_source_workspacePath']
  }
}

/**
 * Main-process validator for renderer-authored PoseClipSidecarV1 payloads.
 * Electron main keeps this minimal validation seam instead of importing renderer
 * helpers so the IPC persistence layer remains decoupled from React/Three code.
 */
function validatePoseClipSidecarV1Payload(value: unknown, sourceWorkspacePath: string): string[] {
  if (!isRecord(value)) return ['invalid_sidecar']

  const errors: string[] = []
  if (value.schema !== 'modly.pose-clip') errors.push('invalid_schema')
  if (value.version !== 1) errors.push('invalid_version')
  if (typeof value.createdAt !== 'string' || value.createdAt.length === 0) errors.push('invalid_created_at')
  if (typeof value.skeletonContextId !== 'string' || value.skeletonContextId.length === 0) errors.push('invalid_skeleton_context_id')

  if (!isRecord(value.source)) {
    errors.push('invalid_source')
  } else {
    if (value.source.workspacePath !== sourceWorkspacePath) errors.push('invalid_source_workspacePath')
    if (value.source.artifactId !== undefined && typeof value.source.artifactId !== 'string') errors.push('invalid_source_artifact_id')
    if (value.source.versionId !== undefined && typeof value.source.versionId !== 'string') errors.push('invalid_source_version_id')
  }

  if (!isRecord(value.clip)) {
    errors.push('invalid_clip')
  } else {
    if (typeof value.clip.id !== 'string' || value.clip.id.length === 0) errors.push('invalid_clip_id')
    if (typeof value.clip.name !== 'string' || value.clip.name.length === 0) errors.push('invalid_clip_name')
    if (!isFiniteNumber(value.clip.durationSeconds) || value.clip.durationSeconds <= 0) errors.push('invalid_clip_duration_seconds')
    if (!isFiniteNumber(value.clip.fps) || value.clip.fps <= 0) errors.push('invalid_clip_fps')
  }

  if (!isRecord(value.skeleton)) {
    errors.push('invalid_skeleton')
  } else {
    if (!Array.isArray(value.skeleton.rootBoneIds) || value.skeleton.rootBoneIds.some((id) => typeof id !== 'string' || id.length === 0)) errors.push('invalid_skeleton_root_bone_ids')
    if (typeof value.skeleton.boneCount !== 'number' || !Number.isInteger(value.skeleton.boneCount) || value.skeleton.boneCount < 1) errors.push('invalid_skeleton_bone_count')
    if (!Array.isArray(value.skeleton.bones) || value.skeleton.bones.length === 0) {
      errors.push('invalid_skeleton_bones')
    } else {
      for (const bone of value.skeleton.bones) {
        if (!isRecord(bone) || typeof bone.boneId !== 'string' || bone.boneId.length === 0) errors.push('invalid_skeleton_bone')
        if (!isRecord(bone) || typeof bone.label !== 'string' || bone.label.length === 0) errors.push('invalid_skeleton_bone_label')
        if (!isRecord(bone) || typeof bone.originalName !== 'string') errors.push('invalid_skeleton_bone_original_name')
        if (!isRecord(bone) || !Array.isArray(bone.path) || bone.path.some((segment) => typeof segment !== 'string')) errors.push('invalid_skeleton_bone_path')
      }
    }
  }

  if (!Array.isArray(value.keyframes)) {
    errors.push('invalid_keyframes')
  } else {
    for (const keyframe of value.keyframes) {
      if (!isRecord(keyframe) || typeof keyframe.id !== 'string' || keyframe.id.length === 0) errors.push('invalid_keyframe_id')
      if (!isRecord(keyframe) || !isFiniteNumber(keyframe.timeSeconds)) errors.push('invalid_keyframe_time_seconds')
      if (!isRecord(keyframe) || typeof keyframe.boneId !== 'string' || keyframe.boneId.length === 0) errors.push('invalid_keyframe_bone_id')
      if (!isRecord(keyframe) || !isQuaternionRecord(keyframe.rotation)) errors.push('invalid_keyframe_rotation')
      if (isRecord(keyframe) && keyframe.translation !== undefined && !isVector3Record(keyframe.translation)) errors.push('invalid_keyframe_translation')
      if (isRecord(keyframe) && keyframe.scale !== undefined && !isVector3Record(keyframe.scale)) errors.push('invalid_keyframe_scale')
    }
  }

  return errors
}

function validateMotionRetargetSidecarV1Payload(value: unknown, sourceWorkspacePath: string): string[] {
  if (!isRecord(value)) return ['invalid_sidecar']

  const errors: string[] = []
  if (value.schema !== 'modly.motion-retarget') errors.push('invalid_schema')
  if (value.version !== 1) errors.push('invalid_version')
  if (typeof value.createdAt !== 'string' || value.createdAt.length === 0) errors.push('invalid_created_at')

  if (!isRecord(value.source)) {
    errors.push('invalid_source')
  } else {
    if (value.source.workspacePath !== sourceWorkspacePath) errors.push('invalid_source_workspacePath')
    if (value.source.artifactId !== undefined && typeof value.source.artifactId !== 'string') errors.push('invalid_source_artifact_id')
    if (value.source.versionId !== undefined && typeof value.source.versionId !== 'string') errors.push('invalid_source_version_id')
  }

  if (value.identity !== undefined) {
    if (!isRecord(value.identity)) {
      errors.push('invalid_identity')
    } else {
      if (typeof value.identity.key !== 'string' || !/^mrt_[a-f0-9]{16}$/.test(value.identity.key)) errors.push('invalid_identity_key')
      if (value.identity.sourceWorkspacePath !== sourceWorkspacePath) errors.push('invalid_identity_source_workspacePath')
      if (typeof value.identity.skeletonContextId !== 'string' || value.identity.skeletonContextId.length === 0) errors.push('invalid_identity_skeleton')
      for (const key of ['workflowId', 'workflowNodeId', 'bundleWorkspacePath', 'metadataWorkspacePath', 'artifactWorkspacePath'] as const) {
        const identityValue = value.identity[key]
        if (identityValue !== undefined && typeof identityValue !== 'string') errors.push(`invalid_identity_${key}`)
      }
    }
  }

  if (!isRecord(value.artifact)) {
    errors.push('invalid_artifact')
  } else {
    if (value.artifact.extensionId !== 'kimodo-soma-rp') errors.push('invalid_artifact_extension')
    if (value.artifact.nodeId !== 'text-to-motion-preview' && value.artifact.nodeId !== 'animate-rigged-mesh') errors.push('invalid_artifact_node')
    if (!isWorkspaceRelativeString(value.artifact.bundleWorkspacePath)) errors.push('invalid_artifact_bundle_path')
    if (!isWorkspaceRelativeString(value.artifact.metadataWorkspacePath)) errors.push('invalid_artifact_metadata_path')
    if (
      isWorkspaceRelativeString(value.artifact.bundleWorkspacePath)
      && isWorkspaceRelativeString(value.artifact.metadataWorkspacePath)
      && value.artifact.metadataWorkspacePath !== value.artifact.bundleWorkspacePath
      && !value.artifact.metadataWorkspacePath.startsWith(`${value.artifact.bundleWorkspacePath}/`)
    ) {
      errors.push('invalid_artifact_metadata_scope')
    }
    if (value.artifact.sourceMeshWorkspacePath !== undefined && value.artifact.sourceMeshWorkspacePath !== sourceWorkspacePath) errors.push('invalid_artifact_source_mesh_path')
    for (const key of ['bundleWorkspacePath', 'metadataWorkspacePath', 'previewGlbWorkspacePath', 'animatedGlbWorkspacePath', 'canonicalMotionArtifactWorkspacePath', 'motionNpzWorkspacePath', 'motionBvhWorkspacePath'] as const) {
      const pathValue = value.artifact[key]
      if (pathValue === sourceWorkspacePath) errors.push(`invalid_artifact_source_alias:${key}`)
    }
    for (const key of ['previewGlbWorkspacePath', 'animatedGlbWorkspacePath', 'canonicalMotionArtifactWorkspacePath', 'motionNpzWorkspacePath', 'motionBvhWorkspacePath'] as const) {
      const pathValue = value.artifact[key]
      if (pathValue !== undefined && !isWorkspaceRelativeString(pathValue)) errors.push(`invalid_artifact_${key}`)
    }

    const diagnostics = value.artifact.diagnostics
    if (!isRecord(diagnostics)) {
      errors.push('invalid_artifact_diagnostics')
    } else {
      for (const key of ['runtimeStatus', 'retargetStatus', 'animationMappingStatus', 'stabilizationStatus', 'visualQualityStatus', 'sourceKind', 'mappingConfidence', 'retargetErrorCode', 'retargetErrorMessage'] as const) {
        const field = diagnostics[key]
        if (field !== null && field !== undefined && typeof field !== 'string') errors.push(`invalid_artifact_diagnostics_${key}`)
      }
      if (!Array.isArray(diagnostics.retargetErrorAliases) || diagnostics.retargetErrorAliases.some((entry) => typeof entry !== 'string')) errors.push('invalid_artifact_diagnostics_retarget_error_aliases')
      if (!Array.isArray(diagnostics.warnings) || diagnostics.warnings.some((entry) => typeof entry !== 'string')) errors.push('invalid_artifact_diagnostics_warnings')
      if (!isRecord(diagnostics.raw)) errors.push('invalid_artifact_diagnostics_raw')
    }
  }

  if (!Array.isArray(value.sourceBones) || value.sourceBones.length === 0) {
    errors.push('invalid_source_bones')
  } else {
    for (const bone of value.sourceBones) {
      if (!isRecord(bone) || typeof bone.sourceBoneId !== 'string' || bone.sourceBoneId.length === 0) errors.push('invalid_source_bone_id')
      if (!isRecord(bone) || typeof bone.label !== 'string' || bone.label.length === 0) errors.push('invalid_source_bone_label')
      if (!isRecord(bone) || typeof bone.rawLabel !== 'string' || bone.rawLabel.length === 0) errors.push('invalid_source_bone_raw_label')
      if (!isRecord(bone) || !Array.isArray(bone.path) || bone.path.some((segment) => typeof segment !== 'string' || segment.length === 0)) errors.push('invalid_source_bone_path')
      if (isRecord(bone) && bone.parentSourceBoneId !== undefined && typeof bone.parentSourceBoneId !== 'string') errors.push('invalid_source_bone_parent')
    }
  }

  if (!isRecord(value.session)) {
    errors.push('invalid_session')
  } else {
    if (value.session.selectedPreview !== undefined && value.session.selectedPreview !== 'preview-glb' && value.session.selectedPreview !== 'animated-glb') {
      errors.push('invalid_session_selected_preview')
    }
    if (value.session.mappings !== undefined) {
      if (!isRecord(value.session.mappings)) {
        errors.push('invalid_session_mappings')
      } else {
        for (const mapping of Object.values(value.session.mappings)) {
          if (!isRecord(mapping)) {
            errors.push('invalid_session_mapping_entry')
            continue
          }
          if (mapping.targetBoneId !== undefined && (typeof mapping.targetBoneId !== 'string' || mapping.targetBoneId.length === 0)) errors.push('invalid_session_mapping_target')
        }
      }
    }
  }

  if (!Array.isArray(value.warnings) || value.warnings.some((entry) => typeof entry !== 'string')) errors.push('invalid_warnings')

  if (value.corrections !== undefined) {
    if (!isRecord(value.corrections)) {
      errors.push('invalid_corrections')
    } else {
      if (!new Set(['solver', 'in_place', 'preserve_scaled_npz']).has(String(value.corrections.rootTranslationPolicy))) errors.push('invalid_corrections_root_policy')
      if (!isFiniteNumber(value.corrections.rootMotionScale) || value.corrections.rootMotionScale < 0 || value.corrections.rootMotionScale > 3) errors.push('invalid_corrections_root_scale')
      const rootOffset = value.corrections.rootOffset
      if (!isRecord(rootOffset) || !isFiniteNumber(rootOffset.x) || !isFiniteNumber(rootOffset.y) || !isFiniteNumber(rootOffset.z)) errors.push('invalid_corrections_root_offset')
      if (value.corrections.previewMode !== undefined && value.corrections.previewMode !== 'before' && value.corrections.previewMode !== 'after') errors.push('invalid_corrections_preview_mode')
    }
  }

  if (value.poseClip !== undefined) {
    if (!isRecord(value.poseClip)) {
      errors.push('invalid_pose_clip')
    } else {
      if (typeof value.poseClip.id !== 'string' || value.poseClip.id.length === 0) errors.push('invalid_pose_clip_id')
      if (typeof value.poseClip.name !== 'string' || value.poseClip.name.length === 0) errors.push('invalid_pose_clip_name')
      if (!isFiniteNumber(value.poseClip.durationSeconds) || value.poseClip.durationSeconds <= 0) errors.push('invalid_pose_clip_duration_seconds')
      if (!isFiniteNumber(value.poseClip.fps) || value.poseClip.fps <= 0) errors.push('invalid_pose_clip_fps')
    }
  }

  return errors
}

function isWorkspaceRelativeString(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) return false
  try {
    assertSafeWorkspacePathInput(value)
    return true
  } catch {
    return false
  }
}

function isVector3Record(value: unknown): boolean {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z)
}

function isQuaternionRecord(value: unknown): boolean {
  return isVector3Record(value) && isRecord(value) && isFiniteNumber(value.w)
}

function validateRigMetaPayload(value: unknown, sourceWorkspacePath: string): string[] {
  if (!isRecord(value)) return ['invalid_rigmeta']

  const errors: string[] = []
  const schema = value.schema ?? value.kind
  if (schema !== undefined && (typeof schema !== 'string' || !SUPPORTED_RIGMETA_SCHEMA_VALUES.has(schema))) {
    errors.push('invalid_schema')
  }

  const outputMesh = value.output_mesh ?? value.outputMesh
  if (outputMesh !== undefined) {
    if (typeof outputMesh !== 'string' || outputMesh.length === 0) {
      errors.push('invalid_output_mesh')
    } else if (basename(outputMesh.replace(/\\/g, '/')) !== basename(sourceWorkspacePath)) {
      errors.push('output_mesh_mismatch')
    }
  }

  return errors
}

function createRigMetaWorkspacePath(sourceWorkspacePath: string): string | null {
  if (!RIGMETA_MESH_EXTENSION_PATTERN.test(sourceWorkspacePath)) return null
  return sourceWorkspacePath.replace(RIGMETA_MESH_EXTENSION_PATTERN, '.rigmeta.json')
}

export function getHumanoidDraftWorkspacePath(meshWorkspacePath: string): string | null {
  if (!RIGMETA_MESH_EXTENSION_PATTERN.test(meshWorkspacePath)) return null
  return meshWorkspacePath.replace(RIGMETA_MESH_EXTENSION_PATTERN, HUMANOID_DRAFT_SIDECAR_SUFFIX)
}

export function getHumanoidPromotionWorkspacePath(meshWorkspacePath: string): string | null {
  if (!RIGMETA_MESH_EXTENSION_PATTERN.test(meshWorkspacePath)) return null
  return meshWorkspacePath.replace(RIGMETA_MESH_EXTENSION_PATTERN, HUMANOID_PROMOTION_SIDECAR_SUFFIX)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function computeSha256Hex(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function toCanonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value))
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sortJsonValue(entry))
  if (!isRecord(value)) return value
  const sortedEntries = Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => [key, sortJsonValue(entryValue)] as const)
  return Object.fromEntries(sortedEntries)
}

function computeHumanoidDraftSha256(sidecar: HumanoidDraftSidecarV1): string {
  const canonicalPayload = JSON.parse(JSON.stringify(sidecar)) as Record<string, unknown>
  delete canonicalPayload.draftSha256
  return computeSha256Hex(toCanonicalJson(canonicalPayload))
}

async function readFileSha256Hex(absolutePath: string): Promise<string> {
  return computeSha256Hex(await readFile(absolutePath))
}

async function loadValidatedRigMetaState(workspaceDir: string, meshWorkspacePath: string): Promise<{ rigMetaWorkspacePath: string, rigmetaSha256: string, rigMeta: unknown }> {
  const rigMetaWorkspacePath = createRigMetaWorkspacePath(meshWorkspacePath)
  if (!rigMetaWorkspacePath) {
    throw new Error('Rigmeta source path must be a workspace-relative .glb or .gltf mesh path')
  }

  const rigMetaPath = normalizeWorkspaceArtifactPath(workspaceDir, rigMetaWorkspacePath)
  const rawRigMeta = await readFile(rigMetaPath.absolutePath, 'utf-8')
  const parsedRigMeta = JSON.parse(rawRigMeta)
  const validationErrors = validateRigMetaPayload(parsedRigMeta, meshWorkspacePath)
  if (validationErrors.length > 0) {
    throw new Error(`Invalid rigmeta sidecar: ${validationErrors.join(', ')}`)
  }

  return {
    rigMetaWorkspacePath,
    rigmetaSha256: computeSha256Hex(rawRigMeta),
    rigMeta: parsedRigMeta,
  }
}

function validateHumanoidPathRecord(value: unknown, field: 'source' | 'output'): string[] {
  if (!isRecord(value)) return [`invalid_${field}`]
  if (!isWorkspaceRelativeString(value.workspacePath)) return [`invalid_${field}_workspace_path`]
  return []
}

function validateHumanoidDraftSidecarV1Payload(value: unknown): string[] {
  if (!isRecord(value)) return ['invalid_sidecar']

  const errors: string[] = []
  if (value.schema !== HUMANOID_DRAFT_SCHEMA) errors.push('invalid_schema')
  if (value.version !== 1) errors.push('invalid_version')
  errors.push(...validateHumanoidPathRecord(value.source, 'source'))
  errors.push(...validateHumanoidPathRecord(value.output, 'output'))
  if (!isNonEmptyString(value.meshOutputSha256)) errors.push('invalid_mesh_output_sha256')
  if (!isNonEmptyString(value.rigmetaSha256)) errors.push('invalid_rigmeta_sha256')
  if (!isNonEmptyString(value.draftSha256)) errors.push('invalid_draft_sha256')

  if (!isRecord(value.trust)) {
    errors.push('invalid_trust')
  } else {
    if (value.trust.status !== 'draft') errors.push('invalid_trust_status')
    if (!isStringArray(value.trust.reasons)) errors.push('invalid_trust_reasons')
    if (value.trust.trusted !== undefined && value.trust.trusted !== false) errors.push('invalid_trust_trusted')
  }

  if (!isRecord(value.provenance)) {
    errors.push('invalid_provenance')
  } else {
    if (!isNonEmptyString(value.provenance.producer)) errors.push('invalid_provenance_producer')
    if (!isNonEmptyString(value.provenance.createdAt)) errors.push('invalid_provenance_created_at')
    if (value.provenance.runId !== undefined && !isNonEmptyString(value.provenance.runId)) errors.push('invalid_provenance_run_id')
    if (value.provenance.extensionId !== undefined && !isNonEmptyString(value.provenance.extensionId)) errors.push('invalid_provenance_extension_id')
  }

  if (!isRecord(value.assignments)) {
    errors.push('invalid_assignments')
  } else {
    if (!isRecord(value.assignments.roles)) errors.push('invalid_assignments_roles')
    if (!isRecord(value.assignments.chains)) errors.push('invalid_assignments_chains')
  }

  if (!isRecord(value.confidence) || !isFiniteNumber(value.confidence.overall)) {
    errors.push('invalid_confidence')
  }
  if (!isRecord(value.completeness) || !isStringArray(value.completeness.requiredRolesMissing) || !isFiniteNumber(value.completeness.score)) {
    errors.push('invalid_completeness')
  }
  if (!isStringArray(value.diagnostics)) errors.push('invalid_diagnostics')

  return errors
}

function validateHumanoidPromotionSidecarV1Payload(value: unknown): string[] {
  if (!isRecord(value)) return ['invalid_sidecar']

  const errors: string[] = []
  if (value.schema !== HUMANOID_PROMOTION_SCHEMA) errors.push('invalid_schema')
  if (value.version !== 1) errors.push('invalid_version')
  if (!isNonEmptyString(value.promotionId)) errors.push('invalid_promotion_id')
  if (value.supersedesPromotionId !== undefined && !isNonEmptyString(value.supersedesPromotionId)) errors.push('invalid_supersedes_promotion_id')
  errors.push(...validateHumanoidPathRecord(value.source, 'source'))
  errors.push(...validateHumanoidPathRecord(value.output, 'output'))
  if (!isNonEmptyString(value.meshOutputSha256)) errors.push('invalid_mesh_output_sha256')
  if (!isNonEmptyString(value.rigmetaSha256)) errors.push('invalid_rigmeta_sha256')
  if (!isNonEmptyString(value.draftSha256)) errors.push('invalid_draft_sha256')
  if (value.draftSchema !== HUMANOID_DRAFT_SCHEMA) errors.push('invalid_draft_schema')

  if (!isRecord(value.promotedAssignments)) {
    errors.push('invalid_promoted_assignments')
  } else {
    if (!isRecord(value.promotedAssignments.roles)) errors.push('invalid_promoted_assignments_roles')
    if (!isRecord(value.promotedAssignments.chains)) errors.push('invalid_promoted_assignments_chains')
  }

  if (!isRecord(value.provenance)) {
    errors.push('invalid_provenance')
  } else {
    if (value.provenance.basis !== HUMANOID_DRAFT_SCHEMA) errors.push('invalid_provenance_basis')
    if (value.provenance.trustStatus !== 'manual_confirmed') errors.push('invalid_provenance_trust_status')
  }

  if (!isRecord(value.audit)) {
    errors.push('invalid_audit')
  } else {
    if (!isNonEmptyString(value.audit.confirmedBy) || !HUMANOID_PROMOTION_CONFIRMED_BY_PATTERN.test(value.audit.confirmedBy)) errors.push('invalid_audit_confirmed_by')
    if (value.audit.confirmedByLabel !== undefined && !isNonEmptyString(value.audit.confirmedByLabel)) errors.push('invalid_audit_confirmed_by_label')
    if (!isNonEmptyString(value.audit.createdAt)) errors.push('invalid_audit_created_at')
    if (!isNonEmptyString(value.audit.method) || !HUMANOID_PROMOTION_METHODS.has(value.audit.method)) errors.push('invalid_audit_method')
    if (!isNonEmptyString(value.audit.rationale)) errors.push('invalid_audit_rationale')
  }

  return errors
}

async function loadValidatedRigMetaHash(workspaceDir: string, meshWorkspacePath: string): Promise<{ rigMetaWorkspacePath: string, rigmetaSha256: string }> {
  const { rigMetaWorkspacePath, rigmetaSha256 } = await loadValidatedRigMetaState(workspaceDir, meshWorkspacePath)
  return { rigMetaWorkspacePath, rigmetaSha256 }
}

async function resolveCurrentHumanoidBindings(workspaceDir: string, meshWorkspacePath: string): Promise<{ meshOutputSha256: string, rigmetaSha256: string, rigMetaWorkspacePath: string }> {
  const meshPath = normalizeWorkspaceArtifactPath(workspaceDir, meshWorkspacePath)
  return {
    meshOutputSha256: await readFileSha256Hex(meshPath.absolutePath),
    ...(await loadValidatedRigMetaHash(workspaceDir, meshWorkspacePath)),
  }
}

function normalizeEmbeddedHumanoidWorkspacePath(candidate: string, anchorDir: string): string {
  const trimmed = candidate.trim()
  if (!trimmed) throw new Error('invalid_workspace_path')
  const normalized = normalizeWorkspaceSeparators(trimmed)
  const anchored = normalized.includes('/') ? normalized : (anchorDir ? `${anchorDir}/${normalized}` : normalized)
  return assertSafeWorkspacePathInput(anchored)
}

function materializeEmbeddedHumanoidDraft(
  parsedDraft: unknown,
  options: {
    meshWorkspacePath: string
    rigmetaSha256: string
  },
): HumanoidDraftSidecarV1 {
  const validationErrors = validateHumanoidDraftSidecarV1Payload(parsedDraft)
  if (validationErrors.length > 0) {
    throw new Error(`Invalid embedded humanoid draft sidecar v1: ${validationErrors.join(', ')}`)
  }

  const draft = JSON.parse(JSON.stringify(parsedDraft)) as HumanoidDraftSidecarV1
  const anchorDir = dirname(options.meshWorkspacePath).replace(/\\/g, '/').replace(/^\.$/, '')
  const normalizedOutputPath = normalizeEmbeddedHumanoidWorkspacePath(draft.output.workspacePath, anchorDir)
  if (normalizedOutputPath !== options.meshWorkspacePath) {
    throw new Error('Invalid embedded humanoid draft sidecar v1: invalid_output_workspace_path')
  }

  const normalizedSourcePath = normalizeEmbeddedHumanoidWorkspacePath(draft.source.workspacePath, anchorDir)
  if (dirname(normalizedSourcePath).replace(/\\/g, '/') !== anchorDir || normalizedSourcePath === options.meshWorkspacePath) {
    throw new Error('Invalid embedded humanoid draft sidecar v1: invalid_source_workspace_path')
  }

  draft.output.workspacePath = normalizedOutputPath
  draft.source.workspacePath = normalizedSourcePath
  draft.rigmetaSha256 = options.rigmetaSha256
  draft.draftSha256 = computeHumanoidDraftSha256(draft)
  return draft
}

async function loadEmbeddedHumanoidDraftFallback(
  workspaceDir: string,
  meshWorkspacePath: string,
  sidecarWorkspacePath: string,
): Promise<HumanoidDraftSidecarReadResult> {
  const rigMetaState = await loadValidatedRigMetaState(workspaceDir, meshWorkspacePath)
  if (!isRecord(rigMetaState.rigMeta) || !isRecord(rigMetaState.rigMeta.humanoid_draft)) {
    return { success: true, status: 'not-found', sidecarWorkspacePath }
  }

  const sidecar = materializeEmbeddedHumanoidDraft(rigMetaState.rigMeta.humanoid_draft, {
    meshWorkspacePath,
    rigmetaSha256: rigMetaState.rigmetaSha256,
  })
  const bindings = await resolveCurrentHumanoidBindings(workspaceDir, meshWorkspacePath)
  const staleReasons: string[] = []
  if (sidecar.meshOutputSha256 !== bindings.meshOutputSha256) staleReasons.push('mesh_output_sha256_mismatch')
  if (sidecar.rigmetaSha256 !== bindings.rigmetaSha256) staleReasons.push('rigmeta_sha256_mismatch')
  if (staleReasons.length > 0) {
    return { success: true, status: 'stale', sidecarWorkspacePath, sidecar, staleReasons }
  }

  return { success: true, status: 'found', sidecarWorkspacePath, sidecar }
}

async function loadHumanoidDraftSidecar(
  workspaceDir: string,
  meshWorkspacePath: string,
): Promise<HumanoidDraftSidecarReadResult> {
  const draftWorkspacePath = getHumanoidDraftWorkspacePath(meshWorkspacePath)
  if (!draftWorkspacePath) {
    throw new Error('Humanoid draft source path must be a workspace-relative .glb or .gltf mesh path')
  }

  const draftPath = normalizeWorkspaceArtifactPath(workspaceDir, draftWorkspacePath)
  let parsedDraft: unknown
  try {
    parsedDraft = JSON.parse(await readFile(draftPath.absolutePath, 'utf-8'))
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return await loadEmbeddedHumanoidDraftFallback(workspaceDir, meshWorkspacePath, draftPath.workspacePath)
    }
    if (error instanceof SyntaxError) {
      return { success: false, status: 'invalid', sidecarWorkspacePath: draftPath.workspacePath, error: `Invalid humanoid draft sidecar JSON: ${error.message}` }
    }
    throw error
  }

  const validationErrors = validateHumanoidDraftSidecarV1Payload(parsedDraft)
  if (validationErrors.length > 0) {
    return { success: false, status: 'invalid', sidecarWorkspacePath: draftPath.workspacePath, error: `Invalid humanoid draft sidecar v1: ${validationErrors.join(', ')}` }
  }

  const sidecar = parsedDraft as HumanoidDraftSidecarV1
  if (sidecar.output.workspacePath !== meshWorkspacePath) {
    return { success: false, status: 'invalid', sidecarWorkspacePath: draftPath.workspacePath, error: 'Invalid humanoid draft sidecar v1: invalid_output_workspace_path' }
  }

  const staleReasons: string[] = []
  try {
    const bindings = await resolveCurrentHumanoidBindings(workspaceDir, meshWorkspacePath)
    if (sidecar.meshOutputSha256 !== bindings.meshOutputSha256) staleReasons.push('mesh_output_sha256_mismatch')
    if (sidecar.rigmetaSha256 !== bindings.rigmetaSha256) staleReasons.push('rigmeta_sha256_mismatch')
  } catch (error) {
    staleReasons.push(error instanceof Error ? error.message : String(error))
  }

  if (staleReasons.length > 0) {
    return { success: true, status: 'stale', sidecarWorkspacePath: draftPath.workspacePath, sidecar, staleReasons }
  }

  return { success: true, status: 'found', sidecarWorkspacePath: draftPath.workspacePath, sidecar }
}

function normalizeRigMetaNamingForRead(rigMeta: unknown, sourceWorkspacePath: string): Pick<Extract<RigMetaSidecarReadResult, { status: 'found' }>, 'namingByBoneId' | 'warnings'> {
  const namingByBoneId: Extract<RigMetaSidecarReadResult, { status: 'found' }>['namingByBoneId'] = {}
  const warnings: string[] = []

  if (!isRecord(rigMeta)) {
    warnings.push('Rigmeta must be an object.')
    return { namingByBoneId, warnings }
  }

  const sourcePath = isRecord(rigMeta.source) && typeof rigMeta.source.workspacePath === 'string'
    ? rigMeta.source.workspacePath
    : null
  if (sourcePath && sourcePath !== sourceWorkspacePath) {
    warnings.push(`Rigmeta source mismatch: expected "${sourceWorkspacePath}" but found "${sourcePath}".`)
  }

  collectRigMetaNamingRecord(rigMeta.semantic_candidates, 'semantic_candidates', namingByBoneId, warnings)
  collectHumanoidDraftNaming(rigMeta.humanoid_draft, namingByBoneId, warnings)
  collectHumanoidContractNaming(rigMeta.humanoid_contract, rigMeta, namingByBoneId, warnings)

  if (Object.keys(namingByBoneId).length === 0) {
    warnings.push('Rigmeta did not contain supported naming entries.')
  }

  return { namingByBoneId, warnings }
}

function collectHumanoidContractNaming(
  value: unknown,
  rigMeta: Record<string, unknown>,
  output: Extract<RigMetaSidecarReadResult, { status: 'found' }>['namingByBoneId'],
  warnings: string[],
): void {
  if (!isRecord(value)) return

  if (isRecord(value.required_roles)) {
    collectTrustedHumanoidContractRequiredRoles(value, rigMeta, output)
    return
  }

  const humanoidContract = isRecord(value.bones) ? value.bones : value
  collectRigMetaNamingRecord(humanoidContract, 'humanoid_contract', output, warnings)
}

function collectTrustedHumanoidContractRequiredRoles(
  contract: Record<string, unknown>,
  rigMeta: Record<string, unknown>,
  output: Extract<RigMetaSidecarReadResult, { status: 'found' }>['namingByBoneId'],
): void {
  if (!isTrustedHumanoidRequiredRolesContract(contract, rigMeta)) return

  const knownBoneIds = new Set(Object.keys(output))
  for (const [role, assignment] of Object.entries(contract.required_roles as Record<string, unknown>)) {
    const boneId = extractHumanoidContractAssignmentKey(assignment)
    const label = humanizeRigMetaRoleLabel(role)
    if (!boneId || !label || !knownBoneIds.has(boneId)) continue

    output[boneId] = { label, source: 'humanoid_contract' }
  }
}

function isTrustedHumanoidRequiredRolesContract(contract: Record<string, unknown>, rigMeta: Record<string, unknown>): boolean {
  if (contract.schema !== 'modly.humanoid.v1') return false
  if ((contract.humanoid_contract_status ?? rigMeta.humanoid_contract_status) !== 'trusted') return false
  if (!isRecord(contract.validation) || contract.validation.status !== 'validated') return false

  const trustScope = isRecord(contract.provenance) && isRecord(contract.provenance.trust_scope)
    ? contract.provenance.trust_scope.trusted
    : null
  return Array.isArray(trustScope) && trustScope.includes('required_roles')
}

function extractHumanoidContractAssignmentKey(assignment: unknown): string | null {
  if (typeof assignment === 'string') return normalizeRigMetaLabel(assignment)
  if (!isRecord(assignment)) return null
  return normalizeRigMetaLabel(assignment.boneId)
}

function collectRigMetaNamingRecord(
  value: unknown,
  source: 'semantic_candidates' | 'humanoid_contract',
  output: Extract<RigMetaSidecarReadResult, { status: 'found' }>['namingByBoneId'],
  warnings: string[],
): void {
  const record = source === 'semantic_candidates'
    ? resolveSemanticCandidatesNamingRecord(value)
    : value
  if (!isRecord(record)) return

  let invalidCount = 0
  for (const [boneId, candidate] of Object.entries(record)) {
    const label = extractRigMetaLabel(candidate)
    if (!label) {
      invalidCount += 1
      continue
    }
    output[boneId] = { label, source }
  }
  if (invalidCount > 0) {
    warnings.push(`Rigmeta naming was partially loaded; ${invalidCount} candidate label(s) were ignored.`)
  }
}

function collectHumanoidDraftNaming(
  value: unknown,
  output: Extract<RigMetaSidecarReadResult, { status: 'found' }>['namingByBoneId'],
  warnings: string[],
): void {
  if (!isRecord(value) || !isRecord(value.assignments) || !isRecord(value.assignments.roles)) return

  let invalidCount = 0
  for (const [role, boneId] of Object.entries(value.assignments.roles)) {
    const normalizedBoneId = normalizeRigMetaLabel(boneId)
    const label = humanizeRigMetaRoleLabel(role)
    if (!normalizedBoneId || !label) {
      invalidCount += 1
      continue
    }
    output[normalizedBoneId] = { label, source: 'humanoid_draft' }
  }
  if (invalidCount > 0) {
    warnings.push(`Rigmeta naming was partially loaded; ${invalidCount} candidate label(s) were ignored.`)
  }
}

function resolveSemanticCandidatesNamingRecord(value: unknown): unknown {
  if (!isRecord(value)) return value
  return isRecord(value.roles) ? value.roles : value
}

function extractRigMetaLabel(candidate: unknown): string | null {
  if (typeof candidate === 'string') return normalizeRigMetaLabel(candidate)
  if (!isRecord(candidate)) return null

  for (const field of ['label', 'display_name', 'semantic_label', 'name', 'resolved_label']) {
    const label = normalizeRigMetaLabel(candidate[field])
    if (label) return label
  }
  return null
}

function normalizeRigMetaLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const label = value.trim()
  return label.length > 0 ? label : null
}

function humanizeRigMetaRoleLabel(value: string): string | null {
  const normalized = normalizeRigMetaLabel(value)
  if (!normalized) return null
  return normalized
    .split(/[_-]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

async function assertPathDoesNotExist(absolutePath: string, label: string): Promise<void> {
  try {
    await stat(absolutePath)
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return
    }
    throw error
  }
  throw new Error(`Edited scene artifact ${label} already exists; refusing to overwrite`)
}

export async function writeArtifactSidecar(request: ArtifactRegistryWriteRequest): Promise<ArtifactRegistryWriteResult> {
  try {
    const assetPath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.workspacePath)
    const sidecarPath = resolveSidecarPath(request.workspaceDir, assetPath.workspacePath)
    const sidecar: ArtifactSidecar = {
      artifactId: request.artifactId,
      workspacePath: assetPath.workspacePath,
      metadata: request.metadata,
    }

    await mkdir(dirname(sidecarPath.absolutePath), { recursive: true })
    await writeFile(sidecarPath.absolutePath, JSON.stringify(sidecar, null, 2), 'utf-8')

    return { success: true, sidecar, sidecarPath: sidecarPath.workspacePath }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function writeEditedSceneArtifact(request: EditedSceneArtifactWriteServiceRequest): Promise<EditedSceneArtifactWriteResult> {
  try {
    const glbBytes = toByteBuffer(request.bytes)
    if (glbBytes.byteLength === 0) {
      throw new Error('Edited scene artifact bytes must be non-empty')
    }
    if (!isRecord(request.metadata)) {
      throw new Error('Edited scene artifact metadata must be a JSON object')
    }

    const glbPath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.glbWorkspacePath)
    const sidecarPath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sidecarWorkspacePath)
    const sourcePath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sourceWorkspacePath)

    assertEditedArtifactPathExtensions(glbPath.workspacePath, sidecarPath.workspacePath)
    assertEditedArtifactPrefix(glbPath.workspacePath, sidecarPath.workspacePath)

    if (glbPath.workspacePath === sourcePath.workspacePath || glbPath.absolutePath === sourcePath.absolutePath) {
      throw new Error('Edited scene artifact GLB path must not overwrite the source artifact')
    }
    if (sidecarPath.workspacePath === sourcePath.workspacePath || sidecarPath.absolutePath === sourcePath.absolutePath) {
      throw new Error('Edited scene artifact sidecar path must not overwrite the source artifact')
    }

    await assertPathDoesNotExist(glbPath.absolutePath, 'GLB')
    await assertPathDoesNotExist(sidecarPath.absolutePath, 'sidecar')

    await mkdir(dirname(glbPath.absolutePath), { recursive: true })
    await mkdir(dirname(sidecarPath.absolutePath), { recursive: true })
    await writeFile(glbPath.absolutePath, glbBytes, { flag: 'wx' })
    await writeFile(sidecarPath.absolutePath, JSON.stringify(request.metadata, null, 2), { encoding: 'utf-8', flag: 'wx' })

    return {
      success: true,
      glbWorkspacePath: glbPath.workspacePath,
      sidecarWorkspacePath: sidecarPath.workspacePath,
      metadata: request.metadata,
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function writeLandmarkSidecar(request: LandmarkSidecarWriteServiceRequest): Promise<LandmarkSidecarWriteResult> {
  try {
    const sidecarPath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sidecarWorkspacePath)
    const sourcePath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sourceWorkspacePath)

    assertLandmarkSidecarPath(sidecarPath.workspacePath)

    if (sidecarPath.workspacePath === sourcePath.workspacePath || sidecarPath.absolutePath === sourcePath.absolutePath) {
      throw new Error('Landmark sidecar path must not overwrite the source artifact')
    }

    const validationErrors = validateLandmarkSidecarV1Payload(request.sidecar, sidecarPath.workspacePath, sourcePath.workspacePath)
    if (validationErrors.length > 0) {
      throw new Error(`Invalid landmark sidecar v1: ${validationErrors.join(', ')}`)
    }

    const sidecar = request.sidecar as LandmarkSidecarWriteRequest['sidecar']

    await assertPathDoesNotExist(sidecarPath.absolutePath, 'landmark sidecar')
    await mkdir(dirname(sidecarPath.absolutePath), { recursive: true })
    await writeFile(sidecarPath.absolutePath, JSON.stringify(sidecar, null, 2), { encoding: 'utf-8', flag: 'wx' })

    return {
      success: true,
      sidecarWorkspacePath: sidecarPath.workspacePath,
      sidecar,
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function writeRigRenameSidecar(request: RigRenameSidecarWriteServiceRequest): Promise<RigRenameSidecarWriteResult> {
  try {
    const sidecarPath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sidecarWorkspacePath)
    const sourcePath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sourceWorkspacePath)

    assertRigRenameSidecarPath(sidecarPath.workspacePath)

    if (sidecarPath.workspacePath === sourcePath.workspacePath || sidecarPath.absolutePath === sourcePath.absolutePath) {
      throw new Error('Rig rename sidecar path must not overwrite the source artifact')
    }

    const validationErrors = validateRigRenameSidecarV1Payload(request.sidecar, sourcePath.workspacePath)
    const sidecar = request.sidecar as RigRenameSidecarWriteRequest['sidecar']
    const sourceLineageErrors = validationErrors.length === 0
      ? await validateRigRenameSidecarSourceLineage(request.workspaceDir, sourcePath.workspacePath, sidecar)
      : []
    if (validationErrors.length > 0 || sourceLineageErrors.length > 0) {
      throw new Error(`Invalid rig rename sidecar v1: ${[...validationErrors, ...sourceLineageErrors].join(', ')}`)
    }

    await mkdir(dirname(sidecarPath.absolutePath), { recursive: true })
    await writeJsonAtomically(sidecarPath.absolutePath, sidecar)

    return {
      success: true,
      sidecarWorkspacePath: sidecarPath.workspacePath,
      sidecar,
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function readRigRenameSidecar(request: RigRenameSidecarReadServiceRequest): Promise<RigRenameSidecarReadResult> {
  try {
    const sidecarPath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sidecarWorkspacePath)
    const sourcePath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sourceWorkspacePath)

    assertRigRenameSidecarPath(sidecarPath.workspacePath)

    if (sidecarPath.workspacePath === sourcePath.workspacePath || sidecarPath.absolutePath === sourcePath.absolutePath) {
      throw new Error('Rig rename sidecar path must not overwrite the source artifact')
    }

    let parsedSidecar: unknown
    try {
      parsedSidecar = JSON.parse(await readFile(sidecarPath.absolutePath, 'utf-8'))
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') {
        return { success: true, status: 'not-found', sidecarWorkspacePath: sidecarPath.workspacePath }
      }
      if (error instanceof SyntaxError) {
        return { success: false, status: 'invalid', error: `Invalid rig rename sidecar JSON: ${error.message}` }
      }
      throw error
    }

    const validationErrors = validateRigRenameSidecarV1Payload(parsedSidecar, sourcePath.workspacePath)
    const sourceLineageErrors = validationErrors.length === 0
      ? await validateRigRenameSidecarSourceLineage(request.workspaceDir, sourcePath.workspacePath, parsedSidecar as RigRenameSidecarV1)
      : []
    if (validationErrors.length > 0 || sourceLineageErrors.length > 0) {
      throw new Error(`Invalid rig rename sidecar v1: ${[...validationErrors, ...sourceLineageErrors].join(', ')}`)
    }

    return {
      success: true,
      status: 'found',
      sidecarWorkspacePath: sidecarPath.workspacePath,
      sidecar: parsedSidecar as RigRenameSidecarV1,
    }
  } catch (error) {
    return { success: false, status: 'invalid', error: error instanceof Error ? error.message : String(error) }
  }
}

export async function writePoseClipSidecar(request: PoseClipSidecarWriteServiceRequest): Promise<PoseClipSidecarWriteResult> {
  try {
    const sidecarPath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sidecarWorkspacePath)
    const sourcePath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sourceWorkspacePath)

    assertPoseClipSidecarPath(sidecarPath.workspacePath)

    if (sidecarPath.workspacePath === sourcePath.workspacePath || sidecarPath.absolutePath === sourcePath.absolutePath) {
      throw new Error('Pose clip sidecar path must not overwrite the source artifact')
    }

    const validationErrors = validatePoseClipSidecarV1Payload(request.sidecar, sourcePath.workspacePath)
    if (validationErrors.length > 0) {
      throw new Error(`Invalid pose clip sidecar v1: ${validationErrors.join(', ')}`)
    }

    await mkdir(dirname(sidecarPath.absolutePath), { recursive: true })
    await writeJsonAtomically(sidecarPath.absolutePath, request.sidecar)

    return {
      success: true,
      sidecarWorkspacePath: sidecarPath.workspacePath,
      sidecar: request.sidecar,
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function writeMotionRetargetSidecar(request: MotionRetargetSidecarWriteServiceRequest): Promise<LocalMotionRetargetSidecarWriteResult> {
  try {
    const sidecarPath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sidecarWorkspacePath)
    const sourcePath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sourceWorkspacePath)

    assertMotionRetargetSidecarPath(sidecarPath.workspacePath)

    if (sidecarPath.workspacePath === sourcePath.workspacePath || sidecarPath.absolutePath === sourcePath.absolutePath) {
      throw new Error('Motion retarget sidecar path must not overwrite the source artifact')
    }

    const validationErrors = validateMotionRetargetSidecarV1Payload(request.sidecar, sourcePath.workspacePath)
    if (validationErrors.length > 0) {
      throw new Error(`Invalid motion retarget sidecar v1: ${validationErrors.join(', ')}`)
    }

    await mkdir(dirname(sidecarPath.absolutePath), { recursive: true })
    await writeJsonAtomically(sidecarPath.absolutePath, request.sidecar)

    return {
      success: true,
      sidecarWorkspacePath: sidecarPath.workspacePath,
      sidecar: request.sidecar as MotionRetargetSidecarV1,
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function readPoseClipSidecar(request: PoseClipSidecarReadServiceRequest): Promise<PoseClipSidecarReadResult> {
  try {
    const sidecarPath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sidecarWorkspacePath)
    const sourcePath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sourceWorkspacePath)
    const legacySidecarPath = request.legacySidecarWorkspacePath
      ? normalizeWorkspaceArtifactPath(request.workspaceDir, request.legacySidecarWorkspacePath)
      : null

    assertPoseClipSidecarPath(sidecarPath.workspacePath)
    if (legacySidecarPath) assertPoseClipSidecarPath(legacySidecarPath.workspacePath)

    if (sidecarPath.workspacePath === sourcePath.workspacePath || sidecarPath.absolutePath === sourcePath.absolutePath) {
      throw new Error('Pose clip sidecar path must not overwrite the source artifact')
    }
    if (legacySidecarPath && (legacySidecarPath.workspacePath === sourcePath.workspacePath || legacySidecarPath.absolutePath === sourcePath.absolutePath)) {
      throw new Error('Pose clip sidecar path must not overwrite the source artifact')
    }

    const primaryResult = await readPoseClipSidecarAtPath(sidecarPath, sourcePath, true)
    if (primaryResult.status !== 'not-found' || !legacySidecarPath || legacySidecarPath.workspacePath === sidecarPath.workspacePath) {
      return primaryResult
    }

    return await readPoseClipSidecarAtPath(legacySidecarPath, sourcePath, true)
  } catch (error) {
    return { success: false, status: 'invalid', error: error instanceof Error ? error.message : String(error) }
  }
}

async function readPoseClipSidecarAtPath(
  sidecarPath: NormalizedWorkspaceArtifactPath,
  sourcePath: NormalizedWorkspaceArtifactPath,
  allowLegacySourceMismatch: boolean,
): Promise<PoseClipSidecarReadResult> {
  try {
    let parsedSidecar: unknown
    try {
      parsedSidecar = JSON.parse(await readFile(sidecarPath.absolutePath, 'utf-8'))
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') {
        return { success: true, status: 'not-found', sidecarWorkspacePath: sidecarPath.workspacePath }
      }
      if (error instanceof SyntaxError) {
        return { success: false, status: 'invalid', error: `Invalid pose clip sidecar JSON: ${error.message}` }
      }
      throw error
    }

    const validationErrors = validatePoseClipSidecarV1Payload(parsedSidecar, sourcePath.workspacePath)
    if (validationErrors.length > 0) {
      if (
        allowLegacySourceMismatch
        && validationErrors.length === 1
        && validationErrors[0] === 'invalid_source_workspacePath'
        && isLegacyBasenamePoseClipSidecarPath(sidecarPath.workspacePath, sourcePath.workspacePath)
      ) {
        return { success: true, status: 'not-found', sidecarWorkspacePath: sidecarPath.workspacePath }
      }
      throw new Error(`Invalid pose clip sidecar v1: ${validationErrors.join(', ')}`)
    }

    return {
      success: true,
      status: 'found',
      sidecarWorkspacePath: sidecarPath.workspacePath,
      sidecar: parsedSidecar,
    }
  } catch (error) {
    return { success: false, status: 'invalid', error: error instanceof Error ? error.message : String(error) }
  }
}

export async function readMotionRetargetSidecar(request: MotionRetargetSidecarReadServiceRequest): Promise<LocalMotionRetargetSidecarReadResult> {
  try {
    const sidecarPath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sidecarWorkspacePath)
    const sourcePath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sourceWorkspacePath)

    assertMotionRetargetSidecarPath(sidecarPath.workspacePath)

    if (sidecarPath.workspacePath === sourcePath.workspacePath || sidecarPath.absolutePath === sourcePath.absolutePath) {
      throw new Error('Motion retarget sidecar path must not overwrite the source artifact')
    }

    let parsedSidecar: unknown
    try {
      parsedSidecar = JSON.parse(await readFile(sidecarPath.absolutePath, 'utf-8'))
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') {
        return { success: true, status: 'not-found', sidecarWorkspacePath: sidecarPath.workspacePath }
      }
      if (error instanceof SyntaxError) {
        return { success: false, status: 'invalid', error: `Invalid motion retarget sidecar JSON: ${error.message}` }
      }
      throw error
    }

    const validationErrors = validateMotionRetargetSidecarV1Payload(parsedSidecar, sourcePath.workspacePath)
    if (validationErrors.length > 0) {
      throw new Error(`Invalid motion retarget sidecar v1: ${validationErrors.join(', ')}`)
    }

    return {
      success: true,
      status: 'found',
      sidecarWorkspacePath: sidecarPath.workspacePath,
      sidecar: parsedSidecar as MotionRetargetSidecarV1,
    }
  } catch (error) {
    return { success: false, status: 'invalid', error: error instanceof Error ? error.message : String(error) }
  }
}

export async function readRigMetaSidecar(request: RigMetaSidecarReadServiceRequest): Promise<RigMetaSidecarReadResult> {
  let rigMetaWorkspacePath: string | undefined

  try {
    const sourcePath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sourceWorkspacePath)
    rigMetaWorkspacePath = createRigMetaWorkspacePath(sourcePath.workspacePath) ?? undefined
    if (!rigMetaWorkspacePath) {
      throw new Error('Rigmeta source path must be a workspace-relative .glb or .gltf mesh path')
    }

    const rigMetaPath = normalizeWorkspaceArtifactPath(request.workspaceDir, rigMetaWorkspacePath)

    let parsedRigMeta: unknown
    try {
      parsedRigMeta = JSON.parse(await readFile(rigMetaPath.absolutePath, 'utf-8'))
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') {
        return { success: true, status: 'not-found', rigMetaWorkspacePath: rigMetaPath.workspacePath }
      }
      if (error instanceof SyntaxError) {
        return { success: false, status: 'invalid', rigMetaWorkspacePath: rigMetaPath.workspacePath, message: `Invalid rigmeta JSON: ${error.message}` }
      }
      throw error
    }

    const validationErrors = validateRigMetaPayload(parsedRigMeta, sourcePath.workspacePath)
    if (validationErrors.length > 0) {
      throw new Error(`Invalid rigmeta sidecar: ${validationErrors.join(', ')}`)
    }

    const naming = normalizeRigMetaNamingForRead(parsedRigMeta, sourcePath.workspacePath)

    return {
      success: true,
      status: 'found',
      rigMetaWorkspacePath: rigMetaPath.workspacePath,
      rigMeta: parsedRigMeta,
      namingByBoneId: naming.namingByBoneId,
      warnings: naming.warnings,
    }
  } catch (error) {
    return { success: false, status: 'invalid', ...(rigMetaWorkspacePath ? { rigMetaWorkspacePath } : {}), message: error instanceof Error ? error.message : String(error) }
  }
}

export async function readHumanoidDraftSidecar(request: HumanoidDraftSidecarReadServiceRequest): Promise<HumanoidDraftSidecarReadResult> {
  let sidecarWorkspacePath: string | undefined

  try {
    const meshPath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.meshWorkspacePath)
    sidecarWorkspacePath = getHumanoidDraftWorkspacePath(meshPath.workspacePath) ?? undefined
    if (!sidecarWorkspacePath) {
      throw new Error('Humanoid draft source path must be a workspace-relative .glb or .gltf mesh path')
    }

    return await loadHumanoidDraftSidecar(request.workspaceDir, meshPath.workspacePath)
  } catch (error) {
    return {
      success: false,
      status: 'invalid',
      ...(sidecarWorkspacePath ? { sidecarWorkspacePath } : {}),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function writeHumanoidPromotionSidecar(request: HumanoidPromotionSidecarWriteServiceRequest): Promise<HumanoidPromotionSidecarWriteResult> {
  try {
    const meshPath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.meshWorkspacePath)
    const promotionWorkspacePath = getHumanoidPromotionWorkspacePath(meshPath.workspacePath)
    if (!promotionWorkspacePath) {
      throw new Error('Humanoid promotion source path must be a workspace-relative .glb or .gltf mesh path')
    }

    const promotionPath = normalizeWorkspaceArtifactPath(request.workspaceDir, promotionWorkspacePath)
    const validationErrors = validateHumanoidPromotionSidecarV1Payload(request.sidecar)
    if (validationErrors.length > 0) {
      throw new Error(`Invalid humanoid promotion sidecar v1: ${validationErrors.join(', ')}`)
    }

    const sidecar = request.sidecar as HumanoidPromotionSidecarV1
    if (sidecar.output.workspacePath !== meshPath.workspacePath) {
      throw new Error('Invalid humanoid promotion sidecar v1: invalid_output_workspace_path')
    }

    const draftState = await loadHumanoidDraftSidecar(request.workspaceDir, meshPath.workspacePath)
    if (draftState.success !== true) {
      throw new Error(draftState.error)
    }
    if (draftState.status === 'not-found') {
      throw new Error('Cannot write humanoid promotion without an adjacent humanoid draft sidecar')
    }
    if (draftState.status === 'stale') {
      throw new Error(`Cannot write humanoid promotion from a stale humanoid draft sidecar: ${draftState.staleReasons.join(', ')}`)
    }

    const bindings = await resolveCurrentHumanoidBindings(request.workspaceDir, meshPath.workspacePath)
    const staleReasons: string[] = []
    if (sidecar.meshOutputSha256 !== bindings.meshOutputSha256) staleReasons.push('mesh_output_sha256_mismatch')
    if (sidecar.rigmetaSha256 !== bindings.rigmetaSha256) staleReasons.push('rigmeta_sha256_mismatch')
    if (sidecar.draftSha256 !== draftState.sidecar.draftSha256) staleReasons.push('draft_sha256_mismatch')
    if (sidecar.draftSchema !== draftState.sidecar.schema) staleReasons.push('draft_schema_mismatch')
    if (sidecar.source.workspacePath !== draftState.sidecar.source.workspacePath) staleReasons.push('source_workspace_path_mismatch')
    if (staleReasons.length > 0) {
      throw new Error(`Cannot write stale humanoid promotion sidecar: ${staleReasons.join(', ')}`)
    }

    await mkdir(dirname(promotionPath.absolutePath), { recursive: true })
    await writeJsonAtomically(promotionPath.absolutePath, sidecar)

    return { success: true, sidecarWorkspacePath: promotionPath.workspacePath, sidecar }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function readHumanoidPromotionSidecar(request: HumanoidPromotionSidecarReadServiceRequest): Promise<HumanoidPromotionSidecarReadResult> {
  let sidecarWorkspacePath: string | undefined

  try {
    const meshPath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.meshWorkspacePath)
    sidecarWorkspacePath = getHumanoidPromotionWorkspacePath(meshPath.workspacePath) ?? undefined
    if (!sidecarWorkspacePath) {
      throw new Error('Humanoid promotion source path must be a workspace-relative .glb or .gltf mesh path')
    }

    const promotionPath = normalizeWorkspaceArtifactPath(request.workspaceDir, sidecarWorkspacePath)
    let parsedPromotion: unknown
    try {
      parsedPromotion = JSON.parse(await readFile(promotionPath.absolutePath, 'utf-8'))
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') {
        return { success: true, status: 'not-found', sidecarWorkspacePath: promotionPath.workspacePath }
      }
      if (error instanceof SyntaxError) {
        return { success: false, status: 'invalid', sidecarWorkspacePath: promotionPath.workspacePath, error: `Invalid humanoid promotion sidecar JSON: ${error.message}` }
      }
      throw error
    }

    const validationErrors = validateHumanoidPromotionSidecarV1Payload(parsedPromotion)
    if (validationErrors.length > 0) {
      return { success: false, status: 'invalid', sidecarWorkspacePath: promotionPath.workspacePath, error: `Invalid humanoid promotion sidecar v1: ${validationErrors.join(', ')}` }
    }

    const sidecar = parsedPromotion as HumanoidPromotionSidecarV1
    if (sidecar.output.workspacePath !== meshPath.workspacePath) {
      return { success: false, status: 'invalid', sidecarWorkspacePath: promotionPath.workspacePath, error: 'Invalid humanoid promotion sidecar v1: invalid_output_workspace_path' }
    }

    const staleReasons: string[] = []
    const draftState = await loadHumanoidDraftSidecar(request.workspaceDir, meshPath.workspacePath)
    if (draftState.success !== true) {
      return { success: false, status: 'invalid', sidecarWorkspacePath: promotionPath.workspacePath, error: draftState.error }
    }
    if (draftState.status === 'not-found') {
      staleReasons.push('draft_sidecar_missing')
    } else {
      if (draftState.status === 'stale') staleReasons.push(...draftState.staleReasons)
      if (sidecar.draftSha256 !== draftState.sidecar.draftSha256) staleReasons.push('draft_sha256_mismatch')
      if (sidecar.draftSchema !== draftState.sidecar.schema) staleReasons.push('draft_schema_mismatch')
      if (sidecar.source.workspacePath !== draftState.sidecar.source.workspacePath) staleReasons.push('source_workspace_path_mismatch')
    }

    try {
      const bindings = await resolveCurrentHumanoidBindings(request.workspaceDir, meshPath.workspacePath)
      if (sidecar.meshOutputSha256 !== bindings.meshOutputSha256) staleReasons.push('mesh_output_sha256_mismatch')
      if (sidecar.rigmetaSha256 !== bindings.rigmetaSha256) staleReasons.push('rigmeta_sha256_mismatch')
    } catch (error) {
      staleReasons.push(error instanceof Error ? error.message : String(error))
    }

    if (staleReasons.length > 0) {
      return { success: true, status: 'stale', sidecarWorkspacePath: promotionPath.workspacePath, sidecar, staleReasons }
    }

    return { success: true, status: 'found', sidecarWorkspacePath: promotionPath.workspacePath, sidecar }
  } catch (error) {
    return {
      success: false,
      status: 'invalid',
      ...(sidecarWorkspacePath ? { sidecarWorkspacePath } : {}),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function writeJsonAtomically(absolutePath: string, value: unknown): Promise<void> {
  const tempPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: 'utf-8', flag: 'wx' })
    await rename(tempPath, absolutePath)
  } catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
}

export async function readArtifactSidecar(request: ArtifactRegistryReadRequest): Promise<ArtifactRegistryReadResult> {
  try {
    const sidecarPath = resolveSidecarPath(request.workspaceDir, request.workspacePath)
    const rawSidecar = await readFile(sidecarPath.absolutePath, 'utf-8')
    const sidecar = JSON.parse(rawSidecar) as ArtifactSidecar
    return { success: true, sidecar }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function previewWorkspaceArtifact(request: WorkspaceArtifactPreviewServiceRequest): Promise<WorkspaceArtifactPreviewResult> {
  try {
    const normalized = normalizeWorkspaceArtifactPath(request.workspaceDir, request.workspacePath)
    const fileStats = await stat(normalized.absolutePath)
    const displayName = basename(normalized.workspacePath)
    const extension = resolveWorkspaceArtifactExtension(normalized.workspacePath)

    if (extension === 'glb' || extension === 'gltf') {
      return {
        success: true,
        status: '3d-model',
        workspacePath: normalized.workspacePath,
        displayName,
        viewerKind: extension as 'glb' | 'gltf',
      }
    }

    if (!isWorkspaceArtifactTextPreviewExtension(extension)) {
      return {
        success: true,
        status: 'binary',
        workspacePath: normalized.workspacePath,
        displayName,
        byteLength: fileStats.size,
        binaryKind: resolveWorkspaceArtifactBinaryKind(extension),
        message: extension === 'npz'
          ? 'Binary preview is unavailable for NPZ artifacts. Download the file to inspect it locally.'
          : 'Binary preview is unavailable for this artifact. Download the file to inspect it locally.',
      }
    }

    const maxBytes = Math.max(1, request.maxBytes ?? 64 * 1024)
    const handle = await open(normalized.absolutePath, 'r')

    try {
      const buffer = Buffer.alloc(Math.min(fileStats.size, maxBytes + 1))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return {
        success: true,
        status: 'text',
        workspacePath: normalized.workspacePath,
        displayName,
        content: buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString('utf8'),
        byteLength: fileStats.size,
        truncated: fileStats.size > maxBytes || bytesRead > maxBytes,
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function downloadWorkspaceArtifact(request: WorkspaceArtifactDownloadServiceRequest): Promise<WorkspaceArtifactDownloadResult> {
  try {
    const normalized = normalizeWorkspaceArtifactPath(request.workspaceDir, request.workspacePath)
    await stat(normalized.absolutePath)
    const dialogResult = await request.showSaveDialog({
      title: 'Download artifact',
      defaultPath: request.suggestedName || basename(normalized.workspacePath),
    })
    if (dialogResult.canceled || !dialogResult.filePath) {
      return { success: true, status: 'cancelled', workspacePath: normalized.workspacePath }
    }

    await mkdir(dirname(dialogResult.filePath), { recursive: true })
    await copyFile(normalized.absolutePath, dialogResult.filePath)
    return {
      success: true,
      status: 'saved',
      workspacePath: normalized.workspacePath,
      targetPath: dialogResult.filePath,
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function registerArtifactRegistryIpcHandlers({ ipcMain, getWorkspaceDir, showSaveDialog }: ArtifactRegistryIpcRegistrationDeps): void {
  const saveDialog = showSaveDialog ?? (async () => ({ canceled: true as const }))
  ipcMain.handle('workspace:library:list', async (_event, payload) => {
    try {
      return listWorkspaceAssetLibrary(parseWorkspaceAssetLibraryListPayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:library:read', async (_event, payload) => {
    try {
      return readWorkspaceAssetLibraryEntry(parseWorkspaceAssetLibraryReadPayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:library:open', async (_event, payload) => {
    try {
      return openWorkspaceAssetLibraryEntry(parseWorkspaceAssetLibraryReadPayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:artifact:writeSidecar', async (_event, payload) => {
    try {
      return writeArtifactSidecar(parseWritePayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:artifact:readSidecar', async (_event, payload) => {
    try {
      return readArtifactSidecar(parseReadPayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:artifact:writeEditedSceneArtifact', async (_event, payload) => {
    try {
      return writeEditedSceneArtifact(parseEditedSceneArtifactPayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:artifact:writeLandmarkSidecar', async (_event, payload) => {
    try {
      return writeLandmarkSidecar(parseLandmarkSidecarPayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:artifact:readHumanoidDraftSidecar', async (_event, payload) => {
    try {
      return readHumanoidDraftSidecar(parseHumanoidDraftSidecarReadPayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, status: 'invalid', error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:artifact:writeHumanoidPromotionSidecar', async (_event, payload) => {
    try {
      return writeHumanoidPromotionSidecar(parseHumanoidPromotionSidecarWritePayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:artifact:readHumanoidPromotionSidecar', async (_event, payload) => {
    try {
      return readHumanoidPromotionSidecar(parseHumanoidPromotionSidecarReadPayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, status: 'invalid', error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:artifact:writeMotionRetargetSidecar', async (_event, payload) => {
    try {
      return writeMotionRetargetSidecar(parseMotionRetargetSidecarPayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:artifact:readMotionRetargetSidecar', async (_event, payload) => {
    try {
      return readMotionRetargetSidecar(parseMotionRetargetSidecarReadPayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, status: 'invalid', error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:artifact:previewWorkspaceArtifact', async (_event, payload) => {
    try {
      return previewWorkspaceArtifact(parseWorkspaceArtifactPreviewPayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:artifact:downloadWorkspaceArtifact', async (_event, payload) => {
    try {
      return downloadWorkspaceArtifact(parseWorkspaceArtifactDownloadPayload(payload, getWorkspaceDir(), saveDialog))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:artifact:writeRigRenameSidecar', async (_event, payload) => {
    try {
      return writeRigRenameSidecar(parseRigRenameSidecarPayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:artifact:readRigRenameSidecar', async (_event, payload) => {
    try {
      return readRigRenameSidecar(parseRigRenameSidecarReadPayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, status: 'invalid', error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:artifact:writePoseClipSidecar', async (_event, payload) => {
    try {
      return writePoseClipSidecar(parsePoseClipSidecarPayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:artifact:readPoseClipSidecar', async (_event, payload) => {
    try {
      return readPoseClipSidecar(parsePoseClipSidecarReadPayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, status: 'invalid', error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:artifact:readRigMetaSidecar', async (_event, payload) => {
    try {
      return readRigMetaSidecar(parseRigMetaSidecarReadPayload(payload, getWorkspaceDir()))
    } catch (error) {
      return { success: false, status: 'invalid', message: error instanceof Error ? error.message : String(error) }
    }
  })
}

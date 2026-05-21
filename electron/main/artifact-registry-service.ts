import { constants } from 'node:fs'
import { readdir, readFile, stat, mkdir, rename, rm, writeFile, lstat, realpath, mkdtemp, link, open } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, resolve as resolvePath, sep } from 'node:path'

import type {
  AssetCapability,
  AssetEntryState,
  AssetLibraryEntry,
  AssetLibraryError,
  AssetLibraryListResult,
  AssetLibraryOpenResult,
  AssetLibraryPreviewKind,
  AssetLibraryPreviewPayload,
  AssetLibraryReadResult,
  AssetLibrarySourceScope,
} from '../../src/shared/types/assetLibrary'
import type { ArtifactProvenance } from '../../src/shared/types/artifacts'

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/
const ENCODED_ESCAPE_PATTERN = /%2e|%2f|%5c/i
const ALLOWED_ROOTS = ['Workflows', 'Exports'] as const
const SKIPPED_DIRS = new Set(['tmp', 'temp', 'cache'])
const INTERNAL_SUFFIXES = ['.artifact.json', '.rigmeta.json'] as const
const TEXT_EXTENSIONS = new Set(['json', 'txt', 'md'])
const INTRINSIC_MOTION_EXTENSIONS = new Set(['bvh', 'npz'])
const MESH_EXTENSIONS = new Set(['glb', 'gltf', 'obj', 'stl', 'ply', 'splat'])

export interface AssetLibraryClassificationCandidate {
  workspacePath: string
  hasRigMetadata?: boolean
}

export interface AssetLibraryClassification {
  capability?: AssetCapability
  state: AssetEntryState
  previewKind: AssetLibraryPreviewKind
  openable: boolean
  nonOpenableReason?: string
}

export interface NormalizedWorkspaceAssetPath {
  workspacePath: string
  absolutePath: string
}

export interface WorkspaceAssetLibraryRequest {
  workspaceDir: string
}

export interface WorkspaceAssetLibraryReadRequest extends WorkspaceAssetLibraryRequest {
  workspacePath: string
  sourceWorkspacePath?: string
}

interface AssetLibraryMetadata {
  sourceWorkspacePath?: string
  manifestWorkspacePath?: string
  artifactId?: string
  versionId?: string
  provenance?: ArtifactProvenance
  warnings: string[]
}

export interface IpcMainLike {
  handle(channel: string, handler: (event: unknown, payload?: unknown) => Promise<unknown>): void
}

export interface WorkspaceAssetLibraryIpcDeps {
  ipcMain: IpcMainLike
  getWorkspaceDir: () => string
}

function libraryError(code: AssetLibraryError['code'], message: string): AssetLibraryError {
  return { code, message }
}

function normalizeSeparators(input: string): string {
  return input.replace(/\\/g, '/')
}

function isWindowsAbsolutePath(input: string): boolean {
  return WINDOWS_ABSOLUTE_PATH.test(input) || input.startsWith('\\\\')
}

function assertSafeWorkspaceRelativePath(workspacePath: string): string {
  const normalized = normalizeSeparators(workspacePath.trim())
  if (!normalized || normalized === '.') throw new Error('Workspace library path must be workspace-relative and non-empty')
  if (ENCODED_ESCAPE_PATTERN.test(normalized)) throw new Error('Workspace library path must not contain encoded path escapes')
  if (isAbsolute(normalized) || isWindowsAbsolutePath(workspacePath)) throw new Error('Workspace library path must not be absolute')
  const segments = normalized.split('/').filter((segment) => segment && segment !== '.')
  if (segments.some((segment) => segment === '..')) throw new Error('Workspace library path must not contain traversal segments')
  if (!ALLOWED_ROOTS.includes(segments[0] as typeof ALLOWED_ROOTS[number])) {
    throw new Error('Workspace library path must stay under allowed workspace library roots')
  }
  return segments.join('/')
}

export function normalizeWorkspaceAssetPath(workspaceDir: string, workspacePath: string): NormalizedWorkspaceAssetPath {
  const safePath = assertSafeWorkspaceRelativePath(workspacePath)
  const root = resolve(workspaceDir)
  const absolutePath = resolve(root, ...safePath.split('/'))
  const back = relative(root, absolutePath)
  if (!back || back.startsWith('..') || isAbsolute(back)) throw new Error('Workspace library path escapes the workspace root')
  return { workspacePath: safePath, absolutePath }
}

function extensionOf(workspacePath: string): string {
  return extname(workspacePath).slice(1).toLowerCase()
}

function isGlbOrGltf(workspacePath: string): boolean {
  return /\.(glb|gltf)$/i.test(workspacePath)
}

function sourceScopeFor(workspacePath: string): AssetLibrarySourceScope {
  return workspacePath.startsWith('Exports/') ? 'exports' : 'workflows'
}

export function classifyAssetLibraryCandidate(candidate: AssetLibraryClassificationCandidate): AssetLibraryClassification {
  const extension = extensionOf(candidate.workspacePath)

  if (candidate.workspacePath.endsWith('.landmarks.v1.json')) {
    return { capability: 'landmarks-sidecar', state: 'ready', previewKind: 'text', openable: false, nonOpenableReason: 'Landmark sidecars require opening their source mesh.' }
  }
  if (candidate.workspacePath.endsWith('.world.json')) {
    return { capability: 'generated-world', state: 'ready', previewKind: 'text', openable: false, nonOpenableReason: 'Generated worlds are list-only in this release.' }
  }
  if (candidate.workspacePath.endsWith('.scene.json') || candidate.workspacePath.endsWith('/scene-manifest.json')) {
    return { capability: 'scene-manifest', state: 'ready', previewKind: 'text', openable: false, nonOpenableReason: 'Scene manifests are list-only in this release.' }
  }
  if (INTRINSIC_MOTION_EXTENSIONS.has(extension)) {
    return { capability: 'animation-motion', state: 'ready', previewKind: 'binary', openable: false, nonOpenableReason: 'Motion files are list-only in this release.' }
  }
  if (extension === 'glb' || extension === 'gltf') {
    return { capability: candidate.hasRigMetadata ? 'rigged-mesh' : 'mesh', state: 'ready', previewKind: '3d-model', openable: true }
  }
  if (MESH_EXTENSIONS.has(extension)) {
    return { capability: 'mesh', state: 'ready', previewKind: 'binary', openable: false, nonOpenableReason: `.${extension} workspace assets are list-only in this release.` }
  }
  if (TEXT_EXTENSIONS.has(extension)) {
    return { state: 'unsupported', previewKind: 'text', openable: false, nonOpenableReason: 'Unsupported workspace asset.' }
  }
  return { state: 'unsupported', previewKind: 'binary', openable: false, nonOpenableReason: 'Unsupported workspace asset.' }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function manifestCapabilityFor(workspacePath: string): 'generated-world' | 'scene-manifest' | undefined {
  if (workspacePath.endsWith('.world.json')) return 'generated-world'
  if (workspacePath.endsWith('.scene.json')) return 'scene-manifest'
  if (workspacePath.endsWith('/scene-manifest.json')) return 'scene-manifest'
  return undefined
}

async function safeLinkedWorkspacePath(workspaceDir: string, ownerWorkspacePath: string, candidate: unknown, expected?: { mustBeMesh?: boolean, mustBeManifest?: boolean }): Promise<{ workspacePath?: string, warning?: string }> {
  const raw = stringField(candidate)
  if (!raw) return {}
  let normalized: NormalizedWorkspaceAssetPath
  try {
    normalized = normalizeWorkspaceAssetPath(workspaceDir, raw)
  } catch {
    return { warning: 'Ignored unsafe linked workspace path.' }
  }
  if (normalized.workspacePath === ownerWorkspacePath) return { warning: 'Ignored self-linked workspace path.' }
  if (expected?.mustBeMesh && !isGlbOrGltf(normalized.workspacePath)) return { warning: 'Ignored non-GLB/GLTF source workspace path.' }
  if (expected?.mustBeManifest && !manifestCapabilityFor(normalized.workspacePath)) return { warning: 'Ignored non-manifest workspace path.' }
  try {
    await stat(normalized.absolutePath)
  } catch {
    return { warning: 'Ignored missing linked workspace path.' }
  }
  return { workspacePath: normalized.workspacePath }
}

async function readMetadata(workspaceDir: string, workspacePath: string, absolutePath: string): Promise<AssetLibraryMetadata> {
  const metadata: AssetLibraryMetadata = { warnings: [] }
  if (extensionOf(workspacePath) !== 'json') return metadata

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(await readFile(absolutePath, 'utf8')) as Record<string, unknown>
  } catch {
    return metadata
  }

  const sourceRaw = parsed.sourceWorkspacePath ?? parsed.source_workspace_path ?? parsed.sourcePath ?? objectField(parsed.source)?.workspacePath
  const source = await safeLinkedWorkspacePath(workspaceDir, workspacePath, sourceRaw, { mustBeMesh: true })
  if (source.workspacePath) metadata.sourceWorkspacePath = source.workspacePath
  if (source.warning) metadata.warnings.push(source.warning)

  const manifestRaw = parsed.manifestWorkspacePath ?? parsed.manifest_workspace_path ?? objectField(parsed.manifest)?.workspacePath
  const manifest = await safeLinkedWorkspacePath(workspaceDir, workspacePath, manifestRaw, { mustBeManifest: true })
  if (manifest.workspacePath) metadata.manifestWorkspacePath = manifest.workspacePath
  if (manifest.warning) metadata.warnings.push(manifest.warning)

  metadata.artifactId = stringField(parsed.artifactId ?? parsed.artifact_id)
  metadata.versionId = stringField(parsed.versionId ?? parsed.version_id)
  metadata.provenance = objectField(parsed.provenance) as ArtifactProvenance | undefined
  return metadata
}

function shouldSkipDirectory(name: string): boolean {
  return name.startsWith('.') || SKIPPED_DIRS.has(name.toLowerCase())
}

function shouldSkipFile(name: string): boolean {
  return name.startsWith('.') || INTERNAL_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

async function hasRigMetadata(absolutePath: string): Promise<boolean> {
  if (!/\.(glb|gltf)$/i.test(absolutePath)) return false
  const stem = absolutePath.replace(/\.(glb|gltf)$/i, '')
  try {
    await stat(`${stem}.rigmeta.json`)
    return true
  } catch {
    return false
  }
}

async function buildEntry(workspaceDir: string, workspacePath: string): Promise<AssetLibraryEntry> {
  const { absolutePath } = normalizeWorkspaceAssetPath(workspaceDir, workspacePath)
  const stats = await stat(absolutePath)
  const classification = classifyAssetLibraryCandidate({ workspacePath, hasRigMetadata: await hasRigMetadata(absolutePath) })
  const metadata = await readMetadata(workspaceDir, workspacePath, absolutePath)
  const manifestCapability = metadata.manifestWorkspacePath ? manifestCapabilityFor(metadata.manifestWorkspacePath) : undefined
  return {
    id: `library:${workspacePath}`,
    workspacePath,
    displayName: basename(workspacePath),
    sourceScope: sourceScopeFor(workspacePath),
    capability: classification.capability,
    state: classification.state,
    previewKind: classification.previewKind,
    source: metadata.sourceWorkspacePath ? { workspacePath: metadata.sourceWorkspacePath, displayName: basename(metadata.sourceWorkspacePath), role: 'source-mesh' } : undefined,
    manifest: metadata.manifestWorkspacePath && manifestCapability ? { workspacePath: metadata.manifestWorkspacePath, capability: manifestCapability } : undefined,
    artifactId: metadata.artifactId,
    versionId: metadata.versionId,
    provenance: metadata.provenance,
    warnings: metadata.warnings,
    openable: classification.openable,
    nonOpenableReason: classification.nonOpenableReason,
    createdAt: (stats.birthtime.getTime() > 0 ? stats.birthtime : stats.mtime).toISOString(),
    updatedAt: stats.mtime.toISOString(),
  }
}

async function collectFiles(workspaceDir: string, rootName: typeof ALLOWED_ROOTS[number]): Promise<string[]> {
  const root = join(workspaceDir, rootName)
  const files: string[] = []

  async function walk(dir: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof readdir>>
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entry.name)) await walk(join(dir, entry.name))
        continue
      }
      if (!entry.isFile() || shouldSkipFile(entry.name)) continue
      files.push(relative(workspaceDir, join(dir, entry.name)).split(sep).join('/'))
    }
  }

  await walk(root)
  return files
}

export async function listWorkspaceAssetLibrary(request: WorkspaceAssetLibraryRequest): Promise<AssetLibraryListResult> {
  try {
    const workspacePaths = (await Promise.all(ALLOWED_ROOTS.map((root) => collectFiles(request.workspaceDir, root)))).flat().sort()
    const entries = await Promise.all(workspacePaths.map((workspacePath) => buildEntry(request.workspaceDir, workspacePath)))
    return { success: true, entries: entries.filter((entry) => entry.state !== 'unsupported') }
  } catch (error) {
    return { success: false, error: libraryError('list-failed', error instanceof Error ? error.message : String(error)) }
  }
}

async function previewEntry(absolutePath: string, entry: AssetLibraryEntry): Promise<AssetLibraryPreviewPayload> {
  if (entry.previewKind === '3d-model') return { kind: '3d-model', viewerKind: extensionOf(entry.workspacePath) as 'glb' | 'gltf' }
  const stats = await stat(absolutePath)
  if (entry.previewKind === 'text') {
    const maxBytes = 64 * 1024
    const content = await readFile(absolutePath, 'utf8')
    return { kind: 'text', content: content.slice(0, maxBytes), byteLength: stats.size, truncated: content.length > maxBytes }
  }
  if (entry.previewKind === 'binary') {
    return { kind: 'binary', binaryKind: extensionOf(entry.workspacePath), byteLength: stats.size, message: 'Binary preview is unavailable.' }
  }
  return { kind: 'none' }
}

export async function readWorkspaceAssetLibraryEntry(request: WorkspaceAssetLibraryReadRequest): Promise<AssetLibraryReadResult> {
  try {
    const normalized = normalizeWorkspaceAssetPath(request.workspaceDir, request.workspacePath)
    const sourceValidation = await validateRequestedSource(request.workspaceDir, normalized.workspacePath, request.sourceWorkspacePath)
    if (!sourceValidation.success) return { success: false, error: sourceValidation.error }
    const entry = await buildEntry(request.workspaceDir, normalized.workspacePath)
    return { success: true, entry, preview: await previewEntry(normalized.absolutePath, entry) }
  } catch (error) {
    return { success: false, error: libraryError('unsafe-path', error instanceof Error ? error.message : String(error)) }
  }
}

async function validateRequestedSource(workspaceDir: string, workspacePath: string, sourceWorkspacePath?: string): Promise<{ success: true } | { success: false, error: AssetLibraryError }> {
  if (!sourceWorkspacePath) return { success: true }
  let source: NormalizedWorkspaceAssetPath
  try {
    source = normalizeWorkspaceAssetPath(workspaceDir, sourceWorkspacePath)
  } catch (error) {
    return { success: false, error: libraryError('unsafe-path', error instanceof Error ? error.message : String(error)) }
  }
  if (source.workspacePath === workspacePath) return { success: false, error: libraryError('not-openable', 'Linked source must not point to the same workspace asset.') }
  if (!isGlbOrGltf(source.workspacePath)) return { success: false, error: libraryError('not-openable', 'Linked source must be a safe .glb/.gltf workspace asset.') }
  try {
    await stat(source.absolutePath)
  } catch {
    return { success: false, error: libraryError('not-openable', 'Linked source workspace asset was not found.') }
  }
  const entry = await buildEntry(workspaceDir, workspacePath)
  if (entry.source?.workspacePath !== source.workspacePath) {
    return { success: false, error: libraryError('not-openable', 'Requested source does not match the indexed library source link.') }
  }
  return { success: true }
}

export async function openWorkspaceAssetLibraryEntry(request: WorkspaceAssetLibraryReadRequest): Promise<AssetLibraryOpenResult> {
  const read = await readWorkspaceAssetLibraryEntry(request)
  if (!read.success) return read
  if (request.sourceWorkspacePath) return { success: true, entry: read.entry }
  if (!read.entry.openable) {
    return { success: false, error: libraryError('not-openable', read.entry.nonOpenableReason ?? 'Workspace asset is not openable.') }
  }
  return { success: true, entry: read.entry }
}

function readPayloadRequest(payload: unknown): { workspacePath?: string, sourceWorkspacePath?: string } {
  if (typeof payload !== 'object' || payload === null) return {}
  const values = payload as { workspacePath?: unknown, sourceWorkspacePath?: unknown }
  return {
    workspacePath: typeof values.workspacePath === 'string' ? values.workspacePath : undefined,
    sourceWorkspacePath: typeof values.sourceWorkspacePath === 'string' ? values.sourceWorkspacePath : undefined,
  }
}

export function registerWorkspaceAssetLibraryIpcHandlers(deps: WorkspaceAssetLibraryIpcDeps): void {
  deps.ipcMain.handle('workspace:library:list', async () => listWorkspaceAssetLibrary({ workspaceDir: deps.getWorkspaceDir() }))
  deps.ipcMain.handle('workspace:library:read', async (_event, payload) => {
    const { workspacePath, sourceWorkspacePath } = readPayloadRequest(payload)
    if (!workspacePath) return { success: false, error: libraryError('invalid-request', 'workspacePath is required.') }
    return readWorkspaceAssetLibraryEntry({ workspaceDir: deps.getWorkspaceDir(), workspacePath, sourceWorkspacePath })
  })
  deps.ipcMain.handle('workspace:library:open', async (_event, payload) => {
    const { workspacePath, sourceWorkspacePath } = readPayloadRequest(payload)
    if (!workspacePath) return { success: false, error: libraryError('invalid-request', 'workspacePath is required.') }
    return openWorkspaceAssetLibraryEntry({ workspaceDir: deps.getWorkspaceDir(), workspacePath, sourceWorkspacePath })
  })
}

// Artifact sidecars are also available outside the asset-library roots.
import type { ArtifactRegistryReadResult, ArtifactRegistryWriteResult, ArtifactSidecar, EditedSceneArtifactWriteRequest, EditedSceneArtifactWriteResult, LandmarkSidecarWriteRequest, LandmarkSidecarWriteResult, RigMetaSidecarReadResult, RigRenameSidecarV1, RigRenameSidecarWriteRequest, RigRenameSidecarWriteResult } from '../../src/shared/types/electron.d'

const SIDECAR_SUFFIX = '.artifact.json'
const LANDMARK_SIDECAR_PREFIX = 'Workflows/landmarks/'
const LANDMARK_SIDECAR_SUFFIX = '.landmarks.v1.json'
const RIG_RENAME_SIDECAR_PREFIX = 'Workflows/rig-edits/'
const RIG_RENAME_SIDECAR_SUFFIX = '.rig.v1.json'
const POSE_CLIP_SIDECAR_PREFIX = 'Workflows/pose-clips/'
const POSE_CLIP_SIDECAR_SUFFIX = '.pose-clip.v1.json'
const RIGMETA_MESH_EXTENSION_PATTERN = /\.(glb|gltf)$/i
const SUPPORTED_RIGMETA_SCHEMA_VALUES = new Set([
  'modly.rigmeta',
  'modly.unirig.rigmeta',
  'unirig.rigmeta',
])
const REQUIRED_LANDMARK_IDS = ['left_shoulder', 'right_shoulder', 'hip', 'left_knee', 'right_knee'] as const
const REQUIRED_LANDMARK_ID_SET = new Set<string>(REQUIRED_LANDMARK_IDS)

export interface NormalizedWorkspaceArtifactPath {
  workspacePath: string
  absolutePath: string
}

export interface ArtifactRegistryReadRequest {
  workspaceDir: string
  workspacePath: string
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
  sourceWorkspacePath: string
}

export interface RigMetaSidecarReadServiceRequest {
  workspaceDir: string
  sourceWorkspacePath: string
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

export interface ArtifactRegistryIpcMainLike {
  handle(channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>): void
}

export interface ArtifactRegistryIpcRegistrationDeps {
  ipcMain: ArtifactRegistryIpcMainLike
  getWorkspaceDir: () => string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}


function normalizeWorkspaceSeparators(workspacePath: string): string {
  return workspacePath.replace(/\\/g, '/')
}

function assertSafeWorkspacePathInput(workspacePath: string): string {
  if (typeof workspacePath !== 'string') throw new Error('Artifact workspace path must be a string')
  const normalized = normalizeWorkspaceSeparators(workspacePath.trim())
  if (ENCODED_ESCAPE_PATTERN.test(normalized) || normalized.includes('\0')) throw new Error('Artifact workspace path must not contain encoded escapes or NUL')
  if (!normalized || normalized === '.') {
    throw new Error('Artifact workspace path must be workspace-relative and non-empty')
  }
  if (isAbsolute(normalized) || isWindowsAbsolutePath(normalized)) {
    throw new Error('Artifact workspace path must not be absolute')
  }
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '..')) {
    throw new Error('Artifact workspace path must not contain traversal segments')
  }
  return segments.filter((segment) => segment !== '' && segment !== '.').join('/')
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

  if (isRecord(value.target) && isRecord(value.artifacts)
    && (value.target.artifactId !== value.artifacts.targetArtifactId || value.target.versionId !== value.artifacts.targetVersionId)) {
    errors.push('target_artifact_binding_mismatch')
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
function validateRigRenameSidecarV1Payload(value: unknown, sourceWorkspacePath: string): string[] {
  if (!isRecord(value)) return ['invalid_sidecar']

  const errors: string[] = []
  // A source/context-bound empty plan persists removal of the final saved alias.
  const emptyAliases = isRecord(value.aliases) && Object.keys(value.aliases).length === 0
  if (value.schema !== 'modly.rig.rename-plan') errors.push('invalid_schema')
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

  if (!isRecord(value.skeleton)) {
    errors.push('invalid_skeleton')
  } else {
    if (!Array.isArray(value.skeleton.rootBoneIds) || value.skeleton.rootBoneIds.some((id) => typeof id !== 'string' || id.length === 0)) errors.push('invalid_skeleton_root_bone_ids')
    if (typeof value.skeleton.boneCount !== 'number' || !Number.isInteger(value.skeleton.boneCount) || value.skeleton.boneCount < 1) errors.push('invalid_skeleton_bone_count')
    if (!Array.isArray(value.skeleton.bones) || (value.skeleton.bones.length === 0 && !emptyAliases)) {
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

  if (!isRecord(value.aliases)) {
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
    } else if (outputMesh !== basename(sourceWorkspacePath)
      && outputMesh.replace(/\\/g, '/') !== sourceWorkspacePath) {
      errors.push('output_mesh_mismatch')
    }
  }

  if (isRecord(value.source) && value.source.workspacePath !== undefined
    && value.source.workspacePath !== sourceWorkspacePath) errors.push('source_workspace_path_mismatch')

  return errors
}

function createRigMetaWorkspacePath(sourceWorkspacePath: string): string | null {
  if (!RIGMETA_MESH_EXTENSION_PATTERN.test(sourceWorkspacePath)) return null
  return sourceWorkspacePath.replace(RIGMETA_MESH_EXTENSION_PATTERN, '.rigmeta.json')
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
  const humanoidContract = isRecord(rigMeta.humanoid_contract) && isRecord(rigMeta.humanoid_contract.bones)
    ? rigMeta.humanoid_contract.bones
    : rigMeta.humanoid_contract
  collectRigMetaNamingRecord(humanoidContract, 'humanoid_contract', namingByBoneId, warnings)

  if (Object.keys(namingByBoneId).length === 0) {
    warnings.push('Rigmeta did not contain supported naming entries.')
  }

  return { namingByBoneId, warnings }
}

function collectRigMetaNamingRecord(
  value: unknown,
  source: 'semantic_candidates' | 'humanoid_contract',
  output: Extract<RigMetaSidecarReadResult, { status: 'found' }>['namingByBoneId'],
  warnings: string[],
): void {
  if (!isRecord(value)) return

  let invalidCount = 0
  for (const [boneId, candidate] of Object.entries(value)) {
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

async function assertPathDoesNotExist(absolutePath: string, label: string): Promise<void> {
  try {
    await lstat(absolutePath)
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return
    }
    throw error
  }
  throw new Error(`Edited scene artifact ${label} already exists; refusing to overwrite`)
}

/**
 * The configured root may itself be a trusted symlink. Descendants may not:
 * validate every existing component with lstat, including broken links.
 * This is static-path confinement, not an OS sandbox against concurrent hostile
 * directory replacement by another process with write access to the workspace.
 */
async function physicalArtifactPath(
  workspaceDir: string,
  workspacePath: string,
  mode: 'read' | 'write' | 'optional' = 'read',
): Promise<NormalizedWorkspaceArtifactPath> {
  const normalized = normalizeWorkspaceArtifactPath(workspaceDir, workspacePath)
  const root = await realpath(workspaceDir)
  if (!(await lstat(root)).isDirectory()) throw new Error('Workspace root must be a directory')
  const segments = normalized.workspacePath.split('/')
  let current = root
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index])
    const leaf = index === segments.length - 1
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error
      if (mode === 'read') throw error
      if (!leaf && mode === 'write') {
        try { await mkdir(current) } catch (creationError) {
          if (!isRecord(creationError) || creationError.code !== 'EEXIST') throw creationError
        }
        info = await lstat(current)
      } else {
        // Nothing below a missing component can resolve through an inner link.
        return { workspacePath: normalized.workspacePath, absolutePath: join(root, ...segments) }
      }
    }
    if (info.isSymbolicLink()) throw new Error('Artifact path must not contain inner symlinks')
    if (leaf ? !info.isFile() : !info.isDirectory()) {
      throw new Error(leaf ? 'Artifact path must be a regular file' : 'Artifact ancestor must be a directory')
    }
  }
  return { workspacePath: normalized.workspacePath, absolutePath: current }
}

async function readArtifactJson(workspaceDir: string, workspacePath: string): Promise<unknown> {
  const target = await physicalArtifactPath(workspaceDir, workspacePath)
  const file = await open(target.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!(await file.stat()).isFile()) throw new Error('Artifact path must be a regular file')
    return JSON.parse(await file.readFile('utf8'))
  } finally { await file.close() }
}

function serializeArtifactJson(value: unknown): string {
  const data = JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === 'number' && !Number.isFinite(entry)) throw new Error('Artifact JSON numbers must be finite')
    if (typeof entry === 'bigint' || typeof entry === 'function' || typeof entry === 'symbol') throw new Error('Artifact data must be JSON serializable')
    return entry
  }, 2)
  if (!data) throw new Error('Artifact data must be JSON serializable')
  return data
}

async function prepareArtifactFile(workspaceDir: string, workspacePath: string, bytes: string | Uint8Array) {
  const target = await physicalArtifactPath(workspaceDir, workspacePath, 'write')
  // mkdtemp owns a fresh directory even when simultaneous writes share timestamp/pid.
  const temporaryDirectory = await mkdtemp(join(dirname(target.absolutePath), '.modly-artifact-'))
  const temporaryPath = join(temporaryDirectory, 'content')
  try {
    await writeFile(temporaryPath, bytes, { flag: 'wx', mode: 0o600 })
    const identity = await lstat(temporaryPath)
    return { target, temporaryDirectory, temporaryPath, identity }
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true })
    throw error
  }
}

type PreparedArtifactFile = Awaited<ReturnType<typeof prepareArtifactFile>>

async function removeOwnedArtifact(file: PreparedArtifactFile): Promise<void> {
  try {
    const current = await lstat(file.target.absolutePath)
    if (current.isFile() && current.dev === file.identity.dev && current.ino === file.identity.ino) {
      await rm(file.target.absolutePath)
    }
  } catch (error) {
    if (!isRecord(error) || error.code !== 'ENOENT') throw error
  }
}

async function publishArtifactFiles(
  workspaceDir: string,
  files: Array<{ workspacePath: string, bytes: string | Uint8Array }>,
  overwrite = false,
): Promise<void> {
  const prepared: PreparedArtifactFile[] = []
  const published: PreparedArtifactFile[] = []
  try {
    for (const file of files) prepared.push(await prepareArtifactFile(workspaceDir, file.workspacePath, file.bytes))
    for (const file of prepared) {
      await physicalArtifactPath(workspaceDir, file.target.workspacePath, 'write')
      if (overwrite) {
        // Only deterministic single-sidecar updates may replace a previous file.
        if (files.length !== 1) throw new Error('Multi-file artifact overwrite is unsupported')
        await rename(file.temporaryPath, file.target.absolutePath)
      } else {
        // link publishes complete bytes exclusively, without rename's clobber semantics.
        await link(file.temporaryPath, file.target.absolutePath)
      }
      published.push(file)
    }
  } catch (error) {
    for (const file of published.reverse()) await removeOwnedArtifact(file)
    throw error
  } finally {
    for (const file of prepared) await rm(file.temporaryDirectory, { recursive: true, force: true })
  }
}

// Shared across both IPC writers; the key includes the physical workspace root.
// This coordinates in-process writes, not hostile external directory replacement.
const authoredSidecarPublications = new Map<string, Promise<void>>()

async function publishSourceOwnedSidecar(
  workspaceDir: string,
  workspacePath: string,
  sourceWorkspacePath: string,
  bytes: string,
  validate: (value: unknown, sourceWorkspacePath: string) => string[],
): Promise<void> {
  const target = await physicalArtifactPath(workspaceDir, workspacePath, 'optional')
  const previous = authoredSidecarPublications.get(target.absolutePath) ?? Promise.resolve()
  let release!: () => void
  const turn = new Promise<void>((resolve) => { release = resolve })
  const queued = previous.then(() => turn)
  authoredSidecarPublications.set(target.absolutePath, queued)
  await previous
  try {
    let existing: unknown
    try {
      existing = await readArtifactJson(workspaceDir, workspacePath)
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') {
        throw new Error('Existing sidecar ownership cannot be read; preserve or relocate it before saving.', { cause: error })
      }
    }
    if (existing !== undefined) {
      // Validate the entire stored record, not an untrusted source field alone.
      if (!isRecord(existing) || !isRecord(existing.source) || typeof existing.source.workspacePath !== 'string'
        || validate(existing, existing.source.workspacePath).length > 0) {
        throw new Error('Existing sidecar ownership is invalid; preserve or relocate it before saving.')
      }
      if (existing.source.workspacePath !== sourceWorkspacePath) {
        throw new Error('Existing sidecar belongs to a different source owner; use a distinct sidecar path.')
      }
    }
    await publishArtifactFiles(workspaceDir, [{ workspacePath, bytes }], true)
  } finally {
    release()
    if (authoredSidecarPublications.get(target.absolutePath) === queued) authoredSidecarPublications.delete(target.absolutePath)
  }
}

export async function writeArtifactSidecar(request: ArtifactRegistryWriteRequest): Promise<ArtifactRegistryWriteResult> {
  try {
    const assetPath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.workspacePath)
    const sidecarPath = resolveSidecarPath(request.workspaceDir, assetPath.workspacePath)
    if (!request.artifactId?.trim() || !isRecord(request.metadata)) throw new Error('Artifact id and metadata object are required')
    await physicalArtifactPath(request.workspaceDir, assetPath.workspacePath, 'optional')
    const sidecar: ArtifactSidecar = {
      artifactId: request.artifactId,
      workspacePath: assetPath.workspacePath,
      metadata: request.metadata,
    }

    const sidecarBytes = serializeArtifactJson(sidecar)
    const serialized: unknown = JSON.parse(sidecarBytes)
    if (!isRecord(serialized) || !isRecord(serialized.metadata)) throw new Error('Artifact metadata must serialize to a JSON object')
    await publishArtifactFiles(request.workspaceDir, [{ workspacePath: sidecarPath.workspacePath, bytes: sidecarBytes }], true)

    return {
      success: true,
      sidecar: { artifactId: sidecar.artifactId, workspacePath: sidecar.workspacePath, metadata: serialized.metadata },
      sidecarPath: sidecarPath.workspacePath,
    }
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

    await physicalArtifactPath(request.workspaceDir, sourcePath.workspacePath)
    const metadataBytes = serializeArtifactJson(request.metadata)
    const metadata: unknown = JSON.parse(metadataBytes)
    if (!isRecord(metadata)) throw new Error('Edited scene artifact metadata must serialize to a JSON object')
    if (isRecord(metadata.source) && metadata.source.workspacePath !== undefined
      && metadata.source.workspacePath !== sourcePath.workspacePath) throw new Error('Edited scene artifact source binding mismatch')
    await physicalArtifactPath(request.workspaceDir, glbPath.workspacePath, 'optional')
    await physicalArtifactPath(request.workspaceDir, sidecarPath.workspacePath, 'optional')
    await assertPathDoesNotExist(glbPath.absolutePath, 'GLB')
    await assertPathDoesNotExist(sidecarPath.absolutePath, 'sidecar')

    await publishArtifactFiles(request.workspaceDir, [
      { workspacePath: glbPath.workspacePath, bytes: glbBytes },
      { workspacePath: sidecarPath.workspacePath, bytes: metadataBytes },
    ])

    return {
      success: true,
      glbWorkspacePath: glbPath.workspacePath,
      sidecarWorkspacePath: sidecarPath.workspacePath,
      metadata,
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

    const sidecarBytes = serializeArtifactJson(request.sidecar)
    const serializedSidecar: unknown = JSON.parse(sidecarBytes)
    const validationErrors = validateLandmarkSidecarV1Payload(serializedSidecar, sidecarPath.workspacePath, sourcePath.workspacePath)
    if (validationErrors.length > 0) {
      throw new Error(`Invalid landmark sidecar v1: ${validationErrors.join(', ')}`)
    }

    const sidecar = serializedSidecar as LandmarkSidecarWriteRequest['sidecar']

    await physicalArtifactPath(request.workspaceDir, sourcePath.workspacePath)
    await physicalArtifactPath(request.workspaceDir, sidecarPath.workspacePath, 'optional')
    await assertPathDoesNotExist(sidecarPath.absolutePath, 'landmark sidecar')
    await publishArtifactFiles(request.workspaceDir, [{ workspacePath: sidecarPath.workspacePath, bytes: sidecarBytes }])

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

    const sidecarBytes = serializeArtifactJson(request.sidecar)
    const serializedSidecar: unknown = JSON.parse(sidecarBytes)
    const validationErrors = validateRigRenameSidecarV1Payload(serializedSidecar, sourcePath.workspacePath)
    if (validationErrors.length > 0) {
      throw new Error(`Invalid rig rename sidecar v1: ${validationErrors.join(', ')}`)
    }

    const sidecar = serializedSidecar as RigRenameSidecarWriteRequest['sidecar']

    await physicalArtifactPath(request.workspaceDir, sourcePath.workspacePath)
    await publishSourceOwnedSidecar(request.workspaceDir, sidecarPath.workspacePath, sourcePath.workspacePath, sidecarBytes, validateRigRenameSidecarV1Payload)

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

    await physicalArtifactPath(request.workspaceDir, sourcePath.workspacePath)
    let parsedSidecar: unknown
    try {
      parsedSidecar = await readArtifactJson(request.workspaceDir, sidecarPath.workspacePath)
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
    if (validationErrors.length > 0) {
      throw new Error(`Invalid rig rename sidecar v1: ${validationErrors.join(', ')}`)
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

    const sidecarBytes = serializeArtifactJson(request.sidecar)
    const serializedSidecar: unknown = JSON.parse(sidecarBytes)
    const validationErrors = validatePoseClipSidecarV1Payload(serializedSidecar, sourcePath.workspacePath)
    if (validationErrors.length > 0) {
      throw new Error(`Invalid pose clip sidecar v1: ${validationErrors.join(', ')}`)
    }

    await physicalArtifactPath(request.workspaceDir, sourcePath.workspacePath)
    await publishSourceOwnedSidecar(request.workspaceDir, sidecarPath.workspacePath, sourcePath.workspacePath, sidecarBytes, validatePoseClipSidecarV1Payload)

    return {
      success: true,
      sidecarWorkspacePath: sidecarPath.workspacePath,
      sidecar: serializedSidecar,
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function readPoseClipSidecar(request: PoseClipSidecarReadServiceRequest): Promise<PoseClipSidecarReadResult> {
  try {
    const sidecarPath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sidecarWorkspacePath)
    const sourcePath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sourceWorkspacePath)

    assertPoseClipSidecarPath(sidecarPath.workspacePath)

    if (sidecarPath.workspacePath === sourcePath.workspacePath || sidecarPath.absolutePath === sourcePath.absolutePath) {
      throw new Error('Pose clip sidecar path must not overwrite the source artifact')
    }

    await physicalArtifactPath(request.workspaceDir, sourcePath.workspacePath)
    let parsedSidecar: unknown
    try {
      parsedSidecar = await readArtifactJson(request.workspaceDir, sidecarPath.workspacePath)
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

export async function readRigMetaSidecar(request: RigMetaSidecarReadServiceRequest): Promise<RigMetaSidecarReadResult> {
  let rigMetaWorkspacePath: string | undefined

  try {
    const sourcePath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.sourceWorkspacePath)
    rigMetaWorkspacePath = createRigMetaWorkspacePath(sourcePath.workspacePath) ?? undefined
    if (!rigMetaWorkspacePath) {
      throw new Error('Rigmeta source path must be a workspace-relative .glb or .gltf mesh path')
    }

    const rigMetaPath = normalizeWorkspaceArtifactPath(request.workspaceDir, rigMetaWorkspacePath)

    await physicalArtifactPath(request.workspaceDir, sourcePath.workspacePath)
    let parsedRigMeta: unknown
    try {
      parsedRigMeta = await readArtifactJson(request.workspaceDir, rigMetaPath.workspacePath)
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

export async function readArtifactSidecar(request: ArtifactRegistryReadRequest): Promise<ArtifactRegistryReadResult> {
  try {
    const sidecarPath = resolveSidecarPath(request.workspaceDir, request.workspacePath)
    const assetPath = normalizeWorkspaceArtifactPath(request.workspaceDir, request.workspacePath)
    await physicalArtifactPath(request.workspaceDir, assetPath.workspacePath, 'optional')
    const parsed = await readArtifactJson(request.workspaceDir, sidecarPath.workspacePath)
    if (!isRecord(parsed) || typeof parsed.artifactId !== 'string' || !parsed.artifactId.trim()
      || parsed.workspacePath !== assetPath.workspacePath || !isRecord(parsed.metadata)) {
      throw new Error('Invalid artifact sidecar schema or target binding')
    }
    const sidecar: ArtifactSidecar = { artifactId: parsed.artifactId, workspacePath: parsed.workspacePath, metadata: parsed.metadata }
    return { success: true, sidecar }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function registerArtifactRegistryIpcHandlers({ ipcMain, getWorkspaceDir }: ArtifactRegistryIpcRegistrationDeps): void {
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

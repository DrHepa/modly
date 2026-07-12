import { createHash } from 'node:crypto'
import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs'
import { rm as rmAsync } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'path'
import type { ListedExtension } from './automation-capabilities.ts'
import { assertSafeOwnershipSegment } from './extension-path-guard.ts'
import type { HfDownloadDescriptor } from './hf-download-manifest.ts'
import {
  expectedHttpsMarkerAssets,
  httpsPlanSha256,
  type HttpsDownloadAsset,
} from './https-download-manifest.ts'

export interface ModelOwnershipDescriptor {
  capabilityId: string
  bundleId: string
  weightOwnerId: string
  sharedOwner: boolean
  legacyPaths: string[]
  hfDownloads?: HfDownloadDescriptor[]
  httpsDownloads?: HttpsDownloadAsset[]
}

export interface PreferredModelPath {
  source: 'canonical' | 'legacy' | 'missing'
  path: string | null
  canonicalPath: string
  legacyPaths: string[]
}

export interface OwnerScopedDeletePlan {
  mode: 'blocked' | 'delete'
  warning: string | null
  siblingCapabilityIds: string[]
  targets: string[]
  preferredPath: PreferredModelPath
}

export interface DownloadedModelCapability {
  id: string
  name: string
  size_gb: number
}

export interface ExtensionUninstallCleanupPlan {
  weightOwnerId: string
  targets: string[]
}

type DownloadProgressLike = {
  percent: number
  file?: string
  fileIndex?: number
  totalFiles?: number
  repoIndex?: number
  totalRepos?: number
  status?: string
}

type DirEntriesReader = (dirPath: string) => string[]

function canonicalModelsRoot(modelsDir: string): string {
  const resolvedRoot = resolvePath(modelsDir)
  try {
    return realpathSync(resolvedRoot)
  } catch {
    return resolvedRoot
  }
}

function assertPathContained(
  rootPath: string,
  candidatePath: string,
  label: string,
  allowRoot = false,
): void {
  const relativePath = relative(rootPath, candidatePath)
  const escapesRoot = relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)

  if (escapesRoot || (!allowRoot && relativePath === '')) {
    throw new Error(`${label} escapes the canonical models directory`)
  }
}

function assertNoAliasedExistingComponents(
  rootPath: string,
  candidatePath: string,
  label: string,
): void {
  assertPathContained(rootPath, candidatePath, label)

  const segments = relative(rootPath, candidatePath).split(sep)
  let currentPath = rootPath
  for (const [index, segment] of segments.entries()) {
    currentPath = resolvePath(currentPath, segment)
    let entry
    try {
      entry = lstatSync(currentPath)
    } catch {
      break
    }

    if (entry.isSymbolicLink()) {
      throw new Error(
        `${label} contains a symbolic link or filesystem alias below the canonical models directory`,
      )
    }
    if (index < segments.length - 1 && !entry.isDirectory()) {
      throw new Error(
        `${label} contains a non-directory ownership path component`,
      )
    }
  }
}

function assertExistingAncestorContained(
  rootPath: string,
  candidatePath: string,
  label: string,
): void {
  if (!existsSync(rootPath)) return
  assertNoAliasedExistingComponents(rootPath, candidatePath, label)

  let existingPath = candidatePath
  while (existingPath !== rootPath && !existsSync(existingPath)) {
    const parentPath = dirname(existingPath)
    if (parentPath === existingPath) {
      throw new Error(`${label} has no ancestor inside the canonical models directory`)
    }
    existingPath = parentPath
  }

  if (existingPath === rootPath) return

  const resolvedExistingPath = realpathSync(existingPath)
  assertPathContained(
    rootPath,
    resolvedExistingPath,
    label,
    existingPath !== candidatePath,
  )
}

function parseOwnershipPath(ownershipPath: string, label: string): [string, string] {
  const segments = ownershipPath.split('/')
  if (segments.length !== 2) {
    throw new Error(`${label} must contain exactly one extension and one owner segment`)
  }

  return [
    assertSafeOwnershipSegment(segments[0], `${label} extension segment`),
    assertSafeOwnershipSegment(segments[1], `${label} owner segment`),
  ]
}

function resolveOwnedModelPath(modelsDir: string, ownershipPath: string, label: string): string {
  const rootPath = canonicalModelsRoot(modelsDir)
  const segments = parseOwnershipPath(ownershipPath, label)
  const candidatePath = resolvePath(rootPath, ...segments)
  assertPathContained(rootPath, candidatePath, label)
  assertExistingAncestorContained(rootPath, candidatePath, label)
  return candidatePath
}

function resolveContainedExistingPath(
  rootPath: string,
  candidatePath: string,
  label: string,
  containingPath?: string,
): string {
  assertPathContained(rootPath, candidatePath, label)
  const resolvedCandidatePath = realpathSync(candidatePath)
  assertPathContained(rootPath, resolvedCandidatePath, label)
  if (containingPath) {
    assertPathContained(containingPath, resolvedCandidatePath, label)
  }
  return resolvedCandidatePath
}

const HTTPS_READY_MARKER = join('.modly', 'https-assets-ready.json')
const HTTPS_READY_MARKER_KIND = 'modly.https-assets.ready'
const MAX_HTTPS_READY_MARKER_BYTES = 64 * 1024
const HASH_READ_CHUNK_BYTES = 1024 * 1024
const UTC_RFC3339_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?Z$/
const verifiedHashCache = new Map<string, true>()

function sha256FileSync(filePath: string): string {
  const handle = openSync(filePath, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(HASH_READ_CHUNK_BYTES)

  try {
    while (true) {
      const bytesRead = readSync(handle, buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    closeSync(handle)
  }

  return hash.digest('hex')
}

function verifiedHashCacheKey(filePath: string, sizeBytes: number, mtimeNs: bigint, expectedSha256: string): string {
  return `${filePath}\u0000${sizeBytes}\u0000${mtimeNs.toString()}\u0000${expectedSha256}`
}

function isVerifiedFile(
  rootPath: string,
  ownerPath: string,
  assetPath: string,
  label: string,
  expectedSizeBytes?: number,
  expectedSha256?: string,
): boolean {
  assertPathContained(ownerPath, assetPath, label)
  assertNoAliasedExistingComponents(rootPath, assetPath, label)

  const assetEntry = lstatSync(assetPath)
  if (assetEntry.isSymbolicLink() || !assetEntry.isFile()) {
    return false
  }
  if (expectedSizeBytes === undefined ? assetEntry.size <= 0 : assetEntry.size !== expectedSizeBytes) {
    return false
  }

  const resolvedAssetPath = resolveContainedExistingPath(rootPath, assetPath, label, ownerPath)
  if (!expectedSha256) return true

  const resolvedEntry = statSync(resolvedAssetPath, { bigint: true })
  const cacheKey = verifiedHashCacheKey(
    resolvedAssetPath,
    Number(resolvedEntry.size),
    resolvedEntry.mtimeNs,
    expectedSha256,
  )
  if (verifiedHashCache.has(cacheKey)) return true
  if (sha256FileSync(resolvedAssetPath) !== expectedSha256) return false
  verifiedHashCache.set(cacheKey, true)
  return true
}

function isHttpsMarkerRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasExactHttpsMarkerKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort()
  const sortedExpectedKeys = [...expectedKeys].sort()
  return actualKeys.length === sortedExpectedKeys.length
    && actualKeys.every((key, index) => key === sortedExpectedKeys[index])
}

function isUtcRfc3339Timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !UTC_RFC3339_PATTERN.test(value)) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp)
    && new Date(timestamp).toISOString().slice(0, 10) === value.slice(0, 10)
}

function markerHasExactHttpsInventory(
  markerAssets: unknown,
  plan: readonly HttpsDownloadAsset[],
): boolean {
  const expectedAssets = expectedHttpsMarkerAssets(plan)
  if (!Array.isArray(markerAssets) || markerAssets.length !== expectedAssets.length) {
    return false
  }

  return markerAssets.every((candidate, index) => {
    if (
      !isHttpsMarkerRecord(candidate)
      || !hasExactHttpsMarkerKeys(candidate, ['filename', 'size_bytes', 'sha256'])
    ) {
      return false
    }

    const expected = expectedAssets[index]
    return candidate.filename === expected.filename
      && candidate.size_bytes === expected.size_bytes
      && candidate.sha256 === expected.sha256
  })
}

function isHttpsDownloadReady(
  rootPath: string,
  ownerPath: string,
  capabilityId: string,
  plan: readonly HttpsDownloadAsset[],
): boolean {
  if (plan.length === 0) return false

  const markerPath = resolvePath(ownerPath, HTTPS_READY_MARKER)
  assertPathContained(ownerPath, markerPath, 'HTTPS download readiness marker')
  assertNoAliasedExistingComponents(
    rootPath,
    markerPath,
    'HTTPS download readiness marker',
  )

  const markerEntry = lstatSync(markerPath)
  if (
    markerEntry.isSymbolicLink()
    || !markerEntry.isFile()
    || markerEntry.size <= 0
    || markerEntry.size > MAX_HTTPS_READY_MARKER_BYTES
  ) {
    return false
  }

  const resolvedMarkerPath = resolveContainedExistingPath(
    rootPath,
    markerPath,
    'HTTPS download readiness marker',
    ownerPath,
  )
  const marker: unknown = JSON.parse(readFileSync(resolvedMarkerPath, 'utf-8'))
  if (
    !isHttpsMarkerRecord(marker)
    || !hasExactHttpsMarkerKeys(marker, [
      'schema_version',
      'kind',
      'model_id',
      'plan_sha256',
      'assets',
      'verified_at',
    ])
    || marker.schema_version !== 1
    || marker.kind !== HTTPS_READY_MARKER_KIND
    || marker.model_id !== capabilityId
    || marker.plan_sha256 !== httpsPlanSha256(plan)
    || !isUtcRfc3339Timestamp(marker.verified_at)
    || !markerHasExactHttpsInventory(marker.assets, plan)
  ) {
    return false
  }

  for (const asset of plan) {
    if (basename(asset.filename) !== asset.filename) return false

    const assetPath = resolvePath(ownerPath, asset.filename)
    if (!isVerifiedFile(
      rootPath,
      ownerPath,
      assetPath,
      'HTTPS model asset path',
      asset.sizeBytes,
      asset.sha256,
    )) {
      return false
    }
  }

  return true
}

function assertSafeDeleteTarget(modelsDir: string, target: string): string {
  const rootPath = canonicalModelsRoot(modelsDir)
  const candidatePath = resolvePath(target)
  assertPathContained(rootPath, candidatePath, 'Model delete target')

  const segments = relative(rootPath, candidatePath).split(sep)
  if (segments.length !== 2) {
    throw new Error('Model delete target must contain exactly one extension and one owner segment')
  }
  assertSafeOwnershipSegment(segments[0], 'Model delete extension segment')
  assertSafeOwnershipSegment(segments[1], 'Model delete owner segment')
  assertExistingAncestorContained(rootPath, candidatePath, 'Model delete target')
  return candidatePath
}

export function getCanonicalModelPath(modelsDir: string, ownership: Pick<ModelOwnershipDescriptor, 'weightOwnerId'>): string {
  return resolveOwnedModelPath(modelsDir, ownership.weightOwnerId, 'Canonical model owner path')
}

export function getLegacyModelPaths(modelsDir: string, ownership: Pick<ModelOwnershipDescriptor, 'legacyPaths'>): string[] {
  return ownership.legacyPaths.map((legacyPath) => (
    resolveOwnedModelPath(modelsDir, legacyPath, 'Legacy model owner path')
  ))
}

export function selectPreferredModelPath(
  modelsDir: string,
  ownership: ModelOwnershipDescriptor,
  pathExists: (candidatePath: string) => boolean = existsSync,
): PreferredModelPath {
  const canonicalPath = getCanonicalModelPath(modelsDir, ownership)
  const legacyPaths = getLegacyModelPaths(modelsDir, ownership)

  if (pathExists(canonicalPath)) {
    return {
      source: 'canonical',
      path: canonicalPath,
      canonicalPath,
      legacyPaths,
    }
  }

  for (const legacyPath of legacyPaths) {
    if (legacyPath === canonicalPath) continue
    if (!pathExists(legacyPath)) continue

    return {
      source: 'legacy',
      path: legacyPath,
      canonicalPath,
      legacyPaths,
    }
  }

  return {
    source: 'missing',
    path: null,
    canonicalPath,
    legacyPaths,
  }
}

export function resolveModelOwnership(
  extensions: ListedExtension[],
  capabilityId: string,
): ModelOwnershipDescriptor | null {
  for (const extension of extensions) {
    if (extension.type !== 'model') continue

    for (const node of extension.nodes) {
      const nodeCapabilityId = node.capabilityId ?? `${extension.id}/${node.id}`
      if (nodeCapabilityId !== capabilityId) continue

      return {
        capabilityId: nodeCapabilityId,
        bundleId: node.bundleId ?? extension.id,
        weightOwnerId: node.weightOwnerId ?? nodeCapabilityId,
        sharedOwner: node.sharedOwner ?? false,
        legacyPaths: [...(node.legacyPaths ?? [nodeCapabilityId])],
        ...(node.hfDownloads ? { hfDownloads: node.hfDownloads } : {}),
        ...(node.httpsDownloads ? { httpsDownloads: node.httpsDownloads } : {}),
      }
    }
  }

  return null
}

export function resolveShowInFolderPath(modelsDir: string, ownership: ModelOwnershipDescriptor): string | null {
  try {
    return selectPreferredModelPath(modelsDir, ownership).path
  } catch {
    return null
  }
}

export function isOwnedModelDownloaded(
  modelsDir: string,
  ownership: ModelOwnershipDescriptor,
  readDir: DirEntriesReader = readdirSync,
): boolean {
  try {
    const preferredPath = selectPreferredModelPath(modelsDir, ownership)
    if (!preferredPath.path) return false

    const rootPath = canonicalModelsRoot(modelsDir)
    const ownerPath = resolveContainedExistingPath(
      rootPath,
      preferredPath.path,
      'Model owner path',
    )

    if (ownership.httpsDownloads?.length) {
      return isHttpsDownloadReady(
        rootPath,
        ownerPath,
        ownership.capabilityId,
        ownership.httpsDownloads,
      )
    }

    if (ownership.hfDownloads?.length) {
      return ownership.hfDownloads.every((descriptor) => descriptor.files.every((file) => {
        const assetPath = resolvePath(ownerPath, descriptor.targetSubdir, file.path)
        return isVerifiedFile(
          rootPath,
          ownerPath,
          assetPath,
          'Model asset path',
          undefined,
          file.sha256,
        )
      }))
    }
    return readDir(ownerPath).length > 0
  } catch {
    return false
  }
}

export function createOwnerScopedDeletePlan(
  modelsDir: string,
  ownership: ModelOwnershipDescriptor,
  siblingCapabilityIds: string[],
): OwnerScopedDeletePlan {
  let preferredPath: PreferredModelPath
  try {
    preferredPath = selectPreferredModelPath(modelsDir, ownership)
  } catch {
    return {
      mode: 'blocked',
      warning: `Unsafe model ownership path for '${ownership.weightOwnerId}'; deletion was blocked.`,
      siblingCapabilityIds: [...siblingCapabilityIds],
      targets: [],
      preferredPath: {
        source: 'missing',
        path: null,
        canonicalPath: canonicalModelsRoot(modelsDir),
        legacyPaths: [],
      },
    }
  }

  if (siblingCapabilityIds.length > 0) {
    return {
      mode: 'blocked',
      // Operational warning: deleting one capability is NOT safe while another
      // sibling still points at the same owner payload. The UI must surface the
      // sibling list so operators understand why the action was skipped.
      warning: `Delete is owner-scoped for '${ownership.weightOwnerId}' and still referenced by: ${siblingCapabilityIds.join(', ')}`,
      siblingCapabilityIds: [...siblingCapabilityIds],
      targets: [],
      preferredPath,
    }
  }

  return {
    mode: 'delete',
    warning: ownership.sharedOwner
      ? `Delete is owner-scoped for '${ownership.weightOwnerId}' and removes all aliases for this owner.`
      : null,
    siblingCapabilityIds: [],
    targets: Array.from(new Set([preferredPath.canonicalPath, ...preferredPath.legacyPaths])),
    preferredPath,
  }
}

export async function deleteOwnedModelPaths(modelsDir: string, targets: string[]): Promise<void> {
  for (const target of targets) {
    const safeTarget = assertSafeDeleteTarget(modelsDir, target)
    await rmAsync(safeTarget, { recursive: true, force: true })
  }
}

function dirSizeBytes(dirPath: string): number {
  let total = 0
  try {
    for (const entry of readdirSync(dirPath)) {
      const full = join(dirPath, entry)
      try {
        const stat = statSync(full)
        total += stat.isDirectory() ? dirSizeBytes(full) : stat.size
      } catch {
        // skip unreadable entries
      }
    }
  } catch {
    // skip unreadable dirs
  }
  return total
}

function getModelSizeFromHFMetadata(modelDir: string): number {
  const cacheDir = join(modelDir, '.cache', 'huggingface', 'download')
  if (!existsSync(cacheDir)) return 0

  let total = 0
  try {
    for (const entry of readdirSync(cacheDir)) {
      if (!entry.endsWith('.metadata')) continue
      try {
        const data = JSON.parse(readFileSync(join(cacheDir, entry), 'utf-8'))
        if (typeof data.size === 'number' && data.size > 0) total += data.size
      } catch {
        // skip malformed metadata
      }
    }
  } catch {
    // skip unreadable metadata cache
  }

  return total
}

export function listDownloadedModelCapabilities(
  modelsDir: string,
  extensions: ListedExtension[],
): DownloadedModelCapability[] {
  const downloaded: DownloadedModelCapability[] = []

  for (const extension of extensions) {
    if (extension.type !== 'model') continue

    for (const node of extension.nodes) {
      const capabilityId = node.capabilityId ?? `${extension.id}/${node.id}`
      const ownership = resolveModelOwnership(extensions, capabilityId)
      if (!ownership || !isOwnedModelDownloaded(modelsDir, ownership)) continue

      const activePath = resolveShowInFolderPath(modelsDir, ownership)
      if (!activePath) continue

      let bytes = dirSizeBytes(activePath)
      if (bytes < 1_000_000) bytes = getModelSizeFromHFMetadata(activePath)

      downloaded.push({
        id: capabilityId,
        name: node.name,
        size_gb: Math.round(bytes / 1e9 * 10) / 10,
      })
    }
  }

  return downloaded
}

export function createExtensionUninstallCleanupPlan(
  modelsDir: string,
  extensions: ListedExtension[],
  extensionId: string,
): ExtensionUninstallCleanupPlan[] {
  const targetExtension = extensions.find((extension) => extension.type === 'model' && extension.id === extensionId)
  if (!targetExtension || targetExtension.type !== 'model') return []

  const plans: ExtensionUninstallCleanupPlan[] = []
  const seenOwners = new Set<string>()

  for (const node of targetExtension.nodes) {
    const capabilityId = node.capabilityId ?? `${targetExtension.id}/${node.id}`
    const ownership = resolveModelOwnership(extensions, capabilityId)
    if (!ownership || seenOwners.has(ownership.weightOwnerId)) continue

    const ownerStillReferencedOutsideTarget = extensions
      .filter((extension) => extension.type === 'model' && extension.id !== extensionId)
      .some((extension) => extension.nodes.some((candidateNode) => {
        const candidateCapabilityId = candidateNode.capabilityId ?? `${extension.id}/${candidateNode.id}`
        return resolveModelOwnership(extensions, candidateCapabilityId)?.weightOwnerId === ownership.weightOwnerId
      }))

    seenOwners.add(ownership.weightOwnerId)
    if (ownerStillReferencedOutsideTarget) continue

    // Keep cleanup owner-scoped and de-duplicated: a bundled extension may list
    // multiple capability ids for one payload, but uninstall must remove that
    // payload once, only after the final sibling disappears.
    const deletePlan = createOwnerScopedDeletePlan(modelsDir, ownership, [])
    if (deletePlan.mode !== 'delete') continue
    plans.push({
      weightOwnerId: ownership.weightOwnerId,
      targets: deletePlan.targets,
    })
  }

  return plans
}

export function mapDownloadProgressToCapability(
  capabilityId: string,
  progress: DownloadProgressLike,
): DownloadProgressLike & { capabilityId: string; modelId: string } {
  return {
    capabilityId,
    modelId: capabilityId,
    ...progress,
  }
}

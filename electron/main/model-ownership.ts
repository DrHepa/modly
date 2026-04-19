import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { rm as rmAsync } from 'fs/promises'
import { join } from 'path'
import type { ListedExtension } from './automation-capabilities.ts'

export interface ModelOwnershipDescriptor {
  capabilityId: string
  bundleId: string
  weightOwnerId: string
  sharedOwner: boolean
  legacyPaths: string[]
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
  status?: string
}

type DirEntriesReader = (dirPath: string) => string[]

export function getCanonicalModelPath(modelsDir: string, ownership: Pick<ModelOwnershipDescriptor, 'weightOwnerId'>): string {
  return join(modelsDir, ownership.weightOwnerId)
}

export function getLegacyModelPaths(modelsDir: string, ownership: Pick<ModelOwnershipDescriptor, 'legacyPaths'>): string[] {
  return ownership.legacyPaths.map((legacyPath) => join(modelsDir, legacyPath))
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
      }
    }
  }

  return null
}

export function resolveShowInFolderPath(modelsDir: string, ownership: ModelOwnershipDescriptor): string | null {
  return selectPreferredModelPath(modelsDir, ownership).path
}

export function isOwnedModelDownloaded(
  modelsDir: string,
  ownership: ModelOwnershipDescriptor,
  readDir: DirEntriesReader = readdirSync,
): boolean {
  const preferredPath = selectPreferredModelPath(modelsDir, ownership)
  if (!preferredPath.path) return false

  try {
    return readDir(preferredPath.path).length > 0
  } catch {
    return false
  }
}

export function createOwnerScopedDeletePlan(
  modelsDir: string,
  ownership: ModelOwnershipDescriptor,
  siblingCapabilityIds: string[],
): OwnerScopedDeletePlan {
  const preferredPath = selectPreferredModelPath(modelsDir, ownership)

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

export async function deleteOwnedModelPaths(targets: string[]): Promise<void> {
  for (const target of targets) {
    await rmAsync(target, { recursive: true, force: true })
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

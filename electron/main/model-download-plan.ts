import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { describeModelOwnership, type ModelOwnershipDescriptor } from './model-ownership'

import {
  EXT_INCOMPLETE_MARKER,
  EXT_REGISTRATION_PENDING_MARKER,
  assertSafeExtensionId,
  resolveExtensionPathWithinRoot,
} from './extension-path-guard'
import { normalizeHfDownloads, type HfDownloadDescriptor } from './hf-download-manifest'
import { normalizeHttpsDownloads, type HttpsDownloadAsset } from './https-download-manifest'
import { ModelAssetDownloadError } from './model-download-events'
import {
  normalizeModelSources,
  normalizeWeightGroupReferences,
  normalizeWeightGroups,
  normalizeWeightVariants,
  validateModelNodeIds,
  safeModelSourceId,
  resolveModelRoot,
  weightGroupTargetId,
  type ModelSource,
  type ModelWeightGroup,
  type WeightVariants,
} from './model-sources'

interface InstalledNode {
  id?: unknown
  weight_owner_id?: unknown
  hf_repo?: unknown
  download_check?: unknown
  hf_skip_prefixes?: unknown
  hf_include_prefixes?: unknown
  model_sources?: unknown
  weight_groups?: unknown
  weight_variants?: unknown
  params_schema?: unknown
  hf_downloads?: unknown
  https_downloads?: unknown
}

interface InstalledManifest {
  id?: unknown
  type?: unknown
  model_sources?: unknown
  weight_groups?: unknown
  params_schema?: unknown
  nodes?: unknown
}

export interface InstalledSharedWeightGroup extends ModelWeightGroup {
  targetId: string
  dependentModelIds: string[]
}

export type InstalledModelDownloadPlan = { ownership?: ModelOwnershipDescriptor } & ({
  kind: 'legacy'
  modelId: string
  extensionId: string
  nodeId: string
  repoId: string
  downloadCheck?: string
  skipPrefixes?: string[]
  includePrefixes?: string[]
  weightVariants?: WeightVariants
} | {
  kind: 'hf-assets'
  modelId: string
  extensionId: string
  nodeId: string
  hfDownloads: HfDownloadDescriptor[]
  weightVariants?: WeightVariants
} | {
  kind: 'https-assets'
  modelId: string
  extensionId: string
  nodeId: string
  httpsDownloads: HttpsDownloadAsset[]
  weightVariants?: WeightVariants
} | {
  kind: 'multi-source'
  modelId: string
  extensionId: string
  nodeId: string
  sources: ModelSource[]
  sharedGroups: InstalledSharedWeightGroup[]
})

/** Read-through only. Downloads always target the canonical owner instead. */
export function privateModelStorageId(modelsDir: string, plan: InstalledModelDownloadPlan): string {
  if (!plan.ownership) return plan.modelId
  const { weightOwnerId, legacyPaths } = plan.ownership
  for (const id of [weightOwnerId, ...legacyPaths]) {
    if (existsSync(resolveModelRoot(modelsDir, id))) return id
  }
  return weightOwnerId
}

async function hasPendingRegistration(root: string, extensionId: string): Promise<boolean> {
  try {
    const prefix = `${EXT_REGISTRATION_PENDING_MARKER}-${extensionId}-`
    return (await readdir(root)).some((name) => (
      name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length))
    ))
  } catch {
    return false
  }
}

function installedSharedGroups(
  manifest: InstalledManifest,
  extensionId: string,
  nodes: InstalledNode[],
): InstalledSharedWeightGroup[] {
  const groups = normalizeWeightGroups(manifest)
  if (groups || nodes.some((node) => node.model_sources !== undefined || node.weight_groups !== undefined)) {
    validateModelNodeIds(manifest.nodes as InstalledNode[])
  }
  if (groups === undefined) return []
  const groupDependents = new Map<string, string[]>()
  for (const candidate of nodes) {
    if (typeof candidate.id === 'string' && candidate.id.toLowerCase() === '_shared') {
      throw new Error('manifest.json: model node id "_shared" is reserved')
    }
    const candidateId = safeModelSourceId(candidate.id, 'model node id')
    const refs = normalizeWeightGroupReferences(
      candidate,
      groups,
      `nodes[${candidateId}].weight_groups`,
    ) ?? []
    for (const groupId of refs) {
      const dependents = groupDependents.get(groupId) ?? []
      dependents.push(`${extensionId}/${candidateId}`)
      groupDependents.set(groupId, dependents)
    }
  }
  return groups.map((group) => ({
    ...group,
    targetId: weightGroupTargetId(extensionId, group.id),
    dependentModelIds: groupDependents.get(group.id) ?? [],
  }))
}

function parseManifest(raw: string, extensionId: string, nodeId: string, validateStorageOwnership = false): InstalledModelDownloadPlan {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Extension "${extensionId}" has an invalid manifest.json`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Extension "${extensionId}" has an invalid manifest.json`)
  }
  const manifest = parsed as InstalledManifest
  if (manifest.id !== extensionId) throw new Error(`Installed manifest id does not match extension "${extensionId}"`)
  if (manifest.type !== undefined && manifest.type !== 'model') {
    throw new Error(`Extension "${extensionId}" is not a model extension`)
  }
  if (manifest.model_sources !== undefined) {
    throw new Error('manifest.json: model_sources must be declared on a model node')
  }
  if (!Array.isArray(manifest.nodes)) throw new Error(`Extension "${extensionId}" does not declare model nodes`)

  const nodes = manifest.nodes.filter((candidate): candidate is InstalledNode => (
    typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
  ))
  const allSharedGroups = installedSharedGroups(manifest, extensionId, nodes)

  const matches = nodes.filter((candidate) => candidate.id === nodeId)
  if (matches.length !== 1) {
    throw new Error(`Installed manifest must declare model node "${nodeId}" exactly once`)
  }

  const node = matches[0]
  const modelId = `${extensionId}/${nodeId}`
  const ownership = validateStorageOwnership || nodes.some((candidate) => candidate.weight_owner_id !== undefined)
    ? describeModelOwnership(extensionId, nodes).find((candidate) => candidate.capabilityId === modelId)
    : undefined
  const weightVariants = normalizeWeightVariants(node, node.params_schema ?? manifest.params_schema)
  const sources = normalizeModelSources(node)
  const refs = normalizeWeightGroupReferences(
    node,
    allSharedGroups,
    `nodes[${nodeId}].weight_groups`,
  ) ?? []
  const sharedGroups = refs.map((groupId) => (
    allSharedGroups.find((candidate) => candidate.id === groupId)!
  ))
  if (!sources && sharedGroups.length === 0) {
    const httpsDownloads = normalizeHttpsDownloads(node.https_downloads, 'https_downloads')
    if (httpsDownloads) return { ...(ownership ? { ownership } : {}), ...(weightVariants ? { weightVariants } : {}), kind: 'https-assets', modelId, extensionId, nodeId, httpsDownloads }
    const hfDownloads = normalizeHfDownloads(node.hf_downloads, 'hf_downloads')
    if (hfDownloads) return { ...(ownership ? { ownership } : {}), ...(weightVariants ? { weightVariants } : {}), kind: 'hf-assets', modelId, extensionId, nodeId, hfDownloads }
  }
  if (sources || sharedGroups.length > 0) {
    if (sharedGroups.length > 0 && node.hf_repo !== undefined) {
      throw new Error(`Model node "${modelId}" must use model_sources for private weights when weight_groups are declared`)
    }
    return {
      ...(ownership ? { ownership } : {}),
      kind: 'multi-source',
      modelId,
      extensionId,
      nodeId,
      sources: sources ?? [],
      sharedGroups,
    }
  }

  const malformedLegacy = (message: string): never => { throw new Error(`Model node "${modelId}" ${message}`) }
  if (typeof node.hf_repo !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(node.hf_repo)) {
    malformedLegacy('has no safe Hugging Face repository')
  }
  for (const field of ['hf_skip_prefixes', 'hf_include_prefixes'] as const) {
    const value = node[field]
    if (value !== undefined && (!Array.isArray(value) || value.some((prefix) => typeof prefix !== 'string' || !prefix.trim() || prefix !== prefix.trim()))) malformedLegacy(`${field} must be an array of non-empty strings`)
  }
  if (node.download_check !== undefined) {
    const check = node.download_check
    if (typeof check !== 'string' || !check || check !== check.trim() || check.includes('\\') || isAbsolute(check)) malformedLegacy('download_check must be a safe relative path')
    const rel = relative(resolve('/models', extensionId), resolve('/models', extensionId, nodeId, check as string))
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) malformedLegacy('download_check escapes its extension root')
  }
  if (typeof node.hf_repo !== 'string' || !node.hf_repo) {
    throw new Error(`Model node "${modelId}" has no Hugging Face download source`)
  }
  return {
    ...(ownership ? { ownership } : {}),
    kind: 'legacy',
    modelId,
    extensionId,
    nodeId,
    repoId: node.hf_repo,
    downloadCheck: typeof node.download_check === 'string' ? node.download_check : undefined,
    skipPrefixes: node.hf_skip_prefixes as string[] | undefined,
    includePrefixes: node.hf_include_prefixes as string[] | undefined,
    ...(weightVariants ? { weightVariants } : {}),
  }
}


export async function resolveInstalledExtensionSharedWeightGroups(args: {
  extensionId: unknown
  userExtensionsDir: string
  builtinExtensionsDir: string
  blockedExtensionIds?: ReadonlySet<string>
}): Promise<InstalledSharedWeightGroup[]> {
  const extensionId = assertSafeExtensionId(args.extensionId)
  if (args.blockedExtensionIds?.has(extensionId)) {
    throw new Error(`Extension "${extensionId}" is being installed or repaired`)
  }
  const userPath = resolveExtensionPathWithinRoot(args.userExtensionsDir, extensionId)
  const builtinPath = resolveExtensionPathWithinRoot(args.builtinExtensionsDir, extensionId)
  const extensionPath = existsSync(userPath) ? userPath : existsSync(builtinPath) ? builtinPath : undefined
  if (!extensionPath) throw new Error(`Extension "${extensionId}" is not installed`)
  const extensionRoot = extensionPath === userPath ? args.userExtensionsDir : args.builtinExtensionsDir
  if (
    existsSync(join(extensionPath, EXT_INCOMPLETE_MARKER))
    || existsSync(join(extensionPath, EXT_REGISTRATION_PENDING_MARKER))
    || await hasPendingRegistration(extensionRoot, extensionId)
  ) {
    throw new Error(`Extension "${extensionId}" has an incomplete installation`)
  }

  const manifestPath = join(extensionPath, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`Extension "${extensionId}" has no manifest.json`)
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf-8'))
  } catch {
    throw new Error(`Extension "${extensionId}" has an invalid manifest.json`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Extension "${extensionId}" has an invalid manifest.json`)
  }
  const manifest = parsed as InstalledManifest
  if (manifest.id !== extensionId) throw new Error(`Installed manifest id does not match extension "${extensionId}"`)
  if (manifest.type !== undefined && manifest.type !== 'model') {
    throw new Error(`Extension "${extensionId}" is not a model extension`)
  }
  if (!Array.isArray(manifest.nodes)) throw new Error(`Extension "${extensionId}" does not declare model nodes`)
  const nodes = manifest.nodes.filter((candidate): candidate is InstalledNode => (
    typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
  ))
  return installedSharedGroups(manifest, extensionId, nodes)
}

export interface LegacyDownloadStep {
  includePrefixes?: string[]
  skipPrefixes?: string[]
}

/**
 * Hugging Face filter passes for one download action. A node that declares weight
 * variants always fetches its shared files first (every variant excluded), then the
 * requested variant — its default one when no variant id is given. The shared pass
 * skips files already complete on disk, so it stays cheap on a resume or a second
 * variant.
 */
export function legacyDownloadSteps(
  plan: Extract<InstalledModelDownloadPlan, { kind: 'legacy' }>,
  variantId?: unknown,
): LegacyDownloadStep[] {
  const variants = plan.weightVariants
  if (!variants) {
    if (variantId !== undefined) {
      throw new Error(`Model node "${plan.modelId}" has no weight variant "${String(variantId)}"`)
    }
    return [{ includePrefixes: plan.includePrefixes, skipPrefixes: plan.skipPrefixes }]
  }
  const selected = variantId === undefined ? variants.default : variantId
  const variant = variants.options.find((option) => option.id === selected)
  if (!variant) throw new Error(`Model node "${plan.modelId}" has no weight variant "${String(variantId)}"`)
  return [
    {
      includePrefixes: plan.includePrefixes,
      skipPrefixes: [...(plan.skipPrefixes ?? []), ...variants.options.flatMap((option) => option.include_prefixes)],
    },
    { includePrefixes: variant.include_prefixes, skipPrefixes: plan.skipPrefixes },
  ]
}

/** Re-read the installed manifest for every model action; renderer metadata is never trusted. */
export async function resolveInstalledModelDownloadPlan(args: {
  modelId: unknown
  userExtensionsDir: string
  builtinExtensionsDir: string
  blockedExtensionIds?: ReadonlySet<string>
  validateStorageOwnership?: boolean
}): Promise<InstalledModelDownloadPlan> {
  try {
    if (typeof args.modelId !== 'string') throw new Error('Model id must be a string')
  const parts = args.modelId.split('/')
  if (parts.length !== 2) throw new Error('Model id must identify one extension node')
  const extensionId = assertSafeExtensionId(parts[0])
  if (parts[1].toLowerCase() === '_shared') throw new Error('Model node id "_shared" is reserved')
  const nodeId = safeModelSourceId(parts[1], 'model node id')
  if (args.blockedExtensionIds?.has(extensionId)) {
    throw new Error(`Extension "${extensionId}" is being installed or repaired`)
  }

  const userPath = resolveExtensionPathWithinRoot(args.userExtensionsDir, extensionId)
  const builtinPath = resolveExtensionPathWithinRoot(args.builtinExtensionsDir, extensionId)
  const extensionPath = existsSync(userPath) ? userPath : existsSync(builtinPath) ? builtinPath : undefined
  if (!extensionPath) throw new Error(`Extension "${extensionId}" is not installed`)
  const extensionRoot = extensionPath === userPath ? args.userExtensionsDir : args.builtinExtensionsDir
  if (
    existsSync(join(extensionPath, EXT_INCOMPLETE_MARKER))
    || existsSync(join(extensionPath, EXT_REGISTRATION_PENDING_MARKER))
    || await hasPendingRegistration(extensionRoot, extensionId)
  ) {
    throw new Error(`Extension "${extensionId}" has an incomplete installation`)
  }

  const manifestPath = join(extensionPath, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`Extension "${extensionId}" has no manifest.json`)
    return parseManifest(await readFile(manifestPath, 'utf-8'), extensionId, nodeId, args.validateStorageOwnership)
  } catch (error) {
    if (error instanceof ModelAssetDownloadError) throw error
    throw new ModelAssetDownloadError({
      code: 'source_plan_invalid', stage: 'validate',
      message: error instanceof Error ? error.message : String(error), retryable: false,
    })
  }
}

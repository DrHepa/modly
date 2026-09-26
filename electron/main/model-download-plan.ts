import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  assertSafeExtensionId,
  resolveExtensionPathWithinRoot,
} from './extension-path-guard'
import { normalizeHfDownloads, type HfDownloadDescriptor } from './hf-download-manifest'
import { normalizeHttpsDownloads, type HttpsDownloadAsset } from './https-download-manifest'
import {
  normalizeModelSources,
  normalizeWeightGroupReferences,
  normalizeWeightGroups,
  safeModelSourceId,
  validateModelNodeIds,
  weightGroupTargetId,
  type ModelSource,
  type ModelWeightGroup,
} from './model-sources'
import { ModelAssetDownloadError } from './model-download-events'

const EXT_INCOMPLETE_MARKER = '.modly-incomplete'
const EXT_REGISTRATION_PENDING_MARKER = '.modly-registration-pending'
const HF_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

interface InstalledNode {
  id?: unknown
  hf_repo?: unknown
  download_check?: unknown
  hf_skip_prefixes?: unknown
  hf_include_prefixes?: unknown
  hf_downloads?: unknown
  https_downloads?: unknown
  model_sources?: unknown
  weight_groups?: unknown
}

interface InstalledManifest {
  id?: unknown
  type?: unknown
  model_sources?: unknown
  weight_groups?: unknown
  nodes?: unknown
}

export interface InstalledSharedWeightGroup extends ModelWeightGroup {
  targetId: string
  dependentModelIds: string[]
}

export type InstalledModelDownloadPlan = {
  kind: 'legacy'
  modelId: string
  extensionId: string
  nodeId: string
  repoId: string
  downloadCheck?: string
  skipPrefixes?: string[]
  includePrefixes?: string[]
} | {
  kind: 'hf-assets'
  modelId: string
  extensionId: string
  nodeId: string
  hfDownloads: HfDownloadDescriptor[]
} | {
  kind: 'https-assets'
  modelId: string
  extensionId: string
  nodeId: string
  httpsDownloads: HttpsDownloadAsset[]
} | {
  kind: 'multi-source'
  modelId: string
  extensionId: string
  nodeId: string
  sources: ModelSource[]
  sharedGroups: InstalledSharedWeightGroup[]
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

function parseManifestUnsafe(raw: string, extensionId: string, nodeId: string): InstalledModelDownloadPlan {
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
  if (manifest.type !== 'model') {
    throw new Error(`Extension "${extensionId}" is not a model extension`)
  }
  if (manifest.model_sources !== undefined) {
    throw new Error('manifest.json: model_sources must be declared on a model node')
  }
  if (!Array.isArray(manifest.nodes)) throw new Error(`Extension "${extensionId}" does not declare model nodes`)

  const nodes = manifest.nodes.filter((candidate): candidate is InstalledNode => (
    typeof candidate === 'object'
    && candidate !== null
    && !Array.isArray(candidate)
  ))
  const groups = normalizeWeightGroups(manifest)
  if (groups || nodes.some((candidate) => candidate.model_sources !== undefined || candidate.weight_groups !== undefined)) {
    validateModelNodeIds(nodes)
  }
  const dependents = new Map<string, string[]>()
  for (const candidate of nodes) {
    const candidateId = safeModelSourceId(candidate.id, 'model node id')
    for (const groupId of normalizeWeightGroupReferences(candidate, groups, `nodes[${candidateId}].weight_groups`) ?? []) {
      dependents.set(groupId, [...(dependents.get(groupId) ?? []), `${extensionId}/${candidateId}`])
    }
  }
  const allSharedGroups: InstalledSharedWeightGroup[] = (groups ?? []).map((group) => ({
    ...group,
    targetId: weightGroupTargetId(extensionId, group.id),
    dependentModelIds: dependents.get(group.id) ?? [],
  }))
  const matches = nodes.filter((candidate) => candidate.id === nodeId)
  if (matches.length !== 1) {
    throw new Error(`Installed manifest must declare model node "${nodeId}" exactly once`)
  }

  const node = matches[0]
  const modelId = `${extensionId}/${nodeId}`
  const groupRefs = normalizeWeightGroupReferences(node, groups, `nodes[${nodeId}].weight_groups`) ?? []
  const sharedGroups = groupRefs.map((groupId) => allSharedGroups.find((group) => group.id === groupId)!)
  const declaredPlanKinds = [
    node.model_sources !== undefined ? 'model_sources' : undefined,
    node.https_downloads !== undefined ? 'https_downloads' : undefined,
    node.hf_downloads !== undefined ? 'hf_downloads' : undefined,
    typeof node.hf_repo === 'string' && node.hf_repo ? 'hf_repo' : undefined,
  ].filter((kind): kind is string => kind !== undefined)
  if (declaredPlanKinds.length > 1) {
    throw new Error(`${modelId} declares conflicting download plan kinds: ${declaredPlanKinds.join(', ')}`)
  }
  const httpsDownloads = normalizeHttpsDownloads(node.https_downloads, 'https_downloads')
  if (httpsDownloads) return { kind: 'https-assets', modelId, extensionId, nodeId, httpsDownloads }
  const hfDownloads = normalizeHfDownloads(node.hf_downloads, 'hf_downloads')
  if (hfDownloads) return { kind: 'hf-assets', modelId, extensionId, nodeId, hfDownloads }
  let sources: ModelSource[] | undefined
  try {
    sources = normalizeModelSources(node)
  } catch (error) {
    throw new ModelAssetDownloadError({
      code: 'source_plan_invalid',
      stage: 'validate',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    })
  }
  if (sources || sharedGroups.length > 0) {
    if (sharedGroups.length > 0 && node.hf_repo !== undefined) {
      throw new Error(`Model node "${modelId}" must use model_sources for private weights when weight_groups are declared`)
    }
    return { kind: 'multi-source', modelId, extensionId, nodeId, sources: sources ?? [], sharedGroups }
  }

  if (
    typeof node.hf_repo !== 'string'
    || !node.hf_repo.trim()
    || node.hf_repo !== node.hf_repo.trim()
    || !HF_REPO_RE.test(node.hf_repo)
  ) {
    throw new Error(`Model node "${modelId}" has no Hugging Face download source`)
  }
  const validateDownloadCheck = (value: unknown): string | undefined => {
    if (value === undefined) return undefined
    if (typeof value !== 'string' || !value || value !== value.trim() || value.includes('\\')) {
      throw new Error(`Model node "${modelId}" download_check must be a safe relative path`)
    }
    const parts = value.split('/')
    if (parts.some((part) => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/.test(part))) {
      throw new Error(`Model node "${modelId}" download_check must be a safe relative path`)
    }
    return value
  }
  const validatePrefixes = (value: unknown, field: string): string[] | undefined => {
    if (value === undefined) return undefined
    if (
      !Array.isArray(value)
      || value.some((prefix) => typeof prefix !== 'string' || !prefix.trim() || prefix !== prefix.trim())
    ) {
      throw new Error(`Model node "${modelId}" ${field} must be an array of non-empty strings`)
    }
    return [...value]
  }
  const downloadCheck = validateDownloadCheck(node.download_check)
  const skipPrefixes = validatePrefixes(node.hf_skip_prefixes, 'hf_skip_prefixes')
  const includePrefixes = validatePrefixes(node.hf_include_prefixes, 'hf_include_prefixes')
  return {
    kind: 'legacy',
    modelId,
    extensionId,
    nodeId,
    repoId: node.hf_repo,
    downloadCheck,
    skipPrefixes,
    includePrefixes,
  }
}

function parseManifest(raw: string, extensionId: string, nodeId: string): InstalledModelDownloadPlan {
  try {
    return parseManifestUnsafe(raw, extensionId, nodeId)
  } catch (error) {
    if (error instanceof ModelAssetDownloadError) throw error
    throw new ModelAssetDownloadError({
      code: 'source_plan_invalid',
      stage: 'validate',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    })
  }
}

/** Re-read the installed manifest for every model action; renderer metadata is never trusted. */
export async function resolveInstalledModelDownloadPlan(args: {
  modelId: unknown
  userExtensionsDir: string
  builtinExtensionsDir: string
  blockedExtensionIds?: ReadonlySet<string>
}): Promise<InstalledModelDownloadPlan> {
  try {
    if (typeof args.modelId !== 'string') throw new Error('Model id must be a string')
  const parts = args.modelId.split('/')
  if (parts.length !== 2) throw new Error('Model id must identify one extension node')
  const extensionId = assertSafeExtensionId(parts[0])
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
    return parseManifest(await readFile(manifestPath, 'utf-8'), extensionId, nodeId)
  } catch (error) {
    if (error instanceof ModelAssetDownloadError) throw error
    throw new ModelAssetDownloadError({
      code: 'source_plan_invalid', stage: 'validate',
      message: error instanceof Error ? error.message : String(error), retryable: false,
    })
  }
}

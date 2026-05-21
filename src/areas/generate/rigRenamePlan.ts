import type { RigBoneId, RigBoneNode, RigSkeletonSummary } from './rigSkeleton.ts'

export type RigRenameValidationCode = 'empty-alias' | 'duplicate-alias' | 'unknown-bone'

export interface RigBoneAliasEntry {
  oldLabel: string
  alias: string
}

export interface RigRenamePlan {
  skeletonContextId: string
  aliases: Record<RigBoneId, RigBoneAliasEntry>
}

export type RigRenamePlanAction =
  | { type: 'set-alias'; boneId: RigBoneId; alias: string }
  | { type: 'cancel-alias'; boneId: RigBoneId }
  | { type: 'revert-all' }

export interface RigRenameValidationError {
  boneId: RigBoneId
  code: RigRenameValidationCode
  message: string
}

export interface RigRenameValidationResult {
  valid: boolean
  errors: RigRenameValidationError[]
}

export interface RigRenameSidecarSource {
  workspacePath: string
  artifactId?: string
  versionId?: string
}

export interface RigRenameSidecarBoneContext {
  boneId: RigBoneId
  oldLabel: string
  originalName: string
  path: string[]
}

export interface RigRenameSidecarV1 {
  schema: 'modly.rig.rename-plan'
  version: 1
  createdAt: string
  source: RigRenameSidecarSource
  skeletonContextId: string
  skeleton: {
    rootBoneIds: RigBoneId[]
    boneCount: number
    bones: RigRenameSidecarBoneContext[]
  }
  aliases: Record<RigBoneId, RigBoneAliasEntry>
}

export interface HydrateRigRenamePlanOptions {
  sourceWorkspacePath: string
}

export interface HydrateRigRenamePlanResult {
  plan: RigRenamePlan
  warnings: string[]
  ignoredBoneIds: RigBoneId[]
  valid: boolean
}

export interface BuildRigRenameSidecarInput {
  summary: RigSkeletonSummary
  plan: RigRenamePlan
  createdAt?: string
  source?: Partial<RigRenameSidecarSource>
}

export function createRigRenameSidecarWorkspacePath(sourceWorkspacePath: string): string {
  return `Workflows/rig-edits/${createRigRenameSidecarStem(sourceWorkspacePath)}-rig-aliases.rig.v1.json`
}

export function createRigRenamePlan(summary: Pick<RigSkeletonSummary, 'skeletonContextId'>): RigRenamePlan {
  return {
    skeletonContextId: summary.skeletonContextId,
    aliases: {},
  }
}

export function reduceRigRenamePlan(
  summary: RigSkeletonSummary,
  plan: RigRenamePlan,
  action: RigRenamePlanAction,
): RigRenamePlan {
  if (action.type === 'revert-all') {
    return createRigRenamePlan(summary)
  }

  const bone = findBone(summary, action.boneId)
  if (!bone) {
    return clonePlan(summary, plan)
  }

  if (action.type === 'cancel-alias') {
    const aliases = { ...plan.aliases }
    delete aliases[action.boneId]
    return { skeletonContextId: summary.skeletonContextId, aliases }
  }

  const alias = action.alias.trim()
  const aliases = { ...plan.aliases }
  if (alias === bone.label) {
    delete aliases[action.boneId]
  } else {
    aliases[action.boneId] = { oldLabel: bone.label, alias }
  }

  return { skeletonContextId: summary.skeletonContextId, aliases }
}

export function validateRigRenamePlan(summary: RigSkeletonSummary, plan: RigRenamePlan): RigRenameValidationResult {
  const errors: RigRenameValidationError[] = []
  const effectiveNames = buildEffectiveNameEntries(summary, plan)

  for (const [boneId, entry] of Object.entries(plan.aliases)) {
    const bone = findBone(summary, boneId)
    if (!bone) {
      errors.push({ boneId, code: 'unknown-bone', message: `Alias targets unknown bone "${boneId}".` })
      continue
    }

    const alias = entry.alias.trim()
    if (alias.length === 0) {
      errors.push({
        boneId,
        code: 'empty-alias',
        message: `Alias for "${bone.label}" cannot be empty.`,
      })
      continue
    }

    const normalizedAlias = normalizeAlias(alias)
    const collision = effectiveNames.find((candidate) => (
      candidate.boneId !== boneId && normalizeAlias(candidate.effectiveName) === normalizedAlias
    ))
    if (collision) {
      errors.push({
        boneId,
        code: 'duplicate-alias',
        message: `Alias "${alias}" for "${bone.label}" collides with "${collision.bone.label}" in this skeleton.`,
      })
    }
  }

  return { valid: errors.length === 0, errors }
}

export function buildRigRenameSidecarV1(input: BuildRigRenameSidecarInput): RigRenameSidecarV1 {
  const createdAt = input.createdAt ?? new Date().toISOString()
  const sourceWorkspacePath = input.source?.workspacePath ?? input.summary.sourceWorkspacePath
  if (!sourceWorkspacePath) {
    throw new Error('Rig rename sidecar requires a source workspace path.')
  }

  const aliases = orderedAliasesForSummary(input.summary, input.plan)
  const aliasedBones = Object.keys(aliases)
    .map((boneId) => findBone(input.summary, boneId))
    .filter((bone): bone is RigBoneNode => Boolean(bone))

  return {
    schema: 'modly.rig.rename-plan',
    version: 1,
    createdAt,
    source: {
      workspacePath: sourceWorkspacePath,
      artifactId: input.source?.artifactId,
      versionId: input.source?.versionId,
    },
    skeletonContextId: input.summary.skeletonContextId,
    skeleton: {
      rootBoneIds: [...input.summary.rootBoneIds],
      boneCount: input.summary.stats.boneCount,
      bones: aliasedBones.map((bone) => ({
        boneId: bone.boneId,
        oldLabel: bone.label,
        originalName: bone.originalName,
        path: [...bone.path],
      })),
    },
    aliases,
  }
}

export function hydrateRigRenamePlanFromSidecar(
  summary: RigSkeletonSummary,
  sidecar: unknown,
  options: HydrateRigRenamePlanOptions,
): HydrateRigRenamePlanResult {
  const emptyPlan = createRigRenamePlan(summary)
  const schemaWarnings = validateRigRenameSidecarShape(sidecar)
  if (schemaWarnings.length > 0) {
    return { plan: emptyPlan, warnings: schemaWarnings, ignoredBoneIds: [], valid: false }
  }

  const renameSidecar = sidecar as RigRenameSidecarV1
  if (renameSidecar.source.workspacePath !== options.sourceWorkspacePath) {
    return {
      plan: emptyPlan,
      warnings: [
        `Rig rename sidecar source mismatch: expected "${options.sourceWorkspacePath}" but found "${renameSidecar.source.workspacePath}".`,
      ],
      ignoredBoneIds: [],
      valid: false,
    }
  }

  const warnings: string[] = []
  const ignoredBoneIds: RigBoneId[] = []
  const aliases: Record<RigBoneId, RigBoneAliasEntry> = {}

  for (const [boneId, entry] of Object.entries(renameSidecar.aliases)) {
    const bone = findBone(summary, boneId)
    if (!bone) {
      ignoredBoneIds.push(boneId)
      warnings.push(`Ignoring alias for unknown boneId "${boneId}".`)
      continue
    }

    aliases[boneId] = {
      oldLabel: bone.label,
      alias: entry.alias,
    }
  }

  return {
    plan: {
      skeletonContextId: summary.skeletonContextId,
      aliases,
    },
    warnings,
    ignoredBoneIds,
    valid: true,
  }
}

function clonePlan(summary: RigSkeletonSummary, plan: RigRenamePlan): RigRenamePlan {
  return {
    skeletonContextId: summary.skeletonContextId,
    aliases: { ...plan.aliases },
  }
}

function findBone(summary: RigSkeletonSummary, boneId: RigBoneId): RigBoneNode | undefined {
  return summary.bones.find((bone) => bone.boneId === boneId)
}

function orderedAliasesForSummary(
  summary: RigSkeletonSummary,
  plan: RigRenamePlan,
): Record<RigBoneId, RigBoneAliasEntry> {
  const aliases: Record<RigBoneId, RigBoneAliasEntry> = {}
  for (const bone of summary.bones) {
    const alias = plan.aliases[bone.boneId]
    if (!alias) continue
    aliases[bone.boneId] = { oldLabel: bone.label, alias: alias.alias.trim() }
  }
  return aliases
}

function buildEffectiveNameEntries(summary: RigSkeletonSummary, plan: RigRenamePlan): Array<{
  boneId: RigBoneId
  bone: RigBoneNode
  effectiveName: string
}> {
  return summary.bones.map((bone) => ({
    boneId: bone.boneId,
    bone,
    effectiveName: plan.aliases[bone.boneId]?.alias.trim() || bone.label,
  }))
}

function normalizeAlias(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function validateRigRenameSidecarShape(sidecar: unknown): string[] {
  const warnings: string[] = []
  if (!isRecord(sidecar)) {
    return ['Rig rename sidecar is not an object.']
  }

  if (sidecar.schema !== 'modly.rig.rename-plan') {
    warnings.push('Rig rename sidecar schema must be "modly.rig.rename-plan".')
  }
  if (sidecar.version !== 1) {
    warnings.push('Rig rename sidecar version must be 1.')
  }
  if ('kind' in sidecar && sidecar.kind !== 'modly.rig.rename-plan') {
    warnings.push('Rig rename sidecar kind is not supported.')
  }

  if (!isRecord(sidecar.source) || typeof sidecar.source.workspacePath !== 'string' || sidecar.source.workspacePath.length === 0) {
    warnings.push('Rig rename sidecar source.workspacePath must be a non-empty string.')
  }
  if (typeof sidecar.skeletonContextId !== 'string') {
    warnings.push('Rig rename sidecar skeletonContextId must be a string.')
  }
  if (!isRecord(sidecar.skeleton) || !Array.isArray(sidecar.skeleton.rootBoneIds) || typeof sidecar.skeleton.boneCount !== 'number' || !Array.isArray(sidecar.skeleton.bones)) {
    warnings.push('Rig rename sidecar skeleton metadata is invalid.')
  }
  if (!isAliasRecord(sidecar.aliases)) {
    warnings.push('Rig rename sidecar aliases must be an object keyed by boneId.')
  }

  return warnings
}

function isAliasRecord(value: unknown): value is Record<RigBoneId, RigBoneAliasEntry> {
  if (!isRecord(value)) return false
  return Object.values(value).every((entry) => (
    isRecord(entry) && typeof entry.oldLabel === 'string' && typeof entry.alias === 'string'
  ))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function createRigRenameSidecarStem(sourceWorkspacePath: string): string {
  const normalized = sourceWorkspacePath.replace(/\\/g, '/')
  const filename = normalized.split('/').filter(Boolean).at(-1) ?? 'rig'
  const withoutExtension = filename.replace(/\.[^.]+$/, '') || 'rig'
  return withoutExtension.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'rig'
}

import { resolveRigEffectiveNaming, type RigEffectiveNameEntry, type RigEffectiveNameProvenance, type RigEffectiveNamingResult } from './rigEffectiveNaming.ts'
import type { RigMetaNamingMap } from './rigMetaNaming.ts'
import type { RigRenamePlan } from './rigRenamePlan.ts'
import type { RigBoneId, RigBoneNode, RigSkeletonSummary } from './rigSkeleton.ts'

export type RigDisplayNameProvenance = RigEffectiveNameProvenance
export type RigDisplayNameEntry = RigEffectiveNameEntry
export type RigDisplayNamingResult = RigEffectiveNamingResult

export interface ResolveRigDisplayNamesInput {
  summary: RigSkeletonSummary
  renamePlan?: RigRenamePlan
  rigMetaNamingByBoneId?: RigMetaNamingMap
  effectiveNaming?: RigEffectiveNamingResult
}

export function resolveRigDisplayNames({
  summary,
  renamePlan,
  rigMetaNamingByBoneId,
  effectiveNaming,
}: ResolveRigDisplayNamesInput): RigDisplayNamingResult {
  if (effectiveNaming) return cloneDisplayNames(effectiveNaming)
  return resolveRigEffectiveNaming(summary, renamePlan ?? createEmptyRenamePlan(summary), rigMetaNamingByBoneId)
}

export function resolveRigDisplayName(
  bone: RigBoneNode,
  displayNames?: RigDisplayNamingResult,
): RigDisplayNameEntry {
  return displayNames?.byBoneId[bone.boneId] ?? {
    boneId: bone.boneId,
    label: bone.label,
    rawLabel: bone.label,
    provenance: 'raw',
  }
}

export function resolveRigDisplayNameById(
  summary: RigSkeletonSummary,
  boneId: RigBoneId,
  displayNames?: RigDisplayNamingResult,
): RigDisplayNameEntry | undefined {
  const bone = summary.bones.find((candidate) => candidate.boneId === boneId)
  return bone ? resolveRigDisplayName(bone, displayNames) : undefined
}

function createEmptyRenamePlan(summary: RigSkeletonSummary): RigRenamePlan {
  return { skeletonContextId: summary.skeletonContextId, aliases: {} }
}

function cloneDisplayNames(displayNames: RigEffectiveNamingResult): RigDisplayNamingResult {
  const byBoneId: RigDisplayNamingResult['byBoneId'] = {}
  const ordered = displayNames.ordered.map((entry) => {
    const clone = { ...entry }
    byBoneId[clone.boneId] = clone
    return clone
  })
  return { byBoneId, ordered }
}

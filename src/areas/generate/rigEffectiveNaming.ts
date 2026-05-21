import type { RigMetaNamingMap } from './rigMetaNaming.ts'
import type { RigRenamePlan } from './rigRenamePlan.ts'
import type { RigBoneId, RigSkeletonSummary } from './rigSkeleton.ts'

export type RigEffectiveNameProvenance = 'manual' | 'unirig' | 'raw'

export interface RigEffectiveNameEntry {
  boneId: RigBoneId
  label: string
  rawLabel: string
  provenance: RigEffectiveNameProvenance
}

export interface RigEffectiveNamingResult {
  byBoneId: Record<RigBoneId, RigEffectiveNameEntry>
  ordered: RigEffectiveNameEntry[]
}

export function resolveRigEffectiveNaming(
  summary: RigSkeletonSummary,
  plan: RigRenamePlan,
  rigMetaNaming?: RigMetaNamingMap,
): RigEffectiveNamingResult {
  const byBoneId: Record<RigBoneId, RigEffectiveNameEntry> = {}
  const ordered = summary.bones.map((bone) => {
    const manualAlias = plan.aliases[bone.boneId]?.alias.trim()
    const unirigLabel = rigMetaNaming?.[bone.boneId]?.label.trim()
    const rawLabel = bone.label

    const entry: RigEffectiveNameEntry = manualAlias
      ? { boneId: bone.boneId, label: manualAlias, rawLabel, provenance: 'manual' }
      : unirigLabel
        ? { boneId: bone.boneId, label: unirigLabel, rawLabel, provenance: 'unirig' }
        : { boneId: bone.boneId, label: rawLabel, rawLabel, provenance: 'raw' }

    byBoneId[bone.boneId] = entry
    return entry
  })

  return { byBoneId, ordered }
}

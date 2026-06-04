export type RigBoneWarning = 'empty-name' | 'duplicate-name'
export type RigBoneId = string

import { normalizeSemanticRoleId } from './semanticRoles.ts'

export interface RigBoneLike {
  name?: string
  parent?: RigBoneLike | null
  children?: readonly RigBoneLike[]
}

export interface RigSkeletonLike {
  bones: readonly RigBoneLike[]
}

export interface RigSkinnedMeshContext {
  name?: string
  path?: readonly string[]
  skeletonIndex?: number
  skeleton: RigSkeletonLike
}

export interface CollectRigSkeletonSummaryInput {
  sourceWorkspacePath?: string
  skinnedMeshes: readonly RigSkinnedMeshContext[]
}

export interface RigBoneNode {
  boneId: RigBoneId
  label: string
  originalName: string
  nodeIndex?: number
  role?: string
  path: string[]
  siblingIndex: number
  parentId?: RigBoneId
  childIds: RigBoneId[]
  warnings: RigBoneWarning[]
}

export interface KimodoTargetTrackRotation {
  timeSeconds: number
  x: number
  y: number
  z: number
  w: number
}

export interface KimodoTargetTrackLike {
  targetNodeName: string
  targetNodeIndex: number
  targetRole?: string
  rotations: KimodoTargetTrackRotation[]
}

export interface TranslatedKimodoTargetTrack extends KimodoTargetTrackLike {
  boneId: RigBoneId
}

export type TranslateKimodoTargetTracksResult =
  | { ok: true, tracks: TranslatedKimodoTargetTrack[], diagnostics: string[] }
  | { ok: false, diagnostics: string[] }

export interface RigSkeletonSummary {
  hasRig: boolean
  sourceWorkspacePath?: string
  skeletonContextId: string
  skinnedMeshContexts: string[]
  bones: RigBoneNode[]
  rootBoneIds: RigBoneId[]
  stats: {
    skinnedMeshCount: number
    boneCount: number
  }
  warnings: string[]
}

export interface RigOverlayConnection {
  fromBoneId: RigBoneId
  toBoneId: RigBoneId
  relation: 'parent' | 'child'
}

export interface RigSelectionOverlayViewModel {
  selectedBoneId: RigBoneId
  selectedLabel: string
  parentBoneId?: RigBoneId
  childBoneIds: RigBoneId[]
  highlightedBoneIds: RigBoneId[]
  connections: RigOverlayConnection[]
}

interface PreparedBone {
  bone: RigBoneLike
  label: string
  originalName: string
  globalIndex: number
  duplicateName: boolean
  emptyName: boolean
}

export function collectRigSkeletonSummary(input: CollectRigSkeletonSummaryInput): RigSkeletonSummary {
  const skinnedMeshContexts = input.skinnedMeshes.map(resolveSkeletonContextId)
  const skeletonContextId = skinnedMeshContexts[0] ?? 'rig:unknown|skeleton:0'
  const bones: RigBoneNode[] = []
  const rootBoneIds: RigBoneId[] = []
  const warnings: string[] = []

  for (const mesh of input.skinnedMeshes) {
    const contextId = resolveSkeletonContextId(mesh)
    const meshBones = mesh.skeleton.bones
    const preparedBones = prepareBones(meshBones)
    const includedBones = new Set(meshBones)
    const nodeByBone = new Map<RigBoneLike, RigBoneNode>()

    for (const [name, count] of countNonEmptyOriginalNames(meshBones)) {
      if (count > 1) {
        warnings.push(`Duplicate bone name "${name}" appears ${count} times in ${contextId}.`)
      }
    }

    for (const prepared of preparedBones) {
      if (prepared.emptyName) {
        warnings.push(`Bone at index ${prepared.globalIndex} has an empty name; using fallback label "${prepared.label}".`)
      }
    }

    const roots = preparedBones.filter(({ bone }) => !bone.parent || !includedBones.has(bone.parent))
    for (const root of roots) {
      visitBone({
        contextId,
        prepared: root,
        parentId: undefined,
        parentPath: [],
        includedBones,
        preparedBones,
        nodeByBone,
        output: bones,
        rootBoneIds,
      })
    }
  }

  if (bones.length === 0) {
    warnings.push('No skeleton bones were found.')
  }

  return {
    hasRig: bones.length > 0,
    sourceWorkspacePath: input.sourceWorkspacePath,
    skeletonContextId,
    skinnedMeshContexts,
    bones,
    rootBoneIds,
    stats: {
      skinnedMeshCount: input.skinnedMeshes.length,
      boneCount: bones.length,
    },
    warnings,
  }
}

export function buildRigSelectionOverlay(
  summary: RigSkeletonSummary,
  selectedBoneId: RigBoneId | undefined,
): RigSelectionOverlayViewModel | null {
  if (!selectedBoneId) return null

  const selectedBone = summary.bones.find((bone) => bone.boneId === selectedBoneId)
  if (!selectedBone) return null

  const highlightedBoneIds = uniqueBoneIds([
    selectedBone.boneId,
    selectedBone.parentId,
    ...selectedBone.childIds,
  ])
  const connections: RigOverlayConnection[] = []

  if (selectedBone.parentId) {
    connections.push({ fromBoneId: selectedBone.parentId, toBoneId: selectedBone.boneId, relation: 'parent' })
  }

  for (const childBoneId of selectedBone.childIds) {
    connections.push({ fromBoneId: selectedBone.boneId, toBoneId: childBoneId, relation: 'child' })
  }

  return {
    selectedBoneId: selectedBone.boneId,
    selectedLabel: selectedBone.label,
    parentBoneId: selectedBone.parentId,
    childBoneIds: [...selectedBone.childIds],
    highlightedBoneIds,
    connections,
  }
}

export function translateKimodoTargetTracks(
  summary: RigSkeletonSummary,
  tracks: readonly KimodoTargetTrackLike[],
): TranslateKimodoTargetTracksResult {
  const translated: TranslatedKimodoTargetTrack[] = []
  const diagnostics: string[] = []

  for (const track of tracks) {
    if (!Array.isArray(track.rotations) || track.rotations.length === 0) {
      diagnostics.push(`Kimodo target track "${track.targetNodeName}" is partial or missing quaternion rotations.`)
      continue
    }

    const resolution = resolveKimodoTargetTrackCandidates(summary, track)
    const baseCandidates = resolution.candidates

    if (baseCandidates.length === 0) {
      diagnostics.push(resolution.diagnostic ?? `Kimodo target track "${track.targetNodeName}" is missing local target for node index ${track.targetNodeIndex}.`)
      continue
    }

    if (resolution.identityMatch) {
      if (baseCandidates.length !== 1) {
        diagnostics.push(`Kimodo target track "${track.targetNodeName}" resolved to an ambiguous local target.`)
        continue
      }

      diagnostics.push(...resolveExactIdentityRoleDiagnostics(baseCandidates[0], track))
      translated.push(cloneTranslatedKimodoTargetTrack(track, baseCandidates[0].boneId))
      continue
    }

    const normalizedTargetRole = normalizeSemanticRoleId(track.targetRole)
    const roleCandidates = normalizedTargetRole
      ? baseCandidates.filter((bone) => normalizeSemanticRoleId(bone.role) === normalizedTargetRole)
      : baseCandidates

    if (normalizedTargetRole && roleCandidates.length === 0) {
      diagnostics.push(`Kimodo target track "${track.targetNodeName}" failed role mismatch for "${track.targetRole}".`)
      continue
    }

    if (roleCandidates.length !== 1) {
      diagnostics.push(`Kimodo target track "${track.targetNodeName}" resolved to an ambiguous local target.`)
      continue
    }

    translated.push(cloneTranslatedKimodoTargetTrack(track, roleCandidates[0].boneId, normalizedTargetRole))
  }

  if (translated.length === 0 && diagnostics.length > 0) return { ok: false, diagnostics }
  return { ok: true, tracks: translated, diagnostics }
}

function resolveExactIdentityRoleDiagnostics(bone: RigBoneNode, track: KimodoTargetTrackLike): string[] {
  const normalizedTargetRole = normalizeSemanticRoleId(track.targetRole)
  if (!normalizedTargetRole) return []
  if (!bone.role) {
    return [`Kimodo target track "${track.targetNodeName}" accepted exact local identity for role "${normalizedTargetRole}"; local role metadata is missing.`]
  }
  const normalizedBoneRole = normalizeSemanticRoleId(bone.role)
  if (normalizedBoneRole === normalizedTargetRole) return []
  return [`Kimodo target track "${track.targetNodeName}" accepted exact local identity; local role metadata "${bone.role}" differs from Kimodo role "${normalizedTargetRole}".`]
}

function cloneTranslatedKimodoTargetTrack(track: KimodoTargetTrackLike, boneId: RigBoneId, normalizedTargetRole = normalizeSemanticRoleId(track.targetRole)): TranslatedKimodoTargetTrack {
  return {
    boneId,
    targetNodeName: track.targetNodeName,
    targetNodeIndex: track.targetNodeIndex,
    ...(normalizedTargetRole ? { targetRole: normalizedTargetRole } : {}),
    rotations: track.rotations.map((rotation) => ({ ...rotation })),
  }
}

function resolveKimodoTargetTrackCandidates(
  summary: RigSkeletonSummary,
  track: KimodoTargetTrackLike,
): { candidates: RigBoneNode[], diagnostic?: string, identityMatch: boolean } {
  const targetName = normalizeComparableBoneName(track.targetNodeName)
  const exactCandidates = summary.bones.filter((bone, index) => {
    const nodeIndex = bone.nodeIndex ?? index
    return normalizeComparableBoneName(bone.originalName) === targetName && nodeIndex === track.targetNodeIndex
  })
  if (exactCandidates.length > 0) return { candidates: exactCandidates, identityMatch: true }

  const sameNameCandidates = summary.bones.filter((bone) => normalizeComparableBoneName(bone.originalName) === targetName)
  if (sameNameCandidates.length === 1) return { candidates: sameNameCandidates, identityMatch: true }

  const normalizedTargetRole = normalizeSemanticRoleId(track.targetRole)
  if (normalizedTargetRole) {
    const sameNameAndRoleCandidates = sameNameCandidates.filter((bone) => normalizeSemanticRoleId(bone.role) === normalizedTargetRole)
    if (sameNameAndRoleCandidates.length > 0) return { candidates: sameNameAndRoleCandidates, identityMatch: false }

    const sameRoleCandidates = summary.bones.filter((bone) => normalizeSemanticRoleId(bone.role) === normalizedTargetRole)
    if (sameRoleCandidates.length > 0) return { candidates: sameRoleCandidates, identityMatch: false }

    if (sameNameCandidates.length > 0) {
      return {
        candidates: [],
        diagnostic: `Kimodo target track "${track.targetNodeName}" failed role mismatch for "${track.targetRole}".`,
        identityMatch: false,
      }
    }
  }

  if (sameNameCandidates.length > 0) return { candidates: sameNameCandidates, identityMatch: false }

  return {
    candidates: [],
    diagnostic: `Kimodo target track "${track.targetNodeName}" is missing local target for node index ${track.targetNodeIndex}.`,
    identityMatch: false,
  }
}

function normalizeComparableBoneName(value: string): string {
  return value.trim().toLowerCase()
}

function visitBone(input: {
  contextId: string
  prepared: PreparedBone
  parentId?: RigBoneId
  parentPath: readonly string[]
  includedBones: ReadonlySet<RigBoneLike>
  preparedBones: readonly PreparedBone[]
  nodeByBone: Map<RigBoneLike, RigBoneNode>
  output: RigBoneNode[]
  rootBoneIds: RigBoneId[]
}): RigBoneNode {
  const path = [...input.parentPath, input.prepared.label]
  const siblingIndex = resolveSiblingIndex(input.prepared, input.includedBones)
  const boneId = `${input.contextId}|bone:${path.map((segment, index) => `${normalizeIdToken(segment)}#${index === path.length - 1 ? siblingIndex : resolvePathSiblingIndex(input.prepared, input.preparedBones, path, index)}`).join('/')}`
  const warnings = resolveBoneWarnings(input.prepared)
  const node: RigBoneNode = {
    boneId,
    label: input.prepared.label,
    originalName: input.prepared.originalName,
    nodeIndex: input.prepared.globalIndex,
    path,
    siblingIndex,
    parentId: input.parentId,
    childIds: [],
    warnings,
  }

  input.nodeByBone.set(input.prepared.bone, node)
  input.output.push(node)
  if (!input.parentId) {
    input.rootBoneIds.push(node.boneId)
  }

  for (const child of input.prepared.bone.children ?? []) {
    if (!input.includedBones.has(child)) continue

    const preparedChild = input.preparedBones.find((item) => item.bone === child)
    if (!preparedChild) continue


    const childNode = visitBone({
      ...input,
      prepared: preparedChild,
      parentId: node.boneId,
      parentPath: path,
    })
    node.childIds.push(childNode.boneId)
  }

  return node
}

function prepareBones(bones: readonly RigBoneLike[]): PreparedBone[] {
  const nameCounts = countNonEmptyOriginalNames(bones)
  return bones.map((bone, index) => {
    const originalName = bone.name ?? ''
    const trimmedName = originalName.trim()
    const emptyName = trimmedName.length === 0
    return {
      bone,
      label: emptyName ? `Bone ${index + 1}` : trimmedName,
      originalName,
      globalIndex: index,
      duplicateName: !emptyName && (nameCounts.get(trimmedName) ?? 0) > 1,
      emptyName,
    }
  })
}

function countNonEmptyOriginalNames(bones: readonly RigBoneLike[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const bone of bones) {
    const name = (bone.name ?? '').trim()
    if (name.length === 0) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return counts
}

function resolveBoneWarnings(prepared: PreparedBone): RigBoneWarning[] {
  const warnings: RigBoneWarning[] = []
  if (prepared.emptyName) warnings.push('empty-name')
  if (prepared.duplicateName) warnings.push('duplicate-name')
  return warnings
}

function resolveSkeletonContextId(mesh: RigSkinnedMeshContext): string {
  const path = mesh.path?.length ? mesh.path : [mesh.name?.trim() || 'skinned-mesh']
  return `rig:${path.map(normalizeIdToken).join('_')}|skeleton:${mesh.skeletonIndex ?? 0}`
}

function resolveSiblingIndex(prepared: PreparedBone, includedBones: ReadonlySet<RigBoneLike>): number {
  const parent = prepared.bone.parent
  const siblings = parent?.children?.filter((child) => includedBones.has(child)) ?? [prepared.bone]
  let index = 0
  for (const sibling of siblings) {
    if (sibling === prepared.bone) return index
    const siblingLabel = (sibling.name ?? '').trim() || prepared.label
    if (siblingLabel === prepared.label) index += 1
  }
  return index
}

function resolvePathSiblingIndex(
  prepared: PreparedBone,
  preparedBones: readonly PreparedBone[],
  path: readonly string[],
  pathIndex: number,
): number {
  const wantedLabel = path[pathIndex]
  let current: RigBoneLike | undefined = prepared.bone
  const ancestors: RigBoneLike[] = []
  while (current) {
    ancestors.unshift(current)
    current = current.parent ?? undefined
  }
  const ancestor = ancestors[pathIndex]
  const ancestorPrepared = preparedBones.find((item) => item.bone === ancestor)
  return ancestorPrepared && ancestorPrepared.label === wantedLabel ? resolveSiblingIndex(ancestorPrepared, new Set(preparedBones.map((item) => item.bone))) : 0
}

function uniqueBoneIds(values: readonly (RigBoneId | undefined)[]): RigBoneId[] {
  return values.filter((value, index, array): value is RigBoneId => Boolean(value) && array.indexOf(value) === index)
}

function normalizeIdToken(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]+/g, '_') || 'unnamed'
}

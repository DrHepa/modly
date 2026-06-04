import { normalizeSemanticRoleId } from './semanticRoles.ts'

export type RigBoneWarning = 'empty-name' | 'duplicate-name'
export type RigBoneId = string

export interface RigBoneLike {
  name?: string
  parent?: RigBoneLike | null
  children?: readonly RigBoneLike[]
}

export interface RigSkeletonLike<Bone extends RigBoneLike = RigBoneLike> {
  bones: readonly Bone[]
}

export interface RigSkinnedMeshContext<Bone extends RigBoneLike = RigBoneLike> {
  name?: string
  path?: readonly string[]
  skeletonIndex?: number
  skeleton: RigSkeletonLike<Bone>
}

export interface CollectRigSkeletonSummaryInput<Bone extends RigBoneLike = RigBoneLike> {
  sourceWorkspacePath?: string
  skinnedMeshes: readonly RigSkinnedMeshContext<Bone>[]
}

export interface RigBoneNode {
  boneId: RigBoneId
  label: string
  originalName: string
  /** Index in the first owning mesh's skeleton.bones, not a GLTF node index or stable ID. */
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
  /** Producer index retained as evidence; not the local skeleton.bones index. */
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

export interface RigSkeletonBinding<Bone extends RigBoneLike = RigBoneLike> {
  summary: RigSkeletonSummary
  bonesById: Map<RigBoneId, Bone>
}

export function collectRigSkeletonSummary(input: CollectRigSkeletonSummaryInput): RigSkeletonSummary {
  return collectRigSkeletonBinding(input).summary
}

/** IDs and object bindings must be produced together, never zipped by array order. */
export function collectRigSkeletonBinding<Bone extends RigBoneLike>(
  input: CollectRigSkeletonSummaryInput<Bone>,
): RigSkeletonBinding<Bone> {
  const bones: RigBoneNode[] = []
  const bonesById = new Map<RigBoneId, Bone>()
  const nodeByBone = new Map<RigBoneLike, RigBoneNode>()
  const rootBoneIds: RigBoneId[] = []
  const warnings: string[] = []
  const skinnedMeshContexts: string[] = []
  const contextCounts = new Map<string, number>()

  for (const mesh of input.skinnedMeshes) {
    const meshBones = orderSkeletonBones(mesh.skeleton.bones)
    // A shared skeleton is one set of authoring targets, not one set per mesh.
    if (meshBones.length > 0 && meshBones.every((bone) => nodeByBone.has(bone))) continue
    const baseContextId = resolveSkeletonContextId(mesh)
    const occurrence = contextCounts.get(baseContextId) ?? 0
    contextCounts.set(baseContextId, occurrence + 1)
    const contextId = occurrence === 0 ? baseContextId : `${baseContextId}|instance:${occurrence}`
    skinnedMeshContexts.push(contextId)
    const included = new Set<RigBoneLike>(meshBones)
    const labels = new Map(meshBones.map((bone, index) => [bone, (bone.name ?? '').trim() || `Bone ${index + 1}`]))
    const counts = countNonEmptyOriginalNames(meshBones)
    for (const [name, count] of counts) {
      if (count > 1) warnings.push(`Duplicate bone name "${name}" appears ${count} times in ${contextId}.`)
    }
    meshBones.forEach((bone, index) => {
      if (!(bone.name ?? '').trim()) warnings.push(`Bone at index ${index} has an empty name; using fallback label "${labels.get(bone)}".`)
    })
    const roots = meshBones.filter((bone) => !bone.parent || !included.has(bone.parent))

    const visit = (bone: Bone, siblings: readonly Bone[], parent?: RigBoneNode): RigBoneNode => {
      const existing = nodeByBone.get(bone)
      if (existing) return existing
      const label = labels.get(bone)!
      const token = normalizeIdToken(label)
      // Count normalized tokens, not raw names, including independent roots.
      const siblingIndex = siblings.slice(0, siblings.indexOf(bone))
        .filter((sibling) => normalizeIdToken(labels.get(sibling)!) === token).length
      const boneId = `${parent ? `${parent.boneId}/` : `${contextId}|bone:`}${token}#${siblingIndex}`
      const originalName = bone.name ?? ''
      const node: RigBoneNode = {
        boneId, label, originalName, path: [...(parent?.path ?? []), label], siblingIndex,
        nodeIndex: mesh.skeleton.bones.indexOf(bone),
        parentId: parent?.boneId, childIds: [],
        warnings: !originalName.trim() ? ['empty-name'] : (counts.get(originalName.trim()) ?? 0) > 1 ? ['duplicate-name'] : [],
      }
      nodeByBone.set(bone, node)
      bonesById.set(boneId, bone)
      bones.push(node)
      if (!parent) rootBoneIds.push(boneId)
      const children = (bone.children ?? []).filter((child): child is Bone => included.has(child) && child.parent === bone)
      // Also tolerate structural fixtures that declare parent links without children.
      for (const child of meshBones) if (child.parent === bone && !children.includes(child)) children.push(child)
      for (const child of children) {
        const childNode = visit(child, children, node)
        if (childNode.parentId === boneId && !node.childIds.includes(childNode.boneId)) node.childIds.push(childNode.boneId)
      }
      return node
    }
    // All roots share one ID namespace, including roots under different groups.
    for (const root of roots) visit(root, roots)
  }
  if (bones.length === 0) warnings.push('No skeleton bones were found.')
  return {
    summary: {
      hasRig: bones.length > 0, sourceWorkspacePath: input.sourceWorkspacePath,
      skeletonContextId: skinnedMeshContexts.join('||') || 'rig:unknown|skeleton:0',
      skinnedMeshContexts, bones, rootBoneIds,
      stats: { skinnedMeshCount: input.skinnedMeshes.length, boneCount: bones.length }, warnings,
    },
    bonesById,
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

    if (typeof track.targetNodeName !== 'string' || !track.targetNodeName.trim()
      || !Number.isSafeInteger(track.targetNodeIndex) || track.targetNodeIndex < 0
      || !validKimodoRotations(track.rotations)) {
      diagnostics.push(`Kimodo target track "${track.targetNodeName}" has invalid identity or quaternion timing data.`)
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

  const counts = new Map<RigBoneId, number>()
  for (const track of translated) counts.set(track.boneId, (counts.get(track.boneId) ?? 0) + 1)
  for (const [boneId, count] of counts) {
    if (count > 1) diagnostics.push(`Multiple Kimodo tracks resolve to local target "${boneId}"; all colliding tracks were omitted.`)
  }
  const tracksWithoutCollisions = translated.filter(track => counts.get(track.boneId) === 1)
  if (tracksWithoutCollisions.length === 0 && diagnostics.length > 0) return { ok: false, diagnostics }
  return { ok: true, tracks: tracksWithoutCollisions, diagnostics }
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
  // External node indices have no demonstrated relationship to skeleton.bones.
  // Prefer literal names, then an unambiguous case-insensitive legacy match.
  const exactCandidates = summary.bones.filter(bone => bone.originalName === track.targetNodeName)
  const sameNameCandidates = exactCandidates.length > 0
    ? exactCandidates
    : summary.bones.filter(bone => normalizeComparableBoneName(bone.originalName) === normalizeComparableBoneName(track.targetNodeName))
  if (sameNameCandidates.length === 1) return { candidates: sameNameCandidates, identityMatch: true }

  const normalizedTargetRole = normalizeSemanticRoleId(track.targetRole)
  if (normalizedTargetRole) {
    const sameNameAndRoleCandidates = sameNameCandidates.filter((bone) => normalizeSemanticRoleId(bone.role) === normalizedTargetRole)
    if (sameNameAndRoleCandidates.length > 0) return { candidates: sameNameAndRoleCandidates, identityMatch: false }

    if (sameNameCandidates.length === 0) {
      const sameRoleCandidates = summary.bones.filter((bone) => normalizeSemanticRoleId(bone.role) === normalizedTargetRole)
      if (sameRoleCandidates.length > 0) return { candidates: sameRoleCandidates, identityMatch: false }
    }

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

function validKimodoRotations(rotations: readonly KimodoTargetTrackRotation[]): boolean {
  return rotations.every((rotation, index) => rotation
    && [rotation.timeSeconds, rotation.x, rotation.y, rotation.z, rotation.w].every(Number.isFinite)
    && rotation.timeSeconds >= 0
    && (index === 0 || rotation.timeSeconds > rotations[index - 1].timeSeconds)
    && Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w) > 0
    && Number.isFinite(Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w)))
}

function normalizeComparableBoneName(value: string): string {
  return value.trim().toLowerCase()
}

function orderSkeletonBones<Bone extends RigBoneLike>(input: readonly Bone[]): Bone[] {
  const unique = [...new Set(input)]
  const included = new Set<RigBoneLike>(unique)
  const roots = unique.filter((bone) => !bone.parent || !included.has(bone.parent))
  const lineage = (bone: RigBoneLike): RigBoneLike[] => {
    const path: RigBoneLike[] = []
    for (let current: RigBoneLike | null | undefined = bone; current && !path.includes(current); current = current.parent) path.unshift(current)
    return path
  }
  roots.sort((left, right) => {
    const a = lineage(left); const b = lineage(right)
    if (a[0] !== b[0]) return 0 // Separate trees have no shared scene ordering.
    let index = 1
    while (a[index] && a[index] === b[index]) index += 1
    const siblings = a[index - 1]?.children ?? []
    return siblings.indexOf(a[index]) - siblings.indexOf(b[index])
  })
  const ordered: Bone[] = []
  const seen = new Set<RigBoneLike>()
  const visit = (bone: Bone) => {
    if (seen.has(bone)) return
    seen.add(bone); ordered.push(bone)
    for (const child of bone.children ?? []) if (included.has(child) && child.parent === bone) visit(child as Bone)
    for (const child of unique) if (child.parent === bone) visit(child)
  }
  for (const root of roots) visit(root)
  return ordered
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

function resolveSkeletonContextId(mesh: RigSkinnedMeshContext): string {
  const path = mesh.path?.length ? mesh.path : [mesh.name?.trim() || 'skinned-mesh']
  return `rig:${path.map(normalizeIdToken).join('_')}|skeleton:${mesh.skeletonIndex ?? 0}`
}

function uniqueBoneIds(values: readonly (RigBoneId | undefined)[]): RigBoneId[] {
  return values.filter((value, index, array): value is RigBoneId => Boolean(value) && array.indexOf(value) === index)
}

function normalizeIdToken(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]+/g, '_') || 'unnamed'
}

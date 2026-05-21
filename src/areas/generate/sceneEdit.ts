import { AnimationClip, Bone, Mesh, Object3D, PropertyBinding, SkinnedMesh } from 'three'

import type { EditPlan, EditPlanAction, EditPlanExportability, SceneEditGuardrail, ScenePart, ScenePartType } from './sceneEdit.types.ts'

export const SCENE_EDIT_ACTION_LABELS = {
  hideFromEditedCopy: 'Hide from edited copy',
  excludeFromExport: 'Exclude from export',
  reset: 'Reset edit plan',
  clear: 'Clear selection',
} as const

export interface CreateEditPlanInput {
  sourceArtifactId: string
  sourceVersionId?: string
  sourceWorkspacePath: string
  selectedPartId?: string
  excludedPartIds?: string[]
}

export interface CollectScenePartsOptions {
  animationClips?: readonly AnimationClip[]
  animatedNodeNames?: readonly string[]
}

export function createEditPlan(input: CreateEditPlanInput): EditPlan {
  return {
    sourceArtifactId: input.sourceArtifactId,
    sourceVersionId: input.sourceVersionId,
    sourceWorkspacePath: input.sourceWorkspacePath,
    selectedPartId: input.selectedPartId,
    excludedPartIds: uniquePartIds(input.excludedPartIds ?? []),
  }
}

export function editPlanReducer(plan: EditPlan, action: EditPlanAction): EditPlan {
  switch (action.type) {
    case 'select-part':
      return { ...plan, selectedPartId: action.partId }
    case 'exclude-selected-part':
      return plan.selectedPartId ? excludePart(plan, plan.selectedPartId) : plan
    case 'exclude-part':
      return excludePart(plan, action.partId)
    case 'unexclude-part':
      return {
        ...plan,
        excludedPartIds: plan.excludedPartIds.filter((partId) => partId !== action.partId),
      }
    case 'reset':
      return { ...plan, excludedPartIds: [] }
    case 'clear':
      return { ...plan, selectedPartId: undefined, excludedPartIds: [] }
  }
}

export function collectSceneParts(scene: Object3D, options: CollectScenePartsOptions = {}): ScenePart[] {
  const parts: ScenePart[] = []
  const animatedNodes = new Set<Object3D>()
  scene.traverse(node => { if (options.animatedNodeNames?.includes(node.name)) animatedNodes.add(node) })
  let unresolvedAnimation = false
  for (const { root, clip } of collectSceneAnimations(scene, options.animationClips)) {
    for (const track of clip.tracks) {
      try {
        const target = resolveSceneAnimationTarget(root, track.name).node
        animatedNodes.add(target)
      } catch {
        // Unknown bindings cannot justify a destructive subtree exclusion.
        unresolvedAnimation = true
      }
    }
  }
  const guardrails = new Map<Object3D, SceneEditGuardrail>()
  function inspect(node: Object3D): SceneEditGuardrail {
    let guardrail = resolveGuardrail(node, resolvePartType(node), animatedNodes)
    for (const child of node.children) {
      const dependency = inspect(child)
      if (guardrail.status === 'allowed' && dependency.status === 'blocked') guardrail = dependency
    }
    if (unresolvedAnimation) guardrail = { status: 'blocked', reason: 'animation-dependency', message: 'Unresolved animation bindings prevent safe subtree exclusion.' }
    guardrails.set(node, guardrail)
    return guardrail
  }
  inspect(scene)

  function visit(node: Object3D, parentPath: ScenePathSegment[], isRoot: boolean): void {
    const type = resolvePartType(node)
    const segment = buildPathSegment(node, type)
    const path = [...parentPath, segment]

    if (!isRoot) {
      const guardrail = guardrails.get(node)!
      parts.push({
        id: path.map(formatPathSegment).join('/'),
        label: resolveNodeLabel(node, type),
        type,
        path: path.map((item) => item.name),
        siblingIndex: segment.siblingIndex,
        selectable: guardrail.status === 'allowed',
        guardrail,
      })
    }

    for (const child of node.children) {
      visit(child, path, false)
    }
  }

  visit(scene, [], true)
  return parts
}

export function isEditPlanExportable(plan: EditPlan, parts: readonly ScenePart[]): EditPlanExportability {
  const blockedPartIds = new Set(
    parts.filter((part) => part.guardrail.status === 'blocked').map((part) => part.id),
  )
  const blockedExcludedPartIds = plan.excludedPartIds.filter((partId) => blockedPartIds.has(partId))

  return blockedExcludedPartIds.length === 0
    ? { exportable: true }
    : { exportable: false, blockedPartIds: blockedExcludedPartIds }
}

function excludePart(plan: EditPlan, partId: string): EditPlan {
  return {
    ...plan,
    excludedPartIds: uniquePartIds([...plan.excludedPartIds, partId]),
  }
}

function uniquePartIds(partIds: readonly string[]): string[] {
  return Array.from(new Set(partIds))
}

interface ScenePathSegment {
  type: ScenePartType
  name: string
  siblingIndex: number
}

function buildPathSegment(node: Object3D, type: ScenePartType): ScenePathSegment {
  return {
    type,
    name: resolveNodeLabel(node, type),
    siblingIndex: resolveSiblingIndex(node, type),
  }
}

function resolveSiblingIndex(node: Object3D, type: ScenePartType): number {
  const parent = node.parent
  if (!parent) {
    return 0
  }

  const label = normalizeIdToken(resolveNodeLabel(node, type))
  return parent.children
    .slice(0, parent.children.indexOf(node) + 1)
    .filter((sibling) => resolvePartType(sibling) === type && normalizeIdToken(resolveNodeLabel(sibling, type)) === label).length - 1
}

function resolvePartType(node: Object3D): ScenePartType {
  if (node instanceof Bone) {
    return 'bone'
  }

  if (node instanceof SkinnedMesh) {
    return 'skinned-mesh'
  }

  if (node.name.toLowerCase().includes('armature')) {
    return 'armature'
  }

  if (node instanceof Mesh) {
    return 'mesh'
  }

  return 'node'
}

function resolveGuardrail(node: Object3D, type: ScenePartType, animatedNodes: ReadonlySet<Object3D>): SceneEditGuardrail {
  if (type === 'bone') {
    return { status: 'blocked', reason: 'bone', message: 'Bones are rig dependencies and cannot be excluded safely.' }
  }

  if (type === 'armature') {
    return { status: 'blocked', reason: 'armature', message: 'Armatures are rig roots and cannot be excluded safely.' }
  }

  if (type === 'skinned-mesh') {
    return { status: 'blocked', reason: 'skinned-mesh', message: 'Skinned meshes depend on skeleton data and cannot be excluded safely.' }
  }

  if (animatedNodes.has(node)) {
    return {
      status: 'blocked',
      reason: 'animation-dependency',
      message: 'Animated nodes cannot be excluded safely in the edit copy.',
    }
  }

  return { status: 'allowed' }
}

function resolveNodeLabel(node: Object3D, type: ScenePartType): string {
  return node.name.trim() || type
}

function formatPathSegment(segment: ScenePathSegment): string {
  return `${segment.type}:${normalizeIdToken(segment.name)}#${segment.siblingIndex}`
}

function normalizeIdToken(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]+/g, '_') || 'unnamed'
}


/** Clip binding roots matter: loaders may attach clips to a nested object. */
export function collectSceneAnimations(scene: Object3D, clips: readonly AnimationClip[] = []): { root: Object3D; clip: AnimationClip }[] {
  const result: { root: Object3D; clip: AnimationClip }[] = []
  const seen = new Map<Object3D, Set<AnimationClip>>()
  const add = (root: Object3D, clip: AnimationClip) => {
    const rootClips = seen.get(root) ?? new Set<AnimationClip>()
    if (rootClips.has(clip)) return
    rootClips.add(clip)
    seen.set(root, rootClips)
    result.push({ root, clip })
  }
  for (const clip of clips) add(scene, clip)
  scene.traverse(node => { for (const clip of node.animations) add(node, clip) })
  return result
}

export function resolveSceneAnimationTarget(root: Object3D, trackName: string): {
  node: Object3D
  binding: ReturnType<typeof PropertyBinding.parseTrackName>
} {
  const binding = PropertyBinding.parseTrackName(trackName)
  let node: Object3D | undefined = PropertyBinding.findNode(root, binding.nodeName) ?? undefined
  if (binding.objectName === 'bones') {
    node = node instanceof SkinnedMesh
      ? node.skeleton.bones.find(bone => bone.name === binding.objectIndex)
        ?? node.skeleton.bones[Number(binding.objectIndex)]
      : undefined
  }
  if (!node) throw new Error(`Unresolved animation target: ${trackName}`)
  return { node, binding }
}

import {
  getWorldComponentDefinition,
  isWorldComponentPropertyWritableFor,
  type WorldComponent,
} from './worldComponentRegistry.ts'
import type {
  WorldPropertyValue,
  WorldSceneDocumentV1,
  WorldSequence,
  WorldSequenceTrack,
} from './worldModel.ts'
import { canContinueWorldSemanticValidation } from './worldValidationLimits.ts'

export interface WorldSequenceTrackTargetIssue {
  readonly code: string
  readonly path: string
  readonly message: string
}

export type WorldSequenceTrackTargetValidation =
  | { readonly success: true }
  | { readonly success: false; readonly issues: readonly WorldSequenceTrackTargetIssue[] }

/**
 * Core semantic authority for sequence write targets. Both document/command
 * validation and cinematic authoring call this function so workflow and AI
 * batches cannot bypass editor conflict checks.
 */
export function validateWorldSequenceTrackTargets(
  scene: WorldSceneDocumentV1,
  sequence: WorldSequence,
  rootPath = 'sequence',
): WorldSequenceTrackTargetValidation {
  const issues: WorldSequenceTrackTargetIssue[] = []
  const entities = new Map(scene.entities.map((entity) => [entity.id, entity]))
  const components = new Map<string, { component: WorldComponent; entityId: string }>()
  for (const entity of scene.entities) {
    for (const component of entity.components) components.set(component.id, { component, entityId: entity.id })
  }
  const writers = new Map<string, { trackId: string; path: string }>()

  for (const [trackIndex, track] of sequence.tracks.entries()) {
    if (!canContinueWorldSemanticValidation(issues)) break
    const path = `${rootPath}.tracks[${trackIndex}]`
    if (track.type === 'event') continue
    const entity = entities.get(track.entityId)
    if (!entity) {
      issues.push({ code: 'entity-reference', path: `${path}.entityId`, message: `Entity ${track.entityId} does not exist in scene ${scene.sceneId}.` })
      continue
    }

    if (track.type === 'transform') {
      const channels = new Set(track.keyframes.flatMap((keyframe) => Object.keys(keyframe.value)))
      for (const channel of channels) {
        if (!canContinueWorldSemanticValidation(issues)) break
        registerWriter(writers, issues, `entity:${entity.id}:transform:${channel}`, track.id, path)
      }
      continue
    }

    if (track.type === 'camera') {
      const camera = entity.components.find((component) => component.type === 'camera')
      if (!camera) issues.push({ code: 'component-reference', path: `${path}.entityId`, message: `Camera track entity ${entity.id} has no camera component.` })
      else registerWriter(writers, issues, `component:${camera.id}:primary`, track.id, path)
      continue
    }

    const target = components.get(track.componentId)
    if (!target) {
      issues.push({ code: 'component-reference', path: `${path}.componentId`, message: `Component ${track.componentId} does not exist in scene ${scene.sceneId}.` })
      continue
    }
    if (target.entityId !== track.entityId) {
      issues.push({ code: 'component-owner', path: `${path}.componentId`, message: `Component ${track.componentId} does not belong to entity ${track.entityId}.` })
      continue
    }

    if (track.type === 'animation') {
      if (target.component.type !== 'animation-player') issues.push(componentKindIssue(path, track, 'animation-player', target.component.type))
      else registerWriter(writers, issues, `playback:animation:${target.component.id}`, track.id, path)
      continue
    }
    if (track.type === 'audio') {
      if (target.component.type !== 'audio-source') issues.push(componentKindIssue(path, track, 'audio-source', target.component.type))
      else registerWriter(writers, issues, `playback:audio:${target.component.id}`, track.id, path)
      continue
    }
    if (track.type === 'light') {
      if (target.component.type !== 'light') {
        issues.push(componentKindIssue(path, track, 'light', target.component.type))
        continue
      }
      registerWriter(writers, issues, `component:${target.component.id}:intensity`, track.id, path)
      validateTrackValues(target.component, track, path, issues)
      continue
    }

    const definition = getWorldComponentDefinition(target.component.type)
    if (!definition?.writableProperties.includes(track.property) && canContinueWorldSemanticValidation(issues)) {
      issues.push({ code: 'track-property', path: `${path}.property`, message: `Property ${track.property} is not writable on ${target.component.type}.` })
    }
    registerWriter(writers, issues, `component:${target.component.id}:${track.property}`, track.id, path)
    validateTrackValues(target.component, track, path, issues)
    validateConsistentPropertyValueKind(track, path, issues)
  }
  return issues.length ? { success: false, issues } : { success: true }
}

function registerWriter(
  writers: Map<string, { trackId: string; path: string }>,
  issues: WorldSequenceTrackTargetIssue[],
  target: string,
  trackId: string,
  path: string,
): void {
  if (!canContinueWorldSemanticValidation(issues)) return
  const existing = writers.get(target)
  if (existing) {
    issues.push({ code: 'track-conflict', path, message: `Track ${trackId} already writes target ${target} owned by track ${existing.trackId}.` })
  } else writers.set(target, { trackId, path })
}

function validateTrackValues(
  component: WorldComponent,
  track: Extract<WorldSequenceTrack, { type: 'light' | 'property' }>,
  path: string,
  issues: WorldSequenceTrackTargetIssue[],
): void {
  for (const [keyframeIndex, keyframe] of track.keyframes.entries()) {
    if (!canContinueWorldSemanticValidation(issues)) break
    if (!isWorldComponentPropertyWritableFor(component, track.property, keyframe.value)) {
      issues.push({
        code: 'track-property', path: `${path}.keyframes[${keyframeIndex}].value`,
        message: `Value is not writable to ${component.type}.${track.property}.`,
      })
    }
  }
}

function validateConsistentPropertyValueKind(
  track: Extract<WorldSequenceTrack, { type: 'property' }>,
  path: string,
  issues: WorldSequenceTrackTargetIssue[],
): void {
  if (!canContinueWorldSemanticValidation(issues)) return
  const kinds = new Set(track.keyframes.map((keyframe) => propertyValueKind(keyframe.value)))
  if (kinds.size > 1) issues.push({ code: 'track-value-kind', path: `${path}.keyframes`, message: 'A property track must use one value kind for all keyframes.' })
}

function propertyValueKind(value: WorldPropertyValue): 'number' | 'vector3' | 'string' | 'boolean' {
  if (Array.isArray(value)) return 'vector3'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  return 'string'
}

function componentKindIssue(
  path: string,
  track: { componentId: string },
  expected: string,
  actual: string,
): WorldSequenceTrackTargetIssue {
  return { code: 'component-kind', path: `${path}.componentId`, message: `Component ${track.componentId} must be ${expected}, received ${actual}.` }
}

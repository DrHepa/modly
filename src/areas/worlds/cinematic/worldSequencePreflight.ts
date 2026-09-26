import {
  parseWorldComponent,
  type WorldComponent,
  type WorldWritableValue,
} from '../core/worldComponentRegistry.ts'
import { parseWorldSequenceDocument } from '../core/worldDocuments.ts'
import type {
  WorldRationalTime,
  WorldSceneDocumentV1,
  WorldSequence,
  WorldSequenceTrack,
} from '../core/worldModel.ts'
import {
  validateWorldSequenceTrackTargets as validateCanonicalWorldSequenceTrackTargets,
  type WorldSequenceTrackTargetValidation,
} from '../core/worldSequenceValidation.ts'
import { evaluateWorldSequence, WorldSequenceEvaluationError } from './worldSequenceEvaluator.ts'
import {
  compareWorldRationalTime,
  normalizeWorldRationalTime,
  worldRationalDifferenceRatio,
  worldRationalTimeKey,
} from './worldRationalTime.ts'

/** Orthographic size is the full vertical extent of the camera in world-space units. */
export const WORLD_ORTHOGRAPHIC_SIZE_SEMANTICS = 'vertical-world-space-height' as const

export interface WorldSequencePreflightIssue {
  readonly code: string
  readonly path: string
  readonly message: string
}

export type { WorldSequenceTrackTargetValidation }

export type WorldSequencePreflightResult =
  | {
      readonly success: true
      readonly sequence: WorldSequence
      readonly sampleTimes: readonly WorldRationalTime[]
    }
  | { readonly success: false; readonly issues: readonly WorldSequencePreflightIssue[] }

export interface WorldSequencePreflightInput {
  readonly scene: WorldSceneDocumentV1
  readonly sequence: WorldSequence
}

export function validateWorldSequenceTrackTargets(
  scene: WorldSceneDocumentV1,
  sequenceValue: WorldSequence,
): WorldSequenceTrackTargetValidation {
  const parsed = parseWorldSequenceDocument(sequenceValue)
  if (!parsed.success) return { success: false, issues: parsed.issues.map((issue) => ({ ...issue })) }
  return validateCanonicalWorldSequenceTrackTargets(scene, parsed.value)
}

export function preflightWorldSequence(input: WorldSequencePreflightInput): WorldSequencePreflightResult {
  const parsed = parseWorldSequenceDocument(input.sequence)
  if (!parsed.success) return { success: false, issues: parsed.issues.map((issue) => ({ ...issue })) }
  const sequence = parsed.value
  const targetValidation = validateWorldSequenceTrackTargets(input.scene, sequence)
  if (!targetValidation.success) return targetValidation

  const sampleTimes = collectPreflightSampleTimes(sequence)
  const issues: WorldSequencePreflightIssue[] = []
  for (const time of sampleTimes) {
    const samplePath = `sequence.samples.${worldRationalTimeKey(time)}`
    try {
      const evaluation = evaluateWorldSequence({ scene: input.scene, sequence, time, mode: 'seek' })
      const scene = structuredClone(input.scene)
      const changedComponents = new Set<string>()
      for (const patch of evaluation.patches) {
        const entity = scene.entities.find((candidate) => candidate.id === patch.entityId)
        if (!entity) continue
        if (patch.kind === 'transform') {
          entity.transform = { ...entity.transform, ...structuredClone(patch.transform) }
          continue
        }
        if (patch.kind === 'playback-state') continue
        const component = entity.components.find((candidate) => candidate.id === patch.componentId)
        if (!component) continue
        writeComponentProperty(component, patch.property, patch.value)
        changedComponents.add(component.id)
      }
      for (const entity of scene.entities) {
        for (const component of entity.components) {
          if (!changedComponents.has(component.id)) continue
          const componentResult = parseWorldComponent(component, `${samplePath}.components.${component.id}`)
          if (!componentResult.success) {
            for (const issue of componentResult.issues) issues.push({ code: 'component-invariant', path: issue.path, message: issue.message })
          }
        }
      }
      const primaryCameras = scene.entities.filter((entity) => isEffectivelyEnabled(scene, entity.id)
        && entity.components.some((component) => component.type === 'camera' && component.enabled && component.primary))
      if (primaryCameras.length !== 1) {
        issues.push({ code: 'camera-primary', path: `${samplePath}.cameras`, message: `Sequence requires exactly one enabled primary camera; found ${primaryCameras.length}.` })
      }
    } catch (error) {
      if (error instanceof WorldSequenceEvaluationError) issues.push({ code: error.code, path: error.path, message: error.message })
      else throw error
    }
  }
  issues.push(...validateAnalyticCameraInvariants(input.scene, sequence))
  return issues.length ? { success: false, issues: deduplicateIssues(issues) } : { success: true, sequence, sampleTimes }
}

function collectPreflightSampleTimes(sequence: WorldSequence): WorldRationalTime[] {
  // Never synthesize midpoints: two valid wire rationals can have no midpoint
  // representable with safe-integer fields. V1 discrete tracks are constant on
  // each open interval, continuous tracks are monotone per field, and coupled
  // camera clipping invariants are proven analytically below.
  return uniqueSortedTimes([
    { numerator: 0, denominator: 1 },
    sequence.duration,
    ...sequence.tracks.flatMap((track) => track.keyframes.map((keyframe) => keyframe.time)),
  ])
}

type WorldNumericPropertyTrack = Extract<WorldSequenceTrack, { type: 'property' }>
type CubicPolynomial = readonly [constant: number, linear: number, quadratic: number, cubic: number]

/**
 * Endpoints and discontinuities are evaluated above. Between two adjacent
 * discontinuities, v1 linear/smoothstep tracks are cubic polynomials. The
 * minimum far-near gap can therefore occur only at an endpoint or at a real
 * root of its quadratic derivative; evaluating those roots completes the
 * clipping-plane proof without frame-density sampling.
 */
function validateAnalyticCameraInvariants(
  scene: WorldSceneDocumentV1,
  sequence: WorldSequence,
): WorldSequencePreflightIssue[] {
  const issues: WorldSequencePreflightIssue[] = []
  for (const entity of scene.entities) {
    for (const component of entity.components) {
      if (component.type !== 'camera') continue
      const nearTrack = findNumericCameraTrack(sequence, component.id, 'near')
      const farTrack = findNumericCameraTrack(sequence, component.id, 'far')
      if (!nearTrack && !farTrack) continue
      const valueScale = cameraCurveValueScale(component.near, component.far, nearTrack, farTrack)
      const boundaries = uniqueSortedTimes([
        { numerator: 0, denominator: 1 },
        sequence.duration,
        ...(nearTrack?.keyframes.map((keyframe) => keyframe.time) ?? []),
        ...(farTrack?.keyframes.map((keyframe) => keyframe.time) ?? []),
      ])
      for (let intervalIndex = 0; intervalIndex + 1 < boundaries.length; intervalIndex += 1) {
        const start = boundaries[intervalIndex]
        const end = boundaries[intervalIndex + 1]
        if (compareWorldRationalTime(start, end) >= 0) continue
        const nearSegment = resolveNumericTrackSegment(nearTrack, component.near, start, end)
        const farSegment = resolveNumericTrackSegment(farTrack, component.far, start, end)
        const near = numericTrackPolynomial(nearSegment, valueScale)
        const far = numericTrackPolynomial(farSegment, valueScale)
        const gap = subtractPolynomial(far, near)
        const extrema = derivativeRootsInsideUnitInterval(gap)
        for (const [rootIndex, alpha] of extrema.entries()) {
          const candidate = structuredClone(component)
          candidate.near = evaluateNumericTrackSegment(nearSegment, alpha)
          candidate.far = evaluateNumericTrackSegment(farSegment, alpha)
          const path = `sequence.analytic-extremum.${component.id}.${worldRationalTimeKey(start)}-${worldRationalTimeKey(end)}.${rootIndex}`
          const parsed = parseWorldComponent(candidate, path)
          if (!parsed.success) {
            for (const issue of parsed.issues) {
              issues.push({ code: 'component-invariant', path: issue.path, message: issue.message })
            }
          }
        }
      }
    }
  }
  return issues
}

function findNumericCameraTrack(
  sequence: WorldSequence,
  componentId: string,
  property: 'near' | 'far',
): WorldNumericPropertyTrack | undefined {
  return sequence.tracks.find((track): track is WorldNumericPropertyTrack => (
    track.type === 'property'
    && track.componentId === componentId
    && track.property === property
    && track.keyframes.every((keyframe) => typeof keyframe.value === 'number')
  ))
}

function uniqueSortedTimes(times: readonly WorldRationalTime[]): WorldRationalTime[] {
  const sorted = times.map(normalizeWorldRationalTime).sort(compareWorldRationalTime)
  return sorted.filter((time, index) => index === 0 || compareWorldRationalTime(time, sorted[index - 1]) !== 0)
}

interface NumericTrackSegment {
  readonly left: number
  readonly right?: number
  readonly interpolation: 'step' | 'linear' | 'cubic'
  readonly offset: number
  readonly scale: number
}

function resolveNumericTrackSegment(
  track: WorldNumericPropertyTrack | undefined,
  baseValue: number,
  intervalStart: WorldRationalTime,
  intervalEnd: WorldRationalTime,
): NumericTrackSegment {
  if (!track?.keyframes.length) return { left: baseValue, interpolation: 'step', offset: 0, scale: 0 }
  let leftIndex = -1
  while (leftIndex + 1 < track.keyframes.length && compareWorldRationalTime(track.keyframes[leftIndex + 1].time, intervalStart) <= 0) leftIndex += 1
  if (leftIndex < 0) return { left: baseValue, interpolation: 'step', offset: 0, scale: 0 }
  const left = track.keyframes[leftIndex]
  const right = track.keyframes[leftIndex + 1]
  if (typeof left.value !== 'number') throw new TypeError('Numeric camera track contains a non-numeric keyframe.')
  const interpolation = left.interpolation ?? 'linear'
  if (!right || interpolation === 'step') return { left: left.value, interpolation: 'step', offset: 0, scale: 0 }
  if (typeof right.value !== 'number') throw new TypeError('Numeric camera track contains a non-numeric keyframe.')

  const offset = worldRationalDifferenceRatio(intervalStart, left.time, right.time, left.time)
  const scale = worldRationalDifferenceRatio(intervalEnd, intervalStart, right.time, left.time)
  return { left: left.value, right: right.value, interpolation, offset, scale }
}

function numericTrackPolynomial(segment: NumericTrackSegment, valueScale: number): CubicPolynomial {
  const left = segment.left / valueScale
  if (segment.right === undefined || segment.interpolation === 'step') return [left, 0, 0, 0]
  const right = segment.right / valueScale
  const delta = right - left
  if (segment.interpolation === 'linear') {
    return [left + delta * segment.offset, delta * segment.scale, 0, 0]
  }

  const offsetSquared = segment.offset * segment.offset
  const scaleSquared = segment.scale * segment.scale
  return [
    left + delta * (3 * offsetSquared - 2 * offsetSquared * segment.offset),
    delta * (6 * segment.offset * segment.scale - 6 * offsetSquared * segment.scale),
    delta * (3 * scaleSquared - 6 * segment.offset * scaleSquared),
    delta * (-2 * scaleSquared * segment.scale),
  ]
}

function evaluateNumericTrackSegment(segment: NumericTrackSegment, alpha: number): number {
  if (segment.right === undefined || segment.interpolation === 'step') return segment.left
  let progress = Math.min(1, Math.max(0, segment.offset + segment.scale * alpha))
  if (segment.interpolation === 'cubic') progress = progress * progress * (3 - 2 * progress)
  return segment.left + (segment.right - segment.left) * progress
}

function cameraCurveValueScale(
  near: number,
  far: number,
  nearTrack: WorldNumericPropertyTrack | undefined,
  farTrack: WorldNumericPropertyTrack | undefined,
): number {
  return Math.max(
    1,
    Math.abs(near),
    Math.abs(far),
    ...(nearTrack?.keyframes.map((keyframe) => typeof keyframe.value === 'number' ? Math.abs(keyframe.value) : 0) ?? []),
    ...(farTrack?.keyframes.map((keyframe) => typeof keyframe.value === 'number' ? Math.abs(keyframe.value) : 0) ?? []),
  )
}

function subtractPolynomial(left: CubicPolynomial, right: CubicPolynomial): CubicPolynomial {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2], left[3] - right[3]]
}

function derivativeRootsInsideUnitInterval(polynomial: CubicPolynomial): number[] {
  const quadratic = 3 * polynomial[3]
  const linear = 2 * polynomial[2]
  const constant = polynomial[1]
  let roots: number[]
  if (quadratic === 0) {
    roots = linear === 0 ? [] : [-constant / linear]
  } else {
    const discriminant = linear * linear - 4 * quadratic * constant
    if (discriminant < 0) return []
    const squareRoot = Math.sqrt(Math.max(0, discriminant))
    if (squareRoot === 0) roots = [-linear / (2 * quadratic)]
    else {
      const stableNumerator = -0.5 * (linear + Math.sign(linear || 1) * squareRoot)
      roots = [stableNumerator / quadratic, constant / stableNumerator]
    }
  }
  return roots
    .filter((root) => Number.isFinite(root) && root > 0 && root < 1)
    .sort((left, right) => left - right)
    .filter((root, index, sorted) => index === 0 || root !== sorted[index - 1])
}

function writeComponentProperty(component: WorldComponent, property: string, value: WorldWritableValue): void {
  const segments = property.split('.')
  let current = component as unknown as Record<string, unknown>
  for (const segment of segments.slice(0, -1)) {
    if (!Object.hasOwn(current, segment)) throw new Error(`Property ${property} is unavailable.`)
    const next = current[segment]
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error(`Property ${property} is unavailable.`)
    current = next as Record<string, unknown>
  }
  const leaf = segments.at(-1)!
  current[leaf] = structuredClone(value)
}

function isEffectivelyEnabled(scene: WorldSceneDocumentV1, entityId: string): boolean {
  const entities = new Map(scene.entities.map((entity) => [entity.id, entity]))
  const visited = new Set<string>()
  let current = entities.get(entityId)
  while (current && !visited.has(current.id)) {
    visited.add(current.id)
    if (!current.enabled) return false
    current = current.parentId ? entities.get(current.parentId) : undefined
  }
  return true
}

function deduplicateIssues(issues: WorldSequencePreflightIssue[]): WorldSequencePreflightIssue[] {
  const seen = new Set<string>()
  return issues.filter((issue) => {
    const key = `${issue.code}\0${issue.path}\0${issue.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

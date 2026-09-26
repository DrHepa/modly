import { applyWorldCommandBatch, type WorldCommand, type WorldCommandBatchV1 } from './worldCommands.ts'
import { validateWorldProjectSnapshot } from './worldDocuments.ts'
import type { WorldProjectSnapshotV1 } from './worldModel.ts'
import { sameWorldAiContext, type WorldAiContext, type WorldAiProposal } from './worldAiContract.ts'
import { compileWorldAiProposal, type WorldAiCreationObservations } from './worldAiCreationCompiler.ts'

export interface WorldAiSemanticChange { field: string; before: string | null; after: string | null }
export type WorldAiSemanticReview =
  | { complete: true; changes: WorldAiSemanticChange[]; warnings: string[] }
  | { complete: false; reason: 'invalid-snapshot' | 'unadmitted-command' | 'provenance-mismatch' | 'candidate-mismatch' | 'warning-mismatch' | 'resource-change' | 'document-path-change' | 'unsafe-content' | 'review-too-large' | 'no-change' }

/** Host-captured context and observations, never caller-authored CLI authority. */
export interface WorldAiSemanticProvenance {
  capturedContext: WorldAiContext
  proposal: WorldAiProposal
  observations: WorldAiCreationObservations
}

const MAX_REVIEW_BYTES = 64 * 1024
const MAX_REVIEW_CHANGES = 512
const MAX_WARNING_COUNT = 16
const MAX_WARNING_BYTES = 8 * 1024
const encoder = new TextEncoder()

function safeText(value: string, checkUri = true): boolean {
  if (value.length > 4096 || /[\\/]/.test(value) || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)) return false
  if (!checkUri || !/\b[A-Za-z][A-Za-z0-9+.-]{0,31}:[^\s]/u.test(value)) return true
  return /^(?:asset|camera|collider|component|entity|environment|event|graphics|input|light|model|project|renderable|resource|rigid-body|scene|sequence|track|transaction|trigger|tx|world):[A-Za-z0-9:_-]+$/.test(value)
}

/** A complete, ordered leaf projection of a canonical candidate, not a model-facing snapshot or inverse. */
export function projectWorldAiSemanticReview(
  before: WorldProjectSnapshotV1, candidate: WorldProjectSnapshotV1, batch: WorldCommandBatchV1,
  warnings: unknown, provenance: WorldAiSemanticProvenance,
): WorldAiSemanticReview {
  const fail = (reason: Extract<WorldAiSemanticReview, { complete: false }>['reason']): WorldAiSemanticReview => ({ complete: false, reason })
  if (!Array.isArray(warnings)) return fail('unsafe-content')
  if (warnings.length > MAX_WARNING_COUNT) return fail('review-too-large')
  let warningBytes = 0
  for (const warning of warnings) {
    if (typeof warning !== 'string' || !safeText(warning)) return fail('unsafe-content')
    warningBytes += encoder.encode(warning).byteLength
    if (warningBytes > MAX_WARNING_BYTES) return fail('review-too-large')
  }
  if (!provenance || !provenance.capturedContext || !provenance.proposal || !provenance.observations) return fail('provenance-mismatch')
  let compiled: ReturnType<typeof compileWorldAiProposal>
  try {
    compiled = compileWorldAiProposal(before, provenance.proposal, provenance.observations)
  } catch { return fail('provenance-mismatch') }
  if (!sameWorldAiContext(compiled.proposal.context, provenance.capturedContext)
    || !sameData(compiled.batch, batch)) return fail('provenance-mismatch')
  const original = validateWorldProjectSnapshot(before)
  const next = validateWorldProjectSnapshot(candidate)
  if (!original.success || !next.success || !sameData(original.value, before)
    || !sameData(next.value, candidate)) return fail('invalid-snapshot')
  if (!batch.commands.length || batch.commands.some((command) => !admitted(command, before))) return fail('unadmitted-command')
  const replay = applyWorldCommandBatch(before, batch)
  if (!replay.success || !sameData(replay.snapshot, candidate)) return fail('candidate-mismatch')
  if (!sameData(replay.warnings, warnings)) return fail('warning-mismatch')
  if (!sameData(before.project.resources, candidate.project.resources)) return fail('resource-change')
  for (const reference of before.project.scenes) {
    const updated = candidate.project.scenes.find((entry) => entry.id === reference.id)
    if (!updated || updated.documentPath !== reference.documentPath) return fail('document-path-change')
  }
  const stripStorage = (snapshot: WorldProjectSnapshotV1) => ({
    project: { ...snapshot.project, resources: [], scenes: snapshot.project.scenes.map(({ id, name }) => ({ id, name })) },
    scenes: snapshot.scenes,
  })
  const changes: WorldAiSemanticChange[] = []
  let unsafe = false
  let tooLarge = false
  let reviewBytes = warningBytes + 64
  const display = (value: unknown): string | null => {
    if (value === undefined) return null
    const text = JSON.stringify(value)
    if (typeof value === 'string' && !safeText(value)) unsafe = true
    if (!text || !safeText(text, false)) unsafe = true
    return text ?? null
  }
  const add = (field: string, beforeValue: unknown, afterValue: unknown): void => {
    if (unsafe || tooLarge) return
    if (!safeText(field)) { unsafe = true; return }
    const change = { field, before: display(beforeValue), after: display(afterValue) }
    if (unsafe) return
    reviewBytes += encoder.encode(JSON.stringify(change)).byteLength + 1
    if (changes.length >= MAX_REVIEW_CHANGES || reviewBytes > MAX_REVIEW_BYTES) { tooLarge = true; return }
    changes.push(change)
  }
  const walk = (field: string, left: unknown, right: unknown): void => {
    if (unsafe || tooLarge) return
    if (sameData(left, right)) return
    if (Array.isArray(left) || Array.isArray(right)) {
      const a = Array.isArray(left) ? left : []
      const b = Array.isArray(right) ? right : []
      if (!Array.isArray(left) || !Array.isArray(right) || a.length !== b.length) add(`${field}.length`, left === undefined ? undefined : a.length, right === undefined ? undefined : b.length)
      for (let index = 0; index < Math.max(a.length, b.length); index += 1) walk(`${field}[${index}]`, a[index], b[index])
      return
    }
    if ((left !== null && typeof left === 'object') || (right !== null && typeof right === 'object')) {
      const a = left && typeof left === 'object' ? left as Record<string, unknown> : {}
      const b = right && typeof right === 'object' ? right as Record<string, unknown> : {}
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
      if (!keys.length) add(field, left, right)
      else for (const key of keys) {
        if (!safeText(key)) unsafe = true
        walk(`${field}.${key}`, a[key], b[key])
      }
      return
    }
    add(field, left, right)
  }
  const left = stripStorage(before)
  const right = stripStorage(candidate)
  walk('project', left.project, right.project)
  walk('scenes', left.scenes, right.scenes)
  if (unsafe) return fail('unsafe-content')
  if (tooLarge) return fail('review-too-large')
  if (!changes.length) return fail('no-change')
  const review = { complete: true as const, changes, warnings: [...warnings] as string[] }
  if (encoder.encode(JSON.stringify(review)).byteLength > MAX_REVIEW_BYTES) return fail('review-too-large')
  return review
}

function admitted(command: WorldCommand, before: WorldProjectSnapshotV1): boolean {
  switch (command.type) {
    case 'add-scene': return !command.scene.environment.environmentResourceId && !command.scene.environment.fog
      && !command.scene.entities.length && !command.scene.sequences.length
    case 'add-entity': return command.entity.components.every((component) => component.type === 'camera' || component.type === 'light')
    case 'add-component': return command.component.type === 'collider' && command.component.purpose === 'simulation'
      || command.component.type === 'rigid-body'
    case 'replace-component': return command.component.type === 'light' || command.component.type === 'collider'
      && command.component.purpose === 'simulation' || command.component.type === 'rigid-body'
    case 'patch-entity': return Object.keys(command.patch).every((key) => ['name', 'enabled', 'transform'].includes(key))
    case 'reparent-entity': return true
    case 'set-scene-environment': {
      const current = before.scenes.find((scene) => scene.sceneId === command.sceneId)?.environment
      return !!current && current.environmentResourceId === command.environment.environmentResourceId
        && JSON.stringify(current.fog) === JSON.stringify(command.environment.fog)
        && command.environment.ambientIntensity >= 0 && command.environment.ambientIntensity <= 10
    }
    default: return false
  }
}

function sameData(left: unknown, right: unknown): boolean { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)) }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]))
  return value
}

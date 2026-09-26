import {
  getWorldComponentDefinition,
  parseWorldComponent,
  type WorldComponent,
  type WorldInspectorFieldDescriptor,
  type WorldLightComponent,
} from '../core/worldComponentRegistry.ts'
import type { WorldCommand } from '../core/worldCommands.ts'
import type { WorldEntity, WorldProjectSnapshotV1 } from '../core/worldModel.ts'
import {
  buildCascadeDeleteCommands,
  buildDuplicateSubtreesCommands,
  buildReparentEntityCommands,
  buildSetEntitiesEnabledCommands,
  buildSetEntitiesLockedCommands,
  buildSetRenderableVisibilityCommands,
  createDeterministicWorldEditorIdentityGenerator,
  type WorldEditorIdentityGenerator,
} from './worldEditorCommandBuilders.ts'

export interface WorldTreeRow {
  id: string
  entity: WorldEntity
  parentId: string | null
  depth: number
  hasChildren: boolean
  expanded: boolean
  effectiveEnabled: boolean
  effectiveLocked: boolean
}

export type WorldsPersistenceStatus = 'saved' | 'saving' | 'conflict' | 'error'

export interface WorldsPersistenceIndicator {
  status: WorldsPersistenceStatus
  recoverable: boolean
}

export function resolveWorldsPersistenceIndicator(
  lifecycle: 'closed' | 'loading' | 'ready' | 'error',
  errorCode: string | null,
): WorldsPersistenceIndicator {
  if (lifecycle === 'loading') return { status: 'saving', recoverable: false }
  if (errorCode === 'revision_conflict') return { status: 'conflict', recoverable: true }
  if (lifecycle === 'error' || errorCode) return { status: 'error', recoverable: false }
  return { status: 'saved', recoverable: false }
}

export interface WorldTreeKeyboardState {
  rows: readonly WorldTreeRow[]
  focusedId: string | null
  expandedIds: ReadonlySet<string>
}

export interface WorldTreeKeyboardResult {
  focusedId: string | null
  expandedIds: Set<string>
  activateId: string | null
}

export function shouldHandleWorldTreeRowKeyEvent(target: unknown, currentTarget: unknown): boolean {
  return target === currentTarget
}

export function resolveWorldsFocusTrapIndex(
  focusableCount: number,
  currentIndex: number,
  reverse: boolean,
): number | null {
  if (!Number.isInteger(focusableCount) || focusableCount <= 0) return null
  if (currentIndex < 0 || currentIndex >= focusableCount) return reverse ? focusableCount - 1 : 0
  return reverse
    ? (currentIndex - 1 + focusableCount) % focusableCount
    : (currentIndex + 1) % focusableCount
}

export interface WorldsFocusCandidateState {
  ariaHidden: boolean
  withinInert: boolean
  clientRectCount: number
}

export function shouldIncludeWorldsFocusCandidate(candidate: WorldsFocusCandidateState): boolean {
  return !candidate.ariaHidden && !candidate.withinInert && candidate.clientRectCount > 0
}

export function getWorldsDockFocusFallbackSelector(
  dock: 'scene' | 'assets' | 'inspector',
): string {
  return dock === 'inspector'
    ? '.worlds-workbench__dock--right'
    : `.worlds-workbench__dock--left [data-worlds-dock="${dock}"]`
}

export function createWorldTreeRows(
  entities: readonly WorldEntity[],
  expandedIds: ReadonlySet<string>,
): WorldTreeRow[] {
  const byId = new Map(entities.map((entity) => [entity.id, entity]))
  const children = new Map<string | null, WorldEntity[]>()
  for (const entity of entities) {
    const siblings = children.get(entity.parentId) ?? []
    siblings.push(entity)
    children.set(entity.parentId, siblings)
  }

  const rows: WorldTreeRow[] = []
  const append = (entity: WorldEntity, depth: number, parentEnabled: boolean, parentLocked: boolean) => {
    const entityChildren = children.get(entity.id) ?? []
    const effectiveEnabled = parentEnabled && entity.enabled
    const effectiveLocked = parentLocked || entity.locked
    const expanded = expandedIds.has(entity.id)
    rows.push({
      id: entity.id,
      entity,
      parentId: entity.parentId,
      depth,
      hasChildren: entityChildren.length > 0,
      expanded,
      effectiveEnabled,
      effectiveLocked,
    })
    if (expanded) {
      for (const child of entityChildren) append(child, depth + 1, effectiveEnabled, effectiveLocked)
    }
  }
  for (const root of children.get(null) ?? []) append(root, 1, true, false)

  // A validated document cannot contain orphans. Keeping this defensive path
  // makes the tree safe while a stale projection is being replaced.
  const included = new Set(rows.map((row) => row.id))
  for (const entity of entities) {
    if (entity.parentId === null || byId.has(entity.parentId) || included.has(entity.id)) continue
    append(entity, 1, true, true)
  }
  return rows
}

export function reduceWorldTreeKeyboard(
  state: WorldTreeKeyboardState,
  key: string,
): WorldTreeKeyboardResult {
  const expandedIds = new Set(state.expandedIds)
  const index = Math.max(0, state.rows.findIndex((row) => row.id === state.focusedId))
  const row = state.rows[index] ?? null
  let focusedId: string | null = row?.id ?? state.rows[0]?.id ?? null
  let activateId: string | null = null

  if (key === 'ArrowDown') focusedId = state.rows[Math.min(index + 1, state.rows.length - 1)]?.id ?? focusedId
  else if (key === 'ArrowUp') focusedId = state.rows[Math.max(index - 1, 0)]?.id ?? focusedId
  else if (key === 'Home') focusedId = state.rows[0]?.id ?? null
  else if (key === 'End') focusedId = state.rows.at(-1)?.id ?? null
  else if (key === 'ArrowRight' && row) {
    if (row.hasChildren && !expandedIds.has(row.id)) expandedIds.add(row.id)
    else if (row.hasChildren) {
      const child = state.rows.slice(index + 1).find((candidate) => candidate.parentId === row.id)
      if (child) focusedId = child.id
    }
  } else if (key === 'ArrowLeft' && row) {
    if (expandedIds.has(row.id)) expandedIds.delete(row.id)
    else if (row.parentId) focusedId = row.parentId
  } else if ((key === 'Enter' || key === ' ') && row) activateId = row.id

  return { focusedId, expandedIds, activateId }
}

export function selectWorldTreeEntity(
  selectedIds: readonly string[],
  entityId: string,
  modifiers: { ctrlKey: boolean; metaKey: boolean },
): string[] {
  if (!modifiers.ctrlKey && !modifiers.metaKey) return [entityId]
  if (selectedIds.includes(entityId)) return selectedIds.filter((id) => id !== entityId)
  return [...selectedIds, entityId]
}

export type WorldTreeMutation =
  | { type: 'move'; entityIds: readonly string[]; parentId: string | null; allowLocked?: boolean }
  | { type: 'set-enabled'; entityIds: readonly string[]; enabled: boolean; allowLocked?: boolean }
  | { type: 'set-locked'; entityIds: readonly string[]; locked: boolean; allowLocked?: boolean }
  | { type: 'set-visible'; entityIds: readonly string[]; visible: boolean; allowLocked?: boolean }
  | { type: 'delete'; entityIds: readonly string[]; allowLocked?: boolean }
  | { type: 'duplicate'; entityIds: readonly string[]; identitiesSeed: string; identities?: WorldEditorIdentityGenerator; allowLocked?: boolean }

export function buildWorldTreeMutationCommands(
  snapshot: WorldProjectSnapshotV1,
  sceneId: string,
  mutation: WorldTreeMutation,
): WorldCommand[] {
  const scene = snapshot.scenes.find((candidate) => candidate.sceneId === sceneId)
  if (!scene) throw new Error(`Scene ${sceneId} does not exist.`)
  const selected = [...new Set(mutation.entityIds)]
  if (selected.length === 0) throw new Error('Select at least one entity.')
  if (!mutation.allowLocked) {
    const locked = selected.find((entityId) => isWorldEntityEffectivelyLocked(scene.entities, entityId))
    if (locked) throw new Error(`Entity ${locked} is effectively locked.`)
  }

  switch (mutation.type) {
    case 'move':
      return selected.flatMap((entityId) => buildReparentEntityCommands(snapshot, sceneId, entityId, mutation.parentId))
    case 'set-enabled':
      return buildSetEntitiesEnabledCommands(snapshot, sceneId, selected, mutation.enabled)
    case 'set-locked':
      return buildSetEntitiesLockedCommands(snapshot, sceneId, selected, mutation.locked)
    case 'set-visible':
      return buildSetRenderableVisibilityCommands(snapshot, sceneId, selected, mutation.visible)
    case 'delete':
      return buildCascadeDeleteCommands(snapshot, sceneId, selected)
    case 'duplicate':
      return buildDuplicateSubtreesCommands(
        snapshot,
        sceneId,
        selected,
        mutation.identities ?? createDeterministicWorldEditorIdentityGenerator(mutation.identitiesSeed),
      )
  }
}

export function isWorldEntityEffectivelyLocked(entities: readonly WorldEntity[], entityId: string): boolean {
  const byId = new Map(entities.map((entity) => [entity.id, entity]))
  const visited = new Set<string>()
  let current = byId.get(entityId)
  while (current) {
    if (visited.has(current.id)) return true
    visited.add(current.id)
    if (current.locked) return true
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return false
}

export interface WorldNumberBounds {
  min?: number
  max?: number
}

export type ParseWorldInspectorNumberResult =
  | { success: true; value: number }
  | { success: false; error: string }

export function parseWorldInspectorNumber(value: string, bounds: WorldNumberBounds): ParseWorldInspectorNumberResult {
  const trimmed = value.trim()
  if (!trimmed) return { success: false, error: 'Enter a number.' }
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return { success: false, error: 'Use a finite number.' }
  if (bounds.min !== undefined && parsed < bounds.min) return { success: false, error: `Minimum ${bounds.min}.` }
  if (bounds.max !== undefined && parsed > bounds.max) return { success: false, error: `Maximum ${bounds.max}.` }
  return { success: true, value: parsed }
}

export interface WorldsSnapSettings {
  enabled: boolean
  increment: number
}

export function snapWorldInspectorValue(value: number, snap: WorldsSnapSettings): number {
  if (!snap.enabled || !Number.isFinite(snap.increment) || snap.increment <= 0) return value
  const snapped = Math.round(value / snap.increment) * snap.increment
  return Object.is(snapped, -0) ? 0 : Number(snapped.toPrecision(12))
}

export interface WorldsNumericDraftState {
  draft: string
  source: string
  error: string | null
}

export type WorldsNumericDraftAction =
  | { type: 'change'; value: string }
  | { type: 'source'; value: string }
  | { type: 'escape' }
  | { type: 'commit'; bounds: WorldNumberBounds }

export interface WorldsNumericDraftResult extends WorldsNumericDraftState {
  commit: number | null
}

export function reduceWorldsNumericDraft(
  state: WorldsNumericDraftState,
  action: WorldsNumericDraftAction,
): WorldsNumericDraftResult {
  if (action.type === 'change') return { ...state, draft: action.value, error: null, commit: null }
  if (action.type === 'source') return { draft: action.value, source: action.value, error: null, commit: null }
  if (action.type === 'escape') return { draft: state.source, source: state.source, error: null, commit: null }
  const parsed = parseWorldInspectorNumber(state.draft, action.bounds)
  if (!parsed.success) return { ...state, error: parsed.error, commit: null }
  const source = String(parsed.value)
  return { draft: source, source, error: null, commit: parsed.value }
}

export function getVisibleWorldInspectorFields(component: WorldComponent): readonly WorldInspectorFieldDescriptor[] {
  const definition = getWorldComponentDefinition(component.type)
  if (!definition) return []
  return definition.inspectorFields.filter((field) => {
    const condition = field.visibleWhen
    if (!condition) return true
    const actual = readComponentProperty(component, condition.property)
    return 'equals' in condition ? actual === condition.equals : condition.oneOf.includes(actual as never)
  })
}

export function buildInspectorComponentReplacement(
  component: WorldComponent,
  property: string,
  value: unknown,
): WorldComponent {
  let replacement: WorldComponent
  if (component.type === 'camera' && property === 'projection') {
    if (value === 'perspective') replacement = {
      id: component.id, type: 'camera', enabled: component.enabled, projection: 'perspective', primary: component.primary,
      near: component.near, far: component.far, fieldOfView: component.fieldOfView ?? 60,
    }
    else if (value === 'orthographic') replacement = {
      id: component.id, type: 'camera', enabled: component.enabled, projection: 'orthographic', primary: component.primary,
      near: component.near, far: component.far, orthographicSize: component.orthographicSize ?? 10,
    }
    else throw new Error('Projection is invalid.')
  } else if (component.type === 'light' && property === 'lightKind') {
    replacement = replaceLightKind(component, value)
  } else if (component.type === 'character-controller' && property === 'jumpActionId' && value === null) {
    replacement = structuredClone(component)
    delete replacement.jumpActionId
  } else {
    replacement = structuredClone(component)
    writeComponentProperty(replacement as unknown as Record<string, unknown>, property, value)
  }
  const parsed = parseWorldComponent(replacement)
  if (!parsed.success) throw new Error(parsed.issues[0]?.message ?? 'Component value is invalid.')
  return parsed.value
}

function replaceLightKind(component: WorldLightComponent, value: unknown): WorldLightComponent {
  const base = { id: component.id, type: 'light' as const, enabled: component.enabled, color: component.color, intensity: component.intensity }
  if (value === 'ambient') return { ...base, lightKind: 'ambient' }
  if (value === 'directional') return { ...base, lightKind: 'directional', castShadow: 'castShadow' in component ? component.castShadow : true }
  if (value === 'point') return { ...base, lightKind: 'point', range: 'range' in component ? component.range : 10, castShadow: 'castShadow' in component ? component.castShadow : true }
  if (value === 'spot') return { ...base, lightKind: 'spot', range: 'range' in component ? component.range : 10, angle: component.lightKind === 'spot' ? component.angle : Math.PI / 4, castShadow: 'castShadow' in component ? component.castShadow : true }
  throw new Error('Light kind is invalid.')
}

export function readComponentProperty(component: WorldComponent, property: string): unknown {
  let current: unknown = component
  for (const segment of property.split('.')) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function writeComponentProperty(target: Record<string, unknown>, property: string, value: unknown): void {
  const segments = property.split('.')
  let current = target
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment]
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error(`Property ${property} is unavailable.`)
    current = next as Record<string, unknown>
  }
  current[segments.at(-1)!] = value
}

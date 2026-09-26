import {
  canonicalWorldCommandBatchPayload,
  fingerprintWorldCommandBatch,
  type WorldCommand,
  type WorldCommandBatchV1,
} from '../core/worldCommands.ts'
import { safeWorldAiText, type WorldAiPropertyDiff, type WorldAiProposal } from '../core/worldAiContract.ts'
import { describeWorldComponentForAi } from '../core/worldComponentRegistry.ts'
import { worldEditorCommandPort, type WorldEditorCommandPort } from './worldEditorCommandPort.ts'
import type {
  WorldEditorControllerError,
  WorldEditorDispatchSuccess,
  WorldEditorProposalGuard,
} from './worldEditorController.ts'

const DEFAULT_MAX_PAGE_SIZE = 50
const DEFAULT_MAX_PROPOSALS = 32
const MAX_DIFF_ENTRIES = 64

export type WorldAiQueryRequest =
  | { kind: 'project'; cursor?: string; pageSize?: number }
  | { kind: 'scenes'; cursor?: string; pageSize?: number }
  | { kind: 'entities'; sceneId: string; cursor?: string; pageSize?: number }
  | { kind: 'components'; sceneId: string; entityId?: string; cursor?: string; pageSize?: number }

export interface WorldAiPage<T> {
  items: readonly T[]
  nextCursor: string | null
  total: number
}

export interface WorldAiProposalPreview {
  details: readonly WorldAiPropertyDiff[]
  handle: string
  batch: WorldCommandBatchV1
  fingerprint: string
  baseRevision: number
  summary: {
    changeCount: number
    warningCount: number
    changes: readonly string[]
    warnings: readonly string[]
    truncated: boolean
  }
}

export type WorldAiBridgeErrorCode =
  | WorldEditorControllerError['code']
  | 'invalid_query'
  | 'proposal_missing'
  | 'proposal_changed'

export type WorldAiBridgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: WorldAiBridgeErrorCode; message: string; retryable: boolean } }

export interface WorldAiCommandBridge {
  query(request: WorldAiQueryRequest): WorldAiBridgeResult<WorldAiPage<unknown>>
  propose(request: { transactionId: string; commands: WorldCommand[]; proposal?: WorldAiProposal; guard?: WorldEditorProposalGuard }): Promise<WorldAiBridgeResult<WorldAiProposalPreview>>
  apply(handle: string): Promise<WorldAiBridgeResult<WorldEditorDispatchSuccess>>
  reject(handle: string): WorldAiBridgeResult<{ rejected: true }>
  undo(): Promise<WorldAiBridgeResult<WorldEditorDispatchSuccess>>
}

export interface WorldAiCommandBridgeOptions {
  maxPageSize?: number
  maxProposals?: number
}

interface ProposalLedgerEntry {
  aiAuthority?: string
  handle: string
  batch: WorldCommandBatchV1
  fingerprint: string
  canonicalPayload: string
  guard?: WorldEditorProposalGuard
}

export function createWorldAiCommandBridge(
  port: WorldEditorCommandPort,
  options: WorldAiCommandBridgeOptions = {},
): WorldAiCommandBridge {
  const maxPageSize = boundedInteger(options.maxPageSize, DEFAULT_MAX_PAGE_SIZE, 1, 100)
  const maxProposals = boundedInteger(options.maxProposals, DEFAULT_MAX_PROPOSALS, 1, 128)
  const ledger = new Map<string, ProposalLedgerEntry>()
  let proposalSequence = 0
  const retire = (handle: string) => {
    const entry = ledger.get(handle)
    ledger.delete(handle)
    if (entry?.aiAuthority && entry.guard) {
      const disposal = port.discardAiProposal?.(entry.aiAuthority, entry.guard.context)
      void disposal?.catch(() => undefined)
    }
  }

  return Object.freeze({
    query(request: WorldAiQueryRequest): WorldAiBridgeResult<WorldAiPage<unknown>> {
      const context = port.getActiveContext()
      if (!context) return failed('project_closed', 'Open a World project before querying it.')
      const cursor = parseCursor(request.cursor)
      if (cursor === null) return failed('invalid_query', 'Query cursor is invalid.')
      const pageSize = boundedInteger(request.pageSize, maxPageSize, 1, maxPageSize)
      let items: unknown[]
      if (request.kind === 'project') {
        items = [{
          id: context.projectId,
          name: context.snapshot.project.name,
          revision: context.snapshot.project.revision,
          startSceneId: context.snapshot.project.startSceneId,
          sceneCount: context.snapshot.project.scenes.length,
          resourceCount: context.snapshot.project.resources.length,
          inputActions: context.snapshot.project.inputActions.map((action) => ({ id: action.id, name: action.name, valueType: action.valueType })),
          graphicsProfiles: context.snapshot.project.graphicsProfiles.map((profile) => ({ id: profile.id, name: profile.name })),
          activeGraphicsProfileId: context.snapshot.project.activeGraphicsProfileId,
        }]
      } else if (request.kind === 'scenes') {
        const scenesById = new Map(context.snapshot.scenes.map((scene) => [scene.sceneId, scene]))
        items = context.snapshot.project.scenes
          .map((reference) => {
            const scene = scenesById.get(reference.id)
            return {
              id: reference.id,
              name: reference.name,
              isStart: reference.id === context.snapshot.project.startSceneId,
              isActive: reference.id === context.activeSceneId,
              entityCount: scene?.entities.length ?? 0,
              sequenceCount: scene?.sequences.length ?? 0,
            }
          })
          .sort(compareById)
      } else {
        const scene = context.snapshot.scenes.find((candidate) => candidate.sceneId === request.sceneId)
        if (!scene) return failed('scene_missing', `Scene ${request.sceneId} does not exist.`)
        if (request.kind === 'entities') {
          items = scene.entities.map((entity) => ({
            id: entity.id,
            name: entity.name,
            parentId: entity.parentId,
            enabled: entity.enabled,
            locked: entity.locked,
            tags: [...entity.tags],
            transform: structuredClone(entity.transform),
            components: entity.components.map((component) => ({ id: component.id, type: component.type })),
          })).sort(compareById)
        } else {
          if (request.entityId && !scene.entities.some((entity) => entity.id === request.entityId)) {
            return failed('invalid_query', `Entity ${request.entityId} does not exist.`)
          }
          items = scene.entities
            .filter((entity) => !request.entityId || entity.id === request.entityId)
            .flatMap((entity) => entity.components.map((component) => ({
              entityId: entity.id,
              ...describeWorldComponentForAi(component),
            })))
            .sort((left, right) => codeUnitCompare(left.entityId, right.entityId) || codeUnitCompare(left.id, right.id))
        }
      }
      return ok(page(items, cursor, pageSize))
    },

    async propose(request: { transactionId: string; commands: WorldCommand[]; proposal?: WorldAiProposal; guard?: WorldEditorProposalGuard }): Promise<WorldAiBridgeResult<WorldAiProposalPreview>> {
      if (request.proposal && (!request.guard || !port.previewAiProposal)) return failed('invalid_command', 'Host AI creation preview is unavailable.')
      const preview = request.proposal ? await port.previewAiProposal!(structuredClone(request.proposal), request.guard!) : await port.previewProposal({
        transactionId: request.transactionId,
        origin: 'ai',
        commands: structuredClone(request.commands),
      }, request.guard)
      if (!preview.ok) return fromControllerFailure(preview.error)
      const batch = structuredClone(preview.value.batch)
      const canonicalPayload = canonicalWorldCommandBatchPayload(batch)
      const fingerprint = fingerprintWorldCommandBatch(batch)
      if (fingerprint !== preview.value.fingerprint) return failed('proposal_changed', 'Proposal fingerprint changed during preview.')
      proposalSequence += 1
      const handle = `proposal:${proposalSequence.toString(36)}:${fingerprint.slice('fnv1a32:'.length)}`
      const entry = deepFreezeData<ProposalLedgerEntry>({ handle, batch, fingerprint, canonicalPayload, guard: request.guard, ...(preview.value.aiAuthority ? { aiAuthority: preview.value.aiAuthority } : {}) })
      ledger.set(handle, entry)
      while (ledger.size > maxProposals) {
        const oldest = ledger.keys().next().value as string | undefined
        if (!oldest) break
        retire(oldest)
      }
      const changes = preview.value.changes.slice(0, MAX_DIFF_ENTRIES).map(safeWorldAiText)
      const warnings = preview.value.warnings.slice(0, MAX_DIFF_ENTRIES).map(safeWorldAiText)
      return ok(deepFreezeData({
        handle,
        details: [...preview.value.details],
        batch: structuredClone(batch),
        fingerprint,
        baseRevision: batch.baseRevision,
        summary: {
          changeCount: preview.value.changes.length,
          warningCount: preview.value.warnings.length,
          changes,
          warnings,
          truncated: preview.value.changes.length > changes.length || preview.value.warnings.length > warnings.length,
        },
      }))
    },

    async apply(handle: string): Promise<WorldAiBridgeResult<WorldEditorDispatchSuccess>> {
      const entry = ledger.get(handle)
      if (!entry) return failed('proposal_missing', 'AI proposal no longer exists.')
      const context = port.getActiveContext()
      if (!context || context.projectId !== entry.batch.projectId || context.baseRevision !== entry.batch.baseRevision) {
        retire(handle)
        return failed('revision_conflict', 'AI proposal is stale.')
      }
      if (canonicalWorldCommandBatchPayload(entry.batch) !== entry.canonicalPayload
        || fingerprintWorldCommandBatch(entry.batch) !== entry.fingerprint) {
        retire(handle)
        return failed('proposal_changed', 'AI proposal changed after preview.')
      }
      const applied = await port.applyProposalExact(entry.batch, entry.guard, entry.aiAuthority)
      if (!applied.ok) {
        if (applied.error.code === 'revision_conflict' || entry.aiAuthority) retire(handle)
        return fromControllerFailure(applied.error)
      }
      ledger.delete(handle)
      return ok(applied.value)
    },

    reject(handle: string): WorldAiBridgeResult<{ rejected: true }> {
      const entry = ledger.get(handle)
      if (!entry) return failed('proposal_missing', 'AI proposal no longer exists.')
      retire(handle)
      return ok(deepFreezeData({ rejected: true as const }))
    },

    async undo(): Promise<WorldAiBridgeResult<WorldEditorDispatchSuccess>> {
      const result = await port.undo()
      return result.ok ? ok(result.value) : fromControllerFailure(result.error)
    },
  })
}

export const worldAiCommandBridge: WorldAiCommandBridge = createWorldAiCommandBridge(worldEditorCommandPort)

function page<T>(items: readonly T[], offset: number, pageSize: number): WorldAiPage<T> {
  const safeOffset = Math.min(offset, items.length)
  const pageItems = items.slice(safeOffset, safeOffset + pageSize)
  const nextOffset = safeOffset + pageItems.length
  return deepFreezeData({
    items: structuredClone(pageItems),
    nextCursor: nextOffset < items.length ? `cursor:${nextOffset}` : null,
    total: items.length,
  })
}

function parseCursor(value: string | undefined): number | null {
  if (value === undefined) return 0
  const match = /^cursor:(0|[1-9][0-9]{0,8})$/.exec(value)
  if (!match) return null
  const offset = Number(match[1])
  return Number.isSafeInteger(offset) ? offset : null
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)))
}

function compareById(left: { id: string }, right: { id: string }): number {
  return codeUnitCompare(left.id, right.id)
}

function fromControllerFailure<T>(failure: WorldEditorControllerError): WorldAiBridgeResult<T> {
  return failed(failure.code, failure.message, failure.retryable)
}

function ok<T>(value: T): WorldAiBridgeResult<T> {
  return { ok: true, value }
}

function failed<T>(code: WorldAiBridgeErrorCode, message: string, retryable = false): WorldAiBridgeResult<T> {
  return { ok: false, error: deepFreezeData({ code, message, retryable }) }
}

function deepFreezeData<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) deepFreezeData(descriptor.value)
  }
  Object.freeze(value)
  return value
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

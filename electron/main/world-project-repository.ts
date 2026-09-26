import { assertWorldAiSnapshot, describeWorldAiCandidate, parseWorldAiContext, parseWorldAiProposal, parseWorldAiQueryRequest, projectWorldAiQuery, sameWorldAiContext, WorldAiContractError, type WorldAiContext, type WorldAiQueryPage, type WorldAiProposal } from '../../src/areas/worlds/core/worldAiContract.ts'
import { compileWorldAiProposal } from '../../src/areas/worlds/core/worldAiCreationCompiler.ts'
import { projectWorldAiSemanticReview, type WorldAiSemanticReview } from '../../src/areas/worlds/core/worldAiSemanticReview.ts'
import { worldAiObservationAuthority } from './world-ai-resource-observations.ts'
import type { WorldProjectAiPreviewRequest, WorldProjectAiPreviewResult, WorldProjectAiDiscardRequest } from '../../src/shared/types/worldProjects.ts'
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  applyWorldCommandBatch,
  canonicalWorldCommandBatchPayload,
  parseWorldCommandBatch,
  type ApplyWorldCommandBatchResult,
  type WorldCommandBatchV1,
  type WorldCommandInverse,
} from '../../src/areas/worlds/core/worldCommands.ts'
import {
  cloneWorldProjectSnapshot,
  validateWorldProjectSnapshot,
  type WorldDocumentIssue,
} from '../../src/areas/worlds/core/worldDocuments.ts'
import {
  WORLD_PROJECT_SCHEMA,
  WORLD_SCENE_SCHEMA,
  type WorldProjectSnapshotV1,
  type WorldSceneDocumentV1,
} from '../../src/areas/worlds/core/worldModel.ts'
import { isWorldCanonicalId } from '../../src/areas/worlds/core/worldValidationLimits.ts'
import { canonicalWorldProjectSnapshotPayload } from '../../src/areas/worlds/core/worldSnapshotDigest.ts'
import { isSafeWorldWireRecord } from '../../src/areas/worlds/core/worldWireValidation.ts'
import {
  isWorldProjectKey,
  type WorldProjectResult,
  type WorldProjectCommandRequest,
  type WorldProjectCommandResult,
  type WorldProjectCommandSuccess,
  type WorldProjectCreateRequest,
  type WorldProjectCreateResult,
  type WorldProjectDeleteRequest,
  type WorldProjectDeleteResult,
  type WorldProjectDiscoveryIssue,
  type WorldProjectKeyRequest,
  type WorldProjectListResult,
  type WorldProjectOpenResult,
  type WorldProjectPublicError,
  type WorldProjectPublicErrorCode,
  type WorldProjectSummary,
  type WorldProjectTransactionReceipt,
} from '../../src/shared/types/worldProjects.ts'
import { processOrderedSettledCohorts, readBoundedOpenedFile, readOpenedFileRange, type PositionalReadFile, WorldRepositoryIoError } from './world-repository-io.ts'

const STATE_SCHEMA = 'modly.world-project-state.v1' as const
const JOURNAL_SCHEMA = 'modly.world-project-journal.v1' as const
const COMMAND_RESULT_SCHEMA = 'modly.world-command-result.v1' as const
const COMMAND_RESULT_COMPACT_SCHEMA = 'modly.world-command-result.v2' as const
const DELETE_RECEIPT_SCHEMA = 'modly.world-delete-receipt.v1' as const
const PROJECT_FILE = 'project.world-project.json'
const STATE_FILE = '.modly/state.v1.json'
const JOURNAL_FILE = '.modly/journal.v1.json'
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
const MAX_STATE_BYTES = 16 * 1024 * 1024
const MAX_CANONICAL_BATCH_BYTES = 256 * 1024
const MAX_BACKUP_PACK_INDEX_BYTES = 64 * 1024

/** Exact durable retention contract for transaction reuse detection. */
export const WORLD_PROJECT_TRANSACTION_LEDGER_LIMIT = 32
/** Exact number of complete prior snapshots retained, excluding a referenced older backup. */
export const WORLD_PROJECT_BACKUP_LIMIT = 8
const BACKUP_RESULT_COPY_COHORT_SIZE = 4
const LEDGER_PROOF_READ_COHORT_SIZE = 4

const LOCK_STALE_MS = 2 * 60 * 1_000
const SCENE_FILE_PATTERN = /^scene-[a-f0-9]{32}\.world-scene\.json$/
const DIGEST_PATTERN = /^[a-f0-9]{64}$/
const BACKUP_PATTERN = /^\.modly\/backups\/[0-9]+-[a-f0-9]{64}$/
const BACKUP_NAME_PATTERN = /^[0-9]+-[a-f0-9]{64}$/
const AFTER_ROOT_PATTERN = /^\.modly\/transactions\/[a-f0-9]{64}\/after$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const BACKUP_TRANSACTION_PACK_SCHEMA = 'modly.world-backup-transaction-pack.v1' as const
const BACKUP_TRANSACTION_PACK_FILE = 'transactions.pack.v1'
const BACKUP_TRANSACTION_PACK_INDEX_FILE = 'transactions.index.v1.json'
const FUTURE_PROJECT_SCHEMA_PATTERN = /^modly\.world-project\.v(?:[2-9]|[1-9][0-9]{1,8})$/
const FUTURE_STATE_SCHEMA_PATTERN = /^modly\.world-project-state\.v(?:[2-9]|[1-9][0-9]{1,8})$/

interface RepositoryContext {
  workspaceRoot: string
  worldsRoot: string
}

interface StateFileRef {
  path: string
  sha256: string
}

interface StateSceneRef extends StateFileRef {
  sceneId: string
}

interface DurableTransaction {
  transactionId: string
  transactionDigest: string
  payloadSha256: string
  canonicalPayload: string
  appliedRevision: number
  resultSha256: string
}

interface DurableResultChainProof {
  snapshotCanonical: string
  inverseSnapshotCanonical: string
}

interface VerifiedDurableResultSemantics {
  value: WorldProjectCommandSuccess
  proof: DurableResultChainProof
}

// This capability never escapes its locked apply operation or retains parsed graphs.
interface DurableResultProofScope {
  (
    bytes: Buffer,
    projectKey: string,
    projectId: string,
    transaction: DurableTransaction,
    source?: DurableResultProofSource,
    backupCost?: BackupCostContext,
  ): DurableResultChainProof
  promote(): void
  discard(): void
  createBackupBridge?(backupRelativePath: string): NewBackupSemanticBridge | undefined
  settlePackedBackup?(): void
  discardBackupBridge?(): void
  retirePublicationAuthorities?(nextTransactionDigests: readonly string[]): void
}

interface NewBackupSemanticBridge {
  sourceScope: DurableResultProofScope
  destinationScope: DurableResultProofScope
  sealDestination(indexSha256: string, packSha256: string, packByteLength: number): void
  discard(): void
}

type BackupPackSourceMode = 'auto' | 'force-full-primary' | 'force-previous-packed-overlap'

type DurableResultProofSource =
  | { layout: 'primary-legacy' }
  | { layout: 'backup-legacy'; backupRelativePath: string }
  | {
      layout: 'backup-pack'
      backupRelativePath: string
      indexSha256: string
      packByteLength: number
      packSha256: string
      offset: number
      length: number
    }

interface WorldProjectStateV1 {
  schema: typeof STATE_SCHEMA
  projectKey: string
  projectId: string
  committedRevision: number
  project: StateFileRef
  scenes: StateSceneRef[]
  transactions: DurableTransaction[]
  lastValidBackup: string | null
}

interface WorldProjectJournalV1 {
  schema: typeof JOURNAL_SCHEMA
  projectKey: string
  transactionDigest: string
  afterRoot: string
  afterStateSha256: string
  previousBackup: string | null
  removedScenes: string[]
  keepAfter: boolean
}

interface StoredCommandResultV1 {
  schema: typeof COMMAND_RESULT_SCHEMA
  transactionId: string
  snapshot: WorldProjectSnapshotV1
  newRevision: number
  changes: string[]
  warnings: string[]
  inverse: WorldCommandInverse
}

interface StoredCommandResultV2 {
  schema: typeof COMMAND_RESULT_COMPACT_SCHEMA
  transactionId: string
  newRevision: number
  changes: string[]
  warnings: string[]
  inverse: WorldCommandInverse
}

type StoredCommandResult = StoredCommandResultV1 | StoredCommandResultV2

function buildStoredCommandResult(
  schema: 'v1' | 'v2',
  transactionId: string,
  applied: {
    snapshot: WorldProjectSnapshotV1
    changes: readonly string[]
    warnings: readonly string[]
    inverse: WorldCommandInverse
  },
): StoredCommandResult {
  const common = {
    transactionId,
    newRevision: applied.snapshot.project.revision,
    changes: [...applied.changes],
    warnings: [...applied.warnings],
    inverse: cloneWorldInverse(applied.inverse),
  }
  return schema === 'v1'
    ? { schema: COMMAND_RESULT_SCHEMA, snapshot: cloneWorldProjectSnapshot(applied.snapshot), ...common }
    : { schema: COMMAND_RESULT_COMPACT_SCHEMA, ...common }
}

// Operation-local ownership: neither the stored graph nor this handoff is public or cached.
type EvaluatedCommandResult =
  | { kind: 'idempotent'; publicResult: WorldProjectCommandSuccess }
  | {
      kind: 'new'
      publicResult: WorldProjectCommandSuccess
      storedResult: StoredCommandResult
      canonicalPayload: string
      resultSha256: string
    }

interface BackupTransactionPackIndexEntry {
  transactionId: string
  transactionDigest: string
  resultSha256: string
  offset: number
  length: number
}

interface BackupTransactionPackIndexV1 {
  schema: typeof BACKUP_TRANSACTION_PACK_SCHEMA
  projectKey: string
  projectId: string
  committedRevision: number
  stateSha256: string
  pack: {
    path: typeof BACKUP_TRANSACTION_PACK_FILE
    byteLength: number
    sha256: string
  }
  entries: BackupTransactionPackIndexEntry[]
}

interface DeleteReceiptV1 {
  schema: typeof DELETE_RECEIPT_SCHEMA
  transactionId: string
  canonicalPayload: string
  payloadSha256: string
  projectKey: string
  expectedRevision: number
  trashName: string
  status: 'prepared' | 'committed'
}

interface LoadedReadyProject {
  status: 'ready'
  projectKey: string
  projectRoot: string
  state: WorldProjectStateV1
  snapshot: WorldProjectSnapshotV1
  durabilityWarnings: string[]
}

interface LoadedUnsupportedProject {
  status: 'unsupported'
  projectKey: string
  schema: string
}

type LoadedProject = LoadedReadyProject | LoadedUnsupportedProject

type InspectedProject =
  | { status: 'ready'; projectKey: string; snapshot: WorldProjectSnapshotV1 }
  | LoadedUnsupportedProject
  | { status: 'needs-recovery'; projectKey: string }

export interface WorldProjectRepositoryOptions {
  getWorkspaceRoot(): string | Promise<string>
  createProjectKey?: () => string
  createSceneKey?: () => string
  now?: () => Date
  failureCheckpoint?: (stage: string) => void | Promise<void>
  syncDirectory?: (directory: string) => boolean | Promise<boolean>
  isProcessAlive?: (pid: number) => boolean | Promise<boolean>
  backupCostObserver?: (record: Readonly<BackupCostRecord>) => undefined
  diagnosticStoredResultSchema?: 'v1' | 'v2'
  diagnosticBackupPackSource?: BackupPackSourceMode
}

export interface BackupCostRecord {
  readonly schema: 'modly.world-backup-cost.v1'
  readonly invocation: number
  readonly sequence: number
  readonly span: number
  readonly parent: number | null
  readonly phase: 'prior-proof' | 'copy-package' | 'pack-ledger' | 'index' | 'seal-sync'
  readonly kind: 'envelope' | 'bounded-read' | 'read-await' | 'write-file' | 'write-positional'
    | 'file-sync' | 'directory-sync' | 'utf8-decode' | 'json-parse' | 'validate'
    | 'canonical-parse' | 'canonical-encode' | 'replay' | 'encode-buffer' | 'hash'
    | 'copy' | 'proof-lookup' | 'metadata' | 'cache-hit' | 'cache-miss'
    | 'cache-admit' | 'cache-evict' | 'observer-fault'
  readonly edge: 'begin' | 'settled'
  readonly ns: string
  readonly ledgerIndex: number | null
  readonly appliedRevision: number | null
  readonly target: 'project' | 'scene' | 'state' | 'receipt' | 'pack' | 'index' | 'directory'
  readonly requestedBytes: number | null
  readonly completedBytes: number | null
  readonly sourceBytes: number | null
  readonly calls: number
  readonly outcome: 'pending' | 'fulfilled' | 'rejected'
  readonly durable: boolean | null
}

type BackupCostPhase = BackupCostRecord['phase']
type BackupCostKind = BackupCostRecord['kind']
type BackupCostTarget = BackupCostRecord['target']
type BackupCostOutcome = Exclude<BackupCostRecord['outcome'], 'pending'>
interface BackupCostSpanMetadata {
  phase: BackupCostPhase
  kind: BackupCostKind
  parent: number | null
  target: BackupCostTarget
  ledgerIndex: number | null
  appliedRevision: number | null
  requestedBytes: number | null
  sourceBytes: number | null
}
interface BackupCostState {
  observer: NonNullable<WorldProjectRepositoryOptions['backupCostObserver']>
  invocation: number
  sequence: number
  nextSpan: number
  lastNs: bigint
  pending: Map<number, BackupCostSpanMetadata>
  delivering: boolean
  faulted: boolean
  faultSignaled: boolean
  closed: boolean
}

interface IncrementalBackupPackPlan {
  backupRoot: string
  packed: { index: BackupTransactionPackIndexV1; indexSha256: string }
  overlapStart: number
  overlapLength: number
}

class BackupCostContext {
  readonly #state: BackupCostState
  readonly #phase: BackupCostPhase
  readonly #parent: number | null

  constructor(state: BackupCostState, phase: BackupCostPhase, parent: number | null) {
    this.#state = state
    this.#phase = phase
    this.#parent = parent
  }

  view(phase: BackupCostPhase, parent = this.#parent): BackupCostContext {
    return new BackupCostContext(this.#state, phase, parent)
  }

  begin(kind: BackupCostKind, target: BackupCostTarget, detail: Partial<Pick<BackupCostSpanMetadata,
    'ledgerIndex' | 'appliedRevision' | 'requestedBytes' | 'sourceBytes'>> = {}): number | null {
    if (this.#state.closed || this.#state.delivering || this.#state.sequence >= 8190) {
      this.#state.faulted = true
      return null
    }
    const span = ++this.#state.nextSpan
    const metadata: BackupCostSpanMetadata = {
      phase: this.#phase, kind, parent: this.#parent, target,
      ledgerIndex: detail.ledgerIndex ?? null,
      appliedRevision: detail.appliedRevision ?? null,
      requestedBytes: detail.requestedBytes ?? null,
      sourceBytes: detail.sourceBytes ?? null,
    }
    this.#state.pending.set(span, metadata)
    this.#emit(metadata, span, 'begin', 'pending', null, 0, null)
    return span
  }

  settle(span: number | null, outcome: BackupCostOutcome, detail: {
    completedBytes?: number | null; sourceBytes?: number | null; calls?: number; durable?: boolean | null
  } = {}): void {
    if (span === null || this.#state.closed) return
    const metadata = this.#state.pending.get(span)
    if (!metadata) { this.#state.faulted = true; return }
    this.#state.pending.delete(span)
    this.#emit(metadata, span, 'settled', outcome, detail.completedBytes ?? null, detail.calls ?? 1,
      detail.durable ?? null, detail.sourceBytes)
  }

  measure<T>(kind: BackupCostKind, target: BackupCostTarget, operation: () => T, detail: Partial<Pick<BackupCostSpanMetadata,
    'ledgerIndex' | 'appliedRevision' | 'requestedBytes' | 'sourceBytes'>> = {}): T {
    const span = this.begin(kind, target, detail)
    try {
      const value = operation()
      const bytes = Buffer.isBuffer(value) ? value.byteLength : typeof value === 'string' ? Buffer.byteLength(value) : null
      this.settle(span, 'fulfilled', { completedBytes: bytes, sourceBytes: detail.sourceBytes ?? null })
      return value
    } catch (error) {
      this.settle(span, 'rejected')
      throw error
    }
  }

  cache(kind: Extract<BackupCostKind, 'cache-hit' | 'cache-miss' | 'cache-admit' | 'cache-evict'>,
    sourceBytes: number): void {
    const span = this.begin(kind, 'receipt', { sourceBytes })
    this.settle(span, 'fulfilled', { sourceBytes, calls: 0 })
  }

  close(rootSpan: number | null, outcome: BackupCostOutcome): void {
    if (this.#state.closed) return
    if (this.#state.pending.size !== (rootSpan === null ? 0 : 1)) this.#state.faulted = true
    this.settle(rootSpan, outcome)
    this.#signalFault()
    this.#state.closed = true
    this.#state.pending.clear()
  }

  #clock(): bigint {
    try {
      const next = process.hrtime.bigint()
      if (next < this.#state.lastNs) throw new Error('non-monotonic observer clock')
      this.#state.lastNs = next
    } catch { this.#state.faulted = true }
    return this.#state.lastNs
  }

  #emit(metadata: BackupCostSpanMetadata, span: number, edge: BackupCostRecord['edge'], outcome: BackupCostRecord['outcome'],
    completedBytes: number | null, calls: number, durable: boolean | null, settledSourceBytes?: number | null): void {
    if (this.#state.closed || this.#state.delivering || this.#state.sequence >= 8192) {
      this.#state.faulted = true
      return
    }
    const record = Object.freeze({
      schema: 'modly.world-backup-cost.v1' as const,
      invocation: this.#state.invocation,
      sequence: ++this.#state.sequence,
      span,
      parent: metadata.parent,
      phase: metadata.phase,
      kind: metadata.kind,
      edge,
      ns: this.#clock().toString(),
      ledgerIndex: metadata.ledgerIndex,
      appliedRevision: metadata.appliedRevision,
      target: metadata.target,
      requestedBytes: metadata.requestedBytes,
      completedBytes,
      sourceBytes: settledSourceBytes === undefined ? metadata.sourceBytes : settledSourceBytes,
      calls,
      outcome,
      durable,
    }) satisfies BackupCostRecord
    if (this.#state.delivering) { this.#state.faulted = true; return }
    this.#state.delivering = true
    try {
      let returned: unknown
      try { returned = this.#state.observer(record) } catch { this.#state.faulted = true; return }
      if (returned !== undefined) {
        this.#state.faulted = true
        if ((typeof returned === 'object' && returned !== null) || typeof returned === 'function') {
          try {
            const then = (returned as { then?: unknown }).then
            if (typeof then === 'function') void Promise.resolve(returned).then(() => undefined, () => undefined)
          } catch { /* the primitive fault flag already contains hostile getters */ }
        }
      }
    } finally {
      this.#state.delivering = false
    }
  }

  #signalFault(): void {
    if (!this.#state.faulted || this.#state.faultSignaled || this.#state.delivering || this.#state.closed || this.#state.sequence >= 8192) return
    this.#state.faultSignaled = true
    const record = Object.freeze({
      schema: 'modly.world-backup-cost.v1' as const, invocation: this.#state.invocation,
      sequence: ++this.#state.sequence, span: 0, parent: null, phase: 'prior-proof' as const,
      kind: 'observer-fault' as const, edge: 'settled' as const, ns: this.#clock().toString(),
      ledgerIndex: null, appliedRevision: null, target: 'directory' as const,
      requestedBytes: null, completedBytes: null, sourceBytes: null, calls: 0,
      outcome: 'rejected' as const, durable: null,
    }) satisfies BackupCostRecord
    this.#state.closed = true
    this.#state.pending.clear()
    try {
      const returned: unknown = this.#state.observer(record)
      if ((typeof returned === 'object' && returned !== null) || typeof returned === 'function') {
        try {
          const then = (returned as { then?: unknown }).then
          if (typeof then === 'function') void Promise.resolve(returned).then(() => undefined, () => undefined)
        } catch { /* terminal diagnostic faults never recurse or escape */ }
      }
    } catch { /* terminal diagnostic faults never recurse or escape */ }
  }
}

function createBackupCostContext(observer: NonNullable<WorldProjectRepositoryOptions['backupCostObserver']>, invocation: number): {
  context: BackupCostContext; rootSpan: number | null
} {
  const state: BackupCostState = {
    observer, invocation, sequence: 0, nextSpan: 0, lastNs: 0n, pending: new Map(),
    delivering: false, faulted: false, faultSignaled: false, closed: false,
  }
  const context = new BackupCostContext(state, 'prior-proof', null)
  return { context, rootSpan: context.begin('envelope', 'directory') }
}

class RepositoryFault extends Error {
  readonly code: WorldProjectPublicErrorCode
  readonly retryable: boolean
  readonly issues?: WorldDocumentIssue[]

  constructor(
    code: WorldProjectPublicErrorCode,
    retryable = false,
    issues?: WorldDocumentIssue[],
  ) {
    super(code)
    this.code = code
    this.retryable = retryable
    this.issues = issues
  }
}

const repositoryQueues = new Map<string, Promise<void>>()

/**
 * Canonical Worlds persistence authority. Repository and IPC readers publish
 * snapshots only through the committed state marker and recover any journal
 * first. The independently named stable JSON files can be mixed briefly while
 * a commit is being published, so arbitrary external filesystem readers are
 * deliberately outside this multi-file atomicity guarantee.
 *
 * Resource workspace paths are references only: this repository never copies
 * or deletes the shared resource files they identify.
 */
export class WorldProjectRepository {
  private readonly options: WorldProjectRepositoryOptions
  private readonly createProjectKey: () => string
  private readonly createSceneKey: () => string
  private readonly now: () => Date
  private readonly diagnosticStoredResultSchema: 'v1' | 'v2'
  private readonly diagnosticBackupPackSource: BackupPackSourceMode
  readonly #durableProofCache = createDurableResultProofCache()
  #backupCostInvocation = 0

  constructor(options: WorldProjectRepositoryOptions) {
    this.options = options
    this.createProjectKey = options.createProjectKey ?? (() => `world-${randomBytes(16).toString('hex')}`)
    this.createSceneKey = options.createSceneKey ?? (() => `scene-${randomBytes(16).toString('hex')}`)
    this.now = options.now ?? (() => new Date())
    this.diagnosticStoredResultSchema = options.diagnosticStoredResultSchema === 'v1' ? 'v1' : 'v2'
    this.diagnosticBackupPackSource = isBackupPackSourceMode(options.diagnosticBackupPackSource)
      ? options.diagnosticBackupPackSource
      : 'auto'
  }

  async create(requestValue: WorldProjectCreateRequest): Promise<WorldProjectCreateResult> {
    let request: WorldProjectCreateRequest
    try {
      request = parseCreateRequest(requestValue)
    } catch (error) {
      return failureResult(error)
    }
    return this.withRootLock(async (context) => {
      let projectKey = ''
      let projectRoot = ''
      let allocated = false
      for (let attempt = 0; attempt < 8; attempt += 1) {
        projectKey = this.createProjectKey()
        if (!isWorldProjectKey(projectKey)) throw new RepositoryFault('write_failed', true)
        projectRoot = join(context.worldsRoot, projectKey)
        try {
          await mkdir(projectRoot, { mode: 0o700 })
          allocated = true
          break
        } catch (error) {
          if (nodeErrorCode(error) !== 'EEXIST' || attempt === 7) throw new RepositoryFault('write_failed', true)
        }
      }
      try {
        if (!allocated) throw new RepositoryFault('write_failed', true)
        await this.assertProjectStructure(context, projectKey, true)
        const sceneKey = this.createSceneKey()
        if (!SCENE_FILE_PATTERN.test(`${sceneKey}.world-scene.json`)) throw new RepositoryFault('write_failed', true)
        const snapshot = createInitialSnapshot(projectKey, sceneKey, request)
        const validated = validateWorldProjectSnapshot(snapshot)
        if (!validated.success) throw new RepositoryFault('invalid_request', false, validated.issues)
        assertSnapshotConfinement(projectKey, validated.value)
        const publication = await this.publishSnapshot(context, projectKey, null, validated.value, {
          transactionDigest: sha256(stableSerialize({ projectKey, snapshot: validated.value })),
          storedResult: null,
          durableTransaction: null,
        })
        return {
          ok: true,
          value: {
            projectKey,
            snapshot: cloneWorldProjectSnapshot(validated.value),
            durabilityWarnings: publication.warnings,
          },
        }
      } catch (error) {
        if (allocated) await this.cleanupUncommittedCreate(context, projectRoot)
        if (error instanceof RepositoryFault) throw error
        throw new RepositoryFault('write_failed', true)
      }
    })
  }

  async list(): Promise<WorldProjectListResult> {
    try {
      const context = await this.resolveReadOnlyContext()
      if (!context) return { ok: true, value: { projects: [], issues: [] } }
      const projects: WorldProjectSummary[] = []
      const issues: WorldProjectDiscoveryIssue[] = []
      const entries = await readdir(context.worldsRoot, { withFileTypes: true })
      for (const entry of entries.sort((left, right) => codeUnitCompare(left.name, right.name))) {
        if (entry.name.startsWith('.')) continue
        if (!isWorldProjectKey(entry.name)) continue
        if (entry.isSymbolicLink()) throw new RepositoryFault('unsafe_workspace')
        if (!entry.isDirectory()) continue
        try {
          const loaded = await this.inspectProjectForList(context, entry.name)
          if (loaded.status === 'unsupported') {
            projects.push({ projectKey: entry.name, status: 'unsupported', schema: loaded.schema })
            issues.push({ projectKey: entry.name, status: 'unsupported', code: 'unsupported_schema' })
          } else if (loaded.status === 'needs-recovery') {
            projects.push({ projectKey: entry.name, status: 'needs-recovery' })
            issues.push({ projectKey: entry.name, status: 'needs-recovery', code: 'recovery_required' })
          } else {
            projects.push({
              projectKey: entry.name,
              projectId: loaded.snapshot.project.projectId,
              name: loaded.snapshot.project.name,
              revision: loaded.snapshot.project.revision,
              status: 'ready',
            })
          }
        } catch (error) {
          if (error instanceof RepositoryFault && error.code === 'unsafe_workspace') throw error
          projects.push({ projectKey: entry.name, status: 'corrupt' })
          issues.push({ projectKey: entry.name, status: 'corrupt', code: 'corrupt_project' })
        }
      }
      const duplicateIds = new Map<string, WorldProjectSummary[]>()
      for (const project of projects) {
        if (project.status !== 'ready' || !project.projectId) continue
        const entriesForId = duplicateIds.get(project.projectId) ?? []
        entriesForId.push(project)
        duplicateIds.set(project.projectId, entriesForId)
      }
      for (const duplicates of duplicateIds.values()) {
        if (duplicates.length < 2) continue
        for (const project of duplicates) {
          project.status = 'duplicate-project-id'
          issues.push({ projectKey: project.projectKey, status: 'duplicate-project-id', code: 'duplicate_project_id' })
        }
      }
      projects.sort((left, right) => codeUnitCompare(left.projectKey, right.projectKey))
      issues.sort((left, right) => codeUnitCompare(left.projectKey, right.projectKey) || codeUnitCompare(left.code, right.code))
      return { ok: true, value: { projects, issues } }
    } catch (error) {
      return failureResult(error)
    }
  }

  async open(requestValue: WorldProjectKeyRequest): Promise<WorldProjectOpenResult> {
    let request: WorldProjectKeyRequest
    try { request = parseProjectKeyRequest(requestValue) } catch (error) { return failureResult(error) }
    return this.withRootLock(async (context) => {
      const loaded = await this.loadProject(context, request.projectKey)
      if (loaded.status === 'unsupported') {
        return { ok: true, value: { status: 'unsupported', projectKey: request.projectKey, schema: loaded.schema, readOnly: true } }
      }
      return {
        ok: true,
        value: {
          status: 'ready',
          projectKey: request.projectKey,
          snapshot: cloneWorldProjectSnapshot(loaded.snapshot),
          durabilityWarnings: [...loaded.durabilityWarnings],
        },
      }
    })
  }

  async queryAi(value: unknown): Promise<WorldProjectResult<WorldAiQueryPage>> {
    return this.queryAiInternal(value, true)
  }

  /** CLI queries create an observation scope but do not credit items before UDS delivery. */
  async queryAiForCli(value: unknown): Promise<WorldProjectResult<WorldAiQueryPage>> {
    return this.queryAiInternal(value, false)
  }

  private async queryAiInternal(value: unknown, recordBeforeReturn: boolean): Promise<WorldProjectResult<WorldAiQueryPage>> {
    try {
      const request = parseWorldAiQueryRequest(value)
      const context = await this.resolveReadOnlyContext()
      if (!context) throw new RepositoryFault('project_not_found')
      const loaded = await this.requireReadyProjectReadOnly(context, request.context.projectKey)
      assertWorldAiSnapshot(loaded.snapshot, request.context)
      const scope = await worldAiObservationAuthority.scope(context.workspaceRoot, request.context, true)
      const observations = request.query.kind === 'resources' ? await worldAiObservationAuthority.discover(scope, loaded.snapshot) : scope.discovered
      const page = projectWorldAiQuery(loaded.snapshot, request, observations)
      if (recordBeforeReturn) worldAiObservationAuthority.record(scope, page)
      return { ok: true, value: page }
    } catch (error) {
      if (error instanceof WorldAiContractError) return { ok: false, error: {
        code: error.code === 'revision_conflict' ? 'revision_conflict' : 'invalid_request', message: error.message, retryable: false,
      } }
      return failureResult(error)
    }
  }

  async recordCliAiObservation(contextValue: WorldAiContext, page: WorldAiQueryPage): Promise<void> {
    const context = parseWorldAiContext(contextValue)
    if (!sameWorldAiContext(context, page.context)) throw new WorldAiContractError('invalid_query', 'Observation context changed.')
    const workspace = await this.resolveReadOnlyContext()
    if (!workspace) throw new RepositoryFault('project_not_found')
    const scope = await worldAiObservationAuthority.scope(workspace.workspaceRoot, context)
    worldAiObservationAuthority.record(scope, page)
  }

  /** Main-only CLI preview: full objects stay in Main; incomplete semantic proof never receives Apply authority. */
  async previewCliAi(proposalValue: WorldAiProposal): Promise<WorldProjectResult<{
    batch: WorldCommandBatchV1; snapshot: WorldProjectSnapshotV1;
    review: Extract<WorldAiSemanticReview, { complete: true }>; authority: string; candidateSnapshotSha256: string
  }>> {
    try {
      const proposal = parseWorldAiProposal(proposalValue)
      const context = await this.resolveReadOnlyContext()
      if (!context) throw new RepositoryFault('project_not_found')
      const loaded = await this.requireReadyProjectReadOnly(context, proposal.context.projectKey)
      assertWorldAiSnapshot(loaded.snapshot, proposal.context)
      const scope = await worldAiObservationAuthority.scope(context.workspaceRoot, proposal.context)
      const observed = await worldAiObservationAuthority.resolve(scope, [])
      const compiled = compileWorldAiProposal(loaded.snapshot, proposal, observed)
      if (compiled.resourceHandles.length) throw new WorldAiContractError('invalid_command', 'Resource recipes are unavailable.')
      const evaluated = await this.evaluateCommands(loaded, compiled.batch)
      if (evaluated.kind === 'idempotent') throw new RepositoryFault('transaction_reuse')
      const review = projectWorldAiSemanticReview(loaded.snapshot, evaluated.publicResult.snapshot, compiled.batch,
        evaluated.publicResult.warnings, { capturedContext: proposal.context, proposal, observations: observed })
      if (!review.complete) throw new WorldAiContractError('invalid_command', 'Semantic review is incomplete.')
      const authority = worldAiObservationAuthority.issue(scope, compiled.batch, [])
      return { ok: true, value: { batch: structuredClone(compiled.batch), snapshot: cloneWorldProjectSnapshot(loaded.snapshot), review, authority,
        candidateSnapshotSha256: sha256(canonicalWorldProjectSnapshotPayload(evaluated.publicResult.snapshot)) } }
    } catch (error) {
      if (error instanceof WorldAiContractError) return { ok: false, error: { code: error.code === 'revision_conflict' ? 'revision_conflict' : 'invalid_request', message: 'The CLI proposal is invalid, stale, or unavailable.', retryable: false } }
      return failureResult(error)
    }
  }

  async previewAi(value: WorldProjectAiPreviewRequest): Promise<WorldProjectAiPreviewResult> {
    try {
      const record = exactRecord(value, ['proposal'])
      const proposal = parseWorldAiProposal(record.proposal)
      const context = await this.resolveReadOnlyContext()
      if (!context) throw new RepositoryFault('project_not_found')
      const loaded = await this.requireReadyProjectReadOnly(context, proposal.context.projectKey)
      assertWorldAiSnapshot(loaded.snapshot, proposal.context)
      const scope = await worldAiObservationAuthority.scope(context.workspaceRoot, proposal.context)
      const handles = [...new Set(proposal.commands.flatMap((command) => command.type === 'create-entity' && command.kind === 'observed-model' ? [command.resourceHandle] : []))]
      const observed = await worldAiObservationAuthority.resolve(scope, handles)
      const compiled = compileWorldAiProposal(loaded.snapshot, proposal, observed)
      const evaluated = await this.evaluateCommands(loaded, compiled.batch)
      if (evaluated.kind === 'idempotent') throw new RepositoryFault('transaction_reuse')
      const details = describeWorldAiCandidate(loaded.snapshot, compiled.candidate, compiled.batch.commands)
      const authority = worldAiObservationAuthority.issue(scope, compiled.batch, compiled.resourceHandles)
      return { ok: true, value: { batch: compiled.batch, result: evaluated.publicResult, details, authority } }
    } catch (error) {
      if (error instanceof WorldAiContractError) return { ok: false, error: { code: error.code === 'revision_conflict' ? 'revision_conflict' : 'invalid_request', message: 'The AI proposal is invalid, stale, or unavailable.', retryable: false } }
      return failureResult(error)
    }
  }

  async discardAi(value: WorldProjectAiDiscardRequest): Promise<WorldProjectResult<{ discarded: true }>> {
    try {
      const record = exactRecord(value, ['context', 'authority'])
      const requestContext = parseWorldAiContext(record.context)
      if (typeof record.authority !== 'string' || !/^apply_[a-f0-9]{48}$/.test(record.authority)) throw new RepositoryFault('invalid_request')
      const context = await this.resolveReadOnlyContext()
      if (!context) throw new RepositoryFault('project_not_found')
      await worldAiObservationAuthority.discard(context.workspaceRoot, requestContext, record.authority)
      return { ok: true, value: { discarded: true } }
    } catch { return { ok: false, error: { code: 'invalid_request', message: 'The AI proposal is unavailable.', retryable: false } } }
  }

  async previewCommands(requestValue: WorldProjectCommandRequest): Promise<WorldProjectCommandResult> {
    let request: WorldProjectCommandRequest
    try { request = parseCommandRequest(requestValue) } catch (error) { return failureResult(error) }
    try {
      const context = await this.resolveReadOnlyContext()
      if (!context) throw new RepositoryFault('project_not_found')
      const loaded = await this.requireReadyProjectReadOnly(context, request.projectKey)
      return this.evaluateCommands(loaded, request.batch).then((evaluated) => ({ ok: true as const, value: evaluated.publicResult }))
    } catch (error) {
      return failureResult(error)
    }
  }

  /** Main-only reviewed CLI entry; never register this method as project IPC. */
  async applyReviewedCliAi(request: WorldProjectCommandRequest & {
    beforeSnapshotSha256: string; candidateSnapshotSha256: string; assertLive(): void; onJournalStart(): void
  }): Promise<WorldProjectCommandResult> {
    return this.applyGuardedCliAi(request)
  }

  /** Main-only scoped direct-edit entry; never register this method as project IPC or UDS. */
  async applyScopedCliAi(request: WorldProjectCommandRequest & {
    beforeSnapshotSha256: string; candidateSnapshotSha256: string; assertLive(): void; onJournalStart(): void
  }): Promise<WorldProjectCommandResult> {
    return this.applyGuardedCliAi(request)
  }

  private async applyGuardedCliAi(request: WorldProjectCommandRequest & {
    beforeSnapshotSha256: string; candidateSnapshotSha256: string; assertLive(): void; onJournalStart(): void
  }): Promise<WorldProjectCommandResult> {
    if (request.batch.origin !== 'ai' || !request.aiAuthority || !/^[a-f0-9]{64}$/.test(request.beforeSnapshotSha256)
      || !/^[a-f0-9]{64}$/.test(request.candidateSnapshotSha256)) return failureResult(new RepositoryFault('invalid_request'))
    return this.applyCommandsInternal({ projectKey: request.projectKey, batch: request.batch, aiAuthority: request.aiAuthority }, request)
  }

  async applyCommands(requestValue: WorldProjectCommandRequest): Promise<WorldProjectCommandResult> {
    return this.applyCommandsInternal(requestValue)
  }

  private async applyCommandsInternal(requestValue: WorldProjectCommandRequest, reviewed?: {
    beforeSnapshotSha256: string; candidateSnapshotSha256: string; assertLive(): void; onJournalStart(): void
  }): Promise<WorldProjectCommandResult> {
    let request: WorldProjectCommandRequest
    try { request = parseCommandRequest(requestValue) } catch (error) { return failureResult(error) }
    const proofScopeRef: { current: DurableResultProofScope | null } = { current: null }
    try {
      const result = await this.withRootLock(async (context): Promise<WorldProjectCommandResult> => {
        const proofScope = this.#durableProofCache.createScope(context, request.projectKey)
        proofScopeRef.current = proofScope
        const loaded = await this.requireReadyProject(context, request.projectKey, proofScope, true)
        if (reviewed) {
          reviewed.assertLive()
          if (sha256(canonicalWorldProjectSnapshotPayload(loaded.snapshot)) !== reviewed.beforeSnapshotSha256) throw new RepositoryFault('revision_conflict')
        }
        let beginAiPublication: (() => void) | undefined
        if (request.aiAuthority) {
          if (request.batch.origin !== 'ai' || request.aiAuthority.context.projectKey !== request.projectKey) throw new RepositoryFault('invalid_request')
          assertWorldAiSnapshot(loaded.snapshot, request.aiAuthority.context)
          try { beginAiPublication = await worldAiObservationAuthority.redeem(context.workspaceRoot, request.aiAuthority.context, request.aiAuthority.token, request.batch) }
          catch { throw new RepositoryFault('invalid_request') }
        }
        reviewed?.assertLive()
        const evaluated = await this.evaluateCommands(loaded, request.batch)
        reviewed?.assertLive()
        if (evaluated.kind === 'idempotent') {
          if (reviewed) throw new RepositoryFault('transaction_reuse')
          return { ok: true, value: evaluated.publicResult }
        }
        const parsed = parseWorldCommandBatch(request.batch)
        if (!parsed.success) throw new RepositoryFault('invalid_request', false, parsed.issues)
        const canonicalPayload = canonicalWorldCommandBatchPayload(parsed.value)
        const payloadSha256 = sha256(canonicalPayload)
        const transactionDigest = sha256(`${parsed.value.transactionId}\n${canonicalPayload}`)
        const { storedResult, publicResult, resultSha256 } = evaluated
        const storedSchemaMatches = storedResult.schema === COMMAND_RESULT_COMPACT_SCHEMA
          || (storedResult.schema === COMMAND_RESULT_SCHEMA
            && storedResult.snapshot.project.projectId === parsed.value.projectId
            && storedResult.snapshot.project.revision === storedResult.newRevision
            && stableSerialize(storedResult.snapshot) === stableSerialize(publicResult.snapshot))
        // Reparse remains authoritative. Reuse only the independently owned evaluated graph,
        // bound to this exact batch and revision; publication still freshly encodes and hashes it.
        if (
          evaluated.canonicalPayload !== canonicalPayload
          || !storedSchemaMatches
          || storedResult.transactionId !== parsed.value.transactionId
          || parsed.value.projectId !== loaded.state.projectId
          || parsed.value.baseRevision !== loaded.snapshot.project.revision
          || storedResult.newRevision !== parsed.value.baseRevision + 1
          || storedResult.inverse.snapshot.project.projectId !== parsed.value.projectId
          || storedResult.inverse.snapshot.project.revision !== parsed.value.baseRevision
          || publicResult.projectKey !== request.projectKey
          || publicResult.snapshot.project.projectId !== parsed.value.projectId
          || publicResult.snapshot.project.revision !== storedResult.newRevision
          || publicResult.newRevision !== storedResult.newRevision
          || publicResult.receipt.transactionId !== parsed.value.transactionId
          || publicResult.receipt.appliedRevision !== storedResult.newRevision
          || publicResult.receipt.payloadSha256 !== payloadSha256
          || publicResult.receipt.resultSha256 !== resultSha256
          || reviewed && sha256(canonicalWorldProjectSnapshotPayload(publicResult.snapshot)) !== reviewed.candidateSnapshotSha256
        ) throw new RepositoryFault('write_failed', true)
        const durableTransaction: DurableTransaction = {
          transactionId: parsed.value.transactionId,
          transactionDigest,
          payloadSha256,
          canonicalPayload,
          appliedRevision: publicResult.newRevision,
          resultSha256,
        }
        try {
          const publication = await this.publishSnapshot(context, request.projectKey, loaded, publicResult.snapshot, {
            transactionDigest,
            storedResult,
            durableTransaction,
            beforeJournal: reviewed ? () => { reviewed.assertLive(); beginAiPublication?.(); reviewed.onJournalStart() } : beginAiPublication,
          }, proofScope)
          return {
            ok: true,
            value: {
              ...publicResult,
              warnings: sortedUnique([...publicResult.warnings, ...publication.warnings]),
              receipt: publicReceipt(durableTransaction),
            },
          }
        } catch (error) {
          if (error instanceof RepositoryFault) throw error
          throw new RepositoryFault('write_failed', true)
        }
      })
      if (result.ok) proofScopeRef.current?.promote()
      return result
    } finally {
      proofScopeRef.current?.discard()
    }
  }

  async delete(requestValue: WorldProjectDeleteRequest): Promise<WorldProjectDeleteResult> {
    let request: WorldProjectDeleteRequest
    try { request = parseDeleteRequest(requestValue) } catch (error) { return failureResult(error) }
    return this.withRootLock(async (context) => {
      const canonicalPayload = stableSerialize(request)
      const payloadSha256 = sha256(canonicalPayload)
    const receiptPath = deleteReceiptPath(context, request.transactionId)
      const existing = await readDeleteReceipt(receiptPath)
      if (existing) {
        if (existing.canonicalPayload !== canonicalPayload || existing.payloadSha256 !== payloadSha256) {
          throw new RepositoryFault('transaction_reuse')
        }
        if (existing.status === 'committed') {
          return { ok: true, value: { projectKey: request.projectKey, transactionId: request.transactionId, idempotent: true } }
        }
        await this.finishPreparedDelete(context, existing, receiptPath)
        return { ok: true, value: { projectKey: request.projectKey, transactionId: request.transactionId, idempotent: true } }
      }

      const loaded = await this.requireReadyProjectReadOnly(context, request.projectKey)
      if (loaded.snapshot.project.revision !== request.expectedRevision) throw new RepositoryFault('revision_conflict', true)
      const trashName = `${request.projectKey}-${payloadSha256.slice(0, 16)}`
      const receipt: DeleteReceiptV1 = {
        schema: DELETE_RECEIPT_SCHEMA,
        transactionId: request.transactionId,
        canonicalPayload,
        payloadSha256,
        projectKey: request.projectKey,
        expectedRevision: request.expectedRevision,
        trashName,
        status: 'prepared',
      }
      await ensureSafeDirectory(join(context.worldsRoot, '.trash'), true)
      await ensureSafeDirectory(dirname(receiptPath), true)
      await atomicWrite(receiptPath, encodeJson(receipt), this.options.syncDirectory)
      await this.finishPreparedDelete(context, receipt, receiptPath)
      await pruneDeleteReceipts(dirname(receiptPath), 128)
      return { ok: true, value: { projectKey: request.projectKey, transactionId: request.transactionId, idempotent: false } }
    })
  }

  private async withRootLock<T extends WorldProjectCreateResult | WorldProjectListResult | WorldProjectOpenResult | WorldProjectCommandResult | WorldProjectDeleteResult>(
    operation: (context: RepositoryContext) => Promise<T>,
  ): Promise<T> {
    let context: RepositoryContext
    try { context = await this.resolveContext() } catch (error) { return failureResult(error) as T }
    return enqueueRepository(context.workspaceRoot, async () => {
      let release: (() => Promise<void>) | null = null
      try {
        release = await this.acquireRootLock(context)
        return await operation(context)
      } catch (error) {
        return failureResult(error) as T
      } finally {
        if (release) await release()
      }
    })
  }

  private async resolveContext(): Promise<RepositoryContext> {
    const configured = await this.options.getWorkspaceRoot()
    if (typeof configured !== 'string' || !configured.trim() || configured.includes('\0') || !isAbsolute(configured)) {
      throw new RepositoryFault('unsafe_workspace')
    }
    await mkdir(configured, { recursive: true, mode: 0o700 })
    const workspaceRoot = await realpath(configured)
    const worldsRoot = join(workspaceRoot, 'Worlds')
    await ensureSafeDirectory(worldsRoot, true)
    assertContained(workspaceRoot, worldsRoot)
    return { workspaceRoot, worldsRoot }
  }

  private async resolveReadOnlyContext(): Promise<RepositoryContext | null> {
    const configured = await this.options.getWorkspaceRoot()
    if (typeof configured !== 'string' || !configured.trim() || configured.includes('\0') || !isAbsolute(configured)) {
      throw new RepositoryFault('unsafe_workspace')
    }
    try {
      const workspaceRoot = await realpath(configured)
      const workspaceInfo = await lstat(workspaceRoot)
      if (workspaceInfo.isSymbolicLink() || !workspaceInfo.isDirectory()) throw new RepositoryFault('unsafe_workspace')
      const worldsRoot = join(workspaceRoot, 'Worlds')
      assertContained(workspaceRoot, worldsRoot)
      let worldsInfo
      try { worldsInfo = await lstat(worldsRoot) } catch (error) {
        if (nodeErrorCode(error) === 'ENOENT') return null
        throw error
      }
      if (worldsInfo.isSymbolicLink() || !worldsInfo.isDirectory()) throw new RepositoryFault('unsafe_workspace')
      if (resolve(await realpath(worldsRoot)) !== resolve(worldsRoot)) throw new RepositoryFault('unsafe_workspace')
      return { workspaceRoot, worldsRoot }
    } catch (error) {
      if (error instanceof RepositoryFault) throw error
      if (nodeErrorCode(error) === 'ENOENT') return null
      throw new RepositoryFault('unsafe_workspace')
    }
  }

  private async acquireRootLock(context: RepositoryContext): Promise<() => Promise<void>> {
    const lockPath = join(context.worldsRoot, '.modly-projects.lock')
    const token = randomBytes(16).toString('hex')
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await mkdir(lockPath, { mode: 0o700 })
      } catch (error) {
        if (nodeErrorCode(error) !== 'EEXIST') throw new RepositoryFault('project_busy', true)
        if (attempt > 0 || !await this.recoverStaleLock(lockPath)) throw new RepositoryFault('project_busy', true)
        continue
      }
      try {
        await this.checkpoint('root-lock-directory-created')
        await atomicWrite(
          join(lockPath, 'owner.json'),
          encodeJson({ pid: process.pid, token, createdAt: this.now().toISOString() }),
          this.options.syncDirectory,
        )
      } catch {
        // An incomplete lock is intentional crash evidence. It is reclaimed
        // only after the same conservative stale timeout as malformed locks.
        throw new RepositoryFault('project_busy', true)
      }
      return async () => {
        try {
          const owner = parseLockOwner(await readJson(join(lockPath, 'owner.json'), 8_192))
          if (owner.token !== token) return
          const info = await lstat(lockPath)
          if (info.isSymbolicLink() || !info.isDirectory()) return
          await rm(lockPath, { recursive: true, force: true })
          await syncDirectoryWith(context.worldsRoot, this.options.syncDirectory)
        } catch { /* another process owns or already removed the lock */ }
      }
    }
    throw new RepositoryFault('project_busy', true)
  }

  private async recoverStaleLock(lockPath: string): Promise<boolean> {
    let evidence
    try {
      evidence = await this.readLockEvidence(lockPath)
    } catch (error) {
      if (error instanceof RepositoryFault) throw error
      if (nodeErrorCode(error) === 'ENOENT') return true
      throw new RepositoryFault('project_busy', true)
    }

    if (!await this.isLockEvidenceStale(evidence)) return false

    const stalePath = `${lockPath}.stale-${randomBytes(8).toString('hex')}`
    try {
      await rename(lockPath, stalePath)
    } catch (error) {
      if (nodeErrorCode(error) === 'ENOENT') return true
      return false
    }

    let claimedEvidence
    try {
      claimedEvidence = await this.readLockEvidence(stalePath)
    } catch (error) {
      await rename(stalePath, lockPath).catch(() => undefined)
      if (error instanceof RepositoryFault && error.code === 'unsafe_workspace') throw error
      return false
    }
    if (!await this.isLockEvidenceStale(claimedEvidence)) {
      await rename(stalePath, lockPath).catch(() => undefined)
      return false
    }
    await rm(stalePath, { recursive: true, force: true })
    await syncDirectoryWith(dirname(lockPath), this.options.syncDirectory)
    return true
  }

  private async readLockOwner(lockPath: string): Promise<{ pid: number; token: string; createdAt: string } | null> {
    try {
      return parseLockOwner(await readJson(join(lockPath, 'owner.json'), 8_192))
    } catch (error) {
      if (error instanceof RepositoryFault && error.code === 'unsafe_workspace') throw error
      return null
    }
  }

  private async readLockEvidence(lockPath: string): Promise<{
    owner: { pid: number; token: string; createdAt: string } | null
    modifiedAtMs: number
  }> {
    const lockInfo = await lstat(lockPath)
    if (lockInfo.isSymbolicLink() || !lockInfo.isDirectory()) throw new RepositoryFault('unsafe_workspace')
    const ownerPath = join(lockPath, 'owner.json')
    let ownerInfo
    try {
      ownerInfo = await lstat(ownerPath)
    } catch (error) {
      if (nodeErrorCode(error) === 'ENOENT') return { owner: null, modifiedAtMs: lockInfo.mtimeMs }
      throw error
    }
    if (ownerInfo.isSymbolicLink() || !ownerInfo.isFile()) throw new RepositoryFault('unsafe_workspace')
    return {
      owner: await this.readLockOwner(lockPath),
      modifiedAtMs: Math.max(lockInfo.mtimeMs, ownerInfo.mtimeMs),
    }
  }

  private async isLockEvidenceStale(evidence: {
    owner: { pid: number; token: string; createdAt: string } | null
    modifiedAtMs: number
  }): Promise<boolean> {
    const publishedAtMs = evidence.owner
      ? Math.max(Date.parse(evidence.owner.createdAt), evidence.modifiedAtMs)
      : evidence.modifiedAtMs
    const age = this.now().getTime() - publishedAtMs
    if (!Number.isFinite(age) || age < LOCK_STALE_MS) return false
    return !evidence.owner || !await this.processAlive(evidence.owner.pid)
  }

  private async processAlive(pid: number): Promise<boolean> {
    if (this.options.isProcessAlive) return this.options.isProcessAlive(pid)
    try { process.kill(pid, 0); return true } catch (error) { return nodeErrorCode(error) !== 'ESRCH' }
  }

  private async requireReadyProject(context: RepositoryContext, projectKey: string, proofScope?: DurableResultProofScope, skipEmptyCleanup = false): Promise<LoadedReadyProject> {
    const loaded = await this.loadProject(context, projectKey, proofScope, skipEmptyCleanup)
    if (loaded.status === 'unsupported') throw new RepositoryFault('unsupported_schema')
    return loaded
  }

  private async requireReadyProjectReadOnly(
    context: RepositoryContext,
    projectKey: string,
  ): Promise<LoadedReadyProject> {
    const loaded = await this.loadProjectReadOnly(context, projectKey)
    if (loaded.status === 'unsupported') throw new RepositoryFault('unsupported_schema')
    return loaded
  }

  private async inspectProjectForList(
    context: RepositoryContext,
    projectKey: string,
  ): Promise<InspectedProject> {
    const projectRoot = join(context.worldsRoot, projectKey)
    await ensureSafeDirectory(projectRoot, false)
    const unsupported = await detectUnsupportedProject(projectRoot)
    if (unsupported) return { status: 'unsupported', projectKey, schema: unsupported }
    await this.assertProjectStructure(context, projectKey, false)
    if (await pathExists(join(projectRoot, JOURNAL_FILE))) {
      if (await this.canRecoverJournalReadOnly(projectRoot, projectKey)) {
        return { status: 'needs-recovery', projectKey }
      }
      throw new RepositoryFault('invalid_document')
    }
    const statePath = join(projectRoot, STATE_FILE)
    if (!await pathExists(statePath)) throw new RepositoryFault('invalid_document')
    const state = parseState(await readJson(statePath, MAX_STATE_BYTES), projectKey)
    try {
      const verified = await verifyStablePackage(projectRoot, projectKey, state)
      await this.verifyReferencedBackup(projectRoot, projectKey, state)
      return { status: 'ready', projectKey, snapshot: verified.snapshot }
    } catch (error) {
      if (error instanceof RepositoryFault && error.code === 'unsafe_workspace') throw error
      if (state.lastValidBackup
        && await this.isBackupValidReadOnly(projectRoot, projectKey, state.lastValidBackup, state)) {
        return { status: 'needs-recovery', projectKey }
      }
      throw new RepositoryFault('invalid_document')
    }
  }

  private async canRecoverJournalReadOnly(projectRoot: string, projectKey: string): Promise<boolean> {
    let journal: WorldProjectJournalV1
    try {
      journal = parseJournal(await readJson(join(projectRoot, JOURNAL_FILE), MAX_STATE_BYTES), projectKey)
    } catch (error) {
      if (error instanceof RepositoryFault && error.code === 'unsafe_workspace') throw error
      return false
    }
    try {
      const currentStateBytes = await readBounded(join(projectRoot, STATE_FILE), MAX_STATE_BYTES)
      const currentState = parseState(parseJsonBuffer(currentStateBytes), projectKey)
      if (sha256(currentStateBytes) === journal.afterStateSha256) {
        assertJournalMatchesStateLedger(journal, currentState)
        await verifyStablePackage(projectRoot, projectKey, currentState)
        await this.verifyReferencedBackup(projectRoot, projectKey, currentState)
        return true
      }
    } catch (error) {
      if (error instanceof RepositoryFault && error.code === 'unsafe_workspace') throw error
    }

    try {
      const afterRoot = join(projectRoot, ...journal.afterRoot.split('/'))
      assertContained(projectRoot, afterRoot)
      const afterStateBytes = await readBounded(join(afterRoot, 'state.v1.json'), MAX_STATE_BYTES)
      if (sha256(afterStateBytes) !== journal.afterStateSha256) throw new RepositoryFault('recovery_failed', true)
      const afterState = parseState(parseJsonBuffer(afterStateBytes), projectKey)
      const verifiedAfter = await verifyPackage(afterRoot, projectKey, afterState)
      assertJournalMatchesStateLedger(journal, afterState)
      await verifyStateLedgerResults(projectRoot, projectKey, afterState, '.modly/transactions', undefined, undefined, verifiedAfter.snapshot)
      await this.verifyReferencedBackup(projectRoot, projectKey, afterState)
      return true
    } catch (error) {
      if (error instanceof RepositoryFault && error.code === 'unsafe_workspace') throw error
    }

    return Boolean(journal.previousBackup
      && await this.isBackupValidReadOnly(projectRoot, projectKey, journal.previousBackup))
  }

  private async isBackupValidReadOnly(
    projectRoot: string,
    projectKey: string,
    backupRelative: string,
    successorState?: WorldProjectStateV1,
  ): Promise<boolean> {
    try {
      await this.verifyBackupPackage(projectRoot, projectKey, backupRelative, successorState)
      return true
    } catch (error) {
      if (error instanceof RepositoryFault && error.code === 'unsafe_workspace') throw error
      return false
    }
  }

  private async loadProjectReadOnly(
    context: RepositoryContext,
    projectKey: string,
  ): Promise<LoadedProject> {
    const projectRoot = join(context.worldsRoot, projectKey)
    if (!await pathExists(projectRoot)) throw new RepositoryFault('project_not_found')
    await ensureSafeDirectory(projectRoot, false)
    const unsupported = await detectUnsupportedProject(projectRoot)
    if (unsupported) return { status: 'unsupported', projectKey, schema: unsupported }
    await this.assertProjectStructure(context, projectKey, false)
    const journalPath = join(projectRoot, JOURNAL_FILE)
    if (await pathExists(journalPath)) throw new RepositoryFault('project_busy', true)
    const statePath = join(projectRoot, STATE_FILE)
    const stateBytes = await readBounded(statePath, MAX_STATE_BYTES)
    const state = parseState(parseJsonBuffer(stateBytes), projectKey)
    const verified = await verifyStablePackage(projectRoot, projectKey, state)
    if (!verified.stateBytes.equals(stateBytes)) throw new RepositoryFault('project_busy', true)
    await this.verifyReferencedBackup(projectRoot, projectKey, state)
    if (await pathExists(journalPath)) throw new RepositoryFault('project_busy', true)
    const finalStateBytes = await readBounded(statePath, MAX_STATE_BYTES)
    if (!finalStateBytes.equals(stateBytes)) throw new RepositoryFault('project_busy', true)
    return {
      status: 'ready',
      projectKey,
      projectRoot,
      state,
      snapshot: verified.snapshot,
      durabilityWarnings: [],
    }
  }

  private async loadProject(context: RepositoryContext, projectKey: string, proofScope?: DurableResultProofScope, skipEmptyCleanup = false): Promise<LoadedProject> {
    const projectRoot = join(context.worldsRoot, projectKey)
    if (!await pathExists(projectRoot)) throw new RepositoryFault('project_not_found')
    await ensureSafeDirectory(projectRoot, false)
    const unsupported = await detectUnsupportedProject(projectRoot)
    if (unsupported) return { status: 'unsupported', projectKey, schema: unsupported }
    await this.assertProjectStructure(context, projectKey, false)
    const { warnings: recoveryWarnings, recovered } = await this.recoverJournal(context, projectKey)
    const statePath = join(projectRoot, STATE_FILE)
    if (!await pathExists(statePath)) throw new RepositoryFault('invalid_document')
    const state = parseState(await readJson(statePath, MAX_STATE_BYTES), projectKey)
    let verified: { snapshot: WorldProjectSnapshotV1; stateBytes: Buffer }
    try {
      verified = await verifyStablePackage(projectRoot, projectKey, state, '.modly/transactions', proofScope)
      await this.verifyReferencedBackup(projectRoot, projectKey, state, proofScope)
    } catch (error) {
      if (error instanceof RepositoryFault && error.code === 'unsafe_workspace') throw error
      if (!state.lastValidBackup) throw error
      await this.restoreBackup(context, projectKey, state.lastValidBackup)
      const restoredState = parseState(await readJson(statePath, MAX_STATE_BYTES), projectKey)
      verified = await verifyStablePackage(projectRoot, projectKey, restoredState)
      await this.verifyReferencedBackup(projectRoot, projectKey, restoredState)
      await this.cleanupOrphans(projectRoot, restoredState)
      return { status: 'ready', projectKey, projectRoot, state: restoredState, snapshot: verified.snapshot, durabilityWarnings: recoveryWarnings }
    }
    await this.cleanupOrphans(projectRoot, state, proofScope, skipEmptyCleanup && !recovered)
    return { status: 'ready', projectKey, projectRoot, state, snapshot: verified.snapshot, durabilityWarnings: recoveryWarnings }
  }

  private async assertProjectStructure(context: RepositoryContext, projectKey: string, create: boolean): Promise<void> {
    if (!isWorldProjectKey(projectKey)) throw new RepositoryFault('invalid_request')
    const projectRoot = join(context.worldsRoot, projectKey)
    assertContained(context.worldsRoot, projectRoot)
    await ensureSafeDirectory(projectRoot, create)
    await ensureSafeDirectory(join(projectRoot, 'scenes'), create)
    await ensureSafeDirectory(join(projectRoot, '.modly'), create)
    await ensureSafeDirectory(join(projectRoot, '.modly', 'transactions'), create)
    await ensureSafeDirectory(join(projectRoot, '.modly', 'backups'), create)
    for (const target of [join(projectRoot, PROJECT_FILE), join(projectRoot, STATE_FILE), join(projectRoot, JOURNAL_FILE)]) {
      await rejectSymlinkIfPresent(target)
    }
  }

  private async cleanupUncommittedCreate(context: RepositoryContext, projectRoot: string): Promise<void> {
    try {
      if (await pathExists(join(projectRoot, STATE_FILE)) || await pathExists(join(projectRoot, JOURNAL_FILE))) return
      await ensureSafeDirectory(projectRoot, false)
      assertContained(context.worldsRoot, projectRoot)
      await rm(projectRoot, { recursive: true, force: true })
      await syncDirectoryWith(context.worldsRoot, this.options.syncDirectory)
    } catch (error) {
      if (error instanceof RepositoryFault && error.code === 'unsafe_workspace') throw error
      throw new RepositoryFault('write_failed', true)
    }
  }

  private async evaluateCommands(
    loaded: LoadedReadyProject,
    batchValue: WorldCommandBatchV1,
  ): Promise<EvaluatedCommandResult> {
    const parsed = parseWorldCommandBatch(batchValue)
    if (!parsed.success) throw new RepositoryFault('invalid_request', false, parsed.issues)
    const canonicalPayload = canonicalWorldCommandBatchPayload(parsed.value)
    if (Buffer.byteLength(canonicalPayload, 'utf8') > MAX_CANONICAL_BATCH_BYTES) throw new RepositoryFault('invalid_request')
    const payloadSha256 = sha256(canonicalPayload)
    const existing = loaded.state.transactions.find((entry) => entry.transactionId === parsed.value.transactionId)
    if (existing) {
      if (existing.canonicalPayload !== canonicalPayload || existing.payloadSha256 !== payloadSha256) {
        throw new RepositoryFault('transaction_reuse')
      }
      return {
        kind: 'idempotent',
        publicResult: await readStoredPublicResult(
          loaded.projectRoot,
          loaded.projectKey,
          loaded.state.projectId,
          existing,
          true,
        ),
      }
    }
    const applied = applyWorldCommandBatch(loaded.snapshot, parsed.value)
    if (!applied.success) throw mapCommandFailure(applied)
    assertSnapshotConfinement(loaded.projectKey, applied.snapshot)
    const stored = buildStoredCommandResult(this.diagnosticStoredResultSchema, parsed.value.transactionId, applied)
    const transactionDigest = sha256(`${parsed.value.transactionId}\n${canonicalPayload}`)
    const durable: DurableTransaction = {
      transactionId: parsed.value.transactionId,
      transactionDigest,
      payloadSha256,
      canonicalPayload,
      appliedRevision: applied.snapshot.project.revision,
      resultSha256: sha256(encodeJson(stored)),
    }
    return {
      kind: 'new',
      storedResult: stored,
      canonicalPayload,
      resultSha256: durable.resultSha256,
      publicResult: {
        projectKey: loaded.projectKey,
        snapshot: cloneWorldProjectSnapshot(applied.snapshot),
        newRevision: applied.snapshot.project.revision,
        idempotent: false,
        changes: [...applied.changes],
        warnings: [...applied.warnings],
        inverse: cloneWorldInverse(applied.inverse),
        receipt: publicReceipt(durable),
      },
    }
  }

  private async finishPreparedDelete(context: RepositoryContext, receipt: DeleteReceiptV1, receiptPath: string): Promise<void> {
    const projectRoot = join(context.worldsRoot, receipt.projectKey)
    const trashRoot = join(context.worldsRoot, '.trash')
    await ensureSafeDirectory(trashRoot, true)
    const trashPath = join(trashRoot, receipt.trashName)
    assertContained(trashRoot, trashPath)
    const projectExists = await pathExists(projectRoot)
    const trashExists = await pathExists(trashPath)
    if (projectExists && !trashExists) {
      await rename(projectRoot, trashPath)
      await syncDirectoryWith(trashRoot, this.options.syncDirectory)
      await syncDirectoryWith(context.worldsRoot, this.options.syncDirectory)
    }
    else if (projectExists && trashExists) throw new RepositoryFault('recovery_failed', true)
    else if (!trashExists) throw new RepositoryFault('project_not_found')
    const committed: DeleteReceiptV1 = { ...receipt, status: 'committed' }
    await atomicWrite(receiptPath, encodeJson(committed), this.options.syncDirectory)
  }

  private async publishSnapshot(
    context: RepositoryContext,
    projectKey: string,
    previous: LoadedReadyProject | null,
    snapshotValue: WorldProjectSnapshotV1,
    transaction: {
      transactionDigest: string
      storedResult: StoredCommandResult | null
      durableTransaction: DurableTransaction | null
      beforeJournal?: () => void
    },
    proofScope?: DurableResultProofScope,
  ): Promise<{ warnings: string[] }> {
    const validated = validateWorldProjectSnapshot(snapshotValue)
    if (!validated.success) throw new RepositoryFault('invalid_document', false, validated.issues)
    const snapshot = validated.value
    assertSnapshotConfinement(projectKey, snapshot)
    await this.assertProjectStructure(context, projectKey, true)
    const projectRoot = join(context.worldsRoot, projectKey)
    const digest = transaction.transactionDigest
    if (!DIGEST_PATTERN.test(digest)) throw new RepositoryFault('write_failed', true)
    const afterRootRelative = `.modly/transactions/${digest}/after`
    const afterRoot = join(projectRoot, ...afterRootRelative.split('/'))
    assertContained(projectRoot, afterRoot)
    const backupRelative = previous
      ? `.modly/backups/${previous.state.committedRevision}-${digest}`
      : null
    const previousTransactions = previous?.state.transactions ?? []
    const nextTransactions = transaction.durableTransaction
      ? [...previousTransactions, transaction.durableTransaction].slice(-WORLD_PROJECT_TRANSACTION_LEDGER_LIMIT)
      : previousTransactions
    // The locked prior load is already independently proved; this exact next ledger owns retirement.
    if (previous && transaction.durableTransaction) {
      proofScope?.retirePublicationAuthorities?.(nextTransactions.map((entry) => entry.transactionDigest))
    }
    const projectBytes = encodeJson(snapshot.project)
    const sceneBuffers = new Map<string, Buffer>()
    for (const scene of snapshot.scenes) {
      const reference = snapshot.project.scenes.find((candidate) => candidate.id === scene.sceneId)
      if (!reference) throw new RepositoryFault('invalid_document')
      sceneBuffers.set(reference.documentPath, encodeJson(scene))
    }
    const state: WorldProjectStateV1 = {
      schema: STATE_SCHEMA,
      projectKey,
      projectId: snapshot.project.projectId,
      committedRevision: snapshot.project.revision,
      project: { path: `Worlds/${projectKey}/${PROJECT_FILE}`, sha256: sha256(projectBytes) },
      scenes: snapshot.project.scenes.map((reference) => ({
        sceneId: reference.id,
        path: reference.documentPath,
        sha256: sha256(sceneBuffers.get(reference.documentPath)!),
      })).sort((left, right) => codeUnitCompare(left.path, right.path)),
      transactions: nextTransactions.map(cloneDurableTransaction),
      lastValidBackup: backupRelative,
    }
    const stateBytes = encodeJson(state)
    if (stateBytes.byteLength > MAX_STATE_BYTES) throw new RepositoryFault('invalid_document')
    const resultBytes = transaction.storedResult ? encodeJson(transaction.storedResult) : null
    if (resultBytes && transaction.durableTransaction?.resultSha256 !== sha256(resultBytes)) {
      throw new RepositoryFault('write_failed', true)
    }
    let durable = true
    await rm(dirname(afterRoot), { recursive: true, force: true })
    await ensureSafeDirectory(join(afterRoot, 'scenes'), true)
    durable = await writeExclusive(join(afterRoot, PROJECT_FILE), projectBytes) && durable
    for (const [workspacePath, bytes] of [...sceneBuffers].sort(([left], [right]) => codeUnitCompare(left, right))) {
      durable = await writeExclusive(join(afterRoot, 'scenes', basename(workspacePath)), bytes) && durable
    }
    if (resultBytes) durable = await writeExclusive(join(afterRoot, 'result.v1.json'), resultBytes) && durable
    durable = await writeExclusive(join(afterRoot, 'state.v1.json'), stateBytes) && durable
    durable = await syncDirectoryWith(join(afterRoot, 'scenes'), this.options.syncDirectory) && durable
    durable = await syncDirectoryWith(afterRoot, this.options.syncDirectory) && durable
    durable = await syncDirectoryWith(dirname(afterRoot), this.options.syncDirectory) && durable
    durable = await syncDirectoryWith(join(projectRoot, '.modly', 'transactions'), this.options.syncDirectory) && durable
    const verifiedAfter = await verifyPackage(afterRoot, projectKey, state)
    await verifyStateLedgerResults(projectRoot, projectKey, state, '.modly/transactions', proofScope, undefined, verifiedAfter.snapshot)
    await this.checkpoint('after-package')

    if (previous && backupRelative) {
      durable = await this.createBackup(projectRoot, previous, backupRelative, proofScope) && durable
    }
    await this.checkpoint('backup-created')

    const previousPaths = new Set(previous?.state.scenes.map((scene) => scene.path) ?? [])
    const nextPaths = new Set(state.scenes.map((scene) => scene.path))
    const removedScenes = [...previousPaths].filter((path) => !nextPaths.has(path)).sort(codeUnitCompare)
    const journal: WorldProjectJournalV1 = {
      schema: JOURNAL_SCHEMA,
      projectKey,
      transactionDigest: digest,
      afterRoot: afterRootRelative,
      afterStateSha256: sha256(stateBytes),
      previousBackup: backupRelative,
      removedScenes,
      keepAfter: Boolean(transaction.durableTransaction),
    }
    // Preparation can await; AI cancellation remains effective until the final synchronous
    // check immediately before initiating the journal-publishing rename.
    const beforeJournalPublish = transaction.beforeJournal ? () => {
      try { transaction.beforeJournal?.() } catch { throw new RepositoryFault('invalid_request') }
    } : undefined
    durable = await atomicWrite(join(projectRoot, JOURNAL_FILE), encodeJson(journal), this.options.syncDirectory,
      undefined, 'receipt', beforeJournalPublish) && durable
    await this.checkpoint('journal-published')

    durable = await atomicWrite(join(projectRoot, PROJECT_FILE), projectBytes, this.options.syncDirectory) && durable
    await this.checkpoint(`document-published:${PROJECT_FILE}`)
    for (const path of [...sceneBuffers.keys()].sort(codeUnitCompare)) {
      durable = await atomicWrite(
        join(projectRoot, 'scenes', basename(path)),
        sceneBuffers.get(path)!,
        this.options.syncDirectory,
      ) && durable
      await this.checkpoint(`document-published:scenes/${basename(path)}`)
    }
    durable = await atomicWrite(join(projectRoot, STATE_FILE), stateBytes, this.options.syncDirectory) && durable
    await this.checkpoint('state-published')
    for (const path of removedScenes) await rm(join(projectRoot, 'scenes', basename(path)), { force: true })
    durable = await syncDirectoryWith(join(projectRoot, 'scenes'), this.options.syncDirectory) && durable
    await this.checkpoint('removed-scenes-cleaned')
    const verified = await verifyStablePackage(projectRoot, projectKey, state, '.modly/transactions', proofScope)
    if (verified.snapshot.project.revision !== snapshot.project.revision) throw new RepositoryFault('write_failed', true)
    await this.verifyReferencedBackup(projectRoot, projectKey, state, proofScope)
    await rm(join(projectRoot, JOURNAL_FILE), { force: true })
    durable = await syncDirectoryWith(join(projectRoot, '.modly'), this.options.syncDirectory) && durable
    if (!journal.keepAfter) await rm(dirname(afterRoot), { recursive: true, force: true })
    await this.checkpoint('journal-cleaned')
    await this.pruneCommittedData(projectRoot, state, proofScope)
    return { warnings: durable ? [] : ['durability-degraded'] }
  }

  private async createBackup(
    projectRoot: string,
    previous: LoadedReadyProject,
    backupRelative: string,
    proofScope?: DurableResultProofScope,
  ): Promise<boolean> {
    if (!BACKUP_PATTERN.test(backupRelative)) throw new RepositoryFault('write_failed', true)
    const backupCostObserver = this.options.backupCostObserver
    const backupCost = backupCostObserver
      ? createBackupCostContext(backupCostObserver, ++this.#backupCostInvocation)
      : undefined
    const priorCost = backupCost?.context.view('prior-proof', backupCost.rootSpan)
    const copyCost = backupCost?.context.view('copy-package', backupCost.rootSpan)
    const packCost = backupCost?.context.view('pack-ledger', backupCost.rootSpan)
    const indexCost = backupCost?.context.view('index', backupCost.rootSpan)
    const sealCost = backupCost?.context.view('seal-sync', backupCost.rootSpan)
    let backupCostOutcome: BackupCostOutcome = 'rejected'
    let bridge: NewBackupSemanticBridge | undefined
    try {
      await verifyStablePackage(projectRoot, previous.projectKey, previous.state, '.modly/transactions', proofScope, priorCost)
      bridge = proofScope?.createBackupBridge?.(backupRelative)
      const backupRoot = join(projectRoot, ...backupRelative.split('/'))
      assertContained(projectRoot, backupRoot)
      await rm(backupRoot, { recursive: true, force: true })
      await ensureSafeDirectory(join(backupRoot, 'scenes'), true)
      let durable = true
      const projectBytes = await readBounded(join(projectRoot, PROJECT_FILE), MAX_DOCUMENT_BYTES, copyCost, 'project')
      durable = await writeExclusive(join(backupRoot, PROJECT_FILE), projectBytes, copyCost, 'project') && durable
      for (const scene of previous.state.scenes) {
        const bytes = await readBounded(join(projectRoot, 'scenes', basename(scene.path)), MAX_DOCUMENT_BYTES, copyCost, 'scene')
        durable = await writeExclusive(join(backupRoot, 'scenes', basename(scene.path)), bytes, copyCost, 'scene') && durable
      }
      const stateBytes = await readBounded(join(projectRoot, STATE_FILE), MAX_STATE_BYTES, copyCost, 'state')
      durable = await writeExclusive(join(backupRoot, 'state.v1.json'), stateBytes, copyCost, 'state') && durable
      const packPath = join(backupRoot, BACKUP_TRANSACTION_PACK_FILE)
      const packHash = createHash('sha256')
      const indexEntries: BackupTransactionPackIndexEntry[] = []
      let packLength = 0
      let incrementalPlan: IncrementalBackupPackPlan | null = null
      if (this.diagnosticBackupPackSource !== 'force-full-primary') {
        try {
          incrementalPlan = await planIncrementalBackupPack(projectRoot, previous)
        } catch (error) {
          if (this.diagnosticBackupPackSource === 'force-previous-packed-overlap') throw error
          incrementalPlan = null
        }
        if (!incrementalPlan && this.diagnosticBackupPackSource === 'force-previous-packed-overlap') {
          throw new RepositoryFault('recovery_failed', true)
        }
      }
      await rejectSymlinkIfPresent(packPath)
      const packHandle = await open(packPath, 'wx', 0o600)
      let packError: unknown
      try {
        const writePackEntry = async (transaction: DurableTransaction, sourceBytes: Buffer, ledgerIndex: number) => {
          if (sourceBytes.byteLength <= 0 || sourceBytes.byteLength > MAX_DOCUMENT_BYTES) {
            throw new RepositoryFault('recovery_failed', true)
          }
          await writeOpenedFileComplete(packHandle, sourceBytes, packLength, packCost, ledgerIndex, transaction.appliedRevision)
          if (packCost) packCost.measure('hash', 'pack', () => packHash.update(sourceBytes), {
            ledgerIndex, appliedRevision: transaction.appliedRevision, sourceBytes: sourceBytes.byteLength,
          })
          else packHash.update(sourceBytes)
          indexEntries.push({
            transactionId: transaction.transactionId,
            transactionDigest: transaction.transactionDigest,
            resultSha256: transaction.resultSha256,
            offset: packLength,
            length: sourceBytes.byteLength,
          })
          packLength += sourceBytes.byteLength
        }
        if (incrementalPlan) {
          const openedPack = await openSafeRegularFile(
            join(incrementalPlan.backupRoot, BACKUP_TRANSACTION_PACK_FILE),
            incrementalPlan.packed.index.pack.byteLength,
          )
          let incrementalFailure: unknown
          try {
            for (const [ledgerIndex, transaction] of previous.state.transactions.entries()) {
              let sourceBytes: Buffer
              if (ledgerIndex < incrementalPlan.overlapLength) {
                const priorTransaction = previous.state.transactions[ledgerIndex]
                const oldTransaction = incrementalPlan.packed.index.entries[incrementalPlan.overlapStart + ledgerIndex]
                if (oldTransaction.transactionDigest !== priorTransaction.transactionDigest) throw new RepositoryFault('recovery_failed', true)
                sourceBytes = await readPackedBackupResultBytesWithHandle(
                  openedPack.handle,
                  projectRoot,
                  incrementalPlan.backupRoot,
                  incrementalPlan.packed,
                  transaction,
                )
                verifyDurableResultProofBytes(
                  sourceBytes,
                  previous.projectKey,
                  previous.state.projectId,
                  transaction,
                  bridge?.sourceScope ?? proofScope,
                  packedProofAuthority(projectRoot, incrementalPlan.backupRoot, incrementalPlan.packed, transaction),
                  packCost,
                  ledgerIndex,
                )
              } else {
                sourceBytes = await readDurableResultProofBytes(
                  projectRoot,
                  previous.projectKey,
                  previous.state.projectId,
                  transaction,
                  '.modly/transactions',
                  bridge?.sourceScope ?? proofScope,
                  { layout: 'primary-legacy' },
                  packCost,
                  ledgerIndex,
                )
              }
              await writePackEntry(transaction, sourceBytes, ledgerIndex)
            }
            await assertOpenedFileStillSettled(openedPack)
          } catch (error) {
            incrementalFailure = error instanceof WorldRepositoryIoError
              ? new RepositoryFault(error.code, error.code === 'invalid_document')
              : error
          } finally {
            try {
              await openedPack.handle.close()
            } catch (error) {
              if (!incrementalFailure) incrementalFailure = new RepositoryFault('recovery_failed', true)
            }
          }
          if (incrementalFailure) throw incrementalFailure
        } else {
          for (const [ledgerIndex, transaction] of previous.state.transactions.entries()) {
            const verifiedSourceBytes = await readDurableResultProofBytes(
              projectRoot,
              previous.projectKey,
              previous.state.projectId,
              transaction,
              '.modly/transactions',
              bridge?.sourceScope ?? proofScope,
              { layout: 'primary-legacy' },
              packCost,
              ledgerIndex,
            )
            // Awaited I/O may expose the entire backing store. A pooled read copy must not
            // alias pending publication/index bytes or semantic proof ownership.
            let sourceBytes: Buffer
            if (packCost) sourceBytes = packCost.measure('copy', 'receipt', () => {
              const owned = Buffer.allocUnsafeSlow(verifiedSourceBytes.byteLength)
              owned.set(verifiedSourceBytes)
              return owned
            }, { ledgerIndex, appliedRevision: transaction.appliedRevision, sourceBytes: verifiedSourceBytes.byteLength })
            else {
              sourceBytes = Buffer.allocUnsafeSlow(verifiedSourceBytes.byteLength)
              sourceBytes.set(verifiedSourceBytes)
            }
            await writePackEntry(transaction, sourceBytes, ledgerIndex)
          }
        }
        const syncSpan = packCost?.begin('file-sync', 'pack', { sourceBytes: packLength }) ?? null
        try {
          await packHandle.sync()
          packCost?.settle(syncSpan, 'fulfilled', { sourceBytes: packLength, durable: true })
        } catch (error) {
          packCost?.settle(syncSpan, 'rejected', { sourceBytes: packLength })
          throw error
        }
      } catch (error) {
        packError = error
      }
      try {
        await packHandle.close()
      } catch (error) {
        if (!packError) throw error
      }
	      if (packError) {
	        if (incrementalPlan && this.diagnosticBackupPackSource === 'auto') {
	          bridge?.discard()
	          bridge = undefined
	          const fallbackBridge = proofScope?.createBackupBridge?.(backupRelative)
	          try {
	            const fallbackDurable = await this.createBackupFullPrimaryPackage(
	              projectRoot,
	              previous,
	              backupRelative,
	              proofScope,
	              fallbackBridge,
	              backupCost,
	              copyCost,
	              packCost,
	              indexCost,
	              sealCost,
	            )
	            backupCostOutcome = 'fulfilled'
	            backupCost?.context.close(backupCost.rootSpan, backupCostOutcome)
	            return fallbackDurable
	          } finally {
	            fallbackBridge?.discard()
	          }
	        }
	        throw packError
	      }
      const index: BackupTransactionPackIndexV1 = {
        schema: BACKUP_TRANSACTION_PACK_SCHEMA,
        projectKey: previous.projectKey,
        projectId: previous.state.projectId,
        committedRevision: previous.state.committedRevision,
          stateSha256: indexCost?.measure('hash', 'state', () => sha256(stateBytes), { sourceBytes: stateBytes.byteLength }) ?? sha256(stateBytes),
        pack: {
          path: BACKUP_TRANSACTION_PACK_FILE,
          byteLength: packLength,
          sha256: indexCost?.measure('hash', 'pack', () => packHash.digest('hex'), { sourceBytes: packLength }) ?? packHash.digest('hex'),
        },
        entries: indexEntries,
      }
      const indexBytes = encodeJson(index, indexCost, 'index')
      if (indexBytes.byteLength > MAX_BACKUP_PACK_INDEX_BYTES) throw new RepositoryFault('write_failed', true)
      // Capture the generated identity before a write can expose its transport buffer.
      const indexSha256 = indexCost?.measure('hash', 'index', () => sha256(indexBytes), { sourceBytes: indexBytes.byteLength }) ?? sha256(indexBytes)
      durable = await atomicWrite(join(backupRoot, BACKUP_TRANSACTION_PACK_INDEX_FILE), indexBytes, this.options.syncDirectory, indexCost, 'index') && durable
      bridge?.sealDestination(indexSha256, index.pack.sha256, packLength)
      for (const path of [
        join(backupRoot, PROJECT_FILE),
        ...previous.state.scenes.map((scene) => join(backupRoot, 'scenes', basename(scene.path))),
        join(backupRoot, 'state.v1.json'),
        packPath,
        join(backupRoot, BACKUP_TRANSACTION_PACK_INDEX_FILE),
      ]) await chmod(path, 0o400).catch(() => undefined)
      durable = await syncDirectoryWith(join(backupRoot, 'scenes'), this.options.syncDirectory, sealCost) && durable
      durable = await syncDirectoryWith(backupRoot, this.options.syncDirectory, sealCost) && durable
      durable = await syncDirectoryWith(dirname(backupRoot), this.options.syncDirectory, sealCost) && durable
      backupCostOutcome = 'fulfilled'
      backupCost?.context.close(backupCost.rootSpan, backupCostOutcome)
      await this.verifyBackupPackage(projectRoot, previous.projectKey, backupRelative, undefined, bridge?.destinationScope ?? proofScope)
      return durable
    } finally {
      backupCost?.context.close(backupCost.rootSpan, backupCostOutcome)
      bridge?.discard()
    }
	  }

  private async createBackupFullPrimaryPackage(
    projectRoot: string,
    previous: LoadedReadyProject,
    backupRelative: string,
    proofScope: DurableResultProofScope | undefined,
    bridge: NewBackupSemanticBridge | undefined,
    backupCost: { context: BackupCostContext; rootSpan: number | null } | undefined,
    copyCost: BackupCostContext | undefined,
    packCost: BackupCostContext | undefined,
    indexCost: BackupCostContext | undefined,
    sealCost: BackupCostContext | undefined,
  ): Promise<boolean> {
    const backupRoot = join(projectRoot, ...backupRelative.split('/'))
    assertContained(projectRoot, backupRoot)
    await rm(backupRoot, { recursive: true, force: true })
    await ensureSafeDirectory(join(backupRoot, 'scenes'), true)
    let durable = true
    const projectBytes = await readBounded(join(projectRoot, PROJECT_FILE), MAX_DOCUMENT_BYTES, copyCost, 'project')
    durable = await writeExclusive(join(backupRoot, PROJECT_FILE), projectBytes, copyCost, 'project') && durable
    for (const scene of previous.state.scenes) {
      const bytes = await readBounded(join(projectRoot, 'scenes', basename(scene.path)), MAX_DOCUMENT_BYTES, copyCost, 'scene')
      durable = await writeExclusive(join(backupRoot, 'scenes', basename(scene.path)), bytes, copyCost, 'scene') && durable
    }
    const stateBytes = await readBounded(join(projectRoot, STATE_FILE), MAX_STATE_BYTES, copyCost, 'state')
    durable = await writeExclusive(join(backupRoot, 'state.v1.json'), stateBytes, copyCost, 'state') && durable
    const packPath = join(backupRoot, BACKUP_TRANSACTION_PACK_FILE)
    const packHash = createHash('sha256')
    const indexEntries: BackupTransactionPackIndexEntry[] = []
    let packLength = 0
    await rejectSymlinkIfPresent(packPath)
    const packHandle = await open(packPath, 'wx', 0o600)
    let packError: unknown
    try {
      for (const [ledgerIndex, transaction] of previous.state.transactions.entries()) {
        const verifiedSourceBytes = await readDurableResultProofBytes(
          projectRoot,
          previous.projectKey,
          previous.state.projectId,
          transaction,
          '.modly/transactions',
          bridge?.sourceScope ?? proofScope,
          { layout: 'primary-legacy' },
          packCost,
          ledgerIndex,
        )
        if (verifiedSourceBytes.byteLength <= 0 || verifiedSourceBytes.byteLength > MAX_DOCUMENT_BYTES) {
          throw new RepositoryFault('recovery_failed', true)
        }
        let sourceBytes: Buffer
        if (packCost) sourceBytes = packCost.measure('copy', 'receipt', () => {
          const owned = Buffer.allocUnsafeSlow(verifiedSourceBytes.byteLength)
          owned.set(verifiedSourceBytes)
          return owned
        }, { ledgerIndex, appliedRevision: transaction.appliedRevision, sourceBytes: verifiedSourceBytes.byteLength })
        else {
          sourceBytes = Buffer.allocUnsafeSlow(verifiedSourceBytes.byteLength)
          sourceBytes.set(verifiedSourceBytes)
        }
        await writeOpenedFileComplete(packHandle, sourceBytes, packLength, packCost, ledgerIndex, transaction.appliedRevision)
        if (packCost) packCost.measure('hash', 'pack', () => packHash.update(sourceBytes), {
          ledgerIndex, appliedRevision: transaction.appliedRevision, sourceBytes: sourceBytes.byteLength,
        })
        else packHash.update(sourceBytes)
        indexEntries.push({
          transactionId: transaction.transactionId,
          transactionDigest: transaction.transactionDigest,
          resultSha256: transaction.resultSha256,
          offset: packLength,
          length: sourceBytes.byteLength,
        })
        packLength += sourceBytes.byteLength
      }
      const syncSpan = packCost?.begin('file-sync', 'pack', { sourceBytes: packLength }) ?? null
      try {
        await packHandle.sync()
        packCost?.settle(syncSpan, 'fulfilled', { sourceBytes: packLength, durable: true })
      } catch (error) {
        packCost?.settle(syncSpan, 'rejected', { sourceBytes: packLength })
        throw error
      }
    } catch (error) {
      packError = error
    }
    try {
      await packHandle.close()
    } catch (error) {
      if (!packError) throw error
    }
    if (packError) throw packError
    const index: BackupTransactionPackIndexV1 = {
      schema: BACKUP_TRANSACTION_PACK_SCHEMA,
      projectKey: previous.projectKey,
      projectId: previous.state.projectId,
      committedRevision: previous.state.committedRevision,
      stateSha256: indexCost?.measure('hash', 'state', () => sha256(stateBytes), { sourceBytes: stateBytes.byteLength }) ?? sha256(stateBytes),
      pack: {
        path: BACKUP_TRANSACTION_PACK_FILE,
        byteLength: packLength,
        sha256: indexCost?.measure('hash', 'pack', () => packHash.digest('hex'), { sourceBytes: packLength }) ?? packHash.digest('hex'),
      },
      entries: indexEntries,
    }
    const indexBytes = encodeJson(index, indexCost, 'index')
    if (indexBytes.byteLength > MAX_BACKUP_PACK_INDEX_BYTES) throw new RepositoryFault('write_failed', true)
    const indexSha256 = indexCost?.measure('hash', 'index', () => sha256(indexBytes), { sourceBytes: indexBytes.byteLength }) ?? sha256(indexBytes)
    durable = await atomicWrite(join(backupRoot, BACKUP_TRANSACTION_PACK_INDEX_FILE), indexBytes, this.options.syncDirectory, indexCost, 'index') && durable
    bridge?.sealDestination(indexSha256, index.pack.sha256, packLength)
    for (const path of [
      join(backupRoot, PROJECT_FILE),
      ...previous.state.scenes.map((scene) => join(backupRoot, 'scenes', basename(scene.path))),
      join(backupRoot, 'state.v1.json'),
      packPath,
      join(backupRoot, BACKUP_TRANSACTION_PACK_INDEX_FILE),
    ]) await chmod(path, 0o400).catch(() => undefined)
    durable = await syncDirectoryWith(join(backupRoot, 'scenes'), this.options.syncDirectory, sealCost) && durable
    durable = await syncDirectoryWith(backupRoot, this.options.syncDirectory, sealCost) && durable
    durable = await syncDirectoryWith(dirname(backupRoot), this.options.syncDirectory, sealCost) && durable
    await this.verifyBackupPackage(projectRoot, previous.projectKey, backupRelative, undefined, bridge?.destinationScope ?? proofScope)
    return durable
  }

	  private async recoverJournal(context: RepositoryContext, projectKey: string): Promise<{ warnings: string[]; recovered: boolean }> {
    const projectRoot = join(context.worldsRoot, projectKey)
    const journalPath = join(projectRoot, JOURNAL_FILE)
    if (!await pathExists(journalPath)) return { warnings: [], recovered: false }
    let journal: WorldProjectJournalV1
    try { journal = parseJournal(await readJson(journalPath, MAX_STATE_BYTES), projectKey) } catch {
      throw new RepositoryFault('recovery_failed', true)
    }
    const afterRoot = join(projectRoot, ...journal.afterRoot.split('/'))
    assertContained(projectRoot, afterRoot)

    try {
      const currentStateBytes = await readBounded(join(projectRoot, STATE_FILE), MAX_STATE_BYTES)
      const currentState = parseState(JSON.parse(currentStateBytes.toString('utf8')), projectKey)
      if (sha256(currentStateBytes) === journal.afterStateSha256) {
        assertJournalMatchesStateLedger(journal, currentState)
        await verifyStablePackage(projectRoot, projectKey, currentState)
        await this.verifyReferencedBackup(projectRoot, projectKey, currentState)
        const durable = await this.cleanupRecoveredCommit(projectRoot, journal, currentState)
        return { warnings: durable ? [] : ['durability-degraded'], recovered: true }
      }
    } catch (error) {
      if (error instanceof RepositoryFault && error.code === 'unsafe_workspace') throw error
      /* state is previous or partially published */
    }

    try {
      const afterStateBytes = await readBounded(join(afterRoot, 'state.v1.json'), MAX_STATE_BYTES)
      if (sha256(afterStateBytes) !== journal.afterStateSha256) throw new Error('after state hash mismatch')
      const afterState = parseState(JSON.parse(afterStateBytes.toString('utf8')), projectKey)
      const verifiedAfter = await verifyPackage(afterRoot, projectKey, afterState)
      assertJournalMatchesStateLedger(journal, afterState)
      await verifyStateLedgerResults(projectRoot, projectKey, afterState, '.modly/transactions', undefined, undefined, verifiedAfter.snapshot)
      await this.verifyReferencedBackup(projectRoot, projectKey, afterState)
      let durable = await this.publishPackage(projectRoot, afterRoot, afterState, journal.removedScenes)
      await this.verifyReferencedBackup(projectRoot, projectKey, afterState)
      durable = await this.cleanupRecoveredCommit(projectRoot, journal, afterState) && durable
      return { warnings: durable ? [] : ['durability-degraded'], recovered: true }
    } catch (error) {
      if (error instanceof RepositoryFault && error.code === 'unsafe_workspace') throw error
      if (!journal.previousBackup) throw new RepositoryFault('recovery_failed', true)
      await this.restoreBackup(context, projectKey, journal.previousBackup)
      const restoredState = parseState(await readJson(join(projectRoot, STATE_FILE), MAX_STATE_BYTES), projectKey)
      await verifyStablePackage(projectRoot, projectKey, restoredState)
      await this.verifyReferencedBackup(projectRoot, projectKey, restoredState)
      const durable = await this.cleanupRecoveredCommit(projectRoot, journal, restoredState)
      return { warnings: durable ? [] : ['durability-degraded'], recovered: true }
    }
  }

  private async publishPackage(
    projectRoot: string,
    packageRoot: string,
    state: WorldProjectStateV1,
    removedScenes: string[],
  ): Promise<boolean> {
    let durable = true
    durable = await atomicWrite(
      join(projectRoot, PROJECT_FILE),
      await readBounded(join(packageRoot, PROJECT_FILE), MAX_DOCUMENT_BYTES),
      this.options.syncDirectory,
    ) && durable
    for (const scene of state.scenes) {
      durable = await atomicWrite(
        join(projectRoot, 'scenes', basename(scene.path)),
        await readBounded(join(packageRoot, 'scenes', basename(scene.path)), MAX_DOCUMENT_BYTES),
        this.options.syncDirectory,
      ) && durable
    }
    durable = await atomicWrite(
      join(projectRoot, STATE_FILE),
      await readBounded(join(packageRoot, 'state.v1.json'), MAX_STATE_BYTES),
      this.options.syncDirectory,
    ) && durable
    for (const path of removedScenes) await rm(join(projectRoot, 'scenes', basename(path)), { force: true })
    durable = await removeUnreferencedSceneFiles(projectRoot, state, this.options.syncDirectory) && durable
    await verifyStablePackage(projectRoot, state.projectKey, state)
    return durable
  }

  private async restoreBackup(context: RepositoryContext, projectKey: string, backupRelative: string): Promise<void> {
    const projectRoot = join(context.worldsRoot, projectKey)
    const backupRoot = join(projectRoot, ...backupRelative.split('/'))
    const state = await this.verifyBackupPackage(projectRoot, projectKey, backupRelative)
    await this.restoreBackupTransactions(projectRoot, backupRoot, state)
    await this.publishPackage(projectRoot, backupRoot, state, [])
  }

  private async restoreBackupTransactions(
    projectRoot: string,
    backupRoot: string,
    state: WorldProjectStateV1,
  ): Promise<void> {
    await ensureSafeDirectory(join(projectRoot, '.modly', 'transactions'), false)
    const layout = await classifyBackupTransactionLayout(backupRoot)
    const packed = layout === 'packed'
      ? await readPackedBackupIndex(backupRoot, state, sha256(await readBounded(join(backupRoot, 'state.v1.json'), MAX_STATE_BYTES)))
      : null
    for (const transaction of state.transactions) {
      const sourceBytes = packed
        ? await readPackedBackupResultBytes(backupRoot, packed, transaction)
        : (await readVerifiedDurableResult(
            backupRoot,
            state.projectKey,
            state.projectId,
            transaction,
            'transactions',
            { layout: 'backup-legacy', backupRelativePath: backupRootRelativePath(projectRoot, backupRoot) },
          )).bytes
      verifyDurableResultProofBytes(
        sourceBytes,
        state.projectKey,
        state.projectId,
        transaction,
        undefined,
        packed ? packedProofAuthority(projectRoot, backupRoot, packed, transaction) : { layout: 'backup-legacy', backupRelativePath: backupRootRelativePath(projectRoot, backupRoot) },
      )
      const transactionRoot = join(projectRoot, '.modly', 'transactions', transaction.transactionDigest)
      await ensureSafeDirectory(join(transactionRoot, 'after'), true)
      await atomicWrite(
        join(transactionRoot, 'after', 'result.v1.json'),
        sourceBytes,
        this.options.syncDirectory,
      )
    }
    await syncDirectoryWith(join(projectRoot, '.modly', 'transactions'), this.options.syncDirectory)
  }

  private async cleanupRecoveredCommit(
    projectRoot: string,
    journal: WorldProjectJournalV1,
    state: WorldProjectStateV1,
  ): Promise<boolean> {
    let durable = await removeUnreferencedSceneFiles(projectRoot, state, this.options.syncDirectory)
    await rm(join(projectRoot, JOURNAL_FILE), { force: true })
    durable = await syncDirectoryWith(join(projectRoot, '.modly'), this.options.syncDirectory) && durable
    if (!journal.keepAfter) {
      const afterRoot = join(projectRoot, ...journal.afterRoot.split('/'))
      await rm(dirname(afterRoot), { recursive: true, force: true })
    }
    await this.pruneCommittedData(projectRoot, state)
    return durable
  }

  private async cleanupOrphans(projectRoot: string, state: WorldProjectStateV1, proofScope?: DurableResultProofScope, skipEmptyCleanup = false): Promise<void> {
    if (await pathExists(join(projectRoot, JOURNAL_FILE))) return
    // Only an ordinary apply load may omit verification guarding a nonexistent deletion.
    // This read-only inspection grants no deletion authority: leftovers use the original
    // fresh verifier and namespace scan below. Terminal and recovery pruning never skip.
    if (skipEmptyCleanup && !await this.hasOrphanCleanupWork(projectRoot, state)) return
    await this.pruneCommittedData(projectRoot, state, proofScope)
  }

  private async hasOrphanCleanupWork(projectRoot: string, state: WorldProjectStateV1): Promise<boolean> {
    const transactionEntries = await readdir(join(projectRoot, '.modly', 'transactions'), { withFileTypes: true })
    if (transactionEntries.some((entry) => entry.isSymbolicLink())) throw new RepositoryFault('unsafe_workspace')
    const retainedTransactions = new Set(state.transactions.map((entry) => entry.transactionDigest))
    const backupDirectoryEntries = await readdir(join(projectRoot, '.modly', 'backups'), { withFileTypes: true })
    if (backupDirectoryEntries.some((entry) => entry.isSymbolicLink())) throw new RepositoryFault('unsafe_workspace')
    if (backupDirectoryEntries.some((entry) => !entry.isDirectory() || !BACKUP_NAME_PATTERN.test(entry.name))) {
      throw new RepositoryFault('recovery_failed', true)
    }
    const backupEntries = backupDirectoryEntries
      .map((entry) => ({ name: entry.name, revision: backupRevision(entry.name) }))
      .sort((left, right) => left.revision - right.revision || codeUnitCompare(left.name, right.name))
    const retainedBackupName = state.lastValidBackup ? basename(state.lastValidBackup) : null
    if (retainedBackupName && !backupEntries.some((entry) => entry.name === retainedBackupName)) {
      throw new RepositoryFault('recovery_failed', true)
    }
    const keep = new Set(backupEntries.slice(-WORLD_PROJECT_BACKUP_LIMIT).map((entry) => entry.name))
    if (retainedBackupName) keep.add(retainedBackupName)
    return transactionEntries.some((entry) => entry.isDirectory() && !retainedTransactions.has(entry.name))
      || backupEntries.some((entry) => !keep.has(entry.name))
  }

  private async pruneCommittedData(projectRoot: string, state: WorldProjectStateV1, proofScope?: DurableResultProofScope): Promise<void> {
    await verifyStateLedgerResults(projectRoot, state.projectKey, state, '.modly/transactions', proofScope)
    await this.verifyReferencedBackup(projectRoot, state.projectKey, state, proofScope)
    const transactionsRoot = join(projectRoot, '.modly', 'transactions')
    const retainedTransactions = new Set(state.transactions.map((entry) => entry.transactionDigest))
    for (const entry of await readdir(transactionsRoot, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new RepositoryFault('unsafe_workspace')
      if (entry.isDirectory() && !retainedTransactions.has(entry.name)) {
        await rm(join(transactionsRoot, entry.name), { recursive: true, force: true })
      }
    }
    const backupsRoot = join(projectRoot, '.modly', 'backups')
    const backupDirectoryEntries = await readdir(backupsRoot, { withFileTypes: true })
    if (backupDirectoryEntries.some((entry) => entry.isSymbolicLink())) {
      throw new RepositoryFault('unsafe_workspace')
    }
    if (backupDirectoryEntries.some((entry) => !entry.isDirectory() || !BACKUP_NAME_PATTERN.test(entry.name))) {
      throw new RepositoryFault('recovery_failed', true)
    }
    const backupEntries = backupDirectoryEntries
      .map((entry) => ({ name: entry.name, revision: backupRevision(entry.name) }))
      .sort((left, right) => left.revision - right.revision || codeUnitCompare(left.name, right.name))
    const retainedBackupName = state.lastValidBackup ? basename(state.lastValidBackup) : null
    if (retainedBackupName && !backupEntries.some((entry) => entry.name === retainedBackupName)) {
      throw new RepositoryFault('recovery_failed', true)
    }
    const keep = new Set(backupEntries.slice(-WORLD_PROJECT_BACKUP_LIMIT).map((entry) => entry.name))
    if (retainedBackupName) keep.add(retainedBackupName)
    for (const entry of backupEntries) {
      if (!keep.has(entry.name)) await rm(join(backupsRoot, entry.name), { recursive: true, force: true })
    }
  }

  private async verifyReferencedBackup(
    projectRoot: string,
    projectKey: string,
    state: WorldProjectStateV1,
    proofScope?: DurableResultProofScope,
  ): Promise<void> {
    if (!state.lastValidBackup) return
    await this.verifyBackupPackage(projectRoot, projectKey, state.lastValidBackup, state, proofScope)
  }

  private async verifyBackupPackage(
    projectRoot: string,
    projectKey: string,
    backupRelative: string,
    successorState?: WorldProjectStateV1,
    proofScope?: DurableResultProofScope,
  ): Promise<WorldProjectStateV1> {
    try {
      if (!BACKUP_PATTERN.test(backupRelative)) throw new RepositoryFault('recovery_failed', true)
      const backupRoot = join(projectRoot, ...backupRelative.split('/'))
      assertContained(projectRoot, backupRoot)
      await ensureSafeDirectory(backupRoot, false)
      await ensureSafeDirectory(join(backupRoot, 'scenes'), false)
      const backupStateBytes = await readBounded(join(backupRoot, 'state.v1.json'), MAX_STATE_BYTES)
      const backupState = parseState(parseJsonBuffer(backupStateBytes), projectKey)
      if (backupRevision(basename(backupRelative)) !== backupState.committedRevision
        || (successorState && (backupState.projectId !== successorState.projectId
          || backupState.committedRevision >= successorState.committedRevision))) {
        throw new RepositoryFault('recovery_failed', true)
      }
      const layout = await classifyBackupTransactionLayout(backupRoot)
      if (layout === 'legacy') await verifyStablePackage(backupRoot, projectKey, backupState, 'transactions', proofScope)
      else await verifyPackedBackupPackage(projectRoot, backupRoot, projectKey, backupState, sha256(backupStateBytes), proofScope)
      return backupState
    } catch (error) {
      if (error instanceof RepositoryFault && error.code === 'unsafe_workspace') throw error
      throw new RepositoryFault('recovery_failed', true)
    } finally {
      proofScope?.discardBackupBridge?.()
    }
  }

  private async checkpoint(stage: string): Promise<void> {
    await this.options.failureCheckpoint?.(stage)
  }
}

function parseCreateRequest(value: unknown): WorldProjectCreateRequest {
  const record = exactRecord(value, ['name', 'initialSceneName', 'projectId', 'initialSceneId'])
  const name = canonicalName(record.name)
  const initialSceneName = canonicalName(record.initialSceneName)
  if (!name || !initialSceneName) throw new RepositoryFault('invalid_request')
  const projectId = optionalCanonicalId(record.projectId)
  const initialSceneId = optionalCanonicalId(record.initialSceneId)
  if ((record.projectId !== undefined && !projectId) || (record.initialSceneId !== undefined && !initialSceneId)) {
    throw new RepositoryFault('invalid_request')
  }
  return {
    name,
    initialSceneName,
    ...(projectId ? { projectId } : {}),
    ...(initialSceneId ? { initialSceneId } : {}),
  }
}

function parseProjectKeyRequest(value: unknown): WorldProjectKeyRequest {
  const record = exactRecord(value, ['projectKey'])
  if (!isWorldProjectKey(record.projectKey)) throw new RepositoryFault('invalid_request')
  return { projectKey: record.projectKey }
}

function parseCommandRequest(value: unknown): WorldProjectCommandRequest {
  const record = exactRecord(value, ['projectKey', 'batch', 'aiAuthority'])
  const key = parseProjectKeyRequest({ projectKey: record.projectKey })
  const parsed = parseWorldCommandBatch(record.batch)
  if (!parsed.success) throw new RepositoryFault('invalid_request', false, parsed.issues)
  let aiAuthority: WorldProjectCommandRequest['aiAuthority']
  if (Object.hasOwn(record, 'aiAuthority')) {
    const authority = exactRecord(record.aiAuthority, ['token', 'context'])
    if (typeof authority.token !== 'string' || !/^apply_[a-f0-9]{48}$/.test(authority.token)) throw new RepositoryFault('invalid_request')
    aiAuthority = { token: authority.token, context: parseWorldAiContext(authority.context) }
  }
  return { ...key, batch: parsed.value, ...(aiAuthority ? { aiAuthority } : {}) }
}

function isBackupPackSourceMode(value: unknown): value is BackupPackSourceMode {
  return value === 'auto' || value === 'force-full-primary' || value === 'force-previous-packed-overlap'
}

function parseDeleteRequest(value: unknown): WorldProjectDeleteRequest {
  const record = exactRecord(value, ['projectKey', 'expectedRevision', 'transactionId'])
  const key = parseProjectKeyRequest({ projectKey: record.projectKey })
  if (typeof record.expectedRevision !== 'number' || !Number.isSafeInteger(record.expectedRevision) || record.expectedRevision < 0) {
    throw new RepositoryFault('invalid_request')
  }
  if (!isWorldCanonicalId(record.transactionId)) throw new RepositoryFault('invalid_request')
  return { ...key, expectedRevision: record.expectedRevision, transactionId: record.transactionId }
}

function createInitialSnapshot(
  projectKey: string,
  sceneKey: string,
  request: WorldProjectCreateRequest,
): WorldProjectSnapshotV1 {
  const suffix = projectKey.slice('world-'.length)
  const sceneSuffix = sceneKey.slice('scene-'.length)
  const projectId = request.projectId ?? `project:${suffix}`
  const sceneId = request.initialSceneId ?? `scene:${sceneSuffix}`
  const scenePath = `Worlds/${projectKey}/scenes/${sceneKey}.world-scene.json`
  const scene: WorldSceneDocumentV1 = {
    schema: WORLD_SCENE_SCHEMA,
    projectId,
    sceneId,
    name: request.initialSceneName,
    environment: { backgroundColor: '#17191d', ambientIntensity: 0.3 },
    editor: { initialView: { position: [8, 5, 12], target: [0, 1, 0], up: [0, 1, 0] } },
    entities: [],
    sequences: [],
  }
  return {
    project: {
      schema: WORLD_PROJECT_SCHEMA,
      projectId,
      name: request.name,
      revision: 0,
      resources: [],
      scenes: [{ id: sceneId, name: request.initialSceneName, documentPath: scenePath }],
      startSceneId: sceneId,
      inputActions: [],
      graphicsProfiles: [{
        id: 'graphics:balanced',
        name: 'Balanced',
        renderScale: 1,
        shadowQuality: 'medium',
        antialiasing: 'fxaa',
      }],
      activeGraphicsProfileId: 'graphics:balanced',
    },
    scenes: [scene],
  }
}

function assertSnapshotConfinement(projectKey: string, snapshot: WorldProjectSnapshotV1): void {
  const expectedPrefix = `Worlds/${projectKey}/scenes/`
  const paths = new Set<string>()
  for (const reference of snapshot.project.scenes) {
    if (!reference.documentPath.startsWith(expectedPrefix)) throw new RepositoryFault('invalid_document')
    const filename = reference.documentPath.slice(expectedPrefix.length)
    if (!SCENE_FILE_PATTERN.test(filename) || filename.includes('/')) throw new RepositoryFault('invalid_document')
    if (reference.documentPath !== `${expectedPrefix}${filename}` || paths.has(reference.documentPath)) {
      throw new RepositoryFault('invalid_document')
    }
    paths.add(reference.documentPath)
  }
  if (paths.size !== snapshot.scenes.length) throw new RepositoryFault('invalid_document')
}

async function verifyPackage(
  packageRoot: string,
  projectKey: string,
  state: WorldProjectStateV1,
  backupCost?: BackupCostContext,
): Promise<{ snapshot: WorldProjectSnapshotV1; stateBytes: Buffer }> {
  if (state.projectKey !== projectKey) throw new RepositoryFault('invalid_document')
  const projectBytes = await readBounded(join(packageRoot, PROJECT_FILE), MAX_DOCUMENT_BYTES, backupCost, 'project')
  if ((backupCost?.measure('hash', 'project', () => sha256(projectBytes), { sourceBytes: projectBytes.byteLength }) ?? sha256(projectBytes)) !== state.project.sha256) throw new RepositoryFault('invalid_document')
  const projectValue: unknown = parseJsonBuffer(projectBytes, backupCost, 'project')
  const scenes: unknown[] = []
  for (const scene of state.scenes) {
    const bytes = await readBounded(join(packageRoot, 'scenes', basename(scene.path)), MAX_DOCUMENT_BYTES, backupCost, 'scene')
    if ((backupCost?.measure('hash', 'scene', () => sha256(bytes), { sourceBytes: bytes.byteLength }) ?? sha256(bytes)) !== scene.sha256) throw new RepositoryFault('invalid_document')
    scenes.push(parseJsonBuffer(bytes, backupCost, 'scene'))
  }
  const validated = backupCost?.measure('validate', 'project', () => validateWorldProjectSnapshot({ project: projectValue, scenes }))
    ?? validateWorldProjectSnapshot({ project: projectValue, scenes })
  if (!validated.success) throw new RepositoryFault('invalid_document', false, validated.issues)
  const scenesById = new Map(validated.value.scenes.map((scene) => [scene.sceneId, scene]))
  const validateOrdered = () => validateWorldProjectSnapshot({
    project: validated.value.project,
    scenes: validated.value.project.scenes.map((reference) => scenesById.get(reference.id)),
  })
  const ordered = backupCost?.measure('validate', 'project', validateOrdered) ?? validateOrdered()
  if (!ordered.success) throw new RepositoryFault('invalid_document', false, ordered.issues)
  assertSnapshotConfinement(projectKey, ordered.value)
  if (
    ordered.value.project.projectId !== state.projectId
    || ordered.value.project.revision !== state.committedRevision
  ) throw new RepositoryFault('invalid_document')
  const documentPaths = new Map(ordered.value.project.scenes.map((scene) => [scene.id, scene.documentPath]))
  if (state.scenes.some((scene) => documentPaths.get(scene.sceneId) !== scene.path)) throw new RepositoryFault('invalid_document')
  const stableStatePath = join(packageRoot, STATE_FILE)
  const packageStatePath = join(packageRoot, 'state.v1.json')
  const stateBytes = await readBounded(await pathExists(stableStatePath) ? stableStatePath : packageStatePath, MAX_STATE_BYTES, backupCost, 'state')
  return { snapshot: ordered.value, stateBytes }
}

async function verifyStablePackage(
  packageRoot: string,
  projectKey: string,
  state: WorldProjectStateV1,
  transactionRootRelative = '.modly/transactions',
  proofScope?: DurableResultProofScope,
  backupCost?: BackupCostContext,
): Promise<{ snapshot: WorldProjectSnapshotV1; stateBytes: Buffer }> {
  const verified = await verifyPackage(packageRoot, projectKey, state, backupCost)
  await verifyStateLedgerResults(packageRoot, projectKey, state, transactionRootRelative, proofScope, backupCost, verified.snapshot)
  return verified
}

async function verifyStateLedgerResults(
  packageRoot: string,
  projectKey: string,
  state: WorldProjectStateV1,
  transactionRootRelative = '.modly/transactions',
  proofScope?: DurableResultProofScope,
  backupCost?: BackupCostContext,
  expectedSnapshot?: WorldProjectSnapshotV1,
): Promise<void> {
  try {
    const proofs: DurableResultChainProof[] = []
    await processOrderedSettledCohorts(state.transactions, LEDGER_PROOF_READ_COHORT_SIZE, (transaction, ledgerIndex) => (
      readDurableResultProofFreshBytes(packageRoot, transaction, transactionRootRelative, backupCost, ledgerIndex)
    ), (bytes, transaction, ledgerIndex) => {
      proofs.push(verifyDurableResultProofBytes(bytes, projectKey, state.projectId, transaction, proofScope, undefined, backupCost, ledgerIndex))
    })
    assertDurableResultChain(proofs, expectedSnapshot, backupCost)
  } catch (error) {
    if (error instanceof RepositoryFault && error.code === 'unsafe_workspace') throw error
    throw new RepositoryFault('recovery_failed', true)
  }
}

function assertDurableResultChain(
  proofs: readonly DurableResultChainProof[],
  expectedSnapshot?: WorldProjectSnapshotV1,
  backupCost?: BackupCostContext,
): void {
  for (let index = 1; index < proofs.length; index += 1) {
    if (proofs[index - 1].snapshotCanonical !== proofs[index].inverseSnapshotCanonical) {
      throw new RepositoryFault('recovery_failed', true)
    }
  }
  if (!proofs.length || !expectedSnapshot) return
  const expectedCanonical = backupCost?.measure('canonical-encode', 'project', () => stableSerialize(expectedSnapshot))
    ?? stableSerialize(expectedSnapshot)
  if (proofs.at(-1)!.snapshotCanonical !== expectedCanonical) throw new RepositoryFault('recovery_failed', true)
}

function parseState(value: unknown, projectKey: string): WorldProjectStateV1 {
  const record = exactRecord(value, [
    'schema', 'projectKey', 'projectId', 'committedRevision', 'project', 'scenes',
    'transactions', 'lastValidBackup',
  ], 'invalid_document')
  if (record.schema !== STATE_SCHEMA || record.projectKey !== projectKey || !isWorldCanonicalId(record.projectId)) {
    throw new RepositoryFault('invalid_document')
  }
  const projectId = record.projectId
  if (typeof record.committedRevision !== 'number' || !Number.isSafeInteger(record.committedRevision) || record.committedRevision < 0) {
    throw new RepositoryFault('invalid_document')
  }
  const committedRevision = record.committedRevision
  const project = parseStateFileRef(record.project, ['path', 'sha256'])
  if (project.path !== `Worlds/${projectKey}/${PROJECT_FILE}`) throw new RepositoryFault('invalid_document')
  if (!Array.isArray(record.scenes) || record.scenes.length > 1_024) throw new RepositoryFault('invalid_document')
  const scenes = record.scenes.map((value) => {
    const sceneRecord = exactRecord(value, ['sceneId', 'path', 'sha256'], 'invalid_document')
    if (!isWorldCanonicalId(sceneRecord.sceneId)) throw new RepositoryFault('invalid_document')
    const ref = parseStateFileRef(sceneRecord, ['sceneId', 'path', 'sha256'])
    const expectedPrefix = `Worlds/${projectKey}/scenes/`
    if (!ref.path.startsWith(expectedPrefix) || !SCENE_FILE_PATTERN.test(ref.path.slice(expectedPrefix.length))) {
      throw new RepositoryFault('invalid_document')
    }
    return { sceneId: sceneRecord.sceneId, ...ref }
  })
  if (new Set(scenes.map((scene) => scene.sceneId)).size !== scenes.length
    || new Set(scenes.map((scene) => scene.path)).size !== scenes.length) throw new RepositoryFault('invalid_document')
  if (!Array.isArray(record.transactions) || record.transactions.length > WORLD_PROJECT_TRANSACTION_LEDGER_LIMIT) {
    throw new RepositoryFault('invalid_document')
  }
  const transactions = record.transactions.map((value) => parseDurableTransaction(value, projectId))
  if (new Set(transactions.map((entry) => entry.transactionId)).size !== transactions.length) {
    throw new RepositoryFault('invalid_document')
  }
  if (new Set(transactions.map((entry) => entry.transactionDigest)).size !== transactions.length) {
    throw new RepositoryFault('invalid_document')
  }
  if (transactions.some((entry, index) => entry.appliedRevision > committedRevision
    || (index > 0 && transactions[index - 1].appliedRevision >= entry.appliedRevision))) {
    throw new RepositoryFault('invalid_document')
  }
  if ((committedRevision === 0 && transactions.length > 0)
    || (committedRevision > 0 && transactions.at(-1)?.appliedRevision !== committedRevision)) {
    throw new RepositoryFault('invalid_document')
  }
  const lastValidBackup = record.lastValidBackup === null
    ? null
    : typeof record.lastValidBackup === 'string' && BACKUP_PATTERN.test(record.lastValidBackup)
      ? record.lastValidBackup
      : null
  if (record.lastValidBackup !== null && !lastValidBackup) throw new RepositoryFault('invalid_document')
  return {
    schema: STATE_SCHEMA,
    projectKey,
    projectId: record.projectId,
    committedRevision,
    project,
    scenes: scenes.sort((left, right) => codeUnitCompare(left.path, right.path)),
    transactions,
    lastValidBackup,
  }
}

function parseStateFileRef(value: unknown, allowedKeys: readonly string[]): StateFileRef {
  const record = exactRecord(value, allowedKeys, 'invalid_document')
  if (typeof record.path !== 'string' || !SHA256_PATTERN.test(String(record.sha256))) {
    throw new RepositoryFault('invalid_document')
  }
  return { path: record.path, sha256: String(record.sha256) }
}

function parseDurableTransaction(value: unknown, expectedProjectId: string): DurableTransaction {
  const record = exactRecord(value, [
    'transactionId', 'transactionDigest', 'payloadSha256', 'canonicalPayload',
    'appliedRevision', 'resultSha256',
  ], 'invalid_document')
  if (
    !isWorldCanonicalId(record.transactionId)
    || typeof record.transactionDigest !== 'string' || !DIGEST_PATTERN.test(record.transactionDigest)
    || typeof record.payloadSha256 !== 'string' || !SHA256_PATTERN.test(record.payloadSha256)
    || typeof record.resultSha256 !== 'string' || !SHA256_PATTERN.test(record.resultSha256)
    || typeof record.canonicalPayload !== 'string'
    || Buffer.byteLength(record.canonicalPayload, 'utf8') > MAX_CANONICAL_BATCH_BYTES
    || sha256(record.canonicalPayload) !== record.payloadSha256
    || sha256(`${record.transactionId}\n${record.canonicalPayload}`) !== record.transactionDigest
    || typeof record.appliedRevision !== 'number' || !Number.isSafeInteger(record.appliedRevision) || record.appliedRevision < 1
  ) throw new RepositoryFault('invalid_document')
  const batch = parseCanonicalDurableBatch(record.canonicalPayload)
  if (batch.transactionId !== record.transactionId || batch.baseRevision + 1 !== record.appliedRevision
    || batch.projectId !== expectedProjectId) {
    throw new RepositoryFault('invalid_document')
  }
  return {
    transactionId: record.transactionId,
    transactionDigest: record.transactionDigest,
    payloadSha256: record.payloadSha256,
    canonicalPayload: record.canonicalPayload,
    appliedRevision: record.appliedRevision,
    resultSha256: record.resultSha256,
  }
}

function parseCanonicalDurableBatch(canonicalPayload: string): WorldCommandBatchV1 {
  let value: unknown
  try { value = JSON.parse(canonicalPayload) } catch { throw new RepositoryFault('invalid_document') }
  const parsed = parseWorldCommandBatch(value)
  if (!parsed.success || canonicalWorldCommandBatchPayload(parsed.value) !== canonicalPayload) {
    throw new RepositoryFault('invalid_document')
  }
  return parsed.value
}

function parseJournal(value: unknown, projectKey: string): WorldProjectJournalV1 {
  const record = exactRecord(value, [
    'schema', 'projectKey', 'transactionDigest', 'afterRoot', 'afterStateSha256',
    'previousBackup', 'removedScenes', 'keepAfter',
  ], 'recovery_failed', true)
  if (
    record.schema !== JOURNAL_SCHEMA || record.projectKey !== projectKey
    || typeof record.transactionDigest !== 'string' || !DIGEST_PATTERN.test(record.transactionDigest)
    || typeof record.afterRoot !== 'string' || !AFTER_ROOT_PATTERN.test(record.afterRoot)
    || record.afterRoot !== `.modly/transactions/${record.transactionDigest}/after`
    || typeof record.afterStateSha256 !== 'string' || !SHA256_PATTERN.test(record.afterStateSha256)
    || (record.previousBackup !== null && (typeof record.previousBackup !== 'string' || !BACKUP_PATTERN.test(record.previousBackup)))
    || !Array.isArray(record.removedScenes)
    || typeof record.keepAfter !== 'boolean'
  ) throw new RepositoryFault('recovery_failed', true)
  const removedScenes = record.removedScenes.map((path) => {
    if (typeof path !== 'string') throw new RepositoryFault('recovery_failed', true)
    const expectedPrefix = `Worlds/${projectKey}/scenes/`
    if (!path.startsWith(expectedPrefix) || !SCENE_FILE_PATTERN.test(path.slice(expectedPrefix.length))) {
      throw new RepositoryFault('recovery_failed', true)
    }
    return path
  })
  return {
    schema: JOURNAL_SCHEMA,
    projectKey,
    transactionDigest: record.transactionDigest,
    afterRoot: record.afterRoot,
    afterStateSha256: record.afterStateSha256,
    previousBackup: record.previousBackup as string | null,
    removedScenes: sortedUnique(removedScenes),
    keepAfter: record.keepAfter,
  }
}

function assertJournalMatchesStateLedger(
  journal: WorldProjectJournalV1,
  state: WorldProjectStateV1,
): void {
  if (!journal.keepAfter) {
    if (state.transactions.some((transaction) => transaction.transactionDigest === journal.transactionDigest)) {
      throw new RepositoryFault('recovery_failed', true)
    }
    return
  }
  const latest = state.transactions.at(-1)
  if (!latest
    || latest.transactionDigest !== journal.transactionDigest
    || latest.appliedRevision !== state.committedRevision) {
    throw new RepositoryFault('recovery_failed', true)
  }
}

async function readStoredPublicResult(
  projectRoot: string,
  projectKey: string,
  projectId: string,
  transaction: DurableTransaction,
  idempotent: boolean,
): Promise<WorldProjectCommandSuccess> {
  const verified = (await readVerifiedDurableResult(
    projectRoot,
    projectKey,
    projectId,
    transaction,
  )).value
  return materializeStoredPublicResult(verified, idempotent)
}

function materializeStoredPublicResult(
  verified: WorldProjectCommandSuccess,
  idempotent: boolean,
): WorldProjectCommandSuccess {
  return {
    ...verified,
    idempotent,
    warnings: idempotent
      ? sortedUnique([...verified.warnings, 'transaction-idempotent'])
      : verified.warnings,
  }
}

async function detectUnsupportedProject(projectRoot: string): Promise<string | null> {
  const statePath = join(projectRoot, STATE_FILE)
  if (await pathExists(statePath)) {
    try {
      const value = await readJson(statePath, MAX_STATE_BYTES)
      if (isPlainRecord(value) && typeof value.schema === 'string' && FUTURE_STATE_SCHEMA_PATTERN.test(value.schema)) {
        return value.schema
      }
    } catch { /* corruption is handled by the normal loader */ }
    return null
  }
  try {
    const value = await readJson(join(projectRoot, PROJECT_FILE), MAX_DOCUMENT_BYTES)
    if (isPlainRecord(value) && typeof value.schema === 'string' && FUTURE_PROJECT_SCHEMA_PATTERN.test(value.schema)) {
      return value.schema
    }
  } catch { /* corruption is handled by the normal loader */ }
  return null
}

function deterministicStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new RepositoryFault('recovery_failed', true)
  }
  const normalized = sortedUnique(value)
  if (normalized.length !== value.length || normalized.some((entry, index) => entry !== value[index])) {
    throw new RepositoryFault('recovery_failed', true)
  }
  return normalized
}

function mapCommandFailure(result: Extract<ApplyWorldCommandBatchResult, { success: false }>): RepositoryFault {
  if (result.issues.some((issue) => issue.code === 'revision-conflict')) {
    return new RepositoryFault('revision_conflict', true)
  }
  if (result.issues.some((issue) => issue.code === 'project-conflict')) {
    return new RepositoryFault('invalid_request', false, result.issues)
  }
  return new RepositoryFault('invalid_request', false, result.issues)
}

function publicReceipt(transaction: DurableTransaction): WorldProjectTransactionReceipt {
  return {
    transactionId: transaction.transactionId,
    payloadSha256: transaction.payloadSha256,
    resultSha256: transaction.resultSha256,
    appliedRevision: transaction.appliedRevision,
  }
}

function cloneDurableTransaction(value: DurableTransaction): DurableTransaction {
  return { ...value }
}

function cloneWorldInverse(inverse: WorldCommandInverse): WorldCommandInverse {
  return { kind: 'world-snapshot', snapshot: cloneWorldProjectSnapshot(inverse.snapshot) }
}

function exactRecord(
  value: unknown,
  allowedKeys: readonly string[],
  code: WorldProjectPublicErrorCode = 'invalid_request',
  retryable = false,
): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new RepositoryFault(code, retryable)
  const allowed = new Set(allowedKeys)
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw new RepositoryFault(code, retryable)
  }
  return value
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function canonicalName(value: unknown): string | null {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 512 || value.includes('\0')) return null
  return value
}

function optionalCanonicalId(value: unknown): string | undefined {
  return value === undefined ? undefined : isWorldCanonicalId(value) ? value : undefined
}

function failureResult(error: unknown): { ok: false; error: WorldProjectPublicError } {
  const fault = error instanceof RepositoryFault ? error : new RepositoryFault('internal_error', true)
  const messages: Record<WorldProjectPublicErrorCode, string> = {
    invalid_request: 'World project request is invalid.',
    project_not_found: 'World project was not found.',
    revision_conflict: 'World project revision changed.',
    transaction_reuse: 'World project transaction id was already used.',
    unsafe_workspace: 'World project workspace is unsafe.',
    invalid_document: 'World project document is invalid.',
    unsupported_schema: 'World project schema is unsupported.',
    project_busy: 'World project repository is busy.',
    recovery_failed: 'World project recovery failed.',
    write_failed: 'World project write failed.',
    unauthorized: 'World project request is unauthorized.',
    internal_error: 'World project operation failed.',
  }
  return {
    ok: false,
    error: {
      code: fault.code,
      message: messages[fault.code],
      retryable: fault.retryable,
      ...(fault.issues?.length ? { issues: fault.issues.map((issue) => ({ ...issue })) } : {}),
    },
  }
}

async function enqueueRepository<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = repositoryQueues.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolvePromise) => { release = resolvePromise })
  const queued = previous.catch(() => undefined).then(() => gate)
  repositoryQueues.set(key, queued)
  await previous.catch(() => undefined)
  try { return await operation() } finally {
    release()
    if (repositoryQueues.get(key) === queued) repositoryQueues.delete(key)
  }
}

async function ensureSafeDirectory(path: string, create: boolean): Promise<void> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new RepositoryFault('unsafe_workspace')
  } catch (error) {
    if (error instanceof RepositoryFault) throw error
    if (nodeErrorCode(error) !== 'ENOENT') throw new RepositoryFault('unsafe_workspace')
    if (!create) throw new RepositoryFault('invalid_document')
    await mkdir(path, { recursive: true, mode: 0o700 })
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new RepositoryFault('unsafe_workspace')
  }
}

async function rejectSymlinkIfPresent(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new RepositoryFault('unsafe_workspace')
  } catch (error) {
    if (error instanceof RepositoryFault) throw error
    if (nodeErrorCode(error) !== 'ENOENT') throw new RepositoryFault('unsafe_workspace')
  }
}

function assertContained(root: string, candidate: string): void {
  const relativePath = relative(resolve(root), resolve(candidate))
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new RepositoryFault('unsafe_workspace')
  }
}

async function atomicWrite(
  target: string,
  bytes: Buffer,
  directorySync?: (directory: string) => boolean | Promise<boolean>,
  backupCost?: BackupCostContext,
  backupTarget: BackupCostTarget = 'receipt',
  beforePublish?: () => void,
): Promise<boolean> {
  await ensureSafeDirectory(dirname(target), false)
  await rejectSymlinkIfPresent(target)
  const temporary = join(dirname(target), `.${basename(target)}.tmp-${randomBytes(12).toString('hex')}`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    const writeSpan = backupCost?.begin('write-file', backupTarget, { requestedBytes: bytes.byteLength, sourceBytes: bytes.byteLength }) ?? null
    try {
      await handle.writeFile(bytes)
      backupCost?.settle(writeSpan, 'fulfilled', { completedBytes: bytes.byteLength, sourceBytes: bytes.byteLength })
    } catch (error) {
      backupCost?.settle(writeSpan, 'rejected', { sourceBytes: bytes.byteLength })
      throw error
    }
    const syncSpan = backupCost?.begin('file-sync', backupTarget, { sourceBytes: bytes.byteLength }) ?? null
    try {
      await handle.sync()
      backupCost?.settle(syncSpan, 'fulfilled', { sourceBytes: bytes.byteLength, durable: true })
    } catch (error) {
      backupCost?.settle(syncSpan, 'rejected', { sourceBytes: bytes.byteLength })
      throw error
    }
  } finally {
    await handle.close()
  }
  try {
    // No await between the final custody check and initiating the irreversible rename.
    beforePublish?.()
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  return syncDirectoryWith(dirname(target), directorySync, backupCost)
}

async function writeExclusive(path: string, bytes: Buffer, backupCost?: BackupCostContext,
  backupTarget: BackupCostTarget = 'receipt'): Promise<boolean> {
  await ensureSafeDirectory(dirname(path), false)
  await rejectSymlinkIfPresent(path)
  const handle = await open(path, 'wx', 0o600)
  try {
    const writeSpan = backupCost?.begin('write-file', backupTarget, { requestedBytes: bytes.byteLength, sourceBytes: bytes.byteLength }) ?? null
    try {
      await handle.writeFile(bytes)
      backupCost?.settle(writeSpan, 'fulfilled', { completedBytes: bytes.byteLength, sourceBytes: bytes.byteLength })
    } catch (error) {
      backupCost?.settle(writeSpan, 'rejected', { sourceBytes: bytes.byteLength })
      throw error
    }
    const syncSpan = backupCost?.begin('file-sync', backupTarget, { sourceBytes: bytes.byteLength }) ?? null
    try {
      await handle.sync()
      backupCost?.settle(syncSpan, 'fulfilled', { sourceBytes: bytes.byteLength, durable: true })
    } catch (error) {
      backupCost?.settle(syncSpan, 'rejected', { sourceBytes: bytes.byteLength })
      throw error
    }
  } finally {
    await handle.close()
  }
  return true
}

async function syncDirectoryWith(
  directory: string,
  custom?: (directory: string) => boolean | Promise<boolean>,
  backupCost?: BackupCostContext,
): Promise<boolean> {
  const span = backupCost?.begin('directory-sync', 'directory') ?? null
  if (custom) {
    try {
      const durable = Boolean(await custom(directory))
      backupCost?.settle(span, 'fulfilled', { durable })
      return durable
    } catch {
      backupCost?.settle(span, 'rejected', { durable: false })
      return false
    }
  }
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(directory, 'r')
    await handle.sync()
    backupCost?.settle(span, 'fulfilled', { durable: true })
    return true
  } catch {
    backupCost?.settle(span, 'rejected', { durable: false })
    return false
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function removeUnreferencedSceneFiles(
  projectRoot: string,
  state: WorldProjectStateV1,
  directorySync?: (directory: string) => boolean | Promise<boolean>,
): Promise<boolean> {
  const scenesRoot = join(projectRoot, 'scenes')
  const retained = new Set(state.scenes.map((scene) => basename(scene.path)))
  for (const entry of await readdir(scenesRoot, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new RepositoryFault('unsafe_workspace')
    if (entry.isFile() && entry.name.endsWith('.world-scene.json') && !retained.has(entry.name)) {
      await rm(join(scenesRoot, entry.name), { force: true })
    }
  }
  return syncDirectoryWith(scenesRoot, directorySync)
}

async function durableResultPath(
  packageRoot: string,
  transaction: DurableTransaction,
  transactionRootRelative = '.modly/transactions',
): Promise<string> {
  const transactionsRoot = join(packageRoot, ...transactionRootRelative.split('/'))
  const transactionRoot = join(transactionsRoot, transaction.transactionDigest)
  const afterRoot = join(transactionRoot, 'after')
  const resultPath = join(afterRoot, 'result.v1.json')
  assertContained(packageRoot, transactionRoot)
  await ensureSafeDirectory(transactionsRoot, false)
  await ensureSafeDirectory(transactionRoot, false)
  await ensureSafeDirectory(afterRoot, false)
  return resultPath
}

type BackupTransactionLayout = 'legacy' | 'packed'

interface SafeOpenedFile {
  path: string
  handle: Awaited<ReturnType<typeof open>>
  dev: number
  ino: number
  size: number
}

async function classifyBackupTransactionLayout(backupRoot: string): Promise<BackupTransactionLayout> {
  const legacy = await pathType(join(backupRoot, 'transactions'))
  const pack = await pathType(join(backupRoot, BACKUP_TRANSACTION_PACK_FILE))
  const index = await pathType(join(backupRoot, BACKUP_TRANSACTION_PACK_INDEX_FILE))
  if (legacy === 'symlink' || pack === 'symlink' || index === 'symlink') throw new RepositoryFault('unsafe_workspace')
  if (legacy === 'directory' && pack === 'missing' && index === 'missing') return 'legacy'
  if (legacy === 'missing' && pack === 'file' && index === 'file') return 'packed'
  throw new RepositoryFault('recovery_failed', true)
}

async function pathType(path: string): Promise<'missing' | 'file' | 'directory' | 'symlink' | 'other'> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) return 'symlink'
    if (info.isFile()) return 'file'
    if (info.isDirectory()) return 'directory'
    return 'other'
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return 'missing'
    throw new RepositoryFault('unsafe_workspace')
  }
}

async function readPackedBackupIndex(
  backupRoot: string,
  state: WorldProjectStateV1,
  stateSha256: string,
): Promise<{ index: BackupTransactionPackIndexV1; indexSha256: string }> {
  const indexBytes = await readBounded(join(backupRoot, BACKUP_TRANSACTION_PACK_INDEX_FILE), MAX_BACKUP_PACK_INDEX_BYTES)
  const indexSha256 = sha256(indexBytes)
  const index = parseBackupTransactionPackIndex(parseJsonBuffer(indexBytes), state, stateSha256)
  return { index, indexSha256 }
}

async function planIncrementalBackupPack(
  projectRoot: string,
  previous: LoadedReadyProject,
): Promise<IncrementalBackupPackPlan | null> {
  const backupRelative = previous.state.lastValidBackup
  if (!backupRelative || !BACKUP_PATTERN.test(backupRelative) || previous.state.transactions.length === 0) return null
  const backupRoot = join(projectRoot, ...backupRelative.split('/'))
  assertContained(projectRoot, backupRoot)
  await ensureSafeDirectory(backupRoot, false)
  await ensureSafeDirectory(join(backupRoot, 'scenes'), false)
  if (await classifyBackupTransactionLayout(backupRoot) !== 'packed') return null
  const stateBytes = await readBounded(join(backupRoot, 'state.v1.json'), MAX_STATE_BYTES)
  const backupState = parseState(parseJsonBuffer(stateBytes), previous.projectKey)
  if (
    backupState.projectId !== previous.state.projectId
    || backupState.committedRevision >= previous.state.committedRevision
    || backupRevision(basename(backupRelative)) !== backupState.committedRevision
    || backupState.transactions.length === 0
  ) return null
  const packed = await readPackedBackupIndex(backupRoot, backupState, sha256(stateBytes))
  await assertPackedBackupPhysicalPackHash(backupRoot, packed)
  const overlap = longestBackupSuffixToCurrentPrefix(backupState.transactions, previous.state.transactions)
  if (!overlap) return null
  return { backupRoot, packed, ...overlap }
}

async function assertPackedBackupPhysicalPackHash(
  backupRoot: string,
  packed: { index: BackupTransactionPackIndexV1; indexSha256: string },
): Promise<void> {
  const openedPack = await openSafeRegularFile(join(backupRoot, BACKUP_TRANSACTION_PACK_FILE), packed.index.pack.byteLength)
  const wholePackHash = createHash('sha256')
  let failure: unknown
  try {
    for (const entry of packed.index.entries) {
      const bytes = await readOpenedFileRange(openedPack.handle, entry.offset, entry.length)
      wholePackHash.update(bytes)
      if (sha256(bytes) !== entry.resultSha256) throw new RepositoryFault('recovery_failed', true)
    }
    await assertOpenedFileStillSettled(openedPack)
    if (wholePackHash.digest('hex') !== packed.index.pack.sha256) throw new RepositoryFault('recovery_failed', true)
  } catch (error) {
    failure = error instanceof WorldRepositoryIoError
      ? new RepositoryFault(error.code, error.code === 'invalid_document')
      : error
  } finally {
    try {
      await openedPack.handle.close()
    } catch (error) {
      if (!failure) failure = new RepositoryFault('recovery_failed', true)
    }
  }
  if (failure) throw failure
}

function longestBackupSuffixToCurrentPrefix(
  prior: readonly DurableTransaction[],
  current: readonly DurableTransaction[],
): { overlapStart: number; overlapLength: number } | null {
  for (let overlapStart = 0; overlapStart < prior.length; overlapStart += 1) {
    const overlapLength = Math.min(prior.length - overlapStart, current.length)
    if (overlapLength <= 0) continue
    let matches = true
    for (let index = 0; index < overlapLength; index += 1) {
      const left = prior[overlapStart + index]
      const right = current[index]
      if (left.transactionDigest !== right.transactionDigest
        || left.transactionId !== right.transactionId
        || left.resultSha256 !== right.resultSha256) {
        matches = false
        break
      }
    }
    if (matches) return { overlapStart, overlapLength }
  }
  return null
}

function parseBackupTransactionPackIndex(
  value: unknown,
  state: WorldProjectStateV1,
  stateSha256: string,
): BackupTransactionPackIndexV1 {
  const record = exactRecord(value, [
    'schema', 'projectKey', 'projectId', 'committedRevision', 'stateSha256', 'pack', 'entries',
  ], 'recovery_failed', true)
  const packRecord = exactRecord(record.pack, ['path', 'byteLength', 'sha256'], 'recovery_failed', true)
  if (
    record.schema !== BACKUP_TRANSACTION_PACK_SCHEMA
    || record.projectKey !== state.projectKey
    || record.projectId !== state.projectId
    || record.committedRevision !== state.committedRevision
    || record.stateSha256 !== stateSha256
    || packRecord.path !== BACKUP_TRANSACTION_PACK_FILE
    || typeof packRecord.byteLength !== 'number'
    || !Number.isSafeInteger(packRecord.byteLength)
    || packRecord.byteLength < 0
    || packRecord.byteLength > WORLD_PROJECT_TRANSACTION_LEDGER_LIMIT * MAX_DOCUMENT_BYTES
    || typeof packRecord.sha256 !== 'string'
    || !SHA256_PATTERN.test(packRecord.sha256)
    || !Array.isArray(record.entries)
    || record.entries.length !== state.transactions.length
    || record.entries.length > WORLD_PROJECT_TRANSACTION_LEDGER_LIMIT
  ) throw new RepositoryFault('recovery_failed', true)

  const entries = record.entries.map((entry, index): BackupTransactionPackIndexEntry => {
    const entryRecord = exactRecord(entry, [
      'transactionId', 'transactionDigest', 'resultSha256', 'offset', 'length',
    ], 'recovery_failed', true)
    const transaction = state.transactions[index]
    if (
      entryRecord.transactionId !== transaction.transactionId
      || entryRecord.transactionDigest !== transaction.transactionDigest
      || entryRecord.resultSha256 !== transaction.resultSha256
      || typeof entryRecord.offset !== 'number'
      || !Number.isSafeInteger(entryRecord.offset)
      || typeof entryRecord.length !== 'number'
      || !Number.isSafeInteger(entryRecord.length)
      || entryRecord.offset < 0
      || entryRecord.length <= 0
      || entryRecord.length > MAX_DOCUMENT_BYTES
    ) throw new RepositoryFault('recovery_failed', true)
    return {
      transactionId: transaction.transactionId,
      transactionDigest: transaction.transactionDigest,
      resultSha256: transaction.resultSha256,
      offset: entryRecord.offset,
      length: entryRecord.length,
    }
  })
  let expectedOffset = 0
  for (const entry of entries) {
    if (entry.offset !== expectedOffset) throw new RepositoryFault('recovery_failed', true)
    expectedOffset += entry.length
  }
  if (expectedOffset !== packRecord.byteLength) throw new RepositoryFault('recovery_failed', true)
  if (entries.length === 0 && (packRecord.byteLength !== 0 || packRecord.sha256 !== sha256(Buffer.alloc(0)))) {
    throw new RepositoryFault('recovery_failed', true)
  }
  return {
    schema: BACKUP_TRANSACTION_PACK_SCHEMA,
    projectKey: state.projectKey,
    projectId: state.projectId,
    committedRevision: state.committedRevision,
    stateSha256,
    pack: {
      path: BACKUP_TRANSACTION_PACK_FILE,
      byteLength: packRecord.byteLength,
      sha256: packRecord.sha256,
    },
    entries,
  }
}

async function verifyPackedBackupPackage(
  projectRoot: string,
  backupRoot: string,
  projectKey: string,
  state: WorldProjectStateV1,
  stateSha256: string,
  proofScope?: DurableResultProofScope,
): Promise<void> {
  const verified = await verifyPackage(backupRoot, projectKey, state)
  const packed = await readPackedBackupIndex(backupRoot, state, stateSha256)
  const packPath = join(backupRoot, BACKUP_TRANSACTION_PACK_FILE)
  const openedPack = await openSafeRegularFile(packPath, packed.index.pack.byteLength)
  const wholePackHash = createHash('sha256')
  const proofs: DurableResultChainProof[] = []
  let failure: unknown
  try {
    for (const transaction of state.transactions) {
      const bytes = await readPackedBackupResultBytesWithHandle(openedPack.handle, projectRoot, backupRoot, packed, transaction)
      wholePackHash.update(bytes)
      assertDurableResultHash(bytes, transaction.resultSha256)
      proofs.push(verifyDurableResultProofBytes(bytes, projectKey, state.projectId, transaction, proofScope,
        packedProofAuthority(projectRoot, backupRoot, packed, transaction)))
    }
    assertDurableResultChain(proofs, verified.snapshot)
    const probe = Buffer.allocUnsafe(1)
    const overflow = await openedPack.handle.read(probe, 0, 1, packed.index.pack.byteLength)
    if (overflow.bytesRead !== 0) throw new RepositoryFault('recovery_failed', true)
    await assertOpenedFileStillSettled(openedPack)
    if (wholePackHash.digest('hex') !== packed.index.pack.sha256) throw new RepositoryFault('recovery_failed', true)
  } catch (error) {
    failure = error instanceof WorldRepositoryIoError
      ? new RepositoryFault(error.code, error.code === 'invalid_document')
      : error
  } finally {
    try {
      await openedPack.handle.close()
    } catch (error) {
      if (!failure) failure = new RepositoryFault('recovery_failed', true)
    }
  }
  if (failure) throw failure
  proofScope?.settlePackedBackup?.()
}

async function readPackedBackupResultBytes(
  backupRoot: string,
  packed: { index: BackupTransactionPackIndexV1; indexSha256: string },
  transaction: DurableTransaction,
): Promise<Buffer> {
  const openedPack = await openSafeRegularFile(join(backupRoot, BACKUP_TRANSACTION_PACK_FILE), packed.index.pack.byteLength)
  let failure: unknown
  let bytes: Buffer | null = null
  try {
    bytes = await readPackedBackupResultBytesWithHandle(openedPack.handle, backupRoot, backupRoot, packed, transaction)
    await assertOpenedFileStillSettled(openedPack)
  } catch (error) {
    failure = error instanceof WorldRepositoryIoError
      ? new RepositoryFault(error.code, error.code === 'invalid_document')
      : error
  } finally {
    try {
      await openedPack.handle.close()
    } catch {
      if (!failure) failure = new RepositoryFault('recovery_failed', true)
    }
  }
  if (failure) throw failure
  if (!bytes) throw new RepositoryFault('recovery_failed', true)
  return bytes
}

async function readPackedBackupResultBytesWithHandle(
  handle: Awaited<ReturnType<typeof open>>,
  projectRoot: string,
  backupRoot: string,
  packed: { index: BackupTransactionPackIndexV1; indexSha256: string },
  transaction: DurableTransaction,
): Promise<Buffer> {
  const entry = packed.index.entries.find((candidate) => candidate.transactionDigest === transaction.transactionDigest)
  if (!entry) throw new RepositoryFault('recovery_failed', true)
  const bytes = await readOpenedFileRange(handle, entry.offset, entry.length)
  assertDurableResultHash(bytes, transaction.resultSha256)
  return bytes
}

async function openSafeRegularFile(path: string, maximum: number): Promise<SafeOpenedFile> {
  const before = await lstat(path)
  if (before.isSymbolicLink() || !before.isFile() || before.size !== maximum) {
    throw new RepositoryFault(before.isSymbolicLink() ? 'unsafe_workspace' : 'recovery_failed', true)
  }
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const handle = await open(path, constants.O_RDONLY | noFollow)
  try {
    const opened = await handle.stat()
    const current = await lstat(path)
    if (!opened.isFile()
      || opened.size !== maximum
      || current.isSymbolicLink()
      || !current.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || current.dev !== opened.dev
      || current.ino !== opened.ino) {
      throw new RepositoryFault(current.isSymbolicLink() ? 'unsafe_workspace' : 'recovery_failed', true)
    }
    return { path, handle, dev: opened.dev, ino: opened.ino, size: opened.size }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function assertOpenedFileStillSettled(opened: SafeOpenedFile): Promise<void> {
  const handleInfo = await opened.handle.stat()
  const pathInfo = await lstat(opened.path)
  if (!handleInfo.isFile()
    || pathInfo.isSymbolicLink()
    || !pathInfo.isFile()
    || handleInfo.dev !== opened.dev
    || handleInfo.ino !== opened.ino
    || handleInfo.size !== opened.size
    || pathInfo.dev !== opened.dev
    || pathInfo.ino !== opened.ino
    || pathInfo.size !== opened.size) {
    throw new RepositoryFault(pathInfo.isSymbolicLink() ? 'unsafe_workspace' : 'recovery_failed', true)
  }
}

async function writeOpenedFileComplete(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Buffer,
  position: number,
  backupCost?: BackupCostContext,
  ledgerIndex: number | null = null,
  appliedRevision: number | null = null,
): Promise<void> {
  let written = 0
  let calls = 0
  const span = backupCost?.begin('write-positional', 'pack', {
    ledgerIndex, appliedRevision, requestedBytes: bytes.byteLength, sourceBytes: bytes.byteLength,
  }) ?? null
  let outcome: BackupCostOutcome = 'rejected'
  try {
  while (written < bytes.byteLength) {
    const result = await handle.write(bytes, written, bytes.byteLength - written, position + written)
    calls += 1
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) {
      throw new RepositoryFault('write_failed', true)
    }
    written += result.bytesWritten
  }
    outcome = 'fulfilled'
  } finally {
    backupCost?.settle(span, outcome, { completedBytes: written, sourceBytes: bytes.byteLength, calls })
  }
}

function packedProofAuthority(
  projectRoot: string,
  backupRoot: string,
  packed: { index: BackupTransactionPackIndexV1; indexSha256: string },
  transaction: DurableTransaction,
): DurableResultProofSource {
  const entry = packed.index.entries.find((candidate) => candidate.transactionDigest === transaction.transactionDigest)
  if (!entry) throw new RepositoryFault('recovery_failed', true)
  return {
    layout: 'backup-pack',
    backupRelativePath: backupRootRelativePath(projectRoot, backupRoot),
    indexSha256: packed.indexSha256,
    packByteLength: packed.index.pack.byteLength,
    packSha256: packed.index.pack.sha256,
    offset: entry.offset,
    length: entry.length,
  }
}

function backupRootRelativePath(projectRoot: string, backupRoot: string): string {
  const relativePath = relative(projectRoot, backupRoot).replaceAll('\\', '/')
  if (!BACKUP_PATTERN.test(relativePath)) throw new RepositoryFault('recovery_failed', true)
  return relativePath
}

function normalizeDurableProofSource(source: DurableResultProofSource | undefined): DurableResultProofSource {
  return source ?? { layout: 'primary-legacy' }
}

const DURABLE_PROOF_ENTRY_LIMIT = 64
const DURABLE_PROOF_BYTE_LIMIT = 8 * 1024 * 1024
const DURABLE_PROOF_METADATA_CHARGE = 512
const DURABLE_PROOF_SEMANTICS = 'modly.world-command-result-proof.v1'

interface DurableResultProofCacheEntry {
  bytes: Buffer
  proof: DurableResultChainProof
  charge: number
  sourceLayout: DurableResultProofSource['layout']
  transactionDigest: string
}

interface DurableResultProofCache {
  createScope(context: RepositoryContext, projectKey: string): DurableResultProofScope
}

function createDurableResultProofCache(): DurableResultProofCache {
  const clone = globalThis.structuredClone
  let namespaceKey: string | null = null
  let entries = new Map<string, DurableResultProofCacheEntry>()
  let retainedBytes = 0
  let epoch = 0
  const eligible = (): boolean => {
    try { return globalThis.structuredClone === clone && isSafeWorldWireRecord({}) } catch { return false }
  }
  const clear = (): void => {
    entries = new Map()
    retainedBytes = 0
  }
  return {
    createScope(context, projectKey) {
      if (!eligible()) {
        clear()
        namespaceKey = null
        epoch += 1
        const scope = ((bytes, currentProjectKey, projectId, transaction) => {
          return verifyDurableResultSemantics(bytes, currentProjectKey, projectId, transaction).proof
        }) as DurableResultProofScope
        scope.promote = () => {}
        scope.discard = () => {}
        return scope
      }
      // Logical authority is captured after root-lock acquisition, never from a physical backup path.
      const namespace = [context.workspaceRoot, context.worldsRoot, join(context.worldsRoot, projectKey), projectKey]
      const requestedNamespaceKey = JSON.stringify([...namespace, DURABLE_PROOF_SEMANTICS])
      epoch += 1
      const leaseEpoch = epoch
      if (namespaceKey !== requestedNamespaceKey) {
        clear()
        namespaceKey = requestedNamespaceKey
      }
      let promotable = true
      let finalized = false
      let operationEntries = new Map(entries)
      let operationBytes = retainedBytes
      let bridgeCreated = false
      let bridgeBytes = 0
      let nextTransactionDigests: Set<string> | undefined
      let retirementBytes = 0
      const clearRetirement = (): void => {
        nextTransactionDigests = undefined
        retirementBytes = 0
      }
      const captured = new Map<string, DurableResultProofCacheEntry & { offset: number }>()
      const pending = new Map<string, DurableResultProofCacheEntry>()
      let destroyBridge = () => {}
      const leaseCurrent = (): boolean => epoch === leaseEpoch && namespaceKey === requestedNamespaceKey
      const invalidateLease = (): void => {
        promotable = false
        destroyBridge()
        clearRetirement()
        operationEntries = new Map()
        operationBytes = 0
        if (leaseCurrent()) {
          clear()
          namespaceKey = null
          epoch += 1
        }
      }
      const usable = (): boolean => {
        if (finalized || !promotable || !leaseCurrent() || !eligible()) {
          invalidateLease()
          return false
        }
        return true
      }
      const makeRoom = (charge: number, backupCost?: BackupCostContext): boolean => {
        // Include pinned copies even when their ordinary source proof has been evicted.
        while (operationEntries.size && (operationEntries.size + captured.size + pending.size >= DURABLE_PROOF_ENTRY_LIMIT
          || operationBytes + bridgeBytes + retirementBytes + charge > DURABLE_PROOF_BYTE_LIMIT)) {
          const oldestKey = operationEntries.keys().next().value!
          const oldest = operationEntries.get(oldestKey)!
          backupCost?.cache('cache-evict', oldest.bytes.byteLength)
          operationBytes -= oldest.charge
          operationEntries.delete(oldestKey)
        }
        return operationEntries.size + captured.size + pending.size < DURABLE_PROOF_ENTRY_LIMIT
          && operationBytes + bridgeBytes + retirementBytes + charge <= DURABLE_PROOF_BYTE_LIMIT
      }
      const entryCharge = (byteLength: number, key: string, transactionDigest: string,
        sourceLayout: DurableResultProofSource['layout'], proof: DurableResultChainProof): number =>
        byteLength + Buffer.byteLength(proof.snapshotCanonical) + Buffer.byteLength(proof.inverseSnapshotCanonical)
        + (key.length + transactionDigest.length + sourceLayout.length) * 2 + DURABLE_PROOF_METADATA_CHARGE
      const authority = (currentProjectKey: string, projectId: string, transaction: DurableTransaction) => [
        ...namespace, currentProjectKey, projectId, DURABLE_PROOF_SEMANTICS,
        transaction.transactionId, transaction.transactionDigest, transaction.payloadSha256,
        transaction.canonicalPayload, transaction.appliedRevision, transaction.resultSha256,
      ]
      const scope = ((bytes, currentProjectKey, projectId, transaction, source, backupCost) => {
        // Added Object.prototype.toJSON must not execute during candidate-key encoding.
        if (!usable()) {
          return verifyDurableResultSemantics(bytes, currentProjectKey, projectId, transaction, backupCost).proof
        }
        const sourceLayout = normalizeDurableProofSource(source).layout
        const key = JSON.stringify([...authority(currentProjectKey, projectId, transaction), normalizeDurableProofSource(source)])
        const previous = operationEntries.get(key)
        // Fresh physical read and SHA256 happened before this synchronous eligibility check.
        if (previous && previous.bytes.byteLength === bytes.byteLength && previous.bytes.equals(bytes) && usable()) {
          backupCost?.cache('cache-hit', bytes.byteLength)
          operationEntries.delete(key)
          operationEntries.set(key, previous)
          return previous.proof
        }
        backupCost?.cache('cache-miss', bytes.byteLength)
        const proof = verifyDurableResultSemantics(bytes, currentProjectKey, projectId, transaction, backupCost).proof
        if (!usable()) return proof
        const charge = entryCharge(bytes.byteLength, key, transaction.transactionDigest, sourceLayout, proof)
        if (charge > DURABLE_PROOF_BYTE_LIMIT) return proof
        if (previous) {
          backupCost?.cache('cache-evict', previous.bytes.byteLength)
          operationEntries.delete(key)
          operationBytes -= previous.charge
        }
        if (!makeRoom(charge, backupCost)) return proof
        // Non-pooled backing storage cannot alias a copy caller's buffer or backing ArrayBuffer.
        const copyOwned = () => {
          const owned = Buffer.alloc(bytes.byteLength)
          bytes.copy(owned)
          return owned
        }
        const ownedBytes = backupCost?.measure('copy', 'receipt', copyOwned, { sourceBytes: bytes.byteLength }) ?? copyOwned()
        operationEntries.set(key, { bytes: ownedBytes, proof, charge, sourceLayout, transactionDigest: transaction.transactionDigest })
        operationBytes += charge
        backupCost?.cache('cache-admit', ownedBytes.byteLength)
        return proof
      }) as DurableResultProofScope
      scope.retirePublicationAuthorities = (digests) => {
        if (!usable() || nextTransactionDigests || digests.length > WORLD_PROJECT_TRANSACTION_LEDGER_LIMIT
          || digests.some((digest) => !DIGEST_PATTERN.test(digest))) return
        // Bounded primitive copy only; the plan is never retained across operations or failures.
        const next = new Set(digests)
        const charge = DURABLE_PROOF_METADATA_CHARGE
          + [...next].reduce((total, digest) => total + digest.length * 2 + DURABLE_PROOF_METADATA_CHARGE, 0)
        for (const [key, proof] of operationEntries) {
          if (proof.sourceLayout === 'primary-legacy') continue
          operationEntries.delete(key)
          operationBytes -= proof.charge
        }
        if (!makeRoom(charge)) return
        nextTransactionDigests = next
        retirementBytes = charge
      }
      scope.createBackupBridge = (backupRelativePath) => {
        if (bridgeCreated || !usable()) return undefined
        bridgeCreated = true
        let active = true
        let nextOffset = 0
        let sealedIndexSha256: string | undefined
        let sealedPackSha256: string | undefined
        let sealedPackByteLength: number | undefined
        destroyBridge = () => {
          active = false
          sealedIndexSha256 = sealedPackSha256 = undefined
          sealedPackByteLength = undefined
          captured.clear()
          pending.clear()
          bridgeBytes = 0
        }
        const sourceScope = ((bytes, currentProjectKey, projectId, transaction, source, backupCost) => {
          // Verify once at the ordinary source boundary; capture synchronously before any write await.
          const chainProof = scope(bytes, currentProjectKey, projectId, transaction, source, backupCost)
          if (!active || !usable()) return chainProof
          // The writer appends these freshly verified receipts sequentially, including uncached ones.
          const offset = nextOffset
          nextOffset += bytes.byteLength
          const key = JSON.stringify([...authority(currentProjectKey, projectId, transaction), bytes.byteLength])
          const sourceLayout = normalizeDurableProofSource(source).layout
          const charge = entryCharge(bytes.byteLength, key, transaction.transactionDigest, sourceLayout, chainProof)
          if (charge > DURABLE_PROOF_BYTE_LIMIT || captured.has(key) || !makeRoom(charge, backupCost)) return chainProof
          const copyOwned = () => {
            const owned = Buffer.alloc(bytes.byteLength)
            bytes.copy(owned)
            return owned
          }
          const ownedBytes = backupCost?.measure('copy', 'receipt', copyOwned, { sourceBytes: bytes.byteLength }) ?? copyOwned()
          captured.set(key, { bytes: ownedBytes, proof: chainProof, charge, offset, sourceLayout, transactionDigest: transaction.transactionDigest })
          bridgeBytes += charge
          backupCost?.cache('cache-admit', ownedBytes.byteLength)
          if (nextTransactionDigests && !nextTransactionDigests.has(transaction.transactionDigest) && usable()) {
            // Only an independently owned, admitted capture can retire its exact ordinary primary key.
            const primaryKey = JSON.stringify([...authority(currentProjectKey, projectId, transaction), normalizeDurableProofSource(source)])
            const primary = operationEntries.get(primaryKey)
            if (primary?.sourceLayout === 'primary-legacy' && primary.transactionDigest === transaction.transactionDigest) {
              backupCost?.cache('cache-evict', primary.bytes.byteLength)
              operationEntries.delete(primaryKey)
              operationBytes -= primary.charge
            }
          }
          return chainProof
        }) as DurableResultProofScope
        const destinationScope = ((bytes, currentProjectKey, projectId, transaction, source, backupCost) => {
          if (!active || !usable() || source?.layout !== 'backup-pack'
            || source.backupRelativePath !== backupRelativePath
            || source.indexSha256 !== sealedIndexSha256
            || source.packSha256 !== sealedPackSha256
            || source.packByteLength !== sealedPackByteLength) {
            return scope(bytes, currentProjectKey, projectId, transaction, source, backupCost)
          }
          const key = JSON.stringify([...authority(currentProjectKey, projectId, transaction), bytes.byteLength])
          const proof = captured.get(key)
          if (!proof || proof.offset !== source.offset || proof.bytes.byteLength !== source.length
            || proof.bytes.byteLength !== bytes.byteLength || !proof.bytes.equals(bytes) || !usable()) {
            return scope(bytes, currentProjectKey, projectId, transaction, source, backupCost)
          }
          // Physical authority is the freshly read destination, never the primary source's identity.
          const destinationKey = JSON.stringify([...authority(currentProjectKey, projectId, transaction), source])
          const charge = entryCharge(bytes.byteLength, destinationKey, transaction.transactionDigest, 'backup-pack', proof.proof)
          captured.delete(key)
          bridgeBytes -= proof.charge
          if (!makeRoom(charge, backupCost)) {
            return proof.proof
          }
          pending.set(destinationKey, { bytes: proof.bytes, proof: proof.proof, charge, sourceLayout: 'backup-pack', transactionDigest: transaction.transactionDigest })
          bridgeBytes += charge
          return proof.proof
        }) as DurableResultProofScope
        sourceScope.promote = destinationScope.promote = () => {}
        sourceScope.discard = destinationScope.discard = destroyBridge
        destinationScope.discardBackupBridge = destroyBridge
        destinationScope.settlePackedBackup = () => {
          if (!active || !usable()) return
          // No await: transfer bounded owned bytes only after the destination handle closed successfully.
          for (const proof of captured.values()) bridgeBytes -= proof.charge
          captured.clear()
          for (const [key, proof] of pending) {
            pending.delete(key)
            bridgeBytes -= proof.charge
            const previous = operationEntries.get(key)
            if (previous) { operationEntries.delete(key); operationBytes -= previous.charge }
            if (makeRoom(proof.charge)) {
              operationEntries.set(key, proof)
              operationBytes += proof.charge
            }
          }
          destroyBridge()
        }
        return {
          sourceScope,
          destinationScope,
          sealDestination(indexSha256, packSha256, packByteLength) {
            if (!active || !usable() || sealedIndexSha256 !== undefined || nextOffset !== packByteLength) {
              destroyBridge()
              return
            }
            // Retain primitives only; no generated index object or I/O-owned buffer enters the seal.
            sealedIndexSha256 = indexSha256
            sealedPackSha256 = packSha256
            sealedPackByteLength = packByteLength
          },
          discard: destroyBridge,
        }
      }
      scope.promote = () => {
        if (finalized) return
        const canPromote = usable()
        finalized = true
        destroyBridge()
        clearRetirement()
        if (canPromote) {
          entries = operationEntries
          retainedBytes = operationBytes
        }
        operationEntries = new Map()
        operationBytes = 0
      }
      scope.discard = () => {
        if (finalized) return
        finalized = true
        promotable = false
        destroyBridge()
        clearRetirement()
        operationEntries = new Map()
        operationBytes = 0
      }
      return scope
    }
  }
}

async function readDurableResultProofBytes(
  packageRoot: string,
  projectKey: string,
  projectId: string,
  transaction: DurableTransaction,
  transactionRootRelative = '.modly/transactions',
  proofScope?: DurableResultProofScope,
  source?: DurableResultProofSource,
  backupCost?: BackupCostContext,
  ledgerIndex: number | null = null,
): Promise<Buffer> {
  try {
    const bytes = await readDurableResultProofFreshBytes(packageRoot, transaction, transactionRootRelative, backupCost, ledgerIndex)
    verifyDurableResultProofBytes(bytes, projectKey, projectId, transaction, proofScope, source, backupCost, ledgerIndex)
    return bytes
  } catch (error) {
    if (error instanceof RepositoryFault && error.code === 'unsafe_workspace') throw error
    throw new RepositoryFault('recovery_failed', true)
  }
}

async function readDurableResultProofFreshBytes(
  packageRoot: string,
  transaction: DurableTransaction,
  transactionRootRelative = '.modly/transactions',
  backupCost?: BackupCostContext,
  ledgerIndex: number | null = null,
): Promise<Buffer> {
  const resultPath = await durableResultPath(packageRoot, transaction, transactionRootRelative)
  const bytes = await readBounded(resultPath, MAX_DOCUMENT_BYTES, backupCost, 'receipt', ledgerIndex, transaction.appliedRevision)
  assertDurableResultHash(bytes, transaction.resultSha256, backupCost, ledgerIndex, transaction.appliedRevision)
  return bytes
}

function verifyDurableResultProofBytes(
  bytes: Buffer,
  projectKey: string,
  projectId: string,
  transaction: DurableTransaction,
  proofScope?: DurableResultProofScope,
  source?: DurableResultProofSource,
  backupCost?: BackupCostContext,
  ledgerIndex: number | null = null,
): DurableResultChainProof {
  const verify = () => {
    if (proofScope) return proofScope(bytes, projectKey, projectId, transaction, source, backupCost)
    return verifyDurableResultSemantics(bytes, projectKey, projectId, transaction, backupCost).proof
  }
  if (backupCost) return backupCost.measure('proof-lookup', 'receipt', verify, {
    ledgerIndex, appliedRevision: transaction.appliedRevision, sourceBytes: bytes.byteLength,
  })
  return verify()
}

async function readVerifiedDurableResult(
  packageRoot: string,
  projectKey: string,
  projectId: string,
  transaction: DurableTransaction,
  transactionRootRelative = '.modly/transactions',
  source?: DurableResultProofSource,
): Promise<{ bytes: Buffer; value: WorldProjectCommandSuccess }> {
  try {
    const resultPath = await durableResultPath(packageRoot, transaction, transactionRootRelative)
    const bytes = await readBounded(resultPath, MAX_DOCUMENT_BYTES)
    assertDurableResultHash(bytes, transaction.resultSha256)
    return { bytes, value: verifyDurableResultSemantics(bytes, projectKey, projectId, transaction).value }
  } catch (error) {
    if (error instanceof RepositoryFault && error.code === 'unsafe_workspace') throw error
    throw new RepositoryFault('recovery_failed', true)
  }
}

function assertDurableResultHash(bytes: Buffer, expectedSha256: string, backupCost?: BackupCostContext,
  ledgerIndex: number | null = null, appliedRevision: number | null = null): void {
  const actual = backupCost?.measure('hash', 'receipt', () => sha256(bytes), { ledgerIndex, appliedRevision, sourceBytes: bytes.byteLength }) ?? sha256(bytes)
  if (actual !== expectedSha256) throw new RepositoryFault('recovery_failed', true)
}

function verifyDurableResultSemantics(
  bytes: Buffer,
  projectKey: string,
  projectId: string,
  transaction: DurableTransaction,
  backupCost?: BackupCostContext,
): VerifiedDurableResultSemantics {
  const value = parseJsonBuffer(bytes, backupCost, 'receipt')
  if (isPlainRecord(value) && value.schema === COMMAND_RESULT_COMPACT_SCHEMA) {
    return verifyCompactDurableResultSemantics(value, projectKey, projectId, transaction, backupCost)
  }
  const record = exactRecord(value, [
    'schema', 'transactionId', 'snapshot', 'newRevision', 'changes', 'warnings', 'inverse',
  ], 'recovery_failed', true)
  if (record.schema !== COMMAND_RESULT_SCHEMA || record.transactionId !== transaction.transactionId) {
    throw new RepositoryFault('recovery_failed', true)
  }
  const snapshot = backupCost?.measure('validate', 'receipt', () => validateWorldProjectSnapshot(record.snapshot))
    ?? validateWorldProjectSnapshot(record.snapshot)
  if (!snapshot.success) throw new RepositoryFault('recovery_failed', true)
  assertSnapshotConfinement(projectKey, snapshot.value)
  if (
    record.newRevision !== transaction.appliedRevision
    || snapshot.value.project.revision !== transaction.appliedRevision
    || snapshot.value.project.projectId !== projectId
  ) throw new RepositoryFault('recovery_failed', true)
  const changes = deterministicStringArray(record.changes)
  const warnings = deterministicStringArray(record.warnings)
  const inverseRecord = exactRecord(record.inverse, ['kind', 'snapshot'], 'recovery_failed', true)
  if (inverseRecord.kind !== 'world-snapshot') throw new RepositoryFault('recovery_failed', true)
  const inverseSnapshot = backupCost?.measure('validate', 'receipt', () => validateWorldProjectSnapshot(inverseRecord.snapshot))
    ?? validateWorldProjectSnapshot(inverseRecord.snapshot)
  if (!inverseSnapshot.success) throw new RepositoryFault('recovery_failed', true)
  assertSnapshotConfinement(projectKey, inverseSnapshot.value)
  if (
    inverseSnapshot.value.project.projectId !== projectId
    || inverseSnapshot.value.project.revision + 1 !== transaction.appliedRevision
  ) throw new RepositoryFault('recovery_failed', true)

  const inverse: WorldCommandInverse = { kind: 'world-snapshot', snapshot: inverseSnapshot.value }
  const parsedBatch = backupCost?.measure('canonical-parse', 'receipt', () => parseCanonicalDurableBatch(transaction.canonicalPayload), {
    sourceBytes: Buffer.byteLength(transaction.canonicalPayload),
  }) ?? parseCanonicalDurableBatch(transaction.canonicalPayload)
  const replayed = backupCost?.measure('replay', 'receipt', () => applyWorldCommandBatch(inverseSnapshot.value, parsedBatch))
    ?? applyWorldCommandBatch(inverseSnapshot.value, parsedBatch)
  const canonical = (value: unknown) => backupCost?.measure('canonical-encode', 'receipt', () => stableSerialize(value)) ?? stableSerialize(value)
  if (!replayed.success) throw new RepositoryFault('recovery_failed', true)
  const snapshotCanonical = canonical(snapshot.value)
  const inverseSnapshotCanonical = canonical(inverseSnapshot.value)
  if (canonical(replayed.snapshot) !== snapshotCanonical
    || canonical(replayed.inverse) !== canonical(inverse)
    || canonical(replayed.changes) !== canonical(changes)
    || canonical(replayed.warnings) !== canonical(warnings)) {
    throw new RepositoryFault('recovery_failed', true)
  }
  return {
    value: {
      projectKey,
      snapshot: snapshot.value,
      newRevision: transaction.appliedRevision,
      idempotent: false,
      changes,
      warnings,
      inverse,
      receipt: publicReceipt(transaction),
    },
    proof: { snapshotCanonical, inverseSnapshotCanonical },
  }
}

function verifyCompactDurableResultSemantics(
  value: Record<string, unknown>,
  projectKey: string,
  projectId: string,
  transaction: DurableTransaction,
  backupCost?: BackupCostContext,
): VerifiedDurableResultSemantics {
  const record = exactRecord(value, [
    'schema', 'transactionId', 'newRevision', 'changes', 'warnings', 'inverse',
  ], 'recovery_failed', true)
  if (record.schema !== COMMAND_RESULT_COMPACT_SCHEMA
    || record.transactionId !== transaction.transactionId
    || record.newRevision !== transaction.appliedRevision) {
    throw new RepositoryFault('recovery_failed', true)
  }
  const changes = deterministicStringArray(record.changes)
  const warnings = deterministicStringArray(record.warnings)
  const inverseRecord = exactRecord(record.inverse, ['kind', 'snapshot'], 'recovery_failed', true)
  if (inverseRecord.kind !== 'world-snapshot') throw new RepositoryFault('recovery_failed', true)
  const inverseSnapshot = backupCost?.measure('validate', 'receipt', () => validateWorldProjectSnapshot(inverseRecord.snapshot))
    ?? validateWorldProjectSnapshot(inverseRecord.snapshot)
  if (!inverseSnapshot.success) throw new RepositoryFault('recovery_failed', true)
  assertSnapshotConfinement(projectKey, inverseSnapshot.value)
  if (inverseSnapshot.value.project.projectId !== projectId
    || inverseSnapshot.value.project.revision + 1 !== transaction.appliedRevision) {
    throw new RepositoryFault('recovery_failed', true)
  }
  const inverse: WorldCommandInverse = { kind: 'world-snapshot', snapshot: inverseSnapshot.value }
  const parsedBatch = backupCost?.measure('canonical-parse', 'receipt', () => parseCanonicalDurableBatch(transaction.canonicalPayload), {
    sourceBytes: Buffer.byteLength(transaction.canonicalPayload),
  }) ?? parseCanonicalDurableBatch(transaction.canonicalPayload)
  if (parsedBatch.transactionId !== transaction.transactionId
    || parsedBatch.projectId !== projectId
    || parsedBatch.baseRevision + 1 !== transaction.appliedRevision) {
    throw new RepositoryFault('recovery_failed', true)
  }
  const replayed = backupCost?.measure('replay', 'receipt', () => applyWorldCommandBatch(inverseSnapshot.value, parsedBatch))
    ?? applyWorldCommandBatch(inverseSnapshot.value, parsedBatch)
  const canonical = (candidate: unknown) => backupCost?.measure('canonical-encode', 'receipt', () => stableSerialize(candidate))
    ?? stableSerialize(candidate)
  if (!replayed.success) throw new RepositoryFault('recovery_failed', true)
  const snapshotCanonical = canonical(replayed.snapshot)
  const inverseSnapshotCanonical = canonical(inverseSnapshot.value)
  if (canonical(replayed.inverse) !== canonical(inverse)
    || canonical(replayed.changes) !== canonical(changes)
    || canonical(replayed.warnings) !== canonical(warnings)) {
    throw new RepositoryFault('recovery_failed', true)
  }
  assertSnapshotConfinement(projectKey, replayed.snapshot)
  if (replayed.snapshot.project.projectId !== projectId
    || replayed.snapshot.project.revision !== transaction.appliedRevision) {
    throw new RepositoryFault('recovery_failed', true)
  }
  return {
    value: {
      projectKey,
      snapshot: replayed.snapshot,
      newRevision: transaction.appliedRevision,
      idempotent: false,
      changes,
      warnings,
      inverse,
      receipt: publicReceipt(transaction),
    },
    proof: { snapshotCanonical, inverseSnapshotCanonical },
  }
}

async function readBounded(path: string, maximum: number, backupCost?: BackupCostContext,
  target: BackupCostTarget = 'receipt', ledgerIndex: number | null = null,
  appliedRevision: number | null = null): Promise<Buffer> {
  const boundedSpan = backupCost?.begin('bounded-read', target, { ledgerIndex, appliedRevision, requestedBytes: maximum }) ?? null
  let boundedOutcome: BackupCostOutcome = 'rejected'
  let sourceBytes: number | null = null
  let completedBytes: number | null = null
  let readCalls = 0
  try {
    const before = await lstat(path)
    if (before.isSymbolicLink() || !before.isFile() || before.size > maximum) {
      throw new RepositoryFault(before.isSymbolicLink() ? 'unsafe_workspace' : 'invalid_document')
    }
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
    const handle = await open(path, constants.O_RDONLY | noFollow)
    let bytes: Buffer
    try {
      const opened = await handle.stat()
      sourceBytes = opened.size
      const current = await lstat(path)
      if (!opened.isFile() || opened.size > maximum
        || current.isSymbolicLink() || !current.isFile()
        || opened.dev !== before.dev || opened.ino !== before.ino
        || current.dev !== opened.dev || current.ino !== opened.ino) {
        throw new RepositoryFault(current.isSymbolicLink() ? 'unsafe_workspace' : 'invalid_document')
      }
      const observedHandle = backupCost ? {
      read(buffer: Buffer, offset: number, length: number, position: number) {
        const readSpan = backupCost.begin('read-await', target, {
          ledgerIndex, appliedRevision, requestedBytes: length, sourceBytes: opened.size,
        })
        let original: ReturnType<PositionalReadFile['read']>
        try { original = handle.read(buffer, offset, length, position) } catch (error) {
          backupCost.settle(readSpan, 'rejected', { sourceBytes: opened.size, calls: 1 })
          throw error
        }
        readCalls += 1
        queueMicrotask(() => {
          void original.then((value) => {
            backupCost.settle(readSpan, 'fulfilled', { completedBytes: value.bytesRead, sourceBytes: opened.size, calls: 1 })
          }, () => {
            backupCost.settle(readSpan, 'rejected', { sourceBytes: opened.size, calls: 1 })
          })
        })
        return original
      },
      } : handle
      bytes = await readBoundedOpenedFile(observedHandle, maximum, opened.size)
    } catch (error) {
      if (error instanceof WorldRepositoryIoError) throw new RepositoryFault(error.code)
      throw error
    } finally {
      await handle.close()
    }
    completedBytes = bytes.byteLength
    boundedOutcome = 'fulfilled'
    return bytes
  } finally {
    backupCost?.settle(boundedSpan, boundedOutcome, { completedBytes, sourceBytes, calls: readCalls })
  }
}

async function readJson(path: string, maximum: number): Promise<unknown> {
  return parseJsonBuffer(await readBounded(path, maximum))
}

function parseJsonBuffer(bytes: Buffer, backupCost?: BackupCostContext, target: BackupCostTarget = 'receipt'): unknown {
  try {
    if (!backupCost) return JSON.parse(bytes.toString('utf8'))
    const decoded = backupCost.measure('utf8-decode', target, () => bytes.toString('utf8'), { sourceBytes: bytes.byteLength })
    return backupCost.measure('json-parse', target, () => JSON.parse(decoded), { sourceBytes: bytes.byteLength })
  } catch { throw new RepositoryFault('invalid_document') }
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return false
    throw error
  }
}

function parseLockOwner(value: unknown): { pid: number; token: string; createdAt: string } {
  const record = exactRecord(value, ['pid', 'token', 'createdAt'], 'project_busy', true)
  if (
    typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0
    || typeof record.token !== 'string' || !/^[a-f0-9]{32}$/.test(record.token)
    || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))
  ) throw new RepositoryFault('project_busy', true)
  return { pid: record.pid, token: record.token, createdAt: record.createdAt }
}

function deleteReceiptPath(context: RepositoryContext, transactionId: string): string {
  const receiptRoot = join(context.worldsRoot, '.trash', '.modly-delete-receipts')
  const path = join(receiptRoot, `${sha256(transactionId)}.json`)
  assertContained(context.worldsRoot, path)
  return path
}

async function readDeleteReceipt(path: string): Promise<DeleteReceiptV1 | null> {
  if (!await pathExists(path)) return null
  try {
    const record = exactRecord(await readJson(path, 512 * 1024), [
      'schema', 'transactionId', 'canonicalPayload', 'payloadSha256', 'projectKey',
      'expectedRevision', 'trashName', 'status',
    ], 'recovery_failed', true)
    if (
      record.schema !== DELETE_RECEIPT_SCHEMA || !isWorldCanonicalId(record.transactionId)
      || typeof record.canonicalPayload !== 'string'
      || typeof record.payloadSha256 !== 'string' || sha256(record.canonicalPayload) !== record.payloadSha256
      || !isWorldProjectKey(record.projectKey)
      || typeof record.expectedRevision !== 'number' || !Number.isSafeInteger(record.expectedRevision) || record.expectedRevision < 0
      || typeof record.trashName !== 'string' || record.trashName !== `${record.projectKey}-${record.payloadSha256.slice(0, 16)}`
      || (record.status !== 'prepared' && record.status !== 'committed')
    ) throw new RepositoryFault('recovery_failed', true)
    let payloadValue: unknown
    try { payloadValue = JSON.parse(record.canonicalPayload) } catch { throw new RepositoryFault('recovery_failed', true) }
    const request = parseDeleteRequest(payloadValue)
    if (
      stableSerialize(request) !== record.canonicalPayload
      || request.transactionId !== record.transactionId
      || request.projectKey !== record.projectKey
      || request.expectedRevision !== record.expectedRevision
      || basename(path) !== `${sha256(request.transactionId)}.json`
    ) throw new RepositoryFault('recovery_failed', true)
    return {
      schema: DELETE_RECEIPT_SCHEMA,
      transactionId: request.transactionId,
      canonicalPayload: record.canonicalPayload,
      payloadSha256: record.payloadSha256,
      projectKey: request.projectKey,
      expectedRevision: request.expectedRevision,
      trashName: record.trashName,
      status: record.status,
    }
  } catch (error) {
    if (error instanceof RepositoryFault && error.code === 'unsafe_workspace') throw error
    throw new RepositoryFault('recovery_failed', true)
  }
}

async function pruneDeleteReceipts(directory: string, limit: number): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  if (entries.some((entry) => entry.isSymbolicLink())) throw new RepositoryFault('unsafe_workspace')
  const files = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map(async (entry) => ({
    name: entry.name,
    modified: (await stat(join(directory, entry.name))).mtimeMs,
  })))
  files.sort((left, right) => left.modified - right.modified || codeUnitCompare(left.name, right.name))
  for (const entry of files.slice(0, Math.max(0, files.length - limit))) await rm(join(directory, entry.name), { force: true })
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RepositoryFault('invalid_document')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  if (!isPlainRecord(value)) throw new RepositoryFault('invalid_document')
  return `{${Object.keys(value).sort(codeUnitCompare).map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`
}

function encodeJson(value: unknown, backupCost?: BackupCostContext, target: BackupCostTarget = 'receipt'): Buffer {
  if (!backupCost) return Buffer.from(`${stableSerialize(value)}\n`, 'utf8')
  const canonical = backupCost.measure('canonical-encode', target, () => `${stableSerialize(value)}\n`)
  return backupCost.measure('encode-buffer', target, () => Buffer.from(canonical, 'utf8'), { sourceBytes: Buffer.byteLength(canonical) })
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(codeUnitCompare)
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function backupRevision(name: string): number {
  const revision = Number(name.slice(0, name.indexOf('-')))
  if (!Number.isSafeInteger(revision) || revision < 0) throw new RepositoryFault('recovery_failed', true)
  return revision
}

function nodeErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

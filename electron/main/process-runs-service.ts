import axios from 'axios'
import { basename, extname, isAbsolute, normalize, relative, resolve as resolvePath } from 'path'
import { randomUUID } from 'crypto'
import {
  ResolveCanonicalProcessTargetError,
  resolveCanonicalProcessTarget,
  type CanonicalProcessTarget,
} from './automation-capabilities.ts'
import {
  resolveAutomationCapabilitiesContext,
  type AutomationCapabilitiesContext,
} from './automation-capabilities-service.ts'
import {
  createRunScopedProcessRunner,
  getExtPythonExe,
  type IProcessRunner,
  type ProcessInput,
  type ProcessResult,
} from './process-runner.ts'

const PROCESS_RUNS_HEALTH_URL = 'http://127.0.0.1:8765/health'
const PROCESS_RUNS_HEALTH_TIMEOUT_MS = 2_000

export const PROCESS_RUNS_MVP_ALLOWLIST = new Set([
  'mesh-optimizer/optimize',
  'mesh-exporter/export',
])

export type ProcessRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancel_requested'
  | 'canceled'

export type ProcessRunErrorCode =
  | 'INVALID_JSON'
  | 'BACKEND_NOT_READY'
  | 'PROCESS_NOT_FOUND'
  | 'PROCESS_UNSUPPORTED'
  | 'INVALID_WORKSPACE_PATH'
  | 'INVALID_OUTPUT_PATH'
  | 'RUN_NOT_FOUND'
  | 'PROCESS_EXECUTION_FAILED'

export type ProcessRunError = {
  code: ProcessRunErrorCode
  message: string
  field?: 'process_id' | 'workspace_path' | 'output_path'
  retryable?: boolean
}

export type ProcessRunOutput = {
  workspace_path: string
  output_url: string
  display_name: string
  format?: string
} | null

export type ProcessRunSnapshot = {
  run_id: string
  process_id: string
  status: ProcessRunStatus
  progress: number | null
  step: string | null
  output: ProcessRunOutput
  error: ProcessRunError | null
  cancelable: boolean
  created_at: string
  updated_at: string
  started_at: string | null
  finished_at: string | null
}

export type CreateProcessRunRequest = {
  process_id: string
  workspace_path: string
  params?: Record<string, unknown>
}

export type ProcessRunRecord = {
  snapshot: ProcessRunSnapshot
  target: CanonicalProcessTarget
  workspaceDir: string
  workspacePath: string
  outputPath: string | null
  params: Record<string, unknown>
  handle: IProcessRunner | null
  execution: Promise<void> | null
}

export type CreateProcessRunnerDeps = {
  target: CanonicalProcessTarget
  workspaceDir: string
  tempDir: string
}

export class ProcessRunServiceError extends Error {
  readonly statusCode: number
  readonly error: ProcessRunError

  constructor(statusCode: number, error: ProcessRunError) {
    super(error.message)
    this.name = 'ProcessRunServiceError'
    this.statusCode = statusCode
    this.error = error
  }
}

type ProcessRunsServiceDeps = {
  now: () => Date
  createRunId: () => string
  resolveContext: () => Promise<AutomationCapabilitiesContext>
  resolveWorkspaceDir: () => Promise<string>
  resolveTempDir: () => Promise<string>
  resolveTarget: (options: {
    processId: string
    builtinDir: string
    userExtensionsDir: string
    trustedRepos: Set<string>
  }) => Promise<CanonicalProcessTarget>
  probeBackendReadiness: () => Promise<void>
  createRunner: (options: CreateProcessRunnerDeps) => Promise<IProcessRunner>
}

const defaultProcessRunsServiceDeps: ProcessRunsServiceDeps = {
  now: () => new Date(),
  createRunId: () => randomUUID(),
  resolveContext: () => resolveAutomationCapabilitiesContext(),
  resolveWorkspaceDir: async () => {
    const { app } = await import('electron')
    const { getSettings } = await import('./settings-store.ts')
    return getSettings(app.getPath('userData')).workspaceDir
  },
  resolveTempDir: async () => {
    const { app } = await import('electron')
    return app.getPath('temp')
  },
  resolveTarget: (options) => resolveCanonicalProcessTarget(options),
  probeBackendReadiness: async () => {
    try {
      await axios.get(PROCESS_RUNS_HEALTH_URL, { timeout: PROCESS_RUNS_HEALTH_TIMEOUT_MS })
    } catch {
      throw new ProcessRunServiceError(503, {
        code: 'BACKEND_NOT_READY',
        message: 'Backend runtime is not ready; GET /health failed before process execution.',
        retryable: true,
      })
    }
  },
  createRunner: async ({ target, workspaceDir, tempDir }) => {
    if (target.entry.endsWith('.py')) {
      const { app } = await import('electron')
      const { getVenvPythonExe } = await import('./python-setup.ts')
      const pythonExe = getExtPythonExe(target.extDir) ?? getVenvPythonExe(app.getPath('userData'))

      return createRunScopedProcessRunner({
        extDir: target.extDir,
        entry: target.entry,
        workspaceDir,
        tempDir,
        pythonExe,
      })
    }

    return createRunScopedProcessRunner({
      extDir: target.extDir,
      entry: target.entry,
      workspaceDir,
      tempDir,
    })
  },
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value)
}

function assertRelativeWorkspacePath(
  value: unknown,
  field: 'workspace_path' | 'output_path',
  code: 'INVALID_WORKSPACE_PATH' | 'INVALID_OUTPUT_PATH',
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProcessRunServiceError(400, {
      code,
      field,
      message: `${field} must be a non-empty workspace-relative path.`,
      retryable: false,
    })
  }

  const normalizedInput = value.replace(/\\/g, '/')
  if (isAbsolute(normalizedInput) || isWindowsAbsolutePath(normalizedInput)) {
    throw new ProcessRunServiceError(400, {
      code,
      field,
      message: `${field} must be relative to the workspace; absolute paths are rejected.`,
      retryable: false,
    })
  }

  const normalizedPath = normalize(normalizedInput).replace(/\\/g, '/')
  if (
    normalizedPath === '.'
    || normalizedPath === '..'
    || normalizedPath.startsWith('../')
    || normalizedPath.includes('/../')
  ) {
    throw new ProcessRunServiceError(400, {
      code,
      field,
      message: `${field} must stay inside the workspace; traversal is rejected.`,
      retryable: false,
    })
  }

  return normalizedPath
}

function getOptionalOutputPath(params: Record<string, unknown>): string | null {
  if (!Object.prototype.hasOwnProperty.call(params, 'output_path')) return null
  if (typeof params.output_path === 'string' && params.output_path.trim().length === 0) return null
  return assertRelativeWorkspacePath(params.output_path, 'output_path', 'INVALID_OUTPUT_PATH')
}

function isPathOutsideWorkspace(absolutePath: string, workspaceDir: string): boolean {
  const normalizedRelative = relative(workspaceDir, absolutePath).replace(/\\/g, '/')
  return normalizedRelative === '..' || normalizedRelative.startsWith('../') || isAbsolute(normalizedRelative)
}

function toWorkspaceRelativePath(absolutePath: string, workspaceDir: string): string {
  const resolvedPath = resolvePath(absolutePath)
  const resolvedWorkspaceDir = resolvePath(workspaceDir)

  if (isPathOutsideWorkspace(resolvedPath, resolvedWorkspaceDir)) {
    throw new ProcessRunServiceError(500, {
      code: 'PROCESS_EXECUTION_FAILED',
      message: 'Process produced an output outside the workspace.',
      retryable: false,
    })
  }

  return relative(resolvedWorkspaceDir, resolvedPath).replace(/\\/g, '/')
}

function buildOutputSnapshot(result: ProcessResult, workspaceDir: string): ProcessRunOutput {
  if (!result.filePath) return null

  const workspacePath = toWorkspaceRelativePath(result.filePath, workspaceDir)
  const extension = extname(workspacePath).replace(/^\./, '') || undefined

  return {
    workspace_path: workspacePath,
    output_url: `/workspace/${workspacePath}`,
    display_name: basename(workspacePath),
    format: extension,
  }
}

function toExecutionFailure(error: unknown): ProcessRunError {
  if (error instanceof ProcessRunServiceError) {
    return error.error
  }

  return {
    code: 'PROCESS_EXECUTION_FAILED',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  }
}

function cloneSnapshot(snapshot: ProcessRunSnapshot): ProcessRunSnapshot {
  return {
    ...snapshot,
    output: snapshot.output ? { ...snapshot.output } : null,
    error: snapshot.error ? { ...snapshot.error } : null,
  }
}

function assertMeshOnlyTarget(target: CanonicalProcessTarget): void {
  if (target.node.input === 'mesh' && target.node.output === 'mesh') return

  throw new ProcessRunServiceError(400, {
    code: 'PROCESS_UNSUPPORTED',
    field: 'process_id',
    message: `Process '${target.processId}' is outside the mesh-only MVP for process-runs.`,
    retryable: false,
  })
}

function assertMvpAllowlistedProcess(processId: string): void {
  if (PROCESS_RUNS_MVP_ALLOWLIST.has(processId)) return

  throw new ProcessRunServiceError(400, {
    code: 'PROCESS_UNSUPPORTED',
    field: 'process_id',
    message: `Process '${processId}' is outside the MVP allowlist for process-runs.`,
    retryable: false,
  })
}

function toServiceError(error: unknown): ProcessRunServiceError {
  if (error instanceof ProcessRunServiceError) return error
  if (error instanceof ResolveCanonicalProcessTargetError) {
    return new ProcessRunServiceError(error.code === 'PROCESS_NOT_FOUND' ? 404 : 400, {
      code: error.code,
      field: 'process_id',
      message: error.message,
      retryable: false,
    })
  }

  throw error
}

export class ProcessRunsService {
  private readonly registry = new Map<string, ProcessRunRecord>()
  private readonly deps: ProcessRunsServiceDeps

  constructor(deps: Partial<ProcessRunsServiceDeps> = {}) {
    this.deps = {
      ...defaultProcessRunsServiceDeps,
      ...deps,
    }
  }

  private updateSnapshot(record: ProcessRunRecord, patch: Partial<ProcessRunSnapshot>): ProcessRunSnapshot {
    const updatedAt = patch.updated_at ?? this.deps.now().toISOString()

    record.snapshot = {
      ...record.snapshot,
      ...patch,
      updated_at: updatedAt,
    }

    return cloneSnapshot(record.snapshot)
  }

  private requireRun(runId: string): ProcessRunRecord {
    const record = this.registry.get(runId)
    if (record) return record

    throw new ProcessRunServiceError(404, {
      code: 'RUN_NOT_FOUND',
      message: `Process run '${runId}' was not found.`,
      retryable: false,
    })
  }

  private async executeRun(record: ProcessRunRecord): Promise<void> {
    const input: ProcessInput = {
      filePath: resolvePath(record.workspaceDir, record.workspacePath),
      nodeId: record.target.nodeId,
    }

    try {
      const result = await record.handle!.run(
        input,
        record.params,
        (percent, label) => {
          if (record.snapshot.status === 'cancel_requested' || record.snapshot.status === 'canceled') return

          this.updateSnapshot(record, {
            status: 'running',
            progress: Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null,
            step: label || record.snapshot.step,
          })
        },
      )

      if (record.snapshot.status === 'cancel_requested' || record.snapshot.status === 'canceled') {
        this.updateSnapshot(record, {
          status: 'canceled',
          progress: record.snapshot.progress,
          step: record.snapshot.step ?? 'Canceled',
          cancelable: false,
          finished_at: this.deps.now().toISOString(),
        })
        return
      }

      this.updateSnapshot(record, {
        status: 'succeeded',
        progress: 100,
        step: 'Done',
        output: buildOutputSnapshot(result, record.workspaceDir),
        error: null,
        cancelable: false,
        finished_at: this.deps.now().toISOString(),
      })
    } catch (error) {
      if (record.snapshot.status === 'cancel_requested' || record.snapshot.status === 'canceled') {
        this.updateSnapshot(record, {
          status: 'canceled',
          step: 'Canceled',
          cancelable: false,
          error: null,
          finished_at: this.deps.now().toISOString(),
        })
        return
      }

      this.updateSnapshot(record, {
        status: 'failed',
        step: 'Failed',
        error: toExecutionFailure(error),
        cancelable: false,
        finished_at: this.deps.now().toISOString(),
      })
    } finally {
      record.handle?.terminate()
      record.handle = null
      record.execution = null
    }
  }

  async createDraftRun(request: CreateProcessRunRequest): Promise<ProcessRunRecord> {
    const params = request.params ?? {}
    const workspacePath = assertRelativeWorkspacePath(
      request.workspace_path,
      'workspace_path',
      'INVALID_WORKSPACE_PATH',
    )
    const outputPath = getOptionalOutputPath(params)
    const normalizedParams = outputPath
      ? { ...params, output_path: outputPath }
      : params

    await this.deps.probeBackendReadiness()

    try {
      const context = await this.deps.resolveContext()
      const workspaceDir = await this.deps.resolveWorkspaceDir()
      const target = await this.deps.resolveTarget({
        processId: request.process_id,
        builtinDir: context.builtinDir,
        userExtensionsDir: context.userExtensionsDir,
        trustedRepos: context.trustedRepos,
      })

      assertMvpAllowlistedProcess(target.processId)
      assertMeshOnlyTarget(target)

      const nowIso = this.deps.now().toISOString()
      const runId = this.deps.createRunId()
      const record: ProcessRunRecord = {
        target,
        workspaceDir,
        workspacePath,
        outputPath,
        params: normalizedParams,
        handle: null,
        execution: null,
        snapshot: {
          run_id: runId,
          process_id: target.processId,
          status: 'queued',
          progress: 0,
          step: 'Queued',
          output: null,
          error: null,
          cancelable: true,
          created_at: nowIso,
          updated_at: nowIso,
          started_at: null,
          finished_at: null,
        },
      }

      this.registry.set(runId, record)
      return record
    } catch (error) {
      throw toServiceError(error)
    }
  }

  async createAndStartRun(request: CreateProcessRunRequest): Promise<ProcessRunSnapshot> {
    const record = await this.createDraftRun(request)
    return this.startRun(record.snapshot.run_id)
  }

  async startRun(runId: string): Promise<ProcessRunSnapshot> {
    const record = this.requireRun(runId)

    if (record.snapshot.status !== 'queued') {
      return cloneSnapshot(record.snapshot)
    }

    try {
      const tempDir = await this.deps.resolveTempDir()
      record.handle = await this.deps.createRunner({
        target: record.target,
        workspaceDir: record.workspaceDir,
        tempDir,
      })
    } catch (error) {
      return this.updateSnapshot(record, {
        status: 'failed',
        step: 'Failed',
        error: toExecutionFailure(error),
        cancelable: false,
        finished_at: this.deps.now().toISOString(),
      })
    }

    const startedAt = this.deps.now().toISOString()
    this.updateSnapshot(record, {
      status: 'running',
      progress: record.snapshot.progress ?? 0,
      step: 'Running',
      started_at: startedAt,
      cancelable: true,
    })

    record.execution = this.executeRun(record)

    return cloneSnapshot(record.snapshot)
  }

  async waitForRun(runId: string): Promise<ProcessRunSnapshot> {
    const record = this.requireRun(runId)
    await record.execution
    return cloneSnapshot(record.snapshot)
  }

  cancelRun(runId: string): ProcessRunSnapshot {
    const record = this.requireRun(runId)

    if (
      record.snapshot.status === 'succeeded'
      || record.snapshot.status === 'failed'
      || record.snapshot.status === 'canceled'
      || record.snapshot.status === 'cancel_requested'
    ) {
      return cloneSnapshot(record.snapshot)
    }

    if (record.snapshot.status === 'queued' && !record.handle) {
      return this.updateSnapshot(record, {
        status: 'canceled',
        step: 'Canceled',
        cancelable: false,
        finished_at: this.deps.now().toISOString(),
      })
    }

    const snapshot = this.updateSnapshot(record, {
      status: 'cancel_requested',
      step: 'Cancel requested',
      cancelable: false,
    })

    record.handle?.terminate()
    return snapshot
  }

  getRun(runId: string): ProcessRunSnapshot {
    const record = this.requireRun(runId)
    return cloneSnapshot(record.snapshot)
  }

  getRunSnapshot(runId: string): ProcessRunSnapshot | null {
    const snapshot = this.registry.get(runId)?.snapshot
    return snapshot ? cloneSnapshot(snapshot) : null
  }

  getRegistrySize(): number {
    return this.registry.size
  }
}

export function createProcessRunsService(deps: Partial<ProcessRunsServiceDeps> = {}): ProcessRunsService {
  return new ProcessRunsService(deps)
}

export function isProcessRunServiceError(error: unknown): error is ProcessRunServiceError {
  return error instanceof ProcessRunServiceError
}

export function validateWorkspaceRelativePath(value: unknown): string {
  return assertRelativeWorkspacePath(value, 'workspace_path', 'INVALID_WORKSPACE_PATH')
}

export function validateOutputRelativePath(value: unknown): string {
  return assertRelativeWorkspacePath(value, 'output_path', 'INVALID_OUTPUT_PATH')
}

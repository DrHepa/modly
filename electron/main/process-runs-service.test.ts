import test from 'node:test'
import assert from 'node:assert/strict'
import {
  type ProcessRunSnapshot,
  ProcessRunServiceError,
  ProcessRunsService,
} from './process-runs-service'
import {
  ResolveCanonicalProcessTargetError,
  type CanonicalProcessTarget,
} from './automation-capabilities'
import type { IProcessRunner, ProcessInput, ProcessResult } from './process-runner'
import { resolveWorkspaceOutputDir } from '../../src/areas/workflows/nodes/mesh-exporter/output-path'

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

function createTerminatingRunner() {
  const completion = createDeferred<ProcessResult>()
  let progressCallback: ((percent: number, label: string) => void) | undefined
  let terminateCalls = 0

  const runner: IProcessRunner = {
    async run(_input: ProcessInput, _params: Record<string, unknown>, onProgress) {
      progressCallback = onProgress
      onProgress?.(25, 'Loading mesh')
      return completion.promise
    },
    terminate() {
      terminateCalls += 1
      completion.reject(new Error('Process run terminated.'))
    },
  }

  return {
    runner,
    resolve: completion.resolve,
    progress: (percent: number, label: string) => progressCallback?.(percent, label),
    getTerminateCalls: () => terminateCalls,
  }
}

function createTarget(processId: string): CanonicalProcessTarget {
  const [extensionId, nodeId] = processId.split('/')

  return {
    processId,
    extensionId,
    nodeId,
    entry: 'processor.js',
    extDir: '/tmp/fake-extension',
    manifest: {
      id: extensionId,
      type: 'process',
      entry: 'processor.js',
      nodes: [{ id: nodeId, input: 'mesh', output: 'mesh' }],
    },
    extension: {
      id: extensionId,
      type: 'process',
      name: extensionId,
      trusted: true,
      builtin: true,
      entry: 'processor.js',
      nodes: [{ id: nodeId, name: nodeId, input: 'mesh', output: 'mesh', paramsSchema: [] }],
    },
    node: { id: nodeId, name: nodeId, input: 'mesh', output: 'mesh', paramsSchema: [] },
  }
}

function createService(overrides: ConstructorParameters<typeof ProcessRunsService>[0] = {}): ProcessRunsService {
  return new ProcessRunsService({
    now: () => new Date('2026-04-14T12:00:00.000Z'),
    createRunId: () => 'run-test',
    resolveContext: async () => ({
      builtinDir: '/tmp/builtin',
      userExtensionsDir: '/tmp/user',
      trustedRepos: new Set<string>(),
    }),
    resolveWorkspaceDir: async () => '/tmp/workspace',
    resolveTempDir: async () => '/tmp/runtime',
    resolveTarget: async ({ processId }) => createTarget(processId),
    probeBackendReadiness: async () => undefined,
    createRunner: async () => createTerminatingRunner().runner,
    ...overrides,
  })
}

function assertSnapshotStatus(snapshot: ProcessRunSnapshot | null, expected: ProcessRunSnapshot['status']): ProcessRunSnapshot {
  assert.ok(snapshot)
  assert.equal(snapshot.status, expected)
  return snapshot
}

test('rejects unknown canonical process ids', async () => {
  const service = createService({
    resolveTarget: async ({ processId }) => {
      throw new ResolveCanonicalProcessTargetError(
        'PROCESS_NOT_FOUND',
        processId,
        `Process '${processId}' was not found in manifest discovery.`,
      )
    },
  })

  await assert.rejects(
    () => service.createDraftRun({ process_id: 'unknown/process', workspace_path: 'meshes/input.glb' }),
    (error: unknown) => {
      assert.ok(error instanceof ProcessRunServiceError)
      assert.equal(error.statusCode, 404)
      assert.equal(error.error.code, 'PROCESS_NOT_FOUND')
      assert.equal(service.getRegistrySize(), 0)
      return true
    },
  )
})

test('rejects supported shape outside MVP allowlist', async () => {
  const service = createService()

  await assert.rejects(
    () => service.createDraftRun({ process_id: 'other-process/run', workspace_path: 'meshes/input.glb' }),
    (error: unknown) => {
      assert.ok(error instanceof ProcessRunServiceError)
      assert.equal(error.statusCode, 400)
      assert.equal(error.error.code, 'PROCESS_UNSUPPORTED')
      assert.equal(error.error.field, 'process_id')
      assert.equal(service.getRegistrySize(), 0)
      return true
    },
  )
})

test('rejects invalid workspace-relative paths before creating runs', async () => {
  const service = createService()

  await assert.rejects(
    () => service.createDraftRun({ process_id: 'mesh-optimizer/optimize', workspace_path: '../escape.glb' }),
    (error: unknown) => {
      assert.ok(error instanceof ProcessRunServiceError)
      assert.equal(error.statusCode, 400)
      assert.equal(error.error.code, 'INVALID_WORKSPACE_PATH')
      assert.equal(error.error.field, 'workspace_path')
      assert.equal(service.getRegistrySize(), 0)
      return true
    },
  )
})

test('rejects when backend health probe fails', async () => {
  const service = createService({
    probeBackendReadiness: async () => {
      throw new ProcessRunServiceError(503, {
        code: 'BACKEND_NOT_READY',
        message: 'Backend runtime is not ready; GET /health failed before process execution.',
        retryable: true,
      })
    },
  })

  await assert.rejects(
    () => service.createDraftRun({ process_id: 'mesh-optimizer/optimize', workspace_path: 'meshes/input.glb' }),
    (error: unknown) => {
      assert.ok(error instanceof ProcessRunServiceError)
      assert.equal(error.statusCode, 503)
      assert.equal(error.error.code, 'BACKEND_NOT_READY')
      assert.equal(service.getRegistrySize(), 0)
      return true
    },
  )
})

test('creates, starts, tracks progress, and completes runs with descriptive output', async () => {
  const controlledRunner = createTerminatingRunner()
  const service = createService({
    createRunner: async () => controlledRunner.runner,
  })

  const started = await service.createAndStartRun({
    process_id: 'mesh-exporter/export',
    workspace_path: 'meshes/input.glb',
    params: { export_format: 'obj', output_path: 'Exports' },
  })

  assert.equal(started.status, 'running')
  assert.equal(started.started_at, '2026-04-14T12:00:00.000Z')

  controlledRunner.progress(60, 'Exporting OBJ')
  const runningSnapshot = assertSnapshotStatus(service.getRunSnapshot('run-test'), 'running')
  assert.equal(runningSnapshot.progress, 60)
  assert.equal(runningSnapshot.step, 'Exporting OBJ')

  controlledRunner.resolve({ filePath: '/tmp/workspace/Exports/export-123.obj' })
  const finished = await service.waitForRun('run-test')

  assert.equal(finished.status, 'succeeded')
  assert.equal(finished.progress, 100)
  assert.equal(finished.step, 'Done')
  assert.deepEqual(finished.output, {
    workspace_path: 'Exports/export-123.obj',
    output_url: '/workspace/Exports/export-123.obj',
    display_name: 'export-123.obj',
    format: 'obj',
  })
  assert.equal(finished.error, null)

  const firstPoll = service.getRun('run-test')
  const secondPoll = service.getRun('run-test')
  assert.deepEqual(firstPoll, finished)
  assert.deepEqual(secondPoll, finished)
})

test('cancel is idempotent at snapshot level and converges to canceled', async () => {
  const controlledRunner = createTerminatingRunner()
  const service = createService({
    createRunner: async () => controlledRunner.runner,
  })

  await service.createAndStartRun({
    process_id: 'mesh-optimizer/optimize',
    workspace_path: 'meshes/input.glb',
  })

  const firstCancel = service.cancelRun('run-test')
  assert.equal(firstCancel.status, 'cancel_requested')
  assert.equal(firstCancel.cancelable, false)

  const secondCancel = service.cancelRun('run-test')
  assert.equal(secondCancel.status, 'cancel_requested')
  assert.equal(controlledRunner.getTerminateCalls(), 1)

  const finished = await service.waitForRun('run-test')
  assert.equal(finished.status, 'canceled')
  assert.equal(finished.step, 'Canceled')
  assert.equal(finished.cancelable, false)

  const firstPoll = service.getRun('run-test')
  const secondPoll = service.getRun('run-test')
  assert.deepEqual(firstPoll, finished)
  assert.deepEqual(secondPoll, finished)
})

test('rejects execution outputs outside the workspace', async () => {
  const controlledRunner = createTerminatingRunner()
  const service = createService({
    createRunner: async () => controlledRunner.runner,
  })

  await service.createAndStartRun({
    process_id: 'mesh-optimizer/optimize',
    workspace_path: 'meshes/input.glb',
  })

  controlledRunner.resolve({ filePath: '/tmp/outside/result.glb' })
  const finished = await service.waitForRun('run-test')

  assert.equal(finished.status, 'failed')
  assert.equal(finished.error?.code, 'PROCESS_EXECUTION_FAILED')

  const firstPoll = service.getRun('run-test')
  const secondPoll = service.getRun('run-test')
  assert.deepEqual(firstPoll, finished)
  assert.deepEqual(secondPoll, finished)
})

test('mesh exporter rejects absolute or traversing output paths before writes', () => {
  assert.throws(
    () => resolveWorkspaceOutputDir('/tmp/workspace', '/tmp/outside'),
    /absolute paths are rejected/,
  )

  assert.throws(
    () => resolveWorkspaceOutputDir('/tmp/workspace', '../escape'),
    /traversal is rejected/,
  )

  assert.equal(
    resolveWorkspaceOutputDir('/tmp/workspace', 'Exports/nested'),
    '/tmp/workspace/Exports/nested',
  )
})

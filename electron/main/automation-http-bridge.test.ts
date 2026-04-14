import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  AUTOMATION_HTTP_BRIDGE_PATH,
  AutomationHttpBridge,
  PROCESS_RUNS_HTTP_BRIDGE_PATH,
} from './automation-http-bridge'
import { ResolveCanonicalProcessTargetError, type CanonicalProcessTarget } from './automation-capabilities'
import { ProcessRunsService, type ProcessRunSnapshot } from './process-runs-service'
import type { IProcessRunner, ProcessInput, ProcessResult } from './process-runner'

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

  const runner: IProcessRunner = {
    async run(_input: ProcessInput, _params: Record<string, unknown>, onProgress) {
      onProgress?.(25, 'Loading mesh')
      return completion.promise
    },
    terminate() {
      completion.reject(new Error('Process run terminated.'))
    },
  }

  return {
    runner,
    resolve: completion.resolve,
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

function createService(controlledRunner: ReturnType<typeof createTerminatingRunner>): ProcessRunsService {
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
    resolveTarget: async ({ processId }) => {
      if (processId === 'unknown/process') {
        throw new ResolveCanonicalProcessTargetError(
          'PROCESS_NOT_FOUND',
          processId,
          `Process '${processId}' was not found in manifest discovery.`,
        )
      }

      return createTarget(processId)
    },
    probeBackendReadiness: async () => undefined,
    createRunner: async () => controlledRunner.runner,
  })
}

async function waitForRunStatus(
  origin: string,
  runId: string,
  expectedStatus: ProcessRunSnapshot['status'],
): Promise<ProcessRunSnapshot> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${origin}${PROCESS_RUNS_HTTP_BRIDGE_PATH}/${runId}`)
    const payload = await response.json() as { run: ProcessRunSnapshot }
    if (payload.run.status === expectedStatus) return payload.run
    await delay(10)
  }

  throw new Error(`Run '${runId}' did not reach status '${expectedStatus}'.`)
}

test('serves localhost process-runs create/get/cancel and factual errors', async (t) => {
  const controlledRunner = createTerminatingRunner()
  const service = createService(controlledRunner)
  const bridge = new AutomationHttpBridge({
    host: '127.0.0.1',
    port: 0,
    getAutomationCapabilities: async () => ({
      backend_ready: true,
      models: [],
      processes: [],
      excluded: { ui_only_nodes: [] },
    }),
    createProcessRun: (request) => service.createAndStartRun(request),
    getProcessRun: (runId) => service.getRun(runId),
    cancelProcessRun: (runId) => service.cancelRun(runId),
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  })

  await bridge.start()
  t.after(async () => {
    await bridge.stop()
  })

  const origin = bridge.getOrigin()
  assert.ok(origin)

  const capabilitiesResponse = await fetch(`${origin}${AUTOMATION_HTTP_BRIDGE_PATH}`)
  assert.equal(capabilitiesResponse.status, 200)

  const createResponse = await fetch(`${origin}${PROCESS_RUNS_HTTP_BRIDGE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      process_id: 'mesh-optimizer/optimize',
      workspace_path: 'meshes/input.glb',
    }),
  })
  assert.equal(createResponse.status, 201)
  const created = await createResponse.json() as { run_id: string; run: ProcessRunSnapshot }
  assert.equal(created.run_id, 'run-test')
  assert.equal(created.run.status, 'running')

  const pollResponse = await fetch(`${origin}${PROCESS_RUNS_HTTP_BRIDGE_PATH}/run-test`)
  assert.equal(pollResponse.status, 200)
  const polled = await pollResponse.json() as { run: ProcessRunSnapshot }
  assert.equal(polled.run.status, 'running')
  assert.equal(polled.run.progress, 25)

  const cancelResponse = await fetch(`${origin}${PROCESS_RUNS_HTTP_BRIDGE_PATH}/run-test/cancel`, {
    method: 'POST',
  })
  assert.equal(cancelResponse.status, 200)
  const canceled = await cancelResponse.json() as { run: ProcessRunSnapshot }
  assert.match(canceled.run.status, /cancel_requested|canceled/)

  const repeatCancelResponse = await fetch(`${origin}${PROCESS_RUNS_HTTP_BRIDGE_PATH}/run-test/cancel`, {
    method: 'POST',
  })
  assert.equal(repeatCancelResponse.status, 200)

  const finalSnapshot = await waitForRunStatus(origin, 'run-test', 'canceled')
  assert.equal(finalSnapshot.cancelable, false)

  const unsupportedResponse = await fetch(`${origin}${PROCESS_RUNS_HTTP_BRIDGE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      process_id: 'other-process/run',
      workspace_path: 'meshes/input.glb',
    }),
  })
  assert.equal(unsupportedResponse.status, 400)
  assert.deepEqual(await unsupportedResponse.json(), {
    error: {
      code: 'PROCESS_UNSUPPORTED',
      field: 'process_id',
      message: "Process 'other-process/run' is outside the MVP allowlist for process-runs.",
      retryable: false,
    },
  })

  const invalidPathResponse = await fetch(`${origin}${PROCESS_RUNS_HTTP_BRIDGE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      process_id: 'mesh-optimizer/optimize',
      workspace_path: '../escape.glb',
    }),
  })
  assert.equal(invalidPathResponse.status, 400)
  assert.deepEqual(await invalidPathResponse.json(), {
    error: {
      code: 'INVALID_WORKSPACE_PATH',
      field: 'workspace_path',
      message: 'workspace_path must stay inside the workspace; traversal is rejected.',
      retryable: false,
    },
  })

  const unknownProcessResponse = await fetch(`${origin}${PROCESS_RUNS_HTTP_BRIDGE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      process_id: 'unknown/process',
      workspace_path: 'meshes/input.glb',
    }),
  })
  assert.equal(unknownProcessResponse.status, 404)
  assert.deepEqual(await unknownProcessResponse.json(), {
    error: {
      code: 'PROCESS_NOT_FOUND',
      field: 'process_id',
      message: "Process 'unknown/process' was not found in manifest discovery.",
      retryable: false,
    },
  })

  const missingRunResponse = await fetch(`${origin}${PROCESS_RUNS_HTTP_BRIDGE_PATH}/missing-run`)
  assert.equal(missingRunResponse.status, 404)
  assert.deepEqual(await missingRunResponse.json(), {
    error: {
      code: 'RUN_NOT_FOUND',
      message: "Process run 'missing-run' was not found.",
      retryable: false,
    },
  })
})

test('serves mesh-exporter success, stable terminal polls, and invalid output_path rejection', async (t) => {
  const controlledRunner = createTerminatingRunner()
  const service = createService(controlledRunner)
  const bridge = new AutomationHttpBridge({
    host: '127.0.0.1',
    port: 0,
    getAutomationCapabilities: async () => ({
      backend_ready: true,
      models: [],
      processes: [],
      excluded: { ui_only_nodes: [] },
    }),
    createProcessRun: (request) => service.createAndStartRun(request),
    getProcessRun: (runId) => service.getRun(runId),
    cancelProcessRun: (runId) => service.cancelRun(runId),
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  })

  await bridge.start()
  t.after(async () => {
    await bridge.stop()
  })

  const origin = bridge.getOrigin()
  assert.ok(origin)

  const invalidOutputPathResponse = await fetch(`${origin}${PROCESS_RUNS_HTTP_BRIDGE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      process_id: 'mesh-exporter/export',
      workspace_path: 'meshes/input.glb',
      params: {
        export_format: 'obj',
        output_path: '../escape',
      },
    }),
  })
  assert.equal(invalidOutputPathResponse.status, 400)
  assert.deepEqual(await invalidOutputPathResponse.json(), {
    error: {
      code: 'INVALID_OUTPUT_PATH',
      field: 'output_path',
      message: 'output_path must stay inside the workspace; traversal is rejected.',
      retryable: false,
    },
  })

  const createResponse = await fetch(`${origin}${PROCESS_RUNS_HTTP_BRIDGE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      process_id: 'mesh-exporter/export',
      workspace_path: 'meshes/input.glb',
      params: {
        export_format: 'obj',
        output_path: 'Exports',
      },
    }),
  })
  assert.equal(createResponse.status, 201)
  const created = await createResponse.json() as { run_id: string; run: ProcessRunSnapshot }
  assert.equal(created.run.status, 'running')

  controlledRunner.resolve({ filePath: '/tmp/workspace/Exports/export-123.obj' })
  const finished = await waitForRunStatus(origin, created.run_id, 'succeeded')
  assert.deepEqual(finished.output, {
    workspace_path: 'Exports/export-123.obj',
    output_url: '/workspace/Exports/export-123.obj',
    display_name: 'export-123.obj',
    format: 'obj',
  })

  const stablePollResponse = await fetch(`${origin}${PROCESS_RUNS_HTTP_BRIDGE_PATH}/${created.run_id}`)
  assert.equal(stablePollResponse.status, 200)
  const stablePoll = await stablePollResponse.json() as { run: ProcessRunSnapshot }
  assert.deepEqual(stablePoll.run, finished)
})

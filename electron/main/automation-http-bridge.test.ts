import { createServer, type IncomingMessage, type ServerResponse, type RequestListener } from 'node:http'
import { Readable } from 'node:stream'
import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  AUTOMATION_HTTP_BRIDGE_PATH,
  AutomationHttpBridge,
  PROCESS_RUNS_HTTP_BRIDGE_PATH,
  SCENE_IMPORT_MESH_HTTP_BRIDGE_PATH,
} from './automation-http-bridge.ts'
import { ResolveCanonicalProcessTargetError, type CanonicalProcessTarget } from './automation-capabilities.ts'
import { ProcessRunsService, type ProcessRunSnapshot } from './process-runs-service.ts'
import type { IProcessRunner, ProcessInput, ProcessResult } from './process-runner.ts'
import { projectWorldAiQuery } from '../../src/areas/worlds/core/worldAiContract.ts'
import { createValidWorldSnapshot } from '../../src/areas/worlds/core/_testFixtures.ts'

type InMemoryBridgeResponse = {
  status: number
  statusCode: number
  headersSent: boolean
  writeHeadCalls: number
  endCalls: number
  headers: { get: (name: string) => string | null }
  json: () => Promise<unknown>
}

type InMemoryBridgeRequestInit = {
  method?: string
  headers?: Record<string, string>
  body?: string
  source?: Readable
}

function createInMemoryHttpBridgeHarness() {
  let handler: RequestListener | null = null
  const createInMemoryServer = ((listener: RequestListener) => {
    handler = listener
    const server = createServer(listener)
    server.listen = ((_port: number, _host: string, ready: () => void) => {
      queueMicrotask(ready)
      return server
    }) as typeof server.listen
    server.close = ((done: (error?: Error) => void) => {
      done()
      return server
    }) as typeof server.close
    server.address = (() => ({ address: '127.0.0.1', family: 'IPv4', port: 0 })) as typeof server.address
    return server
  }) as typeof createServer
  const request = (url: string, init: InMemoryBridgeRequestInit = {}) => new Promise<InMemoryBridgeResponse>((resolve) => {
    assert.ok(handler)
    const responseHeaders = new Map<string, string>()
    let responseBody = ''
    let resolved = false
    const result: InMemoryBridgeResponse = {
      status: 200,
      statusCode: 200,
      headersSent: false,
      writeHeadCalls: 0,
      endCalls: 0,
      headers: { get: (name: string) => responseHeaders.get(name.toLowerCase()) ?? null },
      json: async () => JSON.parse(responseBody),
    }
    const source = init.source ?? Readable.from([Buffer.from(init.body ?? '')])
    const request = Object.assign(source, {
      method: init.method ?? 'GET',
      url,
      headers: init.headers ?? {},
    })
    const response = {
      statusCode: 200,
      headersSent: false,
      setHeader(name: string, value: string) {
        responseHeaders.set(name.toLowerCase(), value)
      },
      writeHead(code: number, headers?: Record<string, string>) {
        response.statusCode = code
        response.headersSent = true
        result.status = code
        result.statusCode = code
        result.headersSent = true
        result.writeHeadCalls += 1
        for (const [name, value] of Object.entries(headers ?? {})) {
          responseHeaders.set(name.toLowerCase(), value)
        }
        return response
      },
      end(data = '') {
        response.headersSent = true
        result.status = response.statusCode
        result.statusCode = response.statusCode
        result.headersSent = true
        result.endCalls += 1
        responseBody = String(data)
        if (!resolved) {
          resolved = true
          resolve(result)
        }
      },
    }
    handler(request as IncomingMessage, response as unknown as ServerResponse)
  })

  return { createServer: createInMemoryServer, request }
}

function createDeferredIncompleteJsonStream() {
  let sent = false
  let markRead!: () => void
  const readStarted = new Promise<void>((resolve) => { markRead = resolve })
  const events: string[] = []
  const stream = new Readable({
    read() {
      if (sent) return
      sent = true
      events.push('chunk')
      this.push(Buffer.from('{"meshPath":'))
      markRead()
    },
  })

  return {
    stream,
    events,
    readStarted,
    abortWithoutEof() {
      events.push('aborted')
      stream.emit('aborted')
    },
    endWithoutAbort() {
      events.push('eof')
      stream.push(null)
    },
  }
}

test('in-memory bridge harness mirrors Node response defaults without writeHead', async () => {
  const harness = createInMemoryHttpBridgeHarness()
  const server = harness.createServer((_request, response) => {
    response.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })

  const response = await harness.request('/no-write-head')
  assert.equal(response.status, 200)
  assert.equal(response.statusCode, 200)
  assert.equal(response.headersSent, true)
  assert.equal(response.writeHeadCalls, 0)
  assert.equal(response.endCalls, 1)
  assert.deepEqual(await response.json(), { ok: true })
})

test('Worlds query HTTP handler uses bounded in-memory streams without a listening socket', async (t) => {
  let queries = 0
  let failure: 'returned' | 'thrown' | null = null
  const snapshot = createValidWorldSnapshot()
  let handler: RequestListener
  const createInMemoryServer = ((listener: RequestListener) => {
    handler = listener
    const server = createServer(listener)
    server.listen = ((_port: number, _host: string, ready: () => void) => { queueMicrotask(ready); return server }) as typeof server.listen
    server.close = ((done: (error?: Error) => void) => { done(); return server }) as typeof server.close
    return server
  }) as typeof createServer
  const bridge = new AutomationHttpBridge({ createServer: createInMemoryServer, host: '127.0.0.1', port: 0, queryWorld: async (request) => {
    queries++
    if (failure === 'returned') return { ok: false, error: { code: 'project_busy', message: 'Unable to read /home/private/world/project.json', retryable: true } }
    if (failure === 'thrown') throw new Error('Read failed at /home/private/world/project.json')
    return { ok: true, value: projectWorldAiQuery(snapshot, request) }
  }, logger: { info() {}, warn() {}, error() {} } })
  await bridge.start()
  t.after(() => bridge.stop())
  const context = { schema: 'modly.world-ai-context.v1', projectKey: `world-${'a'.repeat(32)}`, projectId: 'project:demo',
    baseRevision: 4, activeSceneId: 'scene:one', editorEpoch: 1, originSessionId: 'session-a', requestId: 'tx:query-http' }
  const invoke = (body: string, method = 'POST', source?: Readable) => new Promise<{ status: number; json(): Promise<{ value: ReturnType<typeof projectWorldAiQuery> }> }>((resolve) => {
    let status = 0
    const request = Object.assign(source ?? Readable.from([Buffer.from(body)]), { method, url: '/automation/worlds/query', headers: {} })
    const response = { setHeader() {}, writeHead(code: number) { status = code }, end(data: string) { resolve({ status, json: async () => JSON.parse(data) }) } }
    handler(request as IncomingMessage, response as unknown as ServerResponse)
  })
  const post = (body: string) => invoke(body)
  const first = await post(JSON.stringify({ context, query: { kind: 'scenes', pageSize: 1 } }))
  assert.equal(first.status, 200)
  const body = await first.json()
  assert.equal(body.value.items[0].id, 'scene:one')
  const second = await post(JSON.stringify({ context, query: { kind: 'scenes', pageSize: 1, cursor: body.value.nextCursor } }))
  assert.equal((await second.json()).value.items[0].id, 'scene:two')
  assert.equal(queries, 2)
  assert.equal((await post(JSON.stringify({ context, query: { kind: 'project' }, apply: true }))).status, 400)
  assert.equal((await post(' '.repeat(8193))).status, 413)
  assert.equal((await invoke('', 'DELETE')).status, 405)
  assert.equal(queries, 2)
  const aborted = new Readable({ read() {} })
  const abortedResponse = invoke('', 'POST', aborted)
  aborted.emit('aborted')
  assert.doesNotThrow(() => aborted.emit('error', new Error('Connection reset at /home/private')))
  assert.equal((await abortedResponse).status, 400)
  for (const kind of ['returned', 'thrown'] as const) {
    failure = kind
    const rejected = await post(JSON.stringify({ context, query: { kind: 'project' } }))
    assert.notEqual(rejected.status, 200)
    assert.doesNotMatch(JSON.stringify(await rejected.json()), /home|private|project\.json/)
  }
})

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

function createCapabilitiesPayload() {
  return {
    backend_ready: true,
    models: [],
    processes: [],
    scene: {
      import_mesh: {
        supported: true as const,
        route: SCENE_IMPORT_MESH_HTTP_BRIDGE_PATH as '/scene/import-mesh',
        allowed_extensions: ['.glb', '.obj', '.stl', '.ply'],
        extensions: ['.glb', '.obj', '.stl', '.ply'],
      },
    },
    excluded: { ui_only_nodes: [] },
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
  request: (url: string) => Promise<InMemoryBridgeResponse>,
  runId: string,
  expectedStatus: ProcessRunSnapshot['status'],
): Promise<ProcessRunSnapshot> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await request(`${PROCESS_RUNS_HTTP_BRIDGE_PATH}/${runId}`)
    const payload = await response.json() as { run: ProcessRunSnapshot }
    if (payload.run.status === expectedStatus) return payload.run
    await delay(10)
  }

  throw new Error(`Run '${runId}' did not reach status '${expectedStatus}'.`)
}

test('serves localhost process-runs create/get/cancel and factual errors', async (t) => {
  const controlledRunner = createTerminatingRunner()
  const service = createService(controlledRunner)
  const harness = createInMemoryHttpBridgeHarness()
  const bridge = new AutomationHttpBridge({
    createServer: harness.createServer,
    host: '127.0.0.1',
    port: 0,
    getAutomationCapabilities: async () => createCapabilitiesPayload(),
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

  const capabilitiesResponse = await harness.request(AUTOMATION_HTTP_BRIDGE_PATH)
  assert.equal(capabilitiesResponse.status, 200)

  const createResponse = await harness.request(PROCESS_RUNS_HTTP_BRIDGE_PATH, {
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

  const pollResponse = await harness.request(`${PROCESS_RUNS_HTTP_BRIDGE_PATH}/run-test`)
  assert.equal(pollResponse.status, 200)
  const polled = await pollResponse.json() as { run: ProcessRunSnapshot }
  assert.equal(polled.run.status, 'running')
  assert.equal(polled.run.progress, 25)

  const cancelResponse = await harness.request(`${PROCESS_RUNS_HTTP_BRIDGE_PATH}/run-test/cancel`, {
    method: 'POST',
  })
  assert.equal(cancelResponse.status, 200)
  const canceled = await cancelResponse.json() as { run: ProcessRunSnapshot }
  assert.match(canceled.run.status, /cancel_requested|canceled/)

  const repeatCancelResponse = await harness.request(`${PROCESS_RUNS_HTTP_BRIDGE_PATH}/run-test/cancel`, {
    method: 'POST',
  })
  assert.equal(repeatCancelResponse.status, 200)

  const finalSnapshot = await waitForRunStatus(harness.request, 'run-test', 'canceled')
  assert.equal(finalSnapshot.cancelable, false)

  const unsupportedResponse = await harness.request(PROCESS_RUNS_HTTP_BRIDGE_PATH, {
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

  const invalidPathResponse = await harness.request(PROCESS_RUNS_HTTP_BRIDGE_PATH, {
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

  const unknownProcessResponse = await harness.request(PROCESS_RUNS_HTTP_BRIDGE_PATH, {
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

  const missingRunResponse = await harness.request(`${PROCESS_RUNS_HTTP_BRIDGE_PATH}/missing-run`)
  assert.equal(missingRunResponse.status, 404)
  assert.deepEqual(await missingRunResponse.json(), {
    error: {
      code: 'RUN_NOT_FOUND',
      message: "Process run 'missing-run' was not found.",
      retryable: false,
    },
  })
})

test('serves scene import mesh route with JSON result and validation errors', async (t) => {
  const harness = createInMemoryHttpBridgeHarness()
  const bridge = new AutomationHttpBridge({
    createServer: harness.createServer,
    host: '127.0.0.1',
    port: 0,
    getAutomationCapabilities: async () => createCapabilitiesPayload(),
    importSceneMesh: async ({ meshPath }) => {
      if (meshPath === '../escape.glb') {
        return {
          ok: false,
          statusCode: 400,
          error: {
            code: 'INVALID_WORKSPACE_PATH',
            field: 'meshPath',
            message: 'meshPath must stay inside the workspace; traversal is rejected.',
            retryable: false,
          },
        }
      }

      return {
        ok: true,
        statusCode: 200,
        result: {
          meshPath,
          url: `/workspace/${meshPath}`,
          displayName: 'imported.glb',
        },
      }
    },
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

  const success = await harness.request(SCENE_IMPORT_MESH_HTTP_BRIDGE_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mesh_path: 'Default/imported.glb' }),
  })
  assert.equal(success.status, 200)
  assert.deepEqual(await success.json(), {
    meshPath: 'Default/imported.glb',
    url: '/workspace/Default/imported.glb',
    displayName: 'imported.glb',
  })

  const invalid = await harness.request(SCENE_IMPORT_MESH_HTTP_BRIDGE_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meshPath: '../escape.glb' }),
  })
  assert.equal(invalid.status, 400)
  assert.deepEqual(await invalid.json(), {
    error: {
      code: 'INVALID_WORKSPACE_PATH',
      field: 'meshPath',
      message: 'meshPath must stay inside the workspace; traversal is rejected.',
      retryable: false,
    },
  })

  const wrongMethod = await harness.request(SCENE_IMPORT_MESH_HTTP_BRIDGE_PATH)
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.get('allow'), 'POST')

  const pendingIncomplete = createDeferredIncompleteJsonStream()
  const pendingResponse = harness.request(SCENE_IMPORT_MESH_HTTP_BRIDGE_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    source: pendingIncomplete.stream,
  })
  await pendingIncomplete.readStarted
  assert.equal(
    await Promise.race([
      pendingResponse.then(() => 'settled'),
      delay(25).then(() => 'pending'),
    ]),
    'pending',
  )
  pendingIncomplete.endWithoutAbort()
  await pendingResponse

  const abortedIncomplete = createDeferredIncompleteJsonStream()
  const abortedResponsePromise = harness.request(SCENE_IMPORT_MESH_HTTP_BRIDGE_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    source: abortedIncomplete.stream,
  })
  await abortedIncomplete.readStarted
  abortedIncomplete.abortWithoutEof()
  const abortedIncompleteResponse = await abortedResponsePromise
  assert.deepEqual(abortedIncomplete.events, ['chunk', 'aborted'])
  assert.equal(abortedIncomplete.stream.destroyed, true)
  assert.equal(abortedIncompleteResponse.status, 400)
  assert.deepEqual(await abortedIncompleteResponse.json(), {
    error: {
      code: 'INVALID_JSON',
      message: 'Request body must be valid JSON.',
      retryable: false,
    },
  })
  await delay(0)
  assert.equal(abortedIncompleteResponse.headersSent, true)
  assert.equal(abortedIncompleteResponse.writeHeadCalls, 1)
  assert.equal(abortedIncompleteResponse.endCalls, 1)
})

test('serves mesh-exporter success, stable terminal polls, and invalid output_path rejection', async (t) => {
  const controlledRunner = createTerminatingRunner()
  const service = createService(controlledRunner)
  const harness = createInMemoryHttpBridgeHarness()
  const bridge = new AutomationHttpBridge({
    createServer: harness.createServer,
    host: '127.0.0.1',
    port: 0,
    getAutomationCapabilities: async () => createCapabilitiesPayload(),
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

  const invalidOutputPathResponse = await harness.request(PROCESS_RUNS_HTTP_BRIDGE_PATH, {
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

  const createResponse = await harness.request(PROCESS_RUNS_HTTP_BRIDGE_PATH, {
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
  const finished = await waitForRunStatus(harness.request, created.run_id, 'succeeded')
  assert.deepEqual(finished.output, {
    workspace_path: 'Exports/export-123.obj',
    output_url: '/workspace/Exports/export-123.obj',
    display_name: 'export-123.obj',
    format: 'obj',
  })

  const stablePollResponse = await harness.request(`${PROCESS_RUNS_HTTP_BRIDGE_PATH}/${created.run_id}`)
  assert.equal(stablePollResponse.status, 200)
  const stablePoll = await stablePollResponse.json() as { run: ProcessRunSnapshot }
  assert.deepEqual(stablePoll.run, finished)
})

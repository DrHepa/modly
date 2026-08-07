import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  acquireAgentModelAccessGateway,
  AGENT_MODEL_ACCESS_SANDBOX_SOCKET,
} from './agent-model-access-gateway.ts'

function unixRequest(input: {
  socketPath: string
  token?: string
  path?: string
  body: string
  timeoutMs?: number
}): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      socketPath: input.socketPath,
      method: 'POST',
      path: input.path ?? '/v1/responses',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(input.body),
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      },
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })
    request.on('error', reject)
    if (input.timeoutMs !== undefined) {
      request.setTimeout(input.timeoutMs, () => request.destroy(new Error('client_timeout')))
    }
    request.end(input.body)
  })
}

test('gateway exposes one authenticated bounded Responses request through a private Unix socket', async (t) => {
  if (process.platform !== 'linux') return t.skip('pathname AF_UNIX permissions are Linux-specific')
  const root = await mkdtemp(join(tmpdir(), 'modly-model-gateway-test-'))
  const forwarded: unknown[] = []
  const lease = await acquireAgentModelAccessGateway({
    root,
    actionId: 'action-1',
    proposalHash: 'a'.repeat(64),
    capabilityHash: 'b'.repeat(64),
    digest: `sha256:${'c'.repeat(64)}`,
    approvedModelName: 'qwen3.6:27b',
    declaration: { schema: 'modly.agent-model-access.v1', profile: 'ollama-responses-json-v1' },
    privateModelAlias: 'modly-private-action-1',
    signal: new AbortController().signal,
    forward: async (body) => {
      forwarded.push(body)
      return {
        id: 'response-1', object: 'response', model: 'modly-private-action-1',
        output: [{ type: 'message', content: 'served by modly-private-action-1' }],
        metadata: { 'modly-private-action-1': 'modly-private-action-1' },
      }
    },
  })
  try {
    assert.equal(lease.schema, 'modly.agent-model-execution-lease.v1')
    assert.equal(lease.assurance, 'pinned-local-cooperative-host')
    assert.equal(lease.socketPath, AGENT_MODEL_ACCESS_SANDBOX_SOCKET)
    assert.deepEqual(lease.limits, {
      maxRequests: 1,
      maxRequestBytes: 1024 * 1024,
      maxResponseBytes: 4 * 1024 * 1024,
      idleMs: 30_000,
      leaseMs: 270_000,
      requestMs: 210_000,
      minimumRequestMs: 5_000,
      cleanupMs: 10_000,
    })
    assert.equal(Object.hasOwn(lease.limits, 'totalMs'), false)
    assert.equal((await stat(lease.directoryPath)).mode & 0o777, 0o700)
    assert.equal((await stat(lease.hostSocketPath)).mode & 0o777, 0o600)

    const missingAuth = await unixRequest({ socketPath: lease.hostSocketPath, body: '{}' })
    assert.equal(missingAuth.status, 401)

    const accepted = await unixRequest({
      socketPath: lease.hostSocketPath,
      token: lease.bearerToken,
      body: JSON.stringify({ model: 'approved', input: 'make a chair', stream: false, store: false }),
    })
    assert.equal(accepted.status, 200)
    assert.deepEqual(JSON.parse(accepted.body), {
      id: 'response-1', object: 'response', model: 'approved',
      output: [{ type: 'message', content: 'served by approved' }],
      metadata: { approved: 'approved' },
    })
    assert.equal(accepted.body.includes('modly-private-action-1'), false)
    assert.deepEqual(forwarded, [{ model: 'modly-private-action-1', input: 'make a chair', stream: false, store: false }])

    const replay = await unixRequest({
      socketPath: lease.hostSocketPath,
      token: lease.bearerToken,
      body: JSON.stringify({ model: 'approved', input: 'replay' }),
    })
    assert.equal(replay.status, 409)
    await lease.revalidate()
  } finally {
    await lease.close()
    await lease.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('gateway rejects unsupported Responses modes without forwarding and closes on action abort', async (t) => {
  if (process.platform !== 'linux') return t.skip('pathname AF_UNIX permissions are Linux-specific')
  const root = await mkdtemp(join(tmpdir(), 'modly-model-gateway-policy-test-'))
  const controller = new AbortController()
  let calls = 0
  const lease = await acquireAgentModelAccessGateway({
    root,
    actionId: 'action-2',
    proposalHash: 'd'.repeat(64),
    capabilityHash: 'e'.repeat(64),
    digest: `sha256:${'f'.repeat(64)}`,
    approvedModelName: 'qwen3.6:27b',
    declaration: { schema: 'modly.agent-model-access.v1', profile: 'ollama-responses-json-v1' },
    privateModelAlias: 'modly-private-action-2',
    signal: controller.signal,
    forward: async () => { calls += 1; return {} },
  })
  try {
    const rejected = await unixRequest({
      socketPath: lease.hostSocketPath,
      token: lease.bearerToken,
      body: JSON.stringify({ model: 'approved', input: 'unsafe', conversation: 'conv_1' }),
    })
    assert.equal(rejected.status, 400)
    assert.equal(calls, 0)
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await assert.rejects(stat(lease.hostSocketPath))
  } finally {
    await lease.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('gateway body idle timeout does not truncate a slower bounded inference response', async (t) => {
  if (process.platform !== 'linux') return t.skip('pathname AF_UNIX permissions are Linux-specific')
  const root = await mkdtemp(join(tmpdir(), 'modly-model-gateway-slow-test-'))
  const lease = await acquireAgentModelAccessGateway({
    root,
    actionId: 'action-slow',
    proposalHash: '1'.repeat(64),
    capabilityHash: '2'.repeat(64),
    digest: `sha256:${'3'.repeat(64)}`,
    approvedModelName: 'qwen3.6:27b',
    declaration: { schema: 'modly.agent-model-access.v1', profile: 'ollama-responses-json-v1' },
    privateModelAlias: 'modly-private-slow',
    signal: new AbortController().signal,
    limits: { idleMs: 10, leaseMs: 1_000, requestMs: 500, minimumRequestMs: 10, cleanupMs: 50 },
    forward: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return { model: 'modly-private-slow', output_text: 'ok' }
    },
  })
  try {
    const response = await unixRequest({
      socketPath: lease.hostSocketPath,
      token: lease.bearerToken,
      body: JSON.stringify({ model: 'approved', input: 'chair' }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(JSON.parse(response.body), { model: 'approved', output_text: 'ok' })
  } finally {
    await lease.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('gateway reserves a bounded active request budget after scaled sandbox preparation overhead', async (t) => {
  if (process.platform !== 'linux') return t.skip('pathname AF_UNIX permissions are Linux-specific')
  const root = await mkdtemp(join(tmpdir(), 'modly-model-gateway-budget-test-'))
  let clock = Date.now()
  const lease = await acquireAgentModelAccessGateway({
    root,
    actionId: 'action-budget',
    proposalHash: '4'.repeat(64),
    capabilityHash: '5'.repeat(64),
    digest: `sha256:${'6'.repeat(64)}`,
    approvedModelName: 'qwen3.6:27b',
    declaration: { schema: 'modly.agent-model-access.v1', profile: 'ollama-responses-json-v1' },
    privateModelAlias: 'modly-private-budget',
    signal: new AbortController().signal,
    limits: { idleMs: 10, leaseMs: 270, requestMs: 210, minimumRequestMs: 5, cleanupMs: 10 },
    now: () => new Date(clock),
    forward: async () => {
      await new Promise((resolve) => setTimeout(resolve, 160))
      return { model: 'modly-private-budget', output_text: 'ok' }
    },
  })
  try {
    assert.equal(Date.parse(lease.expiresAt) - clock, 270)
    clock += 32
    const response = await unixRequest({
      socketPath: lease.hostSocketPath,
      token: lease.bearerToken,
      body: JSON.stringify({ model: 'approved', input: 'scaled 32s setup and 160s response' }),
      timeoutMs: 500,
    })
    assert.equal(response.status, 200)
    assert.deepEqual(JSON.parse(response.body), { model: 'approved', output_text: 'ok' })
  } finally {
    await lease.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('gateway rejects a request that starts without its minimum remaining lease budget', async (t) => {
  if (process.platform !== 'linux') return t.skip('pathname AF_UNIX permissions are Linux-specific')
  const root = await mkdtemp(join(tmpdir(), 'modly-model-gateway-margin-test-'))
  let forwards = 0
  let clock = 1_000
  const lease = await acquireAgentModelAccessGateway({
    root,
    actionId: 'action-margin',
    proposalHash: '7'.repeat(64),
    capabilityHash: '8'.repeat(64),
    digest: `sha256:${'9'.repeat(64)}`,
    approvedModelName: 'qwen3.6:27b',
    declaration: { schema: 'modly.agent-model-access.v1', profile: 'ollama-responses-json-v1' },
    privateModelAlias: 'modly-private-margin',
    signal: new AbortController().signal,
    limits: { idleMs: 10, leaseMs: 80, requestMs: 50, minimumRequestMs: 20, cleanupMs: 10 },
    now: () => new Date(clock),
    forward: async () => { forwards += 1; return {} },
  })
  try {
    clock += 60
    const response = await unixRequest({
      socketPath: lease.hostSocketPath,
      token: lease.bearerToken,
      body: JSON.stringify({ model: 'approved', input: 'too late' }),
      timeoutMs: 250,
    })
    assert.equal(response.status, 504)
    assert.deepEqual(JSON.parse(response.body), { error: { code: 'insufficient_lease_time' } })
    assert.equal(forwards, 0)
  } finally {
    await lease.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('lease expiry during an active forward returns one structured timeout before teardown', async (t) => {
  if (process.platform !== 'linux') return t.skip('pathname AF_UNIX permissions are Linux-specific')
  const root = await mkdtemp(join(tmpdir(), 'modly-model-gateway-expiry-test-'))
  let clock = 1_000
  let aborts = 0
  const lease = await acquireAgentModelAccessGateway({
    root,
    actionId: 'action-expiry',
    proposalHash: 'a'.repeat(64),
    capabilityHash: 'b'.repeat(64),
    digest: `sha256:${'c'.repeat(64)}`,
    approvedModelName: 'qwen3.6:27b',
    declaration: { schema: 'modly.agent-model-access.v1', profile: 'ollama-responses-json-v1' },
    privateModelAlias: 'modly-private-expiry',
    signal: new AbortController().signal,
    limits: { idleMs: 10, leaseMs: 50, requestMs: 100, minimumRequestMs: 5, cleanupMs: 1 },
    now: () => new Date(clock),
    forward: async (_body, signal) => new Promise<never>(() => {
      signal.addEventListener('abort', () => { aborts += 1 }, { once: true })
    }),
  })
  try {
    clock = 900
    const response = await unixRequest({
      socketPath: lease.hostSocketPath,
      token: lease.bearerToken,
      body: JSON.stringify({ model: 'approved', input: 'expiry race' }),
      timeoutMs: 500,
    })
    assert.equal(response.status, 504)
    assert.deepEqual(JSON.parse(response.body), { error: { code: 'gateway_timeout' } })
    assert.equal(aborts, 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await assert.rejects(stat(lease.hostSocketPath))
  } finally {
    await lease.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('active request deadline returns one structured timeout and revokes the spent gateway', async (t) => {
  if (process.platform !== 'linux') return t.skip('pathname AF_UNIX permissions are Linux-specific')
  const root = await mkdtemp(join(tmpdir(), 'modly-model-gateway-request-timeout-test-'))
  let aborts = 0
  const lease = await acquireAgentModelAccessGateway({
    root,
    actionId: 'action-request-timeout',
    proposalHash: '1'.repeat(64),
    capabilityHash: '2'.repeat(64),
    digest: `sha256:${'3'.repeat(64)}`,
    approvedModelName: 'qwen3.6:27b',
    declaration: { schema: 'modly.agent-model-access.v1', profile: 'ollama-responses-json-v1' },
    privateModelAlias: 'modly-private-request-timeout',
    signal: new AbortController().signal,
    limits: { idleMs: 10, leaseMs: 200, requestMs: 30, minimumRequestMs: 5, cleanupMs: 10 },
    forward: async (_body, signal) => new Promise<never>(() => {
      signal.addEventListener('abort', () => { aborts += 1 }, { once: true })
    }),
  })
  try {
    const response = await unixRequest({
      socketPath: lease.hostSocketPath,
      token: lease.bearerToken,
      body: JSON.stringify({ model: 'approved', input: 'request deadline' }),
      timeoutMs: 500,
    })
    assert.equal(response.status, 504)
    assert.deepEqual(JSON.parse(response.body), { error: { code: 'gateway_timeout' } })
    assert.equal(aborts, 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await assert.rejects(stat(lease.hostSocketPath))
  } finally {
    await lease.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('gateway cancellation tears down one active ignored forward without a response race', async (t) => {
  if (process.platform !== 'linux') return t.skip('pathname AF_UNIX permissions are Linux-specific')
  const root = await mkdtemp(join(tmpdir(), 'modly-model-gateway-cancel-test-'))
  const controller = new AbortController()
  let started!: () => void
  const forwardStarted = new Promise<void>((resolve) => { started = resolve })
  let aborts = 0
  const lease = await acquireAgentModelAccessGateway({
    root,
    actionId: 'action-cancel',
    proposalHash: 'd'.repeat(64),
    capabilityHash: 'e'.repeat(64),
    digest: `sha256:${'f'.repeat(64)}`,
    approvedModelName: 'qwen3.6:27b',
    declaration: { schema: 'modly.agent-model-access.v1', profile: 'ollama-responses-json-v1' },
    privateModelAlias: 'modly-private-cancel',
    signal: controller.signal,
    limits: { idleMs: 10, leaseMs: 200, requestMs: 100, minimumRequestMs: 5, cleanupMs: 10 },
    forward: async (_body, signal) => new Promise<never>(() => {
      started()
      signal.addEventListener('abort', () => { aborts += 1 }, { once: true })
    }),
  })
  try {
    const pending = unixRequest({
      socketPath: lease.hostSocketPath,
      token: lease.bearerToken,
      body: JSON.stringify({ model: 'approved', input: 'cancel' }),
      timeoutMs: 500,
    })
    await forwardStarted
    controller.abort()
    await assert.rejects(pending)
    await lease.close()
    assert.equal(aborts, 1)
    await assert.rejects(stat(lease.hostSocketPath))
  } finally {
    await lease.close()
    await rm(root, { recursive: true, force: true })
  }
})

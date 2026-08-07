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
    limits: { idleMs: 10, totalMs: 1_000 },
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

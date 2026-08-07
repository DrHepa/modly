import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createAgentModelAccessRuntime, resolveAgentOllamaConfiguration } from './agent-model-access-runtime.ts'
import type { AgentPrivateOllamaDaemon } from './agent-ollama-private-daemon.ts'
import type { AgentProcessModelAccessDeclarationV1, AgentCapabilitySnapshotV1 } from '../../src/shared/types/agentActions.ts'

const declaration: AgentProcessModelAccessDeclarationV1 = {
  schema: 'modly.agent-model-access.v1',
  profile: 'ollama-responses-json-v1',
}

const hash = (value: Buffer | string) => `sha256:${createHash('sha256').update(value).digest('hex')}` as const

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'modly-model-runtime-'))
  const modelsDir = join(root, 'models')
  const runtimeDir = join(root, 'ollama-runtime')
  const layer = Buffer.from('model')
  const config = Buffer.from('{}')
  const layerDigest = hash(layer)
  const configDigest = hash(config)
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    config: { mediaType: 'application/vnd.docker.container.image.v1+json', digest: configDigest, size: config.length },
    layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: layerDigest, size: layer.length }],
  }))
  const manifestDigest = hash(manifest)
  const manifestPath = join(modelsDir, 'manifests', 'registry.ollama.ai', 'library', 'qwen3.6', '27b')
  await mkdir(join(manifestPath, '..'), { recursive: true, mode: 0o755 })
  await mkdir(join(modelsDir, 'blobs'), { recursive: true, mode: 0o755 })
  await writeFile(manifestPath, manifest, { mode: 0o644 })
  await writeFile(join(modelsDir, 'blobs', configDigest.replace(':', '-')), config, { mode: 0o644 })
  await writeFile(join(modelsDir, 'blobs', layerDigest.replace(':', '-')), layer, { mode: 0o644 })
  await mkdir(runtimeDir, { mode: 0o755 })
  await writeFile(join(runtimeDir, 'llama-server'), 'runner', { mode: 0o755 })
  return { root, modelsDir, runtimeDir, manifestDigest }
}

function capability(): AgentCapabilitySnapshotV1 {
  return {
    schema: 'modly.agent-capability.v1', version: 1, id: 'text-to-cad/plan',
    displayName: 'Plan', description: 'Plan CAD',
    extension: { id: 'text-to-cad', name: 'Text to CAD', version: '1.0.0' },
    node: { id: 'plan', input: 'text', output: 'plan', paramsSchema: [] },
    execution: {
      kind: 'process', schema: 'modly.agent-process-execution.v1', entry: 'processor.pyz',
      runtimeFiles: [], resourceFiles: [], modelAccess: declaration, runtimeHash: 'c'.repeat(64),
      artifacts: { maxCount: 1, maxTotalBytes: 1024, allowed: [{ kind: 'plan', mediaTypes: ['application/json'], maxBytes: 1024 }] },
      bindingHash: 'd'.repeat(64),
    },
    approval: { required: true, scope: 'single_action' }, hash: 'b'.repeat(64),
  }
}

function unixRequest(socketPath: string, token: string, body: unknown): Promise<{ status: number, body: unknown }> {
  const encoded = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      socketPath, path: '/v1/responses', method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) },
    }, (response) => {
      let responseBody = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { responseBody += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(responseBody) }))
    })
    request.on('error', reject)
    request.end(encoded)
  })
}

test('Ollama configuration is explicit, canonical, and never resolves mutable PATH', async (t) => {
  if (process.platform !== 'linux') return t.skip('production provider is Linux-only')
  const fixtureRoot = await fixture()
  const binary = await realpath(process.execPath)
  const config = await resolveAgentOllamaConfiguration({
    env: {
      MODLY_AGENT_OLLAMA_BINARY: binary,
      MODLY_AGENT_OLLAMA_MODELS_DIR: fixtureRoot.modelsDir,
      MODLY_AGENT_OLLAMA_RUNTIME_DIR: fixtureRoot.runtimeDir,
    },
    bwrapPath: binary,
    homeDir: fixtureRoot.root,
  })
  assert.equal(config.binaryPath, binary)
  assert.equal(config.modelsDir, fixtureRoot.modelsDir)
  assert.equal(config.runtimeDir, fixtureRoot.runtimeDir)
  const prefix = join(fixtureRoot.root, 'portable-prefix')
  const derivedBinary = join(prefix, 'bin', 'ollama')
  const derivedRuntime = join(prefix, 'lib', 'ollama')
  await mkdir(join(prefix, 'bin'), { recursive: true, mode: 0o755 })
  await mkdir(derivedRuntime, { recursive: true, mode: 0o755 })
  await writeFile(derivedBinary, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await writeFile(join(derivedRuntime, 'llama-server'), 'runner', { mode: 0o755 })
  const derived = await resolveAgentOllamaConfiguration({
    env: { MODLY_AGENT_OLLAMA_BINARY: derivedBinary, MODLY_AGENT_OLLAMA_MODELS_DIR: fixtureRoot.modelsDir },
    bwrapPath: binary,
  })
  assert.equal(derived.runtimeDir, derivedRuntime)
  await assert.rejects(resolveAgentOllamaConfiguration({
    env: { MODLY_AGENT_OLLAMA_BINARY: binary, MODLY_AGENT_OLLAMA_MODELS_DIR: fixtureRoot.modelsDir },
    bwrapPath: binary,
  }), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error
    && error.code === 'invalid_configuration'))
  await assert.rejects(resolveAgentOllamaConfiguration({
    env: {
      MODLY_AGENT_OLLAMA_BINARY: 'ollama',
      MODLY_AGENT_OLLAMA_MODELS_DIR: fixtureRoot.modelsDir,
      MODLY_AGENT_OLLAMA_RUNTIME_DIR: fixtureRoot.runtimeDir,
    },
    bwrapPath: binary,
    homeDir: fixtureRoot.root,
  }), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error
    && error.code === 'invalid_configuration'))
  const modelsLink = join(fixtureRoot.root, 'models-link')
  await symlink(fixtureRoot.modelsDir, modelsLink)
  await assert.rejects(resolveAgentOllamaConfiguration({
    env: {
      MODLY_AGENT_OLLAMA_BINARY: binary,
      MODLY_AGENT_OLLAMA_MODELS_DIR: modelsLink,
      MODLY_AGENT_OLLAMA_RUNTIME_DIR: fixtureRoot.runtimeDir,
    },
    bwrapPath: binary,
    homeDir: fixtureRoot.root,
  }), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'invalid_configuration'))
  const runtimeLink = join(fixtureRoot.root, 'runtime-link')
  await symlink(fixtureRoot.runtimeDir, runtimeLink)
  await assert.rejects(resolveAgentOllamaConfiguration({
    env: {
      MODLY_AGENT_OLLAMA_BINARY: binary,
      MODLY_AGENT_OLLAMA_MODELS_DIR: fixtureRoot.modelsDir,
      MODLY_AGENT_OLLAMA_RUNTIME_DIR: runtimeLink,
    },
    bwrapPath: binary,
  }), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error
    && error.code === 'invalid_configuration' && !String(error).includes(runtimeLink)))
  await rm(fixtureRoot.root, { recursive: true, force: true })
})

test('model access runtime keeps readiness/acquisition aligned and binds a one-shot exact-model lease', async (t) => {
  if (process.platform !== 'linux') return t.skip('production provider is Linux-only')
  const fixtureRoot = await fixture()
  const binary = await realpath(process.execPath)
  const calls: unknown[] = []
  let daemonClosed = 0
  let aliasSeen = ''
  const runtime = createAgentModelAccessRuntime({
    root: join(fixtureRoot.root, 'private'),
    env: {
      MODLY_AGENT_OLLAMA_BINARY: binary,
      MODLY_AGENT_OLLAMA_MODELS_DIR: fixtureRoot.modelsDir,
      MODLY_AGENT_OLLAMA_RUNTIME_DIR: fixtureRoot.runtimeDir,
    },
    bwrapPath: binary,
    homeDir: fixtureRoot.root,
    readinessProbe: async () => true,
    startPrivateDaemon: async (options): Promise<AgentPrivateOllamaDaemon> => {
      aliasSeen = options.alias
      assert.equal(options.runtime.path, fixtureRoot.runtimeDir)
      await options.runtime.revalidate()
      let closed = false
      return {
        alias: options.alias,
        endpoint: 'http://127.0.0.1:1',
        responses: async (body) => {
          await options.model.revalidate()
          calls.push(body)
          return { model: options.alias, output_text: 'ok' }
        },
        revalidate: async () => { if (closed) throw new Error('closed'); await options.model.revalidate() },
        close: async () => { if (!closed) { closed = true; daemonClosed += 1 } },
      }
    },
  })
  const controller = new AbortController()
  try {
    assert.equal(await runtime.readiness(declaration), true)
    const lease = await runtime.acquire({
      actionId: 'action-1', proposalHash: 'a'.repeat(64), capability: capability(),
      model: { provider: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'qwen3.6:27b', digest: fixtureRoot.manifestDigest },
      privateTempRoot: join(fixtureRoot.root, 'unused'), signal: controller.signal,
    })
    assert.notEqual(aliasSeen, '')
    assert.equal(lease.bindingHash.length, 64)
    assert.equal(JSON.stringify(lease).includes(fixtureRoot.runtimeDir), false)
    const response = await unixRequest(lease.hostSocketPath, lease.bearerToken, { model: 'approved', input: 'chair' })
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { model: 'approved', output_text: 'ok' })
    assert.deepEqual(calls, [{ model: aliasSeen, input: 'chair' }])
    await runtime.shutdown()
    assert.equal(daemonClosed, 1)
    await assert.rejects(lease.revalidate())
    await lease.close()
    assert.deepEqual(await readdir(join(fixtureRoot.root, 'private')), [])
  } finally {
    await runtime.shutdown()
    await rm(fixtureRoot.root, { recursive: true, force: true })
  }
})

test('model access runtime defaults unavailable and shuts down all partially active leases', async (t) => {
  if (process.platform !== 'linux') return t.skip('production provider is Linux-only')
  const unavailable = createAgentModelAccessRuntime({
    root: join(tmpdir(), 'does-not-exist', 'private'),
    env: { MODLY_AGENT_OLLAMA_BINARY: '/does/not/exist', MODLY_AGENT_OLLAMA_MODELS_DIR: '/does/not/exist' },
  })
  assert.equal(await unavailable.readiness(declaration), false)
  await unavailable.shutdown()
})

test('model access shutdown awaits in-flight readiness and acquisition cleanup', async (t) => {
  if (process.platform !== 'linux') return t.skip('production provider is Linux-only')
  const fixtureRoot = await fixture()
  const binary = await realpath(process.execPath)
  let releaseReadiness!: () => void
  const readinessGate = new Promise<void>((resolve) => { releaseReadiness = resolve })
  let readinessStarted!: () => void
  const readinessEntered = new Promise<void>((resolve) => { readinessStarted = resolve })
  const readinessRuntime = createAgentModelAccessRuntime({
    root: join(fixtureRoot.root, 'private-readiness'),
    env: {
      MODLY_AGENT_OLLAMA_BINARY: binary,
      MODLY_AGENT_OLLAMA_MODELS_DIR: fixtureRoot.modelsDir,
      MODLY_AGENT_OLLAMA_RUNTIME_DIR: fixtureRoot.runtimeDir,
    },
    bwrapPath: binary,
    readinessProbe: async () => {
      readinessStarted()
      await readinessGate
      return true
    },
  })
  const readiness = readinessRuntime.readiness(declaration)
  await readinessEntered
  let readinessShutdownFinished = false
  const readinessShutdown = readinessRuntime.shutdown().then(() => { readinessShutdownFinished = true })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(readinessShutdownFinished, false)
  releaseReadiness()
  await readinessShutdown
  assert.equal(await readiness, false)

  let releaseDaemon!: () => void
  const daemonGate = new Promise<void>((resolve) => { releaseDaemon = resolve })
  let daemonStarted!: () => void
  const daemonEntered = new Promise<void>((resolve) => { daemonStarted = resolve })
  let daemonClosed = 0
  const acquisitionRuntime = createAgentModelAccessRuntime({
    root: join(fixtureRoot.root, 'private-acquisition'),
    env: {
      MODLY_AGENT_OLLAMA_BINARY: binary,
      MODLY_AGENT_OLLAMA_MODELS_DIR: fixtureRoot.modelsDir,
      MODLY_AGENT_OLLAMA_RUNTIME_DIR: fixtureRoot.runtimeDir,
    },
    bwrapPath: binary,
    readinessProbe: async () => true,
    startPrivateDaemon: async (options): Promise<AgentPrivateOllamaDaemon> => {
      daemonStarted()
      await daemonGate
      let closed = false
      return {
        alias: options.alias,
        endpoint: 'http://127.0.0.1:1',
        responses: async () => ({}),
        revalidate: async () => { if (closed) throw new Error('closed') },
        close: async () => { if (!closed) { closed = true; daemonClosed += 1 } },
      }
    },
  })
  assert.equal(await acquisitionRuntime.readiness(declaration), true)
  const acquisition = acquisitionRuntime.acquire({
    actionId: 'action-shutdown', proposalHash: 'a'.repeat(64), capability: capability(),
    model: { provider: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'qwen3.6:27b', digest: fixtureRoot.manifestDigest },
    privateTempRoot: join(fixtureRoot.root, 'unused'), signal: new AbortController().signal,
  })
  await daemonEntered
  let acquisitionShutdownFinished = false
  const acquisitionShutdown = acquisitionRuntime.shutdown().then(() => { acquisitionShutdownFinished = true })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(acquisitionShutdownFinished, false)
  releaseDaemon()
  await acquisitionShutdown
  await assert.rejects(acquisition)
  assert.equal(daemonClosed, 1)
  assert.deepEqual(await readdir(join(fixtureRoot.root, 'private-readiness')), [])
  assert.deepEqual(await readdir(join(fixtureRoot.root, 'private-acquisition')), [])
  await rm(fixtureRoot.root, { recursive: true, force: true })
})

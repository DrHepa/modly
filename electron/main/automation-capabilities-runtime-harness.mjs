import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import axios from 'axios'
import { buildAutomationCapabilities } from './automation-capabilities.ts'
import { AUTOMATION_HTTP_BRIDGE_PATH, AutomationHttpBridge } from './automation-http-bridge.ts'

async function withTempExtensions(run) {
  const root = await mkdtemp(join(tmpdir(), 'modly-automation-capabilities-harness-'))
  const builtinDir = join(root, 'builtin')
  const userExtensionsDir = join(root, 'user')

  await mkdir(builtinDir, { recursive: true })
  await mkdir(userExtensionsDir, { recursive: true })

  try {
    return await run({ builtinDir, userExtensionsDir })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function createProcessManifest(baseDir, extensionId, manifest) {
  const extensionDir = join(baseDir, extensionId)
  await mkdir(extensionDir, { recursive: true })
  await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
}

async function main() {
  const summary = {
    full_payload_backend_healthy: null,
    partial_payload_backend_healthy: null,
    excluded_ui_only_nodes: null,
    bridge_logging_and_bind: null,
  }

  await withTempExtensions(async ({ builtinDir, userExtensionsDir }) => {
    await createProcessManifest(builtinDir, 'mesh-tools', {
      id: 'mesh-tools',
      displayName: 'Mesh Tools',
      description: 'Built-in mesh helpers',
      version: '1.0.0',
      source: 'acme/mesh-tools',
      type: 'process',
      entry: 'processor.js',
      nodes: [{ id: 'optimize', name: 'Optimize Mesh', input: 'mesh', output: 'mesh', params_schema: [{ key: 'ratio', type: 'number' }] }],
    })

    const originalGet = axios.get
    axios.get = async (url, config = {}) => {
      if (url.endsWith('/health')) return { data: { ok: true } }
      if (url.endsWith('/model/all')) return { data: [{ id: 'hf://acme/mesh-gen', name: 'Mesh Gen' }] }
      if (url.endsWith('/model/params')) {
        assert.equal(config.params?.model_id, 'hf://acme/mesh-gen')
        return { data: [{ key: 'prompt', type: 'string' }] }
      }

      throw new Error(`Unexpected URL: ${url}`)
    }

    try {
      const fullPayload = await buildAutomationCapabilities({
        builtinDir,
        userExtensionsDir,
        trustedRepos: new Set(['acme/mesh-tools']),
      })

      assert.equal(fullPayload.backend_ready, true)
      assert.equal(fullPayload.models.length, 1)
      assert.equal(fullPayload.processes.length, 1)
      assert.equal(fullPayload.errors, undefined)

      summary.full_payload_backend_healthy = {
        backend_ready: fullPayload.backend_ready,
        model_ids: fullPayload.models.map((model) => model.id),
        process_ids: fullPayload.processes.map((process) => process.id),
      }

      summary.excluded_ui_only_nodes = fullPayload.excluded.ui_only_nodes.map((node) => ({
        id: node.id,
        label: node.label,
      }))
      assert.ok(summary.excluded_ui_only_nodes.some((node) => node.label === 'Add to Scene'))
    } finally {
      axios.get = originalGet
    }
  })

  await withTempExtensions(async ({ builtinDir, userExtensionsDir }) => {
    await createProcessManifest(userExtensionsDir, 'user-mesh-tools', {
      id: 'user-mesh-tools',
      displayName: 'User Mesh Tools',
      description: 'User process pack',
      version: '1.1.0',
      source: 'acme/user-mesh-tools',
      type: 'process',
      entry: 'processor.js',
      nodes: [{ id: 'repair', name: 'Repair Mesh', input: 'mesh', output: 'mesh', params_schema: [{ key: 'strength', type: 'number' }] }],
    })

    const originalGet = axios.get
    axios.get = async (url, config = {}) => {
      if (url.endsWith('/health')) return { data: { ok: true } }
      if (url.endsWith('/model/all')) return { data: [{ id: 'model-ok', name: 'Model OK' }, { id: 'model-fails', name: 'Model Fails' }] }
      if (url.endsWith('/model/params')) {
        if (config.params?.model_id === 'model-ok') return { data: [{ key: 'seed', type: 'number' }] }
        if (config.params?.model_id === 'model-fails') throw new Error('params endpoint exploded')
      }

      throw new Error(`Unexpected URL: ${url}`)
    }

    try {
      const partialPayload = await buildAutomationCapabilities({
        builtinDir,
        userExtensionsDir,
        trustedRepos: new Set(['acme/user-mesh-tools']),
      })

      assert.equal(partialPayload.backend_ready, true)
      assert.equal(partialPayload.models.length, 1)
      assert.equal(partialPayload.processes.length, 1)
      assert.ok(partialPayload.errors?.some((error) => error.code === 'MODEL_PARAMS_FAILED'))

      summary.partial_payload_backend_healthy = {
        backend_ready: partialPayload.backend_ready,
        surviving_model_ids: partialPayload.models.map((model) => model.id),
        error_codes: partialPayload.errors?.map((error) => error.code) ?? [],
      }
    } finally {
      axios.get = originalGet
    }
  })

  const loggerMessages = { info: [], warn: [], error: [] }
  const bridge = new AutomationHttpBridge({
    host: '127.0.0.1',
    port: 0,
    getAutomationCapabilities: async () => ({
      backend_ready: false,
      models: [],
      processes: [],
      excluded: {
        ui_only_nodes: [
          {
            kind: 'ui_only',
            source: 'ui-only',
            id: 'outputNode',
            type: 'outputNode',
            label: 'Add to Scene',
            reason: 'Canvas output node from WorkflowsPage; it targets desktop scene composition only and is intentionally excluded from automation discovery.',
          },
        ],
      },
      errors: [{ source: 'backend-runtime', code: 'BACKEND_NOT_READY', message: 'GET /health failed', retryable: true }],
    }),
    logger: {
      info: (message) => loggerMessages.info.push(message),
      warn: (message) => loggerMessages.warn.push(message),
      error: (message) => loggerMessages.error.push(message),
    },
  })

  await bridge.start()
  try {
    const origin = bridge.getOrigin()
    assert.ok(origin)
    const response = await fetch(`${origin}${AUTOMATION_HTTP_BRIDGE_PATH}`)
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.backend_ready, false)
    assert.ok(payload.excluded.ui_only_nodes.some((node) => node.label === 'Add to Scene'))
  } finally {
    await bridge.stop()
  }

  const occupiedServer = createServer()
  occupiedServer.listen(0, '127.0.0.1')
  await once(occupiedServer, 'listening')
  const occupiedAddress = occupiedServer.address()
  assert.ok(occupiedAddress && typeof occupiedAddress !== 'string')

  const bindProbe = new AutomationHttpBridge({
    host: '127.0.0.1',
    port: occupiedAddress.port,
    getAutomationCapabilities: async () => ({ backend_ready: true, models: [], processes: [], excluded: { ui_only_nodes: [] } }),
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  })

  try {
    await assert.rejects(() => bindProbe.start(), /EADDRINUSE|listen/i)
  } finally {
    occupiedServer.close()
    await once(occupiedServer, 'close')
  }

  summary.bridge_logging_and_bind = {
    info_messages: loggerMessages.info,
    warn_messages: loggerMessages.warn,
    bind_failure_verified: true,
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
}

await main()

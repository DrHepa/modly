import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { AUTOMATION_HTTP_BRIDGE_PATH, AutomationHttpBridge } from './automation-http-bridge.ts'

async function startBridge(getAutomationCapabilities, options = {}) {
  const bridge = new AutomationHttpBridge({
    host: '127.0.0.1',
    port: options.port ?? 0,
    getAutomationCapabilities,
    logger: options.logger ?? {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  })

  await bridge.start()
  return bridge
}

async function requestJson(pathname, init, bridge) {
  assert.ok(bridge)
  const origin = bridge.getOrigin()
  assert.ok(origin)

  return fetch(`${origin}${pathname}`, init)
}

test('AutomationHttpBridge returns 200 for partial-success capability payloads', async () => {
  const loggerMessages = { info: [], warn: [] }
  const partialResponse = {
    backend_ready: false,
    models: [],
    processes: [
      {
        kind: 'process',
        source: 'electron-manifest',
        id: 'mesh.optimize',
        extension_id: 'mesh-tools',
        node_id: 'optimize',
        name: 'Optimize Mesh',
        extension_name: 'Mesh Tools',
        builtin: true,
        trusted: true,
        entry: 'processor.js',
      },
    ],
    excluded: { ui_only_nodes: [] },
    errors: [
      {
        source: 'backend-runtime',
        code: 'BACKEND_NOT_READY',
        message: 'GET /health failed',
        retryable: true,
      },
    ],
  }

  const bridge = await startBridge(async () => partialResponse, {
    logger: {
      info: (message) => loggerMessages.info.push(message),
      warn: (message) => loggerMessages.warn.push(message),
      error: () => undefined,
    },
  })

  try {
    const response = await requestJson(AUTOMATION_HTTP_BRIDGE_PATH, undefined, bridge)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/)
    assert.deepEqual(await response.json(), partialResponse)
    assert.equal(loggerMessages.info.length, 1)
    assert.match(loggerMessages.info[0] ?? '', /Automation HTTP bridge listening on http:\/\/127\.0\.0\.1:/)
    assert.deepEqual(loggerMessages.warn, [
      'Automation HTTP bridge returned partial capabilities payload with backend_ready=false',
    ])
  } finally {
    await bridge.stop()
  }
})

test('AutomationHttpBridge returns 404 for unsupported paths', async () => {
  const bridge = await startBridge(async () => {
    throw new Error('should not be called for 404')
  })

  try {
    const response = await requestJson('/automation/unknown', undefined, bridge)
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'Not Found' })
  } finally {
    await bridge.stop()
  }
})

test('AutomationHttpBridge returns 405 and Allow header for non-GET methods', async () => {
  const bridge = await startBridge(async () => {
    throw new Error('should not be called for 405')
  })

  try {
    const response = await requestJson(AUTOMATION_HTTP_BRIDGE_PATH, { method: 'POST' }, bridge)
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'GET')
    assert.deepEqual(await response.json(), { error: 'Method Not Allowed' })
  } finally {
    await bridge.stop()
  }
})

test('AutomationHttpBridge returns 500 for unexpected bridge errors', async () => {
  const loggerMessages = []
  const bridge = await startBridge(
    async () => {
      throw new Error('boom')
    },
    {
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: (message) => {
          loggerMessages.push(message)
        },
      },
    },
  )

  try {
    const response = await requestJson(AUTOMATION_HTTP_BRIDGE_PATH, undefined, bridge)
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: 'Internal Server Error' })
    assert.equal(loggerMessages.length, 1)
    assert.match(loggerMessages[0] ?? '', /Automation HTTP bridge request failed:/)
  } finally {
    await bridge.stop()
  }
})

test('AutomationHttpBridge surfaces bind failures without leaving a listening server behind', async () => {
  const occupiedServer = createServer()
  occupiedServer.listen(0, '127.0.0.1')
  await once(occupiedServer, 'listening')

  const address = occupiedServer.address()
  assert.ok(address && typeof address !== 'string')

  const bridge = new AutomationHttpBridge({
    host: '127.0.0.1',
    port: address.port,
    getAutomationCapabilities: async () => ({
      backend_ready: true,
      models: [],
      processes: [],
      excluded: { ui_only_nodes: [] },
    }),
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  })

  try {
    await assert.rejects(() => bridge.start(), /EADDRINUSE|listen/i)
    assert.equal(bridge.getOrigin(), null)
  } finally {
    occupiedServer.close()
    await once(occupiedServer, 'close')
  }
})

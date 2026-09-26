import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerWorldsCliIpcHandlers } from './worlds-cli-ipc.ts'

const DOCUMENT = 'http://127.0.0.1:5173/'

test('trusted renderer can inspect status or revoke but cannot mint or retrieve a pairing code', async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  const frame = { url: DOCUMENT, origin: new URL(DOCUMENT).origin }
  const contents = { mainFrame: frame, getURL: () => DOCUMENT }
  const window = { isDestroyed: () => false, webContents: contents }
  const event = { sender: contents, senderFrame: frame }
  let revoked = 0
  const controls = registerWorldsCliIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    getStatus: () => ({ running: true, paired: false, expired: false, pairingPending: false, pairingId: null, sessionExpiresAt: null }),
    async revoke() { revoked++ },
  }, { getWindow: () => window, trustedRendererUrl: DOCUMENT,
    dialog: { async showMessageBox() { throw new Error('No dialog needed for status or revoke') } } })
  assert.equal(handlers.has('workspace:worlds:cli:beginPairing'), false)
  for (const operation of ['status', 'revoke']) {
    const handler = handlers.get(`workspace:worlds:cli:${operation}`)!
    assert.deepEqual(await handler({ ...event, senderFrame: { ...frame } }), { ok: false, code: 'UNAUTHORIZED' })
    assert.deepEqual(await handler(event, { secret: 'a'.repeat(32) }), { ok: false, code: 'INVALID_REQUEST' })
  }
  assert.deepEqual(await handlers.get('workspace:worlds:cli:status')!(event), { ok: true, running: true, paired: false,
    expired: false, pairingPending: false, pairingId: null, sessionExpiresAt: null })
  assert.deepEqual(await handlers.get('workspace:worlds:cli:revoke')!(event), { ok: true })
  assert.equal(revoked, 1)
  await controls.shutdown()
  assert.equal(revoked, 2)
})

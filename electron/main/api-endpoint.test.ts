import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import type { Server } from 'node:net'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertApiPortAvailable, assertPrivateDataPath, resolveApiEndpoint, resolveIsolatedUserDataDir } from './api-endpoint'
import { getSettings, setSettings } from './settings-store'

type ProbeEmitter = EventEmitter & { listening: boolean }

test('API endpoint defaults to the installed Modly port', () => {
  assert.deepEqual(resolveApiEndpoint({}), { port: 8765, baseUrl: 'http://127.0.0.1:8765', isolated: false })
})

test('isolated dev mode requires and uses a private port', () => {
  assert.deepEqual(resolveApiEndpoint({ MODLY_ISOLATED_DEV: '1', MODLY_API_PORT: '18765' }), {
    port: 18765, baseUrl: 'http://127.0.0.1:18765', isolated: true,
  })
  assert.throws(() => resolveApiEndpoint({ MODLY_ISOLATED_DEV: '1' }), /private.*port/i)
  assert.throws(() => resolveApiEndpoint({ MODLY_ISOLATED_DEV: '1', MODLY_API_PORT: '8765' }), /private.*port/i)
})

test('rejects malformed port overrides', () => {
  for (const port of ['0', '65536', 'abc', '80x', '-1']) {
    assert.throws(() => resolveApiEndpoint({ MODLY_API_PORT: port }), /port/i)
  }
})

test('occupied port fails without stopping the unrelated listener', async () => {
  let unrelatedListenerStopped = false
  const probe = Object.assign(new EventEmitter(), {
    listening: false,
    listen(this: ProbeEmitter) { queueMicrotask(() => this.emit('error', new Error('EADDRINUSE'))) },
    close() { unrelatedListenerStopped = true },
  }) as unknown as Server
  await assert.rejects(assertApiPortAvailable(18765, () => probe), /already in use/i)
  assert.equal(unrelatedListenerStopped, false)
})

test('successful port probe closes its own temporary listener', async () => {
  let closed = false
  const probe = Object.assign(new EventEmitter(), {
    listening: false,
    listen(this: ProbeEmitter, _port: number, _host: string, ready: () => void) { this.listening = true; ready() },
    close(this: ProbeEmitter, done: () => void) { closed = true; this.listening = false; done() },
  }) as unknown as Server
  await assertApiPortAvailable(18765, () => probe)
  assert.equal(closed, true)
})

test('isolated mode requires separate absolute user data', () => {
  assert.equal(resolveIsolatedUserDataDir({ MODLY_ISOLATED_DEV: '1', MODLY_ISOLATED_USER_DATA_DIR: '/tmp/modly-private' }, '/home/user/.config/Modly'), '/tmp/modly-private')
  assert.throws(() => resolveIsolatedUserDataDir({ MODLY_ISOLATED_DEV: '1' }, '/home/user/.config/Modly'), /USER_DATA_DIR/i)
  assert.throws(() => resolveIsolatedUserDataDir({ MODLY_ISOLATED_DEV: '1', MODLY_ISOLATED_USER_DATA_DIR: '/home/user/.config/Modly' }, '/home/user/.config/Modly'), /separate/i)
  assert.equal(resolveIsolatedUserDataDir({}, '/home/user/.config/Modly'), null)
})

test('private data validation rejects shared and symlink-aliased directories', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'modly-isolation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const privateDir = join(root, 'private')
  const sharedDir = join(root, 'Documents', 'Modly')
  mkdirSync(privateDir)
  mkdirSync(sharedDir, { recursive: true })
  symlinkSync(sharedDir, join(privateDir, 'alias'))
  assertPrivateDataPath(join(privateDir, 'data'), privateDir)
  assert.throws(() => assertPrivateDataPath(sharedDir, privateDir), /private user data/i)
  assert.throws(() => assertPrivateDataPath(join(privateDir, 'alias', 'models'), privateDir), /private user data/i)
  assert.throws(() => resolveIsolatedUserDataDir({ MODLY_ISOLATED_DEV: '1', MODLY_ISOLATED_USER_DATA_DIR: sharedDir }, privateDir, [sharedDir]), /separate/i)
})

test('isolated first-run settings stay private and reject shared writes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'modly-settings-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const userData = join(root, 'private')
  mkdirSync(userData)
  const previous = process.env['MODLY_ISOLATED_DEV']
  process.env['MODLY_ISOLATED_DEV'] = '1'
  t.after(() => {
    if (previous === undefined) delete process.env['MODLY_ISOLATED_DEV']
    else process.env['MODLY_ISOLATED_DEV'] = previous
  })
  const defaults = getSettings(userData)
  for (const dir of [defaults.modelsDir, defaults.workspaceDir, defaults.workflowsDir, defaults.extensionsDir, defaults.dependenciesDir]) {
    assertPrivateDataPath(dir, userData)
  }
  assert.throws(() => setSettings(userData, { workspaceDir: join(root, 'shared', 'workspace') }), /private user data/i)
})

import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { connect, createServer } from 'node:net'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, realpath, symlink, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorldsCliTransport } from './worlds-cli-transport.ts'
import { WorldProjectRepository } from './world-project-repository.ts'

const A = `world-${'a'.repeat(32)}`
const B = `world-${'b'.repeat(32)}`
const execFileAsync = promisify(execFile)
const snapshot = (key: string, revision = 3) => ({
  project: { projectId: key === A ? 'project:a' : 'project:b', name: 'Example', revision,
    startSceneId: 'scene:one', scenes: [{ id: 'scene:one', name: 'One' }, { id: 'scene:two', name: 'Two' }], resources: [] },
  scenes: [], workspacePath: '/private/snapshot/sentinel',
})

let pathnameUnixSocketCapability: Promise<boolean> | undefined

function hasPathnameUnixSocketCapability(): Promise<boolean> {
  pathnameUnixSocketCapability ??= (async () => {
    const root = await mkdtemp(join(tmpdir(), 'modly-worlds-cli-socket-probe-'))
    const socketPath = join(root, 'probe.sock')
    const server = createServer()
    try {
      try {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            server.off('listening', onListening)
            server.off('error', onError)
          }
          const onListening = () => { cleanup(); resolve() }
          const onError = (error: Error) => { cleanup(); reject(error) }
          server.once('listening', onListening)
          server.once('error', onError)
          try { server.listen(socketPath) } catch (error) { cleanup(); reject(error) }
        })
        return true
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        if (code === 'EPERM' || code === 'EACCES') return false
        throw error
      }
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve())
        })
      }
      await rm(root, { recursive: true, force: true })
    }
  })()
  return pathnameUnixSocketCapability
}

function udsTest(name: string, body: (context: TestContext) => Promise<void>): void {
  test(name, async (context) => {
    if (!await hasPathnameUnixSocketCapability()) {
      context.skip('Pathname AF_UNIX sockets are unavailable in this test environment')
      return
    }
    await body(context)
  })
}

function fakeRepository() {
  const calls = { list: 0, open: 0, query: 0 }
  const repository = {
    async list() { calls.list++; return { ok: true as const, value: { projects: [
      { projectKey: A, projectId: 'project:a', name: 'Example', revision: 3, status: 'ready', workspacePath: '/private/list/sentinel' },
    ], issues: [] } } },
    async open({ projectKey }: { projectKey: string }) {
      calls.open++
      return { ok: true as const, value: { status: 'ready' as const, projectKey, snapshot: snapshot(projectKey) } }
    },
    async queryAi(request: { context: Record<string, unknown>; query: { kind: string; cursor?: string } }) {
      calls.query++
      const first = !request.query.cursor
      const scope = JSON.stringify([request.context, request.query.kind, null])
      if (request.query.kind === 'resources') return { ok: true as const, value: { context: request.context, kind: 'resources',
        items: [{ kind: 'resource', id: 'resource:foreign', name: 'Private scene B model', source: 'exports', format: 'glb',
          capability: 'model', fingerprint: 'a'.repeat(64), dependencyCount: 0 },
        { kind: 'resource', id: 'resource:shared', name: 'Shared workspace secret', source: 'workflows', format: 'glb',
          capability: 'model', fingerprint: 'b'.repeat(64), dependencyCount: 0 }], total: 2, nextCursor: null, snapshot: snapshot(A) } }
      if (request.query.kind === 'project') return { ok: true as const, value: { context: request.context, kind: 'project',
        items: [{ kind: 'project', id: 'project:a', name: 'Example', revision: 3, startSceneId: 'scene:two',
          sceneCount: 2, resourceCount: 9 }], total: 1, nextCursor: null, snapshot: snapshot(A) } }
      return { ok: true as const, value: {
        context: request.context, kind: request.query.kind,
        items: [{ kind: 'scene', id: first ? 'scene:one' : 'scene:two', name: first ? 'One' : 'Two', isActive: first, isStart: first, entityCount: 0,
          workspacePath: '/private/page/sentinel' }],
        total: 2, nextCursor: first ? JSON.stringify([scope, 1]) : null,
        snapshot: snapshot(A),
      } }
    },
    async previewCliAi() { throw new Error('A foreign or project-wide recipe reached preview') },
    async discardAi() { return { ok: true as const, value: { discarded: true as const } } },
  }
  return { calls, repository }
}

async function wire(path: string, value: unknown): Promise<Record<string, unknown>> {
  const payload = Buffer.from(JSON.stringify(value))
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length)
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    const chunks: Buffer[] = []
    let expected = -1
    socket.setTimeout(1500, () => { socket.destroy(); reject(new Error('socket timeout')) })
    socket.on('error', reject)
    socket.on('connect', () => socket.write(Buffer.concat([length, payload])))
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      const data = Buffer.concat(chunks)
      if (expected < 0 && data.length >= 4) expected = data.readUInt32BE(0)
      if (expected >= 0 && data.length >= expected + 4) { socket.end(); resolve(JSON.parse(data.subarray(4, expected + 4).toString())) }
    })
    socket.on('end', () => { if (expected < 0) reject(new Error('truncated response')) })
  })
}

async function malformedFrame(path: string, frame: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(path)
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('malformed frame timeout')) }, 2000)
    const done = () => { clearTimeout(timer); socket.destroy(); resolve() }
    socket.once('error', reject)
    socket.once('connect', () => socket.end(frame))
    socket.once('data', done)
    socket.once('close', done)
  })
}

udsTest('opt-in pairing, scoped read-only session, redacted list/open and two opaque query pages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worlds-cli-test-'))
  const { calls, repository } = fakeRepository()
  let now = 1_000_000
  const transport = new WorldsCliTransport({ repository: repository as unknown as ConstructorParameters<typeof WorldsCliTransport>[0]['repository'], runtimeDir: join(root, 'runtime'), now: () => now })
  try {
    assert.equal(transport.running, false)
    assert.deepEqual(transport.getStatus(), { running: false, paired: false, expired: false, pairingPending: false, pairingId: null, sessionExpiresAt: null })
    assert.equal(calls.list, 0)
    const pairing = await transport.beginPairing()
    assert.equal(transport.running, true)
    assert.equal(transport.getStatus().pairingPending, true)
    assert.equal(transport.getStatus().pairingId, pairing.pairingId)
    assert.match(pairing.code, /^[a-f0-9]{32}$/)
    assert.equal((await stat(join(root, 'runtime'))).mode & 0o777, 0o700)
    assert.equal((await stat(transport.socketPath)).mode & 0o777, 0o600)
    assert.deepEqual(await wire(transport.socketPath, { operation: 'list' }), { ok: false, code: 'UNAUTHORIZED' })
    assert.deepEqual(await wire(transport.socketPath, { operation: 'pair', code: 'wrong' }), { ok: false, code: 'UNAUTHORIZED' })
    assert.deepEqual(calls, { list: 0, open: 0, query: 0 })
    const paired = await wire(transport.socketPath, { operation: 'pair', code: pairing.code })
    assert.equal(paired.ok, true)
    assert.equal(transport.getStatus().paired, true)
    assert.equal(transport.getStatus().pairingPending, false)
    assert.equal(transport.getStatus().pairingId, pairing.pairingId)
    const session = paired.session as string
    assert.match(session, /^[a-f0-9]{64}$/)
    assert.deepEqual(await wire(transport.socketPath, { operation: 'pair', code: pairing.code }), { ok: false, code: 'UNAUTHORIZED' })
    assert.deepEqual(await wire(transport.socketPath, { operation: 'apply', session }), { ok: false, code: 'UNSUPPORTED' })
    assert.deepEqual(await wire(transport.socketPath, { operation: 'reject', session }), { ok: false, code: 'UNSUPPORTED' })
    assert.deepEqual(await wire(transport.socketPath, { operation: 'undo', session }), { ok: false, code: 'UNSUPPORTED' })
    const listed = await wire(transport.socketPath, { operation: 'list', session })
    assert.equal(listed.ok, true)
    assert.equal(JSON.stringify(listed).includes('/private/'), false)
    const opened = await wire(transport.socketPath, { operation: 'open', session, projectKey: A })
    assert.equal(opened.ok, true)
    assert.equal(JSON.stringify(opened).includes('snapshot'), false)
    assert.equal(JSON.stringify(opened).includes('/private/'), false)
    const first = await wire(transport.socketPath, { operation: 'query', session, projectKey: A, revision: 3, kind: 'scenes', pageSize: 1 })
    assert.equal(first.ok, true)
    assert.equal(JSON.stringify(first).includes('/private/'), false)
    assert.equal(JSON.stringify(first).includes('snapshot'), false)
    assert.equal(JSON.stringify(first).includes('originSessionId'), false)
    assert.match((first.page as Record<string, unknown>).nextCursor as string, /^cursor_[a-f0-9]{48}$/)
    const second = await wire(transport.socketPath, { operation: 'query', session, projectKey: A, revision: 3, kind: 'scenes', pageSize: 1, cursor: (first.page as Record<string, unknown>).nextCursor })
    assert.equal(second.ok, true)
    assert.equal((second.page as Record<string, unknown>).nextCursor, null)
    assert.equal(calls.query, 2)
    const before = calls.query
    assert.deepEqual(await wire(transport.socketPath, { operation: 'query', session, projectKey: B, revision: 3, kind: 'scenes', pageSize: 1, cursor: (first.page as Record<string, unknown>).nextCursor }), { ok: false, code: 'INVALID_REQUEST' })
    assert.deepEqual(await wire(transport.socketPath, { operation: 'query', session, projectKey: A, revision: 2, kind: 'scenes', pageSize: 1, cursor: (first.page as Record<string, unknown>).nextCursor }), { ok: false, code: 'INVALID_REQUEST' })
    assert.equal(calls.query, before)
    now += 16 * 60_000
    assert.equal(transport.getStatus().paired, false)
    assert.equal(transport.getStatus().expired, true)
    assert.deepEqual(await wire(transport.socketPath, { operation: 'list', session }), { ok: false, code: 'UNAUTHORIZED' })
    assert.equal(calls.list, 1)
    const nextPairing = await transport.beginPairing()
    const nextSession = (await wire(transport.socketPath, { operation: 'pair', code: nextPairing.code })).session
    assert.notEqual(nextSession, session)
    assert.deepEqual(await wire(transport.socketPath, { operation: 'list', session }), { ok: false, code: 'UNAUTHORIZED' })
    await transport.revoke()
    assert.equal(transport.running, false)
  } finally { await transport.revoke(); await rm(root, { recursive: true, force: true }) }
})

udsTest('pre-consent listener permits only bounded rate-limited activation and never releases the pairing code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worlds-cli-test-'))
  const { calls, repository } = fakeRepository()
  let now = 1_000_000
  let requests = 0
  const transport = new WorldsCliTransport({ repository: repository as never, runtimeDir: join(root, 'runtime'), now: () => now,
    onPairRequest: async () => { requests++; return { ok: false, code: 'USER_DECLINED' } } })
  try {
    await transport.startListening()
    assert.equal((await stat(root + '/runtime')).mode & 0o777, 0o700)
    assert.equal((await stat(transport.socketPath)).mode & 0o777, 0o600)
    for (const operation of ['pair', 'list', 'open', 'plan', 'query', 'propose', 'apply']) {
      const response = await wire(transport.socketPath, { operation, code: 'a'.repeat(32), projectKey: A })
      assert.deepEqual(response, { ok: false, code: 'UNAUTHORIZED' }, operation)
    }
    assert.deepEqual(await wire(transport.socketPath, { operation: 'pair.request', extra: true }), { ok: false, code: 'INVALID_REQUEST' })
    for (let i = 0; i < 3; i++) assert.deepEqual(await wire(transport.socketPath, { operation: 'pair.request' }), { ok: false, code: 'USER_DECLINED' })
    assert.equal(requests, 3)
    assert.deepEqual(await wire(transport.socketPath, { operation: 'pair.request' }), { ok: false, code: 'BUSY' })
    assert.equal(requests, 3)
    now += 600_001
    assert.deepEqual(await wire(transport.socketPath, { operation: 'pair.request' }), { ok: false, code: 'USER_DECLINED' })
    assert.equal(requests, 4)
    assert.deepEqual(calls, { list: 0, open: 0, query: 0 })
  } finally { await transport.revoke(); await rm(root, { recursive: true, force: true }) }
})

udsTest('approved activation scopes every read and plan to the mounted scene and revokes on revision/Play', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worlds-cli-test-'))
  const { repository } = fakeRepository()
  const trust = { window: {}, contents: {}, frame: {}, documentUrl: 'file:///trusted', documentEpoch: 0, workspaceRoot: root }
  const scope = { trust, canonicalWorkspace: await realpath(root), projectKey: A, projectId: 'project:a',
    sceneId: 'scene:one', revision: 3, editorEpoch: 2 }
  let active: typeof scope | null = scope
  let code = ''
  const transport = new WorldsCliTransport({ repository: repository as never, runtimeDir: join(root, 'runtime'),
    captureTrust: () => trust, activeEditorScope: async () => active,
    onPairRequest: async (isLive) => { const pairing = await transport.beginPairing(scope, isLive); code = pairing.code; return { ok: true } } })
  try {
    await transport.startListening()
    const activation = await wire(transport.socketPath, { operation: 'pair.request' })
    assert.equal(activation.ok, true)
    assert.equal(JSON.stringify(activation).includes(code), false)
    const paired = await wire(transport.socketPath, { operation: 'pair', code })
    assert.equal(paired.ok, true)
    const session = paired.session
    assert.deepEqual(await wire(transport.socketPath, { operation: 'pair.request' }), { ok: false, code: 'BUSY' })
    assert.deepEqual(await wire(transport.socketPath, { operation: 'open', session, projectKey: B }), { ok: false, code: 'UNAUTHORIZED' })
    assert.deepEqual(await wire(transport.socketPath, { operation: 'plan', session, projectKey: A, sceneId: 'scene:two' }), { ok: false, code: 'UNAUTHORIZED' })
    assert.deepEqual(await wire(transport.socketPath, { operation: 'query', session, projectKey: A, revision: 3, sceneId: 'scene:two', kind: 'scenes' }), { ok: false, code: 'UNAUTHORIZED' })
    assert.deepEqual(await wire(transport.socketPath, { operation: 'query', session, projectKey: A, revision: 3, kind: 'scenes' }), { ok: false, code: 'UNAUTHORIZED' })
    for (const kind of ['resources', 'project']) {
      assert.deepEqual(await wire(transport.socketPath, { operation: 'query', session, projectKey: A, revision: 3, kind }),
        { ok: false, code: 'UNAUTHORIZED' }, `The ${kind} query must not expose scene B or shared workspace metadata`)
    }
    const plan = await wire(transport.socketPath, { operation: 'plan', session, projectKey: A, sceneId: 'scene:one' })
    assert.equal(plan.ok, true)
    assert.deepEqual(await wire(transport.socketPath, { operation: 'propose', session, projectKey: A, planId: plan.planId,
      json: '{"commands":[{"type":"create-scene","localRef":"foreign","name":"Off-scene"}]}' }),
    { ok: false, code: 'UNAUTHORIZED' })
    const listed = await wire(transport.socketPath, { operation: 'list', session })
    assert.equal(listed.ok, true)
    assert.equal((listed.projects as Array<{ projectKey: string }>).length, 1)
    const opened = await wire(transport.socketPath, { operation: 'open', session, projectKey: A })
    assert.deepEqual((opened.project as { sceneIds: string[] }).sceneIds, ['scene:one'])
    active = { ...scope, revision: 4 }
    assert.deepEqual(await wire(transport.socketPath, { operation: 'list', session }), { ok: false, code: 'UNAUTHORIZED' })
    active = scope
    assert.deepEqual(await wire(transport.socketPath, { operation: 'list', session }), { ok: false, code: 'UNAUTHORIZED' })
    assert.equal((await wire(transport.socketPath, { operation: 'pair.request' })).ok, true)
    const staleCode = code
    active = { ...scope, sceneId: 'scene:two' }
    assert.deepEqual(await wire(transport.socketPath, { operation: 'pair', code: staleCode }), { ok: false, code: 'UNAUTHORIZED' })
    active = scope
    assert.deepEqual(await wire(transport.socketPath, { operation: 'pair', code: staleCode }), { ok: false, code: 'UNAUTHORIZED' })
  } finally { await transport.revoke(); await rm(root, { recursive: true, force: true }) }
})

udsTest('shutdown during native consent cannot recreate a socket or mint a code afterward', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worlds-cli-test-'))
  const { repository } = fakeRepository()
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  let intentWasRevoked = false
  const transport = new WorldsCliTransport({ repository: repository as never, runtimeDir: join(root, 'runtime'),
    onPairRequest: async (isLive) => { entered(); await gate; intentWasRevoked = !isLive(); return { ok: true } } })
  try {
    await transport.startListening()
    const pending = wire(transport.socketPath, { operation: 'pair.request' }).catch(() => ({ ok: false }))
    await started
    await transport.revoke()
    release()
    await pending
    assert.equal(intentWasRevoked, true)
    await assert.rejects(transport.startListening(), /stopping/)
    await assert.rejects(stat(transport.socketPath), { code: 'ENOENT' })
  } finally { release(); await transport.revoke(); await rm(root, { recursive: true, force: true }) }
})

udsTest('timed-out native consent retains dialog ownership until the original dialog actually settles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worlds-cli-test-'))
  const { repository } = fakeRepository()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let dialogs = 0
  const transport = new WorldsCliTransport({ repository: repository as never, runtimeDir: join(root, 'runtime'),
    pairRequestMs: 60,
    onPairRequest: async (isLive) => { dialogs++; await gate; assert.equal(isLive(), false); return { ok: false } } })
  try {
    await transport.startListening()
    assert.deepEqual(await wire(transport.socketPath, { operation: 'pair.request' }), { ok: false, code: 'USER_DECLINED' })
    assert.deepEqual(await wire(transport.socketPath, { operation: 'pair.request' }), { ok: false, code: 'BUSY' })
    assert.equal(dialogs, 1)
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(await wire(transport.socketPath, { operation: 'pair.request' }), { ok: false, code: 'USER_DECLINED' })
    assert.equal(dialogs, 2)
  } finally { release(); await transport.revoke(); await rm(root, { recursive: true, force: true }) }
})

udsTest('client disconnect invalidates a late approval and does not mint pairing credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worlds-cli-test-'))
  const { repository } = fakeRepository()
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  let liveAfterDisconnect = true
  const transport = new WorldsCliTransport({ repository: repository as never, runtimeDir: join(root, 'runtime'),
    onPairRequest: async (isLive) => { entered(); await gate; liveAfterDisconnect = isLive(); return { ok: true } } })
  try {
    await transport.startListening()
    const socket = connect(transport.socketPath)
    const payload = Buffer.from('{"operation":"pair.request"}')
    const length = Buffer.alloc(4); length.writeUInt32BE(payload.length)
    await new Promise<void>((resolve) => socket.once('connect', () => { socket.write(Buffer.concat([length, payload])); resolve() }))
    await started
    socket.destroy()
    await new Promise<void>((resolve) => socket.once('close', () => resolve()))
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(liveAfterDisconnect, false)
    assert.equal(transport.getStatus().pairingPending, false)
    assert.equal(transport.getStatus().paired, false)
  } finally { release(); await transport.revoke(); await rm(root, { recursive: true, force: true }) }
})

udsTest('pair-request limiter survives clean socket restart and refuses a corrupt or symlinked owner file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worlds-cli-test-'))
  const runtimeDir = join(root, 'runtime')
  const { repository } = fakeRepository()
  const now = 1_000_000
  let prompts = 0
  const create = () => new WorldsCliTransport({ repository: repository as never, runtimeDir, now: () => now,
    onPairRequest: async () => { prompts++; return { ok: false } } })
  const first = create()
  try {
    await first.startListening()
    for (let i = 0; i < 2; i++) await wire(first.socketPath, { operation: 'pair.request' })
    assert.equal((await stat(join(runtimeDir, 'pair-rate.json'))).mode & 0o777, 0o600)
    await first.revoke()
    const second = create()
    await second.startListening()
    assert.deepEqual(await wire(second.socketPath, { operation: 'pair.request' }), { ok: false, code: 'USER_DECLINED' })
    assert.deepEqual(await wire(second.socketPath, { operation: 'pair.request' }), { ok: false, code: 'BUSY' })
    assert.equal(prompts, 3)
    await second.revoke()
    await writeFile(join(runtimeDir, 'pair-rate.json'), '{invalid')
    const corrupt = create()
    await corrupt.startListening()
    assert.deepEqual(await wire(corrupt.socketPath, { operation: 'pair.request' }), { ok: false, code: 'UNAVAILABLE' })
    assert.equal(prompts, 3)
    await corrupt.revoke()
    await rm(join(runtimeDir, 'pair-rate.json'))
    await symlink(join(root, 'attacker'), join(runtimeDir, 'pair-rate.json'))
    const linked = create()
    await linked.startListening()
    assert.deepEqual(await wire(linked.socketPath, { operation: 'pair.request' }), { ok: false, code: 'UNAVAILABLE' })
    assert.equal(prompts, 3)
    await linked.revoke()
    await rm(join(runtimeDir, 'pair-rate.json'))
    await writeFile(join(runtimeDir, 'pair-rate.json'), JSON.stringify({ version: 1, attempts: [now] }))
    await chmod(join(runtimeDir, 'pair-rate.json'), 0o644)
    const exposed = create()
    await exposed.startListening()
    assert.deepEqual(await wire(exposed.socketPath, { operation: 'pair.request' }), { ok: false, code: 'UNAVAILABLE' })
    assert.equal(prompts, 3)
    await exposed.revoke()
  } finally { await first.revoke(); await rm(root, { recursive: true, force: true }) }
})

udsTest('absolute accept-to-frame deadline closes a continuously trickling peer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worlds-cli-test-'))
  const { repository } = fakeRepository()
  const transport = new WorldsCliTransport({ repository: repository as unknown as ConstructorParameters<typeof WorldsCliTransport>[0]['repository'], runtimeDir: join(root, 'runtime'), frameDeadlineMs: 120 })
  try {
    await transport.beginPairing()
    const started = Date.now()
    await new Promise<void>((resolve, reject) => {
      const socket = connect(transport.socketPath)
      const header = Buffer.alloc(4); header.writeUInt32BE(100)
      let trickle: NodeJS.Timeout | null = null
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error('trickle connection outlived absolute deadline')) }, 800)
      const done = () => { if (trickle) clearInterval(trickle); clearTimeout(timeout); resolve() }
      socket.on('error', () => {})
      socket.on('connect', () => {
        socket.write(header)
        trickle = setInterval(() => { if (!socket.destroyed) socket.write(' ') }, 25)
      })
      socket.once('close', done)
    })
    assert.ok(Date.now() - started < 500)
  } finally { await transport.revoke(); await rm(root, { recursive: true, force: true }) }
})

udsTest('revoke during a bound but pending start waits, invalidates pairing, and leaves no owned listener', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worlds-cli-test-'))
  const { repository } = fakeRepository()
  let bound!: () => void
  let release!: () => void
  const boundPromise = new Promise<void>((resolve) => { bound = resolve })
  const releasePromise = new Promise<void>((resolve) => { release = resolve })
  const transport = new WorldsCliTransport({
    repository: repository as unknown as ConstructorParameters<typeof WorldsCliTransport>[0]['repository'],
    runtimeDir: join(root, 'runtime'),
    listenServer: async (server, path) => {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(path, () => { server.off('error', reject); resolve() })
      })
      bound()
      await releasePromise
    },
  })
  const beginning = transport.beginPairing().then(() => ({ ok: true }), () => ({ ok: false }))
  try {
    await Promise.race([boundPromise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('listen seam not reached')), 300))])
    const revoking = transport.revoke()
    let finished = false
    void revoking.then(() => { finished = true })
    await Promise.resolve()
    assert.equal(finished, false)
    assert.equal(transport.getStatus().running, true)
    release()
    await revoking
    assert.deepEqual(await beginning, { ok: false })
    assert.equal(transport.getStatus().running, false)
    await assert.rejects(stat(transport.socketPath), { code: 'ENOENT' })
  } finally {
    release()
    await beginning
    await transport.revoke()
    await rm(root, { recursive: true, force: true })
  }
})

udsTest('malformed, oversized, truncated, deep, and path-shaped requests fail closed before repository access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worlds-cli-test-'))
  const { calls, repository } = fakeRepository()
  const transport = new WorldsCliTransport({ repository: repository as unknown as ConstructorParameters<typeof WorldsCliTransport>[0]['repository'], runtimeDir: join(root, 'runtime') })
  try {
    const pairing = await transport.beginPairing()
    const paired = await wire(transport.socketPath, { operation: 'pair', code: pairing.code })
    const session = paired.session as string
    for (const projectKey of ['/private', '../outside', '%2e%2e', 'C:\\secret', '\\\\server\\share']) {
      assert.deepEqual(await wire(transport.socketPath, { operation: 'open', session, projectKey }), { ok: false, code: 'INVALID_REQUEST' })
    }
    assert.deepEqual(await wire(transport.socketPath, { operation: 'list', session, extra: 'x' }), { ok: false, code: 'INVALID_REQUEST' })
    assert.deepEqual(await wire(transport.socketPath, { operation: 'query', session, projectKey: A, revision: 3, kind: 'scenes', pageSize: 51 }), { ok: false, code: 'INVALID_REQUEST' })
    assert.deepEqual(await wire(transport.socketPath, { operation: 'list', session: 'bad' }), { ok: false, code: 'UNAUTHORIZED' })
    assert.deepEqual(await wire(transport.socketPath, { operation: 'list', session, scope: 'worlds:write' }), { ok: false, code: 'INVALID_REQUEST' })
    assert.deepEqual(calls, { list: 0, open: 0, query: 0 })
    const oversized = Buffer.alloc(4); oversized.writeUInt32BE(8193)
    await malformedFrame(transport.socketPath, oversized)
    const truncated = Buffer.alloc(4); truncated.writeUInt32BE(10)
    await malformedFrame(transport.socketPath, Buffer.concat([truncated, Buffer.from('{')]))
    const deep = Array.from({ length: 32 }, () => '[').join('') + '0' + Array.from({ length: 32 }, () => ']').join('')
    const body = Buffer.from(deep); const length = Buffer.alloc(4); length.writeUInt32BE(body.length)
    await malformedFrame(transport.socketPath, Buffer.concat([length, body]))
    const malformed = Buffer.from('{'); const malformedLength = Buffer.alloc(4); malformedLength.writeUInt32BE(malformed.length)
    await malformedFrame(transport.socketPath, Buffer.concat([malformedLength, malformed]))
    const duplicate = Buffer.from(`{"operation":"list","operation":"list","session":"${session}"}`)
    const duplicateLength = Buffer.alloc(4); duplicateLength.writeUInt32BE(duplicate.length)
    await malformedFrame(transport.socketPath, Buffer.concat([duplicateLength, duplicate]))
    assert.deepEqual(calls, { list: 0, open: 0, query: 0 })
  } finally { await transport.revoke(); await rm(root, { recursive: true, force: true }) }
})

test('stale socket path is never unlinked or adopted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worlds-cli-test-'))
  const runtimeDir = join(root, 'runtime')
  const { repository } = fakeRepository()
  try {
    await mkdir(runtimeDir, { mode: 0o700 })
    await writeFile(join(runtimeDir, 'worlds.sock'), 'stale', { mode: 0o600 })
    const transport = new WorldsCliTransport({ repository: repository as unknown as ConstructorParameters<typeof WorldsCliTransport>[0]['repository'], runtimeDir })
    await assert.rejects(transport.beginPairing(), /already exists/)
    assert.equal(transport.running, false)
    assert.equal(await readFile(join(runtimeDir, 'worlds.sock'), 'utf8'), 'stale')
  } finally { await rm(root, { recursive: true, force: true }) }
})

udsTest('canonical Python source CLI reads list/open/two pages without exposing its session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worlds-cli-test-'))
  const { repository } = fakeRepository()
  const transport = new WorldsCliTransport({ repository: repository as unknown as ConstructorParameters<typeof WorldsCliTransport>[0]['repository'], runtimeDir: join(root, 'modly-worlds-cli') })
  try {
    const pairing = await transport.beginPairing()
    const paired = await wire(transport.socketPath, { operation: 'pair', code: pairing.code })
    const session = paired.session as string
    await writeFile(join(root, 'modly-worlds-cli', 'session.json'), JSON.stringify({ session }), { mode: 0o600 })
    const cli = async (args: string[]) => {
      const { stdout, stderr } = await execFileAsync('python3', ['tools/modly-cli/agent.py', '--compact', 'world', ...args],
        { cwd: process.cwd(), env: { ...process.env, XDG_RUNTIME_DIR: root }, timeout: 5000 })
      assert.equal(stderr.includes(session), false)
      assert.equal(stdout.includes(session), false)
      assert.equal(stdout.includes(pairing.code), false)
      return JSON.parse(stdout) as Record<string, unknown>
    }
    const listed = await cli(['project', 'list'])
    assert.equal(listed.ok, true)
    assert.equal(JSON.stringify(listed).includes('/private'), false)
    const opened = await cli(['project', 'open', A])
    assert.equal(opened.ok, true)
    assert.equal(JSON.stringify(opened).includes('snapshot'), false)
    const first = await cli(['query', A, '--revision', '3', '--kind', 'scenes', '--page-size', '1'])
    assert.equal(first.ok, true)
    const cursor = (first.page as Record<string, unknown>).nextCursor as string
    const second = await cli(['query', A, '--revision', '3', '--kind', 'scenes', '--page-size', '1', '--cursor', cursor])
    assert.equal(second.ok, true)
    assert.equal((second.page as Record<string, unknown>).nextCursor, null)
  } finally { await transport.revoke(); await rm(root, { recursive: true, force: true }) }
})

udsTest('paired UDS plan, delivered query and typed proposal issue only a nonauthorizing receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worlds-cli-plan-uds-'))
  const repository = new WorldProjectRepository({ getWorkspaceRoot: () => root })
  const created = await repository.create({ name: 'UDS proposal', initialSceneName: 'Start' })
  assert.equal(created.ok, true)
  if (!created.ok) return
  const { projectKey, snapshot } = created.value
  const trustedWindow = { id: 'uds-test-window', contents: {}, frame: {} }
  const transport = new WorldsCliTransport({ repository, runtimeDir: join(root, 'modly-worlds-cli'),
    captureTrust: () => ({ window: trustedWindow, contents: trustedWindow.contents, frame: trustedWindow.frame,
      documentUrl: 'file:///trusted/index.html', documentEpoch: 0, workspaceRoot: root }) })
  try {
    const pairing = await transport.beginPairing()
    const paired = await wire(transport.socketPath, { operation: 'pair', code: pairing.code })
    const session = paired.session as string
    assert.equal(paired.scope, 'worlds:read')
    assert.equal(paired.proposalScope, 'worlds:auto-apply')
    assert.equal((transport as unknown as { directEditBudget: { admitted: number } | null }).directEditBudget?.admitted, 0)
    const planned = await wire(transport.socketPath, { operation: 'plan', session, projectKey, sceneId: snapshot.project.startSceneId })
    assert.equal(planned.ok, true)
    const planId = planned.planId as string
    const page = await wire(transport.socketPath, { operation: 'query', session, projectKey, revision: 0, kind: 'project', planId })
    assert.equal(page.ok, true)
    assert.deepEqual(await wire(transport.socketPath, { operation: 'ack', session, projectKey, planId, deliveryId: page.deliveryId }), { ok: true })
    const receipt = await wire(transport.socketPath, { operation: 'propose', session, projectKey, planId,
      json: '{"commands":[{"type":"create-scene","localRef":"new","name":"New Scene"}]}' })
    assert.equal(receipt.ok, true, JSON.stringify(receipt))
    assert.equal(receipt.status, 'pending-human-review')
    assert.equal(JSON.stringify(receipt).includes('snapshot'), false)
    assert.equal(JSON.stringify(receipt).includes('batch'), false)
    assert.deepEqual(await wire(transport.socketPath, { operation: 'apply', session, proposalId: receipt.proposalId }), { ok: false, code: 'UNSUPPORTED' })
    const opened = await repository.open({ projectKey })
    assert.equal(opened.ok, true)
    if (opened.ok && opened.value.status === 'ready') assert.deepEqual(opened.value.snapshot, snapshot)
    await writeFile(join(root, 'modly-worlds-cli', 'session.json'), JSON.stringify({ session }), { mode: 0o600 })
    const cli = (args: string[], input = '') => new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = spawn('python3', ['tools/modly-cli/agent.py', '--compact', 'world', ...args],
        { cwd: process.cwd(), env: { ...process.env, XDG_RUNTIME_DIR: root }, timeout: 5000 })
      let stdout = ''; let stderr = ''
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
      child.on('error', reject)
      child.on('close', (code) => {
        try {
          assert.equal(code, 0, `${stdout}\n${stderr}`)
          assert.equal(stdout.includes(session), false)
          assert.equal(stderr.includes(session), false)
          resolve(JSON.parse(stdout) as Record<string, unknown>)
        } catch (error) { reject(error) }
      })
      child.stdin.end(input)
    })
    const cliPlan = await cli(['plan', projectKey, '--scene-id', snapshot.project.startSceneId])
    assert.equal(cliPlan.ok, true)
    const cliQuery = await cli(['query', projectKey, '--revision', '0', '--kind', 'project', '--plan', cliPlan.planId as string])
    assert.equal(cliQuery.ok, true)
    assert.equal(JSON.stringify(cliQuery).includes('deliveryId'), false)
    const cliReceipt = await cli(['propose', projectKey, '--plan', cliPlan.planId as string, '--json', '-'],
      '{"commands":[{"type":"create-scene","localRef":"other","name":"Another Scene"}]}')
    assert.equal(cliReceipt.ok, true, JSON.stringify(cliReceipt))
    assert.equal(JSON.stringify(cliReceipt).includes('batch'), false)
    await transport.beginPairing()
    assert.equal((transport as unknown as { directEditBudget: unknown }).directEditBudget, null)
    await transport.revoke()
    assert.equal(transport.running, false)
  } finally { await transport.revoke(); await rm(root, { recursive: true, force: true }) }
})

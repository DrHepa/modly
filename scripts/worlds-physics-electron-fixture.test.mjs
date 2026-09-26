import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import test from 'node:test'

const source = (file) => readFile(new URL(`./worlds-physics-electron-fixture/${file}`, import.meta.url), 'utf8')

// Synthetic browser/viewport and physics/audio ports; editor, service, disk repository,
// ProjectBar, graphics lease/boundary and Play lifecycle are production implementations.
function mountPhysicsGraphicsHost() {
  const Reconciler = createRequire(import.meta.url)('react-reconciler')
  const append = (parent, child) => { parent.children.push(child) }
  const remove = (parent, child) => { parent.children.splice(parent.children.indexOf(child), 1) }
  const node = (type, props) => ({ type, props, children: [] })
  const renderer = Reconciler({
    now: performance.now.bind(performance), supportsMutation: true, isPrimaryRenderer: true,
    getRootHostContext: () => null, getChildHostContext: () => null, getPublicInstance: value => value,
    prepareForCommit: () => null, resetAfterCommit() {}, shouldSetTextContent: () => false,
    createInstance: node, createTextInstance: text => node('#text', { text }),
    appendInitialChild: append, appendChild: append, appendChildToContainer: append,
    removeChild: remove, removeChildFromContainer: remove, clearContainer: value => { value.children = [] },
    insertBefore: append, insertInContainerBefore: append, finalizeInitialChildren: () => false,
    prepareUpdate: () => true, commitUpdate: (value, _payload, _type, _old, props) => { value.props = props },
    commitTextUpdate: (value, _old, text) => { value.props.text = text },
    scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1, getCurrentEventPriority: () => 1,
    detachDeletedInstance() {}, supportsMicrotasks: true, scheduleMicrotask: queueMicrotask,
  })
  const container = node('root', {})
  const root = renderer.createContainer(container, 0, null, false, null, '', () => {}, null)
  const find = (value, predicate) => predicate(value) ? value : value.children.map(child => find(child, predicate)).find(Boolean)
  return {
    container, find: predicate => find(container, predicate),
    render: element => { renderer.flushSync(() => renderer.updateContainer(element, root, null, null)); renderer.flushPassiveEffects() },
    flush: () => { renderer.flushSync(() => {}); renderer.flushPassiveEffects() },
  }
}

function graphicsGate() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function mountedPhysicsGraphics(t, { custom = true, holdList = false } = {}) {
  const { build } = await import('esbuild')
  const { WorldProjectRepository } = await import('../electron/main/world-project-repository.ts')
  const { createPhysicsFixtureBatches } = await import('./worlds-physics-electron-fixture/scene.ts')
  const { PROJECT_KEY, SCENE_KEY } = await import('./worlds-physics-electron-fixture/shared.ts')
  const repo = path.resolve(import.meta.dirname, '..')
  const root = await mkdtemp('/tmp/modly-physics-graphics-mounted-')
  const workspace = path.join(root, 'workspace')
  const repository = new WorldProjectRepository({ getWorkspaceRoot: () => workspace, createProjectKey: () => PROJECT_KEY, createSceneKey: () => SCENE_KEY })
  const created = await repository.create({ name: 'Mounted physics quality', initialSceneName: 'Course' })
  assert.ok(created.ok)
  let baseline = created.value.snapshot
  for (const batch of createPhysicsFixtureBatches(baseline, PROJECT_KEY)) {
    const applied = await repository.applyCommands({ projectKey: PROJECT_KEY, batch })
    assert.ok(applied.ok); baseline = applied.value.snapshot
  }
  if (custom) {
    const applied = await repository.applyCommands({ projectKey: PROJECT_KEY, batch: {
      schema: 'modly.world-command-batch.v1', transactionId: 'tx:graphics-test-profiles', origin: 'ui',
      projectId: baseline.project.projectId, baseRevision: baseline.project.revision,
      commands: [{ type: 'replace-graphics-profiles', activeGraphicsProfileId: 'graphics:balanced', graphicsProfiles: [
        { id: 'graphics:balanced', name: 'Balanced', renderScale: 1, shadowQuality: 'medium', antialiasing: 'fxaa' },
        { id: 'graphics:custom', name: 'Custom', renderScale: 0.5, shadowQuality: 'off', antialiasing: 'off' },
      ] }],
    } })
    assert.ok(applied.ok); baseline = applied.value.snapshot
  }
  const host = mountPhysicsGraphicsHost(), listGate = holdList ? graphicsGate() : null
  const state = { host, calls: [], nextApply: null, created: 0, disposed: 0, audioStopped: 0 }
  const api = {
    list: async () => { await listGate?.promise; return repository.list() },
    open: request => repository.open(request),
    applyCommands: async request => {
      state.calls.push(structuredClone(request.batch))
      const operation = state.nextApply; state.nextApply = null
      return operation ? operation(request) : repository.applyCommands(request)
    },
  }
  const globals = new Map(['window', 'document', '__physicsGraphicsMounted'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const listeners = new Map()
  Object.assign(globalThis, {
    __physicsGraphicsMounted: state,
    window: { electron: { workspace: { worlds: { projects: api } } }, worldsFixtureEnvironment: {} },
    document: { getElementById: () => ({}), addEventListener: (kind, fn) => listeners.set(kind, fn), removeEventListener: (kind, fn) => { if (listeners.get(kind) === fn) listeners.delete(kind) } },
  })
  const settle = async (predicate = () => true) => {
    for (let tick = 0; tick < 200; tick += 1) {
      await new Promise(resolve => setTimeout(resolve, 2)); host.flush()
      if (tick >= 2 && predicate()) return
    }
    assert.fail('Mounted fixture did not settle within the fixed test poll bound.')
  }
  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    listGate?.resolve(); host.render(null); await settle()
    assert.equal(listeners.size, 0, 'Native recorder listeners must be released on unmount.')
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    console.log(`Synthetic physics graphics evidence retained: ${root}`)
  }
  t.after(cleanup)
  const runtime = path.join(repo, 'src/areas/worlds/runtime')
  const mocks = new Map([
    ['react-dom/client', `export function createRoot() { return { render(element) { globalThis.__physicsGraphicsMounted.host.render(element) } } }`],
    ['@react-three/fiber', `export function useThree() { throw new Error('Canvas execution is outside this mounted test.') }`],
    ['css', ''],
    [path.join(repo, 'src/areas/worlds/components/WorldRuntimeViewport.tsx'), `import React from 'react'; export default function Viewport(props) { return React.createElement('synthetic-viewport', props) }`],
    [path.join(runtime, 'worldPhysicsRuntime.ts'), `export function createBrowserWorldPhysicsRuntime() {
      const h = globalThis.__physicsGraphicsMounted; h.created += 1;
      return { async initialize() {}, step() { throw new Error('Physics steps are outside this mounted test.') }, pause() {}, resume() {}, dispose() { h.disposed += 1 } }
    }`],
    [path.join(runtime, 'worldAudioRuntime.ts'), `export function createBrowserWorldAudioAuthority() {
      const h = globalThis.__physicsGraphicsMounted;
      return { async prepareScene() {}, async activate() {}, async play() {}, async stopSource() {}, update() {}, async pause() {}, async resume() {}, async stop() { h.audioStopped += 1 } }
    }`],
  ])
  await symlink(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir')
  const bundled = await build({
    entryPoints: [path.join(repo, 'scripts/worlds-physics-electron-fixture/renderer.tsx')],
    bundle: true, write: false, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic',
    tsconfig: path.join(repo, 'tsconfig.web.json'), metafile: true,
    plugins: [{ name: 'physics-graphics-browser-ports', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        const key = args.path.endsWith('.css') ? 'css' : args.path.startsWith('.') ? path.resolve(args.resolveDir, args.path) : args.path
        return mocks.has(key) ? { path: key, namespace: 'physics-graphics-port' } : undefined
      })
      builder.onLoad({ filter: /.*/, namespace: 'physics-graphics-port' }, args => ({ contents: mocks.get(args.path), loader: 'js', resolveDir: repo }))
    } }],
  })
  const outfile = path.join(root, 'mounted.mjs')
  await writeFile(outfile, bundled.outputFiles[0].text)
  await writeFile(path.join(root, 'metafile.json'), JSON.stringify(bundled.metafile, null, 2))
  const inputs = Object.keys(bundled.metafile.inputs)
  for (const real of ['useWorldEditorController.ts', 'worldEditorController.ts', 'worldProjectService.ts', 'worldPlayController.ts', 'WorldsProjectBar.tsx']) {
    assert.ok(inputs.some(input => !input.startsWith('physics-graphics-port:') && input.endsWith(`/${real}`)), `Real ${real} must remain in the mounted graph.`)
  }
  let mountError = null
  try { await import(pathToFileURL(outfile).href) } catch (error) { mountError = error }
  assert.equal(mountError, null, 'The real fixture entry must mount without missing graphics props.')
  const node = label => host.find(value => value.props['aria-label'] === label && (label !== 'Rendering quality' || value.type === 'select'))
  const view = () => JSON.parse(host.find(value => value.props.id === 'physics-fixture-state').props.children)
  if (!holdList) await settle(() => !!node('Rendering quality') && !view().initializing)
  return { state, host, node, view, settle, cleanup, baseline, repository, PROJECT_KEY, listGate, listeners,
    choose: value => node('Rendering quality').props.onChange({ currentTarget: { value } }),
    reopen: () => new WorldProjectRepository({ getWorkspaceRoot: () => workspace }).open({ projectKey: PROJECT_KEY }),
    ledger: async () => JSON.parse(await readFile(path.join(workspace, 'Worlds', PROJECT_KEY, '.modly/state.v1.json'), 'utf8')),
  }
}

test('physics graphics mounted loading shell exposes no fabricated quality controls', async t => {
  const h = await mountedPhysicsGraphics(t, { holdList: true })
  assert.equal(h.node('Rendering quality'), undefined); assert.equal(h.node('Play World'), undefined)
  assert.equal(h.view().editorSession, null); assert.equal(h.state.calls.length, 0)
  h.listGate.resolve(); await h.settle(() => !!h.node('Rendering quality') && !h.view().initializing)
  assert.equal(h.node('Rendering quality').props.value, 'profile:graphics:balanced')
  assert.deepEqual(h.view().editorSession.snapshot, h.baseline)
})

test('physics graphics mounted profiles persist existing selections and both presets', async t => {
  const h = await mountedPhysicsGraphics(t)
  const quality = h.node('Rendering quality')
  assert.equal(quality.props.value, 'profile:graphics:balanced')
  assert.deepEqual(quality.children.filter(child => child.props.value?.startsWith('profile:')).map(child => child.props.value), ['profile:graphics:balanced', 'profile:graphics:custom'])
  h.choose('profile:graphics:balanced'); await h.settle(); assert.equal(h.state.calls.length, 0)
  for (const [index, value] of ['profile:graphics:custom', 'preset:integrated', 'preset:dedicated'].entries()) {
    h.choose(value); await h.settle(() => h.view().savedRevision === h.baseline.project.revision + index + 1 && !h.node('Rendering quality').props['aria-busy'])
    assert.equal(h.node('Rendering quality').props.value, `profile:graphics:${['custom', 'integrated', 'dedicated'][index]}`)
    const reopened = await h.reopen(); assert.ok(reopened.ok && reopened.value.status === 'ready')
    assert.deepEqual(reopened.value.snapshot, h.view().editorSession.snapshot)
    h.choose(h.node('Rendering quality').props.value); await h.settle(); assert.equal(h.state.calls.length, index + 1)
  }
  assert.deepEqual(h.state.calls.map(batch => [batch.origin, batch.baseRevision, batch.commands[0].type]), [14, 15, 16].map(revision => ['ui', revision, 'replace-graphics-profiles']))
  assert.ok(h.state.calls.every(batch => batch.transactionId.startsWith('tx:ui-graphics-profile-')))
  assert.deepEqual([h.view().editorSession.undoStack.length, h.view().editorSession.receipts.length], [3, 3])
  const ledger = await h.ledger(); assert.equal(ledger.committedRevision, 17); assert.equal(ledger.transactions.length, 17)
})

test('physics graphics mounted pending selection excludes duplicate and Play admission', async t => {
  const h = await mountedPhysicsGraphics(t), gate = graphicsGate()
  h.state.nextApply = async request => { await gate.promise; return h.repository.applyCommands(request) }
  const select = h.node('Rendering quality').props.onChange, play = h.node('Play World').props.onClick
  select({ currentTarget: { value: 'preset:dedicated' } })
  select({ currentTarget: { value: 'preset:integrated' } }); play()
  await h.settle(() => h.state.calls.length === 1)
  assert.equal(h.node('Rendering quality').props['aria-busy'], 'true'); assert.equal(h.node('Play World').props.disabled, true)
  assert.equal(h.state.created, 0); assert.equal(h.view().playLifecycle, 'edit')
  gate.resolve(); await h.settle(() => !h.node('Rendering quality').props.disabled)
  assert.equal(h.state.calls.length, 1); assert.equal(h.node('Play World').props.disabled, false)
  play(); select({ currentTarget: { value: 'preset:integrated' } })
  await h.settle(() => h.view().playLifecycle === 'playing')
  assert.equal(h.state.created, 1); assert.equal(h.state.calls.length, 1)
})

test('physics graphics mounted failures and stale persistence clear pending state', async t => {
  for (const mode of ['write-failed', 'transport-throw', 'stale']) {
    const h = await mountedPhysicsGraphics(t)
    h.state.nextApply = async request => {
      if (mode === 'write-failed') return { ok: false, error: { code: 'write_failed', message: 'Synthetic write failure.', retryable: false } }
      if (mode === 'transport-throw') throw new Error('Synthetic transport failure.')
      const peer = await h.repository.applyCommands({ ...request, batch: { ...request.batch, transactionId: 'tx:graphics-peer', commands: [{ type: 'replace-graphics-profiles', graphicsProfiles: h.baseline.project.graphicsProfiles, activeGraphicsProfileId: 'graphics:custom' }] } })
      assert.ok(peer.ok); return h.repository.applyCommands(request)
    }
    h.choose('preset:dedicated'); await h.settle(() => h.view().editorLifecycle === 'error' && !h.node('Rendering quality').props['aria-busy'])
    assert.equal(h.state.calls.length, 1); assert.ok(h.view().error)
    assert.deepEqual(h.view().editorSession.snapshot, h.baseline)
    assert.equal(h.node('Rendering quality').props.disabled, false)
    h.choose('profile:graphics:missing'); await h.settle()
    assert.match(h.view().error, /does not exist/); assert.equal(h.state.calls.length, 1)
    await h.cleanup()
  }
})

test('physics graphics mounted current graphics failure stops Play and stays terminal', async t => {
  const h = await mountedPhysicsGraphics(t), play = h.node('Play World').props.onClick
  const select = h.node('Rendering quality').props.onChange
  play(); await h.settle(() => h.view().playLifecycle === 'playing')
  const viewport = h.host.find(value => value.type === 'synthetic-viewport')
  assert.equal(typeof viewport.props.onGraphicsFailure, 'function')
  viewport.props.onGraphicsFailure({ kind: 'context-lost', message: 'Synthetic owned context loss.' })
  play(); select({ currentTarget: { value: 'preset:dedicated' } })
  await h.settle(() => h.view().playLifecycle === 'edit' && h.view().physics.audioCloseCompleted === 1)
  assert.equal(h.node('Rendering quality').props.disabled, true); assert.equal(h.node('Play World').props.disabled, true)
  assert.equal(h.node('Retry viewport').props.disabled, true)
  assert.deepEqual([h.state.created, h.state.disposed, h.state.audioStopped, h.state.calls.length], [1, 1, 1, 0])
  assert.equal(h.view().runtimeSnapshotPresent, false); assert.equal(h.view().physics.disposedCount, 1)
  assert.match(h.view().error, /context-lost.*Synthetic owned context loss/)
  const before = h.view(); viewport.props.onGraphicsFailure({ kind: 'render-error', message: 'Stale failure.' }); await h.settle()
  assert.deepEqual(h.view(), before); assert.deepEqual(h.view().editorSession.snapshot, h.baseline)
})

test('physics graphics mounted ordinary errors and stale leases preserve graphics availability', async t => {
  const h = await mountedPhysicsGraphics(t, { custom: false })
  assert.equal(h.baseline.project.revision, 13)
  h.node('Play World').props.onClick(); await h.settle(() => h.view().playLifecycle === 'playing')
  const viewport = h.host.find(value => value.type === 'synthetic-viewport')
  assert.equal(typeof viewport.props.onGraphicsFailure, 'function')
  viewport.props.onError('Synthetic ordinary runtime error.'); await h.settle()
  assert.equal(h.view().playLifecycle, 'playing'); assert.equal(h.state.disposed, 0)
  h.node('Pause World').props.onClick(); await h.settle(() => h.view().playLifecycle === 'paused')
  h.node('Resume World').props.onClick(); await h.settle(() => h.view().playLifecycle === 'playing')
  h.node('Stop World').props.onClick(); await h.settle(() => h.view().physics.audioCloseCompleted === 1)
  viewport.props.onGraphicsFailure({ kind: 'context-lost', message: 'Retired viewport.' }); await h.settle()
  assert.equal(h.view().error, 'Synthetic ordinary runtime error.')
  assert.equal(h.node('Rendering quality').props.disabled, false); assert.equal(h.node('Play World').props.disabled, false)
  assert.equal(h.state.calls.length, 0); assert.deepEqual(h.view().editorSession.snapshot, h.baseline)
  const reopened = await h.reopen(); assert.ok(reopened.ok && reopened.value.status === 'ready')
  assert.deepEqual(reopened.value.snapshot, h.baseline); assert.equal((await h.ledger()).committedRevision, 13)
})

test('physics graphics mounted unmount revokes pending callbacks and input ownership', async t => {
  const h = await mountedPhysicsGraphics(t), gate = graphicsGate()
  h.state.nextApply = async request => { await gate.promise; return h.repository.applyCommands(request) }
  const select = h.node('Rendering quality').props.onChange, play = h.node('Play World').props.onClick
  select({ currentTarget: { value: 'preset:integrated' } }); await h.settle(() => h.state.calls.length === 1)
  assert.ok(h.listeners.size > 0); h.host.render(null); assert.equal(h.listeners.size, 0)
  gate.resolve(); await h.settle()
  select({ currentTarget: { value: 'preset:dedicated' } }); play(); await h.settle()
  assert.equal(h.state.calls.length, 1); assert.equal(h.state.created, 0); assert.deepEqual(h.host.container.children, [])
})

test('acceptance model seed authors 504 bodies in 23 durable canonical transactions', async t => {
  const { WorldProjectRepository } = await import('../electron/main/world-project-repository.ts')
  const { createWorldProjectService } = await import('../src/areas/worlds/worldProjectService.ts')
  const { createWorldEditorController } = await import('../src/areas/worlds/editor/worldEditorController.ts')
  const { projectWorldRuntimeScene } = await import('../src/areas/worlds/runtime/worldRuntimeProjection.ts')
  const { createPhysicsFixtureBatches } = await import('./worlds-physics-electron-fixture/scene.ts')
  const { authorWorkerFixtureCourse } = await import('./worlds-physics-electron-fixture/worker-contract.ts')
  const { captureWorkerProjectFiles } = await import('./worlds-physics-electron-fixture/worker-driver.ts')
  const { PROJECT_KEY, SCENE_KEY } = await import('./worlds-physics-electron-fixture/shared.ts')
  const workspace = await mkdtemp('/tmp/modly-physics-acceptance-seed-')
  try {
    const repository = new WorldProjectRepository({ getWorkspaceRoot: () => workspace, createProjectKey: () => PROJECT_KEY, createSceneKey: () => SCENE_KEY })
    const created = await repository.create({ name: 'Acceptance model seed', initialSceneName: 'Course' })
    assert.ok(created.ok)
    const legacy = createPhysicsFixtureBatches(created.value.snapshot, PROJECT_KEY)
    const batches = createPhysicsFixtureBatches(created.value.snapshot, PROJECT_KEY, 'acceptance-500')
    assert.equal(batches.length, 23, 'The optional acceptance seed must append ten batches to the real course.')
    assert.deepEqual(batches.slice(0, 13), legacy)
    assert.ok(batches.slice(13).every((batch, index) => batch.commands.length === 50 && batch.commands.every(command => command.type === 'add-entity')
      && batch.transactionId === `tx:physics-load-${String(index + 1).padStart(2, '0')}`))
    const editor = createWorldEditorController(createWorldProjectService(repository))
    const session = await authorWorkerFixtureCourse(editor, 'acceptance-500')
    const { snapshot } = session
    assert.deepEqual([snapshot.project.revision, session.undoStack.length, session.receipts.length, session.redoStack.length], [23, 23, 23, 0])
    assert.equal(snapshot.scenes[0].entities.length, 505); assert.equal(snapshot.project.resources.length, 0)
    const projection = projectWorldRuntimeScene(snapshot, snapshot.project.startSceneId)
    assert.ok(projection.success, JSON.stringify(projection)); assert.equal(projection.value.physics.bodies.length, 504)
    for (let n = 0; n < 500; n += 1) {
      const suffix = String(n).padStart(3, '0'), body = projection.value.physics.bodies[n + 4]
      assert.equal(body.entityId, `entity:physics-load-${suffix}`)
      assert.deepEqual(body.position, [-8 + 0.5 * (n % 10), 0.3 + 0.5 * Math.floor(n / 100), 0.5 + 0.5 * (Math.floor(n / 10) % 10)])
      assert.equal(body.bodyType, 'dynamic'); assert.equal(body.canSleep, false)
      assert.deepEqual([body.gravityScale, body.linearDamping, body.angularDamping], [1, 0, 0])
      assert.deepEqual(body.rotation, [0, 0, 0, 1])
      assert.deepEqual(body.colliders[0].shape, { kind: 'box', halfExtents: [0.2, 0.2, 0.2] })
      assert.deepEqual(snapshot.scenes[0].entities[n + 5].components.map(component => component.id), [`rigid-body:physics-load-${suffix}`, `collider:physics-load-${suffix}`])
      assert.deepEqual([body.colliders[0].friction, body.colliders[0].restitution], [0.5, 0])
      assert.equal(body.colliders[0].sensor, false)
    }
    const root = path.join(workspace, 'Worlds', PROJECT_KEY), before = await captureWorkerProjectFiles(root)
    const ledger = JSON.parse(await readFile(path.join(root, '.modly/state.v1.json'), 'utf8'))
    assert.equal(ledger.committedRevision, 23); assert.equal(ledger.transactions.length, 23)
    const reopened = await new WorldProjectRepository({ getWorkspaceRoot: () => workspace }).open({ projectKey: PROJECT_KEY })
    assert.ok(reopened.ok && reopened.value.status === 'ready'); assert.deepEqual(reopened.value.snapshot, snapshot)
    assert.deepEqual(await captureWorkerProjectFiles(root), before); assert.deepEqual(editor.getState().session, session)
    t.diagnostic(JSON.stringify({ workspace, files: before.length, bytes: before.reduce((sum, file) => sum + file.bytes, 0), largestFileBytes: Math.max(...before.map(file => file.bytes)), bodies: 504, revision: 23, defaultSync: true }))
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

async function acceptanceModel(phase = 'timing') {
  const { PhysicsAcceptanceObservation } = await import('./worlds-physics-electron-fixture/observation.ts')
  const ids = [...Array.from({ length: 4 }, (_, n) => `entity:course-${n}`), ...Array.from({ length: 500 }, (_, n) => `entity:physics-load-${String(n).padStart(3, '0')}`)]
  const model = new PhysicsAcceptanceObservation(phase, ids)
  model.beginCycle(0, 1)
  let sequence = 0, time = 0
  const request = (count = 1, seq = sequence++) => ({ sequence: seq, steps: Array.from({ length: count }, () => ({ characters: [], impulses: [] })) })
  const reply = (req, generationId = 1) => ({ generationId, sequence: req.sequence, entityIds: [...ids], triggerEvents: [],
    transforms: Float32Array.from({ length: ids.length * 7 }, (_, n) => n % 7 === 6 ? 1 : 0),
    stepTimings: req.steps.map((_, substep) => ({ substep, solverMs: 1, physicsStepMs: 3 })) })
  const frame = (droppedMs = 0) => ({ sentMs: time, lagMs: 0, droppedMs })
  const accept = (count = 4, droppedMs = 0) => { const req = request(count); model.posted(1, req, frame(droppedMs)); model.received(reply(req), ++time) }
  return { model, ids, request, reply, frame, accept }
}
const stoppedProof = { lifecycle: 'edit', runtimeSnapshot: null, bodyPoseCount: 0, pendingCount: 0, created: 1, disposed: 1, audioStarted: 1, audioCompleted: 1 }

test('acceptance model profiles and scalar categories preserve padding and generation reset', async () => {
  const { PHYSICS_ACCEPTANCE_PROFILES: profiles } = await import('./worlds-physics-electron-fixture/worker-contract.ts')
  assert.ok(Object.isFrozen(profiles) && Object.isFrozen(profiles.timing) && Object.isFrozen(profiles.ownership))
  assert.deepEqual([profiles.timing.cycles, profiles.timing.warmupSteps, profiles.timing.measuredSteps, profiles.ownership.cycles, profiles.ownership.ownershipSteps], [3, 120, 600, 50, 60])
  assert.deepEqual([profiles.timing.mainDeadlineMs, profiles.timing.driverDeadlineMs, profiles.timing.outerDeadlineMs, profiles.ownership.mainDeadlineMs, profiles.ownership.driverDeadlineMs, profiles.ownership.outerDeadlineMs], [180000, 165000, 190000, 900000, 880000, 910000])
  assert.throws(() => { profiles.timing.cycles = 50 }, TypeError)
  const run = await acceptanceModel()
  for (let n = 0; n < 29; n += 1) run.accept()
  run.accept(3); run.accept(4); run.accept(4, 140)
  for (let n = 0; n < 149; n += 1) run.accept()
  run.accept(3); run.accept(4)
  const view = run.model.view(), rows = view.scalarJsonl.trim().split('\n').map(line => JSON.parse(line)), steps = rows.filter(row => row.type === 'step')
  assert.deepEqual(['warmup', 'warmup-padding', 'recovery', 'measured', 'padding'].map(category => steps.filter(row => row.category === category).length), [120, 3, 4, 600, 3])
  assert.deepEqual(steps.map(row => row.ordinal), Array.from({ length: 730 }, (_, n) => n))
  assert.equal(view.poses.length, 2); assert.equal(view.pendingCount, 0); assert.ok(view.scalarBytes <= 4 * 1024 * 1024)
  assert.ok(rows.filter(row => row.type === 'request').every(row => row.clockSource === 'derived-fixture-clock'))
  view.poses[0].transforms[0] = 99; assert.notEqual(run.model.view().poses[0].transforms[0], 99)
  run.model.stop(1, stoppedProof); assert.equal(run.model.view().poses.length, 0)
  run.model.beginCycle(1, 9)
  const next = run.request(1, 0); run.model.posted(9, next, { sentMs: 1000, lagMs: 0, droppedMs: 0 })
  assert.throws(() => run.model.stop(9, stoppedProof), /incomplete|pending/)
  assert.equal(run.model.view().pendingCount, 0); assert.equal(run.model.view().cancelledRequests, 1)
  assert.ok(run.model.view().scalarJsonl.startsWith(view.scalarJsonl), 'Prior scalar evidence must never be silently discarded.')
})

test('acceptance model rejects malformed ownership timing and Stop observations', async () => {
  for (const kind of ['phase', 'cycle', 'generation', 'zero', 'five', 'sequence', 'single-flight', 'ids', 'count', 'substep', 'nan', 'negative', 'infinite', 'clock', 'drop']) {
    if (kind === 'phase') { await assert.rejects(acceptanceModel('other')); continue }
    const run = await acceptanceModel(), req = run.request()
    assert.throws(() => {
      if (kind === 'cycle') return run.model.beginCycle(2, 2)
      if (kind === 'generation') return run.model.posted(2, req, run.frame())
      if (kind === 'zero' || kind === 'five') return run.model.posted(1, run.request(kind === 'zero' ? 0 : 5), run.frame())
      if (kind === 'sequence') return run.model.posted(1, { ...req, sequence: -1 }, run.frame())
      run.model.posted(1, req, run.frame(kind === 'drop' ? 1 : 0))
      if (kind === 'single-flight') return run.model.posted(1, run.request(), run.frame())
      const snapshot = run.reply(req)
      if (kind === 'ids') snapshot.entityIds.reverse()
      if (kind === 'count') snapshot.stepTimings.push({ substep: 1, solverMs: 1, physicsStepMs: 3 })
      if (kind === 'substep') snapshot.stepTimings[0].substep = 1
      if (kind === 'nan' || kind === 'negative' || kind === 'infinite') snapshot.stepTimings[0].solverMs = kind === 'nan' ? NaN : kind === 'negative' ? -1 : Infinity
      run.model.received(snapshot, kind === 'clock' ? -1 : 1)
    }, undefined, kind)
    assert.ok(run.model.view().error, kind)
  }
  for (const field of ['created', 'disposed', 'audioStarted', 'audioCompleted']) {
    const run = await acceptanceModel('ownership'); for (let n = 0; n < 15; n += 1) run.accept()
    assert.throws(() => run.model.stop(1, { ...stoppedProof, [field]: 0 }), /Stop/)
    assert.equal(run.model.view().pendingCount, 0)
  }
})

test('acceptance model caps scalar bytes without silently deleting prior idle frames', async () => {
  const run = await acceptanceModel('ownership')
  assert.throws(() => { for (let n = 0; n < 100000; n += 1) run.model.idleFrame(1, { sentMs: n, lagMs: 0, droppedMs: 0 }) }, /byte/)
  const view = run.model.view()
  assert.ok(view.scalarBytes <= 4 * 1024 * 1024 && view.scalarBytes > 4 * 1024 * 1024 - 1024)
  assert.equal(new TextEncoder().encode(view.scalarJsonl).length, view.scalarBytes)
  assert.ok(view.scalarJsonl.includes('"sentMs":0'))
  assert.throws(() => run.model.idleFrame(1, { sentMs: 100001, lagMs: 0, droppedMs: 0 }))
  assert.equal(run.model.view().scalarJsonl, view.scalarJsonl)
})

test('acceptance model synthetic ownership cycles reject replay overflow and stale generations', async () => {
  const run = await acceptanceModel('ownership') // Model envelopes only: no Worker, Play or audio is created here.
  for (let cycle = 0; cycle < 50; cycle += 1) {
    const generation = cycle + 1
    if (cycle) run.model.beginCycle(cycle, generation)
    for (let sequence = 0; sequence < 15; sequence += 1) {
      const req = run.request(4, sequence), sentMs = cycle * 100 + sequence * 2
      run.model.posted(generation, req, { sentMs, lagMs: 0, droppedMs: 0 })
      run.model.received(run.reply(req, generation), sentMs + 1)
    }
    run.model.stop(generation, stoppedProof)
  }
  const view = run.model.view()
  assert.equal(view.completedCycles, 50); assert.equal(view.pendingCount, 0); assert.equal(view.error, null)
  assert.equal(view.scalarJsonl.trim().split('\n').filter(line => JSON.parse(line).type === 'step').length, 3000)
  assert.throws(() => run.model.beginCycle(50, 51), /cycle/)
  for (const failure of ['reuse', 'older', 'duplicate-reply', 'stale-reply', 'sparse', 'recovery']) {
    const check = await acceptanceModel(), req = check.request(1, 4)
    check.model.posted(1, req, check.frame()); check.model.received(check.reply(req), 1)
    assert.throws(() => {
      if (failure === 'duplicate-reply' || failure === 'stale-reply') return check.model.received(check.reply(req, failure === 'stale-reply' ? 2 : 1), 2)
      if (failure === 'recovery') {
        for (let sequence = 5; sequence < 124; sequence += 1) { const step = check.request(1, sequence); check.model.posted(1, step, { sentMs: sequence, lagMs: 0, droppedMs: 0 }); check.model.received(check.reply(step), sequence) }
        return check.model.posted(1, check.request(4, 124), { sentMs: 125, lagMs: 0, droppedMs: 0 })
      }
      check.model.posted(1, failure === 'sparse' ? { sequence: 5, steps: Array(1) } : check.request(1, failure === 'reuse' ? 4 : 3), { sentMs: 2, lagMs: 0, droppedMs: 0 })
    }, undefined, failure)
  }
})

test('acceptance model rejects sparse and inherited body IDs before receipt accounting', async () => {
  const { PhysicsAcceptanceObservation } = await import('./worlds-physics-electron-fixture/observation.ts')
  for (const inherited of [false, true]) {
    const run = await acceptanceModel(); run.accept(1)
    const req = run.request(2, 9); run.model.posted(1, req, run.frame())
    const before = run.model.view(), snapshot = run.reply(req), ids = snapshot.entityIds
    delete ids[7]
    if (inherited) Object.setPrototypeOf(ids, Object.assign(Object.create(Array.prototype), { 7: run.ids[7] }))
    assert.throws(() => run.model.received(snapshot, 2), /ID|body/)
    const failed = run.model.view()
    assert.ok(failed.error); assert.equal(failed.scalarJsonl, before.scalarJsonl)
    assert.equal(failed.ordinal, before.ordinal); assert.equal(failed.stage, before.stage)
    assert.deepEqual(failed.poses, before.poses); assert.equal(failed.pendingCount, 1)
    assert.throws(() => run.model.received(run.reply(req), 2))
    assert.throws(() => new PhysicsAcceptanceObservation('timing', ids), /ID|body/)
  }
})

test('acceptance model latches receipt exceptions and rejects replacement replies', async () => {
  for (const failure of ['detached', 'admission', 'parser', 'copy', 'serialization']) {
    const run = await acceptanceModel(); run.accept(1)
    const req = run.request(1, 9); run.model.posted(1, req, run.frame())
    const before = run.model.view(), snapshot = run.reply(req)
    if (failure === 'detached') structuredClone(snapshot.transforms.buffer, { transfer: [snapshot.transforms.buffer] })
    if (failure === 'admission') Object.defineProperty(snapshot, 'transforms', { get() { throw new Error('Admission failure') } })
    if (failure === 'parser') Object.defineProperty(snapshot, 'sequence', { get() { throw new Error('Envelope failure') } })
    if (failure === 'copy') snapshot.transforms.slice = () => { throw new Error('Copy failure') }
    if (failure === 'serialization') {
      const event = { type: 'enter', triggerComponentId: 'trigger:test', otherEntityId: run.ids[0], otherTags: [] }
      Object.defineProperty(event, 'toJSON', { value() { throw new Error('Serialization failure') } })
      snapshot.triggerEvents.push(event)
    }
    assert.throws(() => run.model.received(snapshot, 2), undefined, failure)
    assert.throws(() => run.model.received(run.reply(req), 2), undefined, `${failure} cannot be replaced by a valid reply`)
    const failed = run.model.view()
    assert.ok(failed.error); assert.equal(failed.scalarJsonl, before.scalarJsonl); assert.equal(failed.ordinal, before.ordinal)
    assert.deepEqual(failed.poses, before.poses); assert.equal(failed.pendingCount, 1)
    assert.throws(() => run.model.stop(1, stoppedProof))
    assert.equal(run.model.view().pendingCount, 0); assert.equal(run.model.view().cancelledRequests, 1)
  }
})

test('acceptance model owns exact finite poses and atomically rejects reply overflow', async () => {
  for (const shape of ['short', 'long', 'nan', 'infinite']) {
    const run = await acceptanceModel(), req = run.request(); run.model.posted(1, req, run.frame())
    const snapshot = run.reply(req), before = run.model.view()
    if (shape === 'short' || shape === 'long') snapshot.transforms = new Float32Array(shape === 'short' ? 3527 : 3529)
    else snapshot.transforms[7] = shape === 'nan' ? NaN : Infinity
    let copied = false
    snapshot.transforms.slice = () => { copied = true; return new Float32Array(snapshot.transforms) }
    assert.throws(() => run.model.received(snapshot, 1), undefined, shape)
    assert.equal(copied, false, 'Reject pose shape and nonfinite values before copying')
    assert.ok(run.model.view().error); assert.equal(run.model.view().scalarJsonl, before.scalarJsonl)
    assert.equal(run.model.view().ordinal, before.ordinal); assert.deepEqual(run.model.view().poses, before.poses)
  }
  const run = await acceptanceModel('ownership'), req = run.request(1, 7), snapshot = run.reply(req)
  run.ids[0] = 'entity:mutated-input-manifest'
  run.model.posted(1, req, run.frame()); run.model.received(snapshot, 1)
  snapshot.entityIds[0] = 'entity:mutated-reply'; snapshot.transforms[0] = 99
  const view = run.model.view(); view.poses[0].entityIds[0] = 'entity:mutated-view'; view.poses[0].transforms[0] = 88
  assert.equal(run.model.view().poses[0].entityIds[0], 'entity:course-0'); assert.equal(run.model.view().poses[0].transforms[0], 0)
  const frame = { sentMs: 1, lagMs: 0, droppedMs: 0 }, start = run.model.view().scalarBytes
  run.model.idleFrame(1, frame)
  const bytes = run.model.view().scalarBytes - start, remaining = 4 * 1024 * 1024 - run.model.view().scalarBytes
  for (let n = 0; n < Math.floor((remaining - 250) / bytes); n += 1) run.model.idleFrame(1, frame)
  const last = run.request(4, 15); run.model.posted(1, last, frame)
  const before = run.model.view(), reply = run.reply(last); reply.entityIds[0] = 'entity:course-0'
  assert.throws(() => run.model.received(reply, 2), /byte/)
  const failed = run.model.view()
  assert.equal(failed.scalarJsonl, before.scalarJsonl); assert.equal(failed.scalarBytes, before.scalarBytes)
  assert.equal(failed.ordinal, before.ordinal); assert.deepEqual(failed.poses, before.poses); assert.equal(failed.pendingCount, 1)
})

test('acceptance model predeclares three timing cycle windows across legal packet partitions', async () => {
  const { PHYSICS_ACCEPTANCE_PROFILES: profiles } = await import('./worlds-physics-electron-fixture/worker-contract.ts')
  const policy = profiles.timing.packetBoundaryPolicy
  assert.deepEqual(policy, { declaration: 'terminal-warmup-post', warmupPaddingMax: 3, finalPaddingMax: 3, totalPaddingMax: 6, supersedes: 'final-padding-only-assumption' })
  assert.ok(Object.isFrozen(policy))
  const run = await acceptanceModel(), rows = () => run.model.view().scalarJsonl.trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(rows()[0].profile.packetBoundaryPolicy, policy)
  let clock = 0
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const generation = cycle + 1
    if (cycle) run.model.beginCycle(cycle, generation)
    let ordinal = 0, sequence = 0
    const accept = (count, droppedMs = 0) => {
      const req = run.request(count, sequence += 7), terminal = ordinal < 120 && ordinal + count >= 120
      run.model.posted(generation, req, { sentMs: clock, lagMs: 0, droppedMs })
      if (terminal) {
        const declaration = rows().find(row => row.cycle === cycle && row.type === 'measured-window')
        assert.deepEqual([declaration.sequence, declaration.startOrdinal, declaration.endOrdinal], [req.sequence, ordinal + count + 4, ordinal + count + 604])
        assert.equal(rows().some(row => row.cycle === cycle && row.type === 'receipt' && row.sequence === req.sequence), false)
      }
      const reply = run.reply(req, generation) // Timing values do not exist until after the declaration assertion.
      for (const timing of reply.stepTimings) timing.physicsStepMs = 10 * (cycle + 1)
      run.model.received(reply, ++clock); ordinal += count
    }
    const warmup = cycle === 0 ? Array(30).fill(4) : cycle === 1 ? [...Array(29).fill(4), 3, 4] : [...Array(39).fill(3), 1, 4]
    const measured = cycle === 0 ? Array(150).fill(4) : cycle === 1 ? [...Array(149).fill(4), 3, 4] : [...Array(199).fill(3), 2, 4]
    warmup.forEach(count => accept(count)); accept(4, 140); measured.forEach(count => accept(count))
    const current = rows().filter(row => row.cycle === cycle), steps = current.filter(row => row.type === 'step')
    const declaration = current.find(row => row.type === 'measured-window'), counts = category => steps.filter(row => row.category === category)
    assert.deepEqual(['warmup', 'warmup-padding', 'recovery', 'measured', 'padding'].map(category => counts(category).length), [120, [0, 3, 2][cycle], 4, 600, [0, 3, 3][cycle]])
    assert.deepEqual(counts('measured').map(row => row.ordinal), Array.from({ length: 600 }, (_, n) => declaration.startOrdinal + n))
    assert.equal(declaration.endOrdinal, declaration.startOrdinal + 600)
    assert.deepEqual(steps.map(row => row.ordinal), Array.from({ length: ordinal }, (_, n) => n))
    assert.equal(current.filter(row => row.type === 'measured-window').length, 1)
    assert.ok(current.indexOf(declaration) < current.findIndex(row => row.type === 'receipt' && row.sequence === declaration.sequence))
    run.model.stop(generation, stoppedProof)
  }
  assert.equal(run.model.view().completedCycles, 3); assert.equal(run.model.view().error, null)
})

test('physics fixture accepts build-only and never a native launch or caller-selected output', async () => {
  const { parseBuildArguments } = await import('./worlds-physics-electron-fixture.mjs')
  assert.deepEqual(parseBuildArguments(['--build-only']), { buildOnly: true })
  for (const args of [[], ['--run'], ['--build-only', '--run'], ['--build-only', '--out-dir', '/tmp/existing']]) {
    assert.throws(() => parseBuildArguments(args), /build-only/)
  }
})

test('physics fixture authors four real bodies and a primary camera through the repository command contract', async () => {
  const { WorldProjectRepository } = await import('../electron/main/world-project-repository.ts')
  const { projectWorldRuntimeScene } = await import('../src/areas/worlds/runtime/worldRuntimeProjection.ts')
  const { createPhysicsFixtureBatches } = await import('./worlds-physics-electron-fixture/scene.ts')
  const { PROJECT_KEY, SCENE_KEY, ENTITY_NAMES } = await import('./worlds-physics-electron-fixture/shared.ts')
  const workspace = await mkdtemp('/tmp/modly-worlds-physics-seed-test-')
  const repository = new WorldProjectRepository({ getWorkspaceRoot: () => workspace, createProjectKey: () => PROJECT_KEY, createSceneKey: () => SCENE_KEY })
  const created = await repository.create({ name: 'Physics fixture', initialSceneName: 'Course' })
  assert.ok(created.ok)
  let snapshot = created.value.snapshot
  for (const batch of createPhysicsFixtureBatches(snapshot, PROJECT_KEY)) {
    const applied = await repository.applyCommands({ projectKey: PROJECT_KEY, batch })
    assert.ok(applied.ok, JSON.stringify(applied))
    snapshot = applied.value.snapshot
  }
  const projected = projectWorldRuntimeScene(snapshot, snapshot.project.startSceneId)
  assert.ok(projected.success, JSON.stringify(projected))
  const entities = snapshot.scenes[0].entities
  const id = (name) => entities.find((entity) => entity.name === name).id
  const bodies = projected.value.physics.bodies
  assert.equal(entities.length, 5)
  assert.equal(bodies.length, 4)
  const character = bodies.find((body) => body.entityId === id(ENTITY_NAMES.character))
  assert.equal(character.bodyType, 'kinematic-position')
  assert.deepEqual(character.colliders[0].shape, { kind: 'capsule', radius: 0.35, halfHeight: 0.55 })
  assert.equal(character.controller.speed, 4)
  assert.equal(character.controller.jumpSpeed, 6)
  assert.deepEqual(character.position, [0, 1, 0])
  const sensor = bodies.find((body) => body.entityId === id(ENTITY_NAMES.sensor))
  assert.equal(sensor.bodyType, 'fixed', 'Never replace the anticipated failing sensor with a dynamic body')
  assert.equal(sensor.colliders.length, 1)
  assert.equal(sensor.colliders[0].sensor, true)
  assert.equal(sensor.colliders[0].triggerComponentIds.length, 1)
  assert.equal(bodies.find((body) => body.entityId === id(ENTITY_NAMES.platform)).bodyType, 'fixed')
  assert.equal(snapshot.project.resources.length, 0, 'This lane neither fetches assets nor claims visual mesh proof')
  assert.deepEqual(snapshot.project.inputActions.find((action) => action.id === character.controller.moveActionId).bindings.map((binding) => binding.control), ['KeyA', 'KeyD', 'KeyW', 'KeyS'])
  const reopened = await new WorldProjectRepository({ getWorkspaceRoot: () => workspace }).open({ projectKey: PROJECT_KEY })
  assert.ok(reopened.ok && reopened.value.status === 'ready')
  assert.deepEqual(reopened.value.snapshot, snapshot)
  console.log(`Physics seed evidence retained: ${workspace}`)
})

test('physics observations reject missing, stale, duplicate and wrong-body acknowledgements instead of inventing progress', async () => {
  const { PhysicsObservation } = await import('./worlds-physics-electron-fixture/observation.ts')
  const make = () => {
    const value = new PhysicsObservation()
    value.created(1)
    value.initialized(1, { sceneId: 'scene:test', gravity: [0, -9.81, 0], bodies: [{ entityId: 'entity:hero' }] })
    value.posted(1, { sequence: 1, steps: [{ characters: [], impulses: [] }] })
    return value
  }
  const snapshot = { generationId: 1, sequence: 1, entityIds: ['entity:hero'], transforms: new Float32Array([0, 1, 0, 0, 0, 0, 1]), triggerEvents: [] }
  const value = make()
  let acknowledged = false
  const waiting = value.waitForLatestAcknowledgement(100).then(() => { acknowledged = true })
  await Promise.resolve()
  assert.equal(acknowledged, false, 'Posting is not Worker completion')
  value.received(snapshot)
  await waiting
  assert.equal(value.view().acknowledgedSequence, 1)
  assert.equal(value.view().pendingCount, 0)
  value.received(snapshot)
  assert.match(value.view().error, /sequence|duplicate/i)
  const wrongIds = make()
  wrongIds.received({ ...snapshot, entityIds: ['entity:other'] })
  assert.match(wrongIds.view().error, /body|entity/i)
  const stale = make()
  stale.received({ ...snapshot, generationId: 2 })
  assert.match(stale.view().error, /generation/i)
  const missing = make()
  await assert.rejects(missing.waitForLatestAcknowledgement(5), /acknowledgement/i)
  assert.equal(missing.view().samples.length, 0)
})

test('native observer publication is deferred past event propagation and Enter uses the frozen down-char-up helper', async () => {
  const { createDeferredNativeRecorder } = await import('./worlds-physics-electron-fixture/observation.ts')
  const { nativeKeySequence } = await import('./worlds-character-electron-fixture/nativeKeyboard.ts')
  assert.deepEqual(nativeKeySequence('Enter').map((event) => event.type), ['keyDown', 'char', 'keyUp'])
  const published = []
  const recorder = createDeferredNativeRecorder((entries) => published.push(entries))
  const event = { defaultPrevented: false }
  recorder.record({ sequence: 1, type: 'keydown', trusted: true, key: 'Enter', code: 'Enter', target: 'Play World', defaultPrevented: false }, event)
  assert.equal(published.length, 0)
  event.defaultPrevented = true
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(published.length, 1)
  assert.equal(published[0][0].defaultPrevented, true)
  recorder.dispose()
})

test('fixture source preserves sandbox, real production boundaries, read-only DOM probes and finally isolation checks', async () => {
  const [main, preload, renderer, driver, html] = await Promise.all(['main.ts', 'preload.ts', 'renderer.tsx', 'driver.ts', 'index.html'].map(source))
  assert.match(main, /app\.enableSandbox\(\)/)
  assert.match(main, /sandbox: true, contextIsolation: true, nodeIntegration: false/)
  assert.match(main, /registerWorldProjectsIpcHandlers/)
  assert.match(main, /senderFrame === window\.webContents\.mainFrame/)
  assert.doesNotMatch(main, /appendSwitch\(|requestSingleInstanceLock\(|setupIpcHandlers\(|child_process/)
  assert.match(preload, /worlds-character-electron-fixture\/preload/)
  for (const production of ['WorldRuntimeViewport', 'WorldsProjectBar', 'createWorldPlayController', 'createBrowserWorldPhysicsRuntime', 'createBrowserWorldAudioAuthority']) assert.match(renderer, new RegExp(production))
  assert.match(renderer, /handlers\.onSnapshot\(snapshot\)/)
  assert.match(renderer, /waitForLatestAcknowledgement/)
  assert.match(renderer, /createDeferredNativeRecorder/)
  assert.doesNotMatch(renderer, /from ['"]@dimforge\/rapier|new Worker\(/)
  assert.equal((driver.match(/executeJavaScript\(/g) ?? []).length, 2)
  assert.doesNotMatch(driver, /dispatchEvent\(|\.click\(|\.focus\(|__react|\.advance\(|\.start\(|\.setControl\(/)
  assert.match(driver, /nativeKeySequence/)
  assert.match(driver, /finally/)
  assert.match(driver, /UNREACHED/)
  assert.match(html, /worker-src 'self'/)
  assert.match(html, /'wasm-unsafe-eval'/)
  assert.match(html, /connect-src 'none'/)
})

test('build-only emits actual production Rapier Worker and isolated artifacts without running Electron', { timeout: 120_000 }, async () => {
  const { buildWorldsPhysicsFixture } = await import('./worlds-physics-electron-fixture.mjs')
  const result = await buildWorldsPhysicsFixture()
  console.log(`Physics fixture build evidence: ${result.outputDirectory}`)
  assert.match(result.outputDirectory, /^\/tmp\/modly-worlds-physics-ui-/)
  assert.equal(result.execution, 'NOT_RUN')
  assert.equal(result.scope, 'source-level-physics-play-phase1')
  assert.equal(result.productionWorkerEntry, 'src/areas/worlds/runtime/worldPhysics.worker.ts')
  assert.ok(result.sourceInputs.some((entry) => entry.path.endsWith('/src/areas/worlds/runtime/worldPhysics.worker.ts')))
  assert.ok(result.sourceInputs.some((entry) => entry.path.endsWith('/node_modules/@dimforge/rapier3d/rapier_wasm3d.js')))
  assert.ok(result.sourceInputs.some((entry) => entry.path.endsWith('/electron.vite.config.ts')))
  assert.equal(result.workerFiles.length, 1)
  const worker = await readFile(path.join(result.outputDirectory, result.workerFiles[0]), 'utf8')
  assert.match(worker, /physics-init-failed/)
  assert.match(result.nextCommand, /\/usr\/bin\/xvfb-run -a/)
  assert.match(result.nextCommand, /--kill-after=5s 145s/)
  assert.doesNotMatch(result.nextCommand, /--no-sandbox|--no-zygote|DISPLAY=:1/)
  assert.equal((await readdir(result.outputDirectory)).some((name) => name.startsWith('run-')), false)
  for (const filename of ['main.cjs', 'preload.cjs', 'renderer/index.html']) assert.ok(result.outputs[filename].bytes > 0)
})

test('worker-only lane is explicit and cannot replace the default native lane or select an output path', async () => {
  const { parseBuildArguments, buildWorldsPhysicsFixture } = await import('./worlds-physics-electron-fixture.mjs')
  assert.deepEqual(parseBuildArguments(['--build-only']), { buildOnly: true })
  assert.deepEqual(parseBuildArguments(['--build-only', '--lane=worker-only']), { buildOnly: true, lane: 'worker-only' })
  for (const args of [['--lane=worker-only'], ['--build-only', '--lane=unknown'], ['--build-only', '--lane=worker-only', '--run']]) assert.throws(() => parseBuildArguments(args), /build-only/)
  await assert.rejects(buildWorldsPhysicsFixture({ lane: 'unknown' }), /lane/i)
  await assert.rejects(buildWorldsPhysicsFixture({ lane: 'worker-only', outputDirectory: '/tmp/existing' }), /option/i)
})

test('worker-only authoring retains thirteen real editor history entries and receipts with authored input bindings', async () => {
  const { WorldProjectRepository } = await import('../electron/main/world-project-repository.ts')
  const { createWorldProjectService } = await import('../src/areas/worlds/worldProjectService.ts')
  const { createWorldEditorController } = await import('../src/areas/worlds/editor/worldEditorController.ts')
  const { WorldInputSampler } = await import('../src/areas/worlds/runtime/worldInputRuntime.ts')
  const { WorldFixedStepClock } = await import('../src/areas/worlds/runtime/worldRuntimeClock.ts')
  const { authorWorkerFixtureCourse, workerFrameTimestamp, sampleWorkerControls, parseWorkerFixtureCommand } = await import('./worlds-physics-electron-fixture/worker-contract.ts')
  const { captureWorkerProjectFiles } = await import('./worlds-physics-electron-fixture/worker-driver.ts')
  const { PROJECT_KEY, SCENE_KEY } = await import('./worlds-physics-electron-fixture/shared.ts')
  const workspace = await mkdtemp('/tmp/modly-worlds-physics-worker-seed-test-')
  const repository = new WorldProjectRepository({ getWorkspaceRoot: () => workspace, createProjectKey: () => PROJECT_KEY, createSceneKey: () => SCENE_KEY })
  assert.ok((await repository.create({ name: 'Worker-only fixture', initialSceneName: 'Course' })).ok)
  const editor = createWorldEditorController(createWorldProjectService(repository))
  const baseline = await authorWorkerFixtureCourse(editor)
  assert.equal(baseline.snapshot.project.revision, 13)
  assert.equal(baseline.undoStack.length, 13)
  assert.equal(baseline.receipts.length, 13)
  assert.equal(baseline.redoStack.length, 0)
  assert.deepEqual(baseline.receipts.map(receipt => receipt.appliedRevision), Array.from({ length: 13 }, (_, index) => index + 1))
  const sampler = new WorldInputSampler(baseline.snapshot.project.inputActions)
  const controller = baseline.snapshot.scenes[0].entities.flatMap(entity => entity.components).find(component => component.type === 'character-controller')
  const pressed = sampleWorkerControls(sampler, { moveRight: true, jump: true })
  assert.deepEqual(pressed.actions[controller.moveActionId], { value: [1, 0], held: true, pressed: true, released: false })
  assert.equal(pressed.actions[controller.jumpActionId].pressed, true)
  assert.equal(sampleWorkerControls(sampler, { moveRight: true, jump: true }).actions[controller.jumpActionId].pressed, false)
  const released = sampleWorkerControls(sampler, { moveRight: false, jump: false })
  assert.deepEqual(released.actions[controller.moveActionId].value, [0, 0])
  assert.equal(released.actions[controller.jumpActionId].released, true)
  sampler.dispose()
  const clock = new WorldFixedStepClock()
  assert.equal(clock.advance(workerFrameTimestamp(0)).steps, 0)
  for (let tick = 1; tick <= 180; tick += 1) assert.equal(clock.advance(workerFrameTimestamp(tick)).steps, 1)
  clock.pause(); assert.equal(clock.advance(workerFrameTimestamp(181)).steps, 0)
  clock.resume(); assert.equal(clock.advance(workerFrameTimestamp(182)).steps, 0)
  assert.equal(clock.advance(workerFrameTimestamp(183)).steps, 1)
  for (const tick of [-1, 1.5, NaN, Infinity, 4097]) assert.throws(() => workerFrameTimestamp(tick), /tick/i)
  assert.deepEqual(parseWorkerFixtureCommand({ type: 'stop' }), { type: 'stop' })
  for (const input of [{ type: 'teleport' }, { type: 'stop', arbitrary: true }, { type: 'advance', tick: 1, controls: { moveRight: 1, jump: false } }]) assert.throws(() => parseWorkerFixtureCommand(input), /command|controls/i)
  const projectRoot = path.join(workspace, 'Worlds', PROJECT_KEY)
  const durableBefore = await captureWorkerProjectFiles(projectRoot)
  const ledger = JSON.parse(await readFile(path.join(projectRoot, '.modly/state.v1.json'), 'utf8'))
  assert.equal(ledger.committedRevision, 13)
  assert.deepEqual(ledger.transactions.map(({ transactionId, canonicalPayload, appliedRevision }) => ({ transactionId, canonicalPayload, appliedRevision })),
    baseline.receipts.map(({ transactionId, canonicalPayload, appliedRevision }) => ({ transactionId, canonicalPayload, appliedRevision })))
  const reopened = await new WorldProjectRepository({ getWorkspaceRoot: () => workspace }).open({ projectKey: PROJECT_KEY })
  assert.ok(reopened.ok && reopened.value.status === 'ready')
  assert.deepEqual(reopened.value.snapshot, baseline.snapshot)
  assert.deepEqual(await captureWorkerProjectFiles(projectRoot), durableBefore)
  assert.deepEqual(editor.getState().session, baseline)
  console.log(`Worker-only authoring evidence: ${workspace}`)
})

test('worker-only durable byte evidence is independent of renderer state and rejects symlinks and mutation', async () => {
  const { captureWorkerProjectFiles } = await import('./worlds-physics-electron-fixture/worker-driver.ts')
  const root = await mkdtemp('/tmp/modly-worlds-worker-durable-test-')
  await mkdir(path.join(root, '.modly'))
  await writeFile(path.join(root, '.modly/state.v1.json'), '{"transactions":[{"id":"seed"}]}')
  const before = await captureWorkerProjectFiles(root)
  assert.equal(before.length, 1)
  assert.equal(before[0].path, '.modly/state.v1.json')
  assert.deepEqual(await captureWorkerProjectFiles(root), before)
  await writeFile(path.join(root, '.modly/state.v1.json'), '{"transactions":[]}')
  assert.notDeepEqual(await captureWorkerProjectFiles(root), before)
  await symlink('/etc/passwd', path.join(root, 'not-a-project-file'))
  await assert.rejects(captureWorkerProjectFiles(root), /symbolic|non-file/i)
})

test('worker-only build uses a distinct plain-DOM graph, raw WASM provenance and never launches native', { timeout: 120_000 }, async () => {
  const { buildWorldsPhysicsFixture } = await import('./worlds-physics-electron-fixture.mjs')
  const result = await buildWorldsPhysicsFixture({ lane: 'worker-only' })
  console.log(`Worker-only fixture build evidence: ${result.outputDirectory}`)
  assert.equal(result.schema, 'modly.worlds-physics-worker-build.v1')
  assert.equal(result.scope, 'programmatic-worker-play-phase1')
  assert.equal(result.lane, 'worker-only')
  assert.equal(result.execution, 'NOT_RUN')
  assert.match(result.nextCommand, /--kill-after=5s 135s/)
  assert.match(result.outputDirectory, /^\/tmp\/modly-worlds-physics-worker-/)
  assert.ok(result.outputs['renderer/worker-index.html'])
  const wasm = await readFile(result.rawRapierWasm.path)
  assert.ok(wasm.length > 0)
  assert.equal(createHash('sha256').update(wasm).digest('hex'), result.rawRapierWasm.sha256)
  assert.ok(result.moduleGraphs.renderer.some(id => id.endsWith('/worker-renderer.ts')))
  assert.ok(result.moduleGraphs.renderer.some(id => id.endsWith('/worldPlayController.ts')))
  assert.ok(result.moduleGraphs.renderer.some(id => id.endsWith('/worldPhysicsRuntime.ts')))
  assert.ok(result.moduleGraphs.worker.some(id => id.endsWith('/worldPhysics.worker.ts')))
  assert.ok(result.moduleGraphs.worker.some(id => id.includes('rapier_wasm3d_bg.wasm')))
  assert.doesNotMatch(result.moduleGraphs.renderer.join('\n'), /@react-three|\/node_modules\/react(?:-dom)?\/|WorldRuntimeViewport|WorldEditorViewport|WorldsProjectBar|\/renderer\.tsx/)
  const renderer = await source('worker-renderer.ts')
  assert.doesNotMatch(renderer, /from ['"]react|@react-three|new Worker\(|from ['"]@dimforge|dispatchEvent|sendInputEvent/)
  assert.match(renderer, /createBrowserWorldPhysicsRuntime/)
  assert.match(renderer, /createBrowserWorldAudioAuthority/)
  assert.match(renderer, /waitForLatestAcknowledgement/)
  const driver = await source('worker-driver.ts')
  assert.match(driver, /finally/)
  assert.match(driver, /UNREACHED/)
  assert.doesNotMatch(driver, /sendInputEvent|nativeKeySequence|\.dispatchEvent/)
  assert.doesNotMatch(result.nextCommand, /--no-sandbox|--no-zygote|--disable-gpu|ignore-gpu-blocklist|autoplay-policy/)
  assert.equal((await readdir(result.outputDirectory)).some(name => name.startsWith('run-')), false)
})

test('acceptance status exposes frozen scalar snapshots without copying evidence', async () => {
  const run = await acceptanceModel(), before = run.model.view()
  const original = { view: run.model.view, clone: globalThis.structuredClone, stringify: JSON.stringify, join: Array.prototype.join }
  const forbidden = () => { throw new Error('Status must not export or copy retained evidence.') }
  let first, second
  try {
    run.model.view = forbidden; globalThis.structuredClone = forbidden; JSON.stringify = forbidden; Array.prototype.join = forbidden
    first = run.model.status(); second = run.model.status()
  } finally {
    run.model.view = original.view; globalThis.structuredClone = original.clone; JSON.stringify = original.stringify; Array.prototype.join = original.join
  }
  assert.ok(Object.isFrozen(first)); assert.notEqual(first, second); assert.deepEqual(first, second)
  assert.deepEqual(first, { phase: 'timing', cycle: 0, generationId: 1, active: true, stage: 'warmup', ordinal: 0,
    postedSequence: -1, acknowledgedSequence: -1, pendingSequence: null, pendingCount: 0, pendingSteps: 0,
    completedCycles: 0, cancelledRequests: 0, scalarBytes: before.scalarBytes, error: null, measuredStartOrdinal: null, measuredEndOrdinal: null })
  assert.ok(Object.values(first).every(value => value === null || ['number', 'string', 'boolean'].includes(typeof value)))
  assert.equal(Reflect.set(first, 'acknowledgedSequence', 99), false); assert.deepEqual(run.model.view(), before)
  const fresh = new run.model.constructor('timing', run.ids).status()
  assert.deepEqual([fresh.cycle, fresh.generationId, fresh.active, fresh.stage, fresh.postedSequence, fresh.acknowledgedSequence], [-1, 0, false, 'complete', -1, -1])
})

test('acceptance status distinguishes posted acknowledgements and failed Stop cleanup', async () => {
  const run = await acceptanceModel('ownership'), first = run.request(2, 7)
  run.model.posted(1, first, run.frame())
  const pending = run.model.status()
  assert.deepEqual([pending.postedSequence, pending.acknowledgedSequence, pending.pendingSequence, pending.pendingCount, pending.pendingSteps], [7, -1, 7, 1, 2])
  run.model.received(run.reply(first), 1)
  assert.deepEqual([run.model.status().acknowledgedSequence, run.model.status().pendingSequence, run.model.status().ordinal], [7, null, 2])
  const next = run.request(4, 12); run.model.posted(1, next, { sentMs: 1, lagMs: 0, droppedMs: 0 })
  const before = run.model.view(), invalid = run.reply(next); invalid.stepTimings.pop()
  assert.throws(() => run.model.received(invalid, 2))
  const failed = run.model.status(); assert.ok(failed.error)
  assert.deepEqual([failed.postedSequence, failed.acknowledgedSequence, failed.pendingSequence], [12, 7, 12])
  assert.throws(() => run.model.stop(1, stoppedProof))
  const stopped = run.model.status()
  assert.deepEqual([stopped.active, stopped.acknowledgedSequence, stopped.pendingCount, stopped.pendingSteps, stopped.pendingSequence, stopped.cancelledRequests, stopped.completedCycles], [false, 7, 0, 0, null, 1, 0])
  assert.equal(stopped.error, failed.error); assert.equal(run.model.view().scalarJsonl, before.scalarJsonl)
  assert.throws(() => run.model.stop(1, stoppedProof)); assert.equal(run.model.status().cancelledRequests, 1)
  assert.deepEqual([pending.acknowledgedSequence, pending.pendingCount], [-1, 1], 'Older status snapshots cannot mutate with the observer.')
})

test('acceptance status resets acknowledgements only when a new cycle begins', async () => {
  const run = await acceptanceModel('ownership')
  for (let n = 0; n < 15; n += 1) run.accept()
  assert.deepEqual([run.model.status().postedSequence, run.model.status().acknowledgedSequence, run.model.status().ordinal], [14, 14, 60])
  run.model.stop(1, stoppedProof)
  assert.deepEqual([run.model.status().completedCycles, run.model.status().acknowledgedSequence, run.model.status().active], [1, 14, false])
  run.model.beginCycle(1, 7)
  assert.deepEqual([run.model.status().cycle, run.model.status().generationId, run.model.status().postedSequence, run.model.status().acknowledgedSequence, run.model.status().ordinal], [1, 7, -1, -1, 0])
  const next = run.request(1, 0); run.model.posted(7, next, { sentMs: 20, lagMs: 0, droppedMs: 0 }); run.model.received(run.reply(next, 7), 21)
  assert.equal(run.model.status().acknowledgedSequence, 0)
  const timing = await acceptanceModel(); for (let n = 0; n < 30; n += 1) timing.accept()
  assert.deepEqual([timing.model.status().measuredStartOrdinal, timing.model.status().measuredEndOrdinal], [124, 724])
  assert.deepEqual(timing.model.view().measuredWindow, { startOrdinal: 124, endOrdinal: 724 })
})

test('acceptance cadence preserves exact paired and legacy frame rows', async () => {
  const run = await acceptanceModel('ownership'), legacy = { sentMs: 1, lagMs: 17, droppedMs: 0 }
  const delayed = { sentMs: 5, lagMs: 2, droppedMs: 0, scheduledMs: 1, advanceMs: 3 }
  const early = { scheduledMs: 12, advanceMs: 7, sentMs: 9, lagMs: 0, droppedMs: 0 }, req = run.request(2, 5)
  run.model.idleFrame(1, legacy); run.model.idleFrame(1, delayed); run.model.posted(1, req, early)
  run.model.received(run.reply(req), 10)
  run.model.idleFrame(1, { sentMs: 10, lagMs: 2, droppedMs: 0, scheduledMs: 8, advanceMs: 10 })
  const rows = run.model.view().scalarJsonl.trim().split('\n'), prefix = { phase: 'ownership', cycle: 0, generationId: 1 }
  for (const frame of [legacy, delayed]) assert.ok(rows.includes(JSON.stringify({ ...prefix, type: 'idle', clockSource: 'derived-fixture-clock', steps: 0, ...frame })))
  assert.ok(rows.includes(JSON.stringify({ ...prefix, type: 'request', sequence: 5, count: 2, clockSource: 'derived-fixture-clock', ...early })))
  assert.equal(JSON.parse(rows[0]).wired, false); assert.equal(run.model.status().acknowledgedSequence, 5)
  assert.deepEqual(Object.keys(run.model.view()), ['phase', 'cycle', 'generationId', 'active', 'stage', 'pendingCount', 'completedCycles', 'cancelledRequests', 'ordinal', 'measuredWindow', 'scalarBytes', 'scalarJsonl', 'poses', 'error'])
})

test('acceptance cadence rejects malformed shapes and inconsistent elapsed clocks', async () => {
  const valid = { sentMs: 10, lagMs: 1, droppedMs: 0, scheduledMs: 8, advanceMs: 9 }
  const invalid = [
    { sentMs: 10, lagMs: 1, droppedMs: 0, scheduledMs: 8 }, { sentMs: 10, lagMs: 1, droppedMs: 0, advanceMs: 9 },
    { ...valid, scheduledMs: undefined }, { ...valid, advanceMs: undefined }, { ...valid, scheduledMs: undefined, advanceMs: undefined },
    { ...valid, scheduledMs: NaN }, { ...valid, advanceMs: Infinity }, { ...valid, sentMs: NaN }, { ...valid, advanceMs: '9' },
    { ...valid, scheduledMs: -1 }, { ...valid, advanceMs: 7, scheduledMs: 6 }, { ...valid, sentMs: 8 }, { ...valid, lagMs: 0 },
    { ...valid, extra: 0 }, { ...valid, [Symbol('extra')]: 0 }, Object.defineProperty({ ...valid }, 'extra', { value: 0 }),
    { sentMs: 10, lagMs: 0, droppedMs: 0, [Symbol('extra')]: 0 }, Object.defineProperty({ sentMs: 10, lagMs: 0, droppedMs: 0 }, 'extra', { value: 0 }),
    Object.assign(Object.create({ scheduledMs: 8 }), { sentMs: 10, lagMs: 1, droppedMs: 0, advanceMs: 9 }),
    Object.defineProperty({ ...valid }, 'scheduledMs', { value: 8, enumerable: false }),
    { ...valid, get advanceMs() { throw new Error('Untrusted clock accessor must not be evaluated.') } },
  ]
  for (const frame of invalid) {
    const run = await acceptanceModel(), req = run.request(1, 3)
    run.model.posted(1, req, { sentMs: 6, lagMs: 0, droppedMs: 0 }); run.model.received(run.reply(req), 8)
    const before = run.model.view()
    assert.throws(() => run.model.posted(1, run.request(1, 4), frame))
    assert.ok(run.model.status().error); assert.equal(run.model.status().acknowledgedSequence, 3)
    assert.equal(run.model.status().pendingCount, 0); assert.equal(run.model.view().scalarJsonl, before.scalarJsonl)
  }
  const idle = await acceptanceModel(); idle.model.idleFrame(1, { sentMs: 9, lagMs: 0, droppedMs: 0 })
  assert.throws(() => idle.model.idleFrame(1, { sentMs: 10, lagMs: 1, droppedMs: 0, scheduledMs: 7, advanceMs: 8 }))
  assert.ok(idle.model.status().error)
})

// Manual adapter integration: real durable author/reopen, real Play and diagnostic runtime;
// transport replies are model DTOs, NOT Rapier, native performance or heap-release proof.
let manualSessionPromise
async function manualAcceptanceSession() {
  if (!manualSessionPromise) manualSessionPromise = (async () => {
    const { WorldProjectRepository } = await import('../electron/main/world-project-repository.ts')
    const { createWorldProjectService } = await import('../src/areas/worlds/worldProjectService.ts')
    const { createWorldEditorController } = await import('../src/areas/worlds/editor/worldEditorController.ts')
    const { authorWorkerFixtureCourse } = await import('./worlds-physics-electron-fixture/worker-contract.ts')
    const { PROJECT_KEY, SCENE_KEY } = await import('./worlds-physics-electron-fixture/shared.ts')
    const workspace = await mkdtemp('/tmp/modly-physics-manual-adapter-')
    try {
      const repository = new WorldProjectRepository({ getWorkspaceRoot: () => workspace, createProjectKey: () => PROJECT_KEY, createSceneKey: () => SCENE_KEY })
      assert.ok((await repository.create({ name: 'Manual adapter', initialSceneName: 'Course' })).ok)
      const editor = createWorldEditorController(createWorldProjectService(repository))
      const session = await authorWorkerFixtureCourse(editor, 'acceptance-500')
      const reopened = await new WorldProjectRepository({ getWorkspaceRoot: () => workspace }).open({ projectKey: PROJECT_KEY })
      assert.ok(reopened.ok && reopened.value.status === 'ready'); assert.deepEqual(reopened.value.snapshot, session.snapshot)
      assert.deepEqual([session.snapshot.project.revision, session.undoStack.length, session.receipts.length], [23, 23, 23])
      return session
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })()
  return manualSessionPromise
}
async function manualAdapter({ holdInit = false, holdAudio = false, phase = 'ownership', factory = null, automaticReply = false } = {}) {
  const { createPhysicsAcceptancePlayAdapter } = await import('./worlds-physics-electron-fixture/worker-acceptance.ts')
  const { WorldPhysicsWorkerRuntime } = await import('../src/areas/worlds/runtime/worldPhysicsRuntime.ts')
  const { projectWorldRuntimeScene } = await import('../src/areas/worlds/runtime/worldRuntimeProjection.ts')
  const session = await manualAcceptanceSession(), scene = session.snapshot.project.startSceneId
  const projection = projectWorldRuntimeScene(session.snapshot, scene); assert.ok(projection.success)
  const ids = projection.value.physics.bodies.map(body => body.entityId), audioGate = graphicsGate()
  const h = { time: 0, nowQueue: [], transports: [], audioUpdates: [], audioStops: 0, session, scene, ids }
  h.adapter = (factory ?? createPhysicsAcceptancePlayAdapter)(phase, ids, {
    now: () => h.nowQueue.length ? h.nowQueue.shift() : h.time,
    createPhysics(generationId, handlers, diagnostics) {
      assert.equal(diagnostics, true)
      const listeners = new Map(), messages = []
      const worker = { postMessage(message) { messages.push(message); if (message.kind === 'init' && !holdInit) queueMicrotask(() => transport.emit({ version: 1, kind: 'ready', generationId, entityIds: message.scene.bodies.map(body => body.entityId) })); if (message.kind === 'step' && automaticReply) queueMicrotask(() => typeof automaticReply === 'function' ? automaticReply(h, transport, message) : transport.reply(message)) },
        addEventListener: (kind, fn) => listeners.set(kind, fn), removeEventListener: (kind, fn) => { if (listeners.get(kind) === fn) listeners.delete(kind) }, terminate() {} }
      const transport = { messages, listeners, emit: data => listeners.get('message')?.({ data }), fail: message => listeners.get('error')?.({ message }),
        reply(request = messages.findLast(message => message.kind === 'step'), mutate = () => {}) {
          const init = messages.find(message => message.kind === 'init')
          const reply = { version: 1, kind: 'snapshot', generationId, sequence: request.sequence, entityIds: init.scene.bodies.map(body => body.entityId),
            transforms: Float32Array.from(init.scene.bodies.flatMap(body => [...body.position, ...body.rotation])).buffer, triggerEvents: [],
            stepTimings: request.steps.map((_, substep) => ({ substep, solverMs: 1, physicsStepMs: 2 })) }
          mutate(reply); transport.emit(reply)
        } }
      h.transports.push(transport)
      return new WorldPhysicsWorkerRuntime({ generationId, worker, ...handlers, diagnostics })
    },
    createAudio: () => ({ async prepareScene() {}, async activate() {}, async play() {}, async stopSource() {},
      update: poses => { h.audioUpdates.push(poses.length); h.onAudioUpdate?.() }, async pause() {}, async resume() {},
      async stop() { h.audioStops += 1; if (holdAudio) await audioGate.promise } }),
  })
  h.releaseAudio = audioGate.resolve
  h.tick = (time, scheduled = time) => { h.time = time; return h.adapter.advance(scheduled, { sequence: 0, actions: {} }) }
  h.waitPost = async () => { for (let n = 0; n < 20; n += 1) { const request = h.transports.at(-1)?.messages.findLast(message => message.kind === 'step'); if (request?.sequence === h.adapter.status().pendingSequence) return request; await Promise.resolve() } assert.fail('Manual advance did not post within the fixed microtask bound.') }
  h.quota = async () => { await h.tick(h.time); for (let n = 1; n <= 15; n += 1) { const advance = h.tick(h.time + 1000 / 15); await h.waitPost(); h.transports.at(-1).reply(); await advance } }
  return h
}

test('manual acceptance adapter initializes real Play with exact diagnostic canonical bodies', async () => {
  const h = await manualAdapter(), before = structuredClone(h.session)
  await assert.rejects(h.tick(0), /start|playing/i)
  await h.adapter.startCycle(h.session, h.scene)
  const init = h.transports[0].messages[0]
  assert.equal(init.diagnostics, true); assert.deepEqual(init.scene.bodies.map(body => body.entityId), h.ids)
  const prime = await h.tick(0)
  assert.equal(prime.pendingCount, 0); assert.equal(h.transports[0].messages.filter(message => message.kind === 'step').length, 0)
  assert.equal(h.adapter.status().playLifecycle, 'playing'); assert.deepEqual(h.session, before)
  await assert.rejects(h.adapter.stop(), /incomplete/i)
  assert.equal(h.adapter.status().completedCycles, 0)
})

test('manual acceptance adapter awaits production poses and audio after delayed single flight', async () => {
  const h = await manualAdapter(); await h.adapter.startCycle(h.session, h.scene); await h.tick(0)
  h.time = 20; h.nowQueue = [20, 30]
  let acknowledged = false
  const advance = h.adapter.advance(18, { sequence: 1, actions: {} }).then(value => { acknowledged = true; return value })
  const request = await h.waitPost(); assert.equal(request.steps.length, 1); assert.equal(acknowledged, false)
  await assert.rejects(h.tick(31), /pending|flight|busy/i); await assert.rejects(h.adapter.pause(), /pending|busy/i)
  let reentrant
  h.onAudioUpdate = () => { reentrant = h.adapter.advance(31, { sequence: 2, actions: {} }); void reentrant.catch(() => {}) }
  h.time = 31; h.transports[0].reply(request); const ack = await advance
  await assert.rejects(reentrant, /pending|flight|busy/i)
  assert.deepEqual([ack.physicsBodyPoseCount, ack.runtimePoseCount, h.audioUpdates.at(-1)], [504, 505, 505])
  h.onAudioUpdate = null
  await h.adapter.pause(); assert.equal(h.adapter.status().playLifecycle, 'paused')
  await h.adapter.resume(); assert.equal(h.adapter.status().generationId, 1); await h.tick(32)
  await assert.rejects(h.adapter.stop(), /incomplete/i)
  const rows = h.adapter.exportTerminal().scalarJsonl.trim().split('\n').map(JSON.parse), posted = rows.find(row => row.type === 'request')
  assert.deepEqual([posted.scheduledMs, posted.advanceMs, posted.sentMs, posted.lagMs, posted.droppedMs], [18, 20, 30, 2, 0])
})

test('manual acceptance adapter settles complete Stop audio before increasing cycle ownership', async () => {
  const h = await manualAdapter({ holdAudio: true }), before = structuredClone(h.session)
  await h.adapter.startCycle(h.session, h.scene); await h.quota()
  const stop = h.adapter.stop(); assert.equal(stop, h.adapter.stop())
  await Promise.resolve(); assert.equal(h.adapter.status().playLifecycle, 'stopping'); assert.equal(h.adapter.status().audioCompleted, 0)
  await assert.rejects(h.adapter.startCycle(h.session, h.scene), /stop|settle|busy/i)
  h.releaseAudio(); const stopped = await stop
  assert.equal(stopped.playLifecycle, 'edit')
  assert.deepEqual([stopped.completedCycles, stopped.successfulCycles, stopped.disposed, stopped.audioStarted, stopped.audioCompleted], [1, 1, 1, 1, 1])
  assert.deepEqual([stopped.physicsBodyPoseCount, stopped.runtimePoseCount], [0, 0])
  assert.equal(h.adapter.exportTerminal().adapterSuccessful, true)
  await h.adapter.startCycle(h.session, h.scene)
  assert.ok(h.adapter.status().generationId > stopped.generationId); assert.equal(h.adapter.status().created, 1); assert.equal(h.adapter.status().ordinal, 0)
  await assert.rejects(h.adapter.cancel(), /cancel/i); assert.deepEqual(h.session, before)
})

test('manual acceptance adapter preempts pending requests and start with inert late callbacks', async () => {
  const h = await manualAdapter(); await h.adapter.startCycle(h.session, h.scene); await h.tick(0)
  const advance = h.tick(20); void advance.catch(() => {}); await h.waitPost()
  const late = h.transports[0].listeners.get('message'), stop = h.adapter.stop()
  await assert.rejects(advance, /stop|cancel/i); await assert.rejects(stop, /stop|cancel|incomplete/i)
  const before = h.adapter.status(); late({ data: { version: 1, kind: 'ready', generationId: 1, entityIds: h.transports[0].messages.find(message => message.kind === 'init').scene.bodies.map(body => body.entityId) } }); assert.deepEqual(h.adapter.status(), before)
  assert.deepEqual([before.pendingCount, before.cancelledRequests, before.completedCycles, before.runtimePoseCount], [0, 1, 0, 0])
  const starting = await manualAdapter({ holdInit: true }), start = starting.adapter.startCycle(starting.session, starting.scene); void start.catch(() => {})
  for (let n = 0; n < 20 && !starting.transports.length; n += 1) await Promise.resolve()
  await assert.rejects(starting.adapter.stop(), /start|stop|cancel|incomplete/i); await assert.rejects(start, /start|stop|cancel/i)
  assert.deepEqual([starting.adapter.status().playLifecycle, starting.adapter.status().disposed, starting.audioStops], ['edit', 1, 1])
})

test('manual acceptance adapter preserves first malformed snapshot or Worker error until cleanup', async () => {
  for (const failure of ['ids', 'error']) {
    const h = await manualAdapter(); await h.adapter.startCycle(h.session, h.scene); await h.tick(0)
    const advance = h.tick(20); void advance.catch(() => {}); await h.waitPost()
    if (failure === 'ids') h.transports[0].reply(undefined, reply => reply.entityIds.reverse())
    else h.transports[0].fail('First transport error.')
    await assert.rejects(advance); const first = h.adapter.status().error; assert.ok(first)
    await assert.rejects(h.tick(40)); await assert.rejects(h.adapter.stop())
    const terminal = h.adapter.exportTerminal(); assert.equal(terminal.error, first); assert.equal(terminal.adapterSuccessful, false)
    assert.deepEqual([terminal.completedCycles, terminal.successfulCycles, terminal.pendingCount, terminal.cancelledRequests], [0, 0, 0, 1])
  }
})

test('manual acceptance adapter keeps terminal exports off ticks and distinguishes late cancellation', async () => {
  const { PhysicsAcceptanceObservation } = await import('./worlds-physics-electron-fixture/observation.ts')
  const h = await manualAdapter(), original = PhysicsAcceptanceObservation.prototype.view
  try {
    PhysicsAcceptanceObservation.prototype.view = () => { throw new Error('Retained view is terminal only.') }
    await h.adapter.startCycle(h.session, h.scene); await h.quota()
    assert.throws(() => h.adapter.exportTerminal(), /terminal|stop|settle/i)
    const join = Array.prototype.join; try { Array.prototype.join = () => { throw new Error('Status must not join evidence.') }; assert.equal(h.adapter.status().ordinal, 60) } finally { Array.prototype.join = join }
    await assert.rejects(h.adapter.cancel(), /cancel/i)
  } finally { PhysicsAcceptanceObservation.prototype.view = original }
  const terminal = h.adapter.exportTerminal()
  assert.deepEqual([terminal.completedCycles, terminal.successfulCycles, terminal.adapterSuccessful], [1, 0, false])
  assert.match(terminal.error, /cancel/i); assert.equal(JSON.parse(terminal.scalarJsonl.split('\n')[0]).wired, false)
  const backwards = await manualAdapter(); await backwards.adapter.startCycle(backwards.session, backwards.scene); await backwards.tick(10)
  await assert.rejects(backwards.tick(5), /clock|back|time/i); await assert.rejects(backwards.adapter.stop())
})

// Controlled scheduler/receipt time only; all phases retain the actual Play + diagnostic
// runtime transport helper, canonical revision23 author/reopen and production model rows.
async function acceptancePumpHarness(phase, options = {}) {
  const { createPhysicsAcceptancePump } = await import('./worlds-physics-electron-fixture/worker-acceptance-pump.ts')
  let h
  const pendingWait = (target, signal) => new Promise((resolve, reject) => {
    const entry = { finish: () => { cleanup(); resolve() } }
    const aborted = () => { cleanup(); reject(new Error('Controlled wait aborted.')) }
    const cleanup = () => { signal.removeEventListener('abort', aborted); h.liveWaits.delete(entry) }
    h.liveWaits.add(entry); signal.addEventListener('abort', aborted, { once: true })
    if (target === h.adapter.status().deadlineMs) h.deadlineWait = entry
    else h.pendingWait = entry
    if (signal.aborted) aborted()
  })
  h = await manualAdapter({ phase, factory: (name, ids, ports) => createPhysicsAcceptancePump(name, ids, { ...ports,
    async waitUntil(target, signal) {
      h.waits.push({ target, observedMs: h.time, state: h.adapter.status().pumpState })
      if (target === h.adapter.status().deadlineMs || options.holdWait) return pendingWait(target, signal)
      const current = h.adapter.status(), kind = current.pumpState === 'quiet' ? 'quiet' : current.stage === 'recovery' ? 'recovery' : null
      let duration
      if (kind) {
        duration = h.durationRecords.find(record => record.kind === kind && record.cycle === current.successfulCycles)
        if (!duration) {
          duration = { kind, cycle: current.successfulCycles, durationStart: kind === 'recovery' ? current.lastAdvanceMs : h.time, targetMs: target, wakes: [], resolvedMs: null }
          h.durationRecords.push(duration)
        }
        duration.wakes.push({ targetMs: target, beforeMs: h.time, wakeMs: null })
      }
      if (h.adapter.status().pumpState === 'quiet') {
        h.quietWaits += 1
        if (options.cancelFinalQuiet && h.adapter.status().successfulCycles === 50) { void h.adapter.cancel(); return }
      }
      if (duration && duration.wakes.length <= (options.durationEarlyWakes ?? 0)) h.time = Math.max(h.time, target - 1 / (duration.wakes.length + 1))
      else if (options.early && !h.earlyUsed) { h.earlyUsed = true; h.time = Math.max(h.time, target - 0.5) }
      else h.time = Math.max(h.time, target + (options.lateness ?? 0))
      if (duration) { duration.wakes.at(-1).wakeMs = h.time; if (h.time >= target) duration.resolvedMs = h.time }
    } }), automaticReply: (state, transport, request) => {
      if (options.holdReply) { state.pendingReply = { transport, request }; return }
      if (options.replyDelay && !state.delayed) { state.delayed = true; state.time += options.replyDelay }
      transport.reply(request)
    } })
  Object.assign(h, { waits: [], liveWaits: new Set(), quietWaits: 0, durationRecords: [], time: options.initialClock ?? 0 })
  h.run = () => h.adapter.runPhase(h.session, h.scene)
  h.until = async predicate => { for (let n = 0; n < 200; n += 1) { if (predicate()) return; await Promise.resolve() } assert.fail('Pump did not reach its fixed microtask observation bound.') }
  h.rows = terminal => terminal.adapter.model.scalarJsonl.trim().split('\n').map(JSON.parse)
  return h
}

test('acceptance pump completes three timing cycles on actual absolute grids and recovery windows', async t => {
  const h = await acceptancePumpHarness('timing', { early: true, lateness: 0.35 }), before = structuredClone(h.session)
  const completed = await h.run(); t.diagnostic(JSON.stringify({ durationRecords: h.durationRecords }))
  assert.equal(completed.phaseCompleted, true); assert.equal(completed.successfulCycles, 3)
  const terminal = h.adapter.exportPhase(), rows = h.rows(terminal)
  const windows = rows.filter(row => row.type === 'measured-window'); assert.equal(windows.length, 3)
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const own = rows.filter(row => row.cycle === cycle), steps = own.filter(row => row.type === 'step')
    assert.deepEqual(['warmup', 'recovery', 'measured'].map(category => steps.filter(row => row.category === category).length), [120, 4, 600])
    assert.ok(steps.filter(row => row.category === 'warmup-padding').length <= 3); assert.ok(steps.filter(row => row.category === 'padding').length <= 3)
    const requests = own.filter(row => row.type === 'request'), recovery = requests.find(row => row.droppedMs > 0)
    const prior = requests[requests.indexOf(recovery) - 1], origin = own.find(row => row.type === 'idle').advanceMs
    assert.ok(recovery.advanceMs - prior.advanceMs >= 200); assert.equal(recovery.count, 4)
    const duration = h.durationRecords.find(record => record.kind === 'recovery' && record.cycle === cycle), facts = JSON.stringify(duration)
    assert.equal(recovery.scheduledMs, Math.ceil(prior.advanceMs) + 200, facts)
    assert.ok(duration.resolvedMs - duration.durationStart >= 200 && duration.targetMs - duration.durationStart - 200 >= 0 && duration.targetMs - duration.durationStart - 200 <= 1, facts)
    assert.equal(windows[cycle].endOrdinal - windows[cycle].startOrdinal, 600)
    for (const request of requests.filter(row => row !== recovery)) assert.ok(Math.abs((request.scheduledMs - origin) / (1000 / 60) - Math.round((request.scheduledMs - origin) / (1000 / 60))) < 1e-8)
  }
  assert.deepEqual(h.session, before); assert.equal(h.liveWaits.size, 0)
  t.diagnostic(JSON.stringify({ controlledTime: true, cycles: 3, windows, measuredRows: rows.filter(row => row.category === 'measured').length, recoveryRows: rows.filter(row => row.category === 'recovery').length }))
})

test('acceptance pump completes fifty ownership generations and quiet without per tick exports', async t => {
  const { PhysicsAcceptanceObservation } = await import('./worlds-physics-electron-fixture/observation.ts')
  const h = await acceptancePumpHarness('ownership'), original = PhysicsAcceptanceObservation.prototype.view
  let completed
  try { PhysicsAcceptanceObservation.prototype.view = () => { throw new Error('Pump ticks must not export full evidence.') }; completed = await h.run() }
  finally { PhysicsAcceptanceObservation.prototype.view = original }
  t.diagnostic(JSON.stringify({ durationRecords: h.durationRecords }))
  assert.deepEqual([completed.phaseCompleted, completed.successfulCycles, h.transports.length, h.audioStops, h.quietWaits], [true, 50, 50, 50, 50])
  assert.deepEqual([completed.pendingCount, completed.runtimePoseCount, completed.physicsBodyPoseCount, h.liveWaits.size], [0, 0, 0, 0])
  for (const duration of h.durationRecords.filter(record => record.kind === 'quiet')) {
    const facts = JSON.stringify(duration)
    assert.equal(duration.targetMs, Math.ceil(duration.durationStart) + 150, facts)
    assert.ok(duration.resolvedMs - duration.durationStart >= 150 && duration.targetMs - duration.durationStart - 150 >= 0 && duration.targetMs - duration.durationStart - 150 <= 1, facts)
  }
  const terminal = h.adapter.exportPhase(), rows = h.rows(terminal), begins = rows.filter(row => row.type === 'begin')
  assert.ok(begins.every((row, n) => n === 0 || row.generationId > begins[n - 1].generationId))
  assert.equal(rows.filter(row => row.category === 'ownership').length, 3000); assert.equal(rows.filter(row => row.type === 'stop').length, 50)
  assert.ok(terminal.adapter.model.scalarBytes <= 4 * 1024 * 1024); await assert.rejects(h.run(), /one|already|shot/i)
  assert.throws(() => h.adapter.exportPhase(), /once|already/i)
  t.diagnostic(JSON.stringify({ controlledTime: true, generations: begins.length, ownershipRows: 3000, quietWaits: h.quietWaits, scalarBytes: terminal.adapter.model.scalarBytes }))
})

test('acceptance pump preserves delayed acknowledgement elapsed time and rejects outside recovery drops', async () => {
  const h = await acceptancePumpHarness('ownership', { replyDelay: 45 }); assert.equal((await h.run()).phaseCompleted, true)
  const requests = h.rows(h.adapter.exportPhase()).filter(row => row.type === 'request' && row.cycle === 0)
  assert.equal(requests[1].count, 3); assert.ok(requests[1].advanceMs - requests[0].advanceMs >= 50 - 1e-9)
  const stalled = await acceptancePumpHarness('ownership', { replyDelay: 80 }), failed = await stalled.run()
  assert.equal(failed.phaseCompleted, false); assert.match(failed.phaseError, /recovery|drop/i)
  const rows = stalled.rows(stalled.adapter.exportPhase()); assert.equal(rows.filter(row => row.type === 'request').length, 1)
  assert.equal(rows.filter(row => row.type === 'receipt').length, 1); assert.equal(stalled.transports.length, 1)
})

test('acceptance pump cancels pending wait reply and final quiet without inventing cycle success', async () => {
  for (const options of [{ holdWait: true }, { holdReply: true }]) {
    const h = await acceptancePumpHarness('ownership', options), run = h.run()
    await h.until(() => options.holdWait ? h.pendingWait : h.pendingReply)
    const cancelled = await h.adapter.cancel(); assert.equal((await run).phaseCompleted, false)
    assert.match(cancelled.phaseError, /cancel/i); assert.equal(cancelled.successfulCycles, 0); assert.equal(h.liveWaits.size, 0)
    const terminal = h.adapter.exportPhase(); assert.equal(terminal.adapter.pendingCount, 0)
    assert.equal(terminal.adapter.cancelledRequests, options.holdReply ? 1 : 0)
  }
  const final = await acceptancePumpHarness('ownership', { cancelFinalQuiet: true }), cancelled = await final.run()
  assert.deepEqual([cancelled.phaseCompleted, cancelled.successfulCycles], [false, 50])
  const terminal = final.adapter.exportPhase(); assert.match(terminal.phaseError, /cancel/i); assert.equal(terminal.adapter.error, null)
})

test('acceptance pump enforces fixed total deadlines during pending wait and acknowledgement', async t => {
  for (const options of [{ holdWait: true }, { holdReply: true }]) {
    const h = await acceptancePumpHarness('ownership', options), run = h.run()
    await h.until(() => (options.holdWait ? h.pendingWait : h.pendingReply) && h.deadlineWait)
    assert.equal(h.adapter.status().deadlineMs, 880000)
    h.time = 880000; h.deadlineWait.finish(); const expired = await run
    assert.equal(expired.phaseCompleted, false); assert.match(expired.phaseError, /deadline/i)
    assert.equal(expired.successfulCycles, 0); assert.equal(h.transports.length, 1); assert.equal(h.liveWaits.size, 0)
    assert.equal(h.adapter.exportPhase().adapter.pendingCount, 0)
  }
  t.diagnostic('Deadline clock jumps are controlled observations, not real fifteen-minute waits.')
})

test('acceptance pump conservatively rounds fractional quiet origins across repeated early wakes', async t => {
  const h = await acceptancePumpHarness('ownership', { initialClock: 0.125, durationEarlyWakes: 2 }), completed = await h.run()
  t.diagnostic(JSON.stringify({ controlledTime: true, durationRecords: h.durationRecords }))
  assert.equal(completed.phaseCompleted, true); assert.equal(completed.successfulCycles, 50)
  const quiet = h.durationRecords.filter(record => record.kind === 'quiet'); assert.equal(quiet.length, 50)
  for (const duration of quiet) {
    const facts = JSON.stringify(duration), padding = duration.targetMs - duration.durationStart - 150
    assert.equal(duration.targetMs, Math.ceil(duration.durationStart) + 150, facts)
    assert.ok(duration.resolvedMs - duration.durationStart >= 150 && padding >= 0 && padding <= 1, facts)
    assert.equal(duration.wakes.length, 3, facts); assert.ok(duration.wakes.slice(0, 2).every(wake => wake.wakeMs < duration.targetMs && wake.targetMs === duration.targetMs), facts)
  }
  const rows = h.rows(h.adapter.exportPhase()); assert.equal(rows.filter(row => row.category === 'ownership').length, 3000)
})

test('acceptance pump conservatively rounds tiny near integer recovery origins without moving wake targets', async t => {
  const h = await acceptancePumpHarness('timing', { initialClock: 1000.000000000001, durationEarlyWakes: 2 }), completed = await h.run()
  t.diagnostic(JSON.stringify({ controlledTime: true, durationRecords: h.durationRecords }))
  assert.equal(completed.phaseCompleted, true); assert.equal(completed.successfulCycles, 3)
  const recoveries = h.durationRecords.filter(record => record.kind === 'recovery'); assert.equal(recoveries.length, 3)
  for (const duration of recoveries) {
    const facts = JSON.stringify(duration), padding = duration.targetMs - duration.durationStart - 200
    assert.equal(duration.targetMs, Math.ceil(duration.durationStart) + 200, facts)
    assert.ok(duration.resolvedMs - duration.durationStart >= 200 && padding >= 0 && padding <= 1, facts)
    assert.equal(duration.wakes.length, 3, facts); assert.ok(duration.wakes.slice(0, 2).every(wake => wake.wakeMs < duration.targetMs && wake.targetMs === duration.targetMs), facts)
  }
  const rows = h.rows(h.adapter.exportPhase()); assert.equal(rows.filter(row => row.category === 'measured').length, 1800); assert.equal(rows.filter(row => row.category === 'recovery').length, 12)
})

// Opt-in entry contracts: deterministic fixture facades are wiring proof, not native evidence.
async function entryModule() { return import('./worlds-physics-electron-fixture/acceptance-entry.ts') }
function entryPorts(extra = {}) {
  const sender = {}, frame = {}, events = [], clock = { value: 10 }
  return { sender, frame, events, clock, now: () => clock.value, isLive: () => true,
    captureBaseline: async payload => { events.push('baseline'); return payload },
    persist: async (name, bytes) => { events.push(`persist:${name}`); return bytes },
    ...extra }
}
function entryRequest(context, sequence, type, payload = null) {
  return JSON.stringify({ token: context.token, phase: context.phase, sequence, type, payload })
}
function entryTerminal(completed = true) {
  return { phase: 'timing', result: completed ? 'completed' : 'partial', nativeAccepted: false,
    status: { phaseCompleted: completed, settled: completed, active: false, pendingCount: 0, runtimePresent: false,
      runtimePoseCount: 0, physicsBodyPoseCount: 0, phaseError: completed ? null : 'cancelled', cleanupError: null,
      successfulCycles: completed ? 3 : 0, quietCycles: completed ? 3 : 0 },
    evidence: { phase: 'timing', result: completed ? 'completed' : 'partial', nativeAccepted: false,
      adapter: completed ? { adapterSuccessful: true, successfulCycles: 3, completedCycles: 3, error: null } : null,
      phaseError: completed ? null : 'cancelled', cleanupError: null, exportError: null } }
}

test('physics acceptance entry parser strictly binds phases and preserves legacy defaults', async () => {
  const { parseBuildArguments, buildWorldsPhysicsFixture } = await import('./worlds-physics-electron-fixture.mjs')
  for (const phase of ['timing', 'ownership']) assert.deepEqual(parseBuildArguments(['--build-only', '--lane=worker-only', `--acceptance-phase=${phase}`]), { buildOnly: true, lane: 'worker-only', acceptancePhase: phase })
  for (const args of [['--build-only', '--acceptance-phase=timing'], ['--build-only', '--lane=native-ui', '--acceptance-phase=timing'],
    ['--build-only', '--lane=worker-only', '--acceptance-phase=bad'], ['--build-only', '--lane=worker-only', '--acceptance-phase=timing', '--acceptance-phase=timing'],
    ['--build-only', '--lane=worker-only', '--acceptance-phase=timing', '--run']]) assert.throws(() => parseBuildArguments(args), /build-only/)
  assert.deepEqual(parseBuildArguments(['--build-only']), { buildOnly: true })
  assert.deepEqual(parseBuildArguments(['--build-only', '--lane=worker-only']), { buildOnly: true, lane: 'worker-only' })
  await assert.rejects(buildWorldsPhysicsFixture({ acceptancePhase: 'timing' }), /worker-only/)
})

test('physics acceptance entry declarations pin immutable pump and whole entry envelopes', async () => {
  const { acceptanceDeclaration, validateAcceptanceBuild } = await entryModule()
  const { PHYSICS_ACCEPTANCE_PROFILES } = await import('./worlds-physics-electron-fixture/worker-contract.ts')
  for (const [phase, mainMs, outerMs] of [['timing', 245000, 255000], ['ownership', 960000, 970000]]) {
    const declaration = acceptanceDeclaration(phase)
    assert.equal(declaration.pumpMs, PHYSICS_ACCEPTANCE_PROFILES[phase].driverDeadlineMs)
    assert.equal(declaration.mainMs, mainMs); assert.equal(declaration.outerMs, outerMs)
    assert.ok(Object.isFrozen(declaration)); assert.equal(declaration.nativeAccepted, false)
    assert.deepEqual(validateAcceptanceBuild({ lane: 'worker-only', acceptancePhase: phase, acceptance: declaration }), declaration)
    assert.throws(() => validateAcceptanceBuild({ lane: 'native-ui', acceptancePhase: phase, acceptance: declaration }), /worker-only/)
    assert.throws(() => validateAcceptanceBuild({ lane: 'worker-only', acceptancePhase: phase, acceptance: { ...declaration, mainMs: mainMs + 1 } }), /declaration/)
  }
  assert.equal(validateAcceptanceBuild({ lane: 'worker-only' }), null)
  assert.throws(() => validateAcceptanceBuild({ lane: 'worker-only', acceptance: {} }), /declaration/)
})

test('physics acceptance entry authority rejects frame token replay oversize and after terminal', async () => {
  const { createAcceptanceOwner, acceptanceDeclaration } = await entryModule()
  const context = { ...acceptanceDeclaration('timing'), token: 'a'.repeat(64) }, ports = entryPorts()
  const owner = createAcceptanceOwner(context, ports), identity = { sender: ports.sender, frame: ports.frame }
  assert.throws(() => owner.claim({ ...identity, frame: {} }), /sender/)
  assert.deepEqual(owner.claim(identity), context)
  assert.throws(() => owner.claim(identity), /claimed/)
  await assert.rejects(owner.invoke(identity, '{'.repeat(4 * 1024 * 1024 + 1)), /byte/)
  await assert.rejects(owner.invoke(identity, entryRequest({ ...context, token: 'b'.repeat(64) }, 0, 'baseline', {})), /binding/)
  await assert.rejects(owner.invoke({ ...identity, frame: {} }, entryRequest(context, 0, 'baseline', {})), /sender/)
  await owner.invoke(identity, entryRequest(context, 0, 'baseline', { session: {} }))
  await assert.rejects(owner.invoke(identity, entryRequest(context, 0, 'progress', {})), /sequence/)
  await assert.rejects(owner.invoke(identity, entryRequest(context, 1, 'progress', { cycle: 1, extra: true })), /progress/)
  await owner.invoke(identity, entryRequest(context, 1, 'terminal', entryTerminal()))
  assert.ok(owner.state().terminal); assert.equal(owner.state().functionalComplete, true)
  await assert.rejects(owner.invoke(identity, entryRequest(context, 2, 'progress', { cycle: 1, state: 'running' })), /terminal/)
  assert.equal(owner.state().nativeAccepted, false)
})

test('physics acceptance entry progress cannot extend deadlines and cancellation stalls stay bounded partial', async () => {
  const { createAcceptanceOwner, acceptanceDeclaration, boundedEntryOperation } = await entryModule()
  const context = { ...acceptanceDeclaration('timing'), token: 'a'.repeat(64) }, ports = entryPorts()
  const owner = createAcceptanceOwner(context, ports), identity = { sender: ports.sender, frame: ports.frame }
  owner.claim(identity); const deadline = owner.state().deadlineMs
  await owner.invoke(identity, entryRequest(context, 0, 'baseline', {}))
  ports.clock.value += 100; await owner.invoke(identity, entryRequest(context, 1, 'progress', { cycle: 0, state: 'running' }))
  assert.equal(owner.state().deadlineMs, deadline)
  ports.clock.value = deadline
  await assert.rejects(owner.invoke(identity, entryRequest(context, 2, 'progress', { cycle: 0, state: 'running' })), /deadline/)
  assert.equal(owner.state().functionalComplete, false)
  await assert.rejects(boundedEntryOperation(new Promise(() => {}), 10, 'cancel'), /cancel/)
  await owner.forcePartial('cancel did not settle')
  assert.equal(owner.state().terminal.result, 'partial'); assert.equal(owner.state().functionalComplete, false)
  assert.equal(owner.state().terminal.status.settled, false)
})

test('physics acceptance entry terminal rejects quota only success and preserves unsettled partial errors', async () => {
  const { createAcceptanceOwner, acceptanceDeclaration } = await entryModule()
  for (const completed of [true, false]) {
    const context = { ...acceptanceDeclaration('timing'), token: 'c'.repeat(64) }, ports = entryPorts()
    const owner = createAcceptanceOwner(context, ports), identity = { sender: ports.sender, frame: ports.frame }
    owner.claim(identity); await owner.invoke(identity, entryRequest(context, 0, 'baseline', {}))
    const value = entryTerminal(completed)
    if (completed) {
      value.status.settled = false
      await assert.rejects(owner.invoke(identity, entryRequest(context, 1, 'terminal', value)), /settled/)
      value.status.settled = true
    }
    await owner.invoke(identity, entryRequest(context, 1, 'terminal', value))
    assert.equal(owner.state().functionalComplete, completed)
    assert.equal(owner.state().terminal.status.settled, completed)
  }
})

test('physics acceptance entry serialized durable receipt syncs file and directory before acknowledgement', async t => {
  const { createDurableEntryWriter, createAcceptanceOwner, acceptanceDeclaration } = await entryModule()
  const { open } = await import('node:fs/promises')
  const root = await mkdtemp('/tmp/modly-physics-entry-terminal-'), events = []
  const persist = createDurableEntryWriter({
    async openFile(name) { events.push(`open:${name}`); const handle = await open(path.join(root, name), 'wx', 0o600)
      return { async writeFile(bytes) { await handle.writeFile(bytes); events.push(`write:${name}`) }, async sync() { await handle.sync(); events.push(`file-sync:${name}`) }, close: () => handle.close() } },
    async syncDirectory() { const directory = await open(root, 'r'); try { await directory.sync(); events.push('dir-sync') } finally { await directory.close() } },
  })
  await Promise.all([persist('first.json', '{"first":true}\n'), persist('second.json', '{"second":true}\n')])
  assert.ok(events.indexOf('dir-sync') < events.indexOf('open:second.json'))
  const ports = entryPorts({ persist }), context = { ...acceptanceDeclaration('timing'), token: 'd'.repeat(64) }
  const owner = createAcceptanceOwner(context, ports), identity = { sender: ports.sender, frame: ports.frame }
  owner.claim(identity); await owner.invoke(identity, entryRequest(context, 0, 'baseline', {}))
  const receipt = await owner.invoke(identity, entryRequest(context, 1, 'terminal', entryTerminal()))
  events.push('receipt-ack'); assert.ok(events.indexOf('file-sync:acceptance-terminal.json') < events.indexOf('receipt-ack'))
  assert.equal(events.at(-2), 'dir-sync'); assert.equal(receipt.persisted, true)
  const terminal = JSON.parse(await readFile(path.join(root, 'acceptance-terminal.json'), 'utf8'))
  assert.deepEqual(terminal, entryTerminal()); t.diagnostic(`Owned terminal files retained: ${root}`)
})

test('physics acceptance entry real canonical authoring custody reopens ledgers and backups independently', async t => {
  const { WorldProjectRepository } = await import('../electron/main/world-project-repository.ts')
  const { createWorldProjectService } = await import('../src/areas/worlds/worldProjectService.ts')
  const { createWorldEditorController } = await import('../src/areas/worlds/editor/worldEditorController.ts')
  const { authorWorkerFixtureCourse } = await import('./worlds-physics-electron-fixture/worker-contract.ts')
  const { captureWorkerProjectFiles } = await import('./worlds-physics-electron-fixture/worker-driver.ts')
  const { PROJECT_KEY, SCENE_KEY } = await import('./worlds-physics-electron-fixture/shared.ts')
  const { verifyEntryCustody } = await entryModule()
  const workspace = await mkdtemp('/tmp/modly-physics-entry-custody-')
  const repository = new WorldProjectRepository({ getWorkspaceRoot: () => workspace, createProjectKey: () => PROJECT_KEY, createSceneKey: () => SCENE_KEY })
  assert.ok((await repository.create({ name: 'Entry custody', initialSceneName: 'Course' })).ok)
  const editor = createWorldEditorController(createWorldProjectService(repository)), session = await authorWorkerFixtureCourse(editor, 'acceptance-500')
  assert.deepEqual([session.snapshot.project.revision, session.undoStack.length, session.receipts.length], [23, 23, 23])
  const projectRoot = path.join(workspace, 'Worlds', PROJECT_KEY), files = await captureWorkerProjectFiles(projectRoot)
  const state = JSON.parse(await readFile(path.join(projectRoot, '.modly/state.v1.json'), 'utf8'))
  assert.match(state.lastValidBackup, /^\.modly\/backups\/[0-9]+-[a-f0-9]{64}$/)
  const backup = files.find(file => /^\.modly\/backups\/[0-9]+-[a-f0-9]{64}\/project\.world-project\.json$/.test(file.path) && path.dirname(file.path) !== state.lastValidBackup); assert.ok(backup)
  const backupRoot = path.dirname(backup.path), backupState = JSON.parse(await readFile(path.join(projectRoot, backupRoot, 'state.v1.json'), 'utf8'))
  assert.ok(['project.world-project.json', '.modly/state.v1.json', ...state.scenes.map(scene => `scenes/${path.basename(scene.path)}`), ...state.transactions.map(tx => `.modly/transactions/${tx.transactionDigest}/after/result.v1.json`), ...['state.v1.json', 'transactions.pack.v1', 'transactions.index.v1.json'].map(name => `${backupRoot}/${name}`), ...backupState.scenes.map(scene => `${backupRoot}/scenes/${path.basename(scene.path)}`)].every(member => files.some(file => file.path === member)))
  const baseline = { snapshot: session.snapshot, files }
  const ports = { capture: () => captureWorkerProjectFiles(projectRoot), reopen: () => new WorldProjectRepository({ getWorkspaceRoot: () => workspace }).open({ projectKey: PROJECT_KEY }) }
  assert.equal((await verifyEntryCustody(baseline, ports)).unchanged, true)
  await (await import('node:fs/promises')).chmod(path.join(projectRoot, backup.path), 0o600)
  await writeFile(path.join(projectRoot, backup.path), 'mutated owned backup')
  const reopened = await ports.reopen(); assert.ok(reopened.ok && reopened.value.status === 'ready'); assert.deepEqual(reopened.value.snapshot, baseline.snapshot)
  await assert.rejects(verifyEntryCustody(baseline, ports), /Independent project\/ledger\/backup custody changed\./)
  t.diagnostic(`Owned project and mutation retained: ${workspace}`)
})

test('physics acceptance entry renderer reaches canonical author pump and terminal without per tick exports', async () => {
  const { build } = await import('esbuild'), repo = path.resolve(import.meta.dirname, '..')
  const calls = [], status = entryTerminal().status
  const globalKeys = ['window', 'document', '__entryCalls'], saved = new Map(globalKeys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const session = { snapshot: { project: { startSceneId: 'scene:test', inputActions: [] } } }
  const mocks = new Map([
    ['worldEditorController.ts', `export function createWorldEditorController() { return { getState(){return {session:null}} } }`],
    ['worldProjectService.ts', `export function createWorldProjectService(){ return {} }`],
    ['worldPlayController.ts', `export function createWorldPlayController(){return {getState(){return {lifecycle:'edit'}}}}`],
    ['worldPhysicsRuntime.ts', `export function createBrowserWorldPhysicsRuntime(){throw Error('Native execution forbidden')}`],
    ['worldAudioRuntime.ts', `export function createBrowserWorldAudioAuthority(){throw Error('Audio execution forbidden')}`],
    ['worldInputRuntime.ts', `export class WorldInputSampler {}`],
    ['observation.ts', `export class PhysicsObservation {view(){return {acknowledgedSequence:0}}}`],
    ['worker-contract.ts', `export function assertWorker(value,message){if(!value)throw Error(message)}; export async function authorWorkerFixtureCourse(editor,scenario){globalThis.__entryCalls.push(['author',scenario]);return ${JSON.stringify(session)}}; export function parseWorkerFixtureCommand(){};export function sampleWorkerControls(){};export function workerFrameTimestamp(){}`],
    ['worker-acceptance-pump.ts', `export function createPhysicsAcceptancePump(phase,ids){globalThis.__entryCalls.push(['pump',phase,ids.length]);return {status(){return ${JSON.stringify(status)}},async runPhase(){globalThis.__entryCalls.push(['run']);return this.status()},async cancel(){globalThis.__entryCalls.push(['cancel']);return this.status()},exportPhase(){globalThis.__entryCalls.push(['export']);return ${JSON.stringify(entryTerminal().evidence)}}}}`],
    ['worldRuntimeProjection.ts', `export function projectWorldRuntimeScene(){return {success:true,value:{physics:{bodies:Array.from({length:504},(_,n)=>({entityId:'entity:'+n}))}}}}`],
  ])
  try {
    Object.assign(globalThis, { __entryCalls: calls, window: { addEventListener() {} }, document: { getElementById: () => ({}), querySelectorAll: () => [] } })
    const bundle = await build({ entryPoints: [path.join(repo, 'scripts/worlds-physics-electron-fixture/worker-renderer.ts')], bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022', logLevel: 'silent', plugins: [{ name: 'entry-fixture-facades', setup(api) {
      api.onResolve({ filter: /\.ts$/ }, args => { const key = path.basename(args.path); if (mocks.has(key)) return { path: key, namespace: 'entry-facade' } })
      api.onLoad({ filter: /.*/, namespace: 'entry-facade' }, args => ({ contents: mocks.get(args.path), loader: 'ts' }))
    } }] })
    const module = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
    assert.equal(typeof module.runPhysicsAcceptanceEntry, 'function')
    calls.length = 0
    const facade = { async baseline() { calls.push(['baseline']) }, async progress() { calls.push(['progress']) }, async terminal(value) { calls.push(['terminal', value.nativeAccepted]); return { persisted: true } }, onCancel() { return () => {} } }
    await module.runPhysicsAcceptanceEntry({ phase: 'timing', authorMs: 45000 }, facade)
    assert.deepEqual(calls.filter(call => call[0] !== 'progress'), [['author', 'acceptance-500'], ['baseline'], ['pump', 'timing', 504], ['run'], ['export'], ['terminal', false]])
  } finally { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } }
})

test('physics acceptance entry actual main finalizer requires durable report before successful exit', async t => {
  const ts = createRequire(import.meta.url)('typescript'), { transform } = await import('esbuild')
  const { boundedEntryOperation, createDurableEntryWriter, stableEntryJson, acceptanceDeclaration } = await entryModule()
  const { open } = await import('node:fs/promises'), text = await source('main.ts')
  const ast = ts.createSourceFile('main.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), candidates = []
  const durability = node => ts.isExpressionStatement(node) && ts.isAwaitExpression(node.expression)
    && ts.isCallExpression(node.expression.expression) && node.expression.expression.expression.getText(ast) === 'boundedEntryOperation'
    && node.expression.expression.arguments.some(arg => ts.isStringLiteral(arg) && arg.text === 'Acceptance final report durability')
    && ts.isCallExpression(node.expression.expression.arguments[0])
    && node.expression.expression.arguments[0].expression.getText(ast) === 'persistEntry'
    && node.expression.expression.arguments[0].arguments[0].text === 'acceptance-report.json'
  const visit = node => { if (ts.isTryStatement(node) && node.tryBlock.statements.some(durability)) candidates.push(node); ts.forEachChild(node, visit) }
  visit(ast); assert.equal(candidates.length, 1, 'Select the actual precise main durability finalizer, not copied logic.')
  const selected = candidates[0], siblings = selected.parent.statements, previous = siblings[siblings.indexOf(selected) - 1]
  const localExit = previous && ts.isVariableStatement(previous) && previous.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'entryExitCode') ? previous.getText(ast) : ''
  const parameters = `scope: { boundedEntryOperation: (...args: unknown[]) => Promise<unknown>; persistEntry: (name: string, bytes: string) => Promise<void>; stableEntryJson: (value: unknown) => string; report: Record<string, unknown>; entryDeclaration: { graceMs: number }; fixtureWindow: null | { isDestroyed(): boolean; destroy(): void }; app: { exit(code: number): void } }`
  const compiled = await transform(`export async function finalize(${parameters}) { const { boundedEntryOperation, persistEntry, stableEntryJson, report, entryDeclaration, fixtureWindow, app } = scope; ${localExit}\n${selected.getText(ast)} }`, { loader: 'ts', format: 'esm', target: 'es2022' })
  const { finalize } = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`)
  for (const collision of [false, true]) {
    const root = await mkdtemp('/tmp/modly-physics-entry-final-report-'), events = [], exits = []
    const persistEntry = createDurableEntryWriter({ openFile: name => open(path.join(root, name), 'wx', 0o600),
      async syncDirectory() { const handle = await open(root, 'r'); try { await handle.sync(); events.push('dir-sync') } finally { await handle.close() } } })
    if (collision) await writeFile(path.join(root, 'acceptance-report.json'), 'retained owned collision\n', { flag: 'wx', mode: 0o600 })
    const report = { status: 'FUNCTIONAL_COMPLETE', nativeAccepted: false }, fixtureWindow = { isDestroyed: () => false, destroy: () => events.push('destroy') }
    let failure = null
    try { await finalize({ boundedEntryOperation, persistEntry, stableEntryJson, report, entryDeclaration: acceptanceDeclaration('timing'), fixtureWindow, app: { exit: code => { exits.push(code); events.push(`exit:${code}`) } } }) } catch (cause) { failure = cause }
    t.diagnostic(`Actual AST-selected finalizer collision=${collision} exits=${exits} retained=${root}`)
    assert.deepEqual(exits, [collision ? 1 : 0], 'Final report durability failure must not grant process success.')
    assert.ok(events.indexOf('destroy') < events.indexOf(`exit:${collision ? 1 : 0}`))
    if (collision) { assert.ok(failure?.code === 'EEXIST' || report.finalReportPersistenceError?.includes('EEXIST')); assert.equal(report.status, 'PARTIAL') }
    else { assert.equal(failure, null); assert.ok(events.indexOf('dir-sync') < events.indexOf('exit:0')); assert.equal(JSON.parse(await readFile(path.join(root, 'acceptance-report.json'), 'utf8')).status, 'FUNCTIONAL_COMPLETE') }
  }
})

test('physics acceptance entry forced partial revokes pending baseline and terminal durability acknowledgements', async t => {
  const { createAcceptanceOwner, createDurableEntryWriter, acceptanceDeclaration } = await entryModule()
  const { open } = await import('node:fs/promises')
  for (const pendingPartial of [false, true]) {
    const root = await mkdtemp('/tmp/modly-physics-entry-baseline-revocation-'), baseline = graphicsGate(), synced = graphicsGate(), releaseSync = graphicsGate()
    const persist = createDurableEntryWriter({ openFile: name => open(path.join(root, name), 'wx', 0o600),
      async syncDirectory() { const handle = await open(root, 'r'); try { await handle.sync() } finally { await handle.close() }; synced.resolve(); if (pendingPartial) await releaseSync.promise } })
    const context = { ...acceptanceDeclaration('timing'), token: 'e'.repeat(64) }, ports = entryPorts({ captureBaseline: () => baseline.promise, persist })
    const owner = createAcceptanceOwner(context, ports), identity = { sender: ports.sender, frame: ports.frame }
    owner.claim(identity)
    const pending = owner.invoke(identity, entryRequest(context, 0, 'baseline', {})).then(value => ({ value }), cause => ({ cause }))
    await assert.rejects(owner.invoke(identity, entryRequest(context, 0, 'progress', {})), /pending/)
    const forced = owner.forcePartial('Renderer cancellation did not settle.')
    await synced.promise
    if (!pendingPartial) await forced
    const partialFile = JSON.parse(await readFile(path.join(root, 'acceptance-terminal.json'), 'utf8'))
    assert.equal(partialFile.result, 'partial'); assert.equal(partialFile.status.settled, false)
    baseline.resolve(null); const outcome = await pending
    releaseSync.resolve(); await forced
    t.diagnostic(`Actual owner baseline revocation partialPending=${pendingPartial} retained=${root}`)
    assert.ok(outcome.cause, 'Forced partial must revoke even an acknowledgement awaiting partial durability.')
    assert.match(String(outcome.cause), /revoked|terminal/)
    assert.equal(owner.state().baselineCaptured, false); assert.equal(owner.state().functionalComplete, false)
    await assert.rejects(owner.invoke(identity, entryRequest(context, 0, 'baseline', {})), /revoked|terminal/)
  }
  const root = await mkdtemp('/tmp/modly-physics-entry-terminal-revocation-'), synced = graphicsGate(), releaseSync = graphicsGate()
  let directorySyncs = 0
  const persist = createDurableEntryWriter({ openFile: name => open(path.join(root, name), 'wx', 0o600),
    async syncDirectory() { const handle = await open(root, 'r'); try { await handle.sync() } finally { await handle.close() }; if (++directorySyncs === 1) { synced.resolve(); await releaseSync.promise } } })
  const context = { ...acceptanceDeclaration('timing'), token: 'f'.repeat(64) }, ports = entryPorts({ persist })
  const owner = createAcceptanceOwner(context, ports), identity = { sender: ports.sender, frame: ports.frame }
  owner.claim(identity); await owner.invoke(identity, entryRequest(context, 0, 'baseline', {}))
  const terminal = owner.invoke(identity, entryRequest(context, 1, 'terminal', entryTerminal())).then(value => ({ value }), cause => ({ cause }))
  await synced.promise
  const partial = owner.forcePartial('Cancellation raced terminal durability.').then(value => ({ value }), cause => ({ cause }))
  releaseSync.resolve(); const terminalOutcome = await terminal, partialOutcome = await partial
  assert.ok(terminalOutcome.cause); assert.match(String(terminalOutcome.cause), /revoked|terminal/)
  assert.equal(partialOutcome.cause?.code, 'EEXIST', 'Actual exclusive queued terminal file cannot be overwritten or silently retried.')
  assert.equal(owner.state().terminal, null); assert.equal(owner.state().functionalComplete, false)
  assert.equal(JSON.parse(await readFile(path.join(root, 'acceptance-terminal.json'), 'utf8')).result, 'completed', 'Retain actual written bytes without claiming forced partial durability.')
  await assert.rejects(owner.invoke(identity, entryRequest(context, 1, 'progress', {})), /revoked|terminal/)
  assert.throws(() => owner.receipt(identity, entryRequest(context, 1, 'receipt')), /revoked|terminal/)
  t.diagnostic(`Actual exclusive terminal cancellation collision retained=${root}`)
  for (const changed of ['frame', 'deadline']) {
    const gate = graphicsGate(), latePorts = entryPorts({ captureBaseline: () => gate.promise }), lateOwner = createAcceptanceOwner(context, latePorts)
    const lateIdentity = { sender: latePorts.sender, frame: latePorts.frame }; lateOwner.claim(lateIdentity)
    const operation = lateOwner.invoke(lateIdentity, entryRequest(context, 0, 'baseline', {})).then(value => ({ value }), cause => ({ cause }))
    if (changed === 'frame') latePorts.frame = {}; else latePorts.clock.value = lateOwner.state().deadlineMs
    gate.resolve(null); assert.match(String((await operation).cause), /sender|deadline/); assert.equal(lateOwner.state().baselineCaptured, false)
  }
})

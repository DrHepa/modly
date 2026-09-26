import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { applyWorldEditorCommandBatch, createWorldEditorSession, undoWorldEditorSession } from '../core/worldSessions.ts'
import { createRuntimeWorldSnapshot } from '../runtime/_testFixtures.ts'
import { createWorldPlayController } from '../runtime/worldPlayController.ts'

const require = createRequire(import.meta.url)
const React = require('react') as typeof import('react')
const source = path.join(import.meta.dirname, 'WorldViewportBoundary.tsx')
// Real React reconciliation with an in-memory host, not a DOM/WebGL substitute.
const Reconciler = require('react-reconciler')
const { outputFiles } = await build({ entryPoints: [source], bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', jsx: 'automatic', logLevel: 'silent' })
const compiled = { exports: {} as typeof import('./WorldViewportBoundary.tsx') }
new Function('require', 'module', 'exports', outputFiles[0].text)(require, compiled, compiled.exports)
const { WorldViewportBoundary, createWorldViewportRecovery, observeWorldCanvasContext } = compiled.exports

type Host = { type: string; props: Record<string, any>; children: Host[] }
function mounted(options: { concurrent?: boolean; strict?: boolean } = {}) {
  const append = (parent: Host, child: Host) => { parent.children.push(child) }
  const remove = (parent: Host, child: Host) => { parent.children.splice(parent.children.indexOf(child), 1) }
  const renderer = Reconciler({
    now: performance.now.bind(performance), supportsMutation: true, isPrimaryRenderer: true,
    getRootHostContext: () => null, getChildHostContext: () => null, getPublicInstance: (node: Host) => node,
    prepareForCommit: () => null, resetAfterCommit() {}, shouldSetTextContent: () => false,
    createInstance: (type: string, props: Host['props']) => ({ type, props, children: [] }),
    createTextInstance: (text: string) => ({ type: '#text', props: { text }, children: [] }),
    appendInitialChild: append, appendChild: append, appendChildToContainer: append,
    removeChild: remove, removeChildFromContainer: remove, clearContainer: (node: Host) => { node.children = [] },
    insertBefore: append, insertInContainerBefore: append, finalizeInitialChildren: () => false,
    prepareUpdate: () => true, commitUpdate: (node: Host, _payload: unknown, _type: unknown, _old: unknown, props: Host['props']) => { node.props = props },
    commitTextUpdate: (node: Host, _old: unknown, text: string) => { node.props.text = text },
    scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1, getCurrentEventPriority: () => 1,
    detachDeletedInstance() {}, supportsMicrotasks: true, scheduleMicrotask: queueMicrotask,
  })
  const container: Host = { type: 'root', props: {}, children: [] }
  const root = renderer.createContainer(container, options.concurrent ? 1 : 0, null, options.strict ?? false, null, '', () => {}, null)
  return {
    container,
    render: (value: import('react').ReactNode) => { renderer.flushSync(() => renderer.updateContainer(value, root, null, null)); renderer.flushPassiveEffects() },
    transition: (value: import('react').ReactNode) => React.startTransition(() => renderer.updateContainer(value, root, null, null)),
    flush: () => { renderer.flushSync(() => {}); renderer.flushPassiveEffects() },
  }
}
const find = (node: Host, predicate: (node: Host) => boolean): Host | undefined => predicate(node) ? node : node.children.map((child) => find(child, predicate)).find(Boolean)

test('mounted boundary contains render and layout startup exceptions and retries only explicitly', () => {
  for (const phase of ['render', 'layout'] as const) {
    const host = mounted()
    let stopped = 0
    let cleaned = 0
    let fail = false
    const recovery = createWorldViewportRecovery(() => { stopped += 1 })
    let lease = recovery.capture()
    function Viewport(): import('react').ReactNode {
      React.useEffect(() => () => { cleaned += 1 }, [])
      React.useLayoutEffect(() => { if (fail && phase === 'layout') throw new Error('WebGL startup failed') })
      if (fail && phase === 'render') throw new Error('WebGL startup failed')
      return React.createElement('canvas')
    }
    const render = () => host.render(React.createElement('main', null,
      React.createElement('button', { 'aria-label': 'Editor control' }, 'Scene'),
      React.createElement(WorldViewportBoundary, { key: recovery.getState().attempt, failure: recovery.getState().failure, lease, onRetry: () => { recovery.retry(); lease = recovery.capture(); render() }, children: React.createElement(Viewport) }),
    ))
    render()
    fail = true
    const original = console.error
    console.error = () => {} // React's expected caught-error diagnostic, scoped to this mount.
    try { render() } finally { console.error = original }
    assert.equal(stopped, 1)
    assert.equal(cleaned, 1)
    assert.ok(find(host.container, (node) => node.props['aria-label'] === 'Editor control'))
    assert.ok(find(host.container, (node) => node.props.role === 'alert'))
    assert.equal(find(host.container, (node) => node.type === 'canvas'), undefined)
    render() // A parent update / edit transition cannot reset the failure latch.
    assert.equal(stopped, 1)
    fail = false
    find(host.container, (node) => node.props['aria-label'] === 'Retry viewport')!.props.onClick()
    assert.ok(find(host.container, (node) => node.type === 'canvas'))
    assert.equal(stopped, 1)
    host.render(null)
  }
})

test('initial render and layout failures are contained before or during the first commit', () => {
  for (const phase of ['render', 'layout'] as const) {
  const host = mounted()
  let failures = 0
  const recovery = createWorldViewportRecovery(() => { failures += 1 })
  const lease = recovery.capture()
  function Broken(): import('react').ReactNode {
    React.useLayoutEffect(() => { if (phase === 'layout') throw new Error('Error creating WebGL context.') }, [])
    if (phase === 'render') throw new Error('Error creating WebGL context.')
    return React.createElement('canvas')
  }
  const original = console.error
  console.error = () => {}
  try {
    host.render(React.createElement(WorldViewportBoundary, { failure: null, lease, onRetry() {}, children: React.createElement(Broken) }))
  } finally { console.error = original }
  assert.equal(failures, 1)
  assert.ok(find(host.container, (node) => node.props['aria-label'] === 'Retry viewport'))
  host.render(null)
  }
})

test('a child layout context-loss signal is delivered when its boundary commits', () => {
  const host = mounted()
  let calls = 0
  const recovery = createWorldViewportRecovery(() => { calls += 1 })
  const lease = recovery.capture()
  function LostCanvas(): import('react').ReactNode {
    React.useLayoutEffect(() => { lease.fail({ kind: 'context-lost', message: 'Already lost' }) }, [])
    return React.createElement('canvas')
  }
  assert.equal(lease.isCurrent(), false, 'Allocating during render cannot acquire authority')
  host.render(React.createElement(WorldViewportBoundary, { failure: null, lease, onRetry() {}, children: React.createElement(LostCanvas) }))
  assert.equal(calls, 1)
  assert.equal(recovery.getState().failure?.kind, 'context-lost')
  host.render(null)
})

test('StrictMode replay keeps the committed owner current and releases it on unmount', () => {
  const host = mounted({ concurrent: true, strict: true })
  const recovery = createWorldViewportRecovery(() => {})
  let committed: ReturnType<typeof recovery.capture> | undefined
  function View({ generation }: { generation: number }): import('react').ReactNode {
    const lease = React.useMemo(() => recovery.capture(), [generation])
    React.useLayoutEffect(() => { committed = lease })
    return React.createElement(WorldViewportBoundary, { failure: null, lease, onRetry() {}, children: React.createElement('canvas') })
  }
  host.render(React.createElement(View, { generation: 0 }))
  const first = committed!
  assert.equal(first.isCurrent(), true)
  host.render(React.createElement(View, { generation: 1 }))
  assert.equal(first.isCurrent(), false)
  assert.equal(committed!.isCurrent(), true)
  host.render(null)
  assert.equal(committed!.isCurrent(), false)
})

for (const replacement of ['abandoned', 'committed'] as const) test(`${replacement} replacement transfers authority only at an actual boundary commit`, async () => {
  const host = mounted({ concurrent: true })
  let calls = 0
  let reportedGeneration: number | null = null
  const recovery = createWorldViewportRecovery(() => { calls += 1 })
  let suspended = false
  let speculative: ReturnType<typeof recovery.capture> | undefined
  let committed: ReturnType<typeof recovery.capture> | undefined
  const pending = new Promise<void>(() => {})
  function View({ generation }: { generation: number }): import('react').ReactNode {
    const lease = React.useMemo(() => recovery.capture(() => { calls += 1; reportedGeneration = generation }), [generation])
    React.useLayoutEffect(() => { committed = lease })
    if (generation === 1) { speculative = lease; suspended = true; throw pending }
    return React.createElement(WorldViewportBoundary, { failure: recovery.getState().failure, lease, onRetry() {}, children: React.createElement('canvas', { generation }) })
  }
  const tree = (generation: number) => React.createElement(React.Suspense, { fallback: React.createElement('aside') }, React.createElement(View, { generation }))
  host.render(tree(0))
  const first = committed!
  host.transition(tree(1))
  for (let index = 0; index < 100 && !suspended; index += 1) await new Promise((resolve) => setTimeout(resolve, 1))
  assert.equal(suspended, true)
  assert.ok(find(host.container, (node) => node.type === 'canvas' && node.props.generation === 0), 'Original viewport remains committed')
  assert.equal(first.isCurrent(), true)
  assert.equal(speculative!.isCurrent(), false)
  speculative!.fail({ kind: 'context-lost', message: 'Uncommitted candidate' })
  assert.equal(calls, 0, 'An abandoned candidate cannot stop the committed runtime')
  if (replacement === 'committed') {
    host.render(tree(2))
    assert.equal(first.isCurrent(), false)
    first.fail({ kind: 'context-lost', message: 'Stale old committed canvas' })
    assert.equal(calls, 0)
    committed!.fail({ kind: 'context-lost', message: 'Current committed canvas' })
  } else first.fail({ kind: 'context-lost', message: 'Still-current canvas' })
  assert.equal(calls, 1)
  assert.equal(reportedGeneration, replacement === 'committed' ? 2 : 0, 'The committed owner retains its own lifecycle callback')
  host.render(null)
})

test('a context already lost during listener attachment never reports ready', () => {
  const ready: boolean[] = []
  let failures = 0
  const detach = observeWorldCanvasContext(new EventTarget(), () => { failures += 1 }, (value) => ready.push(value), () => true)
  assert.equal(failures, 1)
  assert.deepEqual(ready, [false])
  detach()
})

test('context listener cleanup, repeated loss and stale attempts cannot stop a fresh viewport', () => {
  let stops = 0
  const recovery = createWorldViewportRecovery(() => { stops += 1 })
  const old = recovery.capture()
  old.commit()
  const canvas = new EventTarget()
  const ready: boolean[] = []
  const dispose = observeWorldCanvasContext(canvas, old.fail, (value) => ready.push(value))
  assert.deepEqual(ready, [true])
  const lost = new Event('webglcontextlost', { cancelable: true })
  canvas.dispatchEvent(lost)
  canvas.dispatchEvent(new Event('webglcontextlost'))
  assert.equal(lost.defaultPrevented, true)
  assert.equal(stops, 1)
  assert.equal(ready.at(-1), false)
  dispose(); dispose()
  assert.equal(recovery.retry(), true)
  const fresh = recovery.capture()
  fresh.commit()
  old.fail({ kind: 'render-error', message: 'Late old renderer' })
  canvas.dispatchEvent(new Event('webglcontextlost'))
  assert.equal(stops, 1)
  assert.equal(recovery.getState().failure, null)
  fresh.fail({ kind: 'render-error', message: 'Fresh failure' })
  fresh.fail({ kind: 'render-error', message: 'Repeated failure' })
  assert.equal(stops, 2)
  recovery.revoke()
  assert.equal(fresh.isCurrent(), false)
})

test('failure stops actual loading, paused and playing controllers once without changing editor history', async () => {
  for (const lifecycle of ['loading', 'paused', 'playing'] as const) {
    const created = createWorldEditorSession(createRuntimeWorldSnapshot())
    assert.ok(created.success)
    let editor = created.session
    for (let index = 0; index < 2; index += 1) {
      const applied = applyWorldEditorCommandBatch(editor, {
        schema: 'modly.world-command-batch.v1', transactionId: `tx:graphics-${index}`, projectId: editor.snapshot.project.projectId,
        baseRevision: editor.snapshot.project.revision, origin: 'ui',
        commands: [{ type: 'rename-project', name: `Authored project ${index}` }],
      })
      assert.ok(applied.success)
      editor = applied.session
    }
    const undone = undoWorldEditorSession(editor)
    assert.ok(undone.success)
    editor = undone.session
    assert.equal(editor.undoStack.length, 1)
    assert.equal(editor.redoStack.length, 1)
    assert.equal(editor.receipts.length, 2)
    const original = structuredClone(editor)
    let disposed = 0
    let audioStopRequested = 0
    let stopCalls = 0
    let release = () => {}
    let releaseAudioStop = () => {}
    let signalInitializationEntered = () => {}
    const initializationEntered = new Promise<void>((resolve) => { signalInitializationEntered = resolve })
    const initialize = lifecycle === 'loading' ? new Promise<void>((resolve) => { release = resolve }) : Promise.resolve()
    const audioStop = new Promise<void>((resolve) => { releaseAudioStop = resolve })
    const controller = createWorldPlayController({
      createPhysics: () => ({ initialize: () => { signalInitializationEntered(); return initialize }, step() {}, pause() {}, resume() {}, dispose() { disposed += 1 } }),
      createAudio: () => ({ async prepareScene() {}, async activate() {}, async play() {}, async stopSource() {}, update() {}, async pause() {}, async resume() {}, stop() { audioStopRequested += 1; return audioStop } }),
    })
    const stops: Array<ReturnType<typeof controller.stop>> = []
    const start = controller.start(editor, 'scene:one')
    try {
    if (lifecycle === 'loading') await Promise.race([
      initializationEntered,
      start.then(() => { throw new Error('Play start ended before authority initialization entry.') }),
    ])
    else await start
    if (lifecycle === 'paused') await controller.pause()
    assert.equal(controller.getState().lifecycle, lifecycle)
    const recovery = createWorldViewportRecovery(() => {
      if (controller.getState().lifecycle !== 'edit') { stopCalls += 1; stops.push(controller.stop()) }
    })
    const lease = recovery.capture()
    lease.commit()
    lease.fail({ kind: 'context-lost', message: 'Context lost' })
    lease.fail({ kind: 'context-lost', message: 'Duplicate event' })
    assert.equal(audioStopRequested, 1, 'Viewport failure must request audio cleanup before the stop result resolves')
    releaseAudioStop(); release(); await start
    assert.equal(stopCalls, 1)
    assert.equal(stops.length, 1)
    assert.ok((await stops[0]).success)
    assert.equal(controller.getState().lifecycle, 'edit')
    assert.ok(disposed >= 1)
    assert.ok(audioStopRequested >= 1)
    assert.deepEqual(editor, original)
    assert.deepEqual(controller.getState().editor, original)
    assert.equal(recovery.retry(), true)
    assert.equal(controller.getState().lifecycle, 'edit', 'Viewport retry never restarts Play')
    } finally {
      releaseAudioStop(); release()
      if (controller.getState().lifecycle !== 'edit') stops.push(controller.stop())
      await Promise.all([start, ...stops])
    }
  }
})

test('viewport loss before authority allocation cancels loading without creating runtime authorities', async () => {
  const created = createWorldEditorSession(createRuntimeWorldSnapshot())
  assert.ok(created.success)
  let editor = created.session
  for (let index = 0; index < 2; index += 1) {
    const applied = applyWorldEditorCommandBatch(editor, {
      schema: 'modly.world-command-batch.v1', transactionId: `tx:preallocation-${index}`, projectId: editor.snapshot.project.projectId,
      baseRevision: editor.snapshot.project.revision, origin: 'ui', commands: [{ type: 'rename-project', name: `Authored project ${index}` }],
    })
    assert.ok(applied.success)
    editor = applied.session
  }
  const undone = undoWorldEditorSession(editor)
  assert.ok(undone.success)
  editor = undone.session
  assert.equal(editor.undoStack.length, 1)
  assert.equal(editor.redoStack.length, 1)
  assert.equal(editor.receipts.length, 2)
  const original = structuredClone(editor)
  let physicsCreated = 0
  let audioCreated = 0
  const controller = createWorldPlayController({
    createPhysics: () => { physicsCreated += 1; throw new Error('Pre-allocation cancellation must not create physics.') },
    createAudio: () => { audioCreated += 1; throw new Error('Pre-allocation cancellation must not create audio.') },
  })
  const stops: Array<ReturnType<typeof controller.stop>> = []
  const recovery = createWorldViewportRecovery(() => { stops.push(controller.stop()) })
  const lease = recovery.capture()
  lease.commit()
  const start = controller.start(editor, 'scene:one')
  try {
    assert.equal(controller.getState().lifecycle, 'loading')
    lease.fail({ kind: 'context-lost', message: 'Immediate viewport loss' })
    lease.fail({ kind: 'context-lost', message: 'Duplicate event' })
    assert.equal(stops.length, 1)
    assert.ok((await stops[0]).success)
    const started = await start
    assert.equal(started.success, false)
    if (!started.success) assert.equal(started.issues[0]?.code, 'runtime-load-cancelled')
    assert.equal(controller.getState().lifecycle, 'edit')
    assert.equal(physicsCreated, 0)
    assert.equal(audioCreated, 0)
    assert.deepEqual(editor, original)
    assert.deepEqual(controller.getState().editor, original)
    assert.equal(recovery.retry(), true)
    assert.equal(controller.getState().lifecycle, 'edit', 'Viewport retry never restarts Play')
    assert.equal(physicsCreated, 0, 'No late physics allocation after canceled start or retry')
    assert.equal(audioCreated, 0, 'No late audio allocation after canceled start or retry')
  } finally {
    if (controller.getState().lifecycle !== 'edit') stops.push(controller.stop())
    await Promise.all([start, ...stops])
    lease.release()
  }
})

test('production integration keeps the whole viewport below the boundary and gates runtime advances', async () => {
  const workbench = await readFile(path.join(import.meta.dirname, 'WorldsWorkbench.tsx'), 'utf8')
  const runtime = await readFile(path.join(import.meta.dirname, 'WorldRuntimeViewport.tsx'), 'utf8')
  const viewer = await readFile(path.join(import.meta.dirname, 'WorldsViewer.tsx'), 'utf8')
  assert.match(workbench, /<WorldViewportBoundary[\s\S]*<WorldsViewer[\s\S]*<WorldRuntimeViewport[\s\S]*<\/WorldViewportBoundary>/)
  assert.match(runtime, /lifecycle !== 'playing' \|\| !graphicsReady/)
  assert.match(runtime, /!graphicsReadyRef\.current/)
  assert.match(runtime, /<WorldCanvasLifecycle/)
  assert.match(viewer, /<WorldCanvasLifecycle/)
})

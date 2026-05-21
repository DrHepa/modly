import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import test from 'node:test'
import React from 'react'
import { buildSync } from 'esbuild'
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import type { Workflow } from '@shared/types/electron.d'

const require = createRequire(import.meta.url)
const Reconciler = require('react-reconciler')
const root = path.resolve(import.meta.dirname, '../../..')
const ids = ['left_shoulder', 'right_shoulder', 'hip', 'left_knee', 'right_knee']
const artifact = (id: string) => ({ id, versionId: `${id}-v1`, kind: 'mesh', uri: `/workspace/${id}.glb`, legacy: { filePath: `/workspace/${id}.glb`, outputType: 'mesh' } })
const checkpoint = (nodeId: string, revision = 1) => ({
  owner: { nodeId, revision, runId: 'run', inputArtifactId: nodeId, inputVersionId: `${nodeId}-v1` },
  substitutionPoint: { kind: 'artifact_substitution', nodeId, inputArtifactId: nodeId, inputArtifact: artifact(nodeId), allowedKinds: ['mesh'], status: 'declared', interaction: { boundary: 'ui_only', headless: false, editor: 'none', continueMode: 'manual' } },
})
const points = () => Object.fromEntries(ids.map(id => [id, { id, name: id, world: { x: 0, y: 1, z: 2 }, confidence: 1, source: 'manual' }]))

// Real React hooks and subscription commits; host elements and Electron/Flow are
// inert adapters, not a browser DOM, native viewer or actual IPC qualification.
function mount(Component: any, props: any) {
  const container: any = { children: [] }, context = {}
  const append = (parent: any, child: any) => { parent.children.push(child) }
  const remove = (parent: any, child: any) => { parent.children.splice(parent.children.indexOf(child), 1) }
  const renderer = Reconciler({
    now: Date.now, supportsMutation: true, isPrimaryRenderer: false,
    getRootHostContext: () => context, getChildHostContext: () => context,
    getPublicInstance: (value: any) => value, prepareForCommit: () => null, resetAfterCommit: () => {},
    createInstance: (type: string, props: any) => ({ type, props, children: [] }),
    createTextInstance: (text: string) => ({ type: '#text', text, children: [] }),
    appendInitialChild: append, appendChild: append, appendChildToContainer: append,
    removeChild: remove, removeChildFromContainer: remove,
    insertBefore: (parent: any, child: any, before: any) => parent.children.splice(parent.children.indexOf(before), 0, child),
    shouldSetTextContent: () => false, finalizeInitialChildren: () => false, prepareUpdate: () => true,
    commitUpdate: (instance: any, _payload: any, _type: any, _old: any, props: any) => { instance.props = props },
    commitTextUpdate: (instance: any, _old: any, text: string) => { instance.text = text },
    clearContainer: (target: any) => { target.children = [] },
    scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1,
    detachDeletedInstance: () => {}, getCurrentEventPriority: () => 1,
  })
  const tree = renderer.createContainer(container, 0, null, false, null, '', (error: Error) => { throw error }, null)
  const all = (node: any = container): any[] => [node, ...node.children.flatMap((child: any) => all(child))]
  const act = (fn: () => void) => { renderer.flushSync(fn); renderer.flushPassiveEffects() }
  const update = (next: any) => act(() => renderer.updateContainer(next ? React.createElement(Component, next) : null, tree, null))
  update(props)
  const text = (node: any): string => node.text ?? node.children.map(text).join('')
  const button = (label: string, parent = container) => all(parent).find(node => node.type === 'button' && text(node).trim() === label)
  return { all, text: (node = container) => text(node), button, act, update, unmount: () => update(null) }
}

function fixture(entry: string, actualStore?: any) {
  const calls: any[] = []
  const state: any = {
    runState: { status: 'paused', blockStep: '', blockIndex: 0, blockTotal: 1, blockProgress: 0 },
    activeNodeId: null, activeCheckpointNodeId: 'a', runningBranchId: null,
    waitStates: { a: 'pending', b: 'pending' }, checkpoints: { a: checkpoint('a'), b: checkpoint('b') },
    nodeArtifacts: {}, artifactLineages: {}, landmarkSidecars: {},
    getPendingReplacement: () => undefined,
    setLiveNodeParams: (...args: any[]) => calls.push(['live', ...args]),
    run: (...args: any[]) => calls.push(['run', ...args]), cancel: () => calls.push(['cancel']),
    continueRun: (...args: any[]) => { calls.push(['continue', ...args]) },
    selectCheckpoint: (...args: any[]) => { calls.push(['select', ...args]); return true },
    clearLandmarks: (...args: any[]) => { calls.push(['clear', ...args]); return true },
    setActiveLandmark: (...args: any[]) => { calls.push(['mark', ...args]); return true },
  }
  const store = actualStore ?? createStore<any>(() => state)
  const hook = Object.assign((selector = (s: any) => s) => useStore(store, selector), { getState: store.getState })
  const extensions: any = { modelExtensions: [], processExtensions: [], installedWeightVariants: {}, loadExtensions: () => {} }
  const workflows: any = { workflows: [], activeId: null, load: () => {}, save: async (value: any) => { calls.push(['save', value]); return { success: true } }, setActive: () => {} }
  const nav = { openExtension: (...args: any[]) => calls.push(['open', ...args]), navigate: () => {} }
  const fs = { listFiles: async (...args: any[]) => { calls.push(['files', ...args]); return [] } }
  const app: any = { currentJob: null, apiUrl: 'https://inert.invalid', generationOptions: { modelId: 'model', modelParams: {}, textureResolution: 512, enableTexture: false, remesh: 'none' }, setGenerationOptions: (value: any) => calls.push(['options', value]), showToast: (message: string) => calls.push(['toast', message]) }
  const backend: any = { schema: [] }
  const stubs: Record<string, any> = {
    useApi: { useApi: () => ({ getAllModelsStatus: async () => [{ id: 'model', name: 'Model', downloaded: true }] }) },
    ui: { FieldLabel: ({ label }: any) => React.createElement('label', null, label), Tooltip: ({ children }: any) => children, ConfirmModal: () => null },
    workflowRunStore: { useWorkflowRunStore: hook },
    extensionsStore: { useExtensionsStore: (selector?: any) => selector ? selector(extensions) : extensions },
    workflowsStore: { useWorkflowsStore: Object.assign(() => workflows, { getState: () => workflows }) },
    appStore: { useAppStore: (selector?: any) => selector ? selector(app) : app },
    navStore: { useNavStore: (selector?: any) => selector ? selector(nav) : nav },
    BaseNode: { __esModule: true, default: ({ subheader, handles, children }: any) => React.createElement('section', null, subheader, handles, children) },
    ChatPanel: { __esModule: true, default: () => null },
  }
  const module: any = { exports: {} }
  const result = buildSync({
    entryPoints: [path.join(root, entry)], tsconfig: path.join(root, 'tsconfig.web.json'),
    bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['react', 'react/*', '@xyflow/react', ...Object.keys(stubs).flatMap(name => [`*/${name}`, `*/${name}.tsx`, `*/${name}.ts`])],
    loader: { '.webp': 'dataurl' },
  })
  const reactFlow = {
    Handle: 'handle', Position: { Left: 'left', Right: 'right' }, ReactFlowProvider: ({ children }: any) => children,
    useReactFlow: () => ({ updateNodeData: (...args: any[]) => calls.push(['update', ...args]) }),
    useNodesState: (nodes: any) => React.useState(nodes), useEdgesState: (edges: any) => React.useState(edges),
  }
  vm.runInNewContext(result.outputFiles[0].text, {
    module, exports: module.exports, console, Promise, setTimeout, clearTimeout,
    window: { electron: { fs } },
    fetch: async () => ({ json: async () => backend.schema }),
    require: (id: string) => id === '@xyflow/react' ? reactFlow : stubs[path.basename(id).replace(/\.(tsx?|jsx?)$/, '')] ?? require(id),
  })
  return { module: module.exports, store, state, calls, extensions, workflows, app, backend }
}

for (const [entry, name] of [['src/areas/workflows/nodes/WaitNode.tsx', 'default'], ['src/areas/generate/components/WorkflowPanel.tsx', 'WaitParamRow']]) {
  test(`mounted ${entry} follows per-node state and a freshly published replacement owner`, () => {
    const f = fixture(entry), h = mount(f.module[name], { nodeId: 'a', id: 'a', data: { params: {} } })
    try {
      assert.ok(h.button('Continue'), 'a top-level checkpoint has no activeNodeId')
      assert.match(h.text(), /Temporary checkpoint/)
      assert.equal(h.button('Continue with replacement'), undefined)
      const cp = { ...checkpoint('a', 2), pendingReplacement: artifact('edited-a') }
      h.act(() => f.store.setState({ checkpoints: { ...f.state.checkpoints, a: cp } }))
      assert.ok(h.button('Continue with replacement'), 'publication rerenders the subscribed checkpoint')
      h.act(() => h.button('Continue with replacement').props.onClick())
      assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1))), ['continue', 'a', { owner: cp.owner, replacementArtifact: cp.pendingReplacement }])
      h.act(() => h.button('Continue').props.onClick())
      assert.deepEqual(f.calls.at(-1), ['continue', 'a'], 'normal Continue explicitly keeps original')
      h.act(() => f.store.setState({ runningBranchId: 'b' }))
      assert.equal(h.button('Continue').props.disabled, true)
      assert.equal(h.button('Continue with replacement').props.disabled, true)
      for (const status of ['blocked', 'running', 'done', 'error']) {
        h.act(() => f.store.setState({ runningBranchId: null, waitStates: { a: status, b: 'pending' } }))
        const label = status === 'running' ? 'Running…' : status === 'done' || status === 'error' ? 'Retry' : 'Continue'
        assert.equal(h.button(label).props.disabled, status === 'blocked' || status === 'running', status)
      }
      h.act(() => f.store.setState({ checkpoints: { ...f.state.checkpoints, a: checkpoint('a', 3) } }))
      assert.equal(h.button('Continue with replacement'), undefined, 'clearing pending rerenders without borrowing the prior revision')
    } finally { h.unmount() }
  })
}

test('mounted landmark node continues only its own complete capture and exposes recoverable errors', () => {
  const f = fixture('src/areas/workflows/nodes/LandmarksNode.tsx')
  const capture = { nodeId: 'a', completed: points(), canContinue: true, sidecarStatus: 'not_started' }
  f.store.setState({ checkpoints: { a: { ...checkpoint('a'), landmarkCapture: capture } } })
  const h = mount(f.module.default, { id: 'a', data: { params: {} } })
  try {
    assert.ok(h.button('Continue workflow'))
    assert.equal(h.button('Continue workflow').props.disabled, false)
    h.act(() => h.button('Continue workflow').props.onClick())
    assert.deepEqual(f.calls.at(-1), ['continue', 'a'])
    h.act(() => f.store.setState({ runningBranchId: 'b' }))
    assert.equal(h.button('Continue workflow').props.disabled, true)
    h.act(() => f.store.setState({ runningBranchId: null, checkpoints: { a: { ...checkpoint('a'), landmarkCapture: { ...capture, sidecarStatus: 'pending-write' } } } }))
    assert.equal(h.button('Continue workflow').props.disabled, true)
    h.act(() => f.store.setState({ checkpoints: { a: { ...checkpoint('a'), landmarkCapture: { ...capture, sidecarStatus: 'error', error: 'Write rejected' } } } }))
    assert.match(h.text(), /Write rejected/)
    assert.equal(h.button('Continue workflow').props.disabled, false)
  } finally { h.unmount() }
})


test('mounted concurrent Wait rows do not borrow pending copies or history from another checkpoint', () => {
  const f = fixture('src/areas/generate/components/WorkflowPanel.tsx')
  const a = { ...checkpoint('a', 2), pendingReplacement: artifact('edited-a') }
  f.store.setState({ checkpoints: { a, b: checkpoint('b') } })
  const h = mount(f.module.WaitParamRow, { nodeId: 'b' })
  try {
    assert.equal(h.button('Continue with replacement'), undefined)
    h.act(() => h.button('Artifact historyReview the checkpoint artifact before you continue.').props.onClick())
    assert.match(h.text(), /b\.glb/)
    assert.doesNotMatch(h.text(), /edited-a|a\.glb|Final output/)
    h.act(() => h.button('Continue').props.onClick())
    assert.deepEqual(f.calls.at(-1), ['continue', 'b'])
    h.act(() => h.button('Show checkpoint').props.onClick())
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1))), ['select', checkpoint('b').owner])
  } finally { h.unmount() }
})

test('mounted landmark row uses exact owner for clear, selection and re-mark and per-node Continue', () => {
  const f = fixture('src/areas/generate/components/WorkflowPanel.tsx')
  const cp = { ...checkpoint('b', 8), landmarkCapture: { nodeId: 'b', activeLandmarkId: 'hip', completed: points(), validity: { valid: true, missing: [] }, canContinue: true, sidecarStatus: 'not_started' } }
  f.store.setState({ activeCheckpointNodeId: 'a', checkpoints: { a: checkpoint('a'), b: cp } })
  const h = mount(f.module.LandmarksParamRow, { nodeId: 'b' })
  try {
    h.act(() => h.button('Continue workflow').props.onClick())
    assert.deepEqual(f.calls.at(-1), ['continue', 'b'])
    h.act(() => h.button('Clear landmarks').props.onClick())
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1))), ['clear', cp.owner])
    h.act(() => h.button('Re-mark H Hip').props.onClick())
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls.slice(-2))), [['select', cp.owner], ['mark', cp.owner, 'hip']])
    h.act(() => f.store.setState({ runningBranchId: 'a' }))
    assert.equal(h.button('Continue workflow').props.disabled, true)
    assert.equal(h.button('Clear landmarks').props.disabled, true)
    assert.equal(h.button('Re-mark H Hip').props.disabled, true)
  } finally { h.unmount() }
})

function workflow(nodes: any[], updatedAt = '2026-01-01T00:00:00.000Z') {
  return { id: 'wf', name: 'Fixture', createdAt: updatedAt, updatedAt, nodes, edges: [] }
}
function pinWorkflow(f: ReturnType<typeof fixture>, nodes: any[]) {
  f.workflows.activeId = 'wf'
  f.workflows.workflows = [workflow(nodes)]
}

test('mounted unpinned landmark footer keeps Continue/Clear node-scoped and Stop available during a write', () => {
  const f = fixture('src/areas/generate/components/WorkflowPanel.tsx')
  pinWorkflow(f, [{ id: 'b', type: 'landmarksNode', data: { params: {} } }])
  const cp = { ...checkpoint('b', 9), landmarkCapture: { nodeId: 'b', activeLandmarkId: 'hip', completed: points(), validity: { valid: true, missing: [] }, canContinue: true, sidecarStatus: 'not_started' } }
  f.store.setState({ activeCheckpointNodeId: 'b', checkpoints: { b: cp } })
  const h = mount(f.module.default, {})
  try {
    assert.ok(h.button('Continue workflow'))
    h.act(() => h.button('Continue workflow').props.onClick())
    assert.deepEqual(f.calls.at(-1), ['continue', 'b'])
    h.act(() => h.button('Clear landmarks').props.onClick())
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1))), ['clear', cp.owner])
    h.act(() => f.store.setState({ runningBranchId: 'b', checkpoints: { b: { ...cp, landmarkCapture: { ...cp.landmarkCapture, sidecarStatus: 'pending-write' } } } }))
    assert.equal(h.button('Continue workflow').props.disabled, true)
    assert.equal(h.button('Clear landmarks').props.disabled, true)
    h.act(() => h.button('Stop').props.onClick())
    assert.deepEqual(f.calls.at(-1), ['cancel'])
  } finally { h.unmount() }
})

function landmarkRuntime(writeSidecar: (input: any) => Promise<any>) {
  const app: any = { apiUrl: 'http://inert.invalid', currentJob: null,
    setCurrentJob(value: any) { this.currentJob = value },
    updateCurrentJob(value: any) { this.currentJob = { ...this.currentJob, ...value } },
  }
  const processCalls: any[] = []
  const window = { electron: {
    settings: { get: async () => ({ workspaceDir: '/workspace' }) },
    workspace: { artifacts: { writeLandmarkSidecar: writeSidecar } },
    fs: { deleteDirectory: async () => ({ success: true }), readFileBase64: async () => { throw new Error('Unexpected file read') } },
    extensions: { runProcess: async (...args: any[]) => {
      processCalls.push(args)
      return { success: true, result: { filePath: '/workspace/output.glb' } }
    } },
  } }
  const bundle = buildSync({
    entryPoints: [path.join(root, 'src/areas/workflows/workflowRunStore.ts')], tsconfig: path.join(root, 'tsconfig.web.json'),
    bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['react', 'react/*', 'zustand', 'zustand/*', 'axios', '@shared/stores/appStore', '@shared/utils/notification'],
  }).outputFiles[0].text
  const module: any = { exports: {} }
  vm.runInNewContext(bundle, { module, exports: module.exports, window, console, Promise, crypto, Blob, FormData, atob, TextDecoder, setTimeout, clearTimeout,
    require: (id: string) => id === 'axios' ? { create: () => ({
      post: () => { throw new Error('Unexpected HTTP request') }, get: () => { throw new Error('Unexpected HTTP request') },
    }) }
      : id.endsWith('/appStore') ? { useAppStore: { getState: () => app } }
      : id.endsWith('/notification') ? { showCompletionNotification: () => {}, showErrorNotification: () => {} }
      : require(id),
  })
  return { store: module.exports.useWorkflowRunStore as typeof import('./workflowRunStore').useWorkflowRunStore, processCalls }
}

for (const pinned of [false, true]) {
  for (const recovery of ['retry', 'clear', 'stop']) {
    test(`mounted ${pinned ? 'pinned' : 'unpinned'} landmark footer announces a real rejected write and recovers via ${recovery}`, async () => {
      let attempts = 0, resolveWrite!: (value: any) => void
      const pendingWrite = new Promise(resolve => { resolveWrite = resolve })
      const writes: any[] = []
      const r = landmarkRuntime(async input => {
        writes.push(input)
        if (++attempts === 1) throw new Error('EACCES: checkpoint sidecar is read-only')
        await pendingWrite
        return { success: true, sidecarWorkspacePath: input.sidecarWorkspacePath, sidecar: input.sidecar }
      })
      const wf: Workflow = {
        ...workflow([]),
        description: '',
        nodes: [
          { id: 'src', type: 'meshNode', position: { x: 0, y: 0 }, data: { enabled: true, params: { source: 'file', filePath: '/workspace/source.glb' } } },
          { id: 'a', type: 'landmarksNode', position: { x: 0, y: 0 }, data: { enabled: true, params: {}, showInGenerate: pinned } },
          { id: 'sink', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'process/run', enabled: true, params: {} } },
        ],
        edges: [{ id: 'sa', source: 'src', target: 'a' }, { id: 'as', source: 'a', target: 'sink' }],
      }
      const ext = { id: 'process/run', extensionId: 'process', nodeId: 'run', extensionName: 'Process', extensionAuthor: 'Tests', description: '', name: 'Inert process', input: 'mesh' as const, output: 'mesh' as const, type: 'process' as const, params: [], builtin: false }
      await r.store.getState().run(wf, [ext])
      for (const point of Object.values(points())) assert.equal(r.store.getState().markLandmark(r.store.getState().getCheckpointOwner('a')!, point as Parameters<ReturnType<typeof r.store.getState>['markLandmark']>[1]), true)
      const f = fixture('src/areas/generate/components/WorkflowPanel.tsx', r.store)
      f.workflows.activeId = wf.id; f.workflows.workflows = [wf]
      const h = mount(f.module.default, {})
      const footer = () => h.all().find(n => n.props?.className?.includes('shrink-0 px-4 pt-3 pb-4'))
      const button = (label: string) => h.button(label, footer())
      const flush = async () => { await new Promise(resolve => setImmediate(resolve)); h.act(() => {}) }
      try {
        h.act(() => button('Continue workflow').props.onClick()); await flush()
        const capture = r.store.getState().checkpoints.a.landmarkCapture!
        assert.equal(capture.sidecarStatus, 'error')
        assert.match(capture.error!, /EACCES/)
        assert.equal(r.store.getState().runState.status, 'paused')
        assert.equal(r.store.getState().runState.error, undefined)
        assert.equal(r.processCalls.length, 0)
        assert.equal(button('Continue workflow').props.disabled, false)
        assert.equal(button('Clear landmarks').props.disabled, false)
        assert.ok(button('Stop'))
        const alert = h.all(footer()).find(n => n.props?.role === 'alert')
        assert.ok(alert, 'the footer must announce its recoverable capture error')
        assert.match(h.text(alert), /EACCES: checkpoint sidecar is read-only/)
        if (pinned) assert.ok(h.all().filter(n => n.props?.role === 'alert').length >= 2, 'the pinned row retains its own error feedback')
        if (recovery === 'clear') {
          h.act(() => button('Clear landmarks').props.onClick())
          assert.doesNotMatch(h.text(), /EACCES/)
          assert.equal(button('Finish all landmarks to continue').props.disabled, true)
          assert.equal(r.store.getState().checkpoints.a.landmarkCapture?.error, undefined)
        } else {
          h.act(() => button('Continue workflow').props.onClick())
          assert.equal(attempts, 2)
          assert.doesNotMatch(h.text(), /EACCES/)
          assert.equal(button('Continue workflow').props.disabled, true)
          assert.equal(button('Clear landmarks').props.disabled, true)
          assert.ok(button('Stop'))
          if (recovery === 'stop') h.act(() => button('Stop').props.onClick())
          resolveWrite(undefined); await flush()
          assert.equal(r.store.getState().runState.status, recovery === 'stop' ? 'idle' : 'done')
          assert.equal(r.processCalls.length, recovery === 'stop' ? 0 : 1)
          assert.doesNotMatch(h.text(), /EACCES/)
          assert.equal(writes.length, 2)
        }
      } finally { resolveWrite(undefined); h.unmount(); r.store.getState().reset(); await flush() }
    })
  }
}

test('mounted footer never borrows a landmark error from an unrelated checkpoint', () => {
  const f = fixture('src/areas/generate/components/WorkflowPanel.tsx')
  pinWorkflow(f, [{ id: 'a', type: 'landmarksNode', data: { params: {} } }, { id: 'b', type: 'waitNode', data: { params: {} } }])
  const cp = { ...checkpoint('a'), landmarkCapture: { nodeId: 'a', activeLandmarkId: 'hip', completed: points(), validity: { valid: true, missing: [] }, canContinue: true, sidecarStatus: 'error', error: 'Only checkpoint A failed' } }
  f.store.setState({ activeCheckpointNodeId: 'b', checkpoints: { a: cp, b: checkpoint('b') } })
  const h = mount(f.module.default, {})
  try {
    assert.doesNotMatch(h.text(), /Only checkpoint A failed/)
    h.act(() => f.store.setState({ activeCheckpointNodeId: 'a' }))
    assert.match(h.text(), /Only checkpoint A failed/)
    h.act(() => f.store.setState({ activeCheckpointNodeId: 'b' }))
    assert.doesNotMatch(h.text(), /Only checkpoint A failed/)
  } finally { h.unmount() }
})

for (const surface of ['node', 'panel']) {
  test(`mounted ${surface} advanced controls preserve show_if, defaults, dir_from and variant installs`, async () => {
    const f = fixture(surface === 'node' ? 'src/areas/workflows/nodes/ExtensionNode.tsx' : 'src/areas/generate/components/WorkflowPanel.tsx')
    const node = { id: 'node', type: 'extensionNode', data: { extensionId: 'pack/run', enabled: true, showInGenerate: true, params: { unknown: 'preserve' } } }
    f.extensions.modelExtensions = [{ id: 'pack', name: 'Pack', type: 'model', nodes: [{
      id: 'run', name: 'Run', input: 'image', output: 'mesh',
      paramsSchema: [
        { id: 'folder', label: 'Folder', type: 'string', default: '/presets' },
        { id: 'enabled', label: 'Enabled', type: 'boolean', default: false },
        { id: 'preset', label: 'Preset', type: 'file-select', default: 'saved.json', dir_from: 'folder', extensions: ['json'], advanced: true, show_if: { enabled: false } },
        { id: 'hidden', label: 'Hidden', type: 'int', default: 2, advanced: true, show_if: { enabled: true } },
        { id: 'quant', label: 'Quant', type: 'select', default: 'large', options: [{ value: 'small', label: 'Small' }, { value: 'large', label: 'Large' }], advanced: true },
      ], weightVariants: { param: 'quant', default: 'large', options: [{ id: 'small', label: 'Small' }, { id: 'large', label: 'Large' }] },
    }] }]
    f.extensions.installedWeightVariants = { 'pack/run': ['small'] }
    pinWorkflow(f, [node])
    const h = mount(f.module.default, surface === 'node' ? { id: 'node', data: node.data } : {})
    try {
      assert.doesNotMatch(h.text(), /Saved value|Not installed — install it/)
      const disclosure = () => h.all().find(n => n.type === 'button' && n.props['aria-controls'])
      assert.equal(disclosure().props['aria-expanded'], false)
      h.act(() => disclosure().props.onClick())
      await new Promise(resolve => setImmediate(resolve))
      h.act(() => {})
      assert.equal(disclosure().props['aria-expanded'], true)
      assert.ok(f.calls.some(call => call[0] === 'files' && call[1] === '/presets'), 'advanced file-select resolves dir_from defaults')
      assert.doesNotMatch(h.text(), /Hidden/)
      assert.match(h.text(), /Large \(not installed\)/)
      h.act(() => h.button('Not installed — install it').props.onClick())
      assert.deepEqual(f.calls.at(-1), ['open', 'pack'])
      const select = h.all().find(n => n.type === 'select' && n.props.value === 'large')
      h.act(() => select.props.onChange({ target: { value: 'small' } }))
      const live = f.calls.filter(call => call[0] === 'live').at(-1)
      assert.equal(live[1], 'node'); assert.equal(live[2].quant, 'small'); assert.equal(live[2].unknown, 'preserve')
    } finally { h.unmount() }
  })
}


test('mounted panel retains external tab sync and debounced saveAndClaim with live local edits', async () => {
  const f = fixture('src/areas/generate/components/WorkflowPanel.tsx')
  const node = { id: 'text', type: 'textNode', data: { showInGenerate: true, params: { text: 'original', unknown: 'keep' } } }
  pinWorkflow(f, [node])
  const h = mount(f.module.default, {})
  const editor = () => h.all().find(n => n.type === 'textarea')
  try {
    assert.equal(editor().props.value, 'original')
    h.act(() => editor().props.onChange({ target: { value: 'local edit' } }))
    assert.equal(editor().props.value, 'local edit')
    assert.ok(f.calls.some(call => call[0] === 'live' && call[1] === 'text' && call[2].text === 'local edit'))
    await new Promise(resolve => setTimeout(resolve, 550))
    const saved = f.calls.filter(call => call[0] === 'save').at(-1)[1]
    assert.equal(saved.nodes[0].data.params.text, 'local edit')
    assert.equal(saved.nodes[0].data.params.unknown, 'keep')
    f.workflows.workflows = [saved]
    h.update({})
    assert.equal(editor().props.value, 'local edit', 'own-save echo keeps the local value')
    f.workflows.workflows = [workflow([{ ...node, data: { ...node.data, params: { text: 'external edit' } } }], '2026-10-07T01:00:00.000Z')]
    h.update({})
    assert.equal(editor().props.value, 'external edit', 'Workflows-to-Generate saves resynchronize the canvas')
  } finally { h.unmount() }
})

for (const [type, params, pattern] of [
  ['meshNode', { source: 'current' }, /no mesh is loaded/i],
  ['sceneNode', {}, /validated scene directory/i],
  ['extensionNode', {}, /incoming mesh connection|required.*mesh/i],
] as const) {
  test(`mounted panel preserves actual ${type} preflight and the guarded Generate callback`, () => {
    const f = fixture('src/areas/generate/components/WorkflowPanel.tsx')
    f.extensions.processExtensions = [{ id: 'pack', name: 'Pack', type: 'process', nodes: [{ id: 'run', name: 'Process', input: 'mesh', output: 'mesh', paramsSchema: [] }] }]
    pinWorkflow(f, [{ id: 'node', type, data: { extensionId: 'pack/run', params } }])
    f.store.setState({ runState: { ...f.state.runState, status: 'idle' }, checkpoints: {}, activeCheckpointNodeId: null })
    const h = mount(f.module.default, {})
    try {
      assert.match(h.text(), pattern)
      assert.equal(h.button('Generate 3D Model').props.disabled, true)
      h.act(() => h.button('Generate 3D Model').props.onClick())
      assert.equal(f.calls.length, 0, 'the disabled footer callback must not dispatch')
      assert.equal(f.calls.some(call => call[0] === 'run'), false)
    } finally { h.unmount() }
  })
}


test('mounted GenerationOptions partitions only its existing supported controls, without advertising unsupported fields', async () => {
  const f = fixture('src/areas/generate/components/GenerationOptions.tsx')
  f.backend.schema = [{ id: 'string', type: 'string', label: 'Unsupported string', default: '', advanced: true }]
  const h = mount(f.module.default, {})
  try {
    await new Promise(resolve => setImmediate(resolve)); h.act(() => {})
    assert.doesNotMatch(h.text(), /Advanced Options|Unsupported string/)
  } finally { h.unmount() }
  const supported = fixture('src/areas/generate/components/GenerationOptions.tsx')
  supported.backend.schema = [
    { id: 'steps', type: 'int', label: 'Steps', default: 4 },
    { id: 'seed', type: 'int', label: 'Seed', default: 123, advanced: true },
  ]
  const mounted = mount(supported.module.default, {})
  try {
    await new Promise(resolve => setImmediate(resolve)); mounted.act(() => {})
    assert.match(mounted.text(), /Steps/); assert.doesNotMatch(mounted.text(), /Seed/)
    const disclosure = mounted.all().find(n => n.type === 'button' && n.props['aria-controls'])
    mounted.act(() => disclosure.props.onClick())
    assert.match(mounted.text(), /Seed/)
    assert.ok(mounted.all().some(n => n.type === 'input' && n.props.value === '123'))
  } finally { mounted.unmount() }
})

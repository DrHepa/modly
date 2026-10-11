import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Reconciler from 'react-reconciler'

// Actual component functions and React SSR. This does not mount a browser DOM.
const module = { exports: {} }
const window = { electron: { fs: {} } }
vm.runInNewContext(buildSync({
  entryPoints: ['src/areas/workflows/components/WorkflowParamControl.tsx'],
  tsconfig: 'tsconfig.web.json', bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['react', 'react/*'],
}).outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url), window })
const Control = module.exports.default
const string = (extra = {}) => ({ id: 'path', label: 'Path', type: 'string', default: '', ...extra })
function elements(tree) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(elements)
  return [tree, ...elements(tree.props?.children)]
}
function control(param, value = param.default, onChange = () => {}, resolvedParams = {}) {
  const tree = Control({ param, value, onChange, resolvedParams })
  return param.type === 'string' && typeof tree.type === 'function' ? hooks(tree.type).render(tree.props) : tree
}

// Small deterministic hook adapter for invoking the real file-list/numeric
// functions and their effects. No React scheduler or DOM event dispatch claim.
function hooks(Component) {
  let slots = [], cursor = 0, pending = []
  const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const render = (props) => {
    cursor = 0
    const previous = internals.ReactCurrentDispatcher.current
    internals.ReactCurrentDispatcher.current = {
      useState(value) {
        const i = cursor++
        if (!(i in slots)) slots[i] = typeof value === 'function' ? value() : value
        return [slots[i], (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next }]
      },
      useRef(value) { const i = cursor++; return slots[i] ??= { current: value } },
      useEffect(effect, deps) {
        const i = cursor++
        if (!slots[i] || deps.some((value, n) => !Object.is(value, slots[i].deps[n]))) {
          slots[i]?.cleanup?.()
          slots[i] = { deps }
          pending.push(() => { slots[i].cleanup = effect() })
        }
      },
    }
    try { return Component(props) } finally { internals.ReactCurrentDispatcher.current = previous }
  }
  return { render, flush: () => { const effects = pending; pending = []; effects.forEach((effect) => effect()) }, unmount: () => slots.forEach((slot) => slot?.cleanup?.()) }
}

test('real string control keeps manual editing, legacy browsing, explicit aliases and cancellation', async () => {
  const changes = []
  const calls = []
  window.electron.fs = Object.fromEntries(['selectDirectory', 'selectImage', 'selectMeshFile', 'selectTextFile', 'savePath'].map((name) => [name, async (args) => { calls.push([name, args]); return `/${name}` }]))
  for (const [extra, expected] of [[{}, 'selectDirectory'], [{ picker_intent: 'text' }, 'selectTextFile'], [{ pickerIntent: 'mesh' }, 'selectMeshFile'], [{ pickerIntent: 'image' }, 'selectImage'], [{ pickerIntent: 'directory' }, 'selectDirectory'], [{ pickerIntent: 'save-path', filters: [{ name: 'Mesh', extensions: ['glb'] }] }, 'savePath']]) {
    const tree = control(string(extra), '/current', (value) => changes.push(value))
    const input = elements(tree).find((node) => node.type === 'input')
    input.props.onChange({ target: { value: 'plain text' } })
    assert.equal(changes.at(-1), 'plain text')
    assert.equal(input.props['aria-label'], 'Path')
    await elements(tree).find((node) => node.type === 'button').props.onClick()
    assert.equal(calls.at(-1)[0], expected)
    assert.equal(changes.at(-1), `/${expected}`)
  }
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1)[1])), { filters: [{ name: 'Mesh', extensions: ['glb'] }], defaultPath: '/current' })
  window.electron.fs.selectDirectory = async () => null
  const count = changes.length
  await elements(control(string(), '', (value) => changes.push(value))).find((node) => node.type === 'button').props.onClick()
  assert.equal(changes.length, count)
})

test('generic-file remains manual-only without a misleading or misrouted browse button', () => {
  let value
  const tree = control(string({ pickerIntent: 'generic-file' }), '', (next) => { value = next })
  assert.equal(elements(tree).filter((node) => node.type === 'button' && node.props['aria-expanded'] === undefined).length, 0)
  const input = elements(tree).find((node) => node.type === 'input')
  input.props.onChange({ target: { value: '/arbitrary.bin' } })
  assert.equal(value, '/arbitrary.bin')
  assert.match(input.props.title, /unavailable/)
})

test('boolean control emits real booleans and exposes its accessible checked state', () => {
  let value = true
  const param = { id: 'enabled', label: 'Enabled', type: 'boolean', default: true }
  let tree = control(param, value, (next) => { value = next })
  assert.equal(tree.props.role, 'switch')
  assert.equal(tree.props['aria-checked'], true)
  tree.props.onClick()
  assert.equal(value, false)
  tree = control(param, value, (next) => { value = next })
  assert.equal(tree.props['aria-checked'], false)
  tree.props.onClick()
  assert.equal(value, true)
})

test('real shared FloatInput retains min/max/step, comma typing, clamp and controlled reset', () => {
  const param = { id: 'strength', label: 'Strength', type: 'float', default: 0.5, min: 0, max: 1, step: 0.05 }
  let value = param.default
  const child = elements(control(param, value, (next) => { value = next })).find((node) => typeof node.type === 'function')
  const h = hooks(child.type)
  let tree = h.render(child.props)
  const inputs = elements(tree).filter((node) => node.type === 'input')
  const slider = inputs.find((node) => node.props.type === 'range')
  const text = inputs.find((node) => node.props.type === 'text')
  assert.equal(slider.props.min, 0); assert.equal(slider.props.max, 1); assert.equal(slider.props.step, 0.05)
  text.props.onChange({ target: { value: '1,5' } }); assert.equal(value, 1)
  tree = h.render({ ...child.props, value })
  elements(tree).find((node) => node.props?.type === 'text').props.onBlur()
  tree = h.render({ ...child.props, value })
  assert.equal(elements(tree).find((node) => node.props?.type === 'text').props.value, '1')
  slider.props.onChange({ currentTarget: { valueAsNumber: 0.25 } }); assert.equal(value, 0.25)
  tree = h.render({ ...child.props, value: 0.75 })
  tree = h.render({ ...child.props, value: 0.75 })
  assert.equal(elements(tree).find((node) => node.props?.type === 'text').props.value, '0.75')
})

test('SSR names every numeric text field as well as the float slider', () => {
  for (const param of [{ id: 'n', label: 'Count', type: 'int', default: 4 }, { id: 'f', label: 'Strength', type: 'float', default: 0.5, min: 0, max: 1, step: 0.05 }]) {
    const markup = renderToStaticMarkup(React.createElement(Control, { param, value: param.default, onChange: () => {} }))
    assert.match(markup, new RegExp(`type="text"[^>]*aria-label="${param.label}"|aria-label="${param.label}"[^>]*type="text"`))
    if (param.type === 'float') assert.match(markup, /type="range"[^>]*step="0.05"/)
  }
})

test('actual file-select effect lists filtered dir_from files, ignores stale loads and retains missing saved values', async () => {
  const pending = []
  window.electron.fs.listFiles = (dir, extensions) => new Promise((resolve, reject) => pending.push({ dir, extensions, resolve, reject }))
  const param = { id: 'preset', label: 'Preset', type: 'file-select', default: '', dir_from: 'folder', extensions: ['json'] }
  let selected
  const child = control(param, 'saved.json', (value) => { selected = value }, { folder: '/one' })
  assert.equal(child.props.dirValue, '/one')
  const h = hooks(child.type)
  let tree = h.render(child.props); h.flush()
  assert.equal(pending[0].dir, '/one'); assert.equal(JSON.stringify(pending[0].extensions), '["json"]')
  tree = h.render({ ...child.props, dirValue: '/two' }); h.flush()
  pending[0].resolve(['old.json']); pending[1].resolve(['new.json']); await Promise.resolve()
  tree = h.render({ ...child.props, dirValue: '/two' })
  const options = elements(tree).filter((node) => node.type === 'option').map((node) => node.props.value)
  assert.ok(options.includes('new.json')); assert.ok(options.includes('saved.json')); assert.ok(!options.includes('old.json'))
  tree.props.onChange({ target: { value: 'new.json' } }); assert.equal(selected, 'new.json')
  tree = h.render({ ...child.props, dirValue: '' }); h.flush()
  assert.equal(tree.props.disabled, true)
  tree = h.render({ ...child.props, dirValue: '/bad' }); h.flush()
  pending.at(-1).reject(new Error('missing')); await Promise.resolve(); await Promise.resolve()
  tree = h.render({ ...child.props, dirValue: '/bad' })
  assert.ok(!elements(tree).some((node) => node.type === 'option' && node.props.value === 'new.json'))
  h.unmount()
})

import ts from 'typescript'
import { transformSync } from 'esbuild'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const require = createRequire(import.meta.url)
function loadPure(file) {
  const mod = { exports: {} }
  vm.runInNewContext(buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false, define: { 'import.meta.url': JSON.stringify(pathToFileURL(resolve(file)).href) }, logOverride: { 'empty-import-meta': 'error' } }).outputFiles[0].text, { module: mod, exports: mod.exports, require })
  return mod.exports
}
const state = loadPure('src/areas/workflows/components/workflowParamControlState.ts')
const variants = loadPure('src/shared/utils/weightVariants.ts')
const discovery = loadPure('src/areas/workflows/mockExtensions.ts')
const ports = loadPure('src/areas/workflows/processPorts.ts')

// Extract whole actual component bodies and the actual Generate patch callback.
// Adapters stand in for React state/Flow/stores, not business logic or JSX.
function actualOwner(file, functionName, constants, env, callback = false) {
  const src = readFileSync(file, 'utf8')
  const ast = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let body
  const declarations = []
  function visit(node) {
    if (callback && ts.isFunctionDeclaration(node) && node.name?.text === 'isRecord') declarations.push(node.getText(ast))
    if (!callback && ts.isFunctionDeclaration(node) && node.name?.text === functionName) body = node.getText(ast).replace(/^export default /, '')
    if (ts.isVariableDeclaration(node)) {
      if (constants.includes(node.name.getText(ast))) declarations.push(`const ${node.getText(ast)};`)
      if (callback && node.name.getText(ast) === functionName) body = `const ${functionName} = ${node.initializer.arguments[0].getText(ast)};`
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(body, `${functionName} not found`)
  if (callback && functionName === 'patchNode') assert.ok(declarations.some((source) => source.startsWith('function isRecord')), 'actual patchNode isRecord companion missing')
  const code = transformSync(`${declarations.join('\n')}\n${body}\n globalThis.result = ${functionName}`, { loader: 'tsx', jsx: 'automatic', format: 'cjs' }).code
  const additions = { exports: {} }
  vm.runInNewContext(buildSync({
    stdin: { contents: "export { partitionAdvancedParams } from './src/areas/workflows/workflowParamSchema'; export { default as AdvancedOptionsSection } from './src/areas/workflows/components/AdvancedOptionsSection'", resolveDir: process.cwd() },
    tsconfig: 'tsconfig.web.json', bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['react', 'react/*'],
  }).outputFiles[0].text, { module: additions, exports: additions.exports, require })
  const context = { ...additions.exports, ...env, require }
  vm.runInNewContext(code, context)
  return context.result
}

test('actual Generate and ExtensionNode components preserve visibility, variants, live edits and both handle dialects', () => {
  const manifestNode = { id: 'run', name: 'Run', input: 'image', inputs: ['image', 'mesh', 'text'], inputLabels: ['Front', 'Shape', 'Prompt'], output: 'mesh', paramsSchema: [
    { id: 'enabled', label: 'Enabled', type: 'boolean', default: true },
    { id: 'hidden', label: 'Hidden', type: 'string', default: '', show_if: { enabled: false } },
    { id: 'folder', label: 'Folder', type: 'string', default: '/defaults' },
    { id: 'preset', label: 'Preset', type: 'file-select', default: 'saved.json', dir_from: 'folder', extensions: ['json'] },
    { id: 'numericInt', label: 'Count', type: 'int', default: 3 },
    { id: 'numericFloat', label: 'Strength', type: 'float', default: 0.5 },
    { id: 'quant', label: 'Quant', type: 'select', default: 'large', options: [{ value: 'small', label: 'Small' }, { value: 'large', label: 'Large' }] },
  ], weightVariants: { param: 'quant', default: 'large', options: [{ id: 'small', label: 'Small' }, { id: 'large', label: 'Large' }] } }
  const model = { id: 'pack', name: 'Pack', type: 'model', nodes: [manifestNode] }
  let nodes = [{ id: 'node', data: { extensionId: 'pack/run', enabled: true, params: { enabled: true, unknown: { keep: true }, numericInt: '7', numericFloat: '0.75' } } }]
  const live = [], opened = []
  const store = { modelExtensions: [model], processExtensions: [], installedWeightVariants: { 'pack/run': ['small'] } }
  const runStore = (selector) => selector({ activeNodeId: null })
  runStore.getState = () => ({ setLiveNodeParams: (id, params) => live.push([id, params]) })
  const env = {
    ...state, ...variants, ...discovery, ...ports, WorkflowParamControl: Control,
    useState: (value) => [value, () => {}], useRef: (value) => ({ current: value }), useLayoutEffect: () => {}, useCallback: (fn) => fn,
    useExtensionsStore: (selector) => selector ? selector(store) : store,
    useNavStore: (selector) => selector({ openExtension: (id) => opened.push(id) }), useWorkflowRunStore: runStore,
    useReactFlow: () => ({ updateNodeData: (id, patch) => { nodes = nodes.map((node) => node.id === id ? { ...node, data: { ...node.data, ...patch } } : node) } }),
    BaseNode: 'base-node', Handle: 'handle', Position: { Left: 'left', Right: 'right' },
    setNodes: (updater) => { nodes = updater(nodes) },
  }
  const Generate = actualOwner('src/areas/generate/components/WorkflowPanel.tsx', 'ExtensionParamRow', ['TYPE_COLOR'], env)
  const patchNode = actualOwner('src/areas/generate/components/WorkflowPanel.tsx', 'patchNode', [], env, true)
  const Node = actualOwner('src/areas/workflows/nodes/ExtensionNode.tsx', 'ExtensionNode', ['HANDLE_COLOR', 'TAG_CLS'], env)
  for (const surface of ['generate', 'node']) {
    nodes[0].data.params.enabled = true
    const render = () => surface === 'generate'
      ? Generate({ nodeId: 'node', ext: discovery.buildAllWorkflowExtensions([model], [])[0], nodes, onPatch: patchNode })
      : Node({ id: 'node', data: nodes[0].data })
    let tree = render()
    let controls = elements(tree).filter((node) => node.type === Control)
    assert.equal(controls.length, 6)
    for (const control of controls) {
      const row = elements(tree).find((node) => node.key === JSON.stringify(['node', 'pack/run', control.props.param.id]))
      assert.ok(row, `${surface}: model and field identity must reset local editor state`)
      assert.match(row.props.className, /items-start.*min-w-0/)
    }
    for (const [id, stored] of [['numericInt', '7'], ['numericFloat', '0.75']]) {
      const props = controls.find((node) => node.props.param.id === id).props
      assert.equal(props.value, stored)
      assert.match(renderToStaticMarkup(React.createElement(Control, props)), new RegExp(`value="${stored}"`))
      assert.equal(nodes[0].data.params[id], stored)
    }
    assert.equal(controls.find((node) => node.props.param.id === 'preset').props.resolvedParams.folder, '/defaults')
    assert.equal(controls.find((node) => node.props.param.id === 'quant').props.param.options[1].label, 'Large (not installed)')
    elements(tree).find((node) => node.type === 'button' && node.props.children === 'Not installed — install it').props.onClick()
    assert.equal(opened.at(-1), 'pack')
    controls.find((node) => node.props.param.id === 'enabled').props.onChange(false)
    assert.equal(nodes[0].data.params.enabled, false)
    assert.equal(nodes[0].data.params.unknown.keep, true)
    assert.equal(live.at(-1)[0], 'node'); assert.equal(live.at(-1)[1].enabled, false)
    assert.equal(live.at(-1)[1].numericInt, '7'); assert.equal(live.at(-1)[1].numericFloat, '0.75')
    tree = render(); controls = elements(tree).filter((node) => node.type === Control)
    assert.ok(controls.some((node) => node.props.param.id === 'hidden'))
    assert.equal(controls.find((node) => node.props.param.id === 'enabled').props.value, false)
    // Mount each owner's actual returned tree: stores/Flow remain adapters,
    // while the shared controls and their keyed React state are real.
    const mounted = mountControl({}, () => render())
    try {
      const folderToggle = () => mounted.find((node) => node.type === 'button' && /^(Expand|Collapse) Folder$/.test(node.props['aria-label']))
      mounted.act(() => folderToggle().props.onClick())
      assert.equal(folderToggle().props['aria-expanded'], true)
      mounted.update({})
      assert.equal(folderToggle().props['aria-expanded'], true, 'ordinary owner rerenders retain expansion')
      model.id = 'other-pack'; nodes[0].data.extensionId = 'other-pack/run'
      mounted.update({})
      assert.equal(folderToggle().props['aria-expanded'], false, `${surface}: a new model resets expansion`)
    } finally {
      mounted.unmount()
      model.id = 'pack'; nodes[0].data.extensionId = 'pack/run'
    }
  }
  let tree = Node({ id: 'node', data: nodes[0].data })
  assert.deepEqual(elements(tree.props.handles).filter((node) => node.type === 'handle' && node.props.type === 'target').map((node) => node.props.id), ['input-0', 'input-1', 'input-2'])
  manifestNode.inputs = [{ name: 'front', type: 'image' }, { name: 'coarse', type: 'mesh', required: false }]
  tree = Node({ id: 'node', data: nodes[0].data })
  assert.deepEqual(elements(tree.props.handles).filter((node) => node.type === 'handle' && node.props.type === 'target').map((node) => node.props.id), ['front', 'coarse'])
})

test('mounted ExtensionNode shows named labels and fallbacks without changing handle identities', () => {
  for (const type of ['model', 'process']) {
    const manifestNode = { id: 'run', name: 'Run', input: 'image', output: 'mesh', paramsSchema: [] }
    const extension = { id: 'pack', name: 'Pack', type, nodes: [manifestNode] }
    const store = { modelExtensions: type === 'model' ? [extension] : [], processExtensions: type === 'process' ? [extension] : [], installedWeightVariants: {} }
    const Node = actualOwner('src/areas/workflows/nodes/ExtensionNode.tsx', 'ExtensionNode', ['HANDLE_COLOR', 'TAG_CLS'], {
      ...state, ...variants, ...discovery, ...ports, WorkflowParamControl: Control,
      useState: React.useState, useRef: React.useRef, useLayoutEffect: React.useLayoutEffect, useCallback: React.useCallback,
      useExtensionsStore: (selector) => selector ? selector(store) : store,
      useNavStore: (selector) => selector({ openExtension: () => {} }),
      useWorkflowRunStore: (selector) => selector({ activeNodeId: null }),
      useReactFlow: () => ({ updateNodeData: () => assert.fail('display must not update workflow data') }),
      BaseNode: ({ subheader, handles, children }) => React.createElement('div', null, subheader, handles, children),
      Handle: 'handle', Position: { Left: 'left', Right: 'right' },
    })
    const props = { id: 'node', data: { extensionId: 'pack/run', enabled: true, params: { unknown: 'keep' } } }
    const cases = [
      { inputs: [{ name: 'front', label: 'Primary image', type: 'image' }, { name: 'left', label: 'Image 2', type: 'image', required: false }], labels: ['Primary image (image)', 'Image 2 (image)'], handles: ['front', 'left'] },
      { inputs: [{ name: 'front', label: '  Only image  ', type: 'image' }], labels: ['Only image (image)'], handles: ['front'] },
      { inputs: [{ name: 'track', label: '', type: 'audio' }, { name: 'scene', label: ' \t ', type: 'scene' }, { name: '', label: '', type: 'capture' }], labels: ['track (audio)', 'scene (scene)', 'capture'], handles: ['track', 'scene', ''] },
      { inputs: [{ name: 'front', label: 0, type: 'image' }, { name: 'side', label: false, type: 'image', required: false }], labels: ['front (image)', 'side (image)'], handles: ['front', 'side'] },
      { inputs: [{ name: 'front', label: null, type: 'image' }, { name: 'side', label: {}, type: 'image' }], labels: ['front (image)', 'side (image)'], handles: ['front', 'side'] },
      { inputs: [{ name: 'front', label: 'Named label', type: 'image' }], inputLabels: ['Explicit slot label'], labels: ['Explicit slot label'], handles: ['front'] },
      { inputs: ['image', 'audio', 'scene', 'capture'], inputLabels: ['Front', '', '   '], labels: ['Front', '', '   ', 'capture'], handles: ['input-0', 'input-1', 'input-2', 'input-3'] },
    ]
    for (const fixture of cases) {
      manifestNode.inputs = fixture.inputs
      manifestNode.inputLabels = fixture.inputLabels
      const original = JSON.stringify(extension)
      const h = mountControl(props, Node)
      try {
        assert.deepEqual(h.all().filter((node) => node.type === 'span' && node.props.className?.includes('inline-flex')).map((node) => node.props.children), [fixture.labels[0], 'mesh', ...fixture.labels.slice(1)], type)
        const handleIds = () => h.all().filter((node) => node.type === 'handle' && node.props.type === 'target').map((node) => node.props.id)
        assert.deepEqual(handleIds(), fixture.handles)
        if (fixture.inputs.some((port) => typeof port === 'object' && port.required === false)) assert.ok(h.all().some((node) => node.type === 'span' && node.props.children === 'optional'))
        h.update(props)
        assert.deepEqual(handleIds(), fixture.handles)
        assert.equal(JSON.stringify(extension), original)
        assert.equal(props.data.params.unknown, 'keep')
      } finally { h.unmount() }
    }
  }
})

for (const type of ['model', 'process']) {
  test(`mounted ${type} manifest boundary safely displays raw names without rewriting handle identity`, async () => {
    const { validateInstallManifest } = loadPure('electron/main/extension-install-utils.ts')
    const { parseExtensionManifest } = loadPure('electron/main/automation-capabilities.ts')
    for (const name of [0, 1, false, true, null, ['unexpected'], { raw: 'name' }, ' stable ']) {
      for (const display of [{}, { label: 'Named label' }, { inputLabels: ['Slot override'] }, { inputLabels: [''] }, { inputLabels: ['   '] }]) {
        const manifest = JSON.parse(JSON.stringify({
          id: 'raw-name', type, entry: 'processor.js', generator_class: 'Fixture',
          nodes: [{ id: 'run', input: 'image', output: 'mesh', input_labels: display.inputLabels, inputs: [
            { name, label: display.label, type: 'image', required: false, extension_metadata: { preserve: true } },
          ] }],
        }))
        const original = structuredClone(manifest)
        validateInstallManifest(manifest, { hasEntryFile: () => true, hasGeneratorFile: () => true }, 'inert name fixture')
        const parsed = parseExtensionManifest(manifest, 'raw-name', new Set(), false)
        const store = { modelExtensions: type === 'model' ? [parsed] : [], processExtensions: type === 'process' ? [parsed] : [], installedWeightVariants: {} }
        const [owner] = discovery.buildAllWorkflowExtensions(store.modelExtensions, store.processExtensions)
        assert.deepEqual(owner.inputs[0].name, name)
        assert.equal(ports.getProcessTargetPorts(owner)[0].name, owner.inputs[0].name)
        assert.equal(ports.getProcessTargetPorts(owner)[0].required, false)
        const Node = actualOwner('src/areas/workflows/nodes/ExtensionNode.tsx', 'ExtensionNode', ['HANDLE_COLOR', 'TAG_CLS'], {
          ...state, ...variants, ...discovery, ...ports, WorkflowParamControl: Control,
          useState: React.useState, useRef: React.useRef, useLayoutEffect: React.useLayoutEffect, useCallback: React.useCallback,
          useExtensionsStore: (selector) => selector ? selector(store) : store,
          useNavStore: (selector) => selector({ openExtension: () => {} }),
          useWorkflowRunStore: (selector) => selector({ activeNodeId: null }),
          useReactFlow: () => ({ updateNodeData: () => assert.fail('display must not update workflow data') }),
          BaseNode: ({ subheader, handles, children }) => React.createElement('div', null, subheader, handles, children),
          Handle: 'handle', Position: { Left: 'left', Right: 'right' },
        })
        const props = { id: 'node', data: { extensionId: 'raw-name/run', enabled: true, params: { unknown: 'keep' } } }
        const expected = display.inputLabels?.[0] ?? (display.label ? 'Named label (image)' : typeof name === 'string' ? 'stable (image)' : 'image')
        const h = mountControl(props, Node)
        try {
          assert.deepEqual(h.all().filter((node) => node.type === 'span' && node.props.className?.includes('inline-flex')).map((node) => node.props.children), [expected, 'mesh'])
          assert.ok(h.all().some((node) => node.type === 'span' && node.props.children === 'optional'))
          assert.equal(h.find((node) => node.type === 'handle' && node.props.type === 'target').props.id, owner.inputs[0].name ?? 'input-0')
          // The PROCESS normalizer creates the outer port in the fixture's VM realm.
          assert.deepEqual({ ...owner.inputs[0] }, { ...original.nodes[0].inputs[0], required: false })
          assert.deepEqual(manifest, original)
          assert.equal(props.data.params.unknown, 'keep')
        } finally { h.unmount() }
      }
    }
  })
}

test('numeric strings remain visible through real shared numeric controls without emitting runtime rewrites', () => {
  for (const [type, value, defaultValue] of [['int', '7', 3], ['float', '0.75', 0.5], ['int', '07', 3], ['float', '0.750', 0.5], ['float', '0,75', 0.5]]) {
    const param = { id: 'numeric', label: 'Numeric', type, default: defaultValue }
    const changes = []
    const markup = renderToStaticMarkup(React.createElement(Control, { param, value, onChange: (next) => changes.push(next) }))
    assert.match(markup, new RegExp(`value="${value}"`))
    assert.deepEqual(changes, [])
  }
  let selected
  Control({ param: { id: 'select', label: 'Select', type: 'select', default: 0, options: [{ value: 0, label: '0' }, { value: 1, label: '1' }] }, value: 0, onChange: (value) => { selected = value } }).props.onChange({ target: { value: '1' } })
  assert.equal(selected, 1)
  assert.equal(typeof selected, 'number')
})

// Mount real React hooks and keyed reconciliation using the installed renderer.
// The host tree and bubbling event adapter are NOT a browser DOM or React Flow.
function mountControl(initialProps, Component = Control) {
  const container = { children: [] }
  const context = {}
  const append = (parent, child) => { child.parent = parent; parent.children.push(child) }
  const remove = (parent, child) => { parent.children.splice(parent.children.indexOf(child), 1) }
  const renderer = Reconciler({
    now: Date.now, supportsMutation: true, isPrimaryRenderer: false,
    getRootHostContext: () => context, getChildHostContext: () => context,
    getPublicInstance: (instance) => instance,
    prepareForCommit: () => null, resetAfterCommit: () => {},
    createInstance: (type, props) => ({ type, props, children: [] }),
    createTextInstance: (text) => ({ type: '#text', text, children: [] }),
    appendInitialChild: append, appendChild: append, appendChildToContainer: append,
    removeChild: remove, removeChildFromContainer: remove,
    insertBefore: (parent, child, before) => { child.parent = parent; parent.children.splice(parent.children.indexOf(before), 0, child) },
    shouldSetTextContent: () => false, finalizeInitialChildren: () => false,
    prepareUpdate: () => true,
    commitUpdate: (instance, _payload, _type, _old, props) => { instance.props = props },
    commitTextUpdate: (instance, _old, text) => { instance.text = text },
    clearContainer: (target) => { target.children = [] },
    scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1,
    detachDeletedInstance: () => {}, getCurrentEventPriority: () => 1,
  })
  const root = renderer.createContainer(container, 0, null, false, null, '', (error) => { throw error }, null)
  const all = (node = container) => [node, ...node.children.flatMap((child) => all(child))]
  const update = (props) => renderer.flushSync(() => renderer.updateContainer(props ? React.createElement(Component, props) : null, root, null))
  update(initialProps)
  return {
    update, all,
    find: (predicate) => all().find(predicate),
    act: (action) => renderer.flushSync(action),
    flushEffects: () => renderer.flushPassiveEffects(),
    unmount: () => update(null),
  }
}

test('mounted prompt and generic string editors toggle explicitly and retain controlled multiline values', () => {
  for (const param of [string({ id: 'prompt', label: 'Prompt' }), string({ id: 'name', label: 'Name' })]) {
    const changes = []
    const props = { param, value: 'line one\nline two', onChange: (value) => changes.push(value) }
    const h = mountControl(props)
    try {
      const editor = () => h.find((node) => node.type === 'textarea' || node.type === 'input')
      const toggle = () => h.find((node) => node.type === 'button' && node.props['aria-expanded'] !== undefined)
      assert.equal(editor().type, param.id === 'prompt' ? 'textarea' : 'input')
      assert.ok(toggle(), 'an explicit expansion toggle is available')
      assert.equal(editor().props['aria-label'], param.label)
      for (let i = 0; i < 2; i++) {
        const expanded = toggle().props['aria-expanded']
        h.act(() => toggle().props.onClick())
        assert.equal(toggle().props['aria-expanded'], !expanded)
        assert.equal(editor().type, expanded ? 'input' : 'textarea')
        assert.equal(editor().props.value, props.value)
        assert.deepEqual(changes, [], 'presentation toggles must not rewrite values')
      }
      h.act(() => editor().props.onChange({ target: { value: 'typed\ntext' } }))
      assert.deepEqual(changes, ['typed\ntext'])
      const instance = editor()
      h.update({ ...props, value: changes.at(-1) })
      assert.equal(editor(), instance, 'typing updates the same host instance instead of remounting the editor')
      assert.equal(editor().props.value, 'typed\ntext')
      h.update({ ...props, value: '' })
      assert.equal(editor().props.value, '')
    } finally { h.unmount() }
  }
})

test('mounted field and control-type switches reset expansion without changing hook order', () => {
  const props = { param: string({ id: 'name', label: 'Name' }), value: '', onChange: () => {} }
  const h = mountControl(props)
  const toggle = () => h.find((node) => node.props?.['aria-expanded'] !== undefined)
  try {
    assert.ok(toggle(), 'generic fields have an expansion toggle')
    h.act(() => toggle().props.onClick())
    assert.ok(h.find((node) => node.type === 'textarea'))
    h.update({ ...props, param: string({ id: 'other', label: 'Other' }) })
    assert.ok(h.find((node) => node.type === 'input'))
    h.update({ ...props, param: string({ id: 'prompt', label: 'Prompt' }) })
    assert.ok(h.find((node) => node.type === 'textarea'))
    h.act(() => toggle().props.onClick())
    assert.ok(h.find((node) => node.type === 'input'))
    h.update({ ...props, param: { id: 'b', label: 'Enabled', type: 'boolean', default: false }, value: false })
    assert.equal(h.find((node) => node.props?.role === 'switch').props['aria-checked'], false)
    h.update({ ...props, param: string({ id: 'prompt', label: 'Prompt' }) })
    assert.ok(h.find((node) => node.type === 'textarea'))
  } finally { h.unmount() }
})

test('mounted control down handlers block bubbling but leave default editing and selection intact', () => {
  for (const param of [
    string({ id: 'prompt', label: 'Prompt' }), string(),
    { id: 'i', label: 'Count', type: 'int', default: 0 },
    { id: 'f', label: 'Strength', type: 'float', default: 0.5, min: 0, max: 1, step: 0.05 },
    { id: 'b', label: 'Enabled', type: 'boolean', default: false },
    { id: 's', label: 'Select', type: 'select', default: 0, options: [{ value: 0 }] },
    { id: 'file', label: 'File', type: 'file-select', default: '', dir_from: 'folder' },
  ]) {
    const h = mountControl({ param, value: param.default, onChange: () => {} })
    try {
      for (const target of h.all().filter((node) => ['input', 'textarea', 'select', 'button'].includes(node.type))) {
        for (const eventName of ['onPointerDown', 'onMouseDown']) {
          let stopped = false, prevented = false
          const selection = { selectionStart: 1, selectionEnd: 3 }
          const event = { target: selection, stopPropagation: () => { stopped = true }, preventDefault: () => { prevented = true } }
          for (let node = target; node && !stopped; node = node.parent) node.props?.[eventName]?.(event)
          assert.equal(stopped, true, `${param.type}/${target.type}/${eventName} escapes to the canvas`)
          assert.equal(prevented, false)
          assert.deepEqual(selection, { selectionStart: 1, selectionEnd: 3 })
        }
      }
    } finally { h.unmount() }
  }
})

test('mounted numeric editors retain incomplete typing and their host instance through controlled updates', () => {
  for (const type of ['int', 'float']) {
    const param = { id: 'number', label: 'Number', type, default: 0, min: 0, max: 1, step: 0.05 }
    const changes = []
    function Controlled() {
      const [value, setValue] = React.useState(0)
      return React.createElement(Control, { param, value, onChange: (next) => { changes.push(next); setValue(next) } })
    }
    const h = mountControl({}, Controlled)
    try {
      const input = () => h.find((node) => node.type === 'input' && node.props.type === 'text')
      const instance = input()
      h.act(() => input().props.onChange({ target: { value: '-' } }))
      assert.equal(input().props.value, '-')
      assert.deepEqual(changes, [])
      const typed = type === 'float' ? '0,25' : '7'
      h.act(() => input().props.onChange({ target: { value: typed } }))
      assert.equal(changes.at(-1), type === 'float' ? 0.25 : 7)
      h.update({})
      assert.equal(input(), instance)
      assert.equal(input().props.value, typed)
    } finally { h.unmount() }
  }
})

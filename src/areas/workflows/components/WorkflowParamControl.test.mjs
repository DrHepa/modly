import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

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
  return Control({ param, value, onChange, resolvedParams })
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
  assert.equal(elements(tree).filter((node) => node.type === 'button').length, 0)
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
const require = createRequire(import.meta.url)
function loadPure(file) {
  const mod = { exports: {} }
  vm.runInNewContext(buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, { module: mod, exports: mod.exports, require })
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
    if (!callback && ts.isFunctionDeclaration(node) && node.name?.text === functionName) body = node.getText(ast).replace(/^export default /, '')
    if (ts.isVariableDeclaration(node)) {
      if (constants.includes(node.name.getText(ast))) declarations.push(`const ${node.getText(ast)};`)
      if (callback && node.name.getText(ast) === functionName) body = `const ${functionName} = ${node.initializer.arguments[0].getText(ast)};`
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(body, `${functionName} not found`)
  const code = transformSync(`${declarations.join('\n')}\n${body}\n globalThis.result = ${functionName}`, { loader: 'tsx', jsx: 'automatic', format: 'cjs' }).code
  const context = { ...env, require }
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
  }
  let tree = Node({ id: 'node', data: nodes[0].data })
  assert.deepEqual(elements(tree.props.handles).filter((node) => node.type === 'handle' && node.props.type === 'target').map((node) => node.props.id), ['input-0', 'input-1', 'input-2'])
  manifestNode.inputs = [{ name: 'front', type: 'image' }, { name: 'coarse', type: 'mesh', required: false }]
  tree = Node({ id: 'node', data: nodes[0].data })
  assert.deepEqual(elements(tree.props.handles).filter((node) => node.type === 'handle' && node.props.type === 'target').map((node) => node.props.id), ['front', 'coarse'])
})

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
  assert.equal(selected, '1')
})

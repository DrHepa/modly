import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const React = require('react') as typeof import('react')
const Reconciler = require('react-reconciler')
const repo = path.resolve(import.meta.dirname, '../../../..')
type Host = { type: string; props: Record<string, any>; children: Host[]; focus(): void }

async function loadDrawer() {
  const dir = await mkdtemp('/tmp/worlds-ai-drawer-mounted-')
  await symlink(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
  await writeFile(path.join(dir, 'package.json'), '{"type":"module"}')
  const chatMock = path.join(dir, 'ChatPanel.mjs')
  await writeFile(chatMock, "import React from 'react'; export default function ChatPanel() { return React.createElement('chat-panel', { 'aria-label': 'Scene chat' }) }")
  const result = await build({ entryPoints: [path.join(import.meta.dirname, 'WorldsAiDrawer.tsx')], bundle: true, write: false,
    format: 'esm', platform: 'node', tsconfig: path.join(repo, 'tsconfig.web.json'),
    external: ['react', 'react-dom', 'react/jsx-runtime'], plugins: [{ name: 'mock-chat', setup(plugin) {
      plugin.onResolve({ filter: /ChatPanel\.tsx$/ }, () => ({ path: chatMock }))
    } }],
  })
  const outfile = path.join(dir, 'drawer.mjs')
  await writeFile(outfile, result.outputFiles[0].text)
  return { component: (await import(pathToFileURL(outfile).href)).default as React.ComponentType<any>, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

function mount() {
  const append = (parent: Host, child: Host) => { parent.children.push(child) }
  const remove = (parent: Host, child: Host) => { parent.children.splice(parent.children.indexOf(child), 1) }
  const renderer = Reconciler({ now: performance.now.bind(performance), supportsMutation: true, isPrimaryRenderer: true,
    getRootHostContext: () => null, getChildHostContext: () => null, getPublicInstance: (node: Host) => node,
    prepareForCommit: () => null, resetAfterCommit() {}, shouldSetTextContent: () => false,
    createInstance: (type: string, props: Host['props']) => ({ type, props, children: [], focus() {} }),
    createTextInstance: (value: string) => ({ type: '#text', props: { value }, children: [], focus() {} }),
    appendInitialChild: append, appendChild: append, appendChildToContainer: append,
    removeChild: remove, removeChildFromContainer: remove, clearContainer: (node: Host) => { node.children = [] },
    insertBefore: append, insertInContainerBefore: append, finalizeInitialChildren: () => false,
    prepareUpdate: () => true, commitUpdate: (node: Host, _payload: unknown, _type: unknown, _old: unknown, props: Host['props']) => { node.props = props },
    commitTextUpdate: (node: Host, _old: unknown, value: string) => { node.props.value = value },
    hideInstance: () => {}, unhideInstance: () => {}, hideTextInstance: () => {}, unhideTextInstance: () => {},
    scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1, getCurrentEventPriority: () => 1,
    detachDeletedInstance() {}, supportsMicrotasks: true, scheduleMicrotask: queueMicrotask,
  })
  const container: Host = { type: 'root', props: {}, children: [], focus() {} }
  const root = renderer.createContainer(container, 0, null, false, null, '', () => {}, null)
  return { container, render(value: React.ReactNode) { renderer.flushSync(() => renderer.updateContainer(value, root, null, null)); renderer.flushPassiveEffects() } }
}
function find(node: Host, predicate: (item: Host) => boolean): Host | undefined {
  if (predicate(node)) return node
  for (const child of node.children) { const result = find(child, predicate); if (result) return result }
  return undefined
}
function text(node: Host): string { return node.type === '#text' ? node.props.value : node.children.map(text).join('') }

test('mounted Worlds assistant has a single full-width chat and no review or CLI chrome', async () => {
  const { component: Drawer, cleanup } = await loadDrawer()
  const host = mount()
  let state: { status: string; message: string } = { status: 'idle', message: '' }
  const listeners = new Set<() => void>()
  let undos = 0
  const adapter = { getState: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    cancel() {}, undo: async () => { undos += 1 } }
  const render = () => host.render(React.createElement(Drawer, { adapter, disabled: false, canUndo: true }))
  try {
    render()
    const toggle = find(host.container, (node) => node.type === 'button' && text(node).includes('AI'))!
    assert.equal(toggle.props['aria-expanded'], false)
    toggle.props.onClick()
    render()
    assert.equal(toggle.props['aria-expanded'], true)
    const content = find(host.container, (node) => node.props.id === 'worlds-ai-content')!
    assert.ok(content)
    assert.equal(find(content, (node) => node.type === 'chat-panel')?.props['aria-label'], 'Scene chat')
    assert.equal(find(content, (node) => node.type === 'aside'), undefined)
    assert.doesNotMatch(text(host.container), /Review|Local CLI|External CLI|pairing/i)
    state = { status: 'applied', message: 'Changes applied. Undo is available.' }
    for (const listener of listeners) listener()
    render()
    const undo = find(host.container, (node) => node.type === 'button' && node.props['aria-label'] === 'Undo AI change')!
    assert.ok(undo)
    undo.props.onClick()
    assert.equal(undos, 1)
  } finally { host.render(null); await cleanup() }
})

test('Worlds assistant direct mode and layout do not expose separate review or CLI controls', async () => {
  const drawer = await readFile(new URL('./WorldsAiDrawer.tsx', import.meta.url), 'utf8')
  const workbench = await readFile(new URL('./WorldsWorkbench.tsx', import.meta.url), 'utf8')
  const css = await readFile(new URL('../WorldsWorkbench.css', import.meta.url), 'utf8')
  assert.doesNotMatch(drawer, /Local CLI access|External CLI proposals|Worlds proposal review|Start CLI pairing|<aside/)
  assert.match(workbench, /autoApply: true/)
  assert.match(css, /\.worlds-ai-drawer__content\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/)
  assert.match(css, /\.worlds-ai-drawer__status\s*\{[^}]*white-space:\s*normal/)
  assert.match(css, /\.worlds-ai-drawer__status\s*\{[^}]*overflow-wrap:\s*anywhere/)
})

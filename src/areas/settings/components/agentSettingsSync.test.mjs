import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { buildSync, transformSync } from 'esbuild'
import { pathToFileURL } from 'node:url'
import React from 'react'
import Reconciler from 'react-reconciler'
import { create } from 'zustand'

// Real components, store, React scheduling and effects; an in-memory host, inert
// fetch and secure-storage doubles. No DOM, provider, engine or network is used.
const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '../../../..')
const context = {}
const remove = (parent, child) => { const i = parent.children.indexOf(child); if (i >= 0) parent.children.splice(i, 1) }
const append = (parent, child) => { remove(parent, child); parent.children.push(child) }
const insert = (parent, child, before) => { remove(parent, child); parent.children.splice(parent.children.indexOf(before), 0, child) }
const renderer = Reconciler({
  now: Date.now, supportsMutation: true, isPrimaryRenderer: false,
  getRootHostContext: () => context, getChildHostContext: () => context,
  getPublicInstance: (node) => node, prepareForCommit: () => null, resetAfterCommit() {},
  createInstance: (type, props) => ({ type, props, children: [], style: {}, scrollIntoView() {}, contains: () => false }),
  createTextInstance: (text) => ({ type: '#text', props: { text }, children: [] }),
  appendInitialChild: append, appendChild: append, appendChildToContainer: append,
  removeChild: remove, removeChildFromContainer: remove, insertBefore: insert, insertInContainerBefore: insert,
  finalizeInitialChildren: () => false, shouldSetTextContent: () => false, prepareUpdate: () => true,
  commitUpdate: (node, _payload, _type, _old, props) => { node.props = props },
  commitTextUpdate: (node, _old, text) => { node.props.text = text },
  clearContainer: (node) => { node.children = [] }, detachDeletedInstance() {},
  scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1,
})
function flush(callback = () => {}) {
  renderer.flushSync(callback)
  for (let n = 0; n < 10; n++) {
    if (!renderer.flushPassiveEffects()) return
    renderer.flushSync(() => {})
  }
  assert.fail('Effects did not settle')
}
async function settle() { for (let n = 0; n < 12; n++) { await Promise.resolve(); flush() } }
const all = (node) => [node, ...node.children.flatMap(all)]
const text = (node) => node.type === '#text' ? node.props.text : node.children.map(text).join('')
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

async function mount(t, { provider = 'custom', external = {}, hydrate = null } = {}) {
  const pending = [], chats = [], writes = [], localCalls = []
  const decrypt = deferred()
  const localStorage = {
    getItem: () => hydrate ? JSON.stringify({ version: 3, state: hydrate }) : null,
    setItem: (...args) => writes.push(args), removeItem() {},
  }
  const sourceRoot = process.env.MODLY_AGENT_SYNC_SOURCE_ROOT ?? root
  let session = {
    id: 'settings-session', title: 'Settings fixture', revision: 1,
    createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
    messages: [], attachments: [],
  }
  const sessionApi = {
    list: async () => {
      const { messages, attachments, ...metadata } = session
      return { sessions: [{ ...metadata, messageCount: messages.length, attachmentCount: attachments.length }], activeSessionId: session.id, readOnly: false }
    },
    read: async ({ sessionId }) => { assert.equal(sessionId, session.id); return structuredClone(session) },
    appendMessage: async ({ sessionId, expectedRevision, message }) => {
      assert.equal(sessionId, session.id)
      assert.equal(expectedRevision, session.revision, 'fixture must exercise current revisioned persistence')
      assert.ok(!session.messages.some((entry) => entry.id === message.id))
      session = { ...session, revision: session.revision + 1, messages: [...session.messages, { attachmentIds: [], summaries: [], ...structuredClone(message) }] }
      return structuredClone(session)
    },
    create: async () => assert.fail('Session creation is outside the settings fixture'),
    activate: async () => assert.fail('Session switching is outside the settings fixture'),
    rename: async () => assert.fail('Session rename is outside the settings fixture'),
    delete: async () => assert.fail('Session deletion is outside the settings fixture'),
    addAttachment: async () => assert.fail('Attachment writes are outside the settings fixture'),
    removeAttachment: async () => assert.fail('Attachment deletion is outside the settings fixture'),
    readAttachment: async () => assert.fail('Settings messages have no attachments'),
  }
  const protectedContextUnavailable = async () => { throw new Error('Protected Agent context is unavailable in this ordinary settings fixture') }
  const window = { electron: {
    secureStore: { decrypt: () => decrypt.promise, encrypt: async (key) => `encrypted:${key}` },
    agentSessions: sessionApi,
    agentCapabilities: { list: protectedContextUnavailable, resolveSkillContexts: protectedContextUnavailable },
    agentActions: { list: protectedContextUnavailable, leaseModel: protectedContextUnavailable },
  } }
  const fetch = (url, options) => {
    if (url.endsWith('/agent/external/models')) {
      const response = deferred()
      pending.push({ url, options, ...response })
      return response.promise
    }
    if (url.endsWith('/agent/chat')) {
      chats.push(JSON.parse(options.body))
      return Promise.resolve({ ok: true, json: async () => ({ message: 'Fixture response', actions: [] }) })
    }
    const local = {
      '/llm/status': { binary_installed: true },
      '/llm/models?downloaded=true': { models: [] },
      '/llm/config': { max_models: 'auto', resolved_max_models: 1 },
    }
    const suffix = Object.keys(local).find((key) => url.endsWith(key))
    assert.ok(suffix, `Unexpected fetch: ${url}`)
    assert.equal(options, undefined, 'Local controls must not mutate settings during mount')
    localCalls.push(url)
    return Promise.resolve({ ok: true, json: async () => local[suffix] })
  }
  const load = (file, imports = {}, sourceRoot = root, bundle = false) => {
    const module = { exports: {} }
    const entry = path.join(sourceRoot, file)
    const code = bundle ? buildSync({
      entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false,
      external: ['react', 'react/*', 'zustand', 'axios'],
      alias: { '@shared': path.join(sourceRoot, 'src/shared'), '@areas': path.join(sourceRoot, 'src/areas') },
      define: { 'import.meta.url': JSON.stringify(pathToFileURL(entry).href) }, logOverride: { 'empty-import-meta': 'error' },
    }).outputFiles[0].text : transformSync(readFileSync(entry, 'utf8'), { loader: path.extname(entry) === '.tsx' ? 'tsx' : 'ts', jsx: 'automatic', format: 'cjs' }).code
    // Keep promises in the same realm: Zustand's storage adapter checks
    // `instanceof Promise`, so a VM realm would not exercise real hydration.
    new Function('module', 'exports', 'require', 'window', 'localStorage', 'fetch', 'document', code)(
      module, module.exports, (id) => id in imports ? imports[id] : require(id),
      window, localStorage, fetch, { addEventListener() {}, removeEventListener() {} },
    )
    return module.exports
  }
  const agent = load('src/shared/stores/agentStore.ts')
  if (!hydrate) {
    await settle()
    agent.useAgentStore.setState({ provider, external })
    await settle()
    writes.length = 0
  }
  const app = create(() => ({ apiUrl: 'http://fixture.invalid', currentJob: null, meshStats: null }))
  const { createAgentSessionsStore } = load('src/shared/stores/agentSessionsStore.ts', {}, sourceRoot)
  const sessions = createAgentSessionsStore(sessionApi)
  await sessions.getState().initialize()
  assert.equal(sessions.getState().activeSession.id, session.id)
  assert.equal(sessions.getState().initialized, true)
  const sessionImports = { '@shared/stores/agentSessionsStore': { useAgentSessionsStore: sessions } }
  const imports = {
    ...sessionImports,
    '@shared/hooks/useApi': load('src/shared/hooks/useApi.ts', { '../stores/appStore.ts': { useAppStore: app } }, sourceRoot),
    '@areas/workflows/preflight': load('src/areas/workflows/preflight.ts', {}, sourceRoot, true),
    '../agentDirectActions': load('src/areas/generate/agentDirectActions.ts', {}, sourceRoot),
    '@shared/utils/agentModels': load('src/shared/utils/agentModels.ts', {}, sourceRoot),
    './AgentSessionHistory': load('src/areas/generate/components/AgentSessionHistory.tsx', sessionImports, sourceRoot),
    '@shared/types/artifacts': load('src/shared/types/artifacts.ts', {}, sourceRoot),
    '../../worlds/editor/worldAiChatAdapter.ts': load('src/areas/worlds/editor/worldAiChatAdapter.ts', {}, sourceRoot, true),
    '@shared/stores/agentStore': agent,
    '@shared/stores/appStore': { useAppStore: app },
    '@shared/ui': load('src/shared/ui/index.tsx'),
    '@shared/services/llmDownloads': { consumeSse: () => assert.fail('Engine installation is forbidden') },
    '@shared/components/ui/SseProgressBar': { SseProgressBar: () => null },
    '@shared/components/ui/ModelLibraryModal': { ModelLibraryModal: () => React.createElement('fixture-library') },
    '@shared/utils/format': { formatBytes: String },
    '@shared/stores/llmModelsStore': { useLlmModels: () => ({ models: [
      { id: 'local-a', name: 'Local A', downloaded: true }, { id: 'local-b', name: 'Local B', downloaded: true },
    ] }) },
    '@shared/stores/workflowsStore': { useWorkflowsStore: create(() => ({ workflows: [] })) },
    '@shared/stores/extensionsStore': { useExtensionsStore: () => ({ modelExtensions: [], processExtensions: [] }) },
    '@areas/workflows/workflowRunStore': { useWorkflowRunStore: create(() => ({ runState: { status: 'idle' } })) },
    '@areas/workflows/mockExtensions': { buildAllWorkflowExtensions: () => [] },
  }
  const Settings = load('src/areas/settings/components/AgentSection.tsx', imports, sourceRoot).AgentSection
  const Chat = load('src/areas/generate/components/ChatPanel.tsx', imports, sourceRoot).default
  const host = { type: 'root', props: {}, children: [] }
  const container = renderer.createContainer(host, 0, null, false, null, '', (error) => { throw error }, null)
  const unmount = () => flush(() => renderer.updateContainer(null, container, null))
  t.after(unmount)
  flush(() => renderer.updateContainer(React.createElement(React.Fragment, null, React.createElement(Settings), React.createElement(Chat)), container, null))
  await settle()
  assert.ok(sessions.getState().activeSession, 'real current session must remain active after mount')
  const nodes = () => all(host)
  const button = (label) => { const node = nodes().find((n) => n.type === 'button' && (n.props.title === label || text(n) === label)); assert.ok(node, `Missing button: ${label}`); return node }
  const click = (label) => flush(() => button(label).props.onClick())
  const field = (label) => {
    const block = nodes().find((n) => n.type === 'div' && n.props.className === 'px-4 py-3 flex flex-col gap-2' && n.children.some((child) => text(child).startsWith(label)))
    const node = block && all(block).find((n) => n.type === 'input' || n.type === 'select')
    assert.ok(node, `Missing field: ${label}`)
    return node
  }
  const change = (label, value) => flush(() => field(label).props.onChange({ target: { value } }))
  const finish = async (request, models, ok = true) => { request.resolve({ ok, json: async () => ({ models }) }); await settle() }
  const send = async () => {
    const textarea = nodes().find((n) => n.type === 'textarea')
    flush(() => textarea.props.onChange({ target: { value: 'Fixture prompt' } }))
    const index = chats.length
    const sendButton = nodes().find((node) => node.type === 'button' && node.props['aria-label'] === 'Send message')
    assert.ok(sendButton, 'Real chat send control must be mounted')
    assert.equal(sendButton.props.disabled, false, 'Real chat must be ready to send')
    let completion
    flush(() => { completion = sendButton.props.onClick() })
    assert.ok(completion && typeof completion.then === 'function', 'Real send must expose its completion')
    await completion
    await settle()
    assert.equal(chats.length, index + 1, 'Each send must capture exactly one new real request')
    return chats[index]
  }
  return { agent: agent.useAgentStore, app, host, nodes, button, click, field, change, pending, finish, send, writes, localCalls, decrypt, unmount }
}

test('mounted chat follows asynchronous secure settings hydration and preserves a deliberate local model override', async (t) => {
  const view = await mount(t, { hydrate: { provider: 'local', localModel: 'local-a', defaultThinking: 'off', external: { openai: { apiKey: 'ciphertext', model: 'saved' } } } })
  assert.equal(view.agent.persist.hasHydrated(), false)
  const hydrated = new Promise((resolve) => view.agent.persist.onFinishHydration(resolve))
  view.decrypt.resolve('decrypted-key')
  await hydrated
  await settle()
  assert.equal(view.agent.persist.hasHydrated(), true)
  assert.equal((await view.send()).model, 'local-a')
  assert.equal(view.button('Thinking: off').props.title, 'Thinking: off')
  view.click('Local A'); view.click('Local B')
  flush(() => view.agent.setState({ localModel: 'local-a' }))
  flush(() => view.nodes().find((n) => n.type === 'input' && n.props.type === 'radio' && n.props.value === 'on').props.onChange())
  assert.equal((await view.send()).model, 'local-b')
  assert.ok(view.button('Thinking: on'))
  view.click('Thinking: on')
  flush(() => view.agent.setState({ external: { openai: { apiKey: 'changed', model: 'external-new' } } }))
  assert.equal((await view.send()).thinking, 'off')
  flush(() => view.agent.getState().setProvider('openai'))
  assert.equal((await view.send()).model, 'external-new')
  flush(() => view.agent.getState().setProvider('local'))
  assert.equal((await view.send()).model, 'local-b')
})

test('mounted external fields hydrate without overwriting fields the user has edited', async (t) => {
  const view = await mount(t, { provider: 'openai' })
  view.change('API key', 'unsaved-key')
  flush(() => view.agent.setState({ external: { openai: { apiKey: 'hydrated-key', model: 'hydrated-model' } } }))
  assert.equal(view.field('API key').props.value, 'unsaved-key')
  assert.equal(view.field('Model').props.value, 'hydrated-model')
})

test('a local choice made before secure hydration is not reset to the arriving default', async (t) => {
  const view = await mount(t, { hydrate: { provider: 'local', localModel: 'local-a', defaultThinking: 'auto', external: { openai: { apiKey: 'ciphertext', model: 'saved' } } } })
  view.click('qwen3-4b'); view.click('Local B')
  const hydrated = new Promise((resolve) => view.agent.persist.onFinishHydration(resolve))
  view.decrypt.resolve('decrypted-key'); await hydrated; await settle()
  assert.equal((await view.send()).model, 'local-b')
  assert.equal(view.agent.getState().localModel, 'local-a')
})

test('successful discovery reconciles only the current draft and persists it only on Save', async (t) => {
  const view = await mount(t, { external: { custom: { apiKey: '  key  ', baseUrl: 'http://custom.invalid/v1/', model: 'missing' } } })
  view.click('Test')
  assert.equal(view.pending[0].url, 'http://fixture.invalid/agent/external/models')
  assert.equal(view.pending[0].options.method, 'POST')
  assert.deepEqual(JSON.parse(view.pending[0].options.body), { base_url: 'http://custom.invalid/v1', api_key: 'key' })
  await view.finish(view.pending[0], ['first', 'second'])
  assert.equal(view.field('Model').props.value, 'first')
  assert.equal(view.agent.getState().external.custom.model, 'missing')
  assert.equal(view.writes.length, 0)
  view.change('Model', 'second')
  view.click('Test'); await view.finish(view.pending[1], ['first', 'second'])
  assert.equal(view.field('Model').props.value, 'second')
  view.click('Save'); await settle()
  assert.deepEqual(JSON.parse(JSON.stringify(view.agent.getState().external.custom)), { apiKey: 'key', baseUrl: 'http://custom.invalid/v1', model: 'second' })
  const request = await view.send()
  assert.equal(request.model, 'second')
  assert.deepEqual(request.provider, { type: 'external', base_url: 'http://custom.invalid/v1', api_key: 'key' })
})

test('provider switches retain unsaved drafts and reject old provider responses, including a switch back', async (t) => {
  const view = await mount(t)
  view.change('Base URL', 'http://unsaved.invalid/v1'); view.change('API key', 'custom-key'); view.change('Model', 'manual-custom')
  view.click('Test')
  view.change('LLM provider', 'openai')
  assert.equal(view.button('Test').props.disabled, false)
  view.change('API key', 'openai-key'); view.change('Model', 'manual-openai'); view.click('Test')
  await view.finish(view.pending[1], ['openai-first'])
  await view.finish(view.pending[0], ['stale-custom'])
  assert.equal(view.field('Model').props.value, 'openai-first')
  view.change('LLM provider', 'custom')
  assert.equal(view.field('Base URL').props.value, 'http://unsaved.invalid/v1')
  assert.equal(view.field('API key').props.value, 'custom-key')
  assert.equal(view.field('Model').props.value, 'manual-custom')
  view.click('Test')
  view.change('LLM provider', 'local'); view.change('LLM provider', 'custom')
  await view.finish(view.pending[2], ['stale-return'])
  assert.equal(view.field('Model').props.value, 'manual-custom')
  assert.equal(view.field('Model').type, 'input')
  assert.equal(view.agent.getState().external.custom, undefined)
  assert.equal(view.agent.getState().external.openai, undefined)
})

for (const label of ['Base URL', 'API key']) {
  test(`changing ${label} invalidates lists and pending discovery, even when changed back`, async (t) => {
    const view = await mount(t)
    view.change('Model', 'manual')
    view.click('Test')
    view.change(label, 'changed')
    view.click('Test')
    await view.finish(view.pending[1], ['fresh'])
    await view.finish(view.pending[0], ['stale'])
    assert.equal(view.field('Model').props.value, 'fresh')
    view.change(label, 'changed-again')
    assert.equal(view.field('Model').type, 'input')
    view.change('Model', 'freeform')
    view.click('Test')
    view.change(label, 'temporary'); view.change(label, 'changed-again')
    await view.finish(view.pending[2], ['stale-after-return'])
    assert.equal(view.field('Model').props.value, 'freeform')
    view.click('Save'); await settle()
    assert.equal(view.agent.getState().external.custom.model, 'freeform')
  })
}

test('model edits during discovery are not overwritten and only the latest same-context request can settle', async (t) => {
  const view = await mount(t)
  view.change('Model', 'original'); view.click('Test')
  view.change('Model', 'manual-choice')
  await view.finish(view.pending[0], ['server-choice'])
  assert.equal(view.field('Model').props.value, 'manual-choice')
  assert.equal(view.agent.getState().external.custom, undefined)
  // A queued/repeated click may enter before the disabled button commits.
  const click = view.button('Test').props.onClick
  flush(() => { click(); click() })
  await view.finish(view.pending[2], ['latest'])
  await view.finish(view.pending[1], ['older'])
  assert.equal(view.field('Model').props.value, 'latest')
  view.click('Test'); view.change('Model', 'temporary'); view.change('Model', 'latest')
  await view.finish(view.pending[3], ['must-not-replace'])
  assert.equal(view.field('Model').props.value, 'latest')
})

test('stale failures cannot clear a new request and a current failure restores manual editing', async (t) => {
  const view = await mount(t)
  view.change('Model', 'manual'); view.click('Test')
  view.change('API key', 'new-key'); view.click('Test')
  view.pending[0].reject(new Error('old request failed')); await settle()
  assert.equal(view.button('Testing…').props.disabled, true)
  assert.ok(!text(view.host).includes('Could not list models'))
  await view.finish(view.pending[1], ['current'])
  view.click('Test'); view.pending[2].reject(new Error('current request failed')); await settle()
  assert.equal(view.field('Model').type, 'input')
  assert.equal(view.field('Model').props.value, 'current')
})

test('Save during discovery remains an explicit model choice rather than a pending auto-selection', async (t) => {
  const view = await mount(t)
  view.change('Model', 'chosen'); view.click('Test'); view.click('Save'); await settle()
  const writes = view.writes.length
  await view.finish(view.pending[0], ['other'])
  assert.equal(view.field('Model').props.value, 'chosen')
  assert.equal(view.agent.getState().external.custom.model, 'chosen')
  assert.equal(view.writes.length, writes)
})

for (const failure of ['empty', 'unsupported', 'http-error', 'rejected']) {
  test(`${failure} listing keeps free-form models editable and saveable`, async (t) => {
    const view = await mount(t, { provider: failure === 'unsupported' ? 'anthropic' : 'custom' })
    view.change('Model', 'manual-name'); view.click('Test')
    if (failure === 'rejected') { view.pending[0].reject(new Error('inert failure')); await settle() }
    else if (failure === 'unsupported') { view.pending[0].resolve({ ok: true, json: async () => ({}) }); await settle() }
    else await view.finish(view.pending[0], failure === 'empty' ? [] : ['must-not-select'], failure !== 'http-error')
    assert.equal(view.field('Model').type, 'input')
    assert.equal(view.field('Model').props.value, 'manual-name')
    view.change('Model', 'arbitrary model identifier'); view.click('Save'); await settle()
    assert.equal(view.agent.getState().external[view.agent.getState().provider].model, 'arbitrary model identifier')
  })
}

test('API-origin changes and unmount make outstanding responses inert while local controls remain available', async (t) => {
  const view = await mount(t)
  view.change('Model', 'manual'); view.click('Test')
  flush(() => view.app.setState({ apiUrl: 'http://next-api.invalid' }))
  await view.finish(view.pending[0], ['stale-origin'])
  assert.equal(view.field('Model').props.value, 'manual')
  assert.equal(view.field('Model').type, 'input')
  view.click('Test'); view.unmount(); await view.finish(view.pending[1], ['after-unmount'])
  assert.equal(view.agent.getState().external.custom, undefined)
  const local = await mount(t, { provider: 'local' })
  assert.equal(local.localCalls.length, 3)
  assert.equal(local.field('Simultaneous models').props.value, 'auto')
  local.click('Browse…')
  assert.ok(local.nodes().some((n) => n.type === 'fixture-library'))
})

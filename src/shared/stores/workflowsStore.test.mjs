import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Bundle the store and tab-session helper with the real zustand dependency.
// Storage is private to each load in this isolated test process; the Electron
// workflows bridge is stubbed per test.
function loadStore() {
  const storage = new Map()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, String(value)) },
      removeItem: (key) => { storage.delete(key) },
      clear: () => { storage.clear() },
    },
  })
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-wfstore-test-')), 'workflowsStore.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('src/shared/stores/workflowsStore.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile).useWorkflowsStore
}

function stubBridge(workflows = {}) {
  globalThis.window = { electron: { workflows } }
}

const migrated = (id, over = {}) => ({
  id, name: id.toUpperCase(), description: '', nodes: [], edges: [],
  createdAt: '', updatedAt: '', ...over,
})

const legacyBlocks = (id) => ({
  id, name: id.toUpperCase(), description: '', input: 'image',
  blocks: [{ id: `${id}-blk`, extension: 'pack/x', enabled: true, params: {} }],
  createdAt: '', updatedAt: '',
})

// ─── load(): dedupe + migrate ──────────────────────────────────────────────────

test('load dedupes workflows that share an id, keeping the first', async () => {
  const useStore = loadStore()
  stubBridge({
    list: async () => [migrated('a', { name: 'FIRST' }), migrated('a', { name: 'SECOND' }), migrated('b')],
  })

  await useStore.getState().load()
  const { workflows, loading } = useStore.getState()

  assert.equal(loading, false)
  assert.deepEqual(workflows.map((w) => w.id), ['a', 'b'])
  assert.equal(workflows[0].name, 'FIRST') // the duplicate is dropped, first wins
})

test('load migrates legacy block-format workflows into nodes + edges', async () => {
  const useStore = loadStore()
  stubBridge({ list: async () => [legacyBlocks('w')] })

  await useStore.getState().load()
  const wf = useStore.getState().workflows[0]

  assert.deepEqual(wf.nodes.map((n) => n.type), ['inputNode', 'extensionNode'])
  assert.equal(wf.nodes[0].id, 'input-w')
  assert.equal(wf.nodes[1].id, 'w-blk')
  assert.equal(wf.edges.length, 1)
  assert.deepEqual({ source: wf.edges[0].source, target: wf.edges[0].target }, { source: 'input-w', target: 'w-blk' })
})

test('load flips loading back to false when the bridge throws', async () => {
  const useStore = loadStore()
  stubBridge({ list: async () => { throw new Error('disk error') } })

  await useStore.getState().load()
  assert.equal(useStore.getState().loading, false)
})

// ─── save(): insert vs update ──────────────────────────────────────────────────

test('save inserts a new workflow at the front, updates an existing one in place', async () => {
  const useStore = loadStore()
  stubBridge({ save: async () => ({ success: true }) })
  useStore.setState({ workflows: [migrated('a'), migrated('b')] })

  await useStore.getState().save(migrated('c'))
  assert.deepEqual(useStore.getState().workflows.map((w) => w.id), ['c', 'a', 'b'])

  await useStore.getState().save(migrated('b', { name: 'B2' }))
  const wf = useStore.getState().workflows.find((w) => w.id === 'b')
  assert.equal(wf.name, 'B2')
  assert.equal(useStore.getState().workflows.length, 3) // no duplicate
})

test('save does not touch state when the bridge reports failure', async () => {
  const useStore = loadStore()
  stubBridge({ save: async () => ({ success: false, error: 'nope' }) })
  useStore.setState({ workflows: [migrated('a')], openIds: ['a'], activeId: 'a' })
  useStore.getState().openWorkflow('a')
  const persistedBefore = localStorage.getItem('modly-workflow-tab-session')

  const result = await useStore.getState().save(migrated('z'))
  if (result.success) useStore.getState().openWorkflow('z')
  assert.equal(result.success, false)
  assert.deepEqual(useStore.getState().workflows.map((w) => w.id), ['a'])
  assert.deepEqual(useStore.getState().openIds, ['a'])
  assert.equal(useStore.getState().activeId, 'a')
  assert.equal(localStorage.getItem('modly-workflow-tab-session'), persistedBefore)
})

// ─── remove(): filter + active reset ────────────────────────────────────────────

test('remove drops the workflow and clears activeId when it was the active one', async () => {
  const useStore = loadStore()
  stubBridge({ delete: async () => ({ success: true }) })
  useStore.setState({ workflows: [migrated('a'), migrated('b')], activeId: 'a' })

  await useStore.getState().remove('a')
  assert.deepEqual(useStore.getState().workflows.map((w) => w.id), ['b'])
  assert.equal(useStore.getState().activeId, null)
})

test('remove keeps activeId when a different workflow is deleted', async () => {
  const useStore = loadStore()
  stubBridge({ delete: async () => ({ success: true }) })
  useStore.setState({ workflows: [migrated('a'), migrated('b')], activeId: 'b' })

  await useStore.getState().remove('a')
  assert.equal(useStore.getState().activeId, 'b')
})

// ─── importFile() + setActive() ────────────────────────────────────────────────

test('importFile migrates, moves the workflow to the front, and makes it active', async () => {
  const useStore = loadStore()
  stubBridge({ import: async () => ({ success: true, workflow: legacyBlocks('imp') }) })
  useStore.setState({ workflows: [migrated('a')], activeId: 'a' })

  await useStore.getState().importFile()
  const { workflows, activeId } = useStore.getState()

  assert.deepEqual(workflows.map((w) => w.id), ['imp', 'a'])
  assert.equal(activeId, 'imp')
  assert.deepEqual(workflows[0].nodes.map((n) => n.type), ['inputNode', 'extensionNode'])
})

test('setActive updates only activeId for an already-open workflow', () => {
  const useStore = loadStore()
  stubBridge()
  useStore.setState({ workflows: [migrated('a')], openIds: ['a'], activeId: null })

  useStore.getState().setActive('a')
  assert.equal(useStore.getState().activeId, 'a')
})


test('openWorkflow opens a saved closed workflow without duplicating or reordering open tabs', () => {
  const source = readFileSync(resolve('src/areas/generate/components/WorkflowPanel.tsx'), 'utf8')
  assert.match(source, /useWorkflowsStore\.getState\(\)\.openWorkflow\(selectedId!\); navigate\('workflows'\)/)

  const useStore = loadStore()
  stubBridge()
  useStore.setState({ workflows: [migrated('a'), migrated('b'), migrated('c')], openIds: ['b', 'a'], activeId: 'b' })

  useStore.getState().openWorkflow('a')
  assert.deepEqual(useStore.getState().openIds, ['b', 'a'])
  assert.equal(useStore.getState().activeId, 'a')
  assert.deepEqual(JSON.parse(localStorage.getItem('modly-workflow-tab-session')), { version: 1, openIds: ['b', 'a'], activeId: 'a' })

  useStore.getState().openWorkflow('c')
  assert.deepEqual(useStore.getState().openIds, ['b', 'a', 'c'])
  assert.equal(useStore.getState().activeId, 'c')
  assert.deepEqual(JSON.parse(localStorage.getItem('modly-workflow-tab-session')), { version: 1, openIds: ['b', 'a', 'c'], activeId: 'c' })
})

test('successful create saves before opening the new workflow and persists existing tab order', async () => {
  const source = readFileSync(resolve('src/areas/generate/components/ChatPanel.tsx'), 'utf8')
  assert.match(source, /const openWorkflow = useWorkflowsStore\(\(s\) => s\.openWorkflow\)/)
  assert.match(source, /const res = await saveWorkflow\(wf\)\s+if \(res\.success\) openWorkflow\(wf\.id\)/)

  const useStore = loadStore()
  stubBridge({ save: async () => ({ success: true }) })
  useStore.setState({ workflows: [migrated('a'), migrated('b')], openIds: ['b', 'a'], activeId: 'b' })
  useStore.getState().openWorkflow('b')
  const persistedBefore = localStorage.getItem('modly-workflow-tab-session')
  const wf = migrated('new')

  const result = await useStore.getState().save(wf)
  assert.equal(result.success, true)
  assert.deepEqual(useStore.getState().workflows.map((w) => w.id), ['new', 'a', 'b'])
  assert.deepEqual(useStore.getState().openIds, ['b', 'a'])
  assert.equal(useStore.getState().activeId, 'b')
  assert.equal(localStorage.getItem('modly-workflow-tab-session'), persistedBefore)
  if (result.success) useStore.getState().openWorkflow(wf.id)
  assert.deepEqual(useStore.getState().openIds, ['b', 'a', 'new'])
  assert.equal(useStore.getState().activeId, 'new')
  assert.deepEqual(JSON.parse(localStorage.getItem('modly-workflow-tab-session')), { version: 1, openIds: ['b', 'a', 'new'], activeId: 'new' })
})

test('setActive rejects saved closed workflow ids without changing tabs or persistence', () => {
  const useStore = loadStore()
  stubBridge()
  useStore.setState({ workflows: [migrated('a'), migrated('closed')], openIds: ['a'], activeId: 'a' })
  useStore.getState().openWorkflow('a')
  const persistedBefore = localStorage.getItem('modly-workflow-tab-session')

  useStore.getState().setActive('closed')
  assert.deepEqual(useStore.getState().openIds, ['a'])
  assert.equal(useStore.getState().activeId, 'a')
  assert.equal(localStorage.getItem('modly-workflow-tab-session'), persistedBefore)
})

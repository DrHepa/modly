import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import type { Workflow } from '@shared/types/electron.d'
import { WORKFLOW_TAB_SESSION_KEY, WORKFLOW_TAB_SESSION_VERSION } from './workflowTabSession'

const localStorageState = new Map<string, string>()

if (!globalThis.localStorage) {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key: string): string | null {
        return localStorageState.get(key) ?? null
      },
      setItem(key: string, value: string): void {
        localStorageState.set(key, value)
      },
      removeItem(key: string): void {
        localStorageState.delete(key)
      },
      clear(): void {
        localStorageState.clear()
      },
      key(index: number): string | null {
        return [...localStorageState.keys()][index] ?? null
      },
      get length(): number {
        return localStorageState.size
      },
    },
  })
}

const listCalls: Workflow[][] = []
let listError: Error | null = null
let importResult: { success: boolean; workflow?: Workflow } = { success: false }

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    electron: {
      workflows: {
        async list(): Promise<Workflow[]> {
          if (listError) throw listError
          return listCalls.shift() ?? []
        },
        async save() {
          return { success: true }
        },
        async delete() {
          return { success: true }
        },
        async import() {
          return importResult
        },
        async export() {
          return { success: true }
        },
      },
    },
  },
})

const { useWorkflowsStore } = await import(new URL('./workflowsStore.ts', import.meta.url).href)
const obsoleteWorkflowIoKey = 'io' + 'Contract'
const obsoleteEdgeOrderKey = 'targetItem' + 'Index'

function workflow(id: string, name: string, updatedAt: string, folder?: string, overrides: Partial<Workflow> = {}): Workflow {
  return {
    id,
    name,
    description: '',
    folder,
    nodes: [],
    edges: [],
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  }
}

function writeTabSession(value: unknown): void {
  localStorage.setItem(WORKFLOW_TAB_SESSION_KEY, JSON.stringify(value))
}

function readTabSession(): unknown {
  const raw = localStorage.getItem(WORKFLOW_TAB_SESSION_KEY)
  return raw === null ? null : JSON.parse(raw)
}

beforeEach(() => {
  listCalls.length = 0
  listError = null
  importResult = { success: false }
  localStorage.clear()
  useWorkflowsStore.setState({
    workflows: [],
    loading: false,
    activeId: null,
    openIds: [],
    folders: [],
    folderColors: {},
    bookmarkedFolders: [],
  })
})

test('workflowsStore.load keeps resolved collision lists renderable and clears loading', async () => {
  const canonical = workflow('5c721f0a-27ff-4627-81b9-7a37154bcd7e', 'Canonical Copy', '2026-06-22T18:00:00.000Z', 'Recovered')
  const sibling = workflow('second-workflow', 'Second Workflow', '2026-06-22T17:00:00.000Z')
  listCalls.push([canonical, sibling])

  useWorkflowsStore.setState({
    workflows: [workflow('stale-workflow', 'Stale Workflow', '2026-06-22T16:00:00.000Z')],
    loading: false,
    activeId: 'missing-workflow',
    openIds: ['missing-workflow', canonical.id, 'second-workflow'],
    folders: [],
    folderColors: {},
    bookmarkedFolders: [],
  })

  await useWorkflowsStore.getState().load()

  const state = useWorkflowsStore.getState()
  assert.equal(state.loading, false)
  assert.deepEqual(state.workflows.map((item: Workflow) => item.id), [canonical.id, sibling.id])
  assert.deepEqual(state.openIds, [canonical.id, sibling.id])
  assert.equal(state.activeId, canonical.id)
  assert.deepEqual(state.folders, ['Recovered'])
  assert.deepEqual(readTabSession(), {
    version: WORKFLOW_TAB_SESSION_VERSION,
    openIds: [canonical.id, sibling.id],
    activeId: canonical.id,
  })
})

test('workflowsStore hydrates open order and active tab from persisted session on restart', async () => {
  const first = workflow('first', 'First', '2026-06-22T18:00:00.000Z')
  const second = workflow('second', 'Second', '2026-06-22T17:00:00.000Z')
  const third = workflow('third', 'Third', '2026-06-22T16:00:00.000Z')
  writeTabSession({ version: WORKFLOW_TAB_SESSION_VERSION, openIds: [second.id, first.id], activeId: first.id })
  listCalls.push([first, second, third])

  useWorkflowsStore.setState({
    workflows: [],
    loading: false,
    activeId: first.id,
    openIds: [second.id, first.id],
    folders: [],
    folderColors: {},
    bookmarkedFolders: [],
  })

  await useWorkflowsStore.getState().load()

  const state = useWorkflowsStore.getState()
  assert.deepEqual(state.openIds, [second.id, first.id])
  assert.equal(state.activeId, first.id)
})

test('workflowsStore.load preserves explicit closed-all tab session', async () => {
  const latest = workflow('latest', 'Latest', '2026-06-22T18:00:00.000Z')
  const older = workflow('older', 'Older', '2026-06-22T17:00:00.000Z')
  writeTabSession({ version: WORKFLOW_TAB_SESSION_VERSION, openIds: [], activeId: null })
  listCalls.push([latest, older])

  await useWorkflowsStore.getState().load()

  const state = useWorkflowsStore.getState()
  assert.deepEqual(state.openIds, [])
  assert.equal(state.activeId, null)
  assert.deepEqual(readTabSession(), {
    version: WORKFLOW_TAB_SESSION_VERSION,
    openIds: [],
    activeId: null,
  })
})

test('workflowsStore.load falls back to the most recent workflow when persisted tabs were deleted', async () => {
  const latest = workflow('latest', 'Latest', '2026-06-22T18:00:00.000Z')
  const older = workflow('older', 'Older', '2026-06-22T17:00:00.000Z')
  writeTabSession({ version: WORKFLOW_TAB_SESSION_VERSION, openIds: ['deleted-a', 'deleted-b'], activeId: 'deleted-b' })
  listCalls.push([latest, older])

  await useWorkflowsStore.getState().load()

  const state = useWorkflowsStore.getState()
  assert.deepEqual(state.openIds, [latest.id])
  assert.equal(state.activeId, latest.id)
  assert.deepEqual(readTabSession(), {
    version: WORKFLOW_TAB_SESSION_VERSION,
    openIds: [latest.id],
    activeId: latest.id,
  })
})

test('workflowsStore.load ignores malformed persisted session and keeps default newest fallback', async () => {
  localStorage.setItem(WORKFLOW_TAB_SESSION_KEY, '{bad-json')
  const latest = workflow('latest', 'Latest', '2026-06-22T18:00:00.000Z')
  const older = workflow('older', 'Older', '2026-06-22T17:00:00.000Z')
  listCalls.push([latest, older])

  await useWorkflowsStore.getState().load()

  const state = useWorkflowsStore.getState()
  assert.deepEqual(state.openIds, [latest.id])
  assert.equal(state.activeId, latest.id)
})

test('workflowsStore.load repairs duplicate persisted ids and invalid active id', async () => {
  const first = workflow('first', 'First', '2026-06-22T18:00:00.000Z')
  const second = workflow('second', 'Second', '2026-06-22T17:00:00.000Z')
  writeTabSession({ version: WORKFLOW_TAB_SESSION_VERSION, openIds: [second.id, second.id, first.id], activeId: 'missing' })
  listCalls.push([first, second])

  await useWorkflowsStore.getState().load()

  const state = useWorkflowsStore.getState()
  assert.deepEqual(state.openIds, [second.id, first.id])
  assert.equal(state.activeId, second.id)
  assert.deepEqual(readTabSession(), {
    version: WORKFLOW_TAB_SESSION_VERSION,
    openIds: [second.id, first.id],
    activeId: second.id,
  })
})

test('workflowsStore.load preserves existing workflows when listing fails', async () => {
  const existing = workflow('existing-workflow', 'Existing Workflow', '2026-06-22T18:00:00.000Z')
  listError = new Error('list failed')

  useWorkflowsStore.setState({
    workflows: [existing],
    loading: false,
    activeId: existing.id,
    openIds: [existing.id],
    folders: [],
    folderColors: {},
    bookmarkedFolders: [],
  })

  await useWorkflowsStore.getState().load()

  const state = useWorkflowsStore.getState()
  assert.equal(state.loading, false)
  assert.deepEqual(state.workflows.map((item: Workflow) => item.id), [existing.id])
  assert.deepEqual(state.openIds, [existing.id])
  assert.equal(state.activeId, existing.id)
})

test('workflowsStore.load preserves legacy null handles instead of fabricating nonexistent aliases', async () => {
  listCalls.push([
    workflow('legacy-workflow', 'Legacy Workflow', '2026-06-22T18:00:00.000Z', undefined, {
      nodes: [
        { id: 'source', type: 'imageNode', position: { x: 0, y: 0 }, data: { enabled: true, params: {} } },
        { id: 'target', type: 'extensionNode', position: { x: 120, y: 0 }, data: { extensionId: 'ext/process', enabled: true, params: {} } },
      ],
      edges: [{ id: 'edge', source: 'source', target: 'target', sourceHandle: null, targetHandle: null }],
    }),
  ])

  await useWorkflowsStore.getState().load()

  const loaded = useWorkflowsStore.getState().workflows[0]
  assert.deepEqual(loaded.edges, [{ id: 'edge', source: 'source', target: 'target', sourceHandle: null, targetHandle: null }])
})

test('workflowsStore actions persist tab session mutations and reject activating closed ids', async () => {
  const imported = workflow('imported', 'Imported', '2026-06-22T19:00:00.000Z')
  importResult = { success: true, workflow: imported }

  useWorkflowsStore.setState({
    workflows: [workflow('first', 'First', '2026-06-22T18:00:00.000Z'), workflow('second', 'Second', '2026-06-22T17:00:00.000Z')],
    loading: false,
    activeId: 'first',
    openIds: ['first'],
    folders: [],
    folderColors: {},
    bookmarkedFolders: [],
  })
  writeTabSession({ version: WORKFLOW_TAB_SESSION_VERSION, openIds: ['first'], activeId: 'first' })

  useWorkflowsStore.getState().openWorkflow('second')
  assert.deepEqual(readTabSession(), {
    version: WORKFLOW_TAB_SESSION_VERSION,
    openIds: ['first', 'second'],
    activeId: 'second',
  })

  useWorkflowsStore.getState().moveOpenTab('second', 'first')
  assert.deepEqual(readTabSession(), {
    version: WORKFLOW_TAB_SESSION_VERSION,
    openIds: ['second', 'first'],
    activeId: 'second',
  })

  useWorkflowsStore.getState().setActive('first')
  assert.deepEqual(readTabSession(), {
    version: WORKFLOW_TAB_SESSION_VERSION,
    openIds: ['second', 'first'],
    activeId: 'first',
  })

  useWorkflowsStore.getState().closeWorkflow('second')
  assert.deepEqual(readTabSession(), {
    version: WORKFLOW_TAB_SESSION_VERSION,
    openIds: ['first'],
    activeId: 'first',
  })

  useWorkflowsStore.getState().setActive('second')
  assert.equal(useWorkflowsStore.getState().activeId, 'first')
  assert.deepEqual(readTabSession(), {
    version: WORKFLOW_TAB_SESSION_VERSION,
    openIds: ['first'],
    activeId: 'first',
  })

  await useWorkflowsStore.getState().importFile()
  assert.deepEqual(readTabSession(), {
    version: WORKFLOW_TAB_SESSION_VERSION,
    openIds: ['first', imported.id],
    activeId: imported.id,
  })

  await useWorkflowsStore.getState().remove(imported.id)
  assert.deepEqual(readTabSession(), {
    version: WORKFLOW_TAB_SESSION_VERSION,
    openIds: ['first'],
    activeId: 'first',
  })
})

test('workflowsStore.load strips obsolete workflow metadata safely', async () => {
  listCalls.push([
    workflow('stale-workflow-metadata', 'Stale Workflow Metadata', '2026-06-22T18:00:00.000Z', undefined, {
      nodes: [
        { id: 'model', type: 'extensionNode', position: { x: 120, y: 0 }, data: { extensionId: 'ext/model', [obsoleteWorkflowIoKey]: 'obsolete-contract', enabled: true, params: {} } },
      ],
      edges: [{ id: 'edge', source: 'model', target: 'model', sourceHandle: 'output', targetHandle: 'front', [obsoleteEdgeOrderKey]: 3 } as Workflow['edges'][number] & Record<string, unknown>],
    }),
  ])

  await useWorkflowsStore.getState().load()

  const loaded = useWorkflowsStore.getState().workflows[0]
  assert.deepEqual(loaded.nodes[0]?.data, { extensionId: 'ext/model', enabled: true, params: {} })
  assert.deepEqual(loaded.edges[0], { id: 'edge', source: 'model', target: 'model', sourceHandle: 'output', targetHandle: 'front' })
})

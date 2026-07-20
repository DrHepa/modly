import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import type { Workflow } from '@shared/types/electron.d'

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
          return { success: false }
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

beforeEach(() => {
  listCalls.length = 0
  listError = null
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

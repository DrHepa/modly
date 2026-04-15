import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function readWorkflowFile(relativePath: string): Promise<string> {
  return readFile(path.join(__dirname, relativePath), 'utf8')
}

test('runtime workflow entrypoints use workflowRunStore instead of useWorkflowRunner', async () => {
  const workflowsPageSource = await readWorkflowFile('WorkflowsPage.tsx')
  const workflowPanelSource = await readWorkflowFile('../generate/components/WorkflowPanel.tsx')
  const extensionNodeSource = await readWorkflowFile('nodes/ExtensionNode.tsx')
  const workflowRunStoreSource = await readWorkflowFile('workflowRunStore.ts')

  assert.match(workflowsPageSource, /from '\.\/workflowRunStore'/)
  assert.doesNotMatch(workflowsPageSource, /useWorkflowRunner/)

  assert.match(workflowPanelSource, /workflowRunStore/)
  assert.doesNotMatch(workflowPanelSource, /useWorkflowRunner/)

  assert.match(extensionNodeSource, /workflowRunStore/)
  assert.doesNotMatch(extensionNodeSource, /useWorkflowRunner/)

  assert.match(workflowRunStoreSource, /buildProcessExecutionInput/)
  assert.doesNotMatch(workflowRunStoreSource, /useWorkflowRunner/)
})

// Exercise the actual store's node executor with inert filesystem/HTTP adapters.
// In particular, this detects a cleanly applied historical patch in a loop-table
// construction block rather than the current executeExtensionNode owner.
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import type { Workflow, WFNode, WFEdge } from '../../shared/types/electron.d'
import type { WorkflowExtension } from './mockExtensions'

const storeBundle = (await build({
  entryPoints: [path.join(__dirname, 'workflowRunStore.ts')], bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'inert-store-adapters', setup(builder) {
    builder.onResolve({ filter: /^(axios|@shared\/stores\/appStore|@shared\/utils\/notification)$/ }, (args) => ({ path: args.path, namespace: 'inert' }))
    builder.onLoad({ filter: /.*/, namespace: 'inert' }, ({ path: id }) => ({ loader: 'ts', contents: id === 'axios'
      ? 'export default { create: () => globalThis.fixture.client }'
      : id.endsWith('appStore') ? 'export const useAppStore = { getState: () => globalThis.fixture.app }'
      : 'export const showCompletionNotification = () => {}; export const showErrorNotification = () => {}' }))
  } }],
})).outputFiles[0].text

function storeFixture(resultFor: (nodeId: string) => { filePath?: string; text?: string } = () => ({ filePath: '/workspace/result.glb' })) {
  const calls: { id: string; input: any; params: any }[] = []
  const fixture = {
    app: { apiUrl: 'http://inert.invalid', selectedImagePath: undefined, currentJob: null as any,
      setCurrentJob(value: any) { this.currentJob = value }, updateCurrentJob(value: any) { this.currentJob = { ...this.currentJob, ...value } } },
    client: { post: async () => { throw new Error('No HTTP allowed in process fixture') } },
  }
  const window = { electron: {
    settings: { get: async () => ({ workspaceDir: '/workspace' }) },
    fs: { deleteDirectory: async () => ({ success: true }), listFiles: async () => ['a.glb', 'b.glb'], readFileBase64: async () => { throw new Error('No image reads in process fixture') } },
    extensions: { runProcess: async (id: string, input: any, params: any) => {
      calls.push(JSON.parse(JSON.stringify({ id, input, params })))
      return { success: true, result: resultFor(input.nodeId) }
    } },
  } }
  const module = { exports: {} as any }
  vm.runInNewContext(storeBundle, { module, exports: module.exports, require: createRequire(import.meta.url), fixture, window, process, console, crypto, setTimeout, clearTimeout })
  return { store: module.exports.useWorkflowRunStore, calls, fixture }
}

function node(id: string, type: WFNode['type'], params: Record<string, unknown> = {}, extra: Partial<WFNode> = {}): WFNode {
  return { id, type, position: { x: 1000, y: 1000 }, data: { enabled: true, params, ...(type === 'extensionNode' ? { extensionId: `pack/${id}` } : {}) }, ...extra }
}
function extension(nodeId: string, inputs?: WorkflowExtension['inputs'], input = 'image', output = 'mesh'): WorkflowExtension {
  return { id: `pack/${nodeId}`, extensionId: 'pack', extensionName: 'Pack', extensionAuthor: '', nodeId, name: nodeId, description: '', input, inputs, output, params: [], builtin: false, type: 'process' }
}
function workflow(nodes: WFNode[], edges: WFEdge[]): Workflow {
  return { id: 'wf', name: 'Fixture', description: '', createdAt: '', updatedAt: '', nodes, edges }
}
function edge(source: string, target: string, targetHandle?: string): WFEdge { return { id: `${source}-${target}`, source, target, targetHandle } }

for (const reversed of [false, true]) {
  test(`actual store preserves named PROCESS binding independent of edge arrival (${reversed ? 'reversed' : 'forward'})`, async () => {
    const { store, calls } = storeFixture()
    const nodes = [node('front', 'imageNode', { filePath: '/front.png' }), node('mesh', 'meshNode', { filePath: '/mesh.glb' }), node('prompt', 'textNode', { text: 'make it blue' }), node('run', 'extensionNode')]
    const edges = [edge('front', 'run', 'reference'), edge('mesh', 'run', 'coarse'), edge('prompt', 'run', 'prompt')]
    await store.getState().run(workflow(nodes, reversed ? edges.reverse() : edges), [extension('run', [{ name: 'coarse', type: 'mesh' }, { name: 'reference', type: 'image' }, { name: 'optional', type: 'image', required: false }, { name: 'prompt', type: 'text' }])])
    assert.equal(store.getState().runState.status, 'done', store.getState().runState.error)
    assert.deepEqual(calls[0], { id: 'pack', input: { nodeId: 'run', inputs: {
      coarse: { type: 'mesh', filePath: '/mesh.glb', sourceNodeId: 'mesh' },
      reference: { type: 'image', filePath: '/front.png', sourceNodeId: 'front' },
      prompt: { type: 'text', text: 'make it blue', sourceNodeId: 'prompt' },
    } }, params: {} })
  })
  test(`actual store keeps positional gaps, all extra images, mesh precedence and text slots (${reversed ? 'reversed' : 'forward'})`, async () => {
    const { store, calls } = storeFixture()
    const nodes = [node('front', 'imageNode', { filePath: '/front.png' }), node('side', 'imageNode', { filePath: '/side.png' }), node('back', 'imageNode', { filePath: '/back.png' }), node('mesh', 'meshNode', { filePath: '/mesh.glb' }), node('prompt', 'textNode', { text: 'negative' }), node('run', 'extensionNode')]
    const edges = [edge('back', 'run', 'input-4'), edge('mesh', 'run', 'input-5'), edge('prompt', 'run', 'input-6'), edge('front', 'run', 'input-2'), edge('side', 'run', 'input-3')]
    await store.getState().run(workflow(nodes, reversed ? edges.reverse() : edges), [extension('run', ['image', 'text', 'image', 'image', 'image', 'mesh', 'text'])])
    assert.equal(store.getState().runState.status, 'done', store.getState().runState.error)
    assert.deepEqual(calls[0], { id: 'pack', input: { nodeId: 'run', filePath: '/mesh.glb', text: 'negative', texts: [null, null, null, null, null, null, 'negative'] }, params: { extra_image_paths: ['/front.png', '/side.png', '/back.png'] } })
  })
}

test('actual store preserves While repetitions and For Each with named input ports', async () => {
  const { store, calls } = storeFixture()
  const run = node('run', 'extensionNode', {}, { parentId: 'while' })
  const whileNode = node('while', 'whileNode', {}, { data: { enabled: true, params: {}, iterations: 2 }, position: { x: 0, y: 0 }, width: 420, height: 240 })
  const whileRun = store.getState().run(workflow([whileNode, node('mesh', 'meshNode', { filePath: '/mesh.glb' }), run], [edge('mesh', 'run', 'coarse')]), [extension('run', [{ name: 'coarse', type: 'mesh' }])])
  try {
    for (let i = 0; i < 100 && store.getState().runState.status !== 'paused'; i++) await new Promise((resolve) => setTimeout(resolve, 1))
    assert.equal(store.getState().runState.status, 'paused')
    assert.equal(calls.length, 2)
    store.getState().continueWhile()
    await whileRun
  } finally { if (store.getState().runState.status !== 'done') store.getState().cancel() }
  assert.equal(store.getState().runState.status, 'done', store.getState().runState.error)
  assert.equal(calls.length, 2)
  calls.length = 0
  await store.getState().run(workflow([node('iterator', 'forEachNode', { dir: '/meshes', mode: 'mesh' }), node('run', 'extensionNode')], [edge('iterator', 'run', 'coarse')]), [extension('run', [{ name: 'coarse', type: 'mesh' }])])
  assert.equal(store.getState().runState.status, 'done', store.getState().runState.error)
  assert.deepEqual(calls.map((call) => call.input.inputs.coarse), [
    { type: 'mesh', sourceNodeId: 'iterator', filePath: '/meshes/a.glb' },
    { type: 'mesh', sourceNodeId: 'iterator', filePath: '/meshes/b.glb' },
  ])
})

test('actual store keeps Wait source traversal and audio routing for named and positional nodes', async () => {
  const { store, calls } = storeFixture((id) => ({ filePath: id === 'audio' ? '/sound.wav' : '/workspace/result.glb' }))
  await store.getState().run(workflow([node('prompt', 'textNode', { text: 'sound' }), node('audio', 'extensionNode'), node('wait', 'waitNode'), node('named', 'extensionNode'), node('legacy', 'extensionNode')], [
    edge('prompt', 'audio'), edge('audio', 'wait'), edge('wait', 'named', 'sound'), edge('named', 'legacy', 'input-0'),
  ]), [extension('audio', undefined, 'text', 'audio'), extension('named', [{ name: 'sound', type: 'audio' }], 'audio', 'audio'), extension('legacy', ['audio', 'text'], 'audio')])
  assert.equal(calls.length, 1)
  assert.equal(store.getState().waitStates.wait, 'pending')
  await store.getState().continueRun('wait')
  assert.equal(store.getState().runState.status, 'done', store.getState().runState.error)
  assert.deepEqual(calls[1].input.inputs.sound, { type: 'audio', filePath: '/sound.wav', text: 'sound', sourceNodeId: 'audio' })
  assert.equal(calls[2].input.filePath, '/workspace/result.glb')
})

test('actual store rejects missing and duplicate required named bindings before IPC', async () => {
  for (const edges of [[], [edge('a', 'run', 'coarse'), edge('b', 'run', 'coarse')]]) {
    const { store, calls } = storeFixture()
    await store.getState().run(workflow([node('a', 'meshNode', { filePath: '/a.glb' }), node('b', 'meshNode', { filePath: '/b.glb' }), node('run', 'extensionNode')], edges), [extension('run', [{ name: 'coarse', type: 'mesh' }])])
    assert.equal(store.getState().runState.status, 'error')
    assert.match(store.getState().runState.error, /missing|multiple/)
    assert.equal(calls.length, 0)
  }
})

test('a required named port cannot use an inherited dictionary member as missing data', async () => {
  const { store, calls } = storeFixture()
  await store.getState().run(workflow([node('empty', 'imageNode'), node('mesh', 'meshNode', { filePath: '/mesh.glb' }), node('run', 'extensionNode')], [edge('empty', 'run', 'constructor'), edge('mesh', 'run', 'mesh')]), [extension('run', [{ name: 'constructor', type: 'image' }, { name: 'mesh', type: 'mesh' }])])
  assert.equal(store.getState().runState.status, 'error')
  assert.match(store.getState().runState.error, /constructor.*no input data/)
  assert.equal(calls.length, 0)
})

// Extract the actual palette and append callbacks, not a parallel routing model.
// The host controls/React state setters are inert: this is CPU callback coverage,
// not rendered React Flow or Electron interaction coverage.
import ts from 'typescript'
import * as connectionRules from './processConnectionRules.ts'
import { getProcessTargetPorts } from './processPorts.ts'

const pageSource = await readWorkflowFile('WorkflowsPage.tsx')
const pageAst = ts.createSourceFile('WorkflowsPage.tsx', pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const paletteOwners = new Map<string, string>()
function collectPaletteOwners(astNode: ts.Node): void {
  if (ts.isFunctionDeclaration(astNode) && astNode.name?.text === 'getNodeOutputType') paletteOwners.set(astNode.name.text, astNode.getText(pageAst))
  if (ts.isVariableDeclaration(astNode) && ['addNodeFromPalette', 'appendValidatedEdge'].includes(astNode.name.getText(pageAst))) {
    assert.ok(astNode.initializer && ts.isCallExpression(astNode.initializer))
    const callback = astNode.initializer.arguments[0]
    assert.ok(ts.isArrowFunction(callback))
    paletteOwners.set(astNode.name.getText(pageAst), callback.getText(pageAst))
  }
  ts.forEachChild(astNode, collectPaletteOwners)
}
collectPaletteOwners(pageAst)
assert.equal(paletteOwners.size, 3, 'The regression must execute the current palette and append owners')
const paletteCode = ts.transpileModule(`
${paletteOwners.get('getNodeOutputType')}
const appendValidatedEdge = ${paletteOwners.get('appendValidatedEdge')};
const callback = ${paletteOwners.get('addNodeFromPalette')};
return callback;
`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText

function invokePalette(sourceKind: string, reversed: boolean, targetInputs: WorkflowExtension['inputs']) {
  let nodes = sourceKind === 'waitNode'
    ? [node('mesh', 'meshNode'), node('source', 'waitNode'), node('unrelated', 'imageNode'), node('preview', 'imagePreviewNode')]
    : [node('source', sourceKind as WFNode['type'], sourceKind === 'forEachNode' ? { mode: 'mesh' } : {}), node('unrelated', 'imageNode'), node('preview', 'imagePreviewNode')]
  let edges = [edge('unrelated', 'preview'), ...(sourceKind === 'waitNode' ? [edge('mesh', 'source')] : [])]
  if (reversed) edges.reverse()
  let issue: connectionRules.ProcessConnectionRuleIssue | null = null
  const allExtensions = [extension('run', targetInputs)]
  const env = {
    screenToFlowPosition: (value: unknown) => value, pendingDropPos: { x: 0, y: 0 }, newId: () => 'new-target',
    isContainerType: () => false, findWhileContainerAt: () => undefined,
    nodes, edges, setNodes: (update: (current: WFNode[]) => WFNode[]) => { nodes = update(nodes) },
    setEdges: (update: (current: WFEdge[]) => WFEdge[]) => { edges = update(edges) },
    toWorkflowNodes: (value: WFNode[]) => value, toWorkflowEdges: (value: WFEdge[]) => value,
    pendingConnectionRef: { current: { nodeId: 'source', handleType: 'source', handleId: 'output' } },
    NODE_TYPES_WITHOUT_TARGET: new Set(['imageNode', 'meshNode', 'textNode', 'sceneNode', 'forEachNode']),
    NODE_TYPES_WITHOUT_SOURCE: new Set(['outputNode', 'previewNode']),
    allExtensions, getNode: (id: string) => nodes.find((candidate) => candidate.id === id),
    getProcessTargetPorts, ...connectionRules,
    setConnectionIssue: (value: connectionRules.ProcessConnectionRuleIssue | null) => { issue = value },
    addEdge: (connection: Omit<WFEdge, 'id'>, current: WFEdge[]) => [...current, { id: 'added', ...connection }],
    DEFAULT_EDGE_OPTS: {}, setPendingDropPos: () => {}, setPaletteOpen: () => {}, window: { innerWidth: 100, innerHeight: 100 },
  }
  const callback = new Function(...Object.keys(env), paletteCode)(...Object.values(env))
  callback('extensionNode', 'pack/run')
  return { nodes, addedEdge: edges.find((candidate) => candidate.target === 'new-target'), issue }
}

for (const sourceKind of ['meshNode', 'waitNode', 'forEachNode']) {
  for (const reversed of [false, true]) {
    test(`actual palette autowires ${sourceKind} to the compatible named mesh port (${reversed ? 'reversed' : 'forward'} edges)`, () => {
      const result = invokePalette(sourceKind, reversed, [{ name: 'reference', type: 'image', required: false }, { name: 'coarse', type: 'mesh' }])
      assert.equal(result.issue, null)
      assert.equal(result.addedEdge?.targetHandle, 'coarse')
      assert.equal(result.addedEdge?.source, 'source')
      assert.equal(result.addedEdge?.sourceHandle, 'output')
      assert.equal(result.nodes.filter((candidate) => candidate.id === 'new-target').length, 1)
    })
  }
}

test('actual palette preserves positional handles and unresolved-source first-port fallback', () => {
  const positional = invokePalette('meshNode', false, ['image', 'mesh'])
  assert.equal(positional.issue, null)
  assert.equal(positional.addedEdge?.targetHandle, 'input-1')
  const unresolved = invokePalette('unresolvedSource', false, [{ name: 'reference', type: 'image', required: false }, { name: 'coarse', type: 'mesh' }])
  assert.equal(unresolved.issue, null)
  assert.equal(unresolved.addedEdge?.targetHandle, 'reference')
})

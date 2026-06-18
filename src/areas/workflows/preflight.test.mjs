import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Bundle preflight.ts (and its real dependency mockExtensions.ts) into CJS.
// All @shared/* imports in those files are type-only, so esbuild erases them
// and no path-alias resolution is required.
function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-preflight-test-')), 'preflight.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('src/areas/workflows/preflight.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function ext(overrides = {}) {
  return {
    id: 'pack/process-node',
    extensionId: 'pack',
    extensionName: 'Pack',
    extensionAuthor: 'tester',
    nodeId: 'process-node',
    name: 'Process Node',
    description: '',
    input: 'image',
    output: 'mesh',
    params: [],
    builtin: false,
    type: 'process',
    ...overrides,
  }
}

function wf(nodes, edges = []) {
  return { id: 'wf', name: 'wf', description: '', nodes, edges, createdAt: '', updatedAt: '' }
}

const imageNode = (id = 'img') => ({ id, type: 'imageNode', position: { x: 0, y: 0 }, data: {} })
const textNode = (id = 'txt') => ({ id, type: 'textNode', position: { x: 0, y: 0 }, data: {} })

// ─── Tests ───────────────────────────────────────────────────────────────────

test('valid graph (image → extension expecting image) produces no issues', () => {
  const { validateWorkflowPreflight } = loadModule()
  const extensions = [ext()]
  const workflow = wf(
    [imageNode('img'), { id: 'proc', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node' } }],
    [{ id: 'e1', source: 'img', target: 'proc' }],
  )

  assert.deepEqual(validateWorkflowPreflight(workflow, extensions), [])
})

test('extension node with no matching incoming connection is flagged', () => {
  const { validateWorkflowPreflight } = loadModule()
  const extensions = [ext()]
  const workflow = wf(
    [{ id: 'proc', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node' } }],
    [],
  )

  const issues = validateWorkflowPreflight(workflow, extensions)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].key, 'proc:missing:image')
  assert.match(issues[0].message, /needs an incoming image connection/)
})

test('type mismatch on an incoming edge is flagged', () => {
  const { validateWorkflowPreflight } = loadModule()
  const extensions = [ext()] // expects image
  const workflow = wf(
    [textNode('txt'), { id: 'proc', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node' } }],
    [{ id: 'e1', source: 'txt', target: 'proc' }],
  )

  const issues = validateWorkflowPreflight(workflow, extensions)
  // missing required image input AND a text→image type mismatch
  assert.ok(issues.some((i) => i.key === 'proc:missing:image'))
  assert.ok(issues.some((i) => i.key === 'proc:type:e1' && /outputs text/.test(i.message)))
})

test('unknown extension id is reported as unavailable', () => {
  const { validateWorkflowPreflight } = loadModule()
  const workflow = wf(
    [{ id: 'proc', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'ghost/node' } }],
    [],
  )

  const issues = validateWorkflowPreflight(workflow, [])
  assert.equal(issues.length, 1)
  assert.equal(issues[0].key, 'proc:missing-extension')
  assert.match(issues[0].message, /unavailable/)
})

test('meshNode set to current scene flags when no mesh is loaded', () => {
  const { validateWorkflowPreflight } = loadModule()
  const workflow = wf([
    { id: 'mesh', type: 'meshNode', position: { x: 0, y: 0 }, data: { params: { source: 'current' } } },
  ])

  const without = validateWorkflowPreflight(workflow, [], { currentMeshUrl: null })
  assert.equal(without.length, 1)
  assert.equal(without[0].key, 'mesh:current-mesh')

  const withMesh = validateWorkflowPreflight(workflow, [], { currentMeshUrl: '/tmp/mesh.glb' })
  assert.deepEqual(withMesh, [])
})

test('multi-input extension requires every declared input type', () => {
  const { validateWorkflowPreflight } = loadModule()
  const extensions = [ext({ inputs: ['image', 'text'] })]
  const workflow = wf(
    [imageNode('img'), { id: 'proc', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node' } }],
    [{ id: 'e1', source: 'img', target: 'proc' }],
  )

  const issues = validateWorkflowPreflight(workflow, extensions)
  // image satisfied, text still missing
  assert.ok(!issues.some((i) => i.key === 'proc:missing:image'))
  assert.ok(issues.some((i) => i.key === 'proc:missing:text'))
})

test('scene input requires a validated Load Scene source and rejects image wiring', () => {
  const { validateWorkflowPreflight } = loadModule()
  const model = { id: 'model', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node' } }
  const scene = { id: 'scene', type: 'sceneNode', position: { x: 0, y: 0 }, data: { params: { manifestPath: 'Workflows/room/scene-manifest.json' } } }
  for (const output of ['scene', 'mesh']) {
    const extension = ext({ input: 'scene', output, type: 'model' })
    assert.deepEqual(validateWorkflowPreflight(wf([scene, model], [{ id: 'scene-edge', source: 'scene', target: 'model' }]), [extension]), [])
  }

  const extension = ext({ input: 'scene', output: 'scene', type: 'model' })
  const issues = validateWorkflowPreflight(wf([imageNode(), model], [{ id: 'image-edge', source: 'img', target: 'model' }]), [extension])
  assert.ok(issues.some((issue) => issue.key === 'model:missing:scene'))
  assert.ok(issues.some((issue) => issue.key === 'model:type:image-edge'))
})

test('Load Scene must be validated before a workflow can run', () => {
  const { validateWorkflowPreflight } = loadModule()
  const scene = { id: 'scene', type: 'sceneNode', position: { x: 0, y: 0 }, data: { params: { path: 'Workflows/room' } } }
  const issues = validateWorkflowPreflight(wf([scene], []), [])
  assert.equal(issues[0].key, 'scene:scene-invalid')
})

test('renderer admits PROCESS scene while retaining mixed MODEL scene rejection', () => {
  const { validateWorkflowPreflight } = loadModule()
  const scene = { id: 'scene', type: 'sceneNode', position: { x: 0, y: 0 }, data: { params: { manifestPath: 'Workflows/room/scene-manifest.json' } } }
  const target = { id: 'target', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node' } }
  for (const extension of [
    ext({ input: 'scene', output: 'mesh', type: 'process' }),
    ext({ input: 'scene', inputs: ['scene', 'text'], output: 'mesh', type: 'model' }),
  ]) {
    const issues = validateWorkflowPreflight(wf([scene, target], [{ id: 'e', source: 'scene', target: 'target' }]), [extension])
    if (extension.type === 'model') assert.ok(issues.some((issue) => issue.key === 'target:unsupported-scene-shape'))
    else assert.deepEqual(issues, [])
  }
})

test('text-only MODEL preflight accepts hydrated prompt without an image or text edge', { timeout: 2000 }, () => {
  const { validateWorkflowPreflight } = loadModule()
  const capability = ext({ type: 'model', input: 'text', params: [{ id: 'prompt', type: 'string', default: 'default prompt' }] })
  const workflow = { nodes: [{ id: 'model', type: 'extensionNode', data: { extensionId: capability.id, enabled: true, params: {} } }], edges: [] }
  assert.deepEqual(validateWorkflowPreflight(workflow, [capability]), [])
  workflow.nodes[0].data.params = { prompt: '' }
  assert.equal(validateWorkflowPreflight(workflow, [capability]).length, 1, 'explicit empty prompt does not inherit default')
  workflow.nodes[0].data.params = { prompt: '   ' }
  assert.equal(validateWorkflowPreflight(workflow, [capability]).length, 1)
})

test('prompt fallback never replaces PROCESS or mixed MODEL input contracts', { timeout: 2000 }, () => {
  const { validateWorkflowPreflight } = loadModule()
  for (const overrides of [{ type: 'process', input: 'text' }, { type: 'model', input: 'image', inputs: ['image', 'text'] }, { type: 'model', input: 'text', inputs: ['text', 'text'] }]) {
    const capability = ext({ ...overrides, params: [{ id: 'prompt', type: 'string', default: 'default prompt' }] })
    const workflow = { nodes: [{ id: 'model', type: 'extensionNode', data: { extensionId: capability.id, enabled: true, params: {} } }], edges: [] }
    assert.ok(validateWorkflowPreflight(workflow, [capability]).length > 0)
  }
})

test('single text slot uses the text alias but explicit empty prompt takes precedence', { timeout: 2000 }, () => {
  const { validateWorkflowPreflight } = loadModule()
  const capability = ext({ type: 'model', input: 'text', inputs: ['text'], params: [{ id: 'text', type: 'string', default: 'alias default' }] })
  const workflow = { nodes: [{ id: 'model', type: 'extensionNode', data: { extensionId: capability.id, enabled: true, params: {} } }], edges: [] }
  assert.deepEqual(validateWorkflowPreflight(workflow, [capability]), [])
  workflow.nodes[0].data.params = { prompt: '' }
  assert.equal(validateWorkflowPreflight(workflow, [capability]).length, 1)
})

test('scene positional preflight checks each physical slot instead of a set of kinds', () => {
  const { validateWorkflowPreflight } = loadModule()
  const scene = (id) => ({ id, type: 'sceneNode', position: { x: 0, y: 0 }, data: { params: { path: `${id}/scene-manifest.json`, manifestPath: `${id}/scene-manifest.json`, sceneRoot: '.' } } })
  const target = { id: 'proc', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node' } }
  const nodes = [scene('a'), textNode('t'), scene('b'), target]
  const extensions = [ext({ input: 'scene', inputs: ['scene', 'text', 'scene'], output: 'scene' })]
  const edges = [
    { id: 'a', source: 'a', target: 'proc', targetHandle: 'input-0' },
    { id: 't', source: 't', target: 'proc', targetHandle: 'input-1' },
    { id: 'b', source: 'b', target: 'proc', targetHandle: 'input-2' },
  ]
  assert.deepEqual(validateWorkflowPreflight(wf(nodes, edges), extensions), [])
  assert.ok(validateWorkflowPreflight(wf(nodes, edges.slice(0, 2)), extensions).some((issue) => /input-2/.test(issue.message)))
  const swapped = edges.map((edge) => ({ ...edge, targetHandle: edge.id === 't' ? 'input-2' : edge.id === 'b' ? 'input-1' : edge.targetHandle }))
  assert.ok(validateWorkflowPreflight(wf(nodes, swapped), extensions).some((issue) => /expects/.test(issue.message)))
})

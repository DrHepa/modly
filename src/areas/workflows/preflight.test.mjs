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
const captureNode = (id = 'cap') => ({ id, type: 'captureNode', position: { x: 0, y: 0 }, data: { params: { path: 'Captures/room' } } })

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

test('scene model requires Load Scene output rather than an image', () => {
  const { validateWorkflowPreflight } = loadModule()
  const extensions = [ext({ input: 'scene', type: 'model' })]
  const model = { id: 'model', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node' } }
  const scene = { id: 'scene', type: 'sceneNode', position: { x: 0, y: 0 }, data: { params: { path: 'Worlds/room' } } }
  assert.deepEqual(validateWorkflowPreflight(wf([scene, model], [{ id: 'e1', source: 'scene', target: 'model' }]), extensions), [])
  const issues = validateWorkflowPreflight(wf([imageNode(), model], [{ id: 'e2', source: 'img', target: 'model' }]), extensions)
  assert.ok(issues.some((issue) => issue.key === 'model:missing:scene'))
})

test('scene process input is rejected even with a matching scene connection', () => {
  const { validateWorkflowPreflight } = loadModule()
  const extensions = [ext({ input: 'scene', type: 'process' })]
  const scene = { id: 'scene', type: 'sceneNode', position: { x: 0, y: 0 }, data: { params: { path: 'Worlds/room' } } }
  const process = { id: 'proc', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node' } }
  const issues = validateWorkflowPreflight(wf([scene, process], [{ id: 'e1', source: 'scene', target: 'proc' }]), extensions)
  assert.ok(issues.some((issue) => issue.key === 'proc:unsupported:scene-process' && /cannot receive scenes/.test(issue.message)))
})

test('scene model rejects secondary image or mesh artifacts instead of silently dropping them', () => {
  const { validateWorkflowPreflight } = loadModule()
  const model = { id: 'model', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node' } }
  const scene = { id: 'scene', type: 'sceneNode', position: { x: 0, y: 0 }, data: { params: { path: 'Worlds/room' } } }
  for (const secondary of ['image', 'mesh']) {
    const extensions = [ext({ input: 'scene', inputs: ['scene', secondary], type: 'model' })]
    const issues = validateWorkflowPreflight(wf([scene, model], [{ id: 'e1', source: 'scene', target: 'model' }]), extensions)
    assert.ok(issues.some((issue) => issue.key === 'model:unsupported:scene-model-inputs' && /not image or mesh/.test(issue.message)))
  }
  const extensions = [ext({ input: 'scene', inputs: ['scene', 'text'], type: 'model' })]
  const issues = validateWorkflowPreflight(wf([scene, textNode(), model], [
    { id: 'e1', source: 'scene', target: 'model' },
    { id: 'e2', source: 'txt', target: 'model' },
  ]), extensions)
  assert.deepEqual(issues, [])
})

test('capture model accepts only Load Capture plus optional text', () => {
  const { validateWorkflowPreflight } = loadModule()
  const model = { id: 'model', type: 'extensionNode', position: { x: 0, y: 0 }, data: { extensionId: 'pack/process-node' } }
  const extensions = [ext({ input: 'capture', inputs: ['capture', 'text'], type: 'model' })]
  assert.deepEqual(validateWorkflowPreflight(wf([captureNode(), textNode(), model], [
    { id: 'e1', source: 'cap', target: 'model', targetHandle: 'input-0' },
    { id: 'e2', source: 'txt', target: 'model', targetHandle: 'input-1' },
  ]), extensions), [])
  const issues = validateWorkflowPreflight(wf([imageNode(), model], [{ id: 'bad', source: 'img', target: 'model' }]), extensions)
  assert.ok(issues.some((issue) => issue.key === 'model:missing:capture'))
})

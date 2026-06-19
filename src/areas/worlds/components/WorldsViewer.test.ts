import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import React, { createElement } from 'react'
import * as THREE from 'three'

import { build } from 'esbuild'

import type { WorldSceneItem } from '../worldRenderableResolver.ts'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const worldsRoot = path.join(projectRoot, 'src/areas/worlds')
const viewerEntry = path.join(projectRoot, 'src/areas/worlds/components/WorldsViewer.tsx')
const meshFixture = path.join(projectRoot, 'src/areas/worlds/__fixtures__/colored-mesh.ply')
const pointsFixture = path.join(projectRoot, 'src/areas/worlds/__fixtures__/colored-points.ply')

async function loadViewerModule() {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'modly-worlds-viewer-test-'))
  const outfile = path.join(tempDir, 'WorldsViewer.bundle.mjs')
  const result = await build({
    entryPoints: [viewerEntry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    plugins: [{ name: 'cpu-rendering-boundary', setup(api) {
      api.onResolve({ filter: /^@react-three\/(fiber|drei)$/ }, args => ({ path: args.path, namespace: 'cpu' }))
      api.onLoad({ filter: /.*/, namespace: 'cpu' }, () => ({ loader: 'tsx', contents: `
        export const Canvas = ({children}) => children
        export const Bounds = Canvas, Html = Canvas, GizmoHelper = Canvas
        export const GizmoViewport = () => null, OrbitControls = () => null
        export const useGLTF = url => globalThis.__worldsGltf(url)
      ` }))
      api.onResolve({ filter: /^(react(?:\/.*)?|three(?:\/.*)?)$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }))
    } }],
  })
  const source = result.outputFiles[0].text
  await writeFile(outfile, source)
  return {
    source,
    module: await import(pathToFileURL(outfile).href),
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

test('PLY render topology comes from the loaded bytes, not stale item metadata', async () => {
  const { module, cleanup } = await loadViewerModule()
  try {
    const points = await readFile(pointsFixture)
    const mesh = await readFile(meshFixture)
    for (const [bytes, hint, primitive] of [[points, 'ply-mesh', 'points'], [mesh, 'ply-points', 'mesh']] as const) {
      const model = module.createPlyRenderModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), item(hint, 'same.ply'))
      try { assert.equal(model.primitive, primitive) } finally { model.geometry.dispose() }
    }
    for (const properties of ['property uchar red\nproperty uchar green\nproperty uchar blue', 'property list uchar float texcoord']) {
      const body = properties.includes('texcoord') ? '3 0 1 2 6 0 0 1 0 0 1' : '3 0 1 2 255 0 0'
      const text = `ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\n${properties}\nend_header\n0 0 0\n1 0 0\n0 1 0\n${body}\n`
      const model = module.createPlyRenderModel(new TextEncoder().encode(text).buffer, item('ply-points', 'stale.ply'))
      try { assert.equal(model.geometry.index, null); assert.equal(model.primitive, 'mesh') } finally { model.geometry.dispose() }
    }
  } finally { await cleanup() }
})

test('PLY viewer refuses ineligible bytes instead of guessing a render primitive', async () => {
  const { module, cleanup } = await loadViewerModule()
  try {
    for (const text of ['not ply\n', 'ply\nformat ascii 1.0\nelement vertex 0\nproperty float x\nproperty float y\nproperty float z\nproperty float f_dc_0\nproperty float scale_0\nproperty float rot_0\nend_header\n']) {
      assert.throws(() => module.createPlyRenderModel(new TextEncoder().encode(text).buffer, item('ply-mesh', 'untrusted.ply')), /PLY.*(header|Gaussian|unsupported)/i)
    }
  } finally { await cleanup() }
})

test('PLY viewer keeps supported newline combinations and rejects binary offset mismatches', async () => {
  const { module, cleanup } = await loadViewerModule()
  try {
    for (const format of ['ascii', 'binary_little_endian', 'binary_big_endian']) {
      for (const magic of ['\n', '\r', '\r\n']) for (const interior of ['\n', '\r', '\r\n']) for (const end of ['\n', '\r', '\r\n']) {
        const header = `ply${magic}${['format '+format+' 1.0', '', 'element vertex 1', 'property float x', 'property float y', 'property float z', 'end_header'].join(interior)}${end}`
        const bytes = Buffer.concat([Buffer.from(header), format === 'ascii' ? Buffer.from('1 2 3\n') : (() => { const b = Buffer.alloc(12); [1,2,3].forEach((x,i) => format === 'binary_little_endian' ? b.writeFloatLE(x,i*4) : b.writeFloatBE(x,i*4)); return b })()])
        const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        if (format !== 'ascii' && (magic === '\r\n') !== (end === '\r\n')) {
          assert.throws(() => module.createPlyRenderModel(source, item('ply-points', 'offset.ply')), /PLY.*header/i)
        } else {
          const model = module.createPlyRenderModel(source, item('ply-mesh', 'valid.ply'))
          try { assert.equal(model.primitive, 'points'); assert.equal(model.geometry.getAttribute('position').count, 1); assert.ok(model.geometry.getAttribute('position').array.every(Number.isFinite)) } finally { model.geometry.dispose() }
        }
      }
    }
  } finally { await cleanup() }
})

function item(kind: WorldSceneItem['kind'], url: string): WorldSceneItem {
  return {
    id: `world:${url}`,
    workspacePath: url,
    url,
    kind,
    visible: true,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  }
}

test('WorldsViewer parses vertex-color indexed PLY as a mesh render model', async () => {
  const { module, cleanup } = await loadViewerModule()
  const bytes = await readFile(meshFixture)

  try {
    const model = module.createPlyRenderModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), item('ply-mesh', 'mesh.ply'))

    assert.deepEqual(
      {
        primitive: model.primitive,
        hasVertexColors: model.hasVertexColors,
        material: model.material,
        viewerNormalization: model.viewerNormalization,
        vertexCount: model.geometry.getAttribute('position').count,
        indexCount: model.geometry.index?.count,
        minY: model.geometry.boundingBox?.min.y,
        centerX: ((model.geometry.boundingBox?.min.x ?? 0) + (model.geometry.boundingBox?.max.x ?? 0)) / 2,
        centerZ: ((model.geometry.boundingBox?.min.z ?? 0) + (model.geometry.boundingBox?.max.z ?? 0)) / 2,
      },
      {
        primitive: 'mesh',
        hasVertexColors: true,
        material: 'standard-vertex-color',
        viewerNormalization: 'hy-world-z-up-to-y-up-floor-centered',
        vertexCount: 3,
        indexCount: 3,
        minY: 0,
        centerX: 0,
        centerZ: 0,
      },
    )
  } finally {
    await cleanup()
  }
})

test('WorldsViewer parses vertex-color non-indexed PLY as a points render model', async () => {
  const { module, cleanup } = await loadViewerModule()
  const bytes = await readFile(pointsFixture)

  try {
    const model = module.createPlyRenderModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), item('ply-points', 'points.ply'))

    assert.deepEqual(
      {
        primitive: model.primitive,
        hasVertexColors: model.hasVertexColors,
        material: model.material,
        pointSize: model.pointSize,
        viewerNormalization: model.viewerNormalization,
        vertexCount: model.geometry.getAttribute('position').count,
        indexCount: model.geometry.index?.count ?? 0,
        minY: model.geometry.boundingBox?.min.y,
      },
      {
        primitive: 'points',
        hasVertexColors: true,
        material: 'points-vertex-color',
        pointSize: 0.025,
        viewerNormalization: 'hy-world-z-up-to-y-up-floor-centered',
        vertexCount: 3,
        indexCount: 0,
        minY: 0,
      },
    )
  } finally {
    await cleanup()
  }
})

test('WorldsViewer exposes canvas controls and unsupported states without importing Generate Viewer3D', async () => {
  const { source, module, cleanup } = await loadViewerModule()

  try {
    assert.equal(source.includes('components/Viewer3D'), false)
    assert.equal(source.includes('Viewer3D'), false)
    assert.equal(source.includes('Open a workflow world or renderable PLY/GLB asset.'), false)
    assert.deepEqual(module.WORLD_VIEWER_ORBIT_CONTROLS, {
      enablePan: true,
      enableZoom: true,
      enableRotate: true,
      screenSpacePanning: true,
      minPolarAngle: 0,
      maxPolarAngle: Math.PI,
      minDistance: 0.05,
      maxDistance: 500,
      zoomSpeed: 1.25,
      panSpeed: 1.2,
      rotateSpeed: 0.75,
    })
    assert.deepEqual(module.describeWorldsViewerScene([item('ply-mesh', 'mesh.ply')]), {
      hasRenderableItems: true,
      hasGrid: true,
      hasOrbitControls: true,
      hasGizmo: true,
      unsupported: [],
      renderTargets: [
        {
          workspacePath: 'mesh.ply',
          kind: 'ply-mesh',
          loader: 'ply',
          primitive: 'mesh',
          cameraFit: 'bounds',
          visibleDescription: 'PLY mesh geometry',
        },
      ],
    })
    assert.deepEqual(module.describeWorldsViewerScene([{ ...item('ply-mesh', 'mesh.ply'), visible: false }]), {
      hasRenderableItems: false,
      hasGrid: true,
      hasOrbitControls: true,
      hasGizmo: true,
      unsupported: [],
      renderTargets: [],
    })
  } finally {
    await cleanup()
  }
})

test('WorldsViewer routes GLB and GLTF scene items through the GLTF render target with visible controls', async () => {
  const { module, cleanup } = await loadViewerModule()

  try {
    const glbItem = item('glb', 'workflows/world.glb')
    const gltfItem = item('gltf', 'workflows/world.gltf')

    assert.deepEqual(module.getWorldSceneItemRenderTarget(glbItem), {
      workspacePath: 'workflows/world.glb',
      kind: 'glb',
      loader: 'gltf',
      primitive: 'scene',
      cameraFit: 'bounds',
      visibleDescription: 'GLB/GLTF model scene',
    })
    assert.deepEqual(module.getWorldSceneItemRenderTarget(gltfItem), {
      workspacePath: 'workflows/world.gltf',
      kind: 'gltf',
      loader: 'gltf',
      primitive: 'scene',
      cameraFit: 'bounds',
      visibleDescription: 'GLB/GLTF model scene',
    })
    assert.deepEqual(module.describeWorldsViewerScene([glbItem, gltfItem]), {
      hasRenderableItems: true,
      hasGrid: true,
      hasOrbitControls: true,
      hasGizmo: true,
      unsupported: [],
      renderTargets: [
        {
          workspacePath: 'workflows/world.glb',
          kind: 'glb',
          loader: 'gltf',
          primitive: 'scene',
          cameraFit: 'bounds',
          visibleDescription: 'GLB/GLTF model scene',
        },
        {
          workspacePath: 'workflows/world.gltf',
          kind: 'gltf',
          loader: 'gltf',
          primitive: 'scene',
          cameraFit: 'bounds',
          visibleDescription: 'GLB/GLTF model scene',
        },
      ],
    })
  } finally {
    await cleanup()
  }
})

test('production Worlds modules keep a static boundary from Generate Viewer3D implementations', async () => {
  const productionFiles = await listProductionWorldsFiles(worldsRoot)
  assert.ok(productionFiles.length > 0, 'expected production Worlds files to be scanned')

  const forbiddenPatterns = [
    /src\/areas\/generate\/components\/Viewer3D/i,
    /@areas\/generate\/components\/Viewer3D/i,
    /\.\.\/\.\.\/generate\/components\/Viewer3D/i,
    /generate\/components\/Viewer3D/i,
  ]

  for (const filePath of productionFiles) {
    const source = await readFile(filePath, 'utf8')
    for (const pattern of forbiddenPatterns) {
      assert.equal(pattern.test(source), false, `${path.relative(projectRoot, filePath)} must not import or reference Generate Viewer3D`)
    }
  }
})

async function listProductionWorldsFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__fixtures__') return []
        return listProductionWorldsFiles(entryPath)
      }
      if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) return []
      return [entryPath]
    }),
  )
  return files.flat()
}
// Real React lifecycle on a CPU mutation host; the canvas alone is substituted.
type Host = { type: string; props: any; children: Host[] }
function cpuHost() {
  const reconcilerPath = fileURLToPath(import.meta.resolve('react-reconciler'))
  assert.equal(reconcilerPath, path.join(projectRoot, 'node_modules/react-reconciler/index.js'))
  const require = createRequire(reconcilerPath)
  assert.equal(require('react'), React)
  const context = {}
  const remove = (p: Host, c: Host) => { const i = p.children.indexOf(c); if (i >= 0) p.children.splice(i, 1) }
  const append = (p: Host, c: Host) => { remove(p, c); p.children.push(c) }
  const insert = (p: Host, c: Host, b: Host) => { remove(p, c); p.children.splice(p.children.indexOf(b), 0, c) }
  const renderer = require(reconcilerPath)({
    now: Date.now, supportsMutation: true, isPrimaryRenderer: false,
    getRootHostContext: () => context, getChildHostContext: () => context, getPublicInstance: (x: Host) => x,
    prepareForCommit: () => null, resetAfterCommit: () => undefined,
    createInstance: (type: string, props: any) => ({ type, props, children: [] }),
    createTextInstance: (text: string) => ({ type: '#text', props: { text }, children: [] }),
    appendInitialChild: append, appendChild: append, appendChildToContainer: append,
    removeChild: remove, removeChildFromContainer: remove, insertBefore: insert, insertInContainerBefore: insert,
    finalizeInitialChildren: () => false, shouldSetTextContent: () => false, prepareUpdate: () => true,
    commitUpdate: (x: Host, _p: unknown, _t: string, _old: unknown, props: any) => { x.props = props },
    commitTextUpdate: (x: Host, _old: string, text: string) => { x.props.text = text },
    clearContainer: (x: Host) => { x.children = [] }, detachDeletedInstance: () => undefined,
    scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1,
  })
  const host: Host = { type: 'root', props: {}, children: [] }
  const root = renderer.createContainer(host, 0, null, false, null, '', (e: unknown) => { throw e }, null)
  const flush = (fn = () => {}) => { renderer.flushSync(fn); for (let i = 0; i < 12; i++) { if (!renderer.flushPassiveEffects()) return; renderer.flushSync(() => {}) } assert.fail('Effects did not settle') }
  const render = (node: ReturnType<typeof createElement> | null) => flush(() => renderer.updateContainer(node, root, null))
  const settle = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); flush() } }
  function find(predicate: (n: Host) => boolean, node = host): Host | undefined { if (predicate(node)) return node; for (const child of node.children) { const found = find(predicate, child); if (found) return found } }
  const text = (n: Host): string => n.type === '#text' ? n.props.text : n.children.map(text).join('')
  const button = (label: string) => { const n = find(n => n.type === 'button' && (n.props['aria-label'] === label || text(n) === label)); assert.ok(n, label); return n }
  return { render, flush, settle, find, button, click: (label: string) => { const n = button(label); assert.ok(!n.props.disabled, label); flush(() => n.props.onClick()) } }
}

test('mounted PLY fetch ignores transforms, cancels replaced loads and disposes only owned geometry', async () => {
  const { module, cleanup } = await loadViewerModule()
  const cpu = cpuHost(), previousFetch = globalThis.fetch
  const requests: Array<{ signal: AbortSignal; resolve: (r: Response) => void }> = []
  const bytes = await readFile(pointsFixture)
  globalThis.fetch = ((_url: unknown, init: RequestInit) => new Promise<Response>(resolve => requests.push({ signal: init.signal as AbortSignal, resolve }))) as typeof fetch
  const render = (value: WorldSceneItem) => cpu.render(createElement(module.WorldsViewer, { items: [value] }))
  try {
    const first = item('ply-mesh', 'blob:first'); render(first)
    render({ ...first, transform: { ...first.transform, position: [9, 0, 0] } })
    assert.equal(requests.length, 1, 'transform-only edit must not fetch or parse again')
    render({ ...first, url: 'https://example.invalid/replacement.ply' })
    assert.equal(requests[0].signal.aborted, true)
    requests[0].resolve(new Response(bytes)); await cpu.settle()
    assert.equal(cpu.find(n => n.type === 'points'), undefined)
    requests[1].resolve(new Response(bytes)); await cpu.settle()
    const node = cpu.find(n => n.type === 'points'); assert.ok(node)
    const geometry = node.props.geometry as THREE.BufferGeometry
    let disposed = 0; geometry.addEventListener('dispose', () => disposed++)
    render({ ...first, url: 'https://example.invalid/next.ply' })
    assert.equal(disposed, 1, 'replacement disposes exactly the old owned buffer')
    requests[2].resolve(new Response('failure', { status: 404 })); await cpu.settle()
    assert.ok(cpu.find(n => n.props.role === 'status'))
    render({ ...first, url: 'blob:recovered' }); requests[3].resolve(new Response(bytes)); await cpu.settle()
    const recovered = cpu.find(n => n.type === 'points'); assert.ok(recovered)
    let recoveredDisposed = 0; recovered.props.geometry.addEventListener('dispose', () => recoveredDisposed++)
    cpu.render(null); assert.equal(recoveredDisposed, 1); assert.equal(disposed, 1)
  } finally { cpu.render(null); globalThis.fetch = previousFetch; await cleanup() }
})

test('mounted GLTF instances do not share scene parents and errors recover when the URL changes', async () => {
  const { module, cleanup } = await loadViewerModule()
  const cpu = cpuHost(), scene = new THREE.Group()
  const globals = globalThis as typeof globalThis & { __worldsGltf?: (url: string) => { scene: THREE.Group } }
  const previous = globals.__worldsGltf
  globals.__worldsGltf = url => { if (url === 'bad.glb') throw new Error('Expected GLTF load error'); return { scene } }
  try {
    const a = item('glb', 'same.glb'), b = { ...a, id: 'second' }
    cpu.render(createElement(module.WorldsViewer, { items: [a, b] }))
    const one = cpu.find(n => n.type === 'primitive'); assert.ok(one)
    const two = cpu.find(n => n.type === 'primitive' && n !== one); assert.ok(two)
    assert.notEqual(one.props.object, two.props.object); assert.notEqual(one.props.object, scene)
    cpu.render(createElement(module.WorldsViewer, { items: [{ ...a, url: 'bad.glb' }] }))
    assert.ok(cpu.find(n => n.props.role === 'status'))
    cpu.render(createElement(module.WorldsViewer, { items: [{ ...a, url: 'good.glb' }] }))
    assert.ok(cpu.find(n => n.type === 'primitive'), 'changed URL resets the item error boundary')
  } finally { cpu.render(null); globals.__worldsGltf = previous; await cleanup() }
})

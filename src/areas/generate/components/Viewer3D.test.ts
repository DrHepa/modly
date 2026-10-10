import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build, type Plugin } from 'esbuild'
import * as THREE from 'three'
import { createMotionRetargetSession, type CreateMotionRetargetSessionInput } from '../motionRetargetPlan.ts'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const viewer3DEntry = path.join(projectRoot, 'src/areas/generate/components/Viewer3D.tsx')
const dreamCubeRegressionGlbPath = '/home/drhepa/Documentos/Modly/workspace/Workflows/dreamcube-20260718-173840-d973837e/output_mesh.glb'

function aliasPlugin(): Plugin {
  const resolvePath = (basePath: string): string => {
    if (existsSync(basePath) && statSync(basePath).isFile()) return basePath
    for (const extension of ['.ts', '.tsx', '.js', '.jsx']) {
      const candidate = `${basePath}${extension}`
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    }
    if (existsSync(basePath) && statSync(basePath).isDirectory()) {
      for (const extension of ['.ts', '.tsx', '.js', '.jsx']) {
        const candidate = path.join(basePath, `index${extension}`)
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
      }
    }
    return basePath
  }

  return {
    name: 'modly-aliases',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^@shared\// }, (args) => ({
        path: resolvePath(path.join(projectRoot, 'src/shared', args.path.slice('@shared/'.length))),
      }))
      buildApi.onResolve({ filter: /^@areas\// }, (args) => ({
        path: resolvePath(path.join(projectRoot, 'src/areas', args.path.slice('@areas/'.length))),
      }))
      buildApi.onResolve({ filter: /^@\// }, (args) => ({
        path: resolvePath(path.join(projectRoot, 'src', args.path.slice('@/'.length))),
      }))
    },
  }
}

async function loadViewer3DModule() {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'modly-viewer3d-'))
  const outfile = path.join(tempDir, 'Viewer3D.bundle.mjs')

  try {
    await build({
      entryPoints: [viewer3DEntry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
      plugins: [{ name: 'pure-host-boundary', setup(api) {
        api.onResolve({ filter: /^@react-three\/(fiber|drei|postprocessing)$/ }, () => ({ path: 'renderer', namespace: 'inert' }))
        api.onLoad({ filter: /^renderer$/, namespace: 'inert' }, () => ({ contents: `
          const unavailable = () => { throw new Error('Renderer invoked in pure-helper lane') }
          export const Canvas = unavailable, useFrame = unavailable, useLoader = unavailable, useThree = unavailable,
            Environment = unavailable, GizmoHelper = unavailable, Html = unavailable, Lightformer = unavailable,
            OrbitControls = unavailable, useGizmoContext = unavailable, useGLTF = unavailable,
            EffectComposer = unavailable, Outline = unavailable, Select = unavailable, Selection = unavailable;
        `, loader: 'js' }))
        api.onResolve({ filter: /^(?:@shared\/hooks\/useGeneration|\.\.\/\.\.\/workflows\/workflowRunStore|\.\/SplatViewer)$/ }, args => ({ path: args.path, namespace: 'inert' }))
        api.onLoad({ filter: /.*/, namespace: 'inert' }, () => ({ contents: 'const unavailable = () => { throw new Error("Host invoked in pure-helper lane") }; export const useGeneration = unavailable, useWorkflowRunStore = unavailable; export default unavailable', loader: 'js' }))
        api.onResolve({ filter: /^three-mesh-bvh$/ }, () => ({ path: fileURLToPath(import.meta.resolve('three-mesh-bvh')) }))
        api.onResolve({ filter: /^three$/ }, () => ({ path: fileURLToPath(import.meta.resolve('three')), external: true }))
      } }, aliasPlugin(), { name: 'canonical-dependencies', setup(api) {
        api.onResolve({ filter: /^(react(?:\/.*)?|react-dom(?:\/.*)?|three\/.*|zustand(?:\/.*)?|@xyflow\/react|axios)$/ }, args => ({ path: require.resolve(args.path), external: true }))
      } }],
      packages: 'external',
      external: [
        '@react-three/fiber',
        '@react-three/drei',
        '@xyflow/react',
        'axios',
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        'three',
        'zustand',
      ],
    })

    const module = await import(pathToFileURL(outfile).href)

    return {
      module,
      async cleanup() {
        await rm(tempDir, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true })
    throw error
  }
}

test('Viewer3D scene stats count point vertices without triangles and preserve mesh triangle counts', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const scene = new THREE.Scene()

    const pointGeometry = new THREE.BufferGeometry()
    pointGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ], 3))
    scene.add(new THREE.Points(pointGeometry, new THREE.PointsMaterial()))

    const indexedMeshGeometry = new THREE.BufferGeometry()
    indexedMeshGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0,
      1, 0, 0,
      1, 1, 0,
      0, 1, 0,
    ], 3))
    indexedMeshGeometry.setIndex([0, 1, 2, 0, 2, 3])
    scene.add(new THREE.Mesh(indexedMeshGeometry, new THREE.MeshBasicMaterial()))

    const nonIndexedMeshGeometry = new THREE.BufferGeometry()
    nonIndexedMeshGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      1, 0, 0,
      1, 1, 0,
      0, 1, 0,
    ], 3))
    scene.add(new THREE.Mesh(nonIndexedMeshGeometry, new THREE.MeshBasicMaterial()))

    assert.deepEqual(module.collectViewer3DSceneStats(scene), {
      vertices: 14,
      triangles: 4,
    })
  } finally {
    await cleanup()
  }
})

test('Viewer3D clones loaded scenes and disposes only owned instance materials', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const sourceMaterial = new THREE.MeshStandardMaterial({ color: '#22c55e' })
    let sourceMaterialDisposeCalls = 0
    sourceMaterial.dispose = (() => { sourceMaterialDisposeCalls += 1 }) as typeof sourceMaterial.dispose

    const sourceGeometry = new THREE.BoxGeometry(1, 2, 3)
    let sourceGeometryDisposeCalls = 0
    sourceGeometry.dispose = (() => { sourceGeometryDisposeCalls += 1 }) as typeof sourceGeometry.dispose

    const sourceScene = new THREE.Group()
    sourceScene.add(new THREE.Mesh(sourceGeometry, sourceMaterial))

    const instance = module.cloneViewer3DLoadedScene(sourceScene) as THREE.Group
    const sourceMesh = sourceScene.children[0] as THREE.Mesh
    const instanceMesh = instance.children[0] as THREE.Mesh

    assert.notEqual(instanceMesh.material, sourceMesh.material)
    assert.equal(instanceMesh.geometry, sourceMesh.geometry)

    module.disposeViewer3DOwnedSceneResources(instance)

    assert.equal(sourceMaterialDisposeCalls, 0)
    assert.equal(sourceGeometryDisposeCalls, 0)
  } finally {
    await cleanup()
  }
})

test('Viewer3D cloned skeleton UUID tracks animate owned Bones without touching cached Bones', async () => {
  const { module, cleanup } = await loadViewer3DModule()
  try {
    const source = new THREE.Group(), bone = new THREE.Bone()
    const mesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
    source.add(bone, mesh); mesh.bind(new THREE.Skeleton([bone]))
    const instance = module.cloneViewer3DLoadedScene(source) as THREE.Group
    const ownedBone = instance.getObjectByProperty('uuid', bone.uuid) as THREE.Bone
    const ownedMesh = instance.children[1] as THREE.SkinnedMesh
    assert.notEqual(ownedBone, bone)
    assert.equal(ownedMesh.skeleton.bones[0], ownedBone)
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)
    const clip = new THREE.AnimationClip('uuid-owner', 1, [new THREE.QuaternionKeyframeTrack(`${bone.uuid}.quaternion`, [0, 1], [0, 0, 0, 1, ...rotation.toArray()])])
    const mixer = new THREE.AnimationMixer(instance)
    mixer.clipAction(clip).play(); mixer.update(0.5)
    assert.notEqual(ownedBone.quaternion.x, 0)
    assert.equal(bone.quaternion.x, 0)
    mixer.stopAllAction(); mixer.uncacheRoot(instance)
    const ownedSkeleton = ownedMesh.skeleton
    ownedSkeleton.computeBoneTexture()
    const ownedTexture = ownedSkeleton.boneTexture!
    const cachedTexture = new THREE.DataTexture()
    mesh.skeleton.boneTexture = cachedTexture
    let ownedTextureDisposals = 0, cachedTextureDisposals = 0
    ownedTexture.addEventListener('dispose', () => { ownedTextureDisposals++ })
    cachedTexture.addEventListener('dispose', () => { cachedTextureDisposals++ })
    // Teardown must use its captured owner, not a current borrowed replacement.
    ownedMesh.skeleton = mesh.skeleton
    const release = module.retainViewer3DOwnedSceneResources(instance)
    release()
    const releaseReplay = module.retainViewer3DOwnedSceneResources(instance)
    await Promise.resolve()
    assert.equal(ownedSkeleton.boneTexture, ownedTexture)
    assert.equal(ownedTextureDisposals, 0)
    releaseReplay(); await Promise.resolve()
    module.disposeViewer3DOwnedSceneResources(instance)
    assert.equal(ownedSkeleton.boneTexture, null)
    assert.equal(ownedTextureDisposals, 1)
    assert.equal(mesh.skeleton.boneTexture, cachedTexture)
    assert.equal(cachedTextureDisposals, 0)
  } finally { await cleanup() }
})

test('Viewer3D material cleanup survives effect replay and never consumes transient or cached resources', async () => {
  const { module, cleanup } = await loadViewer3DModule()
  try {
    const material = new THREE.MeshStandardMaterial(), geometry = new THREE.BoxGeometry()
    let cachedDisposals = 0, geometryDisposals = 0, ownedDisposals = 0, transientDisposals = 0
    material.dispose = () => { cachedDisposals++ }; geometry.dispose = () => { geometryDisposals++ }
    const source = new THREE.Group(); source.add(new THREE.Mesh(geometry, material))
    const instance = module.cloneViewer3DLoadedScene(source) as THREE.Group
    const mesh = instance.children[0] as THREE.Mesh
    ;(mesh.material as THREE.Material).dispose = () => { ownedDisposals++ }
    const transient = new THREE.MeshNormalMaterial(); transient.dispose = () => { transientDisposals++ }
    mesh.material = transient
    const release = module.retainViewer3DOwnedSceneResources(instance)
    release()
    const releaseReplay = module.retainViewer3DOwnedSceneResources(instance)
    await Promise.resolve()
    assert.equal(ownedDisposals, 0)
    releaseReplay(); await Promise.resolve()
    module.disposeViewer3DOwnedSceneResources(instance)
    assert.equal(ownedDisposals, 1)
    assert.equal(cachedDisposals, 0); assert.equal(geometryDisposals, 0); assert.equal(transientDisposals, 0)
  } finally { await cleanup() }
})

test('Viewer3D managed BVH references keep foreign trees and release only the exact last-owned tree', async () => {
  const { module, cleanup } = await loadViewer3DModule()
  try {
    const geometry = new THREE.BoxGeometry() as THREE.BufferGeometry & { boundsTree?: unknown; computeBoundsTree?: (options: unknown) => void; disposeBoundsTree?: () => void }
    const tree = {}, foreignTree = {}
    let builds = 0, releases = 0
    geometry.computeBoundsTree = options => { assert.deepEqual(options, { indirect: true }); builds++; geometry.boundsTree = tree }
    geometry.disposeBoundsTree = () => { assert.equal(geometry.boundsTree, tree); releases++; delete geometry.boundsTree }
    assert.equal(module.acquireViewer3DManagedBoundsTree(geometry), true)
    assert.equal(module.acquireViewer3DManagedBoundsTree(geometry), true)
    assert.equal(builds, 1)
    assert.equal(module.releaseViewer3DManagedBoundsTree(geometry), false)
    assert.equal(geometry.boundsTree, tree)
    assert.equal(module.releaseViewer3DManagedBoundsTree(geometry), true)
    assert.equal(releases, 1)
    geometry.boundsTree = foreignTree
    assert.equal(module.acquireViewer3DManagedBoundsTree(geometry), false)
    assert.equal(module.releaseViewer3DManagedBoundsTree(geometry), false)
    assert.equal(geometry.boundsTree, foreignTree)
    delete geometry.boundsTree
    assert.equal(module.acquireViewer3DManagedBoundsTree(geometry), true)
    geometry.boundsTree = foreignTree
    assert.equal(module.releaseViewer3DManagedBoundsTree(geometry), false)
    assert.equal(geometry.boundsTree, foreignTree); assert.equal(releases, 1)
  } finally { await cleanup() }
})

test('Viewer3D optional BVH construction failures preserve fallback raycasting', async t => {
  const { module, cleanup } = await loadViewer3DModule()
  const warnings: unknown[][] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args) })
  try {
    const rejected = new THREE.BoxGeometry() as THREE.BufferGeometry & { computeBoundsTree?: () => void; boundsTree?: unknown }
    rejected.computeBoundsTree = () => { throw new Error('Synthetic unsupported geometry') }
    assert.equal(module.acquireViewer3DManagedBoundsTree(rejected), false)
    assert.equal(module.releaseViewer3DManagedBoundsTree(rejected), false)
    assert.equal(rejected.boundsTree, undefined)
    const source = new THREE.Group(); source.add(new THREE.Mesh(rejected, new THREE.MeshBasicMaterial()))
    assert.equal(module.hasViewer3DRenderableContent(source), true, "Optional acceleration must not reject the renderable mesh")
    // Exercise the installed constructor's missing-position rejection with CPU data only.
    assert.equal(module.acquireViewer3DManagedBoundsTree(new THREE.BufferGeometry()), false)
    assert.equal(warnings.length, 2)
    const externalTree = {}; rejected.boundsTree = externalTree
    assert.equal(module.acquireViewer3DManagedBoundsTree(rejected), false)
    assert.equal(module.releaseViewer3DManagedBoundsTree(rejected), false)
    assert.equal(rejected.boundsTree, externalTree)
    assert.equal(warnings.length, 2, "External trees are not rebuilt or rejected")
    const supported = new THREE.BoxGeometry()
    assert.equal(module.acquireViewer3DManagedBoundsTree(supported), true)
    assert.equal(module.releaseViewer3DManagedBoundsTree(supported), true)
    assert.equal((supported as THREE.BufferGeometry & { boundsTree?: unknown }).boundsTree, null)
  } finally { await cleanup() }
})

test('Viewer3D camera framing resolves finite bounds for tiny huge and offset meshes without changing object transforms', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const tiny = module.resolveViewer3DCameraFrame({
      bounds: new THREE.Box3(new THREE.Vector3(-0.0005, 0, -0.0005), new THREE.Vector3(0.0005, 0.001, 0.0005)),
      aspect: 16 / 9,
      fovDegrees: 45,
    })
    const huge = module.resolveViewer3DCameraFrame({
      bounds: new THREE.Box3(new THREE.Vector3(-5000, -2500, -4000), new THREE.Vector3(5000, 3500, 4500)),
      aspect: 16 / 9,
      fovDegrees: 45,
    })
    const offset = module.resolveViewer3DCameraFrame({
      bounds: new THREE.Box3(new THREE.Vector3(100, -2, 300), new THREE.Vector3(104, 6, 308)),
      aspect: 1,
      fovDegrees: 45,
    })

    assert.ok(tiny)
    assert.ok(huge)
    assert.ok(offset)
    assert.ok(Number.isFinite(tiny.position.length()))
    assert.ok(Number.isFinite(huge.position.length()))
    assert.ok(Number.isFinite(offset.position.length()))
    assert.deepEqual(offset.target.toArray(), [102, 2, 304])
    assert.ok(huge.position.distanceTo(huge.target) > tiny.position.distanceTo(tiny.target))
    assert.ok(tiny.near > 0)
    assert.ok(huge.far > huge.near)
  } finally {
    await cleanup()
  }
})

test('Viewer3D BVH acceleration stays gated behind edit or landmark picking features', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    assert.equal(module.shouldEnableViewer3DBvh({ editMode: false }), false)
    assert.equal(module.shouldEnableViewer3DBvh({ editMode: true }), true)
    assert.equal(module.shouldEnableViewer3DBvh({ editMode: false, landmarkPicking: { activeLandmarkId: 'hips', canvas: null, onPoint: () => undefined } }), true)
  } finally {
    await cleanup()
  }
})

test('Viewer3D viewport gizmos render only when a real renderable object is loaded', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const empty = new THREE.Group()
    const meshGroup = new THREE.Group()
    meshGroup.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()))

    assert.equal(module.shouldRenderViewer3DViewportGizmos({ modelUrl: 'http://127.0.0.1:8000/workspace/mesh.glb', hasCurrentJob: true, object: empty }), false)
    assert.equal(module.shouldRenderViewer3DViewportGizmos({ modelUrl: 'http://127.0.0.1:8000/workspace/mesh.glb', hasCurrentJob: false, object: meshGroup }), false)
    assert.equal(module.shouldRenderViewer3DViewportGizmos({ modelUrl: 'http://127.0.0.1:8000/workspace/mesh.glb', hasCurrentJob: true, object: meshGroup }), true)
  } finally {
    await cleanup()
  }
})

test('Viewer3D local DreamCube regression GLB parses and reports finite bounds when present', { skip: process.env.MODLY_VIEWER3D_PRIVATE_ASSET_REGRESSION !== '1' || !existsSync(dreamCubeRegressionGlbPath) }, async () => {
  const bytes = readFileSync(dreamCubeRegressionGlbPath)
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const loader = new GLTFLoader()
  const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => loader.parse(arrayBuffer, '', resolve, reject))

  gltf.scene.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(gltf.scene)
  const size = bounds.getSize(new THREE.Vector3())

  assert.equal(bounds.isEmpty(), false)
  assert.ok(size.x > 0)
  assert.ok(size.y > 0)
  assert.ok(size.z > 0)
})

test('resolveViewer3DPresentation marks workflow checkpoints as temporary and not deletable', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    assert.deepEqual(
      module.resolveViewer3DPresentation({
        kind: 'workflow-checkpoint',
        modelUrl: 'http://127.0.0.1:8000/workspace/checkpoints/wait.glb',
        isCheckpointPreview: true,
        label: 'Temporary checkpoint — not final output',
      }),
      {
        modelUrl: 'http://127.0.0.1:8000/workspace/checkpoints/wait.glb',
        checkpointLabel: 'Temporary checkpoint — not final output',
        sourceLabel: 'Temporary checkpoint — not final output',
        canDeleteSelectedModel: false,
        selectedHint: 'Temporary checkpoint — not final output',
        idleHint: 'Drag to rotate • Scroll to zoom',
      },
    )
  } finally {
    await cleanup()
  }
})

test('resolveViewer3DPresentation keeps final outputs deletable without checkpoint copy', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    assert.deepEqual(
      module.resolveViewer3DPresentation({
        kind: 'final',
        modelUrl: 'http://127.0.0.1:8000/workspace/final/model.glb',
        isCheckpointPreview: false,
        label: 'Final output',
      }),
      {
        modelUrl: 'http://127.0.0.1:8000/workspace/final/model.glb',
        checkpointLabel: null,
        sourceLabel: 'Final output',
        canDeleteSelectedModel: true,
        selectedHint: 'Click mesh to select • Delete to remove',
        idleHint: 'Drag to rotate • Scroll to zoom',
      },
    )
  } finally {
    await cleanup()
  }
})

test('resolveViewer3DPresentation forwards normalized source label and provenance without creating new UI states', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    assert.deepEqual(
      module.resolveViewer3DPresentation({
        kind: 'final',
        modelUrl: 'http://127.0.0.1:8000/workspace/imports/hero.glb',
        isCheckpointPreview: false,
        label: 'Final output',
        sourceLabel: 'Imported mesh',
        sourceKind: 'import',
        provenance: { producer: 'scene-import', runId: 'import-1' },
      }),
      {
        modelUrl: 'http://127.0.0.1:8000/workspace/imports/hero.glb',
        checkpointLabel: null,
        sourceLabel: 'Imported mesh',
        provenance: { producer: 'scene-import', runId: 'import-1' },
        canDeleteSelectedModel: true,
        selectedHint: 'Click mesh to select • Delete to remove',
        idleHint: 'Drag to rotate • Scroll to zoom',
      },
    )
  } finally {
    await cleanup()
  }
})

test('resolveViewer3DRigSourceWorkspacePath keeps final generated workspace meshes source-backed for rig sidecars', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    assert.equal(
      module.resolveViewer3DRigSourceWorkspacePath({
        kind: 'final',
        modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/generated/unirig-character.glb?cache=manual-test',
        isCheckpointPreview: false,
        label: 'Final output',
      }),
      'Workflows/generated/unirig-character.glb',
    )
    assert.equal(
      module.resolveViewer3DRigSourceWorkspacePath({
        kind: 'workflow-checkpoint',
        modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/checkpoints/wait%20rig.glb',
        isCheckpointPreview: true,
        label: 'Temporary checkpoint — not final output',
      }),
      'Workflows/checkpoints/wait rig.glb',
    )
  } finally {
    await cleanup()
  }
})

test('resolveViewer3DRigSourceWorkspacePath requires target workspacePath to corroborate a safe visible URL', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    assert.equal(
      module.resolveViewer3DRigSourceWorkspacePath({
        kind: 'final',
        modelUrl: 'blob:http://127.0.0.1:8000/generated-preview',
        isCheckpointPreview: false,
        label: 'Final output',
        sourceLabel: 'Imported mesh',
        sourceKind: 'import',
        workspacePath: 'Imports/hero.glb',
      }),
      undefined,
    )
    assert.equal(
      module.resolveViewer3DRigSourceWorkspacePath({
        kind: 'final',
        modelUrl: 'http://127.0.0.1:8000/workspace/Imports/fallback.glb',
        isCheckpointPreview: false,
        label: 'Final output',
        sourceLabel: 'Imported mesh',
        sourceKind: 'import',
        workspacePath: '../unsafe.glb',
      }),
      undefined,
    )
  } finally {
    await cleanup()
  }
})

test('resolveViewer3DRigSourceWorkspacePath refuses non-workspace, traversal, and non-mesh sources', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    assert.equal(module.resolveViewer3DRigSourceWorkspacePath({ kind: 'none', modelUrl: null, isCheckpointPreview: false }), undefined)
    assert.equal(
      module.resolveViewer3DRigSourceWorkspacePath({ kind: 'final', modelUrl: 'blob:http://local/generated', isCheckpointPreview: false, label: 'Final output' }),
      undefined,
    )
    assert.equal(
      module.resolveViewer3DRigSourceWorkspacePath({ kind: 'final', modelUrl: 'http://127.0.0.1:8000/workspace/../escape.glb', isCheckpointPreview: false, label: 'Final output' }),
      undefined,
    )
    assert.equal(
      module.resolveViewer3DRigSourceWorkspacePath({ kind: 'final', modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/generated/readme.txt', isCheckpointPreview: false, label: 'Final output' }),
      undefined,
    )
  } finally {
    await cleanup()
  }
})

test('resolveViewer3DPresentation keeps empty viewer state non-deletable and copy-free', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    assert.deepEqual(
      module.resolveViewer3DPresentation({
        kind: 'none',
        modelUrl: null,
        isCheckpointPreview: false,
      }),
      {
        modelUrl: null,
        checkpointLabel: null,
        sourceLabel: null,
        canDeleteSelectedModel: false,
        selectedHint: 'Click mesh to select • Delete to remove',
        idleHint: 'Drag to rotate • Scroll to zoom',
      },
    )
  } finally {
    await cleanup()
  }
})

test('resolveViewer3DLandmarkMarkers derives simple markers from completed landmarks', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    assert.deepEqual(
      module.resolveViewer3DLandmarkMarkers({
        right_knee: {
          id: 'right_knee',
          name: 'right_knee',
          world: { x: 6, y: 7, z: 8 },
          confidence: 1,
          source: 'manual',
        },
        left_shoulder: {
          id: 'left_shoulder',
          name: 'left_shoulder',
          world: { x: 1, y: 2, z: 3 },
          objectName: 'body-mesh',
          confidence: 1,
          source: 'manual',
        },
      }),
      [
        { id: 'left_shoulder', name: 'left_shoulder', label: 'Left shoulder', shortLabel: 'LS', color: '#fbbf24', position: { x: 1, y: 2, z: 3 }, objectName: 'body-mesh' },
        { id: 'right_knee', name: 'right_knee', label: 'Right knee', shortLabel: 'RK', color: '#22c55e', position: { x: 6, y: 7, z: 8 } },
      ],
    )
  } finally {
    await cleanup()
  }
})

test('resolveViewer3DOverlayLayout offsets right-side overlays when the edit rail is visible', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    assert.deepEqual(module.resolveViewer3DOverlayLayout({ modelUrl: 'model.glb', hasEditRail: true }), {
      viewRailClassName: 'left-4 top-1/2 -translate-y-1/2 z-20',
      editRailClassName: 'right-4 top-1/2 -translate-y-1/2 z-20',
      editPanelClassName: 'right-16',
      rigEditorPanelSlot: 'top-right',
      motionRetargetPanelSlot: 'top-right-stack',
      motionRetargetPanelClassName: 'right-16 top-4',
      poseClipPanelSlot: 'bottom-drawer',
      poseClipPanelClassName: 'left-4 right-16 bottom-4 max-h-[34vh]',
      commonViewportUsability: 'capped-internal-scroll',
      hintClassName: 'right-16',
      rigOverlayClassName: 'left-4 top-24 z-20',
      rigOverlaySafeArea: 'below-top-left-toolbar',
    })
    assert.deepEqual(module.resolveViewer3DOverlayLayout({ modelUrl: 'model.glb', hasEditRail: false }), {
      viewRailClassName: 'left-4 top-1/2 -translate-y-1/2 z-20',
      editRailClassName: null,
      editPanelClassName: 'right-4',
      rigEditorPanelSlot: 'top-right',
      motionRetargetPanelSlot: 'top-right-stack',
      motionRetargetPanelClassName: 'right-4 top-4',
      poseClipPanelSlot: 'bottom-drawer',
      poseClipPanelClassName: 'left-4 right-16 bottom-4 max-h-[34vh]',
      commonViewportUsability: 'capped-internal-scroll',
      hintClassName: 'right-4',
      rigOverlayClassName: 'left-4 top-24 z-20',
      rigOverlaySafeArea: 'below-top-left-toolbar',
    })
  } finally {
    await cleanup()
  }
})

test('resolveViewer3DOverlayLayout keeps Rig Editor in the top-right slot and moves Pose/Clip to a separate lower drawer slot', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const layout = module.resolveViewer3DOverlayLayout({ modelUrl: 'model.glb', hasEditRail: true })

    assert.equal(layout.rigEditorPanelSlot, 'top-right')
    assert.equal(layout.poseClipPanelSlot, 'bottom-drawer')
    assert.notEqual(layout.poseClipPanelSlot, layout.rigEditorPanelSlot)
    assert.match(layout.poseClipPanelClassName, /bottom/)
    assert.doesNotMatch(layout.poseClipPanelClassName, /top-4/)
    assert.equal(layout.commonViewportUsability, 'capped-internal-scroll')
  } finally {
    await cleanup()
  }
})

test('resolveViewer3DOverlayLayout reserves the top-left toolbar area for Free memory controls', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const layout = module.resolveViewer3DOverlayLayout({ modelUrl: 'model.glb', hasEditRail: true })

    assert.equal(layout.rigOverlaySafeArea, 'below-top-left-toolbar')
  } finally {
    await cleanup()
  }
})

test('resolveViewer3DOverlayLayout treats Pose/Clip as one action rail regardless of legacy drawer mode', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const minimizedPoseClipLayout = module.resolveViewer3DOverlayLayout({
      modelUrl: 'model.glb',
      hasEditRail: true,
      poseClipVisibility: { isOpen: true, skeletonContextId: 'rig:hero|skeleton:0', drawerMode: 'minimized' },
    })

    assert.equal(minimizedPoseClipLayout.rigOverlaySafeArea, 'above-minimized-pose-clip-controls')
    assert.match(minimizedPoseClipLayout.rigOverlayClassName, /left-4/)
    assert.match(minimizedPoseClipLayout.rigOverlayClassName, /bottom/)
    assert.doesNotMatch(minimizedPoseClipLayout.rigOverlayClassName, /top-24/)

    const expandedPoseClipLayout = module.resolveViewer3DOverlayLayout({
      modelUrl: 'model.glb',
      hasEditRail: true,
      poseClipVisibility: { isOpen: true, skeletonContextId: 'rig:hero|skeleton:0', drawerMode: 'expanded' },
    })

    assert.deepEqual(expandedPoseClipLayout, minimizedPoseClipLayout)
  } finally {
    await cleanup()
  }
})

test('resolveViewer3DOverlayLayout keeps non-open Pose/Clip contexts on the existing RigOverlay placement', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const closedPoseClipLayout = module.resolveViewer3DOverlayLayout({
      modelUrl: 'model.glb',
      hasEditRail: false,
      poseClipVisibility: { isOpen: false, skeletonContextId: 'rig:hero|skeleton:0', drawerMode: 'minimized' },
    })

    assert.equal(closedPoseClipLayout.rigOverlaySafeArea, 'below-top-left-toolbar')
    assert.equal(closedPoseClipLayout.rigOverlayClassName, 'left-4 top-24 z-20')
  } finally {
    await cleanup()
  }
})

const rigSummary = Object.freeze({
  hasRig: true,
  sourceWorkspacePath: 'Workflows/outputs/hero.glb',
  skeletonContextId: 'rig:hero|skeleton:0',
  skinnedMeshContexts: ['rig:hero|skeleton:0'],
  rootBoneIds: ['rig:hero|skeleton:0|bone:hips#0'],
  stats: { skinnedMeshCount: 1, boneCount: 2 },
  warnings: [],
  bones: [
    {
      boneId: 'rig:hero|skeleton:0|bone:hips#0',
      label: 'Hips',
      originalName: 'Hips',
      path: ['Hips'],
      siblingIndex: 0,
      childIds: ['rig:hero|skeleton:0|bone:hips#0/spine#0'],
      warnings: [],
    },
    {
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      label: 'Spine',
      originalName: 'Spine',
      path: ['Hips', 'Spine'],
      siblingIndex: 0,
      parentId: 'rig:hero|skeleton:0|bone:hips#0',
      childIds: [],
      warnings: [],
    },
  ],
})

const humanoidDraftSidecar = Object.freeze({
  schema: 'modly.humanoid-draft.v1',
  version: 1,
  source: { workspacePath: 'Characters/hero-source.glb' },
  output: { workspacePath: 'Workflows/generated/hero.glb' },
  meshOutputSha256: 'mesh-sha-123',
  rigmetaSha256: 'rigmeta-sha-123',
  draftSha256: 'draft-sha-123',
  trust: { status: 'draft', reasons: ['confidence_below_threshold'], trusted: false },
  provenance: { producer: 'unirig', runId: 'run-123', extensionId: 'unirig-ext', createdAt: '2026-05-22T19:00:00.000Z' },
  assignments: {
    roles: {
      hips: { boneId: 'rig:hero|skeleton:0|bone:hips#0', label: 'Hips', confidence: 0.98 },
      spine: { boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', label: 'Spine', confidence: 0.84 },
    },
    chains: {
      spine: ['rig:hero|skeleton:0|bone:hips#0', 'rig:hero|skeleton:0|bone:hips#0/spine#0'],
    },
  },
  confidence: { overall: 0.76, byRole: { hips: 0.98, spine: 0.84 } },
  completeness: { requiredRolesMissing: ['head'], score: 0.67 },
  diagnostics: ['Head role is still unresolved.'],
})

const humanoidPromotionSidecar = Object.freeze({
  schema: 'modly.humanoid-promotion.v1',
  version: 1,
  promotionId: 'promotion-123',
  source: { workspacePath: 'Characters/hero-source.glb' },
  output: { workspacePath: 'Workflows/generated/hero.glb' },
  meshOutputSha256: 'mesh-sha-123',
  rigmetaSha256: 'rigmeta-sha-123',
  draftSha256: 'draft-sha-123',
  draftSchema: 'modly.humanoid-draft.v1',
  promotedAssignments: structuredClone(humanoidDraftSidecar.assignments),
  provenance: { basis: 'modly.humanoid-draft.v1', trustStatus: 'manual_confirmed' },
  audit: {
    confirmedBy: 'modly:user:local:drhepa',
    confirmedByLabel: 'drhepa',
    createdAt: '2026-05-22T20:00:00.000Z',
    method: 'import',
    rationale: 'Reviewed hips and spine against the rig overlay.',
  },
})

const secondRigSummary = Object.freeze({
  hasRig: true,
  sourceWorkspacePath: 'Workflows/outputs/creature.glb',
  skeletonContextId: 'rig:creature|skeleton:0',
  skinnedMeshContexts: ['rig:creature|skeleton:0'],
  rootBoneIds: ['rig:creature|skeleton:0|bone:root#0'],
  stats: { skinnedMeshCount: 1, boneCount: 1 },
  warnings: [],
  bones: [
    {
      boneId: 'rig:creature|skeleton:0|bone:root#0',
      label: 'Root',
      originalName: 'Root',
      path: ['Root'],
      siblingIndex: 0,
      childIds: [],
      warnings: [],
    },
  ],
})

const contextualRigBoneIds = Object.freeze({
  hips: 'rig:Workflows/1779522315_382fd9a5_unirig.glb|skeleton:0|bone:bone_0#0',
  spine: 'rig:Workflows/1779522315_382fd9a5_unirig.glb|skeleton:0|bone:bone_0#0/bone_1#0',
  unmapped: 'rig:Workflows/1779522315_382fd9a5_unirig.glb|skeleton:0|bone:bone_0#0/bone_1#0/bone_2#0',
  chest: 'rig:Workflows/1779522315_382fd9a5_unirig.glb|skeleton:0|bone:bone_0#0/bone_1#0/bone_2#0/bone_3#0',
  neck: 'rig:Workflows/1779522315_382fd9a5_unirig.glb|skeleton:0|bone:bone_0#0/bone_1#0/bone_2#0/bone_3#0/bone_4#0',
  head: 'rig:Workflows/1779522315_382fd9a5_unirig.glb|skeleton:0|bone:bone_0#0/bone_1#0/bone_2#0/bone_3#0/bone_4#0/bone_5#0',
})

const rawBoneRigSummary = Object.freeze({
  hasRig: true,
  sourceWorkspacePath: 'Workflows/1779522315_382fd9a5_unirig.glb',
  skeletonContextId: 'rig:Workflows/1779522315_382fd9a5_unirig.glb|skeleton:0',
  skinnedMeshContexts: ['rig:Workflows/1779522315_382fd9a5_unirig.glb|skeleton:0'],
  rootBoneIds: [contextualRigBoneIds.hips],
  stats: { skinnedMeshCount: 1, boneCount: 6 },
  warnings: [],
  bones: [
    {
      boneId: contextualRigBoneIds.hips,
      label: 'bone_0',
      originalName: 'bone_0',
      path: ['bone_0'],
      siblingIndex: 0,
      childIds: [contextualRigBoneIds.spine],
      warnings: [],
    },
    {
      boneId: contextualRigBoneIds.spine,
      label: 'bone_1',
      originalName: 'bone_1',
      path: ['bone_0', 'bone_1'],
      siblingIndex: 0,
      parentId: contextualRigBoneIds.hips,
      childIds: [contextualRigBoneIds.unmapped],
      warnings: [],
    },
    {
      boneId: contextualRigBoneIds.unmapped,
      label: 'bone_2',
      originalName: 'bone_2',
      path: ['bone_0', 'bone_1', 'bone_2'],
      siblingIndex: 0,
      parentId: contextualRigBoneIds.spine,
      childIds: [contextualRigBoneIds.chest],
      warnings: [],
    },
    {
      boneId: contextualRigBoneIds.chest,
      label: 'bone_3',
      originalName: 'bone_3',
      path: ['bone_0', 'bone_1', 'bone_2', 'bone_3'],
      siblingIndex: 0,
      parentId: contextualRigBoneIds.unmapped,
      childIds: [contextualRigBoneIds.neck],
      warnings: [],
    },
    {
      boneId: contextualRigBoneIds.neck,
      label: 'bone_4',
      originalName: 'bone_4',
      path: ['bone_0', 'bone_1', 'bone_2', 'bone_3', 'bone_4'],
      siblingIndex: 0,
      parentId: contextualRigBoneIds.chest,
      childIds: [contextualRigBoneIds.head],
      warnings: [],
    },
    {
      boneId: contextualRigBoneIds.head,
      label: 'bone_5',
      originalName: 'bone_5',
      path: ['bone_0', 'bone_1', 'bone_2', 'bone_3', 'bone_4', 'bone_5'],
      siblingIndex: 0,
      parentId: contextualRigBoneIds.neck,
      childIds: [],
      warnings: [],
    },
  ],
})

const rawBoneHumanoidDraftSidecar = Object.freeze({
  schema: 'modly.humanoid-draft.v1',
  version: 1,
  source: { workspacePath: 'Characters/raw-source.glb' },
  output: { workspacePath: 'Workflows/1779522315_382fd9a5_unirig.glb' },
  meshOutputSha256: 'mesh-raw-123',
  rigmetaSha256: 'rigmeta-raw-123',
  draftSha256: 'draft-raw-123',
  trust: { status: 'draft', reasons: ['manual_review_required'], trusted: false },
  provenance: { producer: 'unirig', runId: 'run-raw', extensionId: 'unirig-ext', createdAt: '2026-05-23T10:00:00.000Z' },
  assignments: {
    roles: {
      hips: 'bone_0',
      spine: 'bone_1',
      chest: 'bone_3',
      neck: 'bone_4',
      head: 'bone_5',
    },
    chains: {
      spine: ['bone_0', 'bone_1', 'bone_2', 'bone_3', 'bone_4', 'bone_5'],
    },
  },
  confidence: { overall: 0.79, byRole: { hips: 0.97, spine: 0.91, chest: 0.88, neck: 0.86, head: 0.86 } },
  completeness: { requiredRolesMissing: [], score: 1 },
  diagnostics: [],
})

const rawBoneHumanoidPromotionSidecar = Object.freeze({
  schema: 'modly.humanoid-promotion.v1',
  version: 1,
  promotionId: 'promotion-raw-123',
  source: { workspacePath: 'Characters/raw-source.glb' },
  output: { workspacePath: 'Workflows/1779522315_382fd9a5_unirig.glb' },
  meshOutputSha256: 'mesh-raw-123',
  rigmetaSha256: 'rigmeta-raw-123',
  draftSha256: 'draft-raw-123',
  draftSchema: 'modly.humanoid-draft.v1',
  promotedAssignments: structuredClone(rawBoneHumanoidDraftSidecar.assignments),
  provenance: { basis: 'modly.humanoid-draft.v1', trustStatus: 'manual_confirmed' },
  audit: {
    confirmedBy: 'modly:user:local:drhepa',
    confirmedByLabel: 'drhepa',
    createdAt: '2026-05-23T10:30:00.000Z',
    method: 'viewer3d',
    rationale: 'Reviewed raw bone naming inside Rig Editor.',
  },
})

const kimodoDisplayedWorkspacePath = 'Workflows/kimodo-20260523-140139-ca71024b/animated.glb'
const kimodoSemanticSourceWorkspacePath = 'Workflows/1779535081_02857c58_unirig.glb'

const kimodoDisplayedRigBoneIds = Object.freeze({
  hips: 'rig:Workflows/kimodo-20260523-140139-ca71024b/animated.glb|skeleton:0|bone:bone_0#0',
  spine: 'rig:Workflows/kimodo-20260523-140139-ca71024b/animated.glb|skeleton:0|bone:bone_0#0/bone_1#0',
  unmapped: 'rig:Workflows/kimodo-20260523-140139-ca71024b/animated.glb|skeleton:0|bone:bone_0#0/bone_1#0/bone_2#0',
  chest: 'rig:Workflows/kimodo-20260523-140139-ca71024b/animated.glb|skeleton:0|bone:bone_0#0/bone_1#0/bone_2#0/bone_3#0',
  neck: 'rig:Workflows/kimodo-20260523-140139-ca71024b/animated.glb|skeleton:0|bone:bone_0#0/bone_1#0/bone_2#0/bone_3#0/bone_4#0',
  head: 'rig:Workflows/kimodo-20260523-140139-ca71024b/animated.glb|skeleton:0|bone:bone_0#0/bone_1#0/bone_2#0/bone_3#0/bone_4#0/bone_5#0',
})

const kimodoDisplayedRigSummary = Object.freeze({
  hasRig: true,
  sourceWorkspacePath: kimodoDisplayedWorkspacePath,
  skeletonContextId: 'rig:Workflows/kimodo-20260523-140139-ca71024b/animated.glb|skeleton:0',
  skinnedMeshContexts: ['rig:Workflows/kimodo-20260523-140139-ca71024b/animated.glb|skeleton:0'],
  bones: [
    {
      boneId: kimodoDisplayedRigBoneIds.hips,
      label: 'bone_0',
      originalName: 'bone_0',
      path: ['bone_0'],
      siblingIndex: 0,
      childIds: [kimodoDisplayedRigBoneIds.spine],
      warnings: [],
    },
    {
      boneId: kimodoDisplayedRigBoneIds.spine,
      label: 'bone_1',
      originalName: 'bone_1',
      path: ['bone_0', 'bone_1'],
      siblingIndex: 0,
      parentId: kimodoDisplayedRigBoneIds.hips,
      childIds: [kimodoDisplayedRigBoneIds.unmapped],
      warnings: [],
    },
    {
      boneId: kimodoDisplayedRigBoneIds.unmapped,
      label: 'bone_2',
      originalName: 'bone_2',
      path: ['bone_0', 'bone_1', 'bone_2'],
      siblingIndex: 0,
      parentId: kimodoDisplayedRigBoneIds.spine,
      childIds: [kimodoDisplayedRigBoneIds.chest],
      warnings: [],
    },
    {
      boneId: kimodoDisplayedRigBoneIds.chest,
      label: 'bone_3',
      originalName: 'bone_3',
      path: ['bone_0', 'bone_1', 'bone_2', 'bone_3'],
      siblingIndex: 0,
      parentId: kimodoDisplayedRigBoneIds.unmapped,
      childIds: [kimodoDisplayedRigBoneIds.neck],
      warnings: [],
    },
    {
      boneId: kimodoDisplayedRigBoneIds.neck,
      label: 'bone_4',
      originalName: 'bone_4',
      path: ['bone_0', 'bone_1', 'bone_2', 'bone_3', 'bone_4'],
      siblingIndex: 0,
      parentId: kimodoDisplayedRigBoneIds.chest,
      childIds: [kimodoDisplayedRigBoneIds.head],
      warnings: [],
    },
    {
      boneId: kimodoDisplayedRigBoneIds.head,
      label: 'bone_5',
      originalName: 'bone_5',
      path: ['bone_0', 'bone_1', 'bone_2', 'bone_3', 'bone_4', 'bone_5'],
      siblingIndex: 0,
      parentId: kimodoDisplayedRigBoneIds.neck,
      childIds: [],
      warnings: [],
    },
  ],
  rootBoneIds: [kimodoDisplayedRigBoneIds.hips],
  stats: { skinnedMeshCount: 1, boneCount: 6 },
  warnings: [],
})

const kimodoSourceHumanoidDraftSidecar = Object.freeze({
  ...structuredClone(rawBoneHumanoidDraftSidecar),
  source: { workspacePath: 'Characters/kimodo-source.glb' },
  output: { workspacePath: kimodoSemanticSourceWorkspacePath },
})

const kimodoSourceHumanoidPromotionSidecar = Object.freeze({
  ...structuredClone(rawBoneHumanoidPromotionSidecar),
  source: { workspacePath: 'Characters/kimodo-source.glb' },
  output: { workspacePath: kimodoSemanticSourceWorkspacePath },
})


const motionRetargetFixture = Object.freeze({
  artifact: {
    extensionId: 'kimodo-soma-rp',
    nodeId: 'animate-rigged-mesh',
    workflowId: 'workflow-hero',
    workflowNodeId: 'node-animate',
    sourceMeshWorkspacePath: 'Workflows/outputs/hero.glb',
    previewGlbWorkspacePath: 'Workflows/kimodo/run-1/preview.glb',
    animatedGlbWorkspacePath: 'Workflows/kimodo/run-1/animated.glb',
    bundleWorkspacePath: 'Workflows/kimodo/run-1',
    metadataWorkspacePath: 'Workflows/kimodo/run-1/metadata.json',
    canonicalMotionArtifactWorkspacePath: 'Workflows/kimodo/run-1/motion.npz',
    motionNpzWorkspacePath: 'Workflows/kimodo/run-1/motion.npz',
    motionBvhWorkspacePath: 'Workflows/kimodo/run-1/motion.bvh',
    diagnostics: {
      runtimeStatus: 'completed',
      solverStatus: 'completed',
      basisStatus: 'valid',
      rootMotionStatus: 'preview-only',
      retargetStatus: 'completed',
      animationMappingStatus: 'completed',
      stabilizationStatus: 'completed',
      visualQualityStatus: 'preview-only',
      sourceKind: 'kimodo-motion-json',
      mappingConfidence: 'manual',
      retargetErrorCode: null,
      retargetErrorAliases: [],
      retargetErrorMessage: null,
      warnings: ['Root-motion correctness is deferred.'],
      raw: {},
    },
    motionRetarget: {
      status: 'parsed',
      diagnostics: [],
      clipName: 'Kimodo Walk Forward',
      sourceContract: { schema: 'modly.humanoid.v1', trusted: true },
      mappingStatus: 'trusted_manual',
      mappingConfidence: 'compatible',
      fps: 30,
      durationSeconds: 1.5,
      timeSemantics: 'seconds',
      sourceBones: [
        { sourceBoneId: 'source:hips', label: 'Hips', rawLabel: 'Hips', role: 'hips' },
        { sourceBoneId: 'source:spine', label: 'Spine', rawLabel: 'Spine', role: 'spine', parentSourceBoneId: 'source:hips' },
      ],
      targetTracks: [
        {
          targetNodeName: 'Hips',
          targetNodeIndex: 0,
          targetRole: 'hips',
          rotations: [
            { timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 },
            { timeSeconds: 1, ...quaternionValue(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)) },
          ],
        },
        {
          targetNodeName: 'Spine',
          targetNodeIndex: 1,
          targetRole: 'spine',
          rotations: [
            { timeSeconds: 0, x: 0, y: 0, z: 0, w: 1 },
            { timeSeconds: 1, ...quaternionValue(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI)) },
          ],
        },
      ],
    },
  },
  sourceBones: [
    { sourceBoneId: 'source:hips', label: 'Hips', rawLabel: 'Hips', role: 'hips', path: ['Hips'] },
    { sourceBoneId: 'source:spine', label: 'Spine', rawLabel: 'Spine', role: 'spine', path: ['Hips', 'Spine'], parentSourceBoneId: 'source:hips' },
  ],
  targetBones: [
    {
      boneId: 'rig:hero|skeleton:0|bone:hips#0',
      label: 'UniRig Pelvis',
      rawLabel: 'Hips',
      labelProvenance: 'unirig',
      role: 'hips',
      childIds: ['rig:hero|skeleton:0|bone:hips#0/spine#0'],
    },
    {
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      label: 'Manual Chest',
      rawLabel: 'Spine',
      labelProvenance: 'manual',
      role: 'spine',
      parentId: 'rig:hero|skeleton:0|bone:hips#0',
      childIds: [],
    },
  ],
  selectedPreview: 'animated-glb',
  mappings: {
    'source:hips': {
      sourceBoneId: 'source:hips',
      targetBoneId: 'rig:hero|skeleton:0|bone:hips#0',
      targetLabel: 'UniRig Pelvis',
      targetLabelProvenance: 'unirig',
    },
    'source:spine': {
      sourceBoneId: 'source:spine',
      targetBoneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      targetLabel: 'Manual Chest',
      targetLabelProvenance: 'manual',
    },
  },
  warnings: ['Root-motion correctness is deferred.'],
  diagnostics: {
    artifactWarnings: ['Root-motion correctness is deferred.'],
    mappingWarnings: [],
    sourceWarnings: {
      'source:hips': [],
      'source:spine': [],
    },
  },
  exportReadiness: {
    canSaveSidecar: true,
    canExportPoseClip: true,
    blockingWarnings: [],
  },
  unlockReadiness: {
    trustedPayloadReady: true,
    translationReady: true,
    showSourceBones: true,
    showMappingDisplay: true,
    canPreview: true,
    canSaveSidecar: true,
    canExportPoseClip: true,
    blockingWarnings: [],
  },
})

// Exercise the accepted builder instead of fabricated target identities/readiness flags.
const motionRetargetSession = createMotionRetargetSession({
  targetSummary: rigSummary,
  artifact: motionRetargetFixture.artifact as CreateMotionRetargetSessionInput['artifact'],
  sourceBones: motionRetargetFixture.sourceBones,
  snapshot: { selectedPreview: 'animated-glb', mappings: motionRetargetFixture.mappings },
  renamePlan: { skeletonContextId: rigSummary.skeletonContextId, aliases: { [rigSummary.bones[1].boneId]: { oldLabel: 'Spine', alias: 'Manual Chest' } } },
  rigMetaNamingByBoneId: { [rigSummary.bones[0].boneId]: { label: 'UniRig Pelvis', source: 'semantic_candidates' } },
})

const noRigSummary = Object.freeze({
  hasRig: false,
  skeletonContextId: 'rig:none|skeleton:0',
  skinnedMeshContexts: [],
  rootBoneIds: [],
  stats: { skinnedMeshCount: 0, boneCount: 0 },
  warnings: ['No skeleton bones were found.'],
  bones: [],
})

test('Viewer3D rig editor state owns selected bone and exposes controlled panel props for a rig summary', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let state = module.createViewer3DRigEditorState(rigSummary)
    assert.equal(state.selectedBoneId, undefined)
    assert.deepEqual(state.renamePlan, { skeletonContextId: 'rig:hero|skeleton:0', aliases: {} })

    state = module.reduceViewer3DRigEditorState(state, {
      type: 'select-bone',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })

    const panelProps = module.resolveViewer3DRigEditorPanelProps(state, {
      onSelectBone: () => {},
      onAliasChange: () => {},
      onCancelAlias: () => {},
      onRevertAliases: () => {},
      onSaveAliases: () => {},
    })

    assert.equal(panelProps.summary, rigSummary)
    assert.equal(panelProps.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.deepEqual(panelProps.renamePlan, { skeletonContextId: 'rig:hero|skeleton:0', aliases: {} })
    assert.deepEqual(panelProps.validation, { valid: true, errors: [] })
  } finally {
    await cleanup()
  }
})

test('Viewer3D rig editor reducer updates alias plan without mutating the skeleton summary', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const beforeSummary = structuredClone(rigSummary)
    let state = module.createViewer3DRigEditorState(rigSummary)

    state = module.reduceViewer3DRigEditorState(state, {
      type: 'set-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      alias: 'Chest Control',
    })

    assert.deepEqual(state.renamePlan.aliases, {
      'rig:hero|skeleton:0|bone:hips#0/spine#0': { oldLabel: 'Spine', alias: 'Chest Control' },
    })
    assert.deepEqual(rigSummary, beforeSummary)

    state = module.reduceViewer3DRigEditorState(state, {
      type: 'cancel-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    assert.deepEqual(state.renamePlan.aliases, {})

    state = module.reduceViewer3DRigEditorState(state, {
      type: 'set-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0',
      alias: 'Pelvis Control',
    })
    state = module.reduceViewer3DRigEditorState(state, { type: 'revert-aliases' })
    assert.deepEqual(state.renamePlan, { skeletonContextId: 'rig:hero|skeleton:0', aliases: {} })
  } finally {
    await cleanup()
  }
})

test('Viewer3D builds and writes rig rename sidecars through the dedicated workspace artifact writer', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let state = module.createViewer3DRigEditorState(rigSummary)
    state = module.reduceViewer3DRigEditorState(state, {
      type: 'set-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      alias: 'Chest Control',
    })
    const requests: unknown[] = []

    const result = await module.writeViewer3DRigRenameSidecar({
      state,
      createdAt: '2026-05-19T00:00:00.000Z',
      writer: async (request: unknown) => {
        requests.push(request)
        return { success: true, sidecarWorkspacePath: 'Workflows/rig-edits/hero-rig-aliases.rig.v1.json', sidecar: (request as { sidecar: unknown }).sidecar }
      },
    })

    assert.deepEqual(requests, [
      {
        sidecarWorkspacePath: 'Workflows/rig-edits/hero-rig-aliases.rig.v1.json',
        sourceWorkspacePath: 'Workflows/outputs/hero.glb',
        sidecar: {
          schema: 'modly.rig.rename-plan',
          version: 1,
          createdAt: '2026-05-19T00:00:00.000Z',
          source: { workspacePath: 'Workflows/outputs/hero.glb', artifactId: undefined, versionId: undefined },
          skeletonContextId: 'rig:hero|skeleton:0',
          skeleton: {
            rootBoneIds: ['rig:hero|skeleton:0|bone:hips#0'],
            boneCount: 2,
            bones: [
              {
                boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
                oldLabel: 'Spine',
                originalName: 'Spine',
                path: ['Hips', 'Spine'],
              },
            ],
          },
          aliases: {
            'rig:hero|skeleton:0|bone:hips#0/spine#0': { oldLabel: 'Spine', alias: 'Chest Control' },
          },
        },
      },
    ])
    assert.deepEqual(result, { success: true, sidecarWorkspacePath: 'Workflows/rig-edits/hero-rig-aliases.rig.v1.json', sidecar: (requests[0] as { sidecar: unknown }).sidecar })
  } finally {
    await cleanup()
  }
})

test('Viewer3D repeated rig alias saves use the same active sidecar path and persist the complete alias map', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let state = module.createViewer3DRigEditorState(rigSummary)
    state = module.reduceViewer3DRigEditorState(state, {
      type: 'set-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0',
      alias: 'Pelvis Control',
    })
    state = module.reduceViewer3DRigEditorState(state, {
      type: 'set-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      alias: 'Chest Control',
    })
    const requests: unknown[] = []
    const writer = async (request: unknown) => {
      requests.push(request)
      return { success: true, sidecarWorkspacePath: (request as { sidecarWorkspacePath: string }).sidecarWorkspacePath, sidecar: (request as { sidecar: unknown }).sidecar }
    }

    await module.writeViewer3DRigRenameSidecar({ state, createdAt: '2026-05-19T15:43:09.000Z', writer })
    await module.writeViewer3DRigRenameSidecar({ state, createdAt: '2026-05-19T15:44:02.000Z', writer })

    assert.equal(requests.length, 2)
    assert.equal((requests[0] as { sidecarWorkspacePath: string }).sidecarWorkspacePath, 'Workflows/rig-edits/hero-rig-aliases.rig.v1.json')
    assert.equal((requests[1] as { sidecarWorkspacePath: string }).sidecarWorkspacePath, 'Workflows/rig-edits/hero-rig-aliases.rig.v1.json')
    assert.deepEqual((requests[1] as { sidecar: { aliases: unknown } }).sidecar.aliases, {
      'rig:hero|skeleton:0|bone:hips#0': { oldLabel: 'Hips', alias: 'Pelvis Control' },
      'rig:hero|skeleton:0|bone:hips#0/spine#0': { oldLabel: 'Spine', alias: 'Chest Control' },
    })
  } finally {
    await cleanup()
  }
})

test('Viewer3D builds a source-backed sidecar for a final generated rig after deriving source from its workspace URL', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const derivedSource = module.resolveViewer3DRigSourceWorkspacePath({
      kind: 'final',
      modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/generated/unirig-character.glb',
      isCheckpointPreview: false,
      label: 'Final output',
    })
    let state = module.createViewer3DRigEditorState({ ...rigSummary, sourceWorkspacePath: derivedSource })
    state = module.reduceViewer3DRigEditorState(state, {
      type: 'set-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      alias: 'Chest Control',
    })
    const requests: unknown[] = []

    const result = await module.writeViewer3DRigRenameSidecar({
      state,
      createdAt: '2026-05-19T00:00:00.000Z',
      writer: async (request: unknown) => {
        requests.push(request)
        return { success: true, sidecarWorkspacePath: 'Workflows/rig-edits/unirig-character-rig-aliases.rig.v1.json', sidecar: (request as { sidecar: unknown }).sidecar }
      },
    })

    assert.equal(requests.length, 1)
    assert.equal((requests[0] as { sourceWorkspacePath: string }).sourceWorkspacePath, 'Workflows/generated/unirig-character.glb')
    assert.equal((requests[0] as { sidecarWorkspacePath: string }).sidecarWorkspacePath, 'Workflows/rig-edits/unirig-character-rig-aliases.rig.v1.json')
    assert.deepEqual(result, { success: true, sidecarWorkspacePath: 'Workflows/rig-edits/unirig-character-rig-aliases.rig.v1.json', sidecar: (requests[0] as { sidecar: unknown }).sidecar })
  } finally {
    await cleanup()
  }
})

test('Viewer3D refuses rig rename sidecar saves without a valid source-backed alias plan', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const unbackedState = module.createViewer3DRigEditorState({ ...rigSummary, sourceWorkspacePath: undefined })
    const result = await module.writeViewer3DRigRenameSidecar({
      state: unbackedState,
      createdAt: '2026-05-19T00:00:00.000Z',
      writer: async () => {
        throw new Error('writer should not be called')
      },
    })

    assert.deepEqual(result, { success: false, error: 'Rig rename sidecar requires a valid source-backed alias plan.' })
  } finally {
    await cleanup()
  }
})

test('Viewer3D rig editor state resets selection and aliases when rig context changes or no rig is present', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let state = module.createViewer3DRigEditorState(rigSummary)
    state = module.reduceViewer3DRigEditorState(state, {
      type: 'select-bone',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    state = module.reduceViewer3DRigEditorState(state, {
      type: 'set-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      alias: 'Chest Control',
    })

    state = module.reduceViewer3DRigEditorState(state, {
      type: 'set-summary',
      summary: secondRigSummary,
    })

    assert.equal(state.summary, secondRigSummary)
    assert.equal(state.selectedBoneId, undefined)
    assert.deepEqual(state.renamePlan, { skeletonContextId: 'rig:creature|skeleton:0', aliases: {} })

    state = module.reduceViewer3DRigEditorState(state, {
      type: 'set-summary',
      summary: noRigSummary,
    })

    assert.equal(state.summary, noRigSummary)
    assert.equal(state.selectedBoneId, undefined)
    assert.deepEqual(state.renamePlan, { skeletonContextId: 'rig:none|skeleton:0', aliases: {} })
    assert.equal(module.resolveViewer3DRigEditorPanelProps(state, {}).summary, noRigSummary)
  } finally {
    await cleanup()
  }
})

test('Viewer3D rig hydration derives the deterministic active sidecar path from the rig source', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    assert.deepEqual(module.resolveViewer3DRigHydrationRequest(rigSummary), {
      sidecarWorkspacePath: 'Workflows/rig-edits/hero-rig-aliases.rig.v1.json',
      sourceWorkspacePath: 'Workflows/outputs/hero.glb',
    })
    assert.equal(module.resolveViewer3DRigHydrationRequest({ ...rigSummary, sourceWorkspacePath: undefined }), null)
    assert.equal(module.resolveViewer3DRigHydrationRequest(noRigSummary), null)
  } finally {
    await cleanup()
  }
})

test('Viewer3D rig hydration treats a missing sidecar as normal empty canonical state', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DRigEditorState(rigSummary)
    const token = module.createViewer3DRigHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })

    const hydrated = module.applyViewer3DRigHydrationResult({
      state,
      result: { success: true, status: 'not-found', sidecarWorkspacePath: 'Workflows/rig-edits/hero-rig-aliases.rig.v1.json' },
      token,
      currentToken: token,
    })

    assert.deepEqual(hydrated.state.renamePlan, { skeletonContextId: 'rig:hero|skeleton:0', aliases: {} })
    assert.equal(hydrated.warning, null)
  } finally {
    await cleanup()
  }
})

test('Viewer3D rig hydration applies a found valid sidecar into canonical renamePlan without mutating source data', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DRigEditorState(rigSummary)
    const beforeSummary = structuredClone(rigSummary)
    const sidecar = {
      schema: 'modly.rig.rename-plan',
      version: 1,
      createdAt: '2026-05-19T00:00:00.000Z',
      source: { workspacePath: 'Workflows/outputs/hero.glb' },
      skeletonContextId: 'rig:hero|skeleton:0',
      skeleton: { rootBoneIds: ['rig:hero|skeleton:0|bone:hips#0'], boneCount: 2, bones: [] },
      aliases: {
        'rig:hero|skeleton:0|bone:hips#0/spine#0': { oldLabel: 'Legacy Spine', alias: 'Chest Control' },
      },
    }
    const beforeSidecar = structuredClone(sidecar)
    const token = module.createViewer3DRigHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })

    const hydrated = module.applyViewer3DRigHydrationResult({
      state,
      result: { success: true, status: 'found', sidecarWorkspacePath: 'Workflows/rig-edits/hero-rig-aliases.rig.v1.json', sidecar },
      token,
      currentToken: token,
    })

    assert.deepEqual(hydrated.state.renamePlan, {
      skeletonContextId: 'rig:hero|skeleton:0',
      aliases: {
        'rig:hero|skeleton:0|bone:hips#0/spine#0': { oldLabel: 'Spine', alias: 'Chest Control' },
      },
    })
    assert.equal(hydrated.warning, null)
    assert.deepEqual(rigSummary, beforeSummary)
    assert.deepEqual(sidecar, beforeSidecar)
  } finally {
    await cleanup()
  }
})

test('Viewer3D rig hydration keeps invalid sidecars non-blocking with a warning and empty plan', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DRigEditorState(rigSummary)
    const token = module.createViewer3DRigHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })

    const invalidRead = module.applyViewer3DRigHydrationResult({
      state,
      result: { success: false, status: 'invalid', error: 'Rig rename sidecar JSON is invalid.' },
      token,
      currentToken: token,
    })

    assert.deepEqual(invalidRead.state.renamePlan, { skeletonContextId: 'rig:hero|skeleton:0', aliases: {} })
    assert.deepEqual(invalidRead.warning, { status: 'warning', messages: ['Rig rename sidecar JSON is invalid.'] })

    const helperInvalid = module.applyViewer3DRigHydrationResult({
      state,
      result: {
        success: true,
        status: 'found',
        sidecarWorkspacePath: 'Workflows/rig-edits/hero-rig-aliases.rig.v1.json',
        sidecar: { schema: 'wrong', version: 1, source: { workspacePath: 'Workflows/outputs/hero.glb' }, aliases: {} },
      },
      token,
      currentToken: token,
    })

    assert.deepEqual(helperInvalid.state.renamePlan, { skeletonContextId: 'rig:hero|skeleton:0', aliases: {} })
    assert.deepEqual(helperInvalid.warning, { status: 'warning', messages: ['Rig rename sidecar schema must be "modly.rig.rename-plan".', 'Rig rename sidecar skeletonContextId must be a string.', 'Rig rename sidecar skeleton metadata is invalid.'] })
  } finally {
    await cleanup()
  }
})

test('Viewer3D passes rig hydration warnings through controlled Rig Editor panel props', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DRigEditorState(rigSummary)
    const hydrationWarning = { status: 'warning', messages: ['Rig rename sidecar JSON is invalid.'] }

    const panelProps = module.resolveViewer3DRigEditorPanelProps(state, {}, hydrationWarning)

    assert.deepEqual(panelProps.hydrationWarning, hydrationWarning)
    assert.deepEqual(panelProps.renamePlan, { skeletonContextId: 'rig:hero|skeleton:0', aliases: {} })
    assert.deepEqual(panelProps.validation, { valid: true, errors: [] })
  } finally {
    await cleanup()
  }
})

test('Viewer3D rigmeta hydration treats a missing sidecar as normal empty automatic naming state', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DRigEditorState(rigSummary)
    const token = module.createViewer3DRigMetaHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })

    assert.deepEqual(module.resolveViewer3DRigMetaHydrationRequest(rigSummary), {
      sourceWorkspacePath: 'Workflows/outputs/hero.glb',
    })

    const hydrated = module.applyViewer3DRigMetaHydrationResult({
      state,
      result: { success: true, status: 'not-found', rigMetaWorkspacePath: 'Workflows/outputs/hero.rigmeta.json' },
      token,
      currentToken: token,
    })

    assert.deepEqual(hydrated.state.rigMetaNamingByBoneId, {})
    assert.equal(hydrated.warning, null)
    assert.deepEqual(module.resolveViewer3DRigEditorPanelProps(hydrated.state, {}).rigMetaNamingByBoneId, {})
  } finally {
    await cleanup()
  }
})

test('Viewer3D rigmeta hydration normalizes valid rigmeta into panel props without mutating raw rig data', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DRigEditorState(rigSummary)
    const beforeSummary = structuredClone(rigSummary)
    const token = module.createViewer3DRigMetaHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })

    const hydrated = module.applyViewer3DRigMetaHydrationResult({
      state,
      result: {
        success: true,
        status: 'found',
        rigMetaWorkspacePath: 'Workflows/outputs/hero.rigmeta.json',
        warnings: [],
        namingByBoneId: {},
        rigMeta: {
          schema: 'modly.unirig.rigmeta',
          source: { workspacePath: 'Workflows/outputs/hero.glb' },
          semantic_candidates: {
            'rig:hero|skeleton:0|bone:hips#0': { resolved_label: 'UniRig Pelvis' },
          },
          humanoid_contract: {
            bones: {
              'rig:hero|skeleton:0|bone:hips#0/spine#0': 'UniRig Spine',
            },
          },
        },
      },
      token,
      currentToken: token,
    })

    assert.deepEqual(hydrated.state.rigMetaNamingByBoneId, {
      'rig:hero|skeleton:0|bone:hips#0': { label: 'UniRig Pelvis', source: 'semantic_candidates' },
      'rig:hero|skeleton:0|bone:hips#0/spine#0': { label: 'UniRig Spine', source: 'humanoid_contract' },
    })
    assert.equal(hydrated.warning, null)
    assert.deepEqual(module.resolveViewer3DRigEditorPanelProps(hydrated.state, {}).effectiveNaming.ordered, [
      { boneId: 'rig:hero|skeleton:0|bone:hips#0', label: 'UniRig Pelvis', rawLabel: 'Hips', provenance: 'unirig' },
      { boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', label: 'UniRig Spine', rawLabel: 'Spine', provenance: 'unirig' },
    ])
    assert.deepEqual(rigSummary, beforeSummary)
  } finally {
    await cleanup()
  }
})

test('Viewer3D rigmeta hydration feeds top-level trusted humanoid contract naming into Rig Editor effective labels', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const { collectRigSkeletonSummary } = await import('../rigSkeleton.ts')
    const hips = new THREE.Bone(); hips.name = 'bone_0'
    const leg = new THREE.Bone(); leg.name = 'bone_20'; hips.add(leg)
    const summary = Object.freeze(collectRigSkeletonSummary({
      sourceWorkspacePath: 'Workflows/1779522315_382fd9a5_unirig.glb',
      skinnedMeshes: [{ name: 'Body', skeleton: { bones: [leg, hips] } }],
    }))
    const leftUpperLegId = summary.bones.find((bone) => bone.originalName === 'bone_20')!.boneId
    const state = module.createViewer3DRigEditorState(summary)
    const token = module.createViewer3DRigMetaHydrationToken({ modelUrl: '1779522315_382fd9a5_unirig.glb', summary })

    const hydrated = module.applyViewer3DRigMetaHydrationResult({
      state,
      result: {
        success: true,
        status: 'found',
        rigMetaWorkspacePath: 'Workflows/1779522315_382fd9a5_unirig.rigmeta.json',
        warnings: [],
        namingByBoneId: {},
        rigMeta: {
          schema: 'modly.unirig.rigmeta',
          source: { workspacePath: 'Workflows/1779522315_382fd9a5_unirig.glb' },
          humanoid_contract_status: 'trusted',
          humanoid_contract: {
            schema: 'modly.humanoid.v1',
            required_roles: {
              hips: 'bone_0',
              left_upper_leg: 'bone_20',
            },
            validation: { status: 'validated' },
            provenance: { trust_scope: { trusted: ['required_roles', 'role_chains'] } },
          },
        },
      },
      token,
      currentToken: token,
    })
    const panelProps = module.resolveViewer3DRigEditorPanelProps({ ...hydrated.state, selectedBoneId: leftUpperLegId }, {})

    assert.equal(hydrated.warning, null)
    assert.deepEqual(hydrated.state.rigMetaNamingByBoneId[leftUpperLegId], { label: 'Left Upper Leg', source: 'humanoid_contract' })
    assert.equal(panelProps.effectiveNaming.byBoneId[leftUpperLegId].label, 'Left Upper Leg')
    assert.equal(panelProps.effectiveNaming.byBoneId[leftUpperLegId].rawLabel, 'bone_20')
    assert.equal(panelProps.effectiveNaming.byBoneId[leftUpperLegId].provenance, 'unirig')
    assert.deepEqual(summary.bones.at(-1), {
      boneId: leftUpperLegId,
      label: 'bone_20',
      originalName: 'bone_20',
      nodeIndex: 0,
      path: ['bone_0', 'bone_20'],
      siblingIndex: 0,
      parentId: summary.rootBoneIds[0],
      childIds: [],
      warnings: [],
    })
  } finally {
    await cleanup()
  }
})

test('Viewer3D rigmeta hydration keeps invalid rigmeta non-blocking with empty naming and warning', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DRigEditorState(rigSummary)
    const token = module.createViewer3DRigMetaHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })

    const invalidRead = module.applyViewer3DRigMetaHydrationResult({
      state,
      result: { success: false, status: 'invalid', rigMetaWorkspacePath: 'Workflows/outputs/hero.rigmeta.json', message: 'Rigmeta JSON is invalid.' },
      token,
      currentToken: token,
    })

    assert.deepEqual(invalidRead.state.rigMetaNamingByBoneId, {})
    assert.deepEqual(invalidRead.warning, { status: 'warning', messages: ['Rigmeta JSON is invalid.'] })

    const unsupported = module.applyViewer3DRigMetaHydrationResult({
      state,
      result: { success: true, status: 'found', rigMetaWorkspacePath: 'Workflows/outputs/hero.rigmeta.json', rigMeta: { schema: 'wrong' }, namingByBoneId: {}, warnings: [] },
      token,
      currentToken: token,
    })

    assert.deepEqual(unsupported.state.rigMetaNamingByBoneId, {})
    assert.deepEqual(unsupported.warning, { status: 'warning', messages: ['Rigmeta schema is unsupported; known naming fields will be loaded defensively.', 'Rigmeta did not contain supported naming entries.'] })
  } finally {
    await cleanup()
  }
})

test('Viewer3D rigmeta hydration ignores stale async results and preserves manual alias precedence', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const staleToken = module.createViewer3DRigMetaHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })
    const currentToken = module.createViewer3DRigMetaHydrationToken({ modelUrl: 'creature.glb', summary: secondRigSummary })
    const currentState = module.createViewer3DRigEditorState(secondRigSummary)

    const stale = module.applyViewer3DRigMetaHydrationResult({
      state: currentState,
      result: { success: true, status: 'found', rigMetaWorkspacePath: 'Workflows/outputs/hero.rigmeta.json', rigMeta: { semantic_candidates: { 'rig:hero|skeleton:0|bone:hips#0': 'UniRig Pelvis' } }, namingByBoneId: {}, warnings: [] },
      token: staleToken,
      currentToken,
    })

    assert.equal(stale.stale, true)
    assert.deepEqual(stale.state.rigMetaNamingByBoneId, {})

    let manualState = module.createViewer3DRigEditorState(rigSummary)
    manualState = module.reduceViewer3DRigEditorState(manualState, { type: 'set-alias', boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', alias: 'Manual Chest' })
    const token = module.createViewer3DRigMetaHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })
    const hydrated = module.applyViewer3DRigMetaHydrationResult({
      state: manualState,
      result: { success: true, status: 'found', rigMetaWorkspacePath: 'Workflows/outputs/hero.rigmeta.json', rigMeta: { semantic_candidates: { 'rig:hero|skeleton:0|bone:hips#0/spine#0': 'UniRig Spine' } }, namingByBoneId: {}, warnings: [] },
      token,
      currentToken: token,
    })

    assert.deepEqual(hydrated.state.renamePlan.aliases, {
      'rig:hero|skeleton:0|bone:hips#0/spine#0': { oldLabel: 'Spine', alias: 'Manual Chest' },
    })
    assert.deepEqual(module.resolveViewer3DRigEditorPanelProps(hydrated.state, {}).effectiveNaming.ordered, [
      { boneId: 'rig:hero|skeleton:0|bone:hips#0', label: 'Hips', rawLabel: 'Hips', provenance: 'raw' },
      { boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', label: 'Manual Chest', rawLabel: 'Spine', provenance: 'manual' },
    ])
  } finally {
    await cleanup()
  }
})

test('Viewer3D rig hydration ignores stale async reads for old model/source/skeleton contexts', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const staleToken = module.createViewer3DRigHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })
    const currentToken = module.createViewer3DRigHydrationToken({ modelUrl: 'creature.glb', summary: secondRigSummary })
    const currentState = module.createViewer3DRigEditorState(secondRigSummary)

    const hydrated = module.applyViewer3DRigHydrationResult({
      state: currentState,
      result: {
        success: true,
        status: 'found',
        sidecarWorkspacePath: 'Workflows/rig-edits/hero-rig-aliases.rig.v1.json',
        sidecar: {
          schema: 'modly.rig.rename-plan',
          version: 1,
          createdAt: '2026-05-19T00:00:00.000Z',
          source: { workspacePath: 'Workflows/outputs/hero.glb' },
          skeletonContextId: 'rig:hero|skeleton:0',
          skeleton: { rootBoneIds: ['rig:hero|skeleton:0|bone:hips#0'], boneCount: 2, bones: [] },
          aliases: { 'rig:hero|skeleton:0|bone:hips#0': { oldLabel: 'Hips', alias: 'Pelvis Control' } },
        },
      },
      token: staleToken,
      currentToken,
    })

    assert.equal(hydrated.stale, true)
    assert.deepEqual(hydrated.state.renamePlan, { skeletonContextId: 'rig:creature|skeleton:0', aliases: {} })
    assert.equal(hydrated.warning, null)
  } finally {
    await cleanup()
  }
})

test('Viewer3D rig hydration does not overwrite dirty user edits when a late read resolves', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let state = module.createViewer3DRigEditorState(rigSummary)
    state = module.reduceViewer3DRigEditorState(state, { type: 'set-alias', boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', alias: 'Human Chest' })
    const token = module.createViewer3DRigHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })

    const hydrated = module.applyViewer3DRigHydrationResult({
      state,
      result: {
        success: true,
        status: 'found',
        sidecarWorkspacePath: 'Workflows/rig-edits/hero-rig-aliases.rig.v1.json',
        sidecar: {
          schema: 'modly.rig.rename-plan',
          version: 1,
          createdAt: '2026-05-19T00:00:00.000Z',
          source: { workspacePath: 'Workflows/outputs/hero.glb' },
          skeletonContextId: 'rig:hero|skeleton:0',
          skeleton: { rootBoneIds: ['rig:hero|skeleton:0|bone:hips#0'], boneCount: 2, bones: [] },
          aliases: { 'rig:hero|skeleton:0|bone:hips#0/spine#0': { oldLabel: 'Spine', alias: 'Sidecar Chest' } },
        },
      },
      token,
      currentToken: token,
    })

    assert.deepEqual(hydrated.state.renamePlan.aliases, {
      'rig:hero|skeleton:0|bone:hips#0/spine#0': { oldLabel: 'Spine', alias: 'Human Chest' },
    })
    assert.equal(hydrated.dirtySkipped, true)
    assert.equal(hydrated.warning, null)
  } finally {
    await cleanup()
  }
})

test('Viewer3D keeps the Rig Editor panel hidden by default and toggles it from the right rail', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const rigState = module.createViewer3DRigEditorState(rigSummary)
    let visibility = module.createViewer3DRigEditorVisibilityState(rigSummary)

    assert.equal(visibility.isOpen, false)
    assert.equal(module.resolveViewer3DRigEditorPanelRenderState({ modelUrl: 'hero.glb', rigState, visibility }).shouldRenderPanel, false)

    visibility = module.reduceViewer3DRigEditorVisibilityState(visibility, { type: 'toggle', summary: rigSummary })
    assert.equal(visibility.isOpen, true)
    assert.equal(module.resolveViewer3DRigEditorPanelRenderState({ modelUrl: 'hero.glb', rigState, visibility }).shouldRenderPanel, true)

    visibility = module.reduceViewer3DRigEditorVisibilityState(visibility, { type: 'toggle', summary: rigSummary })
    assert.equal(visibility.isOpen, false)
    assert.equal(module.resolveViewer3DRigEditorPanelRenderState({ modelUrl: 'hero.glb', rigState, visibility }).shouldRenderPanel, false)
  } finally {
    await cleanup()
  }
})

test('Viewer3D Rig Editor visibility preserves selection and aliases while hidden but resets for a new rig source', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let rigState = module.createViewer3DRigEditorState(rigSummary)
    rigState = module.reduceViewer3DRigEditorState(rigState, {
      type: 'select-bone',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    rigState = module.reduceViewer3DRigEditorState(rigState, {
      type: 'set-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      alias: 'Chest Control',
    })
    let visibility = module.reduceViewer3DRigEditorVisibilityState(
      module.createViewer3DRigEditorVisibilityState(rigSummary),
      { type: 'toggle', summary: rigSummary },
    )

    visibility = module.reduceViewer3DRigEditorVisibilityState(visibility, { type: 'toggle', summary: rigSummary })
    assert.equal(visibility.isOpen, false)
    assert.equal(rigState.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.deepEqual(rigState.renamePlan.aliases, {
      'rig:hero|skeleton:0|bone:hips#0/spine#0': { oldLabel: 'Spine', alias: 'Chest Control' },
    })

    visibility = module.reduceViewer3DRigEditorVisibilityState(visibility, { type: 'set-summary', summary: secondRigSummary })
    rigState = module.reduceViewer3DRigEditorState(rigState, { type: 'set-summary', summary: secondRigSummary })
    assert.equal(visibility.isOpen, false)
    assert.equal(rigState.selectedBoneId, undefined)
    assert.deepEqual(rigState.renamePlan, { skeletonContextId: 'rig:creature|skeleton:0', aliases: {} })

    const noRigVisibility = module.reduceViewer3DRigEditorVisibilityState(visibility, { type: 'toggle', summary: noRigSummary })
    assert.equal(noRigVisibility.isOpen, false)
  } finally {
    await cleanup()
  }
})

test('Viewer3D derives selected-bone overlay props from canonical rig editor state', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let state = module.createViewer3DRigEditorState(rigSummary)
    const visibility = module.reduceViewer3DRigEditorVisibilityState(
      module.createViewer3DRigEditorVisibilityState(rigSummary),
      { type: 'toggle', summary: rigSummary },
    )
    state = module.reduceViewer3DRigEditorState(state, {
      type: 'select-bone',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    const selected: string[] = []

    const overlayProps = module.resolveViewer3DRigOverlayProps(
      state,
      { onSelectBone: (boneId: string) => selected.push(boneId) },
      visibility,
    )

    assert.deepEqual(overlayProps.overlay, {
      selectedBoneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      selectedLabel: 'Spine',
      parentBoneId: 'rig:hero|skeleton:0|bone:hips#0',
      childBoneIds: [],
      highlightedBoneIds: [
        'rig:hero|skeleton:0|bone:hips#0/spine#0',
        'rig:hero|skeleton:0|bone:hips#0',
      ],
      connections: [
        { fromBoneId: 'rig:hero|skeleton:0|bone:hips#0', toBoneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', relation: 'parent' },
      ],
    })
    overlayProps.onSelectBone('rig:hero|skeleton:0|bone:hips#0')
    assert.deepEqual(selected, ['rig:hero|skeleton:0|bone:hips#0'])
  } finally {
    await cleanup()
  }
})

test('Viewer3D selected-bone overlay displays effective labels while callbacks keep stable RigBoneId', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let state = module.createViewer3DRigEditorState(rigSummary)
    state = module.reduceViewer3DRigEditorState(state, {
      type: 'select-bone',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    state = module.reduceViewer3DRigEditorState(state, {
      type: 'set-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      alias: 'Manual Chest',
    })
    state = {
      ...state,
      rigMetaNamingByBoneId: {
        'rig:hero|skeleton:0|bone:hips#0': { label: 'UniRig Pelvis', source: 'semantic_candidates' },
        'rig:hero|skeleton:0|bone:hips#0/spine#0': { label: 'UniRig Spine', source: 'humanoid_contract' },
      },
    }
    const visibility = module.reduceViewer3DRigEditorVisibilityState(
      module.createViewer3DRigEditorVisibilityState(rigSummary),
      { type: 'toggle', summary: rigSummary },
    )
    const selected: string[] = []
    const effectiveNaming = module.resolveViewer3DRigEditorPanelProps(state, {}).effectiveNaming

    const overlayProps = module.resolveViewer3DRigOverlayProps(
      state,
      { onSelectBone: (boneId: string) => selected.push(boneId) },
      visibility,
      effectiveNaming,
    )

    assert.equal(overlayProps.overlay.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.equal(overlayProps.overlay.selectedLabel, 'Manual Chest')
    assert.notEqual(overlayProps.overlay.selectedLabel, 'UniRig Spine')
    assert.notEqual(overlayProps.overlay.selectedLabel, 'Spine')
    overlayProps.onSelectBone('rig:hero|skeleton:0|bone:hips#0')
    assert.deepEqual(selected, ['rig:hero|skeleton:0|bone:hips#0'])
  } finally {
    await cleanup()
  }
})

test('Viewer3D selected-bone overlay uses UniRig effective labels before falling back to raw bone names', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let state = module.createViewer3DRigEditorState(rigSummary)
    state = module.reduceViewer3DRigEditorState(state, {
      type: 'select-bone',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    state = {
      ...state,
      rigMetaNamingByBoneId: {
        'rig:hero|skeleton:0|bone:hips#0/spine#0': { label: 'UniRig Spine', source: 'humanoid_contract' },
      },
    }
    const visibility = module.reduceViewer3DRigEditorVisibilityState(
      module.createViewer3DRigEditorVisibilityState(rigSummary),
      { type: 'toggle', summary: rigSummary },
    )
    const effectiveNaming = module.resolveViewer3DRigEditorPanelProps(state, {}).effectiveNaming

    const unirigOverlayProps = module.resolveViewer3DRigOverlayProps(state, {}, visibility, effectiveNaming)
    const rawOverlayProps = module.resolveViewer3DRigOverlayProps(state, {}, visibility)

    assert.equal(unirigOverlayProps.overlay.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.equal(unirigOverlayProps.overlay.selectedLabel, 'UniRig Spine')
    assert.equal(rawOverlayProps.overlay.selectedLabel, 'Spine')
  } finally {
    await cleanup()
  }
})

test('Viewer3D hides selected-bone overlay props when the Rig Editor is closed and restores them when open', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let state = module.createViewer3DRigEditorState(rigSummary)
    state = module.reduceViewer3DRigEditorState(state, {
      type: 'select-bone',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    state = module.reduceViewer3DRigEditorState(state, {
      type: 'set-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      alias: 'Chest Control',
    })
    const closedVisibility = module.createViewer3DRigEditorVisibilityState(rigSummary)

    const closedOverlayProps = module.resolveViewer3DRigOverlayProps(state, {}, closedVisibility)
    assert.equal(closedOverlayProps.overlay, null)
    assert.equal(state.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.deepEqual(state.renamePlan.aliases, {
      'rig:hero|skeleton:0|bone:hips#0/spine#0': { oldLabel: 'Spine', alias: 'Chest Control' },
    })

    const openVisibility = module.reduceViewer3DRigEditorVisibilityState(closedVisibility, { type: 'toggle', summary: rigSummary })
    const openOverlayProps = module.resolveViewer3DRigOverlayProps(state, {}, openVisibility)
    assert.deepEqual(openOverlayProps.overlay, {
      selectedBoneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      selectedLabel: 'Spine',
      parentBoneId: 'rig:hero|skeleton:0|bone:hips#0',
      childBoneIds: [],
      highlightedBoneIds: [
        'rig:hero|skeleton:0|bone:hips#0/spine#0',
        'rig:hero|skeleton:0|bone:hips#0',
      ],
      connections: [
        { fromBoneId: 'rig:hero|skeleton:0|bone:hips#0', toBoneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', relation: 'parent' },
      ],
    })
  } finally {
    await cleanup()
  }
})

test('Viewer3D omits rig overlay props when there is no valid selected rig bone', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const noRigState = module.createViewer3DRigEditorState(noRigSummary)
    const noRigOverlayProps = module.resolveViewer3DRigOverlayProps(noRigState, {})
    assert.equal(noRigOverlayProps.overlay, null)
    assert.equal(noRigOverlayProps.onSelectBone('missing-bone'), undefined)

    const staleState = {
      ...module.createViewer3DRigEditorState(rigSummary),
      selectedBoneId: 'missing-bone',
    }
    assert.equal(module.resolveViewer3DRigOverlayProps(staleState, {}).overlay, null)
  } finally {
    await cleanup()
  }
})

test('Viewer3D resolves in-view rig helper colors from selectedBoneId without new marker feedback', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const helpers = module.resolveViewer3DRigHelperStyles(rigSummary, 'rig:hero|skeleton:0|bone:hips#0/spine#0')

    assert.deepEqual(helpers.markerStylesByBoneId, {
      'rig:hero|skeleton:0|bone:hips#0': {
        tone: 'default',
        color: '#f5f3ff',
        emissive: '#7c3aed',
        emissiveIntensity: 0.55,
        scale: 1,
        renderOrder: 5,
      },
      'rig:hero|skeleton:0|bone:hips#0/spine#0': {
        tone: 'selected',
        color: '#22d3ee',
        emissive: '#67e8f9',
        emissiveIntensity: 1.35,
        scale: 1.45,
        renderOrder: 7,
      },
    })
    assert.deepEqual(helpers.segmentStylesByChildBoneId, {
      'rig:hero|skeleton:0|bone:hips#0/spine#0': {
        tone: 'selected',
        color: '#22d3ee',
        opacity: 1,
        renderOrder: 6,
      },
    })
    assert.equal(helpers.requiresNewMarker, false)
  } finally {
    await cleanup()
  }
})

test('Viewer3D moves in-view selected helper color and falls back to default for unknown selection', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const rootSelected = module.resolveViewer3DRigHelperStyles(rigSummary, 'rig:hero|skeleton:0|bone:hips#0')
    const unknownSelected = module.resolveViewer3DRigHelperStyles(rigSummary, 'missing-bone')
    const noSelected = module.resolveViewer3DRigHelperStyles(rigSummary, undefined)

    assert.equal(rootSelected.markerStylesByBoneId['rig:hero|skeleton:0|bone:hips#0'].tone, 'selected')
    assert.equal(rootSelected.markerStylesByBoneId['rig:hero|skeleton:0|bone:hips#0/spine#0'].tone, 'default')
    assert.equal(rootSelected.segmentStylesByChildBoneId['rig:hero|skeleton:0|bone:hips#0/spine#0'].tone, 'default')

    assert.equal(unknownSelected.markerStylesByBoneId['rig:hero|skeleton:0|bone:hips#0'].tone, 'default')
    assert.equal(unknownSelected.markerStylesByBoneId['rig:hero|skeleton:0|bone:hips#0/spine#0'].tone, 'default')
    assert.equal(unknownSelected.segmentStylesByChildBoneId['rig:hero|skeleton:0|bone:hips#0/spine#0'].tone, 'default')

    assert.deepEqual(noSelected, unknownSelected)
  } finally {
    await cleanup()
  }
})

test('Viewer3D owns Pose/Clip state separately from Rig Editor and passes stable-id panel props', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    let rigVisibility = module.createViewer3DRigEditorVisibilityState(rigSummary)
    let poseVisibility = module.createViewer3DPoseClipVisibilityState(rigSummary)

    assert.equal(poseState.selectedBoneId, undefined)
    assert.equal(module.resolveViewer3DPoseClipPanelRenderState({ modelUrl: 'hero.glb', poseState, visibility: poseVisibility }).shouldRenderPanel, false)

    poseVisibility = module.reduceViewer3DPoseClipVisibilityState(poseVisibility, { type: 'toggle', summary: rigSummary })
    assert.equal(poseVisibility.isOpen, true)
    assert.equal(rigVisibility.isOpen, false)
    assert.equal(module.resolveViewer3DPoseClipPanelRenderState({ modelUrl: 'hero.glb', poseState, visibility: poseVisibility }).shouldRenderPanel, true)

    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'select-bone',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    const captured: string[] = []
    const panelProps = module.resolveViewer3DPoseClipPanelProps(poseState, {
      onCaptureKeyframe: (boneId: string) => captured.push(boneId),
    })

    assert.equal(panelProps.summary, rigSummary)
    assert.equal(panelProps.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    panelProps.onCaptureKeyframe('rig:hero|skeleton:0|bone:hips#0/spine#0', 0.25)
    assert.deepEqual(captured, ['rig:hero|skeleton:0|bone:hips#0/spine#0'])

    rigVisibility = module.reduceViewer3DRigEditorVisibilityState(rigVisibility, { type: 'toggle', summary: rigSummary })
    assert.equal(rigVisibility.isOpen, true)
    assert.equal(poseVisibility.isOpen, true)
  } finally {
    await cleanup()
  }
})

test('Viewer3D keeps Pose/Clip panel free of duplicate tree selection while reducer remains stable-id safe', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    const panelProps = module.resolveViewer3DPoseClipPanelProps(poseState, {})

    assert.equal('onSelectBone' in panelProps, false)
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'select-bone',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })

    assert.equal(poseState.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.equal(poseState.plan.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.notEqual(poseState.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0')
  } finally {
    await cleanup()
  }
})

test('Viewer3D resolves Pose/Clip panel props with manual aliases over UniRig labels while preserving stable ids', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let rigState = module.createViewer3DRigEditorState(rigSummary)
    rigState = module.reduceViewer3DRigEditorState(rigState, {
      type: 'set-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      alias: 'Manual Chest',
    })
    rigState = {
      ...rigState,
      rigMetaNamingByBoneId: {
        'rig:hero|skeleton:0|bone:hips#0': { label: 'UniRig Pelvis', source: 'semantic_candidates' },
        'rig:hero|skeleton:0|bone:hips#0/spine#0': { label: 'UniRig Spine', source: 'humanoid_contract' },
      },
    }
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'select-bone',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })

    const panelProps = module.resolveViewer3DPoseClipPanelProps(
      poseState,
      {},
      module.resolveViewer3DRigEditorPanelProps(rigState, {}).effectiveNaming,
    )

    assert.equal(panelProps.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.deepEqual(panelProps.rigDisplayNames.ordered, [
      { boneId: 'rig:hero|skeleton:0|bone:hips#0', label: 'UniRig Pelvis', rawLabel: 'Hips', provenance: 'unirig' },
      { boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', label: 'Manual Chest', rawLabel: 'Spine', provenance: 'manual' },
    ])
    assert.equal('onSelectBone' in panelProps, false)
    assert.equal(poseState.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
  } finally {
    await cleanup()
  }
})

test('Viewer3D Pose/Clip callback regression keeps effective labels out of reducer ids and sidecar payloads', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let rigState = module.createViewer3DRigEditorState(rigSummary)
    rigState = module.reduceViewer3DRigEditorState(rigState, {
      type: 'set-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      alias: 'Manual Chest',
    })
    rigState = {
      ...rigState,
      rigMetaNamingByBoneId: {
        'rig:hero|skeleton:0|bone:hips#0': { label: 'UniRig Pelvis', source: 'semantic_candidates' },
        'rig:hero|skeleton:0|bone:hips#0/spine#0': { label: 'UniRig Spine', source: 'humanoid_contract' },
      },
    }

    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'set-clip-metadata', summary: rigSummary, durationSeconds: 1, fps: 10 })
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'select-bone',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })

    const effectiveNaming = module.resolveViewer3DRigEditorPanelProps(rigState, {}).effectiveNaming
    const panelProps = module.resolveViewer3DPoseClipPanelProps(
      poseState,
      {
        onCaptureKeyframe: (boneId: string, timeSeconds: number) => {
          poseState = module.reduceViewer3DPoseClipState(poseState, {
            type: 'capture-keyframe',
            summary: rigSummary,
            boneId,
            timeSeconds,
            rotation: { x: 0, y: 0, z: 0, w: 1 },
          })
        },
        onCaptureAndAdvance: (boneId: string) => {
          poseState = module.reduceViewer3DPoseClipState(poseState, {
            type: 'capture-and-advance',
            summary: rigSummary,
            boneId,
            rotation: { x: 0, y: 0.3826834, z: 0, w: 0.9238795 },
          })
        },
        onUpdateSelectedKeyframe: (_keyframeId: string, boneId: string) => {
          poseState = module.reduceViewer3DPoseClipState(poseState, {
            type: 'update-selected-keyframe',
            summary: rigSummary,
            boneId,
            rotation: { x: 0.7071068, y: 0, z: 0, w: 0.7071068 },
          })
        },
        onMoveSelectedKeyframe: (_keyframeId: string, timeSeconds: number) => {
          poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'move-selected-keyframe', summary: rigSummary, timeSeconds })
        },
        onDuplicateSelectedKeyframe: (_keyframeId: string) => {
          poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'duplicate-selected-keyframe', summary: rigSummary })
        },
      },
      effectiveNaming,
    )

    assert.equal(panelProps.rigDisplayNames.byBoneId['rig:hero|skeleton:0|bone:hips#0/spine#0'].label, 'Manual Chest')
    assert.equal(panelProps.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')

    panelProps.onCaptureKeyframe(panelProps.selectedBoneId, 0.25)
    panelProps.onCaptureAndAdvance(panelProps.selectedBoneId)
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'select-keyframe', summary: rigSummary, keyframeId: poseState.plan.keyframes[0].id })
    const selectedKeyframeId = poseState.selectedKeyframeId
    panelProps.onUpdateSelectedKeyframe(selectedKeyframeId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    panelProps.onMoveSelectedKeyframe(selectedKeyframeId, 0.5)
    panelProps.onDuplicateSelectedKeyframe(selectedKeyframeId)

    const requestLog: unknown[] = []
    await module.writeViewer3DPoseClipSidecar({
      state: poseState,
      createdAt: '2026-05-20T15:00:00.000Z',
      writer: async (request: unknown) => {
        requestLog.push(request)
        return { success: true, sidecarWorkspacePath: (request as { sidecarWorkspacePath: string }).sidecarWorkspacePath, sidecar: (request as { sidecar: unknown }).sidecar }
      },
    })

    assert.deepEqual(poseState.plan.keyframes.map((keyframe: { boneId: string }) => keyframe.boneId), [
      'rig:hero|skeleton:0|bone:hips#0/spine#0',
      'rig:hero|skeleton:0|bone:hips#0/spine#0',
      'rig:hero|skeleton:0|bone:hips#0/spine#0',
    ])
    assert.deepEqual(poseState.plan.keyframes.map((keyframe: { id: string }) => keyframe.id), [
      'kf-rig-hero-skeleton-0-bone-hips-0-spine-0-t0p250-f3-2',
      'kf-rig-hero-skeleton-0-bone-hips-0-spine-0-t0p250-f3-1',
      'kf-rig-hero-skeleton-0-bone-hips-0-spine-0-t0p250-f3-1__copy-1',
    ])
    assert.equal(JSON.stringify((requestLog[0] as { sidecar: unknown }).sidecar).includes('Manual Chest'), false)
    assert.equal(JSON.stringify((requestLog[0] as { sidecar: unknown }).sidecar).includes('UniRig Spine'), false)
  } finally {
    await cleanup()
  }
})

test('Viewer3D routes selected helper and overlay callbacks to the active rig authoring mode', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let rigState = module.createViewer3DRigEditorState(rigSummary)
    rigState = module.reduceViewer3DRigEditorState(rigState, {
      type: 'select-bone',
      boneId: 'rig:hero|skeleton:0|bone:hips#0',
    })
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'select-bone',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    const rigVisibility = module.reduceViewer3DRigEditorVisibilityState(
      module.createViewer3DRigEditorVisibilityState(rigSummary),
      { type: 'toggle', summary: rigSummary },
    )
    const poseVisibility = module.reduceViewer3DPoseClipVisibilityState(
      module.createViewer3DPoseClipVisibilityState(rigSummary),
      { type: 'toggle', summary: rigSummary },
    )
    const rigSelections: string[] = []
    const poseSelections: string[] = []

    const rigActive = module.resolveViewer3DActiveRigTargetState({
      rigEditorState: rigState,
      rigEditorVisibility: rigVisibility,
      poseClipState: poseState,
      poseClipVisibility: poseVisibility,
    })
    assert.equal(rigActive.activeMode, 'rig-editor')
    assert.equal(rigActive.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0')

    const rigOverlayProps = module.resolveViewer3DRigOverlayProps(rigActive, {
      onSelectBone: (boneId: string) => rigSelections.push(boneId),
    })
    assert.equal(rigOverlayProps.overlay.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0')
    rigOverlayProps.onSelectBone('rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.deepEqual(rigSelections, ['rig:hero|skeleton:0|bone:hips#0/spine#0'])
    assert.deepEqual([...poseSelections], [])

    const poseActive = module.resolveViewer3DActiveRigTargetState({
      rigEditorState: rigState,
      rigEditorVisibility: module.createViewer3DRigEditorVisibilityState(rigSummary),
      poseClipState: poseState,
      poseClipVisibility: poseVisibility,
    })
    assert.equal(poseActive.activeMode, 'pose-clip')
    assert.equal(poseActive.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')

    const poseOverlayProps = module.resolveViewer3DRigOverlayProps(poseActive, {
      onSelectBone: (boneId: string) => poseSelections.push(boneId),
    })
    assert.equal(poseOverlayProps.overlay.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    poseOverlayProps.onSelectBone('rig:hero|skeleton:0|bone:hips#0')
    assert.deepEqual(rigSelections, ['rig:hero|skeleton:0|bone:hips#0/spine#0'])
    assert.deepEqual(poseSelections, ['rig:hero|skeleton:0|bone:hips#0'])

    const inactive = module.resolveViewer3DActiveRigTargetState({
      rigEditorState: rigState,
      rigEditorVisibility: module.createViewer3DRigEditorVisibilityState(rigSummary),
      poseClipState: poseState,
      poseClipVisibility: module.createViewer3DPoseClipVisibilityState(rigSummary),
    })
    assert.equal(inactive.activeMode, 'none')
    assert.equal(inactive.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0')
    assert.equal(module.resolveViewer3DRigOverlayProps(inactive, {}).overlay, null)
  } finally {
    await cleanup()
  }
})

test('Viewer3D shared selected target lets Rig Editor selection drive Pose/Clip props and overlay helper state', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let sharedTarget = module.createViewer3DSelectedRigTargetState(rigSummary)
    let rigState = module.createViewer3DRigEditorState(rigSummary)
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    const rigVisibility = module.reduceViewer3DRigEditorVisibilityState(
      module.createViewer3DRigEditorVisibilityState(rigSummary),
      { type: 'toggle', summary: rigSummary },
    )
    const poseVisibility = module.reduceViewer3DPoseClipVisibilityState(
      module.createViewer3DPoseClipVisibilityState(rigSummary),
      { type: 'toggle', summary: rigSummary },
    )

    sharedTarget = module.reduceViewer3DSelectedRigTargetState(sharedTarget, {
      type: 'select-bone',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })

    rigState = { ...rigState, selectedBoneId: sharedTarget.selectedBoneId }
    poseState = { ...poseState, selectedBoneId: sharedTarget.selectedBoneId }

    assert.equal(module.resolveViewer3DRigEditorPanelProps(rigState, {}).selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.equal(module.resolveViewer3DPoseClipPanelProps(poseState, {}).selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')

    const activeTarget = module.resolveViewer3DActiveRigTargetState({
      rigEditorState: rigState,
      rigEditorVisibility: rigVisibility,
      poseClipState: poseState,
      poseClipVisibility: poseVisibility,
      selectedTarget: sharedTarget,
    })
    const overlayProps = module.resolveViewer3DRigOverlayProps(activeTarget, {})

    assert.equal(activeTarget.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.equal(overlayProps.overlay.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.equal(module.resolveViewer3DRigHelperStyles(rigSummary, activeTarget.selectedBoneId).markerStylesByBoneId['rig:hero|skeleton:0|bone:hips#0/spine#0'].tone, 'selected')
    assert.notEqual(poseState.plan.selectedBoneId, sharedTarget.selectedBoneId)
  } finally {
    await cleanup()
  }
})

test('Viewer3D shared selected target preserves Pose/Clip selection across panel close/reopen and resets only for invalid skeleton changes', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let sharedTarget = module.createViewer3DSelectedRigTargetState(rigSummary)
    let rigState = module.createViewer3DRigEditorState(rigSummary)
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    let poseVisibility = module.reduceViewer3DPoseClipVisibilityState(
      module.createViewer3DPoseClipVisibilityState(rigSummary),
      { type: 'toggle', summary: rigSummary },
    )

    sharedTarget = module.reduceViewer3DSelectedRigTargetState(sharedTarget, {
      type: 'select-bone',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'select-bone',
      summary: rigSummary,
      boneId: sharedTarget.selectedBoneId,
    })
    rigState = { ...rigState, selectedBoneId: sharedTarget.selectedBoneId }

    poseVisibility = module.reduceViewer3DPoseClipVisibilityState(poseVisibility, { type: 'close' })
    assert.equal(poseVisibility.isOpen, false)
    assert.equal(sharedTarget.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')

    poseVisibility = module.reduceViewer3DPoseClipVisibilityState(poseVisibility, { type: 'toggle', summary: rigSummary })
    const reopenedPoseProps = module.resolveViewer3DPoseClipPanelProps({ ...poseState, selectedBoneId: sharedTarget.selectedBoneId }, {})
    const reopenedRigProps = module.resolveViewer3DRigEditorPanelProps({ ...rigState, selectedBoneId: sharedTarget.selectedBoneId }, {})
    const activeTarget = module.resolveViewer3DActiveRigTargetState({
      rigEditorState: { ...rigState, selectedBoneId: sharedTarget.selectedBoneId },
      rigEditorVisibility: module.createViewer3DRigEditorVisibilityState(rigSummary),
      poseClipState: { ...poseState, selectedBoneId: sharedTarget.selectedBoneId },
      poseClipVisibility: poseVisibility,
      selectedTarget: sharedTarget,
    })

    assert.equal(reopenedPoseProps.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.equal(reopenedRigProps.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.equal(activeTarget.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')

    const sameSkeletonWithSelectedBone = { ...rigSummary, bones: [...rigSummary.bones] }
    sharedTarget = module.reduceViewer3DSelectedRigTargetState(sharedTarget, { type: 'set-summary', summary: sameSkeletonWithSelectedBone })
    assert.equal(sharedTarget.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')

    sharedTarget = module.reduceViewer3DSelectedRigTargetState(sharedTarget, { type: 'set-summary', summary: secondRigSummary })
    assert.deepEqual(sharedTarget, {
      skeletonContextId: 'rig:creature|skeleton:0',
      selectedBoneId: undefined,
    })
  } finally {
    await cleanup()
  }
})

test('Viewer3D Pose/Clip legacy drawer mode changes do not create a distinct normal workflow', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'select-bone',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-keyframe',
      summary: rigSummary,
      keyframeId: 'kf-spine',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      timeSeconds: 0.75,
      rotation: { x: 0, y: 0.5, z: 0, w: 0.866 },
    })
    let sharedTarget = module.createViewer3DSelectedRigTargetState(rigSummary)
    sharedTarget = module.reduceViewer3DSelectedRigTargetState(sharedTarget, {
      type: 'select-bone',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    let visibility = module.reduceViewer3DPoseClipVisibilityState(
      module.createViewer3DPoseClipVisibilityState(rigSummary),
      { type: 'toggle', summary: rigSummary },
    )

    visibility = module.reduceViewer3DPoseClipVisibilityState(visibility, { type: 'set-drawer-mode', drawerMode: 'minimized' })
    assert.equal(visibility.isOpen, true)
    assert.equal(visibility.drawerMode, 'minimized')
    assert.equal(sharedTarget.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.equal(poseState.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.equal(poseState.plan.keyframes.length, 1)

    visibility = module.reduceViewer3DPoseClipVisibilityState(visibility, { type: 'set-drawer-mode', drawerMode: 'expanded' })
    const expandedProps = module.resolveViewer3DPoseClipPanelProps({ ...poseState, selectedBoneId: sharedTarget.selectedBoneId }, {})

    assert.equal(visibility.drawerMode, 'expanded')
    assert.equal(expandedProps.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.deepEqual(expandedProps.keyframes.map((keyframe: { id: string }) => keyframe.id), ['kf-spine'])
    assert.equal(expandedProps.drawerMode, undefined)
    assert.equal(expandedProps.onDrawerModeChange, undefined)
  } finally {
    await cleanup()
  }
})

test('Viewer3D pose clip save/load uses preload sidecar APIs with workspace-safe deterministic paths', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-keyframe',
      summary: rigSummary,
      keyframeId: 'kf-1',
      boneId: 'rig:hero|skeleton:0|bone:hips#0',
      timeSeconds: 0.4,
      rotation: { x: 0, y: 0.7071068, z: 0, w: 0.7071068 },
    })
    const requests: unknown[] = []

    const result = await module.writeViewer3DPoseClipSidecar({
      state: poseState,
      createdAt: '2026-05-20T00:00:00.000Z',
      writer: async (request: unknown) => {
        requests.push(request)
        return { success: true, sidecarWorkspacePath: (request as { sidecarWorkspacePath: string }).sidecarWorkspacePath, sidecar: (request as { sidecar: unknown }).sidecar }
      },
    })

    assert.equal(requests.length, 1)
    assert.equal((requests[0] as { sidecarWorkspacePath: string }).sidecarWorkspacePath, 'Workflows/pose-clips/hero--src-1d73d9779190b874.pose-clip.v1.json')
    assert.equal((requests[0] as { sourceWorkspacePath: string }).sourceWorkspacePath, 'Workflows/outputs/hero.glb')
    assert.equal('legacySidecarWorkspacePath' in (requests[0] as Record<string, unknown>), false)
    assert.equal((requests[0] as { sidecar: { schema: string; source: { workspacePath: string }; skeletonContextId: string; keyframes: unknown[] } }).sidecar.schema, 'modly.pose-clip')
    assert.equal((requests[0] as { sidecar: { source: { workspacePath: string } } }).sidecar.source.workspacePath, 'Workflows/outputs/hero.glb')
    assert.equal((requests[0] as { sidecar: { skeletonContextId: string } }).sidecar.skeletonContextId, 'rig:hero|skeleton:0')
    assert.equal((requests[0] as { sidecar: { keyframes: unknown[] } }).sidecar.keyframes.length, 1)
    assert.deepEqual(result, { success: true, sidecarWorkspacePath: 'Workflows/pose-clips/hero--src-1d73d9779190b874.pose-clip.v1.json', sidecar: (requests[0] as { sidecar: unknown }).sidecar })

    assert.deepEqual(module.resolveViewer3DPoseClipHydrationRequest(rigSummary), {
      sidecarWorkspacePath: 'Workflows/pose-clips/hero--src-1d73d9779190b874.pose-clip.v1.json',
      legacySidecarWorkspacePath: 'Workflows/pose-clips/hero.pose-clip.v1.json',
      sourceWorkspacePath: 'Workflows/outputs/hero.glb',
    })
  } finally {
    await cleanup()
  }
})

test('Viewer3D pose clip save/load regression stays renderer-to-Electron sidecar only and omits ephemeral timeline state', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'set-clip-metadata', summary: rigSummary, durationSeconds: 1, fps: 10 })
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-and-advance',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    })
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-and-advance',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      rotation: { x: 0, y: 0.3826834, z: 0, w: 0.9238795 },
    })

    const requests: unknown[] = []
    const result = await module.writeViewer3DPoseClipSidecar({
      state: poseState,
      createdAt: '2026-05-20T12:00:00.000Z',
      writer: async (request: unknown) => {
        requests.push(request)
        return { success: true, sidecarWorkspacePath: (request as { sidecarWorkspacePath: string }).sidecarWorkspacePath, sidecar: (request as { sidecar: unknown }).sidecar }
      },
    })

    assert.equal(requests.length, 1)
    assert.deepEqual((requests[0] as { sidecarWorkspacePath: string; sourceWorkspacePath: string }), {
      sidecarWorkspacePath: 'Workflows/pose-clips/hero--src-1d73d9779190b874.pose-clip.v1.json',
      sourceWorkspacePath: 'Workflows/outputs/hero.glb',
      sidecar: (requests[0] as { sidecar: unknown }).sidecar,
    })
    assert.equal('legacySidecarWorkspacePath' in (requests[0] as Record<string, unknown>), false)
    assert.equal(result.success, true)
    assert.deepEqual((requests[0] as { sidecar: { keyframes: { timeSeconds: number }[] } }).sidecar.keyframes.map((keyframe) => keyframe.timeSeconds), [0, 0.1])
    assert.deepEqual(Object.keys((requests[0] as { sidecar: Record<string, unknown> }).sidecar), ['schema', 'version', 'createdAt', 'source', 'skeletonContextId', 'clip', 'skeleton', 'keyframes'])
    assert.equal('currentTimeSeconds' in ((requests[0] as { sidecar: Record<string, unknown> }).sidecar), false)
    assert.equal('selectedKeyframeId' in ((requests[0] as { sidecar: Record<string, unknown> }).sidecar), false)
    assert.equal('selectedBoneId' in ((requests[0] as { sidecar: Record<string, unknown> }).sidecar), false)
    assert.deepEqual(module.resolveViewer3DPoseClipHydrationRequest(rigSummary), {
      sidecarWorkspacePath: 'Workflows/pose-clips/hero--src-1d73d9779190b874.pose-clip.v1.json',
      legacySidecarWorkspacePath: 'Workflows/pose-clips/hero.pose-clip.v1.json',
      sourceWorkspacePath: 'Workflows/outputs/hero.glb',
    })
  } finally {
    await cleanup()
  }
})

test('Viewer3D pose clip save/load refuses unsafe source paths without deriving sidecars or invoking IPC writers', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    for (const sourceWorkspacePath of [undefined, null, '', '/Workflows/outputs/hero.glb', 'C:\\Workflows\\outputs\\hero.glb', 'Workflows\\outputs\\hero.glb', 'Workflows/outputs/../hero.glb']) {
      const unsafeSummary = { ...rigSummary, sourceWorkspacePath } as typeof rigSummary
      let poseState = module.createViewer3DPoseClipState(unsafeSummary)
      poseState = module.reduceViewer3DPoseClipState(poseState, {
        type: 'capture-keyframe',
        summary: unsafeSummary,
        keyframeId: 'kf-unsafe-source',
        boneId: 'rig:hero|skeleton:0|bone:hips#0',
        timeSeconds: 0,
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      })
      const requests: unknown[] = []

      assert.equal(module.resolveViewer3DPoseClipHydrationRequest(unsafeSummary), null, String(sourceWorkspacePath))
      const result = await module.writeViewer3DPoseClipSidecar({
        state: poseState,
        createdAt: '2026-05-20T12:00:00.000Z',
        writer: async (request: unknown) => {
          requests.push(request)
          return { success: true, sidecarWorkspacePath: (request as { sidecarWorkspacePath: string }).sidecarWorkspacePath, sidecar: (request as { sidecar: unknown }).sidecar }
        },
      })

      assert.equal(result.success, false, String(sourceWorkspacePath))
      assert.equal(requests.length, 0, String(sourceWorkspacePath))
    }
  } finally {
    await cleanup()
  }
})

test('Viewer3D Pose/Clip seams avoid FastAPI orchestration, new IPC contracts, and source GLB export mutation paths', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const source = readFileSync(viewer3DEntry, 'utf8')
    const poseClipPanelSource = readFileSync(path.join(projectRoot, 'src/areas/generate/components/PoseClipPanel.tsx'), 'utf8')
    const poseClipPlanSource = readFileSync(path.join(projectRoot, 'src/areas/generate/poseClipPlan.ts'), 'utf8')
    const poseClipPreviewSource = readFileSync(path.join(projectRoot, 'src/areas/generate/poseClipPreview.ts'), 'utf8')
    const poseClipLogic = source.slice(
      source.indexOf('export function createViewer3DPoseClipState'),
      source.indexOf('export default function Viewer3D'),
    )
    const poseClipRuntimeHandlers = source.slice(
      source.indexOf('const handleSavePoseClipSidecar ='),
      source.indexOf('const handleSceneSelect ='),
    )
    const poseClipSource = [poseClipPanelSource, poseClipPlanSource, poseClipPreviewSource, poseClipLogic, poseClipRuntimeHandlers].join('\n')

    assert.equal(module.resolveViewer3DPoseClipHydrationRequest(rigSummary)?.sidecarWorkspacePath, 'Workflows/pose-clips/hero--src-1d73d9779190b874.pose-clip.v1.json')
    assert.match(poseClipRuntimeHandlers, /window\.electron\?\.workspace\?\.artifacts\?\.writePoseClipSidecar/)
    assert.match(poseClipRuntimeHandlers, /window\.electron\?\.workspace\?\.artifacts\?\.readPoseClipSidecar/)
    assert.doesNotMatch(poseClipSource, /fetch\s*\(|axios\.|useGeneration|workflowRun|createFromImage|processRun|FastAPI|8000\/generate|GLTFExporter|exportGLB|writePoseClipEmbedded/i)
    assert.doesNotMatch(poseClipSource, /ipcRenderer\.invoke\(['"](?!workspace:artifacts:(?:write|read)-pose-clip-sidecar)/)
  } finally {
    await cleanup()
  }
})

test('Viewer3D pose clip hydration applies compatible sidecars and warns without retargeting incompatible data', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DPoseClipState(rigSummary)
    const token = module.createViewer3DPoseClipHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })
    const sidecar = {
      schema: 'modly.pose-clip',
      version: 1,
      createdAt: '2026-05-20T00:00:00.000Z',
      source: { workspacePath: 'Workflows/outputs/hero.glb' },
      skeletonContextId: 'rig:hero|skeleton:0',
      clip: { id: 'walk', name: 'Walk', durationSeconds: 1, fps: 24 },
      skeleton: { rootBoneIds: ['rig:hero|skeleton:0|bone:hips#0'], boneCount: 2, bones: [] },
      keyframes: [
        { id: 'kf-1', timeSeconds: 0.1, boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', rotation: { x: 0, y: 0, z: 0, w: 1 } },
        { id: 'kf-missing', timeSeconds: 0.2, boneId: 'display-label-spine', rotation: { x: 1, y: 0, z: 0, w: 0 } },
      ],
    }

    const hydrated = module.applyViewer3DPoseClipHydrationResult({
      state,
      result: { success: true, status: 'found', sidecarWorkspacePath: 'Workflows/pose-clips/hero.pose-clip.v1.json', sidecar },
      token,
      currentToken: token,
    })

    assert.equal(hydrated.state.plan.clip.id, 'walk')
    assert.deepEqual(hydrated.state.plan.keyframes.map((keyframe: { boneId: string }) => keyframe.boneId), ['rig:hero|skeleton:0|bone:hips#0/spine#0'])
    assert.deepEqual(hydrated.warning, { status: 'warning', messages: ['Ignoring pose keyframes for unknown boneId "display-label-spine".'] })

    const invalid = module.applyViewer3DPoseClipHydrationResult({
      state,
      result: { success: false, status: 'invalid', sidecarWorkspacePath: 'Workflows/pose-clips/hero.pose-clip.v1.json', error: 'Pose clip sidecar JSON is invalid.' },
      token,
      currentToken: token,
    })
    assert.deepEqual(invalid.state.plan.keyframes, [])
    assert.deepEqual(invalid.warning, { status: 'warning', messages: ['Pose clip sidecar JSON is invalid.'] })
  } finally {
    await cleanup()
  }
})

test('Viewer3D pose clip hydration resets UI-only playhead and selection while preserving compatible v1 keyframes', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let state = module.createViewer3DPoseClipState(rigSummary)
    state = module.reduceViewer3DPoseClipState(state, { type: 'set-current-time', timeSeconds: 0.75 })
    state = { ...state, selectedKeyframeId: 'stale-ui-selection' }
    const token = module.createViewer3DPoseClipHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })
    const sidecar = {
      schema: 'modly.pose-clip',
      version: 1,
      createdAt: '2026-05-20T12:01:00.000Z',
      source: { workspacePath: 'Workflows/outputs/hero.glb' },
      skeletonContextId: 'rig:hero|skeleton:0',
      clip: { id: 'loaded', name: 'Loaded', durationSeconds: 1, fps: 10 },
      skeleton: { rootBoneIds: ['rig:hero|skeleton:0|bone:hips#0'], boneCount: 2, bones: [] },
      keyframes: [
        { id: 'kf-loaded-0', timeSeconds: 0, boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', rotation: { x: 0, y: 0, z: 0, w: 1 } },
        { id: 'kf-loaded-1', timeSeconds: 0.1, boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', rotation: { x: 0, y: 0.3826834, z: 0, w: 0.9238795 } },
      ],
    }

    const hydrated = module.applyViewer3DPoseClipHydrationResult({
      state,
      result: { success: true, status: 'found', sidecarWorkspacePath: 'Workflows/pose-clips/hero.pose-clip.v1.json', sidecar },
      token,
      currentToken: token,
    })

    assert.equal(hydrated.state.loadState, 'loaded')
    assert.equal(hydrated.state.currentTimeSeconds, 0)
    assert.equal(hydrated.state.selectedKeyframeId, undefined)
    assert.deepEqual(hydrated.state.plan.keyframes.map((keyframe: { id: string; timeSeconds: number }) => [keyframe.id, keyframe.timeSeconds]), [
      ['kf-loaded-0', 0],
      ['kf-loaded-1', 0.1],
    ])
  } finally {
    await cleanup()
  }
})

test('Viewer3D pose clip preview pauses GLTF animation, evaluates stable-id bones, and restores snapshots on reset', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-keyframe',
      summary: rigSummary,
      keyframeId: 'kf-1',
      boneId: 'rig:hero|skeleton:0|bone:hips#0',
      timeSeconds: 0,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    })
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-keyframe',
      summary: rigSummary,
      keyframeId: 'kf-2',
      boneId: 'rig:hero|skeleton:0|bone:hips#0',
      timeSeconds: 1,
      rotation: { x: 0, y: 1, z: 0, w: 0 },
    })
    const hip = new THREE.Bone()
    hip.quaternion.set(0.2, 0.3, 0.4, 0.5).normalize()
    const before = hip.quaternion.clone()
    const gltfAction = { enabled: true, paused: false, play: () => { throw new Error('GLTF animation must stay isolated during pose preview') } }

    const started = module.startViewer3DPoseClipPreview({
      state: poseState,
      bonesById: new Map([['rig:hero|skeleton:0|bone:hips#0', hip]]),
      gltfActions: [gltfAction],
      gltfAnimationPlaying: true,
      timeSeconds: 0.5,
    })

    assert.equal(gltfAction.paused, true)
    assert.equal(started.state.previewState, 'playing')
    assert.equal(started.gltfAnimationSnapshot.wasPlaying, true)
    assert.notDeepEqual(hip.quaternion.toArray(), before.toArray())

    const reset = module.resetViewer3DPoseClipPreview({
      state: started.state,
      bonesById: new Map([['rig:hero|skeleton:0|bone:hips#0', hip]]),
      snapshot: started.poseSnapshot,
    })

    assert.equal(reset.state.previewState, 'idle')
    assert.equal(reset.state.currentTimeSeconds, 0)
    assert.deepEqual(hip.quaternion.toArray(), before.toArray())
  } finally {
    await cleanup()
  }
})

test('Viewer3D timeline scrub restores the pose snapshot before evaluating and keeps GLTF animation isolated', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'set-clip-metadata', summary: rigSummary, durationSeconds: 1, fps: 24 })
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-keyframe',
      summary: rigSummary,
      keyframeId: 'kf-spine-0',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      timeSeconds: 0,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    })
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-keyframe',
      summary: rigSummary,
      keyframeId: 'kf-spine-1',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      timeSeconds: 1,
      rotation: quaternionValue(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI)),
    })
    const hips = new THREE.Bone()
    const spine = new THREE.Bone()
    hips.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 7)
    const originalHips = hips.quaternion.clone()
    const snapshot = module.takeViewer3DPoseClipSnapshot(new Map([
      ['rig:hero|skeleton:0|bone:hips#0', hips],
      ['rig:hero|skeleton:0|bone:hips#0/spine#0', spine],
    ]))
    const gltfAction = { enabled: true, paused: false, play: () => { throw new Error('timeline scrub must not resume GLTF animation') } }
    hips.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)

    const scrubbed = module.scrubViewer3DPoseClipPreviewTime({
      state: { ...poseState, previewState: 'playing' },
      bonesById: new Map([
        ['rig:hero|skeleton:0|bone:hips#0', hips],
        ['rig:hero|skeleton:0|bone:hips#0/spine#0', spine],
      ]),
      poseSnapshot: snapshot,
      gltfActions: [gltfAction],
      gltfAnimationPlaying: true,
      timeSeconds: 0.5,
    })

    assert.equal(scrubbed.state.currentTimeSeconds, 0.5)
    assert.equal(scrubbed.state.previewState, 'paused')
    assert.equal(gltfAction.paused, true)
    assert.deepEqual(scrubbed.gltfAnimationSnapshot, { wasPlaying: true })
    assertQuaternionClose(hips.quaternion, originalHips)
    assertQuaternionClose(spine.quaternion, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2))
  } finally {
    await cleanup()
  }
})

test('Viewer3D selecting and updating keyframes preview from a clean snapshot without mutating the stored snapshot', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'set-clip-metadata', summary: rigSummary, durationSeconds: 1, fps: 10 })
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-keyframe',
      summary: rigSummary,
      keyframeId: 'kf-spine',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      timeSeconds: 0.25,
      rotation: quaternionValue(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 4)),
    })
    const spine = new THREE.Bone()
    spine.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 8)
    const originalSpine = spine.quaternion.clone()
    const bonesById = new Map([['rig:hero|skeleton:0|bone:hips#0/spine#0', spine]])
    const snapshot = module.takeViewer3DPoseClipSnapshot(bonesById)

    spine.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
    const selected = module.selectViewer3DPoseClipKeyframePreview({
      state: poseState,
      summary: rigSummary,
      bonesById,
      poseSnapshot: snapshot,
      gltfActions: [],
      gltfAnimationPlaying: false,
      keyframeId: 'kf-spine',
    })
    assert.equal(selected.state.currentTimeSeconds, 0.25)
    assert.equal(selected.state.selectedKeyframeId, 'kf-spine')
    assertQuaternionClose(snapshot.get('rig:hero|skeleton:0|bone:hips#0/spine#0'), originalSpine)
    assertQuaternionClose(spine.quaternion, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 4))

    const updatedRotation = quaternionValue(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 3))
    const updated = module.updateViewer3DSelectedPoseClipKeyframePreview({
      state: module.reduceViewer3DPoseClipState(selected.state, { type: 'set-current-time', timeSeconds: 0.75 }),
      summary: rigSummary,
      bonesById,
      poseSnapshot: snapshot,
      gltfActions: [],
      gltfAnimationPlaying: false,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      rotation: updatedRotation,
    })

    assert.deepEqual(updated.state.plan.keyframes, [{ id: 'kf-spine', timeSeconds: 0.75, boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', rotation: updatedRotation }])
    assertQuaternionClose(snapshot.get('rig:hero|skeleton:0|bone:hips#0/spine#0'), originalSpine)
    assertQuaternionClose(spine.quaternion, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 3))

    const reset = module.resetViewer3DPoseClipPreview({ state: updated.state, bonesById, snapshot })
    assert.equal(reset.state.previewState, 'idle')
    assertQuaternionClose(spine.quaternion, originalSpine)
  } finally {
    await cleanup()
  }
})

test('Viewer3D applies local Pose/Clip rotation to the selected RigBoneId, snapshots before edit, captures the modified quaternion, and resets without scene contamination', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'select-bone',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    const hips = new THREE.Bone()
    const spine = new THREE.Bone()
    hips.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 8)
    const originalHips = hips.quaternion.clone()
    const originalSpine = spine.quaternion.clone()
    const bonesById = new Map([
      ['rig:hero|skeleton:0|bone:hips#0', hips],
      ['rig:hero|skeleton:0|bone:hips#0/spine#0', spine],
    ])

    const edited = module.applyViewer3DPoseClipLocalRotation({
      state: poseState,
      bonesById,
      poseSnapshot: null,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      axis: 'x',
      degreesDelta: 30,
    })

    assert.equal(edited.result.applied, true)
    assert.notEqual(edited.poseSnapshot, null)
    assert.deepEqual(hips.quaternion.toArray(), originalHips.toArray())
    assert.notDeepEqual(spine.quaternion.toArray(), originalSpine.toArray())

    poseState = module.reduceViewer3DPoseClipState(edited.state, {
      type: 'capture-keyframe',
      summary: rigSummary,
      keyframeId: 'kf-edited-spine',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      timeSeconds: 0.5,
      rotation: edited.result.rotation,
    })
    assert.deepEqual(poseState.plan.keyframes[0].rotation, edited.result.rotation)

    const reset = module.resetViewer3DPoseClipSelectedBone({
      state: poseState,
      bonesById,
      snapshot: edited.poseSnapshot,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })

    assert.deepEqual(reset.restoredBoneIds, ['rig:hero|skeleton:0|bone:hips#0/spine#0'])
    assert.deepEqual(spine.quaternion.toArray(), originalSpine.toArray())
    assert.deepEqual(hips.quaternion.toArray(), originalHips.toArray())
  } finally {
    await cleanup()
  }
})

test('Viewer3D pose clip timeline state clamps current time and keeps selection/playhead out of the sidecar', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'set-clip-metadata',
      summary: rigSummary,
      durationSeconds: 2,
      fps: 10,
    })
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'set-current-time', timeSeconds: 3 })
    assert.equal(poseState.currentTimeSeconds, 2)

    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'set-current-time', timeSeconds: -1 })
    assert.equal(poseState.currentTimeSeconds, 0)

    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-and-advance',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0',
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    })
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'select-keyframe', summary: rigSummary, keyframeId: poseState.plan.keyframes[0].id })

    const requests: unknown[] = []
    await module.writeViewer3DPoseClipSidecar({
      state: poseState,
      createdAt: '2026-05-20T00:00:00.000Z',
      writer: async (request: unknown) => {
        requests.push(request)
        return { success: true, sidecarWorkspacePath: 'Workflows/pose-clips/hero.pose-clip.v1.json', sidecar: (request as { sidecar: unknown }).sidecar }
      },
    })

    assert.equal(poseState.selectedKeyframeId, poseState.plan.keyframes[0].id)
    assert.equal('selectedKeyframeId' in ((requests[0] as { sidecar: Record<string, unknown> }).sidecar), false)
    assert.equal('currentTimeSeconds' in ((requests[0] as { sidecar: Record<string, unknown> }).sidecar), false)
  } finally {
    await cleanup()
  }
})

test('Viewer3D capture-and-advance captures at current time and advances by the default FPS step', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'set-clip-metadata', summary: rigSummary, durationSeconds: 1, fps: 10 })

    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-and-advance',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      rotation: { x: 0, y: 0.3826834, z: 0, w: 0.9238795 },
    })
    assert.equal(poseState.plan.keyframes[0].timeSeconds, 0)
    assert.equal(poseState.currentTimeSeconds, 0.1)

    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-and-advance',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      rotation: { x: 0, y: 0.7071068, z: 0, w: 0.7071068 },
    })

    assert.deepEqual(poseState.plan.keyframes.map((keyframe: { timeSeconds: number }) => keyframe.timeSeconds), [0, 0.1])
    assert.equal(poseState.currentTimeSeconds, 0.2)
    assert.equal(poseState.selectedKeyframeId, poseState.plan.keyframes[1].id)
  } finally {
    await cleanup()
  }
})

test('Viewer3D legacy capture callback path derives deterministic IDs from bone, time, and FPS', async () => {
  const { module, cleanup } = await loadViewer3DModule()
  const originalDateNow = Date.now

  try {
    Date.now = () => 987654321
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'set-clip-metadata', summary: rigSummary, durationSeconds: 1, fps: 10 })
    const spineBoneId = 'rig:hero|skeleton:0|bone:hips#0/spine#0'
    const panelProps = module.resolveViewer3DPoseClipPanelProps(poseState, {
      onCaptureKeyframe: (boneId: string, timeSeconds: number) => {
        poseState = module.reduceViewer3DPoseClipState(poseState, {
          type: 'capture-keyframe',
          summary: rigSummary,
          boneId,
          timeSeconds,
          rotation: { x: 0, y: 0.3826834, z: 0, w: 0.9238795 },
        })
      },
    })

    panelProps.onCaptureKeyframe(spineBoneId, 0.25)
    panelProps.onCaptureKeyframe(spineBoneId, 0.25)

    assert.deepEqual(poseState.plan.keyframes.map((keyframe: { id: string }) => keyframe.id), [
      'kf-rig-hero-skeleton-0-bone-hips-0-spine-0-t0p250-f3-1',
      'kf-rig-hero-skeleton-0-bone-hips-0-spine-0-t0p250-f3-2',
    ])
    assert.equal(poseState.plan.keyframes.some((keyframe: { id: string }) => keyframe.id.includes('987654321')), false)
    assert.deepEqual(poseState.plan.keyframes.map((keyframe: { timeSeconds: number }) => keyframe.timeSeconds), [0.25, 0.25])
    assert.equal(poseState.selectedKeyframeId, 'kf-rig-hero-skeleton-0-bone-hips-0-spine-0-t0p250-f3-2')
  } finally {
    Date.now = originalDateNow
    await cleanup()
  }
})

test('Viewer3D minimized Pose/Clip panel props preserve stable capture IDs and display-only effective labels', async () => {
  const { module, cleanup } = await loadViewer3DModule()
  const originalDateNow = Date.now

  try {
    Date.now = () => 987654321
    let rigState = module.createViewer3DRigEditorState(rigSummary)
    rigState = module.reduceViewer3DRigEditorState(rigState, {
      type: 'set-alias',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      alias: 'Manual Chest',
    })
    rigState = {
      ...rigState,
      rigMetaNamingByBoneId: {
        'rig:hero|skeleton:0|bone:hips#0/spine#0': { label: 'UniRig Spine', source: 'humanoid_contract' },
      },
    }
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'set-clip-metadata', summary: rigSummary, durationSeconds: 1, fps: 10 })
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'select-bone',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    const effectiveNaming = module.resolveViewer3DRigEditorPanelProps(rigState, {}).effectiveNaming
    const calls: string[] = []
    const panelProps = module.resolveViewer3DPoseClipPanelProps(
      poseState,
      {
        drawerMode: 'minimized',
        onDrawerModeChange: () => calls.push('drawer-mode-changed'),
        onCurrentTimeChange: (timeSeconds: number) => {
          calls.push(`time:${timeSeconds}`)
          poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'set-current-time', timeSeconds })
        },
        onCaptureKeyframe: (boneId: string, timeSeconds: number) => {
          calls.push(`capture:${boneId}:${timeSeconds}`)
          poseState = module.reduceViewer3DPoseClipState(poseState, {
            type: 'capture-keyframe',
            summary: rigSummary,
            boneId,
            timeSeconds,
            rotation: { x: 0, y: 0.3826834, z: 0, w: 0.9238795 },
          })
        },
        onPreviewPlay: () => calls.push('preview:play'),
        onPreviewReset: () => calls.push('preview:reset'),
        onSaveSidecar: () => calls.push('sidecar:save'),
        onLoadSidecar: () => calls.push('sidecar:load'),
      },
      effectiveNaming,
    )

    assert.equal(panelProps.drawerMode, undefined)
    assert.equal(panelProps.onDrawerModeChange, undefined)
    assert.equal(panelProps.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.equal(panelProps.rigDisplayNames.byBoneId['rig:hero|skeleton:0|bone:hips#0/spine#0'].label, 'Manual Chest')

    panelProps.onCurrentTimeChange(0.25)
    panelProps.onCaptureKeyframe(panelProps.selectedBoneId, 0.25)
    panelProps.onCaptureKeyframe(panelProps.selectedBoneId, 0.25)
    panelProps.onPreviewPlay()
    panelProps.onPreviewReset()
    panelProps.onSaveSidecar()
    panelProps.onLoadSidecar()

    assert.deepEqual(calls, [
      'time:0.25',
      'capture:rig:hero|skeleton:0|bone:hips#0/spine#0:0.25',
      'capture:rig:hero|skeleton:0|bone:hips#0/spine#0:0.25',
      'preview:play',
      'preview:reset',
      'sidecar:save',
      'sidecar:load',
    ])
    assert.equal(calls.some((call) => /Manual|UniRig|Spine/.test(call)), false)
    assert.deepEqual(poseState.plan.keyframes.map((keyframe: { id: string }) => keyframe.id), [
      'kf-rig-hero-skeleton-0-bone-hips-0-spine-0-t0p250-f3-1',
      'kf-rig-hero-skeleton-0-bone-hips-0-spine-0-t0p250-f3-2',
    ])
    assert.equal(poseState.plan.keyframes.some((keyframe: { id: string }) => keyframe.id.includes('987654321')), false)
  } finally {
    Date.now = originalDateNow
    await cleanup()
  }
})

test('Viewer3D selecting a pose keyframe positions playhead and selected target safely', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-keyframe',
      summary: rigSummary,
      keyframeId: 'kf-spine',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      timeSeconds: 0.5,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    })

    const selected = module.reduceViewer3DPoseClipState(poseState, { type: 'select-keyframe', summary: rigSummary, keyframeId: 'kf-spine' })
    assert.equal(selected.selectedKeyframeId, 'kf-spine')
    assert.equal(selected.currentTimeSeconds, 0.5)
    assert.equal(selected.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.equal(selected.plan.selectedBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')

    const invalid = module.reduceViewer3DPoseClipState(selected, { type: 'select-keyframe', summary: rigSummary, keyframeId: 'missing' })
    assert.equal(invalid.selectedKeyframeId, undefined)
    assert.equal(invalid.currentTimeSeconds, 0.5)
  } finally {
    await cleanup()
  }
})

test('Viewer3D updates and deletes the selected keyframe from current pose/time while preserving stable ids', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-keyframe',
      summary: rigSummary,
      keyframeId: 'kf-spine',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      timeSeconds: 0.25,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    })
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'select-keyframe', summary: rigSummary, keyframeId: 'kf-spine' })
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'set-current-time', timeSeconds: 0.75 })
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'update-selected-keyframe',
      summary: rigSummary,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      rotation: { x: 0.3826834, y: 0, z: 0, w: 0.9238795 },
    })

    assert.deepEqual(poseState.plan.keyframes, [{
      id: 'kf-spine',
      timeSeconds: 0.75,
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      rotation: { x: 0.3826834, y: 0, z: 0, w: 0.9238795 },
    }])
    assert.equal(poseState.selectedKeyframeId, 'kf-spine')

    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'delete-selected-keyframe', summary: rigSummary })
    assert.deepEqual(poseState.plan.keyframes, [])
    assert.equal(poseState.selectedKeyframeId, undefined)
  } finally {
    await cleanup()
  }
})

test('Viewer3D moves, shifts, and duplicates the selected keyframe through pure timeline helpers', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let poseState = module.createViewer3DPoseClipState(rigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'set-clip-metadata', summary: rigSummary, durationSeconds: 1, fps: 10 })
    poseState = module.reduceViewer3DPoseClipState(poseState, {
      type: 'capture-keyframe',
      summary: rigSummary,
      keyframeId: 'kf-spine',
      boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
      timeSeconds: 0.4,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    })
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'select-keyframe', summary: rigSummary, keyframeId: 'kf-spine' })

    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'move-selected-keyframe', summary: rigSummary, timeSeconds: 2 })
    assert.equal(poseState.plan.keyframes[0].timeSeconds, 1)
    assert.equal(poseState.currentTimeSeconds, 1)
    assert.equal(poseState.selectedKeyframeId, 'kf-spine')

    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'shift-selected-keyframe', summary: rigSummary, deltaSeconds: -0.25 })
    assert.equal(poseState.plan.keyframes[0].timeSeconds, 0.75)
    assert.equal(poseState.currentTimeSeconds, 0.75)

    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'duplicate-selected-keyframe', summary: rigSummary })
    assert.deepEqual(poseState.plan.keyframes.map((keyframe: { id: string }) => keyframe.id), ['kf-spine', 'kf-spine__copy-1'])
    assert.equal(poseState.selectedKeyframeId, 'kf-spine__copy-1')
    assert.equal(poseState.currentTimeSeconds, 0.85)
  } finally {
    await cleanup()
  }
})

test('resolveViewer3DOverlayLayout gives Motion Retarget its own non-overlapping right-panel slot', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const stackedLayout = module.resolveViewer3DOverlayLayout({
      modelUrl: 'model.glb',
      hasEditRail: true,
      rigEditorVisibility: { isOpen: true },
      motionRetargetVisibility: { isOpen: true },
    })

    assert.equal(stackedLayout.rigEditorPanelSlot, 'top-right')
    assert.equal(stackedLayout.motionRetargetPanelSlot, 'top-right-stack')
    assert.equal(stackedLayout.poseClipPanelSlot, 'bottom-drawer')
    assert.notEqual(stackedLayout.motionRetargetPanelSlot, stackedLayout.poseClipPanelSlot)
    assert.match(stackedLayout.motionRetargetPanelClassName, /right-16/)
    assert.match(stackedLayout.motionRetargetPanelClassName, /top-\[/)

    const soloLayout = module.resolveViewer3DOverlayLayout({
      modelUrl: 'model.glb',
      hasEditRail: true,
      rigEditorVisibility: { isOpen: false },
      motionRetargetVisibility: { isOpen: true },
    })

    assert.equal(soloLayout.motionRetargetPanelSlot, 'top-right-stack')
    assert.match(soloLayout.motionRetargetPanelClassName, /top-4/)
  } finally {
    await cleanup()
  }
})
test('Viewer3D never exposes Motion Retarget toolbar controls in the normal authoring rail', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const hiddenControls = module.resolveViewer3DMotionRetargetToolbarControls({
      modelUrl: null,
      summary: rigSummary,
      visibility: module.createViewer3DMotionRetargetVisibilityState(rigSummary),
      onOpenMotionRetarget: () => undefined,
    })

    assert.equal(hiddenControls, undefined)

    let visibility = module.createViewer3DMotionRetargetVisibilityState(rigSummary)
    const visibleControls = module.resolveViewer3DMotionRetargetToolbarControls({
      modelUrl: 'hero.glb',
      summary: rigSummary,
      visibility,
      onOpenMotionRetarget: () => undefined,
    })

    assert.equal(visibleControls, undefined)

    visibility = module.reduceViewer3DMotionRetargetVisibilityState(visibility, { type: 'toggle', summary: rigSummary })
    assert.equal(visibility.isOpen, true)

    const openControls = module.resolveViewer3DMotionRetargetToolbarControls({
      modelUrl: 'hero.glb',
      summary: rigSummary,
      visibility,
      onOpenMotionRetarget: () => undefined,
    })

    assert.equal(openControls, undefined)
    assert.equal(module.createViewer3DRigEditorVisibilityState(rigSummary).isOpen, false)
    assert.deepEqual(module.createViewer3DPoseClipVisibilityState(rigSummary), {
      isOpen: false,
      skeletonContextId: rigSummary.skeletonContextId,
      drawerMode: 'minimized',
    })
  } finally {
    await cleanup()
  }
})
test('Viewer3D preserves Motion Retarget internals but normal panel render state stays hidden', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let motionState = module.createViewer3DMotionRetargetState(rigSummary, motionRetargetSession)
    let visibility = module.createViewer3DMotionRetargetVisibilityState(rigSummary)

    assert.equal(motionState.selectedSourceBoneId, 'source:hips')
    assert.equal(module.resolveViewer3DMotionRetargetPanelRenderState({ modelUrl: 'hero.glb', motionRetargetState: motionState, visibility }).shouldRenderPanel, false)

    visibility = module.reduceViewer3DMotionRetargetVisibilityState(visibility, { type: 'toggle', summary: rigSummary })
    motionState = module.reduceViewer3DMotionRetargetState(motionState, { type: 'select-source-bone', sourceBoneId: 'source:spine' })
    motionState = module.reduceViewer3DMotionRetargetState(motionState, { type: 'set-preview', selectedPreview: 'preview-glb' })

    const selections: string[] = []
    const previews: string[] = []
    const panelProps = module.resolveViewer3DMotionRetargetPanelProps(motionState, {
      onSelectSourceBone: (sourceBoneId: string) => selections.push(sourceBoneId),
      onSelectPreview: (selectedPreview: string) => previews.push(selectedPreview),
    })

    assert.equal(module.resolveViewer3DMotionRetargetPanelRenderState({ modelUrl: 'hero.glb', motionRetargetState: motionState, visibility }).shouldRenderPanel, false)
    assert.equal(panelProps.summary, rigSummary)
    assert.equal(panelProps.selectedSourceBoneId, 'source:spine')
    assert.equal(panelProps.session.selectedPreview, 'preview-glb')
    assert.equal(panelProps.selectedMapping.targetLabel, 'Manual Chest')
    assert.equal(panelProps.selectedMapping.targetLabelProvenance, 'manual')
    assert.deepEqual(panelProps.warnings, motionRetargetSession.warnings)
    assert.equal(panelProps.saveDisabledReason, undefined)

    panelProps.onSelectSourceBone('source:hips')
    panelProps.onSelectPreview('animated-glb')

    assert.deepEqual(selections, ['source:hips'])
    assert.deepEqual(previews, ['animated-glb'])
  } finally {
    await cleanup()
  }
})
test('Viewer3D saves Motion Retarget sidecars through preload with workspace-safe source and session provenance', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const motionState = module.createViewer3DMotionRetargetState(rigSummary, motionRetargetSession)
    const requests: unknown[] = []

    const result = await module.writeViewer3DMotionRetargetSidecar({
      state: motionState,
      createdAt: '2026-05-21T18:30:00.000Z',
      writer: async (request: unknown) => {
        requests.push(request)
        return {
          success: true,
          sidecarWorkspacePath: (request as { sidecarWorkspacePath: string }).sidecarWorkspacePath,
          sidecar: (request as { sidecar: unknown }).sidecar,
        }
      },
    })

    assert.equal(requests.length, 1)
    assert.match((requests[0] as { sidecarWorkspacePath: string }).sidecarWorkspacePath, /^Workflows\/motion-retarget\/mrt_[a-f0-9]{16}\.motion-retarget\.v1\.json$/)
    assert.equal((requests[0] as { sourceWorkspacePath: string }).sourceWorkspacePath, 'Workflows/outputs/hero.glb')
    assert.equal((requests[0] as { sidecar: { schema: string } }).sidecar.schema, 'modly.motion-retarget')
    assert.match((requests[0] as { sidecar: { identity: { key: string } } }).sidecar.identity.key, /^mrt_[a-f0-9]{16}$/)
    assert.equal((requests[0] as { sidecar: { identity: { sourceWorkspacePath: string; skeletonContextId: string; workflowId: string; artifactWorkspacePath: string } } }).sidecar.identity.sourceWorkspacePath, 'Workflows/outputs/hero.glb')
    assert.equal((requests[0] as { sidecar: { identity: { skeletonContextId: string } } }).sidecar.identity.skeletonContextId, 'rig:hero|skeleton:0')
    assert.equal((requests[0] as { sidecar: { identity: { workflowId: string } } }).sidecar.identity.workflowId, 'workflow-hero')
    assert.equal((requests[0] as { sidecar: { identity: { artifactWorkspacePath: string } } }).sidecar.identity.artifactWorkspacePath, 'Workflows/kimodo/run-1/animated.glb')
    assert.equal((requests[0] as { sidecar: { source: { workspacePath: string } } }).sidecar.source.workspacePath, 'Workflows/outputs/hero.glb')
    assert.equal((requests[0] as { sidecar: { artifact: { workflowId?: string; workflowNodeId?: string } } }).sidecar.artifact.workflowId, 'workflow-hero')
    assert.equal((requests[0] as { sidecar: { artifact: { workflowId?: string; workflowNodeId?: string } } }).sidecar.artifact.workflowNodeId, 'node-animate')
    assert.deepEqual((requests[0] as { sidecar: { session: { selectedPreview: string; mappings: Record<string, { targetBoneId?: string }> } } }).sidecar.session, {
      selectedPreview: 'animated-glb',
      mappings: {
        'source:hips': { targetBoneId: 'rig:hero|skeleton:0|bone:hips#0' },
        'source:spine': { targetBoneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0' },
      },
    })
    assert.deepEqual((requests[0] as { sidecar: { corrections: unknown } }).sidecar.corrections, {
      rootTranslationPolicy: 'solver',
      rootMotionScale: 1,
      rootOffset: { x: 0, y: 0, z: 0 },
      previewMode: 'after',
    })
    assert.deepEqual(result, {
      success: true,
      sidecarWorkspacePath: (requests[0] as { sidecarWorkspacePath: string }).sidecarWorkspacePath,
      sidecar: (requests[0] as { sidecar: unknown }).sidecar,
    })
    assert.deepEqual(module.resolveViewer3DMotionRetargetHydrationRequest(rigSummary, motionRetargetSession), {
      sidecarWorkspacePath: (requests[0] as { sidecarWorkspacePath: string }).sidecarWorkspacePath,
      sourceWorkspacePath: 'Workflows/outputs/hero.glb',
    })
  } finally {
    await cleanup()
  }
})
test('Viewer3D loads Motion Retarget sidecars into renderer-owned session state while preserving mapping, readiness, and warnings', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DMotionRetargetState(rigSummary)
    const token = module.createViewer3DMotionRetargetHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })
    const sidecar = {
      schema: 'modly.motion-retarget',
      version: 1,
      createdAt: '2026-05-21T18:30:00.000Z',
      source: { workspacePath: 'Workflows/outputs/hero.glb' },
      identity: module.createViewer3DMotionRetargetCorrectionIdentity({ summary: rigSummary, session: motionRetargetSession }),
      artifact: structuredClone(motionRetargetSession.artifact),
      sourceBones: structuredClone(motionRetargetSession.sourceBones),
      session: {
        selectedPreview: 'preview-glb',
        mappings: {
          'source:hips': { targetBoneId: 'rig:hero|skeleton:0|bone:hips#0' },
          'source:spine': { targetBoneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0' },
        },
      },
      warnings: ['Root-motion correctness is deferred.', 'Loaded from sidecar.'],
      corrections: {
        rootTranslationPolicy: 'preserve_scaled_npz',
        rootMotionScale: 1.4,
        rootOffset: { x: 0.2, y: 0, z: -0.2 },
        previewMode: 'after',
      },
    }

    const hydrated = module.applyViewer3DMotionRetargetHydrationResult({
      state,
      result: { success: true, status: 'found', sidecarWorkspacePath: 'Workflows/motion-retarget/hero.motion-retarget.v1.json', sidecar },
      token,
      currentToken: token,
    })

    assert.equal(hydrated.state.session?.selectedPreview, 'preview-glb')
    assert.equal(hydrated.state.session?.mappings['source:hips']?.targetBoneId, 'rig:hero|skeleton:0|bone:hips#0')
    assert.equal(hydrated.state.session?.mappings['source:spine']?.targetBoneId, 'rig:hero|skeleton:0|bone:hips#0/spine#0')
    assert.equal(hydrated.state.session?.exportReadiness.canSaveSidecar, true)
    assert.equal(hydrated.state.session?.exportReadiness.canExportPoseClip, true)
    assert.deepEqual(hydrated.state.diagnosticsMessages, ['Loaded from sidecar.'])
    assert.equal(hydrated.state.loadState, 'loaded')
    assert.equal(hydrated.state.correctionState.status, 'loaded')
    assert.equal(hydrated.state.corrections.rootMotionScale, 1.4)
    assert.equal(hydrated.state.selectedSourceBoneId, 'source:hips')
  } finally {
    await cleanup()
  }
})
test('Viewer3D Motion Retarget correction hydration is identity-bound and does not overwrite dirty local edits', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const cleanState = module.createViewer3DMotionRetargetState(rigSummary, motionRetargetSession)
    const dirtyState = module.reduceViewer3DMotionRetargetState(cleanState, {
      type: 'set-mapping',
      sourceBoneId: 'source:spine',
      targetBoneId: 'rig:hero|skeleton:0|bone:hips#0',
    })
    const token = module.createViewer3DMotionRetargetHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })
    const matchingIdentity = module.createViewer3DMotionRetargetCorrectionIdentity({ summary: rigSummary, session: motionRetargetSession })
    const otherSession = {
      ...motionRetargetSession,
      artifact: {
        ...motionRetargetSession.artifact,
        workflowId: 'workflow-other',
        bundleWorkspacePath: 'Workflows/kimodo/other',
        metadataWorkspacePath: 'Workflows/kimodo/other/metadata.json',
      },
    }
    const mismatchedIdentity = module.createViewer3DMotionRetargetCorrectionIdentity({ summary: rigSummary, session: otherSession })
    const sidecar = {
      schema: 'modly.motion-retarget',
      version: 1,
      createdAt: '2026-05-24T20:20:00.000Z',
      source: { workspacePath: 'Workflows/outputs/hero.glb' },
      identity: matchingIdentity,
      artifact: structuredClone(motionRetargetSession.artifact),
      sourceBones: structuredClone(motionRetargetSession.sourceBones),
      session: {
        selectedPreview: 'preview-glb',
        mappings: {
          'source:hips': { targetBoneId: 'rig:hero|skeleton:0|bone:hips#0' },
        },
      },
      corrections: {
        rootTranslationPolicy: 'solver',
        rootMotionScale: 1,
        rootOffset: { x: 0, y: 0, z: 0 },
        previewMode: 'after',
      },
      warnings: [],
    }

    const dirtySkipped = module.applyViewer3DMotionRetargetHydrationResult({
      state: dirtyState,
      result: { success: true, status: 'found', sidecarWorkspacePath: 'Workflows/motion-retarget/mrt_dirty.motion-retarget.v1.json', sidecar },
      token,
      currentToken: token,
    })
    const identityRejected = module.applyViewer3DMotionRetargetHydrationResult({
      state: cleanState,
      result: { success: true, status: 'found', sidecarWorkspacePath: 'Workflows/motion-retarget/mrt_other.motion-retarget.v1.json', sidecar: { ...sidecar, identity: mismatchedIdentity } },
      token,
      currentToken: token,
    })
    const reopened = module.applyViewer3DMotionRetargetHydrationResult({
      state: module.createViewer3DMotionRetargetState(rigSummary, motionRetargetSession),
      result: { success: true, status: 'found', sidecarWorkspacePath: 'Workflows/motion-retarget/mrt_match.motion-retarget.v1.json', sidecar },
      token,
      currentToken: token,
    })

    assert.equal(dirtyState.correctionState.status, 'dirty')
    assert.equal(dirtySkipped.dirtySkipped, true)
    assert.equal(dirtySkipped.state.session.mappings['source:spine']?.targetBoneId, 'rig:hero|skeleton:0|bone:hips#0')
    assert.equal(identityRejected.state.loadState, 'error')
    assert.match(identityRejected.state.loadMessage, /different workflow\/artifact identity/i)
    assert.equal(reopened.state.loadState, 'loaded')
    assert.equal(reopened.state.session.selectedPreview, 'preview-glb')
    assert.equal(reopened.state.session.mappings['source:hips']?.targetBoneId, 'rig:hero|skeleton:0|bone:hips#0')
  } finally {
    await cleanup()
  }
})
test('Viewer3D motion retarget hydration surfaces non-blocking warnings for invalid, not-found, and diagnostics-only states without fabricating mappings', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const emptyState = module.createViewer3DMotionRetargetState(rigSummary)
    const token = module.createViewer3DMotionRetargetHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })

    const notFound = module.applyViewer3DMotionRetargetHydrationResult({
      state: emptyState,
      result: { success: true, status: 'not-found', sidecarWorkspacePath: 'Workflows/motion-retarget/hero.motion-retarget.v1.json' },
      token,
      currentToken: token,
    })
    assert.equal(notFound.state.session, undefined)
    assert.match(notFound.state.diagnosticsMessages.join('\n'), /not found/i)

    const invalid = module.applyViewer3DMotionRetargetHydrationResult({
      state: emptyState,
      result: { success: false, status: 'invalid', sidecarWorkspacePath: 'Workflows/motion-retarget/hero.motion-retarget.v1.json', error: 'Motion retarget sidecar JSON is invalid.' },
      token,
      currentToken: token,
    })
    assert.equal(invalid.state.session, undefined)
    assert.deepEqual(invalid.state.diagnosticsMessages, ['Motion retarget sidecar JSON is invalid.'])

    const diagnosticsOnly = module.createViewer3DMotionRetargetState(rigSummary, {
      ...motionRetargetSession,
      artifact: { ...motionRetargetSession.artifact, motionRetarget: undefined },
      sourceBones: [],
      mappings: {},
      exportReadiness: {
        ...motionRetargetSession.exportReadiness,
        canSaveSidecar: false,
      },
    })
    const panelProps = module.resolveViewer3DMotionRetargetPanelProps(diagnosticsOnly, {})
    assert.equal(panelProps.session?.exportReadiness.canSaveSidecar, false)
    assert.match(panelProps.saveDisabledReason ?? '', /trusted Kimodo motion payload/i)
  } finally {
    await cleanup()
  }
})
test('Viewer3D exposes trusted Motion Retarget unlock readiness only when translated Kimodo metadata is present', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const readyPanelProps = module.resolveViewer3DMotionRetargetPanelProps(
      module.createViewer3DMotionRetargetState(rigSummary, motionRetargetSession),
      {},
    )
    const blockedPanelProps = module.resolveViewer3DMotionRetargetPanelProps(
      module.createViewer3DMotionRetargetState(rigSummary, {
        ...motionRetargetSession,
        artifact: {
          ...motionRetargetSession.artifact,
          motionRetarget: undefined,
        },
        exportReadiness: {
          canSaveSidecar: false,
          canExportPoseClip: false,
          blockingWarnings: ['Trusted Kimodo motion payload is unavailable.'],
        },
        unlockReadiness: {
          trustedPayloadReady: false,
          translationReady: false,
          showSourceBones: false,
          showMappingDisplay: false,
          canPreview: false,
          canSaveSidecar: false,
          canExportPoseClip: false,
          blockingWarnings: ['Trusted Kimodo motion payload is unavailable.'],
        },
      }),
      {},
    )

    assert.equal(readyPanelProps.exportDisabledReason, undefined)
    assert.equal(blockedPanelProps.exportDisabledReason, 'Companion export is unavailable until Modly validates a trusted Kimodo motion payload with a safe Pose/Clip companion output path.')
    assert.equal(readyPanelProps.previewDisabledReason, undefined)
    assert.equal(readyPanelProps.previewDurationSeconds, 1.5)
    assert.equal(blockedPanelProps.previewDisabledReason, 'Local preview is unavailable until Modly validates a trusted Kimodo motion payload with complete translated quaternion tracks.')
  } finally {
    await cleanup()
  }
})
test('Viewer3D local Motion Retarget preview scrubs rotation-only quaternions, resets from the pre-preview snapshot, and leaves Pose/Clip state untouched', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const poseState = module.reduceViewer3DPoseClipState(module.createViewer3DPoseClipState(rigSummary), {
      type: 'set-preview',
      previewState: 'playing',
      currentTimeSeconds: 0.25,
    })
    const poseStateBefore = structuredClone(poseState)
    const motionState = module.createViewer3DMotionRetargetState(rigSummary, motionRetargetSession)
    const hips = new THREE.Bone()
    const spine = new THREE.Bone()
    hips.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 7)
    spine.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 9)
    const originalHips = hips.quaternion.clone()
    const originalSpine = spine.quaternion.clone()
    const hipsPositionBefore = hips.position.clone()
    const spineScaleBefore = spine.scale.clone()
    const bonesById = new Map([
      ['rig:hero|skeleton:0|bone:hips#0', hips],
      ['rig:hero|skeleton:0|bone:hips#0/spine#0', spine],
    ])
    const gltfAction = { enabled: true, paused: false, play: () => { throw new Error('motion retarget scrub must not resume GLTF animation') } }

    const started = module.startViewer3DMotionRetargetPreview({
      state: motionState,
      bonesById,
      poseSnapshot: null,
      gltfActions: [gltfAction],
      gltfAnimationPlaying: true,
      timeSeconds: 0.5,
    })

    assert.equal(started.state.previewState, 'playing')
    assert.equal(started.state.previewCurrentTimeSeconds, 0.5)
    assert.equal(gltfAction.paused, true)
    assertQuaternionClose(hips.quaternion, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2))
    assertQuaternionClose(spine.quaternion, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2))
    assert.deepEqual(hips.position.toArray(), hipsPositionBefore.toArray())
    assert.deepEqual(spine.scale.toArray(), spineScaleBefore.toArray())

    hips.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 4)
    const scrubbed = module.scrubViewer3DMotionRetargetPreviewTime({
      state: started.state,
      bonesById,
      poseSnapshot: started.poseSnapshot,
      gltfActions: [gltfAction],
      gltfAnimationPlaying: true,
      timeSeconds: 1,
    })

    assert.equal(scrubbed.state.previewState, 'paused')
    assert.equal(scrubbed.state.previewCurrentTimeSeconds, 1)
    assertQuaternionClose(hips.quaternion, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI))
    assertQuaternionClose(spine.quaternion, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI))

    const reset = module.resetViewer3DMotionRetargetPreview({
      state: scrubbed.state,
      bonesById,
      snapshot: scrubbed.poseSnapshot,
    })

    assert.equal(reset.state.previewState, 'idle')
    assert.equal(reset.state.previewCurrentTimeSeconds, 0)
    assertQuaternionClose(hips.quaternion, originalHips)
    assertQuaternionClose(spine.quaternion, originalSpine)
    assert.deepEqual(poseState, poseStateBefore)
  } finally {
    await cleanup()
  }
})
test('Viewer3D disables unsafe local Motion Retarget preview copy without blocking sidecar save or PoseClip export', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const disabledCopy = 'Local rotation preview disabled because Kimodo omitted basis/rest-pose evidence; use animated GLB playback or export sidecar for rerun.'
    const state = module.createViewer3DMotionRetargetState(rigSummary, {
      ...motionRetargetSession,
      artifact: { ...motionRetargetSession.artifact, motionRetarget: { ...motionRetargetSession.artifact.motionRetarget, omittedChannels: [{ channel: 'basis_rest_pose', reason: 'Fixture has no basis evidence.' }] } },
      warnings: [disabledCopy],
      exportReadiness: {
        canSaveSidecar: true,
        canExportPoseClip: true,
        blockingWarnings: [disabledCopy],
      },
      unlockReadiness: {
        ...motionRetargetSession.unlockReadiness,
        localRetargetReady: false,
        canPreview: false,
        canSaveSidecar: true,
        canExportPoseClip: true,
        blockingWarnings: [disabledCopy],
      },
    })
    const panelProps = module.resolveViewer3DMotionRetargetPanelProps(state, {})
    const hips = new THREE.Bone()
    const beforeQuaternion = hips.quaternion.clone()
    const started = module.startViewer3DMotionRetargetPreview({
      state,
      bonesById: new Map([['rig:hero|skeleton:0|bone:hips#0', hips]]),
      poseSnapshot: null,
      gltfActions: [],
      gltfAnimationPlaying: false,
      timeSeconds: 0.5,
    })

    assert.equal(panelProps.previewDisabledReason, disabledCopy)
    assert.equal(panelProps.saveDisabledReason, undefined)
    assert.equal(panelProps.exportDisabledReason, undefined)
    assert.equal(started.state.previewState, 'idle')
    assert.equal(started.preview, null)
    assertQuaternionClose(hips.quaternion, beforeQuaternion)
  } finally {
    await cleanup()
  }
})
test('Viewer3D active Motion Retarget reset stops animated GLB playback, clears playing state, and seeks time zero', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const calls: string[] = []
    const action = {
      enabled: true,
      paused: false,
      time: 1.5,
      play() { calls.push('play'); return this },
      stop() { calls.push('stop'); return this },
      reset() { calls.push('reset'); return this },
    }
    const mixer = {
      time: 1.5,
      setTime(timeSeconds: number) {
        calls.push(`setTime:${timeSeconds}`)
        this.time = timeSeconds
      },
    }
    const state = module.reduceViewer3DMotionRetargetState(
      module.createViewer3DMotionRetargetState(rigSummary, motionRetargetSession),
      { type: 'set-preview-state', previewState: 'playing', timeSeconds: 0.75 },
    )

    const reset = module.resetViewer3DActiveMotionPlayback({
      state,
      activeBackend: 'animated-glb',
      bonesById: new Map(),
      localSnapshot: null,
      animation: { actions: [action], mixer, playing: true },
    })

    assert.deepEqual(calls, ['stop', 'reset', 'setTime:0'])
    assert.equal(action.enabled, false)
    assert.equal(action.paused, false)
    assert.equal(action.time, 0)
    assert.equal(mixer.time, 0)
    assert.equal(reset.animationPlaying, false)
    assert.equal(reset.state.previewState, 'idle')
    assert.equal(reset.state.previewCurrentTimeSeconds, 0)
    assert.equal(reset.localSnapshot, null)
    assert.deepEqual(reset.reset, { resetActionCount: 1, mixerTimeSeconds: 0 })
  } finally {
    await cleanup()
  }
})
test('Viewer3D active Motion Retarget reset restores only local preview snapshot when local retarget preview owns playback', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const hips = new THREE.Bone()
    hips.position.set(1, 2, 3)
    hips.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4)
    hips.scale.set(2, 2, 2)
    const bonesById = new Map([['rig:hero|skeleton:0|bone:hips#0', hips]])
    const snapshot = module.takeMotionRetargetPreviewSnapshot(bonesById)
    const action = {
      enabled: true,
      paused: false,
      time: 3,
      play() { throw new Error('local reset must not replay GLB') },
      stop() { throw new Error('local reset must not stop animated GLB actions') },
      reset() { throw new Error('local reset must not seek animated GLB actions') },
    }
    hips.position.set(9, 8, 7)
    hips.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)
    hips.scale.set(4, 5, 6)

    const reset = module.resetViewer3DActiveMotionPlayback({
      state: module.createViewer3DMotionRetargetState(rigSummary, motionRetargetSession),
      activeBackend: 'local-retarget-preview',
      bonesById,
      localSnapshot: snapshot,
      animation: { actions: [action], mixer: { time: 3 }, playing: true },
    })

    assert.deepEqual(hips.position.toArray(), [1, 2, 3])
    assertQuaternionClose(hips.quaternion, snapshot.get('rig:hero|skeleton:0|bone:hips#0').quaternion)
    assert.deepEqual(hips.scale.toArray(), [2, 2, 2])
    assert.equal(action.enabled, true)
    assert.equal(action.time, 3)
    assert.equal(reset.animationPlaying, false)
    assert.equal(reset.state.previewState, 'idle')
    assert.equal(reset.state.previewCurrentTimeSeconds, 0)
    assert.equal(reset.localSnapshot, null)
    assert.deepEqual(reset.restoredBoneIds, ['rig:hero|skeleton:0|bone:hips#0'])
  } finally {
    await cleanup()
  }
})
test('Viewer3D only resets Motion Retarget local preview on an open-to-closed visibility transition', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    assert.equal(module.shouldResetViewer3DMotionRetargetPreviewForVisibilityChange({ wasOpen: false, isOpen: false }), false)
    assert.equal(module.shouldResetViewer3DMotionRetargetPreviewForVisibilityChange({ wasOpen: false, isOpen: true }), false)
    assert.equal(module.shouldResetViewer3DMotionRetargetPreviewForVisibilityChange({ wasOpen: true, isOpen: true }), false)
    assert.equal(module.shouldResetViewer3DMotionRetargetPreviewForVisibilityChange({ wasOpen: true, isOpen: false }), true)
  } finally {
    await cleanup()
  }
})
test('Viewer3D closing Motion Retarget restores only scoped local preview and preserves global animated GLB playback', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const hips = new THREE.Bone()
    hips.position.set(1, 2, 3)
    const bonesById = new Map([['rig:hero|skeleton:0|bone:hips#0', hips]])
    const snapshot = module.takeMotionRetargetPreviewSnapshot(bonesById)
    hips.position.set(7, 8, 9)
    const state = module.reduceViewer3DMotionRetargetState(
      module.createViewer3DMotionRetargetState(rigSummary, motionRetargetSession),
      { type: 'set-preview-state', previewState: 'playing', timeSeconds: 0.5 },
    )

    const reset = module.resetViewer3DScopedMotionRetargetPreviewOnClose({
      state,
      bonesById,
      localSnapshot: snapshot,
      globalAnimationPlaying: true,
    })

    assert.deepEqual(hips.position.toArray(), [1, 2, 3])
    assert.equal(reset.globalAnimationPlaying, true)
    assert.equal(reset.state.previewState, 'idle')
    assert.equal(reset.state.previewCurrentTimeSeconds, 0)
    assert.equal(reset.localSnapshot, null)
    assert.deepEqual(reset.restoredBoneIds, ['rig:hero|skeleton:0|bone:hips#0'])
  } finally {
    await cleanup()
  }
})
test('Viewer3D exports Kimodo Pose/Clip companions through the existing Pose/Clip sidecar writer with manual mapping applied', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let motionState = module.createViewer3DMotionRetargetState(rigSummary, motionRetargetSession)
    motionState = module.reduceViewer3DMotionRetargetState(motionState, {
      type: 'set-mapping',
      sourceBoneId: 'source:hips',
      targetBoneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
    })
    motionState = module.reduceViewer3DMotionRetargetState(motionState, {
      type: 'set-mapping',
      sourceBoneId: 'source:spine',
      targetBoneId: 'rig:hero|skeleton:0|bone:hips#0',
    })
    const requests: unknown[] = []

    const result = await module.writeViewer3DMotionRetargetPoseClipCompanion({
      state: motionState,
      createdAt: '2026-05-21T18:45:00.000Z',
      writer: async (request: unknown) => {
        requests.push(request)
        return {
          success: true,
          sidecarWorkspacePath: (request as { sidecarWorkspacePath: string }).sidecarWorkspacePath,
          sidecar: (request as { sidecar: unknown }).sidecar,
        }
      },
    })

    assert.equal(requests.length, 1)
    assert.equal((requests[0] as { sourceWorkspacePath: string }).sourceWorkspacePath, 'Workflows/outputs/hero.glb')
    assert.equal((requests[0] as { sidecarWorkspacePath: string }).sidecarWorkspacePath, 'Workflows/pose-clips/hero--src-1d73d9779190b874.kimodo-walk-forward.kimodo-companion.pose-clip.v1.json')
    assert.notEqual(
      (requests[0] as { sidecarWorkspacePath: string }).sidecarWorkspacePath,
      'Workflows/pose-clips/hero.pose-clip.v1.json',
    )
    assert.equal((requests[0] as { sidecar: { schema: string } }).sidecar.schema, 'modly.pose-clip')
    assert.deepEqual((requests[0] as { sidecar: { keyframes: unknown[] } }).sidecar.keyframes, [
      {
        id: 'kimodo-rig-hero-skeleton-0-bone-hips-0-f0',
        timeSeconds: 0,
        boneId: 'rig:hero|skeleton:0|bone:hips#0',
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
      {
        id: 'kimodo-rig-hero-skeleton-0-bone-hips-0-spine-0-f0',
        timeSeconds: 0,
        boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
      {
        id: 'kimodo-rig-hero-skeleton-0-bone-hips-0-f30',
        timeSeconds: 1,
        boneId: 'rig:hero|skeleton:0|bone:hips#0',
        rotation: quaternionValue(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI)),
      },
      {
        id: 'kimodo-rig-hero-skeleton-0-bone-hips-0-spine-0-f30',
        timeSeconds: 1,
        boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0',
        rotation: quaternionValue(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)),
      },
    ])
    assert.deepEqual(result, {
      success: true,
      sidecarWorkspacePath: 'Workflows/pose-clips/hero--src-1d73d9779190b874.kimodo-walk-forward.kimodo-companion.pose-clip.v1.json',
      sidecar: (requests[0] as { sidecar: unknown }).sidecar,
    })
  } finally {
    await cleanup()
  }
})
test('Viewer3D fails companion export closed with a clear message when compatible Kimodo metadata is absent', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const motionState = module.createViewer3DMotionRetargetState(rigSummary, {
      ...motionRetargetSession,
      artifact: {
        ...motionRetargetSession.artifact,
        motionRetarget: undefined,
      },
      exportReadiness: {
        canSaveSidecar: false,
        canExportPoseClip: false,
        blockingWarnings: ['Trusted Kimodo motion payload is unavailable.'],
      },
      unlockReadiness: {
        trustedPayloadReady: false,
        translationReady: false,
        showSourceBones: false,
        showMappingDisplay: false,
        canPreview: false,
        canSaveSidecar: false,
        canExportPoseClip: false,
        blockingWarnings: ['Trusted Kimodo motion payload is unavailable.'],
      },
    })
    const requests: unknown[] = []

    const result = await module.writeViewer3DMotionRetargetPoseClipCompanion({
      state: motionState,
      writer: async (request: unknown) => {
        requests.push(request)
        return { success: true, sidecarWorkspacePath: (request as { sidecarWorkspacePath: string }).sidecarWorkspacePath, sidecar: (request as { sidecar: unknown }).sidecar }
      },
    })

    assert.equal(requests.length, 0)
    assert.deepEqual(result, {
      success: false,
      error: 'Companion export is unavailable until Modly validates a trusted Kimodo motion payload with a safe Pose/Clip companion output path.',
    })
  } finally {
    await cleanup()
  }
})
test('Viewer3D wires manual mapping callbacks through renderer-local Motion Retarget state while keeping trusted preview/export readiness unlocked', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let motionState = module.createViewer3DMotionRetargetState(rigSummary, motionRetargetSession)
    const mappedTargets: Array<{ sourceBoneId: string, targetBoneId?: string }> = []

    let panelProps = module.resolveViewer3DMotionRetargetPanelProps(motionState, {
      onChangeMapping: (sourceBoneId: string, targetBoneId?: string) => {
        mappedTargets.push({ sourceBoneId, targetBoneId })
        motionState = module.reduceViewer3DMotionRetargetState(motionState, { type: 'set-mapping', sourceBoneId, targetBoneId })
      },
    })

    panelProps.onChangeMapping('source:spine', 'rig:hero|skeleton:0|bone:hips#0')
    panelProps = module.resolveViewer3DMotionRetargetPanelProps(motionState, {})

    assert.deepEqual(mappedTargets, [
      { sourceBoneId: 'source:spine', targetBoneId: 'rig:hero|skeleton:0|bone:hips#0' },
    ])
    assert.equal(panelProps.session.mappings['source:spine']?.targetBoneId, 'rig:hero|skeleton:0|bone:hips#0')
    assert.equal(panelProps.session.exportReadiness.canExportPoseClip, true)
    assert.match(panelProps.warnings.join('\n'), /assigned to multiple source bones/)

    const requests: unknown[] = []
    await module.writeViewer3DMotionRetargetSidecar({
      state: motionState,
      createdAt: '2026-05-24T09:40:00.000Z',
      writer: async (request: unknown) => {
        requests.push(request)
        return { success: true, sidecarWorkspacePath: (request as { sidecarWorkspacePath: string }).sidecarWorkspacePath, sidecar: (request as { sidecar: unknown }).sidecar }
      },
    })

    assert.deepEqual((requests[0] as { sidecar: { session: { mappings: Record<string, { targetBoneId: string }> } } }).sidecar.session.mappings, {
      'source:hips': { targetBoneId: 'rig:hero|skeleton:0|bone:hips#0' },
      'source:spine': { targetBoneId: 'rig:hero|skeleton:0|bone:hips#0' },
    })
  } finally {
    await cleanup()
  }
})
test('Viewer3D duplicate target assignments surface diagnostics without downgrading companion export readiness', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let motionState = module.createViewer3DMotionRetargetState(rigSummary, motionRetargetSession)

    motionState = module.reduceViewer3DMotionRetargetState(motionState, {
      type: 'set-mapping',
      sourceBoneId: 'source:spine',
      targetBoneId: 'rig:hero|skeleton:0|bone:hips#0',
    })

    const panelProps = module.resolveViewer3DMotionRetargetPanelProps(motionState, {})

    assert.equal(panelProps.session.exportReadiness.canExportPoseClip, true)
    assert.equal(panelProps.session.exportReadiness.coherentExportReady, false)
    assert.match(panelProps.session.exportReadiness.blockingWarnings.join('\n'), /not coherent\/export-ready/i)
    assert.match(panelProps.warnings.join('\n'), /Target bone "UniRig Pelvis" is assigned to multiple source bones/)
  } finally {
    await cleanup()
  }
})
test('Viewer3D open for GLB artifacts routes to the internal Viewer3D preview target instead of an external browser', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DMotionRetargetState(rigSummary, motionRetargetSession)
    const artifacts = module.resolveViewer3DMotionRetargetArtifactEntries(state.session)
    const animatedGlb = artifacts.find((artifact: { key: string }) => artifact.key === 'animated-glb')

    assert.ok(animatedGlb)

    const opened = await module.openViewer3DMotionRetargetArtifact({
      state,
      artifact: animatedGlb,
      previewReader: async () => {
        throw new Error('GLB open must not request a text preview reader')
      },
    })

    assert.equal(opened.motionRetargetState.session?.selectedPreview, 'animated-glb')
    assert.deepEqual(opened.previewState, { status: 'closed' })
  } finally {
    await cleanup()
  }
})
test('Viewer3D open for text Motion Retarget artifacts displays an internal preview state', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DMotionRetargetState(rigSummary, motionRetargetSession)
    const artifacts = module.resolveViewer3DMotionRetargetArtifactEntries(state.session)
    const metadataJson = artifacts.find((artifact: { key: string }) => artifact.key === 'metadata')

    assert.ok(metadataJson)

    const opened = await module.openViewer3DMotionRetargetArtifact({
      state,
      artifact: metadataJson,
      previewReader: async (request: { workspacePath: string }) => {
        assert.equal(request.workspacePath, 'Workflows/kimodo/run-1/metadata.json')
        return {
          success: true,
          status: 'text',
          workspacePath: request.workspacePath,
          displayName: 'metadata.json',
          content: '{"clip":"Walk"}',
          byteLength: 15,
          truncated: false,
        }
      },
    })

    assert.deepEqual(opened.previewState, {
      status: 'text',
      title: 'Metadata JSON',
      workspacePath: 'Workflows/kimodo/run-1/metadata.json',
      displayName: 'metadata.json',
      content: '{"clip":"Walk"}',
      byteLength: 15,
      truncated: false,
    })
  } finally {
    await cleanup()
  }
})
test('Viewer3D open for Motion NPZ shows binary preview unavailable info instead of raw text', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DMotionRetargetState(rigSummary, motionRetargetSession)
    const artifacts = module.resolveViewer3DMotionRetargetArtifactEntries(state.session)
    const motionNpz = artifacts.find((artifact: { key: string }) => artifact.key === 'motion-npz')

    assert.ok(motionNpz)

    const opened = await module.openViewer3DMotionRetargetArtifact({
      state,
      artifact: motionNpz,
      previewReader: async (request: { workspacePath: string }) => ({
        success: true,
        status: 'binary',
        workspacePath: request.workspacePath,
        displayName: 'motion.npz',
        byteLength: 2048,
        binaryKind: 'npz',
        message: 'Binary preview is unavailable for NPZ artifacts. Download the file to inspect it locally.',
      }),
    })

    assert.deepEqual(opened.previewState, {
      status: 'binary',
      title: 'Motion NPZ',
      workspacePath: 'Workflows/kimodo/run-1/motion.npz',
      displayName: 'motion.npz',
      byteLength: 2048,
      binaryKind: 'npz',
      message: 'Binary preview is unavailable for NPZ artifacts. Download the file to inspect it locally.',
    })
  } finally {
    await cleanup()
  }
})
test('Viewer3D Motion Retarget download triggers the Electron artifact download IPC instead of browser anchors', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DMotionRetargetState(rigSummary, motionRetargetSession)
    const artifacts = module.resolveViewer3DMotionRetargetArtifactEntries(state.session)
    const motionBvh = artifacts.find((artifact: { key: string }) => artifact.key === 'motion-bvh')
    const requests: Array<{ workspacePath: string, suggestedName?: string }> = []

    assert.ok(motionBvh)

    const result = await module.downloadViewer3DMotionRetargetArtifact({
      artifact: motionBvh,
      downloader: async (request: { workspacePath: string, suggestedName?: string }) => {
        requests.push(request)
        return {
          success: true,
          status: 'saved',
          workspacePath: request.workspacePath,
          targetPath: '/tmp/motion.bvh',
        }
      },
    })

    assert.deepEqual(requests, [{ workspacePath: 'Workflows/kimodo/run-1/motion.bvh', suggestedName: 'motion.bvh' }])
    assert.deepEqual(result, {
      success: true,
      status: 'saved',
      workspacePath: 'Workflows/kimodo/run-1/motion.bvh',
      targetPath: '/tmp/motion.bvh',
    })
  } finally {
    await cleanup()
  }
})
test('Viewer3D clones Motion Retarget session input so renderer-local state cannot mutate source Kimodo artifacts', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const sourceSession = structuredClone(motionRetargetSession) as {
      selectedPreview: 'preview-glb' | 'animated-glb'
      warnings: string[]
      artifact: { previewGlbWorkspacePath?: string }
      mappings: Record<string, { targetLabel?: string }>
    }
    const state = module.createViewer3DMotionRetargetState(rigSummary, sourceSession)

    sourceSession.selectedPreview = 'preview-glb'
    sourceSession.warnings.push('mutated outside renderer state')
    sourceSession.artifact.previewGlbWorkspacePath = 'Workflows/kimodo/run-1/mutated-preview.glb'
    sourceSession.mappings['source:hips'] = {
      ...sourceSession.mappings['source:hips'],
      targetLabel: 'Mutated outside renderer state',
    }

    assert.equal(state.session?.selectedPreview, 'animated-glb')
    assert.deepEqual(state.session?.warnings, motionRetargetSession.warnings)
    assert.equal(state.session?.artifact.previewGlbWorkspacePath, 'Workflows/kimodo/run-1/preview.glb')
    assert.equal(state.session?.mappings['source:hips']?.targetLabel, 'UniRig Pelvis')
  } finally {
    await cleanup()
  }
})
test('Viewer3D resolves safe Kimodo metadata descriptors only for workspace-backed animate outputs', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    assert.equal(module.isViewer3DKimodoSiblingMetadataCandidate('Workflows/dreamcube-20260718-173840-d973837e/output_mesh.glb'), false)
    assert.equal(module.isViewer3DKimodoSiblingMetadataCandidate('Workflows/kimodo-20260521-230257-c858ac59/output_mesh.glb'), false)
    assert.equal(module.isViewer3DKimodoSiblingMetadataCandidate('Workflows/kimodo-20260521-230257-c858ac59/animated.glb'), true)

    assert.deepEqual(
      module.resolveViewer3DKimodoMetadataDescriptor({
        apiUrl: 'http://127.0.0.1:8000',
        artifact: {
          id: 'workflow-workflow-hero-node-node-animate',
          kind: 'mesh',
          uri: '/workspace/Workflows/kimodo/run-1/preview.glb',
          versionId: 'v1',
          legacy: { filePath: '/workspace/Workflows/kimodo/run-1/preview.glb', outputType: 'mesh' },
          provenance: {
            workflowId: 'workflow-hero',
            workflowNodeId: 'node-animate',
            extensionId: 'kimodo-soma-rp',
            extensionNodeId: 'animate-rigged-mesh',
          },
        },
      }),
      {
        artifact: {
          id: 'workflow-workflow-hero-node-node-animate',
          kind: 'mesh',
          uri: '/workspace/Workflows/kimodo/run-1/preview.glb',
          versionId: 'v1',
          legacy: { filePath: '/workspace/Workflows/kimodo/run-1/preview.glb', outputType: 'mesh' },
          provenance: {
            workflowId: 'workflow-hero',
            workflowNodeId: 'node-animate',
            extensionId: 'kimodo-soma-rp',
            extensionNodeId: 'animate-rigged-mesh',
          },
        },
        artifactWorkspacePath: 'Workflows/kimodo/run-1/preview.glb',
        bundleWorkspacePath: 'Workflows/kimodo/run-1',
        metadataWorkspacePath: 'Workflows/kimodo/run-1/metadata.json',
        metadataUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo/run-1/metadata.json',
        detectionMode: 'provenance',
      },
    )

    assert.deepEqual(
      module.resolveViewer3DKimodoMetadataDescriptor({
        apiUrl: 'http://127.0.0.1:8000',
        modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo-20260521-230257-c858ac59/animated.glb',
      }),
      {
        artifact: {
          id: 'viewer3d:model-url:Workflows/kimodo-20260521-230257-c858ac59/animated.glb',
          kind: 'mesh',
          uri: '/workspace/Workflows/kimodo-20260521-230257-c858ac59/animated.glb',
          versionId: 'viewer3d:model-url:Workflows/kimodo-20260521-230257-c858ac59/animated.glb',
          legacy: {
            filePath: '/workspace/Workflows/kimodo-20260521-230257-c858ac59/animated.glb',
            outputType: 'mesh',
          },
        },
        artifactWorkspacePath: 'Workflows/kimodo-20260521-230257-c858ac59/animated.glb',
        bundleWorkspacePath: 'Workflows/kimodo-20260521-230257-c858ac59',
        metadataWorkspacePath: 'Workflows/kimodo-20260521-230257-c858ac59/metadata.json',
        metadataUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo-20260521-230257-c858ac59/metadata.json',
        detectionMode: 'sibling-metadata',
      },
    )

    assert.deepEqual(
      module.resolveViewer3DKimodoMetadataDescriptor({
        apiUrl: 'http://127.0.0.1:8765',
        workspaceDir: '/home/drhepa/Documentos/Modly/workspace',
        modelUrl: 'http://127.0.0.1:8765/optimize/serve-file?path=%2Fhome%2Fdrhepa%2FDocumentos%2FModly%2Fworkspace%2FWorkflows%2Fkimodo-20260521-230257-c858ac59%2Fanimated.glb',
      }),
      {
        artifact: {
          id: 'viewer3d:model-url:Workflows/kimodo-20260521-230257-c858ac59/animated.glb',
          kind: 'mesh',
          uri: '/workspace/Workflows/kimodo-20260521-230257-c858ac59/animated.glb',
          versionId: 'viewer3d:model-url:Workflows/kimodo-20260521-230257-c858ac59/animated.glb',
          legacy: {
            filePath: '/workspace/Workflows/kimodo-20260521-230257-c858ac59/animated.glb',
            outputType: 'mesh',
          },
        },
        artifactWorkspacePath: 'Workflows/kimodo-20260521-230257-c858ac59/animated.glb',
        bundleWorkspacePath: 'Workflows/kimodo-20260521-230257-c858ac59',
        metadataWorkspacePath: 'Workflows/kimodo-20260521-230257-c858ac59/metadata.json',
        metadataUrl: 'http://127.0.0.1:8765/workspace/Workflows/kimodo-20260521-230257-c858ac59/metadata.json',
        detectionMode: 'sibling-metadata',
      },
    )

    assert.equal(
      module.resolveViewer3DKimodoMetadataDescriptor({
        apiUrl: 'http://127.0.0.1:8000',
        modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/dreamcube-20260718-173840-d973837e/output_mesh.glb',
      }),
      undefined,
    )

    assert.equal(
      module.resolveViewer3DKimodoMetadataDescriptor({
        apiUrl: 'http://127.0.0.1:8000',
        modelUrl: 'blob:http://127.0.0.1:8000/workspace/Workflows/kimodo-20260521-230257-c858ac59/animated.glb',
      }),
      undefined,
    )

    assert.equal(
      module.resolveViewer3DKimodoMetadataDescriptor({
        apiUrl: 'http://127.0.0.1:8000',
        modelUrl: 'http://127.0.0.1:8000/models/kimodo-20260521-230257-c858ac59/animated.glb',
      }),
      undefined,
    )

    assert.equal(
      module.resolveViewer3DKimodoMetadataDescriptor({
        apiUrl: 'http://127.0.0.1:8000',
        modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/../escape/animated.glb',
      }),
      undefined,
    )

    assert.equal(
      module.resolveViewer3DKimodoMetadataDescriptor({
        apiUrl: 'http://127.0.0.1:8000',
        modelUrl: 'http://127.0.0.1:8000/optimize/serve-file?path=%2Fhome%2Fdrhepa%2Foutside%2Fanimated.glb',
      }),
      undefined,
    )

    assert.equal(
      module.resolveViewer3DKimodoMetadataDescriptor({
        apiUrl: 'http://127.0.0.1:8000',
        modelUrl: 'http://127.0.0.1:8000/optimize/serve-file?path=%2Fhome%2Fdrhepa%2FDocumentos%2FModly%2Fworkspace%2FWorkflows%2F..%252Fescape%2Fanimated.glb',
      }),
      undefined,
    )

    assert.equal(
      module.resolveViewer3DKimodoMetadataDescriptor({
        apiUrl: 'http://127.0.0.1:8000',
        modelUrl: 'C:/workspace/Workflows/kimodo-20260521-230257-c858ac59/animated.glb',
      }),
      undefined,
    )

    assert.equal(
      module.resolveViewer3DKimodoMetadataDescriptor({
        apiUrl: 'http://127.0.0.1:8000',
        modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo-20260521-230257-c858ac59/animated.fbx',
      }),
      undefined,
    )

    assert.deepEqual(
      module.resolveViewer3DKimodoMetadataDescriptor({
        apiUrl: 'http://127.0.0.1:8000',
        artifact: {
          id: 'direct-import-kimodo',
          kind: 'mesh',
          uri: '/workspace/Imports/kimodo/run-1/animated.glb',
          versionId: 'v1',
          legacy: { filePath: '/workspace/Imports/kimodo/run-1/animated.glb', outputType: 'mesh' },
        },
      }),
      {
        artifact: {
          id: 'direct-import-kimodo',
          kind: 'mesh',
          uri: '/workspace/Imports/kimodo/run-1/animated.glb',
          versionId: 'v1',
          legacy: { filePath: '/workspace/Imports/kimodo/run-1/animated.glb', outputType: 'mesh' },
        },
        artifactWorkspacePath: 'Imports/kimodo/run-1/animated.glb',
        bundleWorkspacePath: 'Imports/kimodo/run-1',
        metadataWorkspacePath: 'Imports/kimodo/run-1/metadata.json',
        metadataUrl: 'http://127.0.0.1:8000/workspace/Imports/kimodo/run-1/metadata.json',
        detectionMode: 'sibling-metadata',
      },
    )

    assert.equal(
      module.resolveViewer3DKimodoMetadataDescriptor({
        apiUrl: 'http://127.0.0.1:8000',
        artifact: {
          id: 'unsafe',
          kind: 'mesh',
          uri: '/workspace/../escape/animated.glb',
          versionId: 'v1',
          legacy: { filePath: '/workspace/../escape/animated.glb', outputType: 'mesh' },
          provenance: {
            workflowId: 'workflow-hero',
            workflowNodeId: 'node-animate',
            extensionId: 'kimodo-soma-rp',
            extensionNodeId: 'animate-rigged-mesh',
          },
        },
      }),
      undefined,
    )
  } finally {
    await cleanup()
  }
})
test('Viewer3D hydrates a diagnostics-only Motion Retarget session from sibling Kimodo metadata when animated.glb was imported directly without provenance', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const descriptor = module.resolveViewer3DKimodoMetadataDescriptor({
      apiUrl: 'http://127.0.0.1:8000',
      artifact: {
        id: 'direct-import-kimodo',
        kind: 'mesh',
        uri: '/workspace/Imports/kimodo/run-1/animated.glb',
        versionId: 'v1',
        legacy: { filePath: '/workspace/Imports/kimodo/run-1/animated.glb', outputType: 'mesh' },
      },
    })

    const hydrated = module.hydrateViewer3DMotionRetargetSessionFromKimodoMetadata({
      descriptor,
      metadata: {
        extension_id: 'kimodo-soma-rp',
        node_id: 'animate-rigged-mesh',
        contract_version: '2.0.0',
        animated_artifact: 'animated.glb',
        preview_artifact: 'preview.glb',
        canonical_motion_artifact: 'motion.npz',
        bundle_artifacts: ['animated.glb', 'preview.glb', 'motion.npz', 'metadata.json'],
        warnings: ['Root-motion correctness is deferred.'],
      },
      summary: rigSummary,
      renamePlan: { skeletonContextId: rigSummary.skeletonContextId, aliases: {} },
      rigMetaNamingByBoneId: {},
    })

    const panelProps = module.resolveViewer3DMotionRetargetPanelProps({
      ...module.createViewer3DMotionRetargetState(rigSummary, hydrated.session),
      diagnosticsMessages: hydrated.diagnosticsMessages,
    }, {})

    assert.equal(hydrated.session?.artifact.workflowId, undefined)
    assert.equal(hydrated.session?.artifact.animatedGlbWorkspacePath, 'Imports/kimodo/run-1/animated.glb')
    assert.equal(hydrated.session?.sourceBones.length, 0)
    assert.deepEqual(panelProps.warnings, [
      'Diagnostics-only inspection is available until Kimodo exports a trusted motion payload.',
      'Diagnostics-only inspection is available until Kimodo exports source bone metadata.',
      'Root-motion correctness is deferred.',
      'Animated GLB playback is available, but local retarget correctness is not proven.',
      'Trusted Kimodo motion payload is unavailable.',
    ])
    assert.equal(panelProps.saveDisabledReason, 'Save is unavailable until Modly validates a trusted Kimodo motion payload with complete translated source bone metadata.')
    assert.equal(panelProps.previewDisabledReason, 'Local preview is unavailable until Modly validates a trusted Kimodo motion payload with complete translated quaternion tracks.')
    assert.equal(panelProps.exportDisabledReason, 'Companion export is unavailable until Modly validates a trusted Kimodo motion payload with a safe Pose/Clip companion output path.')
  } finally {
    await cleanup()
  }
})
test('Viewer3D hydrates a diagnostics-only Motion Retarget session from workspace modelUrl fallback when no artifact provenance is available', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const descriptor = module.resolveViewer3DKimodoMetadataDescriptor({
      apiUrl: 'http://127.0.0.1:8000',
      modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo-20260521-230257-c858ac59/animated.glb',
    })

    const hydrated = module.hydrateViewer3DMotionRetargetSessionFromKimodoMetadata({
      descriptor,
      metadata: {
        extension_id: 'kimodo-soma-rp',
        contract_version: 'kimodo-runtime-core/v1',
        node_id: 'animate-rigged-mesh',
        animated_artifact: 'animated.glb',
        preview_artifact: 'preview.glb',
        canonical_motion_artifact: 'motion.npz',
        motion_bvh_artifact: 'motion.bvh',
        bundle_artifacts: ['animated.glb', 'metadata.json', 'motion.bvh', 'motion.npz', 'preview.glb'],
        warnings: ['Root-motion correctness is deferred.'],
      },
      summary: rigSummary,
      renamePlan: { skeletonContextId: rigSummary.skeletonContextId, aliases: {} },
      rigMetaNamingByBoneId: {},
    })

    const panelProps = module.resolveViewer3DMotionRetargetPanelProps({
      ...module.createViewer3DMotionRetargetState(rigSummary, hydrated.session),
      diagnosticsMessages: hydrated.diagnosticsMessages,
    }, {})

    assert.equal(descriptor?.detectionMode, 'sibling-metadata')
    assert.equal(hydrated.session?.artifact.workflowId, undefined)
    assert.equal(hydrated.session?.artifact.bundleWorkspacePath, 'Workflows/kimodo-20260521-230257-c858ac59')
    assert.equal(hydrated.session?.artifact.animatedGlbWorkspacePath, 'Workflows/kimodo-20260521-230257-c858ac59/animated.glb')
    assert.equal(hydrated.session?.artifact.previewGlbWorkspacePath, 'Workflows/kimodo-20260521-230257-c858ac59/preview.glb')
    assert.equal(hydrated.session?.artifact.motionNpzWorkspacePath, 'Workflows/kimodo-20260521-230257-c858ac59/motion.npz')
    assert.equal(hydrated.session?.artifact.motionBvhWorkspacePath, 'Workflows/kimodo-20260521-230257-c858ac59/motion.bvh')
    assert.equal(hydrated.session?.sourceBones.length, 0)
    assert.deepEqual(panelProps.warnings, [
      'Diagnostics-only inspection is available until Kimodo exports a trusted motion payload.',
      'Diagnostics-only inspection is available until Kimodo exports source bone metadata.',
      'Root-motion correctness is deferred.',
      'Animated GLB playback is available, but local retarget correctness is not proven.',
      'Trusted Kimodo motion payload is unavailable.',
    ])
    assert.equal(panelProps.saveDisabledReason, 'Save is unavailable until Modly validates a trusted Kimodo motion payload with complete translated source bone metadata.')
    assert.equal(panelProps.previewDisabledReason, 'Local preview is unavailable until Modly validates a trusted Kimodo motion payload with complete translated quaternion tracks.')
    assert.equal(panelProps.exportDisabledReason, 'Companion export is unavailable until Modly validates a trusted Kimodo motion payload with a safe Pose/Clip companion output path.')
  } finally {
    await cleanup()
  }
})
test('Viewer3D hydrates a diagnostics-only Motion Retarget session from serve-file modelUrl fallback when no artifact provenance is available', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const descriptor = module.resolveViewer3DKimodoMetadataDescriptor({
      apiUrl: 'http://127.0.0.1:8765',
        workspaceDir: '/home/drhepa/Documentos/Modly/workspace',
      modelUrl: 'http://127.0.0.1:8765/optimize/serve-file?path=%2Fhome%2Fdrhepa%2FDocumentos%2FModly%2Fworkspace%2FWorkflows%2Fkimodo-20260521-230257-c858ac59%2Fanimated.glb',
    })

    const hydrated = module.hydrateViewer3DMotionRetargetSessionFromKimodoMetadata({
      descriptor,
      metadata: {
        extension_id: 'kimodo-soma-rp',
        contract_version: 'kimodo-runtime-core/v1',
        node_id: 'animate-rigged-mesh',
        animated_artifact: 'animated.glb',
        preview_artifact: 'preview.glb',
        canonical_motion_artifact: 'motion.npz',
        motion_bvh_artifact: 'motion.bvh',
        bundle_artifacts: ['animated.glb', 'metadata.json', 'motion.bvh', 'motion.npz', 'preview.glb'],
        warnings: ['Root-motion correctness is deferred.'],
      },
      summary: rigSummary,
      renamePlan: { skeletonContextId: rigSummary.skeletonContextId, aliases: {} },
      rigMetaNamingByBoneId: {},
    })

    const panelProps = module.resolveViewer3DMotionRetargetPanelProps({
      ...module.createViewer3DMotionRetargetState(rigSummary, hydrated.session),
      diagnosticsMessages: hydrated.diagnosticsMessages,
    }, {})

    assert.equal(descriptor?.detectionMode, 'sibling-metadata')
    assert.equal(descriptor?.artifactWorkspacePath, 'Workflows/kimodo-20260521-230257-c858ac59/animated.glb')
    assert.equal(hydrated.session?.artifact.workflowId, undefined)
    assert.equal(hydrated.session?.artifact.bundleWorkspacePath, 'Workflows/kimodo-20260521-230257-c858ac59')
    assert.equal(hydrated.session?.artifact.animatedGlbWorkspacePath, 'Workflows/kimodo-20260521-230257-c858ac59/animated.glb')
    assert.equal(hydrated.session?.artifact.previewGlbWorkspacePath, 'Workflows/kimodo-20260521-230257-c858ac59/preview.glb')
    assert.equal(hydrated.session?.artifact.motionNpzWorkspacePath, 'Workflows/kimodo-20260521-230257-c858ac59/motion.npz')
    assert.equal(hydrated.session?.artifact.motionBvhWorkspacePath, 'Workflows/kimodo-20260521-230257-c858ac59/motion.bvh')
    assert.equal(hydrated.session?.sourceBones.length, 0)
    assert.deepEqual(panelProps.warnings, [
      'Diagnostics-only inspection is available until Kimodo exports a trusted motion payload.',
      'Diagnostics-only inspection is available until Kimodo exports source bone metadata.',
      'Root-motion correctness is deferred.',
      'Animated GLB playback is available, but local retarget correctness is not proven.',
      'Trusted Kimodo motion payload is unavailable.',
    ])
    assert.equal(panelProps.saveDisabledReason, 'Save is unavailable until Modly validates a trusted Kimodo motion payload with complete translated source bone metadata.')
    assert.equal(panelProps.previewDisabledReason, 'Local preview is unavailable until Modly validates a trusted Kimodo motion payload with complete translated quaternion tracks.')
    assert.equal(panelProps.exportDisabledReason, 'Companion export is unavailable until Modly validates a trusted Kimodo motion payload with a safe Pose/Clip companion output path.')
  } finally {
    await cleanup()
  }
})
test('Viewer3D ignores random sibling metadata during direct-import fallback so non-Kimodo GLBs do not hydrate a session', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const descriptor = module.resolveViewer3DKimodoMetadataDescriptor({
      apiUrl: 'http://127.0.0.1:8000',
      artifact: {
        id: 'direct-import-random',
        kind: 'mesh',
        uri: '/workspace/Imports/random/run-1/animated.glb',
        versionId: 'v1',
        legacy: { filePath: '/workspace/Imports/random/run-1/animated.glb', outputType: 'mesh' },
      },
    })

    const hydrated = module.hydrateViewer3DMotionRetargetSessionFromKimodoMetadata({
      descriptor,
      metadata: {
        extension_id: 'not-kimodo',
        node_id: 'random-glb',
        contract_version: '1.0.0',
        animated_artifact: 'animated.glb',
        bundle_artifacts: ['animated.glb', 'metadata.json'],
      },
      summary: rigSummary,
      renamePlan: { skeletonContextId: rigSummary.skeletonContextId, aliases: {} },
      rigMetaNamingByBoneId: {},
    })

    assert.equal(hydrated.session, undefined)
    assert.deepEqual(hydrated.diagnosticsMessages, [])
  } finally {
    await cleanup()
  }
})
test('Viewer3D preserves provenance-first Kimodo hydration for workflow-selected artifacts even without fallback-only contract fields', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const descriptor = module.resolveViewer3DKimodoMetadataDescriptor({
      apiUrl: 'http://127.0.0.1:8000',
      artifact: {
        id: 'workflow-workflow-hero-node-node-animate',
        kind: 'mesh',
        uri: '/workspace/Workflows/kimodo/run-1/preview.glb',
        versionId: 'v1',
        legacy: { filePath: '/workspace/Workflows/kimodo/run-1/preview.glb', outputType: 'mesh' },
        provenance: {
          workflowId: 'workflow-hero',
          workflowNodeId: 'node-animate',
          extensionId: 'kimodo-soma-rp',
          extensionNodeId: 'animate-rigged-mesh',
        },
      },
    })

    const hydrated = module.hydrateViewer3DMotionRetargetSessionFromKimodoMetadata({
      descriptor,
      metadata: {
        runtime_status: 'success',
        retarget_status: 'success',
        animation_mapping_status: 'trusted_contract',
        canonical_motion_artifact: 'motion.npz',
        artifacts: ['animated.glb', 'metadata.json', 'motion.npz', 'preview.glb'],
        warnings: ['Root-motion correctness is deferred.'],
      },
      summary: rigSummary,
      renamePlan: { skeletonContextId: rigSummary.skeletonContextId, aliases: {} },
      rigMetaNamingByBoneId: {},
    })

    assert.equal(hydrated.session?.artifact.workflowId, 'workflow-hero')
    assert.equal(hydrated.session?.artifact.workflowNodeId, 'node-animate')
    assert.equal(hydrated.session?.artifact.animatedGlbWorkspacePath, 'Workflows/kimodo/run-1/animated.glb')
  } finally {
    await cleanup()
  }
})
test('Viewer3D resolves Kimodo metadata for Add to Scene workflow artifacts even when provenance-backed artifact paths are absolute workspace files', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const descriptor = module.resolveViewer3DKimodoMetadataDescriptor({
      apiUrl: 'http://127.0.0.1:8000',
      modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo/run-absolute/animated.glb',
      workspaceDir: '/home/drhepa/Documentos/Modly/workspace',
      artifact: {
        id: 'workflow-workflow-hero-node-node-animate-absolute',
        kind: 'mesh',
        uri: '/home/drhepa/Documentos/Modly/workspace/Workflows/kimodo/run-absolute/animated.glb',
        versionId: 'v1',
        legacy: {
          filePath: '/home/drhepa/Documentos/Modly/workspace/Workflows/kimodo/run-absolute/animated.glb',
          outputType: 'mesh',
        },
        provenance: {
          workflowId: 'workflow-hero',
          workflowNodeId: 'node-animate',
          extensionId: 'kimodo-soma-rp',
          extensionNodeId: 'animate-rigged-mesh',
        },
      },
    })

    assert.deepEqual(descriptor, {
      artifact: {
        id: 'workflow-workflow-hero-node-node-animate-absolute',
        kind: 'mesh',
        uri: '/home/drhepa/Documentos/Modly/workspace/Workflows/kimodo/run-absolute/animated.glb',
        versionId: 'v1',
        legacy: {
          filePath: '/home/drhepa/Documentos/Modly/workspace/Workflows/kimodo/run-absolute/animated.glb',
          outputType: 'mesh',
        },
        provenance: {
          workflowId: 'workflow-hero',
          workflowNodeId: 'node-animate',
          extensionId: 'kimodo-soma-rp',
          extensionNodeId: 'animate-rigged-mesh',
        },
      },
      artifactWorkspacePath: 'Workflows/kimodo/run-absolute/animated.glb',
      bundleWorkspacePath: 'Workflows/kimodo/run-absolute',
      metadataWorkspacePath: 'Workflows/kimodo/run-absolute/metadata.json',
      metadataUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo/run-absolute/metadata.json',
      detectionMode: 'provenance',
    })

    const hydrated = module.hydrateViewer3DMotionRetargetSessionFromKimodoMetadata({
      descriptor,
      metadata: {
        runtime_status: 'success',
        retarget_status: 'success',
        animation_mapping_status: 'trusted_contract',
        source_kind: 'load_mesh_existing',
        mapping_confidence: 'compatible',
        artifacts: ['animated.glb', 'metadata.json', 'motion.bvh', 'motion.npz', 'preview.glb'],
        canonical_motion_artifact: 'motion.npz',
        motion_bvh_artifact: 'motion.bvh',
        kimodo_motion_retarget: {
          schema: 'kimodo.motion-retarget.v1',
          contract_version: 1,
          source_contract: { schema: 'modly.humanoid.v1', trusted: true, sidecar_payload_sha256: 'abc123' },
          mapping_status: 'trusted_manual',
          mapping_confidence: 'compatible',
          fps: 30,
          duration_seconds: 1.5,
          time_semantics: 'seconds',
          source_bones: [
            { source_bone_id: 'src:hips', label: 'Source Hips', raw_label: 'Hips', chain: 'body' },
            { source_bone_id: 'src:spine', label: 'Source Spine', raw_label: 'Spine', parent_source_bone_id: 'src:hips' },
          ],
          target_tracks: [
            {
              target_node_name: 'Hips',
              target_node_index: 0,
              rotations: [
                { time_seconds: 0, x: 0, y: 0, z: 0, w: 1 },
                { time_seconds: 0.5, x: 0, y: 0.3826834, z: 0, w: 0.9238795 },
              ],
            },
            {
              target_node_name: 'Spine',
              target_node_index: 1,
              rotations: [
                { time_seconds: 0, x: 0, y: 0, z: 0, w: 1 },
                { time_seconds: 0.5, x: 0, y: 0, z: 0.3826834, w: 0.9238795 },
              ],
            },
          ],
        },
      },
      summary: rigSummary,
      renamePlan: { skeletonContextId: rigSummary.skeletonContextId, aliases: {} },
      rigMetaNamingByBoneId: {},
    })

    const panelProps = module.resolveViewer3DMotionRetargetPanelProps({
      ...module.createViewer3DMotionRetargetState(rigSummary, hydrated.session),
      diagnosticsMessages: hydrated.diagnosticsMessages,
    }, {})

    assert.equal(hydrated.session?.artifact.workflowId, 'workflow-hero')
    assert.equal(hydrated.session?.artifact.animatedGlbWorkspacePath, 'Workflows/kimodo/run-absolute/animated.glb')
    assert.equal(hydrated.session?.sourceBones.length, 2)
    assert.equal(hydrated.session?.sourceBones[0].chain, 'body')
    assert.equal(panelProps.saveDisabledReason, undefined)
    assert.equal(panelProps.previewDisabledReason, undefined)
    assert.equal(panelProps.exportDisabledReason, undefined)
    assert.equal(panelProps.warnings.includes('Trusted Kimodo motion payload is unavailable.'), false)
  } finally {
    await cleanup()
  }
})
test('Viewer3D auto-prefers only safe animated GLBs and falls back to preview.glb with diagnostics when retargeting is degraded', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    assert.deepEqual(
      module.resolveViewer3DMotionRetargetModelPresentation({
        defaultModelUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo/run-1/preview.glb',
        apiUrl: 'http://127.0.0.1:8000',
        session: motionRetargetSession,
        diagnosticsMessages: [],
      }),
      {
        modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo/run-1/animated.glb',
        warnings: motionRetargetSession.warnings,
      },
    )

    const degradedSession = {
      ...motionRetargetSession,
      artifact: {
        ...motionRetargetSession.artifact,
        diagnostics: {
          ...motionRetargetSession.artifact.diagnostics,
          retargetStatus: 'failed',
          retargetErrorMessage: 'Kimodo could not guarantee the exported animated GLB.',
        },
      },
      warnings: ['Kimodo could not guarantee the exported animated GLB.'],
      exportReadiness: {
        ...motionRetargetSession.exportReadiness,
        canExportPoseClip: false,
        blockingWarnings: ['Kimodo retarget status is failed.'],
      },
    }

    assert.deepEqual(
      module.resolveViewer3DMotionRetargetModelPresentation({
        defaultModelUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo/run-1/preview.glb',
        apiUrl: 'http://127.0.0.1:8000',
        session: degradedSession,
        diagnosticsMessages: ['Animated GLB fallback engaged because Kimodo reported degraded retarget diagnostics.'],
      }),
      {
        modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo/run-1/preview.glb',
        warnings: [
          'Animated GLB fallback engaged because Kimodo reported degraded retarget diagnostics.',
          'Kimodo could not guarantee the exported animated GLB.',
        ],
      },
    )
  } finally {
    await cleanup()
  }
})

test('Viewer3D Kimodo source-rig fallback selects safe workspace-relative GLB/GLTF only for degraded preview-only output', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const descriptor = module.resolveViewer3DKimodoMetadataDescriptor({
      apiUrl: 'http://127.0.0.1:8000',
      modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo-preview/run-1/preview.glb',
    })
    const result = module.resolveViewer3DKimodoSourceRigFallback({
      apiUrl: 'http://127.0.0.1:8000',
      defaultModelUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo-preview/run-1/preview.glb',
      descriptor,
      metadata: {
        extension_id: 'kimodo-soma-rp', node_id: 'animate-rigged-mesh',
        runtime_status: 'failed',
        retarget_status: 'failed',
        animation_mapping_status: 'failed',
        visual_quality_status: 'preview-only',
        preview_artifact: 'preview.glb',
        canonical_motion_artifact: 'motion.npz',
        motion_bvh_artifact: 'motion.bvh',
        bundle_artifacts: ['metadata.json', 'motion.bvh', 'motion.npz', 'preview.glb'],
        source_workspace_path: 'Workflows/sources/rigged-hero.glb',
      },
      previewHasUsableRig: false,
    })

    assert.deepEqual(result, {
      active: true,
      modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/sources/rigged-hero.glb',
      sourceWorkspacePath: 'Workflows/sources/rigged-hero.glb',
      warnings: ['Kimodo source-rig authoring fallback active because preview output is degraded and no safe animated rig output was available.'],
      artifact: result.artifact,
    })
    assert.equal(result.artifact.previewGlbWorkspacePath, 'Workflows/kimodo-preview/run-1/preview.glb')

    const gltfResult = module.resolveViewer3DKimodoSourceRigFallback({
      apiUrl: 'http://127.0.0.1:8000',
      defaultModelUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo-preview/run-2/preview.glb',
      descriptor: module.resolveViewer3DKimodoMetadataDescriptor({
        apiUrl: 'http://127.0.0.1:8000',
        modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo-preview/run-2/preview.glb',
      }),
      metadata: {
        extension_id: 'kimodo-soma-rp', node_id: 'animate-rigged-mesh',
        runtime_status: 'completed',
        retarget_status: 'failed',
        visual_quality_status: 'preview-only',
        preview_artifact: 'preview.glb',
        source_workspace_path: 'Workflows/sources/rigged-creature.gltf',
      },
      previewHasUsableRig: false,
    })

    assert.equal(gltfResult.active, true)
    assert.equal(gltfResult.sourceWorkspacePath, 'Workflows/sources/rigged-creature.gltf')
    assert.equal(gltfResult.modelUrl, 'http://127.0.0.1:8000/workspace/Workflows/sources/rigged-creature.gltf')
  } finally {
    await cleanup()
  }
})

test('Viewer3D Kimodo source-rig fallback fails closed for unsafe, missing, non-mesh, and non-preview-only source metadata', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const descriptor = module.resolveViewer3DKimodoMetadataDescriptor({
      apiUrl: 'http://127.0.0.1:8000',
      modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo-preview/run-unsafe/preview.glb',
    })
    const unsafeCases = [
      { name: 'missing source', metadata: {} },
      { name: 'absolute source_workspace_path', metadata: { source_workspace_path: '/home/drhepa/Documentos/Modly/workspace/Workflows/source.glb' } },
      { name: 'traversal', metadata: { source_workspace_path: 'Workflows/../source.glb' } },
      { name: 'encoded traversal', metadata: { source_workspace_path: 'Workflows/%2e%2e/source.glb' } },
      { name: 'drive prefix', metadata: { source_workspace_path: 'C:/workspace/Workflows/source.glb' } },
      { name: 'empty segment', metadata: { source_workspace_path: 'Workflows//source.glb' } },
      { name: 'non glb/gltf', metadata: { source_workspace_path: 'Workflows/source.fbx' } },
      { name: 'outside absolute source_rigged_mesh', metadata: { source_rigged_mesh: '/home/drhepa/outside/source.glb' } },
      { name: 'safe source but preview already has rig', metadata: { source_workspace_path: 'Workflows/source.glb' }, previewHasUsableRig: true },
      { name: 'safe source but safe animated output exists', metadata: { source_workspace_path: 'Workflows/source.glb', animated_artifact: 'animated.glb', runtime_status: 'completed', retarget_status: 'completed', animation_mapping_status: 'completed' } },
    ]

    for (const current of unsafeCases) {
      const result = module.resolveViewer3DKimodoSourceRigFallback({
        apiUrl: 'http://127.0.0.1:8000',
        defaultModelUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo-preview/run-unsafe/preview.glb',
        descriptor,
        metadata: {
          extension_id: 'kimodo-soma-rp', node_id: 'animate-rigged-mesh',
          runtime_status: 'failed',
          retarget_status: 'failed',
          visual_quality_status: 'preview-only',
          preview_artifact: 'preview.glb',
          bundle_artifacts: ['metadata.json', 'motion.bvh', 'motion.npz', 'preview.glb'],
          ...current.metadata,
        },
        previewHasUsableRig: Boolean(current.previewHasUsableRig),
      })

      assert.equal(result.active, false, current.name)
      assert.equal(result.modelUrl, 'http://127.0.0.1:8000/workspace/Workflows/kimodo-preview/run-unsafe/preview.glb', current.name)
      assert.equal(result.sourceWorkspacePath, undefined, current.name)
    }
  } finally {
    await cleanup()
  }
})

test('Viewer3D authoring presentation switches only modelUrl and rigSourceWorkspacePath without changing reset keys', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const authoring = module.resolveViewer3DAuthoringPresentation({
      baseModelUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo-preview/run-1/preview.glb',
      currentJobId: 'job-preview-only',
      rigSourceWorkspacePath: 'Workflows/kimodo-preview/run-1/preview.glb',
      motionRetargetPresentation: {
        modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo-preview/run-1/preview.glb',
        warnings: ['Diagnostics-only inspection is available until Kimodo exports a trusted motion payload.'],
      },
      sourceRigFallback: {
        active: true,
        modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/source-rigs/hero.glb',
        sourceWorkspacePath: 'Workflows/source-rigs/hero.glb',
        warnings: ['Kimodo source-rig authoring fallback active because preview output is degraded and no safe animated rig output was available.'],
      },
    })

    assert.deepEqual(authoring, {
      modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/source-rigs/hero.glb',
      rigSourceWorkspacePath: 'Workflows/source-rigs/hero.glb',
      resetKey: { currentJobId: 'job-preview-only', baseModelUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo-preview/run-1/preview.glb' },
      warnings: [
        'Diagnostics-only inspection is available until Kimodo exports a trusted motion payload.',
        'Kimodo source-rig authoring fallback active because preview output is degraded and no safe animated rig output was available.',
      ],
    })
  } finally {
    await cleanup()
  }
})

test('Viewer3D source-rig fallback keeps preview bundle artifacts visible and appends explicit diagnostics', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const descriptor = module.resolveViewer3DKimodoMetadataDescriptor({
      apiUrl: 'http://127.0.0.1:8000',
      modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo-preview/run-artifacts/preview.glb',
    })
    const fallback = module.resolveViewer3DKimodoSourceRigFallback({
      apiUrl: 'http://127.0.0.1:8000',
      defaultModelUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo-preview/run-artifacts/preview.glb',
      descriptor,
      metadata: {
        extension_id: 'kimodo-soma-rp', node_id: 'animate-rigged-mesh',
        runtime_status: 'failed',
        retarget_status: 'failed',
        visual_quality_status: 'preview-only',
        preview_artifact: 'preview.glb',
        canonical_motion_artifact: 'motion.npz',
        motion_bvh_artifact: 'motion.bvh',
        bundle_artifacts: ['metadata.json', 'motion.bvh', 'motion.npz', 'preview.glb'],
        source_workspace_path: 'Workflows/source-rigs/hero.glb',
        warnings: ['Kimodo produced preview-only output.'],
      },
      previewHasUsableRig: false,
    })
    const artifactEntries = module.resolveViewer3DMotionRetargetArtifactEntries(undefined, fallback.artifact)

    assert.deepEqual(artifactEntries.map((entry: { key: string, workspacePath: string, openMode: string }) => [entry.key, entry.workspacePath, entry.openMode]), [
      ['metadata', 'Workflows/kimodo-preview/run-artifacts/metadata.json', 'workspace-preview'],
      ['preview-glb', 'Workflows/kimodo-preview/run-artifacts/preview.glb', 'viewer3d-preview'],
      ['motion-npz', 'Workflows/kimodo-preview/run-artifacts/motion.npz', 'workspace-preview'],
      ['motion-bvh', 'Workflows/kimodo-preview/run-artifacts/motion.bvh', 'workspace-preview'],
    ])
    assert.match(fallback.warnings.join('\n'), /source-rig authoring fallback active/i)
    assert.match(fallback.warnings.join('\n'), /preview-only output/i)
  } finally {
    await cleanup()
  }
})

test('Viewer3D source-rig fallback preserves trust boundaries and ignores PoseClip hashed sidecar paths', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const descriptor = module.resolveViewer3DKimodoMetadataDescriptor({
      apiUrl: 'http://127.0.0.1:8000',
      modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo-preview/run-trust/preview.glb',
    })
    const baseArgs = {
      apiUrl: 'http://127.0.0.1:8000',
      defaultModelUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo-preview/run-trust/preview.glb',
      descriptor,
      metadata: {
        extension_id: 'kimodo-soma-rp', node_id: 'animate-rigged-mesh',
        runtime_status: 'failed',
        retarget_status: 'failed',
        visual_quality_status: 'preview-only',
        preview_artifact: 'preview.glb',
        source_workspace_path: 'Workflows/source-rigs/hero.glb',
        pose_clip_sidecar_workspace_path: 'Workflows/pose-clips/hero--src-1d73d9779190b874.pose-clip.v1.json',
        manual_confirmed: true,
        trusted_contract: true,
        basis: { trusted: true },
        axis: { trusted: true },
        plane: { trusted: true },
      },
      previewHasUsableRig: false,
    }
    const withHashedSidecar = module.resolveViewer3DKimodoSourceRigFallback(baseArgs)
    const withoutHashedSidecar = module.resolveViewer3DKimodoSourceRigFallback({
      ...baseArgs,
      metadata: { ...baseArgs.metadata, pose_clip_sidecar_workspace_path: 'Workflows/pose-clips/other--src-ffffffffffffffff.pose-clip.v1.json' },
    })
    const manualPromotionPresentation = module.resolveViewer3DHumanoidReviewPresentationForHydrationSource({
      presentation: module.resolveViewer3DHumanoidReviewPresentation({
        trustedContractPresent: false,
        draftResult: { success: true, status: 'found', sidecar: humanoidDraftSidecar },
        promotionResult: { success: true, status: 'found', sidecar: humanoidPromotionSidecar },
      }),
      semanticHydrationSource: {
        displayedMeshWorkspacePath: 'Workflows/source-rigs/hero.glb',
        semanticSourceWorkspacePath: 'Workflows/source-rigs/hero.glb',
        sourceKind: 'kimodo-source',
        warnings: withHashedSidecar.warnings,
        failedClosed: false,
      },
    })

    assert.deepEqual(withHashedSidecar, withoutHashedSidecar)
    assert.equal(withHashedSidecar.active, true)
    assert.equal(withHashedSidecar.trust?.trustedContractPresent, false)
    assert.deepEqual(withHashedSidecar.trust?.trustedEvidence, { sourceContract: false, basis: false, axis: false, plane: false, motion: false })
    assert.equal(manualPromotionPresentation.state, 'promoted')
    assert.equal(manualPromotionPresentation.canPromote, false)
  } finally {
    await cleanup()
  }
})
test('Viewer3D keeps Motion Retarget diagnostics visible even when no Kimodo session could be hydrated', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DMotionRetargetState(rigSummary)
    const panelProps = module.resolveViewer3DMotionRetargetPanelProps({
      ...state,
      diagnosticsMessages: [
        'Kimodo metadata could not be loaded.',
        'Diagnostics-only inspection is available until a safe retarget artifact is found.',
      ],
    }, {})

    assert.equal(panelProps.session, undefined)
    assert.deepEqual(panelProps.warnings, [
      'Kimodo metadata could not be loaded.',
      'Diagnostics-only inspection is available until a safe retarget artifact is found.',
    ])
  } finally {
    await cleanup()
  }
})
test('Viewer3D Motion Retarget seams stay renderer-local, Electron-guarded, and avoid interactive FastAPI orchestration', async () => {
  const { cleanup } = await loadViewer3DModule()

  try {
    const source = readFileSync(viewer3DEntry, 'utf8')
    const motionRetargetSlice = source.slice(
      source.indexOf('export function createViewer3DMotionRetargetState'),
      source.indexOf('export function resolveViewer3DPoseClipPanelProps'),
    )
    const motionRetargetRuntimeSlice = source.slice(
      source.indexOf('const kimodoMetadataDescriptor = useMemo('),
      source.indexOf('  const handleSceneSelect'),
    )

    assert.match(motionRetargetRuntimeSlice, /const reader = globalThis\.fetch/)
    assert.match(motionRetargetRuntimeSlice, /reader\(descriptor\.metadataUrl\)/)
    assert.match(motionRetargetRuntimeSlice, /window\.electron\?\.workspace\?\.artifacts\?\.writeMotionRetargetSidecar/)
    assert.match(motionRetargetRuntimeSlice, /window\.electron\?\.workspace\?\.artifacts\?\.readMotionRetargetSidecar/)
    assert.match(motionRetargetRuntimeSlice, /workspaceArtifactService\.previewWorkspaceArtifact/)
    assert.match(motionRetargetRuntimeSlice, /workspaceArtifactService\.downloadWorkspaceArtifact/)
    assert.match(motionRetargetRuntimeSlice, /workspaceArtifactService\.isCurrent\(\)/)
    const service = readFileSync(path.join(projectRoot, 'src/areas/generate/viewerWorkspaceArtifactService.ts'), 'utf8')
    assert.match(service, /window\.electron\?\.workspace\?\.artifacts/)
    assert.match(service, /typeof method !== 'function'/)
    assert.match(service, /await method\.call\(ports, request\)/)
    assert.doesNotMatch(motionRetargetSlice, /writeFile|rename\(|rm\(|mkdir\(|GLTFExporter|exportGLB|saveEditedScenePendingReplacement/i)
    assert.doesNotMatch(motionRetargetRuntimeSlice, /processRun|createFromImage|\/generate|FastAPI|interactive mapping|pose editing|target="_blank"|download=/i)
    assert.doesNotMatch(motionRetargetRuntimeSlice, /ipcRenderer\.invoke\(/)
  } finally {
    await cleanup()
  }
})

test('Viewer3D resolves Kimodo semantic hydration source safely and fails closed for unsafe metadata', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    assert.deepEqual(
      module.resolveViewer3DSemanticHydrationSource({
        displayedMeshWorkspacePath: kimodoDisplayedWorkspacePath,
        workspaceDir: '/home/drhepa/Documentos/Modly/workspace',
        descriptor: {
          artifact: { id: 'kimodo-display', kind: 'mesh', uri: `/workspace/${kimodoDisplayedWorkspacePath}`, versionId: 'v1' },
          artifactWorkspacePath: kimodoDisplayedWorkspacePath,
          bundleWorkspacePath: 'Workflows/kimodo-20260523-140139-ca71024b',
          metadataWorkspacePath: 'Workflows/kimodo-20260523-140139-ca71024b/metadata.json',
          metadataUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo-20260523-140139-ca71024b/metadata.json',
          detectionMode: 'sibling-metadata',
        },
        metadata: {
          source_workspace_path: kimodoSemanticSourceWorkspacePath,
          source_rigged_mesh: '/home/drhepa/Documentos/Modly/workspace/Workflows/1779535081_02857c58_unirig.glb',
        },
      }),
      {
        displayedMeshWorkspacePath: kimodoDisplayedWorkspacePath,
        semanticSourceWorkspacePath: kimodoSemanticSourceWorkspacePath,
        sourceKind: 'kimodo-source',
        warnings: [],
        failedClosed: false,
      },
    )

    assert.deepEqual(
      module.resolveViewer3DSemanticHydrationSource({
        displayedMeshWorkspacePath: kimodoDisplayedWorkspacePath,
        workspaceDir: '/home/drhepa/Documentos/Modly/workspace',
        descriptor: {
          artifact: { id: 'kimodo-display', kind: 'mesh', uri: `/workspace/${kimodoDisplayedWorkspacePath}`, versionId: 'v1' },
          artifactWorkspacePath: kimodoDisplayedWorkspacePath,
          bundleWorkspacePath: 'Workflows/kimodo-20260523-140139-ca71024b',
          metadataWorkspacePath: 'Workflows/kimodo-20260523-140139-ca71024b/metadata.json',
          metadataUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo-20260523-140139-ca71024b/metadata.json',
          detectionMode: 'sibling-metadata',
        },
        metadata: {
          source_rigged_mesh: '/home/drhepa/Documentos/Modly/workspace/Workflows/1779535081_02857c58_unirig.glb',
        },
      }),
      {
        displayedMeshWorkspacePath: kimodoDisplayedWorkspacePath,
        semanticSourceWorkspacePath: kimodoSemanticSourceWorkspacePath,
        sourceKind: 'kimodo-source',
        warnings: [],
        failedClosed: false,
      },
    )

    const unsafe = module.resolveViewer3DSemanticHydrationSource({
      displayedMeshWorkspacePath: kimodoDisplayedWorkspacePath,
      descriptor: {
        artifact: { id: 'kimodo-display', kind: 'mesh', uri: `/workspace/${kimodoDisplayedWorkspacePath}`, versionId: 'v1' },
        artifactWorkspacePath: kimodoDisplayedWorkspacePath,
        bundleWorkspacePath: 'Workflows/kimodo-20260523-140139-ca71024b',
        metadataWorkspacePath: 'Workflows/kimodo-20260523-140139-ca71024b/metadata.json',
        metadataUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo-20260523-140139-ca71024b/metadata.json',
        detectionMode: 'sibling-metadata',
      },
      metadata: {
        source_workspace_path: '../outside.glb',
        source_rigged_mesh: '/home/drhepa/outside/animated.glb',
      },
    })

    assert.equal(unsafe.displayedMeshWorkspacePath, kimodoDisplayedWorkspacePath)
    assert.equal(unsafe.semanticSourceWorkspacePath, kimodoDisplayedWorkspacePath)
    assert.equal(unsafe.sourceKind, 'displayed-mesh')
    assert.equal(unsafe.failedClosed, true)
    assert.match(unsafe.warnings[0], /semantic source/i)
  } finally {
    await cleanup()
  }
})
test('Viewer3D routes Kimodo semantic naming hydration to the source mesh while alias and runtime sidecars stay anchored to the displayed mesh', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const semanticSource = module.resolveViewer3DSemanticHydrationSource({
      displayedMeshWorkspacePath: kimodoDisplayedWorkspacePath,
      descriptor: {
        artifact: { id: 'kimodo-display', kind: 'mesh', uri: `/workspace/${kimodoDisplayedWorkspacePath}`, versionId: 'v1' },
        artifactWorkspacePath: kimodoDisplayedWorkspacePath,
        bundleWorkspacePath: 'Workflows/kimodo-20260523-140139-ca71024b',
        metadataWorkspacePath: 'Workflows/kimodo-20260523-140139-ca71024b/metadata.json',
        metadataUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo-20260523-140139-ca71024b/metadata.json',
        detectionMode: 'sibling-metadata',
      },
      metadata: { source_workspace_path: kimodoSemanticSourceWorkspacePath },
    })

    assert.deepEqual(module.resolveViewer3DRigMetaHydrationRequest(kimodoDisplayedRigSummary, semanticSource), {
      sourceWorkspacePath: kimodoSemanticSourceWorkspacePath,
    })
    assert.deepEqual(module.resolveViewer3DHumanoidHydrationRequest(kimodoDisplayedRigSummary, semanticSource), {
      displayedMeshWorkspacePath: kimodoDisplayedWorkspacePath,
      sourceKind: 'kimodo-source',
      draft: { meshWorkspacePath: kimodoSemanticSourceWorkspacePath },
      promotion: { meshWorkspacePath: kimodoSemanticSourceWorkspacePath },
    })
    assert.equal(module.resolveViewer3DRigHydrationRequest(kimodoDisplayedRigSummary, semanticSource), null)
    assert.deepEqual(module.resolveViewer3DPoseClipHydrationRequest(kimodoDisplayedRigSummary), {
      sidecarWorkspacePath: 'Workflows/pose-clips/animated--src-d517426fb6123459.pose-clip.v1.json',
      legacySidecarWorkspacePath: 'Workflows/pose-clips/animated.pose-clip.v1.json',
      sourceWorkspacePath: kimodoDisplayedWorkspacePath,
    })
    assert.deepEqual(module.resolveViewer3DMotionRetargetHydrationRequest(kimodoDisplayedRigSummary), {
      sidecarWorkspacePath: 'Workflows/motion-retarget/animated.motion-retarget.v1.json',
      sourceWorkspacePath: kimodoDisplayedWorkspacePath,
    })
    assert.deepEqual(module.createViewer3DRigMetaHydrationToken({
      modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo-20260523-140139-ca71024b/animated.glb',
      summary: kimodoDisplayedRigSummary,
      semanticSourceWorkspacePath: kimodoSemanticSourceWorkspacePath,
    }), {
      modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo-20260523-140139-ca71024b/animated.glb',
      sourceWorkspacePath: kimodoDisplayedWorkspacePath,
      semanticSourceWorkspacePath: kimodoSemanticSourceWorkspacePath,
      skeletonContextId: 'rig:Workflows/kimodo-20260523-140139-ca71024b/animated.glb|skeleton:0',
    })
  } finally {
    await cleanup()
  }
})
test('Viewer3D inherits Kimodo semantic source labels onto displayed runtime bones without enabling Kimodo promotion writes', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DRigEditorState(kimodoDisplayedRigSummary)
    const token = module.createViewer3DRigMetaHydrationToken({
      modelUrl: 'http://127.0.0.1:8000/workspace/Workflows/kimodo-20260523-140139-ca71024b/animated.glb',
      summary: kimodoDisplayedRigSummary,
      semanticSourceWorkspacePath: kimodoSemanticSourceWorkspacePath,
    })

    const hydrated = module.applyViewer3DRigMetaHydrationResult({
      state,
      result: {
        success: true,
        status: 'found',
        rigMetaWorkspacePath: 'Workflows/1779535081_02857c58_unirig.rigmeta.json',
        warnings: [],
        namingByBoneId: {},
        rigMeta: {
          schema: 'modly.unirig.rigmeta',
          source: { workspacePath: kimodoSemanticSourceWorkspacePath },
          humanoid_draft: {
            schema: 'modly.humanoid-draft.v1',
            assignments: {
              roles: {
                hips: 'bone_0',
                spine: 'bone_1',
              },
            },
          },
        },
      },
      token,
      currentToken: token,
    })

    const displayNaming = module.resolveViewer3DEffectiveRigMetaNaming({
      summary: kimodoDisplayedRigSummary,
      rigMetaNamingByBoneId: hydrated.state.rigMetaNamingByBoneId,
      draftResult: {
        success: true,
        status: 'found',
        sidecarWorkspacePath: 'Workflows/1779535081_02857c58_unirig.humanoid-draft.v1.json',
        sidecar: kimodoSourceHumanoidDraftSidecar,
      },
      promotionResult: {
        success: true,
        status: 'found',
        sidecarWorkspacePath: 'Workflows/1779535081_02857c58_unirig.humanoid-promotion.v1.json',
        sidecar: kimodoSourceHumanoidPromotionSidecar,
      },
    })

    const panelProps = module.resolveViewer3DRigEditorPanelProps(state, {}, undefined, { rigMetaNamingByBoneId: displayNaming })
    const poseProps = module.resolveViewer3DPoseClipPanelProps(module.createViewer3DPoseClipState(kimodoDisplayedRigSummary), {}, panelProps.effectiveNaming)
    const overlayProps = module.resolveViewer3DRigOverlayProps({
      ...state,
      selectedBoneId: kimodoDisplayedRigBoneIds.spine,
      rigMetaNamingByBoneId: displayNaming,
    }, {}, module.reduceViewer3DRigEditorVisibilityState(module.createViewer3DRigEditorVisibilityState(kimodoDisplayedRigSummary), { type: 'toggle', summary: kimodoDisplayedRigSummary }), panelProps.effectiveNaming)
    const inheritedPresentation = module.resolveViewer3DHumanoidReviewPresentationForHydrationSource({
      presentation: module.resolveViewer3DHumanoidReviewPresentation({
        trustedContractPresent: false,
        draftResult: {
          success: true,
          status: 'found',
          sidecarWorkspacePath: 'Workflows/1779535081_02857c58_unirig.humanoid-draft.v1.json',
          sidecar: kimodoSourceHumanoidDraftSidecar,
        },
        promotionResult: {
          success: true,
          status: 'found',
          sidecarWorkspacePath: 'Workflows/1779535081_02857c58_unirig.humanoid-promotion.v1.json',
          sidecar: kimodoSourceHumanoidPromotionSidecar,
        },
      }),
      semanticHydrationSource: {
        displayedMeshWorkspacePath: kimodoDisplayedWorkspacePath,
        semanticSourceWorkspacePath: kimodoSemanticSourceWorkspacePath,
        sourceKind: 'kimodo-source',
        warnings: [],
        failedClosed: false,
      },
    })

    assert.equal(hydrated.warning, null)
    assert.equal(panelProps.effectiveNaming.byBoneId[kimodoDisplayedRigBoneIds.hips].label, 'Hips')
    assert.equal(panelProps.effectiveNaming.byBoneId[kimodoDisplayedRigBoneIds.spine].label, 'Spine')
    assert.equal(panelProps.effectiveNaming.byBoneId[kimodoDisplayedRigBoneIds.chest].label, 'Chest')
    assert.equal(panelProps.effectiveNaming.byBoneId[kimodoDisplayedRigBoneIds.unmapped].label, 'bone_2')
    assert.equal(poseProps.rigDisplayNames.byBoneId[kimodoDisplayedRigBoneIds.spine].label, 'Spine')
    assert.equal(overlayProps.overlay?.selectedLabel, 'Spine')
    assert.equal(inheritedPresentation.canPromote, false)
    assert.equal(inheritedPresentation.state, 'promoted')
  } finally {
    await cleanup()
  }
})
test('Viewer3D rigmeta hydration surfaces humanoid draft naming as UniRig display labels without trusting the contract', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DRigEditorState(rawBoneRigSummary)
    const token = module.createViewer3DRigMetaHydrationToken({ modelUrl: '1779522315_382fd9a5_unirig.glb', summary: rawBoneRigSummary })

    const hydrated = module.applyViewer3DRigMetaHydrationResult({
      state,
      result: {
        success: true,
        status: 'found',
        rigMetaWorkspacePath: 'Workflows/1779522315_382fd9a5_unirig.rigmeta.json',
        warnings: [],
        namingByBoneId: {},
        rigMeta: {
          schema: 'modly.unirig.rigmeta',
          source: { workspacePath: 'Workflows/1779522315_382fd9a5_unirig.glb' },
          humanoid_contract_status: 'draft',
          humanoid_draft: {
            schema: 'modly.humanoid-draft.v1',
            assignments: {
              roles: {
                hips: 'bone_0',
                spine: 'bone_1',
              },
            },
          },
        },
      },
      token,
      currentToken: token,
    })

    assert.deepEqual(hydrated.state.rigMetaNamingByBoneId, {
      [contextualRigBoneIds.hips]: { label: 'Hips', source: 'humanoid_draft' },
      [contextualRigBoneIds.spine]: { label: 'Spine', source: 'humanoid_draft' },
    })
    assert.deepEqual(module.resolveViewer3DRigEditorPanelProps(hydrated.state, {}).effectiveNaming.ordered, [
      { boneId: contextualRigBoneIds.hips, label: 'Hips', rawLabel: 'bone_0', provenance: 'unirig' },
      { boneId: contextualRigBoneIds.spine, label: 'Spine', rawLabel: 'bone_1', provenance: 'unirig' },
      { boneId: contextualRigBoneIds.unmapped, label: 'bone_2', rawLabel: 'bone_2', provenance: 'raw' },
      { boneId: contextualRigBoneIds.chest, label: 'bone_3', rawLabel: 'bone_3', provenance: 'raw' },
      { boneId: contextualRigBoneIds.neck, label: 'bone_4', rawLabel: 'bone_4', provenance: 'raw' },
      { boneId: contextualRigBoneIds.head, label: 'bone_5', rawLabel: 'bone_5', provenance: 'raw' },
    ])
    assert.equal(module.resolveViewer3DHumanoidReviewPresentation({
      trustedContractPresent: false,
      draftResult: undefined,
      promotionResult: undefined,
    }).state, 'diagnostics-only')
  } finally {
    await cleanup()
  }
})
test('Viewer3D derives Rig Editor effective naming from humanoid draft assignments even when runtime RigBoneId values are contextual', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DRigEditorState(rawBoneRigSummary)
    const displayNaming = module.resolveViewer3DEffectiveRigMetaNaming({
      summary: rawBoneRigSummary,
      rigMetaNamingByBoneId: state.rigMetaNamingByBoneId,
      draftResult: {
        success: true,
        status: 'found',
        sidecarWorkspacePath: 'Workflows/outputs/raw-bones.humanoid-draft.v1.json',
        sidecar: rawBoneHumanoidDraftSidecar,
      },
      promotionResult: { success: true, status: 'not-found', sidecarWorkspacePath: 'Workflows/outputs/raw-bones.humanoid-promotion.v1.json' },
    })

    const panelProps = module.resolveViewer3DRigEditorPanelProps(state, {}, undefined, { rigMetaNamingByBoneId: displayNaming })

    assert.equal(panelProps.effectiveNaming.byBoneId[contextualRigBoneIds.hips].label, 'Hips')
    assert.equal(panelProps.effectiveNaming.byBoneId[contextualRigBoneIds.hips].provenance, 'unirig')
    assert.equal(panelProps.effectiveNaming.byBoneId[contextualRigBoneIds.spine].label, 'Spine')
    assert.equal(panelProps.effectiveNaming.byBoneId[contextualRigBoneIds.chest].label, 'Chest')
    assert.equal(panelProps.effectiveNaming.byBoneId[contextualRigBoneIds.neck].label, 'Neck')
    assert.equal(panelProps.effectiveNaming.byBoneId[contextualRigBoneIds.head].label, 'Head')
    assert.equal(panelProps.effectiveNaming.byBoneId[contextualRigBoneIds.unmapped].label, 'bone_2')
  } finally {
    await cleanup()
  }
})
test('Viewer3D prefers promotion role mappings for all mapped contextual runtime bones even when draft data is absent', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DRigEditorState(rawBoneRigSummary)
    const displayNaming = module.resolveViewer3DEffectiveRigMetaNaming({
      summary: rawBoneRigSummary,
      rigMetaNamingByBoneId: state.rigMetaNamingByBoneId,
      draftResult: { success: true, status: 'not-found', sidecarWorkspacePath: 'Workflows/outputs/raw-bones.humanoid-draft.v1.json' },
      promotionResult: { success: true, status: 'found', sidecarWorkspacePath: 'Workflows/outputs/raw-bones.humanoid-promotion.v1.json', sidecar: rawBoneHumanoidPromotionSidecar },
    })

    const panelProps = module.resolveViewer3DRigEditorPanelProps(state, {}, undefined, { rigMetaNamingByBoneId: displayNaming })

    assert.equal(panelProps.effectiveNaming.byBoneId[contextualRigBoneIds.hips].label, 'Hips')
    assert.equal(panelProps.effectiveNaming.byBoneId[contextualRigBoneIds.spine].label, 'Spine')
    assert.equal(panelProps.effectiveNaming.byBoneId[contextualRigBoneIds.chest].label, 'Chest')
    assert.equal(panelProps.effectiveNaming.byBoneId[contextualRigBoneIds.neck].label, 'Neck')
    assert.equal(panelProps.effectiveNaming.byBoneId[contextualRigBoneIds.head].label, 'Head')
  } finally {
    await cleanup()
  }
})
test('Viewer3D keeps manual aliases above humanoid draft display naming', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let state = module.createViewer3DRigEditorState(rawBoneRigSummary)
    state = module.reduceViewer3DRigEditorState(state, { type: 'set-alias', boneId: contextualRigBoneIds.spine, alias: 'Manual Spine Control' })
    const displayNaming = module.resolveViewer3DEffectiveRigMetaNaming({
      summary: rawBoneRigSummary,
      rigMetaNamingByBoneId: state.rigMetaNamingByBoneId,
      draftResult: {
        success: true,
        status: 'found',
        sidecarWorkspacePath: 'Workflows/outputs/raw-bones.humanoid-draft.v1.json',
        sidecar: rawBoneHumanoidDraftSidecar,
      },
      promotionResult: { success: true, status: 'not-found', sidecarWorkspacePath: 'Workflows/outputs/raw-bones.humanoid-promotion.v1.json' },
    })

    const panelProps = module.resolveViewer3DRigEditorPanelProps(state, {}, undefined, { rigMetaNamingByBoneId: displayNaming })

    assert.equal(panelProps.effectiveNaming.byBoneId[contextualRigBoneIds.spine].label, 'Manual Spine Control')
    assert.equal(panelProps.effectiveNaming.byBoneId[contextualRigBoneIds.spine].provenance, 'manual')
  } finally {
    await cleanup()
  }
})
test('Viewer3D Pose/Clip props receive the same semantic draft labels as Rig Editor effective naming', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const rigState = module.createViewer3DRigEditorState(rawBoneRigSummary)
    const displayNaming = module.resolveViewer3DEffectiveRigMetaNaming({
      summary: rawBoneRigSummary,
      rigMetaNamingByBoneId: rigState.rigMetaNamingByBoneId,
      draftResult: {
        success: true,
        status: 'found',
        sidecarWorkspacePath: 'Workflows/outputs/raw-bones.humanoid-draft.v1.json',
        sidecar: rawBoneHumanoidDraftSidecar,
      },
      promotionResult: { success: true, status: 'not-found', sidecarWorkspacePath: 'Workflows/outputs/raw-bones.humanoid-promotion.v1.json' },
    })
    let poseState = module.createViewer3DPoseClipState(rawBoneRigSummary)
    poseState = module.reduceViewer3DPoseClipState(poseState, { type: 'select-bone', summary: rawBoneRigSummary, boneId: contextualRigBoneIds.spine })

    const effectiveNaming = module.resolveViewer3DRigEditorPanelProps(rigState, {}, undefined, { rigMetaNamingByBoneId: displayNaming }).effectiveNaming
    const panelProps = module.resolveViewer3DPoseClipPanelProps(poseState, {}, effectiveNaming)

    assert.equal(panelProps.rigDisplayNames.byBoneId[contextualRigBoneIds.hips].label, 'Hips')
    assert.equal(panelProps.rigDisplayNames.byBoneId[contextualRigBoneIds.spine].label, 'Spine')
    assert.equal(panelProps.rigDisplayNames.byBoneId[contextualRigBoneIds.spine].provenance, 'unirig')
    assert.equal(panelProps.rigDisplayNames.byBoneId[contextualRigBoneIds.chest].label, 'Chest')
  } finally {
    await cleanup()
  }
})
test('Viewer3D selected-target overlay uses the same raw-bone semantic draft labels as Rig Editor and Pose/Clip', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    let rigState = module.createViewer3DRigEditorState(rawBoneRigSummary)
    rigState = module.reduceViewer3DRigEditorState(rigState, { type: 'select-bone', boneId: contextualRigBoneIds.hips })
    const displayNaming = module.resolveViewer3DEffectiveRigMetaNaming({
      summary: rawBoneRigSummary,
      rigMetaNamingByBoneId: rigState.rigMetaNamingByBoneId,
      draftResult: {
        success: true,
        status: 'found',
        sidecarWorkspacePath: 'Workflows/outputs/raw-bones.humanoid-draft.v1.json',
        sidecar: rawBoneHumanoidDraftSidecar,
      },
      promotionResult: { success: true, status: 'not-found', sidecarWorkspacePath: 'Workflows/outputs/raw-bones.humanoid-promotion.v1.json' },
    })
    const effectiveNaming = module.resolveViewer3DRigEditorPanelProps(rigState, {}, undefined, { rigMetaNamingByBoneId: displayNaming }).effectiveNaming
    const visibility = module.reduceViewer3DRigEditorVisibilityState(
      module.createViewer3DRigEditorVisibilityState(rawBoneRigSummary),
      { type: 'toggle', summary: rawBoneRigSummary },
    )

    const overlayProps = module.resolveViewer3DRigOverlayProps(rigState, {}, visibility, effectiveNaming)

    assert.equal(overlayProps.overlay.selectedBoneId, contextualRigBoneIds.hips)
    assert.equal(overlayProps.overlay.selectedLabel, 'Hips')
  } finally {
    await cleanup()
  }
})
test('Viewer3D resolves humanoid review presentation for draft, promoted, stale, trusted, and diagnostics-only states', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    assert.deepEqual(
      module.resolveViewer3DHumanoidReviewPresentation({
        trustedContractPresent: false,
        draftResult: { success: true, status: 'found', sidecarWorkspacePath: 'Workflows/generated/hero.humanoid-draft.v1.json', sidecar: humanoidDraftSidecar },
        promotionResult: { success: true, status: 'not-found', sidecarWorkspacePath: 'Workflows/generated/hero.humanoid-promotion.v1.json' },
      }),
      {
        state: 'draft',
        headline: 'Draft humanoid proposal available for manual review.',
        canPromote: true,
        diagnostics: ['Head role is still unresolved.'],
      },
    )

    assert.deepEqual(
      module.resolveViewer3DHumanoidReviewPresentation({
        trustedContractPresent: false,
        draftResult: { success: true, status: 'found', sidecarWorkspacePath: 'Workflows/generated/hero.humanoid-draft.v1.json', sidecar: humanoidDraftSidecar },
        promotionResult: { success: true, status: 'found', sidecarWorkspacePath: 'Workflows/generated/hero.humanoid-promotion.v1.json', sidecar: humanoidPromotionSidecar },
      }),
      {
        state: 'promoted',
        headline: 'Manual promotion is active for this mesh.',
        canPromote: true,
        diagnostics: ['Head role is still unresolved.'],
      },
    )

    assert.deepEqual(
      module.resolveViewer3DHumanoidReviewPresentation({
        trustedContractPresent: false,
        draftResult: {
          success: true,
          status: 'stale',
          sidecarWorkspacePath: 'Workflows/generated/hero.humanoid-draft.v1.json',
          sidecar: humanoidDraftSidecar,
          staleReasons: ['mesh_output_sha256_mismatch'],
        },
        promotionResult: { success: true, status: 'not-found', sidecarWorkspacePath: 'Workflows/generated/hero.humanoid-promotion.v1.json' },
      }),
      {
        state: 'stale',
        headline: 'Humanoid draft or promotion is stale and blocked.',
        canPromote: false,
        diagnostics: ['Head role is still unresolved.', 'mesh_output_sha256_mismatch'],
      },
    )

    assert.deepEqual(
      module.resolveViewer3DHumanoidReviewPresentation({
        trustedContractPresent: true,
        draftResult: { success: true, status: 'not-found', sidecarWorkspacePath: 'Workflows/generated/hero.humanoid-draft.v1.json' },
        promotionResult: { success: true, status: 'not-found', sidecarWorkspacePath: 'Workflows/generated/hero.humanoid-promotion.v1.json' },
      }),
      {
        state: 'trusted',
        headline: 'Trusted UniRig humanoid contract is already present.',
        canPromote: false,
        diagnostics: [],
      },
    )

    assert.deepEqual(
      module.resolveViewer3DHumanoidReviewPresentation({
        trustedContractPresent: false,
        draftResult: { success: true, status: 'not-found', sidecarWorkspacePath: 'Workflows/generated/hero.humanoid-draft.v1.json' },
        promotionResult: { success: false, status: 'invalid', error: 'Invalid humanoid promotion sidecar v1: invalid_output_workspace_path' },
      }),
      {
        state: 'diagnostics-only',
        headline: 'No promotable humanoid draft is available for this mesh.',
        canPromote: false,
        diagnostics: ['Invalid humanoid promotion sidecar v1: invalid_output_workspace_path'],
      },
    )
  } finally {
    await cleanup()
  }
})
test('Viewer3D promotion gating requires a valid draft, explicit confirmation, rationale, and an available writer', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const draftPresentation = module.resolveViewer3DHumanoidReviewPresentation({
      trustedContractPresent: false,
      draftResult: { success: true, status: 'found', sidecarWorkspacePath: 'Workflows/generated/hero.humanoid-draft.v1.json', sidecar: humanoidDraftSidecar },
      promotionResult: { success: true, status: 'not-found', sidecarWorkspacePath: 'Workflows/generated/hero.humanoid-promotion.v1.json' },
    })

    assert.deepEqual(module.resolveViewer3DHumanoidPromotionGate({
      presentation: draftPresentation,
      rationale: '',
      confirmationChecked: false,
      writerAvailable: true,
    }), {
      allowed: false,
      reason: 'Explicit confirmation is required before manual promotion.',
    })

    assert.deepEqual(module.resolveViewer3DHumanoidPromotionGate({
      presentation: draftPresentation,
      rationale: '',
      confirmationChecked: true,
      writerAvailable: true,
    }), {
      allowed: false,
      reason: 'Promotion rationale is required for auditability.',
    })

    assert.deepEqual(module.resolveViewer3DHumanoidPromotionGate({
      presentation: draftPresentation,
      rationale: 'Reviewed in Viewer3D.',
      confirmationChecked: true,
      writerAvailable: false,
    }), {
      allowed: false,
      reason: 'Workspace humanoid promotion writer is unavailable.',
    })

    assert.deepEqual(module.resolveViewer3DHumanoidPromotionGate({
      presentation: draftPresentation,
      rationale: 'Reviewed in Viewer3D.',
      confirmationChecked: true,
      writerAvailable: true,
    }), {
      allowed: true,
    })

    const stalePresentation = module.resolveViewer3DHumanoidReviewPresentation({
      trustedContractPresent: false,
      draftResult: {
        success: true,
        status: 'stale',
        sidecarWorkspacePath: 'Workflows/generated/hero.humanoid-draft.v1.json',
        sidecar: humanoidDraftSidecar,
        staleReasons: ['draft_sha256_mismatch'],
      },
      promotionResult: { success: true, status: 'not-found', sidecarWorkspacePath: 'Workflows/generated/hero.humanoid-promotion.v1.json' },
    })

    assert.deepEqual(module.resolveViewer3DHumanoidPromotionGate({
      presentation: stalePresentation,
      rationale: 'Reviewed in Viewer3D.',
      confirmationChecked: true,
      writerAvailable: true,
    }), {
      allowed: false,
      reason: 'Promotion is blocked until the stale humanoid artifacts are regenerated.',
    })
  } finally {
    await cleanup()
  }
})
test('Viewer3D humanoid proposal helpers only edit proposed assignments and never mutate the source draft or rig summary', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const sourceDraft = structuredClone(humanoidDraftSidecar)
    const sourceSummary = structuredClone(rigSummary)
    const initialAssignments = module.createViewer3DHumanoidProposedAssignments(sourceDraft)
    const nextRoles = module.applyViewer3DHumanoidRoleProposalChange(initialAssignments, 'spine', { boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', label: 'Chest', confidence: 0.91 })
    const nextChains = module.applyViewer3DHumanoidChainProposalChange(nextRoles, 'left_arm', [
      'rig:hero|skeleton:0|bone:hips#0',
      'rig:hero|skeleton:0|bone:hips#0/spine#0',
    ])

    assert.notEqual(nextRoles, initialAssignments)
    assert.notEqual(nextChains, nextRoles)
    assert.equal(nextChains.roles.spine.label, 'Chest')
    assert.deepEqual(nextChains.chains.left_arm, [
      'rig:hero|skeleton:0|bone:hips#0',
      'rig:hero|skeleton:0|bone:hips#0/spine#0',
    ])

    assert.equal(sourceDraft.assignments.roles.spine.label, 'Spine')
    assert.equal((sourceDraft.assignments.chains as Record<string, unknown>)['left_arm'], undefined)
    assert.deepEqual(sourceSummary, rigSummary)
  } finally {
    await cleanup()
  }
})
test('Viewer3D keeps humanoid promotion inside Rig Editor props without a separate HumanoidReviewPanel sibling surface', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const state = module.createViewer3DRigEditorState(rawBoneRigSummary)
    const rigEditorProps = module.resolveViewer3DRigEditorPanelProps(state, {}, undefined, {
      rigMetaNamingByBoneId: module.resolveViewer3DEffectiveRigMetaNaming({
        summary: rawBoneRigSummary,
        rigMetaNamingByBoneId: state.rigMetaNamingByBoneId,
        draftResult: {
          success: true,
          status: 'found',
          sidecarWorkspacePath: 'Workflows/outputs/raw-bones.humanoid-draft.v1.json',
          sidecar: rawBoneHumanoidDraftSidecar,
        },
        promotionResult: { success: true, status: 'found', sidecarWorkspacePath: 'Workflows/outputs/raw-bones.humanoid-promotion.v1.json', sidecar: rawBoneHumanoidPromotionSidecar },
      }),
      humanoidReview: module.resolveViewer3DRigHumanoidReviewProps({
        presentation: module.resolveViewer3DHumanoidReviewPresentation({
          trustedContractPresent: false,
          draftResult: {
            success: true,
            status: 'found',
            sidecarWorkspacePath: 'Workflows/outputs/raw-bones.humanoid-draft.v1.json',
            sidecar: rawBoneHumanoidDraftSidecar,
          },
          promotionResult: { success: true, status: 'found', sidecarWorkspacePath: 'Workflows/outputs/raw-bones.humanoid-promotion.v1.json', sidecar: rawBoneHumanoidPromotionSidecar },
        }),
        draft: rawBoneHumanoidDraftSidecar,
        promotion: rawBoneHumanoidPromotionSidecar,
        proposedAssignments: module.createViewer3DHumanoidProposedAssignments(rawBoneHumanoidDraftSidecar),
        rationale: 'Reviewed against Rig Editor semantic names.',
        confirmationChecked: true,
        saveState: { status: 'idle' },
        onRationaleChange: () => {},
        onConfirmationChange: () => {},
        onPromote: () => {},
      }),
    })

    assert.equal('HumanoidReviewPanel' in module, false)
    assert.ok(rigEditorProps.humanoidReview)
    assert.equal(rigEditorProps.humanoidReview.presentation.state, 'promoted')
    assert.equal(rigEditorProps.humanoidReview.presentation.headline.includes('Humanoid review'), false)
    assert.equal('draft' in rigEditorProps.humanoidReview, false)
    assert.equal('proposedAssignments' in rigEditorProps.humanoidReview, false)
  } finally {
    await cleanup()
  }
})
test('Viewer3D resolves default manual-confirmation audit input for the minimal Rig Editor promote button', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    assert.deepEqual(module.resolveViewer3DHumanoidPromotionButtonAudit(), {
      rationale: 'Manual confirmation from Rig Editor',
      confirmationChecked: true,
    })

    const request = module.buildViewer3DHumanoidPromotionWriteRequest({
      meshWorkspacePath: 'Workflows/generated/raw-bones.glb',
      draft: rawBoneHumanoidDraftSidecar,
      proposedAssignments: module.createViewer3DHumanoidProposedAssignments(rawBoneHumanoidDraftSidecar),
      ...module.resolveViewer3DHumanoidPromotionButtonAudit(),
      createdAt: '2026-05-23T11:30:00.000Z',
      confirmedBy: 'modly:user:local:drhepa',
      confirmedByLabel: 'drhepa',
      method: 'viewer3d',
      promotionId: 'promotion-raw-bones',
    })

    assert.deepEqual(request.sidecar.promotedAssignments, rawBoneHumanoidDraftSidecar.assignments)
    assert.equal(request.sidecar.audit.rationale, 'Manual confirmation from Rig Editor')
    assert.equal(request.sidecar.provenance.trustStatus, 'manual_confirmed')
  } finally {
    await cleanup()
  }
})
test('Viewer3D builds auditable humanoid promotion sidecars from proposed assignments without altering draft trust semantics', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const proposedAssignments = module.applyViewer3DHumanoidRoleProposalChange(
      module.createViewer3DHumanoidProposedAssignments(humanoidDraftSidecar),
      'spine',
      { boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', label: 'Chest', confidence: 0.91 },
    )

    const request = module.buildViewer3DHumanoidPromotionWriteRequest({
      meshWorkspacePath: 'Workflows/generated/hero.glb',
      draft: humanoidDraftSidecar,
      existingPromotion: humanoidPromotionSidecar,
      proposedAssignments,
      rationale: 'Reviewed spine mapping against the overlay and keeping this as manual_confirmed only.',
      createdAt: '2026-05-22T21:05:00.000Z',
      confirmedBy: 'modly:user:local:drhepa',
      confirmedByLabel: 'drhepa',
      method: 'add-to-scene',
      promotionId: 'promotion-456',
    })

    assert.deepEqual(request, {
      meshWorkspacePath: 'Workflows/generated/hero.glb',
      sidecar: {
        schema: 'modly.humanoid-promotion.v1',
        version: 1,
        promotionId: 'promotion-456',
        supersedesPromotionId: 'promotion-123',
        source: { workspacePath: 'Characters/hero-source.glb' },
        output: { workspacePath: 'Workflows/generated/hero.glb' },
        meshOutputSha256: 'mesh-sha-123',
        rigmetaSha256: 'rigmeta-sha-123',
        draftSha256: 'draft-sha-123',
        draftSchema: 'modly.humanoid-draft.v1',
        promotedAssignments: {
          roles: {
            hips: { boneId: 'rig:hero|skeleton:0|bone:hips#0', label: 'Hips', confidence: 0.98 },
            spine: { boneId: 'rig:hero|skeleton:0|bone:hips#0/spine#0', label: 'Chest', confidence: 0.91 },
          },
          chains: {
            spine: ['rig:hero|skeleton:0|bone:hips#0', 'rig:hero|skeleton:0|bone:hips#0/spine#0'],
          },
        },
        provenance: { basis: 'modly.humanoid-draft.v1', trustStatus: 'manual_confirmed' },
        audit: {
          confirmedBy: 'modly:user:local:drhepa',
          confirmedByLabel: 'drhepa',
          createdAt: '2026-05-22T21:05:00.000Z',
          method: 'add-to-scene',
          rationale: 'Reviewed spine mapping against the overlay and keeping this as manual_confirmed only.',
        },
      },
    })

    assert.equal(humanoidDraftSidecar.trust.status, 'draft')
    assert.equal(humanoidDraftSidecar.assignments.roles.spine.label, 'Spine')
  } finally {
    await cleanup()
  }
})
test('Viewer3D promotion write requests preserve draft proposedAssignments unchanged when the reviewer does not edit them', async () => {
  const { module, cleanup } = await loadViewer3DModule()

  try {
    const proposedAssignments = module.createViewer3DHumanoidProposedAssignments(humanoidDraftSidecar)

    const request = module.buildViewer3DHumanoidPromotionWriteRequest({
      meshWorkspacePath: 'Workflows/generated/hero.glb',
      draft: humanoidDraftSidecar,
      proposedAssignments,
      rationale: 'Confirmed draft matches the Rig Editor naming and hierarchy.',
      createdAt: '2026-05-23T08:00:00.000Z',
      confirmedBy: 'modly:user:local:drhepa',
      confirmedByLabel: 'drhepa',
      method: 'import',
      promotionId: 'promotion-789',
    })

    assert.deepEqual(request.sidecar.promotedAssignments, humanoidDraftSidecar.assignments)
    assert.notEqual(request.sidecar.promotedAssignments, humanoidDraftSidecar.assignments)
    assert.equal(request.sidecar.provenance.trustStatus, 'manual_confirmed')
  } finally {
    await cleanup()
  }
})

function quaternionValue(quaternion: THREE.Quaternion) {
  return { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w }
}

function assertQuaternionClose(actual: THREE.Quaternion | undefined, expected: THREE.Quaternion, epsilon = 0.000001) {
  assert.ok(actual, 'expected quaternion to exist')
  assert.ok(Math.abs(actual.x - expected.x) <= epsilon, `x expected ${expected.x} got ${actual.x}`)
  assert.ok(Math.abs(actual.y - expected.y) <= epsilon, `y expected ${expected.y} got ${actual.y}`)
  assert.ok(Math.abs(actual.z - expected.z) <= epsilon, `z expected ${expected.z} got ${actual.z}`)
  assert.ok(Math.abs(actual.w - expected.w) <= epsilon, `w expected ${expected.w} got ${actual.w}`)
}

test('Viewer3D rigmeta hydration preserves main read diagnostics alongside current-summary normalization', async () => {
  const { module, cleanup } = await loadViewer3DModule()
  try {
    const state = module.createViewer3DRigEditorState(rigSummary)
    const token = module.createViewer3DRigMetaHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })
    const hydrated = module.applyViewer3DRigMetaHydrationResult({ state, token, currentToken: token, result: {
      success: true, status: 'found', rigMetaWorkspacePath: 'Workflows/outputs/hero.rigmeta.json',
      rigMeta: { semantic_candidates: { [rigSummary.bones[0]!.boneId]: 'Pelvis' } },
      namingByBoneId: {}, warnings: ['An optional metadata entry was ignored by the reader.'],
    } })
    assert.deepEqual(hydrated.warning?.messages, ['An optional metadata entry was ignored by the reader.'])
    assert.equal(hydrated.state.rigMetaNamingByBoneId[rigSummary.bones[0]!.boneId].label, 'Pelvis')
  } finally { await cleanup() }
})

test('Viewer3D metadata descriptor rejects contradictory artifact paths, foreign origins and unconfigured absolute custody', async () => {
  const { module, cleanup } = await loadViewer3DModule()
  try {
    const apiUrl = 'http://local.test'
    const uri = '/workspace/Workflows/kimodo-run/animated.glb'
    const artifact = { id: 'run', kind: 'mesh', uri, versionId: 'v1', legacy: { filePath: uri, outputType: 'mesh' } }
    assert.ok(module.resolveViewer3DKimodoMetadataDescriptor({ apiUrl, artifact, modelUrl: apiUrl + uri }))
    const genericUri = '/workspace/Workflows/run/animated.glb'
    const genericArtifact = { ...artifact, uri: genericUri, legacy: { ...artifact.legacy, filePath: genericUri } }
    assert.equal(module.resolveViewer3DKimodoMetadataDescriptor({ apiUrl, artifact: genericArtifact, modelUrl: apiUrl + genericUri }), undefined, 'A consistent non-Kimodo path is not a Kimodo metadata candidate')
    for (const modelUrl of ['http://evil.test' + uri, apiUrl + '/workspace/Workflows/other/animated.glb', apiUrl + '/workspace/Workflows/./kimodo-run/animated.glb', apiUrl + '/workspace/Workflows/%252e%252e/a.glb', apiUrl + '/workspace/bad%.glb']) {
      assert.equal(module.resolveViewer3DKimodoMetadataDescriptor({ apiUrl, artifact, modelUrl }), undefined, modelUrl)
    }
    assert.equal(module.resolveViewer3DKimodoMetadataDescriptor({ apiUrl, artifact: { ...artifact, legacy: { ...artifact.legacy, filePath: '/workspace/another.glb' } }, modelUrl: apiUrl + uri }), undefined)
    const absolute = '/configured/workspace/Workflows/kimodo-run/animated.glb'
    const modelUrl = apiUrl + '/optimize/serve-file?path=' + encodeURIComponent(absolute)
    assert.equal(module.resolveViewer3DKimodoMetadataDescriptor({ apiUrl, modelUrl }), undefined)
    assert.equal(module.resolveViewer3DKimodoMetadataDescriptor({ apiUrl, modelUrl, workspaceDir: '/configured/workspace' })?.artifactWorkspacePath, 'Workflows/kimodo-run/animated.glb')
    assert.equal(module.resolveViewer3DKimodoMetadataDescriptor({ apiUrl, modelUrl: modelUrl.replace('configured', 'lookalike'), workspaceDir: '/configured/workspace' }), undefined)
    assert.equal(module.resolveViewer3DKimodoMetadataDescriptor({ apiUrl, modelUrl: modelUrl + '&path=' + encodeURIComponent(absolute), workspaceDir: '/configured/workspace' }), undefined)
  } finally { await cleanup() }
})

test('Viewer3D correction save/read use actual skeleton identity and reject contradictory source or artifact fields', async () => {
  const { module, cleanup } = await loadViewer3DModule()
  try {
    const state = module.createViewer3DMotionRetargetState(rigSummary, motionRetargetSession)
    let request: any
    await module.writeViewer3DMotionRetargetSidecar({ state, writer: async (value: any) => { request = value; return { success: true, ...value } } })
    assert.equal(request.sidecarWorkspacePath, `Workflows/motion-retarget/${state.identity.key}.motion-retarget.v1.json`)
    assert.equal(module.resolveViewer3DMotionRetargetHydrationRequest(rigSummary, motionRetargetSession).sidecarWorkspacePath, request.sidecarWorkspacePath)
    const token = module.createViewer3DMotionRetargetHydrationToken({ modelUrl: 'hero.glb', summary: rigSummary })
    const hydrate = (sidecar: any) => module.applyViewer3DMotionRetargetHydrationResult({ state, token, currentToken: token, result: { success: true, status: 'found', sidecarWorkspacePath: request.sidecarWorkspacePath, sidecar } }).state
    assert.equal(hydrate(request.sidecar).loadState, 'loaded')
    assert.equal(hydrate({ ...request.sidecar, identity: { ...request.sidecar.identity, skeletonContextId: 'other' } }).loadState, 'error')
    assert.equal(hydrate({ ...request.sidecar, identity: { ...request.sidecar.identity, workflowId: 'other' } }).loadState, 'error')
    assert.equal(hydrate({ ...request.sidecar, source: { workspacePath: 'other.glb' } }).loadState, 'error')
    assert.equal(hydrate({ ...request.sidecar, artifact: { ...request.sidecar.artifact, workflowId: 'other' } }).loadState, 'error')
    const legacy = { ...request.sidecar }; delete legacy.identity
    assert.equal(hydrate(legacy).loadState, 'loaded', 'legacy sidecar still requires matching source and artifact')
  } finally { await cleanup() }
})

test('Viewer3D rejects fabricated readiness while preserving valid degraded sidecar and GLB capabilities', async () => {
  const { module, cleanup } = await loadViewer3DModule()
  try {
    const forged = { ...motionRetargetSession, artifact: { ...motionRetargetSession.artifact, motionRetarget: undefined } }
    const state = { ...module.createViewer3DMotionRetargetState(rigSummary), session: forged }
    const panel = module.resolveViewer3DMotionRetargetPanelProps(state, {})
    assert.ok(panel.saveDisabledReason)
    assert.ok(panel.previewDisabledReason)
    assert.ok(panel.exportDisabledReason)
    assert.equal(panel.session.unlockReadiness.playbackAvailable, true)
    let writes = 0
    assert.equal((await module.writeViewer3DMotionRetargetSidecar({ state, writer: async () => { writes++; throw new Error('must not write') } })).success, false)
    assert.equal(writes, 0)
    const valid = module.resolveViewer3DMotionRetargetPanelProps(module.createViewer3DMotionRetargetState(rigSummary, motionRetargetSession), {})
    assert.equal(valid.session.exportReadiness.canSaveSidecar, true)
    assert.equal(valid.session.exportReadiness.canExportPoseClip, true)
    assert.equal(valid.session.exportReadiness.coherentExportReady, false)
    assert.equal(valid.artifactLinks.some((entry: any) => entry.key === 'animated-glb'), true)
  } finally { await cleanup() }
})


test('Viewer3D metadata refresh preserves correction ownership for the same identity and resets a different identity', async () => {
  const { module, cleanup } = await loadViewer3DModule()
  try {
    let state = module.createViewer3DMotionRetargetState(rigSummary, motionRetargetSession)
    state = module.reduceViewer3DMotionRetargetState(state, { type: 'set-corrections', corrections: { ...state.corrections, rootMotionScale: 2.75 } })
    const refreshed = module.reduceViewer3DMotionRetargetState(state, { type: 'set-session', session: structuredClone(state.session) })
    assert.equal(refreshed.identity.key, state.identity.key)
    assert.deepEqual(refreshed.correctionState, state.correctionState)
    assert.deepEqual(refreshed.corrections, state.corrections)
    const other = module.reduceViewer3DMotionRetargetState(state, { type: 'set-session', session: { ...state.session, artifact: { ...state.session.artifact, workflowNodeId: 'different-node' } } })
    assert.notEqual(other.identity.key, state.identity.key)
    assert.equal(other.correctionState.status, 'idle')
    assert.equal(other.corrections.rootMotionScale, 1)
  } finally { await cleanup() }
})


test('Viewer3D explicit artifact viewing overrides automatic fallback without changing quality diagnostics', async () => {
  const { module, cleanup } = await loadViewer3DModule()
  try {
    const session = { ...motionRetargetSession, artifact: { ...motionRetargetSession.artifact, diagnostics: { ...motionRetargetSession.artifact.diagnostics, retargetStatus: 'failed' } } }
    const input = { defaultModelUrl: null, apiUrl: 'http://127.0.0.1:8000', session }
    assert.equal(module.resolveViewer3DMotionRetargetModelPresentation(input).modelUrl, 'http://127.0.0.1:8000/workspace/Workflows/kimodo/run-1/preview.glb')
    const explicit = module.resolveViewer3DMotionRetargetModelPresentation({ ...input, explicitPreview: 'animated-glb' })
    assert.equal(explicit.modelUrl, 'http://127.0.0.1:8000/workspace/Workflows/kimodo/run-1/animated.glb')
    assert.deepEqual(explicit.warnings, session.warnings)
    assert.equal(session.artifact.diagnostics.retargetStatus, 'failed')
  } finally { await cleanup() }
})


test('Viewer3D failed correction hydration preserves dirty and saved ownership before a later valid read', async () => {
  const { module, cleanup } = await loadViewer3DModule()
  try {
    const clean = module.createViewer3DMotionRetargetState(rigSummary, motionRetargetSession)
    let saved: any
    await module.writeViewer3DMotionRetargetSidecar({ state: clean, writer: async (request: any) => { saved = request; return { success: true, ...request } } })
    assert.ok(saved)
    const token = module.createViewer3DMotionRetargetHydrationToken({ modelUrl: '/workspace/' + rigSummary.sourceWorkspacePath, summary: rigSummary })
    const found = { success: true, status: 'found', ...saved }
    const loaded = module.applyViewer3DMotionRetargetHydrationResult({ state: clean, token, currentToken: token, result: found }).state
    const dirty = module.reduceViewer3DMotionRetargetState(loaded, { type: 'set-corrections', corrections: { rootMotionScale: 2.75 } })
    const mismatched = structuredClone(found)
    mismatched.sidecar.identity.skeletonContextId += '|retired'
    for (const initial of [loaded, dirty]) {
      for (const result of [mismatched, { success: false, error: 'Corrupt sidecar' }, { success: true, status: 'not-found', ...saved }]) {
        const rejected = module.applyViewer3DMotionRetargetHydrationResult({ state: initial, token, currentToken: token, result }).state
        assert.deepEqual(rejected.correctionState, initial.correctionState)
        assert.deepEqual(rejected.corrections, initial.corrections)
        assert.deepEqual(rejected.session, initial.session)
        const later = module.applyViewer3DMotionRetargetHydrationResult({ state: rejected, token, currentToken: token, result: found }).state
        if (initial.correctionState.dirty) {
          assert.equal(later.correctionState.dirty, true)
          assert.equal(later.corrections.rootMotionScale, 2.75)
        }
      }
    }
  } finally { await cleanup() }
})

test('Viewer3D correction Save rejects generated source aliases before dispatch without disabling a permitted source', async () => {
  const { module, cleanup } = await loadViewer3DModule()
  try {
    for (const field of ['bundleWorkspacePath', 'metadataWorkspacePath', 'previewGlbWorkspacePath', 'animatedGlbWorkspacePath', 'canonicalMotionArtifactWorkspacePath', 'motionNpzWorkspacePath', 'motionBvhWorkspacePath']) {
      const session = { ...motionRetargetSession, artifact: { ...motionRetargetSession.artifact, [field]: rigSummary.sourceWorkspacePath } }
      const state = module.createViewer3DMotionRetargetState(rigSummary, session)
      const panel = module.resolveViewer3DMotionRetargetPanelProps(state, {})
      assert.match(panel.saveDisabledReason, /source.*distinct.*artifact/i)
      let calls = 0
      const result = await module.writeViewer3DMotionRetargetSidecar({ state, writer: async () => { calls++; throw new Error('Contradictory source must not dispatch') } })
      assert.equal(result.success, false)
      assert.equal(calls, 0)
    }
    assert.equal(module.resolveViewer3DMotionRetargetPanelProps(module.createViewer3DMotionRetargetState(rigSummary, motionRetargetSession), {}).saveDisabledReason, undefined)
  } finally { await cleanup() }
})

test('Viewer3D promotion forwards a discovery source receipt without inventing one for legacy reads', async () => {
  const { module, cleanup } = await loadViewer3DModule()
  try {
    const args = { meshWorkspacePath: humanoidDraftSidecar.output.workspacePath, draft: humanoidDraftSidecar,
      proposedAssignments: humanoidDraftSidecar.assignments, rationale: 'Reviewed', createdAt: '2026-10-07',
      confirmedBy: 'modly:user:local:manual', method: 'viewer3d', promotionId: 'receipt-test' }
    const reviewed = module.buildViewer3DHumanoidPromotionWriteRequest({ ...args, sourceSha256: 'discovery-receipt' })
    assert.equal(reviewed.sidecar.sourceSha256, 'discovery-receipt')
    assert.equal(Object.hasOwn(module.buildViewer3DHumanoidPromotionWriteRequest(args).sidecar, 'sourceSha256'), false)
  } finally { await cleanup() }
})

test('Viewer3D trusted required roles need positive unambiguous current rig bindings', async () => {
  const { module, cleanup } = await loadViewer3DModule()
  try {
    const metadata = (roles: unknown) => ({ semantic_candidates: { unrelated: 'Ordinary display label' }, humanoid_contract: {
      schema: 'modly.humanoid.v1', humanoid_contract_status: 'trusted', validation: { status: 'validated' },
      provenance: { trust_scope: { trusted: ['required_roles'] } }, required_roles: roles,
    } })
    const id = rigSummary.bones[0].boneId
    for (const roles of [{}, [], { hips: 'not-an-actual-bone' }, { hips: id, spine: 'absent' }, { hips: id, spine: id }]) {
      assert.equal(module.hasTrustedHumanoidContract(metadata(roles), rigSummary), false)
    }
    assert.equal(module.hasTrustedHumanoidContract(metadata({ customRole: id }), rigSummary), true, 'no arbitrary role-name whitelist')
    assert.equal(module.hasTrustedHumanoidContract(metadata({ hips: id }), { ...rigSummary, hasRig: false }), false)
    assert.equal(module.hasTrustedHumanoidContract(metadata({ hips: id }), undefined), false)
    const ambiguous = { ...rigSummary, bones: rigSummary.bones.map((bone: any) => ({ ...bone, originalName: 'duplicate' })) }
    assert.equal(module.hasTrustedHumanoidContract(metadata({ hips: 'duplicate' }), ambiguous), false)
  } finally { await cleanup() }
})

test('Viewer3D degraded source fallback requires positive bundle identity and exact preview ownership', async () => {
  const { module, cleanup } = await loadViewer3DModule()
  try {
    const apiUrl = 'http://127.0.0.1:8000'
    const defaultModelUrl = `${apiUrl}/workspace/Workflows/kimodo/run/preview.glb`
    const descriptor = module.resolveViewer3DKimodoMetadataDescriptor({ apiUrl, modelUrl: defaultModelUrl })
    const metadata = { extension_id: 'kimodo-soma-rp', node_id: 'animate-rigged-mesh', runtime_status: 'failed',
      preview_artifact: 'preview.glb', source_workspace_path: 'Workflows/rig.glb' }
    const args = { apiUrl, defaultModelUrl, descriptor, metadata, previewHasUsableRig: false }
    assert.equal(module.resolveViewer3DKimodoSourceRigFallback(args).active, true)
    for (const value of [
      { ...metadata, extension_id: undefined }, { ...metadata, node_id: 'unrelated' },
      { ...metadata, preview_artifact: 'Workflows/other/preview.glb' },
      { ...metadata, preview_artifact: undefined }, { ...metadata, source_workspace_path: 'Workflows/kimodo/run/preview.glb' },
      { ...metadata, source_workspace_path: 'Workflows/kimodo/run/animated.glb', animated_artifact: 'animated.glb' },
      { ...metadata, source_workspace_path: 'Workflows/rig.glb', source_rigged_mesh: '/outside/rig.glb' },
      { ...metadata, source_workspace_path: 'Workflows/%252e%252e/rig.glb' },
      { ...metadata, source_workspace_path: 'Workflows/./rig.glb' },
      { ...metadata, kimodo_motion_retarget: { source_contract: { source_mesh_workspace_path: 'Workflows/unrelated.glb' } } },
    ]) assert.equal(module.resolveViewer3DKimodoSourceRigFallback({ ...args, metadata: value }).active, false, JSON.stringify(value))
    assert.equal(module.resolveViewer3DKimodoSourceRigFallback({ ...args, defaultModelUrl: 'https://foreign.invalid/workspace/Workflows/kimodo/run/preview.glb' }).active, false)
    const absolute = { ...metadata, source_rigged_mesh: '/configured/workspace/Workflows/rig.glb' }
    assert.equal(module.resolveViewer3DKimodoSourceRigFallback({ ...args, metadata: absolute }).active, false)
    assert.equal(module.resolveViewer3DKimodoSourceRigFallback({ ...args, metadata: absolute, workspaceDir: '/configured/workspace' }).active, true)
    assert.equal(module.resolveViewer3DKimodoSourceRigFallback({ ...args, metadata: { ...absolute, source_workspace_path: 'Workflows/other.glb' }, workspaceDir: '/configured/workspace' }).active, false)
  } finally { await cleanup() }
})

// CPU lifecycle coverage: real React effects, stores, Scene/Bone identities and
// sidecar services. Only rendering/loaders are adapters; no GLB/GPU/UI claim.
test('Viewer3D mounted degraded-bundle ownership', async suite => {
  const THREE: typeof import('three') = require('three')
  const { createElement } = require('react')
  const axios = require('axios') // Resolve Node transport before browser doubles.
  type Host = { type: string; props: any; children: Host[] }
  const context = {}
  const remove = (parent: Host, child: Host) => {
    const index = parent.children.indexOf(child)
    if (index >= 0) parent.children.splice(index, 1)
  }
  const append = (parent: Host, child: Host) => { remove(parent, child); parent.children.push(child) }
  const insert = (parent: Host, child: Host, before: Host) => { remove(parent, child); parent.children.splice(parent.children.indexOf(before), 0, child) }
  const renderer = require('react-reconciler')({
    now: Date.now, supportsMutation: true, isPrimaryRenderer: false,
    getRootHostContext: () => context, getChildHostContext: () => context,
    getPublicInstance: (instance: Host) => instance, prepareForCommit: () => null, resetAfterCommit: () => undefined,
    createInstance: (type: string, props: any) => ({ type, props, children: [] }),
    createTextInstance: (text: string) => ({ type: '#text', props: { text }, children: [] }),
    appendInitialChild: append, appendChild: append, appendChildToContainer: append,
    removeChild: remove, removeChildFromContainer: remove, insertBefore: insert, insertInContainerBefore: insert,
    finalizeInitialChildren: () => false, shouldSetTextContent: () => false, prepareUpdate: () => true,
    commitUpdate: (instance: Host, _payload: unknown, _type: string, _old: unknown, props: any) => { instance.props = props },
    commitTextUpdate: (instance: Host, _old: string, text: string) => { instance.props.text = text },
    clearContainer: (host: Host) => { host.children = [] }, detachDeletedInstance: () => undefined,
    scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1,
  })
  function flush(callback = () => undefined as void) {
    renderer.flushSync(callback)
    for (let i = 0; i < 10; i++) {
      if (!renderer.flushPassiveEffects()) return
      renderer.flushSync(() => undefined)
    }
    assert.fail('Viewer effects did not settle')
  }
  async function settle() { for (let i = 0; i < 8; i++) { await Promise.resolve(); flush() } }
  function find(host: Host, predicate: (node: Host) => boolean): Host | undefined {
    if (predicate(host)) return host
    for (const child of host.children) { const found = find(child, predicate); if (found) return found }
  }
  function deferred() {
    let resolve!: (value: any) => void
    const promise = new Promise<any>(yes => { resolve = yes })
    return { promise, resolve }
  }
  const previewUrl = '/workspace/Workflows/kimodo/run/preview.glb'
  const sourceUrl = '/workspace/Workflows/rig.glb'
  const animatedUrl = '/workspace/Workflows/kimodo/run/animated.glb'
  const degraded = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    extension_id: 'kimodo-soma-rp', node_id: 'animate-rigged-mesh',
    runtime_status: 'failed', retarget_status: 'failed', animation_mapping_status: 'failed', visual_quality_status: 'preview-only',
    preview_artifact: 'preview.glb', canonical_motion_artifact: 'motion.npz', motion_bvh_artifact: 'motion.bvh',
    source_workspace_path: 'Workflows/rig.glb', warnings: ['degraded fixture'], ...extra,
  })
  const response = (metadata = degraded()) => ({ ok: true, json: async () => metadata })
  function asset(harness: any, url: string, rigged = true) {
    const scene = new THREE.Group()
    const root = new THREE.Bone(); root.name = 'root'
    const child = new THREE.Bone(); child.name = 'child'; child.position.y = 1; root.add(child)
    const geometry = new THREE.BoxGeometry()
    const count = geometry.getAttribute('position').count
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4))
    const weights = new Float32Array(count * 4)
    for (let i = 0; i < count; i++) weights[i * 4] = 1
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4))
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial())
    if (rigged) { scene.add(root, mesh); mesh.bind(new THREE.Skeleton([child, root])) }
    else scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()))
    harness.gltf.set(url, { scene, animations: [] })
    return { scene, root, child, mesh }
  }
  const draftFor = (output = 'Workflows/rig.glb') => ({
    schema: 'modly.humanoid-draft.v1', version: 1, source: { workspacePath: 'Workflows/source.glb' }, output: { workspacePath: output },
    meshOutputSha256: 'fixture-mesh', rigmetaSha256: 'fixture-meta', draftSha256: 'opaque-v1', draftContentSha256: 'host-receipt',
    trust: { status: 'draft', reasons: ['manual review'], trusted: false }, provenance: { producer: 'unirig', createdAt: '2026-10-07' },
    assignments: { roles: { hips: { boneId: 'root', label: 'Pelvis' } }, chains: {} }, confidence: { overall: 0.9 },
    completeness: { requiredRolesMissing: [], score: 1 }, diagnostics: [],
  })
  async function mount(t: any, options: {
    metadata?: Record<string, unknown>; ports?: Record<string, unknown>; rig?: boolean; settings?: any; fetch?: () => any; initialUrl?: string; previewRig?: boolean
  } = {}) {
    const directory = await mkdtemp(path.join(tmpdir(), 'viewer-fallback-mount-'))
    const saved = new Map<string, PropertyDescriptor | undefined>()
    const requests: unknown[] = [], fetches: unknown[] = []
    const originalAdapter = axios.defaults.adapter
    axios.defaults.adapter = async (request: unknown) => { requests.push(request); throw new Error('Unexpected transport request') }
    t.mock.method(globalThis, 'fetch', (...args: unknown[]) => {
      fetches.push(args); return options.fetch ? options.fetch() : Promise.resolve(response(options.metadata))
    })
    let unmount = () => undefined as void
    t.after(async () => {
      try { unmount() } finally {
        for (const [name, descriptor] of saved) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor)
          else Reflect.deleteProperty(globalThis, name)
        }
        axios.defaults.adapter = originalAdapter
        await rm(directory, { recursive: true, force: true })
        assert.deepEqual(requests, [], 'No network request may leave the CPU harness')
      }
    })
    const events = new EventTarget(), storage = new Map<string, string>()
    const localStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) }
    for (const [name, value] of Object.entries({
      window: { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), setInterval, clearInterval, localStorage },
      document: { activeElement: null, hasFocus: () => true }, HTMLInputElement: class {}, localStorage,
    })) {
      saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
    }
    const outfile = path.join(directory, 'viewer.mjs')
    await build({
      stdin: { contents: `export { default as Viewer3D } from './src/areas/generate/components/Viewer3D'; export { useAppStore } from './src/shared/stores/appStore'; export { useWorkflowRunStore } from './src/areas/workflows/workflowRunStore'; export { harness } from '@react-three/fiber'`, resolveDir: projectRoot, loader: 'tsx' },
      outfile, bundle: true, format: 'esm', platform: 'node', tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
      plugins: [{ name: 'mounted-cpu-adapters', setup(builder) {
        builder.onResolve({ filter: /^(@react-three\/(fiber|drei|postprocessing)|\.\/SplatViewer)$/ }, () => ({ path: 'adapters', namespace: 'fixture' }))
        builder.onLoad({ filter: /^adapters$/, namespace: 'fixture' }, () => ({ loader: 'js', resolveDir: projectRoot, contents: `
          import { createElement, forwardRef, useImperativeHandle, useMemo } from 'react'
          import * as THREE from 'three'
          export const harness = { gltf: new Map(), camera: new THREE.PerspectiveCamera(45, 1, 0.01, 1000), invalidations: 0 }
          export const Canvas = props => createElement('test-canvas', null, props.children)
          export const useFrame = () => undefined
          export function useGLTF(url) { const asset = harness.gltf.get(url); if (!asset) throw new Error('Missing fixture ' + url); return asset }
          useGLTF.clear = () => undefined
          export const useLoader = () => { throw new Error('Unexpected non-GLTF load') }
          useLoader.clear = () => undefined
          export const useThree = () => ({ camera: harness.camera, size: { width: 100, height: 100 }, invalidate: () => { harness.invalidations++ }, gl: { domElement: { toDataURL: () => '', getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } } })
          export const useGizmoContext = () => ({})
          export const Environment = () => null, GizmoHelper = () => null, Lightformer = () => null
          const host = props => createElement('test-adapter', props, props.children)
          export const Html = host, EffectComposer = host, Outline = host, Selection = host, Select = host
          export const OrbitControls = forwardRef(function OrbitControls(props, ref) {
            const controls = useMemo(() => ({ target: new THREE.Vector3(), minDistance: 0, maxDistance: Infinity, update: () => undefined }), [])
            useImperativeHandle(ref, () => controls, [controls])
            return host(props)
          })
          export default forwardRef(function SplatViewer(props, ref) { return createElement('test-splat', props) })
        ` }))
        builder.onResolve({ filter: /^@shared\/hooks\/useGeneration$/ }, () => ({ path: 'generation', namespace: 'fixture' }))
        builder.onLoad({ filter: /^generation$/, namespace: 'fixture' }, () => ({
          contents: `import { useAppStore } from ${JSON.stringify(path.join(projectRoot, 'src/shared/stores/appStore.ts'))}; export const useGeneration = () => ({ currentJob: useAppStore(s => s.currentJob) })`, loader: 'js', resolveDir: projectRoot,
        }))
        // Use the installed import entry, not its self-requiring UMD; share
        // the actual Three constructors with fixtures and the real BVH code.
        builder.onResolve({ filter: /^three-mesh-bvh$/ }, () => ({ path: path.join(projectRoot, 'node_modules/three-mesh-bvh/src/index.js') }))
        builder.onResolve({ filter: /^(react(?:\/.*)?|three(?:\/.*)?|axios|zustand(?:\/.*)?)$/ }, args => ({ path: require.resolve(args.path), external: true }))
      } }],
    })
    const { Viewer3D, useAppStore, useWorkflowRunStore, harness } = await import(pathToFileURL(outfile).href)
    const preview = asset(harness, options.initialUrl ?? previewUrl, options.previewRig ?? false), source = asset(harness, sourceUrl, options.rig !== false)
    asset(harness, animatedUrl)
    Object.assign(window, { electron: { settings: options.settings, workspace: { artifacts: {
      readRigMetaSidecar: async () => ({ success: true, status: 'not-found', rigMetaWorkspacePath: 'absent.rigmeta.json' }),
      readHumanoidDraftSidecar: async (request: any) => ({ success: true, status: 'found', sidecarWorkspacePath: 'fixture.json', sidecar: draftFor(request.meshWorkspacePath) }),
      readHumanoidPromotionSidecar: async () => ({ success: true, status: 'not-found', sidecarWorkspacePath: 'absent.json' }),
      ...options.ports,
    } } } })
    const host: Host = { type: 'root', props: {}, children: [] }
    const root = renderer.createContainer(host, 0, null, false, null, '', (error: unknown) => { throw error }, null)
    const job = (url: string) => useAppStore.getState().setCurrentJob({ id: url, status: 'done', outputUrl: url, imageFile: '', progress: 100, createdAt: 0 })
    useAppStore.setState({ apiUrl: '' }); job(options.initialUrl ?? previewUrl)
    const render = () => flush(() => renderer.updateContainer(createElement(Viewer3D), root, null))
    unmount = () => flush(() => renderer.updateContainer(null, root, null))
    const component = (name: string): any => {
      const walk = (fiber: any): any => !fiber ? undefined : fiber.type?.name === name ? fiber.memoizedProps : walk(fiber.child) ?? walk(fiber.sibling)
      const props = walk(root.current); assert.ok(props, `Missing mounted component ${name}`); return props
    }
    // Preserve positive physical-owner checks while keeping loader assets inert.
    const sceneInstances = new WeakMap<THREE.Object3D, THREE.Object3D>()
    const instanceFor = (loadedAsset: ReturnType<typeof asset>): any => {
      const scene = component('SceneMeshModel').scene as THREE.Object3D
      assert.notEqual(scene, loadedAsset.scene, 'The mounted owner is an isolated instance, not the loader cache')
      assert.equal(scene.uuid, loadedAsset.scene.uuid, 'The instance must correspond to the exact expected loader source')
      const previous = sceneInstances.get(loadedAsset.scene)
      if (previous) assert.equal(scene, previous, 'Unchanged mounted source retains the exact instance across panel operations')
      else sceneInstances.set(loadedAsset.scene, scene)
      const root = scene.getObjectByProperty('uuid', loadedAsset.root.uuid)
      const child = scene.getObjectByProperty('uuid', loadedAsset.child.uuid)
      const mesh = scene.getObjectByProperty('uuid', loadedAsset.mesh.uuid) as THREE.SkinnedMesh | undefined
      if (mesh?.skeleton) {
        assert.notEqual(mesh.skeleton, loadedAsset.mesh.skeleton)
        assert.equal(mesh.geometry, loadedAsset.mesh.geometry)
        mesh.skeleton.bones.forEach((bone, index) => {
          assert.notEqual(bone, loadedAsset.mesh.skeleton.bones[index])
          assert.equal(bone.uuid, loadedAsset.mesh.skeleton.bones[index].uuid)
          assert.equal(scene.getObjectByProperty('uuid', bone.uuid), bone)
        })
      }
      return { scene, root, child, mesh }
    }
    const click = (title: string) => flush(() => {
      const button = find(host, node => node.type === 'button' && node.props.title === title)
      assert.ok(button, `Missing button ${title}`); button.props.onClick()
    })
    render(); await settle()
    return { host, harness, source, preview, component, instanceFor, click, render, useWorkflowRunStore, useAppStore, fetches,
      switchTo: (url: string) => flush(() => job(url)), panel: () => component('PoseClipPanel') }
  }

  // A typed output with an invalid suffix is still an output declaration,
  // never evidence that the same path is an independent authoring input.
  for (const field of ['canonical_motion_artifact', 'motion_npz_artifact', 'motion_bvh_artifact', 'artifacts', 'bundle_artifacts']) {
    await suite.test(`reject generated-source collision in ${field}`, async t => {
      const pending = deferred()
      const view = await mount(t, { fetch: () => pending.promise })
      const generated = asset(view.harness, '/workspace/Workflows/kimodo/run/generated.glb')
      pending.resolve(response(degraded({ source_workspace_path: 'Workflows/kimodo/run/generated.glb',
        [field]: field.endsWith('artifacts') ? [{ path: 'generated.glb', role: 'animated-output' }] : 'generated.glb' })))
      await settle()
      assert.equal(view.component('GltfMeshModel').url, previewUrl)
      assert.equal(view.component('SceneMeshModel').scene, view.instanceFor(view.preview).scene)
      assert.notEqual(view.component('SceneMeshModel').scene, generated.scene)
      assert.notEqual(view.component('SceneMeshModel').scene.uuid, generated.scene.uuid)
      assert.equal(view.component('ViewerEditToolbar').rigEditorControls, undefined)
    })
  }

  await suite.test('distinct co-located source keeps actual Bones, dirty aliases and non-promotion across close/reopen', async t => {
    const pending = deferred(), colocated = '/workspace/Workflows/kimodo/run/source.glb'
    const view = await mount(t, { fetch: () => pending.promise })
    const source = asset(view.harness, colocated)
    pending.resolve(response(degraded({ source_workspace_path: colocated.slice('/workspace/'.length),
      artifacts: [{ path: 'animated.glb', role: 'animated-output' }, { path: 'source.glb', role: 'source' }] })))
    await settle()
    assert.equal(view.component('GltfMeshModel').url, colocated)
    assert.equal(view.component('SceneMeshModel').scene, view.instanceFor(source).scene)
    view.click('Open Rig Editor (2 bones)'); await settle()
    const rig = () => view.component('RigEditorPanel')
    const id = rig().summary.bones.find((bone: any) => bone.originalName === 'root').boneId
    flush(() => rig().onSelectBone(id)); flush(() => rig().onAliasChange(id, 'Authored Alias'))
    const bones = [...view.instanceFor(source).mesh.skeleton.bones], names = bones.map(bone => bone.name)
    assert.ok(find(view.host, node => node.type === '#text' && /source-rig authoring fallback/.test(String(node.props.text))))
    view.click('Close Rig Editor (2 bones)'); await settle()
    view.click('Open Rig Editor (2 bones)'); await settle()
    assert.equal(view.component('SceneMeshModel').scene, view.instanceFor(source).scene)
    assert.equal(rig().aliasesDirty, true); assert.equal(rig().effectiveNaming.byBoneId[id].label, 'Authored Alias')
    assert.equal(rig().humanoidReview.presentation.canPromote, false)
    assert.deepEqual(view.instanceFor(source).mesh.skeleton.bones, bones); assert.deepEqual(bones.map(bone => bone.name), names)
    assert.equal(view.fetches.length, 1, 'source hasRig and panel visibility do not revoke the preview decision')
  })
  await suite.test('compact Pose Clip rail shares Rig Editor targets and acts on actual source Bones without retired surfaces', async t => {
    const view = await mount(t)
    assert.equal(find(view.host, node => /Motion Retarget/.test(String(node.props.title))), undefined)
    assert.equal(view.component('ViewerEditToolbar').motionRetargetControls, undefined)
    view.click('Open Rig Editor (2 bones)'); await settle()
    const rig = view.component('RigEditorPanel')
    const id = rig.summary.bones.find((bone: any) => bone.originalName === 'child').boneId
    flush(() => rig.onSelectBone(id))
    view.click('Open Pose/Clip (2 bones)'); await settle()
    assert.equal(view.panel().selectedBoneId, id)
    const instance = view.instanceFor(view.source)
    const original = instance.child.quaternion.clone()
    const loaderOriginal = view.source.child.quaternion.clone()
    view.click('Rotate selected target +X')
    assert.equal(instance.child.quaternion.equals(original), false)
    assert.equal(view.source.child.quaternion.equals(loaderOriginal), true, 'Pose edits must not mutate cached Bones')
    view.click('Capture pose keyframe')
    assert.equal(view.panel().keyframes.length, 1)
    assert.equal(view.panel().keyframes[0].boneId, id)
    view.click('Play Pose/Clip preview'); assert.equal(view.panel().previewState, 'playing')
    view.click('Pause Pose/Clip preview'); assert.equal(view.panel().previewState, 'paused')
    view.click('Reset selected target pose'); assert.equal(instance.child.quaternion.equals(original), true)
    view.click('Reset Pose/Clip preview'); assert.equal(view.panel().currentTimeSeconds, 0)
    assert.equal(view.panel().canSaveSidecar, false, 'No physical writer means no save capability')
    assert.equal(find(view.host, node => node.props.title === 'Expand Pose/Clip drawer'), undefined)
    assert.equal(view.component('SceneMeshModel').scene, view.instanceFor(view.source).scene)
  })
  // Explicit Motion Retarget artifact-preview/animated-selection dispatch was
  // removed in original57. Its helper tests above remain; no hidden UI is rebuilt.
  await suite.test('stale selected checkpoint owner retires source authoring despite a matching artifact URL', async t => {
    const second = deferred()
    let fetchCount = 0, parsedSecondResponse = false
    const view = await mount(t, { fetch: () => ++fetchCount === 1 ? Promise.resolve(response()) : second.promise })
    assert.equal(view.component('SceneMeshModel').scene, view.instanceFor(view.source).scene)
    assert.equal(view.component('GltfMeshModel').url, sourceUrl)
    assert.deepEqual(view.fetches, [['/workspace/Workflows/kimodo/run/metadata.json']])
    const artifact = { id: 'old-input', versionId: 'old-version', kind: 'mesh', uri: previewUrl,
      provenance: { extensionId: 'unrelated', extensionNodeId: 'not-kimodo' } }
    flush(() => view.useWorkflowRunStore.setState({ executionId: 'old-run', activeCheckpointNodeId: 'old-wait',
      checkpoints: { 'old-wait': { owner: { runId: 'old-run', nodeId: 'old-wait', inputArtifactId: artifact.id, inputVersionId: artifact.versionId, revision: 1 },
        substitutionPoint: { inputArtifact: artifact } } } }))
    await settle()
    assert.notEqual(view.useAppStore.getState().currentJob.id, 'old-run')
    assert.equal(view.useWorkflowRunStore.getState().getCheckpointOwner('old-wait'), undefined, 'Public store fields do not create private execution authority')
    assert.deepEqual(view.fetches, [
      ['/workspace/Workflows/kimodo/run/metadata.json'],
      ['/workspace/Workflows/kimodo/run/metadata.json'],
    ])
    assert.equal(view.component('GltfMeshModel').url, previewUrl)
    assert.equal(view.component('SceneMeshModel').scene, view.instanceFor(view.preview).scene, 'The retired checkpoint cannot retain source authoring authority')
    assert.equal(view.component('ViewerEditToolbar').rigEditorControls, undefined)
    second.resolve({ ok: true, json: async () => { parsedSecondResponse = true; return degraded() } })
    await settle()
    assert.equal(parsedSecondResponse, true, 'The second read completed rather than merely remaining pending')
    assert.equal(view.component('GltfMeshModel').url, previewUrl)
    assert.equal(view.component('SceneMeshModel').scene, view.instanceFor(view.preview).scene, 'Late metadata cannot recover retired source authority')
    assert.equal(view.component('ViewerEditToolbar').rigEditorControls, undefined)
    assert.equal(view.fetches.length, 2, 'The fenced completion must not cause a read loop')
  })
  await suite.test('same-URL preview Scene replacement retires old no-rig metadata capability', async t => {
    const first = deferred(), second = deferred(); let count = 0
    const view = await mount(t, { fetch: () => ++count === 1 ? first.promise : second.promise })
    const replacement = asset(view.harness, previewUrl)
    view.render(); await settle()
    first.resolve(response()); await settle(); second.resolve(response()); await settle()
    assert.ok(count >= 2)
    assert.equal(view.component('GltfMeshModel').url, previewUrl)
    assert.equal(view.component('SceneMeshModel').scene, view.instanceFor(replacement).scene)
  })
  await suite.test('delayed configured root cannot select source after execution replacement', async t => {
    const rootResult = deferred(), nextMetadata = deferred(); let roots = 0, fetches = 0
    const root = path.join(tmpdir(), 'configured-workspace')
    const metadata = degraded({ source_rigged_mesh: path.join(root, 'Workflows/rig.glb') }); delete metadata.source_workspace_path
    const view = await mount(t, { settings: { get: () => { roots++; return rootResult.promise } },
      fetch: () => ++fetches === 1 ? Promise.resolve(response(metadata)) : nextMetadata.promise })
    assert.equal(roots, 1)
    flush(() => view.useWorkflowRunStore.setState({ executionId: 'replacement-owner' })); await settle()
    rootResult.resolve({ workspaceDir: root }); await settle()
    assert.equal(view.component('GltfMeshModel').url, previewUrl)
    nextMetadata.resolve(response(degraded({ extension_id: 'unrelated' }))); await settle()
    assert.equal(view.component('GltfMeshModel').url, previewUrl)
  })
  await suite.test('current configured root allows the identified physical source', async t => {
    const root = path.join(tmpdir(), 'configured-workspace')
    const metadata = degraded({ source_rigged_mesh: path.join(root, 'Workflows/rig.glb') }); delete metadata.source_workspace_path
    const view = await mount(t, { metadata, settings: { get: async () => ({ workspaceDir: root }) } })
    // Root discovery triggers a second metadata pass before source loading.
    await settle()
    assert.equal(view.component('GltfMeshModel').url, sourceUrl)
    assert.equal(view.component('SceneMeshModel').scene, view.instanceFor(view.source).scene)
  })
  await suite.test('automatic no-rig serve-file fallback discovers the configured root without opening a panel', async t => {
    const root = path.join(tmpdir(), 'configured-workspace'), reads: string[] = []
    const initialUrl = `/optimize/serve-file?path=${encodeURIComponent(path.join(root, 'Workflows/kimodo/run/preview.glb'))}`
    const view = await mount(t, { initialUrl, settings: { get: async () => { reads.push(root); return { workspaceDir: root } } } })
    await settle()
    assert.equal(reads.length, 1)
    assert.equal(view.component('GltfMeshModel').url, sourceUrl)
    assert.equal(view.component('SceneMeshModel').scene, view.instanceFor(view.source).scene)
    assert.equal(find(view.host, node => node.props['aria-label'] === 'Pose/Clip action rail'), undefined)
    assert.equal(view.component('ViewerEditToolbar').motionRetargetControls, undefined)
  })
  await suite.test('Rig Editor independently discovers a serve-file rig root and enables physical alias custody', async t => {
    const root = path.join(tmpdir(), 'configured-workspace'), reads: string[] = [], writes: any[] = []
    const initialUrl = `/optimize/serve-file?path=${encodeURIComponent(path.join(root, 'Workflows/rig.glb'))}`
    const view = await mount(t, { initialUrl, previewRig: true, metadata: { extension_id: 'unrelated' },
      settings: { get: async () => { reads.push(root); return { workspaceDir: root } } },
      ports: { writeRigRenameSidecar: async (request: any) => { writes.push(request); return { success: true, sidecarWorkspacePath: request.sidecarWorkspacePath } } } })
    assert.equal(reads.length, 0)
    view.click('Open Rig Editor (2 bones)'); await settle()
    assert.equal(reads.length, 1)
    // Resolving physical custody replaces the formerly pathless binding and
    // retires its panel; reopen only the newly source-backed editor.
    view.click('Open Rig Editor (2 bones)'); await settle()
    assert.equal(reads.length, 1)
    const rig = () => view.component('RigEditorPanel'), id = rig().summary.bones.find((bone: any) => bone.originalName === 'root').boneId
    assert.equal(rig().summary.sourceWorkspacePath, 'Workflows/rig.glb')
    flush(() => rig().onAliasChange(id, 'Configured Root')); await rig().onSaveAliases(); await settle()
    assert.equal(writes.length, 1); assert.equal(writes[0].sourceWorkspacePath, 'Workflows/rig.glb')
    assert.equal(view.component('GltfMeshModel').url, initialUrl)
  })
  await suite.test('retired job metadata cannot select a source', async t => {
    const retired = deferred()
    const view = await mount(t, { fetch: () => retired.promise })
    assert.equal(view.component('GltfMeshModel').url, previewUrl)
    assert.equal(view.fetches.length, 1)
    asset(view.harness, '/other.glb', false); view.switchTo('/other.glb'); await settle()
    retired.resolve(response()); await settle()
    assert.equal(view.component('GltfMeshModel').url, '/other.glb')
  })
  for (const replacementKind of ['scene', 'execution', 'port'] as const) {
    await suite.test(`Pose Clip read and retained callbacks retire on ${replacementKind} replacement`, async t => {
      const result = deferred(), reads: any[] = []
      const view = await mount(t, { ports: { readPoseClipSidecar: (request: any) => { reads.push(request); return reads.length === 1 ? Promise.resolve({ success: true, status: 'not-found', sidecarWorkspacePath: 'absent.json' }) : result.promise } } })
      view.click('Open Rig Editor (2 bones)'); await settle()
      const rig = view.component('RigEditorPanel'), id = rig.summary.bones.find((bone: any) => bone.originalName === 'root').boneId
      flush(() => rig.onSelectBone(id)); view.click('Open Pose/Clip (2 bones)'); await settle()
      const old = view.panel(), count = reads.length, retiredRoot = view.instanceFor(view.source).root
      const retiredQuaternion = retiredRoot.quaternion.clone()
      const pending = old.onLoadSidecar(); await settle()
      assert.equal(reads.length, count + 1)
      if (replacementKind === 'scene') { asset(view.harness, sourceUrl); view.render(); await settle() }
      else if (replacementKind === 'execution') { flush(() => view.useWorkflowRunStore.setState({ executionId: 'new-execution' })); await settle() }
      else { window.electron!.workspace.artifacts.readPoseClipSidecar = async () => ({ success: false, status: 'error', error: 'New reader' }); view.render(); await settle() }
      const callsAfterReplacement = reads.length
      result.resolve({ success: false, error: 'Retired pose operation' }); await pending; await settle()
      assert.equal(find(view.host, node => node.type === '#text' && String(node.props.text).includes('Retired pose operation')), undefined)
      await old.onLoadSidecar(); flush(() => old.onRotateSelectedTarget(id, 'x', 30)); await settle()
      assert.equal(reads.length, callsAfterReplacement)
      assert.equal(view.harness.gltf.get(sourceUrl).scene.children[0].quaternion.x, 0)
      assert.equal(retiredRoot.quaternion.equals(retiredQuaternion), true, 'Retained callbacks cannot mutate the retired live Bone owner')
      if (replacementKind === 'port') {
        const state = view.panel()
        flush(() => { old.onCurrentTimeChange(1); old.onPreviewPause(); old.onPreviewReset(); old.onResetSelectedTarget(id) })
        assert.equal(view.panel().currentTimeSeconds, state.currentTimeSeconds)
        assert.equal(view.panel().previewState, state.previewState)
      }
    })
  }
  await suite.test('Pose Clip writer replacement retires pending completion and allows a current retry', async t => {
    const pending = deferred(), oldWrites: any[] = [], newWrites: any[] = []
    const view = await mount(t, { ports: { writePoseClipSidecar: (request: any) => { oldWrites.push(request); return pending.promise } } })
    view.click('Open Rig Editor (2 bones)'); await settle()
    const rig = view.component('RigEditorPanel'), id = rig.summary.bones.find((bone: any) => bone.originalName === 'root').boneId
    flush(() => rig.onSelectBone(id)); view.click('Open Pose/Clip (2 bones)'); view.click('Capture pose keyframe')
    const old = view.panel(), save = old.onSaveSidecar(); await settle()
    assert.equal(oldWrites.length, 1); assert.equal(view.panel().saveState, 'saving')
    window.electron!.workspace.artifacts.writePoseClipSidecar = async request => { newWrites.push(request); return { success: true, sidecarWorkspacePath: request.sidecarWorkspacePath, sidecar: request.sidecar } }
    view.render(); await settle()
    assert.equal(view.panel().saveState, 'idle'); assert.equal(view.panel().canSaveSidecar, true)
    await old.onSaveSidecar(); assert.equal(newWrites.length, 0)
    await view.panel().onSaveSidecar(); await settle()
    assert.equal(newWrites.length, 1); assert.equal(view.panel().saveState, 'saved')
    pending.resolve({ success: false, error: 'Retired writer failure' }); await save; await settle()
    assert.equal(view.panel().saveState, 'saved'); assert.equal(view.panel().saveError, undefined)
    assert.equal(view.panel().keyframes[0].boneId, id)
  })
  for (const persistedResult of ['not-found', 'found'] as const) {
    for (const release of ['reset', 'close'] as const) {
      for (const port of ['reader', 'writer'] as const) {
        await suite.test(`Pose Clip dirty authoring survives ${port} replacement after ${release} with ${persistedResult} sidecar`, async t => {
          let persisted: any, reads = 0, writes = 0
          const reader = async () => {
            reads++
            return persisted
              ? { success: true as const, status: 'found' as const, sidecarWorkspacePath: 'fixture.json', sidecar: persisted }
              : { success: true as const, status: 'not-found' as const, sidecarWorkspacePath: 'absent.json' }
          }
          const writer = async (request: any) => {
            writes++; persisted = request.sidecar
            return { success: true as const, sidecarWorkspacePath: request.sidecarWorkspacePath, sidecar: request.sidecar }
          }
          const view = await mount(t, { ports: { readPoseClipSidecar: reader, writePoseClipSidecar: writer } })
          view.click('Open Rig Editor (2 bones)'); await settle()
          const rig = view.component('RigEditorPanel'), id = rig.summary.bones[0].boneId
          flush(() => rig.onSelectBone(id)); view.click('Open Pose/Clip (2 bones)')
          assert.equal(view.panel().canSaveSidecar, false, 'Initial empty plan is clean')
          view.click('Rotate selected target +X'); view.click('Capture pose keyframe')
          if (persistedResult === 'found') {
            view.click('Save pose clip sidecar'); await settle()
            assert.equal(writes, 1); assert.equal(view.panel().saveState, 'saved')
            assert.equal(view.panel().canSaveSidecar, false)
            const scrub = find(view.host, node => node.type === 'input' && node.props.title === 'Current time scrubber')!
            flush(() => scrub.props.onChange({ currentTarget: { valueAsNumber: 1 } }))
            view.click('Rotate selected target +Y'); view.click('Capture pose keyframe')
          }
          const authored = structuredClone(view.panel().keyframes)
          assert.equal(authored.length, persistedResult === 'found' ? 2 : 1)
          assert.equal(view.panel().canSaveSidecar, true, 'Positive dirty capability before releasing preview ownership')
          view.click(release === 'reset' ? 'Reset Pose/Clip preview' : 'Close Pose/Clip (2 bones)'); await settle()
          const readsBefore = reads
          if (port === 'reader') window.electron!.workspace.artifacts.readPoseClipSidecar = () => reader()
          else window.electron!.workspace.artifacts.writePoseClipSidecar = request => writer(request)
          view.render(); await settle()
          if (release === 'close') view.click('Open Pose/Clip (2 bones)')
          assert.deepEqual(view.panel().keyframes, authored, 'Port replacement is not explicit Load')
          assert.equal(view.panel().canSaveSidecar, true, 'Missing sidecars must not certify dirty authoring as saved')
          assert.equal(reads, readsBefore + 1, 'A current automatic read completed without applying over dirty authoring')
          assert.equal(view.panel().saveState, 'idle'); assert.equal(view.panel().loadState, 'idle')
          assert.equal(view.panel().canLoadSidecar, true)
          view.click('Load pose clip sidecar'); await settle()
          assert.equal(reads, readsBefore + 2, 'Explicit Load remains available through the current reader')
          assert.equal(view.panel().keyframes.length, 1)
          assert.equal(view.panel().canSaveSidecar, persistedResult === 'not-found', 'Only a found explicit Load advances the baseline')
          if (persistedResult === 'not-found') {
            assert.deepEqual(view.panel().keyframes, authored)
            view.click('Save pose clip sidecar'); await settle()
            assert.equal(writes, 1); assert.equal(view.panel().saveState, 'saved')
            assert.equal(view.panel().canSaveSidecar, false)
          }
        })
      }
    }
  }
  await suite.test('Pose Clip automatically hydrates a clean newly loaded Scene from the saved sidecar', async t => {
    let persisted: any, reads = 0
    const view = await mount(t, { ports: {
      readPoseClipSidecar: async () => { reads++; return persisted
        ? { success: true, status: 'found', sidecarWorkspacePath: 'fixture.json', sidecar: persisted }
        : { success: true, status: 'not-found', sidecarWorkspacePath: 'absent.json' } },
      writePoseClipSidecar: async (request: any) => { persisted = request.sidecar; return { success: true, sidecarWorkspacePath: request.sidecarWorkspacePath, sidecar: request.sidecar } },
    } })
    view.click('Open Rig Editor (2 bones)'); await settle()
    const rig = view.component('RigEditorPanel'), id = rig.summary.bones[0].boneId
    flush(() => rig.onSelectBone(id)); view.click('Open Pose/Clip (2 bones)')
    view.click('Rotate selected target +X'); view.click('Capture pose keyframe')
    view.click('Save pose clip sidecar'); await settle()
    assert.equal(view.panel().saveState, 'saved')
    const saved = structuredClone(view.panel().keyframes), readsBefore = reads
    const replacement = asset(view.harness, sourceUrl)
    assert.notEqual(replacement.scene, view.source.scene)
    view.render(); await settle(); view.click('Open Pose/Clip (2 bones)')
    assert.ok(reads > readsBefore, 'A new clean Scene still auto-loads its persisted plan')
    assert.equal(view.panel().loadState, 'loaded')
    assert.deepEqual(view.panel().keyframes, saved)
    assert.equal(view.panel().canSaveSidecar, false)
    assert.equal(replacement.root.quaternion.x, 0, 'Hydration does not acquire live Bone ownership')
    assert.equal(view.instanceFor(replacement).root.quaternion.x, 0, 'Hydration leaves the current live Bone unchanged too')
  })
  for (const missing of [false, true]) {
    await suite.test(missing ? 'source load failure leaves authoring closed' : 'source without rig leaves authoring closed without oscillation', async t => {
      const pending = deferred()
      const view = await mount(t, { rig: false, fetch: () => pending.promise })
      if (missing) view.harness.gltf.delete(sourceUrl)
      pending.resolve(response()); await settle()
      assert.equal(find(view.host, node => node.type === 'button' && /Rig Editor|Motion Retarget/.test(String(node.props.title))), undefined)
      if (missing) assert.ok(find(view.host, node => node.type === '#text' && node.props.text === 'Model file not found'))
      else {
        assert.equal(view.component('GltfMeshModel').url, sourceUrl)
        assert.equal(view.component('ViewerEditToolbar').rigEditorControls, undefined)
        assert.equal(view.component('ViewerEditToolbar').motionRetargetControls, undefined)
      }
      assert.equal(view.fetches.length, 1)
    })
  }
  await suite.test('physical source alias Save/read preserves source/draft receipts and rejects stale Bone identities', async t => {
    const { createHash } = await import('node:crypto')
    const { mkdir, writeFile, readFile } = await import('node:fs/promises')
    const workspaceDir = await mkdtemp(path.join(tmpdir(), 'fallback-source-service-'))
    t.after(() => rm(workspaceDir, { recursive: true, force: true }))
    // The host service belongs to tsconfig.node, not the composite web project.
    // Execute its real Node bundle, leaving both projects' typecheck roots intact.
    const serviceBundle = path.join(workspaceDir, 'service.mjs')
    await build({ entryPoints: [path.join(projectRoot, 'electron/main/artifact-registry-service.ts')],
      outfile: serviceBundle, bundle: true, format: 'esm', platform: 'node', packages: 'external',
      tsconfig: path.join(projectRoot, 'tsconfig.node.json') })
    const service = await import(pathToFileURL(serviceBundle).href)
    const dir = path.join(workspaceDir, 'Workflows'); await mkdir(dir)
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    const input = 'physical original input', mesh = 'physical source rig'
    const meta = JSON.stringify({ schema: 'modly.unirig.rigmeta', output_mesh: 'rig.glb', source: { workspacePath: 'Workflows/source.glb' } })
    const draft: any = { ...draftFor(), meshOutputSha256: sha(mesh), rigmetaSha256: sha(meta) }; delete draft.draftContentSha256
    const files = { 'source.glb': input, 'rig.glb': mesh, 'rig.rigmeta.json': meta, 'rig.humanoid-draft.v1.json': JSON.stringify(draft) }
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text)
    const before = await service.readHumanoidDraftSidecar({ workspaceDir, meshWorkspacePath: 'Workflows/rig.glb' })
    assert.equal(before.success, true); assert.equal(before.status, 'found'); assert.equal(before.sourceSha256, sha(input))
    assert.ok(before.sidecar?.draftContentSha256)
    const writes: any[] = []
    const view = await mount(t, { ports: {
      readRigMetaSidecar: (request: any) => service.readRigMetaSidecar({ ...request, workspaceDir }),
      readHumanoidDraftSidecar: (request: any) => service.readHumanoidDraftSidecar({ ...request, workspaceDir }),
      readHumanoidPromotionSidecar: (request: any) => service.readHumanoidPromotionSidecar({ ...request, workspaceDir }),
      writeHumanoidPromotionSidecar: () => assert.fail('Diagnostic fallback must not promote'),
      readRigRenameSidecar: (request: any) => service.readRigRenameSidecar({ ...request, workspaceDir }),
      writeRigRenameSidecar: async (request: any) => { writes.push(request); return service.writeRigRenameSidecar({ ...request, workspaceDir }) },
    } })
    const rig = () => view.component('RigEditorPanel')
    async function until(predicate: () => boolean) {
      for (let i = 0; i < 100 && !predicate(); i++) { await new Promise(resolve => setTimeout(resolve, 5)); await settle() }
      assert.ok(predicate(), 'Bounded CPU service operation completed')
    }
    view.click('Open Rig Editor (2 bones)'); await settle(); await until(() => rig().humanoidReview.presentation.state === 'draft')
    const id = rig().summary.bones.find((bone: any) => bone.originalName === 'root').boneId
    flush(() => rig().onAliasChange(id, 'Saved Source Root')); await until(() => rig().loadState !== 'loading')
    flush(() => rig().onSaveAliases()); await until(() => rig().saveState === 'saved')
    assert.equal(writes.length, 1); assert.equal(writes[0].sourceWorkspacePath, 'Workflows/rig.glb')
    assert.equal(writes[0].sidecar.source.workspacePath, 'Workflows/rig.glb')
    const saved = await service.readRigRenameSidecar({ workspaceDir, sourceWorkspacePath: writes[0].sourceWorkspacePath, sidecarWorkspacePath: writes[0].sidecarWorkspacePath })
    assert.equal(saved.success, true); assert.equal(saved.status, 'found'); assert.equal(saved.sidecar?.aliases[id].alias, 'Saved Source Root')
    assert.deepEqual(await service.readHumanoidDraftSidecar({ workspaceDir, meshWorkspacePath: 'Workflows/rig.glb' }), before)
    for (const [name, text] of Object.entries(files)) assert.equal(await readFile(path.join(dir, name), 'utf8'), text)
    assert.equal(rig().humanoidReview.presentation.canPromote, false); assert.equal(view.source.root.name, 'root')
    assert.equal(view.instanceFor(view.source).root.name, 'root', 'Alias persistence preserves the current live Bone name too')
    const replacement = asset(view.harness, sourceUrl); replacement.root.name = 'replacementRoot'; view.render(); await settle()
    view.click('Open Rig Editor (2 bones)'); await until(() => rig().loadState !== 'loading')
    assert.equal(rig().aliasesDirty, false); assert.deepEqual(rig().renamePlan.aliases, {})
  })
})

test('Viewer3D source identity excludes every adapter-recognized animated list alias and typed motion declaration', async () => {
  const { module, cleanup } = await loadViewer3DModule()
  try {
    const apiUrl = 'http://127.0.0.1:8000', defaultModelUrl = `${apiUrl}/workspace/Workflows/kimodo/run/preview.glb`
    const descriptor = module.resolveViewer3DKimodoMetadataDescriptor({ apiUrl, modelUrl: defaultModelUrl })
    const metadata = { extension_id: 'kimodo-soma-rp', node_id: 'animate-rigged-mesh', runtime_status: 'failed',
      preview_artifact: 'preview.glb', source_workspace_path: 'Workflows/kimodo/run/generated.glb' }
    const args = { apiUrl, defaultModelUrl, descriptor, previewHasUsableRig: false }
    for (const list of ['artifacts', 'bundle_artifacts']) {
      for (const pathKey of ['path', 'workspace_path', 'workspacePath', 'file_path', 'filePath', 'artifact']) {
        for (const roleKey of ['role', 'kind', 'type', 'output']) {
          const value = { ...metadata, [list]: [{ [pathKey]: 'generated.glb', [roleKey]: 'Animated-Output' }] }
          assert.equal(module.resolveViewer3DKimodoSourceRigFallback({ ...args, metadata: value }).active, false, `${list}/${pathKey}/${roleKey}`)
        }
      }
      assert.equal(module.resolveViewer3DKimodoSourceRigFallback({ ...args, metadata: {
        ...metadata, source_workspace_path: 'Workflows/kimodo/run/animated.glb', [list]: ['animated.glb'],
      } }).active, false)
    }
    for (const field of ['canonical_motion_artifact', 'motion_npz_artifact', 'motion_bvh_artifact']) {
      assert.equal(module.resolveViewer3DKimodoSourceRigFallback({ ...args, metadata: { ...metadata, [field]: 'generated.glb' } }).active, false, field)
      // Reject an output/source identity even if its declaration is outside the bundle.
      assert.equal(module.resolveViewer3DKimodoSourceRigFallback({ ...args, metadata: {
        ...metadata, source_workspace_path: 'Workflows/rig.glb', [field]: 'Workflows/rig.glb',
      } }).active, false, field)
    }
    assert.equal(module.resolveViewer3DKimodoSourceRigFallback({ ...args, metadata: {
      ...metadata, diagnostics: { bvh_path: 'generated.glb' },
    } }).active, false)
    assert.equal(module.resolveViewer3DKimodoSourceRigFallback({ ...args, metadata: {
      ...metadata, artifacts: [{ path: 'generated.glb', role: 'source' }, { path: 'animated.glb', role: 'animated-output' }],
    } }).active, true, 'distinct source and output can share a bundle directory')
  } finally { await cleanup() }
})

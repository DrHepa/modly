import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import type { EffectiveWorldGraphicsProfile } from '../graphics/worldGraphicsProfilePolicy.ts'

const entry = path.join(import.meta.dirname, 'WorldViewportGraphics.tsx')

async function loadModule() {
  const tempDir = await mkdtemp(path.join('/tmp', 'world-viewport-graphics-test-'))
  const result = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', tsconfig: path.join(import.meta.dirname, '../../../..', 'tsconfig.web.json') })
  const outfile = path.join(tempDir, 'WorldViewportGraphics.bundle.mjs')
  await writeFile(outfile, result.outputFiles[0].text)
  return { module: await import(pathToFileURL(outfile).href), cleanup: () => rm(tempDir, { recursive: true, force: true }) }
}

async function loadExternalThreeModule() {
  const tempDir = await mkdtemp(path.join('/tmp', 'world-viewport-graphics-external-three-test-'))
  await import('node:fs/promises').then(async (fs) => {
    await fs.symlink(path.join(import.meta.dirname, '../../../..', 'node_modules'), path.join(tempDir, 'node_modules'), 'dir')
    await writeFile(path.join(tempDir, 'package.json'), '{"type":"module"}')
  })
  const result = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', packages: 'external', tsconfig: path.join(import.meta.dirname, '../../../..', 'tsconfig.web.json') })
  const outfile = path.join(tempDir, 'WorldViewportGraphics.bundle.mjs')
  await writeFile(outfile, result.outputFiles[0].text)
  return { module: await import(pathToFileURL(outfile).href), cleanup: () => rm(tempDir, { recursive: true, force: true }) }
}

test('owned fullscreen quads replace pass quads without disposing shared originals', async () => {
  const { module, cleanup } = await loadModule()
  const { WorldOwnedFullScreenQuad, replacePassFullScreenQuad } = module
  try {
  let originalDisposed = 0
  const pass = { fsQuad: { material: new THREE.MeshBasicMaterial(), dispose: () => { originalDisposed += 1 } } }
  const replacement = replacePassFullScreenQuad(pass)
  assert.ok(pass.fsQuad instanceof WorldOwnedFullScreenQuad)
  replacement.dispose()
  assert.equal(originalDisposed, 0)
  } finally { await cleanup() }
})

test('owned fullscreen quad replacement detaches shared originals before allocation failure', async () => {
  const { module, cleanup } = await loadExternalThreeModule()
  const { replacePassFullScreenQuad } = module
  const originalSetAttribute = THREE.BufferGeometry.prototype.setAttribute
  try {
    let originalDisposed = 0
    const pass = { fsQuad: { material: new THREE.MeshBasicMaterial(), dispose: () => { originalDisposed += 1 } }, dispose() { this.fsQuad?.dispose?.() } }
    const failingSetAttribute: typeof originalSetAttribute = function setAttributeWithInjectedFailure(this: THREE.BufferGeometry, name, attribute) {
      if (name === 'position') throw new Error('injected quad allocation failure')
      return originalSetAttribute.call(this, name, attribute)
    }
    THREE.BufferGeometry.prototype.setAttribute = failingSetAttribute
    assert.throws(() => replacePassFullScreenQuad(pass), /injected quad allocation failure/)
    assert.ok(pass.fsQuad)
    pass.dispose()
    assert.equal(originalDisposed, 0)
  } finally {
    THREE.BufferGeometry.prototype.setAttribute = originalSetAttribute
    await cleanup()
  }
})

async function getSharedFullScreenGeometry() {
  const { ShaderPass } = await import('three/examples/jsm/postprocessing/ShaderPass.js')
  const { FXAAShader } = await import('three/examples/jsm/shaders/FXAAShader.js')
  const sharedQuad = new ShaderPass(FXAAShader).fsQuad as unknown as { _mesh: { geometry: THREE.BufferGeometry } }
  return sharedQuad._mesh.geometry
}

async function assertProductionResourceConstructionFailureCleansSafely(failAtOwnedQuad: number, expectedOwnedDisposals: number) {
  const { module, cleanup } = await loadExternalThreeModule()
  const sharedGeometry = await getSharedFullScreenGeometry()
  const originalSetAttribute = THREE.BufferGeometry.prototype.setAttribute
  const originalDispose = THREE.BufferGeometry.prototype.dispose
  const injectedError = new Error(`injected owned quad allocation failure ${failAtOwnedQuad}`)
  let ownedQuadAllocations = 0
  let ownedGeometryDisposals = 0
  let sharedGeometryDisposals = 0
  sharedGeometry.addEventListener('dispose', () => { sharedGeometryDisposals += 1 })
  try {
    THREE.BufferGeometry.prototype.setAttribute = function injectedOwnedQuadFailure(this: THREE.BufferGeometry, name, attribute) {
      if (name === 'position') {
        ownedQuadAllocations += 1
        if (ownedQuadAllocations === failAtOwnedQuad) throw injectedError
      }
      return originalSetAttribute.call(this, name, attribute)
    }
    THREE.BufferGeometry.prototype.dispose = function countOwnedFullScreenQuadDispose(this: THREE.BufferGeometry) {
      if (this !== sharedGeometry && this.getAttribute('position')) ownedGeometryDisposals += 1
      return originalDispose.call(this)
    }

    assert.throws(
      () => module.createWorldViewportGraphicsResources(createFakeGraphicsRenderer(), new THREE.Scene(), new THREE.PerspectiveCamera(), {
        profileId: 'graphics:test',
        profileName: 'Test',
        requested: { id: 'graphics:test', name: 'Test', renderScale: 1, shadowQuality: 'off', antialiasing: 'fxaa' },
        dpr: 1,
        drawingBufferWidth: 100,
        drawingBufferHeight: 100,
        shadows: { enabled: false, mapSize: 0, clamped: false },
        limits: { maxTextureSize: 4096, maxRenderbufferSize: 4096, maxViewportWidth: 4096, maxViewportHeight: 4096 },
        aa: { mode: 'fxaa', fxaa: true, samples: 0, degraded: false },
        diagnostics: [],
      }, 'editor'),
      (error: unknown) => error === injectedError,
    )
    assert.equal(ownedGeometryDisposals, expectedOwnedDisposals)
    assert.equal(sharedGeometryDisposals, 0)
  } finally {
    THREE.BufferGeometry.prototype.setAttribute = originalSetAttribute
    THREE.BufferGeometry.prototype.dispose = originalDispose
    await cleanup()
  }
}

test('production resource construction preserves copyPass allocation failure and does not dispose shared fullscreen geometry', async () => {
  await assertProductionResourceConstructionFailureCleansSafely(1, 0)
})

test('production resource construction preserves later pass allocation failure and disposes already owned quads once', async () => {
  await assertProductionResourceConstructionFailureCleansSafely(3, 2)
})

test('output profiles preserve editor NoTone/SRGB and Play ACES/SRGB contracts', async () => {
  const { module, cleanup } = await loadModule()
  const { WORLD_VIEWPORT_OUTPUT_PROFILES, applyWorldViewportOutputProfile } = module
  try {
  const renderer = { outputColorSpace: null, toneMapping: null, toneMappingExposure: 0 } as unknown as THREE.WebGLRenderer
  applyWorldViewportOutputProfile(renderer, WORLD_VIEWPORT_OUTPUT_PROFILES.editor)
  assert.equal(renderer.outputColorSpace, THREE.SRGBColorSpace)
  assert.equal(renderer.toneMapping, THREE.NoToneMapping)
  assert.equal(renderer.toneMappingExposure, 1.8)
  applyWorldViewportOutputProfile(renderer, WORLD_VIEWPORT_OUTPUT_PROFILES.play)
  assert.equal(renderer.toneMapping, THREE.ACESFilmicToneMapping)
  assert.equal(renderer.toneMappingExposure, 1.0)
  } finally { await cleanup() }
})

test('sample probe uses exactly RGBA16F and DEPTH_COMPONENT24 renderbuffer formats', async () => {
  const { module, cleanup } = await loadModule()
  const { probeWorldGraphicsSampleSupport } = module
  try {
  const calls: Array<{ target: number; format: number; pname: number }> = []
  const gl = {
    RENDERBUFFER: 0x8d41,
    RGBA16F: 0x881a,
    DEPTH_COMPONENT24: 0x81a6,
    SAMPLES: 0x80a9,
    getInternalformatParameter(target: number, format: number, pname: number) {
      calls.push({ target, format, pname })
      return format === 0x881a ? new Int32Array([4, 2]) : new Int32Array([2])
    },
  } as unknown as WebGL2RenderingContext
  const support = probeWorldGraphicsSampleSupport(gl, true)
  assert.deepEqual(support, { colorInternalFormat: 'RGBA16F', depthInternalFormat: 'DEPTH_COMPONENT24', colorSamples: [2, 4], depthSamples: [2] })
  assert.deepEqual(calls, [
    { target: 0x8d41, format: 0x881a, pname: 0x80a9 },
    { target: 0x8d41, format: 0x81a6, pname: 0x80a9 },
  ])
  } finally { await cleanup() }
})

test('shadow policy disposes owned maps on high to low to off and preserves authored light flags', async () => {
  const { module, cleanup } = await loadModule()
  const { applyWorldViewportShadowProfile } = module
  try {
  const scene = new THREE.Scene()
  const light = new THREE.DirectionalLight()
  light.castShadow = true
  light.shadow.mapSize.set(2048, 2048)
  let disposed = 0
  light.shadow.map = { dispose: () => { disposed += 1 } } as THREE.WebGLRenderTarget
  scene.add(light)
  const renderer = { shadowMap: { enabled: false, type: null } } as unknown as THREE.WebGLRenderer
  const effect = (mapSize: number, enabled = true): EffectiveWorldGraphicsProfile => ({
    profileId: 'graphics:test', profileName: 'Test', requested: { id: 'graphics:test', name: 'Test', renderScale: 1, shadowQuality: enabled ? 'low' : 'off', antialiasing: 'off' },
    dpr: 1, drawingBufferWidth: 1, drawingBufferHeight: 1, shadows: { enabled, mapSize, clamped: false }, limits: { maxTextureSize: 4096, maxRenderbufferSize: 4096, maxViewportWidth: 4096, maxViewportHeight: 4096 }, aa: { mode: 'off', fxaa: false, samples: 0, degraded: false }, diagnostics: [],
  })
  applyWorldViewportShadowProfile(scene, renderer, effect(512))
  assert.equal(disposed, 1)
  assert.equal(light.castShadow, true)
  assert.deepEqual(light.shadow.mapSize.toArray(), [512, 512])
  light.shadow.map = { dispose: () => { disposed += 1 } } as THREE.WebGLRenderTarget
  applyWorldViewportShadowProfile(scene, renderer, effect(0, false))
  assert.equal(disposed, 2)
  assert.equal(light.shadow.map, null)
  } finally { await cleanup() }
})

test('source wires one positive-priority frame owner, Canvas antialias false, no profile key remount, and no wrapper EffectComposer owner', async () => {
  const source = await readFile(path.join(import.meta.dirname, 'WorldViewportGraphics.tsx'), 'utf8')
  assert.match(source, /useFrame\([^]*, 1\)/)
  assert.match(source, /onFailure\(\{ kind: 'render-error'/)
  const viewerSource = await readFile(path.join(import.meta.dirname, 'WorldsViewer.tsx'), 'utf8')
  const runtimeSource = await readFile(path.join(import.meta.dirname, 'WorldRuntimeViewport.tsx'), 'utf8')
  assert.doesNotMatch(viewerSource, /<EffectComposer/)
  assert.match(viewerSource, /<Selection enabled=/)
  assert.match(viewerSource, /antialias: false/)
  assert.match(runtimeSource, /antialias: false/)
  assert.doesNotMatch(viewerSource, /key=\{[^}]*graphics/i)
  assert.doesNotMatch(runtimeSource, /key=\{[^}]*graphics/i)
})

test('resource disposer is idempotent, disposes every added pass once, and lets composer own targets/copyPass', async () => {
  const { module, cleanup } = await loadModule()
  const { disposeWorldViewportGraphicsResources } = module
  try {
    const calls: string[] = []
    const resources = {
      disposed: false,
      composer: { dispose: () => calls.push('composer') },
      renderPass: { dispose: () => calls.push('render') },
      outlinePass: { dispose: () => calls.push('outline') },
      fxaaPass: { dispose: () => calls.push('fxaa') },
      outputPass: { dispose: () => calls.push('output') },
      signature: 'one',
      effect: null,
    }
    disposeWorldViewportGraphicsResources(resources)
    disposeWorldViewportGraphicsResources(resources)
    assert.deepEqual(calls, ['outline', 'fxaa', 'output', 'composer'])
  } finally { await cleanup() }
})

test('per-light shadow sizing keeps directional high while point lights use a 4x2 atlas clamp', async () => {
  const { module, cleanup } = await loadModule()
  const { resolveWorldViewportLightShadowMapSize } = module
  try {
    const directional = new THREE.DirectionalLight()
    const point = new THREE.PointLight()
    const effect: EffectiveWorldGraphicsProfile = {
      profileId: 'graphics:high', profileName: 'High', requested: { id: 'graphics:high', name: 'High', renderScale: 1, shadowQuality: 'high', antialiasing: 'off' },
      dpr: 1, drawingBufferWidth: 1, drawingBufferHeight: 1,
      shadows: { enabled: true, mapSize: 1024, clamped: true },
      limits: { maxTextureSize: 1024, maxRenderbufferSize: 1024, maxViewportWidth: 1024, maxViewportHeight: 1024 },
      aa: { mode: 'off', fxaa: false, samples: 0, degraded: false }, diagnostics: [],
    }
    assert.equal(resolveWorldViewportLightShadowMapSize(directional, effect), 1024)
    assert.equal(resolveWorldViewportLightShadowMapSize(point, effect), 256)
  } finally { await cleanup() }
})

test('controller source has stable lifetime dependencies, renderer-state restoration, and no RenderPass fake quad', async () => {
  const source = await readFile(path.join(import.meta.dirname, 'WorldViewportGraphics.tsx'), 'utf8')
  assert.match(source, /new WorldViewportGraphicsController/)
  assert.match(source, /useLayoutEffect\([^]*\}, \[gl, kind, setDpr\]\)/)
  assert.doesNotMatch(source, /renderPass as unknown as DisposablePass/)
  assert.match(source, /resources\?\.outlinePass\?\.dispose\(\)/)
  assert.match(source, /resources\?\.fxaaPass\?\.dispose\(\)/)
  assert.match(source, /resources\?\.outputPass\.dispose\(\)/)
  assert.match(source, /resources\?\.composer\.dispose\(\)/)
  assert.doesNotMatch(source, /resources\?\.target\.dispose\(\)/)
  assert.match(source, /restoreRendererState\(this\.renderer, this\.original, this\.setDpr\)/)
  assert.match(source, /visibleEdgeColor\.set\(0x8b5cf6\)/)
  assert.match(source, /hiddenEdgeColor\.set\(0x5b21b6\)/)
})

function createFakeGraphicsRenderer() {
  const gl = {
    MAX_TEXTURE_SIZE: 0x0d33,
    MAX_RENDERBUFFER_SIZE: 0x84e8,
    MAX_CUBE_MAP_TEXTURE_SIZE: 0x851c,
    MAX_VIEWPORT_DIMS: 0x0d3a,
    RENDERBUFFER: 0x8d41,
    RGBA16F: 0x881a,
    DEPTH_COMPONENT24: 0x81a6,
    SAMPLES: 0x80a9,
    getParameter(parameter: number) {
      if (parameter === this.MAX_VIEWPORT_DIMS) return [4096, 4096]
      return 4096
    },
    getExtension(_name: string) { return {} },
    getInternalformatParameter(_target: number, format: number, _pname: number) { return format === this.RGBA16F ? [4, 2] : [2] },
  }
  const size = new THREE.Vector2(100, 100)
  return {
    getContext() { return gl },
    capabilities: { isWebGL2: true, maxSamples: 4 },
    outputColorSpace: THREE.LinearSRGBColorSpace,
    toneMapping: THREE.LinearToneMapping,
    toneMappingExposure: 0.5,
    shadowMap: { enabled: true, type: THREE.BasicShadowMap },
    getPixelRatio() { return 1 },
    setSize(width: number, height: number) { size.set(width, height) },
    getSize(target: THREE.Vector2) { return target.copy(size) },
    getRenderTarget() { return null },
    setRenderTarget(_target: THREE.WebGLRenderTarget | null) {},
    render(_scene: THREE.Object3D, _camera: THREE.Camera) {},
  } as unknown as THREE.WebGLRenderer
}

function createGraphicsProject(overrides: Partial<{ revision: number; shadowQuality: 'off' | 'low' | 'high'; renderScale: number; antialiasing: 'off' | 'fxaa' | 'msaa' }> = {}) {
  const profile = {
    id: 'graphics:integrated',
    name: 'Integrated',
    renderScale: overrides.renderScale ?? 0.75,
    shadowQuality: overrides.shadowQuality ?? 'off',
    antialiasing: overrides.antialiasing ?? 'fxaa',
  }
  return {
    schema: 'modly.world-project.v1',
    id: 'project:test',
    name: 'Project Test',
    revision: overrides.revision ?? 1,
    activeGraphicsProfileId: profile.id,
    graphicsProfiles: [profile],
    entities: [],
    components: {},
    systems: [],
    metadata: {},
  }
}

test('fake GPU: controller keeps resources stable across unrelated project, camera, and shadow-only updates', async () => {
  const { module, cleanup } = await loadModule()
  const { WorldViewportGraphicsController } = module
  try {
    const renderer = createFakeGraphicsRenderer()
    const dprs: number[] = []
    const controller = new WorldViewportGraphicsController(renderer, new THREE.Scene(), new THREE.PerspectiveCamera(), 'editor', (dpr: number) => dprs.push(dpr))
    const size = { width: 200, height: 120 }
    controller.update({ project: createGraphicsProject(), size, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera() })
    const first = controller.getResourceIdentity()
    assert.ok(first)
    controller.update({ project: createGraphicsProject({ revision: 2 }), size, scene: new THREE.Scene(), camera: new THREE.OrthographicCamera() })
    assert.equal(controller.getResourceIdentity(), first)
    controller.update({ project: createGraphicsProject({ revision: 3, shadowQuality: 'high' }), size, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera() })
    assert.equal(controller.getResourceIdentity(), first)
    controller.update({ project: createGraphicsProject({ revision: 4, renderScale: 1 }), size, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera() })
    assert.equal(controller.getResourceIdentity(), first)
    assert.deepEqual(dprs.slice(0, 3), [0.75, 0.75, 0.75])
    controller.dispose()
  } finally { await cleanup() }
})

test('fake GPU: controller routes render failures, clears stale resources, and restores renderer state', async () => {
  const { module, cleanup } = await loadModule()
  const { WorldViewportGraphicsController } = module
  try {
    const renderer = createFakeGraphicsRenderer()
    const original = { outputColorSpace: renderer.outputColorSpace, toneMapping: renderer.toneMapping, toneMappingExposure: renderer.toneMappingExposure, shadowEnabled: renderer.shadowMap.enabled }
    const failures: Array<{ kind: string; message: string }> = []
    const controller = new WorldViewportGraphicsController(renderer, new THREE.Scene(), new THREE.PerspectiveCamera(), 'play', () => undefined, () => undefined, (failure: { kind: string; message: string }) => failures.push(failure))
    controller.update({ project: createGraphicsProject({ antialiasing: 'off' }), size: { width: 100, height: 100 }, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera() })
    const resources = controller.getResourceIdentity() as { composer: { render(delta?: number): void } } | null
    assert.ok(resources)
    resources.composer.render = () => { throw new Error('composer exploded') }
    controller.render(1 / 60, [])
    assert.deepEqual(failures, [{ kind: 'render-error', message: 'composer exploded' }])
    assert.equal(controller.getResourceIdentity(), null)
    assert.equal(renderer.outputColorSpace, original.outputColorSpace)
    assert.equal(renderer.toneMapping, original.toneMapping)
    assert.equal(renderer.toneMappingExposure, original.toneMappingExposure)
    assert.equal(renderer.shadowMap.enabled, original.shadowEnabled)
    controller.dispose()
  } finally { await cleanup() }
})

test('fake GPU: controller reports per-light point atlas clamp diagnostics and clears them when resolved', async () => {
  const { module, cleanup } = await loadModule()
  const { WorldViewportGraphicsController } = module
  try {
    const renderer = createFakeGraphicsRenderer()
    const scene = new THREE.Scene()
    scene.add(new THREE.PointLight())
    const diagnostics: string[] = []
    const controller = new WorldViewportGraphicsController(renderer, scene, new THREE.PerspectiveCamera(), 'editor', () => undefined, (message: string) => diagnostics.push(message))
    controller.update({ project: createGraphicsProject({ shadowQuality: 'high' }), size: { width: 100, height: 100 }, scene, camera: new THREE.PerspectiveCamera() })
    assert.match(diagnostics.at(-1) ?? '', /PointLight shadow atlas was clamped/)
    scene.clear()
    controller.update({ project: createGraphicsProject({ revision: 2, shadowQuality: 'high' }), size: { width: 100, height: 100 }, scene, camera: new THREE.PerspectiveCamera() })
    assert.equal(diagnostics.at(-1), '')
    controller.dispose()
  } finally { await cleanup() }
})

test('fake GPU: overlapping scene observers are per owner and preserve original Object3D methods', async () => {
  const { module, cleanup } = await loadModule()
  const { WorldViewportGraphicsController } = module
  try {
    const scene = new THREE.Scene()
    const nativeAdd = scene.add
    const nativeRemove = scene.remove
    const first = new WorldViewportGraphicsController(createFakeGraphicsRenderer(), scene, new THREE.PerspectiveCamera(), 'editor', () => undefined)
    const second = new WorldViewportGraphicsController(createFakeGraphicsRenderer(), scene, new THREE.PerspectiveCamera(), 'editor', () => undefined)
    const input = { project: createGraphicsProject({ shadowQuality: 'high' }), size: { width: 100, height: 100 }, scene, camera: new THREE.PerspectiveCamera() }
    first.update(input)
    second.update(input)
    assert.equal(scene.add, nativeAdd)
    assert.equal(scene.remove, nativeRemove)
    first.dispose()
    const late = new THREE.DirectionalLight()
    scene.add(late)
    second.render(1 / 60, [])
    assert.deepEqual(late.shadow.mapSize.toArray(), [2048, 2048])
    second.dispose()
    assert.equal(scene.add, nativeAdd)
    assert.equal(scene.remove, nativeRemove)

    const third = new WorldViewportGraphicsController(createFakeGraphicsRenderer(), scene, new THREE.PerspectiveCamera(), 'editor', () => undefined)
    const fourth = new WorldViewportGraphicsController(createFakeGraphicsRenderer(), scene, new THREE.PerspectiveCamera(), 'editor', () => undefined)
    third.update(input)
    fourth.update(input)
    fourth.dispose()
    const later = new THREE.DirectionalLight()
    scene.add(later)
    third.render(1 / 60, [])
    assert.deepEqual(later.shadow.mapSize.toArray(), [2048, 2048])
    third.dispose()
  } finally { await cleanup() }
})

test('fake GPU: scene observers track nested additions removals and reparents without retaining detached subtrees', async () => {
  const { module, cleanup } = await loadModule()
  const { WorldViewportGraphicsController } = module
  try {
    const scene = new THREE.Scene()
    const firstParent = new THREE.Group()
    const secondParent = new THREE.Group()
    scene.add(firstParent, secondParent)
    const controller = new WorldViewportGraphicsController(createFakeGraphicsRenderer(), scene, new THREE.PerspectiveCamera(), 'editor', () => undefined)
    controller.update({ project: createGraphicsProject({ shadowQuality: 'high' }), size: { width: 100, height: 100 }, scene, camera: new THREE.PerspectiveCamera() })

    const subtree = new THREE.Group()
    const nested = new THREE.Group()
    const light = new THREE.DirectionalLight()
    subtree.add(nested)
    nested.add(light)
    firstParent.add(subtree)
    assert.deepEqual(light.shadow.mapSize.toArray(), [2048, 2048])

    let disposed = 0
    light.shadow.map = { dispose: () => { disposed += 1 } } as THREE.WebGLRenderTarget
    firstParent.remove(subtree)
    assert.equal(disposed, 1)
    const detachedLight = new THREE.DirectionalLight()
    subtree.add(detachedLight)
    assert.deepEqual(detachedLight.shadow.mapSize.toArray(), [512, 512])

    secondParent.add(subtree)
    assert.deepEqual(detachedLight.shadow.mapSize.toArray(), [2048, 2048])
    firstParent.add(detachedLight)
    assert.deepEqual(detachedLight.shadow.mapSize.toArray(), [2048, 2048])
    controller.dispose()
  } finally { await cleanup() }
})

test('fake GPU: AA sample changes invalidate unique same-size composer targets while preserving resource identity', async () => {
  const { module, cleanup } = await loadModule()
  const { WorldViewportGraphicsController } = module
  try {
    const controller = new WorldViewportGraphicsController(createFakeGraphicsRenderer(), new THREE.Scene(), new THREE.PerspectiveCamera(), 'play', () => undefined)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera()
    const size = { width: 100, height: 100 }
    controller.update({ project: createGraphicsProject({ antialiasing: 'fxaa' }), size, scene, camera })
    const resources = controller.getResourceIdentity() as { composer: { renderTarget1: THREE.WebGLRenderTarget & { samples?: number }; renderTarget2: THREE.WebGLRenderTarget & { samples?: number }; readBuffer: THREE.WebGLRenderTarget & { samples?: number }; writeBuffer: THREE.WebGLRenderTarget & { samples?: number } }; fxaaPass: { enabled: boolean; material: { uniforms: { resolution?: { value: THREE.Vector2 } } } } }
    const uniqueTargets = new Set([resources.composer.renderTarget1, resources.composer.renderTarget2, resources.composer.readBuffer, resources.composer.writeBuffer])
    assert.equal(uniqueTargets.size, 2)
    let invalidations = 0
    for (const target of uniqueTargets) target.addEventListener('dispose', () => { invalidations += 1 })
    assert.equal(resources.composer.renderTarget1.samples, 0)
    assert.equal(resources.fxaaPass.enabled, true)

    controller.update({ project: createGraphicsProject({ antialiasing: 'msaa' }), size, scene, camera })
    assert.equal(controller.getResourceIdentity(), resources)
    assert.equal(resources.composer.renderTarget1.samples, 2)
    assert.equal(resources.composer.renderTarget2.samples, 2)
    assert.equal(invalidations, 2)
    assert.equal(resources.fxaaPass.enabled, false)

    controller.update({ project: createGraphicsProject({ revision: 2, antialiasing: 'msaa' }), size, scene, camera })
    assert.equal(invalidations, 2)
    controller.update({ project: createGraphicsProject({ antialiasing: 'off' }), size, scene, camera })
    assert.equal(resources.composer.renderTarget1.samples, 0)
    assert.equal(invalidations, 4)
    assert.deepEqual(resources.fxaaPass.material.uniforms.resolution?.value.toArray(), [1 / 75, 1 / 75])
    controller.dispose()
  } finally { await cleanup() }
})

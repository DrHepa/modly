import { useFrame, useThree } from '@react-three/fiber'
import { useContext, useLayoutEffect, useRef } from 'react'
import * as THREE from 'three'
import { selectionContext } from '@react-three/postprocessing'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js'

import type { WorldProjectDocumentV1 } from '../core/worldModel.ts'
import {
  resolveWorldGraphicsProfile,
  type EffectiveWorldGraphicsProfile,
  type WorldGraphicsCapabilities,
  type WorldGraphicsSampleSupport,
  type WorldGraphicsViewportKind,
} from '../graphics/worldGraphicsProfilePolicy.ts'
import type { WorldViewportFailure } from './WorldViewportBoundary.tsx'

export interface WorldViewportGraphicsProps {
  kind: WorldGraphicsViewportKind
  project: WorldProjectDocumentV1
  selectedObjects?: readonly THREE.Object3D[]
  onDiagnostic?(message: string): void
  onGraphicsFailure?(failure: WorldViewportFailure): void
}

export type WorldViewportOutputProfile = {
  outputColorSpace: typeof THREE.SRGBColorSpace
  toneMapping: THREE.ToneMapping
  toneMappingExposure: number
  targetType: typeof THREE.HalfFloatType
}

export const WORLD_VIEWPORT_OUTPUT_PROFILES: Record<WorldGraphicsViewportKind, WorldViewportOutputProfile> = Object.freeze({
  editor: { outputColorSpace: THREE.SRGBColorSpace, toneMapping: THREE.NoToneMapping, toneMappingExposure: 1.8, targetType: THREE.HalfFloatType },
  play: { outputColorSpace: THREE.SRGBColorSpace, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.0, targetType: THREE.HalfFloatType },
})

type RendererStateSnapshot = {
  outputColorSpace: THREE.WebGLRenderer['outputColorSpace']
  toneMapping: THREE.ToneMapping
  toneMappingExposure: number
  shadowEnabled: boolean
  shadowType: THREE.ShadowMapType
  dpr: number
}

type DisposablePass = { dispose(): void; fsQuad?: unknown }
type ComposerWithCopyPass = EffectComposer & { copyPass?: DisposablePass }

type ViewportGraphicsResources = {
  disposed: boolean
  composer: EffectComposer
  renderPass: RenderPass
  outlinePass: OutlinePass | null
  fxaaPass: ShaderPass
  outputPass: OutputPass
  signature: string
  effect: EffectiveWorldGraphicsProfile
}

type ViewportGraphicsUpdate = {
  project: WorldProjectDocumentV1
  size: { width: number; height: number }
  scene: THREE.Scene
  camera: THREE.Camera
}

export class WorldOwnedFullScreenQuad {
  readonly camera: THREE.OrthographicCamera
  readonly geometry: THREE.BufferGeometry
  readonly mesh: THREE.Mesh
  private disposed = false

  constructor(material?: THREE.Material) {
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    const geometry = new THREE.BufferGeometry()
    try {
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3))
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2))
      const mesh = new THREE.Mesh(geometry, material)
      mesh.frustumCulled = false
      this.camera = camera
      this.geometry = geometry
      this.mesh = mesh
    } catch (error) {
      geometry.dispose()
      throw error
    }
  }

  get material(): THREE.Material | THREE.Material[] { return this.mesh.material }
  set material(value: THREE.Material | THREE.Material[]) { this.mesh.material = value }
  render(renderer: THREE.WebGLRenderer): void { renderer.render(this.mesh, this.camera) }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.geometry.dispose()
  }
}

const cleanupOnlyFullScreenQuad = Object.freeze({
  get material(): THREE.Material | undefined { return undefined },
  set material(_value: THREE.Material | THREE.Material[]) {
    throw new Error('Cleanup-only fullscreen quad cannot be rendered')
  },
  render(): void {
    throw new Error('Cleanup-only fullscreen quad cannot be rendered')
  },
  dispose(): void {},
})

export function replacePassFullScreenQuad(pass: { fsQuad?: unknown }): WorldOwnedFullScreenQuad {
  const previous = pass.fsQuad as { material?: THREE.Material } | undefined
  const material = previous?.material
  pass.fsQuad = cleanupOnlyFullScreenQuad
  let replacement: WorldOwnedFullScreenQuad | null = null
  try {
    replacement = new WorldOwnedFullScreenQuad(material)
    pass.fsQuad = replacement
    return replacement
  } catch (error) {
    replacement?.dispose()
    throw error
  }
}

export function replaceComposerFullScreenQuads(composer: EffectComposer, passes: ReadonlyArray<{ fsQuad?: unknown }>): WorldOwnedFullScreenQuad[] {
  const replaced: WorldOwnedFullScreenQuad[] = []
  const copyPass = (composer as ComposerWithCopyPass).copyPass
  if (copyPass) replaced.push(replacePassFullScreenQuad(copyPass))
  for (const pass of passes) replaced.push(replacePassFullScreenQuad(pass))
  return replaced
}

export function disposeWorldViewportGraphicsResources(resources: ViewportGraphicsResources | null | undefined): void {
  if (!resources || resources.disposed) return
  resources.disposed = true
  // EffectComposer owns renderTarget1/renderTarget2/copyPass. Added passes are owned here.
  resources?.outlinePass?.dispose()
  resources?.fxaaPass?.dispose()
  if (resources?.outputPass) resources?.outputPass.dispose()
  resources?.composer.dispose()
}

export function probeWorldGraphicsCapabilities(renderer: THREE.WebGLRenderer): WorldGraphicsCapabilities {
  const gl = renderer.getContext()
  const webgl2 = isWebGL2Context(gl)
  const maxTextureSize = numberParameter(gl, gl.MAX_TEXTURE_SIZE)
  const maxRenderbufferSize = numberParameter(gl, gl.MAX_RENDERBUFFER_SIZE)
  const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as ArrayLike<number> | null
  return {
    webgl2,
    halfFloatRenderTarget: webgl2 && typeof gl.getExtension === 'function' && gl.getExtension('EXT_color_buffer_float') !== null,
    maxTextureSize,
    maxCubeMapTextureSize: numberParameter(gl, gl.MAX_CUBE_MAP_TEXTURE_SIZE),
    maxRenderbufferSize,
    maxViewportDims: [Number(viewport?.[0] ?? maxRenderbufferSize), Number(viewport?.[1] ?? maxRenderbufferSize)],
    maxSamples: Number((renderer.capabilities as { maxSamples?: number }).maxSamples ?? 0),
    renderTargetSamples: probeWorldGraphicsSampleSupport(gl, webgl2),
  }
}

export function probeWorldGraphicsSampleSupport(gl: WebGLRenderingContext, webgl2: boolean): WorldGraphicsSampleSupport {
  if (!webgl2 || typeof (gl as WebGL2RenderingContext).getInternalformatParameter !== 'function') {
    return { colorInternalFormat: 'RGBA16F', depthInternalFormat: 'DEPTH_COMPONENT24', colorSamples: [], depthSamples: [] }
  }
  const gl2 = gl as WebGL2RenderingContext
  return {
    colorInternalFormat: 'RGBA16F',
    depthInternalFormat: 'DEPTH_COMPONENT24',
    colorSamples: normalizeSampleList(gl2.getInternalformatParameter(gl2.RENDERBUFFER, gl2.RGBA16F, gl2.SAMPLES)),
    depthSamples: normalizeSampleList(gl2.getInternalformatParameter(gl2.RENDERBUFFER, gl2.DEPTH_COMPONENT24, gl2.SAMPLES)),
  }
}

export function applyWorldViewportOutputProfile(renderer: THREE.WebGLRenderer, profile: WorldViewportOutputProfile): void {
  renderer.outputColorSpace = profile.outputColorSpace
  renderer.toneMapping = profile.toneMapping
  renderer.toneMappingExposure = profile.toneMappingExposure
}

export function applyWorldViewportShadowProfile(scene: THREE.Scene, renderer: THREE.WebGLRenderer, effect: EffectiveWorldGraphicsProfile): void {
  renderer.shadowMap.enabled = effect.shadows.enabled
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  scene.traverse((object) => {
    applyWorldViewportShadowProfileToObject(object, effect)
  })
}

export function applyWorldViewportShadowProfileToObject(object: THREE.Object3D, effect: EffectiveWorldGraphicsProfile): void {
  const light = object as THREE.Light & { isPointLight?: boolean; shadow?: THREE.LightShadow | null }
  if (!('isLight' in light) || light.isLight !== true || !light.shadow) return
  const shadow = light.shadow
  if (!effect.shadows.enabled) {
    disposeShadowMap(shadow)
    shadow.needsUpdate = true
    return
  }
  const nextSize = resolveWorldViewportLightShadowMapSize(light, effect)
  if (shadow.mapSize.x !== nextSize || shadow.mapSize.y !== nextSize) {
    disposeShadowMap(shadow)
    shadow.mapSize.set(nextSize, nextSize)
  }
  shadow.needsUpdate = true
}

export function resolveWorldViewportLightShadowMapSize(light: THREE.Light & { isPointLight?: boolean }, effect: EffectiveWorldGraphicsProfile): number {
  if (!effect.shadows.enabled) return 0
  if (light.isPointLight === true) {
    return Math.max(1, Math.floor(Math.min(effect.shadows.mapSize, effect.limits.maxTextureSize / 4, effect.limits.maxRenderbufferSize / 4, effect.limits.maxViewportWidth / 4, effect.limits.maxViewportHeight / 2)))
  }
  return Math.max(1, Math.floor(Math.min(effect.shadows.mapSize, effect.limits.maxTextureSize, effect.limits.maxRenderbufferSize, effect.limits.maxViewportWidth, effect.limits.maxViewportHeight)))
}

export class WorldViewportGraphicsController {
  private generation = 0
  private disposed = false
  private failed = false
  private lastDiagnostic = ''
  private resources: ViewportGraphicsResources | null = null
  private sceneObserver: WorldViewportSceneLightObserver | null = null
  private readonly original: RendererStateSnapshot

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.Camera,
    private readonly kind: WorldGraphicsViewportKind,
    private readonly setDpr: (dpr: number) => void,
    private readonly onDiagnostic: (message: string) => void = () => undefined,
    private readonly onFailure: (failure: WorldViewportFailure) => void = () => undefined,
  ) {
    this.original = captureRendererState(renderer)
  }

  update(input: ViewportGraphicsUpdate): void {
    if (this.disposed || this.failed) return
    const generation = ++this.generation
    try {
      this.scene = input.scene
      this.camera = input.camera
      this.observeScene(input.scene)
      const caps = probeWorldGraphicsCapabilities(this.renderer)
      const resolved = resolveWorldGraphicsProfile(input.project, { cssWidth: input.size.width, cssHeight: input.size.height }, caps)
      if (!resolved.ok) {
        const diagnostic = resolved.diagnostic
        this.reportDiagnostic(diagnostic)
        disposeWorldViewportGraphicsResources(this.resources)
        this.resources = null
        return
      }
      const effect = resolved.value
      applyWorldViewportOutputProfile(this.renderer, WORLD_VIEWPORT_OUTPUT_PROFILES[this.kind])
      applyWorldViewportShadowProfile(this.scene, this.renderer, effect)
      this.sceneObserver?.setEffect(effect)
      this.reportDiagnostic(formatWorldViewportGraphicsDiagnostics([...effect.diagnostics, ...collectWorldViewportShadowDiagnostics(this.scene, effect)]))
      if (effect.drawingBufferWidth === 0 || effect.drawingBufferHeight === 0) {
        disposeWorldViewportGraphicsResources(this.resources)
        this.resources = null
        return
      }
      this.setDpr(effect.dpr)
      const signature = createWorldViewportGraphicsResourceSignature(effect, this.kind)
      if (!this.resources || this.resources.signature !== signature) {
        const previous = this.resources
        let next: ViewportGraphicsResources | null = null
        try {
          next = createWorldViewportGraphicsResources(this.renderer, this.scene, this.camera, effect, this.kind, signature)
        } catch (error) {
          disposeWorldViewportGraphicsResources(next)
          throw error
        }
        if (generation !== this.generation || this.disposed) {
          disposeWorldViewportGraphicsResources(next)
          return
        }
        this.resources = next
        disposeWorldViewportGraphicsResources(previous)
      } else {
        updateWorldViewportGraphicsResources(this.resources, this.scene, this.camera, effect)
      }
    } catch (error) {
      this.reportFailure(error, 'Graphics profile could not be applied.')
    }
  }

  render(delta: number, selectedObjects: readonly THREE.Object3D[]): void {
    if (this.disposed || this.failed) return
    const resources = this.resources
    if (!resources) return
    const generation = this.generation
    try {
      applyWorldViewportOutputProfile(this.renderer, WORLD_VIEWPORT_OUTPUT_PROFILES[this.kind])
      this.sceneObserver?.flushIfDirty()
      if (resources.outlinePass) resources.outlinePass.selectedObjects = selectedObjects.filter(isWorldSelectableMesh)
      resources.composer.render(delta)
    } catch (error) {
      if (generation === this.generation) this.reportFailure(error, 'Graphics profile render failed.')
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.sceneObserver?.dispose()
    this.sceneObserver = null
    disposeWorldViewportGraphicsResources(this.resources)
    this.resources = null
    restoreRendererState(this.renderer, this.original, this.setDpr)
  }

  getResourceIdentity(): object | null { return this.resources }

  private reportFailure(error: unknown, fallback: string): void {
    if (this.disposed || this.failed) return
    this.failed = true
    this.generation += 1
    this.sceneObserver?.dispose()
    this.sceneObserver = null
    disposeWorldViewportGraphicsResources(this.resources)
    this.resources = null
    restoreRendererState(this.renderer, this.original, this.setDpr)
    this.onFailure({ kind: 'render-error', message: error instanceof Error ? error.message : fallback })
  }

  private reportDiagnostic(message: string): void {
    if (message === this.lastDiagnostic) return
    this.lastDiagnostic = message
    this.onDiagnostic(message)
  }

  private observeScene(scene: THREE.Scene): void {
    if (this.sceneObserver?.scene === scene) return
    this.sceneObserver?.dispose()
    this.sceneObserver = new WorldViewportSceneLightObserver(scene, () => this.reportCurrentShadowDiagnostics())
  }

  private reportCurrentShadowDiagnostics(): void {
    const effect = this.resources?.effect ?? this.sceneObserver?.effect ?? null
    if (!effect) return
    this.reportDiagnostic(formatWorldViewportGraphicsDiagnostics([...effect.diagnostics, ...collectWorldViewportShadowDiagnostics(this.scene, effect)]))
  }
}

export function WorldViewportGraphics({ kind, project, selectedObjects = [], onDiagnostic, onGraphicsFailure }: WorldViewportGraphicsProps): JSX.Element | null {
  const { gl, scene, camera, size, setDpr } = useThree()
  const selection = useContext(selectionContext) as { selected?: Iterable<THREE.Object3D> } | null
  const controllerRef = useRef<WorldViewportGraphicsController | null>(null)
  const selectedRef = useRef<readonly THREE.Object3D[]>(selectedObjects)
  const diagnosticRef = useRef(onDiagnostic)
  const failureRef = useRef(onGraphicsFailure)
  const committedSelected = selection?.selected ? [...selection.selected] : selectedObjects
  const graphicsProfileSignature = createWorldGraphicsProfileSignature(project)

  useLayoutEffect(() => {
    diagnosticRef.current = onDiagnostic
    failureRef.current = onGraphicsFailure
    selectedRef.current = committedSelected
  })

  useLayoutEffect(() => {
    const controller = new WorldViewportGraphicsController(
      gl,
      scene,
      camera,
      kind,
      setDpr,
      (message) => diagnosticRef.current?.(message),
      (failure) => failureRef.current?.(failure),
    )
    controllerRef.current = controller
    controller.update({ project, size, scene, camera })
    return () => {
      if (controllerRef.current === controller) controllerRef.current = null
      controller.dispose()
    }
  }, [gl, kind, setDpr])

  useLayoutEffect(() => {
    controllerRef.current?.update({ project, size, scene, camera })
  }, [camera, graphicsProfileSignature, project.activeGraphicsProfileId, scene, size.height, size.width])

  useFrame((_state, delta) => {
    controllerRef.current?.render(delta, selectedRef.current)
  }, 1)

  return null
}

export function createWorldViewportGraphicsResources(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  effect: EffectiveWorldGraphicsProfile,
  kind: WorldGraphicsViewportKind,
  signature = createWorldViewportGraphicsResourceSignature(effect, kind),
): ViewportGraphicsResources {
  const target = new THREE.WebGLRenderTarget(effect.drawingBufferWidth, effect.drawingBufferHeight, {
    format: THREE.RGBAFormat,
    type: WORLD_VIEWPORT_OUTPUT_PROFILES[kind].targetType,
    depthBuffer: true,
    stencilBuffer: false,
    samples: effect.aa.samples,
  })
  const allocated: Partial<ViewportGraphicsResources> = { disposed: false }
  try {
    const composer = new EffectComposer(renderer, target)
    allocated.composer = composer
    replaceComposerFullScreenQuads(composer, [])
    const renderPass = new RenderPass(scene, camera)
    allocated.renderPass = renderPass
    const outlinePass = kind === 'editor' ? new OutlinePass(new THREE.Vector2(effect.drawingBufferWidth, effect.drawingBufferHeight), scene, camera) : null
    allocated.outlinePass = outlinePass
    if (outlinePass) replacePassFullScreenQuad(outlinePass)
    const fxaaPass = new ShaderPass(FXAAShader)
    allocated.fxaaPass = fxaaPass
    replacePassFullScreenQuad(fxaaPass)
    const outputPass = new OutputPass()
    allocated.outputPass = outputPass
    replacePassFullScreenQuad(outputPass)
    if (outlinePass) configureWorldOutlinePass(outlinePass)
    configureWorldFxaaPass(fxaaPass, effect)
    composer.addPass(renderPass)
    if (outlinePass) composer.addPass(outlinePass)
    composer.addPass(fxaaPass)
    composer.addPass(outputPass)
    composer.setPixelRatio(effect.dpr)
    composer.setSize(effect.drawingBufferWidth / Math.max(effect.dpr, 0.0001), effect.drawingBufferHeight / Math.max(effect.dpr, 0.0001))
    return { disposed: false, composer, renderPass, outlinePass, fxaaPass, outputPass, signature, effect }
  } catch (error) {
    if (allocated.composer) {
      disposeWorldViewportGraphicsResources(allocated as ViewportGraphicsResources)
    } else {
      target.dispose()
    }
    throw error
  }
}

function updateWorldViewportGraphicsResources(resources: ViewportGraphicsResources, scene: THREE.Scene, camera: THREE.Camera, effect: EffectiveWorldGraphicsProfile): void {
  resources.effect = effect
  resources.renderPass.scene = scene
  resources.renderPass.camera = camera
  if (resources.outlinePass) {
    const outline = resources.outlinePass as OutlinePass & { renderScene?: THREE.Scene; renderCamera?: THREE.Camera }
    outline.renderScene = scene
    outline.renderCamera = camera
  }
  resources.composer.setPixelRatio(effect.dpr)
  updateWorldViewportComposerSamples(resources.composer, effect.aa.samples, effect.drawingBufferWidth, effect.drawingBufferHeight)
  resources.composer.setSize(effect.drawingBufferWidth / Math.max(effect.dpr, 0.0001), effect.drawingBufferHeight / Math.max(effect.dpr, 0.0001))
  configureWorldFxaaPass(resources.fxaaPass, effect)
}

function configureWorldFxaaPass(pass: ShaderPass, effect: EffectiveWorldGraphicsProfile): void {
  pass.enabled = effect.aa.fxaa
  const resolution = pass.material.uniforms.resolution?.value as THREE.Vector2 | undefined
  resolution?.set(1 / Math.max(1, effect.drawingBufferWidth), 1 / Math.max(1, effect.drawingBufferHeight))
}

function configureWorldOutlinePass(outlinePass: OutlinePass): void {
  outlinePass.edgeStrength = 2.5
  outlinePass.edgeGlow = 0
  outlinePass.edgeThickness = 1
  outlinePass.pulsePeriod = 0
  outlinePass.visibleEdgeColor.set(0x8b5cf6)
  outlinePass.hiddenEdgeColor.set(0x5b21b6)
}

function createWorldGraphicsProfileSignature(project: WorldProjectDocumentV1): string {
  const profile = project.graphicsProfiles.find((candidate) => candidate.id === project.activeGraphicsProfileId)
  return JSON.stringify(profile ? [profile.id, profile.renderScale, profile.shadowQuality, profile.antialiasing] : [project.activeGraphicsProfileId])
}

function createWorldViewportGraphicsResourceSignature(effect: EffectiveWorldGraphicsProfile, kind: WorldGraphicsViewportKind): string {
  return JSON.stringify([kind])
}

function captureRendererState(renderer: THREE.WebGLRenderer): RendererStateSnapshot {
  return {
    outputColorSpace: renderer.outputColorSpace,
    toneMapping: renderer.toneMapping,
    toneMappingExposure: renderer.toneMappingExposure,
    shadowEnabled: renderer.shadowMap.enabled,
    shadowType: renderer.shadowMap.type,
    dpr: typeof renderer.getPixelRatio === 'function' ? renderer.getPixelRatio() : 1,
  }
}

function restoreRendererState(renderer: THREE.WebGLRenderer, state: RendererStateSnapshot, setDpr?: (dpr: number) => void): void {
  renderer.outputColorSpace = state.outputColorSpace
  renderer.toneMapping = state.toneMapping
  renderer.toneMappingExposure = state.toneMappingExposure
  renderer.shadowMap.enabled = state.shadowEnabled
  renderer.shadowMap.type = state.shadowType
  setDpr?.(state.dpr)
  if (typeof renderer.setPixelRatio === 'function') renderer.setPixelRatio(state.dpr)
}

function formatWorldViewportGraphicsDiagnostics(diagnostics: readonly string[]): string {
  return Array.from(new Set(diagnostics.map((diagnostic) => diagnostic.trim()).filter(Boolean))).join('\n')
}

class WorldViewportSceneLightObserver {
  private readonly observed = new Map<THREE.Object3D, { childadded(event: { child?: THREE.Object3D }): void; childremoved(event: { child?: THREE.Object3D }): void }>()
  effect: EffectiveWorldGraphicsProfile | null = null
  private dirty = false
  private disposed = false

  constructor(readonly scene: THREE.Scene, private readonly onDiagnosticsChanged: () => void) {
    this.observeSubtree(scene)
  }

  setEffect(effect: EffectiveWorldGraphicsProfile): void {
    this.effect = effect
  }

  flushIfDirty(): void {
    if (!this.dirty || !this.effect || this.disposed) return
    this.dirty = false
    this.onDiagnosticsChanged()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const [object, listeners] of this.observed) {
      object.removeEventListener('childadded', listeners.childadded)
      object.removeEventListener('childremoved', listeners.childremoved)
    }
    this.observed.clear()
  }

  private observeSubtree(root: THREE.Object3D): void {
    root.traverse((object) => this.observeObject(object))
  }

  private observeObject(object: THREE.Object3D): void {
    if (this.observed.has(object)) return
    const listeners = {
      childadded: (event: { child?: THREE.Object3D }) => {
        const child = event.child
        if (child) this.observeAdded([child])
      },
      childremoved: (event: { child?: THREE.Object3D }) => {
        const child = event.child
        if (child) this.observeRemoved([child])
      },
    }
    object.addEventListener('childadded', listeners.childadded)
    object.addEventListener('childremoved', listeners.childremoved)
    this.observed.set(object, listeners)
  }

  private observeAdded(children: readonly THREE.Object3D[]): void {
    if (this.disposed) return
    for (const child of children) {
      this.observeSubtree(child)
      if (this.effect) child.traverse((object) => applyWorldViewportShadowProfileToObject(object, this.effect!))
    }
    this.dirty = true
    this.onDiagnosticsChanged()
  }

  private observeRemoved(children: readonly THREE.Object3D[]): void {
    if (this.disposed) return
    for (const child of children) this.unobserveDetachedSubtree(child)
    this.dirty = true
  }

  private unobserveDetachedSubtree(root: THREE.Object3D): void {
    root.traverse((object) => {
      const listeners = this.observed.get(object)
      if (listeners) {
        object.removeEventListener('childadded', listeners.childadded)
        object.removeEventListener('childremoved', listeners.childremoved)
        this.observed.delete(object)
      }
      const light = object as THREE.Light & { shadow?: THREE.LightShadow | null }
      if (light.shadow) disposeShadowMap(light.shadow)
    })
  }
}

function updateWorldViewportComposerSamples(composer: EffectComposer, samples: number, drawingBufferWidth: number, drawingBufferHeight: number): void {
  const targets = composer as EffectComposer & {
    renderTarget1?: THREE.WebGLRenderTarget & { samples?: number }
    renderTarget2?: THREE.WebGLRenderTarget & { samples?: number }
    readBuffer?: THREE.WebGLRenderTarget & { samples?: number }
    writeBuffer?: THREE.WebGLRenderTarget & { samples?: number }
  }
  for (const target of new Set([targets.renderTarget1, targets.renderTarget2, targets.readBuffer, targets.writeBuffer])) {
    if (!target || !('samples' in target) || target.samples === samples) continue
    const sizeWillInvalidate = target.width !== drawingBufferWidth || target.height !== drawingBufferHeight
    target.samples = samples
    if (!sizeWillInvalidate) target.dispose()
  }
}

function collectWorldViewportShadowDiagnostics(scene: THREE.Scene, effect: EffectiveWorldGraphicsProfile): string[] {
  if (!effect.shadows.enabled) return []
  const diagnostics = new Set<string>()
  scene.traverse((object) => {
    const light = object as THREE.Light & { isPointLight?: boolean; shadow?: THREE.LightShadow | null; type?: string }
    if (!('isLight' in light) || light.isLight !== true || !light.shadow) return
    const actual = resolveWorldViewportLightShadowMapSize(light, effect)
    if (actual >= effect.shadows.mapSize) return
    diagnostics.add(`${light.isPointLight === true ? 'PointLight shadow atlas' : `${light.type ?? 'Light'} shadow map`} was clamped to ${actual}px per face by per-light atlas limits.`)
  })
  return Array.from(diagnostics)
}

function disposeShadowMap(shadow: THREE.LightShadow): void {
  if (shadow.map) shadow.map.dispose()
  shadow.map = null
}

function isWebGL2Context(gl: WebGLRenderingContext): boolean {
  return typeof (gl as WebGL2RenderingContext).getInternalformatParameter === 'function'
}

function isWorldSelectableMesh(object: THREE.Object3D): object is THREE.Mesh {
  return (object as THREE.Mesh & { isMesh?: boolean }).isMesh === true
}

function numberParameter(gl: WebGLRenderingContext, parameter: number): number {
  const value = gl.getParameter(parameter)
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1
}

function normalizeSampleList(value: unknown): number[] {
  if (!value || typeof value !== 'object' || typeof (value as ArrayLike<number>).length !== 'number') return []
  return Array.from(value as ArrayLike<number>).map(Number).filter((sample) => Number.isInteger(sample) && sample > 0).sort((left, right) => left - right)
}

export default WorldViewportGraphics

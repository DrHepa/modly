import {
  evaluateWorldSequence,
  type WorldSequenceEvaluatedPatch,
} from '../cinematic/worldSequenceEvaluator.ts'
import type {
  WorldCameraComponent,
  WorldComponent,
} from '../core/worldComponentRegistry.ts'
import type {
  WorldRationalTime,
  WorldSceneDocumentV1,
  WorldSequence,
  WorldTransform,
} from '../core/worldModel.ts'
import type {
  WorldRenderHostAudioResult,
  WorldRenderHostFrameRequest,
  WorldRenderHostFrameResult,
  WorldRenderHostInitializePayload,
  WorldRenderHostResourceDescriptor,
  WorldRenderHostResourceRequest,
  WorldRenderHostResourceResult,
} from '../../../shared/types/worldRenderHost.ts'
import {
  WORLD_RENDER_HOST_MAX_AUDIO_SAMPLES,
  WORLD_RENDER_HOST_PROTOCOL,
} from '../../../shared/types/worldRenderHost.ts'
import {
  encodeSilentStereoPcm16Wav,
  encodeStereoPcm16Wav,
  WORLD_OFFLINE_AUDIO_SAMPLE_RATE,
  worldAudioSampleCount,
} from './worldOfflineAudio.ts'

import * as THREE from 'three'
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js'
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { worldGltfAnimationTime } from '../runtime/worldGltfAnimationTiming.ts'
import { selectWorldGltfAnimationByIndex } from '../runtime/worldGltfAnimationTiming.ts'

const GLB_MAGIC = 0x46546c67
const GLB_JSON_CHUNK = 0x4e4f534a
const SUPPORTED_GLTF_REQUIRED_EXTENSIONS = new Set([
  'KHR_materials_emissive_strength',
  'KHR_materials_ior',
  'KHR_materials_specular',
  'KHR_materials_transmission',
  'KHR_materials_unlit',
  'KHR_materials_volume',
  'KHR_texture_transform',
])

export type WorldGlbInspection =
  | { readonly success: true }
  | { readonly success: false; readonly reason: 'invalid-glb' | 'external-dependency' | 'unsupported-extension' }

/** Accepts GLB 2.0 only when every buffer and image is embedded in the file. */
export function inspectSelfContainedGlb(bytes: Uint8Array): WorldGlbInspection {
  if (bytes.byteLength < 20) return { success: false, reason: 'invalid-glb' }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2
    || view.getUint32(8, true) !== bytes.byteLength) return { success: false, reason: 'invalid-glb' }
  const chunkLength = view.getUint32(12, true)
  if (view.getUint32(16, true) !== GLB_JSON_CHUNK || chunkLength < 2 || 20 + chunkLength > bytes.byteLength) {
    return { success: false, reason: 'invalid-glb' }
  }
  let document: unknown
  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(20, 20 + chunkLength)).trimEnd()
    document = JSON.parse(json)
  } catch {
    return { success: false, reason: 'invalid-glb' }
  }
  if (!isPlainRecord(document) || !isPlainRecord(document.asset) || document.asset.version !== '2.0') {
    return { success: false, reason: 'invalid-glb' }
  }
  const buffers = Array.isArray(document.buffers) ? document.buffers : []
  const images = Array.isArray(document.images) ? document.images : []
  if ([...buffers, ...images].some((entry) => isPlainRecord(entry) && typeof entry.uri === 'string')) {
    return { success: false, reason: 'external-dependency' }
  }
  const required = Array.isArray(document.extensionsRequired) ? document.extensionsRequired : []
  if (required.some((extension) => typeof extension !== 'string' || !SUPPORTED_GLTF_REQUIRED_EXTENSIONS.has(extension))) {
    return { success: false, reason: 'unsupported-extension' }
  }
  return { success: true }
}

export interface OfflineCameraProjection {
  readonly entityId: string
  readonly componentId: string
  readonly projection: 'perspective' | 'orthographic'
  readonly position: readonly [number, number, number]
  readonly rotation: readonly [number, number, number]
  readonly near: number
  readonly far: number
  readonly fieldOfView?: number
  readonly orthographicSize?: number
  readonly frustum?: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }
}

export function projectOfflineCamera(
  sceneValue: WorldSceneDocumentV1,
  sequence: WorldSequence,
  time: WorldRationalTime,
  aspect: number,
): OfflineCameraProjection {
  if (!Number.isFinite(aspect) || aspect <= 0) throw new TypeError('Camera aspect is invalid.')
  const scene = structuredClone(sceneValue)
  applyEvaluation(scene, evaluateWorldSequence({ scene: sceneValue, sequence, time, mode: 'seek' }).patches)
  const cameras = scene.entities.flatMap((entity) => {
    if (!isOfflineWorldEntityEnabled(scene, entity.id)) return []
    const camera = entity.components.find((component): component is WorldCameraComponent => (
      component.type === 'camera' && component.enabled && component.primary
    ))
    return camera ? [{ entity, camera }] : []
  })
  if (cameras.length !== 1) throw new Error(`Offline render requires exactly one enabled primary camera; found ${cameras.length}.`)
  const [{ entity, camera }] = cameras
  const base: OfflineCameraProjection = {
    entityId: entity.id,
    componentId: camera.id,
    projection: camera.projection,
    position: [...entity.transform.position],
    rotation: [...entity.transform.rotation],
    near: camera.near,
    far: camera.far,
    ...(camera.fieldOfView === undefined ? {} : { fieldOfView: camera.fieldOfView }),
    ...(camera.orthographicSize === undefined ? {} : { orthographicSize: camera.orthographicSize }),
  }
  if (camera.projection === 'orthographic') {
    const height = camera.orthographicSize!
    return { ...base, frustum: { left: -(height * aspect) / 2, right: (height * aspect) / 2, top: height / 2, bottom: -height / 2 } }
  }
  return base
}

export function applyEvaluation(
  scene: WorldSceneDocumentV1,
  patches: readonly WorldSequenceEvaluatedPatch[],
): void {
  for (const patch of patches) {
    const entity = scene.entities.find((candidate) => candidate.id === patch.entityId)
    if (!entity) continue
    if (patch.kind === 'transform') {
      entity.transform = mergeTransform(entity.transform, patch.transform)
      continue
    }
    const component = entity.components.find((candidate) => candidate.id === patch.componentId)
    if (!component) continue
    if (patch.kind === 'playback-state') continue
    writeComponentProperty(component, patch.property, patch.value)
  }
}

function mergeTransform(base: WorldTransform, patch: Partial<WorldTransform>): WorldTransform {
  return {
    position: patch.position ? [...patch.position] : [...base.position],
    rotation: patch.rotation ? [...patch.rotation] : [...base.rotation],
    scale: patch.scale ? [...patch.scale] : [...base.scale],
  }
}

function writeComponentProperty(component: WorldComponent, property: string, value: unknown): void {
  const segments = property.split('.')
  let current = component as unknown as Record<string, unknown>
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment]
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error(`Unavailable component property ${property}.`)
    current = next as Record<string, unknown>
  }
  current[segments.at(-1)!] = structuredClone(value)
}

export function isOfflineWorldEntityEnabled(scene: WorldSceneDocumentV1, entityId: string): boolean {
  const entities = new Map(scene.entities.map((entity) => [entity.id, entity]))
  const visited = new Set<string>()
  let entity = entities.get(entityId)
  while (entity && !visited.has(entity.id)) {
    visited.add(entity.id)
    if (!entity.enabled) return false
    entity = entity.parentId ? entities.get(entity.parentId) : undefined
  }
  return true
}

export function isOfflineWorldComponentEnabled(
  scene: WorldSceneDocumentV1,
  entityId: string,
  component: WorldComponent,
): boolean {
  return component.enabled && isOfflineWorldEntityEnabled(scene, entityId)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export interface WorldRenderResourceReader {
  (request: WorldRenderHostResourceRequest): Promise<WorldRenderHostResourceResult>
}

interface WorldRenderContextEventTarget {
  addEventListener(type: 'webglcontextlost' | 'webglcontextrestored', listener: EventListener): void
  removeEventListener(type: 'webglcontextlost' | 'webglcontextrestored', listener: EventListener): void
}

export class WorldRenderGpuContextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorldRenderGpuContextError'
  }
}

/** A restored context cannot resume a deterministic job from an unknown GPU state. */
export class WorldRenderGpuContextGuard {
  private readonly target: WorldRenderContextEventTarget
  private readonly onFatal: (error: WorldRenderGpuContextError) => void
  private failure: WorldRenderGpuContextError | null = null
  private disposed = false
  private readonly onContextLost: EventListener = (event) => {
    event.preventDefault()
    this.fail(new WorldRenderGpuContextError('WebGL context was lost during offline rendering.'))
  }
  private readonly onContextRestored: EventListener = () => {
    if (this.failure) return
    this.fail(new WorldRenderGpuContextError('WebGL context was restored without a recoverable render state.'))
  }

  constructor(target: WorldRenderContextEventTarget, onFatal: (error: WorldRenderGpuContextError) => void) {
    this.target = target
    this.onFatal = onFatal
    target.addEventListener('webglcontextlost', this.onContextLost)
    target.addEventListener('webglcontextrestored', this.onContextRestored)
  }

  assertUsable(): void {
    if (this.failure) throw this.failure
    if (this.disposed) throw new Error('World render GPU context guard is disposed.')
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.target.removeEventListener('webglcontextlost', this.onContextLost)
    this.target.removeEventListener('webglcontextrestored', this.onContextRestored)
  }

  private fail(error: WorldRenderGpuContextError): void {
    if (this.disposed || this.failure) return
    this.failure = error
    this.onFatal(error)
  }
}

interface RenderableRuntime {
  entityId: string
  componentId: string
  modelResourceId: string
  object: THREE.Object3D
  materials: THREE.Material[]
  mixer: THREE.AnimationMixer | null
}

interface CameraRuntime {
  entityId: string
  componentId: string
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera
}

interface LightRuntime {
  entityId: string
  componentId: string
  light: THREE.Light
  target?: THREE.Object3D
}

interface AnimationRuntime {
  entityId: string
  componentId: string
  action: THREE.AnimationAction
  mixer: THREE.AnimationMixer
  duration: number
}

/** Dedicated scene renderer: no editor viewer, controls, grid, gizmos or overlays. */
export class OfflineWorldRenderScene {
  private readonly payload: WorldRenderHostInitializePayload
  private readonly readResource: WorldRenderResourceReader
  private readonly resources = new Map<string, WorldRenderHostResourceDescriptor>()
  private readonly resourceBytes = new Map<string, Uint8Array>()
  private readonly decodedAudio = new Map<string, AudioBuffer>()
  private readonly gltfs = new Map<string, GLTF>()
  private readonly entityObjects = new Map<string, THREE.Group>()
  private readonly renderables = new Map<string, RenderableRuntime>()
  private readonly cameras = new Map<string, CameraRuntime>()
  private readonly lights = new Map<string, LightRuntime>()
  private readonly animations = new Map<string, AnimationRuntime>()
  private readonly scene = new THREE.Scene()
  private readonly canvas: HTMLCanvasElement
  private readonly renderer: THREE.WebGLRenderer
  private readonly contextGuard: WorldRenderGpuContextGuard
  private ambient: THREE.AmbientLight | null = null
  private environmentTexture: THREE.Texture | null = null
  private environmentTarget: THREE.WebGLRenderTarget | null = null
  private disposed = false

  constructor(
    payload: WorldRenderHostInitializePayload,
    readResource: WorldRenderResourceReader,
    onFatal: (error: WorldRenderGpuContextError) => void = () => {},
  ) {
    this.payload = structuredClone(payload)
    this.readResource = readResource
    this.canvas = document.createElement('canvas')
    this.canvas.width = payload.preset.width
    this.canvas.height = payload.preset.height
    this.canvas.setAttribute('aria-hidden', 'true')
    document.body.replaceChildren(this.canvas)
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    })
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(payload.preset.width, payload.preset.height, false)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.contextGuard = new WorldRenderGpuContextGuard(this.canvas, (error) => {
      try { this.dispose() } finally { onFatal(error) }
    })
    for (const descriptor of payload.snapshot.resources) this.resources.set(descriptor.id, descriptor)
  }

  async initialize(): Promise<void> {
    this.assertActive()
    for (const descriptor of this.payload.snapshot.resources) {
      const primary = descriptor.files.find((file) => file.role === 'primary')
      if (!primary) throw new Error(`Resource ${descriptor.id} has no primary file.`)
      const result = await this.readResource({
        protocol: WORLD_RENDER_HOST_PROTOCOL,
        jobId: '',
        generation: '',
        resourceId: descriptor.id,
        role: 'primary',
      })
      if (!result.ok || result.resourceId !== descriptor.id || result.role !== 'primary'
        || result.size !== primary.size || result.sha256 !== primary.sha256
        || result.bytes.byteLength !== primary.size) throw new Error(`Pinned resource ${descriptor.id} failed validation.`)
      const bytes = new Uint8Array(result.bytes)
      if (await sha256(bytes) !== primary.sha256) throw new Error(`Pinned resource ${descriptor.id} hash changed.`)
      this.resourceBytes.set(descriptor.id, bytes)
    }
    await this.loadModels()
    await this.predecodeAudio()
    this.createEntityHierarchy()
    this.createPresentationComponents()
    await this.loadEnvironment()
    const firstTime = this.payload.framePlan[0]?.time ?? { numerator: 0, denominator: 1 }
    const camera = this.applyFrame(firstTime)
    await this.renderer.compileAsync(this.scene, camera)
  }

  async renderFrame(request: WorldRenderHostFrameRequest): Promise<WorldRenderHostFrameResult> {
    this.assertActive()
    const planned = this.payload.framePlan[request.index]
    if (!planned || planned.index !== request.index || planned.timestampMicroseconds !== request.timestampMicroseconds
      || planned.time.numerator !== request.time.numerator || planned.time.denominator !== request.time.denominator) {
      throw new Error('Frame request does not match the pinned plan.')
    }
    const camera = this.applyFrame(request.time)
    this.renderer.render(this.scene, camera)
    const width = this.payload.preset.width
    const height = this.payload.preset.height
    const rgba = new Uint8Array(width * height * 4)
    const context = this.renderer.getContext()
    context.readPixels(0, 0, width, height, context.RGBA, context.UNSIGNED_BYTE, rgba)
    return {
      index: request.index,
      width,
      height,
      rgbaSha256: await sha256(rgba),
      rgba: toArrayBuffer(rgba),
    }
  }

  async renderAudio(): Promise<WorldRenderHostAudioResult> {
    this.assertActive()
    const sampleCount = worldAudioSampleCount(this.payload.snapshot.sequence.duration)
    if (sampleCount > WORLD_RENDER_HOST_MAX_AUDIO_SAMPLES) throw new Error('Offline audio sample bound exceeded.')
    let wav: Uint8Array
    if (sampleCount === 0 || !this.hasAudibleSources()) {
      wav = encodeSilentStereoPcm16Wav(sampleCount)
    } else {
      const context = new OfflineAudioContext(2, sampleCount, WORLD_OFFLINE_AUDIO_SAMPLE_RATE)
      this.scheduleListener(context)
      this.scheduleAudioSources(context)
      const rendered = await context.startRendering()
      if (rendered.length !== sampleCount || rendered.sampleRate !== WORLD_OFFLINE_AUDIO_SAMPLE_RATE
        || rendered.numberOfChannels !== 2) throw new Error('Offline audio returned an unexpected shape.')
      wav = encodeStereoPcm16Wav(rendered.getChannelData(0), rendered.getChannelData(1))
    }
    return {
      sampleRate: WORLD_OFFLINE_AUDIO_SAMPLE_RATE,
      channels: 2,
      sampleCount,
      pcmSha256: await sha256(wav.subarray(44)),
      wav: toArrayBuffer(wav),
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.contextGuard.dispose()
    for (const runtime of this.animations.values()) runtime.mixer.stopAllAction()
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose()
        const materials = Array.isArray(object.material) ? object.material : [object.material]
        for (const material of materials) material.dispose()
      }
    })
    this.environmentTexture?.dispose()
    this.environmentTarget?.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.canvas.remove()
  }

  private async loadModels(): Promise<void> {
    for (const descriptor of this.payload.snapshot.resources) {
      if (descriptor.type !== 'model') continue
      if (descriptor.format !== 'glb') throw new Error(`Unsupported model format ${descriptor.format}.`)
      const bytes = this.resourceBytes.get(descriptor.id)!
      const inspection = inspectSelfContainedGlb(bytes)
      if (!inspection.success) throw new Error(`GLB ${descriptor.id} is not self-contained: ${inspection.reason}.`)
      this.gltfs.set(descriptor.id, await parseGlb(bytes))
    }
  }

  private async predecodeAudio(): Promise<void> {
    const decoder = new OfflineAudioContext(2, 1, WORLD_OFFLINE_AUDIO_SAMPLE_RATE)
    for (const descriptor of this.payload.snapshot.resources) {
      if (descriptor.type !== 'audio') continue
      const source = this.resourceBytes.get(descriptor.id)!
      try {
        this.decodedAudio.set(descriptor.id, await decoder.decodeAudioData(toArrayBuffer(source)))
      } catch {
        throw new Error(`Audio resource ${descriptor.id} cannot be decoded by this Chromium package.`)
      }
    }
  }

  private createEntityHierarchy(): void {
    for (const entity of this.payload.snapshot.scene.entities) {
      const object = new THREE.Group()
      object.name = entity.name
      object.userData.worldEntityId = entity.id
      this.entityObjects.set(entity.id, object)
    }
    for (const entity of this.payload.snapshot.scene.entities) {
      const object = this.entityObjects.get(entity.id)!
      const parent = entity.parentId ? this.entityObjects.get(entity.parentId) : null
      if (parent) parent.add(object)
      else this.scene.add(object)
    }
  }

  private createPresentationComponents(): void {
    const modelInstances = new Map<string, RenderableRuntime>()
    for (const entity of this.payload.snapshot.scene.entities) {
      if (!isOfflineWorldEntityEnabled(this.payload.snapshot.scene, entity.id)) continue
      const root = this.entityObjects.get(entity.id)!
      for (const component of entity.components) {
        if (!isOfflineWorldComponentEnabled(this.payload.snapshot.scene, entity.id, component)) continue
        if (component.type === 'renderable') {
          const gltf = this.gltfs.get(component.resourceId)
          if (!gltf) throw new Error(`Renderable ${component.id} has no loaded GLB.`)
          const object = cloneSkeleton(gltf.scene)
          const materials = cloneObjectMaterials(object)
          root.add(object)
          const runtime: RenderableRuntime = {
            entityId: entity.id,
            componentId: component.id,
            modelResourceId: component.resourceId,
            object,
            materials,
            mixer: gltf.animations.length ? new THREE.AnimationMixer(object) : null,
          }
          this.renderables.set(component.id, runtime)
          modelInstances.set(entity.id, runtime)
        } else if (component.type === 'camera') {
          const camera = component.projection === 'perspective'
            ? new THREE.PerspectiveCamera(component.fieldOfView, this.payload.preset.width / this.payload.preset.height, component.near, component.far)
            : new THREE.OrthographicCamera(-1, 1, 1, -1, component.near, component.far)
          root.add(camera)
          this.cameras.set(component.id, { entityId: entity.id, componentId: component.id, camera })
        } else if (component.type === 'light') {
          const runtime = createLightRuntime(entity.id, component)
          root.add(runtime.light)
          if (runtime.target) this.scene.add(runtime.target)
          this.lights.set(component.id, runtime)
        }
      }
    }
    for (const entity of this.payload.snapshot.scene.entities) {
      if (!isOfflineWorldEntityEnabled(this.payload.snapshot.scene, entity.id)) continue
      for (const component of entity.components) {
        if (component.type !== 'animation-player'
          || !isOfflineWorldComponentEnabled(this.payload.snapshot.scene, entity.id, component)) continue
        const descriptor = this.resources.get(component.resourceId)
        const renderable = modelInstances.get(entity.id)
        if (!descriptor || descriptor.type !== 'animation' || descriptor.format !== 'gltf-clip'
          || !descriptor.boundModelResourceId || renderable?.modelResourceId !== descriptor.boundModelResourceId
          || !renderable.mixer) throw new Error(`Animation player ${component.id} is not bound to its entity GLB.`)
        const gltf = this.gltfs.get(descriptor.boundModelResourceId)!
        const clip = selectAnimationClip(gltf.animations, descriptor)
        const action = renderable.mixer.clipAction(clip)
        action.play()
        action.paused = true
        this.animations.set(component.id, {
          entityId: entity.id,
          componentId: component.id,
          action,
          mixer: renderable.mixer,
          duration: clip.duration,
        })
      }
    }
  }

  private async loadEnvironment(): Promise<void> {
    const environment = this.payload.snapshot.scene.environment
    this.scene.background = new THREE.Color(environment.backgroundColor)
    this.scene.fog = environment.fog ? new THREE.Fog(environment.fog.color, environment.fog.near, environment.fog.far) : null
    this.ambient = new THREE.AmbientLight(0xffffff, environment.ambientIntensity)
    this.scene.add(this.ambient)
    if (!environment.environmentResourceId) return
    const descriptor = this.resources.get(environment.environmentResourceId)
    const bytes = this.resourceBytes.get(environment.environmentResourceId)
    if (!descriptor || descriptor.type !== 'environment' || !bytes) throw new Error('Environment resource is unavailable.')
    let texture: THREE.Texture
    if (descriptor.format === 'hdr') texture = textureFromDecodedData(new RGBELoader().parse(toArrayBuffer(bytes)))
    else if (descriptor.format === 'exr') texture = textureFromDecodedData(new EXRLoader().parse(toArrayBuffer(bytes)))
    else if (descriptor.format === 'image') {
      const bitmap = await createImageBitmap(new Blob([toArrayBuffer(bytes)]))
      texture = new THREE.CanvasTexture(bitmap)
      texture.colorSpace = THREE.SRGBColorSpace
    } else throw new Error(`Unsupported environment format ${descriptor.format}.`)
    texture.mapping = THREE.EquirectangularReflectionMapping
    const generator = new THREE.PMREMGenerator(this.renderer)
    generator.compileEquirectangularShader()
    this.environmentTarget = generator.fromEquirectangular(texture)
    generator.dispose()
    this.environmentTexture = texture
    this.scene.environment = this.environmentTarget.texture
    this.scene.background = texture
  }

  private applyFrame(time: WorldRationalTime): THREE.Camera {
    const scene = structuredClone(this.payload.snapshot.scene)
    const evaluation = evaluateWorldSequence({ scene: this.payload.snapshot.scene, sequence: this.payload.snapshot.sequence, time, mode: 'seek' })
    applyEvaluation(scene, evaluation.patches)
    for (const entity of scene.entities) {
      const object = this.entityObjects.get(entity.id)!
      object.position.fromArray(entity.transform.position)
      object.rotation.set(...entity.transform.rotation, 'XYZ')
      object.scale.fromArray(entity.transform.scale)
      object.visible = entity.enabled
      for (const component of entity.components) {
        if (component.type === 'renderable') this.syncRenderable(component)
        else if (component.type === 'camera') this.syncCamera(component)
        else if (component.type === 'light') this.syncLight(component)
        else if (component.type === 'animation-player') this.syncAnimation(component, time, evaluation.patches)
      }
    }
    this.scene.updateMatrixWorld(true)
    this.syncLightTargets()
    const primary: THREE.Camera[] = []
    for (const entity of scene.entities) {
      if (!isOfflineWorldEntityEnabled(scene, entity.id)) continue
      for (const component of entity.components) {
        if (component.type !== 'camera' || !component.enabled || !component.primary) continue
        const camera = this.cameras.get(component.id)?.camera
        if (camera) primary.push(camera)
      }
    }
    if (primary.length !== 1) throw new Error(`Offline frame requires one primary camera; found ${primary.length}.`)
    return primary[0]
  }

  private syncRenderable(component: Extract<WorldComponent, { type: 'renderable' }>): void {
    const runtime = this.renderables.get(component.id)
    if (!runtime) return
    runtime.object.visible = component.enabled && component.visible
    runtime.object.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return
      object.castShadow = component.castShadow
      object.receiveShadow = component.receiveShadow
    })
    for (const material of runtime.materials) {
      if ('color' in material && material.color instanceof THREE.Color) material.color.set(component.material.baseColor)
      if ('metalness' in material && typeof material.metalness === 'number') material.metalness = component.material.metallic
      if ('roughness' in material && typeof material.roughness === 'number') material.roughness = component.material.roughness
      material.opacity = component.material.opacity
      material.transparent = component.material.opacity < 1
      material.needsUpdate = true
    }
  }

  private syncCamera(component: Extract<WorldComponent, { type: 'camera' }>): void {
    const runtime = this.cameras.get(component.id)
    if (!runtime) return
    runtime.camera.visible = component.enabled
    runtime.camera.near = component.near
    runtime.camera.far = component.far
    if (runtime.camera instanceof THREE.PerspectiveCamera) {
      runtime.camera.aspect = this.payload.preset.width / this.payload.preset.height
      runtime.camera.fov = component.fieldOfView!
    } else {
      const height = component.orthographicSize!
      const width = height * this.payload.preset.width / this.payload.preset.height
      runtime.camera.left = -width / 2
      runtime.camera.right = width / 2
      runtime.camera.top = height / 2
      runtime.camera.bottom = -height / 2
    }
    runtime.camera.updateProjectionMatrix()
  }

  private syncLight(component: Extract<WorldComponent, { type: 'light' }>): void {
    const runtime = this.lights.get(component.id)
    if (!runtime) return
    runtime.light.visible = component.enabled
    runtime.light.color.set(component.color)
    runtime.light.intensity = component.intensity
    if (runtime.light instanceof THREE.PointLight && component.lightKind === 'point') runtime.light.distance = component.range
    if (runtime.light instanceof THREE.SpotLight && component.lightKind === 'spot') runtime.light.distance = component.range
    if (runtime.light instanceof THREE.SpotLight && component.lightKind === 'spot') runtime.light.angle = component.angle
    if ('castShadow' in component && 'castShadow' in runtime.light) runtime.light.castShadow = component.castShadow
  }

  private syncLightTargets(): void {
    const direction = new THREE.Vector3(0, 0, -1)
    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    for (const runtime of this.lights.values()) {
      if (!runtime.target) continue
      runtime.light.getWorldPosition(position)
      runtime.light.getWorldQuaternion(quaternion)
      runtime.target.position.copy(position).add(direction.clone().applyQuaternion(quaternion))
      runtime.target.updateMatrixWorld(true)
    }
  }

  private syncAnimation(
    component: Extract<WorldComponent, { type: 'animation-player' }>,
    time: WorldRationalTime,
    patches: readonly WorldSequenceEvaluatedPatch[],
  ): void {
    const runtime = this.animations.get(component.id)
    if (!runtime) return
    const patch = patches.find((candidate) => candidate.kind === 'playback-state'
      && candidate.media === 'animation' && candidate.componentId === component.id)
    const playing = patch?.kind === 'playback-state' ? patch.playing : component.autoplay
    runtime.action.enabled = component.enabled && playing
    if (!runtime.action.enabled) return
    const start = playbackStartSeconds(this.payload.snapshot.sequence, component.id, component.autoplay, time)
    const elapsed = Math.max(0, rationalSeconds(time) - start)
    runtime.action.time = worldGltfAnimationTime(runtime.duration, component.speed, component.loop, elapsed)
    runtime.mixer.update(0)
  }

  private hasAudibleSources(): boolean {
    const scene = this.payload.snapshot.scene
    return scene.entities.some((entity) => entity.components.some((component) => (
      component.type === 'audio-source' && isOfflineWorldComponentEnabled(scene, entity.id, component)
        && this.decodedAudio.has(component.resourceId)
        && playbackIntervals(this.payload.snapshot.sequence, component.id, component.autoplay).length > 0
    )))
  }

  private scheduleListener(context: OfflineAudioContext): void {
    const scene = this.payload.snapshot.scene
    const listener = scene.entities.find((entity) => entity.components.some((component) => (
      component.type === 'audio-listener' && isOfflineWorldComponentEnabled(scene, entity.id, component) && component.primary
    )))
    if (!listener) return
    const samples = this.audioSpatialSamples(listener.id)
    schedulePosition(context.listener, samples)
  }

  private scheduleAudioSources(context: OfflineAudioContext): void {
    const scene = this.payload.snapshot.scene
    const sequence = this.payload.snapshot.sequence
    for (const entity of scene.entities) {
      if (!isOfflineWorldEntityEnabled(scene, entity.id)) continue
      for (const component of entity.components) {
        if (component.type !== 'audio-source' || !isOfflineWorldComponentEnabled(scene, entity.id, component)) continue
        const buffer = this.decodedAudio.get(component.resourceId)
        if (!buffer) throw new Error(`Decoded audio ${component.resourceId} is unavailable.`)
        for (const interval of playbackIntervals(sequence, component.id, component.autoplay)) {
          const source = context.createBufferSource()
          source.buffer = buffer
          source.loop = component.loop
          const gain = context.createGain()
          gain.gain.setValueAtTime(component.volume, interval.start)
          source.connect(gain)
          if (component.spatial) {
            const panner = context.createPanner()
            panner.panningModel = 'HRTF'
            panner.distanceModel = 'inverse'
            panner.refDistance = 1
            panner.maxDistance = component.maxDistance
            panner.rolloffFactor = 1
            schedulePosition(panner, this.audioSpatialSamples(entity.id, interval))
            gain.connect(panner).connect(context.destination)
          } else gain.connect(context.destination)
          source.start(interval.start, 0)
          const naturalEnd = interval.start + buffer.duration
          source.stop(component.loop ? interval.end : Math.min(interval.end, naturalEnd))
        }
      }
    }
  }

  private audioSpatialSamples(entityId: string, interval?: { start: number; end: number }): PositionSample[] {
    const times = [
      { numerator: 0, denominator: 1 },
      ...this.payload.framePlan.map((frame) => frame.time),
      this.payload.snapshot.sequence.duration,
    ]
    const seen = new Set<number>()
    const samples: PositionSample[] = []
    for (const time of times) {
      const seconds = rationalSeconds(time)
      if (seen.has(seconds) || (interval && (seconds < interval.start || seconds > interval.end))) continue
      seen.add(seconds)
      samples.push({ time: seconds, position: worldPositionAt(this.payload.snapshot.scene, this.payload.snapshot.sequence, time, entityId) })
    }
    if (interval && !samples.some((sample) => sample.time === interval.start)) {
      samples.unshift({ time: interval.start, position: worldPositionAtSeconds(this.payload.snapshot.scene, this.payload.snapshot.sequence, interval.start, entityId) })
    }
    return samples.sort((left, right) => left.time - right.time)
  }

  private assertActive(): void {
    this.contextGuard.assertUsable()
    if (this.disposed) throw new Error('Offline world renderer is disposed.')
  }
}

function createLightRuntime(
  entityId: string,
  component: Extract<WorldComponent, { type: 'light' }>,
): LightRuntime {
  if (component.lightKind === 'ambient') {
    return { entityId, componentId: component.id, light: new THREE.AmbientLight(component.color, component.intensity) }
  }
  if (component.lightKind === 'point') {
    return { entityId, componentId: component.id, light: new THREE.PointLight(component.color, component.intensity, component.range, 2) }
  }
  const target = new THREE.Object3D()
  if (component.lightKind === 'spot') {
    const light = new THREE.SpotLight(component.color, component.intensity, component.range, component.angle, 0, 2)
    light.target = target
    return { entityId, componentId: component.id, light, target }
  }
  const light = new THREE.DirectionalLight(component.color, component.intensity)
  light.target = target
  return { entityId, componentId: component.id, light, target }
}

function cloneObjectMaterials(root: THREE.Object3D): THREE.Material[] {
  const materials: THREE.Material[] = []
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    if (Array.isArray(object.material)) {
      object.material = object.material.map((material) => {
        const clone = material.clone()
        materials.push(clone)
        return clone
      })
    } else {
      object.material = object.material.clone()
      materials.push(object.material)
    }
  })
  return materials
}

function selectAnimationClip(clips: readonly THREE.AnimationClip[], descriptor: WorldRenderHostResourceDescriptor): THREE.AnimationClip {
  if (Object.hasOwn(descriptor, 'clipIndex')) {
    const indexed = selectWorldGltfAnimationByIndex(clips, descriptor)
    if (!indexed.success) throw new Error(`Indexed glTF animation selection failed (${indexed.reason}).`)
    return indexed.clip
  }
  if (descriptor.clipName) {
    const byName = clips.find((clip) => clip.name === descriptor.clipName)
    if (byName) return byName
  }
  if (descriptor.clipId) {
    const match = descriptor.clipId.match(/(?:^|:)(\d+)$/)
    if (match && clips[Number(match[1])]) return clips[Number(match[1])]
  }
  if (clips.length === 1) return clips[0]
  throw new Error(`Animation ${descriptor.id} does not identify exactly one GLB clip.`)
}

function parseGlb(bytes: Uint8Array): Promise<GLTF> {
  return new Promise((resolvePromise, rejectPromise) => {
    new GLTFLoader().parse(toArrayBuffer(bytes), '', resolvePromise, (error) => rejectPromise(
      error instanceof Error ? error : new Error(String(error)),
    ))
  })
}

function playbackStartSeconds(sequence: WorldSequence, componentId: string, initial: boolean, time: WorldRationalTime): number {
  const track = sequence.tracks.find((candidate): candidate is Extract<typeof candidate, { type: 'animation' | 'audio' }> => (
    (candidate.type === 'animation' || candidate.type === 'audio') && candidate.componentId === componentId
  ))
  let state = initial
  let start = initial ? 0 : rationalSeconds(time)
  if (!track) return start
  for (const keyframe of track.keyframes) {
    if (compareRational(keyframe.time, time) > 0) break
    if (!state && keyframe.value) start = rationalSeconds(keyframe.time)
    state = keyframe.value
  }
  return start
}

function playbackIntervals(sequence: WorldSequence, componentId: string, initial: boolean): Array<{ start: number; end: number }> {
  const duration = rationalSeconds(sequence.duration)
  const track = sequence.tracks.find((candidate): candidate is Extract<typeof candidate, { type: 'audio' }> => (
    candidate.type === 'audio' && candidate.componentId === componentId
  ))
  let state = initial
  let start = 0
  const intervals: Array<{ start: number; end: number }> = []
  if (track) {
    for (const keyframe of track.keyframes) {
      const time = rationalSeconds(keyframe.time)
      if (state && !keyframe.value && time > start) intervals.push({ start, end: time })
      if (!state && keyframe.value) start = time
      state = keyframe.value
    }
  }
  if (state && duration > start) intervals.push({ start, end: duration })
  return intervals
}

interface PositionSample {
  time: number
  position: readonly [number, number, number]
}

type PositionedAudioNode = AudioListener | PannerNode

function schedulePosition(target: PositionedAudioNode, samples: readonly PositionSample[]): void {
  if (!samples.length) return
  const positionX = target.positionX
  const positionY = target.positionY
  const positionZ = target.positionZ
  positionX.setValueAtTime(samples[0].position[0], samples[0].time)
  positionY.setValueAtTime(samples[0].position[1], samples[0].time)
  positionZ.setValueAtTime(samples[0].position[2], samples[0].time)
  for (const sample of samples.slice(1)) {
    positionX.linearRampToValueAtTime(sample.position[0], sample.time)
    positionY.linearRampToValueAtTime(sample.position[1], sample.time)
    positionZ.linearRampToValueAtTime(sample.position[2], sample.time)
  }
}

function worldPositionAt(
  sceneValue: WorldSceneDocumentV1,
  sequence: WorldSequence,
  time: WorldRationalTime,
  entityId: string,
): [number, number, number] {
  const scene = structuredClone(sceneValue)
  applyEvaluation(scene, evaluateWorldSequence({ scene: sceneValue, sequence, time, mode: 'seek' }).patches)
  const entities = new Map(scene.entities.map((entity) => [entity.id, entity]))
  const chain: typeof scene.entities = []
  let entity = entities.get(entityId)
  const visited = new Set<string>()
  while (entity && !visited.has(entity.id)) {
    visited.add(entity.id)
    chain.unshift(entity)
    entity = entity.parentId ? entities.get(entity.parentId) : undefined
  }
  const matrix = new THREE.Matrix4()
  for (const item of chain) {
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(...item.transform.position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...item.transform.rotation, 'XYZ')),
      new THREE.Vector3(...item.transform.scale),
    )
    matrix.multiply(local)
  }
  const position = new THREE.Vector3().setFromMatrixPosition(matrix)
  return [position.x, position.y, position.z]
}

function worldPositionAtSeconds(
  scene: WorldSceneDocumentV1,
  sequence: WorldSequence,
  seconds: number,
  entityId: string,
): [number, number, number] {
  const denominator = 1_000_000
  return worldPositionAt(scene, sequence, { numerator: Math.round(seconds * denominator), denominator }, entityId)
}

function rationalSeconds(time: WorldRationalTime): number {
  return time.numerator / time.denominator
}

function compareRational(left: WorldRationalTime, right: WorldRationalTime): number {
  const leftValue = BigInt(left.numerator) * BigInt(right.denominator)
  const rightValue = BigInt(right.numerator) * BigInt(left.denominator)
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function textureFromDecodedData(value: unknown): THREE.DataTexture {
  const decoded = value as {
    data: THREE.TypedArray
    width: number
    height: number
    format?: THREE.PixelFormat
    type?: THREE.TextureDataType
    colorSpace?: THREE.ColorSpace
  }
  if (!decoded || !ArrayBuffer.isView(decoded.data) || !Number.isSafeInteger(decoded.width)
    || !Number.isSafeInteger(decoded.height) || decoded.width < 1 || decoded.height < 1) {
    throw new Error('Environment decoder returned invalid data.')
  }
  const texture = new THREE.DataTexture(
    decoded.data as unknown as Uint8Array<ArrayBuffer>,
    decoded.width,
    decoded.height,
    decoded.format ?? THREE.RGBAFormat,
    decoded.type ?? THREE.FloatType,
  )
  if (decoded.colorSpace) texture.colorSpace = decoded.colorSpace
  texture.needsUpdate = true
  return texture
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

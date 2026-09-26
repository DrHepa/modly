import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber'
import { Environment, OrthographicCamera, PerspectiveCamera, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { clone as cloneSkeletonScene } from 'three/examples/jsm/utils/SkeletonUtils.js'

import type { WorldAnimationPlayerComponent, WorldCameraComponent, WorldLightComponent } from '../core/worldComponentRegistry.ts'
import { isWorldGltfAnimationResourceBoundToModel, type WorldInputAction, type WorldProjectSnapshotV1, type WorldTransform } from '../core/worldModel.ts'
import { projectWorldEditorViewport } from '../editor/useWorldEditorProjectionBridge.ts'
import { WorldInputSampler } from '../runtime/worldInputRuntime.ts'
import { resolveWorldRuntimeTransforms } from '../runtime/worldRuntimeEntityGraph.ts'
import { WorldRuntimeAnimationGate } from '../runtime/worldRuntimeClock.ts'
import { initializeWorldGltfAnimation } from '../runtime/worldGltfAnimationTiming.ts'
import { selectWorldGltfAnimationByIndex } from '../runtime/worldGltfAnimationTiming.ts'
import type { WorldPlayState } from '../core/worldSessions.ts'
import type { WorldRuntimeAnimationRequest, WorldRuntimeBodyPose } from '../runtime/worldPlayController.ts'
import type { WorldRuntimeInputFrame } from '../runtime/worldInputRuntime.ts'
import type { WorldSceneItem } from '../worldRenderableResolver.ts'
import type { WorldsViewportEnvironment, WorldsViewportLight } from '../worldsViewportTypes.ts'
import { WorldsGaussianPlyObject } from './WorldsGaussianPlyObject.tsx'
import { WorldCanvasLifecycle, type WorldViewportFailure } from './WorldViewportBoundary.tsx'
import { WorldViewportGraphics } from './WorldViewportGraphics.tsx'

export interface WorldRuntimeViewportProps {
  snapshot: WorldProjectSnapshotV1
  sceneId: string
  apiUrl: string
  lifecycle: Exclude<WorldPlayState, 'edit'>
  bodyPoses: readonly WorldRuntimeBodyPose[]
  animationRequests: readonly WorldRuntimeAnimationRequest[]
  onAdvance(timestampMs: number, input: WorldRuntimeInputFrame): void | Promise<void>
  onError?(message: string): void
  onGraphicsFailure?(failure: WorldViewportFailure): void
  onGraphicsDiagnostic?(message: string): void
}

interface RuntimeAnimationProjection {
  componentId: string
  autoplay: boolean
  loop: boolean
  speed: number
  clipName?: string
  clipIndex?: number
  requestToken: number
}

interface RuntimeItem extends WorldSceneItem {
  runtimeAnimation?: RuntimeAnimationProjection
}

export function WorldRuntimeViewport({
  snapshot,
  sceneId,
  apiUrl,
  lifecycle,
  bodyPoses,
  animationRequests,
  onAdvance,
  onError,
  onGraphicsFailure,
  onGraphicsDiagnostic,
}: WorldRuntimeViewportProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const [graphicsReady, setGraphicsReady] = useState(false)
  const graphicsReadyRef = useRef(false)
  const callbacksRef = useRef({ onAdvance, onError })
  // Reporting/advance callback churn is not an input lifetime boundary. Commit
  // current callbacks without replacing a held sampler or an in-flight advance.
  useLayoutEffect(() => {
    callbacksRef.current = { onAdvance, onError }
  }, [onAdvance, onError])
  const handleGraphicsReady = useCallback((ready: boolean) => {
    graphicsReadyRef.current = ready
    setGraphicsReady(ready)
  }, [])
  const inputActionsSignature = JSON.stringify(snapshot.project.inputActions)
  const sampler = useMemo(() => new WorldInputSampler(parseInputActions(inputActionsSignature), {
    getGamepads: () => typeof navigator === 'undefined' || !navigator.getGamepads ? [] : [...navigator.getGamepads()],
  }), [inputActionsSignature])
  // Supported Play owner document changes publish a new snapshot identity, even at
  // the same revision; pose/request publications retain it. Cache stays instance-local.
  const documentProjection = useMemo(
    () => projectRuntimeDocument(snapshot, sceneId, apiUrl),
    [apiUrl, sceneId, snapshot],
  )
  const projection = useMemo(
    () => projectRuntimePresentation(documentProjection, bodyPoses, animationRequests),
    [animationRequests, bodyPoses, documentProjection],
  )

  useEffect(() => {
    const element = rootRef.current
    if (!element) return
    const detach = sampler.attach(element)
    return () => {
      detach()
      sampler.dispose()
    }
  }, [sampler])

  useLayoutEffect(() => {
    if (lifecycle !== 'playing') {
      sampler.clear()
      return
    }
    if (!rootRef.current || typeof document === 'undefined') return
    if (document.activeElement !== rootRef.current) rootRef.current.focus({ preventScroll: true })
  }, [lifecycle, sampler])

  const handleBlur = () => sampler.clear()

  useEffect(() => {
    if (lifecycle !== 'playing' || !graphicsReady) {
      sampler.clear()
      return
    }
    let cancelled = false
    let frame = 0
    let advancing = false
    const tick = (timestamp: number) => {
      if (cancelled || !graphicsReadyRef.current) return
      frame = requestAnimationFrame(tick)
      if (advancing) return
      advancing = true
      Promise.resolve().then(() => {
        if (!cancelled && graphicsReadyRef.current) return callbacksRef.current.onAdvance(timestamp, sampler.sample())
      })
        .catch((error: unknown) => {
          if (!cancelled && graphicsReadyRef.current) callbacksRef.current.onError?.(error instanceof Error ? error.message : 'Play update failed.')
        })
        .finally(() => { advancing = false })
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      sampler.clear()
    }
  }, [graphicsReady, lifecycle, sampler])

  if (!projection.success) {
    return <div className="world-runtime-viewport is-error" role="alert">{projection.message}</div>
  }
  return (
    <div
      ref={rootRef}
      className={`world-runtime-viewport is-${lifecycle}`}
      aria-label="Play viewport"
      tabIndex={0}
      onBlur={handleBlur}
      onPointerDown={(event) => event.currentTarget.focus()}
    >
      <Canvas shadows dpr={1} gl={{ antialias: false, powerPreference: 'high-performance', outputColorSpace: THREE.SRGBColorSpace, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.0 }}>
        <WorldCanvasLifecycle onFailure={onGraphicsFailure} onReady={handleGraphicsReady} />
        <WorldViewportGraphics kind="play" project={projection.project} onDiagnostic={onGraphicsDiagnostic} onGraphicsFailure={onGraphicsFailure} />
        <color attach="background" args={[projection.environment.backgroundColor]} />
        <RuntimeCamera camera={projection.primaryCamera.component} transform={projection.primaryCamera.transform} />
        <ambientLight intensity={projection.environment.ambientIntensity} />
        {projection.lights.map((light) => <RuntimeLight key={`${light.entityId}:${light.component.id}`} light={light} />)}
        <Suspense fallback={null}>
          {projection.environment.environmentResourceUrl ? <Environment files={projection.environment.environmentResourceUrl} /> : null}
          {projection.items.map((item) => <RuntimeItemObject key={item.id} item={item} lifecycle={lifecycle} onError={onError} />)}
        </Suspense>
      </Canvas>
      {lifecycle === 'loading' ? <div className="world-runtime-viewport__state" role="status">Loading</div> : null}
      {lifecycle === 'paused' ? <div className="world-runtime-viewport__state" role="status">Paused</div> : null}
      {lifecycle === 'stopping' ? <div className="world-runtime-viewport__state" role="status">Stopping</div> : null}
    </div>
  )
}

function parseInputActions(signature: string): WorldInputAction[] {
  return JSON.parse(signature) as WorldInputAction[]
}

function projectRuntimeDocument(
  snapshot: WorldProjectSnapshotV1,
  sceneId: string,
  apiUrl: string,
): { success: true; project: WorldProjectSnapshotV1['project']; entities: WorldProjectSnapshotV1['scenes'][number]['entities']; items: RuntimeItem[]; lights: WorldsViewportLight[]; environment: WorldsViewportEnvironment; primaryCamera: { entityId: string; component: WorldCameraComponent; transform: WorldTransform } } | { success: false; message: string } {
  const projected = projectWorldEditorViewport(snapshot, sceneId, apiUrl)
  if (!projected.success) return { success: false, message: projected.issues[0]?.message ?? 'Runtime scene could not be projected.' }
  const scene = snapshot.scenes.find((candidate) => candidate.sceneId === sceneId)
  if (!scene) return { success: false, message: `Scene ${sceneId} is unavailable.` }
  const resources = new Map(snapshot.project.resources.map((resource) => [resource.id, resource]))
  const items = projected.value.items.map((item): RuntimeItem => {
    const entity = scene.entities.find((candidate) => candidate.id === item.id)
    const player = entity?.components.find((component): component is WorldAnimationPlayerComponent => component.type === 'animation-player' && component.enabled)
    const renderable = entity?.components.find((component) => component.type === 'renderable' && component.enabled)
    const animationResource = player ? resources.get(player.resourceId) : undefined
    const modelResource = renderable?.type === 'renderable' ? resources.get(renderable.resourceId) : undefined
    const runtimeAnimation = player && animationResource?.type === 'animation' && modelResource?.type === 'model'
      && isWorldGltfAnimationResourceBoundToModel(animationResource, modelResource)
      ? {
          componentId: player.id,
          autoplay: player.autoplay,
          loop: player.loop,
          speed: player.speed,
          ...(animationResource.clipName ? { clipName: animationResource.clipName } : {}),
          ...(animationResource.clipIndex === undefined ? {} : { clipIndex: animationResource.clipIndex }),
          requestToken: 0,
        }
      : undefined
    return {
      ...item,
      ...(runtimeAnimation ? { runtimeAnimation } : {}),
    }
  })
  const primaryCamera = projected.value.canonical.cameras.find((camera) => camera.effectiveEnabled && camera.component.primary)
  if (!primaryCamera) return { success: false, message: 'Play requires an enabled primary camera.' }
  return {
    success: true,
    project: structuredClone(snapshot.project),
    entities: scene.entities,
    items,
    lights: projected.value.lights,
    environment: projected.value.environment,
    primaryCamera: {
      entityId: primaryCamera.entityId,
      component: structuredClone(primaryCamera.component),
      transform: structuredClone(primaryCamera.worldTransform),
    },
  }
}

function projectRuntimePresentation(
  document: ReturnType<typeof projectRuntimeDocument>,
  bodyPoses: readonly WorldRuntimeBodyPose[],
  animationRequests: readonly WorldRuntimeAnimationRequest[],
) {
  if (!document.success) return document
  const runtimeTransforms = resolveWorldRuntimeTransforms(document.entities, bodyPoses)
  const requestTokens = new Map<string, number>()
  for (const request of animationRequests) requestTokens.set(`${request.entityId}\0${request.componentId}`, request.token)
  return {
    ...document,
    items: document.items.map((item): RuntimeItem => ({
      ...item,
      transform: structuredClone(runtimeTransforms.get(item.id) ?? item.transform),
      ...(item.runtimeAnimation ? { runtimeAnimation: {
        ...item.runtimeAnimation,
        requestToken: requestTokens.get(`${item.id}\0${item.runtimeAnimation.componentId}`) ?? 0,
      } } : {}),
    })),
    lights: document.lights.map((light) => ({ ...light, transform: structuredClone(runtimeTransforms.get(light.entityId) ?? light.transform) })),
    primaryCamera: {
      ...document.primaryCamera,
      transform: structuredClone(runtimeTransforms.get(document.primaryCamera.entityId) ?? document.primaryCamera.transform),
    },
  }
}

function RuntimeCamera({ camera, transform }: { camera: WorldCameraComponent; transform: WorldTransform }): JSX.Element {
  const { size } = useThree()
  if (camera.projection === 'orthographic') {
    const halfHeight = (camera.orthographicSize ?? 10) / 2
    const halfWidth = halfHeight * (size.width / Math.max(1, size.height))
    return <OrthographicCamera
      makeDefault
      position={transform.position}
      rotation={transform.rotation}
      near={camera.near}
      far={camera.far}
      left={-halfWidth}
      right={halfWidth}
      top={halfHeight}
      bottom={-halfHeight}
    />
  }
  return <PerspectiveCamera
    makeDefault
    position={transform.position}
    rotation={transform.rotation}
    near={camera.near}
    far={camera.far}
    fov={camera.fieldOfView ?? 60}
  />
}

function RuntimeLight({ light }: { light: WorldsViewportLight }): JSX.Element {
  const component = light.component
  if (component.lightKind === 'ambient') return <ambientLight color={component.color} intensity={component.intensity} />
  if (component.lightKind === 'point') return <pointLight position={light.transform.position} color={component.color} intensity={component.intensity} distance={component.range} castShadow={component.castShadow} />
  return <RuntimeDirectedLight component={component} transform={light.transform} />
}

function RuntimeDirectedLight({ component, transform }: { component: Extract<WorldLightComponent, { lightKind: 'directional' | 'spot' }>; transform: WorldTransform }): JSX.Element {
  const target = useMemo(() => new THREE.Object3D(), [])
  const direction = useMemo(() => new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(...transform.rotation, 'XYZ')), [transform.rotation])
  target.position.set(transform.position[0] + direction.x, transform.position[1] + direction.y, transform.position[2] + direction.z)
  if (component.lightKind === 'spot') {
    return <>
      <primitive object={target} />
      <spotLight position={transform.position} target={target} color={component.color} intensity={component.intensity} distance={component.range} angle={component.angle} castShadow={component.castShadow} />
    </>
  }
  return <>
    <primitive object={target} />
    <directionalLight position={transform.position} target={target} color={component.color} intensity={component.intensity} castShadow={component.castShadow} />
  </>
}

function RuntimeItemObject({ item, lifecycle, onError }: { item: RuntimeItem; lifecycle: Exclude<WorldPlayState, 'edit'>; onError?: (message: string) => void }): JSX.Element | null {
  const groupProps = { position: item.transform.position, rotation: item.transform.rotation, scale: item.transform.scale, visible: item.visible }
  if (item.kind === 'glb' || item.kind === 'gltf') return <RuntimeGltfItem item={item} lifecycle={lifecycle} onError={onError} />
  if (item.kind === 'ply-mesh' || item.kind === 'ply-points') return <RuntimePlyItem item={item} />
  if (item.kind === 'gaussian-ply') {
    return <group {...groupProps}><WorldsGaussianPlyObject itemId={item.id} url={item.url} onBoundsChange={() => undefined} /></group>
  }
  return null
}

function RuntimeGltfItem({ item, lifecycle, onError }: { item: RuntimeItem; lifecycle: Exclude<WorldPlayState, 'edit'>; onError?: (message: string) => void }): JSX.Element {
  const gltf = useGLTF(item.url)
  const scene = useMemo(() => cloneSkeletonScene(gltf.scene), [gltf.scene])
  const mixer = useMemo(() => new THREE.AnimationMixer(scene), [scene])
  const animationGate = useRef(new WorldRuntimeAnimationGate())
  const materialOverride = item.material
  const animation = item.runtimeAnimation
  useEffect(() => {
    const clonedMaterials: THREE.Material[] = []
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = item.castShadow ?? true
      mesh.receiveShadow = item.receiveShadow ?? true
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const replacements = materials.map((sourceMaterial) => {
        const clone = sourceMaterial.clone()
        clonedMaterials.push(clone)
        if ('color' in clone && clone.color instanceof THREE.Color) clone.color.set(materialOverride?.baseColor ?? '#ffffff')
        if ('metalness' in clone && typeof clone.metalness === 'number') clone.metalness = materialOverride?.metallic ?? clone.metalness
        if ('roughness' in clone && typeof clone.roughness === 'number') clone.roughness = materialOverride?.roughness ?? clone.roughness
        clone.opacity = materialOverride?.opacity ?? clone.opacity
        clone.transparent = clone.opacity < 1
        return clone
      })
      mesh.material = Array.isArray(mesh.material) ? replacements : replacements[0]!
    })
    return () => clonedMaterials.forEach((material) => material.dispose())
  }, [item.castShadow, item.receiveShadow, materialOverride?.baseColor, materialOverride?.metallic, materialOverride?.opacity, materialOverride?.roughness, scene])
  useEffect(() => {
    mixer.stopAllAction()
    if (!animation || (!animation.autoplay && animation.requestToken === 0)) return
    const indexed = Object.hasOwn(animation, 'clipIndex')
      ? selectWorldGltfAnimationByIndex(gltf.animations, animation)
      : null
    if (indexed && !indexed.success) {
      onError?.(`Indexed glTF animation selection failed (${indexed.reason}).`)
      return
    }
    const clip = indexed ? indexed.clip : animation.clipName ? THREE.AnimationClip.findByName(gltf.animations, animation.clipName) : gltf.animations[0]
    if (!clip) return
    const action = mixer.clipAction(clip)
    initializeWorldGltfAnimation(action, animation.loop, animation.speed)
    return () => { action.stop() }
  }, [animation?.autoplay, animation?.clipName, animation?.clipIndex, animation?.loop, animation?.requestToken, animation?.speed, gltf.animations, mixer, onError])
  useEffect(() => () => {
    mixer.stopAllAction()
    mixer.uncacheRoot(scene)
  }, [mixer, scene])
  useFrame((_state, delta) => animationGate.current.advance(lifecycle, delta, (step) => mixer.update(step)))
  return <primitive object={scene} position={item.transform.position} rotation={item.transform.rotation} scale={item.transform.scale} visible={item.visible} />
}

function RuntimePlyItem({ item }: { item: RuntimeItem }): JSX.Element {
  const source = useLoader(PLYLoader, item.url)
  const geometry = useMemo(() => {
    const clone = source.clone()
    if (item.kind === 'ply-mesh' && !clone.attributes.normal) clone.computeVertexNormals()
    return clone
  }, [item.kind, source])
  useEffect(() => () => geometry.dispose(), [geometry])
  const vertexColors = !!geometry.attributes.color
  const common = { position: item.transform.position, rotation: item.transform.rotation, scale: item.transform.scale, visible: item.visible }
  if (item.kind === 'ply-points') {
    return <points geometry={geometry} {...common}><pointsMaterial size={0.01} vertexColors={vertexColors} color={vertexColors ? '#ffffff' : item.material?.baseColor ?? '#ffffff'} /></points>
  }
  return <mesh geometry={geometry} castShadow={item.castShadow} receiveShadow={item.receiveShadow} {...common}>
    <meshStandardMaterial vertexColors={vertexColors} color={vertexColors ? '#ffffff' : item.material?.baseColor ?? '#ffffff'} metalness={item.material?.metallic ?? 0} roughness={item.material?.roughness ?? 1} opacity={item.material?.opacity ?? 1} transparent={(item.material?.opacity ?? 1) < 1} />
  </mesh>
}

export default WorldRuntimeViewport

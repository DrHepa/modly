import { Component, Suspense, useEffect, useMemo, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { Bounds, GizmoHelper, GizmoViewport, Html, OrbitControls, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'

import { classifyPlyGeometry } from '../plyClassification.ts'
import type { WorldSceneItem } from '../worldRenderableResolver.ts'

export type WorldsViewerUnsupportedItem = {
  workspacePath: string
  reason: 'unsupported-spz' | 'unsupported-gaussian-ply' | 'unsupported-extension' | 'unsafe' | 'unavailable'
}

export interface WorldsViewerProps {
  items: WorldSceneItem[]
  unsupportedItems?: WorldsViewerUnsupportedItem[]
}

export type PlyRenderModel = {
  primitive: 'mesh' | 'points'
  geometry: THREE.BufferGeometry
  hasVertexColors: boolean
  material: 'standard-vertex-color' | 'standard-neutral' | 'points-vertex-color' | 'points-neutral'
  pointSize?: number
  viewerNormalization: 'hy-world-z-up-to-y-up-floor-centered'
}

export const WORLD_VIEWER_ORBIT_CONTROLS = {
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
} as const

export type WorldSceneItemRenderTarget = {
  workspacePath: string
  kind: WorldSceneItem['kind']
  loader: 'ply' | 'gltf'
  primitive: 'mesh' | 'points' | 'scene'
  cameraFit: 'bounds'
  visibleDescription: 'PLY mesh geometry' | 'PLY point cloud geometry' | 'GLB/GLTF model scene'
}

export function WorldsViewer({ items, unsupportedItems = [] }: WorldsViewerProps): JSX.Element {
  const visibleItems = useMemo(() => items.filter((item) => item.visible), [items])
  const description = describeWorldsViewerScene(items, unsupportedItems)

  return (
    <section className="relative h-full w-full overflow-hidden" aria-label="Worlds 3D canvas">
      <Canvas
        camera={{ position: [2.4, 1.8, 2.8], fov: 45, near: 0.01, far: 500 }}
        dpr={[1, 1]}
        gl={{ antialias: true, alpha: false }}
        className="h-full w-full bg-[#18181b]"
      >
        <color attach="background" args={['#18181b']} />
        <ambientLight intensity={0.65} />
        <directionalLight position={[4, 6, 4]} intensity={1.2} />
        <gridHelper args={[10, 20, '#3f3f46', '#27272a']} />
        <Suspense fallback={<HtmlStatus message="Loading world asset…" />}>
          <Bounds fit clip observe margin={1.25}>
            {visibleItems.map((item) => (
              <WorldSceneItemErrorBoundary key={item.id}>
                <WorldSceneItemObject item={item} />
              </WorldSceneItemErrorBoundary>
            ))}
          </Bounds>
        </Suspense>
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.08}
          enablePan={WORLD_VIEWER_ORBIT_CONTROLS.enablePan}
          enableZoom={WORLD_VIEWER_ORBIT_CONTROLS.enableZoom}
          enableRotate={WORLD_VIEWER_ORBIT_CONTROLS.enableRotate}
          screenSpacePanning={WORLD_VIEWER_ORBIT_CONTROLS.screenSpacePanning}
          minPolarAngle={WORLD_VIEWER_ORBIT_CONTROLS.minPolarAngle}
          maxPolarAngle={WORLD_VIEWER_ORBIT_CONTROLS.maxPolarAngle}
          minDistance={WORLD_VIEWER_ORBIT_CONTROLS.minDistance}
          maxDistance={WORLD_VIEWER_ORBIT_CONTROLS.maxDistance}
          zoomSpeed={WORLD_VIEWER_ORBIT_CONTROLS.zoomSpeed}
          panSpeed={WORLD_VIEWER_ORBIT_CONTROLS.panSpeed}
          rotateSpeed={WORLD_VIEWER_ORBIT_CONTROLS.rotateSpeed}
        />
        <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
          <GizmoViewport axisColors={['#ef4444', '#22c55e', '#3b82f6']} labelColor="#f4f4f5" />
        </GizmoHelper>
      </Canvas>

      {description.unsupported.length > 0 ? (
        <div role="status" className="absolute right-3 top-3 rounded-full border border-zinc-700/70 bg-zinc-950/70 px-3 py-1 text-xs text-zinc-300 shadow-xl backdrop-blur">
          Unsupported world asset: {description.unsupported[0].reason}
        </div>
      ) : null}
    </section>
  )
}

export function describeWorldsViewerScene(items: WorldSceneItem[], unsupportedItems: WorldsViewerUnsupportedItem[] = []) {
  const visibleItems = items.filter((item) => item.visible)
  return {
    hasRenderableItems: visibleItems.length > 0,
    hasGrid: true,
    hasOrbitControls: true,
    hasGizmo: true,
    unsupported: unsupportedItems,
    renderTargets: visibleItems.map(getWorldSceneItemRenderTarget),
  }
}

export function getWorldSceneItemRenderTarget(item: WorldSceneItem): WorldSceneItemRenderTarget {
  if (item.kind === 'ply-points') {
    return {
      workspacePath: item.workspacePath,
      kind: item.kind,
      loader: 'ply',
      primitive: 'points',
      cameraFit: 'bounds',
      visibleDescription: 'PLY point cloud geometry',
    }
  }

  if (item.kind === 'ply-mesh') {
    return {
      workspacePath: item.workspacePath,
      kind: item.kind,
      loader: 'ply',
      primitive: 'mesh',
      cameraFit: 'bounds',
      visibleDescription: 'PLY mesh geometry',
    }
  }

  return {
    workspacePath: item.workspacePath,
    kind: item.kind,
    loader: 'gltf',
    primitive: 'scene',
    cameraFit: 'bounds',
    visibleDescription: 'GLB/GLTF model scene',
  }
}

export function createPlyRenderModel(source: ArrayBuffer, item: Pick<WorldSceneItem, 'kind'>): PlyRenderModel {
  const geometry = new PLYLoader().parse(source)
  const classification = classifyPlyGeometry(geometry)
  const shouldRenderPoints = item.kind === 'ply-points' || classification.kind === 'points'

  normalizeHyWorldPlyGeometryForViewer(geometry)
  geometry.computeBoundingSphere()
  if (!shouldRenderPoints && !geometry.getAttribute('normal')) {
    geometry.computeVertexNormals()
  }

  if (shouldRenderPoints) {
    return {
      primitive: 'points',
      geometry,
      hasVertexColors: classification.hasVertexColors,
      material: classification.hasVertexColors ? 'points-vertex-color' : 'points-neutral',
      pointSize: 0.025,
      viewerNormalization: 'hy-world-z-up-to-y-up-floor-centered',
    }
  }

  return {
    primitive: 'mesh',
    geometry,
    hasVertexColors: classification.hasVertexColors,
    material: classification.hasVertexColors ? 'standard-vertex-color' : 'standard-neutral',
    viewerNormalization: 'hy-world-z-up-to-y-up-floor-centered',
  }
}

export function normalizeHyWorldPlyGeometryForViewer(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  geometry.rotateX(-Math.PI / 2)
  geometry.computeBoundingBox()

  const box = geometry.boundingBox
  if (!box) return geometry

  const center = new THREE.Vector3()
  box.getCenter(center)

  geometry.translate(-center.x, -box.min.y, -center.z)
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

function WorldSceneItemObject({ item }: { item: WorldSceneItem }): JSX.Element | null {
  if (item.kind === 'ply-mesh' || item.kind === 'ply-points') {
    return <PlySceneObject item={item} />
  }
  return <GltfSceneObject item={item} />
}

function PlySceneObject({ item }: { item: WorldSceneItem }): JSX.Element | null {
  const [model, setModel] = useState<PlyRenderModel | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setModel(null)
    setError(null)

    fetch(item.url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Unable to load PLY: ${response.status}`)
        return response.arrayBuffer()
      })
      .then((buffer) => {
        if (!controller.signal.aborted) setModel(createPlyRenderModel(buffer, item))
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Unable to load PLY')
      })

    return () => {
      controller.abort()
    }
  }, [item])

  useEffect(() => {
    return () => {
      model?.geometry.dispose()
    }
  }, [model])

  if (error) return <HtmlStatus message={error} />
  if (!model) return <HtmlStatus message="Loading PLY…" />

  if (model.primitive === 'points') {
    return (
      <points geometry={model.geometry} position={item.transform.position} rotation={item.transform.rotation} scale={item.transform.scale}>
        <pointsMaterial size={model.pointSize} sizeAttenuation vertexColors={model.hasVertexColors} color={model.hasVertexColors ? undefined : '#a1a1aa'} />
      </points>
    )
  }

  return (
    <mesh geometry={model.geometry} position={item.transform.position} rotation={item.transform.rotation} scale={item.transform.scale}>
      <meshStandardMaterial vertexColors={model.hasVertexColors} color={model.hasVertexColors ? undefined : '#d4d4d8'} roughness={0.8} metalness={0.05} />
    </mesh>
  )
}

function GltfSceneObject({ item }: { item: WorldSceneItem }): JSX.Element {
  const gltf = useGLTF(item.url)
  return <primitive object={gltf.scene} position={item.transform.position} rotation={item.transform.rotation} scale={item.transform.scale} />
}

class WorldSceneItemErrorBoundary extends Component<{ children: JSX.Element }, { message: string | null }> {
  state = { message: null }

  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: error instanceof Error ? error.message : 'Unable to load world asset' }
  }

  render(): JSX.Element {
    if (this.state.message) return <HtmlStatus message={this.state.message} />
    return this.props.children
  }
}

function HtmlStatus({ message }: { message: string }): JSX.Element {
  return (
    <Html center>
      <div role="status" className="rounded-full border border-zinc-700/70 bg-zinc-950/80 px-3 py-1 text-xs text-zinc-300 shadow-xl backdrop-blur">
        {message}
      </div>
    </Html>
  )
}

export default WorldsViewer

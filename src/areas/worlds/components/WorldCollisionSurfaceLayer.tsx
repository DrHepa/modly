import { TransformControls } from '@react-three/drei'
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import * as THREE from 'three'

import { normalizeWorldCollisionSurface, type WorldCollisionRectGeometry, type WorldCollisionSurface, type WorldCollisionSurfaceTransform, type WorldCollisionSurfaceTuple2 } from '../worldsCollisionSurfaces.ts'
import type { WorldsTransformMode } from './WorldsTransformToolbar.tsx'

export const WORLD_COLLISION_SURFACE_MIN_SCALE = 0.05

export interface WorldCollisionSurfaceLayerProps {
  editMode: boolean
  surfaces: readonly WorldCollisionSurface[]
  selectedSurfaceId: string | null
  transformMode: WorldsTransformMode | null
  onSelectSurface: (surfaceId: string) => void
  onTransformSurface: (surfaceId: string, transform: WorldCollisionSurfaceTransform) => void
  draggingRef?: RefObject<boolean>
  onTransformDragEndSelectionBlock?: () => void
}

export interface WorldCollisionSurfaceGeometryData {
  positions: [number, number, number, ...number[]]
  indices: [number, number, number, ...number[]]
  outlinePositions: [number, number, number, ...number[]]
}

export interface RectCollisionSurfaceGeometryData extends WorldCollisionSurfaceGeometryData {
  corners: [[number, number], [number, number], [number, number], [number, number]]
}

export interface TriCollisionSurfaceGeometryData extends WorldCollisionSurfaceGeometryData {
  vertices: [WorldCollisionSurfaceTuple2, WorldCollisionSurfaceTuple2, WorldCollisionSurfaceTuple2]
}

export interface WorldCollisionSurfaceTransformAxisVisibility {
  showX: boolean
  showY: boolean
  showZ: boolean
}

export interface WorldCollisionSurfaceObjectLike {
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number }
  scale: { x: number; y: number; z: number }
}

export type WorldCollisionSurfaceRenderModel = {
  id: string
  shape: 'rect' | 'tri'
  selected: boolean
  transform: WorldCollisionSurfaceTransform
  geometry: RectCollisionSurfaceGeometryData | TriCollisionSurfaceGeometryData
}

export interface WorldCollisionSurfaceLayerModel {
  surfaces: WorldCollisionSurfaceRenderModel[]
  gizmoSurfaceId: string | null
  transformMode: WorldsTransformMode | null
  transformAxes: WorldCollisionSurfaceTransformAxisVisibility
}

export interface WorldCollisionSurfaceRenderResources {
  fillGeometry: THREE.BufferGeometry
  outlineGeometry: THREE.BufferGeometry
}

export interface WorldCollisionSurfaceLayerMaterials {
  selectedFill: THREE.MeshBasicMaterial
  unselectedFill: THREE.MeshBasicMaterial
  selectedOutline: THREE.LineBasicMaterial
  unselectedOutline: THREE.LineBasicMaterial
}

export function buildRectCollisionSurfaceGeometryData(geometry: Pick<WorldCollisionRectGeometry, 'halfWidth' | 'halfHeight'>): RectCollisionSurfaceGeometryData {
  const corners: RectCollisionSurfaceGeometryData['corners'] = [
    [-geometry.halfWidth, -geometry.halfHeight],
    [-geometry.halfWidth, geometry.halfHeight],
    [geometry.halfWidth, geometry.halfHeight],
    [geometry.halfWidth, -geometry.halfHeight],
  ]

  return {
    corners,
    positions: corners.flatMap(([x, z]) => [x, 0, z]) as RectCollisionSurfaceGeometryData['positions'],
    indices: [0, 1, 2, 0, 2, 3],
    outlinePositions: corners.flatMap(([x, z]) => [x, 0, z]) as RectCollisionSurfaceGeometryData['outlinePositions'],
  }
}

export function buildTriCollisionSurfaceGeometryData(vertices: readonly WorldCollisionSurfaceTuple2[]): TriCollisionSurfaceGeometryData {
  const stableVertices = [
    [...vertices[0]!] as WorldCollisionSurfaceTuple2,
    [...vertices[1]!] as WorldCollisionSurfaceTuple2,
    [...vertices[2]!] as WorldCollisionSurfaceTuple2,
  ] as TriCollisionSurfaceGeometryData['vertices']

  if (signedTriangleAreaTwice(stableVertices) < 0) {
    const swap = stableVertices[1]
    stableVertices[1] = stableVertices[2]
    stableVertices[2] = swap
  }

  return {
    vertices: stableVertices,
    positions: stableVertices.flatMap(([x, z]) => [x, 0, z]) as TriCollisionSurfaceGeometryData['positions'],
    indices: [0, 1, 2],
    outlinePositions: stableVertices.flatMap(([x, z]) => [x, 0, z]) as TriCollisionSurfaceGeometryData['outlinePositions'],
  }
}

export function resolveWorldCollisionSurfaceTransformAxisVisibility(mode: WorldsTransformMode | null): WorldCollisionSurfaceTransformAxisVisibility {
  return {
    showX: true,
    showY: mode === 'scale' ? false : true,
    showZ: true,
  }
}

export function normalizeWorldCollisionSurfaceObjectTransform(object: WorldCollisionSurfaceObjectLike): WorldCollisionSurfaceTransform {
  return {
    position: [object.position.x, object.position.y, object.position.z],
    rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
    scale: [
      clampPlanarScale(object.scale.x),
      1,
      clampPlanarScale(object.scale.z),
    ],
  }
}

export function enforceWorldCollisionSurfacePlanarScale(object: Pick<WorldCollisionSurfaceObjectLike, 'scale'>): void {
  object.scale.x = clampPlanarScale(object.scale.x)
  object.scale.y = 1
  object.scale.z = clampPlanarScale(object.scale.z)
}

export function guardSelectWorldCollisionSurface({
  selectedSurfaceId,
  surfaceId,
  onSelectSurface,
}: {
  selectedSurfaceId: string | null
  surfaceId: string
  onSelectSurface: (surfaceId: string) => void
}): boolean {
  if (selectedSurfaceId === surfaceId) return false
  onSelectSurface(surfaceId)
  return true
}

export function describeWorldCollisionSurfaceLayerModel({
  editMode,
  surfaces,
  selectedSurfaceId,
  transformMode,
}: {
  editMode: boolean
  surfaces: readonly WorldCollisionSurface[]
  selectedSurfaceId: string | null
  transformMode: WorldsTransformMode | null
}): WorldCollisionSurfaceLayerModel {
  if (!editMode) {
    return {
      surfaces: [],
      gizmoSurfaceId: null,
      transformMode: null,
      transformAxes: resolveWorldCollisionSurfaceTransformAxisVisibility(null),
    }
  }

  const renderSurfaces = surfaces.flatMap((surface) => {
    const normalized = normalizeWorldCollisionSurface(surface)
    if (!normalized) return []
    return [{
      id: normalized.id,
      shape: normalized.shape,
      selected: normalized.id === selectedSurfaceId,
      transform: normalized.transform,
      geometry: normalized.shape === 'rect'
        ? buildRectCollisionSurfaceGeometryData(normalized.geometry)
        : buildTriCollisionSurfaceGeometryData(normalized.geometry.vertices),
    } satisfies WorldCollisionSurfaceRenderModel]
  })

  const gizmoSurfaceId = transformMode && renderSurfaces.some((surface) => surface.id === selectedSurfaceId)
    ? selectedSurfaceId
    : null

  return {
    surfaces: renderSurfaces,
    gizmoSurfaceId,
    transformMode,
    transformAxes: resolveWorldCollisionSurfaceTransformAxisVisibility(transformMode),
  }
}

export function createWorldCollisionSurfaceRenderResources(surface: WorldCollisionSurfaceRenderModel): WorldCollisionSurfaceRenderResources {
  const fillGeometry = new THREE.BufferGeometry()
  fillGeometry.setAttribute('position', new THREE.Float32BufferAttribute(surface.geometry.positions, 3))
  fillGeometry.setIndex([...surface.geometry.indices])
  fillGeometry.computeBoundingSphere()

  const outlineGeometry = new THREE.BufferGeometry()
  outlineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(surface.geometry.outlinePositions, 3))
  outlineGeometry.computeBoundingSphere()

  return { fillGeometry, outlineGeometry }
}

export function disposeWorldCollisionSurfaceRenderResources(resources: WorldCollisionSurfaceRenderResources): void {
  resources.fillGeometry.dispose()
  resources.outlineGeometry.dispose()
}

export function createWorldCollisionSurfaceLayerMaterials(): WorldCollisionSurfaceLayerMaterials {
  return {
    selectedFill: new THREE.MeshBasicMaterial({
      color: '#38bdf8',
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.26,
      depthWrite: false,
    }),
    unselectedFill: new THREE.MeshBasicMaterial({
      color: '#f59e0b',
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
    }),
    selectedOutline: new THREE.LineBasicMaterial({
      color: '#7dd3fc',
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    }),
    unselectedOutline: new THREE.LineBasicMaterial({
      color: '#fde68a',
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    }),
  }
}

export function disposeWorldCollisionSurfaceLayerMaterials(materials: WorldCollisionSurfaceLayerMaterials): void {
  materials.selectedFill.dispose()
  materials.unselectedFill.dispose()
  materials.selectedOutline.dispose()
  materials.unselectedOutline.dispose()
}

export function WorldCollisionSurfaceLayer({
  editMode,
  surfaces,
  selectedSurfaceId,
  transformMode,
  onSelectSurface,
  onTransformSurface,
  draggingRef,
  onTransformDragEndSelectionBlock,
}: WorldCollisionSurfaceLayerProps): JSX.Element | null {
  const layerModel = useMemo(() => describeWorldCollisionSurfaceLayerModel({
    editMode,
    surfaces,
    selectedSurfaceId,
    transformMode,
  }), [editMode, selectedSurfaceId, surfaces, transformMode])
  const materials = useMemo(() => createWorldCollisionSurfaceLayerMaterials(), [])
  const resources = useMemo(() => layerModel.surfaces.map((surface) => ({
    surfaceId: surface.id,
    resources: createWorldCollisionSurfaceRenderResources(surface),
  })), [layerModel.surfaces])
  const surfaceRootsRef = useRef(new Map<string, THREE.Group>())
  const [selectedRootObject, setSelectedRootObject] = useState<THREE.Group | null>(null)

  useEffect(() => {
    return () => {
      disposeWorldCollisionSurfaceLayerMaterials(materials)
    }
  }, [materials])

  useEffect(() => {
    return () => {
      resources.forEach((entry) => disposeWorldCollisionSurfaceRenderResources(entry.resources))
    }
  }, [resources])

  useEffect(() => {
    setSelectedRootObject(layerModel.gizmoSurfaceId ? surfaceRootsRef.current.get(layerModel.gizmoSurfaceId) ?? null : null)
  }, [layerModel.gizmoSurfaceId, resources])

  if (layerModel.surfaces.length === 0) return null

  return (
    <>
      {layerModel.surfaces.map((surface, index) => {
        const resourceEntry = resources[index]
        if (!resourceEntry) return null
        const fillMaterial = surface.selected ? materials.selectedFill : materials.unselectedFill
        const outlineMaterial = surface.selected ? materials.selectedOutline : materials.unselectedOutline

        return (
          <group
            key={surface.id}
            ref={(node) => {
              if (node) surfaceRootsRef.current.set(surface.id, node)
              else surfaceRootsRef.current.delete(surface.id)
              if (surface.id === layerModel.gizmoSurfaceId) setSelectedRootObject(node)
            }}
            position={surface.transform.position}
            rotation={surface.transform.rotation}
            scale={surface.transform.scale}
            userData={{ worldsCollisionSurface: true, worldsCollisionSurfaceId: surface.id }}
          >
            <mesh
              renderOrder={surface.selected ? 11 : 10}
              onClick={(event) => {
                event.stopPropagation()
                guardSelectWorldCollisionSurface({ selectedSurfaceId, surfaceId: surface.id, onSelectSurface })
              }}
            >
              <primitive object={resourceEntry.resources.fillGeometry} attach="geometry" />
              <primitive object={fillMaterial} attach="material" />
            </mesh>
            <lineLoop renderOrder={surface.selected ? 13 : 12}>
              <primitive object={resourceEntry.resources.outlineGeometry} attach="geometry" />
              <primitive object={outlineMaterial} attach="material" />
            </lineLoop>
          </group>
        )
      })}
      {layerModel.gizmoSurfaceId && selectedRootObject && layerModel.transformMode ? (
        <TransformControls
          object={selectedRootObject}
          mode={layerModel.transformMode}
          space="local"
          showX={layerModel.transformAxes.showX}
          showY={layerModel.transformAxes.showY}
          showZ={layerModel.transformAxes.showZ}
          onMouseDown={() => {
            if (draggingRef) draggingRef.current = true
          }}
          onObjectChange={() => {
            if (transformMode === 'scale' && selectedRootObject) enforceWorldCollisionSurfacePlanarScale(selectedRootObject)
          }}
          onMouseUp={() => {
            if (draggingRef) draggingRef.current = false
            onTransformDragEndSelectionBlock?.()
            enforceWorldCollisionSurfacePlanarScale(selectedRootObject)
            onTransformSurface(layerModel.gizmoSurfaceId, normalizeWorldCollisionSurfaceObjectTransform(selectedRootObject))
          }}
        />
      ) : null}
    </>
  )
}

export default WorldCollisionSurfaceLayer

function signedTriangleAreaTwice(vertices: readonly WorldCollisionSurfaceTuple2[]): number {
  const [a, b, c] = vertices
  return ((b[1] - a[1]) * (c[0] - a[0])) - ((b[0] - a[0]) * (c[1] - a[1]))
}

function clampPlanarScale(value: number): number {
  if (!Number.isFinite(value)) return WORLD_COLLISION_SURFACE_MIN_SCALE
  return Math.max(Math.abs(value), WORLD_COLLISION_SURFACE_MIN_SCALE)
}

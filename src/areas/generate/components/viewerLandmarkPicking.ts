import { REQUIRED_LANDMARK_IDS, type LandmarkId, type LandmarkPoint, type LandmarkWorldPoint } from '../../workflows/landmarks.ts'
import { LANDMARK_GUIDE_ITEM_BY_ID } from '../../workflows/landmarkGuideModel.ts'

export interface CanvasPointerLike {
  clientX: number
  clientY: number
}

export interface CanvasRectProvider {
  getBoundingClientRect: () => Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>
}

export interface LandmarkPickObjectLike {
  name?: string
  parent?: LandmarkPickObjectLike | null
  userData?: {
    name?: unknown
    objectName?: unknown
    landmarkClickable?: unknown
    landmarkPickTarget?: unknown
  }
}

export interface LandmarkIntersectionLike {
  object: LandmarkPickObjectLike
  point: LandmarkWorldPoint
}

export interface NormalizedCanvasPointer {
  x: number
  y: number
}

export interface LandmarkPointIntent {
  pointer: NormalizedCanvasPointer
  point: LandmarkPoint
}

export interface CreateLandmarkPointIntentInput {
  activeLandmarkId: LandmarkId
  pointer: CanvasPointerLike
  canvas: CanvasRectProvider
  intersections: readonly LandmarkIntersectionLike[]
  clickableObjects?: readonly LandmarkPickObjectLike[]
}

export interface LandmarkMarkerViewModel {
  id: LandmarkId
  name: string
  label: string
  shortLabel: string
  color: string
  position: LandmarkWorldPoint
  objectName?: string
}

export interface LandmarkMarkerLabelViewModel {
  id: LandmarkId
  label: string
  shortLabel: string
  visible: boolean
}

export interface LandmarkMarkerRenderModel {
  id: LandmarkId
  badgeLabel: string
  fullLabel: string
  color: string
  showFullLabel: boolean
  position: LandmarkWorldPoint
}

function isFiniteCoordinate(value: number): boolean {
  return Number.isFinite(value)
}

function isValidWorldPoint(point: LandmarkWorldPoint): boolean {
  return isFiniteCoordinate(point.x) && isFiniteCoordinate(point.y) && isFiniteCoordinate(point.z)
}

function isSelfOrDescendantOf(object: LandmarkPickObjectLike, target: LandmarkPickObjectLike): boolean {
  let current: LandmarkPickObjectLike | null | undefined = object
  while (current) {
    if (current === target) return true
    current = current.parent
  }
  return false
}

function isExplicitLandmarkClickable(object: LandmarkPickObjectLike): boolean {
  return object.userData?.landmarkClickable === true || object.userData?.landmarkPickTarget === true
}

function isRelevantIntersection(intersection: LandmarkIntersectionLike, clickableObjects: readonly LandmarkPickObjectLike[]): boolean {
  if (clickableObjects.length === 0) return isExplicitLandmarkClickable(intersection.object)
  return clickableObjects.some((target) => isSelfOrDescendantOf(intersection.object, target))
}

function resolveObjectName(object: LandmarkPickObjectLike): string | undefined {
  const userDataObjectName = object.userData?.objectName
  if (typeof userDataObjectName === 'string' && userDataObjectName.length > 0) return userDataObjectName

  const userDataName = object.userData?.name
  if (typeof userDataName === 'string' && userDataName.length > 0) return userDataName

  return typeof object.name === 'string' && object.name.length > 0 ? object.name : undefined
}

export function normalizeCanvasPointer(pointer: CanvasPointerLike, canvas: CanvasRectProvider): NormalizedCanvasPointer {
  const rect = canvas.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 }

  const canvasX = pointer.clientX - rect.left
  const canvasY = pointer.clientY - rect.top

  return {
    x: (canvasX / rect.width) * 2 - 1,
    y: -((canvasY / rect.height) * 2 - 1),
  }
}

export function createLandmarkPointIntent(input: CreateLandmarkPointIntentInput): LandmarkPointIntent | null {
  const clickableObjects = input.clickableObjects ?? []
  const hit = input.intersections.find((intersection) => (
    isValidWorldPoint(intersection.point) && isRelevantIntersection(intersection, clickableObjects)
  ))

  if (!hit) return null

  const objectName = resolveObjectName(hit.object)
  return {
    pointer: normalizeCanvasPointer(input.pointer, input.canvas),
    point: {
      id: input.activeLandmarkId,
      name: input.activeLandmarkId,
      world: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
      ...(objectName !== undefined ? { objectName } : {}),
      confidence: 1,
      source: 'manual',
    },
  }
}

export function deriveLandmarkMarkers(completed: Partial<Record<LandmarkId, LandmarkPoint>> | undefined): LandmarkMarkerViewModel[] {
  if (!completed) return []

  return REQUIRED_LANDMARK_IDS.flatMap((id) => {
    const point = completed[id]
    if (!point) return []
    return [{
      id: point.id,
      name: point.name,
      label: LANDMARK_GUIDE_ITEM_BY_ID[id].label,
      shortLabel: LANDMARK_GUIDE_ITEM_BY_ID[id].token,
      color: LANDMARK_GUIDE_ITEM_BY_ID[id].color,
      position: { x: point.world.x, y: point.world.y, z: point.world.z },
      ...(point.objectName !== undefined ? { objectName: point.objectName } : {}),
    }]
  })
}

export function resolveLandmarkMarkerLabelVisibility(
  markers: readonly LandmarkMarkerViewModel[],
  hoveredMarkerId: LandmarkId | null,
): LandmarkMarkerLabelViewModel[] {
  return markers.map((marker) => ({
    id: marker.id,
    label: marker.label,
    shortLabel: marker.shortLabel,
    visible: marker.id === hoveredMarkerId,
  }))
}

export function resolveLandmarkMarkerRenderModels(
  markers: readonly LandmarkMarkerViewModel[],
  hoveredMarkerId: LandmarkId | null,
): LandmarkMarkerRenderModel[] {
  return markers.map((marker) => ({
    id: marker.id,
    badgeLabel: marker.shortLabel,
    fullLabel: marker.label,
    color: marker.color,
    showFullLabel: marker.id === hoveredMarkerId,
    position: marker.position,
  }))
}

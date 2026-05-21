import { REQUIRED_LANDMARK_IDS, isLandmarkCaptureComplete, type LandmarkCaptureState, type LandmarkId, type LandmarkPoint } from './landmarks.ts'

export type LandmarkGuideStatus = 'empty' | 'partial' | 'complete'

export type LandmarkGuidePoint = { x: number; y: number }

export type LandmarkGuideCharacterViewport = {
  frame: { width: number; height: number }
  image: {
    naturalWidth: number
    naturalHeight: number
    renderedWidth: number
    renderedHeight: number
    offsetX: number
    offsetY: number
  }
}

export type LandmarkGuideItem = {
  id: LandmarkId
  token: string
  label: string
  color: string
  visual: {
    /** Character-local percent, before object-contain centering inside the guide frame. */
    anchor: LandmarkGuidePoint
    /** Character-local percent for readable label placement; mapped to frame coordinates at render time. */
    badge: LandmarkGuidePoint
  }
  /** @deprecated Use visual.anchor for the anatomical point and visual.badge for displayed label position. */
  guidePosition: { x: number; y: number }
}

export type LandmarkGuideItemState = LandmarkGuideItem & { completed: boolean }

export type LandmarksGuideModel = {
  items: LandmarkGuideItemState[]
  completedCount: number
  totalCount: number
  status: LandmarkGuideStatus
  progressLabel: string
  instruction: string
  error?: string
}

export type LandmarksNodePrimaryAction = {
  kind: 'continue-landmarks'
  nodeId: string
  label: 'Continue workflow' | 'Finish all landmarks to continue'
  disabled: boolean
}

export type LandmarkGuideSession = Pick<LandmarkCaptureState, 'nodeId' | 'completed'> & Pick<Partial<LandmarkCaptureState>, 'canContinue' | 'error'> & { sidecarStatus?: 'not_started' | 'pending-write' | 'ready' | 'error' }

export const LANDMARK_GUIDE_CHARACTER_VIEWPORT: LandmarkGuideCharacterViewport = {
  frame: { width: 156, height: 144 },
  image: {
    naturalWidth: 210,
    naturalHeight: 339,
    renderedWidth: 89.2,
    renderedHeight: 144,
    offsetX: 33.4,
    offsetY: 0,
  },
}

export const LANDMARK_GUIDE_ITEMS: LandmarkGuideItem[] = [
  { id: 'right_shoulder', token: 'RS', label: 'Right shoulder', color: '#38bdf8', visual: { anchor: { x: 34, y: 21 }, badge: { x: 19, y: 19 } }, guidePosition: { x: 34, y: 21 } },
  { id: 'left_shoulder', token: 'LS', label: 'Left shoulder', color: '#fbbf24', visual: { anchor: { x: 59, y: 21 }, badge: { x: 74, y: 19 } }, guidePosition: { x: 59, y: 21 } },
  { id: 'hip', token: 'H', label: 'Hip', color: '#f97316', visual: { anchor: { x: 46, y: 41 }, badge: { x: 68, y: 41 } }, guidePosition: { x: 46, y: 41 } },
  { id: 'left_knee', token: 'LK', label: 'Left knee', color: '#a78bfa', visual: { anchor: { x: 55, y: 64 }, badge: { x: 73, y: 66 } }, guidePosition: { x: 55, y: 64 } },
  { id: 'right_knee', token: 'RK', label: 'Right knee', color: '#22c55e', visual: { anchor: { x: 38, y: 64 }, badge: { x: 20, y: 66 } }, guidePosition: { x: 38, y: 64 } },
]

export const LANDMARK_GUIDE_ITEM_BY_ID: Record<LandmarkId, LandmarkGuideItem> = Object.fromEntries(
  LANDMARK_GUIDE_ITEMS.map((item) => [item.id, item]),
) as Record<LandmarkId, LandmarkGuideItem>

function countCompletedRequiredLandmarks(completed?: Partial<Record<LandmarkId, LandmarkPoint>>): number {
  if (!completed) return 0
  return REQUIRED_LANDMARK_IDS.filter((id) => completed[id] !== undefined).length
}

function roundGuidePoint(value: number): number {
  const rounded = Math.round(value * 10) / 10
  return Object.is(rounded, -0) ? 0 : rounded
}

export function mapCharacterLocalPointToGuideFrame(
  point: LandmarkGuidePoint,
  viewport: LandmarkGuideCharacterViewport = LANDMARK_GUIDE_CHARACTER_VIEWPORT,
): LandmarkGuidePoint {
  return {
    x: roundGuidePoint(((viewport.image.offsetX + (point.x / 100) * viewport.image.renderedWidth) / viewport.frame.width) * 100),
    y: roundGuidePoint(((viewport.image.offsetY + (point.y / 100) * viewport.image.renderedHeight) / viewport.frame.height) * 100),
  }
}

export function resolveLandmarkGuideRenderPoints(item: Pick<LandmarkGuideItem, 'visual' | 'guidePosition'>): {
  anchor: LandmarkGuidePoint
  badge: LandmarkGuidePoint
} {
  return {
    anchor: mapCharacterLocalPointToGuideFrame(item.visual?.anchor ?? item.guidePosition),
    badge: mapCharacterLocalPointToGuideFrame(item.visual?.badge ?? item.guidePosition),
  }
}

function resolveLandmarksGuideStatus(completedCount: number, totalCount: number): LandmarkGuideStatus {
  if (completedCount === 0) return 'empty'
  if (completedCount >= totalCount) return 'complete'
  return 'partial'
}

function resolveLandmarksGuideInstruction(status: LandmarkGuideStatus): string {
  if (status === 'complete') return 'All points marked; continue when workflow is ready.'
  if (status === 'partial') return 'Keep placing the remaining landmarks in the 3D viewer.'
  return 'Start by marking points in the 3D viewer.'
}

export function resolveLandmarksGuideModel(input: {
  nodeId: string
  session?: LandmarkGuideSession
}): LandmarksGuideModel {
  const completed = input.session?.nodeId === input.nodeId ? input.session.completed : undefined
  const completedCount = countCompletedRequiredLandmarks(completed)
  const totalCount = LANDMARK_GUIDE_ITEMS.length
  const status = resolveLandmarksGuideStatus(completedCount, totalCount)

  return {
    items: LANDMARK_GUIDE_ITEMS.map((item) => ({
      ...item,
      completed: completed?.[item.id] !== undefined,
    })),
    completedCount,
    totalCount,
    status,
    progressLabel: `${completedCount} of ${totalCount}`,
    instruction: resolveLandmarksGuideInstruction(status),
    error: input.session?.nodeId === input.nodeId ? input.session.error : undefined,
  }
}

export function resolveLandmarksNodePrimaryAction(input: {
  nodeId: string
  canContinue: boolean
  session?: LandmarkGuideSession
}): LandmarksNodePrimaryAction | undefined {
  if (input.session?.nodeId !== input.nodeId) return undefined
  const complete = input.session.canContinue === true && isLandmarkCaptureComplete(Object.values(input.session.completed))
  return {
    kind: 'continue-landmarks',
    nodeId: input.nodeId,
    label: complete ? 'Continue workflow' : 'Finish all landmarks to continue',
    disabled: !complete || !input.canContinue || input.session.sidecarStatus === 'pending-write',
  }
}

export function executeLandmarksNodePrimaryAction(
  action: LandmarksNodePrimaryAction | undefined,
  handlers: { continueRun: (nodeId: string) => void },
): void {
  if (!action || action.disabled) return
  handlers.continueRun(action.nodeId)
}

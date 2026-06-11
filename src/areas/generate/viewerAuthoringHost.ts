export const VIEWER_AUTHORING_HOST_SLOTS = [
  'view-rail',
  'edit-rail',
  'top-right',
  'top-right-stack',
  'bottom-drawer',
] as const

export type ViewerAuthoringHostSlot = (typeof VIEWER_AUTHORING_HOST_SLOTS)[number]

export const VIEWER_AUTHORING_HOST_SLOT_PROPS = {
  'view-rail': 'viewRail',
  'edit-rail': 'editRail',
  'top-right': 'topRight',
  'top-right-stack': 'topRightStack',
  'bottom-drawer': 'bottomDrawer',
} as const satisfies Record<ViewerAuthoringHostSlot, string>

export type ViewerAuthoringHostSlotProp =
  (typeof VIEWER_AUTHORING_HOST_SLOT_PROPS)[ViewerAuthoringHostSlot]

export function getViewerAuthoringHostSlotProp(
  slot: ViewerAuthoringHostSlot,
): ViewerAuthoringHostSlotProp {
  return VIEWER_AUTHORING_HOST_SLOT_PROPS[slot]
}

export const VIEWER_AUTHORING_CONTRIBUTION_IDS = [
  'view-toolbar',
  'transform-toolbar',
] as const

export type ViewerAuthoringContributionId = (typeof VIEWER_AUTHORING_CONTRIBUTION_IDS)[number]

export interface ViewerAuthoringHostContext {
  hasModel: boolean
  meshSelected: boolean
  hasTransformTools: boolean
}

export interface ViewerAuthoringHostContextInput {
  hasModel?: boolean
  meshSelected?: boolean
  hasTransformTools?: boolean
}

export function createViewerAuthoringHostContext(
  input: ViewerAuthoringHostContextInput,
): ViewerAuthoringHostContext {
  return {
    hasModel: input.hasModel ?? false,
    meshSelected: input.meshSelected ?? false,
    hasTransformTools: input.hasTransformTools ?? false,
  }
}

export interface ViewerAuthoringContribution {
  id: ViewerAuthoringContributionId
  slot: ViewerAuthoringHostSlot
  order: number
  label: string
  kind: 'toolbar'
  isVisible: (ctx: ViewerAuthoringHostContext) => boolean
}

export type ResolvedViewerAuthoringContribution = Omit<ViewerAuthoringContribution, 'isVisible'>

const SLOT_ORDER = new Map<ViewerAuthoringHostSlot, number>(
  VIEWER_AUTHORING_HOST_SLOTS.map((slot, index) => [slot, index]),
)

export const DEFAULT_VIEWER_AUTHORING_CONTRIBUTIONS: readonly ViewerAuthoringContribution[] = [
  {
    id: 'view-toolbar',
    slot: 'view-rail',
    order: 10,
    label: 'View toolbar',
    kind: 'toolbar',
    isVisible: (ctx) => ctx.hasModel,
  },
  {
    id: 'transform-toolbar',
    slot: 'edit-rail',
    order: 10,
    label: 'Transform toolbar',
    kind: 'toolbar',
    isVisible: (ctx) => ctx.hasModel && ctx.meshSelected && ctx.hasTransformTools,
  },
]

export function resolveViewerAuthoringContributions(
  contributions: readonly ViewerAuthoringContribution[],
  ctx: ViewerAuthoringHostContext,
): ResolvedViewerAuthoringContribution[] {
  return contributions
    .filter((contribution) => contribution.isVisible(ctx))
    .map(({ isVisible: _isVisible, ...contribution }) => contribution)
    .sort((a, b) => {
      const slotDiff = (SLOT_ORDER.get(a.slot) ?? Number.MAX_SAFE_INTEGER)
        - (SLOT_ORDER.get(b.slot) ?? Number.MAX_SAFE_INTEGER)
      if (slotDiff !== 0) return slotDiff

      const orderDiff = a.order - b.order
      if (orderDiff !== 0) return orderDiff

      return a.id.localeCompare(b.id)
    })
}

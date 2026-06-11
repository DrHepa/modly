import type { ReactNode } from 'react'

import {
  getViewerAuthoringHostSlotProp,
  type ResolvedViewerAuthoringContribution,
  type ViewerAuthoringHostSlotProp,
} from '../viewerAuthoringHost'

export interface ViewerAuthoringHostSlots {
  viewRail?: ReactNode
  editRail?: ReactNode
  topRight?: ReactNode
  topRightStack?: ReactNode
  bottomDrawer?: ReactNode
}

export interface ViewerAuthoringHostProps {
  children: ReactNode
  hasModel: boolean
  contributions: readonly ResolvedViewerAuthoringContribution[]
  slots?: ViewerAuthoringHostSlots
}

export function renderViewerAuthoringHostSlot(
  slots: ViewerAuthoringHostSlots | undefined,
  slotName: ViewerAuthoringHostSlotProp,
): ReactNode {
  return slots?.[slotName] ?? null
}

export function ViewerAuthoringHost({ children, slots }: ViewerAuthoringHostProps): JSX.Element {
  const viewRail = renderViewerAuthoringHostSlot(
    slots,
    getViewerAuthoringHostSlotProp('view-rail'),
  )
  const topRight = renderViewerAuthoringHostSlot(
    slots,
    getViewerAuthoringHostSlotProp('top-right'),
  )
  const topRightStack = renderViewerAuthoringHostSlot(
    slots,
    getViewerAuthoringHostSlotProp('top-right-stack'),
  )
  const bottomDrawer = renderViewerAuthoringHostSlot(
    slots,
    getViewerAuthoringHostSlotProp('bottom-drawer'),
  )

  return (
    <div className="relative w-full h-full bg-surface-400">
      {children}
      {viewRail}
      {topRight || topRightStack ? (
        <div className="absolute top-4 right-4 z-20 flex flex-col items-end gap-2">
          {topRight}
          {topRightStack}
        </div>
      ) : null}
      {bottomDrawer ? <div className="absolute inset-x-4 bottom-4 z-20">{bottomDrawer}</div> : null}
    </div>
  )
}

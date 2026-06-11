import type { ReactNode } from 'react'

import type { ResolvedViewerAuthoringContribution } from '../viewerAuthoringHost'

export interface ViewerAuthoringHostSlots {
  viewRail?: ReactNode
  editRail?: ReactNode
}

export interface ViewerAuthoringHostProps {
  children: ReactNode
  hasModel: boolean
  contributions: readonly ResolvedViewerAuthoringContribution[]
  slots?: ViewerAuthoringHostSlots
}

export function renderViewerAuthoringHostSlot(
  slots: ViewerAuthoringHostSlots | undefined,
  slotName: keyof ViewerAuthoringHostSlots,
): ReactNode {
  return slots?.[slotName] ?? null
}

export function ViewerAuthoringHost({ children, slots }: ViewerAuthoringHostProps): JSX.Element {
  return (
    <div className="relative w-full h-full bg-surface-400">
      {children}
      {renderViewerAuthoringHostSlot(slots, 'viewRail')}
    </div>
  )
}

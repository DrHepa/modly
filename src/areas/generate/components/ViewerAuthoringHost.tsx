import type { ReactNode } from 'react'

import type { ResolvedViewerAuthoringContribution } from '../viewerAuthoringHost'

export interface ViewerAuthoringHostSlots {
  viewRail?: ReactNode
}

export interface ViewerAuthoringHostProps {
  children: ReactNode
  hasModel: boolean
  contributions: readonly ResolvedViewerAuthoringContribution[]
  slots?: ViewerAuthoringHostSlots
}

export function ViewerAuthoringHost({ children, slots }: ViewerAuthoringHostProps): JSX.Element {
  return (
    <div className="relative w-full h-full bg-surface-400">
      {children}
      {slots?.viewRail}
    </div>
  )
}

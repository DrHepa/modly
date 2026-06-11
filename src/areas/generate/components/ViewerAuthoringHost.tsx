import type { ReactNode } from 'react'

import type { ResolvedViewerAuthoringContribution } from '../viewerAuthoringHost'

export interface ViewerAuthoringHostProps {
  children: ReactNode
  hasModel: boolean
  contributions: readonly ResolvedViewerAuthoringContribution[]
}

export function ViewerAuthoringHost({ children }: ViewerAuthoringHostProps): JSX.Element {
  return <>{children}</>
}

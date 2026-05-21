import { Handle, Position } from '@xyflow/react'
import { useCallback } from 'react'
import type { WFNodeData } from '@shared/types/electron.d'
import BaseNode from './BaseNode'
import { LandmarksNodeGuide } from './LandmarksNodeGuide'
import { useWorkflowRunStore } from '../workflowRunStore'
import type { LandmarkCaptureState } from '../landmarks'
import {
  executeLandmarksNodePrimaryAction,
  resolveLandmarksGuideModel,
  resolveLandmarksNodePrimaryAction,
  type LandmarksGuideModel,
  type LandmarksNodePrimaryAction,
} from '../landmarkGuideModel'

const HANDLE_STYLE = { background: '#22c55e', width: 14, height: 14, border: '2.5px solid #18181b' }

export type LandmarksNodeContentProps = {
  completedCount?: number
  totalCount?: number
  guide?: LandmarksGuideModel
  primaryAction?: LandmarksNodePrimaryAction
  onPrimaryAction?: () => void
}

export function resolveLandmarksNodeProgress(input: {
  nodeId: string
  session?: Pick<LandmarkCaptureState, 'nodeId' | 'completed'>
}): Pick<LandmarksNodeContentProps, 'completedCount' | 'totalCount'> {
  const guide = resolveLandmarksGuideModel({ nodeId: input.nodeId, session: input.session })

  return {
    completedCount: guide.completedCount,
    totalCount: guide.totalCount,
  }
}

export function LandmarksNodeContent({ completedCount = 0, totalCount = 5, guide, primaryAction, onPrimaryAction }: LandmarksNodeContentProps) {
  const resolvedGuide = guide ?? resolveLandmarksGuideModel({ nodeId: 'landmarks-node-content-preview', session: { nodeId: 'landmarks-node-content-preview', completed: {}, canContinue: false } })
  const displayGuide = guide ? resolvedGuide : { ...resolvedGuide, completedCount, totalCount, progressLabel: `${completedCount} of ${totalCount}` }
  return <LandmarksNodeGuide guide={displayGuide} primaryAction={primaryAction} onPrimaryAction={onPrimaryAction} />
}

export default function LandmarksNode({ id, data, selected }: { id: string; data: WFNodeData; selected?: boolean }) {
  const runState = useWorkflowRunStore((state) => state.runState)
  const activeNodeId = useWorkflowRunStore((state) => state.activeNodeId)
  const landmarkSession = useWorkflowRunStore((state) => state.landmarkSession)
  const continueRun = useWorkflowRunStore((state) => state.continueRun)
  const session = landmarkSession?.nodeId === id ? landmarkSession : undefined
  const guide = resolveLandmarksGuideModel({ nodeId: id, session })
  const primaryAction = resolveLandmarksNodePrimaryAction({ nodeId: id, activeNodeId, runState, session })
  const handlePrimaryAction = useCallback(() => {
    executeLandmarksNodePrimaryAction(primaryAction, { continueRun })
  }, [continueRun, primaryAction])

  return (
    <BaseNode
      id={id}
      selected={selected}
      title="Landmarks"
      minWidth={185}
      showInGenerate={data.showInGenerate ?? false}
      icon={
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2">
          <path d="M12 3v18"/>
          <path d="M3 12h18"/>
          <circle cx="12" cy="12" r="3"/>
          <circle cx="6" cy="6" r="2"/>
          <circle cx="18" cy="6" r="2"/>
          <circle cx="8" cy="18" r="2"/>
          <circle cx="16" cy="18" r="2"/>
        </svg>
      }
      handles={
        <>
          <Handle type="target" position={Position.Left}  style={HANDLE_STYLE} />
          <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
        </>
      }
    >
      <LandmarksNodeContent guide={guide} primaryAction={primaryAction} onPrimaryAction={handlePrimaryAction} />
    </BaseNode>
  )
}

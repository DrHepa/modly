import { useCallback } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { ArtifactRef, WFNodeData } from '@shared/types/electron.d'
import type { ArtifactReplacementReason } from '@shared/types/artifacts'
import { useWorkflowRunStore, type WorkflowRunState } from '../workflowRunStore'
import { resolveArtifactReplacement } from '../workflowArtifacts'
import BaseNode from './BaseNode'

const HANDLE_STYLE = { background: '#71717a', width: 14, height: 14, border: '2.5px solid #18181b' }

type WaitCheckpointUiStateInput = {
  nodeId: string
  activeNodeId: string | null
  runState: WorkflowRunState
  pendingReplacement?: ArtifactRef
}

type WaitCheckpointUiState = {
  isPaused: boolean
  isCheckpoint: boolean
  statusLabel: string
  description: string
  normalContinueLabel: string
  showSubstitutedContinue: boolean
  substitutedContinueLabel?: string
  rejectionCopy?: string
}

const REPLACEMENT_REASON_COPY: Record<ArtifactReplacementReason, string> = {
  kind_not_allowed: 'Replacement not used: this checkpoint does not accept that artifact type.',
  legacy_unavailable: 'Replacement not used: it cannot be passed to the next workflow step.',
  stale_checkpoint: 'Replacement not used: this checkpoint is no longer active.',
  no_replacement: 'No replacement selected; the original checkpoint artifact was used.',
}

function artifactCheckpointLabel(artifact: ArtifactRef | undefined): string | undefined {
  if (!artifact) return undefined
  const pathOrText = artifact.legacy?.filePath ?? artifact.uri ?? artifact.legacy?.text ?? artifact.text
  const name = pathOrText?.split(/[\\/]/).pop()
  return name ? `${artifact.kind} · ${name}` : artifact.kind
}

function replacementReasonCopy(runState: WorkflowRunState): string | undefined {
  const result = runState.replacementResult
  if (!result || result.status === 'accepted') return undefined
  return REPLACEMENT_REASON_COPY[result.reason]
}

export function resolveWaitCheckpointUiState(input: WaitCheckpointUiStateInput): WaitCheckpointUiState {
  const isPaused = input.runState.status === 'paused' && input.activeNodeId === input.nodeId
  const substitutionPoint = isPaused && input.runState.substitutionPoint?.nodeId === input.nodeId
    ? input.runState.substitutionPoint
    : undefined
  const artifactLabel = artifactCheckpointLabel(input.runState.artifact ?? substitutionPoint?.inputArtifact)
  const replacementResult = substitutionPoint && input.pendingReplacement
    ? resolveArtifactReplacement(substitutionPoint, input.pendingReplacement, { currentNodeId: input.nodeId })
    : undefined
  const showSubstitutedContinue = replacementResult?.status === 'accepted'

  if (!isPaused) {
    return {
      isPaused,
      isCheckpoint: false,
      statusLabel: 'Waiting',
      description: 'Pauses the workflow until you click Continue.',
      normalContinueLabel: 'Continue',
      showSubstitutedContinue: false,
      rejectionCopy: replacementReasonCopy(input.runState),
    }
  }

  if (!substitutionPoint) {
    return {
      isPaused,
      isCheckpoint: false,
      statusLabel: 'Paused',
      description: 'Workflow paused — click Continue to resume.',
      normalContinueLabel: 'Continue',
      showSubstitutedContinue: false,
      rejectionCopy: replacementReasonCopy(input.runState),
    }
  }

  return {
    isPaused,
    isCheckpoint: true,
    statusLabel: 'Temporary checkpoint',
    description: `Temporary checkpoint${artifactLabel ? `: ${artifactLabel}` : ''}. This preview is not the final output.`,
    normalContinueLabel: 'Continue',
    showSubstitutedContinue,
    ...(showSubstitutedContinue ? { substitutedContinueLabel: 'Continue with replacement' } : {}),
    rejectionCopy: replacementReasonCopy(input.runState),
  }
}

export default function WaitNode({ id, data, selected }: { id: string; data: WFNodeData; selected?: boolean }) {
  const runState              = useWorkflowRunStore((s) => s.runState)
  const activeNodeId          = useWorkflowRunStore((s) => s.activeNodeId)
  const continueRun           = useWorkflowRunStore((s) => s.continueRun)
  const getPendingReplacement = useWorkflowRunStore((s) => s.getPendingReplacement)
  const pendingReplacement    = getPendingReplacement()
  const checkpointUi          = resolveWaitCheckpointUiState({ nodeId: id, activeNodeId, runState, pendingReplacement })

  const handleContinue = useCallback(() => {
    continueRun()
  }, [continueRun])

  const handleContinueWithReplacement = useCallback(() => {
    if (!pendingReplacement) return
    continueRun({ replacementArtifact: pendingReplacement })
  }, [continueRun, pendingReplacement])

  return (
    <BaseNode
      id={id}
      selected={selected}
      title="Wait"
      minWidth={170}
      showInGenerate={data.showInGenerate ?? false}
      icon={
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#71717a" strokeWidth="2">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
      }
      subheader={checkpointUi.isPaused ? (
        <div className="nodrag flex flex-col border-y border-amber-500/30 bg-amber-500/10">
          <button
            onClick={handleContinue}
            className="w-full flex items-center justify-center gap-1.5 px-2.5 py-2 text-amber-400 hover:bg-amber-500/20 transition-colors text-[10px] font-medium animate-pulse"
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            {checkpointUi.normalContinueLabel}
          </button>
          {checkpointUi.showSubstitutedContinue && (
            <button
              onClick={handleContinueWithReplacement}
              className="w-full px-2.5 py-1.5 border-t border-amber-500/20 text-[10px] font-medium text-violet-200 hover:bg-violet-500/15 transition-colors"
            >
              {checkpointUi.substitutedContinueLabel}
            </button>
          )}
        </div>
      ) : undefined}
      handles={
        <>
          <Handle type="target" position={Position.Left}  style={HANDLE_STYLE} />
          <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
        </>
      }
    >
      <div className="px-3 pb-3 pt-2.5">
        {checkpointUi.isPaused && checkpointUi.isCheckpoint && (
          <p className="mb-1 text-[9px] uppercase tracking-wide text-amber-300 font-semibold">
            {checkpointUi.statusLabel}
          </p>
        )}
        <p className="text-[10px] text-zinc-500 italic">
          {checkpointUi.description}
        </p>
        {checkpointUi.rejectionCopy && (
          <p className="mt-1.5 text-[10px] text-zinc-400">
            {checkpointUi.rejectionCopy}
          </p>
        )}
      </div>
    </BaseNode>
  )
}

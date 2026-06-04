import { useCallback } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { ArtifactRef, WFNodeData } from '@shared/types/electron.d'
import type { ArtifactReplacementReason } from '@shared/types/artifacts'
import { useWorkflowRunStore, type WorkflowCheckpoint, type WaitState } from '../workflowRunStore'
import { resolveArtifactReplacement, sameCheckpointOwner } from '../workflowArtifacts'
import { useWaitButton } from '../useWaitButton'
import BaseNode from './BaseNode'

const HANDLE_STYLE = { background: '#71717a', width: 14, height: 14, border: '2.5px solid #18181b' }

type WaitCheckpointUiStateInput = {
  nodeId: string
  checkpoint?: WorkflowCheckpoint
  waitState?: WaitState
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
  humanoidHeadline?: string
  humanoidDiagnostics: string[]
  humanoidReviewHint?: string
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

function replacementReasonCopy(checkpoint?: WorkflowCheckpoint): string | undefined {
  const result = checkpoint?.replacementResult
  if (!result || result.status === 'accepted') return undefined
  return REPLACEMENT_REASON_COPY[result.reason]
}

export function resolveWaitCheckpointUiState(input: WaitCheckpointUiStateInput): WaitCheckpointUiState {
  const checkpoint = input.checkpoint?.owner.nodeId === input.nodeId ? input.checkpoint : undefined
  const isPaused = input.waitState === 'pending'
  const substitutionPoint = checkpoint?.substitutionPoint
  const artifactLabel = artifactCheckpointLabel(substitutionPoint?.inputArtifact)
  const replacementResult = substitutionPoint && checkpoint?.pendingReplacement
    ? resolveArtifactReplacement(substitutionPoint, checkpoint.pendingReplacement, { currentNodeId: input.nodeId })
    : undefined
  const showSubstitutedContinue = replacementResult?.status === 'accepted'

  if (!isPaused) {
    return {
      isPaused,
      isCheckpoint: false,
      statusLabel: 'Waiting',
      description: 'Pauses the workflow until you click Continue.',
      normalContinueLabel: 'Continue',
      showSubstitutedContinue,
      ...(showSubstitutedContinue ? { substitutedContinueLabel: 'Continue with replacement' } : {}),
      rejectionCopy: replacementReasonCopy(checkpoint),
      humanoidDiagnostics: [],
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
      rejectionCopy: replacementReasonCopy(checkpoint),
      humanoidDiagnostics: [],
    }
  }

  const review = checkpoint?.humanoidReview
  const humanoidReview = review && sameCheckpointOwner(review.owner, checkpoint.owner) ? review.state : undefined

  return {
    isPaused,
    isCheckpoint: true,
    statusLabel: 'Temporary checkpoint',
    description: `Temporary checkpoint${artifactLabel ? `: ${artifactLabel}` : ''}. This preview is not the final output.`,
    normalContinueLabel: humanoidReview?.continueLabel ?? 'Continue',
    showSubstitutedContinue,
    ...(showSubstitutedContinue ? { substitutedContinueLabel: 'Continue with replacement' } : {}),
    rejectionCopy: replacementReasonCopy(checkpoint),
    humanoidHeadline: humanoidReview?.headline,
    humanoidDiagnostics: humanoidReview?.diagnostics ?? [],
    humanoidReviewHint: humanoidReview?.reviewHint,
  }
}

export default function WaitNode({ id, data, selected }: { id: string; data: WFNodeData; selected?: boolean }) {
  const { waitState, canContinue, isRunning, label, buttonClass, statusText, onContinue } = useWaitButton(id)
  const checkpoint = useWorkflowRunStore((s) => s.checkpoints[id])
  const continueRun = useWorkflowRunStore((s) => s.continueRun)
  const selectCheckpoint = useWorkflowRunStore((s) => s.selectCheckpoint)
  const checkpointUi = resolveWaitCheckpointUiState({ nodeId: id, checkpoint, waitState })
  const handleContinueWithReplacement = useCallback(() => {
    if (!canContinue || !checkpoint?.pendingReplacement) return
    void continueRun(id, { owner: checkpoint.owner, replacementArtifact: checkpoint.pendingReplacement })
  }, [id, canContinue, continueRun, checkpoint])

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
      subheader={waitState ? (
        <div className="nodrag flex flex-col">
          <button
            onClick={onContinue}
            disabled={!canContinue}
            className={`w-full flex items-center justify-center gap-1.5 px-2.5 py-2 border-y transition-colors text-[10px] font-medium ${buttonClass} ${canContinue ? (waitState === 'pending' ? 'animate-pulse' : '') : 'opacity-40 cursor-not-allowed'}`}
          >
            {isRunning ? (
              <>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="animate-spin">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                Running…
              </>
            ) : (
              <>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                {waitState === 'pending' ? checkpointUi.normalContinueLabel : label}
              </>
            )}
          </button>
          {checkpointUi.showSubstitutedContinue && (
            <button
              onClick={handleContinueWithReplacement}
              disabled={!canContinue}
              className="w-full px-2.5 py-1.5 border-t border-amber-500/20 text-[10px] font-medium text-violet-200 hover:bg-violet-500/15 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {checkpointUi.substitutedContinueLabel}
            </button>
          )}
          {checkpoint && (
            <button type="button" disabled={!canContinue} onClick={() => selectCheckpoint(checkpoint.owner)} className="px-2.5 py-1.5 text-[10px] text-zinc-400 disabled:opacity-40">
              Show checkpoint
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
          {checkpointUi.isCheckpoint && checkpointUi.isPaused ? checkpointUi.description : statusText}
        </p>
        {checkpointUi.humanoidHeadline && (
          <p className="mt-1.5 text-[10px] font-medium text-cyan-200">
            {checkpointUi.humanoidHeadline}
          </p>
        )}
        {checkpointUi.humanoidReviewHint && (
          <p className="mt-1 text-[10px] text-zinc-400">
            {checkpointUi.humanoidReviewHint}
          </p>
        )}
        {checkpointUi.humanoidDiagnostics.map((diagnostic) => (
          <p key={diagnostic} className="mt-1 text-[10px] text-zinc-400">
            {diagnostic}
          </p>
        ))}
        {checkpointUi.rejectionCopy && (
          <p className="mt-1.5 text-[10px] text-zinc-400">
            {checkpointUi.rejectionCopy}
          </p>
        )}
      </div>
    </BaseNode>
  )
}

import type { WorldsCliStatus, WorldsCliCompleteReview, WorldsCliPendingSummary } from '../../../shared/types/worldProjects.ts'

/** A displayed one-time code is valid only while this exact challenge remains pending. */
export function retainWorldsCliPairing<T extends { pairingId: string }>(pairing: T | null, status: WorldsCliStatus): T | null {
  return pairing && status.running && status.pairingPending && status.pairingId === pairing.pairingId ? pairing : null
}

type PollTicket = { generation: number; sequence: number }

/** Reject old poll responses after a newer poll or a local pairing/revoke action. */
export class WorldsCliStatusOrder {
  private generation = 0
  private nextSequence = 0
  private appliedSequence = 0

  beginPoll(): PollTicket { return { generation: this.generation, sequence: ++this.nextSequence } }
  accept(ticket: PollTicket): boolean {
    if (ticket.generation !== this.generation || ticket.sequence <= this.appliedSequence) return false
    this.appliedSequence = ticket.sequence
    return true
  }
  invalidate(): number { this.generation++; this.appliedSequence = 0; return this.generation }
  isCurrentGeneration(generation: number): boolean { return generation === this.generation }
}

type ReviewTicket = { generation: number; sequence: number }

/** Every drawer/scope transition clears busy immediately; old request completions cannot modify the next scope. */
export class WorldsCliReviewRequestOrder {
  private generation = 0
  private sequence = 0

  begin(setBusy: (busy: boolean) => void): ReviewTicket {
    setBusy(true)
    return { generation: this.generation, sequence: ++this.sequence }
  }
  invalidate(setBusy?: (busy: boolean) => void): number {
    this.generation++
    this.sequence = 0
    setBusy?.(false)
    return this.generation
  }
  isCurrentGeneration(generation: number): boolean { return generation === this.generation }
  currentGeneration(): number { return this.generation }
  isCurrent(ticket: ReviewTicket): boolean { return ticket.generation === this.generation && ticket.sequence === this.sequence }
  finish(ticket: ReviewTicket, setBusy: (busy: boolean) => void): void { if (this.isCurrent(ticket)) setBusy(false) }
}

export interface WorldsCliActionOutcome {
  transactionId: string
  projectKey: string
  projectId: string
  sceneId: string
  baseRevision: number
  resultingRevision: number
  message: string
}

/** A persisted result remains visible across its own revision advance, not later edits or scope switches. */
export function retainWorldsCliActionOutcome<T extends WorldsCliActionOutcome>(
  outcome: T | null,
  scope: { projectKey: string; projectId: string; sceneId: string; revision: number },
): T | null {
  return outcome && outcome.projectKey === scope.projectKey && outcome.projectId === scope.projectId
    && outcome.sceneId === scope.sceneId && (scope.revision === outcome.baseRevision || scope.revision === outcome.resultingRevision)
    ? outcome : null
}

export function retainLiveWorldsCliReview<T extends { proposalId: string; revision: number; digest: string; expiresAt: number }>(
  review: T | null, pending: ReadonlyArray<{ proposalId: string; revision: number; digest: string; expiresAt: number }>, now: number,
): T | null {
  return review && now < review.expiresAt && pending.some((item) => item.proposalId === review.proposalId
    && item.revision === review.revision && item.digest === review.digest && item.expiresAt === review.expiresAt) ? review : null
}

export function isCompleteCurrentWorldsCliReview(
  review: (WorldsCliPendingSummary & { reviewId: string; review: WorldsCliCompleteReview }) | null,
  pending: readonly WorldsCliPendingSummary[],
  scope: { projectKey: string; projectId: string; sceneId: string; revision: number },
  now: number,
): boolean {
  if (!review || review.projectKey !== scope.projectKey || review.projectId !== scope.projectId
    || review.sceneId !== scope.sceneId || review.revision !== scope.revision || now >= review.expiresAt
    || !review.review.complete || review.commandCount < 1 || review.changeCount < 1
    || review.review.changes.length !== review.changeCount || review.review.warnings.length !== review.warningCount
    || !review.review.changes.every((change) => typeof change.field === 'string'
      && (change.before === null || typeof change.before === 'string')
      && (change.after === null || typeof change.after === 'string'))
    || !review.review.warnings.every((warning) => typeof warning === 'string')) return false
  return pending.some((item) => item.proposalId === review.proposalId && item.projectKey === scope.projectKey
    && item.projectId === scope.projectId && item.sceneId === scope.sceneId && item.revision === scope.revision
    && item.digest === review.digest && item.expiresAt === review.expiresAt && item.commandCount === review.commandCount
    && item.changeCount === review.changeCount && item.warningCount === review.warningCount)
}

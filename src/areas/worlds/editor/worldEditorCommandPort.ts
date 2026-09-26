import type { WorldCommandBatchV1 } from '../core/worldCommands.ts'
import type { WorldProjectSnapshotV1 } from '../core/worldModel.ts'
import type { WorldAiContext, WorldAiProposal } from '../core/worldAiContract.ts'
import {
  worldEditorController,
  type WorldEditorController,
  type WorldEditorControllerResult,
  type WorldEditorControllerState,
  type WorldEditorDispatchAuthority,
  type WorldEditorDispatchRequest,
  type WorldEditorDispatchSuccess,
  type WorldEditorProposalPreview,
  type WorldEditorProposalGuard,
} from './worldEditorController.ts'

export interface WorldEditorActiveContext {
  projectKey: string
  projectId: string
  baseRevision: number
  activeSceneId: string
  snapshot: WorldProjectSnapshotV1
}

export interface WorldEditorCommandPort {
  previewAiProposal?(proposal: WorldAiProposal, guard: WorldEditorProposalGuard): Promise<WorldEditorControllerResult<WorldEditorProposalPreview>>
  discardAiProposal?(authority: string, context: WorldAiContext): Promise<void>
  getState(): WorldEditorControllerState
  getActiveContext(): WorldEditorActiveContext | null
  subscribe(listener: (state: WorldEditorControllerState) => void): () => void
  dispatchCommands(request: WorldEditorDispatchRequest, expectedAuthority?: WorldEditorDispatchAuthority): Promise<WorldEditorControllerResult<WorldEditorDispatchSuccess>>
  previewProposal(request: WorldEditorDispatchRequest, guard?: WorldEditorProposalGuard): Promise<WorldEditorControllerResult<WorldEditorProposalPreview>>
  applyProposalExact(batch: WorldCommandBatchV1, guard?: WorldEditorProposalGuard, aiAuthority?: string): Promise<WorldEditorControllerResult<WorldEditorDispatchSuccess>>
  undo(guard?: WorldEditorProposalGuard): Promise<WorldEditorControllerResult<WorldEditorDispatchSuccess>>
  redo(): Promise<WorldEditorControllerResult<WorldEditorDispatchSuccess>>
}

export function createWorldEditorCommandPort(controller: WorldEditorController): WorldEditorCommandPort {
  return Object.freeze({
    previewAiProposal: (proposal: WorldAiProposal, guard: WorldEditorProposalGuard) => controller.previewAiProposal(proposal, guard),
    discardAiProposal: (authority: string, context: WorldAiContext) => controller.discardAiProposal(authority, context),
    getState: () => controller.getState(),
    getActiveContext: () => {
      const state = controller.getState()
      if (!state.projectKey || !state.session || !state.activeSceneId) return null
      return Object.freeze({
        projectKey: state.projectKey,
        projectId: state.session.snapshot.project.projectId,
        baseRevision: state.session.snapshot.project.revision,
        activeSceneId: state.activeSceneId,
        snapshot: state.session.snapshot,
      })
    },
    subscribe: (listener: (state: WorldEditorControllerState) => void) => controller.subscribe(listener),
    dispatchCommands: (request: WorldEditorDispatchRequest, expectedAuthority?: WorldEditorDispatchAuthority) => controller.dispatchCommands(request, expectedAuthority),
    previewProposal: (request: WorldEditorDispatchRequest, guard?: WorldEditorProposalGuard) => controller.previewProposal(request, guard),
    applyProposalExact: (batch: WorldCommandBatchV1, guard?: WorldEditorProposalGuard, aiAuthority?: string) => controller.applyProposalExact(batch, guard, aiAuthority),
    undo: (guard?: WorldEditorProposalGuard) => controller.undo(guard),
    redo: () => controller.redo(),
  })
}

export const worldEditorCommandPort: WorldEditorCommandPort = createWorldEditorCommandPort(worldEditorController)

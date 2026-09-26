import type { WorldProjectSnapshotV1 } from '../core/worldModel.ts'
import type { WorldEditorViewportCommitLease } from './useWorldEditorProjectionBridge.ts'

export interface WorldEditorTransformGesture {
  readonly gestureId: string
  readonly projectKey: string
  readonly projectId: string
  readonly sceneId: string
  readonly baseRevision: number
  readonly entityIds: readonly string[]
  readonly snapshot: WorldProjectSnapshotV1
  readonly viewportLease: WorldEditorViewportCommitLease
}

export interface WorldEditorTransformAdmission {
  begin(kind: 'viewport' | 'inspector', entityIds: readonly string[]): WorldEditorTransformGesture | null
  release(gesture: WorldEditorTransformGesture): boolean
  cancel(gesture: WorldEditorTransformGesture): void
  finish(gesture: WorldEditorTransformGesture): void
  invalidateActive(): void
  isCurrent(gesture: WorldEditorTransformGesture): boolean
  readonly pending: boolean
}

export interface WorldEditorTransformAdmissionContext {
  readonly projectKey: string | null
  readonly activeSceneId: string | null
  readonly snapshot: WorldProjectSnapshotV1 | null
}

export function createWorldEditorTransformAdmission(options: {
  getContext(): WorldEditorTransformAdmissionContext
  getViewportLease(): WorldEditorViewportCommitLease
  isViewportCurrent(lease: WorldEditorViewportCommitLease): boolean
  onError(message: string): void
  onPendingChange(pending: boolean): void
}): WorldEditorTransformAdmission {
  let active: WorldEditorTransformGesture | null = null
  let pending: WorldEditorTransformGesture | null = null
  let sequence = 0

  return {
    begin(kind, entityIds) {
      if (active || pending) {
        options.onError('Wait for the current transform to finish.')
        return null
      }
      const context = options.getContext()
      const lease = options.getViewportLease()
      if (!context.projectKey || !context.snapshot || !context.activeSceneId || !options.isViewportCurrent(lease)) {
        options.onError('Transform is not available in the current viewport.')
        return null
      }
      active = Object.freeze({
        gestureId: `transform:${kind}:${sequence += 1}`,
        projectKey: context.projectKey,
        projectId: context.snapshot.project.projectId,
        sceneId: context.activeSceneId,
        baseRevision: context.snapshot.project.revision,
        entityIds: [...entityIds],
        snapshot: context.snapshot,
        viewportLease: lease,
      })
      return active
    },
    release(gesture) {
      if (active !== gesture) return false
      active = null
      pending = gesture
      options.onPendingChange(true)
      return true
    },
    cancel(gesture) {
      if (active === gesture) active = null
    },
    finish(gesture) {
      if (pending === gesture) {
        pending = null
        options.onPendingChange(false)
      }
    },
    invalidateActive() {
      active = null
    },
    isCurrent(gesture) {
      return active === gesture || pending === gesture
    },
    get pending() {
      return pending !== null
    },
  }
}

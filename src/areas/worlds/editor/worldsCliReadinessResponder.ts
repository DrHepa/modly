import type {
  WorldsCliDirectEditReadinessRequest,
  WorldsCliDirectEditReadinessResponse,
} from '../../../shared/types/worldProjects.ts'

export interface WorldsCliReadinessView {
  mounted: boolean
  playLifecycle: string
  editorLifecycle: string
  projectKey: string | null
  projectId: string | null
  sceneId: string | null
  revision: number | null
  editorEpoch: number
}

type ReadinessCli = {
  onDirectEditReadinessRequest(callback: (request: WorldsCliDirectEditReadinessRequest) => void): () => void
  respondDirectEditReadiness(value: WorldsCliDirectEditReadinessResponse): Promise<{ ok: boolean }>
  cancelDirectEditReadiness(value: { nonce: string; intentId: string }): Promise<{ ok: boolean }>
}

type ActiveReadiness = Pick<WorldsCliDirectEditReadinessRequest, 'nonce' | 'intentId'> & {
  request: WorldsCliDirectEditReadinessRequest
}
type ReadinessRefusal = Extract<WorldsCliDirectEditReadinessResponse, { status: 'REFUSED' }>['reason']

/** Nonvisual TOCTOU response only. This helper has no command or repository API. */
export function createWorldsCliReadinessResponder(options: {
  cli: ReadinessCli
  readView(): WorldsCliReadinessView
  subscribeEditor(listener: () => void): () => void
  subscribePlay(listener: () => void): () => void
  now?: () => number
}): { dispose(): void } {
  const now = options.now ?? Date.now
  let active: ActiveReadiness | null = null
  let disposed = false

  const cancelActive = (): void => {
    const current = active
    if (!current) return
    active = null
    void options.cli.cancelDirectEditReadiness({ nonce: current.nonce, intentId: current.intentId }).catch(() => undefined)
  }
  const invalidate = (): void => {
    if (active && readinessRefusal(active.request, options.readView(), now()) !== null) cancelActive()
  }
  const unsubscribeEditor = options.subscribeEditor(invalidate)
  const unsubscribePlay = options.subscribePlay(invalidate)
  const unsubscribeRequest = options.cli.onDirectEditReadinessRequest((request) => {
    if (disposed) return
    const refusal = active ? 'busy' : readinessRefusal(request, options.readView(), now())
    const response: WorldsCliDirectEditReadinessResponse = refusal === null
      ? { nonce: request.nonce, intentId: request.intentId, status: 'READY' }
      : { nonce: request.nonce, intentId: request.intentId, status: 'REFUSED', reason: refusal }
    if (refusal !== null) {
      void options.cli.respondDirectEditReadiness(response).catch(() => undefined)
      return
    }
    const claimed = { nonce: request.nonce, intentId: request.intentId, request }
    active = claimed
    void options.cli.respondDirectEditReadiness(response).catch(() => undefined).finally(() => {
      if (active === claimed) active = null
    })
  })

  return { dispose() {
    if (disposed) return
    disposed = true
    unsubscribeRequest()
    unsubscribeEditor()
    unsubscribePlay()
    cancelActive()
  } }
}

function readinessRefusal(
  request: WorldsCliDirectEditReadinessRequest,
  view: WorldsCliReadinessView,
  now: number,
): ReadinessRefusal | null {
  if (now >= request.expiresAt) return 'expired'
  if (!view.mounted || !view.projectKey || !view.projectId || !view.sceneId || view.revision === null) return 'unmounted'
  if (view.playLifecycle !== 'edit') return 'play_active'
  if (view.editorLifecycle !== 'ready') return 'editor_not_ready'
  if (view.projectKey !== request.projectKey || view.projectId !== request.projectId || view.sceneId !== request.sceneId
    || view.revision !== request.baseRevision || view.editorEpoch !== request.editorEpoch) return 'scope_mismatch'
  return null
}

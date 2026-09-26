import { hasWorldAiRecipes, parseWorldAiContext, parseWorldAiProposal, sameWorldAiContext, validateWorldAiCommands, WORLD_AI_CONTEXT_SCHEMA, type WorldAiContext, type WorldAiProposal } from '../core/worldAiContract.ts'
import { createWorldAiCommandBridge, type WorldAiBridgeErrorCode, type WorldAiProposalPreview } from './worldAiCommandBridge.ts'
import type { WorldEditorCommandPort } from './worldEditorCommandPort.ts'
import type { WorldEditorProposalGuard } from './worldEditorController.ts'

export interface WorldAiChatTurn {
  context: WorldAiContext
  guard: WorldEditorProposalGuard
  /** Original request preflight only; applying and undoing have separate revision lifetimes. */
  isRequestCurrent(): boolean
}
export interface WorldAiChatState {
  status: 'idle' | 'loading' | 'previewing' | 'ready' | 'applying' | 'applied' | 'undoing' | 'rejected' | 'stale' | 'error'
  message: string
  preview?: WorldAiProposalPreview
  errorCode?: WorldAiBridgeErrorCode
}
export interface WorldAiChatResponse { message: string; thinking?: string; actions: []; proposals: []; worldProposals: WorldAiProposal[] }
export interface WorldAiChatAdapter {
  begin(input: { originSessionId: string; requestId: string; isCurrent(): boolean }): WorldAiChatTurn
  accept(turn: WorldAiChatTurn, response: unknown): Promise<void>
  fail(turn: WorldAiChatTurn, reason?: WorldAiRequestFailureReason): void
  apply(): Promise<void>
  reject(): void
  undo(): Promise<void>
  cancel(): void
  getState(): WorldAiChatState
  subscribe(listener: () => void): () => void
  dispose(): void
}
export type WorldAiRequestFailureReason = 'transport' | 'http' | 'invalid_response' | 'unknown'
export type WorldAiProvider = 'ollama' | 'openai'

class WorldAiRequestError extends Error {
  readonly reason: WorldAiRequestFailureReason
  readonly status?: number
  constructor(reason: WorldAiRequestFailureReason, status?: number) {
    super(worldAiRequestFailureMessage(reason))
    this.name = 'WorldAiRequestError'
    this.reason = reason
    this.status = status
  }
}

export function classifyWorldAiRequestFailure(error: unknown): WorldAiRequestFailureReason {
  if (error instanceof WorldAiRequestError) return error.reason
  if (error instanceof DOMException && error.name === 'AbortError') return 'unknown'
  return 'unknown'
}

export function worldAiRequestFailureMessage(reason: WorldAiRequestFailureReason): string {
  switch (reason) {
    case 'transport': return 'Cannot reach Modly API. Is the backend running?'
    case 'http': return 'Worlds AI reached Modly API, but the request could not complete.'
    case 'invalid_response': return 'Worlds AI returned an invalid response. No changes were made.'
    default: return 'Worlds AI request could not complete. Try again.'
  }
}

/** A separate decoder prevents legacy response actions from reaching generic chat execution. */
export function parseWorldAiChatResponse(value: unknown): WorldAiChatResponse {
  const invalid = () => { throw new Error('Worlds returned an invalid response. No changes were made.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const body = value as Record<string, unknown>
  if (new TextEncoder().encode(JSON.stringify(body)).length > 64 * 1024
    || Object.keys(body).some((key) => !['message', 'thinking', 'actions', 'proposals', 'worldProposals'].includes(key))
    || typeof body.message !== 'string' || (body.thinking !== undefined && body.thinking !== null && typeof body.thinking !== 'string')
    || !Array.isArray(body.actions) || body.actions.length || !Array.isArray(body.proposals) || body.proposals.length
    || !Array.isArray(body.worldProposals) || body.worldProposals.length > 1) return invalid()
  return { message: body.message, ...(typeof body.thinking === 'string' ? { thinking: body.thinking } : {}),
    actions: [], proposals: [], worldProposals: body.worldProposals.map(parseWorldAiProposal) }
}

/** Called by the real ChatPanel. Only this user message and the captured IDs enter the Worlds request. */
export async function requestWorldAiChat(input: {
  apiUrl: string; model: string; ollamaUrl: string; thinking: string; turn: WorldAiChatTurn
  provider?: WorldAiProvider; openaiModel?: string
  message: { role: string; content: string; images?: string[] }; signal: AbortSignal
  fetch: typeof fetch
}): Promise<WorldAiChatResponse> {
  if (!input.turn.isRequestCurrent() || input.signal.aborted || input.message.role !== 'user') throw new Error('The Worlds request is no longer current.')
  let response: Response
  try {
    response = await input.fetch.call(globalThis, `${input.apiUrl}/agent/chat`, { method: 'POST', signal: input.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        messages: [{ role: 'user', content: input.message.content, ...(input.message.images ? { images: input.message.images } : {}) }],
        model: input.model, ollama_url: input.ollamaUrl, thinking: input.thinking,
        ...(input.provider === 'openai' ? { provider: 'openai' as const, openaiModel: input.openaiModel } : {}),
        originSessionId: input.turn.context.originSessionId, worldContext: input.turn.context, context: {},
      }) })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new WorldAiRequestError('transport')
  }
  if (!response.ok) throw new WorldAiRequestError('http', response.status)
  try {
    return parseWorldAiChatResponse(await response.json())
  } catch {
    throw new WorldAiRequestError('invalid_response')
  }
}

export function createWorldAiChatAdapter(port: WorldEditorCommandPort, isEditAvailable: () => boolean,
  options: { autoApply?: boolean; onBeforeApply?: () => void } = {}): WorldAiChatAdapter {
  const bridge = createWorldAiCommandBridge(port, { maxProposals: 1 })
  const listeners = new Set<() => void>()
  let state: WorldAiChatState = { status: 'idle', message: '' }
  let generation = 0
  let current: WorldAiChatTurn | null = null
  let committedRevision: number | null = null
  let disposed = false
  const publish = (next: WorldAiChatState) => { state = Object.freeze(next); for (const listener of listeners) listener() }
  const scopeBound = (context: WorldAiContext) => {
    const active = port.getActiveContext()
    return !!active && port.getState().editorEpoch === context.editorEpoch && active.projectKey === context.projectKey
      && active.projectId === context.projectId && active.activeSceneId === context.activeSceneId
  }
  const bound = (context: WorldAiContext) => scopeBound(context) && port.getActiveContext()?.baseRevision === context.baseRevision
  const live = (turn: WorldAiChatTurn) => current === turn && turn.guard.isCurrent() && bound(turn.context)
  const discard = () => { if (state.preview) bridge.reject(state.preview.handle) }
  const stale = () => {
    discard(); generation += 1; current = null; committedRevision = null
    publish({ status: 'stale', message: 'This request is stale. Ask again from the current scene.' })
  }
  const keepCommittedHistory = (turn: WorldAiChatTurn) => {
    // The chat/request lifetime may end when its drawer closes. A committed command
    // belongs to the editor history, not to that transient request UI token.
    const savedGeneration = generation
    committedRevision = port.getActiveContext()?.baseRevision ?? null
    current = Object.freeze({ ...turn, guard: { context: turn.context,
      isCurrent: () => !disposed && generation === savedGeneration && scopeBound(turn.context) && isEditAvailable() } })
    publish({ status: 'applied', message: 'Changes applied. Undo is available.' })
  }
  let unsubscribe: (() => void) | null = null
  const onEditorChange = () => {
    if (!current || state.status === 'applying') return
    if (!scopeBound(current.context) || !current.guard.isCurrent()
      || (state.status === 'applied' && port.getActiveContext()?.baseRevision !== committedRevision)
      || (['loading', 'previewing', 'ready'].includes(state.status) && !bound(current.context))) stale()
  }
  const adapter: WorldAiChatAdapter = {
    begin(input) {
      discard(); generation += 1; committedRevision = null
      const active = port.getActiveContext()
      if (!active || !isEditAvailable() || disposed) {
        current = null
        publish({ status: 'error', message: 'Open a World in Edit mode before asking AI.' })
        throw new Error('Open a World in Edit mode before asking AI.')
      }
      const context = Object.freeze(parseWorldAiContext({ schema: WORLD_AI_CONTEXT_SCHEMA, projectKey: active.projectKey,
        projectId: active.projectId, baseRevision: active.baseRevision, activeSceneId: active.activeSceneId, editorEpoch: port.getState().editorEpoch,
        originSessionId: input.originSessionId, requestId: input.requestId }))
      const captured = generation
      const turn: WorldAiChatTurn = Object.freeze({ context,
        guard: { context, isCurrent: () => !disposed && generation === captured && input.isCurrent() && isEditAvailable() },
        isRequestCurrent: () => {
          if (current !== turn || state.status !== 'loading') return false
          if (!live(turn)) { stale(); return false }
          return true
        },
      })
      current = turn
      publish({ status: 'loading', message: 'Asking the configured model…' })
      return current
    },
    async accept(turn, response) {
      // Claim this turn before any awaited preview. A duplicate callback must never
      // obtain a second proposal handle or retry a failed host write.
      if (current !== turn || state.status !== 'loading') return
      if (!live(turn)) { stale(); return }
      try {
        const data = parseWorldAiChatResponse(response)
        if (!data.worldProposals.length) {
          current = null
          publish({ status: 'idle', message: 'Scene unchanged.' })
          return
        }
        const proposal = data.worldProposals[0]
        if (!sameWorldAiContext(turn.context, proposal.context)) { stale(); return }
        publish({ status: 'previewing', message: 'Checking the proposed changes…' })
        const active = port.getActiveContext()
        if (!active) { stale(); return }
        const preview = await bridge.propose({ transactionId: turn.context.requestId, commands: hasWorldAiRecipes(proposal.commands) ? [] : validateWorldAiCommands(active.snapshot, turn.context, proposal.commands),
          ...(hasWorldAiRecipes(proposal.commands) ? { proposal } : {}), guard: turn.guard })
        if (current !== turn) { if (preview.ok) bridge.reject(preview.value.handle); return }
        if (!live(turn)) { if (preview.ok) bridge.reject(preview.value.handle); stale(); return }
        if (!preview.ok) {
          if (isStaleAuthority(preview.error.code)) stale()
          else publish({ status: 'error', message: 'The proposal could not be previewed. Ask again.', errorCode: preview.error.code })
          return
        }
        publish({ status: 'ready', message: 'Changes checked.', preview: preview.value })
        if (options.autoApply) await adapter.apply()
      } catch { discard(); publish({ status: 'error', message: 'The response was rejected. No changes were made.' }) }
    },
    fail(turn, reason = 'unknown') { if (current === turn && state.status === 'loading') { discard(); publish({ status: 'error', message: worldAiRequestFailureMessage(reason) }) } },
    async apply() {
      if (!current || state.status !== 'ready' || !state.preview) return
      const turn = current; const preview = state.preview
      options.onBeforeApply?.()
      publish({ status: 'applying', message: 'Applying changes…', preview })
      const result = await bridge.apply(preview.handle)
      if (current !== turn) {
        if (result.ok && current === null && !disposed && scopeBound(turn.context) && isEditAvailable()) {
          // Closing a request cannot undo journal irreversibility. Own a new history-only
          // lifetime for the committed edit; never restore the cancelled model request or preview.
          keepCommittedHistory(turn)
        }
        return
      }
      if (!scopeBound(turn.context) || !turn.guard.isCurrent()) { stale(); return }
      if (!result.ok) {
        if (isStaleAuthority(result.error.code)) stale()
        else {
          discard()
          publish({ status: 'error', message: applyErrorMessage(result.error.code), errorCode: result.error.code })
        }
        return
      }
      keepCommittedHistory(turn)
    },
    reject() { discard(); generation += 1; current = null; committedRevision = null; publish({ status: 'rejected', message: 'Proposal rejected. Nothing changed.' }) },
    async undo() {
      if (!current || state.status !== 'applied' || !scopeBound(current.context) || !isEditAvailable()) return
      const active = port.getActiveContext()
      if (!active) return
      if (active.baseRevision !== committedRevision) { stale(); return }
      const turn = current
      const context = parseWorldAiContext({ ...turn.context, projectKey: active.projectKey, projectId: active.projectId,
        baseRevision: active.baseRevision, activeSceneId: active.activeSceneId, editorEpoch: port.getState().editorEpoch })
      // Claim Undo before the asynchronous host transition. Its own revision publish
      // must not be mistaken for an intervening human edit.
      publish({ status: 'undoing', message: 'Undoing last command…' })
      const result = await port.undo({ context, isCurrent: turn.guard.isCurrent })
      if (current !== turn) return
      if (!scopeBound(turn.context) || !turn.guard.isCurrent()
        || (result.ok && port.getActiveContext()?.baseRevision !== result.value.revision)) { stale(); return }
      committedRevision = null
      current = null
      publish(result.ok ? { status: 'idle', message: 'Last command undone.' } : { status: 'stale', message: 'Undo is unavailable in the current scene.' })
    },
    cancel() {
      if (!current || state.status === 'applied' || state.status === 'undoing') return
      generation += 1
      current = null
      stale()
    },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      unsubscribe ??= port.subscribe(onEditorChange)
      return () => { listeners.delete(listener); if (!listeners.size) { unsubscribe?.(); unsubscribe = null } }
    },
    dispose() { disposed = true; generation += 1; discard(); current = null; unsubscribe?.(); unsubscribe = null; listeners.clear() },
  }
  return adapter
}

function isStaleAuthority(code: WorldAiBridgeErrorCode): boolean {
  return code === 'revision_conflict' || code === 'project_closed' || code === 'project_not_found' || code === 'scene_missing'
}

/** Repository diagnostics can include host paths; only stable typed errors choose UI copy. */
function applyErrorMessage(code: WorldAiBridgeErrorCode): string {
  switch (code) {
    case 'write_failed': return 'Could not save the World changes. Check project storage before trying again.'
    case 'project_busy': return 'The project is busy. Wait for the current operation to finish before trying again.'
    case 'recovery_failed': return 'The project needs recovery before changes can be saved.'
    case 'invalid_request':
    case 'invalid_command':
    case 'invalid_response':
    case 'proposal_changed':
    case 'transaction_reuse': return 'The proposal could not be applied safely. No automatic retry was attempted.'
    default: return 'Apply could not complete. Check the project before trying again.'
  }
}

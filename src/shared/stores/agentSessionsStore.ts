import { create, type StoreApi, type UseBoundStore } from 'zustand'

import type {
  AgentSession,
  AgentSessionAddAttachmentRequest,
  AgentSessionAppendMessageRequest,
  AgentSessionListItem,
  AgentSessionsApi,
} from '../types/agentSessions'

interface AgentSessionsState {
  sessions: AgentSessionListItem[]
  activeSession: AgentSession | null
  readOnly: boolean
  initialized: boolean
  initialize(): Promise<void>
  createSession(title?: string): Promise<void>
  switchSession(sessionId: string): Promise<void>
  renameSession(sessionId: string, title: string): Promise<void>
  deleteSession(sessionId: string): Promise<void>
  appendMessage(sessionId: string, message: AgentSessionAppendMessageRequest['message']): Promise<AgentSession>
  addAttachment(sessionId: string, attachment: AgentSessionAddAttachmentRequest['attachment']): Promise<AgentSession>
  removeAttachments(sessionId: string, attachmentIds: string[]): Promise<void>
}

export class AgentSessionConflictError extends Error {
  constructor() {
    super('Chat history changed while saving. Please retry your message.')
    this.name = 'AgentSessionConflictError'
  }
}

function defaultApi(): AgentSessionsApi {
  if (typeof window === 'undefined' || !window.electron?.agentSessions) {
    throw new Error('Agent session persistence is available only in the Modly desktop app.')
  }
  return window.electron.agentSessions
}

export function createAgentSessionsStore(api?: AgentSessionsApi): UseBoundStore<StoreApi<AgentSessionsState>> {
  const sessionApi = () => api ?? defaultApi()
  let initializePromise: Promise<void> | null = null
  let activationGeneration = 0
  let pendingSelectionOperations = 0
  let durableActiveSessionId: string | undefined
  let durableSelectionQueue: Promise<void> = Promise.resolve()
  const enqueueDurableSelection = <T>(
    generation: number,
    operation: () => Promise<T>,
  ): Promise<{ performed: false } | { performed: true, value: T }> => {
    const result = durableSelectionQueue.then(async () => {
      if (generation !== activationGeneration) return { performed: false as const }
      return { performed: true as const, value: await operation() }
    })
    durableSelectionQueue = result.then(() => undefined, () => undefined)
    return result
  }
  const operationQueues = new Map<string, Promise<unknown>>()
  const enqueue = <T>(sessionId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = operationQueues.get(sessionId) ?? Promise.resolve()
    const result = previous.then(operation, operation)
    operationQueues.set(sessionId, result)
    void result.finally(() => { if (operationQueues.get(sessionId) === result) operationQueues.delete(sessionId) }).catch(() => undefined)
    return result
  }
  const isRevisionConflict = (error: unknown): boolean => error instanceof Error && /revision conflict/i.test(error.message)
  const applyMutation = async (
    sessionId: string,
    mutate: (session: AgentSession) => Promise<AgentSession>,
  ): Promise<AgentSession> => enqueue(sessionId, async () => {
    let target = await sessionApi().read({ sessionId })
    try {
      target = await mutate(target)
    } catch (error) {
      if (!isRevisionConflict(error)) throw error
      target = await sessionApi().read({ sessionId })
      try { target = await mutate(target) }
      catch (retryError) {
        if (isRevisionConflict(retryError)) throw new AgentSessionConflictError()
        throw retryError
      }
    }
    const listed = await sessionApi().list()
    const stillActive = getActiveSessionId?.() === sessionId
    setStore?.({ sessions: listed.sessions, ...(stillActive ? { activeSession: target } : {}) })
    return target
  })
  let getActiveSessionId: (() => string | undefined) | undefined
  let setStore: ((state: Partial<AgentSessionsState>) => void) | undefined
  return create<AgentSessionsState>((set, get) => {
    getActiveSessionId = () => get().activeSession?.id
    setStore = set
    return {
    sessions: [], activeSession: null, readOnly: false, initialized: false,
    async initialize() {
      if (get().initialized) return
      if (initializePromise) return initializePromise
      const requestGeneration = ++activationGeneration
      pendingSelectionOperations += 1
      initializePromise = (async () => {
        const selection = await enqueueDurableSelection(requestGeneration, async () => {
          const listed = await sessionApi().list()
          durableActiveSessionId = listed.activeSessionId || undefined
          return listed
        })
        if (!selection.performed) return
        const listed = selection.value
        const activeSession = listed.readOnly || !listed.activeSessionId ? null : await sessionApi().read({ sessionId: listed.activeSessionId })
        if (requestGeneration !== activationGeneration) return
        set({ sessions: listed.sessions, activeSession, readOnly: listed.readOnly, initialized: true })
      })().finally(() => {
        pendingSelectionOperations -= 1
        initializePromise = null
      })
      return initializePromise
    },
    async createSession(title) {
      const requestGeneration = ++activationGeneration
      pendingSelectionOperations += 1
      try {
        const selection = await enqueueDurableSelection(requestGeneration, async () => {
          const activeSession = await sessionApi().create(title ? { title } : {})
          durableActiveSessionId = activeSession.id
          return activeSession
        })
        if (!selection.performed) return
        const listed = await sessionApi().list()
        if (requestGeneration !== activationGeneration) return
        set({ sessions: listed.sessions, activeSession: selection.value, readOnly: listed.readOnly, initialized: true })
      } finally {
        pendingSelectionOperations -= 1
      }
    },
    async switchSession(sessionId) {
      const requestGeneration = ++activationGeneration
      if (
        get().activeSession?.id === sessionId
        && pendingSelectionOperations === 0
        && durableActiveSessionId === sessionId
      ) return
      pendingSelectionOperations += 1
      try {
        const selection = await enqueueDurableSelection(requestGeneration, async () => {
          const listed = await sessionApi().activate({ sessionId })
          durableActiveSessionId = listed.activeSessionId || undefined
          return listed
        })
        if (!selection.performed) return
        const listed = selection.value
        const activeSession = await sessionApi().read({ sessionId })
        if (requestGeneration !== activationGeneration) return
        set({ sessions: listed.sessions, activeSession, readOnly: listed.readOnly, initialized: true })
      } finally {
        pendingSelectionOperations -= 1
      }
    },
    async renameSession(sessionId, title) {
      await applyMutation(sessionId, (target) => sessionApi().rename({
        sessionId,
        expectedRevision: target.revision,
        title,
      }))
    },
    async deleteSession(sessionId) {
      const summary = get().sessions.find((item) => item.id === sessionId)
      if (!summary) throw new Error('Agent session not found.')
      const requestGeneration = ++activationGeneration
      pendingSelectionOperations += 1
      try {
        const selection = await enqueueDurableSelection(requestGeneration, async () => {
          const listed = await sessionApi().delete({ sessionId, expectedRevision: summary.revision })
          durableActiveSessionId = listed.activeSessionId || undefined
          return listed
        })
        if (!selection.performed) return
        const listed = selection.value
        const activeSession = await sessionApi().read({ sessionId: listed.activeSessionId })
        if (requestGeneration !== activationGeneration) return
        set({ sessions: listed.sessions, activeSession, readOnly: listed.readOnly })
      } finally {
        pendingSelectionOperations -= 1
      }
    },
    async appendMessage(sessionId, message) {
      return applyMutation(sessionId, (target) => sessionApi().appendMessage({
        sessionId,
        expectedRevision: target.revision,
        message,
      }))
    },
    async addAttachment(sessionId, attachment) {
      return applyMutation(sessionId, (target) => sessionApi().addAttachment({
        sessionId,
        expectedRevision: target.revision,
        attachment,
      }))
    },
    async removeAttachments(sessionId, attachmentIds) {
      for (const attachmentId of attachmentIds) {
        await applyMutation(sessionId, (target) => sessionApi().removeAttachment({
          sessionId,
          expectedRevision: target.revision,
          attachmentId,
        })).catch((error) => {
          if (error instanceof Error && /not found|referenced/i.test(error.message)) return undefined as never
          throw error
        })
      }
    },
  }
  })
}

export const useAgentSessionsStore = createAgentSessionsStore()

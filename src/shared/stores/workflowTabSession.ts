export const WORKFLOW_TAB_SESSION_KEY = 'modly-workflow-tab-session'
export const WORKFLOW_TAB_SESSION_VERSION = 1

export interface WorkflowTabSession {
  version: 1
  openIds: string[]
  activeId: string | null
}

export interface StoredWorkflowTabSession {
  exists: boolean
  session: WorkflowTabSession | null
}

interface StorageReader {
  getItem(key: string): string | null
}

interface StorageWriter {
  setItem(key: string, value: string): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function unique(ids: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

export function createWorkflowTabSession(openIds: string[], activeId: string | null): WorkflowTabSession {
  const dedupedOpenIds = unique(openIds)
  return {
    version: WORKFLOW_TAB_SESSION_VERSION,
    openIds: dedupedOpenIds,
    activeId: activeId !== null && dedupedOpenIds.includes(activeId) ? activeId : (dedupedOpenIds[0] ?? null),
  }
}

export function parseWorkflowTabSession(raw: string): WorkflowTabSession | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return null
    if (parsed.version !== WORKFLOW_TAB_SESSION_VERSION) return null
    if (!isStringArray(parsed.openIds)) return null
    if (parsed.activeId !== null && typeof parsed.activeId !== 'string') return null
    return createWorkflowTabSession(parsed.openIds, parsed.activeId)
  } catch {
    return null
  }
}

export function readWorkflowTabSession(storage: StorageReader = localStorage): StoredWorkflowTabSession {
  try {
    const raw = storage.getItem(WORKFLOW_TAB_SESSION_KEY)
    if (raw === null) return { exists: false, session: null }
    return { exists: true, session: parseWorkflowTabSession(raw) }
  } catch {
    return { exists: false, session: null }
  }
}

export function writeWorkflowTabSession(session: WorkflowTabSession, storage: StorageWriter = localStorage): void {
  try {
    storage.setItem(WORKFLOW_TAB_SESSION_KEY, JSON.stringify(createWorkflowTabSession(session.openIds, session.activeId)))
  } catch {
    // Ignore quota/private mode failures because tab session is UI state only.
  }
}

export function reconcileWorkflowTabSession(
  stored: StoredWorkflowTabSession,
  workflowIds: string[],
): WorkflowTabSession {
  const fallback = createWorkflowTabSession(workflowIds.length > 0 ? [workflowIds[0]] : [], workflowIds[0] ?? null)
  if (stored.session === null) return fallback

  if (stored.session.openIds.length === 0) {
    return createWorkflowTabSession([], null)
  }

  const available = new Set(workflowIds)
  const filtered = stored.session.openIds.filter((id) => available.has(id))
  if (filtered.length === 0) {
    // If every persisted tab disappeared (for example after deletions), reopen the
    // most recent available workflow instead of leaving the UI in a broken state.
    return fallback
  }

  return createWorkflowTabSession(filtered, stored.session.activeId)
}

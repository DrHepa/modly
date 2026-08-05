export const AGENT_SESSION_SCHEMA = 'modly.agent-sessions' as const
export const AGENT_SESSION_SCHEMA_VERSION = 1 as const

export type AgentMessageRole = 'user' | 'assistant'

export interface AgentAttachmentRef {
  id: string
  name: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  sizeBytes: number
}

/** A deliberately narrower artifact reference whose location is always workspace-relative. */
export interface AgentArtifactRef {
  id: string
  kind: string
  versionId: string
  workspacePath: string
}

export interface AgentSessionSummary {
  kind: 'action' | 'artifact'
  label: string
  artifact?: AgentArtifactRef
}

export interface AgentSessionMessage {
  id: string
  role: AgentMessageRole
  content: string
  attachmentIds: string[]
  summaries: AgentSessionSummary[]
}

export interface AgentSession {
  id: string
  title: string
  revision: number
  createdAt: string
  updatedAt: string
  expiresAt: string
  messages: AgentSessionMessage[]
  attachments: AgentAttachmentRef[]
}

export interface AgentSessionListItem extends Omit<AgentSession, 'messages' | 'attachments'> {
  messageCount: number
  attachmentCount: number
}

export interface AgentSessionListResult {
  sessions: AgentSessionListItem[]
  activeSessionId: string
  readOnly: boolean
}

export interface AgentSessionCreateRequest { title?: string }
export interface AgentSessionReadRequest { sessionId: string }
export interface AgentSessionActivateRequest { sessionId: string }
export interface AgentSessionRenameRequest { sessionId: string, expectedRevision: number, title: string }
export interface AgentSessionDeleteRequest { sessionId: string, expectedRevision: number }
export interface AgentSessionAppendMessageRequest {
  sessionId: string
  expectedRevision: number
  message: {
    id: string
    role: AgentMessageRole
    content: string
    attachmentIds?: string[]
    summaries?: AgentSessionSummary[]
  }
}
export interface AgentSessionAttachmentInput {
  name: string
  mimeType: string
  bytes: Uint8Array
}
export interface AgentSessionAddAttachmentRequest {
  sessionId: string
  expectedRevision: number
  attachment: AgentSessionAttachmentInput
}
export interface AgentSessionRemoveAttachmentRequest {
  sessionId: string
  expectedRevision: number
  attachmentId: string
}
export interface AgentSessionReadAttachmentRequest { sessionId: string, attachmentId: string }

export interface AgentSessionsApi {
  list(): Promise<AgentSessionListResult>
  create(request: AgentSessionCreateRequest): Promise<AgentSession>
  read(request: AgentSessionReadRequest): Promise<AgentSession>
  activate(request: AgentSessionActivateRequest): Promise<AgentSessionListResult>
  rename(request: AgentSessionRenameRequest): Promise<AgentSession>
  delete(request: AgentSessionDeleteRequest): Promise<AgentSessionListResult>
  appendMessage(request: AgentSessionAppendMessageRequest): Promise<AgentSession>
  addAttachment(request: AgentSessionAddAttachmentRequest): Promise<AgentSession>
  removeAttachment(request: AgentSessionRemoveAttachmentRequest): Promise<AgentSession>
  readAttachment(request: AgentSessionReadAttachmentRequest): Promise<Uint8Array>
}

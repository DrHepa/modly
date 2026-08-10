export const AGENT_WORKFLOW_GRAPH_SCHEMA = 'modly.agent-workflow-graph' as const
export const AGENT_WORKFLOW_GRAPH_VERSION = 1 as const

export type AgentWorkflowParamValue = boolean | number | string

interface AgentWorkflowGraphNodeBaseV1 {
  key: string
  enabled: boolean
  showInGenerate: boolean
  params: Record<string, AgentWorkflowParamValue>
  position?: { x: number, y: number }
}

export interface AgentWorkflowBuiltinNodeV1 extends AgentWorkflowGraphNodeBaseV1 {
  kind: 'builtin'
  type: string
}

export interface AgentWorkflowExtensionNodeV1 extends AgentWorkflowGraphNodeBaseV1 {
  kind: 'extension'
  /** Canonical runtime identity: `${extension.id}/${node.id}`. */
  type: string
}

export type AgentWorkflowGraphNodeV1 = AgentWorkflowBuiltinNodeV1 | AgentWorkflowExtensionNodeV1

export interface AgentWorkflowGraphEdgeV1 {
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
}

export interface AgentWorkflowGraphV1 {
  schema: typeof AGENT_WORKFLOW_GRAPH_SCHEMA
  version: typeof AGENT_WORKFLOW_GRAPH_VERSION
  name: string
  description: string
  nodes: AgentWorkflowGraphNodeV1[]
  edges: AgentWorkflowGraphEdgeV1[]
}

export interface AgentWorkflowCreateRequest {
  actionId: string
  originSessionId: string
  graph: AgentWorkflowGraphV1
}

export interface AgentCreatedWorkflowNode {
  id: string
  type: string
  position: { x: number, y: number }
  data: {
    extensionId?: string
    enabled: boolean
    showInGenerate: boolean
    params: Record<string, AgentWorkflowParamValue>
  }
}

export interface AgentCreatedWorkflowEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
}

export interface AgentCreatedWorkflow {
  id: string
  name: string
  description: string
  nodes: AgentCreatedWorkflowNode[]
  edges: AgentCreatedWorkflowEdge[]
  createdAt: string
  updatedAt: string
}

export type AgentWorkflowCreateErrorCode =
  | 'invalid_request'
  | 'origin_inactive'
  | 'inventory_unavailable'
  | 'graph_invalid'
  | 'write_failed'

export type AgentWorkflowCreateResult =
  | { ok: true, workflow: AgentCreatedWorkflow }
  | { ok: false, error: { code: AgentWorkflowCreateErrorCode } }

export interface AgentWorkflowsApi {
  create(request: AgentWorkflowCreateRequest): Promise<AgentWorkflowCreateResult>
}

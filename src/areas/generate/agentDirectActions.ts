import type { Workflow } from '@shared/types/electron.d'
import type {
  AgentCreatedWorkflow,
  AgentWorkflowCreateRequest,
  AgentWorkflowCreateResult,
  AgentWorkflowGraphV1,
  AgentWorkflowParamValue,
} from '@shared/types/agentWorkflows.ts'
import type { WorkflowExtension } from '../workflows/mockExtensions.ts'

const MAX_ACTION_RESULT_UNITS = 64 * 1024
const MAX_AGENT_ACTION_BATCH_BYTES = 512 * 1024
const MAX_AGENT_ACTIONS_PER_RESPONSE = 80
const MAX_GRAPH_BYTES = 256 * 1024
const MAX_GRAPH_NODES = 64
const MAX_GRAPH_EDGES = 128
const MAX_GRAPH_PARAMS = 64
const MAX_PARAM_STRING_UNITS = 8_192
const OPAQUE_DIRECT_ACTION_ID = /^direct-[a-f0-9]{32}$/
const SAFE_WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_GRAPH_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SAFE_NODE_TYPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/
const SAFE_PARAM_KEY = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/
const MESH_SUFFIXES = ['.glb', '.gltf', '.obj', '.ply', '.stl', '.fbx'] as const
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const READ_ONLY_TOOL_NAMES = new Set([
  'list_models',
  'list_processes',
  'get_mesh_info',
  'get_generation_status',
  'list_workflows',
])

export type AgentDirectActionIntent =
  | { type: 'models_unloaded', actionId: string }
  | {
      type: 'mesh_operation'
      actionId: string
      operation: 'smooth'
      assetRef: string
      iterations: number
    }
  | {
      type: 'mesh_operation'
      actionId: string
      operation: 'decimate'
      assetRef: string
      targetFaces: number
    }
  | {
      type: 'run_workflow'
      actionId: string
      workflowId: string
      workflowName: string
    }
  | {
      type: 'create_workflow'
      actionId: string
      graph: AgentWorkflowGraphV1
    }

export interface AgentResponseAction {
  tool: string
  result: string
  payload?: AgentDirectActionIntent | null
}

export type AgentReflectedActionPayload =
  | { type: 'models_unloaded' }
  | { type: 'mesh_update', url: string, face_count?: number }
  | { type: 'run_workflow', workflow_id: string, workflow_name: string }
  | { type: 'create_workflow', workflow_id: string, workflow_name: string }

export interface AgentReflectedAction {
  tool: string
  result: string
  payload?: AgentReflectedActionPayload | null
}

export interface AppliedDirectActionIds {
  reserve(actionId: string): boolean
  has(actionId: string): boolean
}

export interface AgentDirectActionDependencies {
  originSessionId: string
  isCurrent(): boolean
  appliedIds: AppliedDirectActionIds
  createWorkflow(request: AgentWorkflowCreateRequest): Promise<AgentWorkflowCreateResult>
  reloadWorkflows(): Promise<void>
  openWorkflow(workflowId: string): void
  getWorkflows(): readonly Workflow[]
  isWorkflowBusy(): boolean
  loadExtensions(): Promise<void>
  getWorkflowExtensions(): WorkflowExtension[]
  preflightWorkflow(workflow: Workflow, extensions: WorkflowExtension[]): readonly string[]
  startWorkflow(workflow: Workflow, extensions: WorkflowExtension[]): void | Promise<void>
  currentMeshRef(): string | null
  smoothMesh(workspacePath: string, iterations: number): Promise<{ url: string }>
  decimateMesh(workspacePath: string, targetFaces: number): Promise<{ url: string, faceCount: number }>
  updateMesh(url: string, faceCount?: number): void
  unloadModels(): Promise<{ success: boolean, error?: string }>
}

export interface AgentActionFailure {
  action: AgentResponseAction
  error: unknown
}

export interface AgentActionApplicationResult {
  reflectedActions: AgentReflectedAction[]
  failures: AgentActionFailure[]
}

function isOwnRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Reflect.ownKeys(value)
  const allowed = new Set([...required, ...optional])
  return keys.every((key) => typeof key === 'string' && allowed.has(key))
    && required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function isSafeText(value: unknown, maxLength: number, allowEmpty = false): value is string {
  if (typeof value !== 'string' || value.length > maxLength || value.trim() !== value || (!allowEmpty && !value)) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) return false
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

function isFiniteInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

export function canonicalWorkspaceAssetRef(value: unknown): string | null {
  if (!isSafeText(value, 2_048) || !value.startsWith('/workspace/')) return null
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return null
  }
  if (value.includes('\\') || value.includes('%') || value.includes('?') || value.includes('#')) return null
  const suffix = value.slice('/workspace/'.length)
  const segments = suffix.split('/')
  if (!suffix || segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  if (!MESH_SUFFIXES.some((extension) => suffix.toLowerCase().endsWith(extension))) return null
  return value
}

function parsePosition(value: unknown): { x: number, y: number } | null {
  if (!isOwnRecord(value) || !hasExactKeys(value, ['x', 'y'])) return null
  if (
    typeof value.x !== 'number' || !Number.isFinite(value.x) || Math.abs(value.x) > 1_000_000
    || typeof value.y !== 'number' || !Number.isFinite(value.y) || Math.abs(value.y) > 1_000_000
  ) return null
  return { x: value.x, y: value.y }
}

function parseParams(value: unknown): Record<string, AgentWorkflowParamValue> | null {
  if (!isOwnRecord(value)) return null
  const keys = Reflect.ownKeys(value)
  if (keys.length > MAX_GRAPH_PARAMS) return null
  const params: Record<string, AgentWorkflowParamValue> = {}
  for (const key of keys) {
    if (typeof key !== 'string' || !SAFE_PARAM_KEY.test(key) || UNSAFE_KEYS.has(key)) return null
    const item = value[key]
    if (typeof item === 'string') {
      if (!isSafeText(item, MAX_PARAM_STRING_UNITS, true)) return null
      params[key] = item
    } else if (typeof item === 'boolean') {
      params[key] = item
    } else if (typeof item === 'number' && Number.isFinite(item)) {
      params[key] = item
    } else return null
  }
  return params
}

function parseGraph(value: unknown): AgentWorkflowGraphV1 | null {
  if (!isOwnRecord(value) || !hasExactKeys(value, [
    'schema', 'version', 'name', 'description', 'nodes', 'edges',
  ])) return null
  if (
    value.schema !== 'modly.agent-workflow-graph'
    || value.version !== 1
    || !isSafeText(value.name, 120)
    || !isSafeText(value.description, 2_000, true)
    || !Array.isArray(value.nodes)
    || value.nodes.length < 1
    || value.nodes.length > MAX_GRAPH_NODES
    || !Array.isArray(value.edges)
    || value.edges.length > MAX_GRAPH_EDGES
  ) return null

  const nodes: AgentWorkflowGraphV1['nodes'] = []
  const nodeKeys = new Set<string>()
  for (const rawNode of value.nodes) {
    if (!isOwnRecord(rawNode) || !hasExactKeys(rawNode, [
      'key', 'kind', 'type', 'enabled', 'showInGenerate', 'params',
    ], ['position'])) return null
    if (
      typeof rawNode.key !== 'string'
      || !SAFE_GRAPH_KEY.test(rawNode.key)
      || UNSAFE_KEYS.has(rawNode.key)
      || nodeKeys.has(rawNode.key)
      || (rawNode.kind !== 'builtin' && rawNode.kind !== 'extension')
      || typeof rawNode.type !== 'string'
      || rawNode.type.length > 256
      || !SAFE_NODE_TYPE.test(rawNode.type)
      || rawNode.type.split('/').some((segment) => UNSAFE_KEYS.has(segment))
      || (rawNode.kind === 'extension') !== rawNode.type.includes('/')
      || typeof rawNode.enabled !== 'boolean'
      || typeof rawNode.showInGenerate !== 'boolean'
    ) return null
    const params = parseParams(rawNode.params)
    if (!params) return null
    const position = rawNode.position === undefined ? undefined : parsePosition(rawNode.position)
    if (rawNode.position !== undefined && !position) return null
    nodeKeys.add(rawNode.key)
    nodes.push({
      key: rawNode.key,
      kind: rawNode.kind,
      type: rawNode.type,
      enabled: rawNode.enabled,
      showInGenerate: rawNode.showInGenerate,
      params,
      ...(position ? { position } : {}),
    })
  }

  const edges: AgentWorkflowGraphV1['edges'] = []
  for (const rawEdge of value.edges) {
    if (!isOwnRecord(rawEdge) || !hasExactKeys(rawEdge, ['source', 'target'], ['sourceHandle', 'targetHandle'])) return null
    if (
      typeof rawEdge.source !== 'string' || !SAFE_GRAPH_KEY.test(rawEdge.source)
      || UNSAFE_KEYS.has(rawEdge.source)
      || typeof rawEdge.target !== 'string' || !SAFE_GRAPH_KEY.test(rawEdge.target)
      || UNSAFE_KEYS.has(rawEdge.target)
      || (rawEdge.sourceHandle !== undefined && (
        typeof rawEdge.sourceHandle !== 'string'
        || !SAFE_PARAM_KEY.test(rawEdge.sourceHandle)
        || UNSAFE_KEYS.has(rawEdge.sourceHandle)
      ))
      || (rawEdge.targetHandle !== undefined && (
        typeof rawEdge.targetHandle !== 'string'
        || !SAFE_PARAM_KEY.test(rawEdge.targetHandle)
        || UNSAFE_KEYS.has(rawEdge.targetHandle)
      ))
    ) return null
    edges.push({
      source: rawEdge.source,
      target: rawEdge.target,
      ...(typeof rawEdge.sourceHandle === 'string' ? { sourceHandle: rawEdge.sourceHandle } : {}),
      ...(typeof rawEdge.targetHandle === 'string' ? { targetHandle: rawEdge.targetHandle } : {}),
    })
  }

  const graph: AgentWorkflowGraphV1 = {
    schema: value.schema,
    version: value.version,
    name: value.name,
    description: value.description,
    nodes,
    edges,
  }
  try {
    if (new TextEncoder().encode(JSON.stringify(graph)).byteLength > MAX_GRAPH_BYTES) return null
  } catch {
    return null
  }
  return graph
}

function parseDirectPayload(tool: string, value: unknown): AgentDirectActionIntent | null {
  if (!isOwnRecord(value) || typeof value.type !== 'string' || typeof value.actionId !== 'string' || !OPAQUE_DIRECT_ACTION_ID.test(value.actionId)) {
    return null
  }
  if (tool === 'unload_models') {
    return value.type === 'models_unloaded' && hasExactKeys(value, ['type', 'actionId'])
      ? { type: value.type, actionId: value.actionId }
      : null
  }
  if (tool === 'smooth_mesh') {
    const assetRef = canonicalWorkspaceAssetRef(value.assetRef)
    return value.type === 'mesh_operation'
      && value.operation === 'smooth'
      && hasExactKeys(value, ['type', 'actionId', 'operation', 'assetRef', 'iterations'])
      && assetRef !== null
      && isFiniteInteger(value.iterations, 1, 20)
      ? { type: value.type, actionId: value.actionId, operation: value.operation, assetRef, iterations: value.iterations }
      : null
  }
  if (tool === 'decimate_mesh') {
    const assetRef = canonicalWorkspaceAssetRef(value.assetRef)
    return value.type === 'mesh_operation'
      && value.operation === 'decimate'
      && hasExactKeys(value, ['type', 'actionId', 'operation', 'assetRef', 'targetFaces'])
      && assetRef !== null
      && isFiniteInteger(value.targetFaces, 100, 500_000)
      ? { type: value.type, actionId: value.actionId, operation: value.operation, assetRef, targetFaces: value.targetFaces }
      : null
  }
  if (tool === 'run_workflow') {
    return value.type === 'run_workflow'
      && hasExactKeys(value, ['type', 'actionId', 'workflowId', 'workflowName'])
      && typeof value.workflowId === 'string'
      && SAFE_WORKFLOW_ID.test(value.workflowId)
      && !UNSAFE_KEYS.has(value.workflowId)
      && isSafeText(value.workflowName, 120)
      ? {
          type: value.type,
          actionId: value.actionId,
          workflowId: value.workflowId,
          workflowName: value.workflowName,
        }
      : null
  }
  if (tool === 'create_workflow') {
    const graph = parseGraph(value.graph)
    return value.type === 'create_workflow'
      && hasExactKeys(value, ['type', 'actionId', 'graph'])
      && graph !== null
      ? { type: value.type, actionId: value.actionId, graph }
      : null
  }
  return null
}

function parseResponseAction(value: unknown): AgentResponseAction | null {
  if (!isOwnRecord(value) || !hasExactKeys(value, ['tool', 'result'], ['payload'])) return null
  if (typeof value.tool !== 'string' || !isSafeText(value.result, MAX_ACTION_RESULT_UNITS, true)) return null
  if (READ_ONLY_TOOL_NAMES.has(value.tool)) {
    if (value.payload !== undefined && value.payload !== null) return null
    return { tool: value.tool, result: value.result, ...(value.payload === null ? { payload: null } : {}) }
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'payload')) return null
  const payload = parseDirectPayload(value.tool, value.payload)
  return payload ? { tool: value.tool, result: value.result, payload } : null
}

export function parseAgentResponseActions(value: unknown): { actions: AgentResponseAction[], valid: boolean } {
  if (value === undefined) return { actions: [], valid: true }
  if (!Array.isArray(value) || value.length > MAX_AGENT_ACTIONS_PER_RESPONSE) {
    return { actions: [], valid: false }
  }
  try {
    const encoded = JSON.stringify(value)
    if (new TextEncoder().encode(encoded).byteLength > MAX_AGENT_ACTION_BATCH_BYTES) {
      return { actions: [], valid: false }
    }
  } catch {
    return { actions: [], valid: false }
  }
  const actions: AgentResponseAction[] = []
  let directActionCount = 0
  for (const rawAction of value) {
    const action = parseResponseAction(rawAction)
    if (!action) return { actions: [], valid: false }
    if (action.payload) {
      directActionCount += 1
      if (directActionCount > 1) return { actions: [], valid: false }
    }
    actions.push(action)
  }
  return { actions, valid: true }
}

export function createAppliedDirectActionIds(): AppliedDirectActionIds {
  const ids = new Set<string>()
  return {
    reserve(actionId: string): boolean {
      if (ids.has(actionId)) return false
      ids.add(actionId)
      return true
    },
    has: (actionId: string) => ids.has(actionId),
  }
}

function requireCurrent(dependencies: AgentDirectActionDependencies): void {
  if (!dependencies.isCurrent()) throw new Error('The originating Agent session is no longer active.')
}

function workspaceRelativePath(assetRef: string): string {
  return assetRef.slice('/workspace/'.length)
}

function validateCreatedWorkflow(value: AgentCreatedWorkflow, expectedName: string): AgentCreatedWorkflow {
  if (!SAFE_WORKFLOW_ID.test(value.id) || !isSafeText(value.name, 120) || value.name !== expectedName) {
    throw new Error('Modly returned an invalid created workflow.')
  }
  return value
}

async function applyDirectAction(
  action: AgentResponseAction & { payload: AgentDirectActionIntent },
  dependencies: AgentDirectActionDependencies,
): Promise<AgentReflectedAction> {
  const { payload } = action
  if (!dependencies.appliedIds.reserve(payload.actionId)) {
    throw new Error('This direct action was already handled.')
  }
  requireCurrent(dependencies)

  if (payload.type === 'models_unloaded') {
    const result = await dependencies.unloadModels()
    if (result.success !== true) throw new Error('Modly could not unload local models.')
    return { tool: action.tool, result: action.result, payload: { type: 'models_unloaded' } }
  }

  if (payload.type === 'create_workflow') {
    const result = await dependencies.createWorkflow({
      actionId: payload.actionId,
      originSessionId: dependencies.originSessionId,
      graph: payload.graph,
    })
    if (!result.ok) throw new Error(`Modly could not create the workflow (${result.error.code}).`)
    const workflow = validateCreatedWorkflow(result.workflow, payload.graph.name)
    if (dependencies.isCurrent()) {
      await dependencies.reloadWorkflows()
      if (dependencies.isCurrent()) dependencies.openWorkflow(workflow.id)
    }
    return {
      tool: action.tool,
      result: action.result,
      payload: { type: 'create_workflow', workflow_id: workflow.id, workflow_name: workflow.name },
    }
  }

  if (payload.type === 'run_workflow') {
    if (dependencies.isWorkflowBusy()) throw new Error('Another workflow is already running.')
    const resolveWorkflow = () => dependencies.getWorkflows().find((candidate) => (
      candidate.id === payload.workflowId && candidate.name === payload.workflowName
    ))
    if (!resolveWorkflow()) throw new Error('The requested workflow is no longer available.')
    await dependencies.loadExtensions()
    requireCurrent(dependencies)
    if (dependencies.isWorkflowBusy()) throw new Error('Another workflow is already running.')
    const workflow = resolveWorkflow()
    if (!workflow) throw new Error('The requested workflow is no longer available.')
    const extensions = dependencies.getWorkflowExtensions()
    const issues = dependencies.preflightWorkflow(workflow, extensions)
    if (issues.length > 0) throw new Error(issues[0] || 'Workflow preflight failed.')
    requireCurrent(dependencies)
    await dependencies.startWorkflow(workflow, extensions)
    return {
      tool: action.tool,
      result: action.result,
      payload: { type: 'run_workflow', workflow_id: workflow.id, workflow_name: workflow.name },
    }
  }

  const currentAssetRef = canonicalWorkspaceAssetRef(dependencies.currentMeshRef())
  if (!currentAssetRef || currentAssetRef !== payload.assetRef) {
    throw new Error('The requested mesh is no longer the current workspace mesh.')
  }
  let response: { url: string, faceCount?: number }
  if (payload.operation === 'smooth') {
    response = await dependencies.smoothMesh(workspaceRelativePath(payload.assetRef), payload.iterations)
  } else {
    response = await dependencies.decimateMesh(workspaceRelativePath(payload.assetRef), payload.targetFaces)
  }
  const outputUrl = canonicalWorkspaceAssetRef(response.url)
  if (!outputUrl) throw new Error('Modly returned an invalid workspace mesh reference.')
  const faceCount = payload.operation === 'decimate' ? response.faceCount : undefined
  if (faceCount !== undefined && (!Number.isSafeInteger(faceCount) || faceCount < 0 || faceCount > 100_000_000)) {
    throw new Error('Modly returned an invalid mesh face count.')
  }
  const stillCurrentAsset = canonicalWorkspaceAssetRef(dependencies.currentMeshRef())
  if (dependencies.isCurrent() && stillCurrentAsset === payload.assetRef) {
    dependencies.updateMesh(outputUrl, faceCount)
  }
  return {
    tool: action.tool,
    result: action.result,
    payload: { type: 'mesh_update', url: outputUrl, ...(faceCount === undefined ? {} : { face_count: faceCount }) },
  }
}

export async function applyAgentResponseActions(
  actions: readonly AgentResponseAction[],
  dependencies: AgentDirectActionDependencies,
): Promise<AgentActionApplicationResult> {
  const parsed = parseAgentResponseActions(actions)
  if (!parsed.valid) {
    const error = new Error('The Agent direct-action batch is invalid.')
    return {
      reflectedActions: [],
      failures: actions.map((action) => ({ action, error })),
    }
  }
  const reflectedActions: AgentReflectedAction[] = []
  const failures: AgentActionFailure[] = []
  for (const action of parsed.actions) {
    if (!action.payload) {
      reflectedActions.push({ tool: action.tool, result: action.result, ...(action.payload === null ? { payload: null } : {}) })
      continue
    }
    try {
      reflectedActions.push(await applyDirectAction(
        action as AgentResponseAction & { payload: AgentDirectActionIntent },
        dependencies,
      ))
    } catch (error) {
      failures.push({ action, error })
    }
  }
  return { reflectedActions, failures }
}

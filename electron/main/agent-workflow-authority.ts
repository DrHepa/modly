import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises'
import path from 'node:path'

import {
  AGENT_WORKFLOW_GRAPH_SCHEMA,
  AGENT_WORKFLOW_GRAPH_VERSION,
  type AgentCreatedWorkflow,
  type AgentCreatedWorkflowEdge,
  type AgentCreatedWorkflowNode,
  type AgentWorkflowCreateErrorCode,
  type AgentWorkflowCreateRequest,
  type AgentWorkflowCreateResult,
  type AgentWorkflowGraphEdgeV1,
  type AgentWorkflowGraphNodeV1,
  type AgentWorkflowGraphV1,
  type AgentWorkflowParamValue,
} from '../../src/shared/types/agentWorkflows.ts'
import {
  WORKFLOW_BUILTIN_NODE_CONTRACTS,
  isSafeWorkflowWorkspacePath,
  type WorkflowBuiltinAgentSourceAuthority,
  type WorkflowBuiltinParamContract,
  type WorkflowBuiltinNodeType,
} from '../../src/shared/workflowBuiltinContracts.ts'
import type { ListedExtension, ListedExtensionNode } from './automation-capabilities.ts'

const MAX_NODES = 64
const MAX_EDGES = 128
const MAX_REQUEST_BYTES = 256 * 1024
const MAX_WORKFLOW_BYTES = 512 * 1024
const MAX_SCENE_MANIFEST_BYTES = 2 * 1024 * 1024
const MAX_PARAM_STRING = 8_192
const MAX_PARSE_RECORD_KEYS = 5_500
const MAX_PARSE_ARRAY_ITEMS = MAX_NODES + MAX_EDGES
const MAX_PARSE_STRING_UNITS = MAX_REQUEST_BYTES
const DEFAULT_MAX_ACTION_RECORDS = 1_024
const DEFAULT_ACTION_RECORD_TTL_MS = 10 * 60 * 1_000
const TEMP_CLEANUP_ATTEMPTS = 3
const MAX_POSITION_ABS = 1_000_000
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SAFE_CAPABILITY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SAFE_PARAM_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/

type InputPort = {
  name: string | null
  type: string
  required: boolean
}

type ParamRules = {
  required: boolean
  requiredWhen?: { param: string, equals: AgentWorkflowParamValue }
  forbiddenWhen?: { param: string, equals: AgentWorkflowParamValue }
  allowEmpty: boolean
  workspacePath: boolean
}

type ParamContract =
  | (ParamRules & { type: 'boolean', hasDefault: boolean, default?: boolean })
  | (ParamRules & { type: 'int', hasDefault: boolean, default?: number, min?: number, max?: number })
  | (ParamRules & { type: 'float', hasDefault: boolean, default?: number, min?: number, max?: number })
  | (ParamRules & { type: 'string', hasDefault: boolean, default?: string })
  | (ParamRules & { type: 'select', hasDefault: boolean, default?: string | number, options: ReadonlySet<string | number> })

type IndexedExtensionNode = ListedExtensionNode & { extensionType: ListedExtension['type'] }

type NodeContract = {
  storedType: string
  extensionId?: string
  builtinType?: WorkflowBuiltinNodeType
  agentSourceAuthority?: WorkflowBuiltinAgentSourceAuthority
  inputs: InputPort[]
  output: string | null
  params: Map<string, ParamContract>
}

type ParsedRequest = {
  actionId: string
  originSessionId: string
  graph: AgentWorkflowGraphV1
}

type ExtensionInventory = {
  extensions: readonly ListedExtension[]
  errors: readonly unknown[]
}

export interface AgentWorkflowAuthorityDependencies {
  commitIfOriginSessionActive(
    originSessionId: string,
    operation: () => Promise<void>,
  ): Promise<'committed' | 'inactive' | 'commit_failed'>
  discoverExtensions(): Promise<ExtensionInventory>
  getWorkflowsDir(): string
  validateWorkspaceSource(source: AgentWorkflowWorkspaceSource): Promise<boolean>
  now?: () => Date
  createId?: () => string
  actionClock?: () => number
  maxActionRecords?: number
  actionRecordTtlMs?: number
  persistWorkflow?: (workflowsDir: string, workflow: AgentCreatedWorkflow) => Promise<void>
}

type ActionRecord = {
  digest: string
  result: Promise<AgentWorkflowCreateResult>
  state: 'in-flight' | 'settled'
  lastAccessedAt: number
  settledAt?: number
}

export type AgentWorkflowWorkspaceSource = {
  kind: 'video' | 'scene' | 'capture'
  workspacePath: string
}

class InvalidRequestError extends Error {}
class InventoryUnavailableError extends Error {}
class GraphInvalidError extends Error {}

function failure(code: AgentWorkflowCreateErrorCode): AgentWorkflowCreateResult {
  return { ok: false, error: { code } }
}

function isPlainOwnRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasForbiddenText(value: string): boolean {
  if (value.includes('\0')) return true
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true
    if (code === 0x7f) return true
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

function boundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === 'string'
    && value.length <= maxLength
    && (allowEmpty || value.length > 0)
    && value.trim() === value
    && !hasForbiddenText(value)
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!isPlainOwnRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}

function stableJson(value: unknown, pretty = false): string {
  return JSON.stringify(stableValue(value), null, pretty ? 2 : undefined)
}

class ParseBudget {
  private recordKeys = 0
  private arrayItems = 0
  private stringUnits = 0

  private ownStringKeys(value: Record<string, unknown>, maxKeys: number): string[] {
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length > maxKeys || ownKeys.some((key) => typeof key !== 'string')) throw new InvalidRequestError()
    return ownKeys as string[]
  }

  exactRecord(
    value: unknown,
    required: readonly string[],
    optional: readonly string[] = [],
  ): Record<string, unknown> {
    if (!isPlainOwnRecord(value)) throw new InvalidRequestError()
    const maxKeys = required.length + optional.length
    const keys = this.ownStringKeys(value, maxKeys)
    this.recordKeys += keys.length
    if (this.recordKeys > MAX_PARSE_RECORD_KEYS) throw new InvalidRequestError()
    const allowed = new Set([...required, ...optional])
    if (!required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
      || !keys.every((key) => allowed.has(key))) throw new InvalidRequestError()
    return value
  }

  record(value: unknown, maxKeys: number): { value: Record<string, unknown>, keys: string[] } {
    if (!isPlainOwnRecord(value)) throw new InvalidRequestError()
    const keys = this.ownStringKeys(value, maxKeys)
    this.recordKeys += keys.length
    if (this.recordKeys > MAX_PARSE_RECORD_KEYS) throw new InvalidRequestError()
    return { value, keys }
  }

  array(value: unknown, minLength: number, maxLength: number): unknown[] {
    if (!Array.isArray(value) || value.length < minLength || value.length > maxLength) throw new InvalidRequestError()
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new InvalidRequestError()
    }
    this.arrayItems += value.length
    if (this.arrayItems > MAX_PARSE_ARRAY_ITEMS) throw new InvalidRequestError()
    return value
  }

  string(value: unknown, maxLength: number, allowEmpty = false, requireTrim = true): string {
    if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && value.length === 0)
      || (requireTrim && value.trim() !== value) || hasForbiddenText(value)) throw new InvalidRequestError()
    this.stringUnits += value.length
    if (this.stringUnits > MAX_PARSE_STRING_UNITS) throw new InvalidRequestError()
    return value
  }
}

function parseParamRecord(value: unknown, budget: ParseBudget): Record<string, AgentWorkflowParamValue> {
  const parsedRecord = budget.record(value, 64)
  const parsed: Record<string, AgentWorkflowParamValue> = {}
  for (const key of parsedRecord.keys.sort()) {
    if (!SAFE_PARAM_ID.test(key)) throw new InvalidRequestError()
    budget.string(key, 64)
    const item = parsedRecord.value[key]
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new InvalidRequestError()
    } else if (typeof item === 'string') {
      if (item.length > MAX_PARAM_STRING || hasForbiddenText(item)) throw new InvalidRequestError()
      budget.string(item, MAX_PARAM_STRING, true, false)
    } else if (typeof item !== 'boolean') {
      throw new InvalidRequestError()
    }
    parsed[key] = item
  }
  return parsed
}

function parseNode(input: unknown, budget: ParseBudget): AgentWorkflowGraphNodeV1 {
  const value = budget.exactRecord(input, ['key', 'kind', 'type', 'enabled', 'showInGenerate', 'params'], ['position'])
  const key = budget.string(value.key, 64)
  if (!SAFE_KEY.test(key)) throw new InvalidRequestError()
  const kind = value.kind
  if (kind !== 'builtin' && kind !== 'extension') throw new InvalidRequestError()
  const type = budget.string(value.type, 256)
  if (kind === 'extension' && !SAFE_CAPABILITY_ID.test(type)) throw new InvalidRequestError()
  if (value.enabled !== true && value.enabled !== false) throw new InvalidRequestError()
  if (value.showInGenerate !== true && value.showInGenerate !== false) throw new InvalidRequestError()
  const params = parseParamRecord(value.params, budget)
  let position: { x: number, y: number } | undefined
  if (value.position !== undefined) {
    const parsedPosition = budget.exactRecord(value.position, ['x', 'y'])
    const { x, y } = parsedPosition
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)
      || Math.abs(x) > MAX_POSITION_ABS || Math.abs(y) > MAX_POSITION_ABS) throw new InvalidRequestError()
    position = { x, y }
  }
  return { key, kind, type, enabled: value.enabled, showInGenerate: value.showInGenerate, params, ...(position ? { position } : {}) }
}

function parseEdge(input: unknown, budget: ParseBudget): AgentWorkflowGraphEdgeV1 {
  const value = budget.exactRecord(input, ['source', 'target'], ['sourceHandle', 'targetHandle'])
  const source = budget.string(value.source, 64)
  const target = budget.string(value.target, 64)
  if (!SAFE_KEY.test(source) || !SAFE_KEY.test(target)) throw new InvalidRequestError()
  const handles: { sourceHandle?: string, targetHandle?: string } = {}
  for (const key of ['sourceHandle', 'targetHandle'] as const) {
    const handle = value[key]
    if (handle === undefined) continue
    const parsedHandle = budget.string(handle, 64)
    if (!SAFE_PARAM_ID.test(parsedHandle)) throw new InvalidRequestError()
    handles[key] = parsedHandle
  }
  return { source, target, ...handles }
}

function parseRequest(inputValue: unknown): ParsedRequest {
  const budget = new ParseBudget()
  const value = budget.exactRecord(inputValue, ['actionId', 'originSessionId', 'graph'])
  const actionId = budget.string(value.actionId, 128)
  const originSessionId = budget.string(value.originSessionId, 128)
  if (!SAFE_ID.test(actionId) || !SAFE_ID.test(originSessionId)) throw new InvalidRequestError()
  const input = budget.exactRecord(value.graph, ['schema', 'version', 'name', 'description', 'nodes', 'edges'])
  if (input.schema !== AGENT_WORKFLOW_GRAPH_SCHEMA || input.version !== AGENT_WORKFLOW_GRAPH_VERSION) throw new InvalidRequestError()
  const name = budget.string(input.name, 120)
  const description = budget.string(input.description, 2_000, true)
  // Lengths are checked before reading any element or serializing the request.
  const rawNodes = budget.array(input.nodes, 1, MAX_NODES)
  const rawEdges = budget.array(input.edges, 0, MAX_EDGES)
  const nodes: AgentWorkflowGraphNodeV1[] = []
  for (let index = 0; index < rawNodes.length; index += 1) {
    if (!Object.hasOwn(rawNodes, index)) throw new InvalidRequestError()
    nodes.push(parseNode(rawNodes[index], budget))
  }
  const edges: AgentWorkflowGraphEdgeV1[] = []
  for (let index = 0; index < rawEdges.length; index += 1) {
    if (!Object.hasOwn(rawEdges, index)) throw new InvalidRequestError()
    edges.push(parseEdge(rawEdges[index], budget))
  }
  const parsed: ParsedRequest = {
    actionId,
    originSessionId,
    graph: {
      schema: AGENT_WORKFLOW_GRAPH_SCHEMA,
      version: AGENT_WORKFLOW_GRAPH_VERSION,
      name,
      description,
      nodes,
      edges,
    },
  }
  if (Buffer.byteLength(stableJson(parsed), 'utf8') > MAX_REQUEST_BYTES) throw new InvalidRequestError()
  return parsed
}

function finiteBound(value: unknown, integer: boolean): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) throw new InventoryUnavailableError()
  return value
}

function optionValue(value: unknown): string | number {
  if (typeof value === 'string' && value.length <= MAX_PARAM_STRING && !hasForbiddenText(value)) return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new InventoryUnavailableError()
}

const OPTIONAL_PARAM_RULES: ParamRules = {
  required: false,
  allowEmpty: true,
  workspacePath: false,
}

function extensionParamContract(value: unknown): { id: string, contract: ParamContract } {
  if (!isPlainOwnRecord(value) || !boundedString(value.id, 64) || !SAFE_PARAM_ID.test(value.id) || typeof value.type !== 'string') {
    throw new InventoryUnavailableError()
  }
  if (value.type === 'boolean') {
    if (typeof value.default !== 'boolean') throw new InventoryUnavailableError()
    return { id: value.id, contract: { ...OPTIONAL_PARAM_RULES, type: 'boolean', hasDefault: true, default: value.default } }
  }
  if (value.type === 'string') {
    if (typeof value.default !== 'string' || value.default.length > MAX_PARAM_STRING || hasForbiddenText(value.default)) throw new InventoryUnavailableError()
    return { id: value.id, contract: { ...OPTIONAL_PARAM_RULES, type: 'string', hasDefault: true, default: value.default } }
  }
  if (value.type === 'int' || value.type === 'float') {
    const integer = value.type === 'int'
    const defaultValue = finiteBound(value.default, integer)
    const min = finiteBound(value.min, integer)
    const max = finiteBound(value.max, integer)
    if (defaultValue === undefined || (min !== undefined && max !== undefined && min > max)
      || (min !== undefined && defaultValue < min) || (max !== undefined && defaultValue > max)) throw new InventoryUnavailableError()
    return { id: value.id, contract: { ...OPTIONAL_PARAM_RULES, type: value.type, hasDefault: true, default: defaultValue, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) } }
  }
  if (value.type === 'select') {
    const defaultValue = optionValue(value.default)
    const options = new Set<string | number>()
    if (value.options !== undefined) {
      if (!Array.isArray(value.options) || value.options.length > 256) throw new InventoryUnavailableError()
      for (const rawOption of value.options) {
        if (!isPlainOwnRecord(rawOption) || !Object.prototype.hasOwnProperty.call(rawOption, 'value')) throw new InventoryUnavailableError()
        const normalized = optionValue(rawOption.value)
        if (options.has(normalized)) throw new InventoryUnavailableError()
        options.add(normalized)
      }
    }
    if (options.size === 0) options.add(defaultValue)
    if (!options.has(defaultValue)) throw new InventoryUnavailableError()
    return { id: value.id, contract: { ...OPTIONAL_PARAM_RULES, type: 'select', hasDefault: true, default: defaultValue, options } }
  }
  throw new InventoryUnavailableError()
}

function builtinParamContract(value: WorkflowBuiltinParamContract): ParamContract {
  const hasDefault = Object.prototype.hasOwnProperty.call(value, 'default')
  const rules: ParamRules = {
    required: value.required,
    ...(value.requiredWhen ? { requiredWhen: value.requiredWhen } : {}),
    ...(value.forbiddenWhen ? { forbiddenWhen: value.forbiddenWhen } : {}),
    allowEmpty: value.allowEmpty ?? false,
    workspacePath: value.workspacePath ?? false,
  }
  if (value.type === 'select') {
    return { ...rules, type: 'select', hasDefault, ...(hasDefault ? { default: value.default } : {}), options: new Set(value.options) }
  }
  return { ...rules, ...value, hasDefault } as ParamContract
}

function inputPorts(node: ListedExtensionNode): InputPort[] {
  if (Array.isArray(node.inputs) && node.inputs.length > 0) {
    const names = new Set<string>()
    return node.inputs.map((port) => {
      if (!port || typeof port !== 'object' || !boundedString(port.name, 64) || !SAFE_PARAM_ID.test(port.name)
        || names.has(port.name) || !boundedString(port.type, 80)
        || (port.required !== undefined && typeof port.required !== 'boolean')) throw new InventoryUnavailableError()
      names.add(port.name)
      if (port.multiple === true) throw new GraphInvalidError()
      if (port.multiple !== undefined || port.min_items !== undefined || port.max_items !== undefined || port.ordered !== undefined) {
        throw new InventoryUnavailableError()
      }
      return { name: port.name, type: port.type, required: port.required ?? true }
    })
  }
  if (node.input === 'none') return []
  if (!boundedString(node.input, 80)) throw new InventoryUnavailableError()
  return [{ name: null, type: node.input, required: true }]
}

function assertSupportedVideoExtensionShape(node: IndexedExtensionNode): void {
  const hasVideoArrayInput = Array.isArray(node.inputs) && node.inputs.some((port) => port?.type === 'video')
  if (node.extensionType === 'process' && node.output === 'video') throw new GraphInvalidError()
  if (hasVideoArrayInput) throw new GraphInvalidError()
  if (node.extensionType === 'process' && node.input === 'video') throw new GraphInvalidError()
}

function extensionContract(node: IndexedExtensionNode, capabilityId: string): NodeContract {
  if (!boundedString(node.output, 80)) throw new InventoryUnavailableError()
  assertSupportedVideoExtensionShape(node)
  const params = new Map<string, ParamContract>()
  if (!Array.isArray(node.paramsSchema) || node.paramsSchema.length > 64) throw new InventoryUnavailableError()
  for (const rawParam of node.paramsSchema) {
    const normalized = extensionParamContract(rawParam)
    if (params.has(normalized.id)) throw new InventoryUnavailableError()
    params.set(normalized.id, normalized.contract)
  }
  return { storedType: 'extensionNode', extensionId: capabilityId, inputs: inputPorts(node), output: node.output, params }
}

function builtinContract(type: string): NodeContract | undefined {
  const contract = WORKFLOW_BUILTIN_NODE_CONTRACTS[type as keyof typeof WORKFLOW_BUILTIN_NODE_CONTRACTS]
  if (!contract) return undefined
  const params = new Map<string, ParamContract>()
  for (const [id, rawParam] of Object.entries(contract.params)) params.set(id, builtinParamContract(rawParam))
  return {
    storedType: type,
    builtinType: type as WorkflowBuiltinNodeType,
    ...('agentSourceAuthority' in contract ? { agentSourceAuthority: contract.agentSourceAuthority } : {}),
    inputs: contract.input === null ? [] : [{ name: null, type: contract.input, required: true }],
    output: contract.output,
    params,
  }
}

function extensionIndex(extensions: readonly ListedExtension[]): Map<string, IndexedExtensionNode> {
  const index = new Map<string, IndexedExtensionNode>()
  const ambiguous = new Set<string>()
  for (const extension of extensions) {
    if (extension.trusted !== true) continue
    if (!boundedString(extension.id, 128)) throw new InventoryUnavailableError()
    for (const node of extension.nodes) {
      const id = `${extension.id}/${node.id}`
      if (!SAFE_CAPABILITY_ID.test(id)) throw new InventoryUnavailableError()
      if (index.has(id)) ambiguous.add(id)
      else index.set(id, { ...node, extensionType: extension.type })
    }
  }
  if (ambiguous.size > 0) throw new InventoryUnavailableError()
  return index
}

function assertParamValue(contract: ParamContract, value: AgentWorkflowParamValue): void {
  if (contract.type === 'boolean') {
    if (typeof value !== 'boolean') throw new GraphInvalidError()
    return
  }
  if (contract.type === 'string') {
    if (typeof value !== 'string' || value.length > MAX_PARAM_STRING || hasForbiddenText(value)
      || (!contract.allowEmpty && value.trim().length === 0)
      || (contract.workspacePath && !isSafeWorkflowWorkspacePath(value))) throw new GraphInvalidError()
    return
  }
  if (contract.type === 'select') {
    if (!contract.options.has(value as string | number)) throw new GraphInvalidError()
    return
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || (contract.type === 'int' && !Number.isInteger(value))) throw new GraphInvalidError()
  if (contract.min !== undefined && value < contract.min) throw new GraphInvalidError()
  if (contract.max !== undefined && value > contract.max) throw new GraphInvalidError()
}

function hydrateParams(contract: NodeContract, supplied: Record<string, AgentWorkflowParamValue>): Record<string, AgentWorkflowParamValue> {
  for (const key of Object.keys(supplied)) if (!contract.params.has(key)) throw new GraphInvalidError()
  const effective: Record<string, AgentWorkflowParamValue> = { ...supplied }
  for (const [key, param] of contract.params) {
    if (!Object.prototype.hasOwnProperty.call(effective, key) && param.hasDefault && param.default !== undefined) {
      effective[key] = param.default
    }
  }
  const result: Record<string, AgentWorkflowParamValue> = {}
  for (const key of [...contract.params.keys()].sort()) {
    const param = contract.params.get(key)!
    const present = Object.prototype.hasOwnProperty.call(effective, key)
    const required = param.required
      || (param.requiredWhen !== undefined && effective[param.requiredWhen.param] === param.requiredWhen.equals)
    const forbidden = param.forbiddenWhen !== undefined
      && effective[param.forbiddenWhen.param] === param.forbiddenWhen.equals
    if (!present) {
      if (required) throw new GraphInvalidError()
      continue
    }
    if (forbidden) throw new GraphInvalidError()
    const value = effective[key]!
    assertParamValue(param, value)
    result[key] = value
  }
  return result
}

function resolveContracts(graph: AgentWorkflowGraphV1, index: Map<string, IndexedExtensionNode>): Map<string, NodeContract> {
  const result = new Map<string, NodeContract>()
  for (const node of graph.nodes) {
    if (result.has(node.key)) throw new GraphInvalidError()
    if (node.kind === 'builtin') {
      const resolved = builtinContract(node.type)
      if (!resolved) throw new GraphInvalidError()
      result.set(node.key, resolved)
      continue
    }
    const inventoryNode = index.get(node.type)
    if (!inventoryNode) throw new GraphInvalidError()
    result.set(node.key, extensionContract(inventoryNode, node.type))
  }
  return result
}

function hydrateGraphParams(
  graph: AgentWorkflowGraphV1,
  contracts: Map<string, NodeContract>,
): Map<string, Record<string, AgentWorkflowParamValue>> {
  const hydrated = new Map<string, Record<string, AgentWorkflowParamValue>>()
  for (const node of graph.nodes) {
    hydrated.set(node.key, hydrateParams(contracts.get(node.key)!, node.params))
  }
  return hydrated
}

async function validateAgentSources(
  graph: AgentWorkflowGraphV1,
  contracts: Map<string, NodeContract>,
  hydratedParams: Map<string, Record<string, AgentWorkflowParamValue>>,
  validateWorkspaceSource: AgentWorkflowAuthorityDependencies['validateWorkspaceSource'],
): Promise<void> {
  for (const node of graph.nodes) {
    const contract = contracts.get(node.key)!
    if (!contract.builtinType || contract.inputs.length > 0 || contract.output === null) continue
    const authority = contract.agentSourceAuthority
    if (!authority || authority.kind === 'unsupported') throw new GraphInvalidError()
    const params = hydratedParams.get(node.key)!
    if (authority.kind === 'inline') continue
    if (authority.kind === 'current') {
      if (params[authority.discriminator] !== authority.value) throw new GraphInvalidError()
      continue
    }
    const workspacePath = params[authority.pathParam]
    if (!isSafeWorkflowWorkspacePath(workspacePath)) throw new GraphInvalidError()
    let exists = false
    try {
      exists = await validateWorkspaceSource({ kind: authority.sourceKind, workspacePath })
    } catch {
      exists = false
    }
    if (!exists) throw new GraphInvalidError()
  }
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

/** Validates the workspace reference used by the existing video/scene runtime. */
export async function validateAgentWorkspaceSource(
  workspaceDir: string,
  source: AgentWorkflowWorkspaceSource,
): Promise<boolean> {
  if (!path.isAbsolute(workspaceDir) || !isSafeWorkflowWorkspacePath(source.workspacePath)) return false
  try {
    const rootInfo = await lstat(workspaceDir)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return false
    const canonicalRoot = await realpath(workspaceDir)
    const requested = path.resolve(workspaceDir, ...source.workspacePath.split('/'))
    if (!pathIsWithin(path.resolve(workspaceDir), requested)) return false

    let target = requested
    if (source.kind === 'scene' || source.kind === 'capture') {
      const requestedInfo = await lstat(requested)
      if (requestedInfo.isSymbolicLink()) return false
      const manifestName = source.kind === 'scene' ? 'scene-manifest.json' : 'capture-manifest.json'
      if (requestedInfo.isDirectory()) target = path.join(requested, manifestName)
      else if (path.basename(requested) !== manifestName) return false
    }
    const targetInfo = await lstat(target)
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink() || targetInfo.size <= 0) return false
    const canonicalTarget = await realpath(target)
    if (!pathIsWithin(canonicalRoot, canonicalTarget)) return false
    if (source.kind === 'scene') {
      if (targetInfo.size > MAX_SCENE_MANIFEST_BYTES) return false
      const manifest = JSON.parse(await readFile(canonicalTarget, 'utf8')) as unknown
      if (!isPlainOwnRecord(manifest) || manifest.schema !== 'modly.scene-manifest.v1'
        || !Array.isArray(manifest.assets)) return false
      if (manifest.sceneRoot !== '.' && !isSafeWorkflowWorkspacePath(manifest.sceneRoot)) return false
    }
    if (source.kind === 'capture') {
      if (targetInfo.size > MAX_SCENE_MANIFEST_BYTES) return false
      const manifest = JSON.parse(await readFile(canonicalTarget, 'utf8')) as unknown
      if (!isPlainOwnRecord(manifest) || manifest.schema !== 'modly.capture-manifest.v1'
        || (manifest.kind !== 'frames' && manifest.kind !== 'video')) return false
      if (manifest.captureRoot !== '.' && !isSafeWorkflowWorkspacePath(manifest.captureRoot)) return false
    }
    return true
  } catch {
    return false
  }
}

function portKey(target: string, handle: string | undefined): string {
  return `${target}\0${handle ?? ''}`
}

function validateGraph(graph: AgentWorkflowGraphV1, contracts: Map<string, NodeContract>): string[] {
  const nodes = new Map(graph.nodes.map((node) => [node.key, node]))
  const incoming = new Map<string, AgentWorkflowGraphEdgeV1[]>()
  const outgoing = new Map<string, AgentWorkflowGraphEdgeV1[]>()
  const targetCounts = new Map<string, number>()
  const signatures = new Set<string>()

  for (const edge of graph.edges) {
    const sourceNode = nodes.get(edge.source)
    const targetNode = nodes.get(edge.target)
    if (!sourceNode || !targetNode || edge.source === edge.target) throw new GraphInvalidError()
    const signature = `${edge.source}\0${edge.sourceHandle ?? ''}\0${edge.target}\0${edge.targetHandle ?? ''}`
    if (signatures.has(signature)) throw new GraphInvalidError()
    signatures.add(signature)
    const sourceContract = contracts.get(edge.source)!
    const targetContract = contracts.get(edge.target)!
    if (sourceContract.output === null || edge.sourceHandle !== undefined) throw new GraphInvalidError()
    const namedInputs = targetContract.inputs.some((port) => port.name !== null)
    const targetPort = namedInputs
      ? targetContract.inputs.find((port) => port.name === edge.targetHandle)
      : edge.targetHandle === undefined ? targetContract.inputs[0] : undefined
    if (!targetPort || sourceContract.output !== targetPort.type) throw new GraphInvalidError()
    const targetKey = portKey(edge.target, edge.targetHandle)
    const nextCount = (targetCounts.get(targetKey) ?? 0) + 1
    if (nextCount > 1) throw new GraphInvalidError()
    targetCounts.set(targetKey, nextCount)
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge])
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge])
  }

  const indegree = new Map(graph.nodes.map((node) => [node.key, 0]))
  for (const edge of graph.edges) indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
  const queue = [...graph.nodes.map((node) => node.key).filter((key) => indegree.get(key) === 0)].sort()
  const ordered: string[] = []
  while (queue.length > 0) {
    const key = queue.shift()!
    ordered.push(key)
    for (const edge of [...(outgoing.get(key) ?? [])].sort((left, right) => left.target.localeCompare(right.target))) {
      const next = (indegree.get(edge.target) ?? 0) - 1
      indegree.set(edge.target, next)
      if (next === 0) {
        queue.push(edge.target)
        queue.sort()
      }
    }
  }
  if (ordered.length !== graph.nodes.length) throw new GraphInvalidError()

  const activeNodes = graph.nodes.filter((node) => node.enabled)
  if (activeNodes.length === 0) throw new GraphInvalidError()
  const activeKeys = new Set(activeNodes.map((node) => node.key))
  const activeIncoming = (key: string) => (incoming.get(key) ?? []).filter((edge) => activeKeys.has(edge.source))
  const activeOutgoing = (key: string) => (outgoing.get(key) ?? []).filter((edge) => activeKeys.has(edge.target))
  const sources = activeNodes.filter((node) => activeIncoming(node.key).length === 0)
  const sinks = activeNodes.filter((node) => activeOutgoing(node.key).length === 0)
  if (sources.length === 0 || sinks.length === 0) throw new GraphInvalidError()
  if (sources.some((node) => contracts.get(node.key)!.inputs.length > 0)) throw new GraphInvalidError()
  if (sinks.some((node) => contracts.get(node.key)!.output !== null)) throw new GraphInvalidError()

  for (const node of activeNodes) {
    const contract = contracts.get(node.key)!
    for (const port of contract.inputs) {
      const count = activeIncoming(node.key).filter((edge) => edge.targetHandle === (port.name ?? undefined)).length
      if (port.required && count === 0) throw new GraphInvalidError()
    }
  }

  const visited = new Set<string>()
  const visitQueue = [activeNodes[0]!.key]
  while (visitQueue.length > 0) {
    const key = visitQueue.shift()!
    if (visited.has(key)) continue
    visited.add(key)
    const neighbors = [
      ...activeIncoming(key).map((edge) => edge.source),
      ...activeOutgoing(key).map((edge) => edge.target),
    ].sort()
    for (const neighbor of neighbors) if (!visited.has(neighbor)) visitQueue.push(neighbor)
  }
  if (visited.size !== activeNodes.length) throw new GraphInvalidError()
  return ordered
}

function deterministicPositions(graph: AgentWorkflowGraphV1, orderedKeys: string[]): Map<string, { x: number, y: number }> {
  const depths = new Map<string, number>()
  const predecessors = new Map<string, string[]>()
  for (const edge of graph.edges) predecessors.set(edge.target, [...(predecessors.get(edge.target) ?? []), edge.source])
  for (const key of orderedKeys) {
    const prior = predecessors.get(key) ?? []
    depths.set(key, prior.length === 0 ? 0 : Math.max(...prior.map((item) => depths.get(item) ?? 0)) + 1)
  }
  const levelIndex = new Map<number, number>()
  const result = new Map<string, { x: number, y: number }>()
  const byKey = new Map(graph.nodes.map((node) => [node.key, node]))
  for (const key of orderedKeys) {
    const supplied = byKey.get(key)?.position
    if (supplied) {
      result.set(key, supplied)
      continue
    }
    const depth = depths.get(key) ?? 0
    const row = levelIndex.get(depth) ?? 0
    levelIndex.set(depth, row + 1)
    result.set(key, { x: depth * 320, y: row * 220 })
  }
  return result
}

function assertGeneratedId(id: string, seen: Set<string>): void {
  if (!SAFE_ID.test(id) || seen.has(id)) throw new Error('Generated workflow ids must be safe and unique.')
  seen.add(id)
}

function createWorkflow(
  graph: AgentWorkflowGraphV1,
  contracts: Map<string, NodeContract>,
  hydratedParams: Map<string, Record<string, AgentWorkflowParamValue>>,
  orderedKeys: string[],
  now: Date,
  createId: () => string,
): AgentCreatedWorkflow {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid workflow clock.')
  const timestamp = now.toISOString()
  const positions = deterministicPositions(graph, orderedKeys)
  const inputNodes = new Map(graph.nodes.map((node) => [node.key, node]))
  const generated = new Set<string>()
  const workflowId = createId()
  assertGeneratedId(workflowId, generated)
  const nodeIds = new Map<string, string>()
  const nodes: AgentCreatedWorkflowNode[] = []
  for (const key of orderedKeys) {
    const input = inputNodes.get(key)!
    const contract = contracts.get(key)!
    const id = createId()
    assertGeneratedId(id, generated)
    nodeIds.set(key, id)
    nodes.push({
      id,
      type: contract.storedType,
      position: positions.get(key)!,
      data: {
        ...(contract.extensionId ? { extensionId: contract.extensionId } : {}),
        enabled: input.enabled,
        showInGenerate: input.showInGenerate,
        params: hydratedParams.get(key)!,
      },
    })
  }
  const edges: AgentCreatedWorkflowEdge[] = graph.edges.map((input) => {
    const id = createId()
    assertGeneratedId(id, generated)
    return {
      id,
      source: nodeIds.get(input.source)!,
      target: nodeIds.get(input.target)!,
      ...(input.sourceHandle ? { sourceHandle: input.sourceHandle } : {}),
      ...(input.targetHandle ? { targetHandle: input.targetHandle } : {}),
    }
  })
  return { id: workflowId, name: graph.name, description: graph.description, nodes, edges, createdAt: timestamp, updatedAt: timestamp }
}

export interface AtomicWriteAgentWorkflowOptions {
  createTempId?: () => string
  link?: typeof link
  remove?: typeof rm
  syncDirectory?: (workflowsDir: string) => Promise<void>
  onPostPublishIssue?: (issue: AgentWorkflowPostPublishIssue) => void
}

export type AgentWorkflowPostPublishIssue = {
  code: 'temp_cleanup_failed' | 'directory_sync_failed'
}

type FileIdentity = {
  dev: number
  ino: number
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function reportPostPublishIssue(
  options: AtomicWriteAgentWorkflowOptions,
  issue: AgentWorkflowPostPublishIssue,
): void {
  try {
    if (options.onPostPublishIssue) options.onPostPublishIssue(issue)
    else console.warn(`[Agent workflows] ${issue.code}`)
  } catch {
    // Diagnostics must never convert an already-published workflow into a failure.
  }
}

async function removeOwnedTemp(
  temp: string,
  identity: FileIdentity,
  remove: typeof rm,
): Promise<boolean> {
  for (let attempt = 0; attempt < TEMP_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      const current = await lstat(temp)
      if (!current.isFile() || current.isSymbolicLink() || !sameFileIdentity(current, identity)) return false
      await remove(temp)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    }
  }
  return false
}

async function syncWorkflowDirectory(workflowsDir: string): Promise<void> {
  const directoryHandle = await open(workflowsDir, 'r')
  try { await directoryHandle.sync() } finally { await directoryHandle.close() }
}

async function publishedWorkflowMatches(
  target: string,
  identity: FileIdentity,
  serialized: string,
  workflow: AgentCreatedWorkflow,
): Promise<boolean> {
  try {
    const targetInfo = await lstat(target)
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink() || targetInfo.size > MAX_WORKFLOW_BYTES
      || !sameFileIdentity(targetInfo, identity)) return false
    const contents = await readFile(target, 'utf8')
    if (contents === serialized) return true
    return stableJson(JSON.parse(contents)) === stableJson(workflow)
  } catch {
    return false
  }
}

export async function atomicWriteAgentWorkflow(
  workflowsDir: string,
  workflow: AgentCreatedWorkflow,
  options: AtomicWriteAgentWorkflowOptions = {},
): Promise<void> {
  if (!path.isAbsolute(workflowsDir) || !SAFE_ID.test(workflow.id)) throw new Error('Invalid Agent workflow persistence target.')
  const serialized = `${stableJson(workflow, true)}\n`
  if (Buffer.byteLength(serialized, 'utf8') > MAX_WORKFLOW_BYTES) throw new Error('Agent workflow exceeds the persistence limit.')
  await mkdir(workflowsDir, { recursive: true, mode: 0o700 })
  const tempId = options.createTempId?.() ?? randomUUID()
  if (!SAFE_ID.test(tempId)) throw new Error('Invalid Agent workflow temp id.')
  const target = path.join(workflowsDir, `${workflow.id}.json`)
  const temp = path.join(workflowsDir, `.${workflow.id}.${tempId}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let tempIdentity: FileIdentity | undefined
  let published = false
  try {
    handle = await open(temp, 'wx', 0o600)
    const tempInfo = await handle.stat()
    tempIdentity = { dev: tempInfo.dev, ino: tempInfo.ino }
    await handle.writeFile(serialized, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    // Hard-link publication is same-directory, atomic, and fails with EEXIST;
    // unlike rename(), it can never clobber an existing workflow id.
    await (options.link ?? link)(temp, target)
    published = true
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    if (tempIdentity) {
      const removed = await removeOwnedTemp(temp, tempIdentity, options.remove ?? rm)
      if (!removed) reportPostPublishIssue(options, { code: 'temp_cleanup_failed' })
    }
    throw error
  }

  if (!published || !tempIdentity) throw new Error('Agent workflow publication state is invalid.')
  const tempRemoved = await removeOwnedTemp(temp, tempIdentity, options.remove ?? rm)
  let directorySynced = true
  try {
    await (options.syncDirectory ?? syncWorkflowDirectory)(workflowsDir)
  } catch {
    directorySynced = false
  }
  if (tempRemoved && directorySynced) return

  if (!tempRemoved) reportPostPublishIssue(options, { code: 'temp_cleanup_failed' })
  if (!directorySynced) reportPostPublishIssue(options, { code: 'directory_sync_failed' })
  if (!await publishedWorkflowMatches(target, tempIdentity, serialized, workflow)) {
    throw new Error('Published Agent workflow could not be reconciled.')
  }
}

export interface AgentWorkflowAuthorityLike {
  create(request: unknown): Promise<AgentWorkflowCreateResult>
}

export class AgentWorkflowAuthority implements AgentWorkflowAuthorityLike {
  private readonly records = new Map<string, ActionRecord>()
  private readonly dependencies: AgentWorkflowAuthorityDependencies
  private readonly now: () => Date
  private readonly createId: () => string
  private readonly actionClock: () => number
  private readonly maxActionRecords: number
  private readonly actionRecordTtlMs: number
  private readonly persistWorkflow: (workflowsDir: string, workflow: AgentCreatedWorkflow) => Promise<void>

  constructor(dependencies: AgentWorkflowAuthorityDependencies) {
    this.dependencies = dependencies
    this.now = dependencies.now ?? (() => new Date())
    this.createId = dependencies.createId ?? randomUUID
    this.actionClock = dependencies.actionClock ?? Date.now
    this.maxActionRecords = dependencies.maxActionRecords ?? DEFAULT_MAX_ACTION_RECORDS
    this.actionRecordTtlMs = dependencies.actionRecordTtlMs ?? DEFAULT_ACTION_RECORD_TTL_MS
    if (!Number.isSafeInteger(this.maxActionRecords) || this.maxActionRecords < 1
      || !Number.isSafeInteger(this.actionRecordTtlMs) || this.actionRecordTtlMs < 1) {
      throw new Error('Invalid Agent workflow idempotency configuration.')
    }
    this.persistWorkflow = dependencies.persistWorkflow ?? atomicWriteAgentWorkflow
  }

  async create(requestValue: unknown): Promise<AgentWorkflowCreateResult> {
    let request: ParsedRequest
    try { request = parseRequest(requestValue) } catch { return failure('invalid_request') }
    const digest = createHash('sha256').update(stableJson(request)).digest('hex')
    let actionNow: number
    try {
      actionNow = this.actionClock()
      if (!Number.isSafeInteger(actionNow)) throw new Error('Invalid action clock.')
    } catch { return failure('invalid_request') }
    this.pruneExpiredRecords(actionNow)
    const existing = this.records.get(request.actionId)
    if (existing) {
      if (existing.digest !== digest) return failure('invalid_request')
      existing.lastAccessedAt = Math.max(existing.lastAccessedAt, actionNow)
      return existing.result
    }
    if (!this.makeRecordCapacity()) return failure('invalid_request')
    const result = this.execute(request)
    const record: ActionRecord = { digest, result, state: 'in-flight', lastAccessedAt: actionNow }
    this.records.set(request.actionId, record)
    void result.then(
      () => this.settleRecord(request.actionId, record),
      () => this.settleRecord(request.actionId, record),
    )
    return result
  }

  private pruneExpiredRecords(now: number): void {
    for (const [actionId, record] of this.records) {
      if (record.state === 'settled' && record.settledAt !== undefined
        && now - record.settledAt >= this.actionRecordTtlMs) this.records.delete(actionId)
    }
  }

  private makeRecordCapacity(): boolean {
    while (this.records.size >= this.maxActionRecords) {
      const settled = [...this.records.entries()]
        .filter((entry): entry is [string, ActionRecord & { state: 'settled' }] => entry[1].state === 'settled')
        .sort(([leftId, left], [rightId, right]) => left.lastAccessedAt - right.lastAccessedAt
          || (left.settledAt ?? 0) - (right.settledAt ?? 0)
          || leftId.localeCompare(rightId))[0]
      if (!settled) return false
      this.records.delete(settled[0])
    }
    return true
  }

  private settleRecord(actionId: string, record: ActionRecord): void {
    if (this.records.get(actionId) !== record) return
    let now: number
    try { now = this.actionClock() } catch { now = record.lastAccessedAt }
    if (!Number.isSafeInteger(now)) now = record.lastAccessedAt
    now = Math.max(record.lastAccessedAt, now)
    record.state = 'settled'
    record.settledAt = now
    record.lastAccessedAt = now
    this.pruneExpiredRecords(now)
  }

  private async execute(request: AgentWorkflowCreateRequest): Promise<AgentWorkflowCreateResult> {
    let inventory: ExtensionInventory
    try {
      inventory = await this.dependencies.discoverExtensions()
      if (!inventory || !Array.isArray(inventory.extensions) || !Array.isArray(inventory.errors) || inventory.errors.length > 0) {
        return failure('inventory_unavailable')
      }
    } catch { return failure('inventory_unavailable') }

    let workflow: AgentCreatedWorkflow
    try {
      const index = extensionIndex(inventory.extensions)
      const contracts = resolveContracts(request.graph, index)
      const ordered = validateGraph(request.graph, contracts)
      const hydratedParams = hydrateGraphParams(request.graph, contracts)
      await validateAgentSources(request.graph, contracts, hydratedParams, this.dependencies.validateWorkspaceSource)
      workflow = createWorkflow(request.graph, contracts, hydratedParams, ordered, this.now(), this.createId)
      if (Buffer.byteLength(stableJson(workflow), 'utf8') > MAX_WORKFLOW_BYTES) return failure('invalid_request')
    } catch (error) {
      return failure(error instanceof InventoryUnavailableError ? 'inventory_unavailable' : 'graph_invalid')
    }

    let writeStarted = false
    try {
      const status = await this.dependencies.commitIfOriginSessionActive(request.originSessionId, async () => {
        writeStarted = true
        await this.persistWorkflow(this.dependencies.getWorkflowsDir(), workflow)
      })
      if (status === 'inactive') return failure('origin_inactive')
      if (status === 'commit_failed') return failure('write_failed')
      return status === 'committed' ? { ok: true, workflow } : failure('write_failed')
    } catch {
      return failure(writeStarted ? 'write_failed' : 'origin_inactive')
    }
  }
}

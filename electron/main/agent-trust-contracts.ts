import { createHash } from 'node:crypto'

import { ARTIFACT_KINDS, type ArtifactKind } from '../../src/shared/types/artifacts.ts'
import {
  AGENT_ACTION_STATUSES,
  type AgentActionPublicSummaryV1,
  type AgentActionEventV1,
  type AgentActionStatus,
  type AgentActionV1,
  type AgentCapabilitySnapshotV1,
  type AgentOllamaModelSnapshotV1,
  type ArtifactRefV1,
  type JsonValue,
} from '../../src/shared/types/agentActions.ts'

const SHA256_PATTERN = /^(?:sha256:)?[a-f0-9]{64}$/
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const ARTIFACT_KIND_SET = new Set<string>(ARTIFACT_KINDS)
const ACTION_STATUS_SET = new Set<string>(AGENT_ACTION_STATUSES)
const OLLAMA_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,2}(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/
const WINDOWS_FORBIDDEN_SEGMENT_CHARACTER_PATTERN = /[<>:"|?*]/
const WINDOWS_RESERVED_SEGMENT_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

function fail(message: string): never {
  throw new TypeError(`Invalid canonical JSON: ${message}`)
}

function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === 'string' && ARTIFACT_KIND_SET.has(value)
}

function isAgentActionStatus(value: unknown): value is AgentActionStatus {
  return typeof value === 'string' && ACTION_STATUS_SET.has(value)
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`)
  }
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') throw new TypeError(`${label} contains a symbol key`)
    if (!allowedSet.has(key)) throw new TypeError(`${label} contains unknown field "${key}"`)
  }
}

function assertString(value: unknown, label: string, maxLength = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.length > maxLength) {
    throw new TypeError(`${label} must be a non-empty trimmed string of at most ${maxLength} characters`)
  }
  if (hasControlCharacter(value)) throw new TypeError(`${label} must not contain control characters`)
  if (hasLoneSurrogate(value)) throw new TypeError(`${label} must not contain lone surrogate code points`)
  return value
}

function assertSafeId(value: unknown, label: string): string {
  const id = assertString(value, label, 128)
  if (!SAFE_ID_PATTERN.test(id)) throw new TypeError(`${label} is malformed`)
  return id
}

function assertIsoTimestamp(value: unknown, label: string): string {
  const timestamp = assertString(value, label, 64)
  const milliseconds = Date.parse(timestamp)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    throw new TypeError(`${label} must be a canonical ISO-8601 timestamp`)
  }
  return timestamp
}

function serializeCanonical(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fail('numbers must be finite')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) return fail('strings must not contain lone surrogate code points')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object' || value === undefined) return fail(`unsupported value type ${typeof value}`)
  if (seen.has(value)) return fail('cyclic values are not supported')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return fail('arrays must use the standard Array prototype')
      const ownKeys = Reflect.ownKeys(value)
      if (ownKeys.some((key) => typeof key === 'symbol')) return fail('arrays must not contain a symbol key')
      if (ownKeys.some((key) => typeof key === 'string' && key !== 'length' && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
        return fail('arrays must not have extra enumerable properties')
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) return fail('sparse arrays are not supported')
      }
      if (Object.keys(value).some((key) => !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
        return fail('arrays must not have extra enumerable properties')
      }
      return `[${value.map((entry) => {
        if (entry === undefined) return fail('array values must not be undefined')
        return serializeCanonical(entry, seen)
      }).join(',')}]`
    }

    assertPlainRecord(value, 'Canonical JSON value')
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.some((key) => typeof key === 'symbol')) return fail('objects must not contain a symbol key')
    const keys = ownKeys.filter((key): key is string => typeof key === 'string').sort()
    const entries: string[] = []
    for (const key of keys) {
      if (UNSAFE_OBJECT_KEYS.has(key)) return fail(`unsafe object key "${key}"`)
      if (hasLoneSurrogate(key)) return fail('object keys must not contain lone surrogate code points')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) return fail(`object field "${key}" must be a data property`)
      if (!descriptor.enumerable) return fail(`object field "${key}" must be enumerable`)
      const entry = descriptor.value
      if (entry === undefined) return fail(`object field "${key}" must not be undefined`)
      entries.push(`${JSON.stringify(key)}:${serializeCanonical(entry, seen)}`)
    }
    return `{${entries.join(',')}}`
  } finally {
    seen.delete(value)
  }
}

/**
 * Canonical JSON subset used for trust-boundary hashes.
 *
 * Object keys are UTF-16 sorted, -0 is encoded as 0, finite ECMAScript numbers
 * use JSON.stringify encoding, and non-JSON values, cycles, unsafe keys, custom
 * prototypes, and lone surrogates are rejected.
 */
export function canonicalJson(value: unknown): string {
  return serializeCanonical(value, new Set())
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

export function normalizeJsonValue(value: unknown): JsonValue {
  canonicalJson(value)
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') return Object.is(value, -0) ? 0 : value
  if (Array.isArray(value)) return value.map((entry) => normalizeJsonValue(entry))
  assertPlainRecord(value, 'JSON value')
  const normalized: Record<string, JsonValue> = {}
  for (const key of Object.keys(value)) normalized[key] = normalizeJsonValue(value[key])
  return normalized
}

export function assertWorkspaceRelativePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError('Workspace-relative path must be a non-empty trimmed string')
  }
  if (hasControlCharacter(value) || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new TypeError('Workspace-relative path must use normalized relative POSIX syntax')
  }
  const segments = value.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new TypeError('Workspace-relative path must not contain empty, dot, or traversal segments')
  }
  if (segments.some((segment) => WINDOWS_FORBIDDEN_SEGMENT_CHARACTER_PATTERN.test(segment)
    || WINDOWS_RESERVED_SEGMENT_PATTERN.test(segment)
    || /[. ]$/.test(segment))) {
    throw new TypeError('Workspace-relative path contains a Windows-unsafe segment')
  }
  return value
}

function normalizeSha256(value: unknown, label: string, allowPrefix = false): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256 digest`)
  if (!allowPrefix && value.startsWith('sha256:')) throw new TypeError(`${label} must not include a prefix`)
  return value.startsWith('sha256:') ? value : allowPrefix ? `sha256:${value}` : value
}

export function assertArtifactRefV1(value: unknown): ArtifactRefV1 {
  assertPlainRecord(value, 'ArtifactRef v1')
  assertExactKeys(value, ['schema', 'version', 'id', 'kind', 'mediaType', 'workspacePath', 'sha256', 'sizeBytes'], 'ArtifactRef v1')
  if (value.schema !== 'modly.artifact-ref.v1' || value.version !== 1) throw new TypeError('ArtifactRef v1 schema/version is invalid')
  const id = assertSafeId(value.id, 'ArtifactRef v1 id')
  if (!isArtifactKind(value.kind)) throw new TypeError('ArtifactRef v1 kind is invalid')
  const mediaType = assertString(value.mediaType, 'ArtifactRef v1 mediaType', 128).toLowerCase()
  if (!MIME_TYPE_PATTERN.test(mediaType)) throw new TypeError('ArtifactRef v1 mediaType is invalid')
  const workspacePath = assertWorkspaceRelativePath(value.workspacePath)
  const sha256 = normalizeSha256(value.sha256, 'ArtifactRef v1 sha256')
  if (typeof value.sizeBytes !== 'number' || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0) throw new TypeError('ArtifactRef v1 sizeBytes must be a non-negative safe integer')
  return {
    schema: 'modly.artifact-ref.v1', version: 1, id,
    kind: value.kind, mediaType, workspacePath, sha256,
    sizeBytes: value.sizeBytes,
  }
}

function capabilityUnsigned(capability: AgentCapabilitySnapshotV1): Omit<AgentCapabilitySnapshotV1, 'hash'> {
  const { hash: _hash, ...unsigned } = capability
  return unsigned
}

type AgentSnapshotInputs = NonNullable<AgentCapabilitySnapshotV1['node']['inputs']>
type AgentSnapshotInput = AgentSnapshotInputs[number]

function optionalStringField(record: Record<string, unknown>, key: string, label: string, maxLength = 500): string | undefined {
  return record[key] === undefined ? undefined : assertString(record[key], `${label}.${key}`, maxLength)
}

function optionalBooleanField(record: Record<string, unknown>, key: string, label: string): boolean | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new TypeError(`${label}.${key} must be a boolean`)
  return value
}

function assertFiniteNumber(value: unknown, label: string, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value))) {
    throw new TypeError(`${label} must be a ${integer ? 'safe integer' : 'finite number'}`)
  }
  return Object.is(value, -0) ? 0 : value
}

function normalizeShowIf(value: unknown, label: string): Record<string, JsonValue> | undefined {
  if (value === undefined) return undefined
  assertPlainRecord(value, label)
  const normalized: Record<string, JsonValue> = {}
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') throw new TypeError(`${label} contains a symbol key`)
    assertSafeId(key, `${label} key`)
    const condition = value[key]
    if (typeof condition === 'boolean' || typeof condition === 'string') {
      normalized[key] = condition
      continue
    }
    if (typeof condition === 'number' && Number.isFinite(condition)) {
      normalized[key] = Object.is(condition, -0) ? 0 : condition
      continue
    }
    if (!Array.isArray(condition) || condition.length === 0) throw new TypeError(`${label}.${key} must be a scalar or non-empty scalar array`)
    normalized[key] = condition.map((entry, index) => {
      if (typeof entry === 'boolean' || typeof entry === 'string') return entry
      if (typeof entry === 'number' && Number.isFinite(entry)) return Object.is(entry, -0) ? 0 : entry
      throw new TypeError(`${label}.${key}[${index}] must be a finite JSON scalar`)
    })
  }
  canonicalJson(normalized)
  return normalized
}

function normalizeParamUi(value: unknown, label: string): Record<string, JsonValue> | undefined {
  if (value === undefined) return undefined
  assertPlainRecord(value, label)
  assertExactKeys(value, ['control', 'collapsed', 'order', 'help'], label)
  const control = optionalStringField(value, 'control', label, 64)
  const collapsed = optionalBooleanField(value, 'collapsed', label)
  const order = value.order === undefined ? undefined : assertFiniteNumber(value.order, `${label}.order`, true)
  const help = optionalStringField(value, 'help', label)
  return {
    ...(control === undefined ? {} : { control }),
    ...(collapsed === undefined ? {} : { collapsed }),
    ...(order === undefined ? {} : { order }),
    ...(help === undefined ? {} : { help }),
  }
}

function normalizeParamOptions(value: unknown, label: string): JsonValue[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array`)
  return value.map((option, index) => {
    const optionLabel = `${label}[${index}]`
    assertPlainRecord(option, optionLabel)
    assertExactKeys(option, ['value', 'label'], optionLabel)
    const optionValue = option.value
    if (typeof optionValue !== 'string' && (typeof optionValue !== 'number' || !Number.isFinite(optionValue))) {
      throw new TypeError(`${optionLabel}.value must be a string or finite number`)
    }
    return {
      value: Object.is(optionValue, -0) ? 0 : optionValue,
      label: assertString(option.label, `${optionLabel}.label`, 120),
    }
  })
}

function normalizeParamFilters(value: unknown, label: string): JsonValue[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array`)
  return value.map((filter, index) => {
    const filterLabel = `${label}[${index}]`
    assertPlainRecord(filter, filterLabel)
    assertExactKeys(filter, ['name', 'extensions'], filterLabel)
    if (!Array.isArray(filter.extensions) || filter.extensions.length === 0) throw new TypeError(`${filterLabel}.extensions must be a non-empty array`)
    return {
      name: assertString(filter.name, `${filterLabel}.name`, 120),
      extensions: filter.extensions.map((extension, extensionIndex) => {
        const normalized = assertString(extension, `${filterLabel}.extensions[${extensionIndex}]`, 24).toLowerCase()
        if (!/^[a-z0-9][a-z0-9._+-]*$/.test(normalized)) throw new TypeError(`${filterLabel}.extensions[${extensionIndex}] is invalid`)
        return normalized
      }),
    }
  })
}

export function normalizeAgentParamsSchema(value: unknown): JsonValue[] {
  if (!Array.isArray(value)) throw new TypeError('Agent capability paramsSchema must be an array')
  const ids = new Set<string>()
  return value.map((param, index) => {
    const label = `Agent capability paramsSchema[${index}]`
    assertPlainRecord(param, label)
    const type = param.type
    if (type !== 'select' && type !== 'int' && type !== 'float' && type !== 'string' && type !== 'boolean') {
      throw new TypeError(`${label}.type is unsupported`)
    }
    const typeKeys: Record<typeof type, string[]> = {
      select: ['options'],
      int: ['min', 'max', 'step'],
      float: ['min', 'max', 'step'],
      string: ['pickerIntent', 'filters'],
      boolean: [],
    }
    const commonKeys = ['id', 'label', 'type', 'default', 'tooltip', 'advanced', 'group', 'ui', 'show_if']
    assertExactKeys(param, [...commonKeys, ...typeKeys[type]], label)
    const id = assertSafeId(param.id, `${label}.id`)
    if (ids.has(id)) throw new TypeError(`Agent capability paramsSchema contains duplicate id "${id}"`)
    ids.add(id)
    const displayLabel = optionalStringField(param, 'label', label, 120)
    const tooltip = optionalStringField(param, 'tooltip', label)
    const advanced = optionalBooleanField(param, 'advanced', label)
    const group = optionalStringField(param, 'group', label, 120)
    const ui = normalizeParamUi(param.ui, `${label}.ui`)
    const showIf = normalizeShowIf(param.show_if, `${label}.show_if`)
    const base: Record<string, JsonValue> = {
      id,
      type,
      ...(displayLabel === undefined ? {} : { label: displayLabel }),
      ...(tooltip === undefined ? {} : { tooltip }),
      ...(advanced === undefined ? {} : { advanced }),
      ...(group === undefined ? {} : { group }),
      ...(ui === undefined ? {} : { ui }),
      ...(showIf === undefined ? {} : { show_if: showIf }),
    }

    if (type === 'select') {
      const defaultValue = param.default
      if (typeof defaultValue !== 'string' && (typeof defaultValue !== 'number' || !Number.isFinite(defaultValue))) throw new TypeError(`${label}.default is invalid`)
      const normalizedDefault = Object.is(defaultValue, -0) ? 0 : defaultValue
      const options = normalizeParamOptions(param.options, `${label}.options`)
      if (options && !options.some((option) => option !== null
        && typeof option === 'object'
        && !Array.isArray(option)
        && Object.is(option.value, normalizedDefault))) {
        throw new TypeError(`${label}.default must match an option`)
      }
      return { ...base, default: normalizedDefault, ...(options ? { options } : {}) }
    }
    if (type === 'boolean') {
      if (typeof param.default !== 'boolean') throw new TypeError(`${label}.default must be a boolean`)
      return { ...base, default: param.default }
    }
    if (type === 'string') {
      if (typeof param.default !== 'string' || hasLoneSurrogate(param.default)) throw new TypeError(`${label}.default must be a string`)
      const pickerIntent = param.pickerIntent === undefined ? undefined : assertString(param.pickerIntent, `${label}.pickerIntent`, 32)
      if (pickerIntent !== undefined && !['image', 'mesh', 'directory', 'save-path', 'generic-file'].includes(pickerIntent)) {
        throw new TypeError(`${label}.pickerIntent is invalid`)
      }
      const filters = normalizeParamFilters(param.filters, `${label}.filters`)
      return { ...base, default: param.default, ...(pickerIntent ? { pickerIntent } : {}), ...(filters ? { filters } : {}) }
    }

    const integer = type === 'int'
    const defaultValue = assertFiniteNumber(param.default, `${label}.default`, integer)
    const min = param.min === undefined ? undefined : assertFiniteNumber(param.min, `${label}.min`, integer)
    const max = param.max === undefined ? undefined : assertFiniteNumber(param.max, `${label}.max`, integer)
    const step = param.step === undefined ? undefined : assertFiniteNumber(param.step, `${label}.step`, integer)
    if (min !== undefined && max !== undefined && min > max) throw new TypeError(`${label}.min must not exceed max`)
    if (min !== undefined && defaultValue < min) throw new TypeError(`${label}.default is below min`)
    if (max !== undefined && defaultValue > max) throw new TypeError(`${label}.default exceeds max`)
    if (step !== undefined && step <= 0) throw new TypeError(`${label}.step must be positive`)
    return {
      ...base, default: defaultValue,
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
      ...(step === undefined ? {} : { step }),
    }
  })
}

function normalizeAgentInputs(value: unknown): AgentSnapshotInputs | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) throw new TypeError('Agent capability inputs must be a non-empty array')
  const names = new Set<string>()
  return value.map((input, index): AgentSnapshotInput => {
    const label = `Agent capability inputs[${index}]`
    assertPlainRecord(input, label)
    assertExactKeys(input, ['name', 'label', 'type', 'required', 'multiple', 'min_items', 'max_items', 'ordered'], label)
    const name = assertSafeId(input.name, `${label}.name`)
    if (names.has(name)) throw new TypeError(`Agent capability inputs contains duplicate name "${name}"`)
    names.add(name)
    if (!isArtifactKind(input.type)) throw new TypeError(`${label}.type is invalid`)
    const displayLabel = optionalStringField(input, 'label', label, 120)
    const required = optionalBooleanField(input, 'required', label)
    if (input.multiple === undefined) {
      if (input.min_items !== undefined || input.max_items !== undefined || input.ordered !== undefined) throw new TypeError(`${label} repeat fields require multiple=true`)
      return {
        name,
        ...(displayLabel === undefined ? {} : { label: displayLabel }),
        type: input.type,
        ...(required === undefined ? {} : { required }),
      }
    }
    if (input.multiple !== true || input.ordered !== true) throw new TypeError(`${label} repeatable inputs require multiple=true and ordered=true`)
    const minItems = assertFiniteNumber(input.min_items, `${label}.min_items`, true)
    const maxItems = assertFiniteNumber(input.max_items, `${label}.max_items`, true)
    if (minItems < 0 || maxItems < 1 || minItems > maxItems || maxItems > 100) throw new TypeError(`${label} repeat bounds are invalid`)
    return {
      name,
      ...(displayLabel === undefined ? {} : { label: displayLabel }),
      type: input.type,
      ...(required === undefined ? {} : { required }),
      multiple: true,
      min_items: minItems,
      max_items: maxItems,
      ordered: true,
    }
  })
}

export function assertAgentCapabilitySnapshotV1(value: unknown): AgentCapabilitySnapshotV1 {
  assertPlainRecord(value, 'Agent capability snapshot')
  assertExactKeys(value, ['schema', 'version', 'id', 'displayName', 'description', 'extension', 'node', 'approval', 'hash'], 'Agent capability snapshot')
  if (value.schema !== 'modly.agent-capability.v1' || value.version !== 1) throw new TypeError('Agent capability snapshot schema/version is invalid')
  const id = assertString(value.id, 'Agent capability id', 257)
  const idSegments = id.split('/')
  if (idSegments.length !== 2) throw new TypeError('Agent capability id must contain exactly two safe segments')
  idSegments.forEach((segment, index) => assertSafeId(segment, `Agent capability id segment ${index + 1}`))
  const displayName = assertString(value.displayName, 'Agent capability displayName', 80)
  const description = assertString(value.description, 'Agent capability description', 500)

  assertPlainRecord(value.extension, 'Agent capability extension')
  assertExactKeys(value.extension, ['id', 'name', 'version'], 'Agent capability extension')
  const extension = {
    id: assertSafeId(value.extension.id, 'Agent capability extension id'),
    name: assertString(value.extension.name, 'Agent capability extension name', 120),
    ...(value.extension.version === undefined ? {} : { version: assertString(value.extension.version, 'Agent capability extension version', 64) }),
  }

  assertPlainRecord(value.node, 'Agent capability node')
  assertExactKeys(value.node, ['id', 'input', 'output', 'inputs', 'paramsSchema'], 'Agent capability node')
  const nodeId = assertSafeId(value.node.id, 'Agent capability node id')
  const input = assertString(value.node.input, 'Agent capability node input', 64)
  if (!isArtifactKind(input)) throw new TypeError('Agent capability node input is invalid')
  if (!isArtifactKind(value.node.output)) throw new TypeError('Agent capability node output is invalid')
  const paramsSchema = normalizeAgentParamsSchema(value.node.paramsSchema)
  const inputs = normalizeAgentInputs(value.node.inputs)

  assertPlainRecord(value.approval, 'Agent capability approval')
  assertExactKeys(value.approval, ['required', 'scope'], 'Agent capability approval')
  if (value.approval.required !== true || value.approval.scope !== 'single_action') throw new TypeError('Agent capability approval must require single_action approval')
  const hash = normalizeSha256(value.hash, 'Agent capability hash')
  const capability: AgentCapabilitySnapshotV1 = {
    schema: 'modly.agent-capability.v1', version: 1, id, displayName, description,
    extension,
    node: {
      id: nodeId, input, output: value.node.output,
      ...(inputs ? { inputs } : {}), paramsSchema,
    },
    approval: { required: true, scope: 'single_action' }, hash,
  }
  if (id !== `${extension.id}/${nodeId}`) throw new TypeError('Agent capability id must match its extension and node identity')
  if (sha256Canonical(capabilityUnsigned(capability)) !== hash) throw new TypeError('Agent capability hash does not match its snapshot')
  return capability
}

function assertOllamaModelSnapshot(value: unknown): AgentOllamaModelSnapshotV1 {
  assertPlainRecord(value, 'Agent Ollama model snapshot')
  assertExactKeys(value, ['provider', 'endpoint', 'model', 'digest'], 'Agent Ollama model snapshot')
  if (value.provider !== 'ollama') throw new TypeError('Agent model provider must be ollama')
  const endpoint = assertString(value.endpoint, 'Agent Ollama endpoint', 256)
  let parsed: URL
  try { parsed = new URL(endpoint) } catch { throw new TypeError('Agent Ollama endpoint must be a valid URL') }
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]'])
  if (parsed.protocol !== 'http:' || !loopbackHosts.has(parsed.hostname) || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new TypeError('Agent Ollama endpoint must be an uncredentialed local HTTP origin')
  }
  const model = assertString(value.model, 'Agent Ollama model', 200)
  if (!OLLAMA_MODEL_PATTERN.test(model)) {
    throw new TypeError('Agent Ollama model must use a conservative namespace/model:tag identifier')
  }
  const digest = normalizeSha256(value.digest, 'Agent Ollama digest', true)
  return { provider: 'ollama', endpoint, model, digest }
}

function proposalHashPayload(action: {
  schema: 'modly.agent-action.v1'
  version: 1
  id: string
  createdAt: string
  capability: AgentCapabilitySnapshotV1
  argumentsHash: string
  modelHash: string
  inputArtifacts: ArtifactRefV1[]
  approval: { scope: 'single_action', expiresAt: string }
}): Record<string, unknown> {
  return {
    schema: action.schema,
    version: action.version,
    id: action.id,
    createdAt: action.createdAt,
    capabilityHash: action.capability.hash,
    argumentsHash: action.argumentsHash,
    modelHash: action.modelHash,
    inputArtifacts: action.inputArtifacts,
    approval: action.approval,
  }
}

function eventStateHashPayload(input: {
  actionId: string
  proposalHash: string
  approval: { scope: 'single_action', expiresAt: string }
  inputArtifacts: ArtifactRefV1[]
  sequence: number
  status: AgentActionStatus
  at: string
  previousStateHash: string | null
  outputArtifactsHash: string
  errorSummaryHash: string
}): Record<string, unknown> {
  return {
    schema: 'modly.agent-action-state.v1',
    actionId: input.actionId,
    proposalHash: input.proposalHash,
    approval: input.approval,
    inputArtifacts: input.inputArtifacts,
    sequence: input.sequence,
    status: input.status,
    at: input.at,
    previousStateHash: input.previousStateHash,
    outputArtifactsHash: input.outputArtifactsHash,
    errorSummaryHash: input.errorSummaryHash,
  }
}

function createActionEvent(input: {
  actionId: string
  proposalHash: string
  approval: { scope: 'single_action', expiresAt: string }
  inputArtifacts: ArtifactRefV1[]
  sequence: number
  status: AgentActionStatus
  at: string
  previousStateHash: string | null
  outputArtifacts: ArtifactRefV1[]
  errorSummary?: string
}): AgentActionEventV1 {
  const outputArtifactsHash = sha256Canonical(input.outputArtifacts)
  const errorSummaryHash = sha256Canonical(input.errorSummary ?? null)
  const payload = {
    actionId: input.actionId,
    proposalHash: input.proposalHash,
    approval: input.approval,
    inputArtifacts: input.inputArtifacts,
    sequence: input.sequence,
    status: input.status,
    at: input.at,
    previousStateHash: input.previousStateHash,
    outputArtifactsHash,
    errorSummaryHash,
  }
  return {
    sequence: input.sequence,
    status: input.status,
    at: input.at,
    previousStateHash: input.previousStateHash,
    outputArtifactsHash,
    errorSummaryHash,
    stateHash: sha256Canonical(eventStateHashPayload(payload)),
  }
}

export function createAgentActionProposal(input: {
  id: string
  capability: AgentCapabilitySnapshotV1
  arguments: unknown
  model: AgentOllamaModelSnapshotV1
  inputArtifacts: unknown[]
  approval: { scope: 'single_action', expiresAt: string }
  createdAt: string
}): AgentActionV1 {
  const id = assertSafeId(input.id, 'Agent action id')
  const capability = assertAgentCapabilitySnapshotV1(input.capability)
  const args = normalizeJsonValue(input.arguments)
  const model = assertOllamaModelSnapshot(input.model)
  const inputArtifacts = input.inputArtifacts.map(assertArtifactRefV1)
  const createdAt = assertIsoTimestamp(input.createdAt, 'Agent action createdAt')
  const expiresAt = assertIsoTimestamp(input.approval.expiresAt, 'Agent action approval expiresAt')
  if (input.approval.scope !== 'single_action') throw new TypeError('Agent action approval scope must be single_action')
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw new TypeError('Agent action approval expiry must be after creation')
  const argumentsHash = sha256Canonical(args)
  const modelHash = sha256Canonical(model)
  const base = {
    schema: 'modly.agent-action.v1' as const,
    version: 1 as const,
    id,
    createdAt,
    capability,
    arguments: args,
    argumentsHash,
    model,
    modelHash,
    inputArtifacts,
    approval: { scope: 'single_action' as const, expiresAt },
  }
  const proposalHash = sha256Canonical(proposalHashPayload(base))
  const initialEvent = createActionEvent({
    actionId: id,
    proposalHash,
    approval: base.approval,
    inputArtifacts,
    sequence: 0,
    status: 'proposed',
    at: createdAt,
    previousStateHash: null,
    outputArtifacts: [],
  })
  const action: AgentActionV1 = {
    ...base,
    status: 'proposed',
    updatedAt: createdAt,
    outputArtifacts: [],
    proposalHash,
    stateHash: initialEvent.stateHash,
    history: [initialEvent],
  }
  return normalizeAgentActionV1(action)
}

function normalizeAgentActionV1(value: unknown, now?: string): AgentActionV1 {
  assertPlainRecord(value, 'Agent action')
  assertExactKeys(value, [
    'schema', 'version', 'id', 'status', 'createdAt', 'updatedAt', 'capability',
    'arguments', 'argumentsHash', 'model', 'modelHash', 'inputArtifacts',
    'outputArtifacts', 'approval', 'proposalHash', 'stateHash', 'history', 'errorSummary',
  ], 'Agent action')
  if (value.schema !== 'modly.agent-action.v1' || value.version !== 1) throw new TypeError('Agent action schema/version is invalid')
  const id = assertSafeId(value.id, 'Agent action id')
  if (!isAgentActionStatus(value.status)) throw new TypeError('Agent action status is invalid')
  const createdAt = assertIsoTimestamp(value.createdAt, 'Agent action createdAt')
  const updatedAt = assertIsoTimestamp(value.updatedAt, 'Agent action updatedAt')
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new TypeError('Agent action updatedAt precedes createdAt')
  const capability = assertAgentCapabilitySnapshotV1(value.capability)
  const args = normalizeJsonValue(value.arguments)
  const argumentsHash = normalizeSha256(value.argumentsHash, 'Agent action arguments hash')
  if (sha256Canonical(args) !== argumentsHash) throw new TypeError('Agent action arguments hash does not match normalized arguments')
  const model = assertOllamaModelSnapshot(value.model)
  const modelHash = normalizeSha256(value.modelHash, 'Agent action model hash')
  if (sha256Canonical(model) !== modelHash) throw new TypeError('Agent action model hash does not match its snapshot')
  if (!Array.isArray(value.inputArtifacts) || !Array.isArray(value.outputArtifacts)) throw new TypeError('Agent action artifacts must be arrays')
  const inputArtifacts = value.inputArtifacts.map(assertArtifactRefV1)
  const outputArtifacts = value.outputArtifacts.map(assertArtifactRefV1)
  assertPlainRecord(value.approval, 'Agent action approval')
  assertExactKeys(value.approval, ['scope', 'expiresAt'], 'Agent action approval')
  if (value.approval.scope !== 'single_action') throw new TypeError('Agent action approval scope must be single_action')
  const expiresAt = assertIsoTimestamp(value.approval.expiresAt, 'Agent action approval expiresAt')
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw new TypeError('Agent action approval expiry must be after creation')
  const proposalHash = normalizeSha256(value.proposalHash, 'Agent action proposal hash')
  const stateHash = normalizeSha256(value.stateHash, 'Agent action state hash')
  const errorSummary = value.errorSummary === undefined ? undefined : assertString(value.errorSummary, 'Agent action errorSummary', 500)
  const immutable = {
    schema: 'modly.agent-action.v1' as const, version: 1 as const, id,
    createdAt, capability,
    arguments: args, argumentsHash, model, modelHash, inputArtifacts, outputArtifacts,
    approval: { scope: 'single_action' as const, expiresAt }, proposalHash,
  }
  const expectedProposalHash = sha256Canonical(proposalHashPayload(immutable))
  if (expectedProposalHash !== proposalHash) throw new TypeError('Agent action proposal hash does not match the approved proposal')
  if (!Array.isArray(value.history) || value.history.length === 0) throw new TypeError('Agent action history must be a non-empty array')

  const history: AgentActionEventV1[] = []
  for (const [index, rawEvent] of value.history.entries()) {
    const label = `Agent action history[${index}]`
    assertPlainRecord(rawEvent, label)
    assertExactKeys(rawEvent, ['sequence', 'status', 'at', 'previousStateHash', 'outputArtifactsHash', 'errorSummaryHash', 'stateHash'], label)
    if (rawEvent.sequence !== index) throw new TypeError(`${label} sequence is invalid`)
    if (!isAgentActionStatus(rawEvent.status)) throw new TypeError(`${label} status is invalid`)
    const eventStatus = rawEvent.status
    const at = assertIsoTimestamp(rawEvent.at, `${label}.at`)
    const previousStateHash = rawEvent.previousStateHash === null
      ? null
      : normalizeSha256(rawEvent.previousStateHash, `${label}.previousStateHash`)
    const outputArtifactsHash = normalizeSha256(rawEvent.outputArtifactsHash, `${label}.outputArtifactsHash`)
    const errorSummaryHash = normalizeSha256(rawEvent.errorSummaryHash, `${label}.errorSummaryHash`)
    const eventHash = normalizeSha256(rawEvent.stateHash, `${label}.stateHash`)
    const previous = history[index - 1]
    if (index === 0) {
      if (eventStatus !== 'proposed' || at !== createdAt || previousStateHash !== null) {
        throw new TypeError('Agent action history must begin with the proposed state at createdAt')
      }
    } else {
      if (!previous || previousStateHash !== previous.stateHash) throw new TypeError(`${label} previous state hash is invalid`)
      if (!ALLOWED_TRANSITIONS[previous.status].includes(eventStatus)) throw new TypeError(`${label} contains an invalid lifecycle transition`)
      if (Date.parse(at) <= Date.parse(previous.at)) throw new TypeError(`${label} timestamp must be strictly increasing`)
    }
    if ((eventStatus === 'approved' || eventStatus === 'executing') && Date.parse(at) >= Date.parse(expiresAt)) {
      throw new TypeError(`${label} occurred after approval expired`)
    }
    if (eventStatus === 'expired' && Date.parse(at) < Date.parse(expiresAt)) {
      throw new TypeError(`${label} expired before its approval deadline`)
    }
    const isLast = index === value.history.length - 1
    const eventOutputs = isLast ? outputArtifacts : []
    const eventError = isLast ? errorSummary : undefined
    if (outputArtifactsHash !== sha256Canonical(eventOutputs)) throw new TypeError(`${label} output artifacts hash is invalid`)
    if (errorSummaryHash !== sha256Canonical(eventError ?? null)) throw new TypeError(`${label} error summary hash is invalid`)
    const expectedStateHash = sha256Canonical(eventStateHashPayload({
      actionId: id,
      proposalHash,
      approval: immutable.approval,
      inputArtifacts,
      sequence: index,
      status: eventStatus,
      at,
      previousStateHash,
      outputArtifactsHash,
      errorSummaryHash,
    }))
    if (expectedStateHash !== eventHash) throw new TypeError(`${label} state hash is invalid`)
    history.push({
      sequence: index,
      status: eventStatus,
      at,
      previousStateHash,
      outputArtifactsHash,
      errorSummaryHash,
      stateHash: eventHash,
    })
  }

  const lastEvent = history.at(-1)
  if (!lastEvent || lastEvent.status !== value.status || lastEvent.at !== updatedAt) {
    throw new TypeError('Agent action status and updatedAt must match its history')
  }
  if (lastEvent.stateHash !== stateHash) throw new TypeError('Agent action state hash must match its history')
  if (outputArtifacts.length > 0 && value.status !== 'completed') throw new TypeError('Only completed Agent actions may expose output artifacts')
  if (errorSummary !== undefined && value.status !== 'failed' && value.status !== 'cancelled') {
    throw new TypeError('Only failed or cancelled Agent actions may expose an error summary')
  }
  if (now !== undefined) {
    const checkedAt = assertIsoTimestamp(now, 'Agent action validation time')
    if ((value.status === 'proposed' || value.status === 'approved') && Date.parse(checkedAt) >= Date.parse(expiresAt)) {
      throw new TypeError('Agent action approval has expired')
    }
  }
  return {
    ...immutable,
    status: value.status,
    updatedAt,
    stateHash,
    history,
    ...(errorSummary ? { errorSummary } : {}),
  }
}

export function assertAgentActionV1(value: unknown, now = new Date().toISOString()): AgentActionV1 {
  return normalizeAgentActionV1(value, now)
}

const ALLOWED_TRANSITIONS: Readonly<Record<AgentActionStatus, readonly AgentActionStatus[]>> = {
  proposed: ['approved', 'rejected', 'expired', 'cancelled'],
  approved: ['executing', 'expired', 'cancelled'],
  rejected: [],
  expired: [],
  executing: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

export function transitionAgentAction(
  actionValue: unknown,
  nextStatus: AgentActionStatus,
  at: string,
  details: { outputArtifacts?: unknown[], errorSummary?: string } = {},
): AgentActionV1 {
  const action = normalizeAgentActionV1(actionValue)
  if (!ACTION_STATUS_SET.has(nextStatus) || !ALLOWED_TRANSITIONS[action.status].includes(nextStatus)) {
    throw new Error(`Invalid Agent action transition ${action.status} -> ${nextStatus}`)
  }
  const updatedAt = assertIsoTimestamp(at, 'Agent action transition timestamp')
  if (Date.parse(updatedAt) <= Date.parse(action.updatedAt)) throw new Error('Agent action transition timestamp is not strictly monotonic')
  const isPastExpiry = Date.parse(updatedAt) >= Date.parse(action.approval.expiresAt)
  if (isPastExpiry && nextStatus !== 'expired' && action.status !== 'executing') {
    throw new Error('Agent action approval has expired')
  }
  if (!isPastExpiry && nextStatus === 'expired') throw new Error('Agent action approval has not expired')
  const outputArtifacts = details.outputArtifacts?.map(assertArtifactRefV1) ?? []
  if (outputArtifacts.length > 0 && nextStatus !== 'completed') throw new TypeError('Only completed Agent actions may receive output artifacts')
  const errorSummary = details.errorSummary === undefined
    ? undefined
    : assertString(details.errorSummary, 'Agent action transition errorSummary', 500)
  if (errorSummary !== undefined && nextStatus !== 'failed' && nextStatus !== 'cancelled') {
    throw new TypeError('Only failed or cancelled Agent actions may receive an error summary')
  }
  const event = createActionEvent({
    actionId: action.id,
    proposalHash: action.proposalHash,
    approval: action.approval,
    inputArtifacts: action.inputArtifacts,
    sequence: action.history.length,
    status: nextStatus,
    at: updatedAt,
    previousStateHash: action.stateHash,
    outputArtifacts,
    ...(errorSummary ? { errorSummary } : {}),
  })
  return normalizeAgentActionV1({
    ...action,
    status: nextStatus,
    updatedAt,
    outputArtifacts,
    stateHash: event.stateHash,
    history: [...action.history, event],
    ...(errorSummary ? { errorSummary } : {}),
  })
}

function summarizeArtifact(artifact: ArtifactRefV1) {
  return {
    id: artifact.id,
    kind: artifact.kind,
    mediaType: artifact.mediaType,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
  }
}

export function toAgentActionPublicSummary(actionValue: unknown): AgentActionPublicSummaryV1 {
  const action = assertAgentActionV1(actionValue)
  return {
    schema: 'modly.agent-action-summary.v1',
    version: 1,
    id: action.id,
    status: action.status,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
    capability: {
      id: action.capability.id,
      displayName: action.capability.displayName,
      description: action.capability.description,
      hash: action.capability.hash,
    },
    model: {
      provider: action.model.provider,
      model: action.model.model,
      digest: action.model.digest,
    },
    approval: { ...action.approval },
    inputs: action.inputArtifacts.map(summarizeArtifact),
    outputs: action.outputArtifacts.map(summarizeArtifact),
  }
}

export interface WorldWireIssue {
  code: 'wire-shape' | 'wire-accessor' | 'wire-prototype' | 'wire-key' | 'wire-limit' | 'wire-value'
  path: string
  message: string
}

export type ValidateWorldWireValueResult =
  | { success: true }
  | { success: false; issues: WorldWireIssue[] }

export type NormalizeWorldWireValueResult =
  | { success: true; value: unknown }
  | { success: false; issues: WorldWireIssue[] }

const MAX_WIRE_DEPTH = 64
const MAX_WIRE_NODES = 100_000
const MAX_WIRE_KEYS = 100_000
const MAX_WIRE_RECORD_KEYS = 4_096
const MAX_WIRE_ARRAY_LENGTH = 100_000
const MAX_WIRE_STRING_LENGTH = 1_048_576
const MAX_WIRE_PROPERTY_NAME_LENGTH = 256
const MAX_WIRE_ISSUES = 16
const POLLUTION_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const ORDINARY_OBJECT_PROTOTYPE_KEYS = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
])

/** Accepts JSON-like ordinary objects and null-prototype records without invoking accessors. */
export function isSafeWorldWireRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== null && prototype !== Object.prototype) return false
    if (prototype === Object.prototype && !hasPristineOrdinaryObjectPrototype()) return false
    if (Object.getOwnPropertySymbols(value).length > 0) return false
    const descriptors = Object.getOwnPropertyDescriptors(value)
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (POLLUTION_KEYS.has(key) || !descriptor.enumerable || !('value' in descriptor)) return false
    }
    return true
  } catch {
    return false
  }
}

export function validateWorldWireValue(value: unknown, rootPath = 'value'): ValidateWorldWireValueResult {
  const issues: WorldWireIssue[] = []
  const seenObjects = new WeakSet<object>()
  let nodes = 0
  let keys = 0
  let aborted = false

  const report = (issue: WorldWireIssue, terminal = false): void => {
    if (aborted) return
    if (issues.length >= MAX_WIRE_ISSUES - 1) {
      issues.push({ code: 'wire-limit', path: issue.path, message: `Wire validation stopped after ${MAX_WIRE_ISSUES} issues.` })
      aborted = true
      return
    }
    issues.push(issue)
    if (terminal) aborted = true
  }

  const countKeys = (count: number, path: string): boolean => {
    keys += count
    if (keys <= MAX_WIRE_KEYS) return true
    report({ code: 'wire-limit', path, message: `Wire value exceeds ${MAX_WIRE_KEYS} keys.` }, true)
    return false
  }

  const visit = (candidate: unknown, path: string, depth: number): void => {
    if (aborted) return
    nodes += 1
    if (nodes > MAX_WIRE_NODES) {
      report({ code: 'wire-limit', path, message: `Wire value exceeds ${MAX_WIRE_NODES} nodes.` }, true)
      return
    }
    if (depth > MAX_WIRE_DEPTH) {
      report({ code: 'wire-limit', path, message: `Wire value exceeds depth ${MAX_WIRE_DEPTH}.` }, true)
      return
    }
    if (candidate === null || typeof candidate === 'boolean') return
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) report({ code: 'wire-value', path, message: 'Wire numbers must be finite.' })
      return
    }
    if (typeof candidate === 'string') {
      if (candidate.length > MAX_WIRE_STRING_LENGTH) report({ code: 'wire-limit', path, message: `Wire string exceeds ${MAX_WIRE_STRING_LENGTH} characters.` }, true)
      return
    }
    if (typeof candidate !== 'object' || candidate === null) {
      report({ code: 'wire-shape', path, message: 'Wire values must contain only JSON-compatible data.' })
      return
    }
    if (seenObjects.has(candidate)) {
      report({ code: 'wire-limit', path, message: 'Wire value contains a repeated or cyclic object reference.' }, true)
      return
    }
    seenObjects.add(candidate)
    if (Array.isArray(candidate)) {
      visitArray(candidate, path, depth)
      return
    }
    let ownKeys: (string | symbol)[]
    try {
      ownKeys = Reflect.ownKeys(candidate)
    } catch {
      report({ code: 'wire-shape', path, message: 'Wire record could not be inspected safely.' })
      return
    }
    if (ownKeys.length > MAX_WIRE_RECORD_KEYS) {
      report({ code: 'wire-limit', path, message: `Wire record exceeds ${MAX_WIRE_RECORD_KEYS} keys.` }, true)
      return
    }
    const overlongKey = ownKeys.find((key) => typeof key === 'string' && key.length > MAX_WIRE_PROPERTY_NAME_LENGTH)
    if (overlongKey !== undefined) {
      report({ code: 'wire-limit', path, message: `Wire property names cannot exceed ${MAX_WIRE_PROPERTY_NAME_LENGTH} characters.` }, true)
      return
    }
    if (!countKeys(ownKeys.length, path)) return
    if (!isSafeWorldWireRecord(candidate)) {
      report({ code: classifyUnsafeRecord(candidate), path, message: 'Wire records must be ordinary data objects without inherited fields, accessors, symbols, or prototype-pollution keys.' })
      return
    }
    let descriptors: Record<string, PropertyDescriptor>
    try {
      descriptors = Object.getOwnPropertyDescriptors(candidate)
    } catch {
      report({ code: 'wire-shape', path, message: 'Wire record descriptors could not be inspected safely.' })
      return
    }
    const descriptorKeys = Object.keys(descriptors).sort(codeUnitCompare)
    for (const key of descriptorKeys) {
      if (aborted) return
      const descriptor = descriptors[key]
      if ('value' in descriptor) visit(descriptor.value, `${path}.${key}`, depth + 1)
    }
  }

  const visitArray = (candidate: unknown[], path: string, depth: number): void => {
    if (aborted) return
    try {
      if (Object.getPrototypeOf(candidate) !== Array.prototype || Object.getOwnPropertySymbols(candidate).length > 0) {
        report({ code: 'wire-prototype', path, message: 'Wire arrays must use the ordinary Array prototype and no symbol properties.' })
        return
      }
      if (candidate.length > MAX_WIRE_ARRAY_LENGTH) {
        report({ code: 'wire-limit', path, message: `Wire array exceeds ${MAX_WIRE_ARRAY_LENGTH} entries.` }, true)
        return
      }
      const ownKeys = Reflect.ownKeys(candidate)
      if (ownKeys.length > MAX_WIRE_ARRAY_LENGTH + 1) {
        report({ code: 'wire-limit', path, message: `Wire array exceeds ${MAX_WIRE_ARRAY_LENGTH} keys.` }, true)
        return
      }
      if (!countKeys(ownKeys.length - 1, path)) return
      if (ownKeys.some((key) => typeof key === 'string' && key !== 'length' && key.length > MAX_WIRE_PROPERTY_NAME_LENGTH)) {
        report({ code: 'wire-limit', path, message: `Wire property names cannot exceed ${MAX_WIRE_PROPERTY_NAME_LENGTH} characters.` }, true)
        return
      }
      const descriptors = Object.getOwnPropertyDescriptors(candidate)
      const descriptorKeys = Object.keys(descriptors).filter((key) => key !== 'length').sort(codeUnitCompare)
      for (const key of descriptorKeys) {
        if (aborted) return
        if (!isCanonicalArrayIndex(key, candidate.length)) {
          report({ code: 'wire-key', path: `${path}.${key}`, message: 'Wire arrays cannot contain named properties.' })
          continue
        }
        const descriptor = descriptors[key]
        if (!descriptor.enumerable || !('value' in descriptor)) {
          report({ code: 'wire-accessor', path: `${path}[${key}]`, message: 'Wire arrays cannot contain accessors or hidden entries.' })
          continue
        }
        visit(descriptor.value, `${path}[${key}]`, depth + 1)
      }
      for (let index = 0; index < candidate.length && !aborted; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(descriptors, String(index))) report({ code: 'wire-shape', path: `${path}[${index}]`, message: 'Wire arrays cannot contain holes.' })
      }
    } catch {
      report({ code: 'wire-shape', path, message: 'Wire array could not be inspected safely.' })
    }
  }

  visit(value, rootPath, 0)
  return issues.length ? { success: false, issues } : { success: true }
}

/**
 * Produces an isolated JSON-cloneable value before public parsers perform
 * ordinary property reads. Proxies and other non-cloneable wrappers are
 * rejected by the platform clone boundary.
 */
export function normalizeWorldWireValue(value: unknown, rootPath = 'value'): NormalizeWorldWireValueResult {
  const validated = validateWorldWireValue(value, rootPath)
  if (!validated.success) return validated
  try {
    if (typeof structuredClone === 'function') return { success: true, value: structuredClone(value) }
    return { success: true, value: cloneValidatedWireValue(value) }
  } catch {
    return {
      success: false,
      issues: [{ code: 'wire-shape', path: rootPath, message: 'Wire value must be JSON-cloneable data without wrappers.' }],
    }
  }
}

function cloneValidatedWireValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value)
    return Array.from({ length: value.length }, (_, index) => cloneValidatedWireValue(descriptors[String(index)].value))
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const clone: Record<string, unknown> = {}
  for (const key of Object.keys(descriptors).sort(codeUnitCompare)) clone[key] = cloneValidatedWireValue(descriptors[key].value)
  return clone
}

function hasPristineOrdinaryObjectPrototype(): boolean {
  const keys = Object.getOwnPropertyNames(Object.prototype)
  return keys.length === ORDINARY_OBJECT_PROTOTYPE_KEYS.size && keys.every((key) => ORDINARY_OBJECT_PROTOTYPE_KEYS.has(key))
}

function classifyUnsafeRecord(value: unknown): WorldWireIssue['code'] {
  if (typeof value !== 'object' || value === null) return 'wire-shape'
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== null && prototype !== Object.prototype) return 'wire-prototype'
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.keys(descriptors).some((key) => POLLUTION_KEYS.has(key))) return 'wire-key'
    if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) return 'wire-accessor'
  } catch {
    return 'wire-shape'
  }
  return 'wire-shape'
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false
  const index = Number(key)
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export const WORLD_ID_MAX_LENGTH = 256
export const WORLD_PROPERTY_NAME_MAX_LENGTH = 256
export const WORLD_MAX_COLLECTION_ITEMS = 1_024
export const WORLD_MAX_RECORD_KEYS = 128
export const WORLD_MAX_SEMANTIC_ISSUES = 64

const WORLD_CANONICAL_ID_NAMESPACES = new Set([
  'animation', 'asset', 'audio', 'behavior', 'binding', 'c', 'camera', 'collider', 'component', 'default',
  'entity', 'environment', 'event', 'graphics', 'id', 'input', 'key', 'legacy', 'light', 'model', 'modly',
  'profile', 'project', 'renderable', 'resource', 'rigid-body', 'scene', 'sequence', 'surface', 'track',
  'transaction', 'trigger', 'tx', 'world',
])

export function isWorldCanonicalId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= WORLD_ID_MAX_LENGTH
    && value === value.trim()
    && !value.includes('\0')
    && !value.includes('/')
    && !value.includes('\\')
    && hasCanonicalIdNamespace(value)
}

function hasCanonicalIdNamespace(value: string): boolean {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value)
  return !match || WORLD_CANONICAL_ID_NAMESPACES.has(match[1].toLowerCase())
}

export function isWorldCanonicalPropertyName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= WORLD_PROPERTY_NAME_MAX_LENGTH
    && value === value.trim()
    && !value.includes('\0')
    && value !== '__proto__'
    && value !== 'prototype'
    && value !== 'constructor'
}

export function canContinueWorldSemanticValidation(issues: readonly unknown[]): boolean {
  return issues.length < WORLD_MAX_SEMANTIC_ISSUES
}

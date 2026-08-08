const MAX_OLLAMA_MODELS = 256
const MAX_OLLAMA_MODEL_NAME_LENGTH = 200
const OLLAMA_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/

function exactOwnDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null

  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== expectedKeys.length) return null
  const expected = new Set(expectedKeys)
  if (ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))) return null

  const result: Record<string, unknown> = Object.create(null)
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
    result[key] = descriptor.value
  }
  return result
}

function boundedOwnDataArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (!lengthDescriptor || !('value' in lengthDescriptor)) return null
  const length = lengthDescriptor.value
  if (!Number.isInteger(length) || length < 0 || length > MAX_OLLAMA_MODELS) return null

  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== length + 1 || ownKeys.some((key) => (
    typeof key !== 'string' || (key !== 'length' && !/^(?:0|[1-9]\d*)$/.test(key))
  ))) return null

  const entries: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
    entries.push(descriptor.value)
  }
  return entries
}

function isValidModelName(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_OLLAMA_MODEL_NAME_LENGTH
    || value !== value.trim()
  ) return false
  return !Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

export function parseOllamaModelNames(value: unknown): string[] {
  try {
    const response = exactOwnDataRecord(value, ['models'])
    if (!response) return []
    const entries = boundedOwnDataArray(response.models)
    if (!entries) return []

    const names = new Set<string>()
    for (const entry of entries) {
      const model = exactOwnDataRecord(entry, ['name', 'digest'])
      if (
        !model
        || !isValidModelName(model.name)
        || typeof model.digest !== 'string'
        || !OLLAMA_DIGEST_PATTERN.test(model.digest)
      ) continue
      names.add(model.name)
    }
    return [...names].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  } catch {
    return []
  }
}

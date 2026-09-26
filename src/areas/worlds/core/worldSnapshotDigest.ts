/** Canonical snapshot bytes shared by Main and future renderer reconciliation. SHA-256 hashes these UTF-8 bytes, not the stored command result. */
export function canonicalWorldProjectSnapshotPayload(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid snapshot number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalWorldProjectSnapshotPayload).join(',')}]`
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Invalid snapshot value')
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map((key) => `${JSON.stringify(key)}:${canonicalWorldProjectSnapshotPayload(record[key])}`).join(',')}}`
}

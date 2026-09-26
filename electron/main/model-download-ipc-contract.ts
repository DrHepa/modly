import { assertSafeOwnershipSegment } from './extension-path-guard'

const HF_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

export type LegacyModelDownloadPayload = {
  modelId: string
  repoId?: string
  skipPrefixes?: string[]
  includePrefixes?: string[]
}

export function parseLegacyModelDownloadPayload(payload: unknown): LegacyModelDownloadPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Legacy model download payload must be an object')
  const value = payload as Record<string, unknown>
  const allowed = new Set(['repoId', 'modelId', 'skipPrefixes', 'includePrefixes'])
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('Legacy model download payload has unknown fields')
  if (typeof value.modelId !== 'string') throw new Error('Legacy model download modelId must be a string')
  const segments = value.modelId.split('/')
  if (segments.length !== 2) throw new Error('Model asset download modelId must contain exactly two segments')
  const modelId = `${assertSafeOwnershipSegment(segments[0], 'Model asset download extension segment')}/${assertSafeOwnershipSegment(segments[1], 'Model asset download node segment')}`
  const repoId = value.repoId
  if (repoId !== undefined && (typeof repoId !== 'string' || !HF_REPO_RE.test(repoId))) throw new Error('repoId must be a safe Hugging Face repository ID')
  const prefixes = (raw: unknown, field: string): string[] | undefined => {
    if (raw === undefined) return undefined
    if (!Array.isArray(raw) || raw.some((prefix) => typeof prefix !== 'string' || !prefix || prefix !== prefix.trim())) throw new Error(`${field} must be an array of non-empty strings`)
    return [...raw] as string[]
  }
  return { modelId, ...(repoId !== undefined ? { repoId } : {}), skipPrefixes: prefixes(value.skipPrefixes, 'skipPrefixes'), includePrefixes: prefixes(value.includePrefixes, 'includePrefixes') }
}

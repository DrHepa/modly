import axios from 'axios'

export type RuntimeReadiness = {
  ok: boolean
  machine_code: string
  label_hint?: 'Ready' | 'Setup Codex' | 'Login' | 'Update Codex' | 'Unsupported' | 'Checking failed'
  reason?: string
  evidence?: Record<string, unknown>
  actions?: RuntimeReadinessAction[]
  details?: RuntimeReadinessDetails
  checked_at: string
  stale?: boolean
}

export type RuntimeReadinessActionKind = 'show_guidance' | 'show_details' | 'open_external_url' | 'refresh_readiness'
export type RuntimeReadinessActionSafety = 'manual' | 'non_destructive' | 'confirm'

export type RuntimeReadinessAction = {
  id: string
  kind: RuntimeReadinessActionKind
  label: string
  disabled?: boolean
  reason?: string
  guidance?: string
  docs_url?: string
  requires_confirmation?: boolean
  confirmation?: { title: string; body: string; confirm_label: string }
  refresh_after?: 'always' | 'success' | 'never'
  safety: RuntimeReadinessActionSafety
}

export type RuntimeReadinessDetails = {
  title?: string
  summary?: string
  evidence?: Record<string, string>
  diagnostics?: Record<string, string>
  guidance?: string
}

export type RuntimeReadinessResponse = {
  success: boolean
  models: Record<string, RuntimeReadiness>
  error?: string
}

type ReadinessHttpClient = {
  get(url: string, options?: { timeout?: number }): Promise<{ data: unknown }>
}

type RuntimeActionDeps = {
  openExternal(url: string): Promise<unknown>
}

const MAX_ACTIONS = 5
const MAX_SHORT_TEXT = 240
const MAX_LONG_TEXT = 2_000
const ACTION_ID_RE = /^[a-z0-9._:-]{1,80}$/
const ALLOWED_ACTION_KINDS = new Set<RuntimeReadinessActionKind>(['show_guidance', 'show_details', 'open_external_url', 'refresh_readiness'])
const ALLOWED_ACTION_SAFETY = new Set<RuntimeReadinessActionSafety>(['manual', 'non_destructive', 'confirm'])
const ALLOWED_REFRESH_AFTER = new Set(['always', 'success', 'never'])
const ALLOWED_DIAGNOSTIC_KEYS = new Set([
  'runtime_source',
  'runtime_name',
  'runtime_version',
  'runtime_version_supported',
  'supported_versions',
  'platform_supported',
  'platform_key',
  'auth_state',
  'entitlement_state',
  'extension_setup_state',
  'extension_import_state',
  'codex_app_server_state',
  'readiness_source',
  'diagnostic_status',
  'last_checked_at',
])

export function hasTraversalLikeModelId(modelIds: string[]): boolean {
  return modelIds.some((modelId) => {
    const normalized = modelId.replace(/\\/g, '/')
    return normalized.split('/').some((part) => part === '..')
  })
}

export function buildRuntimeReadinessQuery(modelIds: string[]): string {
  const uniqueIds = [...new Set(modelIds.map((id) => id.trim()).filter(Boolean))]
  if (hasTraversalLikeModelId(uniqueIds)) {
    throw new Error('model_ids must be canonical model IDs; traversal-like inputs are rejected.')
  }

  const params = new URLSearchParams()
  params.set('model_ids', uniqueIds.join(','))
  return `/model/runtime-readiness?${params.toString()}`
}

export async function fetchRuntimeReadinessWithHealthGate(
  modelIds: string[],
  deps: { apiBaseUrl: string; get?: ReadinessHttpClient['get'] },
): Promise<RuntimeReadinessResponse> {
  const uniqueIds = [...new Set(modelIds.map((id) => id.trim()).filter(Boolean))]
  const get = deps.get ?? axios.get.bind(axios)

  try {
    const query = buildRuntimeReadinessQuery(uniqueIds)
    await get(`${deps.apiBaseUrl}/health`, { timeout: 3_000 })
    const response = await get(`${deps.apiBaseUrl}${query}`, { timeout: 10_000 })
    const data = response.data as { models?: Record<string, unknown>; readiness?: Record<string, unknown> }
    return { success: true, models: sanitizeRuntimeReadinessMap(data.models ?? data.readiness ?? {}) }
  } catch {
    return {
      success: false,
      error: 'Runtime readiness check failed.',
      models: Object.fromEntries(uniqueIds.map((modelId) => [modelId, createCheckingFailedReadiness()])),
    }
  }
}

export function createRuntimeReadinessActionHandler(deps: RuntimeActionDeps) {
  return async (action: unknown): Promise<{ success: boolean; error?: string }> => {
    const sanitized = sanitizeRuntimeReadinessAction(action)
    if (!sanitized || sanitized.disabled) {
      return { success: false, error: 'Runtime readiness action is unavailable.' }
    }

    if (sanitized.kind !== 'open_external_url' || !sanitized.docs_url) {
      return { success: false, error: 'Runtime readiness action is unavailable.' }
    }

    try {
      await deps.openExternal(sanitized.docs_url)
      return { success: true }
    } catch {
      return { success: false, error: 'Runtime readiness action failed.' }
    }
  }
}

function sanitizeRuntimeReadinessMap(models: Record<string, unknown>): Record<string, RuntimeReadiness> {
  const sanitized: Record<string, RuntimeReadiness> = {}
  for (const [modelId, value] of Object.entries(models)) {
    const readiness = sanitizeRuntimeReadiness(value)
    if (readiness) sanitized[modelId] = readiness
  }
  return sanitized
}

function sanitizeRuntimeReadiness(value: unknown): RuntimeReadiness | undefined {
  if (!isPlainObject(value)) return undefined
  const ok = typeof value.ok === 'boolean' ? value.ok : false
  const machineCode = sanitizeText(value.machine_code, MAX_SHORT_TEXT)
  const checkedAt = sanitizeText(value.checked_at, MAX_SHORT_TEXT)
  if (!machineCode || !checkedAt) return undefined
  const labelHint = sanitizeText(value.label_hint, MAX_SHORT_TEXT) as RuntimeReadiness['label_hint'] | undefined
  const reason = sanitizeText(value.reason, MAX_LONG_TEXT)
  const details = sanitizeRuntimeReadinessDetails(value.details)
  const actions = sanitizeRuntimeReadinessActions(value.actions)

  return {
    ok,
    machine_code: machineCode,
    ...(labelHint ? { label_hint: labelHint } : {}),
    ...(reason ? { reason } : {}),
    ...(isPlainObject(value.evidence) ? { evidence: value.evidence } : {}),
    ...(actions.length > 0 ? { actions } : {}),
    ...(details ? { details } : {}),
    checked_at: checkedAt,
    ...(value.stale === true ? { stale: true } : {}),
  }
}

function sanitizeRuntimeReadinessActions(value: unknown): RuntimeReadinessAction[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => sanitizeRuntimeReadinessAction(entry))
    .filter((entry): entry is RuntimeReadinessAction => Boolean(entry))
    .slice(0, MAX_ACTIONS)
}

function sanitizeRuntimeReadinessAction(value: unknown): RuntimeReadinessAction | undefined {
  if (!isPlainObject(value)) return undefined
  const id = sanitizeText(value.id, 80)
  const kind = sanitizeText(value.kind, MAX_SHORT_TEXT) as RuntimeReadinessActionKind | undefined
  const label = sanitizeText(value.label, MAX_SHORT_TEXT)
  const safety = sanitizeText(value.safety, MAX_SHORT_TEXT) as RuntimeReadinessActionSafety | undefined
  if (!id || !ACTION_ID_RE.test(id) || !kind || !ALLOWED_ACTION_KINDS.has(kind) || !label || !safety || !ALLOWED_ACTION_SAFETY.has(safety)) {
    return undefined
  }

  const docsUrl = sanitizeHttpsUrl(value.docs_url)
  if (kind === 'open_external_url' && !docsUrl) return undefined

  const guidance = sanitizeText(value.guidance, MAX_LONG_TEXT)
  const reason = sanitizeText(value.reason, MAX_LONG_TEXT)
  const refreshAfter = sanitizeText(value.refresh_after, MAX_SHORT_TEXT)
  const confirmation = sanitizeConfirmation(value.confirmation)

  return {
    id,
    kind,
    label,
    safety,
    ...(value.disabled === true ? { disabled: true } : {}),
    ...(reason ? { reason } : {}),
    ...(guidance ? { guidance } : {}),
    ...(docsUrl ? { docs_url: docsUrl } : {}),
    ...(value.requires_confirmation === true ? { requires_confirmation: true } : {}),
    ...(confirmation ? { confirmation } : {}),
    ...(refreshAfter && ALLOWED_REFRESH_AFTER.has(refreshAfter) ? { refresh_after: refreshAfter as 'always' | 'success' | 'never' } : {}),
  }
}

function sanitizeRuntimeReadinessDetails(value: unknown): RuntimeReadinessDetails | undefined {
  if (!isPlainObject(value)) return undefined
  const title = sanitizeText(value.title, MAX_SHORT_TEXT)
  const summary = sanitizeText(value.summary, MAX_LONG_TEXT)
  const guidance = sanitizeText(value.guidance, MAX_LONG_TEXT)
  const evidence = sanitizeStringMap(value.evidence)
  const diagnostics = sanitizeStringMap(value.diagnostics)
  const details = {
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    ...(Object.keys(evidence).length > 0 ? { evidence } : {}),
    ...(Object.keys(diagnostics).length > 0 ? { diagnostics } : {}),
    ...(guidance ? { guidance } : {}),
  }
  return Object.keys(details).length > 0 ? details : undefined
}

function sanitizeStringMap(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, rawValue] of Object.entries(value)) {
    if (!ALLOWED_DIAGNOSTIC_KEYS.has(key)) continue
    const text = sanitizeText(rawValue, MAX_SHORT_TEXT)
    if (text) result[key] = text
  }
  return result
}

function sanitizeConfirmation(value: unknown): RuntimeReadinessAction['confirmation'] | undefined {
  if (!isPlainObject(value)) return undefined
  const title = sanitizeText(value.title, MAX_SHORT_TEXT)
  const body = sanitizeText(value.body, MAX_LONG_TEXT)
  const confirmLabel = sanitizeText(value.confirm_label, MAX_SHORT_TEXT)
  if (!title || !body || !confirmLabel) return undefined
  return { title, body, confirm_label: confirmLabel }
}

function sanitizeHttpsUrl(value: unknown): string | undefined {
  const url = sanitizeText(value, MAX_LONG_TEXT)
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' ? parsed.toString() : undefined
  } catch {
    return undefined
  }
}

function sanitizeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text || text.length > maxLength || containsUnsafeDiagnosticText(text)) return undefined
  return text
}

function containsUnsafeDiagnosticText(value: string): boolean {
  return /\.\.|token\s*=|secret|api[_-]?key|raw output|command output|\b[A-Z_]{3,}=|(?:^|\s)(?:\/[\w.-]+){2,}|[A-Za-z]:\\/i.test(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function createCheckingFailedReadiness(): RuntimeReadiness {
  return {
    ok: false,
    machine_code: 'checking_failed',
    label_hint: 'Checking failed',
    checked_at: new Date().toISOString(),
  }
}

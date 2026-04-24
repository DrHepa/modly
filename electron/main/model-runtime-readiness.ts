import axios from 'axios'

export type RuntimeReadiness = {
  ok: boolean
  machine_code: string
  label_hint?: 'Ready' | 'Setup Codex' | 'Login' | 'Update Codex' | 'Unsupported' | 'Checking failed'
  reason?: string
  evidence?: Record<string, unknown>
  checked_at: string
  stale?: boolean
}

export type RuntimeReadinessResponse = {
  success: boolean
  models: Record<string, RuntimeReadiness>
  error?: string
}

type ReadinessHttpClient = {
  get(url: string, options?: { timeout?: number }): Promise<{ data: unknown }>
}

export function hasTraversalLikeModelId(modelIds: string[]): boolean {
  return modelIds.some((modelId) => {
    const normalized = modelId.replace(/\\/g, '/')
    return normalized.split('/').some((part) => part === '..')
  })
}

export function buildRuntimeReadinessQuery(modelIds: string[]): string {
  const uniqueIds = [...new Set(modelIds.map((id) => id.trim()).filter(Boolean))]
  if (hasTraversalLikeModelId(uniqueIds) || uniqueIds.some((id) =>
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id))) {
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
  const uniqueIds = Array.isArray(modelIds)
    ? [...new Set(modelIds.filter((id): id is string => typeof id === 'string').map((id) => id.trim()).filter(Boolean))]
    : []
  const get = deps.get ?? axios.get.bind(axios)

  try {
    const query = buildRuntimeReadinessQuery(uniqueIds)
    if (!Array.isArray(modelIds) || uniqueIds.length === 0 || modelIds.some((id) => typeof id !== 'string')) {
      throw new Error('Invalid model IDs')
    }
    const health = await get(`${deps.apiBaseUrl}/health`, { timeout: 3_000 })
    if (!health.data || (health.data as { status?: unknown }).status !== 'ok') {
      throw new Error('Backend is not healthy')
    }
    const response = await get(`${deps.apiBaseUrl}${query}`, { timeout: 10_000 })
    const data = response.data as { models?: Record<string, RuntimeReadiness>; readiness?: Record<string, RuntimeReadiness> }
    const models = data.models ?? data.readiness
    if (!models || typeof models !== 'object' || Array.isArray(models)) throw new Error('Invalid readiness response')
    const selected: Record<string, RuntimeReadiness> = {}
    for (const id of uniqueIds) {
      const status = models[id]
      if (!status) continue
      if (typeof status.ok !== 'boolean' || typeof status.machine_code !== 'string' || typeof status.checked_at !== 'string') {
        throw new Error('Invalid readiness status')
      }
      selected[id] = status
    }
    return { success: true, models: selected }
  } catch {
    return {
      success: false,
      error: 'Runtime readiness check failed.',
      models: Object.fromEntries(uniqueIds.map((modelId) => [modelId, createCheckingFailedReadiness()])),
    }
  }
}

function createCheckingFailedReadiness(): RuntimeReadiness {
  return {
    ok: false,
    machine_code: 'checking_failed',
    label_hint: 'Checking failed',
    checked_at: new Date().toISOString(),
  }
}

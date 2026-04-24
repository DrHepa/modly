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
    const data = response.data as { models?: Record<string, RuntimeReadiness>; readiness?: Record<string, RuntimeReadiness> }
    return { success: true, models: data.models ?? data.readiness ?? {} }
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

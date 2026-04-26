import assert from 'node:assert/strict'
import test from 'node:test'

const {
  buildRuntimeReadinessQuery,
  createRuntimeReadinessActionHandler,
  fetchRuntimeReadinessWithHealthGate,
  hasTraversalLikeModelId,
} = await import(new URL('./model-runtime-readiness.ts', import.meta.url).href)

test('buildRuntimeReadinessQuery forwards canonical ids and rejects traversal-like ids', () => {
  assert.equal(hasTraversalLikeModelId(['modly-codex-image-extension/text-to-image']), false)
  assert.equal(hasTraversalLikeModelId(['../escape']), true)
  assert.equal(hasTraversalLikeModelId(['codex/../../escape']), true)
  assert.equal(hasTraversalLikeModelId(['codex\\..\\escape']), true)

  assert.equal(
    buildRuntimeReadinessQuery(['modly-codex-image-extension/text-to-image', 'other/model']),
    '/model/runtime-readiness?model_ids=modly-codex-image-extension%2Ftext-to-image%2Cother%2Fmodel',
  )

  assert.throws(
    () => buildRuntimeReadinessQuery(['../escape']),
    /model_ids must be canonical model IDs/i,
  )
})

test('fetchRuntimeReadinessWithHealthGate checks health before readiness endpoint and accepts FastAPI readiness map', async () => {
  const calls: string[] = []
  const result = await fetchRuntimeReadinessWithHealthGate(['modly-codex-image-extension/text-to-image'], {
    apiBaseUrl: 'http://127.0.0.1:8000',
    async get(url: string) {
      calls.push(url)
      if (url.endsWith('/health')) return { data: { status: 'ok' } }
      return {
        data: {
          readiness: {
            'modly-codex-image-extension/text-to-image': {
              ok: false,
              machine_code: 'preflight/not_authenticated',
              label_hint: 'Login',
              checked_at: '2026-04-24T00:00:00.000Z',
            },
          },
        },
      }
    },
  })

  assert.deepEqual(calls, [
    'http://127.0.0.1:8000/health',
    'http://127.0.0.1:8000/model/runtime-readiness?model_ids=modly-codex-image-extension%2Ftext-to-image',
  ])
  assert.equal(result.success, true)
  assert.equal(result.models['modly-codex-image-extension/text-to-image']?.label_hint, 'Login')
})

test('fetchRuntimeReadinessWithHealthGate preserves sanitized readiness actions and details from FastAPI', async () => {
  const result = await fetchRuntimeReadinessWithHealthGate(['modly-codex-image-extension/text-to-image'], {
    apiBaseUrl: 'http://127.0.0.1:8000',
    async get(url: string) {
      if (url.endsWith('/health')) return { data: { status: 'ok' } }
      return {
        data: {
          models: {
            'modly-codex-image-extension/text-to-image': {
              ok: false,
              machine_code: 'preflight/not_authenticated',
              label_hint: 'Login',
              checked_at: '2026-04-24T00:00:00.000Z',
              actions: [
                {
                  id: 'codex.login.docs',
                  kind: 'open_external_url',
                  label: 'Open login docs',
                  docs_url: 'https://developers.openai.com/codex/auth',
                  safety: 'manual',
                  refresh_after: 'never',
                },
                {
                  id: 'codex.refresh',
                  kind: 'refresh_readiness',
                  label: 'Refresh',
                  safety: 'non_destructive',
                },
              ],
              details: {
                title: 'Login required',
                summary: 'Codex is installed but not authenticated.',
                diagnostics: {
                  runtime_source: 'path',
                  auth_state: 'missing',
                  diagnostic_status: 'ok',
                },
              },
            },
          },
        },
      }
    },
  })

  const readiness = result.models['modly-codex-image-extension/text-to-image']
  assert.deepEqual(readiness?.actions?.map((action: { id: string }) => action.id), ['codex.login.docs', 'codex.refresh'])
  assert.equal(readiness?.actions?.[0]?.docs_url, 'https://developers.openai.com/codex/auth')
  assert.deepEqual(readiness?.details?.diagnostics, {
    runtime_source: 'path',
    auth_state: 'missing',
    diagnostic_status: 'ok',
  })
})

test('fetchRuntimeReadinessWithHealthGate drops unsafe readiness action and detail shapes without failing legacy status', async () => {
  const result = await fetchRuntimeReadinessWithHealthGate(['codex/text-to-image'], {
    apiBaseUrl: 'http://127.0.0.1:8000',
    async get(url: string) {
      if (url.endsWith('/health')) return { data: { status: 'ok' } }
      return {
        data: {
          readiness: {
            'codex/text-to-image': {
              ok: false,
              machine_code: 'preflight/unsupported_version',
              label_hint: 'Update Codex',
              checked_at: '2026-04-24T00:00:00.000Z',
              actions: [
                { id: 'valid.details', kind: 'show_details', label: 'Details', safety: 'manual' },
                { id: '../escape', kind: 'open_external_url', label: 'Bad id', docs_url: 'https://developers.openai.com/codex/auth', safety: 'manual' },
                { id: 'bad.url', kind: 'open_external_url', label: 'Bad URL', docs_url: 'file:///home/user/token', safety: 'manual' },
                { id: 'bad.kind', kind: 'run_command', label: 'Run codex', safety: 'confirm' },
              ],
              details: {
                title: '/home/user/private should not leak',
                summary: 'Safe summary',
                diagnostics: {
                  runtime_version: '0.123.0',
                  raw_output: 'token=secret',
                  auth_state: '/home/user/.codex/auth.json',
                },
              },
            },
          },
        },
      }
    },
  })

  const readiness = result.models['codex/text-to-image']
  assert.equal(readiness?.label_hint, 'Update Codex')
  assert.deepEqual(readiness?.actions?.map((action: { id: string }) => action.id), ['valid.details'])
  assert.equal(readiness?.details?.title, undefined)
  assert.deepEqual(readiness?.details?.diagnostics, { runtime_version: '0.123.0' })
})

test('createRuntimeReadinessActionHandler opens only validated HTTPS readiness URLs', async () => {
  const opened: string[] = []
  const handler = createRuntimeReadinessActionHandler({
    async openExternal(url: string) {
      opened.push(url)
    },
  })

  assert.deepEqual(await handler({
    id: 'docs',
    kind: 'open_external_url',
    label: 'Docs',
    safety: 'manual',
    docs_url: 'https://developers.openai.com/codex/cli',
  }), { success: true })

  assert.deepEqual(opened, ['https://developers.openai.com/codex/cli'])
  assert.deepEqual(await handler({
    id: 'bad',
    kind: 'open_external_url',
    label: 'Bad',
    safety: 'manual',
    docs_url: 'file:///home/user/private',
  }), { success: false, error: 'Runtime readiness action is unavailable.' })
  assert.deepEqual(opened, ['https://developers.openai.com/codex/cli'])
})

test('fetchRuntimeReadinessWithHealthGate serializes multiple ids as a FastAPI-compatible comma-separated query', async () => {
  const calls: string[] = []
  const result = await fetchRuntimeReadinessWithHealthGate([
    'modly-codex-image-extension/text-to-image',
    'other/model',
  ], {
    apiBaseUrl: 'http://127.0.0.1:8000',
    async get(url: string) {
      calls.push(url)
      if (url.endsWith('/health')) return { data: { status: 'ok' } }
      return {
        data: {
          readiness: {
            'modly-codex-image-extension/text-to-image': {
              ok: true,
              machine_code: 'ready',
              label_hint: 'Ready',
              checked_at: '2026-04-24T00:00:00.000Z',
            },
            'other/model': {
              ok: false,
              machine_code: 'preflight/not_authenticated',
              label_hint: 'Login',
              checked_at: '2026-04-24T00:00:00.000Z',
            },
          },
        },
      }
    },
  })

  assert.deepEqual(calls, [
    'http://127.0.0.1:8000/health',
    'http://127.0.0.1:8000/model/runtime-readiness?model_ids=modly-codex-image-extension%2Ftext-to-image%2Cother%2Fmodel',
  ])
  assert.equal(result.models['modly-codex-image-extension/text-to-image']?.label_hint, 'Ready')
  assert.equal(result.models['other/model']?.label_hint, 'Login')
})

test('fetchRuntimeReadinessWithHealthGate returns sanitized checking-failed payload when health or business call fails', async () => {
  const healthFailed = await fetchRuntimeReadinessWithHealthGate(['codex/text-to-image'], {
    apiBaseUrl: 'http://127.0.0.1:8000',
    async get() {
      throw new Error('token=secret raw output /home/user/private')
    },
  })

  assert.equal(healthFailed.success, false)
  assert.equal(healthFailed.models['codex/text-to-image']?.machine_code, 'checking_failed')
  assert.equal(healthFailed.models['codex/text-to-image']?.label_hint, 'Checking failed')
  assert.doesNotMatch(healthFailed.error ?? '', /secret|\/home\/user|raw output/i)

  const businessCalls: string[] = []
  const businessFailed = await fetchRuntimeReadinessWithHealthGate(['codex/text-to-image'], {
    apiBaseUrl: 'http://127.0.0.1:8000',
    async get(url: string) {
      businessCalls.push(url)
      if (url.endsWith('/health')) return { data: { status: 'ok' } }
      throw new Error('full command output should not leak')
    },
  })

  assert.deepEqual(businessCalls, [
    'http://127.0.0.1:8000/health',
    'http://127.0.0.1:8000/model/runtime-readiness?model_ids=codex%2Ftext-to-image',
  ])
  assert.equal(businessFailed.success, false)
  assert.equal(businessFailed.models['codex/text-to-image']?.machine_code, 'checking_failed')
  assert.doesNotMatch(businessFailed.error ?? '', /command output/i)
})

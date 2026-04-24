import assert from 'node:assert/strict'
import test from 'node:test'
import type { AnyExtension, FailedExtensionResult, InstalledExtensionResult, RuntimeReadiness } from '../types/electron.d'

const { useExtensionsStore } = await import(new URL('./extensionsStore.ts', import.meta.url).href)

type MockInstallResult = {
  success: boolean
  status?: 'success' | 'partial' | 'error'
  installed?: Array<{
    extensionId: string
    extension: Record<string, unknown>
    status?: 'success' | 'partial'
  }>
  failed?: Array<{
    extensionId: string
    stage: string
    error: string
  }>
  warnings?: string[]
  reloaded?: boolean
  extensionId?: string
  extension?: Record<string, unknown>
  error?: string
}

function createModelExtension(id: string, capabilityId = `${id}/node`) {
  return {
    type: 'model',
    id,
    name: id,
    trusted: true,
    builtin: false,
    nodes: [
      {
        id: 'node',
        name: 'Node',
        input: 'image',
        output: 'image',
        paramsSchema: [],
        hfRepo: `${id}/repo`,
        capabilityId,
        bundleId: id,
        weightOwnerId: `${id}/owner`,
        sharedOwner: false,
        legacyPaths: [capabilityId],
      },
    ],
  }
}

function createProcessExtension(id: string) {
  return {
    type: 'process',
    id,
    name: id,
    trusted: true,
    builtin: false,
    entry: 'index.js',
    nodes: [
      {
        id: 'node',
        name: 'Node',
        input: 'image',
        output: 'image',
        paramsSchema: [],
      },
    ],
  }
}

function installMockWindow(result: MockInstallResult, downloadedIds: string[] = [], readiness?: {
  calls: string[][]
  responses: Array<Promise<{ success: boolean; models: Record<string, RuntimeReadiness>; error?: string }> | { success: boolean; models: Record<string, RuntimeReadiness>; error?: string }>
}, shellCalls: string[] = []) {
  let progressHandler: ((data: { step: string; percent?: number; message?: string }) => void) | undefined

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electron: {
        extensions: {
          onInstallProgress(cb: (data: { step: string; percent?: number; message?: string }) => void) {
            progressHandler = cb
          },
          offInstallProgress() {
            progressHandler = undefined
          },
          async installFromGitHub() {
            progressHandler?.({ step: 'validating', percent: 50 })
            return result
          },
          async uninstall() {
            return { success: true }
          },
          async reload() {
            return { success: true, errors: {} }
          },
          async list() {
            return []
          },
        },
        model: {
          async listDownloaded() {
            return downloadedIds.map((id) => ({ id, name: id, size_gb: 1 }))
          },
          async runtimeReadiness(modelIds: string[]) {
            readiness?.calls.push(modelIds)
            const response = readiness?.responses.shift()
            return response ?? { success: true, models: {} }
          },
        },
        shell: {
          async openExternal(url: string) {
            shellCalls.push(url)
            return { success: true }
          },
        },
      },
    },
  })
}

function resetStoreState() {
  useExtensionsStore.setState({
    modelExtensions: [],
    processExtensions: [],
    readyOwnerIds: [],
    loading: false,
    installProgress: null,
    installError: null,
    installResult: null,
    loadErrors: {},
    runtimeReadinessById: {},
    runtimeReadinessLoadingById: {},
    runtimeReadinessActionLoadingById: {},
    runtimeReadinessActionErrorById: {},
  })
}

const readyReadiness: RuntimeReadiness = {
  ok: true,
  machine_code: 'ready',
  label_hint: 'Ready',
  checked_at: '2026-04-24T00:00:00.000Z',
}

const loginReadiness: RuntimeReadiness = {
  ok: false,
  machine_code: 'preflight/not_authenticated',
  label_hint: 'Login',
  checked_at: '2026-04-24T00:00:00.000Z',
}

const loginReadinessWithActions: RuntimeReadiness = {
  ...loginReadiness,
  actions: [
    {
      id: 'codex.login.docs',
      kind: 'open_external_url',
      label: 'Open login docs',
      docs_url: 'https://developers.openai.com/codex/auth',
      safety: 'manual',
    },
    {
      id: 'bad.secret',
      kind: 'show_guidance',
      label: 'Leak',
      guidance: 'token=secret /home/user/private',
      safety: 'manual',
    },
  ],
  details: {
    title: 'Login required',
    summary: 'Complete Codex auth outside Modly.',
    diagnostics: {
      runtime_source: 'path',
      auth_state: 'missing',
      raw_output: 'token=secret',
    },
  },
}

test('installFromGitHub preserves legacy single-extension installs and refreshes model ownership', async () => {
  const modelExtension = createModelExtension('legacy-model', 'legacy-model/node')
  installMockWindow({
    success: true,
    extensionId: 'legacy-model',
    extension: modelExtension,
  }, ['legacy-model/node'])
  resetStoreState()

  const result = await useExtensionsStore.getState().installFromGitHub('https://github.com/example/legacy-model')
  const state = useExtensionsStore.getState()

  assert.equal(result.success, true)
  assert.deepEqual(state.modelExtensions.map((extension: AnyExtension) => extension.id), ['legacy-model'])
  assert.deepEqual(state.readyOwnerIds, ['legacy-model/owner'])
  assert.equal(state.installError, null)
  assert.equal(state.installResult?.status, 'success')
  assert.deepEqual(state.installResult?.installed.map((entry: InstalledExtensionResult) => entry.extensionId), ['legacy-model'])
  assert.deepEqual(state.installProgress, {
    step: 'done',
    success: true,
    extensionId: 'legacy-model',
    status: 'success',
    completedChildren: 1,
    totalChildren: 1,
  })
})

test('installFromGitHub merges installed bundle children into model and process collections', async () => {
  const existingProcess = createProcessExtension('existing-process')
  const existingModel = createModelExtension('existing-model', 'existing-model/node')
  const bundledProcess = createProcessExtension('bundle-process')
  const bundledModel = createModelExtension('bundle-model', 'bundle-model/node')

  installMockWindow({
    success: true,
    status: 'success',
    installed: [
      { extensionId: 'bundle-process', extension: bundledProcess, status: 'success' },
      { extensionId: 'bundle-model', extension: bundledModel, status: 'success' },
    ],
    failed: [],
    warnings: [],
    reloaded: true,
  }, ['bundle-model/node'])
  resetStoreState()
  useExtensionsStore.setState({
    modelExtensions: [existingModel as never],
    processExtensions: [existingProcess as never],
  })

  const result = await useExtensionsStore.getState().installFromGitHub('https://github.com/example/bundle')
  const state = useExtensionsStore.getState()

  assert.equal(result.status, 'success')
  assert.deepEqual(state.processExtensions.map((extension: AnyExtension) => extension.id), ['existing-process', 'bundle-process'])
  assert.deepEqual(state.modelExtensions.map((extension: AnyExtension) => extension.id), ['existing-model', 'bundle-model'])
  assert.deepEqual(state.readyOwnerIds, ['bundle-model/owner'])
  assert.equal(state.installError, null)
  assert.equal(state.installResult?.installed.length, 2)
  assert.deepEqual(state.installProgress, {
    step: 'done',
    success: true,
    status: 'success',
    completedChildren: 2,
    totalChildren: 2,
  })
})

test('installFromGitHub keeps partial installs merged and surfaces failed children with warnings', async () => {
  const partialProcess = createProcessExtension('partial-process')

  installMockWindow({
    success: true,
    status: 'partial',
    installed: [
      { extensionId: 'partial-process', extension: partialProcess, status: 'success' },
    ],
    failed: [
      { extensionId: 'broken-model', stage: 'setup', error: 'setup failed' },
    ],
    warnings: ['broken-model: setup failed'],
    reloaded: true,
    error: 'setup failed',
  })
  resetStoreState()

  const result = await useExtensionsStore.getState().installFromGitHub('https://github.com/example/partial-bundle')
  const state = useExtensionsStore.getState()

  assert.equal(result.success, true)
  assert.equal(result.status, 'partial')
  assert.deepEqual(state.processExtensions.map((extension: AnyExtension) => extension.id), ['partial-process'])
  assert.equal(state.installError, null)
  assert.deepEqual(state.installResult?.failed, [
    { extensionId: 'broken-model', stage: 'setup', error: 'setup failed' },
  ] satisfies FailedExtensionResult[])
  assert.deepEqual(state.installResult?.warnings, ['broken-model: setup failed'])
  assert.deepEqual(state.installProgress, {
    step: 'done',
    success: true,
    status: 'partial',
    completedChildren: 1,
    totalChildren: 2,
  })
})

test('ensureRuntimeReadiness debounces duplicate ids and caches fresh readiness', async () => {
  const readiness = {
    calls: [] as string[][],
    responses: [
      Promise.resolve({
        success: true,
        models: {
          'codex/text-to-image': loginReadiness,
        },
      }),
    ],
  }
  installMockWindow({ success: true }, [], readiness)
  resetStoreState()

  const first = useExtensionsStore.getState().ensureRuntimeReadiness(['codex/text-to-image', 'codex/text-to-image'])
  const second = useExtensionsStore.getState().ensureRuntimeReadiness(['codex/text-to-image'])
  await Promise.all([first, second])

  assert.deepEqual(readiness.calls, [['codex/text-to-image']])
  assert.equal(useExtensionsStore.getState().runtimeReadinessById['codex/text-to-image']?.label_hint, 'Login')

  await useExtensionsStore.getState().ensureRuntimeReadiness(['codex/text-to-image'])
  assert.deepEqual(readiness.calls, [['codex/text-to-image']])
})

test('ensureRuntimeReadiness marks stale cache on failure and returns checking failed without cache', async () => {
  const readiness = {
    calls: [] as string[][],
    responses: [
      { success: false, error: 'Backend unavailable', models: {} },
      { success: true, models: { 'codex/text-to-image': readyReadiness } },
      { success: false, error: 'Backend unavailable again', models: {} },
    ],
  }
  installMockWindow({ success: true }, [], readiness)
  resetStoreState()

  await useExtensionsStore.getState().ensureRuntimeReadiness(['codex/text-to-image'])
  assert.equal(useExtensionsStore.getState().runtimeReadinessById['codex/text-to-image']?.label_hint, 'Checking failed')

  await useExtensionsStore.getState().ensureRuntimeReadiness(['codex/text-to-image'], { force: true })
  assert.equal(useExtensionsStore.getState().runtimeReadinessById['codex/text-to-image']?.label_hint, 'Ready')

  await useExtensionsStore.getState().ensureRuntimeReadiness(['codex/text-to-image'], { force: true })
  const stale = useExtensionsStore.getState().runtimeReadinessById['codex/text-to-image']
  assert.equal(stale?.label_hint, 'Ready')
  assert.equal(stale?.stale, true)
})

test('ensureRuntimeReadiness stores bounded actions and details without leaking unsafe fields or opening URLs', async () => {
  const shellCalls: string[] = []
  const readiness = {
    calls: [] as string[][],
    responses: [
      { success: true, models: { 'codex/text-to-image': loginReadinessWithActions } },
    ],
  }
  installMockWindow({ success: true }, [], readiness, shellCalls)
  resetStoreState()

  await useExtensionsStore.getState().ensureRuntimeReadiness(['codex/text-to-image'])

  const stored = useExtensionsStore.getState().runtimeReadinessById['codex/text-to-image']
  assert.deepEqual(stored?.actions?.map((action) => action.id), ['codex.login.docs'])
  assert.deepEqual(stored?.details?.diagnostics, {
    runtime_source: 'path',
    auth_state: 'missing',
  })
  assert.equal(stored?.details?.summary, 'Complete Codex auth outside Modly.')
  assert.deepEqual(shellCalls, [])
})

test('runRuntimeReadinessAction forces refresh for refresh_readiness actions and records bounded loading state', async () => {
  const readiness = {
    calls: [] as string[][],
    responses: [
      { success: true, models: { 'codex/text-to-image': loginReadiness } },
      { success: true, models: { 'codex/text-to-image': readyReadiness } },
    ],
  }
  installMockWindow({ success: true }, [], readiness)
  resetStoreState()

  await useExtensionsStore.getState().ensureRuntimeReadiness(['codex/text-to-image'])
  await useExtensionsStore.getState().runRuntimeReadinessAction('codex/text-to-image', {
    id: 'refresh',
    kind: 'refresh_readiness',
    label: 'Refresh',
    safety: 'non_destructive',
  })

  assert.deepEqual(readiness.calls, [['codex/text-to-image'], ['codex/text-to-image']])
  assert.equal(useExtensionsStore.getState().runtimeReadinessById['codex/text-to-image']?.label_hint, 'Ready')
  assert.equal(useExtensionsStore.getState().runtimeReadinessActionLoadingById['codex/text-to-image:refresh'], false)
  assert.equal(useExtensionsStore.getState().runtimeReadinessActionErrorById['codex/text-to-image:refresh'], null)
})

test('runRuntimeReadinessAction does not execute open_external_url without explicit dispatcher', async () => {
  const shellCalls: string[] = []
  installMockWindow({ success: true }, [], undefined, shellCalls)
  resetStoreState()

  const result = await useExtensionsStore.getState().runRuntimeReadinessAction('codex/text-to-image', {
    id: 'docs',
    kind: 'open_external_url',
    label: 'Docs',
    docs_url: 'https://developers.openai.com/codex/cli',
    safety: 'manual',
  })

  assert.deepEqual(result, { success: false, error: 'Runtime readiness action requires explicit UI dispatch.' })
  assert.deepEqual(shellCalls, [])
  assert.equal(useExtensionsStore.getState().runtimeReadinessActionErrorById['codex/text-to-image:docs'], 'Runtime readiness action requires explicit UI dispatch.')
})

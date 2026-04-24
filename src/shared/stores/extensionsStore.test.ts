import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AnyExtension, FailedExtensionResult, InstalledExtensionResult, RuntimeReadiness, RuntimeReadinessAction } from '../types/electron.d'

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
          async isDownloaded(id: string) { return downloadedIds.includes(id) },
          async installedWeightVariants() { return [] },
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
  useExtensionsStore.getState().invalidateRuntimeReadiness()
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
  const readiness: NonNullable<Parameters<typeof installMockWindow>[2]> = {
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

test('ensureRuntimeReadiness deduplicates overlapping batches by exact capability', async () => {
  let release!: (value: { success: boolean; models: Record<string, RuntimeReadiness> }) => void
  const deferred = new Promise<{ success: boolean; models: Record<string, RuntimeReadiness> }>((resolve) => { release = resolve })
  const readiness = { calls: [] as string[][], responses: [deferred, Promise.resolve({ success: true, models: { 'ext/c': loginReadiness } })] }
  installMockWindow({ success: true }, [], readiness)
  resetStoreState()
  const first = useExtensionsStore.getState().ensureRuntimeReadiness(['ext/a', 'ext/b'])
  const second = useExtensionsStore.getState().ensureRuntimeReadiness(['ext/b', 'ext/c'])
  await Promise.resolve()
  assert.deepEqual(readiness.calls, [['ext/a', 'ext/b'], ['ext/c']])
  release({ success: true, models: { 'ext/a': readyReadiness, 'ext/b': loginReadiness } })
  await Promise.all([first, second])
  assert.equal(useExtensionsStore.getState().runtimeReadinessById['ext/b'].label_hint, 'Login')
})

test('ensureRuntimeReadiness discards old lifecycle responses without clearing a new request', async () => {
  let release!: (value: { success: boolean; models: Record<string, RuntimeReadiness> }) => void
  const deferred = new Promise<{ success: boolean; models: Record<string, RuntimeReadiness> }>((resolve) => { release = resolve })
  const readiness = { calls: [] as string[][], responses: [deferred, Promise.resolve({ success: true, models: { 'ext/a': loginReadiness } })] }
  installMockWindow({ success: true }, [], readiness)
  resetStoreState()
  const old = useExtensionsStore.getState().ensureRuntimeReadiness(['ext/a'])
  await Promise.resolve()
  useExtensionsStore.getState().invalidateRuntimeReadiness()
  await useExtensionsStore.getState().ensureRuntimeReadiness(['ext/a'])
  release({ success: true, models: { 'ext/a': readyReadiness } })
  await old
  assert.equal(useExtensionsStore.getState().runtimeReadinessById['ext/a'].label_hint, 'Login')
  assert.equal(useExtensionsStore.getState().runtimeReadinessLoadingById['ext/a'], false)
})

test('loadExtensions restores installed and paused download controls before optional readiness settles', async () => {
  const { getNodeState, NodeInstallControl } = await import(new URL('../../areas/models/components/extensionShared.tsx', import.meta.url).href)
  let release!: (value: { success: boolean; models: Record<string, RuntimeReadiness> }) => void
  const deferred = new Promise<{ success: boolean; models: Record<string, RuntimeReadiness> }>((resolve) => { release = resolve })
  const readiness = { calls: [] as string[][], responses: [deferred] }
  installMockWindow({ success: true }, ['ext/node'], readiness)
  resetStoreState()
  const extension = createModelExtension('ext')
  window.electron.extensions.list = async () => [extension] as AnyExtension[]
  let activeDownloadsCalled = false
  window.electron.model.activeDownloads = async () => {
    activeDownloadsCalled = true
    return [{ modelId: 'ext/node', percent: 25, paused: true }]
  }
  let installedIds: string[] = []
  let downloads: Record<string, { percent: number; paused?: boolean }> = {}
  // Exercise the real store and the ModelsPage loadExtensions().then recovery order.
  const initialization = useExtensionsStore.getState().loadExtensions().then(async () => {
    const active = await window.electron.model.activeDownloads()
    downloads = Object.fromEntries(active.map(({ modelId, ...progress }) => [modelId, progress]))
    if (await window.electron.model.isDownloaded('ext/node')) installedIds.push('ext/node')
  })
  try {
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(readiness.calls, [['ext/node']])
    assert.equal(useExtensionsStore.getState().runtimeReadinessLoadingById['ext/node'], true)
    assert.equal(activeDownloadsCalled, true, 'readiness must not delay download recovery')
    assert.deepEqual(installedIds, ['ext/node'])
    assert.equal(getNodeState('ext', extension.nodes[0], installedIds, {}).kind, 'installed')
    const html = renderToStaticMarkup(createElement(NodeInstallControl, {
      state: getNodeState('ext', extension.nodes[0], installedIds, downloads),
      onInstall() {}, onPause() {}, onResume() {}, onCancel() {},
    }))
    assert.match(html, /Resume download/)
    assert.match(html, /Cancel download/)
    assert.doesNotMatch(html, />Install</)
  } finally {
    release({ success: true, models: { 'ext/node': readyReadiness } })
    await initialization
    await useExtensionsStore.getState().ensureRuntimeReadiness(['ext/node'])
    resetStoreState()
  }
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
  assert.deepEqual(stored?.actions?.map((action: RuntimeReadinessAction) => action.id), ['codex.login.docs'])
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

test('runtime actions reject disabled and unknown payloads before explicit dispatch', async () => {
  installMockWindow({ success: true })
  resetStoreState()
  const calls: unknown[] = []
  const dispatch = async (action: unknown) => { calls.push(action); return { success: true } }
  for (const action of [null, { id: 'x', kind: 'repair_extension', label: 'Repair', safety: 'confirm' }, {
    id: 'docs', kind: 'open_external_url', label: 'Docs', safety: 'manual',
    docs_url: 'https://example.com/docs', disabled: true,
  }]) {
    const result = await useExtensionsStore.getState().runRuntimeReadinessAction('ext/node', action as never, { dispatch })
    assert.equal(result.success, false)
  }
  assert.deepEqual(calls, [])
})

test('runtime action completion cannot refresh or clear a new lifecycle action', async () => {
  const readiness = { calls: [] as string[][], responses: [] }
  installMockWindow({ success: true }, [], readiness)
  resetStoreState()
  const action = { id: 'docs', kind: 'open_external_url', label: 'Docs', safety: 'manual', docs_url: 'https://example.com/docs', refresh_after: 'always' } as const
  let finishOld!: (value: { success: boolean }) => void
  let finishNew!: (value: { success: boolean }) => void
  const old = useExtensionsStore.getState().runRuntimeReadinessAction('ext/node', action, {
    dispatch: () => new Promise((resolve) => { finishOld = resolve }),
  })
  useExtensionsStore.getState().invalidateRuntimeReadiness()
  const current = useExtensionsStore.getState().runRuntimeReadinessAction('ext/node', action, {
    dispatch: () => new Promise((resolve) => { finishNew = resolve }),
  })
  try {
    finishOld({ success: true })
    await old
    assert.deepEqual(readiness.calls, [], 'old action must not consult the new lifecycle')
    assert.equal(useExtensionsStore.getState().runtimeReadinessActionLoadingById['ext/node:docs'], true)
  } finally {
    finishNew({ success: true })
    await current
    resetStoreState()
  }
})

test('refresh action reports failed checks but does not claim a backend cache bypass', async () => {
  const readiness: { calls: string[][]; responses: Array<{ success: boolean; models: Record<string, RuntimeReadiness> }> } = { calls: [], responses: [
    { success: true, models: { 'ext/node': loginReadiness } },
    { success: true, models: { 'ext/node': loginReadiness } },
    { success: false, models: {} },
  ] }
  installMockWindow({ success: true }, [], readiness)
  resetStoreState()
  await useExtensionsStore.getState().ensureRuntimeReadiness(['ext/node'])
  const action = { id: 'refresh', kind: 'refresh_readiness', label: 'Refresh', safety: 'non_destructive' } as const
  assert.equal((await useExtensionsStore.getState().runRuntimeReadinessAction('ext/node', action)).success, true)
  assert.equal(useExtensionsStore.getState().runtimeReadinessById['ext/node'].checked_at, loginReadiness.checked_at)
  assert.equal((await useExtensionsStore.getState().runRuntimeReadinessAction('ext/node', action)).success, false)
  assert.equal(useExtensionsStore.getState().runtimeReadinessById['ext/node'].stale, true)
})

test('runtime action deduplicates clicks and strips unrecognized dispatch fields', async () => {
  installMockWindow({ success: true })
  resetStoreState()
  const action = { id: 'docs', kind: 'open_external_url', label: 'Docs', safety: 'manual', docs_url: 'https://example.com/docs', command: 'must not leave renderer' } as const
  let finish!: (result: { success: boolean }) => void
  const calls: unknown[] = []
  const dispatch = (payload: unknown): Promise<{ success: boolean }> => {
    calls.push(payload)
    return new Promise((resolve) => { finish = resolve })
  }
  const first = useExtensionsStore.getState().runRuntimeReadinessAction('ext/node', action, { dispatch })
  try {
    assert.equal((await useExtensionsStore.getState().runRuntimeReadinessAction('ext/node', action, { dispatch })).success, false)
    assert.deepEqual(calls, [{ id: 'docs', kind: 'open_external_url', label: 'Docs', safety: 'manual', docs_url: 'https://example.com/docs' }])
  } finally {
    finish({ success: true })
    await first
    resetStoreState()
  }
})

test('readiness store preserves HTTPS queries and fragments until explicit validated dispatch', async () => {
  const { createRuntimeReadinessActionHandler } = await import(new URL('../../../electron/main/model-runtime-readiness.ts', import.meta.url).href)
  const opened: string[] = []
  const dispatch = createRuntimeReadinessActionHandler({ async openExternal(url: string) { opened.push(url) } })
  for (const docs_url of [
    'https://example.invalid/docs?tab=linux&version=0.122.0#install',
    'https://example.invalid/docs?topic=api_key#authorization',
  ]) {
    const action: RuntimeReadinessAction = { id: 'docs.query', kind: 'open_external_url', label: 'Platform docs', safety: 'manual', docs_url }
    const readiness = { calls: [] as string[][], responses: [
      { success: true, models: { 'ext/node': { ...readyReadiness, actions: [action] } } },
    ] }
    installMockWindow({ success: true }, [], readiness)
    resetStoreState()
    try {
      await useExtensionsStore.getState().ensureRuntimeReadiness(['ext/node'])
      assert.deepEqual(useExtensionsStore.getState().runtimeReadinessById['ext/node'].actions, [action])
      assert.deepEqual(opened, [], 'ingestion must not open documentation')
      assert.equal((await useExtensionsStore.getState().runRuntimeReadinessAction('ext/node', action)).success, false)
      assert.deepEqual(opened, [], 'a dispatcher remains mandatory')
      assert.deepEqual(await useExtensionsStore.getState().runRuntimeReadinessAction('ext/node', action, { dispatch }), { success: true })
      assert.deepEqual(opened.splice(0), [docs_url])
      for (const invalid of ['http://example.invalid/docs', 'https://user:pass@example.invalid/docs', 'https://example.invalid:invalid/docs']) {
        assert.equal((await useExtensionsStore.getState().runRuntimeReadinessAction('ext/node', { ...action, docs_url: invalid }, { dispatch })).success, false)
      }
      assert.deepEqual(opened, [])
    } finally {
      resetStoreState()
    }
  }
})

test('readiness store omits drive paths from text and details', async () => {
  for (const path of [
    'C:/Users/Example/AppData/Local/codex.exe',
    'C:\\Users\\Example\\AppData\\Local\\codex.exe',
    'C:/Users\\Example/AppData/Local/codex.exe',
    '/home/example/bin/codex',
    'Located at C:/Users/Example/codex.exe',
    '(z:/Users/Example/codex.exe)',
    '"C:\\Users\\Example\\codex.exe"',
  ]) {
    const readiness = { calls: [] as string[][], responses: [
      { success: true, models: { 'ext/node': { ...readyReadiness, details: {
        title: path, summary: 'Runtime at ' + path, guidance: path,
        diagnostics: { runtime_source: path, auth_state: 'authenticated', runtime_version: '0.122.0' },
        evidence: { runtime_source: 'path', runtime_name: path },
      } } } },
    ] }
    installMockWindow({ success: true }, [], readiness)
    resetStoreState()
    try {
      await useExtensionsStore.getState().ensureRuntimeReadiness(['ext/node'])
      assert.deepEqual(useExtensionsStore.getState().runtimeReadinessById['ext/node'].details, {
        diagnostics: { auth_state: 'authenticated', runtime_version: '0.122.0' },
        evidence: { runtime_source: 'path' },
      })
    } finally {
      resetStoreState()
    }
  }
})

test('readiness store preserves HTTPS prose in guidance and details', async () => {
  for (const text of [
    'See https://example.invalid/docs for help.',
    'https://example.invalid/docs',
    'Docs (https://example.invalid/docs#install).',
  ]) {
    const action: RuntimeReadinessAction = { id: 'guide', kind: 'show_guidance', label: 'Setup guide', safety: 'manual', guidance: text }
    const details = { title: text, summary: text, guidance: text }
    const readiness = { calls: [] as string[][], responses: [
      { success: true, models: { 'ext/node': { ...readyReadiness, actions: [action], details } } },
    ] }
    installMockWindow({ success: true }, [], readiness)
    resetStoreState()
    try {
      await useExtensionsStore.getState().ensureRuntimeReadiness(['ext/node'])
      assert.deepEqual(useExtensionsStore.getState().runtimeReadinessById['ext/node'].actions, [action])
      assert.deepEqual(useExtensionsStore.getState().runtimeReadinessById['ext/node'].details, details)
    } finally {
      resetStoreState()
    }
  }
})

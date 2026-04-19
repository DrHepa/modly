import assert from 'node:assert/strict'
import test from 'node:test'
import type { AnyExtension, FailedExtensionResult, InstalledExtensionResult } from '../types/electron.d'

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

function installMockWindow(result: MockInstallResult, downloadedIds: string[] = []) {
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
  })
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

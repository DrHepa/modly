import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-preload-download-')), 'electron-api.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('electron/preload/electron-api.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

test('renderer model actions keep node and shared-weight identities explicit', async () => {
  const { createElectronApi } = loadModule()
  const calls = []
  const ipc = {
    invoke: async (...args) => { calls.push(args); return { success: true } },
    send: () => {},
    on: () => {},
    removeAllListeners: () => {},
  }
  const api = createElectronApi(
    ipc,
    { setZoomFactor: () => {} },
    { getPathForFile: () => '' },
  )

  await api.model.isDownloaded('pixal3d/generate')
  await api.model.hasLocalData('pixal3d/generate')
  await api.model.sharedGroups('pixal3d')
  await api.model.download('pixal3d/generate')
  await api.model.deleteSharedGroup('pixal3d', 'base')
  await api.model.deleteExtensionWeights('pixal3d')

  assert.deepEqual(calls, [
    ['model:isDownloaded', 'pixal3d/generate'],
    ['model:hasLocalData', 'pixal3d/generate'],
    ['model:sharedGroups', 'pixal3d'],
    ['model:download', 'pixal3d/generate'],
    ['model:deleteSharedGroup', 'pixal3d', 'base'],
    ['model:deleteExtensionWeights', 'pixal3d'],
  ])
})

test('UI exposes partial-data removal and dependent-node warnings', () => {
  const page = readFileSync(resolve('src/areas/models/ModelsPage.tsx'), 'utf8')
  const drawer = readFileSync(resolve('src/areas/models/components/ExtensionDrawer.tsx'), 'utf8')

  assert.match(page, /window\.electron\.model\.hasLocalData\(fullId\)/)
  assert.match(page, /deleteExtensionWeights\(extId\)/)
  assert.match(drawer, /localDataIds\.includes\(fullId\) && state\.kind !== 'downloading'/)
  assert.match(drawer, /Remove partial model data/)
  assert.match(drawer, /following nodes will become unavailable/)
})

test('owner progress preserves capability, variant and cancellation metadata through the factory', async () => {
  const { createElectronApi } = loadModule()
  const calls = [], listeners = new Map()
  const ipc = {
    invoke: async (...args) => { calls.push(args); return { success: true } },
    send: () => {}, on: (channel, fn) => listeners.set(channel, fn), removeAllListeners: () => {},
  }
  const api = createElectronApi(ipc, { setZoomFactor: () => {} }, { getPathForFile: () => '' })
  let received
  api.model.onProgress((data) => { received = data })
  const payload = { capabilityId: 'bundle/a', modelId: 'bundle/a', variantId: 'Q4', percent: 20,
    bytesDownloaded: 200, totalBytes: 1000, stalledSeconds: 1, paused: true, cancelled: false }
  listeners.get('model:downloadProgress')(null, payload)
  assert.deepEqual(received, payload)
  await api.model.download('bundle/a', 'Q4')
  await api.model.pauseDownload('bundle/a')
  await api.model.cancelDownload('bundle/a')
  assert.deepEqual(calls, [
    ['model:download', 'bundle/a', 'Q4'], ['model:pauseDownload', 'bundle/a'], ['model:cancelDownload', 'bundle/a'],
  ])
})

test('renderer exposes legacy, structured, and multi-source model download actions', async () => {
  const { createElectronApi } = loadModule()
  const calls = []
  const ipcRenderer = {
    invoke: async (...args) => { calls.push(args); return { success: true } },
    send: () => {},
    on: () => {},
    removeAllListeners: () => {},
  }
  const api = createElectronApi(ipcRenderer, { setZoomFactor: () => {} }, { getPathForFile: () => '' })

  await api.model.isDownloaded('pixal3d/generate')
  await api.model.hasLocalData('pixal3d/generate')
  await api.model.download('pixal3d/generate')
  await api.model.downloadAssets('pixal3d/generate')
  await api.model.downloadSources('pixal3d/generate')
  await api.model.downloadHttpsAssets('pixal3d/generate')
  await api.model.pauseDownload('pixal3d/generate')
  await api.model.cancelDownload('pixal3d/generate')

  assert.deepEqual(calls, [
    ['model:isDownloaded', 'pixal3d/generate'],
    ['model:hasLocalData', 'pixal3d/generate'],
    ['model:download', 'pixal3d/generate'],
    ['model:downloadAssets', { modelId: 'pixal3d/generate' }],
    ['model:downloadSources', { modelId: 'pixal3d/generate' }],
    ['model:downloadHttpsAssets', { modelId: 'pixal3d/generate' }],
    ['model:pauseDownload', 'pixal3d/generate'],
    ['model:cancelDownload', 'pixal3d/generate'],
  ])
})


test('the CURRENT canonical preload identifier forms the manifest-owned main-process payload', async () => {
  const contractFile = join(mkdtempSync(join(tmpdir(), 'modly-download-contract-')), 'contract.cjs')
  const built = buildSync({
    entryPoints: [resolve('electron/main/model-download-ipc-contract.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(contractFile, built.outputFiles[0].text, 'utf8')
  const require = createRequire(import.meta.url)
  const { parseLegacyModelDownloadPayload } = require(contractFile)
  const calls = []
  const api = loadModule().createElectronApi(
    { invoke: async (...args) => { calls.push(args); return { success: true } }, send: () => {}, on: () => {}, removeAllListeners: () => {} },
    { setZoomFactor: () => {} }, { getPathForFile: () => '' },
  )
  await api.model.download('pixal3d/generate')
  assert.deepEqual(parseLegacyModelDownloadPayload({ modelId: calls[0][1] }), {
    modelId: 'pixal3d/generate', skipPrefixes: undefined, includePrefixes: undefined,
  })
})


test('multi-source cancellation preserves completed files by removing only partial artifacts', () => {
  const main = readFileSync(resolve('electron/main/ipc-handlers.ts'), 'utf8')
  const page = readFileSync(resolve('src/areas/models/ModelsPage.tsx'), 'utf8')
  const shared = readFileSync(resolve('src/areas/models/components/extensionShared.tsx'), 'utf8')

  assert.match(main, /model:cancelDownload[\s\S]*active\.done[\s\S]*removePartialDownloadArtifacts/)
  assert.doesNotMatch(main, /model:cancelDownload[\s\S]*rmAsync\(modelDir[\s\S]*model:export/)
  assert.match(main, /plan\.sharedGroups[\s\S]*downloadModelSourcesFromHF\(modelId,\s*target\.targetId[\s\S]*model:downloadSources/)
  assert.match(main, /downloadModelFromHF\([\s\S]*plan\.repoId[\s\S]*step\.skipPrefixes,\s*step\.includePrefixes[\s\S]*model:download'/)
  assert.match(main, /parseLegacyModelDownloadPayloadContract[\s\S]*modelId[\s\S]*resolveModelPlan/)
  assert.match(page, /nodeHasManagedWeights\(node\)[\s\S]*modelApi\.download\(fullId, variantId\)/)
  assert.match(shared, /nodeHasManagedWeights[\s\S]*node\.hasModelSources/)
})


test('extension uninstall deletes owned models before removing the extension directory', () => {
  const main = readFileSync(resolve('electron/main/ipc-handlers.ts'), 'utf8')
  const uninstallBlock = main.match(/ipcMain\.handle\('extensions:uninstall'[\s\S]*?ipcMain\.handle\('extensions:repair'/)?.[0] ?? ''

  assert.match(uninstallBlock, /weightOperations\.remove[\s\S]*unloadExtensionForRemoval[\s\S]*rmWithRetry\(extensionRoot[\s\S]*removeExtensionWithBackups/)
})

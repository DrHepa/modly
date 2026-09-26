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

test('renderer exposes legacy, structured, and multi-source model download actions', async () => {
  const { createElectronApi } = loadModule()
  const calls = []
  const ipcRenderer = {
    invoke: async (...args) => { calls.push(args); return { success: true } },
    send: () => {},
    on: () => {},
    removeAllListeners: () => {},
  }
  const api = createElectronApi({ ipcRenderer, webFrame: { setZoomFactor: () => {} } })

  await api.model.isDownloaded('pixal3d/generate')
  await api.model.hasLocalData('pixal3d/generate')
  await api.model.download('org/legacy', 'pixal3d/generate', ['skip/'], ['include/'])
  await api.model.downloadAssets('pixal3d/generate')
  await api.model.downloadSources('pixal3d/generate')
  await api.model.downloadHttpsAssets('pixal3d/generate')
  await api.model.pauseDownload('pixal3d/generate')
  await api.model.cancelDownload('pixal3d/generate')

  assert.deepEqual(calls, [
    ['model:isDownloaded', 'pixal3d/generate'],
    ['model:hasLocalData', 'pixal3d/generate'],
    ['model:download', { repoId: 'org/legacy', modelId: 'pixal3d/generate', skipPrefixes: ['skip/'], includePrefixes: ['include/'] }],
    ['model:downloadAssets', { modelId: 'pixal3d/generate' }],
    ['model:downloadSources', { modelId: 'pixal3d/generate' }],
    ['model:downloadHttpsAssets', { modelId: 'pixal3d/generate' }],
    ['model:pauseDownload', 'pixal3d/generate'],
    ['model:cancelDownload', 'pixal3d/generate'],
  ])
})

test('the exact preload legacy payload is accepted by the main-process parser contract', async () => {
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
  const api = loadModule().createElectronApi({
    ipcRenderer: { invoke: async (...args) => { calls.push(args); return { success: true } }, send: () => {}, on: () => {}, removeAllListeners: () => {} },
    webFrame: { setZoomFactor: () => {} },
  })
  await api.model.download('org/legacy', 'pixal3d/generate', [], ['weights/'])
  assert.deepEqual(parseLegacyModelDownloadPayload(calls[0][1]), {
    modelId: 'pixal3d/generate', repoId: 'org/legacy', skipPrefixes: [], includePrefixes: ['weights/'],
  })
})

test('multi-source cancellation preserves completed files by removing only partial artifacts', () => {
  const main = readFileSync(resolve('electron/main/ipc-handlers.ts'), 'utf8')
  const page = readFileSync(resolve('src/areas/models/ModelsPage.tsx'), 'utf8')
  const shared = readFileSync(resolve('src/areas/models/components/extensionShared.tsx'), 'utf8')

  assert.match(main, /model:cancelDownload[\s\S]*waitForActiveDownloadSettlement[\s\S]*removePartialDownloadArtifacts/)
  assert.doesNotMatch(main, /model:cancelDownload[\s\S]*rmAsync\(modelDir[\s\S]*model:export/)
  assert.match(main, /model:downloadSources[\s\S]*resolveInstalledModelDownloadPlan[\s\S]*plan\.sharedGroups[\s\S]*downloadModelSourcesFromHF\(modelId,\s*downloadPlan\.targetId/)
  assert.match(main, /model:download'[\s\S]*resolveInstalledModelDownloadPlan[\s\S]*downloadModelFromHF\(plan\.repoId[\s\S]*plan\.skipPrefixes,\s*plan\.includePrefixes/)
  assert.match(main, /parseLegacyModelDownloadPayload[\s\S]*repoId[\s\S]*skipPrefixes[\s\S]*includePrefixes/)
  assert.match(page, /node\.hasModelSources[\s\S]*downloadSources\(fullId\)/)
  assert.match(shared, /nodeHasManagedWeights[\s\S]*node\.hasModelSources/)
})

test('extension uninstall deletes owned models before removing the extension directory', () => {
  const main = readFileSync(resolve('electron/main/ipc-handlers.ts'), 'utf8')
  const uninstallBlock = main.match(/ipcMain\.handle\('extensions:uninstall'[\s\S]*?ipcMain\.handle\('extensions:repair'/)?.[0] ?? ''

  assert.match(uninstallBlock, /deleteOwnedModelPaths[\s\S]*rmAsync\(extPath/)
})

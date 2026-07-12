import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const ipcSource = readFileSync(
  new URL('./ipc-handlers.ts', import.meta.url),
  'utf8',
)

test('IPC registers HTTPS asset downloads through the shared structured handler', () => {
  assert.match(
    ipcSource,
    /ipcMain\.handle\('model:downloadHttpsAssets',[\s\S]*?handleStructuredModelAssetDownload\([\s\S]*?downloadModelAssetsFromHttps/,
  )
  assert.match(
    ipcSource,
    /return modelAssetDownloadResult\(error\)/,
  )
  assert.match(
    ipcSource,
    /error instanceof ModelAssetDownloadError \? \{ failure: error\.failure \} : \{\}/,
  )
})

test('IPC validates exactly two safe capability segments and rejects duplicate downloads', () => {
  assert.match(
    ipcSource,
    /const segments = modelId\.split\('\/'\)/,
  )
  assert.match(
    ipcSource,
    /if \(segments\.length !== 2\)/,
  )
  assert.match(
    ipcSource,
    /assertSafeOwnershipSegment\([\s\S]*?'Model asset download extension segment'/,
  )
  assert.match(
    ipcSource,
    /assertSafeOwnershipSegment\([\s\S]*?'Model asset download node segment'/,
  )
  assert.match(
    ipcSource,
    /if \(activeDownloads\.has\(modelId\)\)/,
  )
  assert.match(
    ipcSource,
    /code: 'download_in_progress'/,
  )
})

test('structured HTTPS plans suppress optimistic downloaded fallback', () => {
  assert.match(
    ipcSource,
    /ownership\.httpsDownloads\?\.length \|\| ownership\.hfDownloads\?\.length/,
  )
})

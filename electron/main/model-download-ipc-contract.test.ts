import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parseLegacyModelDownloadPayload } from './model-download-ipc-contract.ts'

const ipcSource = readFileSync(
  new URL('./ipc-handlers.ts', import.meta.url),
  'utf8',
)
const contractSource = readFileSync(
  new URL('./model-download-ipc-contract.ts', import.meta.url),
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
    contractSource,
    /const segments = value\.modelId\.split\('\/'\)/,
  )
  assert.match(
    contractSource,
    /if \(segments\.length !== 2\)/,
  )
  assert.match(
    contractSource,
    /assertSafeOwnershipSegment\([\s\S]*?'Model asset download extension segment'/,
  )
  assert.match(
    contractSource,
    /assertSafeOwnershipSegment\([\s\S]*?'Model asset download node segment'/,
  )
  assert.match(
    ipcSource,
    /activeDownloadKeysForOwnership\(ownership, siblingCapabilityIds\)/,
  )
  assert.match(
    ipcSource,
    /runTrackedModelDownload\(ownership\.weightOwnerId/,
  )
  assert.match(
    ipcSource,
    /code: 'download_in_progress'/,
  )
  assert.match(
    ipcSource,
    /code: 'download_in_progress'[\s\S]*?retryable: true/,
  )
})

test('download readiness fallback uses owner-scoped validation instead of raw model paths', () => {
  assert.doesNotMatch(ipcSource, /ownedDownloaded \|\| isModelDownloaded\(/)
  assert.doesNotMatch(ipcSource, /isModelDownloaded\(modelsDir, modelId\)/)
})

test('structured plans and legacy readiness use the owner-scoped result', () => {
  assert.match(ipcSource, /const ownedDownloaded = isOwnedModelDownloaded\(modelsDir, ownership\)/)
  assert.match(ipcSource, /return ownedDownloaded/)
})


test('explicit download cancellation is neutral rather than retryable failure state', () => {
  const downloaderSource = readFileSync(
    new URL('./model-downloader.ts', import.meta.url),
    'utf8',
  )

  assert.match(downloaderSource, /event\.progress\.cancelled/)
  assert.doesNotMatch(downloaderSource, /code: 'download_cancelled'[\s\S]*?retryable: true/)
})

test('IPC registers a pending settlement before owner resolution so early cancel waits', () => {
  assert.match(ipcSource, /beginPendingDownloadSettlement\(modelId\)/)
  assert.match(ipcSource, /localDownloadControl\(modelId\)/)
  assert.match(ipcSource, /waitForActiveDownloadSettlement\(modelId\)/)
  assert.match(ipcSource, /if \(control\.cancel\)[\s\S]*?status: 'cancelled'/)
})

test('legacy model downloads release pending settlement and clear owner controls', () => {
  assert.match(
    ipcSource,
    /ipcMain\.handle\('model:download',[\s\S]*?finally \{[\s\S]*?activeDownloads\.delete\(modelId\)[\s\S]*?clearLocalDownloadControlAliases\([\s\S]*?releasePendingDownload\(\)/,
  )
})

test('legacy model download validates malformed IPC payloads before entering the guarded path', () => {
  assert.match(
    ipcSource,
    /ipcMain\.handle\('model:download', async \(event, payload: unknown\) => \{[\s\S]*?parseLegacyModelDownloadPayloadContract\(payload\)/,
  )
})

test('preload legacy download payload is accepted by the centralized main-process parser', () => {
  const preloadPayload = {
    repoId: 'org/legacy',
    modelId: 'pixal3d/generate',
    skipPrefixes: ['skip/'],
    includePrefixes: ['include/'],
  }
  assert.deepEqual(parseLegacyModelDownloadPayload(preloadPayload), preloadPayload)
  assert.throws(
    () => parseLegacyModelDownloadPayload({ ...preloadPayload, modelId: '../outside' }),
    /exactly two segments|segment .* invalid/,
  )
})

test('immediate cancel latches a pending owner cancel without deleting inactive partials', () => {
  assert.match(ipcSource, /const hadOwnerSettlement = keys\.some\(\(key\) => activeDownloadSettlements\.has\(key\)\)/)
  assert.match(ipcSource, /findLocalDownloadControl\(keys\) \?\? localDownloadControl\(modelId\)/)
  assert.match(ipcSource, /if \(hadOwnerSettlement\) \{[\s\S]*?removePartialDownloadArtifacts/)
})

test('structured downloads re-check local control immediately before backend fetch', () => {
  assert.match(
    ipcSource,
    /handleStructuredModelAssetDownload[\s\S]*?if \(control\.cancel\) \{[\s\S]*?status: 'cancelled'[\s\S]*?return[\s\S]*?if \(control\.pause\) \{[\s\S]*?status: 'paused'[\s\S]*?return[\s\S]*?await runTrackedModelDownload\(owner\.weightOwnerId/,
  )
})

test('structured downloads send the ownership-derived target owner to the backend', () => {
  assert.match(
    ipcSource,
    /downloader\(modelId, owner\.weightOwnerId, \(progress\) =>/,
  )
})

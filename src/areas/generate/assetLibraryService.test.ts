import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  AssetLibraryListRequest,
  AssetLibraryOpenRequest,
  AssetLibraryReadRequest,
} from '../../shared/types/assetLibrary.ts'
import {
  listAssetLibraryEntries,
  openAssetLibraryEntry,
  readAssetLibraryEntry,
} from './assetLibraryService.ts'

const originalWindow = globalThis.window

function installLibraryWindow(stubs: {
  listCalls?: AssetLibraryListRequest[]
  readCalls?: AssetLibraryReadRequest[]
  openCalls?: AssetLibraryOpenRequest[]
}) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electron: {
        workspace: {
          library: {
            list: async () => {
              stubs.listCalls?.push({})
              return {
                success: true,
                entries: [
                  {
                    id: 'landmark-1',
                    workspacePath: 'Workflows/landmarks/run-1/node-1.landmarks.v1.json',
                    displayName: 'Shoulder landmarks',
                    capability: 'landmarks-sidecar',
                    state: 'ready',
                    previewKind: 'text',
                    source: {
                      relation: 'sidecar-source',
                      workspacePath: 'Characters/source.glb',
                      assetId: 'source-asset-1',
                      versionId: 'source-version-1',
                    },
                    warnings: [],
                  },
                ],
              }
            },
            read: async (request: AssetLibraryReadRequest) => {
              stubs.readCalls?.push(request)
              return {
                success: true,
                entry: {
                  id: 'mesh-1',
                  workspacePath: request.workspacePath,
                  displayName: 'Hero mesh',
                  capability: 'mesh',
                  state: 'ready',
                  previewKind: '3d-model',
                  warnings: [],
                },
                preview: {
                  kind: '3d-model',
                  viewerKind: 'glb',
                },
              }
            },
            open: async (request: AssetLibraryOpenRequest) => {
              stubs.openCalls?.push(request)
              return {
                success: true,
                entry: {
                  id: 'mesh-1',
                  workspacePath: request.workspacePath,
                  displayName: 'Hero mesh',
                  capability: 'mesh',
                  state: 'ready',
                  artifactId: 'artifact-1',
                  versionId: 'version-1',
                  previewKind: '3d-model',
                  warnings: [],
                },
              }
            },
          },
        },
      },
    },
  })
}

test.afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  })
})

test('assetLibraryService delegates list/read/open through preload and projects renderer-safe entries', async () => {
  const listCalls: AssetLibraryListRequest[] = []
  const readCalls: AssetLibraryReadRequest[] = []
  const openCalls: AssetLibraryOpenRequest[] = []
  installLibraryWindow({ listCalls, readCalls, openCalls })

  const [listResult, readResult, openResult] = await Promise.all([
    listAssetLibraryEntries(),
    readAssetLibraryEntry({ workspacePath: 'Characters/hero.glb' }),
    openAssetLibraryEntry({ workspacePath: 'Characters/hero.glb' }),
  ])

  assert.deepEqual(listCalls, [{}])
  assert.deepEqual(readCalls, [{ workspacePath: 'Characters/hero.glb' }])
  assert.deepEqual(openCalls, [{ workspacePath: 'Characters/hero.glb' }])

  assert.equal(listResult.success, true)
  if (listResult.success === true) {
    assert.deepEqual(listResult.entries[0].openTarget, {
      kind: 'linked-source',
      workspacePath: 'Characters/source.glb',
      relation: 'sidecar-source',
    })
  }

  assert.equal(readResult.success, true)
  if (readResult.success === true) {
    assert.deepEqual(readResult.entry.openTarget, {
      kind: 'self',
      workspacePath: 'Characters/hero.glb',
    })
    assert.deepEqual(readResult.preview, {
      kind: '3d-model',
      viewerKind: 'glb',
    })
  }

  assert.equal(openResult.success, true)
  if (openResult.success === true) {
    assert.deepEqual(openResult.entry.openTarget, {
      kind: 'self',
      workspacePath: 'Characters/hero.glb',
    })
    assert.equal(openResult.entry.artifactId, 'artifact-1')
    assert.equal(openResult.entry.versionId, 'version-1')
  }
})

test('assetLibraryService rejects unsafe renderer requests before preload is called', async () => {
  const readCalls: AssetLibraryReadRequest[] = []
  const openCalls: AssetLibraryOpenRequest[] = []
  installLibraryWindow({ readCalls, openCalls })

  await assert.rejects(() => readAssetLibraryEntry({ workspacePath: '../outside/hero.glb' }), /safe workspace-relative path/i)
  await assert.rejects(() => openAssetLibraryEntry({ workspacePath: 'Characters/hero.glb', sourceWorkspacePath: '/outside/source.glb' }), /safe workspace-relative path/i)

  assert.deepEqual(readCalls, [])
  assert.deepEqual(openCalls, [])
})

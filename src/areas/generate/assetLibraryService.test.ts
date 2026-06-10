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
                    sourceScope: 'workflows',
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
                  sourceScope: 'workflows',
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
                  sourceScope: 'workflows',
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

test('library service rejects malformed envelopes, absent methods and malformed optional source before dispatch', async () => {
  installLibraryWindow({})
  const library = window.electron.workspace.library
  for (const sourceWorkspacePath of [null, false, 0, '', {}, ' Workflows/source.glb']) {
    await assert.rejects(() => openAssetLibraryEntry({ workspacePath: 'Workflows/hero.glb', sourceWorkspacePath } as unknown as AssetLibraryOpenRequest), /safe workspace-relative/)
  }
  for (const payload of [undefined, null, {}, { success: true }, { success: false, error: {} }, { success: true, entries: [{}] }]) {
    library.list = async () => payload as never
    await assert.rejects(() => listAssetLibraryEntries(), /Invalid asset library/)
  }
  library.open = undefined as never
  await assert.rejects(() => openAssetLibraryEntry({ workspacePath: 'Workflows/hero.glb' }), /unavailable/)
})

test('library service validates typed optional identities without rejecting unknown producer metadata', async () => {
  installLibraryWindow({})
  const library = window.electron.workspace.library
  const entry = { id: 'library:Workflows/a.glb', workspacePath: 'Workflows/a.glb', displayName: 'A', sourceScope: 'workflows', capability: 'mesh', state: 'ready', previewKind: '3d-model', warnings: [] }
  for (const patch of [{ artifactId: 42 }, { versionId: [] }, { createdAt: {} }, { provenance: [] }, { provenance: { workflowId: 2 } }, { source: { relation: 'source', assetId: {} } }, { manifest: { capability: 'scene-manifest', workspacePath: 'Workflows/world.json', title: {} } }]) {
    library.list = async () => ({ success: true, entries: [{ ...entry, ...patch }] }) as never
    await assert.rejects(() => listAssetLibraryEntries(), /Invalid asset library entries/)
  }
  const provenance = { workflowId: 'wf', vendor: { model: 'custom', revisions: [1, 2] } }
  library.list = async () => ({ success: true, entries: [{ ...entry, provenance }] }) as never
  const result = await listAssetLibraryEntries()
  assert.ok(result.success)
  assert.deepEqual(result.entries[0].provenance, provenance)

  library.list = async () => ({ success: true, entries: [entry, { ...entry }] }) as never
  await assert.rejects(() => listAssetLibraryEntries(), /duplicate identity/)
  library.open = async () => ({ success: true, entry: { ...entry, workspacePath: 'Workflows/other.glb' } }) as never
  await assert.rejects(() => openAssetLibraryEntry({ workspacePath: entry.workspacePath }), /entry response/)
  library.read = async () => ({ success: true, entry, preview: { kind: 'text', content: 'x', byteLength: -1, truncated: false } }) as never
  await assert.rejects(() => readAssetLibraryEntry({ workspacePath: entry.workspacePath }), /preview/)
})

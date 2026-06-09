import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  ArtifactRegistryReadRequest,
  ArtifactRegistryReadResult,
  WorkspaceArtifactDownloadRequest,
  WorkspaceArtifactDownloadResult,
  WorkspaceArtifactPreviewRequest,
  WorkspaceArtifactPreviewResult,
} from '../../shared/types/electron.d.ts'
import {
  downloadWorkspaceArtifact,
  previewWorkspaceArtifact,
  readWorkspaceArtifactSidecar,
  captureViewerWorkspaceArtifactService,
} from './viewerWorkspaceArtifactService.ts'

const originalWindow = globalThis.window

function installArtifactWindow(stubs: {
  previewResult?: WorkspaceArtifactPreviewResult
  downloadResult?: WorkspaceArtifactDownloadResult
  sidecarResult?: ArtifactRegistryReadResult
  previewCalls?: WorkspaceArtifactPreviewRequest[]
  downloadCalls?: WorkspaceArtifactDownloadRequest[]
  sidecarCalls?: ArtifactRegistryReadRequest[]
}) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electron: {
        workspace: {
          artifacts: {
            previewWorkspaceArtifact: async (request: WorkspaceArtifactPreviewRequest) => {
              stubs.previewCalls?.push(request)
              return stubs.previewResult ?? { success: true, status: '3d-model', workspacePath: request.workspacePath, displayName: 'avatar.glb', viewerKind: 'glb' }
            },
            downloadWorkspaceArtifact: async (request: WorkspaceArtifactDownloadRequest) => {
              stubs.downloadCalls?.push(request)
              return stubs.downloadResult ?? { success: true, status: 'saved', workspacePath: request.workspacePath, targetPath: '/tmp/avatar.glb' }
            },
            readSidecar: async (request: ArtifactRegistryReadRequest) => {
              stubs.sidecarCalls?.push(request)
              return stubs.sidecarResult ?? { success: true, sidecar: { artifactId: 'artifact-1', workspacePath: request.workspacePath, metadata: { schema: 'modly.test' } } }
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

test('viewer workspace artifact service delegates preview, download, and sidecar reads without reshaping successful requests', async () => {
  const previewCalls: WorkspaceArtifactPreviewRequest[] = []
  const downloadCalls: WorkspaceArtifactDownloadRequest[] = []
  const sidecarCalls: ArtifactRegistryReadRequest[] = []
  installArtifactWindow({ previewCalls, downloadCalls, sidecarCalls })

  const previewRequest = { workspacePath: 'Workflows/generated/avatar.glb' }
  const downloadRequest = { workspacePath: 'Workflows/generated/avatar.glb', suggestedName: 'avatar.glb' }
  const sidecarRequest = { workspacePath: 'Workflows/generated/avatar.rigmeta.json' }

  const [previewResult, downloadResult, sidecarResult] = await Promise.all([
    previewWorkspaceArtifact(previewRequest),
    downloadWorkspaceArtifact(downloadRequest),
    readWorkspaceArtifactSidecar(sidecarRequest),
  ])

  assert.deepEqual(previewCalls, [previewRequest])
  assert.deepEqual(downloadCalls, [downloadRequest])
  assert.deepEqual(sidecarCalls, [sidecarRequest])
  assert.deepEqual(previewResult, { success: true, status: '3d-model', workspacePath: 'Workflows/generated/avatar.glb', displayName: 'avatar.glb', viewerKind: 'glb' })
  assert.deepEqual(downloadResult, { success: true, status: 'saved', workspacePath: 'Workflows/generated/avatar.glb', targetPath: '/tmp/avatar.glb' })
  assert.deepEqual(sidecarResult, {
    success: true,
    sidecar: { artifactId: 'artifact-1', workspacePath: 'Workflows/generated/avatar.rigmeta.json', metadata: { schema: 'modly.test' } },
  })
})

test('viewer workspace artifact service rejects unsafe workspace-relative paths before electron is called', async () => {
  const previewCalls: WorkspaceArtifactPreviewRequest[] = []
  const downloadCalls: WorkspaceArtifactDownloadRequest[] = []
  const sidecarCalls: ArtifactRegistryReadRequest[] = []
  installArtifactWindow({ previewCalls, downloadCalls, sidecarCalls })

  await assert.rejects(() => previewWorkspaceArtifact({ workspacePath: '../outside/avatar.glb' }), /safe workspace-relative path/i)
  await assert.rejects(() => downloadWorkspaceArtifact({ workspacePath: '/outside/avatar.glb' }), /safe workspace-relative path/i)
  await assert.rejects(() => readWorkspaceArtifactSidecar({ workspacePath: 'C:/outside/avatar.rigmeta.json' }), /safe workspace-relative path/i)

  assert.deepEqual(previewCalls, [])
  assert.deepEqual(downloadCalls, [])
  assert.deepEqual(sidecarCalls, [])
})

test('viewer workspace artifact services return rejected promises for absent and non-callable ports', async () => {
  for (const artifacts of [undefined, {}, { previewWorkspaceArtifact: true, downloadWorkspaceArtifact: 'not-callable', readSidecar: 1 }]) {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { electron: { workspace: { artifacts } } } })
    for (const invoke of [previewWorkspaceArtifact, downloadWorkspaceArtifact, readWorkspaceArtifactSidecar]) {
      let result: Promise<unknown> | undefined
      assert.doesNotThrow(() => { result = invoke({ workspacePath: 'models/hero.glb' }) })
      await assert.rejects(result!, /unavailable/i)
    }
  }
})

test('viewer workspace paths reject ambiguous canonical forms before invoking physical IO', async () => {
  const calls: WorkspaceArtifactPreviewRequest[] = []
  installArtifactWindow({ previewCalls: calls })
  for (const workspacePath of ['a/./hero.glb', 'a//hero.glb', 'a\\hero.glb', ' a/hero.glb', 'a/hero.glb ', 'a/%252e.glb', 'a/hero.glb?x', 'a/hero\0.glb']) {
    await assert.rejects(previewWorkspaceArtifact({ workspacePath }), /safe workspace-relative/i)
  }
  assert.deepEqual(calls, [])
})

test('captured workspace services retire before dispatch and after await instead of routing to replacement ports', async () => {
  for (const method of ['previewWorkspaceArtifact', 'downloadWorkspaceArtifact', 'readWorkspaceArtifactSidecar'] as const) {
    const calls: unknown[] = []
    installArtifactWindow({ previewCalls: calls as WorkspaceArtifactPreviewRequest[], downloadCalls: calls as WorkspaceArtifactDownloadRequest[], sidecarCalls: calls as ArtifactRegistryReadRequest[] })
    const retired = captureViewerWorkspaceArtifactService()
    installArtifactWindow({})
    assert.equal(retired.isCurrent(), false)
    await assert.rejects(retired[method]({ workspacePath: 'models/hero.glb' }), /changed|retired/)
    assert.deepEqual(calls, [])

    const portName = method === 'readWorkspaceArtifactSidecar' ? 'readSidecar' : method
    const dispatched: string[] = []
    let resolve!: (value: never) => void
    const promise = new Promise<never>(yes => { resolve = yes })
    const ports = window.electron.workspace.artifacts
    const original = ports[portName]
    Object.assign(ports, { [portName]: () => { dispatched.push('original'); return promise } })
    const captured = captureViewerWorkspaceArtifactService()
    const result = captured[method]({ workspacePath: 'models/hero.glb' })
    assert.deepEqual(dispatched, ['original'])
    Object.assign(ports, { [portName]: original })
    resolve({ success: true } as never)
    await assert.rejects(result, /changed|retired/)
    assert.deepEqual(dispatched, ['original'])
  }
})

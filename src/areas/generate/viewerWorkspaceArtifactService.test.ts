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

test('viewer workspace artifact service passes through audio preview payloads without reshaping', async () => {
  installArtifactWindow({
    previewResult: {
      success: true,
      status: 'audio',
      workspacePath: 'Workflows/audio/theme.ogg',
      displayName: 'theme.ogg',
      byteLength: 128,
      audioKind: 'ogg',
      sourceUrl: '/workspace/Workflows/audio/theme.ogg',
    },
  })

  const previewResult = await previewWorkspaceArtifact({ workspacePath: 'Workflows/audio/theme.ogg' })

  assert.deepEqual(previewResult, {
    success: true,
    status: 'audio',
    workspacePath: 'Workflows/audio/theme.ogg',
    displayName: 'theme.ogg',
    byteLength: 128,
    audioKind: 'ogg',
    sourceUrl: '/workspace/Workflows/audio/theme.ogg',
  })
})

import assert from 'node:assert/strict'
import test from 'node:test'

const { normalizeHfDownloads } = await import(new URL('./hf-download-manifest.ts', import.meta.url).href)
const { parseExtensionManifest } = await import(new URL('./automation-capabilities.ts', import.meta.url).href)

const revision = 'ef15eda2e413f994e3b4657960b0309487587718'

test('normalizes pinned allowlisted hf_downloads descriptors', () => {
  assert.deepEqual(normalizeHfDownloads([{
    repo_id: 'TrNi/efficient-cube3d',
    revision,
    target_subdir: 'cube3d',
    files: [
      { path: 'config.json' },
      { path: 'weights/model.pt', sha256: 'A'.repeat(64) },
    ],
  }]), [{
    repoId: 'TrNi/efficient-cube3d',
    revision,
    targetSubdir: 'cube3d',
    files: [
      { path: 'config.json' },
      { path: 'weights/model.pt', sha256: 'a'.repeat(64) },
    ],
  }])
})

test('rejects mutable revisions and unsafe asset paths', () => {
  assert.throws(() => normalizeHfDownloads([{
    repo_id: 'owner/model',
    revision: 'main',
    target_subdir: 'cube3d',
    files: [{ path: 'model.pt' }],
  }]), /40-character commit SHA/)

  assert.throws(() => normalizeHfDownloads([{
    repo_id: 'owner/model',
    revision,
    target_subdir: '../escape',
    files: [{ path: 'model.pt' }],
  }]), /safe relative path/)
})

test('manifest parsing propagates hf_downloads and keeps legacy fields', () => {
  const extension = parseExtensionManifest({
    id: 'cube3d',
    type: 'model',
    nodes: [{
      id: 'generate',
      input: 'text',
      output: 'mesh',
      hf_repo: 'TrNi/efficient-cube3d',
      download_check: 'cube3d/model.pt',
      hf_downloads: [{
        repo_id: 'TrNi/efficient-cube3d',
        revision,
        target_subdir: 'cube3d',
        files: [{ path: 'model.pt', sha256: '0'.repeat(64) }],
      }],
    }],
  }, 'cube3d', new Set(), false)

  assert.equal(extension.nodes[0].hfRepo, 'TrNi/efficient-cube3d')
  assert.equal(extension.nodes[0].downloadCheck, 'cube3d/model.pt')
  assert.deepEqual(extension.nodes[0].hfDownloads, [{
    repoId: 'TrNi/efficient-cube3d',
    revision,
    targetSubdir: 'cube3d',
    files: [{ path: 'model.pt', sha256: '0'.repeat(64) }],
  }])
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const outfile = join(mkdtempSync(join(tmpdir(), 'modly-scene-source-')), 'scene.cjs')
writeFileSync(outfile, buildSync({
  entryPoints: [resolve('src/areas/workflows/workflowSceneSource.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text)
const { resolveSceneSourceManifest } = createRequire(import.meta.url)(outfile)
const encoded = Buffer.from(JSON.stringify({ schema: 'modly.scene-manifest.v1', sceneRoot: '.', assets: [] })).toString('base64')

test('Load Scene resolves directory and manifest to the same workspace manifest without image bytes', async () => {
  const reads = []
  const readFileBase64 = async (path) => { reads.push(path); return encoded }
  for (const scenePath of ['Worlds/room', 'Worlds/room/scene-manifest.json']) {
    const result = await resolveSceneSourceManifest({ scenePath, workspaceDir: '/workspace', readFileBase64 })
    assert.equal(result.ok, true)
    assert.equal(result.manifestWorkspacePath, 'Worlds/room/scene-manifest.json')
  }
  assert.deepEqual(reads, ['/workspace/Worlds/room/scene-manifest.json', '/workspace/Worlds/room/scene-manifest.json'])
})

test('Load Scene refuses traversal before reading', async () => {
  let reads = 0
  const result = await resolveSceneSourceManifest({ scenePath: '../outside', workspaceDir: '/workspace', readFileBase64: async () => { reads++; return encoded } })
  assert.equal(result.ok, false)
  assert.equal(reads, 0)
})

test('Load Scene rejects backend-unsafe source and manifest paths before success', async () => {
  let reads = 0
  const readFileBase64 = async () => { reads++; return encoded }
  for (const scenePath of ['file:scene', 'https://example.com/scene', 'Worlds/%2e%2e', 'Worlds/%25x', 'Worlds/room/', ' Worlds/room']) {
    const result = await resolveSceneSourceManifest({ scenePath, workspaceDir: '/workspace', readFileBase64 })
    assert.equal(result.ok, false, scenePath)
  }
  assert.equal(reads, 0)
  for (const manifest of [
    { schema: 'modly.scene-manifest.v1', sceneRoot: 'file:scene', assets: [] },
    { schema: 'modly.scene-manifest.v1', sceneRoot: '%2e%2e', assets: [] },
    { schema: 'modly.scene-manifest.v1', sceneRoot: '.', assets: [{ path: 'https://example.com/mesh.glb' }] },
    { schema: 'modly.scene-manifest.v1', sceneRoot: '.', assets: [{ workspacePath: 'Worlds/safe.glb', path: '../unsafe.glb' }] },
    { schema: 'modly.scene-manifest.v1', sceneRoot: '.', assets: [{ workspacePath: null, path: 'safe.glb' }] },
    { schema: 'modly.scene-manifest.v1', sceneRoot: '.', assets: [{ workspacePath: 'Worlds/safe.glb', path: 4 }] },
    { schema: 'modly.scene-manifest.v1', sceneRoot: '.', assets: [], preview: { image: '%2e%2e.png' } },
    { schema: 'modly.scene-manifest.v1', sceneRoot: '.', assets: [], preview: { image: null } },
  ]) {
    const result = await resolveSceneSourceManifest({
      scenePath: 'Worlds/room', workspaceDir: '/workspace',
      readFileBase64: async () => Buffer.from(JSON.stringify(manifest)).toString('base64'),
    })
    assert.equal(result.ok, false, JSON.stringify(manifest))
  }
})

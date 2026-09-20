import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const outfile = join(mkdtempSync(join(tmpdir(), 'modly-capture-source-')), 'capture.cjs')
writeFileSync(outfile, buildSync({
  entryPoints: [resolve('src/areas/workflows/workflowCaptureSource.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text)
const { resolveCaptureSourceManifest } = createRequire(import.meta.url)(outfile)

const manifest = {
  schema: 'modly.capture-manifest.v1', captureRoot: '.', kind: 'frames',
  frames: [
    { index: 0, path: 'frames/0000.png', width: 64, height: 48, byteSize: 120 },
    { index: 1, path: 'frames/0001.png', width: 64, height: 48, byteSize: 121 },
  ],
  provenance: { source: 'test', ordering: 'manifest-index' },
}
const encoded = Buffer.from(JSON.stringify(manifest)).toString('base64')

test('Load Capture resolves a directory or manifest without reading media bytes', async () => {
  const reads = []
  for (const capturePath of ['Captures/room', 'Captures/room/capture-manifest.json']) {
    const result = await resolveCaptureSourceManifest({
      capturePath, workspaceDir: '/workspace',
      readFileBase64: async (path) => { reads.push(path); return encoded },
    })
    assert.equal(result.ok, true)
    assert.equal(result.manifestWorkspacePath, 'Captures/room/capture-manifest.json')
    assert.equal(result.kind, 'frames')
  }
  assert.deepEqual(reads, ['/workspace/Captures/room/capture-manifest.json', '/workspace/Captures/room/capture-manifest.json'])
})

test('Load Capture rejects traversal and nondeterministic frame order', async () => {
  let reads = 0
  const traversal = await resolveCaptureSourceManifest({
    capturePath: '../outside', workspaceDir: '/workspace',
    readFileBase64: async () => { reads++; return encoded },
  })
  assert.equal(traversal.ok, false)
  assert.equal(reads, 0)
  const bad = { ...manifest, frames: [manifest.frames[1], manifest.frames[0]] }
  const result = await resolveCaptureSourceManifest({
    capturePath: 'Captures/room', workspaceDir: '/workspace',
    readFileBase64: async () => Buffer.from(JSON.stringify(bad)).toString('base64'),
  })
  assert.equal(result.ok, false)
})

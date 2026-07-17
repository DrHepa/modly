import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function loadParser() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-extension-manifest-test-')), 'manifest.cjs')
  const result = buildSync({
    entryPoints: [resolve('electron/main/extension-manifest.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return createRequire(import.meta.url)(outfile)
}

test('named input contract survives installed manifest parsing', () => {
  const { parseExtensionManifest } = loadParser()
  const parsed = parseExtensionManifest({
    id: 'demo',
    source: 'https://github.com/owner/demo/',
    input_labels: ['Top-level legacy label'],
    io_contract: 'named-v1',
    input_ports: [
      { name: 'front', type: 'image', label: 'Front RGB Image', required: true },
    ],
    nodes: [
      {
        id: 'fallback',
        input: 'image',
        inputs: ['image'],
        input_labels: ['Legacy image'],
      },
      {
        id: 'override',
        input: 'image',
        io_contract: 'named-v1',
        input_ports: [
          { name: 'side', type: 'image', label: 'Side RGB Image', required: false },
        ],
      },
    ],
  }, 'fallback-id', new Set(['https://github.com/owner/demo']))

  assert.equal(parsed.trusted, true)
  assert.equal(parsed.nodes[0].io_contract, 'named-v1')
  assert.deepEqual(parsed.nodes[0].input_ports, [
    { name: 'front', type: 'image', label: 'Front RGB Image', required: true },
  ])
  assert.deepEqual(parsed.nodes[0].inputs, ['image'])
  assert.deepEqual(parsed.nodes[0].inputLabels, ['Legacy image'])
  assert.deepEqual(parsed.nodes[1].input_ports, [
    { name: 'side', type: 'image', label: 'Side RGB Image', required: false },
  ])
})

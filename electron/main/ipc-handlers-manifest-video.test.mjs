import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'

// Exercise the authoritative parser without Electron, discovery, HTTP or model runs.
const bundle = (await build({
  entryPoints: [fileURLToPath(new URL('./automation-capabilities.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', write: false,
  define: { 'import.meta.url': JSON.stringify(new URL('./automation-capabilities.ts', import.meta.url).href) },
  external: ['axios'],
})).outputFiles[0].text
const require = createRequire(import.meta.url)
const module = { exports: {} }
vm.runInNewContext(bundle, {
  module, exports: module.exports, process, console,
  require(id) {
    if (id === 'axios') return { get() { throw new Error('HTTP is forbidden in this parser fixture') } }
    return require(id)
  },
})
const { parseExtensionManifest } = module.exports
const plain = (value) => JSON.parse(JSON.stringify(value))

test('desktop manifest contract parses video scalars and both open multi-port dialects', async () => {
  const source = await readFile(new URL('./ipc-handlers.ts', import.meta.url), 'utf8')
  const authority = await readFile(new URL('./automation-capabilities.ts', import.meta.url), 'utf8')
  assert.match(source, /import\s*{[^}]*parseExtensionManifest[^}]*type ParsedManifest[^}]*}\s*from ['"]\.\/automation-capabilities['"]/s)
  const parsedManifest = authority.slice(
    authority.indexOf('export type ParsedManifest = {'),
    authority.indexOf('export type ListedExtensionNode'),
  )
  assert.match(parsedManifest, /input\?:\s*string/)
  assert.match(parsedManifest, /inputs\?:\s*string\[\] \| ProcessPort\[\]/)
  assert.match(parsedManifest, /output\?:\s*string/)

  const extension = parseExtensionManifest({
    id: 'video-contract', type: 'process', entry: 'processor.js',
    nodes: [
      { id: 'scalar', input: 'video', output: 'video' },
      { id: 'positional', input: 'video', inputs: ['video', 'custom-port'], output: 'custom-output' },
      { id: 'named', input: 'video', inputs: [
        { name: 'clip', type: 'video', required: true },
        { name: 'metadata', type: 'custom-port', required: false },
      ], output: 'video' },
    ],
  }, 'video-contract', new Set(), false)
  assert.equal(extension.nodes[0].input, 'video')
  assert.equal(extension.nodes[0].output, 'video')
  assert.deepEqual(plain(extension.nodes[1].inputs), ['video', 'custom-port'])
  assert.equal(extension.nodes[1].output, 'custom-output')
  assert.deepEqual(plain(extension.nodes[2].inputs), [
    { name: 'clip', type: 'video', required: true },
    { name: 'metadata', type: 'custom-port', required: false },
  ])
  assert.equal(extension.nodes[2].input, 'video')
  assert.equal(extension.nodes[2].output, 'video')
})

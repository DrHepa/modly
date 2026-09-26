import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
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

async function loadModule(entryPoint) {
  const result = await build({
    entryPoints: [resolve(entryPoint)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    plugins: [{
      name: 'unused-runtime-dependencies',
      setup(build) {
        build.onResolve({ filter: /^(?:axios|esbuild|tar)$/ }, ({ path }) => ({
          path,
          namespace: 'unused-runtime-dependencies',
        }))
        build.onLoad({ filter: /.*/, namespace: 'unused-runtime-dependencies' }, ({ path }) => ({
          contents: path === 'axios'
            ? 'export default {}'
            : path === 'esbuild'
              ? 'export function buildSync() { throw new Error("unused in manifest parser test") }'
              : 'export function x() { throw new Error("unused in manifest parser test") }',
          loader: 'js',
        }))
      },
    }],
    write: false,
  })
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-ipc-manifest-test-')), 'module.mjs')
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return import(pathToFileURL(outfile).href)
}

function governedLocalManifest() {
  const node = (id, input, output, mediaType) => ({
    id,
    input,
    output,
    params_schema: [],
    agent: {
      schema: 'modly.agent-capability-declaration.v1',
      capability_id: `local-agent/${id}`,
      display_name: `Create ${id}`,
      description: `Create the ${id} artifact.`,
      approval: { required: true, scope: 'single_action' },
      process: {
        schema: 'modly.agent-process.v1',
        runtimeFiles: ['processor.py'],
        resourceFiles: [],
        runtime: { kind: 'extension-python-venv-v1', interpreter: 'bin/python' },
        artifacts: {
          maxCount: 1,
          maxTotalBytes: 4096,
          allowed: [{ kind: output, mediaTypes: [mediaType], maxBytes: 4096 }],
        },
      },
    },
  })
  return {
    id: 'local-agent',
    name: 'Local Agent',
    type: 'process',
    entry: 'processor.py',
    nodes: [
      node('plan', 'text', 'plan', 'application/json'),
      node('source', 'plan', 'source', 'text/x-python'),
      node('glb', 'source', 'glb', 'model/gltf-binary'),
      node('step', 'source', 'step', 'model/step'),
    ],
  }
}



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

test('local install validation allows model video outputs and rejects private Agent process video IO', async () => {
  const { validateInstallManifest } = await loadModule('electron/main/extension-install-utils.ts')
  assert.throws(() => validateInstallManifest({
    id: 'video-process',
    type: 'process',
    entry: 'processor.js',
    nodes: [{ agent: {}, id: 'video', input: 'video', output: 'mesh' }],
  }, { hasEntryFile: () => true, hasGeneratorFile: () => false }, 'repository'), /video/i)
  assert.doesNotThrow(() => validateInstallManifest({
    id: 'video-output',
    generator_class: 'Generator',
    nodes: [{ agent: {}, id: 'video', input: 'image', output: 'video' }],
  }, { hasEntryFile: () => false, hasGeneratorFile: () => true }, 'repository'))
  assert.throws(() => validateInstallManifest({
    id: 'video-process-output',
    type: 'process',
    entry: 'processor.js',
    nodes: [{ agent: {}, id: 'video', input: 'image', output: 'video' }],
  }, { hasEntryFile: () => true, hasGeneratorFile: () => false }, 'repository'), /video/i)
})


test('local install uses Agent-safe legacy parsing before linking', async () => {
  const source = await readFile(resolve('electron/main/ipc-handlers.ts'), 'utf8')
  const handler = source.slice(
    source.indexOf("ipcMain.handle('extensions:installFromLocal'"),
    source.indexOf("ipcMain.handle('extensions:reload'"),
  )

  const parseIndex = handler.indexOf('parseManifestForInstall(')
  const linkIndex = handler.indexOf('await symlink(')
  assert.ok(parseIndex >= 0, 'local install must use centralized Agent-safe manifest parsing')
  assert.ok(linkIndex >= 0, 'local install must retain its link step')
  assert.ok(parseIndex < linkIndex, 'raw Agent validation must happen before filesystem mutation')
  assert.doesNotMatch(source, /function parseExtensionManifest\(/)
})


test('local install response and subsequent listing share the Agent-only node projection while raw authority stays intact', async () => {
  const { parseManifestForInstall } = await loadModule('electron/main/github-extension-install.ts')
  const { listVisibleExtensions } = await loadModule('electron/main/automation-capabilities.ts')
  const root = await mkdtemp(join(tmpdir(), 'modly-local-agent-projection-'))
  const extensionDir = join(root, 'extensions', 'local-agent')
  const builtinDir = join(root, 'builtin')
  const manifest = governedLocalManifest()

  try {
    await mkdir(extensionDir, { recursive: true })
    await writeFile(join(extensionDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await writeFile(join(extensionDir, 'processor.py'), 'print("processor")\n')

    const immediate = parseManifestForInstall(
      { ...manifest, source: `local://${extensionDir}` },
      manifest.id,
      new Set(),
    )
    const listed = await listVisibleExtensions({
      builtinDir,
      userExtensionsDir: join(root, 'extensions'),
      trustedRepos: new Set(),
    })

    assert.deepEqual(immediate.nodes, [])
    assert.deepEqual(immediate.nodes, listed[0].nodes)
    const raw = JSON.parse(await readFile(join(extensionDir, 'manifest.json'), 'utf8'))
    assert.deepEqual(raw.nodes.map((node) => node.id), ['plan', 'source', 'glb', 'step'])
    assert.equal(raw.nodes.every((node) => Object.hasOwn(node, 'agent')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test('local install rejects raw Agent fields on model, missing, or invalid manifest types', async () => {
  const { parseManifestForInstall } = await loadModule('electron/main/github-extension-install.ts')

  for (const declaredType of ['model', undefined, 'invalid']) {
    const manifest = governedLocalManifest()
    if (declaredType === undefined) delete manifest.type
    else manifest.type = declaredType
    assert.throws(
      () => parseManifestForInstall(manifest, manifest.id, new Set()),
      /Agent declarations require a process manifest/i,
    )
  }
})

import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

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

test('local install validation allows model video outputs and rejects process video IO', async () => {
  const { validateInstallManifest } = await loadModule('electron/main/extension-install-utils.ts')
  assert.throws(() => validateInstallManifest({
    id: 'video-process',
    type: 'process',
    entry: 'processor.js',
    nodes: [{ id: 'video', input: 'video', output: 'mesh' }],
  }, { hasEntryFile: () => true, hasGeneratorFile: () => false }, 'repository'), /video/i)
  assert.doesNotThrow(() => validateInstallManifest({
    id: 'video-output',
    generator_class: 'Generator',
    nodes: [{ id: 'video', input: 'image', output: 'video' }],
  }, { hasEntryFile: () => false, hasGeneratorFile: () => true }, 'repository'))
  assert.throws(() => validateInstallManifest({
    id: 'video-process-output',
    type: 'process',
    entry: 'processor.js',
    nodes: [{ id: 'video', input: 'image', output: 'video' }],
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

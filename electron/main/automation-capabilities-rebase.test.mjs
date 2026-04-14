import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtemp, mkdir, rm, writeFile, symlink, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

register('../../scripts/node-ts-extensionless-loader.mjs', import.meta.url)
const discovery = await import('./automation-capabilities.ts')
const { createElectronApi } = await import('../preload/electron-api.ts')

const source = { id: 'main', provider: 'huggingface', repo_id: 'org/model', destination: '.', checks: ['weights.bin'] }
const processManifest = (id) => ({ id, type: 'process', entry: 'processor.js', nodes: [{ id: 'run', input: 'mesh', output: 'mesh' }] })

test('extracted parser preserves positional inputs, flexible kinds and inherited defaults', () => {
  const parsed = discovery.parseExtensionManifest({
    id: 'flexible', params_schema: [{ id: 'seed', type: 'int' }],
    param_defaults: { seed: 4, flag: true, text: 'base' },
    nodes: [{ id: 'generate', input: 'capture', inputs: ['image', 'image', 'audio', 'text'],
      input_labels: ['Front', 'Side', 'Audio', 'Prompt'], output: 'video',
      param_defaults: { seed: 0, flag: false, text: '' },
      hf_repo: 'org/model', hf_include_prefixes: ['weights'], hf_skip_prefixes: ['legacy'],
    }],
  }, 'fallback', new Set())
  const node = parsed.nodes[0]
  assert.deepEqual(node.inputs, ['image', 'image', 'audio', 'text'])
  assert.deepEqual(node.inputLabels, ['Front', 'Side', 'Audio', 'Prompt'])
  assert.equal(node.input, 'capture')
  assert.equal(node.output, 'video')
  assert.deepEqual(node.paramsSchema, [{ id: 'seed', type: 'int' }])
  assert.deepEqual(node.paramDefaults, { seed: 0, flag: false, text: '' })
  assert.deepEqual(node.hfIncludePrefixes, ['weights'])
  assert.deepEqual(node.hfSkipPrefixes, ['legacy'])
})

test('extracted parser retains shared groups, private sources and variant summaries', () => {
  const parsed = discovery.parseExtensionManifest({ id: 'managed', weight_groups: [{ id: 'base', model_sources: [source] }],
    nodes: [{ id: 'shared', weight_groups: ['base'] }, { id: 'private', model_sources: [source] }],
  }, 'fallback', new Set())
  assert.deepEqual(parsed.weightGroups, [{ id: 'base', dependentNodeIds: ['shared'] }])
  assert.deepEqual(parsed.nodes[0].weightGroups, ['base'])
  assert.equal(parsed.nodes[1].hasModelSources, true)
  const variants = discovery.parseExtensionManifest({ id: 'variants', params_schema: [{ id: 'precision', type: 'select', options: ['small'] }], nodes: [{ id: 'generate', hf_repo: 'org/model',
    weight_variants: { param: 'precision', default: 'small', options: [{ id: 'small', label: 'Small', include_prefixes: ['small/'], checks: ['small/model.bin'], size_gb: 2, vram_gb: 3 }] },
  }] }, 'fallback', new Set())
  assert.deepEqual(variants.nodes[0].weightVariants, { param: 'precision', default: 'small', options: [{ id: 'small', label: 'Small', sizeGb: 2, vramGb: 3 }] })
})

test('extracted parser keeps upstream scene and managed-weight rejection boundaries', () => {
  const parse = (manifest) => discovery.parseExtensionManifest(manifest, 'fallback', new Set())
  assert.throws(() => parse({ id: 'bad', model_sources: [source] }), /model_sources.*model node/)
  assert.throws(() => parse({ ...processManifest('bad'), weight_groups: [] }), /weight_groups.*model/)
  assert.throws(() => parse({ ...processManifest('bad'), nodes: [{ id: 'bad', model_sources: [source] }] }), /model_sources.*model/)
  assert.throws(() => parse({ ...processManifest('bad'), nodes: [{ id: 'bad', output: 'scene' }] }), /scene.*model|model.*scene/i)
  assert.throws(() => parse({ id: 'bad', nodes: [{ id: 'generate', input: 'scene', inputs: ['scene'] }] }), /scene.*single|single.*scene/i)
  assert.equal(parse({ id: 'scene', nodes: [{ id: 'generate', input: 'scene', output: 'scene' }] }).nodes[0].output, 'scene')
})

async function withFixtures(run) {
  const root = await mkdtemp(join(tmpdir(), 'modly-discovery-rebase-'))
  const options = { builtinDir: join(root, 'builtin'), userExtensionsDir: join(root, 'user'), trustedRepos: new Set() }
  await mkdir(options.builtinDir)
  await mkdir(options.userExtensionsDir)
  const writeManifest = async (base, id, manifest = processManifest(id)) => {
    const dir = join(base, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest))
    return dir
  }
  try { await run({ root, options, writeManifest }) } finally { await rm(root, { recursive: true, force: true }) }
}

test('all discovery surfaces preserve repairable metadata but exclude unsafe executable entries', async () => {
  await withFixtures(async ({ root, options, writeManifest }) => {
    await writeManifest(options.builtinDir, 'builtin')
    await writeManifest(options.userExtensionsDir, '.modly-staging-hidden')
    await writeManifest(options.userExtensionsDir, '.modly-backup-hidden-123')
    await writeManifest(options.userExtensionsDir, 'healthy')
    const incomplete = await writeManifest(options.userExtensionsDir, 'incomplete')
    await writeFile(join(incomplete, '.modly-incomplete'), '')
    const pending = await writeManifest(options.userExtensionsDir, 'pending')
    await writeFile(join(pending, '.modly-registration-pending'), '')
    await writeManifest(options.userExtensionsDir, 'sibling-pending')
    await writeFile(join(options.userExtensionsDir, '.modly-registration-pending-sibling-pending-123'), '')
    const invalid = await writeManifest(options.userExtensionsDir, 'invalid')
    await writeFile(join(invalid, 'manifest.json'), '{bad')
    const semanticInvalid = await writeManifest(options.userExtensionsDir, 'semantic-invalid', { id: 'semantic-invalid', model_sources: [source] })
    assert.ok(semanticInvalid)
    await mkdir(join(options.userExtensionsDir, 'missing'))
    const localDir = await writeManifest(root, 'linked-source', processManifest('linked'))
    await writeFile(join(localDir, '.modly-local'), localDir)
    await symlink(localDir, join(options.userExtensionsDir, 'linked'), 'dir')
    await symlink(join(root, 'absent'), join(options.userExtensionsDir, 'broken-link'), 'dir')

    const listed = await discovery.listVisibleExtensions(options)
    const detailed = await discovery.listVisibleExtensionsDetailed(options)
    assert.deepEqual(listed, detailed.extensions)
    assert.equal(listed[0].id, 'builtin')
    assert.ok(!listed.some((ext) => ext.id.startsWith('.') || ext.id === 'broken-link'))
    assert.equal(listed.find((ext) => ext.id === 'linked').source, `local://${localDir}`)
    for (const id of ['incomplete', 'pending', 'sibling-pending']) {
      const item = listed.find((ext) => ext.id === id)
      assert.equal(item.corrupted, true)
      assert.equal(item.manifestError, 'incomplete')
      assert.equal(item.type, 'process')
      assert.equal(item.nodes[0].id, 'run')
    }
    assert.equal(listed.find((ext) => ext.id === 'invalid').manifestError, 'invalid')
    assert.equal(listed.find((ext) => ext.id === 'semantic-invalid').manifestError, 'invalid')
    assert.deepEqual(listed.find((ext) => ext.id === 'missing'), {
      type: 'model', id: 'missing', name: 'missing', trusted: false, builtin: false,
      nodes: [], corrupted: true, manifestError: 'missing',
    })
    assert.ok(detailed.errors.some((error) => error.code === 'PROCESS_DISCOVERY_MANIFEST_INVALID'))
    const { processes } = await discovery.getManifestProcesses(options)
    assert.deepEqual(processes.map((item) => item.id).sort(), ['builtin/run', 'healthy/run', 'linked/run'])
    await assert.rejects(discovery.resolveCanonicalProcessTarget({ ...options, processId: 'incomplete/run' }), /not found/)
    const linked = await discovery.resolveCanonicalProcessTarget({ ...options, processId: 'linked/run' })
    assert.equal(linked.extDir, join(options.userExtensionsDir, 'linked'))
  })
})

test('active installs share visibility state with IPC and automation discovery', async () => {
  await withFixtures(async ({ options, writeManifest }) => {
    const dir = await writeManifest(options.userExtensionsDir, 'active')
    await writeFile(join(dir, '.modly-incomplete'), '')
    assert.ok(discovery.activeExtensionInstalls instanceof Set)
    discovery.activeExtensionInstalls.add('active')
    try {
      assert.deepEqual(await discovery.listVisibleExtensions(options), [])
      assert.deepEqual((await discovery.getManifestProcesses(options)).processes, [])
    } finally { discovery.activeExtensionInstalls.delete('active') }
    assert.equal((await discovery.listVisibleExtensions(options))[0].manifestError, 'incomplete')
  })
})

test('capability preload extends the upstream API factory without replacing its surface', async () => {
  const calls = []
  const payload = { backend_ready: false, models: [], processes: [], excluded: { ui_only_nodes: [] } }
  const api = createElectronApi({ invoke: async (...args) => { calls.push(args); return payload }, send() {}, on() {}, removeAllListeners() {} }, { setZoomFactor() {} }, { getPathForFile() { return '' } })
  assert.equal(await api.automation.capabilities(), payload)
  assert.equal(typeof api.workspace.library.list, 'function')
  assert.equal(typeof api.model.deleteSharedGroup, 'function')
  assert.deepEqual(calls, [['automation:capabilities']])
})

test('trusted registry extraction retains the upstream repository owner', async () => {
  const text = await readFile(new URL('./trusted-repos.ts', import.meta.url), 'utf8')
  assert.match(text, /https:\/\/raw\.githubusercontent\.com\/lightningpixel\/modly-official-extension\/main\/registry\.json/)
})


test('automation reports positional audio metadata without widening mesh-only execution', async () => {
  await withFixtures(async ({ options, writeManifest }) => {
    await writeManifest(options.userExtensionsDir, 'audio', {
      id: 'audio', type: 'process', entry: 'processor.py',
      params_schema: [{ id: 'strength', type: 'float' }], param_defaults: { strength: 0.5 },
      nodes: [{ id: 'run', input: 'audio', inputs: ['audio', 'text', 'text'],
        input_labels: ['Clip', 'Prompt', 'Negative'], output: 'audio', param_defaults: { strength: 0 } }],
    })
    const { processes } = await discovery.getManifestProcesses(options)
    assert.equal(processes[0].id, 'audio/run')
    assert.deepEqual(processes[0].inputs, ['audio', 'text', 'text'])
    assert.deepEqual(processes[0].input_labels, ['Clip', 'Prompt', 'Negative'])
    assert.deepEqual(processes[0].params_schema, [{ id: 'strength', type: 'float' }])
    assert.deepEqual(processes[0].param_defaults, { strength: 0 })
    assert.equal(processes[0].ready, null)
    await assert.rejects(discovery.resolveCanonicalProcessTarget({ ...options, processId: 'audio/run' }), { code: 'PROCESS_UNSUPPORTED' })
    for (const processId of ['audio', 'audio/run/extra', '/run', 'audio/ ', '../run']) {
      await assert.rejects(discovery.resolveCanonicalProcessTarget({ ...options, processId }), { code: 'PROCESS_NOT_FOUND' })
    }
  })
})

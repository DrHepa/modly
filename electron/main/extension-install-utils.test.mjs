import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-ext-test-')), 'extension-install-utils.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('electron/main/extension-install-utils.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

test('validateInstallManifest accepts legacy flat model manifests', () => {
  const mod = loadModule()

  const validated = mod.validateInstallManifest(
    { id: 'legacy-model', generator_class: 'Generator' },
    {
      hasEntryFile: () => false,
      hasGeneratorFile: () => true,
    },
    'repository',
  )

  assert.equal(validated.id, 'legacy-model')
  assert.equal(validated.isProcess, false)
  assert.equal(validated.hasNodes, false)
})

test('validateInstallManifest still rejects missing process entry files', () => {
  const mod = loadModule()

  assert.throws(
    () => mod.validateInstallManifest(
      { id: 'proc', type: 'process', entry: 'processor.py' },
      {
        hasEntryFile: () => false,
        hasGeneratorFile: () => false,
      },
      'selected folder',
    ),
    /entry file "processor\.py" missing from selected folder/,
  )
})


test('validateInstallManifest accepts multi-source nodes and preserves legacy shapes', () => {
  const mod = loadModule()
  assert.doesNotThrow(() => mod.validateInstallManifest({
    id: 'multi-model',
    generator_class: 'Generator',
    nodes: [{
      id: 'generate',
      model_sources: [
        {
          id: 'primary', provider: 'huggingface', repo_id: 'org/main',
          destination: '.', checks: ['pipeline.json'],
        },
        {
          id: 'encoder', provider: 'huggingface', repo_id: 'org/encoder',
          destination: 'auxiliary/encoder', checks: ['model.safetensors'],
        },
      ],
    }],
  }, { hasEntryFile: () => false, hasGeneratorFile: () => true }, 'repository'))

  assert.doesNotThrow(() => mod.validateInstallManifest({
    id: 'legacy',
    generator_class: 'Generator',
    nodes: [{
      id: 'projection',
      hf_repo: 'org/legacy',
      download_check: '../generate/model.safetensors',
      hf_skip_prefixes: ['weights/**'],
    }],
  }, { hasEntryFile: () => false, hasGeneratorFile: () => true }, 'repository'))
})

test('validateInstallManifest rejects malformed or process model_sources', () => {
  const mod = loadModule()
  const source = {
    id: 'weights', provider: 'huggingface', repo_id: 'org/model',
    destination: '../outside', checks: ['model.safetensors'],
  }
  assert.throws(() => mod.validateInstallManifest({
    id: 'unsafe', generator_class: 'Generator',
    nodes: [{ id: 'generate', model_sources: [source] }],
  }, { hasEntryFile: () => false, hasGeneratorFile: () => true }, 'repository'), /destination/i)

  assert.throws(() => mod.validateInstallManifest({
    id: 'process', type: 'process', entry: 'processor.js',
    nodes: [{ id: 'run', model_sources: [{ ...source, destination: '.' }] }],
  }, { hasEntryFile: () => true, hasGeneratorFile: () => false }, 'repository'), /only for model nodes/i)
})

test('python process setup failures are treated as fatal', () => {
  const mod = loadModule()

  assert.equal(mod.isSetupFailureFatal({ isProcess: true, isPythonProcess: true }), true)
  assert.equal(mod.isSetupFailureFatal({ isProcess: true, isPythonProcess: false }), false)
  assert.equal(mod.isSetupFailureFatal({ isProcess: false, isPythonProcess: false }), true)
})

test('validateInstallManifest allows scalar model video input and output only', () => {
  const mod = loadModule()
  const modelFiles = { hasEntryFile: () => false, hasGeneratorFile: () => true }
  const processFiles = { hasEntryFile: () => true, hasGeneratorFile: () => false }
  assert.doesNotThrow(() => mod.validateInstallManifest({
    id: 'video-model', generator_class: 'Generator',
    nodes: [{ id: 'generate', input: 'video', output: 'mesh' }],
  }, modelFiles, 'repository'))
  assert.doesNotThrow(() => mod.validateInstallManifest({
    id: 'image-to-video-model', generator_class: 'Generator',
    nodes: [{ id: 'image-to-video', input: 'image', output: 'video' }],
  }, modelFiles, 'repository'))
  for (const node of [
    { id: 'array', input: 'video', inputs: ['video'], output: 'mesh' },
    { id: 'mixed', input: 'video', inputs: ['video', 'text'], output: 'mesh' },
    { id: 'object-array', input: 'video', inputs: [{ name: 'clip', type: 'video', required: true }], output: 'mesh' },
  ]) {
    assert.throws(() => mod.validateInstallManifest({ id: 'bad', generator_class: 'Generator', nodes: [node] }, modelFiles, 'repository'), /video/i)
  }
  assert.throws(() => mod.validateInstallManifest({
    id: 'process', type: 'process', entry: 'processor.js', nodes: [{ id: 'run', input: 'video', output: 'mesh' }],
  }, processFiles, 'repository'), /video/i)
  assert.throws(() => mod.validateInstallManifest({
    id: 'process-output', type: 'process', entry: 'processor.js', nodes: [{ id: 'run', input: 'image', output: 'video' }],
  }, processFiles, 'repository'), /video/i)
})

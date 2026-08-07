import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  AgentOllamaModelStoreError,
  openVerifiedOllamaModel,
  parseOllamaModelName,
  probeOllamaModelStore,
} from './agent-ollama-model-store.ts'

const digest = (value: Buffer | string) => `sha256:${createHash('sha256').update(value).digest('hex')}` as const

async function modelFixture(options: { layerBytes?: Buffer, model?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'modly-ollama-store-'))
  const model = options.model ?? 'qwen3.6:27b'
  const config = Buffer.from('{"model_format":"gguf"}')
  const layer = options.layerBytes ?? Buffer.from('small deterministic model layer')
  const configDigest = digest(config)
  const layerDigest = digest(layer)
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    config: {
      mediaType: 'application/vnd.docker.container.image.v1+json',
      digest: configDigest,
      size: config.length,
    },
    layers: [{
      mediaType: 'application/vnd.ollama.image.model',
      digest: layerDigest,
      size: layer.length,
    }],
  }))
  const manifestDigest = digest(manifest)
  const parsed = parseOllamaModelName(model)
  const manifestPath = join(root, 'manifests', parsed.registry, ...parsed.namespace, parsed.name, parsed.tag)
  const blobs = join(root, 'blobs')
  await mkdir(join(manifestPath, '..'), { recursive: true, mode: 0o755 })
  await mkdir(blobs, { recursive: true, mode: 0o755 })
  await writeFile(join(blobs, configDigest.replace(':', '-')), config, { mode: 0o644 })
  await writeFile(join(blobs, layerDigest.replace(':', '-')), layer, { mode: 0o644 })
  await writeFile(manifestPath, manifest, { mode: 0o644 })
  return { root, model, manifestDigest, manifestPath, layerPath: join(blobs, layerDigest.replace(':', '-')) }
}

test('verified Ollama model pins an exact manifest graph and rejects later mutation', async () => {
  const fixture = await modelFixture()
  const model = await openVerifiedOllamaModel({
    modelsDir: fixture.root,
    model: fixture.model,
    digest: fixture.manifestDigest,
  })
  try {
    assert.equal(model.model, fixture.model)
    assert.equal(model.digest, fixture.manifestDigest)
    assert.equal(model.blobs.length, 2)
    assert.equal(model.manifest.identity.sha256, fixture.manifestDigest.slice('sha256:'.length))
    await model.revalidate()
    await writeFile(fixture.layerPath, 'mutated')
    await assert.rejects(model.revalidate(), (error: unknown) => (
      error instanceof AgentOllamaModelStoreError && error.code === 'model_stale'
    ))
  } finally {
    await model.close()
    await model.close()
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('Ollama model store rejects traversal, symlinked blobs, digest mismatch, and graph bounds', async () => {
  assert.throws(() => parseOllamaModelName('../escape:latest'), /model name/i)
  assert.throws(() => parseOllamaModelName('registry.example/model:latest'), /model name/i)

  const symlinkFixture = await modelFixture()
  const outside = join(symlinkFixture.root, 'outside')
  await writeFile(outside, 'outside')
  await rm(symlinkFixture.layerPath)
  await symlink(outside, symlinkFixture.layerPath)
  await assert.rejects(openVerifiedOllamaModel({
    modelsDir: symlinkFixture.root,
    model: symlinkFixture.model,
    digest: symlinkFixture.manifestDigest,
  }), (error: unknown) => error instanceof AgentOllamaModelStoreError)
  await rm(symlinkFixture.root, { recursive: true, force: true })

  const digestFixture = await modelFixture()
  await assert.rejects(openVerifiedOllamaModel({
    modelsDir: digestFixture.root,
    model: digestFixture.model,
    digest: `sha256:${'0'.repeat(64)}`,
  }), (error: unknown) => error instanceof AgentOllamaModelStoreError && error.code === 'digest_mismatch')
  await rm(digestFixture.root, { recursive: true, force: true })

  const boundedFixture = await modelFixture({ layerBytes: Buffer.alloc(32) })
  await assert.rejects(openVerifiedOllamaModel({
    modelsDir: boundedFixture.root,
    model: boundedFixture.model,
    digest: boundedFixture.manifestDigest,
    limits: { maxLogicalBytes: 16 },
  }), (error: unknown) => error instanceof AgentOllamaModelStoreError && error.code === 'model_too_large')
  await assert.rejects(openVerifiedOllamaModel({
    modelsDir: boundedFixture.root,
    model: boundedFixture.model,
    digest: boundedFixture.manifestDigest,
    limits: { maxEntries: 2 },
  }), (error: unknown) => error instanceof AgentOllamaModelStoreError && error.code === 'model_too_large')
  await rm(boundedFixture.root, { recursive: true, force: true })

  const unsafeManifestFixture = await modelFixture()
  const unsafeManifest = JSON.parse(await readFile(unsafeManifestFixture.manifestPath, 'utf8')) as Record<string, unknown>
  unsafeManifest.urls = ['https://cloud.invalid/model']
  const unsafeBytes = Buffer.from(JSON.stringify(unsafeManifest))
  await writeFile(unsafeManifestFixture.manifestPath, unsafeBytes)
  await assert.rejects(openVerifiedOllamaModel({
    modelsDir: unsafeManifestFixture.root,
    model: unsafeManifestFixture.model,
    digest: digest(unsafeBytes),
  }), (error: unknown) => error instanceof AgentOllamaModelStoreError && error.code === 'invalid_manifest')
  await rm(unsafeManifestFixture.root, { recursive: true, force: true })

  const missingFixture = await modelFixture()
  await rm(missingFixture.layerPath)
  await assert.rejects(openVerifiedOllamaModel({
    modelsDir: missingFixture.root,
    model: missingFixture.model,
    digest: missingFixture.manifestDigest,
  }), (error: unknown) => error instanceof AgentOllamaModelStoreError && error.code === 'invalid_store')
  await rm(missingFixture.root, { recursive: true, force: true })
})

test('Ollama model hashing detects a mutation race before returning authority', async () => {
  const fixture = await modelFixture()
  await assert.rejects(openVerifiedOllamaModel({
    modelsDir: fixture.root,
    model: fixture.model,
    digest: fixture.manifestDigest,
    afterHash: async ({ kind, path }) => {
      if (kind === 'blob' && path === fixture.layerPath) await writeFile(path, 'raced')
    },
  }), (error: unknown) => error instanceof AgentOllamaModelStoreError && error.code === 'model_stale')
  await rm(fixture.root, { recursive: true, force: true })
})

test('Ollama model verification aborts before opening large payloads', async () => {
  const fixture = await modelFixture()
  const controller = new AbortController()
  try {
    await assert.rejects(openVerifiedOllamaModel({
      modelsDir: fixture.root,
      model: fixture.model,
      digest: fixture.manifestDigest,
      signal: controller.signal,
      afterHash: ({ kind }) => { if (kind === 'manifest') controller.abort() },
    }), (error: unknown) => error instanceof AgentOllamaModelStoreError && error.code === 'aborted')
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('Ollama model revalidation rejects a symlinked canonical-store replacement', async () => {
  const fixture = await modelFixture()
  const moved = `${fixture.root}-moved`
  const model = await openVerifiedOllamaModel({
    modelsDir: fixture.root,
    model: fixture.model,
    digest: fixture.manifestDigest,
  })
  try {
    await rename(fixture.root, moved)
    await symlink(moved, fixture.root, 'dir')
    await assert.rejects(model.revalidate(), (error: unknown) => (
      error instanceof AgentOllamaModelStoreError && error.code === 'model_stale'
    ))
  } finally {
    await model.close()
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined)
    await rm(moved, { recursive: true, force: true })
  }
})

test('Ollama model store probe validates one bounded manifest graph without hashing model payloads', async () => {
  const valid = await modelFixture()
  try {
    assert.equal(await probeOllamaModelStore(valid.root), true)
    const manifest = JSON.parse(await readFile(valid.manifestPath, 'utf8')) as {
      layers: Array<{ size: number }>
    }
    manifest.layers[0].size += 1
    await writeFile(valid.manifestPath, JSON.stringify(manifest))
    assert.equal(await probeOllamaModelStore(valid.root), false)
  } finally {
    await rm(valid.root, { recursive: true, force: true })
  }
})

test('Ollama model store rejects group-writable authorities', async () => {
  const writableBlob = await modelFixture()
  try {
    await chmod(writableBlob.layerPath, 0o660)
    await assert.rejects(openVerifiedOllamaModel({
      modelsDir: writableBlob.root,
      model: writableBlob.model,
      digest: writableBlob.manifestDigest,
    }), (error: unknown) => error instanceof AgentOllamaModelStoreError && error.code === 'invalid_store')
  } finally {
    await rm(writableBlob.root, { recursive: true, force: true })
  }

  const writableRoot = await modelFixture()
  try {
    await chmod(writableRoot.root, 0o770)
    await assert.rejects(openVerifiedOllamaModel({
      modelsDir: writableRoot.root,
      model: writableRoot.model,
      digest: writableRoot.manifestDigest,
    }), (error: unknown) => error instanceof AgentOllamaModelStoreError && error.code === 'invalid_store')
  } finally {
    await rm(writableRoot.root, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const { parseExtensionManifest } = await import(new URL('./automation-capabilities.ts', import.meta.url).href)
const {
  createOwnerScopedDeletePlan,
  createExtensionUninstallCleanupPlan,
  deleteOwnedModelPaths,
  isOwnedModelDownloaded,
  listDownloadedModelCapabilities,
  mapDownloadProgressToCapability,
  resolveModelOwnership,
  resolveShowInFolderPath,
  selectPreferredModelPath,
} = await import(new URL('./model-ownership.ts', import.meta.url).href)

const bundledFixtureManifestPath = new URL('../../tests/fixtures/bundled-image-models/image-bundle.manifest.json', import.meta.url)

function readBundledFixtureManifest() {
  return JSON.parse(readFileSync(bundledFixtureManifestPath, 'utf-8'))
}

function createBundledModelExtension() {
  return parseExtensionManifest(
    readBundledFixtureManifest(),
    'image-bundle',
    new Set(),
    false,
  )
}

async function withTempModelsDir(run: (modelsDir: string) => Promise<void>) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'modly-model-ownership-'))
  const modelsDir = join(tempRoot, 'models')
  await mkdir(modelsDir, { recursive: true })
  try {
    await run(modelsDir)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

test('parseExtensionManifest derives owner-aware metadata for bundled model nodes', () => {
  const extension = parseExtensionManifest(
    readBundledFixtureManifest(),
    'image-bundle',
    new Set(),
    false,
  )

  assert.equal(extension.type, 'model')
  assert.deepEqual(extension.nodes, [
    {
      id: 'sd15',
      name: 'SD 1.5',
      input: 'image',
      output: 'mesh',
      paramsSchema: [],
      hfRepo: 'acme/sd15',
      downloadCheck: 'weights/model.safetensors',
      hfSkipPrefixes: undefined,
      capabilityId: 'image-bundle/sd15',
      bundleId: 'image-bundle',
      weightOwnerId: 'image-bundle/shared-base',
      sharedOwner: true,
      legacyPaths: ['image-bundle/sd15', 'image-bundle/sdxl-base'],
    },
    {
      id: 'sdxl-base',
      name: 'SDXL Base',
      input: 'image',
      output: 'mesh',
      paramsSchema: [],
      hfRepo: 'acme/sdxl-base',
      downloadCheck: 'weights/model.safetensors',
      hfSkipPrefixes: undefined,
      capabilityId: 'image-bundle/sdxl-base',
      bundleId: 'image-bundle',
      weightOwnerId: 'image-bundle/shared-base',
      sharedOwner: true,
      legacyPaths: ['image-bundle/sd15', 'image-bundle/sdxl-base'],
    },
    {
      id: 'flux-schnell',
      name: 'Flux Schnell',
      input: 'image',
      output: 'mesh',
      paramsSchema: [],
      hfRepo: 'acme/flux-schnell',
      downloadCheck: 'weights/model.safetensors',
      hfSkipPrefixes: undefined,
      capabilityId: 'image-bundle/flux-schnell',
      bundleId: 'image-bundle',
      weightOwnerId: 'image-bundle/flux-schnell',
      sharedOwner: false,
      legacyPaths: ['image-bundle/flux-schnell'],
    },
  ])
})

test('selectPreferredModelPath prefers the canonical owner path over legacy aliases', () => {
  const result = selectPreferredModelPath(
    '/models',
    {
      capabilityId: 'image-bundle/sd15',
      bundleId: 'image-bundle',
      weightOwnerId: 'image-bundle/shared-base',
      sharedOwner: true,
      legacyPaths: ['image-bundle/sd15', 'image-bundle/sdxl-base'],
    },
    (candidatePath: string) => candidatePath === '/models/image-bundle/shared-base' || candidatePath === '/models/image-bundle/sd15',
  )

  assert.deepEqual(result, {
    source: 'canonical',
    path: '/models/image-bundle/shared-base',
    canonicalPath: '/models/image-bundle/shared-base',
    legacyPaths: ['/models/image-bundle/sd15', '/models/image-bundle/sdxl-base'],
  })
})

test('selectPreferredModelPath falls back to the first existing legacy alias in manifest order', () => {
  const result = selectPreferredModelPath(
    '/models',
    {
      capabilityId: 'image-bundle/sdxl-base',
      bundleId: 'image-bundle',
      weightOwnerId: 'image-bundle/shared-base',
      sharedOwner: true,
      legacyPaths: ['image-bundle/sd15', 'image-bundle/sdxl-base'],
    },
    (candidatePath: string) => candidatePath === '/models/image-bundle/sdxl-base',
  )

  assert.deepEqual(result, {
    source: 'legacy',
    path: '/models/image-bundle/sdxl-base',
    canonicalPath: '/models/image-bundle/shared-base',
    legacyPaths: ['/models/image-bundle/sd15', '/models/image-bundle/sdxl-base'],
  })
})

test('isOwnedModelDownloaded and resolveShowInFolderPath fall back to the first existing legacy alias', async () => {
  await withTempModelsDir(async (modelsDir) => {
    const extension = createBundledModelExtension()
    const ownership = resolveModelOwnership([extension], 'image-bundle/sd15')

    assert.ok(ownership)

    const legacyAlias = join(modelsDir, 'image-bundle', 'sd15')
    await mkdir(legacyAlias, { recursive: true })
    await writeFile(join(legacyAlias, 'weights.safetensors'), 'ready')

    assert.equal(isOwnedModelDownloaded(modelsDir, ownership), true)
    assert.equal(resolveShowInFolderPath(modelsDir, ownership), legacyAlias)
  })
})

test('createOwnerScopedDeletePlan blocks deleting shared owner payloads while siblings still reference the owner', async () => {
  await withTempModelsDir(async (modelsDir) => {
    const extension = createBundledModelExtension()
    const ownership = resolveModelOwnership([extension], 'image-bundle/sd15')

    assert.ok(ownership)

    const canonicalPath = join(modelsDir, 'image-bundle', 'shared-base')
    await mkdir(canonicalPath, { recursive: true })
    await writeFile(join(canonicalPath, 'weights.safetensors'), 'ready')

    const plan = createOwnerScopedDeletePlan(modelsDir, ownership, ['image-bundle/sdxl-base'])

    assert.equal(plan.mode, 'blocked')
    assert.deepEqual(plan.targets, [])
    assert.match(plan.warning ?? '', /owner-scoped/i)
    assert.match(plan.warning ?? '', /image-bundle\/sdxl-base/)
  })
})

test('deleteOwnedModelPaths removes canonical and legacy owner paths for the final referencing capability', async () => {
  await withTempModelsDir(async (modelsDir) => {
    const extension = createBundledModelExtension()
    const ownership = resolveModelOwnership([extension], 'image-bundle/sd15')

    assert.ok(ownership)

    const canonicalPath = join(modelsDir, 'image-bundle', 'shared-base')
    const legacySd15Path = join(modelsDir, 'image-bundle', 'sd15')
    const legacySdxlPath = join(modelsDir, 'image-bundle', 'sdxl-base')

    await mkdir(canonicalPath, { recursive: true })
    await writeFile(join(canonicalPath, 'weights.safetensors'), 'ready')
    await mkdir(legacySd15Path, { recursive: true })
    await writeFile(join(legacySd15Path, 'legacy.bin'), 'legacy')
    await mkdir(legacySdxlPath, { recursive: true })
    await writeFile(join(legacySdxlPath, 'legacy.bin'), 'legacy')

    const plan = createOwnerScopedDeletePlan(modelsDir, ownership, [])

    assert.equal(plan.mode, 'delete')
    await deleteOwnedModelPaths(plan.targets)

    assert.equal(isOwnedModelDownloaded(modelsDir, ownership), false)
  })
})

test('listDownloadedModelCapabilities returns all capability ids that share one downloaded owner', async () => {
  await withTempModelsDir(async (modelsDir) => {
    const extension = createBundledModelExtension()
    const canonicalPath = join(modelsDir, 'image-bundle', 'shared-base')
    await mkdir(canonicalPath, { recursive: true })
    await writeFile(join(canonicalPath, 'weights.safetensors'), 'ready')

    const downloaded = listDownloadedModelCapabilities(modelsDir, [extension])

    assert.deepEqual(
      downloaded.map((entry: { id: string }) => entry.id),
      ['image-bundle/sd15', 'image-bundle/sdxl-base'],
    )
    assert.ok(downloaded.every((entry: { size_gb: number }) => entry.size_gb >= 0))
  })
})

test('createExtensionUninstallCleanupPlan deletes a shared owner only once after the last sibling is removed', async () => {
  await withTempModelsDir(async (modelsDir) => {
    const extension = createBundledModelExtension()
    const canonicalPath = join(modelsDir, 'image-bundle', 'shared-base')
    const legacySd15Path = join(modelsDir, 'image-bundle', 'sd15')
    const legacySdxlPath = join(modelsDir, 'image-bundle', 'sdxl-base')

    await mkdir(canonicalPath, { recursive: true })
    await writeFile(join(canonicalPath, 'weights.safetensors'), 'ready')
    await mkdir(legacySd15Path, { recursive: true })
    await writeFile(join(legacySd15Path, 'legacy.bin'), 'legacy')
    await mkdir(legacySdxlPath, { recursive: true })
    await writeFile(join(legacySdxlPath, 'legacy.bin'), 'legacy')

    const plan = createExtensionUninstallCleanupPlan(modelsDir, [extension], 'image-bundle')

    assert.equal(plan.length, 2)
    assert.deepEqual(plan[0]?.targets, [canonicalPath, legacySd15Path, legacySdxlPath])
    assert.deepEqual(plan[1]?.targets, [join(modelsDir, 'image-bundle', 'flux-schnell')])
  })
})

test('mapDownloadProgressToCapability emits progress keyed by capability id', () => {
  assert.deepEqual(
    mapDownloadProgressToCapability('image-bundle/sd15', {
      percent: 42,
      file: 'weights.safetensors',
      fileIndex: 1,
      totalFiles: 2,
      status: 'downloading',
    }),
    {
      capabilityId: 'image-bundle/sd15',
      modelId: 'image-bundle/sd15',
      percent: 42,
      file: 'weights.safetensors',
      fileIndex: 1,
      totalFiles: 2,
      status: 'downloading',
    },
  )
})

test('bundled fixture keeps the remaining sibling ready and still reports standalone siblings from the canonical owner path', async () => {
  await withTempModelsDir(async (modelsDir) => {
    const extension = createBundledModelExtension()
    const canonicalPath = join(modelsDir, 'image-bundle', 'shared-base')
    const standalonePath = join(modelsDir, 'image-bundle', 'flux-schnell')
    await mkdir(canonicalPath, { recursive: true })
    await writeFile(join(canonicalPath, 'weights.safetensors'), 'ready')
    await mkdir(standalonePath, { recursive: true })
    await writeFile(join(standalonePath, 'flux.safetensors'), 'ready')

    const sd15Ownership = resolveModelOwnership([extension], 'image-bundle/sd15')

    assert.ok(sd15Ownership)
    assert.equal(isOwnedModelDownloaded(modelsDir, sd15Ownership), true)
    assert.deepEqual(
      listDownloadedModelCapabilities(modelsDir, [extension]).map((entry: { id: string }) => entry.id),
      ['image-bundle/sd15', 'image-bundle/sdxl-base', 'image-bundle/flux-schnell'],
    )

    const blockedDelete = createOwnerScopedDeletePlan(modelsDir, sd15Ownership, ['image-bundle/sdxl-base'])
    assert.equal(blockedDelete.mode, 'blocked')
    assert.deepEqual(blockedDelete.targets, [])
  })
})

test('bundled fixture keeps legacy-only shared payloads ready until the last sibling deletes the owner payload', async () => {
  await withTempModelsDir(async (modelsDir) => {
    const extension = createBundledModelExtension()
    const legacySharedPath = join(modelsDir, 'image-bundle', 'sdxl-base')
    await mkdir(legacySharedPath, { recursive: true })
    await writeFile(join(legacySharedPath, 'weights.safetensors'), 'legacy-ready')

    const sd15Ownership = resolveModelOwnership([extension], 'image-bundle/sd15')

    assert.ok(sd15Ownership)
    assert.deepEqual(
      listDownloadedModelCapabilities(modelsDir, [extension]).map((entry: { id: string }) => entry.id),
      ['image-bundle/sd15', 'image-bundle/sdxl-base'],
    )

    const finalDelete = createOwnerScopedDeletePlan(modelsDir, sd15Ownership, [])
    assert.equal(finalDelete.mode, 'delete')
    assert.deepEqual(finalDelete.targets, [
      join(modelsDir, 'image-bundle', 'shared-base'),
      join(modelsDir, 'image-bundle', 'sd15'),
      join(modelsDir, 'image-bundle', 'sdxl-base'),
    ])

    await deleteOwnedModelPaths(finalDelete.targets)
    assert.equal(isOwnedModelDownloaded(modelsDir, sd15Ownership), false)
  })
})

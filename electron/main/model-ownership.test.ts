import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const { parseExtensionManifest } = await import(new URL('./automation-capabilities.ts', import.meta.url).href)
const {
  createOwnerScopedDeletePlan,
  createExtensionUninstallCleanupPlan,
  deleteOwnedModelPaths,
  getCanonicalModelPath,
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

test('hf_downloads ownership readiness requires every declared asset', async () => {
  await withTempModelsDir(async (modelsDir) => {
    const extension = parseExtensionManifest({
      id: 'cube3d',
      type: 'model',
      nodes: [{
        id: 'generate',
        name: 'Generate',
        input: 'text',
        output: 'mesh',
        hf_repo: 'owner/model',
        hf_downloads: [{
          repo_id: 'owner/model',
          revision: 'ef15eda2e413f994e3b4657960b0309487587718',
          target_subdir: 'cube3d',
          files: [{ path: 'config.json' }, { path: 'model.pt' }],
        }],
      }],
    }, 'cube3d', new Set(), false)

    const ownership = resolveModelOwnership([extension], 'cube3d/generate')
    assert.ok(ownership)
    const target = join(modelsDir, 'cube3d', 'generate', 'cube3d')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'config.json'), '{}')

    assert.equal(isOwnedModelDownloaded(modelsDir, ownership), false)

    await writeFile(join(target, 'model.pt'), 'weights')
    assert.equal(isOwnedModelDownloaded(modelsDir, ownership), true)
  })
})

test('hf_downloads ownership readiness verifies declared SHA-256 and keeps no-hash files compatible', async () => {
  await withTempModelsDir(async (modelsDir) => {
    const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
    const ownership = {
      capabilityId: 'cube3d/generate',
      bundleId: 'cube3d',
      weightOwnerId: 'cube3d/generate',
      sharedOwner: false,
      legacyPaths: ['cube3d/generate'],
      hfDownloads: [{
        repoId: 'owner/model',
        revision: 'ef15eda2e413f994e3b4657960b0309487587718',
        targetSubdir: 'cube3d',
        files: [
          { path: 'config.json' },
          { path: 'model.pt', sha256: sha256('expected') },
        ],
      }],
    }
    const target = join(modelsDir, 'cube3d', 'generate', 'cube3d')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'config.json'), '{}')
    await writeFile(join(target, 'model.pt'), 'wrong')

    assert.equal(isOwnedModelDownloaded(modelsDir, ownership), false)

    await writeFile(join(target, 'model.pt'), 'expected')
    assert.equal(isOwnedModelDownloaded(modelsDir, ownership), true)
  })
})

test('parseExtensionManifest preserves process port labels while keeping handle names', () => {
  const extension = parseExtensionManifest(
    {
      id: 'codex-image',
      type: 'model',
      nodes: [{
        id: 'image-to-image',
        input: 'image',
        output: 'image',
        inputs: [
          { name: 'front', label: 'Primary image', type: 'image' },
          { name: 'left', label: 'Image 2', type: 'image', required: false },
        ],
      }],
    },
    'codex-image',
    new Set(),
    false,
  )

  assert.deepEqual(extension.nodes[0].inputs, [
    { name: 'front', label: 'Primary image', type: 'image', required: true },
    { name: 'left', label: 'Image 2', type: 'image', required: false },
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
    await deleteOwnedModelPaths(modelsDir, plan.targets)

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

    await deleteOwnedModelPaths(modelsDir, finalDelete.targets)
    assert.equal(isOwnedModelDownloaded(modelsDir, sd15Ownership), false)
  })
})

test('ownership paths reject traversal before construction or deletion', async () => {
  await withTempModelsDir(async (modelsDir) => {
    const ownership = {
      capabilityId: 'safe-extension/generate',
      bundleId: 'safe-extension',
      weightOwnerId: '../outside',
      sharedOwner: false,
      legacyPaths: ['safe-extension/generate'],
    }

    assert.throws(
      () => getCanonicalModelPath(modelsDir, ownership),
      /exactly one extension and one owner segment|path separators|invalid/i,
    )

    const plan = createOwnerScopedDeletePlan(modelsDir, ownership, [])
    assert.equal(plan.mode, 'blocked')
    assert.deepEqual(plan.targets, [])
    assert.match(plan.warning ?? '', /unsafe model ownership path/i)

    await assert.rejects(
      deleteOwnedModelPaths(modelsDir, [join(modelsDir, '..', 'outside')]),
      /escapes the canonical models directory|symbolic link|filesystem alias/i,
    )
  })
})

test('symlinked ownership parents cannot become ready or delete outside modelsDir', async () => {
  await withTempModelsDir(async (modelsDir) => {
    const outsideRoot = join(modelsDir, '..', 'outside-owner')
    const outsideOwner = join(outsideRoot, 'owner')
    const outsideMarker = join(outsideOwner, 'marker.bin')
    await mkdir(outsideOwner, { recursive: true })
    await writeFile(outsideMarker, 'preserve')
    await symlink(outsideRoot, join(modelsDir, 'escape'), 'dir')

    const ownership = {
      capabilityId: 'escape/owner',
      bundleId: 'escape',
      weightOwnerId: 'escape/owner',
      sharedOwner: false,
      legacyPaths: ['escape/owner'],
    }

    assert.equal(isOwnedModelDownloaded(modelsDir, ownership), false)
    assert.equal(resolveShowInFolderPath(modelsDir, ownership), null)

    const plan = createOwnerScopedDeletePlan(modelsDir, ownership, [])
    assert.equal(plan.mode, 'blocked')
    assert.deepEqual(plan.targets, [])

    await assert.rejects(
      deleteOwnedModelPaths(modelsDir, [join(modelsDir, 'escape', 'owner')]),
      /escapes the canonical models directory|symbolic link|filesystem alias/i,
    )
    assert.equal(readFileSync(outsideMarker, 'utf-8'), 'preserve')
  })
})

test('hf_downloads readiness rejects asset symlinks that resolve outside the owner', async () => {
  await withTempModelsDir(async (modelsDir) => {
    const ownerPath = join(modelsDir, 'cube3d', 'generate')
    const assetDir = join(ownerPath, 'cube3d')
    const outsideAsset = join(modelsDir, '..', 'outside-model.pt')
    await mkdir(assetDir, { recursive: true })
    await writeFile(outsideAsset, 'external weights')
    await symlink(outsideAsset, join(assetDir, 'model.pt'), 'file')

    const ownership = {
      capabilityId: 'cube3d/generate',
      bundleId: 'cube3d',
      weightOwnerId: 'cube3d/generate',
      sharedOwner: false,
      legacyPaths: ['cube3d/generate'],
      hfDownloads: [{
        repoId: 'owner/model',
        revision: 'ef15eda2e413f994e3b4657960b0309487587718',
        targetSubdir: 'cube3d',
        files: [{ path: 'model.pt' }],
      }],
    }

    assert.equal(isOwnedModelDownloaded(modelsDir, ownership), false)
  })
})

test('in-root extension and owner aliases cannot cross ownership boundaries', async () => {
  await withTempModelsDir(async (modelsDir) => {
    const victimOwner = join(modelsDir, 'victim', 'owner')
    const victimMarker = join(victimOwner, 'weights.bin')
    await mkdir(victimOwner, { recursive: true })
    await writeFile(victimMarker, 'victim')

    await symlink(join(modelsDir, 'victim'), join(modelsDir, 'evil-extension'), 'dir')
    const extensionAliasOwnership = {
      capabilityId: 'evil-extension/owner',
      bundleId: 'evil-extension',
      weightOwnerId: 'evil-extension/owner',
      sharedOwner: false,
      legacyPaths: ['evil-extension/owner'],
    }

    assert.equal(
      isOwnedModelDownloaded(modelsDir, extensionAliasOwnership),
      false,
    )
    const extensionPlan = createOwnerScopedDeletePlan(
      modelsDir,
      extensionAliasOwnership,
      [],
    )
    assert.equal(extensionPlan.mode, 'blocked')
    assert.deepEqual(extensionPlan.targets, [])
    await assert.rejects(
      deleteOwnedModelPaths(
        modelsDir,
        [join(modelsDir, 'evil-extension', 'owner')],
      ),
      /symbolic link|filesystem alias/i,
    )
    assert.equal(readFileSync(victimMarker, 'utf-8'), 'victim')

    const evilOwnerRoot = join(modelsDir, 'evil-owner')
    await mkdir(evilOwnerRoot, { recursive: true })
    await symlink(victimOwner, join(evilOwnerRoot, 'owner'), 'dir')
    const ownerAliasOwnership = {
      capabilityId: 'evil-owner/owner',
      bundleId: 'evil-owner',
      weightOwnerId: 'evil-owner/owner',
      sharedOwner: false,
      legacyPaths: ['evil-owner/owner'],
    }

    assert.equal(isOwnedModelDownloaded(modelsDir, ownerAliasOwnership), false)
    const ownerPlan = createOwnerScopedDeletePlan(
      modelsDir,
      ownerAliasOwnership,
      [],
    )
    assert.equal(ownerPlan.mode, 'blocked')
    assert.deepEqual(ownerPlan.targets, [])
    await assert.rejects(
      deleteOwnedModelPaths(
        modelsDir,
        [join(modelsDir, 'evil-owner', 'owner')],
      ),
      /symbolic link|filesystem alias/i,
    )
    assert.equal(readFileSync(victimMarker, 'utf-8'), 'victim')
  })
})

test('configured modelsDir may itself be a symlink without allowing child aliases', async () => {
  await withTempModelsDir(async (modelsDir) => {
    const configuredModelsDir = join(modelsDir, '..', 'configured-models')
    await symlink(modelsDir, configuredModelsDir, 'dir')

    const ownerPath = join(modelsDir, 'safe-extension', 'owner')
    await mkdir(ownerPath, { recursive: true })
    await writeFile(join(ownerPath, 'weights.bin'), 'ready')
    const ownership = {
      capabilityId: 'safe-extension/owner',
      bundleId: 'safe-extension',
      weightOwnerId: 'safe-extension/owner',
      sharedOwner: false,
      legacyPaths: ['safe-extension/owner'],
    }

    assert.equal(isOwnedModelDownloaded(configuredModelsDir, ownership), true)
    assert.equal(
      resolveShowInFolderPath(configuredModelsDir, ownership),
      ownerPath,
    )
    const plan = createOwnerScopedDeletePlan(
      configuredModelsDir,
      ownership,
      [],
    )
    assert.equal(plan.mode, 'delete')
    assert.deepEqual(plan.targets, [ownerPath])
  })
})

const {
  expectedHttpsMarkerAssets,
  httpsPlanSha256,
} = await import(new URL('./https-download-manifest.ts', import.meta.url).href)

const HTTPS_PLAN = [
  {
    url: 'https://assets.example/weights.bin',
    filename: 'weights.bin',
    sizeBytes: 5,
    sha256: createHash('sha256').update(Buffer.alloc(5, 1)).digest('hex'),
  },
  {
    url: 'https://assets.example/config.json',
    filename: 'config.json',
    sizeBytes: 2,
    sha256: createHash('sha256').update(Buffer.alloc(2, 2)).digest('hex'),
  },
]

const HTTPS_MANIFEST_PLAN = HTTPS_PLAN.map((asset) => ({
  url: asset.url,
  filename: asset.filename,
  size_bytes: asset.sizeBytes,
  sha256: asset.sha256,
}))

function createHttpsOwnership() {
  const extension = parseExtensionManifest(
    {
      id: 'gaussiangpt',
      type: 'model',
      nodes: [{
        id: 'vfront',
        input: 'none',
        output: 'mesh',
        https_downloads: HTTPS_MANIFEST_PLAN,
      }],
    },
    'gaussiangpt',
    new Set(),
    false,
  )

  const ownership = resolveModelOwnership([extension], 'gaussiangpt/vfront')
  assert.ok(ownership)
  return ownership
}

function validHttpsReadyMarker() {
  return {
    schema_version: 1,
    kind: 'modly.https-assets.ready',
    model_id: 'gaussiangpt/vfront',
    plan_sha256: httpsPlanSha256(HTTPS_PLAN),
    assets: expectedHttpsMarkerAssets(HTTPS_PLAN),
    verified_at: '2026-07-11T12:00:00Z',
  }
}

async function prepareHttpsOwner(modelsDir: string) {
  const ownerPath = join(modelsDir, 'gaussiangpt', 'vfront')
  const metadataPath = join(ownerPath, '.modly')

  await mkdir(metadataPath, { recursive: true })
  await writeFile(join(ownerPath, 'weights.bin'), Buffer.alloc(5, 1))
  await writeFile(join(ownerPath, 'config.json'), Buffer.alloc(2, 2))

  return {
    ownerPath,
    markerPath: join(metadataPath, 'https-assets-ready.json'),
  }
}

test('HTTPS ownership readiness accepts the exact marker and ordered asset inventory', async () => {
  await withTempModelsDir(async (modelsDir) => {
    const ownership = createHttpsOwnership()
    const { markerPath } = await prepareHttpsOwner(modelsDir)

    await writeFile(markerPath, JSON.stringify(validHttpsReadyMarker()))

    assert.deepEqual(ownership.httpsDownloads, HTTPS_PLAN)
    assert.equal(isOwnedModelDownloaded(modelsDir, ownership), true)
  })
})

test('HTTPS ownership readiness rejects wrong model, order, hash, schema, and file size', async () => {
  await withTempModelsDir(async (modelsDir) => {
    const ownership = createHttpsOwnership()
    const { ownerPath, markerPath } = await prepareHttpsOwner(modelsDir)
    const validMarker = validHttpsReadyMarker()

    const invalidMarkers = [
      {
        ...validMarker,
        model_id: 'gaussiangpt/both',
      },
      {
        ...validMarker,
        plan_sha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      },
      {
        ...validMarker,
        assets: [...validMarker.assets].reverse(),
      },
      {
        ...validMarker,
        verified_at: '2026-07-11T14:00:00+02:00',
      },
      {
        ...validMarker,
        unexpected: true,
      },
    ]

    for (const marker of invalidMarkers) {
      await writeFile(markerPath, JSON.stringify(marker))
      assert.equal(isOwnedModelDownloaded(modelsDir, ownership), false)
    }

    await writeFile(markerPath, JSON.stringify(validMarker))
    await writeFile(join(ownerPath, 'weights.bin'), Buffer.alloc(4))
    assert.equal(isOwnedModelDownloaded(modelsDir, ownership), false)
  })
})

test('HTTPS ownership readiness detects same-size tampering after marker publish', async () => {
  await withTempModelsDir(async (modelsDir) => {
    const ownership = createHttpsOwnership()
    const { ownerPath, markerPath } = await prepareHttpsOwner(modelsDir)

    await writeFile(markerPath, JSON.stringify(validHttpsReadyMarker()))
    assert.equal(isOwnedModelDownloaded(modelsDir, ownership), true)

    await writeFile(join(ownerPath, 'weights.bin'), Buffer.alloc(5, 9))
    assert.equal(isOwnedModelDownloaded(modelsDir, ownership), false)
  })
})

test('HTTPS ownership readiness rejects symlinked assets and readiness markers', async () => {
  await withTempModelsDir(async (modelsDir) => {
    const ownership = createHttpsOwnership()
    const { ownerPath, markerPath } = await prepareHttpsOwner(modelsDir)
    const weightsPath = join(ownerPath, 'weights.bin')
    const weightsTargetPath = join(ownerPath, 'weights-target.bin')

    await writeFile(markerPath, JSON.stringify(validHttpsReadyMarker()))
    await rm(weightsPath)
    await writeFile(weightsTargetPath, Buffer.alloc(5))
    await symlink('weights-target.bin', weightsPath, 'file')

    assert.equal(isOwnedModelDownloaded(modelsDir, ownership), false)

    await rm(weightsPath)
    await writeFile(weightsPath, Buffer.alloc(5))

    const markerTargetPath = join(ownerPath, '.modly', 'marker-target.json')
    await rm(markerPath)
    await writeFile(markerTargetPath, JSON.stringify(validHttpsReadyMarker()))
    await symlink('marker-target.json', markerPath, 'file')

    assert.equal(isOwnedModelDownloaded(modelsDir, ownership), false)
  })
})

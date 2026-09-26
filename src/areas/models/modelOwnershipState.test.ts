import assert from 'node:assert/strict'
import test from 'node:test'

const { collectReadyOwnerIds, deriveModelOwnershipState } = await import(new URL('./modelOwnershipState.ts', import.meta.url).href)

test('deriveModelOwnershipState marks every capability ready when their shared owner is ready', () => {
  const state = deriveModelOwnershipState(
    [
      {
        capabilityId: 'image-bundle/sd15',
        bundleId: 'image-bundle',
        weightOwnerId: 'image-bundle/shared-base',
        sharedOwner: true,
        legacyPaths: ['image-bundle/sd15', 'image-bundle/sdxl-base'],
      },
      {
        capabilityId: 'image-bundle/sdxl-base',
        bundleId: 'image-bundle',
        weightOwnerId: 'image-bundle/shared-base',
        sharedOwner: true,
        legacyPaths: ['image-bundle/sd15', 'image-bundle/sdxl-base'],
      },
    ],
    new Set(['image-bundle/shared-base']),
  )

  assert.deepEqual(state['image-bundle/sd15'], {
    capabilityId: 'image-bundle/sd15',
    bundleId: 'image-bundle',
    weightOwnerId: 'image-bundle/shared-base',
    sharedOwner: true,
    legacyPaths: ['image-bundle/sd15', 'image-bundle/sdxl-base'],
    downloaded: true,
    badges: ['Shared weights'],
    deleteDisabled: true,
    installDisabled: true,
    isOwnerDownloading: false,
    ownerPeerCapabilityIds: ['image-bundle/sdxl-base'],
    warning: 'Shared weights are used by another node in this extension. Uninstall the whole extension to remove them safely.',
  })
  assert.equal(state['image-bundle/sdxl-base']?.downloaded, true)
})

test('deriveModelOwnershipState keeps standalone capabilities not-ready when their owner is absent', () => {
  const state = deriveModelOwnershipState(
    [
      {
        capabilityId: 'image-bundle/flux-schnell',
        bundleId: 'image-bundle',
        weightOwnerId: 'image-bundle/flux-schnell',
        sharedOwner: false,
        legacyPaths: ['image-bundle/flux-schnell'],
      },
    ],
    new Set(['image-bundle/shared-base']),
  )

  assert.deepEqual(state['image-bundle/flux-schnell'], {
    capabilityId: 'image-bundle/flux-schnell',
    bundleId: 'image-bundle',
    weightOwnerId: 'image-bundle/flux-schnell',
    sharedOwner: false,
    legacyPaths: ['image-bundle/flux-schnell'],
    downloaded: false,
    badges: [],
    deleteDisabled: true,
    installDisabled: false,
    isOwnerDownloading: false,
    ownerPeerCapabilityIds: [],
    warning: null,
  })
})

test('deriveModelOwnershipState exposes shared-owner badge and blocks per-node delete when a sibling still uses the owner', () => {
  const state = deriveModelOwnershipState(
    [
      {
        capabilityId: 'image-bundle/sd15',
        bundleId: 'image-bundle',
        weightOwnerId: 'image-bundle/shared-base',
        sharedOwner: true,
        legacyPaths: ['image-bundle/sd15', 'image-bundle/sdxl-base'],
      },
      {
        capabilityId: 'image-bundle/sdxl-base',
        bundleId: 'image-bundle',
        weightOwnerId: 'image-bundle/shared-base',
        sharedOwner: true,
        legacyPaths: ['image-bundle/sd15', 'image-bundle/sdxl-base'],
      },
    ],
    new Set(['image-bundle/shared-base']),
  )

  assert.deepEqual(state['image-bundle/sd15'], {
    capabilityId: 'image-bundle/sd15',
    bundleId: 'image-bundle',
    weightOwnerId: 'image-bundle/shared-base',
    sharedOwner: true,
    legacyPaths: ['image-bundle/sd15', 'image-bundle/sdxl-base'],
    downloaded: true,
    badges: ['Shared weights'],
    deleteDisabled: true,
    installDisabled: true,
    isOwnerDownloading: false,
    ownerPeerCapabilityIds: ['image-bundle/sdxl-base'],
    warning: 'Shared weights are used by another node in this extension. Uninstall the whole extension to remove them safely.',
  })
})

test('deriveModelOwnershipState disables sibling downloads while a shared owner is downloading', () => {
  const state = deriveModelOwnershipState(
    [
      {
        capabilityId: 'image-bundle/sd15',
        bundleId: 'image-bundle',
        weightOwnerId: 'image-bundle/shared-base',
        sharedOwner: true,
        legacyPaths: ['image-bundle/sd15', 'image-bundle/sdxl-base'],
      },
      {
        capabilityId: 'image-bundle/sdxl-base',
        bundleId: 'image-bundle',
        weightOwnerId: 'image-bundle/shared-base',
        sharedOwner: true,
        legacyPaths: ['image-bundle/sd15', 'image-bundle/sdxl-base'],
      },
    ],
    new Set(),
    new Set(['image-bundle/shared-base']),
  )

  assert.deepEqual(state['image-bundle/sdxl-base'], {
    capabilityId: 'image-bundle/sdxl-base',
    bundleId: 'image-bundle',
    weightOwnerId: 'image-bundle/shared-base',
    sharedOwner: true,
    legacyPaths: ['image-bundle/sd15', 'image-bundle/sdxl-base'],
    downloaded: false,
    badges: ['Shared weights'],
    deleteDisabled: true,
    installDisabled: true,
    isOwnerDownloading: true,
    ownerPeerCapabilityIds: ['image-bundle/sd15'],
    warning: 'Shared weights are downloading for this extension. Wait for the download to finish.',
  })
})

test('deriveModelOwnershipState keeps model_sources readiness capability-specific for shared owners', () => {
  const state = deriveModelOwnershipState(
    [
      {
        capabilityId: 'bundle/shape',
        bundleId: 'bundle',
        weightOwnerId: 'bundle/shared',
        sharedOwner: true,
        legacyPaths: ['bundle/shape', 'bundle/texture'],
        hasModelSources: true,
      },
      {
        capabilityId: 'bundle/texture',
        bundleId: 'bundle',
        weightOwnerId: 'bundle/shared',
        sharedOwner: true,
        legacyPaths: ['bundle/shape', 'bundle/texture'],
        hasModelSources: true,
      },
    ],
    new Set(['bundle/shape']),
  )

  assert.equal(state['bundle/shape']?.downloaded, true)
  assert.equal(state['bundle/texture']?.downloaded, false)
})

test('deriveModelOwnershipState keeps distinct hf_downloads readiness capability-specific for shared owners', () => {
  const state = deriveModelOwnershipState(
    [
      {
        capabilityId: 'bundle/front',
        bundleId: 'bundle',
        weightOwnerId: 'bundle/shared',
        sharedOwner: true,
        legacyPaths: ['bundle/front', 'bundle/back'],
        hfDownloads: [{
          repoId: 'owner/front',
          revision: 'ef15eda2e413f994e3b4657960b0309487587718',
          targetSubdir: 'front',
          files: [{ path: 'model.bin' }],
        }],
      },
      {
        capabilityId: 'bundle/back',
        bundleId: 'bundle',
        weightOwnerId: 'bundle/shared',
        sharedOwner: true,
        legacyPaths: ['bundle/front', 'bundle/back'],
        hfDownloads: [{
          repoId: 'owner/back',
          revision: 'ef15eda2e413f994e3b4657960b0309487587718',
          targetSubdir: 'back',
          files: [{ path: 'model.bin' }],
        }],
      },
    ],
    new Set(['bundle/front']),
  )

  assert.equal(state['bundle/front']?.downloaded, true)
  assert.equal(state['bundle/back']?.downloaded, false)
})

test('deriveModelOwnershipState keeps distinct https_downloads readiness capability-specific for shared owners', () => {
  const state = deriveModelOwnershipState(
    [
      {
        capabilityId: 'bundle/front',
        bundleId: 'bundle',
        weightOwnerId: 'bundle/shared',
        sharedOwner: true,
        legacyPaths: ['bundle/front', 'bundle/back'],
        httpsDownloads: [{
          url: 'https://example.com/front.bin',
          filename: 'front.bin',
          sizeBytes: 1,
          sha256: 'a'.repeat(64),
        }],
      },
      {
        capabilityId: 'bundle/back',
        bundleId: 'bundle',
        weightOwnerId: 'bundle/shared',
        sharedOwner: true,
        legacyPaths: ['bundle/front', 'bundle/back'],
        httpsDownloads: [{
          url: 'https://example.com/back.bin',
          filename: 'back.bin',
          sizeBytes: 1,
          sha256: 'b'.repeat(64),
        }],
      },
    ],
    new Set(['bundle/front']),
  )

  assert.equal(state['bundle/front']?.downloaded, true)
  assert.equal(state['bundle/back']?.downloaded, false)
})

test('collectReadyOwnerIds keeps structured capability ids but preserves legacy owner fallback', () => {
  const capabilities = [
    {
      capabilityId: 'bundle/shape',
      bundleId: 'bundle',
      weightOwnerId: 'bundle/shared',
      sharedOwner: true,
      legacyPaths: ['bundle/shape', 'bundle/texture'],
      hasModelSources: true,
    },
    {
      capabilityId: 'legacy/generate',
      bundleId: 'legacy',
      weightOwnerId: 'legacy/shared',
      sharedOwner: false,
      legacyPaths: ['legacy/generate'],
    },
    {
      capabilityId: 'bundle/hf',
      bundleId: 'bundle',
      weightOwnerId: 'bundle/shared',
      sharedOwner: true,
      legacyPaths: ['bundle/hf'],
      hfDownloads: [{
        repoId: 'owner/hf',
        revision: 'ef15eda2e413f994e3b4657960b0309487587718',
        targetSubdir: 'hf',
        files: [{ path: 'model.bin' }],
      }],
    },
    {
      capabilityId: 'bundle/https',
      bundleId: 'bundle',
      weightOwnerId: 'bundle/shared',
      sharedOwner: true,
      legacyPaths: ['bundle/https'],
      httpsDownloads: [{
        url: 'https://example.com/model.bin',
        filename: 'model.bin',
        sizeBytes: 1,
        sha256: 'c'.repeat(64),
      }],
    },
  ]

  assert.deepEqual(
    collectReadyOwnerIds(capabilities, ['bundle/shape', 'legacy/generate', 'bundle/hf', 'bundle/https']),
    ['bundle/shape', 'legacy/shared', 'bundle/hf', 'bundle/https'],
  )
})

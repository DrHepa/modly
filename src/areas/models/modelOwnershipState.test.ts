import assert from 'node:assert/strict'
import test from 'node:test'

const { deriveModelOwnershipState } = await import(new URL('./modelOwnershipState.ts', import.meta.url).href)

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
    warning: 'Shared weights are still used by: image-bundle/sdxl-base. Uninstall the whole extension to remove them safely.',
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
    warning: 'Shared weights are still used by: image-bundle/sdxl-base. Uninstall the whole extension to remove them safely.',
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
    warning: 'Shared weights are downloading for: image-bundle/sd15, image-bundle/sdxl-base. Wait for the owner download to finish.',
  })
})

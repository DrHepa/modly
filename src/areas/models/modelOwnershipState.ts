import type { ExtensionNode, ModelExtension, ModelOwnershipMetadata } from '../../shared/types/electron.d'

export interface ModelOwnershipCapabilityState extends ModelOwnershipMetadata {
  downloaded: boolean
  isOwnerDownloading: boolean
  installDisabled: boolean
  deleteDisabled: boolean
  ownerPeerCapabilityIds: string[]
  badges: string[]
  warning: string | null
}

function isOwnershipNode(node: ExtensionNode): node is ExtensionNode & ModelOwnershipMetadata {
  return Boolean(
    (node.hfRepo || node.hfDownloads?.length || node.httpsDownloads?.length) &&
    node.capabilityId &&
    node.bundleId &&
    node.weightOwnerId &&
    node.legacyPaths,
  )
}

export function collectModelOwnershipMetadata(extensions: readonly ModelExtension[]): ModelOwnershipMetadata[] {
  return extensions.flatMap((extension) => extension.nodes.filter(isOwnershipNode).map((node) => ({
    capabilityId: node.capabilityId,
    bundleId: node.bundleId,
    weightOwnerId: node.weightOwnerId,
    sharedOwner: node.sharedOwner ?? false,
    legacyPaths: [...node.legacyPaths],
    ...(node.hfDownloads ? { hfDownloads: node.hfDownloads } : {}),
    ...(node.httpsDownloads ? { httpsDownloads: node.httpsDownloads } : {}),
  })))
}

export function collectReadyOwnerIds(
  capabilities: readonly ModelOwnershipMetadata[],
  downloadedCapabilityIds: Iterable<string>,
): string[] {
  const ownershipByCapabilityId = new Map(capabilities.map((capability) => [capability.capabilityId, capability]))
  const readyOwnerIds = new Set<string>()

  for (const capabilityId of downloadedCapabilityIds) {
    const ownership = ownershipByCapabilityId.get(capabilityId)
    if (ownership) readyOwnerIds.add(ownership.weightOwnerId)
  }

  return [...readyOwnerIds]
}

function createSharedWarning(
  ownerCapabilityIds: string[],
  peerCapabilityIds: string[],
  downloaded: boolean,
  isOwnerDownloading: boolean,
): string | null {
  if (peerCapabilityIds.length === 0) return null

  if (isOwnerDownloading) {
    return ownerCapabilityIds.length > 1
      ? 'Shared weights are downloading for this extension. Wait for the download to finish.'
      : 'Model weights are downloading. Wait for the download to finish.'
  }

  if (downloaded) {
    return 'Shared weights are used by another node in this extension. Uninstall the whole extension to remove them safely.'
  }

  return 'Downloading this node also prepares shared weights for another node in this extension.'
}

export function deriveModelOwnershipState(
  capabilities: readonly ModelOwnershipMetadata[],
  readyOwnerIds: ReadonlySet<string>,
  downloadingOwnerIds: ReadonlySet<string> = new Set(),
): Record<string, ModelOwnershipCapabilityState> {
  const groupedCapabilityIds = capabilities.reduce<Record<string, string[]>>((groups, capability) => {
    groups[capability.weightOwnerId] ??= []
    groups[capability.weightOwnerId].push(capability.capabilityId)
    return groups
  }, {})

  return capabilities.reduce<Record<string, ModelOwnershipCapabilityState>>((state, capability) => {
    const downloaded = readyOwnerIds.has(capability.weightOwnerId)
    const isOwnerDownloading = downloadingOwnerIds.has(capability.weightOwnerId)
    const ownerCapabilityIds = groupedCapabilityIds[capability.weightOwnerId] ?? []
    const ownerPeerCapabilityIds = ownerCapabilityIds
      .filter((candidateCapabilityId) => candidateCapabilityId !== capability.capabilityId)

    state[capability.capabilityId] = {
      ...capability,
      downloaded,
      isOwnerDownloading,
      installDisabled: downloaded || isOwnerDownloading,
      deleteDisabled: !downloaded || isOwnerDownloading || ownerPeerCapabilityIds.length > 0,
      ownerPeerCapabilityIds,
      badges: capability.sharedOwner ? ['Shared weights'] : [],
      warning: capability.sharedOwner
        ? createSharedWarning(ownerCapabilityIds, ownerPeerCapabilityIds, downloaded, isOwnerDownloading)
        : null,
    }

    return state
  }, {})
}

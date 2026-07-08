import type { ArtifactRef } from './artifacts.ts'

export const ASSET_CAPABILITIES = [
  'mesh',
  'rigged-mesh',
  'animation-motion',
  'landmarks-sidecar',
  'generated-world',
  'scene-manifest',
] as const

export const ASSET_ENTRY_STATES = ['ready', 'unknown-metadata', 'unsupported', 'unsafe'] as const
export const ASSET_LIBRARY_PREVIEW_KINDS = ['3d-model', 'text', 'audio', 'binary', 'none'] as const
export const ASSET_LIBRARY_MANIFEST_CAPABILITIES = ['generated-world', 'scene-manifest'] as const
export const ASSET_LIBRARY_SOURCE_SCOPES = ['workflows', 'exports'] as const

export type AssetCapability = typeof ASSET_CAPABILITIES[number]
export type AssetEntryState = typeof ASSET_ENTRY_STATES[number]
export type AssetLibraryPreviewKind = typeof ASSET_LIBRARY_PREVIEW_KINDS[number]
export type AssetLibraryManifestCapability = typeof ASSET_LIBRARY_MANIFEST_CAPABILITIES[number]
export type AssetLibrarySourceScope = typeof ASSET_LIBRARY_SOURCE_SCOPES[number]

export interface AssetLibrarySourceLink {
  relation: 'source' | 'sidecar-source' | 'manifest-source' | 'derived-from'
  workspacePath?: string
  assetId?: string
  versionId?: string
  degraded?: boolean
}

export interface AssetLibraryManifestRef {
  capability: AssetLibraryManifestCapability
  workspacePath: string
  schema?: string
  title?: string
}

export interface AssetLibraryEntry {
  id: string
  workspacePath: string
  displayName: string
  createdAt?: string
  updatedAt?: string
  sourceScope: AssetLibrarySourceScope
  capability?: AssetCapability
  state: AssetEntryState
  artifactId?: string
  versionId?: string
  provenance?: ArtifactRef['provenance']
  source?: AssetLibrarySourceLink
  manifest?: AssetLibraryManifestRef
  previewKind: AssetLibraryPreviewKind
  warnings: string[]
}

export type AssetLibraryPreviewPayload =
  | {
      kind: '3d-model'
      viewerKind: 'glb' | 'gltf'
    }
  | {
      kind: 'text'
      content: string
      byteLength: number
      truncated: boolean
    }
  | {
      kind: 'audio'
      audioKind: 'wav' | 'mp3' | 'ogg' | 'flac'
      byteLength: number
      sourceUrl: string
    }
  | {
      kind: 'binary'
      binaryKind: string
      byteLength: number
      message: string
    }
  | {
      kind: 'none'
    }

export interface AssetLibraryReadRequest {
  workspacePath: string
  sourceWorkspacePath?: string
}

export type AssetLibraryListRequest = Record<string, never>

export type AssetLibraryReadResult =
  | {
      success: true
      entry: AssetLibraryEntry
      preview: AssetLibraryPreviewPayload
    }
  | {
      success: false
      error: string
    }

export type AssetLibraryListResult =
  | {
      success: true
      entries: AssetLibraryEntry[]
    }
  | {
      success: false
      error: string
    }

export type AssetLibraryOpenRequest = AssetLibraryReadRequest

export type AssetLibraryOpenResult =
  | {
      success: true
      entry: AssetLibraryEntry
    }
  | {
      success: false
      error: string
    }

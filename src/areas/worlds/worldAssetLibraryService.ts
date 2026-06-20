import type {
  AssetLibraryEntry,
  AssetLibraryListResult,
  AssetLibraryOpenRequest,
  AssetLibraryOpenResult,
} from '../../shared/types/assetLibrary.ts'
import type { WorkspaceAssetLibraryEntry } from '../../shared/components/WorkspaceAssetLibrary.tsx'
import {
  resolveWorldRenderable,
  type WorldRenderable,
  type WorldSceneItem,
  type WorldUnsupportedReason,
} from './worldRenderableResolver.ts'
import { listAssetLibraryEntries, readAssetLibraryEntry, openAssetLibraryEntry } from '../generate/assetLibraryService.ts'
import { projectAssetLibraryEntry } from '../generate/assetLibraryProjection.ts'
import { isSafeViewerWorkspaceRelativePath } from '../generate/viewerAssetTarget.ts'

export type WorldAssetLibraryType = 'GLB model' | 'GLTF scene' | 'PLY mesh' | 'PLY points' | 'Scene manifest' | 'Unsupported' | 'Unavailable'

export type WorldAssetLibraryRenderable =
  | (WorkspaceAssetLibraryEntry & {
      id: string
      name: string
      type: WorldAssetLibraryType
      openable: true
      workspacePath: string
      item: WorldSceneItem
    })
  | (WorkspaceAssetLibraryEntry & {
      id: string
      name: string
      type: 'Scene manifest'
      openable: true
      workspacePath: string
      sceneManifest: true
    })
  | (WorkspaceAssetLibraryEntry & {
      id: string
      name: string
      type: WorldAssetLibraryType
      openable: false
      workspacePath: string
      reason: WorldUnsupportedReason
    })

export type WorldAssetLibraryListResult =
  | { success: true; assets: WorldAssetLibraryRenderable[] }
  | { success: false; error: string }

export type WorldAssetLibraryOpenResult =
  | { success: true; asset: WorldAssetLibraryRenderable }
  | { success: false; error: string }

export async function listWorldAssetLibraryRenderables(apiUrl: string): Promise<WorldAssetLibraryListResult> {
  return projectWorldAssetLibraryListResult(await listAssetLibraryEntries(), apiUrl)
}

export async function openWorldAssetLibraryRenderable(request: AssetLibraryOpenRequest, apiUrl: string): Promise<WorldAssetLibraryOpenResult> {
  // Both facades validate the complete request before IPC. PLY uses authorised
  // read, not Generate's intentionally GLB/GLTF-only open policy.
  const read = typeof request?.workspacePath === 'string' && getExtension(request.workspacePath) === '.ply'
  const result = await (read ? readAssetLibraryEntry(request) : openAssetLibraryEntry(request))
  return projectWorldAssetLibraryOpenResult(result, apiUrl)
}

export function projectWorldAssetLibraryListResult(result: AssetLibraryListResult, apiUrl: string): WorldAssetLibraryListResult {
  if (result.success !== true) return result
  return {
    success: true,
    assets: result.entries.filter(isWorldLibraryCandidate).map((entry) => projectWorldAssetLibraryEntry(entry, apiUrl)),
  }
}

export function projectWorldAssetLibraryOpenResult(result: AssetLibraryOpenResult, apiUrl: string): WorldAssetLibraryOpenResult {
  if (result.success !== true) return result
  return {
    success: true,
    asset: projectWorldAssetLibraryEntry(result.entry, apiUrl),
  }
}

function projectWorldAssetLibraryEntry(entry: AssetLibraryEntry, apiUrl: string): WorldAssetLibraryRenderable {
  assertPlyHeader(entry.plyHeader)
  const extension = getExtension(entry.workspacePath)
  let renderable: WorldRenderable
  if (!isSafeViewerWorkspaceRelativePath(entry.workspacePath) || entry.state === 'unsafe') {
    renderable = { openable: false, reason: 'unsafe' }
  } else if (entry.state !== 'ready' || (extension === '.ply' && entry.plyHeader?.status !== 'complete')) {
    renderable = { openable: false, reason: 'unavailable' }
  } else if (['.glb', '.gltf'].includes(extension) && projectAssetLibraryEntry(entry).openTarget.kind !== 'self') {
    renderable = { openable: false, reason: 'unavailable' }
  } else {
    renderable = resolveWorldRenderable({ workspacePath: entry.workspacePath, apiUrl, header: entry.plyHeader?.status === 'complete' ? entry.plyHeader.content : undefined })
  }
  const name = resolveName(entry)
  const baseEntry = {
    ...entry,
    name,
    displayName: name,
  }

  if (entry.capability === 'scene-manifest' || entry.manifest?.capability === 'scene-manifest') {
    return {
      ...baseEntry,
      name,
      type: 'Scene manifest',
      openable: true,
      sceneManifest: true,
    }
  }

  if (renderable.openable) {
    return {
      ...baseEntry,
      name,
      type: describeRenderableType(renderable),
      openable: true,
      item: renderable.item,
    }
  }

  return {
    ...baseEntry,
    name,
    type: describeUnsupportedType(renderable.reason),
    openable: false,
    reason: renderable.reason,
  }
}

function isWorldLibraryCandidate(entry: AssetLibraryEntry): boolean {
  if (entry.capability === 'generated-world' || entry.capability === 'scene-manifest' || entry.capability === 'mesh' || entry.capability === 'rigged-mesh') {
    return true
  }
  return ['.ply', '.glb', '.gltf', '.spz'].includes(getExtension(entry.workspacePath))
}

function describeRenderableType(renderable: Extract<WorldRenderable, { openable: true }>): WorldAssetLibraryType {
  switch (renderable.item.kind) {
    case 'glb':
      return 'GLB model'
    case 'gltf':
      return 'GLTF scene'
    case 'ply-mesh':
      return 'PLY mesh'
    case 'ply-points':
      return 'PLY points'
  }
}

function describeUnsupportedType(reason: WorldUnsupportedReason): WorldAssetLibraryType {
  return reason === 'unsafe' || reason === 'unavailable' ? 'Unavailable' : 'Unsupported'
}

function resolveName(entry: AssetLibraryEntry): string {
  if (!isSafeViewerWorkspaceRelativePath(entry.workspacePath)) return entry.workspacePath
  const displayName = entry.displayName.trim()
  if (displayName) return displayName
  return entry.workspacePath.replace(/\\/g, '/').split('/').at(-1) || entry.workspacePath
}

function assertPlyHeader(value: unknown): void {
  if (value === undefined) return
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if ('status' in value && value.status === 'complete' && 'content' in value && typeof value.content === 'string'
      && value.content.length <= 65536 && new TextEncoder().encode(value.content).byteLength <= 65536) return
    if ('status' in value && value.status === 'unavailable' && 'reason' in value && typeof value.reason === 'string'
      && ['header-too-large', 'incomplete-header', 'invalid-header-encoding'].includes(value.reason)) return
  }
  throw new Error('Invalid asset library PLY header evidence.')
}

function getExtension(workspacePath: string): string {
  const filename = workspacePath.replace(/\\/g, '/').split('/').at(-1) ?? workspacePath
  const dotIndex = filename.lastIndexOf('.')
  return dotIndex === -1 ? '' : filename.slice(dotIndex).toLowerCase()
}

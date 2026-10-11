import type {
  AssetLibraryEntry,
  AssetLibraryListResult,
  AssetLibraryOpenRequest,
  AssetLibraryOpenResult,
  AssetLibraryReadRequest,
  AssetLibraryReadResult,
} from '../../shared/types/assetLibrary.ts'
import type { WorkspaceAssetLibraryEntry } from '../../shared/components/WorkspaceAssetLibrary.tsx'
import { normalizeWorldWorkspacePath } from './core/worldDocuments.ts'
import {
  resolveWorldRenderable,
  type WorldRenderable,
  type WorldSceneItem,
  type WorldUnsupportedReason,
} from './worldRenderableResolver.ts'
import { listAssetLibraryEntries, readAssetLibraryEntry, openAssetLibraryEntry } from '../generate/assetLibraryService.ts'
import { projectAssetLibraryEntry } from '../generate/assetLibraryProjection.ts'
import { isSafeViewerWorkspaceRelativePath } from '../generate/viewerAssetTarget.ts'

export type WorldAssetLibraryType = 'GLB model' | 'GLTF scene' | 'PLY mesh' | 'PLY points' | 'Gaussian PLY' | 'Scene manifest' | 'Pose clip' | 'Audio' | 'Unsupported' | 'Unavailable'

export type WorldAssetLibraryRenderable =
  | (WorkspaceAssetLibraryEntry & {
      id: string
      name: string
      type: 'Audio'
      openable: true
      workspacePath: string
      audio: true
      audioFormat: 'wav' | 'mp3' | 'ogg' | 'flac'
    })
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
      type: 'Pose clip'
      openable: true
      workspacePath: string
      poseClip: true
      animation: NonNullable<WorldSceneItem['animation']>
      linkedItem?: WorldSceneItem
    })
  | (WorkspaceAssetLibraryEntry & {
      id: string
      name: string
      type: WorldAssetLibraryType
      openable: false
      workspacePath: string
      reason: WorldUnsupportedReason
      plyKind?: AssetLibraryEntry['plyKind']
    })

export type WorldAssetLibraryListResult =
  | { success: true; assets: WorldAssetLibraryRenderable[] }
  | { success: false; error: string }

export type WorldAssetLibraryOpenResult =
  | { success: true; asset: WorldAssetLibraryRenderable }
  | { success: false; error: string }

export type WorldAssetLibraryAudioReadResult =
  | { success: true; audio: { workspacePath: string; format: 'wav' | 'mp3' | 'ogg' | 'flac'; name: string } }
  | { success: false; error: string }

export async function listWorldAssetLibraryRenderables(apiUrl: string): Promise<WorldAssetLibraryListResult> {
  return projectWorldAssetLibraryListResult(await listAssetLibraryEntries(), apiUrl)
}

export async function openWorldAssetLibraryRenderable(request: AssetLibraryOpenRequest, apiUrl: string): Promise<WorldAssetLibraryOpenResult> {
  // Both facades validate the complete request before IPC. PLY and JSON metadata
  // use authorised read, not Generate's intentionally GLB/GLTF-only open policy.
  const read = typeof request?.workspacePath === 'string' && ['.ply', '.json'].includes(getExtension(request.workspacePath))
  const result = await (read ? readAssetLibraryEntry(request) : openAssetLibraryEntry(request))
  return projectWorldAssetLibraryOpenResult(result, apiUrl)
}

export function readWorldAssetLibraryAudio(request: AssetLibraryReadRequest): Promise<WorldAssetLibraryAudioReadResult> {
  if (!isCanonicalSafeWorkspacePath(request.workspacePath) || request.sourceWorkspacePath) {
    return Promise.reject(new Error('World asset library service requires a safe workspace-relative path.'))
  }
  return readAssetLibraryEntry(request).then((result) => projectWorldAssetLibraryAudioReadResult(result, request.workspacePath))
}

export function projectWorldAssetLibraryListResult(result: AssetLibraryListResult, apiUrl: string): WorldAssetLibraryListResult {
  if (result.success !== true) return result
  if (!Array.isArray(result.entries)) {
    return { success: false, error: 'Workspace asset-library returned an invalid entries payload.' }
  }
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
  } else if (extension === '.ply' && entry.plyKind === 'gaussian') {
    renderable = resolveWorldRenderable({ workspacePath: entry.workspacePath, apiUrl, plyKind: entry.plyKind })
  } else if (entry.state !== 'ready' || (extension === '.ply' && entry.plyHeader?.status !== 'complete')) {
    renderable = { openable: false, reason: 'unavailable' }
  } else if (['.glb', '.gltf'].includes(extension) && projectAssetLibraryEntry(entry).openTarget.kind !== 'self') {
    renderable = { openable: false, reason: 'unavailable' }
  } else {
    renderable = resolveWorldRenderable({ workspacePath: entry.workspacePath, apiUrl, plyKind: entry.plyKind, header: entry.plyHeader?.status === 'complete' ? entry.plyHeader.content : undefined })
  }
  const name = resolveName(entry)
  const baseEntry = {
    ...entry,
    name,
    displayName: name,
  }

  const audioFormat = resolveAudioFormat(entry)
  if (audioFormat && isCanonicalSafeWorkspacePath(entry.workspacePath)) {
    return { ...baseEntry, type: 'Audio', openable: true, audio: true, audioFormat }
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

  if (entry.capability === 'animation-motion') {
    const sourceWorkspacePath = entry.source?.relation === 'sidecar-source' ? entry.source.workspacePath : undefined
    const safeSidecarPath = isSafeViewerWorkspaceRelativePath(entry.workspacePath)
    const safeSourcePath = typeof sourceWorkspacePath === 'string' && isSafeViewerWorkspaceRelativePath(sourceWorkspacePath)
    const linkedRenderable = safeSourcePath ? resolveWorldRenderable({ workspacePath: sourceWorkspacePath, apiUrl }) : null

    if (safeSidecarPath && safeSourcePath && sourceWorkspacePath && linkedRenderable?.openable === true) {
      return {
        ...baseEntry,
        name,
        type: 'Pose clip',
        openable: true,
        poseClip: true,
        animation: {
          kind: 'pose-clip',
          sidecarWorkspacePath: entry.workspacePath,
          sourceWorkspacePath,
        },
        linkedItem: linkedRenderable.item,
      }
    }

    return {
      ...baseEntry,
      name,
      type: safeSidecarPath ? 'Unavailable' : 'Unsupported',
      openable: false,
      reason: safeSidecarPath ? 'unavailable' : 'unsafe',
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
  if (entry.capability === 'generated-world' || entry.capability === 'scene-manifest' || entry.capability === 'mesh' || entry.capability === 'rigged-mesh' || entry.capability === 'animation-motion') {
    return true
  }
  if (entry.previewKind === 'audio' && resolveAudioFormat(entry)) return true
  return ['.ply', '.glb', '.gltf', '.spz'].includes(getExtension(entry.workspacePath))
}

function projectWorldAssetLibraryAudioReadResult(result: AssetLibraryReadResult, requestedPath: string): WorldAssetLibraryAudioReadResult {
  if (result.success !== true) return result
  if (result.entry.workspacePath !== requestedPath || !isCanonicalSafeWorkspacePath(result.entry.workspacePath)) {
    return { success: false, error: 'Workspace asset-library returned a mismatched or unsafe audio path.' }
  }
  const format = resolveAudioFormat(result.entry)
  if (result.preview.kind !== 'audio' || !format || result.preview.audioKind !== format) {
    return { success: false, error: 'Workspace asset-library entry is not compatible audio.' }
  }
  return {
    success: true,
    audio: { workspacePath: result.entry.workspacePath, format, name: resolveName(result.entry) },
  }
}

function resolveAudioFormat(entry: AssetLibraryEntry): 'wav' | 'mp3' | 'ogg' | 'flac' | null {
  if (entry.previewKind !== 'audio') return null
  const extension = getExtension(entry.workspacePath).slice(1)
  return extension === 'wav' || extension === 'mp3' || extension === 'ogg' || extension === 'flac' ? extension : null
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
    case 'gaussian-ply':
      return 'Gaussian PLY'
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

function isCanonicalSafeWorkspacePath(workspacePath: string): boolean {
  return normalizeWorldWorkspacePath(workspacePath) === workspacePath
}

function getExtension(workspacePath: string): string {
  const filename = workspacePath.replace(/\\/g, '/').split('/').at(-1) ?? workspacePath
  const dotIndex = filename.lastIndexOf('.')
  return dotIndex === -1 ? '' : filename.slice(dotIndex).toLowerCase()
}

import { classifyPlyHeader } from './plyClassification.ts'

export type WorldAssetKind = 'glb' | 'gltf' | 'ply-mesh' | 'ply-points' | 'gaussian-ply' | 'spz'
export type WorldSceneItemRole = 'asset' | 'base-scene'

export type WorldUnsupportedReason =
  | 'unsafe'
  | 'unsupported-spz'
  | 'unsupported-gaussian-ply'
  | 'unsupported-extension'
  | 'unavailable'

export interface WorldSceneItem {
  id: string
  workspacePath: string
  url: string
  kind: Exclude<WorldAssetKind, 'gaussian-ply' | 'spz'>
  role: WorldSceneItemRole
  visible: boolean
  animation?: WorldSceneItemAnimationBinding
  transform: {
    position: [number, number, number]
    rotation: [number, number, number]
    scale: [number, number, number]
  }
}

export interface WorldSceneItemAnimationBinding {
  kind: 'pose-clip'
  sidecarWorkspacePath: string
  legacySidecarWorkspacePath?: string
  sourceWorkspacePath: string
  clipId?: string
  clipName?: string
  durationSeconds?: number
}

export type WorldRenderable =
  | { openable: true; item: WorldSceneItem }
  | { openable: false; reason: WorldUnsupportedReason }

export interface WorldRenderableInput {
  workspacePath: string
  url?: string
  apiUrl?: string
  header?: string
}

export interface WorldMirrorBundleInput {
  rootPath: string
  files: string[]
  headersByPath?: Record<string, string>
}

const WORLD_MIRROR_PRIORITY = ['ply/fuse_simplified.ply', 'ply/fuse_post.ply']
const IDENTITY_TRANSFORM = {
  position: [0, 0, 0] as [number, number, number],
  rotation: [0, 0, 0] as [number, number, number],
  scale: [1, 1, 1] as [number, number, number],
}

export function resolveWorldMirrorBundleRenderable(bundle: WorldMirrorBundleInput): WorldRenderable {
  const normalizedRoot = normalizeWorkspacePath(bundle.rootPath)
  if (!normalizedRoot) return { openable: false, reason: 'unsafe' }

  for (const priorityPath of [...WORLD_MIRROR_PRIORITY, ...bundle.files]) {
    if (!bundle.files.includes(priorityPath)) continue

    const renderable = resolveWorldRenderable({
      workspacePath: `${normalizedRoot}/${priorityPath}`,
      header: bundle.headersByPath?.[priorityPath],
    })

    if (renderable.openable) return renderable
  }

  const gltfFallback = bundle.files.find((file) => ['.ply', '.glb', '.gltf'].includes(getExtension(file)))
  if (!gltfFallback) return { openable: false, reason: 'unavailable' }
  return resolveWorldRenderable({
    workspacePath: `${normalizedRoot}/${gltfFallback}`,
    header: bundle.headersByPath?.[gltfFallback],
  })
}

export function resolveWorldRenderable(input: WorldRenderableInput): WorldRenderable {
  const workspacePath = normalizeWorkspacePath(input.workspacePath)
  if (!workspacePath) return { openable: false, reason: 'unsafe' }

  const extension = getExtension(workspacePath)
  if (extension === '.spz') return { openable: false, reason: 'unsupported-spz' }
  if (extension === '.glb' || extension === '.gltf') {
    return { openable: true, item: createSceneItem(workspacePath, extension.slice(1) as 'glb' | 'gltf', input) }
  }
  if (extension === '.ply') {
    const classification = input.header ? classifyPlyHeader(input.header) : undefined
    if (classification?.kind === 'gaussian') return { openable: false, reason: 'unsupported-gaussian-ply' }
    const kind = classification?.kind === 'standard-points' ? 'ply-points' : 'ply-mesh'
    return { openable: true, item: createSceneItem(workspacePath, kind, input) }
  }

  return { openable: false, reason: 'unsupported-extension' }
}

export function toWorldSceneItems(renderables: WorldRenderable[]): WorldSceneItem[] {
  return renderables.flatMap((renderable) => (renderable.openable ? [renderable.item] : []))
}

function createSceneItem(workspacePath: string, kind: WorldSceneItem['kind'], input: Pick<WorldRenderableInput, 'url' | 'apiUrl'> = {}): WorldSceneItem {
  return {
    id: `world:${workspacePath}`,
    workspacePath,
    url: resolveWorldRenderableUrl(workspacePath, input),
    kind,
    role: 'asset',
    visible: true,
    transform: {
      position: [...IDENTITY_TRANSFORM.position],
      rotation: [...IDENTITY_TRANSFORM.rotation],
      scale: [...IDENTITY_TRANSFORM.scale],
    },
  }
}

function normalizeWorkspacePath(workspacePath: string): string | undefined {
  const normalized = workspacePath.replace(/\\/g, '/').trim().replace(/^\.\//, '')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.includes('\0') || /%2e|%2f|%5c/i.test(normalized)) return undefined
  if (normalized.split('/').some((segment) => segment === '' || segment === '..')) return undefined
  return normalized
}

function resolveWorldRenderableUrl(workspacePath: string, input: Pick<WorldRenderableInput, 'url' | 'apiUrl'>): string {
  const explicitUrl = input.url?.trim()
  if (explicitUrl && (/^(?:https?:|blob:)/i.test(explicitUrl))) return explicitUrl
  if (explicitUrl?.startsWith('/') && input.apiUrl) return `${input.apiUrl}${explicitUrl}`

  return input.apiUrl ? `${input.apiUrl}/workspace/${workspacePath}` : `/workspace/${workspacePath}`
}

function getExtension(workspacePath: string): string {
  const filename = workspacePath.split('/').at(-1) ?? workspacePath
  const dotIndex = filename.lastIndexOf('.')
  return dotIndex === -1 ? '' : filename.slice(dotIndex).toLowerCase()
}

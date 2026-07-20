export const PREVIEW_IMAGE_NODE_TYPE = 'previewImageNode'
export const PREVIEW_VIEWS_NODE_TYPE = 'previewNode'
export const PREVIEW_VIDEO_NODE_TYPE = 'previewVideoNode'
export const PREVIEW_IMAGE_TITLE = 'Preview Image'
export const PREVIEW_VIEWS_TITLE = 'Preview Views'
export const PREVIEW_VIDEO_TITLE = 'Preview Video'
export const PREVIEW_IMAGE_EMPTY_COPY = 'Connect an image to preview.'
export const PREVIEW_VIEWS_EMPTY_COPY = 'Connect a multi-view image to preview.'
export const PREVIEW_VIDEO_EMPTY_COPY = 'Connect a video to preview.'

type PreviewEdge = {
  source: string
  sourceHandle?: string | null
  target: string
}

function resolvePreviewOutput(incomingEdge: PreviewEdge | undefined, nodeOutputs: Record<string, string>): string | undefined {
  if (!incomingEdge) {
    return undefined
  }

  return nodeOutputs[incomingEdge.source]
}

type ResolvePreviewImageUrlArgs = {
  nodeId: string
  apiUrl?: string
  edges: PreviewEdge[]
  nodeImageOutputs: Record<string, string>
}

type NormalizePreviewImageUrlArgs = {
  imageUrl?: string
  apiUrl?: string
}

export function normalizePreviewImageUrl({ imageUrl, apiUrl }: NormalizePreviewImageUrlArgs): string | undefined {
  if (!imageUrl) {
    return undefined
  }

  if (!imageUrl.startsWith('/workspace/')) {
    return imageUrl
  }

  return apiUrl ? `${apiUrl}${imageUrl}` : undefined
}

export function resolvePreviewImageUrl({ nodeId, apiUrl, edges, nodeImageOutputs }: ResolvePreviewImageUrlArgs): string | undefined {
  const incomingEdge = edges.find((edge) => edge.target === nodeId)
  return normalizePreviewImageUrl({
    imageUrl: resolvePreviewOutput(incomingEdge, nodeImageOutputs),
    apiUrl,
  })
}

type ResolvePreviewVideoUrlArgs = {
  nodeId: string
  apiUrl?: string
  edges: PreviewEdge[]
  nodeVideoOutputs: Record<string, string>
}

type NormalizePreviewVideoUrlArgs = {
  videoUrl?: string
  apiUrl?: string
}

export function normalizePreviewVideoUrl({ videoUrl, apiUrl }: NormalizePreviewVideoUrlArgs): string | undefined {
  if (!videoUrl) {
    return undefined
  }

  if (!videoUrl.startsWith('/workspace/')) {
    return videoUrl
  }

  return apiUrl ? `${apiUrl}${videoUrl}` : undefined
}

export function resolvePreviewVideoUrl({ nodeId, apiUrl, edges, nodeVideoOutputs }: ResolvePreviewVideoUrlArgs): string | undefined {
  const incomingEdge = edges.find((edge) => edge.target === nodeId)
  return normalizePreviewVideoUrl({
    videoUrl: resolvePreviewOutput(incomingEdge, nodeVideoOutputs),
    apiUrl,
  })
}

export function previewNodeTargetArtifactKind(nodeType?: string): 'image' | 'video' | undefined {
  if (nodeType === PREVIEW_VIDEO_NODE_TYPE) return 'video'
  if (nodeType === PREVIEW_IMAGE_NODE_TYPE || nodeType === PREVIEW_VIEWS_NODE_TYPE) return 'image'
  return undefined
}

export function isPreviewNodeType(nodeType?: string): boolean {
  return previewNodeTargetArtifactKind(nodeType) !== undefined
}

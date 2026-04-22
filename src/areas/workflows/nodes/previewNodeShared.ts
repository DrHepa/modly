export const PREVIEW_IMAGE_NODE_TYPE = 'previewImageNode'
export const PREVIEW_VIEWS_NODE_TYPE = 'previewNode'
export const PREVIEW_IMAGE_TITLE = 'Preview Image'
export const PREVIEW_VIEWS_TITLE = 'Preview Views'
export const PREVIEW_IMAGE_EMPTY_COPY = 'Connect an image to preview.'
export const PREVIEW_VIEWS_EMPTY_COPY = 'Connect a multi-view image to preview.'

type PreviewEdge = {
  source: string
  target: string
}

type ResolvePreviewImageUrlArgs = {
  nodeId: string
  edges: PreviewEdge[]
  nodeImageOutputs: Record<string, string>
}

export function resolvePreviewImageUrl({ nodeId, edges, nodeImageOutputs }: ResolvePreviewImageUrlArgs): string | undefined {
  const incomingEdge = edges.find((edge) => edge.target === nodeId)
  return incomingEdge ? nodeImageOutputs[incomingEdge.source] : undefined
}

export function isPreviewNodeType(nodeType?: string): boolean {
  return nodeType === PREVIEW_IMAGE_NODE_TYPE || nodeType === PREVIEW_VIEWS_NODE_TYPE
}

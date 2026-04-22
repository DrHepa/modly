import type { WFNode } from '../../../shared/types/electron.d'
import { resolveDataSource } from '../nodeBehaviors'

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
  nodes?: WFNode[]
  nodeImageOutputs: Record<string, string>
}

export function resolvePreviewImageUrl({ nodeId, edges, nodes = [], nodeImageOutputs }: ResolvePreviewImageUrlArgs): string | undefined {
  const incomingEdge = edges.find((edge) => edge.target === nodeId)
  if (!incomingEdge) return undefined
  const sourceId = resolveDataSource(
    incomingEdge.source,
    edges.map((edge, index) => ({ ...edge, id: String(index) })),
    new Map(nodes.map((node) => [node.id, node])),
  )
  // This map is produced only for image outputs by the runner. Never interpret
  // arbitrary artifact/scene file paths as preview images.
  return sourceId ? nodeImageOutputs[sourceId] : undefined
}

export function isPreviewNodeType(nodeType?: string): boolean {
  return nodeType === PREVIEW_IMAGE_NODE_TYPE || nodeType === PREVIEW_VIEWS_NODE_TYPE
}

import React from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'

import { useWorkflowRunStore } from '../workflowRunStore'
import { useAppStore } from '../../../shared/stores/appStore.ts'
import BaseNode from './BaseNode'
import { PREVIEW_VIEWS_EMPTY_COPY, PREVIEW_VIEWS_TITLE, resolvePreviewImageUrl } from './previewNodeShared'

const INPUT_COLOR = '#38bdf8'

export function PreviewViewsContent({ imageUrl }: { imageUrl?: string }) {
  if (!imageUrl) {
    return (
        <p className="py-2 text-center text-[10px] text-zinc-600 italic">
        {PREVIEW_VIEWS_EMPTY_COPY}
      </p>
    )
  }

  return (
    <div
      className="nodrag grid gap-0.5 overflow-hidden rounded"
      style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}
    >
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <div
          key={index}
          style={{
            aspectRatio: '1',
            backgroundImage: `url(${imageUrl})`,
            backgroundSize: '100% 600%',
            backgroundPosition: `0 ${index * 20}%`,
            backgroundRepeat: 'no-repeat',
            borderRadius: '2px',
          }}
        />
      ))}
    </div>
  )
}

export function resolvePreviewViewsNodeUrl({
  nodeId,
  apiUrl,
  getEdges,
  nodeImageOutputs,
}: {
  nodeId: string
  apiUrl?: string
  getEdges: () => Array<{ source: string; target: string }>
  nodeImageOutputs: Record<string, string>
}) {
  return resolvePreviewImageUrl({
    nodeId,
    apiUrl,
    edges: getEdges(),
    nodeImageOutputs,
  })
}

export default function PreviewViewsNode({ id, selected }: { id: string; selected?: boolean }) {
  const apiUrl = useAppStore((state) => state.apiUrl)
  const nodeImageOutputs = useWorkflowRunStore((state) => state.nodeImageOutputs)
  const { getEdges } = useReactFlow()

  const imageUrl = resolvePreviewViewsNodeUrl({
    nodeId: id,
    apiUrl,
    getEdges,
    nodeImageOutputs,
  })

  return (
    <BaseNode
      id={id}
      selected={selected}
      title={PREVIEW_VIEWS_TITLE}
      minWidth={200}
      icon={
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={INPUT_COLOR} strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
      }
      subheader={
        <div className="flex items-center gap-1.5 px-3 py-2">
          <span className="inline-flex items-center rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-medium text-sky-400">image</span>
          <span className="text-[9px] text-zinc-600">→ multi-view preview</span>
        </div>
      }
      handles={
        <Handle
          type="target"
          position={Position.Left}
          style={{ background: INPUT_COLOR, width: 14, height: 14, border: '2.5px solid #18181b' }}
        />
      }
    >
      <div className="px-2 pb-2 pt-1">
        <PreviewViewsContent imageUrl={imageUrl} />
      </div>
    </BaseNode>
  )
}

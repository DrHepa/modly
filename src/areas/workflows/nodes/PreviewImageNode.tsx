import React from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'

import { useWorkflowRunStore } from '../workflowRunStore'
import { useAppStore } from '../../../shared/stores/appStore.ts'
import BaseNode from './BaseNode'
import { PREVIEW_IMAGE_EMPTY_COPY, PREVIEW_IMAGE_TITLE, resolvePreviewImageUrl } from './previewNodeShared'

const INPUT_COLOR = '#38bdf8'

export function PreviewImageContent({ imageUrl }: { imageUrl?: string }) {
  if (!imageUrl) {
    return (
        <p className="py-2 text-center text-[10px] text-zinc-600 italic">
        {PREVIEW_IMAGE_EMPTY_COPY}
      </p>
    )
  }

  return (
    <div className="nodrag overflow-hidden rounded border border-zinc-800 bg-zinc-950/60">
      <img src={imageUrl} alt="Workflow preview output" className="h-40 w-full object-contain" />
    </div>
  )
}

export function resolvePreviewImageNodeUrl({
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

export default function PreviewImageNode({ id, selected }: { id: string; selected?: boolean }) {
  const apiUrl = useAppStore((state) => state.apiUrl)
  const nodeImageOutputs = useWorkflowRunStore((state) => state.nodeImageOutputs)
  const { getEdges } = useReactFlow()

  const imageUrl = resolvePreviewImageNodeUrl({
    nodeId: id,
    apiUrl,
    getEdges,
    nodeImageOutputs,
  })

  return (
    <BaseNode
      id={id}
      selected={selected}
      title={PREVIEW_IMAGE_TITLE}
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
          <span className="text-[9px] text-zinc-600">→ single preview</span>
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
        <PreviewImageContent imageUrl={imageUrl} />
      </div>
    </BaseNode>
  )
}

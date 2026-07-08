import React from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'

import { useWorkflowRunStore } from '../workflowRunStore'
import { useAppStore } from '../../../shared/stores/appStore.ts'
import BaseNode from './BaseNode'
import { PREVIEW_VIDEO_EMPTY_COPY, PREVIEW_VIDEO_TITLE, resolvePreviewVideoUrl } from './previewNodeShared'

const INPUT_COLOR = '#fb7185'

export function PreviewVideoContent({ videoUrl }: { videoUrl?: string }) {
  const [playbackError, setPlaybackError] = React.useState(false)

  if (!videoUrl) {
    return (
      <p className="py-2 text-center text-[10px] text-zinc-600 italic">
        {PREVIEW_VIDEO_EMPTY_COPY}
      </p>
    )
  }

  return (
    <div className="nodrag flex h-full min-h-[150px] flex-col overflow-hidden rounded border border-zinc-800 bg-zinc-950/60">
      <video
        key={videoUrl}
        src={videoUrl}
        controls
        playsInline
        preload="metadata"
        onError={() => setPlaybackError(true)}
        onLoadedMetadata={() => setPlaybackError(false)}
        className="min-h-0 flex-1 bg-black object-contain"
      />
      {playbackError && (
        <p className="border-t border-zinc-800 px-2 py-1 text-[9px] text-amber-300">
          Video preview failed in Electron. The MP4 file is still available in the workspace.
        </p>
      )}
    </div>
  )
}

export function resolvePreviewVideoNodeUrl({
  nodeId,
  apiUrl,
  getEdges,
  nodeVideoOutputs,
}: {
  nodeId: string
  apiUrl?: string
  getEdges: () => Array<{ source: string; target: string }>
  nodeVideoOutputs: Record<string, string>
}) {
  return resolvePreviewVideoUrl({
    nodeId,
    apiUrl,
    edges: getEdges(),
    nodeVideoOutputs,
  })
}

export default function PreviewVideoNode({ id, selected }: { id: string; selected?: boolean }) {
  const apiUrl = useAppStore((state) => state.apiUrl)
  const nodeVideoOutputs = useWorkflowRunStore((state) => state.nodeVideoOutputs)
  const { getEdges } = useReactFlow()

  const videoUrl = resolvePreviewVideoNodeUrl({
    nodeId: id,
    apiUrl,
    getEdges,
    nodeVideoOutputs,
  })

  return (
    <BaseNode
      id={id}
      selected={selected}
      title={PREVIEW_VIDEO_TITLE}
      minWidth={260}
      minHeight={220}
      icon={
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={INPUT_COLOR} strokeWidth="2">
          <rect x="3" y="5" width="14" height="14" rx="2"/>
          <path d="M17 9l4-2v10l-4-2z"/>
        </svg>
      }
      subheader={
        <div className="flex items-center gap-1.5 px-3 py-2">
          <span className="inline-flex items-center rounded border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 text-[9px] font-medium text-rose-400">video</span>
          <span className="text-[9px] text-zinc-600">→ mp4 preview</span>
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
      <div className="flex-1 min-h-[160px] px-2 pb-2 pt-1">
        <PreviewVideoContent videoUrl={videoUrl} />
      </div>
    </BaseNode>
  )
}

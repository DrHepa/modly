import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'
import type { WFNodeData } from '@shared/types/electron.d'
import BaseNode from './BaseNode'

const OUTPUT_COLOR = '#fb7185'

export function withoutVideoSelection(params: Record<string, unknown>): Record<string, unknown> {
  const next = { ...params }
  delete next.videoPath
  delete next.displayName
  return next
}

export function resolveVideoSelectionLabel(params: Record<string, unknown>): string | undefined {
  const displayName = typeof params.displayName === 'string' ? params.displayName.trim() : ''
  if (displayName) return displayName

  const videoPath = typeof params.videoPath === 'string' ? params.videoPath.trim() : ''
  if (!videoPath) return undefined

  const pathParts = videoPath
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
  return pathParts[pathParts.length - 1] ?? 'Selected video'
}

export function VideoNodeContent({
  displayName,
  error,
  onSelect,
  onClear,
}: {
  displayName?: string
  error?: string
  onSelect: () => void
  onClear: () => void
}) {
  if (!displayName) {
    return (
      <div className="px-3 py-3">
        <button
          type="button"
          onClick={onSelect}
          className="nodrag w-full min-h-9 flex items-center justify-center gap-2 px-2.5 py-2 rounded-lg border border-dashed border-zinc-700 hover:border-rose-400/60 hover:bg-rose-400/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 transition-colors"
        >
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-500 shrink-0">
            <path d="M15 10l4.55-2.27A1 1 0 0 1 21 8.62v6.76a1 1 0 0 1-1.45.89L15 14"/>
            <rect x="3" y="6" width="12" height="12" rx="2"/>
          </svg>
          <span className="text-[10px] text-zinc-400">Select video</span>
        </button>
        {error && <p role="alert" className="mt-2 text-[9px] leading-snug text-red-400">{error}</p>}
      </div>
    )
  }

  return (
    <div className="px-3 py-3 flex flex-col gap-2">
      <p className="truncate text-[10px] font-medium text-zinc-200" title={displayName} aria-live="polite">
        {displayName}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          aria-label="Change selected video"
          onClick={onSelect}
          className="nodrag min-h-7 flex-1 rounded-md border border-zinc-700 px-2 text-[9px] text-zinc-300 hover:border-rose-400/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 transition-colors"
        >
          Change
        </button>
        <button
          type="button"
          aria-label="Clear selected video"
          onClick={onClear}
          className="nodrag min-h-7 rounded-md border border-zinc-700 px-2 text-[9px] text-zinc-400 hover:border-red-400/60 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 transition-colors"
        >
          Clear
        </button>
      </div>
      {error && <p role="alert" className="text-[9px] leading-snug text-red-400">{error}</p>}
    </div>
  )
}

export default function VideoNode({ id, data, selected }: { id: string; data: WFNodeData; selected?: boolean }) {
  const { updateNodeData } = useReactFlow()
  const ioRowRef = useRef<HTMLDivElement>(null)
  const [handleTop, setHandleTop] = useState('50%')
  const [error, setError] = useState<string>()

  useLayoutEffect(() => {
    if (ioRowRef.current) {
      const center = ioRowRef.current.offsetTop + ioRowRef.current.offsetHeight / 2
      setHandleTop(`${center}px`)
    }
  }, [])

  const displayName = resolveVideoSelectionLabel(data.params)

  const selectVideo = useCallback(async () => {
    setError(undefined)
    try {
      const selection = await window.electron.fs.selectVideo()
      if (!selection) return
      updateNodeData(id, {
        params: {
          ...data.params,
          videoPath: selection.workspacePath,
          displayName: selection.displayName,
        },
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [data.params, id, updateNodeData])

  const clearVideo = useCallback(() => {
    setError(undefined)
    updateNodeData(id, { params: withoutVideoSelection(data.params) })
  }, [data.params, id, updateNodeData])

  return (
    <BaseNode
      id={id}
      selected={selected}
      title="Video"
      showInGenerate={data.showInGenerate ?? false}
      minWidth={180}
      autoHeight
      icon={
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={OUTPUT_COLOR} strokeWidth="2">
          <path d="M15 10l4.55-2.27A1 1 0 0 1 21 8.62v6.76a1 1 0 0 1-1.45.89L15 14"/>
          <rect x="3" y="6" width="12" height="12" rx="2"/>
        </svg>
      }
      subheader={
        <div ref={ioRowRef} className="flex items-center justify-end px-3 py-2">
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border border-rose-400/30 bg-rose-400/10 text-rose-300">video</span>
        </div>
      }
      handles={
        <Handle
          type="source"
          position={Position.Right}
          style={{ background: OUTPUT_COLOR, width: 14, height: 14, border: '2.5px solid #18181b', top: handleTop }}
        />
      }
    >
      <VideoNodeContent
        displayName={displayName}
        error={error}
        onSelect={selectVideo}
        onClear={clearVideo}
      />
    </BaseNode>
  )
}

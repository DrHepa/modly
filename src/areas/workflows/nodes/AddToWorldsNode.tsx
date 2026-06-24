import { Handle, Position } from '@xyflow/react'
import type { WFNodeData } from '@shared/types/electron.d'
import BaseNode from './BaseNode'

const INPUT_COLOR = '#a78bfa'

export default function AddToWorldsNode({ id, selected }: { id: string; data: WFNodeData; selected?: boolean }) {
  return (
    <BaseNode
      id={id}
      selected={selected}
      title="Add to Worlds"
      minWidth={160}
      icon={
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2">
          <path d="M12 2 3 7l9 5 9-5-9-5Z"/>
          <path d="M3 12l9 5 9-5"/>
          <path d="M3 17l9 5 9-5"/>
        </svg>
      }
      subheader={
        <div className="flex items-center gap-1.5 px-3 py-2">
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border border-violet-500/30 bg-violet-500/10 text-violet-400">mesh</span>
          <span className="text-[9px] text-zinc-600">→ worlds</span>
        </div>
      }
      handles={
        <Handle type="target" position={Position.Left}
          style={{ background: INPUT_COLOR, width: 14, height: 14, border: '2.5px solid #18181b' }} />
      }
    >
      <div className="px-3 pb-3 pt-2.5">
        <div className="rounded-lg border border-violet-500/20 bg-violet-500/10 px-2.5 py-2 text-[10px] leading-relaxed text-violet-200">
          Automatically adds the connected mesh to Worlds when the workflow runs.
        </div>
      </div>
    </BaseNode>
  )
}

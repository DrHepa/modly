import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'
import type { WFNodeData } from '@shared/types/electron.d'

import BaseNode from './BaseNode'
import { resolveCaptureSourceManifest } from '../workflowCaptureSource'

const OUTPUT_COLOR = '#22d3ee'

export default function LoadCaptureNode({ id, data, selected }: { id: string; data: WFNodeData; selected?: boolean }) {
  const { updateNodeData } = useReactFlow()
  const ioRowRef = useRef<HTMLDivElement>(null)
  const [handleTop, setHandleTop] = useState('50%')
  useLayoutEffect(() => {
    if (ioRowRef.current) setHandleTop(`${ioRowRef.current.offsetTop + ioRowRef.current.offsetHeight / 2}px`)
  }, [])

  const capturePath = typeof data.params.path === 'string' ? data.params.path : ''
  const manifestPath = typeof data.params.manifestPath === 'string' ? data.params.manifestPath : undefined
  const kind = typeof data.params.kind === 'string' ? data.params.kind : undefined
  const error = typeof data.params.error === 'string' ? data.params.error : undefined

  const validate = useCallback(async (nextPath: string) => {
    const settings = await window.electron.settings.get()
    const result = await resolveCaptureSourceManifest({
      capturePath: nextPath,
      workspaceDir: settings.workspaceDir,
      readFileBase64: window.electron.fs.readFileBase64,
    })
    updateNodeData(id, {
      params: result.ok
        ? { ...data.params, path: result.inputWorkspacePath, manifestPath: result.manifestWorkspacePath, kind: result.kind, error: undefined }
        : { ...data.params, path: nextPath, manifestPath: undefined, kind: undefined, error: result.error },
    })
  }, [data.params, id, updateNodeData])

  const browse = useCallback(async () => {
    const path = await window.electron.fs.selectDirectory()
    if (path) await validate(path)
  }, [validate])

  return (
    <BaseNode id={id} selected={selected} title="Load Capture" showInGenerate={data.showInGenerate ?? false} minWidth={230}
      icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={OUTPUT_COLOR} strokeWidth="2"><path d="M3 6h18v12H3z"/><path d="m9 10 6 3-6 3z"/></svg>}
      subheader={<div ref={ioRowRef} className="flex items-center justify-end px-3 py-2"><span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border border-cyan-500/30 bg-cyan-500/10 text-cyan-400">capture</span></div>}
      handles={<Handle type="source" position={Position.Right} style={{ background: OUTPUT_COLOR, width: 14, height: 14, border: '2.5px solid #18181b', top: handleTop }} />}
    >
      <div className="px-3 py-2.5 flex flex-col gap-2">
        <input type="text" value={capturePath} placeholder="Captures/room or capture-manifest.json"
          onChange={(event) => updateNodeData(id, { params: { ...data.params, path: event.target.value } })}
          className="nodrag w-full rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-2 text-[10px] text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-cyan-500/40" />
        <div className="flex gap-2">
          <button onClick={browse} className="nodrag flex-1 rounded-lg border border-zinc-700 px-2 py-1.5 text-[10px] text-zinc-300 hover:border-cyan-500/40">Directory...</button>
          <button onClick={() => validate(capturePath)} className="nodrag rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2 py-1.5 text-[10px] text-cyan-300">Validate</button>
        </div>
        {manifestPath && <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 px-2.5 py-2 text-[10px] text-zinc-300"><div className="text-cyan-400">Manifest: {manifestPath}</div><div className="text-zinc-500">kind: {kind}</div></div>}
        {!manifestPath && <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/40 px-2.5 py-2 text-[10px] text-zinc-500">Loads a validated video or ordered-frame capture manifest.</div>}
        {error && <div className="text-[10px] text-rose-400">{error}</div>}
      </div>
    </BaseNode>
  )
}

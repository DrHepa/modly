import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'
import type { ReactFlowInstance } from '@xyflow/react'
import type { WFNode, WFNodeData } from '@shared/types/electron.d'

import BaseNode from './BaseNode'
import {
  applySceneValidationResult,
  invalidateValidatedScenePath,
  resolveSceneSourceManifest,
} from '../workflowSceneSource'

const OUTPUT_COLOR = '#f472b6'

async function validateAndPersistScenePath(args: {
  id: string
  nextPath: string
  updateNodeData: ReactFlowInstance<WFNode>['updateNodeData']
  isCurrent: () => boolean
}): Promise<void> {
  args.updateNodeData(args.id, (node) => ({
    params: invalidateValidatedScenePath(node.data.params, args.nextPath),
  }))

  let resolution: Awaited<ReturnType<typeof resolveSceneSourceManifest>>
  try {
    const settings = await window.electron.settings.get()
    if (!args.isCurrent()) return
    resolution = await resolveSceneSourceManifest({
      scenePath: args.nextPath,
      workspaceDir: settings.workspaceDir,
      readFileBase64: window.electron.fs.readFileBase64,
    })
  } catch (error) {
    resolution = { ok: false, error: String(error) }
  }
  if (!args.isCurrent()) return

  args.updateNodeData(args.id, (node) => {
    const params = applySceneValidationResult(node.data.params, args.nextPath, resolution)
    return params ? { params } : {}
  })
}

export default function LoadSceneNode({ id, data, selected }: { id: string; data: WFNodeData; selected?: boolean }) {
  const { updateNodeData } = useReactFlow<WFNode>()
  const ioRowRef = useRef<HTMLDivElement>(null)
  const [handleTop, setHandleTop] = useState('50%')
  const requestEpoch = useRef(0)

  useLayoutEffect(() => () => { requestEpoch.current += 1 }, [id])

  useLayoutEffect(() => {
    if (ioRowRef.current) {
      const center = ioRowRef.current.offsetTop + ioRowRef.current.offsetHeight / 2
      setHandleTop(`${center}px`)
    }
  }, [])

  const scenePath = typeof data.params.path === 'string' ? data.params.path : ''
  const manifestPath = typeof data.params.manifestPath === 'string' ? data.params.manifestPath : undefined
  const sceneRoot = typeof data.params.sceneRoot === 'string' ? data.params.sceneRoot : undefined
  const error = typeof data.params.error === 'string' ? data.params.error : undefined

  const browse = useCallback(async (kind: 'manifest' | 'directory') => {
    const epoch = ++requestEpoch.current
    const isCurrent = () => requestEpoch.current === epoch
    try {
      const path = await (kind === 'manifest' ? window.electron.fs.selectSceneFile() : window.electron.fs.selectDirectory())
      if (!path || !isCurrent()) return
      await validateAndPersistScenePath({ id, nextPath: path, updateNodeData, isCurrent })
    } catch (error) {
      if (!isCurrent()) return
      updateNodeData(id, (node) => ({ params: { ...invalidateValidatedScenePath(node.data.params, String(node.data.params.path ?? '')), error: String(error) } }))
    }
  }, [id, updateNodeData])

  const validatePath = useCallback(async () => {
    if (!scenePath.trim()) return
    const epoch = ++requestEpoch.current
    await validateAndPersistScenePath({ id, nextPath: scenePath, updateNodeData, isCurrent: () => requestEpoch.current === epoch })
  }, [id, scenePath, updateNodeData])

  return (
    <BaseNode
      id={id}
      selected={selected}
      title="Load Scene"
      showInGenerate={data.showInGenerate ?? false}
      minWidth={220}
      icon={
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={OUTPUT_COLOR} strokeWidth="2">
          <path d="M4 7h16" />
          <path d="M7 4h10v16H7z" />
          <path d="M10 11h4" />
          <path d="M10 15h4" />
        </svg>
      }
      subheader={
        <div ref={ioRowRef} className="flex items-center justify-end px-3 py-2">
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border border-pink-500/30 bg-pink-500/10 text-pink-400">scene</span>
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
      <div className="px-3 py-2.5 flex flex-col gap-2">
        <input
          type="text"
          aria-label="Scene path"
          value={scenePath}
          placeholder="Scenes/castle or Scenes/castle/scene-manifest.json"
          onChange={(event) => {
            requestEpoch.current += 1
            const nextPath = event.target.value
            updateNodeData(id, (node) => ({ params: invalidateValidatedScenePath(node.data.params, nextPath) }))
          }}
          className="nodrag w-full rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-2 text-[10px] text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-pink-500/40"
        />
        <div className="flex gap-2">
          <button onClick={() => browse('manifest')} className="nodrag flex-1 rounded-lg border border-zinc-700 px-2 py-1.5 text-[10px] text-zinc-300 hover:border-pink-500/40 hover:bg-pink-500/5 transition-colors">
            Manifest...
          </button>
          <button onClick={() => browse('directory')} className="nodrag flex-1 rounded-lg border border-zinc-700 px-2 py-1.5 text-[10px] text-zinc-300 hover:border-pink-500/40 hover:bg-pink-500/5 transition-colors">
            Directory...
          </button>
          <button onClick={validatePath} className="nodrag rounded-lg border border-pink-500/30 bg-pink-500/10 px-2 py-1.5 text-[10px] text-pink-300 hover:bg-pink-500/15 transition-colors">
            Validate
          </button>
        </div>
        {manifestPath ? (
          <div className="rounded-lg border border-pink-500/20 bg-pink-500/5 px-2.5 py-2 text-[10px] text-zinc-300">
            <div className="text-pink-400">Manifest: {manifestPath}</div>
            {sceneRoot && <div className="text-zinc-500">sceneRoot: {sceneRoot}</div>}
          </div>
        ) : (
          <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/40 px-2.5 py-2 text-[10px] text-zinc-500">
            Loads an existing workspace scene manifest for downstream scene nodes.
          </div>
        )}
        {error && <div role="alert" className="text-[10px] text-rose-400">{error}</div>}
      </div>
    </BaseNode>
  )
}

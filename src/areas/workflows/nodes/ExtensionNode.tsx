import { useCallback, useEffect, useRef, useLayoutEffect, useState } from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'
import { useExtensionsStore } from '@shared/stores/extensionsStore'
import { buildAllWorkflowExtensions } from '../mockExtensions'
import type { ParamSchema } from '../mockExtensions'
import type { WFNodeData } from '@shared/types/electron.d'
import { getExtensionSourcePorts, getProcessTargetPorts, PROCESS_PORT_HANDLE_COLOR } from '../processPorts'
import { useWorkflowRunStore } from '../workflowRunStore'
import AdvancedOptionsSection from '../components/AdvancedOptionsSection'
import WorkflowParamControl from '../components/WorkflowParamControl'
import { partitionAdvancedParams } from '../workflowParamSchema'
import BaseNode from './BaseNode'

// ─── Handle colors ────────────────────────────────────────────────────────────

const TAG_CLS: Record<string, string> = {
  image: 'border-sky-500/30 bg-sky-500/10 text-sky-400',
  mesh:  'border-violet-500/30 bg-violet-500/10 text-violet-400',
  scene: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  text:  'border-amber-500/30 bg-amber-500/10 text-amber-400',
  audio: 'border-pink-500/30 bg-pink-500/10 text-pink-400',
  video: 'border-rose-500/30 bg-rose-500/10 text-rose-400',
}

// ─── ExtensionNode ────────────────────────────────────────────────────────────

export default function ExtensionNode({ id, data, selected }: { id: string; data: WFNodeData; selected?: boolean }) {
  const { updateNodeData } = useReactFlow()
  const running = useWorkflowRunStore((s) => s.activeNodeId === id)
  const ioRowRef = useRef<HTMLDivElement>(null)
  const [handleTop, setHandleTop] = useState('50%')

  useLayoutEffect(() => {
    if (ioRowRef.current) {
      const center = ioRowRef.current.offsetTop + ioRowRef.current.offsetHeight / 2
      setHandleTop(`${center}px`)
    }
  }, [])

  const { modelExtensions, processExtensions } = useExtensionsStore()
  const ext = buildAllWorkflowExtensions(modelExtensions, processExtensions)
    .find((e) => e.id === data.extensionId)

  const isTerminal = ext?.id === 'mesh-exporter'
  const targetPorts = ext ? getProcessTargetPorts(ext) : []
  const hasNamedTargetPorts = targetPorts.length > 1 || targetPorts.some((port) => !port.isLegacy)
  const sourcePorts = isTerminal ? [] : getExtensionSourcePorts({ output: ext?.output })
  const hasNamedSourcePorts = sourcePorts.some((port) => !port.isLegacy)
  const hasParams = (ext?.params.length ?? 0) > 0
  const paramSections = partitionAdvancedParams(ext?.params ?? [])

  const patchParam = useCallback((key: string, val: boolean | number | string) => {
    updateNodeData(id, { params: { ...data.params, [key]: val } })
  }, [id, data.params, updateNodeData])

  const paramById = new Map(ext?.params.map((p) => [p.id, p]))

  const isVisible = (param: ParamSchema): boolean => {
    if (!param.show_if) return true
    return Object.entries(param.show_if).every(([key, expected]) => {
      const current = data.params[key] ?? paramById.get(key)?.default
      return Array.isArray(expected) ? expected.includes(current as string | number) : current === expected
    })
  }
  return (
    <BaseNode
      id={id}
      selected={selected}
      running={running}
      title={ext?.name ?? data.extensionId ?? 'Unknown extension'}
      enabled={data.enabled}
      showInGenerate={data.showInGenerate ?? false}
      collapsible={hasParams}
      minWidth={200}
      subheader={
        hasNamedTargetPorts || hasNamedSourcePorts ? (
          <div ref={ioRowRef} className="flex items-start justify-between gap-3 px-3 py-2">
            <div className="min-w-0 flex-1 flex flex-col gap-1">
              {targetPorts.map((port) => (
                <div key={port.name ?? '__legacy-target'} className="flex items-center gap-1.5 min-w-0">
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border ${TAG_CLS[port.type] ?? 'border-zinc-700 bg-zinc-800 text-zinc-400'}`}>
                    {port.type}
                  </span>
                  <span className="text-[9px] text-zinc-400 truncate">{port.label ?? port.name ?? 'input'}</span>
                  {port.multiple ? (
                    <span className="text-[8px] uppercase tracking-wide text-zinc-600">{port.minItems ?? 1}–{port.maxItems ?? 10} ordered</span>
                  ) : !port.required ? (
                    <span className="text-[8px] uppercase tracking-wide text-zinc-600">optional</span>
                  ) : null}
                </div>
              ))}
            </div>
            {!isTerminal && (
              <div className="flex shrink-0 flex-col items-end gap-1 self-start pt-0.5">
                {sourcePorts.map((port) => (
                  <div key={port.name ?? '__legacy-source'} className="flex items-center justify-end gap-1.5 min-w-0">
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border ${TAG_CLS[port.type] ?? 'border-zinc-700 bg-zinc-800 text-zinc-400'}`}>
                      {port.type}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div ref={ioRowRef} className={`flex items-center px-3 py-2 ${ext?.input === 'none' ? 'justify-end' : 'justify-between'}`}>
            {ext?.input !== 'none' && (
              <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border ${TAG_CLS[ext?.input ?? ''] ?? 'border-zinc-700 bg-zinc-800 text-zinc-400'}`}>
                {ext?.input ?? '—'}
              </span>
            )}
            {!isTerminal && (
              <>
                {ext?.input !== 'none' && (
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-600 shrink-0">
                    <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
                  </svg>
                )}
                <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border ${TAG_CLS[ext?.output ?? ''] ?? 'border-zinc-700 bg-zinc-800 text-zinc-400'}`}>
                  {ext?.output ?? '—'}
                </span>
              </>
            )}
          </div>
        )
      }
      handles={<>
        {targetPorts.map((port, index) => (
          <Handle
            key={port.name ?? '__legacy-target'}
            {...(port.name ? { id: port.name } : {})}
            type="target"
            position={Position.Left}
            isConnectable={!port.multiple || (port.maxItems ?? 10) > 0}
            style={{
              background: PROCESS_PORT_HANDLE_COLOR[port.type],
              width: 14,
              height: 14,
              border: '2.5px solid #18181b',
              top: hasNamedTargetPorts ? `${((index + 1) / (targetPorts.length + 1)) * 100}%` : handleTop,
            }}
          />
        ))}
        {sourcePorts.map((port, index) => (
          <Handle
            key={port.name ?? '__legacy-source'}
            {...(port.name ? { id: port.name } : {})}
            type="source"
            position={Position.Right}
            style={{
              background: PROCESS_PORT_HANDLE_COLOR[port.type],
              width: 14,
              height: 14,
              border: '2.5px solid #18181b',
              top: hasNamedSourcePorts ? `${((index + 1) / (sourcePorts.length + 1)) * 100}%` : handleTop,
            }}
          />
        ))}
      </>}
    >
      {hasParams && (
        <div className="px-3 pb-3 pt-2.5 flex flex-col gap-2">
          {paramSections.basic.filter(isVisible).map((param) => {
            const val = (data.params[param.id] ?? param.default) as boolean | number | string
            return (
              <div key={param.id} className="flex items-start gap-2 min-w-0">
                <label className="text-[10px] text-zinc-500 w-24 shrink-0 leading-tight">{param.label}</label>
                <div className="min-w-0 flex-1">
                  <WorkflowParamControl param={param} value={val} onChange={(v) => patchParam(param.id, v)} />
                </div>
              </div>
            )
          })}
          <AdvancedOptionsSection>
            {paramSections.advanced.filter(isVisible).map((param) => {
              const val = (data.params[param.id] ?? param.default) as boolean | number | string
              return (
                <div key={param.id} className="flex items-start gap-2 min-w-0">
                  <label className="text-[10px] text-zinc-500 w-24 shrink-0 leading-tight">{param.label}</label>
                  <div className="min-w-0 flex-1">
                    <WorkflowParamControl param={param} value={val} onChange={(v) => patchParam(param.id, v)} />
                  </div>
                </div>
              )
            })}
          </AdvancedOptionsSection>
        </div>
      )}
    </BaseNode>
  )
}

import { getExtensionSourcePorts, getProcessTargetPorts } from '../processPorts'
import { useCallback, useRef, useLayoutEffect, useState } from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'
import { useExtensionsStore } from '@shared/stores/extensionsStore'
import { useNavStore } from '@shared/stores/navStore'
import { buildAllWorkflowExtensions } from '../mockExtensions'
import type { WFNodeData } from '@shared/types/electron.d'
import WorkflowParamControl from '../components/WorkflowParamControl'
import { isWorkflowParamVisible, resolveWorkflowParamValues } from '../components/workflowParamControlState'
import { isMissingWeightVariant, withWeightVariantAvailability } from '@shared/utils/weightVariants'
import { useWorkflowRunStore } from '../workflowRunStore'
import AdvancedOptionsSection from '../components/AdvancedOptionsSection'
import { partitionAdvancedParams } from '../workflowParamSchema'
import BaseNode from './BaseNode'

// ─── Handle colors ────────────────────────────────────────────────────────────

const HANDLE_COLOR: Record<string, string> = {
  audio: '#34d399',
  image: '#38bdf8',
  mesh:  '#a78bfa',
  text:  '#fbbf24',
  scene: '#f472b6',
}

const TAG_CLS: Record<string, string> = {
  audio: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  image: 'border-sky-500/30 bg-sky-500/10 text-sky-400',
  mesh:  'border-violet-500/30 bg-violet-500/10 text-violet-400',
  text:  'border-amber-500/30 bg-amber-500/10 text-amber-400',
  scene: 'border-pink-500/30 bg-pink-500/10 text-pink-400',
  video: 'border-rose-500/30 bg-rose-500/10 text-rose-400',
}

// ─── ExtensionNode ────────────────────────────────────────────────────────────

export default function ExtensionNode({ id, data, selected }: { id: string; data: WFNodeData; selected?: boolean }) {
  const { updateNodeData } = useReactFlow()
  const running = useWorkflowRunStore((s) => s.activeNodeId === id)

  const handleRefs = useRef<HTMLDivElement[]>([])
  const [handleTops, setHandleTops] = useState<string[]>([])

  const { modelExtensions, processExtensions } = useExtensionsStore()
  const installedVariants = useExtensionsStore((s) => (data.extensionId ? s.installedWeightVariants[data.extensionId] : undefined))
  const allExtensions = buildAllWorkflowExtensions(modelExtensions, processExtensions)
  const ext = allExtensions.find((e) => e.id === data.extensionId)
  const openExtension = useNavStore((s) => s.openExtension)

  const inputs = ext?.input === 'none' ? [] : getProcessTargetPorts(ext ?? { input: 'image' })
  const isMulti = inputs.length > 1 || inputs.some((port) => !port.isLegacy)
  const isTerminal  = ext?.id === 'mesh-exporter'
  const sourcePorts = isTerminal ? [] : getExtensionSourcePorts({ output: ext?.output, outputs: ext?.type === 'model' ? ext.outputs : undefined })
  const hasNamedSourcePorts = sourcePorts.some((port) => !port.isLegacy)
  const outputColor = HANDLE_COLOR[ext?.output ?? 'mesh']
  const hasParams   = (ext?.params.length ?? 0) > 0

  // Align handles with their respective IO rows after mount
  useLayoutEffect(() => {
    setHandleTops(handleRefs.current.map((ref) => {
      if (ref) {
        const center = ref.offsetTop + ref.offsetHeight / 2
        return `${center}px`
      }
      return '50%'
    }))
  }, [isMulti, inputs.length, hasNamedSourcePorts, sourcePorts.length])

  const patchParam = useCallback((key: string, val: boolean | number | string) => {
    const params = { ...data.params, [key]: val }
    updateNodeData(id, { params })
    // Push live so a paused/looping run picks up the change on the next node start.
    useWorkflowRunStore.getState().setLiveNodeParams(id, params)
  }, [id, data.params, updateNodeData])

  const resolvedParams = resolveWorkflowParamValues(ext?.params ?? [], data.params)

  const paramSections = partitionAdvancedParams((ext?.params ?? []).filter((param) => isWorkflowParamVisible(param, resolvedParams)))

  // ── IO subheader ─────────────────────────────────────────────────────────
  const ioSubheader = hasNamedSourcePorts ? (
    <div className="flex flex-col divide-y divide-zinc-800/40">
      {Array.from({ length: Math.max(inputs.length, sourcePorts.length) }, (_, i) => {
        const input = inputs[i]
        const output = sourcePorts[i]
        return (
          <div key={i} ref={(el) => { if (el) handleRefs.current[i] = el }} className="flex items-center justify-between gap-3 px-3 py-2">
            <div className="flex min-w-0 items-center gap-1.5">
              {input && (
                <>
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border ${TAG_CLS[input.type] ?? 'border-zinc-700 bg-zinc-800 text-zinc-400'}`}>
                    {ext?.inputLabels?.[i] ?? `${input.label ?? input.name ?? 'input'} (${input.type})`}
                  </span>
                  {input.multiple ? (
                    <span className="text-[8px] uppercase tracking-wide text-zinc-600">{input.minItems ?? 1}–{input.maxItems ?? 10} ordered</span>
                  ) : !input.required ? (
                    <span className="text-[8px] uppercase tracking-wide text-zinc-600">optional</span>
                  ) : null}
                </>
              )}
            </div>
            {output && (
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="text-[9px] text-zinc-400 truncate">{output.label ?? output.name}</span>
                <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border ${TAG_CLS[output.type] ?? 'border-zinc-700 bg-zinc-800 text-zinc-400'}`}>
                  {output.type}
                </span>
              </div>
            )}
          </div>
        )
      })}
    </div>
  ) : isMulti ? (
    // Multi-input layout: one row per input (N, not just 2), output on the first row.
    // Row refs feed the same handleRefs array handlesEl aligns its Handles against.
    <div className="flex flex-col divide-y divide-zinc-800/40">
      {inputs.map((inputType, i) => (
        <div key={i} ref={(el) => { if (el) handleRefs.current[i] = el }} className="flex items-center justify-between px-3 py-2">
          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border ${TAG_CLS[inputType.type] ?? 'border-zinc-700 bg-zinc-800 text-zinc-400'}`}>
            {ext?.inputLabels?.[i] ?? (inputType.isLegacy
              ? inputType.type
              : inputType.label || (typeof inputType.name === 'string' && inputType.name.trim())
                ? `${inputType.label || (typeof inputType.name === 'string' && inputType.name.trim())} (${inputType.type})`
                : inputType.type)}
          </span>
          {inputType.multiple ? (
            <span className="text-[8px] uppercase tracking-wide text-zinc-600">{inputType.minItems ?? 1}–{inputType.maxItems ?? 10} ordered</span>
          ) : !inputType.required ? (
            <span className="text-[8px] uppercase tracking-wide text-zinc-600">optional</span>
          ) : null}
          {i === 0 && !isTerminal && (
            <>
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-600 shrink-0">
                <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
              </svg>
              <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border ${TAG_CLS[ext?.output ?? ''] ?? 'border-zinc-700 bg-zinc-800 text-zinc-400'}`}>
                {ext?.output ?? '—'}
              </span>
            </>
          )}
        </div>
      ))}
    </div>
  ) : (
    // Single-input layout (existing behavior)
    <div ref={(el) => { if (el) handleRefs.current[0] = el }} className={`flex items-center px-3 py-2 ${ext?.input === 'none' ? 'justify-end' : 'justify-between'}`}>
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

  // ── Handles ──────────────────────────────────────────────────────────────
  const sourceHandlesEl = hasNamedSourcePorts ? (
    <>
      <Handle
        key="__primary-source-alias"
        type="source"
        position={Position.Right}
        isConnectable={false}
        aria-label="Primary output compatibility handle"
        style={{ background: HANDLE_COLOR[sourcePorts[0].type], width: 8, height: 8, border: '2px solid #18181b', top: handleTops[0] ?? '50%', opacity: 0, pointerEvents: 'none' }}
      />
      {!sourcePorts.some((port) => port.name === 'output') && (
        <Handle
          id="output"
          type="source"
          position={Position.Right}
          isConnectable={false}
          aria-label="Legacy primary output compatibility handle"
          style={{ background: HANDLE_COLOR[sourcePorts[0].type], width: 8, height: 8, border: '2px solid #18181b', top: handleTops[0] ?? '50%', opacity: 0, pointerEvents: 'none' }}
        />
      )}
      {sourcePorts.map((port, index) => (
        <Handle
          key={port.name ?? '__legacy-source'}
          {...(port.name ? { id: port.name } : {})}
          type="source"
          position={Position.Right}
          style={{ background: HANDLE_COLOR[port.type], width: 14, height: 14, border: '2.5px solid #18181b', top: handleTops[index] ?? '50%' }}
        />
      ))}
    </>
  ) : !isTerminal ? (
    <Handle
      id="output"
      type="source"
      position={Position.Right}
      style={{ background: outputColor, width: 14, height: 14, border: '2.5px solid #18181b', top: handleTops[0] ?? '50%' }}
    />
  ) : null
  const handlesEl = isMulti ? (
    <>
      {inputs.map((inputType, i) => (
        <Handle
          key={i}
          id={inputType.name ?? `input-${i}`}
          type="target"
          position={Position.Left}
          isConnectable={!inputType.multiple || (inputType.maxItems ?? 10) > 0}
          style={{ background: HANDLE_COLOR[inputType.type], width: 14, height: 14, border: '2.5px solid #18181b', top: handleTops[i] ?? '50%' }}
        />
      ))}
      {sourceHandlesEl}
    </>
  ) : (
    <>
      {ext?.input !== 'none' && (
      <Handle
        id="input-0"
        type="target"
        position={Position.Left}
        style={{ background: HANDLE_COLOR[ext?.input ?? 'image'], width: 14, height: 14, border: '2.5px solid #18181b', top: handleTops[0] ?? '50%' }}
      />
      )}
      {sourceHandlesEl}
    </>
  )

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
      subheader={ioSubheader}
      handles={handlesEl}
    >
      {hasParams && (
        <div className="px-3 pb-3 pt-2.5 flex flex-col gap-2">
          {[paramSections.basic, paramSections.advanced].map((params, section) => {
            const controls = params.map((param) => {
              const val = (data.params[param.id] ?? param.default) as boolean | number | string
              return (
                <div key={JSON.stringify([id, data.extensionId, param.id])} className="flex items-start gap-2 min-w-0">
                  <label className="text-[10px] text-zinc-500 w-24 shrink-0 leading-tight">{param.label}</label>
                  <div className="min-w-0 flex-1">
                    <WorkflowParamControl
                      param={withWeightVariantAvailability(param, ext?.weightVariants, installedVariants)}
                      value={val}
                      onChange={(v) => patchParam(param.id, v)}
                      resolvedParams={resolvedParams}
                    />
                    {/* Offer the install instead of leaving the graph on selection. */}
                    {ext && isMissingWeightVariant(param.id, val, ext.weightVariants, installedVariants) && (
                      <button
                        onClick={() => openExtension(ext.extensionId)}
                        className="nodrag mt-1 text-[10px] text-amber-400 hover:text-amber-300 hover:underline"
                      >
                        Not installed — install it
                      </button>
                    )}
                  </div>
                </div>
              )
            })
            return section === 0 ? controls : <AdvancedOptionsSection key="advanced">{controls}</AdvancedOptionsSection>
          })}
        </div>
      )}
    </BaseNode>
  )
}

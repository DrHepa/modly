import { useEffect, useState } from 'react'

import type { FileSelectParamSchema, ParamSchema } from '@shared/types/electron.d'
import { FloatInput, IntInput } from '@shared/components/ui/NumberInput'
import { PickerIcon } from '@shared/components/ui/PickerIcon'
import { PICKER_LABELS, resolvePickerIntent } from '@shared/utils/paramPicker'

import {
  resolveBooleanParamValue,
  selectWorkflowParamPath,
  toggleBooleanParamValue,
  type WorkflowParamValue,
} from './workflowParamControlState'

type WorkflowParamControlProps = {
  param: ParamSchema
  value: WorkflowParamValue
  onChange: (value: WorkflowParamValue) => void
  resolvedParams?: Record<string, unknown>
}

// nodrag/nowheel keeps editing and dropdown scrolling independent of the canvas.
const INPUT_CLASS_NAME = 'nodrag nowheel w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1 text-[11px] text-zinc-200 focus:outline-none focus:border-accent/60'
const PICKER_BUTTON_CLASS_NAME = 'nodrag shrink-0 flex items-center justify-center w-6 h-6 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200 transition-colors focus-visible:outline focus-visible:outline-accent disabled:opacity-50 disabled:cursor-not-allowed'
const TOGGLE_TRACK_CLASS_NAME = 'relative h-4 w-7 shrink-0 rounded-full transition-colors'
const TOGGLE_THUMB_CLASS_NAME = 'absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform'

/** Shared directory-dependent dropdown; a saved missing filename remains visible. */
function FileSelectControl({ param, value, dirValue, onChange }: {
  param: FileSelectParamSchema
  value: string
  dirValue: string
  onChange: (value: string) => void
}) {
  const [files, setFiles] = useState<string[]>([])
  const extensionsKey = JSON.stringify(param.extensions ?? null)
  useEffect(() => {
    let alive = true
    setFiles([])
    if (!dirValue) return
    const extensions: string[] | null = JSON.parse(extensionsKey)
    window.electron.fs.listFiles(dirValue, extensions ?? undefined).then((list) => {
      if (alive) setFiles(list)
    }).catch(() => { if (alive) setFiles([]) })
    return () => { alive = false }
  }, [dirValue, extensionsKey])

  return (
    <select aria-label={param.label} value={value} disabled={!dirValue} onChange={(event) => onChange(event.target.value)}
      className={`${INPUT_CLASS_NAME} ${!dirValue ? 'opacity-50 cursor-not-allowed' : ''}`}>
      <option value="">{!dirValue ? 'Pick a folder first…' : files.length === 0 ? 'No files found' : 'Select…'}</option>
      {value && !files.includes(value) && <option value={value}>{value} (missing)</option>}
      {files.map((file) => <option key={file} value={file}>{file}</option>)}
    </select>
  )
}

export default function WorkflowParamControl({ param, value, onChange, resolvedParams = {} }: WorkflowParamControlProps) {
  if (param.type === 'file-select') {
    return <FileSelectControl param={param} value={String(value ?? '')}
      dirValue={String(resolvedParams[param.dir_from ?? ''] ?? '')} onChange={onChange} />
  }

  if (param.type === 'select') {
    return (
      <select aria-label={param.label} value={String(value)} onChange={(event) => onChange(event.target.value)} className={INPUT_CLASS_NAME}>
        {param.options?.map((option) => (
          <option key={String(option.value)} value={option.value}>{option.label ?? String(option.value)}</option>
        ))}
      </select>
    )
  }

  if (param.type === 'string') {
    const textValue = typeof value === 'string' ? value : String(value ?? '')
    const intent = param.pickerIntent ?? param.picker_intent
    const pickerAvailable = intent !== 'generic-file'
    const pickerLabel = intent === 'save-path' ? 'Choose save path' : PICKER_LABELS[resolvePickerIntent(param)]

    return (
      <div className="flex items-center gap-1">
        <input type="text" aria-label={param.label} value={textValue} placeholder={param.tooltip ?? ''}
          title={!pickerAvailable ? 'Enter a file path; generic file browsing is unavailable' : param.tooltip}
          onChange={(event) => onChange(event.target.value)} className={`${INPUT_CLASS_NAME} flex-1`} />
        {pickerAvailable && <button type="button" title={pickerLabel} aria-label={pickerLabel}
          className={PICKER_BUTTON_CLASS_NAME}
          onClick={async () => {
            if (!pickerAvailable) return
            const selectedPath = await selectWorkflowParamPath(window.electron.fs, param, textValue)
            if (selectedPath) onChange(selectedPath)
          }}>
          <PickerIcon intent={resolvePickerIntent(param)} />
        </button>}
      </div>
    )
  }

  if (param.type === 'float') {
    return <FloatInput value={typeof value === 'number' || typeof value === 'string' ? value : param.default} onChange={onChange} className={INPUT_CLASS_NAME}
        min={param.min} max={param.max} step={param.step} label={param.label} />
  }

  if (param.type === 'int') {
    return <IntInput value={typeof value === 'number' || typeof value === 'string' ? value : param.default} onChange={onChange} className={INPUT_CLASS_NAME} label={param.label} />
  }

  if (param.type === 'boolean') {
    const checked = resolveBooleanParamValue(param, value)
    return (
      <button type="button" role="switch" aria-label={param.label} aria-checked={checked}
        onClick={() => onChange(toggleBooleanParamValue(param, value))}
        className="nodrag flex min-h-6 items-center gap-2 text-left rounded focus-visible:outline focus-visible:outline-accent">
        <span className={`${TOGGLE_TRACK_CLASS_NAME} ${checked ? 'bg-accent/70' : 'bg-zinc-700'}`}>
          <span className={`${TOGGLE_THUMB_CLASS_NAME} ${checked ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
        </span>
        <span className="text-[10px] text-zinc-400">{checked ? 'Enabled' : 'Disabled'}</span>
      </button>
    )
  }

  return <div className="rounded-lg border border-dashed border-zinc-700 px-2 py-1.5 text-[10px] text-zinc-500">{param.reason}</div>
}

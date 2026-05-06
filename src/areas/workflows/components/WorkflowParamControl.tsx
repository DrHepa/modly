import { useRef, useState } from 'react'

import type { ParamSchema } from '@shared/types/electron.d'

import {
  isPickerEnabled,
  isPromptLikeStringParam,
  resolveBooleanParamValue,
  resolveStringParamEditorState,
  selectWorkflowParamPath,
  stopControlDragPropagation,
  toggleBooleanParamValue,
  type WorkflowParamValue,
} from './workflowParamControlState'

type WorkflowParamControlProps = {
  param: ParamSchema
  value: WorkflowParamValue
  onChange: (value: WorkflowParamValue) => void
}

const INPUT_CLASS_NAME = 'nodrag w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1 text-[11px] text-zinc-200 focus:outline-none focus:border-accent/60'
const TEXTAREA_CLASS_NAME = 'nodrag w-full min-h-[4.5rem] bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-[11px] text-zinc-200 leading-relaxed focus:outline-none focus:border-accent/60 resize-y overflow-auto'
const PICKER_BUTTON_CLASS_NAME = 'nodrag shrink-0 flex items-center justify-center w-6 h-6 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-zinc-700 disabled:hover:text-zinc-400'
const STRING_MODE_BUTTON_CLASS_NAME = 'nodrag self-start rounded px-1.5 py-0.5 text-[9px] font-medium text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors'
const TOGGLE_TRACK_CLASS_NAME = 'relative h-4 w-7 shrink-0 rounded-full transition-colors'
const TOGGLE_THUMB_CLASS_NAME = 'absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform'

function IntInput({ value, onChange, className }: { value: number; onChange: (value: number) => void; className: string }) {
  const [text, setText] = useState(String(value))
  const prevValue = useRef(value)

  if (prevValue.current !== value && parseInt(text, 10) !== value) {
    prevValue.current = value
    setText(String(value))
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      value={text}
      onChange={(event) => {
        const raw = event.target.value
        if (raw !== '' && raw !== '-' && !/^-?\d+$/.test(raw)) return
        setText(raw)
        const nextValue = parseInt(raw, 10)
        if (!Number.isNaN(nextValue)) {
          prevValue.current = nextValue
          onChange(nextValue)
        }
      }}
      className={className}
      onPointerDown={stopControlDragPropagation}
      onMouseDown={stopControlDragPropagation}
    />
  )
}

function FloatInput({ value, onChange, className }: { value: number; onChange: (value: number) => void; className: string }) {
  const [text, setText] = useState(String(value))
  const prevValue = useRef(value)

  if (prevValue.current !== value && parseFloat(text.replace(',', '.')) !== value) {
    prevValue.current = value
    setText(String(value))
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      onChange={(event) => {
        const raw = event.target.value.replace(',', '.')
        if (raw !== '' && raw !== '-' && raw !== '.' && !/^-?\d*\.?\d*$/.test(raw)) return
        setText(event.target.value)
        const nextValue = parseFloat(raw)
        if (!Number.isNaN(nextValue)) {
          prevValue.current = nextValue
          onChange(nextValue)
        }
      }}
      className={className}
      onPointerDown={stopControlDragPropagation}
      onMouseDown={stopControlDragPropagation}
    />
  )
}

function renderPickerIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
    </svg>
  )
}

export default function WorkflowParamControl({ param, value, onChange }: WorkflowParamControlProps) {
  const [stringExpanded, setStringExpanded] = useState(false)
  const [stringCollapsed, setStringCollapsed] = useState(false)

  if (param.type === 'select') {
    return (
      <select
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
        className={INPUT_CLASS_NAME}
        onPointerDown={stopControlDragPropagation}
        onMouseDown={stopControlDragPropagation}
      >
        {param.options?.map((option) => (
          <option key={String(option.value)} value={option.value}>{option.label ?? String(option.value)}</option>
        ))}
      </select>
    )
  }

  if (param.type === 'string') {
    const editorState = resolveStringParamEditorState(param, value, stringExpanded)
    const textValue = editorState.value
    const promptLike = isPromptLikeStringParam(param)
    const isMultiline = promptLike && stringCollapsed ? false : editorState.mode === 'multiline'
    const pickerAvailable = !isPickerEnabled(param) || param.pickerIntent !== 'generic-file'

    return (
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start gap-1 min-w-0">
          {isMultiline ? (
            <textarea
              value={textValue}
              placeholder={param.tooltip ?? ''}
              rows={promptLike ? 3 : 4}
              onChange={(event) => onChange(event.target.value)}
              className={`${TEXTAREA_CLASS_NAME} flex-1`}
              onPointerDown={stopControlDragPropagation}
              onMouseDown={stopControlDragPropagation}
            />
          ) : (
            <input
              type="text"
              value={textValue}
              placeholder={param.tooltip ?? ''}
              onChange={(event) => onChange(event.target.value)}
              className={`${INPUT_CLASS_NAME} flex-1`}
              onPointerDown={stopControlDragPropagation}
              onMouseDown={stopControlDragPropagation}
            />
          )}

          {isPickerEnabled(param) && (
            <button
              type="button"
              onPointerDown={stopControlDragPropagation}
              onMouseDown={stopControlDragPropagation}
              onClick={async () => {
                if (!pickerAvailable) return
                const selectedPath = await selectWorkflowParamPath(window.electron.fs, param, textValue)
                if (selectedPath) onChange(selectedPath)
              }}
              className={PICKER_BUTTON_CLASS_NAME}
              title={param.pickerIntent === 'generic-file'
                ? 'Generic file picker is not available yet'
                : param.pickerIntent === 'save-path'
                  ? 'Choose save path'
                  : 'Browse path'}
              disabled={!pickerAvailable}
            >
              {renderPickerIcon()}
            </button>
          )}
        </div>

        <button
          type="button"
          onPointerDown={stopControlDragPropagation}
          onMouseDown={stopControlDragPropagation}
          onClick={() => {
            if (promptLike) {
              setStringCollapsed((collapsed) => !collapsed)
              return
            }
            setStringExpanded((expanded) => !expanded)
          }}
          className={STRING_MODE_BUTTON_CLASS_NAME}
        >
          {isMultiline ? 'Collapse' : 'Expand'}
        </button>
      </div>
    )
  }

  if (param.type === 'float') {
    return <FloatInput value={typeof value === 'number' ? value : param.default} onChange={onChange} className={INPUT_CLASS_NAME} />
  }

  if (param.type === 'int') {
    return <IntInput value={typeof value === 'number' ? value : param.default} onChange={onChange} className={INPUT_CLASS_NAME} />
  }

  if (param.type === 'boolean') {
    const checked = resolveBooleanParamValue(param, value)

    return (
      <button
        type="button"
        onPointerDown={stopControlDragPropagation}
        onMouseDown={stopControlDragPropagation}
        onClick={() => onChange(toggleBooleanParamValue(param, value))}
        className="nodrag flex items-center gap-2 text-left"
      >
        <span className={`${TOGGLE_TRACK_CLASS_NAME} ${checked ? 'bg-accent/70' : 'bg-zinc-700'}`}>
          <span className={`${TOGGLE_THUMB_CLASS_NAME} ${checked ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
        </span>
        <span className="text-[10px] text-zinc-400">{checked ? 'Enabled' : 'Disabled'}</span>
      </button>
    )
  }

  return (
    <div className="rounded-lg border border-dashed border-zinc-700 px-2 py-1.5 text-[10px] text-zinc-500">
      {param.reason}
    </div>
  )
}

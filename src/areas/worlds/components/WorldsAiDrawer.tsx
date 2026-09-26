import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import ChatPanel from '../../generate/components/ChatPanel.tsx'
import { Tooltip } from '../../../shared/components/ui/Tooltip.tsx'
import type { WorldAiChatAdapter } from '../editor/worldAiChatAdapter.ts'

/** The assistant edits the current scene through the guarded command bus; it has no separate review dock. */
export default function WorldsAiDrawer({ adapter, disabled, canUndo }: {
  adapter: WorldAiChatAdapter; disabled: boolean; canUndo: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const state = useSyncExternalStore(adapter.subscribe, adapter.getState, adapter.getState)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const statusRef = useRef<HTMLParagraphElement>(null)
  const pending = state.status === 'loading' || state.status === 'previewing' || state.status === 'applying' || state.status === 'undoing'
  const barMessage = state.status === 'applied' ? 'Saved' : state.message

  useEffect(() => {
    if (state.status === 'error' || state.status === 'stale') statusRef.current?.focus()
  }, [state.status])

  const toggle = () => {
    if (open && pending) adapter.cancel()
    setOpen(!open)
    if (open) toggleRef.current?.focus()
  }

  return <section className="worlds-ai-drawer" aria-label="Worlds AI">
    <header className="worlds-ai-drawer__bar">
      <Tooltip content="Ask about the open scene or make a change. Changes use the World history.">
        <button ref={toggleRef} type="button" aria-expanded={open} aria-controls="worlds-ai-content" onClick={toggle}>
          AI <span aria-hidden="true">{open ? '▾' : '▴'}</span>
        </button>
      </Tooltip>
      <span className="worlds-ai-drawer__hint">Scene assistant</span>
      {barMessage && state.status !== 'ready' ? <p ref={statusRef} className="worlds-ai-drawer__status" tabIndex={-1}
        role={state.status === 'error' ? 'alert' : 'status'} aria-live="polite">{barMessage}</p> : null}
      {state.status === 'applied' && canUndo ? <Tooltip content="Undo the assistant's last World command.">
        <button type="button" aria-label="Undo AI change" disabled={disabled} onClick={() => { void adapter.undo() }}>Undo</button>
      </Tooltip> : null}
    </header>
    {open ? <div id="worlds-ai-content" className="worlds-ai-drawer__content" aria-busy={pending}>
      <div className="worlds-ai-drawer__chat"><ChatPanel worlds={adapter} /></div>
    </div> : null}
  </section>
}

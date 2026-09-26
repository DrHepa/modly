import { useEffect, useState } from 'react'

import { useAgentSessionsStore } from '@shared/stores/agentSessionsStore'

export default function AgentSessionHistory({ worlds = false }: { worlds?: boolean }): JSX.Element {
  const sessions = useAgentSessionsStore((state) => state.sessions)
  const activeSession = useAgentSessionsStore((state) => state.activeSession)
  const readOnly = useAgentSessionsStore((state) => state.readOnly)
  const createSession = useAgentSessionsStore((state) => state.createSession)
  const switchSession = useAgentSessionsStore((state) => state.switchSession)
  const renameSession = useAgentSessionsStore((state) => state.renameSession)
  const deleteSession = useAgentSessionsStore((state) => state.deleteSession)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [title, setTitle] = useState('')

  useEffect(() => {
    if (editingSessionId && activeSession?.id !== editingSessionId) setEditingSessionId(null)
  }, [activeSession?.id, editingSessionId])

  return (
    <details className="shrink-0 border-b border-zinc-800 px-3 py-2">
      <summary className="cursor-pointer select-none text-[11px] text-zinc-400">
        {activeSession?.title ?? (readOnly ? 'Chat history unavailable' : 'Chat history')}
      </summary>
      <div className="mt-2 flex flex-col gap-1.5">
        {readOnly && <p className="text-[10px] text-amber-400">Created by a newer Modly version. History is read-only.</p>}
        {!readOnly && (
          <button className={`self-start text-[10px] ${worlds ? 'text-accent-light' : 'text-accent'} hover:text-accent-light`} onClick={() => void createSession()}>
            New chat
          </button>
        )}
        {sessions.map((session) => (
          <div key={session.id} className="flex items-center gap-1">
            <button
              className={`min-w-0 flex-1 truncate text-left text-[10px] ${session.id === activeSession?.id ? 'text-zinc-100' : worlds ? 'text-zinc-300 hover:text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
              onClick={() => void switchSession(session.id)}
            >
              {session.title}
            </button>
            {!readOnly && session.id === activeSession?.id && (
              <>
                <button
                  className={`text-[9px] ${worlds ? 'text-zinc-300 hover:text-zinc-100' : 'text-zinc-600 hover:text-zinc-300'}`}
                  onClick={() => { setTitle(session.title); setEditingSessionId(session.id) }}
                >Rename</button>
                <button className={`text-[9px] ${worlds ? 'text-zinc-300 hover:text-red-300' : 'text-zinc-600 hover:text-red-400'}`} onClick={() => void deleteSession(session.id)}>Delete</button>
              </>
            )}
          </div>
        ))}
        {editingSessionId && (
          <form
            className="flex gap-1"
            onSubmit={(event) => {
              event.preventDefault()
              if (!title.trim()) return
              void renameSession(editingSessionId, title.trim()).then(() => setEditingSessionId(null))
            }}
          >
            <input autoFocus maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} className="min-w-0 flex-1 rounded bg-zinc-900 px-2 py-1 text-[10px] text-zinc-200 outline-none" />
            <button className={`text-[10px] ${worlds ? 'text-accent-light' : 'text-accent'}`} type="submit">Save</button>
            <button className={`text-[10px] ${worlds ? 'text-zinc-300' : 'text-zinc-500'}`} type="button" onClick={() => setEditingSessionId(null)}>Cancel</button>
          </form>
        )}
      </div>
    </details>
  )
}

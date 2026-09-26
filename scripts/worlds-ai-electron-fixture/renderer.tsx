import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import WorldsAiDrawer from '../../src/areas/worlds/components/WorldsAiDrawer.tsx'
import { createWorldEditorController } from '../../src/areas/worlds/editor/worldEditorController.ts'
import { createWorldEditorCommandPort } from '../../src/areas/worlds/editor/worldEditorCommandPort.ts'
import { createWorldAiChatAdapter } from '../../src/areas/worlds/editor/worldAiChatAdapter.ts'
import { useWorldEditorController } from '../../src/areas/worlds/editor/useWorldEditorController.ts'
import { createWorldProjectService } from '../../src/areas/worlds/worldProjectService.ts'
import { useAppStore } from '../../src/shared/stores/appStore.ts'
import { useAgentStore } from '../../src/shared/stores/agentStore.ts'
import { useAgentSessionsStore } from '../../src/shared/stores/agentSessionsStore.ts'
import { requireEphemeralOrigin, STUB_MODEL, type FixtureConfig, type FixtureView, type TraceEntry } from './shared.ts'
import './styles.css'
import '../../src/areas/worlds/WorldsWorkbench.css'

const bridge = Reflect.get(window, 'worldsAiFixture') as { getConfig(): Promise<FixtureConfig>; environment: FixtureView['environment'] }
const controller = createWorldEditorController(createWorldProjectService())
// This fixture has no Play lifecycle; its scope is explicitly Edit-only.
const adapter = createWorldAiChatAdapter(createWorldEditorCommandPort(controller), () => true, { autoApply: true })
const bootId = crypto.randomUUID()

function Fixture(): JSX.Element {
  const editor = useWorldEditorController(controller)
  const ai = useSyncExternalStore(adapter.subscribe, adapter.getState, adapter.getState)
  const session = useAgentSessionsStore((state) => state.activeSession)
  const initialized = useAgentSessionsStore((state) => state.initialized)
  const [observation, setObservation] = useState<{ trace: TraceEntry[]; untrusted: number }>({ trace: [], untrusted: 0 })
  const sequence = useRef(0)
  useEffect(() => {
    let pending: TraceEntry[] = []; let untrusted = 0; let timer: number | undefined
    const record = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null
      pending.push({ sequence: ++sequence.current, type: event.type, trusted: event.isTrusted,
        key: event instanceof KeyboardEvent ? event.key : null,
        label: target?.getAttribute('aria-label') ?? target?.textContent?.trim().slice(0, 80) ?? '', tag: target?.tagName ?? '' })
      if (!event.isTrusted) untrusted += 1
      // Defer React observation updates until controlled-input bubble handlers finish.
      if (timer === undefined) timer = window.setTimeout(() => {
        const entries = pending; const count = untrusted; pending = []; untrusted = 0; timer = undefined
        setObservation((value) => ({ trace: [...value.trace, ...entries].slice(-200), untrusted: value.untrusted + count }))
      }, 0)
    }
    const kinds = ['pointerdown', 'keydown', 'keypress', 'keyup', 'click', 'input', 'focusin']
    for (const kind of kinds) document.addEventListener(kind, record, true)
    return () => { for (const kind of kinds) document.removeEventListener(kind, record, true); if (timer !== undefined) window.clearTimeout(timer) }
  }, [])
  const view: FixtureView = {
    bootId, environment: bridge.environment, requireType: typeof Reflect.get(window, 'require'), processType: typeof Reflect.get(window, 'process'),
    initializing: editor.initializing, error: editor.initializationError ?? editor.state.error?.message ?? null,
    snapshot: editor.state.session?.snapshot ?? null, ai, sessionId: session?.id ?? null, sessionInitialized: initialized,
    messages: session?.messages.map(({ id, role, content }) => ({ id, role, content })) ?? [], ...observation,
  }
  return <main className="ai-fixture">
    <h1>Worlds AI · isolated native fixture</h1>
    <p>Deterministic provider STUB. Actual chat, query transport and direct durable scene edits. No live model, full Workbench, Play or screen-reader claim.</p>
    <section aria-label="Saved World"><h2>{view.snapshot?.project.name ?? 'Opening World…'}</h2>
      <p>Saved revision: {view.snapshot?.project.revision ?? '—'}</p>
      <ul>{view.snapshot?.scenes[0]?.entities.map((entity) => <li key={entity.id}>{entity.name}</li>)}</ul>
    </section>
    {view.error ? <p role="alert">{view.error}</p> : null}
    {view.snapshot && editor.state.projectKey && editor.state.activeSceneId ? <WorldsAiDrawer
      adapter={adapter} disabled={editor.initializing} canUndo={editor.state.canUndo} /> : null}
    <output id="worlds-ai-fixture-state" hidden>{JSON.stringify(view)}</output>
  </main>
}

void bridge.getConfig().then((config) => {
  const origin = requireEphemeralOrigin(config.apiOrigin)
  useAppStore.setState({ apiUrl: origin })
  useAgentStore.getState().setOllamaUrl(origin)
  useAgentStore.getState().setDefaultModel(STUB_MODEL)
  useAgentStore.getState().setDefaultThinking('off')
  const root = document.getElementById('root')
  if (!root) throw new Error('Fixture root is missing.')
  createRoot(root).render(<Fixture />)
}).catch((error: unknown) => { console.error(error); document.getElementById('root')!.textContent = 'Fixture initialization failed.' })

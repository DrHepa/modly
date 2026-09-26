import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import WorldsInspector from '../../src/areas/worlds/components/WorldsInspector.tsx'
import WorldsProjectBar from '../../src/areas/worlds/components/WorldsProjectBar.tsx'
import { createWorldEditorController, type WorldEditorControllerResult } from '../../src/areas/worlds/editor/worldEditorController.ts'
import { useWorldEditorController } from '../../src/areas/worlds/editor/useWorldEditorController.ts'
import { createWorldProjectService } from '../../src/areas/worlds/worldProjectService.ts'
import { trapWorldsOverlayFocus } from '../../src/areas/worlds/editor/worldsOverlayFocus.ts'
import { describeFixtureControl } from './domEvidence.ts'
import { FIXTURE_PROJECT_KEY, FIXTURE_TARGET_NAME, type FixtureEnvironment, type FixtureInputEvidence, type FixtureTraceEvent, type FixtureView } from './shared.ts'
import '../../src/areas/worlds/WorldsWorkbench.css'
import './styles.css'

const controller = createWorldEditorController(createWorldProjectService())
const bootId = crypto.randomUUID()
const environment = Reflect.get(window, 'worldsFixtureEnvironment') as FixtureEnvironment

function CharacterFixture(): JSX.Element {
  const editor = useWorldEditorController(controller)
  const { state } = editor
  const [error, setError] = useState<string | null>(null)
  const [projectPickerKey, setProjectPickerKey] = useState(FIXTURE_PROJECT_KEY)
  const [inputs, setInputs] = useState<FixtureInputEvidence>({ pointerdown: 0, keydown: 0, input: 0, change: 0, untrusted: 0 })
  const [trace, setTrace] = useState<FixtureTraceEvent[]>([])
  const [cancelledEnterClicks, setCancelledEnterClicks] = useState(0)
  const eventSequence = useRef(0)
  const snapshot = state.session?.snapshot ?? null
  const projectKey = state.projectKey
  const scene = snapshot?.scenes.find((item) => item.sceneId === state.activeSceneId)
  const target = scene?.entities.find((entity) => entity.name === FIXTURE_TARGET_NAME)

  useEffect(() => {
    const emptyCounts = (): FixtureInputEvidence => ({ pointerdown: 0, keydown: 0, input: 0, change: 0, untrusted: 0 })
    let pendingCounts = emptyCounts()
    let pending: Array<{ event: Event; entry: FixtureTraceEvent }> = []
    let flushTimer: number | null = null
    const flush = () => {
      const counts = pendingCounts
      pendingCounts = emptyCounts()
      const completed = pending.map(({ event, entry }) => ({ ...entry, defaultPrevented: event.defaultPrevented }))
      pending = []
      flushTimer = null
      setInputs((current) => ({
        pointerdown: current.pointerdown + counts.pointerdown, keydown: current.keydown + counts.keydown,
        input: current.input + counts.input, change: current.change + counts.change,
        untrusted: current.untrusted + counts.untrusted,
      }))
      setTrace((current) => [...current, ...completed].slice(-200))
    }
    const record = (event: Event) => {
      if (event.type === 'pointerdown' || event.type === 'keydown' || event.type === 'input' || event.type === 'change') {
        pendingCounts[event.type] += 1
      }
      if (!event.isTrusted) pendingCounts.untrusted += 1
      const entry: FixtureTraceEvent = {
        sequence: ++eventSequence.current, type: event.type, trusted: event.isTrusted,
        key: event instanceof KeyboardEvent ? event.key : null,
        code: event instanceof KeyboardEvent ? event.code : null,
        charCode: event instanceof KeyboardEvent ? event.charCode : null,
        defaultPrevented: event.defaultPrevented,
        inputType: event instanceof InputEvent ? event.inputType : null,
        data: event instanceof InputEvent ? event.data : null,
        target: describeFixtureControl(event.target instanceof Element ? event.target : null),
        active: describeFixtureControl(document.activeElement),
      }
      pending = [...pending.slice(-199), { event, entry }]
      // Capture only plain data: React updates here can restore a controlled input
      // before its bubble change handler. Flush both observers in a later task.
      if (flushTimer === null) flushTimer = window.setTimeout(flush, 0)
    }
    const kinds = ['pointerdown', 'keydown', 'keypress', 'keyup', 'click', 'beforeinput', 'input', 'change', 'focusin', 'focusout'] as const
    for (const kind of kinds) document.addEventListener(kind, record, true)
    return () => {
      for (const kind of kinds) document.removeEventListener(kind, record, true)
      if (flushTimer !== null) window.clearTimeout(flushTimer)
      pending = []
      pendingCounts = emptyCounts()
    }
  }, [])

  const run = async (operation: Promise<WorldEditorControllerResult<unknown>>) => {
    setError(null)
    try {
      const result = await operation
      if (!result.ok) setError(result.error.message)
    } catch (caught) { setError(String(caught)) }
  }
  const unavailable = () => setError('This isolated fixture only covers character authoring, project opening, Undo and Redo.')
  const publicError = error ?? editor.initializationError ?? state.error?.message ?? null
  const view: FixtureView = {
    bootId, environment,
    requireType: typeof Reflect.get(window, 'require'), processType: typeof Reflect.get(window, 'process'),
    initializing: editor.initializing, lifecycle: state.lifecycle, error: publicError,
    projectKey: state.projectKey, activeSceneId: state.activeSceneId, savedRevision: state.savedRevision,
    canUndo: state.canUndo, canRedo: state.canRedo, cancelledEnterClicks, snapshot, inputs, trace,
  }
  return <main className="character-fixture">
    <h1>Worlds character authoring fixture</h1>
    <p>Isolated source-level interaction check. Play and packaged-app acceptance are not covered.</p>
    <WorldsProjectBar
      projects={state.projects} projectKey={state.projectKey} projectPickerKey={projectPickerKey}
      scenes={snapshot?.project.scenes ?? []} activeSceneId={state.activeSceneId}
      saveStatus={publicError ? 'error' : state.lifecycle === 'loading' ? 'saving' : 'saved'}
      canUndo={state.canUndo} canRedo={state.canRedo} selectionCount={target ? 1 : 0}
      busy={editor.initializing || state.lifecycle === 'loading'} playState="edit" canPlay={false}
      onProjectPickerKey={setProjectPickerKey} onOpenProject={() => { void run(editor.openProject(projectPickerKey)) }}
      onNewProject={unavailable} onScene={(id) => { void run(editor.setActiveScene(id)) }} onAddScene={unavailable}
      onUndo={() => { void run(controller.undo()) }} onRedo={() => { void run(controller.redo()) }}
      onDuplicate={unavailable} onDelete={unavailable} onLegacyExport={unavailable} onRecoverConflict={unavailable}
      onPlayIntent={unavailable} onPlay={unavailable} onPause={unavailable} onResume={unavailable} onStop={unavailable} onDock={unavailable}
    />
    <button type="button" aria-label="Cancelled Enter probe"
      onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault() }}
      onClick={() => setCancelledEnterClicks((count) => count + 1)}>
      Enter cancellation check
    </button>
    {publicError ? <p role="alert">{publicError}</p> : null}
    {snapshot && scene && target && projectKey ? <div className="character-fixture__inspector" role="dialog" aria-label="Isolated Inspector keyboard check"
      onKeyDown={(event) => { if (event.key === 'Tab') trapWorldsOverlayFocus(event) }}>
      <WorldsInspector
        projectKey={projectKey} snapshot={snapshot} scene={scene} selectedEntityIds={[target.id]} activeEntityId={target.id}
        snapEnabled={false} snapIncrement={0.5} onSnap={unavailable} onError={setError}
        onCommands={(commands, scope) => { void run(editor.dispatchUiCommands(commands, scope, {
          projectKey, projectId: snapshot.project.projectId,
          baseRevision: snapshot.project.revision, activeSceneId: scene.sceneId,
        })) }}
      />
    </div> : <p role="status">Opening isolated World project…</p>}
    <output id="fixture-state" hidden>{JSON.stringify(view)}</output>
  </main>
}

const root = document.getElementById('root')
if (!root) throw new Error('Fixture root is missing.')
createRoot(root).render(<CharacterFixture />)

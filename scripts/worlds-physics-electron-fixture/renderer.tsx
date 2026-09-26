import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import WorldsProjectBar from '../../src/areas/worlds/components/WorldsProjectBar.tsx'
import WorldRuntimeViewport from '../../src/areas/worlds/components/WorldRuntimeViewport.tsx'
import { createWorldViewportRecovery, WorldViewportBoundary, type WorldViewportFailure } from '../../src/areas/worlds/components/WorldViewportBoundary.tsx'
import { createWorldEditorController } from '../../src/areas/worlds/editor/worldEditorController.ts'
import { useWorldEditorController } from '../../src/areas/worlds/editor/useWorldEditorController.ts'
import { buildWorldGraphicsProfileSelectionCommands, type WorldGraphicsProfileChoice } from '../../src/areas/worlds/editor/worldGraphicsProfileCommands.ts'
import { createWorldProjectService } from '../../src/areas/worlds/worldProjectService.ts'
import { createWorldPlayController, type WorldPlayControllerResult } from '../../src/areas/worlds/runtime/worldPlayController.ts'
import { createBrowserWorldPhysicsRuntime } from '../../src/areas/worlds/runtime/worldPhysicsRuntime.ts'
import { createBrowserWorldAudioAuthority } from '../../src/areas/worlds/runtime/worldAudioRuntime.ts'
import type { WorldRuntimeInputFrame } from '../../src/areas/worlds/runtime/worldInputRuntime.ts'
import type { FixtureEnvironment } from '../worlds-character-electron-fixture/shared.ts'
import { PhysicsObservation, createDeferredNativeRecorder } from './observation.ts'
import { PROJECT_KEY, type NativeTrace, type PhysicsFixtureView } from './shared.ts'
import '../../src/areas/worlds/WorldsWorkbench.css'
import './styles.css'

const editorController = createWorldEditorController(createWorldProjectService())
const observation = new PhysicsObservation()
const bootId = crypto.randomUUID()
const playController = createWorldPlayController({
  createPhysics: (generationId, handlers) => {
    observation.created(generationId)
    const real = createBrowserWorldPhysicsRuntime(generationId, {
      onSnapshot: (snapshot) => { observation.received(snapshot); handlers.onSnapshot(snapshot) },
      onTriggerEvents: (events) => handlers.onTriggerEvents(events),
      onError: (issue) => { observation.fail(`${issue.code}: ${issue.message}`); handlers.onError?.(issue) },
    })
    return {
      initialize: (scene) => { observation.initialized(generationId, scene); return real.initialize(scene) },
      step: (request) => { observation.posted(generationId, request); real.step(request) },
      pause: () => real.pause(), resume: () => real.resume(),
      dispose: () => { real.dispose(); observation.disposed() },
    }
  },
  createAudio: () => {
    const real = createBrowserWorldAudioAuthority('')
    let closing: Promise<void> | null = null
    return {
      prepareScene: (snapshot, sceneId) => real.prepareScene(snapshot, sceneId),
      activate: () => real.activate(), play: (id) => real.play(id), stopSource: (id) => real.stopSource(id),
      update: (poses) => real.update(poses), pause: () => real.pause(), resume: () => real.resume(),
      stop: () => {
        if (!closing) {
          observation.audioClosing()
          closing = real.stop().then(() => observation.audioClosed(), (error: unknown) => {
            observation.fail(`Audio close failed: ${String(error)}`)
            throw error
          })
        }
        return closing
      },
    }
  },
})
const subscribePlay = (listener: () => void) => playController.subscribe(listener)
const getPlayState = () => playController.getState()

function PhysicsFixture(): JSX.Element {
  const editor = useWorldEditorController(editorController)
  const { state } = editor
  const play = useSyncExternalStore(subscribePlay, getPlayState)
  useSyncExternalStore(observation.subscribe, observation.getRevision)
  const [error, setError] = useState<string | null>(null)
  const [trace, setTrace] = useState<NativeTrace[]>([])
  const [untrustedInputs, setUntrustedInputs] = useState(0)
  const mountedRef = useRef(true)
  const graphicsProfilePendingRef = useRef(false)
  const [graphicsProfilePending, setGraphicsProfilePending] = useState(false)
  const fail = useCallback((message: string) => { if (mountedRef.current) setError(message) }, [])
  const handle = useCallback(async (operation: Promise<WorldPlayControllerResult>) => {
    try {
      const result = await operation
      if (!result.success) throw new Error(result.issues.map((issue) => `${issue.code}: ${issue.message}`).join('; '))
    } catch (caught) { fail(caught instanceof Error ? caught.message : String(caught)); throw caught }
  }, [fail])
  const onAdvance = useCallback(async (timestamp: number, input: WorldRuntimeInputFrame) => {
    await handle(playController.advance(timestamp, input))
    // Bound native fixture traffic to one real request; this is not a throughput benchmark.
    await observation.waitForLatestAcknowledgement()
  }, [handle])
  const reportGraphicsFailure = useCallback((failure: WorldViewportFailure) => {
    fail(`${failure.kind}: ${failure.message}`)
    if (playController.getState().lifecycle !== 'edit') void handle(playController.stop()).catch(() => undefined)
  }, [fail, handle])
  const [graphicsRecovery] = useState(() => createWorldViewportRecovery(reportGraphicsFailure))
  const graphicsState = useSyncExternalStore(graphicsRecovery.subscribe, graphicsRecovery.getState, graphicsRecovery.getState)
  const editViewportActive = play.lifecycle === 'edit'
  const graphicsLease = useMemo(() => graphicsRecovery.capture(reportGraphicsFailure), [graphicsRecovery, graphicsState.attempt, reportGraphicsFailure, play.generationId, editViewportActive])
  const chooseGraphicsProfile = async (choice: WorldGraphicsProfileChoice) => {
    if (!mountedRef.current || graphicsProfilePendingRef.current) return
    if (graphicsRecovery.getState().failure) return fail('Graphics are unavailable for this fixture run.')
    const current = editorController.getState()
    if (!current.projectKey || !current.session || !current.activeSceneId || current.lifecycle === 'loading') return fail('The authored project is not ready.')
    if (playController.getState().lifecycle !== 'edit') return fail('Quality can only be changed while editing.')
    const authority = {
      projectKey: current.projectKey, projectId: current.session.snapshot.project.projectId,
      baseRevision: current.session.snapshot.project.revision, activeSceneId: current.activeSceneId,
    }
    try {
      const commands = buildWorldGraphicsProfileSelectionCommands(current.session.snapshot, choice)
      if (!commands.length) return
      graphicsProfilePendingRef.current = true
      setGraphicsProfilePending(true)
      const result = await editor.dispatchUiCommands(commands, 'graphics-profile', authority)
      if (!result.ok) fail(result.error.message)
    } catch (caught) {
      fail(caught instanceof Error ? caught.message : 'Quality could not be changed.')
    } finally {
      graphicsProfilePendingRef.current = false
      if (mountedRef.current) setGraphicsProfilePending(false)
    }
  }
  const start = () => {
    if (!mountedRef.current) return
    if (graphicsRecovery.getState().failure) return fail('Graphics are unavailable for this fixture run.')
    if (graphicsProfilePendingRef.current) return fail('Wait for the quality change before starting Play.')
    const current = editorController.getState()
    if (!current.session || !current.activeSceneId || current.lifecycle === 'loading') return fail('The authored project is not ready.')
    void handle(playController.start(current.session, current.activeSceneId)).catch(() => undefined)
  }
  const operation = (promise: Promise<WorldPlayControllerResult>) => { void handle(promise).catch(() => undefined) }
  const unsupported = () => fail('This fixture only exercises Play, Pause, Resume and Stop on its pre-authored project.')

  useEffect(() => {
    let sequence = 0
    const recorder = createDeferredNativeRecorder((entries) => {
      setTrace((current) => [...current, ...entries].slice(-200))
      setUntrustedInputs((current) => current + entries.filter((entry) => !entry.trusted).length)
    })
    const record = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null
      recorder.record({
        sequence: ++sequence, type: event.type, trusted: event.isTrusted,
        key: event instanceof KeyboardEvent ? event.key : null, code: event instanceof KeyboardEvent ? event.code : null,
        target: target?.closest('[aria-label]')?.getAttribute('aria-label') ?? target?.tagName ?? '',
        defaultPrevented: event.defaultPrevented,
      }, event)
    }
    const kinds = ['pointerdown', 'keydown', 'keypress', 'keyup', 'click', 'focusin', 'focusout'] as const
    for (const kind of kinds) document.addEventListener(kind, record, true)
    return () => { for (const kind of kinds) document.removeEventListener(kind, record, true); recorder.dispose() }
  }, [])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      graphicsProfilePendingRef.current = false
      if (playController.getState().lifecycle !== 'edit') void playController.stop()
    }
  }, [])

  const physics = observation.view()
  const publicError = graphicsState.failure ? `${graphicsState.failure.kind}: ${graphicsState.failure.message}`
    : error ?? observation.view().error ?? play.failure?.message ?? editor.initializationError ?? state.error?.message ?? null
  const view: PhysicsFixtureView = {
    bootId, environment: Reflect.get(window, 'worldsFixtureEnvironment') as FixtureEnvironment,
    requireType: typeof Reflect.get(window, 'require'), processType: typeof Reflect.get(window, 'process'),
    initializing: editor.initializing, editorLifecycle: state.lifecycle, playLifecycle: play.lifecycle,
    projectKey: state.projectKey, sceneId: state.activeSceneId, savedRevision: state.savedRevision,
    editorSession: state.session, playEditorSession: play.editor,
    runtimeSnapshotPresent: play.runtimeSnapshot !== null, bodyPoseCount: play.bodyPoses.length,
    error: publicError, physics, trace, untrustedInputs,
  }
  return <main className="physics-fixture">
    <div className="physics-fixture__heading"><h1>Worlds real physics fixture</h1>
      <p>Production Play and Worker, isolated source-level evidence. Collider-only course: no visual mesh, audio-output, performance or packaged-app claim.</p></div>
    {state.session ? <WorldsProjectBar
      projects={state.projects} projectKey={state.projectKey} projectPickerKey={PROJECT_KEY}
      scenes={state.session.snapshot.project.scenes} activeSceneId={state.activeSceneId}
      saveStatus={publicError ? 'error' : 'saved'} canUndo={false} canRedo={false} selectionCount={0}
      busy={editor.initializing || state.lifecycle === 'loading'} playState={play.lifecycle} canPlay={!!state.session}
      graphicsProfiles={state.session.snapshot.project.graphicsProfiles} activeGraphicsProfileId={state.session.snapshot.project.activeGraphicsProfileId}
      graphicsProfilePending={graphicsProfilePending} graphicsUnavailable={!!graphicsState.failure}
      onGraphicsProfileChoice={(choice) => { void chooseGraphicsProfile(choice) }}
      onProjectPickerKey={unsupported} onOpenProject={unsupported} onNewProject={unsupported} onScene={unsupported} onAddScene={unsupported}
      onUndo={unsupported} onRedo={unsupported} onDuplicate={unsupported} onDelete={unsupported}
      onLegacyExport={unsupported} onRecoverConflict={unsupported} onDock={unsupported}
      onPlayIntent={() => {}} onPlay={start} onPause={() => operation(playController.pause())}
      onResume={() => operation(playController.resume())} onStop={() => operation(playController.stop())}
    /> : <div className="physics-fixture__status" role="status">Opening authored project…</div>}
    <div className="physics-fixture__viewport">
      {/* A graphics failure is terminal evidence; this fixed run must never retry to salvage a pass. */}
      <WorldViewportBoundary failure={graphicsState.failure} lease={graphicsLease} retryDisabled
        onRetry={() => fail('Viewport retry is unavailable for this fixed fixture run.')}>
      {play.lifecycle !== 'edit' && play.runtimeSnapshot && play.sceneId ? <WorldRuntimeViewport
        snapshot={play.runtimeSnapshot} sceneId={play.sceneId} apiUrl="" lifecycle={play.lifecycle}
        bodyPoses={play.bodyPoses} animationRequests={play.animationRequests} onAdvance={onAdvance} onError={fail} onGraphicsFailure={graphicsLease.fail}
      /> : <div className="physics-fixture__status" role="status">{play.lifecycle === 'edit' ? 'Ready for Play' : 'Loading real Worker…'}</div>}
      </WorldViewportBoundary>
    </div>
    <div className="physics-fixture__status">{publicError ? <p role="alert">{publicError}</p> : <p>State: {play.lifecycle} · Worker generation {physics.generationId} · Acknowledged {physics.acknowledgedSequence}</p>}</div>
    <output id="physics-fixture-state" hidden>{JSON.stringify(view)}</output>
  </main>
}

const root = document.getElementById('root')
if (!root) throw new Error('Physics fixture root is missing.')
createRoot(root).render(<PhysicsFixture />)

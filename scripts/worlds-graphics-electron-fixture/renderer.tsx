import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import WorldRuntimeViewport from '../../src/areas/worlds/components/WorldRuntimeViewport.tsx'
import { WorldViewportBoundary, createWorldViewportRecovery } from '../../src/areas/worlds/components/WorldViewportBoundary.tsx'
import { createWorldEditorController } from '../../src/areas/worlds/editor/worldEditorController.ts'
import { useWorldEditorController } from '../../src/areas/worlds/editor/useWorldEditorController.ts'
import { createWorldProjectService } from '../../src/areas/worlds/worldProjectService.ts'
import { createWorldPlayController } from '../../src/areas/worlds/runtime/worldPlayController.ts'
import { createBrowserWorldPhysicsRuntime } from '../../src/areas/worlds/runtime/worldPhysicsRuntime.ts'
import { createBrowserWorldAudioAuthority } from '../../src/areas/worlds/runtime/worldAudioRuntime.ts'
import type { WorldRuntimeInputFrame } from '../../src/areas/worlds/runtime/worldInputRuntime.ts'
import '../../src/areas/worlds/WorldsWorkbench.css'
import '../worlds-physics-electron-fixture/styles.css'

declare const __GRAPHICS_CASE__: string
const positive = __GRAPHICS_CASE__ === 'supported-runtime'
const parameters = new URLSearchParams(location.hash.slice(1))
const assetBase = positive ? parameters.get('assetBase') ?? '' : ''
if (positive && (parameters.get('case') !== 'supported-runtime' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(assetBase))) throw new Error('Positive fixture private asset declaration is absent.')

const editorController = createWorldEditorController(createWorldProjectService())
const evidence = { stopCalls: 0, physicsCreated: 0, physicsDisposed: 0, audioStopRequested: 0, audioClosed: 0, advanceCalls: 0, failures: [] as string[], error: null as string | null,
  workerSamples: [] as Array<{ generationId: number; sequence: number; entityIds: string[]; transforms: number[]; at: number }>, nativeKeys: [] as string[], inputSequence: 0 }
if (positive) { window.addEventListener('error', (event) => { evidence.error = event.message }); window.addEventListener('unhandledrejection', (event) => { evidence.error = String(event.reason) }) }
const controller = createWorldPlayController({
  createPhysics(generationId, handlers) {
    evidence.physicsCreated += 1
    const real = createBrowserWorldPhysicsRuntime(generationId, { ...handlers, onSnapshot(snapshot) {
      handlers.onSnapshot(snapshot)
      if (positive) { evidence.workerSamples.push({ generationId: snapshot.generationId, sequence: snapshot.sequence, entityIds: [...snapshot.entityIds], transforms: [...snapshot.transforms], at: performance.now() }); evidence.workerSamples = evidence.workerSamples.slice(-64) }
    } })
    let disposed = false
    return {
      initialize: (scene) => real.initialize(scene), step: (request) => real.step(request), pause: () => real.pause(), resume: () => real.resume(),
      dispose() { if (!disposed) { disposed = true; evidence.physicsDisposed += 1 }; real.dispose() },
    }
  },
  createAudio() {
    const real = createBrowserWorldAudioAuthority('')
    let closing: Promise<void> | null = null
    return {
      prepareScene: (snapshot, sceneId) => real.prepareScene(snapshot, sceneId), activate: () => real.activate(),
      play: (id) => real.play(id), stopSource: (id) => real.stopSource(id), update: (poses) => real.update(poses), pause: () => real.pause(), resume: () => real.resume(),
      stop() {
        if (!closing) { evidence.audioStopRequested += 1; closing = real.stop().then(() => { evidence.audioClosed += 1 }) }
        return closing
      },
    }
  },
})
const subscribePlay = (listener: () => void) => controller.subscribe(listener)
const getPlay = () => controller.getState()
const recovery = createWorldViewportRecovery((failure) => {
  evidence.failures.push(failure.message)
  if (controller.getState().lifecycle !== 'edit') {
    evidence.stopCalls += 1
    void controller.stop().then((result) => { if (!result.success) evidence.error = result.issues[0]?.message ?? 'Stop failed.' })
      .catch((error: unknown) => { evidence.error = String(error) })
  }
})

function GraphicsRecoveryFixture(): JSX.Element {
  const editor = useWorldEditorController(editorController)
  const play = useSyncExternalStore(subscribePlay, getPlay)
  const graphics = useSyncExternalStore(recovery.subscribe, recovery.getState)
  const edit = play.lifecycle === 'edit'
  const lease = useMemo(() => recovery.capture(), [edit, play.generationId, graphics.attempt])
  const [trustedClicks, setTrustedClicks] = useState<string[]>([])
  const [shellInteractions, setShellInteractions] = useState(0)
  const [, updateEvidence] = useState(0)
  useEffect(() => {
    // Observation only: this timer never advances runtime or changes its lifecycle.
    const timer = window.setInterval(() => updateEvidence((value) => value + 1), 50)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    const record = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target.closest('[aria-label]') : null
      if (event.isTrusted) setTrustedClicks((current) => [...current, element?.getAttribute('aria-label') ?? ''].slice(-20))
    }
    document.addEventListener('click', record, true)
    const key = (event: KeyboardEvent) => { if (positive && event.isTrusted && event.target instanceof Element && event.target.closest('.world-runtime-viewport')) evidence.nativeKeys.push(`${event.type}:${event.code}`) }
    document.addEventListener('keydown', key, true); document.addEventListener('keyup', key, true)
    return () => { document.removeEventListener('click', record, true); document.removeEventListener('keydown', key, true); document.removeEventListener('keyup', key, true) }
  }, [])
  useEffect(() => () => { if (controller.getState().lifecycle !== 'edit') void controller.stop() }, [])
  const start = () => {
    const { session, activeSceneId } = editorController.getState()
    if (!session || !activeSceneId || !lease.isCurrent()) return
    void controller.start(session, activeSceneId).then((result) => { if (!result.success) evidence.error = result.issues[0]?.message ?? 'Start failed.' })
      .catch((error: unknown) => { evidence.error = String(error) })
  }
  const advance = useCallback(async (timestamp: number, input: WorldRuntimeInputFrame) => {
    evidence.advanceCalls += 1
    evidence.inputSequence = input.sequence
    const result = await controller.advance(timestamp, input)
    if (!result.success) evidence.error = result.issues[0]?.message ?? 'Advance failed.'
  }, [])
  const retry = () => { if (controller.getState().lifecycle === 'edit') recovery.retry() }
  const control = (operation: 'pause' | 'resume' | 'stop') => {
    void controller[operation]().then((result) => { if (!result.success) evidence.error = result.issues[0]?.message ?? `${operation} failed.` }).catch((error: unknown) => { evidence.error = String(error) })
  }
  return <main className="physics-fixture" aria-label="Graphics recovery editor shell">
    <div className="physics-fixture__heading"><h1>{positive ? 'Worlds supported graphics admission' : 'Worlds graphics recovery'}</h1><p>{positive ? 'Small-scene hardware context admission only — not full fluency or packaged acceptance.' : 'Unsupported-WebGL containment only. No visual Play, gameplay, sensor, performance or packaged-app claim.'}</p></div>
    <div className="physics-fixture__status">
      <button type="button" className="worlds-button" aria-label={positive ? 'Start positive Play' : 'Start recovery probe'} disabled={!editor.state.session || !edit || !!graphics.failure} onClick={start}>Play</button>
      <button type="button" className="worlds-button" aria-label="Editor shell control" onClick={() => setShellInteractions((value) => value + 1)}>Scene</button>
      {positive ? <><button type="button" aria-label="Pause positive Play" disabled={play.lifecycle !== 'playing'} onClick={() => control('pause')}>Pause</button><button type="button" aria-label="Resume positive Play" disabled={play.lifecycle !== 'paused'} onClick={() => control('resume')}>Resume</button><button type="button" aria-label="Stop positive Play" disabled={edit || play.lifecycle === 'stopping'} onClick={() => control('stop')}>Stop</button></> : null}
    </div>
    <div className="physics-fixture__viewport">
      <WorldViewportBoundary key={graphics.attempt} failure={graphics.failure} lease={lease} onRetry={retry} retryDisabled={!edit}>
        {play.lifecycle !== 'edit' && play.runtimeSnapshot && play.sceneId ? <WorldRuntimeViewport key={play.generationId}
          snapshot={play.runtimeSnapshot} sceneId={play.sceneId} apiUrl={assetBase} lifecycle={play.lifecycle} bodyPoses={play.bodyPoses}
          animationRequests={play.animationRequests} onAdvance={advance} onGraphicsFailure={lease.fail} onError={(message) => { evidence.error = message }}
        /> : <div className="physics-fixture__status" role="status">{edit ? 'Ready for an explicit Play attempt' : 'Loading production runtime'}</div>}
      </WorldViewportBoundary>
    </div>
    <output id="graphics-recovery-state" hidden>{JSON.stringify({
      environment: Reflect.get(window, 'worldsFixtureEnvironment'), requireType: typeof Reflect.get(window, 'require'), processType: typeof Reflect.get(window, 'process'),
      editorSession: editor.state.session, editorError: editor.initializationError ?? editor.state.error?.message ?? null,
      lifecycle: play.lifecycle, generationId: play.generationId, bodyPoses: play.bodyPoses, runtimeSnapshotPresent: !!play.runtimeSnapshot, graphics, evidence, trustedClicks, shellInteractions,
    })}</output>
  </main>
}

const root = document.getElementById('root')
if (!root) throw new Error('Graphics recovery fixture root is missing.')
createRoot(root).render(<GraphicsRecoveryFixture />)

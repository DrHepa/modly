import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react'
import { createRoot } from 'react-dom/client'

import { WorldsWorkbench } from '../../src/areas/worlds/components/WorldsWorkbench.tsx'
import { worldEditorController } from '../../src/areas/worlds/editor/worldEditorController.ts'
import { useNavStore } from '../../src/shared/stores/navStore.ts'
import { safeControllerState, type FixtureRendererView, type FixtureScenario, type RendererTrace } from './shared.ts'
import './styles.css'

type FixtureBridge = Readonly<{
  scenario: FixtureScenario
  environment: { sandboxed: boolean; contextIsolated: boolean }
  recordObservation(value: unknown): void
}>

const bridge = (() => {
  const candidate = Reflect.get(window, 'worldsC3Fixture') as FixtureBridge | undefined
  if (!candidate) throw new Error('Fixture preload bridge is unavailable.')
  return candidate
})()
useNavStore.setState({ currentPage: 'worlds', navigationError: null })

function FixtureShell(): JSX.Element {
  const controllerState = useSyncExternalStore(
    worldEditorController.subscribe.bind(worldEditorController),
    worldEditorController.getState.bind(worldEditorController),
    worldEditorController.getState.bind(worldEditorController),
  )
  const page = useNavStore((state) => state.currentPage)
  const navigationError = useNavStore((state) => state.navigationError)
  const [trace, setTrace] = useState<RendererTrace[]>([])
  const [navigationResult, setNavigationResult] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sequence = useMemo(() => ({ current: 0 }), [])
  const navigationSequence = useMemo(() => ({ current: 0 }), [])
  const record = useCallback((entry: Omit<RendererTrace, 'sequence'>) => {
    setTrace((current) => [...current, { ...entry, sequence: ++sequence.current }].slice(-256))
  }, [sequence])

  useEffect(() => {
    const key = (event: KeyboardEvent) => record({ type: event.type as 'keydown' | 'keyup', trusted: event.isTrusted,
      key: event.key, label: event.target instanceof Element ? event.target.getAttribute('aria-label') ?? '' : '' })
    const click = (event: MouseEvent) => record({ type: 'click', trusted: event.isTrusted, key: null,
      label: event.target instanceof Element ? event.target.closest('button')?.getAttribute('aria-label')
        ?? event.target.closest('button')?.textContent?.trim() ?? '' : '' })
    const controller = () => record({ type: 'controller', trusted: true, key: null,
      label: `${worldEditorController.getState().lifecycle}:${worldEditorController.getState().session?.snapshot.project.revision ?? 'none'}` })
    document.addEventListener('keydown', key, true)
    document.addEventListener('keyup', key, true)
    document.addEventListener('click', click, true)
    const unsubscribe = worldEditorController.subscribe(controller)
    const onError = (event: ErrorEvent) => setError(event.message)
    const rejection = (event: PromiseRejectionEvent) => setError(String(event.reason))
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', rejection)
    return () => {
      document.removeEventListener('keydown', key, true)
      document.removeEventListener('keyup', key, true)
      document.removeEventListener('click', click, true)
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', rejection)
      unsubscribe()
    }
  }, [record])

  const leave = useCallback(async (input: ReactMouseEvent<HTMLButtonElement>) => {
    if (!input.isTrusted) { setError('Navigation input was not trusted.'); return }
    const navigationId = `navigation-${++navigationSequence.current}`
    record({ type: 'navigation', trusted: true, key: null, label: 'navigation-request' })
    bridge.recordObservation({ type: 'navigation-request', navigationId, trusted: input.isTrusted })
    try {
      const accepted = await useNavStore.getState().navigate('generate')
      setNavigationResult(accepted)
      record({ type: 'navigation', trusted: true, key: null, label: accepted ? 'navigation-complete' : 'navigation-blocked' })
      if (accepted) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        const destinationVisible = document.querySelector('[aria-label="Destination page"]') instanceof HTMLElement
        bridge.recordObservation({ type: 'navigation-complete', navigationId,
          page: useNavStore.getState().currentPage, destinationVisible })
      }
    } catch (reason) { setError(String(reason)) }
  }, [navigationSequence, record])

  const view: FixtureRendererView = {
    scenario: bridge.scenario,
    environment: bridge.environment,
    requireType: typeof Reflect.get(window, 'require'),
    processType: typeof Reflect.get(window, 'process'),
    page,
    controller: safeControllerState(controllerState),
    trace,
    navigationResult,
    error: error ?? navigationError,
  }

  return <main className="c3-fixture-shell" aria-label="Worlds direct edit acceptance shell">
    <header className="c3-fixture-header">
      <div><h1>Worlds editor acceptance</h1><p>Production editor surface with isolated deterministic scene data.</p></div>
      <button type="button" className="c3-fixture-leave" aria-label="Leave Worlds" onClick={(event) => { void leave(event) }}>Leave Worlds</button>
    </header>
    {page === 'worlds' ? <WorldsWorkbench /> : <section aria-label="Destination page"><h2>Generate</h2></section>}
    <output id="worlds-c3-fixture-state" hidden>{JSON.stringify(view)}</output>
  </main>
}

const root = document.getElementById('root')
if (!root) throw new Error('Fixture root is unavailable.')
createRoot(root).render(<FixtureShell />)

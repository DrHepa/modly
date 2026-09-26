import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { Tooltip } from '../../../shared/components/ui/Tooltip.tsx'
import { useAppStore } from '../../../shared/stores/appStore.ts'
import { worldRationalTimeToSeconds, type WorldSequenceFps } from '../cinematic/worldRationalTime.ts'
import type { WorldCommand } from '../core/worldCommands.ts'
import type { WorldGraphicsProfileChoice } from '../editor/worldGraphicsProfileCommands.ts'
import { buildWorldGraphicsProfileSelectionCommands } from '../editor/worldGraphicsProfileCommands.ts'
import type { WorldRationalTime } from '../core/worldModel.ts'
import type { WorldPlayControllerResult } from '../runtime/worldPlayController.ts'
import { importLegacyWorldsSceneManifest } from '../core/legacySceneManifestAdapter.ts'
import {
  buildAddCameraCommands,
  buildAddLightCommands,
  buildAddModelEntityCommands,
  buildImportLegacySceneCommands,
  createDeterministicWorldEditorIdentityGenerator,
} from '../editor/worldEditorCommandBuilders.ts'
import { buildAddEmptyEntityCommands, buildAttachAudioSourceCommands, getWorldGltfAnimationModel } from '../editor/worldAuthoringModel.ts'
import { restoreWorldsDockFocus, trapWorldsOverlayFocus } from '../editor/worldsOverlayFocus.ts'
export { restoreWorldsDockFocus, trapWorldsOverlayFocus } from '../editor/worldsOverlayFocus.ts'
import { legacyWorldsCommandBridge } from '../editor/legacyWorldsCommandBridge.ts'
import type { WorldEditorDispatchAuthority } from '../editor/worldEditorController.ts'
import { useWorldEditorController, createWorldUiTransactionId } from '../editor/useWorldEditorController.ts'
import { useWorldsCliApplyLifetime } from '../editor/useWorldsCliApplyLifetime.ts'
import { resolveWorldProjectPickerKey } from '../editor/worldProjectPickerModel.ts'
import {
  createWorldEditorViewportCommitAuthority,
  projectWorldEditorViewport,
  useWorldEditorProjectionBridge,
} from '../editor/useWorldEditorProjectionBridge.ts'
import { createWorldEditorTransformAdmission } from '../editor/worldEditorTransformAdmission.ts'
import {
  createWorldTimelinePreviewController,
  type WorldTimelinePreviewInput,
} from '../editor/worldTimelinePreview.ts'
import { useWorldsUiStore, type WorldsWorkbenchDock } from '../editor/worldsUiStore.ts'
import {
  buildWorldTreeMutationCommands,
  isWorldEntityEffectivelyLocked,
  resolveWorldsPersistenceIndicator,
  type WorldTreeMutation,
} from '../editor/worldsWorkbenchModel.ts'
import {
  listWorldAssetLibraryRenderables,
  openWorldAssetLibraryRenderable,
  readWorldAssetLibraryAudio,
  type WorldAssetLibraryRenderable,
} from '../worldAssetLibraryService.ts'
import { appendWorldSceneItem } from '../worldsScenePlacement.ts'
import { buildWorldsSceneManifest } from '../worldsSceneManifest.ts'
import { createBrowserWorldAudioAuthority } from '../runtime/worldAudioRuntime.ts'
import { createBrowserWorldPhysicsRuntime } from '../runtime/worldPhysicsRuntime.ts'
import { createWorldPlayController } from '../runtime/worldPlayController.ts'
import { loadWorldGeometrySource } from '../runtime/worldGeometryPreparation.ts'
import '../WorldsWorkbench.css'
import WorldRuntimeViewport from './WorldRuntimeViewport.tsx'
import { WorldViewportBoundary, createWorldViewportRecovery } from './WorldViewportBoundary.tsx'
import WorldsAssetsDock from './WorldsAssetsDock.tsx'
import WorldsInspector from './WorldsInspector.tsx'
import WorldsLegacyExportDialog from './WorldsLegacyExportDialog.tsx'
import WorldsProjectBar from './WorldsProjectBar.tsx'
import WorldsSceneDock from './WorldsSceneDock.tsx'
import WorldsTimelineDrawer from './WorldsTimelineDrawer.tsx'
import WorldsAiDrawer from './WorldsAiDrawer.tsx'
import { createWorldEditorCommandPort } from '../editor/worldEditorCommandPort.ts'
import { createWorldAiChatAdapter } from '../editor/worldAiChatAdapter.ts'
import { createWorldsCliReadinessResponder } from '../editor/worldsCliReadinessResponder.ts'
import WorldsViewer from './WorldsViewer.tsx'

type AddSceneEntityKind = 'empty' | 'camera' | 'light'
type GraphicsDiagnosticOwner = Readonly<{
  mode: 'edit' | 'play'
  projectId: string | null
  sceneId: string | null
  scope: string
}>

type GraphicsDiagnosticToken = {
  readonly owner: GraphicsDiagnosticOwner
  pendingMessage: string | null
}

function graphicsDiagnosticKey(token: GraphicsDiagnosticToken, message: string): string {
  const { owner } = token
  return `${owner.mode}\0${owner.projectId ?? ''}\0${owner.sceneId ?? ''}\0${owner.scope}\0${message}`
}

export function WorldsWorkbench(): JSX.Element {
  const apiUrl = useAppStore((state) => state.apiUrl)
  const editor = useWorldEditorController()
  const { controller, state } = editor
  useWorldsCliApplyLifetime(controller)
  const selectedEntityIds = useWorldsUiStore((value) => value.selectedEntityIds)
  const activeEntityId = useWorldsUiStore((value) => value.activeEntityId)
  const expandedEntityIds = useWorldsUiStore((value) => value.expandedEntityIds)
  const focusedTreeEntityId = useWorldsUiStore((value) => value.focusedTreeEntityId)
  const activeLeftDock = useWorldsUiStore((value) => value.activeLeftDock)
  const overlayDock = useWorldsUiStore((value) => value.overlayDock)
  const snapEnabled = useWorldsUiStore((value) => value.snapEnabled)
  const snapIncrement = useWorldsUiStore((value) => value.snapIncrement)
  const setSelection = useWorldsUiStore((value) => value.setSelection)
  const setExpandedEntityIds = useWorldsUiStore((value) => value.setExpandedEntityIds)
  const setFocusedTreeEntityId = useWorldsUiStore((value) => value.setFocusedTreeEntityId)
  const setActiveLeftDock = useWorldsUiStore((value) => value.setActiveLeftDock)
  const setOverlayDock = useWorldsUiStore((value) => value.setOverlayDock)
  const setSnap = useWorldsUiStore((value) => value.setSnap)
  const resetForScene = useWorldsUiStore((value) => value.resetForScene)

  const rootRef = useRef<HTMLElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const dockTriggerRef = useRef<HTMLButtonElement | null>(null)
  const animationBusyRef = useRef(false)
  const pendingAssetRef = useRef<string | null>(null)
  const playIntentSequenceRef = useRef(0)
  const graphicsProfilePendingRef = useRef(false)
  const [graphicsProfilePending, setGraphicsProfilePending] = useState(false)
  const clearPlayIntentListenersRef = useRef<() => void>(() => undefined)
  const [compact, setCompact] = useState(false)
  const [projectPickerKey, setProjectPickerKey] = useState('')
  const previousProjectKeyRef = useRef<string | null>(null)
  const [assets, setAssets] = useState<WorldAssetLibraryRenderable[]>([])
  const [assetsLoading, setAssetsLoading] = useState(false)
  const [assetsError, setAssetsError] = useState<string | null>(null)
  const [addingAssetId, setAddingAssetId] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [transformPending, setTransformPending] = useState(false)
  const [graphicsMessage, setGraphicsMessage] = useState<string | null>(null)
  const graphicsDiagnosticRef = useRef('')
  const graphicsDiagnosticTokenRef = useRef<GraphicsDiagnosticToken | null>(null)
  const [legacyExportOpen, setLegacyExportOpen] = useState(false)
  const [legacyConversionStarted, setLegacyConversionStarted] = useState(false)
  const [legacyResolved, setLegacyResolved] = useState(false)
  const [legacyScene] = useState(() => legacyWorldsCommandBridge.readScene())
  const viewportCommitAuthority = useMemo(() => createWorldEditorViewportCommitAuthority(), [])
  const [viewportCommitLease, setViewportCommitLease] = useState(() => viewportCommitAuthority.issue())
  const viewportCommitLeaseRef = useRef(viewportCommitLease)
  viewportCommitLeaseRef.current = viewportCommitLease
  const playController = useMemo(() => createWorldPlayController({
    createPhysics: (generationId, handlers) => createBrowserWorldPhysicsRuntime(generationId, handlers),
    createAudio: () => createBrowserWorldAudioAuthority(apiUrl),
    geometry: { apiUrl, loadModelGeometry: loadWorldGeometrySource },
  }), [apiUrl])
  const [playState, setPlayState] = useState(() => playController.getState())
  useLayoutEffect(() => {
    const cli = window.electron?.workspace?.worlds?.cli
    if (!cli?.onContextRequest) return
    let mounted = true
    let priorEditor = controller.getState()
    let priorPlay = playController.getState().lifecycle
    const invalidate = () => {
      const currentEditor = controller.getState()
      const currentPlay = playController.getState().lifecycle
      const classification = controller.classifyExternalCliEditorLifecycle(priorEditor, currentEditor, priorPlay, currentPlay)
      priorEditor = currentEditor
      priorPlay = currentPlay
      if (classification === 'revoke') void cli.editorLeft().catch(() => undefined)
    }
    const unsubscribeEditor = controller.subscribe(invalidate)
    const unsubscribePlay = playController.subscribe(invalidate)
    const unsubscribeRequest = cli.onContextRequest((nonce) => {
      if (!mounted) return
      const current = controller.getState()
      const project = current.session?.snapshot.project
      if (playController.getState().lifecycle !== 'edit' || current.lifecycle !== 'ready'
        || !current.projectKey || !project || !current.activeSceneId) return
      void cli.respondContext({ nonce, projectKey: current.projectKey, projectId: project.projectId,
        sceneId: current.activeSceneId, revision: project.revision, editorEpoch: current.editorEpoch, mode: 'edit' }).catch(() => undefined)
    })
    return () => { mounted = false; unsubscribeRequest(); unsubscribeEditor(); unsubscribePlay(); void cli.editorLeft().catch(() => undefined) }
  }, [controller, playController])
  useLayoutEffect(() => {
    const cli = window.electron?.workspace?.worlds?.cli
    if (!cli?.onDirectEditRequest) return
    const unsubscribe = cli.onDirectEditRequest((request) => {
      void controller.applyScopedCliIntent(request)
    })
    return unsubscribe
  }, [controller])
  useLayoutEffect(() => {
    const cli = window.electron?.workspace?.worlds?.cli
    if (!cli?.onDirectEditReadinessRequest) return
    const responder = createWorldsCliReadinessResponder({
      cli,
      readView: () => {
        const current = controller.getState()
        const project = current.session?.snapshot.project
        return { mounted: true, playLifecycle: playController.getState().lifecycle, editorLifecycle: current.lifecycle,
          projectKey: current.projectKey, projectId: project?.projectId ?? null, sceneId: current.activeSceneId,
          revision: project?.revision ?? null, editorEpoch: current.editorEpoch }
      },
      subscribeEditor: (listener) => controller.subscribe(listener),
      subscribePlay: (listener) => playController.subscribe(listener),
    })
    return () => { responder.dispose() }
  }, [controller, playController])
  const beforeAiApplyRef = useRef<() => void>(() => undefined)
  const aiAdapter = useMemo(() => createWorldAiChatAdapter(createWorldEditorCommandPort(controller),
    () => playController.getState().lifecycle === 'edit', { autoApply: true, onBeforeApply: () => beforeAiApplyRef.current() }), [controller, playController])
  useEffect(() => {
    const unsubscribe = playController.subscribe(() => {
      if (playController.getState().lifecycle !== 'edit') aiAdapter.cancel()
    })
    return () => { unsubscribe(); aiAdapter.cancel() }
  }, [aiAdapter, playController])
  const timelinePreviewController = useMemo(() => createWorldTimelinePreviewController(), [])
  const [timelinePreviewState, setTimelinePreviewState] = useState(() => timelinePreviewController.getState())
  const playFailure = playState.failure

  const legacyAvailable = legacyScene.sceneItems.length > 0 || legacyScene.collisionSurfaces.length > 0
  const session = state.session
  const snapshot = session?.snapshot ?? null
  const scene = snapshot?.scenes.find((candidate) => candidate.sceneId === state.activeSceneId) ?? null
  const editViewportResetKey = [
    state.projectKey ?? '',
    snapshot?.project.projectId ?? '',
    state.activeSceneId ?? '',
  ].join('\0')
  const selectionLocked = scene
    ? selectedEntityIds.some((entityId) => isWorldEntityEffectivelyLocked(scene.entities, entityId))
    : false

  const announceError = useCallback((message: string) => {
    setError(message)
    setStatus(null)
  }, [])
  const announceStatus = useCallback((message: string) => {
    setStatus(message)
    setError(null)
  }, [])

  const transformAdmission = useMemo(() => createWorldEditorTransformAdmission({
    getContext: () => {
      const current = controller.getState()
      return {
        projectKey: current.projectKey,
        activeSceneId: current.activeSceneId,
        snapshot: current.session?.snapshot ?? null,
      }
    },
    getViewportLease: () => viewportCommitLeaseRef.current,
    isViewportCurrent: (lease) => viewportCommitAuthority.isCurrent(lease),
    onError: announceError,
    onPendingChange: setTransformPending,
  }), [announceError, controller, viewportCommitAuthority])

  useEffect(() => {
    transformAdmission.invalidateActive()
  }, [editViewportResetKey, playState.lifecycle, transformAdmission, viewportCommitLease])
  const deliverGraphicsDiagnostic = useCallback((token: GraphicsDiagnosticToken, message: string) => {
    const key = graphicsDiagnosticKey(token, message)
    if (graphicsDiagnosticRef.current === key) return
    graphicsDiagnosticRef.current = key
    if (message) {
      setGraphicsMessage(`Graphics: ${message}`)
    } else {
      setGraphicsMessage(null)
    }
  }, [])
  const handleGraphicsDiagnostic = useCallback((token: GraphicsDiagnosticToken, message: string) => {
    if (graphicsDiagnosticTokenRef.current !== token) {
      token.pendingMessage = message
      return
    }
    deliverGraphicsDiagnostic(token, message)
  }, [deliverGraphicsDiagnostic])
  const revokeEditViewport = useCallback(() => {
    viewportCommitAuthority.revoke()
  }, [viewportCommitAuthority])
  const renewEditViewport = useCallback(() => {
    const lease = viewportCommitAuthority.issue()
    viewportCommitLeaseRef.current = lease
    setViewportCommitLease(lease)
  }, [viewportCommitAuthority])
  const cancelPendingPlayIntent = useCallback(() => {
    playIntentSequenceRef.current += 1
    clearPlayIntentListenersRef.current()
    clearPlayIntentListenersRef.current = () => undefined
  }, [])
  const handleGraphicsFailure = useCallback(() => {
    cancelPendingPlayIntent()
    timelinePreviewController.stop()
    revokeEditViewport()
    setGraphicsMessage(null)
    if (playController.getState().lifecycle !== 'edit') {
      // The existing Stop API disposes physics and requests audio stop; it does not await audio closure.
      void playController.stop().then((result) => {
        if (!result.success) announceError(result.issues[0]?.message ?? 'Play could not stop.')
      }).catch((caught: unknown) => announceError(caught instanceof Error ? caught.message : 'Play could not stop.'))
    }
  }, [announceError, cancelPendingPlayIntent, playController, revokeEditViewport, timelinePreviewController])
  // Availability belongs to this Workbench, not to a replaceable backend/Play controller.
  const [graphicsRecovery] = useState(() => createWorldViewportRecovery(handleGraphicsFailure))
  const graphicsState = useSyncExternalStore(graphicsRecovery.subscribe, graphicsRecovery.getState, graphicsRecovery.getState)
  const editViewportActive = playState.lifecycle === 'edit'
  const graphicsLease = useMemo(() => graphicsRecovery.capture(handleGraphicsFailure), [graphicsRecovery, graphicsState.attempt, handleGraphicsFailure, editViewportActive, playController, playState.generationId, viewportCommitLease.generation])
  const editGraphicsDiagnosticScope = `${editViewportResetKey}\0${graphicsState.attempt}\0${graphicsState.failure ? 'failed' : 'live'}`
  const activeGraphicsDiagnosticToken: GraphicsDiagnosticToken = useMemo(() => ({
    owner: playState.lifecycle === 'edit' ? {
      mode: 'edit',
      projectId: snapshot?.project.projectId ?? null,
      sceneId: state.activeSceneId,
      scope: editGraphicsDiagnosticScope,
    } : {
      mode: 'play',
      projectId: playState.runtimeSnapshot?.project.projectId ?? snapshot?.project.projectId ?? null,
      sceneId: playState.sceneId,
      scope: String(playState.generationId),
    },
    pendingMessage: null,
  }), [editGraphicsDiagnosticScope, playState.generationId, playState.lifecycle, playState.runtimeSnapshot?.project.projectId, playState.sceneId, snapshot?.project.projectId, state.activeSceneId])
  const handleActiveGraphicsDiagnostic = useCallback((message: string) => {
    handleGraphicsDiagnostic(activeGraphicsDiagnosticToken, message)
  }, [activeGraphicsDiagnosticToken, handleGraphicsDiagnostic])
  useLayoutEffect(() => {
    const previousToken = graphicsDiagnosticTokenRef.current
    graphicsDiagnosticTokenRef.current = activeGraphicsDiagnosticToken
    graphicsDiagnosticRef.current = ''
    if (previousToken !== activeGraphicsDiagnosticToken) {
      setGraphicsMessage(null)
    }
    const pendingMessage = activeGraphicsDiagnosticToken.pendingMessage
    activeGraphicsDiagnosticToken.pendingMessage = null
    if (pendingMessage !== null) {
      deliverGraphicsDiagnostic(activeGraphicsDiagnosticToken, pendingMessage)
    }
  }, [activeGraphicsDiagnosticToken, deliverGraphicsDiagnostic])
  const handleViewportRetry = useCallback(() => {
    if (playController.getState().lifecycle !== 'edit') return
    cancelPendingPlayIntent()
    timelinePreviewController.stop()
    if (graphicsRecovery.retry()) renewEditViewport()
  }, [cancelPendingPlayIntent, graphicsRecovery, playController, renewEditViewport, timelinePreviewController])
  useEffect(() => {
    if (graphicsState.attempt > 0 && !graphicsState.failure) rootRef.current?.querySelector<HTMLElement>('[aria-label="Worlds 3D canvas"]')?.focus()
  }, [graphicsState.attempt, graphicsState.failure])
  const handlePlayIntent = useCallback(() => {
    if (!graphicsLease.isCurrent()) return
    timelinePreviewController.stop()
    revokeEditViewport()
    cancelPendingPlayIntent()
    const sequence = playIntentSequenceRef.current
    const finishPointerIntent = () => {
      clearPlayIntentListenersRef.current()
      clearPlayIntentListenersRef.current = () => undefined
      window.setTimeout(() => {
        if (playIntentSequenceRef.current !== sequence) return
        if (playController.getState().lifecycle === 'edit') renewEditViewport()
      }, 0)
    }
    const clearListeners = () => {
      window.removeEventListener('pointerup', finishPointerIntent, true)
      window.removeEventListener('pointercancel', finishPointerIntent, true)
    }
    clearPlayIntentListenersRef.current = clearListeners
    window.addEventListener('pointerup', finishPointerIntent, { capture: true, once: true })
    window.addEventListener('pointercancel', finishPointerIntent, { capture: true, once: true })
  }, [cancelPendingPlayIntent, graphicsLease, playController, renewEditViewport, revokeEditViewport, timelinePreviewController])

  useEffect(() => {
    setPlayState(playController.getState())
    return playController.subscribe(() => setPlayState(playController.getState()))
  }, [playController])

  useEffect(() => {
    setTimelinePreviewState(timelinePreviewController.getState())
    return timelinePreviewController.subscribe(setTimelinePreviewState)
  }, [timelinePreviewController])

  useEffect(() => {
    if (playFailure) announceError(playFailure.message)
  }, [announceError, playFailure])

  useEffect(() => {
    // React StrictMode replays effect cleanup during mount; renew the lease on its second setup.
    if (!viewportCommitAuthority.isCurrent(viewportCommitLeaseRef.current)) renewEditViewport()
    return () => {
      cancelPendingPlayIntent()
      timelinePreviewController.stop()
      viewportCommitAuthority.revoke()
      if (playController.getState().lifecycle !== 'edit') void playController.stop()
    }
  }, [cancelPendingPlayIntent, playController, renewEditViewport, timelinePreviewController, viewportCommitAuthority])

  const bridge = useWorldEditorProjectionBridge({
    controller,
    state,
    apiUrl,
    viewportCommitAuthority,
    viewportCommitLease,
    transformAdmission,
    onError: announceError,
  })

  useEffect(() => {
    const element = rootRef.current
    if (!element) return
    const update = () => setCompact(element.getBoundingClientRect().width <= 1080)
    update()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!compact && overlayDock) setOverlayDock(null)
  }, [compact, overlayDock, setOverlayDock])

  useEffect(() => {
    if (!compact || !overlayDock) return
    const dock = overlayDock
    queueMicrotask(() => {
      const first = overlayRef.current?.querySelector<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled), [tabindex="0"]')
      first?.focus()
    })
    return () => {
      queueMicrotask(() => {
        restoreWorldsDockFocus(rootRef.current, dockTriggerRef.current, dock)
      })
    }
  }, [compact, overlayDock])

  useEffect(() => {
    const previousProjectKey = previousProjectKeyRef.current
    previousProjectKeyRef.current = state.projectKey
    setProjectPickerKey((currentPickerKey) => resolveWorldProjectPickerKey({
      currentPickerKey,
      currentProjectKey: state.projectKey,
      previousProjectKey,
      projects: state.projects,
    }))
  }, [state.projectKey, state.projects])

  const refreshAssets = useCallback(async () => {
    setAssetsLoading(true)
    setAssetsError(null)
    try {
      const result = await listWorldAssetLibraryRenderables(apiUrl)
      if (!result.success) throw new Error(result.error)
      setAssets(result.assets)
    } catch (caught) {
      setAssetsError(caught instanceof Error ? caught.message : 'Assets could not be loaded.')
    } finally {
      setAssetsLoading(false)
    }
  }, [apiUrl])

  useEffect(() => {
    if (session) void refreshAssets()
  }, [refreshAssets, session?.snapshot.project.projectId])

  useEffect(() => {
    const issue = bridge.issues[0] ?? editor.initializationError ?? state.error?.message ?? null
    if (issue) setError(issue)
  }, [bridge.issues, editor.initializationError, state.error])

  const stopTimelinePreview = useCallback((restoreEditorAuthority = true) => {
    timelinePreviewController.stop()
    if (
      restoreEditorAuthority
      && playController.getState().lifecycle === 'edit'
      && !viewportCommitAuthority.isCurrent(viewportCommitLeaseRef.current)
    ) renewEditViewport()
  }, [playController, renewEditViewport, timelinePreviewController, viewportCommitAuthority])
  beforeAiApplyRef.current = () => stopTimelinePreview()

  const createTimelinePreviewInput = useCallback((sequenceId: string, fps: WorldSequenceFps): WorldTimelinePreviewInput | null => {
    if (!graphicsLease.isCurrent()) return null
    const current = controller.getState()
    if (!current.session || !current.activeSceneId || playController.getState().lifecycle !== 'edit') return null
    return {
      snapshot: current.session.snapshot,
      sceneId: current.activeSceneId,
      sequenceId,
      fps,
    }
  }, [controller, graphicsLease, playController])

  const handleTimelinePreviewPlay = useCallback((sequenceId: string, fps: WorldSequenceFps, time: WorldRationalTime) => {
    const input = createTimelinePreviewInput(sequenceId, fps)
    if (!input) return announceError('Timeline preview is only available while editing.')
    revokeEditViewport()
    try {
      timelinePreviewController.seek(input, time)
      timelinePreviewController.play(input)
      announceStatus('Previewing')
    } catch (caught) {
      stopTimelinePreview()
      announceError(caught instanceof Error ? caught.message : 'Timeline preview could not start.')
    }
  }, [announceError, announceStatus, createTimelinePreviewInput, revokeEditViewport, stopTimelinePreview, timelinePreviewController])

  const handleTimelinePreviewSeek = useCallback((sequenceId: string, fps: WorldSequenceFps, time: WorldRationalTime) => {
    const input = createTimelinePreviewInput(sequenceId, fps)
    if (!input) return announceError('Timeline preview is only available while editing.')
    revokeEditViewport()
    try {
      timelinePreviewController.seek(input, time)
    } catch (caught) {
      stopTimelinePreview()
      announceError(caught instanceof Error ? caught.message : 'Timeline preview could not seek.')
    }
  }, [announceError, createTimelinePreviewInput, revokeEditViewport, stopTimelinePreview, timelinePreviewController])

  const dispatchCommands = useCallback(async (
    commands: WorldCommand[],
    scope: string,
    expectedAuthority?: WorldEditorDispatchAuthority,
  ) => {
    if (commands.length === 0) return false
    stopTimelinePreview()
    const result = await editor.dispatchUiCommands(commands, scope, expectedAuthority)
    if (!result.ok) {
      announceError(result.error.message)
      return false
    }
    announceStatus('Saved')
    return true
  }, [announceError, announceStatus, editor, stopTimelinePreview])

  const handleGraphicsProfileChoice = useCallback(async (choice: WorldGraphicsProfileChoice) => {
    if (graphicsProfilePendingRef.current) return
    if (graphicsRecovery.getState().failure) return announceError('Resolve the graphics failure before changing quality.')
    const current = editor.controller.getState()
    if (!current.projectKey || !current.session || !current.activeSceneId) return announceError('Open a World project before changing quality.')
    if (playController.getState().lifecycle !== 'edit') return announceError('Quality can only be changed while editing.')
    const authority: WorldEditorDispatchAuthority = {
      projectKey: current.projectKey,
      projectId: current.session.snapshot.project.projectId,
      baseRevision: current.session.snapshot.project.revision,
      activeSceneId: current.activeSceneId,
    }
    let commands: WorldCommand[]
    try {
      commands = buildWorldGraphicsProfileSelectionCommands(current.session.snapshot, choice)
    } catch (caught) {
      announceError(caught instanceof Error ? caught.message : 'Quality could not be changed.')
      return
    }
    if (commands.length === 0) return
    graphicsProfilePendingRef.current = true
    setGraphicsProfilePending(true)
    cancelPendingPlayIntent()
    revokeEditViewport()
    try {
      const result = await editor.dispatchUiCommands(commands, 'graphics-profile', authority)
      if (!result.ok) {
        announceError(result.error.message)
        return
      }
      announceStatus('Quality saved')
    } finally {
      graphicsProfilePendingRef.current = false
      setGraphicsProfilePending(false)
      if (playController.getState().lifecycle === 'edit') renewEditViewport()
    }
  }, [announceError, announceStatus, cancelPendingPlayIntent, editor, playController, renewEditViewport, revokeEditViewport])

  const handlePlayResult = useCallback((result: WorldPlayControllerResult, successMessage?: string) => {
    if (!result.success) {
      if (result.issues[0]?.code === 'runtime-load-cancelled') return true
      announceError(result.issues[0]?.message ?? 'Play operation failed.')
      return false
    }
    if (successMessage) announceStatus(successMessage)
    return true
  }, [announceError, announceStatus])

  const handlePlay = useCallback(async () => {
    if (!graphicsLease.isCurrent()) return
    if (graphicsProfilePendingRef.current) return announceError('Wait for the quality change to finish before starting Play.')
    if (!session || !state.activeSceneId) return announceError('Open a World project before starting Play.')
    const barrier = await controller.cancelExternalCliIntents()
    if (!barrier.ok) return announceError('External edit cancellation could not be verified. Play remains closed.')
    const current = controller.getState()
    if (!graphicsLease.isCurrent() || current.session !== session || current.activeSceneId !== state.activeSceneId
      || current.editorEpoch !== state.editorEpoch) return announceError('World scope changed before Play could start.')
    // Keyboard activation has no pointer-down, so Play must revoke the edit viewport again here.
    timelinePreviewController.stop()
    cancelPendingPlayIntent()
    revokeEditViewport()
    const result = await playController.start(session, state.activeSceneId)
    handlePlayResult(result, 'Playing')
    if (playController.getState().lifecycle === 'edit') renewEditViewport()
  }, [announceError, cancelPendingPlayIntent, controller, graphicsLease, handlePlayResult, playController, renewEditViewport, revokeEditViewport, session, state.activeSceneId, timelinePreviewController])

  const handlePause = useCallback(async () => {
    handlePlayResult(await playController.pause(), 'Paused')
  }, [handlePlayResult, playController])

  const handleResume = useCallback(async () => {
    if (!graphicsLease.isCurrent()) return
    handlePlayResult(await playController.resume(), 'Playing')
  }, [graphicsLease, handlePlayResult, playController])

  const handleStop = useCallback(async () => {
    const result = await playController.stop()
    handlePlayResult(result, 'Play stopped')
    if (result.success && playController.getState().lifecycle === 'edit') renewEditViewport()
  }, [handlePlayResult, playController, renewEditViewport])

  const handleRuntimeAdvance = useCallback(async (timestampMs: number, input: Parameters<typeof playController.advance>[1]) => {
    handlePlayResult(await playController.advance(timestampMs, input))
  }, [handlePlayResult, playController])

  const handleNewProject = useCallback(async () => {
    stopTimelinePreview()
    const created = await editor.createProject()
    if (!created.ok) return announceError(created.error.message)
    resetForScene()
    renewEditViewport()
    setProjectPickerKey(created.value.projectKey ?? '')
    const refreshed = await editor.refreshProjects()
    if (!refreshed.ok) return announceError(refreshed.error.message)
    announceStatus('Project created')
  }, [announceError, announceStatus, editor, renewEditViewport, resetForScene, stopTimelinePreview])

  const handleOpenProject = useCallback(async () => {
    if (!projectPickerKey) return
    stopTimelinePreview()
    const opened = await editor.openProject(projectPickerKey)
    if (!opened.ok) return announceError(opened.error.message)
    resetForScene()
    renewEditViewport()
    announceStatus('Project opened')
  }, [announceError, announceStatus, editor, projectPickerKey, renewEditViewport, resetForScene, stopTimelinePreview])

  const handleScene = useCallback(async (sceneId: string) => {
    stopTimelinePreview()
    const changed = await editor.setActiveScene(sceneId)
    if (!changed.ok) return announceError(changed.error.message)
    resetForScene()
    renewEditViewport()
    announceStatus('Scene changed')
  }, [announceError, announceStatus, editor, renewEditViewport, resetForScene, stopTimelinePreview])

  const handleAddScene = useCallback(async () => {
    stopTimelinePreview()
    const added = await editor.addScene()
    if (!added.ok) return announceError(added.error.message)
    resetForScene()
    renewEditViewport()
    announceStatus('Scene added')
  }, [announceError, announceStatus, editor, renewEditViewport, resetForScene, stopTimelinePreview])

  const handleRecoverConflict = useCallback(async () => {
    stopTimelinePreview()
    const current = controller.getState()
    if (current.error?.code !== 'revision_conflict') return
    const previousSceneId = current.activeSceneId
    const refreshed = await controller.refresh()
    if (!refreshed.ok) return announceError(refreshed.error.message)
    if (previousSceneId && refreshed.value.session?.snapshot.scenes.some((candidate) => candidate.sceneId === previousSceneId)) {
      const restored = await controller.setActiveScene(previousSceneId)
      if (!restored.ok) return announceError(restored.error.message)
    }
    resetForScene()
    renewEditViewport()
    announceStatus('Project refreshed')
  }, [announceError, announceStatus, controller, renewEditViewport, resetForScene, stopTimelinePreview])

  const handleRenderRefresh = useCallback(async () => {
    stopTimelinePreview()
    const previousSceneId = controller.getState().activeSceneId
    const refreshed = await controller.refresh()
    if (!refreshed.ok) return announceError(refreshed.error.message)
    if (previousSceneId && refreshed.value.session?.snapshot.scenes.some((candidate) => candidate.sceneId === previousSceneId)) {
      const restored = await controller.setActiveScene(previousSceneId)
      if (!restored.ok) return announceError(restored.error.message)
    }
    resetForScene()
    renewEditViewport()
    announceStatus('Project refreshed')
  }, [announceError, announceStatus, controller, renewEditViewport, resetForScene, stopTimelinePreview])

  const handleUndo = useCallback(async () => {
    stopTimelinePreview()
    const result = await controller.undo()
    if (!result.ok) return announceError(result.error.message)
    announceStatus('Undone')
  }, [announceError, announceStatus, controller, stopTimelinePreview])

  const handleRedo = useCallback(async () => {
    stopTimelinePreview()
    const result = await controller.redo()
    if (!result.ok) return announceError(result.error.message)
    announceStatus('Redone')
  }, [announceError, announceStatus, controller, stopTimelinePreview])

  const handleDock = useCallback((dock: WorldsWorkbenchDock, trigger?: HTMLButtonElement) => {
    if (trigger) dockTriggerRef.current = trigger
    if (dock === 'scene' || dock === 'assets') setActiveLeftDock(dock)
    setOverlayDock(dock)
  }, [setActiveLeftDock, setOverlayDock])

  const closeOverlayDock = useCallback(() => {
    setOverlayDock(null)
  }, [setOverlayDock])

  const handleLeftDock = useCallback((dock: 'scene' | 'assets') => {
    setActiveLeftDock(dock)
    if (compact && overlayDock !== dock) setOverlayDock(dock)
  }, [compact, overlayDock, setActiveLeftDock, setOverlayDock])

  const handleTreeMutation = useCallback(async (mutation: WorldTreeMutation) => {
    const current = controller.getState()
    if (!current.session || !current.activeSceneId) return announceError('Open a World project before editing.')
    try {
      const commands = buildWorldTreeMutationCommands(current.session.snapshot, current.activeSceneId, mutation)
      if (!await dispatchCommands(commands, `tree-${mutation.type}`)) return
      if (mutation.type === 'delete') {
        const removed = new Set(mutation.entityIds)
        setSelection(selectedEntityIds.filter((entityId) => !removed.has(entityId)))
      } else if (mutation.type === 'duplicate') {
        const duplicated = commands
          .filter((command): command is Extract<WorldCommand, { type: 'add-entity' }> => command.type === 'add-entity')
          .map((command) => command.entity.id)
        if (duplicated.length > 0) setSelection(duplicated, duplicated.at(-1) ?? null)
      }
    } catch (caught) {
      announceError(caught instanceof Error ? caught.message : 'Scene edit failed.')
    }
  }, [announceError, controller, dispatchCommands, selectedEntityIds, setSelection])

  const duplicateSelection = useCallback(() => {
    if (selectedEntityIds.length === 0) return
    const identitiesSeed = createWorldUiTransactionId('duplicate')
    void handleTreeMutation({ type: 'duplicate', entityIds: selectedEntityIds, identitiesSeed })
  }, [handleTreeMutation, selectedEntityIds])

  const deleteSelection = useCallback(() => {
    if (selectedEntityIds.length > 0) void handleTreeMutation({ type: 'delete', entityIds: selectedEntityIds })
  }, [handleTreeMutation, selectedEntityIds])

  const addSceneEntity = useCallback(async (kind: AddSceneEntityKind) => {
    const current = controller.getState()
    if (!current.projectKey || !current.session || !current.activeSceneId) return announceError('Open a World project before editing.')
    const seed = createWorldUiTransactionId(`add-${kind}`)
    const context = {
      snapshot: current.session.snapshot,
      projectKey: current.projectKey,
      activeSceneId: current.activeSceneId,
      identities: createDeterministicWorldEditorIdentityGenerator(seed),
    }
    const currentScene = current.session.snapshot.scenes.find((candidate) => candidate.sceneId === current.activeSceneId)
    const existingCount = kind === 'empty'
      ? currentScene?.entities.filter((entity) => entity.components.length === 0).length ?? 0
      : currentScene?.entities.filter((entity) => entity.components.some((component) => component.type === kind)).length ?? 0
    const commands = kind === 'empty'
      ? buildAddEmptyEntityCommands(context, { name: `Empty ${existingCount + 1}` })
      : kind === 'camera'
        ? buildAddCameraCommands(context, { name: `Camera ${existingCount + 1}` })
        : buildAddLightCommands(context, { name: `Light ${existingCount + 1}`, lightKind: 'directional' })
    if (await dispatchCommands(commands, `add-${kind}`)) {
      const entityId = commands[0].entity.id
      setSelection([entityId], entityId)
    }
  }, [announceError, controller, dispatchCommands, setSelection])

  const addAsset = useCallback(async (asset: WorldAssetLibraryRenderable) => {
    if (pendingAssetRef.current !== null) return announceError('An asset is already being added.')
    const current = controller.getState()
    if (!current.projectKey || !current.session || !current.activeSceneId) return announceError('Open a World project before adding assets.')
    const audioAsset = asset.openable && 'audio' in asset
    if (!audioAsset && (!asset.openable || !('item' in asset))) return announceError('This asset is not compatible with the scene.')
    if (audioAsset && !activeEntityId) return announceError('Select an entity before attaching audio.')
    const expectedAuthority: WorldEditorDispatchAuthority = {
      projectKey: current.projectKey,
      projectId: current.session.snapshot.project.projectId,
      baseRevision: current.session.snapshot.project.revision,
      activeSceneId: current.activeSceneId,
    }
    pendingAssetRef.current = asset.id
    setAddingAssetId(asset.id)
    try {
      if (audioAsset) {
        const read = await readWorldAssetLibraryAudio({ workspacePath: asset.workspacePath })
        if (!read.success) throw new Error(read.error)
        const commands = buildAttachAudioSourceCommands({
          snapshot: current.session.snapshot,
          projectKey: current.projectKey,
          activeSceneId: current.activeSceneId,
          identities: createDeterministicWorldEditorIdentityGenerator(createWorldUiTransactionId('attach-audio')),
        }, activeEntityId!, read.audio)
        await dispatchCommands(commands, 'attach-audio', expectedAuthority)
        return
      }
      const opened = await openWorldAssetLibraryRenderable({ workspacePath: asset.workspacePath }, apiUrl)
      if (!opened.success) throw new Error(opened.error)
      if (!opened.asset.openable || !('item' in opened.asset)) throw new Error('This asset is not a compatible model.')
      const placed = appendWorldSceneItem(bridge.projection?.items ?? [], opened.asset.item, { selectedSceneItemId: activeEntityId })
      const item = placed.sceneItems.find((candidate) => candidate.id === placed.selectedSceneItemId) ?? opened.asset.item
      const seed = createWorldUiTransactionId('add-model')
      const commands = buildAddModelEntityCommands({
        snapshot: current.session.snapshot,
        projectKey: current.projectKey,
        activeSceneId: current.activeSceneId,
        identities: createDeterministicWorldEditorIdentityGenerator(seed),
      }, {
        workspacePath: item.workspacePath,
        format: item.kind,
        name: opened.asset.displayName,
        role: item.role,
        transform: item.transform,
      })
      if (await dispatchCommands(commands, 'add-model', expectedAuthority)) {
        const added = commands.find((command): command is Extract<WorldCommand, { type: 'add-entity' }> => command.type === 'add-entity')
        if (added) setSelection([added.entity.id], added.entity.id)
      }
    } catch (caught) {
      announceError(caught instanceof Error ? caught.message : 'Asset could not be added.')
    } finally {
      pendingAssetRef.current = null
      setAddingAssetId(null)
    }
  }, [activeEntityId, announceError, apiUrl, bridge.projection?.items, controller, dispatchCommands, setSelection])

  const convertLegacyScene = useCallback(async () => {
    if (!legacyAvailable || legacyResolved) return
    setLegacyConversionStarted(true)
    try {
      const manifest = buildWorldsSceneManifest(legacyScene.sceneItems, legacyScene.collisionSurfaces, {
        ...(legacyScene.initialView ? { initialView: legacyScene.initialView } : {}),
      })
      const imported = importLegacyWorldsSceneManifest(manifest, { projectName: 'Converted World', sceneName: 'Scene 1' })
      if (!imported.success) throw new Error(imported.issues[0]?.message ?? 'Legacy scene could not be converted.')
      let current = controller.getState()
      if (!current.session) {
        const created = await editor.createProject('Converted World')
        if (!created.ok) throw new Error(created.error.message)
        const refreshed = await editor.refreshProjects()
        if (!refreshed.ok) throw new Error(refreshed.error.message)
        current = controller.getState()
      }
      if (!current.projectKey || !current.session || !current.activeSceneId) throw new Error('Converted project is unavailable.')
      const seed = createWorldUiTransactionId('convert-legacy')
      const commands = buildImportLegacySceneCommands({
        snapshot: current.session.snapshot,
        projectKey: current.projectKey,
        activeSceneId: current.activeSceneId,
        identities: createDeterministicWorldEditorIdentityGenerator(seed),
      }, imported.snapshot, 'replace')
      if (!await dispatchCommands(commands, 'convert-legacy')) return
      setLegacyResolved(true)
      setLegacyConversionStarted(false)
      resetForScene()
      announceStatus('Legacy scene converted')
    } catch (caught) {
      announceError(caught instanceof Error ? caught.message : 'Legacy scene could not be converted.')
    }
  }, [announceError, announceStatus, controller, dispatchCommands, editor, legacyAvailable, legacyResolved, legacyScene, resetForScene])

  const persistenceIndicator = resolveWorldsPersistenceIndicator(state.lifecycle, state.error?.code ?? null)
  const saveStatus = persistenceIndicator.status
  const playActive = playState.lifecycle !== 'edit'
  const editorBusy = editor.initializing || state.lifecycle === 'loading' || addingAssetId !== null
  const busy = editorBusy || playActive
  animationBusyRef.current = busy || graphicsProfilePending
  const showLegacyOffer = legacyAvailable && !legacyResolved && (!session || legacyConversionStarted)

  const leftDock = !playActive && scene ? (
    <LeftDock
      active={activeLeftDock}
      onActive={handleLeftDock}
      scenePanel={<WorldsSceneDock
        scene={scene}
        selectedEntityIds={selectedEntityIds}
        activeEntityId={activeEntityId}
        expandedEntityIds={expandedEntityIds}
        focusedEntityId={focusedTreeEntityId}
        onSelection={setSelection}
        onExpanded={setExpandedEntityIds}
        onFocused={setFocusedTreeEntityId}
        onMutation={(mutation) => { void handleTreeMutation(mutation) }}
        onAddEntity={(kind) => { void addSceneEntity(kind) }}
      />}
      assetsPanel={<WorldsAssetsDock
        assets={assets}
        loading={assetsLoading}
        addingAssetId={addingAssetId}
        error={assetsError}
        onRefresh={() => { void refreshAssets() }}
        onAddAsset={(asset) => { void addAsset(asset) }}
      />}
    />
  ) : null
  const contextualItem = bridge.viewerProps.items.find((item) => item.id === bridge.viewerProps.selectedItemId && item.visible)
  const contextualToolsDisabled = busy || graphicsProfilePending || transformPending || !!timelinePreviewState.frame
  const isContextualToolsOwnerCurrent = () => {
    const current = controller.getState(), selection = useWorldsUiStore.getState()
    if (animationBusyRef.current || pendingAssetRef.current !== null || graphicsProfilePendingRef.current
      || transformAdmission.pending || timelinePreviewController.getState().frame || playController.getState().lifecycle !== 'edit'
      || !viewportCommitAuthority.isCurrent(viewportCommitLease) || current.lifecycle !== 'ready'
      || !snapshot || !scene || !contextualItem || !current.session || current.projectKey !== state.projectKey
      || current.activeSceneId !== scene.sceneId || current.session.snapshot.project.projectId !== snapshot.project.projectId
      || current.session.snapshot.project.revision !== snapshot.project.revision || selection.activeEntityId !== activeEntityId
      || selection.selectedEntityIds.length !== selectedEntityIds.length
      || !selectedEntityIds.every((id, index) => selection.selectedEntityIds[index] === id)) return false
    const currentScene = current.session.snapshot.scenes.find((candidate) => candidate.sceneId === scene.sceneId)
    return !!currentScene && selectedEntityIds.includes(contextualItem.id)
      && currentScene.entities.some((entity) => entity.id === contextualItem.id)
      && !selectedEntityIds.some((id) => isWorldEntityEffectivelyLocked(currentScene.entities, id))
  }
  const inspector = !playActive && snapshot && scene ? (
    <WorldsInspector
      projectKey={state.projectKey ?? snapshot.project.projectId}
      snapshot={snapshot}
      scene={scene}
      selectedEntityIds={selectedEntityIds}
      activeEntityId={activeEntityId}
      snapEnabled={snapEnabled}
      snapIncrement={snapIncrement}
      transformPending={transformPending}
      transformAdmission={transformAdmission}
      viewportTools={contextualItem ? {
        entityId: contextualItem.id,
        mode: bridge.viewerProps.transformMode ?? null,
        baseScene: contextualItem.role === 'base-scene',
        disabled: contextualToolsDisabled,
        onModeChange: (mode) => { if (isContextualToolsOwnerCurrent()) bridge.viewerProps.onTransformModeChange?.(mode) },
        onToggleBaseSceneItem: (id) => { if (id === contextualItem.id && isContextualToolsOwnerCurrent()) bridge.viewerProps.onToggleBaseSceneItem?.(id) },
      } : undefined}
      apiUrl={apiUrl}
      animationDisabled={animationBusyRef.current}
      isAnimationOwnerCurrent={(owner) => {
        const current = controller.getState()
        const selection = useWorldsUiStore.getState()
        if (animationBusyRef.current || pendingAssetRef.current !== null || graphicsProfilePendingRef.current
          || playController.getState().lifecycle !== 'edit' || current.lifecycle !== 'ready'
          || !current.session || current.projectKey !== owner.projectKey || current.activeSceneId !== owner.sceneId
          || current.session.snapshot.project.projectId !== owner.projectId || current.session.snapshot.project.revision !== owner.baseRevision
          || selection.selectedEntityIds.length !== 1 || selection.activeEntityId !== owner.entityId || selection.selectedEntityIds[0] !== owner.entityId) return false
        const model = getWorldGltfAnimationModel(current.session.snapshot, owner.sceneId, owner.entityId)
        const currentScene = current.session.snapshot.scenes.find((candidate) => candidate.sceneId === owner.sceneId)
        return !!model && model.id === owner.modelResourceId && model.workspacePath === owner.modelWorkspacePath
          && !!currentScene && !isWorldEntityEffectivelyLocked(currentScene.entities, owner.entityId)
      }}
      onSnap={setSnap}
      onCommands={(commands, scope, expectedAuthority) => dispatchCommands(commands, scope, expectedAuthority ?? {
        projectKey: state.projectKey ?? snapshot.project.projectId,
        projectId: snapshot.project.projectId,
        baseRevision: snapshot.project.revision,
        activeSceneId: scene.sceneId,
      })}
      onError={announceError}
    />
  ) : null
  const timelineFrame = timelinePreviewState.frame
  const timelineProjectionResult = timelineFrame
    ? projectWorldEditorViewport(timelineFrame.snapshot, timelineFrame.sceneId, apiUrl)
    : null
  const timelineProjection = timelineProjectionResult?.success ? timelineProjectionResult.value : null
  const viewerProps = timelineFrame && timelineProjection ? {
    ...bridge.viewerProps,
    project: timelineFrame.snapshot.project,
    items: timelineProjection.items,
    collisionSurfaces: timelineProjection.collisionSurfaces,
    initialView: timelineProjection.initialView ?? undefined,
    environment: timelineProjection.environment,
    lights: timelineProjection.lights,
    useStudioLights: timelineProjection.useStudioLights,
    selectedItemId: null,
    selectedItemIds: [],
    pendingSurfacePlacementItemId: null,
    collisionEditMode: false,
    selectedCollisionSurfaceId: null,
    transformMode: null,
    onSelectItem: () => undefined,
    onTransformModeChange: () => undefined,
    onTransformItem: () => undefined,
    onTransformItems: () => undefined,
    onRemoveItem: () => undefined,
    onToggleBaseSceneItem: () => undefined,
    onSceneItemAnchorChange: () => undefined,
    onCommitPendingSurfacePlacement: () => undefined,
    onClearPendingSurfacePlacement: () => undefined,
    timelinePreview: {
      timeSeconds: worldRationalTimeToSeconds(timelineFrame.time),
      animationStates: timelineFrame.animationStates,
      activeCamera: timelineFrame.activeCamera ? {
        entityId: timelineFrame.activeCamera.entityId,
        component: timelineFrame.activeCamera.component,
        transform: timelineFrame.activeCamera.worldTransform,
      } : null,
    },
  } : bridge.viewerProps
  const liveMessage = error ?? graphicsMessage ?? status
  const liveMessageIsError = !!error

  return (
    <section ref={rootRef} className={`worlds-workbench${playActive ? ' is-playing' : ''}`} aria-label="Worlds editor">
      <WorldsProjectBar
        projects={state.projects}
        projectKey={state.projectKey}
        projectPickerKey={projectPickerKey}
        scenes={snapshot?.project.scenes ?? []}
        activeSceneId={state.activeSceneId}
        saveStatus={saveStatus}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
        selectionCount={selectionLocked ? 0 : selectedEntityIds.length}
        busy={busy}
        playState={playState.lifecycle}
        canPlay={!graphicsState.failure && !editorBusy && !graphicsProfilePending && !!session && !!state.activeSceneId}
        graphicsProfiles={snapshot?.project.graphicsProfiles ?? []}
        activeGraphicsProfileId={snapshot?.project.activeGraphicsProfileId ?? null}
        graphicsProfilePending={graphicsProfilePending}
        graphicsUnavailable={!!graphicsState.failure}
        onGraphicsProfileChoice={(choice) => { void handleGraphicsProfileChoice(choice) }}
        onProjectPickerKey={setProjectPickerKey}
        onOpenProject={() => { void handleOpenProject() }}
        onNewProject={() => { void handleNewProject() }}
        onScene={(sceneId) => { void handleScene(sceneId) }}
        onAddScene={() => { void handleAddScene() }}
        onUndo={() => { void handleUndo() }}
        onRedo={() => { void handleRedo() }}
        onDuplicate={duplicateSelection}
        onDelete={deleteSelection}
        onLegacyExport={() => setLegacyExportOpen(true)}
        onRecoverConflict={handleRecoverConflict}
        onPlayIntent={handlePlayIntent}
        onPlay={() => { void handlePlay() }}
        onPause={() => { void handlePause() }}
        onResume={() => { void handleResume() }}
        onStop={() => { void handleStop() }}
        onDock={handleDock}
      />

      <div className="worlds-workbench__body">
        {!playActive ? (compact ? <DockRail side="left" onDock={handleDock} /> : <aside className="worlds-workbench__dock worlds-workbench__dock--left" aria-label="World scene and assets">{leftDock}</aside>) : null}
        <div className="worlds-workbench__viewport" aria-label="World viewport">
          <WorldViewportBoundary key={graphicsState.attempt} failure={graphicsState.failure} lease={graphicsLease} onRetry={handleViewportRetry} retryDisabled={playActive}>
            {playState.lifecycle === 'edit' ? (
            <WorldsViewer key={editViewportResetKey} {...viewerProps} showAuthoringToolbar={false} showPlaybackControls={false} onGraphicsDiagnostic={handleActiveGraphicsDiagnostic} onGraphicsFailure={graphicsLease.fail} />
            ) : playState.runtimeSnapshot && playState.sceneId ? (
              <WorldRuntimeViewport
                key={playState.generationId}
                snapshot={playState.runtimeSnapshot}
                sceneId={playState.sceneId}
                apiUrl={apiUrl}
                lifecycle={playState.lifecycle}
                bodyPoses={playState.bodyPoses}
                animationRequests={playState.animationRequests}
                onAdvance={handleRuntimeAdvance}
                onError={announceError}
                onGraphicsDiagnostic={handleActiveGraphicsDiagnostic}
                onGraphicsFailure={graphicsLease.fail}
              />
            ) : (
              <div className="world-runtime-viewport is-loading is-loading-shell" aria-label="Play viewport" role="status">Loading</div>
            )}
          </WorldViewportBoundary>
          {playState.lifecycle === 'edit' && editor.initializing ? <EmptyState heading="Loading Worlds" detail="Opening recent project…" /> : playState.lifecycle === 'edit' && !session ? (
            <EmptyState
              heading={showLegacyOffer ? 'Legacy scene found' : state.projects.length > 0 ? 'No compatible project' : 'Create a World'}
              detail={showLegacyOffer ? 'Convert it to keep editing.' : 'Start with a project and scene.'}
              actions={<>
                {showLegacyOffer ? <button type="button" className="worlds-button worlds-button--primary" onClick={() => { void convertLegacyScene() }}>Convert</button> : null}
                <button type="button" className="worlds-button" onClick={() => { void handleNewProject() }}>New</button>
              </>}
            />
          ) : playState.lifecycle === 'edit' && showLegacyOffer ? (
            <div className="worlds-workbench__legacy-offer" role="status">
              <span>Legacy scene ready</span>
              <button type="button" className="worlds-button worlds-button--primary" onClick={() => { void convertLegacyScene() }}>Convert</button>
            </div>
          ) : null}
          {liveMessage ? <div className={`worlds-workbench__status${liveMessageIsError ? ' is-error' : ''}`} role={liveMessageIsError ? 'alert' : 'status'} aria-live={liveMessageIsError ? 'assertive' : 'polite'}>{liveMessage}</div> : null}
        </div>
        {!playActive ? (compact ? <DockRail side="right" onDock={handleDock} /> : <aside className="worlds-workbench__dock worlds-workbench__dock--right" aria-label="World inspector">{inspector}</aside>) : null}

        {!playActive && compact && overlayDock ? (
          <div
            ref={overlayRef}
            className={`worlds-workbench__overlay ${overlayDock === 'inspector' ? 'is-right' : 'is-left'}`}
            role="dialog"
            aria-modal="true"
            aria-label={`${overlayDock === 'inspector' ? 'Inspector' : overlayDock === 'assets' ? 'Assets' : 'Scene'} dock`}
            onKeyDown={(event) => {
              if (event.key === 'Tab') trapWorldsOverlayFocus(event)
              else if (event.key === 'Escape' && !event.defaultPrevented) closeOverlayDock()
            }}
          >
            <Tooltip content="Close dock">
              <button type="button" className="worlds-workbench__overlay-close worlds-icon-button" aria-label="Close dock" onClick={closeOverlayDock}>×</button>
            </Tooltip>
            {overlayDock === 'inspector' ? inspector : leftDock}
          </div>
        ) : null}
      </div>

      {!playActive && snapshot && scene ? <div className="worlds-workbench__bottom"><WorldsTimelineDrawer
        projectKey={state.projectKey!}
        snapshot={snapshot}
        scene={scene}
        previewState={timelinePreviewState}
        disabled={editorBusy}
        onCommands={(commands, scope) => { void dispatchCommands(commands, scope) }}
        onPreviewPlay={handleTimelinePreviewPlay}
        onPreviewPause={() => timelinePreviewController.pause()}
        onPreviewStop={() => stopTimelinePreview()}
        onPreviewSeek={handleTimelinePreviewSeek}
        onRefreshProject={() => { void handleRenderRefresh() }}
        onError={announceError}
      /><WorldsAiDrawer adapter={aiAdapter} disabled={editorBusy || state.lifecycle !== 'ready'} canUndo={state.canUndo} /></div> : null}

      <WorldsLegacyExportDialog
        open={legacyExportOpen}
        snapshot={snapshot}
        sceneId={state.activeSceneId}
        onClose={() => setLegacyExportOpen(false)}
        onStatus={announceStatus}
        onError={announceError}
      />
    </section>
  )
}

function LeftDock({
  active,
  onActive,
  scenePanel,
  assetsPanel,
}: {
  active: 'scene' | 'assets'
  onActive(value: 'scene' | 'assets'): void
  scenePanel: JSX.Element
  assetsPanel: JSX.Element
}): JSX.Element {
  return (
    <div className="worlds-left-dock">
      <div className="worlds-left-dock__tabs" role="tablist" aria-label="World editor dock">
        <button type="button" role="tab" aria-label="Scene" data-worlds-dock="scene" aria-selected={active === 'scene'} className={active === 'scene' ? 'is-active' : ''} onClick={() => onActive('scene')}>Scene</button>
        <button type="button" role="tab" aria-label="Assets" data-worlds-dock="assets" aria-selected={active === 'assets'} className={active === 'assets' ? 'is-active' : ''} onClick={() => onActive('assets')}>Assets</button>
      </div>
      {active === 'scene' ? scenePanel : assetsPanel}
    </div>
  )
}

function DockRail({ side, onDock }: { side: 'left' | 'right'; onDock(dock: WorldsWorkbenchDock, trigger: HTMLButtonElement): void }): JSX.Element {
  return (
    <aside className={`worlds-workbench__rail worlds-workbench__rail--${side}`} aria-label={`${side === 'left' ? 'Scene and assets' : 'Inspector'} rail`}>
      {side === 'left' ? <>
        <Tooltip content="Scene dock"><button type="button" className="worlds-icon-button" aria-label="Open Scene dock" onClick={(event) => onDock('scene', event.currentTarget)}>☷</button></Tooltip>
        <Tooltip content="Assets dock"><button type="button" className="worlds-icon-button" aria-label="Open Assets dock" onClick={(event) => onDock('assets', event.currentTarget)}>⬡</button></Tooltip>
      </> : <Tooltip content="Inspector dock"><button type="button" className="worlds-icon-button" aria-label="Open Inspector dock" onClick={(event) => onDock('inspector', event.currentTarget)}>⚙</button></Tooltip>}
    </aside>
  )
}

function EmptyState({ heading, detail, actions }: { heading: string; detail: string; actions?: JSX.Element }): JSX.Element {
  return (
    <div className="worlds-workbench__empty">
      <strong>{heading}</strong>
      <p>{detail}</p>
      {actions ? <div className="worlds-workbench__empty-actions">{actions}</div> : null}
    </div>
  )
}

export default WorldsWorkbench

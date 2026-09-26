import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import type { WorldProjectSummary } from '../../../shared/types/worldProjects.ts'

import type { WorldCommand } from '../core/worldCommands.ts'
import {
  buildAddSceneCommands,
  createDeterministicWorldEditorIdentityGenerator,
} from './worldEditorCommandBuilders.ts'
import {
  worldEditorController,
  type WorldEditorController,
  type WorldEditorControllerResult,
  type WorldEditorControllerState,
  type WorldEditorDispatchAuthority,
  type WorldEditorDispatchSuccess,
} from './worldEditorController.ts'

let transactionCounter = 0

export function createWorldUiTransactionId(scope: string): string {
  transactionCounter = (transactionCounter + 1) % Number.MAX_SAFE_INTEGER
  const safeScope = scope.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'edit'
  return `tx:ui-${safeScope}-${Date.now().toString(36)}-${transactionCounter.toString(36)}`
}

export async function initializeWorldEditorController(
  controller: WorldEditorController,
): Promise<WorldEditorControllerResult<WorldEditorControllerState>> {
  const listed = await controller.listProjects()
  if (!listed.ok) return listed
  const current = controller.getState()
  if (current.session) return { ok: true, value: current }
  const recent = listed.value.find((project) => project.status === 'ready')
  if (!recent) return { ok: true, value: controller.getState() }
  return controller.openProject(recent.projectKey)
}

export interface UseWorldEditorControllerResult {
  controller: WorldEditorController
  state: WorldEditorControllerState
  initializing: boolean
  initializationError: string | null
  refreshProjects(): Promise<WorldEditorControllerResult<readonly WorldProjectSummary[]>>
  createProject(name?: string): Promise<WorldEditorControllerResult<WorldEditorControllerState>>
  openProject(projectKey: string): Promise<WorldEditorControllerResult<WorldEditorControllerState>>
  setActiveScene(sceneId: string): Promise<WorldEditorControllerResult<WorldEditorControllerState>>
  addScene(name?: string): Promise<WorldEditorControllerResult<WorldEditorDispatchSuccess>>
  dispatchUiCommands(
    commands: WorldCommand[],
    scope: string,
    expectedAuthority?: WorldEditorDispatchAuthority,
  ): Promise<WorldEditorControllerResult<WorldEditorDispatchSuccess>>
}

export function useWorldEditorController(
  controller: WorldEditorController = worldEditorController,
): UseWorldEditorControllerResult {
  const state = useSyncExternalStore(controller.subscribe.bind(controller), controller.getState.bind(controller), controller.getState.bind(controller))
  const initializedRef = useRef(false)
  const [initializing, setInitializing] = useState(false)
  const [initializationError, setInitializationError] = useState<string | null>(null)

  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true
    let active = true
    setInitializing(true)
    initializeWorldEditorController(controller).then((result) => {
      if (!active) return
      setInitializationError(result.ok ? null : result.error.message)
    }).finally(() => {
      if (active) setInitializing(false)
    })
    return () => { active = false }
  }, [controller])

  const dispatchUiCommands = useCallback(async (
    commands: WorldCommand[],
    scope: string,
    expectedAuthority?: WorldEditorDispatchAuthority,
  ) => {
    const current = controller.getState()
    if (!current.projectKey || !current.session || !current.activeSceneId) {
      return {
        ok: false as const,
        error: { code: 'project_closed' as const, message: 'Open a World project before editing.', retryable: false },
      }
    }
    return controller.dispatchCommands({ transactionId: createWorldUiTransactionId(scope), origin: 'ui', commands }, expectedAuthority ?? {
      projectKey: current.projectKey,
      projectId: current.session.snapshot.project.projectId,
      baseRevision: current.session.snapshot.project.revision,
      activeSceneId: current.activeSceneId,
    })
  }, [controller])

  const addScene = useCallback(async (name?: string) => {
    const current = controller.getState()
    if (!current.projectKey || !current.session) {
      return { ok: false as const, error: { code: 'project_closed' as const, message: 'Open a World project before adding a scene.', retryable: false } }
    }
    const sceneName = name?.trim() || `Scene ${current.session.snapshot.scenes.length + 1}`
    const transactionId = createWorldUiTransactionId('add-scene')
    const commands = buildAddSceneCommands({
      snapshot: current.session.snapshot,
      projectKey: current.projectKey,
      identities: createDeterministicWorldEditorIdentityGenerator(transactionId),
    }, { name: sceneName })
    const applied = await controller.dispatchCommands({ transactionId, origin: 'ui', commands }, {
      projectKey: current.projectKey,
      projectId: current.session.snapshot.project.projectId,
      baseRevision: current.session.snapshot.project.revision,
      activeSceneId: current.activeSceneId ?? current.session.snapshot.project.startSceneId,
    })
    if (applied.ok) await controller.setActiveScene(commands[0].scene.sceneId)
    return applied
  }, [controller])

  return {
    controller,
    state,
    initializing,
    initializationError,
    refreshProjects: () => controller.listProjects(),
    createProject: (name) => controller.createProject({
      name: name?.trim() || `Untitled World ${state.projects.filter((project) => project.status === 'ready').length + 1}`,
      initialSceneName: 'Scene 1',
    }),
    openProject: (projectKey) => controller.openProject(projectKey),
    setActiveScene: (sceneId) => controller.setActiveScene(sceneId),
    addScene,
    dispatchUiCommands,
  }
}

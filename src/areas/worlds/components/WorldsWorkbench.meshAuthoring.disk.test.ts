import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import { WORLD_COMMAND_BATCH_SCHEMA, type WorldProjectSnapshotV1 } from '../core/worldModel.ts'
import type { WorldCommand, WorldCommandBatchV1 } from '../core/worldCommands.ts'
import { createWorldProjectService } from '../worldProjectService.ts'
import { buildAddSceneCommands, createDeterministicWorldEditorIdentityGenerator } from '../editor/worldEditorCommandBuilders.ts'
import type { WorldEditorController } from '../editor/worldEditorController.ts'
import type { AssetLibraryEntry } from '../../../shared/types/assetLibrary.ts'

const require = createRequire(import.meta.url)
const React = require('react') as typeof import('react')
const Reconciler = require('react-reconciler')
const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(currentDir, '../../../..')
const workbenchEntry = path.join(currentDir, 'WorldsWorkbench.tsx')
const controllerEntry = path.join(currentDir, '../editor/worldEditorController.ts')
const uiStoreEntry = path.join(currentDir, '../editor/worldsUiStore.ts')

type Host = { type: string; props: Record<string, unknown>; children: Host[]; getBoundingClientRect(): { width: number }; querySelector(selector: string): Host | null; focus(): void }
type Service = ReturnType<typeof createWorldProjectService>
type RepositoryCtor = new (options: { getWorkspaceRoot: () => string; createProjectKey?: () => string; createSceneKey?: () => string; now?: () => Date }) => unknown
type WorkbenchMeshModule = { WorldsWorkbench: React.ComponentType; worldEditorController: WorldEditorController; useWorldsUiStore: { getState(): { transformMode: string | null; setSelection(ids: readonly string[], active?: string | null): void } }; useAppStore: { setState(value: { apiUrl: string }): void } }
type HarnessGlobal = typeof globalThis & { __worldsMeshDiskHarness?: ReturnType<typeof resetHarness> }

test('mounted real Assets Add and installed glTF loader author exact clips, rebind and reopen without changing model bytes', async () => {
  const evidenceRoot = await mkdtemp(path.join(tmpdir(), 'modly-worlds-animation-authoring-evidence-'))
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'modly-worlds-animation-authoring-workspace-'))
  await mkdir(path.join(workspaceRoot, 'Assets'), { recursive: true })
  const model = Buffer.from(makeAnimationGlb())
  const textModel = makeAnimationGltf()
  await writeFile(path.join(workspaceRoot, 'Assets/Hero.glb'), model)
  await writeFile(path.join(workspaceRoot, 'Assets/Delayed.glb'), model)
  await writeFile(path.join(workspaceRoot, 'Assets/Empty.glb'), Buffer.from(makeMountedGlb()))
  await writeFile(path.join(workspaceRoot, 'Assets/Broken.glb'), 'not a glTF file')
  await writeFile(path.join(workspaceRoot, 'Assets/TextHero.gltf'), JSON.stringify(textModel.json))
  await writeFile(path.join(workspaceRoot, 'Assets/unrelated.txt'), 'preserve this exact byte sequence')
  const assetHashes = await recursiveHashes(path.join(workspaceRoot, 'Assets'))
  const entries: AssetLibraryEntry[] = ['Hero', 'Delayed', 'Empty', 'Broken', 'TextHero'].map((name) => ({ id: `asset:${name}`, workspacePath: `Assets/${name}.${name === 'TextHero' ? 'gltf' : 'glb'}`, displayName: name, sourceScope: 'exports', capability: 'rigged-mesh', state: 'ready', previewKind: '3d-model', warnings: [] }))
  const projectKey = `world-${'d'.repeat(32)}`
  const Repository = await loadRepositoryCtor()
  const service = createWorldProjectService(new Repository({ getWorkspaceRoot: () => workspaceRoot, createProjectKey: () => projectKey, createSceneKey: () => `scene-${'d'.repeat(32)}` }) as never)
  const setupController = (await import(pathToFileURL(controllerEntry).href) as { createWorldEditorController(service: Service): WorldEditorController }).createWorldEditorController(service)
  const created = await setupController.createProject({ name: 'Animation Gate', initialSceneName: 'Clips' })
  assert.equal(created.ok, true, created.ok ? undefined : created.error.message)
  await setupController.closeProject()
  const metrics = resetHarness()
  const originalFetch = globalThis.fetch
  const originalProgressEvent = Object.getOwnPropertyDescriptor(globalThis, 'ProgressEvent')
  // The Node host lacks the browser progress event used by the unchanged installed FileLoader.
  if (!originalProgressEvent) Object.defineProperty(globalThis, 'ProgressEvent', { configurable: true, value: class ProgressEvent extends Event { lengthComputable: boolean; loaded: number; total: number; constructor(type: string, options: { lengthComputable?: boolean; loaded?: number; total?: number } = {}) { super(type); this.lengthComputable = options.lengthComputable ?? false; this.loaded = options.loaded ?? 0; this.total = options.total ?? 0 } } })
  const requested: string[] = []
  let releaseDelayed: (() => void) | undefined
  let releaseOpen: (() => void) | undefined
  const delayed = new Promise<void>((resolve) => { releaseDelayed = resolve })
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === textModel.uri) {
      requested.push('TextHero embedded buffer')
      return new Response(textModel.buffer, { headers: { 'content-length': String(textModel.buffer.byteLength) } })
    }
    const relative = decodeURIComponent(url.slice(url.indexOf('/workspace/') + '/workspace/'.length))
    assert.ok(url.includes('/workspace/') && entries.some((entry) => entry.workspacePath === relative), `unexpected fetch ${url}`)
    requested.push(relative)
    if (relative === 'Assets/Delayed.glb') await delayed
    const bytes = await readFile(path.join(workspaceRoot, relative))
    return new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } })
  }
  const loaded = await loadWorkbenchModule(service, entries)
  const host = mounted()
  const controller = loaded.module.worldEditorController
  const select = (id: string) => loaded.module.useWorldsUiStore.getState().setSelection([id], id)
  const current = () => controller.getState().session!.snapshot
  const player = (entityId: string) => current().scenes[0].entities.find((entity) => entity.id === entityId)!.components.find((component) => component.type === 'animation-player')
  try {
    host.render(React.createElement(loaded.module.WorldsWorkbench))
    await waitFor(host, () => !!controller.getState().session)
    assert.ok(metrics.hookCalls > 0)
    assert.ok(metrics.hookControllerMatchesExport.every(Boolean))
    ;(requireNode(host, (node) => node.props['data-worlds-dock'] === 'assets', 'Assets tab').props.onClick as () => void)()
    await waitFor(host, () => !!find(host.container, (node) => node.props['aria-label'] === 'Add Hero to scene'))
    click(host, 'Add Hero to scene')
    await waitFor(host, () => current().scenes[0].entities.some((entity) => entity.name === 'Hero'))
    const heroId = current().scenes[0].entities.find((entity) => entity.name === 'Hero')!.id
    await settle(host, 6)
    assert.equal(requested.length, 0, 'Discovery must be an explicit human action, not asset import.')
    click(host, 'Load animation clips')
    await waitFor(host, () => text(host.container).includes('Choose clip') && !!find(host.container, (node) => node.type === 'option' && node.props.value === 'clip:1'))
    const clipSelect = () => selectByLabelInSection(host, 'Animation', 'Clip')
    assert.equal(clipSelect().props.value, '')
    assert.equal(requireNode(host, (node) => node.props['aria-label'] === 'Create animation and add player', 'Create+Add').props.disabled, true)
    assert.ok(text(host.container).includes('Duplicate · 2'))
    changeSelect(clipSelect(), 'clip:1')
    await settle(host, 2)
    click(host, 'Create animation and add player')
    await waitFor(host, () => !!player(heroId))
    const firstPlayer = player(heroId)!
    assert.equal(firstPlayer.type, 'animation-player')
    const firstResource = current().project.resources.find((resource) => resource.type === 'animation')!
    assert.equal(firstResource.type === 'animation' ? firstResource.clipIndex : undefined, 1)
    assert.equal(firstResource.type === 'animation' ? firstResource.clipName : undefined, 'Duplicate')
    assert.deepEqual(current().scenes[0].entities.find((entity) => entity.id === heroId)!.components.filter((component) => component.type === 'renderable').map((component) => component.type === 'renderable' ? component.resourceId : null), [current().project.resources.find((resource) => resource.type === 'model')!.id])
    const speed = selectByLabelInSection(host, 'Animation player', 'Speed')
    ;(speed.props.onChange as (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value: '-2' } })
    await settle(host, 2)
    ;(selectByLabelInSection(host, 'Animation player', 'Speed').props.onBlur as () => void)()
    await waitFor(host, () => player(heroId)?.type === 'animation-player' && player(heroId)!.speed === -2)
    click(host, 'Load animation clips')
    await waitFor(host, () => !!find(host.container, (node) => node.type === 'option' && node.props.value === 'clip:0'))
    changeSelect(clipSelect(), 'clip:0')
    await settle(host, 2)
    const beforeRebind = structuredClone(current())
    click(host, 'Assign animation')
    await waitFor(host, () => player(heroId)?.type === 'animation-player' && player(heroId)!.resourceId !== firstResource.id)
    const rebound = structuredClone(current())
    const reboundPlayer = player(heroId)!
    const reboundResource = rebound.project.resources.at(-1)!
    assert.deepEqual(reboundPlayer, { ...firstPlayer, speed: -2, resourceId: reboundResource.id })
    assert.equal(reboundResource.type, 'animation')
    if (reboundResource.type === 'animation') assert.equal(reboundResource.clipIndex, 0)
    click(host, 'Undo')
    await waitFor(host, () => player(heroId)?.type === 'animation-player' && player(heroId)!.resourceId === firstResource.id)
    assert.deepEqual(current().project.resources, beforeRebind.project.resources)
    assert.deepEqual(current().scenes, beforeRebind.scenes)
    click(host, 'Redo')
    await waitFor(host, () => player(heroId)?.type === 'animation-player' && player(heroId)!.resourceId === reboundPlayer.resourceId)
    assert.deepEqual(current().project.resources, rebound.project.resources)
    assert.deepEqual(current().scenes, rebound.scenes)
    const resourceSelect = selectByLabelInSection(host, 'Animation', 'Resource')
    changeSelect(resourceSelect, firstResource.id)
    await settle(host, 2)
    click(host, 'Assign animation')
    await waitFor(host, () => player(heroId)?.type === 'animation-player' && player(heroId)!.resourceId === firstResource.id)
    assert.equal(current().project.resources.length, rebound.project.resources.length)
    click(host, 'Add Camera')
    await waitFor(host, () => current().scenes[0].entities.find((entity) => entity.id === heroId)!.components.some((component) => component.type === 'camera'))
    click(host, 'Make primary camera')
    await waitFor(host, () => current().scenes[0].entities.find((entity) => entity.id === heroId)!.components.some((component) => component.type === 'camera' && component.primary))
    changeSelect(selectByLabelInSection(host, 'Animation', 'Resource'), reboundPlayer.resourceId)
    await settle(host, 2)
    const stalePlayAssign = requireNode(host, (node) => node.props['aria-label'] === 'Assign animation', 'Assign before Play').props.onClick as () => void
    const beforePlay = sessionProof(controller)
    click(host, 'Play World')
    await waitFor(host, () => !!find(host.container, (node) => node.type === 'world-runtime-viewport'))
    stalePlayAssign()
    await settle(host, 4)
    assert.deepEqual(sessionProof(controller), beforePlay, 'An old Inspector callback cannot author during Play.')
    click(host, 'Stop World')
    await waitFor(host, () => !!find(host.container, (node) => node.props['aria-label'] === 'Load animation clips'))
    assert.deepEqual(sessionProof(controller), beforePlay)
    select(heroId)
    await settle(host, 2)
    changeSelect(selectByLabelInSection(host, 'Animation', 'Resource'), reboundPlayer.resourceId)
    await settle(host, 2)
    const staleLockAssign = requireNode(host, (node) => node.props['aria-label'] === 'Assign animation', 'Assign before parent lock').props.onClick as () => void
    const sceneId = current().scenes[0].sceneId
    await dispatch(controller, projectKey, 'tx:animation-parent-lock', [
      { type: 'add-entity', sceneId, entity: { id: 'entity:animation-parent', name: 'Parent', parentId: null, enabled: true, locked: false, tags: [], transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: [] } },
      { type: 'reparent-entity', sceneId, entityId: heroId, parentId: 'entity:animation-parent' },
      { type: 'patch-entity', sceneId, entityId: 'entity:animation-parent', patch: { locked: true } },
    ])
    await settle(host, 4)
    const locked = sessionProof(controller)
    assert.equal(requireNode(host, (node) => node.props['aria-label'] === 'Assign animation', 'Locked Assign').props.disabled, true)
    staleLockAssign()
    await settle(host, 4)
    assert.deepEqual(sessionProof(controller), locked)
    assert.equal((await controller.undo()).ok, true)
    await settle(host, 4)
    const expected = structuredClone(current())
    // A pending old-owner loader result must never expose authoring controls on the new owner.
    changeSelect(selectByLabelInSection(host, 'Animation', 'Resource'), reboundPlayer.resourceId)
    await settle(host, 2)
    const staleBusyAssign = requireNode(host, (node) => node.props['aria-label'] === 'Assign animation', 'Assign before busy').props.onClick as () => void
    metrics.assetOpenGate = async () => new Promise<void>((resolve) => { releaseOpen = resolve })
    host.batch(() => { click(host, 'Add Delayed to scene'); staleBusyAssign() })
    await waitFor(host, () => !!releaseOpen && requireNode(host, (node) => node.props['aria-label'] === 'Load animation clips', 'Busy loader').props.disabled === true)
    staleBusyAssign()
    await settle(host, 4)
    // A same-scene no-op joins the real controller queue, so a forbidden old callback cannot hide behind disk I/O.
    assert.equal((await controller.setActiveScene(sceneId)).ok, true)
    assert.deepEqual(current().project.resources, expected.project.resources)
    assert.deepEqual(current().scenes, expected.scenes)
    metrics.assetOpenGate = null
    releaseOpen!()
    await waitFor(host, () => current().scenes[0].entities.some((entity) => entity.name === 'Delayed'))
    await settle(host, 4)
    click(host, 'Load animation clips')
    await waitFor(host, () => requested.includes('Assets/Delayed.glb'))
    select(heroId)
    await settle(host, 4)
    releaseDelayed!()
    await settle(host, 16)
    assert.equal(find(host.container, (node) => node.type === 'option' && String(node.props.value).startsWith('clip:')), undefined)
    assert.deepEqual(current().scenes[0].entities.find((entity) => entity.id === heroId)!.components, expected.scenes[0].entities.find((entity) => entity.id === heroId)!.components)
    const delayedId = current().scenes[0].entities.find((entity) => entity.name === 'Delayed')!.id
    select(delayedId)
    await settle(host, 4)
    click(host, 'Load animation clips')
    await waitFor(host, () => !!find(host.container, (node) => node.type === 'option' && node.props.value === 'clip:2'))
    changeSelect(clipSelect(), 'clip:2')
    await settle(host, 2)
    click(host, 'Create animation')
    await waitFor(host, () => current().project.resources.filter((resource) => resource.type === 'animation').length === 3)
    const zero = current().project.resources.at(-1)!
    assert.equal(zero.type, 'animation')
    if (zero.type === 'animation') { assert.equal(zero.clipIndex, 2); assert.equal(zero.clipName, 'Zero'); assert.equal(Object.hasOwn(zero, 'durationSeconds'), false) }
    assert.equal(player(delayedId), undefined, 'Create alone must not silently add a player.')
    changeSelect(selectByLabelInSection(host, 'Animation', 'Resource'), zero.id)
    await settle(host, 2)
    click(host, 'Add Animation Player')
    await waitFor(host, () => !!player(delayedId))
    assert.equal(player(delayedId)!.resourceId, zero.id)
    assert.equal(current().project.resources.filter((resource) => resource.type === 'animation').length, 3)
    click(host, 'Add TextHero to scene')
    await waitFor(host, () => current().scenes[0].entities.some((entity) => entity.name === 'TextHero'))
    const textHeroId = current().scenes[0].entities.find((entity) => entity.name === 'TextHero')!.id
    await settle(host, 4)
    click(host, 'Load animation clips')
    await waitFor(host, () => !!find(host.container, (node) => node.type === 'option' && node.props.value === 'clip:3'))
    changeSelect(clipSelect(), 'clip:3')
    await settle(host, 2)
    click(host, 'Create animation and add player')
    await waitFor(host, () => !!player(textHeroId))
    const textClip = current().project.resources.find((resource) => resource.id === player(textHeroId)!.resourceId)!
    assert.equal(textClip.type, 'animation')
    if (textClip.type === 'animation') { assert.equal(textClip.clipIndex, 3); assert.equal(Object.hasOwn(textClip, 'clipName'), false); assert.equal(textClip.durationSeconds, 2); assert.equal(textClip.workspacePath, 'Assets/TextHero.gltf') }
    assert.ok(requested.includes('Assets/TextHero.gltf'))
    assert.ok(requested.includes('TextHero embedded buffer'))
    click(host, 'Add Empty to scene')
    await waitFor(host, () => current().scenes[0].entities.some((entity) => entity.name === 'Empty'))
    await settle(host, 4)
    click(host, 'Load animation clips')
    await waitFor(host, () => text(host.container).includes('No animation clips'))
    click(host, 'Add Broken to scene')
    await waitFor(host, () => current().scenes[0].entities.some((entity) => entity.name === 'Broken'))
    await settle(host, 4)
    click(host, 'Load animation clips')
    await waitFor(host, () => text(host.container).includes('Clips could not load'))
    assert.equal(current().project.resources.filter((resource) => resource.type === 'animation').length, 4)
    const final = structuredClone(current())
    await writeEvidence(evidenceRoot, 'authored.json', final)
    assert.deepEqual(await recursiveHashes(path.join(workspaceRoot, 'Assets')), assetHashes)
    host.render(null)
    await settle(host, 4)
    await controller.closeProject()
    const fresh = createWorldProjectService(new Repository({ getWorkspaceRoot: () => workspaceRoot }) as never)
    const reopened = await fresh.open({ projectKey })
    assert.equal(reopened.ok, true)
    if (!reopened.ok) throw new Error('Fresh repository reopen rejected.')
    assert.equal(reopened.value.status, 'ready')
    if (reopened.value.status !== 'ready') throw new Error('Fresh repository returned an unsupported document.')
    assert.deepEqual(reopened.value.snapshot, final)
    assert.deepEqual(await recursiveHashes(path.join(workspaceRoot, 'Assets')), assetHashes)
    await writeEvidence(evidenceRoot, 'summary.json', { evidenceRoot, workspaceRoot, requested, assetHashes, actual: 'Production Workbench, Inspector, AssetsDock, asset service, controller, command bus, repository and installed Drei useGLTF/FileLoader/GLTFLoader. Private workspace fetch shim and browser ProgressEvent fixture only; viewport/physics/audio remain unchanged mesh harness stubs. No native/GPU/audio/performance acceptance.' })
  } catch (error) {
    await writeEvidence(evidenceRoot, 'failure.json', { evidenceRoot, workspaceRoot, text: text(host.container), message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null })
    throw error
  } finally {
    metrics.assetOpenGate = null
    releaseOpen?.()
    releaseDelayed!()
    host.render(null)
    globalThis.fetch = originalFetch
    if (originalProgressEvent) Object.defineProperty(globalThis, 'ProgressEvent', originalProgressEvent)
    else Reflect.deleteProperty(globalThis, 'ProgressEvent')
    await loaded.cleanup()
  }
})

test('mounted Workbench rapid numeric component edits reject stale drafts, retry, undo and reopen through disk authority', async () => {
  const evidenceRoot = await mkdtemp(path.join(tmpdir(), 'modly-worlds-component-number-evidence-'))
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'modly-worlds-component-number-workspace-'))
  await mkdir(path.join(workspaceRoot, 'Assets'))
  await writeFile(path.join(workspaceRoot, 'Assets/collider.glb'), Buffer.from(makeMountedGlb()))
  await writeFile(path.join(workspaceRoot, 'Assets/renderable.glb'), Buffer.from(makeMountedGlb()))
  await writeFile(path.join(workspaceRoot, 'Assets/unrelated.txt'), 'preserve component number fixture bytes')
  const assetHashes = await recursiveHashes(path.join(workspaceRoot, 'Assets'))
  const projectKey = `world-${'e'.repeat(32)}`
  let sceneKey = 0
  const Repository = await loadRepositoryCtor()
  const service = createWorldProjectService(new Repository({ getWorkspaceRoot: () => workspaceRoot, createProjectKey: () => projectKey, createSceneKey: () => `scene-${String(++sceneKey).padStart(32, 'e')}` }) as never)
  const setupController = (await import(pathToFileURL(controllerEntry).href) as { createWorldEditorController(service: Service): WorldEditorController }).createWorldEditorController(service)
  await seedMeshAuthoringProject(setupController, projectKey)
  await setupController.closeProject()
  const metrics = resetHarness()
  const apply = service.applyCommands.bind(service)
  let release!: () => void
  let defer = true
  let applies = 0
  service.applyCommands = async (request) => {
    applies += 1
    if (defer) { defer = false; await new Promise<void>((resolve) => { release = resolve }) }
    return apply(request)
  }
  const loaded = await loadWorkbenchModule(service)
  const host = mounted()
  const controller = loaded.module.worldEditorController
  const current = () => controller.getState().session!.snapshot
  const collider = () => {
    const value = current().scenes[0].entities.find((entity) => entity.id === 'entity:collider')!.components.find((component) => component.id === 'component:box')!
    assert.equal(value.type, 'collider')
    if (value.type !== 'collider') throw new Error('Missing fixture collider.')
    return value
  }
  const commit = (label: string, value: string) => {
    const input = selectByLabelInSection(host, 'Collider', label)
    assert.equal(input.props.disabled, false)
    ;(input.props.onChange as (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value } })
    host.flush()
    ;(selectByLabelInSection(host, 'Collider', label).props.onBlur as () => void)()
  }
  try {
    host.render(React.createElement(loaded.module.WorldsWorkbench))
    await waitFor(host, () => controller.getState().lifecycle === 'ready')
    await settle(host, 4)
    loaded.module.useWorldsUiStore.getState().setSelection(['entity:collider'], 'entity:collider')
    await settle(host, 4)
    const before = sessionProof(controller)
    const beforeFiles = await recursiveHashes(workspaceRoot)
    commit('Friction', '0.6')
    await waitFor(host, () => !!release)
    assert.deepEqual(sessionProof(controller), before)
    assert.deepEqual(await recursiveHashes(workspaceRoot), beforeFiles, 'No optimistic disk publication while apply is held.')
    commit('Restitution', '0.7')
    release()
    await waitFor(host, () => controller.getState().error?.code === 'revision_conflict')
    await settle(host, 4)
    assert.equal(collider().friction, 0.6)
    assert.equal(collider().restitution, 0)
    assert.equal(selectByLabelInSection(host, 'Collider', 'Restitution').props.value, '0')
    assert.ok(text(host.container).includes('World editor authority changed while commands were prepared.'))
    assert.equal(applies, 1, 'Stale replacement must not reach the disk service.')
    assert.equal(controller.getState().session!.undoStack.length, before.undoStack.length + 1)
    click(host, 'Undo')
    await waitFor(host, () => collider().friction === 0.5)
    assert.equal(controller.getState().session!.undoStack.length, before.undoStack.length)
    click(host, 'Redo')
    await waitFor(host, () => collider().friction === 0.6)
    commit('Restitution', '0.7')
    await waitFor(host, () => collider().restitution === 0.7)
    assert.equal(controller.getState().session!.undoStack.length, before.undoStack.length + 2)
    click(host, 'Undo')
    await waitFor(host, () => collider().restitution === 0)
    click(host, 'Redo')
    await waitFor(host, () => collider().restitution === 0.7)
    const final = structuredClone(current())
    assert.deepEqual(await recursiveHashes(path.join(workspaceRoot, 'Assets')), assetHashes)
    host.render(null)
    await controller.closeProject()
    const fresh = createWorldProjectService(new Repository({ getWorkspaceRoot: () => workspaceRoot }) as never)
    const reopened = await fresh.open({ projectKey })
    assert.ok(reopened.ok && reopened.value.status === 'ready')
    if (!reopened.ok || reopened.value.status !== 'ready') throw new Error('Fresh fixture reopen rejected.')
    assert.deepEqual(reopened.value.snapshot, final)
    assert.deepEqual(await recursiveHashes(path.join(workspaceRoot, 'Assets')), assetHashes)
    assert.equal(metrics.physicsInitialized, 0)
    await writeEvidence(evidenceRoot, 'summary.json', { evidenceRoot, workspaceRoot, before, final, assetHashes, applies, actual: 'Mounted production Workbench, Inspector, hook, controller, command bus and disk repository; only first IPC-like apply delivery deferred. Viewer/runtime viewport, physics/audio, scene/assets/timeline/AI docks and Electron transport are fixture stubs; selection seeded through production store. Native/perceptual/GPU/latency UNTESTED.' })
    console.log(`Component numeric disk evidence: ${evidenceRoot}`)
  } catch (error) {
    await writeEvidence(evidenceRoot, 'failure.json', { evidenceRoot, workspaceRoot, text: text(host.container), state: controller.getState(), message: error instanceof Error ? error.message : String(error) })
    console.log(`Component numeric disk failure evidence: ${evidenceRoot}`)
    throw error
  } finally {
    release?.()
    host.render(null)
    await loaded.cleanup()
  }
})

test('mounted canonical contextual tools preserve base tags, revision ownership, pending isolation and relative Assets Add through disk reopen', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'worlds-contextual-tools-disk-')), Repository = await loadRepositoryCtor()
  await mkdir(path.join(workspace, 'Assets'))
  for (const name of ['collider', 'renderable', 'relative']) await writeFile(path.join(workspace, `Assets/${name}.glb`), Buffer.from(makeMountedGlb()))
  const key = `world-${'e'.repeat(32)}`, service = createWorldProjectService(new Repository({ getWorkspaceRoot: () => workspace, createProjectKey: () => key }) as never)
  const setup = (await import(pathToFileURL(controllerEntry).href)).createWorldEditorController(service) as WorldEditorController
  await seedMeshAuthoringProject(setup, key)
  const sceneId = setup.getState().activeSceneId!, id = 'entity:collider'
  await dispatch(setup, key, 'tx:contextual-setup', [{ type: 'patch-entity', sceneId, entityId: id, patch: { tags: ['preserve'], transform: { position: [12, 2, -4], rotation: [0, 0, 0], scale: [1, 1, 1] } } }])
  await setup.closeProject()
  let hold = false, release: (() => void) | undefined
  const applies: unknown[] = []
  const gatedService = { ...service, async applyCommands(request: Parameters<Service['applyCommands']>[0]) {
    applies.push(request)
    if (hold) { hold = false; await new Promise<void>((resolve) => { release = resolve }) }
    return service.applyCommands(request)
  } }
  resetHarness()
  const entry: AssetLibraryEntry = { id: 'asset:relative', workspacePath: 'Assets/relative.glb', displayName: 'Relative', sourceScope: 'exports', capability: 'mesh', state: 'ready', previewKind: '3d-model', warnings: [] }
  const loaded = await loadWorkbenchModule(gatedService, [entry]), host = mounted(), controller = loaded.module.worldEditorController
  const snapshot = () => controller.getState().session!.snapshot
  const entity = () => snapshot().scenes.find((scene) => scene.sceneId === sceneId)!.entities.find((entity) => entity.id === id)!
  const ui = () => loaded.module.useWorldsUiStore.getState()
  const button = (label: string) => requireNode(host, (node) => node.props['aria-label'] === label, label)
  const viewer = () => requireNode(host, (node) => node.type === 'worlds-viewer', 'Viewer')
  try {
    host.render(React.createElement(loaded.module.WorldsWorkbench))
    await waitFor(host, () => controller.getState().lifecycle === 'ready')
    ui().setSelection([id], id); await settle(host, 4)
    assert.equal(viewer().props.showAuthoringToolbar, false)
    const beforeModes = sessionProof(controller)
    for (const [label, mode] of [['Rotate selected asset', 'rotate'], ['Scale selected asset', 'scale'], ['Move selected asset', 'translate'], ['Move selected asset', null]] as const) {
      click(host, label); await settle(host, 2); assert.equal(ui().transformMode, mode); assert.equal(viewer().props.transformMode, mode)
    }
    assert.deepEqual(sessionProof(controller), beforeModes)
    click(host, 'Move selected asset'); await settle(host, 2)
    const beforeBase = structuredClone(snapshot())
    click(host, 'Set selected asset as base world')
    await waitFor(host, () => entity().tags.includes('modly:base-scene'))
    assert.deepEqual(entity().tags, ['preserve', 'modly:base-scene'])
    assert.equal(snapshot().project.revision, beforeBase.project.revision + 1)
    assert.equal(button('Unset selected asset as base world').props['aria-pressed'], true)
    click(host, 'Undo'); await waitFor(host, () => !entity().tags.includes('modly:base-scene'))
    assert.deepEqual(snapshot().scenes, beforeBase.scenes)
    click(host, 'Redo'); await waitFor(host, () => entity().tags.includes('modly:base-scene'))
    const staleBase = button('Unset selected asset as base world').props.onClick as () => void
    const staleMode = button('Rotate selected asset').props.onClick as () => void
    await dispatch(controller, key, 'tx:contextual-new-revision', [{ type: 'patch-entity', sceneId, entityId: id, patch: { name: 'Current base' } }])
    const revised = sessionProof(controller), revisedFiles = await recursiveHashes(workspace), count = applies.length
    staleBase(); staleMode(); await settle(host, 4)
    assert.deepEqual(sessionProof(controller), revised); assert.deepEqual(await recursiveHashes(workspace), revisedFiles); assert.equal(applies.length, count)
    const staleSelection = button('Unset selected asset as base world').props.onClick as () => void
    ui().setSelection([]); await settle(host, 2); staleSelection(); await settle(host, 2)
    assert.equal(find(host.container, (node) => node.props['aria-label'] === 'Move selected asset'), undefined)
    assert.deepEqual(sessionProof(controller), revised)
    ui().setSelection([id], id); await settle(host, 2)
    const heldBase = button('Unset selected asset as base world').props.onClick as () => void
    const v = viewer().props, gesture = (v.onTransformGestureBegin as (ids: string[]) => unknown)([id])
    assert.ok(gesture)
    hold = true
    ;(v.onTransformItem as (id: string, transform: unknown, meta: unknown) => void)(id, { ...structuredClone(entity().transform), position: [13, 2, -4] }, { gesture })
    await waitFor(host, () => !!release)
    assert.equal(button('Unset selected asset as base world').props.disabled, true)
    assert.equal(button('Rotate selected asset').props.disabled, true)
    assert.equal(viewer().props.transformMode, 'translate', 'The real viewport gizmo mode must remain available for admission-denial testing.')
    heldBase(); await settle(host, 2); assert.deepEqual(sessionProof(controller), revised)
    release!(); await waitFor(host, () => entity().transform.position[0] === 13); await settle(host, 4)
    const lockBase = button('Unset selected asset as base world').props.onClick as () => void
    await dispatch(controller, key, 'tx:contextual-lock-parent', [
      { type: 'add-entity', sceneId, entity: { id: 'entity:tools-parent', name: 'Parent', parentId: null, enabled: true, locked: false, tags: [], transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: [] } },
      { type: 'reparent-entity', sceneId, entityId: id, parentId: 'entity:tools-parent' },
      { type: 'patch-entity', sceneId, entityId: 'entity:tools-parent', patch: { locked: true } },
    ])
    await settle(host, 4); const locked = sessionProof(controller)
    assert.equal(button('Unset selected asset as base world').props.disabled, true)
    lockBase(); await settle(host, 2); assert.deepEqual(sessionProof(controller), locked)
    click(host, 'Undo'); await waitFor(host, () => entity().parentId === null); await settle(host, 4)
    ui().setSelection([]); await settle(host, 2)
    ;(requireNode(host, (node) => node.props['data-worlds-dock'] === 'assets', 'Assets tab').props.onClick as () => void)()
    await waitFor(host, () => !!find(host.container, (node) => node.props['aria-label'] === 'Add Relative to scene'))
    click(host, 'Add Relative to scene')
    await waitFor(host, () => snapshot().scenes.find((scene) => scene.sceneId === sceneId)!.entities.some((entity) => entity.name === 'Relative'))
    assert.deepEqual(snapshot().scenes.find((scene) => scene.sceneId === sceneId)!.entities.find((entity) => entity.name === 'Relative')!.transform.position, [14.75, 2, -4])
    const final = structuredClone(snapshot()), assetHashes = await recursiveHashes(path.join(workspace, 'Assets'))
    host.render(null); await controller.closeProject()
    const reopened = await createWorldProjectService(new Repository({ getWorkspaceRoot: () => workspace }) as never).open({ projectKey: key })
    assert.ok(reopened.ok && reopened.value.status === 'ready')
    if (reopened.ok && reopened.value.status === 'ready') assert.deepEqual(reopened.value.snapshot, final)
    assert.deepEqual(await recursiveHashes(path.join(workspace, 'Assets')), assetHashes)
    console.log(`Contextual tools disk workspace: ${workspace}; mounted production Inspector/Workbench/bridge/controller/bus/repository/Assets Add, Viewer/physics/audio stubbed; native obstruction and GPU/latency UNTESTED.`)
  } finally { release?.(); host.render(null); await loaded.cleanup() }
})

function resetHarness() {
  const value = { physicsInitialized: 0, physicsDisposed: 0, audioPrepared: 0, audioStopped: 0, physicsScenes: [] as unknown[], runtimeSnapshots: [] as WorldProjectSnapshotV1[], hookCalls: 0, hookControllerMatchesExport: [] as boolean[], assetOpenGate: null as (() => Promise<void>) | null }
  ;(globalThis as HarnessGlobal).__worldsMeshDiskHarness = value
  return value
}

test('mounted Workbench real Inspector authors mesh colliders through disk persistence and default Play geometry loading', async () => {
  const evidenceRoot = process.env.MODLY_WORLDS_MESH_AUTHORING_DISK_EVIDENCE ?? await mkdtemp(path.join(tmpdir(), 'modly-worlds-mesh-authoring-disk-evidence-'))
  await mkdir(evidenceRoot, { recursive: true })
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'modly-worlds-mesh-authoring-disk-workspace-'))
  await mkdir(path.join(workspaceRoot, 'Assets'), { recursive: true })
  await writeFile(path.join(workspaceRoot, 'Assets/collider.glb'), Buffer.from(makeMountedGlb()))
  await writeFile(path.join(workspaceRoot, 'Assets/renderable.glb'), Buffer.from(makeMountedGlb()))
  const projectKey = `world-${'c'.repeat(32)}`
  const sceneKeys = [`scene-${'a'.repeat(32)}`, `scene-${'b'.repeat(32)}`]
  let nextSceneKey = 0
  const Repository = await loadRepositoryCtor()
  const service = createWorldProjectService(new Repository({ getWorkspaceRoot: () => workspaceRoot, createProjectKey: () => projectKey, createSceneKey: () => sceneKeys[nextSceneKey++] ?? `scene-${String(nextSceneKey).padStart(32, 'c')}`, now: () => new Date('2026-09-08T00:00:00.000Z') }) as never)
  const setupController = (await import(pathToFileURL(controllerEntry).href) as { createWorldEditorController(service: Service): WorldEditorController }).createWorldEditorController(service)
  const setupSnapshot = await seedMeshAuthoringProject(setupController, projectKey)
  await writeEvidence(evidenceRoot, '00-setup-snapshot.json', setupSnapshot)
  await writeEvidence(evidenceRoot, '00-setup-file-hashes.json', await recursiveHashes(workspaceRoot))

  const metrics = resetHarness()
  const originalFetch = globalThis.fetch
  const requested: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    requested.push(url)
    const suffix = '/workspace/'
    const index = url.indexOf(suffix)
    assert.notEqual(index, -1, `unexpected fetch url ${url}`)
    const relative = decodeURIComponent(url.slice(index + suffix.length))
    const bytes = await readFile(path.join(workspaceRoot, relative))
    return new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } })
  }
  const loaded = await loadWorkbenchModule(service)
  try {
    const host = mounted()
    host.render(React.createElement(loaded.module.WorldsWorkbench))
    const controller = loaded.module.worldEditorController
    for (let attempt = 0; attempt < 200 && !controller.getState().session && !controller.getState().error; attempt += 1) await settle(host, 2)
    assert.deepEqual(controller.getState().session?.snapshot, setupSnapshot)
    assert.equal(metrics.hookCalls > 0, true)
    assert.equal(metrics.hookControllerMatchesExport.every(Boolean), true)
    loaded.module.useWorldsUiStore.getState().setSelection(['entity:collider'], 'entity:collider')
    await settle(host, 4)

    click(host, 'Add Fixed Body')
    await waitFor(host, () => controller.getState().session!.snapshot.scenes[0].entities.find((candidate) => candidate.id === 'entity:collider')!.components.some((component) => component.type === 'rigid-body'))
    const afterBody = controller.getState().session!.snapshot.scenes[0].entities.find((candidate) => candidate.id === 'entity:collider')!
    assert.equal(afterBody.components.filter((component) => component.type === 'collider' && component.shape === 'box').length, 1)
    changeSelect(selectByLabelInSection(host, 'Add component', 'Mesh source'), 'resource:collider')
    await waitFor(host, () => selectByLabelInSection(host, 'Add component', 'Mesh source').props.value === 'resource:collider')
    click(host, 'Add Static Mesh')
    await waitFor(host, () => controller.getState().session!.snapshot.scenes[0].entities.find((candidate) => candidate.id === 'entity:collider')!.components.some((component) => component.type === 'collider' && component.shape === 'mesh'))
    let authored = controller.getState().session!.snapshot
    const entity = authored.scenes[0].entities.find((candidate) => candidate.id === 'entity:collider')!
    const collider = entity.components.find((component) => component.type === 'collider' && component.shape === 'mesh')
    if (!collider) await writeEvidence(evidenceRoot, 'debug-after-static-add.json', { text: text(host.container), components: entity.components })
    assert.equal(collider?.type, 'collider')
    if (collider?.type === 'collider') {
      assert.equal(collider.shape, 'mesh')
      if (collider.shape === 'mesh') assert.equal(collider.resourceId, 'resource:collider')
    }
    assert.equal(entity.components.filter((component) => component.type === 'collider' && component.shape === 'box').length, 1)
    const body = entity.components.find((component) => component.type === 'rigid-body')
    assert.equal(body?.type, 'rigid-body')
    assert.equal(body?.type === 'rigid-body' ? body.bodyType : null, 'fixed')

    const beforeConflict = structuredClone(authored)
    changeSelect(selectByLabelInSection(host, 'Rigid body', 'Type'), 'dynamic')
    await settle(host, 12)
    assert.deepEqual(controller.getState().session!.snapshot, beforeConflict)
    assert.match(text(host.container), /fixed body/i)

    click(host, 'Undo')
    await waitFor(host, () => !controller.getState().session!.snapshot.scenes[0].entities.find((candidate) => candidate.id === 'entity:collider')!.components.some((component) => component.type === 'collider' && component.shape === 'mesh'))
    click(host, 'Redo')
    await waitFor(host, () => controller.getState().session!.snapshot.scenes[0].entities.find((candidate) => candidate.id === 'entity:collider')!.components.some((component) => component.type === 'collider' && component.shape === 'mesh'))
    authored = structuredClone(controller.getState().session!.snapshot)
    const beforePlaySession = sessionProof(controller)
    await writeEvidence(evidenceRoot, '01-authored-session.json', sessionProof(controller))
    const beforePlayHashes = await recursiveHashes(workspaceRoot)
    await writeEvidence(evidenceRoot, '01-before-play-file-hashes.json', beforePlayHashes)

    click(host, 'Play World')
    for (let attempt = 0; attempt < 240 && metrics.physicsInitialized < 1 && !text(host.container).includes('could not'); attempt += 1) await settle(host, 2)
    if (metrics.physicsInitialized < 1) await writeEvidence(evidenceRoot, 'debug-play-not-started.json', { text: text(host.container), playButton: findLast(host.container, (node) => node.props['aria-label'] === 'Play World')?.props, state: controller.getState() })
    assert.equal(metrics.physicsInitialized, 1)
    assert.equal(requested.some((url) => url.endsWith('/workspace/Assets/collider.glb')), true)
    const scene = metrics.physicsScenes[0] as { bodies: Array<{ entityId: string; colliders: Array<{ shape: { kind: string; vertices?: Float32Array; indices?: Uint32Array } }> }> }
    const shape = scene.bodies.find((candidate) => candidate.entityId === 'entity:collider')?.colliders.map((collider) => collider.shape).find((shape) => shape.kind === 'trimesh')
    assert.equal(shape?.kind, 'trimesh')
    assert.deepEqual([...(shape?.vertices ?? new Float32Array())], [0, 0, 0, 1, 0, 0, 0, 1, 0])
    assert.deepEqual([...(shape?.indices ?? new Uint32Array())], [0, 1, 2])

    click(host, 'Stop World')
    await settle(host, 24)
    assert.equal(metrics.physicsDisposed, 1)
    assert.equal(metrics.audioStopped, 1)
    assert.deepEqual(controller.getState().session!.snapshot, authored)
    assert.deepEqual(sessionProof(controller), beforePlaySession)
    assert.deepEqual(await recursiveHashes(workspaceRoot), beforePlayHashes)
    await writeEvidence(evidenceRoot, '02-after-stop-session.json', sessionProof(controller))
    await writeEvidence(evidenceRoot, '02-after-stop-file-hashes.json', await recursiveHashes(workspaceRoot))
    host.render(null)
    await settle(host, 8)
    await controller.closeProject()
    await loaded.cleanup()

    const reopened = await loadWorkbenchModule(createWorldProjectService(new Repository({ getWorkspaceRoot: () => workspaceRoot }) as never))
    try {
      const reopenedHost = mounted()
      reopenedHost.render(React.createElement(reopened.module.WorldsWorkbench))
      const reopenedController = reopened.module.worldEditorController
      for (let attempt = 0; attempt < 200 && !reopenedController.getState().session && !reopenedController.getState().error; attempt += 1) await settle(reopenedHost, 2)
      const reopenedSnapshot = reopenedController.getState().session!.snapshot
      const reopenedEntity = reopenedSnapshot.scenes[0].entities.find((candidate) => candidate.id === 'entity:collider')!
      const reopenedCollider = reopenedEntity.components.find((component) => component.id === 'component:box')
      assert.equal(reopenedCollider?.type, 'collider')
      const reopenedMesh = reopenedEntity.components.find((component) => component.type === 'collider' && component.shape === 'mesh')
      assert.equal(reopenedMesh?.type, 'collider')
      if (reopenedMesh?.type === 'collider' && reopenedMesh.shape === 'mesh') assert.equal(reopenedMesh.resourceId, 'resource:collider')
      assert.deepEqual(reopenedSnapshot, authored)
      assert.deepEqual(await recursiveHashes(workspaceRoot), beforePlayHashes)
      await writeEvidence(evidenceRoot, '03-reopened-session.json', sessionProof(reopenedController))
      await writeEvidence(evidenceRoot, '03-reopened-file-hashes.json', await recursiveHashes(workspaceRoot))
      await reopenedController.closeProject()
    } finally {
      await reopened.cleanup()
    }

    await writeEvidence(evidenceRoot, '99-summary.json', { workspaceRoot, evidenceRoot, projectKey, requested, setupRevision: setupSnapshot.project.revision, authoredRevision: authored.project.revision, actualUiBoundary: 'Mounted production WorldsWorkbench, WorldsProjectBar and real WorldsInspector. Selection was seeded through production worldsUiStore before using rendered Inspector/ProjectBar host controls.', playBoundary: 'Production Play controller default geometry loader fetched actual GLB bytes from the private /tmp workspace through a bounded fetch shim and passed numeric trimesh DTOs to a stub physics port.', stubs: ['Transparent production hook observer', 'Canvas/viewer implementation', 'Runtime viewport DOM', 'asset library', 'physics port', 'audio port', 'Electron IPC transport object'] })
  } catch (error) {
    await writeEvidence(evidenceRoot, 'failure.json', { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null })
    throw error
  } finally {
    globalThis.fetch = originalFetch
    await loaded.cleanup().catch(() => undefined)
  }
})

async function loadRepositoryCtor(): Promise<RepositoryCtor> {
  const importer = Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<{ WorldProjectRepository: RepositoryCtor }>
  const module = await importer(pathToFileURL(path.join(repo, 'electron/main/world-project-repository.ts')).href)
  return module.WorldProjectRepository
}

async function seedMeshAuthoringProject(controller: WorldEditorController, projectKey: string): Promise<WorldProjectSnapshotV1> {
  const created = await controller.createProject({ name: 'Mesh authoring disk workflow', initialSceneName: 'Mesh Gate' })
  assert.equal(created.ok, true)
  const state = controller.getState()
  assert.ok(state.session && state.activeSceneId)
  await dispatch(controller, projectKey, 'tx:seed-resources', [
    { type: 'add-resource', resource: { id: 'resource:renderable', type: 'model', name: 'Renderable mesh', workspacePath: 'Assets/renderable.glb', format: 'glb' } },
    { type: 'add-resource', resource: { id: 'resource:collider', type: 'model', name: 'Collider mesh', workspacePath: 'Assets/collider.glb', format: 'glb' } },
  ])
  await dispatch(controller, projectKey, 'tx:seed-entity', [{ type: 'add-entity', sceneId: state.activeSceneId, entity: {
    id: 'entity:collider',
    name: 'Collider Source',
    parentId: null,
    enabled: true,
    locked: false,
    tags: [],
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [
      { id: 'component:renderable', type: 'renderable', enabled: true, resourceId: 'resource:renderable', visible: true, castShadow: true, receiveShadow: true, material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 } },
      { id: 'component:camera', type: 'camera', enabled: true, projection: 'perspective', primary: true, near: 0.1, far: 100, fieldOfView: 60 },
      { id: 'component:box', type: 'collider', enabled: true, purpose: 'simulation', shape: 'box', halfExtents: [0.5, 0.5, 0.5], sensor: false, friction: 0.5, restitution: 0, collisionLayer: 1, collisionMask: 0xffff },
    ],
  } }])
  const addScene = buildAddSceneCommands({ snapshot: controller.getState().session!.snapshot, projectKey, identities: createDeterministicWorldEditorIdentityGenerator('mesh-authoring-scene-two') }, { name: 'Second Gate' })
  await dispatch(controller, projectKey, 'tx:seed-second-scene', addScene)
  const snapshot = structuredClone(controller.getState().session!.snapshot)
  assert.deepEqual(snapshot.project.scenes.map((scene) => scene.name), ['Mesh Gate', 'Second Gate'])
  assert.deepEqual(snapshot.project.resources.map((resource) => resource.id), ['resource:renderable', 'resource:collider'])
  return snapshot
}

async function dispatch(controller: WorldEditorController, projectKey: string, transactionId: string, commands: WorldCommand[]): Promise<void> {
  const state = controller.getState()
  assert.ok(state.session && state.activeSceneId)
  const result = await controller.dispatchCommands({ transactionId, origin: 'ui', commands })
  assert.equal(result.ok, true, result.ok ? undefined : `${result.error.code}: ${result.error.message}`)
}

async function loadWorkbenchModule(service: Service, assets?: AssetLibraryEntry[]): Promise<{ module: WorkbenchMeshModule; cleanup(): Promise<void> }> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'worlds-workbench-mesh-disk-mounted-'))
  const mockDir = path.join(tempDir, 'mocks')
  await mkdir(mockDir, { recursive: true })
  await symlink(path.join(repo, 'node_modules'), path.join(tempDir, 'node_modules'), 'dir')
  await writeFile(path.join(tempDir, 'package.json'), '{"type":"module"}')
  await writeFile(path.join(tempDir, 'entry.ts'), `export { WorldsWorkbench } from ${JSON.stringify(workbenchEntry)}\nexport { worldEditorController } from ${JSON.stringify(controllerEntry)}\nexport { useWorldsUiStore } from ${JSON.stringify(uiStoreEntry)}\nexport { useAppStore } from ${JSON.stringify(path.join(repo, 'src/shared/stores/appStore.ts'))}\n`)
  await writeFile(path.join(mockDir, 'css-empty.mjs'), '')
  await writeFile(path.join(mockDir, 'useWorldEditorControllerObserver.mjs'), `
import { worldEditorController } from ${JSON.stringify(controllerEntry)}
import { useWorldEditorController as realUseWorldEditorController, createWorldUiTransactionId, initializeWorldEditorController } from ${JSON.stringify(path.join(currentDir, '../editor/useWorldEditorController.ts'))}
export { createWorldUiTransactionId, initializeWorldEditorController }
export function useWorldEditorController(controller = worldEditorController) {
  const result = realUseWorldEditorController(controller)
  globalThis.__worldsMeshDiskHarness.hookCalls += 1
  globalThis.__worldsMeshDiskHarness.hookControllerMatchesExport.push(result.controller === worldEditorController)
  return result
}
`)
  await writeFile(path.join(mockDir, 'WorldsViewer.mjs'), `import React from 'react'; export default function WorldsViewer(props) { return React.createElement('worlds-viewer', { ...props, 'aria-label': 'Worlds 3D canvas', activeGraphicsProfileId: props.project.activeGraphicsProfileId }) }`)
  await writeFile(path.join(mockDir, 'WorldRuntimeViewport.mjs'), `import React from 'react'; export default function WorldRuntimeViewport(props) { globalThis.__worldsMeshDiskHarness.runtimeSnapshots.push(structuredClone(props.snapshot)); return React.createElement('world-runtime-viewport', { lifecycle: props.lifecycle }) }`)
  const simpleComponent = (name: string) => `import React from 'react'; export default function ${name}(props) { return React.createElement('${name.toLowerCase()}', props) }`
  for (const [file, name] of [['WorldsAssetsDock.mjs', 'WorldsAssetsDock'], ['WorldsLegacyExportDialog.mjs', 'WorldsLegacyExportDialog'], ['WorldsSceneDock.mjs', 'WorldsSceneDock'], ['WorldsTimelineDrawer.mjs', 'WorldsTimelineDrawer'], ['WorldsAiDrawer.mjs', 'WorldsAiDrawer']] as const) await writeFile(path.join(mockDir, file), simpleComponent(name))
  await writeFile(path.join(mockDir, 'assetService.mjs'), `export async function listWorldAssetLibraryRenderables() { return { success: true, assets: [] } } export async function openWorldAssetLibraryRenderable() { return { success: false, error: 'unused' } } export async function readWorldAssetLibraryAudio() { return { success: false, error: 'unused' } }`)
  await writeFile(path.join(mockDir, 'physics.mjs'), `export function createBrowserWorldPhysicsRuntime() { return { async initialize(scene) { globalThis.__worldsMeshDiskHarness.physicsInitialized += 1; globalThis.__worldsMeshDiskHarness.physicsScenes.push(structuredClone(scene)) }, step() {}, pause() {}, resume() {}, dispose() { globalThis.__worldsMeshDiskHarness.physicsDisposed += 1 } } }`)
  await writeFile(path.join(mockDir, 'audio.mjs'), `export function createBrowserWorldAudioAuthority() { return { async prepareScene() { globalThis.__worldsMeshDiskHarness.audioPrepared += 1 }, async activate() {}, async play() {}, async stopSource() {}, update() {}, async pause() {}, async resume() {}, stop() { globalThis.__worldsMeshDiskHarness.audioStopped += 1 } } }`)
  const aliases = new Map([
    [path.join(currentDir, '../editor/useWorldEditorController.ts'), path.join(mockDir, 'useWorldEditorControllerObserver.mjs')],
    [path.join(currentDir, 'WorldsViewer.tsx'), path.join(mockDir, 'WorldsViewer.mjs')],
    [path.join(currentDir, 'WorldRuntimeViewport.tsx'), path.join(mockDir, 'WorldRuntimeViewport.mjs')],
    [path.join(currentDir, 'WorldsAssetsDock.tsx'), path.join(mockDir, 'WorldsAssetsDock.mjs')],
    [path.join(currentDir, 'WorldsLegacyExportDialog.tsx'), path.join(mockDir, 'WorldsLegacyExportDialog.mjs')],
    [path.join(currentDir, 'WorldsSceneDock.tsx'), path.join(mockDir, 'WorldsSceneDock.mjs')],
    [path.join(currentDir, 'WorldsTimelineDrawer.tsx'), path.join(mockDir, 'WorldsTimelineDrawer.mjs')],
    [path.join(currentDir, 'WorldsAiDrawer.tsx'), path.join(mockDir, 'WorldsAiDrawer.mjs')],
    [path.join(currentDir, '../worldAssetLibraryService.ts'), path.join(mockDir, 'assetService.mjs')],
    [path.join(currentDir, '../runtime/worldPhysicsRuntime.ts'), path.join(mockDir, 'physics.mjs')],
    [path.join(currentDir, '../runtime/worldAudioRuntime.ts'), path.join(mockDir, 'audio.mjs')],
  ])
  if (assets) {
    aliases.delete(path.join(currentDir, 'WorldsAssetsDock.tsx'))
    aliases.delete(path.join(currentDir, '../worldAssetLibraryService.ts'))
  }
  const result = await build({ entryPoints: [path.join(tempDir, 'entry.ts')], bundle: true, write: false, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', logLevel: 'silent', tsconfig: path.join(repo, 'tsconfig.web.json'), plugins: [{ name: 'worlds-workbench-mesh-disk-aliases', setup(buildApi) { buildApi.onResolve({ filter: /\.css$/ }, () => ({ path: path.join(mockDir, 'css-empty.mjs') })); buildApi.onResolve({ filter: /.*/ }, (args) => { if (!args.path.startsWith('.')) return undefined; const resolved = path.resolve(args.resolveDir, args.path); return aliases.has(resolved) ? { path: aliases.get(resolved)! } : undefined }) } }] })
  const outfile = path.join(tempDir, `WorldsWorkbench.bundle.${Date.now()}.mjs`)
  await writeFile(outfile, result.outputFiles[0].text)
  setupWindow(service, assets)
  const module = await import(pathToFileURL(outfile).href) as WorkbenchMeshModule
  // Use the real app API configuration; Node's Request cannot resolve browser-relative URLs.
  if (assets) module.useAppStore.setState({ apiUrl: 'http://127.0.0.1:9' })
  return { module, cleanup: () => rm(tempDir, { recursive: true, force: true }) }
}

function setupWindow(service: Service, assets?: AssetLibraryEntry[]): void {
  const target = globalThis as HarnessGlobal
  Object.defineProperty(target, 'window', { value: target, configurable: true })
  Object.defineProperty(target, 'electron', {
    value: {
      workspace: {
        worlds: { projects: service },
        library: { list: async () => ({ success: true, entries: assets ?? [] }), open: async ({ workspacePath }: { workspacePath: string }) => { await target.__worldsMeshDiskHarness?.assetOpenGate?.(); const entry = assets?.find((candidate) => candidate.workspacePath === workspacePath); return entry ? { success: true, entry } : { success: false, error: 'Private fixture asset missing.' } } },
        writeSceneManifest: async () => ({ success: false, error: 'unused' }),
      },
      renders: {},
      app: { info: async () => ({ version: 'test', userData: '/tmp', modelsDir: '/tmp', apiUrl: 'http://127.0.0.1:9', platform: process.platform, arch: process.arch }) },
    },
    configurable: true,
  })
  target.addEventListener = target.addEventListener ?? (() => undefined)
  target.removeEventListener = target.removeEventListener ?? (() => undefined)
  target.setTimeout = target.setTimeout ?? setTimeout
  target.clearTimeout = target.clearTimeout ?? clearTimeout
  Object.defineProperty(target, 'localStorage', { value: target.localStorage ?? { getItem: () => null, setItem: () => undefined, removeItem: () => undefined, clear: () => undefined, key: () => null, length: 0 }, configurable: true })
  Object.defineProperty(target, 'ResizeObserver', { value: target.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} }, configurable: true })
}

function mounted() {
  const append = (parent: Host, child: Host) => { parent.children.push(child) }
  const remove = (parent: Host, child: Host) => { parent.children.splice(parent.children.indexOf(child), 1) }
  const insert = (parent: Host, child: Host, before: Host) => {
    const existing = parent.children.indexOf(child)
    if (existing >= 0) parent.children.splice(existing, 1)
    const index = parent.children.indexOf(before)
    if (index >= 0) parent.children.splice(index, 0, child)
    else parent.children.push(child)
  }
  const renderer = Reconciler({ now: performance.now.bind(performance), supportsMutation: true, isPrimaryRenderer: true, getRootHostContext: () => null, getChildHostContext: () => null, getPublicInstance: (node: Host) => node, prepareForCommit: () => null, resetAfterCommit() {}, shouldSetTextContent: () => false, createInstance: (type: string, props: Host['props']) => makeHost(type, props), createTextInstance: (text: string) => makeHost('#text', { text }), appendInitialChild: append, appendChild: append, appendChildToContainer: append, removeChild: remove, removeChildFromContainer: remove, clearContainer: (node: Host) => { node.children = [] }, insertBefore: insert, insertInContainerBefore: insert, finalizeInitialChildren: () => false, prepareUpdate: () => true, commitUpdate: (node: Host, _payload: unknown, _type: unknown, _old: unknown, props: Host['props']) => { node.props = props }, commitTextUpdate: (node: Host, _old: unknown, text: string) => { node.props.text = text }, scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1, getCurrentEventPriority: () => 1, detachDeletedInstance() {}, supportsMicrotasks: true, scheduleMicrotask: queueMicrotask })
  const container: Host = makeHost('root', {})
  const root = renderer.createContainer(container, 0, null, false, null, '', () => {}, null)
  return { container, batch: (operation: () => void) => renderer.batchedUpdates(operation), render: (value: React.ReactNode) => { renderer.flushSync(() => renderer.updateContainer(value, root, null, null)); renderer.flushPassiveEffects() }, flush: () => { renderer.flushSync(() => {}); renderer.flushPassiveEffects() } }
}

function makeHost(type: string, props: Record<string, unknown>): Host { return { type, props, children: [], getBoundingClientRect: () => ({ width: 1440 }), querySelector: () => null, focus: () => undefined } }
async function settle(host: ReturnType<typeof mounted>, ticks = 8): Promise<void> { for (let index = 0; index < ticks; index += 1) { await new Promise((resolve) => setTimeout(resolve, 0)); host.flush() } }
async function waitFor(host: ReturnType<typeof mounted>, predicate: () => boolean, ticks = 240): Promise<void> { for (let attempt = 0; attempt < ticks && !predicate(); attempt += 1) await settle(host, 2); assert.equal(predicate(), true) }
function click(host: ReturnType<typeof mounted>, label: string): void { const button = requireNode(host, (node) => node.type === 'button' && node.props['aria-label'] === label, `button ${label}`); assert.equal(button.props.disabled, false); (button.props.onClick as () => void)() }
function changeSelect(select: Host, value: string): void { (select.props.onChange as (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value } }) }
function selectByLabelInSection(host: ReturnType<typeof mounted>, heading: string, label: string): Host { const section = requireNode(host, (node) => node.type === 'section' && !!find(node, (child) => child.type === 'h3' && text(child) === heading), `section ${heading}`); const labelNode = findLast(section, (node) => node.type === 'label' && text(node).includes(label)); assert.ok(labelNode, `label ${heading} / ${label}`); const control = findLast(labelNode, (node) => node.type === 'select' || node.type === 'input'); assert.ok(control, `control ${heading} / ${label}`); return control }
function requireNode(host: ReturnType<typeof mounted>, predicate: (node: Host) => boolean, label: string): Host { const found = findLast(host.container, predicate); if (!found) throw new assert.AssertionError({ message: label, actual: found, expected: true, operator: '==' }); return found }
function find(node: Host, predicate: (node: Host) => boolean): Host | undefined { if (predicate(node)) return node; for (const child of node.children) { const found = find(child, predicate); if (found) return found } return undefined }
function findLast(node: Host, predicate: (node: Host) => boolean): Host | undefined { for (let index = node.children.length - 1; index >= 0; index -= 1) { const found = findLast(node.children[index]!, predicate); if (found) return found } return predicate(node) ? node : undefined }
function text(node: Host): string { if (node.type === '#text') return String(node.props.text); return node.children.map(text).join('') }
function sessionProof(controller: WorldEditorController) { const session = controller.getState().session; assert.ok(session); return { snapshot: structuredClone(session.snapshot), undoStack: structuredClone(session.undoStack), redoStack: structuredClone(session.redoStack), receipts: structuredClone(session.receipts) } }
function canonical(value: unknown): string { return JSON.stringify(value, (_key, nested) => !nested || typeof nested !== 'object' || Array.isArray(nested) ? nested : Object.fromEntries(Object.keys(nested).sort().map((key) => [key, (nested as Record<string, unknown>)[key]]))) }
function sha256(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
async function recursiveHashes(root: string) { const rows: Array<{ path: string; sha256: string }> = []; async function visit(directory: string): Promise<void> { for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) { const absolute = path.join(directory, entry.name); if (entry.isDirectory()) await visit(absolute); else if (entry.isFile()) rows.push({ path: path.relative(root, absolute), sha256: sha256(await readFile(absolute)) }) } } await visit(root); return rows }
async function writeEvidence(evidenceRoot: string, name: string, value: unknown): Promise<void> { await mkdir(evidenceRoot, { recursive: true }); await writeFile(path.join(evidenceRoot, name), `${canonical(value)}\n`) }

function makeMountedGlb(): ArrayBuffer {
  const vertices = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const indices = new Uint32Array([0, 1, 2])
  const vertexBytes = new Uint8Array(vertices.buffer)
  const indexBytes = new Uint8Array(indices.buffer)
  const bin = new Uint8Array(align4(vertexBytes.byteLength + indexBytes.byteLength)); bin.set(vertexBytes, 0); bin.set(indexBytes, vertexBytes.byteLength)
  const json = { asset: { version: '2.0' }, buffers: [{ byteLength: bin.byteLength }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: vertexBytes.byteLength, target: 34962 }, { buffer: 0, byteOffset: vertexBytes.byteLength, byteLength: indexBytes.byteLength, target: 34963 }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5125, count: 3, type: 'SCALAR', min: [0], max: [2] }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0 }
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const paddedJson = new Uint8Array(align4(jsonBytes.byteLength)); paddedJson.set(jsonBytes); paddedJson.fill(0x20, jsonBytes.byteLength)
  const total = 12 + 8 + paddedJson.byteLength + 8 + bin.byteLength
  const out = new ArrayBuffer(total)
  const view = new DataView(out)
  let offset = 0
  view.setUint32(offset, 0x46546c67, true); offset += 4
  view.setUint32(offset, 2, true); offset += 4
  view.setUint32(offset, total, true); offset += 4
  view.setUint32(offset, paddedJson.byteLength, true); offset += 4
  view.setUint32(offset, 0x4e4f534a, true); offset += 4
  new Uint8Array(out, offset, paddedJson.byteLength).set(paddedJson); offset += paddedJson.byteLength
  view.setUint32(offset, bin.byteLength, true); offset += 4
  view.setUint32(offset, 0x004e4942, true); offset += 4
  new Uint8Array(out, offset, bin.byteLength).set(bin)
  return out
}
function makeAnimationGlb(): ArrayBuffer {
  const base = makeMountedGlb()
  const baseView = new DataView(base)
  const jsonLength = baseView.getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(base, 20, jsonLength)))
  const oldBin = new Uint8Array(base, 28 + jsonLength)
  const times = new Float32Array([0, 2])
  const values = new Float32Array([0, 0, 0, 2, 0, 0])
  const bin = new Uint8Array(oldBin.byteLength + times.byteLength + values.byteLength)
  bin.set(oldBin); bin.set(new Uint8Array(times.buffer), oldBin.byteLength); bin.set(new Uint8Array(values.buffer), oldBin.byteLength + times.byteLength)
  json.buffers[0].byteLength = bin.byteLength
  json.nodes[0].name = 'AnimatedMarker'
  json.bufferViews.push({ buffer: 0, byteOffset: oldBin.byteLength, byteLength: times.byteLength }, { buffer: 0, byteOffset: oldBin.byteLength + times.byteLength, byteLength: values.byteLength })
  json.accessors.push({ bufferView: 2, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [2] }, { bufferView: 3, componentType: 5126, count: 2, type: 'VEC3' })
  json.animations = [0, 1].map(() => ({ name: 'Duplicate', samplers: [{ input: 2, output: 3, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] }))
  json.accessors.push({ bufferView: 2, componentType: 5126, count: 1, type: 'SCALAR', min: [0], max: [0] }, { bufferView: 3, componentType: 5126, count: 1, type: 'VEC3' })
  json.animations.push({ name: 'Zero', samplers: [{ input: 4, output: 5, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] })
  json.animations.push({ name: 'x'.repeat(257), samplers: [{ input: 2, output: 3, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] })
  const raw = new TextEncoder().encode(JSON.stringify(json))
  const jsonBytes = new Uint8Array(align4(raw.byteLength)); jsonBytes.fill(0x20); jsonBytes.set(raw)
  const out = new ArrayBuffer(28 + jsonBytes.byteLength + bin.byteLength)
  const view = new DataView(out)
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, out.byteLength, true)
  view.setUint32(12, jsonBytes.byteLength, true); view.setUint32(16, 0x4e4f534a, true)
  new Uint8Array(out, 20, jsonBytes.byteLength).set(jsonBytes)
  view.setUint32(20 + jsonBytes.byteLength, bin.byteLength, true); view.setUint32(24 + jsonBytes.byteLength, 0x004e4942, true)
  new Uint8Array(out, 28 + jsonBytes.byteLength).set(bin)
  return out
}
function makeAnimationGltf() {
  const glb = makeAnimationGlb()
  const jsonLength = new DataView(glb).getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength)))
  const buffer = Buffer.from(glb, 28 + jsonLength)
  const uri = `data:application/octet-stream;base64,${buffer.toString('base64')}`
  json.buffers[0].uri = uri
  return { json, buffer, uri }
}
function align4(value: number): number { return (value + 3) & ~3 }

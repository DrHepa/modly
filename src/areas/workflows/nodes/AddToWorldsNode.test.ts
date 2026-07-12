import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  addWorkflowOutputUrlToWorlds,
  encodeWorkflowOutputWorldsWorkspacePath,
  resolveWorkflowOutputWorldsWorkspacePath,
} from '../workflowWorldsOutput.ts'
import { WORLDS_EXPERIMENTAL_FEATURES } from '../../worlds/worldRenderableResolver.ts'
import { useWorldsSceneStore } from '../../worlds/worldsSceneStore.ts'
import { useAppStore } from '../../../shared/stores/appStore.ts'

const sourcePath = path.join(import.meta.dirname, 'AddToWorldsNode.tsx')

test('AddToWorldsNode is a standalone stable Worlds destination node', async () => {
  const source = await readFile(sourcePath, 'utf8')

  assert.match(source, /title="Add to Worlds"/)
  assert.match(source, /Add to Worlds/)
  assert.match(source, /Automatically adds the connected mesh to Worlds when the workflow runs\./)
  assert.doesNotMatch(source, /checkbox|Open in Worlds|openInWorlds/)
  assert.doesNotMatch(source, /button|onClick|navigate\('worlds'\)|setWorldsError|text-red|fetch\(/)
})

test('resolveWorkflowOutputWorldsWorkspacePath accepts only safe workspace URLs', () => {
  assert.equal(resolveWorkflowOutputWorldsWorkspacePath('/workspace/Workflows/generated/hero.glb'), 'Workflows/generated/hero.glb')
  assert.equal(resolveWorkflowOutputWorldsWorkspacePath('http://127.0.0.1:8765/workspace/Exports/hero.glb'), 'Exports/hero.glb')
  assert.equal(resolveWorkflowOutputWorldsWorkspacePath('/workspace/Workflows/%68ero.glb'), 'Workflows/hero.glb')
  assert.equal(resolveWorkflowOutputWorldsWorkspacePath('/workspace/../outside.glb'), null)
  assert.equal(resolveWorkflowOutputWorldsWorkspacePath('/workspace/%2e%2e/outside.glb'), null)
  assert.equal(resolveWorkflowOutputWorldsWorkspacePath('/not-workspace/hero.glb'), null)
  assert.equal(resolveWorkflowOutputWorldsWorkspacePath('/workspace/C:/outside.glb'), null)
})

test('workflow Add to Worlds accepts Gaussian PLY and keeps standard PLY unchanged', async () => {
  const originalWindow = globalThis.window
  useAppStore.setState({ apiUrl: 'http://127.0.0.1:8765' })
  useWorldsSceneStore.setState({
    sceneItems: [],
    collisionSurfaces: [],
    selectedSceneItemId: null,
    selectedSceneItemIds: [],
    pendingSurfacePlacementItemId: null,
    collisionEditMode: false,
    selectedCollisionSurfaceId: null,
    transformMode: null,
    sceneItemAnchors: {},
  })

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electron: {
        workspace: {
          library: {
            read: async ({ workspacePath }: { workspacePath: string }) => ({
              success: true as const,
              entry: {
                id: workspacePath,
                workspacePath,
                displayName: workspacePath,
                sourceScope: 'workflows' as const,
                state: workspacePath.includes('gaussian') ? 'unknown-metadata' as const : 'ready' as const,
                capability: workspacePath.includes('gaussian') ? undefined : 'mesh' as const,
                plyKind: workspacePath.includes('gaussian') ? 'gaussian' as const : 'mesh' as const,
                previewKind: 'binary' as const,
                warnings: [],
              },
              preview: {
                kind: 'binary' as const,
                binaryKind: 'ply',
                byteLength: 32,
                message: 'Binary preview is unavailable for this artifact. Download the file to inspect it locally.',
                plyKind: workspacePath.includes('gaussian') ? 'gaussian' as const : 'mesh' as const,
              },
            }),
          },
        },
      },
    },
  })

  try {
    ;(WORLDS_EXPERIMENTAL_FEATURES as { gaussianPly: boolean }).gaussianPly = true
    assert.equal(await addWorkflowOutputUrlToWorlds('/workspace/Workflows/generated/gaussian.ply'), true)
    assert.deepEqual(useWorldsSceneStore.getState().sceneItems.map((item) => ({ workspacePath: item.workspacePath, kind: item.kind })), [
      { workspacePath: 'Workflows/generated/gaussian.ply', kind: 'gaussian-ply' },
    ])

    assert.equal(await addWorkflowOutputUrlToWorlds('/workspace/Workflows/generated/standard.ply'), true)
    assert.deepEqual(useWorldsSceneStore.getState().sceneItems.map((item) => ({ workspacePath: item.workspacePath, kind: item.kind })), [
      { workspacePath: 'Workflows/generated/gaussian.ply', kind: 'gaussian-ply' },
      { workspacePath: 'Workflows/generated/standard.ply', kind: 'ply-mesh' },
    ])
    assert.equal(useWorldsSceneStore.getState().pendingSurfacePlacementItemId, null)
  } finally {
    ;(WORLDS_EXPERIMENTAL_FEATURES as { gaussianPly: boolean }).gaussianPly = false
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    })
  }
})

test('workflow Worlds output source resolves PLY through the library boundary before world loading', async () => {
  const source = await readFile(path.join(import.meta.dirname, '../workflowWorldsOutput.ts'), 'utf8')
  assert.match(source, /libraryApi\.read\(\{ workspacePath \}\)/)
  assert.match(source, /resolveWorldRenderable\(\{ workspacePath, apiUrl, .*plyKind/s)
  assert.match(source, /pendingSurfacePlacementItemId: shouldPendingWorldsSurfacePlacement\(sceneState\.sceneItems, renderable\.item\)/)
})


test('workflow scene output fetches an encoded manifest URL and replaces Worlds atomically', async () => {
  const originalFetch = globalThis.fetch
  const requestedUrls: string[] = []
  useAppStore.setState({ apiUrl: 'http://127.0.0.1:8765' })
  useWorldsSceneStore.setState({
    sceneItems: [],
    collisionSurfaces: [],
    initialView: null,
    selectedSceneItemId: null,
    selectedSceneItemIds: [],
    pendingSurfacePlacementItemId: null,
    collisionEditMode: false,
    selectedCollisionSurfaceId: null,
    transformMode: null,
    sceneItemAnchors: {},
  })

  const manifest = {
    schema: 'modly.scene-manifest.v1',
    sceneRoot: '.',
    initialView: { position: [0, 0, 0], target: [0, 0, 1], up: [0, 1, 0] },
    collisionSurfaces: {
      schema: 'modly.collision-surfaces.v1',
      surfaces: [{
        id: 'floor',
        sidedness: 'double',
        shape: 'rect',
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        geometry: { halfWidth: 1, halfHeight: 1 },
      }],
    },
    assets: [
      {
        id: 'base',
        role: 'base-scene',
        workspacePath: 'Workflows/generated/base.glb',
        kind: 'glb',
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
      {
        id: 'prop',
        role: 'asset',
        workspacePath: 'Workflows/generated/prop.glb',
        kind: 'glb',
        transform: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
    ],
  }

  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrls.push(String(input))
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify(manifest),
    } as Response
  }) as typeof fetch

  try {
    const encodedPath = 'Workflows/scene%20%23%3F%25%C3%A9.json'
    assert.equal(resolveWorkflowOutputWorldsWorkspacePath(`/workspace/${encodedPath}`), 'Workflows/scene #?%é.json')
    assert.equal(
      encodeWorkflowOutputWorldsWorkspacePath('Workflows/scene #?%é.json'),
      encodedPath,
    )
    assert.equal(await addWorkflowOutputUrlToWorlds(`/workspace/${encodedPath}`, 'scene'), true)
    assert.deepEqual(requestedUrls, [`http://127.0.0.1:8765/workspace/${encodedPath}`])

    const state = useWorldsSceneStore.getState()
    assert.deepEqual(state.sceneItems.map((item) => item.id), ['base', 'prop'])
    assert.deepEqual(state.collisionSurfaces.map((surface) => surface.id), ['floor'])
    assert.deepEqual(state.initialView, manifest.initialView)
    assert.equal(state.selectedSceneItemId, 'base')
    assert.deepEqual(state.selectedSceneItemIds, ['base'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('workflow scene failures leave existing Worlds state untouched', async () => {
  const originalFetch = globalThis.fetch
  useAppStore.setState({ apiUrl: 'http://127.0.0.1:8765' })
  const existingItem = {
    id: 'existing',
    workspacePath: 'Workflows/existing.glb',
    url: '/workspace/Workflows/existing.glb',
    kind: 'glb' as const,
    role: 'base-scene' as const,
    visible: true,
    transform: { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] },
  }
  const existingView = { position: [2, 3, 4] as [number, number, number], target: [0, 0, 0] as [number, number, number] }
  useWorldsSceneStore.setState({
    sceneItems: [existingItem],
    collisionSurfaces: [],
    initialView: existingView,
    selectedSceneItemId: existingItem.id,
    selectedSceneItemIds: [existingItem.id],
    pendingSurfacePlacementItemId: null,
    collisionEditMode: false,
    selectedCollisionSurfaceId: null,
    transformMode: null,
    sceneItemAnchors: {},
  })
  const before = useWorldsSceneStore.getState()

  try {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      statusText: 'Broken',
      text: async () => '',
    } as Response)) as typeof fetch
    await assert.rejects(
      addWorkflowOutputUrlToWorlds('/workspace/Workflows/broken.json', 'scene'),
      /HTTP 500 Broken/,
    )
    assert.deepEqual(useWorldsSceneStore.getState().sceneItems, before.sceneItems)
    assert.deepEqual(useWorldsSceneStore.getState().initialView, before.initialView)

    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '{"schema":"wrong"}',
    } as Response)) as typeof fetch
    await assert.rejects(
      addWorkflowOutputUrlToWorlds('/workspace/Workflows/invalid.json', 'scene'),
      /Unable to parse workflow scene manifest/,
    )
    assert.deepEqual(useWorldsSceneStore.getState().sceneItems, before.sceneItems)
    assert.deepEqual(useWorldsSceneStore.getState().initialView, before.initialView)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Worlds scene store preserves omitted initialView and clears explicit null', () => {
  const store = useWorldsSceneStore.getState()
  const view = {
    position: [1, 2, 3] as [number, number, number],
    target: [0, 0, 0] as [number, number, number],
  }
  store.setScene({
    sceneItems: [],
    collisionSurfaces: [],
    selectedSceneItemId: null,
    initialView: view,
  })
  useWorldsSceneStore.getState().setScene({
    sceneItems: [],
    collisionSurfaces: [],
    selectedSceneItemId: null,
  })
  assert.deepEqual(useWorldsSceneStore.getState().initialView, view)

  useWorldsSceneStore.getState().setScene({
    sceneItems: [],
    collisionSurfaces: [],
    selectedSceneItemId: null,
    initialView: null,
  })
  assert.equal(useWorldsSceneStore.getState().initialView, null)
})

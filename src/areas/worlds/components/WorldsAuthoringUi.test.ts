import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { createValidWorldSnapshot } from '../core/_testFixtures.ts'
import { createRuntimeWorldSnapshot } from '../runtime/_testFixtures.ts'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')

test('Worlds exposes compact accessible no-code gameplay authoring without arbitrary scripts', async () => {
  const sceneDock = await readFile(path.join(import.meta.dirname, 'WorldsSceneDock.tsx'), 'utf8')
  const inspector = await readFile(path.join(import.meta.dirname, 'WorldsInspector.tsx'), 'utf8')
  const assets = await readFile(path.join(import.meta.dirname, 'WorldsAssetsDock.tsx'), 'utf8')
  const css = await readFile(path.join(import.meta.dirname, '../WorldsWorkbench.css'), 'utf8')

  assert.match(sceneDock, /aria-label="Add empty entity"/)
  assert.match(sceneDock, /<Tooltip content="Add empty"/)
  for (const label of ['Box Collider', 'Sphere Collider', 'Capsule Collider', 'Dynamic Body', 'Fixed Body', 'Character', 'Trigger', 'Audio Listener', 'Behavior']) {
    assert.match(inspector, new RegExp(label))
  }
  assert.match(inspector, /Shape/)
  assert.match(inspector, /Geometry source/)
  assert.doesNotMatch(inspector, /Add a GLB, GLTF, or PLY mesh asset first\./)
  assert.match(inspector, /<fieldset[^>]*className="worlds-vector-field"/)
  assert.match(inspector, /<legend>/)
  assert.match(inspector, /aria-label="Make primary camera"/)
  assert.match(inspector, /aria-label="Make primary audio listener"/)
  assert.match(inspector, /Project inputs/)
  assert.match(inspector, /Keyboard code/)
  assert.match(inspector, /Alt\+ArrowUp/)
  assert.match(inspector, /Trigger enter/)
  assert.match(inspector, /Stop audio/)
  assert.doesNotMatch(inspector, /Sequence event/)
  assert.doesNotMatch(inspector, /JavaScript|<textarea/)
  assert.match(assets, /Attach audio/)
  assert.match(css, /\.worlds-authoring-action[^}]*min-height:\s*32px/s)
  assert.match(css, /\.worlds-authoring-action:focus-visible/)
  const workbench = await readFile(path.join(import.meta.dirname, 'WorldsWorkbench.tsx'), 'utf8')
  const viewer = await readFile(path.join(import.meta.dirname, 'WorldsViewer.tsx'), 'utf8')
  const tooltipModel = await readFile(path.join(projectRoot, 'src/shared/components/ui/tooltipModel.ts'), 'utf8')
  assert.match(workbench, /showAuthoringToolbar=\{false\}/)
  assert.match(viewer, /showAuthoringToolbar = true/)
  assert.match(inspector, /aria-label="Selected entity viewport tools"/)
  assert.match(tooltipModel, /TOOLTIP_POINTER_DELAY_MS = 2_000/)
  assert.match(tooltipModel, /action\.type === 'focus'\) return \{ visible: true, pointerPending: false \}/)
})

test('Worlds Inspector exposes labeled character, capsule, kinematic and axis binding controls', async () => {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-worlds-character-ui-test-'))
  try {
    const result = await build({
      entryPoints: [path.join(import.meta.dirname, 'WorldsInspector.tsx')],
      bundle: true, write: false, format: 'esm', platform: 'node',
      tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
      external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
    })
    const outfile = path.join(tempDir, 'WorldsInspector.bundle.mjs')
    await writeFile(outfile, result.outputFiles[0].text)
    const module = await import(pathToFileURL(outfile).href)
    const snapshot = createRuntimeWorldSnapshot()
    const markup = renderToStaticMarkup(createElement(module.WorldsInspector, {
      projectKey: `world-${'a'.repeat(32)}`, snapshot, scene: snapshot.scenes[0],
      selectedEntityIds: ['entity:hero'], activeEntityId: 'entity:hero',
      snapEnabled: false, snapIncrement: 0.5,
      onSnap() {}, onCommands() {}, onError() {},
    }))
    for (const copy of ['Character controller', 'Shape', 'Sphere', 'Capsule', 'Radius', 'Half height', 'Kinematic position', 'Move input', 'Jump input', 'None', 'Jump speed', 'Max slope', 'Target axis', 'Scale']) {
      assert.ok(markup.includes(copy), `Missing character control: ${copy}`)
    }
    assert.match(markup, /aria-label="Add axis2d input"/)
    assert.doesNotMatch(markup, /Kinematic body · view only|Legacy collider · view only/)
    const workbench = await readFile(path.join(import.meta.dirname, 'WorldsWorkbench.tsx'), 'utf8')
    const inspectorCallback = workbench.slice(workbench.indexOf('const inspector ='), workbench.indexOf('const timelineFrame ='))
    // Explicit gesture authority wins; other component edits capture the rendered revision.
    assert.match(inspectorCallback, /dispatchCommands\(commands, scope, expectedAuthority \?\? \{/)
    assert.match(inspectorCallback, /baseRevision: snapshot\.project\.revision/)
    assert.match(inspectorCallback, /activeSceneId: scene\.sceneId/)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('Worlds Inspector exposes primitive collider authoring and keeps unsupported mesh resources disabled without text drafts', async () => {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-worlds-primitive-collider-ui-test-'))
  try {
    const result = await build({
      entryPoints: [path.join(import.meta.dirname, 'WorldsInspector.tsx')],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
      external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
    })
    const outfile = path.join(tempDir, 'WorldsInspector.bundle.mjs')
    await writeFile(outfile, result.outputFiles[0].text)
    const module = await import(pathToFileURL(outfile).href)
    const snapshot = createValidWorldSnapshot()
    const entity = snapshot.scenes[0].entities[0]
    entity.components.push(
      { id: 'component:sphere', type: 'collider', enabled: true, purpose: 'simulation', shape: 'sphere', radius: 0.8, sensor: false, friction: 0.5, restitution: 0, collisionLayer: 1, collisionMask: 0xffff },
      { id: 'component:capsule', type: 'collider', enabled: true, purpose: 'simulation', shape: 'capsule', radius: 0.35, halfHeight: 0.55, sensor: false, friction: 0.5, restitution: 0, collisionLayer: 1, collisionMask: 0xffff },
      { id: 'component:convex', type: 'collider', enabled: true, purpose: 'simulation', shape: 'convex', resourceId: 'resource:hero', sensor: false, friction: 0.5, restitution: 0, collisionLayer: 1, collisionMask: 0xffff },
    )
    const markup = renderToStaticMarkup(createElement(module.WorldsInspector, {
      projectKey: `world-${'a'.repeat(32)}`,
      snapshot,
      scene: snapshot.scenes[0],
      selectedEntityIds: [entity.id],
      activeEntityId: entity.id,
      snapEnabled: false,
      snapIncrement: 0.5,
      onSnap: () => undefined,
      onCommands: () => undefined,
      onError: () => undefined,
      viewportTools: { entityId: entity.id, mode: 'translate', baseScene: false, disabled: false, onModeChange() {}, onToggleBaseSceneItem() {} },
    }))
    for (const copy of ['Sphere Collider', 'Capsule Collider', 'Shape', 'Box', 'Sphere', 'Capsule', 'Radius', 'Half height', 'Geometry source', 'Hero · GLB']) {
      assert.ok(markup.includes(copy), `Missing primitive collider UI copy: ${copy}`)
    }
    assert.doesNotMatch(markup, /Legacy collider · view only|<textarea|JavaScript|workspace path|vertices/i)
    for (const copy of ['Move selected asset', 'Rotate selected asset', 'Scale selected asset', 'Set selected asset as base world']) assert.ok(markup.includes(`aria-label="${copy}"`))
    assert.match(markup, /aria-label="Move selected asset" aria-pressed="true"/)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('Worlds Inspector renders the complete authored gameplay fixture without invalid draft controls', async () => {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-worlds-authoring-ui-test-'))
  try {
    const result = await build({
      entryPoints: [path.join(import.meta.dirname, 'WorldsInspector.tsx')],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
      external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
    })
    const outfile = path.join(tempDir, 'WorldsInspector.bundle.mjs')
    await writeFile(outfile, result.outputFiles[0].text)
    const module = await import(pathToFileURL(outfile).href)
    const snapshot = createValidWorldSnapshot()
    snapshot.project.resources.push({ id: 'resource:impact', type: 'audio', name: 'Impact', workspacePath: 'Workflows/Audio/impact.wav', format: 'wav' })
    const entity = snapshot.scenes[0].entities[0]
    entity.components.push(
      { id: 'component:camera', type: 'camera', enabled: true, projection: 'perspective', primary: true, near: 0.1, far: 100, fieldOfView: 60 },
      { id: 'component:body-collider', type: 'collider', enabled: true, purpose: 'simulation', shape: 'box', halfExtents: [0.5, 0.5, 0.5], sensor: false, friction: 0.5, restitution: 0, collisionLayer: 1, collisionMask: 0xffff },
      { id: 'component:body', type: 'rigid-body', enabled: true, bodyType: 'dynamic', gravityScale: 1, linearDamping: 0.1, angularDamping: 0.1, canSleep: true },
      { id: 'component:sensor', type: 'collider', enabled: true, purpose: 'simulation', shape: 'box', halfExtents: [1, 1, 1], sensor: true, friction: 0.5, restitution: 0, collisionLayer: 1, collisionMask: 0xffff },
      { id: 'component:trigger', type: 'trigger', enabled: true, colliderComponentId: 'component:sensor', once: false, targetTags: ['player'] },
      { id: 'component:listener', type: 'audio-listener', enabled: true, primary: true },
      { id: 'component:impact', type: 'audio-source', enabled: true, resourceId: 'resource:impact', autoplay: false, loop: false, volume: 1, spatial: true, maxDistance: 20 },
      { id: 'component:behavior', type: 'behavior', enabled: true, bindings: [{ id: 'binding:start', event: { type: 'start' }, actions: [{ type: 'play-audio', entityId: entity.id, componentId: 'component:impact' }] }] },
    )
    const markup = renderToStaticMarkup(createElement(module.WorldsInspector, {
      projectKey: `world-${'a'.repeat(32)}`,
      snapshot,
      scene: snapshot.scenes[0],
      selectedEntityIds: [entity.id],
      activeEntityId: entity.id,
      snapEnabled: false,
      snapIncrement: 0.5,
      onSnap: () => undefined,
      onCommands: () => undefined,
      onError: () => undefined,
    }))
    for (const copy of ['Half extents', 'Gravity', 'Max distance', 'Collider', 'Rule 1', 'Trigger enter', 'Stop audio', 'Apply impulse', 'Change scene', 'Keyboard code']) {
      assert.match(markup, new RegExp(copy))
    }
    assert.doesNotMatch(markup, /textarea|JavaScript|Sequence event/)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

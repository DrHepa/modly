import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import * as THREE from 'three'
import ts from 'typescript'

const component = path.join(import.meta.dirname, 'WorldRuntimeViewport.tsx')

test('runtime viewport uses authored primary camera and scoped input without editor overlays', async () => {
  const source = await readFile(component, 'utf8')
  assert.match(source, /aria-label="Play viewport"/)
  assert.match(source, /tabIndex=\{0\}/)
  assert.match(source, /primaryCamera/)
  assert.match(source, /makeDefault/)
  assert.match(source, /sampler\.dispose\(\)/)
  assert.match(source, /inputActionsSignature/)
  assert.doesNotMatch(source, /\}\), \[snapshot\.project\.inputActions\]\)/)
  assert.match(source, /animation\?\.requestToken/)
  assert.match(source, /RuntimeItemObject key=\{item\.id\} item=\{item\} lifecycle=\{lifecycle\} onError=\{onError\}/)
  assert.match(source, /animationGate\.current\.advance\(lifecycle, delta/)
  assert.doesNotMatch(source, /\[gltf\.animations,\s*item\.runtimeAnimation,\s*mixer\]/)
  assert.doesNotMatch(source, /useFrame\(\(_state, delta\) => mixer\.update\(delta\)\)/)
  assert.doesNotMatch(source, /OrbitControls|TransformControls|GridHelper|Gizmo|Selection|Outline/)
  assert.doesNotMatch(source, /WorldsViewportModeControl|WorldsViewportNavigationControls|WORLD_VIEWER_CAMERA_NAVIGATION/)
})

test('runtime viewport focuses on Play and clears scoped input on blur pause stop and unmount', async () => {
  const source = await readFile(component, 'utf8')
  assert.match(source, /rootRef\.current\.focus\(\{ preventScroll: true \}\)/, 'Play handoff must focus the viewport without scrolling editor chrome')
  assert.match(source, /document\.activeElement !== rootRef\.current/, 'focus handoff must be scoped to the viewport element')
  assert.match(source, /lifecycle !== 'playing'[\s\S]*sampler\.clear\(\)/, 'non-playing states must clear held input')
  assert.match(source, /const handleBlur = \(\) => sampler\.clear\(\)/, 'blur must release input edges owned by the viewport')
  assert.match(source, /onBlur=\{handleBlur\}/, 'the focusable viewport must wire the blur clear handler')
  assert.match(source, /detach\(\)[\s\S]*sampler\.dispose\(\)/, 'unmount must detach listeners and dispose sampler state')
  assert.doesNotMatch(source, /window\.addEventListener\('keydown'|document\.addEventListener\('keydown'/, 'Play input must not use global keyboard listeners')
})

// Execute the exact consumer effect body, not a copy of its playback policy.
// This does not mount React, load an asset, or execute the Canvas frame loop.
async function animationEffect(sourceOverride?: string) {
  const source = sourceOverride ?? await readFile(component, 'utf8')
  const ast = ts.createSourceFile(component, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const owner = ast.statements.filter(ts.isFunctionDeclaration).find((entry) => entry.name?.text === 'RuntimeGltfItem')
  const effects = owner?.body?.statements.filter(ts.isExpressionStatement).map((entry) => entry.expression)
    .filter(ts.isCallExpression).filter((call) => call.expression.getText(ast) === 'useEffect'
      && ts.isArrowFunction(call.arguments[0]!) && ts.isBlock(call.arguments[0]!.body)
      && call.arguments[0]!.body.statements[0]?.getText(ast) === 'mixer.stopAllAction()') ?? []
  assert.equal(effects.length, 1, 'one exact animation effect with unchanged dependencies')
  const effectCall = effects[0]!, callback = effectCall.arguments[0] as ts.ArrowFunction
  const dependencies = effectCall.arguments[1]
  assert.ok(dependencies && ts.isArrayLiteralExpression(dependencies))
  const names = dependencies.elements.map((entry) => entry.getText(ast))
  const legacy = ['animation?.autoplay', 'animation?.clipName', 'animation?.loop', 'animation?.requestToken', 'animation?.speed', 'gltf.animations', 'mixer']
  assert.deepEqual(names.filter((name) => !['animation?.clipIndex', 'onError'].includes(name)), legacy, 'exact original playback dependencies remain')
  const body = callback.body.getText(ast).slice(1, -1)
  const imports = ast.statements.filter(ts.isImportDeclaration)
  const threeImports = imports.filter(({ importClause }) => {
    const bindings = importClause?.namedBindings
    return importClause?.name?.text === 'THREE' || (bindings && (ts.isNamespaceImport(bindings)
      ? bindings.name.text === 'THREE' : bindings.elements.some((element) => element.name.text === 'THREE')))
  })
  assert.equal(threeImports.length, 1, 'one exact consumer Three import')
  const threeImport = threeImports[0]!
  const threeClause = threeImport.importClause
  assert.ok(threeClause && !threeClause.isTypeOnly && !threeClause.name
    && threeClause.namedBindings && ts.isNamespaceImport(threeClause.namedBindings), 'consumer Three wildcard value binding')
  assert.ok(ts.isStringLiteral(threeImport.moduleSpecifier), 'consumer Three uses a literal specifier')
  const threeSpecifier = threeImport.moduleSpecifier.text
  assert.equal(threeSpecifier, 'three', 'consumer Three resolves to three')
  const helperImports = imports.filter(({ importClause }) => {
    const bindings = importClause?.namedBindings
    return importClause?.name?.text === 'initializeWorldGltfAnimation' || (bindings && (ts.isNamespaceImport(bindings)
      ? bindings.name.text === 'initializeWorldGltfAnimation' : bindings.elements.some((element) => (
        element.name.text === 'initializeWorldGltfAnimation' || element.propertyName?.text === 'initializeWorldGltfAnimation'
      ))))
  })
  assert.equal(helperImports.length, 1, 'one exact animation helper import')
  const helperImport = helperImports[0]!
  const helperClause = helperImport.importClause
  const helperBindings = helperClause?.namedBindings
  assert.ok(helperClause && !helperClause.isTypeOnly && !helperClause.name && helperBindings
    && ts.isNamedImports(helperBindings) && helperBindings.elements.length === 1, 'consumer animation helper value binding')
  const element = helperBindings.elements[0]!
  assert.ok(!element.isTypeOnly && !element.propertyName && element.name.text === 'initializeWorldGltfAnimation', 'consumer animation helper unaliased value binding')
  assert.ok(ts.isStringLiteral(helperImport.moduleSpecifier), 'consumer animation helper uses a literal specifier')
  const specifier = helperImport.moduleSpecifier.text
  assert.match(specifier, /^\.\.?\//, 'consumer animation helper uses a relative literal')
  const helperUrl = new URL(specifier, pathToFileURL(component))
  assert.equal(helperUrl.href, new URL('../runtime/worldGltfAnimationTiming.ts', pathToFileURL(component)).href, 'animation helper resolves to the owned timing policy')
  const three = await import(threeSpecifier)
  assert.equal(three, THREE, 'captured consumer Three is the installed test dependency')
  const initialize = (await import(helperUrl.href)).initializeWorldGltfAnimation
  assert.equal(typeof initialize, 'function', 'captured animation helper is callable')
  let selector: unknown
  if (names.includes('animation?.clipIndex')) {
    const declarations = imports.filter((entry) => entry.importClause?.namedBindings && ts.isNamedImports(entry.importClause.namedBindings)
      && entry.importClause.namedBindings.elements.some((binding) => binding.name.text === 'selectWorldGltfAnimationByIndex'))
    assert.equal(declarations.length, 1, 'one exact selector import')
    const entry = declarations[0]!, bindings = entry.importClause!.namedBindings as ts.NamedImports
    assert.ok(!entry.importClause!.isTypeOnly && bindings.elements.length === 1 && !bindings.elements[0]!.isTypeOnly && !bindings.elements[0]!.propertyName)
    assert.ok(ts.isStringLiteral(entry.moduleSpecifier))
    assert.equal(new URL(entry.moduleSpecifier.text, pathToFileURL(component)).href, helperUrl.href, 'selector resolves to owned timing module')
    selector = Reflect.get(await import(helperUrl.href), 'selectWorldGltfAnimationByIndex')
    assert.equal(typeof selector, 'function', 'captured actual selector is callable')
  }
  const effect = new Function('THREE', 'mixer', 'animation', 'gltf', 'initializeWorldGltfAnimation', 'selectWorldGltfAnimationByIndex', 'onError', body)
    .bind(null, three) as (mixer: THREE.AnimationMixer, animation: object, gltf: object, initializer: typeof initialize, selector: unknown, onError?: (message: string) => void) => (() => void) | undefined
  return (mixer: THREE.AnimationMixer, animation: object, gltf: object, onError?: (message: string) => void) => effect(mixer, animation, gltf, initialize, selector, onError)
}

function animationFixture(duration = 2) {
  const root = new THREE.Object3D()
  const clip = new THREE.AnimationClip('selected', duration, [new THREE.NumberKeyframeTrack('.position[x]', [0, 2], [0, 20])])
  const mixer = new THREE.AnimationMixer(root)
  const animation = { autoplay: true, loop: false, speed: -1, requestToken: 0, clipName: 'selected' }
  const gltf = { animations: [new THREE.AnimationClip('not-selected', 9, []), clip] }
  return { root, clip, mixer, animation, gltf }
}

async function startAnimation(fixture: ReturnType<typeof animationFixture>) {
  const effect = await animationEffect()
  const cleanup = effect(fixture.mixer, fixture.animation, fixture.gltf)
  const action = fixture.mixer.existingAction(fixture.clip)
  return { action, cleanup }
}

test('reverse once initializes at the actual selected clip endpoint before any delta', async () => {
  const fixture = animationFixture()
  const { action, cleanup } = await startAnimation(fixture)
  assert.ok(action)
  assert.equal(action.time, 2)
  assert.equal(action.loop, THREE.LoopOnce)
  assert.equal(action.clampWhenFinished, true)
  // Explicit test-local zero-delta evaluation; the production frame gate is untouched.
  fixture.mixer.update(0)
  assert.equal(fixture.root.position.x, 20)
  assert.equal(action.paused, false)
  cleanup?.()
  assert.equal(action.isScheduled(), false)
})

test('reverse once traverses the real numeric track and finishes only after crossing zero', async () => {
  const fixture = animationFixture()
  const finished: number[] = []
  fixture.mixer.addEventListener('finished', (event) => finished.push(event.direction))
  const { action } = await startAnimation(fixture)
  assert.ok(action)
  fixture.mixer.update(0.5)
  assert.equal(action.time, 1.5)
  assert.equal(fixture.root.position.x, 15)
  assert.deepEqual(finished, [])
  fixture.mixer.update(1.5)
  assert.equal(action.time, 0)
  assert.equal(fixture.root.position.x, 0)
  assert.deepEqual(finished, [], 'Three finishes reverse once on crossing below zero, not equality')
  fixture.mixer.update(0.1)
  assert.deepEqual(finished, [-1])
  assert.equal(action.paused, true)
  fixture.mixer.update(10)
  assert.equal(action.time, 0)
  assert.equal(fixture.root.position.x, 0)
  assert.deepEqual(finished, [-1])
})

test('runtime once preserves forward origin and both signed speed magnitudes', async () => {
  for (const speed of [-2, 2]) {
    const fixture = animationFixture()
    fixture.animation.speed = speed
    const { action } = await startAnimation(fixture)
    assert.ok(action)
    assert.equal(action.time, speed < 0 ? 2 : 0)
    fixture.mixer.update(0.25)
    assert.equal(action.time, speed < 0 ? 1.5 : 0.5)
    assert.equal(fixture.root.position.x, speed < 0 ? 15 : 5)
    fixture.mixer.update(2)
    assert.equal(action.time, speed < 0 ? 0 : 2)
    assert.equal(action.paused, true)
  }
})

test('runtime repeat retains zero origin and wraps either playback direction', async () => {
  for (const speed of [-2, 2]) {
    const fixture = animationFixture()
    Object.assign(fixture.animation, { speed, loop: true })
    const { action } = await startAnimation(fixture)
    assert.ok(action)
    assert.equal(action.time, 0)
    assert.equal(action.loop, THREE.LoopRepeat)
    assert.equal(action.clampWhenFinished, false)
    fixture.mixer.update(0.25)
    assert.equal(action.time, speed < 0 ? 1.5 : 0.5)
    assert.equal(fixture.root.position.x, speed < 0 ? 15 : 5)
    assert.equal(action.paused, false)
  }
})

test('runtime zero-duration and zero-speed actions keep finite stationary track samples', async () => {
  for (const [duration, speed, loop] of [[0, -1, true], [0, 1, false], [2, 0, true]] as const) {
    const fixture = animationFixture(duration)
    Object.assign(fixture.animation, { speed, loop })
    const { action } = await startAnimation(fixture)
    assert.ok(action)
    fixture.mixer.update(1)
    assert.equal(action.time, 0)
    assert.equal(fixture.root.position.x, 0)
    assert.equal(Number.isFinite(action.time), true)
  }
})

test('actual runtime effect admits explicit requests and restarts reverse after cleanup', async () => {
  const fixture = animationFixture()
  fixture.animation.autoplay = false
  assert.equal((await startAnimation(fixture)).action, null)
  fixture.animation.requestToken = 1
  const first = await startAnimation(fixture)
  assert.ok(first.action)
  fixture.mixer.update(0.5)
  assert.equal(first.action.time, 1.5)
  first.cleanup?.()
  assert.equal(first.action.isScheduled(), false)
  fixture.animation.requestToken = 2
  const second = await startAnimation(fixture)
  assert.equal(second.action, first.action)
  assert.equal(second.action.time, 2)
  assert.equal(second.action.paused, false)
  second.cleanup?.()
})

test('runtime clip timing rejects nonfinite duration or speed before scheduling', async () => {
  for (const [duration, speed] of [[Infinity, -1], [-1, 1], [2, NaN], [2, Infinity]] as const) {
    const fixture = animationFixture()
    fixture.clip.duration = duration
    fixture.animation.speed = speed
    await assert.rejects(startAnimation(fixture), RangeError)
  }
})

test('runtime effect extraction rejects a missing actual helper import', async () => {
  const source = await readFile(component, 'utf8')
  await assert.rejects(animationEffect(source.replace("import { initializeWorldGltfAnimation } from '../runtime/worldGltfAnimationTiming.ts'\n", '')), /one exact animation helper import/)
})

test('runtime effect extraction rejects a misdirected actual helper import', async () => {
  const source = await readFile(component, 'utf8')
  await assert.rejects(animationEffect(source.replace("from '../runtime/worldGltfAnimationTiming.ts'", "from '../runtime/worldRuntimeClock.ts'")), /animation helper resolves to the owned timing policy/)
})

test('runtime effect extraction rejects duplicate actual helper imports', async () => {
  const source = await readFile(component, 'utf8')
  const declaration = "import { initializeWorldGltfAnimation } from '../runtime/worldGltfAnimationTiming.ts'\n"
  await assert.rejects(animationEffect(source.replace(declaration, declaration + declaration)), /one exact animation helper import/)
})

test('runtime effect extraction rejects missing misdirected or duplicate actual Three imports', async () => {
  const source = await readFile(component, 'utf8')
  const declaration = "import * as THREE from 'three'\n"
  for (const replacement of ['', "import * as THREE from 'three/wrong-module'\n", declaration + declaration]) {
    await assert.rejects(animationEffect(source.replace(declaration, replacement)), /one exact consumer Three import|consumer Three resolves to three/)
  }
})

test('runtime effect extraction rejects a helper import hidden in a block comment', async () => {
  const source = await readFile(component, 'utf8')
  const declaration = "import { initializeWorldGltfAnimation } from '../runtime/worldGltfAnimationTiming.ts'\n"
  await assert.rejects(animationEffect(source.replace(declaration, `/*\n${declaration}*/\n`)), /one exact animation helper import/)
})

test('runtime effect extraction rejects a Three import hidden in a block comment', async () => {
  const source = await readFile(component, 'utf8')
  const declaration = "import * as THREE from 'three'\n"
  await assert.rejects(animationEffect(source.replace(declaration, `/*\n${declaration}*/\n`)), /one exact consumer Three import/)
})

import { createRuntimeWorldSnapshot } from '../runtime/_testFixtures.ts'
import type { WorldRuntimeAnimationRequest, WorldRuntimeBodyPose } from '../runtime/worldPlayController.ts'
import type { WorldCameraComponent } from '../core/worldComponentRegistry.ts'
import type { WorldTransform } from '../core/worldModel.ts'
import type { WorldsViewportLight } from '../worldsViewportTypes.ts'
import type { WorldSceneItem } from '../worldRenderableResolver.ts'

type ProjectionValue = { success: false; message: string } | { success: true; project: ReturnType<typeof createRuntimeWorldSnapshot>['project']; items: (WorldSceneItem & { runtimeAnimation?: { requestToken: number } })[]; lights: WorldsViewportLight[]; primaryCamera: { component: WorldCameraComponent; transform: WorldTransform } }

// Verbatim consumer memo/functions plus real imports; explicit hook-slot evaluations,
// NOT mounted React scheduling, effects, Canvas, asset loading, or GPU lifecycle proof.
async function projectionConsumer(sourceOverride?: string) {
  const source = sourceOverride ?? await readFile(component, 'utf8')
  const ast = ts.createSourceFile(component, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const imports = ast.statements.filter(ts.isImportDeclaration)
  const helpers = [['projectWorldEditorViewport', '../editor/useWorldEditorProjectionBridge.ts'], ['resolveWorldRuntimeTransforms', '../runtime/worldRuntimeEntityGraph.ts'], ['isWorldGltfAnimationResourceBoundToModel', '../core/worldModel.ts']] as const
  for (const [name, specifier] of [...helpers, ['useMemo', 'react']] as const) {
    const declarations = imports.filter((entry) => entry.importClause?.namedBindings && ts.isNamedImports(entry.importClause.namedBindings) && entry.importClause.namedBindings.elements.some((binding) => binding.name.text === name || binding.propertyName?.text === name))
    assert.equal(declarations.length, 1, `one actual ${name} import`)
    const entry = declarations[0]!
    const bindings = entry.importClause!.namedBindings as ts.NamedImports
    const binding = bindings.elements.find((entry) => entry.name.text === name)!
    assert.ok(!entry.importClause!.isTypeOnly && binding && !binding.isTypeOnly && !binding.propertyName, `${name} unaliased value binding`)
    assert.ok(ts.isStringLiteral(entry.moduleSpecifier))
    assert.equal(entry.moduleSpecifier.text, specifier, `${name} owned module binding`)
  }
  const owner = ast.statements.filter(ts.isFunctionDeclaration).find((entry) => entry.name?.text === 'WorldRuntimeViewport')!
  assert.ok(owner?.body, 'actual viewport function body')
  const memos = owner.body.statements.filter(ts.isVariableStatement).filter((entry) => entry.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && /projection/i.test(declaration.name.text) && declaration.initializer && ts.isCallExpression(declaration.initializer) && declaration.initializer.expression.getText(ast) === 'useMemo'))
  assert.ok(memos.length >= 1 && memos.length <= 2, 'actual projection memo statements only')
  const functions = ast.statements.filter(ts.isFunctionDeclaration).filter((entry) => entry.name && /^projectRuntime/.test(entry.name.text))
  assert.ok(functions.length >= 1 && functions.length <= 2, 'actual projection functions only')
  const modules = await Promise.all(helpers.map(([, specifier]) => import(new URL(specifier, pathToFileURL(component)).href)))
  const canonical = modules[0]!.projectWorldEditorViewport
  assert.equal(typeof canonical, 'function', 'real canonical projector callable')
  let calls = 0, cursor = 0
  const slots: { deps: readonly unknown[]; value: unknown }[] = []
  const useMemo = (factory: () => unknown, deps: readonly unknown[]) => {
    const index = cursor++, previous = slots[index]
    if (previous && previous.deps.length === deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return previous.value
    const value = factory(); slots[index] = { deps: [...deps], value }; return value
  }
  const code = ts.transpileModule([...functions, ...memos].map((entry) => entry.getText(ast)).join('\n') + '\nreturn projection;', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const evaluate = new Function('useMemo', ...helpers.map(([name]) => name), 'snapshot', 'sceneId', 'apiUrl', 'bodyPoses', 'animationRequests', code) as (...args: unknown[]) => ProjectionValue
  return { get calls() { return calls }, render(snapshot: ReturnType<typeof createRuntimeWorldSnapshot>, sceneId = 'scene:one', apiUrl = 'http://127.0.0.1:8000', poses: readonly WorldRuntimeBodyPose[] = [], requests: readonly WorldRuntimeAnimationRequest[] = []) {
    cursor = 0
    return evaluate(useMemo, (...args: unknown[]) => { calls++; return canonical(...args) }, modules[1]!.resolveWorldRuntimeTransforms, modules[2]!.isWorldGltfAnimationResourceBoundToModel, snapshot, sceneId, apiUrl, poses, requests)
  } }
}

function projectionFixture() {
  const snapshot = createRuntimeWorldSnapshot(), entities = snapshot.scenes[0]!.entities
  entities.find((entity) => entity.id === 'entity:hero')!.parentId = 'entity:crate'
  entities.find((entity) => entity.id === 'entity:camera')!.parentId = 'entity:crate'
  entities.push({ id: 'entity:light', name: 'Light', parentId: 'entity:hero', enabled: true, locked: false, tags: [], transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: [{ id: 'component:light', type: 'light', enabled: true, lightKind: 'point', color: '#ffffff', intensity: 1, range: 20, castShadow: true }] })
  return snapshot
}

test('actual runtime consumer reuses canonical projection on two pose-only updates with current hierarchy poses', async () => {
  const consumer = await projectionConsumer(), snapshot = projectionFixture(), before = structuredClone(snapshot)
  const initial = consumer.render(snapshot)
  assert.ok(initial.success)
  for (const x of [10, 40]) {
    const projected = consumer.render(snapshot, undefined, undefined, [{ entityId: 'entity:crate', position: [x, 20, 30], rotation: [0, 0, 0, 1] }], [])
    assert.ok(projected.success)
    assert.deepEqual(projected.items[0]!.transform.position, [x, 21, 30])
    assert.deepEqual(projected.lights[0]!.transform.position, [x + 1, 23, 33])
    assert.deepEqual(projected.primaryCamera.transform.position, [x, 22, 36])
    assert.equal(projected.items[0]!.runtimeAnimation!.requestToken, 0)
  }
  assert.deepEqual(snapshot, before, 'cached projection must not mutate snapshot')
  assert.deepEqual(initial.items[0]!.transform.position, [2, 3, 0], 'previous presentation remains intact')
  assert.equal(consumer.calls, 1, 'pose-only updates must not rerun the real canonical projector')
})

test('actual runtime consumer reuses canonical projection on two request-only updates with fresh pose identities', async () => {
  const consumer = await projectionConsumer(), snapshot = projectionFixture(), initial = consumer.render(snapshot)
  assert.ok(initial.success)
  for (const token of [1, 2]) {
    const projected = consumer.render(snapshot, undefined, undefined, [], [{ entityId: 'entity:hero', componentId: 'component:hero-animation', token }])
    assert.ok(projected.success)
    assert.equal(projected.items[0]!.runtimeAnimation!.requestToken, token)
    assert.deepEqual(projected.primaryCamera.transform, initial.primaryCamera.transform)
    assert.deepEqual(projected.lights[0]!.transform, initial.lights[0]!.transform)
  }
  assert.equal(initial.items[0]!.runtimeAnimation!.requestToken, 0, 'previous player metadata is not mutated')
  assert.equal(consumer.calls, 1, 'request-only updates must not rerun the real canonical projector')
})

test('actual runtime consumer invalidates snapshot scene API and recovers projection errors including same revision changes', async () => {
  const consumer = await projectionConsumer(), snapshot = projectionFixture()
  assert.ok(consumer.render(snapshot).success)
  assert.ok(consumer.render(snapshot, 'scene:two').success)
  const api = consumer.render(snapshot, 'scene:one', 'http://127.0.0.1:9000')
  assert.ok(api.success); assert.match(api.items[0]!.url, /:9000/)
  assert.equal(consumer.calls, 3)
  const changed = structuredClone(snapshot), hero = changed.scenes[0]!.entities.find((entity) => entity.id === 'entity:hero')!
  const renderable = hero.components.find((component) => component.type === 'renderable')!
  assert.equal(renderable.type, 'renderable'); if (renderable.type !== 'renderable') throw new Error('Fixture renderable missing')
  renderable.material.opacity = 0.25; renderable.visible = false
  assert.equal(changed.project.revision, snapshot.project.revision)
  const visual = consumer.render(changed, 'scene:one', 'http://127.0.0.1:9000')
  assert.ok(visual.success); assert.equal(visual.items[0]!.material!.opacity, 0.25); assert.equal(visual.items[0]!.visible, false)
  assert.equal(consumer.calls, 4)
  const invalid = structuredClone(changed); invalid.project.activeGraphicsProfileId = 'graphics:missing'
  assert.equal(consumer.render(invalid).success, false)
  assert.equal(consumer.render(changed).success, true)
  const camera = structuredClone(changed)
  camera.scenes[0]!.entities.find((entity) => entity.id === 'entity:camera')!.enabled = false
  assert.equal(consumer.render(camera).success, false)
  assert.equal(consumer.render(changed).success, true)
  assert.equal(consumer.calls, 8)
})

test('runtime projection extraction rejects missing commented duplicate or misdirected canonical imports', async () => {
  const source = await readFile(component, 'utf8'), declaration = "import { projectWorldEditorViewport } from '../editor/useWorldEditorProjectionBridge.ts'\n"
  for (const replacement of ['', `/* ${declaration} */\n`, declaration + declaration, declaration.replace('useWorldEditorProjectionBridge', 'worldEditorProjection')]) {
    await assert.rejects(projectionConsumer(source.replace(declaration, replacement)), /one actual projectWorldEditorViewport import|owned module binding/)
  }
})

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

async function loadedExactSelectorClips() {
  // Actual installed loader, inline glTF JSON and empty tracks: no network, GPU or decoder.
  const names = ['Duplicate', undefined, 'Duplicate', 'animation_1', '', 'unrepresentable\u0001name']
  const gltf = await new GLTFLoader().parseAsync(JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }], nodes: [],
    animations: names.map((name) => ({ ...(name === undefined ? {} : { name }), channels: [], samplers: [] })),
  }), '')
  assert.deepEqual(gltf.animations.map((clip) => clip.name), ['Duplicate', 'animation_1', 'Duplicate', 'animation_1', 'animation_4', 'unrepresentable\u0001name'])
  return gltf.animations
}

test('shared explicit-index helper selects actual loaded duplicates generated names and collisions by object identity', async () => {
  const clips = await loadedExactSelectorClips()
  const helper = Reflect.get(await import('../runtime/worldGltfAnimationTiming.ts'), 'selectWorldGltfAnimationByIndex')
  assert.equal(typeof helper, 'function', 'new explicit-index-only helper exists')
  for (const clipIndex of [0, 1, 2, 3, 4, 5]) {
    const result = helper(clips, { clipIndex })
    assert.equal(result.success, true)
    assert.equal(result.clip, clips[clipIndex])
    const namedResult = helper(clips, { clipIndex, clipName: clips[clipIndex]!.name })
    assert.equal(namedResult.success, true)
    if (namedResult.success) assert.equal(namedResult.clip, clips[clipIndex])
  }
  for (const clipIndex of [undefined, null, '0', true, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(helper(clips, { clipIndex, clipName: 'Duplicate' }), { success: false, reason: 'invalid-index' })
  }
  for (const clipIndex of [clips.length, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(helper(clips, { clipIndex, clipName: 'Duplicate' }), { success: false, reason: 'index-out-of-range' })
  }
  assert.deepEqual(helper([], { clipIndex: 0 }), { success: false, reason: 'index-out-of-range' })
  assert.deepEqual(helper(clips, { clipIndex: 1, clipName: 'Duplicate' }), { success: false, reason: 'name-mismatch' })
  assert.deepEqual(helper(clips, { clipIndex: 0, clipName: '' }), { success: false, reason: 'name-mismatch' })
})

test('actual live effect consumes exact indices without name-first fallback and keeps legacy name-first policies', async () => {
  const clips = await loadedExactSelectorClips(), effect = await animationEffect()
  for (const clipIndex of [0, 1, 2, 3, 4, 5]) {
    const mixer = new THREE.AnimationMixer(new THREE.Object3D())
    const cleanup = effect(mixer, { clipIndex, autoplay: true, loop: true, speed: 1, requestToken: 0 }, { animations: clips })
    assert.ok(mixer.existingAction(clips[clipIndex]!), `actual indexed action ${clipIndex}`)
    for (const [index, clip] of clips.entries()) if (index !== clipIndex) assert.equal(mixer.existingAction(clip), null)
    assert.equal(mixer.existingAction(clips[clipIndex]!)!.paused, true, 'actual zero-duration loaded clip remains finite')
    assert.equal(mixer.existingAction(clips[clipIndex]!)!.time, 0)
    cleanup?.()
    assert.equal(mixer.existingAction(clips[clipIndex]!)!.isScheduled(), false)
    assert.equal(mixer.existingAction(clips[clipIndex]!)!.paused, false, 'cleanup resets the stopped action')
  }
  for (const clipName of [undefined, 'Duplicate', 'animation_1', 'missing']) {
    const mixer = new THREE.AnimationMixer(new THREE.Object3D())
    effect(mixer, { clipName, autoplay: true, loop: false, speed: 1, requestToken: 0 }, { animations: clips })
    const selected = clipName === undefined ? clips[0] : clips.find((clip) => clip.name === clipName)
    assert.equal(clips.filter((clip) => mixer.existingAction(clip)).length, selected ? 1 : 0)
    if (selected) assert.ok(mixer.existingAction(selected))
    mixer.stopAllAction()
  }
})

test('actual live invalid exact selector diagnoses rejection and never schedules another matching clip', async () => {
  const clips = await loadedExactSelectorClips(), effect = await animationEffect()
  for (const [clipIndex, clipName, reason] of [[-1, 'Duplicate', 'invalid-index'], ['0', 'Duplicate', 'invalid-index'], [clips.length, 'Duplicate', 'index-out-of-range'], [1, 'Duplicate', 'name-mismatch']] as const) {
    const mixer = new THREE.AnimationMixer(new THREE.Object3D()), errors: string[] = []
    assert.equal(effect(mixer, { clipIndex, clipName, autoplay: true, loop: false, speed: 1, requestToken: 0 }, { animations: clips }, (message) => errors.push(message)), undefined)
    assert.equal(clips.filter((clip) => mixer.existingAction(clip)).length, 0)
    assert.deepEqual(errors, [`Indexed glTF animation selection failed (${reason}).`])
  }
})

test('actual cold projection preserves zero and nonfirst index through requests and invalidates same-revision selection', async () => {
  const consumer = await projectionConsumer(), snapshot = projectionFixture()
  const resource = snapshot.project.resources.find((resource) => resource.type === 'animation')!
  Object.assign(resource, { clipIndex: 0 })
  const initial = consumer.render(snapshot)
  assert.ok(initial.success)
  assert.equal(Reflect.get(initial.items[0]!.runtimeAnimation!, 'clipIndex'), 0)
  const requested = consumer.render(snapshot, undefined, undefined, [], [{ entityId: 'entity:hero', componentId: 'component:hero-animation', token: 2 }])
  assert.ok(requested.success)
  assert.equal(Reflect.get(requested.items[0]!.runtimeAnimation!, 'clipIndex'), 0)
  assert.equal(consumer.calls, 1)
  const changed = structuredClone(snapshot)
  Object.assign(changed.project.resources.find((resource) => resource.type === 'animation')!, { clipIndex: 2 })
  assert.equal(changed.project.revision, snapshot.project.revision)
  const rebound = consumer.render(changed)
  assert.ok(rebound.success)
  assert.equal(Reflect.get(rebound.items[0]!.runtimeAnimation!, 'clipIndex'), 2)
  assert.equal(consumer.calls, 2)
})

test('actual animation effect dependencies and existing error routing include exact selection changes', async () => {
  const source = await readFile(component, 'utf8')
  const ast = ts.createSourceFile(component, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const owner = ast.statements.filter(ts.isFunctionDeclaration).find((entry) => entry.name?.text === 'RuntimeGltfItem')!
  const effect = owner.body!.statements.filter(ts.isExpressionStatement).map((entry) => entry.expression).filter(ts.isCallExpression)
    .find((call) => call.expression.getText(ast) === 'useEffect' && call.arguments[0]!.getText(ast).includes('initializeWorldGltfAnimation'))!
  assert.ok(ts.isArrayLiteralExpression(effect.arguments[1]!))
  assert.ok(effect.arguments[1]!.elements.some((entry) => entry.getText(ast) === 'animation?.clipIndex'))
  assert.match(source, /RuntimeItemObject key=\{item\.id\} item=\{item\} lifecycle=\{lifecycle\} onError=\{onError\}/)
  assert.match(source, /RuntimeGltfItem item=\{item\} lifecycle=\{lifecycle\} onError=\{onError\}/)
})

import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import type { WorldRuntimeInputFrame } from '../runtime/worldInputRuntime.ts'
import type { WorldRuntimeViewportProps } from './WorldRuntimeViewport.tsx'

const require = createRequire(import.meta.url)
const React = require('react') as typeof import('react')
const Reconciler = require('react-reconciler')
type InputHostProps = Record<string, unknown>
class InputHost extends EventTarget {
  children: InputHost[] = []
  type: string
  props: InputHostProps
  constructor(type: string, props: InputHostProps) { super(); this.type = type; this.props = props }
  focus(): void {}
}

// Real React commits/hooks and the complete production viewport/input sampler.
// Only Canvas/graphics/asset adapters are inert. RAF and events are controlled
// source-test fixtures, not trusted native input, real rendering or GPU proof.
async function heldInputHarness() {
  const dir = await mkdtemp('/tmp/world-runtime-held-input-')
  const repo = path.resolve(import.meta.dirname, '../../../..')
  await symlink(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
  await writeFile(path.join(dir, 'package.json'), '{"type":"module"}')
  const graphics = path.join(dir, 'graphics.mjs'), fiber = path.join(dir, 'fiber.mjs'), drei = path.join(dir, 'drei.mjs')
  await writeFile(fiber, `import React from 'react'; export function Canvas({ children }) { return React.createElement(React.Fragment, null, children) }; export function useThree() { return { size: { width: 100, height: 100 } } }; export function useFrame() {}; export function useLoader() { throw new Error('unexpected asset load') }`)
  await writeFile(drei, `export function Environment() { return null }; export function OrthographicCamera() { return null }; export function PerspectiveCamera() { return null }; export function useGLTF() { throw new Error('unexpected glTF load') }`)
  await writeFile(graphics, `import React from 'react'; let ready; export function setReady(value) { if (!ready) throw new Error('missing mounted graphics owner'); ready(value) }; export function WorldCanvasLifecycle({ onReady }) { React.useLayoutEffect(() => { ready = onReady; onReady(true); return () => { ready = undefined; onReady(false) } }, [onReady]); return null }; export function WorldViewportGraphics() { return null }; export function WorldsGaussianPlyObject() { return null }`)
  const aliases = new Map([
    ['@react-three/fiber', fiber], ['@react-three/drei', drei],
    [path.join(import.meta.dirname, 'WorldViewportBoundary.tsx'), graphics],
    [path.join(import.meta.dirname, 'WorldViewportGraphics.tsx'), graphics],
    [path.join(import.meta.dirname, 'WorldsGaussianPlyObject.tsx'), graphics],
  ])
  const result = await build({
    entryPoints: [component], bundle: true, write: false, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', tsconfig: path.join(repo, 'tsconfig.web.json'),
    plugins: [{ name: 'held-input-mounted-adapters', setup(api) {
      api.onResolve({ filter: /.*/ }, (args) => {
        const key = args.path.startsWith('.') ? path.resolve(args.resolveDir, args.path) : args.path
        return aliases.has(key) ? { path: aliases.get(key)!, external: true } : undefined
      })
      api.onLoad({ filter: /WorldRuntimeViewport\.tsx$/ }, async (args) => {
        assert.equal(args.path, component)
        const source = await readFile(args.path, 'utf8')
        const ast = ts.createSourceFile(component, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
        const samplerImports = ast.statements.filter(ts.isImportDeclaration).filter((entry) => entry.moduleSpecifier.getText(ast) === "'../runtime/worldInputRuntime.ts'")
        assert.equal(samplerImports.filter((entry) => !entry.importClause?.isTypeOnly).length, 1, 'one actual value sampler import')
        return { contents: source + '\nexport { WorldInputSampler as __HeldInputSampler };', loader: 'tsx', resolveDir: import.meta.dirname }
      })
    } }],
  })
  const outfile = path.join(dir, 'viewport.mjs')
  await writeFile(outfile, result.outputFiles[0]!.text + `\nexport { setReady as __setReady } from ${JSON.stringify(pathToFileURL(graphics).href)};`)
  const module = await import(pathToFileURL(outfile).href) as {
    WorldRuntimeViewport: React.ComponentType<WorldRuntimeViewportProps>
    __HeldInputSampler: typeof import('../runtime/worldInputRuntime.ts').WorldInputSampler
    __setReady(ready: boolean): void
  }
  const append = (parent: InputHost, child: InputHost) => { parent.children.push(child) }
  const remove = (parent: InputHost, child: InputHost) => { parent.children.splice(parent.children.indexOf(child), 1) }
  const renderer = Reconciler({
    now: performance.now.bind(performance), supportsMutation: true, isPrimaryRenderer: true,
    getRootHostContext: () => null, getChildHostContext: () => null, getPublicInstance: (node: InputHost) => node,
    prepareForCommit: () => null, resetAfterCommit() {}, shouldSetTextContent: () => false,
    createInstance: (type: string, props: InputHostProps) => new InputHost(type, props),
    createTextInstance: (text: string) => new InputHost('#text', { text }),
    appendInitialChild: append, appendChild: append, appendChildToContainer: append,
    removeChild: remove, removeChildFromContainer: remove, clearContainer: (node: InputHost) => { node.children = [] },
    insertBefore: append, insertInContainerBefore: append, finalizeInitialChildren: () => false,
    prepareUpdate: () => true, commitUpdate: (node: InputHost, _payload: unknown, _type: unknown, _old: unknown, props: InputHostProps) => { node.props = props },
    commitTextUpdate: (node: InputHost, _old: unknown, text: string) => { node.props.text = text },
    scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1, getCurrentEventPriority: () => 1,
    detachDeletedInstance() {}, supportsMicrotasks: true, scheduleMicrotask: queueMicrotask,
  })
  const container = new InputHost('root', {})
  const root = renderer.createContainer(container, 1, null, false, null, '', () => {}, null)
  const flush = (operation: () => void) => { renderer.flushSync(operation); renderer.flushPassiveEffects() }
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrameId = 0, clears = 0, disposals = 0
  const descriptors = ['requestAnimationFrame', 'cancelAnimationFrame'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => { frames.set(++nextFrameId, callback); return nextFrameId } })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => { frames.delete(id) } })
  const prototype = module.__HeldInputSampler.prototype, clear = prototype.clear, dispose = prototype.dispose, sample = prototype.sample
  let sampledOwner: InstanceType<typeof module.__HeldInputSampler> | undefined
  const recordSampledOwner = (owner: InstanceType<typeof module.__HeldInputSampler>) => { sampledOwner = owner }
  prototype.clear = function () { clears++; return clear.call(this) }
  prototype.dispose = function () { disposals++; return dispose.call(this) }
  prototype.sample = function () { recordSampledOwner(this); return sample.call(this) }
  const snapshot = createRuntimeWorldSnapshot()
  snapshot.scenes[0]!.entities = snapshot.scenes[0]!.entities.filter((entity) => entity.id === 'entity:camera')
  snapshot.scenes[0]!.entities[0]!.components = snapshot.scenes[0]!.entities[0]!.components.filter((entry) => entry.type === 'camera')
  const inputFrames: WorldRuntimeInputFrame[] = []
  let props: WorldRuntimeViewportProps = { snapshot, sceneId: 'scene:one', apiUrl: '', lifecycle: 'playing', bodyPoses: [], animationRequests: [], onAdvance: (_time, input) => { inputFrames.push(input) } }
  const suspended = new Promise<void>(() => {})
  function Suspender(): React.ReactNode { throw suspended }
  const tree = (value: WorldRuntimeViewportProps, suspend = false) => React.createElement(React.Suspense, { fallback: null },
    React.createElement(module.WorldRuntimeViewport, value), suspend ? React.createElement(Suspender) : null)
  const render = (patch: Partial<WorldRuntimeViewportProps> = {}) => { props = { ...props, ...patch }; flush(() => renderer.updateContainer(tree(props), root, null, null)) }
  const element = () => {
    const node = container.children.find((entry) => entry.props['aria-label'] === 'Play viewport')
    assert.ok(node, 'real production focusable input owner mounted')
    return node
  }
  const key = (type: 'keydown' | 'keyup', code = 'KeyD') => element().dispatchEvent(Object.assign(new Event(type), { code, key: code === 'KeyD' ? 'd' : code }))
  return {
    snapshot, inputFrames, render, element, key, frames,
    get clears() { return clears }, get disposals() { return disposals },
    get sampledOwner() { assert.ok(sampledOwner); return sampledOwner },
    ready: (value: boolean) => flush(() => module.__setReady(value)),
    transition: (patch: Partial<WorldRuntimeViewportProps>) => React.startTransition(() => renderer.updateContainer(tree({ ...props, ...patch }, true), root, null, null)),
    async tick(time = 100) { const first = frames.entries().next().value; assert.ok(first, 'one scheduled production RAF'); frames.delete(first[0]); first[1](time); await new Promise<void>((resolve) => setImmediate(resolve)) },
    async settle() { await new Promise<void>((resolve) => setImmediate(resolve)) },
    unmount: () => flush(() => renderer.updateContainer(null, root, null, null)),
    async cleanup() {
      try { flush(() => renderer.updateContainer(null, root, null, null)) }
      finally {
        prototype.clear = clear; prototype.dispose = dispose; prototype.sample = sample
        for (const [name, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name) }
        await rm(dir, { recursive: true, force: true })
      }
    },
  }
}

function moveState(frame: WorldRuntimeInputFrame | undefined) {
  assert.ok(frame)
  const state = frame.actions['input:move']; assert.ok(state)
  return state
}

test('mounted production viewport keeps one held D through error advance and pose-only callback churn until keyup', async () => {
  const h = await heldInputHarness()
  try {
    h.render(); h.key('keydown'); await h.tick()
    assert.deepEqual(moveState(h.inputFrames.at(-1)), { value: [1, 0], held: true, pressed: true, released: false })
    const clears = h.clears, originalRoot = h.element()
    h.render({ onError: () => undefined }); await h.tick(150)
    assert.deepEqual(moveState(h.inputFrames.at(-1)), { value: [1, 0], held: true, pressed: false, released: false })
    const newest: WorldRuntimeInputFrame[] = []
    h.render({ onAdvance: (_time, input) => { newest.push(input); h.inputFrames.push(input) } }); await h.tick(200)
    for (let index = 0; index < 3; index++) {
      h.render({ bodyPoses: [{ entityId: 'entity:camera', position: [index, 2, 6], rotation: [0, 0, 0, 1] }], animationRequests: [], onError: () => undefined })
      await h.tick(250 + index * 50)
      assert.deepEqual(moveState(newest.at(-1)), { value: [1, 0], held: true, pressed: false, released: false })
    }
    h.render({ snapshot: structuredClone(h.snapshot) })
    assert.equal(h.element(), originalRoot); assert.equal(h.clears, clears); assert.equal(newest.length, 4)
    assert.deepEqual(h.inputFrames.map((frame) => frame.sequence), [1, 2, 3, 4, 5, 6])
    h.key('keyup'); await h.tick(450)
    assert.deepEqual(moveState(newest.at(-1)), { value: [0, 0], held: false, pressed: false, released: true })
    await h.tick(500); assert.equal(moveState(newest.at(-1)).released, false)
    assert.equal(h.frames.size, 1)
  } finally { await h.cleanup() }
})

test('mounted production viewport routes synchronous and pending promise errors to latest committed callback', async () => {
  const h = await heldInputHarness(), errors: string[] = []
  try {
    h.render({ onAdvance: () => { throw new Error('sync advance') }, onError: (message) => errors.push(`old:${message}`) })
    await h.tick(); assert.deepEqual(errors, ['old:sync advance'])
    let reject!: (error: Error) => void
    const pending = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise })
    h.render({ onAdvance: () => pending }); await h.tick(150)
    h.render({ onError: (message) => errors.push(`new:${message}`) })
    reject(new Error('pending advance')); await h.settle()
    assert.deepEqual(errors, ['old:sync advance', 'new:pending advance'])
    h.render({ onAdvance: () => Promise.reject('unknown failure') }); await h.tick(200)
    assert.equal(errors.at(-1), 'new:Play update failed.')
  } finally { await h.cleanup() }
})

test('mounted production viewport clears real blur pause loading graphics loss and input-map replacement', async () => {
  const h = await heldInputHarness()
  try {
    h.render(); h.key('keydown'); await h.tick()
    h.element().dispatchEvent(new Event('blur')); await h.tick(150)
    assert.deepEqual(moveState(h.inputFrames.at(-1)), { value: [0, 0], held: false, pressed: false, released: true })
    for (const lifecycle of ['paused', 'loading', 'stopping'] as const) {
      h.key('keydown'); await h.tick(200)
      const clears = h.clears
      h.render({ lifecycle }); assert.equal(h.frames.size, 0); assert.ok(h.clears > clears)
      h.render({ lifecycle: 'playing' }); await h.tick(250)
      assert.equal(moveState(h.inputFrames.at(-1)).held, false)
    }
    h.key('keydown'); await h.tick(300); h.ready(false); assert.equal(h.frames.size, 0)
    h.ready(true); await h.tick(350); assert.equal(moveState(h.inputFrames.at(-1)).held, false)
    h.key('keydown'); await h.tick(400)
    const disposals = h.disposals, replacement = structuredClone(h.snapshot)
    replacement.project.inputActions[0]!.bindings[1]!.scale = 0.5
    h.render({ snapshot: replacement }); assert.equal(h.disposals, disposals + 1)
    await h.tick(450); assert.equal(moveState(h.inputFrames.at(-1)).held, false)
    h.key('keydown'); await h.tick(500); assert.deepEqual(moveState(h.inputFrames.at(-1)).value, [0.5, 0])
    const owner = h.element(), sampledOwner = h.sampledOwner, clears = h.clears
    h.unmount(); assert.equal(h.frames.size, 0); assert.ok(h.clears > clears)
    owner.dispatchEvent(Object.assign(new Event('keydown'), { code: 'KeyD', key: 'd' }))
    assert.equal(moveState(sampledOwner.sample()).held, false, 'real detached listener cannot restore a cleared control')
  } finally { await h.cleanup() }
})

test('mounted production viewport has no overlapping advances or late callbacks after active owner teardown', async () => {
  const h = await heldInputHarness(), errors: string[] = []
  try {
    let reject!: (error: Error) => void, calls = 0
    const pending = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise })
    h.render({ onAdvance: () => { calls++; return pending }, onError: (message) => errors.push(message) })
    const staleTick = [...h.frames.values()][0]!
    await h.tick()
    h.render({ onAdvance: () => { calls++; return Promise.resolve() }, onError: (message) => errors.push(`latest:${message}`) })
    await h.tick(150); assert.equal(calls, 1, 'callback replacement cannot start another advance while one is pending')
    h.unmount(); assert.equal(h.frames.size, 0)
    staleTick(200); reject(new Error('late advance')); await h.settle()
    assert.equal(calls, 1); assert.deepEqual(errors, []); assert.equal(h.frames.size, 0)
  } finally { await h.cleanup() }
})

test('mounted production viewport rejects abandoned concurrent callbacks and queued work after teardown', async () => {
  const h = await heldInputHarness(), calls: string[] = []
  try {
    h.render({ onAdvance: () => { calls.push('committed'); throw new Error('committed failure') }, onError: (message) => calls.push(message) })
    h.transition({ onAdvance: () => { calls.push('abandoned') }, onError: () => calls.push('abandoned error') })
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    await h.tick()
    assert.deepEqual(calls, ['committed', 'committed failure'])
    h.render()
    const first = h.frames.entries().next().value; assert.ok(first)
    h.frames.delete(first[0]); first[1](150)
    h.unmount(); await h.settle()
    assert.deepEqual(calls, ['committed', 'committed failure'], 'queued microtask cannot advance or report after owner teardown')
    assert.equal(h.frames.size, 0)
  } finally { await h.cleanup() }
})

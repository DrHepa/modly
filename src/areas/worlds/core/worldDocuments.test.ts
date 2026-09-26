import assert from 'node:assert/strict'
import { Session } from 'node:inspector/promises'
import test from 'node:test'

import {
  cloneWorldProjectSnapshot,
  normalizeWorldWorkspacePath,
  parseWorldInputActionsDocument,
  parseWorldProjectDocument,
  parseWorldSceneDocument,
  parseWorldSequenceDocument,
  validateWorldProjectSnapshot,
} from './worldDocuments.ts'
import { createValidWorldSnapshot } from './_testFixtures.ts'
import type { WorldBehaviorAction, WorldBehaviorEvent } from './worldComponentRegistry.ts'
import { WORLD_CUBIC_INTERPOLATION_SEMANTICS, type WorldProjectSnapshotV1, type WorldSequence } from './worldModel.ts'

test('snapshot parsing normalizes its wire once without bypassing public document boundaries', async (t) => {
  const snapshot = createValidWorldSnapshot()
  // Component parsing has its own independent boundary, outside this optimization.
  snapshot.scenes[0].entities[0].components = []
  const operations = [
    ['project', () => parseWorldProjectDocument(snapshot.project)],
    ['scene', () => parseWorldSceneDocument(snapshot.scenes[0])],
    ['snapshot', () => validateWorldProjectSnapshot(snapshot)],
  ] as const
  const counts: Record<string, number> = {}
  const inspector = new Session()
  // In-process instrumentation only: no listening inspector endpoint or replaced globals.
  inspector.connect()
  try {
    await inspector.post('Profiler.enable')
    await inspector.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false })
    for (const [name, operation] of operations) {
      await inspector.post('Profiler.takePreciseCoverage')
      const parsed = operation()
      const coverage = await inspector.post('Profiler.takePreciseCoverage')
      assert.equal(parsed.success, true, JSON.stringify(parsed))
      const wire = coverage.result.find((script) => script.url === new URL('./worldWireValidation.ts', import.meta.url).href)
      assert.ok(wire, 'Actual wire validation module must appear in runtime coverage.')
      const normalizer = wire.functions.find((fn) => fn.functionName === 'normalizeWorldWireValue')
      assert.ok(normalizer, 'Actual normalizer must appear in runtime coverage.')
      counts[name] = normalizer.ranges[0].count
    }
  } finally {
    try { await inspector.post('Profiler.stopPreciseCoverage') } finally { inspector.disconnect() }
  }
  t.diagnostic(`Actual normalization calls (not latency): ${JSON.stringify(counts)}`)
  assert.deepEqual(counts, { project: 1, scene: 1, snapshot: 1 })
})

test('project scene and snapshot public boundaries retain hostile-wire rejection and limits', () => {
  const snapshot = createValidWorldSnapshot()
  const boundaries = [
    { value: snapshot.project, parse: parseWorldProjectDocument },
    { value: snapshot.scenes[0], parse: parseWorldSceneDocument },
    { value: snapshot, parse: validateWorldProjectSnapshot },
  ]
  let getterCalls = 0
  let proxyReads = 0
  for (const { value, parse } of boundaries) {
    const accessor = structuredClone(value)
    Object.defineProperty(accessor, 'hidden', { enumerable: true, get() { getterCalls += 1; return true } })
    const polluted = structuredClone(value)
    Object.defineProperty(polluted, '__proto__', { enumerable: true, value: {} })
    const cyclic = { ...structuredClone(value), cycle: {} }
    cyclic.cycle = cyclic
    const shared = { data: true }
    const wide = { ...structuredClone(value), ...Object.fromEntries(Array.from({ length: 4_097 }, (_, i) => [`extra${i}`, i])) }
    const cases = [
      accessor, polluted, cyclic, wide,
      Object.create(value), Object.assign(new Date(), value),
      { ...structuredClone(value), [Symbol('hidden')]: true },
      { ...structuredClone(value), extra: new Array(2) },
      { ...structuredClone(value), first: shared, second: shared },
      new Proxy(value, { get(target, key, receiver) { proxyReads += 1; return Reflect.get(target, key, receiver) } }),
      new Proxy(value, { getPrototypeOf() { throw new Error('Untrusted wrapper') } }),
    ]
    for (const candidate of cases) {
      const parsed = parse(candidate)
      assert.equal(parsed.success, false)
      if (parsed.success !== false) continue
      assert.ok(parsed.issues.length <= 16)
      assert.ok(parsed.issues.every((issue) => issue.code.startsWith('wire-')), JSON.stringify(parsed))
      assert.deepEqual(parse(candidate), parsed, 'Wire issue codes, paths and ordering must be deterministic.')
    }
    const nullPrototype = Object.assign(Object.create(null), structuredClone(value))
    assert.equal(parse(nullPrototype).success, true)
  }
  assert.equal(getterCalls, 0)
  assert.equal(proxyReads, 0)
})

test('snapshot project and scene subtrees retain wire boundaries before semantic reads', () => {
  let getterCalls = 0
  for (const target of ['project', 'scene'] as const) {
    const snapshot = createValidWorldSnapshot()
    const document = target === 'project' ? snapshot.project : snapshot.scenes[0]
    Object.defineProperty(document, 'name', { enumerable: true, get() { getterCalls += 1; return 'Unsafe' } })
    const result = validateWorldProjectSnapshot(snapshot)
    assert.equal(result.success, false)
    if (result.success === false) assert.deepEqual(result.issues.map(({ code, path }) => ({ code, path })), [
      { code: 'wire-accessor', path: target === 'project' ? 'snapshot.project' : 'snapshot.scenes[0]' },
    ])
  }
  assert.equal(getterCalls, 0)
})

test('public document and snapshot outputs remain isolated from nested inputs and other parses', () => {
  const input = createValidWorldSnapshot()
  const before = structuredClone(input)
  const project = parseWorldProjectDocument(input.project)
  const scene = parseWorldSceneDocument(input.scenes[0])
  const snapshot = validateWorldProjectSnapshot(input)
  assert.ok(project.success && scene.success && snapshot.success)
  const repeated = validateWorldProjectSnapshot(input)
  assert.ok(repeated.success)
  assert.deepEqual(input, before)
  input.project.resources[0].name = 'Input mutation'
  input.scenes[0].entities[0].transform.position[0] = 99
  assert.equal(project.value.resources[0].name, before.project.resources[0].name)
  assert.equal(scene.value.entities[0].transform.position[0], 0)
  assert.deepEqual(snapshot.value, repeated.value)
  project.value.resources[0].name = 'Project output mutation'
  scene.value.entities[0].transform.position[0] = -1
  snapshot.value.project.resources[0].name = 'Snapshot output mutation'
  snapshot.value.scenes[0].entities[0].transform.scale[0] = 4
  assert.deepEqual(repeated.value, before)
  assert.equal(input.project.resources[0].name, 'Input mutation')
  assert.equal(input.scenes[0].entities[0].transform.position[0], 99)
  assert.equal(input.scenes[0].entities[0].transform.scale[0], 1)
})

test('snapshot semantic issue order and paths match public document parsing', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.project.name = ''
  snapshot.project.revision = -1
  snapshot.scenes[0].name = ''
  snapshot.scenes[0].environment.ambientIntensity = -1
  const project = parseWorldProjectDocument(snapshot.project)
  const scene = parseWorldSceneDocument(snapshot.scenes[0])
  const result = validateWorldProjectSnapshot(snapshot)
  assert.ok(!project.success && !scene.success && !result.success)
  assert.deepEqual(result.issues, [
    ...project.issues,
    ...scene.issues.map((issue) => ({ ...issue, path: `snapshot.scenes[0]${issue.path.slice('scene'.length)}` })),
  ])
})

test('snapshot missing project preserves the public parser wire issue', () => {
  const missingProject = parseWorldProjectDocument(undefined)
  assert.equal(missingProject.success, false)
  if (missingProject.success === false) assert.deepEqual(missingProject.issues, [{
    code: 'wire-shape', path: 'project', message: 'Wire values must contain only JSON-compatible data.',
  }])
  assert.deepEqual(validateWorldProjectSnapshot({ scenes: [] }), missingProject)
})

function addBehavior(snapshot: WorldProjectSnapshotV1, event: WorldBehaviorEvent, actions: WorldBehaviorAction[]): void {
  snapshot.scenes[0].entities[0].components.push({
    id: 'component:test-behavior',
    type: 'behavior',
    enabled: true,
    bindings: [{ id: 'binding:test', event, actions }],
  })
}

function assertBehaviorCapabilityFailure(snapshot: WorldProjectSnapshotV1): void {
  const result = validateWorldProjectSnapshot(snapshot)
  const repeated = validateWorldProjectSnapshot(snapshot)
  assert.equal(result.success, false)
  assert.deepEqual(result, repeated)
  if (result.success === false) assert.ok(result.issues.some((issue) => issue.code === 'behavior-capability'), JSON.stringify(result))
}

test('validates and clones a canonical two-scene snapshot without losing legacy scale values', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.scenes[0].entities[0].transform.scale = [0, -1, 2]
  const validated = validateWorldProjectSnapshot(snapshot)
  assert.equal(validated.success, true, JSON.stringify(validated))
  if (validated.success !== true) return
  assert.deepEqual(validated.value.scenes[0].entities[0].transform.scale, [0, -1, 2])

  const clone = cloneWorldProjectSnapshot(validated.value)
  clone.project.name = 'Changed clone'
  clone.scenes[0].entities[0].transform.position[0] = 99
  assert.equal(validated.value.project.name, 'Demo world')
  assert.equal(validated.value.scenes[0].entities[0].transform.position[0], 0)
})

test('normalizes only canonical workspace-relative paths', () => {
  assert.equal(normalizeWorldWorkspacePath('Assets/hero.glb'), 'Assets/hero.glb')
  assert.equal(normalizeWorldWorkspacePath('Assets/%68ero.glb'), 'Assets/hero.glb')
  assert.equal(normalizeWorldWorkspacePath('Assets/%68%65ro.glb'), 'Assets/hero.glb')
  assert.equal(normalizeWorldWorkspacePath('%41ssets/hero.glb'), 'Assets/hero.glb')
  for (const value of ['', '.', './Assets/a.glb', 'Assets//a.glb', '../a', 'Assets/../a', '/tmp/a', 'C:/a', 'C:Assets/hero.glb', 'file:Assets/hero.glb', 'Assets\\a', 'Assets%2Fhero.glb', 'Assets%252Fhero.glb', 'Assets%5chero.glb', 'Assets/%2e%2e/a', 'Assets/%252e%252e%252fsecret.glb', 'Assets/%25252e%25252e%25252fsecret.glb', 'Assets/%E0%A4%A', `Assets/${'%25'.repeat(1500)}.glb`, 'Assets/a\0b']) {
    assert.equal(normalizeWorldWorkspacePath(value), null, value)
  }
  for (const value of [
    'Assets/model.glb:secret', 'Assets/model?.glb', 'Assets/model*.glb', 'Assets/a<.glb', 'Assets/a>.glb', 'Assets/a".glb', 'Assets/a|.glb',
    'Assets/CON', 'Assets/con.txt', 'Assets/CON .txt', 'Assets/PrN.json', 'Assets/AUX', 'Assets/NUL.glb', 'Assets/COM1', 'Assets/com9.bin', 'Assets/LPT1', 'Assets/lpt9.txt',
    'Assets/COM¹.txt', 'Assets/com².bin', 'Assets/Com³', 'Assets/LPT¹.txt', 'Assets/lpt².json', 'Assets/LpT³',
    'Assets/folder./model.glb', 'Assets/folder /model.glb', 'Assets/model.glb.', 'Assets/model.glb ',
    'Assets/model.glb%3Asecret', 'Assets/%43%4f%4e.txt', 'Assets/model%3F.glb', 'Assets/folder%2E/model.glb', 'Assets/model.glb%20',
    'Assets/COM%C2%B9.txt', 'Assets/com%C2%B2.bin', 'Assets/Com%C2%B3', 'Assets/LPT%C2%B9.txt', 'Assets/lpt%C2%B2.json', 'Assets/LpT%C2%B3',
  ]) assert.equal(normalizeWorldWorkspacePath(value), null, value)
})

test('input bindings canonicalize safe legacy forms and require explicit axis2d target axes', () => {
  const parsed = parseWorldInputActionsDocument([
    { id: 'input:jump', name: 'Jump', valueType: 'button', bindings: [{ device: 'keyboard', control: 'Space' }] },
    { id: 'input:throttle', name: 'Throttle', valueType: 'axis1d', bindings: [{ device: 'gamepad', control: 'left-trigger', scale: -1 }] },
    { id: 'input:move', name: 'Move', valueType: 'axis2d', bindings: [
      { kind: 'axis2d', device: 'keyboard', control: 'KeyA', targetAxis: 'x', scale: -1 },
      { kind: 'axis2d', device: 'keyboard', control: 'KeyW', targetAxis: 'y', scale: 1 },
    ] },
  ])
  assert.equal(parsed.success, true, JSON.stringify(parsed))
  if (parsed.success === true) {
    assert.deepEqual(parsed.value[0].bindings, [{ kind: 'button', device: 'keyboard', control: 'Space' }])
    assert.deepEqual(parsed.value[1].bindings, [{ kind: 'axis1d', device: 'gamepad', control: 'left-trigger', scale: -1 }])
    assert.deepEqual(parsed.value[2].bindings, [
      { kind: 'axis2d', device: 'keyboard', control: 'KeyA', targetAxis: 'x', scale: -1 },
      { kind: 'axis2d', device: 'keyboard', control: 'KeyW', targetAxis: 'y', scale: 1 },
    ])
  }

  const invalidCases = [
    {
      code: 'input-binding-ambiguous',
      actions: [{ id: 'input:move', name: 'Move', valueType: 'axis2d', bindings: [{ device: 'keyboard', control: 'KeyA', scale: -1 }] }],
    },
    {
      code: 'input-binding-kind',
      actions: [{ id: 'input:throttle', name: 'Throttle', valueType: 'axis1d', bindings: [{ kind: 'button', device: 'keyboard', control: 'KeyW' }] }],
    },
    {
      code: 'input-binding-axis',
      actions: [{ id: 'input:move', name: 'Move', valueType: 'axis2d', bindings: [{ kind: 'axis2d', device: 'keyboard', control: 'KeyA' }] }],
    },
    {
      code: 'input-binding-conflict',
      actions: [{ id: 'input:move', name: 'Move', valueType: 'axis2d', bindings: [
        { kind: 'axis2d', device: 'keyboard', control: 'KeyA', targetAxis: 'x', scale: -1 },
        { kind: 'axis2d', device: 'keyboard', control: 'KeyA', targetAxis: 'y', scale: 1 },
      ] }],
    },
  ]
  for (const { code, actions } of invalidCases) {
    const result = parseWorldInputActionsDocument(actions)
    assert.equal(result.success, false, `${code}: ${JSON.stringify(result)}`)
    if (result.success === false) assert.ok(result.issues.some((issue) => issue.code === code), JSON.stringify(result))
  }
})

test('document boundaries reject transparent and throwing wrappers without throwing', () => {
  const project = createValidWorldSnapshot().project
  let reads = 0
  const transparent = new Proxy(project, {
    get(target, property, receiver) {
      reads += 1
      return Reflect.get(target, property, receiver)
    },
  })
  assert.equal(parseWorldProjectDocument(transparent).success, false)
  assert.equal(reads, 0)

  const throwing = new Proxy(project, {
    getPrototypeOf() {
      throw new Error('wrapper trap')
    },
  })
  assert.doesNotThrow(() => parseWorldProjectDocument(throwing))
  assert.equal(parseWorldProjectDocument(throwing).success, false)
})

test('semantic collections and issue output are globally bounded', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.scenes[0].entities[0].tags = Array.from({ length: 1_025 }, (_, index) => `tag:${index}`)
  const started = performance.now()
  const result = validateWorldProjectSnapshot(snapshot)
  const elapsed = performance.now() - started
  assert.equal(result.success, false)
  if (result.success === false) {
    assert.ok(result.issues.length <= 64, String(result.issues.length))
    assert.ok(result.issues.some((issue) => issue.code === 'collection-limit'), JSON.stringify(result))
  }
  assert.ok(elapsed < 2_000, `${elapsed}ms`)
})

test('wire parsers reject inherited fields, accessors, and class instances while accepting null-prototype records', () => {
  const snapshot = createValidWorldSnapshot()
  assert.equal(parseWorldProjectDocument(Object.create(snapshot.project)).success, false)

  let getterCalls = 0
  const accessorProject = structuredClone(snapshot.project)
  Object.defineProperty(accessorProject, 'projectId', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'project:accessor'
    },
  })
  assert.equal(parseWorldProjectDocument(accessorProject).success, false)
  assert.equal(getterCalls, 0)

  class ProjectRecord {}
  assert.equal(parseWorldProjectDocument(Object.assign(new ProjectRecord(), snapshot.project)).success, false)

  const nullPrototypeProject = Object.assign(Object.create(null), structuredClone(snapshot.project))
  assert.equal(parseWorldProjectDocument(nullPrototypeProject).success, true)
})

test('document parsers reject wrong schemas and malformed wire values', () => {
  const snapshot = createValidWorldSnapshot()
  assert.equal(parseWorldProjectDocument({ ...snapshot.project, schema: 'wrong' }).success, false)
  assert.equal(parseWorldProjectDocument({ ...snapshot.project, revision: -1 }).success, false)
  assert.equal(parseWorldSceneDocument({ ...snapshot.scenes[0], projectId: '' }).success, false)
  assert.equal(parseWorldSceneDocument({ ...snapshot.scenes[0], entities: [{ object3D: {} }] }).success, false)
})

test('snapshot validation rejects scene/document mismatches and dangling references', () => {
  const missingScene = createValidWorldSnapshot()
  missingScene.scenes.pop()
  assert.equal(validateWorldProjectSnapshot(missingScene).success, false)

  const wrongProject = createValidWorldSnapshot()
  wrongProject.scenes[0].projectId = 'project:other'
  assert.equal(validateWorldProjectSnapshot(wrongProject).success, false)

  const danglingResource = createValidWorldSnapshot()
  const renderable = danglingResource.scenes[0].entities[0].components[0]
  if (renderable.type === 'renderable') renderable.resourceId = 'resource:missing'
  assert.equal(validateWorldProjectSnapshot(danglingResource).success, false)

  const missingProfile = createValidWorldSnapshot()
  missingProfile.project.activeGraphicsProfileId = 'graphics:missing'
  assert.equal(validateWorldProjectSnapshot(missingProfile).success, false)
})

test('snapshot validation rejects duplicate ids, cycles, and cardinality violations', () => {
  const duplicate = createValidWorldSnapshot()
  duplicate.scenes[0].entities.push(structuredClone(duplicate.scenes[0].entities[0]))
  assert.equal(validateWorldProjectSnapshot(duplicate).success, false)

  const cycle = createValidWorldSnapshot()
  cycle.scenes[0].entities.push({
    id: 'entity:child', name: 'Child', parentId: 'entity:hero', enabled: true, locked: false, tags: [],
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: [],
  })
  cycle.scenes[0].entities[0].parentId = 'entity:child'
  assert.equal(validateWorldProjectSnapshot(cycle).success, false)

  const cardinality = createValidWorldSnapshot()
  cardinality.scenes[0].entities[0].components.push({
    ...structuredClone(cardinality.scenes[0].entities[0].components[0]), id: 'component:second-renderable',
  })
  assert.equal(validateWorldProjectSnapshot(cardinality).success, false)
})

test('snapshot permits at most one enabled primary camera and listener per scene', () => {
  const snapshot = createValidWorldSnapshot()
  for (const suffix of ['a', 'b']) {
    snapshot.scenes[0].entities.push({
      id: `entity:camera-${suffix}`, name: `Camera ${suffix}`, parentId: null, enabled: true, locked: false, tags: [],
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      components: [
        { id: `component:camera-${suffix}`, type: 'camera', enabled: true, projection: 'perspective', primary: true, near: 0.1, far: 100, fieldOfView: 60 },
        { id: `component:listener-${suffix}`, type: 'audio-listener', enabled: true, primary: true },
      ],
    })
  }
  assert.equal(validateWorldProjectSnapshot(snapshot).success, false)
})

test('component and sequence references must target the correct kind and owner', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.scenes[0].entities[0].components.push({
    id: 'component:controller',
    type: 'character-controller',
    enabled: true,
    colliderComponentId: 'component:hero-renderable',
    moveActionId: 'input:jump',
    speed: 4,
    jumpSpeed: 6,
    maxSlopeDegrees: 45,
  })
  const result = validateWorldProjectSnapshot(snapshot)
  assert.equal(result.success, false)
  if (result.success === false) assert.ok(result.issues.some((issue) => issue.code === 'component-kind'))
})

test('enabled controllers and triggers require compatible input and collider capabilities', () => {
  const controller = createValidWorldSnapshot()
  controller.scenes[0].entities[0].components.push(
    { id: 'component:controller-collider', type: 'collider', enabled: true, purpose: 'simulation', shape: 'box', halfExtents: [1, 1, 1], sensor: false, friction: 0, restitution: 0 },
    { id: 'component:controller-body', type: 'rigid-body', enabled: true, bodyType: 'kinematic-position', gravityScale: 1, linearDamping: 0, angularDamping: 0, canSleep: true },
    { id: 'component:controller', type: 'character-controller', enabled: true, colliderComponentId: 'component:controller-collider', moveActionId: 'input:jump', speed: 4, jumpSpeed: 6, maxSlopeDegrees: 45 },
  )
  const wrongAction = validateWorldProjectSnapshot(controller)
  assert.equal(wrongAction.success, false)
  if (wrongAction.success === false) assert.ok(wrongAction.issues.some((issue) => issue.code === 'input-action-kind'), JSON.stringify(wrongAction))

  const invalidControllerCollider = createValidWorldSnapshot()
  invalidControllerCollider.project.inputActions.push({ id: 'input:move', name: 'Move', valueType: 'axis2d', bindings: [] })
  invalidControllerCollider.scenes[0].entities[0].components.push(
    { id: 'component:controller-collider', type: 'collider', enabled: false, purpose: 'editor-navigation', shape: 'rect-surface', halfExtents: [1, 1], sidedness: 'double', sensor: true, friction: 0, restitution: 0 },
    { id: 'component:controller-body', type: 'rigid-body', enabled: true, bodyType: 'kinematic-position', gravityScale: 1, linearDamping: 0, angularDamping: 0, canSleep: true },
    { id: 'component:controller', type: 'character-controller', enabled: true, colliderComponentId: 'component:controller-collider', moveActionId: 'input:move', speed: 4, jumpSpeed: 6, maxSlopeDegrees: 45 },
  )
  const invalidController = validateWorldProjectSnapshot(invalidControllerCollider)
  assert.equal(invalidController.success, false)
  if (invalidController.success === false) assert.ok(invalidController.issues.some((issue) => issue.code === 'controller-capability'), JSON.stringify(invalidController))

  const disabledControllerCollider = structuredClone(invalidControllerCollider)
  const disabledController = disabledControllerCollider.scenes[0].entities[0].components.at(-1)
  if (disabledController?.type === 'character-controller') disabledController.enabled = false
  disabledControllerCollider.scenes[0].entities[0].components = disabledControllerCollider.scenes[0].entities[0].components.filter((component) => component.type !== 'rigid-body')
  assert.equal(validateWorldProjectSnapshot(disabledControllerCollider).success, true)

  const invalidTriggerSnapshot = createValidWorldSnapshot()
  invalidTriggerSnapshot.scenes[0].entities[0].components.push(
    { id: 'component:trigger-collider', type: 'collider', enabled: true, purpose: 'simulation', shape: 'box', halfExtents: [1, 1, 1], sensor: false, friction: 0, restitution: 0 },
    { id: 'component:trigger', type: 'trigger', enabled: true, colliderComponentId: 'component:trigger-collider', once: false, targetTags: [] },
  )
  const invalidTrigger = validateWorldProjectSnapshot(invalidTriggerSnapshot)
  assert.equal(invalidTrigger.success, false)
  if (invalidTrigger.success === false) assert.ok(invalidTrigger.issues.some((issue) => issue.code === 'trigger-capability'), JSON.stringify(invalidTrigger))

  const disabledTriggerSnapshot = structuredClone(invalidTriggerSnapshot)
  const disabledTrigger = disabledTriggerSnapshot.scenes[0].entities[0].components.at(-1)
  if (disabledTrigger?.type === 'trigger') disabledTrigger.enabled = false
  assert.equal(validateWorldProjectSnapshot(disabledTriggerSnapshot).success, true)
})

test('enabled character controllers require an enabled kinematic-position rigid body on the same entity', () => {
  const makeControllerSnapshot = (body: 'missing' | 'disabled' | 'dynamic' | 'kinematic-velocity' | 'kinematic-position') => {
    const snapshot = createValidWorldSnapshot()
    snapshot.project.inputActions.push({ id: 'input:move', name: 'Move', valueType: 'axis2d', bindings: [] })
    snapshot.scenes[0].entities[0].components.push(
      { id: 'component:controller-collider', type: 'collider', enabled: true, purpose: 'simulation', shape: 'capsule', radius: 0.4, halfHeight: 0.8, sensor: false, friction: 0, restitution: 0 },
      { id: 'component:controller', type: 'character-controller', enabled: true, colliderComponentId: 'component:controller-collider', moveActionId: 'input:move', jumpActionId: 'input:jump', speed: 4, jumpSpeed: 6, maxSlopeDegrees: 45 },
    )
    if (body !== 'missing') snapshot.scenes[0].entities[0].components.push({
      id: 'component:controller-body',
      type: 'rigid-body',
      enabled: body !== 'disabled',
      bodyType: body === 'disabled' ? 'kinematic-position' : body,
      gravityScale: 1,
      linearDamping: 0,
      angularDamping: 0,
      canSleep: true,
    })
    return snapshot
  }

  assert.equal(validateWorldProjectSnapshot(makeControllerSnapshot('kinematic-position')).success, true)
  for (const body of ['missing', 'disabled', 'dynamic', 'kinematic-velocity'] as const) {
    const result = validateWorldProjectSnapshot(makeControllerSnapshot(body))
    assert.equal(result.success, false, `${body}: ${JSON.stringify(result)}`)
    if (result.success === false) {
      assert.ok(result.issues.some((issue) => issue.code === 'controller-capability' && issue.path.endsWith('.enabled')), JSON.stringify(result))
    }
  }

  const disabledController = makeControllerSnapshot('missing')
  const controller = disabledController.scenes[0].entities[0].components.find((component) => component.type === 'character-controller')
  if (controller?.type === 'character-controller') controller.enabled = false
  assert.equal(validateWorldProjectSnapshot(disabledController).success, true)
})

test('sequence keyframes use exact bounded rational time and event interpolation domains', () => {
  const makeEventSequence = (time: { numerator: number; denominator: number }, interpolation?: 'step' | 'linear' | 'cubic') => ({
    id: 'sequence:event',
    name: 'Event',
    duration: { numerator: 1, denominator: 3 },
    tracks: [{ id: 'track:event', type: 'event', keyframes: [{ id: 'key:event', time, ...(interpolation ? { interpolation } : {}), eventId: 'event:one' }] }],
  })

  const boundary = createValidWorldSnapshot()
  boundary.scenes[0].sequences.push(makeEventSequence({ numerator: 2, denominator: 6 }, 'step') as WorldSequence)
  assert.equal(validateWorldProjectSnapshot(boundary).success, true)

  const outside = createValidWorldSnapshot()
  outside.scenes[0].sequences.push(makeEventSequence({ numerator: 1, denominator: 2 }, 'step') as WorldSequence)
  const outsideResult = validateWorldProjectSnapshot(outside)
  assert.equal(outsideResult.success, false)
  if (outsideResult.success === false) assert.ok(outsideResult.issues.some((issue) => issue.code === 'keyframe-time'), JSON.stringify(outsideResult))

  const interpolated = createValidWorldSnapshot()
  interpolated.scenes[0].sequences.push(makeEventSequence({ numerator: 0, denominator: 1 }, 'linear') as unknown as WorldSequence)
  const interpolatedResult = validateWorldProjectSnapshot(interpolated)
  assert.equal(interpolatedResult.success, false)
  if (interpolatedResult.success === false) assert.ok(interpolatedResult.issues.some((issue) => issue.code === 'event-interpolation'), JSON.stringify(interpolatedResult))

  const exactLarge = createValidWorldSnapshot()
  exactLarge.scenes[0].sequences.push({
    id: 'sequence:large', name: 'Large exact', duration: { numerator: Number.MAX_SAFE_INTEGER, denominator: Number.MAX_SAFE_INTEGER },
    tracks: [{ id: 'track:large', type: 'event', keyframes: [{ id: 'key:large', time: { numerator: Number.MAX_SAFE_INTEGER - 1, denominator: Number.MAX_SAFE_INTEGER - 1 }, interpolation: 'step', eventId: 'event:large' }] }],
  } as WorldSequence)
  assert.equal(validateWorldProjectSnapshot(exactLarge).success, true)

  const unsafe = createValidWorldSnapshot()
  unsafe.scenes[0].sequences.push(makeEventSequence({ numerator: Number.MAX_SAFE_INTEGER + 1, denominator: 1 }) as unknown as WorldSequence)
  assert.equal(validateWorldProjectSnapshot(unsafe).success, false)
})

test('cubic interpolation is smoothstep-only for numeric and vector tracks without authored tangents', () => {
  assert.equal(WORLD_CUBIC_INTERPOLATION_SEMANTICS, 'smoothstep-adjacent-strictly-time-ordered-numeric-or-vector-values-no-authored-tangents')
  const continuous = parseWorldSequenceDocument({
    id: 'sequence:continuous',
    name: 'Continuous',
    duration: { numerator: 1, denominator: 1 },
    tracks: [
      { id: 'track:transform', type: 'transform', entityId: 'entity:hero', keyframes: [{ id: 'key:transform', time: { numerator: 0, denominator: 1 }, interpolation: 'cubic', value: { position: [0, 1, 2] } }] },
      { id: 'track:light', type: 'light', entityId: 'entity:light', componentId: 'component:light', property: 'intensity', keyframes: [
        { id: 'key:light:start', time: { numerator: 0, denominator: 1 }, interpolation: 'cubic', value: 2 },
        { id: 'key:light:end', time: { numerator: 1, denominator: 1 }, interpolation: 'cubic', value: 4 },
      ] },
      { id: 'track:property', type: 'property', entityId: 'entity:hero', componentId: 'component:hero-renderable', property: 'material.opacity', keyframes: [{ id: 'key:property', time: { numerator: 0, denominator: 1 }, interpolation: 'cubic', value: 0.5 }] },
    ],
  })
  assert.equal(continuous.success, true, JSON.stringify(continuous))

  for (const track of [
    { id: 'track:camera', type: 'camera', entityId: 'entity:camera', keyframes: [{ id: 'key:camera', time: { numerator: 0, denominator: 1 }, interpolation: 'cubic', value: true }] },
    { id: 'track:audio', type: 'audio', entityId: 'entity:hero', componentId: 'component:audio', keyframes: [{ id: 'key:audio', time: { numerator: 0, denominator: 1 }, interpolation: 'linear', value: true }] },
    { id: 'track:property', type: 'property', entityId: 'entity:hero', componentId: 'component:hero-renderable', property: 'material.baseColor', keyframes: [{ id: 'key:color', time: { numerator: 0, denominator: 1 }, interpolation: 'cubic', value: '#ffffff' }] },
  ]) {
    const result = parseWorldSequenceDocument({ id: 'sequence:discrete', name: 'Discrete', duration: { numerator: 1, denominator: 1 }, tracks: [track] })
    assert.equal(result.success, false, JSON.stringify(result))
    if (result.success === false) assert.ok(result.issues.some((issue) => issue.code === 'discrete-interpolation'), JSON.stringify(result))
  }

  const tangent = parseWorldSequenceDocument({
    id: 'sequence:tangent', name: 'Tangent', duration: { numerator: 1, denominator: 1 },
    tracks: [{ id: 'track:tangent', type: 'light', entityId: 'entity:light', componentId: 'component:light', property: 'intensity', keyframes: [{ id: 'key:tangent', time: { numerator: 0, denominator: 1 }, interpolation: 'cubic', value: 1, tangentIn: 0 }] }],
  })
  assert.equal(tangent.success, false)
  if (tangent.success === false) assert.ok(tangent.issues.some((issue) => issue.code === 'unknown-property' && issue.path.endsWith('.tangentIn')), JSON.stringify(tangent))

  for (const [label, keyframes] of [
    ['out-of-order', [
      { id: 'key:late', time: { numerator: 1, denominator: 1 }, interpolation: 'cubic', value: 2 },
      { id: 'key:early', time: { numerator: 0, denominator: 1 }, interpolation: 'cubic', value: 1 },
    ]],
    ['duplicate-time', [
      { id: 'key:first', time: { numerator: 0, denominator: 1 }, interpolation: 'cubic', value: 1 },
      { id: 'key:second', time: { numerator: 0, denominator: 2 }, interpolation: 'cubic', value: 2 },
    ]],
  ] as const) {
    const result = parseWorldSequenceDocument({
      id: `sequence:${label}`,
      name: label,
      duration: { numerator: 1, denominator: 1 },
      tracks: [{ id: `track:${label}`, type: 'light', entityId: 'entity:light', componentId: 'component:light', property: 'intensity', keyframes }],
    })
    assert.equal(result.success, false, `${label}: ${JSON.stringify(result)}`)
    if (result.success === false) assert.ok(result.issues.some((issue) => issue.code === 'keyframe-order' && issue.path.endsWith('.keyframes[1].time')), JSON.stringify(result))
  }
})

test('sequence-event behaviors resolve a concrete event keyframe in the same scene', () => {
  const makeSnapshot = () => {
    const snapshot = createValidWorldSnapshot()
    snapshot.scenes[0].sequences.push({
      id: 'sequence:door', name: 'Door', duration: { numerator: 1, denominator: 1 },
      tracks: [{ id: 'track:door-events', type: 'event', keyframes: [{ id: 'key:door-open', time: { numerator: 1, denominator: 2 }, interpolation: 'step', eventId: 'event:door-open' }] }],
    })
    return snapshot
  }

  const valid = makeSnapshot()
  addBehavior(valid, { type: 'sequence-event', sequenceId: 'sequence:door', eventId: 'event:door-open' }, [])
  assert.equal(validateWorldProjectSnapshot(valid).success, true)

  const missingSequence = makeSnapshot()
  addBehavior(missingSequence, { type: 'sequence-event', sequenceId: 'sequence:missing', eventId: 'event:door-open' }, [])
  const missingSequenceResult = validateWorldProjectSnapshot(missingSequence)
  assert.equal(missingSequenceResult.success, false)
  if (missingSequenceResult.success === false) assert.ok(missingSequenceResult.issues.some((issue) => issue.code === 'sequence-reference'), JSON.stringify(missingSequenceResult))

  const missingEvent = makeSnapshot()
  addBehavior(missingEvent, { type: 'sequence-event', sequenceId: 'sequence:door', eventId: 'event:missing' }, [])
  const missingEventResult = validateWorldProjectSnapshot(missingEvent)
  assert.equal(missingEventResult.success, false)
  if (missingEventResult.success === false) assert.ok(missingEventResult.issues.some((issue) => issue.code === 'sequence-event-reference' && issue.path.endsWith('.event.eventId')), JSON.stringify(missingEventResult))
})

test('sequence property keyframes use the target component writable-value domain', () => {
  const negativeLight = createValidWorldSnapshot()
  negativeLight.scenes[0].entities.push({
    id: 'entity:sequence-light', name: 'Sequence light', parentId: null, enabled: true, locked: false, tags: [],
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [{ id: 'component:sequence-light', type: 'light', enabled: true, lightKind: 'directional', color: '#ffffff', intensity: 1, castShadow: true }],
  })
  negativeLight.scenes[0].sequences.push({
    id: 'sequence:negative-light', name: 'Negative light', duration: { numerator: 1, denominator: 1 },
    tracks: [{ id: 'track:negative-light', type: 'light', entityId: 'entity:sequence-light', componentId: 'component:sequence-light', property: 'intensity', keyframes: [{ id: 'key:negative-light', time: { numerator: 0, denominator: 1 }, value: -1 }] }],
  })
  const negativeResult = validateWorldProjectSnapshot(negativeLight)
  assert.equal(negativeResult.success, false)
  if (negativeResult.success === false) assert.ok(negativeResult.issues.some((issue) => issue.code === 'track-property'))

  const opacity = createValidWorldSnapshot()
  const propertySequence = {
    id: 'sequence:opacity', name: 'Opacity', duration: { numerator: 1, denominator: 1 },
    tracks: [{ id: 'track:opacity', type: 'property' as const, entityId: 'entity:hero', componentId: 'component:hero-renderable', property: 'material.opacity', keyframes: [{ id: 'key:opacity', time: { numerator: 0, denominator: 1 }, value: 2 }] }],
  }
  opacity.scenes[0].sequences.push(propertySequence as unknown as WorldSequence)
  const opacityResult = validateWorldProjectSnapshot(opacity)
  assert.equal(opacityResult.success, false)
  if (opacityResult.success === false) assert.ok(opacityResult.issues.some((issue) => issue.code === 'track-property'))

  propertySequence.tracks[0].keyframes[0].value = 0.5
  assert.equal(validateWorldProjectSnapshot(opacity).success, true)
})

test('apply-impulse behavior requires an enabled dynamic rigid body on an enabled target entity', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.scenes[0].entities.push({
    id: 'entity:physics-target',
    name: 'Physics target',
    parentId: null,
    enabled: true,
    locked: false,
    tags: [],
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [{ id: 'component:fixed-body', type: 'rigid-body', enabled: true, bodyType: 'fixed', gravityScale: 1, linearDamping: 0, angularDamping: 0, canSleep: true }],
  })
  snapshot.scenes[0].entities[0].components.push({
    id: 'component:impulse-behavior',
    type: 'behavior',
    enabled: true,
    bindings: [{ id: 'binding:impulse', event: { type: 'start' }, actions: [{ type: 'apply-impulse', entityId: 'entity:physics-target', impulse: [1, 0, 0] }] }],
  })
  const result = validateWorldProjectSnapshot(snapshot)
  assert.equal(result.success, false)
  if (result.success === false) assert.ok(result.issues.some((issue) => issue.code === 'behavior-capability'))
})

test('behavior events and actions validate concrete target capabilities consistently', () => {
  const visibility = createValidWorldSnapshot()
  visibility.scenes[0].entities.push({
    id: 'entity:empty', name: 'Empty', parentId: null, enabled: true, locked: false, tags: [],
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: [],
  })
  addBehavior(visibility, { type: 'start' }, [{ type: 'set-visibility', entityId: 'entity:empty', visible: false }])
  assertBehaviorCapabilityFailure(visibility)

  const camera = createValidWorldSnapshot()
  camera.scenes[0].entities.push({
    id: 'entity:camera', name: 'Camera', parentId: null, enabled: true, locked: false, tags: [],
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [{ id: 'component:camera', type: 'camera', enabled: true, projection: 'orthographic', primary: false, near: 0.1, far: 100, orthographicSize: 5 }],
  })
  addBehavior(camera, { type: 'start' }, [{ type: 'set-component-property', entityId: 'entity:camera', componentId: 'component:camera', componentType: 'camera', property: 'fieldOfView', value: 60 }])
  assertBehaviorCapabilityFailure(camera)

  const light = createValidWorldSnapshot()
  light.scenes[0].entities.push({
    id: 'entity:light', name: 'Light', parentId: null, enabled: true, locked: false, tags: [],
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [{ id: 'component:light', type: 'light', enabled: true, lightKind: 'directional', color: '#ffffff', intensity: 1, castShadow: true }],
  })
  addBehavior(light, { type: 'start' }, [{ type: 'set-component-property', entityId: 'entity:light', componentId: 'component:light', componentType: 'light', property: 'range', value: 10 }])
  assertBehaviorCapabilityFailure(light)

  const playback = createValidWorldSnapshot()
  playback.project.resources.push({ id: 'resource:animation', type: 'animation', name: 'Animation', workspacePath: 'Animations/test.pose.json', format: 'pose-clip', sourceWorkspacePath: 'Assets/hero.glb' })
  playback.scenes[0].entities[0].components.push({ id: 'component:animation', type: 'animation-player', enabled: false, resourceId: 'resource:animation', autoplay: false, loop: true, speed: 1 })
  addBehavior(playback, { type: 'start' }, [{ type: 'play-animation', entityId: 'entity:hero', componentId: 'component:animation' }])
  assertBehaviorCapabilityFailure(playback)

  const audio = createValidWorldSnapshot()
  audio.project.resources.push({ id: 'resource:audio', type: 'audio', name: 'Audio', workspacePath: 'Audio/test.wav', format: 'wav' })
  audio.scenes[0].entities[0].components.push({ id: 'component:audio', type: 'audio-source', enabled: false, resourceId: 'resource:audio', autoplay: false, loop: false, volume: 1, spatial: false, maxDistance: 10 })
  addBehavior(audio, { type: 'start' }, [{ type: 'play-audio', entityId: 'entity:hero', componentId: 'component:audio' }])
  assertBehaviorCapabilityFailure(audio)

  const trigger = createValidWorldSnapshot()
  trigger.scenes[0].entities.push({
    id: 'entity:trigger', name: 'Trigger', parentId: null, enabled: true, locked: false, tags: [],
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [
      { id: 'component:trigger-collider', type: 'collider', enabled: true, purpose: 'simulation', shape: 'box', halfExtents: [1, 1, 1], sensor: false, friction: 0, restitution: 0 },
      { id: 'component:trigger', type: 'trigger', enabled: true, colliderComponentId: 'component:trigger-collider', once: false, targetTags: [] },
    ],
  })
  addBehavior(trigger, { type: 'trigger-enter', triggerComponentId: 'component:trigger' }, [])
  assertBehaviorCapabilityFailure(trigger)

  const dynamic = createValidWorldSnapshot()
  dynamic.scenes[0].entities.push({
    id: 'entity:dynamic', name: 'Dynamic', parentId: null, enabled: true, locked: false, tags: [],
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [{ id: 'component:dynamic-body', type: 'rigid-body', enabled: true, bodyType: 'dynamic', gravityScale: 1, linearDamping: 0, angularDamping: 0, canSleep: true }],
  })
  addBehavior(dynamic, { type: 'start' }, [{ type: 'apply-impulse', entityId: 'entity:dynamic', impulse: [1, 0, 0] }])
  assert.equal(validateWorldProjectSnapshot(dynamic).success, true)

  const sceneChange = createValidWorldSnapshot()
  addBehavior(sceneChange, { type: 'start' }, [{ type: 'change-scene', sceneId: 'scene:missing' }])
  const sceneChangeResult = validateWorldProjectSnapshot(sceneChange)
  assert.equal(sceneChangeResult.success, false)
  if (sceneChangeResult.success === false) assert.ok(sceneChangeResult.issues.some((issue) => issue.code === 'scene-reference'))
})

test('behavior binding IDs participate in the project-global identifier namespace', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.scenes[0].entities[0].components.push({
    id: 'component:binding-collision', type: 'behavior', enabled: true,
    bindings: [{ id: 'binding:shared', event: { type: 'start' }, actions: [] }],
  })
  snapshot.scenes[0].sequences.push({
    id: 'sequence:binding-collision', name: 'Binding collision', duration: { numerator: 1, denominator: 1 }, tracks: [{
      id: 'track:binding-collision', type: 'event', keyframes: [{
        id: 'binding:shared', time: { numerator: 0, denominator: 1 }, interpolation: 'step', eventId: 'event:binding-collision',
      }],
    }],
  })

  const result = validateWorldProjectSnapshot(snapshot)
  assert.equal(result.success, false, JSON.stringify(result))
  if (!result.success) {
    assert.ok(result.issues.some((issue) => issue.code === 'duplicate-id' && issue.path.endsWith('.keyframes[0].id')), JSON.stringify(result))
  }
})

import { parseWorldResourceDocument } from './worldDocuments.ts'

const indexedGltfResource = { id: 'resource:indexed', type: 'animation', name: 'Indexed', workspacePath: 'Assets/hero.glb', format: 'gltf-clip' } as const

test('canonical glTF exact indices retain zero and safe source order through parsing and snapshot wire round trips', () => {
  for (const clipIndex of [0, 1, Number.MAX_SAFE_INTEGER]) {
    const resource = { ...indexedGltfResource, clipIndex }
    const parsed = parseWorldResourceDocument(resource)
    assert.ok(parsed.success, JSON.stringify(parsed))
    assert.deepEqual(parsed.value, resource)
    const snapshot = createValidWorldSnapshot()
    snapshot.project.resources.push(resource)
    const reopened = validateWorldProjectSnapshot(JSON.parse(JSON.stringify(cloneWorldProjectSnapshot(snapshot))))
    assert.ok(reopened.success, JSON.stringify(reopened))
    assert.deepEqual(reopened.value.project.resources.at(-1), resource)
  }
  assert.deepEqual(parseWorldResourceDocument(indexedGltfResource), { success: true, value: indexedGltfResource })
})

test('canonical exact-index admission remains gltf-only and rejects malformed indices without weakening other gates', () => {
  for (const clipIndex of [null, '0', true, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parseWorldResourceDocument({ ...indexedGltfResource, clipIndex }).success, false, String(clipIndex))
  }
  for (const resource of [
    { ...indexedGltfResource, format: 'pose-clip' },
    { ...indexedGltfResource, type: 'model', format: 'glb' },
    { ...indexedGltfResource, type: 'audio', format: 'wav' },
    { ...indexedGltfResource, type: 'environment', format: 'hdr' },
  ]) assert.equal(parseWorldResourceDocument({ ...resource, clipIndex: 0 }).success, false)
  for (const extra of [{ metadata: {} }, { clipName: ' ' }, { clipName: 'x\u0000' }, { clipName: 'x'.repeat(513) }, { durationSeconds: 0 }, { durationSeconds: -1 }]) {
    assert.equal(parseWorldResourceDocument({ ...indexedGltfResource, clipIndex: 0, ...extra }).success, false)
  }
  // Follow the existing canonical optional-wire convention, not the separate host convention.
  const omitted = parseWorldResourceDocument({ ...indexedGltfResource, clipName: undefined })
  const undefinedIndex = parseWorldResourceDocument({ ...indexedGltfResource, clipIndex: undefined })
  for (const [parsed, field] of [[omitted, 'clipName'], [undefinedIndex, 'clipIndex']] as const) {
    assert.equal(parsed.success, false)
    if (parsed.success !== false) continue
    assert.deepEqual(parsed.issues.map(({ code, path }) => ({ code, path })), [
      { code: 'wire-shape', path: `resource.${field}` },
    ])
  }
})

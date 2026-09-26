// Fixture guards only. Importing the native runner must never launch it.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter, getEventListeners } from 'node:events'
import test, { after } from 'node:test'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertCapturedTranslation, assertNativeNumericCommit, assertUiAuthoredScene, assertBothScenesReopened, CAPTURED_TRANSFORM_TOLERANCE, waitForOwnedWindowFocus, assertNativeClickPointStable, isNativeNumericCommitSettled, assertInspector, isNativeHandleHover, assertReopenedAuthoringVisual } from './driver.ts'
import { captureOwnedDisplayResources, waitForDisplayResourcesAbsent } from './display-resources.mjs'
import { parseRunArguments, inheritedDisplayEnvironment, validateRunnerLocalAiConfig, validateRunnerRepositoryAdmission } from './run.mjs'
import { BufferGeometry, BoxGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Vector3 } from 'three'
import { withPickerScratch } from './picker-scratch.ts'
import { createSourceCustody } from '../worlds-authoring-electron-fixture.mjs'
import { materializeLocalAiConfig, parseBuildArguments } from '../worlds-authoring-electron-fixture.mjs'
import * as aiPolicies from './shared.ts'
import { createServer, request as ownedHttpRequest } from 'node:http'
import { parseWorldAiQueryRequest, WorldAiContractError, WORLD_AI_QUERY_BYTES, WORLD_AI_PAGE_BYTES } from '../../src/areas/worlds/core/worldAiContract.ts'

const canonicalRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const canonicalLocalAiConfig = materializeLocalAiConfig(canonicalRoot)
const externalEvidenceRoot = process.env.WORLD_AUTHORING_GUARD_TEST_ROOT
const ownsEvidenceRoot = externalEvidenceRoot === undefined
const posixOwnership = process.platform !== 'win32' && typeof process.getuid === 'function'
const evidenceRoot = externalEvidenceRoot ?? await mkdtemp(path.join(await realpath(tmpdir()), 'modly-worlds-authoring-remediation-'))
try {
  if (!ownsEvidenceRoot) assert.ok(evidenceRoot.startsWith('/tmp/modly-worlds-authoring-remediation-'))
  assert.equal(await realpath(evidenceRoot), evidenceRoot)
  const evidenceRootInfo = await lstat(evidenceRoot)
  assert.equal(evidenceRootInfo.isDirectory(), true)
  if (posixOwnership) {
    assert.equal(evidenceRootInfo.mode & 0o777, 0o700)
    assert.equal(evidenceRootInfo.uid, process.getuid())
  }
} catch (error) {
  if (ownsEvidenceRoot) await rm(evidenceRoot, { recursive: true, force: true })
  throw error
}
// Register hooks and tests in one synchronous turn, after asynchronous root validation has settled.
if (ownsEvidenceRoot) after(() => rm(evidenceRoot, { recursive: true, force: true }))
const before = { position: [-1.25, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }
const preview = { ...structuredClone(before), position: [-1.25, 0.625, 0] }

test('N1 admits only separately reviewed inherited-display mode without native flags', () => {
  const reviewed = `--reviewed-build-sha256=${'a'.repeat(64)}`
  assert.deepEqual(parseRunArguments([reviewed]), { buildSha256: 'a'.repeat(64), mode: 'owned-xvfb' })
  assert.deepEqual(parseRunArguments([reviewed, '--inherited-display']), { buildSha256: 'a'.repeat(64), mode: 'inherited-display' })
  for (const args of [[], [reviewed, '--no-sandbox'], [reviewed, '--inherited-display', '--inherited-display'], ['--inherited-display', reviewed]]) assert.throws(() => parseRunArguments(args))
})

test('N2 preserves every inherited environment field and never creates display authentication', () => {
  const environment = { DISPLAY: ':1', XAUTHORITY: '/host/current/Xauthority', HOME: '/host/home', PATH: '/host/path', WAYLAND_DISPLAY: 'wayland-0', CUSTOM_HOST_SENTINEL: 'untouched' }
  const result = inheritedDisplayEnvironment(environment, '/tmp/fixture/run-a', 'a'.repeat(64))
  for (const [name, value] of Object.entries(environment)) assert.equal(result[name], value)
  assert.equal(result.WORLD_AUTHORING_RUN_DIRECTORY, '/tmp/fixture/run-a')
  assert.equal(result.WORLD_AUTHORING_BUILD_SHA256, 'a'.repeat(64))
  assert.deepEqual(environment, { DISPLAY: ':1', XAUTHORITY: '/host/current/Xauthority', HOME: '/host/home', PATH: '/host/path', WAYLAND_DISPLAY: 'wayland-0', CUSTOM_HOST_SENTINEL: 'untouched' })
  assert.throws(() => inheritedDisplayEnvironment({}, '/tmp/fixture/run-a', 'a'.repeat(64)), /DISPLAY/)
  assert.throws(() => inheritedDisplayEnvironment({ DISPLAY: ':1', WORLD_AUTHORING_RUN_DIRECTORY: '/other' }, '/tmp/fixture/run-a', 'a'.repeat(64)), /reserved/)
})

test('WSNAV1 WorldSculpt navigation requires inherited display and excludes local AI', () => {
  const sha = '9b299c9ae4f7ded566a7006a9e5b2fc046eeccbcf28ad8df4163580248db2725'
  const source = '/tmp/reviewed-worldsculpt/scene.glb'
  const buildArgs = [
    '--build-only',
    '--inherited-display',
    '--worldsculpt-navigation',
    `--worldsculpt-source=${source}`,
    `--worldsculpt-sha256=${sha}`,
  ]
  assert.deepEqual(parseBuildArguments(buildArgs), {
    buildOnly: true,
    nativeMode: 'inherited-display',
    runtimeMode: 'worldsculpt-navigation',
    worldSculptSource: { path: source, sha256: sha },
  })
  const reviewed = `--reviewed-build-sha256=${'a'.repeat(64)}`
  assert.deepEqual(parseRunArguments([reviewed, '--inherited-display', '--worldsculpt-navigation']), {
    buildSha256: 'a'.repeat(64),
    mode: 'inherited-display',
    runtimeMode: 'worldsculpt-navigation',
  })
  for (const invalid of [
    buildArgs.filter((value) => value !== '--inherited-display'),
    buildArgs.filter((value) => !value.startsWith('--worldsculpt-source=')),
    buildArgs.filter((value) => !value.startsWith('--worldsculpt-sha256=')),
    [...buildArgs, '--local-ai'],
    [...buildArgs, '--ai-model=model'],
    [...buildArgs.slice(0, -1), '--worldsculpt-sha256=ABC'],
  ]) assert.throws(() => parseBuildArguments(invalid))
  assert.throws(() => parseRunArguments([reviewed, '--worldsculpt-navigation']))
  assert.throws(() => parseRunArguments([reviewed, '--inherited-display', '--worldsculpt-navigation', '--local-ai']))

  assert.equal(typeof aiPolicies.createWorldSculptPointerLockPermissionPolicy, 'function')
  const owner = Object.freeze({ id: 'owned-current-web-contents' })
  const staleOwner = Object.freeze({ id: 'stale-web-contents' })
  let currentOwner = owner
  const denied = []
  const permissionPolicy = aiPolicies.createWorldSculptPointerLockPermissionPolicy({
    runtimeMode: 'worldsculpt-navigation',
    expectedOrigin: 'http://127.0.0.1:43123',
    expectedDocumentUrl: 'http://127.0.0.1:43123/index.html',
    getOwnedWebContents: () => currentOwner,
    onDeniedRequest: (permission) => denied.push(permission),
  })
  const requestDetails = { requestingUrl: 'http://127.0.0.1:43123/index.html', isMainFrame: true }
  const checkDetails = { ...requestDetails }
  const decisions = []
  permissionPolicy.request(owner, 'pointerLock', (granted) => decisions.push(granted), requestDetails)
  assert.deepEqual(decisions, [true]); assert.deepEqual(denied, [])
  assert.equal(permissionPolicy.check(owner, 'pointerLock', 'http://127.0.0.1:43123', checkDetails), true)

  for (const [label, webContents, permission, requestingOrigin, details] of [
    ['wrong owner', staleOwner, 'pointerLock', 'http://127.0.0.1:43123', requestDetails],
    ['wrong permission', owner, 'geolocation', 'http://127.0.0.1:43123', requestDetails],
    ['wrong origin', owner, 'pointerLock', 'http://127.0.0.1:43124', { ...requestDetails, requestingUrl: 'http://127.0.0.1:43124/index.html' }],
    ['wrong document', owner, 'pointerLock', 'http://127.0.0.1:43123', { ...requestDetails, requestingUrl: 'http://127.0.0.1:43123/other.html' }],
    ['subframe', owner, 'pointerLock', 'http://127.0.0.1:43123', { ...requestDetails, isMainFrame: false }],
  ]) {
    const requestDecision = []
    permissionPolicy.request(webContents, permission, (granted) => requestDecision.push(granted), details)
    assert.deepEqual(requestDecision, [false], label)
    assert.equal(denied.at(-1), permission, `${label} must retain fatal request denial`)
    assert.equal(permissionPolicy.check(webContents, permission, requestingOrigin, details), false, label)
  }
  currentOwner = staleOwner
  const staleDecision = []
  permissionPolicy.request(owner, 'pointerLock', (granted) => staleDecision.push(granted), requestDetails)
  assert.deepEqual(staleDecision, [false], 'Replaced renderer must lose pointer-lock authority')
  assert.equal(permissionPolicy.check(owner, 'pointerLock', 'http://127.0.0.1:43123', checkDetails), false)

  const otherMode = aiPolicies.createWorldSculptPointerLockPermissionPolicy({
    runtimeMode: 'authoring', expectedOrigin: 'http://127.0.0.1:43123', expectedDocumentUrl: requestDetails.requestingUrl,
    getOwnedWebContents: () => owner, onDeniedRequest: (permission) => denied.push(`other:${permission}`),
  })
  assert.equal(otherMode.check(owner, 'pointerLock', 'http://127.0.0.1:43123', checkDetails), false)
  const otherModeDecision = []
  otherMode.request(owner, 'pointerLock', (granted) => otherModeDecision.push(granted), requestDetails)
  assert.deepEqual(otherModeDecision, [false]); assert.equal(denied.at(-1), 'other:pointerLock')
})

test('WSNAV2 WorldSculpt build input admission rejects aliases nonregular files and invalid GLB bytes', async () => {
  const fixture = await import('../worlds-authoring-electron-fixture.mjs')
  assert.equal(typeof fixture.readWorldSculptBuildInput, 'function')
  const directory = await mkdtemp(path.join(evidenceRoot, 'worldsculpt-input-'))
  const source = path.join(directory, 'scene.glb')
  const bytes = Buffer.alloc(12)
  bytes.write('glTF', 0, 'ascii'); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8)
  await writeFile(source, bytes, { mode: 0o600 })
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const admitted = await fixture.readWorldSculptBuildInput(source, sha256)
  assert.deepEqual(admitted.bytes, bytes)
  assert.deepEqual(Object.keys(admitted.sourceIdentity).sort(), ['bytes', 'device', 'inode', 'mode', 'sha256', 'uid'].sort())
  assert.equal(admitted.sourceIdentity.bytes, bytes.length)
  assert.equal(admitted.sourceIdentity.sha256, sha256)
  assert.equal(Object.values(admitted.sourceIdentity).includes(source), false, 'Runtime-safe identity must not retain the user path')

  await assert.rejects(fixture.readWorldSculptBuildInput(source, '0'.repeat(64)), /digest/i)
  const malformed = path.join(directory, 'malformed.glb')
  await writeFile(malformed, Buffer.from('not a GLB'))
  await assert.rejects(fixture.readWorldSculptBuildInput(malformed, createHash('sha256').update(Buffer.from('not a GLB')).digest('hex')), /GLB/i)
  const alias = path.join(directory, 'alias.glb')
  await symlink(source, alias)
  await assert.rejects(fixture.readWorldSculptBuildInput(alias, sha256), /regular|alias|canonical/i)
  await assert.rejects(fixture.readWorldSculptBuildInput(directory, sha256), /regular/i)
  const nested = path.join(directory, 'nested'); await mkdir(nested)
  await assert.rejects(fixture.readWorldSculptBuildInput(`${nested}/../scene.glb`, sha256), /canonical/i)
})

test('WSNAV3 WorldSculpt runtime contract exposes only one hash-bound private path', async () => {
  const runner = await import('./run.mjs')
  assert.equal(typeof runner.validateRunnerWorldSculptInput, 'function')
  assert.equal(typeof aiPolicies.parseWorldSculptInputContract, 'function')
  const sha256 = '9b299c9ae4f7ded566a7006a9e5b2fc046eeccbcf28ad8df4163580248db2725'
  const input = {
    schema: 'modly.worlds-authoring-worldsculpt-input.v1',
    sourceIdentity: { bytes: 117940, sha256, device: '1', inode: '2', uid: 1000, mode: 0o664 },
    bundled: { relativePath: 'inputs/worldsculpt-scene.glb', bytes: 117940, sha256 },
    workspaceRelativePath: 'Workflows/worldsculpt-5a9cc08eaf924e988e527f75137ea8c4/scene.glb',
  }
  assert.deepEqual(aiPolicies.parseWorldSculptInputContract(structuredClone(input)), input)
  const build = { runtimeMode: 'worldsculpt-navigation', worldSculptInput: structuredClone(input), outputs: { [input.bundled.relativePath]: { bytes: 117940, sha256 } } }
  assert.deepEqual(runner.validateRunnerWorldSculptInput(build, 'worldsculpt-navigation'), input)
  assert.equal(JSON.stringify(input).includes('/home/'), false, 'Electron contract must not receive the original user path')

  for (const mutate of [
    (value) => { value.sourcePath = '/home/user/original.glb' },
    (value) => { value.workspaceRelativePath = 'Workflows/other/scene.glb' },
    (value) => { value.bundled.relativePath = 'inputs/other.glb' },
    (value) => { value.bundled.sha256 = '0'.repeat(64) },
    (value) => { value.sourceIdentity.bytes += 1 },
  ]) {
    const invalid = structuredClone(input); mutate(invalid)
    assert.throws(() => aiPolicies.parseWorldSculptInputContract(invalid))
  }
  assert.throws(() => runner.validateRunnerWorldSculptInput({ runtimeMode: 'worldsculpt-navigation', outputs: {} }, 'worldsculpt-navigation'))
  assert.throws(() => runner.validateRunnerWorldSculptInput(build, 'authoring'))
  assert.throws(() => runner.validateRunnerWorldSculptInput({ runtimeMode: 'authoring', outputs: {}, worldSculptInput: input }, 'authoring'))
})

test('WSNAV4 native navigation terminal rejects untrusted input pointer lock GPU and cleanup failures', async () => {
  const runner = await import('./run.mjs')
  assert.equal(typeof runner.assertActualWorldSculptNavigationTerminal, 'function')
  const checks = ['native-worldsculpt-library-add', 'native-inspect-orbit', 'native-fly-pointer-lock', 'native-run-ground-only', 'native-navigation-document-isolation']
    .map((name) => ({ name, status: 'PASS' }))
  const navigation = {
    schema: 'modly.worldsculpt-navigation-acceptance.v1', phase: 'complete',
    source: { bytes: 117940, sourceSha256: 'a'.repeat(64), bundledSha256: 'a'.repeat(64), workspaceSha256: 'a'.repeat(64), servedSha256: 'a'.repeat(64) },
    inputTrace: [
      { trusted: true, type: 'pointerdown', code: null, movementX: 0, movementY: 0 },
      { trusted: true, type: 'pointermove', code: null, movementX: 14, movementY: -6 },
      { trusted: true, type: 'keydown', code: 'KeyW', movementX: null, movementY: null },
      { trusted: true, type: 'keydown', code: 'Digit3', movementX: null, movementY: null },
    ],
    pointerLock: { changes: 2, errors: 0, acquired: true, retainedFlyToRun: true, released: true },
    graphics: { contextLost: false, drawingBuffer: [1200, 700], renderer: 'WebKit WebGL', unmaskedRenderer: 'ANGLE (NVIDIA GB10, Vulkan)' },
    isolation: { canonicalUnchangedDuringNavigation: true, applyCountUnchanged: true, historyUnchanged: true, freshReopenMatched: true, observationCapabilityImmutable: true },
    run: { groundOnlyFallback: true, colliderBacked: false, yPinned: true, horizontalMoved: true, rollZero: true },
    screenshots: ['12-worldsculpt-inspect-framed.png', '13-worldsculpt-inspect-orbit.png', '14-worldsculpt-fly-locked.png', '15-worldsculpt-run-ground-only.png', '16-worldsculpt-restored-inspect.png'],
  }
  const result = { status: 'PASS', checks, errors: [], evidence: { worldSculptNavigation: navigation } }
  assert.doesNotThrow(() => runner.assertActualWorldSculptNavigationTerminal(result))
  for (const [label, mutate] of [
    ['untrusted', (value) => { value.evidence.worldSculptNavigation.inputTrace[0].trusted = false }],
    ['lock error', (value) => { value.evidence.worldSculptNavigation.pointerLock.errors = 1 }],
    ['lock unavailable', (value) => { value.evidence.worldSculptNavigation.pointerLock.acquired = false }],
    ['context lost', (value) => { value.evidence.worldSculptNavigation.graphics.contextLost = true }],
    ['software GPU', (value) => { value.evidence.worldSculptNavigation.graphics.renderer = 'ANGLE (SwiftShader)' }],
    ['generic masked GPU with unavailable identity', (value) => { value.evidence.worldSculptNavigation.graphics.renderer = 'WebKit WebGL'; value.evidence.worldSculptNavigation.graphics.unmaskedRenderer = null }],
    ['generic unmasked GPU identity', (value) => { value.evidence.worldSculptNavigation.graphics.unmaskedRenderer = 'WebKit WebGL' }],
    ['unknown unmasked GPU identity', (value) => { value.evidence.worldSculptNavigation.graphics.unmaskedRenderer = 'Unknown GPU' }],
    ['empty unmasked GPU identity', (value) => { value.evidence.worldSculptNavigation.graphics.unmaskedRenderer = '' }],
    ['observation mutation', (value) => { value.evidence.worldSculptNavigation.isolation.observationCapabilityImmutable = false }],
    ['cleanup', (value) => { value.errors.push('unexpected cleanup failure') }],
    ['collider claim', (value) => { value.evidence.worldSculptNavigation.run.colliderBacked = true }],
  ]) {
    const invalid = structuredClone(result); mutate(invalid)
    assert.throws(() => runner.assertActualWorldSculptNavigationTerminal(invalid), undefined, label)
  }
})

test('WSNAV5 renderer observation treats absent OrbitControls as pending without weakening navigation readiness', async () => {
  assert.equal(typeof aiPolicies.parseObservedOrbitEnabled, 'function')
  const diagnostics = []
  const observe = (controls) => {
    try { return { controls: { orbitEnabled: aiPolicies.parseObservedOrbitEnabled(controls) } } }
    catch (error) { diagnostics.push(String(error)); return null }
  }

  const beforeMount = observe(undefined)
  assert.equal(beforeMount.controls.orbitEnabled, null)
  assert.deepEqual(diagnostics, [], 'A control-less pre-mount observation must not poison later readiness')
  const mounted = observe({ enabled: true })
  assert.equal(mounted.controls.orbitEnabled, true)
  assert.deepEqual(diagnostics, [], 'Absent then valid controls in one lifecycle must remain diagnostic-free')
  assert.equal(beforeMount.controls.orbitEnabled === true, false, 'Pending controls cannot satisfy Inspect readiness')
  assert.equal(beforeMount.controls.orbitEnabled === false, false, 'Pending controls cannot satisfy Fly/Run readiness')
  assert.equal(observe({ enabled: false }).controls.orbitEnabled, false)

  for (const malformed of [{}, { enabled: 'true' }, false, []]) {
    assert.throws(() => aiPolicies.parseObservedOrbitEnabled(malformed), /OrbitControls public runtime contract changed/)
  }
  assert.equal(observe({ enabled: 'true' }), null)
  assert.match(diagnostics.at(-1), /OrbitControls public runtime contract changed/, 'Present malformed controls remain fatal to fixture health')

  const canvas = { canvasUuid: 'canvas:owned', rect: { x: 10, y: 20, width: 400, height: 300 } }
  const emptyObservation = {
    point: { x: 50, y: 60 }, canvasUuid: canvas.canvasUuid, hitCanvas: true,
    interactionHitCount: 0, firstEntityId: null, firstHitKind: null,
  }
  const entityObservation = {
    point: { x: 210, y: 170 }, canvasUuid: canvas.canvasUuid, hitCanvas: true,
    interactionHitCount: 2, firstEntityId: 'entity:worldsculpt', firstHitKind: 'selection-hitbox',
  }
  assert.equal(typeof aiPolicies.admitCanvasInteractionPoint, 'function')
  const emptyPoint = aiPolicies.admitCanvasInteractionPoint(emptyObservation, { ...canvas, entityId: null })
  const entityPoint = aiPolicies.admitCanvasInteractionPoint(entityObservation, { ...canvas, entityId: 'entity:worldsculpt' })
  assert.deepEqual(emptyPoint, emptyObservation.point); assert.notEqual(emptyPoint, emptyObservation.point); assert.equal(Object.isFrozen(emptyPoint), true)
  assert.deepEqual(entityPoint, entityObservation.point); assert.notEqual(entityPoint, entityObservation.point); assert.equal(Object.isFrozen(entityPoint), true)
  const admittedCopies = { empty: structuredClone(emptyPoint), entity: structuredClone(entityPoint) }
  emptyObservation.point.x = 99; entityObservation.point.y = 199
  assert.deepEqual(emptyPoint, admittedCopies.empty, 'Admitted empty point must not alias renderer observation')
  assert.deepEqual(entityPoint, admittedCopies.entity, 'Admitted entity point must not alias renderer observation')

  for (const [label, base, expected, mutate] of [
    ['missing', null, { ...canvas, entityId: null }, () => {}],
    ['wrong canvas', structuredClone(emptyObservation), { ...canvas, entityId: null }, (value) => { value.canvasUuid = 'canvas:stale' }],
    ['occluded DOM', structuredClone(emptyObservation), { ...canvas, entityId: null }, (value) => { value.hitCanvas = false }],
    ['outside Canvas', structuredClone(emptyObservation), { ...canvas, entityId: null }, (value) => { value.point.x = 9 }],
    ['noninteger point', structuredClone(emptyObservation), { ...canvas, entityId: null }, (value) => { value.point.y = 60.5 }],
    ['empty ray hit', structuredClone(emptyObservation), { ...canvas, entityId: null }, (value) => { value.interactionHitCount = 1 }],
    ['empty entity alias', structuredClone(emptyObservation), { ...canvas, entityId: null }, (value) => { value.firstEntityId = 'entity:worldsculpt'; value.firstHitKind = 'model' }],
    ['wrong entity', structuredClone(entityObservation), { ...canvas, entityId: 'entity:worldsculpt' }, (value) => { value.firstEntityId = 'entity:other' }],
    ['missing entity hit', structuredClone(entityObservation), { ...canvas, entityId: 'entity:worldsculpt' }, (value) => { value.interactionHitCount = 0 }],
    ['invalid hit kind', structuredClone(entityObservation), { ...canvas, entityId: 'entity:worldsculpt' }, (value) => { value.firstHitKind = 'grid' }],
  ]) {
    const value = base === null ? null : structuredClone(base); mutate(value)
    const beforeAdmission = structuredClone(value)
    assert.throws(() => aiPolicies.admitCanvasInteractionPoint(value, expected), undefined, label)
    assert.deepEqual(value, beforeAdmission, `${label} denial must not mutate the observation`)
  }

  const beforeCamera = Array.from({ length: 32 }, (_, index) => index / 10)
  const afterCamera = [...beforeCamera]; afterCamera[12] += 2
  const framedCorners = Array.from({ length: 8 }, (_, index) => ({
    world: [index & 1, (index >> 1) & 1, (index >> 2) & 1],
    ndc: [(index & 1) ? 0.5 : -0.5, (index & 2) ? 0.4 : -0.4, 0.2],
    depth: 2.1,
  }))
  const focusTrace = [{ sequence: 8, at: '2026-09-26T00:00:00.000Z', type: 'dblclick', trusted: true,
    x: 210, y: 170, buttons: 0, movementX: 0, movementY: 0, code: null,
    target: 'CANVAS:', canvasUuid: canvas.canvasUuid, frame: 12 }]
  const focusInput = {
    beforeCamera, afterCamera, beforeBounds: { x: 60, y: 120, width: 300, height: 30 },
    afterBounds: { x: 80, y: 125, width: 260, height: 26 }, afterWorldCorners: framedCorners,
    trace: focusTrace, traceStart: 7, point: { x: 210, y: 170 }, canvasUuid: canvas.canvasUuid,
  }
  assert.equal(typeof aiPolicies.admitNativeCanvasFocusEvidence, 'function')
  const focusEvidence = aiPolicies.admitNativeCanvasFocusEvidence(focusInput)
  assert.deepEqual(focusEvidence, { dblclickSequence: 8 }); assert.equal(Object.isFrozen(focusEvidence), true)
  const alreadyFitted = structuredClone(focusInput)
  alreadyFitted.afterCamera = [...alreadyFitted.beforeCamera]; alreadyFitted.afterBounds = structuredClone(alreadyFitted.beforeBounds)
  assert.deepEqual(aiPolicies.admitNativeCanvasFocusEvidence(alreadyFitted), { dblclickSequence: 8 },
    'A trusted focus gesture on an already-fitted clean scene may legitimately leave the camera unchanged')
  const preservedFocusInput = structuredClone(focusInput)
  aiPolicies.admitNativeCanvasFocusEvidence(focusInput)
  assert.deepEqual(focusInput, preservedFocusInput, 'Focus evidence admission must be read-only')
  for (const [label, mutate] of [
    ['untrusted double click', (value) => { value.trace[0].trusted = false }],
    ['wrong event', (value) => { value.trace[0].type = 'click' }],
    ['stale sequence', (value) => { value.trace[0].sequence = value.traceStart }],
    ['wrong Canvas', (value) => { value.trace[0].canvasUuid = 'canvas:other' }],
    ['retargeted point', (value) => { value.trace[0].x += 1 }],
    ['nonfinite camera', (value) => { value.afterCamera[0] = Number.NaN }],
    ['invalid projected bounds', (value) => { value.afterBounds.width = 0 }],
    ['missing framed geometry', (value) => { value.afterWorldCorners = [] }],
    ['outside padded frame', (value) => { value.afterWorldCorners[0].ndc[0] = 0.93 }],
    ['behind camera', (value) => { value.afterWorldCorners[0].depth = 0 }],
    ['nonfinite geometry', (value) => { value.afterWorldCorners[0].world[1] = Number.NaN }],
  ]) {
    const invalid = structuredClone(focusInput); mutate(invalid)
    const beforeDenial = structuredClone(invalid)
    assert.throws(() => aiPolicies.admitNativeCanvasFocusEvidence(invalid), undefined, label)
    assert.deepEqual(invalid, beforeDenial, `${label} denial must not mutate the focus evidence input`)
  }

  const rendererSource = await readFile(new URL('./renderer.tsx', import.meta.url), 'utf8')
  assert.match(rendererSource, /const orbitEnabled = parseObservedOrbitEnabled\(record\(state\)\.controls\)/,
    'Actual renderer observer must use the pending-aware parser')
  assert.match(rendererSource, /controls: \{ orbitEnabled \}/,
    'Actual renderer DTO must publish the parser result without fabricating a control state')
  assert.match(rendererSource, /interactionTargets: observeCanvasInteractionTargets/,
    'Renderer must publish bounded read-only Canvas hit admission')
  assert.doesNotMatch(rendererSource, /state\.raycaster\.setFromCamera/,
    'Read-only fixture observation must not mutate the production raycaster')
  assert.match(rendererSource, /'dblclick'/, 'Renderer trace must observe the trusted production focus gesture')
  const sharedSource = await readFile(new URL('./shared.ts', import.meta.url), 'utf8')
  assert.match(sharedSource, /controls: \{ orbitEnabled: boolean \| null \}/,
    'Shared observation DTO must preserve the explicit pending state')
  const navigationSource = await readFile(new URL('./navigation-driver.ts', import.meta.url), 'utf8')
  assert.match(navigationSource, /controls\.orbitEnabled === false/, 'Fly/Run readiness must remain strictly disabled')
  assert.match(navigationSource, /controls\.orbitEnabled === true/, 'Inspect readiness must remain strictly enabled')
  assert.match(navigationSource, /nativeCanvasDoubleClick/, 'Navigation must focus through real native double-click input')
  assert.equal([...navigationSource.matchAll(/prepareWorldSculptVisualProof\(/g)].length, 3,
    'One helper and exactly two strict visual checks must share the closeup preparation')
  assert.doesNotMatch(navigationSource, /focused\.bounds\.width > initialBounds\.width|changed\(focus\.beforeCamera/,
    'Already-fitted clean scenes must not require camera motion or projected enlargement')
  assert.match(navigationSource, /click\(contents, ports, 'button', 'Add scene'\)/,
    'WorldSculpt must use the real scene-add UI before import')
  assert.match(navigationSource, /assertSuccessfulUiApply\(beforeSceneAdd,[^;]+\['add-scene'\]\)/s,
    'Empty-scene setup must prove one canonical add-scene revision')
  assert.match(navigationSource, /assertSuccessfulUiApply\(beforeAdd,[^;]+\['add-resource', 'add-entity'\]\)/s,
    'WorldSculpt import must prove the canonical resource/entity revision')
  assert.equal([...navigationSource.matchAll(/assertReopenedAuthoringVisual\(/g)].length, 2,
    'Both strict visual paint checks must remain present')
})

test('WSNAV6 durable witness replays actual v2 and retains exact v1 compatibility', async () => {
  const [{ WorldProjectRepository }, commands, documents, model] = await Promise.all([
    import('../../electron/main/world-project-repository.ts'),
    import('../../src/areas/worlds/core/worldCommands.ts'),
    import('../../src/areas/worlds/core/worldDocuments.ts'),
    import('../../src/areas/worlds/core/worldModel.ts'),
  ])
  const source = await readFile(new URL('./main.ts', import.meta.url), 'utf8')
  const implementation = oneSeam(source, /(function assertStoredResult\([\s\S]*?\n})\nasync function captureStoredWitness/g, 'actual durable result witness')
  const makeComparator = await inertFunction(`${implementation}\nreturn assertStoredResult`, [
    'assert', 'hash', 'parseWorldCommandBatch', 'canonicalWorldCommandBatchPayload', 'applyWorldCommandBatch', 'validateWorldProjectSnapshot',
  ])
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const compare = makeComparator(assert, digest, commands.parseWorldCommandBatch, commands.canonicalWorldCommandBatchPayload,
    commands.applyWorldCommandBatch, documents.validateWorldProjectSnapshot)
  assert.equal([...source.matchAll(/assertStoredResult\(/g)].length, 4,
    'Immediate capture, historical checkpoints, and normalized AI witnesses must share one comparator')

  const root = await mkdtemp(path.join(evidenceRoot, 'durable-witness-'))
  const projectKey = 'world-11111111111111111111111111111111'
  const repository = new WorldProjectRepository({
    getWorkspaceRoot: () => root,
    createProjectKey: () => projectKey,
    createSceneKey: () => 'scene-22222222222222222222222222222222',
    now: () => new Date('2026-09-26T00:00:00.000Z'),
  })
  const created = await repository.create({ name: 'Durable witness', initialSceneName: 'Scene' })
  assert.equal(created.ok, true)
  if (!created.ok) return
  const sceneId = created.value.snapshot.project.startSceneId
  const addBatch = {
    schema: model.WORLD_COMMAND_BATCH_SCHEMA,
    transactionId: 'tx:fixture-durable-add', projectId: created.value.snapshot.project.projectId,
    baseRevision: created.value.snapshot.project.revision, origin: 'ui',
    commands: [
      { type: 'add-resource', resource: { id: 'resource:fixture-model', type: 'model', name: 'fixture.glb', workspacePath: 'Exports/Fixture/fixture.glb', format: 'glb' } },
      { type: 'add-entity', sceneId, entity: { id: 'entity:fixture-model', name: 'fixture.glb', parentId: null,
        enabled: true, locked: false, tags: [], transform: structuredClone(before), components: [{ id: 'component:fixture-renderable', type: 'renderable', enabled: true,
          resourceId: 'resource:fixture-model', visible: true, castShadow: true, receiveShadow: true,
          material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 } }] } },
    ],
  }
  const added = await repository.applyCommands({ projectKey, batch: addBatch })
  assert.equal(added.ok, true)
  if (!added.ok) return

  const projectRoot = path.join(root, 'Worlds', projectKey)
  const readStored = async (transactionId) => {
    const state = JSON.parse(await readFile(path.join(projectRoot, '.modly/state.v1.json'), 'utf8'))
    const transaction = state.transactions.find((entry) => entry.transactionId === transactionId)
    assert.ok(transaction)
    const bytes = await readFile(path.join(projectRoot, '.modly/transactions', transaction.transactionDigest, 'after/result.v1.json'))
    return { bytes, transaction }
  }
  const firstStored = await readStored(addBatch.transactionId)
  const compact = JSON.parse(firstStored.bytes.toString('utf8'))
  assert.equal(compact.schema, 'modly.world-command-result.v2')
  assert.equal(Object.hasOwn(compact, 'snapshot'), false, 'Compact v2 must remain compact')
  assert.doesNotThrow(() => compare(firstStored.bytes, firstStored.transaction, added.value))

  const patchBatch = {
    schema: model.WORLD_COMMAND_BATCH_SCHEMA,
    transactionId: 'tx:fixture-durable-transform', projectId: added.value.snapshot.project.projectId,
    baseRevision: added.value.snapshot.project.revision, origin: 'ui',
    commands: [{ type: 'patch-entity', sceneId, entityId: 'entity:fixture-model', patch: {
      transform: { position: [3, 2, 1], rotation: [0.1, 0.2, 0.3], scale: [2, 2, 2] },
    } }],
  }
  const patched = await repository.applyCommands({ projectKey, batch: patchBatch })
  assert.equal(patched.ok, true)
  if (!patched.ok) return
  const secondStored = await readStored(patchBatch.transactionId)
  assert.doesNotThrow(() => compare(secondStored.bytes, secondStored.transaction, patched.value))
  assert.doesNotThrow(() => compare(firstStored.bytes, firstStored.transaction, added.value), 'Historical evidence remains valid after later commands')

  const legacy = {
    schema: 'modly.world-command-result.v1', transactionId: added.value.receipt.transactionId,
    snapshot: structuredClone(added.value.snapshot), newRevision: added.value.newRevision,
    changes: [...added.value.changes], warnings: [...added.value.warnings], inverse: structuredClone(added.value.inverse),
  }
  const retarget = (record, transaction = structuredClone(firstStored.transaction), value = structuredClone(added.value)) => {
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`), resultSha256 = digest(bytes)
    transaction.resultSha256 = resultSha256; value.receipt.resultSha256 = resultSha256
    return { bytes, transaction, value }
  }
  const legacyControl = retarget(legacy)
  assert.doesNotThrow(() => compare(legacyControl.bytes, legacyControl.transaction, legacyControl.value))

  const rejects = (label, mutate) => {
    const record = structuredClone(compact), transaction = structuredClone(firstStored.transaction), value = structuredClone(added.value)
    mutate({ record, transaction, value })
    const control = retarget(record, transaction, value)
    assert.throws(() => compare(control.bytes, control.transaction, control.value), undefined, label)
  }
  rejects('unknown schema', ({ record }) => { record.schema = 'modly.world-command-result.v3' })
  rejects('extra field', ({ record }) => { record.snapshot = structuredClone(added.value.snapshot) })
  rejects('missing field', ({ record }) => { delete record.warnings })
  rejects('altered inverse', ({ record }) => { record.inverse.snapshot.project.name = 'Corrupt prior snapshot' })
  rejects('wrong transaction', ({ record }) => { record.transactionId = 'tx:other' })
  rejects('wrong revision', ({ record }) => { record.newRevision += 1 })
  rejects('altered changes', ({ record }) => { record.changes = ['corrupt-change'] })
  rejects('altered warnings', ({ record }) => { record.warnings = ['corrupt-warning'] })
  rejects('wrong reconstructed IPC snapshot', ({ value }) => { value.snapshot.project.name = 'Corrupt accepted snapshot' })
  rejects('wrong payload hash', ({ transaction, value }) => { transaction.payloadSha256 = '0'.repeat(64); value.receipt.payloadSha256 = transaction.payloadSha256 })
  rejects('wrong transaction digest', ({ transaction }) => { transaction.transactionDigest = '0'.repeat(64) })
  rejects('wrong canonical project binding', ({ transaction, value }) => {
    const batch = JSON.parse(transaction.canonicalPayload); batch.projectId = 'project:other'
    transaction.canonicalPayload = commands.canonicalWorldCommandBatchPayload(batch)
    transaction.payloadSha256 = digest(Buffer.from(transaction.canonicalPayload)); value.receipt.payloadSha256 = transaction.payloadSha256
    transaction.transactionDigest = digest(Buffer.from(`${transaction.transactionId}\n${transaction.canonicalPayload}`))
  })
})

const authoredSnapshot = () => ({ project: { projectId: 'project:observed', revision: 8, scenes: [{ id: 'scene:first' }, { id: 'scene:second' }] }, scenes: ['scene:first', 'scene:second'].map((sceneId) => ({ sceneId, entities: [
  { id: `${sceneId}:model-a`, enabled: true, parentId: null, transform: structuredClone(before), components: [{ type: 'renderable', enabled: true }] },
  { id: `${sceneId}:model-b`, enabled: true, parentId: null, transform: structuredClone(before), components: [{ type: 'renderable', enabled: true }] },
  { id: `${sceneId}:camera`, enabled: true, components: [{ type: 'camera', enabled: true, primary: true }] },
  { id: `${sceneId}:light`, enabled: true, components: [{ type: 'light', enabled: true }] },
] })) })

test('N3 numeric evidence rejects no-op, wrong captured owner and unrelated canonical changes', () => {
  const initial = authoredSnapshot(), final = structuredClone(initial), id = 'scene:first:model-a'
  final.project.revision += 1; final.scenes[0].entities[0].transform.position[0] = -2
  const invocation = { forwardedAt: 'observed', settledAt: 'observed', result: { ok: true, value: { snapshot: final, warnings: [], idempotent: false, inverse: { kind: 'world-snapshot', snapshot: structuredClone(initial) } } }, request: { batch: { origin: 'ui', projectId: initial.project.projectId, baseRevision: initial.project.revision, commands: [{ type: 'patch-entity', sceneId: 'scene:first', entityId: id, patch: { transform: final.scenes[0].entities[0].transform } }] } } }
  assert.doesNotThrow(() => assertNativeNumericCommit(initial, final, 'scene:first', id, 'position', 0, -2, invocation))
  assert.throws(() => assertNativeNumericCommit(initial, initial, 'scene:first', id, 'position', 0, -1.25, invocation))
  const wrong = structuredClone(invocation); wrong.request.batch.commands[0].entityId = 'scene:first:model-b'
  assert.throws(() => assertNativeNumericCommit(initial, final, 'scene:first', id, 'position', 0, -2, wrong))
  const unrelated = structuredClone(final); unrelated.scenes[1].entities[0].transform.position[1] = 4
  assert.throws(() => assertNativeNumericCommit(initial, unrelated, 'scene:first', id, 'position', 0, -2, invocation))
  for (const [label, corrupt] of [
    ['missing inverse', (value) => { delete value.inverse }],
    ['wrong kind', (value) => { value.inverse.kind = 'entity-patch' }],
    ['wrong project', (value) => { value.inverse.snapshot.project.projectId = 'project:other' }],
    ['wrong scene', (value) => { value.inverse.snapshot.scenes[0].sceneId = 'scene:second' }],
    ['wrong entity', (value) => { value.inverse.snapshot.scenes[0].entities[0].id = 'scene:first:model-b' }],
    ['wrong revision', (value) => { value.inverse.snapshot.project.revision += 1 }],
    ['wrong captured transform', (value) => { value.inverse.snapshot.scenes[0].entities[0].transform.position[0] = -2 }],
    ['unrelated before data', (value) => { value.inverse.snapshot.scenes[1].entities[0].transform.position[1] = 4 }],
    ['extra inverse field', (value) => { value.inverse.commands = [] }],
  ]) {
    const invalid = structuredClone(invocation); corrupt(invalid.result.value)
    assert.throws(() => assertNativeNumericCommit(initial, final, 'scene:first', id, 'position', 0, -2, invalid), /Numeric inverse must match the captured before snapshot/, label)
  }
})

test('N4 both authored scenes require models, one primary camera, light and a genuinely fresh reopen', () => {
  const value = authoredSnapshot(), ids = ['scene:first', 'scene:second']
  for (const id of ids) assert.doesNotThrow(() => assertUiAuthoredScene(value, id, 2))
  assert.doesNotThrow(() => assertBothScenesReopened(value, structuredClone(value), ids, 'old', 'new'))
  assert.throws(() => assertBothScenesReopened(value, value, ids, 'old', 'old'))
  assert.throws(() => assertBothScenesReopened(value, value, [ids[0], ids[0]], 'old', 'new'))
  const missing = structuredClone(value); missing.scenes[1].entities.pop()
  assert.throws(() => assertUiAuthoredScene(missing, ids[1], 2))
  const changed = structuredClone(value); changed.scenes[1].entities[0].transform.position[2] = 3
  assert.throws(() => assertBothScenesReopened(value, changed, ids, 'old', 'new'))
})

test('F1 binds held and committed transforms to the same final preview, not any nonzero change', () => {
  const rounded = structuredClone(preview); rounded.position[1] += CAPTURED_TRANSFORM_TOLERANCE / 2
  assert.doesNotThrow(() => assertCapturedTranslation(before, preview, rounded, 'Y', 'Held C request'))
  assert.doesNotThrow(() => assertCapturedTranslation(before, preview, preview, 'Y', 'Committed C snapshot'))
  const wrong = structuredClone(preview); wrong.position[1] += 0.125
  for (const label of ['Held C request before release', 'Committed C snapshot']) {
    assert.throws(() => assertCapturedTranslation(before, preview, wrong, 'Y', label), /does not match the captured final preview/)
    assert.throws(() => assertCapturedTranslation(before, preview, before, 'Y', label), /does not match the captured final preview/)
  }
})

test('F1 rejects cross-axis, rotation, scale, no-op and nonfinite preview leakage', () => {
  for (const [field, index] of [['position', 0], ['position', 2], ['rotation', 0], ['rotation', 1], ['rotation', 2], ['scale', 0], ['scale', 1], ['scale', 2]]) {
    const changed = structuredClone(preview); changed[field][index] += 0.01
    assert.throws(() => assertCapturedTranslation(before, changed, changed, 'Y', 'Preview'), /unrelated .* changed during translation/)
  }
  assert.throws(() => assertCapturedTranslation(before, before, before, 'Y', 'Preview'), /no nonzero chosen-axis preview/)
  for (const value of [NaN, Infinity, -Infinity]) {
    const changed = structuredClone(preview); changed.position[1] = value
    assert.throws(() => assertCapturedTranslation(before, preview, changed, 'Y', 'Held request'), /nonfinite/)
  }
})

test('F2 records exact absent paths independently of process exit', async (t) => {
  t.diagnostic(`Evidence root: ${evidenceRoot}; owned=${ownsEvidenceRoot}`)
  const directory = await mkdtemp(path.join(evidenceRoot, 'absent-'))
  const paths = { socket: path.join(directory, 'X-fixture'), lock: path.join(directory, 'X-fixture-lock') }
  const result = await waitForDisplayResourcesAbsent(paths, 0)
  assert.equal(result.status, 'ABSENT'); assert.equal(result.scope, 'exact-filesystem-paths-only')
  assert.deepEqual(result.observations.map(({ socket, lock }) => ({ socket, lock })), [{ socket: null, lock: null }])
  await writeFile(path.join(directory, 'observations.json'), JSON.stringify(result, null, 2))
})

test('F2 fails remaining/replaced paths without deleting files or following a symlink', {
  skip: posixOwnership ? false : 'Requires POSIX UID and symlink ownership semantics; no native display proof',
}, async () => {
  const directory = await mkdtemp(path.join(evidenceRoot, 'remains-'))
  const paths = { socket: path.join(directory, 'X-fixture'), lock: path.join(directory, 'X-fixture-lock') }
  const target = path.join(directory, 'untouched-target'); await mkdir(target)
  await writeFile(path.join(target, 'sentinel'), 'unchanged\n')
  await symlink(target, paths.socket); await writeFile(paths.lock, `${process.pid}\n`)
  await assert.rejects(captureOwnedDisplayResources(paths, process.pid, process.getuid()), /not a socket/)
  const result = await waitForDisplayResourcesAbsent(paths, 40)
  assert.equal(result.status, 'REMAINS'); assert.ok(result.observations.length >= 1 && result.observations.length <= 2)
  for (const observation of result.observations) {
    assert.equal(observation.socket.type, 'symlink-not-followed'); assert.equal(observation.lock.type, 'file')
    for (const resource of [observation.socket, observation.lock]) {
      const info = await lstat(resource.path, { bigint: true })
      assert.equal(resource.device, String(info.dev)); assert.equal(resource.inode, String(info.ino)); assert.equal(resource.uid, process.getuid())
    }
  }
  assert.equal(await readFile(path.join(target, 'sentinel'), 'utf8'), 'unchanged\n')
  assert.equal(await readFile(paths.lock, 'utf8'), `${process.pid}\n`)
  await writeFile(path.join(directory, 'observations.json'), JSON.stringify(result, null, 2))
})

test('S1 classifies generated evidence metadata without following targets or hashing regular files', async () => {
  const directory = await mkdtemp(path.join(evidenceRoot, 'source-evidence-'))
  const evidence = path.join(directory, 'docs/worlds-engine-evidence/attempt')
  await mkdir(evidence, { recursive: true })
  const target = path.join(directory, 'untouched-target'), link = path.join(evidence, 'profile.json')
  await writeFile(target, 'unchanged\n'); await symlink(target, link)
  const dangling = path.join(evidence, 'dangling.json'); await symlink(path.join(directory, 'missing-target'), dangling)
  const regular = path.join(evidence, 'report.md'); await writeFile(regular, 'retained regular evidence\n')
  const custody = createSourceCustody(directory)
  for (const filename of [link, dangling, regular]) await custody.remember(filename, { canonicalEnumeration: true })
  assert.equal(custody.sources.size, 0); assert.equal(custody.sources.has(regular), false)
  assert.equal(custody.incidentalArtifacts.size, 3)
  assert.equal(custody.incidentalArtifacts.get(regular).type, 'regular-file')
  assert.equal(custody.incidentalArtifacts.get(regular).lstatSize, (await lstat(regular)).size)
  for (const filename of [link, dangling]) {
    const metadata = custody.incidentalArtifacts.get(filename), info = await lstat(filename)
    assert.equal(metadata.classification, 'incidental-generated-evidence'); assert.equal(metadata.type, 'symlink-not-followed')
    assert.equal(metadata.device, String(info.dev)); assert.equal(metadata.inode, String(info.ino))
    await assert.rejects(custody.remember(filename), /Nonregular source input/)
    await assert.rejects(custody.rememberResolvedModule(`${filename}?raw`), /Nonregular source input/)
  }
  await custody.verifySources()
  assert.equal(await readFile(target, 'utf8'), 'unchanged\n')
  for (const relative of ['docs/ordinary-link', 'docs/worlds-engine-evidence-lookalike/profile.json', 'src/source.ts']) {
    const filename = path.join(directory, relative)
    await mkdir(path.dirname(filename), { recursive: true }); await symlink(target, filename)
    await assert.rejects(custody.remember(filename, { canonicalEnumeration: true }), /Nonregular source input/)
  }
})

test('S2 strictly remembers existing resolved filesystem modules and leaves virtual IDs to Vite', async () => {
  const directory = await mkdtemp(path.join(evidenceRoot, 'source-modules-'))
  const filename = path.join(directory, 'source.ts'); await writeFile(filename, 'export const source = true\n')
  const custody = createSourceCustody(directory)
  await custody.rememberResolvedModule(`${filename}?raw`)
  assert.equal(custody.sources.has(filename), true)
  await custody.rememberResolvedModule('\0virtual:source'); await custody.rememberResolvedModule('virtual:source')
  const missing = path.join(directory, 'missing-virtual-module')
  await custody.rememberResolvedModule(missing)
  await assert.rejects(custody.remember(missing), { code: 'ENOENT' })
  await assert.rejects(custody.rememberResolvedModule(directory), /Nonregular source input/)
  await custody.verifySources()
})

test('S3 rechecks cached and verified input types and still rejects changed file bytes', async () => {
  const directory = await mkdtemp(path.join(evidenceRoot, 'source-replaced-'))
  const filename = path.join(directory, 'source.ts'), target = path.join(directory, 'same-bytes-target')
  await writeFile(filename, 'original\n'); await writeFile(target, 'original\n')
  const custody = createSourceCustody(directory); await custody.remember(filename)
  await rm(filename); await symlink(target, filename)
  await assert.rejects(custody.remember(filename), /Nonregular source input/)
  await assert.rejects(custody.rememberResolvedModule(`${filename}?raw`), /Nonregular source input/)
  await assert.rejects(custody.verifySources(), /Nonregular source input/)
  assert.equal(await readFile(target, 'utf8'), 'original\n')
  await rm(filename); await writeFile(filename, 'changed\n')
  await assert.rejects(custody.verifySources(), /Source input changed during build/)
})

// EventEmitter doubles exercise admission policy only; these are not native focus proof.
function focusAdmissionFixture(focused = false) {
  const window = new EventEmitter(), controller = new AbortController()
  window.focused = focused; window.destroyed = false
  window.isFocused = () => window.focused; window.isDestroyed = () => window.destroyed
  const state = { currentWindow: window, windows: [window], stopping: false, failure: null, ownershipChecks: 0 }
  const options = {
    deadline: Date.now() + 1000, signal: controller.signal,
    assertOwned() {
      state.ownershipChecks += 1
      if (state.failure) throw state.failure
      assert.equal(state.stopping, false, 'Fixture is stopping')
      assert.equal(state.currentWindow, window, 'Owned fixture window replaced')
      assert.deepEqual(state.windows, [window], 'Unexpected window ownership')
    },
  }
  return { window, controller, state, options }
}
function assertFocusAdmissionClean({ window, controller }) {
  assert.equal(window.listenerCount('focus'), 0); assert.equal(window.listenerCount('closed'), 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
}

test('NF1 waits for an asynchronous focus event and authoritative owned focus predicate', async () => {
  const fixture = focusAdmissionFixture(), admission = waitForOwnedWindowFocus(fixture.window, fixture.options)
  assert.equal(fixture.window.listenerCount('focus'), 1); assert.equal(fixture.window.isFocused(), false)
  setImmediate(() => { fixture.window.focused = true; fixture.window.emit('focus') })
  const result = await admission
  assert.equal(result.observedBy, 'native-focus-event'); assert.ok(Number.isFinite(Date.parse(result.focusedAt)))
  assertFocusAdmissionClean(fixture)
})

test('NF2 admits an already focused owned window without installing waiting listeners', async () => {
  const fixture = focusAdmissionFixture(true)
  const result = await waitForOwnedWindowFocus(fixture.window, fixture.options)
  assert.equal(result.observedBy, 'already-focused'); assertFocusAdmissionClean(fixture)
})

test('NF3 rejects a focus event whose authoritative predicate remains false', async () => {
  const fixture = focusAdmissionFixture(), admission = waitForOwnedWindowFocus(fixture.window, fixture.options)
  fixture.window.emit('focus')
  await assert.rejects(admission, /Native focus event did not confirm/); assertFocusAdmissionClean(fixture)
})

test('NF4 rejects not-owned, additional-owner and replaced-owner focus admission', async () => {
  for (const change of [(fixture) => { fixture.state.currentWindow = null }, (fixture) => { fixture.state.windows.push(new EventEmitter()) }]) {
    const fixture = focusAdmissionFixture(true); change(fixture)
    await assert.rejects(waitForOwnedWindowFocus(fixture.window, fixture.options), /replaced|ownership/)
    assertFocusAdmissionClean(fixture)
  }
  const fixture = focusAdmissionFixture(), admission = waitForOwnedWindowFocus(fixture.window, fixture.options)
  fixture.state.currentWindow = new EventEmitter(); fixture.window.focused = true; fixture.window.emit('focus')
  await assert.rejects(admission, /replaced/); assertFocusAdmissionClean(fixture)
})

test('NF5 rejects initially destroyed, subsequently destroyed and closed windows', async () => {
  const destroyed = focusAdmissionFixture(true); destroyed.window.destroyed = true
  await assert.rejects(waitForOwnedWindowFocus(destroyed.window, destroyed.options), /destroyed/)
  assertFocusAdmissionClean(destroyed)
  for (const event of ['closed', 'focus']) {
    const fixture = focusAdmissionFixture(), admission = waitForOwnedWindowFocus(fixture.window, fixture.options)
    if (event === 'focus') { fixture.window.destroyed = true; fixture.window.focused = true }
    fixture.window.emit(event)
    await assert.rejects(admission, /closed|destroyed/); assertFocusAdmissionClean(fixture)
  }
})

test('NF6 rejects missing focus by deadline and cannot admit focused windows after deadline', async () => {
  const fixture = focusAdmissionFixture(); fixture.options.deadline = Date.now() + 20
  await assert.rejects(waitForOwnedWindowFocus(fixture.window, fixture.options), /deadline exceeded/)
  assertFocusAdmissionClean(fixture)
  const expired = focusAdmissionFixture(true); expired.options.deadline = Date.now() - 1
  await assert.rejects(waitForOwnedWindowFocus(expired.window, expired.options), /deadline exceeded/)
  assertFocusAdmissionClean(expired)
})

test('NF7 rejects stopping, existing failure and actual fatal abort with listener cleanup', async () => {
  for (const change of [(fixture) => { fixture.state.stopping = true }, (fixture) => { fixture.state.failure = new Error('Existing fatal failure') }]) {
    const fixture = focusAdmissionFixture(), admission = waitForOwnedWindowFocus(fixture.window, fixture.options)
    change(fixture); fixture.window.focused = true; fixture.window.emit('focus')
    await assert.rejects(admission, /stopping|fatal failure/); assertFocusAdmissionClean(fixture)
  }
  const fixture = focusAdmissionFixture(), admission = waitForOwnedWindowFocus(fixture.window, fixture.options)
  const fatal = new Error('Actual fatal cancellation'); fixture.controller.abort(fatal)
  await assert.rejects(admission, (error) => error === fatal); assertFocusAdmissionClean(fixture)
  const aborted = focusAdmissionFixture(true); aborted.controller.abort(0)
  await assert.rejects(waitForOwnedWindowFocus(aborted.window, aborted.options), /0/); assertFocusAdmissionClean(aborted)
})

test('NF8 removes listeners and cancels its deadline after observed successful focus', async () => {
  const fixture = focusAdmissionFixture(); fixture.options.deadline = Date.now() + 100
  const admission = waitForOwnedWindowFocus(fixture.window, fixture.options)
  fixture.window.focused = true; fixture.window.emit('focus'); await admission
  const checks = fixture.state.ownershipChecks; assertFocusAdmissionClean(fixture)
  fixture.window.emit('closed'); fixture.window.emit('focus')
  // This timer observes cleanup only; it neither requests nor assumes native focus.
  await new Promise((resolve) => setTimeout(resolve, 130))
  assert.equal(fixture.state.ownershipChecks, checks); assertFocusAdmissionClean(fixture)
})

// Observation-policy guards only; CSS geometry and trusted browser events require native UI proof.
const nativeClickObservation = () => ({ point: { x: 154, y: 134 }, matchCount: 1, enabled: true, visible: true, hitMatches: true,
  hit: { tagName: 'SPAN', ariaLabel: null, text: 'red-cube.glb' } })
test('HC1 admits only the unchanged original native point with an intended visible enabled hit', () => {
  for (const name of ['red-cube.glb', 'Position:Y', 'Add camera entity', 'Scene']) {
    const observation = nativeClickObservation()
    assert.doesNotThrow(() => assertNativeClickPointStable({ x: 154, y: 134 }, observation, name))
  }
})

test('HC2 rejects the observed name-to-Disable hover drift before native mutation', () => {
  const observation = nativeClickObservation()
  observation.hitMatches = false; observation.hit = { tagName: 'BUTTON', ariaLabel: 'Disable red-cube.glb', text: '◉' }
  assert.throws(() => assertNativeClickPointStable({ x: 154, y: 134 }, observation, 'red-cube.glb'), /drifted or was occluded.*Disable red-cube.glb/)
  observation.hit = null
  assert.throws(() => assertNativeClickPointStable({ x: 154, y: 134 }, observation, 'red-cube.glb'), /drifted or was occluded/)
})

test('HC3 rejects retargeting, missing or ambiguous targets and disabled or hidden post-hover targets', () => {
  for (const [change, reason] of [
    [(value) => { value.point.x += 1 }, /must not be retargeted/],
    [(value) => { value.matchCount = 0 }, /Ambiguous/],
    [(value) => { value.matchCount = 2 }, /Ambiguous/],
    [(value) => { value.enabled = false }, /Disabled/],
    [(value) => { value.visible = false }, /Hidden/],
  ]) {
    const observation = nativeClickObservation(); change(observation)
    assert.throws(() => assertNativeClickPointStable({ x: 154, y: 134 }, observation, 'red-cube.glb'), reason)
  }
})

const numericSettlementObservation = () => ({
  editor: { lifecycle: 'ready', session: { snapshot: { project: { revision: 10 } } } }, statuses: ['Saved'],
  inspectorValues: Object.entries(before).flatMap(([key, values]) => values.map((value, index) => ({
    label: `${key[0].toUpperCase()}${key.slice(1)}:${['X', 'Y', 'Z'][index]}`,
    value: String(value * (key === 'rotation' ? 180 / Math.PI : 1)), disabled: false,
  }))),
})

test('NS1 rejects ready exact-revision numeric observations while the production pending marker remains', () => {
  const view = numericSettlementObservation(); view.statuses.push('Saving transform…')
  assert.equal(isNativeNumericCommitSettled(view, 10), false)
})

test('NS2 admits ready exact-revision numeric observations after the pending marker clears', () => {
  assert.equal(isNativeNumericCommitSettled(numericSettlementObservation(), 10), true)
})

test('NS3 rejects loading and wrong-revision numeric observations even without a pending marker', () => {
  const loading = numericSettlementObservation(); loading.editor.lifecycle = 'loading'
  assert.equal(isNativeNumericCommitSettled(loading, 10), false)
  for (const revision of [9, 11]) assert.equal(isNativeNumericCommitSettled(numericSettlementObservation(), revision), false)
})

test('NS4 keeps settled Inspector count disability and value errors outside the wait boundary', () => {
  assert.doesNotThrow(() => assertInspector(numericSettlementObservation(), before, false))
  for (const [change, reason] of [
    [(view) => { view.inspectorValues.pop() }, /Expected all nine/],
    [(view) => { view.inspectorValues[0].disabled = true }, /disabled state disagrees/],
    [(view) => { view.inspectorValues[0].value = '99' }, /does not reflect canonical selection/],
  ]) {
    const view = numericSettlementObservation(); change(view)
    assert.equal(isNativeNumericCommitSettled(view, 10), true)
    assert.throws(() => assertInspector(view, before, false), reason)
  }
  const pending = numericSettlementObservation(); pending.inspectorValues.forEach((field) => { field.disabled = true })
  assert.doesNotThrow(() => assertInspector(pending, before, true))
})

// Pure admission policy only; these observations do not establish native input or GPU geometry.
function nativeHandleFixture() {
  const handle = { axis: 'Y', start: { x: 707, y: 364 }, end: { x: 642, y: 264 }, pickerUuid: 'picker:y', firstHitAxis: 'Y' }
  const captured = { bootId: 'renderer:current', editor: { projectKey: 'world:current', activeSceneId: 'scene:first', lifecycle: 'loading',
    session: { snapshot: authoredSnapshot(), undoStack: [], redoStack: [], receipts: [] } },
    selection: { ids: ['scene:first:model-b'], active: 'scene:first:model-b', mode: 'translate' }, statuses: ['Saving transform…'],
    canvas: { canvasUuid: 'canvas:current', frame: 10, contextLost: false, rect: { x: 260, y: 82, width: 1052, height: 869 }, camera: [1, 0, 0, 1],
      models: ['scene:first:model-b', 'scene:first:model-a'].map((entityId) => ({ entityId, uuid: entityId, transform: structuredClone(before), matrixWorld: [1, 0, 0, 1] })),
      gizmo: { controlUuid: 'control:current', objectUuid: 'scene:first:model-b', entityId: 'scene:first:model-b', enabled: true, mode: 'translate', axis: null, dragging: false, candidates: [handle], pointerHit: null } }, trace: [{ sequence: 40 }] }
  const view = structuredClone(captured)
  view.canvas.frame = 14; view.canvas.gizmo.axis = 'Y'
  view.canvas.gizmo.pointerHit = { canvasUuid: 'canvas:current', targetCanvas: true, trusted: true, sequence: 41, frame: 11,
    type: 'pointermove', buttons: 0, point: { x: 707, y: 364 }, firstHitAxis: 'Y', pickerUuid: 'picker:y' }
  view.trace.push({ sequence: 41, type: 'pointermove', trusted: true, x: 707, y: 364, buttons: 0, canvasUuid: 'canvas:current', frame: 11 })
  return { captured, view, handle, id: 'scene:first:model-b' }
}
function assertHandleRejected(change) {
  const fixture = nativeHandleFixture(); change(fixture.view, fixture.captured)
  // This is the exact exported predicate called by down() before its native mouseDown.
  assert.throws(() => isNativeHandleHover(fixture.view, fixture.handle, fixture.id, fixture.captured))
}

test('GH1 keeps strict native axis acknowledgement on an enabled fixed-point hit', () => {
  const { captured, view, handle, id } = nativeHandleFixture()
  assert.equal(isNativeHandleHover(view, handle, id, captured), true)
  view.canvas.gizmo.axis = null
  assert.equal(isNativeHandleHover(view, handle, id, captured), false)
})

test('GH2 rejects stale delivered points and fixed-point misses despite a historical candidate hit', () => {
  for (const change of [
    (v) => { v.canvas.gizmo.pointerHit.point.x += 1 },
    (v) => { v.canvas.gizmo.pointerHit.firstHitAxis = null; v.canvas.gizmo.pointerHit.pickerUuid = null },
    (v) => { v.canvas.gizmo.pointerHit.firstHitAxis = 'X' },
    (v) => { v.canvas.gizmo.pointerHit.pickerUuid = 'picker:other' },
  ]) assertHandleRejected(change)
})

test('GH3 rejects wrong Canvas untrusted missing and unmatched native pointer evidence', () => {
  for (const change of [
    (v) => { v.canvas.gizmo.pointerHit.canvasUuid = 'canvas:other' },
    (v) => { v.canvas.gizmo.pointerHit.targetCanvas = false },
    (v) => { v.canvas.gizmo.pointerHit.trusted = false },
    (v) => { v.canvas.gizmo.pointerHit = null },
    (v) => { v.trace[1].trusted = false },
    (v) => { v.trace[1].x += 1 },
    (v) => { v.canvas.gizmo.pointerHit.type = 'pointerup' },
    (v) => { v.canvas.gizmo.pointerHit.buttons = 1 },
  ]) assertHandleRejected(change)
})

test('GH4 rejects stale or nonfinite sequence and render frame evidence', () => {
  for (const change of [
    (v) => { v.canvas.gizmo.pointerHit.sequence = 40 },
    (v) => { v.canvas.gizmo.pointerHit.sequence = NaN },
    (v) => { v.canvas.gizmo.pointerHit.frame = 9 },
    (v) => { v.canvas.gizmo.pointerHit.frame = null },
    (v) => { v.canvas.frame = 11 },
    (v) => { v.canvas.frame = Infinity },
  ]) assertHandleRejected(change)
})

test('GH5 rejects changed control actor Canvas project scene revision or pending owner', () => {
  for (const change of [
    (v) => { v.canvas.gizmo.controlUuid = 'control:other' },
    (v) => { v.canvas.gizmo.objectUuid = 'actor:other' },
    (v) => { v.canvas.gizmo.entityId = 'scene:first:model-a' },
    (v) => { v.canvas.canvasUuid = 'canvas:other' },
    (v) => { v.editor.projectKey = 'world:other' },
    (v) => { v.editor.activeSceneId = 'scene:second' },
    (v) => { v.editor.session.snapshot.project.revision += 1 },
    (v) => { v.statuses = [] },
    (v) => { v.selection.ids.push('scene:first:model-a') },
  ]) assertHandleRejected(change)
})

test('GH6 rejects disabled or missing enabled observation rather than calling noninteraction denial', () => {
  for (const change of [
    (v) => { v.canvas.gizmo.enabled = false },
    (v) => { delete v.canvas.gizmo.enabled },
    (v, c) => { c.canvas.gizmo.enabled = false },
  ]) assertHandleRejected(change)
})

test('GH7 rejects camera rendered model session lifecycle and context leakage before down', () => {
  for (const change of [
    (v) => { v.canvas.camera[0] += 1 },
    (v) => { v.canvas.models[0].transform.position[1] += 1 },
    (v) => { v.canvas.models[1].matrixWorld[0] += 1 },
    (v) => { v.editor.session.receipts.push({}) },
    (v) => { v.editor.lifecycle = 'ready' },
    (v) => { v.canvas.contextLost = true },
    (v) => { v.canvas.gizmo.dragging = true },
  ]) assertHandleRejected(change)
})

// Real Three geometry faults at the input boundary; no mocked raycaster or product core.
class TrackedPickerGeometry extends BufferGeometry {
  constructor(sourceIndex, state, shape) { super(); this.copy(shape); this.sourceIndex = sourceIndex; this.state = state }
  clone() {
    const state = this.state
    if (state.stage === 'clone' && this.sourceIndex === 1) throw state.primary
    const copy = new BufferGeometry().copy(this), index = state.returned.length
    state.returned.push(copy); state.disposed.push(0)
    copy.addEventListener('dispose', () => { state.disposed[index] += 1; if (state.stage === 'cleanup' && index === 0) throw state.cleanup })
    if (this.sourceIndex === 1 && ['mesh', 'raycast'].includes(state.stage)) Object.defineProperty(copy,
      state.stage === 'mesh' ? 'morphAttributes' : 'boundingSphere', { get() { throw state.primary } })
    return copy
  }
}
function scratchPickerFixture(stage = 'normal') {
  const state = { stage, primary: new Error('Original picker source failure'), cleanup: new Error('Scratch disposal listener failed'), returned: [], disposed: [], active: false, sourceDisposals: 0 }
  const shape = new BoxGeometry(1, 1, 1), material = new MeshBasicMaterial(), picker = new Group()
  const sources = [0, 1].map((index) => {
    const geometry = new TrackedPickerGeometry(index, state, shape), mesh = new Mesh(geometry, material)
    geometry.addEventListener('dispose', () => { state.sourceDisposals += 1 })
    mesh.name = index === 0 ? 'Y' : 'X'; mesh.matrixWorld.makeTranslation(index * 3, 0, -5); picker.add(mesh)
    return mesh
  })
  shape.dispose()
  if (stage === 'matrix') {
    const elements = sources[1].matrixWorld.elements
    Object.defineProperty(sources[1].matrixWorld, 'elements', { get() { if (state.active) throw state.primary; return elements } })
  }
  const camera = new PerspectiveCamera(50, 1, 0.1, 50), viewport = { x: 0, y: 0, width: 100, height: 100 }
  const sourceState = () => sources.map((mesh) => ({ uuid: mesh.uuid, geometry: mesh.geometry.toJSON(), matrix: [...mesh.matrixWorld.elements], material: mesh.material.toJSON() }))
  const before = sourceState(), cameraBefore = [...camera.matrixWorld.elements, ...camera.projectionMatrix.elements]
  return { state, picker, sources, camera, viewport,
    assertReadOnly() { assert.deepEqual(sourceState(), before); assert.deepEqual([...camera.matrixWorld.elements, ...camera.projectionMatrix.elements], cameraBefore); assert.equal(state.sourceDisposals, 0); assert.deepEqual(picker.children, sources) },
    release() { for (const source of sources) source.geometry.dispose(); material.dispose() },
  }
}

test('GS1 actual scratch raycast retains first axis picker UUID and read-only source ownership', () => {
  const fixture = scratchPickerFixture()
  try {
    const result = withPickerScratch(fixture.picker, fixture.camera, fixture.viewport, (scratch, sourceByScratch, hitAt) => {
      assert.equal(scratch.length, 2)
      const hit = hitAt({ x: 50, y: 50 })
      return { axis: hit?.object.name, pickerUuid: sourceByScratch.get(hit?.object)?.uuid }
    })
    assert.deepEqual(result, { axis: 'Y', pickerUuid: fixture.sources[0].uuid })
    assert.deepEqual(fixture.state.disposed, [1, 1]); fixture.assertReadOnly()
  } finally { fixture.release() }
})

test('GS2 every returned clone is disposed on later clone Mesh matrix raycast or cleanup failure', () => {
  for (const stage of ['clone', 'mesh', 'matrix', 'raycast', 'cleanup']) {
    const fixture = scratchPickerFixture(stage)
    try {
      let observed
      fixture.state.active = true
      try { withPickerScratch(fixture.picker, fixture.camera, fixture.viewport, (_scratch, _sources, hitAt) => { hitAt({ x: 50, y: 50 }); if (stage === 'cleanup') throw fixture.state.primary }) }
      catch (error) { observed = error }
      finally { fixture.state.active = false }
      assert.deepEqual(fixture.state.disposed, fixture.state.returned.map(() => 1), 'Every successfully returned owned geometry clone must receive disposal')
      assert.equal(observed, fixture.state.primary, 'Cleanup must preserve the original source exception')
      fixture.assertReadOnly()
    } finally { fixture.release() }
  }
})

function reopenedVisualWitness() {
  const camera = new PerspectiveCamera(45, 1, 0.1, 50)
  camera.position.set(0, 0, 5); camera.updateMatrixWorld()
  const corners = []
  for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) {
    const world = new Vector3(x, y, z), ndc = world.clone().project(camera)
    corners.push({ world: world.toArray(), ndc: ndc.toArray(), depth: -world.clone().applyMatrix4(camera.matrixWorldInverse).z })
  }
  return {
    shot: { width: 100, height: 100, pixels: Buffer.alloc(100 * 100 * 4, 200) },
    view: { canvas: { rect: { x: 0, y: 0, width: 100, height: 100 },
      camera: [...camera.matrixWorld.elements, ...camera.projectionMatrix.elements],
      cameraFraming: { uuid: camera.uuid, near: camera.near, far: camera.far, matrixWorldInverse: [...camera.matrixWorldInverse.elements] },
      models: [{ entityId: 'scene:second:model-a', uuid: 'actual:root', visible: true, meshes: 1, triangles: 12,
        bounds: { x: 30, y: 30, width: 40, height: 40 }, worldCorners: corners }] } },
    id: 'scene:second:model-a',
  }
}

test('RF1 final reopened-scene visual seam accepts all eight healthy actual-camera corners and retains pixel proof', () => {
  const { shot, view, id } = reopenedVisualWitness()
  assert.equal(assertReopenedAuthoringVisual(shot, view, id), 1600)
  assert.throws(() => assertReopenedAuthoringVisual({ ...shot, pixels: Buffer.alloc(shot.pixels.length) }, view, id), /Screenshot lacks actual neutral model pixels/)
})

test('RF2 final reopened-scene visual seam rejects historical clipped XY despite enough neutral pixels', () => {
  for (const [axis, value] of [[0, -1.5], [0, 1.05], [1, -1.1], [1, 1.8], [0, 0.93]]) {
    const { shot, view, id } = reopenedVisualWitness()
    view.canvas.models[0].worldCorners[7].ndc[axis] = value
    assert.throws(() => assertReopenedAuthoringVisual(shot, view, id), /padded viewport/)
  }
})

test('RF3 final reopened-scene visual seam rejects behind-camera near far or clip-depth corners', () => {
  for (const change of [
    (c) => { c.depth = -5 }, (c) => { c.depth = 0 }, (c) => { c.depth = 0.05 },
    (c) => { c.depth = 51 }, (c) => { c.ndc[2] = -1.01 }, (c) => { c.ndc[2] = 1.01 },
  ]) {
    const { shot, view, id } = reopenedVisualWitness()
    change(view.canvas.models[0].worldCorners[7])
    assert.throws(() => assertReopenedAuthoringVisual(shot, view, id), /camera depth|clip depth/)
  }
})

test('RF4 final reopened-scene visual seam rejects missing nonfinite corners or malformed actual-camera witnesses', () => {
  for (const change of [
    (v) => { delete v.canvas.models[0].worldCorners }, (v) => { v.canvas.models[0].worldCorners.pop() },
    (v) => { v.canvas.models[0].worldCorners[7].world[0] = Infinity },
    (v) => { v.canvas.models[0].worldCorners[7].ndc[1] = NaN },
    (v) => { v.canvas.models[0].worldCorners[7].depth = Infinity },
    (v) => { v.canvas.models[0].worldCorners[7].ndc.pop() },
    (v) => { delete v.canvas.cameraFraming }, (v) => { v.canvas.cameraFraming.near = 0 },
    (v) => { v.canvas.cameraFraming.far = NaN }, (v) => { v.canvas.cameraFraming.far = 0.05 },
    (v) => { v.canvas.cameraFraming.matrixWorldInverse[4] = Infinity },
    (v) => { v.canvas.camera[31] = NaN }, (v) => { v.canvas.rect.width = 0 },
  ]) {
    const { shot, view, id } = reopenedVisualWitness()
    change(view)
    assert.throws(() => assertReopenedAuthoringVisual(shot, view, id), /corners|finite|camera|viewport/)
  }
})

// Local-AI admission is pure policy/source-body evidence, NEVER an ASGI or provider test.
test('AI1 build admission explicitly opts into manifest-bound canonical AI without selecting a model', () => {
  assert.deepEqual(parseBuildArguments([]), { buildOnly: true, nativeMode: 'owned-xvfb' })
  let parsed
  assert.doesNotThrow(() => { parsed = parseBuildArguments(['--build-only', '--inherited-display', '--local-ai']) })
  assert.equal(parsed.runtimeMode, 'local-ai')
  assert.equal(parsed.localAi.ollamaUrl, 'http://127.0.0.1:11434')
  assert.equal(Object.hasOwn(parsed.localAi, 'model'), false)
  assert.equal(parsed.localAi.mainWatchdogSeconds, 420)
  assert.equal(parsed.localAi.runnerWatchdogSeconds, 430)
  assert.equal(parsed.localAi.outerSeconds, 450)
  const reviewed = { name: 'reviewed-existing:tag', digest: `sha256:${'b'.repeat(64)}`, toolsReviewed: true }
  const identityArgs = [`--ai-model=${reviewed.name}`, `--ai-model-digest=${reviewed.digest}`, '--ai-tools-reviewed']
  const admitted = parseBuildArguments(['--inherited-display', '--local-ai', ...identityArgs])
  assert.deepEqual(admitted.reviewedAiModel, reviewed); assert.equal(Object.isFrozen(admitted.reviewedAiModel), true)
  assert.equal(Object.hasOwn(parsed, 'reviewedAiModel'), false, 'Mode-only parsing remains non-selecting; actual build requires identity separately')
  for (const args of [['--inherited-display', '--local-ai', identityArgs[0]], ['--inherited-display', ...identityArgs], ['--inherited-display', '--local-ai', ...identityArgs, identityArgs[0]], ['--inherited-display', '--local-ai', identityArgs[0], '--ai-model-digest=bad', '--ai-tools-reviewed']]) assert.throws(() => parseBuildArguments(args))
  for (const value of [null, { ...reviewed, toolsReviewed: false }, { ...reviewed, unknown: true }, { ...reviewed, name: ' padded ' }]) assert.throws(() => aiPolicies.parseReviewedAiModel(value))
  for (const args of [['--local-ai'], ['--inherited-display', '--local-ai', '--local-ai'], ['--inherited-display', '--local-ai=http://evil'], ['--model=hidden']]) assert.throws(() => parseBuildArguments(args))
  const config = parsed.localAi
  const roots = aiPolicies.localAiEnvironment('/tmp/owned/run-a')
  assert.equal(roots.MODLY_AGENT_OLLAMA_ROUND_DEADLINE_SECONDS, '60')
  assert.equal(roots.HOME, '/tmp/owned/run-a/api-home')
  for (const secret of ['HF_TOKEN', 'OPENAI_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_OPTIONS', 'PYTHONPATH']) assert.equal(Object.hasOwn(roots, secret), false)
  assert.equal(roots.EXTENSIONS_DIR, '/tmp/owned/run-a/empty-extensions')
  assert.deepEqual(config, canonicalLocalAiConfig)
  assert.equal(aiPolicies.validateLocalAiConfig(config, canonicalLocalAiConfig), config)
  for (const change of [{ ollamaUrl: 'http://localhost:11434' }, { roundSeconds: 1800 }, { pythonPath: '/usr/bin/python3.12' }, { model: 'hidden' }]) assert.throws(() => aiPolicies.validateLocalAiConfig({ ...config, ...change }, canonicalLocalAiConfig))
  const args = aiPolicies.localAiPythonArguments(config)
  assert.deepEqual(args.slice(0, 6), ['-I', '-B', '-m', 'uvicorn', 'main:app', '--app-dir'])
  assert.equal(args[6], config.apiRoot)
  assert.equal(args[args.indexOf('--port') + 1], '0')
})

test('AI1P local-AI paths materialize only from a canonical relocated repository root', () => {
  const relocated = '/tmp/relocated-modly'
  assert.deepEqual(materializeLocalAiConfig(relocated), {
    apiRoot: '/tmp/relocated-modly/api',
    pythonPath: '/tmp/relocated-modly/api/.venv/bin/python',
    ...aiPolicies.LOCAL_AI_PROFILE,
  })
  for (const root of ['relative/root', '/tmp/../tmp/relocated-modly', '/tmp/relocated-modly\0']) {
    assert.throws(() => materializeLocalAiConfig(root), /repository|root|path/i)
  }
  for (const admission of [
    { ...aiPolicies.LOCAL_AI_PATH_ADMISSION, apiRootRelative: '/outside' },
    { ...aiPolicies.LOCAL_AI_PATH_ADMISSION, apiRootRelative: '../outside' },
    { ...aiPolicies.LOCAL_AI_PATH_ADMISSION, pythonPathRelative: 'api/../../outside' },
    { ...aiPolicies.LOCAL_AI_PATH_ADMISSION, pythonPathRelative: 'api/.venv/bin/python\0' },
    { ...aiPolicies.LOCAL_AI_PATH_ADMISSION, extra: true },
  ]) assert.throws(() => materializeLocalAiConfig(relocated, admission), /admission|path|relative/i)
})

test('AI2 runner admission forwards exactly the reviewed runtime mode and reserves its owned environment', () => {
  const reviewed = `--reviewed-build-sha256=${'a'.repeat(64)}`
  assert.deepEqual(parseRunArguments([reviewed, '--inherited-display', '--local-ai']), { buildSha256: 'a'.repeat(64), mode: 'inherited-display', runtimeMode: 'local-ai' })
  for (const args of [[reviewed, '--local-ai'], [reviewed, '--inherited-display', '--local-ai', '--local-ai'], [reviewed, '--local-ai', '--inherited-display']]) assert.throws(() => parseRunArguments(args))
  const admission = { root: canonicalRoot }
  assert.equal(validateRunnerLocalAiConfig(canonicalLocalAiConfig, admission), canonicalLocalAiConfig)
  for (const changed of [
    { ...canonicalLocalAiConfig, apiRoot: '/tmp/other/api' },
    { ...canonicalLocalAiConfig, pythonPath: '/usr/bin/python3' },
  ]) assert.throws(() => validateRunnerLocalAiConfig(changed, admission), /local-ai|path/i)
})

test('P1 repository admissions bind relocated main and runner consumers before source reads or spawning', async () => {
  const head = '2111f62cf2042e8ca8826f2e5dc99e3bd8dc9b61', branch = 'codex/worlds-engine'
  const admission = { schema: 'modly.worlds-authoring-repository-admission.v1', root: canonicalRoot, head, branch }
  assert.equal(aiPolicies.validateRepositoryAdmission(admission, canonicalRoot, head, branch), admission)
  for (const mutate of [
    (copy) => { copy.schema = 'forged' }, (copy) => { copy.root = '/tmp/other-root' },
    (copy) => { copy.root = 'relative/root' }, (copy) => { copy.root = `${canonicalRoot}\0` },
    (copy) => { copy.head = '0'.repeat(40) }, (copy) => { copy.branch = 'main' },
    (copy) => { copy.extra = true }, (copy) => { delete copy.root },
  ]) {
    const changed = structuredClone(admission); mutate(changed)
    assert.throws(() => aiPolicies.validateRepositoryAdmission(changed, canonicalRoot, head, branch), /repository admission/i)
  }
  const receipt = { bytes: 7, sha256: 'a'.repeat(64) }
  const runnerBuild = {
    repositoryRoot: canonicalRoot, repositoryAdmission: admission, initialHead: head, initialBranch: branch,
    outputs: { 'run.mjs': receipt },
    sourceInputs: [{ path: path.join(canonicalRoot, 'scripts/worlds-authoring-electron-fixture/run.mjs'), ...receipt }],
  }
  assert.equal(validateRunnerRepositoryAdmission(runnerBuild), admission)
  for (const mutate of [
    (copy) => { copy.repositoryAdmission.schema = 'forged' },
    (copy) => { copy.repositoryAdmission.root = '/tmp/other-root' },
    (copy) => { copy.repositoryAdmission.root = `${canonicalRoot}\0` },
    (copy) => { copy.repositoryAdmission.head = '0'.repeat(40) },
    (copy) => { copy.repositoryAdmission.branch = 'main' },
    (copy) => { copy.repositoryAdmission.extra = true },
    (copy) => { copy.sourceInputs = [] },
    (copy) => { copy.sourceInputs[0].path = path.join(canonicalRoot, 'scripts/other-run.mjs') },
    (copy) => { copy.sourceInputs[0].bytes += 1 },
    (copy) => { copy.sourceInputs[0].sha256 = 'b'.repeat(64) },
  ]) {
    const changed = structuredClone(runnerBuild); mutate(changed)
    assert.throws(() => validateRunnerRepositoryAdmission(changed), /repository|source|runner/i)
  }
  const runnerSource = await readFile(new URL('./run.mjs', import.meta.url), 'utf8')
  const admissionGate = runnerSource.indexOf('const repositoryAdmission = validateRunnerRepositoryAdmission(build)')
  assert.ok(admissionGate >= 0 && admissionGate < runnerSource.indexOf('for (const [relative, expected] of Object.entries(build.outputs))'))
  assert.ok(admissionGate < runnerSource.indexOf("open(path.join(bundle, 'run-consumed.json')"))
  const mainSource = await readFile(new URL('./main.ts', import.meta.url), 'utf8')
  const mainAdmissionGate = mainSource.indexOf('const repositoryAdmission = validateRepositoryAdmission(')
  assert.ok(mainAdmissionGate >= 0 && mainAdmissionGate < mainSource.indexOf('const verifySources = () => {'))
  assert.ok(mainAdmissionGate < mainSource.indexOf('spawn(localAi.pythonPath'))
})

test('AI3 inherited display cannot override owned local-AI config even when the default lane is selected', () => {
  for (const field of ['WORLD_AUTHORING_RUNTIME_MODE', 'WORLD_AUTHORING_LOCAL_AI_CONFIG']) assert.throws(() => inheritedDisplayEnvironment({ DISPLAY: ':1', [field]: 'injected' }, '/tmp/owned/run', 'a'.repeat(64)), /reserved/)
})

test('AI4 actual session network callback admits only exact same-origin local agent routes', async () => {
  const source = await readFile(new URL('./main.ts', import.meta.url), 'utf8')
  const body = source.match(/isolatedSession\.webRequest\.onBeforeRequest\(\(details, callback\) => \{([\s\S]*?)\n  \}\)/)?.[1]
  assert.ok(body, 'Existing actual session callback must remain source-qualified')
  const callback = new Function('details', 'callback', 'allowed', 'network', 'now', 'fail', 'localAi', 'origin', 'isLocalAiRoute', body)
  const origin = 'http://127.0.0.1:32123', models = `${origin}/agent/models?ollama_url=http%3A%2F%2F127.0.0.1%3A11434`
  const allowed = new Set([`${origin}/index.html`]), observed = [], failures = []
  let admitted
  assert.doesNotThrow(() => { admitted = parseBuildArguments(['--inherited-display', '--local-ai']).localAi })
  const check = (url, method, enabled) => { let cancelled; callback({ url, method, webContentsId: 1 }, (value) => { cancelled = value.cancel }, allowed, observed, () => 'observed', (error) => failures.push(error), enabled ? admitted : null, origin, aiPolicies.isLocalAiRoute); return !cancelled }
  assert.equal(check(models, 'GET', true), true)
  assert.equal(check(`${origin}/agent/chat`, 'POST', true), true)
  assert.equal(check(`${origin}/index.html`, 'GET', false), true)
  for (const [url, method] of [[models, 'POST'], [`${origin}/agent/chat`, 'GET'], [`${origin}/agent/chat?extra=1`, 'POST'], [`${origin}/agent/models?ollama_url=http://evil`, 'GET'], ['http://127.0.0.1:11434/api/chat', 'POST'], [`${origin}/model/download`, 'POST']]) assert.equal(check(url, method, true), false)
  assert.equal(check(models, 'GET', false), false)
  const headers = { host: origin.slice(7), referer: `${origin}/index.html`, origin, 'content-type': 'application/json', 'content-length': '128', 'sec-fetch-site': 'same-origin' }
  assert.equal(aiPolicies.isLocalAiHttpRequest('POST', '/agent/chat', headers, origin, `${origin}/index.html`), true)
  for (const changed of [{ authorization: 'secret' }, { cookie: 'user-global' }, { 'x-provider-key': 'secret' }, { 'transfer-encoding': 'chunked' }, { host: 'evil' }, { origin: 'http://evil' }, { referer: `${origin}/other` }, { 'sec-fetch-site': 'cross-site' }]) assert.equal(aiPolicies.isLocalAiHttpRequest('POST', '/agent/chat', { ...headers, ...changed }, origin, `${origin}/index.html`), false)
})

test('AI5 exact narrowed production preload session channel set rejects broader session privileges', async () => {
  const source = await readFile(new URL('./preload.ts', import.meta.url), 'utf8')
  const expression = source.match(/const known = (new Set<string>\([^\n]+\))/)?.[1]
  assert.ok(expression, 'Existing production preload channel seam is required')
  const known = new Function('WORLD_PROJECT_CHANNELS', 'LOCAL_AI_SESSION_METHODS', `return ${expression.replace('new Set<string>', 'new Set')}`)({}, ['list', 'create', 'read', 'activate', 'appendMessage'])
  assert.equal(known.has('agentSessions:list'), true)
  for (const method of ['create', 'read', 'activate', 'appendMessage']) assert.equal(known.has(`agentSessions:${method}`), true)
  for (const method of ['rename', 'delete', 'addAttachment', 'readAttachment', 'removeAttachment']) assert.equal(known.has(`agentSessions:${method}`), false)
})

test('AI6 bounded canonical chat policy binds discovered model digest and real captured context only', () => {
  // The positive admission assertion precedes prospective policy use: RED must be semantic, never missing imports.
  let config
  assert.doesNotThrow(() => { config = parseBuildArguments(['--inherited-display', '--local-ai']).localAi })
  const context = { schema: 'modly.world-ai-context.v1', projectKey: `world-${'a'.repeat(32)}`, projectId: 'project:observed', activeSceneId: 'scene:observed', baseRevision: 1, editorEpoch: 2, originSessionId: 'session:observed', requestId: 'request:observed' }
  const body = { messages: [{ role: 'user', content: 'Observed prompt' }], model: 'actual-existing:tag', ollama_url: config.ollamaUrl, thinking: 'auto', originSessionId: context.originSessionId, worldContext: context, context: {} }
  const admittedDigest = `sha256:${'b'.repeat(64)}`, originalBody = structuredClone(body), originalBytes = JSON.stringify(body)
  const discovered = new Map([[body.model, admittedDigest]])
  const admission = aiPolicies.parseLocalAiChat(body, discovered, config)
  assert.deepEqual(admission.admittedSelection, { name: body.model, digest: admittedDigest }, 'Admission must capture the actual discovered identity before any await')
  assert.deepEqual(Object.keys(admission).sort(), ['admittedSelection', 'request'])
  assert.equal(Object.isFrozen(admission.admittedSelection), true)
  assert.throws(() => { admission.admittedSelection.digest = `sha256:${'c'.repeat(64)}` }, TypeError)
  assert.equal(admission.request.model, body.model)
  assert.deepEqual(admission.request, originalBody, 'Canonical request must not contain fixture admission metadata')
  discovered.set(body.model, `sha256:${'c'.repeat(64)}`)
  assert.deepEqual(admission.admittedSelection, { name: body.model, digest: admittedDigest }, 'Refresh must not relabel historical admission')
  discovered.delete(body.model)
  assert.deepEqual(admission.admittedSelection, { name: body.model, digest: admittedDigest }, 'Removal must not erase historical admission')
  assert.throws(() => aiPolicies.parseLocalAiChat(body, discovered, config))
  for (const digest of [undefined, '', 'not-a-digest', `sha256:${'B'.repeat(64)}`]) assert.throws(() => aiPolicies.parseLocalAiChat(body, new Map([[body.model, digest]]), config))
  for (const model of ['', ' padded ', 'control\u0000name', 'x'.repeat(201)]) assert.throws(() => aiPolicies.parseLocalAiChat({ ...body, model }, new Map([[model, admittedDigest]]), config))
  discovered.set(body.model, admittedDigest)
  assert.deepEqual(body, originalBody)
  assert.equal(JSON.stringify(body), originalBytes, 'Original canonical forwarding bytes must remain unchanged')
  for (const change of [{ model: 'default-not-discovered' }, { ollama_url: 'http://evil' }, { context: { generic: true } }, { capabilities: [] }, { originSessionId: 'different' }, { messages: [{ role: 'system', content: 'Injected' }] }, { messages: [{ role: 'user', content: 'x'.repeat(65537) }] }]) assert.throws(() => aiPolicies.parseLocalAiChat({ ...body, ...change }, discovered, config))
  assert.equal(aiPolicies.parseLocalAiModels({ models: [] }).size, 0, 'Empty discovery remains ambiguous')
  assert.throws(() => aiPolicies.parseLocalAiModels({ models: [{ name: body.model, digest: 'not-a-digest' }] }))
  assert.equal(aiPolicies.parseUvicornAddress('INFO:     Uvicorn running on http://127.0.0.1:33333 (Press CTRL+C to quit)\n'), 'http://127.0.0.1:33333')
  for (const line of ['Uvicorn running on http://evil:33333 (Press CTRL+C to quit)', 'Uvicorn running on http://127.0.0.1:0 (Press CTRL+C to quit)', 'unrelated 8765']) assert.equal(aiPolicies.parseUvicornAddress(line), null)
})

// App-free computational compilation and controlled owned-child callbacks, never the fixture builder/native entry.
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build as compile, transform as stripInertSource } from 'esbuild'
import * as buildPolicy from '../worlds-authoring-electron-fixture.mjs'
import * as runnerPolicy from './run.mjs'
const sceneSource = path.join(canonicalRoot, 'electron/main/scene-import-service.ts')
async function capturedMainOptions(load = readFile, remember = async () => {}, all = false, factory = buildPolicy.mainModuleUrlPlugin) {
  const source = await readFile(new URL('../worlds-authoring-electron-fixture.mjs', import.meta.url), 'utf8')
  const body = source.match(/    const common = [\s\S]*?(?=    for \(const built of builds\))/)?.[0]
  assert.ok(body, 'Existing actual common/main compilation seam must remain source-qualified')
  const capture = new Function('esbuild', 'path', 'fixtureSource', 'outputDirectory', 'mainModuleUrlPlugin', 'remember', 'mainTranslationWarnings', `return (async () => { ${body}; return builds })()`)
  const options = await capture((value) => value, path, path.join(canonicalRoot, 'scripts/worlds-authoring-electron-fixture'), evidenceRoot,
    factory && ((remember, warnings, _defaultLoad, translate) => factory(remember, warnings, load, translate)), remember, [])
  assert.equal(options[0].format, 'cjs'); assert.equal(options[0].platform, 'node')
  assert.equal(options[1].platform, 'browser')
  assert.equal((options[1].plugins ?? []).some((plugin) => plugin.name === 'worlds-authoring-main-source-module-url'), false, 'Preload must not receive main URL translation')
  return all ? options : options[0]
}
async function compileSceneProbe(extra) {
  const source = await readFile(sceneSource, 'utf8')
  const load = async (filename, encoding) => filename === sceneSource ? `${source}\n${extra}\n` : readFile(filename, encoding)
  const options = await capturedMainOptions(load)
  const fallbackProbe = { name: 'unit-only-append-inert-probe', setup(build) { build.onLoad({ filter: /scene-import-service\.ts$/ }, async (args) => ({ contents: await load(args.path, 'utf8'), loader: 'ts', resolveDir: path.dirname(args.path) })) } }
  const result = await compile({ ...options, entryPoints: [sceneSource], outfile: path.join(evidenceRoot, 'focused-main.cjs'), write: false, plugins: [...(options.plugins ?? []), fallbackProbe] })
  process.stdout.write(`Focused main compiler warnings: ${JSON.stringify(result.warnings)}\n`)
  return result
}
test('ML1 actual main CJS options retain canonical scene module URL and Node resolution at inert initialization', async () => {
  const result = await compileSceneProbe("export const ownedModuleProbe = { url: import.meta.url, electron: require.resolve('electron'), settings: require.resolve('./settings-store.ts'), embedded: 'createRequire(import.meta.url)' }")
  const module = { exports: {} }, require = createRequire(sceneSource)
  assert.doesNotThrow(() => new Function('require', 'module', 'exports', '__filename', '__dirname', result.outputFiles[0].text)(require, module, module.exports, path.join(evidenceRoot, 'focused-main.cjs'), evidenceRoot), 'Actual canonical top-level createRequire must initialize before any fixture watchdog')
  assert.deepEqual(module.exports.ownedModuleProbe, { url: pathToFileURL(sceneSource).href, electron: require.resolve('electron'), settings: require.resolve('./settings-store.ts'), embedded: 'createRequire(import.meta.url)' })
})
test('ML2 actual main parser rejects unsupported module metadata without altering embedded worker program text', async () => {
  await assert.rejects(() => compileSceneProbe('export const unsupportedProbe = import.meta.resolve'), /Unsupported main import\.meta semantics/)
})
test('ML3 actual manifest constructor retains qualified successful compiler warnings without adding output owners', async () => {
  const source = await readFile(new URL('../worlds-authoring-electron-fixture.mjs', import.meta.url), 'utf8')
  const expression = source.match(/    const manifest = ([\s\S]*?)\n    const manifestBytes/)?.[1]
  assert.ok(expression, 'Existing actual manifest construction seam is required')
  const warnings = [{ id: 'qualified-warning', text: 'Actual returned warning', location: { file: sceneSource, line: 9, column: 0 }, notes: [], detail: undefined }]
  const names = ['localAi', 'worldSculpt', 'nativeMode', 'repositoryRoot', 'repositoryAdmission', 'outputDirectory', 'initialHead', 'initialBranch', 'nodePath', 'electronPath', 'versions', 'outputs', 'sources', 'incidentalArtifacts', 'moduleGraphs', 'renderer', 'builds', 'mainTranslationWarnings']
  const admission = { schema: 'modly.worlds-authoring-repository-admission.v1', root: canonicalRoot, head: 'head', branch: 'branch' }
  const manifest = new Function(...names, `return (${expression})`)(null, null, 'owned-xvfb', canonicalRoot, admission, evidenceRoot, 'head', 'branch', '/node', '/electron', {}, { 'main.cjs': {} }, new Map(), new Map(), [], { plugins: [], worker: { plugins: () => [] } }, [{ warnings }, { warnings: [] }], [])
  assert.deepEqual(manifest.compilerDiagnostics, { schema: 'modly.worlds-authoring-compiler-diagnostics.v1', esbuild: [{ entry: 'main', warnings }, { entry: 'preload', warnings: [] }], mainTranslationWarnings: [] })
  assert.deepEqual(Object.keys(manifest.outputs), ['main.cjs'])
})
test('ML4 actual owned child callbacks retain split fatal CRLF bytes before one scoped interrupt and clean listeners', async () => {
  const source = await readFile(new URL('./run.mjs', import.meta.url), 'utf8')
  const body = source.match(/async function child\([\s\S]*?(?=async function manifest)/)?.[0]
  assert.ok(body, 'Existing actual owned-child source-body seam is required')
  const make = new Function('failed', 'stopping', 'open', 'path', 'runDirectory', 'spawn', 'localAi', 'interrupt', 'owned', 'events', 'installOwnedFatalGate', `${body}; return child`)
  const instance = new EventEmitter(); instance.pid = 123; instance.stdout = new EventEmitter(); instance.stderr = new EventEmitter()
  const raw = [], interrupted = [], owned = []
  const handles = new Map()
  const open = async (filename) => { const handle = { write: async (bytes, offset = 0, length = bytes.length) => { if (filename.endsWith('stderr.log')) raw.push(Buffer.from(bytes.subarray(offset, offset + length))); return { bytesWritten: length } }, close: async () => {} }; handles.set(filename, handle); return handle }
  const child = make(null, false, open, path, evidenceRoot, () => instance, canonicalLocalAiConfig, (message) => interrupted.push({ message, raw: Buffer.concat(raw).toString('utf8') }), owned, [], runnerPolicy.installOwnedFatalGate)
  const entry = await child('electron', '/owned/electron', [], {})
  for (const chunk of ['WARNING error: retained\r\n', 'Not App threw an error during load\n', 'App threw an er', 'ror during load\r', '\n', 'App threw an error during load\r\n']) instance.stderr.emit('data', Buffer.from(chunk))
  await entry.logWrites; await Promise.resolve()
  assert.equal(interrupted.length, 1, 'Exact authoritative complete fatal line must interrupt once, never wait430 seconds')
  assert.match(interrupted[0].raw, /App threw an error during load\r\n/, 'Original fatal bytes must be retained before owned interrupt')
  assert.match(Buffer.concat(raw).toString('utf8'), /^WARNING error: retained\r\nNot App threw an error during load\n/)
  instance.emit('exit', 0, null); instance.stdout.emit('close'); instance.stderr.emit('close')
  await entry.done; await entry.logWrites
  assert.equal(instance.stderr.listenerCount('data'), 0); assert.equal(instance.stdout.listenerCount('data'), 0)
  assert.equal(instance.stderr.listenerCount('close'), 0); assert.equal(instance.stdout.listenerCount('close'), 0)
  assert.equal(owned.length, 1); assert.equal(owned[0], entry)
})

function controlledOwnedLogs(write, interrupt) {
  const entry = { name: 'electron', child: { pid: 123, stdout: new EventEmitter(), stderr: new EventEmitter() }, done: Promise.resolve(), logWrites: Promise.resolve() }
  entry.stdout = { write, close: async () => { entry.handlesClosed = true } }; entry.stderr = entry.stdout
  runnerPolicy.installOwnedFatalGate(entry, interrupt, 1048576)
  return entry
}
async function captureOwnedLogCleanup() {
  const source = await readFile(new URL('./run.mjs', import.meta.url), 'utf8')
  const body = source.match(/    for \(const entry of owned\) \{[\s\S]*?\n    \}\n  \} catch/)?.[0].replace(/\n  \} catch$/, '')
  assert.ok(body, 'Existing actual owned cleanup loop is required')
  return async (entry) => {
    const errors = [], events = []
    await new Function('owned', 'pause', 'groupAlive', 'events', 'recordFailure', `return (async () => { let failed = null; ${body} })()`)([entry], () => Promise.resolve(), () => false, events, (error) => errors.push(String(error)))
    return { errors, events }
  }
}
for (const mode of ['fatal', 'rejected-write', 'invalid-progress']) test(`ML5 ${mode} log failure retains throwing interrupt as secondary without rejecting the owned queue`, async () => {
  const notifications = [], killError = new Error('Controlled owned termination race')
  const entry = controlledOwnedLogs(async (_bytes, _offset, length) => {
    if (mode === 'rejected-write') throw new Error('Controlled original write failure')
    return { bytesWritten: mode === 'invalid-progress' ? 0 : length }
  }, (message) => { notifications.push(message); throw killError })
  entry.child.stderr.emit('data', Buffer.from(mode === 'fatal' ? 'App threw an error during load\n' : 'Original log bytes\n'))
  // Observe baseline immediately too: semantic failure must not become a generic unhandled test-file failure.
  const rejection = await entry.logWrites.then(() => null, (error) => error)
  entry.disposeLogs()
  assert.equal(rejection, null, 'The owned terminal log promise must intrinsically fulfill after retained failures')
  assert.equal(notifications.length, 1)
  assert.ok(entry.logErrors.some((error) => error.operation === 'interrupt' && error.error.includes(killError.message)))
  if (mode !== 'fatal') assert.ok(entry.logErrors.some((error) => error.operation === 'write' && error.error.includes(mode === 'rejected-write' ? 'Controlled original write failure' : 'invalid progress')))
})
test('ML6 actual cleanup closes read admission then drains late split fatal and partial writes before handle closure', async () => {
  const cleanupOwned = await captureOwnedLogCleanup()
  let release, started, first = true, afterClose = 0
  const blocked = new Promise((resolve) => { release = resolve }), writing = new Promise((resolve) => { started = resolve })
  const raw = [], notifications = []
  let entry
  entry = controlledOwnedLogs(async (bytes, offset, length) => {
    if (first) { first = false; started(); await blocked }
    if (entry.handlesClosed) afterClose++
    const count = Math.min(length, 2); raw.push(Buffer.from(bytes.subarray(offset, offset + count))); return { bytesWritten: count }
  }, (message) => notifications.push({ message, raw: Buffer.concat(raw).toString('utf8') }))
  entry.child.stderr.emit('data', Buffer.from('Original prefix\n'))
  await writing
  const cleanup = cleanupOwned(entry)
  await new Promise((resolve) => setImmediate(resolve))
  for (const chunk of ['App threw an er', 'ror during load\r', '\n']) entry.child.stderr.emit('data', Buffer.from(chunk))
  entry.child.stdout.emit('close'); entry.child.stderr.emit('close'); release()
  await cleanup; await entry.logWrites
  assert.equal(afterClose, 0, 'Late accepted writes must complete before handles close')
  assert.equal(Buffer.concat(raw).toString('utf8'), 'Original prefix\nApp threw an error during load\r\n')
  assert.equal(notifications.length, 1); assert.match(notifications[0].raw, /during load\r\n$/)
  assert.equal(entry.child.stderr.listenerCount('data'), 0); assert.equal(entry.child.stderr.listenerCount('close'), 0)
})
test('ML7 actual cleanup bounds unresolved owned pipe closure and retains truthful partial tail evidence', async () => {
  const cleanupOwned = await captureOwnedLogCleanup()
  const raw = [], notifications = []
  const entry = controlledOwnedLogs(async (bytes, offset, length) => { raw.push(Buffer.from(bytes.subarray(offset, offset + length))); return { bytesWritten: length } }, (message) => notifications.push(message))
  const finish = entry.finishLogs
  if (finish) entry.finishLogs = () => finish(5)
  entry.child.stderr.emit('data', Buffer.from('Retained partial tail'))
  await cleanupOwned(entry)
  entry.child.stderr.emit('data', Buffer.from('Not admitted after partial cutoff'))
  await entry.logWrites
  assert.ok(entry.logErrors?.some((error) => error.operation === 'pipe-close' && error.partial === true), 'Open pipes cannot be reported as complete drained logs')
  assert.equal(Buffer.concat(raw).toString('utf8'), 'Retained partial tail'); assert.equal(notifications.length, 1)
  assert.equal(entry.handlesClosed, true); assert.equal(entry.child.stderr.listenerCount('data'), 0)
})

async function inertFunction(source, parameters) {
  const transformed = await stripInertSource(source, { loader: 'ts', target: 'es2022', logLevel: 'silent' })
  assert.deepEqual(transformed.warnings, [], 'Exact inert TypeScript seam must parse without warnings')
  return new Function(...parameters, transformed.code)
}
function oneSeam(source, expression, label) {
  const matches = [...source.matchAll(expression)]
  assert.equal(matches.length, 1, `One exact existing ${label} seam required`)
  return matches[0][1]
}

// Synthetic filesystem doubles ONLY: no authentication path or credential bytes are opened.
const privacyRoot = '/tmp/synthetic-worlds-source-privacy'
const privacyDigest = (bytes) => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
function privacyFilesystem(specs) {
  const entries = new Map(specs.map((spec) => [spec.path, { bytes: Buffer.from('synthetic code control\n'), ...spec }]))
  const reads = [], metadata = []
  const info = (filename) => {
    const entry = entries.get(filename)
    if (!entry) throw Object.assign(new Error('Synthetic path absent'), { code: 'ENOENT' })
    metadata.push({ path: filename, size: entry.bytes.length })
    return { isFile: () => !entry.symlink, isSymbolicLink: () => !!entry.symlink, isDirectory: () => false,
      dev: 1, ino: 2, uid: 1000, mode: 0o100600, size: entry.bytes.length }
  }
  const resolve = (filename) => entries.get(filename)?.resolved ?? filename
  const read = (filename) => {
    reads.push(filename)
    if (entries.get(filename)?.denied) throw new Error('DENIED_SYNTHETIC_READ')
    return entries.get(filename).bytes
  }
  const inventory = specs.map(({ path: filename }) => ({ path: filename, ...privacyDigest(entries.get(filename).bytes) }))
  return { entries, reads, metadata, info, resolve, read, inventory }
}
async function privacyCollector(fs, root = privacyRoot) {
  const source = await readFile(new URL('../worlds-authoring-electron-fixture.mjs', import.meta.url), 'utf8')
  const body = oneSeam(source, /export function createSourceCustody\(root\) \{([\s\S]*?)\n\}\nexport function mainModuleUrlPlugin/g, 'source custody privacy')
  const make = await inertFunction(body, ['root', 'path', 'lstat', 'realpath', 'readFile', 'digest'])
  return make(root, path, async (filename) => fs.info(filename), async (filename) => fs.resolve(filename), async (filename) => fs.read(filename), privacyDigest)
}
async function privacyConsumer(consumer, fs, inventory = fs.inventory, omitInventory = false) {
  const source = await readFile(new URL(consumer === 'main' ? './main.ts' : './run.mjs', import.meta.url), 'utf8')
  const expression = consumer === 'main'
    ? /const verifySources = \(\) => \{([\s\S]*?)\n\}\nfor \(const \[relative, entry\]/g
    : /for \(const \[relative, expected\] of Object.entries\(build.outputs\)\) \{[\s\S]*?\n\}\n([\s\S]*?)\n\/\/ The exclusive marker/g
  const body = oneSeam(source, expression, `${consumer} source input privacy`)
  const repositoryAdmission = { schema: 'modly.worlds-authoring-repository-admission.v1', root: canonicalRoot, head: '3807bb10ca60e071d183a30392e0c0ed1ae7534e', branch: 'codex/worlds-engine' }
  const build = { repositoryRoot: canonicalRoot, repositoryAdmission, ...(omitInventory ? {} : { sourceInputs: inventory }) }
  const digest = (bytes) => privacyDigest(bytes).sha256
  const make = await inertFunction(consumer === 'main' ? body : `return (async () => {${body}})()`,
    consumer === 'main' ? ['build', 'repositoryAdmission', 'assert', 'path', 'lstatSync', 'realpathSync', 'readFileSync', 'hash'] : ['build', 'repositoryAdmission', 'assert', 'path', 'lstat', 'realpath', 'readFile', 'sha'])
  return make(build, repositoryAdmission, assert, path, consumer === 'main' ? fs.info : async (filename) => fs.info(filename),
    consumer === 'main' ? fs.resolve : async (filename) => fs.resolve(filename),
    consumer === 'main' ? fs.read : async (filename) => fs.read(filename), digest)
}
const privacyAuthNames = ['.Xauthority', 'Xauthority', 'private.Xauthority', 'PRIVATE.xAuThOrItY.backup']
for (const name of privacyAuthNames) for (const size of [0, 7]) test(`S4 privacy collector direct ${name} bytes=${size}`, async () => {
  const filename = path.join(privacyRoot, 'src', name), fs = privacyFilesystem([{ path: filename, bytes: Buffer.alloc(size, 0x78), denied: true }])
  assert.equal(fs.info(filename).size, size, 'Empty/nonempty control must vary actual lstat metadata too')
  const custody = await privacyCollector(fs)
  const caught = await custody.remember(filename).then(() => null, (error) => error)
  assert.equal(fs.reads.length, 0, 'Authentication source must reject BEFORE its denied-read sentinel')
  assert.match(caught?.message ?? '', /forbidden.*source input/i, 'Missing authentication source policy')
})
for (const route of ['cached-auth', 'module-auth', 'alias-auth', 'verify-auth', 'enumerated-evidence', 'enumerated-auth-evidence', 'module-evidence', 'cached-evidence', 'verify-evidence']) test(`S4 privacy collector ${route}`, async () => {
  const ordinary = path.join(privacyRoot, 'src/control.ts')
  const forbidden = path.join(privacyRoot, route === 'enumerated-auth-evidence' ? 'docs/worlds-engine-evidence/attempt/private.Xauthority' : route.includes('evidence') ? 'docs/worlds-engine-evidence/attempt/report.md' : 'src/private.Xauthority')
  const alias = path.join(privacyRoot, 'src/alias.ts')
  const fs = privacyFilesystem([{ path: ordinary }, { path: forbidden, denied: true }, { path: alias, resolved: forbidden, denied: true }])
  const custody = await privacyCollector(fs)
  let operation
  if (route.startsWith('cached')) { custody.sources.set(forbidden, fs.inventory[1]); operation = () => custody.remember(forbidden) }
  else if (route.startsWith('module')) operation = () => custody.rememberResolvedModule(`${forbidden}?raw`)
  else if (route.startsWith('alias')) operation = () => custody.remember(alias)
  else if (route.startsWith('verify')) { custody.sources.set(ordinary, fs.inventory[0]); custody.sources.set(forbidden, fs.inventory[1]); operation = () => custody.verifySources() }
  else operation = () => custody.remember(forbidden, { canonicalEnumeration: true })
  const caught = await operation().then(() => null, (error) => error)
  assert.equal(fs.reads.length, 0, 'Complete source policy must precede ANY input read, including ordinary-first verification')
  if (route === 'enumerated-evidence' || route === 'enumerated-auth-evidence') {
    assert.equal(caught, null); assert.equal(custody.sources.size, 0)
    assert.equal(custody.incidentalArtifacts.get(forbidden)?.type, 'regular-file', 'Regular exact evidence must be metadata-only')
  } else assert.match(caught?.message ?? '', /forbidden.*source input/i, 'Missing cached/module/alias/verification source policy')
})
test('S4 privacy collector positive ordinary and evidence-lookalike inputs remain hashed and verified', async () => {
  const fs = privacyFilesystem(['src/control.ts', 'docs/worlds-engine-evidence-lookalike/report.md'].map((relative) => ({ path: path.join(privacyRoot, relative) })))
  const custody = await privacyCollector(fs)
  for (const entry of fs.inventory) await custody.remember(entry.path, { canonicalEnumeration: true })
  await custody.verifySources()
  assert.equal(custody.sources.size, 2); assert.equal(custody.incidentalArtifacts.size, 0); assert.equal(fs.reads.length, 4)
  for (const entry of fs.inventory) assert.deepEqual(custody.sources.get(entry.path), entry)
})
for (const consumer of ['main', 'runner']) {
  const prefix = consumer === 'main' ? 'S5' : 'S6'
  test(`${prefix} privacy ${consumer} positive ordinary and evidence-lookalike inventory`, async () => {
    const fs = privacyFilesystem(['src/control.ts', 'docs/worlds-engine-evidence-lookalike/report.md'].map((relative) => ({ path: path.join(canonicalRoot, relative) })))
    await privacyConsumer(consumer, fs)
    assert.equal(fs.reads.length, 2, 'Positive inventory must be fully read/hash verified')
  })
  const cases = [
    ...privacyAuthNames.flatMap((name) => [0, 7].map((size) => ({ name: `auth ${name} bytes=${size}`, relative: `src/${name}`, size }))),
    { name: 'exact evidence', relative: 'docs/worlds-engine-evidence/attempt/report.md' },
    { name: 'auth realpath alias', relative: 'src/alias.ts', resolved: 'src/private.Xauthority' },
    { name: 'evidence realpath alias', relative: 'src/alias.ts', resolved: 'docs/worlds-engine-evidence/attempt/report.md' },
    { name: 'ordinary realpath alias', relative: 'src/alias.ts', resolved: 'src/target.ts' },
    { name: 'nonregular input', relative: 'src/link.ts', symlink: true },
    { name: 'relative unsafe input', relative: 'src/relative.ts', unsafe: 'src/relative.ts' },
    { name: 'traversal unsafe input', relative: 'src/traversal.ts', unsafe: '/tmp/../tmp/source.ts' },
    { name: 'missing inventory', relative: 'src/control2.ts', inventory: 'missing' },
    { name: 'empty inventory', relative: 'src/control2.ts', inventory: 'empty' },
  ]
  for (const control of cases) test(`${prefix} privacy ${consumer} rejects ${control.name} before ANY input read`, async () => {
    const root = canonicalRoot, ordinary = path.join(root, 'src/control.ts'), forbidden = path.join(root, control.relative)
    const fs = privacyFilesystem([{ path: ordinary }, { path: forbidden, bytes: Buffer.alloc(control.size ?? 7, 0x78), denied: true, symlink: control.symlink,
      ...(control.resolved ? { resolved: path.join(root, control.resolved) } : {}) }])
    let inventory = fs.inventory
    if (control.unsafe) inventory[1].path = control.unsafe
    if (control.inventory === 'missing') inventory = undefined
    if (control.inventory === 'empty') inventory = []
    // Explicit missing inventory cannot use the helper's positive default.
    const actualInventory = control.inventory === 'missing' ? null : inventory
    const caught = await privacyConsumer(consumer, fs, actualInventory, control.inventory === 'missing').then(() => null, (error) => error)
    assert.equal(fs.reads.length, 0, 'Consumer must prevalidate the COMPLETE inventory before ordinary-first bytes')
    assert.match(caught?.message ?? '', /source input|inventory/i, 'Missing fail-closed source inventory policy')
    assert.notEqual(caught?.message, 'DENIED_SYNTHETIC_READ', 'Caught sentinel is NOT policy rejection')
  })
}
// Actual installed option/body/hook seams; downstream loaders and transform responses are synthetic.
async function capturedS7Load(consumer, fs, filename) {
  const source = await readFile(new URL('../worlds-authoring-electron-fixture.mjs', import.meta.url), 'utf8')
  const body = oneSeam(source, /export function mainModuleUrlPlugin\([^)]*\) \{([\s\S]*?)\n\}\nexport async function buildWorldsAuthoringFixture/g, 'actual esbuild source-load plugin')
  const transforms = [], defaults = [], hooks = []
  const transform = async (contents, options) => {
    transforms.push({ contents, options })
    if (options.define) return { code: contents.replaceAll('import.meta.url', options.define['import.meta.url']), warnings: [] }
    return { code: contents, warnings: contents.includes('import.meta.url') ? [{ id: 'empty-import-meta' }] : [] }
  }
  const load = async (filename) => fs.read(filename).toString('utf8')
  const make = await inertFunction(body, ['remember', 'warnings', 'load', 'translate', 'path', 'repositoryRoot', 'esTransform', 'pathToFileURL'])
  const factory = (remember, warnings, _defaultLoad, translate = true) => make(remember, warnings, load, translate, path, path.resolve(canonicalRoot), transform, pathToFileURL)
  const custody = await privacyCollector(fs, path.resolve(canonicalRoot))
  if (filename.startsWith(path.join(canonicalRoot, 'docs/worlds-engine-evidence') + path.sep)) await custody.remember(filename, { canonicalEnumeration: true })
  const options = (await capturedMainOptions(load, custody.remember, true, factory))[consumer === 'main' ? 0 : 1]
  for (const plugin of options.plugins ?? []) plugin.setup({ onLoad: (options, callback) => hooks.push({ options, callback }) })
  const invoke = async (namespace = 'file') => {
    for (const hook of hooks) {
      if (hook.options.namespace && hook.options.namespace !== namespace || !hook.options.filter.test(filename)) continue
      const result = await hook.callback({ path: filename, namespace })
      if (result != null) return result
    }
    if (namespace !== 'file') return { contents: 'synthetic virtual module', loader: 'js' }
    defaults.push(filename)
    return { contents: await load(filename), loader: filename.endsWith('.json') ? 'json' : 'js' }
  }
  return { custody, transforms, defaults, hooks, invoke }
}
for (const consumer of ['main', 'preload']) {
  const denied = ['docs/worlds-engine-evidence/attempt/report.json', 'docs/worlds-engine-evidence/attempt/private.Xauthority.json', ...privacyAuthNames.map((name) => `src/${name}.json`)]
  for (const relative of denied) test(`S7 privacy actual ${consumer} rejects ${relative} before default-loader bytes`, async () => {
    const filename = path.join(canonicalRoot, relative), fs = privacyFilesystem([{ path: filename, bytes: Buffer.from('synthetic denied JSON control'), denied: true }])
    const lane = await capturedS7Load(consumer, fs, filename)
    const caught = await lane.invoke().then(() => null, (error) => error)
    assert.equal(lane.defaults.length, 0, 'Actual esbuild file hook must reject BEFORE downstream default-loader sentinel')
    assert.equal(fs.reads.length, 0, 'Forbidden file must have no source-pin or loader bytes')
    assert.match(caught?.message ?? '', /forbidden.*source input/i, 'Actual main/preload file-load custody is missing')
    assert.equal(lane.transforms.length, 0, 'Forbidden input must never reach main translation')
  })
  for (const extension of ['json', 'js']) test(`S7 privacy actual ${consumer} positive ordinary ${extension} pin and translation routing`, async () => {
    const filename = path.join(canonicalRoot, `src/s7-control.${extension}`)
    const bytes = Buffer.from(extension === 'json' ? '{"synthetic":true}\n' : 'export const source = import.meta.url\n'), fs = privacyFilesystem([{ path: filename, bytes }])
    const lane = await capturedS7Load(consumer, fs, filename), result = await lane.invoke()
    assert.deepEqual(lane.custody.sources.get(filename), { path: filename, ...privacyDigest(bytes) }, 'Ordinary source must be really pinned before default-loader delegation')
    assert.equal(fs.reads.length, 2, 'Positive source must be hashed and then loaded')
    if (consumer === 'main' && extension === 'js') {
      assert.equal(lane.defaults.length, 0); assert.equal(lane.transforms.length, 3)
      assert.equal(result.contents, 'export const source = ' + JSON.stringify(pathToFileURL(filename).href) + '\n')
      assert.equal(lane.transforms[1].options.define['import.meta.url'], JSON.stringify(pathToFileURL(filename).href))
    } else {
      assert.equal(lane.defaults.length, 1); assert.equal(lane.transforms.length, 0)
      assert.equal(result.contents, bytes.toString('utf8'), 'JSON/preload must delegate without main URL translation')
    }
  })
  test(`S7 privacy actual ${consumer} explicitly delegates virtual namespace without filesystem custody`, async () => {
    const filename = path.join(canonicalRoot, 'src/private.Xauthority.json'), fs = privacyFilesystem([{ path: filename, denied: true }])
    const lane = await capturedS7Load(consumer, fs, filename), result = await lane.invoke('virtual')
    assert.equal(result.contents, 'synthetic virtual module'); assert.equal(lane.defaults.length, 0)
    assert.equal(fs.reads.length, 0); assert.equal(fs.metadata.length, 0); assert.equal(lane.transforms.length, 0)
    assert.ok(lane.hooks.every((hook) => hook.options.namespace === 'file'), 'Filesystem custody hooks must be explicitly file-namespace scoped')
  })
}
// Session-shaped DATA controls are in memory only; ordinary authority-named CODE stays admitted.
const privacySessionNames = [':memory:.ses', 'STATE.SeS']
for (const name of privacySessionNames) for (const size of [0, 51]) {
  for (const route of ['direct', 'cached', 'module', 'alias', 'verify', 'enumerated', 'enumerated-symlink']) test(`S8 privacy session collector ${route} ${name} bytes=${size}`, async () => {
    const ordinary = path.join(privacyRoot, 'src/session.ts'), filename = path.join(privacyRoot, name), alias = path.join(privacyRoot, 'src/alias.ts')
    const fs = privacyFilesystem([{ path: ordinary }, { path: filename, bytes: Buffer.alloc(size, 0x78), denied: true, symlink: route === 'enumerated-symlink' }, { path: alias, resolved: filename, denied: true }])
    assert.equal(fs.info(filename).size, size, 'Empty/nonempty controls must vary actual lstat metadata')
    let resolutions = 0
    const resolve = fs.resolve
    fs.resolve = (filename) => { resolutions++; return resolve(filename) }
    const custody = await privacyCollector(fs)
    let operation
    if (route === 'cached') { custody.sources.set(filename, fs.inventory[1]); operation = () => custody.remember(filename) }
    else if (route === 'module') operation = () => custody.rememberResolvedModule(`${filename}?raw`)
    else if (route === 'alias') operation = () => custody.remember(alias)
    else if (route === 'verify') { custody.sources.set(ordinary, fs.inventory[0]); custody.sources.set(filename, fs.inventory[1]); operation = () => custody.verifySources() }
    else operation = () => custody.remember(filename, { canonicalEnumeration: route.startsWith('enumerated') })
    const caught = await operation().then(() => null, (error) => error)
    assert.equal(fs.reads.length, 0, 'Session DATA policy must precede ANY input read, including ordinary-first verification')
    if (route.startsWith('enumerated')) {
      assert.equal(caught, null, 'Canonical session DATA enumeration must remain metadata-only')
      assert.equal(custody.sources.size, 0, 'Session DATA cannot be promoted to source pins')
      const incidental = custody.incidentalArtifacts.get(filename)
      assert.equal(incidental?.type, route === 'enumerated-symlink' ? 'symlink-not-followed' : 'regular-file')
      assert.equal(incidental?.classification, 'incidental-session-data')
      assert.equal(incidental?.lstatSize, size)
      assert.equal(incidental?.relativePath, name)
      assert.equal(resolutions, 0, 'Metadata-only enumeration must not follow any target')
      assert.equal(Object.hasOwn(incidental, 'bytes'), false); assert.equal(Object.hasOwn(incidental, 'sha256'), false)
    } else {
      assert.match(caught?.message ?? '', /forbidden.*source input/i, 'Strict session DATA policy missing before cache/module/alias/verification')
      assert.notEqual(caught?.message, 'DENIED_SYNTHETIC_READ', 'Denied sentinel is not policy rejection')
    }
  })
  for (const consumer of ['main', 'runner']) test(`S8 privacy session ${consumer} complete inventory ${name} bytes=${size}`, async () => {
    const root = canonicalRoot, ordinary = path.join(root, 'src/session.ts'), filename = path.join(root, name)
    const fs = privacyFilesystem([{ path: ordinary }, { path: filename, bytes: Buffer.alloc(size, 0x78), denied: true }])
    assert.equal(fs.info(filename).size, size, 'Consumer empty/nonempty lstat control must be real metadata')
    const caught = await privacyConsumer(consumer, fs).then(() => null, (error) => error)
    assert.equal(fs.reads.length, 0, 'Both consumers must reject complete session DATA inventory BEFORE first ordinary read')
    assert.match(caught?.message ?? '', /forbidden.*source input/i)
    assert.notEqual(caught?.message, 'DENIED_SYNTHETIC_READ')
  })
  for (const consumer of ['main', 'preload']) test(`S8 privacy session actual ${consumer} file-load ${name} bytes=${size}`, async () => {
    const filename = path.join(canonicalRoot, name), fs = privacyFilesystem([{ path: filename, bytes: Buffer.alloc(size, 0x78), denied: true }])
    assert.equal(fs.info(filename).size, size)
    const lane = await capturedS7Load(consumer, fs, filename)
    const caught = await lane.invoke().then(() => null, (error) => error)
    assert.equal(fs.reads.length, 0, 'Actual file hook must reject session DATA before source-pin/default-loader bytes')
    assert.equal(lane.defaults.length, 0); assert.equal(lane.transforms.length, 0)
    assert.match(caught?.message ?? '', /forbidden.*source input/i)
  })
}
for (const consumer of ['main', 'runner']) test(`S8 privacy session ${consumer} realpath alias complete inventory`, async () => {
  const root = canonicalRoot, ordinary = path.join(root, 'src/cookies.js'), alias = path.join(root, 'src/alias.ts')
  const fs = privacyFilesystem([{ path: ordinary }, { path: alias, resolved: path.join(root, ':memory:.ses'), denied: true }])
  const caught = await privacyConsumer(consumer, fs).then(() => null, (error) => error)
  assert.equal(fs.reads.length, 0, 'Alias rejection must precede first ordinary consumer read')
  assert.match(caught?.message ?? '', /source input alias forbidden/i)
})
const privacySessionCode = ['src/session.ts', 'src/cookies.js', 'src/state.ses.ts']
test('S8 privacy session collector ordinary CODE real hash and verification positive', async () => {
  const fs = privacyFilesystem(privacySessionCode.map((relative) => ({ path: path.join(privacyRoot, relative) })))
  const custody = await privacyCollector(fs)
  for (const entry of fs.inventory) await custody.remember(entry.path, { canonicalEnumeration: true })
  await custody.verifySources()
  assert.equal(fs.reads.length, 6); assert.equal(custody.incidentalArtifacts.size, 0)
  for (const entry of fs.inventory) assert.deepEqual(custody.sources.get(entry.path), entry, 'Ordinary CODE must retain real byte/digest source pins')
})
for (const consumer of ['main', 'runner']) test(`S8 privacy session ${consumer} ordinary CODE real hash positive`, async () => {
  const root = canonicalRoot, fs = privacyFilesystem(privacySessionCode.map((relative) => ({ path: path.join(root, relative) })))
  await privacyConsumer(consumer, fs)
  assert.deepEqual(fs.reads, fs.inventory.map((entry) => entry.path), 'Ordinary session/cookies CODE must be really read and hash verified')
})
// Key-material DATA controls are synthetic paths and noncredential buffers only.
const privacyKeyNames = ['public_key.pem', 'PRIVATE.KEY', 'certificate.P12', 'bundle.pfx']
for (const name of privacyKeyNames) for (const size of [0, 113]) {
  for (const route of ['direct', 'cached', 'module', 'alias', 'verify', 'enumerated', 'enumerated-symlink']) test(`S9 privacy key DATA collector ${route} ${name} bytes=${size}`, async () => {
    const ordinary = path.join(privacyRoot, 'src/key.ts'), filename = path.join(privacyRoot, name), alias = path.join(privacyRoot, 'src/alias.ts')
    const fs = privacyFilesystem([{ path: ordinary }, { path: filename, bytes: Buffer.alloc(size, 0x78), denied: true, symlink: route === 'enumerated-symlink' }, { path: alias, resolved: filename, denied: true }])
    assert.equal(fs.info(filename).size, size, 'Empty/nonempty controls must vary actual lstat metadata')
    let resolutions = 0
    const resolve = fs.resolve
    fs.resolve = (filename) => { resolutions++; return resolve(filename) }
    const custody = await privacyCollector(fs)
    let operation
    if (route === 'cached') { custody.sources.set(filename, fs.inventory[1]); operation = () => custody.remember(filename) }
    else if (route === 'module') operation = () => custody.rememberResolvedModule(`${filename}?raw`)
    else if (route === 'alias') operation = () => custody.remember(alias)
    else if (route === 'verify') { custody.sources.set(ordinary, fs.inventory[0]); custody.sources.set(filename, fs.inventory[1]); operation = () => custody.verifySources() }
    else operation = () => custody.remember(filename, { canonicalEnumeration: route.startsWith('enumerated') })
    const caught = await operation().then(() => null, (error) => error)
    assert.equal(fs.reads.length, 0, 'Key DATA policy must precede ANY input read, including ordinary-first verification')
    if (route.startsWith('enumerated')) {
      assert.equal(caught, null, 'Canonical key DATA enumeration must remain metadata-only')
      assert.equal(custody.sources.size, 0, 'Key DATA cannot be promoted to source pins')
      const incidental = custody.incidentalArtifacts.get(filename)
      assert.equal(incidental?.type, route === 'enumerated-symlink' ? 'symlink-not-followed' : 'regular-file')
      assert.equal(incidental?.classification, 'incidental-key-material-data')
      assert.equal(incidental?.lstatSize, size); assert.equal(incidental?.relativePath, name)
      assert.equal(resolutions, 0, 'Metadata-only enumeration must not resolve any target')
      assert.deepEqual(Object.keys(incidental).sort(), ['classification', 'device', 'inode', 'lstatSize', 'mode', 'path', 'relativePath', 'type', 'uid'].sort(), 'Metadata must contain no bytes, digest, realpath or link target')
    } else {
      assert.match(caught?.message ?? '', /forbidden.*source input/i, 'Strict key DATA policy missing before cache/module/alias/verification')
      assert.notEqual(caught?.message, 'DENIED_SYNTHETIC_READ', 'Denied sentinel is not policy rejection')
    }
  })
  for (const consumer of ['main', 'runner']) test(`S9 privacy key DATA ${consumer} complete inventory ${name} bytes=${size}`, async () => {
    const ordinary = path.join(canonicalRoot, 'src/key.ts'), filename = path.join(canonicalRoot, name)
    const fs = privacyFilesystem([{ path: ordinary }, { path: filename, bytes: Buffer.alloc(size, 0x78), denied: true }])
    assert.equal(fs.info(filename).size, size, 'Consumer empty/nonempty lstat control must vary metadata')
    const caught = await privacyConsumer(consumer, fs).then(() => null, (error) => error)
    assert.equal(fs.reads.length, 0, 'Both consumers must reject complete key DATA inventory BEFORE first ordinary read')
    assert.match(caught?.message ?? '', /forbidden.*source input/i)
    assert.notEqual(caught?.message, 'DENIED_SYNTHETIC_READ')
  })
  for (const consumer of ['main', 'preload']) test(`S9 privacy key DATA actual ${consumer} file-load ${name} bytes=${size}`, async () => {
    const filename = path.join(canonicalRoot, name), fs = privacyFilesystem([{ path: filename, bytes: Buffer.alloc(size, 0x78), denied: true }])
    assert.equal(fs.info(filename).size, size)
    const lane = await capturedS7Load(consumer, fs, filename)
    const caught = await lane.invoke().then(() => null, (error) => error)
    assert.equal(fs.reads.length, 0, 'Actual file hook must reject key DATA before source-pin/default-loader bytes')
    assert.equal(lane.defaults.length, 0); assert.equal(lane.transforms.length, 0)
    assert.match(caught?.message ?? '', /forbidden.*source input/i)
    assert.notEqual(caught?.message, 'DENIED_SYNTHETIC_READ')
  })
}
for (const consumer of ['main', 'runner']) test(`S9 privacy key DATA ${consumer} realpath alias complete inventory`, async () => {
  const ordinary = path.join(canonicalRoot, 'src/key.ts'), alias = path.join(canonicalRoot, 'src/alias.ts')
  const fs = privacyFilesystem([{ path: ordinary }, { path: alias, resolved: path.join(canonicalRoot, 'public_key.pem'), denied: true }])
  const caught = await privacyConsumer(consumer, fs).then(() => null, (error) => error)
  assert.equal(fs.reads.length, 0, 'Alias rejection must precede first ordinary consumer read')
  assert.match(caught?.message ?? '', /source input alias forbidden/i)
  assert.notEqual(caught?.message, 'DENIED_SYNTHETIC_READ')
})
const privacyKeyCode = ['src/key.ts', 'src/session.ts', 'src/state.pem.ts']
test('S9 privacy key DATA collector ordinary CODE real hash and verification positive', async () => {
  const fs = privacyFilesystem(privacyKeyCode.map((relative) => ({ path: path.join(privacyRoot, relative) })))
  const custody = await privacyCollector(fs)
  for (const entry of fs.inventory) await custody.remember(entry.path, { canonicalEnumeration: true })
  await custody.verifySources()
  assert.equal(fs.reads.length, 6); assert.equal(custody.incidentalArtifacts.size, 0)
  for (const entry of fs.inventory) assert.deepEqual(custody.sources.get(entry.path), entry, 'Ordinary CODE must retain actual byte/digest source pins')
})
for (const consumer of ['main', 'runner']) test(`S9 privacy key DATA ${consumer} ordinary CODE real hash positive`, async () => {
  const fs = privacyFilesystem(privacyKeyCode.map((relative) => ({ path: path.join(canonicalRoot, relative) })))
  await privacyConsumer(consumer, fs)
  assert.deepEqual(fs.reads, fs.inventory.map((entry) => entry.path), 'Ordinary key/session CODE must be read and hash verified')
})
for (const consumer of ['main', 'preload']) test(`S9 privacy key DATA actual ${consumer} ordinary CODE pin and translation routing positive`, async () => {
  for (const relative of privacyKeyCode) {
    const filename = path.join(canonicalRoot, relative), bytes = Buffer.from('export const source = import.meta.url\n')
    const fs = privacyFilesystem([{ path: filename, bytes }]), lane = await capturedS7Load(consumer, fs, filename), result = await lane.invoke()
    assert.deepEqual(lane.custody.sources.get(filename), { path: filename, ...privacyDigest(bytes) })
    assert.equal(fs.reads.length, 2); assert.equal(lane.custody.incidentalArtifacts.size, 0)
    if (consumer === 'main') {
      assert.equal(lane.defaults.length, 0); assert.equal(lane.transforms.length, 3)
      assert.equal(result.contents, 'export const source = ' + JSON.stringify(pathToFileURL(filename).href) + '\n')
      assert.equal(lane.transforms[1].options.define['import.meta.url'], JSON.stringify(pathToFileURL(filename).href))
    } else {
      assert.equal(lane.defaults.length, 1); assert.equal(lane.transforms.length, 0)
      assert.equal(result.contents, bytes.toString('utf8'), 'Preload CODE must delegate without main URL translation')
    }
  }
})
test('AI7 real preview/discard forwarding stays outside canonical mutation accounting', async () => {
  const source = await readFile(new URL('./main.ts', import.meta.url), 'utf8')
  const body = oneSeam(source, /registerWorldProjectsIpcHandlers\(\{([\s\S]*?)\n\}, repository,/g, 'production registration')
  const routes = new Map(), applies = [], previews = [], discards = []
  const channels = { list: 'list', open: 'open', create: 'create', applyCommands: 'apply', previewCommands: 'preview', previewAi: 'preview-ai', discardAi: 'discard-ai' }
  const make = await inertFunction(`return ({${body}})`, ['register', 'WORLD_PROJECT_CHANNELS', 'inheritedDisplay', 'localAi', 'assert', 'applies', 'aiPreviews', 'aiDiscards', 'now', 'captureAiProjectRead'])
  for (const enabled of [true, false]) {
    routes.clear()
    const forwarded = [], request = { observedRequest: true }, result = { ok: true, value: { observedResult: true } }
    const adapter = make((name, handler) => routes.set(name, handler), channels, true, enabled ? canonicalLocalAiConfig : null, assert, applies, previews, discards, () => 'observed', (channel, args, value) => (channel === channels.previewAi ? previews : discards).push({ args, value }))
    for (const channel of [channels.previewAi, channels.discardAi, 'delete']) adapter.handle(channel, async (_event, argument) => { forwarded.push({ channel, argument }); return result })
    if (enabled) for (const channel of [channels.previewAi, channels.discardAi]) {
      let received
      await assert.doesNotReject(async () => { received = await routes.get(channel)({}, request) }, 'Real preview/discard must forward in the admitted lane')
      assert.equal(received, result); assert.equal(forwarded.at(-1).argument, request)
    }
    else for (const channel of [channels.previewAi, channels.discardAi]) await assert.rejects(() => routes.get(channel)({}, request), /Unexpected project operation/)
    await assert.rejects(() => routes.get('delete')({}, request), /Unexpected project operation/)
    assert.equal(forwarded.length, enabled ? 2 : 0); assert.equal(applies.length, 0)
  }
  assert.equal(previews.length, 1); assert.equal(discards.length, 1)
})

import { parseWorldAiChatResponse } from '../../src/areas/worlds/editor/worldAiChatAdapter.ts'
import { canonicalWorldCommandBatchPayload } from '../../src/areas/worlds/core/worldCommands.ts'
test('AI8 bounded received response custody precedes JSON/DTO decoding failures', async () => {
  const source = await readFile(new URL('./main.ts', import.meta.url), 'utf8')
  const body = oneSeam(source, /upstream.once\('error', reject\); upstream.end\(isChat \? body : undefined\)\n    \}\)\n([\s\S]*?)\n    if \(stopping \|\| controller.signal.aborted\) throw new Error\('Owned request stopped before renderer response'\)/g, 'received response processing')
  const process = await inertFunction(`return (async () => {${body}})()`, ['result', 'isChat', 'aiChats', 'aiDiscoveries', 'capturedChat', 'parseWorldAiChatResponse', 'parseLocalAiModels', 'now', 'hash', 'persist', 'localAi'])
  for (const [status, bytes, valid] of [[200, Buffer.from('{invalid'), false], [200, Buffer.from('{"message":"bad DTO"}'), false], [409, Buffer.from('{"detail":"rejected"}'), false], [200, Buffer.from('{"message":"real response control","actions":[],"proposals":[],"worldProposals":[]}'), true]]) {
    const chats = [], persisted = []
    const caught = await process({ status, bytes }, true, chats, [], { request: { worldContext: { observed: true } }, admittedSelection: { name: 'observed', digest: 'observed' } }, parseWorldAiChatResponse, aiPolicies.parseLocalAiModels, () => 'observed', (bytes) => createHash('sha256').update(bytes).digest('hex'), async () => persisted.push(structuredClone(chats)), canonicalLocalAiConfig).then(() => null, (error) => error)
    assert.equal(chats.length, 1, 'Caught JSON/DTO failure must retain exactly one received response')
    const receipt = chats[0]
    assert.equal(receipt.status, status); assert.equal(receipt.responseBytes, bytes.length)
    assert.equal(receipt.responseSha256, createHash('sha256').update(bytes).digest('hex')); assert.deepEqual(Buffer.from(receipt.rawResponseBase64, 'base64'), bytes)
    assert.ok(persisted.some((rows) => rows.length === 1 && rows[0].validation === 'pending'), 'Pending raw receipt must be persisted before decoding')
    assert.equal(receipt.validation, valid ? 'accepted' : 'rejected'); assert.equal(caught === null, valid || status !== 200, 'Real non-200 status/body forwards unchanged, with rejected validation custody')
  }
})

function completeActualAiPolicyControl() {
  // Synthetic policy control ONLY. This is not HTTP, repository, model or native evidence.
  const context = { schema: 'modly.world-ai-context.v1', projectKey: `world-${'a'.repeat(32)}`, projectId: 'project:observed', activeSceneId: 'scene:first', baseRevision: 8, editorEpoch: 2, originSessionId: 'session:observed', requestId: 'request:first' }
  const model = { name: 'reviewed-existing:tag', digest: `sha256:${'b'.repeat(64)}`, toolsReviewed: true }
  const receipt = (body) => { const bytes = Buffer.from(JSON.stringify(body)); return { status: 200, responseBytes: bytes.length, responseSha256: createHash('sha256').update(bytes).digest('hex'), rawResponseBase64: bytes.toString('base64'), validation: 'accepted', response: body } }
  const before = authoredSnapshot(), candidate = structuredClone(before); candidate.project.revision++
  candidate.project.scenes.push({ id: 'scene:new' }); candidate.scenes.push({ sceneId: 'scene:new', entities: [] })
  before.project.resources = []; candidate.project.resources = [{ id: 'resource:observed', type: 'model', format: 'glb', workspacePath: 'Exports/AuthoringFixtures/red-cube.glb' }]
  before.project.startSceneId = 'scene:first'; candidate.project.startSceneId = 'scene:first'
  for (const scene of [candidate.scenes[0], candidate.scenes[2]]) scene.entities.push({ id: `${scene.sceneId}:new-model`, enabled: true, parentId: null, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: [{ id: `${scene.sceneId}:render`, type: 'renderable', enabled: true, resourceId: 'resource:observed' }, { id: `${scene.sceneId}:collider`, type: 'collider', shape: 'box', enabled: true }, { id: `${scene.sceneId}:body`, type: 'rigid-body', bodyType: 'dynamic', enabled: true }] })
  candidate.scenes[2].entities.push({ id: 'camera:new', components: [{ type: 'camera', enabled: true }] }, { id: 'light:new', components: [{ type: 'light', enabled: true }] })
  const state = { snapshot: before, history: { undo: 3, redo: 0 }, documents: [{ path: 'project.json', sha256: 'c'.repeat(64), bytes: 80 }] }
  const point = { x: 20, y: 30 }, hover = { point, matchCount: 1, enabled: true, visible: true, hitMatches: true }
  const target = { trusted: true, sequence: 1, target: 'BUTTON:Reject Worlds proposal', hitMatches: true, point, hover }
  const proposal = (ctx, commands) => ({ type: 'world_command_proposal', context: ctx, commands })
  const firstProposal = proposal(context, [{ type: 'create-entity', kind: 'group', localRef: 'group-control', sceneRef: { kind: 'existing', id: 'scene:first' }, name: 'AI review group' }, { type: 'reparent-entity', sceneId: 'scene:first', entityId: 'scene:first:model-a', parentRef: { kind: 'local', localRef: 'group-control' } }])
  const secondContext = { ...context, requestId: 'request:second' }, handle = `asset_${'d'.repeat(32)}`
  const secondProposal = proposal(secondContext, [{ type: 'create-scene', localRef: 'new', name: 'Observed scene' }, ...['scene:first', 'new'].map((ref) => ({ type: 'create-entity', kind: 'observed-model', localRef: `model:${ref}`, sceneRef: ref === 'new' ? { kind: 'local', localRef: ref } : { kind: 'existing', id: ref }, name: 'Observed model', resourceHandle: handle }))])
  const query = (ctx, kind, items) => ({ request: { context: ctx, query: { kind } }, result: { ok: true, value: { context: ctx, kind, items: items.map((item) => kind === 'components' ? { ...item, current: { type: 'renderable', enabled: true } } : kind === 'project' ? { ...item, capabilities: ['create-scene', 'create-entity'] } : kind === 'resources' ? { ...item, fingerprint: proof.fingerprint } : item) } } })
  const details = [{ entityName: 'Observed', property: 'Position', before: 'old', after: 'new' }]
  const batch = { schema: 'modly.world-command-batch.v1', transactionId: 'tx:ai-observed', projectId: context.projectId, baseRevision: 8, origin: 'ai', commands: [{ type: 'add-scene', scene: candidate.scenes[2] }] }, authority = `apply_${'e'.repeat(48)}`
  const secondPreview = { request: { proposal: secondProposal }, result: { ok: true, value: { batch, result: { snapshot: candidate, inverse: { kind: 'world-snapshot', snapshot: before }, warnings: [] }, details, authority } } }
  const firstPreview = structuredClone(secondPreview); firstPreview.request.proposal = firstProposal
  const firstCandidate = structuredClone(before); firstCandidate.project.revision++; firstCandidate.scenes[0].entities[0].transform.position[0] += 0.25
  firstCandidate.scenes[0].entities[0].parentId = 'group:control'; firstCandidate.scenes[0].entities.push({ id: 'group:control', name: 'AI review group', parentId: null, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: [] })
  firstPreview.result.value.result.snapshot = firstCandidate
  const turn = (ctx, prop, preview, queries, decision) => { const request = { worldContext: ctx, model: model.name }; return { context: ctx, request, responseReceipt: { ...receipt({ message: 'Observed', actions: [], proposals: [], worldProposals: [prop] }), request: structuredClone(request), admittedSelection: { name: model.name, digest: model.digest } }, queries, preview, before: structuredClone(state), beforeDecision: structuredClone(state), review: { details, warnings: [], applyEnabled: true, rejectEnabled: true, busy: false, focused: true }, decision } }
  const applied = { snapshot: candidate, inverse: { kind: 'world-snapshot', snapshot: before }, idempotent: false, newRevision: 9, receipt: { transactionId: batch.transactionId, payloadSha256: createHash('sha256').update(canonicalWorldCommandBatchPayload(batch)).digest('hex') } }
  const stored = { verified: true, transactionId: batch.transactionId, snapshot: candidate, inverse: applied.inverse }
  const undo = structuredClone(before); undo.project.revision = 10
  const redo = structuredClone(candidate); redo.project.revision = 11
  const history = (kind, snap) => {
    const transactionId = `tx:synthetic-policy-history-${kind}`, inverse = { kind: 'world-snapshot', snapshot: structuredClone(kind === 'Undo' ? candidate : undo) }
    return { kind, input: { ...target, target: `BUTTON:${kind}` }, result: { ok: true, value: { snapshot: snap, inverse, receipt: { transactionId }, newRevision: snap.project.revision, idempotent: false } }, stored: { verified: true, transactionId, snapshot: structuredClone(snap), inverse: structuredClone(inverse) } }
  }
  const sourceBytes = Buffer.alloc(24); sourceBytes.writeUInt32LE(0x46546c67, 0); sourceBytes.writeUInt32LE(2, 4); sourceBytes.writeUInt32LE(24, 8); sourceBytes.writeUInt32LE(4, 12); sourceBytes.writeUInt32LE(0x4e4f534a, 16); sourceBytes.write('{}  ', 20)
  const input = { bytes: sourceBytes.length, sha256: createHash('sha256').update(sourceBytes).digest('hex'), rawBase64: sourceBytes.toString('base64') }
  const proof = { workspacePath: candidate.project.resources[0].workspacePath, format: 'glb', files: [{ path: candidate.project.resources[0].workspacePath, sha256: input.sha256, byteLength: input.bytes, identity: 'synthetic-policy-control-only' }] }
  proof.fingerprint = createHash('sha256').update(JSON.stringify(['glb', proof.files])).digest('hex')
  return { status: 'PASS', checks: ['actual-model-discovery', 'actual-ai-reject', 'actual-ai-apply-and-history', 'actual-ai-both-scenes-reopen'].map((name) => ({ name, status: 'PASS' })), evidence: { actualAi: {
    schema: 'modly.worlds-actual-ai-acceptance.v1', phase: 'complete', admittedModel: model, discovery: receipt({ models: [{ name: model.name, digest: model.digest }] }),
    counters: { discoveryRequests: 1, discoveryResponses: 1, chatRequests: 2, receivedChats: 2, validDecodedChats: 2, validReturnedWorldProposals: 2, hostPreviews: 2, hostDiscards: 1, aiApplies: 1, aiSettledApplies: 1, undo: 1, redo: 1 },
    turns: [turn(context, firstProposal, firstPreview, [query(context, 'entities', [{ kind: 'entity', id: 'scene:first:model-a' }]), query(context, 'components', [{ kind: 'component', entityId: 'scene:first:model-a', type: 'renderable' }])], { kind: 'reject', input: target, discarded: { request: { context, authority }, result: { ok: true, value: { discarded: true } } }, after: structuredClone(state) }), turn(secondContext, secondProposal, secondPreview, [query(secondContext, 'project', [{ kind: 'project', id: context.projectId }]), query(secondContext, 'resources', [{ kind: 'resource', id: handle, format: 'glb', capability: 'mesh', fingerprint: input.sha256 }])], { kind: 'apply', input: { ...target, sequence: 2, target: 'BUTTON:Apply Worlds proposal' }, invocation: { request: { projectKey: context.projectKey, batch, aiAuthority: { token: authority, context: secondContext } }, forwardedAt: 'observed', settledAt: 'observed', result: { ok: true, value: applied } }, stored })],
    sourceWitnesses: [{ handle, resourceId: 'resource:observed', fingerprint: proof.fingerprint, proof, input }], undo: history('Undo', undo), redo: history('Redo', redo),
    reopened: ['scene:first', 'scene:new'].map((sceneId) => ({ sceneId, oldBootId: 'old', bootId: 'new', snapshot: redo, canonicalDiskMatches: true, model: { entityId: `${sceneId}:new-model`, meshes: 1, triangles: 12, visible: true, matrixWorld: Array(16).fill(1), worldCorners: Array(8).fill({ world: [0, 0, 0], ndc: [0, 0, 0], depth: 2 }) }, screenshot: { bytes: 100, sha256: 'f'.repeat(64), filename: 'observed.png' } })),
  } } }
}
test('AI9 actual native terminal rejects startup-only empty AI evidence', async () => {
  const source = await readFile(new URL('./run.mjs', import.meta.url), 'utf8')
  const body = oneSeam(source, /(    assert.equal\(result.status, 'PASS'[\s\S]*?\n    return)/g, 'inherited native terminal')
  const finish = new Function('result', 'assert', 'localAi', 'worldSculptInput', 'assertActualAiTerminal', 'assertActualWorldSculptNavigationTerminal', body)
  const accepted = completeActualAiPolicyControl()
  const invoke = (result, localAi = true) => finish(result, assert, localAi, null, runnerPolicy.assertActualAiTerminal, runnerPolicy.assertActualWorldSculptNavigationTerminal)
  assert.doesNotThrow(() => invoke(accepted), 'Complete synthetic policy control must be accepted')
  assert.doesNotThrow(() => invoke({ status: 'PASS', checks: [{ status: 'PASS' }] }, null), 'Non-AI authoring remains unchanged')
  for (const bad of [{ status: 'PASS', checks: [{ status: 'PASS' }] }, { ...accepted, evidence: { actualApi: { queries: [], chats: [], discoveries: [] } } }]) assert.throws(() => invoke(bad), /AI|actual|query|proposal/i, 'Startup-only cannot satisfy actual AI acceptance')
  const paths = ['schema', 'phase', 'admittedModel', 'discovery', 'counters', 'turns', 'sourceWitnesses', 'undo', 'redo', 'reopened']
  for (const path of paths) { const bad = structuredClone(accepted); delete bad.evidence.actualAi[path]; assert.throws(() => invoke(bad), undefined, `Missing ${path} must be refused`) }
  const corruptions = [(a) => a.turns.pop(), (a) => a.discovery.response.models[0].digest = `sha256:${'c'.repeat(64)}`, (a) => a.turns[0].responseReceipt.validation = 'pending', (a) => a.turns[0].queries.pop(), (a) => a.turns[1].queries[1].result.value.context.requestId = 'stale', (a) => a.turns[0].beforeDecision.history.undo++, (a) => a.turns[0].decision.after.documents = [], (a) => a.turns[0].decision.discarded.result.ok = false, (a) => a.turns[1].decision.input.trusted = false, (a) => a.turns[1].decision.invocation.request.batch.transactionId = 'different', (a) => a.turns[1].decision.invocation.request.aiAuthority.context.editorEpoch++, (a) => a.turns[1].decision.invocation.result.value.idempotent = true, (a) => a.turns[1].decision.stored.verified = false, (a) => a.sourceWitnesses[0].input.sha256 = '0'.repeat(64), (a) => a.undo.result.value.snapshot.project.revision--, (a) => a.redo.result.ok = false, (a) => a.reopened[0].bootId = 'old', (a) => a.reopened[1].canonicalDiskMatches = false, (a) => a.reopened[1].model.triangles = 0, (a) => a.reopened[1].model.worldCorners.pop(), (a) => delete a.reopened[1].screenshot]
  for (const corrupt of corruptions) { const bad = structuredClone(accepted); corrupt(bad.evidence.actualAi); assert.throws(() => invoke(bad), undefined, 'Required actual witness corruption must be refused') }
  for (const event of ['undo', 'redo']) {
    for (const field of ['transactionId', 'snapshot', 'inverse']) {
      const missing = structuredClone(accepted); delete missing.evidence.actualAi[event].stored[field]
      assert.throws(() => invoke(missing), undefined, `${event} missing stored ${field} must be refused`)
      const corrupt = structuredClone(accepted), stored = corrupt.evidence.actualAi[event].stored
      if (field === 'transactionId') stored.transactionId = 'tx:unrelated-synthetic-policy-control'
      else if (field === 'snapshot') stored.snapshot.project.revision++
      else stored.inverse.snapshot.project.revision++
      assert.throws(() => invoke(corrupt), undefined, `${event} independently corrupt stored ${field} must be refused`)
    }
    for (const field of ['receipt', 'transactionId', 'inverse']) {
      const missing = structuredClone(accepted), result = missing.evidence.actualAi[event].result.value
      if (field === 'transactionId') delete result.receipt.transactionId
      else delete result[field]
      assert.throws(() => invoke(missing), undefined, `${event} missing result ${field} must be refused`)
    }
    for (const field of ['transactionId', 'snapshot', 'inverse']) {
      const missing = structuredClone(accepted), history = missing.evidence.actualAi[event]
      delete history.stored[field]
      if (field === 'transactionId') delete history.result.value.receipt.transactionId
      else delete history.result.value[field]
      assert.throws(() => invoke(missing), undefined, `${event} missing both ${field} copies must not compare undefined equal`)
    }
  }
})

test('AI10 native Worlds toggle target resolves scoped existing DOM without a fabricated aria label', async () => {
  const source = await readFile(new URL('./driver.ts', import.meta.url), 'utf8')
  const body = oneSeam(source, /(async function observeNativeClickPoint\([\s\S]*?)(?=async function target)/g, 'safe DOM observation')
  const target = { textContent: 'AI ▴', tagName: 'BUTTON', parentElement: null, isConnected: true,
    getAttribute: () => null, getBoundingClientRect: () => ({ x: 20, y: 20, width: 40, height: 20 }), matches: () => false, contains: () => false }
  const allowed = '[aria-label="Worlds AI"] .worlds-ai-drawer__bar button[aria-controls="worlds-ai-content"]'
  const observe = (await inertFunction(`${body}; return observeNativeClickPoint`, []))()
  for (const mode of ['valid', 'absent', 'ambiguous', 'disabled', 'hidden', 'occluded']) {
    const document = { querySelectorAll: (selector) => selector === allowed ? mode === 'absent' ? [] : mode === 'ambiguous' ? [target, target] : [target] : selector === 'button' ? [{ ...target, getAttribute: () => 'Outside toggle' }] : [], elementFromPoint: () => mode === 'occluded' ? { tagName: 'DIV', getAttribute: () => null } : target }
    target.matches = () => mode === 'disabled'
    const fakeContents = { executeJavaScript: async (expression) => new Function('document', 'getComputedStyle', `return ${expression}`)(document, () => ({ display: mode === 'hidden' ? 'none' : 'block', visibility: 'visible', opacity: '1' })) }
    const observed = await observe(fakeContents, 'ai-toggle', 'Worlds AI')
    if (mode === 'valid') { assert.equal(observed.matchCount, 1, 'Existing scoped Worlds AI header must be natively targetable'); assertNativeClickPointStable(observed.point, observed, 'Worlds AI') }
    else assert.throws(() => assertNativeClickPointStable(observed.point, observed, 'Worlds AI'))
  }
})

test('AI11 main AI stage reacquires current owned renderer after authoring replaces its generation', async () => {
  const source = await readFile(new URL('./main.ts', import.meta.url), 'utf8')
  const body = oneSeam(source, /(  if \(inheritedDisplay\) \{\n    const authored = await runUiAuthoredScenes[\s\S]*?)\n  guard\(\); verifySources\(\)/g, 'existing main orchestration')
  const currentWindow = { webContents: { id: 'initial' }, isDestroyed: () => false }, calls = []
  const make = await inertFunction(`return (async () => {${body}})()`, ['inheritedDisplay', 'contents', 'ports', 'runUiAuthoredScenes', 'runAuthoringInteractions', 'seed', 'assert', 'localAi', 'worldSculptInput', 'currentWindow', 'runActualOllamaDriver', 'aiPorts', 'assertCurrentAiContents', 'report', 'evidence'])
  await make(true, currentWindow.webContents, {}, async () => ({ seed: {} }), async () => { currentWindow.webContents = { id: 'current' } }, {}, assert, true, null, currentWindow, async (contents) => calls.push(contents.id), {}, (contents) => assert.equal(contents, currentWindow.webContents), { localAi: {} }, { actualApi: {} })
  assert.deepEqual(calls, ['current'], 'AI input must use the current owned generation, never stale initial contents')
})

// Owned socket controls only: no native app, provider, default port or host files.
let realLoopbackCapabilityPromise
function loopbackPermissionCode(error) {
  if (!error || typeof error !== 'object' || !('code' in error)) return null
  return error.code === 'EPERM' || error.code === 'EACCES' ? error.code : null
}
async function probeRealLoopbackCapability() {
  const server = createServer()
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      try {
        server.listen(0, '127.0.0.1')
      } catch (error) {
        server.off('error', onError)
        server.off('listening', onListening)
        reject(error)
      }
    })
  } catch (error) {
    const code = loopbackPermissionCode(error)
    if (code) return { available: false, code }
    throw error
  }
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error)
    server.once('error', onError)
    server.close((error) => {
      server.off('error', onError)
      if (error) reject(error)
      else resolve()
    })
  })
  return { available: true, code: null }
}
function getRealLoopbackCapability() {
  realLoopbackCapabilityPromise ??= probeRealLoopbackCapability()
  return realLoopbackCapabilityPromise
}
function loopbackTest(name, run) {
  test(name, async (t) => {
    const capability = await getRealLoopbackCapability()
    if (!capability.available) {
      t.skip(`IPv4 loopback listeners are unavailable (${capability.code}).`)
      return
    }
    await run()
  })
}
const ownedBridgeLogger = { info() {}, warn() {}, error(message) { throw new Error(message) } }
const ownedBridgeDenied = async () => { throw new Error('Generic authority is forbidden in owned bridge controls') }
async function captureOwnedBridgeClass() {
  const source = await readFile(new URL('../../electron/main/automation-http-bridge.ts', import.meta.url), 'utf8')
  const implementation = oneSeam(source, /export (class AutomationHttpBridge[\s\S]*)$/g, 'production bridge class and bounded query reader')
  const writeJson = oneSeam(source, /(function writeJson\([\s\S]*?)\nfunction writeProcessRunError/g, 'production JSON writer')
  return (await inertFunction(writeJson + '\n' + implementation + '\nreturn AutomationHttpBridge',
    ['defaultAutomationHttpBridgeDeps', 'AUTOMATION_HTTP_BRIDGE_HOST', 'AUTOMATION_HTTP_BRIDGE_PORT', 'AUTOMATION_HTTP_BRIDGE_PATH', 'WORLD_AI_QUERY_HTTP_BRIDGE_PATH', 'WORLD_AI_QUERY_BYTES', 'WORLD_AI_PAGE_BYTES', 'parseWorldAiQueryRequest', 'WorldAiContractError']))(
    {}, '127.0.0.1', 8766, '/automation/capabilities', '/automation/worlds/query', WORLD_AI_QUERY_BYTES, WORLD_AI_PAGE_BYTES, parseWorldAiQueryRequest, WorldAiContractError)
}
function ownedBridgeOptions(extra = {}) {
  return { host: '127.0.0.1', port: 0, createServer, logger: ownedBridgeLogger, queryWorld: ownedBridgeDenied,
    getAutomationCapabilities: ownedBridgeDenied, createProcessRun: ownedBridgeDenied, getProcessRun: ownedBridgeDenied,
    cancelProcessRun: ownedBridgeDenied, importSceneMesh: ownedBridgeDenied, ...extra }
}
function ownedBridgePost(origin, route, headers, body) {
  return new Promise((resolve, reject) => {
    const request = ownedHttpRequest(origin + route, { method: 'POST', headers, agent: false }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk)); response.once('error', reject)
      response.once('end', () => resolve({ status: response.statusCode, bytes: Buffer.concat(chunks) }))
    })
    request.once('error', reject); request.setTimeout(2000, () => request.destroy(new Error('Owned control deadline'))); request.end(body)
  })
}
loopbackTest('NP1 owned bridge port0 retains two unique live sockets through owned cleanup', async () => {
  const Bridge = await captureOwnedBridgeClass(), bridges = [new Bridge(ownedBridgeOptions()), new Bridge(ownedBridgeOptions())]
  try {
    for (const bridge of bridges) { assert.equal(bridge.getOrigin(), null); await bridge.start() }
    const origins = bridges.map((bridge) => bridge.getOrigin())
    for (const origin of origins) assert.match(origin, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/)
    assert.notEqual(origins[0], origins[1]); await bridges[0].start()
    assert.deepEqual(bridges.map((bridge) => bridge.getOrigin()), origins, 'Repeated start must retain the same owned listening sockets')
  } finally { for (const bridge of bridges) { await bridge.stop(); assert.equal(bridge.getOrigin(), null) } }
})
loopbackTest('NP2 actual injected bridge admits exact dynamic Host query and refuses generic authority', async () => {
  const source = await readFile(new URL('./main.ts', import.meta.url), 'utf8')
  const producer = oneSeam(source, /createServer: (\(\(handler\?[\s\S]*?) as typeof createServer,/g, 'actual injected bridge server')
  const sockets = new Set(), failures = [], Bridge = await captureOwnedBridgeClass()
  const make = await inertFunction('let bridgeHost: string | null = null; return { createServer: ' + producer + ', configure: (host: string) => { bridgeHost = host } }',
    ['createServer', 'stopping', 'upstreamAbort', 'WORLD_AI_QUERY_BYTES', 'localAi', 'aiSockets', 'fail'])
  const adapter = make(createServer, false, new AbortController(), WORLD_AI_QUERY_BYTES, canonicalLocalAiConfig, sockets, (error) => failures.push(error))
  let queries = 0
  const context = { schema: 'modly.world-ai-context.v1', projectKey: 'world-' + 'a'.repeat(32), projectId: 'project:owned', baseRevision: 4, activeSceneId: 'scene:one', editorEpoch: 1, originSessionId: 'session:owned', requestId: 'tx:owned-query' }
  const body = Buffer.from(JSON.stringify({ context, query: { kind: 'entities', pageSize: 1 } }))
  const bridge = new Bridge(ownedBridgeOptions({ createServer: adapter.createServer, queryWorld: async (request) => {
    queries++; assert.deepEqual(request.context, context)
    return { ok: true, value: { context, kind: 'entities', items: [], total: 0, nextCursor: null } }
  } }))
  try {
    await bridge.start(); const origin = bridge.getOrigin(), headers = { 'Content-Type': 'application/json', 'Content-Length': String(body.length), Host: origin.slice(7) }
    assert.equal((await ownedBridgePost(origin, '/automation/worlds/query', headers, body)).status, 403, 'Requests before Host configuration must be denied')
    adapter.configure(origin.slice(7))
    for (const [route, changed] of [['/automation/worlds/query', { Host: '127.0.0.1:1' }], ['/automation/capabilities', {}], ['/automation/worlds/query', { Authorization: 'synthetic-denied' }], ['/automation/worlds/query', { Cookie: 'synthetic=denied' }]]) {
      assert.equal((await ownedBridgePost(origin, route, { ...headers, ...changed }, body)).status, 403)
    }
    await assert.rejects(() => ownedBridgePost(origin, '/automation/worlds/query', { ...headers, Connection: 'Upgrade', Upgrade: 'websocket' }, body), /socket hang up/)
    assert.equal(queries, 0, 'Denials cannot reach the canonical query callback'); assert.deepEqual(failures, [])
    const response = await ownedBridgePost(origin, '/automation/worlds/query', headers, body)
    assert.equal(response.status, 200, 'Exact owned dynamic Host must reach the actual production query handler')
    assert.equal(queries, 1); assert.equal(JSON.parse(response.bytes).ok, true)
  } finally { for (const socket of sockets) socket.destroy(); await bridge.stop(); assert.equal(bridge.getOrigin(), null) }
})
loopbackTest('NP3 source-qualified owned startup binds and validates origin before private environment checkpoint', async () => {
  const source = await readFile(new URL('./main.ts', import.meta.url), 'utf8')
  const body = oneSeam(source, /(  const denied = async \(\): Promise<never>[\s\S]*?  const env = [^\n]+)\n  for \(const directory/g, 'actual startup bind and private environment boundary')
  const server = createServer(), events = [], options = [], sockets = new Set()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(), origin = 'http://127.0.0.1:' + address.port
  class ControlledBridge {
    constructor(value) { options.push(value) }
    async start() { assert.equal(server.listening, true); events.push('bind') }
    getOrigin() { assert.equal(server.listening, true); events.push('getOrigin'); return origin }
  }
  const make = await inertFunction('return (async () => { let automationBridge; ' + body + '; return env })()',
    ['AutomationHttpBridge', 'createServer', 'stopping', 'upstreamAbort', 'WORLD_AI_QUERY_BYTES', 'localAi', 'aiSockets', 'fail', 'activeAiContext', 'sameWorldAiContext', 'queryRequests', 'repository', 'queryBytes', 'aiQueries', 'now', 'bounded', 'assert', 'aiEvent', 'localAiEnvironment', 'localAiBridgeEnvironment', 'parseOwnedBridgeOrigin', 'runDirectory'])
  const checkpoint = (run, configuredOrigin) => { events.push('environment'); assert.equal(configuredOrigin, origin, 'Private environment must receive the same still-owned startup origin'); return { MODLY_AUTOMATION_BRIDGE_ORIGIN: configuredOrigin } }
  try {
    const env = await make(ControlledBridge, createServer, false, new AbortController(), WORLD_AI_QUERY_BYTES, canonicalLocalAiConfig, sockets, (error) => { throw error }, null, () => false, 0, {}, 0, [], () => 'observed', (operation) => operation,
      assert,
      () => {}, checkpoint, checkpoint, (value) => { events.push('validate'); assert.equal(value, origin); return value }, '/tmp/owned-origin-control')
    assert.equal(options[0].port, 0, 'Actual startup must request explicit port0 rather than the fixed default')
    assert.equal(env.MODLY_AUTOMATION_BRIDGE_ORIGIN, origin); assert.ok(events.indexOf('getOrigin') < events.indexOf('environment'))
    assert.ok(events.indexOf('validate') < events.indexOf('environment'), 'Owned origin validation must precede private env and later Python spawn')
    assert.ok(source.indexOf('const env =') < source.indexOf('pythonChild = spawn('), 'Captured environment boundary must precede actual private Python spawn')
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); assert.equal(server.listening, false) }
})
test('NP4 owned private environment preserves roots and deadlines while rejecting invalid startup origins', () => {
  const run = '/tmp/owned-origin-control', origin = 'http://127.0.0.1:43123'
  const make = aiPolicies.localAiBridgeEnvironment ?? aiPolicies.localAiEnvironment
  const result = make(run, origin), original = aiPolicies.localAiEnvironment(run)
  assert.equal(result.MODLY_AUTOMATION_BRIDGE_ORIGIN, origin, 'Private environment must carry the explicit canonical owned bridge startup origin')
  assert.deepEqual(Object.keys(result).sort(), [...Object.keys(original), 'MODLY_AUTOMATION_BRIDGE_ORIGIN'].sort())
  for (const [key, value] of Object.entries(original)) assert.equal(result[key], value)
  for (const invalid of [undefined, null, '', 'http://localhost:43123', 'https://127.0.0.1:43123', 'http://127.0.0.1:0', 'http://127.0.0.1:01', 'http://127.0.0.1:65536', origin + '/', origin + '?a=1', origin + '#x', 'http://user@127.0.0.1:43123', origin + '\n']) assert.throws(() => make(run, invalid), /bridge origin/i)
  for (const key of ['OLLAMA_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'PYTHONPATH', 'MODLY_API', 'OPENAI_API_KEY']) assert.equal(Object.hasOwn(result, key), false)
})

// Thinking controls are synthetic DOM/transport doubles, executing the actual inert driver bodies.
async function thinkingNativeSurface(mode = 'auto', fault = null) {
  const source = await readFile(new URL('./driver.ts', import.meta.url), 'utf8')
  const body = oneSeam(source, /(async function observeNativeClickPoint\([\s\S]*?)(?=function stableTransform)/g, 'native fixed-point Thinking path').replace(/^export /gm, '')
  const events = [], records = [], titles = ['Thinking: auto', 'Thinking: on', 'Thinking: off']
  const button = { title: `Thinking: ${mode}`, textContent: '', tagName: 'BUTTON', isConnected: true, parentElement: null,
    getAttribute(name) { return name === 'title' ? this.title : null }, getBoundingClientRect: () => ({ x: 20, y: 20, width: 40, height: 20 }), matches: () => fault === 'disabled', contains: () => false }
  const prompt = { parentElement: { querySelectorAll: (selector) => selector === 'button[title]' ? fault === 'absent' ? [] : fault === 'ambiguous' ? [button, button] : [button] : [] } }
  const document = { querySelectorAll: (selector) => selector === '[aria-label="Worlds AI"] textarea[aria-label="Ask Worlds AI"]' ? [prompt] : [],
    elementFromPoint: () => fault === 'occluded' ? { tagName: 'DIV', getAttribute: () => null } : button, activeElement: { getAttribute: () => 'Ask Worlds AI' } }
  const contents = { isDestroyed: () => false, executeJavaScript: async (expression) => new Function('document', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', `return ${expression}`)(document,
    () => ({ display: fault === 'hidden' ? 'none' : 'block', visibility: 'visible', opacity: '1' }), (callback) => { queueMicrotask(callback); return 1 }, () => {}),
    sendInputEvent(event) { events.push(structuredClone(event)); if (event.type === 'mouseMove' && fault === 'drift') button.title = 'Thinking: off'; if (event.type === 'mouseUp') button.title = titles[(titles.indexOf(button.title) + 1) % 3] } }
  const ports = { guard() {}, record(name, value) { records.push({ name, value }) } }
  const make = await inertFunction(`${body}; return {observeNativeClickPoint, click}`, ['assert', 'assertNativeClickPointStable'])
  return { ...make(assert, assertNativeClickPointStable), contents, ports, events, records, button, titles }
}
test('TH1 genuine Thinking title uses the existing unique enabled fixed-point native path', async () => {
  for (const mode of ['auto', 'on', 'off']) {
    const surface = await thinkingNativeSurface(mode), title = `Thinking: ${mode}`
    const observed = await surface.observeNativeClickPoint(surface.contents, 'ai-thinking', title)
    assert.equal(observed.matchCount, 1, 'Existing title-only Thinking control must resolve without a fabricated aria-label')
    assertNativeClickPointStable(observed.point, observed, title)
    await surface.click(surface.contents, surface.ports, 'ai-thinking', title)
    assert.deepEqual(surface.events.map((event) => event.type), ['mouseMove', 'mouseDown', 'mouseUp'])
    assert.deepEqual(surface.events[0].x, surface.events[1].x); assert.deepEqual(surface.events[0].y, surface.events[1].y)
  }
})
test('TH2 Thinking title drift after native hover denies mouseDown without retargeting', async () => {
  const surface = await thinkingNativeSurface('auto', 'drift')
  const caught = await surface.click(surface.contents, surface.ports, 'ai-thinking', 'Thinking: auto').then(() => null, (error) => error)
  assert.equal(surface.events.filter((event) => event.type === 'mouseMove').length, 1, 'Initial genuine title must be admitted before the hover drift control')
  assert.ok(caught); assert.equal(surface.events.some((event) => event.type === 'mouseDown'), false)
  assert.equal(surface.records.filter((entry) => entry.name === 'native-click-hover-Thinking: auto').length, 1)
})
test('TH3 missing ambiguous disabled hidden occluded or invalid Thinking targets are denied', async () => {
  const positive = await thinkingNativeSurface('off'), admitted = await positive.observeNativeClickPoint(positive.contents, 'ai-thinking', 'Thinking: off')
  assert.equal(admitted.matchCount, 1, 'Negative controls require the genuine positive title route')
  for (const fault of ['absent', 'ambiguous', 'disabled', 'hidden', 'occluded']) {
    const surface = await thinkingNativeSurface('off', fault)
    await assert.rejects(() => surface.click(surface.contents, surface.ports, 'ai-thinking', 'Thinking: off'))
    assert.equal(surface.events.some((event) => event.type === 'mouseDown'), false)
  }
  for (const title of ['Thinking: unknown', 'Thinking: off ', 'Outside title']) {
    const surface = await thinkingNativeSurface('off'); surface.button.title = title
    await assert.rejects(() => surface.click(surface.contents, surface.ports, 'ai-thinking', title))
    assert.equal(surface.events.some((event) => event.type === 'mouseDown'), false)
  }
})
async function thinkingScenario(receiptThinking = 'off', requestChange = null) {
  const native = await thinkingNativeSurface(), source = await readFile(new URL('./ai-driver.ts', import.meta.url), 'utf8')
  const body = oneSeam(source, /(async function typePrompt\([\s\S]*?)(?=async function decisionInput)/g, 'actual prompt and receipt review')
  const snapshotBody = oneSeam(source, /(const snapshot = [^\n]+)/g, 'actual driver snapshot observation')
  const context = { schema: 'modly.world-ai-context.v1', projectKey: `world-${'a'.repeat(32)}`, projectId: 'project:thinking', activeSceneId: 'scene:thinking', baseRevision: 7, editorEpoch: 2, originSessionId: 'session:thinking', requestId: 'request:thinking' }
  const state = { snapshot: { project: { projectId: context.projectId, revision: context.baseRevision }, scenes: [] }, history: { undo: 0, redo: 0 }, documents: [] }
  const view = { bootId: 'boot:thinking', editor: { projectKey: context.projectKey, activeSceneId: context.activeSceneId, session: { snapshot: state.snapshot } }, aiReview: { prompt: '', sendEnabled: true, busy: false, selectedModel: 'observed:thinking', applyEnabled: false } }
  const receipts = { chats: [], previews: [], queries: [] }, sent = []
  const originalInput = native.contents.sendInputEvent.bind(native.contents)
  native.contents.sendInputEvent = (event) => { originalInput(event); if (event.type === 'char') view.aiReview.prompt += event.keyCode }
  const ports = { ...native.ports, currentContents: () => native.contents, reviewedModel: { name: view.aiReview.selectedModel }, config: canonicalLocalAiConfig, deadline: Date.now() + 400000,
    applies: () => [], receipts: () => receipts, capture: async () => {}, documentState: async () => structuredClone(state),
    nativeClickWitness: (name) => native.records.findLast((entry) => entry.name === `native-click-hover-${name}`)?.value }
  const key = (_contents, _ports, name) => {
    if (name === 'A') view.aiReview.prompt = ''
    if (name === 'Return') {
      sent.push({ title: native.button.title, prompt: view.aiReview.prompt })
      const current = { ...context, requestId: `request:thinking:${receipts.chats.length}` }, proposal = { context: current, commands: [] }
      const request = { worldContext: structuredClone(current), model: view.aiReview.selectedModel, thinking: receiptThinking }
      if (requestChange) requestChange(request, view)
      receipts.chats.push({ status: 200, validation: 'accepted', request, response: { worldProposals: [proposal] } })
      receipts.previews.push({ request: { proposal } })
      for (const kind of ['entities', 'components']) receipts.queries.push({ request: { context: current }, result: { ok: true, value: { context: current, kind, items: [{ kind }] } } })
      view.aiReview.applyEnabled = true
    }
  }
  const click = async (contents, driverPorts, kind, name) => { if (kind === 'ai-thinking') await native.click(contents, driverPorts, kind, name) }
  const make = await inertFunction(`${snapshotBody}\n${body}; return {typePrompt, reviewTurn}`, ['owner', 'assert', 'click', 'key', 'waitFor', 'budget', 'readView', 'parseWorldAiChatResponse', 'sameWorldAiContext', 'assertReview', 'observeNativeClickPoint', 'assertNativeClickPointStable', 'paint'])
  const scenario = make((driverPorts, contents) => { driverPorts.guard(); assert.equal(contents, driverPorts.currentContents()); assert.equal(contents.isDestroyed(), false) }, assert, click, key,
    async (_contents, _ports, predicate) => { assert.ok(predicate(view)); return view }, () => {}, async () => view, (response) => response,
    (left, right) => JSON.stringify(left) === JSON.stringify(right), () => {}, native.observeNativeClickPoint, assertNativeClickPointStable, async () => view)
  return { ...scenario, native, ports, state, view, sent, receipts }
}
test('TH4 actual driver observes local Thinking off immediately before both scenario chats', async () => {
  const scenario = await thinkingScenario()
  await scenario.typePrompt(scenario.native.contents, scenario.ports, 'First source scenario')
  assert.equal(scenario.sent[0].title, 'Thinking: off', 'First genuine native request must select local off')
  assert.equal(scenario.native.events.filter((event) => event.type === 'mouseDown').length, 2)
  scenario.native.button.title = 'Thinking: on'; scenario.view.aiReview.applyEnabled = false
  await scenario.typePrompt(scenario.native.contents, scenario.ports, 'Second source scenario')
  assert.equal(scenario.sent[1].title, 'Thinking: off', 'Second genuine native request must recheck local off rather than trust earlier clicks')
  assert.equal(scenario.native.events.filter((event) => event.type === 'mouseDown').length, 3)
  assert.deepEqual(scenario.sent.map((entry) => entry.prompt), ['First source scenario', 'Second source scenario'])
})
test('TH5 actual captured request denies auto on or stale context despite native off and admits bound off', async () => {
  for (const mode of ['auto', 'on', undefined]) {
    const scenario = await thinkingScenario(mode)
    // Undefined must be real missing data rather than the default parameter's positive value.
    if (mode === undefined) { const original = scenario.ports.receipts; scenario.ports.receipts = () => { const value = original(); for (const chat of value.chats) delete chat.request.thinking; return value } }
    await assert.rejects(() => scenario.reviewTurn(scenario.native.contents, scenario.ports, 'Bound source scenario', scenario.state, 0), /Thinking|request context/, 'A historical native off witness cannot admit a different actual request mode')
  }
  for (const change of [(request) => request.worldContext.baseRevision++, (request) => request.worldContext.projectKey = `world-${'b'.repeat(32)}`, (request) => request.worldContext.activeSceneId = 'scene:other', (request) => request.model = 'other:tag', (_request, view) => view.bootId = 'boot:other']) {
    const scenario = await thinkingScenario('off', change)
    await assert.rejects(() => scenario.reviewTurn(scenario.native.contents, scenario.ports, 'Bound source scenario', scenario.state, 0), /Thinking|request context|generation/)
  }
  const positive = await thinkingScenario('off')
  await assert.doesNotReject(() => positive.reviewTurn(positive.native.contents, positive.ports, 'Bound source scenario', positive.state, 0))
  assert.equal(positive.sent[0].title, 'Thinking: off')
})

// Actual registered main callbacks and Promise.race teardown; all native/resource ports are inert.
async function ownedLifecycleMain(terminalPorts = {}) {
  const source = await readFile(new URL('./main.ts', import.meta.url), 'utf8')
  const registration = oneSeam(source, /(app\.on\('window-all-closed',[\s\S]*?)(?=\nconst checks)/g, 'actual registered app lifecycle')
  const variables = oneSeam(source, /(let firstFailure:[\s\S]*?)(?=function fail)/g, 'actual lifecycle state declarations')
  const functions = oneSeam(source, /(function fail\([\s\S]*?)(?=function assertCurrentAiContents)/g, 'actual fail lifecycle and owner guard')
  const windows = oneSeam(source, /(async function openWindow\([\s\S]*?)(?=async function run)/g, 'actual native generation creation')
  const pipeline = oneSeam(source, /(void Promise\.race\(\[execution, fatal\]\)[\s\S]*)$/g, 'actual fatal race and bounded owned teardown')
  const events = [], snapshots = [], cleanup = [], evidence = {}, errors = [], network = []
  const checks = [{ name: 'fresh-repository-and-renderer-reopen', status: 'UNREACHED' }], report = { status: 'RUNNING', checks, cleanup, errors, evidence }
  const app = new EventEmitter(), nativeWindows = [], ipcMain = new EventEmitter()
  const outsideBefore = () => events.push('outside-before'), outsideWill = () => events.push('outside-will')
  app.on('before-quit', outsideBefore); app.on('will-quit', outsideWill)
  const removeOwnedListener = app.removeListener.bind(app)
  app.removeListener = (name, listener) => {
    if (terminalPorts.disposalError && events.includes('persist:complete') && listener !== outsideBefore && listener !== outsideWill) {
      events.push('controlled:owned-disposal'); throw terminalPorts.disposalError
    }
    return removeOwnedListener(name, listener)
  }
  let resolveDone, resolveExecution, releasePersist, holdPersist = false, apiClosedResolve
  const done = new Promise((resolve) => { resolveDone = resolve }), execution = new Promise((resolve) => { resolveExecution = resolve })
  const apiClosed = new Promise((resolve) => { apiClosedResolve = resolve })
  app.exit = (code) => { events.push(`exit:${code}`); resolveDone(code) }
  ipcMain.removeHandler = (channel) => events.push(`channel:${channel}`)
  class OwnedWindow extends EventEmitter {
    static getAllWindows() { return nativeWindows.filter((window) => !window.destroyed) }
    constructor() { super(); this.destroyed = false; this.focused = false; nativeWindows.push(this); this.webContents = new EventEmitter(); Object.assign(this.webContents,
      { id: nativeWindows.length, setWindowOpenHandler() {}, focus() {}, getOSProcessId: () => 100 + nativeWindows.length, capturePage: async () => ({ toPNG: () => Buffer.from('synthetic screenshot') }) }) }
    isDestroyed() { return this.destroyed } isFocused() { return this.focused }
    destroy() { this.destroyed = true; this.emit('closed') } async loadURL() {} show() {} focus() { this.focused = true }
  }
  const session = { fromPartition: () => ({ webRequest: { onBeforeRequest: (callback) => events.push(callback === null ? 'session:disposed' : 'session:registered') }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) }
  const persist = async () => { events.push('persist'); if (holdPersist) await new Promise((resolve) => { releasePersist = resolve }); events.push('persist:complete') }
  const params = ['app', 'BrowserWindow', 'ipcMain', 'session', 'assert', 'evidence', 'errors', 'report', 'checks', 'cleanup', 'network', 'now', 'writeFileSync', 'reportPath', 'path', 'bundle', 'build', 'assetPaths', 'runtimeMode', 'createWorldSculptPointerLockPermissionPolicy', 'localAi', 'isLocalAiRoute', 'waitForOwnedWindowFocus', 'execution', 'readView', 'writeFile', 'runDirectory', 'abortGate', 'bounded', 'stopLocalAi', 'diskManifest', 'workspace', 'persist', 'watchdog', 'onViolation', 'gate']
  // Bind the actual expression only to observe its exceptional completion; its body is unchanged.
  const observedPipeline = pipeline.replace(/^void /, 'const terminal = ')
  const make = await inertFunction(`${variables}\n${functions}\n${registration}\n${windows}\n${observedPipeline}\nreturn {openWindow, fail, terminal, state: () => ({firstFailure, currentWindow, generation, stopping, terminalExitAuthorized, records: evidence.lifecycle ?? []}), setStage: name => {currentStage = name}, setStopping: value => {stopping = value}, setServer: value => {server = value}, addChannel: name => ownedChannels.push(name)}`, params)
  const main = make(app, OwnedWindow, ipcMain, session, assert, evidence, errors, report, checks, cleanup, network, () => 'controlled:at', (_path, bytes) => {
    events.push('snapshot')
    if (terminalPorts.finalWriteError && events.includes('persist:complete')) { events.push('controlled:final-write'); throw terminalPorts.finalWriteError }
    snapshots.push(JSON.parse(bytes))
  }, '/tmp/inert-lifecycle-report.json', path, '/tmp/modly-worlds-authoring-ui-inert', { outputs: { 'renderer/index.html': {} } }, [], 'authoring', () => ({ request() {}, check: () => false }), { cleanupSeconds: 8 }, () => false,
    async (_window, options) => { options.assertOwned(); return { focusedAt: 'controlled:at' } }, execution, async () => ({}), async () => {}, '/tmp/inert-run', () => {}, async (operation) => operation,
    async () => { events.push('api:closed'); cleanup.push({ actualApiClosed: true }); apiClosedResolve() }, async () => { events.push('manifest'); return [] }, '/tmp/inert-workspace', persist, null, () => {}, null)
  main.setStage(checks[0].name)
  const emitQuit = (name) => { const event = { prevented: false, preventDefault() { this.prevented = true; events.push(`prevent:${name}`) } }; app.emit(name, event); return event }
  return { ...main, app, events, snapshots, checks, cleanup, evidence, report, done, apiClosed, nativeWindows, emitQuit,
    releaseExecution() { resolveExecution() },
    holdPersist() { holdPersist = true }, releasePersist() { holdPersist = false; releasePersist?.() },
    async finish() {
      holdPersist = false; releasePersist?.(); resolveExecution(); await done
      const unexpected = cleanup.filter((receipt) => Object.hasOwn(receipt, 'error') || Object.hasOwn(receipt, 'terminalError'))
      if (unexpected.length) throw new Error(`INVALID_LIFECYCLE_HARNESS_CLEANUP: ${JSON.stringify(unexpected)}`)
      console.log('WLRED harness integrity: cleanup.error=0; actual initial gate=null; no active gate claim')
    } }
}
test('WLRED1 actual replacement records deliberate generation1 destroy and zero-owner gap', async () => {
  const main = await ownedLifecycleMain()
  try {
    await main.openWindow(); await main.openWindow()
    assert.equal(main.state().firstFailure, null); assert.equal(main.nativeWindows[0].isDestroyed(), true)
    assert.ok(main.state().records.some((event) => event.event === 'replacement-destroyed' && event.generation === 1 && event.ownedWindowCount === 0), 'Actual deliberate replacement must retain its generation1 zero-owner receipt')
  } finally { await main.finish() }
})
test('WLRED2 actual before-quit prevents active termination before first FAIL snapshot', async () => {
  const main = await ownedLifecycleMain()
  try {
    await main.openWindow(); const event = main.emitQuit('before-quit')
    assert.equal(event.prevented, true, 'Actual before-quit must synchronously prevent Electron termination')
    assert.ok(main.events.indexOf('prevent:before-quit') < main.events.indexOf('snapshot'))
    assert.equal(main.snapshots[0].checks[0].status, 'FAIL'); assert.ok(main.state().firstFailure)
  } finally { await main.finish() }
})
test('WLRED3 actual will-quit and repeated quit cannot escape incomplete stopping cleanup', async () => {
  const main = await ownedLifecycleMain()
  try {
    await main.openWindow(); main.holdPersist(); main.fail(new Error('first controlled failure')); await main.apiClosed
    assert.equal(main.state().stopping, true)
    const original = main.state().firstFailure
    assert.equal(main.emitQuit('will-quit').prevented, true, 'Stopping is not terminal cleanup authorization')
    assert.equal(main.emitQuit('before-quit').prevented, true)
    assert.equal(main.state().firstFailure, original); assert.equal(main.events.some((event) => event.startsWith('exit:')), false)
  } finally { await main.finish() }
})
test('WLRED4 actual generation2 closed synchronously marks fresh-reopen FAIL', async () => {
  const main = await ownedLifecycleMain()
  try {
    await main.openWindow(); await main.openWindow(); main.state().currentWindow.destroy()
    assert.equal(main.state().firstFailure.message, 'Owned window closed unexpectedly')
    assert.equal(main.snapshots[0].checks[0].status, 'FAIL', 'Current watcher failure must name the stage before its first synchronous snapshot')
    assert.ok(main.state().records.some((event) => event.event === 'closed' && event.generation === 2 && event.classification === 'active'))
  } finally { await main.finish() }
})
test('WLRED5 actual status exit follows owned channels server API and persisted cleanup', async () => {
  const main = await ownedLifecycleMain()
  try {
    main.addChannel('controlled-owned'); main.setServer({ close(callback) { main.events.push('server:closed'); callback(null) }, closeAllConnections() {} })
    await main.finish()
    const exit = main.events.indexOf('exit:1')
    for (const event of ['channel:controlled-owned', 'server:closed', 'api:closed', 'manifest', 'persist']) assert.ok(main.events.indexOf(event) >= 0 && main.events.indexOf(event) < exit)
  } finally { await main.finish() }
})
test('WLRED6 actual lifecycle retains immutable generations and disposes only owned quit listeners', async () => {
  const main = await ownedLifecycleMain()
  try {
    await main.openWindow(); await main.openWindow()
    const generation1 = main.state().records.find((event) => event.event === 'created' && event.generation === 1)
    assert.ok(generation1, 'Actual main creation callback must retain immutable generation metadata')
    assert.equal(Object.isFrozen(generation1), true); assert.equal(generation1.classification, 'active')
    await main.finish()
    assert.equal(main.app.listenerCount('before-quit'), 1); assert.equal(main.app.listenerCount('will-quit'), 1)
    assert.ok(main.state().records.some((event) => event.event === 'terminal-exit-authorized'))
  } finally { await main.finish() }
})
test('WLTERM1 actual final publication failure still attempts forced FAIL exit', async () => {
  const controlled = new Error('Controlled final report write fault')
  const main = await ownedLifecycleMain({ finalWriteError: controlled })
  main.report.status = 'PASS'; main.releaseExecution()
  const rejected = await main.terminal.then(() => null, (error) => error)
  if (rejected && rejected !== controlled) throw new Error(`INVALID_LIFECYCLE_TERMINAL_BINDING: ${String(rejected)}`)
  if (main.cleanup.some((receipt) => receipt.terminalError && receipt.terminalError !== String(controlled))) throw new Error('INVALID_LIFECYCLE_TERMINAL_ERROR')
  assert.equal(main.cleanup.some((receipt) => Object.hasOwn(receipt, 'error')), false, 'Unexpected cleanup.error remains INVALID')
  assert.ok(main.events.indexOf('persist:complete') < main.events.indexOf('controlled:final-write'))
  assert.ok(main.events.includes('exit:1'), 'Actual finalizer must attempt exit1 even when final publication and fallback writes throw')
  assert.equal(main.report.status, 'FAIL'); assert.equal(main.state().terminalExitAuthorized, false)
  assert.ok(main.cleanup.some((receipt) => receipt.terminalExit === 'forced' && receipt.ownedCleanupComplete === false))
})
test('WLTERM2 actual owned listener disposal failure still attempts forced FAIL exit', async () => {
  const controlled = new Error('Controlled owned listener disposal fault')
  const main = await ownedLifecycleMain({ disposalError: controlled })
  main.report.status = 'PASS'; main.releaseExecution()
  const rejected = await main.terminal.then(() => null, (error) => error)
  if (rejected && rejected !== controlled) throw new Error(`INVALID_LIFECYCLE_TERMINAL_BINDING: ${String(rejected)}`)
  if (main.cleanup.some((receipt) => receipt.terminalError && receipt.terminalError !== String(controlled))) throw new Error('INVALID_LIFECYCLE_TERMINAL_ERROR')
  assert.equal(main.cleanup.some((receipt) => Object.hasOwn(receipt, 'error')), false, 'Unexpected cleanup.error remains INVALID')
  assert.ok(main.events.indexOf('persist:complete') < main.events.indexOf('controlled:owned-disposal'))
  assert.ok(main.events.includes('exit:1'), 'Actual finalizer must attempt exit1 despite owned listener disposal failure')
  assert.equal(main.report.status, 'FAIL'); assert.equal(main.state().terminalExitAuthorized, false)
  assert.ok(main.cleanup.some((receipt) => receipt.terminalExit === 'forced' && receipt.ownedCleanupComplete === false))
})

test('DB1 owned native startup exports sixty-second round deadline', () => {
  const run = '/tmp/owned/round-budget-control', origin = 'http://127.0.0.1:32123'
  const privateEnvironment = aiPolicies.localAiEnvironment(run)
  const bridgeEnvironment = aiPolicies.localAiBridgeEnvironment(run, origin)
  assert.equal(privateEnvironment.MODLY_AGENT_OLLAMA_ROUND_DEADLINE_SECONDS, '60', 'Private startup must use the fixed sixty-second round admission profile')
  assert.equal(bridgeEnvironment.MODLY_AGENT_OLLAMA_ROUND_DEADLINE_SECONDS, '60', 'Owned bridge startup must retain that same round admission profile')
  assert.deepEqual(bridgeEnvironment, { ...privateEnvironment, MODLY_AUTOMATION_BRIDGE_ORIGIN: origin })
  assert.equal(privateEnvironment.HOME, `${run}/api-home`)
  for (const secret of ['HF_TOKEN', 'OPENAI_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_OPTIONS', 'PYTHONPATH']) assert.equal(Object.hasOwn(privateEnvironment, secret), false)
  const config = canonicalLocalAiConfig
  assert.equal(config.roundSeconds, 60)
  assert.deepEqual([config.turnSeconds, config.mainWatchdogSeconds, config.runnerWatchdogSeconds, config.outerSeconds], [100, 420, 430, 450], 'The total-turn and outer watchdog budgets must not widen')
})

test('DB2 fixed round deadline rejects nonpositive nonfinite and over-sixty profiles', () => {
  const message = /Local-AI round deadline must be finite, positive, at most 60 seconds, and shorter than the turn deadline/
  for (const roundSeconds of [NaN, Infinity, -Infinity, 0, -1, 60.001, 61, 100, '60']) {
    assert.throws(() => aiPolicies.validateLocalAiConfig({ ...canonicalLocalAiConfig, roundSeconds }, canonicalLocalAiConfig), message, `Invalid round deadline ${String(roundSeconds)} must fail with the bounded-round diagnostic`)
  }
  for (const turnSeconds of [NaN, Infinity, -Infinity, 0, 59, 60, '100']) {
    assert.throws(() => aiPolicies.validateLocalAiConfig({ ...canonicalLocalAiConfig, roundSeconds: 60, turnSeconds }, canonicalLocalAiConfig), message, `Invalid enclosing turn deadline ${String(turnSeconds)} must fail before fixed-profile comparison`)
  }
  assert.equal(aiPolicies.validateLocalAiConfig(canonicalLocalAiConfig, canonicalLocalAiConfig), canonicalLocalAiConfig)
  assert.throws(() => aiPolicies.validateLocalAiConfig({ ...canonicalLocalAiConfig, roundSeconds: 50 }, canonicalLocalAiConfig), /Invalid local-AI configuration roundSeconds/, 'A bounded but different profile must still be refused')
})

test('DB3 legacy twenty-second round1 HTTP504 never establishes actual AI acceptance', () => {
  // Exact historical failure bytes, synthetic in-memory policy control only; no HTTP or native execution.
  const bytes = Buffer.from('{"detail":{"code":"ollama_round_deadline_exceeded","message":"Ollama exceeded the total deadline for one agent round. Try again.","retryable":true,"round":1,"actions":[],"proposals":[]}}')
  assert.equal(bytes.length, 186)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'f50cd2a2f8fbc6c847b5a3034a169939a91c57b7a7313d958fe717ff2a5eaca8')
  const complete = completeActualAiPolicyControl()
  assert.doesNotThrow(() => runnerPolicy.assertActualAiTerminal(complete), 'Complete prior-stage synthetic control must pass before replacing its HTTP receipt')
  const failed = structuredClone(complete)
  Object.assign(failed.evidence.actualAi.turns[0].responseReceipt, { status: 504, responseBytes: bytes.length, responseSha256: createHash('sha256').update(bytes).digest('hex'), rawResponseBase64: bytes.toString('base64'), validation: 'rejected', response: JSON.parse(bytes.toString('utf8')) })
  assert.equal(failed.evidence.actualAi.turns[0].responseReceipt.response.detail.round, 1)
  assert.throws(() => runnerPolicy.assertActualAiTerminal(failed), { code: 'ERR_ASSERTION', actual: 504, expected: 200, message: /Actual AI HTTP success required/ }, 'A historical round timeout must fail specifically at real HTTP success validation, not at missing prior-stage evidence')
})

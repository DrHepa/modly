import assert from 'node:assert/strict'
import type { WebContents } from 'electron'
import type { WorldProjectSnapshotV1 } from '../../src/areas/worlds/core/worldModel.ts'
import { nativeKeySequence } from '../worlds-character-electron-fixture/nativeKeyboard.ts'
import { CHECK_NAMES, ENTITY_NAMES, PROJECT_KEY, type CheckName, type PhysicsCheck, type PhysicsFixtureView } from './shared.ts'

const WAIT_MS = 7_000
class RuntimeFailure extends Error {}
const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

export function readPhysicsFixtureView(contents: WebContents): Promise<PhysicsFixtureView | null> {
  return contents.executeJavaScript("(() => { const text = document.getElementById('physics-fixture-state')?.textContent; return text ? JSON.parse(text) : null; })()")
}

function locateInPage(label: string, scroll: boolean) {
  const matches = [...document.querySelectorAll<HTMLElement>('[aria-label]')].filter((element) => element.getAttribute('aria-label') === label)
  if (matches.length !== 1) throw new Error(`Expected one native target ${label}, found ${matches.length}.`)
  const element = matches[0]
  if (scroll) element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
  const rectangle = element.getBoundingClientRect()
  const x = Math.round(rectangle.left + rectangle.width / 2)
  const y = Math.round(rectangle.top + rectangle.height / 2)
  return { x, y, focused: document.activeElement === element,
    visible: rectangle.width > 0 && rectangle.height > 0,
    disabled: 'disabled' in element && !!element.disabled, obscured: !element.contains(document.elementFromPoint(x, y)) }
}
const locate = (contents: WebContents, label: string, scroll = false): Promise<ReturnType<typeof locateInPage>> =>
  contents.executeJavaScript(`(${locateInPage.toString()})(${JSON.stringify(label)}, ${scroll})`)

async function waitFor(contents: WebContents, description: string, predicate: (view: PhysicsFixtureView) => boolean, allowError = false): Promise<PhysicsFixtureView> {
  const deadline = Date.now() + WAIT_MS
  let last: PhysicsFixtureView | null = null
  while (Date.now() < deadline) {
    last = await readPhysicsFixtureView(contents)
    if (last?.error && !allowError) throw new RuntimeFailure(`${description}: ${last.error}`)
    if (last && predicate(last)) return last
    await delay(25)
  }
  throw new Error(`Timed out: ${description}; ${JSON.stringify(last ? compact(last) : null)}`)
}

async function key(contents: WebContents, keyCode: string, allowError = false): Promise<void> {
  const previous = (await readPhysicsFixtureView(contents))?.trace.at(-1)?.sequence ?? 0
  for (const event of nativeKeySequence(keyCode)) contents.sendInputEvent(event)
  await waitFor(contents, `trusted ${keyCode} keyUp`, (view) => view.trace.some((entry) => entry.sequence > previous && entry.trusted && entry.type === 'keyup' && entry.key?.toLowerCase() === keyCode.toLowerCase()), allowError)
}

async function heldKey(contents: WebContents, down: boolean, keyCode = 'D', allowError = false): Promise<void> {
  const previous = (await readPhysicsFixtureView(contents))?.trace.at(-1)?.sequence ?? 0
  contents.sendInputEvent({ type: down ? 'keyDown' : 'keyUp', keyCode })
  const expectedCode = keyCode === 'Space' ? 'Space' : `Key${keyCode}`
  await waitFor(contents, `trusted ${expectedCode} ${down ? 'down' : 'up'} on viewport`, (view) => view.trace.some((entry) => entry.sequence > previous && entry.trusted
    && entry.type === (down ? 'keydown' : 'keyup') && entry.code === expectedCode && entry.target === 'Play viewport'), allowError)
}

async function pointer(contents: WebContents, label: string, allowError = false): Promise<void> {
  const previous = (await readPhysicsFixtureView(contents))?.trace.at(-1)?.sequence ?? 0
  const target = await locate(contents, label, true)
  assert.ok(target.visible && !target.disabled && !target.obscured, `Native pointer target is unavailable: ${label}`)
  contents.sendInputEvent({ type: 'mouseMove', x: target.x, y: target.y })
  contents.sendInputEvent({ type: 'mouseDown', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  contents.sendInputEvent({ type: 'mouseUp', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  await waitFor(contents, `trusted pointer ${label}`, (view) => view.trace.some((entry) => entry.sequence > previous && entry.trusted && entry.type === 'pointerdown' && entry.target === label), allowError)
  if (label === 'Play viewport') assert.equal((await locate(contents, label)).focused, true, 'Native pointer must focus the actual production viewport.')
}

function position(view: PhysicsFixtureView, entityId: string): [number, number, number] {
  const latest = view.physics.samples.at(-1)
  assert.ok(latest, 'A real Worker snapshot is required.')
  const index = latest.entityIds.indexOf(entityId)
  assert.ok(index >= 0, 'Character is missing from the real snapshot.')
  return latest.transforms.slice(index * 7, index * 7 + 3) as [number, number, number]
}
function compact(view: PhysicsFixtureView) {
  return { playLifecycle: view.playLifecycle, savedRevision: view.savedRevision, error: view.error,
    physics: { ...view.physics, samples: view.physics.samples.slice(-12) }, trace: view.trace.slice(-35), untrustedInputs: view.untrustedInputs }
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export async function runPhysicsInteractions(contents: WebContents, checkpoint: (entry: PhysicsCheck) => Promise<void>, verifyRepository: (snapshot: WorldProjectSnapshotV1) => Promise<void>) {
  const checks: PhysicsCheck[] = CHECK_NAMES.map((name) => ({ name, status: 'UNREACHED' }))
  const retained: { original: PhysicsFixtureView | null } = { original: null }
  let started = false
  let scenarioError: string | null = null
  const check = async (name: CheckName, operation: () => Promise<unknown>) => {
    const entry = checks.find((candidate) => candidate.name === name)!
    try {
      entry.evidence = await operation()
      if (retained.original?.editorSession) {
        await verifyRepository(retained.original.editorSession.snapshot)
        const current = await readPhysicsFixtureView(contents)
        assert.deepEqual(current?.editorSession, retained.original.editorSession, 'Every checkpoint must preserve the entire editor session.')
      }
      entry.status = 'PASS'
    }
    catch (error) {
      entry.status = 'FAIL'; entry.reason = errorText(error)
      const view = await readPhysicsFixtureView(contents).catch(() => null)
      if (view) entry.evidence = compact(view)
      throw error
    } finally { await checkpoint(structuredClone(entry)) }
  }
  try {
    await check('sandbox-and-original-document', async () => {
      const original = await waitFor(contents, 'canonical authored project', (view) => !view.initializing && view.editorLifecycle === 'ready' && view.editorSession !== null)
      retained.original = original
      assert.deepEqual(original.environment, { sandboxed: true, contextIsolated: true })
      assert.equal(original.requireType, 'undefined'); assert.equal(original.processType, 'undefined')
      assert.equal(original.projectKey, PROJECT_KEY)
      await verifyRepository(original.editorSession!.snapshot)
      return { environment: original.environment, editorSession: original.editorSession }
    })
    const baseline = retained.original!
    const entities = baseline.editorSession!.snapshot.scenes.find((scene) => scene.sceneId === baseline.sceneId)!.entities
    const hero = entities.find((entity) => entity.name === ENTITY_NAMES.character)!.id
    const sensor = entities.find((entity) => entity.name === ENTITY_NAMES.sensor)!
    const trigger = sensor.components.find((component) => component.type === 'trigger')!
    const expectedIds = entities.filter((entity) => Object.values(ENTITY_NAMES).includes(entity.name as typeof ENTITY_NAMES[keyof typeof ENTITY_NAMES])).map((entity) => entity.id)
    await check('native-enter-play', async () => {
      let focused = false
      for (let count = 0; count < 24; count += 1) {
        if ((await locate(contents, 'Play World')).focused) { focused = true; break }
        await key(contents, 'Tab')
      }
      assert.ok(focused, 'Native Tab did not reach Play World.')
      const sequence = (await readPhysicsFixtureView(contents))!.trace.at(-1)?.sequence ?? 0
      started = true
      await key(contents, 'Enter')
      const view = await waitFor(contents, 'playing with a real snapshot', (candidate) => candidate.playLifecycle === 'playing' && candidate.physics.receivedCount > 0)
      const inputs = view.trace.filter((entry) => entry.sequence > sequence)
      assert.ok(inputs.some((entry) => entry.type === 'keypress' && entry.key === 'Enter' && entry.trusted))
      assert.equal(inputs.filter((entry) => entry.type === 'click' && entry.target === 'Play World').length, 1)
      return compact(view)
    })
    await check('exact-body-ids', async () => {
      const view = (await readPhysicsFixtureView(contents))!
      assert.deepEqual(view.physics.expectedEntityIds, expectedIds)
      assert.deepEqual(view.physics.samples.at(-1)!.entityIds, expectedIds)
      assert.equal(expectedIds.length, 4)
      assert.equal(view.physics.generationId, 1)
      return compact(view)
    })
    await check('ground-settle', async () => {
      const view = await waitFor(contents, 'character rests on ground', (candidate) => candidate.physics.receivedCount >= 25 && Math.abs(position(candidate, hero)[1] - 0.91) < 0.08)
      assert.ok(Math.abs(position(view, hero)[0]) < 0.03)
      return compact(view)
    })
    await check('native-movement-and-release', async () => {
      await pointer(contents, 'Play viewport')
      try {
        await heldKey(contents, true)
        await waitFor(contents, 'native D advances before the sensor', (view) => position(view, hero)[0] >= 0.3)
      } finally { await heldKey(contents, false) }
      const released = (await readPhysicsFixtureView(contents))!
      const x = position(released, hero)[0]
      assert.ok(x >= 0.2 && x < 0.64, `Movement must remain before the sensor: x=${x}`)
      const stopped = await waitFor(contents, '12 acknowledged frames after key release', (view) => view.physics.acknowledgedSequence >= released.physics.acknowledgedSequence + 12)
      assert.ok(Math.abs(position(stopped, hero)[0] - x) < 0.03, 'Character kept moving after releasing D.')
      return compact(stopped)
    })
    await check('pause-and-resume', async () => {
      await pointer(contents, 'Pause World')
      await waitFor(contents, 'pause acknowledgement', (view) => view.playLifecycle === 'paused' && view.physics.pendingCount === 0)
      const paused = (await readPhysicsFixtureView(contents))!
      await pointer(contents, 'Play viewport')
      await heldKey(contents, true)
      await delay(350)
      const still = (await readPhysicsFixtureView(contents))!
      assert.equal(still.physics.acknowledgedSequence, paused.physics.acknowledgedSequence)
      assert.deepEqual(position(still, hero), position(paused, hero))
      await heldKey(contents, false)
      await pointer(contents, 'Resume World')
      const resumed = await waitFor(contents, 'resume fresh Worker acknowledgements', (view) => view.playLifecycle === 'playing' && view.physics.acknowledgedSequence > paused.physics.acknowledgedSequence + 2)
      return compact(resumed)
    })
    await check('sensor-traversal', async () => {
      await pointer(contents, 'Play viewport')
      try {
        await heldKey(contents, true)
        return compact(await waitFor(contents, 'character crosses the fixed sensor volume', (view) => position(view, hero)[0] > 1.9))
      } finally { await heldKey(contents, false) }
    })
    try {
      await check('fixed-sensor-enter-exit', async () => {
        const view = (await readPhysicsFixtureView(contents))!
        const events = view.physics.triggerEvents.filter((event) => event.triggerComponentId === trigger.id && event.otherEntityId === hero)
        assert.deepEqual(events.map((event) => event.type), ['enter', 'exit'], 'The real kinematic Character must emit fixed-sensor enter then exit.')
        assert.ok(events.every((event) => event.otherTags.includes('physics-character')))
        return { events }
      })
    } catch (error) {
      // Missing sensor events are semantic RED, but a traversed course can still prove the later independent checks.
      if (error instanceof RuntimeFailure) throw error
      scenarioError = errorText(error)
    }
    await check('platform-blocks-walking', async () => {
      await pointer(contents, 'Play viewport')
      try {
        await heldKey(contents, true)
        const beginning = (await readPhysicsFixtureView(contents))!.physics.acknowledgedSequence
        const blocked = await waitFor(contents, '30 acknowledged steps against raised platform', (view) => view.physics.acknowledgedSequence >= beginning + 30)
        const [x, y] = position(blocked, hero)
        assert.ok(x > 2 && x < 2.2 && Math.abs(y - 0.91) < 0.08, `Platform did not block grounded walking: ${x},${y}`)
        return compact(blocked)
      } finally { await heldKey(contents, false) }
    })
    await check('jump-and-platform-landing', async () => {
      await pointer(contents, 'Play viewport')
      const beginning = (await readPhysicsFixtureView(contents))!.physics.acknowledgedSequence
      try {
        await heldKey(contents, true)
        await heldKey(contents, true, 'Space')
        await waitFor(contents, 'jump rises above ground from a fresh Worker frame', (view) => view.physics.acknowledgedSequence > beginning && position(view, hero)[1] > 1.2)
        await heldKey(contents, false, 'Space')
        await waitFor(contents, 'jump clears the platform edge', (view) => position(view, hero)[0] > 3.05)
      } finally {
        await heldKey(contents, false, 'Space')
        await heldKey(contents, false)
      }
      const released = (await readPhysicsFixtureView(contents))!
      const landed = await waitFor(contents, 'stable landing on top of platform', (view) => view.physics.acknowledgedSequence > released.physics.acknowledgedSequence + 55 && Math.abs(position(view, hero)[1] - 1.91) < 0.08)
      assert.ok(position(landed, hero)[0] >= 3 && position(landed, hero)[0] < 3.8)
      assert.ok(landed.physics.samples.some((sample) => sample.sequence > beginning && sample.transforms[sample.entityIds.indexOf(hero) * 7 + 1] > 2.1), 'A real upward trajectory is required, not a teleported landing.')
      return compact(landed)
    })
    await check('walk-off-and-ground-landing', async () => {
      try {
        await heldKey(contents, true)
        await waitFor(contents, 'character clears the far platform edge', (view) => position(view, hero)[0] > 4.6)
      } finally { await heldKey(contents, false) }
      const released = (await readPhysicsFixtureView(contents))!
      const grounded = await waitFor(contents, 'character lands back on ground', (view) => view.physics.acknowledgedSequence > released.physics.acknowledgedSequence + 40 && Math.abs(position(view, hero)[1] - 0.91) < 0.08)
      return compact(grounded)
    })
  } catch (error) { scenarioError ??= errorText(error) }
  finally {
    // Native Stop and repository evidence must survive an expected sensor failure.
    if (retained.original?.editorSession) {
      const baseline = retained.original
      if (started) {
        try {
          await check('stop-restores-editor-and-closes-audio', async () => {
            for (const keyCode of ['D', 'Space']) contents.sendInputEvent({ type: 'keyUp', keyCode })
            const before = await readPhysicsFixtureView(contents)
            assert.ok(before && before.playLifecycle !== 'edit', 'Play already exited before the native Stop check.')
            await pointer(contents, 'Stop World', true)
            const stopped = await waitFor(contents, 'Stop, Worker disposal and actual audio close settlement', (view) => view.playLifecycle === 'edit'
              && view.physics.disposedCount === 1 && view.physics.audioCloseStarted === 1 && view.physics.audioCloseCompleted === 1, true)
            assert.equal(stopped.runtimeSnapshotPresent, false)
            assert.equal(stopped.bodyPoseCount, 0)
            assert.equal(stopped.physics.pendingCount, 0)
            assert.deepEqual(stopped.editorSession, baseline.editorSession)
            assert.deepEqual(stopped.playEditorSession, baseline.editorSession)
            assert.equal(stopped.savedRevision, baseline.savedRevision)
            assert.equal(stopped.untrustedInputs, 0)
            await delay(200)
            const quiet = (await readPhysicsFixtureView(contents))!
            assert.equal(quiet.physics.receivedCount, stopped.physics.receivedCount)
            assert.equal(quiet.physics.postedSequence, stopped.physics.postedSequence)
            return { editorSession: stopped.editorSession, final: compact(quiet), claim: 'Production dispose and quiescence; not a physical process-memory leak benchmark.' }
          })
        } catch (error) { scenarioError ??= errorText(error) }
      }
      try {
        await check('independent-repository-unchanged', async () => {
          await verifyRepository(baseline.editorSession!.snapshot)
          return { revision: baseline.savedRevision, independentlyReopened: true }
        })
      } catch (error) { scenarioError ??= errorText(error) }
    }
    for (const entry of checks) if (entry.status === 'UNREACHED') {
      entry.reason = scenarioError ? `Not executed after: ${scenarioError}` : 'Prerequisite was not reached.'
      await checkpoint(structuredClone(entry))
    }
  }
  return { checks, error: scenarioError, finalView: await readPhysicsFixtureView(contents).catch(() => null) }
}

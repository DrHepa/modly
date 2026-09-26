import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { WebContents } from 'electron'
import { ENTITY_NAMES } from './shared.ts'
import { WORKER_CHECK_NAMES, type WorkerCheck, type WorkerCheckName, type WorkerControls, type WorkerFixtureCommand, type WorkerFixtureView } from './worker-contract.ts'

const NEUTRAL: WorkerControls = { moveRight: false, jump: false }
const RIGHT: WorkerControls = { moveRight: true, jump: false }
const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds))
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 4096)

/** Main-owned stable byte evidence has no dependency on a renderer or its DOM. */
export async function captureWorkerProjectFiles(projectRoot: string) {
  assert.equal(await realpath(projectRoot), path.resolve(projectRoot), 'Project root must not be a symbolic link.')
  const entries: Array<{ path: string; bytes: number; sha256: string }> = []
  let totalBytes = 0
  const visit = async (relative: string): Promise<void> => {
    for (const name of (await readdir(path.join(projectRoot, relative))).sort()) {
      const child = path.join(relative, name)
      const absolute = path.join(projectRoot, child)
      const info = await lstat(absolute)
      assert.ok(!info.isSymbolicLink(), `Refusing symbolic link in durable evidence: ${child}`)
      if (info.isDirectory()) { await visit(child); continue }
      assert.ok(info.isFile(), `Refusing non-file durable evidence: ${child}`)
      totalBytes += info.size
      assert.ok(entries.length < 512 && info.size <= 8 * 1024 * 1024 && totalBytes <= 32 * 1024 * 1024, 'Durable fixture evidence exceeded its file/byte bound.')
      const bytes = await readFile(absolute)
      assert.equal(bytes.length, info.size)
      entries.push({ path: child, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
  }
  await visit('')
  return entries
}

export function readWorkerFixtureView(contents: WebContents): Promise<WorkerFixtureView | null> {
  return contents.executeJavaScript('window.worldsPhysicsWorkerFixture?.read() ?? null')
}
function position(view: WorkerFixtureView, entityId: string): [number, number, number] {
  const sample = view.physics.samples.at(-1)
  assert.ok(sample, 'A real Worker snapshot is required.')
  const index = sample.entityIds.indexOf(entityId)
  assert.ok(index >= 0, 'The Character must exist in the real Worker snapshot.')
  return sample.transforms.slice(index * 7, index * 7 + 3) as [number, number, number]
}
function compact(view: WorkerFixtureView) {
  return { lane: view.lane, lifecycle: view.play.lifecycle, revision: view.savedRevision,
    history: { undo: view.editorSession?.undoStack.length, redo: view.editorSession?.redoStack.length, receipts: view.editorSession?.receipts.length },
    canvasCount: view.canvasCount, error: view.error, lastFrame: view.lastFrame,
    physics: { ...view.physics, samples: view.physics.samples.slice(-12) } }
}

export async function runWorkerPhysicsInteractions(
  contents: WebContents,
  checkpoint: (entry: WorkerCheck) => Promise<void>,
  captureBaseline: (view: WorkerFixtureView) => Promise<void>,
  rendererFailure: Promise<never>,
) {
  const checks: WorkerCheck[] = WORKER_CHECK_NAMES.map(name => ({ name, status: 'UNREACHED' }))
  const retained: { original: WorkerFixtureView | null } = { original: null }
  const deadline = Date.now() + 95_000
  let started = false
  let tick = -1
  let error: string | null = null
  async function bounded<T>(operation: Promise<T>, milliseconds = 12_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([operation, rendererFailure, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Worker-only browser operation timed out.')), milliseconds)
      })])
    } finally { clearTimeout(timer) }
  }
  const read = () => bounded(readWorkerFixtureView(contents), 3_000)
  async function call(command: WorkerFixtureCommand, cleanup = false): Promise<WorkerFixtureView> {
    assert.ok(cleanup || Date.now() < deadline, 'Worker-only scenario exceeded its 95 second bound.')
    // Explicit programmatic public-API invocation. No synthetic DOM event or user-gesture override.
    const view: WorkerFixtureView = await bounded(contents.executeJavaScript(`window.worldsPhysicsWorkerFixture.command(${JSON.stringify(command)})`))
    if (!cleanup) assert.equal(view.error, null, `Real runtime failure: ${view.error}`)
    assert.equal(view.canvasCount, 0)
    return view
  }
  const step = (controls = NEUTRAL) => call({ type: 'advance', tick: ++tick, controls })
  async function frames(count: number, controls = NEUTRAL): Promise<WorkerFixtureView> {
    let view: WorkerFixtureView | null = null
    for (let frame = 0; frame < count; frame += 1) view = await step(controls)
    assert.ok(view)
    return view
  }
  async function until(description: string, predicate: (view: WorkerFixtureView) => boolean, controls: WorkerControls, limit = 120): Promise<WorkerFixtureView> {
    let last: WorkerFixtureView | null = null
    for (let count = 0; count < limit; count += 1) {
      last = await step(controls)
      if (predicate(last)) return last
    }
    throw new Error(`${description} was not reached within ${limit} acknowledged simulation frames: ${JSON.stringify(last ? compact(last) : null)}`)
  }
  async function check(name: WorkerCheckName, operation: () => Promise<unknown>) {
    const entry = checks.find(candidate => candidate.name === name)!
    try { entry.evidence = await operation(); entry.status = 'PASS' }
    catch (cause) { entry.status = 'FAIL'; entry.reason = message(cause); throw cause }
    finally { await checkpoint(structuredClone(entry)) }
  }
  try {
    await check('sandbox-and-authored-history', async () => {
      let view: WorkerFixtureView | null = null
      const authorDeadline = Date.now() + 25_000
      while (Date.now() < authorDeadline) {
        view = await read()
        assert.ok(!view?.error, view?.error ?? '')
        if (view?.ready) break
        await delay(25)
      }
      assert.ok(view?.ready && view.editorSession, 'Canonical Worker-only authoring did not finish.')
      assert.deepEqual(view.environment, { sandboxed: true, contextIsolated: true })
      assert.equal(view.requireType, 'undefined'); assert.equal(view.processType, 'undefined'); assert.equal(view.canvasCount, 0)
      assert.equal(view.savedRevision, 13); assert.equal(view.editorSession.undoStack.length, 13)
      assert.equal(view.editorSession.receipts.length, 13); assert.equal(view.editorSession.redoStack.length, 0)
      retained.original = view
      await captureBaseline(view)
      return compact(view)
    })
    const baseline = retained.original!
    const entities = baseline.editorSession!.snapshot.scenes[0].entities
    const hero = entities.find(entity => entity.name === ENTITY_NAMES.character)!.id
    const sensor = entities.find(entity => entity.name === ENTITY_NAMES.sensor)!
    const trigger = sensor.components.find(component => component.type === 'trigger')!
    const expectedIds = entities.filter(entity => Object.values(ENTITY_NAMES).some(name => name === entity.name)).map(entity => entity.id)
    await check('programmatic-play-ready', async () => {
      started = true
      const view = await call({ type: 'start' })
      assert.equal(view.play.lifecycle, 'playing'); assert.equal(view.physics.generationId, 1)
      const prime = await step()
      assert.equal(prime.lastFrame?.expectedSteps, 0); assert.equal(prime.physics.receivedCount, 0)
      return compact(prime)
    })
    await check('exact-body-ids', async () => {
      const view = await step()
      assert.equal(expectedIds.length, 4)
      assert.deepEqual(view.physics.expectedEntityIds, expectedIds)
      assert.deepEqual(view.physics.samples.at(-1)!.entityIds, expectedIds)
      assert.equal(view.physics.acknowledgedSequence, 1)
      return compact(view)
    })
    await check('ground-settle', async () => {
      const view = await frames(30)
      assert.ok(Math.abs(position(view, hero)[1] - 0.91) < 0.08)
      assert.ok(Math.abs(position(view, hero)[0]) < 0.03)
      return compact(view)
    })
    await check('programmatic-movement-and-release', async () => {
      const moving = await until('Movement before sensor', view => position(view, hero)[0] >= 0.3, RIGHT, 12)
      const x = position(moving, hero)[0]
      assert.ok(x < 0.64)
      const released = await frames(12)
      assert.ok(Math.abs(position(released, hero)[0] - x) < 0.03, 'Character moved after releasing its authored input.')
      return compact(released)
    })
    await check('pause-and-resume', async () => {
      const paused = await call({ type: 'pause' })
      const still = await frames(6, RIGHT)
      assert.equal(still.physics.acknowledgedSequence, paused.physics.acknowledgedSequence)
      assert.deepEqual(position(still, hero), position(paused, hero))
      await call({ type: 'resume' })
      const prime = await step()
      assert.equal(prime.lastFrame?.expectedSteps, 0)
      const resumed = await frames(3)
      assert.equal(resumed.physics.acknowledgedSequence, paused.physics.acknowledgedSequence + 3)
      return compact(resumed)
    })
    await check('sensor-traversal', async () => {
      const view = await until('Crossing the fixed sensor', candidate => position(candidate, hero)[0] > 1.9, RIGHT)
      await step()
      return compact(view)
    })
    await check('fixed-sensor-enter-exit', async () => {
      const view = (await read())!
      const events = view.physics.triggerEvents.filter(event => event.triggerComponentId === trigger.id && event.otherEntityId === hero)
      assert.deepEqual(events.map(event => event.type), ['enter', 'exit'], 'Real kinematic Character / fixed sensor must emit enter then exit; anticipated RED is not PASS.')
      assert.ok(events.every(event => event.otherTags.includes('physics-character')))
      return { events }
    })
    await check('platform-blocks-walking', async () => {
      const view = await frames(30, RIGHT)
      const [x, y] = position(view, hero)
      assert.ok(x > 2 && x < 2.2 && Math.abs(y - 0.91) < 0.08, `Grounded walking was not blocked: ${x},${y}`)
      await step()
      return compact(view)
    })
    await check('jump-and-platform-landing', async () => {
      const beginning = (await read())!.physics.acknowledgedSequence
      await step({ moveRight: true, jump: true })
      const crossed = await until('Jumping over the platform edge', view => position(view, hero)[0] > 3.05, RIGHT)
      assert.ok(position(crossed, hero)[1] > 1.2)
      const landed = await frames(70)
      const [x, y] = position(landed, hero)
      assert.ok(x >= 3 && x < 3.8 && Math.abs(y - 1.91) < 0.08, `Platform landing was not stable: ${x},${y}`)
      assert.ok(landed.physics.samples.some(sample => sample.sequence > beginning && sample.transforms[sample.entityIds.indexOf(hero) * 7 + 1] > 2.1), 'Real upward trajectory was not observed.')
      return compact(landed)
    })
    await check('walk-off-and-ground-landing', async () => {
      await until('Leaving the platform', view => position(view, hero)[0] > 4.6, RIGHT)
      const landed = await frames(55)
      assert.ok(Math.abs(position(landed, hero)[1] - 0.91) < 0.08)
      return compact(landed)
    })
  } catch (cause) { error = message(cause) }
  finally {
    if (started) {
      try {
        await check('stop-and-audio-settlement', async () => {
          const before = await read().catch(() => null)
          const stopped = await call({ type: 'stop' }, true)
          assert.ok(before && before.play.lifecycle !== 'edit', 'Runtime exited before the explicit Stop check.')
          assert.equal(stopped.play.lifecycle, 'edit'); assert.equal(stopped.play.runtimeSnapshot, null)
          assert.equal(stopped.play.bodyPoses.length, 0); assert.equal(stopped.physics.pendingCount, 0)
          assert.equal(stopped.physics.disposedCount, 1)
          assert.equal(stopped.physics.audioCloseStarted, 1); assert.equal(stopped.physics.audioCloseCompleted, 1)
          await delay(150)
          const quiet = (await read())!
          assert.equal(quiet.physics.postedSequence, stopped.physics.postedSequence)
          assert.equal(quiet.physics.receivedCount, stopped.physics.receivedCount)
          return compact(quiet)
        })
      } catch (cause) { error ??= message(cause) }
    }
    if (retained.original) {
      try {
        await check('editor-history-receipts-unchanged', async () => {
          const final = await read()
          assert.ok(final, 'Renderer state is unavailable; editor equality is unproved.')
          assert.deepEqual(final.editorSession, retained.original!.editorSession)
          if (started) assert.deepEqual(final.play.editor, retained.original!.editorSession)
          assert.equal(final.savedRevision, retained.original!.savedRevision)
          return { revision: final.savedRevision, undo: final.editorSession!.undoStack.length, receipts: final.editorSession!.receipts.length, redo: final.editorSession!.redoStack.length }
        })
      } catch (cause) { error ??= message(cause) }
    }
    for (const entry of checks) if (entry.status === 'UNREACHED' && entry.name !== 'independent-durable-reopen') {
      entry.reason = error ? `Not executed after: ${error}` : 'Prerequisite was not reached.'
      await checkpoint(structuredClone(entry))
    }
  }
  return { checks, error, finalView: await read().catch(() => null) }
}

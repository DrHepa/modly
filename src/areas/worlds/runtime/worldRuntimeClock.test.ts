import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WORLD_FIXED_STEP_SECONDS,
  WORLD_MAX_RECOVERY_STEPS,
  WorldRuntimeAnimationGate,
  WorldFixedStepClock,
} from './worldRuntimeClock.ts'

test('fixed clock advances at 60 Hz, caps recovery at four and discards excess backlog', () => {
  const clock = new WorldFixedStepClock()
  assert.deepEqual(clock.advance(0), { steps: 0, alpha: 0, droppedSeconds: 0 })
  assert.equal(clock.advance(1000 / 60).steps, 1)
  const stalled = clock.advance(1_000)
  assert.equal(stalled.steps, WORLD_MAX_RECOVERY_STEPS)
  assert.ok(stalled.droppedSeconds > WORLD_FIXED_STEP_SECONDS * 50)
  assert.ok(stalled.alpha >= 0 && stalled.alpha < 1)
})

test('pause and resume discard wall-clock time instead of replaying it', () => {
  const clock = new WorldFixedStepClock()
  clock.advance(0)
  clock.pause()
  assert.deepEqual(clock.advance(10_000), { steps: 0, alpha: 0, droppedSeconds: 0 })
  clock.resume()
  assert.deepEqual(clock.advance(10_000), { steps: 0, alpha: 0, droppedSeconds: 0 })
  assert.equal(clock.advance(10_000 + 1000 / 60).steps, 1)
})

test('runtime animation advances only while playing and never catches up paused time', () => {
  const gate = new WorldRuntimeAnimationGate()
  const advanced: number[] = []
  gate.advance('playing', 10, (deltaSeconds) => advanced.push(deltaSeconds))
  gate.advance('playing', WORLD_FIXED_STEP_SECONDS, (deltaSeconds) => advanced.push(deltaSeconds))
  for (const lifecycle of ['loading', 'paused', 'stopping', 'edit'] as const) gate.advance(lifecycle, 5, (deltaSeconds) => advanced.push(deltaSeconds))
  gate.advance('playing', 10, (deltaSeconds) => advanced.push(deltaSeconds))
  gate.advance('playing', 0.02, (deltaSeconds) => advanced.push(deltaSeconds))
  assert.deepEqual(advanced, [WORLD_FIXED_STEP_SECONDS, 0.02])
})

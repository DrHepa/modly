import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveAnimationAvailability, resolveAnimationToggleState, syncAnimationActions } from './viewerAnimation.ts'

test('resolveAnimationToggleState maps no clips to a disabled no-animation affordance', () => {
  assert.deepEqual(resolveAnimationToggleState({ hasAnimations: false, animationPlaying: false }), {
    disabled: true,
    label: 'No animation clips',
    pressed: undefined,
  })
})

test('resolveAnimationToggleState maps paused and playing states to Play/Pause semantics', () => {
  assert.deepEqual(resolveAnimationToggleState({ hasAnimations: true, animationPlaying: false }), {
    disabled: false,
    label: 'Play animation',
    pressed: false,
  })
  assert.deepEqual(resolveAnimationToggleState({ hasAnimations: true, animationPlaying: true }), {
    disabled: false,
    label: 'Pause animation',
    pressed: true,
  })
})

test('resolveAnimationAvailability treats only non-empty clip arrays as animated', () => {
  assert.equal(resolveAnimationAvailability([]), false)
  assert.equal(resolveAnimationAvailability([{ name: 'Idle' }]), true)
})

test('syncAnimationActions resumes and plays available actions', () => {
  const calls: string[] = []
  const action = {
    paused: true,
    enabled: false,
    play() {
      calls.push('play')
      return this
    },
  }

  syncAnimationActions([action], true)

  assert.equal(action.enabled, true)
  assert.equal(action.paused, false)
  assert.deepEqual(calls, ['play'])
})

test('syncAnimationActions pauses available actions without replaying them', () => {
  const calls: string[] = []
  const action = {
    paused: false,
    enabled: true,
    play() {
      calls.push('play')
      return this
    },
  }

  syncAnimationActions([action], false)

  assert.equal(action.enabled, true)
  assert.equal(action.paused, true)
  assert.deepEqual(calls, [])
})

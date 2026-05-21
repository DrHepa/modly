import assert from 'node:assert/strict'
import test from 'node:test'
import { isolateAnimationForPoseClipPreview, resolveAnimationAvailability, resolveAnimationToggleState, syncAnimationActions } from './viewerAnimation.ts'

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

test('isolateAnimationForPoseClipPreview pauses GLTF actions and reports the prior playback snapshot', () => {
  const calls: string[] = []
  const actions = [
    {
      paused: false,
      enabled: true,
      play() {
        calls.push('play-first')
        return this
      },
    },
    {
      paused: true,
      enabled: true,
      play() {
        calls.push('play-second')
        return this
      },
    },
  ]

  const snapshot = isolateAnimationForPoseClipPreview(actions, true)

  assert.deepEqual(snapshot, { wasPlaying: true })
  assert.equal(actions[0].enabled, true)
  assert.equal(actions[0].paused, true)
  assert.equal(actions[1].enabled, true)
  assert.equal(actions[1].paused, true)
  assert.deepEqual(calls, [])
})

test('isolateAnimationForPoseClipPreview keeps a paused GLTF state paused without inventing playback', () => {
  const action = {
    paused: true,
    enabled: true,
    play() {
      throw new Error('pose preview isolation must not play GLTF clips')
    },
  }

  const snapshot = isolateAnimationForPoseClipPreview([action], false)

  assert.deepEqual(snapshot, { wasPlaying: false })
  assert.equal(action.enabled, true)
  assert.equal(action.paused, true)
})

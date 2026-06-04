import assert from 'node:assert/strict'
import test from 'node:test'
import { finishScopedAnimationPlayback, isolateAnimationForPoseClipPreview, resetAnimationPlayback, resolveAnimationAvailability, resolveAnimationToggleState, startGlobalAnimationPlayback, startScopedAnimationPlayback, syncAnimationActions } from './viewerAnimation.ts'

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

test('resetAnimationPlayback stops, resets, unpauses, disables and rewinds every action before seeking the mixer to time zero', () => {
  const calls: string[] = []
  const firstAction = {
    enabled: true,
    paused: true,
    time: 1.25,
    play() { calls.push('first:play'); return this },
    stop() { calls.push('first:stop'); return this },
    reset() { calls.push('first:reset'); return this },
  }
  const secondAction = {
    enabled: true,
    paused: false,
    time: 0.5,
    play() { calls.push('second:play'); return this },
    stop() { calls.push('second:stop'); return this },
    reset() { calls.push('second:reset'); return this },
  }
  const mixer = {
    time: 2.75,
    setTime(timeSeconds: number) {
      calls.push(`mixer:setTime:${timeSeconds}`)
      this.time = timeSeconds
    },
  }

  const result = resetAnimationPlayback({ actions: [firstAction, secondAction], mixer })

  assert.deepEqual(calls, ['first:stop', 'first:reset', 'second:stop', 'second:reset', 'mixer:setTime:0'])
  assert.equal(firstAction.enabled, false)
  assert.equal(firstAction.paused, false)
  assert.equal(firstAction.time, 0)
  assert.equal(secondAction.enabled, false)
  assert.equal(secondAction.paused, false)
  assert.equal(secondAction.time, 0)
  assert.equal(mixer.time, 0)
  assert.deepEqual(result, { resetActionCount: 2, mixerTimeSeconds: 0 })
})

test('resetAnimationPlayback remains deterministic when actions or mixers only implement part of the Three.js control surface', () => {
  const action = {
    enabled: true,
    paused: true,
    play() { throw new Error('reset must not replay an action') },
  }
  const mixer = { time: 9 }

  const result = resetAnimationPlayback({ actions: [action], mixer })

  assert.equal(action.enabled, false)
  assert.equal(action.paused, false)
  assert.equal(mixer.time, 0)
  assert.deepEqual(result, { resetActionCount: 1, mixerTimeSeconds: 0 })
})

test('global GLB playback owner can start independently of panel-scoped previews', () => {
  assert.deepEqual(startGlobalAnimationPlayback({ hasAnimations: true, animationPlaying: false }), {
    owner: 'global-glb',
    animationPlaying: true,
  })
  assert.deepEqual(startGlobalAnimationPlayback({ hasAnimations: false, animationPlaying: false }), {
    owner: 'global-glb',
    animationPlaying: false,
  })
})

test('scoped pose and Motion Retarget previews snapshot but do not erase the prior global GLB state', () => {
  assert.deepEqual(startScopedAnimationPlayback({ owner: 'pose-clip-preview', globalAnimationPlaying: true }), {
    owner: 'pose-clip-preview',
    restoreGlobalAnimationPlaying: true,
  })
  assert.deepEqual(startScopedAnimationPlayback({ owner: 'motion-retarget-local-preview', globalAnimationPlaying: false }), {
    owner: 'motion-retarget-local-preview',
    restoreGlobalAnimationPlaying: false,
  })
})

test('finishing a local Motion Retarget preview restores the prior global owner state without permanently disabling playback', () => {
  assert.deepEqual(finishScopedAnimationPlayback({ owner: 'motion-retarget-local-preview', restoreGlobalAnimationPlaying: true }), {
    owner: 'global-glb',
    animationPlaying: true,
  })
  assert.deepEqual(finishScopedAnimationPlayback({ owner: 'pose-clip-preview', restoreGlobalAnimationPlaying: false }), {
    owner: 'global-glb',
    animationPlaying: false,
  })
})

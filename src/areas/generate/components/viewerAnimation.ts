export interface AnimationToggleStateInput {
  hasAnimations: boolean
  animationPlaying: boolean
}

export interface AnimationToggleState {
  disabled: boolean
  label: 'No animation clips' | 'Play animation' | 'Pause animation'
  pressed?: boolean
}

export interface AnimationIsolationSnapshot {
  wasPlaying: boolean
}

export interface AnimationActionLike {
  enabled: boolean
  paused: boolean
  time?: number
  play: () => unknown
  stop?: () => unknown
  reset?: () => unknown
}

export interface AnimationMixerLike {
  time?: number
  setTime?: (timeSeconds: number) => unknown
}

export interface AnimationPlaybackResetResult {
  resetActionCount: number
  mixerTimeSeconds: 0
}

export type AnimationPlaybackOwner = 'global-glb' | 'pose-clip-preview' | 'motion-retarget-local-preview'

export interface GlobalAnimationPlaybackState {
  owner: 'global-glb'
  animationPlaying: boolean
}

export interface ScopedAnimationPlaybackState {
  owner: Exclude<AnimationPlaybackOwner, 'global-glb'>
  restoreGlobalAnimationPlaying: boolean
}

export function resolveAnimationAvailability(animations: readonly unknown[]): boolean {
  return animations.length > 0
}

export function resolveAnimationToggleState({
  hasAnimations,
  animationPlaying,
}: AnimationToggleStateInput): AnimationToggleState {
  if (!hasAnimations) {
    return {
      disabled: true,
      label: 'No animation clips',
      pressed: undefined,
    }
  }

  return {
    disabled: false,
    label: animationPlaying ? 'Pause animation' : 'Play animation',
    pressed: animationPlaying,
  }
}

export function syncAnimationActions(actions: readonly AnimationActionLike[], animationPlaying: boolean): void {
  for (const action of actions) {
    action.enabled = true
    action.paused = !animationPlaying
    if (animationPlaying) {
      action.play()
    }
  }
}

export function isolateAnimationForPoseClipPreview(
  actions: readonly AnimationActionLike[],
  animationPlaying: boolean,
): AnimationIsolationSnapshot {
  for (const action of actions) {
    action.enabled = true
    action.paused = true
  }

  return { wasPlaying: animationPlaying }
}

export function resetAnimationPlayback({
  actions,
  mixer,
}: {
  actions: readonly AnimationActionLike[]
  mixer?: AnimationMixerLike | null
}): AnimationPlaybackResetResult {
  for (const action of actions) {
    action.stop?.()
    action.reset?.()
    action.time = 0
    action.paused = false
    action.enabled = false
  }

  mixer?.setTime?.(0)
  if (mixer) mixer.time = 0

  return { resetActionCount: actions.length, mixerTimeSeconds: 0 }
}

export function startGlobalAnimationPlayback({
  hasAnimations,
  animationPlaying,
}: {
  hasAnimations: boolean
  animationPlaying: boolean
}): GlobalAnimationPlaybackState {
  return {
    owner: 'global-glb',
    animationPlaying: hasAnimations ? !animationPlaying : false,
  }
}

export function startScopedAnimationPlayback({
  owner,
  globalAnimationPlaying,
}: {
  owner: ScopedAnimationPlaybackState['owner']
  globalAnimationPlaying: boolean
}): ScopedAnimationPlaybackState {
  return {
    owner,
    restoreGlobalAnimationPlaying: globalAnimationPlaying,
  }
}

export function finishScopedAnimationPlayback(state: ScopedAnimationPlaybackState): GlobalAnimationPlaybackState {
  return {
    owner: 'global-glb',
    animationPlaying: state.restoreGlobalAnimationPlaying,
  }
}

export interface AnimationToggleStateInput {
  hasAnimations: boolean
  animationPlaying: boolean
}

export interface AnimationToggleState {
  disabled: boolean
  label: 'No animation clips' | 'Play animation' | 'Pause animation'
  pressed?: boolean
}

export interface AnimationActionLike {
  enabled: boolean
  paused: boolean
  play: () => unknown
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

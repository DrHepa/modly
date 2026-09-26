import { LoopOnce, LoopRepeat, type AnimationAction } from 'three'

/** Maps elapsed playback time using the selected loaded clip, never resource metadata. */
export function worldGltfAnimationTime(
  duration: number,
  speed: number,
  loop: boolean,
  elapsedSeconds: number,
): number {
  if (!Number.isFinite(duration) || duration < 0
    || !Number.isFinite(speed)
    || !Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
    throw new RangeError('Animation timing requires finite duration, speed and nonnegative elapsed time.')
  }
  if (duration === 0) return 0
  const distance = elapsedSeconds * speed
  if (!Number.isFinite(distance)) throw new RangeError('Animation elapsed playback time is out of range.')
  if (loop) {
    const remainder = distance % duration
    // Keep forward remainder precision and avoid negative zero at wrap boundaries.
    return remainder === 0 ? 0 : remainder < 0 ? remainder + duration : remainder
  }
  const origin = speed < 0 ? duration : 0
  return Math.max(0, Math.min(duration, origin + distance))
}

/** Reset first: Three's reset clears time even when timeScale is negative. */
export function initializeWorldGltfAnimation(action: AnimationAction, loop: boolean, speed: number): void {
  const duration = action.getClip().duration
  const initialTime = worldGltfAnimationTime(duration, speed, loop, 0)
  action.reset()
  action.loop = loop ? LoopRepeat : LoopOnce
  action.clampWhenFinished = !loop
  action.timeScale = speed
  action.time = initialTime
  action.play()
  // Three's repeat wrap divides by duration on nonzero deltas; hold empty clips.
  if (duration === 0) action.paused = true
}

export type WorldGltfIndexedClipSelection<T> =
  | { readonly success: true; readonly clip: T }
  | { readonly success: false; readonly reason: 'invalid-index' | 'index-out-of-range' | 'name-mismatch' }

/** Explicit index only. Callers own their unchanged legacy policy when the index is absent. */
export function selectWorldGltfAnimationByIndex<T extends { readonly name: string }>(
  clips: readonly T[],
  selector: { readonly clipIndex?: unknown; readonly clipName?: string },
): WorldGltfIndexedClipSelection<T> {
  const index = selector.clipIndex
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
    return { success: false, reason: 'invalid-index' }
  }
  const clip = clips[index]
  if (!clip) return { success: false, reason: 'index-out-of-range' }
  if (selector.clipName !== undefined && selector.clipName !== clip.name) {
    return { success: false, reason: 'name-mismatch' }
  }
  return { success: true, clip }
}

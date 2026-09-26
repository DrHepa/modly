import type { WorldPlayState } from '../core/worldSessions.ts'

export const WORLD_FIXED_STEP_SECONDS = 1 / 60
export const WORLD_MAX_RECOVERY_STEPS = 4

export interface WorldFixedStepAdvance {
  steps: number
  /** Remaining sub-step fraction, suitable for render interpolation. */
  alpha: number
  /** Whole-step wall time intentionally discarded after a long stall. */
  droppedSeconds: number
}

export class WorldFixedStepClock {
  private lastTimestampMs: number | null = null
  private accumulatorSeconds = 0
  private paused = false

  advance(timestampMs: number): WorldFixedStepAdvance {
    if (!Number.isFinite(timestampMs)) throw new TypeError('World runtime timestamp must be finite.')
    if (this.paused) return { steps: 0, alpha: 0, droppedSeconds: 0 }
    if (this.lastTimestampMs === null || timestampMs < this.lastTimestampMs) {
      this.lastTimestampMs = timestampMs
      this.accumulatorSeconds = 0
      return { steps: 0, alpha: 0, droppedSeconds: 0 }
    }

    const elapsedSeconds = Math.max(0, (timestampMs - this.lastTimestampMs) / 1_000)
    this.lastTimestampMs = timestampMs
    this.accumulatorSeconds += elapsedSeconds
    const availableSteps = Math.floor((this.accumulatorSeconds + 1e-12) / WORLD_FIXED_STEP_SECONDS)
    const steps = Math.min(availableSteps, WORLD_MAX_RECOVERY_STEPS)
    const droppedSteps = Math.max(0, availableSteps - steps)
    this.accumulatorSeconds -= (steps + droppedSteps) * WORLD_FIXED_STEP_SECONDS
    if (this.accumulatorSeconds < 0 && this.accumulatorSeconds > -1e-12) this.accumulatorSeconds = 0
    return {
      steps,
      alpha: Math.min(0.999999999999, Math.max(0, this.accumulatorSeconds / WORLD_FIXED_STEP_SECONDS)),
      droppedSeconds: droppedSteps * WORLD_FIXED_STEP_SECONDS,
    }
  }

  pause(): void {
    this.paused = true
    this.lastTimestampMs = null
    this.accumulatorSeconds = 0
  }

  resume(): void {
    this.paused = false
    this.lastTimestampMs = null
    this.accumulatorSeconds = 0
  }

  reset(): void {
    this.paused = false
    this.lastTimestampMs = null
    this.accumulatorSeconds = 0
  }
}

export class WorldRuntimeAnimationGate {
  private wasPlaying = false

  advance(lifecycle: WorldPlayState, deltaSeconds: number, update: (deltaSeconds: number) => void): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) throw new TypeError('World animation delta must be finite and non-negative.')
    if (lifecycle !== 'playing') {
      this.wasPlaying = false
      return
    }
    if (!this.wasPlaying) {
      this.wasPlaying = true
      return
    }
    update(deltaSeconds)
  }
}

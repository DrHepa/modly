import type { WorldRationalTime } from '../core/worldModel.ts'

export const WORLD_SEQUENCE_FPS_VALUES = [24, 25, 30, 60] as const
export type WorldSequenceFps = typeof WORLD_SEQUENCE_FPS_VALUES[number]

export interface WorldFrameTime {
  readonly index: number
  readonly time: WorldRationalTime
  /** Exact presentation duration; the final sample may be shorter than 1/fps. */
  readonly duration: WorldRationalTime
  /** Nearest integer microsecond derived from the exact rational frame time. */
  readonly timestampMicroseconds: number
}

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)
const DEFAULT_MAXIMUM_FRAME_COUNT = 1_000_000

export function normalizeWorldRationalTime(value: WorldRationalTime): WorldRationalTime {
  assertRationalInput(value)
  return fromBigInt(BigInt(value.numerator), BigInt(value.denominator))
}

export function compareWorldRationalTime(left: WorldRationalTime, right: WorldRationalTime): -1 | 0 | 1 {
  assertRationalInput(left)
  assertRationalInput(right)
  const leftValue = BigInt(left.numerator) * BigInt(right.denominator)
  const rightValue = BigInt(right.numerator) * BigInt(left.denominator)
  const direction = Math.sign(left.denominator) * Math.sign(right.denominator)
  const comparison = leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
  return (direction < 0 ? -comparison : comparison) as -1 | 0 | 1
}

export function addWorldRationalTime(left: WorldRationalTime, right: WorldRationalTime): WorldRationalTime {
  const a = toBigInt(left)
  const b = toBigInt(right)
  return fromBigInt(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator)
}

export function subtractWorldRationalTime(left: WorldRationalTime, right: WorldRationalTime): WorldRationalTime {
  const a = toBigInt(left)
  const b = toBigInt(right)
  return fromBigInt(a.numerator * b.denominator - b.numerator * a.denominator, a.denominator * b.denominator)
}

export function multiplyWorldRationalTime(left: WorldRationalTime, right: WorldRationalTime): WorldRationalTime {
  const a = toBigInt(left)
  const b = toBigInt(right)
  return fromBigInt(a.numerator * b.numerator, a.denominator * b.denominator)
}

export function clampWorldRationalTime(value: WorldRationalTime, minimum: WorldRationalTime, maximum: WorldRationalTime): WorldRationalTime {
  const normalizedMinimum = normalizeWorldRationalTime(minimum)
  const normalizedMaximum = normalizeWorldRationalTime(maximum)
  if (compareWorldRationalTime(normalizedMinimum, normalizedMaximum) > 0) throw new RangeError('Rational clamp minimum cannot exceed maximum.')
  if (compareWorldRationalTime(value, normalizedMinimum) < 0) return normalizedMinimum
  if (compareWorldRationalTime(value, normalizedMaximum) > 0) return normalizedMaximum
  return normalizeWorldRationalTime(value)
}

/** Floating-point conversion is intentionally confined to display/sampling output. */
export function worldRationalTimeToSeconds(value: WorldRationalTime): number {
  const normalized = normalizeWorldRationalTime(value)
  return normalized.numerator / normalized.denominator
}

/**
 * Converts `(numeratorLeft - numeratorRight) / (denominatorLeft - denominatorRight)`
 * only at the dimensionless sampling boundary. Both differences stay exact
 * BigInts, so valid wire rationals never require an unsafe intermediate
 * `WorldRationalTime` representation.
 */
export function worldRationalDifferenceRatio(
  numeratorLeft: WorldRationalTime,
  numeratorRight: WorldRationalTime,
  denominatorLeft: WorldRationalTime,
  denominatorRight: WorldRationalTime,
): number {
  const numerator = exactRationalDifference(numeratorLeft, numeratorRight)
  const denominator = exactRationalDifference(denominatorLeft, denominatorRight)
  if (denominator.numerator === 0n) throw new RangeError('Rational difference ratio denominator cannot be zero.')
  let quotientNumerator = numerator.numerator * denominator.denominator
  let quotientDenominator = numerator.denominator * denominator.numerator
  const divisor = greatestCommonDivisor(quotientNumerator, quotientDenominator)
  quotientNumerator /= divisor
  quotientDenominator /= divisor
  return Number(quotientNumerator) / Number(quotientDenominator)
}

export function snapWorldRationalTimeToFrame(value: WorldRationalTime, fps: WorldSequenceFps): WorldRationalTime {
  assertWorldSequenceFps(fps)
  const normalized = normalizeWorldRationalTime(value)
  if (normalized.numerator < 0) throw new RangeError('Frame snapping requires a non-negative rational time.')
  const numerator = BigInt(normalized.numerator) * BigInt(fps)
  const denominator = BigInt(normalized.denominator)
  let frame = numerator / denominator
  const remainder = numerator % denominator
  if (remainder * 2n >= denominator) frame += 1n
  return fromBigInt(frame, BigInt(fps))
}

export function midpointWorldRationalTime(left: WorldRationalTime, right: WorldRationalTime): WorldRationalTime {
  return multiplyWorldRationalTime(addWorldRationalTime(left, right), { numerator: 1, denominator: 2 })
}

export function enumerateWorldFrames(
  duration: WorldRationalTime,
  fps: WorldSequenceFps,
  maximumFrames = DEFAULT_MAXIMUM_FRAME_COUNT,
): readonly WorldFrameTime[] {
  assertWorldSequenceFps(fps)
  if (!Number.isSafeInteger(maximumFrames) || maximumFrames <= 0) throw new RangeError('Maximum frame count must be a positive safe integer.')
  const normalizedDuration = normalizeWorldRationalTime(duration)
  if (normalizedDuration.numerator < 0) throw new RangeError('Frame duration cannot be negative.')
  const scaledNumerator = BigInt(normalizedDuration.numerator) * BigInt(fps)
  const denominator = BigInt(normalizedDuration.denominator)
  const frameCount = scaledNumerator === 0n ? 0n : (scaledNumerator + denominator - 1n) / denominator
  if (frameCount > BigInt(maximumFrames)) throw new RangeError(`Frame enumeration exceeds its ${maximumFrames}-frame safety bound.`)

  const frames: WorldFrameTime[] = []
  const count = checkedSafeNumber(frameCount)
  for (let index = 0; index < count; index += 1) {
    const exactTime = fromBigInt(BigInt(index), BigInt(fps))
    if (compareWorldRationalTime(exactTime, normalizedDuration) >= 0) break
    const nominalEnd = fromBigInt(BigInt(index + 1), BigInt(fps))
    const exactEnd = compareWorldRationalTime(nominalEnd, normalizedDuration) <= 0
      ? nominalEnd
      : normalizedDuration
    const frameDuration = subtractWorldRationalTime(exactEnd, exactTime)
    if (compareWorldRationalTime(frameDuration, { numerator: 0, denominator: 1 }) <= 0) {
      throw new RangeError('Frame duration must remain positive.')
    }
    frames.push({
      index,
      time: exactTime,
      duration: frameDuration,
      timestampMicroseconds: checkedSafeNumber(roundPositiveRatio(BigInt(index) * 1_000_000n, BigInt(fps))),
    })
  }
  return frames
}

export function worldRationalTimeKey(value: WorldRationalTime): string {
  const normalized = normalizeWorldRationalTime(value)
  return `${normalized.numerator}/${normalized.denominator}`
}

function assertWorldSequenceFps(value: number): asserts value is WorldSequenceFps {
  if (!(WORLD_SEQUENCE_FPS_VALUES as readonly number[]).includes(value)) throw new RangeError('World sequence FPS must be 24, 25, 30, or 60.')
}

function assertRationalInput(value: WorldRationalTime): void {
  if (!value || !Number.isSafeInteger(value.numerator) || !Number.isSafeInteger(value.denominator)) {
    throw new TypeError('Rational numerator and denominator must be safe integers.')
  }
  if (value.denominator === 0) throw new RangeError('Rational denominator cannot be zero.')
}

function toBigInt(value: WorldRationalTime): { numerator: bigint; denominator: bigint } {
  assertRationalInput(value)
  let numerator = BigInt(value.numerator)
  let denominator = BigInt(value.denominator)
  if (denominator < 0n) {
    numerator = -numerator
    denominator = -denominator
  }
  return { numerator, denominator }
}

function exactRationalDifference(
  left: WorldRationalTime,
  right: WorldRationalTime,
): { readonly numerator: bigint; readonly denominator: bigint } {
  const normalizedLeft = toBigInt(left)
  const normalizedRight = toBigInt(right)
  return {
    numerator: normalizedLeft.numerator * normalizedRight.denominator - normalizedRight.numerator * normalizedLeft.denominator,
    denominator: normalizedLeft.denominator * normalizedRight.denominator,
  }
}

function fromBigInt(rawNumerator: bigint, rawDenominator: bigint): WorldRationalTime {
  if (rawDenominator === 0n) throw new RangeError('Rational denominator cannot be zero.')
  let numerator = rawNumerator
  let denominator = rawDenominator
  if (denominator < 0n) {
    numerator = -numerator
    denominator = -denominator
  }
  if (numerator === 0n) return { numerator: 0, denominator: 1 }
  const divisor = greatestCommonDivisor(numerator, denominator)
  numerator /= divisor
  denominator /= divisor
  return { numerator: checkedSafeNumber(numerator), denominator: checkedSafeNumber(denominator) }
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left
  let b = right < 0n ? -right : right
  while (b !== 0n) {
    const remainder = a % b
    a = b
    b = remainder
  }
  return a
}

function checkedSafeNumber(value: bigint): number {
  if (value > MAX_SAFE_BIGINT || value < -MAX_SAFE_BIGINT) throw new RangeError('Exact rational result exceeds the safe-integer range.')
  return Number(value)
}

function roundPositiveRatio(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator
  return numerator % denominator * 2n >= denominator ? quotient + 1n : quotient
}

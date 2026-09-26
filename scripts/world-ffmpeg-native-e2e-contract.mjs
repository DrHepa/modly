const AUDIO_SAMPLE_RATE = 48_000n

export const WORLD_FFMPEG_NATIVE_CASES = Object.freeze([
  Object.freeze({ id: 'aligned-100ms-at-30fps', fps: 30, duration: Object.freeze({ numerator: 1, denominator: 10 }) }),
  Object.freeze({ id: 'partial-115ms-at-30fps', fps: 30, duration: Object.freeze({ numerator: 23, denominator: 200 }) }),
  Object.freeze({ id: 'partial-1010ms-at-30fps', fps: 30, duration: Object.freeze({ numerator: 101, denominator: 100 }) }),
  Object.freeze({ id: 'one-frame-10ms-at-30fps', fps: 30, duration: Object.freeze({ numerator: 1, denominator: 100 }) }),
])

export function worldFfmpegNativeCasePlan(input) {
  const fps = requireSafePositiveInteger(input?.fps, 'fps')
  const duration = normalizeRational(input?.duration, 'duration')
  const frameCountBig = ceilDivide(duration.numerator * BigInt(fps), duration.denominator)
  if (frameCountBig < 1n || frameCountBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('World FFmpeg native case frame count is out of range.')
  }
  const priorFrameCount = frameCountBig - 1n
  const finalFrameDuration = normalizeBigRational(
    duration.numerator * BigInt(fps) - priorFrameCount * duration.denominator,
    duration.denominator * BigInt(fps),
    'final frame duration',
  )
  const audioSampleNumerator = duration.numerator * AUDIO_SAMPLE_RATE
  if (audioSampleNumerator % duration.denominator !== 0n) {
    throw new Error('World FFmpeg native proof duration is not exactly representable at 48 kHz.')
  }
  const audioSampleCountBig = audioSampleNumerator / duration.denominator
  if (audioSampleCountBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('World FFmpeg native case audio sample count is out of range.')
  }
  return {
    fps,
    frameCount: Number(frameCountBig),
    audioSampleCount: Number(audioSampleCountBig),
    duration: { numerator: Number(duration.numerator), denominator: Number(duration.denominator) },
    finalFrameDuration: {
      numerator: Number(finalFrameDuration.numerator),
      denominator: Number(finalFrameDuration.denominator),
    },
  }
}

function requireSafePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`World FFmpeg native case ${label} is invalid.`)
  }
  return value
}

function normalizeRational(value, label) {
  if (!value || typeof value !== 'object') throw new Error(`World FFmpeg native case ${label} is invalid.`)
  const numerator = requireSafePositiveInteger(value.numerator, `${label} numerator`)
  const denominator = requireSafePositiveInteger(value.denominator, `${label} denominator`)
  return normalizeBigRational(BigInt(numerator), BigInt(denominator), label)
}

function normalizeBigRational(numerator, denominator, label) {
  if (numerator < 1n || denominator < 1n) throw new Error(`World FFmpeg native case ${label} is invalid.`)
  const divisor = greatestCommonDivisor(numerator, denominator)
  return { numerator: numerator / divisor, denominator: denominator / divisor }
}

function ceilDivide(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator
}

function greatestCommonDivisor(left, right) {
  let a = left
  let b = right
  while (b !== 0n) {
    const remainder = a % b
    a = b
    b = remainder
  }
  return a
}

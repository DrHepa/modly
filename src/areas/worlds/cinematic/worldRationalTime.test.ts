import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addWorldRationalTime,
  clampWorldRationalTime,
  compareWorldRationalTime,
  enumerateWorldFrames,
  multiplyWorldRationalTime,
  normalizeWorldRationalTime,
  snapWorldRationalTimeToFrame,
  subtractWorldRationalTime,
  worldRationalDifferenceRatio,
  worldRationalTimeToSeconds,
} from './worldRationalTime.ts'

test('normalizes signed rationals and performs exact BigInt-backed arithmetic', () => {
  assert.deepEqual(normalizeWorldRationalTime({ numerator: 6, denominator: -8 }), { numerator: -3, denominator: 4 })
  assert.deepEqual(normalizeWorldRationalTime({ numerator: 0, denominator: -99 }), { numerator: 0, denominator: 1 })
  assert.deepEqual(addWorldRationalTime({ numerator: 1, denominator: 3 }, { numerator: 1, denominator: 6 }), { numerator: 1, denominator: 2 })
  assert.deepEqual(subtractWorldRationalTime({ numerator: 1, denominator: 6 }, { numerator: 1, denominator: 2 }), { numerator: -1, denominator: 3 })
  assert.deepEqual(multiplyWorldRationalTime({ numerator: -2, denominator: 3 }, { numerator: 9, denominator: 4 }), { numerator: -3, denominator: 2 })
})

test('compares large safe integers exactly without floating-point cross-product loss', () => {
  const maximum = Number.MAX_SAFE_INTEGER
  const left = { numerator: maximum, denominator: maximum - 1 }
  const right = { numerator: maximum - 1, denominator: maximum - 2 }
  assert.equal(compareWorldRationalTime(left, right), -1)
  assert.equal(compareWorldRationalTime(right, left), 1)
  assert.equal(compareWorldRationalTime({ numerator: 2, denominator: 6 }, { numerator: 1, denominator: 3 }), 0)
})

test('clamps exactly and converts to floating point only at the display boundary', () => {
  const minimum = { numerator: 1, denominator: 4 }
  const maximum = { numerator: 3, denominator: 4 }
  assert.deepEqual(clampWorldRationalTime({ numerator: 1, denominator: 10 }, minimum, maximum), minimum)
  assert.deepEqual(clampWorldRationalTime({ numerator: 9, denominator: 10 }, minimum, maximum), maximum)
  assert.deepEqual(clampWorldRationalTime({ numerator: 1, denominator: 2 }, minimum, maximum), { numerator: 1, denominator: 2 })
  assert.equal(worldRationalTimeToSeconds({ numerator: 1, denominator: 8 }), 0.125)
})

test('converts a ratio of exact rational differences without materializing unsafe wire rationals', () => {
  const maximum = Number.MAX_SAFE_INTEGER
  const earliest = { numerator: 1, denominator: maximum }
  const interior = { numerator: 1, denominator: maximum - 1 }
  const latest = { numerator: 1, denominator: maximum - 2 }

  const ratio = worldRationalDifferenceRatio(interior, earliest, latest, earliest)
  assert.equal(ratio, Number(BigInt(maximum - 2)) / Number(2n * BigInt(maximum - 1)))
  assert.ok(ratio > 0 && ratio < 1)
})

for (const fps of [24, 25, 30, 60] as const) {
  test(`enumerates one second at ${fps} fps exactly over [0, duration)`, () => {
    const frames = enumerateWorldFrames({ numerator: 1, denominator: 1 }, fps)
    assert.equal(frames.length, fps)
    assert.deepEqual(frames[0], {
      index: 0,
      time: { numerator: 0, denominator: 1 },
      duration: { numerator: 1, denominator: fps },
      timestampMicroseconds: 0,
    })
    assert.deepEqual(frames.at(-1)?.time, { numerator: fps - 1, denominator: fps })
    assert.ok(frames.every((frame) => Number.isSafeInteger(frame.timestampMicroseconds)))
    assert.equal(new Set(frames.map((frame) => frame.timestampMicroseconds)).size, frames.length)
    assert.ok(frames.every((frame) => compareWorldRationalTime(frame.time, { numerator: 1, denominator: 1 }) < 0))
  })
}

test('uses exact frame inclusion for fractional durations and never duplicates the endpoint', () => {
  const frames = enumerateWorldFrames({ numerator: 1, denominator: 10 }, 24)
  assert.deepEqual(frames.map((frame) => frame.time), [
    { numerator: 0, denominator: 1 },
    { numerator: 1, denominator: 24 },
    { numerator: 1, denominator: 12 },
  ])
  assert.equal(compareWorldRationalTime(frames.at(-1)!.time, { numerator: 1, denominator: 10 }) < 0, true)
})

test('shortens only the final presentation sample to an exact non-frame-aligned duration', () => {
  const frames = enumerateWorldFrames({ numerator: 101, denominator: 100 }, 30)

  assert.equal(frames.length, 31)
  assert.deepEqual(frames.slice(0, -1).map((frame) => frame.duration),
    Array.from({ length: 30 }, () => ({ numerator: 1, denominator: 30 })))
  assert.deepEqual(frames.at(-1), {
    index: 30,
    time: { numerator: 1, denominator: 1 },
    duration: { numerator: 1, denominator: 100 },
    timestampMicroseconds: 1_000_000,
  })
  assert.deepEqual(
    addWorldRationalTime(frames.at(-1)!.time, frames.at(-1)!.duration),
    { numerator: 101, denominator: 100 },
  )

  const subMicrosecondRemainder = enumerateWorldFrames({ numerator: 60_000_001, denominator: 60_000_000 }, 60)
  assert.deepEqual(subMicrosecondRemainder.at(-1)?.duration, { numerator: 1, denominator: 60_000_000 })
  assert.equal(compareWorldRationalTime(subMicrosecondRemainder.at(-1)!.duration, { numerator: 0, denominator: 1 }) > 0, true)
})

test('snaps to the nearest selected frame with deterministic half-up ties', () => {
  assert.deepEqual(snapWorldRationalTimeToFrame({ numerator: 1, denominator: 20 }, 24), { numerator: 1, denominator: 24 })
  assert.deepEqual(snapWorldRationalTimeToFrame({ numerator: 1, denominator: 48 }, 24), { numerator: 1, denominator: 24 })
  assert.deepEqual(snapWorldRationalTimeToFrame({ numerator: 7, denominator: 100 }, 25), { numerator: 2, denominator: 25 })
})

test('rejects unsafe or unbounded rational/frame outputs instead of losing precision', () => {
  assert.throws(() => normalizeWorldRationalTime({ numerator: Number.MAX_SAFE_INTEGER + 1, denominator: 1 }), /safe integers/)
  assert.throws(() => addWorldRationalTime({ numerator: Number.MAX_SAFE_INTEGER, denominator: 1 }, { numerator: 1, denominator: 1 }), /safe-integer range/)
  assert.throws(() => enumerateWorldFrames({ numerator: 1_000_001, denominator: 1 }, 60), /frame safety bound/)
})

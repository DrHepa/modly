import assert from 'node:assert/strict'
import test from 'node:test'

import {
  encodeStereoPcm16Wav,
  floatSampleToPcm16,
  worldAudioSampleCount,
} from './worldOfflineAudio.ts'

test('PCM16 conversion clamps edges and uses the documented asymmetric full scale', () => {
  assert.equal(floatSampleToPcm16(Number.NaN), 0)
  assert.equal(floatSampleToPcm16(-2), -32768)
  assert.equal(floatSampleToPcm16(-1), -32768)
  assert.equal(floatSampleToPcm16(-0.5), -16384)
  assert.equal(floatSampleToPcm16(0), 0)
  assert.equal(floatSampleToPcm16(0.5), 16384)
  assert.equal(floatSampleToPcm16(1), 32767)
  assert.equal(floatSampleToPcm16(2), 32767)
})

test('stereo WAV has an exact canonical header and interleaved sample count', () => {
  const left = new Float32Array([-1, 0.5, 1])
  const right = new Float32Array([1, -0.5, 0])
  const bytes = encodeStereoPcm16Wav(left, right)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'RIFF')
  assert.equal(view.getUint32(4, true), bytes.byteLength - 8)
  assert.equal(new TextDecoder().decode(bytes.subarray(8, 12)), 'WAVE')
  assert.equal(view.getUint16(20, true), 1)
  assert.equal(view.getUint16(22, true), 2)
  assert.equal(view.getUint32(24, true), 48_000)
  assert.equal(view.getUint32(28, true), 48_000 * 2 * 2)
  assert.equal(view.getUint16(32, true), 4)
  assert.equal(view.getUint16(34, true), 16)
  assert.equal(new TextDecoder().decode(bytes.subarray(36, 40)), 'data')
  assert.equal(view.getUint32(40, true), 3 * 2 * 2)
  assert.deepEqual(
    Array.from({ length: 6 }, (_, index) => view.getInt16(44 + index * 2, true)),
    [-32768, 32767, 16384, -16384, 32767, 0],
  )
})

test('sample count floors the exact rational duration without floating drift', () => {
  assert.equal(worldAudioSampleCount({ numerator: 1, denominator: 3 }), 16_000)
  assert.equal(worldAudioSampleCount({ numerator: 1001, denominator: 30_000 }), 1_601)
  assert.equal(worldAudioSampleCount({ numerator: 0, denominator: 1 }), 0)
})

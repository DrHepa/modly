import type { WorldRationalTime } from '../core/worldModel.ts'

export const WORLD_OFFLINE_AUDIO_SAMPLE_RATE = 48_000 as const
export const WORLD_OFFLINE_AUDIO_CHANNELS = 2 as const
export const WORLD_OFFLINE_AUDIO_BITS_PER_SAMPLE = 16 as const

/**
 * Deterministic PCM16 conversion. Non-finite input is silence. Negative
 * full-scale uses -32768 and positive full-scale uses 32767; Math.round is
 * deliberately the only rounding operation.
 */
export function floatSampleToPcm16(value: number): number {
  if (!Number.isFinite(value)) return 0
  const sample = Math.max(-1, Math.min(1, value))
  return sample < 0
    ? Math.max(-32768, Math.round(sample * 32768))
    : Math.min(32767, Math.round(sample * 32767))
}

export function worldAudioSampleCount(duration: WorldRationalTime): number {
  if (!Number.isSafeInteger(duration.numerator) || !Number.isSafeInteger(duration.denominator)
    || duration.numerator < 0 || duration.denominator <= 0) {
    throw new TypeError('World audio duration must be a non-negative safe rational.')
  }
  const samples = (BigInt(duration.numerator) * BigInt(WORLD_OFFLINE_AUDIO_SAMPLE_RATE))
    / BigInt(duration.denominator)
  if (samples > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('World audio duration exceeds the sample bound.')
  return Number(samples)
}

export function encodeStereoPcm16Wav(left: Float32Array, right: Float32Array): Uint8Array {
  if (left.length !== right.length) throw new TypeError('Stereo channels must have identical sample counts.')
  const dataBytes = left.length * WORLD_OFFLINE_AUDIO_CHANNELS * (WORLD_OFFLINE_AUDIO_BITS_PER_SAMPLE / 8)
  if (!Number.isSafeInteger(dataBytes) || dataBytes > 0xffff_ffff - 36) {
    throw new RangeError('PCM16 WAV exceeds the RIFF size bound.')
  }
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  writeAscii(bytes, 0, 'RIFF')
  view.setUint32(4, bytes.byteLength - 8, true)
  writeAscii(bytes, 8, 'WAVE')
  writeAscii(bytes, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, WORLD_OFFLINE_AUDIO_CHANNELS, true)
  view.setUint32(24, WORLD_OFFLINE_AUDIO_SAMPLE_RATE, true)
  view.setUint32(28, WORLD_OFFLINE_AUDIO_SAMPLE_RATE * WORLD_OFFLINE_AUDIO_CHANNELS * 2, true)
  view.setUint16(32, WORLD_OFFLINE_AUDIO_CHANNELS * 2, true)
  view.setUint16(34, WORLD_OFFLINE_AUDIO_BITS_PER_SAMPLE, true)
  writeAscii(bytes, 36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let index = 0; index < left.length; index += 1) {
    const offset = 44 + index * 4
    view.setInt16(offset, floatSampleToPcm16(left[index]), true)
    view.setInt16(offset + 2, floatSampleToPcm16(right[index]), true)
  }
  return bytes
}

export function encodeSilentStereoPcm16Wav(sampleCount: number): Uint8Array {
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 0) throw new TypeError('Sample count is invalid.')
  return encodeStereoPcm16Wav(new Float32Array(sampleCount), new Float32Array(sampleCount))
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index)
}

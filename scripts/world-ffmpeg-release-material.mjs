const RECEIPT_SCHEMA = 'modly.world-ffmpeg-release-verification.v1'
export const WORLD_FFMPEG_RELEASE_VERIFICATION_RECEIPT = 'ffmpeg-7.1.1-release-verification.v1.json'
export const WORLD_FFMPEG_CANONICAL_SOURCE_ENTRIES = Object.freeze([
  'ffmpeg-7.1.1-release-verification.v1.json',
  'ffmpeg-7.1.1.tar.xz',
  'libvpx-1.15.2.tar.gz',
  'opus-1.5.2.tar.gz',
  'zlib-1.3.2.tar.gz',
])

export function createWorldFfmpegReleaseVerificationReceipt(contract) {
  const ffmpeg = contract?.sources?.[0]
  const signature = contract?.ffmpegReleaseSignature
  if (ffmpeg?.name !== 'ffmpeg' || ffmpeg.version !== '7.1.1'
    || typeof ffmpeg.archive !== 'string' || !isSha256(ffmpeg.sha256)
    || typeof signature?.fingerprint !== 'string' || !/^[A-F0-9]{40}$/.test(signature.fingerprint)) {
    throw new Error('World FFmpeg release-verification authority is invalid.')
  }
  return Object.freeze({
    schema: RECEIPT_SCHEMA,
    ffmpegArchive: ffmpeg.archive,
    ffmpegSha256: ffmpeg.sha256,
    signerFingerprint: signature.fingerprint,
    verification: 'detached-signature-valid',
  })
}

export function validateWorldFfmpegReleaseVerificationReceipt(value, contract) {
  if (!exactRecord(value, [
    'schema', 'ffmpegArchive', 'ffmpegSha256', 'signerFingerprint', 'verification',
  ])) return false
  try {
    const expected = createWorldFfmpegReleaseVerificationReceipt(contract)
    return JSON.stringify(value) === JSON.stringify(expected)
  } catch {
    return false
  }
}

export function worldFfmpegReleaseVerificationReceiptBytes(contract) {
  return Buffer.from(`${JSON.stringify(createWorldFfmpegReleaseVerificationReceipt(contract))}\n`)
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false
  const actual = Object.keys(value).sort(codeUnitCompare)
  const expected = [...keys].sort(codeUnitCompare)
  return actual.length === expected.length && actual.every((entry, index) => entry === expected[index])
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

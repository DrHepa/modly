import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

export type HttpsDownloadAsset = {
  url: string
  filename: string
  sizeBytes: number
  sha256: string
}

export type HttpsMarkerAsset = {
  filename: string
  size_bytes: number
  sha256: string
}

type RawHttpsDownloadAsset = {
  url?: unknown
  filename?: unknown
  size_bytes?: unknown
  sha256?: unknown
  [key: string]: unknown
}

const ASSET_FIELDS = new Set([
  'url',
  'filename',
  'size_bytes',
  'sha256',
])
const SAFE_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u
const SHA256_RE = /^[0-9a-f]{64}$/u

function assertExactFields(
  value: Record<string, unknown>,
  expected: ReadonlySet<string>,
  context: string,
): void {
  const fields = new Set(Object.keys(value))
  const missing = [...expected].filter((field) => !fields.has(field))
  const unknown = [...fields].filter((field) => !expected.has(field))

  if (missing.length > 0) {
    throw new Error(
      context + ' is missing required fields: ' + missing.sort().join(', '),
    )
  }
  if (unknown.length > 0) {
    throw new Error(
      context + ' has unknown fields: ' + unknown.sort().join(', '),
    )
  }
}

type IpRange = readonly [network: string, prefixLength: number]

const IPV4_NON_GLOBAL_RANGES: readonly IpRange[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['240.0.0.0', 4],
]
const IPV4_GLOBAL_EXCEPTIONS: readonly IpRange[] = [
  ['192.0.0.9', 32],
  ['192.0.0.10', 32],
]

const IPV6_NON_GLOBAL_RANGES: readonly IpRange[] = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
]
const IPV6_GLOBAL_EXCEPTIONS: readonly IpRange[] = [
  ['2001:1::1', 128],
  ['2001:1::2', 128],
  ['2001:3::', 32],
  ['2001:4:112::', 48],
  ['2001:20::', 28],
  ['2001:30::', 28],
]

function ipv4ToNumber(address: string): number {
  return address.split('.').reduce(
    (value, octet) => ((value << 8) | Number(octet)) >>> 0,
    0,
  )
}

function ipv4InRange(value: number, range: IpRange): boolean {
  const [network, prefixLength] = range
  if (prefixLength === 0) return true
  const mask = (0xffffffff << (32 - prefixLength)) >>> 0
  return (value & mask) >>> 0 === (ipv4ToNumber(network) & mask) >>> 0
}

function isGlobalIpv4Number(value: number): boolean {
  if (IPV4_GLOBAL_EXCEPTIONS.some((range) => ipv4InRange(value, range))) {
    return true
  }
  return !IPV4_NON_GLOBAL_RANGES.some((range) => ipv4InRange(value, range))
}

function ipv6ToBigInt(address: string): bigint {
  let normalized = address
  if (normalized.includes('.')) {
    const separator = normalized.lastIndexOf(':')
    const ipv4 = ipv4ToNumber(normalized.slice(separator + 1))
    normalized = normalized.slice(0, separator)
      + ':' + ((ipv4 >>> 16) & 0xffff).toString(16)
      + ':' + (ipv4 & 0xffff).toString(16)
  }

  const halves = normalized.split('::')
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const parts = halves.length === 2
    ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
    : head

  return parts.reduce(
    (value, part) => (value << 16n) | BigInt('0x' + part),
    0n,
  )
}

function ipv6InRange(value: bigint, range: IpRange): boolean {
  const [network, prefixLength] = range
  if (prefixLength === 0) return true
  const shift = BigInt(128 - prefixLength)
  return value >> shift === ipv6ToBigInt(network) >> shift
}

function isGlobalIpv6(value: bigint): boolean {
  const mappedPrefix = ipv6ToBigInt('::ffff:0:0')
  if (value >> 32n === mappedPrefix >> 32n) {
    return isGlobalIpv4Number(Number(value & 0xffffffffn))
  }
  if (IPV6_GLOBAL_EXCEPTIONS.some((range) => ipv6InRange(value, range))) {
    return true
  }
  return !IPV6_NON_GLOBAL_RANGES.some((range) => ipv6InRange(value, range))
}

function assertStaticGlobalHostname(hostnameValue: string, context: string): void {
  const hostname = hostnameValue
    .replace(/^\[|\]$/gu, '')
    .replace(/\.+$/gu, '')
    .toLowerCase()

  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
  ) {
    throw new Error(context + ' must not target a local host')
  }

  const addressFamily = isIP(hostname)
  const globallyRoutable = addressFamily === 4
    ? isGlobalIpv4Number(ipv4ToNumber(hostname))
    : addressFamily === 6
      ? isGlobalIpv6(ipv6ToBigInt(hostname))
      : true

  if (!globallyRoutable) {
    throw new Error(context + ' must target a globally routable host')
  }
}

function normalizeHttpsUrl(value: unknown, context: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 4096
    || /\s/u.test(value)
  ) {
    throw new Error(context + ' must be an absolute HTTPS URL')
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(context + ' must be an absolute HTTPS URL')
  }

  if (parsed.protocol !== 'https:' || !parsed.hostname) {
    throw new Error(context + ' must be an absolute HTTPS URL')
  }
  if (parsed.username || parsed.password) {
    throw new Error(context + ' must not contain credentials')
  }
  if (parsed.hash) {
    throw new Error(context + ' must not contain a URL fragment')
  }
  if (parsed.port === '0') {
    throw new Error(context + ' contains an invalid port')
  }

  assertStaticGlobalHostname(parsed.hostname, context)
  return value
}

export function normalizeHttpsDownloads(
  value: unknown,
  context = 'https_downloads',
): HttpsDownloadAsset[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(context + ' must be a non-empty array')
  }

  const filenames = new Set<string>()

  return value.map((candidate, index) => {
    const assetContext = context + '[' + index + ']'
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(assetContext + ' must be an object')
    }

    const raw = candidate as RawHttpsDownloadAsset
    assertExactFields(raw, ASSET_FIELDS, assetContext)

    const url = normalizeHttpsUrl(raw.url, assetContext + '.url')

    if (
      typeof raw.filename !== 'string'
      || !SAFE_FILENAME_RE.test(raw.filename)
    ) {
      throw new Error(assetContext + '.filename must be a safe basename')
    }
    if (filenames.has(raw.filename)) {
      throw new Error(
        context + ' contains duplicate filename: ' + raw.filename,
      )
    }
    filenames.add(raw.filename)

    if (
      typeof raw.size_bytes !== 'number'
      || !Number.isSafeInteger(raw.size_bytes)
      || raw.size_bytes <= 0
    ) {
      throw new Error(
        assetContext + '.size_bytes must be a positive safe integer',
      )
    }

    if (
      typeof raw.sha256 !== 'string'
      || !SHA256_RE.test(raw.sha256)
    ) {
      throw new Error(
        assetContext
        + '.sha256 must be a lowercase 64-character SHA-256 digest',
      )
    }

    return {
      url,
      filename: raw.filename,
      sizeBytes: raw.size_bytes,
      sha256: raw.sha256,
    }
  })
}

export function canonicalHttpsPlanJson(
  plan: readonly HttpsDownloadAsset[],
): string {
  if (!Array.isArray(plan) || plan.length === 0) {
    throw new Error('https_downloads must be a non-empty array')
  }

  return JSON.stringify(plan.map((asset) => ({
    filename: asset.filename,
    sha256: asset.sha256,
    size_bytes: asset.sizeBytes,
    url: asset.url,
  })))
}

export function httpsPlanSha256(
  plan: readonly HttpsDownloadAsset[],
): string {
  return createHash('sha256')
    .update(canonicalHttpsPlanJson(plan), 'utf8')
    .digest('hex')
}

export function expectedHttpsMarkerAssets(
  plan: readonly HttpsDownloadAsset[],
): HttpsMarkerAsset[] {
  return plan.map((asset) => ({
    filename: asset.filename,
    size_bytes: asset.sizeBytes,
    sha256: asset.sha256,
  }))
}

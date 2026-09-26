'use strict'

const { createHash } = require('node:crypto')

const CLAIM_SCHEMA = 'modly.world-ffmpeg-owned-garbage-claim.v1'
const INTENT_SCHEMA = 'modly.world-ffmpeg-owned-garbage-intent.v1'
const TOMBSTONE_SCHEMA = 'modly.world-ffmpeg-owned-garbage-tombstone.v1'
const CLAIM_PREFIX = '.WORLD_FFMPEG_GC.claim-'
const CLAIM_PATTERN = /^\.WORLD_FFMPEG_GC\.claim-([a-f0-9]{64})\.v1\.json$/
const INTENT_PATTERN = /^\.WORLD_FFMPEG_GC\.intent-([a-f0-9]{32})\.v1\.json$/
const TOMBSTONE_PATTERN = /^\.WORLD_FFMPEG_GC\.tombstone-([a-f0-9]{32})\.v1\.json$/
const QUARANTINE_DIRECTORY_PATTERN = /^\.WORLD_FFMPEG_GC\.quarantine-([a-f0-9]{32})$/
const TOKEN_PATTERN = /^[a-f0-9]{32}$/
const MAXIMUM_SUPPORTED_BYTES = 128 * 1024 * 1024 * 1024
const MAXIMUM_SUPPORTED_ENTRIES = 200_000

function sourceAuthorityFromStat(info) {
  if (!info || typeof info !== 'object' || typeof info.birthtimeNs !== 'bigint'
    || info.birthtimeNs < 1n || typeof info.ctimeNs !== 'bigint' || info.ctimeNs < 1n
    || typeof info.dev !== 'bigint' || typeof info.ino !== 'bigint'
    || typeof info.mode !== 'bigint' || typeof info.size !== 'bigint'
    || info.size < 0n || info.size > BigInt(MAXIMUM_SUPPORTED_BYTES)) {
    throw new Error('World FFmpeg garbage source birth authority is unavailable.')
  }
  return Object.freeze({
    dev: String(info.dev),
    ino: String(info.ino),
    birthtimeNs: String(info.birthtimeNs),
    ctimeNs: String(info.ctimeNs),
    mode: Number(info.mode & 0o7777n),
    size: Number(info.size),
  })
}

function claimNameFor(kind, sourceName, sourceAuthority) {
  requireKind(kind)
  requireDirectName(sourceName)
  requireSourceAuthority(sourceAuthority)
  const key = createHash('sha256').update([
    kind,
    sourceName,
    sourceAuthority.dev,
    sourceAuthority.ino,
    sourceAuthority.birthtimeNs,
  ].join('\0')).digest('hex')
  return `${CLAIM_PREFIX}${key}.v1.json`
}

function buildClaim(input) {
  const token = requireToken(input?.token)
  const sourceName = requireDirectName(input?.sourceName)
  const kind = requireKind(input?.kind)
  const sourceAuthority = requireSourceAuthority(input?.sourceAuthority)
  const value = {
    schema: CLAIM_SCHEMA,
    token,
    ownerPid: requireInteger(input?.ownerPid, 1, 0xffff_ffff, 'claim owner pid'),
    ownerToken: requireToken(input?.ownerToken),
    kind,
    label: requireLabel(input?.label),
    sourceName,
    sourceIdentity: input?.sourceIdentity,
    sourceAuthority,
    createdAtMs: requireInteger(input?.createdAtMs, 0, Number.MAX_SAFE_INTEGER, 'claim timestamp'),
    maximumEntries: requireInteger(
      input?.maximumEntries, 1, MAXIMUM_SUPPORTED_ENTRIES, 'claim entry bound',
    ),
    maximumBytes: requireInteger(
      input?.maximumBytes, 1, MAXIMUM_SUPPORTED_BYTES, 'claim byte bound',
    ),
    intentName: `.WORLD_FFMPEG_GC.intent-${token}.v1.json`,
    quarantineDirectoryName: `.WORLD_FFMPEG_GC.quarantine-${token}`,
    quarantineName: 'owned',
    completionName: `.WORLD_FFMPEG_GC.tombstone-${token}.v1.json`,
  }
  requireSourceIdentity(value.sourceIdentity, kind)
  return Object.freeze(value)
}

function requireClaim(value, claimName) {
  if (!exactRecord(value, [
    'schema', 'token', 'ownerPid', 'ownerToken', 'kind', 'label', 'sourceName',
    'sourceIdentity', 'sourceAuthority', 'createdAtMs', 'maximumEntries', 'maximumBytes',
    'intentName', 'quarantineDirectoryName', 'quarantineName', 'completionName',
  ]) || value.schema !== CLAIM_SCHEMA) {
    throw new Error('World FFmpeg garbage transaction claim is invalid.')
  }
  const rebuilt = buildClaim(value)
  if (!canonicalBytes(rebuilt).equals(canonicalBytes(value))
    || claimNameFor(value.kind, value.sourceName, value.sourceAuthority) !== claimName
    || value.intentName !== `.WORLD_FFMPEG_GC.intent-${value.token}.v1.json`
    || value.quarantineDirectoryName !== `.WORLD_FFMPEG_GC.quarantine-${value.token}`
    || value.quarantineName !== 'owned'
    || value.completionName !== `.WORLD_FFMPEG_GC.tombstone-${value.token}.v1.json`) {
    throw new Error('World FFmpeg garbage transaction claim token or identity is invalid.')
  }
  return value
}

function buildIntent(claim, inventory, quarantineAuthority) {
  requireClaim(claim, claimNameFor(claim.kind, claim.sourceName, claim.sourceAuthority))
  requireQuarantineAuthority(quarantineAuthority)
  return Object.freeze({
    schema: INTENT_SCHEMA,
    token: claim.token,
    claimName: claimNameFor(claim.kind, claim.sourceName, claim.sourceAuthority),
    kind: claim.kind,
    label: claim.label,
    sourceName: claim.sourceName,
    intentName: claim.intentName,
    quarantineDirectoryName: claim.quarantineDirectoryName,
    quarantineName: claim.quarantineName,
    quarantineAuthority,
    completionName: claim.completionName,
    sourceIdentity: claim.sourceIdentity,
    sourceAuthority: claim.sourceAuthority,
    createdAtMs: claim.createdAtMs,
    maximumEntries: claim.maximumEntries,
    maximumBytes: claim.maximumBytes,
    plannedEntries: inventory.entries.length,
    plannedBytes: inventory.plannedBytes,
    entries: inventory.entries,
  })
}

function requireIntentBinding(value, claim) {
  requireClaim(claim, claimNameFor(claim.kind, claim.sourceName, claim.sourceAuthority))
  for (const key of [
    'token', 'kind', 'label', 'sourceName', 'intentName', 'quarantineDirectoryName',
    'quarantineName', 'completionName',
    'createdAtMs', 'maximumEntries', 'maximumBytes',
  ]) {
    if (value?.[key] !== claim[key]) {
      throw new Error('World FFmpeg garbage cleanup intent conflicts with its transaction claim.')
    }
  }
  if (value?.claimName !== claimNameFor(claim.kind, claim.sourceName, claim.sourceAuthority)
    || JSON.stringify(value?.sourceIdentity) !== JSON.stringify(claim.sourceIdentity)
    || JSON.stringify(value?.sourceAuthority) !== JSON.stringify(claim.sourceAuthority)) {
    throw new Error('World FFmpeg garbage cleanup intent token or source authority conflicts with its claim.')
  }
  return value
}

function buildTombstone(claim, intent, receiptSchema) {
  requireIntentBinding(intent, claim)
  const receipt = buildReceipt(intent, receiptSchema)
  return Object.freeze({
    schema: TOMBSTONE_SCHEMA,
    token: claim.token,
    claimName: claimNameFor(claim.kind, claim.sourceName, claim.sourceAuthority),
    kind: intent.kind,
    label: intent.label,
    sourceName: intent.sourceName,
    intentName: intent.intentName,
    quarantineDirectoryName: intent.quarantineDirectoryName,
    quarantineName: intent.quarantineName,
    quarantineAuthority: intent.quarantineAuthority,
    completionName: intent.completionName,
    sourceIdentity: intent.sourceIdentity,
    sourceAuthority: intent.sourceAuthority,
    createdAtMs: intent.createdAtMs,
    completedAtMs: intent.createdAtMs,
    maximumEntries: intent.maximumEntries,
    maximumBytes: intent.maximumBytes,
    plannedEntries: intent.plannedEntries,
    plannedBytes: intent.plannedBytes,
    receiptSchema,
    receiptSha256: createHash('sha256').update(canonicalBytes(receipt)).digest('hex'),
  })
}

function requireTombstoneBinding(value, claim, intent) {
  const expected = buildTombstone(claim, intent, value?.receiptSchema)
  if (!canonicalBytes(expected).equals(canonicalBytes(value))) {
    throw new Error('World FFmpeg garbage cleanup tombstone conflicts with its transaction claim.')
  }
  return value
}

function buildReceipt(intent, receiptSchema) {
  if (typeof receiptSchema !== 'string' || receiptSchema.length < 1 || receiptSchema.length > 128) {
    throw new Error('World FFmpeg garbage cleanup receipt schema is invalid.')
  }
  if (!intent || typeof intent !== 'object' || !['directory', 'file'].includes(intent.kind)) {
    throw new Error('World FFmpeg garbage cleanup receipt intent is invalid.')
  }
  if (intent.kind === 'directory') {
    return Object.freeze({
      schema: receiptSchema,
      label: intent.label,
      rootIdentity: intent.sourceIdentity,
      quarantinedAtMs: intent.createdAtMs,
      reclaimedAtMs: intent.createdAtMs,
      entries: intent.plannedEntries,
      files: intent.entries.filter(({ kind }) => kind === 'file').length,
      reclaimedBytes: intent.plannedBytes,
      foreignReplacements: Object.freeze([]),
    })
  }
  return Object.freeze({
    schema: receiptSchema,
    label: intent.label,
    identity: intent.sourceIdentity,
    reclaimedBytes: intent.plannedBytes,
    reclaimedAtMs: intent.createdAtMs,
  })
}

function sameStableSourceAuthority(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino
    && left?.birthtimeNs === right?.birthtimeNs && left?.mode === right?.mode
}

function sameClaimTransaction(left, right) {
  try {
    requireClaim(left, claimNameFor(left?.kind, left?.sourceName, left?.sourceAuthority))
    requireClaim(right, claimNameFor(right?.kind, right?.sourceName, right?.sourceAuthority))
  } catch {
    return false
  }
  return left.kind === right.kind
    && left.label === right.label
    && left.sourceName === right.sourceName
    && left.maximumEntries === right.maximumEntries
    && left.maximumBytes === right.maximumBytes
    && canonicalBytes(left.sourceIdentity).equals(canonicalBytes(right.sourceIdentity))
    && canonicalBytes(left.sourceAuthority).equals(canonicalBytes(right.sourceAuthority))
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`)
}

function requireSourceAuthority(value) {
  if (!exactRecord(value, ['dev', 'ino', 'birthtimeNs', 'ctimeNs', 'mode', 'size'])
    || !/^[0-9]{1,40}$/.test(value.dev) || !/^[1-9][0-9]{0,39}$/.test(value.ino)
    || !/^[1-9][0-9]{0,39}$/.test(value.birthtimeNs)
    || !/^[1-9][0-9]{0,39}$/.test(value.ctimeNs)
    || !Number.isSafeInteger(value.mode) || value.mode < 0 || value.mode > 0o7777
    || !Number.isSafeInteger(value.size) || value.size < 0
    || value.size > MAXIMUM_SUPPORTED_BYTES) {
    throw new Error('World FFmpeg garbage source authority is invalid.')
  }
  return value
}

function requireSourceIdentity(value, kind) {
  const keys = kind === 'directory' ? ['dev', 'ino'] : ['dev', 'ino', 'size', 'mode']
  if (!exactRecord(value, keys) || !/^[0-9]{1,40}$/.test(value.dev)
    || !/^[1-9][0-9]{0,39}$/.test(value.ino)) {
    throw new Error('World FFmpeg garbage source identity is invalid.')
  }
  if (kind === 'file' && (!Number.isSafeInteger(value.size) || value.size < 0
    || value.size > MAXIMUM_SUPPORTED_BYTES || !Number.isSafeInteger(value.mode)
    || value.mode < 0 || value.mode > 0o7777)) {
    throw new Error('World FFmpeg garbage file source identity is invalid.')
  }
  return value
}

function quarantineAuthorityFromStat(info) {
  if (!info || typeof info !== 'object' || !info.isDirectory?.() || info.isSymbolicLink?.()
    || typeof info.birthtimeNs !== 'bigint' || info.birthtimeNs < 1n
    || typeof info.dev !== 'bigint' || typeof info.ino !== 'bigint' || info.ino < 1n
    || typeof info.mode !== 'bigint') {
    throw new Error('World FFmpeg garbage private quarantine authority is unavailable.')
  }
  return Object.freeze({
    dev: String(info.dev),
    ino: String(info.ino),
    birthtimeNs: String(info.birthtimeNs),
    mode: Number(info.mode & 0o7777n),
  })
}

function requireQuarantineAuthority(value) {
  if (!exactRecord(value, ['dev', 'ino', 'birthtimeNs', 'mode'])
    || !/^[0-9]{1,40}$/.test(value.dev) || !/^[1-9][0-9]{0,39}$/.test(value.ino)
    || !/^[1-9][0-9]{0,39}$/.test(value.birthtimeNs)
    || !Number.isSafeInteger(value.mode) || value.mode < 0 || value.mode > 0o7777) {
    throw new Error('World FFmpeg garbage private quarantine authority is invalid.')
  }
  return value
}

function requireKind(value) {
  if (value !== 'directory' && value !== 'file') throw new Error('World FFmpeg garbage kind is invalid.')
  return value
}

function requireToken(value) {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) {
    throw new Error('World FFmpeg garbage generation token is invalid.')
  }
  return value
}

function requireDirectName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255
    || value === '.' || value === '..' || /[\\/\0\r\n]/.test(value)) {
    throw new Error('World FFmpeg garbage source name is invalid.')
  }
  return value
}

function requireLabel(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,100}$/.test(value)) {
    throw new Error('World FFmpeg garbage label is invalid.')
  }
  return value
}

function requireInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`World FFmpeg ${label} is invalid.`)
  }
  return value
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

module.exports = Object.freeze({
  CLAIM_SCHEMA,
  INTENT_SCHEMA,
  TOMBSTONE_SCHEMA,
  CLAIM_PATTERN,
  INTENT_PATTERN,
  TOMBSTONE_PATTERN,
  QUARANTINE_DIRECTORY_PATTERN,
  TOKEN_PATTERN,
  MAXIMUM_SUPPORTED_BYTES,
  MAXIMUM_SUPPORTED_ENTRIES,
  sourceAuthorityFromStat,
  quarantineAuthorityFromStat,
  claimNameFor,
  buildClaim,
  requireClaim,
  buildIntent,
  requireIntentBinding,
  buildTombstone,
  buildReceipt,
  requireTombstoneBinding,
  requireQuarantineAuthority,
  sameStableSourceAuthority,
  sameClaimTransaction,
  canonicalBytes,
})

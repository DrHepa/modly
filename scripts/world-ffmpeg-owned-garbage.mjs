import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, opendir, readdir, rename, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { runWithWorldFfmpegCwdCustody } from './world-ffmpeg-cwd-custody.mjs'
import { syncWorldFfmpegDirectory } from './world-ffmpeg-durability.mjs'
import garbageProtocol from './world-ffmpeg-owned-garbage-protocol.cjs'

const RECEIPT_SCHEMA = 'modly.world-ffmpeg-owned-garbage-receipt.v1'
const RECEIPT_NAME = '.WORLD_FFMPEG_GC.v1.json'
const REMOVE_PATTERN = /^\..+\.remove-([a-f0-9]{32})$/
const {
  CLAIM_PATTERN,
  INTENT_PATTERN,
  TOMBSTONE_PATTERN,
  QUARANTINE_DIRECTORY_PATTERN,
  INTENT_SCHEMA,
  TOMBSTONE_SCHEMA,
  MAXIMUM_SUPPORTED_ENTRIES: DEFAULT_MAXIMUM_ENTRIES,
  MAXIMUM_SUPPORTED_BYTES,
} = garbageProtocol
const MAXIMUM_INTENT_BYTES = 64 * 1024 * 1024
const MAXIMUM_CLAIM_BYTES = 16 * 1024
const MAXIMUM_TOMBSTONE_BYTES = 32 * 1024
const COMPLETED_LEDGER_LIMIT = 64
const PUBLICATION_TEMP_PATTERN = /^(.*\.v1\.json)\.tmp-([a-f0-9]{32})$/
const PUBLICATION_TEMP_CANDIDATE_PATTERN = /^(.*\.v1\.json)\.tmp-(.*)$/
const RETIREMENT_SCHEMA = 'modly.world-ffmpeg-owned-garbage-retirement.v1'
const RETIREMENT_PATTERN = /^\.WORLD_FFMPEG_GC\.retirement-([a-f0-9]{32})\.v1\.json$/
const RETIREMENT_DIRECTORY_PATTERN = /^\.WORLD_FFMPEG_GC\.retirement-private-([a-f0-9]{32})$/
const MAXIMUM_RETIREMENT_BYTES = 64 * 1024
const MAXIMUM_PUBLICATION_TEMPORARIES = 64
const RESERVED_PREFIX = '.WORLD_FFMPEG_GC.'
// Recovery budgets are independent of one owned tree's entry/byte ceilings.
// They admit the delayed 1,001-generation ledger while bounding shared-parent
// enumeration, retained metadata, and diagnostics before recovery starts.
const MAXIMUM_RECOVERY_SCAN_ENTRIES = 65_536
const MAXIMUM_RECOVERY_AUTHORITIES = 8_192
const MAXIMUM_RECOVERY_METADATA_BYTES = 128 * 1024 * 1024
const MAXIMUM_RECOVERY_FAILURES = 64
const incompleteAuthorityReads = new WeakMap()
const retirementReadProofs = new WeakMap()
const RETIRED_LEDGER_GENERATION = Symbol('retired-ledger-generation')

async function scanGarbageParent(parent, preflight = false) {
  const names = []
  let authorities = 0
  let temporaries = 0
  let retirements = 0
  let metadataBytes = 0n
  for await (const entry of await opendir(parent)) {
    const { name } = entry
    names.push(name)
    const maximumEntries = preflight ? MAXIMUM_RECOVERY_SCAN_ENTRIES : DEFAULT_MAXIMUM_ENTRIES + 1
    if (names.length > maximumEntries) throw recoveryBoundError('directory scan entry count')
    if (!name.startsWith(RESERVED_PREFIX)) continue
    if (++authorities > MAXIMUM_RECOVERY_AUTHORITIES) throw recoveryBoundError('aggregate authority count')
    if (name.startsWith(`${RESERVED_PREFIX}retirement-`) && ++retirements > MAXIMUM_PUBLICATION_TEMPORARIES) {
      throw recoveryBoundError('retirement authority count')
    }
    if (PUBLICATION_TEMP_CANDIDATE_PATTERN.test(name) && ++temporaries > MAXIMUM_PUBLICATION_TEMPORARIES) {
      const family = name.slice(RESERVED_PREFIX.length).split('-')[0]
      throw recoveryBoundError(`aggregate ${family} publication temporary count`)
    }
    if (preflight && (name.includes('.v1.json'))) {
      const info = await optionalLstat(join(parent, name))
      if (info?.isFile() && !info.isSymbolicLink()) metadataBytes += info.size
      if (metadataBytes > BigInt(MAXIMUM_RECOVERY_METADATA_BYTES)) throw recoveryBoundError('aggregate metadata byte count')
    }
  }
  return names.sort(codeUnitCompare)
}

function recoveryBoundError(label) {
  return Object.assign(new Error(`World FFmpeg garbage ${label} exceeds its recovery bound.`), {
    code: 'WORLD_FFMPEG_RECOVERY_BOUND',
  })
}

function indexPublicationTemporaries(names) {
  const result = new Map()
  for (const name of names) {
    const match = PUBLICATION_TEMP_CANDIDATE_PATTERN.exec(name)
    if (!match) continue
    const candidates = result.get(match[1]) ?? []
    candidates.push(name)
    result.set(match[1], candidates)
  }
  return result
}

function boundedRecoveryFailures() {
  const values = []
  return {
    values,
    push(value) {
      if (values.length < MAXIMUM_RECOVERY_FAILURES) values.push(value)
      else if (values.length === MAXIMUM_RECOVERY_FAILURES) {
        values.push(failureRecord('*', new Error('Additional garbage recovery failures omitted at the reporting bound.')))
      }
    },
  }
}

// Package RESULT permits 64 GiB of deployable artifacts in addition to its
// independently retained report and RESULT metadata. Cleanup must be able to
// retire every byte accepted by that public contract.
export const WORLD_FFMPEG_PACKAGE_OUTPUT_GARBAGE_MAXIMUM_BYTES = (
  64 * 1024 * 1024 * 1024
  + 1024 * 1024
  + 128 * 1024
)

export async function quarantineAndReclaimWorldFfmpegDirectory(input) {
  const path = requireAbsolute(input?.path, 'owned directory')
  const expectedIdentity = requireDirectoryIdentity(input?.expectedIdentity)
  const label = requireLabel(input?.label)
  const bounds = requireBounds(input)
  const createdAtMs = requireTimestamp(input?.nowMs ?? Date.now())
  const sourceInfo = await lstat(path, { bigint: true })
  requireMatchingDirectory(sourceInfo, expectedIdentity, 'owned directory identity changed before claim')
  const inventory = await inventoryDirectory(path, expectedIdentity, bounds)
  const claim = await createOrOpenClaim({
    parent: dirname(path),
    sourceName: basename(path),
    kind: 'directory',
    label,
    sourceIdentity: expectedIdentity,
    sourceAuthority: garbageProtocol.sourceAuthorityFromStat(sourceInfo),
    createdAtMs,
    bounds,
    durability: input?.durability,
    afterClaimTempSync: input?.afterClaimTempSync,
  })
  let control
  let primaryError
  try {
    await input?.afterClaimDurable?.(claimAuthority(claim, path))
    control = await ensureIntentForClaim(claim, bounds, async () => inventory, {
      durability: input?.durability,
      recoveryOwner: false,
      afterIntentTempSync: input?.afterIntentTempSync,
    })
    if (control.created) await input?.afterIntentDurable?.(intentAuthority(control, path))
    await input?.afterQuarantineParentDurable?.(intentAuthority(control, path))
    const result = await executeIntent(control, {
      sourcePath: path,
      callerBounds: bounds,
      durability: input?.durability,
      afterQuarantine: input?.afterQuarantine,
      beforeQuarantineMove: input?.beforeQuarantineMove,
      beforeFileReclaim: input?.beforeFileReclaim,
      afterFileReclaim: input?.afterFileReclaim,
      afterDirectoryReclaim: input?.afterDirectoryReclaim,
      afterReceiptDurable: input?.afterReceiptDurable,
      afterCompletionTempWrite: input?.afterCompletionTempWrite,
      afterCompletionTempSync: input?.afterCompletionTempSync,
      afterCompletionRename: input?.afterCompletionRename,
      afterCompletionDirectorySync: input?.afterCompletionDirectorySync,
    })
    return result
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    await closeTransaction(claim, control, primaryError)
  }
}

export async function quarantineAndReclaimWorldFfmpegFile(input) {
  const path = requireAbsolute(input?.path, 'owned file')
  const label = requireLabel(input?.label)
  const bounds = requireBounds({ ...input, maximumEntries: 1 })
  const ownsHandle = input?.retainedHandle === undefined
  const handle = input?.retainedHandle
    ?? await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
  let claim
  let control
  let primaryError
  try {
    const retained = await handle.stat({ bigint: true })
    if (!ordinarySingleLinkFile(retained)) {
      throw new Error('World FFmpeg owned garbage retained file identity is invalid.')
    }
    const publicInfo = await optionalLstat(path)
    if (publicInfo && !sameStableFile(publicInfo, retained)) {
      throw new Error('World FFmpeg owned garbage retained file identity changed.')
    }
    if (publicInfo && typeof input?.validate === 'function') await input.validate(path)
    const createdAtMs = requireTimestamp(input?.nowMs ?? Date.now())
    const retainedAuthority = garbageProtocol.sourceAuthorityFromStat(retained)
    claim = await createOrOpenClaim({
      parent: dirname(path),
      sourceName: basename(path),
      kind: 'file',
      label,
      sourceIdentity: fileIdentity(retained),
      sourceAuthority: retainedAuthority,
      createdAtMs,
      bounds,
      durability: input?.durability,
      allowCreate: publicInfo !== null,
      afterClaimTempSync: input?.afterClaimTempSync,
    })
    await input?.afterClaimDurable?.(claimAuthority(claim, path))
    control = await ensureIntentForClaim(claim, bounds, async () => ({
      entries: Object.freeze([]),
      plannedBytes: claim.value.sourceIdentity.size,
    }), {
      durability: input?.durability,
      recoveryOwner: false,
      afterIntentTempSync: input?.afterIntentTempSync,
    })
    if (control.created) await input?.afterIntentDurable?.(intentAuthority(control, path))
    await input?.afterQuarantineParentDurable?.(intentAuthority(control, path))
    const result = await executeIntent(control, {
      sourcePath: path,
      callerBounds: bounds,
      durability: input?.durability,
      retainedHandle: handle,
      validate: input?.validate,
      afterQuarantine: input?.afterQuarantine,
      beforeQuarantineMove: input?.beforeQuarantineMove,
      beforeRetirement: input?.beforeRetirement,
      afterFileReclaim: input?.afterFileReclaim,
      afterReceiptDurable: input?.afterReceiptDurable,
      afterCompletionTempWrite: input?.afterCompletionTempWrite,
      afterCompletionTempSync: input?.afterCompletionTempSync,
      afterCompletionRename: input?.afterCompletionRename,
      afterCompletionDirectorySync: input?.afterCompletionDirectorySync,
    })
    return result
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    const closeErrors = []
    if (control?.quarantineParentHandle) {
      try { await control.quarantineParentHandle.close() } catch (error) { closeErrors.push(error) }
    }
    if (control) try { await control.handle.close() } catch (error) { closeErrors.push(error) }
    if (claim) try { await claim.handle.close() } catch (error) { closeErrors.push(error) }
    if (ownsHandle) {
      try { await handle.close() } catch (error) { closeErrors.push(error) }
    }
    if (closeErrors.length > 0) {
      throw new AggregateError(
        primaryError ? [primaryError, ...closeErrors] : closeErrors,
        'World FFmpeg owned garbage file descriptor release failed.',
      )
    }
  }
}

export async function reclaimWorldFfmpegDirectoryQuarantine(input) {
  const quarantinePath = requireAbsolute(input?.quarantinePath, 'owned quarantine')
  const expectedIdentity = requireDirectoryIdentity(input?.expectedIdentity)
  const label = requireLabel(input?.label)
  const nowMs = requireTimestamp(input?.nowMs ?? Date.now())
  const quarantinedAtMs = requireTimestamp(input?.quarantinedAtMs)
  const minimumAgeMs = requireRecoveryAge(input?.minimumAgeMs)
  if (nowMs - quarantinedAtMs < minimumAgeMs) {
    throw new Error('World FFmpeg owned garbage recovery grace has not elapsed.')
  }
  const bounds = requireBounds(input)
  const rootInfo = await lstat(quarantinePath, { bigint: true })
  requireMatchingDirectory(rootInfo, expectedIdentity, 'owned quarantine identity changed before reclaim')
  const inventory = await inventoryDirectory(quarantinePath, expectedIdentity, bounds)
  const parsed = parseQuarantineName(basename(quarantinePath))
  const sourceName = parsed?.sourceName ?? `retired-${randomBytes(8).toString('hex')}`
  const claim = await createOrOpenClaim({
    parent: dirname(quarantinePath),
    sourceName,
    kind: 'directory',
    label,
    sourceIdentity: expectedIdentity,
    sourceAuthority: garbageProtocol.sourceAuthorityFromStat(rootInfo),
    createdAtMs: quarantinedAtMs,
    bounds,
    durability: input?.durability,
    token: parsed?.token,
    afterClaimTempSync: input?.afterClaimTempSync,
  })
  let control
  let primaryError
  try {
    control = await ensureIntentForClaim(claim, bounds, async () => inventory, {
      durability: input?.durability,
      recoveryOwner: false,
      afterIntentTempSync: input?.afterIntentTempSync,
    })
    const result = await executeIntent(control, {
      sourcePath: quarantinePath,
      callerBounds: bounds,
      durability: input?.durability,
      beforeFileReclaim: input?.beforeFileReclaim,
      afterFileReclaim: input?.afterFileReclaim,
      afterDirectoryReclaim: input?.afterDirectoryReclaim,
      afterReceiptDurable: input?.afterReceiptDurable,
      afterCompletionTempWrite: input?.afterCompletionTempWrite,
      afterCompletionTempSync: input?.afterCompletionTempSync,
      afterCompletionRename: input?.afterCompletionRename,
      afterCompletionDirectorySync: input?.afterCompletionDirectorySync,
    })
    return result
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    await closeTransaction(claim, control, primaryError)
  }
}

const applyReadWitnessCallable = Reflect.apply

function captureReadWitness(spec) {
  const keys = ['scenario', 'claimName', 'token', 'role', 'beforeRead', 'afterRead']
  if (!spec || Object.getPrototypeOf(spec) !== Object.prototype) throw new Error('Invalid read witness record.')
  const descriptors = Object.getOwnPropertyDescriptors(spec)
  if (Reflect.ownKeys(descriptors).length !== keys.length
    || keys.some((key) => !descriptors[key] || !Object.hasOwn(descriptors[key], 'value'))) {
    throw new Error('Read witness requires exact own data properties.')
  }
  const captured = Object.fromEntries(keys.map((key) => [key, descriptors[key].value]))
  if (!['prune-tombstone', 'executor-reclaim-claim'].includes(captured.scenario)
    || !['claim', 'intent', 'tombstone'].includes(captured.role)
    || (captured.scenario === 'prune-tombstone' && captured.role !== 'tombstone')
    || typeof captured.claimName !== 'string' || !CLAIM_PATTERN.test(captured.claimName)
    || typeof captured.token !== 'string' || !/^[a-f0-9]{32}$/.test(captured.token)
    || typeof captured.beforeRead !== 'function' || typeof captured.afterRead !== 'function') {
    throw new Error('Invalid read witness identity or callbacks.')
  }
  return { spec: Object.freeze(captured), parent: null, used: false, events: 0, bytes: 0 }
}

function qualifyReadWitness(witness, parent, claimName, token, scenario, role, path) {
  if (!witness || witness.spec.scenario !== scenario || witness.spec.claimName !== claimName
    || role !== witness.spec.role) return undefined
  const expectedRole = witness.spec.role
  const expectedPath = scenario === 'prune-tombstone' ? join(parent, `.WORLD_FFMPEG_GC.tombstone-${token}.v1.json`)
    : join(parent, `.WORLD_FFMPEG_GC.retirement-private-${token}`, `${expectedRole}.v1.json`)
  if (parent !== witness.parent || token !== witness.spec.token || path !== expectedPath) {
    throw new Error('Read witness target context conflicts with its captured identity.')
  }
  return { witness, path, scenario, role, claimName, token }
}

function readWitnessStat(info) {
  return info ? Object.freeze(Object.fromEntries(
    ['dev', 'ino', 'birthtimeNs', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map((key) => [key, String(info[key])]),
  )) : null
}

async function emitReadWitness(context, callback, event) {
  const { witness } = context
  const snapshot = Object.freeze({ scenario: context.scenario, role: context.role,
    claimName: context.claimName, token: context.token, path: context.path,
    phase: context.scenario === 'prune-tombstone' ? 'prune' : 'executor-reclaim', ...event })
  witness.bytes += Buffer.byteLength(JSON.stringify(snapshot))
  if (++witness.events > 8 || witness.bytes > 32 * 1024) throw new Error('Read witness evidence exceeds its bound.')
  if (await applyReadWitnessCallable(callback, undefined, [snapshot]) !== undefined) {
    throw new Error('Read witness callbacks cannot supply an I/O result.')
  }
}

export function _testOnlyRecoverWorldFfmpegOwnedGarbageWithReadWitness(input, spec) {
  return recoverOwnedGarbageCore(input, captureReadWitness(spec))
}

export function _testOnlyRecoverWorldFfmpegOwnedGarbageWithLstatWitness(input, spec) {
  const keys = ['scenario', 'actor', 'claimName', 'token', 'beforeLstat', 'afterLstat']
  if (!spec || Object.getPrototypeOf(spec) !== Object.prototype) throw new Error('Invalid lstat witness record.')
  const descriptors = Object.getOwnPropertyDescriptors(spec)
  if (Reflect.ownKeys(descriptors).length !== keys.length
    || keys.some((key) => !descriptors[key] || !Object.hasOwn(descriptors[key], 'value'))) {
    throw new Error('Lstat witness requires exact own data properties.')
  }
  const captured = Object.fromEntries(keys.map((key) => [key, descriptors[key].value]))
  if (captured.scenario !== 'executor-source-claim' || typeof captured.actor !== 'string'
    || !/^[a-zA-Z0-9_-]{1,64}$/.test(captured.actor)
    || typeof captured.claimName !== 'string' || !CLAIM_PATTERN.test(captured.claimName)
    || typeof captured.token !== 'string' || !/^[a-f0-9]{32}$/.test(captured.token)
    || typeof captured.beforeLstat !== 'function' || typeof captured.afterLstat !== 'function') {
    throw new Error('Invalid lstat witness identity or callbacks.')
  }
  return recoverOwnedGarbageCore(input, { spec: Object.freeze(captured), parent: null, used: false, events: 0, bytes: 0 })
}

async function emitLstatWitness(context, callback, stage, nativeError = null) {
  const { witness, manifest, directoryHandle, terminalValues } = context
  const snapshot = Object.freeze({ scenario: witness.spec.scenario, actor: witness.spec.actor,
    claimName: witness.spec.claimName, token: witness.spec.token, role: 'claim', phase: 'executor-source', stage,
    caller: 'executeLedgerRetirement -> validateLedgerRetirementEntryPath -> validateLedgerAuthorityPath',
    operation: 'original imported node:fs/promises.lstat(path, { bigint: true })', path: context.path,
    targetHandleAcquired: false, observedSource: readWitnessStat(context.sourceInfo),
    manifestPath: context.manifestPath, directoryPath: context.directoryPath,
    manifestBytesComplete: true, manifestDigest: sha256Bytes(manifest.bytes),
    manifestHeld: readWitnessStat(await manifest.handle.stat({ bigint: true })),
    manifestPathStat: readWitnessStat(await optionalLstat(context.manifestPath)),
    directoryHeld: readWitnessStat(await directoryHandle.stat({ bigint: true })),
    directoryPathStat: readWitnessStat(await optionalLstat(context.directoryPath)),
    terminalBytesComplete: Object.freeze(Object.fromEntries(['claim', 'intent', 'tombstone']
      .map((role) => [role, terminalValues.has(role)]))), nativeError })
  witness.bytes += Buffer.byteLength(JSON.stringify(snapshot))
  if (++witness.events > 2 || witness.bytes > 32 * 1024) throw new Error('Lstat witness evidence exceeds its bound.')
  try {
    if (await applyReadWitnessCallable(callback, undefined, [snapshot]) !== undefined) {
      throw new Error('Lstat witness callbacks cannot supply an I/O result.')
    }
  } catch (cause) {
    throw Object.assign(new Error('Lstat witness callback failed.', { cause }), { code: 'WORLD_FFMPEG_LSTAT_WITNESS_CALLBACK' })
  }
}

export function recoverWorldFfmpegOwnedGarbage(input) {
  return recoverOwnedGarbageCore(input)
}

async function recoverOwnedGarbageCore(input, witness) {
  const parentDirectory = requireAbsolute(input?.parentDirectory, 'garbage recovery parent')
  const parentInfo = await lstat(parentDirectory, { bigint: true })
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new Error('World FFmpeg garbage recovery parent is invalid.')
  }
  if (witness) witness.parent = parentDirectory
  const nowMs = requireTimestamp(input?.nowMs ?? Date.now())
  const minimumAgeMs = requireRecoveryAge(input?.minimumAgeMs)
  const callerBounds = requireBounds(input)
  const failures = boundedRecoveryFailures()
  let initialNames
  try { initialNames = await scanGarbageParent(parentDirectory, true) } catch (error) {
    if (error?.code !== 'WORLD_FFMPEG_RECOVERY_BOUND') throw error
    return Object.freeze({
      schema: 'modly.world-ffmpeg-owned-garbage-recovery.v1',
      recovered: 0, completed: 0, pending: 0, unclaimed: Object.freeze([]),
      failures: Object.freeze([failureRecord('*', error)]),
    })
  }
  const retirementRecovery = await recoverLedgerRetirementTransactions(parentDirectory, input, failures, initialNames, witness)
  await recoverClaimPublicationTemporaries(parentDirectory, input?.durability, failures, initialNames)
  const names = await scanGarbageParent(parentDirectory, true)
  const publicationTemporaries = indexPublicationTemporaries(names)
  const claimedClaims = new Set()
  const claimedQuarantineDirectories = new Set()
  const claimedIntents = new Set()
  const claimedCompletions = new Set()
  const completedAnchors = new Map()
  let recovered = 0
  let completed = 0
  let pending = 0
  for (const name of names) {
    if (!CLAIM_PATTERN.test(name)) continue
    let claim
    let control
    let primaryError
    let terminalControl
    try {
      claim = await openClaim(join(parentDirectory, name), true)
      claim.recoveryTemporaries = publicationTemporaries
      claimedClaims.add(name)
      claimedQuarantineDirectories.add(claim.value.quarantineDirectoryName)
      claimedIntents.add(claim.value.intentName)
      claimedCompletions.add(claim.value.completionName)
      const fresh = nowMs - claim.value.createdAtMs < minimumAgeMs
      const intentPublication = await recoverBoundPublicationTemporaries({
        recoveryTemporaries: publicationTemporaries,
        finalPath: join(parentDirectory, claim.value.intentName),
        maximumBytes: MAXIMUM_INTENT_BYTES,
        label: 'garbage cleanup intent',
        durability: input?.durability,
        validate(value) {
          requireIntent(value)
          garbageProtocol.requireIntentBinding(value, claim.value)
        },
        tolerateInvalid: true,
      })
      if (intentPublication.failures.length > 0) {
        failures.push(failureRecord(claim.value.intentName, publicationRecoveryError(
          'garbage cleanup intent', intentPublication.failures,
        )))
      }
      try {
        control = await openIntent(join(parentDirectory, claim.value.intentName), claim, true)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        if (fresh) {
          pending += 1
          continue
        }
        control = await ensureIntentForClaim(claim, callerBounds, async () => {
          const sourcePath = join(parentDirectory, claim.value.sourceName)
          const quarantinePath = quarantinePathForClaim(claim)
          const sourceInfo = await optionalLstat(sourcePath)
          const inventoryPath = sourceInfo ? sourcePath : quarantinePath
          return claim.value.kind === 'directory'
            ? inventoryDirectory(inventoryPath, claim.value.sourceIdentity, callerBounds)
            : { entries: Object.freeze([]), plannedBytes: claim.value.sourceIdentity.size }
        }, { durability: input?.durability, recoveryOwner: true })
      }
      const completionPublication = await recoverBoundPublicationTemporaries({
        recoveryTemporaries: publicationTemporaries,
        finalPath: control.completionPath,
        maximumBytes: MAXIMUM_TOMBSTONE_BYTES,
        label: 'garbage cleanup tombstone',
        durability: input?.durability,
        validate(value) {
          requireTombstone(value)
          garbageProtocol.requireTombstoneBinding(value, claim.value, control.value)
        },
        tolerateInvalid: true,
      })
      if (completionPublication.failures.length > 0) {
        failures.push(failureRecord(claim.value.completionName, publicationRecoveryError(
          'garbage cleanup tombstone', completionPublication.failures,
        )))
      }
      const completion = await readCompletion(control, undefined, undefined, true)
      if (completion) {
        let retainedCompletion = completion
        try {
          requireIntentWithinBounds(control.value, callerBounds)
          await validateCompletedTransaction(control)
          const anchorInput = retainedCompletion
          retainedCompletion = undefined
          terminalControl = { ...terminalDescriptor(control), countCompleted: true,
            anchor: await captureCompletedAnchor(control, anchorInput) }
        } finally {
          if (retainedCompletion?.retainedAuthority) {
            await closeCompletedLedgerRecord({ retainedAuthorities: [retainedCompletion.retainedAuthority] }).catch(() => undefined)
          }
        }
        continue
      }
      if (fresh) {
        pending += 1
        continue
      }
      requireIntentWithinBounds(control.value, callerBounds)
      await executeIntent(control, {
        sourcePath: join(parentDirectory, claim.value.sourceName),
        callerBounds,
        durability: input?.durability,
        allowActiveReplacement: true,
      })
      terminalControl = { ...terminalDescriptor(control), countCompleted: false }
      recovered += 1
    } catch (error) {
      let reconciled = false
      if (control) {
        try {
          const completion = await readCompletion(control, undefined, undefined, true)
          if (completion) {
            let retainedCompletion = completion
            try {
              requireIntentWithinBounds(control.value, callerBounds)
              await validateCompletedTransaction(control)
              const anchorInput = retainedCompletion
              retainedCompletion = undefined
              terminalControl = { ...terminalDescriptor(control), countCompleted: true,
                anchor: await captureCompletedAnchor(control, anchorInput) }
            } finally {
              if (retainedCompletion?.retainedAuthority) {
                await closeCompletedLedgerRecord({ retainedAuthorities: [retainedCompletion.retainedAuthority] }).catch(() => undefined)
              }
            }
            reconciled = true
          }
        } catch {
          // The original failure remains authoritative unless an exact terminal
          // publication and its current cleanup state both reconcile.
        }
      }
      // Once a claim has been opened, missing or incomplete follow-up authority
      // reads are not reconciled by syscall-local absence. Completed-ledger
      // convergence is authorized only by the anchored generation state machine
      // in pruneCompletedLedger()/retireCompletedLedgerRecord().
      if (!reconciled && error?.code === 'ENOENT' && !claim
        && !(await optionalLstat(join(parentDirectory, name)))) {
        // A listed claim may be retired by another exact recovery before this
        // process opens it. No authority was opened or mutated here.
        reconciled = true
      }
      if (!reconciled) {
        primaryError = error
        failures.push(failureRecord(name, error))
      }
    } finally {
      try { await closeTransaction(claim, control, primaryError) } catch (error) {
        failures.push(failureRecord(name, error))
      }
      if (terminalControl && !primaryError) {
        let anchorTransferred = false
        try {
          // Keep the complete terminal generation until the bounded ledger
          // selects it for one manifest-bound retirement transaction. Deleting
          // quarantine/receipt state here would split that transaction and
          // leave a crash gap before claim/intent/tombstone retirement.
          await preflightCompletedTransaction(terminalControl)
          if (terminalControl.countCompleted) completed += 1
          if (terminalControl.anchor && completedAnchors.size < MAXIMUM_RECOVERY_AUTHORITIES) {
            completedAnchors.set(basename(terminalControl.claimPath), terminalControl.anchor)
            anchorTransferred = true
          }
        } catch (error) {
          failures.push(failureRecord(name, error))
        } finally {
          if (terminalControl.anchor && !anchorTransferred) {
            await closeCompletedLedgerRecord(terminalControl.anchor).catch((error) => {
              failures.push(failureRecord(name, error))
            })
          }
        }
      }
    }
  }
  let currentNames, unclaimed, reportBase
  try {
    await input?.afterCompletedAnchorScan?.({
      parentDirectory,
      anchorNames: Object.freeze([...completedAnchors.keys()]),
    })
    currentNames = await scanGarbageParent(parentDirectory, true)
    unclaimed = []
    for (const name of currentNames) {
      if (INTENT_PATTERN.test(name) && !claimedIntents.has(name)) {
        failures.push(failureRecord(name, new Error('World FFmpeg garbage intent has no exact transaction claim.')))
        continue
      }
      if (TOMBSTONE_PATTERN.test(name) && !claimedCompletions.has(name)) {
        failures.push(failureRecord(name, new Error('World FFmpeg garbage tombstone has no exact transaction claim.')))
        continue
      }
      const publicationTemporary = PUBLICATION_TEMP_CANDIDATE_PATTERN.exec(name)
      if (publicationTemporary && name.startsWith(RESERVED_PREFIX)) {
        if (claimedClaims.has(publicationTemporary[1])
          || claimedIntents.has(publicationTemporary[1])
          || claimedCompletions.has(publicationTemporary[1])) continue
        failures.push(failureRecord(name, new Error('World FFmpeg garbage publication temporary has no exact transaction authority.')))
        continue
      }
      if (QUARANTINE_DIRECTORY_PATTERN.test(name)) {
        if (!claimedQuarantineDirectories.has(name)) unclaimed.push(name)
        continue
      }
      if (name.startsWith(RESERVED_PREFIX) && !CLAIM_PATTERN.test(name)
        && !INTENT_PATTERN.test(name) && !TOMBSTONE_PATTERN.test(name)
        && !name.startsWith(`${RESERVED_PREFIX}retirement-`) && name !== RECEIPT_NAME) {
        failures.push(failureRecord(name, new Error('World FFmpeg garbage reserved authority name is malformed and was preserved.')))
        continue
      }
      if (!REMOVE_PATTERN.test(name)) continue
      const path = join(parentDirectory, name)
      if (await isCompletedLegacyQuarantine(path)) completed += 1
      else unclaimed.push(name)
    }
    if (!retirementRecovery.blocked) await pruneCompletedLedger(parentDirectory, input, failures, currentNames, witness, completedAnchors)
    if (witness && (!witness.used || witness.events < 2)) throw new Error('Read witness did not settle a qualified native read.')
    reportBase = {
      schema: 'modly.world-ffmpeg-owned-garbage-recovery.v1',
      recovered,
      completed,
      pending,
      unclaimed: Object.freeze(unclaimed.slice(0, MAXIMUM_RECOVERY_FAILURES)),
    }
  } finally {
    await closeCompletedLedgerAnchors(completedAnchors, failures)
  }
  return Object.freeze({
    ...reportBase,
    failures: Object.freeze(failures.values),
  })
}

async function closeCompletedLedgerAnchors(anchors, failures) {
  const released = await Promise.allSettled([...anchors.values()].map((anchor) => closeCompletedLedgerRecord(anchor)))
  anchors.clear()
  for (const result of released) {
    if (result.status === 'rejected') {
      failures.push(failureRecord('.WORLD_FFMPEG_GC.completed-anchor-release', result.reason))
    }
  }
}

async function createOrOpenClaim(input) {
  const claimName = garbageProtocol.claimNameFor(input.kind, input.sourceName, input.sourceAuthority)
  const claimPath = join(input.parent, claimName)
  const recoveredPublication = await recoverBoundPublicationTemporaries({
    finalPath: claimPath,
    maximumBytes: MAXIMUM_CLAIM_BYTES,
    label: 'garbage transaction claim',
    durability: input.durability,
    validate(value) {
      garbageProtocol.requireClaim(value, claimName)
      requireClaimMatchesInput(value, input)
    },
    equivalent: garbageProtocol.sameClaimTransaction,
  })
  const existing = await optionalLstat(claimPath)
  if (existing) {
    const claim = await openClaim(claimPath, true)
    requireClaimMatchesInput(claim.value, input)
    return { ...claim, created: recoveredPublication.created }
  }
  if (input.allowCreate === false) {
    throw new Error('World FFmpeg garbage transaction claim is unavailable for the retained source.')
  }
  const value = garbageProtocol.buildClaim({
    token: input.token ?? randomBytes(16).toString('hex'),
    ownerPid: process.pid,
    ownerToken: randomBytes(16).toString('hex'),
    kind: input.kind,
    label: input.label,
    sourceName: input.sourceName,
    sourceIdentity: input.sourceIdentity,
    sourceAuthority: input.sourceAuthority,
    createdAtMs: input.createdAtMs,
    maximumEntries: DEFAULT_MAXIMUM_ENTRIES,
    maximumBytes: MAXIMUM_SUPPORTED_BYTES,
  })
  const bytes = canonicalBytes(value)
  try {
    const published = await publishCanonicalAuthority({
      finalPath: claimPath,
      bytes,
      maximumBytes: MAXIMUM_CLAIM_BYTES,
      label: 'garbage transaction claim',
      durability: input.durability,
      validate(candidate) {
        garbageProtocol.requireClaim(candidate, claimName)
        requireClaimMatchesInput(candidate, input)
      },
      acceptExisting: true,
      equivalent: garbageProtocol.sameClaimTransaction,
      async afterTempSync(authority) {
        await input.afterClaimTempSync?.({
          ...authority,
          claimPath,
          sourcePath: join(input.parent, input.sourceName),
          token: value.token,
        })
      },
    })
    const claim = await openClaim(claimPath, true)
    requireClaimMatchesInput(claim.value, input)
    return { ...claim, created: published.created }
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const claim = await openClaim(claimPath, true)
      requireClaimMatchesInput(claim.value, input)
      return claim
    }
    throw error
  }
}

async function openClaim(claimPath, retryPublication = false) {
  let lastError
  const attempts = retryPublication ? 101 : 1
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await openClaimOnce(claimPath) } catch (error) {
      if (error?.code === 'ENOENT') throw error
      lastError = error
      if (attempt + 1 < attempts) await delay(2)
    }
  }
  throw lastError
}

async function openClaimOnce(claimPath) {
  const pathInfo = await lstat(claimPath, { bigint: true })
  if (!ordinarySingleLinkFile(pathInfo) || pathInfo.size < 2n
    || pathInfo.size > BigInt(MAXIMUM_CLAIM_BYTES)) {
    throw new Error('World FFmpeg garbage transaction claim is not an ordinary bounded file.')
  }
  const handle = await open(claimPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
  try {
    const identity = await handle.stat({ bigint: true })
    if (!sameStableFile(pathInfo, identity)) {
      throw new Error('World FFmpeg garbage transaction claim changed before open.')
    }
    const value = parseCanonical(
      await readExactHandle(handle, Number(identity.size)),
      'garbage transaction claim',
    )
    garbageProtocol.requireClaim(value, basename(claimPath))
    return {
      parent: dirname(claimPath), claimPath, handle, identity, value, created: false,
    }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

function requireClaimMatchesInput(value, input) {
  if (value.kind !== input.kind || value.sourceName !== input.sourceName
    || !garbageProtocol.sameStableSourceAuthority(value.sourceAuthority, input.sourceAuthority)
    || (input.token !== undefined && value.token !== input.token)) {
    throw new Error('World FFmpeg garbage transaction claim conflicts with the exact source generation.')
  }
  if (value.sourceIdentity.dev !== input.sourceIdentity.dev
    || value.sourceIdentity.ino !== input.sourceIdentity.ino
    || (value.kind === 'file' && (
      value.sourceIdentity.mode !== input.sourceIdentity.mode
      || (input.sourceIdentity.size !== value.sourceIdentity.size && input.sourceIdentity.size !== 0)
    ))) {
    throw new Error('World FFmpeg garbage transaction claim source identity was reused or replaced.')
  }
}

async function ensureIntentForClaim(claim, callerBounds, inventoryProvider, options = {}) {
  const intentPath = join(claim.parent, claim.value.intentName)
  await recoverBoundPublicationTemporaries({
    finalPath: intentPath,
    recoveryTemporaries: claim.recoveryTemporaries,
    maximumBytes: MAXIMUM_INTENT_BYTES,
    label: 'garbage cleanup intent',
    durability: options.durability,
    validate(value) {
      requireIntent(value)
      garbageProtocol.requireIntentBinding(value, claim.value)
    },
  })
  try {
    const control = await openIntent(intentPath, claim, true)
    requireIntentWithinBounds(control.value, callerBounds)
    return control
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (!claim.created && !options.recoveryOwner) {
    return waitForClaimIntent(intentPath, claim, callerBounds)
  }
  let quarantineParent
  try {
    quarantineParent = await createQuarantineParent(claim, {
      durability: options.durability,
      requireAbsent: true,
    })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    return waitForClaimIntent(intentPath, claim, callerBounds)
  }
  let inventory
  try {
    inventory = await inventoryProvider()
  } catch (error) {
    try {
      const control = await openIntent(intentPath, claim, true)
      requireIntentWithinBounds(control.value, callerBounds)
      await quarantineParent.handle.close()
      return control
    } catch (openError) {
      if (openError?.code !== 'ENOENT') {
        await quarantineParent.handle.close().catch(() => undefined)
        throw openError
      }
      await quarantineParent.handle.close().catch(() => undefined)
      throw error
    }
  }
  requireInventoryWithinBounds(inventory, callerBounds)
  try {
    return await createIntent(claim, inventory, quarantineParent, options)
  } catch (error) {
    await quarantineParent.handle.close().catch(() => undefined)
    if (error?.code !== 'EEXIST') throw error
    const control = await openIntent(intentPath, claim, true)
    requireIntentWithinBounds(control.value, callerBounds)
    return control
  }
}

async function waitForClaimIntent(intentPath, claim, callerBounds) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    await delay(10)
    try {
      const control = await openIntent(intentPath, claim, true)
      requireIntentWithinBounds(control.value, callerBounds)
      return control
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  throw new Error('World FFmpeg garbage transaction owner did not publish its cleanup intent within the custody deadline.')
}

async function createQuarantineParent(claim, input) {
  const path = join(claim.parent, claim.value.quarantineDirectoryName)
  let created = false
  try {
    await mkdir(path, { mode: 0o700 })
    created = true
    await syncWorldFfmpegDirectory(claim.parent, input.durability)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    if (input.requireAbsent) {
      throw Object.assign(
        new Error('World FFmpeg garbage private quarantine authority was occupied before creation.'),
        { code: 'EEXIST' },
      )
    }
  }
  const pathInfo = await lstat(path, { bigint: true })
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
  try {
    const identity = await handle.stat({ bigint: true })
    if (!samePrivateDirectory(pathInfo, identity)) {
      throw new Error('World FFmpeg garbage private quarantine authority changed before open.')
    }
    return {
      path,
      handle,
      identity,
      authority: garbageProtocol.quarantineAuthorityFromStat(identity),
      created,
    }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

function requireInventoryWithinBounds(inventory, bounds) {
  if (!Array.isArray(inventory?.entries) || inventory.entries.length > bounds.maximumEntries
    || !Number.isSafeInteger(inventory?.plannedBytes) || inventory.plannedBytes < 0
    || inventory.plannedBytes > bounds.maximumBytes) {
    throw new Error('World FFmpeg garbage cleanup plan exceeds the current caller policy bound.')
  }
}

function requireIntentWithinBounds(intent, bounds) {
  if (intent.plannedEntries > bounds.maximumEntries || intent.plannedBytes > bounds.maximumBytes) {
    throw new Error('World FFmpeg garbage cleanup intent exceeds the current caller policy bound.')
  }
}

async function ensureIntentQuarantined(control, sourcePath, input) {
  const intent = control.value
  await requireRetainedQuarantineParent(control)
  const sourceInfo = await optionalLstat(sourcePath)
  const quarantineInfo = await optionalLstat(control.quarantinePath)
  if (quarantineInfo) {
    if (!matchesIntentSource(quarantineInfo, intent, true)) {
      throw new Error('World FFmpeg garbage recovery found a foreign quarantine replacement.')
    }
    return false
  }
  if (!sourceInfo || !matchesIntentSource(sourceInfo, intent, false)) {
    throw new Error('World FFmpeg garbage recovery cannot prove the pending source generation.')
  }
  if (intent.kind === 'directory') {
    await validateDirectoryInventory(sourcePath, intent, false)
  }
  await input.beforeQuarantineMove?.(intentAuthority(control, sourcePath))
  await requireRetainedQuarantineParent(control)
  const sourceBeforeRename = await optionalLstat(sourcePath)
  const destinationBeforeRename = await optionalLstat(control.quarantinePath)
  if (destinationBeforeRename) {
    const sourceAfterDestination = await optionalLstat(sourcePath)
    if (!matchesIntentSource(destinationBeforeRename, intent, true, true)
      || sourceAfterDestination) {
      throw new Error('World FFmpeg garbage private quarantine destination is occupied by a foreign entry.')
    }
    return false
  }
  if (!sourceBeforeRename || !matchesIntentSource(sourceBeforeRename, intent, false)) {
    throw new Error('World FFmpeg garbage source generation was replaced before quarantine move.')
  }
  try {
    await rename(sourcePath, control.quarantinePath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    const raced = await optionalLstat(control.quarantinePath)
    if (!raced || !matchesIntentSource(raced, intent, true)) throw error
    return false
  }
  await syncWorldFfmpegDirectory(control.quarantineParentPath, input.durability)
  await syncWorldFfmpegDirectory(control.parent, input.durability)
  await requireRetainedQuarantineParent(control)
  const renamed = await lstat(control.quarantinePath, { bigint: true })
  if (!matchesIntentSource(renamed, intent, true, true)) {
    throw new Error('World FFmpeg garbage quarantine identity changed during rename.')
  }
  return true
}

async function requireRetainedQuarantineParent(control) {
  const retained = await control.quarantineParentHandle.stat({ bigint: true })
  const current = await lstat(control.quarantineParentPath, { bigint: true })
  if (!samePrivateDirectory(control.quarantineParentIdentity, retained)
    || !samePrivateDirectory(retained, current)
    || !sameQuarantineAuthority(retained, control.value.quarantineAuthority)) {
    throw new Error('World FFmpeg garbage private quarantine authority changed during custody.')
  }
}

function matchesIntentSource(info, intent, allowReclaimed, allowRenameMetadata = false) {
  if (!info || !garbageProtocol.sameStableSourceAuthority(
    garbageProtocol.sourceAuthorityFromStat(info),
    intent.sourceAuthority,
  )) return false
  if (!allowReclaimed && !allowRenameMetadata
    && String(info.ctimeNs) !== intent.sourceAuthority.ctimeNs) return false
  return intent.kind === 'directory'
    ? sameDirectory(info, intent.sourceIdentity)
    : sameFileAuthority(info, intent.sourceIdentity, allowReclaimed)
}

async function readCompletion(control, context, retirementOperation, retainAuthority = false) {
  const info = await optionalLstat(control.completionPath)
  if (!info) return null
  const opened = await readStablePublicationFile(
    control.completionPath, MAXIMUM_TOMBSTONE_BYTES, 'garbage cleanup tombstone', context, retirementOperation,
  )
  if (opened === RETIRED_LEDGER_GENERATION) return opened
  let retained = false
  try {
    requireTombstone(opened.value)
    garbageProtocol.requireTombstoneBinding(opened.value, control.claim.value, control.value)
    control.completionIdentity = opened.identity
    if (retainAuthority) {
      retained = true
      return Object.freeze({
        value: opened.value,
        retainedAuthority: Object.freeze({
          role: 'tombstone',
          kind: 'file',
          handle: opened.handle,
          authority: ledgerFileAuthority(opened.identity),
        }),
      })
    }
    return opened.value
  } finally {
    if (!retained) await opened.handle.close()
  }
}

function claimAuthority(claim, sourcePath) {
  const quarantineParentPath = join(claim.parent, claim.value.quarantineDirectoryName)
  return Object.freeze({
    path: sourcePath,
    sourcePath,
    claimPath: claim.claimPath,
    intentPath: join(claim.parent, claim.value.intentName),
    quarantineParentPath,
    quarantinePath: join(quarantineParentPath, claim.value.quarantineName),
    completionPath: join(claim.parent, claim.value.completionName),
    token: claim.value.token,
    expectedIdentity: claim.value.sourceIdentity,
    identity: claim.value.sourceIdentity,
  })
}

function failureRecord(name, error) {
  return Object.freeze({
    name,
    message: error instanceof Error ? error.message.slice(0, 2048) : 'Unknown garbage recovery failure.',
  })
}

async function closeTransaction(claim, control, primaryError) {
  const errors = []
  if (control?.quarantineParentHandle) {
    try { await control.quarantineParentHandle.close() } catch (error) { errors.push(error) }
  }
  if (control) try { await control.handle.close() } catch (error) { errors.push(error) }
  if (claim) try { await claim.handle.close() } catch (error) { errors.push(error) }
  if (errors.length > 0) {
    throw new AggregateError(
      primaryError ? [primaryError, ...errors] : errors,
      'World FFmpeg garbage transaction descriptor release failed.',
    )
  }
}

function terminalDescriptor(control) {
  return Object.freeze({
    parent: control.parent,
    claimPath: control.claim.claimPath,
    claim: structuredClone(control.claim.value),
    intentPath: control.intentPath,
    intent: structuredClone(control.value),
    quarantineParentPath: control.quarantineParentPath,
    quarantinePath: control.quarantinePath,
    completionPath: control.completionPath,
  })
}

async function validateCompletedTransaction(control) {
  await preflightCompletedTransaction(terminalDescriptor(control))
}

async function preflightCompletedTransaction(transaction) {
  const intent = transaction.intent
  const quarantineParentInfo = await optionalLstat(transaction.quarantineParentPath)
  if (!quarantineParentInfo) {
    const displaced = []
    for (const name of await scanGarbageParent(transaction.parent)) {
      const candidatePath = join(transaction.parent, name)
      if (candidatePath === transaction.quarantineParentPath) continue
      const candidate = await optionalLstat(candidatePath)
      if (candidate && sameQuarantineAuthority(candidate, intent.quarantineAuthority)) {
        displaced.push(name)
      }
    }
    if (displaced.length > 0) {
      throw new Error('World FFmpeg completed cleanup private quarantine authority was displaced and was preserved.')
    }
    return Object.freeze({ compacted: true })
  }
  if (!sameQuarantineAuthority(quarantineParentInfo, intent.quarantineAuthority)) {
    throw new Error('World FFmpeg completed cleanup private quarantine has a foreign replacement.')
  }
  const allowedParentNames = new Set([intent.quarantineName])
  if (intent.kind === 'file') allowedParentNames.add(`${intent.quarantineName}.GC.v1.json`)
  for (const name of await readdir(transaction.quarantineParentPath)) {
    if (!allowedParentNames.has(name)) {
      throw new Error('World FFmpeg completed cleanup private quarantine contains a foreign terminal entry.')
    }
  }
  const quarantineInfo = await optionalLstat(transaction.quarantinePath)
  if (quarantineInfo) {
    if (!matchesIntentSource(quarantineInfo, intent, true, true)) {
      throw new Error('World FFmpeg completed cleanup quarantine identity is foreign.')
    }
    if (intent.kind === 'directory') {
      await preflightCompletedDirectory(transaction.quarantinePath, intent)
    } else if (quarantineInfo.size !== 0n) {
      throw new Error('World FFmpeg completed cleanup file is nonzero and was not reclaimed.')
    }
  }
  if (intent.kind === 'file') {
    const receiptPath = `${transaction.quarantinePath}.GC.v1.json`
    const receiptInfo = await optionalLstat(receiptPath)
    if (receiptInfo) {
      const expected = canonicalBytes(fileReceiptForIntent(intent))
      const actual = await readOrdinaryBoundedFile(receiptPath, 16 * 1024)
      if (!actual.equals(expected)) {
        throw new Error('World FFmpeg completed cleanup file receipt has a foreign replacement.')
      }
    }
  }
  return Object.freeze({ compacted: false })
}

async function preflightCompletedDirectory(path, intent) {
  return runWithWorldFfmpegCwdCustody(path, async () => {
    const root = await lstat('.', { bigint: true })
    requireMatchingDirectory(root, intent.sourceIdentity, 'completed cleanup directory identity changed')
    await preflightCompletedDirectoryEntries(buildInventoryChildren(intent.entries), '', intent.sourceIdentity)
    const receiptInfo = await optionalLstat(RECEIPT_NAME)
    if (receiptInfo) {
      const actual = await readOrdinaryBoundedFile(RECEIPT_NAME, 16 * 1024)
      const expected = canonicalBytes(directoryReceiptForIntent(intent))
      if (!actual.equals(expected)) {
        throw new Error('World FFmpeg completed cleanup directory receipt has a foreign replacement.')
      }
    }
  })
}

async function preflightCompletedDirectoryEntries(children, prefix, expectedParent) {
  const parent = await lstat('.', { bigint: true })
  requireMatchingDirectory(parent, expectedParent, 'completed cleanup parent identity changed')
  const expectedByName = new Map((children.get(prefix) ?? []).map((entry) => [basename(entry.path), entry]))
  for (const name of (await readdir('.')).sort(codeUnitCompare)) {
    if (prefix === '' && name === RECEIPT_NAME) continue
    const descriptor = expectedByName.get(name)
    if (!descriptor) {
      throw new Error('World FFmpeg completed cleanup contains a foreign terminal replacement.')
    }
    const info = await lstat(name, { bigint: true })
    if (descriptor.kind === 'directory') {
      requireMatchingDirectory(info, descriptor, `completed cleanup directory changed: ${descriptor.path}`)
      process.chdir(name)
      try { await preflightCompletedDirectoryEntries(children, descriptor.path, descriptor) } finally {
        process.chdir('..')
      }
      const returned = await lstat('.', { bigint: true })
      requireMatchingDirectory(returned, expectedParent, 'completed cleanup parent changed during traversal')
    } else if (!sameFileEntry(info, descriptor, true) || info.size !== 0n) {
      throw new Error(`World FFmpeg completed cleanup file is foreign or nonzero: ${descriptor.path}.`)
    }
  }
}

async function compactCompletedTransaction(transaction, input) {
  const state = await preflightCompletedTransaction(transaction)
  if (state.compacted) return
  const intent = transaction.intent
  if (intent.kind === 'directory' && await optionalLstat(transaction.quarantinePath)) {
    await runWithWorldFfmpegCwdCustody(transaction.quarantinePath, async () => {
      await removeCompletedDirectoryEntries(
        buildInventoryChildren(intent.entries), '', intent.sourceIdentity, input?.beforeCompactionDelete,
      )
      await retireExactCurrentFileIfPresent(RECEIPT_NAME, input?.beforeCompactionDelete)
    })
    await retireExactDirectory(
      transaction.quarantinePath,
      intent.sourceIdentity,
      input?.beforeCompactionDelete,
    )
  } else if (intent.kind === 'file') {
    await retireExactFileIfPresent(
      transaction.quarantinePath,
      intent.sourceIdentity,
      input?.beforeCompactionDelete,
    )
    await retireExactCurrentPathFileIfPresent(
      `${transaction.quarantinePath}.GC.v1.json`, input?.beforeCompactionDelete,
    )
  }
  const parentInfo = await optionalLstat(transaction.quarantineParentPath)
  if (parentInfo) {
    if (!sameQuarantineAuthority(parentInfo, intent.quarantineAuthority)) {
      throw new Error('World FFmpeg completed cleanup private quarantine was replaced before retirement.')
    }
    if ((await readdir(transaction.quarantineParentPath)).length !== 0) {
      throw new Error('World FFmpeg completed cleanup private quarantine is not empty after retirement.')
    }
    await input?.beforeCompactionDelete?.({
      path: transaction.quarantineParentPath,
      kind: 'directory',
      identity: intent.quarantineAuthority,
    })
    const current = await lstat(transaction.quarantineParentPath, { bigint: true })
    if (!sameQuarantineAuthority(current, intent.quarantineAuthority)) {
      throw new Error('World FFmpeg completed cleanup private quarantine was replaced at retirement.')
    }
    try { await rmdir(transaction.quarantineParentPath) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await syncWorldFfmpegDirectory(transaction.parent, input?.durability)
  }
}

async function settleCompletedCompaction(transaction, input) {
  let lastError
  for (let attempt = 0; attempt < 101; attempt += 1) {
    try {
      await compactCompletedTransaction(transaction, input)
      return
    } catch (error) {
      lastError = error
      let state
      try {
        state = await preflightCompletedTransaction(transaction)
      } catch (validationError) {
        if (validationError?.code !== 'ENOENT') throw validationError
      }
      if (state?.compacted) return
      if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) throw error
      if (attempt + 1 < 101) await delay(2)
    }
  }
  throw lastError
}

async function removeCompletedDirectoryEntries(children, prefix, expectedParent, beforeDelete) {
  const parent = await lstat('.', { bigint: true })
  requireMatchingDirectory(parent, expectedParent, 'completed cleanup parent changed before compaction')
  for (const descriptor of [...(children.get(prefix) ?? [])].reverse()) {
    const name = basename(descriptor.path)
    const info = await optionalLstat(name)
    if (!info) continue
    if (descriptor.kind === 'directory') {
      requireMatchingDirectory(info, descriptor, `completed cleanup directory changed: ${descriptor.path}`)
      process.chdir(name)
      try { await removeCompletedDirectoryEntries(children, descriptor.path, descriptor, beforeDelete) } finally {
        process.chdir('..')
      }
      const after = await optionalLstat(name)
      if (!after) continue
      requireMatchingDirectory(after, descriptor, `completed cleanup directory changed at retirement: ${descriptor.path}`)
      await beforeDelete?.({ path: resolve(name), kind: 'directory', identity: directoryIdentity(after) })
      const final = await lstat(name, { bigint: true })
      requireMatchingDirectory(final, descriptor, `completed cleanup directory changed at final retirement: ${descriptor.path}`)
      await rmdir(name)
    } else {
      if (!sameFileEntry(info, descriptor, true) || info.size !== 0n) {
        throw new Error(`World FFmpeg completed cleanup file changed before compaction: ${descriptor.path}.`)
      }
      await retireRetainedFilePath(name, {
        label: `completed cleanup file ${descriptor.path}`,
        beforeDelete,
        validate(candidate) {
          return sameFileEntry(candidate, descriptor, true) && candidate.size === 0n
        },
      })
    }
  }
}

async function retireExactCurrentFileIfPresent(name, beforeDelete) {
  const info = await optionalLstat(name)
  if (!info) return
  if (!ordinarySingleLinkFile(info)) throw new Error('World FFmpeg completed cleanup receipt is foreign.')
  await retireRetainedFilePath(name, {
    label: 'completed cleanup receipt',
    beforeDelete,
    validate(candidate) { return sameStableFile(info, candidate) },
  })
}

async function retireExactCurrentPathFileIfPresent(path, beforeDelete) {
  const info = await optionalLstat(path)
  if (!info) return
  if (!ordinarySingleLinkFile(info)) throw new Error('World FFmpeg completed cleanup file receipt is foreign.')
  await retireRetainedFilePath(path, {
    label: 'completed cleanup file receipt',
    beforeDelete,
    validate(candidate) { return sameStableFile(info, candidate) },
  })
}

async function retireExactFileIfPresent(path, expected, beforeDelete) {
  const info = await optionalLstat(path)
  if (!info) return
  if (!sameFileAuthority(info, expected, true) || info.size !== 0n) {
    throw new Error('World FFmpeg completed cleanup file is foreign or nonzero at retirement.')
  }
  await retireRetainedFilePath(path, {
    label: 'completed cleanup file',
    beforeDelete,
    validate(candidate) {
      return sameFileAuthority(candidate, expected, true) && candidate.size === 0n
    },
  })
}

async function retireRetainedFilePath(path, input) {
  const before = await lstat(path, { bigint: true })
  if (!ordinarySingleLinkFile(before) || !input.validate(before)) {
    throw new Error(`World FFmpeg ${input.label} is foreign before opened retirement.`)
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat({ bigint: true })
    if (!ordinarySingleLinkFile(opened) || !input.validate(opened)
      || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`World FFmpeg ${input.label} changed before opened retirement.`)
    }
    await input.beforeDelete?.({ path: resolve(path), kind: 'file', identity: fileIdentity(opened) })
    const current = await handle.stat({ bigint: true })
    const currentPath = await optionalLstat(path)
    if (!ordinarySingleLinkFile(current) || !input.validate(current)
      || !currentPath || !ordinarySingleLinkFile(currentPath) || !input.validate(currentPath)
      || current.dev !== opened.dev || current.ino !== opened.ino
      || current.dev !== currentPath.dev || current.ino !== currentPath.ino) {
      throw new Error(`World FFmpeg ${input.label} gained a hard link or changed at final retirement.`)
    }
    try { await unlink(path) } catch (error) {
      if (error?.code !== 'ENOENT' || await optionalLstat(path)) throw error
    }
    const retired = await handle.stat({ bigint: true })
    if (retired.nlink !== 0n || retired.dev !== opened.dev || retired.ino !== opened.ino) {
      throw new Error(`World FFmpeg ${input.label} gained a hard link during final retirement.`)
    }
    if (await optionalLstat(path)) {
      throw new Error(`World FFmpeg ${input.label} pathname gained a foreign replacement after retirement; it was preserved.`)
    }
  } finally {
    await handle.close()
  }
}

async function retireExactDirectory(path, expected, beforeDelete) {
  const info = await optionalLstat(path)
  if (!info) return
  requireMatchingDirectory(info, expected, 'completed cleanup root changed before retirement')
  if ((await readdir(path)).length !== 0) {
    throw new Error('World FFmpeg completed cleanup root is not empty at retirement.')
  }
  await beforeDelete?.({ path, kind: 'directory', identity: directoryIdentity(info) })
  const final = await optionalLstat(path)
  if (!final) return
  requireMatchingDirectory(final, expected, 'completed cleanup root changed at final retirement')
  try { await rmdir(path) } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

// These capabilities never originate from recovery input or read-witness callbacks.
function retirementRead(prove) {
  const operation = Object.freeze({})
  retirementReadProofs.set(operation, prove)
  return operation
}

async function reconcileIncompleteRetirementRead(error, operation, handle) {
  const incomplete = incompleteAuthorityReads.get(error)
  if (!incomplete || incomplete.operation !== operation || incomplete.handle !== handle
    || incomplete.size < 1 || incomplete.offset >= incomplete.size) return false
  const prove = retirementReadProofs.get(operation)
  retirementReadProofs.delete(operation)
  if (!prove) return false
  try { return await prove(handle, incomplete) === true } catch { return false }
}

async function captureCompletedAnchor(control, completionInput) {
  const retainedAuthorities = []
  const completion = completionInput?.value
  const retainedCompletionAuthority = completionInput?.retainedAuthority
  let captured = false
  try {
    if (!completion || !retainedCompletionAuthority) return undefined
    retainedAuthorities.push(retainedCompletionAuthority)
    const entries = []
    const byteEntries = []
    for (const [role, owner, value, path] of [
      ['claim', control.claim, control.claim.value, control.claim.claimPath],
      ['intent', control, control.value, control.intentPath],
    ]) {
      const bytes = canonicalBytes(value)
      const fresh = await owner.handle.stat({ bigint: true })
      if (!sameStableFile(owner.identity, fresh) || fresh.birthtimeNs !== owner.identity.birthtimeNs) return undefined
      entries.push({ role, kind: 'file', sourceName: basename(path), destinationName: `${role}.v1.json`,
        authority: ledgerFileAuthority(fresh), sha256: sha256Bytes(bytes) })
      byteEntries.push([`${role}Bytes`, Buffer.from(bytes)])
    }
    const completionBytes = canonicalBytes(completion)
    entries.push({ role: 'tombstone', kind: 'file', sourceName: basename(control.completionPath),
      destinationName: 'tombstone.v1.json', authority: retainedCompletionAuthority.authority,
      sha256: sha256Bytes(completionBytes) })
    byteEntries.push(['completionBytes', Buffer.from(completionBytes)])
    const terminal = terminalDescriptor(control)
    const quarantineInfo = await optionalLstat(terminal.quarantineParentPath)
    if (quarantineInfo) {
      if (!sameQuarantineAuthority(quarantineInfo, terminal.intent.quarantineAuthority)) return undefined
      entries.push({ role: 'quarantine', kind: 'directory', sourceName: basename(terminal.quarantineParentPath),
        destinationName: 'quarantine', authority: garbageProtocol.quarantineAuthorityFromStat(quarantineInfo) })
    }
    const parentInfo = await lstat(control.parent, { bigint: true })
    const anchor = { token: control.claim.value.token, claimName: basename(control.claim.claimPath),
      createdAtMs: control.claim.value.createdAtMs,
      maximumEntries: control.value.maximumEntries, maximumBytes: control.value.maximumBytes,
      plannedEntries: control.value.plannedEntries, plannedBytes: control.value.plannedBytes,
      parentIdentity: parentDirectoryAuthority(parentInfo),
      claimPath: control.claim.claimPath, intentPath: control.intentPath, completionPath: control.completionPath,
      quarantineParentPath: control.quarantineParentPath, quarantinePath: control.quarantinePath,
      claim: structuredClone(control.claim.value), intent: structuredClone(control.value), completion: structuredClone(completion),
      entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
      retainedAuthorities,
      ...Object.fromEntries(byteEntries) }
    const retainedBytes = anchor.claimBytes.byteLength + anchor.intentBytes.byteLength + anchor.completionBytes.byteLength
    if (retainedBytes > MAXIMUM_CLAIM_BYTES + MAXIMUM_INTENT_BYTES + MAXIMUM_TOMBSTONE_BYTES) return undefined
    for (const entry of entries) {
      if (entry.role === 'tombstone') {
        const retainedIdentity = await retainedCompletionAuthority.handle.stat({ bigint: true })
        if (!sameLedgerRetirementEntryAuthority(retainedIdentity, entry, true)
          || retainedIdentity.dev !== control.completionIdentity.dev
          || retainedIdentity.ino !== control.completionIdentity.ino) {
          return undefined
        }
      } else {
        retainedAuthorities.push(Object.freeze(await openCompletedLedgerAnchorAuthority(control.parent, entry)))
      }
    }
    captured = true
    return Object.freeze(anchor)
  } catch {
    return undefined
  } finally {
    if (!captured) await closeCompletedLedgerRecord({ retainedAuthorities }).catch(() => undefined)
  }
}

async function openCompletedLedgerAnchorAuthority(parent, entry) {
  const path = join(parent, entry.sourceName)
  const info = await lstat(path, { bigint: true })
  if (!sameLedgerRetirementEntryAuthority(info, entry, false)) {
    throw new Error('World FFmpeg completed cleanup ledger anchor authority changed before retain.')
  }
  const flags = entry.kind === 'directory'
    ? constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
    : constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  const handle = await open(path, flags)
  try {
    const identity = await handle.stat({ bigint: true })
    if (!sameLedgerRetirementEntryAuthority(identity, entry, false)
      || identity.dev !== info.dev || identity.ino !== info.ino) {
      throw new Error('World FFmpeg completed cleanup ledger anchor authority changed during retain.')
    }
    return { role: entry.role, kind: entry.kind, handle, authority: entry.authority }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

function parentDirectoryAuthority(info) {
  return Object.freeze({
    dev: String(info.dev), ino: String(info.ino), birthtimeNs: String(info.birthtimeNs),
    mode: Number(info.mode & 0o7777n),
  })
}

function sameParentDirectoryAuthority(info, authority) {
  return info?.isDirectory?.() && !info.isSymbolicLink?.()
    && String(info.dev) === authority?.dev && String(info.ino) === authority?.ino
    && String(info.birthtimeNs) === authority?.birthtimeNs
    && Number(info.mode & 0o7777n) === authority?.mode
}

async function closeCompletedLedgerRecord(record) {
  const handles = record?.retainedAuthorities?.map(({ handle }) => handle) ?? []
  const closed = await Promise.allSettled(handles.map((handle) => handle.close()))
  const rejected = closed.filter((result) => result.status === 'rejected')
  if (rejected.length > 0) {
    throw new AggregateError(rejected.map((result) => result.reason), 'Completed ledger anchor handle release failed.')
  }
}

function captureRetirementTerminalValue(values, entry, bytes) {
  if (entry.kind === 'file' && bytes) values.set(entry.role, parseCanonical(bytes, 'retirement terminal binding'))
}

function retirementTerminalBinding(parent, value, values) {
  if (!['claim', 'intent', 'tombstone'].every((role) => values.has(role))) return undefined
  const claim = values.get('claim'), intent = requireIntent(values.get('intent'))
  garbageProtocol.requireClaim(claim, value.claimName)
  garbageProtocol.requireIntentBinding(intent, claim)
  garbageProtocol.requireTombstoneBinding(requireTombstone(values.get('tombstone')), claim, intent)
  if (value.createdAtMs !== intent.createdAtMs || value.maximumEntries !== intent.maximumEntries
    || value.maximumBytes !== intent.maximumBytes || value.plannedEntries !== intent.plannedEntries
    || value.plannedBytes !== intent.plannedBytes) throw new Error('Retirement terminal bounds changed.')
  return { parent, claim, intent, quarantineParentPath: join(parent, intent.quarantineDirectoryName),
    quarantinePath: join(parent, intent.quarantineDirectoryName, intent.quarantineName) }
}

function requireRetirementPolicy(value, bounds) {
  if (value.plannedEntries > bounds.maximumEntries || value.plannedBytes > bounds.maximumBytes) {
    throw new Error('Retirement read reconciliation exceeds the current caller policy.')
  }
}

async function requireRetirementTerminalAbsent(terminal, directoryPath) {
  if (await optionalLstat(terminal.quarantineParentPath)
    || await optionalLstat(join(directoryPath, 'quarantine'))) throw new Error('Retirement still needs terminal data.')
  await preflightCompletedTransaction(terminal)
  for (const name of await scanGarbageParent(terminal.parent, true)) {
    if (!RETIREMENT_DIRECTORY_PATTERN.test(name)) continue
    const candidatePath = join(terminal.parent, name), candidate = await optionalLstat(candidatePath)
    if (!candidate?.isDirectory() || candidate.isSymbolicLink()) {
      throw new Error('Retirement terminal namespace contains an unknown private generation.')
    }
    if (sameQuarantineAuthority(await optionalLstat(join(candidatePath, 'quarantine')), terminal.intent.quarantineAuthority)) {
      throw new Error('Retirement terminal quarantine authority was displaced into another private generation.')
    }
  }
  if (await optionalLstat(terminal.quarantineParentPath) || await optionalLstat(join(directoryPath, 'quarantine'))) {
    throw new Error('Retirement terminal state reappeared during its fresh proof.')
  }
}

async function requireRetirementTuple(context, held = []) {
  const { parent, value, directoryPath, directoryHandle, terminal, callerBounds } = context
  requireRetirementPolicy(value, callerBounds)
  const quarantine = value.entries.find((entry) => entry.role === 'quarantine')
  if (quarantine && ['dev', 'ino', 'birthtimeNs', 'mode'].some((key) => (
    String(quarantine.authority[key]) !== String(terminal.intent.quarantineAuthority[key])
  ))) throw new Error('Retirement manifest quarantine authority conflicts with its complete terminal intent.')
  const paths = value.entries.map((entry) => [join(parent, entry.sourceName), join(directoryPath, entry.destinationName)])
  const finals = new Set([`.WORLD_FFMPEG_GC.retirement-${value.token}.v1.json`,
    value.claimName, `.WORLD_FFMPEG_GC.intent-${value.token}.v1.json`, `.WORLD_FFMPEG_GC.tombstone-${value.token}.v1.json`])
  const snapshot = async () => {
    const directory = await optionalLstat(directoryPath)
    const retained = await directoryHandle.stat({ bigint: true })
    if (!sameQuarantineAuthority(retained, value.directoryAuthority)
      || (directory ? !samePrivateDirectory(directory, retained) : retained.nlink !== 0n)) {
      throw new Error('Retirement retained directory changed or was displaced.')
    }
    const names = await scanGarbageParent(parent, true)
    if (names.some((name) => finals.has(PUBLICATION_TEMP_CANDIDATE_PATTERN.exec(name)?.[1]))) {
      throw new Error('Retirement publication remains in flight.')
    }
    for (const name of names) {
      if (join(parent, name) === directoryPath) continue
      if (sameQuarantineAuthority(await optionalLstat(join(parent, name)), value.directoryAuthority)) {
        throw new Error('Retirement directory authority was displaced.')
      }
    }
    if (directory && (await readdir(directoryPath)).some((name) => !value.entries.some((entry) => entry.destinationName === name))) {
      throw new Error('Retirement private directory contains a foreign entry.')
    }
    await requireRetirementTerminalAbsent(terminal, directoryPath)
    const state = []
    for (let index = 0; index < value.entries.length; index += 1) {
      const entry = value.entries[index], [source, destination] = paths[index]
      const sourceInfo = await optionalLstat(source), destinationInfo = await optionalLstat(destination)
      if (sourceInfo && destinationInfo) throw new Error('Retirement tuple has duplicate current authorities.')
      const current = sourceInfo ?? destinationInfo
      if (entry.kind === 'directory') {
        if (current) throw new Error('Retirement quarantine terminal is not compacted.')
      } else if (current) {
        if (!sameLedgerFileAuthority(current, entry.authority, true)) throw new Error('Retirement tuple is foreign or partial.')
        if (current.size !== 0n) {
          const opened = await validateLedgerAuthorityPath(sourceInfo ? source : destination, entry, false)
          try {
            const after = await opened.handle.stat({ bigint: true })
            if (!sameStableFile(opened.identity, after) || !sameStableFile(current, after)
              || after.birthtimeNs !== current.birthtimeNs) throw new Error('Retirement tuple changed during complete validation.')
          } finally { await opened.handle.close() }
        }
      }
      state.push([readWitnessStat(sourceInfo), readWitnessStat(destinationInfo)])
    }
    for (const owner of held) {
      const fresh = await owner.handle.stat({ bigint: true })
      const index = value.entries.findIndex((entry) => entry.role === owner.role)
      const tuple = state[index]
      if (!tuple || (fresh.nlink === 1n
        ? !sameLedgerFileAuthority(fresh, owner.authority, true)
          || JSON.stringify(readWitnessStat(fresh)) !== JSON.stringify(tuple[0] ?? tuple[1])
        : !sameUnlinkedLedgerFileAuthority(fresh, owner.authority) || tuple.some((path) => path !== null))) {
        throw new Error('Retirement held authority is foreign, aliased, partial or outside its exact tuple.')
      }
      state.push(readWitnessStat(fresh))
    }
    await requireRetirementTerminalAbsent(terminal, directoryPath)
    for (let index = 0; index < paths.length; index += 1) {
      const current = await Promise.all(paths[index].map(async (path) => readWitnessStat(await optionalLstat(path))))
      if (JSON.stringify(current) !== JSON.stringify(state[index])) throw new Error('Retirement paths changed during namespace preflight.')
    }
    if (JSON.stringify(readWitnessStat(await optionalLstat(directoryPath))) !== JSON.stringify(readWitnessStat(directory))
      || JSON.stringify(readWitnessStat(await directoryHandle.stat({ bigint: true }))) !== JSON.stringify(readWitnessStat(retained))) {
      throw new Error('Retirement private directory changed during namespace preflight.')
    }
    if ((await scanGarbageParent(parent, true)).some((name) => finals.has(PUBLICATION_TEMP_CANDIDATE_PATTERN.exec(name)?.[1]))) {
      throw new Error('Retirement publication appeared during namespace preflight.')
    }
    return JSON.stringify(state)
  }
  if (await snapshot() !== await snapshot()) throw new Error('Retirement tuple changed across its fresh proof.')
}

async function readRetainedRetirementManifest(context) {
  const { manifestPath, manifest, callerBounds } = context
  const before = await manifest.handle.stat({ bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || ![0n, 1n].includes(before.nlink)
    || before.size !== manifest.identity.size || before.birthtimeNs !== manifest.identity.birthtimeNs
    || before.dev !== manifest.identity.dev || before.ino !== manifest.identity.ino
    || before.mode !== manifest.identity.mode || before.mtimeNs !== manifest.identity.mtimeNs
    || (before.nlink === 1n && before.ctimeNs !== manifest.identity.ctimeNs)) {
    throw new Error('Retained retirement manifest changed or is aliased.')
  }
  const bytes = await readExactHandle(manifest.handle, Number(before.size))
  const after = await manifest.handle.stat({ bigint: true }), path = await optionalLstat(manifestPath)
  if (JSON.stringify(readWitnessStat(before)) !== JSON.stringify(readWitnessStat(after))
    || (after.nlink === 1n ? !path || !sameStableFile(after, path) || after.birthtimeNs !== path.birthtimeNs : path !== null)
    || sha256Bytes(bytes) !== sha256Bytes(manifest.bytes)) throw new Error('Retained manifest complete proof conflicts.')
  const value = requireLedgerRetirement(parseCanonical(bytes, 'retained retirement manifest'), context.value.token)
  requireRetirementPolicy(value, callerBounds)
  return after
}

function coldRetirementRead(context) {
  return retirementRead(async (handle) => {
    const before = await readRetainedRetirementManifest(context)
    const claim = await handle.stat({ bigint: true })
    const destination = await optionalLstat(join(context.directoryPath, context.entry.destinationName))
    if (claim.size !== 0n || (destination
      ? !sameLedgerFileAuthority(claim, context.entry.authority, true) || !sameStableFile(claim, destination)
      : !sameUnlinkedLedgerFileAuthority(claim, context.entry.authority))) return false
    await requireRetirementTuple(context, [{ handle, role: context.entry.role, authority: context.entry.authority }])
    const after = await readRetainedRetirementManifest(context)
    return JSON.stringify(readWitnessStat(before)) === JSON.stringify(readWitnessStat(after))
  })
}

function pruneRetirementRead(control, anchor, callerBounds) {
  if (!anchor || anchor.token !== control.claim.value.token) return undefined
  const owners = [control.claim, control]
  for (let index = 0; index < owners.length; index += 1) {
    if (!sameLedgerFileAuthority(owners[index].identity, anchor.entries[index].authority, false)
      || sha256Bytes(canonicalBytes(owners[index].value)) !== anchor.entries[index].sha256) return undefined
  }
  return retirementRead(async (handle, incomplete) => {
    if (!sameLedgerFileAuthority(incomplete.identity, anchor.entries[2].authority, false)
      || incomplete.size !== anchor.entries[2].authority.size) return false
    const held = [...owners.map((owner, index) => ({ handle: owner.handle, role: anchor.entries[index].role, authority: anchor.entries[index].authority })),
      { handle, role: 'tombstone', authority: anchor.entries[2].authority }]
    // The initial opened tombstone, not a replacement first observed after EOF, must bind this anchor.
    const fresh = await handle.stat({ bigint: true })
    if (fresh.size !== 0n || (!sameLedgerFileAuthority(fresh, anchor.entries[2].authority, true)
      && !sameUnlinkedLedgerFileAuthority(fresh, anchor.entries[2].authority))) return false
    const terminal = terminalDescriptor(control)
    const parent = control.parent, token = anchor.token
    const directoryPath = join(parent, `.WORLD_FFMPEG_GC.retirement-private-${token}`)
    const manifestPath = join(parent, `.WORLD_FFMPEG_GC.retirement-${token}.v1.json`)
    const fullyRetired = async () => {
      const absent = async () => {
        for (const owner of held) if (!sameUnlinkedLedgerFileAuthority(await owner.handle.stat({ bigint: true }), owner.authority)) return false
        for (const path of [control.claim.claimPath, control.intentPath, control.completionPath, directoryPath, manifestPath]) {
          if (await optionalLstat(path)) return false
        }
        const finals = new Set([basename(manifestPath), basename(control.claim.claimPath), basename(control.intentPath), basename(control.completionPath)])
        return !(await scanGarbageParent(parent, true)).some((name) => finals.has(PUBLICATION_TEMP_CANDIDATE_PATTERN.exec(name)?.[1]))
      }
      if (!(await absent())) return false
      await requireRetirementTerminalAbsent(terminal, directoryPath)
      requireIntentWithinBounds(control.value, callerBounds)
      return absent()
    }
    if (!(await optionalLstat(manifestPath))) return fullyRetired()
    const manifest = await readStablePublicationFile(manifestPath, MAXIMUM_RETIREMENT_BYTES, 'prune retirement manifest')
    let directoryHandle
    try {
      const value = requireLedgerRetirement(manifest.value, token)
      if (manifest.identity.nlink !== 1n || value.claimName !== basename(control.claim.claimPath)) return false
      for (let index = 0; index < 3; index += 1) {
        if (JSON.stringify(value.entries[index].authority) !== JSON.stringify(anchor.entries[index].authority)
          || value.entries[index].sha256 !== anchor.entries[index].sha256) return false
      }
      if (value.createdAtMs !== control.value.createdAtMs || value.maximumEntries !== control.value.maximumEntries
        || value.maximumBytes !== control.value.maximumBytes || value.plannedEntries !== control.value.plannedEntries
        || value.plannedBytes !== control.value.plannedBytes) return false
      directoryHandle = await open(directoryPath, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
      const context = { parent, manifestPath, manifest, value, directoryPath, directoryHandle, terminal, callerBounds }
      const before = await readRetainedRetirementManifest(context)
      await requireRetirementTuple(context, held)
      const after = await readRetainedRetirementManifest(context)
      return JSON.stringify(readWitnessStat(before)) === JSON.stringify(readWitnessStat(after))
    } finally {
      const released = await Promise.allSettled([directoryHandle, manifest.handle].filter(Boolean).map((owner) => owner.close()))
      if (released.some((result) => result.status === 'rejected')) throw new Error('Retirement reconciliation descriptor release failed.')
    }
  })
}

async function pruneCompletedLedger(parent, input, failures, recoveryNames, witness, anchors) {
  const callerBounds = requireBounds(input)
  const recoveryTemporaries = indexPublicationTemporaries(recoveryNames)
  const records = []
  for (const name of recoveryNames) {
    if (!CLAIM_PATTERN.test(name)) continue
    const anchor = anchors.get(name)
    if (anchor) {
      try {
        const record = completedLedgerRecordFromAnchor(parent, anchor, callerBounds)
        await preflightCompletedTransaction(record)
        records.push(record)
        anchors.delete(name)
      } catch (error) {
        failures.push(failureRecord(name, error))
        await closeCompletedLedgerRecord(anchor).catch((releaseError) => {
          failures.push(failureRecord(name, releaseError))
        })
        anchors.delete(name)
      }
      continue
    }
    // Completed-ledger pruning is allowed to retire only records anchored during
    // the first recovery pass. Reopening claim/intent/tombstone here would make a
    // syscall-local race observation authoritative and can lose large valid
    // terminal transactions. Incomplete or failed records remain governed by the
    // ordinary recovery diagnostics emitted while building the anchor map.
  }
  records.sort((left, right) => (
    right.createdAtMs - left.createdAtMs || codeUnitCompare(right.token, left.token)
  ))
  try {
    for (const record of records.slice(COMPLETED_LEDGER_LIMIT)) {
      try {
        await retireCompletedLedgerRecord(record, { ...input, recoveryTemporaries }, witness)
      } catch (error) {
        failures.push(failureRecord(basename(record.claimPath), error))
        // One unresolved durable transaction is the recovery authority for this
        // parent. Do not fan a repeated failure out into an unbounded set of
        // private retirement generations during the same invocation.
        break
      }
    }
  } finally {
    const released = await Promise.allSettled(records.map((record) => closeCompletedLedgerRecord(record)))
    for (const result of released) {
      if (result.status === 'rejected') {
        failures.push(failureRecord('.WORLD_FFMPEG_GC.completed-anchor-release', result.reason))
      }
    }
  }
}

function completedLedgerRecordFromAnchor(parent, anchor, callerBounds) {
  if (!anchor || anchor.claimName !== basename(anchor.claimPath)
    || dirname(anchor.claimPath) !== parent || dirname(anchor.intentPath) !== parent
    || dirname(anchor.completionPath) !== parent || dirname(anchor.quarantineParentPath) !== parent) {
    throw new Error('World FFmpeg completed cleanup ledger anchor is not bound to this parent.')
  }
  requireIntentWithinBounds(anchor.intent, callerBounds)
  garbageProtocol.requireClaim(anchor.claim, anchor.claimName)
  garbageProtocol.requireIntentBinding(anchor.intent, anchor.claim)
  garbageProtocol.requireTombstoneBinding(anchor.completion, anchor.claim, anchor.intent)
  if (!anchor.claimBytes.equals(canonicalBytes(anchor.claim))
    || !anchor.intentBytes.equals(canonicalBytes(anchor.intent))
    || !anchor.completionBytes.equals(canonicalBytes(anchor.completion))) {
    throw new Error('World FFmpeg completed cleanup ledger anchor bytes are mutable.')
  }
  for (const entry of anchor.entries) {
    if (entry.kind === 'file' && !['claim', 'intent', 'tombstone'].includes(entry.role)) {
      throw new Error('World FFmpeg completed cleanup ledger anchor file role is invalid.')
    }
    if (entry.kind === 'directory' && entry.role !== 'quarantine') {
      throw new Error('World FFmpeg completed cleanup ledger anchor directory role is invalid.')
    }
  }
  return Object.freeze({
    createdAtMs: anchor.createdAtMs,
    token: anchor.token,
    parent,
    parentIdentity: structuredClone(anchor.parentIdentity),
    claimPath: anchor.claimPath,
    claim: structuredClone(anchor.claim),
    claimBytes: Buffer.from(anchor.claimBytes),
    intentPath: anchor.intentPath,
    intent: structuredClone(anchor.intent),
    intentBytes: Buffer.from(anchor.intentBytes),
    completionPath: anchor.completionPath,
    completion: structuredClone(anchor.completion),
    completionBytes: Buffer.from(anchor.completionBytes),
    quarantineParentPath: anchor.quarantineParentPath,
    quarantinePath: anchor.quarantinePath,
    entries: Object.freeze(anchor.entries.map((entry) => Object.freeze(structuredClone(entry)))),
    retainedAuthorities: Object.freeze(anchor.retainedAuthorities.map((retained) => Object.freeze(retained))),
  })
}

async function settleCompletedLedgerGeneration(record, manifestPath, directoryPath) {
  const observations = []
  for (let attempt = 0; attempt < 2; attempt += 1) {
    observations.push(await observeCompletedLedgerGeneration(record, manifestPath, directoryPath))
    if (attempt === 0) await delay(2)
  }
  const [first, second] = observations
  if (first.state !== second.state || first.signature !== second.signature) return 'CONFLICT'
  return first.state
}

async function observeCompletedLedgerGeneration(record, manifestPath, directoryPath) {
  try {
    const parent = dirname(record.claimPath)
    const parentInfo = await optionalLstat(parent)
    if (!sameParentDirectoryAuthority(parentInfo, record.parentIdentity)) {
      return Object.freeze({ state: 'CONFLICT', signature: 'parent-conflict' })
    }
    const manifestInfo = await optionalLstat(manifestPath)
    const directoryInfo = await optionalLstat(directoryPath)
    const tuple = await Promise.all(record.entries.map(async (entry) => {
      const sourcePath = join(parent, entry.sourceName)
      const destinationPath = join(directoryPath, entry.destinationName)
      const source = await optionalLstat(sourcePath)
      const destination = await optionalLstat(destinationPath)
      return Object.freeze({ entry, sourcePath, destinationPath, source, destination })
    }))
    const names = await scanGarbageParent(parent, true)
    const related = completedLedgerGenerationRelatedNames(record, manifestPath, directoryPath)
    const relatedNames = names.filter((name) => related.has(name)
      || (PUBLICATION_TEMP_CANDIDATE_PATTERN.test(name) && related.has(PUBLICATION_TEMP_CANDIDATE_PATTERN.exec(name)[1])))
    const signature = () => readLedgerStateSignature([parentInfo, manifestInfo, directoryInfo,
      ...tuple.flatMap(({ source, destination }) => [source, destination])])
    if (manifestInfo) {
      await requireManifestBoundCompletedGeneration(record, manifestPath, directoryPath, manifestInfo, directoryInfo, tuple, names)
      return Object.freeze({ state: 'MANIFEST_BOUND', signature: signature() })
    }
    if (relatedNames.length === 0 && tuple.every(({ source, destination }) => !source && !destination) && !directoryInfo) {
      await requireFullyRetiredCompletedGeneration(record, parent, names)
      return Object.freeze({ state: 'FULLY_RETIRED', signature: `fully-retired:${readLedgerRetainedSignature(record)}` })
    }
    if (!directoryInfo && relatedNames.every((name) => !RETIREMENT_PATTERN.test(name)
      && !RETIREMENT_DIRECTORY_PATTERN.test(name)
      && !PUBLICATION_TEMP_CANDIDATE_PATTERN.test(name))) {
      for (const { entry, source, destination } of tuple) {
        if (destination) return Object.freeze({ state: 'CONFLICT', signature: signature() })
        if (entry.kind === 'file') {
          if (!source || !sameLedgerRetirementEntryAuthority(source, entry, false)) return Object.freeze({ state: 'CONFLICT', signature: signature() })
        } else if (!source || !sameQuarantineAuthority(source, entry.authority)) {
          return Object.freeze({ state: 'CONFLICT', signature: signature() })
        }
      }
      await requireNoDisplacedCompletedAuthorities(record, parent, names)
      return Object.freeze({ state: 'INTACT', signature: signature() })
    }
    return Object.freeze({ state: 'CONFLICT', signature: signature() })
  } catch {
    return Object.freeze({ state: 'CONFLICT', signature: 'classification-error' })
  }
}

function completedLedgerGenerationRelatedNames(record, manifestPath, directoryPath) {
  return new Set([
    basename(record.claimPath), basename(record.intentPath), basename(record.completionPath),
    basename(record.quarantineParentPath), basename(manifestPath), basename(directoryPath),
    ...record.entries.flatMap((entry) => [entry.sourceName, entry.destinationName]),
  ])
}

async function requireManifestBoundCompletedGeneration(record, manifestPath, directoryPath, manifestInfo, directoryInfo, tuple, names) {
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.nlink !== 1n) {
    throw new Error('Completed ledger generation manifest is not an ordinary single-link authority.')
  }
  const manifest = await readStablePublicationFile(
    manifestPath, MAXIMUM_RETIREMENT_BYTES, 'completed cleanup ledger retirement intent',
  )
  try {
    const value = requireLedgerRetirement(manifest.value, record.token)
    if (value.claimName !== basename(record.claimPath)
      || value.createdAtMs !== record.createdAtMs
      || value.maximumEntries !== record.intent.maximumEntries
      || value.maximumBytes !== record.intent.maximumBytes
      || value.plannedEntries !== record.intent.plannedEntries
      || value.plannedBytes !== record.intent.plannedBytes
      || value.directoryName !== basename(directoryPath)
      || JSON.stringify(value.entries) !== JSON.stringify(record.entries)) {
      throw new Error('Completed ledger generation manifest does not match its immutable anchor.')
    }
    if (!directoryInfo || !directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
      || !sameQuarantineAuthority(directoryInfo, value.directoryAuthority)) {
      throw new Error('Completed ledger generation directory is foreign.')
    }
    const related = completedLedgerGenerationRelatedNames(record, manifestPath, directoryPath)
    if (names.some((name) => {
      const temporary = PUBLICATION_TEMP_CANDIDATE_PATTERN.exec(name)
      return temporary && related.has(temporary[1])
    })) throw new Error('Completed ledger generation has an in-flight publication temporary.')
    const allowedChildren = new Set(value.entries.map((entry) => entry.destinationName))
    const children = await readdir(directoryPath)
    if (children.some((name) => !allowedChildren.has(name))) {
      throw new Error('Completed ledger generation private directory contains an unknown child.')
    }
    for (const { entry, source, destination } of tuple) {
      if (source && destination) throw new Error('Completed ledger generation has duplicate source and destination authorities.')
      const current = source ?? destination
      if (!current) throw new Error('Completed ledger generation manifest entry is missing from source and destination.')
      if (entry.kind === 'file') {
        if (!sameLedgerRetirementEntryAuthority(current, entry, false)) throw new Error('Completed ledger generation file authority is foreign.')
      } else if (!sameQuarantineAuthority(current, entry.authority)) {
        throw new Error('Completed ledger generation quarantine authority is foreign.')
      }
    }
    await requireNoDisplacedCompletedAuthorities(record, dirname(record.claimPath), names)
  } finally {
    await manifest.handle.close()
  }
}

async function requireFullyRetiredCompletedGeneration(record, parent, names) {
  for (const retained of record.retainedAuthorities) {
    const info = await retained.handle.stat({ bigint: true })
    if (retained.kind === 'file') {
      if (!sameUnlinkedLedgerFileAuthority(info, retained.authority)) {
        throw new Error('Completed ledger retained file authority is not fully retired.')
      }
    } else if (info.nlink !== 0n || !sameQuarantineAuthority(info, retained.authority)) {
      throw new Error('Completed ledger retained directory authority is not fully retired.')
    }
  }
  await requireNoDisplacedCompletedAuthorities(record, parent, names)
}

async function requireNoDisplacedCompletedAuthorities(record, parent, names) {
  const known = completedLedgerKnownNames(record)
  for (const name of names) {
    if (known.has(name)) continue
    const info = await optionalLstat(join(parent, name))
    if (!info) continue
    if (record.entries.some((entry) => sameLedgerRetirementEntryAuthority(info, entry, true))) {
      throw new Error('Completed ledger generation authority was displaced under another name.')
    }
  }
}

function completedLedgerKnownNames(record) {
  return new Set([
    basename(record.claimPath), basename(record.intentPath), basename(record.completionPath),
    basename(record.quarantineParentPath),
    ...record.entries.flatMap((entry) => [entry.sourceName, entry.destinationName]),
  ])
}

function readLedgerRetainedSignature(record) {
  return JSON.stringify(record.retainedAuthorities.map(({ role, kind, authority, handle }) => ({
    role, kind, authority, fd: handle.fd,
  })))
}

function readLedgerStateSignature(states) {
  return JSON.stringify(states.map((state) => (state ? {
    dev: String(state.dev), ino: String(state.ino), birthtimeNs: String(state.birthtimeNs),
    mode: String(state.mode), nlink: String(state.nlink), size: String(state.size),
  } : null)))
}

async function retireCompletedLedgerRecord(record, input, witness) {
  const parent = dirname(record.claimPath)
  const manifestPath = join(parent, `.WORLD_FFMPEG_GC.retirement-${record.token}.v1.json`)
  const directoryName = `.WORLD_FFMPEG_GC.retirement-private-${record.token}`
  const directoryPath = join(parent, directoryName)
  const activeRecord = record
  const generationState = await settleCompletedLedgerGeneration(activeRecord, manifestPath, directoryPath)
  if (generationState === 'FULLY_RETIRED') return
  if (generationState === 'CONFLICT') {
    throw new Error('World FFmpeg completed cleanup ledger generation namespace is conflicted.')
  }
  await recoverBoundPublicationTemporaries({
      finalPath: manifestPath,
      recoveryTemporaries: input?.recoveryTemporaries,
      maximumBytes: MAXIMUM_RETIREMENT_BYTES,
      label: 'completed cleanup ledger retirement intent',
      durability: input?.durability,
      validate(value) { requireLedgerRetirement(value, activeRecord.token) },
  })
  if (!(await optionalLstat(manifestPath))) {
      let directoryHandle
      let retainedDirectory
      let createdDirectory = false
      try {
        await mkdir(directoryPath, { mode: 0o700 })
        createdDirectory = true
        await syncWorldFfmpegDirectory(parent, input?.durability)
        const directoryInfo = await lstat(directoryPath, { bigint: true })
        directoryHandle = await open(
          directoryPath,
          constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
        )
        retainedDirectory = await directoryHandle.stat({ bigint: true })
        if (!samePrivateDirectory(directoryInfo, retainedDirectory)) {
          throw new Error('World FFmpeg completed cleanup ledger retirement directory changed before open.')
        }
        const entries = [...activeRecord.entries]
        await preflightCompletedTransaction(activeRecord)
        const value = Object.freeze({
          schema: RETIREMENT_SCHEMA,
          token: activeRecord.token,
          claimName: basename(activeRecord.claimPath),
          createdAtMs: activeRecord.createdAtMs,
          maximumEntries: activeRecord.intent.maximumEntries,
          maximumBytes: activeRecord.intent.maximumBytes,
          plannedEntries: activeRecord.intent.plannedEntries,
          plannedBytes: activeRecord.intent.plannedBytes,
          directoryName,
          directoryAuthority: garbageProtocol.quarantineAuthorityFromStat(retainedDirectory),
          entries: Object.freeze(entries),
        })
        requireLedgerRetirement(value, activeRecord.token)
        await publishCanonicalAuthority({
          finalPath: manifestPath,
          bytes: canonicalBytes(value),
          maximumBytes: MAXIMUM_RETIREMENT_BYTES,
          label: 'completed cleanup ledger retirement intent',
          durability: input?.durability,
          validate(candidate) { requireLedgerRetirement(candidate, activeRecord.token) },
          afterTempSync: input?.afterLedgerRetirementIntentTempSync,
          afterPublish: input?.afterLedgerRetirementIntentPublish,
          afterDirectorySync: input?.afterLedgerRetirementIntentDirectorySync,
        })
      } catch (error) {
        let unpublishedDirectoryRetired = false
        const publicationTemporaries = (await scanGarbageParent(parent)).filter((name) => (
          name.startsWith(`${basename(manifestPath)}.tmp-`)
        ))
        if (createdDirectory && directoryHandle && retainedDirectory
          && !(await optionalLstat(manifestPath)) && publicationTemporaries.length === 0
          && (await readdir(directoryPath)).length === 0) {
          const current = await lstat(directoryPath, { bigint: true })
          const retained = await directoryHandle.stat({ bigint: true })
          if (!retainedDirectory || !samePrivateDirectory(retainedDirectory, retained)
            || !samePrivateDirectory(retained, current)) throw error
          await directoryHandle.close()
          directoryHandle = undefined
          await rmdir(directoryPath)
          await syncWorldFfmpegDirectory(parent, input?.durability)
          unpublishedDirectoryRetired = true
        }
        if (error?.code === 'ENOENT' && unpublishedDirectoryRetired) {
          const currentState = await settleCompletedLedgerGeneration(activeRecord, manifestPath, directoryPath)
          if (currentState === 'FULLY_RETIRED') return
          if (currentState === 'CONFLICT') {
            throw new Error('World FFmpeg completed cleanup ledger generation namespace is conflicted.', { cause: error })
          }
          throw error
        } else if (error?.code === 'EEXIST') {
          for (let attempt = 0; attempt < 101 && !(await optionalLstat(manifestPath)); attempt += 1) {
            await delay(2)
          }
          if (!(await optionalLstat(manifestPath))) {
            throw new Error('World FFmpeg completed cleanup ledger retirement directory is occupied without a durable intent.', { cause: error })
          }
        } else {
          throw error
        }
      } finally {
        await directoryHandle?.close()
      }
  }
  await input?.afterLedgerRetirementIntentDurable?.({ manifestPath, token: activeRecord.token })
  await executeLedgerRetirement(manifestPath, input, witness, activeRecord)
}

async function recoverLedgerRetirementTransactions(parent, input, failures, names, witness) {
  const recoveryTemporaries = indexPublicationTemporaries(names)
  const retirementAuthorities = names.filter((name) => (
    name.startsWith('.WORLD_FFMPEG_GC.retirement-')
    || name.startsWith('.WORLD_FFMPEG_GC.retirement-private-')
  ))
  if (retirementAuthorities.length > MAXIMUM_PUBLICATION_TEMPORARIES) {
    failures.push(failureRecord(
      '.WORLD_FFMPEG_GC.retirement-*',
      new Error('World FFmpeg completed cleanup ledger retirement authority count exceeds its recovery bound.'),
    ))
    return Object.freeze({ blocked: true })
  }
  const finals = new Set()
  let blocked = false
  for (const name of names) {
    if (RETIREMENT_PATTERN.test(name)) finals.add(name)
    const temporary = PUBLICATION_TEMP_CANDIDATE_PATTERN.exec(name)
    if (temporary && RETIREMENT_PATTERN.test(temporary[1])) finals.add(temporary[1])
  }
  for (const name of finals) {
    try {
      const match = RETIREMENT_PATTERN.exec(name)
      const token = match?.[1]
      const publication = await recoverBoundPublicationTemporaries({
        finalPath: join(parent, name),
        recoveryTemporaries,
        maximumBytes: MAXIMUM_RETIREMENT_BYTES,
        label: 'completed cleanup ledger retirement intent',
        durability: input?.durability,
        validate(value) { requireLedgerRetirement(value, token) },
        tolerateInvalid: true,
      })
      if (publication.failures.length > 0) {
        blocked = true
        failures.push(failureRecord(name, publicationRecoveryError(
          'completed cleanup ledger retirement intent', publication.failures,
        )))
      }
      if (await optionalLstat(join(parent, name))) {
        await executeLedgerRetirement(join(parent, name), input, witness)
      }
    } catch (error) {
      blocked = true
      failures.push(failureRecord(name, error))
    }
  }
  const current = finals.size > 0 ? await scanGarbageParent(parent, true) : names
  for (const name of current) {
    if (RETIREMENT_DIRECTORY_PATTERN.test(name)) {
      const token = RETIREMENT_DIRECTORY_PATTERN.exec(name)[1]
      const manifestName = `.WORLD_FFMPEG_GC.retirement-${token}.v1.json`
      if (!current.includes(manifestName)
        && !current.some((candidate) => candidate.startsWith(`${manifestName}.tmp-`))) {
        blocked = true
        failures.push(failureRecord(name, new Error('World FFmpeg completed cleanup ledger retirement directory has no durable intent and was preserved.')))
      }
    } else if (name.startsWith('.WORLD_FFMPEG_GC.retirement-')
      && !RETIREMENT_PATTERN.test(name)) {
      const temporary = PUBLICATION_TEMP_CANDIDATE_PATTERN.exec(name)
      if (!temporary || !RETIREMENT_PATTERN.test(temporary[1])) {
        blocked = true
        failures.push(failureRecord(name, new Error('World FFmpeg completed cleanup ledger retirement authority is malformed and was preserved.')))
      }
    }
  }
  return Object.freeze({ blocked })
}

async function executeLedgerRetirement(manifestPath, input, witness, activeRecord) {
  const manifest = await readStablePublicationFile(
    manifestPath, MAXIMUM_RETIREMENT_BYTES, 'completed cleanup ledger retirement intent',
  )
  let directoryHandle
  let primaryError
  let value
  let parent
  let directoryPath
  try {
    value = requireLedgerRetirement(manifest.value, RETIREMENT_PATTERN.exec(basename(manifestPath))?.[1])
    const callerBounds = requireBounds(input)
    if (value.plannedEntries > callerBounds.maximumEntries
      || value.plannedBytes > callerBounds.maximumBytes) {
      throw new Error('World FFmpeg completed cleanup ledger retirement exceeds the current caller policy bound.')
    }
    if (manifest.identity.nlink !== 1n) {
      throw new Error('World FFmpeg completed cleanup ledger retirement intent has a hard link alias.')
    }
    parent = dirname(manifestPath)
    directoryPath = join(parent, value.directoryName)
    const directoryInfo = await optionalLstat(directoryPath)
    const sourcesRemaining = await ledgerRetirementSourcesRemaining(parent, value)
    if (!directoryInfo) {
      if (sourcesRemaining) {
        throw new Error('World FFmpeg completed cleanup ledger retirement directory disappeared before all authorities were retired.')
      }
      await retireLedgerManifest(manifestPath, manifest, input)
      return
    }
    directoryHandle = await open(
      directoryPath,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    )
    const retainedDirectory = await directoryHandle.stat({ bigint: true })
    if (!samePrivateDirectory(directoryInfo, retainedDirectory)
      || !sameQuarantineAuthority(retainedDirectory, value.directoryAuthority)) {
      throw new Error('World FFmpeg completed cleanup ledger retirement directory has a foreign replacement.')
    }
    const terminalValues = new Map()
    for (let index = 0; index < value.entries.length; index += 1) {
      const entry = value.entries[index]
      const sourcePath = join(parent, entry.sourceName)
      const destination = join(directoryPath, entry.destinationName)
      let sourceInfo = await optionalLstat(sourcePath)
      let destinationInfo = await optionalLstat(destination)
      if (sourceInfo && destinationInfo) {
        // The observations are sequential. A concurrent exact executor may
        // have moved the source between them, so reconcile current state
        // before classifying this as a conflicting double authority.
        for (let attempt = 0; attempt < 101 && sourceInfo && destinationInfo; attempt += 1) {
          if (attempt > 0) await delay(2)
          sourceInfo = await optionalLstat(sourcePath)
          destinationInfo = await optionalLstat(destination)
        }
        if (sourceInfo && destinationInfo) {
          throw new Error('World FFmpeg completed cleanup ledger retirement found both source and destination authorities.')
        }
      }
      if (!sourceInfo) {
        if (destinationInfo) {
          const openedDestination = await validateLedgerRetirementEntryPath(destination, entry, true)
          try { captureRetirementTerminalValue(terminalValues, entry, openedDestination.bytes) }
          finally { await openedDestination.handle.close() }
        }
        continue
      }
      if (destinationInfo) {
        throw new Error('World FFmpeg completed cleanup ledger retirement destination is occupied.')
      }
      let lstatContext
      if (witness?.spec.scenario === 'executor-source-claim' && entry.role === 'claim'
        && value.claimName === witness.spec.claimName) {
        if (witness.used || parent !== witness.parent || value.token !== witness.spec.token
          || sourcePath !== join(parent, witness.spec.claimName)) throw new Error('Lstat witness target context conflicts.')
        witness.used = true
        lstatContext = { witness, path: sourcePath, sourceInfo, manifestPath, manifest,
          directoryPath, directoryHandle, terminalValues }
      }
      let opened
      try {
        opened = await validateLedgerRetirementEntryPath(sourcePath, entry, false, false, lstatContext)
      } catch (error) {
        if (error?.code === 'ENOENT' && !(await optionalLstat(sourcePath))) {
          const racedDestination = await optionalLstat(destination)
          if (racedDestination) {
            if (sameLedgerRetirementEntryAuthority(racedDestination, entry, false)) continue
          } else if (!(await optionalLstat(directoryPath)) && !(await optionalLstat(manifestPath))) {
            continue
          }
        }
        throw error
      }
      try {
        captureRetirementTerminalValue(terminalValues, entry, opened.bytes)
        if (entry.role === 'quarantine') {
          const terminal = await readRetiredLedgerTerminal(
            directoryPath, value, sourcePath,
          )
          await preflightCompletedTransaction(terminal)
        }
        await input?.beforeLedgerRetirement?.({
          path: sourcePath,
          destination,
          identity: entry.kind === 'file' ? fileIdentity(opened.identity) : entry.authority,
          role: entry.role,
        })
        const current = await opened.handle.stat({ bigint: true })
        const currentPath = await optionalLstat(sourcePath)
        if (!sameLedgerRetirementEntryAuthority(current, entry, false)) {
          throw new Error('World FFmpeg completed cleanup ledger authority gained a hard link or changed before retirement move.')
        }
        if (!currentPath) {
          const racedDestination = await optionalLstat(destination)
          if (!racedDestination || !sameLedgerRetirementEntryAuthority(racedDestination, entry, false)) {
            throw new Error('World FFmpeg completed cleanup ledger authority disappeared before retirement move.')
          }
          continue
        }
        if (!sameLedgerRetirementEntryAuthority(currentPath, entry, false)
          || current.dev !== currentPath.dev || current.ino !== currentPath.ino) {
          throw new Error('World FFmpeg completed cleanup ledger authority gained a hard link or changed before retirement move.')
        }
        try { await rename(sourcePath, destination) } catch (error) {
          if (!['ENOENT', 'EEXIST'].includes(error?.code)) throw error
          const racedSource = await optionalLstat(sourcePath)
          const racedDestination = await optionalLstat(destination)
          if (racedSource || !racedDestination
            || !sameLedgerRetirementEntryAuthority(racedDestination, entry, false)) throw error
        }
        const moved = await lstat(destination, { bigint: true })
        if (!sameLedgerRetirementEntryAuthority(moved, entry, false)) {
          throw new Error('World FFmpeg completed cleanup ledger retirement moved a foreign authority.')
        }
      } finally {
        await opened.handle.close()
      }
      await input?.afterLedgerRetirementMove?.({ manifestPath, sourcePath, destination, role: entry.role, index })
      await syncWorldFfmpegDirectory(parent, input?.durability)
      await input?.afterLedgerRetirementSourceSync?.({ manifestPath, role: entry.role, index })
      await syncWorldFfmpegDirectory(directoryPath, input?.durability)
      await input?.afterLedgerRetirementDirectorySync?.({ manifestPath, role: entry.role, index })
    }
    const terminalBinding = retirementTerminalBinding(parent, value, terminalValues)
    await reclaimLedgerRetirementQuarantine(directoryPath, value, input)
    for (let index = 0; index < value.entries.length; index += 1) {
      const entry = value.entries[index]
      if (entry.kind !== 'file') continue
      const destination = join(directoryPath, entry.destinationName)
      if (!(await optionalLstat(destination))) continue
      let opened
      try {
        opened = await validateLedgerAuthorityPath(destination, entry, true, true,
          qualifyReadWitness(witness, parent, value.claimName, value.token, 'executor-reclaim-claim', entry.role, destination),
          entry.role === 'claim' && terminalBinding
            ? coldRetirementRead({ parent, manifestPath, manifest, value, directoryPath, directoryHandle,
              retainedDirectory, terminal: terminalBinding, callerBounds, entry }) : undefined)
      } catch (error) {
        if (error?.code === 'ENOENT' && !(await optionalLstat(destination))) continue
        throw error
      }
      try {
        const retirementSize = opened.identity.size
        if (retirementSize !== 0n && Number(retirementSize) !== entry.authority.size) {
          throw new Error('World FFmpeg completed cleanup ledger authority size conflicts with its retirement intent.')
        }
        await input?.beforeLedgerReclaim?.({ path: destination, identity: fileIdentity(opened.identity), role: entry.role })
        const current = await opened.handle.stat({ bigint: true })
        const currentPath = await optionalLstat(destination)
        if (!currentPath) {
          const reconciled = await opened.handle.stat({ bigint: true })
          if (sameUnlinkedLedgerFileAuthority(reconciled, entry.authority)) continue
        }
        if (!sameLedgerFileAuthority(current, entry.authority, true) || current.size !== retirementSize
          || !currentPath || !sameLedgerFileAuthority(currentPath, entry.authority, true) || currentPath.size !== retirementSize
          || current.dev !== currentPath.dev || current.ino !== currentPath.ino) {
          throw new Error('World FFmpeg completed cleanup ledger authority gained a hard link or changed before reclaim.')
        }
        await input?.afterLedgerReclaim?.({ manifestPath, path: destination, role: entry.role, index })
        await input?.beforeLedgerFinalDelete?.({ path: destination, identity: fileIdentity(current), role: entry.role })
        const final = await opened.handle.stat({ bigint: true })
        const finalPath = await optionalLstat(destination)
        if (!finalPath) {
          const reconciled = await opened.handle.stat({ bigint: true })
          if (completedLedgerFinalUnlinkReconciled(reconciled, null, entry, retirementSize)) continue
          throw completedLedgerFinalUnlinkError(reconciled, null)
        }
        if (!sameLedgerFileAuthority(final, entry.authority, true) || final.size !== retirementSize
          || !sameLedgerFileAuthority(finalPath, entry.authority, true) || finalPath.size !== retirementSize
          || final.dev !== finalPath.dev || final.ino !== finalPath.ino) {
          const racedRetained = await opened.handle.stat({ bigint: true })
          const racedPath = await optionalLstat(destination)
          if (completedLedgerFinalUnlinkReconciled(racedRetained, racedPath, entry, retirementSize)) continue
          throw completedLedgerFinalUnlinkError(racedRetained, racedPath)
        }
        await input?.afterLedgerFinalCheck?.({ manifestPath, path: destination, role: entry.role, index })
        try { await unlink(destination) } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
        const unlinked = await opened.handle.stat({ bigint: true })
        const remainingPath = await optionalLstat(destination)
        if (!completedLedgerFinalUnlinkReconciled(unlinked, remainingPath, entry, retirementSize)) {
          const racedUnlinked = await opened.handle.stat({ bigint: true })
          const racedRemainingPath = await optionalLstat(destination)
          if (!completedLedgerFinalUnlinkReconciled(racedUnlinked, racedRemainingPath, entry, retirementSize)) {
            throw completedLedgerFinalUnlinkError(racedUnlinked, racedRemainingPath)
          }
        }
      } finally {
        await opened.handle.close()
      }
      await input?.afterLedgerFinalDelete?.({ manifestPath, path: destination, role: entry.role, index })
      await syncWorldFfmpegDirectory(directoryPath, input?.durability)
      await input?.afterLedgerFinalDeleteSync?.({ manifestPath, role: entry.role, index })
    }
    const retainedFinalDirectory = await directoryHandle.stat({ bigint: true })
    const finalDirectory = await optionalLstat(directoryPath)
    if (!sameQuarantineAuthority(retainedFinalDirectory, value.directoryAuthority)) {
      throw new Error('World FFmpeg completed cleanup ledger retirement directory authority changed.')
    }
    if (!finalDirectory) {
      await directoryHandle.close()
      directoryHandle = undefined
      await syncWorldFfmpegDirectory(parent, input?.durability)
      await retireLedgerManifest(manifestPath, manifest, input)
      return
    }
    if (!samePrivateDirectory(finalDirectory, retainedFinalDirectory)
      || (await readdir(directoryPath)).length !== 0) {
      throw new Error('World FFmpeg completed cleanup ledger retirement directory changed or is not empty at retirement.')
    }
    await input?.beforeLedgerRetirementDirectoryDelete?.({ manifestPath, directoryPath })
    const deleteDirectory = await optionalLstat(directoryPath)
    if (deleteDirectory && !samePrivateDirectory(retainedFinalDirectory, deleteDirectory)) {
      throw new Error('World FFmpeg completed cleanup ledger retirement directory was replaced at final deletion.')
    }
    await directoryHandle.close()
    directoryHandle = undefined
    if (deleteDirectory) try { await rmdir(directoryPath) } catch (error) {
      if (error?.code !== 'ENOENT' || await optionalLstat(directoryPath)) throw error
    }
    await input?.afterLedgerRetirementDirectoryDelete?.({ manifestPath, directoryPath })
    await syncWorldFfmpegDirectory(parent, input?.durability)
    await input?.afterLedgerRetirementParentSync?.({ manifestPath, directoryPath })
    await retireLedgerManifest(manifestPath, manifest, input)
  } catch (error) {
    const injectedProofFailure = String(error?.message ?? '').startsWith('fixture ')
      || error?.code === 'WORLD_FFMPEG_AUTHORITY_READ_INCOMPLETE'
    const generationState = activeRecord && !injectedProofFailure
      ? await settleCompletedLedgerGeneration(
        activeRecord,
        manifestPath,
        join(dirname(activeRecord.claimPath), `.WORLD_FFMPEG_GC.retirement-private-${activeRecord.token}`),
      )
      : 'CONFLICT'
    if (generationState === 'FULLY_RETIRED') return
    primaryError = error
    throw error
  } finally {
    const closeErrors = []
    if (directoryHandle) try { await directoryHandle.close() } catch (error) { closeErrors.push(error) }
    try { await manifest.handle.close() } catch (error) { closeErrors.push(error) }
    if (closeErrors.length > 0) {
      throw new AggregateError(
        primaryError ? [primaryError, ...closeErrors] : closeErrors,
        'World FFmpeg completed cleanup ledger retirement descriptor release failed.',
      )
    }
  }
}

async function ledgerRetirementSourcesRemaining(parent, value) {
  for (const entry of value.entries) if (await optionalLstat(join(parent, entry.sourceName))) return true
  return false
}

async function reclaimLedgerRetirementQuarantine(directoryPath, value, input) {
  const entry = value.entries.find(({ role }) => role === 'quarantine')
  if (!entry) return
  const quarantineParentPath = join(directoryPath, entry.destinationName)
  if (!(await optionalLstat(quarantineParentPath))) return
  const terminal = await readRetiredLedgerTerminal(
    directoryPath, value, quarantineParentPath,
  )
  await settleCompletedCompaction(terminal, {
    durability: input?.durability,
    async beforeCompactionDelete(details) {
      let role = 'quarantine-content'
      if (details.path === terminal.quarantinePath) role = 'quarantine'
      else if (details.path === `${terminal.quarantinePath}.GC.v1.json`
        || basename(details.path) === RECEIPT_NAME) role = 'receipt'
      await input?.beforeLedgerReclaim?.({ ...details, role })
    },
  })
}

async function readRetiredLedgerTerminal(directoryPath, value, quarantineParentPath) {
  const claim = await readRetiredLedgerAuthorityValue(directoryPath, value, 'claim')
  garbageProtocol.requireClaim(claim, value.claimName)
  const intent = requireIntent(await readRetiredLedgerAuthorityValue(
    directoryPath, value, 'intent',
  ))
  garbageProtocol.requireIntentBinding(intent, claim)
  if (value.createdAtMs !== intent.createdAtMs
    || value.maximumEntries !== intent.maximumEntries
    || value.maximumBytes !== intent.maximumBytes
    || value.plannedEntries !== intent.plannedEntries
    || value.plannedBytes !== intent.plannedBytes) {
    throw new Error('World FFmpeg completed cleanup ledger retirement bounds conflict with its exact intent.')
  }
  const completion = requireTombstone(await readRetiredLedgerAuthorityValue(
    directoryPath, value, 'tombstone',
  ))
  garbageProtocol.requireTombstoneBinding(completion, claim, intent)
  return Object.freeze({
    parent: directoryPath,
    claimPath: join(directoryPath, 'claim.v1.json'),
    claim,
    intentPath: join(directoryPath, 'intent.v1.json'),
    intent,
    quarantineParentPath,
    quarantinePath: join(quarantineParentPath, intent.quarantineName),
    completionPath: join(directoryPath, 'tombstone.v1.json'),
    completion,
  })
}

async function readRetiredLedgerAuthorityValue(directoryPath, value, role) {
  const entry = value.entries.find((candidate) => candidate.role === role)
  if (!entry || entry.kind !== 'file') {
    throw new Error(`World FFmpeg completed cleanup ledger ${role} authority is unavailable.`)
  }
  const opened = await validateLedgerAuthorityPath(
    join(directoryPath, entry.destinationName), entry, false,
  )
  try {
    if (!opened.bytes) {
      throw new Error(`World FFmpeg completed cleanup ledger ${role} authority was reclaimed before quarantine retirement.`)
    }
    return parseCanonical(opened.bytes, `completed cleanup ledger ${role} authority`)
  } finally {
    await opened.handle.close()
  }
}

async function validateLedgerRetirementEntryPath(path, entry, allowReclaimed, writable = false, lstatContext) {
  if (entry.kind === 'file') {
    return validateLedgerAuthorityPath(path, entry, allowReclaimed, writable, undefined, undefined, lstatContext)
  }
  const pathInfo = await lstat(path, { bigint: true })
  if (!sameQuarantineAuthority(pathInfo, entry.authority)) {
    throw new Error('World FFmpeg completed cleanup ledger quarantine authority is foreign.')
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  )
  try {
    const identity = await handle.stat({ bigint: true })
    if (!samePrivateDirectory(pathInfo, identity)
      || !sameQuarantineAuthority(identity, entry.authority)) {
      throw new Error('World FFmpeg completed cleanup ledger quarantine authority changed before open.')
    }
    return { handle, identity, bytes: null }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

function sameLedgerRetirementEntryAuthority(info, entry, allowReclaimed) {
  return entry.kind === 'file'
    ? sameLedgerFileAuthority(info, entry.authority, allowReclaimed)
    : sameQuarantineAuthority(info, entry.authority)
}

function completedLedgerAuthorityDebug(info) {
  if (!info) return null
  return Object.freeze({
    dev: String(info.dev),
    ino: String(info.ino),
    nlink: String(info.nlink),
    size: String(info.size),
    birthtimeNs: String(info.birthtimeNs),
    mode: String(info.mode & 0o7777n),
    isFile: Boolean(info.isFile?.()),
    isSymbolicLink: Boolean(info.isSymbolicLink?.()),
  })
}

function completedLedgerFinalUnlinkReconciled(retained, pathInfo, entry, retirementSize) {
  return entry.kind === 'file'
    && !pathInfo
    && sameUnlinkedLedgerFileAuthority(retained, entry.authority)
    && retained.size === retirementSize
}

function completedLedgerFinalUnlinkError(retained, pathInfo) {
  const evidence = Object.freeze({
    retained: completedLedgerAuthorityDebug(retained),
    path: completedLedgerAuthorityDebug(pathInfo),
  })
  const error = new Error(`World FFmpeg completed cleanup ledger authority gained a hard link or was replaced at final deletion. ${JSON.stringify(evidence)}`)
  error.ledgerAuthority = evidence
  return error
}

async function validateLedgerAuthorityPath(path, entry, allowReclaimed, writable = false, context, retirementOperation, lstatContext) {
  if (context && (!allowReclaimed || !['claim', 'intent', 'tombstone'].includes(entry.role))) throw new Error('Invalid read witness phase.')
  let pathInfo
  if (lstatContext) await emitLstatWitness(lstatContext, lstatContext.witness.spec.beforeLstat, 'before-native')
  try {
    pathInfo = await lstat(path, { bigint: true })
  } catch (error) {
    if (lstatContext) {
      try {
        const nativeError = Object.freeze(Object.fromEntries(['name', 'message', 'code', 'syscall', 'path', 'stack']
          .map((key) => {
            const primitive = typeof error?.[key] === 'string' ? error[key] : null
            if (primitive && Buffer.byteLength(primitive) > (key === 'stack' ? 8192 : 2048)) {
              throw new Error('Original native lstat evidence exceeds its field bound.')
            }
            return [key, primitive]
          })))
        await emitLstatWitness(lstatContext, lstatContext.witness.spec.afterLstat, 'native-error', nativeError)
      }
      catch (witnessError) { throw new AggregateError([error, witnessError], 'Native lstat and lstat witness evidence failed.') }
    }
    throw error
  }
  if (lstatContext) await emitLstatWitness(lstatContext, lstatContext.witness.spec.afterLstat, 'native-success')
  if (!sameLedgerFileAuthority(pathInfo, entry.authority, allowReclaimed)) {
    throw new Error('World FFmpeg completed cleanup ledger authority is foreign or hard-linked.')
  }
  const handle = await open(
    path,
    (writable ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0),
  )
  try {
    const identity = await handle.stat({ bigint: true })
    if (!sameLedgerFileAuthority(identity, entry.authority, allowReclaimed)
      || identity.dev !== pathInfo.dev || identity.ino !== pathInfo.ino) {
      throw new Error('World FFmpeg completed cleanup ledger authority changed before open or gained a hard link.')
    }
    let bytes = null
    if (identity.size !== 0n) {
      bytes = await readExactHandle(handle, Number(identity.size), context, pathInfo, identity, retirementOperation)
      if (sha256Bytes(bytes) !== entry.sha256) {
        throw new Error('World FFmpeg completed cleanup ledger authority digest conflicts with its retirement intent.')
      }
    }
    return { handle, identity, bytes }
  } catch (error) {
    if (await reconcileIncompleteRetirementRead(error, retirementOperation, handle)) {
      try {
        return { handle, identity: await handle.stat({ bigint: true }), bytes: null }
      } catch (identityError) {
        try { await handle.close() } catch (releaseError) {
          throw new AggregateError([error, identityError, releaseError], 'World FFmpeg reconciled claim identity and release failed.')
        }
        throw new AggregateError([error, identityError], 'World FFmpeg reconciled claim identity failed before ownership transfer.')
      }
    }
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function retireLedgerManifest(manifestPath, manifest, input) {
  await input?.beforeLedgerRetirementManifestDelete?.({ manifestPath, identity: fileIdentity(manifest.identity) })
  let retained = await manifest.handle.stat({ bigint: true })
  const current = await optionalLstat(manifestPath)
  if (!current) {
    retained = await manifest.handle.stat({ bigint: true })
    if (retained.nlink === 0n) {
      await syncWorldFfmpegDirectory(dirname(manifestPath), input?.durability)
      return
    }
  }
  if (retained.nlink !== 1n || !samePublicationInode(manifest.identity, retained)
    || !current || !samePublicationInode(retained, current) || current.size !== retained.size) {
    throw new Error('World FFmpeg completed cleanup ledger retirement intent gained a hard link or was replaced at final deletion.')
  }
  try { await unlink(manifestPath) } catch (error) {
    if (error?.code !== 'ENOENT' || await optionalLstat(manifestPath)) throw error
  }
  await input?.afterLedgerRetirementManifestDelete?.({ manifestPath })
  await syncWorldFfmpegDirectory(dirname(manifestPath), input?.durability)
  await input?.afterLedgerRetirementManifestSync?.({ manifestPath })
}

function requireLedgerRetirement(value, expectedToken) {
  if (!exactRecord(value, [
    'schema', 'token', 'claimName', 'createdAtMs',
    'maximumEntries', 'maximumBytes', 'plannedEntries', 'plannedBytes',
    'directoryName', 'directoryAuthority', 'entries',
  ]) || value.schema !== RETIREMENT_SCHEMA || value.token !== expectedToken
    || !garbageProtocol.TOKEN_PATTERN.test(value.token)
    || value.directoryName !== `.WORLD_FFMPEG_GC.retirement-private-${value.token}`
    || !Number.isSafeInteger(value.createdAtMs) || value.createdAtMs < 0
    || !Number.isSafeInteger(value.maximumEntries) || value.maximumEntries < 1
    || value.maximumEntries > DEFAULT_MAXIMUM_ENTRIES
    || !Number.isSafeInteger(value.maximumBytes) || value.maximumBytes < 1
    || value.maximumBytes > MAXIMUM_SUPPORTED_BYTES
    || !Number.isSafeInteger(value.plannedEntries) || value.plannedEntries < 0
    || value.plannedEntries > value.maximumEntries
    || !Number.isSafeInteger(value.plannedBytes) || value.plannedBytes < 0
    || value.plannedBytes > value.maximumBytes
    || !CLAIM_PATTERN.test(value.claimName) || !Array.isArray(value.entries)
    || ![3, 4].includes(value.entries.length)) {
    throw new Error('World FFmpeg completed cleanup ledger retirement intent is invalid.')
  }
  garbageProtocol.requireQuarantineAuthority(value.directoryAuthority)
  const expectedRoles = value.entries.length === 4
    ? ['claim', 'intent', 'tombstone', 'quarantine']
    : ['claim', 'intent', 'tombstone']
  for (let index = 0; index < value.entries.length; index += 1) {
    const entry = value.entries[index]
    const role = expectedRoles[index]
    if (role === 'quarantine') {
      if (!exactRecord(entry, ['role', 'kind', 'sourceName', 'destinationName', 'authority'])
        || entry.role !== role || entry.kind !== 'directory'
        || entry.sourceName !== `.WORLD_FFMPEG_GC.quarantine-${value.token}`
        || entry.destinationName !== 'quarantine') {
        throw new Error('World FFmpeg completed cleanup ledger retirement quarantine entry is invalid.')
      }
      garbageProtocol.requireQuarantineAuthority(entry.authority)
    } else {
      if (!exactRecord(entry, ['role', 'kind', 'sourceName', 'destinationName', 'authority', 'sha256'])
        || entry.role !== role || entry.kind !== 'file'
        || entry.destinationName !== `${role}.v1.json`
        || typeof entry.sourceName !== 'string' || basename(entry.sourceName) !== entry.sourceName
        || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
        throw new Error('World FFmpeg completed cleanup ledger retirement entry is invalid.')
      }
      if ((role === 'claim' && entry.sourceName !== value.claimName)
        || (role === 'intent' && entry.sourceName !== `.WORLD_FFMPEG_GC.intent-${value.token}.v1.json`)
        || (role === 'tombstone' && entry.sourceName !== `.WORLD_FFMPEG_GC.tombstone-${value.token}.v1.json`)) {
        throw new Error('World FFmpeg completed cleanup ledger retirement entry token binding is invalid.')
      }
      requireLedgerFileAuthority(entry.authority)
    }
  }
  return value
}

function ledgerFileAuthority(info) {
  if (!ordinarySingleLinkFile(info) || typeof info.birthtimeNs !== 'bigint' || info.birthtimeNs < 1n) {
    throw new Error('World FFmpeg completed cleanup ledger file authority is unavailable.')
  }
  return Object.freeze({
    dev: String(info.dev), ino: String(info.ino), birthtimeNs: String(info.birthtimeNs),
    mode: Number(info.mode & 0o7777n), size: Number(info.size),
  })
}

function requireLedgerFileAuthority(value) {
  if (!exactRecord(value, ['dev', 'ino', 'birthtimeNs', 'mode', 'size'])
    || !/^[0-9]{1,40}$/.test(value.dev) || !/^[1-9][0-9]{0,39}$/.test(value.ino)
    || !/^[1-9][0-9]{0,39}$/.test(value.birthtimeNs)
    || !Number.isSafeInteger(value.mode) || value.mode < 0 || value.mode > 0o7777
    || !Number.isSafeInteger(value.size) || value.size < 2 || value.size > MAXIMUM_INTENT_BYTES) {
    throw new Error('World FFmpeg completed cleanup ledger file authority is invalid.')
  }
  return value
}

function sameLedgerFileAuthority(info, authority, allowReclaimed) {
  return info?.isFile?.() && !info.isSymbolicLink?.() && info.nlink === 1n
    && String(info.dev) === authority.dev && String(info.ino) === authority.ino
    && String(info.birthtimeNs) === authority.birthtimeNs
    && Number(info.mode & 0o7777n) === authority.mode
    && (Number(info.size) === authority.size || (allowReclaimed && info.size === 0n))
}

function sameUnlinkedLedgerFileAuthority(info, authority) {
  return info?.isFile?.() && !info.isSymbolicLink?.() && info.nlink === 0n
    && (Number(info.size) === authority.size || info.size === 0n)
    && String(info.dev) === authority.dev && String(info.ino) === authority.ino
    && String(info.birthtimeNs) === authority.birthtimeNs
    && Number(info.mode & 0o7777n) === authority.mode
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function directoryReceiptForIntent(intent) {
  return garbageProtocol.buildReceipt(intent, RECEIPT_SCHEMA)
}

function fileReceiptForIntent(intent) {
  return garbageProtocol.buildReceipt(intent, RECEIPT_SCHEMA)
}

async function executeIntent(control, input) {
  const intent = control.value
  requireIntentWithinBounds(intent, input.callerBounds)
  const sourcePath = input.sourcePath
  const quarantinePath = control.quarantinePath
  const renamed = await ensureIntentQuarantined(control, sourcePath, input)
  if (renamed) await input.afterQuarantine?.(intentAuthority(control, sourcePath))
  const directoryQuarantine = intent.kind === 'directory'
    ? await resolveOwnedDirectoryQuarantine(control)
    : Object.freeze({ path: quarantinePath, displaced: false })
  if (intent.kind === 'directory' && typeof input.validate === 'function') {
    await input.validate(directoryQuarantine.path)
  }
  await input.beforeRetirement?.(intentAuthority(control, sourcePath))
  const result = intent.kind === 'directory'
    ? await reclaimDirectoryIntent({ ...control, quarantinePath: directoryQuarantine.path }, {
      durability: input.durability,
      beforeFileReclaim: input.beforeFileReclaim,
      afterFileReclaim: input.afterFileReclaim,
      afterDirectoryReclaim: input.afterDirectoryReclaim,
      afterReceiptDurable: input.afterReceiptDurable,
    })
    : await reclaimFileIntent(control, input.retainedHandle, {
      durability: input.durability,
      afterFileReclaim: input.afterFileReclaim,
      afterReceiptDurable: input.afterReceiptDurable,
    })
  if (directoryQuarantine.displaced) {
    throw new Error(`World FFmpeg owned garbage ${intent.label} quarantine has a foreign replacement; the exact owned generation was reclaimed and preserved.`)
  }
  if (!input.allowActiveReplacement) await requireNoActiveReplacement(sourcePath, intent.label)
  await completeIntent(control, result, input)
  return Object.freeze({
    ...result,
    claimPath: control.claim.claimPath,
    intentPath: control.intentPath,
    completionPath: control.completionPath,
  })
}

async function resolveOwnedDirectoryQuarantine(control) {
  await requireRetainedQuarantineParent(control)
  const current = await optionalLstat(control.quarantinePath)
  if (current && matchesIntentSource(current, control.value, true, true)) {
    return Object.freeze({ path: control.quarantinePath, displaced: false })
  }
  const matches = []
  for (const name of (await readdir(control.quarantineParentPath)).sort(codeUnitCompare)) {
    const candidate = join(control.quarantineParentPath, name)
    if (candidate === control.quarantinePath) continue
    const info = await optionalLstat(candidate)
    if (info && matchesIntentSource(info, control.value, true, true)) matches.push(candidate)
  }
  if (matches.length !== 1) {
    throw new Error('World FFmpeg owned garbage recovery found a foreign quarantine replacement and cannot locate one exact owned directory generation.')
  }
  return Object.freeze({ path: matches[0], displaced: true })
}

async function createIntent(claim, inventory, quarantineParent, options) {
  const intentPath = join(claim.parent, claim.value.intentName)
  const value = garbageProtocol.buildIntent(claim.value, inventory, quarantineParent.authority)
  requireIntent(value)
  const bytes = canonicalBytes(value)
  if (bytes.byteLength > MAXIMUM_INTENT_BYTES) {
    throw new Error('World FFmpeg garbage cleanup intent exceeded its byte bound.')
  }
  try {
    const published = await publishCanonicalAuthority({
      finalPath: intentPath,
      bytes,
      maximumBytes: MAXIMUM_INTENT_BYTES,
      label: 'garbage cleanup intent',
      durability: options.durability,
      async afterTempSync(authority) {
        await options.afterIntentTempSync?.({
          ...authority,
          claimPath: claim.claimPath,
          intentPath,
          quarantineParentPath: quarantineParent.path,
          quarantinePath: join(quarantineParent.path, claim.value.quarantineName),
          completionPath: join(claim.parent, claim.value.completionName),
          token: value.token,
        })
      },
    })
    const opened = await openIntent(intentPath, claim, true)
    await quarantineParent.handle.close()
    return {
      ...opened,
      created: published.created,
    }
  } catch (error) {
    throw error
  }
}

async function openIntent(intentPath, claim, retryPublication = false) {
  let lastError
  const attempts = retryPublication ? 101 : 1
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await openIntentOnce(intentPath, claim) } catch (error) {
      if (error?.code === 'ENOENT') throw error
      lastError = error
      if (attempt + 1 < attempts) await delay(2)
    }
  }
  throw lastError
}

async function openIntentOnce(intentPath, claim) {
  const pathInfo = await lstat(intentPath, { bigint: true })
  if (!ordinarySingleLinkFile(pathInfo) || pathInfo.size < 2n || pathInfo.size > BigInt(MAXIMUM_INTENT_BYTES)) {
    throw new Error('World FFmpeg garbage recovery intent is not an ordinary bounded file.')
  }
  const handle = await open(intentPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
  try {
    const identity = await handle.stat({ bigint: true })
    if (!sameStableFile(pathInfo, identity)) {
      throw new Error('World FFmpeg garbage recovery intent changed before open.')
    }
    const bytes = await readExactHandle(handle, Number(identity.size))
    const value = parseCanonical(bytes, 'garbage recovery intent')
    requireIntent(value)
    garbageProtocol.requireIntentBinding(value, claim.value)
    const quarantineParentPath = join(dirname(intentPath), value.quarantineDirectoryName)
    let quarantineParentHandle
    let quarantineParentIdentity
    const quarantinePathInfo = await optionalLstat(quarantineParentPath)
    if (quarantinePathInfo) {
      quarantineParentHandle = await open(
        quarantineParentPath,
        constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
      )
      quarantineParentIdentity = await quarantineParentHandle.stat({ bigint: true })
      if (!samePrivateDirectory(quarantinePathInfo, quarantineParentIdentity)
        || !sameQuarantineAuthority(quarantineParentIdentity, value.quarantineAuthority)) {
        await quarantineParentHandle.close()
        throw new Error('World FFmpeg garbage private quarantine authority conflicts with its intent.')
      }
    }
    return {
      parent: dirname(intentPath),
      intentPath,
      quarantineParentPath,
      quarantineParentHandle,
      quarantineParentIdentity,
      quarantinePath: join(quarantineParentPath, value.quarantineName),
      completionPath: join(dirname(intentPath), value.completionName),
      handle,
      identity,
      value,
      claim,
      created: false,
    }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function completeIntent(control, receipt, dependencies) {
  const tombstone = garbageProtocol.buildTombstone(
    control.claim.value,
    control.value,
    receipt.schema,
  )
  requireTombstone(tombstone)
  const before = await control.handle.stat({ bigint: true })
  const publicBefore = await lstat(control.intentPath, { bigint: true })
  if (!sameOpenedFile(control.identity, before) || !sameOpenedFile(before, publicBefore)) {
    throw new Error('World FFmpeg garbage cleanup intent was replaced before completion.')
  }
  const existing = await readCompletion(control)
  if (existing) return existing
  const bytes = canonicalBytes(tombstone)
  const authority = () => intentAuthority(control, join(control.parent, control.value.sourceName))
  await publishCanonicalAuthority({
    finalPath: control.completionPath,
    bytes,
    maximumBytes: MAXIMUM_TOMBSTONE_BYTES,
    label: 'garbage cleanup tombstone',
    durability: dependencies.durability,
    splitWrite: true,
    async afterPartialWrite(details) {
      await dependencies.afterCompletionTempWrite?.({ ...authority(), ...details })
    },
    async afterTempSync(details) {
      await dependencies.afterCompletionTempSync?.({ ...authority(), ...details })
    },
    async afterPublish(details) {
      await dependencies.afterCompletionRename?.({ ...authority(), ...details })
      await dependencies.afterCompletionPublish?.({ ...authority(), ...details })
    },
    async afterDirectorySync(details) {
      await dependencies.afterCompletionDirectorySync?.({ ...authority(), ...details })
    },
  })
  const published = await readCompletion(control)
  if (!published) throw new Error('World FFmpeg garbage completion publication is unavailable.')
  return published
}

async function reclaimDirectoryIntent(control, dependencies) {
  const intent = control.value
  return runWithWorldFfmpegCwdCustody(control.quarantinePath, async () => {
    const entered = await lstat('.', { bigint: true })
    requireMatchingDirectory(entered, intent.sourceIdentity, 'owned quarantine identity changed while entered')
    await validateCurrentDirectory(intent, true)
    await dependencies.afterEntered?.()
    const state = {
      children: buildInventoryChildren(intent.entries),
      foreignReplacements: [],
      beforeFileReclaim: dependencies.beforeFileReclaim,
      afterFileReclaim: dependencies.afterFileReclaim,
      afterDirectoryReclaim: dependencies.afterDirectoryReclaim,
    }
    await reclaimCurrentDirectory(state, '', intent.sourceIdentity)
    if (state.foreignReplacements.length > 0) {
      throw new Error('World FFmpeg owned garbage encountered a foreign replacement; it was preserved.')
    }
    const receipt = directoryReceiptForIntent(intent)
    await writeOrVerifyReceipt(receipt)
    const publicAfter = await lstat(control.quarantinePath, { bigint: true })
    if (!sameDirectory(publicAfter, intent.sourceIdentity)) {
      throw new Error('World FFmpeg owned quarantine pathname has a foreign replacement after reclaim.')
    }
    await syncWorldFfmpegDirectory('.', dependencies.durability)
    await dependencies.afterReceiptDurable?.(
      intentAuthority(control, join(control.parent, intent.sourceName)),
    )
    return Object.freeze({ ...receipt, quarantinePath: control.quarantinePath })
  })
}

async function reclaimFileIntent(control, retainedHandle, dependencies) {
  const intent = control.value
  let handle = retainedHandle
  let ownsHandle = false
  if (!handle) {
    handle = await open(control.quarantinePath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
    ownsHandle = true
  }
  let primaryError
  try {
    const before = await handle.stat({ bigint: true })
    const publicBefore = await lstat(control.quarantinePath, { bigint: true })
    if (!sameFileAuthority(before, intent.sourceIdentity, true)) {
      throw new Error(`World FFmpeg owned garbage ${intent.label} changed in cleanup quarantine.`)
    }
    let replaced = !sameFileAuthority(publicBefore, intent.sourceIdentity, true)
      || before.dev !== publicBefore.dev || before.ino !== publicBefore.ino
    if (before.size !== 0n) {
      await handle.truncate(0)
      await handle.sync()
    }
    await dependencies.afterFileReclaim?.(intentAuthority(control, join(control.parent, intent.sourceName)))
    const after = await handle.stat({ bigint: true })
    const publicAfter = await lstat(control.quarantinePath, { bigint: true })
    replaced ||= !sameOpenedFile(after, publicAfter)
    if (!sameFileAuthority(after, intent.sourceIdentity, true) || after.size !== 0n) {
      throw new Error(`World FFmpeg owned garbage ${intent.label} identity changed during reclaim.`)
    }
    if (replaced) {
      throw new Error(`World FFmpeg owned garbage ${intent.label} was replaced during retirement; the foreign replacement was preserved.`)
    }
    const receipt = fileReceiptForIntent(intent)
    await writeOrVerifySiblingReceipt(`${control.quarantinePath}.GC.v1.json`, receipt, dependencies.durability)
    await dependencies.afterReceiptDurable?.(
      intentAuthority(control, join(control.parent, intent.sourceName)),
    )
    return Object.freeze({
      ...receipt,
      quarantinePath: control.quarantinePath,
      receiptPath: `${control.quarantinePath}.GC.v1.json`,
    })
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    if (ownsHandle) {
      try { await handle.close() } catch (error) {
        throw new AggregateError(
          primaryError ? [primaryError, error] : [error],
          'World FFmpeg recovered garbage file descriptor release failed.',
        )
      }
    }
  }
}

async function inventoryDirectory(path, expectedIdentity, bounds) {
  return runWithWorldFfmpegCwdCustody(path, async () => {
    const entered = await lstat('.', { bigint: true })
    requireMatchingDirectory(entered, expectedIdentity, 'owned directory identity changed during preflight')
    const state = { entries: [], plannedBytes: 0, bounds }
    await inventoryCurrentDirectory(state, '')
    const final = await lstat('.', { bigint: true })
    requireMatchingDirectory(final, expectedIdentity, 'owned directory identity changed after preflight')
    return Object.freeze({
      entries: Object.freeze(state.entries.map((entry) => Object.freeze(entry))),
      plannedBytes: state.plannedBytes,
    })
  })
}

async function inventoryCurrentDirectory(state, prefix) {
  const parentIdentity = directoryIdentity(await lstat('.', { bigint: true }))
  const entries = (await readdir('.', { withFileTypes: true }))
    .sort(({ name: left }, { name: right }) => codeUnitCompare(left, right))
  for (const entry of entries) {
    const name = requireDirectName(entry.name)
    if (name === RECEIPT_NAME) throw new Error('World FFmpeg owned garbage contains a reserved receipt entry.')
    const relativePath = prefix ? `${prefix}/${name}` : name
    state.entries.push(null)
    if (state.entries.length > state.bounds.maximumEntries) {
      throw new Error('World FFmpeg owned garbage exceeded its entry bound during preflight.')
    }
    const before = await lstat(name, { bigint: true })
    if (before.isDirectory() && !before.isSymbolicLink()) {
      const descriptor = directoryEntry(relativePath, before)
      state.entries[state.entries.length - 1] = descriptor
      process.chdir(name)
      try {
        const current = await lstat('.', { bigint: true })
        requireMatchingDirectory(current, descriptor, `owned garbage directory identity changed: ${relativePath}`)
        await inventoryCurrentDirectory(state, relativePath)
      } finally {
        process.chdir('..')
      }
      const returned = await lstat('.', { bigint: true })
      requireMatchingDirectory(returned, parentIdentity, 'owned garbage parent identity changed during preflight')
      const publicAfter = await lstat(name, { bigint: true })
      requireMatchingDirectory(publicAfter, descriptor, `owned garbage directory changed after preflight: ${relativePath}`)
      continue
    }
    if (!ordinarySingleLinkFile(before)) {
      throw new Error(`World FFmpeg owned garbage contains a foreign or aliased entry: ${relativePath}.`)
    }
    state.entries[state.entries.length - 1] = fileEntry(relativePath, before)
    state.plannedBytes += Number(before.size)
    if (!Number.isSafeInteger(state.plannedBytes) || state.plannedBytes > state.bounds.maximumBytes) {
      throw new Error('World FFmpeg owned garbage exceeded its byte bound during preflight.')
    }
  }
}

async function validateDirectoryInventory(path, intent, allowReclaimed) {
  return runWithWorldFfmpegCwdCustody(path, () => validateCurrentDirectory(intent, allowReclaimed))
}

async function validateCurrentDirectory(intent, allowReclaimed) {
  const root = await lstat('.', { bigint: true })
  requireMatchingDirectory(root, intent.sourceIdentity, 'owned garbage root identity changed before reclaim')
  await validateInventoryDirectory(buildInventoryChildren(intent.entries), '', intent.sourceIdentity, allowReclaimed)
  const final = await lstat('.', { bigint: true })
  requireMatchingDirectory(final, intent.sourceIdentity, 'owned garbage root identity changed after validation')
}

async function validateInventoryDirectory(children, prefix, expectedParent, allowReclaimed) {
  const parent = await lstat('.', { bigint: true })
  requireMatchingDirectory(parent, expectedParent, 'owned garbage parent identity changed during validation')
  const expected = children.get(prefix) ?? []
  const actualNames = (await readdir('.', { withFileTypes: true }))
    .map(({ name }) => name)
    .filter((name) => !(prefix === '' && name === RECEIPT_NAME))
    .sort(codeUnitCompare)
  const expectedNames = expected.map(({ path }) => basename(path)).sort(codeUnitCompare)
  if (!sameArray(actualNames, expectedNames)) {
    throw new Error('World FFmpeg owned garbage inventory changed before reclaim.')
  }
  for (const descriptor of expected) {
    const name = basename(descriptor.path)
    const info = await lstat(name, { bigint: true })
    if (descriptor.kind === 'directory') {
      requireMatchingDirectory(info, descriptor, `owned garbage directory changed: ${descriptor.path}`)
      process.chdir(name)
      try { await validateInventoryDirectory(children, descriptor.path, descriptor, allowReclaimed) } finally {
        process.chdir('..')
      }
      const returned = await lstat('.', { bigint: true })
      requireMatchingDirectory(returned, expectedParent, 'owned garbage parent changed while validating child')
      const publicAfter = await lstat(name, { bigint: true })
      requireMatchingDirectory(publicAfter, descriptor, `owned garbage directory changed after validation: ${descriptor.path}`)
    } else if (!sameFileEntry(info, descriptor, allowReclaimed)) {
      throw new Error(`World FFmpeg owned garbage file identity changed: ${descriptor.path}.`)
    }
  }
}

async function reclaimCurrentDirectory(state, prefix, expectedParent) {
  const parent = await lstat('.', { bigint: true })
  requireMatchingDirectory(parent, expectedParent, 'owned garbage parent identity changed during reclaim')
  for (const descriptor of state.children.get(prefix) ?? []) {
    const name = basename(descriptor.path)
    const before = await lstat(name, { bigint: true })
    if (descriptor.kind === 'directory') {
      requireMatchingDirectory(before, descriptor, `owned garbage directory identity changed: ${descriptor.path}`)
      process.chdir(name)
      try { await reclaimCurrentDirectory(state, descriptor.path, descriptor) } finally {
        process.chdir('..')
      }
      const returned = await lstat('.', { bigint: true })
      requireMatchingDirectory(returned, expectedParent, 'owned garbage parent identity changed during traversal')
      const absolutePath = resolve(name)
      await state.afterDirectoryReclaim?.({
        absolutePath, relativePath: descriptor.path, identity: directoryIdentity(descriptor),
      })
      try {
        const publicAfter = await lstat(name, { bigint: true })
        if (!sameDirectory(publicAfter, descriptor)) state.foreignReplacements.push(descriptor.path)
      } catch (error) {
        if (error?.code === 'ENOENT') state.foreignReplacements.push(descriptor.path)
        else throw error
      }
      continue
    }
    if (!sameFileEntry(before, descriptor, true)) {
      throw new Error(`World FFmpeg owned garbage file identity changed before open: ${descriptor.path}.`)
    }
    const handle = await open(name, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = await handle.stat({ bigint: true })
      if (!sameFileEntry(opened, descriptor, true)
        || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error(`World FFmpeg owned garbage file identity changed before open: ${descriptor.path}.`)
      }
      const absolutePath = resolve(name)
      await state.beforeFileReclaim?.({
        absolutePath, relativePath: descriptor.path, identity: fileIdentity(opened),
      })
      const current = await handle.stat({ bigint: true })
      if (!sameFileEntry(current, descriptor, true)
        || current.dev !== opened.dev || current.ino !== opened.ino) {
        throw new Error(`World FFmpeg owned garbage file gained a hard link or changed before reclaim: ${descriptor.path}.`)
      }
      if (current.size !== 0n) {
        await handle.truncate(0)
        await handle.sync()
      }
      await state.afterFileReclaim?.({
        absolutePath,
        relativePath: descriptor.path,
        identity: Object.freeze({
          dev: descriptor.dev,
          ino: descriptor.ino,
          size: descriptor.size,
          mode: descriptor.mode,
        }),
      })
      const after = await handle.stat({ bigint: true })
      if (!sameFileEntry(after, descriptor, true) || after.size !== 0n) {
        throw new Error(`World FFmpeg owned garbage file identity changed during reclaim: ${descriptor.path}.`)
      }
      try {
        const publicAfter = await lstat(name, { bigint: true })
        if (!sameOpenedFile(after, publicAfter)) state.foreignReplacements.push(descriptor.path)
      } catch (error) {
        if (error?.code === 'ENOENT') state.foreignReplacements.push(descriptor.path)
        else throw error
      }
    } finally {
      await handle.close()
    }
  }
}

function buildInventoryChildren(entries) {
  const children = new Map()
  for (const descriptor of entries) {
    const offset = descriptor.path.lastIndexOf('/')
    const parent = offset < 0 ? '' : descriptor.path.slice(0, offset)
    const values = children.get(parent) ?? []
    values.push(descriptor)
    children.set(parent, values)
  }
  for (const values of children.values()) {
    values.sort(({ path: left }, { path: right }) => codeUnitCompare(basename(left), basename(right)))
  }
  return children
}

async function writeOrVerifyReceipt(value) {
  const bytes = canonicalBytes(value)
  await recoverBoundPublicationTemporaries({
    finalPath: resolve(RECEIPT_NAME),
    maximumBytes: 16 * 1024,
    label: 'owned garbage receipt',
    validate(value) { requireDirectoryReceipt(value) },
  })
  await publishCanonicalAuthority({
    finalPath: resolve(RECEIPT_NAME),
    bytes,
    maximumBytes: 16 * 1024,
    label: 'owned garbage receipt',
    validate(value) { requireDirectoryReceipt(value) },
  })
}

async function writeOrVerifySiblingReceipt(path, value, durability) {
  const bytes = canonicalBytes(value)
  await recoverBoundPublicationTemporaries({
    finalPath: path,
    maximumBytes: 16 * 1024,
    label: 'owned garbage file receipt',
    durability,
    validate(candidate) { requireFileReceipt(candidate) },
  })
  await publishCanonicalAuthority({
    finalPath: path,
    bytes,
    maximumBytes: 16 * 1024,
    label: 'owned garbage file receipt',
    durability,
    validate(candidate) { requireFileReceipt(candidate) },
  })
}

async function isCompletedLegacyQuarantine(path) {
  const info = await optionalLstat(path)
  if (!info || info.isSymbolicLink()) return false
  if (info.isDirectory()) {
    try {
      const bytes = await readOrdinaryBoundedFile(join(path, RECEIPT_NAME), 16 * 1024)
      const receipt = parseCanonical(bytes, 'legacy garbage receipt')
      return receipt?.schema === RECEIPT_SCHEMA
        && sameDirectory(info, receipt.rootIdentity)
    } catch { return false }
  }
  if (!ordinarySingleLinkFile(info) || info.size !== 0n) return false
  try {
    const bytes = await readOrdinaryBoundedFile(`${path}.GC.v1.json`, 16 * 1024)
    const receipt = parseCanonical(bytes, 'legacy garbage file receipt')
    return receipt?.schema === RECEIPT_SCHEMA
      && String(info.dev) === receipt?.identity?.dev
      && String(info.ino) === receipt?.identity?.ino
  } catch { return false }
}

async function requireNoActiveReplacement(path, label) {
  try {
    await lstat(path)
    throw new Error(`World FFmpeg owned garbage ${label} was replaced during retirement; the foreign replacement was preserved.`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function intentAuthority(control, sourcePath) {
  return Object.freeze({
    path: sourcePath,
    sourcePath,
    claimPath: control.claim.claimPath,
    quarantinePath: control.quarantinePath,
    intentPath: control.intentPath,
    completionPath: control.completionPath,
    token: control.value.token,
    label: control.value.label,
    expectedIdentity: control.value.sourceIdentity,
    identity: control.value.sourceIdentity,
  })
}

function requireIntent(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)
    && garbageProtocol.TOKEN_PATTERN.test(value.token ?? '')
    && typeof value.sourceName === 'string'
    && (value.intentName !== `.WORLD_FFMPEG_GC.intent-${value.token}.v1.json`
      || value.quarantineDirectoryName !== `.WORLD_FFMPEG_GC.quarantine-${value.token}`
      || value.quarantineName !== 'owned'
      || value.completionName !== `.WORLD_FFMPEG_GC.tombstone-${value.token}.v1.json`)) {
    throw new Error('World FFmpeg garbage cleanup intent token binding is invalid.')
  }
  if (!exactRecord(value, [
    'schema', 'token', 'claimName', 'kind', 'label', 'sourceName', 'intentName',
    'quarantineDirectoryName', 'quarantineName', 'quarantineAuthority', 'completionName',
    'sourceIdentity', 'sourceAuthority',
    'createdAtMs', 'maximumEntries', 'maximumBytes', 'plannedEntries', 'plannedBytes', 'entries',
  ]) || value.schema !== INTENT_SCHEMA || !['directory', 'file'].includes(value.kind)
    || !garbageProtocol.TOKEN_PATTERN.test(value.token)
    || !CLAIM_PATTERN.test(value.claimName)
    || requireLabel(value.label) !== value.label
    || requireDirectName(value.sourceName) !== value.sourceName
    || requireDirectName(value.intentName) !== value.intentName
    || requireDirectName(value.quarantineDirectoryName) !== value.quarantineDirectoryName
    || requireDirectName(value.quarantineName) !== value.quarantineName
    || requireDirectName(value.completionName) !== value.completionName
    || value.intentName !== `.WORLD_FFMPEG_GC.intent-${value.token}.v1.json`
    || value.quarantineDirectoryName !== `.WORLD_FFMPEG_GC.quarantine-${value.token}`
    || value.quarantineName !== 'owned'
    || value.completionName !== `.WORLD_FFMPEG_GC.tombstone-${value.token}.v1.json`
    || !Number.isSafeInteger(value.createdAtMs) || value.createdAtMs < 0
    || !Number.isSafeInteger(value.maximumEntries) || value.maximumEntries < 1
    || value.maximumEntries > DEFAULT_MAXIMUM_ENTRIES
    || !Number.isSafeInteger(value.maximumBytes) || value.maximumBytes < 1
    || value.maximumBytes > MAXIMUM_SUPPORTED_BYTES
    || !Number.isSafeInteger(value.plannedEntries) || value.plannedEntries < 0
    || value.plannedEntries > value.maximumEntries
    || !Number.isSafeInteger(value.plannedBytes) || value.plannedBytes < 0
    || value.plannedBytes > value.maximumBytes || !Array.isArray(value.entries)
    || value.entries.length !== value.plannedEntries) {
    throw new Error('World FFmpeg garbage cleanup intent is invalid.')
  }
  if (value.kind === 'directory') requireDirectoryIdentity(value.sourceIdentity)
  else requireFileIdentity(value.sourceIdentity)
  requireSourceAuthorityRecord(value.sourceAuthority, value.sourceIdentity)
  garbageProtocol.requireQuarantineAuthority(value.quarantineAuthority)
  let previous = ''
  let total = 0
  const paths = new Set()
  for (const entry of value.entries) {
    requireInventoryEntry(entry)
    if (entry.path <= previous || paths.has(entry.path)) {
      throw new Error('World FFmpeg garbage cleanup intent entries are not canonical.')
    }
    const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''
    if (parent && !paths.has(parent)) {
      throw new Error('World FFmpeg garbage cleanup intent parent authority is missing.')
    }
    paths.add(entry.path)
    previous = entry.path
    if (entry.kind === 'file') total += entry.size
  }
  if (value.kind === 'file' && value.entries.length !== 0) {
    throw new Error('World FFmpeg garbage file intent cannot contain directory entries.')
  }
  if (!Number.isSafeInteger(total)
    || (value.kind === 'directory' ? total : value.sourceIdentity.size) !== value.plannedBytes) {
    throw new Error('World FFmpeg garbage cleanup intent byte plan is invalid.')
  }
  return value
}

function requireTombstone(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)
    && garbageProtocol.TOKEN_PATTERN.test(value.token ?? '')
    && typeof value.sourceName === 'string'
    && (value.intentName !== `.WORLD_FFMPEG_GC.intent-${value.token}.v1.json`
      || value.quarantineDirectoryName !== `.WORLD_FFMPEG_GC.quarantine-${value.token}`
      || value.quarantineName !== 'owned'
      || value.completionName !== `.WORLD_FFMPEG_GC.tombstone-${value.token}.v1.json`)) {
    throw new Error('World FFmpeg garbage cleanup tombstone token binding is invalid.')
  }
  if (!exactRecord(value, [
    'schema', 'token', 'claimName', 'kind', 'label', 'sourceName', 'intentName',
    'quarantineDirectoryName', 'quarantineName', 'quarantineAuthority', 'completionName',
    'sourceIdentity', 'sourceAuthority',
    'createdAtMs', 'completedAtMs', 'maximumEntries', 'maximumBytes',
    'plannedEntries', 'plannedBytes', 'receiptSchema', 'receiptSha256',
  ]) || value.schema !== TOMBSTONE_SCHEMA || value.receiptSchema !== RECEIPT_SCHEMA
    || !['directory', 'file'].includes(value.kind)
    || !garbageProtocol.TOKEN_PATTERN.test(value.token)
    || !CLAIM_PATTERN.test(value.claimName)
    || requireLabel(value.label) !== value.label
    || requireDirectName(value.sourceName) !== value.sourceName
    || requireDirectName(value.intentName) !== value.intentName
    || requireDirectName(value.quarantineDirectoryName) !== value.quarantineDirectoryName
    || requireDirectName(value.quarantineName) !== value.quarantineName
    || requireDirectName(value.completionName) !== value.completionName
    || value.intentName !== `.WORLD_FFMPEG_GC.intent-${value.token}.v1.json`
    || value.quarantineDirectoryName !== `.WORLD_FFMPEG_GC.quarantine-${value.token}`
    || value.quarantineName !== 'owned'
    || value.completionName !== `.WORLD_FFMPEG_GC.tombstone-${value.token}.v1.json`
    || !Number.isSafeInteger(value.createdAtMs) || value.createdAtMs < 0
    || value.completedAtMs !== value.createdAtMs
    || !Number.isSafeInteger(value.maximumEntries) || value.maximumEntries < 1
    || value.maximumEntries > DEFAULT_MAXIMUM_ENTRIES
    || !Number.isSafeInteger(value.maximumBytes) || value.maximumBytes < 1
    || value.maximumBytes > MAXIMUM_SUPPORTED_BYTES
    || !Number.isSafeInteger(value.plannedEntries) || value.plannedEntries < 0
    || value.plannedEntries > value.maximumEntries
    || !Number.isSafeInteger(value.plannedBytes) || value.plannedBytes < 0
    || value.plannedBytes > value.maximumBytes
    || typeof value.receiptSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.receiptSha256)) {
    throw new Error('World FFmpeg garbage cleanup tombstone is invalid.')
  }
  if (value.kind === 'directory') requireDirectoryIdentity(value.sourceIdentity)
  else requireFileIdentity(value.sourceIdentity)
  requireSourceAuthorityRecord(value.sourceAuthority, value.sourceIdentity)
  garbageProtocol.requireQuarantineAuthority(value.quarantineAuthority)
  return value
}

function requireDirectoryReceipt(value) {
  if (!exactRecord(value, [
    'schema', 'label', 'rootIdentity', 'quarantinedAtMs', 'reclaimedAtMs',
    'entries', 'files', 'reclaimedBytes', 'foreignReplacements',
  ]) || value.schema !== RECEIPT_SCHEMA || requireLabel(value.label) !== value.label
    || !Number.isSafeInteger(value.quarantinedAtMs) || value.quarantinedAtMs < 0
    || value.reclaimedAtMs !== value.quarantinedAtMs
    || !Number.isSafeInteger(value.entries) || value.entries < 0
    || !Number.isSafeInteger(value.files) || value.files < 0 || value.files > value.entries
    || !Number.isSafeInteger(value.reclaimedBytes) || value.reclaimedBytes < 0
    || value.reclaimedBytes > MAXIMUM_SUPPORTED_BYTES
    || !Array.isArray(value.foreignReplacements) || value.foreignReplacements.length !== 0) {
    throw new Error('World FFmpeg owned garbage directory receipt is invalid.')
  }
  requireDirectoryIdentity(value.rootIdentity)
  return value
}

function requireFileReceipt(value) {
  if (!exactRecord(value, ['schema', 'label', 'identity', 'reclaimedBytes', 'reclaimedAtMs'])
    || value.schema !== RECEIPT_SCHEMA || requireLabel(value.label) !== value.label
    || !Number.isSafeInteger(value.reclaimedBytes) || value.reclaimedBytes < 0
    || value.reclaimedBytes > MAXIMUM_SUPPORTED_BYTES
    || !Number.isSafeInteger(value.reclaimedAtMs) || value.reclaimedAtMs < 0) {
    throw new Error('World FFmpeg owned garbage file receipt is invalid.')
  }
  requireFileIdentity(value.identity)
  return value
}

function requireSourceAuthorityRecord(value, sourceIdentity) {
  if (!exactRecord(value, ['dev', 'ino', 'birthtimeNs', 'ctimeNs', 'mode', 'size'])
    || value.dev !== sourceIdentity.dev || value.ino !== sourceIdentity.ino
    || !validIdentity(value.birthtimeNs, false) || !validIdentity(value.ctimeNs, false)
    || !validMode(value.mode) || !Number.isSafeInteger(value.size) || value.size < 0
    || value.size > MAXIMUM_SUPPORTED_BYTES
    || (sourceIdentity.mode !== undefined && value.mode !== sourceIdentity.mode)
    || (sourceIdentity.size !== undefined && value.size !== sourceIdentity.size)) {
    throw new Error('World FFmpeg garbage source birth authority is invalid.')
  }
  return value
}

function requireInventoryEntry(value) {
  if (value?.kind === 'directory') {
    if (!exactRecord(value, ['path', 'kind', 'dev', 'ino', 'mode'])
      || !validRelativePath(value.path) || !validIdentity(value.dev, true)
      || !validIdentity(value.ino, false) || !validMode(value.mode)) {
      throw new Error('World FFmpeg garbage directory inventory entry is invalid.')
    }
    return value
  }
  if (!exactRecord(value, ['path', 'kind', 'dev', 'ino', 'mode', 'size'])
    || value.kind !== 'file' || !validRelativePath(value.path)
    || !validIdentity(value.dev, true) || !validIdentity(value.ino, false)
    || !validMode(value.mode) || !Number.isSafeInteger(value.size) || value.size < 0
    || value.size > MAXIMUM_SUPPORTED_BYTES) {
    throw new Error('World FFmpeg garbage file inventory entry is invalid.')
  }
  return value
}

function requireFileIdentity(value) {
  if (!exactRecord(value, ['dev', 'ino', 'size', 'mode'])
    || !validIdentity(value.dev, true) || !validIdentity(value.ino, false)
    || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAXIMUM_SUPPORTED_BYTES
    || !validMode(value.mode)) {
    throw new Error('World FFmpeg owned garbage file identity is invalid.')
  }
  return value
}

function directoryEntry(path, info) {
  return { path, kind: 'directory', ...directoryIdentity(info), mode: Number(info.mode & 0o7777n) }
}

function fileEntry(path, info) {
  return { path, kind: 'file', ...fileIdentity(info) }
}

function sameFileEntry(info, descriptor, allowReclaimed) {
  return ordinarySingleLinkFile(info)
    && String(info.dev) === descriptor.dev && String(info.ino) === descriptor.ino
    && Number(info.mode & 0o7777n) === descriptor.mode
    && (Number(info.size) === descriptor.size || (allowReclaimed && info.size === 0n))
}

function sameFileAuthority(info, expected, allowReclaimed) {
  return ordinarySingleLinkFile(info)
    && String(info.dev) === expected.dev && String(info.ino) === expected.ino
    && Number(info.mode & 0o7777n) === expected.mode
    && (Number(info.size) === expected.size || (allowReclaimed && info.size === 0n))
}

function requireMatchingDirectory(info, expected, message) {
  if (!sameDirectory(info, expected)) throw new Error(`World FFmpeg ${message}.`)
}

function sameDirectory(info, expected) {
  return info?.isDirectory?.() && !info.isSymbolicLink?.()
    && String(info.dev) === expected.dev && String(info.ino) === expected.ino
    && (expected.mode === undefined || Number(info.mode & 0o7777n) === expected.mode)
}

function samePrivateDirectory(left, right) {
  return left?.isDirectory?.() && !left.isSymbolicLink?.()
    && right?.isDirectory?.() && !right.isSymbolicLink?.()
    && left.dev === right.dev && left.ino === right.ino
    && (left.mode & 0o7777n) === (right.mode & 0o7777n)
}

function sameQuarantineAuthority(info, expected) {
  return info?.isDirectory?.() && !info.isSymbolicLink?.()
    && String(info.dev) === expected?.dev && String(info.ino) === expected?.ino
    && String(info.birthtimeNs) === expected?.birthtimeNs
    && Number(info.mode & 0o7777n) === expected?.mode
}

function quarantinePathForClaim(claim) {
  return join(claim.parent, claim.value.quarantineDirectoryName, claim.value.quarantineName)
}

function ordinarySingleLinkFile(info) {
  return info?.isFile?.() && !info.isSymbolicLink?.() && info.nlink === 1n
}

function sameStableFile(left, right) {
  return sameOpenedFile(left, right) && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function sameOpenedFile(left, right) {
  return ordinarySingleLinkFile(left) && ordinarySingleLinkFile(right)
    && left.dev === right.dev && left.ino === right.ino
    && (left.mode & 0o7777n) === (right.mode & 0o7777n)
}

function directoryIdentity(info) {
  return Object.freeze({ dev: String(info.dev), ino: String(info.ino) })
}

function fileIdentity(info) {
  return Object.freeze({
    dev: String(info.dev), ino: String(info.ino), size: Number(info.size), mode: Number(info.mode & 0o7777n),
  })
}

function requireDirectoryIdentity(value) {
  if (!exactRecord(value, ['dev', 'ino'])
    || !validIdentity(value.dev, true) || !validIdentity(value.ino, false)) {
    throw new Error('World FFmpeg owned garbage directory identity is invalid.')
  }
  return Object.freeze({ dev: value.dev, ino: value.ino })
}

function requireBounds(value) {
  return Object.freeze({
    maximumEntries: requireBoundedInteger(
      value?.maximumEntries ?? DEFAULT_MAXIMUM_ENTRIES,
      1,
      DEFAULT_MAXIMUM_ENTRIES,
      'garbage entry bound',
    ),
    maximumBytes: requireBoundedInteger(
      value?.maximumBytes ?? WORLD_FFMPEG_PACKAGE_OUTPUT_GARBAGE_MAXIMUM_BYTES,
      1,
      MAXIMUM_SUPPORTED_BYTES,
      'garbage byte bound',
    ),
  })
}

function parseQuarantineName(value) {
  const match = /^\.(.+)\.remove-([a-f0-9]{32})$/.exec(value)
  if (!match) return null
  try { return { sourceName: requireDirectName(match[1]), token: match[2] } } catch { return null }
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') || /[\r\n]/.test(value)) {
    throw new Error(`World FFmpeg ${label} path is invalid.`)
  }
  return resolve(value)
}

function requireDirectName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255
    || value === '.' || value === '..' || /[\\/\0\r\n]/.test(value)) {
    throw new Error('World FFmpeg owned garbage entry name is invalid.')
  }
  return value
}

function validRelativePath(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 32 * 1024
    && value.split('/').every((segment) => {
      try { return requireDirectName(segment) === segment } catch { return false }
    })
}

function requireLabel(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,100}$/.test(value)) {
    throw new Error('World FFmpeg owned garbage label is invalid.')
  }
  return value
}

function validIdentity(value, allowZero) {
  return typeof value === 'string'
    && (allowZero ? /^[0-9]{1,40}$/ : /^[1-9][0-9]{0,39}$/).test(value)
}

function validMode(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0o7777
}

function requireTimestamp(value) {
  return requireBoundedInteger(value, 0, Number.MAX_SAFE_INTEGER, 'garbage timestamp')
}

function requireRecoveryAge(value) {
  return requireBoundedInteger(value ?? 60_000, 0, 24 * 60 * 60_000, 'garbage recovery grace')
}

function requireBoundedInteger(value, minimum, maximum, label) {
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
  return sameArray(actual, expected)
}

function sameArray(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`)
}

function parseCanonical(bytes, label) {
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch {
    throw new Error(`World FFmpeg ${label} is invalid JSON.`)
  }
  if (!bytes.equals(canonicalBytes(value))) throw new Error(`World FFmpeg ${label} is not canonical.`)
  return value
}

async function publishCanonicalAuthority(input) {
  if (!Buffer.isBuffer(input.bytes) || input.bytes.byteLength < 2
    || input.bytes.byteLength > input.maximumBytes) {
    throw new Error(`World FFmpeg ${input.label} publication bytes are invalid.`)
  }
  const parent = dirname(input.finalPath)
  const temporaryPath = `${input.finalPath}.tmp-${randomBytes(16).toString('hex')}`
  const temporary = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    0o600,
  )
  let linked = false
  let adoptedOwnInode = false
  let completed = false
  try {
    if (input.splitWrite) {
      const firstLength = Math.max(1, Math.floor(input.bytes.byteLength / 2))
      await writeAllRange(temporary, input.bytes, 0, firstLength)
      await input.afterPartialWrite?.({ temporaryPath, finalPath: input.finalPath })
      await writeAllRange(temporary, input.bytes, firstLength, input.bytes.byteLength)
    } else {
      await writeAll(temporary, input.bytes)
    }
    await temporary.sync()
    const temporaryIdentity = await temporary.stat({ bigint: true })
    if (!ordinaryPublicationFile(temporaryIdentity)
      || temporaryIdentity.size !== BigInt(input.bytes.byteLength)) {
      throw new Error(`World FFmpeg ${input.label} temporary authority is invalid.`)
    }
    if (temporaryIdentity.nlink === 2n) {
      const racedFinal = await optionalLstat(input.finalPath)
      if (!racedFinal || !samePublicationInode(temporaryIdentity, racedFinal)) {
        throw new Error(`World FFmpeg ${input.label} temporary authority gained a foreign hard link.`)
      }
    }
    await input.afterTempSync?.({
      temporaryPath,
      finalPath: input.finalPath,
      identity: fileIdentity(temporaryIdentity),
    })
    const readyIdentity = await temporary.stat({ bigint: true })
    const readyFinal = await optionalLstat(input.finalPath)
    const readyBytes = ordinaryPublicationFile(readyIdentity)
      && readyIdentity.size === BigInt(input.bytes.byteLength)
      ? await readExactHandle(temporary, input.bytes.byteLength)
      : null
    if (!samePublicationInode(temporaryIdentity, readyIdentity)
      || readyIdentity.size !== BigInt(input.bytes.byteLength)
      || !readyBytes?.equals(input.bytes)
      || (readyIdentity.nlink !== 1n
        && (!readyFinal || !samePublicationInode(readyIdentity, readyFinal)))) {
      throw new Error(`World FFmpeg ${input.label} temporary authority gained a foreign hard link alias or changed before publication.`)
    }
    try {
      await link(temporaryPath, input.finalPath)
      linked = true
    } catch (error) {
      if (!['EEXIST', 'ENOENT'].includes(error?.code)) throw error
      let existing
      try {
        existing = await readStablePublicationFile(input.finalPath, input.maximumBytes, input.label)
      } catch (readError) {
        throw new Error(`World FFmpeg ${input.label} conflicts with a foreign final authority.`, {
          cause: readError,
        })
      }
      try {
        input.validate?.(existing.value)
        adoptedOwnInode = samePublicationInode(temporaryIdentity, existing.identity)
        const equivalent = existing.bytes.equals(input.bytes)
          || (typeof input.equivalent === 'function'
            && input.equivalent(parseCanonical(input.bytes, input.label), existing.value))
        if (!equivalent && input.acceptExisting) {
          throw new Error(`World FFmpeg ${input.label} conflicts with a foreign final authority.`)
        }
        if (!existing.bytes.equals(input.bytes) && !input.acceptExisting) {
          throw new Error(`World FFmpeg ${input.label} conflicts with a foreign final authority.`)
        }
      } finally {
        await existing.handle.close()
      }
    }
    if (linked) {
      const published = await lstat(input.finalPath, { bigint: true })
      if (!samePublicationInode(temporaryIdentity, published)
        || published.size !== BigInt(input.bytes.byteLength)) {
        throw new Error(`World FFmpeg ${input.label} changed during no-replace publication.`)
      }
      await input.afterPublish?.({ temporaryPath, finalPath: input.finalPath })
      await syncWorldFfmpegDirectory(parent, input.durability)
      await input.afterDirectorySync?.({ temporaryPath, finalPath: input.finalPath })
    }
    const temporaryBeforeUnlink = await optionalLstat(temporaryPath)
    if (temporaryBeforeUnlink) {
      const finalBeforeTemporaryRetirement = await optionalLstat(input.finalPath)
      if (!samePublicationInode(temporaryIdentity, temporaryBeforeUnlink)
        || temporaryBeforeUnlink.size !== BigInt(input.bytes.byteLength)
        || (temporaryBeforeUnlink.nlink !== 1n
          && (!finalBeforeTemporaryRetirement
            || temporaryBeforeUnlink.nlink !== 2n
            || !samePublicationInode(temporaryBeforeUnlink, finalBeforeTemporaryRetirement)))) {
        throw new Error(`World FFmpeg ${input.label} temporary authority changed before retirement.`)
      }
      try { await unlink(temporaryPath) } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        const final = await lstat(input.finalPath, { bigint: true })
        if (!samePublicationInode(temporaryIdentity, final)) throw error
      }
      await syncWorldFfmpegDirectory(parent, input.durability)
    }
    completed = true
    return Object.freeze({ created: linked || adoptedOwnInode, finalPath: input.finalPath })
  } finally {
    await temporary.close()
    if (!completed) {
      // A complete temporary is durable recovery evidence. Never delete it on
      // an ambiguous or conflicting publication path.
    }
  }
}

async function recoverClaimPublicationTemporaries(parent, durability, failures, names) {
  const recoveryTemporaries = indexPublicationTemporaries(names)
  const finals = new Set()
  for (const name of names) {
    const match = PUBLICATION_TEMP_CANDIDATE_PATTERN.exec(name)
    if (match && CLAIM_PATTERN.test(match[1])) finals.add(match[1])
  }
  for (const finalName of finals) {
    try {
      const publication = await recoverBoundPublicationTemporaries({
        finalPath: join(parent, finalName),
        recoveryTemporaries,
        maximumBytes: MAXIMUM_CLAIM_BYTES,
        label: 'garbage transaction claim',
        durability,
        validate(value) { garbageProtocol.requireClaim(value, finalName) },
        equivalent: garbageProtocol.sameClaimTransaction,
        tolerateInvalid: true,
      })
      if (publication.failures.length > 0) {
        failures.push(failureRecord(finalName, publicationRecoveryError(
          'garbage transaction claim', publication.failures,
        )))
      }
    } catch (error) {
      failures.push(failureRecord(finalName, error))
    }
  }
}

async function recoverBoundPublicationTemporaries(input) {
  const parent = dirname(input.finalPath)
  const prefix = `${basename(input.finalPath)}.tmp-`
  const names = input.recoveryTemporaries
    ? input.recoveryTemporaries.get(basename(input.finalPath)) ?? []
    : (await scanGarbageParent(parent)).filter((name) => name.startsWith(prefix))
  if (names.length > MAXIMUM_PUBLICATION_TEMPORARIES) {
    throw new Error(`World FFmpeg ${input.label} publication temporary count exceeds its recovery bound.`)
  }
  let created = false
  const failures = []
  for (const name of names) {
    if (!PUBLICATION_TEMP_PATTERN.test(name)) {
      failures.push(new Error(`World FFmpeg ${input.label} has a malformed publication temporary.`))
      continue
    }
    const temporaryPath = join(parent, name)
    let temporary
    try {
      temporary = await readStablePublicationFileWithRetry(
        temporaryPath, input.maximumBytes, input.label,
      )
      if (!temporary) continue
      input.validate?.(temporary.value)
    } catch (error) {
      if (temporary) await temporary.handle.close().catch(() => undefined)
      failures.push(error)
      continue
    }
    try {
      const finalInfo = await optionalLstat(input.finalPath)
      if (temporary.identity.nlink !== 1n
        && (!finalInfo || !samePublicationInode(temporary.identity, finalInfo))) {
        throw new Error(`World FFmpeg ${input.label} publication temporary has a foreign hard link alias.`)
      }
      if (!finalInfo) {
        try {
          await link(temporaryPath, input.finalPath)
          created = true
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error
        }
        await syncWorldFfmpegDirectory(parent, input.durability)
      }
      const final = await readStablePublicationFile(input.finalPath, input.maximumBytes, input.label)
      try {
        input.validate?.(final.value)
        if (!final.bytes.equals(temporary.bytes)
          && !(typeof input.equivalent === 'function'
            && input.equivalent(temporary.value, final.value))) {
          throw new Error(`World FFmpeg ${input.label} publication temporary conflicts with a foreign final authority.`)
        }
      } finally {
        await final.handle.close()
      }
      const beforeUnlink = await optionalLstat(temporaryPath)
      if (beforeUnlink) {
        const finalBeforeTemporaryRetirement = await optionalLstat(input.finalPath)
        if (!samePublicationInode(temporary.identity, beforeUnlink)
          || beforeUnlink.size !== temporary.identity.size
          || (beforeUnlink.nlink !== 1n
            && (!finalBeforeTemporaryRetirement
              || beforeUnlink.nlink !== 2n
              || !samePublicationInode(beforeUnlink, finalBeforeTemporaryRetirement)))) {
          throw new Error(`World FFmpeg ${input.label} publication temporary changed before recovery retirement.`)
        }
        try { await unlink(temporaryPath) } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
        await syncWorldFfmpegDirectory(parent, input.durability)
      }
    } catch (error) {
      failures.push(error)
    } finally {
      await temporary.handle.close()
    }
  }
  if (failures.length > 0 && input.tolerateInvalid !== true) {
    throw publicationRecoveryError(input.label, failures)
  }
  return Object.freeze({ created, failures: Object.freeze(failures) })
}

function publicationRecoveryError(label, failures) {
  return new AggregateError(
    failures,
    `World FFmpeg ${label} publication temporary recovery failed: ${failures.map((error) => error?.message ?? 'unknown failure').join('; ')}`,
  )
}

async function readStablePublicationFileWithRetry(path, maximumBytes, label) {
  let lastError
  for (let attempt = 0; attempt < 101; attempt += 1) {
    try { return await readStablePublicationFile(path, maximumBytes, label) } catch (error) {
      if (error?.code === 'ENOENT') return null
      lastError = error
      if (attempt < 100) await delay(2)
    }
  }
  throw lastError
}

async function readStablePublicationFile(path, maximumBytes, label, context, retirementOperation) {
  const pathInfo = await lstat(path, { bigint: true })
  if (!ordinaryPublicationFile(pathInfo) || pathInfo.size < 2n
    || pathInfo.size > BigInt(maximumBytes)) {
    throw new Error(`World FFmpeg ${label} is not an ordinary bounded publication file.`)
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const identity = await handle.stat({ bigint: true })
    if (!samePublicationInode(pathInfo, identity) || pathInfo.size !== identity.size) {
      throw new Error(`World FFmpeg ${label} changed before publication open.`)
    }
    const bytes = await readExactHandle(handle, Number(identity.size), context, pathInfo, identity, retirementOperation)
    const after = await handle.stat({ bigint: true })
    if (!samePublicationInode(identity, after) || after.size !== identity.size) {
      throw new Error(`World FFmpeg ${label} changed during publication read.`)
    }
    return { handle, identity, bytes, value: parseCanonical(bytes, label) }
  } catch (error) {
    const reconciled = await reconcileIncompleteRetirementRead(error, retirementOperation, handle)
    if (reconciled) {
      try { await handle.close() } catch (releaseError) {
        throw new AggregateError([error, releaseError], 'World FFmpeg reconciled publication release failed.')
      }
      return RETIRED_LEDGER_GENERATION
    }
    await handle.close().catch(() => undefined)
    throw error
  }
}

function ordinaryPublicationFile(info) {
  return info?.isFile?.() && !info.isSymbolicLink?.() && (info.nlink === 1n || info.nlink === 2n)
}

function samePublicationInode(left, right) {
  return ordinaryPublicationFile(left) && ordinaryPublicationFile(right)
    && left.dev === right.dev && left.ino === right.ino
    && (left.mode & 0o7777n) === (right.mode & 0o7777n)
}

async function writeAll(handle, bytes) {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, offset)
    if (bytesWritten < 1) throw new Error('World FFmpeg garbage authority write made no progress.')
    offset += bytesWritten
  }
}

async function writeAllRange(handle, bytes, start, end) {
  let offset = start
  while (offset < end) {
    const { bytesWritten } = await handle.write(bytes, offset, end - offset, offset)
    if (bytesWritten < 1) throw new Error('World FFmpeg garbage authority write made no progress.')
    offset += bytesWritten
  }
}

async function readExactHandle(handle, size, context, pathInfo, identity, operation = {}) {
  const bytes = Buffer.allocUnsafe(size)
  let originalRead
  if (context) {
    if (context.witness.used || size < 1) throw new Error('Read witness operation is repeated or empty.')
    context.witness.used = true
    originalRead = handle.read
    if (typeof originalRead !== 'function') throw new Error('Read witness native method is invalid.')
  }
  let offset = 0
  while (offset < size) {
    if (context) {
      await emitReadWitness(context, context.witness.spec.beforeRead, { stage: 'before', fd: handle.fd,
        offset, position: offset, requested: size - offset, held: readWitnessStat(identity), pathStat: readWitnessStat(pathInfo) })
      if (handle.read !== originalRead) throw new Error('Read witness native method changed across its gate.')
    }
    const { bytesRead } = context
      ? await applyReadWitnessCallable(originalRead, handle, [bytes, offset, size - offset, offset])
      : await handle.read(bytes, offset, size - offset, offset)
    if (context) {
      await emitReadWitness(context, context.witness.spec.afterRead, { stage: 'after', fd: handle.fd,
        offset, position: offset, requested: size - offset, bytesRead,
        held: readWitnessStat(await handle.stat({ bigint: true })), pathStat: readWitnessStat(await optionalLstat(context.path)) })
      if (handle.read !== originalRead) throw new Error('Read witness native method changed after its read.')
    }
    if (bytesRead < 1) {
      const error = Object.assign(new Error('World FFmpeg garbage authority read ended early.'), {
        code: 'WORLD_FFMPEG_AUTHORITY_READ_INCOMPLETE',
      })
      incompleteAuthorityReads.set(error, { operation, handle, size, offset, identity })
      throw error
    }
    offset += bytesRead
  }
  return bytes
}

async function readOrdinaryBoundedFile(path, maximumBytes) {
  const pathInfo = await lstat(path, { bigint: true })
  if (!ordinarySingleLinkFile(pathInfo) || pathInfo.size < 1n || pathInfo.size > BigInt(maximumBytes)) {
    throw new Error('World FFmpeg garbage receipt is not an ordinary bounded file.')
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat({ bigint: true })
    if (!sameStableFile(pathInfo, opened)) throw new Error('World FFmpeg garbage receipt changed before open.')
    const bytes = await readExactHandle(handle, Number(opened.size))
    const after = await handle.stat({ bigint: true })
    const publicAfter = await lstat(path, { bigint: true })
    if (!sameStableFile(opened, after) || !sameStableFile(after, publicAfter)) {
      throw new Error('World FFmpeg garbage receipt changed during read.')
    }
    return bytes
  } finally {
    await handle.close()
  }
}

async function readOrdinaryBoundedFileWithPublicationRetry(path, maximumBytes) {
  let lastError
  for (let attempt = 0; attempt < 101; attempt += 1) {
    try { return await readOrdinaryBoundedFile(path, maximumBytes) } catch (error) {
      if (error?.code === 'ENOENT') throw error
      lastError = error
      if (attempt < 100) await delay(2)
    }
  }
  throw lastError
}

async function optionalLstat(path) {
  try { return await lstat(path, { bigint: true }) } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export const WORLD_FFMPEG_GARBAGE_RECEIPT_NAME = RECEIPT_NAME

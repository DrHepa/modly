import { PHYSICS_ACCEPTANCE_LIMITS as LIMITS, PHYSICS_ACCEPTANCE_PROFILES as PROFILES, type PhysicsAcceptancePhase } from './worker-contract.ts'

const requireEntry = (value: unknown, message: string): void => { if (!value) throw new Error(message) }
export function acceptanceDeclaration(phase: PhysicsAcceptancePhase) {
  requireEntry(phase === 'timing' || phase === 'ownership', 'Invalid acceptance phase declaration.')
  const pumpMs = PROFILES[phase].driverDeadlineMs
  // New whole-entry policy, not a mutation of the protected pump/old proposed envelopes.
  const mainMs = LIMITS.startMs + LIMITS.authorMs + pumpMs + LIMITS.stopMs + LIMITS.reopenMs + LIMITS.killGraceMs
  return Object.freeze({ phase, startupMs: LIMITS.startMs, authorMs: LIMITS.authorMs, pumpMs,
    cancelMs: LIMITS.stopMs, reopenMs: LIMITS.reopenMs, graceMs: LIMITS.killGraceMs, mainMs,
    outerMs: mainMs + 2 * LIMITS.killGraceMs, nativeAccepted: false as const })
}
export type AcceptanceDeclaration = ReturnType<typeof acceptanceDeclaration>
export type AcceptanceContext = AcceptanceDeclaration & { token: string }
export function stableEntryJson(value: unknown): string {
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered)
    if (input !== null && typeof input === 'object') return Object.fromEntries(Object.keys(input).sort().map(key => [key, ordered(Reflect.get(input, key))]))
    requireEntry(input === null || typeof input === 'string' || typeof input === 'boolean' || (typeof input === 'number' && Number.isFinite(input)), 'Non-JSON acceptance value.')
    return input
  }
  return `${JSON.stringify(ordered(value))}\n`
}
export function validateAcceptanceBuild(build: { lane?: unknown; acceptancePhase?: unknown; acceptance?: unknown }) {
  if (build.acceptancePhase === undefined) { requireEntry(build.acceptance === undefined, 'Unexpected acceptance declaration.'); return null }
  requireEntry(build.lane === 'worker-only', 'Acceptance declaration requires worker-only lane.')
  const expected = acceptanceDeclaration(build.acceptancePhase as PhysicsAcceptancePhase)
  requireEntry(stableEntryJson(build.acceptance) === stableEntryJson(expected), 'Acceptance build/runtime declaration mismatch.')
  return expected
}
export { boundedFixtureAcceptanceOperation as boundedEntryOperation } from './shared.ts'
interface DurableFile { writeFile(bytes: string): Promise<unknown>; sync(): Promise<unknown>; close(): Promise<unknown> }
export function createDurableEntryWriter(ports: { openFile(name: string): Promise<DurableFile>; syncDirectory(): Promise<unknown> }) {
  let queue: Promise<unknown> = Promise.resolve()
  return (name: string, bytes: string): Promise<void> => {
    requireEntry(/^[a-z-]+\.json$/.test(name), 'Invalid owned acceptance filename.')
    requireEntry(new TextEncoder().encode(bytes).byteLength <= LIMITS.scalarBytes, 'Acceptance persistence byte cap exceeded.')
    const write = queue.then(async () => {
      const file = await ports.openFile(name)
      try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
      await ports.syncDirectory()
    })
    queue = write // A failed durability operation poisons later receipts, never silently retries.
    return write
  }
}
export async function verifyEntryCustody(baseline: { snapshot: unknown; files: unknown } | null, ports: { capture(): Promise<unknown>; reopen(): Promise<unknown> }) {
  const before = await ports.capture(), reopened = await ports.reopen() as { ok: boolean; value?: { status: string; snapshot: unknown } }
  const after = await ports.capture()
  if (!baseline || !reopened.ok || reopened.value?.status !== 'ready') throw new Error('Independent custody baseline/reopen unavailable.', { cause: { before, after, reopened } })
  if (stableEntryJson(before) !== stableEntryJson(baseline.files) || stableEntryJson(after) !== stableEntryJson(baseline.files)
    || stableEntryJson(reopened.value.snapshot) !== stableEntryJson(baseline.snapshot)) throw new Error('Independent project/ledger/backup custody changed.', { cause: { before, after, reopened } })
  return { unchanged: true as const, before, after, snapshot: reopened.value!.snapshot, rendererRequired: false as const }
}
type Identity = { sender: unknown; frame: unknown }
type Terminal = { phase: PhysicsAcceptancePhase; result: 'completed' | 'partial'; nativeAccepted: false; status: Record<string, unknown>; evidence: Record<string, unknown> | null; error?: string }
export function createAcceptanceOwner(context: AcceptanceContext, ports: { sender: unknown; frame: unknown; now(): number; isLive(): boolean;
  startedMs?: number; captureBaseline(payload: unknown): Promise<unknown>; persist(name: string, bytes: string): Promise<unknown> }) {
  const deadlineMs = (ports.startedMs ?? ports.now()) + context.mainMs
  let claimed = false, sequence = 0, busy = false, baselineCaptured = false, terminal: Terminal | null = null, functionalComplete = false, receiptReceived = false
  let revoked = false, partialWrite: Promise<void> | null = null
  let acknowledgeReceipt!: () => void
  const received = new Promise<void>(resolve => { acknowledgeReceipt = resolve })
  const sender = (identity: Identity) => requireEntry(ports.isLive() && identity.sender === ports.sender && identity.frame === ports.frame, 'Untrusted acceptance sender/main frame.')
  const decode = (raw: unknown) => {
    requireEntry(typeof raw === 'string' && raw.length <= LIMITS.scalarBytes && new TextEncoder().encode(raw as string).byteLength <= LIMITS.scalarBytes, 'Acceptance raw byte cap exceeded.')
    const message = JSON.parse(raw as string)
    requireEntry(message && !Array.isArray(message) && Object.keys(message).sort().join(',') === 'payload,phase,sequence,token,type', 'Invalid acceptance envelope.')
    requireEntry(message.token === context.token && message.phase === context.phase, 'Acceptance token/phase binding rejected.')
    requireEntry(Number.isSafeInteger(message.sequence) && message.sequence === sequence, 'Acceptance replay/sequence rejected.')
    return message
  }
  const state = () => Object.freeze({ claimed, deadlineMs, terminal, functionalComplete, baselineCaptured, receiptReceived, authorityRevoked: revoked, nativeAccepted: false as const })
  const continuing = (identity: Identity, type: string) => {
    sender(identity); requireEntry(!revoked && !terminal, 'Acceptance authority is revoked or terminal.')
    requireEntry(ports.now() < deadlineMs + (type === 'terminal' ? context.graceMs : 0), 'Acceptance deadline exceeded.')
  }
  async function invoke(identity: Identity, raw: unknown) {
    sender(identity); requireEntry(claimed, 'Acceptance context must be claimed.'); requireEntry(!terminal, 'Acceptance is terminal.'); requireEntry(!busy, 'Acceptance operation is already pending.')
    requireEntry(!revoked, 'Acceptance authority is revoked.')
    const message = decode(raw)
    requireEntry(ports.now() < deadlineMs + context.graceMs, 'Acceptance hard terminal deadline exceeded.')
    if (message.type !== 'terminal') requireEntry(ports.now() < deadlineMs, 'Acceptance deadline exceeded.')
    busy = true
    try {
      if (message.type === 'baseline') {
        requireEntry(!baselineCaptured, 'Acceptance baseline is one-shot.')
        await ports.captureBaseline(message.payload); continuing(identity, message.type); baselineCaptured = true
      } else if (message.type === 'progress') {
        const payload = message.payload
        requireEntry(baselineCaptured && payload && Object.keys(payload).sort().join(',') === 'cycle,state'
          && Number.isSafeInteger(payload.cycle) && payload.cycle >= 0 && payload.cycle <= PROFILES[context.phase].cycles
          && ['running', 'quiet', 'completed', 'partial'].includes(payload.state), 'Invalid coarse acceptance progress.')
      } else {
        requireEntry(message.type === 'terminal', 'Unknown acceptance operation.')
        const value = message.payload as Terminal
        requireEntry(value && value.phase === context.phase && value.nativeAccepted === false && ['completed', 'partial'].includes(value.result) && value.status, 'Invalid acceptance terminal binding.')
        if (value.result === 'completed') {
          const status = value.status, evidence = value.evidence, adapter = evidence?.adapter as Record<string, unknown> | undefined, cycles = PROFILES[context.phase].cycles
          requireEntry(baselineCaptured && status.phaseCompleted === true && status.settled === true && status.active === false
            && status.pendingCount === 0 && status.runtimePresent === false && status.runtimePoseCount === 0 && status.physicsBodyPoseCount === 0
            && status.phaseError === null && status.cleanupError === null && status.successfulCycles === cycles && status.quietCycles === cycles
            && evidence?.phase === context.phase && evidence.nativeAccepted === false && evidence.result === 'completed' && evidence.phaseError === null
            && evidence.cleanupError === null && evidence.exportError === null && adapter?.adapterSuccessful === true
            && adapter.successfulCycles === cycles && adapter.completedCycles === cycles && adapter.error === null, 'Completed acceptance requires settled Stop/audio/quiet and successful fixed cycles.')
        }
        await ports.persist('acceptance-terminal.json', stableEntryJson(value))
        continuing(identity, message.type)
        terminal = value; functionalComplete = value.result === 'completed'
      }
      sequence += 1
      return { persisted: message.type === 'terminal', baselineCaptured, nativeAccepted: false as const }
    } finally { busy = false }
  }
  return Object.freeze({ state, invoke, received,
    claim(identity: Identity) { sender(identity); requireEntry(!revoked, 'Acceptance authority is revoked.'); requireEntry(!claimed, 'Acceptance context already claimed.'); claimed = true; return Object.freeze({ ...context }) },
    receipt(identity: Identity, raw: unknown) {
      sender(identity); requireEntry(!revoked, 'Acceptance authority is revoked.'); requireEntry(ports.now() < deadlineMs, 'Acceptance receipt deadline exceeded.'); const message = decode(raw)
      requireEntry(terminal && message.type === 'receipt' && message.payload === null && !receiptReceived, 'Invalid terminal receipt replay.')
      receiptReceived = true; sequence += 1; acknowledgeReceipt(); return { received: true }
    },
    async forcePartial(error: string) {
      revoked = true; functionalComplete = false
      if (terminal) return state()
      if (!partialWrite) {
        const value: Terminal = { phase: context.phase, result: 'partial', nativeAccepted: false,
          status: { settled: false, phaseCompleted: false }, evidence: null, error: error.slice(0, 4096) }
        partialWrite = (async () => { await ports.persist('acceptance-terminal.json', stableEntryJson(value)); terminal = value })()
      }
      await partialWrite; return state()
    },
  })
}

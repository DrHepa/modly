import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  AgentActionsService,
  AgentActionsServiceError,
  type AgentActionExecutorRequest,
} from './agent-actions-service.ts'
import { WorkspaceAgentArtifactVerifier, type AgentArtifactVerifier } from './agent-artifact-verifier.ts'
import { sha256Canonical } from './agent-trust-contracts.ts'
import type {
  AgentCapabilitySnapshotV1,
  AgentOllamaModelSnapshotV1,
  ArtifactRefV1,
} from '../../src/shared/types/agentActions.ts'

function capabilityFixture(overrides: Partial<AgentCapabilitySnapshotV1> = {}): AgentCapabilitySnapshotV1 {
  const base: Omit<AgentCapabilitySnapshotV1, 'hash'> = {
    schema: 'modly.agent-capability.v1' as const,
    version: 1 as const,
    id: 'cad-tools/generate',
    displayName: 'Generate CAD',
    description: 'Generate a CAD mesh from text.',
    extension: { id: 'cad-tools', name: 'CAD Tools', version: '1.0.0' },
    node: {
      id: 'generate',
      input: 'text',
      output: 'mesh' as const,
      paramsSchema: [
        {
          id: 'quality',
          type: 'select',
          default: 'balanced',
          options: [
            { value: 'draft', label: 'Draft' },
            { value: 'balanced', label: 'Balanced' },
          ],
        },
        { id: 'iterations', type: 'int', default: 2, min: 1, max: 4 },
      ],
    },
    approval: { required: true as const, scope: 'single_action' as const },
  }
  const { hash: _ignored, ...snapshotOverrides } = overrides
  const unsigned: Omit<AgentCapabilitySnapshotV1, 'hash'> = { ...base, ...snapshotOverrides }
  return { ...unsigned, hash: sha256Canonical(unsigned) }
}

const selectedModel: AgentOllamaModelSnapshotV1 = {
  provider: 'ollama',
  endpoint: 'http://127.0.0.1:11434/',
  model: 'qwen3.6:latest',
  digest: `sha256:${'a'.repeat(64)}`,
}

const validOutput: ArtifactRefV1 = {
  schema: 'modly.artifact-ref.v1',
  version: 1,
  id: 'generated-mesh',
  kind: 'mesh',
  mediaType: 'model/gltf-binary',
  workspacePath: 'Workflows/agent/generated.glb',
  sha256: 'b'.repeat(64),
  sizeBytes: 128,
}

const passThroughArtifactVerifier: AgentArtifactVerifier = {
  async verify(candidate) { return candidate },
}

function clock(start = '2026-08-06T12:00:00.000Z') {
  let milliseconds = Date.parse(start)
  return {
    now: () => new Date(milliseconds),
    advance: (amount: number) => { milliseconds += amount },
  }
}

async function rejectsCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AgentActionsServiceError)
    assert.equal(error.code, code)
    return true
  })
}

test('proposal is default-deny, normalizes only declared arguments, and keeps private data out of public views', async () => {
  const capability = capabilityFixture()
  const time = clock()
  let captured: AgentActionExecutorRequest | undefined
  const service = new AgentActionsService({
    now: time.now,
    createActionId: () => 'action-private',
    createLease: () => 'private-lease-token',
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => ({ ...selectedModel, endpoint: 'http://127.0.0.1:11434' }),
    artifactVerifier: passThroughArtifactVerifier,
    executor: async (request) => {
      captured = request
      return { artifacts: [validOutput] }
    },
  })

  await rejectsCode(service.propose({
    capabilityId: 'legacy/not-opted-in',
    arguments: { input: 'chair', params: {} },
    model: selectedModel,
  }), 'capability_not_found')
  await rejectsCode(service.propose({
    capabilityId: capability.id,
    arguments: { input: 'chair', params: { hidden: true } },
    model: selectedModel,
  }), 'invalid_arguments')
  await rejectsCode(service.propose({
    capabilityId: capability.id,
    arguments: { input: 'chair', params: { quality: 'ultra' } },
    model: selectedModel,
  }), 'invalid_arguments')
  await rejectsCode(service.propose({
    capabilityId: capability.id,
    arguments: { input: 'chair', params: {} },
    model: selectedModel,
    status: 'approved',
  } as never), 'invalid_request')

  const proposed = await service.propose({
    capabilityId: capability.id,
    arguments: { input: 'chair', params: { quality: 'draft' } },
    model: selectedModel,
  })
  assert.equal(proposed.status, 'proposed')
  const publicJson = JSON.stringify(proposed)
  assert.equal(publicJson.includes('chair'), false)
  assert.equal(publicJson.includes('127.0.0.1'), false)
  assert.equal(publicJson.includes('private-lease-token'), false)
  assert.equal('arguments' in proposed, false)

  time.advance(10)
  await service.decide({ actionId: proposed.id, decision: 'approve' })
  time.advance(10)
  const completed = await service.execute({ actionId: proposed.id })
  assert.equal(completed.status, 'completed')
  assert.deepEqual(captured?.arguments, {
    input: 'chair',
    params: { iterations: 2, quality: 'draft' },
  })
  assert.equal(captured?.model.endpoint, 'http://127.0.0.1:11434')
  assert.equal(JSON.stringify(completed).includes(validOutput.workspacePath), false)
})

test('artifact inputs are resolved from opaque ids and paths or hashes are never accepted from the renderer', async () => {
  const capability = capabilityFixture({
    id: 'mesh-tools/optimize',
    extension: { id: 'mesh-tools', name: 'Mesh Tools', version: '1.0.0' },
    node: { id: 'optimize', input: 'mesh', output: 'mesh', paramsSchema: [] },
  })
  const sourceArtifact: ArtifactRefV1 = {
    ...validOutput,
    id: 'source-mesh',
    workspacePath: 'Workflows/private/source.glb',
    sha256: 'c'.repeat(64),
  }
  let captured: AgentActionExecutorRequest | undefined
  const service = new AgentActionsService({
    createActionId: () => 'action-artifact',
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    artifactVerifier: passThroughArtifactVerifier,
    resolveArtifact: async (artifactId) => artifactId === sourceArtifact.id ? sourceArtifact : null,
    executor: async (request) => { captured = request; return { artifacts: [validOutput] } },
  })

  await rejectsCode(service.propose({
    capabilityId: capability.id,
    arguments: { input: sourceArtifact, params: {} } as never,
    model: selectedModel,
  }), 'invalid_arguments')

  const proposed = await service.propose({
    capabilityId: capability.id,
    arguments: { input: { artifactId: sourceArtifact.id }, params: {} },
    model: selectedModel,
  })
  assert.equal(JSON.stringify(proposed).includes(sourceArtifact.workspacePath), false)
  assert.equal(JSON.stringify(proposed).includes(sourceArtifact.sha256), true)
  await service.decide({ actionId: proposed.id, decision: 'approve' })
  await service.execute({ actionId: proposed.id })
  assert.deepEqual(captured?.arguments, { input: sourceArtifact, params: {} })
})

test('approval fails closed when capability, model, or expiry changes after proposal', async () => {
  const initialCapability = capabilityFixture()
  let currentCapability = initialCapability
  let currentModel = selectedModel
  const time = clock()
  let nextId = 0
  const service = new AgentActionsService({
    now: time.now,
    approvalTtlMs: 1_000,
    createActionId: () => `action-binding-${++nextId}`,
    resolveCapabilities: async () => ({ capabilities: [currentCapability], errors: [] }),
    resolveCurrentModel: async () => currentModel,
    artifactVerifier: passThroughArtifactVerifier,
    executor: async () => ({ artifacts: [validOutput] }),
  })
  const propose = () => service.propose({
    capabilityId: initialCapability.id,
    arguments: { input: 'chair', params: {} },
    model: selectedModel,
  })

  const capabilityAction = await propose()
  currentCapability = capabilityFixture({ description: 'Changed capability.' })
  await rejectsCode(service.decide({ actionId: capabilityAction.id, decision: 'approve' }), 'capability_stale')
  assert.equal((await service.get({ actionId: capabilityAction.id })).status, 'cancelled')

  currentCapability = initialCapability
  const modelAction = await propose()
  currentModel = { ...selectedModel, digest: `sha256:${'d'.repeat(64)}` }
  await rejectsCode(service.decide({ actionId: modelAction.id, decision: 'approve' }), 'model_stale')
  assert.equal((await service.get({ actionId: modelAction.id })).status, 'cancelled')

  currentModel = selectedModel
  const expiredAction = await propose()
  time.advance(1_000)
  await rejectsCode(service.decide({ actionId: expiredAction.id, decision: 'approve' }), 'approval_expired')
  assert.equal((await service.get({ actionId: expiredAction.id })).status, 'expired')

  const staleExecution = await propose()
  await service.decide({ actionId: staleExecution.id, decision: 'approve' })
  currentCapability = capabilityFixture({ description: 'Changed after approval.' })
  await rejectsCode(service.execute({ actionId: staleExecution.id }), 'capability_stale')
  assert.equal((await service.get({ actionId: staleExecution.id })).status, 'cancelled')

  currentCapability = initialCapability
  const expiredLease = await propose()
  await service.decide({ actionId: expiredLease.id, decision: 'approve' })
  time.advance(1_000)
  await rejectsCode(service.execute({ actionId: expiredLease.id }), 'approval_expired')
  assert.equal((await service.get({ actionId: expiredLease.id })).status, 'expired')
})

test('approval lease is consumed once and concurrent execute calls invoke the executor at most once', async () => {
  const capability = capabilityFixture()
  let resolveExecution!: (value: { artifacts: ArtifactRefV1[] }) => void
  const executionResult = new Promise<{ artifacts: ArtifactRefV1[] }>((resolve) => { resolveExecution = resolve })
  let executions = 0
  const service = new AgentActionsService({
    createActionId: () => 'action-replay',
    createLease: () => 'one-use-secret-token-32bytes-aaaa',
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    artifactVerifier: passThroughArtifactVerifier,
    executor: async () => { executions += 1; return executionResult },
  })
  const proposed = await service.propose({
    capabilityId: capability.id,
    arguments: { input: 'chair', params: {} },
    model: selectedModel,
  })
  await service.decide({ actionId: proposed.id, decision: 'approve' })

  const first = service.execute({ actionId: proposed.id })
  await new Promise((resolve) => setImmediate(resolve))
  await rejectsCode(service.execute({ actionId: proposed.id }), 'invalid_state')
  resolveExecution({ artifacts: [validOutput] })
  assert.equal((await first).status, 'completed')
  await rejectsCode(service.execute({ actionId: proposed.id }), 'invalid_state')
  assert.equal(executions, 1)
})

test('approval expiring during authoritative re-resolution never reaches the executor', async () => {
  const capability = capabilityFixture()
  const time = clock()
  let expireDuringResolution = false
  let executions = 0
  const service = new AgentActionsService({
    now: time.now,
    approvalTtlMs: 100,
    createActionId: () => 'action-resolution-expiry',
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => {
      if (expireDuringResolution) time.advance(100)
      return selectedModel
    },
    artifactVerifier: passThroughArtifactVerifier,
    executor: async () => { executions += 1; return { artifacts: [validOutput] } },
  })
  const action = await service.propose({
    capabilityId: capability.id,
    arguments: { input: 'chair', params: {} },
    model: selectedModel,
  })
  await service.decide({ actionId: action.id, decision: 'approve' })
  expireDuringResolution = true
  await rejectsCode(service.execute({ actionId: action.id }), 'approval_expired')
  assert.equal(executions, 0)
  assert.equal((await service.get({ actionId: action.id })).status, 'cancelled')
})

test('cancellation is idempotent and late executor success cannot overwrite cancelled state', async () => {
  const capability = capabilityFixture()
  let started!: () => void
  const didStart = new Promise<void>((resolve) => { started = resolve })
  let resolveExecution!: (value: { artifacts: ArtifactRefV1[] }) => void
  const execution = new Promise<{ artifacts: ArtifactRefV1[] }>((resolve) => { resolveExecution = resolve })
  let executorSignal: AbortSignal | undefined
  const service = new AgentActionsService({
    createActionId: () => 'action-cancel',
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    artifactVerifier: passThroughArtifactVerifier,
    executor: async (request) => {
      executorSignal = request.signal
      started()
      return execution
    },
  })
  const proposed = await service.propose({
    capabilityId: capability.id,
    arguments: { input: 'chair', params: {} },
    model: selectedModel,
  })
  await service.decide({ actionId: proposed.id, decision: 'approve' })
  const running = service.execute({ actionId: proposed.id })
  await didStart

  assert.equal((await service.cancel({ actionId: proposed.id })).status, 'cancelled')
  assert.equal(executorSignal?.aborted, true)
  assert.equal((await service.cancel({ actionId: proposed.id })).status, 'cancelled')
  resolveExecution({ artifacts: [validOutput] })
  assert.equal((await running).status, 'cancelled')
  assert.equal((await service.get({ actionId: proposed.id })).status, 'cancelled')
})

test('executor output is fail-closed for unavailable executors, path escapes, wrong kinds, and duplicate artifacts', async () => {
  const capability = capabilityFixture()
  let nextId = 0
  let executor: ((request: AgentActionExecutorRequest) => Promise<unknown>) | undefined
  const service = new AgentActionsService({
    createActionId: () => `action-output-${++nextId}`,
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    artifactVerifier: passThroughArtifactVerifier,
    executor: (request) => executor ? executor(request) : Promise.reject(new Error('not configured')),
    isExecutorAvailable: () => executor !== undefined,
  })
  const createApproved = async () => {
    const action = await service.propose({
      capabilityId: capability.id,
      arguments: { input: 'chair', params: {} },
      model: selectedModel,
    })
    await service.decide({ actionId: action.id, decision: 'approve' })
    return action.id
  }

  const unavailable = await createApproved()
  await rejectsCode(service.execute({ actionId: unavailable }), 'executor_unavailable')
  assert.equal((await service.get({ actionId: unavailable })).status, 'failed')

  executor = async () => ({ artifacts: [{ ...validOutput, workspacePath: '../escape.glb' }] })
  const escape = await createApproved()
  await rejectsCode(service.execute({ actionId: escape }), 'invalid_artifact')
  assert.equal((await service.get({ actionId: escape })).outputs.length, 0)

  executor = async () => ({ artifacts: [{ ...validOutput, kind: 'image' }] })
  await rejectsCode(service.execute({ actionId: await createApproved() }), 'invalid_artifact')

  executor = async () => ({ artifacts: [validOutput, validOutput] })
  await rejectsCode(service.execute({ actionId: await createApproved() }), 'invalid_artifact')
})

test('terminal actions are bounded, expired actions are pruned into terminal state, and restart restores nothing', async () => {
  const capability = capabilityFixture()
  const time = clock()
  let nextId = 0
  const dependencies = {
    now: time.now,
    approvalTtlMs: 100,
    maxTerminalActions: 2,
    terminalRetentionMs: 60_000,
    createActionId: () => `action-retention-${++nextId}`,
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    artifactVerifier: passThroughArtifactVerifier,
  }
  const service = new AgentActionsService(dependencies)
  for (let index = 0; index < 3; index += 1) {
    const action = await service.propose({
      capabilityId: capability.id,
      arguments: { input: `chair-${index}`, params: {} },
      model: selectedModel,
    })
    time.advance(1)
    await service.decide({ actionId: action.id, decision: 'reject' })
    time.advance(1)
  }
  assert.deepEqual((await service.list()).map((action) => action.id), [
    'action-retention-2',
    'action-retention-3',
  ])

  const expiring = await service.propose({
    capabilityId: capability.id,
    arguments: { input: 'expiring', params: {} },
    model: selectedModel,
  })
  time.advance(100)
  assert.equal((await service.get({ actionId: expiring.id })).status, 'expired')

  const restarted = new AgentActionsService({ ...dependencies, createActionId: () => 'after-restart' })
  assert.deepEqual(await restarted.list(), [])
  await rejectsCode(restarted.get({ actionId: expiring.id }), 'action_not_found')
})

test('cancellation during input revalidation prevents executor invocation', async () => {
  const capability = capabilityFixture({
    id: 'mesh-tools/optimize',
    extension: { id: 'mesh-tools', name: 'Mesh Tools', version: '1.0.0' },
    node: { id: 'optimize', input: 'mesh', output: 'mesh', paramsSchema: [] },
  })
  const source = { ...validOutput, id: 'source-mesh', sha256: 'c'.repeat(64) }
  let verificationStarted!: () => void
  const didStartVerification = new Promise<void>((resolve) => { verificationStarted = resolve })
  let releaseVerification!: () => void
  const verificationBarrier = new Promise<void>((resolve) => { releaseVerification = resolve })
  let executions = 0
  const service = new AgentActionsService({
    createActionId: () => 'action-cancel-before-executor',
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    resolveArtifact: async () => source,
    artifactVerifier: {
      async verify(candidate) {
        if (candidate.id === source.id) {
          verificationStarted()
          await verificationBarrier
        }
        return candidate
      },
    },
    executor: async () => { executions += 1; return { artifacts: [validOutput] } },
  })
  const action = await service.propose({
    capabilityId: capability.id,
    arguments: { input: { artifactId: source.id }, params: {} },
    model: selectedModel,
  })
  await service.decide({ actionId: action.id, decision: 'approve' })
  const running = service.execute({ actionId: action.id })
  await didStartVerification
  assert.equal((await service.cancel({ actionId: action.id })).status, 'cancelled')
  releaseVerification()
  assert.equal((await running).status, 'cancelled')
  assert.equal(executions, 0)
})

test('cancellation wins while final output verification is awaiting and cannot be overwritten by completion', async () => {
  const capability = capabilityFixture()
  let outputVerificationStarted!: () => void
  const didStartOutputVerification = new Promise<void>((resolve) => { outputVerificationStarted = resolve })
  let releaseOutputVerification!: () => void
  const outputVerificationBarrier = new Promise<void>((resolve) => { releaseOutputVerification = resolve })
  const service = new AgentActionsService({
    createActionId: () => 'action-cancel-final-revalidation',
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    artifactVerifier: {
      async verify(candidate) {
        if (candidate.id === validOutput.id) {
          outputVerificationStarted()
          await outputVerificationBarrier
        }
        return candidate
      },
    },
    executor: async () => ({ artifacts: [validOutput] }),
  })
  const action = await service.propose({
    capabilityId: capability.id,
    arguments: { input: 'chair', params: {} },
    model: selectedModel,
  })
  await service.decide({ actionId: action.id, decision: 'approve' })
  const running = service.execute({ actionId: action.id })
  await didStartOutputVerification
  assert.equal((await service.cancel({ actionId: action.id })).status, 'cancelled')
  releaseOutputVerification()
  assert.equal((await running).status, 'cancelled')
  assert.equal((await service.get({ actionId: action.id })).status, 'cancelled')
})

test('input artifact mutation is detected immediately before start and never reaches the executor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modly-agent-input-revalidation-'))
  const workflows = join(root, 'Workflows')
  const original = Buffer.from('original mesh')
  await mkdir(workflows, { recursive: true })
  await writeFile(join(workflows, 'source.glb'), original)
  const capability = capabilityFixture({
    id: 'mesh-tools/optimize',
    extension: { id: 'mesh-tools', name: 'Mesh Tools', version: '1.0.0' },
    node: { id: 'optimize', input: 'mesh', output: 'mesh', paramsSchema: [] },
  })
  const source: ArtifactRefV1 = {
    ...validOutput,
    id: 'source-before-mutation',
    workspacePath: 'Workflows/source.glb',
    sha256: createHash('sha256').update(original).digest('hex'),
    sizeBytes: original.byteLength,
  }
  let executions = 0
  const service = new AgentActionsService({
    createActionId: () => 'action-mutated-input',
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    resolveArtifact: async () => source,
    artifactVerifier: new WorkspaceAgentArtifactVerifier({ getWorkspaceRoot: () => root }),
    executor: async () => { executions += 1; return { artifacts: [validOutput] } },
  })
  try {
    const action = await service.propose({
      capabilityId: capability.id,
      arguments: { input: { artifactId: source.id }, params: {} },
      model: selectedModel,
    })
    await service.decide({ actionId: action.id, decision: 'approve' })
    await writeFile(join(workflows, 'source.glb'), Buffer.from('mutated mesh!'))
    await rejectsCode(service.execute({ actionId: action.id }), 'invalid_artifact')
    assert.equal(executions, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

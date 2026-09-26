import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  AgentActionsService,
  AgentActionsServiceError,
  type AgentActionExecutorRequest,
} from './agent-actions-service.ts'
import { WorkspaceAgentArtifactVerifier, type AgentArtifactVerifier } from './agent-artifact-verifier.ts'
import { AgentProcessTerminalError } from './agent-process-executor.ts'
import { createAgentActionProposal, sha256Canonical } from './agent-trust-contracts.ts'
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

function modelFreeProcessCapabilityFixture(runtimeSha256 = 'c'.repeat(64)): AgentCapabilitySnapshotV1 {
  const runtimeFiles = [{
    path: 'processor.mjs', device: '1', inode: '2', uid: 1000, gid: 1000,
    mode: 0o644, size: 12, mtimeNs: '3', sha256: runtimeSha256,
  }]
  const resourceFiles: typeof runtimeFiles = []
  const artifacts = {
    maxCount: 2,
    maxTotalBytes: 2048,
    allowed: [
      { kind: 'glb' as const, mediaTypes: ['model/gltf-binary'], maxBytes: 1536 },
      { kind: 'plan' as const, mediaTypes: ['text/markdown'], maxBytes: 512 },
    ],
  }
  const runtimeHash = sha256Canonical({ runtimeFiles, resourceFiles })
  const execution = {
    kind: 'process' as const,
    schema: 'modly.agent-process-execution.v1' as const,
    entry: 'processor.mjs',
    runtimeFiles,
    resourceFiles,
    runtimeHash,
    artifacts,
    bindingHash: sha256Canonical({
      schema: 'modly.agent-process-execution.v1', entry: 'processor.mjs', runtimeHash, artifacts,
    }),
  }
  return capabilityFixture({
    node: {
      id: 'generate', input: 'text', output: 'glb', outputs: ['glb', 'plan'],
      paramsSchema: [
        {
          id: 'quality', type: 'select', default: 'balanced',
          options: [{ value: 'draft', label: 'Draft' }, { value: 'balanced', label: 'Balanced' }],
        },
        { id: 'iterations', type: 'int', default: 2, min: 1, max: 4 },
      ],
    },
    execution,
  })
}

function modelAccessProcessCapabilityFixture(): AgentCapabilitySnapshotV1 {
  const runtimeFiles = [{
    path: 'processor.py', device: '1', inode: '2', uid: 1000, gid: 1000,
    mode: 0o600, size: 128, mtimeNs: '3', sha256: '3'.repeat(64),
  }]
  const resourceFiles: never[] = []
  const runtimeUnsigned = {
    kind: 'extension-python-venv-v1' as const,
    interpreter: 'bin/python' as const,
    baseInterpreter: {
      device: '9', inode: '10', uid: 0, gid: 0, mode: 0o755, size: 1024, nlink: 1,
      mtimeNs: '11', ctimeNs: '12', sha256: 'f'.repeat(64),
    },
    treeDigest: '1'.repeat(64),
    sourceIdentityHash: '2'.repeat(64),
    entryCount: 8,
    logicalBytes: 4096,
  }
  const runtime = {
    ...runtimeUnsigned,
    bindingHash: sha256Canonical({ schema: 'modly.extension-python-runtime-binding.v1', ...runtimeUnsigned }),
  }
  const modelAccess = {
    schema: 'modly.agent-model-access.v1' as const,
    profile: 'ollama-responses-json-v1' as const,
  }
  const runtimeHash = sha256Canonical({ runtimeFiles, resourceFiles, runtime, modelAccess })
  const artifacts = {
    maxCount: 1,
    maxTotalBytes: 1024,
    allowed: [{ kind: 'text' as const, mediaTypes: ['text/plain'], maxBytes: 1024 }],
  }
  return capabilityFixture({
    node: {
      id: 'generate', input: 'text', output: 'text', outputs: ['text'],
      paramsSchema: [
        {
          id: 'quality', type: 'select', default: 'balanced',
          options: [{ value: 'draft', label: 'Draft' }, { value: 'balanced', label: 'Balanced' }],
        },
        { id: 'iterations', type: 'int', default: 2, min: 1, max: 4 },
      ],
    },
    execution: {
      kind: 'process', schema: 'modly.agent-process-execution.v1', entry: 'processor.py',
      runtimeFiles, resourceFiles, runtime, modelAccess, runtimeHash, artifacts,
      bindingHash: sha256Canonical({
        schema: 'modly.agent-process-execution.v1', entry: 'processor.py', runtimeHash, artifacts,
      }),
    },
  })
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

function publicArtifactSelection(artifact: ArtifactRefV1) {
  return {
    id: artifact.id,
    kind: artifact.kind,
    mediaType: artifact.mediaType,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
  }
}

function cadProcessCapability(input: {
  id: string
  input: AgentCapabilitySnapshotV1['node']['input']
  output: AgentCapabilitySnapshotV1['node']['output']
  outputs?: AgentCapabilitySnapshotV1['node']['outputs']
  inputs?: AgentCapabilitySnapshotV1['node']['inputs']
  allowed: Array<{ kind: ArtifactRefV1['kind'], mediaTypes: string[], maxBytes: number }>
  modelAccess?: boolean
}): AgentCapabilitySnapshotV1 {
  const template = input.modelAccess
    ? modelAccessProcessCapabilityFixture().execution
    : modelFreeProcessCapabilityFixture().execution
  if (template?.kind !== 'process') throw new Error('PROCESS fixture is unavailable')
  const { runtimeFiles, resourceFiles, runtime, modelAccess } = template
  const artifacts = {
    maxCount: input.allowed.length,
    maxTotalBytes: input.allowed.reduce((total, policy) => total + policy.maxBytes, 0),
    allowed: input.allowed,
  }
  const runtimeHash = sha256Canonical({
    runtimeFiles,
    resourceFiles,
    ...(runtime ? { runtime } : {}),
    ...(modelAccess ? { modelAccess } : {}),
  })
  const execution = {
    kind: 'process' as const,
    schema: 'modly.agent-process-execution.v1' as const,
    entry: template.entry,
    runtimeFiles,
    resourceFiles,
    ...(runtime ? { runtime } : {}),
    ...(modelAccess ? { modelAccess } : {}),
    runtimeHash,
    artifacts,
    bindingHash: sha256Canonical({
      schema: 'modly.agent-process-execution.v1', entry: template.entry, runtimeHash, artifacts,
    }),
  }
  const [extensionId, nodeId] = input.id.split('/')
  return capabilityFixture({
    id: input.id,
    displayName: nodeId,
    description: `${nodeId} fixture.`,
    extension: { id: extensionId, name: extensionId, version: '1.0.0' },
    node: {
      id: nodeId,
      input: input.input,
      output: input.output,
      ...(input.outputs ? { outputs: input.outputs } : {}),
      ...(input.inputs ? { inputs: input.inputs } : {}),
      paramsSchema: [],
    },
    execution,
  })
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
    originSessionId: 'test-session',
    capabilityId: 'legacy/not-opted-in',
    capabilityHash: '0'.repeat(64),
    arguments: { input: 'chair', params: {} },
    model: selectedModel,
  }), 'capability_not_found')
  await rejectsCode(service.propose({
    originSessionId: 'test-session',
    capabilityId: capability.id,
    capabilityHash: capability.hash,
    arguments: { input: 'chair', params: { hidden: true } },
    model: selectedModel,
  }), 'invalid_arguments')
  await rejectsCode(service.propose({
    originSessionId: 'test-session',
    capabilityId: capability.id,
    capabilityHash: capability.hash,
    arguments: { input: 'chair', params: { quality: 'ultra' } },
    model: selectedModel,
  }), 'invalid_arguments')
  await rejectsCode(service.propose({
    originSessionId: 'test-session',
    capabilityId: capability.id,
    capabilityHash: capability.hash,
    arguments: { input: 'chair', params: {} },
    model: selectedModel,
    status: 'approved',
  } as never), 'invalid_request')

  const proposed = await service.propose({
    originSessionId: 'test-session',
    capabilityId: capability.id,
    capabilityHash: capability.hash,
    arguments: { input: 'chair', params: { quality: 'draft' } },
    model: selectedModel,
  })
  assert.equal(proposed.status, 'proposed')
  const publicJson = JSON.stringify(proposed)
  assert.deepEqual(proposed.preview[0], { label: 'Input', value: 'chair' })
  assert.equal(publicJson.includes('127.0.0.1'), false)
  assert.equal(publicJson.includes('private-lease-token'), false)
  assert.equal('arguments' in proposed, false)

  time.advance(10)
  await service.decide({ actionId: proposed.id, originSessionId: 'test-session', decision: 'approve' })
  time.advance(10)
  const completed = await service.execute({ actionId: proposed.id, originSessionId: 'test-session' })
  assert.equal(completed.status, 'completed')
  assert.deepEqual(captured?.arguments, {
    input: 'chair',
    params: { iterations: 2, quality: 'draft' },
  })
  assert.equal(captured?.originSessionId, 'test-session')
  assert.equal(captured?.model.endpoint, 'http://127.0.0.1:11434')
  const expectedProposal = createAgentActionProposal({
    id: proposed.id,
    capability,
    arguments: { input: 'chair', params: { iterations: 2, quality: 'draft' } },
    model: selectedModel,
    inputArtifacts: [],
    approval: proposed.approval,
    createdAt: proposed.createdAt,
  })
  assert.equal(captured?.proposalHash, expectedProposal.proposalHash)
  assert.equal(JSON.stringify(completed).includes(validOutput.workspacePath), false)
})

test('process execution accepts only its declared multi-artifact policy and keeps trusted context main-owned', async () => {
  const capability = modelFreeProcessCapabilityFixture()
  const plan: ArtifactRefV1 = {
    ...validOutput, id: 'generated-plan', kind: 'plan', mediaType: 'text/markdown',
    workspacePath: 'Workflows/agent-actions/action-process/plan.md', sizeBytes: 64,
  }
  const glb: ArtifactRefV1 = {
    ...validOutput, id: 'generated-glb', kind: 'glb',
    workspacePath: 'Workflows/agent-actions/action-process/model.glb', sizeBytes: 128,
  }
  let captured: AgentActionExecutorRequest | undefined
  let modelResolverCalls = 0
  const service = new AgentActionsService({
    createActionId: () => 'action-process',
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => {
      modelResolverCalls += 1
      throw new Error('the provider must not be consulted for a model-free process')
    },
    artifactVerifier: passThroughArtifactVerifier,
    executor: async (value) => { captured = value; return { artifacts: [plan, glb] } },
  })
  await rejectsCode(service.propose({
    originSessionId: 'session-process', capabilityId: capability.id, capabilityHash: capability.hash,
    arguments: { input: 'chair', params: {}, trustedContext: { actionId: 'forged' } }, model: selectedModel,
  } as never), 'invalid_arguments')

  const proposed = await service.propose({
    originSessionId: 'session-process', capabilityId: capability.id, capabilityHash: capability.hash,
    arguments: { input: 'chair', params: {} }, model: selectedModel,
  })
  await service.decide({ actionId: proposed.id, originSessionId: 'session-process', decision: 'approve' })
  const completed = await service.execute({ actionId: proposed.id, originSessionId: 'session-process' })
  assert.equal(completed.status, 'completed')
  assert.equal(modelResolverCalls, 0)
  assert.equal(captured?.originSessionId, 'session-process')
  assert.deepEqual(captured?.model, { ...selectedModel, endpoint: 'http://127.0.0.1:11434' })
  assert.deepEqual(completed.outputs.map((output) => output.kind), ['plan', 'glb'])
})

test('process execution requires a verified artifact matching the declared primary output', async () => {
  const capability = cadProcessCapability({
    id: 'cad-tools/build', input: 'text', output: 'glb', outputs: ['glb', 'plan'],
    allowed: [
      { kind: 'glb', mediaTypes: ['model/gltf-binary'], maxBytes: 1536 },
      { kind: 'plan', mediaTypes: ['text/markdown'], maxBytes: 512 },
    ],
  })
  const secondary: ArtifactRefV1 = {
    ...validOutput,
    id: 'secondary-plan',
    kind: 'plan',
    mediaType: 'text/markdown',
    workspacePath: 'Workflows/agent-actions/action-secondary-only/plan.md',
    sizeBytes: 64,
  }
  const service = new AgentActionsService({
    createActionId: () => 'action-secondary-only',
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    artifactVerifier: passThroughArtifactVerifier,
    executor: async () => ({ artifacts: [secondary] }),
  })
  const proposed = await service.propose({
    originSessionId: 'session-secondary-only', capabilityId: capability.id,
    capabilityHash: capability.hash, arguments: { input: 'chair', params: {} }, model: selectedModel,
  })
  await service.decide({ actionId: proposed.id, originSessionId: 'session-secondary-only', decision: 'approve' })
  await rejectsCode(
    service.execute({ actionId: proposed.id, originSessionId: 'session-secondary-only' }),
    'invalid_artifact',
  )
})

test('model-free process still rejects a changed runtime binding without consulting the model provider', async () => {
  const initialCapability = modelFreeProcessCapabilityFixture()
  let currentCapability = initialCapability
  let modelResolverCalls = 0
  const service = new AgentActionsService({
    createActionId: () => 'action-process-runtime-swap',
    resolveCapabilities: async () => ({ capabilities: [currentCapability], errors: [] }),
    resolveCurrentModel: async () => {
      modelResolverCalls += 1
      throw new Error('the provider must not be consulted for a model-free process')
    },
  })
  const proposed = await service.propose({
    originSessionId: 'session-process', capabilityId: initialCapability.id,
    capabilityHash: initialCapability.hash, arguments: { input: 'chair', params: {} },
    model: selectedModel,
  })
  currentCapability = modelFreeProcessCapabilityFixture('d'.repeat(64))
  await rejectsCode(
    service.decide({ actionId: proposed.id, originSessionId: 'session-process', decision: 'approve' }),
    'capability_stale',
  )
  assert.equal(modelResolverCalls, 0)
  assert.equal((await service.get({ actionId: proposed.id, originSessionId: 'session-process' })).status, 'cancelled')
})

test('model-free process still rejects approval lease hash tampering without consulting the model provider', async () => {
  const capability = modelFreeProcessCapabilityFixture()
  let modelResolverCalls = 0
  const service = new AgentActionsService({
    now: clock().now,
    createActionId: () => 'action-process-tampered-approval',
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => {
      modelResolverCalls += 1
      throw new Error('the provider must not be consulted for a model-free process')
    },
  })
  const proposed = await service.propose({
    originSessionId: 'session-process', capabilityId: capability.id, capabilityHash: capability.hash,
    arguments: { input: 'chair', params: {} }, model: selectedModel,
  })
  await service.decide({ actionId: proposed.id, originSessionId: 'session-process', decision: 'approve' })
  const privateLeases = (service as unknown as {
    leases: Map<string, { bindingHash: string }>
  }).leases
  const lease = privateLeases.get(proposed.id)
  assert.ok(lease)
  lease.bindingHash = '0'.repeat(64)
  await rejectsCode(
    service.execute({ actionId: proposed.id, originSessionId: 'session-process' }),
    'capability_stale',
  )
  assert.equal(modelResolverCalls, 0)
})

test('model-access process keeps live provider-model revalidation at every service boundary', async () => {
  const capability = modelAccessProcessCapabilityFixture()
  let modelResolverCalls = 0
  const output: ArtifactRefV1 = {
    ...validOutput,
    id: 'model-plan',
    kind: 'text',
    mediaType: 'text/plain',
    workspacePath: 'Workflows/agent-actions/action-model-access/plan.txt',
    sizeBytes: 64,
  }
  const service = new AgentActionsService({
    createActionId: () => 'action-model-access',
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => {
      modelResolverCalls += 1
      return selectedModel
    },
    artifactVerifier: passThroughArtifactVerifier,
    executor: async () => ({ artifacts: [output] }),
  })
  const proposed = await service.propose({
    originSessionId: 'session-model-access', capabilityId: capability.id,
    capabilityHash: capability.hash, arguments: { input: 'chair', params: {} }, model: selectedModel,
  })
  await service.decide({ actionId: proposed.id, originSessionId: 'session-model-access', decision: 'approve' })
  const completed = await service.execute({ actionId: proposed.id, originSessionId: 'session-model-access' })
  assert.equal(completed.status, 'completed')
  assert.equal(modelResolverCalls, 4)
})

test('main binds actions to an origin session and generates a bounded redacted approval preview', async () => {
  let nextId = 0
  const capability = capabilityFixture({
    node: {
      id: 'generate', input: 'text', output: 'mesh',
      paramsSchema: [
        { id: 'quality', label: 'Quality', type: 'select', default: 'balanced', options: [{ value: 'balanced', label: 'Balanced' }] },
        { id: 'api_token', label: 'API token', type: 'string', default: '' },
        { id: 'notes', label: 'Notes', type: 'string', default: '' },
      ],
    },
  })
  const service = new AgentActionsService({
    createActionId: () => `session-action-${++nextId}`,
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
  })

  const first = await service.propose({
    originSessionId: 'session-a',
    capabilityId: capability.id,
    capabilityHash: capability.hash,
    arguments: { input: 'chair', params: { api_token: 'https://private.invalid/token', notes: 'Authorization: Bearer private-secret' } },
    model: selectedModel,
  } as never)
  const second = await service.propose({
    originSessionId: 'session-b',
    capabilityId: capability.id,
    capabilityHash: capability.hash,
    arguments: { input: 'table', params: {} },
    model: selectedModel,
  } as never)

  assert.equal(first.capability.risk, 'mutating')
  assert.deepEqual(first.preview, [
    { label: 'Input', value: 'chair' },
    { label: 'Quality', value: 'balanced' },
    { label: 'API token', value: '[redacted]' },
    { label: 'Notes', value: '[redacted]' },
  ])
  assert.equal(JSON.stringify(first).includes('private.invalid'), false)
  assert.equal(JSON.stringify(first).includes('private-secret'), false)
  assert.deepEqual((await service.list({ originSessionId: 'session-a' } as never)).map((action) => action.id), [first.id])
  assert.deepEqual((await service.list({ originSessionId: 'session-b' } as never)).map((action) => action.id), [second.id])
  await rejectsCode(service.get({ actionId: first.id, originSessionId: 'session-b' } as never), 'action_not_found')
})

test('MCP capability proposals preserve canonical schema-shaped arguments without workflow input wrappers', async () => {
  const inputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', maxLength: 80 } },
    required: ['text'],
  }
  const capability = capabilityFixture({
    id: 'mcp-tools/create-text',
    extension: { id: 'mcp-tools', name: 'MCP Tools', version: '1.0.0' },
    node: { id: 'create-text', input: 'text', output: 'text', paramsSchema: [] },
    execution: {
      kind: 'mcp_tool',
      inputSchema,
      inputSchemaHash: sha256Canonical(inputSchema),
      mutating: true,
      bindingHash: 'd'.repeat(64),
    },
  })
  let captured: AgentActionExecutorRequest | undefined
  let modelResolverCalls = 0
  let modelProviderAvailable = true
  const service = new AgentActionsService({
    createActionId: () => 'action-mcp',
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => {
      modelResolverCalls += 1
      if (!modelProviderAvailable) throw new Error('model provider unavailable')
      return selectedModel
    },
    artifactVerifier: passThroughArtifactVerifier,
    executor: async (request) => {
      captured = request
      return { artifacts: [{ ...validOutput, kind: 'text', mediaType: 'text/plain' }] }
    },
  })
  const proposed = await service.propose({
    originSessionId: 'test-session',
    capabilityId: capability.id,
    capabilityHash: capability.hash,
    arguments: { text: 'hello' },
    model: selectedModel,
  })
  await service.decide({ actionId: proposed.id, originSessionId: 'test-session', decision: 'approve' })
  await service.execute({ actionId: proposed.id, originSessionId: 'test-session' })
  assert.deepEqual(captured?.arguments, { text: 'hello' })
  assert.equal(modelResolverCalls, 4)
  modelProviderAvailable = false
  await rejectsCode(service.propose({
    originSessionId: 'test-session', capabilityId: capability.id, capabilityHash: capability.hash,
    arguments: { text: 'provider must be live' }, model: selectedModel,
  }), 'model_stale')
  assert.equal(modelResolverCalls, 5)
  modelProviderAvailable = true
  await rejectsCode(service.propose({
    originSessionId: 'test-session',
    capabilityId: capability.id,
    capabilityHash: capability.hash,
    arguments: Object.assign(Object.create(null), { constructor: 'polluted' }),
    model: selectedModel,
  }), 'invalid_arguments')
})

test('MCP artifact arguments resolve opaque inventory ids in main and bind authoritative identities into the proposal', async () => {
  const inputSchema = {
    type: 'object', additionalProperties: false,
    properties: {
      sceneArtifact: { type: 'string', maxLength: 128 },
      operation: { type: 'string', maxLength: 32 },
    },
    required: ['sceneArtifact', 'operation'],
  }
  const capability = capabilityFixture({
    id: 'mcp-tools/inspect-scene',
    extension: { id: 'mcp-tools', name: 'MCP Tools', version: '1.0.0' },
    node: { id: 'inspect-scene', input: 'blend', output: 'text', paramsSchema: [] },
    execution: {
      kind: 'mcp_tool', inputSchema, inputSchemaHash: sha256Canonical(inputSchema),
      inputArtifacts: [{
        argument: 'sceneArtifact', kind: 'blend', mediaTypes: ['application/x-blender'], sandboxPath: '/input/0',
      }],
      mutating: false, bindingHash: 'd'.repeat(64),
    } as never,
  })
  const sourceArtifact: ArtifactRefV1 = {
    schema: 'modly.artifact-ref.v1', version: 1, id: 'approved-scene', kind: 'blend',
    mediaType: 'application/x-blender', workspacePath: 'Workflows/scenes/approved.blend',
    sha256: 'c'.repeat(64), sizeBytes: 4096,
  }
  const producer = capabilityFixture({
    id: 'scene-tools/create-scene',
    extension: { id: 'scene-tools', name: 'Scene Tools', version: '1.0.0' },
    node: { id: 'create-scene', input: 'text', output: 'blend', paramsSchema: [] },
  })
  let captured: AgentActionExecutorRequest | undefined
  let nextId = 0
  const service = new AgentActionsService({
    createActionId: () => `action-mcp-input-${++nextId}`,
    resolveCapabilities: async () => ({ capabilities: [producer, capability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    artifactVerifier: passThroughArtifactVerifier,
    executor: async (request) => {
      if (request.capability.id === producer.id) return { artifacts: [sourceArtifact] }
      captured = request
      return { artifacts: [{ ...validOutput, kind: 'text', mediaType: 'text/plain' }] }
    },
  })
  const source = await service.propose({
    originSessionId: 'test-session', capabilityId: producer.id, capabilityHash: producer.hash,
    arguments: { input: 'cube', params: {} }, model: selectedModel,
  })
  await service.decide({ actionId: source.id, originSessionId: 'test-session', decision: 'approve' })
  await service.execute({ actionId: source.id, originSessionId: 'test-session' })
  const proposed = await service.propose({
    originSessionId: 'test-session', capabilityId: capability.id, capabilityHash: capability.hash,
    arguments: { sceneArtifact: sourceArtifact.id, operation: 'inspect' }, model: selectedModel,
  })
  assert.equal(JSON.stringify(proposed).includes(sourceArtifact.workspacePath), false)
  assert.equal(JSON.stringify(proposed).includes(sourceArtifact.sha256), true)
  await service.decide({ actionId: proposed.id, originSessionId: 'test-session', decision: 'approve' })
  await service.execute({ actionId: proposed.id, originSessionId: 'test-session' })
  assert.deepEqual(captured?.arguments, { sceneArtifact: sourceArtifact.id, operation: 'inspect' })
  assert.deepEqual(captured?.inputArtifacts, [sourceArtifact])

  for (const [invalid, expected] of [
    [{ sceneArtifact: sourceArtifact.workspacePath, operation: 'inspect' }, 'invalid_arguments'],
    [{ sceneArtifact: sourceArtifact.sha256, operation: 'inspect' }, 'artifact_not_found'],
    [{ sceneArtifact: { artifactId: sourceArtifact.id, path: sourceArtifact.workspacePath }, operation: 'inspect' }, 'invalid_arguments'],
  ] as const) {
    await rejectsCode(service.propose({
      originSessionId: 'test-session', capabilityId: capability.id, capabilityHash: capability.hash,
      arguments: invalid as never, model: selectedModel,
    }), expected)
  }
})

test('MCP artifact bindings resolve only an unambiguous successful output from the same session', async () => {
  const producer = capabilityFixture({
    id: 'scene-tools/create-scene',
    extension: { id: 'scene-tools', name: 'Scene Tools', version: '1.0.0' },
    node: { id: 'create-scene', input: 'text', output: 'blend', paramsSchema: [] },
  })
  const inputSchema = {
    type: 'object', additionalProperties: false,
    properties: { sceneArtifact: { type: 'string', maxLength: 128 } },
    required: ['sceneArtifact'],
  }
  const consumer = capabilityFixture({
    id: 'mcp-tools/inspect-scene',
    extension: { id: 'mcp-tools', name: 'MCP Tools', version: '1.0.0' },
    node: { id: 'inspect-scene', input: 'blend', output: 'text', paramsSchema: [] },
    execution: {
      kind: 'mcp_tool', inputSchema, inputSchemaHash: sha256Canonical(inputSchema),
      inputArtifacts: [{
        argument: 'sceneArtifact', kind: 'blend', mediaTypes: ['application/x-blender'], sandboxPath: '/input/0',
      }],
      mutating: false, bindingHash: 'd'.repeat(64),
    } as never,
  })
  const blend: ArtifactRefV1 = {
    schema: 'modly.artifact-ref.v1', version: 1, id: 'scene-output', kind: 'blend',
    mediaType: 'application/x-blender', workspacePath: 'Workflows/scene.blend',
    sha256: '7'.repeat(64), sizeBytes: 2048,
  }
  let nextId = 0
  let captured: AgentActionExecutorRequest | undefined
  const service = new AgentActionsService({
    createActionId: () => `mcp-chain-${++nextId}`,
    resolveCapabilities: async () => ({ capabilities: [producer, consumer], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    artifactVerifier: passThroughArtifactVerifier,
    executor: async (request) => {
      if (request.capability.id === producer.id) return { artifacts: [blend] }
      captured = request
      return { artifacts: [{ ...validOutput, id: 'scene-report', kind: 'text', mediaType: 'text/plain' }] }
    },
  })
  const produced = await service.propose({
    originSessionId: 'scene-session', capabilityId: producer.id, capabilityHash: producer.hash,
    arguments: { input: 'cube', params: {} }, model: selectedModel,
  })
  await service.decide({ actionId: produced.id, originSessionId: 'scene-session', decision: 'approve' })
  await service.execute({ actionId: produced.id, originSessionId: 'scene-session' })

  await rejectsCode(service.propose({
    originSessionId: 'other-session', capabilityId: consumer.id, capabilityHash: consumer.hash,
    arguments: { sceneArtifact: blend.id }, model: selectedModel,
  }), 'artifact_not_found')
  const proposal = await service.propose({
    originSessionId: 'scene-session', capabilityId: consumer.id, capabilityHash: consumer.hash,
    arguments: { sceneArtifact: blend.id }, model: selectedModel,
  })
  await service.decide({ actionId: proposal.id, originSessionId: 'scene-session', decision: 'approve' })
  await service.execute({ actionId: proposal.id, originSessionId: 'scene-session' })
  assert.deepEqual(captured?.inputArtifacts, [blend])
  assert.equal(JSON.stringify(proposal).includes(blend.workspacePath), false)
})

test('MCP output identities remain non-reusable after pruning while the current same-session reference stays valid', async () => {
  const producerSchema = { type: 'object', additionalProperties: false, properties: {} }
  const producer = capabilityFixture({
    id: 'mcp-tools/create-scene',
    extension: { id: 'mcp-tools', name: 'MCP Tools', version: '1.0.0' },
    node: { id: 'create-scene', input: 'text', output: 'blend', paramsSchema: [] },
    execution: {
      kind: 'mcp_tool', inputSchema: producerSchema, inputSchemaHash: sha256Canonical(producerSchema),
      mutating: true, bindingHash: 'd'.repeat(64),
    } as never,
  })
  const consumerSchema = {
    type: 'object', additionalProperties: false,
    properties: { sceneArtifact: { type: 'string', maxLength: 128 } },
    required: ['sceneArtifact'],
  }
  const consumer = capabilityFixture({
    id: 'mcp-tools/inspect-scene',
    extension: { id: 'mcp-tools', name: 'MCP Tools', version: '1.0.0' },
    node: { id: 'inspect-scene', input: 'blend', output: 'text', paramsSchema: [] },
    execution: {
      kind: 'mcp_tool', inputSchema: consumerSchema, inputSchemaHash: sha256Canonical(consumerSchema),
      inputArtifacts: [{
        argument: 'sceneArtifact', kind: 'blend', mediaTypes: ['application/x-blender'], sandboxPath: '/input/0',
      }],
      mutating: false, bindingHash: 'e'.repeat(64),
    } as never,
  })
  const providerArtifact: ArtifactRefV1 = {
    schema: 'modly.artifact-ref.v1', version: 1, id: 'provider-scene', kind: 'blend',
    mediaType: 'application/x-blender', workspacePath: 'Workflows/provider-scene.blend',
    sha256: '7'.repeat(64), sizeBytes: 2048,
  }
  const actionIds = ['mcp-producer-one', 'mcp-producer-two', 'mcp-consumer']
  const service = new AgentActionsService({
    maxTerminalActions: 1,
    createActionId: () => actionIds.shift() ?? 'unexpected-action',
    resolveCapabilities: async () => ({ capabilities: [producer, consumer], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    artifactVerifier: passThroughArtifactVerifier,
    executor: async (request) => request.capability.id === producer.id
      ? { artifacts: [providerArtifact] }
      : { artifacts: [{ ...validOutput, id: 'provider-report', kind: 'text', mediaType: 'text/plain' }] },
  })
  const produce = async () => {
    const action = await service.propose({
      originSessionId: 'mcp-reuse-session', capabilityId: producer.id,
      capabilityHash: producer.hash, arguments: {}, model: selectedModel,
    })
    await service.decide({ actionId: action.id, originSessionId: 'mcp-reuse-session', decision: 'approve' })
    return service.execute({ actionId: action.id, originSessionId: 'mcp-reuse-session' })
  }

  const first = await produce()
  const second = await produce()
  assert.notEqual(first.outputs[0].id, second.outputs[0].id)
  await rejectsCode(service.propose({
    originSessionId: 'mcp-reuse-session', capabilityId: consumer.id, capabilityHash: consumer.hash,
    arguments: { sceneArtifact: first.outputs[0].id }, model: selectedModel,
  }), 'artifact_not_found')
  const valid = await service.propose({
    originSessionId: 'mcp-reuse-session', capabilityId: consumer.id, capabilityHash: consumer.hash,
    arguments: { sceneArtifact: second.outputs[0].id }, model: selectedModel,
  })
  assert.deepEqual(valid.inputs, [{ ...second.outputs[0] }])
})

test('MCP file outputs are validated against their own declared path policy instead of the first output kind', async () => {
  const inputSchema = { type: 'object', additionalProperties: false, properties: {} }
  const capability = capabilityFixture({
    id: 'mcp-tools/render-pair',
    extension: { id: 'mcp-tools', name: 'MCP Tools', version: '1.0.0' },
    node: {
      id: 'render-pair', input: 'text', output: 'blend', outputs: ['blend', 'text'], paramsSchema: [],
    },
    execution: {
      kind: 'mcp_tool', inputSchema, inputSchemaHash: sha256Canonical(inputSchema),
      artifacts: {
        profile: 'relative-files-v1', maxCount: 2, maxArtifactBytes: 1024, maxTotalBytes: 2048,
        allowed: [
          { path: 'report.txt', kind: 'text', mediaTypes: ['text/plain'], maxBytes: 1024, required: true },
          { path: 'scene.blend', kind: 'blend', mediaTypes: ['application/x-blender'], maxBytes: 1024, required: true },
        ],
      },
      mutating: true, bindingHash: 'd'.repeat(64),
    },
  })
  const artifact = (id: string, path: string, kind: ArtifactRefV1['kind'], mediaType: string): ArtifactRefV1 => ({
    schema: 'modly.artifact-ref.v1', version: 1, id, kind, mediaType,
    workspacePath: `Workflows/agent-actions/action-mcp-pair/${path}`,
    sha256: id === 'scene' ? '1'.repeat(64) : '2'.repeat(64), sizeBytes: 16,
  })
  const service = new AgentActionsService({
    createActionId: () => 'action-mcp-pair',
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    artifactVerifier: passThroughArtifactVerifier,
    executor: async () => ({ artifacts: [
      artifact('scene', 'scene.blend', 'text', 'text/plain'),
      artifact('report', 'report.txt', 'blend', 'application/x-blender'),
    ] }),
  })
  const proposed = await service.propose({
    originSessionId: 'test-session', capabilityId: capability.id, capabilityHash: capability.hash,
    arguments: {}, model: selectedModel,
  })
  await service.decide({ actionId: proposed.id, originSessionId: 'test-session', decision: 'approve' })
  await rejectsCode(service.execute({ actionId: proposed.id, originSessionId: 'test-session' }), 'invalid_artifact')

  const validService = new AgentActionsService({
    createActionId: () => 'action-mcp-pair',
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    artifactVerifier: {
      async verify(candidate, expectedKind) {
        assert.equal(expectedKind, candidate.kind)
        return candidate
      },
    },
    executor: async () => ({ artifacts: [
      artifact('scene', 'scene.blend', 'blend', 'application/x-blender'),
      artifact('report', 'report.txt', 'text', 'text/plain'),
    ] }),
  })
  const validProposal = await validService.propose({
    originSessionId: 'test-session', capabilityId: capability.id, capabilityHash: capability.hash,
    arguments: {}, model: selectedModel,
  })
  await validService.decide({ actionId: validProposal.id, originSessionId: 'test-session', decision: 'approve' })
  const completed = await validService.execute({ actionId: validProposal.id, originSessionId: 'test-session' })
  assert.deepEqual(completed.outputs.map((output) => output.kind), ['blend', 'text'])
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
  const producer = capabilityFixture({
    id: 'mesh-tools/create-mesh',
    extension: { id: 'mesh-tools', name: 'Mesh Tools', version: '1.0.0' },
    node: { id: 'create-mesh', input: 'text', output: 'mesh', paramsSchema: [] },
  })
  let captured: AgentActionExecutorRequest | undefined
  let nextId = 0
  const service = new AgentActionsService({
    createActionId: () => `action-artifact-${++nextId}`,
    resolveCapabilities: async () => ({ capabilities: [producer, capability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    artifactVerifier: passThroughArtifactVerifier,
    executor: async (request) => {
      if (request.capability.id === producer.id) return { artifacts: [sourceArtifact] }
      captured = request
      return { artifacts: [validOutput] }
    },
  })

  const source = await service.propose({
    originSessionId: 'test-session', capabilityId: producer.id, capabilityHash: producer.hash,
    arguments: { input: 'mesh', params: {} }, model: selectedModel,
  })
  await service.decide({ actionId: source.id, originSessionId: 'test-session', decision: 'approve' })
  await service.execute({ actionId: source.id, originSessionId: 'test-session' })

  await rejectsCode(service.propose({
    originSessionId: 'test-session',
    capabilityId: capability.id,
    capabilityHash: capability.hash,
    arguments: { input: sourceArtifact, params: {} } as never,
    model: selectedModel,
  }), 'invalid_arguments')

  const proposed = await service.propose({
    originSessionId: 'test-session',
    capabilityId: capability.id,
    capabilityHash: capability.hash,
    arguments: { input: publicArtifactSelection(sourceArtifact), params: {} },
    model: selectedModel,
  })
  assert.equal(JSON.stringify(proposed).includes(sourceArtifact.workspacePath), false)
  assert.equal(JSON.stringify(proposed).includes(sourceArtifact.sha256), true)
  await service.decide({ actionId: proposed.id, originSessionId: 'test-session', decision: 'approve' })
  await service.execute({ actionId: proposed.id, originSessionId: 'test-session' })
  assert.deepEqual(captured?.arguments, { input: sourceArtifact, params: {} })
})

test('same-session completed PROCESS outputs chain plan to source to model-free build with exact public refs', async () => {
  const planCapability = cadProcessCapability({
    id: 'text-to-cad-agent/plan-cad', input: 'text', output: 'plan', outputs: ['plan'], modelAccess: true,
    allowed: [{ kind: 'plan', mediaTypes: ['application/vnd.modly.cad-plan+json'], maxBytes: 4096 }],
  })
  const compileCapability = cadProcessCapability({
    id: 'text-to-cad-agent/compile-cad', input: 'plan', output: 'source', outputs: ['source'], modelAccess: true,
    allowed: [{ kind: 'source', mediaTypes: ['application/vnd.modly.cad-source+json'], maxBytes: 4096 }],
  })
  const buildCapability = cadProcessCapability({
    id: 'text-to-cad-agent/build-cad', input: 'source', output: 'glb', outputs: ['glb', 'step'],
    inputs: [
      { name: 'plan', label: 'Approved CAD plan', type: 'plan', required: true },
      { name: 'source', label: 'Approved CAD source', type: 'source', required: true },
    ],
    allowed: [
      { kind: 'glb', mediaTypes: ['model/gltf-binary'], maxBytes: 8192 },
      { kind: 'step', mediaTypes: ['model/step'], maxBytes: 8192 },
    ],
  })
  const planArtifact: ArtifactRefV1 = {
    schema: 'modly.artifact-ref.v1', version: 1, id: 'cad-plan-1', kind: 'plan',
    mediaType: 'application/vnd.modly.cad-plan+json', workspacePath: 'Workflows/agent-actions/action-plan/plan.json',
    sha256: '1'.repeat(64), sizeBytes: 321,
  }
  const sourceArtifact: ArtifactRefV1 = {
    schema: 'modly.artifact-ref.v1', version: 1, id: 'cad-source-1', kind: 'source',
    mediaType: 'application/vnd.modly.cad-source+json', workspacePath: 'Workflows/agent-actions/action-compile/source.json',
    sha256: '2'.repeat(64), sizeBytes: 654,
  }
  const glbArtifact: ArtifactRefV1 = {
    schema: 'modly.artifact-ref.v1', version: 1, id: 'cad-glb-1', kind: 'glb',
    mediaType: 'model/gltf-binary', workspacePath: 'Workflows/agent-actions/action-build/model.glb',
    sha256: '3'.repeat(64), sizeBytes: 1024,
  }
  const stepArtifact: ArtifactRefV1 = {
    schema: 'modly.artifact-ref.v1', version: 1, id: 'cad-step-1', kind: 'step',
    mediaType: 'model/step', workspacePath: 'Workflows/agent-actions/action-build/model.step',
    sha256: '4'.repeat(64), sizeBytes: 2048,
  }
  const ids = ['action-plan', 'action-compile', 'action-build']
  const captured = new Map<string, AgentActionExecutorRequest>()
  let modelResolverCalls = 0
  const service = new AgentActionsService({
    createActionId: () => ids.shift() ?? 'unexpected-action',
    resolveCapabilities: async () => ({ capabilities: [planCapability, compileCapability, buildCapability], errors: [] }),
    resolveCurrentModel: async () => { modelResolverCalls += 1; return selectedModel },
    artifactVerifier: passThroughArtifactVerifier,
    executor: async (request) => {
      captured.set(request.capability.id, request)
      if (request.capability.id === planCapability.id) return { artifacts: [planArtifact] }
      if (request.capability.id === compileCapability.id) return { artifacts: [sourceArtifact] }
      return { artifacts: [glbArtifact, stepArtifact] }
    },
  })

  const plan = await service.propose({
    originSessionId: 'cad-session', capabilityId: planCapability.id, capabilityHash: planCapability.hash,
    arguments: { input: 'Create a 40 mm cube.', params: {} }, model: selectedModel,
  })
  await service.decide({ actionId: plan.id, originSessionId: 'cad-session', decision: 'approve' })
  const completedPlan = await service.execute({ actionId: plan.id, originSessionId: 'cad-session' })
  assert.deepEqual(completedPlan.outputs, [publicArtifactSelection(planArtifact)])
  assert.equal(JSON.stringify(completedPlan).includes(planArtifact.workspacePath), false)
  assert.deepEqual(
    (await service.list({ originSessionId: 'cad-session' })).flatMap((action) => action.outputs.map((output) => output.id)),
    ['cad-plan-1'],
  )
  assert.deepEqual(await service.list({ originSessionId: 'other-session' }), [])

  await rejectsCode(service.propose({
    originSessionId: 'other-session', capabilityId: compileCapability.id, capabilityHash: compileCapability.hash,
    arguments: { input: publicArtifactSelection(planArtifact), params: {} }, model: selectedModel,
  }), 'artifact_not_found')
  const compile = await service.propose({
    originSessionId: 'cad-session', capabilityId: compileCapability.id, capabilityHash: compileCapability.hash,
    arguments: { input: publicArtifactSelection(planArtifact), params: {} }, model: selectedModel,
  })
  await service.decide({ actionId: compile.id, originSessionId: 'cad-session', decision: 'approve' })
  await service.execute({ actionId: compile.id, originSessionId: 'cad-session' })
  assert.deepEqual(captured.get(compileCapability.id)?.inputArtifacts, [planArtifact])
  assert.deepEqual(
    (await service.list({ originSessionId: 'cad-session' }))
      .flatMap((action) => action.outputs.map((output) => output.id)).sort(),
    ['cad-plan-1', 'cad-source-1'],
  )

  const modelCallsBeforeBuild = modelResolverCalls
  const build = await service.propose({
    originSessionId: 'cad-session', capabilityId: buildCapability.id, capabilityHash: buildCapability.hash,
    arguments: { input: {
      plan: publicArtifactSelection(planArtifact),
      source: publicArtifactSelection(sourceArtifact),
    }, params: {} },
    model: selectedModel,
  })
  await service.decide({ actionId: build.id, originSessionId: 'cad-session', decision: 'approve' })
  const completedBuild = await service.execute({ actionId: build.id, originSessionId: 'cad-session' })
  assert.deepEqual(captured.get(buildCapability.id)?.inputArtifacts, [planArtifact, sourceArtifact])
  assert.deepEqual(completedBuild.outputs, [publicArtifactSelection(glbArtifact), publicArtifactSelection(stepArtifact)])
  assert.equal(modelResolverCalls, modelCallsBeforeBuild)

  const restarted = new AgentActionsService({
    resolveCapabilities: async () => ({ capabilities: [compileCapability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
  })
  await rejectsCode(restarted.propose({
    originSessionId: 'cad-session', capabilityId: compileCapability.id, capabilityHash: compileCapability.hash,
    arguments: { input: publicArtifactSelection(planArtifact), params: {} }, model: selectedModel,
  }), 'artifact_not_found')
})

test('completed artifact resolution rejects non-success, ambiguity, and every requested identity mismatch', async () => {
  const producer = cadProcessCapability({
    id: 'cad-chain/produce-plan', input: 'text', output: 'plan', outputs: ['plan'],
    allowed: [{ kind: 'plan', mediaTypes: ['application/vnd.modly.cad-plan+json'], maxBytes: 4096 }],
  })
  const consumer = cadProcessCapability({
    id: 'cad-chain/consume-plan', input: 'plan', output: 'source', outputs: ['source'],
    allowed: [{ kind: 'source', mediaTypes: ['application/vnd.modly.cad-source+json'], maxBytes: 4096 }],
  })
  const planArtifact: ArtifactRefV1 = {
    schema: 'modly.artifact-ref.v1', version: 1, id: 'shared-plan', kind: 'plan',
    mediaType: 'application/vnd.modly.cad-plan+json', workspacePath: 'Workflows/shared-plan.json',
    sha256: '5'.repeat(64), sizeBytes: 99,
  }
  let nextId = 0
  const service = new AgentActionsService({
    createActionId: () => `artifact-status-${++nextId}`,
    resolveCapabilities: async () => ({ capabilities: [producer, consumer], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    artifactVerifier: passThroughArtifactVerifier,
    executor: async (request) => request.capability.id === producer.id
      ? { artifacts: [planArtifact] }
      : { artifacts: [{ ...planArtifact, id: 'compiled-source', kind: 'source', mediaType: 'application/vnd.modly.cad-source+json' }] },
  })
  const selection = publicArtifactSelection(planArtifact)

  const running = await service.propose({
    originSessionId: 'session-a', capabilityId: producer.id, capabilityHash: producer.hash,
    arguments: { input: 'pending', params: {} }, model: selectedModel,
  })
  await rejectsCode(service.propose({
    originSessionId: 'session-a', capabilityId: consumer.id, capabilityHash: consumer.hash,
    arguments: { input: selection, params: {} }, model: selectedModel,
  }), 'artifact_not_found')
  await service.decide({ actionId: running.id, originSessionId: 'session-a', decision: 'reject' })
  await rejectsCode(service.propose({
    originSessionId: 'session-a', capabilityId: consumer.id, capabilityHash: consumer.hash,
    arguments: { input: selection, params: {} }, model: selectedModel,
  }), 'artifact_not_found')

  for (let index = 0; index < 2; index += 1) {
    const action = await service.propose({
      originSessionId: 'session-a', capabilityId: producer.id, capabilityHash: producer.hash,
      arguments: { input: `complete-${index}`, params: {} }, model: selectedModel,
    })
    await service.decide({ actionId: action.id, originSessionId: 'session-a', decision: 'approve' })
    await service.execute({ actionId: action.id, originSessionId: 'session-a' })
    if (index === 0) {
      for (const mismatched of [
        { ...selection, id: 'missing-plan' },
        { ...selection, kind: 'source' },
        { ...selection, mediaType: 'application/json' },
        { ...selection, sha256: '6'.repeat(64) },
        { ...selection, sizeBytes: selection.sizeBytes + 1 },
      ]) {
        await rejectsCode(service.propose({
          originSessionId: 'session-a', capabilityId: consumer.id, capabilityHash: consumer.hash,
          arguments: { input: mismatched, params: {} } as never, model: selectedModel,
        }), 'artifact_not_found')
      }
    }
  }
  await rejectsCode(service.propose({
    originSessionId: 'session-a', capabilityId: consumer.id, capabilityHash: consumer.hash,
    arguments: { input: selection, params: {} }, model: selectedModel,
  }), 'artifact_not_found')
})

test('failed, cancelled, and executing producer attempts never become artifact authority', async () => {
  const producer = cadProcessCapability({
    id: 'artifact-status/produce-plan', input: 'text', output: 'plan', outputs: ['plan'],
    allowed: [{ kind: 'plan', mediaTypes: ['application/vnd.modly.cad-plan+json'], maxBytes: 4096 }],
  })
  const consumer = cadProcessCapability({
    id: 'artifact-status/consume-plan', input: 'plan', output: 'source', outputs: ['source'],
    allowed: [{ kind: 'source', mediaTypes: ['application/vnd.modly.cad-source+json'], maxBytes: 4096 }],
  })
  const failedArtifact: ArtifactRefV1 = {
    schema: 'modly.artifact-ref.v1', version: 1, id: 'failed-plan', kind: 'plan',
    mediaType: 'application/vnd.modly.cad-plan+json', workspacePath: 'Workflows/failed-plan.json',
    sha256: '7'.repeat(64), sizeBytes: 7,
  }
  const cancelledArtifact: ArtifactRefV1 = {
    ...failedArtifact, id: 'cancelled-plan', workspacePath: 'Workflows/cancelled-plan.json',
    sha256: '8'.repeat(64), sizeBytes: 8,
  }
  let nextId = 0
  let executorStarted!: () => void
  const didStartExecutor = new Promise<void>((resolve) => { executorStarted = resolve })
  let releaseExecutor!: () => void
  const executorBarrier = new Promise<void>((resolve) => { releaseExecutor = resolve })
  let executorAborted!: () => void
  const didAbortExecutor = new Promise<void>((resolve) => { executorAborted = resolve })
  const service = new AgentActionsService({
    createActionId: () => `producer-status-${++nextId}`,
    resolveCapabilities: async () => ({ capabilities: [producer, consumer], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    artifactVerifier: passThroughArtifactVerifier,
    executor: async (request) => {
      if (request.capability.id !== producer.id) throw new Error('consumer must not execute')
      if (JSON.stringify(request.arguments).includes('failed')) throw new Error('producer failed')
      request.signal.addEventListener('abort', executorAborted, { once: true })
      executorStarted()
      await executorBarrier
      return { artifacts: [cancelledArtifact] }
    },
  })
  const proposeConsumer = (artifact: ArtifactRefV1) => service.propose({
    originSessionId: 'artifact-status-session', capabilityId: consumer.id, capabilityHash: consumer.hash,
    arguments: { input: publicArtifactSelection(artifact), params: {} }, model: selectedModel,
  })

  const failed = await service.propose({
    originSessionId: 'artifact-status-session', capabilityId: producer.id, capabilityHash: producer.hash,
    arguments: { input: 'failed', params: {} }, model: selectedModel,
  })
  await service.decide({ actionId: failed.id, originSessionId: 'artifact-status-session', decision: 'approve' })
  await rejectsCode(service.execute({ actionId: failed.id, originSessionId: 'artifact-status-session' }), 'execution_failed')
  assert.equal((await service.get({ actionId: failed.id, originSessionId: 'artifact-status-session' })).status, 'failed')
  await rejectsCode(proposeConsumer(failedArtifact), 'artifact_not_found')

  const cancellable = await service.propose({
    originSessionId: 'artifact-status-session', capabilityId: producer.id, capabilityHash: producer.hash,
    arguments: { input: 'cancelled', params: {} }, model: selectedModel,
  })
  await service.decide({ actionId: cancellable.id, originSessionId: 'artifact-status-session', decision: 'approve' })
  const running = service.execute({ actionId: cancellable.id, originSessionId: 'artifact-status-session' })
  await didStartExecutor
  assert.equal((await service.get({ actionId: cancellable.id, originSessionId: 'artifact-status-session' })).status, 'executing')
  await rejectsCode(proposeConsumer(cancelledArtifact), 'artifact_not_found')
  const cancelling = service.cancel({ actionId: cancellable.id, originSessionId: 'artifact-status-session' })
  await didAbortExecutor
  releaseExecutor()
  assert.equal((await cancelling).status, 'cancelled')
  assert.equal((await running).status, 'cancelled')
  await rejectsCode(proposeConsumer(cancelledArtifact), 'artifact_not_found')
})

test('artifact authority follows bounded terminal retention without invalidating an already-bound action', async () => {
  const producer = cadProcessCapability({
    id: 'retention/produce-plan', input: 'text', output: 'plan', outputs: ['plan'],
    allowed: [{ kind: 'plan', mediaTypes: ['application/vnd.modly.cad-plan+json'], maxBytes: 4096 }],
  })
  const consumer = cadProcessCapability({
    id: 'retention/consume-plan', input: 'plan', output: 'source', outputs: ['source'],
    allowed: [{ kind: 'source', mediaTypes: ['application/vnd.modly.cad-source+json'], maxBytes: 4096 }],
  })
  const time = clock()
  let nextAction = 0
  let producedCount = 0
  const producedArtifacts: ArtifactRefV1[] = []
  const service = new AgentActionsService({
    now: time.now,
    terminalRetentionMs: 1_000,
    maxTerminalActions: 1,
    createActionId: () => `retained-action-${++nextAction}`,
    resolveCapabilities: async () => ({ capabilities: [producer, consumer], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    artifactVerifier: passThroughArtifactVerifier,
    executor: async (request) => {
      if (request.capability.id === producer.id) {
        producedCount += 1
        const artifact: ArtifactRefV1 = {
          schema: 'modly.artifact-ref.v1', version: 1, id: `retained-plan-${producedCount}`, kind: 'plan',
          mediaType: 'application/vnd.modly.cad-plan+json', workspacePath: `Workflows/plan-${producedCount}.json`,
          sha256: String(producedCount).repeat(64), sizeBytes: producedCount,
        }
        producedArtifacts.push(artifact)
        return { artifacts: [artifact] }
      }
      return { artifacts: [{
        schema: 'modly.artifact-ref.v1', version: 1, id: 'retained-source', kind: 'source',
        mediaType: 'application/vnd.modly.cad-source+json', workspacePath: 'Workflows/source.json',
        sha256: '9'.repeat(64), sizeBytes: 9,
      }] }
    },
  })
  const completePlan = async (label: string) => {
    const action = await service.propose({
      originSessionId: 'retention-session', capabilityId: producer.id, capabilityHash: producer.hash,
      arguments: { input: label, params: {} }, model: selectedModel,
    })
    await service.decide({ actionId: action.id, originSessionId: 'retention-session', decision: 'approve' })
    await service.execute({ actionId: action.id, originSessionId: 'retention-session' })
    time.advance(1)
  }
  await completePlan('first')
  const boundConsumer = await service.propose({
    originSessionId: 'retention-session', capabilityId: consumer.id, capabilityHash: consumer.hash,
    arguments: { input: publicArtifactSelection(producedArtifacts[0]), params: {} }, model: selectedModel,
  })
  await completePlan('second')
  await rejectsCode(service.propose({
    originSessionId: 'retention-session', capabilityId: consumer.id, capabilityHash: consumer.hash,
    arguments: { input: publicArtifactSelection(producedArtifacts[0]), params: {} }, model: selectedModel,
  }), 'artifact_not_found')

  await service.decide({ actionId: boundConsumer.id, originSessionId: 'retention-session', decision: 'approve' })
  assert.equal((await service.execute({ actionId: boundConsumer.id, originSessionId: 'retention-session' })).status, 'completed')
  // State transitions use strictly monotonic millisecond timestamps even when
  // this test clock has not advanced between approval/execution boundaries.
  time.advance(1_010)
  await rejectsCode(service.propose({
    originSessionId: 'retention-session', capabilityId: consumer.id, capabilityHash: consumer.hash,
    arguments: { input: publicArtifactSelection(producedArtifacts[1]), params: {} }, model: selectedModel,
  }), 'artifact_not_found')
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
    originSessionId: 'test-session',
    capabilityId: initialCapability.id,
    capabilityHash: initialCapability.hash,
    arguments: { input: 'chair', params: {} },
    model: selectedModel,
  })

  const capabilityAction = await propose()
  currentCapability = capabilityFixture({ description: 'Changed capability.' })
  await rejectsCode(service.decide({ actionId: capabilityAction.id, originSessionId: 'test-session', decision: 'approve' }), 'capability_stale')
  assert.equal((await service.get({ actionId: capabilityAction.id, originSessionId: 'test-session' })).status, 'cancelled')

  currentCapability = initialCapability
  const modelAction = await propose()
  currentModel = { ...selectedModel, digest: `sha256:${'d'.repeat(64)}` }
  await rejectsCode(service.decide({ actionId: modelAction.id, originSessionId: 'test-session', decision: 'approve' }), 'model_stale')
  assert.equal((await service.get({ actionId: modelAction.id, originSessionId: 'test-session' })).status, 'cancelled')

  currentModel = selectedModel
  const expiredAction = await propose()
  time.advance(1_000)
  await rejectsCode(service.decide({ actionId: expiredAction.id, originSessionId: 'test-session', decision: 'approve' }), 'approval_expired')
  assert.equal((await service.get({ actionId: expiredAction.id, originSessionId: 'test-session' })).status, 'expired')

  const staleExecution = await propose()
  await service.decide({ actionId: staleExecution.id, originSessionId: 'test-session', decision: 'approve' })
  currentCapability = capabilityFixture({ description: 'Changed after approval.' })
  await rejectsCode(service.execute({ actionId: staleExecution.id, originSessionId: 'test-session' }), 'capability_stale')
  assert.equal((await service.get({ actionId: staleExecution.id, originSessionId: 'test-session' })).status, 'cancelled')

  currentCapability = initialCapability
  const expiredLease = await propose()
  await service.decide({ actionId: expiredLease.id, originSessionId: 'test-session', decision: 'approve' })
  time.advance(1_000)
  await rejectsCode(service.execute({ actionId: expiredLease.id, originSessionId: 'test-session' }), 'approval_expired')
  assert.equal((await service.get({ actionId: expiredLease.id, originSessionId: 'test-session' })).status, 'expired')
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
    originSessionId: 'test-session',
    capabilityId: capability.id,
    capabilityHash: capability.hash,
    arguments: { input: 'chair', params: {} },
    model: selectedModel,
  })
  await service.decide({ actionId: proposed.id, originSessionId: 'test-session', decision: 'approve' })

  const first = service.execute({ actionId: proposed.id, originSessionId: 'test-session' })
  await new Promise((resolve) => setImmediate(resolve))
  await rejectsCode(service.execute({ actionId: proposed.id, originSessionId: 'test-session' }), 'invalid_state')
  resolveExecution({ artifacts: [validOutput] })
  assert.equal((await first).status, 'completed')
  await rejectsCode(service.execute({ actionId: proposed.id, originSessionId: 'test-session' }), 'invalid_state')
  assert.equal(executions, 1)
})

test('terminal child failure consumes its single-use approval and completes no publication accounting', async () => {
  const capability = capabilityFixture()
  let executions = 0
  const service = new AgentActionsService({
    createActionId: () => 'action-terminal-child-failure',
    createLease: () => 'one-use-secret-token-32bytes-error',
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    artifactVerifier: passThroughArtifactVerifier,
    executor: async () => {
      executions += 1
      throw new AgentActionsServiceError('execution_failed', new AgentProcessTerminalError({
        code: 'model_binding_unavailable',
        message: 'The approved model binding is unavailable.',
      }))
    },
  })
  const action = await service.propose({
    originSessionId: 'test-session', capabilityId: capability.id, capabilityHash: capability.hash,
    arguments: { input: 'chair', params: {} }, model: selectedModel,
  })
  await service.decide({ actionId: action.id, originSessionId: 'test-session', decision: 'approve' })

  await rejectsCode(service.execute({ actionId: action.id, originSessionId: 'test-session' }), 'execution_failed')
  const failed = await service.get({ actionId: action.id, originSessionId: 'test-session' })
  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.outputs, [])
  assert.equal(executions, 1)
  await rejectsCode(service.execute({ actionId: action.id, originSessionId: 'test-session' }), 'invalid_state')
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
    originSessionId: 'test-session',
    capabilityId: capability.id,
    capabilityHash: capability.hash,
    arguments: { input: 'chair', params: {} },
    model: selectedModel,
  })
  await service.decide({ actionId: action.id, originSessionId: 'test-session', decision: 'approve' })
  expireDuringResolution = true
  await rejectsCode(service.execute({ actionId: action.id, originSessionId: 'test-session' }), 'approval_expired')
  assert.equal(executions, 0)
  assert.equal((await service.get({ actionId: action.id, originSessionId: 'test-session' })).status, 'cancelled')
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
    originSessionId: 'test-session',
    capabilityId: capability.id,
    capabilityHash: capability.hash,
    arguments: { input: 'chair', params: {} },
    model: selectedModel,
  })
  await service.decide({ actionId: proposed.id, originSessionId: 'test-session', decision: 'approve' })
  const running = service.execute({ actionId: proposed.id, originSessionId: 'test-session' })
  await didStart

  const cancelling = service.cancel({ actionId: proposed.id, originSessionId: 'test-session' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(executorSignal?.aborted, true)
  resolveExecution({ artifacts: [validOutput] })
  assert.equal((await cancelling).status, 'cancelled')
  assert.equal((await service.cancel({ actionId: proposed.id, originSessionId: 'test-session' })).status, 'cancelled')
  assert.equal((await running).status, 'cancelled')
  assert.equal((await service.get({ actionId: proposed.id, originSessionId: 'test-session' })).status, 'cancelled')
})

test('shutdown aborts and awaits running executors and rejects new work', async () => {
  const capability = capabilityFixture()
  let started!: () => void
  const didStart = new Promise<void>((resolve) => { started = resolve })
  let executorSignal: AbortSignal | undefined
  const service = new AgentActionsService({
    createActionId: () => 'action-shutdown',
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    artifactVerifier: passThroughArtifactVerifier,
    executor: async (request) => {
      executorSignal = request.signal
      started()
      await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true }))
      return { artifacts: [validOutput] }
    },
  })
  const proposed = await service.propose({
    originSessionId: 'test-session', capabilityId: capability.id, capabilityHash: capability.hash,
    arguments: { input: 'chair', params: {} }, model: selectedModel,
  })
  await service.decide({ actionId: proposed.id, originSessionId: 'test-session', decision: 'approve' })
  const running = service.execute({ actionId: proposed.id, originSessionId: 'test-session' })
  await didStart
  await service.shutdown()
  assert.equal(executorSignal?.aborted, true)
  assert.equal((await running).status, 'cancelled')
  await rejectsCode(service.propose({
    originSessionId: 'test-session', capabilityId: capability.id, capabilityHash: capability.hash,
    arguments: { input: 'table', params: {} }, model: selectedModel,
  }), 'executor_unavailable')
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
    originSessionId: 'test-session',
      capabilityId: capability.id,
    capabilityHash: capability.hash,
      arguments: { input: 'chair', params: {} },
      model: selectedModel,
    })
    await service.decide({ actionId: action.id, originSessionId: 'test-session', decision: 'approve' })
    return action.id
  }

  const unavailable = await createApproved()
  await rejectsCode(service.execute({ actionId: unavailable, originSessionId: 'test-session' }), 'executor_unavailable')
  assert.equal((await service.get({ actionId: unavailable, originSessionId: 'test-session' })).status, 'approved')
  executor = async () => ({ artifacts: [validOutput] })
  assert.equal((await service.execute({ actionId: unavailable, originSessionId: 'test-session' })).status, 'completed')

  executor = async () => ({ artifacts: [{ ...validOutput, workspacePath: '../escape.glb' }] })
  const escape = await createApproved()
  await rejectsCode(service.execute({ actionId: escape, originSessionId: 'test-session' }), 'invalid_artifact')
  assert.equal((await service.get({ actionId: escape, originSessionId: 'test-session' })).outputs.length, 0)

  executor = async () => ({ artifacts: [{ ...validOutput, kind: 'image' }] })
  await rejectsCode(service.execute({ actionId: await createApproved(), originSessionId: 'test-session' }), 'invalid_artifact')

  executor = async () => ({ artifacts: [validOutput, validOutput] })
  await rejectsCode(service.execute({ actionId: await createApproved(), originSessionId: 'test-session' }), 'invalid_artifact')
})

test('a governed executor can return stable fail-closed sandbox_unavailable without exposing its cause', async () => {
  const capability = capabilityFixture()
  const service = new AgentActionsService({
    createActionId: () => 'action-sandbox-unavailable',
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    artifactVerifier: passThroughArtifactVerifier,
    executor: async () => { throw new AgentActionsServiceError('sandbox_unavailable', new Error('/private/bwrap path')) },
  })
  const proposed = await service.propose({
    originSessionId: 'test-session',
    capabilityId: capability.id,
    capabilityHash: capability.hash,
    arguments: { input: 'chair', params: {} },
    model: selectedModel,
  })
  await service.decide({ actionId: proposed.id, originSessionId: 'test-session', decision: 'approve' })
  await rejectsCode(service.execute({ actionId: proposed.id, originSessionId: 'test-session' }), 'sandbox_unavailable')
  const failed = await service.get({ actionId: proposed.id, originSessionId: 'test-session' })
  assert.equal(failed.status, 'failed')
  assert.equal(JSON.stringify(failed).includes('/private'), false)
})

test('sandbox readiness failure preserves the approval lease for a retry until expiry', async () => {
  const capability = capabilityFixture()
  const time = clock()
  let ready = false
  let executions = 0
  let nextId = 0
  const service = new AgentActionsService({
    now: time.now,
    approvalTtlMs: 1_000,
    createActionId: () => `action-retry-readiness-${++nextId}`,
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    artifactVerifier: passThroughArtifactVerifier,
    ensureExecutorReady: async () => {
      if (!ready) throw new AgentActionsServiceError('sandbox_unavailable')
    },
    executor: async () => { executions += 1; return { artifacts: [validOutput] } },
  })
  const proposed = await service.propose({
    originSessionId: 'test-session',
    capabilityId: capability.id,
    capabilityHash: capability.hash,
    arguments: { input: 'chair', params: {} },
    model: selectedModel,
  })
  await service.decide({ actionId: proposed.id, originSessionId: 'test-session', decision: 'approve' })

  await rejectsCode(service.execute({ actionId: proposed.id, originSessionId: 'test-session' }), 'sandbox_unavailable')
  assert.equal((await service.get({ actionId: proposed.id, originSessionId: 'test-session' })).status, 'approved')
  assert.equal(executions, 0)

  ready = true
  assert.equal((await service.execute({ actionId: proposed.id, originSessionId: 'test-session' })).status, 'completed')
  assert.equal(executions, 1)

  ready = false
  const expiring = await service.propose({
    originSessionId: 'test-session',
    capabilityId: capability.id,
    capabilityHash: capability.hash,
    arguments: { input: 'table', params: {} },
    model: selectedModel,
  })
  await service.decide({ actionId: expiring.id, originSessionId: 'test-session', decision: 'approve' })
  await rejectsCode(service.execute({ actionId: expiring.id, originSessionId: 'test-session' }), 'sandbox_unavailable')
  time.advance(1_000)
  await rejectsCode(service.execute({ actionId: expiring.id, originSessionId: 'test-session' }), 'approval_expired')
  assert.equal((await service.get({ actionId: expiring.id, originSessionId: 'test-session' })).status, 'expired')
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
    originSessionId: 'test-session',
      capabilityId: capability.id,
    capabilityHash: capability.hash,
      arguments: { input: `chair-${index}`, params: {} },
      model: selectedModel,
    })
    time.advance(1)
    await service.decide({ actionId: action.id, originSessionId: 'test-session', decision: 'reject' })
    time.advance(1)
  }
  assert.deepEqual((await service.list({ originSessionId: 'test-session' })).map((action) => action.id), [
    'action-retention-2',
    'action-retention-3',
  ])

  const expiring = await service.propose({
    originSessionId: 'test-session',
    capabilityId: capability.id,
    capabilityHash: capability.hash,
    arguments: { input: 'expiring', params: {} },
    model: selectedModel,
  })
  time.advance(100)
  assert.equal((await service.get({ actionId: expiring.id, originSessionId: 'test-session' })).status, 'expired')

  const restarted = new AgentActionsService({ ...dependencies, createActionId: () => 'after-restart' })
  assert.deepEqual(await restarted.list({ originSessionId: 'test-session' }), [])
  await rejectsCode(restarted.get({ actionId: expiring.id, originSessionId: 'test-session' }), 'action_not_found')
})

test('cancellation during input revalidation prevents executor invocation', async () => {
  const capability = capabilityFixture({
    id: 'mesh-tools/optimize',
    extension: { id: 'mesh-tools', name: 'Mesh Tools', version: '1.0.0' },
    node: { id: 'optimize', input: 'mesh', output: 'mesh', paramsSchema: [] },
  })
  const source = { ...validOutput, id: 'source-mesh', sha256: 'c'.repeat(64) }
  const producer = capabilityFixture({
    id: 'mesh-tools/create-mesh',
    extension: { id: 'mesh-tools', name: 'Mesh Tools', version: '1.0.0' },
    node: { id: 'create-mesh', input: 'text', output: 'mesh', paramsSchema: [] },
  })
  let verificationStarted!: () => void
  const didStartVerification = new Promise<void>((resolve) => { verificationStarted = resolve })
  let releaseVerification!: () => void
  const verificationBarrier = new Promise<void>((resolve) => { releaseVerification = resolve })
  let executions = 0
  let sourceCompleted = false
  let nextId = 0
  const service = new AgentActionsService({
    createActionId: () => `action-cancel-before-executor-${++nextId}`,
    resolveCapabilities: async () => ({ capabilities: [producer, capability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    artifactVerifier: {
      async verify(candidate) {
        if (candidate.id === source.id && sourceCompleted) {
          verificationStarted()
          await verificationBarrier
        }
        return candidate
      },
    },
    executor: async (request) => {
      if (request.capability.id === producer.id) return { artifacts: [source] }
      executions += 1
      return { artifacts: [validOutput] }
    },
  })
  const produced = await service.propose({
    originSessionId: 'test-session', capabilityId: producer.id, capabilityHash: producer.hash,
    arguments: { input: 'mesh', params: {} }, model: selectedModel,
  })
  await service.decide({ actionId: produced.id, originSessionId: 'test-session', decision: 'approve' })
  await service.execute({ actionId: produced.id, originSessionId: 'test-session' })
  sourceCompleted = true
  const action = await service.propose({
    originSessionId: 'test-session',
    capabilityId: capability.id,
    capabilityHash: capability.hash,
    arguments: { input: publicArtifactSelection(source), params: {} },
    model: selectedModel,
  })
  await service.decide({ actionId: action.id, originSessionId: 'test-session', decision: 'approve' })
  const running = service.execute({ actionId: action.id, originSessionId: 'test-session' })
  await didStartVerification
  assert.equal((await service.cancel({ actionId: action.id, originSessionId: 'test-session' })).status, 'cancelled')
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
    originSessionId: 'test-session',
    capabilityId: capability.id,
    capabilityHash: capability.hash,
    arguments: { input: 'chair', params: {} },
    model: selectedModel,
  })
  await service.decide({ actionId: action.id, originSessionId: 'test-session', decision: 'approve' })
  const running = service.execute({ actionId: action.id, originSessionId: 'test-session' })
  await didStartOutputVerification
  const cancelling = service.cancel({ actionId: action.id, originSessionId: 'test-session' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  releaseOutputVerification()
  assert.equal((await cancelling).status, 'cancelled')
  assert.equal((await running).status, 'cancelled')
  assert.equal((await service.get({ actionId: action.id, originSessionId: 'test-session' })).status, 'cancelled')
})

test('transactional executor output is rolled back before post-publication verification failure becomes terminal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modly-agent-rollback-failure-'))
  const published = join(root, 'published.glb')
  const capability = capabilityFixture()
  const service = new AgentActionsService({
    createActionId: () => 'action-rollback-failure',
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    artifactVerifier: { async verify() { throw new Error('authoritative verification failed') } },
    executor: async () => {
      await writeFile(published, 'published bytes')
      return {
        artifacts: [validOutput],
        rollback: async () => { await rm(published, { force: true }) },
      }
    },
  })
  try {
    const action = await service.propose({
    originSessionId: 'test-session',
      capabilityId: capability.id,
    capabilityHash: capability.hash,
      arguments: { input: 'chair', params: {} },
      model: selectedModel,
    })
    await service.decide({ actionId: action.id, originSessionId: 'test-session', decision: 'approve' })
    await rejectsCode(service.execute({ actionId: action.id, originSessionId: 'test-session' }), 'invalid_artifact')
    await assert.rejects(readFile(published), { code: 'ENOENT' })
    assert.equal((await service.get({ actionId: action.id, originSessionId: 'test-session' })).status, 'failed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cancellation after executor publication awaits rollback before exposing cancelled state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modly-agent-rollback-cancel-'))
  const published = join(root, 'published.glb')
  const capability = capabilityFixture()
  let verificationStarted!: () => void
  const didStartVerification = new Promise<void>((resolve) => { verificationStarted = resolve })
  let releaseVerification!: () => void
  const verificationBarrier = new Promise<void>((resolve) => { releaseVerification = resolve })
  const service = new AgentActionsService({
    createActionId: () => 'action-rollback-cancel',
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    artifactVerifier: {
      async verify(candidate) {
        verificationStarted()
        await verificationBarrier
        return candidate
      },
    },
    executor: async () => {
      await writeFile(published, 'published bytes')
      return {
        artifacts: [validOutput],
        rollback: async () => { await rm(published, { force: true }) },
      }
    },
  })
  try {
    const action = await service.propose({
    originSessionId: 'test-session',
      capabilityId: capability.id,
    capabilityHash: capability.hash,
      arguments: { input: 'chair', params: {} },
      model: selectedModel,
    })
    await service.decide({ actionId: action.id, originSessionId: 'test-session', decision: 'approve' })
    const running = service.execute({ actionId: action.id, originSessionId: 'test-session' })
    await didStartVerification
    const cancelling = service.cancel({ actionId: action.id, originSessionId: 'test-session' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(await readFile(published, 'utf8'), 'published bytes')
    releaseVerification()
    const cancelled = await cancelling
    assert.equal(cancelled.status, 'cancelled')
    await assert.rejects(readFile(published), { code: 'ENOENT' })
    assert.equal((await running).status, 'cancelled')
  } finally {
    releaseVerification?.()
    await rm(root, { recursive: true, force: true })
  }
})

test('cancellation between atomic publication and executor handoff waits for registered rollback cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modly-agent-rollback-handoff-'))
  const published = join(root, 'published.glb')
  const capability = capabilityFixture()
  let publishedReady!: () => void
  const didPublish = new Promise<void>((resolve) => { publishedReady = resolve })
  let releaseHandoff!: () => void
  const handoffBarrier = new Promise<void>((resolve) => { releaseHandoff = resolve })
  const service = new AgentActionsService({
    createActionId: () => 'action-rollback-handoff',
    cancellationSettlementTimeoutMs: 1_000,
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    artifactVerifier: passThroughArtifactVerifier,
    executor: async () => {
      await writeFile(published, 'published bytes')
      publishedReady()
      await handoffBarrier
      return {
        artifacts: [validOutput],
        rollback: async () => { await rm(published, { force: true }) },
      }
    },
  })
  try {
    const action = await service.propose({
    originSessionId: 'test-session',
      capabilityId: capability.id,
    capabilityHash: capability.hash,
      arguments: { input: 'chair', params: {} },
      model: selectedModel,
    })
    await service.decide({ actionId: action.id, originSessionId: 'test-session', decision: 'approve' })
    const running = service.execute({ actionId: action.id, originSessionId: 'test-session' })
    await didPublish
    let cancelSettled = false
    const cancelling = service.cancel({ actionId: action.id, originSessionId: 'test-session' }).finally(() => { cancelSettled = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(cancelSettled, false)
    assert.equal(await readFile(published, 'utf8'), 'published bytes')
    releaseHandoff()
    assert.equal((await cancelling).status, 'cancelled')
    await assert.rejects(readFile(published), { code: 'ENOENT' })
    assert.equal((await running).status, 'cancelled')
  } finally {
    releaseHandoff?.()
    await rm(root, { recursive: true, force: true })
  }
})

test('cancellation timeout stays non-terminal when an executor ignores abort and replay shares settlement', async () => {
  const capability = capabilityFixture()
  let executorStarted!: () => void
  const didStartExecutor = new Promise<void>((resolve) => { executorStarted = resolve })
  let releaseExecutor!: () => void
  const executorBarrier = new Promise<void>((resolve) => { releaseExecutor = resolve })
  const service = new AgentActionsService({
    createActionId: () => 'action-cancel-pending',
    cancellationSettlementTimeoutMs: 20,
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
    artifactVerifier: passThroughArtifactVerifier,
    executor: async () => {
      executorStarted()
      await executorBarrier
      throw new Error('executor eventually settled after ignoring abort')
    },
  })
  const action = await service.propose({
    originSessionId: 'test-session',
    capabilityId: capability.id,
    capabilityHash: capability.hash,
    arguments: { input: 'chair', params: {} },
    model: selectedModel,
  })
  await service.decide({ actionId: action.id, originSessionId: 'test-session', decision: 'approve' })
  const running = service.execute({ actionId: action.id, originSessionId: 'test-session' })
  await didStartExecutor
  await rejectsCode(service.cancel({ actionId: action.id, originSessionId: 'test-session' }), 'cancellation_pending')
  assert.equal((await service.get({ actionId: action.id, originSessionId: 'test-session' })).status, 'executing')
  await rejectsCode(service.cancel({ actionId: action.id, originSessionId: 'test-session' }), 'cancellation_pending')
  assert.equal((await service.get({ actionId: action.id, originSessionId: 'test-session' })).status, 'executing')
  releaseExecutor()
  assert.equal((await running).status, 'cancelled')
  assert.equal((await service.get({ actionId: action.id, originSessionId: 'test-session' })).status, 'cancelled')
})

test('input artifact mutation is detected immediately before start and never reaches the executor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modly-agent-input-revalidation-'))
  const workflows = join(root, 'Workflows')
  const original = Buffer.from('original mesh')
  await mkdir(workflows, { recursive: true })
  await writeFile(join(workflows, 'source.glb'), original)
  const producer = cadProcessCapability({
    id: 'mesh-tools/create-mesh', input: 'text', output: 'mesh', outputs: ['mesh'],
    allowed: [{ kind: 'mesh', mediaTypes: ['model/gltf-binary'], maxBytes: 4096 }],
  })
  const capability = cadProcessCapability({
    id: 'mesh-tools/optimize', input: 'mesh', output: 'mesh', outputs: ['mesh'],
    allowed: [{ kind: 'mesh', mediaTypes: ['model/gltf-binary'], maxBytes: 4096 }],
  })
  const source: ArtifactRefV1 = {
    ...validOutput,
    id: 'source-before-mutation',
    workspacePath: 'Workflows/source.glb',
    sha256: createHash('sha256').update(original).digest('hex'),
    sizeBytes: original.byteLength,
  }
  let executions = 0
  let modelResolverCalls = 0
  let nextId = 0
  const service = new AgentActionsService({
    createActionId: () => `action-mutated-input-${++nextId}`,
    resolveCapabilities: async () => ({ capabilities: [producer, capability], errors: [] }),
    resolveCurrentModel: async () => {
      modelResolverCalls += 1
      throw new Error('model-free execution must not resolve a provider model')
    },
    artifactVerifier: new WorkspaceAgentArtifactVerifier({ getWorkspaceRoot: () => root }),
    executor: async (request) => {
      if (request.capability.id === producer.id) return { artifacts: [source] }
      executions += 1
      return { artifacts: [validOutput] }
    },
  })
  try {
    const produced = await service.propose({
      originSessionId: 'test-session', capabilityId: producer.id, capabilityHash: producer.hash,
      arguments: { input: 'mesh', params: {} }, model: selectedModel,
    })
    await service.decide({ actionId: produced.id, originSessionId: 'test-session', decision: 'approve' })
    await service.execute({ actionId: produced.id, originSessionId: 'test-session' })
    const action = await service.propose({
    originSessionId: 'test-session',
      capabilityId: capability.id,
    capabilityHash: capability.hash,
      arguments: { input: publicArtifactSelection(source), params: {} },
      model: selectedModel,
    })
    await service.decide({ actionId: action.id, originSessionId: 'test-session', decision: 'approve' })
    await writeFile(join(workflows, 'source.glb'), Buffer.from('mutated mesh!'))
    await rejectsCode(service.execute({ actionId: action.id, originSessionId: 'test-session' }), 'invalid_artifact')
    assert.equal(executions, 0)
    assert.equal(modelResolverCalls, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('every action read and mutation is authorized by the immutable origin session in main', async () => {
  const capability = capabilityFixture()
  const service = new AgentActionsService({
    createActionId: () => 'session-owned-action',
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
  })
  const action = await service.propose({
    originSessionId: 'session-a',
    capabilityId: capability.id,
    capabilityHash: capability.hash,
    arguments: { input: 'chair', params: {} },
    model: selectedModel,
  } as never)

  await rejectsCode(service.get({ actionId: action.id, originSessionId: 'session-b' }), 'action_not_found')
  await rejectsCode(service.decide({ actionId: action.id, originSessionId: 'session-b', decision: 'reject' } as never), 'action_not_found')
  await service.decide({ actionId: action.id, originSessionId: 'session-a', decision: 'approve' } as never)
  await rejectsCode(service.execute({ actionId: action.id, originSessionId: 'session-b' } as never), 'action_not_found')
  await rejectsCode(service.cancel({ actionId: action.id, originSessionId: 'session-b' } as never), 'action_not_found')
  assert.equal((await service.get({ actionId: action.id, originSessionId: 'session-a' })).status, 'approved')

  await rejectsCode(service.get({ actionId: action.id } as never), 'invalid_request')
  await rejectsCode(service.decide({ actionId: action.id, decision: 'reject' } as never), 'invalid_request')
  await rejectsCode(service.execute({ actionId: action.id } as never), 'invalid_request')
  await rejectsCode(service.cancel({ actionId: action.id } as never), 'invalid_request')
})

test('proposal compares the capability hash seen by the model before creating an action', async () => {
  const capability = capabilityFixture()
  const service = new AgentActionsService({
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
  })

  await rejectsCode(service.propose({
    originSessionId: 'session-a',
    capabilityId: capability.id,
    capabilityHash: 'f'.repeat(64),
    arguments: { input: 'chair', params: {} },
    model: selectedModel,
  } as never), 'capability_stale')
  await rejectsCode(service.propose({
    originSessionId: 'session-a', capabilityId: capability.id,
    arguments: { input: 'chair', params: {} }, model: selectedModel,
  } as never), 'invalid_request')
  await rejectsCode(service.propose({
    capabilityId: capability.id, capabilityHash: capability.hash,
    arguments: { input: 'chair', params: {} }, model: selectedModel,
  } as never), 'invalid_request')
  assert.deepEqual(await service.list({ originSessionId: 'session-a' }), [])
})

test('MCP proposal validation is strict and its approval preview includes every executable nested argument', async () => {
  const scalarProperties = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [
    `field_${String(index + 1).padStart(2, '0')}`,
    { type: 'string', maxLength: 80 },
  ]))
  const inputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...scalarProperties,
      nested: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bearer: { type: 'string', maxLength: 200 },
          github: { type: 'string', maxLength: 200 },
          aws: { type: 'string', maxLength: 200 },
          jwt: { type: 'string', maxLength: 400 },
          pem: { type: 'string', maxLength: 400 },
        },
        required: ['bearer', 'github', 'aws', 'jwt', 'pem'],
      },
      items: {
        type: 'array',
        maxItems: 2,
        items: { type: 'string', maxLength: 80 },
      },
      exact_text: { type: 'string', maxLength: 200 },
      null_value: { type: 'null' },
    },
    required: [...Object.keys(scalarProperties), 'nested', 'items', 'exact_text', 'null_value'],
  }
  const capability = capabilityFixture({
    id: 'mcp-tools/preview-all',
    extension: { id: 'mcp-tools', name: 'MCP Tools', version: '1.0.0' },
    node: { id: 'preview-all', input: 'text', output: 'mesh', paramsSchema: [] },
    execution: {
      kind: 'mcp_tool', inputSchema, inputSchemaHash: sha256Canonical(inputSchema),
      mutating: true, bindingHash: 'e'.repeat(64),
    },
  })
  const service = new AgentActionsService({
    createActionId: () => 'mcp-preview-all',
    resolveCapabilities: async () => ({ capabilities: [capability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
  })
  const argumentsValue = {
    ...Object.fromEntries(Object.keys(scalarProperties).map((key) => [key, key])),
    nested: {
      bearer: 'Bearer abcdefghijklmnopqrstuvwxyz',
      github: 'github_pat_11AA22BB33CC44DD55',
      aws: 'AKIAIOSFODNN7EXAMPLE',
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature',
      pem: '-----BEGIN PRIVATE KEY----- secret -----END PRIVATE KEY-----',
    },
    items: ['first', 'second'],
    exact_text: 'line one\nline two',
    null_value: null,
  }
  const action = await service.propose({
    originSessionId: 'session-a', capabilityId: capability.id, capabilityHash: capability.hash,
    arguments: argumentsValue, model: selectedModel,
  } as never)

  assert.ok(action.preview.some((entry) => entry.label === 'field_13' && entry.value === 'field_13'))
  assert.ok(action.preview.some((entry) => entry.label === 'items[1]' && entry.value === 'second'))
  assert.deepEqual(action.preview.find((entry) => entry.label === 'exact_text'), {
    label: 'exact_text', value: 'line one\\nline two',
  })
  assert.deepEqual(action.preview.find((entry) => entry.label === 'null_value'), {
    label: 'null_value', value: 'null',
  })
  for (const label of ['nested.bearer', 'nested.github', 'nested.aws', 'nested.jwt', 'nested.pem']) {
    assert.deepEqual(action.preview.find((entry) => entry.label === label), { label, value: '[redacted]' })
  }

  await rejectsCode(service.propose({
    originSessionId: 'session-a', capabilityId: capability.id, capabilityHash: capability.hash,
    arguments: { ...argumentsValue, hidden: 'must never become approvable' }, model: selectedModel,
  } as never), 'invalid_arguments')

  const openSchema = { type: 'object', additionalProperties: true }
  const openCapability = capabilityFixture({
    id: 'mcp-tools/open-schema',
    extension: { id: 'mcp-tools', name: 'MCP Tools', version: '1.0.0' },
    node: { id: 'open-schema', input: 'text', output: 'mesh', paramsSchema: [] },
    execution: {
      kind: 'mcp_tool', inputSchema: openSchema, inputSchemaHash: sha256Canonical(openSchema),
      mutating: true, bindingHash: 'f'.repeat(64),
    },
  })
  const openService = new AgentActionsService({
    resolveCapabilities: async () => ({ capabilities: [openCapability], errors: [] }),
    resolveCurrentModel: async () => selectedModel,
  })
  await rejectsCode(openService.propose({
    originSessionId: 'session-a', capabilityId: openCapability.id, capabilityHash: openCapability.hash,
    arguments: { hidden: 'not governed by a closed schema' }, model: selectedModel,
  } as never), 'invalid_arguments')

  for (const [nodeId, unsafeSchema, unsafeArguments] of [
    [
      'pattern-schema',
      { type: 'object', additionalProperties: false, properties: {}, patternProperties: { '^x': { type: 'string', maxLength: 80 } } },
      { x_hidden: 'not declared as a fixed approval field' },
    ],
    [
      'unbounded-array',
      { type: 'object', additionalProperties: false, properties: { items: { type: 'array', items: { type: 'string', maxLength: 80 } } } },
      { items: ['unbounded'] },
    ],
    [
      'unbounded-string',
      { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
      { text: 'unbounded' },
    ],
    [
      'oversized-preview-string',
      { type: 'object', additionalProperties: false, properties: { text: { type: 'string', maxLength: 5_000 } } },
      { text: 'bounded by Ajv but too large for complete human approval' },
    ],
  ] as const) {
    const unsafeCapability = capabilityFixture({
      id: `mcp-tools/${nodeId}`,
      extension: { id: 'mcp-tools', name: 'MCP Tools', version: '1.0.0' },
      node: { id: nodeId, input: 'text', output: 'mesh', paramsSchema: [] },
      execution: {
        kind: 'mcp_tool', inputSchema: unsafeSchema as never, inputSchemaHash: sha256Canonical(unsafeSchema),
        mutating: true, bindingHash: 'a'.repeat(64),
      },
    })
    const unsafeService = new AgentActionsService({
      resolveCapabilities: async () => ({ capabilities: [unsafeCapability], errors: [] }),
      resolveCurrentModel: async () => selectedModel,
    })
    await rejectsCode(unsafeService.propose({
      originSessionId: 'session-a', capabilityId: unsafeCapability.id, capabilityHash: unsafeCapability.hash,
      arguments: unsafeArguments, model: selectedModel,
    } as never), 'invalid_arguments')
  }
})

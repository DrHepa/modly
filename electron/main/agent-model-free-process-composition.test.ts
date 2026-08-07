import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type {
  AgentCapabilitySnapshotV1,
  AgentOllamaModelSnapshotV1,
} from '../../src/shared/types/agentActions.ts'
import { registerAgentActionsIpcHandlers } from './agent-actions-ipc.ts'
import { AgentActionsService } from './agent-actions-service.ts'
import { WorkspaceAgentArtifactVerifier } from './agent-artifact-verifier.ts'
import { createAgentProcessExecutor } from './agent-process-executor.ts'
import { sha256Canonical } from './agent-trust-contracts.ts'
import { listAgentCapabilities } from './automation-capabilities.ts'

const processor = String.raw`
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const request = JSON.parse(await new Promise((resolve) => {
  let value = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => { value += chunk })
  process.stdin.on('end', () => resolve(value))
}))
const trusted = request.trustedContext
for (const forbidden of ['modelAccess', 'bearerToken', 'socketPath', 'responsesPath']) {
  if (forbidden in trusted) throw new Error('model or network authority was exposed')
}
if (trusted.model?.provider !== 'ollama' || trusted.model?.model !== 'qwen3.6:latest') {
  throw new Error('approval attribution is missing')
}
if (typeof trusted.proposalHash !== 'string' || trusted.proposalHash.length !== 64) {
  throw new Error('proposal binding is missing')
}
const body = Buffer.from('model-free:' + request.arguments.input)
await writeFile(join(trusted.dirs.output, 'result.txt'), body)
process.stdout.write(JSON.stringify({
  schema: 'modly.agent-process-result.v1',
  type: 'result',
  artifacts: [{
    path: 'result.txt', kind: 'text', mediaType: 'text/plain', sizeBytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
  }],
}) + '\n')
`

function modelAccessCapability(): AgentCapabilitySnapshotV1 {
  const runtimeFiles = [{
    path: 'processor.pyz', device: '1', inode: '2', uid: 1000, gid: 1000,
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
    treeDigest: '1'.repeat(64), sourceIdentityHash: '2'.repeat(64), entryCount: 8, logicalBytes: 4096,
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
    maxCount: 1, maxTotalBytes: 1024,
    allowed: [{ kind: 'text' as const, mediaTypes: ['text/plain'], maxBytes: 1024 }],
  }
  const execution = {
    kind: 'process' as const, schema: 'modly.agent-process-execution.v1' as const,
    entry: 'processor.pyz', runtimeFiles, resourceFiles, runtime, modelAccess, runtimeHash, artifacts,
    bindingHash: sha256Canonical({
      schema: 'modly.agent-process-execution.v1', entry: 'processor.pyz', runtimeHash, artifacts,
    }),
  }
  const unsigned = {
    schema: 'modly.agent-capability.v1' as const,
    version: 1 as const,
    id: 'model-tools/model-bound',
    displayName: 'Model-bound process',
    description: 'Requires governed local-model access.',
    extension: { id: 'model-tools', name: 'Model Tools', version: '1.0.0' },
    node: { id: 'model-bound', input: 'text' as const, output: 'text' as const, paramsSchema: [] },
    execution,
    approval: { required: true as const, scope: 'single_action' as const },
  }
  return { ...unsigned, hash: sha256Canonical(unsigned) }
}

test('opaque model lease composes through the real service and PROCESS executor without post-mint provider access', async (t) => {
  if (process.platform !== 'linux') return t.skip('Governed PROCESS v1 is Linux-only')
  const root = await mkdtemp(join(tmpdir(), 'modly-model-free-composition-'))
  const builtinDir = join(root, 'builtin')
  const userDir = join(root, 'extensions')
  const extensionDir = join(userDir, 'deterministic-tools')
  const workspaceDir = join(root, 'workspace')
  const privateTempRoot = join(root, 'private-agent-temp')
  await mkdir(builtinDir, { recursive: true })
  await mkdir(extensionDir, { recursive: true })
  await mkdir(workspaceDir, { recursive: true })
  await writeFile(join(extensionDir, 'processor.mjs'), processor)
  await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify({
    id: 'deterministic-tools', name: 'Deterministic Tools', version: '1.0.0',
    type: 'process', entry: 'processor.mjs',
    nodes: [{
      id: 'build-cad', name: 'Build CAD', input: 'text', output: 'text', params_schema: [],
      agent: {
        schema: 'modly.agent-capability-declaration.v1',
        capability_id: 'deterministic-tools/build-cad',
        display_name: 'Build CAD', description: 'Build a deterministic CAD plan.',
        approval: { required: true, scope: 'single_action' },
        process: {
          schema: 'modly.agent-process.v1', runtimeFiles: ['processor.mjs'], resourceFiles: [],
          artifacts: {
            maxCount: 1, maxTotalBytes: 1024,
            allowed: [{ kind: 'text', mediaTypes: ['text/plain'], maxBytes: 1024 }],
          },
        },
      },
    }],
  }))

  let service: AgentActionsService | undefined
  try {
    const inventory = await listAgentCapabilities({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
    assert.deepEqual(inventory.errors, [])
    assert.equal(inventory.capabilities.length, 1)
    const modelFreeCapability = inventory.capabilities[0]
    const modelBoundCapability = modelAccessCapability()
    const capabilities = [modelFreeCapability, modelBoundCapability]
    const model: AgentOllamaModelSnapshotV1 = {
      provider: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'qwen3.6:latest',
      digest: `sha256:${'a'.repeat(64)}`,
    }
    let providerAvailable = true
    let modelResolverCalls = 0
    const resolveModel = async (): Promise<AgentOllamaModelSnapshotV1> => {
      modelResolverCalls += 1
      if (!providerAvailable) throw new Error('provider unavailable after main minted the attribution lease')
      return model
    }
    const processExecutor = createAgentProcessExecutor({
      getWorkspaceRoot: () => workspaceDir,
      getPrivateTempRoot: () => privateTempRoot,
      resolveTarget: async (capabilityId) => {
        if (capabilityId !== modelFreeCapability.id) throw new Error('unexpected process target')
        return { capability: modelFreeCapability, extensionDir, entry: 'processor.mjs' }
      },
      resolveCurrentModel: resolveModel,
    })
    let processExecutions = 0
    const now = () => new Date('2026-08-07T12:00:00.000Z')
    service = new AgentActionsService({
      now,
      createActionId: () => 'action-composed-model-free',
      createLease: () => 'approval-lease-token-32bytes-long',
      resolveCapabilities: async () => ({ capabilities, errors: [] }),
      resolveCurrentModel: resolveModel,
      artifactVerifier: new WorkspaceAgentArtifactVerifier({ getWorkspaceRoot: () => workspaceDir }),
      executor: async (request) => {
        processExecutions += 1
        return processExecutor.execute(request)
      },
      ensureExecutorReady: processExecutor.ensureReady,
      isExecutorAvailable: () => true,
    })
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerAgentActionsIpcHandlers({
      handle(channel, handler) { handlers.set(channel, handler) },
    }, service, {
      now,
      createModelLeaseId: () => 'opaque-model-lease',
      resolveSelectedModel: resolveModel,
    })
    const leaseResult = await handlers.get('agentActions:leaseModel')?.({}, {
      originSessionId: 'session-composed',
      model: { provider: model.provider, endpoint: model.endpoint, model: model.model },
    }) as { ok: true, lease: { id: string } }
    assert.equal(leaseResult.ok, true)
    assert.equal(modelResolverCalls, 1)
    providerAvailable = false

    const proposal = await handlers.get('agentActions:propose')?.({}, {
      originSessionId: 'session-composed', capabilityId: modelFreeCapability.id,
      capabilityHash: modelFreeCapability.hash, arguments: { input: 'chair', params: {} },
      modelLeaseId: leaseResult.lease.id,
    }) as { ok: true, action: { id: string, status: string } }
    assert.equal(proposal.ok, true)
    assert.equal(proposal.action.status, 'proposed')
    const approved = await handlers.get('agentActions:decide')?.({}, {
      actionId: proposal.action.id, originSessionId: 'session-composed', decision: 'approve',
    }) as { ok: true, action: { status: string } }
    assert.equal(approved.ok, true)
    assert.equal(approved.action.status, 'approved')
    const completed = await handlers.get('agentActions:execute')?.({}, {
      actionId: proposal.action.id, originSessionId: 'session-composed',
    }) as { ok: true, action: { status: string } }
    assert.equal(completed.ok, true)
    assert.equal(completed.action.status, 'completed')
    assert.equal(modelResolverCalls, 1)
    assert.equal(processExecutions, 1)
    assert.equal(
      await readFile(join(workspaceDir, 'Workflows', 'agent-actions', proposal.action.id, 'result.txt'), 'utf8'),
      'model-free:chair',
    )

    const modelBound = await handlers.get('agentActions:propose')?.({}, {
      originSessionId: 'session-composed', capabilityId: modelBoundCapability.id,
      capabilityHash: modelBoundCapability.hash, arguments: { input: 'chair', params: {} },
      modelLeaseId: leaseResult.lease.id,
    })
    assert.deepEqual(modelBound, { ok: false, error: { code: 'model_stale' } })
    assert.equal(modelResolverCalls, 2)
    assert.equal(processExecutions, 1)
  } finally {
    await service?.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})

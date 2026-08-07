import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertAgentCapabilitySnapshotV1,
  assertAgentActionV1,
  assertArtifactRefV1,
  assertWorkspaceRelativePath,
  canonicalJson,
  createAgentActionProposal,
  requiresLiveProviderModelRevalidation,
  sha256Canonical,
  toAgentActionPublicSummary,
  transitionAgentAction,
} from './agent-trust-contracts.ts'
import type { AgentCapabilitySnapshotV1 } from '../../src/shared/types/agentActions.ts'

const capability: AgentCapabilitySnapshotV1 = {
  schema: 'modly.agent-capability.v1',
  version: 1,
  id: 'text-to-cad/generate',
  displayName: 'Text to CAD',
  description: 'Generate a CAD artifact from text.',
  extension: { id: 'text-to-cad', name: 'Text to CAD', version: '1.0.0' },
  node: {
    id: 'generate',
    input: 'text',
    output: 'mesh',
    paramsSchema: [{ id: 'quality', type: 'select', default: 'balanced' }],
  },
  approval: { required: true, scope: 'single_action' },
  hash: '',
}
capability.hash = hashCapability(capability)

const model = {
  provider: 'ollama' as const,
  endpoint: 'http://127.0.0.1:11434',
  model: 'qwen3.6:latest',
  digest: `sha256:${'a'.repeat(64)}`,
}

function hashCapability(value: AgentCapabilitySnapshotV1): string {
  const { hash: _hash, ...unsigned } = value
  return sha256Canonical(unsigned)
}

test('canonicalJson sorts object keys recursively and normalizes negative zero', () => {
  assert.equal(
    canonicalJson({ z: -0, a: { y: 2.5, x: 1 }, list: [{ b: true, a: null }] }),
    '{"a":{"x":1,"y":2.5},"list":[{"a":null,"b":true}],"z":0}',
  )
  assert.equal(sha256Canonical({ b: 2, a: 1 }), sha256Canonical({ a: 1, b: 2 }))
})

test('canonicalJson rejects non-JSON, ambiguous Unicode, pollution keys, and invalid numbers', () => {
  for (const value of [undefined, 1n, Symbol('x'), () => undefined, Number.NaN, Infinity, -Infinity]) {
    assert.throws(() => canonicalJson(value), /canonical JSON/i)
  }
  assert.throws(() => canonicalJson({ value: undefined }), /canonical JSON/i)
  assert.throws(() => canonicalJson({ value: new Date() }), /plain object/i)
  assert.throws(() => canonicalJson(Object.assign(Object.create({ inherited: true }), { own: true })), /plain object/i)
  assert.throws(() => canonicalJson(JSON.parse('{"__proto__":true}')), /unsafe object key/i)
  assert.throws(() => canonicalJson(Object.assign([1], { extra: true })), /extra enumerable/i)
  assert.throws(() => canonicalJson(new Array(1)), /sparse array/i)
  assert.throws(() => canonicalJson(Object.defineProperty({}, 'value', { enumerable: true, get: () => 'unsafe' })), /data property/i)
  assert.throws(() => canonicalJson({ [Symbol('hidden')]: true }), /symbol key/i)
  assert.throws(() => canonicalJson(Object.assign([1], { [Symbol('hidden')]: true })), /symbol key/i)
  assert.throws(() => canonicalJson({ value: '\ud800' }), /surrogate/i)
  assert.equal(canonicalJson({ value: 'CAD 🪑' }), '{"value":"CAD 🪑"}')
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.throws(() => canonicalJson(cyclic), /cyclic/i)
})

test('workspace paths are lexical, relative, normalized, and platform-independent', () => {
  assert.equal(assertWorkspaceRelativePath('Workflows/cad/chair.step'), 'Workflows/cad/chair.step')
  for (const path of [
    '', '.', '..', 'Workflows/../escape.glb', 'Workflows/./mesh.glb',
    '/tmp/mesh.glb', 'C:\\mesh.glb', 'C:/mesh.glb', '\\\\server\\share\\mesh.glb',
    '//server/share/mesh.glb', 'Workflows\\mesh.glb', 'Workflows//mesh.glb',
    'Workflows/file.glb:secret', 'Workflows/bad<name>.glb', 'Workflows/bad>name.glb',
    'Workflows/bad"name.glb', 'Workflows/bad|name.glb', 'Workflows/bad?name.glb',
    'Workflows/bad*name.glb', 'Workflows/trailing-dot./mesh.glb', 'Workflows/trailing-space /mesh.glb',
    'Workflows/CON/model.glb', 'Workflows/nul.txt', 'Workflows/COM1/model.glb', 'Workflows/lpt9.txt',
  ]) {
    assert.throws(() => assertWorkspaceRelativePath(path), /workspace-relative path/i, path)
  }
})

test('ArtifactRef v1 validates hashes, sizes, media kinds, exact keys, and workspace paths', () => {
  const artifact = assertArtifactRefV1({
    schema: 'modly.artifact-ref.v1',
    version: 1,
    id: 'artifact-1',
    kind: 'mesh',
    mediaType: 'model/gltf-binary',
    workspacePath: 'Workflows/cad/chair.glb',
    sha256: 'b'.repeat(64),
    sizeBytes: 123,
  })
  assert.equal(artifact.workspacePath, 'Workflows/cad/chair.glb')

  assert.throws(() => assertArtifactRefV1({ ...artifact, workspacePath: '../chair.glb' }), /workspace-relative path/i)
  assert.throws(() => assertArtifactRefV1({ ...artifact, sha256: 'bad' }), /sha256/i)
  assert.throws(() => assertArtifactRefV1({ ...artifact, sizeBytes: -1 }), /sizeBytes/i)
  assert.throws(() => assertArtifactRefV1({ ...artifact, unexpected: true }), /unknown field/i)
})

test('extension Python runtime and model access bindings are exact and transitively hash-bound', () => {
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
  const runtimeFiles = [{
    path: 'processor.pyz', device: '1', inode: '2', uid: 1000, gid: 1000,
    mode: 0o600, size: 128, mtimeNs: '3', sha256: '3'.repeat(64),
  }]
  const resourceFiles: never[] = []
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
  const execution = {
    kind: 'process' as const,
    schema: 'modly.agent-process-execution.v1' as const,
    entry: 'processor.pyz', runtimeFiles, resourceFiles, runtime, modelAccess, runtimeHash, artifacts,
    bindingHash: sha256Canonical({
      schema: 'modly.agent-process-execution.v1', entry: 'processor.pyz', runtimeHash, artifacts,
    }),
  }
  const unsigned = {
    schema: 'modly.agent-capability.v1' as const,
    version: 1 as const,
    id: 'python-tools/run', displayName: 'Run Python', description: 'Run a Python zipapp.',
    extension: { id: 'python-tools', name: 'Python Tools' },
    node: { id: 'run', input: 'text' as const, output: 'text' as const, paramsSchema: [] },
    execution,
    approval: { required: true as const, scope: 'single_action' as const },
  }
  const snapshot = { ...unsigned, hash: sha256Canonical(unsigned) }
  assert.equal(assertAgentCapabilitySnapshotV1(snapshot).execution?.kind, 'process')
  assert.equal(requiresLiveProviderModelRevalidation(snapshot), true)

  const runtimeHashWithoutModelAccess = sha256Canonical({ runtimeFiles, resourceFiles, runtime })
  const executionWithoutModelAccess = {
    ...execution,
    modelAccess: undefined,
    runtimeHash: runtimeHashWithoutModelAccess,
    bindingHash: sha256Canonical({
      schema: 'modly.agent-process-execution.v1', entry: 'processor.pyz',
      runtimeHash: runtimeHashWithoutModelAccess, artifacts,
    }),
  }
  delete (executionWithoutModelAccess as { modelAccess?: unknown }).modelAccess
  const unsignedWithoutModelAccess = { ...unsigned, execution: executionWithoutModelAccess }
  const snapshotWithoutModelAccess = {
    ...unsignedWithoutModelAccess,
    hash: sha256Canonical(unsignedWithoutModelAccess),
  }
  assert.equal(assertAgentCapabilitySnapshotV1(snapshotWithoutModelAccess).execution?.kind, 'process')
  assert.equal(requiresLiveProviderModelRevalidation(snapshotWithoutModelAccess), false)
  assert.notEqual(snapshot.hash, snapshotWithoutModelAccess.hash)

  const withRuntime = (changedRuntime: Record<string, unknown>) => {
    const changedRuntimeHash = sha256Canonical({ runtimeFiles, resourceFiles, runtime: changedRuntime })
    const changedExecution = {
      ...execution,
      runtime: changedRuntime,
      runtimeHash: changedRuntimeHash,
      bindingHash: sha256Canonical({
        schema: 'modly.agent-process-execution.v1', entry: 'processor.pyz',
        runtimeHash: changedRuntimeHash, artifacts,
      }),
    }
    const changedUnsigned = { ...unsigned, execution: changedExecution }
    return { ...changedUnsigned, hash: sha256Canonical(changedUnsigned) }
  }
  assert.throws(() => assertAgentCapabilitySnapshotV1(withRuntime({ ...runtime, interpreter: '/usr/bin/python' })), /Python runtime/i)
  assert.throws(() => assertAgentCapabilitySnapshotV1(withRuntime({ ...runtime, unknown: true })), /unknown field/i)
  assert.throws(() => assertAgentCapabilitySnapshotV1(withRuntime({ ...runtime, treeDigest: '4'.repeat(64) })), /binding hash/i)
  assert.throws(
    () => requiresLiveProviderModelRevalidation({ ...snapshotWithoutModelAccess, hash: '0'.repeat(64) }),
    /capability hash/i,
  )
  assert.throws(() => assertAgentCapabilitySnapshotV1({
    ...snapshot,
    execution: { ...execution, modelAccess: { ...modelAccess, profile: 'unsupported' } },
  }), /modelAccess/i)
})

test('action hashes bind normalized arguments, capability, model, artifacts, scope, and expiry', () => {
  const base = createAgentActionProposal({
    id: 'action-1',
    capability,
    arguments: { prompt: 'chair', dimensions: { width: 40, depth: 42 } },
    model,
    inputArtifacts: [],
    approval: { scope: 'single_action', expiresAt: '2026-08-06T12:05:00.000Z' },
    createdAt: '2026-08-06T12:00:00.000Z',
  })
  const reordered = createAgentActionProposal({
    id: 'action-1',
    capability,
    arguments: { dimensions: { depth: 42, width: 40 }, prompt: 'chair' },
    model,
    inputArtifacts: [],
    approval: { scope: 'single_action', expiresAt: '2026-08-06T12:05:00.000Z' },
    createdAt: '2026-08-06T12:00:00.000Z',
  })
  assert.equal(base.argumentsHash, reordered.argumentsHash)
  assert.equal(base.proposalHash, reordered.proposalHash)

  const changedModel = createAgentActionProposal({
    id: 'action-1', capability, arguments: base.arguments,
    model: { ...model, model: 'qwen3.6:32b' }, inputArtifacts: [],
    approval: base.approval, createdAt: base.createdAt,
  })
  assert.notEqual(base.modelHash, changedModel.modelHash)
  assert.notEqual(base.proposalHash, changedModel.proposalHash)

  const changedCapability = { ...capability, description: 'Changed description', hash: '' }
  changedCapability.hash = hashCapability(changedCapability)
  const changedAction = createAgentActionProposal({
    id: 'action-1', capability: changedCapability, arguments: base.arguments,
    model, inputArtifacts: [], approval: base.approval, createdAt: base.createdAt,
  })
  assert.notEqual(capability.hash, changedCapability.hash)
  assert.notEqual(base.proposalHash, changedAction.proposalHash)
})

test('actions fail closed on tampering, expired approvals, and invalid lifecycle transitions', () => {
  const proposed = createAgentActionProposal({
    id: 'action-2', capability, arguments: { prompt: 'chair' }, model, inputArtifacts: [],
    approval: { scope: 'single_action', expiresAt: '2026-08-06T12:05:00.000Z' },
    createdAt: '2026-08-06T12:00:00.000Z',
  })
  assert.throws(() => assertAgentActionV1({ ...proposed, arguments: { prompt: 'table' } }), /arguments hash/i)
  assert.throws(() => assertAgentActionV1({ ...proposed, model: { ...model, endpoint: 'https://cloud.example' } }), /Ollama endpoint/i)
  assert.throws(() => assertAgentActionV1({ ...proposed, unknown: true }), /unknown field/i)

  const approved = transitionAgentAction(proposed, 'approved', '2026-08-06T12:01:00.000Z')
  const executing = transitionAgentAction(approved, 'executing', '2026-08-06T12:02:00.000Z')
  const completed = transitionAgentAction(executing, 'completed', '2026-08-06T12:03:00.000Z')
  assert.equal(completed.status, 'completed')
  assert.deepEqual(completed.history.map((event) => event.status), ['proposed', 'approved', 'executing', 'completed'])
  assert.equal(completed.proposalHash, proposed.proposalHash)
  assert.notEqual(completed.stateHash, proposed.stateHash)
  assert.throws(() => transitionAgentAction(completed, 'executing', '2026-08-06T12:04:00.000Z'), /transition/i)
  assert.throws(() => transitionAgentAction(proposed, 'executing', '2026-08-06T12:01:00.000Z'), /transition/i)
  assert.throws(() => transitionAgentAction(proposed, 'approved', '2026-08-06T12:06:00.000Z'), /expired/i)
  assert.equal(transitionAgentAction(proposed, 'expired', '2026-08-06T12:06:00.000Z').status, 'expired')
  assert.throws(() => assertAgentActionV1({ ...proposed, status: 'completed' }), /history|status/i)
  assert.throws(() => assertAgentActionV1({ ...completed, stateHash: '0'.repeat(64) }), /state hash/i)
  assert.throws(() => assertAgentActionV1({ ...completed, history: completed.history.slice().reverse() }), /history|sequence|transition/i)
  assert.throws(() => assertAgentActionV1(approved, '2026-08-06T12:06:00.000Z'), /expired/i)
})

test('execution must begin before approval expiry but may complete afterwards with state-bound outputs', () => {
  const artifact = assertArtifactRefV1({
    schema: 'modly.artifact-ref.v1', version: 1, id: 'mesh-output', kind: 'mesh',
    mediaType: 'model/gltf-binary', workspacePath: 'Workflows/cad/output.glb',
    sha256: 'd'.repeat(64), sizeBytes: 64,
  })
  const proposed = createAgentActionProposal({
    id: 'action-long-run', capability, arguments: { prompt: 'chair' }, model, inputArtifacts: [],
    approval: { scope: 'single_action', expiresAt: '2026-08-06T12:05:00.000Z' },
    createdAt: '2026-08-06T12:00:00.000Z',
  })
  const approved = transitionAgentAction(proposed, 'approved', '2026-08-06T12:01:00.000Z')
  assert.throws(() => transitionAgentAction(approved, 'executing', '2026-08-06T12:05:00.000Z'), /expired/i)
  const executing = transitionAgentAction(approved, 'executing', '2026-08-06T12:04:59.000Z')
  const completed = transitionAgentAction(executing, 'completed', '2026-08-06T12:30:00.000Z', { outputArtifacts: [artifact] })
  assert.deepEqual(completed.outputArtifacts, [artifact])
  assertAgentActionV1(completed, '2026-08-07T12:00:00.000Z')
  assert.throws(() => assertAgentActionV1({ ...completed, outputArtifacts: [{ ...artifact, sizeBytes: 65 }] }), /state hash|artifact/i)
})

test('Ollama model names accept conservative model syntax and reject URLs, tokens, queries, and whitespace', () => {
  for (const modelName of ['qwen3.6:latest', 'acme/qwen3.6:q4_K_M', 'registry.example/library/model-v2:tag']) {
    const action = createAgentActionProposal({
      id: `model-${sha256Canonical(modelName).slice(0, 8)}`, capability, arguments: {},
      model: { ...model, model: modelName }, inputArtifacts: [],
      approval: { scope: 'single_action', expiresAt: '2026-08-06T12:05:00.000Z' },
      createdAt: '2026-08-06T12:00:00.000Z',
    })
    assert.equal(action.model.model, modelName)
  }
  for (const modelName of ['http://host/model', '../model', 'model?token=secret', 'model#tag', 'model tag', 'model\nname', 'model@sha256:abc', 'Bearer secret']) {
    assert.throws(() => createAgentActionProposal({
      id: 'invalid-model', capability, arguments: {}, model: { ...model, model: modelName }, inputArtifacts: [],
      approval: { scope: 'single_action', expiresAt: '2026-08-06T12:05:00.000Z' },
      createdAt: '2026-08-06T12:00:00.000Z',
    }), /model/i, modelName)
  }
})

test('Agent parameter metadata rejects prototype-pollution identifiers', () => {
  for (const id of ['__proto__', 'prototype', 'constructor']) {
    const unsafe = {
      ...capability,
      node: { ...capability.node, paramsSchema: [{ id, type: 'string', default: '' }] },
      hash: '',
    }
    unsafe.hash = hashCapability(unsafe)
    assert.throws(() => createAgentActionProposal({
      id: `unsafe-${id.replaceAll('_', 'x')}`,
      capability: unsafe,
      arguments: {},
      model,
      inputArtifacts: [],
      approval: { scope: 'single_action', expiresAt: '2026-08-06T12:05:00.000Z' },
      createdAt: '2026-08-06T12:00:00.000Z',
    }), /parameter|paramsSchema|unsafe/i)
  }
})

test('public action summaries omit endpoints, arguments, workspace paths, and trust-boundary secrets', () => {
  const artifact = assertArtifactRefV1({
    schema: 'modly.artifact-ref.v1', version: 1, id: 'mesh-1', kind: 'mesh',
    mediaType: 'model/gltf-binary', workspacePath: 'Workflows/private/chair.glb',
    sha256: 'c'.repeat(64), sizeBytes: 42,
  })
  const action = createAgentActionProposal({
    id: 'action-public', capability, arguments: { privatePrompt: 'secret chair' }, model,
    inputArtifacts: [artifact], approval: { scope: 'single_action', expiresAt: '2026-08-06T12:05:00.000Z' },
    createdAt: '2026-08-06T12:00:00.000Z',
  })
  const approved = transitionAgentAction(action, 'approved', '2026-08-06T12:01:00.000Z')
  const executing = transitionAgentAction(approved, 'executing', '2026-08-06T12:02:00.000Z')
  const failed = transitionAgentAction(executing, 'failed', '2026-08-06T12:03:00.000Z', { errorSummary: 'Failed at /usr/bin/private-runner' })
  const summary = toAgentActionPublicSummary(failed)
  const serialized = JSON.stringify(summary)
  assert.equal(serialized.includes(model.endpoint), false)
  assert.equal(serialized.includes('secret chair'), false)
  assert.equal(serialized.includes(artifact.workspacePath), false)
  assert.equal(serialized.includes('/usr/bin/private-runner'), false)
  assert.equal('arguments' in summary, false)
  assert.equal('proposalHash' in summary, false)
  assert.equal('stateHash' in summary, false)
  assert.equal('history' in summary, false)
})

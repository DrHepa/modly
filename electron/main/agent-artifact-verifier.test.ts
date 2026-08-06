import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  AgentArtifactVerificationError,
  WorkspaceAgentArtifactVerifier,
} from './agent-artifact-verifier.ts'
import type { ArtifactRefV1 } from '../../src/shared/types/agentActions.ts'

function artifact(bytes: Buffer, overrides: Partial<ArtifactRefV1> = {}): ArtifactRefV1 {
  return {
    schema: 'modly.artifact-ref.v1',
    version: 1,
    id: 'artifact-1',
    kind: 'mesh',
    mediaType: 'model/gltf-binary',
    workspacePath: 'Workflows/source.glb',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.byteLength,
    ...overrides,
  }
}

async function rejectsVerification(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AgentArtifactVerificationError)
    assert.equal(error.code, code)
    return true
  })
}

test('workspace verifier canonicalizes a regular file and recomputes size and SHA-256', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modly-agent-artifacts-'))
  const bytes = Buffer.from('verified mesh')
  await mkdir(join(root, 'Workflows'), { recursive: true })
  await writeFile(join(root, 'Workflows/source.glb'), bytes)
  try {
    const verifier = new WorkspaceAgentArtifactVerifier({ getWorkspaceRoot: () => root })
    assert.deepEqual(await verifier.verify(artifact(bytes), 'mesh', new AbortController().signal), artifact(bytes))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('workspace verifier rejects mutation, missing files, symlinks, and digest mismatches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modly-agent-artifacts-adversarial-'))
  const workflows = join(root, 'Workflows')
  const original = Buffer.from('original')
  await mkdir(workflows, { recursive: true })
  await writeFile(join(workflows, 'source.glb'), original)
  const verifier = new WorkspaceAgentArtifactVerifier({ getWorkspaceRoot: () => root })
  try {
    await writeFile(join(workflows, 'source.glb'), Buffer.from('mutated!'))
    await rejectsVerification(verifier.verify(artifact(original), 'mesh', new AbortController().signal), 'artifact_mismatch')

    await rejectsVerification(verifier.verify(artifact(original, { workspacePath: 'Workflows/missing.glb' }), 'mesh', new AbortController().signal), 'artifact_missing')

    await writeFile(join(workflows, 'real.glb'), original)
    await symlink(join(workflows, 'real.glb'), join(workflows, 'linked.glb'))
    await rejectsVerification(verifier.verify(artifact(original, { workspacePath: 'Workflows/linked.glb' }), 'mesh', new AbortController().signal), 'artifact_symlink')

    await rejectsVerification(verifier.verify(artifact(original, { workspacePath: 'Workflows/real.glb', sha256: 'f'.repeat(64) }), 'mesh', new AbortController().signal), 'artifact_mismatch')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

import type { ArtifactRef, ArtifactSubstitutionPoint } from '../../../shared/types/electron.d.ts'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const waitNodeEntry = path.join(projectRoot, 'src/areas/workflows/nodes/WaitNode.tsx')

async function loadWaitNodeModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-wait-node-'))
  const outfile = path.join(tempDir, 'WaitNode.bundle.mjs')

  await build({
    entryPoints: [waitNodeEntry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    external: ['react', 'react/jsx-runtime', '@xyflow/react', 'zustand', 'axios'],
  })

  const module = await import(pathToFileURL(outfile).href)

  return {
    module,
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

const originalMesh: ArtifactRef = {
  id: 'artifact-original-mesh',
  kind: 'mesh',
  uri: '/workspace/models/original.glb',
  versionId: 'artifact-original-mesh-v1',
  legacy: { filePath: '/workspace/models/original.glb', outputType: 'mesh' },
}

const validMeshReplacement: ArtifactRef = {
  id: 'artifact-replacement-mesh',
  kind: 'mesh',
  uri: '/workspace/models/replacement.glb',
  versionId: 'artifact-replacement-mesh-v1',
  legacy: { filePath: '/workspace/models/replacement.glb', outputType: 'mesh' },
}

const invalidImageReplacement: ArtifactRef = {
  id: 'artifact-replacement-image',
  kind: 'image',
  uri: '/workspace/images/replacement.png',
  versionId: 'artifact-replacement-image-v1',
  legacy: { filePath: '/workspace/images/replacement.png', outputType: 'image' },
}

const substitutionPoint: ArtifactSubstitutionPoint = {
  kind: 'artifact_substitution',
  nodeId: 'wait-1',
  inputArtifactId: originalMesh.id,
  inputArtifact: originalMesh,
  allowedKinds: ['mesh'],
  status: 'declared',
  interaction: {
    boundary: 'ui_only',
    headless: false,
    editor: 'none',
    continueMode: 'manual',
  },
}

test('wait checkpoint UI state labels paused artifact as temporary and not final output', async () => {
  const { module, cleanup } = await loadWaitNodeModule()

  try {
    const state = module.resolveWaitCheckpointUiState({
      nodeId: 'wait-1',
      activeNodeId: 'wait-1',
      runState: {
        status: 'paused',
        blockIndex: 0,
        blockTotal: 1,
        blockProgress: 100,
        blockStep: 'Paused — click Continue',
        artifact: originalMesh,
        substitutionPoint,
      },
    })

    assert.equal(state.isPaused, true)
    assert.equal(state.isCheckpoint, true)
    assert.equal(state.statusLabel, 'Temporary checkpoint')
    assert.match(state.description, /not the final output/i)
    assert.equal(state.normalContinueLabel, 'Continue')
  } finally {
    await cleanup()
  }
})

test('legacy wait UI state stays non-invasive when no checkpoint metadata exists', async () => {
  const { module, cleanup } = await loadWaitNodeModule()

  try {
    const state = module.resolveWaitCheckpointUiState({
      nodeId: 'wait-legacy',
      activeNodeId: 'wait-legacy',
      runState: {
        status: 'paused',
        blockIndex: 0,
        blockTotal: 1,
        blockProgress: 0,
        blockStep: 'Paused — click Continue',
      },
    })

    assert.equal(state.isPaused, true)
    assert.equal(state.isCheckpoint, false)
    assert.equal(state.showSubstitutedContinue, false)
    assert.equal(state.statusLabel, 'Paused')
    assert.match(state.description, /click Continue to resume/i)
    assert.doesNotMatch(state.description, /checkpoint/i)
  } finally {
    await cleanup()
  }
})

test('substituted continue is visible only for a valid pending replacement', async () => {
  const { module, cleanup } = await loadWaitNodeModule()

  try {
    const withValidReplacement = module.resolveWaitCheckpointUiState({
      nodeId: 'wait-1',
      activeNodeId: 'wait-1',
      runState: {
        status: 'paused',
        blockIndex: 0,
        blockTotal: 1,
        blockProgress: 100,
        blockStep: 'Paused — click Continue',
        artifact: originalMesh,
        substitutionPoint,
      },
      pendingReplacement: validMeshReplacement,
    })

    assert.equal(withValidReplacement.showSubstitutedContinue, true)
    assert.equal(withValidReplacement.substitutedContinueLabel, 'Continue with replacement')

    const withInvalidReplacement = module.resolveWaitCheckpointUiState({
      nodeId: 'wait-1',
      activeNodeId: 'wait-1',
      runState: {
        status: 'paused',
        blockIndex: 0,
        blockTotal: 1,
        blockProgress: 100,
        blockStep: 'Paused — click Continue',
        artifact: originalMesh,
        substitutionPoint,
      },
      pendingReplacement: invalidImageReplacement,
    })

    assert.equal(withInvalidReplacement.showSubstitutedContinue, false)
    assert.equal(withInvalidReplacement.substitutedContinueLabel, undefined)
  } finally {
    await cleanup()
  }
})

test('replacement rejection reasons render clear bounded copy without leaking raw reason codes', async () => {
  const { module, cleanup } = await loadWaitNodeModule()

  try {
    const expectedCopyByReason = new Map([
      ['kind_not_allowed', 'Replacement not used: this checkpoint does not accept that artifact type.'],
      ['legacy_unavailable', 'Replacement not used: it cannot be passed to the next workflow step.'],
      ['stale_checkpoint', 'Replacement not used: this checkpoint is no longer active.'],
      ['no_replacement', 'No replacement selected; the original checkpoint artifact was used.'],
    ])

    for (const [reason, expectedCopy] of expectedCopyByReason) {
      const state = module.resolveWaitCheckpointUiState({
        nodeId: 'wait-1',
        activeNodeId: 'next-node',
        runState: {
          status: 'running',
          blockIndex: 1,
          blockTotal: 2,
          blockProgress: 50,
          blockStep: 'Running next step',
          replacementResult: reason === 'no_replacement'
            ? { status: 'noop', reason }
            : { status: 'rejected', reason },
        },
      })

      assert.equal(state.rejectionCopy, expectedCopy)
      assert.doesNotMatch(state.rejectionCopy, /kind_not_allowed|legacy_unavailable|stale_checkpoint|no_replacement/)
    }
  } finally {
    await cleanup()
  }
})

test('humanoid Wait review state surfaces manual_confirmed continue copy without implying UniRig trust parity', async () => {
  const { module, cleanup } = await loadWaitNodeModule()

  try {
    const state = module.resolveWaitCheckpointUiState({
      nodeId: 'wait-1',
      activeNodeId: 'wait-1',
      runState: {
        status: 'paused',
        blockIndex: 0,
        blockTotal: 1,
        blockProgress: 100,
        blockStep: 'Paused — review humanoid handoff before Kimodo',
        artifact: originalMesh,
        substitutionPoint,
      },
      waitCheckpointReview: {
        status: 'manual_confirmed',
        headline: 'Manual humanoid promotion is ready for downstream Kimodo.',
        diagnostics: ['Promotion remains manual_confirmed only — it does NOT upgrade the mesh to UniRig semantic trust.'],
        meshWorkspacePath: 'models/original.glb',
        canPromote: true,
        canReview: true,
        continueLabel: 'Continue manual-confirmed',
        reviewHint: 'Promotion remains manual_confirmed only — it does NOT upgrade the mesh to UniRig semantic trust.',
        downstreamHumanoidStatus: 'manual_confirmed',
        promotionSidecarWorkspacePath: 'models/original.humanoid-promotion.v1.json',
      },
    })

    assert.equal(state.normalContinueLabel, 'Continue manual-confirmed')
    assert.equal(state.humanoidHeadline, 'Manual humanoid promotion is ready for downstream Kimodo.')
    assert.match(state.humanoidReviewHint ?? '', /manual_confirmed only/i)
    assert.match(state.humanoidDiagnostics.join('\n'), /does NOT upgrade the mesh to UniRig semantic trust/i)
  } finally {
    await cleanup()
  }
})

test('humanoid Wait review state keeps stale draft and promotion paths degraded', async () => {
  const { module, cleanup } = await loadWaitNodeModule()

  try {
    const state = module.resolveWaitCheckpointUiState({
      nodeId: 'wait-1',
      activeNodeId: 'wait-1',
      runState: {
        status: 'paused',
        blockIndex: 0,
        blockTotal: 1,
        blockProgress: 100,
        blockStep: 'Paused — review humanoid handoff before Kimodo',
        artifact: originalMesh,
        substitutionPoint,
      },
      waitCheckpointReview: {
        status: 'stale',
        headline: 'Humanoid draft or promotion is stale; downstream Kimodo will stay degraded.',
        diagnostics: ['mesh_output_sha256_mismatch', 'draft_sha256_mismatch'],
        meshWorkspacePath: 'models/original.glb',
        canPromote: false,
        canReview: true,
        continueLabel: 'Continue degraded',
        reviewHint: 'Regenerate the draft or write a fresh promotion before expecting manual_confirmed downstream use.',
      },
    })

    assert.equal(state.normalContinueLabel, 'Continue degraded')
    assert.equal(state.humanoidHeadline, 'Humanoid draft or promotion is stale; downstream Kimodo will stay degraded.')
    assert.match(state.humanoidDiagnostics.join('\n'), /mesh_output_sha256_mismatch/)
    assert.match(state.humanoidReviewHint ?? '', /fresh promotion/i)
  } finally {
    await cleanup()
  }
})

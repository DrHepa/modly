import assert from 'node:assert/strict'
import test from 'node:test'
import type { ArtifactLineage, ArtifactRef } from '../../shared/types/artifacts.ts'
import {
  artifactRefToLegacyOutput,
  buildEditedCheckpointArtifactRef,
  buildLandmarkSidecarLineageMetadata,
  buildWaitArtifactLineage,
  buildWaitReplacementArtifactRef,
  createArtifactLineage,
  createDeclaredArtifactSubstitution,
  createDeclaredArtifactSubstitutionPoint,
  deriveArtifactHistoryRows,
  legacyOutputToArtifactRef,
  replaceCurrentArtifactVersion,
  resolveArtifactReplacement,
} from './workflowArtifacts.ts'

test('legacyOutputToArtifactRef adapts mesh and image file outputs without dropping legacy fields', () => {
  const mesh = legacyOutputToArtifactRef(
    { filePath: '/workspace/output/model.glb', outputType: 'mesh' },
    { artifactId: 'artifact-mesh', versionId: 'version-mesh' },
  )
  const image = legacyOutputToArtifactRef(
    { filePath: '/workspace/output/preview.png', outputType: 'image' },
    { artifactId: 'artifact-image', versionId: 'version-image' },
  )

  assert.deepEqual(mesh, {
    id: 'artifact-mesh',
    kind: 'mesh',
    uri: '/workspace/output/model.glb',
    versionId: 'version-mesh',
    legacy: { filePath: '/workspace/output/model.glb', outputType: 'mesh' },
  })
  assert.deepEqual(image, {
    id: 'artifact-image',
    kind: 'image',
    uri: '/workspace/output/preview.png',
    versionId: 'version-image',
    legacy: { filePath: '/workspace/output/preview.png', outputType: 'image' },
  })
})

test('legacyOutputToArtifactRef adapts text outputs and ignores empty legacy outputs', () => {
  const text = legacyOutputToArtifactRef(
    { text: 'A small robot', outputType: 'text' },
    { artifactId: 'artifact-text', versionId: 'version-text' },
  )
  const empty = legacyOutputToArtifactRef({ outputType: 'mesh' }, { artifactId: 'unused' })

  assert.deepEqual(text, {
    id: 'artifact-text',
    kind: 'text',
    text: 'A small robot',
    versionId: 'version-text',
    legacy: { text: 'A small robot', outputType: 'text' },
  })
  assert.equal(empty, undefined)
})

test('artifactRefToLegacyOutput round-trips legacy file and text outputs', () => {
  const meshLegacy = { filePath: '/workspace/output/model.glb', outputType: 'mesh' as const }
  const textLegacy = { text: 'Describe this asset', outputType: 'text' as const }

  const meshArtifact = legacyOutputToArtifactRef(meshLegacy, { artifactId: 'mesh-a', versionId: 'mesh-v1' })
  const textArtifact = legacyOutputToArtifactRef(textLegacy, { artifactId: 'text-a', versionId: 'text-v1' })

  assert.deepEqual(artifactRefToLegacyOutput(meshArtifact), meshLegacy)
  assert.deepEqual(artifactRefToLegacyOutput(textArtifact), textLegacy)
})

test('artifactRefToLegacyOutput reconstructs legacy output when legacy payload is absent', () => {
  const ref: ArtifactRef = {
    id: 'artifact-image',
    kind: 'image',
    uri: '/workspace/output/generated.png',
    versionId: 'version-image',
  }

  assert.deepEqual(artifactRefToLegacyOutput(ref), {
    filePath: '/workspace/output/generated.png',
    outputType: 'image',
  })
})

test('lineage helpers preserve original and advance current to edited replacement', () => {
  const original = legacyOutputToArtifactRef(
    { filePath: '/workspace/original.glb', outputType: 'mesh' },
    { artifactId: 'asset-1', versionId: 'asset-1-original' },
  )
  const edited: ArtifactRef = {
    id: 'asset-1',
    kind: 'mesh',
    uri: '/workspace/edited.glb',
    versionId: 'asset-1-edited',
    legacy: { filePath: '/workspace/edited.glb', outputType: 'mesh' },
  }

  assert.ok(original)
  const lineage = createArtifactLineage(original, { createdAt: '2026-05-16T18:10:00.000Z' })
  const updated = replaceCurrentArtifactVersion(lineage, edited, { createdAt: '2026-05-16T18:11:00.000Z' })

  assert.equal(updated.artifactId, 'asset-1')
  assert.equal(updated.originalVersionId, 'asset-1-original')
  assert.equal(updated.currentVersionId, 'asset-1-edited')
  assert.deepEqual(
    updated.versions.map((version) => ({ id: version.id, role: version.role, parentVersionId: version.parentVersionId })),
    [
      { id: 'asset-1-original', role: 'original', parentVersionId: undefined },
      { id: 'asset-1-edited', role: 'edited', parentVersionId: 'asset-1-original' },
    ],
  )
  assert.deepEqual(artifactRefToLegacyOutput(updated.versions[0].ref), {
    filePath: '/workspace/original.glb',
    outputType: 'mesh',
  })
  assert.deepEqual(artifactRefToLegacyOutput(updated.versions[1].ref), {
    filePath: '/workspace/edited.glb',
    outputType: 'mesh',
  })
})

test('substitution helper declares replaceable artifact metadata without applying a replacement', () => {
  const substitution = createDeclaredArtifactSubstitution({
    nodeId: 'wait-node',
    inputArtifactId: 'asset-1',
    allowedKinds: ['mesh'],
  })

  assert.deepEqual(substitution, {
    nodeId: 'wait-node',
    inputArtifactId: 'asset-1',
    allowedKinds: ['mesh'],
    status: 'declared',
  })
})

test('substitution point helper declares UI-only replaceable artifact checkpoint without launching an editor', () => {
  const inputArtifact: ArtifactRef = {
    id: 'mesh-asset',
    kind: 'mesh',
    uri: '/workspace/meshes/original.glb',
    versionId: 'mesh-asset-original',
    legacy: { filePath: '/workspace/meshes/original.glb', outputType: 'mesh' },
  }

  const point = createDeclaredArtifactSubstitutionPoint({
    nodeId: 'wait-for-review',
    inputArtifact,
  })

  assert.deepEqual(point, {
    kind: 'artifact_substitution',
    nodeId: 'wait-for-review',
    inputArtifactId: 'mesh-asset',
    inputArtifact,
    allowedKinds: ['mesh'],
    status: 'declared',
    interaction: {
      boundary: 'ui_only',
      headless: false,
      editor: 'none',
      continueMode: 'manual',
    },
  })
})

test('resolveArtifactReplacement returns noop and preserves original passthrough when no replacement is supplied', () => {
  const original = meshArtifact('mesh-asset', '/workspace/meshes/original.glb', 'mesh-asset-original')
  const point = createDeclaredArtifactSubstitutionPoint({
    nodeId: 'wait-node',
    inputArtifact: original,
    allowedKinds: ['mesh'],
  })

  const result = resolveArtifactReplacement(point)

  assert.deepEqual(result, {
    status: 'noop',
    reason: 'no_replacement',
    artifact: original,
    legacy: { filePath: '/workspace/meshes/original.glb', outputType: 'mesh' },
  })
})

test('resolveArtifactReplacement accepts allowed legacy-convertible replacement without mutating checkpoint artifact', () => {
  const original = meshArtifact('mesh-asset', '/workspace/meshes/original.glb', 'mesh-asset-original')
  const replacement = meshArtifact('edited-mesh', '/workspace/meshes/edited.glb', 'edited-mesh-v1')
  const point = createDeclaredArtifactSubstitutionPoint({
    nodeId: 'wait-node',
    inputArtifact: original,
    allowedKinds: ['mesh'],
  })

  const result = resolveArtifactReplacement(point, replacement)

  assert.equal(result.status, 'accepted')
  assert.deepEqual(result.legacy, { filePath: '/workspace/meshes/edited.glb', outputType: 'mesh' })
  assert.deepEqual(result.artifact, replacement)
  assert.deepEqual(original.legacy, { filePath: '/workspace/meshes/original.glb', outputType: 'mesh' })
})

test('resolveArtifactReplacement rejects disallowed kind and preserves original passthrough', () => {
  const original = meshArtifact('mesh-asset', '/workspace/meshes/original.glb', 'mesh-asset-original')
  const replacement: ArtifactRef = {
    id: 'image-preview',
    kind: 'image',
    uri: '/workspace/preview.png',
    versionId: 'image-preview-v1',
    legacy: { filePath: '/workspace/preview.png', outputType: 'image' },
  }
  const point = createDeclaredArtifactSubstitutionPoint({
    nodeId: 'wait-node',
    inputArtifact: original,
    allowedKinds: ['mesh'],
  })

  assert.deepEqual(resolveArtifactReplacement(point, replacement), {
    status: 'rejected',
    reason: 'kind_not_allowed',
    artifact: original,
    legacy: { filePath: '/workspace/meshes/original.glb', outputType: 'mesh' },
  })
})

test('resolveArtifactReplacement rejects allowed replacement when legacy output is unavailable', () => {
  const original = meshArtifact('mesh-asset', '/workspace/meshes/original.glb', 'mesh-asset-original')
  const replacement: ArtifactRef = {
    id: 'mesh-without-output',
    kind: 'mesh',
    versionId: 'mesh-without-output-v1',
  }
  const point = createDeclaredArtifactSubstitutionPoint({
    nodeId: 'wait-node',
    inputArtifact: original,
    allowedKinds: ['mesh'],
  })

  assert.deepEqual(resolveArtifactReplacement(point, replacement), {
    status: 'rejected',
    reason: 'legacy_unavailable',
    artifact: original,
    legacy: { filePath: '/workspace/meshes/original.glb', outputType: 'mesh' },
  })
})

test('resolveArtifactReplacement rejects allowed mesh replacements with unusable legacy-only payloads', () => {
  const original = meshArtifact('mesh-asset', '/workspace/meshes/original.glb', 'mesh-asset-original')
  const point = createDeclaredArtifactSubstitutionPoint({
    nodeId: 'wait-node',
    inputArtifact: original,
    allowedKinds: ['mesh'],
  })
  const outputTypeOnly: ArtifactRef = {
    id: 'mesh-output-type-only',
    kind: 'mesh',
    versionId: 'mesh-output-type-only-v1',
    legacy: { outputType: 'mesh' },
  }
  const emptyLegacy: ArtifactRef = {
    id: 'mesh-empty-legacy',
    kind: 'mesh',
    versionId: 'mesh-empty-legacy-v1',
    legacy: {},
  }

  assert.deepEqual(resolveArtifactReplacement(point, outputTypeOnly), {
    status: 'rejected',
    reason: 'legacy_unavailable',
    artifact: original,
    legacy: { filePath: '/workspace/meshes/original.glb', outputType: 'mesh' },
  })
  assert.deepEqual(resolveArtifactReplacement(point, emptyLegacy), {
    status: 'rejected',
    reason: 'legacy_unavailable',
    artifact: original,
    legacy: { filePath: '/workspace/meshes/original.glb', outputType: 'mesh' },
  })
})

test('resolveArtifactReplacement rejects allowed text replacements when text payload is missing', () => {
  const original: ArtifactRef = {
    id: 'text-asset',
    kind: 'text',
    text: 'Original prompt',
    versionId: 'text-asset-original',
    legacy: { text: 'Original prompt', outputType: 'text' },
  }
  const replacement: ArtifactRef = {
    id: 'text-output-type-only',
    kind: 'text',
    versionId: 'text-output-type-only-v1',
    legacy: { outputType: 'text' },
  }
  const point = createDeclaredArtifactSubstitutionPoint({
    nodeId: 'wait-node',
    inputArtifact: original,
    allowedKinds: ['text'],
  })

  assert.deepEqual(resolveArtifactReplacement(point, replacement), {
    status: 'rejected',
    reason: 'legacy_unavailable',
    artifact: original,
    legacy: { text: 'Original prompt', outputType: 'text' },
  })
})

test('resolveArtifactReplacement rejects stale checkpoints before applying replacement', () => {
  const original = meshArtifact('mesh-asset', '/workspace/meshes/original.glb', 'mesh-asset-original')
  const replacement = meshArtifact('edited-mesh', '/workspace/meshes/edited.glb', 'edited-mesh-v1')
  const point = createDeclaredArtifactSubstitutionPoint({
    nodeId: 'wait-node',
    inputArtifact: original,
    allowedKinds: ['mesh'],
  })

  assert.deepEqual(resolveArtifactReplacement(point, replacement, { currentNodeId: 'other-wait-node' }), {
    status: 'rejected',
    reason: 'stale_checkpoint',
    artifact: original,
    legacy: { filePath: '/workspace/meshes/original.glb', outputType: 'mesh' },
  })
})

test('buildWaitReplacementArtifactRef keeps original artifact identity and replacement payload as edited current', () => {
  const original = meshArtifact('mesh-asset', '/workspace/meshes/original.glb', 'mesh-asset-original')
  const replacement = meshArtifact('edited-mesh', '/workspace/meshes/edited.glb', 'edited-mesh-v1')

  assert.deepEqual(buildWaitReplacementArtifactRef(original, replacement), {
    id: 'mesh-asset',
    kind: 'mesh',
    uri: '/workspace/meshes/edited.glb',
    versionId: 'mesh-asset-edited-mesh-v1',
    legacy: { filePath: '/workspace/meshes/edited.glb', outputType: 'mesh' },
  })
})

test('buildWaitArtifactLineage creates current original lineage and appends edited replacement lineage', () => {
  const original = meshArtifact('mesh-asset', '/workspace/meshes/original.glb', 'mesh-asset-original')
  const replacement = meshArtifact('edited-mesh', '/workspace/meshes/edited.glb', 'edited-mesh-v1')
  const edited = buildWaitReplacementArtifactRef(original, replacement)
  const existingLineage: ArtifactLineage = createArtifactLineage(original, { createdAt: '2026-05-16T18:10:00.000Z' })

  const created = buildWaitArtifactLineage(undefined, original, edited, { createdAt: '2026-05-16T18:11:00.000Z' })
  const updated = buildWaitArtifactLineage(existingLineage, original, edited, { createdAt: '2026-05-16T18:11:00.000Z' })

  const expectedVersions = [
    { id: 'mesh-asset-original', role: 'original', parentVersionId: undefined },
    { id: 'mesh-asset-edited-mesh-v1', role: 'edited', parentVersionId: 'mesh-asset-original' },
  ]

  assert.equal(created.currentVersionId, 'mesh-asset-edited-mesh-v1')
  assert.deepEqual(
    created.versions.map((version) => ({ id: version.id, role: version.role, parentVersionId: version.parentVersionId })),
    expectedVersions,
  )
  assert.deepEqual(
    updated.versions.map((version) => ({ id: version.id, role: version.role, parentVersionId: version.parentVersionId })),
    expectedVersions,
  )
})

test('buildEditedCheckpointArtifactRef creates edited mesh lineage intent without setting pending replacement', () => {
  const original = meshArtifact('mesh-asset', '/workspace/checkpoints/original.glb', 'mesh-asset-original')

  const result = buildEditedCheckpointArtifactRef(original, {
    workspacePath: 'Workflows/edited/original-edited.glb',
    sidecarWorkspacePath: 'Workflows/edited/original-edited.json',
    createdAt: '2026-05-17T15:00:00.000Z',
  })

  assert.deepEqual(result, {
    artifact: {
      id: 'mesh-asset',
      kind: 'mesh',
      uri: 'Workflows/edited/original-edited.glb',
      versionId: 'mesh-asset-edited-20260517T150000000Z',
      legacy: { filePath: 'Workflows/edited/original-edited.glb', outputType: 'mesh' },
    },
    lineageIntent: {
      type: 'edited-checkpoint-copy',
      sourceArtifactId: 'mesh-asset',
      sourceVersionId: 'mesh-asset-original',
      editedVersionId: 'mesh-asset-edited-20260517T150000000Z',
      sidecarWorkspacePath: 'Workflows/edited/original-edited.json',
      pendingReplacement: false,
    },
  })
})

test('deriveArtifactHistoryRows returns no rows for empty input and a safe legacy row for legacy node artifacts', () => {
  const legacyOnly = meshArtifact('legacy-mesh', '/workspace/legacy.glb', 'legacy-v1')

  assert.deepEqual(deriveArtifactHistoryRows({}), [])
  assert.deepEqual(deriveArtifactHistoryRows({ nodeArtifacts: { legacyNode: legacyOnly } }), [
    {
      kind: 'legacy-info',
      label: 'Artifact info',
      description: 'Artifact info: mesh at /workspace/legacy.glb (version legacy-v1).',
      artifact: legacyOnly,
      status: 'available',
    },
  ])
})

test('deriveArtifactHistoryRows shows the original checkpoint before any replacement state', () => {
  const original = meshArtifact('mesh-asset', '/workspace/checkpoints/original.glb', 'mesh-asset-original')
  const point = createDeclaredArtifactSubstitutionPoint({ nodeId: 'wait-node', inputArtifact: original })

  assert.deepEqual(deriveArtifactHistoryRows({ waitNodeId: 'wait-node', substitutionPoint: point }), [
    {
      kind: 'checkpoint-original',
      label: 'Temporary checkpoint',
      description: 'Starting artifact: mesh at /workspace/checkpoints/original.glb (version mesh-asset-original).',
      artifact: original,
      status: 'available',
    },
  ])
})

test('deriveArtifactHistoryRows shows a pending edited copy after the original checkpoint', () => {
  const original = meshArtifact('mesh-asset', '/workspace/checkpoints/original.glb', 'mesh-asset-original')
  const pending = meshArtifact('mesh-asset', '/workspace/checkpoints/original-edited.glb', 'mesh-asset-edited')

  const rows = deriveArtifactHistoryRows({
    waitNodeId: 'wait-node',
    nodeArtifacts: { 'wait-node': original },
    pendingReplacement: pending,
  })

  assert.deepEqual(rows.map((row) => row.kind), ['checkpoint-original', 'pending-edited-copy'])
  assert.deepEqual(rows[1], {
    kind: 'pending-edited-copy',
    label: 'Edited copy pending',
    description:
      'Edited copy: mesh at /workspace/checkpoints/original-edited.glb (version mesh-asset-edited). It will only be used if you continue with it.',
    artifact: pending,
    status: 'pending',
  })
})

test('deriveArtifactHistoryRows shows accepted replacement before final output', () => {
  const original = meshArtifact('mesh-asset', '/workspace/checkpoints/original.glb', 'mesh-asset-original')
  const replacement = meshArtifact('mesh-asset', '/workspace/checkpoints/replacement.glb', 'mesh-asset-replacement')
  const finalOutput = meshArtifact('final-mesh', '/workspace/output/final.glb', 'final-v1')

  const rows = deriveArtifactHistoryRows({
    substitutionPoint: createDeclaredArtifactSubstitutionPoint({ nodeId: 'wait-node', inputArtifact: original }),
    replacementResult: { status: 'accepted', artifact: replacement, legacy: { filePath: replacement.uri, outputType: 'mesh' } },
    runArtifact: finalOutput,
  })

  assert.deepEqual(rows.map((row) => row.kind), ['checkpoint-original', 'replacement-used', 'final-output'])
  assert.deepEqual(rows[1], {
    kind: 'replacement-used',
    label: 'Replacement used',
    description: 'Continue used the edited artifact: mesh at /workspace/checkpoints/replacement.glb (version mesh-asset-replacement).',
    artifact: replacement,
    status: 'used',
  })
  assert.deepEqual(rows[2], {
    kind: 'final-output',
    label: 'Final output',
    description: 'Current output: mesh at /workspace/output/final.glb (version final-v1).',
    artifact: finalOutput,
    status: 'available',
  })
})

test('deriveArtifactHistoryRows shows rejected and noop replacement decisions as original used', () => {
  const original = meshArtifact('mesh-asset', '/workspace/checkpoints/original.glb', 'mesh-asset-original')
  const replacement = meshArtifact('wrong-kind', '/workspace/preview.png', 'preview-v1')

  const rejectedRows = deriveArtifactHistoryRows({
    substitutionPoint: createDeclaredArtifactSubstitutionPoint({ nodeId: 'wait-node', inputArtifact: original }),
    replacementResult: { status: 'rejected', reason: 'kind_not_allowed', artifact: original, legacy: original.legacy },
  })
  const noopRows = deriveArtifactHistoryRows({
    substitutionPoint: createDeclaredArtifactSubstitutionPoint({ nodeId: 'wait-node', inputArtifact: original }),
    pendingReplacement: replacement,
    replacementResult: { status: 'noop', reason: 'no_replacement', artifact: original, legacy: original.legacy },
  })

  assert.deepEqual(rejectedRows.map((row) => row.kind), ['checkpoint-original', 'original-used'])
  assert.deepEqual(noopRows.map((row) => row.kind), ['checkpoint-original', 'pending-edited-copy', 'original-used'])
  assert.equal(rejectedRows[1].label, 'Original used')
  assert.equal(rejectedRows[1].description, 'Continue kept the original artifact: mesh at /workspace/checkpoints/original.glb (version mesh-asset-original). No replacement was applied.')
  assert.equal(noopRows[2].label, 'Original used')
  assert.equal(noopRows[2].status, 'skipped')
})

test('deriveArtifactHistoryRows degrades safely when artifact metadata is missing', () => {
  const minimal: ArtifactRef = { id: 'minimal-mesh', kind: 'mesh', versionId: 'minimal-v1' }

  assert.deepEqual(deriveArtifactHistoryRows({ waitNodeId: 'wait-node', nodeArtifacts: { 'wait-node': minimal } }), [
    {
      kind: 'checkpoint-original',
      label: 'Temporary checkpoint',
      description: 'Starting artifact: mesh (version minimal-v1).',
      artifact: minimal,
      status: 'available',
    },
  ])
})

test('deriveArtifactHistoryRows does not mutate input artifacts or lineage maps', () => {
  const original = meshArtifact('mesh-asset', '/workspace/checkpoints/original.glb', 'mesh-asset-original')
  const pending = meshArtifact('mesh-asset', '/workspace/checkpoints/original-edited.glb', 'mesh-asset-edited')
  const input = {
    waitNodeId: 'wait-node',
    nodeArtifacts: { 'wait-node': original },
    artifactLineages: { 'mesh-asset': createArtifactLineage(original, { createdAt: '2026-05-17T16:00:00.000Z' }) },
    pendingReplacement: pending,
  }
  const before = JSON.stringify(input)

  deriveArtifactHistoryRows(input)

  assert.equal(JSON.stringify(input), before)
})

test('buildLandmarkSidecarLineageMetadata describes the landmark sidecar without changing mesh legacy output', () => {
  const target = meshArtifact('mesh-asset', '/workspace/meshes/original.glb', 'mesh-asset-original')

  const metadata = buildLandmarkSidecarLineageMetadata({
    runId: 'workflow-landmarks-runtime',
    nodeId: 'landmarks-node',
    sidecarWorkspacePath: 'Workflows/landmarks/workflow-landmarks-runtime/landmarks-node.landmarks.v1.json',
    targetArtifact: target,
    targetMeshPath: '/workspace/meshes/original.glb',
  })

  assert.deepEqual(metadata, {
    sidecarRole: 'landmarks-sidecar',
    runId: 'workflow-landmarks-runtime',
    nodeId: 'landmarks-node',
    sidecarWorkspacePath: 'Workflows/landmarks/workflow-landmarks-runtime/landmarks-node.landmarks.v1.json',
    targetArtifactId: 'mesh-asset',
    targetVersionId: 'mesh-asset-original',
    targetMeshPath: '/workspace/meshes/original.glb',
    downstreamParam: 'landmarks_sidecar_path',
  })
  assert.deepEqual(target.legacy, { filePath: '/workspace/meshes/original.glb', outputType: 'mesh' })
})

test('deriveArtifactHistoryRows includes landmark sidecar history linked to the mesh checkpoint', () => {
  const target = meshArtifact('mesh-asset', '/workspace/meshes/original.glb', 'mesh-asset-original')
  const landmarkSidecar = buildLandmarkSidecarLineageMetadata({
    runId: 'workflow-landmarks-runtime',
    nodeId: 'landmarks-node',
    sidecarWorkspacePath: 'Workflows/landmarks/workflow-landmarks-runtime/landmarks-node.landmarks.v1.json',
    targetArtifact: target,
    targetMeshPath: '/workspace/meshes/original.glb',
  })

  const rows = deriveArtifactHistoryRows({
    waitNodeId: 'landmarks-node',
    nodeArtifacts: { 'landmarks-node': target },
    landmarkSidecar,
  })

  assert.deepEqual(rows.map((row) => row.kind), ['checkpoint-original', 'landmark-sidecar'])
  assert.deepEqual(rows[1], {
    kind: 'landmark-sidecar',
    label: 'Landmark sidecar',
    description:
      'Manual landmarks sidecar: Workflows/landmarks/workflow-landmarks-runtime/landmarks-node.landmarks.v1.json for mesh at /workspace/meshes/original.glb (version mesh-asset-original).',
    artifact: target,
    status: 'available',
  })
})

function meshArtifact(id: string, filePath: string, versionId: string): ArtifactRef {
  return {
    id,
    kind: 'mesh',
    uri: filePath,
    versionId,
    legacy: { filePath, outputType: 'mesh' },
  }
}

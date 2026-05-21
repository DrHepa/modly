import assert from 'node:assert/strict'
import test from 'node:test'

import type { ArtifactRef } from '../../shared/types/artifacts.ts'
import {
  REQUIRED_LANDMARK_IDS,
  buildLandmarkSidecarV1,
  buildLandmarksSidecarPath,
  createLandmarkCaptureIdentity,
  getMissingRequiredLandmarkIds,
  isLandmarkCaptureComplete,
  validateLandmarkSidecarV1,
} from './landmarks.ts'

const meshArtifact: ArtifactRef = {
  id: 'mesh-artifact-1',
  kind: 'mesh',
  uri: 'Meshes/rig-source.glb',
  versionId: 'mesh-version-1',
  legacy: { filePath: 'Meshes/rig-source.glb', outputType: 'mesh' },
}

const completeLandmarks = REQUIRED_LANDMARK_IDS.map((id, index) => ({
  id,
  name: id.replaceAll('_', ' '),
  world: { x: index + 0.1, y: index + 0.2, z: index + 0.3 },
  objectName: `mesh-surface-${index}`,
  confidence: 1 as const,
  source: 'manual' as const,
}))

test('exports exactly the required landmark ids in guided capture order', () => {
  assert.deepEqual(REQUIRED_LANDMARK_IDS, ['left_shoulder', 'right_shoulder', 'hip', 'left_knee', 'right_knee'])
})

test('reports missing required landmarks and gates completion until every required point exists', () => {
  const partial = completeLandmarks.slice(0, 3)

  assert.deepEqual(getMissingRequiredLandmarkIds(partial), ['left_knee', 'right_knee'])
  assert.equal(isLandmarkCaptureComplete(partial), false)
  assert.deepEqual(getMissingRequiredLandmarkIds(completeLandmarks), [])
  assert.equal(isLandmarkCaptureComplete(completeLandmarks), true)
})

test('validator rejects invalid manual landmark payloads with recoverable reasons', () => {
  const sidecar = buildLandmarkSidecarV1({
    runId: 'run-123',
    nodeId: 'node-abc',
    sidecarPath: 'Workflows/landmarks/run-123/node-abc/capture-001.landmarks.v1.json',
    targetArtifact: meshArtifact,
    meshPath: 'Meshes/rig-source.glb',
    createdAt: '2026-05-17T20:30:00.000Z',
    landmarks: completeLandmarks,
  })

  const invalid = {
    ...sidecar,
    landmarks: [
      ...completeLandmarks.slice(0, 4),
      { ...completeLandmarks[4], id: 'ankle', confidence: 0.5 },
    ],
  }

  assert.deepEqual(validateLandmarkSidecarV1(invalid), {
    valid: false,
    errors: [
      'missing_required_landmark:right_knee',
      'invalid_landmark_id:ankle',
      'invalid_landmark_confidence:ankle',
    ],
  })
})

test('builds the landmarks sidecar v1 shape without mutating the target mesh artifact', () => {
  const sidecar = buildLandmarkSidecarV1({
    runId: 'run-123',
    nodeId: 'node-abc',
    sidecarPath: 'Workflows/landmarks/run-123/node-abc/capture-001.landmarks.v1.json',
    targetArtifact: meshArtifact,
    meshPath: 'Meshes/rig-source.glb',
    createdAt: '2026-05-17T20:30:00.000Z',
    landmarks: completeLandmarks,
    lineage: { upstreamNodeId: 'mesh-node' },
  })

  assert.deepEqual(sidecar, {
    schema: 'modly.landmarks',
    version: 1,
    createdAt: '2026-05-17T20:30:00.000Z',
    runId: 'run-123',
    nodeId: 'node-abc',
    sidecarPath: 'Workflows/landmarks/run-123/node-abc/capture-001.landmarks.v1.json',
    target: {
      artifactId: 'mesh-artifact-1',
      versionId: 'mesh-version-1',
      kind: 'mesh',
      meshPath: 'Meshes/rig-source.glb',
      lineage: { upstreamNodeId: 'mesh-node' },
    },
    artifacts: {
      sidecarRole: 'landmarks-sidecar',
      targetArtifactId: 'mesh-artifact-1',
      targetVersionId: 'mesh-version-1',
    },
    landmarks: completeLandmarks,
  })
  assert.deepEqual(meshArtifact, {
    id: 'mesh-artifact-1',
    kind: 'mesh',
    uri: 'Meshes/rig-source.glb',
    versionId: 'mesh-version-1',
    legacy: { filePath: 'Meshes/rig-source.glb', outputType: 'mesh' },
  })
  assert.deepEqual(validateLandmarkSidecarV1(sidecar), { valid: true, errors: [] })
})

test('builds canonical workspace-relative sidecar paths and rejects unsafe run or node ids', () => {
  assert.equal(
    buildLandmarksSidecarPath('run-123', 'landmarks-node_1', 'capture-001'),
    'Workflows/landmarks/run-123/landmarks-node_1/capture-001.landmarks.v1.json',
  )

  assert.throws(() => buildLandmarksSidecarPath('../run-123', 'node-a', 'capture-001'), /Unsafe landmark sidecar id: workflowId/)
  assert.throws(() => buildLandmarksSidecarPath('/absolute-run', 'node-a', 'capture-001'), /Unsafe landmark sidecar id: workflowId/)
  assert.throws(() => buildLandmarksSidecarPath('run-123', 'nested/node', 'capture-001'), /Unsafe landmark sidecar id: nodeId/)
  assert.throws(() => buildLandmarksSidecarPath('run-123', 'node-a', '../capture'), /Unsafe landmark sidecar id: captureId/)
})

test('landmark sidecar validator accepts new capture paths and legacy v1 paths but rejects unsafe paths', () => {
  const captureSidecar = buildLandmarkSidecarV1({
    runId: 'run-123',
    nodeId: 'node-abc',
    sidecarPath: 'Workflows/landmarks/run-123/node-abc/capture-001.landmarks.v1.json',
    targetArtifact: meshArtifact,
    meshPath: 'Meshes/rig-source.glb',
    createdAt: '2026-05-17T20:30:00.000Z',
    landmarks: completeLandmarks,
  })
  const legacySidecar = {
    ...captureSidecar,
    sidecarPath: 'Workflows/landmarks/run-123/node-abc.landmarks.v1.json',
  }

  assert.deepEqual(validateLandmarkSidecarV1(captureSidecar), { valid: true, errors: [] })
  assert.deepEqual(validateLandmarkSidecarV1(legacySidecar), { valid: true, errors: [] })
  for (const unsafePath of [
    '/tmp/run-123/node-abc/capture-001.landmarks.v1.json',
    'Workflows/landmarks/run-123/../capture-001.landmarks.v1.json',
    'Workflows/landmarks/run-123/node-abc/not-a-sidecar.txt',
  ]) {
    assert.deepEqual(validateLandmarkSidecarV1({ ...captureSidecar, sidecarPath: unsafePath }), {
      valid: false,
      errors: ['invalid_sidecar_path'],
    })
  }
})

test('creates unique landmark capture identities for the same workflow node', () => {
  const first = createLandmarkCaptureIdentity('workflow-1', 'landmarks-node')
  const second = createLandmarkCaptureIdentity('workflow-1', 'landmarks-node')

  assert.equal(first.captureRevision, 1)
  assert.equal(second.captureRevision, 1)
  assert.notEqual(first.captureId, second.captureId)
  assert.notEqual(first.sidecarPath, second.sidecarPath)
  assert.match(first.sidecarPath, /^Workflows\/landmarks\/workflow-1\/landmarks-node\/[A-Za-z0-9_.-]+\.landmarks\.v1\.json$/)
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  classifyAssetLibraryCandidate,
  downloadWorkspaceArtifact,
  getHumanoidDraftWorkspacePath,
  getHumanoidPromotionWorkspacePath,
  getArtifactSidecarWorkspacePath,
  listWorkspaceAssetLibrary,
  normalizeAssetLibraryReadRequest,
  normalizeWorkspaceArtifactPath,
  openWorkspaceAssetLibraryEntry,
  previewWorkspaceArtifact,
  readHumanoidDraftSidecar,
  readHumanoidPromotionSidecar,
  readPoseClipSidecar,
  readRigMetaSidecar,
  readRigRenameSidecar,
  readWorkspaceAssetLibraryEntry,
  registerArtifactRegistryIpcHandlers,
  writeLandmarkSidecar,
  readArtifactSidecar,
  writeHumanoidPromotionSidecar,
  writeEditedSceneArtifact,
  writePoseClipSidecar,
  writeArtifactSidecar,
} from './artifact-registry-service.ts'

import type { LandmarkSidecarV1 } from '../../src/areas/workflows/landmarks.ts'
import type { AssetLibraryListResult, AssetLibraryReadResult } from '../../src/shared/types/assetLibrary.ts'
import type { RigMetaSidecarReadResult } from '../../src/shared/types/electron.d.ts'

const artifactRegistryService = await import(new URL('./artifact-registry-service.ts', import.meta.url).href)

function assertSuccessfulAssetLibraryList(result: AssetLibraryListResult): asserts result is Extract<AssetLibraryListResult, { success: true }> {
  if (result.success !== true) {
    assert.fail(`expected successful library list, got ${result.error}`)
  }
}

function assertSuccessfulAssetLibraryRead(result: AssetLibraryReadResult): asserts result is Extract<AssetLibraryReadResult, { success: true }> {
  if (result.success !== true) {
    assert.fail(`expected successful library read, got ${result.error}`)
  }
}

function stripAssetLibraryEntryTimestamps<T extends { createdAt?: string, updatedAt?: string } | undefined>(entry: T): Omit<NonNullable<T>, 'createdAt' | 'updatedAt'> | undefined {
  if (!entry) return undefined
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = entry
  return rest
}

function resolveExpectedAssetLibraryEntryTimestamps(fileStats: Awaited<ReturnType<typeof stat>>): { createdAt: string, updatedAt: string } {
  const createdAt = fileStats.birthtime.getTime() > 0 ? fileStats.birthtime : fileStats.mtime
  const updatedAt = fileStats.mtime.getTime() > 0 ? fileStats.mtime : fileStats.birthtime
  return {
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  }
}

type RigRenameSidecarWriter = (request: {
  workspaceDir: string
  sidecarWorkspacePath: string
  sourceWorkspacePath: string
  sidecar: unknown
}) => Promise<unknown>

type RigRenameSidecarReader = (request: {
  workspaceDir: string
  sidecarWorkspacePath: string
  sourceWorkspacePath: string
}) => Promise<unknown>

type RigMetaSidecarReader = (request: {
  workspaceDir: string
  sourceWorkspacePath: string
}) => Promise<unknown>

type PoseClipSidecarWriter = (request: {
  workspaceDir: string
  sidecarWorkspacePath: string
  sourceWorkspacePath: string
  sidecar: unknown
}) => Promise<unknown>

type PoseClipSidecarReader = (request: {
  workspaceDir: string
  sidecarWorkspacePath: string
  legacySidecarWorkspacePath?: string
  sourceWorkspacePath: string
}) => Promise<unknown>

type MotionRetargetSidecarWriter = (request: {
  workspaceDir: string
  sidecarWorkspacePath: string
  sourceWorkspacePath: string
  sidecar: unknown
}) => Promise<unknown>

type MotionRetargetSidecarReader = (request: {
  workspaceDir: string
  sidecarWorkspacePath: string
  sourceWorkspacePath: string
}) => Promise<unknown>

async function withTempWorkspace(run: (workspaceDir: string) => Promise<void>) {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'modly-artifacts-'))
  try {
    await run(workspaceDir)
  } finally {
    await rm(workspaceDir, { recursive: true, force: true })
  }
}

function landmarkSidecar(overrides: Partial<LandmarkSidecarV1> = {}): LandmarkSidecarV1 {
  return {
    schema: 'modly.landmarks',
    version: 1,
    createdAt: '2026-05-17T00:00:00.000Z',
    runId: 'run-1',
    nodeId: 'node-1',
    sidecarPath: 'Workflows/landmarks/run-1/node-1.landmarks.v1.json',
    target: {
      artifactId: 'mesh-artifact-1',
      versionId: 'mesh-version-1',
      kind: 'mesh',
      meshPath: 'Workflows/checkpoints/source.glb',
      lineage: { upstreamNodeId: 'mesh-node' },
    },
    artifacts: {
      sidecarRole: 'landmarks-sidecar',
      targetArtifactId: 'mesh-artifact-1',
      targetVersionId: 'mesh-version-1',
    },
    landmarks: [
      { id: 'left_shoulder', name: 'Left shoulder', world: { x: 1, y: 2, z: 3 }, confidence: 1, source: 'manual', objectName: 'Body' },
      { id: 'right_shoulder', name: 'Right shoulder', world: { x: 4, y: 5, z: 6 }, confidence: 1, source: 'manual' },
      { id: 'hip', name: 'Hip', world: { x: 7, y: 8, z: 9 }, confidence: 1, source: 'manual' },
      { id: 'left_knee', name: 'Left knee', world: { x: 10, y: 11, z: 12 }, confidence: 1, source: 'manual' },
      { id: 'right_knee', name: 'Right knee', world: { x: 13, y: 14, z: 15 }, confidence: 1, source: 'manual' },
    ],
    ...overrides,
  }
}

function capturedLandmarkSidecar(overrides: Partial<LandmarkSidecarV1> = {}): LandmarkSidecarV1 {
  return landmarkSidecar({
    sidecarPath: 'Workflows/landmarks/run-1/node-1/capture-001.landmarks.v1.json',
    ...overrides,
  })
}

function rigRenameSidecar(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'modly.rig.rename-plan',
    version: 1,
    createdAt: '2026-05-19T00:00:00.000Z',
    source: {
      workspacePath: 'Workflows/checkpoints/source.glb',
      artifactId: 'mesh-artifact-1',
      versionId: 'mesh-version-1',
    },
    skeletonContextId: 'rig:Body|skeleton:0',
    skeleton: {
      rootBoneIds: ['rig:Body|skeleton:0|bone:Hips#0'],
      boneCount: 2,
      bones: [
        {
          boneId: 'rig:Body|skeleton:0|bone:Hips#0',
          oldLabel: 'Hips',
          originalName: 'Hips',
          path: ['Hips'],
        },
        {
          boneId: 'rig:Body|skeleton:0|bone:Hips#0/Spine#0',
          oldLabel: 'Spine',
          originalName: 'Spine',
          path: ['Hips', 'Spine'],
        },
      ],
    },
    aliases: {
      'rig:Body|skeleton:0|bone:Hips#0/Spine#0': {
        oldLabel: 'Spine',
        alias: 'Torso Control',
      },
    },
    ...overrides,
  }
}

function poseClipSidecar(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'modly.pose-clip',
    version: 1,
    createdAt: '2026-05-20T00:00:00.000Z',
    source: {
      workspacePath: 'Workflows/checkpoints/source.glb',
      artifactId: 'mesh-artifact-1',
      versionId: 'mesh-version-1',
    },
    skeletonContextId: 'rig:Body|skeleton:0',
    clip: {
      id: 'walk-cycle',
      name: 'Walk Cycle',
      durationSeconds: 1.5,
      fps: 24,
    },
    skeleton: {
      rootBoneIds: ['rig:Body|skeleton:0|bone:Hips#0'],
      boneCount: 2,
      bones: [
        {
          boneId: 'rig:Body|skeleton:0|bone:Hips#0',
          label: 'Hips',
          originalName: 'Hips',
          path: ['Hips'],
        },
        {
          boneId: 'rig:Body|skeleton:0|bone:Hips#0/Spine#0',
          label: 'Spine',
          originalName: 'Spine',
          path: ['Hips', 'Spine'],
        },
      ],
    },
    keyframes: [
      {
        id: 'kf-1',
        timeSeconds: 0,
        boneId: 'rig:Body|skeleton:0|bone:Hips#0/Spine#0',
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
      {
        id: 'kf-2',
        timeSeconds: 1,
        boneId: 'rig:Body|skeleton:0|bone:Hips#0/Spine#0',
        rotation: { x: 0, y: 0.25, z: 0, w: 0.9682458365518543 },
        translation: { x: 0, y: 0.1, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    ],
    ...overrides,
  }
}

function getRigRenameSidecarWriter(): RigRenameSidecarWriter {
  const writer = (artifactRegistryService as { writeRigRenameSidecar?: unknown }).writeRigRenameSidecar
  assert.equal(typeof writer, 'function', 'artifact registry service must export writeRigRenameSidecar')
  return writer as RigRenameSidecarWriter
}

function getRigRenameSidecarReader(): RigRenameSidecarReader {
  return readRigRenameSidecar as RigRenameSidecarReader
}

function getRigMetaSidecarReader(): RigMetaSidecarReader {
  return readRigMetaSidecar as RigMetaSidecarReader
}

function getPoseClipSidecarWriter(): PoseClipSidecarWriter {
  return writePoseClipSidecar as PoseClipSidecarWriter
}

function getPoseClipSidecarReader(): PoseClipSidecarReader {
  return readPoseClipSidecar as PoseClipSidecarReader
}

function getMotionRetargetSidecarWriter(): MotionRetargetSidecarWriter {
  const writer = (artifactRegistryService as { writeMotionRetargetSidecar?: unknown }).writeMotionRetargetSidecar
  assert.equal(typeof writer, 'function', 'artifact registry service must export writeMotionRetargetSidecar')
  return writer as MotionRetargetSidecarWriter
}

function getMotionRetargetSidecarReader(): MotionRetargetSidecarReader {
  const reader = (artifactRegistryService as { readMotionRetargetSidecar?: unknown }).readMotionRetargetSidecar
  assert.equal(typeof reader, 'function', 'artifact registry service must export readMotionRetargetSidecar')
  return reader as MotionRetargetSidecarReader
}

function rigMetaSidecar(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'modly.unirig.rigmeta',
    output_mesh: 'foo_unirig.glb',
    semantic_candidates: {
      'rig:Body|skeleton:0|bone:Hips#0': { label: 'Pelvis' },
      'rig:Body|skeleton:0|bone:Hips#0/Spine#0': { display_name: 'Spine Control' },
    },
    humanoid_contract: {
      bones: {
        'rig:Body|skeleton:0|bone:Hips#0/Head#0': { name: 'Head' },
      },
    },
    ...overrides,
  }
}

function motionRetargetSidecar(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'modly.motion-retarget',
    version: 1,
    createdAt: '2026-05-21T00:00:00.000Z',
    source: {
      workspacePath: 'Workflows/checkpoints/source.glb',
      artifactId: 'mesh-artifact-1',
      versionId: 'mesh-version-1',
    },
    artifact: {
      extensionId: 'kimodo-soma-rp',
      nodeId: 'animate-rigged-mesh',
      workflowId: 'workflow-kimodo-1',
      workflowNodeId: 'node-kimodo-1',
      sourceMeshWorkspacePath: 'Workflows/checkpoints/source.glb',
      previewGlbWorkspacePath: 'Workflows/generated/kimodo/source.preview.glb',
      animatedGlbWorkspacePath: 'Workflows/generated/kimodo/source.animated.glb',
      bundleWorkspacePath: 'Workflows/generated/kimodo/source-motion',
      metadataWorkspacePath: 'Workflows/generated/kimodo/source-motion/metadata.json',
      canonicalMotionArtifactWorkspacePath: 'Workflows/generated/kimodo/source-motion/motion.npz',
      motionNpzWorkspacePath: 'Workflows/generated/kimodo/source-motion/motion.npz',
      motionBvhWorkspacePath: 'Workflows/generated/kimodo/source-motion/motion.bvh',
      diagnostics: {
        runtimeStatus: 'ok',
        retargetStatus: 'degraded',
        animationMappingStatus: 'ok',
        stabilizationStatus: 'ok',
        visualQualityStatus: 'warning',
        sourceKind: 'kimodo-motion-bundle',
        mappingConfidence: 'medium',
        retargetErrorCode: null,
        retargetErrorAliases: [],
        retargetErrorMessage: null,
        warnings: ['Root translation is deferred in MVP.'],
        raw: { warnings: ['Root translation is deferred in MVP.'] },
      },
    },
    sourceBones: [
      {
        sourceBoneId: 'source:Hips',
        label: 'Hips',
        rawLabel: 'Hips',
        path: ['Hips'],
      },
      {
        sourceBoneId: 'source:Spine',
        label: 'Spine',
        rawLabel: 'Spine',
        path: ['Hips', 'Spine'],
        parentSourceBoneId: 'source:Hips',
      },
    ],
    session: {
      selectedPreview: 'animated-glb',
      mappings: {
        'source:Hips': { targetBoneId: 'rig:Body|skeleton:0|bone:Hips#0' },
        'source:Spine': { targetBoneId: 'rig:Body|skeleton:0|bone:Hips#0/Spine#0' },
      },
    },
    warnings: [
      'Root translation is deferred in MVP.',
      'Target bone "Spine" is assigned to multiple source bones.',
    ],
    poseClip: {
      id: 'walk-cycle',
      name: 'Walk Cycle',
      durationSeconds: 1.5,
      fps: 24,
    },
    ...overrides,
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function buildMinimalGlb(document: Record<string, unknown>): Buffer {
  const jsonBytes = Buffer.from(JSON.stringify(document), 'utf-8')
  const paddedJsonLength = Math.ceil(jsonBytes.length / 4) * 4
  const jsonChunk = Buffer.alloc(paddedJsonLength, 0x20)
  jsonBytes.copy(jsonChunk)

  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + jsonChunk.length, 8)

  const chunkHeader = Buffer.alloc(8)
  chunkHeader.writeUInt32LE(jsonChunk.length, 0)
  chunkHeader.writeUInt32LE(0x4e4f534a, 4)

  return Buffer.concat([header, chunkHeader, jsonChunk])
}

function humanoidDraftSidecar(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'modly.humanoid-draft.v1',
    version: 1,
    source: { workspacePath: 'Workflows/sources/source.glb' },
    output: { workspacePath: 'Workflows/outputs/hero_unirig.glb' },
    meshOutputSha256: sha256('mesh-bytes-v1'),
    rigmetaSha256: sha256(JSON.stringify(rigMetaSidecar({ output_mesh: 'hero_unirig.glb' }), null, 2)),
    draftSha256: 'draft-sha-1',
    trust: { status: 'draft', reasons: ['semantic_trust_failed'], trusted: false },
    provenance: {
      producer: 'unirig',
      runId: 'run-1',
      extensionId: 'unirig-ext',
      createdAt: '2026-05-22T00:00:00.000Z',
    },
    assignments: {
      roles: {
        hips: 'rig:Body|skeleton:0|bone:Hips#0',
      },
      chains: {
        spine: ['rig:Body|skeleton:0|bone:Hips#0', 'rig:Body|skeleton:0|bone:Hips#0/Spine#0'],
      },
    },
    confidence: { byRole: { hips: 0.92 }, overall: 0.91 },
    completeness: { requiredRolesMissing: [], score: 1 },
    diagnostics: [],
    ...overrides,
  }
}

function humanoidPromotionSidecar(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'modly.humanoid-promotion.v1',
    version: 1,
    promotionId: 'promotion-1',
    source: { workspacePath: 'Workflows/sources/source.glb' },
    output: { workspacePath: 'Workflows/outputs/hero_unirig.glb' },
    meshOutputSha256: sha256('mesh-bytes-v1'),
    rigmetaSha256: sha256(JSON.stringify(rigMetaSidecar({ output_mesh: 'hero_unirig.glb' }), null, 2)),
    draftSha256: 'draft-sha-1',
    draftSchema: 'modly.humanoid-draft.v1',
    promotedAssignments: {
      roles: {
        hips: 'rig:Body|skeleton:0|bone:Hips#0',
      },
      chains: {
        spine: ['rig:Body|skeleton:0|bone:Hips#0', 'rig:Body|skeleton:0|bone:Hips#0/Spine#0'],
      },
    },
    provenance: {
      basis: 'modly.humanoid-draft.v1',
      trustStatus: 'manual_confirmed',
    },
    audit: {
      confirmedBy: 'modly:user:local:drhepa',
      confirmedByLabel: 'drhepa',
      createdAt: '2026-05-22T00:05:00.000Z',
      method: 'viewer3d',
      rationale: 'Reviewed manually.',
    },
    ...overrides,
  }
}

function humanoidEmbeddedRigMetaDraftSidecar(options: {
  meshWorkspacePath?: string
  sourceWorkspacePath?: string
  rigMetaWorkspacePath?: string
  embeddedOutputWorkspacePath?: string
  embeddedSourceWorkspacePath?: string
  draftOverrides?: Record<string, unknown>
  rigMetaOverrides?: Record<string, unknown>
} = {}) {
  const meshWorkspacePath = options.meshWorkspacePath ?? 'Workflows/outputs/hero_unirig.glb'
  const sourceWorkspacePath = options.sourceWorkspacePath ?? 'Workflows/outputs/source.glb'
  const rigMetaWorkspacePath = options.rigMetaWorkspacePath ?? 'Workflows/outputs/hero_unirig.rigmeta.json'
  const draft = humanoidDraftSidecar({
    source: { workspacePath: options.embeddedSourceWorkspacePath ?? path.basename(sourceWorkspacePath) },
    output: { workspacePath: options.embeddedOutputWorkspacePath ?? path.basename(meshWorkspacePath) },
    rigmetaSha256: 'will-be-rewritten-by-modly-fallback',
    draftSha256: 'will-be-rewritten-by-modly-fallback',
    ...(options.draftOverrides ?? {}),
  })
  return rigMetaSidecar({
    output_mesh: path.basename(meshWorkspacePath),
    humanoid_contract_status: 'draft',
    humanoid_draft: draft,
    source: { workspacePath: sourceWorkspacePath },
    sidecar_path: rigMetaWorkspacePath,
    ...(options.rigMetaOverrides ?? {}),
  })
}

test('normalizes workspace-relative artifact paths and rejects absolute or traversal input', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    assert.deepEqual(normalizeWorkspaceArtifactPath(workspaceDir, 'renders\\mesh.glb'), {
      workspacePath: 'renders/mesh.glb',
      absolutePath: path.resolve(workspaceDir, 'renders', 'mesh.glb'),
    })

    for (const unsafePath of ['../secret.glb', 'renders/../secret.glb', '/tmp/secret.glb', 'C:\\tmp\\secret.glb']) {
      assert.throws(
        () => normalizeWorkspaceArtifactPath(workspaceDir, unsafePath),
        /workspace-relative|traversal|absolute/i,
        `${unsafePath} should be rejected`,
      )
    }
  })
})

test('classifies asset library entries by capability evidence instead of file extension buckets', () => {
  const cases = [
    {
      name: 'mesh from artifact sidecar metadata',
      input: { workspacePath: 'Workflows/generated/hero.glb', artifactKind: 'mesh', previewKind: '3d-model' },
      expected: { capability: 'mesh', state: 'ready' },
    },
    {
      name: 'mesh from sidecar-free glb',
      input: { workspacePath: 'Workflows/generated/mystery.glb', previewKind: '3d-model' },
      expected: { capability: 'mesh', state: 'ready' },
    },
    {
      name: 'mesh from sidecar-free gltf',
      input: { workspacePath: 'Workflows/generated/mystery.gltf', previewKind: '3d-model' },
      expected: { capability: 'mesh', state: 'ready' },
    },
    {
      name: 'mesh from sidecar-free obj',
      input: { workspacePath: 'Workflows/generated/mystery.obj', previewKind: 'binary' },
      expected: { capability: 'mesh', state: 'ready' },
    },
    {
      name: 'mesh from sidecar-free stl',
      input: { workspacePath: 'Workflows/generated/mystery.stl', previewKind: 'binary' },
      expected: { capability: 'mesh', state: 'ready' },
    },
    {
      name: 'mesh from sidecar-free ply',
      input: { workspacePath: 'Workflows/generated/mystery.ply', previewKind: 'binary' },
      expected: { capability: 'mesh', state: 'ready' },
    },
    {
      name: 'rigged-mesh',
      input: { workspacePath: 'Workflows/generated/hero.glb', artifactKind: 'mesh', previewKind: '3d-model', evidence: { rigMeta: true } },
      expected: { capability: 'rigged-mesh', state: 'ready' },
    },
    {
      name: 'animation-motion',
      input: { workspacePath: 'Workflows/motion-retarget/hero.motion-retarget.v1.json', previewKind: 'text', evidence: { motionRetargetSidecar: true } },
      expected: { capability: 'animation-motion', state: 'ready' },
    },
    {
      name: 'animation-motion from embedded animation evidence',
      input: { workspacePath: 'Exports/motions/walk.glb', previewKind: '3d-model', evidence: { embeddedAnimations: true } },
      expected: { capability: 'animation-motion', state: 'ready' },
    },
    {
      name: 'rigged-mesh from embedded skin evidence',
      input: { workspacePath: 'Exports/rigged/hero.glb', previewKind: '3d-model', evidence: { embeddedSkins: true } },
      expected: { capability: 'rigged-mesh', state: 'ready' },
    },
    {
      name: 'embedded animation beats embedded skin when both exist',
      input: { workspacePath: 'Exports/rigged/hero-animated.glb', previewKind: '3d-model', evidence: { embeddedSkins: true, embeddedAnimations: true } },
      expected: { capability: 'animation-motion', state: 'ready' },
    },
    {
      name: 'animation-motion from bvh motion file',
      input: { workspacePath: 'Exports/motions/walk.bvh', previewKind: 'text', evidence: { intrinsicMotionFile: true } },
      expected: { capability: 'animation-motion', state: 'ready' },
    },
    {
      name: 'animation-motion from npz motion file',
      input: { workspacePath: 'Exports/motions/walk.npz', previewKind: 'binary', evidence: { intrinsicMotionFile: true } },
      expected: { capability: 'animation-motion', state: 'ready' },
    },
    {
      name: 'landmarks-sidecar',
      input: { workspacePath: 'Workflows/landmarks/hero.landmarks.v1.json', previewKind: 'text', evidence: { landmarkSidecar: true } },
      expected: { capability: 'landmarks-sidecar', state: 'ready' },
    },
    {
      name: 'generated-world',
      input: { workspacePath: 'Workflows/worlds/hero.world.json', previewKind: 'text', evidence: { manifestCapability: 'generated-world' } },
      expected: { capability: 'generated-world', state: 'ready' },
    },
    {
      name: 'scene-manifest',
      input: { workspacePath: 'Workflows/scenes/hero.scene.json', previewKind: 'text', evidence: { manifestCapability: 'scene-manifest' } },
      expected: { capability: 'scene-manifest', state: 'ready' },
    },
    {
      name: 'unsupported',
      input: { workspacePath: 'Workflows/notes/readme.txt', artifactKind: 'text', previewKind: 'text' },
      expected: { capability: undefined, state: 'unsupported' },
    },
  ] as const

  for (const testCase of cases) {
    const result = classifyAssetLibraryCandidate(testCase.input)
    assert.deepEqual(result, testCase.expected, `${testCase.name} should classify from capability evidence`)
  }
})

test('normalizes asset library read requests and rejects encoded escapes plus source-link mismatches', () => {
  assert.deepEqual(
    normalizeAssetLibraryReadRequest({
      workspaceDir: '/workspace',
      workspacePath: 'Workflows\\generated\\hero.glb',
      sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
      indexedSourceWorkspacePath: 'Workflows/checkpoints/source.glb',
    }),
    {
      workspacePath: 'Workflows/generated/hero.glb',
      sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
    },
  )

  for (const workspacePath of [
    '../secret.glb',
    '/tmp/secret.glb',
    'Workflows/%2e%2e/secret.glb',
    'Workflows/%2Fsecret.glb',
  ]) {
    assert.throws(
      () => normalizeAssetLibraryReadRequest({ workspaceDir: '/workspace', workspacePath }),
      /workspace-relative|traversal|absolute|encoded/i,
      `${workspacePath} should be rejected before any library read`,
    )
  }

  assert.throws(
    () => normalizeAssetLibraryReadRequest({
      workspaceDir: '/workspace',
      workspacePath: 'Workflows/landmarks/hero.landmarks.v1.json',
      sourceWorkspacePath: 'Workflows/checkpoints/other.glb',
      indexedSourceWorkspacePath: 'Workflows/checkpoints/source.glb',
    }),
    /source link does not match/i,
  )
})

test('lists workspace asset library entries with projected registry metadata, sidecar evidence, and fallback states', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'generated'), { recursive: true })
    await mkdir(path.join(workspaceDir, 'Workflows', 'sources'), { recursive: true })
    await mkdir(path.join(workspaceDir, 'Workflows', 'motion-retarget'), { recursive: true })
    await mkdir(path.join(workspaceDir, 'Workflows', 'landmarks', 'run-1'), { recursive: true })
    await mkdir(path.join(workspaceDir, 'Workflows', 'worlds'), { recursive: true })
    await mkdir(path.join(workspaceDir, 'notes'), { recursive: true })

    await writeFile(path.join(workspaceDir, 'Workflows', 'sources', 'source.glb'), buildMinimalGlb({ asset: { version: '2.0' } }))
    await writeFile(path.join(workspaceDir, 'Workflows', 'generated', 'hero.glb'), buildMinimalGlb({ asset: { version: '2.0' } }))
    await writeFile(path.join(workspaceDir, 'Workflows', 'generated', 'mystery.glb'), buildMinimalGlb({ asset: { version: '2.0' } }))
    await writeFile(path.join(workspaceDir, 'Workflows', 'generated', 'mystery.gltf'), '{"asset":{"version":"2.0"}}', 'utf-8')
    await writeFile(path.join(workspaceDir, 'Workflows', 'generated', 'mystery.obj'), 'o hero\nv 0 0 0\n', 'utf-8')
    await writeFile(path.join(workspaceDir, 'Workflows', 'generated', 'mystery.stl'), 'solid hero\nendsolid hero\n', 'utf-8')
    await writeFile(path.join(workspaceDir, 'Workflows', 'generated', 'mystery.ply'), 'ply\nformat ascii 1.0\nend_header\n', 'utf-8')
    await writeFile(path.join(workspaceDir, 'notes', 'readme.md'), '# hello', 'utf-8')

    await writeFile(
      path.join(workspaceDir, 'Workflows', 'generated', 'hero.glb.artifact.json'),
      JSON.stringify({
        artifactId: 'artifact-hero',
        workspacePath: 'Workflows/generated/hero.glb',
        metadata: {
          artifact: {
            id: 'artifact-hero',
            kind: 'mesh',
            versionId: 'artifact-hero-v2',
            provenance: {
              workflowId: 'workflow-1',
              workflowNodeId: 'node-hero',
              extensionId: 'unirig',
              extensionNodeId: 'mesh-output',
            },
          },
          displayName: 'Hero Mesh',
          warnings: ['sidecar-warning'],
        },
      }, null, 2),
      'utf-8',
    )
    await writeFile(
      path.join(workspaceDir, 'Workflows', 'generated', 'hero.rigmeta.json'),
      JSON.stringify(rigMetaSidecar({ output_mesh: 'hero.glb', source: { workspacePath: 'Workflows/sources/source.glb' } }), null, 2),
      'utf-8',
    )

    const motionSidecarPath = 'Workflows/motion-retarget/hero.motion-retarget.v1.json'
    await writeFile(
      path.join(workspaceDir, ...motionSidecarPath.split('/')),
      JSON.stringify(motionRetargetSidecar(), null, 2),
      'utf-8',
    )

    const landmarkPath = 'Workflows/landmarks/run-1/hero.landmarks.v1.json'
    await writeFile(
      path.join(workspaceDir, ...landmarkPath.split('/')),
      JSON.stringify(landmarkSidecar({ sidecarPath: landmarkPath }), null, 2),
      'utf-8',
    )

    const worldWorkspacePath = 'Workflows/worlds/hero.world.json'
    await writeFile(
      path.join(workspaceDir, ...worldWorkspacePath.split('/')),
      JSON.stringify({ schema: 'modly.generated-world.v1', title: 'Hero World' }, null, 2),
      'utf-8',
    )
    await writeFile(
      path.join(workspaceDir, 'Workflows', 'worlds', 'hero.world.json.artifact.json'),
      JSON.stringify({
        artifactId: 'artifact-world',
        workspacePath: worldWorkspacePath,
        metadata: {
          artifact: {
            id: 'artifact-world',
            kind: 'text',
            versionId: 'artifact-world-v1',
            provenance: {
              workflowId: 'workflow-world',
              workflowNodeId: 'node-world',
            },
          },
          assetLibrary: { capability: 'generated-world', title: 'Hero World' },
        },
      }, null, 2),
      'utf-8',
    )

    const result = await listWorkspaceAssetLibrary({ workspaceDir })

    assertSuccessfulAssetLibraryList(result)

    const byPath = new Map(result.entries.map((entry) => [entry.workspacePath, entry]))
    assert.equal(byPath.has('Workflows/generated/hero.glb.artifact.json'), false)
    assert.equal(byPath.has('Workflows/generated/hero.rigmeta.json'), false)

    assert.deepEqual(stripAssetLibraryEntryTimestamps(byPath.get('Workflows/generated/hero.glb')), {
      id: 'artifact-hero',
      workspacePath: 'Workflows/generated/hero.glb',
      displayName: 'Hero Mesh',
      sourceScope: 'workflows',
      capability: 'rigged-mesh',
      state: 'ready',
      artifactId: 'artifact-hero',
      versionId: 'artifact-hero-v2',
      provenance: {
        workflowId: 'workflow-1',
        workflowNodeId: 'node-hero',
        extensionId: 'unirig',
        extensionNodeId: 'mesh-output',
      },
      source: {
        relation: 'derived-from',
        workspacePath: 'Workflows/sources/source.glb',
      },
      previewKind: '3d-model',
      warnings: [
        'sidecar-warning',
        'Rigmeta source mismatch: expected "Workflows/generated/hero.glb" but found "Workflows/sources/source.glb".',
      ],
    })

    assert.deepEqual(stripAssetLibraryEntryTimestamps(byPath.get(motionSidecarPath)), {
      id: motionSidecarPath,
      workspacePath: motionSidecarPath,
      displayName: 'hero.motion-retarget.v1.json',
      sourceScope: 'workflows',
      capability: 'animation-motion',
      state: 'ready',
      source: {
        relation: 'sidecar-source',
        workspacePath: 'Workflows/checkpoints/source.glb',
        assetId: 'mesh-artifact-1',
        versionId: 'mesh-version-1',
      },
      previewKind: 'text',
      warnings: ['Root translation is deferred in MVP.'],
    })

    assert.deepEqual(stripAssetLibraryEntryTimestamps(byPath.get(landmarkPath)), {
      id: landmarkPath,
      workspacePath: landmarkPath,
      displayName: 'hero.landmarks.v1.json',
      sourceScope: 'workflows',
      capability: 'landmarks-sidecar',
      state: 'ready',
      source: {
        relation: 'sidecar-source',
        workspacePath: 'Workflows/checkpoints/source.glb',
        assetId: 'mesh-artifact-1',
        versionId: 'mesh-version-1',
      },
      previewKind: 'text',
      warnings: [],
    })

    assert.deepEqual(stripAssetLibraryEntryTimestamps(byPath.get(worldWorkspacePath)), {
      id: 'artifact-world',
      workspacePath: worldWorkspacePath,
      displayName: 'Hero World',
      sourceScope: 'workflows',
      capability: 'generated-world',
      state: 'ready',
      artifactId: 'artifact-world',
      versionId: 'artifact-world-v1',
      provenance: {
        workflowId: 'workflow-world',
        workflowNodeId: 'node-world',
      },
      manifest: {
        capability: 'generated-world',
        workspacePath: worldWorkspacePath,
        schema: 'modly.generated-world.v1',
        title: 'Hero World',
      },
      previewKind: 'text',
      warnings: [],
    })

    assert.deepEqual(stripAssetLibraryEntryTimestamps(byPath.get('Workflows/generated/mystery.glb')), {
      id: 'Workflows/generated/mystery.glb',
      workspacePath: 'Workflows/generated/mystery.glb',
      displayName: 'mystery.glb',
      sourceScope: 'workflows',
      capability: 'mesh',
      state: 'ready',
      previewKind: '3d-model',
      warnings: [],
    })

    assert.deepEqual(stripAssetLibraryEntryTimestamps(byPath.get('Workflows/generated/mystery.gltf')), {
      id: 'Workflows/generated/mystery.gltf',
      workspacePath: 'Workflows/generated/mystery.gltf',
      displayName: 'mystery.gltf',
      sourceScope: 'workflows',
      capability: 'mesh',
      state: 'ready',
      previewKind: '3d-model',
      warnings: [],
    })

    for (const workspacePath of [
      'Workflows/generated/mystery.obj',
      'Workflows/generated/mystery.stl',
      'Workflows/generated/mystery.ply',
    ]) {
      const expectedName = path.basename(workspacePath)
      assert.deepEqual(stripAssetLibraryEntryTimestamps(byPath.get(workspacePath)), {
        id: workspacePath,
        workspacePath,
        displayName: expectedName,
        sourceScope: 'workflows',
        capability: 'mesh',
        state: 'ready',
        previewKind: 'binary',
        warnings: [],
      })
    }

    assert.equal(byPath.has('notes/readme.md'), false)
  })
})

test('lists workspace asset library entries with source scope preserved and intrinsic capability evidence under both roots', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'generated'), { recursive: true })
    await mkdir(path.join(workspaceDir, 'Exports', 'generated'), { recursive: true })
    await mkdir(path.join(workspaceDir, 'Exports', 'motions'), { recursive: true })

    await writeFile(path.join(workspaceDir, 'Workflows', 'generated', 'static.glb'), buildMinimalGlb({ asset: { version: '2.0' } }))
    await writeFile(path.join(workspaceDir, 'Workflows', 'generated', 'rigged.gltf'), JSON.stringify({ asset: { version: '2.0' }, skins: [{}] }), 'utf-8')
    await writeFile(path.join(workspaceDir, 'Exports', 'generated', 'animated.glb'), buildMinimalGlb({ asset: { version: '2.0' }, animations: [{ name: 'Walk' }] }))
    await writeFile(path.join(workspaceDir, 'Exports', 'generated', 'animated-rigged.glb'), buildMinimalGlb({ asset: { version: '2.0' }, skins: [{}], animations: [{ name: 'Walk' }] }))
    await writeFile(path.join(workspaceDir, 'Exports', 'motions', 'walk.bvh'), 'HIERARCHY\nROOT Hips\nMOTION\nFrames: 1\nFrame Time: 0.0333333\n', 'utf-8')
    await writeFile(path.join(workspaceDir, 'Exports', 'motions', 'walk.npz'), Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    await writeFile(path.join(workspaceDir, 'Exports', 'generated', 'broken.glb'), Buffer.from([0x67, 0x6c, 0x62]))

    const result = await listWorkspaceAssetLibrary({ workspaceDir })

    assertSuccessfulAssetLibraryList(result)

    const byPath = new Map(result.entries.map((entry) => [entry.workspacePath, entry]))

    assert.equal(byPath.get('Workflows/generated/static.glb')?.sourceScope, 'workflows')
    assert.equal(byPath.get('Workflows/generated/static.glb')?.capability, 'mesh')
    assert.equal(byPath.get('Workflows/generated/rigged.gltf')?.sourceScope, 'workflows')
    assert.equal(byPath.get('Workflows/generated/rigged.gltf')?.capability, 'rigged-mesh')

    assert.equal(byPath.get('Exports/generated/animated.glb')?.sourceScope, 'exports')
    assert.equal(byPath.get('Exports/generated/animated.glb')?.capability, 'animation-motion')
    assert.equal(byPath.get('Exports/generated/animated-rigged.glb')?.sourceScope, 'exports')
    assert.equal(byPath.get('Exports/generated/animated-rigged.glb')?.capability, 'animation-motion')
    assert.equal(byPath.get('Exports/motions/walk.bvh')?.capability, 'animation-motion')
    assert.equal(byPath.get('Exports/motions/walk.npz')?.capability, 'animation-motion')

    assert.equal(byPath.get('Exports/generated/broken.glb')?.capability, 'mesh')
    assert.match(byPath.get('Exports/generated/broken.glb')?.warnings.join('\n') ?? '', /parse|glb|gltf/i)
  })
})

test('lists a real indexed workspace candidate as unknown-metadata when no supported evidence exists', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'generated'), { recursive: true })
    await writeFile(path.join(workspaceDir, 'Workflows', 'generated', 'opaque-bundle'), Buffer.from([0xde, 0xad, 0xbe, 0xef]))

    const result = await listWorkspaceAssetLibrary({ workspaceDir })

    assertSuccessfulAssetLibraryList(result)

    assert.deepEqual(result.entries.map((entry) => stripAssetLibraryEntryTimestamps(entry)), [
      {
        id: 'Workflows/generated/opaque-bundle',
        workspacePath: 'Workflows/generated/opaque-bundle',
        displayName: 'opaque-bundle',
        sourceScope: 'workflows',
        state: 'unknown-metadata',
        previewKind: 'none',
        warnings: [],
      },
    ])
  })
})

test('lists workspace asset library entries with created and updated timestamps from file stats', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'generated'), { recursive: true })
    const workspacePath = 'Workflows/generated/dated.glb'
    const absolutePath = path.join(workspaceDir, 'Workflows', 'generated', 'dated.glb')
    await writeFile(absolutePath, buildMinimalGlb({ asset: { version: '2.0' } }))

    const result = await listWorkspaceAssetLibrary({ workspaceDir })

    assertSuccessfulAssetLibraryList(result)

    const entry = result.entries.find((candidate) => candidate.workspacePath === workspacePath)
    assert.ok(entry, 'expected dated asset entry to be listed')

    const expectedTimestamps = resolveExpectedAssetLibraryEntryTimestamps(await stat(absolutePath))
    assert.equal(entry?.createdAt, expectedTimestamps.createdAt)
    assert.equal(entry?.updatedAt, expectedTimestamps.updatedAt)
  })
})

test('lists workspace asset library entries only from Workflows and Exports roots and filters unsupported files', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'generated'), { recursive: true })
    await mkdir(path.join(workspaceDir, 'Workflows', 'notes'), { recursive: true })
    await mkdir(path.join(workspaceDir, 'Exports', 'meshes'), { recursive: true })
    await mkdir(path.join(workspaceDir, 'cache'), { recursive: true })

    await writeFile(path.join(workspaceDir, 'Workflows', 'generated', 'hero.glb'), buildMinimalGlb({ asset: { version: '2.0' } }))
    await writeFile(path.join(workspaceDir, 'Exports', 'meshes', 'hero.glb'), buildMinimalGlb({ asset: { version: '2.0' } }))
    await writeFile(path.join(workspaceDir, 'Workflows', 'notes', 'readme.md'), '# noise\n', 'utf-8')
    await writeFile(path.join(workspaceDir, 'cache', 'tmp.glb'), Buffer.from([0x67, 0x6c, 0x62]))

    const result = await listWorkspaceAssetLibrary({ workspaceDir })

    assertSuccessfulAssetLibraryList(result)

    const workspacePaths = result.entries.map((entry) => entry.workspacePath)
    assert.deepEqual(workspacePaths, [
      'Exports/meshes/hero.glb',
      'Workflows/generated/hero.glb',
    ])
    assert.equal(workspacePaths.includes('Workflows/notes/readme.md'), false)
    assert.equal(workspacePaths.includes('cache/tmp.glb'), false)
  })
})

test('lists workspace asset library entries when one scoped root is missing', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Exports', 'meshes'), { recursive: true })
    await writeFile(path.join(workspaceDir, 'Exports', 'meshes', 'hero.glb'), buildMinimalGlb({ asset: { version: '2.0' } }))

    const result = await listWorkspaceAssetLibrary({ workspaceDir })

    assertSuccessfulAssetLibraryList(result)

    assert.deepEqual(result.entries.map((entry) => entry.workspacePath), ['Exports/meshes/hero.glb'])
  })
})

test('prunes internal temporary workspace directories from asset library scanning', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', '.STAGE-P3-SAM', 'run-1', 'PART_MASK'), { recursive: true })
    await mkdir(path.join(workspaceDir, 'Workflows', 'tmp', 'drafts'), { recursive: true })
    await mkdir(path.join(workspaceDir, 'Workflows', 'cache', 'meshes'), { recursive: true })
    await mkdir(path.join(workspaceDir, 'Exports', '.cache', 'meshes'), { recursive: true })
    await mkdir(path.join(workspaceDir, 'Workflows', 'generated'), { recursive: true })
    await mkdir(path.join(workspaceDir, 'Exports', 'meshes'), { recursive: true })

    await writeFile(path.join(workspaceDir, 'Workflows', '.STAGE-P3-SAM', 'run-1', 'PART_MASK', 'mask.glb'), buildMinimalGlb({ asset: { version: '2.0' } }))
    await writeFile(path.join(workspaceDir, 'Workflows', 'tmp', 'drafts', 'preview.glb'), buildMinimalGlb({ asset: { version: '2.0' } }))
    await writeFile(path.join(workspaceDir, 'Workflows', 'cache', 'meshes', 'cached.glb'), buildMinimalGlb({ asset: { version: '2.0' } }))
    await writeFile(path.join(workspaceDir, 'Exports', '.cache', 'meshes', 'export-cache.glb'), buildMinimalGlb({ asset: { version: '2.0' } }))
    await writeFile(path.join(workspaceDir, 'Workflows', 'generated', 'hero.glb'), buildMinimalGlb({ asset: { version: '2.0' } }))
    await writeFile(path.join(workspaceDir, 'Exports', 'meshes', 'hero.glb'), buildMinimalGlb({ asset: { version: '2.0' } }))

    const result = await listWorkspaceAssetLibrary({ workspaceDir })

    assertSuccessfulAssetLibraryList(result)

    const workspacePaths = result.entries.map((entry) => entry.workspacePath)
    assert.deepEqual(workspacePaths, [
      'Exports/meshes/hero.glb',
      'Workflows/generated/hero.glb',
    ])
    assert.equal(workspacePaths.includes('Workflows/.STAGE-P3-SAM/run-1/PART_MASK/mask.glb'), false)
    assert.equal(workspacePaths.includes('Workflows/tmp/drafts/preview.glb'), false)
    assert.equal(workspacePaths.includes('Workflows/cache/meshes/cached.glb'), false)
    assert.equal(workspacePaths.includes('Exports/.cache/meshes/export-cache.glb'), false)
  })
})

test('reads and opens workspace asset library entries through the safe library boundary', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'motion-retarget'), { recursive: true })
    await mkdir(path.join(workspaceDir, 'Workflows', 'generated'), { recursive: true })
    const motionSidecarPath = 'Workflows/motion-retarget/hero.motion-retarget.v1.json'
    await writeFile(
      path.join(workspaceDir, ...motionSidecarPath.split('/')),
      JSON.stringify(motionRetargetSidecar(), null, 2),
      'utf-8',
    )

    const readResult = await readWorkspaceAssetLibraryEntry({
      workspaceDir,
      workspacePath: motionSidecarPath,
      sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
    })

    assertSuccessfulAssetLibraryRead(readResult)
    assert.equal(readResult.entry.capability, 'animation-motion')
    assert.deepEqual(readResult.preview, {
      kind: 'text',
      content: JSON.stringify(motionRetargetSidecar(), null, 2),
      byteLength: JSON.stringify(motionRetargetSidecar(), null, 2).length,
      truncated: false,
    })

    const mismatchResult = await readWorkspaceAssetLibraryEntry({
      workspaceDir,
      workspacePath: motionSidecarPath,
      sourceWorkspacePath: 'Workflows/checkpoints/other.glb',
    })
    assert.equal(mismatchResult.success, false)
    assert.match(mismatchResult.error ?? '', /source link does not match/i)

    await writeFile(path.join(workspaceDir, 'Workflows', 'generated', 'mystery.glb'), buildMinimalGlb({ asset: { version: '2.0' } }))
    await writeFile(path.join(workspaceDir, 'Workflows', 'generated', 'mystery.gltf'), '{"asset":{"version":"2.0"}}', 'utf-8')
    await writeFile(path.join(workspaceDir, 'Workflows', 'generated', 'mystery.obj'), 'o hero\nv 0 0 0\n', 'utf-8')
    await writeFile(path.join(workspaceDir, 'Workflows', 'generated', 'mystery.stl'), 'solid hero\nendsolid hero\n', 'utf-8')
    await writeFile(path.join(workspaceDir, 'Workflows', 'generated', 'mystery.ply'), 'ply\nformat ascii 1.0\nend_header\n', 'utf-8')

    const openReadyResult = await openWorkspaceAssetLibraryEntry({
      workspaceDir,
      workspacePath: motionSidecarPath,
      sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
    })
    assert.deepEqual(openReadyResult, { success: true, entry: readResult.entry })

    for (const workspacePath of [
      'Workflows/generated/mystery.glb',
      'Workflows/generated/mystery.gltf',
      'Workflows/generated/mystery.obj',
      'Workflows/generated/mystery.stl',
      'Workflows/generated/mystery.ply',
    ]) {
      const openMeshResult = await openWorkspaceAssetLibraryEntry({
        workspaceDir,
        workspacePath,
      })
      assert.equal(openMeshResult.success, true)
      if (openMeshResult.success !== true) continue
      assert.equal(openMeshResult.entry.capability, 'mesh')
      assert.equal(openMeshResult.entry.state, 'ready')
    }
  })
})

test('writes and reads a .artifact.json sidecar without mutating the original asset', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'collection'), { recursive: true })
    const assetPath = path.join(workspaceDir, 'collection', 'model.glb')
    await writeFile(assetPath, 'original mesh bytes', 'utf-8')

    const writeResult = await writeArtifactSidecar({
      workspaceDir,
      workspacePath: 'collection/model.glb',
      artifactId: 'artifact-mesh-1',
      metadata: { source: 'test', nested: { kept: true } },
    })

    assert.equal(writeResult.success, true)
    assert.equal(writeResult.sidecarPath, 'collection/model.glb.artifact.json')
    assert.deepEqual(writeResult.sidecar, {
      artifactId: 'artifact-mesh-1',
      workspacePath: 'collection/model.glb',
      metadata: { source: 'test', nested: { kept: true } },
    })
    assert.equal(await readFile(assetPath, 'utf-8'), 'original mesh bytes')

    const sidecarRaw = await readFile(path.join(workspaceDir, 'collection', 'model.glb.artifact.json'), 'utf-8')
    assert.deepEqual(JSON.parse(sidecarRaw), writeResult.sidecar)

    const readResult = await readArtifactSidecar({ workspaceDir, workspacePath: 'collection/model.glb' })
    assert.deepEqual(readResult, { success: true, sidecar: writeResult.sidecar })
  })
})

test('keeps sidecar writes inside the configured workspace boundary', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'modly-outside-'))
    try {
      const result = await writeArtifactSidecar({
        workspaceDir,
        workspacePath: `..${path.sep}${path.basename(outsideDir)}${path.sep}escape.glb`,
        artifactId: 'escape',
        metadata: { shouldNotWrite: true },
      })

      assert.equal(result.success, false)
      assert.match(result.error ?? '', /traversal|workspace-relative/i)
      await assert.rejects(stat(path.join(outsideDir, 'escape.glb.artifact.json')), /ENOENT/)
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })
})

test('registers minimal artifact registry IPC handlers for read and write sidecars', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => Promise<unknown>>()
    registerArtifactRegistryIpcHandlers({
      getWorkspaceDir: () => workspaceDir,
      ipcMain: {
        handle(channel, handler) {
          handlers.set(channel, handler)
        },
      },
    })

    assert.deepEqual([...handlers.keys()].sort(), [
      'workspace:artifact:downloadWorkspaceArtifact',
      'workspace:artifact:previewWorkspaceArtifact',
      'workspace:artifact:readHumanoidDraftSidecar',
      'workspace:artifact:readHumanoidPromotionSidecar',
      'workspace:artifact:readMotionRetargetSidecar',
      'workspace:artifact:readPoseClipSidecar',
      'workspace:artifact:readRigMetaSidecar',
      'workspace:artifact:readRigRenameSidecar',
      'workspace:artifact:readSidecar',
      'workspace:artifact:writeEditedSceneArtifact',
      'workspace:artifact:writeHumanoidPromotionSidecar',
      'workspace:artifact:writeLandmarkSidecar',
      'workspace:artifact:writeMotionRetargetSidecar',
      'workspace:artifact:writePoseClipSidecar',
      'workspace:artifact:writeRigRenameSidecar',
      'workspace:artifact:writeSidecar',
      'workspace:library:list',
      'workspace:library:open',
      'workspace:library:read',
    ])

    const writeHandler = handlers.get('workspace:artifact:writeSidecar')
    const readHandler = handlers.get('workspace:artifact:readSidecar')
    assert.ok(writeHandler)
    assert.ok(readHandler)

    const writeResult = await writeHandler(undefined, {
      workspacePath: 'job/output.mesh.glb',
      artifactId: 'ipc-artifact',
      metadata: { via: 'ipc' },
    })
    assert.deepEqual(writeResult, {
      success: true,
      sidecarPath: 'job/output.mesh.glb.artifact.json',
      sidecar: {
        artifactId: 'ipc-artifact',
        workspacePath: 'job/output.mesh.glb',
        metadata: { via: 'ipc' },
      },
    })

    const readResult = await readHandler(undefined, { workspacePath: 'job/output.mesh.glb' })
    assert.deepEqual(readResult, {
      success: true,
      sidecar: {
        artifactId: 'ipc-artifact',
        workspacePath: 'job/output.mesh.glb',
        metadata: { via: 'ipc' },
      },
    })
  })
})

test('workspace artifact preview rejects absolute and traversal paths before reading', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    for (const workspacePath of ['/tmp/secret.json', '../secret.json', 'Workflows/../secret.json']) {
      const result = await previewWorkspaceArtifact({ workspaceDir, workspacePath })
      assert.equal(result.success, false)
      assert.match(result.error ?? '', /workspace-relative|absolute|traversal/i)
    }
  })
})

test('workspace artifact preview caps and truncates text previews safely', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows/kimodo/run-1'), { recursive: true })
    const workspacePath = 'Workflows/kimodo/run-1/metadata.json'
    await writeFile(path.join(workspaceDir, workspacePath), 'a'.repeat(40), 'utf8')

    const result = await previewWorkspaceArtifact({ workspaceDir, workspacePath, maxBytes: 12 })

    assert.deepEqual(result, {
      success: true,
      status: 'text',
      workspacePath,
      displayName: 'metadata.json',
      content: 'aaaaaaaaaaaa',
      byteLength: 40,
      truncated: true,
    })
  })
})

test('workspace artifact preview classifies NPZ as binary and GLB as Viewer3D-owned 3D content', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows/kimodo/run-1'), { recursive: true })
    await writeFile(path.join(workspaceDir, 'Workflows/kimodo/run-1/motion.npz'), new Uint8Array([80, 75, 3, 4]))
    await writeFile(path.join(workspaceDir, 'Workflows/kimodo/run-1/animated.glb'), new Uint8Array([103, 108, 84, 70]))

    const binaryResult = await previewWorkspaceArtifact({ workspaceDir, workspacePath: 'Workflows/kimodo/run-1/motion.npz' })
    const glbResult = await previewWorkspaceArtifact({ workspaceDir, workspacePath: 'Workflows/kimodo/run-1/animated.glb' })

    assert.deepEqual(binaryResult, {
      success: true,
      status: 'binary',
      workspacePath: 'Workflows/kimodo/run-1/motion.npz',
      displayName: 'motion.npz',
      byteLength: 4,
      binaryKind: 'npz',
      message: 'Binary preview is unavailable for NPZ artifacts. Download the file to inspect it locally.',
    })
    assert.deepEqual(glbResult, {
      success: true,
      status: '3d-model',
      workspacePath: 'Workflows/kimodo/run-1/animated.glb',
      displayName: 'animated.glb',
      viewerKind: 'glb',
    })
  })
})

test('workspace artifact download copies only after the save target is approved', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows/kimodo/run-1'), { recursive: true })
    const workspacePath = 'Workflows/kimodo/run-1/metadata.json'
    const sourcePath = path.join(workspaceDir, workspacePath)
    await writeFile(sourcePath, '{"ok":true}', 'utf8')

    const canceled = await downloadWorkspaceArtifact({
      workspaceDir,
      workspacePath,
      suggestedName: 'metadata.json',
      showSaveDialog: async () => ({ canceled: true }),
    })

    assert.deepEqual(canceled, {
      success: true,
      status: 'cancelled',
      workspacePath,
    })

    const targetPath = path.join(workspaceDir, 'downloads', 'metadata.json')
    const saved = await downloadWorkspaceArtifact({
      workspaceDir,
      workspacePath,
      suggestedName: 'metadata.json',
      showSaveDialog: async () => ({ canceled: false, filePath: targetPath }),
    })

    assert.deepEqual(saved, {
      success: true,
      status: 'saved',
      workspacePath,
      targetPath,
    })
    assert.equal(await readFile(targetPath, 'utf8'), '{"ok":true}')
  })
})

test('sidecar path derivation appends suffix instead of replacing the original asset name', () => {
  assert.equal(getArtifactSidecarWorkspacePath('collection/model.glb'), 'collection/model.glb.artifact.json')
  assert.equal(getArtifactSidecarWorkspacePath('notes/prompt.txt'), 'notes/prompt.txt.artifact.json')
})

test('writes edited scene GLB bytes and exact sidecar metadata within the workspace', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'checkpoints'), { recursive: true })
    await writeFile(path.join(workspaceDir, 'Workflows', 'checkpoints', 'source.glb'), Buffer.from([1, 1, 1]))

    const glbBytes = new Uint8Array([0x67, 0x6c, 0x62, 0x21])
    const result = await writeEditedSceneArtifact({
      workspaceDir,
      glbWorkspacePath: 'Workflows/edited/source-edited.glb',
      sidecarWorkspacePath: 'Workflows/edited/source-edited.json',
      sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
      bytes: glbBytes,
      metadata: { kind: 'scene-edit', source: { workspacePath: 'Workflows/checkpoints/source.glb' } },
    })

    assert.deepEqual(result, {
      success: true,
      glbWorkspacePath: 'Workflows/edited/source-edited.glb',
      sidecarWorkspacePath: 'Workflows/edited/source-edited.json',
      metadata: { kind: 'scene-edit', source: { workspacePath: 'Workflows/checkpoints/source.glb' } },
    })
    assert.deepEqual(await readFile(path.join(workspaceDir, 'Workflows', 'edited', 'source-edited.glb')), Buffer.from(glbBytes))
    assert.deepEqual(JSON.parse(await readFile(path.join(workspaceDir, 'Workflows', 'edited', 'source-edited.json'), 'utf-8')), result.metadata)
  })
})

test('accepts ArrayBuffer bytes for edited scene artifact writes', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const bytes = Uint8Array.from([0, 1, 2, 3]).buffer

    const result = await writeEditedSceneArtifact({
      workspaceDir,
      glbWorkspacePath: 'Workflows/edited/array-buffer.glb',
      sidecarWorkspacePath: 'Workflows/edited/array-buffer.artifact.json',
      sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
      bytes,
      metadata: { kind: 'scene-edit', source: { workspacePath: 'Workflows/checkpoints/source.glb' } },
    })

    assert.equal(result.success, true)
    assert.deepEqual(await readFile(path.join(workspaceDir, 'Workflows', 'edited', 'array-buffer.glb')), Buffer.from([0, 1, 2, 3]))
  })
})

test('rejects unsafe edited scene artifact requests before writing either file', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const invalidRequests = [
      { glbWorkspacePath: '/tmp/escape.glb', sidecarWorkspacePath: 'Workflows/edited/absolute.json', message: /absolute|workspace-relative/i },
      { glbWorkspacePath: 'Workflows/edited/..\\escape.glb', sidecarWorkspacePath: 'Workflows/edited/traversal.json', message: /traversal/i },
      { glbWorkspacePath: 'Workflows/edited/not-glb.obj', sidecarWorkspacePath: 'Workflows/edited/not-glb.json', message: /\.glb/i },
      { glbWorkspacePath: 'Workflows/edited/source-edited.glb', sidecarWorkspacePath: 'Workflows/edited/source-edited.txt', message: /sidecar.*json/i },
      { glbWorkspacePath: 'Workflows/edited/source.glb', sidecarWorkspacePath: 'Workflows/edited/overwrite.json', sourceWorkspacePath: 'Workflows/edited/source.glb', message: /source/i },
      { glbWorkspacePath: 'Workflows/edited/no-bytes.glb', sidecarWorkspacePath: 'Workflows/edited/no-bytes.json', bytes: new Uint8Array(), message: /bytes/i },
    ]

    for (const invalidRequest of invalidRequests) {
      const result = await writeEditedSceneArtifact({
        workspaceDir,
        glbWorkspacePath: invalidRequest.glbWorkspacePath,
        sidecarWorkspacePath: invalidRequest.sidecarWorkspacePath,
        sourceWorkspacePath: invalidRequest.sourceWorkspacePath ?? 'Workflows/checkpoints/source.glb',
        bytes: invalidRequest.bytes ?? new Uint8Array([9, 9, 9]),
        metadata: { kind: 'scene-edit' },
      })

      assert.equal(result.success, false, invalidRequest.glbWorkspacePath)
      assert.match(result.error, invalidRequest.message)
    }

    await assert.rejects(stat(path.join(workspaceDir, 'Workflows', 'edited', 'source-edited.glb')), /ENOENT/)
    await assert.rejects(stat(path.join(workspaceDir, 'Workflows', 'edited', 'source-edited.txt')), /ENOENT/)
    await assert.rejects(stat(path.join(workspaceDir, 'Workflows', 'edited', 'no-bytes.json')), /ENOENT/)
  })
})

test('registers edited scene artifact IPC handler with unknown payload validation', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => Promise<unknown>>()
    registerArtifactRegistryIpcHandlers({
      getWorkspaceDir: () => workspaceDir,
      ipcMain: {
        handle(channel, handler) {
          handlers.set(channel, handler)
        },
      },
    })

    assert.equal(handlers.has('workspace:artifact:writeEditedSceneArtifact'), true)
    const handler = handlers.get('workspace:artifact:writeEditedSceneArtifact')
    assert.ok(handler)

    const invalid = await handler(undefined, { glbWorkspacePath: 'Workflows/edited/missing-bytes.glb' })
    const invalidMetadata = await handler(undefined, {
      glbWorkspacePath: 'Workflows/edited/no-metadata.glb',
      sidecarWorkspacePath: 'Workflows/edited/no-metadata.json',
      sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
      bytes: new Uint8Array([1]),
      metadata: null,
    })
    assert.deepEqual(invalid, { success: false, error: 'Edited scene artifact write requires glbWorkspacePath, sidecarWorkspacePath, sourceWorkspacePath, bytes, and metadata' })
    assert.deepEqual(invalidMetadata, { success: false, error: 'Edited scene artifact write requires glbWorkspacePath, sidecarWorkspacePath, sourceWorkspacePath, bytes, and metadata' })

    const valid = await handler(undefined, {
      glbWorkspacePath: 'Workflows/edited/ipc.glb',
      sidecarWorkspacePath: 'Workflows/edited/ipc.json',
      sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
      bytes: new Uint8Array([5, 6, 7]),
      metadata: { kind: 'scene-edit', via: 'ipc' },
    })

    assert.deepEqual(valid, {
      success: true,
      glbWorkspacePath: 'Workflows/edited/ipc.glb',
      sidecarWorkspacePath: 'Workflows/edited/ipc.json',
      metadata: { kind: 'scene-edit', via: 'ipc' },
    })
  })
})

test('writes landmark sidecar JSON under Workflows/landmarks without mutating source mesh', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'checkpoints'), { recursive: true })
    const sourceMesh = path.join(workspaceDir, 'Workflows', 'checkpoints', 'source.glb')
    await writeFile(sourceMesh, Buffer.from([0x67, 0x6c, 0x62]))

    const sidecar = landmarkSidecar()
    const result = await writeLandmarkSidecar({
      workspaceDir,
      sidecarWorkspacePath: sidecar.sidecarPath,
      sourceWorkspacePath: sidecar.target.meshPath,
      sidecar,
    })

    assert.deepEqual(result, { success: true, sidecarWorkspacePath: sidecar.sidecarPath, sidecar })
    assert.deepEqual(await readFile(sourceMesh), Buffer.from([0x67, 0x6c, 0x62]))
    assert.deepEqual(
      JSON.parse(await readFile(path.join(workspaceDir, 'Workflows', 'landmarks', 'run-1', 'node-1.landmarks.v1.json'), 'utf-8')),
      sidecar,
    )
  })
})

test('writes nested landmark capture sidecar JSON without weakening exact overwrite protection', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'checkpoints'), { recursive: true })
    const sourceMesh = path.join(workspaceDir, 'Workflows', 'checkpoints', 'source.glb')
    await writeFile(sourceMesh, Buffer.from([0x67, 0x6c, 0x62]))

    const sidecar = capturedLandmarkSidecar()
    const first = await writeLandmarkSidecar({
      workspaceDir,
      sidecarWorkspacePath: sidecar.sidecarPath,
      sourceWorkspacePath: sidecar.target.meshPath,
      sidecar,
    })
    const second = await writeLandmarkSidecar({
      workspaceDir,
      sidecarWorkspacePath: sidecar.sidecarPath,
      sourceWorkspacePath: sidecar.target.meshPath,
      sidecar,
    })

    assert.deepEqual(first, { success: true, sidecarWorkspacePath: sidecar.sidecarPath, sidecar })
    assert.equal(second.success, false)
    assert.match(second.error, /already exists|overwrite/i)
    assert.deepEqual(await readFile(sourceMesh), Buffer.from([0x67, 0x6c, 0x62]))
    assert.deepEqual(
      JSON.parse(await readFile(path.join(workspaceDir, 'Workflows', 'landmarks', 'run-1', 'node-1', 'capture-001.landmarks.v1.json'), 'utf-8')),
      sidecar,
    )
  })
})

test('rejects unsafe landmark sidecar paths before writing files', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const unsafeRequests = [
      { sidecarWorkspacePath: '/tmp/escape.landmarks.v1.json', message: /absolute|workspace-relative/i },
      { sidecarWorkspacePath: 'Workflows/landmarks/../escape.landmarks.v1.json', message: /traversal/i },
      { sidecarWorkspacePath: 'Workflows/edited/run-1/node-1.landmarks.v1.json', message: /Workflows\/landmarks/i },
      { sidecarWorkspacePath: 'Workflows/landmarks/run-1/node-1.txt', message: /landmarks\.v1\.json/i },
    ]

    for (const unsafeRequest of unsafeRequests) {
      const sidecar = landmarkSidecar({ sidecarPath: unsafeRequest.sidecarWorkspacePath })
      const result = await writeLandmarkSidecar({
        workspaceDir,
        sidecarWorkspacePath: unsafeRequest.sidecarWorkspacePath,
        sourceWorkspacePath: sidecar.target.meshPath,
        sidecar,
      })

      assert.equal(result.success, false, unsafeRequest.sidecarWorkspacePath)
      assert.match(result.error, unsafeRequest.message)
    }

    await assert.rejects(stat(path.join(workspaceDir, 'Workflows', 'edited', 'run-1', 'node-1.landmarks.v1.json')), /ENOENT/)
    await assert.rejects(stat(path.join(workspaceDir, 'Workflows', 'landmarks', 'run-1', 'node-1.txt')), /ENOENT/)
  })
})

test('refuses to overwrite an existing landmark sidecar or source mesh path', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const sidecar = landmarkSidecar()
    const absoluteSidecar = path.join(workspaceDir, 'Workflows', 'landmarks', 'run-1', 'node-1.landmarks.v1.json')
    await mkdir(path.dirname(absoluteSidecar), { recursive: true })
    await writeFile(absoluteSidecar, '{"existing":true}', 'utf-8')

    const overwriteResult = await writeLandmarkSidecar({
      workspaceDir,
      sidecarWorkspacePath: sidecar.sidecarPath,
      sourceWorkspacePath: sidecar.target.meshPath,
      sidecar,
    })

    assert.equal(overwriteResult.success, false)
    assert.match(overwriteResult.error, /already exists|overwrite/i)
    assert.equal(await readFile(absoluteSidecar, 'utf-8'), '{"existing":true}')

    const sourceOverwriteResult = await writeLandmarkSidecar({
      workspaceDir,
      sidecarWorkspacePath: 'Workflows/checkpoints/source.glb',
      sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
      sidecar: landmarkSidecar({ sidecarPath: 'Workflows/checkpoints/source.glb' }),
    })

    assert.equal(sourceOverwriteResult.success, false)
    assert.match(sourceOverwriteResult.error, /source|Workflows\/landmarks/i)
  })
})

test('validates landmark sidecar v1 shape before writing JSON', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const invalidSidecar = {
      ...landmarkSidecar(),
      landmarks: landmarkSidecar().landmarks.filter((landmark) => landmark.id !== 'right_knee'),
    }

    const result = await writeLandmarkSidecar({
      workspaceDir,
      sidecarWorkspacePath: invalidSidecar.sidecarPath,
      sourceWorkspacePath: invalidSidecar.target.meshPath,
      sidecar: invalidSidecar,
    })

    assert.equal(result.success, false)
    assert.match(result.error, /missing_required_landmark:right_knee/i)
    await assert.rejects(stat(path.join(workspaceDir, 'Workflows', 'landmarks', 'run-1', 'node-1.landmarks.v1.json')), /ENOENT/)
  })
})

test('registers landmark sidecar IPC handler with recoverable result errors', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => Promise<unknown>>()
    registerArtifactRegistryIpcHandlers({
      getWorkspaceDir: () => workspaceDir,
      ipcMain: {
        handle(channel, handler) {
          handlers.set(channel, handler)
        },
      },
    })

    assert.equal(handlers.has('workspace:artifact:writeLandmarkSidecar'), true)
    const handler = handlers.get('workspace:artifact:writeLandmarkSidecar')
    assert.ok(handler)

    const invalid = await handler(undefined, { sidecarWorkspacePath: 'Workflows/landmarks/run-1/node-1.landmarks.v1.json' })
    assert.deepEqual(invalid, { success: false, error: 'Landmark sidecar write requires sidecarWorkspacePath, sourceWorkspacePath, and sidecar' })

    const sidecar = landmarkSidecar()
    const valid = await handler(undefined, {
      sidecarWorkspacePath: sidecar.sidecarPath,
      sourceWorkspacePath: sidecar.target.meshPath,
      sidecar,
    })

    assert.deepEqual(valid, { success: true, sidecarWorkspacePath: sidecar.sidecarPath, sidecar })
  })
})

test('writes rig rename sidecar JSON under Workflows/rig-edits without mutating source mesh', async () => {
  const writeRigRenameSidecar = getRigRenameSidecarWriter()

  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'checkpoints'), { recursive: true })
    const sourceMesh = path.join(workspaceDir, 'Workflows', 'checkpoints', 'source.glb')
    await writeFile(sourceMesh, Buffer.from([0x67, 0x6c, 0x62]))

    const sidecarWorkspacePath = 'Workflows/rig-edits/source-rig-aliases.rig.v1.json'
    const sidecar = rigRenameSidecar()
    const result = await writeRigRenameSidecar({
      workspaceDir,
      sidecarWorkspacePath,
      sourceWorkspacePath: sidecar.source.workspacePath as string,
      sidecar,
    })

    assert.deepEqual(result, { success: true, sidecarWorkspacePath, sidecar })
    assert.deepEqual(await readFile(sourceMesh), Buffer.from([0x67, 0x6c, 0x62]))
    assert.deepEqual(
      JSON.parse(await readFile(path.join(workspaceDir, ...sidecarWorkspacePath.split('/')), 'utf-8')),
      sidecar,
    )
    await assert.rejects(stat(path.join(workspaceDir, 'Workflows', 'checkpoints', 'source.glb.rig.v1.json')), /ENOENT/)
  })
})

test('rejects unsafe rig rename sidecar paths before writing files', async () => {
  const writeRigRenameSidecar = getRigRenameSidecarWriter()

  await withTempWorkspace(async (workspaceDir) => {
    const unsafeRequests = [
      { sidecarWorkspacePath: '/tmp/escape.rig.v1.json', message: /absolute|workspace-relative/i },
      { sidecarWorkspacePath: 'Workflows/rig-edits/../escape.rig.v1.json', message: /traversal/i },
      { sidecarWorkspacePath: 'Workflows/rig-edits/..\\escape.rig.v1.json', message: /traversal/i },
      { sidecarWorkspacePath: 'Workflows/edited/source-rig-aliases-20260519T000000Z.rig.v1.json', message: /Workflows\/rig-edits/i },
      { sidecarWorkspacePath: 'Workflows/rig-edits/source-rig-aliases-20260519T000000Z.json', message: /rig\.v1\.json/i },
      { sidecarWorkspacePath: 'Workflows/checkpoints/source.glb', message: /source|Workflows\/rig-edits/i },
    ]

    for (const unsafeRequest of unsafeRequests) {
      const result = await writeRigRenameSidecar({
        workspaceDir,
        sidecarWorkspacePath: unsafeRequest.sidecarWorkspacePath,
        sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
        sidecar: rigRenameSidecar(),
      })

      assert.equal((result as { success?: unknown }).success, false, unsafeRequest.sidecarWorkspacePath)
      assert.match(String((result as { error?: unknown }).error), unsafeRequest.message)
    }

    await assert.rejects(stat(path.join(workspaceDir, 'Workflows', 'edited', 'source-rig-aliases-20260519T000000Z.rig.v1.json')), /ENOENT/)
    await assert.rejects(stat(path.join(workspaceDir, 'Workflows', 'rig-edits', 'source-rig-aliases-20260519T000000Z.json')), /ENOENT/)
  })
})

test('updates an existing deterministic rig rename sidecar safely without mutating source mesh', async () => {
  const writeRigRenameSidecar = getRigRenameSidecarWriter()

  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'checkpoints'), { recursive: true })
    const sourceMesh = path.join(workspaceDir, 'Workflows', 'checkpoints', 'source.glb')
    await writeFile(sourceMesh, Buffer.from([0x67, 0x6c, 0x62]))
    const sidecarWorkspacePath = 'Workflows/rig-edits/source-rig-aliases.rig.v1.json'
    const absoluteSidecar = path.join(workspaceDir, 'Workflows', 'rig-edits', 'source-rig-aliases.rig.v1.json')
    await mkdir(path.dirname(absoluteSidecar), { recursive: true })
    await writeFile(absoluteSidecar, JSON.stringify(rigRenameSidecar({ aliases: { 'rig:Body|skeleton:0|bone:Hips#0': { oldLabel: 'Hips', alias: 'Pelvis Control' } } }), null, 2), 'utf-8')

    const updatedSidecar = rigRenameSidecar({
      createdAt: '2026-05-19T15:44:02.000Z',
      aliases: {
        'rig:Body|skeleton:0|bone:Hips#0': { oldLabel: 'Hips', alias: 'Pelvis Control' },
        'rig:Body|skeleton:0|bone:Hips#0/Spine#0': { oldLabel: 'Spine', alias: 'Torso Control' },
      },
    })

    const result = await writeRigRenameSidecar({
      workspaceDir,
      sidecarWorkspacePath,
      sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
      sidecar: updatedSidecar,
    })

    assert.deepEqual(result, { success: true, sidecarWorkspacePath, sidecar: updatedSidecar })
    assert.deepEqual(await readFile(sourceMesh), Buffer.from([0x67, 0x6c, 0x62]))
    assert.deepEqual(JSON.parse(await readFile(absoluteSidecar, 'utf-8')), updatedSidecar)
  })
})

test('validates rig rename sidecar v1 schema and source metadata before writing JSON', async () => {
  const writeRigRenameSidecar = getRigRenameSidecarWriter()

  await withTempWorkspace(async (workspaceDir) => {
    const invalidSidecars = [
      { sidecar: rigRenameSidecar({ schema: 'modly.landmarks' }), message: /schema/i },
      { sidecar: rigRenameSidecar({ version: 2 }), message: /version/i },
      { sidecar: rigRenameSidecar({ source: { workspacePath: 'Workflows/checkpoints/other.glb' } }), message: /source|workspacePath/i },
      { sidecar: rigRenameSidecar({ aliases: {} }), message: /aliases/i },
    ]

    for (const invalid of invalidSidecars) {
      const result = await writeRigRenameSidecar({
        workspaceDir,
        sidecarWorkspacePath: 'Workflows/rig-edits/source-rig-aliases-20260519T000000Z.rig.v1.json',
        sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
        sidecar: invalid.sidecar,
      })

      assert.equal((result as { success?: unknown }).success, false)
      assert.match(String((result as { error?: unknown }).error), invalid.message)
    }

    await assert.rejects(stat(path.join(workspaceDir, 'Workflows', 'rig-edits', 'source-rig-aliases-20260519T000000Z.rig.v1.json')), /ENOENT/)
  })
})

test('accepts rig rename sidecars that bind to the current mesh lineage source via adjacent rigmeta', async () => {
  const writeRigRenameSidecar = getRigRenameSidecarWriter()
  const readRigRenameSidecar = getRigRenameSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    const outputWorkspacePath = 'Workflows/outputs/hero_unirig.glb'
    const sidecarWorkspacePath = 'Workflows/rig-edits/hero_unirig-rig-aliases.rig.v1.json'
    const lineageSourceWorkspacePath = 'Workflows/inputs/hero.glb'
    const rigMetaWorkspacePath = 'Workflows/outputs/hero_unirig.rigmeta.json'
    const sidecar = rigRenameSidecar({ source: { workspacePath: lineageSourceWorkspacePath } })

    await mkdir(path.join(workspaceDir, 'Workflows', 'outputs'), { recursive: true })
    await writeFile(path.join(workspaceDir, ...outputWorkspacePath.split('/')), Buffer.from([0x67, 0x6c, 0x62]))
    await writeFile(
      path.join(workspaceDir, ...rigMetaWorkspacePath.split('/')),
      JSON.stringify(rigMetaSidecar({ output_mesh: 'hero_unirig.glb', source: { workspacePath: lineageSourceWorkspacePath } }), null, 2),
      'utf-8',
    )

    const writeResult = await writeRigRenameSidecar({
      workspaceDir,
      sidecarWorkspacePath,
      sourceWorkspacePath: outputWorkspacePath,
      sidecar,
    })

    assert.deepEqual(writeResult, { success: true, sidecarWorkspacePath, sidecar })

    const readResult = await readRigRenameSidecar({
      workspaceDir,
      sidecarWorkspacePath,
      sourceWorkspacePath: outputWorkspacePath,
    })

    assert.deepEqual(readResult, { success: true, status: 'found', sidecarWorkspacePath, sidecar })
  })
})

test('registers rig rename sidecar IPC handler with recoverable result errors', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => Promise<unknown>>()
    registerArtifactRegistryIpcHandlers({
      getWorkspaceDir: () => workspaceDir,
      ipcMain: {
        handle(channel, handler) {
          handlers.set(channel, handler)
        },
      },
    })

    assert.equal(handlers.has('workspace:artifact:writeRigRenameSidecar'), true)
    const handler = handlers.get('workspace:artifact:writeRigRenameSidecar')
    assert.ok(handler)

    const invalid = await handler(undefined, { sidecarWorkspacePath: 'Workflows/rig-edits/source-rig-aliases-20260519T000000Z.rig.v1.json' })
    assert.deepEqual(invalid, { success: false, error: 'Rig rename sidecar write requires sidecarWorkspacePath, sourceWorkspacePath, and sidecar' })

    const sidecarWorkspacePath = 'Workflows/rig-edits/source-rig-aliases-20260519T000000Z.rig.v1.json'
    const sidecar = rigRenameSidecar()
    const valid = await handler(undefined, {
      sidecarWorkspacePath,
      sourceWorkspacePath: sidecar.source.workspacePath,
      sidecar,
    })

    assert.deepEqual(valid, { success: true, sidecarWorkspacePath, sidecar })
  })
})

test('reads a valid rig rename sidecar under Workflows/rig-edits without mutating files', async () => {
  const readRigRenameSidecar = getRigRenameSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'checkpoints'), { recursive: true })
    const sourceMesh = path.join(workspaceDir, 'Workflows', 'checkpoints', 'source.glb')
    await writeFile(sourceMesh, Buffer.from([0x67, 0x6c, 0x62]))

    const sidecarWorkspacePath = 'Workflows/rig-edits/source-rig-aliases.rig.v1.json'
    const absoluteSidecar = path.join(workspaceDir, ...sidecarWorkspacePath.split('/'))
    const sidecar = rigRenameSidecar()
    await mkdir(path.dirname(absoluteSidecar), { recursive: true })
    await writeFile(absoluteSidecar, JSON.stringify(sidecar, null, 2), 'utf-8')

    const result = await readRigRenameSidecar({
      workspaceDir,
      sidecarWorkspacePath,
      sourceWorkspacePath: sidecar.source.workspacePath as string,
    })

    assert.deepEqual(result, { success: true, status: 'found', sidecarWorkspacePath, sidecar })
    assert.deepEqual(await readFile(sourceMesh), Buffer.from([0x67, 0x6c, 0x62]))
    assert.equal(await readFile(absoluteSidecar, 'utf-8'), JSON.stringify(sidecar, null, 2))
    await assert.rejects(stat(path.join(workspaceDir, 'Workflows', 'checkpoints', 'source.glb.rig.v1.json')), /ENOENT/)
  })
})

test('returns not-found for a missing rig rename sidecar without creating files', async () => {
  const readRigRenameSidecar = getRigRenameSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    const sidecarWorkspacePath = 'Workflows/rig-edits/missing-rig-aliases.rig.v1.json'

    const result = await readRigRenameSidecar({
      workspaceDir,
      sidecarWorkspacePath,
      sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
    })

    assert.deepEqual(result, { success: true, status: 'not-found', sidecarWorkspacePath })
    await assert.rejects(stat(path.join(workspaceDir, ...sidecarWorkspacePath.split('/'))), /ENOENT/)
  })
})

test('returns invalid for malformed rig rename sidecar JSON, schema, or source mismatch', async () => {
  const readRigRenameSidecar = getRigRenameSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'rig-edits'), { recursive: true })
    const cases = [
      { filename: 'invalid-json.rig.v1.json', contents: '{not json', message: /json/i },
      { filename: 'invalid-schema.rig.v1.json', contents: JSON.stringify(rigRenameSidecar({ schema: 'modly.landmarks' })), message: /schema/i },
      { filename: 'source-mismatch.rig.v1.json', contents: JSON.stringify(rigRenameSidecar({ source: { workspacePath: 'Workflows/checkpoints/other.glb' } })), message: /source|workspacePath/i },
    ]

    for (const invalidCase of cases) {
      const sidecarWorkspacePath = `Workflows/rig-edits/${invalidCase.filename}`
      await writeFile(path.join(workspaceDir, ...sidecarWorkspacePath.split('/')), invalidCase.contents, 'utf-8')

      const result = await readRigRenameSidecar({
        workspaceDir,
        sidecarWorkspacePath,
        sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
      })

      assert.equal((result as { success?: unknown }).success, false, invalidCase.filename)
      assert.equal((result as { status?: unknown }).status, 'invalid', invalidCase.filename)
      assert.match(String((result as { error?: unknown }).error), invalidCase.message)
    }
  })
})

test('rejects rig rename sidecars whose source path does not match the current mesh lineage', async () => {
  const readRigRenameSidecar = getRigRenameSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    const outputWorkspacePath = 'Workflows/outputs/hero_unirig.glb'
    const sidecarWorkspacePath = 'Workflows/rig-edits/hero_unirig-rig-aliases.rig.v1.json'
    const rigMetaWorkspacePath = 'Workflows/outputs/hero_unirig.rigmeta.json'
    const mismatchedSourceWorkspacePath = 'Workflows/inputs/other.glb'

    await mkdir(path.join(workspaceDir, 'Workflows', 'outputs'), { recursive: true })
    await mkdir(path.join(workspaceDir, 'Workflows', 'rig-edits'), { recursive: true })
    await writeFile(path.join(workspaceDir, ...outputWorkspacePath.split('/')), Buffer.from([0x67, 0x6c, 0x62]))
    await writeFile(
      path.join(workspaceDir, ...rigMetaWorkspacePath.split('/')),
      JSON.stringify(rigMetaSidecar({ output_mesh: 'hero_unirig.glb', source: { workspacePath: 'Workflows/inputs/hero.glb' } }), null, 2),
      'utf-8',
    )
    await writeFile(
      path.join(workspaceDir, ...sidecarWorkspacePath.split('/')),
      JSON.stringify(rigRenameSidecar({ source: { workspacePath: mismatchedSourceWorkspacePath } }), null, 2),
      'utf-8',
    )

    const result = await readRigRenameSidecar({
      workspaceDir,
      sidecarWorkspacePath,
      sourceWorkspacePath: outputWorkspacePath,
    })

    assert.equal((result as { success?: unknown }).success, false)
    assert.equal((result as { status?: unknown }).status, 'invalid')
    assert.match(String((result as { error?: unknown }).error), /invalid_source_workspacePath/i)
  })
})

test('rejects unsafe rig rename sidecar read paths before reading outside the workspace', async () => {
  const readRigRenameSidecar = getRigRenameSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    const unsafeRequests = [
      { sidecarWorkspacePath: '/tmp/escape.rig.v1.json', message: /absolute|workspace-relative/i },
      { sidecarWorkspacePath: 'Workflows/rig-edits/../escape.rig.v1.json', message: /traversal/i },
      { sidecarWorkspacePath: 'Workflows/rig-edits/..\\escape.rig.v1.json', message: /traversal/i },
      { sidecarWorkspacePath: 'Workflows/edited/source-rig-aliases.rig.v1.json', message: /Workflows\/rig-edits/i },
      { sidecarWorkspacePath: 'Workflows/rig-edits/source-rig-aliases.json', message: /rig\.v1\.json/i },
      { sidecarWorkspacePath: 'Workflows/checkpoints/source.glb', message: /source|Workflows\/rig-edits/i },
    ]

    for (const unsafeRequest of unsafeRequests) {
      const result = await readRigRenameSidecar({
        workspaceDir,
        sidecarWorkspacePath: unsafeRequest.sidecarWorkspacePath,
        sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
      })

      assert.equal((result as { success?: unknown }).success, false, unsafeRequest.sidecarWorkspacePath)
      assert.equal((result as { status?: unknown }).status, 'invalid', unsafeRequest.sidecarWorkspacePath)
      assert.match(String((result as { error?: unknown }).error), unsafeRequest.message)
    }

    await assert.rejects(stat(path.join(workspaceDir, 'Workflows', 'edited', 'source-rig-aliases.rig.v1.json')), /ENOENT/)
    await assert.rejects(stat(path.join(workspaceDir, 'Workflows', 'rig-edits', 'source-rig-aliases.json')), /ENOENT/)
  })
})

test('registers rig rename sidecar read IPC handler with recoverable result errors', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => Promise<unknown>>()
    registerArtifactRegistryIpcHandlers({
      getWorkspaceDir: () => workspaceDir,
      ipcMain: {
        handle(channel, handler) {
          handlers.set(channel, handler)
        },
      },
    })

    assert.equal(handlers.has('workspace:artifact:readRigRenameSidecar'), true)
    const handler = handlers.get('workspace:artifact:readRigRenameSidecar')
    assert.ok(handler)

    const invalid = await handler(undefined, { sidecarWorkspacePath: 'Workflows/rig-edits/source-rig-aliases.rig.v1.json' })
    assert.deepEqual(invalid, { success: false, status: 'invalid', error: 'Rig rename sidecar read requires sidecarWorkspacePath and sourceWorkspacePath' })

    const sidecarWorkspacePath = 'Workflows/rig-edits/source-rig-aliases.rig.v1.json'
    const sidecar = rigRenameSidecar()
    const absoluteSidecar = path.join(workspaceDir, ...sidecarWorkspacePath.split('/'))
    await mkdir(path.dirname(absoluteSidecar), { recursive: true })
    await writeFile(absoluteSidecar, JSON.stringify(sidecar, null, 2), 'utf-8')

    const valid = await handler(undefined, {
      sidecarWorkspacePath,
      sourceWorkspacePath: sidecar.source.workspacePath,
    })

    assert.deepEqual(valid, { success: true, status: 'found', sidecarWorkspacePath, sidecar })
  })
})

test('writes and upserts pose clip sidecar JSON under Workflows/pose-clips without mutating source mesh', async () => {
  const writePoseClipSidecar = getPoseClipSidecarWriter()

  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'checkpoints'), { recursive: true })
    const sourceMesh = path.join(workspaceDir, 'Workflows', 'checkpoints', 'source.glb')
    await writeFile(sourceMesh, Buffer.from([0x67, 0x6c, 0x62]))
    const sidecarWorkspacePath = 'Workflows/pose-clips/source-walk.pose-clip.v1.json'
    const firstSidecar = poseClipSidecar()
    const updatedSidecar = poseClipSidecar({ clip: { id: 'walk-cycle', name: 'Updated Walk', durationSeconds: 2, fps: 30 } })

    const first = await writePoseClipSidecar({
      workspaceDir,
      sidecarWorkspacePath,
      sourceWorkspacePath: firstSidecar.source.workspacePath as string,
      sidecar: firstSidecar,
    })
    const second = await writePoseClipSidecar({
      workspaceDir,
      sidecarWorkspacePath,
      sourceWorkspacePath: firstSidecar.source.workspacePath as string,
      sidecar: updatedSidecar,
    })

    assert.deepEqual(first, { success: true, sidecarWorkspacePath, sidecar: firstSidecar })
    assert.deepEqual(second, { success: true, sidecarWorkspacePath, sidecar: updatedSidecar })
    assert.deepEqual(await readFile(sourceMesh), Buffer.from([0x67, 0x6c, 0x62]))
    assert.deepEqual(JSON.parse(await readFile(path.join(workspaceDir, ...sidecarWorkspacePath.split('/')), 'utf-8')), updatedSidecar)
  })
})

test('rejects unsafe pose clip sidecar write paths before writing files', async () => {
  const writePoseClipSidecar = getPoseClipSidecarWriter()

  await withTempWorkspace(async (workspaceDir) => {
    const unsafeRequests = [
      { sidecarWorkspacePath: '/tmp/escape.pose-clip.v1.json', message: /absolute|workspace-relative/i },
      { sidecarWorkspacePath: 'Workflows/pose-clips/../escape.pose-clip.v1.json', message: /traversal/i },
      { sidecarWorkspacePath: 'Workflows/pose-clips/..\\escape.pose-clip.v1.json', message: /traversal/i },
      { sidecarWorkspacePath: 'Workflows/rig-edits/source-walk.pose-clip.v1.json', message: /Workflows\/pose-clips/i },
      { sidecarWorkspacePath: 'Workflows/pose-clips/source-walk.json', message: /pose-clip\.v1\.json/i },
      { sidecarWorkspacePath: 'Workflows/pose-clips/source.pose-clip.v1.json', sourceWorkspacePath: 'Workflows/pose-clips/source.pose-clip.v1.json', message: /source/i },
    ]

    for (const unsafeRequest of unsafeRequests) {
      const sourceWorkspacePath = unsafeRequest.sourceWorkspacePath ?? 'Workflows/checkpoints/source.glb'
      const result = await writePoseClipSidecar({
        workspaceDir,
        sidecarWorkspacePath: unsafeRequest.sidecarWorkspacePath,
        sourceWorkspacePath,
        sidecar: poseClipSidecar({ source: { workspacePath: sourceWorkspacePath } }),
      })

      assert.equal((result as { success?: unknown }).success, false, unsafeRequest.sidecarWorkspacePath)
      assert.match(String((result as { error?: unknown }).error), unsafeRequest.message)
    }

    await assert.rejects(stat(path.join(workspaceDir, 'Workflows', 'rig-edits', 'source-walk.pose-clip.v1.json')), /ENOENT/)
    await assert.rejects(stat(path.join(workspaceDir, 'Workflows', 'pose-clips', 'source-walk.json')), /ENOENT/)
  })
})

test('validates pose clip sidecar schema, source, skeleton, and keyframes before writing JSON', async () => {
  const writePoseClipSidecar = getPoseClipSidecarWriter()

  await withTempWorkspace(async (workspaceDir) => {
    const invalidSidecars = [
      { sidecar: poseClipSidecar({ schema: 'modly.rig.rename-plan' }), message: /schema/i },
      { sidecar: poseClipSidecar({ source: { workspacePath: 'Workflows/checkpoints/other.glb' } }), message: /source|workspacePath/i },
      { sidecar: poseClipSidecar({ skeleton: { rootBoneIds: [], boneCount: 0, bones: [] } }), message: /skeleton|bone/i },
      { sidecar: poseClipSidecar({ keyframes: [{ id: 'kf-bad', boneId: 'bone-a', rotation: { x: 0, y: 0, z: 0 } }] }), message: /keyframe|rotation/i },
    ]

    for (const invalid of invalidSidecars) {
      const result = await writePoseClipSidecar({
        workspaceDir,
        sidecarWorkspacePath: 'Workflows/pose-clips/source-walk.pose-clip.v1.json',
        sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
        sidecar: invalid.sidecar,
      })

      assert.equal((result as { success?: unknown }).success, false)
      assert.match(String((result as { error?: unknown }).error), invalid.message)
    }

    await assert.rejects(stat(path.join(workspaceDir, 'Workflows', 'pose-clips', 'source-walk.pose-clip.v1.json')), /ENOENT/)
  })
})

test('reads found, not-found, and invalid pose clip sidecars with source compatibility enforced', async () => {
  const readPoseClipSidecar = getPoseClipSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'pose-clips'), { recursive: true })
    const sidecarWorkspacePath = 'Workflows/pose-clips/source-walk.pose-clip.v1.json'
    const absoluteSidecar = path.join(workspaceDir, ...sidecarWorkspacePath.split('/'))
    const sidecar = poseClipSidecar()
    await writeFile(absoluteSidecar, JSON.stringify(sidecar, null, 2), 'utf-8')

    const found = await readPoseClipSidecar({ workspaceDir, sidecarWorkspacePath, sourceWorkspacePath: sidecar.source.workspacePath as string })
    assert.deepEqual(found, { success: true, status: 'found', sidecarWorkspacePath, sidecar })

    const notFoundPath = 'Workflows/pose-clips/missing.pose-clip.v1.json'
    const notFound = await readPoseClipSidecar({ workspaceDir, sidecarWorkspacePath: notFoundPath, sourceWorkspacePath: sidecar.source.workspacePath as string })
    assert.deepEqual(notFound, { success: true, status: 'not-found', sidecarWorkspacePath: notFoundPath })

    const mismatch = await readPoseClipSidecar({ workspaceDir, sidecarWorkspacePath, sourceWorkspacePath: 'Workflows/checkpoints/other.glb' })
    assert.equal((mismatch as { success?: unknown }).success, false)
    assert.equal((mismatch as { status?: unknown }).status, 'invalid')
    assert.match(String((mismatch as { error?: unknown }).error), /source|workspacePath/i)
  })
})

test('treats a legacy basename-derived Pose/Clip sidecar for a different same-basename source as not found', async () => {
  const readPoseClipSidecar = getPoseClipSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'pose-clips'), { recursive: true })
    const sourceA = 'Workflows/run-a/animated.glb'
    const sourceB = 'Workflows/run-b/animated.glb'
    const legacySidecarWorkspacePath = 'Workflows/pose-clips/animated.pose-clip.v1.json'
    const legacySidecarForSourceA = poseClipSidecar({ source: { workspacePath: sourceA } })
    await writeFile(
      path.join(workspaceDir, ...legacySidecarWorkspacePath.split('/')),
      JSON.stringify(legacySidecarForSourceA, null, 2),
      'utf-8',
    )

    const result = await readPoseClipSidecar({
      workspaceDir,
      sidecarWorkspacePath: legacySidecarWorkspacePath,
      sourceWorkspacePath: sourceB,
    })

    assert.deepEqual(result, {
      success: true,
      status: 'not-found',
      sidecarWorkspacePath: legacySidecarWorkspacePath,
    })
  })
})

test('reads the hashed Pose/Clip sidecar before a colliding legacy basename fallback', async () => {
  const readPoseClipSidecar = getPoseClipSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'pose-clips'), { recursive: true })
    const sourceA = 'Workflows/run-a/animated.glb'
    const sourceB = 'Workflows/run-b/animated.glb'
    const legacySidecarWorkspacePath = 'Workflows/pose-clips/animated.pose-clip.v1.json'
    const hashedSidecarWorkspacePath = 'Workflows/pose-clips/animated--src-bbbbbbbbbbbbbbbb.pose-clip.v1.json'
    const legacySidecarForSourceA = poseClipSidecar({ source: { workspacePath: sourceA }, clip: { id: 'legacy', name: 'Legacy Clip', durationSeconds: 1, fps: 24 } })
    const hashedSidecarForSourceB = poseClipSidecar({ source: { workspacePath: sourceB }, clip: { id: 'hashed', name: 'Hashed Clip', durationSeconds: 2, fps: 30 } })

    await writeFile(path.join(workspaceDir, ...legacySidecarWorkspacePath.split('/')), JSON.stringify(legacySidecarForSourceA, null, 2), 'utf-8')
    await writeFile(path.join(workspaceDir, ...hashedSidecarWorkspacePath.split('/')), JSON.stringify(hashedSidecarForSourceB, null, 2), 'utf-8')

    const result = await readPoseClipSidecar({
      workspaceDir,
      sidecarWorkspacePath: hashedSidecarWorkspacePath,
      legacySidecarWorkspacePath,
      sourceWorkspacePath: sourceB,
    })

    assert.deepEqual(result, {
      success: true,
      status: 'found',
      sidecarWorkspacePath: hashedSidecarWorkspacePath,
      sidecar: hashedSidecarForSourceB,
    })
  })
})

test('falls back to a matching legacy Pose/Clip basename sidecar only when the hashed sidecar is missing', async () => {
  const readPoseClipSidecar = getPoseClipSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'pose-clips'), { recursive: true })
    const sourceWorkspacePath = 'Workflows/run-a/animated.glb'
    const legacySidecarWorkspacePath = 'Workflows/pose-clips/animated.pose-clip.v1.json'
    const missingHashedSidecarWorkspacePath = 'Workflows/pose-clips/animated--src-aaaaaaaaaaaaaaaa.pose-clip.v1.json'
    const legacySidecar = poseClipSidecar({ source: { workspacePath: sourceWorkspacePath } })
    await writeFile(path.join(workspaceDir, ...legacySidecarWorkspacePath.split('/')), JSON.stringify(legacySidecar, null, 2), 'utf-8')

    const result = await readPoseClipSidecar({
      workspaceDir,
      sidecarWorkspacePath: missingHashedSidecarWorkspacePath,
      legacySidecarWorkspacePath,
      sourceWorkspacePath,
    })

    assert.deepEqual(result, {
      success: true,
      status: 'found',
      sidecarWorkspacePath: legacySidecarWorkspacePath,
      sidecar: legacySidecar,
    })
  })
})

test('keeps invalid legacy Pose/Clip fallback schema errors visible when hashed sidecar is missing', async () => {
  const readPoseClipSidecar = getPoseClipSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'pose-clips'), { recursive: true })
    const sourceWorkspacePath = 'Workflows/run-a/animated.glb'
    const legacySidecarWorkspacePath = 'Workflows/pose-clips/animated.pose-clip.v1.json'
    const missingHashedSidecarWorkspacePath = 'Workflows/pose-clips/animated--src-aaaaaaaaaaaaaaaa.pose-clip.v1.json'
    await writeFile(
      path.join(workspaceDir, ...legacySidecarWorkspacePath.split('/')),
      JSON.stringify(poseClipSidecar({ source: { workspacePath: sourceWorkspacePath }, schema: 'modly.landmarks' }), null, 2),
      'utf-8',
    )

    const result = await readPoseClipSidecar({
      workspaceDir,
      sidecarWorkspacePath: missingHashedSidecarWorkspacePath,
      legacySidecarWorkspacePath,
      sourceWorkspacePath,
    })

    assert.equal((result as { success?: unknown }).success, false)
    assert.equal((result as { status?: unknown }).status, 'invalid')
    assert.match(String((result as { error?: unknown }).error), /schema/i)
  })
})

test('returns invalid for malformed pose clip JSON, schema, skeleton, or keyframes instead of throwing', async () => {
  const readPoseClipSidecar = getPoseClipSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'pose-clips'), { recursive: true })
    const cases = [
      { filename: 'invalid-json.pose-clip.v1.json', contents: '{not json', message: /json/i },
      { filename: 'invalid-schema.pose-clip.v1.json', contents: JSON.stringify(poseClipSidecar({ schema: 'modly.landmarks' })), message: /schema/i },
      { filename: 'invalid-skeleton.pose-clip.v1.json', contents: JSON.stringify(poseClipSidecar({ skeleton: { rootBoneIds: ['root'], boneCount: 1, bones: [{ boneId: '', label: 'Bad', originalName: 'Bad', path: [] }] } })), message: /skeleton|bone/i },
      { filename: 'invalid-keyframes.pose-clip.v1.json', contents: JSON.stringify(poseClipSidecar({ keyframes: [{ id: 'bad', timeSeconds: 0, boneId: 'bone-a', rotation: { x: 0, y: 0, z: 0, w: Number.NaN } }] })), message: /keyframe|rotation/i },
    ]

    for (const invalidCase of cases) {
      const sidecarWorkspacePath = `Workflows/pose-clips/${invalidCase.filename}`
      await writeFile(path.join(workspaceDir, ...sidecarWorkspacePath.split('/')), invalidCase.contents, 'utf-8')

      const result = await readPoseClipSidecar({ workspaceDir, sidecarWorkspacePath, sourceWorkspacePath: 'Workflows/checkpoints/source.glb' })
      assert.equal((result as { success?: unknown }).success, false, invalidCase.filename)
      assert.equal((result as { status?: unknown }).status, 'invalid', invalidCase.filename)
      assert.match(String((result as { error?: unknown }).error), invalidCase.message)
    }
  })
})

test('rejects unsafe pose clip read paths before reading outside the workspace', async () => {
  const readPoseClipSidecar = getPoseClipSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    const unsafeRequests = [
      { sidecarWorkspacePath: '/tmp/escape.pose-clip.v1.json', message: /absolute|workspace-relative/i },
      { sidecarWorkspacePath: 'Workflows/pose-clips/../escape.pose-clip.v1.json', message: /traversal/i },
      { sidecarWorkspacePath: 'Workflows/pose-clips/..\\escape.pose-clip.v1.json', message: /traversal/i },
      { sidecarWorkspacePath: 'Workflows/rig-edits/source-walk.pose-clip.v1.json', message: /Workflows\/pose-clips/i },
      { sidecarWorkspacePath: 'Workflows/pose-clips/source-walk.json', message: /pose-clip\.v1\.json/i },
      { sidecarWorkspacePath: 'Workflows/pose-clips/source.pose-clip.v1.json', sourceWorkspacePath: 'Workflows/pose-clips/source.pose-clip.v1.json', message: /source/i },
    ]

    for (const unsafeRequest of unsafeRequests) {
      const result = await readPoseClipSidecar({
        workspaceDir,
        sidecarWorkspacePath: unsafeRequest.sidecarWorkspacePath,
        sourceWorkspacePath: unsafeRequest.sourceWorkspacePath ?? 'Workflows/checkpoints/source.glb',
      })

      assert.equal((result as { success?: unknown }).success, false, unsafeRequest.sidecarWorkspacePath)
      assert.equal((result as { status?: unknown }).status, 'invalid', unsafeRequest.sidecarWorkspacePath)
      assert.match(String((result as { error?: unknown }).error), unsafeRequest.message)
    }
  })
})

test('registers pose clip sidecar IPC handlers with recoverable result envelopes', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => Promise<unknown>>()
    registerArtifactRegistryIpcHandlers({
      getWorkspaceDir: () => workspaceDir,
      ipcMain: {
        handle(channel, handler) {
          handlers.set(channel, handler)
        },
      },
    })

    const writeHandler = handlers.get('workspace:artifact:writePoseClipSidecar')
    const readHandler = handlers.get('workspace:artifact:readPoseClipSidecar')
    assert.ok(writeHandler)
    assert.ok(readHandler)

    const invalidWrite = await writeHandler(undefined, { sidecarWorkspacePath: 'Workflows/pose-clips/source.pose-clip.v1.json' })
    assert.deepEqual(invalidWrite, { success: false, error: 'Pose clip sidecar write requires sidecarWorkspacePath, sourceWorkspacePath, and sidecar' })

    const sidecarWorkspacePath = 'Workflows/pose-clips/source.pose-clip.v1.json'
    const sidecar = poseClipSidecar()
    const validWrite = await writeHandler(undefined, {
      sidecarWorkspacePath,
      sourceWorkspacePath: sidecar.source.workspacePath,
      sidecar,
    })
    assert.deepEqual(validWrite, { success: true, sidecarWorkspacePath, sidecar })

    const invalidRead = await readHandler(undefined, { sidecarWorkspacePath })
    assert.deepEqual(invalidRead, { success: false, status: 'invalid', error: 'Pose clip sidecar read requires sidecarWorkspacePath and sourceWorkspacePath' })

    const validRead = await readHandler(undefined, { sidecarWorkspacePath, sourceWorkspacePath: sidecar.source.workspacePath })
    assert.deepEqual(validRead, { success: true, status: 'found', sidecarWorkspacePath, sidecar })
  })
})

test('writes and reads motion retarget sidecar JSON under Workflows/motion-retarget without mutating source mesh', async () => {
  const writeMotionRetargetSidecar = getMotionRetargetSidecarWriter()
  const readMotionRetargetSidecar = getMotionRetargetSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'checkpoints'), { recursive: true })
    const sourceMesh = path.join(workspaceDir, 'Workflows', 'checkpoints', 'source.glb')
    await writeFile(sourceMesh, Buffer.from([0x67, 0x6c, 0x62]))
    const sidecarWorkspacePath = 'Workflows/motion-retarget/source-walk.motion-retarget.v1.json'
    const sidecar = motionRetargetSidecar()

    const writeResult = await writeMotionRetargetSidecar({
      workspaceDir,
      sidecarWorkspacePath,
      sourceWorkspacePath: sidecar.source.workspacePath,
      sidecar,
    })
    const readResult = await readMotionRetargetSidecar({
      workspaceDir,
      sidecarWorkspacePath,
      sourceWorkspacePath: sidecar.source.workspacePath,
    })

    assert.deepEqual(writeResult, { success: true, sidecarWorkspacePath, sidecar })
    assert.deepEqual(readResult, { success: true, status: 'found', sidecarWorkspacePath, sidecar })
    assert.deepEqual(await readFile(sourceMesh), Buffer.from([0x67, 0x6c, 0x62]))
  })
})

test('motion retarget sidecars validate artifact identity and correction payloads', async () => {
  const writeMotionRetargetSidecar = getMotionRetargetSidecarWriter()
  const readMotionRetargetSidecar = getMotionRetargetSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'motion-retarget'), { recursive: true })
    const sidecarWorkspacePath = 'Workflows/motion-retarget/mrt_0123456789abcdef.motion-retarget.v1.json'
    const sidecar = motionRetargetSidecar({
      identity: {
        key: 'mrt_0123456789abcdef',
        sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
        skeletonContextId: 'rig:Body|skeleton:0',
        workflowId: 'workflow-kimodo-1',
        workflowNodeId: 'node-kimodo-1',
        bundleWorkspacePath: 'Workflows/generated/kimodo/source-motion',
        metadataWorkspacePath: 'Workflows/generated/kimodo/source-motion/metadata.json',
        artifactWorkspacePath: 'Workflows/generated/kimodo/source.animated.glb',
      },
      corrections: {
        rootTranslationPolicy: 'preserve_scaled_npz',
        rootMotionScale: 1.5,
        rootOffset: { x: 0.25, y: 0, z: -0.5 },
        previewMode: 'after',
      },
    })

    const writeResult = await writeMotionRetargetSidecar({
      workspaceDir,
      sidecarWorkspacePath,
      sourceWorkspacePath: sidecar.source.workspacePath,
      sidecar,
    })
    const readResult = await readMotionRetargetSidecar({ workspaceDir, sidecarWorkspacePath, sourceWorkspacePath: sidecar.source.workspacePath })

    assert.deepEqual(writeResult, { success: true, sidecarWorkspacePath, sidecar })
    assert.deepEqual(readResult, { success: true, status: 'found', sidecarWorkspacePath, sidecar })

    for (const invalidSidecar of [
      motionRetargetSidecar({ identity: { ...sidecar.identity, key: 'hero' } }),
      motionRetargetSidecar({ identity: { ...sidecar.identity, sourceWorkspacePath: 'Workflows/checkpoints/other.glb' } }),
      motionRetargetSidecar({ corrections: { ...sidecar.corrections, rootTranslationPolicy: 'basis_override' } }),
      motionRetargetSidecar({ corrections: { ...sidecar.corrections, rootMotionScale: 4 } }),
      motionRetargetSidecar({ corrections: { ...sidecar.corrections, rootOffset: { x: 0, y: Number.POSITIVE_INFINITY, z: 0 } } }),
    ]) {
      const invalid = await writeMotionRetargetSidecar({
        workspaceDir,
        sidecarWorkspacePath: 'Workflows/motion-retarget/mrt_invalid.motion-retarget.v1.json',
        sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
        sidecar: invalidSidecar,
      })
      assert.equal((invalid as { success?: unknown }).success, false)
      assert.match(String((invalid as { error?: unknown }).error), /identity|correction|root/i)
    }
  })
})

test('rejects unsafe motion retarget sidecar paths and invalid payloads before writing files', async () => {
  const writeMotionRetargetSidecar = getMotionRetargetSidecarWriter()

  await withTempWorkspace(async (workspaceDir) => {
    const unsafeRequests = [
      { sidecarWorkspacePath: '/tmp/escape.motion-retarget.v1.json', message: /absolute|workspace-relative/i },
      { sidecarWorkspacePath: 'Workflows/motion-retarget/../escape.motion-retarget.v1.json', message: /traversal/i },
      { sidecarWorkspacePath: 'Workflows/motion-retarget/..\\escape.motion-retarget.v1.json', message: /traversal/i },
      { sidecarWorkspacePath: 'Workflows/pose-clips/source.motion-retarget.v1.json', message: /Workflows\/motion-retarget/i },
      { sidecarWorkspacePath: 'Workflows/motion-retarget/source.json', message: /motion-retarget\.v1\.json/i },
      { sidecarWorkspacePath: 'Workflows/motion-retarget/source.motion-retarget.v1.json', sourceWorkspacePath: 'Workflows/motion-retarget/source.motion-retarget.v1.json', message: /source/i },
    ]

    for (const unsafeRequest of unsafeRequests) {
      const sourceWorkspacePath = unsafeRequest.sourceWorkspacePath ?? 'Workflows/checkpoints/source.glb'
      const result = await writeMotionRetargetSidecar({
        workspaceDir,
        sidecarWorkspacePath: unsafeRequest.sidecarWorkspacePath,
        sourceWorkspacePath,
        sidecar: motionRetargetSidecar({ source: { workspacePath: sourceWorkspacePath } }),
      })

      assert.equal((result as { success?: unknown }).success, false, unsafeRequest.sidecarWorkspacePath)
      assert.match(String((result as { error?: unknown }).error), unsafeRequest.message)
    }

    const invalidSidecars = [
      { sidecar: motionRetargetSidecar({ schema: 'modly.pose-clip' }), message: /schema/i },
      { sidecar: motionRetargetSidecar({ source: { workspacePath: 'Workflows/checkpoints/other.glb' } }), message: /source|workspacePath/i },
      { sidecar: motionRetargetSidecar({ artifact: { extensionId: 'other-extension' } }), message: /artifact|extension/i },
      { sidecar: motionRetargetSidecar({ session: { selectedPreview: 'wireframe-only' } }), message: /preview|session/i },
      {
        sidecar: motionRetargetSidecar({ artifact: { ...motionRetargetSidecar().artifact, previewGlbWorkspacePath: 'Workflows/checkpoints/source.glb' } }),
        message: /source|previewglbworkspacepath|artifact/i,
      },
      {
        sidecar: motionRetargetSidecar({ artifact: { ...motionRetargetSidecar().artifact, animatedGlbWorkspacePath: 'Workflows/checkpoints/source.glb' } }),
        message: /source|animatedglbworkspacepath|artifact/i,
      },
    ]

    for (const invalid of invalidSidecars) {
      const result = await writeMotionRetargetSidecar({
        workspaceDir,
        sidecarWorkspacePath: 'Workflows/motion-retarget/source-walk.motion-retarget.v1.json',
        sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
        sidecar: invalid.sidecar,
      })

      assert.equal((result as { success?: unknown }).success, false)
      assert.match(String((result as { error?: unknown }).error), invalid.message)
    }
  })
})

test('reads an existing Pose/Clip v1 sidecar unchanged after Motion Retarget additions', async () => {
  const readPoseClipSidecar = getPoseClipSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'pose-clips'), { recursive: true })
    await mkdir(path.join(workspaceDir, 'Workflows', 'checkpoints'), { recursive: true })
    const sourceMesh = path.join(workspaceDir, 'Workflows', 'checkpoints', 'source.glb')
    await writeFile(sourceMesh, Buffer.from([0x67, 0x6c, 0x62]))

    const sidecarWorkspacePath = 'Workflows/pose-clips/source-legacy.pose-clip.v1.json'
    const sidecar = poseClipSidecar({
      createdAt: '2025-12-01T00:00:00.000Z',
      clip: { id: 'legacy', name: 'Legacy Clip', durationSeconds: 1, fps: 12 },
    })
    const absoluteSidecar = path.join(workspaceDir, ...sidecarWorkspacePath.split('/'))
    await writeFile(absoluteSidecar, JSON.stringify(sidecar, null, 2), 'utf-8')

    const result = await readPoseClipSidecar({
      workspaceDir,
      sidecarWorkspacePath,
      sourceWorkspacePath: 'Workflows/checkpoints/source.glb',
    })

    assert.deepEqual(result, { success: true, status: 'found', sidecarWorkspacePath, sidecar })
    assert.deepEqual(await readFile(sourceMesh), Buffer.from([0x67, 0x6c, 0x62]))
    assert.equal(await readFile(absoluteSidecar, 'utf-8'), JSON.stringify(sidecar, null, 2))
  })
})

test('reads found, not-found, and invalid motion retarget sidecars with source compatibility enforced', async () => {
  const readMotionRetargetSidecar = getMotionRetargetSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'motion-retarget'), { recursive: true })
    const sidecarWorkspacePath = 'Workflows/motion-retarget/source-walk.motion-retarget.v1.json'
    const absoluteSidecar = path.join(workspaceDir, ...sidecarWorkspacePath.split('/'))
    const sidecar = motionRetargetSidecar()
    await writeFile(absoluteSidecar, JSON.stringify(sidecar, null, 2), 'utf-8')

    const found = await readMotionRetargetSidecar({ workspaceDir, sidecarWorkspacePath, sourceWorkspacePath: sidecar.source.workspacePath })
    assert.deepEqual(found, { success: true, status: 'found', sidecarWorkspacePath, sidecar })

    const notFoundPath = 'Workflows/motion-retarget/missing.motion-retarget.v1.json'
    const notFound = await readMotionRetargetSidecar({ workspaceDir, sidecarWorkspacePath: notFoundPath, sourceWorkspacePath: sidecar.source.workspacePath })
    assert.deepEqual(notFound, { success: true, status: 'not-found', sidecarWorkspacePath: notFoundPath })

    const mismatch = await readMotionRetargetSidecar({ workspaceDir, sidecarWorkspacePath, sourceWorkspacePath: 'Workflows/checkpoints/other.glb' })
    assert.equal((mismatch as { success?: unknown }).success, false)
    assert.equal((mismatch as { status?: unknown }).status, 'invalid')
    assert.match(String((mismatch as { error?: unknown }).error), /source|workspacePath/i)
  })
})

test('registers motion retarget sidecar IPC handlers with recoverable result envelopes', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => Promise<unknown>>()
    registerArtifactRegistryIpcHandlers({
      getWorkspaceDir: () => workspaceDir,
      ipcMain: {
        handle(channel, handler) {
          handlers.set(channel, handler)
        },
      },
    })

    const writeHandler = handlers.get('workspace:artifact:writeMotionRetargetSidecar')
    const readHandler = handlers.get('workspace:artifact:readMotionRetargetSidecar')
    assert.ok(writeHandler)
    assert.ok(readHandler)

    const invalidWrite = await writeHandler(undefined, { sidecarWorkspacePath: 'Workflows/motion-retarget/source.motion-retarget.v1.json' })
    assert.deepEqual(invalidWrite, { success: false, error: 'Motion retarget sidecar write requires sidecarWorkspacePath, sourceWorkspacePath, and sidecar' })

    const sidecarWorkspacePath = 'Workflows/motion-retarget/source.motion-retarget.v1.json'
    const sidecar = motionRetargetSidecar()
    const validWrite = await writeHandler(undefined, {
      sidecarWorkspacePath,
      sourceWorkspacePath: sidecar.source.workspacePath,
      sidecar,
    })
    assert.deepEqual(validWrite, { success: true, sidecarWorkspacePath, sidecar })

    const invalidRead = await readHandler(undefined, { sidecarWorkspacePath })
    assert.deepEqual(invalidRead, { success: false, status: 'invalid', error: 'Motion retarget sidecar read requires sidecarWorkspacePath and sourceWorkspacePath' })

    const validRead = await readHandler(undefined, { sidecarWorkspacePath, sourceWorkspacePath: sidecar.source.workspacePath })
    assert.deepEqual(validRead, { success: true, status: 'found', sidecarWorkspacePath, sidecar })
  })
})

test('reads an adjacent UniRig rigmeta sidecar derived from a safe source mesh path', async () => {
  const readRigMetaSidecar = getRigMetaSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows'), { recursive: true })
    const sourceMesh = path.join(workspaceDir, 'Workflows', 'foo_unirig.glb')
    const rigMetaWorkspacePath = 'Workflows/foo_unirig.rigmeta.json'
    const rigMeta = rigMetaSidecar()
    await writeFile(sourceMesh, Buffer.from([0x67, 0x6c, 0x62]))
    await writeFile(path.join(workspaceDir, ...rigMetaWorkspacePath.split('/')), JSON.stringify(rigMeta, null, 2), 'utf-8')

    const result = await readRigMetaSidecar({ workspaceDir, sourceWorkspacePath: 'Workflows/foo_unirig.glb' }) as RigMetaSidecarReadResult

    assert.deepEqual(result, {
      success: true,
      status: 'found',
      rigMetaWorkspacePath,
      rigMeta,
      namingByBoneId: {
        'rig:Body|skeleton:0|bone:Hips#0': { label: 'Pelvis', source: 'semantic_candidates' },
        'rig:Body|skeleton:0|bone:Hips#0/Spine#0': { label: 'Spine Control', source: 'semantic_candidates' },
        'rig:Body|skeleton:0|bone:Hips#0/Head#0': { label: 'Head', source: 'humanoid_contract' },
      },
      warnings: [],
    })
    assert.deepEqual(await readFile(sourceMesh), Buffer.from([0x67, 0x6c, 0x62]))
    assert.equal(await readFile(path.join(workspaceDir, ...rigMetaWorkspacePath.split('/')), 'utf-8'), JSON.stringify(rigMeta, null, 2))
  })
})

test('readRigMetaSidecar exposes humanoid draft role naming and ignores semantic candidate structural fields', async () => {
  const readRigMetaSidecar = getRigMetaSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows'), { recursive: true })
    const sourceMesh = path.join(workspaceDir, 'Workflows', 'foo_unirig.glb')
    const rigMetaWorkspacePath = 'Workflows/foo_unirig.rigmeta.json'
    const rigMeta = rigMetaSidecar({
      semantic_candidates: {
        schema: 'unirig.semantic_candidates.v1',
        diagnostics: [{ code: 'missing_core_roles' }],
        producer: { resolver: 'semantic_humanoid_resolver' },
        roles: {},
        chains: {},
        topology: { joint_count: 52 },
        transforms: { status: 'available' },
        trust: { status: 'blocked' },
      },
      humanoid_contract: undefined,
      humanoid_draft: {
        assignments: {
          roles: {
            hips: 'bone_0',
            spine: 'bone_1',
          },
        },
      },
    })
    await writeFile(sourceMesh, Buffer.from([0x67, 0x6c, 0x62]))
    await writeFile(path.join(workspaceDir, ...rigMetaWorkspacePath.split('/')), JSON.stringify(rigMeta, null, 2), 'utf-8')

    const result = await readRigMetaSidecar({ workspaceDir, sourceWorkspacePath: 'Workflows/foo_unirig.glb' }) as RigMetaSidecarReadResult

    assert.equal(result.success, true)
    assert.equal(result.status, 'found')
    if (result.success !== true || result.status !== 'found') {
      assert.fail('expected found rigmeta result')
    }
    assert.deepEqual(result.namingByBoneId, {
      bone_0: { label: 'Hips', source: 'humanoid_draft' },
      bone_1: { label: 'Spine', source: 'humanoid_draft' },
    })
    assert.equal(result.warnings.some((warning: string) => warning.includes('candidate label(s) were ignored')), false)
  })
})

test('readRigMetaSidecar extracts trusted humanoid contract required_roles only for known rigmeta bone keys', async () => {
  const readRigMetaSidecar = getRigMetaSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows'), { recursive: true })
    const sourceMesh = path.join(workspaceDir, 'Workflows', 'foo_unirig.glb')
    const rigMetaWorkspacePath = 'Workflows/foo_unirig.rigmeta.json'
    const rigMeta = rigMetaSidecar({
      semantic_candidates: {
        bone_0: { label: 'Generated pelvis' },
        bone_1: { label: 'Generated spine' },
      },
      humanoid_contract_status: 'trusted',
      humanoid_contract: {
        schema: 'modly.humanoid.v1',
        basis: 'unirig',
        required_roles: {
          hips: 'bone_0',
          spine: 'bone_1',
          left_upper_leg: 'UpperLeg.L',
        },
        chains: {
          spine: ['hips', 'spine'],
        },
        optional_roles: {},
        validation: { status: 'validated' },
        provenance: {
          trust_scope: { trusted: ['required_roles', 'role_chains'] },
        },
      },
    })
    await writeFile(sourceMesh, Buffer.from([0x67, 0x6c, 0x62]))
    await writeFile(path.join(workspaceDir, ...rigMetaWorkspacePath.split('/')), JSON.stringify(rigMeta, null, 2), 'utf-8')

    const result = await readRigMetaSidecar({ workspaceDir, sourceWorkspacePath: 'Workflows/foo_unirig.glb' }) as RigMetaSidecarReadResult

    assert.equal(result.success, true)
    assert.equal(result.status, 'found')
    if (result.success !== true || result.status !== 'found') {
      assert.fail('expected found rigmeta result')
    }
    assert.deepEqual(result.namingByBoneId, {
      bone_0: { label: 'Hips', source: 'humanoid_contract' },
      bone_1: { label: 'Spine', source: 'humanoid_contract' },
    })
    assert.equal(Object.hasOwn(result.namingByBoneId, 'UpperLeg.L'), false)
    assert.equal(result.warnings.some((warning: string) => warning.includes('candidate label(s) were ignored')), false)
  })
})

test('readRigMetaSidecar does not over-promise raw-name required_roles resolution without a skeleton summary', async () => {
  const readRigMetaSidecar = getRigMetaSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows'), { recursive: true })
    const sourceMesh = path.join(workspaceDir, 'Workflows', 'foo_unirig.glb')
    const rigMetaWorkspacePath = 'Workflows/foo_unirig.rigmeta.json'
    const rigMeta = rigMetaSidecar({
      semantic_candidates: {
        bone_0: { label: 'Generated pelvis' },
      },
      humanoid_contract_status: 'trusted',
      humanoid_contract: {
        schema: 'modly.humanoid.v1',
        required_roles: {
          hips: 'Hips',
        },
        validation: { status: 'validated' },
        provenance: {
          trust_scope: { trusted: ['required_roles'] },
        },
      },
    })
    await writeFile(sourceMesh, Buffer.from([0x67, 0x6c, 0x62]))
    await writeFile(path.join(workspaceDir, ...rigMetaWorkspacePath.split('/')), JSON.stringify(rigMeta, null, 2), 'utf-8')

    const result = await readRigMetaSidecar({ workspaceDir, sourceWorkspacePath: 'Workflows/foo_unirig.glb' }) as RigMetaSidecarReadResult

    assert.equal(result.success, true)
    assert.equal(result.status, 'found')
    if (result.success !== true || result.status !== 'found') {
      assert.fail('expected found rigmeta result')
    }
    assert.deepEqual(result.namingByBoneId, {
      bone_0: { label: 'Generated pelvis', source: 'semantic_candidates' },
    })
    assert.equal(Object.hasOwn(result.namingByBoneId, 'Hips'), false)
    assert.equal(result.warnings.some((warning: string) => warning.includes('candidate label(s) were ignored')), false)
  })
})

test('returns not-found for a missing adjacent UniRig rigmeta sidecar without creating files', async () => {
  const readRigMetaSidecar = getRigMetaSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    const rigMetaWorkspacePath = 'Workflows/foo_unirig.rigmeta.json'

    const result = await readRigMetaSidecar({ workspaceDir, sourceWorkspacePath: 'Workflows/foo_unirig.glb' })

    assert.deepEqual(result, { success: true, status: 'not-found', rigMetaWorkspacePath })
    await assert.rejects(stat(path.join(workspaceDir, ...rigMetaWorkspacePath.split('/'))), /ENOENT/)
  })
})

test('returns invalid for malformed rigmeta JSON, unsupported schema, or output mesh mismatch', async () => {
  const readRigMetaSidecar = getRigMetaSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows'), { recursive: true })
    const cases = [
      { sourceWorkspacePath: 'Workflows/invalid-json.glb', contents: '{not json', message: /json/i },
      { sourceWorkspacePath: 'Workflows/invalid-schema.glb', contents: JSON.stringify(rigMetaSidecar({ output_mesh: 'invalid-schema.glb', schema: 'unsupported.schema' })), message: /schema/i },
      { sourceWorkspacePath: 'Workflows/foo_unirig.glb', contents: JSON.stringify(rigMetaSidecar({ output_mesh: 'other_unirig.glb' })), message: /output_mesh|mismatch/i },
    ]

    for (const invalidCase of cases) {
      const rigMetaWorkspacePath = invalidCase.sourceWorkspacePath.replace(/\.glb$/i, '.rigmeta.json')
      await writeFile(path.join(workspaceDir, ...rigMetaWorkspacePath.split('/')), invalidCase.contents, 'utf-8')

      const result = await readRigMetaSidecar({ workspaceDir, sourceWorkspacePath: invalidCase.sourceWorkspacePath })

      assert.equal((result as { success?: unknown }).success, false, invalidCase.sourceWorkspacePath)
      assert.equal((result as { status?: unknown }).status, 'invalid', invalidCase.sourceWorkspacePath)
      assert.equal((result as { rigMetaWorkspacePath?: unknown }).rigMetaWorkspacePath, rigMetaWorkspacePath)
      assert.match(String((result as { message?: unknown }).message), invalidCase.message)
    }
  })
})

test('rejects unsafe rigmeta source mesh paths before reading outside the workspace', async () => {
  const readRigMetaSidecar = getRigMetaSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    const unsafeRequests = [
      { sourceWorkspacePath: '/tmp/escape.glb', message: /absolute|workspace-relative/i },
      { sourceWorkspacePath: 'Workflows/../escape.glb', message: /traversal/i },
      { sourceWorkspacePath: 'Workflows/..\\escape.glb', message: /traversal/i },
      { sourceWorkspacePath: 'Workflows/foo.png', message: /mesh|glb|gltf/i },
    ]

    for (const unsafeRequest of unsafeRequests) {
      const result = await readRigMetaSidecar({ workspaceDir, sourceWorkspacePath: unsafeRequest.sourceWorkspacePath })

      assert.equal((result as { success?: unknown }).success, false, unsafeRequest.sourceWorkspacePath)
      assert.equal((result as { status?: unknown }).status, 'invalid', unsafeRequest.sourceWorkspacePath)
      assert.match(String((result as { message?: unknown }).message), unsafeRequest.message)
    }

    await assert.rejects(stat(path.join(workspaceDir, 'Workflows', 'escape.rigmeta.json')), /ENOENT/)
    await assert.rejects(stat(path.join(workspaceDir, 'Workflows', 'foo.rigmeta.json')), /ENOENT/)
  })
})

test('registers rigmeta sidecar read IPC handler with recoverable result errors', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => Promise<unknown>>()
    registerArtifactRegistryIpcHandlers({
      getWorkspaceDir: () => workspaceDir,
      ipcMain: {
        handle(channel, handler) {
          handlers.set(channel, handler)
        },
      },
    })

    assert.equal(handlers.has('workspace:artifact:readRigMetaSidecar'), true)
    const handler = handlers.get('workspace:artifact:readRigMetaSidecar')
    assert.ok(handler)

    const invalid = await handler(undefined, { sourceWorkspacePath: 123 })
    assert.deepEqual(invalid, { success: false, status: 'invalid', message: 'Rigmeta sidecar read requires sourceWorkspacePath' })

    await mkdir(path.join(workspaceDir, 'Workflows'), { recursive: true })
    const rigMeta = rigMetaSidecar()
    await writeFile(path.join(workspaceDir, 'Workflows', 'foo_unirig.rigmeta.json'), JSON.stringify(rigMeta, null, 2), 'utf-8')

    const valid = await handler(undefined, { sourceWorkspacePath: 'Workflows/foo_unirig.glb' })

    assert.deepEqual(valid, {
      success: true,
      status: 'found',
      rigMetaWorkspacePath: 'Workflows/foo_unirig.rigmeta.json',
      rigMeta,
      namingByBoneId: {
        'rig:Body|skeleton:0|bone:Hips#0': { label: 'Pelvis', source: 'semantic_candidates' },
        'rig:Body|skeleton:0|bone:Hips#0/Spine#0': { label: 'Spine Control', source: 'semantic_candidates' },
        'rig:Body|skeleton:0|bone:Hips#0/Head#0': { label: 'Head', source: 'humanoid_contract' },
      },
      warnings: [],
    })
  })
})

test('derives canonical humanoid draft and promotion sibling sidecar paths from a mesh workspace path', () => {
  assert.equal(getHumanoidDraftWorkspacePath('Workflows/outputs/hero_unirig.glb'), 'Workflows/outputs/hero_unirig.humanoid-draft.v1.json')
  assert.equal(getHumanoidPromotionWorkspacePath('Workflows/outputs/hero_unirig.glb'), 'Workflows/outputs/hero_unirig.humanoid-promotion.v1.json')
  assert.equal(getHumanoidDraftWorkspacePath('Workflows/outputs/hero_unirig.gltf'), 'Workflows/outputs/hero_unirig.humanoid-draft.v1.json')
  assert.equal(getHumanoidPromotionWorkspacePath('Workflows/outputs/hero_unirig.gltf'), 'Workflows/outputs/hero_unirig.humanoid-promotion.v1.json')
})

test('writes and reads a manual-confirmed humanoid promotion sidecar beside the mesh without mutating source files', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'outputs'), { recursive: true })
    await mkdir(path.join(workspaceDir, 'Workflows', 'sources'), { recursive: true })

    const meshWorkspacePath = 'Workflows/outputs/hero_unirig.glb'
    const meshAbsolutePath = path.join(workspaceDir, ...meshWorkspacePath.split('/'))
    const draftWorkspacePath = 'Workflows/outputs/hero_unirig.humanoid-draft.v1.json'
    const promotionWorkspacePath = 'Workflows/outputs/hero_unirig.humanoid-promotion.v1.json'
    const rigMetaWorkspacePath = 'Workflows/outputs/hero_unirig.rigmeta.json'
    const sourceWorkspacePath = 'Workflows/sources/source.glb'

    await writeFile(meshAbsolutePath, 'mesh-bytes-v1', 'utf-8')
    await writeFile(path.join(workspaceDir, ...sourceWorkspacePath.split('/')), 'source-mesh', 'utf-8')
    await writeFile(path.join(workspaceDir, ...rigMetaWorkspacePath.split('/')), JSON.stringify(rigMetaSidecar({ output_mesh: 'hero_unirig.glb' }), null, 2), 'utf-8')
    await writeFile(path.join(workspaceDir, ...draftWorkspacePath.split('/')), JSON.stringify(humanoidDraftSidecar(), null, 2), 'utf-8')

    const promotion = humanoidPromotionSidecar()
    const writeResult = await writeHumanoidPromotionSidecar({
      workspaceDir,
      meshWorkspacePath,
      sidecar: promotion,
    })

    assert.deepEqual(writeResult, {
      success: true,
      sidecarWorkspacePath: promotionWorkspacePath,
      sidecar: promotion,
    })

    const readDraftResult = await readHumanoidDraftSidecar({ workspaceDir, meshWorkspacePath })
    assert.deepEqual(readDraftResult, {
      success: true,
      status: 'found',
      sidecarWorkspacePath: draftWorkspacePath,
      sidecar: humanoidDraftSidecar(),
    })

    const readPromotionResult = await readHumanoidPromotionSidecar({ workspaceDir, meshWorkspacePath })
    assert.deepEqual(readPromotionResult, {
      success: true,
      status: 'found',
      sidecarWorkspacePath: promotionWorkspacePath,
      sidecar: promotion,
    })

    assert.equal(await readFile(meshAbsolutePath, 'utf-8'), 'mesh-bytes-v1')
    assert.equal(await readFile(path.join(workspaceDir, ...sourceWorkspacePath.split('/')), 'utf-8'), 'source-mesh')
  })
})

test('detects stale humanoid draft and promotion sidecars when mesh or bound hashes drift', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'outputs'), { recursive: true })

    const meshWorkspacePath = 'Workflows/outputs/hero_unirig.glb'
    const meshAbsolutePath = path.join(workspaceDir, ...meshWorkspacePath.split('/'))
    const draftWorkspacePath = 'Workflows/outputs/hero_unirig.humanoid-draft.v1.json'
    const promotionWorkspacePath = 'Workflows/outputs/hero_unirig.humanoid-promotion.v1.json'
    const rigMetaWorkspacePath = 'Workflows/outputs/hero_unirig.rigmeta.json'

    await writeFile(meshAbsolutePath, 'mesh-bytes-v1', 'utf-8')
    await writeFile(path.join(workspaceDir, ...rigMetaWorkspacePath.split('/')), JSON.stringify(rigMetaSidecar({ output_mesh: 'hero_unirig.glb' }), null, 2), 'utf-8')
    await writeFile(path.join(workspaceDir, ...draftWorkspacePath.split('/')), JSON.stringify(humanoidDraftSidecar(), null, 2), 'utf-8')
    await writeFile(path.join(workspaceDir, ...promotionWorkspacePath.split('/')), JSON.stringify(humanoidPromotionSidecar(), null, 2), 'utf-8')

    await writeFile(meshAbsolutePath, 'mesh-bytes-v2', 'utf-8')

    const staleDraft = await readHumanoidDraftSidecar({ workspaceDir, meshWorkspacePath })
    assert.equal((staleDraft as { success?: unknown }).success, true)
    assert.equal((staleDraft as { status?: unknown }).status, 'stale')
    assert.match(JSON.stringify(staleDraft), /mesh_output_sha256/i)

    const stalePromotion = await readHumanoidPromotionSidecar({ workspaceDir, meshWorkspacePath })
    assert.equal((stalePromotion as { success?: unknown }).success, true)
    assert.equal((stalePromotion as { status?: unknown }).status, 'stale')
    assert.match(JSON.stringify(stalePromotion), /mesh_output_sha256/i)
  })
})

test('rejects malformed humanoid draft and promotion payloads plus unsafe mesh paths', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'outputs'), { recursive: true })
    const meshWorkspacePath = 'Workflows/outputs/hero_unirig.glb'
    const promotionWorkspacePath = 'Workflows/outputs/hero_unirig.humanoid-promotion.v1.json'
    const draftWorkspacePath = 'Workflows/outputs/hero_unirig.humanoid-draft.v1.json'
    const rigMetaWorkspacePath = 'Workflows/outputs/hero_unirig.rigmeta.json'

    await writeFile(path.join(workspaceDir, ...meshWorkspacePath.split('/')), 'mesh-bytes-v1', 'utf-8')
    await writeFile(path.join(workspaceDir, ...rigMetaWorkspacePath.split('/')), JSON.stringify(rigMetaSidecar({ output_mesh: 'hero_unirig.glb' }), null, 2), 'utf-8')
    await writeFile(path.join(workspaceDir, ...draftWorkspacePath.split('/')), JSON.stringify(humanoidDraftSidecar({ schema: 'unsupported.schema' }), null, 2), 'utf-8')

    const invalidDraft = await readHumanoidDraftSidecar({ workspaceDir, meshWorkspacePath })
    assert.equal((invalidDraft as { success?: unknown }).success, false)
    assert.equal((invalidDraft as { status?: unknown }).status, 'invalid')
    assert.match(String((invalidDraft as { error?: unknown }).error), /schema|version/i)

    const invalidWrite = await writeHumanoidPromotionSidecar({
      workspaceDir,
      meshWorkspacePath,
      sidecar: humanoidPromotionSidecar({
        audit: {
          confirmedBy: 'bad-user-id',
          createdAt: '2026-05-22T00:05:00.000Z',
          method: 'viewer3d',
          rationale: 'Reviewed manually.',
        },
      }),
    })
    assert.deepEqual(invalidWrite, {
      success: false,
      error: 'Invalid humanoid promotion sidecar v1: invalid_audit_confirmed_by',
    })

    const unsafeWrite = await writeHumanoidPromotionSidecar({
      workspaceDir,
      meshWorkspacePath: '../escape.glb',
      sidecar: humanoidPromotionSidecar(),
    })
    assert.equal(unsafeWrite.success, false)
    assert.match(String(unsafeWrite.error), /traversal|workspace-relative/i)
    await assert.rejects(stat(path.join(workspaceDir, ...promotionWorkspacePath.split('/'))), /ENOENT/)
  })
})

test('falls back to embedded rigmeta humanoid drafts when the adjacent draft sidecar is missing', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'outputs'), { recursive: true })

    const meshWorkspacePath = 'Workflows/outputs/hero_unirig.glb'
    const meshAbsolutePath = path.join(workspaceDir, ...meshWorkspacePath.split('/'))
    const rigMetaWorkspacePath = 'Workflows/outputs/hero_unirig.rigmeta.json'
    const rigMeta = humanoidEmbeddedRigMetaDraftSidecar({ meshWorkspacePath })

    await writeFile(meshAbsolutePath, 'mesh-bytes-v1', 'utf-8')
    await writeFile(path.join(workspaceDir, ...rigMetaWorkspacePath.split('/')), JSON.stringify(rigMeta, null, 2), 'utf-8')

    const result = await readHumanoidDraftSidecar({ workspaceDir, meshWorkspacePath })
    assert.equal(result.success, true)
    assert.equal(result.status, 'found')
    assert.equal(result.sidecarWorkspacePath, 'Workflows/outputs/hero_unirig.humanoid-draft.v1.json')
    assert.equal(result.sidecar.output.workspacePath, meshWorkspacePath)
    assert.equal(result.sidecar.source.workspacePath, 'Workflows/outputs/source.glb')
    assert.equal(result.sidecar.rigmetaSha256, sha256(JSON.stringify(rigMeta, null, 2)))
    const embeddedDraft = (rigMeta as unknown as { humanoid_draft: { draftSha256: string } }).humanoid_draft
    assert.notEqual(result.sidecar.draftSha256, embeddedDraft.draftSha256)
  })
})

test('writes humanoid promotions from embedded rigmeta fallback drafts and rejects unrelated embedded paths', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'outputs'), { recursive: true })

    const meshWorkspacePath = 'Workflows/outputs/hero_unirig.glb'
    const meshAbsolutePath = path.join(workspaceDir, ...meshWorkspacePath.split('/'))
    const rigMetaWorkspacePath = 'Workflows/outputs/hero_unirig.rigmeta.json'
    const promotionWorkspacePath = 'Workflows/outputs/hero_unirig.humanoid-promotion.v1.json'
    const validRigMeta = humanoidEmbeddedRigMetaDraftSidecar({ meshWorkspacePath })

    await writeFile(meshAbsolutePath, 'mesh-bytes-v1', 'utf-8')
    await writeFile(path.join(workspaceDir, ...rigMetaWorkspacePath.split('/')), JSON.stringify(validRigMeta, null, 2), 'utf-8')

    const draftResult = await readHumanoidDraftSidecar({ workspaceDir, meshWorkspacePath })
    assert.equal(draftResult.success, true)
    assert.equal(draftResult.status, 'found')

    const promotion = humanoidPromotionSidecar({
      source: draftResult.sidecar.source,
      output: draftResult.sidecar.output,
      meshOutputSha256: draftResult.sidecar.meshOutputSha256,
      rigmetaSha256: draftResult.sidecar.rigmetaSha256,
      draftSha256: draftResult.sidecar.draftSha256,
    })
    const writeResult = await writeHumanoidPromotionSidecar({
      workspaceDir,
      meshWorkspacePath,
      sidecar: promotion,
    })
    assert.deepEqual(writeResult, {
      success: true,
      sidecarWorkspacePath: promotionWorkspacePath,
      sidecar: promotion,
    })

    const invalidRigMeta = humanoidEmbeddedRigMetaDraftSidecar({
      meshWorkspacePath,
      embeddedSourceWorkspacePath: 'Workflows/unrelated/source.glb',
    })
    await writeFile(path.join(workspaceDir, ...rigMetaWorkspacePath.split('/')), JSON.stringify(invalidRigMeta, null, 2), 'utf-8')

    const invalidDraft = await readHumanoidDraftSidecar({ workspaceDir, meshWorkspacePath })
    assert.equal(invalidDraft.success, false)
    assert.equal(invalidDraft.status, 'invalid')
    assert.match(String(invalidDraft.error), /source|lineage|related|directory/i)
  })
})

test('registers humanoid draft and promotion IPC handlers with recoverable result envelopes', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => Promise<unknown>>()
    registerArtifactRegistryIpcHandlers({
      getWorkspaceDir: () => workspaceDir,
      ipcMain: {
        handle(channel, handler) {
          handlers.set(channel, handler)
        },
      },
    })

    const writeHandler = handlers.get('workspace:artifact:writeHumanoidPromotionSidecar')
    const readDraftHandler = handlers.get('workspace:artifact:readHumanoidDraftSidecar')
    const readPromotionHandler = handlers.get('workspace:artifact:readHumanoidPromotionSidecar')
    assert.ok(writeHandler)
    assert.ok(readDraftHandler)
    assert.ok(readPromotionHandler)

    const invalidWrite = await writeHandler(undefined, { meshWorkspacePath: 'Workflows/outputs/hero_unirig.glb' })
    assert.deepEqual(invalidWrite, { success: false, error: 'Humanoid promotion sidecar write requires meshWorkspacePath and sidecar' })

    const invalidReadDraft = await readDraftHandler(undefined, { meshWorkspacePath: 123 })
    assert.deepEqual(invalidReadDraft, { success: false, status: 'invalid', error: 'Humanoid draft sidecar read requires meshWorkspacePath' })

    const invalidReadPromotion = await readPromotionHandler(undefined, { meshWorkspacePath: 123 })
    assert.deepEqual(invalidReadPromotion, { success: false, status: 'invalid', error: 'Humanoid promotion sidecar read requires meshWorkspacePath' })
  })
})

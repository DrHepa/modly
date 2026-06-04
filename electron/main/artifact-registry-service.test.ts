import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  downloadWorkspaceArtifact,
  getArtifactSidecarWorkspacePath,
  normalizeWorkspaceArtifactPath,
  previewWorkspaceArtifact,
  readPoseClipSidecar,
  readRigMetaSidecar,
  readRigRenameSidecar,
  registerArtifactRegistryIpcHandlers,
  writeLandmarkSidecar,
  readArtifactSidecar,
  writeEditedSceneArtifact,
  writePoseClipSidecar,
  writeArtifactSidecar,
} from './artifact-registry-service.ts'

import type { LandmarkSidecarV1 } from '../../src/areas/workflows/landmarks.ts'
import type { RigMetaSidecarReadResult } from '../../src/shared/types/electron.d.ts'

const artifactRegistryService = await import(new URL('./artifact-registry-service.ts', import.meta.url).href)

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
      'workspace:artifact:readMotionRetargetSidecar',
      'workspace:artifact:readPoseClipSidecar',
      'workspace:artifact:readRigMetaSidecar',
      'workspace:artifact:readRigRenameSidecar',
      'workspace:artifact:readSidecar',
      'workspace:artifact:writeEditedSceneArtifact',
      'workspace:artifact:writeLandmarkSidecar',
      'workspace:artifact:writeMotionRetargetSidecar',
      'workspace:artifact:writePoseClipSidecar',
      'workspace:artifact:writeRigRenameSidecar',
      'workspace:artifact:writeSidecar',
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

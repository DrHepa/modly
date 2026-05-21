import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  classifyAssetLibraryCandidate,
  listWorkspaceAssetLibrary,
  normalizeWorkspaceAssetPath,
  openWorkspaceAssetLibraryEntry,
  readWorkspaceAssetLibraryEntry,
  registerWorkspaceAssetLibraryIpcHandlers,
} from './artifact-registry-service.ts'

async function withWorkspace(run: (workspaceDir: string) => Promise<void>) {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'modly-library-'))
  try {
    await run(workspaceDir)
  } finally {
    await rm(workspaceDir, { recursive: true, force: true })
  }
}

test('normalizes only workspace-relative paths under allowed Workflows and Exports roots', () => withWorkspace(async (workspaceDir) => {
  assert.equal(normalizeWorkspaceAssetPath(workspaceDir, 'Workflows/checkpoints/hero.glb').workspacePath, 'Workflows/checkpoints/hero.glb')
  assert.equal(normalizeWorkspaceAssetPath(workspaceDir, 'Exports/hero.glb').workspacePath, 'Exports/hero.glb')
  assert.throws(() => normalizeWorkspaceAssetPath(workspaceDir, '../secret.glb'), /traversal|escape|relative/i)
  assert.throws(() => normalizeWorkspaceAssetPath(workspaceDir, '/tmp/secret.glb'), /absolute/i)
  assert.throws(() => normalizeWorkspaceAssetPath(workspaceDir, 'Workflows/%2e%2e/secret.glb'), /encoded/i)
  assert.throws(() => normalizeWorkspaceAssetPath(workspaceDir, 'Collections/hero.glb'), /allowed workspace library roots/i)
}))

test('classifies supported assets by capability instead of extension category', () => {
  assert.deepEqual(classifyAssetLibraryCandidate({ workspacePath: 'Workflows/a.glb' }), {
    capability: 'mesh', state: 'ready', previewKind: '3d-model', openable: true,
  })
  assert.deepEqual(classifyAssetLibraryCandidate({ workspacePath: 'Workflows/rigged.gltf', hasRigMetadata: true }), {
    capability: 'rigged-mesh', state: 'ready', previewKind: '3d-model', openable: true,
  })
  assert.equal(classifyAssetLibraryCandidate({ workspacePath: 'Workflows/motion.bvh' }).capability, 'animation-motion')
  assert.equal(classifyAssetLibraryCandidate({ workspacePath: 'Workflows/scan.splat' }).openable, false)
  assert.equal(classifyAssetLibraryCandidate({ workspacePath: 'Workflows/notes.txt' }).state, 'unsupported')
})

test('lists Workflows and Exports assets while skipping hidden, cache, and internal files', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Workflows/checkpoints'), { recursive: true })
  await mkdir(path.join(workspaceDir, 'Workflows/.hidden'), { recursive: true })
  await mkdir(path.join(workspaceDir, 'Workflows/cache'), { recursive: true })
  await mkdir(path.join(workspaceDir, 'Exports'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.glb'), 'glb')
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.rigmeta.json'), '{}')
  await writeFile(path.join(workspaceDir, 'Workflows/.hidden/private.glb'), 'glb')
  await writeFile(path.join(workspaceDir, 'Workflows/cache/temp.glb'), 'glb')
  await writeFile(path.join(workspaceDir, 'Exports/exported.ply'), 'ply')

  const result = await listWorkspaceAssetLibrary({ workspaceDir })
  assert.equal(result.success, true)
  assert.deepEqual(result.success && result.entries.map((entry) => entry.workspacePath), [
    'Exports/exported.ply',
    'Workflows/checkpoints/hero.glb',
  ])
  assert.equal(result.success && result.entries.find((entry) => entry.workspacePath.endsWith('hero.glb'))?.capability, 'rigged-mesh')
  assert.equal(result.success && result.entries.find((entry) => entry.workspacePath.endsWith('exported.ply'))?.openable, false)
}))

test('registers a generated scene directory through its canonical manifest artifact', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Workflows/world'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'Workflows/world/scene-manifest.json'), JSON.stringify({
    schema: 'modly.scene-manifest.v1', sceneRoot: '.', assets: [],
  }))
  const result = await listWorkspaceAssetLibrary({ workspaceDir })
  assert.equal(result.success, true)
  const scene = result.success && result.entries.find((entry) => entry.workspacePath === 'Workflows/world/scene-manifest.json')
  assert.equal(scene && scene.capability, 'scene-manifest')
  assert.equal(scene && scene.state, 'ready')
}))

test('reads and opens only safe GLB/GLTF workspace assets', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Workflows/checkpoints'), { recursive: true })
  await mkdir(path.join(workspaceDir, 'Exports'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.glb'), 'glb')
  await writeFile(path.join(workspaceDir, 'Exports/static.ply'), 'ply')

  const read = await readWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: 'Workflows/checkpoints/hero.glb' })
  assert.equal(read.success, true)
  assert.equal(read.success && read.preview.kind, '3d-model')
  const opened = await openWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: 'Workflows/checkpoints/hero.glb' })
  assert.equal(opened.success, true)
  assert.equal(opened.success && opened.entry.openable, true)
  const blocked = await openWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: 'Exports/static.ply' })
  assert.equal(blocked.success, false)
  assert.equal(!blocked.success && blocked.error.code, 'not-openable')
  const unsafe = await readWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: '../secret.glb' })
  assert.equal(unsafe.success, false)
  assert.equal(!unsafe.success && unsafe.error.code, 'unsafe-path')
}))

test('Electron read/open boundary rejects Windows absolute and UNC workspace paths', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Workflows/checkpoints'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.glb'), 'glb')

  const unsafeWorkspacePaths = [
    'C:\\Users\\x\\asset.glb',
    'C:/Users/x/asset.glb',
    '\\\\server\\share\\asset.glb',
  ]

  for (const workspacePath of unsafeWorkspacePaths) {
    const read = await readWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath })
    const opened = await openWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath })

    assert.equal(read.success, false, `${workspacePath} should be rejected for read`)
    assert.equal(!read.success && read.error.code, 'unsafe-path')
    assert.equal(opened.success, false, `${workspacePath} should be rejected for open`)
    assert.equal(!opened.success && opened.error.code, 'unsafe-path')
  }
}))

test('Electron read/open boundary rejects Windows absolute and UNC sourceWorkspacePath values', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Workflows/checkpoints'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.glb'), 'glb')
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.landmarks.v1.json'), JSON.stringify({
    sourceWorkspacePath: 'Workflows/checkpoints/hero.glb',
  }))

  const unsafeSourcePaths = [
    'C:\\Users\\x\\asset.glb',
    'C:/Users/x/asset.glb',
    '\\\\server\\share\\asset.glb',
  ]

  for (const sourceWorkspacePath of unsafeSourcePaths) {
    const read = await readWorkspaceAssetLibraryEntry({
      workspaceDir,
      workspacePath: 'Workflows/checkpoints/hero.landmarks.v1.json',
      sourceWorkspacePath,
    })
    const opened = await openWorkspaceAssetLibraryEntry({
      workspaceDir,
      workspacePath: 'Workflows/checkpoints/hero.landmarks.v1.json',
      sourceWorkspacePath,
    })

    assert.equal(read.success, false, `${sourceWorkspacePath} should be rejected as read source`)
    assert.equal(!read.success && read.error.code, 'unsafe-path')
    assert.equal(opened.success, false, `${sourceWorkspacePath} should be rejected as open source`)
    assert.equal(!opened.success && opened.error.code, 'unsafe-path')
  }
}))

test('enriches sidecars with safe source, manifest, artifact, version, and provenance metadata', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Workflows/checkpoints'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.glb'), 'glb')
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.scene.json'), JSON.stringify({ schema: 'scene-manifest' }))
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.landmarks.v1.json'), JSON.stringify({
    sourceWorkspacePath: 'Workflows/checkpoints/hero.glb',
    manifestWorkspacePath: 'Workflows/checkpoints/hero.scene.json',
    artifactId: 'artifact-hero',
    versionId: 'version-1',
    provenance: { workflowId: 'wf-1', workflowNodeId: 'node-1' },
  }))

  const read = await readWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: 'Workflows/checkpoints/hero.landmarks.v1.json' })

  assert.equal(read.success, true)
  if (!read.success) return
  assert.equal(read.entry.source?.workspacePath, 'Workflows/checkpoints/hero.glb')
  assert.equal(read.entry.manifest?.workspacePath, 'Workflows/checkpoints/hero.scene.json')
  assert.equal(read.entry.manifest?.capability, 'scene-manifest')
  assert.equal(read.entry.artifactId, 'artifact-hero')
  assert.equal(read.entry.versionId, 'version-1')
  assert.equal(read.entry.provenance?.workflowId, 'wf-1')
}))

test('fails closed for unsafe, self, missing, and mismatched sourceWorkspacePath opens', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Workflows/checkpoints'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.glb'), 'glb')
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/other.glb'), 'glb')
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.landmarks.v1.json'), JSON.stringify({
    sourceWorkspacePath: 'Workflows/checkpoints/hero.glb',
  }))
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/self.landmarks.v1.json'), JSON.stringify({
    sourceWorkspacePath: 'Workflows/checkpoints/self.landmarks.v1.json',
  }))
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/missing.landmarks.v1.json'), JSON.stringify({
    sourceWorkspacePath: 'Workflows/checkpoints/missing.glb',
  }))

  const opened = await openWorkspaceAssetLibraryEntry({
    workspaceDir,
    workspacePath: 'Workflows/checkpoints/hero.landmarks.v1.json',
    sourceWorkspacePath: 'Workflows/checkpoints/hero.glb',
  })
  assert.equal(opened.success, true)
  assert.equal(opened.success && opened.entry.source?.workspacePath, 'Workflows/checkpoints/hero.glb')

  const unsafe = await openWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: 'Workflows/checkpoints/hero.landmarks.v1.json', sourceWorkspacePath: '../secret.glb' })
  const self = await openWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: 'Workflows/checkpoints/self.landmarks.v1.json', sourceWorkspacePath: 'Workflows/checkpoints/self.landmarks.v1.json' })
  const missing = await openWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: 'Workflows/checkpoints/missing.landmarks.v1.json', sourceWorkspacePath: 'Workflows/checkpoints/missing.glb' })
  const mismatched = await openWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: 'Workflows/checkpoints/hero.landmarks.v1.json', sourceWorkspacePath: 'Workflows/checkpoints/other.glb' })

  assert.equal(unsafe.success, false)
  assert.equal(!unsafe.success && unsafe.error.code, 'unsafe-path')
  assert.equal(self.success, false)
  assert.equal(!self.success && self.error.code, 'not-openable')
  assert.equal(missing.success, false)
  assert.equal(!missing.success && missing.error.code, 'not-openable')
  assert.equal(mismatched.success, false)
  assert.equal(!mismatched.success && mismatched.error.code, 'not-openable')
}))

test('IPC read and open handlers forward sourceWorkspacePath without trusting malformed payloads', async () => {
  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>()
  registerWorkspaceAssetLibraryIpcHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getWorkspaceDir: () => '/tmp/modly-workspace',
  })

  const result = await handlers.get('workspace:library:open')?.({}, {
    workspacePath: 'Workflows/hero.landmarks.v1.json',
    sourceWorkspacePath: '../secret.glb',
  })

  assert.equal(typeof (result as { success?: unknown }).success, 'boolean')
  assert.equal((result as { success: boolean, error?: { code: string } }).error?.code, 'unsafe-path')
})

test('registers workspace library IPC handlers with structured results', async () => {
  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>()
  registerWorkspaceAssetLibraryIpcHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getWorkspaceDir: () => '/tmp/modly-workspace',
  })

  assert.equal(typeof handlers.get('workspace:library:list'), 'function')
  assert.equal(typeof handlers.get('workspace:library:read'), 'function')
  assert.equal(typeof handlers.get('workspace:library:open'), 'function')
  const result = await handlers.get('workspace:library:read')?.({}, { workspacePath: '../escape.glb' })
  assert.equal(typeof (result as { success?: unknown }).success, 'boolean')
  assert.equal((result as { success: boolean, error?: { code: string } }).error?.code, 'unsafe-path')
})

import {
  getArtifactSidecarWorkspacePath,
  normalizeWorkspaceArtifactPath,
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

async function createRegularSource(workspaceDir: string, workspacePath: string): Promise<void> {
  const target = path.join(workspaceDir, workspacePath)
  await mkdir(path.dirname(target), { recursive: true })
  try { await writeFile(target, 'owned regular source fixture', { flag: 'wx' }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
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
      'workspace:artifact:readPoseClipSidecar',
      'workspace:artifact:readRigMetaSidecar',
      'workspace:artifact:readRigRenameSidecar',
      'workspace:artifact:readSidecar',
      'workspace:artifact:writeEditedSceneArtifact',
      'workspace:artifact:writeLandmarkSidecar',
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
    await createRegularSource(workspaceDir, 'Workflows/checkpoints/source.glb')
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
    await createRegularSource(workspaceDir, 'Workflows/checkpoints/source.glb')
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
    await createRegularSource(workspaceDir, 'Workflows/checkpoints/source.glb')
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
    await createRegularSource(workspaceDir, 'Workflows/checkpoints/source.glb')
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
      { sidecar: rigRenameSidecar({ aliases: [] }), message: /aliases/i },
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
    await createRegularSource(workspaceDir, 'Workflows/checkpoints/source.glb')
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
    await createRegularSource(workspaceDir, 'Workflows/checkpoints/source.glb')
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
    await createRegularSource(workspaceDir, 'Workflows/checkpoints/source.glb')
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
    await createRegularSource(workspaceDir, 'Workflows/checkpoints/source.glb')
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
    await createRegularSource(workspaceDir, 'Workflows/checkpoints/source.glb')
    await createRegularSource(workspaceDir, 'Workflows/checkpoints/other.glb')
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

test('returns invalid for malformed pose clip JSON, schema, skeleton, or keyframes instead of throwing', async () => {
  const readPoseClipSidecar = getPoseClipSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    await createRegularSource(workspaceDir, 'Workflows/checkpoints/source.glb')
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
    await createRegularSource(workspaceDir, 'Workflows/checkpoints/source.glb')
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

test('reads an adjacent UniRig rigmeta sidecar derived from a safe source mesh path', async () => {
  const readRigMetaSidecar = getRigMetaSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows'), { recursive: true })
    const sourceMesh = path.join(workspaceDir, 'Workflows', 'foo_unirig.glb')
    const rigMetaWorkspacePath = 'Workflows/foo_unirig.rigmeta.json'
    const rigMeta = rigMetaSidecar()
    await writeFile(sourceMesh, Buffer.from([0x67, 0x6c, 0x62]))
    await writeFile(path.join(workspaceDir, ...rigMetaWorkspacePath.split('/')), JSON.stringify(rigMeta, null, 2), 'utf-8')

    const result = await readRigMetaSidecar({ workspaceDir, sourceWorkspacePath: 'Workflows/foo_unirig.glb' })

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

test('returns not-found for a missing adjacent UniRig rigmeta sidecar without creating files', async () => {
  const readRigMetaSidecar = getRigMetaSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    await createRegularSource(workspaceDir, 'Workflows/foo_unirig.glb')
    const rigMetaWorkspacePath = 'Workflows/foo_unirig.rigmeta.json'

    const result = await readRigMetaSidecar({ workspaceDir, sourceWorkspacePath: 'Workflows/foo_unirig.glb' })

    assert.deepEqual(result, { success: true, status: 'not-found', rigMetaWorkspacePath })
    await assert.rejects(stat(path.join(workspaceDir, ...rigMetaWorkspacePath.split('/'))), /ENOENT/)
  })
})

test('returns invalid for malformed rigmeta JSON, unsupported schema, or output mesh mismatch', async () => {
  const readRigMetaSidecar = getRigMetaSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    await createRegularSource(workspaceDir, 'Workflows/foo_unirig.glb')
    await mkdir(path.join(workspaceDir, 'Workflows'), { recursive: true })
    const cases = [
      { sourceWorkspacePath: 'Workflows/invalid-json.glb', contents: '{not json', message: /json/i },
      { sourceWorkspacePath: 'Workflows/invalid-schema.glb', contents: JSON.stringify(rigMetaSidecar({ output_mesh: 'invalid-schema.glb', schema: 'unsupported.schema' })), message: /schema/i },
      { sourceWorkspacePath: 'Workflows/foo_unirig.glb', contents: JSON.stringify(rigMetaSidecar({ output_mesh: 'other_unirig.glb' })), message: /output_mesh|mismatch/i },
    ]

    for (const invalidCase of cases) {
      await createRegularSource(workspaceDir, invalidCase.sourceWorkspacePath)
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
    await createRegularSource(workspaceDir, 'Workflows/foo_unirig.glb')
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

test('artifact APIs reject inner symlinks even when they resolve inside the workspace', () => withTempWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'real'))
  await symlink(path.join(workspaceDir, 'real'), path.join(workspaceDir, 'alias'))
  const result = await writeArtifactSidecar({ workspaceDir, workspacePath: 'alias/mesh.glb', artifactId: 'mesh', metadata: {} })
  assert.equal(result.success, false)
  await assert.rejects(stat(path.join(workspaceDir, 'real/mesh.glb.artifact.json')), /ENOENT/)
}))

test('artifact reads reject sidecar symlinks, directories, malformed metadata, and wrong target binding', () => withTempWorkspace(async (workspaceDir) => {
  const sidecar = { artifactId: 'mesh', workspacePath: 'mesh.glb', metadata: {} }
  await writeFile(path.join(workspaceDir, 'real.json'), JSON.stringify(sidecar))
  await symlink(path.join(workspaceDir, 'real.json'), path.join(workspaceDir, 'mesh.glb.artifact.json'))
  assert.equal((await readArtifactSidecar({ workspaceDir, workspacePath: 'mesh.glb' })).success, false)
  await rm(path.join(workspaceDir, 'mesh.glb.artifact.json'))
  for (const invalid of [null, {}, { ...sidecar, workspacePath: 'other.glb' }, { ...sidecar, metadata: [] }]) {
    await writeFile(path.join(workspaceDir, 'mesh.glb.artifact.json'), JSON.stringify(invalid))
    assert.equal((await readArtifactSidecar({ workspaceDir, workspacePath: 'mesh.glb' })).success, false)
  }
}))

test('edited pair validates serialization before publishing either member', () => withTempWorkspace(async (workspaceDir) => {
  await writeFile(path.join(workspaceDir, 'source.glb'), 'source')
  const metadata: Record<string, unknown> = {}; metadata.circular = metadata
  const result = await writeEditedSceneArtifact({ workspaceDir, sourceWorkspacePath: 'source.glb', glbWorkspacePath: 'Workflows/edited/new.glb', sidecarWorkspacePath: 'Workflows/edited/new.json', bytes: new Uint8Array([1]), metadata })
  assert.equal(result.success, false)
  await assert.rejects(stat(path.join(workspaceDir, 'Workflows/edited/new.glb')), /ENOENT/)
}))

test('edited and landmark writes require an existing regular source', () => withTempWorkspace(async (workspaceDir) => {
  const edited = await writeEditedSceneArtifact({ workspaceDir, sourceWorkspacePath: 'missing.glb', glbWorkspacePath: 'Workflows/edited/new.glb', sidecarWorkspacePath: 'Workflows/edited/new.json', bytes: new Uint8Array([1]), metadata: {} })
  assert.equal(edited.success, false)
  const sidecar = landmarkSidecar()
  assert.equal((await writeLandmarkSidecar({ workspaceDir, sourceWorkspacePath: sidecar.target.meshPath!, sidecarWorkspacePath: sidecar.sidecarPath, sidecar })).success, false)
}))

test('landmark sidecar target and artifact linkage must agree', () => withTempWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Workflows/checkpoints'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/source.glb'), 'source')
  const sidecar = landmarkSidecar(); sidecar.artifacts.targetVersionId = 'another-version'
  assert.equal((await writeLandmarkSidecar({ workspaceDir, sourceWorkspacePath: sidecar.target.meshPath!, sidecarWorkspacePath: sidecar.sidecarPath, sidecar })).success, false)
}))

test('all source-bound sidecar operations reject missing, directory, and symlink sources', () => withTempWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Workflows/checkpoints'), { recursive: true })
  const source = path.join(workspaceDir, 'Workflows/checkpoints/source.glb')
  const capture = landmarkSidecar()
  const rig = rigRenameSidecar()
  const pose = poseClipSidecar()
  const sourceWorkspacePath = 'Workflows/checkpoints/source.glb'
  const operations = [
    () => writeEditedSceneArtifact({ workspaceDir, sourceWorkspacePath, glbWorkspacePath: 'Workflows/edited/a.glb', sidecarWorkspacePath: 'Workflows/edited/a.json', bytes: new Uint8Array([1]), metadata: {} }),
    () => writeLandmarkSidecar({ workspaceDir, sourceWorkspacePath, sidecarWorkspacePath: capture.sidecarPath, sidecar: capture }),
    () => artifactRegistryService.writeRigRenameSidecar({ workspaceDir, sourceWorkspacePath, sidecarWorkspacePath: 'Workflows/rig-edits/a.rig.v1.json', sidecar: rig }),
    () => readRigRenameSidecar({ workspaceDir, sourceWorkspacePath, sidecarWorkspacePath: 'Workflows/rig-edits/a.rig.v1.json' }),
    () => writePoseClipSidecar({ workspaceDir, sourceWorkspacePath, sidecarWorkspacePath: 'Workflows/pose-clips/a.pose-clip.v1.json', sidecar: pose }),
    () => readPoseClipSidecar({ workspaceDir, sourceWorkspacePath, sidecarWorkspacePath: 'Workflows/pose-clips/a.pose-clip.v1.json' }),
    () => readRigMetaSidecar({ workspaceDir, sourceWorkspacePath }),
  ]
  for (const kind of ['missing', 'directory', 'symlink', 'broken-link']) {
    if (kind === 'directory') await mkdir(source)
    if (kind === 'symlink') {
      await writeFile(path.join(workspaceDir, 'real.glb'), 'original')
      await symlink(path.join(workspaceDir, 'real.glb'), source)
    }
    if (kind === 'broken-link') await symlink(path.join(workspaceDir, 'absent.glb'), source)
    for (const operation of operations) assert.equal((await operation()).success, false, kind)
    if (kind !== 'missing') await rm(source, { recursive: true })
  }
}))

test('sidecar output ancestors and leaves reject symlinks and non-regular files', () => withTempWorkspace(async (workspaceDir) => {
  await createRegularSource(workspaceDir, 'Workflows/checkpoints/source.glb')
  const target = path.join(workspaceDir, 'Workflows/rig-edits')
  const actual = path.join(workspaceDir, 'actual'); await mkdir(actual)
  await symlink(actual, target)
  const request = { workspaceDir, sourceWorkspacePath: 'Workflows/checkpoints/source.glb', sidecarWorkspacePath: 'Workflows/rig-edits/a.rig.v1.json', sidecar: rigRenameSidecar() }
  assert.equal((await artifactRegistryService.writeRigRenameSidecar(request)).success, false)
  await rm(target); await mkdir(target)
  const leaf = path.join(target, 'a.rig.v1.json')
  await symlink(path.join(actual, 'absent.json'), leaf)
  assert.equal((await artifactRegistryService.writeRigRenameSidecar(request)).success, false)
  assert.equal((await readRigRenameSidecar(request)).success, false)
  await rm(leaf); await mkdir(leaf)
  assert.equal((await artifactRegistryService.writeRigRenameSidecar(request)).success, false)
  assert.equal((await readRigRenameSidecar(request)).success, false)
}))

test('configured trusted root may be a symlink while descendants remain confined', () => withTempWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'actual'))
  await symlink(path.join(workspaceDir, 'actual'), path.join(workspaceDir, 'configured'))
  const configured = path.join(workspaceDir, 'configured')
  const result = await writeArtifactSidecar({ workspaceDir: configured, workspacePath: 'collection/deep/mesh.glb', artifactId: 'mesh', metadata: { revision: 1 } })
  assert.equal(result.success, true)
  assert.equal((await readArtifactSidecar({ workspaceDir: configured, workspacePath: 'collection/deep/mesh.glb' })).success, true)
}))

test('deterministic sidecar updates use collision-safe owned temporary files', () => withTempWorkspace(async (workspaceDir) => {
  const { readdir } = await import('node:fs/promises')
  const request = { workspaceDir, workspacePath: 'collection/mesh.glb', artifactId: 'mesh' }
  const results = await Promise.all(Array.from({ length: 8 }, (_, revision) => writeArtifactSidecar({ ...request, metadata: { revision } })))
  assert.equal(results.every((result) => result.success), true)
  const loaded = await readArtifactSidecar(request)
  assert.equal(loaded.success, true)
  assert.deepEqual(await readdir(path.join(workspaceDir, 'collection')), ['mesh.glb.artifact.json'])
}))

test('all nine artifact IPC handlers reject unknown payloads and coexist with library channels', () => withTempWorkspace(async (workspaceDir) => {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>()
  const ipcMain = { handle: (channel: string, handler: (event: unknown, payload?: unknown) => Promise<unknown>) => {
    assert.equal(handlers.has(channel), false, channel)
    handlers.set(channel, handler)
  } }
  registerWorkspaceAssetLibraryIpcHandlers({ ipcMain, getWorkspaceDir: () => workspaceDir })
  registerArtifactRegistryIpcHandlers({ ipcMain, getWorkspaceDir: () => workspaceDir })
  assert.equal(handlers.size, 12)
  for (const [channel, handler] of handlers) {
    if (!channel.startsWith('workspace:artifact:')) continue
    for (const invalid of [null, [], false, 'path', {}]) {
      assert.equal((await handler(undefined, invalid) as { success: boolean }).success, false, channel)
    }
  }
}))

test('rigmeta rejects another directory with the same mesh basename', () => withTempWorkspace(async (workspaceDir) => {
  await createRegularSource(workspaceDir, 'Workflows/foo_unirig.glb')
  for (const output_mesh of ['other/foo_unirig.glb', '/outside/foo_unirig.glb', '../foo_unirig.glb']) {
    await writeFile(path.join(workspaceDir, 'Workflows/foo_unirig.rigmeta.json'), JSON.stringify(rigMetaSidecar({ output_mesh })))
    assert.equal((await readRigMetaSidecar({ workspaceDir, sourceWorkspacePath: 'Workflows/foo_unirig.glb' })).success, false)
  }
}))

async function loadArtifactServiceWithFs(overrides: Record<string, unknown>) {
  const { build } = await import('esbuild')
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  const built = await build({ entryPoints: [path.join(import.meta.dirname, 'artifact-registry-service.ts')], bundle: true, write: false, platform: 'node', format: 'cjs' })
  const module = { exports: {} as typeof import('./artifact-registry-service') }
  const injectedRequire = (id: string) => id === 'node:fs/promises' ? { ...require(id), ...overrides } : require(id)
  // Production bundle has no import.meta; the outer test stays ESM and shares Promise/ArrayBuffer realms.
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(injectedRequire, module, module.exports)
  return module.exports
}

test('second-file publish failure rolls back only the owned GLB and preserves another writer sidecar', () => withTempWorkspace(async (workspaceDir) => {
  const fs = await import('node:fs/promises')
  await createRegularSource(workspaceDir, 'source.glb')
  const writer = await loadArtifactServiceWithFs({ link: async (source: string, destination: string) => {
    if (destination.endsWith('.json')) {
      await fs.writeFile(destination, 'another writer owns this', { flag: 'wx' })
      throw Object.assign(new Error('Injected second-file collision'), { code: 'EEXIST' })
    }
    return fs.link(source, destination)
  } })
  const result = await writer.writeEditedSceneArtifact({ workspaceDir, sourceWorkspacePath: 'source.glb', glbWorkspacePath: 'Workflows/edited/new.glb', sidecarWorkspacePath: 'Workflows/edited/new.json', bytes: new Uint8Array([1]), metadata: {} })
  assert.equal(result.success, false)
  await assert.rejects(stat(path.join(workspaceDir, 'Workflows/edited/new.glb')), /ENOENT/)
  assert.equal(await readFile(path.join(workspaceDir, 'Workflows/edited/new.json'), 'utf8'), 'another writer owns this')
  assert.deepEqual(await fs.readdir(path.join(workspaceDir, 'Workflows/edited')), ['new.json'])
  assert.equal(await readFile(path.join(workspaceDir, 'source.glb'), 'utf8'), 'owned regular source fixture')
}))

test('temporary-file preparation failure leaves no pair members and no owned temporary files', () => withTempWorkspace(async (workspaceDir) => {
  const fs = await import('node:fs/promises')
  await createRegularSource(workspaceDir, 'source.glb')
  let writes = 0
  const writer = await loadArtifactServiceWithFs({ writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
    if (++writes === 2) throw new Error('Injected sidecar write failure')
    return fs.writeFile(...args)
  } })
  const result = await writer.writeEditedSceneArtifact({ workspaceDir, sourceWorkspacePath: 'source.glb', glbWorkspacePath: 'Workflows/edited/new.glb', sidecarWorkspacePath: 'Workflows/edited/new.json', bytes: new Uint8Array([1]), metadata: {} })
  assert.equal(result.success, false)
  assert.deepEqual(await fs.readdir(path.join(workspaceDir, 'Workflows/edited')), [])
}))

test('sidecar validators validate serialized payloads, not just the pre-serialization object', () => withTempWorkspace(async (workspaceDir) => {
  await createRegularSource(workspaceDir, 'Workflows/checkpoints/source.glb')
  const sidecar = { ...landmarkSidecar(), toJSON: () => ({ schema: 'wrong' }) }
  const result = await writeLandmarkSidecar({ workspaceDir, sourceWorkspacePath: 'Workflows/checkpoints/source.glb', sidecarWorkspacePath: sidecar.sidecarPath, sidecar })
  assert.equal(result.success, false)
  await assert.rejects(stat(path.join(workspaceDir, sidecar.sidecarPath)), /ENOENT/)
}))

test('landmark payloads reject duplicate identifiers and non-finite coordinates before creating files', () => withTempWorkspace(async (workspaceDir) => {
  await createRegularSource(workspaceDir, 'Workflows/checkpoints/source.glb')
  for (const kind of ['duplicate', 'nonfinite', 'wrong-kind', 'wrong-source']) {
    const sidecar = landmarkSidecar()
    if (kind === 'duplicate') sidecar.landmarks[1] = sidecar.landmarks[0]
    if (kind === 'nonfinite') sidecar.landmarks[0].world.x = Number.NaN
    if (kind === 'wrong-kind') (sidecar.target as { kind: string }).kind = 'image'
    if (kind === 'wrong-source') sidecar.target.meshPath = 'Workflows/checkpoints/other.glb'
    const result = await writeLandmarkSidecar({ workspaceDir, sourceWorkspacePath: 'Workflows/checkpoints/source.glb', sidecarWorkspacePath: sidecar.sidecarPath, sidecar })
    assert.equal(result.success, false, kind)
    await assert.rejects(stat(path.join(workspaceDir, sidecar.sidecarPath)), /ENOENT/)
  }
}))

test('artifact reads reject FIFO leaves without blocking', { skip: process.platform === 'win32' }, () => withTempWorkspace(async (workspaceDir) => {
  const { execFileSync } = await import('node:child_process')
  execFileSync('mkfifo', [path.join(workspaceDir, 'mesh.glb.artifact.json')])
  assert.equal((await readArtifactSidecar({ workspaceDir, workspacePath: 'mesh.glb' })).success, false)
}))

test('external inner symlinks never read or overwrite the external target', () => withTempWorkspace(async (workspaceDir) => withTempWorkspace(async (outside) => {
  await writeFile(path.join(outside, 'mesh.glb.artifact.json'), 'external bytes')
  await symlink(outside, path.join(workspaceDir, 'external'))
  assert.equal((await readArtifactSidecar({ workspaceDir, workspacePath: 'external/mesh.glb' })).success, false)
  assert.equal((await writeArtifactSidecar({ workspaceDir, workspacePath: 'external/mesh.glb', artifactId: 'mesh', metadata: {} })).success, false)
  assert.equal(await readFile(path.join(outside, 'mesh.glb.artifact.json'), 'utf8'), 'external bytes')
})))

for (const kind of ['rig', 'pose'] as const) {
  test(`${kind} sidecar refuses different same-basename owner and malformed existing records without changing bytes`, () => withTempWorkspace(async (workspaceDir) => {
    const writer = kind === 'rig' ? artifactRegistryService.writeRigRenameSidecar : writePoseClipSidecar
    const makeSidecar = kind === 'rig' ? rigRenameSidecar : poseClipSidecar
    const sidecarWorkspacePath = kind === 'rig' ? 'Workflows/rig-edits/hero-rig-aliases.rig.v1.json' : 'Workflows/pose-clips/hero.pose-clip.v1.json'
    const sourceA = 'A/hero.glb'; const sourceB = 'B/hero.glb'
    await createRegularSource(workspaceDir, sourceA); await createRegularSource(workspaceDir, sourceB)
    const request = (sourceWorkspacePath: string) => ({ workspaceDir, sourceWorkspacePath, sidecarWorkspacePath, sidecar: makeSidecar({ source: { workspacePath: sourceWorkspacePath } }) })
    assert.equal((await writer(request(sourceA))).success, true)
    const target = path.join(workspaceDir, sidecarWorkspacePath); const before = await readFile(target)
    const rejected = await writer(request(sourceB))
    assert.equal(rejected.success, false)
    assert.match(!rejected.success ? rejected.error : '', /owner|different source/i)
    assert.deepEqual(await readFile(target), before)
    assert.equal((await writer(request(sourceA))).success, true)
    for (const contents of ['{bad', '{}', JSON.stringify({ source: { workspacePath: sourceA } })]) {
      await writeFile(target, contents)
      const invalid = await writer(request(sourceA))
      assert.equal(invalid.success, false)
      assert.match(!invalid.success ? invalid.error : '', /owner|existing/i)
      assert.equal(await readFile(target, 'utf8'), contents)
    }
    for (const source of [sourceA, sourceB]) assert.equal(await readFile(path.join(workspaceDir, source), 'utf8'), 'owned regular source fixture')
  }))

  test(`${kind} sidecar serializes concurrent destination ownership while allowing same-owner updates`, () => withTempWorkspace(async (workspaceDir) => {
    const fs = await import('node:fs/promises')
    const writer = kind === 'rig' ? artifactRegistryService.writeRigRenameSidecar : writePoseClipSidecar
    const makeSidecar = kind === 'rig' ? rigRenameSidecar : poseClipSidecar
    const sidecarWorkspacePath = kind === 'rig' ? 'Workflows/rig-edits/hero.rig.v1.json' : 'Workflows/pose-clips/hero.pose-clip.v1.json'
    const sources = ['A/hero.glb', 'B/hero.glb']; for (const source of sources) await createRegularSource(workspaceDir, source)
    const request = (sourceWorkspacePath: string, revision = 0) => ({ workspaceDir, sourceWorkspacePath, sidecarWorkspacePath, sidecar: makeSidecar({ source: { workspacePath: sourceWorkspacePath }, createdAt: `revision-${revision}` }) })
    const results = await Promise.all(sources.map((source) => writer(request(source))))
    assert.equal(results.filter((result) => result.success).length, 1)
    const winner = sources[results.findIndex((result) => result.success)]
    const loaded = JSON.parse(await readFile(path.join(workspaceDir, sidecarWorkspacePath), 'utf8'))
    assert.equal(loaded.source.workspacePath, winner)
    const sameOwner = await Promise.all(Array.from({ length: 8 }, (_, revision) => writer(request(winner, revision))))
    assert.equal(sameOwner.every((result) => result.success), true)
    assert.deepEqual(await fs.readdir(path.dirname(path.join(workspaceDir, sidecarWorkspacePath))), [path.basename(sidecarWorkspacePath)])
  }))
}

for (const kind of ['rig', 'pose'] as const) {
  test(`${kind} ownership queue releases after failed publication and unreadable existing content`, () => withTempWorkspace(async (workspaceDir) => {
    const fs = await import('node:fs/promises')
    let failRename = true; let failRead = false
    let releaseFirst!: () => void; let enteredFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve })
    let pathCalls = 0
    const service = await loadArtifactServiceWithFs({
      realpath: async (...args: Parameters<typeof fs.realpath>) => {
        if (++pathCalls === 1) { enteredFirst(); await firstGate }
        return fs.realpath(...args)
      },
      rename: async (...args: Parameters<typeof fs.rename>) => {
        if (failRename) { failRename = false; throw new Error('Injected publish failure') }
        return fs.rename(...args)
      },
      open: async (...args: Parameters<typeof fs.open>) => {
        if (failRead) throw Object.assign(new Error('Injected owner read failure'), { code: 'EACCES' })
        return fs.open(...args)
      },
    })
    const writer = kind === 'rig' ? service.writeRigRenameSidecar : service.writePoseClipSidecar
    const sidecarWorkspacePath = kind === 'rig' ? 'Workflows/rig-edits/hero.rig.v1.json' : 'Workflows/pose-clips/hero.pose-clip.v1.json'
    const sidecar = (kind === 'rig' ? rigRenameSidecar : poseClipSidecar)({ source: { workspacePath: 'A/hero.glb' } })
    await createRegularSource(workspaceDir, 'A/hero.glb')
    const request = { workspaceDir, sourceWorkspacePath: 'A/hero.glb', sidecarWorkspacePath, sidecar }
    const requests = [
      { ...request, sidecar: { ...sidecar, createdAt: 'first-caller' } },
      { ...request, sidecar: { ...sidecar, createdAt: 'second-caller' } },
    ]
    const first = writer(requests[0])
    await firstEntered
    // Force the second caller to reach publication first; queue arrival is after IO.
    const second = await writer(requests[1])
    releaseFirst()
    const results = [await first, second]
    assert.equal(results.filter((result) => result.success).length, 1)
    const failed = results.find((result) => !result.success)
    assert.ok(failed && !failed.success)
    assert.match(failed.error, /Injected publish failure/)
    const winner = requests[results.findIndex((result) => result.success)]
    const target = path.join(workspaceDir, sidecarWorkspacePath); const before = await readFile(target)
    assert.deepEqual(JSON.parse(before.toString()), JSON.parse(JSON.stringify(winner.sidecar)))
    failRead = true
    assert.equal((await writer(request)).success, false)
    assert.deepEqual(await readFile(target), before)
    failRead = false
    assert.equal((await writer(request)).success, true)
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), JSON.parse(JSON.stringify(request.sidecar)))
    assert.deepEqual(await fs.readdir(path.dirname(target)), [path.basename(target)])
  }))

  test(`${kind} ownership key covers physical-root aliases but not different workspaces`, () => withTempWorkspace(async (parent) => {
    const roots = [path.join(parent, 'one'), path.join(parent, 'two')]
    for (const root of roots) { await mkdir(root); await createRegularSource(root, 'A/hero.glb'); await createRegularSource(root, 'B/hero.glb') }
    const alias = path.join(parent, 'alias'); await symlink(roots[0], alias)
    const writer = kind === 'rig' ? artifactRegistryService.writeRigRenameSidecar : writePoseClipSidecar
    const makeSidecar = kind === 'rig' ? rigRenameSidecar : poseClipSidecar
    const sidecarWorkspacePath = kind === 'rig' ? 'Workflows/rig-edits/hero.rig.v1.json' : 'Workflows/pose-clips/hero.pose-clip.v1.json'
    const request = (workspaceDir: string, sourceWorkspacePath: string) => ({ workspaceDir, sourceWorkspacePath, sidecarWorkspacePath, sidecar: makeSidecar({ source: { workspacePath: sourceWorkspacePath } }) })
    const results = await Promise.all([writer(request(roots[0], 'A/hero.glb')), writer(request(alias, 'B/hero.glb'))])
    assert.equal(results.filter((result) => result.success).length, 1)
    const differentRoot = await writer(request(roots[1], 'B/hero.glb'))
    assert.equal(differentRoot.success, true)
    assert.equal(JSON.parse(await readFile(path.join(roots[1], sidecarWorkspacePath), 'utf8')).source.workspacePath, 'B/hero.glb')
  }))
}


test('last alias cancel and revert persist an empty same-source v1 plan and hydrate without resurrection', () => withTempWorkspace(async (workspaceDir) => {
  // These are real renderer modules at runtime, not additions to the node TS project.
  const rename = await import(new URL('../../src/areas/generate/rigRenamePlan.ts', import.meta.url).href)
  const { collectRigSkeletonSummary } = await import(new URL('../../src/areas/generate/rigSkeleton.ts', import.meta.url).href)
  const sourceWorkspacePath = 'A/hero.glb'
  await createRegularSource(workspaceDir, sourceWorkspacePath)
  await createRegularSource(workspaceDir, 'B/hero.glb')
  const summary = collectRigSkeletonSummary({ sourceWorkspacePath, skinnedMeshes: [{ name: 'Body', skeleton: { bones: [{ name: 'Hips' }] } }] })
  const boneId = summary.bones[0].boneId
  const aliased = rename.reduceRigRenamePlan(summary, rename.createRigRenamePlan(summary), { type: 'set-alias', boneId, alias: 'Pelvis' })
  const sidecarWorkspacePath = rename.createRigRenameSidecarWorkspacePath(sourceWorkspacePath)
  const request = { workspaceDir, sourceWorkspacePath, sidecarWorkspacePath }
  const writer = artifactRegistryService.writeRigRenameSidecar
  const target = path.join(workspaceDir, sidecarWorkspacePath)
  for (const action of [{ type: 'cancel-alias', boneId }, { type: 'revert-all' }] as const) {
    assert.equal((await writer({ ...request, sidecar: rename.buildRigRenameSidecarV1({ summary, plan: aliased }) })).success, true)
    const cleared = rename.reduceRigRenamePlan(summary, aliased, action)
    const emptySidecar = rename.buildRigRenameSidecarV1({ summary, plan: cleared })
    assert.deepEqual(emptySidecar.aliases, {}); assert.deepEqual(emptySidecar.skeleton.bones, [])
    const saved = await writer({ ...request, sidecar: emptySidecar })
    assert.equal(saved.success, true)
    const read = await readRigRenameSidecar(request)
    assert.ok(read.success && read.status === 'found')
    const hydrated = rename.hydrateRigRenamePlanFromSidecar(summary, read.sidecar, { sourceWorkspacePath })
    assert.equal(hydrated.valid, true); assert.deepEqual(hydrated.plan.aliases, {})
    const persisted = await readFile(target)
    assert.deepEqual(JSON.parse(persisted.toString()), JSON.parse(JSON.stringify(emptySidecar)))
    assert.equal((await writer({ ...request, sidecar: emptySidecar })).success, true)
    const foreign = await writer({ ...request, sourceWorkspacePath: 'B/hero.glb', sidecar: { ...emptySidecar, source: { workspacePath: 'B/hero.glb' } } })
    assert.equal(foreign.success, false)
    assert.deepEqual(await readFile(target), persisted)
    for (const invalid of [
      { ...emptySidecar, aliases: [] }, { ...emptySidecar, skeletonContextId: '' },
      { ...emptySidecar, source: {} }, { ...emptySidecar, skeleton: { ...emptySidecar.skeleton, boneCount: 0 } },
      { ...emptySidecar, aliases: aliased.aliases },
    ]) {
      assert.equal((await writer({ ...request, sidecar: invalid as never })).success, false)
      assert.deepEqual(await readFile(target), persisted)
    }
  }
  assert.equal(await readFile(path.join(workspaceDir, sourceWorkspacePath), 'utf8'), 'owned regular source fixture')
  assert.equal(await readFile(path.join(workspaceDir, 'B/hero.glb'), 'utf8'), 'owned regular source fixture')
}))

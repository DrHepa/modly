import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, lstat, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  classifyAssetLibraryCandidate,
  resolveAssetLibraryEntryTimestamps,
  normalizeWorkspaceAssetPath,
  listWorkspaceAssetLibrary,
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
  assert.throws(() => normalizeWorkspaceAssetPath(workspaceDir, '/tmp/secret.glb'), /absolute|relative/i)
  assert.throws(() => normalizeWorkspaceAssetPath(workspaceDir, 'Workflows/%2e%2e/secret.glb'), /encoded/i)
  assert.throws(() => normalizeWorkspaceAssetPath(workspaceDir, 'Collections/hero.glb'), /allowed workspace library roots/i)
}))

test('classifies supported assets by capability instead of extension category', () => {
  assert.deepEqual(classifyAssetLibraryCandidate({ workspacePath: 'Workflows/a.glb' }), { capability: 'mesh', state: 'ready' })
  assert.deepEqual(classifyAssetLibraryCandidate({ workspacePath: 'Workflows/rigged.gltf', evidence: { rigMeta: true } }), { capability: 'rigged-mesh', state: 'ready' })
  assert.equal(classifyAssetLibraryCandidate({ workspacePath: 'Workflows/motion.bvh', evidence: { intrinsicMotionFile: true } }).capability, 'animation-motion')
  assert.equal(classifyAssetLibraryCandidate({ workspacePath: 'Workflows/scan.splat', previewKind: 'binary' }).state, 'unsupported')
  assert.equal(classifyAssetLibraryCandidate({ workspacePath: 'Workflows/notes.txt', previewKind: 'text' }).state, 'unsupported')
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
  assert.equal(result.success && result.entries.find((entry) => entry.workspacePath.endsWith('exported.ply'))?.previewKind, 'binary')
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

test('optional manifest inspection skips oversized generic JSON without weakening sidecar budgets or path guards', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Workflows'), { recursive: true })
  const workspacePath = 'Workflows/source-geometry.json'
  const oversized = '{}' + ' '.repeat(8 * 1024 * 1024)
  await writeFile(path.join(workspaceDir, workspacePath), oversized)
  await writeArtifactSidecar({ workspaceDir, workspacePath, artifactId: 'source-geometry', metadata: { artifactKind: 'mesh' } })
  await writeFile(path.join(workspaceDir, 'Workflows/scene-manifest.json'), JSON.stringify({ schema: 'modly.scene-manifest.v1', sceneRoot: '.', assets: [] }))

  const listed = await listWorkspaceAssetLibrary({ workspaceDir })
  assertSuccessfulAssetLibraryList(listed)
  const entry = listed.entries.find((entry) => entry.workspacePath === workspacePath)
  assert.ok(entry)
  assert.equal(entry.manifest, undefined)
  assert.ok(entry.warnings.some((warning) => /Skipped optional manifest inspection.*inspection limit/.test(warning)))
  assert.equal(listed.entries.find((entry) => entry.workspacePath === 'Workflows/scene-manifest.json')?.capability, 'scene-manifest')
  assert.equal((await readWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: '../outside.json' })).success, false)

  await writeFile(path.join(workspaceDir, `${workspacePath}.artifact.json`), oversized)
  const blocked = await listWorkspaceAssetLibrary({ workspaceDir })
  assert.equal(blocked.success, false, 'required sidecar evidence keeps its bounded reader')
  if (!blocked.success) assert.match(blocked.error, /Library metadata exceeds inspection limit/)
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
  assert.equal(opened.success && opened.entry.previewKind, '3d-model')
  const blocked = await openWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: 'Exports/static.ply' })
  assert.equal(blocked.success, false)
  assert.equal(!blocked.success && typeof blocked.error, 'string')
  const unsafe = await readWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: '../secret.glb' })
  assert.equal(unsafe.success, false)
  assert.equal(!unsafe.success && typeof unsafe.error, 'string')
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
    assert.equal(!read.success && typeof read.error, 'string')
    assert.equal(opened.success, false, `${workspacePath} should be rejected for open`)
    assert.equal(!opened.success && typeof opened.error, 'string')
  }
}))

test('Electron read/open boundary rejects Windows absolute and UNC sourceWorkspacePath values', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Workflows/checkpoints'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.glb'), 'glb')
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.landmarks.v1.json'), JSON.stringify(landmarkSidecar({ sidecarPath: 'Workflows/checkpoints/hero.landmarks.v1.json', target: { ...landmarkSidecar().target, meshPath: 'Workflows/checkpoints/hero.glb' } })))

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
    assert.equal(!read.success && typeof read.error, 'string')
    assert.equal(opened.success, false, `${sourceWorkspacePath} should be rejected as open source`)
    assert.equal(!opened.success && typeof opened.error, 'string')
  }
}))

test('enriches canonical manifests with registry source, artifact, version, and provenance metadata', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Workflows/checkpoints'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.glb'), 'glb')
  const workspacePath = 'Workflows/checkpoints/hero.scene.json'
  await writeFile(path.join(workspaceDir, workspacePath), JSON.stringify({ schema: 'modly.scene-manifest.v1' }))
  await writeArtifactSidecar({ workspaceDir, workspacePath, artifactId: 'artifact-hero', metadata: {
    source: { workspacePath: 'Workflows/checkpoints/hero.glb' }, versionId: 'version-1',
    provenance: { workflowId: 'wf-1', workflowNodeId: 'node-1' },
  } })
  const read = await readWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath })
  assert.equal(read.success, true)
  if (!read.success) return
  assert.equal(read.entry.source?.workspacePath, 'Workflows/checkpoints/hero.glb')
  assert.equal(read.entry.manifest?.workspacePath, workspacePath)
  assert.equal(read.entry.manifest?.capability, 'scene-manifest')
  assert.equal(read.entry.artifactId, 'artifact-hero')
  assert.equal(read.entry.versionId, 'version-1')
  assert.equal(read.entry.provenance?.workflowId, 'wf-1')
}))

test('fails closed for unsafe, self, missing, and mismatched sourceWorkspacePath opens', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Workflows/checkpoints'), { recursive: true })
  await mkdir(path.join(workspaceDir, 'Workflows/landmarks'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.glb'), 'glb')
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/other.glb'), 'glb')
  await writeFile(path.join(workspaceDir, 'Workflows/landmarks/hero.landmarks.v1.json'), JSON.stringify(landmarkSidecar({ sidecarPath: 'Workflows/landmarks/hero.landmarks.v1.json', target: { ...landmarkSidecar().target, meshPath: 'Workflows/checkpoints/hero.glb' } })))
  await writeFile(path.join(workspaceDir, 'Workflows/landmarks/self.landmarks.v1.json'), JSON.stringify(landmarkSidecar({ sidecarPath: 'Workflows/landmarks/self.landmarks.v1.json', target: { ...landmarkSidecar().target, meshPath: 'Workflows/landmarks/self.landmarks.v1.json' } })))
  await writeFile(path.join(workspaceDir, 'Workflows/landmarks/missing.landmarks.v1.json'), JSON.stringify(landmarkSidecar({ sidecarPath: 'Workflows/landmarks/missing.landmarks.v1.json', target: { ...landmarkSidecar().target, meshPath: 'Workflows/checkpoints/missing.glb' } })))

  const opened = await openWorkspaceAssetLibraryEntry({
    workspaceDir,
    workspacePath: 'Workflows/landmarks/hero.landmarks.v1.json',
    sourceWorkspacePath: 'Workflows/checkpoints/hero.glb',
  })
  assert.equal(opened.success, true)
  assert.equal(opened.success && opened.entry.source?.workspacePath, 'Workflows/checkpoints/hero.glb')

  const unsafe = await openWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: 'Workflows/landmarks/hero.landmarks.v1.json', sourceWorkspacePath: '../secret.glb' })
  const self = await openWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: 'Workflows/landmarks/self.landmarks.v1.json', sourceWorkspacePath: 'Workflows/landmarks/self.landmarks.v1.json' })
  const missing = await openWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: 'Workflows/landmarks/missing.landmarks.v1.json', sourceWorkspacePath: 'Workflows/checkpoints/missing.glb' })
  const mismatched = await openWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: 'Workflows/landmarks/hero.landmarks.v1.json', sourceWorkspacePath: 'Workflows/checkpoints/other.glb' })

  assert.equal(unsafe.success, false)
  assert.equal(!unsafe.success && typeof unsafe.error, 'string')
  assert.equal(self.success, false)
  assert.equal(!self.success && typeof self.error, 'string')
  assert.equal(missing.success, false)
  assert.equal(!missing.success && typeof missing.error, 'string')
  assert.equal(mismatched.success, false)
  assert.equal(!mismatched.success && typeof mismatched.error, 'string')
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
  assert.equal(typeof (result as { success: boolean, error?: string }).error, 'string')
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
  assert.equal(typeof (result as { success: boolean, error?: string }).error, 'string')
})

import {
  downloadWorkspaceArtifact,
  getHumanoidDraftWorkspacePath,
  getHumanoidPromotionWorkspacePath,
  getArtifactSidecarWorkspacePath,
  normalizeAssetLibraryReadRequest,
  normalizeWorkspaceArtifactPath,
  previewWorkspaceArtifact,
  readHumanoidDraftSidecar,
  readHumanoidPromotionSidecar,
  readPoseClipSidecar,
  readRigMetaSidecar,
  readRigRenameSidecar,
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

function motionRetargetSidecar<T extends Record<string, unknown> = Record<never, never>>(overrides: T = {} as T) {
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

function humanoidRigMetaSidecar() {
  return rigMetaSidecar({ output_mesh: 'hero_unirig.glb', source: { workspacePath: 'Workflows/sources/source.glb' } })
}

function humanoidContentReceipt(draft: object): string {
  const sort = (value: any): any => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)])) : value
  const payload = Object.fromEntries(Object.entries(draft).filter(([key]) => !['draftSha256', 'draftContentSha256'].includes(key)))
  return sha256(JSON.stringify(sort(payload)))
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
    rigmetaSha256: sha256(JSON.stringify(humanoidRigMetaSidecar(), null, 2)),
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
    rigmetaSha256: sha256(JSON.stringify(humanoidRigMetaSidecar(), null, 2)),
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
      name: 'audio stays indexed as unknown metadata instead of being dropped',
      input: { workspacePath: 'Workflows/audio/theme.ogg', previewKind: 'audio' },
      expected: { capability: undefined, state: 'unknown-metadata' },
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
      workspacePath: 'Workflows/generated/hero.glb',
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
      JSON.stringify(rigMetaSidecar({ output_mesh: 'hero.glb', source: { workspacePath: 'Workflows/generated/hero.glb' } }), null, 2),
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

    await createRegularSource(workspaceDir, 'Workflows/checkpoints/source.glb')
    const result = await listWorkspaceAssetLibrary({ workspaceDir })

    assertSuccessfulAssetLibraryList(result)

    const byPath = new Map(result.entries.map(({ createdAt, updatedAt, ...entry }) => {
      assert.ok(Number.isFinite(Date.parse(createdAt!)))
      assert.ok(Number.isFinite(Date.parse(updatedAt!)))
      return [entry.workspacePath, entry]
    }))
    assert.equal(byPath.has('Workflows/generated/hero.glb.artifact.json'), false)
    assert.equal(byPath.has('Workflows/generated/hero.rigmeta.json'), false)

    assert.deepEqual(byPath.get('Workflows/generated/hero.glb'), {
      id: 'library:Workflows/generated/hero.glb',
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
      source: { relation: 'derived-from', degraded: true },
      previewKind: '3d-model',
      warnings: [
        'sidecar-warning',
        'Ignored unsafe, missing, self-linked or non-viewable library source.',
      ],
    })

    assert.deepEqual(byPath.get(motionSidecarPath), {
      id: `library:${motionSidecarPath}`,
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

    assert.deepEqual(byPath.get(landmarkPath), {
      id: `library:${landmarkPath}`,
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

    assert.deepEqual(byPath.get(worldWorkspacePath), {
      id: `library:${worldWorkspacePath}`,
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

    assert.deepEqual(byPath.get('Workflows/generated/mystery.glb'), {
      id: 'library:Workflows/generated/mystery.glb',
      workspacePath: 'Workflows/generated/mystery.glb',
      displayName: 'mystery.glb',
      sourceScope: 'workflows',
      capability: 'mesh',
      state: 'ready',
      previewKind: '3d-model',
      warnings: [],
    })

    assert.deepEqual(byPath.get('Workflows/generated/mystery.gltf'), {
      id: 'library:Workflows/generated/mystery.gltf',
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
      assert.deepEqual(byPath.get(workspacePath), {
        id: `library:${workspacePath}`,
        workspacePath,
        displayName: expectedName,
        ...(workspacePath.endsWith('.ply') ? { plyHeader: { status: 'complete', content: 'ply\nformat ascii 1.0\nend_header\n' } } : {}),
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

    assert.deepEqual(result.entries.map(({ createdAt, updatedAt, ...entry }) => entry), [
      {
        id: 'library:Workflows/generated/opaque-bundle',
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

test('asset library timestamp fallback accepts only positive representable dates without fabricating metadata', () => {
  const birthtimeMs = Date.parse('2026-06-10T00:00:00.000Z')
  const mtimeMs = Date.parse('2026-06-10T00:05:00.000Z')
  const createdAt = new Date(birthtimeMs).toISOString()
  const updatedAt = new Date(mtimeMs).toISOString()
  assert.deepEqual(resolveAssetLibraryEntryTimestamps({ birthtimeMs, mtimeMs }), { createdAt, updatedAt })
  for (const invalid of [0.5, 0, -1, NaN, Infinity, -Infinity, 8_640_000_000_000_001, Number.MAX_VALUE]) {
    assert.deepEqual(resolveAssetLibraryEntryTimestamps({ birthtimeMs: invalid, mtimeMs }), {
      createdAt: updatedAt, updatedAt,
    }, `Creation falls back from ${invalid} to modification`)
    assert.deepEqual(resolveAssetLibraryEntryTimestamps({ birthtimeMs, mtimeMs: invalid }), {
      createdAt, updatedAt: createdAt,
    }, `Modification falls back from ${invalid} to creation`)
    assert.deepEqual(resolveAssetLibraryEntryTimestamps({ birthtimeMs: invalid, mtimeMs: invalid }), {}, `No timestamp for ${invalid}`)
  }
  assert.deepEqual(resolveAssetLibraryEntryTimestamps({ birthtimeMs: 1, mtimeMs: 8_640_000_000_000_000 }), {
    createdAt: '1970-01-01T00:00:00.001Z', updatedAt: '+275760-09-13T00:00:00.000Z',
  })
})

test('lists, reads and opens workspace asset library entries with timestamps from physically checked file stats', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'generated'), { recursive: true })
    const workspacePath = 'Workflows/generated/dated.glb'
    const absolutePath = path.join(workspaceDir, 'Workflows', 'generated', 'dated.glb')
    await writeFile(absolutePath, buildMinimalGlb({ asset: { version: '2.0' } }))

    const result = await listWorkspaceAssetLibrary({ workspaceDir })

    assertSuccessfulAssetLibraryList(result)

    const entry = result.entries.find((candidate) => candidate.workspacePath === workspacePath)
    assert.ok(entry, 'expected dated asset entry to be listed')

    const fileStats = await lstat(absolutePath)
    assert.ok(fileStats.isFile() && !fileStats.isSymbolicLink())
    assert.ok(fileStats.mtimeMs > 0)
    const expectedCreatedAt = new Date(fileStats.birthtimeMs > 0 ? fileStats.birthtimeMs : fileStats.mtimeMs).toISOString()
    const expectedUpdatedAt = new Date(fileStats.mtimeMs).toISOString()
    assert.equal(entry.id, `library:${workspacePath}`)
    assert.equal(entry.createdAt, expectedCreatedAt)
    assert.equal(entry.updatedAt, expectedUpdatedAt)

    const read = await readWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath })
    assertSuccessfulAssetLibraryRead(read)
    assert.equal(read.entry.createdAt, expectedCreatedAt)
    assert.equal(read.entry.updatedAt, expectedUpdatedAt)
    const opened = await openWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath })
    assert.equal(opened.success, true)
    assert.equal(opened.entry.createdAt, expectedCreatedAt)
    assert.equal(opened.entry.updatedAt, expectedUpdatedAt)
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

    await createRegularSource(workspaceDir, 'Workflows/checkpoints/source.glb')
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
      assert.equal(openMeshResult.success, /\.(glb|gltf)$/.test(workspacePath))
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

test('workspace artifact preview recognizes audio artifacts with direct workspace playback URLs', async () => {
  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows/audio/run-1'), { recursive: true })
    await writeFile(path.join(workspaceDir, 'Workflows/audio/run-1/theme.wav'), new Uint8Array([82, 73, 70, 70]))

    const result = await previewWorkspaceArtifact({ workspaceDir, workspacePath: 'Workflows/audio/run-1/theme.wav' })

    assert.deepEqual(result, {
      success: true,
      status: 'audio',
      workspacePath: 'Workflows/audio/run-1/theme.wav',
      displayName: 'theme.wav',
      byteLength: 4,
      audioKind: 'wav',
      sourceUrl: '/workspace/Workflows/audio/run-1/theme.wav',
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

test('accepts rig rename sidecars that bind to the current mesh lineage source via adjacent rigmeta', async () => {
  const writeRigRenameSidecar = getRigRenameSidecarWriter()
  const readRigRenameSidecar = getRigRenameSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    const outputWorkspacePath = 'Workflows/outputs/hero_unirig.glb'
    const sidecarWorkspacePath = 'Workflows/rig-edits/hero_unirig-rig-aliases.rig.v1.json'
    const lineageSourceWorkspacePath = 'Workflows/inputs/hero.glb'
    const rigMetaWorkspacePath = 'Workflows/outputs/hero_unirig.rigmeta.json'
    const sidecar = rigRenameSidecar({ source: { workspacePath: lineageSourceWorkspacePath } })
    await createRegularSource(workspaceDir, lineageSourceWorkspacePath)

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

test('treats a legacy basename-derived Pose/Clip sidecar for a different same-basename source as not found', async () => {
  const readPoseClipSidecar = getPoseClipSidecarReader()

  await withTempWorkspace(async (workspaceDir) => {
    await mkdir(path.join(workspaceDir, 'Workflows', 'pose-clips'), { recursive: true })
    const sourceA = 'Workflows/run-a/animated.glb'
    const sourceB = 'Workflows/run-b/animated.glb'
    await createRegularSource(workspaceDir, sourceB)
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
    await createRegularSource(workspaceDir, sourceB)
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
    await createRegularSource(workspaceDir, sourceWorkspacePath)
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
    await createRegularSource(workspaceDir, sourceWorkspacePath)
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
    await createRegularSource(workspaceDir, 'Workflows/checkpoints/source.glb')
    await createRegularSource(workspaceDir, 'Workflows/checkpoints/other.glb')
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
      assert.match(String((invalid as { error?: unknown }).error), /identity|correction|root|finite/i)
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
    await createRegularSource(workspaceDir, 'Workflows/checkpoints/source.glb')
    await createRegularSource(workspaceDir, 'Workflows/checkpoints/other.glb')
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
    await createRegularSource(workspaceDir, 'Workflows/checkpoints/source.glb')
    await createRegularSource(workspaceDir, 'Workflows/checkpoints/other.glb')
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

test('all artifact IPC handlers reject unknown payloads and coexist with library channels', () => withTempWorkspace(async (workspaceDir) => {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>()
  const ipcMain = { handle: (channel: string, handler: (event: unknown, payload?: unknown) => Promise<unknown>) => {
    assert.equal(handlers.has(channel), false, channel)
    handlers.set(channel, handler)
  } }
  registerWorkspaceAssetLibraryIpcHandlers({ ipcMain, getWorkspaceDir: () => workspaceDir })
  registerArtifactRegistryIpcHandlers({ ipcMain, getWorkspaceDir: () => workspaceDir })
  assert.equal(handlers.size, 19)
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


// Fixed renderer routing fixtures: main accepts source-owned paths, not a renderer module dependency.
function poseClipRoutingFixture(sourceWorkspacePath: string) {
  const paths: Record<string, [string, string]> = {
    'Workflows/run-b/hero character.glb': ['Workflows/pose-clips/hero-character--src-dac34d68cd2b28e7.pose-clip.v1.json', 'Workflows/pose-clips/hero-character.pose-clip.v1.json'],
    'Workflows/run-b/hero%20character.glb': ['Workflows/pose-clips/hero-20character--src-1061d109a060e674.pose-clip.v1.json', 'Workflows/pose-clips/hero-20character.pose-clip.v1.json'],
    'Workflows/run-b/骨骼.glb': ['Workflows/pose-clips/pose-clip--src-bc40ad4fa6793064.pose-clip.v1.json', 'Workflows/pose-clips/pose-clip.pose-clip.v1.json'],
    'Workflows/run-b/---.glb': ['Workflows/pose-clips/pose-clip--src-8c69b281d6a56feb.pose-clip.v1.json', 'Workflows/pose-clips/pose-clip.pose-clip.v1.json'],
    'Workflows/a/hero%20character.glb': ['Workflows/pose-clips/hero-20character--src-7d36eb3879a390db.pose-clip.v1.json', 'Workflows/pose-clips/hero-20character.pose-clip.v1.json'],
    'Workflows/b/hero%20character.glb': ['Workflows/pose-clips/hero-20character--src-5f7c443a52d681cc.pose-clip.v1.json', 'Workflows/pose-clips/hero-20character.pose-clip.v1.json'],
    'Workflows/hero.glb': ['Workflows/pose-clips/hero--src-8a3ec10a74f65eaf.pose-clip.v1.json', 'Workflows/pose-clips/hero.pose-clip.v1.json'],
    'Workflows/hero character.glb': ['Workflows/pose-clips/hero-character--src-33c09f294e20c9a4.pose-clip.v1.json', 'Workflows/pose-clips/hero-character.pose-clip.v1.json'],
  }
  assert.ok(paths[sourceWorkspacePath], sourceWorkspacePath)
  const [hashed, legacy] = paths[sourceWorkspacePath]
  return { hashed, legacy }
}

test('Pose/Clip migration recognizes sanitized legacy names without hiding malformed owners', () => withTempWorkspace(async workspaceDir => {
  for (const name of ['hero character', 'hero%20character', '骨骼', '---']) {
    const sourceWorkspacePath = `Workflows/run-b/${name}.glb`
    await createRegularSource(workspaceDir, sourceWorkspacePath)
    const legacySidecarWorkspacePath = poseClipRoutingFixture(sourceWorkspacePath).legacy
    const sidecarWorkspacePath = poseClipRoutingFixture(sourceWorkspacePath).hashed
    const target = path.join(workspaceDir, legacySidecarWorkspacePath)
    await mkdir(path.dirname(target), { recursive: true })
    const foreign = poseClipSidecar({ source: { workspacePath: `Workflows/run-a/${name}.glb` } })
    await writeFile(target, JSON.stringify(foreign))
    for (const primary of [sidecarWorkspacePath, legacySidecarWorkspacePath]) {
      const result = await readPoseClipSidecar({ workspaceDir, sourceWorkspacePath, sidecarWorkspacePath: primary, legacySidecarWorkspacePath })
      assert.equal(result.status, 'not-found', name)
    }
    for (const source of [{}, { workspacePath: null }, { workspacePath: '' }, { workspacePath: '../foreign.glb' }]) {
      await writeFile(target, JSON.stringify(poseClipSidecar({ source })))
      const result = await readPoseClipSidecar({ workspaceDir, sourceWorkspacePath, sidecarWorkspacePath, legacySidecarWorkspacePath })
      assert.equal(result.status, 'invalid', `${name}: ${JSON.stringify(source)}`)
    }
  }
}))

test('Pose/Clip hashed routing keeps same-basename sources independent and still enforces stored ownership', () => withTempWorkspace(async workspaceDir => {
  const sources = ['Workflows/a/hero%20character.glb', 'Workflows/b/hero%20character.glb']
  const requests = sources.map(sourceWorkspacePath => ({ workspaceDir, sourceWorkspacePath,
    sidecarWorkspacePath: poseClipRoutingFixture(sourceWorkspacePath).hashed, sidecar: poseClipSidecar({ source: { workspacePath: sourceWorkspacePath } }) }))
  for (const source of sources) await createRegularSource(workspaceDir, source)
  assert.notEqual(requests[0].sidecarWorkspacePath, requests[1].sidecarWorkspacePath)
  assert.deepEqual((await Promise.all(requests.map(request => writePoseClipSidecar(request)))).map(result => result.success), [true, true])
  for (const request of requests) {
    const result = await readPoseClipSidecar(request)
    assert.equal(result.status, 'found')
    assert.deepEqual(result.success && result.status === 'found' && result.sidecar, request.sidecar)
  }
  const target = path.join(workspaceDir, requests[0].sidecarWorkspacePath)
  const bytes = await readFile(target)
  const foreignRoute = { ...requests[1], sidecarWorkspacePath: requests[0].sidecarWorkspacePath }
  assert.equal((await writePoseClipSidecar(foreignRoute)).success, false)
  assert.equal((await readPoseClipSidecar(foreignRoute)).status, 'invalid')
  assert.deepEqual(await readFile(target), bytes)
  assert.equal((await writePoseClipSidecar({ ...requests[0], sidecar: { ...requests[0].sidecar, clip: { ...requests[0].sidecar.clip, name: 'Updated' } } })).success, true)
  for (const source of sources) assert.equal(await readFile(path.join(workspaceDir, source), 'utf8'), 'owned regular source fixture')
}))

test('Pose/Clip fallback never masks an invalid or unreadable primary and preserves source checks', () => withTempWorkspace(async workspaceDir => {
  const sourceWorkspacePath = 'Workflows/hero.glb'
  await createRegularSource(workspaceDir, sourceWorkspacePath)
  const sidecarWorkspacePath = poseClipRoutingFixture(sourceWorkspacePath).hashed
  const legacySidecarWorkspacePath = poseClipRoutingFixture(sourceWorkspacePath).legacy
  const primary = path.join(workspaceDir, sidecarWorkspacePath)
  const legacy = path.join(workspaceDir, legacySidecarWorkspacePath)
  await mkdir(path.dirname(primary), { recursive: true })
  const sidecar = poseClipSidecar({ source: { workspacePath: sourceWorkspacePath } })
  await writeFile(legacy, JSON.stringify(sidecar))
  const request = { workspaceDir, sourceWorkspacePath, sidecarWorkspacePath, legacySidecarWorkspacePath }
  for (const bytes of ['{broken', JSON.stringify({ ...sidecar, schema: 'bad' }), JSON.stringify({ ...sidecar, source: { workspacePath: 'Workflows/other.glb' } })]) {
    await writeFile(primary, bytes)
    assert.equal((await readPoseClipSidecar(request)).status, 'invalid')
    assert.equal(await readFile(primary, 'utf8'), bytes)
  }
  await rm(primary); await symlink(legacy, primary)
  assert.equal((await readPoseClipSidecar(request)).status, 'invalid')
  await rm(primary)
  assert.equal((await readPoseClipSidecar(request)).status, 'found')
  await rm(legacy); await symlink(path.join(workspaceDir, 'missing.json'), legacy)
  assert.equal((await readPoseClipSidecar(request)).status, 'invalid')
  await rm(legacy); await writeFile(legacy, JSON.stringify(sidecar))
  await rm(path.join(workspaceDir, sourceWorkspacePath))
  assert.equal((await readPoseClipSidecar(request)).status, 'invalid')
}))

test('Pose/Clip IPC forwards source-bound legacy fallback without trusting payload workspaceDir', () => withTempWorkspace(async workspaceDir => {
  const sourceWorkspacePath = 'Workflows/hero character.glb'
  await createRegularSource(workspaceDir, sourceWorkspacePath)
  const sidecarWorkspacePath = poseClipRoutingFixture(sourceWorkspacePath).hashed
  const legacySidecarWorkspacePath = poseClipRoutingFixture(sourceWorkspacePath).legacy
  const sidecar = poseClipSidecar({ source: { workspacePath: sourceWorkspacePath } })
  const target = path.join(workspaceDir, legacySidecarWorkspacePath)
  await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, JSON.stringify(sidecar))
  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>()
  registerArtifactRegistryIpcHandlers({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, getWorkspaceDir: () => workspaceDir })
  const result = await handlers.get('workspace:artifact:readPoseClipSidecar')!({}, { sourceWorkspacePath, sidecarWorkspacePath, legacySidecarWorkspacePath, workspaceDir: '/ignored' })
  assert.deepEqual(result, { success: true, status: 'found', sidecarWorkspacePath: legacySidecarWorkspacePath, sidecar })
}))

test('rigmeta read keeps supported draft objects and rejects same-target role collisions without changing source bytes', async () => {
  await withTempWorkspace(async workspaceDir => {
    const sourceWorkspacePath = 'Workflows/foo_unirig.glb'
    await createRegularSource(workspaceDir, sourceWorkspacePath)
    const sourceBefore = await readFile(path.join(workspaceDir, sourceWorkspacePath))
    const metadata = rigMetaSidecar({ semantic_candidates: { bone_0: 'Generated pelvis' }, humanoid_contract: undefined,
      humanoid_draft: { assignments: { roles: { head: { boneId: 'bone_5', label: 'Look Control' }, hips: 'bone_0', spine: { boneId: 'bone_0' } } } },
    })
    const metaPath = path.join(workspaceDir, 'Workflows/foo_unirig.rigmeta.json')
    const bytes = JSON.stringify(metadata)
    await writeFile(metaPath, bytes)
    const result = await getRigMetaSidecarReader()({ workspaceDir, sourceWorkspacePath }) as RigMetaSidecarReadResult
    assert.ok(result.success && result.status === 'found')
    assert.deepEqual(result.namingByBoneId, {
      bone_0: { label: 'Generated pelvis', source: 'semantic_candidates' },
      bone_5: { label: 'Look Control', source: 'humanoid_draft' },
    })
    assert.match(result.warnings.join('\n'), /multiple.*roles|roles.*same/i)
    assert.equal(await readFile(metaPath, 'utf8'), bytes)
    assert.deepEqual(await readFile(path.join(workspaceDir, sourceWorkspacePath)), sourceBefore)
  })
})

test('motion persistence confines source and sidecar physical paths including trusted-root aliases', () => withTempWorkspace(async (workspaceDir) => {
  const request = { workspaceDir, sourceWorkspacePath: 'Workflows/checkpoints/source.glb', sidecarWorkspacePath: 'Workflows/motion-retarget/physical.motion-retarget.v1.json', sidecar: motionRetargetSidecar() }
  await createRegularSource(workspaceDir, request.sourceWorkspacePath)
  const output = path.join(workspaceDir, 'Workflows/motion-retarget')
  const actual = path.join(workspaceDir, 'actual'); await mkdir(actual)
  await symlink(actual, output)
  assert.equal((await artifactRegistryService.writeMotionRetargetSidecar(request)).success, false)
  await rm(output); await mkdir(output)
  const leaf = path.join(workspaceDir, request.sidecarWorkspacePath)
  for (const kind of ['link', 'directory']) {
    if (kind === 'link') await symlink(path.join(actual, 'missing.json'), leaf)
    else await mkdir(leaf)
    assert.equal((await artifactRegistryService.writeMotionRetargetSidecar(request)).success, false)
    assert.equal((await artifactRegistryService.readMotionRetargetSidecar(request)).success, false)
    await rm(leaf, { recursive: true })
  }
  const source = path.join(workspaceDir, request.sourceWorkspacePath)
  await rm(source)
  for (const kind of ['missing', 'link', 'directory']) {
    if (kind === 'link') await symlink(path.join(actual, 'missing.glb'), source)
    if (kind === 'directory') await mkdir(source)
    assert.equal((await artifactRegistryService.writeMotionRetargetSidecar(request)).success, false, kind)
    assert.equal((await artifactRegistryService.readMotionRetargetSidecar(request)).success, false, kind)
    if (kind !== 'missing') await rm(source, { recursive: true })
  }
  await createRegularSource(workspaceDir, request.sourceWorkspacePath)
  const alias = path.join(workspaceDir, 'configured'); await symlink(workspaceDir, alias)
  const saved = await artifactRegistryService.writeMotionRetargetSidecar({ ...request, workspaceDir: alias })
  assert.equal(saved.success, true, JSON.stringify(saved))
  assert.equal((await artifactRegistryService.readMotionRetargetSidecar(request)).status, 'found')
}))

test('motion persistence rejects non-finite JSON and serialized owner substitution before creating directories', () => withTempWorkspace(async (workspaceDir) => {
  const request = { workspaceDir, sourceWorkspacePath: 'Workflows/checkpoints/source.glb', sidecarWorkspacePath: 'Workflows/motion-retarget/finite.motion-retarget.v1.json' }
  await createRegularSource(workspaceDir, request.sourceWorkspacePath)
  for (const sidecar of [
    motionRetargetSidecar({ extra: { metric: Infinity } }),
    { ...motionRetargetSidecar(), toJSON: () => motionRetargetSidecar({ source: { workspacePath: 'other.glb' } }) },
  ]) {
    assert.equal((await artifactRegistryService.writeMotionRetargetSidecar({ ...request, sidecar })).success, false)
    await assert.rejects(stat(path.join(workspaceDir, 'Workflows/motion-retarget')), { code: 'ENOENT' })
  }
}))

test('motion persistence preserves unknown data but rejects contradictory identity paths and context', () => withTempWorkspace(async (workspaceDir) => {
  const sidecar = motionRetargetSidecar({
    identity: { key: 'mrt_0123456789abcdef', sourceWorkspacePath: 'Workflows/checkpoints/source.glb', skeletonContextId: 'rig:Body|skeleton:0' },
    futureExtension: { schema: 'future.motion.v9', statuses: ['vendor-specific'], score: 1.25 },
  })
  const request = { workspaceDir, sourceWorkspacePath: sidecar.source.workspacePath, sidecarWorkspacePath: 'Workflows/motion-retarget/context.motion-retarget.v1.json' }
  await createRegularSource(workspaceDir, request.sourceWorkspacePath)
  const valid = await artifactRegistryService.writeMotionRetargetSidecar({ ...request, sidecar })
  assert.equal(valid.success, true, JSON.stringify(valid))
  assert.deepEqual(valid.sidecar, sidecar)
  for (const identity of [
    { ...sidecar.identity, bundleWorkspacePath: '../escape' },
    { ...sidecar.identity, metadataWorkspacePath: 'different/metadata.json' },
    { ...sidecar.identity, artifactWorkspacePath: 'different/animated.glb' },
    { ...sidecar.identity, workflowId: 'different-workflow' },
  ]) assert.equal((await artifactRegistryService.writeMotionRetargetSidecar({ ...request, sidecar: { ...sidecar, identity } })).success, false)
  assert.equal((await artifactRegistryService.writeMotionRetargetSidecar({ ...request, sidecar: { ...sidecar, skeletonContextId: 'different-context' } })).success, false)
  assert.deepEqual(JSON.parse(await readFile(path.join(workspaceDir, request.sidecarWorkspacePath), 'utf8')), sidecar)
}))

test('motion ownership queue covers physical aliases and preserves foreign or malformed owners', () => withTempWorkspace(async (workspaceDir) => {
  const sourceA = 'Workflows/checkpoints/source.glb', sourceB = 'Workflows/checkpoints/other.glb'
  await createRegularSource(workspaceDir, sourceA); await createRegularSource(workspaceDir, sourceB)
  const alias = path.join(workspaceDir, 'configured'); await symlink(workspaceDir, alias)
  const sidecarWorkspacePath = 'Workflows/motion-retarget/shared.motion-retarget.v1.json'
  const make = (sourceWorkspacePath: string, root = workspaceDir) => ({ workspaceDir: root, sidecarWorkspacePath, sourceWorkspacePath, sidecar: motionRetargetSidecar({ source: { workspacePath: sourceWorkspacePath }, artifact: { ...motionRetargetSidecar().artifact, sourceMeshWorkspacePath: sourceWorkspacePath } }) })
  const concurrent = await Promise.all([artifactRegistryService.writeMotionRetargetSidecar(make(sourceA)), artifactRegistryService.writeMotionRetargetSidecar(make(sourceB, alias))])
  assert.equal(concurrent.filter((result: { success: boolean }) => result.success).length, 1)
  const target = path.join(workspaceDir, sidecarWorkspacePath)
  const owner = JSON.parse(await readFile(target, 'utf8')).source.workspacePath
  assert.equal((await artifactRegistryService.writeMotionRetargetSidecar(make(owner, alias))).success, true)
  for (const content of ['{broken', '{}', JSON.stringify(motionRetargetSidecar({ source: { workspacePath: owner }, schema: 'foreign' }))]) {
    await writeFile(target, content)
    const rejected = await artifactRegistryService.writeMotionRetargetSidecar(make(owner))
    assert.equal(rejected.success, false)
    assert.match(rejected.error, /ownership/i)
    assert.equal(await readFile(target, 'utf8'), content)
  }
  await rm(target)
  assert.equal((await artifactRegistryService.writeMotionRetargetSidecar(make(owner))).success, true)
  const { readdir } = await import('node:fs/promises')
  assert.deepEqual(await readdir(path.dirname(target)), [path.basename(target)])
}))

test('motion reads distinguish absent sidecars from malformed, non-finite, or physically invalid data', () => withTempWorkspace(async (workspaceDir) => {
  const request = { workspaceDir, sourceWorkspacePath: 'Workflows/checkpoints/source.glb', sidecarWorkspacePath: 'Workflows/motion-retarget/read.motion-retarget.v1.json' }
  await createRegularSource(workspaceDir, request.sourceWorkspacePath)
  assert.equal((await artifactRegistryService.readMotionRetargetSidecar(request)).status, 'not-found')
  const target = path.join(workspaceDir, request.sidecarWorkspacePath); await mkdir(path.dirname(target), { recursive: true })
  for (const content of ['{invalid', JSON.stringify({ ...motionRetargetSidecar(), extra: 'PLACEHOLDER' }).replace('"PLACEHOLDER"', '1e999')]) {
    await writeFile(target, content)
    assert.equal((await artifactRegistryService.readMotionRetargetSidecar(request)).status, 'invalid')
  }
  await rm(target); await symlink(path.join(workspaceDir, 'missing'), target)
  assert.equal((await artifactRegistryService.readMotionRetargetSidecar(request)).status, 'invalid')
}))

test('workspace preview and download reject symlinks and non-regular sources before a dialog', () => withTempWorkspace(async (workspaceDir) => {
  await writeFile(path.join(workspaceDir, 'real.json'), '{"private":true}')
  await symlink(path.join(workspaceDir, 'real.json'), path.join(workspaceDir, 'linked.json'))
  await mkdir(path.join(workspaceDir, 'directory.glb'))
  const { execFileSync } = await import('node:child_process')
  execFileSync('mkfifo', [path.join(workspaceDir, 'pipe.txt')])
  await symlink(workspaceDir, path.join(workspaceDir, 'inner'))
  let dialogs = 0
  for (const workspacePath of ['linked.json', 'directory.glb', 'pipe.txt', 'inner/real.json']) {
    assert.equal((await previewWorkspaceArtifact({ workspaceDir, workspacePath })).success, false, workspacePath)
    assert.equal((await downloadWorkspaceArtifact({ workspaceDir, workspacePath, showSaveDialog: async () => { dialogs += 1; return { canceled: true } } })).success, false, workspacePath)
  }
  assert.equal(dialogs, 0)
}))

test('workspace preview bounds UTF-8 text bytes and handles empty and binary payloads', () => withTempWorkspace(async (workspaceDir) => {
  await writeFile(path.join(workspaceDir, 'unicode.txt'), 'é🙂tail')
  const capped = await previewWorkspaceArtifact({ workspaceDir, workspacePath: 'unicode.txt', maxBytes: 3 })
  assert.equal(capped.success && capped.status, 'text')
  if (!capped.success || capped.status !== 'text') return
  assert.equal(capped.content, 'é'); assert.equal(capped.byteLength, 10); assert.equal(capped.truncated, true)
  await writeFile(path.join(workspaceDir, 'empty.json'), '')
  const empty = await previewWorkspaceArtifact({ workspaceDir, workspacePath: 'empty.json' })
  assert.equal(empty.success && empty.status === 'text' && empty.content, '')
  assert.equal(empty.success && empty.status === 'text' && empty.truncated, false)
  await writeFile(path.join(workspaceDir, 'large.log'), 'x'.repeat(70 * 1024))
  const bounded = await previewWorkspaceArtifact({ workspaceDir, workspacePath: 'large.log', maxBytes: 1e12 })
  assert.equal(bounded.success && bounded.status === 'text' && Buffer.byteLength(bounded.content), 64 * 1024)
  await writeFile(path.join(workspaceDir, 'binary.npz'), Buffer.from([80, 75, 0, 255]))
  const binary = await previewWorkspaceArtifact({ workspaceDir, workspacePath: 'binary.npz' })
  assert.equal(binary.success && binary.status === 'binary' && binary.byteLength, 4)
}))

test('download revalidates the source after the dialog without mutating approved destinations', () => withTempWorkspace(async (workspaceDir) => {
  const workspacePath = 'source.json', source = path.join(workspaceDir, workspacePath)
  const target = path.join(workspaceDir, 'downloads', 'copy.json')
  await writeFile(source, 'original')
  const result = await downloadWorkspaceArtifact({ workspaceDir, workspacePath, showSaveDialog: async () => {
    await rm(source); await symlink(path.join(workspaceDir, 'other.json'), source)
    await writeFile(path.join(workspaceDir, 'other.json'), 'replacement')
    return { canceled: false, filePath: target }
  } })
  assert.equal(result.success, false)
  await assert.rejects(stat(path.dirname(target)), { code: 'ENOENT' })
  assert.equal(await readFile(path.join(workspaceDir, 'other.json'), 'utf8'), 'replacement')
}))

test('download supports approved external copies, side-effect-free cancel, and same-file protections', () => withTempWorkspace(async (workspaceDir) => withTempWorkspace(async (outside) => {
  const workspacePath = 'source.json', source = path.join(workspaceDir, workspacePath)
  const bytes = Buffer.from([0, 1, 2, 255, 33]); await writeFile(source, bytes)
  const target = path.join(outside, 'downloads', 'copy.json')
  const canceled = await downloadWorkspaceArtifact({ workspaceDir, workspacePath, showSaveDialog: async () => ({ canceled: true, filePath: target }) })
  assert.equal(canceled.success && canceled.status, 'cancelled')
  await assert.rejects(stat(path.dirname(target)), { code: 'ENOENT' })
  const saved = await downloadWorkspaceArtifact({ workspaceDir, workspacePath, showSaveDialog: async () => ({ canceled: false, filePath: target }) })
  assert.equal(saved.success, true, JSON.stringify(saved)); assert.deepEqual(await readFile(target), bytes)
  const { link } = await import('node:fs/promises'); const hardlink = path.join(outside, 'hardlink.json'); await link(source, hardlink)
  for (const filePath of [source, hardlink]) {
    assert.equal((await downloadWorkspaceArtifact({ workspaceDir, workspacePath, showSaveDialog: async () => ({ canceled: false, filePath }) })).success, false)
    assert.deepEqual(await readFile(source), bytes)
  }
  const linked = path.join(outside, 'linked.json'); await symlink(target, linked)
  assert.equal((await downloadWorkspaceArtifact({ workspaceDir, workspacePath, showSaveDialog: async () => ({ canceled: false, filePath: linked }) })).success, false)
  assert.deepEqual(await readFile(source), bytes); assert.deepEqual(await readFile(target), bytes)
})))

test('download checks the exact native POSIX destination spelling before any directory creation', () => withTempWorkspace(async (workspaceDir) => withTempWorkspace(async (outside) => {
  if (path.sep !== '/') return
  const sourceBytes = Buffer.from('source bytes'), victimBytes = Buffer.from('victim bytes')
  await writeFile(path.join(workspaceDir, 'source.json'), sourceBytes)
  const victim = path.join(outside, 'victim'); await mkdir(victim)
  await writeFile(path.join(victim, 'copy.json'), victimBytes)
  const linked = path.join(outside, 'chosen\\directory'); await symlink(victim, linked)
  const destination = path.join(linked, 'copy.json')
  const result = await downloadWorkspaceArtifact({ workspaceDir, workspacePath: 'source.json', showSaveDialog: async () => ({ canceled: false, filePath: destination }) })
  assert.equal(result.success, false, 'The native destination symlink ancestor must not be rewritten before validation')
  assert.deepEqual(await readFile(path.join(victim, 'copy.json')), victimBytes)
  assert.deepEqual(await readFile(path.join(workspaceDir, 'source.json')), sourceBytes)
  await assert.rejects(stat(path.join(outside, 'chosen')), { code: 'ENOENT' })
  const { readdir } = await import('node:fs/promises')
  assert.deepEqual((await readdir(outside)).sort(), ['chosen\\directory', 'victim'])
})))

test('download preserves legal native POSIX backslashes, percent text and whitespace without an alternate tree', () => withTempWorkspace(async (workspaceDir) => withTempWorkspace(async (outside) => {
  if (path.sep !== '/') return
  const { readdir } = await import('node:fs/promises')
  const sourceBytes = Buffer.alloc(150000, 117); await writeFile(path.join(workspaceDir, 'source.json'), sourceBytes)
  const directoryNames = ['chosen\\directory', '%2f literal directory', ' spaced directory ']
  const leaf = ' copy\\%2f.json '
  for (const name of directoryNames) {
    const destination = path.join(outside, name, leaf)
    const result = await downloadWorkspaceArtifact({ workspaceDir, workspacePath: 'source.json', showSaveDialog: async () => ({ canceled: false, filePath: destination }) })
    assert.deepEqual(result, { success: true, status: 'saved', workspacePath: 'source.json', targetPath: destination })
    assert.deepEqual(await readFile(destination), sourceBytes)
    assert.deepEqual(await readdir(path.join(outside, name)), [leaf])
    // Same spelling also supports an approved atomic replacement.
    await writeFile(destination, 'old bytes')
    assert.equal((await downloadWorkspaceArtifact({ workspaceDir, workspacePath: 'source.json', showSaveDialog: async () => ({ canceled: false, filePath: destination }) })).success, true)
    assert.deepEqual(await readFile(destination), sourceBytes)
    assert.deepEqual(await readdir(path.join(outside, name)), [leaf])
  }
  assert.deepEqual((await readdir(outside)).sort(), directoryNames.sort())
  assert.deepEqual(await readFile(path.join(workspaceDir, 'source.json')), sourceBytes)
})))

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

    await createRegularSource(workspaceDir, 'Workflows/sources/source.glb')
    await createRegularSource(workspaceDir, 'Workflows/outputs/source.glb')
    await writeFile(meshAbsolutePath, 'mesh-bytes-v1', 'utf-8')
    await writeFile(path.join(workspaceDir, ...sourceWorkspacePath.split('/')), 'source-mesh', 'utf-8')
    await writeFile(path.join(workspaceDir, ...rigMetaWorkspacePath.split('/')), JSON.stringify(humanoidRigMetaSidecar(), null, 2), 'utf-8')
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
      sidecar: { ...promotion, draftContentSha256: humanoidContentReceipt(humanoidDraftSidecar()), sourceSha256: sha256('source-mesh') },
    })

    const readDraftResult = await readHumanoidDraftSidecar({ workspaceDir, meshWorkspacePath })
    assert.deepEqual(readDraftResult, {
      success: true,
      status: 'found',
      sidecarWorkspacePath: draftWorkspacePath,
      sourceSha256: sha256('source-mesh'),
      sidecar: { ...humanoidDraftSidecar(), draftContentSha256: humanoidContentReceipt(humanoidDraftSidecar()) },
    })

    const readPromotionResult = await readHumanoidPromotionSidecar({ workspaceDir, meshWorkspacePath })
    assert.deepEqual(readPromotionResult, {
      success: true,
      status: 'found',
      sidecarWorkspacePath: promotionWorkspacePath,
      sidecar: { ...promotion, draftContentSha256: humanoidContentReceipt(humanoidDraftSidecar()), sourceSha256: sha256('source-mesh') },
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

    await createRegularSource(workspaceDir, 'Workflows/sources/source.glb')
    await createRegularSource(workspaceDir, 'Workflows/outputs/source.glb')
    await writeFile(meshAbsolutePath, 'mesh-bytes-v1', 'utf-8')
    await writeFile(path.join(workspaceDir, ...rigMetaWorkspacePath.split('/')), JSON.stringify(humanoidRigMetaSidecar(), null, 2), 'utf-8')
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
    await writeFile(path.join(workspaceDir, ...rigMetaWorkspacePath.split('/')), JSON.stringify(humanoidRigMetaSidecar(), null, 2), 'utf-8')
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

    await createRegularSource(workspaceDir, 'Workflows/sources/source.glb')
    await createRegularSource(workspaceDir, 'Workflows/outputs/source.glb')
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

    await createRegularSource(workspaceDir, 'Workflows/sources/source.glb')
    await createRegularSource(workspaceDir, 'Workflows/outputs/source.glb')
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
      sidecar: { ...promotion, draftContentSha256: humanoidContentReceipt(draftResult.sidecar), sourceSha256: sha256('owned regular source fixture') },
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

async function createHumanoidPhysicalFixture(workspaceDir: string) {
  const meshWorkspacePath = 'Workflows/outputs/hero_unirig.glb'
  const draftPath = path.join(workspaceDir, getHumanoidDraftWorkspacePath(meshWorkspacePath)!)
  const promotionPath = path.join(workspaceDir, getHumanoidPromotionWorkspacePath(meshWorkspacePath)!)
  const rigMetaPath = path.join(workspaceDir, 'Workflows/outputs/hero_unirig.rigmeta.json')
  await createRegularSource(workspaceDir, 'Workflows/sources/source.glb')
  await createRegularSource(workspaceDir, meshWorkspacePath)
  await writeFile(path.join(workspaceDir, meshWorkspacePath), 'mesh-bytes-v1')
  await writeFile(rigMetaPath, JSON.stringify(humanoidRigMetaSidecar(), null, 2))
  await writeFile(draftPath, JSON.stringify(humanoidDraftSidecar(), null, 2))
  return { request: { workspaceDir, meshWorkspacePath, sidecar: humanoidPromotionSidecar() }, draftPath, promotionPath, rigMetaPath }
}

test('humanoid promotion content receipts detect changed assignments retaining the producer token and changed source bytes', () => withTempWorkspace(async workspaceDir => {
  const fixture = await createHumanoidPhysicalFixture(workspaceDir)
  const draft = await readHumanoidDraftSidecar(fixture.request)
  assert.ok(draft.success && draft.status === 'found')
  assert.equal(draft.sidecar.draftSha256, 'draft-sha-1', 'legacy opaque producer token remains supported')
  const first = await writeHumanoidPromotionSidecar({ ...fixture.request, sidecar: { ...fixture.request.sidecar, draftContentSha256: draft.sidecar.draftContentSha256 } })
  assert.equal(first.success, true)
  const before = await readFile(fixture.promotionPath)
  const changed = humanoidDraftSidecar({ assignments: { roles: { hips: 'changed' }, chains: {} } })
  await writeFile(fixture.draftPath, JSON.stringify(changed, null, 2))
  const stale = await readHumanoidPromotionSidecar(fixture.request)
  assert.ok(stale.success && stale.status === 'stale'); assert.ok(stale.staleReasons.includes('draft_content_sha256_mismatch'))
  const rejected = await writeHumanoidPromotionSidecar({ ...fixture.request, sidecar: { ...fixture.request.sidecar, draftContentSha256: draft.sidecar.draftContentSha256 } })
  assert.equal(rejected.success, false); assert.deepEqual(await readFile(fixture.promotionPath), before)
  await writeFile(fixture.draftPath, JSON.stringify(humanoidDraftSidecar(), null, 2))
  await writeFile(path.join(workspaceDir, 'Workflows/sources/source.glb'), 'changed source')
  const staleSource = await readHumanoidPromotionSidecar(fixture.request)
  assert.ok(staleSource.success && staleSource.status === 'stale'); assert.ok(staleSource.staleReasons.includes('source_sha256_mismatch'))
}))

test('humanoid promotion preserves malformed and foreign owners and serializes same-owner physical-root aliases', () => withTempWorkspace(async workspaceDir => {
  const fixture = await createHumanoidPhysicalFixture(workspaceDir)
  const alias = path.join(workspaceDir, 'configured'); await symlink(workspaceDir, alias)
  const results = await Promise.all(Array.from({ length: 5 }, (_, revision) => writeHumanoidPromotionSidecar({ ...fixture.request,
    workspaceDir: revision % 2 ? alias : workspaceDir, sidecar: { ...fixture.request.sidecar, promotionId: `p-${revision}` } })))
  assert.ok(results.every(result => result.success))
  for (const contents of ['{invalid', '{}', JSON.stringify(humanoidPromotionSidecar({ source: { workspacePath: 'Workflows/foreign.glb' } })),
    JSON.stringify({ ...humanoidPromotionSidecar(), extra: 1 }).replace('"extra":1', '"extra":1e999')]) {
    await writeFile(fixture.promotionPath, contents)
    const rejected = await writeHumanoidPromotionSidecar(fixture.request)
    assert.equal(rejected.success, false); assert.match(rejected.error!, /owner|existing/i)
    assert.equal(await readFile(fixture.promotionPath, 'utf8'), contents)
  }
  const fs = await import('node:fs/promises')
  assert.ok((await fs.readdir(path.dirname(fixture.promotionPath))).every(name => !name.startsWith('.modly-artifact-')))
}))

for (const changed of ['mesh', 'rigmeta', 'draft', 'source'] as const) {
  test(`humanoid promotion revalidates actual ${changed} bytes inside its publication queue`, () => withTempWorkspace(async workspaceDir => {
    const fs = await import('node:fs/promises')
    const fixture = await createHumanoidPhysicalFixture(workspaceDir)
    await writeHumanoidPromotionSidecar(fixture.request)
    const before = await readFile(fixture.promotionPath)
    let mutated = false
    const service = await loadArtifactServiceWithFs({ open: async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === fixture.promotionPath && !mutated) {
        mutated = true
        const target = changed === 'mesh' ? path.join(workspaceDir, fixture.request.meshWorkspacePath)
          : changed === 'rigmeta' ? fixture.rigMetaPath : changed === 'draft' ? fixture.draftPath : path.join(workspaceDir, 'Workflows/sources/source.glb')
        await writeFile(target, changed === 'draft' ? JSON.stringify(humanoidDraftSidecar({ assignments: { roles: { hips: 'changed' }, chains: {} } }), null, 2)
          : changed === 'rigmeta' ? JSON.stringify({ ...humanoidRigMetaSidecar(), changed: true }) : 'mutated')
      }
      return fs.open(...args)
    } })
    const result = await service.writeHumanoidPromotionSidecar(fixture.request)
    assert.equal(mutated, true); assert.equal(result.success, false)
    assert.deepEqual(await readFile(fixture.promotionPath), before)
  }))
}

test('humanoid invalid primary does not fall back to embedded diagnostics', () => withTempWorkspace(async workspaceDir => {
  const fixture = await createHumanoidPhysicalFixture(workspaceDir)
  await createRegularSource(workspaceDir, 'Workflows/outputs/source.glb')
  await writeFile(fixture.rigMetaPath, JSON.stringify(humanoidEmbeddedRigMetaDraftSidecar(), null, 2))
  for (const contents of ['{invalid', JSON.stringify({ ...humanoidDraftSidecar(), extra: 1 }).replace('"extra":1', '"extra":1e999')]) {
    await writeFile(fixture.draftPath, contents)
    assert.equal((await readHumanoidDraftSidecar(fixture.request)).success, false)
  }
}))

for (const kind of ['draft', 'promotion', 'mesh'] as const) {
  test(`humanoid rejects inner symlink and directory ${kind} paths`, () => withTempWorkspace(async workspaceDir => {
    const fixture = await createHumanoidPhysicalFixture(workspaceDir)
    const target = kind === 'draft' ? fixture.draftPath : kind === 'promotion' ? fixture.promotionPath : path.join(workspaceDir, fixture.request.meshWorkspacePath)
    for (const type of ['symlink', 'directory']) {
      await rm(target, { force: true })
      if (type === 'symlink') await symlink(path.join(workspaceDir, 'missing.json'), target)
      else await mkdir(target)
      const read = kind === 'promotion' ? await readHumanoidPromotionSidecar(fixture.request) : await readHumanoidDraftSidecar(fixture.request)
      if (kind === 'mesh') {
        assert.ok(read.success && read.status === 'stale')
        assert.match(read.staleReasons.join(' '), /symbolic|regular|symlink/i)
      } else assert.equal(read.success, false)
      assert.equal((await writeHumanoidPromotionSidecar(fixture.request)).success, false)
      await rm(target, { recursive: true })
    }
  }))
}

test('rig alias lineage remains anchored across two updates and rejects changed or missing lineage', () => withTempWorkspace(async workspaceDir => {
  const fixture = await createHumanoidPhysicalFixture(workspaceDir)
  const request = { workspaceDir, sourceWorkspacePath: fixture.request.meshWorkspacePath, sidecarWorkspacePath: 'Workflows/rig-edits/lineage.rig.v1.json',
    sidecar: rigRenameSidecar({ source: { workspacePath: 'Workflows/sources/source.glb' } }) }
  for (const createdAt of ['first', 'second']) {
    const sidecar = { ...request.sidecar, createdAt }
    assert.equal((await artifactRegistryService.writeRigRenameSidecar({ ...request, sidecar })).success, true)
    const read = await readRigRenameSidecar(request)
    assert.ok(read.success && read.status === 'found'); assert.equal(read.sidecar.createdAt, createdAt)
  }
  const before = await readFile(path.join(workspaceDir, request.sidecarWorkspacePath))
  await writeFile(fixture.rigMetaPath, JSON.stringify(rigMetaSidecar({ output_mesh: 'elsewhere/hero_unirig.glb', source: request.sidecar.source })))
  assert.equal((await artifactRegistryService.writeRigRenameSidecar(request)).success, false)
  assert.equal((await readRigRenameSidecar(request)).success, false)
  assert.deepEqual(await readFile(path.join(workspaceDir, request.sidecarWorkspacePath)), before)
}))

for (const changed of ['mesh', 'rigmeta', 'draft', 'source'] as const) {
  test(`humanoid refuses ${changed} mutation during temporary publication preparation`, () => withTempWorkspace(async workspaceDir => {
    const fs = await import('node:fs/promises')
    const fixture = await createHumanoidPhysicalFixture(workspaceDir)
    assert.equal((await writeHumanoidPromotionSidecar(fixture.request)).success, true)
    const before = await readFile(fixture.promotionPath)
    let mutated = false
    const service = await loadArtifactServiceWithFs({ writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      const result = await fs.writeFile(...args)
      if (String(args[0]).includes('.modly-artifact-') && !mutated) {
        mutated = true
        const target = changed === 'mesh' ? path.join(workspaceDir, fixture.request.meshWorkspacePath)
          : changed === 'rigmeta' ? fixture.rigMetaPath : changed === 'draft' ? fixture.draftPath : path.join(workspaceDir, 'Workflows/sources/source.glb')
        await fs.writeFile(target, changed === 'draft' ? JSON.stringify(humanoidDraftSidecar({ assignments: { roles: { hips: 'changed' }, chains: {} } }), null, 2)
          : changed === 'rigmeta' ? JSON.stringify({ ...humanoidRigMetaSidecar(), changed: true }) : 'mutated')
      }
      return result
    } })
    const result = await service.writeHumanoidPromotionSidecar(fixture.request)
    assert.equal(mutated, true); assert.equal(result.success, false)
    assert.deepEqual(await readFile(fixture.promotionPath), before)
    assert.ok((await fs.readdir(path.dirname(fixture.promotionPath))).every(name => !name.startsWith('.modly-artifact-')))
  }))
}

test('humanoid refuses a source receipt changed between its initial read and snapshot', () => withTempWorkspace(async workspaceDir => {
  const fs = await import('node:fs/promises')
  const fixture = await createHumanoidPhysicalFixture(workspaceDir)
  let mutated = false
  const sourcePath = path.join(workspaceDir, 'Workflows/sources/source.glb')
  const service = await loadArtifactServiceWithFs({ open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args)
    if (String(args[0]) !== sourcePath || mutated) return handle
    const original = handle.readFile.bind(handle)
    // The wrapper forwards each original overload unchanged, including its encoding.
    handle.readFile = (async (...readArgs: Parameters<typeof handle.readFile>) => {
      const bytes = await original(...readArgs)
      if (!mutated) { mutated = true; await fs.writeFile(sourcePath, 'changed after source receipt') }
      return bytes
    }) as typeof handle.readFile
    return handle
  } })
  const result = await service.writeHumanoidPromotionSidecar(fixture.request)
  assert.equal(mutated, true); assert.equal(result.success, false)
  await assert.rejects(readFile(fixture.promotionPath), /ENOENT/)
}))

test('humanoid draft discovery receipts bind reviewed source bytes without changing producer content', () => withTempWorkspace(async workspaceDir => {
  const fixture = await createHumanoidPhysicalFixture(workspaceDir)
  const sourcePath = path.join(workspaceDir, fixture.request.sidecar.source.workspacePath)
  const originalDraft = await readFile(fixture.draftPath)
  const first = await readHumanoidDraftSidecar(fixture.request)
  assert.ok(first.success && first.status === 'found')
  assert.equal(first.sourceSha256, createHash('sha256').update(await readFile(sourcePath)).digest('hex'))
  await writeFile(sourcePath, 'replacement after discovery')
  const second = await readHumanoidDraftSidecar(fixture.request)
  assert.ok(second.success && second.status === 'found')
  assert.notEqual(second.sourceSha256, first.sourceSha256)
  assert.equal(second.sidecar.draftContentSha256, first.sidecar.draftContentSha256)
  assert.deepEqual(await readFile(fixture.draftPath), originalDraft)
  const rejected = await writeHumanoidPromotionSidecar({ ...fixture.request, sidecar: { ...fixture.request.sidecar, sourceSha256: first.sourceSha256 } })
  assert.equal(rejected.success, false)
  await assert.rejects(readFile(fixture.promotionPath), /ENOENT/)
  const accepted = await writeHumanoidPromotionSidecar({ ...fixture.request, sidecar: { ...fixture.request.sidecar, sourceSha256: second.sourceSha256 } })
  assert.ok(accepted.success); assert.equal(accepted.sidecar.sourceSha256, second.sourceSha256)
}))

test('humanoid promotion rejects wrong or stale source receipts and preserves the saved promotion', () => withTempWorkspace(async workspaceDir => {
  const fixture = await createHumanoidPhysicalFixture(workspaceDir)
  const wrong = await writeHumanoidPromotionSidecar({ ...fixture.request, sidecar: { ...fixture.request.sidecar, sourceSha256: 'contradictory-receipt' } })
  assert.equal(wrong.success, false)
  await assert.rejects(readFile(fixture.promotionPath), /ENOENT/)
  const first = await writeHumanoidPromotionSidecar(fixture.request)
  assert.ok(first.success, 'legacy absent receipt stays supported')
  const before = await readFile(fixture.promotionPath)
  await writeFile(path.join(workspaceDir, first.sidecar.source.workspacePath), 'changed physical input')
  assert.equal((await writeHumanoidPromotionSidecar({ ...fixture.request, sidecar: first.sidecar })).success, false)
  assert.deepEqual(await readFile(fixture.promotionPath), before)
  const fresh = await readHumanoidDraftSidecar(fixture.request)
  assert.ok(fresh.success && fresh.status === 'found')
  assert.equal((await writeHumanoidPromotionSidecar({ ...fixture.request, sidecar: { ...first.sidecar, sourceSha256: fresh.sourceSha256 } })).success, true,
    'valid stale same-owner records may be superseded by a freshly reviewed receipt')
}))

for (const receipt of ['sourceSha256', 'draftContentSha256'] as const) {
  test(`humanoid promotion preserves existing malformed optional ${receipt} receipts`, () => withTempWorkspace(async workspaceDir => {
    const fixture = await createHumanoidPhysicalFixture(workspaceDir)
    for (const value of [null, '', 7, {}, []]) {
      const bytes = JSON.stringify({ ...fixture.request.sidecar, [receipt]: value })
      await writeFile(fixture.promotionPath, bytes)
      const result = await writeHumanoidPromotionSidecar(fixture.request)
      assert.equal(result.success, false, `${receipt}=${JSON.stringify(value)}`)
      assert.equal(await readFile(fixture.promotionPath, 'utf8'), bytes)
    }
    await writeFile(fixture.promotionPath, JSON.stringify(fixture.request.sidecar))
    assert.equal((await writeHumanoidPromotionSidecar(fixture.request)).success, true, 'absent legacy receipts remain valid')
  }))
}

test('embedded humanoid draft discovery captures the physical source review receipt', () => withTempWorkspace(async workspaceDir => {
  const fixture = await createHumanoidPhysicalFixture(workspaceDir)
  await createRegularSource(workspaceDir, 'Workflows/outputs/source.glb')
  await rm(fixture.draftPath)
  await writeFile(fixture.rigMetaPath, JSON.stringify(humanoidEmbeddedRigMetaDraftSidecar(), null, 2))
  const first = await readHumanoidDraftSidecar(fixture.request)
  assert.ok(first.success && first.status === 'found')
  const source = path.join(workspaceDir, first.sidecar.source.workspacePath)
  assert.equal(first.sourceSha256, sha256(await readFile(source, 'utf8')))
  await writeFile(source, 'replaced embedded input')
  const request = { ...fixture.request, sidecar: { ...fixture.request.sidecar, source: first.sidecar.source,
    rigmetaSha256: first.sidecar.rigmetaSha256, draftSha256: first.sidecar.draftSha256,
    draftContentSha256: first.sidecar.draftContentSha256, sourceSha256: first.sourceSha256 } }
  assert.equal((await writeHumanoidPromotionSidecar(request)).success, false)
  await assert.rejects(readFile(fixture.promotionPath), /ENOENT/)
  const fresh = await readHumanoidDraftSidecar(fixture.request)
  assert.ok(fresh.success && fresh.status === 'found')
  assert.equal(fresh.sidecar.draftSha256, first.sidecar.draftSha256)
  assert.equal(fresh.sidecar.draftContentSha256, first.sidecar.draftContentSha256)
  assert.equal((await writeHumanoidPromotionSidecar({ ...request, sidecar: { ...request.sidecar, sourceSha256: fresh.sourceSha256 } })).success, true)
}))

test('library physical reads reject descendant links and non-files while accepting configured root aliases', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'real/Workflows'), { recursive: true })
  await mkdir(path.join(workspaceDir, 'outside'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'outside/escape.gltf'), '{"skins":[{}]}')
  await writeFile(path.join(workspaceDir, 'real/Workflows/safe.gltf'), '{"skins":[{}]}')
  await symlink(path.join(workspaceDir, 'real'), path.join(workspaceDir, 'alias'))
  const root = path.join(workspaceDir, 'alias')
  const safe = await readWorkspaceAssetLibraryEntry({ workspaceDir: root, workspacePath: 'Workflows/safe.gltf' })
  assert.equal(safe.success, true)
  await symlink(path.join(workspaceDir, 'outside'), path.join(workspaceDir, 'real/Workflows/link'))
  await symlink(path.join(workspaceDir, 'outside/escape.gltf'), path.join(workspaceDir, 'real/Workflows/leaf.gltf'))
  await mkdir(path.join(workspaceDir, 'real/Workflows/directory.gltf'))
  for (const workspacePath of ['Workflows/link/escape.gltf', 'Workflows/leaf.gltf', 'Workflows/directory.gltf']) {
    assert.equal((await readWorkspaceAssetLibraryEntry({ workspaceDir: root, workspacePath })).success, false)
  }
  await symlink(path.join(workspaceDir, 'outside/escape.gltf'), path.join(workspaceDir, 'real/Workflows/safe.gltf.artifact.json'))
  assert.equal((await readWorkspaceAssetLibraryEntry({ workspaceDir: root, workspacePath: 'Workflows/safe.gltf' })).success, false)
  await symlink(path.join(workspaceDir, 'outside'), path.join(workspaceDir, 'real/Exports'))
  const listed = await listWorkspaceAssetLibrary({ workspaceDir: root })
  assert.equal(listed.success, false, 'symlinked scan roots must not expose external files')
}))

test('library source requests need an indexed existing viewable owner and stable path identity', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Workflows'), { recursive: true })
  for (const name of ['a.gltf', 'b.gltf']) {
    await writeFile(path.join(workspaceDir, 'Workflows', name), '{}')
    await writeArtifactSidecar({ workspaceDir, workspacePath: `Workflows/${name}`, artifactId: 'reused-artifact', metadata: { kind: 'mesh' } })
  }
  const listed = await listWorkspaceAssetLibrary({ workspaceDir })
  assert.equal(listed.success, true)
  if (!listed.success) return
  assert.equal(new Set(listed.entries.map(entry => entry.id)).size, 2)
  assert.throws(() => normalizeAssetLibraryReadRequest({ workspaceDir, workspacePath: 'Workflows/a.gltf', sourceWorkspacePath: 'Workflows/b.gltf' }), /indexed/)
  assert.equal((await openWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: 'Workflows/a.gltf', sourceWorkspacePath: 'Workflows/b.gltf' })).success, false)
}))

test('library IPC rejects caller roots malformed optional sources and list payloads', () => withWorkspace(async workspaceDir => {
  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<any>>()
  registerWorkspaceAssetLibraryIpcHandlers({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, getWorkspaceDir: () => workspaceDir })
  for (const payload of [[], true, 'x', { workspaceDir: '/outside' }, { unexpected: true }]) {
    assert.equal((await handlers.get('workspace:library:list')!(undefined, payload)).success, false)
  }
  for (const channel of ['workspace:library:read', 'workspace:library:open']) {
    for (const sourceWorkspacePath of [null, false, 0, [], {}, '']) {
      assert.equal((await handlers.get(channel)!(undefined, { workspacePath: 'Workflows/safe.glb', sourceWorkspacePath })).success, false)
    }
    assert.equal((await handlers.get(channel)!(undefined, { workspacePath: 'Workflows/safe.glb', workspaceDir: '/outside' })).success, false)
  }
}))

test('enriches sidecars with safe source, manifest, artifact, version, and provenance metadata', () => withWorkspace(async workspaceDir => {
  await mkdir(path.join(workspaceDir, 'Workflows/checkpoints'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'Workflows/checkpoints/hero.glb'), 'glb')
  const workspacePath = 'Workflows/checkpoints/hero.scene.json'
  await writeFile(path.join(workspaceDir, workspacePath), JSON.stringify({ schema: 'modly.scene-manifest.v1', title: 'Hero scene' }))
  assert.equal((await writeArtifactSidecar({ workspaceDir, workspacePath, artifactId: 'artifact-hero', metadata: {
    versionId: 'version-1', source: { workspacePath: 'Workflows/checkpoints/hero.glb', assetId: 'source-asset', versionId: 'source-version' },
    provenance: { workflowId: 'wf-1', workflowNodeId: 'node-1', vendor: { harmless: true } },
    assetLibrary: { capability: 'scene-manifest', schema: 'modly.scene-manifest.v1', title: 'Hero scene' },
    producerExtra: { arbitrary: ['preserved by registry'] },
  } })).success, true)
  const read = await readWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath })
  assert.ok(read.success)
  assert.equal(read.entry.source?.workspacePath, 'Workflows/checkpoints/hero.glb')
  assert.equal(read.entry.source?.assetId, 'source-asset')
  assert.equal(read.entry.source?.versionId, 'source-version')
  assert.equal(read.entry.manifest?.workspacePath, workspacePath)
  assert.equal(read.entry.manifest?.capability, 'scene-manifest')
  assert.equal(read.entry.artifactId, 'artifact-hero')
  assert.equal(read.entry.versionId, 'version-1')
  assert.equal(read.entry.provenance?.workflowId, 'wf-1')
  const registry = await readArtifactSidecar({ workspaceDir, workspacePath })
  assert.ok(registry.success && registry.sidecar)
  assert.deepEqual(registry.sidecar.metadata.producerExtra, { arbitrary: ['preserved by registry'] })
}))

const WORLD_PLY_HEADER = 'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n'

test('library list/read expose bounded PLY headers while Generate open remains mesh-only', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Workflows'), { recursive: true })
  const workspacePath = 'Workflows/世界 con espacios.ply'
  const filePath = path.join(workspaceDir, workspacePath)
  await writeFile(filePath, WORLD_PLY_HEADER + '0 0 0\n')
  const { open } = await import('node:fs/promises')
  const handle = await open(filePath, 'r+')
  try { await handle.truncate(32 * 1024 * 1024) } finally { await handle.close() }
  const list = await listWorkspaceAssetLibrary({ workspaceDir })
  assert.ok(list.success)
  const entry = list.entries.find(item => item.workspacePath === workspacePath)
  assert.deepEqual(entry?.plyHeader, { status: 'complete', content: WORLD_PLY_HEADER })
  const read = await readWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath })
  assert.ok(read.success)
  assert.deepEqual(read.entry.plyHeader, entry?.plyHeader)
  assert.equal(read.preview.kind, 'binary')
  const opened = await openWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath })
  assert.ok(!opened.success)
  assert.match(opened.error, /safe GLB\/GLTF/)
  const replacement = WORLD_PLY_HEADER.replace('end_header', 'property float f_dc_0\nproperty float scale_0\nproperty float rot_0\nend_header')
  await writeFile(filePath, replacement)
  const fresh = await readWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath })
  assert.ok(fresh.success)
  assert.deepEqual(fresh.entry.plyHeader, { status: 'complete', content: replacement })
}))

test('PLY header inspection reports unavailable evidence without reading an unbounded model', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Workflows'), { recursive: true })
  for (const [name, bytes, reason] of [
    ['long', Buffer.from('ply\ncomment ' + 'x'.repeat(65536) + '\nend_header\n'), 'header-too-large'],
    ['short', Buffer.from('ply\nformat ascii 1.0\n'), 'incomplete-header'],
    ['encoding', Buffer.concat([Buffer.from('ply\ncomment '), Buffer.from([255]), Buffer.from('\nend_header\n')]), 'invalid-header-encoding'],
  ] as const) {
    const workspacePath = `Workflows/${name}.ply`
    await writeFile(path.join(workspaceDir, workspacePath), bytes)
    const result = await readWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath })
    assert.ok(result.success)
    assert.deepEqual(result.entry.plyHeader, { status: 'unavailable', reason })
  }
  const listed = await listWorkspaceAssetLibrary({ workspaceDir })
  assert.ok(listed.success)
  assert.equal(listed.entries.length, 3)
}))

test('bounded PLY descriptor reader respects short reads, delimiter and byte ceiling', async () => {
  const { readBoundedPlyHeader } = await import('./artifact-registry-service.ts')
  for (const content of [Buffer.from(WORLD_PLY_HEADER + 'body'.repeat(30000)), Buffer.alloc(100000, 120)]) {
    let readBytes = 0
    const reads: number[] = []
    const result = await readBoundedPlyHeader({ read: async (buffer, offset, length, position) => {
      reads.push(length)
      const bytesRead = Math.min(17, length, content.length - position)
      if (bytesRead > 0) content.copy(buffer, offset, position, position + bytesRead)
      readBytes += bytesRead
      return { bytesRead }
    } })
    assert.ok(reads.every(length => length <= 4096))
    assert.ok(readBytes <= 65536)
    if (content[0] === 112) {
      assert.deepEqual(result, { status: 'complete', content: WORLD_PLY_HEADER })
      assert.ok(readBytes < WORLD_PLY_HEADER.length + 17)
    } else {
      assert.deepEqual(result, { status: 'unavailable', reason: 'header-too-large' })
      assert.equal(readBytes, 65536)
    }
  }
})

test('PLY read retains root-alias support and rejects physical links or nonregular leaves', () => withWorkspace(async (workspaceDir) => {
  await mkdir(path.join(workspaceDir, 'Workflows'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'Workflows/real.ply'), WORLD_PLY_HEADER)
  await mkdir(path.join(workspaceDir, 'Workflows/directory.ply'))
  await symlink(path.join(workspaceDir, 'Workflows/real.ply'), path.join(workspaceDir, 'Workflows/link.ply'))
  await symlink(path.join(workspaceDir, 'missing'), path.join(workspaceDir, 'Workflows/broken.ply'))
  const alias = workspaceDir + '-root-alias'
  await symlink(workspaceDir, alias)
  try {
    const positive = await readWorkspaceAssetLibraryEntry({ workspaceDir: alias, workspacePath: 'Workflows/real.ply' })
    assert.ok(positive.success && positive.entry.plyHeader?.status === 'complete')
    for (const name of ['directory', 'link', 'broken']) {
      assert.equal((await readWorkspaceAssetLibraryEntry({ workspaceDir, workspacePath: `Workflows/${name}.ply` })).success, false)
    }
  } finally { await rm(alias) }
}))

test('bounded PLY inspection preserves CR, CRLF and LF delimiters across short reads without accepting trailing whitespace', async () => {
  const { readBoundedPlyHeader } = await import('./artifact-registry-service.ts')
  for (const newline of ['\n', '\r', '\r\n']) {
    const header = WORLD_PLY_HEADER.replaceAll('\n', newline)
    for (const chunkSize of [1, 7, 4096]) {
      const source = Buffer.from(header + '0 0 0' + newline)
      let total = 0
      const result = await readBoundedPlyHeader({ async read(buffer, offset, length, position) {
        assert.ok(length <= 4096)
        const bytesRead = Math.min(length, chunkSize, source.length - position)
        source.copy(buffer, offset, position, position + bytesRead)
        total += bytesRead
        return { bytesRead }
      } })
      assert.deepEqual(result, { status: 'complete', content: header })
      assert.ok(total <= 65536)
    }
  }
  for (const suffix of [' ', '\t']) {
    const source = Buffer.from(WORLD_PLY_HEADER.replace('end_header', `end_header${suffix}`))
    const result = await readBoundedPlyHeader({ async read(buffer, offset, length, position) {
      const bytesRead = Math.min(length, source.length - position)
      source.copy(buffer, offset, position, position + bytesRead)
      return { bytesRead }
    } })
    assert.deepEqual(result, { status: 'unavailable', reason: 'incomplete-header' })
  }
})

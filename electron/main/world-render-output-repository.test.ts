import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fsPromises, { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deflateSync } from 'node:zlib'

import type { WorldProjectSnapshotV1 } from '../../src/areas/worlds/core/worldModel.ts'
import {
  WORLD_RENDER_MANIFEST_FILENAME,
  type WorldRenderNormalizedCreateRequest,
} from '../../src/shared/types/worldRenders.ts'
import { enumerateWorldFrames } from '../../src/areas/worlds/cinematic/worldRationalTime.ts'
import { createWorldRenderService } from '../../src/areas/worlds/worldRenderService.ts'
import { WorldProjectRepository } from './world-project-repository.ts'
import {
  WorldRenderOutputRepository,
  type WorldRenderExecutionPackage,
} from './world-render-output-repository.ts'
import {
  invalidWorldRenderBlockGroupDurationWebm500ms,
  invalidWorldRenderDefaultFinalFrameWebm1010ms,
  invalidWorldRenderDefaultDurationWebm500ms,
  invalidWorldRenderDefaultDurationQuantizationWebm500ms,
  invalidWorldRenderFullFinalFrameWebm1010ms,
  invalidWorldRenderPrimedOpusWebm500ms,
  invalidWorldRenderRetimedMissingOpusPacketWebm500ms,
  invalidWorldRenderWebm500ms,
  validWorldRenderBlockGroupWebm500ms,
  validWorldRenderCeilDefaultDurationWebm500ms,
  validWorldRenderFfmpegPrimedOpusWebm500ms,
  validWorldRenderFloorDefaultDurationWebm500ms,
  validWorldRenderMediabunnyWebm500ms,
  validWorldRenderMixedOpusDurationsWebm500ms,
  validWorldRenderOpusFramingWebm500ms,
  validWorldRenderPipeWebm500ms,
  validWorldRenderSeekableWebm115msWithoutDefaultDuration,
  validWorldRenderWebm1010ms,
  validWorldRenderWebm500ms,
  validWorldRenderWebmOneOver1001Second,
  validWorldRenderZeroLengthOpusFramesWebm500ms,
  worldRenderMaxOpusFrameWebm500ms,
  type WorldRenderWebmTimelineMutation,
} from './world-render-webm-test-fixture.ts'

const PROJECT_KEY = 'world-0123456789abcdef0123456789abcdef'
const JOB_ID = 'render-0123456789abcdef0123456789abcdef'
const TRUNCATED_WEBM_FIXTURE_BASE64 = 'GkXfowEAAAAAAAAQQoKFd2VibQBCh4ECQoWBAhhTgGcBAAAAAAADEhFNm3QBAAAAAAAAjE27AQAAAAAAABJTq4QVSalmU6yIAAAAAAAAAJhNuwEAAAAAAAASU6uEFlSua1OsiAAAAAAAAAEF7JoBAAAAAAAAElOrhBBDp3BTrIj//////////027AQAAAAAAABJTq4QcU7trU6yIAAAAAAAAAqJNuwEAAAAAAAASU6uEElTDZ1OsiAAAAAAAAALKFUmpZgEAAAAAAABhKtexgw9CQESJiEBaqqqn3ta7TYClR1N0cmVhbWVyIG1hdHJvc2thbXV4IHZlcnNpb24gMS4yNC4yAFdBmUdTdHJlYW1lciBNYXRyb3NrYSBtdXhlcgBEYYgLPfz6EmzYQBZUrmsBAAAAAAAAzK4BAAAAAAAAVteBAYOBAXPFiMAfxkcoOD08I+ODhAH8oFVTboZWaWRlbwDgAQAAAAAAACOwgUC6gUCagQJVsAEAAAAAAAAQVbmBAVWxgQZVuoEGVbuBBoaGVl9WUDkArgEAAAAAAABk14ECg4ECc8WIbj92MfYP+Boj44OEATEtAFNuhkF1ZGlvAOEBAAAAAAAADbWIQOdwAAAAAACfgQKGh0FfT1BVUwBjopNPcHVzSGVhZAECOAGAuwAAAAAAVruEBMS0AFaqg2MuoB9DtnUBAAAAAAAAueeBAKPsgQAAgLEkwaFIAB+AH7AxwSDgwpAAAQBAAGxb///LPX/qZTVMfb6kvcM9vVEtIGbTwQ4M+UJ0OLAyaG057zJidj///ViGbxgK/6WiwmyhMsRjjZ7kxUkjAKNkHmgIWEULorSahuii7aYJDMSAo4eCAAAA/P/+o4eCABQA/P/+o4eCACgA/P/+o4eCADwA/P/+o4eCAFAA/P/+oAEAAAAAAAASm4ENdaKDaES1oYeCAGQA/P/+HFO7awEAAAAAAAAcuwEAAAAAAAATs4EAtwEAAAAAAAAH94EB8YIB3RJUw2cBAAAAAAAAPHNzAQAAAAAAADJjwAEAAAAAAAALY8WIbj92MfYP+BpnyAEAAAAAAAATRaOHQklUU1BTAESHhjY0MDAwAA=='

function request(): WorldRenderNormalizedCreateRequest {
  return {
    projectKey: PROJECT_KEY,
    expectedRevision: 4,
    sceneId: 'scene:main',
    sequenceId: 'sequence:intro',
    preset: { width: 64, height: 64, fps: 30 },
  }
}

function snapshot(): WorldProjectSnapshotV1 {
  return {
    project: {
      schema: 'modly.world-project.v1', projectId: 'project:render', name: 'Render project', revision: 4,
      resources: [{ id: 'resource:model', type: 'model', name: 'Model', workspacePath: 'Assets/model.glb', format: 'glb' }],
      scenes: [{ id: 'scene:main', name: 'Main', documentPath: `Worlds/${PROJECT_KEY}/scenes/scene-main.world-scene.json` }],
      startSceneId: 'scene:main', inputActions: [],
      graphicsProfiles: [{ id: 'graphics:balanced', name: 'Balanced', renderScale: 1, shadowQuality: 'medium', antialiasing: 'fxaa' }],
      activeGraphicsProfileId: 'graphics:balanced',
    },
    scenes: [{
      schema: 'modly.world-scene.v1', projectId: 'project:render', sceneId: 'scene:main', name: 'Main',
      environment: { backgroundColor: '#101114', ambientIntensity: 0.2 },
      entities: [{
        id: 'entity:camera', name: 'Camera', parentId: null, enabled: true, locked: false, tags: [],
        transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
        components: [{ id: 'component:camera', type: 'camera', enabled: true, projection: 'perspective', primary: true, near: 0.1, far: 100, fieldOfView: 60 }],
      }],
      sequences: [{ id: 'sequence:intro', name: 'Intro', duration: { numerator: 1, denominator: 2 }, tracks: [] }],
    }],
  }
}

function png(index: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(64, 0)
  ihdr.writeUInt32BE(64, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc(64 * (1 + 64 * 4))
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('tEXt', Buffer.from(`frame=${index}`)),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function indexedPng(includePalette: boolean): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(64, 0)
  ihdr.writeUInt32BE(64, 4)
  ihdr[8] = 8
  ihdr[9] = 3
  const chunks = [pngChunk('IHDR', ihdr)]
  if (includePalette) chunks.push(pngChunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255])))
  chunks.push(
    pngChunk('IDAT', deflateSync(Buffer.alloc(64 * (1 + 64)))),
    pngChunk('IEND', Buffer.alloc(0)),
  )
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks])
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii')
  const result = Buffer.alloc(12 + data.length)
  result.writeUInt32BE(data.length, 0)
  name.copy(result, 4)
  data.copy(result, 8)
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length)
  return result
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffff_ffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb8_8320 & -(value & 1))
  }
  return (value ^ 0xffff_ffff) >>> 0
}

function headerOnlyPng(): Buffer {
  const header = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header)
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12, 'ascii')
  header.writeUInt32BE(64, 16)
  header.writeUInt32BE(64, 20)
  header[24] = 8
  header[25] = 6
  return Buffer.concat([header, Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0])])
}

function wav(sampleFrames = 24_000): Buffer {
  const dataSize = sampleFrames * 4
  const bytes = Buffer.alloc(44 + dataSize)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8, 'ascii')
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(2, 22)
  bytes.writeUInt32LE(48_000, 24)
  bytes.writeUInt32LE(192_000, 28)
  bytes.writeUInt16LE(4, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36, 'ascii')
  bytes.writeUInt32LE(dataSize, 40)
  return bytes
}

function webm(): Buffer {
  return validWorldRenderWebm500ms()
}

function truncatedWebm(): Buffer {
  return Buffer.from(TRUNCATED_WEBM_FIXTURE_BASE64, 'base64')
}

function magicOnlyWebm(): Buffer {
  return Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81])
}

async function fixture(t: test.TestContext, options: Partial<ConstructorParameters<typeof WorldRenderOutputRepository>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-render-output-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'Assets'), { recursive: true })
  await writeFile(join(root, 'Assets', 'model.glb'), Buffer.from('immutable-model'))
  const repository = new WorldRenderOutputRepository({
    getWorkspaceRoot: () => root,
    createJobId: () => JOB_ID,
    now: () => new Date('2026-09-02T12:00:00.000Z'),
    ...options,
  })
  return { root, repository }
}

async function settleWithin<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolvePromise, rejectPromise) => {
        timer = setTimeout(() => rejectPromise(new Error('test operation did not settle')), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function rendererAdapterFor(repository: WorldRenderOutputRepository) {
  return createWorldRenderService({
    create: async () => { throw new Error('unused') },
    list: () => repository.list(),
    get: (requestValue) => repository.get(requestValue),
    cancel: (requestValue) => repository.requestCancel(requestValue.jobId),
    delete: (requestValue) => repository.delete(requestValue),
  })
}

function replaceBuiltinLstat(replacement: typeof fsPromises.lstat): () => void {
  const original = fsPromises.lstat
  fsPromises.lstat = replacement
  syncBuiltinESMExports()
  return () => {
    fsPromises.lstat = original
    syncBuiltinESMExports()
  }
}

test('read-only recovery leaves a genuinely absent workspace untouched until the project authority creates it', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'modly-world-render-clean-profile-'))
  const workspaceRoot = join(parent, 'workspace')
  t.after(() => rm(parent, { recursive: true, force: true }))
  const repository = new WorldRenderOutputRepository({
    getWorkspaceRoot: () => workspaceRoot,
    createJobId: () => JOB_ID,
    now: () => new Date('2026-09-02T12:00:00.000Z'),
  })

  assert.deepEqual(await repository.recoverJobs(), [])
  assert.deepEqual(await repository.list(), { ok: true, value: { jobs: [] } })
  assert.equal(await lstat(workspaceRoot).then(() => true, () => false), false)

  const projectRepository = new WorldProjectRepository({
    getWorkspaceRoot: () => workspaceRoot,
    createProjectKey: () => PROJECT_KEY,
    createSceneKey: () => 'scene-0123456789abcdef0123456789abcdef',
  })
  const project = await projectRepository.create({ name: 'Created later', initialSceneName: 'Main' })
  assert.equal(project.ok, true, project.ok ? undefined : project.error.code)
  assert.deepEqual(await repository.recoverJobs(), [])
  assert.deepEqual(await repository.list(), { ok: true, value: { jobs: [] } })
  assert.equal(await lstat(join(workspaceRoot, 'Exports')).then(() => true, () => false), false)
  await mkdir(join(workspaceRoot, 'Assets'))
  await writeFile(join(workspaceRoot, 'Assets', 'model.glb'), Buffer.from('immutable-model'))

  const framePlan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
  const created = await repository.createJob({ request: request(), snapshot: snapshot(), framePlan })
  assert.equal(created.ok, true, created.ok ? undefined : created.error.code)
  assert.equal((await lstat(join(workspaceRoot, 'Exports', 'Worlds', 'Renders'))).isDirectory(), true)
})

test('read-only absence rejects symlink aliases and resolver failures instead of reporting an empty repository', async (t) => {
  const aliasBase = await mkdtemp(join(tmpdir(), 'modly-world-render-read-alias-'))
  const aliasTarget = await mkdtemp(join(tmpdir(), 'modly-world-render-read-target-'))
  t.after(() => Promise.all([
    rm(aliasBase, { recursive: true, force: true }),
    rm(aliasTarget, { recursive: true, force: true }),
  ]))
  await symlink(aliasTarget, join(aliasBase, 'alias'), 'dir')
  const aliasedWorkspace = join(aliasBase, 'alias', 'missing-workspace')
  const aliasedRepository = new WorldRenderOutputRepository({ getWorkspaceRoot: () => aliasedWorkspace })

  const aliasedList = await aliasedRepository.list()
  assert.equal(aliasedList.ok, false)
  if (!aliasedList.ok) assert.equal(aliasedList.error.code, 'unsafe_workspace')
  await assert.rejects(aliasedRepository.recoverJobs(), /unsafe_workspace/)
  assert.equal(await lstat(join(aliasTarget, 'missing-workspace')).then(() => true, () => false), false)

  const nonDirectoryRoot = join(aliasBase, 'workspace-file')
  await writeFile(nonDirectoryRoot, 'not a directory')
  const nonDirectoryRepository = new WorldRenderOutputRepository({ getWorkspaceRoot: () => nonDirectoryRoot })
  const nonDirectoryList = await nonDirectoryRepository.list()
  assert.equal(nonDirectoryList.ok, false)
  if (!nonDirectoryList.ok) assert.equal(nonDirectoryList.error.code, 'unsafe_workspace')
  await assert.rejects(nonDirectoryRepository.recoverJobs(), /unsafe_workspace/)

  const resolverFailure = new WorldRenderOutputRepository({
    getWorkspaceRoot: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) },
  })
  const failedList = await resolverFailure.list()
  assert.equal(failedList.ok, false)
  if (!failedList.ok) assert.equal(failedList.error.code, 'unsafe_workspace')
  await assert.rejects(resolverFailure.recoverJobs(), /write_failed/)
})

test('read-only absence rejects a symlinked output ancestor without creating through it', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'modly-world-render-output-alias-'))
  const external = await mkdtemp(join(tmpdir(), 'modly-world-render-output-external-'))
  t.after(() => Promise.all([
    rm(workspaceRoot, { recursive: true, force: true }),
    rm(external, { recursive: true, force: true }),
  ]))
  await symlink(external, join(workspaceRoot, 'Exports'), 'dir')
  const repository = new WorldRenderOutputRepository({ getWorkspaceRoot: () => workspaceRoot })

  const listed = await repository.list()
  assert.equal(listed.ok, false)
  if (!listed.ok) assert.equal(listed.error.code, 'unsafe_workspace')
  await assert.rejects(repository.recoverJobs(), /unsafe_workspace/)
  assert.equal(await lstat(join(external, 'Worlds')).then(() => true, () => false), false)
})

test('read-only recovery fails closed when the absent workspace becomes a symlink during its first lstat', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'modly-world-render-workspace-race-'))
  const external = await mkdtemp(join(tmpdir(), 'modly-world-render-workspace-race-target-'))
  const workspaceRoot = join(parent, 'workspace')
  t.after(() => Promise.all([
    rm(parent, { recursive: true, force: true }),
    rm(external, { recursive: true, force: true }),
  ]))
  const originalLstat = fsPromises.lstat
  let injected = false
  const restore = replaceBuiltinLstat((async (path) => {
    if (!injected && String(path) === workspaceRoot) {
      injected = true
      await symlink(external, workspaceRoot, 'dir')
      throw Object.assign(new Error('simulated raced absence'), { code: 'ENOENT' })
    }
    return originalLstat(path)
  }) as typeof fsPromises.lstat)

  try {
    const repository = new WorldRenderOutputRepository({ getWorkspaceRoot: () => workspaceRoot })
    await assert.rejects(repository.recoverJobs(), /unsafe_workspace/)
    assert.equal(injected, true)
  } finally {
    restore()
  }
})

test('read-only recovery requires a stable absence when a later lstat races with a new workspace symlink', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'modly-world-render-workspace-recheck-race-'))
  const external = await mkdtemp(join(tmpdir(), 'modly-world-render-workspace-recheck-target-'))
  const workspaceRoot = join(parent, 'workspace')
  t.after(() => Promise.all([
    rm(parent, { recursive: true, force: true }),
    rm(external, { recursive: true, force: true }),
  ]))
  const originalLstat = fsPromises.lstat
  let workspaceLstatCalls = 0
  const restore = replaceBuiltinLstat((async (path) => {
    if (String(path) === workspaceRoot) {
      workspaceLstatCalls += 1
      if (workspaceLstatCalls === 2) {
        await symlink(external, workspaceRoot, 'dir')
        throw Object.assign(new Error('simulated raced recheck'), { code: 'ENOENT' })
      }
    }
    return originalLstat(path)
  }) as typeof fsPromises.lstat)

  try {
    const repository = new WorldRenderOutputRepository({ getWorkspaceRoot: () => workspaceRoot })
    await assert.rejects(repository.recoverJobs(), /unsafe_workspace/)
    assert.equal(workspaceLstatCalls, 2)
  } finally {
    restore()
  }
})

test('read-only recovery fails closed when the absent output root becomes a symlink during validation', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'modly-world-render-output-race-'))
  const external = await mkdtemp(join(tmpdir(), 'modly-world-render-output-race-target-'))
  const outputRoot = join(workspaceRoot, 'Exports', 'Worlds', 'Renders')
  await mkdir(join(workspaceRoot, 'Exports', 'Worlds'), { recursive: true })
  t.after(() => Promise.all([
    rm(workspaceRoot, { recursive: true, force: true }),
    rm(external, { recursive: true, force: true }),
  ]))
  const originalLstat = fsPromises.lstat
  let outputLstatCalls = 0
  const restore = replaceBuiltinLstat((async (path) => {
    if (String(path) === outputRoot) {
      outputLstatCalls += 1
      if (outputLstatCalls === 2) {
        await symlink(external, outputRoot, 'dir')
        throw Object.assign(new Error('simulated raced absence'), { code: 'ENOENT' })
      }
    }
    return originalLstat(path)
  }) as typeof fsPromises.lstat)

  try {
    const repository = new WorldRenderOutputRepository({ getWorkspaceRoot: () => workspaceRoot })
    await assert.rejects(repository.recoverJobs(), /unsafe_workspace/)
    assert.equal(outputLstatCalls, 3)
  } finally {
    restore()
  }
})

test('read-only recovery rejects deepest workspace ancestor replacement during the final absence scan', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'modly-world-render-workspace-ancestor-race-'))
  const ancestor = join(parent, 'configured-parent')
  const displacedAncestor = join(parent, 'configured-parent-original')
  const workspaceRoot = join(ancestor, 'workspace')
  await mkdir(ancestor)
  t.after(() => rm(parent, { recursive: true, force: true }))
  const originalLstat = fsPromises.lstat
  let workspaceLstatCalls = 0
  const restore = replaceBuiltinLstat((async (path) => {
    if (String(path) === workspaceRoot) {
      workspaceLstatCalls += 1
      if (workspaceLstatCalls === 3) {
        await rename(ancestor, displacedAncestor)
        await mkdir(ancestor)
        throw Object.assign(new Error('simulated final-scan replacement'), { code: 'ENOENT' })
      }
    }
    return originalLstat(path)
  }) as typeof fsPromises.lstat)

  try {
    const repository = new WorldRenderOutputRepository({ getWorkspaceRoot: () => workspaceRoot })
    await assert.rejects(repository.recoverJobs(), /unsafe_workspace/)
    assert.equal(workspaceLstatCalls, 3)
  } finally {
    restore()
  }
})

test('read-only recovery rejects deepest output ancestor replacement during the final absence scan', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'modly-world-render-output-ancestor-race-'))
  const ancestor = join(workspaceRoot, 'Exports', 'Worlds')
  const displacedAncestor = join(workspaceRoot, 'Exports', 'Worlds-original')
  const outputRoot = join(ancestor, 'Renders')
  await mkdir(ancestor, { recursive: true })
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }))
  const originalLstat = fsPromises.lstat
  let outputLstatCalls = 0
  const restore = replaceBuiltinLstat((async (path) => {
    if (String(path) === outputRoot) {
      outputLstatCalls += 1
      if (outputLstatCalls === 4) {
        await rename(ancestor, displacedAncestor)
        await mkdir(ancestor)
        throw Object.assign(new Error('simulated final-scan replacement'), { code: 'ENOENT' })
      }
    }
    return originalLstat(path)
  }) as typeof fsPromises.lstat)

  try {
    const repository = new WorldRenderOutputRepository({ getWorkspaceRoot: () => workspaceRoot })
    await assert.rejects(repository.recoverJobs(), /unsafe_workspace/)
    assert.equal(outputLstatCalls, 4)
  } finally {
    restore()
  }
})

test('pins an immutable revision/scene/sequence/resource package and exact rational frame plan', async (t) => {
  const { root, repository } = await fixture(t)
  const source = snapshot()
  source.project.resources.push({
    id: 'resource:walk', type: 'animation', name: 'Walk', workspacePath: 'Animations/walk.pose.json',
    sourceWorkspacePath: 'Assets/walk-source.glb', legacyWorkspacePath: 'Animations/walk.legacy.json',
    format: 'pose-clip',
  })
  await mkdir(join(root, 'Animations'), { recursive: true })
  await writeFile(join(root, 'Animations', 'walk.pose.json'), 'pose')
  await writeFile(join(root, 'Assets', 'walk-source.glb'), 'source')
  await writeFile(join(root, 'Animations', 'walk.legacy.json'), 'legacy')
  const plan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
  const created = await repository.createJob({ request: request(), snapshot: source, framePlan: plan })
  assert.equal(created.ok, true, created.ok ? undefined : created.error.code)
  if (!created.ok) return
  assert.equal(created.value.jobId, JOB_ID)
  assert.equal(created.value.status, 'queued')
  assert.equal(created.value.frameCount, 15)
  assert.equal(created.value.progress.completedUnits, 0)
  assert.equal(created.value.progress.totalUnits, 17)

  source.project.name = 'Edited later'
  source.project.revision = 5
  source.scenes[0].sequences[0].duration = { numerator: 99, denominator: 1 }
  await writeFile(join(root, 'Assets', 'model.glb'), Buffer.from('changed-later'))

  const execution = await repository.openExecutionPackage(JOB_ID)
  assert.equal(execution.snapshot.project.name, 'Render project')
  assert.equal(execution.snapshot.project.revision, 4)
  assert.deepEqual(execution.sequence.duration, { numerator: 1, denominator: 2 })
  assert.equal(execution.framePlan.length, 15)
  assert.deepEqual(execution.framePlan.at(-1), {
    index: 14,
    time: { numerator: 7, denominator: 15 },
    duration: { numerator: 1, denominator: 30 },
    timestampMicroseconds: 466_667,
  })
  assert.equal(await readFile(join(root, execution.resources[0].files[0].workspacePath), 'utf8'), 'immutable-model')
  assert.equal(execution.resources[0].files[0].sha256, createHash('sha256').update('immutable-model').digest('hex'))
  assert.equal((await lstat(join(root, execution.resources[0].files[0].workspacePath))).nlink, 1)
  assert.deepEqual(execution.resources[1].files.map((file) => file.role), ['primary', 'source', 'legacy'])
  assert.deepEqual(await Promise.all(execution.resources[1].files.map((file) => readFile(join(root, file.workspacePath), 'utf8'))), [
    'pose', 'source', 'legacy',
  ])
  const persistedSnapshot = JSON.parse(await readFile(
    join(root, 'Exports', 'Worlds', 'Renders', JOB_ID, 'snapshot', 'render-snapshot.v1.json'),
    'utf8',
  ))
  assert.deepEqual(Object.keys(persistedSnapshot.framePlan).sort(), ['fps', 'frameCount', 'sha256'])
  assert.equal(persistedSnapshot.framePlan.fps, 30)
  assert.equal(persistedSnapshot.framePlan.frameCount, 15)
  assert.match(persistedSnapshot.framePlan.sha256, /^[a-f0-9]{64}$/)
})

test('pinned resource reads abort while queued and never wait for unrelated durable serialization', async (t) => {
  let blockSync = false
  let enteredBlockedSync!: () => void
  let releaseBlockedSync!: () => void
  const blockedSyncEntered = new Promise<void>((resolvePromise) => { enteredBlockedSync = resolvePromise })
  const blockedSyncRelease = new Promise<void>((resolvePromise) => { releaseBlockedSync = resolvePromise })
  const { repository } = await fixture(t, {
    syncDirectory: async () => {
      if (blockSync) {
        enteredBlockedSync()
        await blockedSyncRelease
      }
      return true
    },
  })
  const plan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
  assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan: plan })).ok, true)

  blockSync = true
  const durableWrite = repository.recordFrame(JOB_ID, 0, png(0))
  await blockedSyncEntered
  const controller = new AbortController()
  const read = repository.readPinnedResource(JOB_ID, 'resource:model', 'primary', controller.signal)
    .then(() => 'completed', (error: unknown) => (
      error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'failed'
    ))
  controller.abort()
  const outcome = await settleWithin(read, 250)
  releaseBlockedSync()
  await durableWrite
  await read
  assert.equal(outcome, 'aborted')
})

test('pinned resource reads use preflight-sealed authorization without rehashing unrelated resources', async (t) => {
  const { root, repository } = await fixture(t)
  const source = snapshot()
  source.project.resources.push({
    id: 'resource:second',
    type: 'model',
    name: 'Second model',
    workspacePath: 'Assets/second.glb',
    format: 'glb',
  })
  await writeFile(join(root, 'Assets', 'second.glb'), Buffer.from('second-model'))
  const plan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
  assert.equal((await repository.createJob({ request: request(), snapshot: source, framePlan: plan })).ok, true)

  const execution = await repository.openExecutionPackage(JOB_ID)
  const unrelated = execution.resources.find((candidate) => candidate.resource.id === 'resource:second')?.files[0]
  assert.ok(unrelated)
  const unrelatedPath = join(root, unrelated.workspacePath)
  await chmod(unrelatedPath, 0o600)
  await writeFile(unrelatedPath, Buffer.from('tampered-mod'))

  const resource = await repository.readPinnedResource(
    JOB_ID,
    'resource:model',
    'primary',
    new AbortController().signal,
  )
  assert.equal(Buffer.from(resource.bytes).toString('utf8'), 'immutable-model')
})

test('execution package verification is abortable without retaining durable repository queue custody', async (t) => {
  const { repository } = await fixture(t)
  const plan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
  assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan: plan })).ok, true)

  const internal = repository as unknown as {
    loadExecutionPackage: (...args: unknown[]) => Promise<WorldRenderExecutionPackage>
  }
  const originalLoad = internal.loadExecutionPackage.bind(repository)
  let enterVerification!: () => void
  let releaseVerification!: () => void
  const verificationEntered = new Promise<void>((resolvePromise) => { enterVerification = resolvePromise })
  const verificationRelease = new Promise<void>((resolvePromise) => { releaseVerification = resolvePromise })
  let forwardedSignal: AbortSignal | undefined
  internal.loadExecutionPackage = async (...args) => {
    forwardedSignal = args[4] as AbortSignal | undefined
    enterVerification()
    await verificationRelease
    return originalLoad(...args)
  }

  const controller = new AbortController()
  const openExecutionPackage = repository.openExecutionPackage as unknown as (
    jobId: string,
    signal: AbortSignal,
  ) => Promise<WorldRenderExecutionPackage>
  const opening = openExecutionPackage.call(repository, JOB_ID, controller.signal)
  await verificationEntered
  const cancelRequest = repository.requestCancel(JOB_ID)
  const cancelOutcome = await settleWithin(
    cancelRequest.then((result) => result.ok ? result.value.status : 'failed'),
    1_000,
  )
  controller.abort()
  releaseVerification()
  await assert.rejects(opening, (error: unknown) => error instanceof Error && error.name === 'AbortError')
  await cancelRequest
  assert.equal(forwardedSignal, controller.signal)
  assert.equal(cancelOutcome, 'cancel_requested')
})

test('pins the complete multiscene revision while selecting one exact render scene and sequence', async (t) => {
  const { repository } = await fixture(t)
  const source = snapshot()
  source.project.scenes.push({
    id: 'scene:second', name: 'Second',
    documentPath: `Worlds/${PROJECT_KEY}/scenes/scene-second.world-scene.json`,
  })
  source.scenes.push({
    schema: 'modly.world-scene.v1', projectId: 'project:render', sceneId: 'scene:second', name: 'Second',
    environment: { backgroundColor: '#000000', ambientIntensity: 0 }, entities: [], sequences: [],
  })
  const plan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
  assert.equal((await repository.createJob({ request: request(), snapshot: source, framePlan: plan })).ok, true)
  const execution = await repository.openExecutionPackage(JOB_ID)
  assert.deepEqual(execution.snapshot.project.scenes.map((scene) => scene.id), ['scene:main', 'scene:second'])
  assert.deepEqual(execution.snapshot.scenes.map((scene) => scene.sceneId), ['scene:main', 'scene:second'])
  assert.equal(execution.scene.sceneId, 'scene:main')
  assert.equal(execution.sequence.id, 'sequence:intro')
})

test('repository-owned partial masters survive the renderer adapter and terminal truth requires verified masters', async (t) => {
  const { root, repository } = await fixture(t)
  const plan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
  assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan: plan })).ok, true)
  for (const frame of plan) await repository.recordFrame(JOB_ID, frame.index, png(frame.index))
  await repository.recordAudio(JOB_ID, wav())
  const partial = await repository.settle(JOB_ID, { executorError: null })
  assert.equal(partial.ok, true)
  if (!partial.ok) return
  assert.equal(partial.value.status, 'partial')
  assert.equal(partial.value.outputs.frames.length, 15)
  assert.equal(partial.value.outputs.audio?.workspacePath.endsWith('/audio/master.wav'), true)
  assert.equal(partial.value.outputs.renderManifest?.workspacePath.endsWith(`/${WORLD_RENDER_MANIFEST_FILENAME}`), true)
  assert.equal(partial.value.outputs.webm, null)
  assert.equal(partial.value.error?.code, 'output_invalid')

  const rendererPartial = await rendererAdapterFor(repository).get({ jobId: JOB_ID })
  assert.equal(rendererPartial.ok, true, JSON.stringify(rendererPartial))
  if (!rendererPartial.ok) return
  assert.equal(rendererPartial.value.status, 'partial')
  assert.equal(
    rendererPartial.value.outputs.renderManifest?.workspacePath,
    `Exports/Worlds/Renders/${JOB_ID}/${WORLD_RENDER_MANIFEST_FILENAME}`,
  )

  const manifest = JSON.parse(await readFile(join(root, partial.value.outputs.renderManifest!.workspacePath), 'utf8'))
  assert.equal(manifest.frames[0].workspacePath.endsWith('/frames/frame-000000.png'), true)
  assert.equal(manifest.frames[0].sha256, createHash('sha256').update(png(0)).digest('hex'))
  assert.equal(manifest.audio.sha256, createHash('sha256').update(wav()).digest('hex'))

  const second = new WorldRenderOutputRepository({
    getWorkspaceRoot: () => root,
    createJobId: () => 'render-fedcba9876543210fedcba9876543210',
  })
  const created = await second.createJob({ request: request(), snapshot: snapshot(), framePlan: plan })
  assert.equal(created.ok, true)
  if (!created.ok) return
  await second.recordFrame(created.value.jobId, 0, Buffer.from('only-one-frame'))
  const failed = await second.settle(created.value.jobId, { executorError: null })
  assert.equal(failed.ok, true)
  if (failed.ok) assert.equal(failed.value.status, 'failed')
})

test('snapshot pinning rejects empty resource payloads instead of creating an unreadable job', async (t) => {
  const { root, repository } = await fixture(t)
  await writeFile(join(root, 'Assets', 'model.glb'), Buffer.alloc(0))
  const plan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
  const created = await repository.createJob({ request: request(), snapshot: snapshot(), framePlan: plan })
  assert.equal(created.ok, false)
  if (!created.ok) assert.equal(created.error.code, 'output_invalid')
})

test('creation fails closed when a directory publication cannot be durably synced', async (t) => {
  const { repository } = await fixture(t, { syncDirectory: async () => false })
  const plan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
  const created = await repository.createJob({ request: request(), snapshot: snapshot(), framePlan: plan })
  assert.equal(created.ok, false)
  if (!created.ok) assert.equal(created.error.code, 'write_failed')
})

test('resource pinning enforces bounded per-file and aggregate copy budgets', async (t) => {
  const { repository } = await fixture(t, {
    maximumPinnedResourceBytes: 8,
    maximumPinnedResourceTotalBytes: 16,
  })
  const plan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
  const created = await repository.createJob({ request: request(), snapshot: snapshot(), framePlan: plan })
  assert.equal(created.ok, false)
  if (!created.ok) assert.equal(created.error.code, 'output_invalid')
})

test('executor errors are canonicalized before they enter durable or public state', async (t) => {
  const { repository } = await fixture(t)
  const plan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
  assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan: plan })).ok, true)
  const settled = await repository.settle(JOB_ID, {
    executorError: {
      code: 'output_invalid',
      message: 'private path: /home/user/secret',
      retryable: true,
    },
  })
  assert.equal(settled.ok, true)
  if (settled.ok) {
    assert.equal(settled.value.error?.message, 'World render output is incomplete or invalid.')
    assert.equal(settled.value.error?.retryable, false)
  }
})

test('per-frame durability uses bounded receipts instead of rewriting an ever-growing job state', async (t) => {
  const { root, repository } = await fixture(t)
  const plan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
  assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan: plan })).ok, true)
  const statePath = join(root, 'Exports', 'Worlds', 'Renders', JOB_ID, 'job.v1.json')
  const initialSize = (await lstat(statePath)).size
  for (const frame of plan) await repository.recordFrame(JOB_ID, frame.index, png(frame.index))
  const finalBytes = await readFile(statePath)
  assert.equal(finalBytes.length <= initialSize + 256, true)
  assert.equal(finalBytes.includes(Buffer.from('frame-000014.png')), false)
  assert.equal((await readdir(join(root, 'Exports', 'Worlds', 'Renders', JOB_ID, '.modly', 'artifacts'))).length, 15)
})

test('verified WebM survives the production repository-to-renderer adapter seam and corruption recovers as recovery_failed', async (t) => {
  const { root, repository } = await fixture(t)
  const plan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
  assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan: plan })).ok, true)
  for (const frame of plan) await repository.recordFrame(JOB_ID, frame.index, png(frame.index))
  await repository.recordAudio(JOB_ID, wav())
  await repository.recordWebm(JOB_ID, webm())
  const settled = await repository.settle(JOB_ID, { executorError: null })
  assert.equal(settled.ok, true)
  if (!settled.ok) return
  assert.equal(settled.value.status, 'succeeded')

  const rendererJob = await rendererAdapterFor(repository).get({ jobId: JOB_ID })
  assert.equal(rendererJob.ok, true, JSON.stringify(rendererJob))
  if (!rendererJob.ok) return
  assert.equal(rendererJob.value.outputs.webm?.workspacePath, `Exports/Worlds/Renders/${JOB_ID}/output.webm`)

  const framePath = join(root, settled.value.outputs.frames[0].workspacePath)
  await writeFile(framePath, Buffer.from('corrupt'))
  const recovered = await new WorldRenderOutputRepository({ getWorkspaceRoot: () => root }).recoverJobs()
  const job = recovered.find((candidate) => candidate.jobId === JOB_ID)
  assert.equal(job?.status, 'recovery_failed')
  assert.equal(job?.outputs.frames.length, 0)
})

test('rejects a VP9/Opus WebM whose media timeline is truncated relative to the pinned render plan', async (t) => {
  const { repository } = await fixture(t)
  const plan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
  assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan: plan })).ok, true)
  for (const frame of plan) await repository.recordFrame(JOB_ID, frame.index, png(frame.index))
  await repository.recordAudio(JOB_ID, wav())

  // This real GStreamer fixture declares about 107 ms and contains only one
  // video sample. Track presence alone must not satisfy a 500 ms / 15-frame job.
  await repository.recordWebm(JOB_ID, truncatedWebm())
  const settled = await repository.settle(JOB_ID, { executorError: null })

  assert.equal(settled.ok, true)
  if (settled.ok) {
    assert.equal(settled.value.status, 'partial')
    assert.equal(settled.value.outputs.webm, null)
    assert.equal(settled.value.error?.code, 'output_invalid')
  }
})

test('rejects malformed or incomplete WebM timelines against the exact pinned frame/audio plan', async (t) => {
  const mutations: readonly WorldRenderWebmTimelineMutation[] = [
    'duplicate-video-timestamp',
    'out-of-order-video-timestamp',
    'extra-video-block',
    'missing-audio-tail',
    'forged-duration',
    'video-lacing',
    'truncated-opus-vbr-length',
    'opus-code3-zero-frames',
    'opus-code3-padding-overrun',
    'opus-code3-vbr-length-overrun',
    'default-duration-contradiction',
    'default-duration-zero',
  ]
  for (const mutation of mutations) {
    await t.test(mutation, async (subtest) => {
      const { repository } = await fixture(subtest)
      const framePlan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
      assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan })).ok, true)
      for (const frame of framePlan) await repository.recordFrame(JOB_ID, frame.index, png(frame.index))
      await repository.recordAudio(JOB_ID, wav())
      await repository.recordWebm(JOB_ID, invalidWorldRenderWebm500ms(mutation))

      const settled = await repository.settle(JOB_ID, { executorError: null })
      assert.equal(settled.ok, true, mutation)
      if (settled.ok) {
        assert.equal(settled.value.status, 'partial', mutation)
        assert.equal(settled.value.outputs.webm, null, mutation)
      }
    })
  }
})

test('accepts the non-seekable pipe WebM layout with unknown sizes and media-proven duration', async (t) => {
  const { repository } = await fixture(t)
  const framePlan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
  assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan })).ok, true)
  for (const frame of framePlan) await repository.recordFrame(JOB_ID, frame.index, png(frame.index))
  await repository.recordAudio(JOB_ID, wav())
  await repository.recordWebm(JOB_ID, validWorldRenderPipeWebm500ms())

  const settled = await repository.settle(JOB_ID, { executorError: null })
  assert.equal(settled.ok && settled.value.status, 'succeeded')
})

test('accepts producer-compatible VP9 BlockGroup and Opus SimpleBlock timelines', async (t) => {
  const { repository } = await fixture(t)
  const framePlan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
  assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan })).ok, true)
  for (const frame of framePlan) await repository.recordFrame(JOB_ID, frame.index, png(frame.index))
  await repository.recordAudio(JOB_ID, wav())
  await repository.recordWebm(JOB_ID, validWorldRenderBlockGroupWebm500ms())

  const settled = await repository.settle(JOB_ID, { executorError: null })
  assert.equal(settled.ok && settled.value.status, 'succeeded')
})

test('accepts the pinned Mediabunny SimpleBlock layout without video duration metadata', async (t) => {
  const { repository } = await fixture(t)
  const framePlan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
  assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan })).ok, true)
  for (const frame of framePlan) await repository.recordFrame(JOB_ID, frame.index, png(frame.index))
  await repository.recordAudio(JOB_ID, wav())
  await repository.recordWebm(JOB_ID, validWorldRenderMediabunnyWebm500ms())

  const settled = await repository.settle(JOB_ID, { executorError: null })
  assert.equal(settled.ok && settled.value.status, 'succeeded')
})

test('verifies exact shortened video/audio tails for non-frame-aligned and sub-frame plans', async (t) => {
  const cases = [
    {
      name: '23/200 seconds at 30 fps',
      duration: { numerator: 23, denominator: 200 },
      audioSamples: 5_520,
      webm: validWorldRenderSeekableWebm115msWithoutDefaultDuration(),
    },
    {
      name: '101/100 seconds at 30 fps',
      duration: { numerator: 101, denominator: 100 },
      audioSamples: 48_480,
      webm: validWorldRenderWebm1010ms(),
    },
    {
      name: '1/1001 second at 30 fps',
      duration: { numerator: 1, denominator: 1_001 },
      audioSamples: 47,
      webm: validWorldRenderWebmOneOver1001Second(),
    },
  ] as const
  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, async (subtest) => {
      const { repository } = await fixture(subtest)
      const source = snapshot()
      source.scenes[0].sequences[0].duration = { ...fixtureCase.duration }
      const framePlan = enumerateWorldFrames(fixtureCase.duration, 30, 864_000)
      assert.equal((await repository.createJob({ request: request(), snapshot: source, framePlan })).ok, true)
      for (const frame of framePlan) await repository.recordFrame(JOB_ID, frame.index, png(frame.index))
      await repository.recordAudio(JOB_ID, wav(fixtureCase.audioSamples))
      await repository.recordWebm(JOB_ID, fixtureCase.webm)
      const settled = await repository.settle(JOB_ID, { executorError: null })
      assert.equal(settled.ok && settled.value.status, 'succeeded')
    })
  }
})

test('rejects nominal BlockDuration or DefaultDuration extending an exact shortened final sample', async (t) => {
  for (const [name, webmBytes] of [
    ['BlockDuration', invalidWorldRenderFullFinalFrameWebm1010ms()],
    ['DefaultDuration', invalidWorldRenderDefaultFinalFrameWebm1010ms()],
  ] as const) {
    await t.test(name, async (subtest) => {
      const { repository } = await fixture(subtest)
      const duration = { numerator: 101, denominator: 100 }
      const source = snapshot()
      source.scenes[0].sequences[0].duration = duration
      const framePlan = enumerateWorldFrames(duration, 30, 864_000)
      assert.equal((await repository.createJob({ request: request(), snapshot: source, framePlan })).ok, true)
      for (const frame of framePlan) await repository.recordFrame(JOB_ID, frame.index, png(frame.index))
      await repository.recordAudio(JOB_ID, wav(48_480))
      await repository.recordWebm(JOB_ID, webmBytes)

      const settled = await repository.settle(JOB_ID, { executorError: null })
      assert.equal(settled.ok && settled.value.status, 'partial')
    })
  }
})

test('uses one cumulative audio clock for mixed Opus durations and rejects retimed missing media', async (t) => {
  for (const [name, webmBytes, expectedStatus] of [
    ['mixed 2.5/5/10/20/40/60 ms packets', validWorldRenderMixedOpusDurationsWebm500ms(), 'succeeded'],
    ['one missing 20 ms packet hidden by retimed gaps', invalidWorldRenderRetimedMissingOpusPacketWebm500ms(), 'partial'],
  ] as const) {
    await t.test(name, async (subtest) => {
      const { repository } = await fixture(subtest)
      const framePlan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
      assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan })).ok, true)
      for (const frame of framePlan) await repository.recordFrame(JOB_ID, frame.index, png(frame.index))
      await repository.recordAudio(JOB_ID, wav())
      await repository.recordWebm(JOB_ID, webmBytes)

      const settled = await repository.settle(JOB_ID, { executorError: null })
      assert.equal(settled.ok && settled.value.status, expectedStatus)
    })
  }
})

test('models FFmpeg Opus codec priming and signed boundary discard as presentation coverage', async (t) => {
  for (const [name, webmBytes] of [
    ['CodecDelay preroll plus final padding', validWorldRenderFfmpegPrimedOpusWebm500ms()],
    ['matching negative initial and positive final discard', validWorldRenderFfmpegPrimedOpusWebm500ms(-6_500_000)],
  ] as const) {
    await t.test(name, async (subtest) => {
      const { repository } = await fixture(subtest)
      const framePlan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
      assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan })).ok, true)
      for (const frame of framePlan) await repository.recordFrame(JOB_ID, frame.index, png(frame.index))
      await repository.recordAudio(JOB_ID, wav())
      await repository.recordWebm(JOB_ID, webmBytes)

      const settled = await repository.settle(JOB_ID, { executorError: null })
      assert.equal(settled.ok && settled.value.status, 'succeeded')
    })
  }
})

test('rejects missing, contradictory, duplicate, or unbounded Opus priming authorities', async (t) => {
  for (const mutation of [
    'missing-codec-delay',
    'wrong-codec-delay',
    'missing-final-discard',
    'wrong-final-discard',
    'wrong-initial-discard',
    'duplicate-codec-delay',
    'missing-seek-pre-roll',
    'duplicate-seek-pre-roll',
    'codec-delay-overflow',
    'seek-pre-roll-overflow',
    'seek-pre-roll-too-large',
  ] as const) {
    await t.test(mutation, async (subtest) => {
      const { repository } = await fixture(subtest)
      const framePlan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
      assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan })).ok, true)
      for (const frame of framePlan) await repository.recordFrame(JOB_ID, frame.index, png(frame.index))
      await repository.recordAudio(JOB_ID, wav())
      await repository.recordWebm(JOB_ID, invalidWorldRenderPrimedOpusWebm500ms(mutation))

      const settled = await repository.settle(JOB_ID, { executorError: null })
      assert.equal(settled.ok && settled.value.status, 'partial', mutation)
    })
  }
})

test('accepts sub-nanosecond DefaultDuration quantization at 24 and 60 fps only', async (t) => {
  for (const fps of [24, 60] as const) {
    for (const [label, webmBytes, expectedStatus] of [
      ['floor', validWorldRenderFloorDefaultDurationWebm500ms(fps), 'succeeded'],
      ['ceil', validWorldRenderCeilDefaultDurationWebm500ms(fps), 'succeeded'],
      ['materially wrong', invalidWorldRenderDefaultDurationQuantizationWebm500ms(fps), 'partial'],
    ] as const) {
      await t.test(`${fps} fps ${label}`, async (subtest) => {
        const { repository } = await fixture(subtest)
        const renderRequest = request()
        renderRequest.preset.fps = fps
        const framePlan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, fps, 864_000)
        assert.equal((await repository.createJob({ request: renderRequest, snapshot: snapshot(), framePlan })).ok, true)
        for (const frame of framePlan) await repository.recordFrame(JOB_ID, frame.index, png(frame.index))
        await repository.recordAudio(JOB_ID, wav())
        await repository.recordWebm(JOB_ID, webmBytes)

        const settled = await repository.settle(JOB_ID, { executorError: null })
        assert.equal(settled.ok && settled.value.status, expectedStatus)
      })
    }
  }
})

test('accepts RFC-legal zero-length Opus frames and enforces 1,275 bytes per frame', async (t) => {
  for (const [name, webmBytes, expectedStatus] of [
    ['TOC-only and zero-length multi-frame packets', validWorldRenderZeroLengthOpusFramesWebm500ms(), 'succeeded'],
    ['two maximum-size frames in one packet', worldRenderMaxOpusFrameWebm500ms(1_275), 'succeeded'],
    ['one byte over the per-frame maximum', worldRenderMaxOpusFrameWebm500ms(1_276), 'partial'],
  ] as const) {
    await t.test(name, async (subtest) => {
      const { repository } = await fixture(subtest)
      const framePlan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
      assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan })).ok, true)
      for (const frame of framePlan) await repository.recordFrame(JOB_ID, frame.index, png(frame.index))
      await repository.recordAudio(JOB_ID, wav())
      await repository.recordWebm(JOB_ID, webmBytes)

      const settled = await repository.settle(JOB_ID, { executorError: null })
      assert.equal(settled.ok && settled.value.status, expectedStatus)
    })
  }
})

test('validates all four RFC 6716 Opus packet framing codes', async (t) => {
  for (const code of [0, 1, 2, 3] as const) {
    await t.test(`code ${code}`, async (subtest) => {
      const { repository } = await fixture(subtest)
      const framePlan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
      assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan })).ok, true)
      for (const frame of framePlan) await repository.recordFrame(JOB_ID, frame.index, png(frame.index))
      await repository.recordAudio(JOB_ID, wav())
      await repository.recordWebm(JOB_ID, validWorldRenderOpusFramingWebm500ms(code))

      const settled = await repository.settle(JOB_ID, { executorError: null })
      assert.equal(settled.ok && settled.value.status, 'succeeded')
    })
  }
})

test('accepts a legitimate BlockDuration and rejects a contradictory 65,535-tick duration', async (t) => {
  for (const [label, blockDuration, expectedStatus] of [
    ['rounded frame duration', 33, 'succeeded'],
    ['contradictory duration', 65_535, 'partial'],
  ] as const) {
    await t.test(label, async (subtest) => {
      const { repository } = await fixture(subtest)
      const framePlan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
      assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan })).ok, true)
      for (const frame of framePlan) await repository.recordFrame(JOB_ID, frame.index, png(frame.index))
      await repository.recordAudio(JOB_ID, wav())
      await repository.recordWebm(JOB_ID, validWorldRenderBlockGroupWebm500ms(blockDuration))

      const settled = await repository.settle(JOB_ID, { executorError: null })
      assert.equal(settled.ok && settled.value.status, expectedStatus)
    })
  }
})

test('rejects duplicate, zero, and overflowing BlockDuration elements', async (t) => {
  for (const mutation of ['zero', 'duplicate', 'overflow'] as const) {
    await t.test(mutation, async (subtest) => {
      const { repository } = await fixture(subtest)
      const framePlan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
      assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan })).ok, true)
      for (const frame of framePlan) await repository.recordFrame(JOB_ID, frame.index, png(frame.index))
      await repository.recordAudio(JOB_ID, wav())
      await repository.recordWebm(JOB_ID, invalidWorldRenderBlockGroupDurationWebm500ms(mutation))
      const settled = await repository.settle(JOB_ID, { executorError: null })
      assert.equal(settled.ok && settled.value.status, 'partial')
    })
  }
})

test('rejects duplicate and overflowing track DefaultDuration elements', async (t) => {
  for (const mutation of ['duplicate', 'overflow'] as const) {
    await t.test(mutation, async (subtest) => {
      const { repository } = await fixture(subtest)
      const framePlan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
      assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan })).ok, true)
      for (const frame of framePlan) await repository.recordFrame(JOB_ID, frame.index, png(frame.index))
      await repository.recordAudio(JOB_ID, wav())
      await repository.recordWebm(JOB_ID, invalidWorldRenderDefaultDurationWebm500ms(mutation))
      const settled = await repository.settle(JOB_ID, { executorError: null })
      assert.equal(settled.ok && settled.value.status, 'partial')
    })
  }
})

test('decodable PNG and structured VP9/Opus WebM plus canonical PCM16 WAV are required for truthful terminal states', async (t) => {
  const { root, repository } = await fixture(t)
  const plan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
  assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan: plan })).ok, true)
  for (const frame of plan) await repository.recordFrame(JOB_ID, frame.index, png(frame.index))
  await repository.recordAudio(JOB_ID, wav())
  await repository.recordWebm(JOB_ID, magicOnlyWebm())
  const settled = await repository.settle(JOB_ID, { executorError: null })
  assert.equal(settled.ok, true)
  if (settled.ok) {
    assert.equal(settled.value.status, 'partial')
    assert.equal(settled.value.outputs.webm, null)
    assert.equal(settled.value.error?.code, 'output_invalid')
  }


  const invalidPngJobId = 'render-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const invalidPngRepository = new WorldRenderOutputRepository({
    getWorkspaceRoot: () => root,
    createJobId: () => invalidPngJobId,
  })
  assert.equal((await invalidPngRepository.createJob({ request: request(), snapshot: snapshot(), framePlan: plan })).ok, true)
  for (const frame of plan) await invalidPngRepository.recordFrame(invalidPngJobId, frame.index, headerOnlyPng())
  await invalidPngRepository.recordAudio(invalidPngJobId, wav())
  const invalidPng = await invalidPngRepository.settle(invalidPngJobId, { executorError: null })
  assert.equal(invalidPng.ok, true)
  if (invalidPng.ok) assert.equal(invalidPng.value.status, 'failed')

  const validIndexedJobId = 'render-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  const validIndexedRepository = new WorldRenderOutputRepository({
    getWorkspaceRoot: () => root,
    createJobId: () => validIndexedJobId,
  })
  assert.equal((await validIndexedRepository.createJob({ request: request(), snapshot: snapshot(), framePlan: plan })).ok, true)
  for (const frame of plan) await validIndexedRepository.recordFrame(validIndexedJobId, frame.index, indexedPng(true))
  await validIndexedRepository.recordAudio(validIndexedJobId, wav())
  await validIndexedRepository.recordWebm(validIndexedJobId, webm())
  const validIndexed = await validIndexedRepository.settle(validIndexedJobId, { executorError: null })
  assert.equal(validIndexed.ok && validIndexed.value.status, 'succeeded')

  const missingPaletteJobId = 'render-cccccccccccccccccccccccccccccccc'
  const missingPaletteRepository = new WorldRenderOutputRepository({
    getWorkspaceRoot: () => root,
    createJobId: () => missingPaletteJobId,
  })
  assert.equal((await missingPaletteRepository.createJob({ request: request(), snapshot: snapshot(), framePlan: plan })).ok, true)
  for (const frame of plan) await missingPaletteRepository.recordFrame(missingPaletteJobId, frame.index, indexedPng(false))
  await missingPaletteRepository.recordAudio(missingPaletteJobId, wav())
  await missingPaletteRepository.recordWebm(missingPaletteJobId, webm())
  const missingPalette = await missingPaletteRepository.settle(missingPaletteJobId, { executorError: null })
  assert.equal(missingPalette.ok && missingPalette.value.status, 'failed')
})

test('recovery rejects terminal status, output, and error combinations that settlement cannot publish', async (t) => {
  for (const variant of ['partial-with-webm', 'succeeded-with-error'] as const) {
    const { root, repository } = await fixture(t)
    const plan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
    assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan: plan })).ok, true)
    for (const frame of plan) await repository.recordFrame(JOB_ID, frame.index, png(frame.index))
    await repository.recordAudio(JOB_ID, wav())
    await repository.recordWebm(JOB_ID, webm())
    const settled = await repository.settle(JOB_ID, { executorError: null })
    assert.equal(settled.ok && settled.value.status, 'succeeded')

    const statePath = join(root, 'Exports', 'Worlds', 'Renders', JOB_ID, 'job.v1.json')
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    if (variant === 'partial-with-webm') state.status = 'partial'
    else state.error = { code: 'internal_error', message: 'World render operation failed.', retryable: true }
    await writeFile(statePath, `${JSON.stringify(state)}\n`)

    const recovered = await new WorldRenderOutputRepository({ getWorkspaceRoot: () => root }).recoverJobs()
    assert.equal(recovered[0].status, 'recovery_failed', variant)
    assert.deepEqual(recovered[0].outputs.frames, [], variant)
  }
})

test('crash checkpoints publish state last and restart marks active work interrupted', async (t) => {
  for (const failureStage of ['last-valid-published', 'journal-published', 'state-published'] as const) {
    let shouldFail = false
    let failed = false
    const { root, repository } = await fixture(t, {
      failureCheckpoint: (stage) => {
        if (shouldFail && !failed && stage === failureStage) {
          failed = true
          throw new Error('simulated crash')
        }
      },
    })
    const plan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
    assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan: plan })).ok, true)
    shouldFail = true
    const update = await repository.updateProgress(JOB_ID, { phase: 'preflighting', completedFrames: 0 })
    assert.equal(update.ok, false, failureStage)
    const restarted = new WorldRenderOutputRepository({ getWorkspaceRoot: () => root })
    const recovered = await restarted.recoverJobs()
    assert.equal(recovered.length, 1, failureStage)
    assert.equal(recovered[0].status, 'interrupted', failureStage)
    assert.equal(recovered[0].progress.completedUnits, 0, failureStage)
    assert.deepEqual((await readdir(join(root, 'Exports', 'Worlds', 'Renders', JOB_ID, '.modly')))
      .filter((name) => name.endsWith('.tmp')), [], failureStage)
  }
})

test('a crash after artifact rename cannot publish or expose an uncommitted frame', async (t) => {
  let shouldFail = false
  let failed = false
  const { root, repository } = await fixture(t, {
    failureCheckpoint: (stage) => {
      if (shouldFail && !failed && stage === 'artifact-written') {
        failed = true
        throw new Error('simulated artifact checkpoint crash')
      }
    },
  })
  const plan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
  assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan: plan })).ok, true)
  shouldFail = true
  const recorded = await repository.recordFrame(JOB_ID, 0, png(0))
  assert.equal(recorded.ok, false)

  const recovered = await new WorldRenderOutputRepository({ getWorkspaceRoot: () => root }).recoverJobs()
  assert.equal(recovered[0].status, 'interrupted')
  assert.deepEqual(recovered[0].outputs.frames, [])
  assert.deepEqual(await readdir(join(root, 'Exports', 'Worlds', 'Renders', JOB_ID, 'frames')), [])
})

test('manifest publication intent recovers every artifact, receipt, and state checkpoint coherently', async (t) => {
  const stages = [
    'manifest-publication-intent-published',
    'manifest-artifact-published',
    'artifact-receipt-published',
    'last-valid-published',
    'journal-published',
    'state-published',
    'journal-cleaned',
    'manifest-publication-intent-cleared',
  ] as const
  for (const failureStage of stages) {
    await t.test(failureStage, async (subtest) => {
      let armed = false
      let failed = false
      const { root, repository } = await fixture(subtest, {
        failureCheckpoint: (stage) => {
          if (armed && !failed && stage === failureStage) {
            failed = true
            throw new Error(`simulated ${failureStage} crash`)
          }
        },
      })
      const framePlan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
      assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan })).ok, true)
      for (const frame of framePlan) await repository.recordFrame(JOB_ID, frame.index, png(frame.index))
      await repository.recordAudio(JOB_ID, wav())
      armed = true

      const settled = await repository.settle(JOB_ID, { executorError: null })
      assert.equal(settled.ok, false, failureStage)
      assert.equal(failed, true, failureStage)

      const restarted = new WorldRenderOutputRepository({ getWorkspaceRoot: () => root })
      const [recovered] = await restarted.recoverJobs()
      assert.notEqual(recovered.status, 'recovery_failed', failureStage)
      const jobRoot = join(root, 'Exports', 'Worlds', 'Renders', JOB_ID)
      const hasManifest = await lstat(join(jobRoot, WORLD_RENDER_MANIFEST_FILENAME)).then(() => true, () => false)
      const hasReceipt = await lstat(join(jobRoot, '.modly', 'artifacts', 'render-manifest.v1.json')).then(() => true, () => false)
      assert.equal(hasManifest, Boolean(recovered.outputs.renderManifest), failureStage)
      assert.equal(hasReceipt, Boolean(recovered.outputs.renderManifest), failureStage)

      const requested = await restarted.requestCancel(JOB_ID)
      assert.equal(requested.ok && requested.value.status, 'cancel_requested', failureStage)
      const cancelled = await restarted.finishCancelled(JOB_ID)
      assert.equal(cancelled.ok && cancelled.value.status, 'cancelled', failureStage)
      await assert.rejects(readFile(join(jobRoot, WORLD_RENDER_MANIFEST_FILENAME)), /ENOENT/)
      await assert.rejects(readFile(join(jobRoot, '.modly', 'manifest-publication-intent.v1.json')), /ENOENT/)
    })
  }
})

test('manifest publication never overwrites a pre-existing canonical file', async (t) => {
  const { root, repository } = await fixture(t)
  const framePlan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
  assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan })).ok, true)
  for (const frame of framePlan) await repository.recordFrame(JOB_ID, frame.index, png(frame.index))
  await repository.recordAudio(JOB_ID, wav())
  const manifestPath = join(root, 'Exports', 'Worlds', 'Renders', JOB_ID, WORLD_RENDER_MANIFEST_FILENAME)
  const preExisting = Buffer.from('{"preExisting":true}\n')
  await writeFile(manifestPath, preExisting)

  const settled = await repository.settle(JOB_ID, { executorError: null })
  assert.equal(settled.ok, false)
  assert.deepEqual(await readFile(manifestPath), preExisting)
  await assert.rejects(
    readFile(join(root, 'Exports', 'Worlds', 'Renders', JOB_ID, '.modly', 'manifest-publication-intent.v1.json')),
    /ENOENT/,
  )
})

test('manifest publication rollback remains recoverable when cleanup itself is interrupted', async (t) => {
  for (const rollbackStage of [
    'manifest-publication-rollback-receipt-removed',
    'manifest-publication-rollback-artifact-removed',
  ] as const) {
    await t.test(rollbackStage, async (subtest) => {
      let armed = false
      const failedStages = new Set<string>()
      const { root, repository } = await fixture(subtest, {
        failureCheckpoint: (stage) => {
          if (!armed || failedStages.has(stage)) return
          if (stage === 'manifest-artifact-published' || stage === rollbackStage) {
            failedStages.add(stage)
            throw new Error(`simulated ${stage} crash`)
          }
        },
      })
      const framePlan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
      assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan })).ok, true)
      for (const frame of framePlan) await repository.recordFrame(JOB_ID, frame.index, png(frame.index))
      await repository.recordAudio(JOB_ID, wav())
      armed = true

      assert.equal((await repository.settle(JOB_ID, { executorError: null })).ok, false)
      assert.deepEqual([...failedStages].sort(), ['manifest-artifact-published', rollbackStage].sort())

      const restarted = new WorldRenderOutputRepository({ getWorkspaceRoot: () => root })
      const [recovered] = await restarted.recoverJobs()
      assert.notEqual(recovered.status, 'recovery_failed')
      const jobRoot = join(root, 'Exports', 'Worlds', 'Renders', JOB_ID)
      await assert.rejects(readFile(join(jobRoot, WORLD_RENDER_MANIFEST_FILENAME)), /ENOENT/)
      await assert.rejects(readFile(join(jobRoot, '.modly', 'artifacts', 'render-manifest.v1.json')), /ENOENT/)
      await assert.rejects(readFile(join(jobRoot, '.modly', 'manifest-publication-intent.v1.json')), /ENOENT/)
    })
  }
})

test('a manifest intent fsync fault is rolled back without poisoning restart recovery', async (t) => {
  let armed = false
  let failed = false
  const { root, repository } = await fixture(t, {
    syncDirectory: (directory) => {
      if (armed && !failed && directory.endsWith(`${join('.modly')}`)) {
        failed = true
        return false
      }
      return true
    },
  })
  const framePlan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
  assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan })).ok, true)
  for (const frame of framePlan) await repository.recordFrame(JOB_ID, frame.index, png(frame.index))
  await repository.recordAudio(JOB_ID, wav())
  armed = true

  assert.equal((await repository.settle(JOB_ID, { executorError: null })).ok, false)
  assert.equal(failed, true)
  const [recovered] = await new WorldRenderOutputRepository({ getWorkspaceRoot: () => root }).recoverJobs()
  assert.notEqual(recovered.status, 'recovery_failed')
})

test('recovery rejects frame receipts whose rational timestamp diverges from the pinned plan', async (t) => {
  const { root, repository } = await fixture(t)
  const plan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
  assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan: plan })).ok, true)
  assert.equal((await repository.recordFrame(JOB_ID, 0, png(0))).ok, true)
  const receiptPath = join(
    root,
    'Exports',
    'Worlds',
    'Renders',
    JOB_ID,
    '.modly',
    'artifacts',
    'frame-000000.v1.json',
  )
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  receipt.artifact.time = { numerator: 1, denominator: 3 }
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`)
  const recovered = await new WorldRenderOutputRepository({ getWorkspaceRoot: () => root }).recoverJobs()
  assert.equal(recovered[0].status, 'recovery_failed')
  assert.deepEqual(recovered[0].outputs.frames, [])
})

test('rejects unsafe roots, symlinked output internals, hardlink aliases, and noncanonical job IDs', async (t) => {
  const { root, repository } = await fixture(t)
  const plan = enumerateWorldFrames({ numerator: 1, denominator: 2 }, 30, 864_000)
  assert.equal((await repository.createJob({ request: request(), snapshot: snapshot(), framePlan: plan })).ok, true)
  const jobRoot = join(root, 'Exports', 'Worlds', 'Renders', JOB_ID)
  const external = join(root, 'external')
  await mkdir(external)
  await rm(join(jobRoot, 'frames'), { recursive: true })
  await symlink(external, join(jobRoot, 'frames'), 'dir')
  const linked = await repository.recordFrame(JOB_ID, 0, Buffer.from('png'))
  assert.equal(linked.ok, false)
  if (!linked.ok) assert.equal(linked.error.code, 'unsafe_workspace')

  const hardlinkRoot = await mkdtemp(join(tmpdir(), 'modly-world-render-hardlink-'))
  t.after(() => rm(hardlinkRoot, { recursive: true, force: true }))
  await mkdir(join(hardlinkRoot, 'Assets'), { recursive: true })
  await writeFile(join(hardlinkRoot, 'Assets', 'model.glb'), 'model')
  await link(join(hardlinkRoot, 'Assets', 'model.glb'), join(hardlinkRoot, 'Assets', 'alias.glb'))
  const hardlinkRepository = new WorldRenderOutputRepository({ getWorkspaceRoot: () => hardlinkRoot, createJobId: () => JOB_ID })
  const hardlinked = await hardlinkRepository.createJob({ request: request(), snapshot: snapshot(), framePlan: plan })
  assert.equal(hardlinked.ok, false)
  if (!hardlinked.ok) assert.equal(hardlinked.error.code, 'unsafe_workspace')

  const alternateStreamSnapshot = snapshot()
  alternateStreamSnapshot.project.resources[0].workspacePath = 'Assets/model.glb:stream'
  const alternateStream = await new WorldRenderOutputRepository({
    getWorkspaceRoot: () => hardlinkRoot,
    createJobId: () => JOB_ID,
  }).createJob({ request: request(), snapshot: alternateStreamSnapshot, framePlan: plan })
  assert.equal(alternateStream.ok, false)
  if (!alternateStream.ok) assert.equal(alternateStream.error.code, 'invalid_request')

  const invalid = await repository.get({ jobId: 'C:\\device' } as never)
  assert.equal(invalid.ok, false)
  if (!invalid.ok) assert.equal(invalid.error.code, 'invalid_request')

  for (const configured of ['\\\\?\\C:\\workspace', `${root}/../${root.split('/').at(-1)}`]) {
    const unsafe = await new WorldRenderOutputRepository({ getWorkspaceRoot: () => configured }).createJob({
      request: request(), snapshot: snapshot(), framePlan: plan,
    })
    assert.equal(unsafe.ok, false, configured)
    if (!unsafe.ok) assert.equal(unsafe.error.code, 'unsafe_workspace', configured)
  }

  const aliasBase = await mkdtemp(join(tmpdir(), 'modly-world-render-root-alias-'))
  const aliasTarget = await mkdtemp(join(tmpdir(), 'modly-world-render-root-target-'))
  t.after(() => Promise.all([
    rm(aliasBase, { recursive: true, force: true }),
    rm(aliasTarget, { recursive: true, force: true }),
  ]))
  await symlink(aliasTarget, join(aliasBase, 'alias'), 'dir')
  const aliasedRoot = join(aliasBase, 'alias', 'new-workspace')
  const aliased = await new WorldRenderOutputRepository({ getWorkspaceRoot: () => aliasedRoot }).createJob({
    request: request(), snapshot: snapshot(), framePlan: plan,
  })
  assert.equal(aliased.ok, false)
  if (!aliased.ok) assert.equal(aliased.error.code, 'unsafe_workspace')
  assert.equal(await lstat(join(aliasTarget, 'new-workspace')).then(() => true, () => false), false)
})

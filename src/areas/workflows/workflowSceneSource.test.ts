import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveSceneSourceManifest } from './workflowSceneSource.ts'

function manifestBase64(manifest: unknown): string {
  return Buffer.from(JSON.stringify(manifest), 'utf8').toString('base64')
}

test('resolveSceneSourceManifest accepts workspace-relative scene directories and resolves scene manifests', async () => {
  const result = await resolveSceneSourceManifest({
    scenePath: 'Scenes/castle',
    workspaceDir: '/workspace',
    readFileBase64: async (filePath) => {
      assert.equal(filePath, '/workspace/Scenes/castle/scene-manifest.json')
      return manifestBase64({
        schema: 'modly.scene-manifest.v1',
        sceneRoot: '.',
        assets: [],
      })
    },
  })

  assert.deepEqual(result, {
    ok: true,
    sourceKind: 'directory',
    inputWorkspacePath: 'Scenes/castle',
    manifestWorkspacePath: 'Scenes/castle/scene-manifest.json',
    manifestAbsolutePath: '/workspace/Scenes/castle/scene-manifest.json',
    sceneRoot: '.',
    manifest: {
      schema: 'modly.scene-manifest.v1',
      sceneRoot: '.',
      assets: [],
    },
  })
})

const minimalManifest = { schema: 'modly.scene-manifest.v1', sceneRoot: '.', assets: [] }
const validView = { position: [1, 2, 3], target: [0, 0, 0] }
const previewObjectError = 'Scene manifest preview must be a JSON object.'
const previewReferenceError = 'Scene manifest preview image/video must be safe relative file references.'
const viewObjectError = 'Scene manifest initialView must be a JSON object.'
const viewVectorError = 'Scene manifest initialView requires distinct finite numeric position/target triples and optional non-zero finite up.'

async function resolveFileFixture(manifest: unknown, options: { request?: string; rawJson?: string; unsafe?: boolean } = {}) {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'modly-scene-manifest-boundary-'))
  const relativeManifest = 'Scenes/castle/scene-manifest.json'
  const manifestPath = join(workspaceDir, relativeManifest)
  const readPaths: string[] = []
  try {
    await mkdir(join(workspaceDir, 'Scenes/castle'), { recursive: true })
    await writeFile(manifestPath, options.rawJson ?? JSON.stringify(manifest), 'utf8')
    const scenePath = options.request === 'absolute' ? join(workspaceDir, 'Scenes/castle')
      : options.request === 'alias' ? '/workspace/Scenes/castle'
        : options.request === 'manifest' ? relativeManifest : options.request ?? 'Scenes/castle'
    const result = await resolveSceneSourceManifest({ scenePath, workspaceDir, readFileBase64: async (filePath) => {
      readPaths.push(filePath)
      assert.equal(filePath, manifestPath)
      return (await readFile(filePath)).toString('base64')
    } })
    assert.deepEqual(readPaths, options.unsafe ? [] : [manifestPath])
    if (result.ok) {
      assert.equal(result.manifestWorkspacePath, relativeManifest)
      assert.equal(result.manifestAbsolutePath, manifestPath)
      assert.equal(result.inputWorkspacePath, options.request === 'manifest' ? relativeManifest : 'Scenes/castle')
      assert.equal(result.sourceKind, options.request === 'manifest' ? 'manifest' : 'directory')
    }
    return result
  } finally {
    await rm(workspaceDir, { recursive: true, force: true })
  }
}

for (const [name, preview] of Object.entries({ null: null, array: [], number: 7, string: 'image.png' })) {
  test(`resolveSceneSourceManifest rejects supplied preview ${name} through real file ingress`, async () => {
    assert.deepEqual(await resolveFileFixture({ ...minimalManifest, preview }), { ok: false, error: previewObjectError })
  })
}

const unsafePreviewRefs: unknown[] = [17, false, null, [], {}, '', '   ', '.', '..', '/tmp/outside.png',
  '\\\\server\\share\\image.png', 'C:\\outside.png', 'C:/outside.png', 'C:outside.png', 'https://example.invalid/x',
  'file:///tmp/x', 'data:image/png;base64,AA', '../outside.png', 'a/../b.png', 'a/./b.png', 'a//b.png',
  'a\\..\\b.png', 'a/', 'a\u0000b.png', '%2e%2e/x.png', 'a%2Fb.png', 'a%5cb.png', 'a%00b.png', 'a%2Eb.png', '%252e%252e/x.png',
  'previews/name%25.png', 'a%', 'a%2', 'a%GG.png', 'a%2%66b.png']
for (const member of ['image', 'video']) {
  for (const [index, reference] of unsafePreviewRefs.entries()) {
    test(`resolveSceneSourceManifest rejects preview ${member} reference ${index}: ${JSON.stringify(reference)}`, async () => {
      assert.deepEqual(await resolveFileFixture({ ...minimalManifest, preview: { [member]: reference } }),
        { ok: false, error: previewReferenceError })
    })
  }
}

const splitPercentPreviewWitnesses = [
  ['image', '%25%32%65%25%32%65/escape.png'],
  ['video', '%25%32e%25%32e/escape.mp4'],
  ['image', 'a%25%32%66b.png'],
  ['video', 'a%25%35%63b.mp4'],
  ['image', 'a%25%30%30b.png'],
] as const
for (const [member, reference] of splitPercentPreviewWitnesses) {
  test(`resolveSceneSourceManifest rejects reviewed split percent ${member} witness ${reference}`, async () => {
    assert.deepEqual(await resolveFileFixture({ ...minimalManifest, preview: { [member]: reference } }),
      { ok: false, error: previewReferenceError })
  })
}

for (const [name, initialView] of Object.entries({ null: null, array: [], number: 7, string: 'camera' })) {
  test(`resolveSceneSourceManifest rejects supplied initialView ${name} through real file ingress`, async () => {
    assert.deepEqual(await resolveFileFixture({ ...minimalManifest, initialView }), { ok: false, error: viewObjectError })
  })
}

const malformedViews = { empty: {}, missingPosition: { target: [0, 0, 0] }, missingTarget: { position: [1, 2, 3] },
  positionNull: { ...validView, position: null }, positionObject: { ...validView, position: { x: 1, y: 2, z: 3 } },
  positionShort: { ...validView, position: [1, 2] }, positionLong: { ...validView, position: [1, 2, 3, 4] },
  positionString: { ...validView, position: ['1', 2, 3] }, targetNull: { ...validView, target: null },
  targetShort: { ...validView, target: [0, 0] }, targetLong: { ...validView, target: [0, 0, 0, 0] },
  targetString: { ...validView, target: [0, '0', 0] }, samePositionTarget: { position: [1, 2, 3], target: [1, 2, 3] },
  upNull: { ...validView, up: null }, upObject: { ...validView, up: {} }, upShort: { ...validView, up: [0, 1] },
  upLong: { ...validView, up: [0, 1, 0, 0] }, upString: { ...validView, up: [0, '1', 0] }, upZero: { ...validView, up: [0, 0, 0] } }
for (const [name, initialView] of Object.entries(malformedViews)) {
  test(`resolveSceneSourceManifest rejects initialView ${name} through real file ingress`, async () => {
    assert.deepEqual(await resolveFileFixture({ ...minimalManifest, initialView }), { ok: false, error: viewVectorError })
  })
}
for (const member of ['position', 'target', 'up']) {
  test(`resolveSceneSourceManifest rejects raw JSON 1e400 in initialView ${member}`, async () => {
    const rawJson = `{"schema":"modly.scene-manifest.v1","sceneRoot":".","assets":[],"initialView":{"position":[1,2,3],"target":[0,0,0],"up":[0,1,0],"${member}":[1e400,0,1]}}`
    assert.equal(JSON.parse(rawJson).initialView[member][0], Infinity)
    assert.deepEqual(await resolveFileFixture({}, { rawJson }), { ok: false, error: viewVectorError })
  })
}

const hyWorldManifest = { ...minimalManifest, sceneRoot: 'artifacts/scene', extension_id: 'hy-world-2', stage_id: 'scene',
  preview: { image: 'artifacts/scene/panorama.png', video: 'artifacts/scene/keyframes.mp4' },
  assets: [{ category: 'panorama', id: 'panorama', path: 'artifacts/scene/panorama.png', media_type: 'image/png', status: 'ready' }] }
const dreamCubeManifest = { ...minimalManifest, generator: 'dreamcube', version: '1', timestamp: '2026-09-13T00:00:00Z',
  initialView: { position: [0, 0, 0], target: [0, 0, 1], up: [0, 1, 0] },
  assets: [{ id: 'base-scene', workspacePath: 'Scenes/castle/scene.glb', kind: 'glb', visible: true,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }] }
const opaqueManifest = { ...minimalManifest, sceneRoot: ' artifacts\\scene ',
  source: { path: '/tmp/not-read', uri: 'https://example.invalid/not-fetched', nested: [{ version: 2 }] },
  preview: { image: 'previews\\panorama.png', video: 'previews/video.mp4', extra: { dimensions: [20, 10], source: '/tmp/opaque' } },
  initialView: { ...validView, up: [2, 4, 6], extra: { quaternion: [0, 0, 0, 1], fov: 'opaque', nested: [null, { x: 2 }] } },
  assets: [null, 42, 'opaque', { arbitrary: { path: '/tmp/not-imported' } }] }
const preservedManifests = { minimal: minimalManifest, hyWorld: hyWorldManifest, dreamCube: dreamCubeManifest, opaque: opaqueManifest,
  viewWithoutUp: { ...minimalManifest, initialView: validView },
  collinearNonUnitUp: { ...minimalManifest, initialView: { ...validView, up: [-2, -4, -6] } },
  emptyPreview: { ...minimalManifest, preview: {} }, imageOnly: { ...minimalManifest, preview: { image: 'previews/image.png' } },
  videoOnly: { ...minimalManifest, preview: { video: 'previews/video.mp4' } },
  safeDotFilename: { ...minimalManifest, preview: { image: '.preview.png', video: 'previews/space name.mp4' } },
  harmlessPercent41: { ...minimalManifest, preview: { image: 'previews/%41-image.png', video: 'previews/%41-video.mp4' } },
  harmlessPercent20: { ...minimalManifest, preview: { image: 'previews/space%20name.png', video: 'previews/space%20name.mp4' } },
  originalWhitespaceBackslashPercent: { ...minimalManifest, preview: { image: ' previews\\image.png ', video: 'previews/%41-video.mp4' } } }
for (const [name, manifest] of Object.entries(preservedManifests)) {
  test(`resolveSceneSourceManifest preserves whole valid ${name} manifest and sole selected read authority`, async () => {
    const result = await resolveFileFixture(manifest)
    assert.equal(result.ok, true)
    assert.deepEqual(result.manifest, manifest)
    assert.equal(result.sceneRoot, name === 'opaque' ? 'artifacts/scene' : manifest.sceneRoot)
  })
}
for (const request of ['manifest', 'absolute', 'alias']) {
  test(`resolveSceneSourceManifest preserves valid ${request} selection with actual workspace files`, async () => {
    const result = await resolveFileFixture(hyWorldManifest, { request })
    assert.equal(result.ok, true)
    assert.deepEqual(result.manifest, hyWorldManifest)
  })
}
for (const request of ['../outside', '/tmp/outside', 'Scenes/../outside', 'Scenes//castle', 'Scenes/./castle']) {
  test(`resolveSceneSourceManifest refuses unsafe selected request ${request} before any reader call`, async () => {
    assert.deepEqual(await resolveFileFixture(minimalManifest, { request, unsafe: true }),
      { ok: false, error: 'Load Scene requires a safe workspace-relative scene path.' })
  })
}

test('resolveSceneSourceManifest rejects unsafe or invalid scene manifests', async () => {
  const invalidPath = await resolveSceneSourceManifest({
    scenePath: '../outside',
    workspaceDir: '/workspace',
    readFileBase64: async () => manifestBase64({}),
  })
  const invalidSchema = await resolveSceneSourceManifest({
    scenePath: 'Scenes/castle/scene-manifest.json',
    workspaceDir: '/workspace',
    readFileBase64: async () => manifestBase64({ schema: 'wrong', sceneRoot: '.', assets: [] }),
  })
  const invalidSceneRoot = await resolveSceneSourceManifest({
    scenePath: 'Scenes/castle/scene-manifest.json',
    workspaceDir: '/workspace',
    readFileBase64: async () => manifestBase64({ schema: 'modly.scene-manifest.v1', sceneRoot: '../escape', assets: [] }),
  })

  assert.deepEqual(invalidPath, {
    ok: false,
    error: 'Load Scene requires a safe workspace-relative scene path.',
  })
  assert.deepEqual(invalidSchema, {
    ok: false,
    error: 'Scene manifest schema must be modly.scene-manifest.v1.',
  })
  assert.deepEqual(invalidSceneRoot, {
    ok: false,
    error: 'Scene manifest sceneRoot must be a safe relative path.',
  })
})

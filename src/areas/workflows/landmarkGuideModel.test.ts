import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const projectRoot = path.resolve(import.meta.dirname, '../../..')
const guideModelEntry = path.join(projectRoot, 'src/areas/workflows/landmarkGuideModel.ts')

async function loadGuideModel() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-landmark-guide-model-'))
  const outfile = path.join(tempDir, 'landmarkGuideModel.bundle.mjs')

  await build({
    entryPoints: [guideModelEntry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
  })

  const module = await import(pathToFileURL(outfile).href)

  return {
    module,
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

function point(id: string) {
  return { id, name: id, world: { x: 0, y: 0, z: 0 }, confidence: 1, source: 'manual' }
}

test('landmark guide metadata exposes stable tokens, labels, colors, and visual positions', async () => {
  const { module, cleanup } = await loadGuideModel()

  try {
    assert.deepEqual(
      module.LANDMARK_GUIDE_ITEMS.map((item: { token: string; label: string }) => [item.token, item.label]),
      [
        ['RS', 'Right shoulder'],
        ['LS', 'Left shoulder'],
        ['H', 'Hip'],
        ['LK', 'Left knee'],
        ['RK', 'Right knee'],
      ],
    )
    assert.deepEqual(
      module.LANDMARK_GUIDE_ITEMS.map((item: { visual: { anchor: { x: number; y: number }; badge: { x: number; y: number } } }) => ({
        anchorLocal: item.visual.anchor,
        badgeLocal: item.visual.badge,
      })),
      [
        { anchorLocal: { x: 34, y: 21 }, badgeLocal: { x: 19, y: 19 } },
        { anchorLocal: { x: 59, y: 21 }, badgeLocal: { x: 74, y: 19 } },
        { anchorLocal: { x: 46, y: 41 }, badgeLocal: { x: 68, y: 41 } },
        { anchorLocal: { x: 55, y: 64 }, badgeLocal: { x: 73, y: 66 } },
        { anchorLocal: { x: 38, y: 64 }, badgeLocal: { x: 20, y: 66 } },
      ],
    )
    for (const item of module.LANDMARK_GUIDE_ITEMS) {
      assert.match(item.color, /^#[0-9a-f]{6}$/i)
    }
  } finally {
    await cleanup()
  }
})

test('maps character-local anatomy points into the rendered guide frame', async () => {
  const { module, cleanup } = await loadGuideModel()

  try {
    assert.deepEqual(module.LANDMARK_GUIDE_CHARACTER_VIEWPORT, {
      frame: { width: 156, height: 144 },
      image: { naturalWidth: 210, naturalHeight: 339, renderedWidth: 89.2, renderedHeight: 144, offsetX: 33.4, offsetY: 0 },
    })
    assert.deepEqual(module.mapCharacterLocalPointToGuideFrame({ x: 50, y: 50 }), { x: 50, y: 50 })
    assert.deepEqual(module.mapCharacterLocalPointToGuideFrame({ x: 34, y: 21 }), { x: 40.9, y: 21 })
    assert.deepEqual(module.mapCharacterLocalPointToGuideFrame({ x: 59, y: 21 }), { x: 55.1, y: 21 })
  } finally {
    await cleanup()
  }
})

test('landmark guide positions map to rendered character anatomy and keep badges readable', async () => {
  const { module, cleanup } = await loadGuideModel()

  try {
    const byToken = Object.fromEntries(
      module.LANDMARK_GUIDE_ITEMS.map((item: { token: string }) => [item.token, module.resolveLandmarkGuideRenderPoints(item)]),
    )

    assert.ok(byToken.RS.anchor.x < 50, 'RS must resolve on viewer-left for a front-facing character')
    assert.ok(byToken.LS.anchor.x > 50, 'LS must resolve on viewer-right for a front-facing character')
    assert.ok(byToken.RK.anchor.x < 50, 'RK must resolve on viewer-left, consistent with RS')
    assert.ok(byToken.LK.anchor.x > 50, 'LK must resolve on viewer-right, consistent with LS')
    assert.ok(byToken.RS.anchor.x >= 40.8 && byToken.RS.anchor.x <= 41, 'RS anchor should receive the differential final viewer-left correction')
    assert.ok(byToken.LS.anchor.x >= 55 && byToken.LS.anchor.x <= 55.2, 'LS anchor must remain unchanged during the differential final correction')
    assert.ok(byToken.RS.anchor.y >= 20 && byToken.RS.anchor.y <= 22, 'shoulder anchors should be fine-tuned further upward')
    assert.ok(byToken.LS.anchor.y >= 20 && byToken.LS.anchor.y <= 22, 'shoulder anchors should be fine-tuned further upward')
    assert.ok(byToken.H.anchor.x >= 47.6 && byToken.H.anchor.x <= 47.8, 'hip anchor should receive the smaller differential final correction without changing y')
    assert.ok(byToken.H.anchor.y >= 40 && byToken.H.anchor.y <= 42, 'hip anchor should be fine-tuned further upward at pelvis')
    assert.ok(byToken.LK.anchor.y >= 63 && byToken.LK.anchor.y <= 65, 'left knee anchor should be fine-tuned further upward')
    assert.ok(byToken.RK.anchor.y >= 63 && byToken.RK.anchor.y <= 65, 'right knee anchor should be fine-tuned further upward')
    assert.ok(byToken.LK.anchor.x >= 52.8 && byToken.LK.anchor.x <= 53, 'LK anchor must remain unchanged during the differential final correction')
    assert.ok(byToken.RK.anchor.x >= 43 && byToken.RK.anchor.x <= 43.2, 'RK anchor should receive the differential final viewer-left correction')
    assert.ok(byToken.RK.anchor.x < byToken.LK.anchor.x, 'knee handedness should match shoulders: RK viewer-left, LK viewer-right')
    assert.ok(byToken.LK.anchor.x - byToken.RK.anchor.x >= 7, 'knee anchors should be visibly separated')
    assert.ok(byToken.H.anchor.y > byToken.RS.anchor.y + 16, 'hip should be clearly below shoulders')
    assert.ok(byToken.LK.anchor.y > byToken.H.anchor.y + 14, 'knees should be clearly below hip')
    assert.ok(byToken.RS.badge.x < byToken.RS.anchor.x, 'RS badge should be offset outward from the shoulder anchor')
    assert.ok(byToken.LS.badge.x > byToken.LS.anchor.x, 'LS badge should be offset outward from the shoulder anchor')
    assert.ok(byToken.RK.badge.x < byToken.RK.anchor.x, 'RK badge should be offset outward to viewer-left')
    assert.ok(byToken.LK.badge.x > byToken.LK.anchor.x, 'LK badge should be offset outward to viewer-right')
    assert.ok(byToken.LK.badge.x - byToken.RK.badge.x >= 25, 'knee badges should be clearly separated')
    for (const token of ['RS', 'LS', 'H', 'LK', 'RK']) {
      assert.ok(byToken[token].anchor.x >= 21.4 && byToken[token].anchor.x <= 78.6, `${token} anchor must resolve inside the rendered character image bounds`)
      assert.ok(!(byToken[token].badge.x >= 43 && byToken[token].badge.x <= 57 && byToken[token].badge.y >= 28 && byToken[token].badge.y <= 67), `${token} badge should not sit over the central torso stack`)
    }
  } finally {
    await cleanup()
  }
})

test('packaged guide character asset is a bounded repo asset suitable for a node card', async () => {
  const assetPath = path.join(projectRoot, 'src/assets/landmarks/guide-character.webp')
  const assetStats = await stat(assetPath)

  assert.ok(assetStats.size > 8_000, 'character asset should not be an empty placeholder')
  assert.ok(assetStats.size < 80_000, 'character asset should stay small enough for node-card usage')
})

test('resolveLandmarksGuideModel reports empty, partial, and complete progress from real completed points', async () => {
  const { module, cleanup } = await loadGuideModel()

  try {
    const empty = module.resolveLandmarksGuideModel({ nodeId: 'landmarks-node' })
    assert.equal(empty.status, 'empty')
    assert.equal(empty.progressLabel, '0 of 5')
    assert.equal(empty.instruction, 'Start by marking points in the 3D viewer.')
    assert.deepEqual(empty.items.map((item: { completed: boolean }) => item.completed), [false, false, false, false, false])

    const partial = module.resolveLandmarksGuideModel({
      nodeId: 'landmarks-node',
      session: {
        nodeId: 'landmarks-node',
        completed: {
          right_shoulder: point('right_shoulder'),
          hip: point('hip'),
        },
        canContinue: false,
      },
    })
    assert.equal(partial.status, 'partial')
    assert.equal(partial.progressLabel, '2 of 5')
    assert.equal(partial.instruction, 'Keep placing the remaining landmarks in the 3D viewer.')
    assert.deepEqual(partial.items.map((item: { token: string; completed: boolean }) => [item.token, item.completed]), [
      ['RS', true],
      ['LS', false],
      ['H', true],
      ['LK', false],
      ['RK', false],
    ])

    const complete = module.resolveLandmarksGuideModel({
      nodeId: 'landmarks-node',
      session: {
        nodeId: 'landmarks-node',
        completed: {
          right_shoulder: point('right_shoulder'),
          left_shoulder: point('left_shoulder'),
          hip: point('hip'),
          left_knee: point('left_knee'),
          right_knee: point('right_knee'),
        },
        canContinue: true,
      },
    })
    assert.equal(complete.status, 'complete')
    assert.equal(complete.progressLabel, '5 of 5')
    assert.equal(complete.instruction, 'All points marked; continue when workflow is ready.')
  } finally {
    await cleanup()
  }
})

test('resolveLandmarksNodePrimaryAction gates Continue to the active paused landmarks checkpoint for this node', async () => {
  const { module, cleanup } = await loadGuideModel()

  try {
    const enabled = module.resolveLandmarksNodePrimaryAction({
      nodeId: 'landmarks-node',
      activeNodeId: 'landmarks-node',
      runState: { status: 'paused', blockStep: 'Paused — mark required landmarks', substitutionPoint: { nodeId: 'landmarks-node' } },
      session: { nodeId: 'landmarks-node', completed: {}, canContinue: true },
    })
    assert.deepEqual(enabled, { kind: 'continue-landmarks', label: 'Continue workflow', disabled: false })

    const disabled = module.resolveLandmarksNodePrimaryAction({
      nodeId: 'landmarks-node',
      activeNodeId: 'landmarks-node',
      runState: { status: 'paused', blockStep: 'Paused — mark required landmarks', substitutionPoint: { nodeId: 'landmarks-node' } },
      session: { nodeId: 'landmarks-node', completed: {}, canContinue: false },
    })
    assert.deepEqual(disabled, { kind: 'continue-landmarks', label: 'Finish all landmarks to continue', disabled: true })

    assert.equal(module.resolveLandmarksNodePrimaryAction({
      nodeId: 'landmarks-node',
      activeNodeId: 'other-node',
      runState: { status: 'paused', blockStep: 'Paused — mark required landmarks', substitutionPoint: { nodeId: 'landmarks-node' } },
      session: { nodeId: 'landmarks-node', completed: {}, canContinue: true },
    }), undefined)
  } finally {
    await cleanup()
  }
})

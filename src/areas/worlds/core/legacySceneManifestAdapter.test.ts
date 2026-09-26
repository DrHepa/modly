import assert from 'node:assert/strict'
import test from 'node:test'

import {
  analyzeLegacyWorldsSceneExport,
  exportLegacyWorldsSceneManifest,
  importLegacyWorldsSceneManifest,
} from './legacySceneManifestAdapter.ts'
import { createValidWorldSnapshot } from './_testFixtures.ts'
import { parseWorldsSceneManifest } from '../worldsSceneManifest.ts'

function legacyManifest() {
  return {
    schema: 'modly.scene-manifest.v1' as const,
    sceneRoot: '.', generator: 'foreign-generator', version: 7, createdAt: '2025-01-01T00:00:00.000Z',
    initialView: { position: [8, 5, 12] as [number, number, number], target: [0, 1, 0] as [number, number, number] },
    assets: [
      { id: 'asset:duplicate', name: 'Stage', role: 'base-scene', workspacePath: 'Scenes/stage.glb', kind: 'glb', visible: true, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      { id: 'asset:duplicate', name: 'Hero', workspacePath: 'Characters/hero.glb', kind: 'glb', visible: true, animation: { kind: 'pose-clip', sidecarWorkspacePath: 'Animations/hero.pose.json', sourceWorkspacePath: 'Characters/hero.glb', clipId: 'walk', durationSeconds: 2 }, transform: { position: [1, 0, 2], rotation: [0, 0.5, 0], scale: [1, 1, 1] } },
    ],
    collisionSurfaces: {
      schema: 'modly.collision-surfaces.v1',
      surfaces: [{ id: 'surface:floor', shape: 'rect', preset: 'floor', sidedness: 'double', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, geometry: { halfWidth: 5, halfHeight: 5 } }],
    },
  }
}

test('imports base role, duplicate ids, pose clip, initial view, and navigation-only collisions', () => {
  const imported = importLegacyWorldsSceneManifest(legacyManifest(), { projectId: 'project:legacy', projectName: 'Legacy', sceneId: 'scene:legacy', sceneName: 'Imported' })
  assert.equal(imported.success, true, JSON.stringify(imported))
  if (imported.success !== true) return
  assert.ok(imported.warnings.some((warning) => warning.code === 'duplicate-id-normalized'))
  const scene = imported.snapshot.scenes[0]
  assert.deepEqual(scene.editor?.initialView, legacyManifest().initialView)
  assert.ok(scene.entities[0].tags.includes('modly:base-scene'))
  assert.notEqual(scene.entities[0].id, scene.entities[1].id)
  assert.ok(imported.snapshot.project.resources.some((resource) => resource.type === 'animation'))
  assert.ok(scene.entities[1].components.some((component) => component.type === 'animation-player'))
  const surface = scene.entities.find((entity) => entity.id.includes('surface:floor'))
  assert.ok(surface)
  assert.equal(surface?.components[0].type, 'collider')
  if (surface?.components[0].type === 'collider') {
    assert.equal(surface.components[0].purpose, 'editor-navigation')
    assert.equal(surface.components[0].shape, 'rect-surface')
    if (surface.components[0].shape === 'rect-surface') assert.equal(surface.components[0].legacyPreset, 'floor')
  }
  assert.equal(scene.entities.some((entity) => entity.components.some((component) => component.type === 'camera')), false)
})

test('legacy import rejects malformed or unsafe data atomically and ignores generated URLs', () => {
  const unsafe = legacyManifest()
  unsafe.assets[0].workspacePath = '../escape.glb'
  assert.equal(importLegacyWorldsSceneManifest(unsafe).success, false)
  const withUrl = legacyManifest()
  Object.assign(withUrl.assets[0], { url: 'https://example.invalid/private.glb' })
  const imported = importLegacyWorldsSceneManifest(withUrl)
  assert.equal(imported.success, true)
  if (imported.success === true) assert.equal(JSON.stringify(imported.snapshot).includes('example.invalid'), false)
})

test('legacy boundary rejects inherited records and accessors without invoking them', () => {
  const manifest = legacyManifest()
  assert.equal(importLegacyWorldsSceneManifest(Object.create(manifest)).success, false)

  let getterCalls = 0
  const accessorManifest = { ...manifest }
  Object.defineProperty(accessorManifest, 'assets', {
    enumerable: true,
    get() {
      getterCalls += 1
      return manifest.assets
    },
  })
  assert.equal(importLegacyWorldsSceneManifest(accessorManifest).success, false)
  assert.equal(getterCalls, 0)

  const inheritedAsset = legacyManifest()
  inheritedAsset.assets[0] = Object.create(inheritedAsset.assets[0])
  assert.equal(importLegacyWorldsSceneManifest(inheritedAsset).success, false)

  const pollutionKey = legacyManifest()
  Object.defineProperty(pollutionKey, 'constructor', { enumerable: true, value: { prototype: { polluted: true } } })
  const polluted = importLegacyWorldsSceneManifest(pollutionKey)
  assert.equal(polluted.success, false)
  if (polluted.success === false) assert.ok(polluted.issues.some((issue) => issue.code === 'wire-key'))

  const dateValue = legacyManifest()
  Reflect.set(dateValue.assets[0], 'transform', new Date())
  assert.equal(importLegacyWorldsSceneManifest(dateValue).success, false)

  const nullPrototypeManifest = Object.assign(Object.create(null), legacyManifest())
  assert.equal(importLegacyWorldsSceneManifest(nullPrototypeManifest).success, true)

  let proxyReads = 0
  const transparent = new Proxy(legacyManifest(), {
    get(target, property, receiver) {
      proxyReads += 1
      return Reflect.get(target, property, receiver)
    },
  })
  assert.equal(importLegacyWorldsSceneManifest(transparent).success, false)
  assert.equal(proxyReads, 0)

  const throwing = new Proxy(legacyManifest(), {
    getPrototypeOf() {
      throw new Error('wrapper trap')
    },
  })
  assert.doesNotThrow(() => importLegacyWorldsSceneManifest(throwing))
  assert.equal(importLegacyWorldsSceneManifest(throwing).success, false)
})

test('flat legacy content round-trips only after every declared loss is accepted', () => {
  const imported = importLegacyWorldsSceneManifest(legacyManifest())
  assert.equal(imported.success, true)
  if (imported.success !== true) return
  const analysis = analyzeLegacyWorldsSceneExport(imported.snapshot)
  assert.equal(exportLegacyWorldsSceneManifest(imported.snapshot, { acceptedLosses: [] }).success, false)
  const exported = exportLegacyWorldsSceneManifest(imported.snapshot, { acceptedLosses: analysis.losses.map((loss) => loss.id), now: new Date('2026-09-01T12:00:00.000Z') })
  assert.equal(exported.success, true, JSON.stringify(exported))
  if (exported.success !== true) return
  assert.equal(exported.manifest.schema, 'modly.scene-manifest.v1')
  assert.equal(exported.manifest.sceneRoot, '.')
  assert.equal(exported.manifest.createdAt, '2026-09-01T12:00:00.000Z')
  assert.equal(exported.manifest.assets.length, 2)
  assert.equal(exported.manifest.assets[0].role, 'base-scene')
  assert.equal(exported.manifest.collisionSurfaces?.surfaces[0].shape, 'rect')
  assert.equal(exported.manifest.collisionSurfaces?.surfaces[0].preset, 'floor')

  const reparsed = parseWorldsSceneManifest(exported.manifest)
  assert.equal(reparsed.success, true, JSON.stringify(reparsed))
  if (reparsed.success !== true) return
  assert.deepEqual(reparsed.manifest.initialView, legacyManifest().initialView)
  assert.deepEqual(reparsed.manifest.assets.map((asset) => ({ workspacePath: asset.workspacePath, role: asset.role, visible: asset.visible, transform: asset.transform, animation: asset.animation })), exported.manifest.assets.map((asset) => ({ workspacePath: asset.workspacePath, role: asset.role, visible: asset.visible, transform: asset.transform, animation: asset.animation })))
  assert.deepEqual(reparsed.collisionSurfaces, exported.manifest.collisionSurfaces?.surfaces)
})

test('legacy export requires explicit acceptance for project and selected-scene metadata', () => {
  const snapshot = createValidWorldSnapshot()
  const analysis = analyzeLegacyWorldsSceneExport(snapshot)
  const metadataPaths = analysis.losses
    .filter((loss) => loss.code === 'project-metadata' || loss.code === 'scene-metadata')
    .map((loss) => loss.path)
  assert.deepEqual(metadataPaths, [
    'project.name',
    'project.projectId',
    'project.revision',
    'project.scenes[0].documentPath',
    'project.scenes[0].id',
    'project.scenes[0].name',
  ])
  const withoutMetadata = analysis.losses.filter((loss) => loss.code !== 'project-metadata' && loss.code !== 'scene-metadata').map((loss) => loss.id)
  const rejected = exportLegacyWorldsSceneManifest(snapshot, { acceptedLosses: withoutMetadata })
  assert.equal(rejected.success, false)
  if (rejected.success === false) assert.deepEqual(rejected.unacceptedLosses.map((loss) => loss.path), metadataPaths)
})

test('legacy preset survives canonical compatibility metadata and flat round-trip', () => {
  const imported = importLegacyWorldsSceneManifest(legacyManifest())
  assert.equal(imported.success, true, JSON.stringify(imported))
  if (imported.success !== true) return
  const colliderEntity = imported.snapshot.scenes[0].entities.find((entity) => entity.components.some((component) => component.type === 'collider'))
  const collider = colliderEntity?.components.find((component) => component.type === 'collider')
  assert.equal(collider?.type === 'collider' && (collider.shape === 'rect-surface' || collider.shape === 'tri-surface') ? collider.legacyPreset : undefined, 'floor')
  const analysis = analyzeLegacyWorldsSceneExport(imported.snapshot)
  const exported = exportLegacyWorldsSceneManifest(imported.snapshot, { acceptedLosses: analysis.losses.map((loss) => loss.id) })
  assert.equal(exported.success, true, JSON.stringify(exported))
  if (exported.success !== true) return
  assert.equal(exported.manifest.collisionSurfaces?.surfaces[0].preset, 'floor')
  assert.equal(parseWorldsSceneManifest(exported.manifest).success, true)
  assert.equal(importLegacyWorldsSceneManifest(exported.manifest).success, true)
})

test('legacy import warns and remaps asset/surface cross-domain ids deterministically', () => {
  const manifest = legacyManifest()
  manifest.collisionSurfaces.surfaces[0].id = 'asset:duplicate'
  const first = importLegacyWorldsSceneManifest(manifest)
  const second = importLegacyWorldsSceneManifest(manifest)
  assert.equal(first.success, true, JSON.stringify(first))
  assert.deepEqual(first, second)
  if (first.success !== true) return
  assert.ok(first.warnings.some((warning) => warning.code === 'cross-domain-id-normalized' && warning.path === 'manifest.collisionSurfaces.surfaces[0].id'), JSON.stringify(first.warnings))
  const ids = first.snapshot.scenes[0].entities.map((entity) => entity.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('adapter-generated ids remain addressable and exported manifests self-import for long legacy ids', () => {
  const manifest = legacyManifest()
  manifest.assets = [{ ...manifest.assets[0], id: 'x'.repeat(250) }]
  manifest.collisionSurfaces.surfaces[0].id = 'y'.repeat(250)
  const imported = importLegacyWorldsSceneManifest(manifest)
  assert.equal(imported.success, true, JSON.stringify(imported))
  if (imported.success !== true) return
  const canonicalIds = [
    imported.snapshot.project.projectId,
    ...imported.snapshot.project.resources.map((resource) => resource.id),
    ...imported.snapshot.scenes[0].entities.flatMap((entity) => [entity.id, ...entity.components.map((component) => component.id)]),
  ]
  assert.ok(canonicalIds.every((id) => id.length <= 256), JSON.stringify(canonicalIds.map((id) => id.length)))

  const analysis = analyzeLegacyWorldsSceneExport(imported.snapshot)
  const exported = exportLegacyWorldsSceneManifest(imported.snapshot, { acceptedLosses: analysis.losses.map((loss) => loss.id) })
  assert.equal(exported.success, true, JSON.stringify(exported))
  if (exported.success !== true) return
  assert.equal(parseWorldsSceneManifest(exported.manifest).success, true)
  assert.equal(importLegacyWorldsSceneManifest(exported.manifest).success, true)
  assert.ok(exported.manifest.assets.every((asset) => (asset.id?.length ?? 0) <= 228))
  assert.ok((exported.manifest.collisionSurfaces?.surfaces ?? []).every((surface) => surface.id.length <= 228))
})

test('multiple colliders receive deterministic unique legacy ids and every successful export reparses', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.scenes[0].entities[0].components.push(
    { id: 'component:surface-a', type: 'collider', enabled: true, purpose: 'editor-navigation', shape: 'rect-surface', halfExtents: [2, 3], sidedness: 'double', sensor: false, friction: 0, restitution: 0 },
    { id: 'component:surface-b', type: 'collider', enabled: true, purpose: 'editor-navigation', shape: 'tri-surface', vertices: [[0, 0], [1, 0], [0, 1]], sidedness: 'front', sensor: false, friction: 0, restitution: 0 },
  )
  const analysis = analyzeLegacyWorldsSceneExport(snapshot)
  assert.ok(analysis.losses.some((loss) => loss.code === 'collider-grouping'))
  assert.ok(analysis.losses.some((loss) => loss.code === 'collider-geometry'))
  const options = { acceptedLosses: analysis.losses.map((loss) => loss.id), now: new Date('2026-09-02T00:00:00.000Z') }
  const first = exportLegacyWorldsSceneManifest(snapshot, options)
  const second = exportLegacyWorldsSceneManifest(snapshot, options)
  assert.equal(first.success, true, JSON.stringify(first))
  assert.equal(second.success, true, JSON.stringify(second))
  if (first.success !== true || second.success !== true) return
  const firstIds = first.manifest.collisionSurfaces?.surfaces.map((surface) => surface.id) ?? []
  const secondIds = second.manifest.collisionSurfaces?.surfaces.map((surface) => surface.id) ?? []
  assert.equal(firstIds.length, 2)
  assert.equal(new Set(firstIds).size, 2)
  assert.deepEqual(firstIds, secondIds)
  assert.equal(parseWorldsSceneManifest(first.manifest).success, true)
})

test('triangle loss analysis matches legacy winding and minimum-area canonicalization exactly', () => {
  const makeSnapshot = (vertices: [[number, number], [number, number], [number, number]]) => {
    const snapshot = createValidWorldSnapshot()
    snapshot.scenes[0].entities[0].components.push({
      id: 'component:triangle', type: 'collider', enabled: true, purpose: 'editor-navigation', shape: 'tri-surface', vertices, sidedness: 'front', sensor: false, friction: 0, restitution: 0,
    })
    return snapshot
  }
  const trianglePath = 'scenes[0].entities[0].components[1].vertices'

  const positive = makeSnapshot([[0, 0], [0, 1], [1, 0]])
  const positiveAnalysis = analyzeLegacyWorldsSceneExport(positive)
  assert.equal(positiveAnalysis.losses.some((loss) => loss.code === 'collider-geometry' && loss.path === trianglePath), false)
  const positiveExport = exportLegacyWorldsSceneManifest(positive, { acceptedLosses: positiveAnalysis.losses.map((loss) => loss.id) })
  assert.equal(positiveExport.success, true, JSON.stringify(positiveExport))
  if (positiveExport.success === true) {
    assert.deepEqual(positiveExport.manifest.collisionSurfaces?.surfaces[0].geometry, { vertices: [[0, 0], [0, 1], [1, 0]] })
    assert.equal(parseWorldsSceneManifest(positiveExport.manifest).success, true)
  }

  const negative = makeSnapshot([[0, 0], [1, 0], [0, 1]])
  const negativeAnalysis = analyzeLegacyWorldsSceneExport(negative)
  assert.ok(negativeAnalysis.losses.some((loss) => loss.code === 'collider-geometry' && loss.path === trianglePath))
  assert.equal(exportLegacyWorldsSceneManifest(negative, { acceptedLosses: negativeAnalysis.losses.filter((loss) => loss.code !== 'collider-geometry').map((loss) => loss.id) }).success, false)
  const negativeExport = exportLegacyWorldsSceneManifest(negative, { acceptedLosses: negativeAnalysis.losses.map((loss) => loss.id) })
  assert.equal(negativeExport.success, true, JSON.stringify(negativeExport))
  if (negativeExport.success === true) {
    assert.deepEqual(negativeExport.manifest.collisionSurfaces?.surfaces[0].geometry, { vertices: [[0, 0], [0, 1], [1, 0]] })
    assert.equal(parseWorldsSceneManifest(negativeExport.manifest).success, true)
  }

  const tiny = makeSnapshot([[0, 0], [1, 0], [0, 1e-9]])
  const tinyAnalysis = analyzeLegacyWorldsSceneExport(tiny)
  assert.ok(tinyAnalysis.losses.some((loss) => loss.code === 'collider-geometry' && loss.path === trianglePath))
  const tinyExport = exportLegacyWorldsSceneManifest(tiny, { acceptedLosses: tinyAnalysis.losses.map((loss) => loss.id) })
  assert.equal(tinyExport.success, true, JSON.stringify(tinyExport))
  if (tinyExport.success === true) {
    assert.equal(tinyExport.manifest.collisionSurfaces, undefined)
    assert.equal(parseWorldsSceneManifest(tinyExport.manifest).success, true)
  }
})

test('legacy export declares every entity, resource, and component identity remap before success', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.scenes[0].entities[0].id = 'canonical.hero'
  const analysis = analyzeLegacyWorldsSceneExport(snapshot)
  const identityPaths = analysis.losses.filter((loss) => loss.code === 'identity-remap').map((loss) => loss.path)
  assert.deepEqual(identityPaths, [
    'project.resources[0].id',
    'scenes[0].entities[0].components[0].id',
    'scenes[0].entities[0].id',
  ])
  assert.equal(exportLegacyWorldsSceneManifest(snapshot, { acceptedLosses: analysis.losses.filter((loss) => loss.code !== 'identity-remap').map((loss) => loss.id) }).success, false)

  const exported = exportLegacyWorldsSceneManifest(snapshot, { acceptedLosses: analysis.losses.map((loss) => loss.id) })
  assert.equal(exported.success, true, JSON.stringify(exported))
  if (exported.success !== true) return
  assert.equal(parseWorldsSceneManifest(exported.manifest).success, true)
  const imported = importLegacyWorldsSceneManifest(exported.manifest)
  assert.equal(imported.success, true, JSON.stringify(imported))
  if (imported.success !== true) return
  assert.notEqual(imported.snapshot.scenes[0].entities[0].id, 'canonical.hero')
  assert.notEqual(imported.snapshot.project.resources[0].id, 'resource:hero')
  assert.notEqual(imported.snapshot.scenes[0].entities[0].components[0].id, 'component:hero-renderable')
})

test('non-representable collision transforms are declared and omitted only after acceptance', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.scenes[0].entities[0].transform.scale = [0, 1, 1]
  snapshot.scenes[0].entities[0].components.push({ id: 'component:zero-surface', type: 'collider', enabled: true, purpose: 'editor-navigation', shape: 'rect-surface', halfExtents: [2, 2], sidedness: 'double', sensor: false, friction: 0, restitution: 0 })
  const analysis = analyzeLegacyWorldsSceneExport(snapshot)
  assert.ok(analysis.losses.some((loss) => loss.code === 'collider-transform'))
  assert.equal(exportLegacyWorldsSceneManifest(snapshot, { acceptedLosses: [] }).success, false)
  const exported = exportLegacyWorldsSceneManifest(snapshot, { acceptedLosses: analysis.losses.map((loss) => loss.id) })
  assert.equal(exported.success, true, JSON.stringify(exported))
  if (exported.success !== true) return
  assert.equal(exported.manifest.collisionSurfaces, undefined)
  assert.equal(parseWorldsSceneManifest(exported.manifest).success, true)
})

test('authored renderable and collider state produces granular deterministic losses', () => {
  const snapshot = createValidWorldSnapshot()
  const entity = snapshot.scenes[0].entities[0]
  entity.enabled = false
  const renderable = entity.components[0]
  if (renderable.type !== 'renderable') return
  renderable.enabled = false
  renderable.castShadow = false
  renderable.receiveShadow = false
  renderable.material = { baseColor: '#ff0000', metallic: 0.2, roughness: 0.3, opacity: 0.4 }
  entity.components.push({
    id: 'component:authored-surface', type: 'collider', enabled: false, purpose: 'editor-navigation', shape: 'rect-surface', halfExtents: [1, 1], sidedness: 'double', sensor: true, friction: 0.7, restitution: 0.5, collisionLayer: 2, collisionMask: 3,
  })
  const analysis = analyzeLegacyWorldsSceneExport(snapshot)
  const paths = new Set(analysis.losses.map((loss) => loss.path))
  for (const suffix of [
    '.enabled',
    '.components[0].enabled',
    '.components[0].castShadow',
    '.components[0].receiveShadow',
    '.components[0].material.baseColor',
    '.components[0].material.metallic',
    '.components[0].material.roughness',
    '.components[0].material.opacity',
    '.components[1].enabled',
    '.components[1].sensor',
    '.components[1].friction',
    '.components[1].restitution',
    '.components[1].collisionLayer',
    '.components[1].collisionMask',
  ]) assert.ok([...paths].some((path) => path.endsWith(suffix)), suffix)

  const exported = exportLegacyWorldsSceneManifest(snapshot, { acceptedLosses: analysis.losses.map((loss) => loss.id) })
  assert.equal(exported.success, true, JSON.stringify(exported))
  if (exported.success === true) assert.equal(parseWorldsSceneManifest(exported.manifest).success, true)
})

test('legacy loss analysis declares model resource names and shared identity that cannot round-trip', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.project.resources[0].name = 'Canonical model name'
  snapshot.scenes[0].entities.push({
    id: 'entity:hero-copy',
    name: 'Hero copy',
    parentId: null,
    enabled: true,
    locked: false,
    tags: [],
    transform: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [{
      id: 'component:hero-copy-renderable',
      type: 'renderable',
      enabled: true,
      resourceId: 'resource:hero',
      visible: true,
      castShadow: true,
      receiveShadow: true,
      material: { baseColor: '#ffffff', metallic: 0, roughness: 1, opacity: 1 },
    }],
  })
  const analysis = analyzeLegacyWorldsSceneExport(snapshot)
  assert.ok(analysis.losses.some((loss) => loss.code === 'unsupported-resources' && loss.path === 'project.resources[0].name'))
  assert.ok(analysis.losses.some((loss) => loss.code === 'unsupported-resources' && loss.path === 'project.resources[0].id'))
})

test('legacy role tags are treated as representable only on matching entity content', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.scenes[0].entities[0].tags = ['modly:editor-navigation']
  const analysis = analyzeLegacyWorldsSceneExport(snapshot)
  assert.ok(analysis.losses.some((loss) => loss.code === 'tags-locks' && loss.path === 'scenes[0].entities[0].tags[0]'))
})

test('loss analysis gates every unsupported canonical feature explicitly', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.project.resources.push({ id: 'resource:sound', type: 'audio', name: 'Sound', workspacePath: 'Audio/sound.wav', format: 'wav' })
  snapshot.scenes[0].environment = { backgroundColor: '#ff0000', ambientIntensity: 2 }
  snapshot.scenes[0].sequences.push({ id: 'sequence:intro', name: 'Intro', duration: { numerator: 3, denominator: 1 }, tracks: [] })
  snapshot.scenes[0].entities[0].locked = true
  snapshot.scenes[0].entities[0].tags.push('gameplay')
  snapshot.scenes[0].entities[0].components.push(
    { id: 'component:body', type: 'rigid-body', enabled: true, bodyType: 'dynamic', gravityScale: 1, linearDamping: 0, angularDamping: 0, canSleep: true },
    { id: 'component:audio', type: 'audio-source', enabled: true, resourceId: 'resource:sound', autoplay: false, loop: false, volume: 1, spatial: true, maxDistance: 20 },
    { id: 'component:behavior', type: 'behavior', enabled: true, bindings: [] },
  )
  const analysis = analyzeLegacyWorldsSceneExport(snapshot)
  const codes = new Set(analysis.losses.map((loss) => loss.code))
  for (const code of ['extra-scenes', 'environment', 'simulation-physics', 'audio', 'behavior', 'sequences', 'input-actions', 'graphics-profiles', 'tags-locks'] as const) assert.ok(codes.has(code), code)
  const partiallyAccepted = exportLegacyWorldsSceneManifest(snapshot, { acceptedLosses: analysis.losses.slice(1).map((loss) => loss.id) })
  assert.equal(partiallyAccepted.success, false)
  if (partiallyAccepted.success === false) assert.equal(partiallyAccepted.unacceptedLosses.length, 1)
})

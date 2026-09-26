import assert from 'node:assert/strict'
import test from 'node:test'

import { createValidWorldSnapshot } from '../core/_testFixtures.ts'
import { projectWorldScene } from './worldEditorProjection.ts'

test('projection builds immutable hierarchy, world transforms and render descriptors without canonical URLs', () => {
  const snapshot = createValidWorldSnapshot()
  snapshot.project.resources.push({ id: 'resource:env', type: 'environment', name: 'Studio', workspacePath: 'Assets/studio.hdr', format: 'hdr' })
  snapshot.scenes[0].environment.environmentResourceId = 'resource:env'
  snapshot.scenes[0].entities[0].transform = { position: [2, 0, 0], rotation: [0, Math.PI / 2, 0], scale: [2, 2, 2] }
  snapshot.scenes[0].entities.push({
    id: 'entity:child', name: 'Child', parentId: 'entity:hero', enabled: false, locked: true, tags: [],
    transform: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: [
      { id: 'component:camera', type: 'camera', enabled: true, projection: 'perspective', primary: true, near: 0.1, far: 100, fieldOfView: 60 },
      { id: 'component:light', type: 'light', enabled: true, lightKind: 'point', color: '#ffffff', intensity: 2, range: 10, castShadow: true },
      { id: 'component:navigation', type: 'collider', enabled: true, purpose: 'editor-navigation', shape: 'rect-surface', halfExtents: [2, 3], sidedness: 'double', sensor: false, friction: 0, restitution: 0 },
    ],
  })
  const before = structuredClone(snapshot)
  const projection = projectWorldScene(snapshot, 'scene:one', (workspacePath) => `modly://workspace/${encodeURIComponent(workspacePath)}`)
  assert.equal(projection.success, true)
  if (!projection.success) return
  assert.deepEqual(snapshot, before)
  assert.equal(projection.value.hierarchy.roots[0].id, 'entity:hero')
  assert.deepEqual(projection.value.hierarchy.roots[0].childIds, ['entity:child'])
  const child = projection.value.entities.find((entity) => entity.id === 'entity:child')!
  assert.equal(child.effectiveEnabled, false)
  assert.equal(child.effectiveLocked, true)
  assert.ok(Math.abs(child.worldTransform.position[0] - 2) < 1e-9)
  assert.ok(Math.abs(child.worldTransform.position[2] + 2) < 1e-9)
  assert.equal(projection.value.viewerItems[0].url.startsWith('modly://workspace/'), true)
  assert.equal('url' in snapshot.project.resources[0], false)
  assert.equal(projection.value.viewerItems[0].material.baseColor, '#ffffff')
  assert.equal(projection.value.cameras.length, 1)
  assert.equal(projection.value.lights.length, 1)
  assert.equal(projection.value.editorNavigationSurfaces.length, 1)
  assert.equal(projection.value.environment.environmentResourceUrl?.startsWith('modly://workspace/'), true)
  assert.deepEqual(projection.value.initialView, snapshot.scenes[0].editor?.initialView)
  assert.equal(Object.isFrozen(projection.value), true)
  assert.equal(Reflect.set(projection.value.entities[0], 'name', 'Hostile'), false)
})

test('bad resolver results become deterministic warnings without mutating the snapshot', () => {
  const snapshot = createValidWorldSnapshot()
  const projection = projectWorldScene(snapshot, 'scene:one', () => { throw new Error('unavailable') })
  assert.equal(projection.success, true)
  if (!projection.success) return
  assert.equal(projection.value.viewerItems.length, 0)
  assert.deepEqual(projection.value.warnings, ['resource:resource:hero:unavailable'])
  assert.equal(projectWorldScene(snapshot, 'scene:missing', () => '').success, false)
})

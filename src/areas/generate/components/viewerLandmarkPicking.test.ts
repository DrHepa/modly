import assert from 'node:assert/strict'
import test from 'node:test'

import type { LandmarkPoint } from '../../workflows/landmarks.ts'
import {
  createLandmarkPointIntent,
  deriveLandmarkMarkers,
  resolveLandmarkMarkerRenderModels,
  resolveLandmarkMarkerLabelVisibility,
  normalizeCanvasPointer,
} from './viewerLandmarkPicking.ts'

const canvas = {
  getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 100 }),
}

test('normalizeCanvasPointer uses canvas-relative coordinates', () => {
  assert.deepEqual(
    normalizeCanvasPointer({ clientX: 110, clientY: 45 }, canvas),
    { x: 0, y: 0.5 },
  )
})

test('createLandmarkPointIntent filters to relevant clickables and stores world point with objectName', () => {
  const ignoredObject = { name: 'grid-helper', userData: {} }
  const targetObject = { name: 'mesh-node', userData: { objectName: 'Body Mesh' } }

  const intent = createLandmarkPointIntent({
    activeLandmarkId: 'left_shoulder',
    pointer: { clientX: 110, clientY: 45 },
    canvas,
    intersections: [
      { object: ignoredObject, point: { x: 99, y: 99, z: 99 } },
      { object: targetObject, point: { x: 1.25, y: 2.5, z: -3.75 } },
    ],
    clickableObjects: [targetObject],
  })

  assert.deepEqual(intent, {
    pointer: { x: 0, y: 0.5 },
    point: {
      id: 'left_shoulder',
      name: 'left_shoulder',
      world: { x: 1.25, y: 2.5, z: -3.75 },
      objectName: 'Body Mesh',
      confidence: 1,
      source: 'manual',
    },
  })
})

test('createLandmarkPointIntent accepts descendant hits for filtered clickables and falls back to object name', () => {
  const rootObject = { name: 'root-mesh', userData: {} }
  const childObject = { name: 'child-surface', userData: {}, parent: rootObject }

  const intent = createLandmarkPointIntent({
    activeLandmarkId: 'hip',
    pointer: { clientX: 210, clientY: 120 },
    canvas,
    intersections: [
      { object: childObject, point: { x: -1, y: 0.5, z: 4 } },
    ],
    clickableObjects: [rootObject],
  })

  assert.deepEqual(intent?.point, {
    id: 'hip',
    name: 'hip',
    world: { x: -1, y: 0.5, z: 4 },
    objectName: 'child-surface',
    confidence: 1,
    source: 'manual',
  })
  assert.deepEqual(intent?.pointer, { x: 1, y: -1 })
})

test('createLandmarkPointIntent ignores miss and no relevant hit', () => {
  const targetObject = { name: 'body', userData: {} }
  const helperObject = { name: 'gizmo', userData: {} }

  assert.equal(
    createLandmarkPointIntent({
      activeLandmarkId: 'right_knee',
      pointer: { clientX: 110, clientY: 45 },
      canvas,
      intersections: [],
      clickableObjects: [targetObject],
    }),
    null,
  )

  assert.equal(
    createLandmarkPointIntent({
      activeLandmarkId: 'right_knee',
      pointer: { clientX: 110, clientY: 45 },
      canvas,
      intersections: [{ object: helperObject, point: { x: 0, y: 0, z: 0 } }],
      clickableObjects: [targetObject],
    }),
    null,
  )
})

test('deriveLandmarkMarkers derives marker view models from completed landmarks in required order', () => {
  const completed: Partial<Record<LandmarkPoint['id'], LandmarkPoint>> = {
    hip: {
      id: 'hip',
      name: 'hip',
      world: { x: 0, y: 1, z: 2 },
      confidence: 1,
      source: 'manual',
    },
    left_shoulder: {
      id: 'left_shoulder',
      name: 'left_shoulder',
      world: { x: 3, y: 4, z: 5 },
      objectName: 'torso',
      confidence: 1,
      source: 'manual',
    },
  }

  assert.deepEqual(deriveLandmarkMarkers(completed), [
    { id: 'left_shoulder', name: 'left_shoulder', label: 'Left shoulder', shortLabel: 'LS', color: '#fbbf24', position: { x: 3, y: 4, z: 5 }, objectName: 'torso' },
    { id: 'hip', name: 'hip', label: 'Hip', shortLabel: 'H', color: '#f97316', position: { x: 0, y: 1, z: 2 } },
  ])
})

test('deriveLandmarkMarkers gives every required marker a readable hover label and compact short label', () => {
  const completed: Partial<Record<LandmarkPoint['id'], LandmarkPoint>> = {
    left_shoulder: landmarkPoint('left_shoulder', 1),
    right_shoulder: landmarkPoint('right_shoulder', 2),
    hip: landmarkPoint('hip', 3),
    left_knee: landmarkPoint('left_knee', 4),
    right_knee: landmarkPoint('right_knee', 5),
  }

  assert.deepEqual(
    deriveLandmarkMarkers(completed).map((marker) => [marker.id, marker.label, marker.shortLabel]),
    [
      ['left_shoulder', 'Left shoulder', 'LS'],
      ['right_shoulder', 'Right shoulder', 'RS'],
      ['hip', 'Hip', 'H'],
      ['left_knee', 'Left knee', 'LK'],
      ['right_knee', 'Right knee', 'RK'],
    ],
  )
})

test('resolveLandmarkMarkerRenderModels keeps scene badges compact and full labels hover-only', () => {
  const markers = deriveLandmarkMarkers({
    left_shoulder: landmarkPoint('left_shoulder', 1),
    hip: landmarkPoint('hip', 3),
  })

  assert.deepEqual(resolveLandmarkMarkerRenderModels(markers, 'hip'), [
    {
      id: 'left_shoulder',
      badgeLabel: 'LS',
      fullLabel: 'Left shoulder',
      color: '#fbbf24',
      showFullLabel: false,
      position: { x: 1, y: 2, z: 3 },
    },
    {
      id: 'hip',
      badgeLabel: 'H',
      fullLabel: 'Hip',
      color: '#f97316',
      showFullLabel: true,
      position: { x: 3, y: 4, z: 5 },
    },
  ])
  assert.ok(resolveLandmarkMarkerRenderModels(markers, null).every((marker) => marker.badgeLabel.length <= 2 && !marker.showFullLabel))
})

test('resolveLandmarkMarkerLabelVisibility shows only the hovered marker label', () => {
  const markers = deriveLandmarkMarkers({
    left_shoulder: landmarkPoint('left_shoulder', 1),
    right_knee: landmarkPoint('right_knee', 2),
  })

  assert.deepEqual(resolveLandmarkMarkerLabelVisibility(markers, 'right_knee'), [
    { id: 'left_shoulder', label: 'Left shoulder', shortLabel: 'LS', visible: false },
    { id: 'right_knee', label: 'Right knee', shortLabel: 'RK', visible: true },
  ])
  assert.deepEqual(resolveLandmarkMarkerLabelVisibility(markers, null), [
    { id: 'left_shoulder', label: 'Left shoulder', shortLabel: 'LS', visible: false },
    { id: 'right_knee', label: 'Right knee', shortLabel: 'RK', visible: false },
  ])
})

function landmarkPoint(id: LandmarkPoint['id'], x: number): LandmarkPoint {
  return {
    id,
    name: id,
    world: { x, y: x + 1, z: x + 2 },
    confidence: 1,
    source: 'manual',
  }
}

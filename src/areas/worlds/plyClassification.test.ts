import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'

import {
  classifyPlyHeader,
  classifyPlyGeometry,
} from './plyClassification.ts'

const fixturesDir = path.join(import.meta.dirname, '__fixtures__')

test('classifies colored indexed PLY fixtures as vertex-color mesh geometry', async () => {
  const source = await readFile(path.join(fixturesDir, 'colored-mesh.ply'), 'utf8')
  const geometry = new PLYLoader().parse(new TextEncoder().encode(source).buffer)

  assert.deepEqual(classifyPlyHeader(source), { kind: 'standard-mesh', hasFaces: true, hasVertexColors: true })
  assert.deepEqual(classifyPlyGeometry(geometry), { kind: 'mesh', hasVertexColors: true })
  assert.equal(geometry.index?.count, 3)
  assert.equal(geometry.getAttribute('color')?.count, 3)
})

test('classifies colored non-indexed PLY fixtures as vertex-color points geometry', async () => {
  const source = await readFile(path.join(fixturesDir, 'colored-points.ply'), 'utf8')
  const geometry = new PLYLoader().parse(new TextEncoder().encode(source).buffer)

  assert.deepEqual(classifyPlyHeader(source), { kind: 'standard-points', hasFaces: false, hasVertexColors: true })
  assert.deepEqual(classifyPlyGeometry(geometry), { kind: 'points', hasVertexColors: true })
  assert.equal(geometry.index, null)
  assert.equal(geometry.getAttribute('color')?.count, 3)
})

test('classifies Gaussian PLY headers as deferred unsupported assets', () => {
  const header = `ply
format ascii 1.0
element vertex 1
property float x
property float y
property float z
property float f_dc_0
property float opacity
property float scale_0
property float rot_0
end_header
`

  assert.deepEqual(classifyPlyHeader(header), { kind: 'gaussian', hasFaces: false, hasVertexColors: false })
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyPlyHeader } from './plyHeaderClassification.ts'

test('classifies Gaussian PLY headers from ASCII or binary-format headers', () => {
  const header = `ply
format binary_little_endian 1.0
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

  assert.deepEqual(classifyPlyHeader(header), { plyKind: 'gaussian', hasFaces: false, hasVertexColors: false })
})

test('classifies face-bearing PLY headers as mesh', () => {
  const header = `ply
format ascii 1.0
element vertex 3
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
element face 1
property list uchar int vertex_indices
end_header
`

  assert.deepEqual(classifyPlyHeader(header), { plyKind: 'mesh', hasFaces: true, hasVertexColors: true })
})

test('classifies vertex-only PLY headers as points', () => {
  const header = `ply
format ascii 1.0
element vertex 3
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
end_header
`

  assert.deepEqual(classifyPlyHeader(header), { plyKind: 'points', hasFaces: false, hasVertexColors: true })
})

test('fails closed for missing PLY signatures', () => {
  assert.deepEqual(classifyPlyHeader('not-a-ply'), { plyKind: 'unknown', hasFaces: false, hasVertexColors: false })
})

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
  assert.deepEqual(classifyPlyGeometry(geometry, classifyPlyHeader(source)), { kind: 'points', hasVertexColors: true })
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

test('reads declarations rather than comments and supports whitespace and numeric aliases', () => {
  const points = 'ply\r\nformat binary_little_endian 1.0\r\ncomment property float f_dc_0 property float scale_0 property float rot_0\r\nelement vertex 1\r\nproperty float32 x\r\nproperty float32 y\r\nproperty float32 z\r\nproperty uint8 red\r\nproperty uint8 green\r\nproperty uint8 blue\r\nend_header\r\n'
  assert.deepEqual(classifyPlyHeader(points), { kind: 'standard-points', hasFaces: false, hasVertexColors: true })
  const gaussian = points.replace('end_header', 'property  float32  f_dc_0\r\nproperty\tfloat\tscale_0\r\nproperty float rot_0\r\nend_header')
  assert.equal(classifyPlyHeader(gaussian).kind, 'gaussian')
  const faceOnly = points.replace('end_header', 'element face 1\r\nproperty list uchar int vertex_indices\r\nproperty float f_dc_0\r\nproperty float scale_0\r\nproperty float rot_0\r\nend_header')
  assert.equal(classifyPlyHeader(faceOnly).kind, 'standard-mesh')
})

test('does not call malformed, incomplete or over-limit declarations standard PLY', () => {
  const valid = 'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n'
  for (const input of ['', 'not ply\nend_header\n', valid.replace('end_header\n', ''), valid.replace('vertex 1', 'vertex -1'), valid.replace('property float z\n', ''), valid.replace('ascii 1.0', 'unknown 1.0'), valid.replace('end_header', `comment ${'x'.repeat(65536)}\nend_header`)]) {
    assert.equal(classifyPlyHeader(input).kind, 'invalid')
  }
})

const TRIANGLE_HEADER = 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n'
const TRIANGLE_BODY = '0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n'
const parseExactPlyBytes = (source: string) => new PLYLoader().parse(new TextEncoder().encode(source).buffer)

test('header eligibility follows actual ArrayBuffer loader newline, blank-line and terminator behavior', () => {
  const source = TRIANGLE_HEADER + TRIANGLE_BODY
  for (const valid of [source, source.replaceAll('\n', '\r'), source.replaceAll('\n', '\r\n'), source.replace('element vertex', ' \t\nelement vertex'), source.replace('end_header', ' end_header')]) {
    const geometry = parseExactPlyBytes(valid)
    assert.equal(geometry.getAttribute('position').count, 3)
    assert.equal(geometry.index?.count, 3)
    assert.equal(classifyPlyHeader(valid).kind, 'standard-mesh')
  }
  for (const suffix of [' ', '\t']) {
    const invalid = source.replace('end_header', `end_header${suffix}`)
    assert.equal(parseExactPlyBytes(invalid).getAttribute('position').count, 0)
    assert.equal(classifyPlyHeader(invalid).kind, 'invalid')
  }
})

test('same-byte header context preserves non-indexed triangle meshes with face colors or face UVs', () => {
  const variants = [
    { declaration: 'property uchar red\nproperty uchar green\nproperty uchar blue\n', values: ' 255 0 0', attribute: 'color', colors: true },
    { declaration: 'property list uchar float texcoord\n', values: ' 6 0 0 1 0 0 1', attribute: 'uv', colors: false },
  ]
  for (const variant of variants) {
    const source = TRIANGLE_HEADER.replace('end_header', `${variant.declaration}end_header`) + TRIANGLE_BODY.trimEnd() + variant.values + '\n'
    const geometry = parseExactPlyBytes(source)
    assert.equal(geometry.index, null)
    assert.equal(geometry.getAttribute('position').count, 3)
    assert.equal(geometry.getAttribute(variant.attribute).count, 3)
    assert.deepEqual(classifyPlyGeometry(geometry, classifyPlyHeader(source)), { kind: 'mesh', hasVertexColors: variant.colors })
    assert.equal(classifyPlyGeometry(geometry).kind, 'unknown')
  }
})

test('absent or unsupported header context does not invent topology from positions', async () => {
  const source = await readFile(path.join(fixturesDir, 'colored-points.ply'), 'utf8')
  const geometry = parseExactPlyBytes(source)
  assert.equal(geometry.index, null)
  assert.equal(geometry.getAttribute('position').count, 3)
  assert.deepEqual(classifyPlyGeometry(geometry, classifyPlyHeader(source)), { kind: 'points', hasVertexColors: true })
  assert.deepEqual(classifyPlyGeometry(geometry), { kind: 'unknown', hasVertexColors: true })
  assert.equal(classifyPlyGeometry(geometry, classifyPlyHeader('invalid')).kind, 'unknown')
})

test('binary ArrayBuffer topology uses supported line endings and exact byte-offset terminators', () => {
  const body = Buffer.alloc(49)
  for (const [index, value] of [0, 0, 0, 1, 0, 0, 0, 1, 0].entries()) body.writeFloatLE(value, index * 4)
  body.writeUInt8(3, 36)
  for (let index = 0; index < 3; index++) body.writeInt32LE(index, 37 + index * 4)
  for (const newline of ['\n', '\r', '\r\n']) {
    const header = TRIANGLE_HEADER.replace('ascii', 'binary_little_endian').replaceAll('\n', newline)
    const bytes = Buffer.concat([Buffer.from(header), body])
    const geometry = new PLYLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    assert.equal(geometry.index?.count, 3)
    assert.deepEqual(Array.from(geometry.getAttribute('position').array), [0, 0, 0, 1, 0, 0, 0, 1, 0])
    assert.equal(classifyPlyHeader(header).kind, 'standard-mesh')
    const indented = header.replace('end_header', ' end_header')
    const invalidBytes = Buffer.concat([Buffer.from(indented), body])
    assert.throws(() => new PLYLoader().parse(invalidBytes.buffer.slice(invalidBytes.byteOffset, invalidBytes.byteOffset + invalidBytes.byteLength)), RangeError)
    assert.equal(classifyPlyHeader(indented).kind, 'invalid')
  }
})

test('eligibility matches actual magic, interior and terminator newline offsets without banning supported mixed endings', () => {
  const positions = [2, 3, 4, 5, 6, 7, 8, 9, 10]
  let readable = 0
  let incompatible = 0
  for (const format of ['ascii', 'binary_little_endian', 'binary_big_endian']) {
    const binaryBody = Buffer.alloc(49)
    positions.forEach((value, index) => format === 'binary_big_endian' ? binaryBody.writeFloatBE(value, index * 4) : binaryBody.writeFloatLE(value, index * 4))
    binaryBody[36] = 3
    for (let index = 0; index < 3; index++) {
      if (format === 'binary_big_endian') binaryBody.writeInt32BE(index, 37 + index * 4)
      else binaryBody.writeInt32LE(index, 37 + index * 4)
    }
    for (const magic of ['\n', '\r', '\r\n']) for (const interior of ['\n', '\r', '\r\n']) for (const terminator of ['\n', '\r', '\r\n']) {
      const lines = TRIANGLE_HEADER.trimEnd().replace('ascii', format).split('\n')
      const header = lines[0] + magic + lines.slice(1, -1).join(interior) + interior + lines.at(-1) + terminator
      const bytes = Buffer.concat([Buffer.from(header), format === 'ascii' ? Buffer.from('2 3 4\n5 6 7\n8 9 10\n3 0 1 2\n') : binaryBody])
      let parsesExactly = false
      try {
        const geometry = new PLYLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
        parsesExactly = JSON.stringify(Array.from(geometry.getAttribute('position').array)) === JSON.stringify(positions)
          && JSON.stringify(geometry.index ? Array.from(geometry.index.array) : null) === '[0,1,2]'
      } catch (error) {
        assert.ok(error instanceof RangeError)
      }
      const identity = JSON.stringify({ format, magic, interior, terminator })
      assert.equal(classifyPlyHeader(header).kind, parsesExactly ? 'standard-mesh' : 'invalid', identity)
      if (parsesExactly) readable++
      else incompatible++
    }
  }
  assert.equal(readable, 57)
  assert.equal(incompatible, 24)
})

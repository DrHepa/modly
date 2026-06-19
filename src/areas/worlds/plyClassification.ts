import type { BufferGeometry } from 'three'

export type PlyHeaderClassification =
  | { kind: 'invalid'; hasFaces: false; hasVertexColors: false }
  | { kind: 'gaussian'; hasFaces: false; hasVertexColors: false }
  | { kind: 'standard-mesh'; hasFaces: true; hasVertexColors: boolean }
  | { kind: 'standard-points'; hasFaces: false; hasVertexColors: boolean }

export type PlyGeometryClassification =
  | { kind: 'mesh'; hasVertexColors: boolean }
  | { kind: 'points'; hasVertexColors: boolean }
  | { kind: 'unknown'; hasVertexColors: boolean }

const SCALAR_TYPES = new Set(['char', 'uchar', 'short', 'ushort', 'int', 'uint', 'int8', 'uint8', 'int16', 'uint16', 'int32', 'uint32', 'float', 'double', 'float32', 'float64'])
const INTEGER_TYPES = new Set(['char', 'uchar', 'short', 'ushort', 'int', 'uint', 'int8', 'uint8', 'int16', 'uint16', 'int32', 'uint32'])
const FLOAT_TYPES = new Set(['float', 'double', 'float32', 'float64'])

export function classifyPlyHeader(source: string): PlyHeaderClassification {
  const invalid = { kind: 'invalid', hasFaces: false, hasVertexColors: false } as const
  // Bound inspection even when a caller supplies an entire model string.
  const prefix = source.slice(0, 65536)
  const delimiter = /(?:^|[\r\n])[\t ]*end_header(?:\r\n|\r|\n)/.exec(prefix)
  if (!delimiter) return invalid
  const header = prefix.slice(0, delimiter.index + delimiter[0].length)
  if (new TextEncoder().encode(header).byteLength > 65536) return invalid
  const lines = header.trimEnd().split(/\r\n|\r|\n/)
  if (lines.shift() !== 'ply') return invalid
  let formatSeen = false
  let binary = false
  let current: { name: string; count: number; properties: Map<string, string> } | undefined
  const elements = new Map<string, NonNullable<typeof current>>()
  for (const line of lines) {
    if (!line.trim()) continue
    const words = line.trim().split(/\s+/)
    if (words[0] === 'comment' || words[0] === 'obj_info') continue
    if (words[0] === 'format') {
      if (formatSeen || current || words.length !== 3 || words[2] !== '1.0'
        || !['ascii', 'binary_little_endian', 'binary_big_endian'].includes(words[1])) return invalid
      formatSeen = true
      binary = words[1] !== 'ascii'
    } else if (words[0] === 'element') {
      if (!formatSeen || words.length !== 3 || !/^\d+$/.test(words[2])
        || !Number.isSafeInteger(Number(words[2])) || elements.has(words[1])) return invalid
      current = { name: words[1], count: Number(words[2]), properties: new Map() }
      elements.set(current.name, current)
    } else if (words[0] === 'property') {
      if (!current) return invalid
      const list = words[1] === 'list'
      if (list ? words.length !== 5 || !INTEGER_TYPES.has(words[2]) || !SCALAR_TYPES.has(words[3])
        : words.length !== 3 || !SCALAR_TYPES.has(words[1])) return invalid
      const name = words[list ? 4 : 2]
      if (current.properties.has(name)) return invalid
      current.properties.set(name, list ? `list:${words[3]}` : words[1])
    } else if (words.length !== 1 || words[0] !== 'end_header' || (binary && line !== 'end_header')) {
      // ASCII parsing tolerates indentation; binary offsets in PLYLoader require
      // the exact terminator line used by its ArrayBuffer header scanner.
      return invalid
    }
  }
  // PLYLoader's binary scanner consumes one terminator byte, then a second
  // only when the magic line used CRLF. Match that actual byte-offset rule,
  // not a blanket uniform-newline policy: interior endings and LF/CR mixes work.
  if (binary && prefix.startsWith('ply\r\n') !== delimiter[0].endsWith('\r\n')) return invalid
  const vertex = elements.get('vertex')
  if (!formatSeen || !vertex || !['x', 'y', 'z'].every(name => SCALAR_TYPES.has(vertex.properties.get(name) ?? ''))) return invalid
  if (['f_dc_0', 'scale_0', 'rot_0'].every(name => FLOAT_TYPES.has(vertex.properties.get(name) ?? ''))) {
    return { kind: 'gaussian', hasFaces: false, hasVertexColors: false }
  }
  const face = elements.get('face')
  const indices = face?.properties.get('vertex_indices') ?? face?.properties.get('vertex_index')
  if (face && face.count > 0 && (!indices?.startsWith('list:') || !INTEGER_TYPES.has(indices.slice(5)))) return invalid
  const hasFaces = Boolean(face && face.count > 0)
  const hasVertexColors = ['red', 'green', 'blue'].every(name => SCALAR_TYPES.has(vertex.properties.get(name) ?? ''))

  return hasFaces
    ? { kind: 'standard-mesh', hasFaces: true, hasVertexColors }
    : { kind: 'standard-points', hasFaces: false, hasVertexColors }
}

/**
 * Pass the classification of the same bytes supplied to PLYLoader. Face colors
 * and UVs can make its triangle mesh non-indexed. The one-argument call remains
 * valid, but a missing index now yields unknown rather than unproven points.
 */
export function classifyPlyGeometry(geometry: BufferGeometry, context?: PlyHeaderClassification): PlyGeometryClassification {
  const kind = geometry.index || context?.kind === 'standard-mesh' ? 'mesh'
    : context?.kind === 'standard-points' ? 'points' : 'unknown'
  return {
    kind,
    hasVertexColors: Boolean(geometry.getAttribute('color')),
  }
}

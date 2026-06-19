import type { BufferGeometry } from 'three'

export type PlyHeaderClassification =
  | { kind: 'gaussian'; hasFaces: false; hasVertexColors: false }
  | { kind: 'standard-mesh'; hasFaces: true; hasVertexColors: boolean }
  | { kind: 'standard-points'; hasFaces: false; hasVertexColors: boolean }

export type PlyGeometryClassification =
  | { kind: 'mesh'; hasVertexColors: boolean }
  | { kind: 'points'; hasVertexColors: boolean }

const GAUSSIAN_MARKERS = ['property float f_dc_0', 'property float scale_0', 'property float rot_0']
const COLOR_PROPERTIES = [
  ['property uchar red', 'property uchar green', 'property uchar blue'],
  ['property uint8 red', 'property uint8 green', 'property uint8 blue'],
  ['property float red', 'property float green', 'property float blue'],
]

export function classifyPlyHeader(source: string): PlyHeaderClassification {
  const header = source.slice(0, resolveHeaderEnd(source)).toLowerCase()
  const hasGaussianMarkers = GAUSSIAN_MARKERS.every((marker) => header.includes(marker))

  if (hasGaussianMarkers) {
    return { kind: 'gaussian', hasFaces: false, hasVertexColors: false }
  }

  const hasFaces = /(?:^|\n)element\s+face\s+[1-9]\d*/.test(header)
  const hasVertexColors = COLOR_PROPERTIES.some((properties) => properties.every((property) => header.includes(property)))

  return hasFaces
    ? { kind: 'standard-mesh', hasFaces: true, hasVertexColors }
    : { kind: 'standard-points', hasFaces: false, hasVertexColors }
}

export function classifyPlyGeometry(geometry: BufferGeometry): PlyGeometryClassification {
  return {
    kind: geometry.index ? 'mesh' : 'points',
    hasVertexColors: Boolean(geometry.getAttribute('color')),
  }
}

function resolveHeaderEnd(source: string): number {
  const endHeaderIndex = source.toLowerCase().indexOf('end_header')
  if (endHeaderIndex === -1) return source.length
  return endHeaderIndex + 'end_header'.length
}

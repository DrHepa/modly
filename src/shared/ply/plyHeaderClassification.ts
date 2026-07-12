export const PLY_KINDS = ['gaussian', 'mesh', 'points', 'unknown'] as const

export type PlyKind = typeof PLY_KINDS[number]

export interface PlyHeaderClassification {
  plyKind: PlyKind
  hasFaces: boolean
  hasVertexColors: boolean
}

const GAUSSIAN_MARKERS = ['property float f_dc_0', 'property float scale_0', 'property float rot_0']
const COLOR_PROPERTIES = [
  ['property uchar red', 'property uchar green', 'property uchar blue'],
  ['property uint8 red', 'property uint8 green', 'property uint8 blue'],
  ['property float red', 'property float green', 'property float blue'],
]

export function classifyPlyHeader(source: string): PlyHeaderClassification {
  const header = slicePlyHeader(source)
  if (!header.startsWith('ply')) {
    return { plyKind: 'unknown', hasFaces: false, hasVertexColors: false }
  }

  const hasGaussianMarkers = GAUSSIAN_MARKERS.every((marker) => header.includes(marker))
  if (hasGaussianMarkers) {
    return { plyKind: 'gaussian', hasFaces: false, hasVertexColors: false }
  }

  const hasFaces = /(?:^|\n)element\s+face\s+[1-9]\d*/.test(header)
  const hasVertexColors = COLOR_PROPERTIES.some((properties) => properties.every((property) => header.includes(property)))

  return {
    plyKind: hasFaces ? 'mesh' : 'points',
    hasFaces,
    hasVertexColors,
  }
}

function slicePlyHeader(source: string): string {
  const normalized = source.toLowerCase()
  const endHeaderIndex = normalized.indexOf('end_header')
  const header = endHeaderIndex === -1 ? normalized : normalized.slice(0, endHeaderIndex + 'end_header'.length)
  return header.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimStart()
}

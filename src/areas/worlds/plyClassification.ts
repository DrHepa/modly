import type { BufferGeometry } from 'three'
import { classifyPlyHeader as classifySharedPlyHeader } from '../../shared/ply/plyHeaderClassification.ts'
import type { PlyHeaderClassification } from '../../shared/ply/plyHeaderClassification.ts'

export type PlyGeometryClassification =
  | { kind: 'mesh'; hasVertexColors: boolean }
  | { kind: 'points'; hasVertexColors: boolean }

export function classifyPlyHeader(source: string): PlyHeaderClassification {
  return classifySharedPlyHeader(source)
}

export function classifyPlyGeometry(geometry: BufferGeometry): PlyGeometryClassification {
  return {
    kind: geometry.index ? 'mesh' : 'points',
    hasVertexColors: Boolean(geometry.getAttribute('color')),
  }
}

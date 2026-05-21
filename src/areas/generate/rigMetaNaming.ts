import type { RigBoneId } from './rigSkeleton.ts'

export type RigMetaNamingSource = 'semantic_candidates' | 'humanoid_contract'

export interface RigMetaNamingEntry {
  label: string
  source: RigMetaNamingSource
}

export type RigMetaNamingMap = Record<RigBoneId, RigMetaNamingEntry>

export interface NormalizeRigMetaNamingOptions {
  expectedSourceWorkspacePath?: string
}

export interface NormalizeRigMetaNamingResult {
  valid: boolean
  namingByBoneId: RigMetaNamingMap
  warnings: string[]
}

const MESH_EXTENSION_PATTERN = /\.(glb|gltf)$/i
const SAFE_WORKSPACE_SEGMENT_PATTERN = /^[^/\\]+$/
const SUPPORTED_SCHEMA_VALUES = new Set([
  'modly.rigmeta',
  'modly.unirig.rigmeta',
  'unirig.rigmeta',
])

export function createRigMetaWorkspacePath(sourceWorkspacePath: string): string | null {
  if (!isSafeRelativeWorkspacePath(sourceWorkspacePath)) return null
  if (!MESH_EXTENSION_PATTERN.test(sourceWorkspacePath)) return null
  return sourceWorkspacePath.replace(MESH_EXTENSION_PATTERN, '.rigmeta.json')
}

export function normalizeRigMetaNaming(
  rigMeta: unknown,
  options: NormalizeRigMetaNamingOptions = {},
): NormalizeRigMetaNamingResult {
  if (!isRecord(rigMeta)) {
    return {
      valid: false,
      namingByBoneId: {},
      warnings: ['Rigmeta must be an object.'],
    }
  }

  const warnings: string[] = []
  const namingByBoneId: RigMetaNamingMap = {}

  collectSchemaWarnings(rigMeta, warnings)
  collectSourceMismatchWarnings(rigMeta, options, warnings)

  const candidateStats = collectNamingRecord(
    rigMeta.semantic_candidates,
    'semantic_candidates',
    namingByBoneId,
  )
  const humanoidStats = collectHumanoidContract(rigMeta.humanoid_contract, namingByBoneId)
  const invalidCount = candidateStats.invalidCount + humanoidStats.invalidCount

  if (invalidCount > 0) {
    warnings.push(`Rigmeta naming was partially loaded; ${invalidCount} candidate label(s) were ignored.`)
  }
  if (Object.keys(namingByBoneId).length === 0) {
    warnings.push('Rigmeta did not contain supported naming entries.')
  }

  return {
    valid: true,
    namingByBoneId,
    warnings,
  }
}

function collectSchemaWarnings(rigMeta: Record<string, unknown>, warnings: string[]): void {
  const schema = rigMeta.schema ?? rigMeta.kind
  if (schema !== undefined && (typeof schema !== 'string' || !SUPPORTED_SCHEMA_VALUES.has(schema))) {
    warnings.push('Rigmeta schema is unsupported; known naming fields will be loaded defensively.')
  }
}

function collectSourceMismatchWarnings(
  rigMeta: Record<string, unknown>,
  options: NormalizeRigMetaNamingOptions,
  warnings: string[],
): void {
  if (!options.expectedSourceWorkspacePath) return

  const sourcePath = readSourceWorkspacePath(rigMeta.source)
  if (sourcePath && sourcePath !== options.expectedSourceWorkspacePath) {
    warnings.push(`Rigmeta source mismatch: expected "${options.expectedSourceWorkspacePath}" but found "${sourcePath}".`)
  }
}

function collectHumanoidContract(value: unknown, output: RigMetaNamingMap): { invalidCount: number } {
  if (!isRecord(value)) return { invalidCount: 0 }
  const bones = isRecord(value.bones) ? value.bones : value
  return collectNamingRecord(bones, 'humanoid_contract', output)
}

function collectNamingRecord(
  value: unknown,
  source: RigMetaNamingSource,
  output: RigMetaNamingMap,
): { invalidCount: number } {
  if (!isRecord(value)) return { invalidCount: 0 }

  let invalidCount = 0
  for (const [boneId, candidate] of Object.entries(value)) {
    const label = extractLabel(candidate)
    if (!label) {
      invalidCount += 1
      continue
    }
    output[boneId] = { label, source }
  }
  return { invalidCount }
}

function extractLabel(candidate: unknown): string | null {
  if (typeof candidate === 'string') return normalizeLabel(candidate)
  if (!isRecord(candidate)) return null

  const labelFields = ['label', 'display_name', 'semantic_label', 'name', 'resolved_label']
  for (const field of labelFields) {
    const label = normalizeLabel(candidate[field])
    if (label) return label
  }
  return null
}

function normalizeLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const label = value.trim()
  return label.length > 0 ? label : null
}

function readSourceWorkspacePath(source: unknown): string | null {
  if (!isRecord(source)) return null
  return typeof source.workspacePath === 'string' ? source.workspacePath : null
}

function isSafeRelativeWorkspacePath(workspacePath: string): boolean {
  if (workspacePath.trim() !== workspacePath || workspacePath.length === 0) return false
  if (workspacePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(workspacePath)) return false
  if (workspacePath.includes('\\')) return false

  const segments = workspacePath.split('/')
  return segments.every((segment) => (
    segment.length > 0 && segment !== '.' && segment !== '..' && SAFE_WORKSPACE_SEGMENT_PATTERN.test(segment)
  ))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

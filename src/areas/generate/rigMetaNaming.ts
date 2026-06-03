import type { RigBoneId, RigSkeletonSummary } from './rigSkeleton.ts'

export type RigMetaNamingSource = 'semantic_candidates' | 'humanoid_contract' | 'humanoid_draft' | 'humanoid_promotion'

export interface RigMetaNamingEntry {
  label: string
  source: RigMetaNamingSource
}

export type RigMetaNamingMap = Record<RigBoneId, RigMetaNamingEntry>

export interface NormalizeRigMetaNamingOptions {
  expectedSourceWorkspacePath?: string
  summary?: RigSkeletonSummary
}

export interface NormalizeRigMetaNamingResult {
  valid: boolean
  namingByBoneId: RigMetaNamingMap
  warnings: string[]
}

export interface RigMetaNamingTranslationSource {
  source: 'embedded_rigmeta' | 'humanoid_contract' | 'humanoid_draft' | 'humanoid_promotion'
  roleMap: unknown
}

export interface TranslateHumanoidAssignmentsToRigMetaNamingResult {
  namingByBoneId: RigMetaNamingMap
  diagnostics: string[]
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
    resolveSemanticCandidatesNamingRecord(rigMeta.semantic_candidates),
    'semantic_candidates',
    namingByBoneId,
  )
  const humanoidStats = collectHumanoidContract(rigMeta.humanoid_contract, namingByBoneId, warnings, options.summary, rigMeta)
  const draftStats = collectHumanoidDraft(rigMeta.humanoid_draft, namingByBoneId, warnings, options.summary)
  const invalidCount = candidateStats.invalidCount + humanoidStats.invalidCount + draftStats.invalidCount

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

function collectHumanoidContract(
  value: unknown,
  output: RigMetaNamingMap,
  warnings: string[],
  summary?: RigSkeletonSummary,
  rigMeta?: Record<string, unknown>,
): { invalidCount: number } {
  if (!isRecord(value)) return { invalidCount: 0 }

  if (isRecord(value.required_roles)) {
    if (!isTrustedHumanoidRequiredRolesContract(value, rigMeta)) return { invalidCount: 0 }

    if (summary?.hasRig) {
      const translation = translateHumanoidAssignmentsToRigMetaNaming({
        summary,
        sources: [{ source: 'humanoid_contract', roleMap: { roles: value.required_roles } }],
      })
      Object.assign(output, translation.namingByBoneId)
      warnings.push(...translation.diagnostics)
    }
    return { invalidCount: 0 }
  }

  const bones = isRecord(value.bones) ? value.bones : value
  return collectNamingRecord(bones, 'humanoid_contract', output)
}

function isTrustedHumanoidRequiredRolesContract(contract: Record<string, unknown>, rigMeta?: Record<string, unknown>): boolean {
  if (contract.schema !== 'modly.humanoid.v1') return false
  if ((contract.humanoid_contract_status ?? rigMeta?.humanoid_contract_status) !== 'trusted') return false
  if (!isRecord(contract.validation) || contract.validation.status !== 'validated') return false

  const trustScope = isRecord(contract.provenance) && isRecord(contract.provenance.trust_scope)
    ? contract.provenance.trust_scope.trusted
    : null
  return Array.isArray(trustScope) && trustScope.includes('required_roles')
}

function collectHumanoidDraft(
  value: unknown,
  output: RigMetaNamingMap,
  warnings: string[],
  summary?: RigSkeletonSummary,
): { invalidCount: number } {
  if (!isRecord(value) || !isRecord(value.assignments) || !isRecord(value.assignments.roles)) {
    return { invalidCount: 0 }
  }

  if (summary?.hasRig) {
    const translation = translateHumanoidAssignmentsToRigMetaNaming({
      summary,
      sources: [{ source: 'embedded_rigmeta', roleMap: value.assignments }],
    })
    Object.assign(output, translation.namingByBoneId)
    warnings.push(...translation.diagnostics)
    return { invalidCount: 0 }
  }

  return collectHumanoidAssignmentNaming(value.assignments, 'humanoid_draft', output)
}

export function createRigMetaNamingFromHumanoidAssignments(
  assignments: unknown,
  source: Extract<RigMetaNamingSource, 'humanoid_draft' | 'humanoid_promotion'> = 'humanoid_draft',
): RigMetaNamingMap {
  const namingByBoneId: RigMetaNamingMap = {}
  collectHumanoidAssignmentNaming(resolveHumanoidRoleRecord(assignments), source, namingByBoneId)
  return namingByBoneId
}

export function translateHumanoidAssignmentsToRigMetaNaming(args: {
  summary: RigSkeletonSummary
  sources: readonly RigMetaNamingTranslationSource[]
}): TranslateHumanoidAssignmentsToRigMetaNamingResult {
  const namingByBoneId: RigMetaNamingMap = {}
  const diagnostics: string[] = []
  const exactBoneIds = new Set(args.summary.bones.map((bone) => bone.boneId))
  const candidateBoneIdsByName = createCandidateBoneIdsByName(args.summary)

  for (const source of args.sources) {
    const roles = resolveHumanoidRoleRecord(source.roleMap)
    if (!roles) continue

    for (const [role, assignment] of Object.entries(roles)) {
      const assignmentIdentifier = extractHumanoidAssignmentBoneId(assignment)
      const label = extractHumanoidAssignmentLabel(role, assignment)
      if (!assignmentIdentifier || !label) continue

      const resolvedBoneId = resolveAssignmentIdentifierToBoneId({
        assignmentIdentifier,
        exactBoneIds,
        candidateBoneIdsByName,
        source: source.source,
        role,
        diagnostics,
      })
      if (!resolvedBoneId) continue

      namingByBoneId[resolvedBoneId] = {
        label,
        source: resolveTranslatedHumanoidNamingSource(source.source),
      }
    }
  }

  return { namingByBoneId, diagnostics }
}

function resolveTranslatedHumanoidNamingSource(source: RigMetaNamingTranslationSource['source']): RigMetaNamingSource {
  if (source === 'humanoid_contract') return 'humanoid_contract'
  if (source === 'humanoid_promotion') return 'humanoid_promotion'
  return 'humanoid_draft'
}

function collectHumanoidAssignmentNaming(
  assignments: unknown,
  source: Extract<RigMetaNamingSource, 'humanoid_draft' | 'humanoid_promotion'>,
  output: RigMetaNamingMap,
): { invalidCount: number } {
  const roles = resolveHumanoidRoleRecord(assignments)
  if (!roles) return { invalidCount: 0 }

  let invalidCount = 0
  for (const [role, assignment] of Object.entries(roles)) {
    const normalizedBoneId = extractHumanoidAssignmentBoneId(assignment)
    const label = extractHumanoidAssignmentLabel(role, assignment)
    if (!normalizedBoneId || !label) {
      invalidCount += 1
      continue
    }
    output[normalizedBoneId as RigBoneId] = { label, source }
  }
  return { invalidCount }
}

function resolveHumanoidRoleRecord(assignments: unknown): Record<string, unknown> | null {
  if (!isRecord(assignments)) return null
  if (isRecord(assignments.roles)) return assignments.roles
  return assignments
}

function createCandidateBoneIdsByName(summary: RigSkeletonSummary): Map<string, RigBoneId[]> {
  const output = new Map<string, RigBoneId[]>()

  for (const bone of summary.bones) {
    appendCandidateBoneId(output, bone.originalName, bone.boneId)
    appendCandidateBoneId(output, bone.label, bone.boneId)
  }

  return output
}

function appendCandidateBoneId(output: Map<string, RigBoneId[]>, rawName: unknown, boneId: RigBoneId): void {
  const normalizedName = normalizeLabel(rawName)
  if (!normalizedName) return
  const existing = output.get(normalizedName)
  if (existing) {
    if (!existing.includes(boneId)) existing.push(boneId)
    return
  }
  output.set(normalizedName, [boneId])
}

function resolveAssignmentIdentifierToBoneId(args: {
  assignmentIdentifier: string
  exactBoneIds: ReadonlySet<RigBoneId>
  candidateBoneIdsByName: ReadonlyMap<string, RigBoneId[]>
  source: RigMetaNamingTranslationSource['source']
  role: string
  diagnostics: string[]
}): RigBoneId | null {
  if (args.exactBoneIds.has(args.assignmentIdentifier)) {
    return args.assignmentIdentifier
  }

  const nameMatches = args.candidateBoneIdsByName.get(args.assignmentIdentifier) ?? []
  if (nameMatches.length === 1) return nameMatches[0] ?? null
  if (nameMatches.length > 1) {
    args.diagnostics.push(`${args.source} assignment "${args.role}" with identifier "${args.assignmentIdentifier}" is ambiguous across ${nameMatches.length} runtime bones.`)
    return null
  }

  args.diagnostics.push(`${args.source} assignment "${args.role}" with identifier "${args.assignmentIdentifier}" could not be resolved to a runtime rig bone.`)
  return null
}

function extractHumanoidAssignmentBoneId(assignment: unknown): string | null {
  if (typeof assignment === 'string') return normalizeLabel(assignment)
  if (!isRecord(assignment)) return null
  return normalizeLabel(assignment.boneId)
}

function extractHumanoidAssignmentLabel(role: string, assignment: unknown): string | null {
  if (isRecord(assignment)) {
    const explicitLabel = normalizeLabel(assignment.label)
    if (explicitLabel) return explicitLabel
  }
  return humanizeRoleLabel(role)
}

function resolveSemanticCandidatesNamingRecord(value: unknown): unknown {
  if (!isRecord(value)) return value
  return isRecord(value.roles) ? value.roles : value
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

function humanizeRoleLabel(role: string): string | null {
  const normalized = normalizeLabel(role)
  if (!normalized) return null
  return normalized
    .split(/[_-]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
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

import type { ArtifactRef, ArtifactProvenance } from '../../shared/types/artifacts.ts'

export type KimodoMotionNodeId = 'text-to-motion-preview' | 'animate-rigged-mesh'

export interface KimodoMotionDiagnostics {
  runtimeStatus: string | null
  retargetStatus: string | null
  solverStatus: string | null
  basisStatus: string | null
  rootMotionStatus: string | null
  animationMappingStatus: string | null
  stabilizationStatus: string | null
  visualQualityStatus: string | null
  sourceKind: string | null
  mappingConfidence: string | null
  sourceAuthority?: string
  sourceContract?: string
  bvhRole?: string
  fallbackDiagnostics?: string[]
  retargetErrorCode: string | null
  retargetErrorAliases: string[]
  retargetErrorMessage: string | null
  warnings: string[]
  raw: Record<string, unknown>
}

export interface KimodoMotionRetargetSourceContract {
  schema: string
  trusted: boolean
  status?: string
  sidecarPayloadSha256?: string
  sidecarWorkspacePath?: string
  sourceMeshWorkspacePath?: string
  sourceMeshSha256?: string
}

export interface KimodoMotionRetargetSourceBone {
  sourceBoneId: string
  label: string
  rawLabel: string
  parentSourceBoneId?: string
  role?: string
  chain?: string
}

export interface KimodoMotionRetargetTargetTrack {
  targetNodeName: string
  targetNodeIndex: number
  targetRole?: string
  rotations: Array<{ timeSeconds: number, x: number, y: number, z: number, w: number }>
}

export interface KimodoMotionRetargetOmittedChannel {
  targetNodeName: string
  channel: string
  reason: string
}

export interface KimodoMotionRetargetCoverageBucket {
  status?: string
  reason?: string
  coveredRoles?: string[]
  expectedRoles?: string[]
}

export interface KimodoMotionRetargetCoverage {
  rootTranslation?: KimodoMotionRetargetCoverageBucket
  body?: KimodoMotionRetargetCoverageBucket
  hands?: KimodoMotionRetargetCoverageBucket
  fingers?: KimodoMotionRetargetCoverageBucket
}

export interface KimodoMotionRetargetFutureTransformTrack {
  targetNodeName: string
  targetNodeIndex: number
  targetRole?: string
  translations?: Array<{ timeSeconds: number, x: number, y: number, z: number }>
  scales?: Array<{ timeSeconds: number, x: number, y: number, z: number }>
}

export type KimodoMotionRetargetState = {
  status: 'parsed' | 'invalid'
  diagnostics: string[]
  clipName?: string
  sourceAuthority?: string
  bvhRole?: string
  fallbackDiagnostics?: string[]
  sourceContract?: KimodoMotionRetargetSourceContract
  mappingStatus?: string
  mappingConfidence?: string
  fps?: number
  durationSeconds?: number
  timeSemantics?: string
  sourceBones: KimodoMotionRetargetSourceBone[]
  targetTracks: KimodoMotionRetargetTargetTrack[]
  omittedChannels?: KimodoMotionRetargetOmittedChannel[]
  coverage?: KimodoMotionRetargetCoverage
  futureTransformTracks?: KimodoMotionRetargetFutureTransformTrack[]
}

export interface KimodoMotionArtifact {
  extensionId: 'kimodo-soma-rp'
  nodeId: KimodoMotionNodeId
  workflowId?: string
  workflowNodeId?: string
  sourceMeshWorkspacePath?: string
  previewGlbWorkspacePath?: string
  animatedGlbWorkspacePath?: string
  bundleWorkspacePath: string
  metadataWorkspacePath: string
  canonicalMotionArtifactWorkspacePath?: string
  motionNpzWorkspacePath?: string
  motionBvhWorkspacePath?: string
  diagnostics: KimodoMotionDiagnostics
  motionRetarget?: KimodoMotionRetargetState
}

export type KimodoMotionAdapterResult =
  | { ok: true; artifact: KimodoMotionArtifact }
  | { ok: false; errors: string[] }

export interface NormalizeKimodoMotionArtifactInput {
  artifact: ArtifactRef
  bundleWorkspacePath: string
  metadataWorkspacePath: string
  metadata: Record<string, unknown>
  sourceMeshWorkspacePath?: string
}

const KIMODO_EXTENSION_ID = 'kimodo-soma-rp'
const KIMODO_NODE_IDS = new Set<KimodoMotionNodeId>(['text-to-motion-preview', 'animate-rigged-mesh'])

export function normalizeKimodoMotionArtifact(input: NormalizeKimodoMotionArtifactInput): KimodoMotionAdapterResult {
  const errors: string[] = []
  const bundleWorkspacePath = normalizeWorkspaceRelativePath(input.bundleWorkspacePath)
  const metadataWorkspacePath = normalizeWorkspaceRelativePath(input.metadataWorkspacePath)
  const provenance = normalizeKimodoProvenance(input.artifact.provenance)
  const artifactWorkspacePath = normalizeWorkspaceRelativePath(input.artifact.legacy?.filePath ?? input.artifact.uri)

  if (!bundleWorkspacePath || !metadataWorkspacePath) {
    return { ok: false, errors: ['Kimodo bundle and metadata paths must be workspace-relative.'] }
  }
  if (!metadataWorkspacePath.startsWith(`${bundleWorkspacePath}/`)) {
    return { ok: false, errors: ['Kimodo metadata path must stay inside the bundle workspace path.'] }
  }
  const artifactEntries = collectKimodoBundleArtifactEntries(input.metadata)
  const normalizedArtifacts = new Set<string>()
  const animatedArtifactEntries = new Set<string>()

  for (const entry of artifactEntries) {
    const normalized = resolveBundleWorkspacePath(bundleWorkspacePath, entry.path)
    if (!normalized) {
      errors.push(`Kimodo metadata path must stay workspace-relative inside the bundle: ${entry.path}`)
      continue
    }
    normalizedArtifacts.add(normalized)
    if (entry.animatedOutput) animatedArtifactEntries.add(normalized)
  }

  const fallbackAnimatedGlbWorkspacePath = resolveOptionalBundlePath({
    bundleWorkspacePath,
    value: input.metadata.animated_artifact,
    errors,
  })
  const fallbackPreviewGlbWorkspacePath = resolveOptionalBundlePath({
    bundleWorkspacePath,
    value: input.metadata.preview_artifact,
    errors,
  })

  const fallbackContract = provenance
    ? undefined
    : validateKimodoFallbackContract({
      metadata: input.metadata,
      artifactWorkspacePath,
      animatedArtifactWorkspacePath: fallbackAnimatedGlbWorkspacePath,
      animatedArtifactEntries,
      errors,
    })

  if (!provenance && !fallbackContract) {
    return { ok: false, errors: errors.length > 0 ? errors : ['Workflow artifact provenance is not a supported Kimodo motion node.'] }
  }

  const canonicalMotionArtifactWorkspacePath = resolveOptionalBundlePath({
    bundleWorkspacePath,
    value: input.metadata.canonical_motion_artifact,
    errors,
  })
  const topLevelMotionBvhWorkspacePath = resolveOptionalBundlePath({
    bundleWorkspacePath,
    value: input.metadata.motion_bvh_artifact,
    errors,
  })
  const diagnosticsMotionBvhWorkspacePath = topLevelMotionBvhWorkspacePath
    ?? resolveOptionalBundlePath({
      bundleWorkspacePath,
      value: readDiagnosticsValue(input.metadata, 'bvh_path'),
      errors,
      onInvalid: 'ignore',
      normalizedArtifacts,
    })
  const motionBvhWorkspacePath = topLevelMotionBvhWorkspacePath
    ?? diagnosticsMotionBvhWorkspacePath
    ?? resolveOptionalBundlePath({
      bundleWorkspacePath,
      value: undefined,
      fallbackFileName: 'motion.bvh',
      errors,
      normalizedArtifacts,
    })

  if (errors.length > 0) return { ok: false, errors }

  const previewGlbWorkspacePath = fallbackPreviewGlbWorkspacePath
    ?? resolvePreferredWorkspacePath({
      artifact: input.artifact,
      bundleWorkspacePath,
      preferredFileNames: ['preview.glb'],
      normalizedArtifacts,
    })
  const animatedGlbWorkspacePath = fallbackAnimatedGlbWorkspacePath
    ?? resolvePreferredWorkspacePath({
      artifact: input.artifact,
      bundleWorkspacePath,
      preferredFileNames: ['animated.glb'],
      normalizedArtifacts,
    })
  const motionNpzWorkspacePath = canonicalMotionArtifactWorkspacePath
    ?? resolvePreferredWorkspacePath({
      artifact: undefined,
      bundleWorkspacePath,
      preferredFileNames: ['motion.npz'],
      normalizedArtifacts,
    })

  const raw = structuredClone(input.metadata)
  const motionRetarget = parseKimodoMotionRetarget(input.metadata, asOptionalString(input.metadata.clip_name), bundleWorkspacePath)
  const warnings = normalizeStringList(input.metadata.warnings)
  if (motionRetarget?.status === 'invalid') warnings.push(...motionRetarget.diagnostics)

  return {
    ok: true,
    artifact: {
      extensionId: KIMODO_EXTENSION_ID,
      nodeId: provenance?.extensionNodeId ?? fallbackContract!.nodeId,
      ...(provenance?.workflowId !== undefined ? { workflowId: provenance.workflowId } : {}),
      ...(provenance?.workflowNodeId !== undefined ? { workflowNodeId: provenance.workflowNodeId } : {}),
      ...(input.sourceMeshWorkspacePath !== undefined ? { sourceMeshWorkspacePath: input.sourceMeshWorkspacePath } : {}),
      ...(previewGlbWorkspacePath !== undefined ? { previewGlbWorkspacePath } : {}),
      ...(animatedGlbWorkspacePath !== undefined ? { animatedGlbWorkspacePath } : {}),
      bundleWorkspacePath,
      metadataWorkspacePath,
      ...(canonicalMotionArtifactWorkspacePath !== undefined ? { canonicalMotionArtifactWorkspacePath } : {}),
      ...(motionNpzWorkspacePath !== undefined ? { motionNpzWorkspacePath } : {}),
      ...(motionBvhWorkspacePath !== undefined ? { motionBvhWorkspacePath } : {}),
      ...(motionRetarget ? { motionRetarget } : {}),
      diagnostics: {
        runtimeStatus: asOptionalString(input.metadata.runtime_status),
        retargetStatus: asOptionalString(input.metadata.retarget_status),
        solverStatus: asOptionalString(input.metadata.solver_status),
        basisStatus: asOptionalString(input.metadata.basis_status),
        rootMotionStatus: asOptionalString(input.metadata.root_motion_status),
        animationMappingStatus: asOptionalString(input.metadata.animation_mapping_status),
        stabilizationStatus: asOptionalString(input.metadata.stabilization_status),
        visualQualityStatus: asOptionalString(input.metadata.visual_quality_status),
        sourceKind: asOptionalString(input.metadata.source_kind),
        mappingConfidence: asOptionalString(input.metadata.mapping_confidence),
        ...(asString(input.metadata.source_authority) ? { sourceAuthority: asString(input.metadata.source_authority) } : {}),
        ...(asString(input.metadata.source_contract) ? { sourceContract: asString(input.metadata.source_contract) } : {}),
        ...(asString(input.metadata.bvh_role) ? { bvhRole: asString(input.metadata.bvh_role) } : {}),
        ...(normalizeStringList(input.metadata.fallback_diagnostics).length > 0 ? { fallbackDiagnostics: normalizeStringList(input.metadata.fallback_diagnostics) } : {}),
        retargetErrorCode: asOptionalString(input.metadata.retarget_error_code),
        retargetErrorAliases: normalizeStringList(input.metadata.retarget_error_aliases),
        retargetErrorMessage: asOptionalString(input.metadata.retarget_error_message),
        warnings,
        raw,
      },
    },
  }
}

function normalizeKimodoProvenance(provenance: ArtifactProvenance | undefined): (ArtifactProvenance & { extensionNodeId: KimodoMotionNodeId }) | undefined {
  if (!provenance || provenance.extensionId !== KIMODO_EXTENSION_ID) return undefined
  if (!provenance.extensionNodeId || !KIMODO_NODE_IDS.has(provenance.extensionNodeId as KimodoMotionNodeId)) return undefined
  return provenance as ArtifactProvenance & { extensionNodeId: KimodoMotionNodeId }
}

function collectKimodoBundleArtifactEntries(metadata: Record<string, unknown>): Array<{ path: string, animatedOutput: boolean }> {
  return [metadata.artifacts, metadata.bundle_artifacts]
    .flatMap((value) => Array.isArray(value) ? value : [])
    .flatMap((entry) => normalizeKimodoBundleArtifactEntry(entry))
}

function normalizeKimodoBundleArtifactEntry(entry: unknown): Array<{ path: string, animatedOutput: boolean }> {
  if (typeof entry === 'string') {
    return [{ path: entry, animatedOutput: entry.replace(/\\/g, '/').split('/').at(-1) === 'animated.glb' }]
  }
  if (!entry || typeof entry !== 'object') return []

  const record = entry as Record<string, unknown>
  const path = [record.path, record.workspace_path, record.workspacePath, record.file_path, record.filePath, record.artifact]
    .find((value) => typeof value === 'string')
  if (typeof path !== 'string') return []

  const animatedOutput = [record.role, record.kind, record.type, record.output]
    .filter((value): value is string => typeof value === 'string')
    .some((value) => /animated/.test(value.toLowerCase()))
    || path.replace(/\\/g, '/').split('/').at(-1) === 'animated.glb'

  return [{ path, animatedOutput }]
}

function validateKimodoFallbackContract(args: {
  metadata: Record<string, unknown>
  artifactWorkspacePath: string | undefined
  animatedArtifactWorkspacePath: string | undefined
  animatedArtifactEntries: ReadonlySet<string>
  errors: string[]
}): { nodeId: KimodoMotionNodeId } | undefined {
  if (args.metadata.extension_id !== KIMODO_EXTENSION_ID) return undefined
  if (args.metadata.node_id !== 'animate-rigged-mesh') return undefined
  if (typeof args.metadata.contract_version !== 'string' || args.metadata.contract_version.trim().length === 0) return undefined
  if (!args.artifactWorkspacePath) return undefined

  const selectedMatchesAnimatedArtifact = args.animatedArtifactWorkspacePath === args.artifactWorkspacePath
  const selectedMatchesAnimatedEntry = args.animatedArtifactEntries.has(args.artifactWorkspacePath)
  if (!selectedMatchesAnimatedArtifact && !selectedMatchesAnimatedEntry) return undefined

  return { nodeId: 'animate-rigged-mesh' }
}

function parseKimodoMotionRetarget(metadata: Record<string, unknown>, clipName: string | null, bundleWorkspacePath: string): KimodoMotionRetargetState | undefined {
  const rawBlock = metadata.kimodo_motion_retarget
  if (!rawBlock || typeof rawBlock !== 'object' || Array.isArray(rawBlock)) return undefined

  const block = rawBlock as Record<string, unknown>
  const diagnostics: string[] = []
  const sourceBones = normalizeKimodoSourceBones(block.source_bones, diagnostics)
  const sourceContract = normalizeKimodoSourceContract(block.source_contract, diagnostics, bundleWorkspacePath)
  const sourceAuthority = asString(block.source_authority)
  const bvhRole = asString(block.bvh_role)
  const fallbackDiagnostics = normalizeStringList(block.fallback_diagnostics)
  const mappingStatus = typeof block.mapping_status === 'string' && block.mapping_status.trim().length > 0 ? block.mapping_status : undefined
  const mappingConfidence = typeof block.mapping_confidence === 'string' && block.mapping_confidence.trim().length > 0 ? block.mapping_confidence : undefined
  const fps = asFinitePositiveNumber(block.fps)
  const durationSeconds = asFinitePositiveNumber(block.duration_seconds)
  const timeSemantics = typeof block.time_semantics === 'string' && block.time_semantics.trim().length > 0 ? block.time_semantics : 'seconds'
  const targetTracks = normalizeKimodoTargetTracks(block.target_tracks, diagnostics)
  const solverCoverage = normalizeKimodoSolverCoverage(block.solver_export_contract)
  const omittedChannels = [
    ...normalizeKimodoOmittedChannels(block.omitted_channels, diagnostics),
    ...normalizeKimodoSolverOmissions(block.solver_export_contract),
  ]
  const coverage = normalizeKimodoCoverage(block.coverage, diagnostics) ?? solverCoverage
  const futureTransformTracks = normalizeKimodoFutureTransformTracks(block.transform_tracks, diagnostics)

  if (block.schema !== 'kimodo.motion-retarget.v1') diagnostics.push('Kimodo motion retarget schema must be "kimodo.motion-retarget.v1".')
  if (block.contract_version !== 1) diagnostics.push('Kimodo motion retarget contract version must be 1.')
  if (!mappingStatus) diagnostics.push('Kimodo motion retarget mapping_status must be a non-empty string.')
  if (!mappingConfidence) diagnostics.push('Kimodo motion retarget mapping_confidence must be a non-empty string.')
  if (fps === undefined) diagnostics.push('Kimodo motion retarget fps must be a positive number.')
  if (durationSeconds === undefined) diagnostics.push('Kimodo motion retarget duration_seconds must be a positive number.')

  if (diagnostics.length > 0) {
    return {
      status: 'invalid',
      diagnostics,
      ...(clipName ? { clipName } : {}),
      ...(sourceAuthority ? { sourceAuthority } : {}),
      ...(bvhRole ? { bvhRole } : {}),
      ...(fallbackDiagnostics.length > 0 ? { fallbackDiagnostics } : {}),
      ...(sourceContract ? { sourceContract } : {}),
      ...(mappingStatus ? { mappingStatus } : {}),
      ...(mappingConfidence ? { mappingConfidence } : {}),
      ...(fps !== undefined ? { fps } : {}),
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      timeSemantics,
      sourceBones,
      targetTracks: [],
      ...(omittedChannels.length > 0 ? { omittedChannels } : {}),
      ...(coverage ? { coverage } : {}),
      ...(futureTransformTracks.length > 0 ? { futureTransformTracks } : {}),
    }
  }

  return {
    status: 'parsed',
    diagnostics: [],
    clipName: clipName ?? 'Kimodo Motion',
    ...(sourceAuthority ? { sourceAuthority } : {}),
    ...(bvhRole ? { bvhRole } : {}),
    ...(fallbackDiagnostics.length > 0 ? { fallbackDiagnostics } : {}),
    sourceContract: sourceContract!,
    mappingStatus: mappingStatus!,
    mappingConfidence: mappingConfidence!,
    fps: fps!,
    durationSeconds: durationSeconds!,
    timeSemantics,
    sourceBones,
    targetTracks,
    ...(omittedChannels.length > 0 ? { omittedChannels } : {}),
    ...(coverage ? { coverage } : {}),
    ...(futureTransformTracks.length > 0 ? { futureTransformTracks } : {}),
  }
}

function normalizeKimodoSourceContract(value: unknown, diagnostics: string[], bundleWorkspacePath: string): KimodoMotionRetargetSourceContract | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push('Kimodo motion retarget source_contract is invalid.')
    return undefined
  }

  const record = value as Record<string, unknown>
  if (typeof record.schema !== 'string' || typeof record.trusted !== 'boolean') {
    diagnostics.push('Kimodo motion retarget source_contract must include schema and trusted.')
    return undefined
  }

  return {
    schema: record.schema,
    trusted: record.trusted,
    ...(typeof record.status === 'string' && record.status.trim().length > 0 ? { status: record.status } : {}),
    ...(typeof record.sidecar_payload_sha256 === 'string' ? { sidecarPayloadSha256: record.sidecar_payload_sha256 } : {}),
    ...normalizeOptionalWorkspaceEvidence({ key: 'sidecarWorkspacePath', value: record.sidecar_workspace_path ?? record.sidecarWorkspacePath ?? record.path, bundleWorkspacePath }),
    ...normalizeOptionalWorkspaceEvidence({ key: 'sourceMeshWorkspacePath', value: record.source_mesh_workspace_path ?? record.sourceMeshWorkspacePath, bundleWorkspacePath }),
    ...(typeof record.source_mesh_sha256 === 'string' ? { sourceMeshSha256: record.source_mesh_sha256 } : {}),
  }
}

function normalizeOptionalWorkspaceEvidence<const K extends string>({
  key,
  value,
  bundleWorkspacePath,
}: {
  key: K
  value: unknown
  bundleWorkspacePath: string
}): { [P in K]?: string } {
  if (typeof value !== 'string') return {}
  const normalized = normalizeWorkspaceEvidencePath(value, bundleWorkspacePath)
  return normalized ? { [key]: normalized } as { [P in K]?: string } : {}
}

function normalizeWorkspaceEvidencePath(value: string, bundleWorkspacePath: string): string | undefined {
  const direct = normalizeWorkspaceRelativePath(value)
  if (direct) return direct.includes('/') ? direct : `${bundleWorkspacePath}/${direct}`

  const text = value.replace(/\\/g, '/').trim()
  const workspaceMarker = '/workspace/'
  const markerIndex = text.indexOf(workspaceMarker)
  if (markerIndex < 0) return undefined
  return normalizeWorkspaceRelativePath(text.slice(markerIndex + workspaceMarker.length))
}

function normalizeKimodoOmittedChannels(value: unknown, diagnostics: string[]): KimodoMotionRetargetOmittedChannel[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    diagnostics.push('Kimodo motion retarget omitted_channels must be an array when present.')
    return []
  }

  const channels: KimodoMotionRetargetOmittedChannel[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      diagnostics.push('Kimodo motion retarget omitted_channels entries must be objects.')
      return []
    }
    const record = entry as Record<string, unknown>
    const targetNodeName = typeof record.target_node_name === 'string' ? record.target_node_name.trim() : ''
    const channel = typeof record.channel === 'string' ? record.channel.trim() : ''
    const reason = typeof record.reason === 'string' ? record.reason.trim() : ''
    if (!targetNodeName || !channel || !reason) {
      diagnostics.push('Kimodo motion retarget omitted_channels entries must include target_node_name, channel, and reason.')
      return []
    }
    channels.push({ targetNodeName, channel, reason })
  }
  return channels
}

function normalizeKimodoCoverage(value: unknown, diagnostics: string[]): KimodoMotionRetargetCoverage | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push('Kimodo motion retarget coverage must be an object when present.')
    return undefined
  }
  const record = value as Record<string, unknown>
  const coverage: KimodoMotionRetargetCoverage = {}
  for (const [rawKey, outputKey] of [
    ['root_translation', 'rootTranslation'],
    ['body', 'body'],
    ['hands', 'hands'],
    ['fingers', 'fingers'],
  ] as const) {
    const bucket = normalizeKimodoCoverageBucket(record[rawKey], diagnostics, rawKey)
    if (bucket) coverage[outputKey] = bucket
  }
  return Object.keys(coverage).length > 0 ? coverage : undefined
}

function normalizeKimodoSolverCoverage(value: unknown): KimodoMotionRetargetCoverage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const coverage: KimodoMotionRetargetCoverage = {}

  const rootMotion = asRecord(record.root_motion)
  if (rootMotion) {
    coverage.rootTranslation = { status: rootMotion.status === 'emitted' ? 'complete' : asString(rootMotion.status) ?? 'missing', ...(typeof rootMotion.reason === 'string' ? { reason: rootMotion.reason } : {}) }
  }

  const bodyChains = asRecord(record.body_chains)
  const required = asRecord(bodyChains?.required)
  if (required) {
    const expectedRoles = Object.keys(required)
    const partialReasons: string[] = []
    const coveredRoles = expectedRoles.filter((role) => {
      const value = required[role]
      if (typeof value !== 'string') return false
      const [covered, expected] = value.split('/').map((part) => Number(part))
      const complete = Number.isFinite(covered) && Number.isFinite(expected) && expected > 0 && covered >= expected
      if (!complete) partialReasons.push(`${role} coverage ${value}`)
      return complete
    })
    coverage.body = {
      status: partialReasons.length === 0 ? 'complete' : 'partial',
      coveredRoles,
      expectedRoles,
      ...(partialReasons.length > 0 ? { reason: partialReasons.join('; ') } : {}),
    }
  }

  const hands = asRecord(record.hands)
  if (hands) {
    const expectedRoles = ['left_hand', 'right_hand']
    const coveredRoles = [hands.left, hands.right]
      .map((bucket, index) => asRecord(bucket)?.status === 'emitted' ? expectedRoles[index] : undefined)
      .filter((role): role is string => typeof role === 'string')
    coverage.hands = { status: coveredRoles.length === expectedRoles.length ? 'complete' : 'partial', coveredRoles, expectedRoles }
  }

  const fingers = asRecord(record.fingers)
  if (fingers) {
    const expectedRoles = ['left_fingers', 'right_fingers']
    const coveredRoles = [fingers.left, fingers.right]
      .map((bucket, index) => asRecord(bucket)?.status === 'emitted' ? expectedRoles[index] : undefined)
      .filter((role): role is string => typeof role === 'string')
    const reasons = [fingers.left, fingers.right]
      .flatMap((bucket) => typeof asRecord(bucket)?.reason === 'string' ? [asRecord(bucket)!.reason as string] : [])
    coverage.fingers = {
      status: coveredRoles.length === expectedRoles.length ? 'complete' : (coveredRoles.length > 0 ? 'partial' : 'omitted'),
      coveredRoles,
      expectedRoles,
      ...(reasons.length > 0 ? { reason: dedupeStrings(reasons).join('; ') } : {}),
    }
  }

  return Object.keys(coverage).length > 0 ? coverage : undefined
}

function normalizeKimodoSolverOmissions(value: unknown): KimodoMotionRetargetOmittedChannel[] {
  const record = asRecord(value)
  if (!record) return []
  const explicitOmissions = Array.isArray(record.explicit_omissions) ? record.explicit_omissions : []
  const omissions = explicitOmissions.flatMap((entry) => {
    const omission = asRecord(entry)
    const channel = asString(omission?.path)
    const reason = asString(omission?.reason)
    return channel && reason ? [{ targetNodeName: '*', channel, reason }] : []
  })
  const basisRestPose = asRecord(record.basis_rest_pose)
  if (asString(basisRestPose?.status)?.toLowerCase() === 'omitted') {
    omissions.push({
      targetNodeName: '*',
      channel: 'basis_rest_pose',
      reason: asString(basisRestPose?.reason) ?? 'Kimodo omitted basis/rest-pose evidence.',
    })
  }
  return omissions
}

function normalizeKimodoCoverageBucket(value: unknown, diagnostics: string[], key: string): KimodoMotionRetargetCoverageBucket | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push(`Kimodo motion retarget coverage.${key} must be an object.`)
    return undefined
  }
  const record = value as Record<string, unknown>
  const hasCoveredRoles = Array.isArray(record.covered_roles)
  const hasExpectedRoles = Array.isArray(record.expected_roles)
  const coveredRoles = normalizeStringList(record.covered_roles)
  const expectedRoles = normalizeStringList(record.expected_roles)
  return {
    ...(typeof record.status === 'string' && record.status.trim().length > 0 ? { status: record.status } : {}),
    ...(typeof record.reason === 'string' && record.reason.trim().length > 0 ? { reason: record.reason } : {}),
    ...(hasCoveredRoles ? { coveredRoles } : {}),
    ...(hasExpectedRoles ? { expectedRoles } : {}),
  }
}

function normalizeKimodoFutureTransformTracks(value: unknown, diagnostics: string[]): KimodoMotionRetargetFutureTransformTrack[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    diagnostics.push('Kimodo motion retarget transform_tracks must be an array when present.')
    return []
  }
  const tracks: KimodoMotionRetargetFutureTransformTrack[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      diagnostics.push('Kimodo motion retarget transform_tracks entries must be objects.')
      return []
    }
    const record = entry as Record<string, unknown>
    const targetNodeName = typeof record.target_node_name === 'string' ? record.target_node_name.trim() : ''
    const targetNodeIndex = typeof record.target_node_index === 'number' && Number.isInteger(record.target_node_index) ? record.target_node_index : undefined
    if (!targetNodeName || targetNodeIndex === undefined) {
      diagnostics.push('Kimodo motion retarget transform_tracks must include target_node_name and integer target_node_index.')
      return []
    }
    const translations = normalizeKimodoVectorSamples(record.translations)
    const scales = normalizeKimodoVectorSamples(record.scales)
    if ((record.translations !== undefined && translations === undefined) || (record.scales !== undefined && scales === undefined)) {
      diagnostics.push(`Kimodo motion retarget transform track "${targetNodeName}" has invalid vector sample data.`)
      return []
    }
    tracks.push({
      targetNodeName,
      targetNodeIndex,
      ...(typeof record.target_role === 'string' && record.target_role.trim().length > 0 ? { targetRole: record.target_role } : {}),
      ...(translations && translations.length > 0 ? { translations } : {}),
      ...(scales && scales.length > 0 ? { scales } : {}),
    })
  }
  return tracks
}

function normalizeKimodoVectorSamples(value: unknown): Array<{ timeSeconds: number, x: number, y: number, z: number }> | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const samples = value.map((sample) => normalizeKimodoVectorSample(sample))
  if (samples.some((sample) => sample === undefined)) return undefined
  return samples as Array<{ timeSeconds: number, x: number, y: number, z: number }>
}

function normalizeKimodoVectorSample(value: unknown): { timeSeconds: number, x: number, y: number, z: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const timeSeconds = asFiniteNumber(record.timeSeconds) ?? asFiniteNumber(record.time_seconds)
  const x = asFiniteNumber(record.x)
  const y = asFiniteNumber(record.y)
  const z = asFiniteNumber(record.z)
  if (timeSeconds === undefined || x === undefined || y === undefined || z === undefined) return undefined
  return { timeSeconds, x, y, z }
}

function normalizeKimodoSourceBones(value: unknown, diagnostics: string[]): KimodoMotionRetargetSourceBone[] {
  if (!Array.isArray(value)) {
    diagnostics.push('Kimodo motion retarget source_bones must be an array.')
    return []
  }

  const bones: KimodoMotionRetargetSourceBone[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      diagnostics.push('Kimodo motion retarget source_bones entries must be objects.')
      return []
    }

    const record = entry as Record<string, unknown>
    if (typeof record.source_bone_id !== 'string' || typeof record.label !== 'string' || typeof record.raw_label !== 'string') {
      diagnostics.push('Kimodo motion retarget source_bones entries must include source_bone_id, label, and raw_label.')
      return []
    }

    bones.push({
      sourceBoneId: record.source_bone_id,
      label: record.label,
      rawLabel: record.raw_label,
      ...(typeof record.parent_source_bone_id === 'string' ? { parentSourceBoneId: record.parent_source_bone_id } : {}),
      ...(typeof record.role === 'string' ? { role: record.role } : {}),
      ...(typeof record.chain === 'string' ? { chain: record.chain } : {}),
    })
  }

  return bones
}

function normalizeKimodoTargetTracks(value: unknown, diagnostics: string[]): KimodoMotionRetargetTargetTrack[] {
  if (!Array.isArray(value) || value.length === 0) {
    diagnostics.push('Kimodo motion retarget target_tracks must be a non-empty array.')
    return []
  }

  const tracks: KimodoMotionRetargetTargetTrack[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      diagnostics.push('Kimodo motion retarget target_tracks entries must be objects.')
      return []
    }

    const record = entry as Record<string, unknown>
    const targetNodeName = typeof record.target_node_name === 'string' ? record.target_node_name.trim() : ''
    const targetNodeIndex = typeof record.target_node_index === 'number' && Number.isInteger(record.target_node_index)
      ? record.target_node_index
      : undefined

    if (!targetNodeName || targetNodeIndex === undefined) {
      diagnostics.push('Kimodo motion retarget target_tracks must include target_node_name and integer target_node_index.')
      return []
    }
    if ('translation' in record || 'translations' in record || 'scale' in record || 'scales' in record) {
      diagnostics.push(`Kimodo motion retarget target track "${targetNodeName}" must remain rotation-only.`)
      return []
    }
    if (!Array.isArray(record.rotations) || record.rotations.length === 0) {
      diagnostics.push(`Kimodo motion retarget target track "${targetNodeName}" must include quaternion rotations.`)
      return []
    }

    const rotations = record.rotations.map((rotation) => normalizeKimodoRotation(rotation))
    if (rotations.some((rotation) => rotation === undefined)) {
      diagnostics.push(`Kimodo motion retarget target track "${targetNodeName}" has invalid quaternion rotation data.`)
      return []
    }

    tracks.push({
      targetNodeName,
      targetNodeIndex,
      ...(typeof record.target_role === 'string' && record.target_role.trim().length > 0 ? { targetRole: record.target_role } : {}),
      rotations: rotations as Array<{ timeSeconds: number, x: number, y: number, z: number, w: number }>,
    })
  }

  return tracks
}

function normalizeKimodoRotation(value: unknown): { timeSeconds: number, x: number, y: number, z: number, w: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const timeSeconds = asFiniteNumber(record.timeSeconds) ?? asFiniteNumber(record.time_seconds)
  const x = asFiniteNumber(record.x)
  const y = asFiniteNumber(record.y)
  const z = asFiniteNumber(record.z)
  const w = asFiniteNumber(record.w)
  if (timeSeconds === undefined || x === undefined || y === undefined || z === undefined || w === undefined) return undefined
  return { timeSeconds, x, y, z, w }
}

function normalizeWorkspaceRelativePath(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/\\/g, '/').trim().replace(/^\/workspace\//, '')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return undefined
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '' || segment === '..')) return undefined
  return segments.join('/')
}

function resolveBundleWorkspacePath(bundleWorkspacePath: string, value: string): string | undefined {
  const normalized = normalizeWorkspaceRelativePath(value)
  if (!normalized) return undefined
  if (normalized === bundleWorkspacePath || normalized.startsWith(`${bundleWorkspacePath}/`)) return normalized
  if (normalized.includes('/')) return undefined
  return `${bundleWorkspacePath}/${normalized}`
}

function resolveOptionalBundlePath(args: {
  bundleWorkspacePath: string
  value: unknown
  fallbackFileName?: string
  errors: string[]
  normalizedArtifacts?: Set<string>
  onInvalid?: 'error' | 'ignore'
}): string | undefined {
  if (typeof args.value === 'string') {
    const normalized = resolveBundleWorkspacePath(args.bundleWorkspacePath, args.value)
    if (!normalized) {
      if ((args.onInvalid ?? 'error') === 'error') {
        args.errors.push(`Kimodo metadata path must stay workspace-relative inside the bundle: ${args.value}`)
      }
      return undefined
    }
    return normalized
  }
  if (args.fallbackFileName) {
    const candidate = `${args.bundleWorkspacePath}/${args.fallbackFileName}`
    if (args.normalizedArtifacts?.has(candidate)) return candidate
  }
  return undefined
}

function resolvePreferredWorkspacePath(args: {
  artifact?: ArtifactRef
  bundleWorkspacePath: string
  preferredFileNames: string[]
  normalizedArtifacts: Set<string>
}): string | undefined {
  for (const fileName of args.preferredFileNames) {
    const fromArtifacts = `${args.bundleWorkspacePath}/${fileName}`
    if (args.normalizedArtifacts.has(fromArtifacts)) return fromArtifacts
  }

  const artifactPath = normalizeWorkspaceRelativePath(args.artifact?.legacy?.filePath ?? args.artifact?.uri)
  if (!artifactPath) return undefined
  if (!artifactPath.startsWith(`${args.bundleWorkspacePath}/`)) return undefined
  const fileName = artifactPath.split('/').at(-1)
  return args.preferredFileNames.includes(fileName ?? '') ? artifactPath : undefined
}

function readDiagnosticsValue(metadata: Record<string, unknown>, key: string): unknown {
  const diagnostics = metadata.diagnostics
  return diagnostics && typeof diagnostics === 'object' ? (diagnostics as Record<string, unknown>)[key] : undefined
}

function asFinitePositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => typeof entry === 'string' ? [entry] : [])
    : []
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

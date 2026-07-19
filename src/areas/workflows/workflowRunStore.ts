import { create } from 'zustand'
import axios from 'axios'
import { useAppStore } from '../../shared/stores/appStore.ts'
import type { WorkflowExtension } from './mockExtensions.ts'
import type {
  ArtifactLineage,
  ArtifactRef,
  ArtifactSubstitutionPoint,
  HumanoidDraftSidecarReadResult,
  HumanoidPromotionSidecarReadResult,
  RigMetaSidecarReadResult,
  Workflow,
  WFNode,
  WFEdge,
} from '../../shared/types/electron.d'
import type { ArtifactReplacementResult, WorkflowContinueOptions } from '../../shared/types/artifacts.ts'
import { buildProcessExecutionInput } from './processExecution.ts'
import { resolveWorkflowDispatch } from './workflowDispatch.ts'
import { hydrateWorkflowNodeParams } from './workflowNodeParams.ts'
import {
  buildLandmarkSidecarV1,
  createLandmarkCaptureIdentity,
  getMissingRequiredLandmarkIds,
  REQUIRED_LANDMARK_IDS,
  type LandmarkCaptureState,
  type LandmarkId,
  type LandmarkPoint,
  validateLandmarkSidecarV1,
} from './landmarks.ts'
import {
  buildLandmarkSidecarLineageMetadata,
  type LandmarkSidecarLineageMetadata,
  buildWaitArtifactLineage,
  buildWaitReplacementArtifactRef,
  createArtifactLineage,
  createDeclaredArtifactSubstitutionPoint,
  legacyOutputToArtifactRef,
  resolveArtifactReplacement,
  type LegacyWorkflowOutput,
} from './workflowArtifacts.ts'
import { resolveSceneSourceManifest } from './workflowSceneSource.ts'
import { addWorkflowOutputUrlToWorlds } from './workflowWorldsOutput.ts'
import { deriveActiveWorkflowGraph, topoSortWorkflowNodes } from './workflowActiveGraph.ts'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkflowRunState {
  status:        'idle' | 'running' | 'paused' | 'done' | 'error'
  blockIndex:    number
  blockTotal:    number
  blockProgress: number
  blockStep:     string
  outputUrl?:    string
  outputPath?:   string
  artifact?:     ArtifactRef
  substitutionPoint?: ArtifactSubstitutionPoint
  replacementResult?: ArtifactReplacementResult
  error?:        string
}

export type WaitState = 'blocked' | 'pending' | 'running' | 'done' | 'error'

const IDLE: WorkflowRunState = {
  status: 'idle', blockIndex: 0, blockTotal: 0, blockProgress: 0, blockStep: '',
}

// ─── Module-level run context (survives between run() and continueRun(id)) ───

const _cancel      = { current: false }
const _activeJobId = { current: null as string | null }
// While container (manual mode) pause/resume — set by continueWhile()/retryWhile().
const _resume      = { current: null as (() => void) | null }
const _resumeOptions = { current: undefined as WorkflowContinueOptions | undefined }
const _pendingReplacement = { current: undefined as ArtifactRef | undefined }

type LandmarkSidecarStatus = 'not_started' | 'pending-write' | 'error'

type WorkflowLandmarkSession = LandmarkCaptureState & {
  captureId: string
  captureRevision: number
  sidecarStatus: LandmarkSidecarStatus
}

export type WaitCheckpointHumanoidStatus = 'manual_confirmed' | 'draft_only' | 'stale' | 'diagnostics_only'

export interface WaitCheckpointReviewState {
  status: WaitCheckpointHumanoidStatus
  headline: string
  diagnostics: string[]
  meshWorkspacePath: string
  canPromote: boolean
  canReview: boolean
  continueLabel: string
  reviewHint?: string
  downstreamHumanoidStatus?: 'manual_confirmed'
  promotionSidecarWorkspacePath?: string
}

type WaitCheckpointHumanoidTarget = {
  consumerNodeId: string
  consumerExtensionId: string
}

function flushResume(): boolean {
  const fn = _resume.current
  if (!fn) return false
  _resume.current = null
  fn()
  return true
}

function clearPendingCheckpointState(): void {
  _pendingReplacement.current = undefined
  _resumeOptions.current = undefined
}

function buildLandmarkValidity(completed: Partial<Record<LandmarkId, LandmarkPoint>>): LandmarkCaptureState['validity'] {
  const missing = getMissingRequiredLandmarkIds(Object.values(completed))
  return { valid: missing.length === 0, missing }
}

function nextActiveLandmarkId(completed: Partial<Record<LandmarkId, LandmarkPoint>>, fallback: LandmarkId): LandmarkId {
  return REQUIRED_LANDMARK_IDS.find((id) => completed[id] === undefined) ?? fallback
}

function createLandmarkSession(args: {
  workflowId: string
  nodeId: string
  targetArtifact: ArtifactRef
}): WorkflowLandmarkSession {
  const completed: Partial<Record<LandmarkId, LandmarkPoint>> = {}
  const validity = buildLandmarkValidity(completed)
  const captureIdentity = createLandmarkCaptureIdentity(args.workflowId, args.nodeId)
  return {
    nodeId: args.nodeId,
    targetArtifact: args.targetArtifact,
    activeLandmarkId: REQUIRED_LANDMARK_IDS[0],
    completed,
    validity,
    canContinue: false,
    ...captureIdentity,
    sidecarStatus: 'not_started',
  }
}

function withLandmarkError(session: WorkflowLandmarkSession | undefined, message: string): WorkflowLandmarkSession | undefined {
  if (!session) return undefined
  return {
    ...session,
    error: message,
    sidecarStatus: session.sidecarStatus === 'pending-write' ? 'pending-write' : 'error',
  }
}

function markLandmarkInSession(session: WorkflowLandmarkSession, point: LandmarkPoint): WorkflowLandmarkSession {
  const completed = { ...session.completed, [point.id]: point }
  const validity = buildLandmarkValidity(completed)
  return {
    ...session,
    completed,
    validity,
    activeLandmarkId: nextActiveLandmarkId(completed, point.id),
    canContinue: validity.valid,
    error: undefined,
    sidecarStatus: validity.valid ? 'pending-write' : 'not_started',
  }
}

function resetLandmarksInSession(session: WorkflowLandmarkSession, workflowId: string): WorkflowLandmarkSession {
  const completed: Partial<Record<LandmarkId, LandmarkPoint>> = {}
  const validity = buildLandmarkValidity(completed)
  const captureIdentity = createLandmarkCaptureIdentity(workflowId, session.nodeId, session.captureRevision + 1)
  return {
    ...session,
    ...captureIdentity,
    activeLandmarkId: REQUIRED_LANDMARK_IDS[0],
    completed,
    validity,
    canContinue: false,
    error: undefined,
    sidecarStatus: 'not_started',
  }
}

function landmarkMissingError(missing: readonly LandmarkId[]): string {
  return `Missing required landmarks: ${missing.join(', ')}`
}

function landmarkSidecarError(message: string): string {
  return `Landmark sidecar is not ready: ${message}`
}

function resolveMeshPathForArtifact(artifact: ArtifactRef): string | undefined {
  return artifact.legacy?.filePath ?? artifact.uri
}

function normalizeWorkspaceRelativeMeshPath(filePath: string, workspaceDir: string): string | undefined {
  const normalizedPath = filePath.replace(/\\/g, '/')
  const normalizedWorkspace = workspaceDir.replace(/\\/g, '/').replace(/\/$/, '')

  let relativePath: string | undefined
  if (normalizedPath.startsWith('/workspace/')) {
    relativePath = normalizedPath.slice('/workspace/'.length)
  } else if (normalizedPath === normalizedWorkspace) {
    return undefined
  } else if (normalizedPath.startsWith(`${normalizedWorkspace}/`)) {
    relativePath = normalizedPath.slice(normalizedWorkspace.length + 1)
  } else if (!normalizedPath.startsWith('/') && !/^[A-Za-z]:\//.test(normalizedPath)) {
    relativePath = normalizedPath
  }

  if (!relativePath) return undefined
  const segments = relativePath.split('/')
  if (segments.length === 0 || segments.some((segment) => segment === '' || segment === '..')) return undefined
  return segments.join('/')
}

function isHumanoidDraftStale(result: HumanoidDraftSidecarReadResult | undefined): result is Extract<HumanoidDraftSidecarReadResult, { status: 'stale' }> {
  return result?.success === true && result.status === 'stale'
}

function isHumanoidDraftFound(result: HumanoidDraftSidecarReadResult | undefined): result is Extract<HumanoidDraftSidecarReadResult, { status: 'found' }> {
  return result?.success === true && result.status === 'found'
}

function isHumanoidPromotionStale(result: HumanoidPromotionSidecarReadResult | undefined): result is Extract<HumanoidPromotionSidecarReadResult, { status: 'stale' }> {
  return result?.success === true && result.status === 'stale'
}

function isHumanoidPromotionFound(result: HumanoidPromotionSidecarReadResult | undefined): result is Extract<HumanoidPromotionSidecarReadResult, { status: 'found' }> {
  return result?.success === true && result.status === 'found'
}

function isRigMetaFound(result: RigMetaSidecarReadResult | undefined): result is Extract<RigMetaSidecarReadResult, { status: 'found' }> {
  return result?.success === true && result.status === 'found'
}

function collectWaitCheckpointHumanoidDiagnostics(args: {
  rigMetaResult?: RigMetaSidecarReadResult
  draftResult?: HumanoidDraftSidecarReadResult
  promotionResult?: HumanoidPromotionSidecarReadResult
}): string[] {
  const diagnostics: string[] = []

  if (isRigMetaFound(args.rigMetaResult)) diagnostics.push(...args.rigMetaResult.warnings)
  if (args.rigMetaResult?.success === false && args.rigMetaResult.status === 'invalid') diagnostics.push(args.rigMetaResult.message)

  if (isHumanoidDraftFound(args.draftResult)) diagnostics.push(...args.draftResult.sidecar.diagnostics)
  if (isHumanoidDraftStale(args.draftResult)) diagnostics.push(...args.draftResult.staleReasons)
  if (args.draftResult?.success === false) diagnostics.push(args.draftResult.error)

  if (isHumanoidPromotionStale(args.promotionResult)) diagnostics.push(...args.promotionResult.staleReasons)
  if (args.promotionResult?.success === false) diagnostics.push(args.promotionResult.error)

  return [...new Set(diagnostics.filter((value) => value.trim().length > 0))]
}

function resolveWaitCheckpointHumanoidReview(args: {
  meshWorkspacePath: string
  rigMetaResult?: RigMetaSidecarReadResult
  draftResult?: HumanoidDraftSidecarReadResult
  promotionResult?: HumanoidPromotionSidecarReadResult
}): WaitCheckpointReviewState {
  const diagnostics = collectWaitCheckpointHumanoidDiagnostics(args)

  if (isHumanoidPromotionFound(args.promotionResult)) {
    return {
      status: 'manual_confirmed',
      headline: 'Manual humanoid promotion is ready for downstream Kimodo.',
      diagnostics,
      meshWorkspacePath: args.meshWorkspacePath,
      canPromote: Boolean(isHumanoidDraftFound(args.draftResult)),
      canReview: true,
      continueLabel: 'Continue manual-confirmed',
      reviewHint: 'Promotion remains manual_confirmed only — it does NOT upgrade the mesh to UniRig semantic trust.',
      downstreamHumanoidStatus: 'manual_confirmed',
      promotionSidecarWorkspacePath: args.promotionResult.sidecarWorkspacePath,
    }
  }

  if (isHumanoidDraftStale(args.draftResult) || isHumanoidPromotionStale(args.promotionResult)) {
    return {
      status: 'stale',
      headline: 'Humanoid draft or promotion is stale; downstream Kimodo will stay degraded.',
      diagnostics,
      meshWorkspacePath: args.meshWorkspacePath,
      canPromote: false,
      canReview: true,
      continueLabel: 'Continue degraded',
      reviewHint: 'Regenerate the draft or write a fresh promotion before expecting manual_confirmed downstream use.',
    }
  }

  if (isHumanoidDraftFound(args.draftResult)) {
    return {
      status: 'draft_only',
      headline: 'Draft humanoid proposal requires manual review before manual-confirmed Kimodo handoff.',
      diagnostics,
      meshWorkspacePath: args.meshWorkspacePath,
      canPromote: true,
      canReview: true,
      continueLabel: 'Continue degraded',
      reviewHint: 'Review the checkpoint preview in Viewer3D and write a manual promotion if the mapping is safe enough.',
    }
  }

  return {
    status: 'diagnostics_only',
    headline: 'No promotable humanoid mapping is available for downstream Kimodo.',
    diagnostics,
    meshWorkspacePath: args.meshWorkspacePath,
    canPromote: false,
    canReview: false,
    continueLabel: 'Continue degraded',
    reviewHint: 'Continuing will not send a manual_confirmed humanoid input downstream.',
  }
}

function isKimodoHumanoidConsumer(ext: WorkflowExtension, targetHandle?: string): boolean {
  const identity = [ext.id, ext.extensionId, ext.nodeId, ext.name]
    .map((value) => value.toLowerCase())
  const hasKimodoMarker = identity.some((value) => value.includes('kimodo') || value.includes('animate-rigged-mesh'))
  if (!hasKimodoMarker) return false

  const meshInputs = ext.inputs?.filter((port) => port.type === 'mesh') ?? []
  return meshInputs.some((port) => port.name === 'rigged_mesh' && (targetHandle === port.name || meshInputs.length === 1))
}

function resolveWaitCheckpointHumanoidTarget(args: {
  nodeId: string
  edges: WFEdge[]
  nodes: WFNode[]
  allExtensions: WorkflowExtension[]
}): WaitCheckpointHumanoidTarget | undefined {
  for (const edge of args.edges) {
    if (edge.source !== args.nodeId) continue
    const targetNode = args.nodes.find((candidate) => candidate.id === edge.target)
    if (!targetNode || targetNode.type !== 'extensionNode') continue
    const extensionId = typeof targetNode.data.extensionId === 'string' ? targetNode.data.extensionId : ''
    const ext = args.allExtensions.find((candidate) => candidate.id === extensionId)
    if (!ext || !isKimodoHumanoidConsumer(ext, edge.targetHandle ?? undefined)) continue
    return { consumerNodeId: targetNode.id, consumerExtensionId: ext.id }
  }
  return undefined
}

async function readWaitCheckpointHumanoidReview(args: {
  meshWorkspacePath: string
}): Promise<WaitCheckpointReviewState> {
  const rigMetaReader = window.electron.workspace.artifacts.readRigMetaSidecar
  const draftReader = window.electron.workspace.artifacts.readHumanoidDraftSidecar
  const promotionReader = window.electron.workspace.artifacts.readHumanoidPromotionSidecar

  const [rigMetaResult, draftResult, promotionResult] = await Promise.all([
    rigMetaReader({ sourceWorkspacePath: args.meshWorkspacePath }),
    draftReader({ meshWorkspacePath: args.meshWorkspacePath }),
    promotionReader({ meshWorkspacePath: args.meshWorkspacePath }),
  ])

  return resolveWaitCheckpointHumanoidReview({
    meshWorkspacePath: args.meshWorkspacePath,
    rigMetaResult,
    draftResult,
    promotionResult,
  })
}

function resolveIncomingWaitHumanoidParams(args: {
  ext: WorkflowExtension
  incomingEdges: WFEdge[]
  waitCheckpointReviews: Map<string, WaitCheckpointReviewState>
}): Record<string, string> {
  if (!isKimodoHumanoidConsumer(args.ext)) return {}

  for (const edge of args.incomingEdges) {
    const review = args.waitCheckpointReviews.get(edge.source)
    if (!review?.downstreamHumanoidStatus) continue
    return {
      humanoid_input_status: review.downstreamHumanoidStatus,
      ...(review.downstreamHumanoidStatus === 'manual_confirmed' && review.promotionSidecarWorkspacePath
        ? { humanoid_promotion_sidecar_path: review.promotionSidecarWorkspacePath }
        : {}),
    }
  }

  return {}
}

function isLandmarkSidecarConsumer(ext: WorkflowExtension): boolean {
  const candidates = [ext.id, ext.nodeId, ext.name, ext.extensionName]
    .map((value) => value.toLowerCase())
  return candidates.some((value) => (
    value.includes('rig-mesh')
    || value.includes('rig_mesh')
    || value.includes('rig mesh')
    || value.includes('unirig')
    || value.includes('uni-rig')
    || value.includes('uni rig')
  ))
}

function resolveIncomingLandmarkSidecarPath(args: {
  incomingEdges: WFEdge[]
  landmarkSidecars: Map<string, string>
}): string | undefined {
  for (const edge of args.incomingEdges) {
    const sidecarPath = args.landmarkSidecars.get(edge.source)
    if (sidecarPath) return sidecarPath
  }
  return undefined
}

function resolveLandmarkSidecarParams(ext: WorkflowExtension, incomingLandmarkSidecarPath: string | undefined): Record<string, string> {
  if (!incomingLandmarkSidecarPath || !isLandmarkSidecarConsumer(ext)) return {}
  return { landmarks_sidecar_path: incomingLandmarkSidecarPath }
}

async function writeLandmarkSidecarForSession(args: {
  workflowId: string
  session: WorkflowLandmarkSession
  workspaceDir: string
}): Promise<{ success: true; sidecarPath: string; metadata: LandmarkSidecarLineageMetadata } | { success: false; error: string }> {
  const sidecarPath = args.session.sidecarPath
  if (!sidecarPath) return { success: false, error: 'missing sidecar path' }

  const targetMeshPath = resolveMeshPathForArtifact(args.session.targetArtifact)
  if (!targetMeshPath) return { success: false, error: 'missing target mesh path' }
  const targetWorkspacePath = normalizeWorkspaceRelativeMeshPath(targetMeshPath, args.workspaceDir)
  if (!targetWorkspacePath) return { success: false, error: `target mesh path is outside workspace: ${targetMeshPath}` }

  const landmarks = REQUIRED_LANDMARK_IDS.map((id) => args.session.completed[id])
  if (landmarks.some((landmark) => landmark === undefined)) {
    return { success: false, error: landmarkMissingError(args.session.validity.missing) }
  }
  const completedLandmarks = landmarks as LandmarkPoint[]

  const metadata = buildLandmarkSidecarLineageMetadata({
    runId: args.workflowId,
    nodeId: args.session.nodeId,
    sidecarWorkspacePath: sidecarPath,
    targetArtifact: args.session.targetArtifact,
    targetMeshPath: targetWorkspacePath,
  })
  const sidecar = buildLandmarkSidecarV1({
    runId: args.workflowId,
    nodeId: args.session.nodeId,
    sidecarPath,
    targetArtifact: args.session.targetArtifact,
    meshPath: targetWorkspacePath,
    landmarks: completedLandmarks,
    lineage: metadata,
  })
  const validation = validateLandmarkSidecarV1(sidecar)
  if (!validation.valid) return { success: false, error: validation.errors.join(', ') }

  const result = await window.electron.workspace.artifacts.writeLandmarkSidecar({
    sidecarWorkspacePath: sidecarPath,
    sourceWorkspacePath: targetWorkspacePath,
    sidecar,
  })
  if (!result.success) return { success: false, error: result.error }
  if (result.sidecarWorkspacePath !== sidecarPath) {
    return { success: false, error: `unexpected sidecar path ${result.sidecarWorkspacePath}` }
  }
  const writtenValidation = validateLandmarkSidecarV1(result.sidecar)
  if (!writtenValidation.valid) return { success: false, error: writtenValidation.errors.join(', ') }

  return { success: true, sidecarPath, metadata }
}

function clearCurrentJobCheckpointMetadata(): void {
  useAppStore.getState().updateCurrentJob({ step: undefined, outputUrl: undefined, previewKind: undefined })
}

type ModelGenerationRequest =
  | {
      kind: 'none'
      payload: {
        model_id: string
        collection: string
        remesh: string
        enable_texture: boolean
        texture_resolution: number
        params: Record<string, unknown>
      }
    }
  | {
      kind: 'image'
      imagePath: string
      imageData?: string
      params: Record<string, unknown>
    }
  | {
      kind: 'text'
      payload: {
        prompt: string
        model_id: string
        collection: string
        remesh: string
        enable_texture: boolean
        texture_resolution: number
        params: Record<string, unknown>
      }
    }
  | {
      kind: 'scene'
      scenePath: string
      params: Record<string, unknown>
    }

const RESERVED_MODEL_SIDE_IMAGE_PARAMS = ['left_image_path', 'back_image_path', 'right_image_path'] as const

function normalizeWorkflowPath(filePath: string, workspaceDir: string): string {
  const norm = filePath.replace(/\\/g, '/')
  return norm.startsWith(workspaceDir)
    ? norm.slice(workspaceDir.length).replace(/^\//, '')
    : norm
}

function resolveSafeWorkspaceUrl(filePath: string | undefined, workspaceDir: string): string | undefined {
  if (!filePath) return undefined
  const norm = filePath.replace(/\\/g, '/')
  const workspace = workspaceDir.replace(/\\/g, '/').replace(/\/$/, '')
  if (norm !== workspace && !norm.startsWith(`${workspace}/`)) return undefined

  const rel = norm.slice(workspace.length).replace(/^\//, '')
  if (!rel || rel.split('/').includes('..')) return undefined
  return `/workspace/${rel}`
}

function publishWaitCheckpointPreview(args: {
  artifact: ArtifactRef | undefined
  workspaceDir: string
}): void {
  if (args.artifact?.kind !== 'mesh') return
  const meshPath = args.artifact.legacy?.filePath ?? args.artifact.uri
  const outputUrl = resolveSafeWorkspaceUrl(meshPath, args.workspaceDir)
  if (!outputUrl) return

  useAppStore.getState().updateCurrentJob({
    status: 'generating',
    progress: 100,
    step: 'Workflow checkpoint',
    outputUrl,
    previewKind: 'workflow-checkpoint',
  })
}

function observableReplacementResult(result: ArtifactReplacementResult): ArtifactReplacementResult {
  if (result.status === 'rejected') {
    return { status: result.status, reason: result.reason }
  }
  if (result.status === 'noop') {
    return { status: result.status, reason: result.reason }
  }
  return result
}

function resolveModelImageRouting(args: {
  ext: WorkflowExtension
  incomingEdges: WFEdge[]
  nodeOutputs: Map<string, LegacyWorkflowOutput>
}): {
  applies: boolean
  frontPath?: string
  sideParams: Record<string, string>
} {
  const namedImagePorts = new Set(
    args.ext.inputs?.filter((port) => port.type === 'image').map((port) => port.name) ?? [],
  )

  if (namedImagePorts.size === 0) {
    return { applies: false, sideParams: {} }
  }

  const routed = new Map<string, string>()
  for (const edge of args.incomingEdges) {
    const handle = edge.targetHandle ?? undefined
    if (!handle || !namedImagePorts.has(handle)) continue

    const src = args.nodeOutputs.get(edge.source)
    if (!src?.filePath || src.outputType !== 'image') continue
    routed.set(handle, src.filePath)
  }

  return {
    applies: true,
    frontPath: routed.get('front'),
    sideParams: {
      ...(routed.get('left') ? { left_image_path: routed.get('left')! } : {}),
      ...(routed.get('back') ? { back_image_path: routed.get('back')! } : {}),
      ...(routed.get('right') ? { right_image_path: routed.get('right')! } : {}),
    },
  }
}

function resolveModelMeshRouting(args: {
  ext: WorkflowExtension
  incomingEdges: WFEdge[]
  nodeOutputs: Map<string, LegacyWorkflowOutput>
}): {
  applies: boolean
  requiredPorts: string[]
  routed: Map<string, string>
} {
  const meshPorts = args.ext.inputs?.filter((port) => port.type === 'mesh') ?? []
  if (meshPorts.length === 0) {
    return { applies: false, requiredPorts: [], routed: new Map() }
  }

  const meshPortNames = new Set(meshPorts.map((port) => port.name))
  const routed = new Map<string, string>()
  for (const edge of args.incomingEdges) {
    const src = args.nodeOutputs.get(edge.source)
    if (!src?.filePath || src.outputType !== 'mesh') continue

    const handle = edge.targetHandle ?? undefined
    if (handle && meshPortNames.has(handle)) {
      routed.set(handle, src.filePath)
      continue
    }

    if (meshPorts.length === 1) {
      routed.set(meshPorts[0].name, src.filePath)
    }
  }

  return {
    applies: true,
    requiredPorts: meshPorts.filter((port) => port.required).map((port) => port.name),
    routed,
  }
}

export function shouldUsePreviousNodeFallback(input: WorkflowExtension['input']): boolean {
  return input !== 'none'
}

function resolveModelNodeOutputKind(args: {
  declaredOutput?: ArtifactRef['kind']
  actualOutput?: ArtifactRef['kind']
  extensionId: string
}): ArtifactRef['kind'] | undefined {
  if (args.actualOutput === undefined) return args.declaredOutput
  if (args.declaredOutput !== undefined && args.declaredOutput !== args.actualOutput) {
    throw new Error(
      `Model ${args.extensionId} declared output "${args.declaredOutput}" but generated "${args.actualOutput}". Update the manifest output or fix the generator output contract.`,
    )
  }
  return args.actualOutput
}

export function buildModelGenerationRequest(args: {
  ext: WorkflowExtension
  node: WFNode
  nodeParams: Record<string, unknown>
  nodeInputPath?: string
  nodeInputText?: string
  nodeInputMeshPath?: string
  routedMeshParams?: Record<string, string>
  routedSideParams?: Record<string, string>
  selectedImagePath?: string
  selectedImageData?: string
  workspaceDir: string
}): ModelGenerationRequest {
  const {
    ext,
    node,
    nodeParams,
    nodeInputPath,
    nodeInputText,
    nodeInputMeshPath,
    routedMeshParams = {},
    routedSideParams = {},
    selectedImagePath,
    selectedImageData,
    workspaceDir,
  } = args

  const input: unknown = Reflect.get(ext, 'input')
  if (input === undefined) {
    throw new Error(`Missing workflow capability input metadata for extension: ${ext.id}`)
  }

  if (input === 'none') {
    return {
      kind: 'none',
      payload: {
        model_id: node.data.extensionId ?? '',
        collection: 'Workflows',
        remesh: 'none',
        enable_texture: false,
        texture_resolution: 1024,
        params: nodeParams,
      },
    }
  }

  if (input === 'text') {
    const promptParam = typeof nodeParams.prompt === 'string' ? nodeParams.prompt : undefined
    const isAnimateRiggedMesh = ext.nodeId === 'animate-rigged-mesh' || ext.id.includes('animate-rigged-mesh')
    const nodeOwnParams = node.data.params && typeof node.data.params === 'object' ? node.data.params : {}
    const hasExplicitPromptParam = Object.prototype.hasOwnProperty.call(nodeOwnParams, 'prompt')
    const prompt = isAnimateRiggedMesh && hasExplicitPromptParam && promptParam !== undefined
      ? promptParam
      : nodeInputText ?? promptParam ?? ''
    const { prompt: _prompt, ...params } = nodeParams
    if (!prompt.trim()) {
      throw new Error(`Missing required ${isAnimateRiggedMesh ? 'motion prompt' : 'prompt'} input for extension ${ext.id}`)
    }
    const textParams = { ...params, ...routedMeshParams }
    if (isAnimateRiggedMesh) {
      textParams.motion_prompt = prompt.trim()
      if (hasExplicitPromptParam && promptParam !== undefined && typeof nodeInputText === 'string' && nodeInputText.trim() && nodeInputText.trim() !== prompt.trim()) {
        textParams.character_prompt = nodeInputText.trim()
      }
    }

    return {
      kind: 'text',
      payload: {
        prompt: prompt.trim(),
        model_id: node.data.extensionId ?? '',
        collection: 'Workflows',
        remesh: 'none',
        enable_texture: false,
        texture_resolution: 1024,
        params: textParams,
      },
    }
  }

  if (input === 'scene') {
    const activeScenePath = nodeInputPath
    if (!activeScenePath) {
      throw new Error(`Missing required scene input for extension ${ext.id}`)
    }
    const scenePath = normalizeWorkflowPath(activeScenePath, workspaceDir)
    return {
      kind: 'scene',
      scenePath,
      params: {
        ...nodeParams,
        scene_path: scenePath,
        input_scene_path: scenePath,
      },
    }
  }

  if (input !== 'image') {
    throw new Error(`Unsupported workflow capability input for extension ${ext.id}: ${String(input)}`)
  }

  const activeImagePath = nodeInputPath ?? selectedImagePath
  if (!activeImagePath) {
    throw new Error("ENOENT: no such file or directory, open ''")
  }
  const sanitizedNodeParams = Object.fromEntries(
    Object.entries(nodeParams).filter(([key]) => !RESERVED_MODEL_SIDE_IMAGE_PARAMS.includes(key as typeof RESERVED_MODEL_SIDE_IMAGE_PARAMS[number])),
  )
  const extraParams: Record<string, unknown> = {}
  if (nodeInputMeshPath) {
    extraParams.mesh_path = normalizeWorkflowPath(nodeInputMeshPath, workspaceDir)
  }

  return {
    kind: 'image',
    imagePath: activeImagePath,
    imageData: selectedImageData && nodeInputPath === undefined ? selectedImageData : undefined,
    params: { ...sanitizedNodeParams, ...routedSideParams, ...routedMeshParams, ...extraParams },
  }
}


// ─── Store ────────────────────────────────────────────────────────────────────

export interface WorkflowRunStore {
  runState:         WorkflowRunState
  activeNodeId:     string | null
  activeWorkflowId: string | null
  pendingReplacement?: ArtifactRef
  /** nodeId → workspace URL for image outputs (populated after each run) */
  nodeImageOutputs: Record<string, string>
  /** nodeId → workspace URL for video outputs (populated after each run) */
  nodeVideoOutputs: Record<string, string>
  /** nodeId → ArtifactRef wrapper for legacy node outputs */
  nodeArtifacts: Record<string, ArtifactRef>
  /** artifactId → immutable-original lineage metadata */
  artifactLineages: Record<string, ArtifactLineage>
  /** landmarksNode id → sidecar metadata for artifact history. */
  landmarkSidecars: Record<string, LandmarkSidecarLineageMetadata>
  /** Active guided landmarks capture session for a paused landmarksNode. */
  landmarkSession?: WorkflowLandmarkSession
  /** Active Wait-before-Kimodo humanoid review state, when applicable. */
  waitCheckpointReview?: WaitCheckpointReviewState

  run:         (workflow: Workflow, allExtensions: WorkflowExtension[], overrideImageData?: string) => Promise<void>
  cancel:      () => void
  reset:       () => void
  continueRun: (options?: WorkflowContinueOptions) => void
  setPendingReplacement: (replacement: ArtifactRef | undefined) => void
  getPendingReplacement: () => ArtifactRef | undefined
  markLandmark: (point: LandmarkPoint) => void
  selectLandmarkForEditing: (id: LandmarkId) => void
  resetLandmarks: (nodeId?: string) => void
}

export const useWorkflowRunStore = create<WorkflowRunStore>((set) => ({
  runState:         IDLE,
  activeNodeId:     null,
  activeWorkflowId: null,
  pendingReplacement: undefined,
  nodeImageOutputs: {},
  nodeVideoOutputs: {},
  nodeArtifacts: {},
  artifactLineages: {},
  landmarkSidecars: {},
  landmarkSession: undefined,
  waitCheckpointReview: undefined,

  async run(workflow, allExtensions, overrideImageData?) {
    _cancel.current = false
    clearPendingCheckpointState()

    const appState     = useAppStore.getState()
    const apiUrl       = appState.apiUrl
    const activeGraph  = deriveActiveWorkflowGraph(workflow.nodes, workflow.edges)
    const ordered      = topoSortWorkflowNodes(activeGraph.nodes, activeGraph.edges)
    const execNodes    = ordered.filter((n) =>
      n.type === 'extensionNode' || n.type === 'waitNode' || n.type === 'landmarksNode',
    )

    const selectedImagePath = appState.selectedImagePath ?? ''
    const selectedImageData = overrideImageData ?? appState.selectedImageData ?? undefined
    const currentMeshUrl    = appState.currentJob?.outputUrl

    set({
      activeWorkflowId: workflow.id,
      pendingReplacement: undefined,
      nodeImageOutputs: {},
      nodeVideoOutputs: {},
      nodeArtifacts: {},
      artifactLineages: {},
      landmarkSidecars: {},
      landmarkSession: undefined,
      waitCheckpointReview: undefined,
      runState: { status: 'running', blockIndex: 0, blockTotal: execNodes.length, blockProgress: 0, blockStep: 'Starting…' },
    })

    appState.setCurrentJob({
      id: crypto.randomUUID(),
      imageFile: selectedImagePath,
      status: 'generating',
      progress: 0,
      createdAt: Date.now(),
    })

    try {
      const client   = axios.create({ baseURL: apiUrl })
      const settings = await window.electron.settings.get()
      const workspaceDir = settings.workspaceDir.replace(/\\/g, '/')

      // Clean up tmp folder from previous run
      const tmpAbsPath = settings.workspaceDir.replace(/[\\/]+$/, '') + '/tmp'
      window.electron.fs.deleteDirectory(tmpAbsPath).catch(() => {})

      // nodeId → { filePath, text, outputType }
      const nodeOutputs = new Map<string, LegacyWorkflowOutput>()
      const nodeArtifacts = new Map<string, ArtifactRef>()
      const artifactLineages = new Map<string, ArtifactLineage>()
      const nodeLandmarkSidecars = new Map<string, string>()
      const landmarkSidecarMetadata = new Map<string, LandmarkSidecarLineageMetadata>()
      const waitCheckpointHumanoidReviews = new Map<string, WaitCheckpointReviewState>()
      const addToSceneNodeIds = new Set(ordered.filter((n) => n.type === 'outputNode').map((n) => n.id))
      const addToWorldsNodeIds = new Set(ordered.filter((n) => n.type === 'addToWorldsNode').map((n) => n.id))
      const sceneOutputNodeIds = new Set([...addToSceneNodeIds, ...addToWorldsNodeIds])

      const rememberArtifactOutput = (
        nodeId: string,
        output: LegacyWorkflowOutput,
        provenance?: {
          workflowId: string
          workflowNodeId: string
          extensionId?: string
          extensionNodeId?: string
        },
      ): ArtifactRef | undefined => {
        const artifact = legacyOutputToArtifactRef(output, {
          artifactId: `workflow-${workflow.id}-node-${nodeId}`,
          provenance,
        })
        if (!artifact) return undefined
        nodeArtifacts.set(nodeId, artifact)
        if (!artifactLineages.has(artifact.id)) {
          artifactLineages.set(artifact.id, createArtifactLineage(artifact))
        }
        set({
          nodeArtifacts: Object.fromEntries(nodeArtifacts),
          artifactLineages: Object.fromEntries(artifactLineages),
        })
        return artifact
      }

      // Pre-populate source nodes
      for (const node of ordered) {
        if (node.type === 'imageNode') {
          const fp = node.data.params?.filePath as string | undefined
          // When the agent provides an override image, ignore any hardcoded filePath so the
          // model node falls through to selectedImageData (= overrideImageData).
          const resolvedPath = overrideImageData ? undefined : (fp ?? selectedImagePath ?? undefined)
          const output = { filePath: resolvedPath, outputType: 'image' }
          nodeOutputs.set(node.id, output)
          rememberArtifactOutput(node.id, output)
        }
        if (node.type === 'textNode') {
          const output = { text: node.data.params?.text as string | undefined, outputType: 'text' }
          nodeOutputs.set(node.id, output)
          rememberArtifactOutput(node.id, output)
        }
        if (node.type === 'meshNode') {
          const source = node.data.params?.source as 'file' | 'current' | undefined
          if (source === 'current' && currentMeshUrl) {
            let meshFilePath: string
            if (currentMeshUrl.includes('serve-file?path=')) {
              // URL like /optimize/serve-file?path=D%3A%5C... → extract and decode the real path
              const encoded = currentMeshUrl.split('serve-file?path=')[1]
              meshFilePath = decodeURIComponent(encoded).replace(/\\/g, '/')
            } else {
              // URL like /workspace/Workflows/file.glb → resolve to absolute path
              const rel = currentMeshUrl.replace(/^\/workspace\//, '')
              meshFilePath = `${workspaceDir}/${rel}`
            }
            const output = { filePath: meshFilePath, outputType: 'mesh' }
            nodeOutputs.set(node.id, output)
            rememberArtifactOutput(node.id, output)
          } else {
            const fp = node.data.params?.filePath as string | undefined
            if (fp) {
              const output = { filePath: fp, outputType: 'mesh' }
              nodeOutputs.set(node.id, output)
              rememberArtifactOutput(node.id, output)
            }
          }
          const workspaceUrl = toWorkspaceUrl(o.filePath, ctx.workspaceDir)
          if (workspaceUrl) outputUrl = workspaceUrl
          else outputPath = o.filePath
        }
      }
    }

    set((s) => ({
      activeNodeId:     null,
      runningBranchId:  null,
      whileProgress:    {},
      pausedGroup:      [],
      waitStates:       finalWaitStates ?? s.waitStates,
      nodeImageOutputs: collectImageOutputs(ctx),
      runState: {
        status:        'done',
        blockIndex:    0,
        blockTotal:    0,
        blockProgress: 100,
        blockStep:     'Done',
        outputUrl,
        outputPath,
      },
    }))
    useAppStore.getState().updateCurrentJob({ status: 'done', progress: 100, outputUrl })
  }

  return {
    runState:         IDLE,
    activeNodeId:     null,
    activeWorkflowId: null,
    nodeImageOutputs: {},
    waitStates:       {},
    runningBranchId:  null,
    whileProgress:    {},
    pausedGroup:      [],

    async run(workflow, allExtensions, overrideImageData?) {
      _cancel.current = false
      _pauseRequested.current = false
      // Seed live params from the snapshot; UI edits during the run override these.
      _liveParams.current = new Map(workflow.nodes.map((n) => [n.id, { ...(n.data.params ?? {}) }]))

      const appState = useAppStore.getState()
      const apiUrl   = appState.apiUrl

      const { preExecExtNodes, branches, waitIds, parentWait, ordered } = identifyBranches(workflow)
      const branchSteps = waitIds.reduce((acc, w) => acc + (branches.get(w)?.length ?? 0), 0)

      const nodeMap = new Map(workflow.nodes.map((n) => [n.id, n]))

      // ── For Each iterators → resolve their folders up front ────────────────────
      // The loop count is driven by the folder contents, so the listing must resolve
      // before the loop table (and its progress totals) below.
      const iteratorFiles = new Map<string, string[]>()
      for (const w of workflow.nodes) {
        if (!isIterator(w.type)) continue
        const dir = (w.data.params?.dir as string | undefined)?.trim()
        const fail = (msg: string, step: string): void => {
          set((s) => ({ runState: { ...s.runState, status: 'error', error: msg, blockStep: step }, activeNodeId: null }))
        }
        if (!dir) { fail('For Each: pick a folder first', 'No folder selected'); return }
        try {
          const files = await listIteratorFiles(dir, iteratorConfig(w).exts)
          if (files.length === 0) { fail(`For Each: no matching files in ${dir}`, 'Empty folder'); return }
          iteratorFiles.set(w.id, files)
        } catch (err) {
          fail(String(err), 'Failed to read folder'); return
        }
        if (node.type === 'sceneNode') {
          const scenePath = node.data.params?.path as string | undefined
          if (scenePath) {
            const resolution = await resolveSceneSourceManifest({
              scenePath,
              workspaceDir,
              readFileBase64: window.electron.fs.readFileBase64,
            })
            if (!resolution.ok) {
              throw new Error(`Load Scene: ${resolution.error}`)
            }
            const output = { filePath: resolution.manifestAbsolutePath, outputType: 'scene' }
            nodeOutputs.set(node.id, output)
            rememberArtifactOutput(node.id, output)
          }
        }
      }

      // ── Loop table ─────────────────────────────────────────────────────────────
      // While containers loop their geometric body N× (or manually). For Each
      // iterators loop the executable nodes reachable downstream, once per file.
      // Replays filter by bodyIds membership (not a contiguous range), so unrelated
      // pre-phase nodes sorting between body members aren't replayed.
      interface LoopInfo { whileId: string; kind: 'while' | 'forEach'; firstIdx: number; lastIdx: number; bodyIds: Set<string>; iterations: number | null }
      const loops: LoopInfo[] = []
      const indexOf = new Map(preExecExtNodes.map((n, i) => [n.id, i]))

        const node = execNodes[i]
        const incomingEdges = activeGraph.edges.filter((e) => e.target === node.id)

        // ── Built-in Wait-like checkpoints are not external extensions ─────────────
        // Keep them ahead of workflow dispatch so built-ins with no extensionId do not
        // weaken the strict unresolved-extension contract for real extensionNode nodes.
        if (node.type === 'waitNode' || node.type === 'landmarksNode') {
          let nodeInputPath:     string | undefined
          let nodeInputText:     string | undefined

          for (const edge of incomingEdges) {
            const src = nodeOutputs.get(edge.source)
            if (src?.filePath !== undefined) nodeInputPath = src.filePath
            if (src?.text     !== undefined) nodeInputText = src.text
          }
          if (nodeInputPath === undefined && nodeInputText === undefined && i > 0) {
            const prev = nodeOutputs.get(execNodes[i - 1].id)
            if (prev?.filePath !== undefined) nodeInputPath = prev.filePath
            if (prev?.text     !== undefined) nodeInputText = prev.text
          }

          set((s) => ({
            activeNodeId: node.id,
            runState: { ...s.runState, blockIndex: i, blockProgress: 0, blockStep: 'Starting…' },
          }))

          const inputArtifact = incomingEdges
            .map((edge) => nodeArtifacts.get(edge.source))
            .find((artifact): artifact is ArtifactRef => artifact !== undefined)
          const substitutionPoint = inputArtifact
            ? createDeclaredArtifactSubstitutionPoint({ nodeId: node.id, inputArtifact })
            : undefined
          const isLandmarksCheckpoint = node.type === 'landmarksNode'
          const landmarkSession = isLandmarksCheckpoint && inputArtifact?.kind === 'mesh'
            ? createLandmarkSession({ workflowId: workflow.id, nodeId: node.id, targetArtifact: inputArtifact })
            : undefined
          const humanoidTarget = !isLandmarksCheckpoint && inputArtifact?.kind === 'mesh'
            ? resolveWaitCheckpointHumanoidTarget({ nodeId: node.id, edges: activeGraph.edges, nodes: activeGraph.nodes, allExtensions })
            : undefined

          let waitCheckpointReview: WaitCheckpointReviewState | undefined
          if (humanoidTarget && inputArtifact?.kind === 'mesh') {
            const meshPath = resolveMeshPathForArtifact(inputArtifact)
            const meshWorkspacePath = meshPath
              ? normalizeWorkspaceRelativeMeshPath(meshPath, workspaceDir)
              : undefined

            waitCheckpointReview = meshWorkspacePath
              ? await readWaitCheckpointHumanoidReview({ meshWorkspacePath })
              : {
                  status: 'diagnostics_only',
                  headline: 'No promotable humanoid mapping is available for downstream Kimodo.',
                  diagnostics: meshPath ? [`Wait checkpoint mesh is outside the workspace: ${meshPath}`] : ['Wait checkpoint mesh path is unavailable for humanoid review.'],
                  meshWorkspacePath: '',
                  canPromote: false,
                  canReview: false,
                  continueLabel: 'Continue degraded',
                  reviewHint: 'Continuing will not send a manual_confirmed humanoid input downstream.',
                }
          }

          if (isLandmarksCheckpoint && !landmarkSession) {
            throw new Error('Landmarks node requires a mesh checkpoint input')
          }

          set((s) => ({
            runState: {
              ...s.runState,
              status: 'paused',
              blockStep: isLandmarksCheckpoint
                ? 'Paused — mark required landmarks'
                : waitCheckpointReview
                  ? 'Paused — review humanoid handoff before Kimodo'
                  : 'Paused — click Continue',
              artifact: inputArtifact,
              substitutionPoint,
              replacementResult: undefined,
              error: undefined,
            },
            landmarkSession,
            waitCheckpointReview,
          }))
          publishWaitCheckpointPreview({ artifact: inputArtifact, workspaceDir })
          let landmarkSidecarPath: string | undefined
          while (true) {
            await new Promise<void>((resolve) => { _resume.current = resolve })
            if (_cancel.current) { set({ runState: IDLE, activeNodeId: null, landmarkSession: undefined, landmarkSidecars: {}, waitCheckpointReview: undefined }); return }

            const activeLandmarkSession = useWorkflowRunStore.getState().landmarkSession
            if (!isLandmarksCheckpoint || !activeLandmarkSession) break

            const sidecarResult = await writeLandmarkSidecarForSession({
              workflowId: workflow.id,
              session: activeLandmarkSession,
              workspaceDir,
            })
            if (sidecarResult.success) {
              landmarkSidecarPath = sidecarResult.sidecarPath
              landmarkSidecarMetadata.set(node.id, sidecarResult.metadata)
              break
            }

            const message = landmarkSidecarError(sidecarResult.error)
            set((s) => ({
              runState: { ...s.runState, status: 'paused', error: message },
              landmarkSession: s.landmarkSession
                ? { ...s.landmarkSession, error: message, sidecarStatus: 'error' }
                : undefined,
            }))
          }

          const passthroughOutput = {
            filePath:   nodeInputPath,
            text:       nodeInputText,
            outputType: incomingEdges[0] ? nodeOutputs.get(incomingEdges[0].source)?.outputType : undefined,
          }
          const activeWaitCheckpointReview = useWorkflowRunStore.getState().waitCheckpointReview
          const replacement = _resumeOptions.current?.replacementArtifact ?? _pendingReplacement.current
          _resumeOptions.current = undefined
          _pendingReplacement.current = undefined
          const replacementResult = substitutionPoint
            ? resolveArtifactReplacement(substitutionPoint, replacement, { currentNodeId: node.id })
            : undefined
          const visibleReplacementResult = replacementResult
            ? observableReplacementResult(replacementResult)
            : undefined
          clearCurrentJobCheckpointMetadata()

          if (replacementResult?.status === 'accepted' && inputArtifact) {
            const editedArtifact = buildWaitReplacementArtifactRef(inputArtifact, replacementResult.artifact)
            nodeOutputs.set(node.id, replacementResult.legacy)
            nodeArtifacts.set(node.id, editedArtifact)
            artifactLineages.set(
              inputArtifact.id,
              buildWaitArtifactLineage(artifactLineages.get(inputArtifact.id), inputArtifact, editedArtifact),
            )
            set({
              nodeArtifacts: Object.fromEntries(nodeArtifacts),
              artifactLineages: Object.fromEntries(artifactLineages),
            })
          } else {
            nodeOutputs.set(node.id, passthroughOutput)
            rememberArtifactOutput(node.id, passthroughOutput)
          }
          if (isLandmarksCheckpoint && landmarkSidecarPath) {
            nodeLandmarkSidecars.set(node.id, landmarkSidecarPath)
            set({ landmarkSidecars: Object.fromEntries(landmarkSidecarMetadata) })
          }
          if (activeWaitCheckpointReview?.downstreamHumanoidStatus) {
            waitCheckpointHumanoidReviews.set(node.id, activeWaitCheckpointReview)
          } else {
            waitCheckpointHumanoidReviews.delete(node.id)
          }
          set((s) => ({
            runState: {
              ...s.runState,
              status: 'running',
              substitutionPoint: undefined,
              error: undefined,
              ...(visibleReplacementResult !== undefined ? { replacementResult: visibleReplacementResult } : {}),
            },
            pendingReplacement: undefined,
            landmarkSession: undefined,
            waitCheckpointReview: undefined,
          }))
          continue
        }

        const dispatch = resolveWorkflowDispatch(node, allExtensions)
        const { ext, mode } = dispatch
        const hydratedParams = hydrateWorkflowNodeParams(ext, node.data.params as Record<string, unknown> | undefined)
        const artifactProvenance = {
          workflowId: workflow.id,
          workflowNodeId: node.id,
          extensionId: ext.extensionId,
          extensionNodeId: ext.nodeId,
        }

        // ── Resolve inputs ────────────────────────────────────────────────
        let nodeInputPath:     string | undefined
        let nodeInputText:     string | undefined
        let nodeInputMeshPath: string | undefined

        const modelImageRouting = resolveModelImageRouting({
          ext,
          incomingEdges,
          nodeOutputs,
        })
        const modelMeshRouting = resolveModelMeshRouting({
          ext,
          incomingEdges,
          nodeOutputs,
        })
        const incomingLandmarkSidecarPath = resolveIncomingLandmarkSidecarPath({
          incomingEdges,
          landmarkSidecars: nodeLandmarkSidecars,
        })
        const incomingWaitHumanoidParams = resolveIncomingWaitHumanoidParams({
          ext,
          incomingEdges,
          waitCheckpointReviews: waitCheckpointHumanoidReviews,
        })

        if (ext?.inputs && ext.inputs.length > 1) {
          // Multi-input: route each incoming edge by the source node's outputType
          for (const edge of incomingEdges) {
            const src = nodeOutputs.get(edge.source)
            if (!src) continue
            if (src.outputType === 'mesh')        nodeInputMeshPath = src.filePath
            else if (src.outputType === 'image') {
              const targetHandle = edge.targetHandle ?? undefined
              if (!modelImageRouting.applies || !['left', 'back', 'right'].includes(targetHandle ?? '')) {
                nodeInputPath = src.filePath
              }
            }
            else if (src.filePath !== undefined)  nodeInputPath     = src.filePath
            if (src.text !== undefined)           nodeInputText     = src.text
          }
        } else if (shouldUsePreviousNodeFallback(ext.input)) {
          // Single-input. Inputless model sources never consume edges or prior outputs.
          for (const edge of incomingEdges) {
            const src = nodeOutputs.get(edge.source)
            if (src?.filePath !== undefined) nodeInputPath = src.filePath
            if (src?.text     !== undefined) nodeInputText = src.text
          }
          // Fallback to previous node's output
          if (nodeInputPath === undefined && nodeInputText === undefined && i > 0) {
            const prev = nodeOutputs.get(execNodes[i - 1].id)
            if (prev?.filePath !== undefined) nodeInputPath = prev.filePath
            if (prev?.text     !== undefined) nodeInputText = prev.text
          }
        }

        if (modelImageRouting.applies && modelImageRouting.frontPath) {
          nodeInputPath = modelImageRouting.frontPath
        }

        const routedMeshParams: Record<string, string> = {}
        if (modelMeshRouting.applies) {
          const riggedMeshPath = modelMeshRouting.routed.get('rigged_mesh')
          if (riggedMeshPath) {
            const normalized = normalizeWorkflowPath(riggedMeshPath, workspaceDir)
            routedMeshParams.rigged_mesh_path = normalized
            routedMeshParams.mesh_path = normalized
            routedMeshParams.node_id = ext.nodeId
            routedMeshParams.model_id = node.data.extensionId ?? ''
          }
          const genericMeshPath = modelMeshRouting.routed.get('mesh')
          if (genericMeshPath) {
            routedMeshParams.mesh_path = normalizeWorkflowPath(genericMeshPath, workspaceDir)
          }
        }
        Object.assign(routedMeshParams, resolveLandmarkSidecarParams(ext, incomingLandmarkSidecarPath), incomingWaitHumanoidParams)

        set((s) => ({
          activeNodeId: node.id,
          runState: { ...s.runState, blockIndex: i, blockProgress: 0, blockStep: 'Starting…' },
        }))

        // ── Model extensions → HTTP API ───────────────────────────────────
        // Process extensions → IPC runProcess
        if (mode === 'model') {
          const request = buildModelGenerationRequest({
            ext,
            node,
            nodeParams: hydratedParams,
            nodeInputPath,
            nodeInputText,
            nodeInputMeshPath,
            routedMeshParams,
            routedSideParams: modelImageRouting.sideParams,
            selectedImagePath,
            selectedImageData,
            workspaceDir,
          })

          set((s) => ({ runState: { ...s.runState, blockProgress: 5, blockStep: 'Submitting to model…' } }))

          const { data } = await (request.kind === 'none'
            ? client.post<{ job_id: string }>('/generate/from-none', request.payload)
            : request.kind === 'scene'
              ? client.post<{ job_id: string }>('/generate/from-scene', {
              scene_path: request.scenePath,
              model_id: node.data.extensionId ?? '',
              collection: 'Workflows',
              remesh: 'none',
              enable_texture: false,
              texture_resolution: 1024,
                params: request.params,
              })
            : request.kind === 'image'
              ? (async () => {
                const bytes = Uint8Array.from(atob(request.imageData ?? await window.electron.fs.readFileBase64(request.imagePath)), (c) => c.charCodeAt(0))
                const blob  = new Blob([bytes], { type: 'image/png' })
                const fname = request.imagePath.split(/[\\/]/).pop() ?? 'image.png'
                const fd = new FormData()
                fd.append('image', blob, fname)
                fd.append('model_id', node.data.extensionId ?? '')
                fd.append('collection', 'Workflows')
                fd.append('remesh', 'none')
                fd.append('enable_texture', 'false')
                fd.append('texture_resolution', '1024')
                fd.append('params', JSON.stringify(request.params))
                return client.post<{ job_id: string }>(
                  '/generate/from-image', fd,
                  { headers: { 'Content-Type': 'multipart/form-data' } },
                )
              })()
              : client.post<{ job_id: string }>('/generate/from-text', request.payload))
          _activeJobId.current = data.job_id

          while (true) {
            if (_cancel.current) {
              await client.post(`/generate/cancel/${_activeJobId.current}`).catch(() => {})
              _activeJobId.current = null
              set({ runState: IDLE, activeNodeId: null })
              return
            }
            await new Promise((r) => setTimeout(r, 1200))

            const { data: st } = await client.get<{
              status: string; progress?: number; step?: string; output_url?: string; output_kind?: ArtifactRef['kind']; error?: string
            }>(`/generate/status/${_activeJobId.current}`)

            if (st.status === 'done' && st.output_url) {
              const outputType = resolveModelNodeOutputKind({
                declaredOutput: ext.output,
                actualOutput: st.output_kind,
                extensionId: ext.id,
              })
              const rel = st.output_url.replace(/^\/workspace\//, '')
              nodeInputPath = `${workspaceDir}/${rel}`
              nodeOutputs.set(`${node.id}::__actual_output_kind__`, { outputType })
              _activeJobId.current = null
              set((s) => ({ runState: { ...s.runState, blockProgress: 100, blockStep: 'Generation complete' } }))
              break
            }
            if (st.status === 'error') throw new Error(st.error ?? 'Generation failed')

            const total   = execNodes.length
            const overall = total > 0
              ? Math.round((i / total) * 100 + (st.progress ?? 0) / total)
              : st.progress ?? 0
            set((s) => ({
              runState: { ...s.runState, blockProgress: st.progress ?? s.runState.blockProgress, blockStep: st.step ?? 'Generating…' },
            }))
            useAppStore.getState().updateCurrentJob({ status: 'generating', progress: overall, step: st.step })
          }

        } else {
          const processInput = buildProcessExecutionInput({
            node,
            nodes: activeGraph.nodes,
            edges: activeGraph.edges,
            allExtensions,
            nodeOutputs,
            previousNodeOutput: i > 0 ? nodeOutputs.get(execNodes[i - 1].id) : undefined,
          })
          const result = await window.electron.extensions.runProcess(
            ext.extensionId,
            processInput,
            { ...hydratedParams, ...routedMeshParams },
          )
          if (!result.success) throw new Error(result.error ?? 'Process extension failed')
          nodeInputPath = processInput.filePath
          nodeInputText = processInput.text
          nodeInputPath = result.result?.filePath ?? nodeInputPath
          nodeInputText = result.result?.text     ?? nodeInputText
          set((s) => ({ runState: { ...s.runState, blockProgress: 100, blockStep: 'Done' } }))
        }

        // Store output with type for downstream routing
        const actualOutputType = nodeOutputs.get(`${node.id}::__actual_output_kind__`)?.outputType
        nodeOutputs.delete(`${node.id}::__actual_output_kind__`)
        const outputType = actualOutputType ?? ext?.output ?? (nodeInputPath ? 'mesh' : undefined)
        const nodeOutput = { filePath: nodeInputPath, text: nodeInputText, outputType }
        nodeOutputs.set(node.id, nodeOutput)
        rememberArtifactOutput(node.id, nodeOutput, artifactProvenance)

        // If this node feeds an Add-to-Scene, push the mesh to currentJob
        // immediately so the 3D viewer loads it without waiting for the rest of the run.
        const norm = nodeInputPath?.replace(/\\/g, '/')
        if (
          norm?.startsWith(workspaceDir) &&
          outputType === 'mesh' &&
          activeGraph.edges.some((e) => e.source === node.id && addToSceneNodeIds.has(e.target))
        ) {
          useAppStore.getState().updateCurrentJob({
            status:    'done',
            progress:  100,
            outputUrl: `/workspace/${norm.slice(workspaceDir.length).replace(/^\//, '')}`,
            previewKind: undefined,
          })
        }
        if (norm?.startsWith(workspaceDir)) {
          const outputUrl = `/workspace/${norm.slice(workspaceDir.length).replace(/^\//, '')}`
          if (activeGraph.edges.some((e) => e.source === node.id && addToWorldsNodeIds.has(e.target))) {
            await addWorkflowOutputUrlToWorlds(outputUrl, outputType)
          }
        }
      }

      // ── Collect media outputs for preview nodes ──────────────────────
      const imageOutputs: Record<string, string> = {}
      const videoOutputs: Record<string, string> = {}
      for (const [nodeId, out] of nodeOutputs) {
        if ((out.outputType === 'image' || out.outputType === 'video') && out.filePath) {
          const norm = out.filePath.replace(/\\/g, '/')
          if (norm.startsWith(workspaceDir)) {
            const workspaceUrl = `/workspace/${norm.slice(workspaceDir.length).replace(/^\//, '')}`
            if (out.outputType === 'image') imageOutputs[nodeId] = workspaceUrl
            if (out.outputType === 'video') videoOutputs[nodeId] = workspaceUrl
          }
        }
        if (maxIter > 0) loopExtraSteps += (maxIter - 1) * union.size
      }
      const totalSteps = preExecExtNodes.length + branchSteps + loopExtraSteps

      // ── Resolve final output URL ──────────────────────────────────────
      let outputUrl:  string | undefined
      let outputPath: string | undefined
      let artifact:   ArtifactRef | undefined

      // Use the last scene output node in topo order — its predecessor is the final scene mesh.
      const outputNodeDef = [...ordered].reverse().find((n) => sceneOutputNodeIds.has(n.id))
      if (outputNodeDef) {
        for (const edge of activeGraph.edges.filter((e) => e.target === outputNodeDef.id)) {
          const src = nodeOutputs.get(edge.source)
          if (src?.filePath) {
            artifact = nodeArtifacts.get(edge.source)
            const norm = src.filePath.replace(/\\/g, '/')
            if (norm.startsWith(workspaceDir)) {
              outputUrl = `/workspace/${norm.slice(workspaceDir.length).replace(/^\//, '')}`
            }
          }
        }
      }
      if (!outputUrl) {
        for (const node of execNodes) {
          const out = nodeOutputs.get(node.id)
          if (out?.filePath) {
            artifact = nodeArtifacts.get(node.id)
            const norm = out.filePath.replace(/\\/g, '/')
            if (norm.startsWith(workspaceDir)) {
              outputUrl = `/workspace/${norm.slice(workspaceDir.length).replace(/^\//, '')}`
            } else {
              outputPath = out.filePath
            }
          }
        }
      }

      set((s) => ({
        activeNodeId:     null,
        nodeImageOutputs: imageOutputs,
        nodeVideoOutputs: videoOutputs,
        landmarkSession:  undefined,
        waitCheckpointReview: undefined,
        runState: {
          status:        'done',
          blockIndex:    execNodes.length > 0 ? execNodes.length - 1 : 0,
          blockTotal:    execNodes.length,
          blockProgress: 100,
          blockStep:     'Done',
          outputUrl,
          outputPath,
          artifact,
          ...(s.runState.replacementResult !== undefined ? { replacementResult: s.runState.replacementResult } : {}),
        },
      }))
      useAppStore.getState().updateCurrentJob({
        status: 'done',
        progress: 100,
        step: undefined,
        outputUrl: artifact?.kind === 'mesh' ? outputUrl : undefined,
        previewKind: undefined,
      })

    } catch (err) {
      if (!_cancel.current) {
        clearPendingCheckpointState()
        clearCurrentJobCheckpointMetadata()
        set((s) => ({ runState: { ...s.runState, status: 'error', substitutionPoint: undefined, error: String(err) }, activeNodeId: null, pendingReplacement: undefined, landmarkSession: undefined, landmarkSidecars: {}, waitCheckpointReview: undefined }))
        useAppStore.getState().updateCurrentJob({ status: 'error', error: String(err) })
      }
    },

  cancel() {
    _cancel.current = true
    clearPendingCheckpointState()
    flushResume()
    if (_activeJobId.current) {
      const apiUrl = useAppStore.getState().apiUrl
      axios.create({ baseURL: apiUrl }).post(`/generate/cancel/${_activeJobId.current}`).catch(() => {})
      _activeJobId.current = null
    }
    clearCurrentJobCheckpointMetadata()
    set({ runState: IDLE, activeNodeId: null, activeWorkflowId: null, pendingReplacement: undefined, nodeImageOutputs: {}, nodeVideoOutputs: {}, nodeArtifacts: {}, artifactLineages: {}, landmarkSidecars: {}, landmarkSession: undefined, waitCheckpointReview: undefined })
  },

  reset() {
    clearPendingCheckpointState()
    clearCurrentJobCheckpointMetadata()
    set({ runState: IDLE, activeNodeId: null, activeWorkflowId: null, pendingReplacement: undefined, nodeImageOutputs: {}, nodeVideoOutputs: {}, nodeArtifacts: {}, artifactLineages: {}, landmarkSidecars: {}, landmarkSession: undefined, waitCheckpointReview: undefined })
  },

  continueRun(options) {
    const state = useWorkflowRunStore.getState()
    const pausedNodeId = state.runState.status === 'paused' ? state.runState.substitutionPoint?.nodeId : undefined
    if (pausedNodeId && state.activeNodeId === pausedNodeId && state.runState.blockStep === 'Paused — mark required landmarks') {
      if (!state.landmarkSession || state.landmarkSession.nodeId !== pausedNodeId) {
        const message = 'Landmark capture state is not active'
        set((s) => ({ runState: { ...s.runState, error: message } }))
        return
      }
      if (!state.landmarkSession.canContinue) {
        const message = landmarkMissingError(state.landmarkSession.validity.missing)
        set((s) => ({
          runState: { ...s.runState, error: message },
          landmarkSession: withLandmarkError(s.landmarkSession, message),
        }))
        return
      }
      set((s) => ({
        landmarkSession: s.landmarkSession
          ? { ...s.landmarkSession, error: undefined, sidecarStatus: 'pending-write' }
          : undefined,
      }))
    }
    _resumeOptions.current = options
    const resumed = flushResume()
    if (!resumed && pausedNodeId) {
      const message = 'Workflow checkpoint is not resumable in this renderer session. Restart the workflow from Generate.'
      set((s) => ({
        runState: { ...s.runState, error: message },
        landmarkSession: s.landmarkSession
          ? { ...s.landmarkSession, error: message, sidecarStatus: 'error' }
          : undefined,
      }))
    }
  },

  setPendingReplacement(replacement) {
    _pendingReplacement.current = replacement
    set({ pendingReplacement: replacement })
  },

  getPendingReplacement() {
    return _pendingReplacement.current
  },

  markLandmark(point) {
    set((s) => {
      if (!s.landmarkSession) return s
      return { landmarkSession: markLandmarkInSession(s.landmarkSession, point) }
    })
  },

  selectLandmarkForEditing(id) {
    set((s) => {
      if (!s.landmarkSession) return s
      return {
        landmarkSession: {
          ...s.landmarkSession,
          activeLandmarkId: id,
          error: undefined,
        },
      }
    })
  },

  resetLandmarks(nodeId) {
    set((s) => {
      if (nodeId && s.landmarkSession?.nodeId !== nodeId) return s
      if (!s.landmarkSession) return s
      const workflowId = s.activeWorkflowId ?? 'workflow'
      return {
        runState: { ...s.runState, error: undefined },
        landmarkSession: resetLandmarksInSession(s.landmarkSession, workflowId),
      }
    })
  },
}))

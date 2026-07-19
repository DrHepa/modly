import { buildProcessExecutionInput } from './processExecution'
import { getPositionalInputTypes, getProcessTargetPorts, hasNamedProcessInputs } from './processPorts'
import { create } from 'zustand'
import axios, { AxiosInstance } from 'axios'
import { useAppStore } from '@shared/stores/appStore'
import { resolveWorkflowDispatch } from './workflowDispatch'
import { hasUnsupportedSceneShape } from './sceneShape'
import { resolveSceneSourceManifest } from './workflowSceneSource'
import { addWorkflowOutputUrlToWorlds } from './workflowWorldsOutput.ts'
import { showCompletionNotification, showErrorNotification } from '@shared/utils/notification'
import type { WorkflowExtension } from './mockExtensions'
import type { Workflow, WFNode, WFEdge, HumanoidDraftSidecarReadResult, HumanoidPromotionSidecarReadResult, RigMetaSidecarReadResult } from '@shared/types/electron.d'
import { isBranchStarter, isSceneOutput, resolveDataSource, reachesSceneOutput, nearestUpstreamWaits } from './nodeBehaviors'
import { assignSlotFilePaths } from './slotInputs'
import { hydrateWorkflowNodeParams, resolveWorkflowPrompt } from './workflowNodeParams'
import type { SlotInputType } from './slotInputs'

import type { ArtifactRef, ArtifactLineage, ArtifactProvenance, ArtifactSubstitutionPoint, ArtifactReplacementResult } from '../../shared/types/artifacts'
import {
  artifactRefToLegacyOutput, legacyOutputToArtifactRef, createArtifactLineage,
  createDeclaredArtifactSubstitutionPoint, resolveArtifactReplacement, buildWaitArtifactLineage,
  buildWaitReplacementArtifactRef, sameCheckpointOwner, buildLandmarkSidecarLineageMetadata,
  type CheckpointOwner, type CheckpointContinueOptions, type LandmarkSidecarLineageMetadata,
} from './workflowArtifacts'
import {
  REQUIRED_LANDMARK_IDS, isLandmarkId, isLandmarkCaptureComplete, getMissingRequiredLandmarkIds,
  createLandmarkCaptureIdentity, buildLandmarkSidecarV1, validateLandmarkSidecarV1,
  type LandmarkCaptureState, type LandmarkCaptureIdentity, type LandmarkPoint, type LandmarkId,
} from './landmarks'

export interface WorkflowLandmarkSession extends Omit<LandmarkCaptureState, 'sidecarPath'>, LandmarkCaptureIdentity {
  sidecarStatus: 'not_started' | 'pending-write' | 'ready' | 'error'
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

export interface WorkflowCheckpoint {
  humanoidReview?: { owner: CheckpointOwner; state: WaitCheckpointReviewState }
  owner: CheckpointOwner
  input?: NodeOutput
  substitutionPoint?: ArtifactSubstitutionPoint
  pendingReplacement?: ArtifactRef
  replacementResult?: ArtifactReplacementResult
  lineage?: ArtifactLineage
  landmarkCapture?: WorkflowLandmarkSession
  landmarkSidecar?: LandmarkSidecarLineageMetadata
}
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

let executionEpoch = 0
const _cancel      = { current: false }
const _activeJobId = { current: null as string | null }
// While container (manual mode) pause/resume — set by continueWhile()/retryWhile().
const _resume      = { current: null as (() => void) | null }
const _retry       = { current: false }
// For Each auto-loop: the user asked to pause at the next iteration boundary.
const _pauseRequested = { current: false }
// Live node params — the UI pushes edits here so a looping/paused run re-reads the
// latest values when a body node starts (instead of the snapshot from run start).
const _liveParams  = { current: new Map<string, Record<string, unknown>>() }

function flushResume(): void {
  const fn = _resume.current
  _resume.current = null
  if (fn) fn()
}

interface NodeOutput { filePath?: string; text?: string; outputType?: string }

function isSceneMeshOutput(output: NodeOutput | undefined): output is NodeOutput & { filePath: string } {
  return output?.outputType === 'mesh' && typeof output.filePath === 'string'
}

function normalizeWorkflowPath(filePath: string, workspaceDir: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const workspace = workspaceDir.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.startsWith(`${workspace}/`) ? normalized.slice(workspace.length + 1) : normalized
}

// ─── For Each iterator (image / text / mesh) ───────────────────────────────────
// A "For Each" node walks a folder alphabetically and emits one file per loop
// iteration. Its loop body = the executable nodes reachable downstream, which
// re-run for every file. The `mode` param picks what it emits and which files it
// matches.

const FOR_EACH_MODES: Record<string, { exts: string[]; outputType: 'image' | 'text' | 'mesh' }> = {
  image: { exts: ['png', 'jpg', 'jpeg', 'webp'],              outputType: 'image' },
  text:  { exts: ['txt', 'md', 'prompt'],                     outputType: 'text'  },
  mesh:  { exts: ['glb', 'gltf', 'obj', 'stl', 'ply', 'fbx'], outputType: 'mesh'  },
}

function iteratorConfig(node: WFNode): { exts: string[]; outputType: 'image' | 'text' | 'mesh' } {
  return FOR_EACH_MODES[(node.data.params?.mode as string) ?? 'image'] ?? FOR_EACH_MODES.image
}

function isIterator(type: string | undefined): boolean {
  return type === 'forEachNode'
}

/** True for nodes the runner executes (and can re-run inside a loop body). */
function isExecutable(node: WFNode): boolean {
  if (isIterator(node.type)) return true
  return node.type === 'extensionNode' && node.data.enabled !== false
}

/** Absolute, alphabetically-sorted paths of an iterator's files (listFiles sorts). */
async function listIteratorFiles(dir: string, exts: string[]): Promise<string[]> {
  const names = await window.electron.fs.listFiles(dir, exts)
  const norm  = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  return names.map((n) => `${norm}/${n}`)
}

/** Read a UTF-8 text file through the base64 IPC bridge. */
async function readTextFile(filePath: string): Promise<string> {
  const b64 = await window.electron.fs.readFileBase64(filePath)
  return new TextDecoder('utf-8').decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
}

/**
 * Executable nodes reachable downstream from `startId` (its loop body). Traversal
 * stops at Wait boundaries — those nodes belong to branches, not the pre-phase loop.
 */
function reachableExecutable(startId: string, edges: WFEdge[], nodeMap: Map<string, WFNode>): Set<string> {
  const body = new Set<string>([startId])
  const stack = [startId]
  const seen = new Set<string>([startId])
  while (stack.length > 0) {
    const id = stack.pop()!
    for (const e of edges) {
      if (e.source !== id || seen.has(e.target)) continue
      seen.add(e.target)
      const t = nodeMap.get(e.target)
      if (!t || isBranchStarter(t.type)) continue
      if (isExecutable(t)) body.add(e.target)
      stack.push(e.target)
    }
  }
  return body
}

function toWorkspaceUrl(filePath: string, workspaceDir: string): string | undefined {
  const norm = filePath.replace(/\\/g, '/')
  if (!norm.startsWith(workspaceDir)) return undefined
  return `/workspace/${norm.slice(workspaceDir.length).replace(/^\//, '')}`
}

// Inverse of toWorkspaceUrl — used by node components that read a `/workspace/...`
// output URL back off disk (e.g. to build a data: URL for a preview).
export function fromWorkspaceUrl(url: string, workspaceDir: string): string {
  const wsDir = workspaceDir.replace(/\\/g, '/').replace(/\/+$/, '')
  const rel   = url.replace(/^\/workspace\//, '')
  return `${wsDir}/${rel}`
}

interface RunContext {
  runId: string
  epoch: number
  jobId: string
  checkpoints: Map<string, WorkflowCheckpoint>
  nodeArtifacts: Map<string, ArtifactRef>
  outputRevisions: Map<string, number>
  checkpointRevision: number
  reviewRequests: Map<string, symbol>
  workflow:           Workflow
  allExtensions:      WorkflowExtension[]
  client:             AxiosInstance
  workspaceDir:       string
  selectedImagePath:  string | undefined
  selectedImageData?: string
  overrideImageData?: string
  nodeOutputs:        Map<string, NodeOutput>
  nodeMap:            Map<string, WFNode>
  /** nodes in execution (topological) order */
  ordered:            WFNode[]
  branches:           Map<string, WFNode[]>
  waitIds:            string[]
  /** waitId → nearest upstream waitId (null = top-level, runnable from the start) */
  parentWait:         Map<string, string | null>
  /** iterator node id → its resolved file paths, one per loop iteration */
  iteratorFiles:      Map<string, string[]>
  /** workspace URL of the most recently pushed scene mesh (last branch the user ran wins) */
  lastSceneMesh?:     string
}
const _ctx = { current: null as RunContext | null }

function isCurrentContext(ctx: RunContext): boolean {
  return _ctx.current === ctx && executionEpoch === ctx.epoch && !_cancel.current
}

function assertCurrentContext(ctx: RunContext): void {
  if (!isCurrentContext(ctx)) throw new Error('Stale workflow execution')
}

function updateOwnedJob(ctx: RunContext, patch: Parameters<ReturnType<typeof useAppStore.getState>['updateCurrentJob']>[0]): void {
  if (isCurrentContext(ctx) && useAppStore.getState().currentJob?.id === ctx.jobId) {
    useAppStore.getState().updateCurrentJob(patch)
  }
}

function recordNodeArtifact(ctx: RunContext, nodeId: string, provenance?: ArtifactProvenance): void {
  const revision = (ctx.outputRevisions.get(nodeId) ?? 0) + 1
  ctx.outputRevisions.set(nodeId, revision)
  const artifact = legacyOutputToArtifactRef(ctx.nodeOutputs.get(nodeId), {
    artifactId: `${ctx.runId}:${nodeId}`, versionId: `${ctx.runId}:${nodeId}:${revision}`,
    provenance,
  })
  if (artifact && artifactRefToLegacyOutput(artifact)) ctx.nodeArtifacts.set(nodeId, artifact)
  else ctx.nodeArtifacts.delete(nodeId)
}

function incomingCheckpointSource(ctx: RunContext, nodeId: string): string | undefined {
  const edge = ctx.workflow.edges.find((edge) => edge.target === nodeId)
  return edge && resolveDataSource(edge.source, ctx.workflow.edges, ctx.nodeMap, ctx.nodeOutputs)
}

function materializeCheckpoint(ctx: RunContext, nodeId: string): WorkflowCheckpoint {
  const sourceId = incomingCheckpointSource(ctx, nodeId)
  const input = sourceId ? ctx.nodeOutputs.get(sourceId) : undefined
  const artifact = sourceId ? ctx.nodeArtifacts.get(sourceId) : undefined
  const owner: CheckpointOwner = {
    runId: ctx.runId, nodeId, inputArtifactId: artifact?.id ?? `${ctx.runId}:${sourceId ?? nodeId}`,
    inputVersionId: artifact?.versionId ?? `${ctx.runId}:${sourceId ?? nodeId}:${ctx.outputRevisions.get(sourceId ?? '') ?? 0}`,
    revision: ++ctx.checkpointRevision,
  }
  const checkpoint: WorkflowCheckpoint = {
    owner, input: input && { ...input },
    substitutionPoint: artifact && createDeclaredArtifactSubstitutionPoint({ nodeId, inputArtifact: artifact }),
    lineage: artifact && createArtifactLineage(artifact),
  }
  if (ctx.nodeMap.get(nodeId)?.type === 'landmarksNode') {
    if (artifact?.kind !== 'mesh') throw new Error('Landmarks node requires a mesh checkpoint input')
    checkpoint.landmarkCapture = {
      ...createLandmarkCaptureIdentity(ctx.runId, nodeId), nodeId, targetArtifact: artifact,
      activeLandmarkId: REQUIRED_LANDMARK_IDS[0], completed: {},
      validity: { valid: false, missing: [...REQUIRED_LANDMARK_IDS] }, canContinue: false,
      sidecarStatus: 'not_started',
    }
  }
  ctx.checkpoints.set(nodeId, checkpoint)
  // Materialization is branch-local. Never replace the shared upstream output.
  if (input) ctx.nodeOutputs.set(nodeId, { ...input })
  if (artifact) ctx.nodeArtifacts.set(nodeId, artifact)
  return checkpoint
}

function runtimeCheckpointOutput(output: NodeOutput, workspaceDir: string): NodeOutput {
  if (!output.filePath) return { ...output }
  let filePath = output.filePath.replace(/\\/g, '/')
  if (filePath.startsWith('/workspace/')) filePath = fromWorkspaceUrl(filePath, workspaceDir)
  else if (!filePath.startsWith('/') && !/^[A-Za-z]:\//.test(filePath)) {
    if (filePath.split('/').some((part) => !part || part === '.' || part === '..') || filePath.includes(':')) throw new Error('Invalid checkpoint artifact path')
    filePath = `${workspaceDir.replace(/\/+$/, '')}/${filePath}`
  }
  return { ...output, filePath }
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

// Only the resolved capability and its declared consumed port own this adapter.
// Display names and the legacy positional dialect are not semantic authority.
function isHumanoidConsumer(ext: WorkflowExtension): boolean {
  return ext.extensionId === 'kimodo-soma-rp' && ext.nodeId === 'animate-rigged-mesh'
    && (ext.type === 'process' || ext.input === 'text') && hasNamedProcessInputs(ext.inputs)
    && ext.inputs.some((port) => port.name === 'rigged_mesh' && port.type === 'mesh')
}

function checkpointFeedsHumanoid(ctx: RunContext, waitId: string): boolean {
  return ctx.workflow.nodes.some((node) => {
    if (node.type !== 'extensionNode' || !node.data.enabled) return false
    const ext = ctx.allExtensions.find((candidate) => candidate.id === node.data.extensionId)
    if (!ext || !isHumanoidConsumer(ext)) return false
    if (ext.type === 'process') {
      const input = buildProcessExecutionInput({ node, nodes: ctx.workflow.nodes, edges: ctx.workflow.edges,
        allExtensions: ctx.allExtensions, nodeOutputs: ctx.nodeOutputs }).inputs?.rigged_mesh
      return input?.type === 'mesh' && input.sourceNodeId === waitId && !!input.filePath
    }
    let source: string | undefined
    for (const edge of ctx.workflow.edges) {
      if (edge.target !== node.id || edge.targetHandle !== 'rigged_mesh') continue
      const id = resolveDataSource(edge.source, ctx.workflow.edges, ctx.nodeMap, ctx.nodeOutputs)
      const output = id ? ctx.nodeOutputs.get(id) : undefined
      if (output?.outputType === 'mesh' && output.filePath?.trim()) source = id
    }
    return source === waitId
  })
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

export function shouldUsePreviousNodeFallback(input: WorkflowExtension['input']): boolean {
  return input !== 'none'
}

function resolveModelNodeOutputKind(args: {
  declaredOutput?: string
  actualOutput?: ArtifactRef['kind']
  extensionId: string
}): string | undefined {
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
  const { ext, node, nodeParams } = args

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

  throw new Error(`Model ${ext.id} does not declare input "none"`)
}

function humanoidWorkspacePath(filePath: string | undefined, workspaceDir: string): string | undefined {
  if (!filePath) return undefined
  const relative = normalizeWorkflowPath(filePath, workspaceDir).replace(/^\/workspace\//, '')
  if (!relative || relative.startsWith('/') || relative.includes(':')
    || relative.split('/').some((part) => !part || part === '.' || part === '..')
    || !/\.gl(?:b|tf)$/i.test(relative)) return undefined
  return relative
}

function captureHumanoidReaders() {
  const ports = window.electron?.workspace?.artifacts
  return {
    rig: typeof ports?.readRigMetaSidecar === 'function' ? ports.readRigMetaSidecar.bind(ports) : undefined,
    draft: typeof ports?.readHumanoidDraftSidecar === 'function' ? ports.readHumanoidDraftSidecar.bind(ports) : undefined,
    promotion: typeof ports?.readHumanoidPromotionSidecar === 'function' ? ports.readHumanoidPromotionSidecar.bind(ports) : undefined,
  }
}

async function boundedReviewRead<T>(read: (() => Promise<T>) | undefined, name: string): Promise<{ result?: T; diagnostic?: string }> {
  if (!read) return { diagnostic: `${name} reader is unavailable.` }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // A missing response must not hold Continue indefinitely. Rejections are
    // attached immediately, including if the timeout wins the race.
    const result = await Promise.race([
      Promise.resolve().then(read),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} reader timed out.`)), 5000) }),
    ])
    return { result }
  } catch (error) {
    return { diagnostic: `${name}: ${String(error)}` }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function readWaitCheckpointHumanoidReview(filePath: string | undefined, workspaceDir: string): Promise<WaitCheckpointReviewState> {
  const meshWorkspacePath = humanoidWorkspacePath(filePath, workspaceDir)
  const readers = captureHumanoidReaders()
  if (!meshWorkspacePath) {
    const review = resolveWaitCheckpointHumanoidReview({ meshWorkspacePath: '' })
    return { ...review, diagnostics: ['Humanoid review requires a workspace GLB or GLTF mesh.'] }
  }
  const [rig, draft, promotion] = await Promise.all([
    boundedReviewRead(readers.rig && (() => readers.rig!({ sourceWorkspacePath: meshWorkspacePath })), 'Rig metadata'),
    boundedReviewRead(readers.draft && (() => readers.draft!({ meshWorkspacePath })), 'Humanoid draft'),
    boundedReviewRead(readers.promotion && (() => readers.promotion!({ meshWorkspacePath })), 'Humanoid promotion'),
  ])
  const review = resolveWaitCheckpointHumanoidReview({ meshWorkspacePath,
    rigMetaResult: rig.result, draftResult: draft.result, promotionResult: promotion.result })
  return { ...review, diagnostics: [...review.diagnostics, ...[rig, draft, promotion].flatMap((read) => read.diagnostic ? [read.diagnostic] : [])] }
}

function clearHumanoidAuthority(params: Record<string, unknown>): void {
  delete params.humanoid_input_status
  delete params.humanoid_promotion_sidecar_path
}

async function readCurrentHumanoidParams(ctx: RunContext, filePath: string | undefined): Promise<Record<string, string>> {
  const meshWorkspacePath = humanoidWorkspacePath(filePath, ctx.workspaceDir)
  const { promotion } = captureHumanoidReaders()
  if (!meshWorkspacePath) return {}
  const { result } = await boundedReviewRead(promotion && (() => promotion({ meshWorkspacePath })), 'Humanoid promotion')
  assertCurrentContext(ctx)
  // Main validates physical source, output, draft and receipts. Do not add a
  // competing renderer schema or infer solver trust from rig labels/booleans.
  return isHumanoidPromotionFound(result) ? {
    humanoid_input_status: 'manual_confirmed', humanoid_promotion_sidecar_path: result.sidecarWorkspacePath,
  } : {}
}

function incomingLandmarkSidecar(ctx: RunContext, nodeId: string): string | undefined {
  for (const edge of ctx.workflow.edges.filter((edge) => edge.target === nodeId)) {
    const source = resolveDataSource(edge.source, ctx.workflow.edges, ctx.nodeMap, ctx.nodeOutputs)
    const checkpoint = source ? ctx.checkpoints.get(source) : undefined
    if (checkpoint?.landmarkSidecar) return checkpoint.landmarkSidecar.sidecarWorkspacePath
  }
  return undefined
}

function consumesLandmarks(ext: WorkflowExtension): boolean {
  // Capability identity, never a translated/display name, controls this narrow adapter.
  return [ext.extensionId, ext.nodeId].some((id) => /(?:^|[-_/])(unirig|uni-rig|rig-mesh|rig_mesh)(?:$|[-_/])/.test(id))
}

// ─── While container geometry ──────────────────────────────────────────────────
// Body membership can't rely on parentId alone: React Flow only assigns it when a
// node is dragged into the container, so a While resized around existing nodes (or
// nodes added by palette click) leaves them unparented. We therefore also test
// on-canvas containment at run time.

interface WhileBounds { x: number; y: number; w: number; h: number }

function nodeSize(n: WFNode): { w: number; h: number } {
  const measured = (n as { measured?: { width?: number; height?: number } }).measured
  const styleW = n.style?.width
  const styleH = n.style?.height
  return {
    w: measured?.width  ?? n.width  ?? (typeof styleW === 'number' ? styleW : 200),
    h: measured?.height ?? n.height ?? (typeof styleH === 'number' ? styleH : 80),
  }
}

function whileBounds(w: WFNode): WhileBounds {
  const s = nodeSize(w)
  return { x: w.position.x, y: w.position.y, w: s.w, h: s.h }
}

function isInsideWhile(n: WFNode, whileId: string, b: WhileBounds): boolean {
  if (n.parentId === whileId) return true
  if (n.parentId) return false   // explicit child of another container
  const s = nodeSize(n)
  const cx = n.position.x + s.w / 2
  const cy = n.position.y + s.h / 2
  return cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h
}

// ─── Branch identification ────────────────────────────────────────────────────
// A node belongs to Wait W's branch if its single nearest upstream Wait is W
// (dominance). Nodes with no upstream Wait — or with multiple (merges) — execute
// in the pre-phase before any user pause.

function identifyBranches(workflow: Workflow): {
  preExecExtNodes: WFNode[]
  branches:        Map<string, WFNode[]>
  waitIds:         string[]
  parentWait:      Map<string, string | null>
  ordered:         WFNode[]
} {
  const ordered = topoSortWorkflowNodes(workflow.nodes, workflow.edges)
  const nodeMap = new Map(workflow.nodes.map((n) => [n.id, n]))
  const waitIds = ordered.filter((n) => isBranchStarter(n.type)).map((n) => n.id)

  // A node is owned by its single nearest upstream Wait (dominance). This lets
  // Wait → … → Wait chains nest: nodes after the 2nd Wait belong to it, not the 1st.
  const branchOwner = new Map<string, string>()
  for (const node of workflow.nodes) {
    if (isBranchStarter(node.type) || !isExecutable(node)) continue
    const nearest = nearestUpstreamWaits(node.id, workflow.edges, nodeMap)
    if (nearest.size === 1) branchOwner.set(node.id, [...nearest][0])
  }

  // Each Wait's parent = its own nearest upstream Wait (null if top-level).
  const parentWait = new Map<string, string | null>()
  for (const w of waitIds) {
    const nearest = nearestUpstreamWaits(w, workflow.edges, nodeMap)
    parentWait.set(w, nearest.size === 1 ? [...nearest][0] : null)
  }

  const branches = new Map<string, WFNode[]>()
  for (const w of waitIds) branches.set(w, [])
  const preExecExtNodes: WFNode[] = []
  for (const node of ordered) {
    if (!isExecutable(node)) continue
    const owner = branchOwner.get(node.id)
    if (owner) branches.get(owner)!.push(node)
    else preExecExtNodes.push(node)
  }

  return { preExecExtNodes, branches, waitIds, parentWait, ordered }
}

// ─── For Each iterator execution ───────────────────────────────────────────────
// Emits the current iteration's file. Image iterators emit an image path; text
// iterators read the file and emit its text. The iteration index comes from the
// loop's progress (its own node id keys the loop).

async function executeIteratorNode(
  node:        WFNode,
  ctx:         RunContext,
  setRunState: (updater: (s: WorkflowRunState) => WorkflowRunState) => void,
): Promise<void> {
  const files   = ctx.iteratorFiles.get(node.id) ?? []
  const current = useWorkflowRunStore.getState().whileProgress[node.id]?.current ?? 1
  const path    = files[current - 1]
  if (!path) throw new Error('For Each: no file for this iteration')

  const kind = iteratorConfig(node)
  const name = path.split(/[\\/]/).pop()
  setRunState((s) => ({ ...s, blockProgress: 30, blockStep: `Reading ${name}` }))

  if (kind.outputType === 'text') {
    const text = await readTextFile(path)
    assertCurrentContext(ctx)
    ctx.nodeOutputs.set(node.id, { text, outputType: 'text' })
  } else {
    ctx.nodeOutputs.set(node.id, { filePath: path, outputType: kind.outputType })
  }
  recordNodeArtifact(ctx, node.id)
  setRunState((s) => ({ ...s, blockProgress: 100, blockStep: `Loaded ${name}` }))
}

// ─── Per-node execution ──────────────────────────────────────────────────────
// Resolves inputs (walking through Wait passthroughs), runs the extension
// (model or process), updates nodeOutputs, and pushes the mesh to the scene
// if it feeds an Add-to-Scene through Waits.

async function executeExtensionNode(
  node:        WFNode,
  ctx:         RunContext,
  setRunState: (updater: (s: WorkflowRunState) => WorkflowRunState) => void,
): Promise<void> {
  assertCurrentContext(ctx)
  if (isIterator(node.type)) {
    await executeIteratorNode(node, ctx, setRunState)
    return
  }

  const { workflow, allExtensions, client, workspaceDir, nodeOutputs, nodeMap,
          selectedImagePath, selectedImageData } = ctx

  const { ext, mode } = resolveWorkflowDispatch(node, allExtensions)
  if (hasUnsupportedSceneShape(ext)) {
    throw new Error(`${ext.name} uses an unsupported scene input or output declaration`)
  }
  // Freshest params at the moment the node starts (so loop iterations / Retry pick
  // up edits made while paused, not the values captured at run start).
  const rawParams = _liveParams.current.get(node.id) ?? node.data.params ?? {}
  const liveParams = hydrateWorkflowNodeParams(ext, rawParams)

  const resolveSource = (sourceId: string): NodeOutput | undefined => {
    const realId = resolveDataSource(sourceId, workflow.edges, nodeMap, nodeOutputs)
    return realId ? nodeOutputs.get(realId) : undefined
  }

  let nodeInputPath:     string | undefined
  let nodeInputText:     string | undefined
  let nodeInputMeshPath: string | undefined
  let nodeInputScenePath: string | undefined
  // Per-slot texts for multi-text-input nodes (e.g. positive/negative prompts).
  // Indexed by target handle: input-0 → texts[0], input-1 → texts[1].
  const nodeInputTexts: (string | undefined)[] = []
  // Every image beyond the first resolved slot, for extensions that take several
  // (e.g. a texture node taking a mesh plus multiple reference images).
  const extraImagePaths: string[] = []

  const incomingEdges = workflow.edges.filter((e) => e.target === node.id)
  const isInputless = mode === 'model' && ext.input === 'none'
  const positionalInputs = !isInputless ? getPositionalInputTypes(ext) : undefined
  const hasNamedInputs = ext?.type === 'process' && hasNamedProcessInputs(ext.inputs)
  const scenePositional = mode === 'process' && !hasNamedInputs
    && (ext.input === 'scene' || positionalInputs?.includes('scene'))
  // This adapter is only the named front/side image MODEL contract, not a
  // generic named-input ABI and not the named PROCESS transport below.
  const namedModelImagePorts = mode === 'model' && ext.input === 'image' && hasNamedProcessInputs(ext.inputs)
    ? new Set(ext.inputs.filter((port) => port.type === 'image' && ['front', 'left', 'back', 'right'].includes(port.name)).map((port) => port.name))
    : new Set<string>()
  const routedSideParams: Record<string, string> = {}

  if (namedModelImagePorts.size > 0) {
    let legacyImagePath: string | undefined
    for (const edge of incomingEdges) {
      const src = resolveSource(edge.source)
      if (src?.text !== undefined && src.text.trim().length > 0) nodeInputText = src.text
      const handle = edge.targetHandle
      if (src?.outputType !== 'image' || !src.filePath) continue
      if (handle == null) {
        legacyImagePath = src.filePath
        continue
      }
      if (!namedModelImagePorts.has(handle)) continue
      if (handle === 'front') nodeInputPath = src.filePath
      else routedSideParams[`${handle}_image_path`] = src.filePath
    }
    // Named front wins regardless of edge order; sides never replace primary.
    nodeInputPath ??= legacyImagePath
  } else if (positionalInputs && positionalInputs.length > 1) {
    // MODEL shape is checked above; PROCESS retains the physical slot indices.
    const inputTypes = positionalInputs as SlotInputType[]
    // Resolved by target handle first, then typed by that slot's declared input --
    // not by the arrival order of `incomingEdges`, which does not match slot order.
    const inputPaths  = new Array<string | undefined>(inputTypes.length).fill(undefined)

    for (const edge of incomingEdges) {
      const src = resolveSource(edge.source)
      if (!src) continue
      const slotMatch = /^input-(\d+)$/.exec(edge.targetHandle ?? '')
      const slot = slotMatch ? Number(slotMatch[1]) : 0
      if (src.filePath !== undefined && slot < inputTypes.length) inputPaths[slot] = src.filePath
      if (src.text !== undefined && src.text.trim().length > 0) {
        nodeInputText = src.text
        if (slotMatch) nodeInputTexts[slot] = src.text
      }
    }

    const slots = assignSlotFilePaths(inputTypes, inputPaths)
    nodeInputPath     = slots.nodeInputPath
    nodeInputMeshPath = slots.nodeInputMeshPath
    extraImagePaths.push(...slots.extraImagePaths)
  } else if (shouldUsePreviousNodeFallback(ext.input)) {
    for (const edge of incomingEdges) {
      const src = resolveSource(edge.source)
      if (src?.filePath !== undefined) nodeInputPath = src.filePath
      if (src?.text !== undefined && src.text.trim().length > 0) nodeInputText = src.text
      if (src?.outputType === 'scene') nodeInputScenePath = src.filePath
    }
  }

  let actualOutputType: string | undefined
  if (mode === 'model') {
    if (!ext.input && !positionalInputs?.length) throw new Error(`Missing workflow capability input metadata for extension: ${ext.id}`)
    const isSceneInput = positionalInputs ? positionalInputs.includes('scene') : ext?.input === 'scene'
    const isTextInput = positionalInputs ? positionalInputs.every((i) => i === 'text') : ext?.input === 'text'
    if (isSceneInput && !nodeInputScenePath) throw new Error(`${ext?.name ?? 'Model'} needs an incoming scene connection`)
    const namedModelInputs = !isInputless && hasNamedProcessInputs(ext.inputs) ? ext.inputs : []
    const meshPorts = namedModelInputs.filter((port) => port.type === 'mesh')
    const meshPaths = new Map<string, string>()
    for (const edge of incomingEdges) {
      if (!meshPorts.some((port) => port.name === edge.targetHandle)) continue
      const src = resolveSource(edge.source)
      if (src?.outputType === 'mesh' && src.filePath?.trim()) meshPaths.set(edge.targetHandle!, src.filePath)
    }
    // A declared prompt port owns its connected text (including blank values).
    // Legacy text models and unrelated named/mixed declarations keep their ABI.
    const promptPort = isTextInput && namedModelInputs.find((port) => port.name === 'prompt' && port.type === 'text')
    if (promptPort) {
      nodeInputText = undefined
      for (const edge of incomingEdges) {
        if (edge.targetHandle !== promptPort.name) continue
        const src = resolveSource(edge.source)
        if (src?.text !== undefined && (!src.outputType || src.outputType === 'text')) nodeInputText = src.text
      }
    }
    const activeImagePath = (isInputless || isTextInput || isSceneInput) ? undefined : (nodeInputPath ?? selectedImagePath)
    if (!isInputless && !isTextInput && !isSceneInput && !selectedImageData && (!activeImagePath || activeImagePath.trim().length === 0)) {
      throw new Error('No input image selected for model node')
    }

    let blob: Blob | undefined
    let fname = 'image.png'
    if (!isInputless && !isTextInput && !isSceneInput && selectedImageData && nodeInputPath === undefined) {
      fname = 'placeholder.png'
      blob = new Blob([Uint8Array.from(atob(selectedImageData), (c) => c.charCodeAt(0))], { type: 'image/png' })
    } else if (!isInputless && !isTextInput && !isSceneInput) {
      const base64 = await window.electron.fs.readFileBase64(activeImagePath as string)
      assertCurrentContext(ctx)
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      blob = new Blob([bytes], { type: 'image/png' })
      fname = activeImagePath?.split(/[\\/]/).pop() ?? 'image.png'
    }

    const extraParams: Record<string, unknown> = {}
    const sidecar = consumesLandmarks(ext) ? incomingLandmarkSidecar(ctx, node.id) : undefined
    if (sidecar) extraParams.landmarks_sidecar_path = sidecar
    if (nodeInputMeshPath) {
      extraParams.mesh_path = normalizeWorkflowPath(nodeInputMeshPath, workspaceDir)
    }
    if (nodeInputText !== undefined && nodeInputText.trim().length > 0) {
      extraParams.prompt = nodeInputText
      extraParams.text   = nodeInputText
    }
    if (extraImagePaths.length > 0) {
      extraParams.extra_image_paths = extraImagePaths
    }

    const effectiveParams = { ...liveParams }
    if (isHumanoidConsumer(ext)) clearHumanoidAuthority(effectiveParams)
    if (namedModelImagePorts.size > 0) {
      // Only declared image side ports reserve these keys. Other models and
      // undeclared sides retain their ordinary user parameters.
      for (const side of ['left', 'back', 'right']) {
        if (namedModelImagePorts.has(side)) delete effectiveParams[`${side}_image_path`]
      }
      Object.assign(effectiveParams, routedSideParams)
    }

    setRunState((s) => ({ ...s, blockProgress: 5, blockStep: 'Submitting to model…' }))
    let submission: { data: { job_id: string } }
    if (isInputless) {
      const request = buildModelGenerationRequest({ ext, node, nodeParams: effectiveParams, workspaceDir })
      if (request.kind === 'none') submission = await client.post('/generate/from-none', request.payload)
      else throw new Error('Expected inputless model request')
    } else if (isSceneInput) {
      const normalized = nodeInputScenePath!.replace(/\\/g, '/')
      const inputPath = normalized.startsWith(`${workspaceDir}/`)
        ? normalized.slice(workspaceDir.length + 1)
        : normalized.replace(/^\/workspace\//, '')
      submission = await client.post('/generate/from-artifact', {
        input_kind: 'scene', input_path: inputPath,
        model_id: node.data.extensionId ?? '', collection: 'Workflows',
        params: { ...effectiveParams, ...extraParams },
      })
    } else if (isTextInput) {
      const { prompt: _prompt, ...params } = effectiveParams
      const isRiggedMotion = ext.input === 'text' && isHumanoidConsumer(ext)
      const explicitMotion = isRiggedMotion && Object.hasOwn(rawParams, 'prompt') && typeof rawParams.prompt === 'string'
        ? rawParams.prompt : undefined
      const resolvedPrompt = explicitMotion ?? resolveWorkflowPrompt(effectiveParams, nodeInputText)
      const prompt = isRiggedMotion ? resolvedPrompt.trim() : resolvedPrompt
      if ((explicitMotion !== undefined || (promptPort && promptPort.required !== false)) && !prompt.trim()) {
        throw new Error(`Missing required ${isRiggedMotion ? 'motion prompt' : 'prompt'} input for extension ${ext.id}`)
      }
      if (isRiggedMotion) {
        extraParams.motion_prompt = prompt
        // Keep existing wire aliases coherent, without changing ordinary MODELs.
        if (Object.hasOwn(extraParams, 'prompt')) extraParams.prompt = prompt
        if (Object.hasOwn(extraParams, 'text') || Object.hasOwn(params, 'text')) extraParams.text = prompt
        delete params.character_prompt
        const characterPrompt = nodeInputText?.trim()
        if (explicitMotion !== undefined && characterPrompt && characterPrompt !== prompt) extraParams.character_prompt = characterPrompt
      }
      // This is the specialized text + rigged_mesh adapter, not a multi-mesh ABI.
      const riggedMeshPath = meshPaths.get('rigged_mesh')
      if (riggedMeshPath) {
        const normalized = normalizeWorkflowPath(riggedMeshPath, workspaceDir)
        extraParams.rigged_mesh_path = normalized
        extraParams.mesh_path = normalized
        extraParams.node_id = ext.nodeId
        extraParams.model_id = ext.id
      }
      if (isHumanoidConsumer(ext)) {
        Object.assign(extraParams, await readCurrentHumanoidParams(ctx, riggedMeshPath))
        assertCurrentContext(ctx)
      }
      submission = await client.post('/generate/from-text', {
        prompt, model_id: ext.id, collection: 'Workflows',
        remesh: 'none', enable_texture: false, texture_resolution: 1024,
        params: { ...params, ...extraParams },
      })
    } else {
      const fd = new FormData()
      fd.append('image', blob!, fname)
      fd.append('model_id', node.data.extensionId ?? '')
      fd.append('collection', 'Workflows')
      fd.append('remesh', 'none')
      fd.append('enable_texture', 'false')
      fd.append('texture_resolution', '1024')
      fd.append('params', JSON.stringify({ ...effectiveParams, ...extraParams }))
      submission = await client.post('/generate/from-image', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
    }
    const { data } = submission
    if (!isCurrentContext(ctx)) {
      // Cancellation can precede the submission acknowledgement. Clean up only
      // this invocation's returned job through its own client, never the global
      // active id, which may already belong to a newer run.
      const backendJobId: unknown = data?.job_id
      if (typeof backendJobId === 'string' && backendJobId.trim().length > 0) {
        try { await client.post(`/generate/cancel/${backendJobId}`) } catch { /* Best-effort cleanup. */ }
      }
      throw new Error('Stale workflow execution')
    }
    const backendJobId = data.job_id
    _activeJobId.current = backendJobId

    while (true) {
      if (!isCurrentContext(ctx)) {
        throw new Error('Stale workflow execution')
      }
      await new Promise((r) => setTimeout(r, 1200))
      assertCurrentContext(ctx)

      const { data: st } = await client.get<{
        status: string; progress?: number; step?: string; output_url?: string; output_kind?: ArtifactRef['kind']; error?: string
      }>(`/generate/status/${backendJobId}`)

      assertCurrentContext(ctx)
      if (st.status === 'done' && st.output_url) {
        actualOutputType = resolveModelNodeOutputKind({ declaredOutput: ext.output, actualOutput: st.output_kind, extensionId: ext.id })
        const rel = st.output_url.replace(/^\/workspace\//, '')
        nodeInputPath = `${workspaceDir}/${rel}`
        _activeJobId.current = null
        setRunState((s) => ({ ...s, blockProgress: 100, blockStep: 'Generation complete' }))
        break
      }
      if (st.status === 'cancelled') throw new Error('Cancelled')
      if (st.status === 'error') throw new Error(st.error ?? 'Generation failed')

      setRunState((s) => ({ ...s, blockProgress: st.progress ?? s.blockProgress, blockStep: st.step ?? 'Generating…' }))
      updateOwnedJob(ctx, { status: 'generating', progress: st.progress, step: st.step, previewKind: undefined })
    }
  } else {
    if (!hasNamedInputs && ext?.input === 'mesh'  && !nodeInputMeshPath && !nodeInputPath) throw new Error(`${ext.name} needs an incoming mesh connection`)
    if (!hasNamedInputs && ext?.input === 'image' && !nodeInputPath) throw new Error(`${ext.name} needs an incoming image connection`)
    if (!hasNamedInputs && ext?.input === 'audio' && !nodeInputPath) throw new Error(`${ext.name} needs an incoming audio connection`)
    if (!hasNamedInputs && ext?.input === 'text'  && !nodeInputText) throw new Error(`${ext.name} needs an incoming text connection`)

    // Freshest params (liveParams), same as the model-node branch above, so a
    // multi-image process node re-run inside a loop also picks up edits made while
    // paused rather than the snapshot captured at run start.
    const processParams: Record<string, unknown> = { ...liveParams }
    const sidecar = consumesLandmarks(ext) ? incomingLandmarkSidecar(ctx, node.id) : undefined
    if (sidecar) processParams.landmarks_sidecar_path = sidecar
    if (!scenePositional && nodeInputMeshPath && nodeInputPath) {
      // Texture node: mesh is filePath, all images in extra_image_paths
      processParams.extra_image_paths = [nodeInputPath, ...extraImagePaths]
    } else if (!scenePositional && extraImagePaths.length > 0) {
      processParams.extra_image_paths = extraImagePaths
    }

    const processInput = hasNamedInputs || scenePositional ? buildProcessExecutionInput({
      node, nodes: workflow.nodes, edges: workflow.edges, allExtensions, nodeOutputs,
    }) : {
      filePath: nodeInputMeshPath ?? nodeInputPath,
      text: nodeInputText,
      texts: nodeInputTexts.length > 0 ? nodeInputTexts : undefined,
      nodeId: ext.nodeId,
    }
    if (hasNamedInputs || scenePositional) {
      for (const port of getProcessTargetPorts(ext!)) {
        const name = port.name ?? 'input-0'
        const value = processInput.inputs && Object.hasOwn(processInput.inputs, name) ? processInput.inputs[name] : undefined
        if (port.required && !value) throw new Error(`Required port "${port.name}" has no input data.`)
        if (value && (value.type !== port.type || (port.type === 'scene' && !value.filePath?.trim()))) {
          throw new Error(`Port "${port.name}" requires ${port.type} input data.`)
        }
      }
    }
    if (scenePositional) {
      const images = Object.values(processInput.inputs ?? {}).filter((value) => value.type === 'image' && value.filePath && value.filePath !== processInput.filePath).map((value) => value.filePath!)
      if (images.length) processParams.extra_image_paths = images
    }
    if (hasNamedInputs) {
      // Named values never leak into the legacy top-level fallback/output fields.
      nodeInputPath = undefined
      nodeInputText = undefined
    }
    if (isHumanoidConsumer(ext)) {
      clearHumanoidAuthority(processParams)
      const mesh = processInput.inputs?.rigged_mesh
      Object.assign(processParams, await readCurrentHumanoidParams(ctx, mesh?.type === 'mesh' ? mesh.filePath : undefined))
      assertCurrentContext(ctx)
    }
    const result = await window.electron.extensions.runProcess(ext.extensionId, processInput, processParams)
    assertCurrentContext(ctx)
    if (!result.success) throw new Error(result.error ?? 'Process extension failed')
    if (ext.output === 'scene' && (!result.result?.filePath?.trim()
      || (result.result.outputType !== undefined && result.result.outputType !== 'scene'))) {
      throw new Error('Scene process must return an explicit scene manifest output')
    }
    nodeInputPath = result.result?.filePath ?? nodeInputPath
    nodeInputText = result.result?.text     ?? nodeInputText
    setRunState((s) => ({ ...s, blockProgress: 100, blockStep: 'Done' }))
  }

  const outputType = actualOutputType ?? ext.output
  nodeOutputs.set(node.id, { filePath: nodeInputPath, text: nodeInputText, outputType })

  recordNodeArtifact(ctx, node.id, {
    workflowId: workflow.id, workflowNodeId: node.id,
    extensionId: ext.extensionId, extensionNodeId: ext.nodeId,
  })
  const output = nodeOutputs.get(node.id)
  const url = isSceneMeshOutput(output) ? toWorkspaceUrl(output.filePath, workspaceDir) : undefined
  if (url && reachesSceneOutput(node.id, workflow.edges, nodeMap)) {
    ctx.lastSceneMesh = url   // remember it so finalize() keeps the last-run branch in view
    updateOwnedJob(ctx, { status: 'done', progress: 100, outputUrl: url, previewKind: undefined, step: undefined })
  }
  const worldsUrl = output?.filePath ? toWorkspaceUrl(output.filePath, workspaceDir) : undefined
  if (worldsUrl && workflow.edges.some((edge) => edge.source === node.id && nodeMap.get(edge.target)?.type === 'addToWorldsNode')) {
    await addWorkflowOutputUrlToWorlds(worldsUrl, outputType)
  }
}

// ─── Wait dependency helpers ───────────────────────────────────────────────────

/** All Waits nested (transitively) under `rootId`, via the parentWait chain. */
function descendantWaits(rootId: string, ctx: RunContext): Set<string> {
  const out = new Set<string>()
  let frontier = new Set<string>([rootId])
  while (frontier.size > 0) {
    const next = new Set<string>()
    for (const w of ctx.waitIds) {
      const parent = ctx.parentWait.get(w)
      if (parent && frontier.has(parent) && !out.has(w)) { out.add(w); next.add(w) }
    }
    frontier = next
  }
  return out
}

/**
 * Push the mesh of every scene output owned by `waitId`'s branch to the viewer.
 * A branch whose only scene output has no in-branch processing (e.g. Wait → Add
 * to Scene) gets no immediate push during execution, so the display has to be
 * driven here, when the user continues that branch.
 */
async function pushBranchSceneMesh(ctx: RunContext, waitId: string): Promise<void> {
  for (const node of ctx.ordered) {
    if (!isSceneOutput(node.type) && node.type !== 'addToWorldsNode') continue
    const owners = nearestUpstreamWaits(node.id, ctx.workflow.edges, ctx.nodeMap)
    if (owners.size !== 1 || [...owners][0] !== waitId) continue
    const inEdge = ctx.workflow.edges.find((e) => e.target === node.id)
    if (!inEdge) continue
    if (node.type === 'addToWorldsNode' && ctx.nodeMap.get(inEdge.source)?.type === 'extensionNode') continue
    const srcId = resolveDataSource(inEdge.source, ctx.workflow.edges, ctx.nodeMap, ctx.nodeOutputs)
    const sourceOutput = srcId ? ctx.nodeOutputs.get(srcId) : undefined
    const url = node.type === 'addToWorldsNode' && sourceOutput?.filePath
      ? toWorkspaceUrl(sourceOutput.filePath, ctx.workspaceDir)
      : isSceneMeshOutput(sourceOutput) ? toWorkspaceUrl(sourceOutput.filePath, ctx.workspaceDir) : undefined
    if (url) {
      if (node.type === 'addToWorldsNode') {
        await addWorkflowOutputUrlToWorlds(url, sourceOutput?.outputType)
      } else {
        ctx.lastSceneMesh = url
        updateOwnedJob(ctx, { status: 'done', progress: 100, outputUrl: url, previewKind: undefined, step: undefined })
      }
    }
  }
}

// ─── Store ────────────────────────────────────────────────────────────────────

interface WorkflowRunStore {
  runState:         WorkflowRunState
  executionId: string | null
  checkpoints: Record<string, WorkflowCheckpoint>
  activeCheckpointNodeId: string | null
  nodeArtifacts: Record<string, ArtifactRef>
  artifactLineages: Record<string, ArtifactLineage>
  landmarkSidecars: Record<string, LandmarkSidecarLineageMetadata>
  getCheckpointOwner: (nodeId: string) => CheckpointOwner | undefined
  selectCheckpoint: (owner: CheckpointOwner) => boolean
  setPendingReplacement: (owner: CheckpointOwner, artifact?: ArtifactRef) => boolean
  getPendingReplacement: (owner: CheckpointOwner) => ArtifactRef | undefined
  markLandmark: (owner: CheckpointOwner, point: LandmarkPoint) => boolean
  setActiveLandmark: (owner: CheckpointOwner, id: LandmarkId) => boolean
  clearLandmarks: (owner: CheckpointOwner) => boolean
  activeNodeId:     string | null
  activeWorkflowId: string | null
  nodeImageOutputs: Record<string, string>
  waitStates:       Record<string, WaitState>
  runningBranchId:  string | null
  /** whileId → current iteration / total (total null = manual/unbounded) */
  whileProgress:    Record<string, { current: number; total: number | null }>
  /** iterator ids paused together at a shared boundary (lockstep For Each group) */
  pausedGroup:      string[]
  /** nodeId → workspace URL for video outputs */
  nodeVideoOutputs: Record<string, string>

  run:         (workflow: Workflow, allExtensions: WorkflowExtension[], overrideImageData?: string) => Promise<void>
  cancel:      () => void
  reset:       () => void
  continueRun: (waitId: string, options?: CheckpointContinueOptions) => Promise<void>
  /** While container: resume past the loop (Continue) */
  continueWhile: () => void
  /** While container: resume and re-run the loop body once more (Retry) */
  retryWhile:    () => void
  /** For Each container: request a pause at the next file boundary */
  pauseWhile:    () => void
  /** UI → runner: push the latest params for a node so a looping run uses them */
  setLiveNodeParams: (nodeId: string, params: Record<string, unknown>) => void
}

export const useWorkflowRunStore = create<WorkflowRunStore>((set, get) => {
  const setRunState = (updater: (s: WorkflowRunState) => WorkflowRunState): void => {
    set((s) => ({ runState: updater(s.runState) }))
  }

  const syncCheckpoints = (ctx: RunContext): void => {
    if (!isCurrentContext(ctx)) return
    set({ checkpoints: Object.fromEntries(ctx.checkpoints), nodeArtifacts: Object.fromEntries(ctx.nodeArtifacts),
      artifactLineages: Object.fromEntries([...ctx.checkpoints].flatMap(([id, cp]) => cp.lineage ? [[id, cp.lineage]] : [])),
      landmarkSidecars: Object.fromEntries([...ctx.checkpoints].flatMap(([id, cp]) => cp.landmarkSidecar ? [[id, cp.landmarkSidecar]] : [])),
    })
  }

  const refreshCheckpointReview = async (ctx: RunContext, checkpoint: WorkflowCheckpoint, output = checkpoint.input): Promise<void> => {
    if (!isCurrentContext(ctx) || ctx.nodeMap.get(checkpoint.owner.nodeId)?.type !== 'waitNode'
      || !checkpointFeedsHumanoid(ctx, checkpoint.owner.nodeId)) return
    const owner = { ...checkpoint.owner }, nodeId = owner.nodeId
    const request = Symbol('checkpoint-review')
    const filePath = output?.outputType === 'mesh' ? output.filePath : undefined
    ctx.reviewRequests.set(nodeId, request)
    const ownsRequest = (): boolean => isCurrentContext(ctx)
      && sameCheckpointOwner(ctx.checkpoints.get(nodeId)?.owner, owner) && ctx.reviewRequests.get(nodeId) === request
    const publish = (state: WaitCheckpointReviewState): void => {
      if (!ownsRequest()) return
      ctx.checkpoints.set(nodeId, { ...ctx.checkpoints.get(nodeId)!, humanoidReview: { owner, state } })
      syncCheckpoints(ctx)
    }
    publish({ ...resolveWaitCheckpointHumanoidReview({ meshWorkspacePath: humanoidWorkspacePath(filePath, ctx.workspaceDir) ?? '' }),
      headline: 'Reading humanoid review; Continue will recheck the selected mesh.' })
    try {
      publish(await readWaitCheckpointHumanoidReview(filePath, ctx.workspaceDir))
    } catch (error) {
      // Unexpected reader/result failures are still owner-bound and degraded.
      publish({ ...resolveWaitCheckpointHumanoidReview({ meshWorkspacePath: '' }), diagnostics: [String(error)] })
    } finally {
      if (ownsRequest()) ctx.reviewRequests.delete(nodeId)
    }
  }

  const ownedCheckpoint = (owner: CheckpointOwner, allowCaptureWrite = false): { ctx: RunContext; checkpoint: WorkflowCheckpoint } | undefined => {
    const ctx = _ctx.current
    if (!ctx || !isCurrentContext(ctx) || !owner) return undefined
    const running = get().runningBranchId
    if (running !== null && !(allowCaptureWrite && running === owner.nodeId && ctx.checkpoints.get(owner.nodeId)?.landmarkCapture?.sidecarStatus === 'pending-write')) return undefined
    const checkpoint = ctx.checkpoints.get(owner.nodeId)
    if (!checkpoint || !sameCheckpointOwner(checkpoint.owner, owner)) return undefined
    const status = get().waitStates[owner.nodeId]
    if (get().runState.status === 'running' || (status === 'pending' && get().runState.status === 'error')) return undefined
    if (status !== 'pending' && status !== 'done' && status !== 'error') return undefined
    return { ctx, checkpoint }
  }

  const publishCheckpointPreview = (ctx: RunContext, checkpoint: WorkflowCheckpoint): void => {
    const output = checkpoint.input
    if (output?.outputType !== 'mesh' || !output.filePath) return
    const outputUrl = toWorkspaceUrl(output.filePath, ctx.workspaceDir)
    if (outputUrl) updateOwnedJob(ctx, { status: 'generating', outputUrl, previewKind: 'workflow-checkpoint', step: 'Temporary workflow checkpoint' })
  }

  const collectImageOutputs = (ctx: RunContext): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [nodeId, o] of ctx.nodeOutputs) {
      if (o.outputType === 'image' && o.filePath) {
        const norm = o.filePath.replace(/\\/g, '/')
        if (norm.startsWith(ctx.workspaceDir)) {
          out[nodeId] = `/workspace/${norm.slice(ctx.workspaceDir.length).replace(/^\//, '')}`
        }
      }
    }
    return out
  }

  const collectVideoOutputs = (ctx: RunContext): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [nodeId, o] of ctx.nodeOutputs) {
      if (o.outputType === 'video' && o.filePath) {
        const norm = o.filePath.replace(/\\/g, '/')
        if (norm.startsWith(ctx.workspaceDir)) {
          out[nodeId] = `/workspace/${norm.slice(ctx.workspaceDir.length).replace(/^\//, '')}`
        }
      }
    }
    return out
  }

  const finalize = (ctx: RunContext, finalWaitStates?: Record<string, WaitState>): void => {
    if (!isCurrentContext(ctx)) return
    syncCheckpoints(ctx)
    // Prefer the mesh of the last branch the user actually ran — it's already in the
    // viewer, and topo order must not override the user's last action.
    let outputUrl:  string | undefined = ctx.lastSceneMesh
    let outputPath: string | undefined

    const lastOutputNode = outputUrl ? undefined : [...ctx.ordered].reverse().find((n) => isSceneOutput(n.type) || n.type === 'addToWorldsNode')
    if (lastOutputNode) {
      for (const edge of ctx.workflow.edges.filter((e) => e.target === lastOutputNode.id)) {
        const src = ctx.nodeOutputs.get(edge.source)
        if (isSceneMeshOutput(src)) {
          outputUrl = toWorkspaceUrl(src.filePath, ctx.workspaceDir)
        }
      }
    }
    if (!outputUrl) {
      for (const [id, o] of ctx.nodeOutputs) {
        // Merely previewing a manual boundary cannot make its input a final result.
        if (ctx.checkpoints.size && !isExecutable(ctx.nodeMap.get(id)!)) continue
        if (o.filePath) {
          if (o.outputType === 'audio' || o.outputType === 'scene') {
            outputPath = o.filePath
            continue
          }
          const workspaceUrl = toWorkspaceUrl(o.filePath, ctx.workspaceDir)
          if (workspaceUrl) outputUrl = workspaceUrl
          else outputPath = o.filePath
        }
      }
    }

    const finalPath = outputUrl ? fromWorkspaceUrl(outputUrl, ctx.workspaceDir) : outputPath
    const artifact = finalPath ? [...ctx.nodeArtifacts.values()].reverse().find((ref) =>
      artifactRefToLegacyOutput(ref)?.filePath && runtimeCheckpointOutput(artifactRefToLegacyOutput(ref)!, ctx.workspaceDir).filePath === finalPath) : undefined
    set((s) => ({
      activeCheckpointNodeId: null,
      activeNodeId:     null,
      runningBranchId:  null,
      whileProgress:    {},
      pausedGroup:      [],
      waitStates:       finalWaitStates ?? s.waitStates,
      nodeImageOutputs: collectImageOutputs(ctx),
      nodeVideoOutputs: collectVideoOutputs(ctx),
      runState: {
        status:        'done',
        blockIndex:    0,
        blockTotal:    0,
        blockProgress: 100,
        blockStep:     'Done',
        outputUrl,
        outputPath,
        artifact,
      },
    }))
    updateOwnedJob(ctx, { status: 'done', progress: 100, outputUrl: artifact?.kind === 'mesh' ? outputUrl : undefined, previewKind: undefined, step: undefined })
    void showCompletionNotification('Workflow run complete')
  }

  return {
    runState:         IDLE,
    executionId: null, checkpoints: {}, activeCheckpointNodeId: null,
    nodeArtifacts: {}, artifactLineages: {}, landmarkSidecars: {},
    activeNodeId:     null,
    activeWorkflowId: null,
    nodeImageOutputs: {}, nodeVideoOutputs: {},
    waitStates:       {},
    runningBranchId:  null,
    whileProgress:    {},
    pausedGroup:      [],

    async run(workflow, allExtensions, overrideImageData?) {
      const activeGraph = deriveActiveWorkflowGraph(workflow.nodes, workflow.edges)
      workflow = { ...workflow, ...activeGraph }
      // Snapshot a legitimate Current Mesh before clearing the previous job.
      // A disposable checkpoint preview is not an input to the next workflow.
      const startingJob = useAppStore.getState().currentJob
      const currentMeshUrl = startingJob?.previewKind === 'workflow-checkpoint' ? undefined : startingJob?.outputUrl
      const previous = _ctx.current
      if (previous) updateOwnedJob(previous, { outputUrl: undefined, previewKind: undefined, step: undefined })
      const epoch = ++executionEpoch
      const runId = crypto.randomUUID()
      const jobId = runId
      flushResume()
      _ctx.current = null
      _activeJobId.current = null
      set({ executionId: runId, checkpoints: {}, activeCheckpointNodeId: null, nodeArtifacts: {}, artifactLineages: {}, landmarkSidecars: {} })
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
          if (epoch !== executionEpoch || _cancel.current) return
          if (files.length === 0) { fail(`For Each: no matching files in ${dir}`, 'Empty folder'); return }
          iteratorFiles.set(w.id, files)
        } catch (err) {
          if (epoch !== executionEpoch || _cancel.current) return
          fail(String(err), 'Failed to read folder'); return
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

      for (const w of workflow.nodes) {
        if (w.type !== 'whileNode') continue
        const bounds = whileBounds(w)
        const idxs = preExecExtNodes.reduce<number[]>((acc, n, idx) => {
          if (isInsideWhile(n, w.id, bounds)) acc.push(idx)
          return acc
        }, [])
        if (idxs.length === 0) continue
        const iters = Number(w.data?.iterations)
        loops.push({
          whileId:  w.id,
          kind:     'while',
          firstIdx: Math.min(...idxs),
          lastIdx:  Math.max(...idxs),
          bodyIds:  new Set(idxs.map((i) => preExecExtNodes[i].id)),
          iterations: Number.isFinite(iters) && iters > 0 ? Math.floor(iters) : null,
        })
      }

      for (const [iterId, files] of iteratorFiles) {
        const bodyIds = new Set([...reachableExecutable(iterId, workflow.edges, nodeMap)].filter((id) => indexOf.has(id)))
        const idxs = [...bodyIds].map((id) => indexOf.get(id)!)
        if (idxs.length === 0) continue
        loops.push({
          whileId:    iterId,
          kind:       'forEach',
          firstIdx:   Math.min(...idxs),
          lastIdx:    Math.max(...idxs),
          bodyIds,
          iterations: files.length,   // one pass per file
        })
      }
      const loopCounters = new Map(loops.map((l) => [l.whileId, l.iterations]))
      // Auto-mode loops replay their body N times; count the extra passes so the
      // progress total reflects the real work (manual loops stay unbounded). While
      // loops are independent. For Each loops sharing a boundary (same lastIdx) run
      // in lockstep over the union of their bodies, so that union is replayed once
      // per pass — count it once, for max(files) − 1 extra passes.
      const forEachGroups = new Map<number, LoopInfo[]>()
      let loopExtraSteps = 0
      for (const l of loops) {
        if (l.kind === 'while') {
          loopExtraSteps += l.iterations != null ? (l.iterations - 1) * l.bodyIds.size : 0
        } else {
          const g = forEachGroups.get(l.lastIdx) ?? []
          g.push(l)
          forEachGroups.set(l.lastIdx, g)
        }
      }

      for (const group of forEachGroups.values()) {
        const union = new Set<string>()
        let maxIter = 0
        for (const l of group) {
          l.bodyIds.forEach((id) => union.add(id))
          if (l.iterations != null) maxIter = Math.max(maxIter, l.iterations)
        }
        if (maxIter > 0) loopExtraSteps += (maxIter - 1) * union.size
      }
      const totalSteps = preExecExtNodes.length + branchSteps + loopExtraSteps

      const selectedImagePath = appState.selectedImagePath ?? undefined
      const selectedImageData = overrideImageData ?? appState.selectedImageData ?? undefined

      set({
        activeWorkflowId: workflow.id,
        nodeImageOutputs: {}, nodeVideoOutputs: {},
        // Top-level Waits are pending; nested Waits start blocked until their parent finishes.
        waitStates:       Object.fromEntries(waitIds.map((id) => [id, parentWait.get(id) ? 'blocked' as WaitState : 'pending' as WaitState])),
        runningBranchId:  null,
        whileProgress:    Object.fromEntries(loops.map((l) => [l.whileId, { current: 1, total: l.iterations }])),
        pausedGroup:      [],
        runState: {
          status: 'running', blockIndex: 0, blockTotal: totalSteps,
          blockProgress: 0, blockStep: 'Starting…',
        },
      })

      appState.setCurrentJob({
        id:        jobId,
        imageFile: selectedImagePath ?? '__workflow__',
        status:    'generating',
        progress:  0,
        createdAt: Date.now(),
      })

      try {
        const client       = axios.create({ baseURL: apiUrl })
        const settings     = await window.electron.settings.get()
        if (epoch !== executionEpoch || _cancel.current) return
        const workspaceDir = settings.workspaceDir.replace(/\\/g, '/')

        const tmpAbsPath = settings.workspaceDir.replace(/[\\/]+$/, '') + '/tmp'
        window.electron.fs.deleteDirectory(tmpAbsPath).catch(() => {})

        const nodeOutputs = new Map<string, NodeOutput>()

        // Pre-populate only source nodes used by the active graph.
        for (const node of ordered) {
          if (!workflow.edges.some((edge) => edge.source === node.id)) continue
          if (node.type === 'imageNode') {
            const fp = node.data.params?.filePath as string | undefined
            const resolvedPath = overrideImageData ? undefined : (fp ?? selectedImagePath ?? undefined)
            nodeOutputs.set(node.id, { filePath: resolvedPath, outputType: 'image' })
          }
          if (node.type === 'textNode') {
            nodeOutputs.set(node.id, { text: node.data.params?.text as string | undefined })
          }
          if (node.type === 'meshNode') {
            const source = node.data.params?.source as 'file' | 'current' | undefined
            if (source === 'current' && currentMeshUrl) {
              let meshFilePath: string
              if (currentMeshUrl.includes('serve-file?path=')) {
                const encoded = currentMeshUrl.split('serve-file?path=')[1]
                meshFilePath = decodeURIComponent(encoded).replace(/\\/g, '/')
              } else {
                const rel = currentMeshUrl.replace(/^\/workspace\//, '')
                meshFilePath = `${workspaceDir}/${rel}`
              }
              nodeOutputs.set(node.id, { filePath: meshFilePath, outputType: 'mesh' })
            } else {
              const fp = node.data.params?.filePath as string | undefined
              if (fp) nodeOutputs.set(node.id, { filePath: fp, outputType: 'mesh' })
            }
          }
          if (node.type === 'sceneNode') {
            // Revalidate the live source, never trust a persisted UI validation cache.
            const resolution = await resolveSceneSourceManifest({
              scenePath: typeof node.data.params?.path === 'string' ? node.data.params.path : '',
              workspaceDir,
              readFileBase64: window.electron.fs.readFileBase64,
            })
            // Validation runs before a context exists. Its epoch must still own
            // this run before either publishing an error or installing outputs.
            if (epoch !== executionEpoch || _cancel.current) return
            if (!resolution.ok) throw new Error(`Load Scene: ${resolution.error}`)
            nodeOutputs.set(node.id, { filePath: resolution.manifestAbsolutePath, outputType: 'scene' })
          }
        }

        if (epoch !== executionEpoch || _cancel.current) return
        const ctx: RunContext = {
          runId, epoch, jobId, checkpoints: new Map(), nodeArtifacts: new Map(), outputRevisions: new Map(), checkpointRevision: 0, reviewRequests: new Map(),
          workflow, allExtensions, client, workspaceDir, selectedImagePath, selectedImageData,
          overrideImageData, nodeOutputs, nodeMap, ordered, branches, waitIds, parentWait, iteratorFiles,
        }
        _ctx.current = ctx
        for (const id of nodeOutputs.keys()) recordNodeArtifact(ctx, id)
        const ownedSetRunState = (updater: (s: WorkflowRunState) => WorkflowRunState): void => { if (isCurrentContext(ctx)) setRunState(updater) }

        // While the runner is replaying a loop body, this holds the body nodes of the
        // active loop (or the union of several For Each loops sharing a boundary);
        // re-iterations then execute only those members and skip everything else in
        // the range. null = first pass / no active loop (run all nodes once).
        let activeLoopBody: Set<string> | null = null

        // End-of-body handler for While containers. Called after each pre-phase node;
        // when the index is a loop's last body node, it either jumps back (auto N× or
        // Retry) or pauses for Continue/Retry. Returns the index to resume at,
        // 'cancel', or undefined to continue normally.
        const bumpWhileProgress = (whileId: string): void => set((s) => {
          const prev = s.whileProgress[whileId]
          return { whileProgress: { ...s.whileProgress, [whileId]: { current: (prev?.current ?? 1) + 1, total: prev?.total ?? null } } }
        }
        )

        const handleLoopEnd = async (idx: number): Promise<number | 'cancel' | undefined> => {
          const forEachLoops = loops.filter((l) => l.lastIdx === idx && l.kind === 'forEach')
          const whileLoop    = loops.find((l) => l.lastIdx === idx && l.kind === 'while')

          // ── For Each: run through every file automatically. Several iterators can
          // share the same downstream body (e.g. an image folder + a mesh folder both
          // feeding one node); they advance together, in lockstep. It only stops if
          // the user hit Pause; then Continue advances to the next file(s) and Retry
          // re-runs the current one. No forced pause at the end — it just finishes.
          if (forEachLoops.length > 0) {
            const groupBody = new Set<string>()
            let jumpTo = Infinity
            for (const loop of forEachLoops) {
              loop.bodyIds.forEach((id) => groupBody.add(id))
              jumpTo = Math.min(jumpTo, loop.firstIdx)
            }

            if (_pauseRequested.current) {
              _pauseRequested.current = false
              _retry.current = false
              // Pause every iterator of the group together (they show the same state).
              const groupIds = forEachLoops.map((l) => l.whileId)
              set({ activeNodeId: groupIds[0], runningBranchId: groupIds[0], pausedGroup: groupIds })
              setRunState((s) => ({ ...s, status: 'paused', blockStep: 'Paused — Continue or Retry' }))
              await new Promise<void>((resolve) => { _resume.current = resolve })
              if (!isCurrentContext(ctx)) return 'cancel'
              set({ runningBranchId: null, pausedGroup: [] })
              setRunState((s) => ({ ...s, status: 'running' }))
              if (_retry.current) {   // re-run the current file(s), no advance
                _retry.current = false
                activeLoopBody = groupBody
                return jumpTo
              }
              // Continue → fall through to the normal advance below
            }

            // Advance every iterator that still has files left; they move together.
            let anyMore = false
            for (const loop of forEachLoops) {
              const remaining = loopCounters.get(loop.whileId)
              if (remaining != null && remaining > 1) {
                loopCounters.set(loop.whileId, remaining - 1)
                bumpWhileProgress(loop.whileId)
                anyMore = true
              }
            }
            if (anyMore) {
              setRunState((s) => ({ ...s, blockStep: 'Next file…' }))
              activeLoopBody = groupBody
              return jumpTo
            }
            activeLoopBody = null
            return undefined
          }

          if (!whileLoop) return undefined
          const remaining = loopCounters.get(whileLoop.whileId)

          // Auto mode with iterations left → loop back automatically.
          if (remaining != null && remaining > 1) {
            loopCounters.set(whileLoop.whileId, remaining - 1)
            bumpWhileProgress(whileLoop.whileId)
            setRunState((s) => ({ ...s, blockStep: `Looping… ${remaining - 1} left` }))
            activeLoopBody = whileLoop.bodyIds
            return whileLoop.firstIdx
          }
          // Otherwise the auto counter is exhausted (or it's manual mode): pause on
          // the While and wait for Continue (proceed) or Retry (run the body again).
          // runningBranchId blocks Wait branches while the pre-phase is parked here.
          _retry.current = false
          set({ activeNodeId: whileLoop.whileId, runningBranchId: whileLoop.whileId })
          setRunState((s) => ({ ...s, status: 'paused', blockStep: 'Loop finished — Continue or Retry' }))
          await new Promise<void>((resolve) => { _resume.current = resolve })
          if (!isCurrentContext(ctx)) return 'cancel'
          set({ runningBranchId: null })
          setRunState((s) => ({ ...s, status: 'running' }))
          if (_retry.current) {
            _retry.current = false
            bumpWhileProgress(whileLoop.whileId)
            activeLoopBody = whileLoop.bodyIds
            return whileLoop.firstIdx
          }
          activeLoopBody = null   // Continue → resume normal forward execution
          return undefined
        }

        // Pre-phase: nodes that don't belong to any single branch (sources + merges).
        let stepsDone = 0
        for (let i = 0; i < preExecExtNodes.length; i++) {
          if (!isCurrentContext(ctx)) return
          const node = preExecExtNodes[i]
          // During a loop replay, only re-run the active loop's body members.
          if (activeLoopBody && !activeLoopBody.has(node.id)) continue
          set((s) => ({
            activeNodeId: node.id,
            runState: { ...s.runState, blockIndex: stepsDone, blockProgress: 0, blockStep: 'Starting…' },
          }))
          await executeExtensionNode(node, ctx, ownedSetRunState)
          if (!isCurrentContext(ctx)) return
          stepsDone++

          const jump = await handleLoopEnd(i)
          if (jump === 'cancel' || !isCurrentContext(ctx)) return
          if (jump !== undefined) { i = jump - 1 }
        }

        if (waitIds.length > 0) {
          for (const id of waitIds) if (!parentWait.get(id)) materializeCheckpoint(ctx, id)
          syncCheckpoints(ctx)
          const first = ctx.checkpoints.values().next().value
          if (first) {
            set({ activeCheckpointNodeId: first.owner.nodeId })
            publishCheckpointPreview(ctx, first)
          }
          // Reviews are checkpoint-local and never delay the manual handoff.
          for (const checkpoint of ctx.checkpoints.values()) void refreshCheckpointReview(ctx, checkpoint)
          // Hand off to the user — branches run on demand via continueRun(id).
          set((s) => ({
            activeNodeId: null,
            runState: { ...s.runState, status: 'paused', blockStep: 'Pick a branch and click Continue' },
          }))
          return
        }

        finalize(ctx)
      } catch (err) {
        if (epoch === executionEpoch && !_cancel.current) {
          set((s) => ({ runState: { ...s.runState, status: 'error', error: String(err) }, activeNodeId: null }))
          if (useAppStore.getState().currentJob?.id === jobId) useAppStore.getState().updateCurrentJob({ status: 'error', error: String(err), outputUrl: undefined, previewKind: undefined, step: undefined })
          void showErrorNotification(String(err), 'Workflow run failed')
        }
      }
    },

    async continueRun(waitId, options) {
      const state = get()
      if (state.runningBranchId !== null || state.runState.status === 'running') return
      // Only runnable Waits: blocked (parent not done) and running are not.
      const ws = state.waitStates[waitId]
      if (ws !== 'pending' && ws !== 'done' && ws !== 'error') return
      // A pending Wait only runs after a clean handoff. If the run errored in the
      // pre-phase, it never handed off — don't start a branch with missing inputs.
      if (ws === 'pending' && state.runState.status === 'error') return
      const ctx = _ctx.current
      if (!ctx) {
        console.warn('continueRun: no active run context — was the module hot-reloaded mid-run?')
        return
      }

      if (!isCurrentContext(ctx)) return
      // A descendant marked error because its parent failed must not bypass its parent.
      const parent = ctx.parentWait.get(waitId)
      if (parent && state.waitStates[parent] !== 'done') return
      let checkpoint = ctx.checkpoints.get(waitId)
      if (!checkpoint) return
      if (options && !sameCheckpointOwner(options.owner, checkpoint.owner)) return
      const replacement = options?.replacementArtifact
      const result = checkpoint.substitutionPoint
        ? resolveArtifactReplacement(checkpoint.substitutionPoint, replacement) : undefined
      if (replacement && (!result || result.status !== 'accepted')) return
      let replacementOutput: NodeOutput | undefined
      try { if (result?.status === 'accepted') replacementOutput = runtimeCheckpointOutput(result.legacy, ctx.workspaceDir) }
      catch { return }
      // Landmarks annotate their original mesh; replacement belongs to a preceding Wait.
      if (replacement && checkpoint.landmarkCapture) return
      if (checkpoint.landmarkCapture) {
        const capture = checkpoint.landmarkCapture
        if (!isLandmarkCaptureComplete(Object.values(capture.completed))) return
        const attempt = { ...capture, sidecarStatus: 'pending-write' as const, error: undefined }
        checkpoint = { ...checkpoint, landmarkCapture: attempt }
        ctx.checkpoints.set(waitId, checkpoint)
        set({ runningBranchId: waitId })
        syncCheckpoints(ctx)
        try {
          const targetPath = artifactRefToLegacyOutput(capture.targetArtifact)?.filePath
          const meshPath = targetPath && normalizeWorkflowPath(targetPath, ctx.workspaceDir).replace(/^\/workspace\//, '')
          if (!meshPath || meshPath.startsWith('/') || /^[A-Za-z]:/.test(meshPath) || meshPath.split('/').some((p) => !p || p === '..')) throw new Error('Landmark mesh must be inside the workspace')
          const sidecar = buildLandmarkSidecarV1({ runId: ctx.runId, nodeId: waitId,
            sidecarPath: attempt.sidecarPath, targetArtifact: capture.targetArtifact, meshPath,
            landmarks: Object.values(capture.completed) })
          const validation = validateLandmarkSidecarV1(sidecar)
          if (!validation.valid) throw new Error(validation.errors.join(', '))
          const written = await window.electron.workspace.artifacts.writeLandmarkSidecar({
            sourceWorkspacePath: meshPath, sidecarWorkspacePath: attempt.sidecarPath, sidecar,
          })
          if (!isCurrentContext(ctx) || ctx.checkpoints.get(waitId) !== checkpoint || checkpoint.landmarkCapture !== attempt) return
          if (!written.success) throw new Error(written.error)
          if (written.sidecarWorkspacePath !== attempt.sidecarPath || JSON.stringify(written.sidecar) !== JSON.stringify(sidecar)) throw new Error('Landmark sidecar response does not match this capture')
          checkpoint = { ...checkpoint, landmarkCapture: { ...attempt, sidecarStatus: 'ready' },
            landmarkSidecar: buildLandmarkSidecarLineageMetadata({ runId: ctx.runId, nodeId: waitId,
              sidecarWorkspacePath: written.sidecarWorkspacePath, targetArtifact: capture.targetArtifact, targetMeshPath: meshPath }) }
          ctx.checkpoints.set(waitId, checkpoint)
        } catch (err) {
          if (!isCurrentContext(ctx) || ctx.checkpoints.get(waitId) !== checkpoint) return
          ctx.checkpoints.set(waitId, { ...checkpoint, landmarkCapture: { ...attempt, sidecarStatus: 'error', error: String(err) } })
          set({ runningBranchId: null })
          syncCheckpoints(ctx)
          return
        }
      }
      if (checkpointFeedsHumanoid(ctx, waitId)) {
        // An accepted Continue/Retry is busy before any reader can yield. Publish
        // the reservation and visible controls together; background hydration
        // does not enter this phase and leaves the paused checkpoint usable.
        set((s) => ({
          runningBranchId: waitId,
          waitStates: { ...s.waitStates, [waitId]: 'running' },
          runState: { ...s.runState, status: 'running', blockProgress: 0, blockStep: 'Checking humanoid review…' },
        }))
        const owner = checkpoint.owner
        await refreshCheckpointReview(ctx, checkpoint, replacementOutput ?? checkpoint.input)
        if (!isCurrentContext(ctx) || !sameCheckpointOwner(ctx.checkpoints.get(waitId)?.owner, owner)) return
        checkpoint = ctx.checkpoints.get(waitId)!
      }
      // Consuming a checkpoint invalidates every previously captured editor token.
      const original = checkpoint.substitutionPoint?.inputArtifact
      const edited = result?.status === 'accepted' && original ? buildWaitReplacementArtifactRef(original, result.artifact) : undefined
      checkpoint = { ...checkpoint, owner: { ...checkpoint.owner, revision: ++ctx.checkpointRevision },
        pendingReplacement: undefined, replacementResult: result, humanoidReview: undefined,
        lineage: edited && original ? buildWaitArtifactLineage(checkpoint.lineage, original, edited)
          : checkpoint.lineage && original ? { ...checkpoint.lineage, currentVersionId: original.versionId } : checkpoint.lineage }
      ctx.checkpoints.set(waitId, checkpoint)
      const chosen = edited ? replacementOutput : checkpoint.input
      if (chosen) ctx.nodeOutputs.set(waitId, { ...chosen })
      if (edited || original) ctx.nodeArtifacts.set(waitId, (edited ?? original)!)
      updateOwnedJob(ctx, { outputUrl: undefined, previewKind: undefined, step: undefined })
      set({ activeCheckpointNodeId: null })
      const branch = ctx.branches.get(waitId) ?? []
      // Re-running a Wait invalidates everything downstream: descendant branches
      // were computed against the old output, so drop their outputs and reset
      // them to blocked until this branch produces a fresh result.
      const descendants = descendantWaits(waitId, ctx)

      _cancel.current = false

      // Reset outputs for this branch's nodes so Retry re-executes cleanly.
      for (const node of branch) { ctx.nodeOutputs.delete(node.id); ctx.nodeArtifacts.delete(node.id) }
      for (const d of descendants) {
        ctx.checkpoints.delete(d); ctx.nodeOutputs.delete(d); ctx.nodeArtifacts.delete(d)
        for (const node of ctx.branches.get(d) ?? []) { ctx.nodeOutputs.delete(node.id); ctx.nodeArtifacts.delete(node.id) }
      }
      syncCheckpoints(ctx)

      set((s) => {
        const waitStates = { ...s.waitStates, [waitId]: 'running' as WaitState }
        for (const d of descendants) waitStates[d] = 'blocked'
        return {
          runningBranchId: waitId,
          waitStates,
          runState: { ...s.runState, status: 'running', blockIndex: 0, blockTotal: branch.length, blockProgress: 0, blockStep: branch.length === 0 ? 'Done' : 'Starting…' },
        }
      })

      const finishBranch = async (next: WaitState, err?: string): Promise<void> => {
        if (!isCurrentContext(ctx)) return
        const newWaitStates = { ...get().waitStates, [waitId]: next }
        // Unblock nested Waits whose parent branch just finished, and push this
        // branch's scene output to the viewer.
        if (next === 'done') {
          for (const w of ctx.waitIds) {
            if (ctx.parentWait.get(w) === waitId && newWaitStates[w] === 'blocked') {
              const nextCheckpoint = materializeCheckpoint(ctx, w)
              void refreshCheckpointReview(ctx, nextCheckpoint)
              newWaitStates[w] = 'pending'
            }
          }
          await pushBranchSceneMesh(ctx, waitId)
          if (!isCurrentContext(ctx)) return
          syncCheckpoints(ctx)
        }
        // A failed branch can never feed its descendants — surface them as error
        // too, otherwise they stay 'blocked' and the run hangs on 'paused' forever.
        if (next === 'error') {
          for (const d of descendantWaits(waitId, ctx)) {
            if (newWaitStates[d] === 'blocked') newWaitStates[d] = 'error'
          }
        }
        const allFinished = ctx.waitIds.every((id) => newWaitStates[id] === 'done' || newWaitStates[id] === 'error')
        const anyError    = ctx.waitIds.some((id) => newWaitStates[id] === 'error')

        if (allFinished && !anyError) {
          finalize(ctx, newWaitStates)
        } else {
          set((s) => ({
            activeNodeId:    null,
            runningBranchId: null,
            waitStates:      newWaitStates,
            runState: {
              ...s.runState,
              status:    allFinished ? 'error' : 'paused',
              error:     anyError ? (err ?? s.runState.error) : undefined,
              blockStep: err ? `Branch failed: ${err}` : 'Pick a branch and click Continue',
            },
          }))
        }
      }

      try {
        for (let i = 0; i < branch.length; i++) {
          if (!isCurrentContext(ctx)) return
          const node = branch[i]
          set((s) => ({
            activeNodeId: node.id,
            runState: { ...s.runState, blockIndex: i, blockProgress: 0, blockStep: 'Starting…' },
          }))
          await executeExtensionNode(node, ctx, (updater) => { if (isCurrentContext(ctx)) setRunState(updater) })
          if (!isCurrentContext(ctx)) return
        }
        await finishBranch('done')
      } catch (err) {
        await finishBranch('error', String(err))
      }
    },

    cancel() {
      const ctx = _ctx.current
      if (ctx) updateOwnedJob(ctx, { outputUrl: undefined, previewKind: undefined, step: undefined })
      ++executionEpoch
      _cancel.current = true
      _pauseRequested.current = false
      flushResume()   // unblock a manual While pause so the run can tear down
      if (_activeJobId.current) {
        const apiUrl = useAppStore.getState().apiUrl
        axios.create({ baseURL: apiUrl }).post(`/generate/cancel/${_activeJobId.current}`).catch(() => {})
        _activeJobId.current = null
      }
      _ctx.current = null
      set({ executionId: null, checkpoints: {}, activeCheckpointNodeId: null, nodeArtifacts: {}, artifactLineages: {}, landmarkSidecars: {}, runState: IDLE, activeNodeId: null, activeWorkflowId: null, nodeImageOutputs: {}, nodeVideoOutputs: {}, waitStates: {}, runningBranchId: null, whileProgress: {}, pausedGroup: [] })
      if (ctx && useAppStore.getState().currentJob?.id === ctx.jobId) useAppStore.getState().setCurrentJob(null)
    },

    reset() {
      const ctx = _ctx.current
      if (ctx) updateOwnedJob(ctx, { outputUrl: undefined, previewKind: undefined, step: undefined })
      ++executionEpoch
      _cancel.current = true
      _pauseRequested.current = false
      flushResume()
      _ctx.current = null
      set({ executionId: null, checkpoints: {}, activeCheckpointNodeId: null, nodeArtifacts: {}, artifactLineages: {}, landmarkSidecars: {}, runState: IDLE, activeNodeId: null, activeWorkflowId: null, nodeImageOutputs: {}, nodeVideoOutputs: {}, waitStates: {}, runningBranchId: null, whileProgress: {}, pausedGroup: [] })
    },

    getCheckpointOwner(nodeId) {
      const ctx = _ctx.current
      const owner = ctx && isCurrentContext(ctx) ? ctx.checkpoints.get(nodeId)?.owner : undefined
      return owner && { ...owner }
    },

    selectCheckpoint(owner) {
      const match = ownedCheckpoint(owner)
      if (!match) return false
      set({ activeCheckpointNodeId: owner.nodeId })
      publishCheckpointPreview(match.ctx, match.checkpoint)
      void refreshCheckpointReview(match.ctx, match.checkpoint)
      return true
    },

    setPendingReplacement(owner, artifact) {
      const match = ownedCheckpoint(owner)
      if (!match || match.checkpoint.landmarkCapture || !match.checkpoint.substitutionPoint) return false
      if (artifact) {
        const result = resolveArtifactReplacement(match.checkpoint.substitutionPoint, artifact)
        if (result.status !== 'accepted') return false
        try { runtimeCheckpointOutput(result.legacy, match.ctx.workspaceDir) } catch { return false }
      }
      // Detach caller-owned values: an exporter must not mutate a pending artifact later.
      const pendingReplacement = artifact && { ...artifact, legacy: artifact.legacy && { ...artifact.legacy } }
      const next = { ...match.checkpoint, owner: { ...match.checkpoint.owner, revision: ++match.ctx.checkpointRevision }, pendingReplacement, humanoidReview: undefined }
      match.ctx.checkpoints.set(owner.nodeId, next)
      syncCheckpoints(match.ctx)
      // Normal Continue still chooses the original, even with a pending edit.
      void refreshCheckpointReview(match.ctx, next)
      return true
    },

    getPendingReplacement(owner) {
      return ownedCheckpoint(owner)?.checkpoint.pendingReplacement
    },

    markLandmark(owner, point) {
      const match = ownedCheckpoint(owner, true)
      const capture = match?.checkpoint.landmarkCapture
      if (!match || !capture || !isLandmarkId(point.id) || point.source !== 'manual' || point.confidence !== 1
        || typeof point.name !== 'string' || !point.name.trim() || !point.world || ![point.world.x, point.world.y, point.world.z].every(Number.isFinite)) return false
      const completed = { ...capture.completed, [point.id]: { ...point, world: { ...point.world } } }
      const valid = isLandmarkCaptureComplete(Object.values(completed))
      match.ctx.checkpoints.set(owner.nodeId, { ...match.checkpoint, landmarkSidecar: undefined, landmarkCapture: {
        ...capture, ...createLandmarkCaptureIdentity(match.ctx.runId, owner.nodeId, capture.captureRevision + 1),
        completed, validity: { valid, missing: getMissingRequiredLandmarkIds(Object.values(completed)) },
        canContinue: valid, error: undefined, sidecarStatus: 'not_started',
        activeLandmarkId: REQUIRED_LANDMARK_IDS.find((id) => !completed[id]) ?? point.id,
      } })
      if (get().runningBranchId === owner.nodeId) set({ runningBranchId: null })
      syncCheckpoints(match.ctx)
      return true
    },

    setActiveLandmark(owner, id) {
      const match = ownedCheckpoint(owner)
      const capture = match?.checkpoint.landmarkCapture
      if (!match || !capture || !isLandmarkId(id)) return false
      match.ctx.checkpoints.set(owner.nodeId, { ...match.checkpoint, landmarkCapture: { ...capture, activeLandmarkId: id } })
      syncCheckpoints(match.ctx)
      return true
    },

    clearLandmarks(owner) {
      const match = ownedCheckpoint(owner, true)
      const capture = match?.checkpoint.landmarkCapture
      if (!match || !capture) return false
      match.ctx.checkpoints.set(owner.nodeId, { ...match.checkpoint, landmarkSidecar: undefined, landmarkCapture: {
        ...capture, ...createLandmarkCaptureIdentity(match.ctx.runId, owner.nodeId, capture.captureRevision + 1),
        completed: {}, validity: { valid: false, missing: [...REQUIRED_LANDMARK_IDS] }, canContinue: false,
        activeLandmarkId: REQUIRED_LANDMARK_IDS[0], error: undefined, sidecarStatus: 'not_started',
      } })
      if (get().runningBranchId === owner.nodeId) set({ runningBranchId: null })
      syncCheckpoints(match.ctx)
      return true
    },

    continueWhile() {
      flushResume()
    },

    retryWhile() {
      _retry.current = true
      flushResume()
    },

    pauseWhile() {
      _pauseRequested.current = true
    },

    setLiveNodeParams(nodeId, params) {
      _liveParams.current.set(nodeId, params)
    },
  }
})

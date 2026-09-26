import { importLegacyWorldsSceneManifest } from '../worlds/core/legacySceneManifestAdapter.ts'
import type { WorldCommand } from '../worlds/core/worldCommands.ts'
import {
  buildAddModelEntityCommands,
  buildImportLegacySceneCommands,
  createDeterministicWorldEditorIdentityGenerator,
} from '../worlds/editor/worldEditorCommandBuilders.ts'
import {
  worldEditorCommandPort,
  type WorldEditorActiveContext,
  type WorldEditorCommandPort,
} from '../worlds/editor/worldEditorCommandPort.ts'
import {
  legacyWorldsCommandBridge,
  type LegacyWorldsCommandBridge,
} from '../worlds/editor/legacyWorldsCommandBridge.ts'
import { resolveWorldRenderable } from '../worlds/worldRenderableResolver.ts'
import { parseWorldsSceneManifestText } from '../worlds/worldsSceneManifest.ts'
import { useAppStore } from '../../shared/stores/appStore.ts'
import type { ArtifactKind } from '../../shared/types/artifacts.ts'

const MAX_WORKFLOW_COMMAND_RECEIPTS = 128
const workflowCommandLedger = new Map<string, readonly WorldCommand[]>()

export interface WorkflowWorldsOutputContext {
  runId?: string
  sourceNodeId?: string
  targetNodeId?: string
  artifactId?: string
  sceneMode?: 'append' | 'replace'
}

export type WorkflowWorldsOutputResult =
  | { accepted: false; mode: 'none' }
  | { accepted: true; mode: 'legacy' }
  | { accepted: true; mode: 'canonical'; transactionId: string; revision: number; idempotent: boolean }

export interface WorkflowWorldsOutputDependencies {
  commandPort: WorldEditorCommandPort
  legacyBridge: LegacyWorldsCommandBridge
  getApiUrl(): string
  fetchManifest(url: string): Promise<Response>
  resolvePlyKind(workspacePath: string): Promise<'mesh' | 'points' | 'gaussian' | 'unknown' | undefined>
}

export class WorkflowWorldsOutputError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable = false) {
    super(message)
    this.code = code
    this.retryable = retryable
  }
}

export function resolveWorkflowOutputWorldsWorkspacePath(outputUrl: string): string | null {
  const trimmed = outputUrl.trim()
  if (!trimmed) return null

  const path = (() => {
    if (trimmed.startsWith('/workspace/')) return trimmed.slice('/workspace/'.length)
    try {
      const url = new URL(trimmed)
      return url.pathname.startsWith('/workspace/') ? url.pathname.slice('/workspace/'.length) : null
    } catch {
      return null
    }
  })()

  if (!path) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(path).replace(/\\/g, '/').replace(/^\.\//, '')
  } catch {
    return null
  }
  if (!decoded || decoded.startsWith('/') || /^[A-Za-z]:\//.test(decoded) || decoded.includes('\0')) return null
  if (/%2e|%2f|%5c/i.test(decoded)) return null
  if (decoded.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return null
  return decoded
}

export function encodeWorkflowOutputWorldsWorkspacePath(workspacePath: string): string {
  return workspacePath.split('/').map((segment) => encodeURIComponent(segment)).join('/')
}

/** Compatibility wrapper for callers that only need acceptance. */
export async function addWorkflowOutputUrlToWorlds(
  outputUrl: string,
  outputKind?: ArtifactKind,
  context: WorkflowWorldsOutputContext = {},
): Promise<boolean> {
  return (await routeWorkflowOutputToWorlds(outputUrl, outputKind, context)).accepted
}

export async function routeWorkflowOutputToWorlds(
  outputUrl: string,
  outputKind?: ArtifactKind,
  context: WorkflowWorldsOutputContext = {},
  providedDependencies: Partial<WorkflowWorldsOutputDependencies> = {},
): Promise<WorkflowWorldsOutputResult> {
  const workspacePath = resolveWorkflowOutputWorldsWorkspacePath(outputUrl)
  if (!workspacePath) {
    if (outputKind === 'scene') {
      throw new WorkflowWorldsOutputError('unsafe_workspace', 'Unable to import workflow scene: output URL must reference a safe workspace path.')
    }
    return Object.freeze({ accepted: false, mode: 'none' })
  }

  const dependencies = resolveDependencies(providedDependencies)
  const apiUrl = dependencies.getApiUrl().trim().replace(/\/+$/, '')
  const active = dependencies.commandPort.getActiveContext()
  const identitySeed = stableWorkflowIdentity(active?.projectId ?? 'legacy', active?.activeSceneId ?? 'legacy', workspacePath, outputKind, context)

  if (outputKind === 'scene') {
    const parsed = await fetchWorkflowScene(workspacePath, apiUrl, dependencies.fetchManifest)
    if (!active) {
      rejectLegacyFallbackAfterCanonicalOpen(dependencies.commandPort)
      return dependencies.legacyBridge.replaceScene({
        sceneItems: parsed.sceneItems,
        collisionSurfaces: parsed.collisionSurfaces,
        initialView: parsed.manifest.initialView ?? null,
      })
    }

    const reference = active.snapshot.project.scenes.find((candidate) => candidate.id === active.activeSceneId)
    if (!reference) throw new WorkflowWorldsOutputError('scene_missing', `Active scene ${active.activeSceneId} does not exist.`)
    const imported = importLegacyWorldsSceneManifest(parsed.manifest, {
      projectId: active.projectId,
      projectName: active.snapshot.project.name,
      sceneId: active.activeSceneId,
      sceneName: reference.name,
      sceneDocumentPath: reference.documentPath,
    })
    if (!imported.success) {
      throw new WorkflowWorldsOutputError('invalid_document', imported.issues[0]?.message ?? 'Unable to adapt workflow scene manifest.')
    }
    const transactionId = `tx:workflow:${digest128(identitySeed)}`
    const commands = commandsForRetry(transactionId, () => buildImportLegacySceneCommands({
      snapshot: active.snapshot,
      projectKey: active.projectKey,
      activeSceneId: active.activeSceneId,
      identities: createDeterministicWorldEditorIdentityGenerator(identitySeed),
    }, imported.snapshot, context.sceneMode ?? 'replace'))
    return dispatchCanonical(dependencies.commandPort, transactionId, commands, active)
  }

  const plyKind = await dependencies.resolvePlyKind(workspacePath)
  if (workspacePath.toLowerCase().endsWith('.ply') && !plyKind) return Object.freeze({ accepted: false, mode: 'none' })
  const renderable = resolveWorldRenderable({ workspacePath, apiUrl, ...(plyKind ? { plyKind } : {}) })
  if (!renderable.openable) return Object.freeze({ accepted: false, mode: 'none' })
  if (!active) {
    rejectLegacyFallbackAfterCanonicalOpen(dependencies.commandPort)
    return dependencies.legacyBridge.appendRenderable(renderable.item)
  }

  const transactionId = `tx:workflow:${digest128(identitySeed)}`
  const commands = commandsForRetry(transactionId, () => buildAddModelEntityCommands({
    snapshot: active.snapshot,
    projectKey: active.projectKey,
    activeSceneId: active.activeSceneId,
    identities: createDeterministicWorldEditorIdentityGenerator(identitySeed),
  }, {
    workspacePath,
    format: renderable.item.kind,
    name: basename(workspacePath),
  }))
  return dispatchCanonical(dependencies.commandPort, transactionId, commands, active)
}

async function dispatchCanonical(
  port: WorldEditorCommandPort,
  transactionId: string,
  commands: readonly WorldCommand[],
  authority: WorldEditorActiveContext,
): Promise<Extract<WorkflowWorldsOutputResult, { mode: 'canonical' }>> {
  const result = await port.dispatchCommands(
    { transactionId, origin: 'workflow', commands: commands.map((command) => structuredClone(command)) },
    {
      projectKey: authority.projectKey,
      projectId: authority.projectId,
      baseRevision: authority.baseRevision,
      activeSceneId: authority.activeSceneId,
    },
  )
  if (!result.ok) throw new WorkflowWorldsOutputError(result.error.code, result.error.message, result.error.retryable)
  return Object.freeze({
    accepted: true,
    mode: 'canonical',
    transactionId,
    revision: result.value.revision,
    idempotent: result.value.idempotent,
  })
}

function rejectLegacyFallbackAfterCanonicalOpen(port: WorldEditorCommandPort): void {
  if (port.getActiveContext()) {
    throw new WorkflowWorldsOutputError('revision_conflict', 'World editor authority changed while workflow output was prepared.')
  }
}

async function fetchWorkflowScene(
  workspacePath: string,
  apiUrl: string,
  fetchManifest: (url: string) => Promise<Response>,
) {
  if (!apiUrl) throw new WorkflowWorldsOutputError('invalid_request', 'Unable to fetch workflow scene manifest: Modly API URL is not configured.')
  const encodedWorkspacePath = encodeWorkflowOutputWorldsWorkspacePath(workspacePath)
  const manifestUrl = `${apiUrl}/workspace/${encodedWorkspacePath}`
  let response: Response
  try {
    response = await fetchManifest(manifestUrl)
  } catch (reason: unknown) {
    throw new WorkflowWorldsOutputError('internal_error', `Unable to fetch workflow scene manifest "${workspacePath}": ${describeError(reason)}`, true)
  }
  if (!response.ok) {
    const statusText = response.statusText.trim()
    throw new WorkflowWorldsOutputError('invalid_document', `Unable to fetch workflow scene manifest "${workspacePath}": HTTP ${response.status}${statusText ? ` ${statusText}` : ''}.`)
  }
  let text: string
  try {
    text = await response.text()
  } catch (reason: unknown) {
    throw new WorkflowWorldsOutputError('invalid_document', `Unable to read workflow scene manifest "${workspacePath}": ${describeError(reason)}`)
  }
  const parsed = parseWorldsSceneManifestText(text, { apiUrl })
  if (!parsed.success) throw new WorkflowWorldsOutputError('invalid_document', `Unable to parse workflow scene manifest "${workspacePath}": ${parsed.error}`)
  return parsed
}

function commandsForRetry(transactionId: string, build: () => WorldCommand[]): readonly WorldCommand[] {
  const existing = workflowCommandLedger.get(transactionId)
  if (existing) return existing
  const commands = deepFreezeData(structuredClone(build()))
  workflowCommandLedger.set(transactionId, commands)
  while (workflowCommandLedger.size > MAX_WORKFLOW_COMMAND_RECEIPTS) {
    const oldest = workflowCommandLedger.keys().next().value as string | undefined
    if (!oldest) break
    workflowCommandLedger.delete(oldest)
  }
  return commands
}

function resolveDependencies(provided: Partial<WorkflowWorldsOutputDependencies>): WorkflowWorldsOutputDependencies {
  return {
    commandPort: provided.commandPort ?? worldEditorCommandPort,
    legacyBridge: provided.legacyBridge ?? legacyWorldsCommandBridge,
    getApiUrl: provided.getApiUrl ?? (() => useAppStore.getState().apiUrl),
    fetchManifest: provided.fetchManifest ?? ((url) => fetch(url)),
    resolvePlyKind: provided.resolvePlyKind ?? resolveWorkflowOutputPlyKind,
  }
}

function stableWorkflowIdentity(
  projectId: string,
  sceneId: string,
  workspacePath: string,
  outputKind: ArtifactKind | undefined,
  context: WorkflowWorldsOutputContext,
): string {
  return [
    projectId,
    sceneId,
    context.runId ?? '',
    context.sourceNodeId ?? '',
    context.targetNodeId ?? '',
    context.artifactId ?? '',
    context.sceneMode ?? 'replace',
    outputKind ?? 'mesh',
    workspacePath,
  ].join('\0')
}

function digest128(value: string): string {
  return [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
    .map((seed, lane) => fnv1a32(`${lane}:${value}`, seed).toString(16).padStart(8, '0'))
    .join('')
}

function fnv1a32(value: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

function basename(workspacePath: string): string {
  return workspacePath.split('/').at(-1) ?? workspacePath
}

function describeError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

async function resolveWorkflowOutputPlyKind(workspacePath: string) {
  if (!workspacePath.toLowerCase().endsWith('.ply')) return undefined
  const libraryApi = window.electron?.workspace?.library
  if (!libraryApi) return undefined
  const result = await libraryApi.read({ workspacePath })
  if (result.success !== true) return undefined
  return result.entry.plyKind
}

function deepFreezeData<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) deepFreezeData(descriptor.value)
  }
  Object.freeze(value)
  return value
}

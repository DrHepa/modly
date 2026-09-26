import type { WorldEditorControllerState } from '../../src/areas/worlds/editor/worldEditorController.ts'
import type { WorldProjectSnapshotV1, WorldTransform } from '../../src/areas/worlds/core/worldModel.ts'
import { parseWorldAiContext } from '../../src/areas/worlds/core/worldAiContract.ts'

// Fixed path-free admission profile, never read from global preferences or inherited provider environment.
export const LOCAL_AI_PATH_ADMISSION = Object.freeze({
  apiRootRelative: 'api',
  pythonPathRelative: 'api/.venv/bin/python',
})
export const LOCAL_AI_PROFILE = Object.freeze({
  ollamaUrl: 'http://127.0.0.1:11434', roundSeconds: 60, startupSeconds: 30,
  turnSeconds: 100, bodySeconds: 5, modelsSeconds: 8, cleanupSeconds: 8,
  mainWatchdogSeconds: 420, runnerWatchdogSeconds: 430, outerSeconds: 450,
  bodyBytes: 65536, responseBytes: 65536, logBytes: 1048576,
  queryCount: 80, queryTotalBytes: 2621440, modelRequests: 8, chatRequests: 4,
})
export type LocalAiConfig = Readonly<{ apiRoot: string; pythonPath: string } & typeof LOCAL_AI_PROFILE>
export function createLocalAiConfig(apiRoot: string, pythonPath: string): LocalAiConfig {
  if (!apiRoot || !pythonPath || /[\0\r\n]/.test(apiRoot) || /[\0\r\n]/.test(pythonPath)) throw new Error('Invalid materialized local-AI path')
  return Object.freeze({ apiRoot, pythonPath, ...LOCAL_AI_PROFILE })
}
export interface ReviewedAiModel { name: string; digest: string; toolsReviewed: true }
export function parseReviewedAiModel(value: unknown): Readonly<ReviewedAiModel> {
  const record = aiExact(value, ['name', 'digest', 'toolsReviewed'])
  if (record.toolsReviewed !== true || parseLocalAiModels({ models: [{ name: record.name, digest: record.digest }] }).size !== 1) throw new Error('Explicit reviewed tool-capable model identity required')
  return Object.freeze({ name: record.name as string, digest: record.digest as string, toolsReviewed: true })
}
export const LOCAL_AI_SESSION_METHODS = ['list', 'create', 'read', 'activate', 'appendMessage'] as const
function aiRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid local-AI record')
  return value as Record<string, unknown>
}
function aiExact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = aiRecord(value)
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) throw new Error('Invalid local-AI fields')
  return record
}
const LOCAL_AI_CONFIG_KEYS = Object.freeze(['apiRoot', 'pythonPath', ...Object.keys(LOCAL_AI_PROFILE)])
function validateLocalAiConfigShape(value: unknown): LocalAiConfig {
  const record = aiExact(value, LOCAL_AI_CONFIG_KEYS)
  const { roundSeconds, turnSeconds } = record
  if (typeof roundSeconds !== 'number' || !Number.isFinite(roundSeconds) || roundSeconds <= 0 || roundSeconds > 60
    || typeof turnSeconds !== 'number' || !Number.isFinite(turnSeconds) || roundSeconds >= turnSeconds) {
    throw new Error('Local-AI round deadline must be finite, positive, at most 60 seconds, and shorter than the turn deadline')
  }
  if (typeof record.apiRoot !== 'string' || typeof record.pythonPath !== 'string'
    || !record.apiRoot || !record.pythonPath || /[\0\r\n]/.test(record.apiRoot) || /[\0\r\n]/.test(record.pythonPath)) throw new Error('Invalid materialized local-AI path')
  for (const key of Object.keys(LOCAL_AI_PROFILE) as Array<keyof typeof LOCAL_AI_PROFILE>) if (record[key] !== LOCAL_AI_PROFILE[key]) throw new Error(`Invalid local-AI configuration ${key}`)
  return value as LocalAiConfig
}
export interface WorldAuthoringRepositoryAdmission {
  schema: 'modly.worlds-authoring-repository-admission.v1'
  root: string
  head: string
  branch: string
}
export function validateRepositoryAdmission(
  value: unknown,
  expectedRoot: string,
  expectedHead: string,
  expectedBranch: string,
): Readonly<WorldAuthoringRepositoryAdmission> {
  let record: Record<string, unknown>
  try { record = aiExact(value, ['schema', 'root', 'head', 'branch']) }
  catch (error) { throw new Error('Invalid Worlds authoring repository admission fields', { cause: error }) }
  if (record.schema !== 'modly.worlds-authoring-repository-admission.v1'
    || typeof expectedRoot !== 'string' || !expectedRoot || expectedRoot.includes('\0') || record.root !== expectedRoot
    || typeof expectedHead !== 'string' || !/^[a-f0-9]{40}$/.test(expectedHead) || record.head !== expectedHead
    || typeof expectedBranch !== 'string' || !expectedBranch || expectedBranch.includes('\0') || record.branch !== expectedBranch) {
    throw new Error('Invalid Worlds authoring repository admission')
  }
  return value as WorldAuthoringRepositoryAdmission
}
export function validateLocalAiConfig(value: unknown, expectedConfig: LocalAiConfig): LocalAiConfig {
  const config = validateLocalAiConfigShape(value)
  const expected = validateLocalAiConfigShape(expectedConfig)
  for (const key of LOCAL_AI_CONFIG_KEYS as readonly (keyof LocalAiConfig)[]) if (config[key] !== expected[key]) throw new Error(`Invalid local-AI configuration ${key}`)
  return config
}
export function localAiEnvironment(run: string): Record<string, string> {
  if (!run.startsWith('/tmp/') || run.includes('..') || run.endsWith('/')) throw new Error('Private local-AI root required')
  return { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: `${run}/api-home`, TMPDIR: `${run}/api-tmp`,
    XDG_CACHE_HOME: `${run}/api-cache`, XDG_CONFIG_HOME: `${run}/api-config`, XDG_DATA_HOME: `${run}/api-data`,
    MODELS_DIR: `${run}/api-models`, WORKSPACE_DIR: `${run}/workspace`, EXTENSIONS_DIR: `${run}/empty-extensions`,
    SELECTED_MODEL_ID: '', PYTHONUNBUFFERED: '1', MODLY_AGENT_OLLAMA_ROUND_DEADLINE_SECONDS: String(LOCAL_AI_PROFILE.roundSeconds) }
}
export function parseOwnedBridgeOrigin(value: unknown): string {
  const match = typeof value === 'string' ? /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(value) : null
  if (!match || match[0] !== value || Number(match[1]) > 65535) throw new Error('Invalid owned automation bridge origin')
  return value as string
}
export function localAiBridgeEnvironment(run: string, origin: unknown): Record<string, string> {
  const bridgeOrigin = parseOwnedBridgeOrigin(origin)
  return { ...localAiEnvironment(run), MODLY_AUTOMATION_BRIDGE_ORIGIN: bridgeOrigin }
}
export function localAiPythonArguments(config: LocalAiConfig): string[] {
  validateLocalAiConfigShape(config)
  return ['-I', '-B', '-m', 'uvicorn', 'main:app', '--app-dir', config.apiRoot, '--host', '127.0.0.1', '--port', '0',
    '--workers', '1', '--lifespan', 'on', '--loop', 'asyncio', '--http', 'h11', '--no-access-log']
}
export function isLocalAiRoute(url: string, method: string, origin: string): boolean {
  return (method === 'POST' && url === `${origin}/agent/chat`)
    || (method === 'GET' && url === `${origin}/agent/models?ollama_url=${encodeURIComponent(LOCAL_AI_PROFILE.ollamaUrl)}`)
}
export function isLocalAiHttpRequest(method: string, route: string, headers: Record<string, string | string[] | undefined>, origin: string, indexUrl: string): boolean {
  const allowedHeaders = ['host', 'connection', 'content-length', 'content-type', 'origin', 'referer', 'user-agent', 'accept', 'accept-encoding', 'accept-language',
    'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'priority']
  return isLocalAiRoute(`${origin}${route}`, method, origin) && headers.host === origin.slice(7) && headers.referer === indexUrl
    && Object.keys(headers).every((name) => allowedHeaders.includes(name) && typeof headers[name] === 'string')
    && (headers['sec-fetch-site'] === undefined || headers['sec-fetch-site'] === 'same-origin')
    && (method === 'POST' ? headers.origin === origin && headers['content-type'] === 'application/json' : headers.origin === undefined || headers.origin === origin)
}
export function parseUvicornAddress(captured: string): string | null {
  const match = captured.match(/(?:^|\n)INFO:\s+Uvicorn running on (http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})) \(Press CTRL\+C to quit\)(?:\r?\n|$)/)
  return match && Number(match[2]) <= 65535 ? match[1] : null
}
export function parseLocalAiModels(value: unknown): Map<string, string> {
  const record = aiExact(value, ['models']), models = new Map<string, string>()
  if (!Array.isArray(record.models) || record.models.length > 128) throw new Error('Invalid actual model discovery')
  for (const value of record.models) {
    const model = aiExact(value, ['name', 'digest'])
    if (typeof model.name !== 'string' || !model.name || model.name.length > 200 || model.name !== model.name.trim()
      || /[\x00-\x1f\x7f]/.test(model.name) || typeof model.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(model.digest) || models.has(model.name)) throw new Error('Invalid actual model identity')
    models.set(model.name, model.digest)
  }
  return models
}
export function parseLocalAiChat(value: unknown, discovered: ReadonlyMap<string, string>, config: LocalAiConfig) {
  validateLocalAiConfigShape(config)
  if (new TextEncoder().encode(JSON.stringify(value)).length > config.bodyBytes) throw new Error('Local-AI chat body exceeds limit')
  const record = aiExact(value, ['messages', 'model', 'ollama_url', 'thinking', 'originSessionId', 'worldContext', 'context'])
  const context = parseWorldAiContext(record.worldContext)
  const model = record.model, digest = typeof model === 'string' ? discovered.get(model) : undefined
  if (record.ollama_url !== config.ollamaUrl || typeof model !== 'string' || !model || model.length > 200 || model !== model.trim()
    || /[\x00-\x1f\x7f]/.test(model) || typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(digest)
    || record.originSessionId !== context.originSessionId || typeof record.thinking !== 'string' || !['auto', 'on', 'off'].includes(record.thinking)
    || Object.keys(aiRecord(record.context)).length || !Array.isArray(record.messages) || record.messages.length !== 1) throw new Error('Local-AI chat authority rejected')
  const message = aiRecord(record.messages[0])
  if (Object.keys(message).some((key) => !['role', 'content', 'images'].includes(key)) || message.role !== 'user'
    || typeof message.content !== 'string' || !message.content.trim() || (message.images !== undefined && (!Array.isArray(message.images) || message.images.length))) throw new Error('Local-AI accepts text-only user Worlds requests')
  // Discovery identity is immutable admission metadata, not inference-weight proof or part of the canonical DTO.
  const admittedSelection = Object.freeze({ name: model, digest })
  return { request: { ...record, model, worldContext: context, originSessionId: context.originSessionId }, admittedSelection }
}

export const PROJECT_KEY = `world-${'7'.repeat(32)}`
export const SCENE_KEY = `scene-${'8'.repeat(32)}`
export const PROJECT_ID = 'project:native-authoring'
export const SCENE_ID = 'scene:native-authoring'
export const NAMES = { a: 'A — red cube', b: 'B — blue pyramid', sentinel: 'Untouched sentinel' } as const
export const CHECK_NAMES = [
  'positive-canvas-admission', 'native-select-and-duplicate', 'native-drag-preview',
  'pending-selection-and-overlap-denial', 'captured-target-commit', 'native-undo',
  'native-redo', 'fresh-repository-and-renderer-reopen',
] as const
export const UI_CHECK_NAMES = ['native-ui-project-and-both-scenes', 'native-numeric-authoring', 'native-both-scenes-reopen'] as const
export const AI_CHECK_NAMES = ['actual-model-discovery', 'actual-ai-reject', 'actual-ai-apply-and-history', 'actual-ai-both-scenes-reopen'] as const
export type CheckName = typeof CHECK_NAMES[number] | typeof UI_CHECK_NAMES[number] | typeof AI_CHECK_NAMES[number]
export interface Check { name: CheckName; status: 'UNREACHED' | 'PASS' | 'FAIL'; reason?: string }
export interface Rect { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }
export interface WorldCornerObservation {
  world: [number, number, number]; ndc: [number, number, number]; depth: number
}
export interface ModelObservation {
  entityId: string; uuid: string; name: string; transform: WorldTransform
  matrixWorld: number[]; meshes: number; triangles: number; visible: boolean; bounds: Rect | null
  worldCorners: WorldCornerObservation[]
}
export interface HandleCandidate {
  axis: 'X' | 'Y' | 'Z'; start: Point; end: Point; pickerUuid: string; firstHitAxis: string
}
export interface NativePointerHit {
  canvasUuid: string | null; targetCanvas: boolean; trusted: boolean; sequence: number; frame: number | null
  type: string; buttons: number; point: Point; firstHitAxis: string | null; pickerUuid: string | null
}
export interface CanvasObservation {
  canvasUuid: string; rect: Rect; drawingBuffer: [number, number]; contextLost: boolean; frame: number
  gl: { version: string; vendor: string; renderer: string; unmaskedVendor: string | null; unmaskedRenderer: string | null }
  camera: number[]; models: ModelObservation[]
  cameraFraming: { uuid: string; near: number; far: number; matrixWorldInverse: number[] }
  gizmo: null | { controlUuid: string; enabled: boolean; pointerHit: NativePointerHit | null; objectUuid: string; entityId: string | null; mode: string; axis: string | null; dragging: boolean; candidates: HandleCandidate[] }
}
export interface NativeTrace {
  sequence: number; at: string; type: string; trusted: boolean; x: number | null; y: number | null
  buttons: number | null; target: string; canvasUuid: string | null; frame: number | null
}
export interface AiReviewObservation {
  expanded: boolean; prompt: string | null; promptDisabled: boolean; sendEnabled: boolean
  selectedModel: string | null; modelOptions: string[]; busy: boolean; focused: boolean; status: string
  details: Array<{ entityName: string; property: string; before: string; after: string }>
  warnings: string[]; applyEnabled: boolean; rejectEnabled: boolean
}
export interface AuthoringView {
  bootId: string; at: string; environment: { sandboxed: boolean; contextIsolated: boolean }
  nodeGlobals: { require: string; process: string }; hostSetupComplete: boolean
  editor: WorldEditorControllerState
  selection: { ids: string[]; active: string | null; mode: string | null }
  canvasCount: number; canvas: CanvasObservation | null; diagnostics: string[]
  alerts: string[]; statuses: string[]; inspectorName: string | null; inspectorValues: { label: string; value: string; disabled: boolean }[]
  assetButtons: string[]
  selectValues: { label: string; value: string }[]
  viewport: Rect
  trace: NativeTrace[]; untrustedInputs: number
  aiReview: AiReviewObservation
}
export interface SeedEvidence {
  snapshot: WorldProjectSnapshotV1; aId: string; bId: string; sentinelSceneId: string
}

declare global {
  interface Window {
    readonly worldsAuthoringEnvironment: Readonly<{ sandboxed: boolean; contextIsolated: boolean }>
    readonly worldsAuthoringObserve: () => AuthoringView
  }
}

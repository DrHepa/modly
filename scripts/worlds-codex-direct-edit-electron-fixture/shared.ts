import type { WorldEditorControllerState } from '../../src/areas/worlds/editor/worldEditorController.ts'

export const FIXTURE_SCENARIOS = ['primary', 'duplicate-loss', 'cancellation'] as const
export type FixtureScenario = typeof FIXTURE_SCENARIOS[number]

export const PROJECT_KEY = `world-${'c'.repeat(32)}`
export const PROJECT_ID = 'project:c3-native-fixture'
export const SCENE_KEY = `scene-${'d'.repeat(32)}`
export const SCENE_ID = 'scene:c3-native-fixture'
export const TARGET_ENTITY_ID = 'entity:c3-native-target'
export const TARGET_ENTITY_NAME = 'Fixture target'
export const RENAMED_ENTITY_NAME = 'Codex renamed target'

export const NATIVE_LABELS = {
  primary: 'PASS_NATIVE_PRIMARY',
  'duplicate-loss': 'PASS_NATIVE_DUPLICATE_LOSS',
  cancellation: 'PASS_NATIVE_CANCELLATION',
} as const
export const OVERALL_NATIVE_LABEL = 'ACCEPT_NATIVE_C3'
export const NATIVE_BUDGET_LABEL = 'UNTESTED_NATIVE'

export const SANDBOX_DISABLING_SWITCHES = [
  'no-sandbox', 'no-zygote', 'disable-setuid-sandbox', 'disable-gpu-sandbox',
  'disable-web-security', 'allow-running-insecure-content',
] as const

export interface Receipt { bytes: number; sha256: string }
export interface SourceReceipt extends Receipt { path: string }
export interface ScenarioPaths {
  root: string
  workspace: string
  runtime: string
  profile: string
  evidence: string
}
export interface FixtureEnvironmentContract {
  schema: 'modly.worlds-c3-environment-contract.v1'
  entries: Array<[name: string, utf8Bytes: number, valueSha256: string]>
  sha256: string
}
export interface FixtureRuntimeIdentity {
  schema: 'modly.worlds-c3-runtime-identity.v1'
  electronVersion: string
  platform: string
  arch: string
  executable: { path: string; type: 'file'; uid: number; mode: string; nlink: number; size: number; sha256: string }
}
export interface FixtureRuntimeEnvironmentAllowance {
  schema: 'modly.worlds-c3-runtime-environment-allowance.v1'
  entries: Array<{ name: string; required: true; value: string; receipt: [name: string, utf8Bytes: number, valueSha256: string] }>
  runtimeEnvironmentAllowanceSha256: string
  runtimeIdentity: FixtureRuntimeIdentity
  runtimeIdentitySha256: string
  liveEnvironmentAdmissionSha256: string
}
export interface FixtureLaunch {
  paths: Record<'stateRoot' | 'userData' | 'sessionData' | 'crashDumps' | 'home' | 'config' | 'cache' | 'tmp' | 'workspace' | 'runtime' | 'profiles' | 'x11', string>
  display: { name: string; number: number; authorityPath: string; lockPath: string; socketPath: string }
  supervisor: {
    commandShape: string
    expectedOwnerUid: number
    environmentKeys: string[]
    evidencePath: string
    startedEvidencePath: string
  }
  scenarios: Record<FixtureScenario, ScenarioPaths>
  argv: string[]
  environment: Record<string, string>
  preparedDirectories: Array<{ path: string; uid: number; mode: number }>
  environmentContract: FixtureEnvironmentContract
  runtimeEnvironmentAllowance: FixtureRuntimeEnvironmentAllowance
  argvSha256: string
  launchBindingSha256: string
}
export interface FixtureBuildManifest {
  schema: 'modly.worlds-codex-direct-edit-native-build.v1'
  scope: 'source-module-c3-direct-edit-native-fixture'
  execution: 'NOT_RUN'
  nativeEvidence: 'ABSENT'
  outputDirectory: string
  repositoryRoot: string
  builtAt: string
  versions: Record<string, string>
  outputs: Record<string, Receipt>
  outputInventory: string[]
  sourceInputs: SourceReceipt[]
  sourceAggregateSha256: string
  sourceGraph: {
    definition: 'esbuild-metafiles+vite-load-graph+fixture-tree+project-local-config-import-closure'
    configExecutionClosure: string[]
  }
  gitCustody: { head: string; branch: string; porcelain: Receipt }
  launch: FixtureLaunch
  nextCommand: string
  limits: string[]
}
export interface FixtureStartup {
  bundleDirectory: string
  build: FixtureBuildManifest
  launch: FixtureLaunch
  builtinFileAccess: boolean
  assertLiveEnvironment(environment: Readonly<Record<string, string | undefined>>): void
  takeOwnership(fail: (error: unknown) => void): void
}

export interface SafeControllerView {
  lifecycle: WorldEditorControllerState['lifecycle']
  editorEpoch: number
  projectKey: string | null
  projectId: string | null
  activeSceneId: string | null
  revision: number | null
  entityNames: Array<{ id: string; name: string }>
  undo: string[]
  redo: string[]
  externalCliUndoTransactionId: string | null
  canUndo: boolean
  canRedo: boolean
  error: string | null
}
export interface RendererTrace {
  sequence: number
  type: 'keydown' | 'keyup' | 'click' | 'controller' | 'navigation'
  trusted: boolean
  key: string | null
  label: string
}
export interface FixtureRendererView {
  scenario: FixtureScenario | null
  environment: { sandboxed: boolean; contextIsolated: boolean }
  requireType: string
  processType: string
  page: string
  controller: SafeControllerView
  trace: RendererTrace[]
  navigationResult: boolean | null
  error: string | null
}

export interface UdsTranscriptEntry {
  sequence: number
  direction: 'inbound' | 'outbound'
  operation: string
  bytes: number
  sha256: string
  safe: unknown
}
export interface FixtureEvent {
  sequence: number
  at: number
  scenario: FixtureScenario
  type: string
  detail?: unknown
}

export function isFixtureScenario(value: unknown): value is FixtureScenario {
  return typeof value === 'string' && (FIXTURE_SCENARIOS as readonly string[]).includes(value)
}

export function assertFixtureLaunch(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, launch: FixtureLaunch,
  assertLiveEnvironment: (environment: Readonly<Record<string, string | undefined>>) => void): void {
  if (!launch || JSON.stringify(argv) !== JSON.stringify(launch.argv)) throw new Error('Only the exact prepared native launch is accepted.')
  if (argv.length !== 3 || argv[1] !== `${launch.paths.stateRoot.slice(0, -'/native-state'.length)}/bootstrap.cjs`
    || argv[2] !== `--user-data-dir=${launch.paths.userData}`) throw new Error('Unexpected native fixture argument.')
  assertLiveEnvironment(env)
  if (env.DISPLAY !== launch.display.name || env.XAUTHORITY !== launch.display.authorityPath) throw new Error('Pinned display custody mismatch.')
}

export function safeControllerState(state: WorldEditorControllerState): SafeControllerView {
  const snapshot = state.session?.snapshot ?? null
  return {
    lifecycle: state.lifecycle,
    editorEpoch: state.editorEpoch,
    projectKey: state.projectKey,
    projectId: snapshot?.project.projectId ?? null,
    activeSceneId: state.activeSceneId,
    revision: snapshot?.project.revision ?? null,
    entityNames: snapshot?.scenes.flatMap((scene) => scene.entities.map((entity) => ({ id: entity.id, name: entity.name }))) ?? [],
    undo: state.session?.undoStack.map((entry) => entry.transactionId) ?? [],
    redo: state.session?.redoStack.map((entry) => entry.transactionId) ?? [],
    externalCliUndoTransactionId: state.externalCliUndoTransactionId,
    canUndo: state.canUndo,
    canRedo: state.canRedo,
    error: state.error?.message ?? null,
  }
}

export function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error('Unexpected fixture record.')
  return value as Record<string, unknown>
}

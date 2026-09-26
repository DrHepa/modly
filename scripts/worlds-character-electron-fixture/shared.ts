import type { WorldProjectSnapshotV1 } from '../../src/areas/worlds/core/worldModel.ts'

export const FIXTURE_PROJECT_KEY = `world-${'1'.repeat(32)}`
export const FIXTURE_SCENE_KEY = `scene-${'2'.repeat(32)}`
export const FIXTURE_TARGET_NAME = 'Character target'
export const SANDBOX_DISABLING_SWITCHES = ['no-sandbox', 'no-zygote', 'disable-setuid-sandbox', 'disable-gpu-sandbox'] as const

export function assertSandboxLaunch(argv: readonly string[], environment: Readonly<Record<string, string | undefined>>): void {
  for (const argument of argv) {
    if (SANDBOX_DISABLING_SWITCHES.some((flag) => argument === `--${flag}` || argument.startsWith(`--${flag}=`))) {
      throw new Error(`Refusing sandbox-disabling argument: ${argument}`)
    }
  }
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_DISABLE_SANDBOX']) {
    if (environment[name]) throw new Error(`Refusing inherited ${name} environment value.`)
  }
  if (argv.slice(2).length > 0) throw new Error('The sandboxed fixture does not accept runtime arguments.')
}

export interface FixtureEnvironment {
  sandboxed: boolean
  contextIsolated: boolean
}

export interface FixtureInputEvidence {
  pointerdown: number
  keydown: number
  input: number
  change: number
  untrusted: number
}

export interface FixtureControlEvidence {
  tagName: string
  label: string
  section: string
  legends: string[]
  value: string | null
  selectionStart: number | null
  selectionEnd: number | null
}

export interface FixtureTraceEvent {
  sequence: number
  type: string
  trusted: boolean
  key: string | null
  code: string | null
  charCode: number | null
  defaultPrevented: boolean
  inputType: string | null
  data: string | null
  target: FixtureControlEvidence | null
  active: FixtureControlEvidence | null
}

export interface FixtureView {
  bootId: string
  environment: FixtureEnvironment
  requireType: string
  processType: string
  initializing: boolean
  lifecycle: string
  error: string | null
  projectKey: string | null
  activeSceneId: string | null
  savedRevision: number | null
  canUndo: boolean
  canRedo: boolean
  cancelledEnterClicks: number
  snapshot: WorldProjectSnapshotV1 | null
  inputs: FixtureInputEvidence
  trace: FixtureTraceEvent[]
}

export interface FixtureCheckpoint {
  name: string
  revision: number
  bootId: string
  inputs: FixtureInputEvidence
  environment: FixtureEnvironment
  requireType: string
  processType: string
  cancelledEnterClicks: number
  trace: FixtureTraceEvent[]
  snapshot: WorldProjectSnapshotV1
}

export type FixtureLocator =
  | { kind: 'button'; label: string }
  | { kind: 'summary'; text: string }
  | { kind: 'field'; section: string; label: string; legend?: string; binding?: number }

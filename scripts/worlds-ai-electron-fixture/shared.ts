import type { WorldProjectSnapshotV1 } from '../../src/areas/worlds/core/worldModel.ts'
import type { WorldAiChatState } from '../../src/areas/worlds/editor/worldAiChatAdapter.ts'

export const PROJECT_KEY = `world-${'a'.repeat(32)}`
export const SCENE_KEY = `scene-${'b'.repeat(32)}`
export const TARGET_NAME = 'Fixture target'
export const REVIEWED_NAME = 'Reviewed target'
export const PROMPT = 'Rename the target to Reviewed target.'
export const STUB_MODEL = 'worlds-fixture-stub'

export const SANDBOX_DISABLING_SWITCHES = ['no-sandbox', 'no-zygote', 'disable-setuid-sandbox', 'disable-gpu-sandbox'] as const
export interface FixtureLaunch {
  paths: Record<'stateRoot' | 'userData' | 'sessionData' | 'crashDumps' | 'home' | 'config' | 'cache' | 'tmp' | 'agentSessions', string>
  argv: string[]
  environment: Record<string, string>
  preparedDirectories: Array<{ path: string; uid: number; mode: number }>
}
export interface FixtureStartup {
  bundleDirectory: string
  launch: FixtureLaunch
  build: { outputs: Record<string, { bytes: number; sha256: string }>; pythonExecutable: string }
  builtinFileAccess: boolean
  takeOwnership(fail: (error: unknown) => void): void
}

export function assertFixtureLaunch(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, launch: FixtureLaunch): void {
  if (!launch || argv.length !== 3 || JSON.stringify(argv) !== JSON.stringify(launch.argv)
    || argv[1] !== `${launch.paths.stateRoot.slice(0, -'/native-state'.length)}/bootstrap.cjs`
    || argv[2] !== `--user-data-dir=${launch.paths.userData}`) throw new Error('Only the exact prepared private startup arguments are accepted.')
  if (launch.environment.DBUS_SESSION_BUS_ADDRESS !== 'disabled:' || env.DBUS_SESSION_BUS_ADDRESS !== 'disabled:') {
    throw new Error('Private startup environment mismatch: DBUS_SESSION_BUS_ADDRESS.')
  }
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_DISABLE_SANDBOX', 'SESSION_MANAGER']) {
    if (Object.hasOwn(env, name)) throw new Error(`Refusing inherited ${name}.`)
  }
  for (const [name, expected] of Object.entries(launch.environment)) if (env[name] !== expected) throw new Error(`Private startup environment mismatch: ${name}.`)
  if (!/^:(?:[9][0-9]|[1-9][0-9]{2,})(?:\.0)?$/.test(env.DISPLAY ?? '')) throw new Error('A fresh private Xvfb display is required; user displays are forbidden.')
}

export function requireEphemeralOrigin(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Missing owned loopback origin.')
  const url = new URL(value)
  const port = Number(url.port)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || url.origin !== value
    || !Number.isInteger(port) || port < 1024 || port > 65535 || [8765, 8766, 11434].includes(port)) {
    throw new Error('Only an owned ephemeral loopback origin is accepted.')
  }
  return value
}

/** Deliberate allowlist: no proxies, credentials, user Python/Node paths or display inheritance. */
export function childEnvironment(runDirectory: string): Record<string, string> {
  return { HOME: runDirectory, TMPDIR: runDirectory, XDG_CACHE_HOME: runDirectory, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }
}

export function isFixtureSender(event: unknown, window: { isDestroyed(): boolean; webContents: { mainFrame: unknown } }): boolean {
  if (!event || typeof event !== 'object' || window.isDestroyed()) return false
  return Reflect.get(event, 'sender') === window.webContents && Reflect.get(event, 'senderFrame') === window.webContents.mainFrame
}

export function createRunFence() {
  let closed = false
  return { close() { closed = true }, assertOpen() { if (closed) throw new Error('Fixture lifecycle has ended.') } }
}

export interface FixtureConfig { apiOrigin: string }
export interface TraceEntry { sequence: number; type: string; trusted: boolean; key: string | null; label: string; tag: string }
export interface FixtureView {
  bootId: string
  environment: { sandboxed: boolean; contextIsolated: boolean }
  requireType: string
  processType: string
  initializing: boolean
  error: string | null
  snapshot: WorldProjectSnapshotV1 | null
  ai: WorldAiChatState
  sessionId: string | null
  sessionInitialized: boolean
  messages: Array<{ id: string; role: string; content: string }>
  trace: TraceEntry[]
  untrusted: number
}

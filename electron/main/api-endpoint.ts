import { createServer, type Server } from 'node:net'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'

const API_HOST = '127.0.0.1'
const DEFAULT_API_PORT = 8765

export function resolveApiEndpoint(env: NodeJS.ProcessEnv = process.env): { port: number; baseUrl: string; isolated: boolean } {
  const rawPort = env['MODLY_API_PORT']
  const port = rawPort === undefined ? DEFAULT_API_PORT : Number(rawPort)
  if (!/^\d+$/.test(rawPort ?? String(DEFAULT_API_PORT)) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('MODLY_API_PORT must be an integer TCP port between 1 and 65535')
  }
  const isolated = env['MODLY_ISOLATED_DEV'] === '1'
  if (isolated && port === DEFAULT_API_PORT) {
    throw new Error('MODLY_ISOLATED_DEV requires a private MODLY_API_PORT other than 8765')
  }
  return { port, baseUrl: `http://${API_HOST}:${port}`, isolated }
}

export function resolveIsolatedUserDataDir(env: NodeJS.ProcessEnv, defaultUserDataDir: string, sharedDataDirs: string[] = []): string | null {
  if (env['MODLY_ISOLATED_DEV'] !== '1') return null
  const dir = env['MODLY_ISOLATED_USER_DATA_DIR']
  if (!dir || !isAbsolute(dir)) throw new Error('Isolated Modly requires an absolute MODLY_ISOLATED_USER_DATA_DIR')
  const privateDir = canonicalPath(dir)
  if ([defaultUserDataDir, ...sharedDataDirs].some((dir) => {
    const shared = canonicalPath(dir)
    return overlap(privateDir, shared) || overlap(shared, privateDir)
  })) {
    throw new Error('Isolated Modly user data must be separate from installed Modly')
  }
  return privateDir
}

function canonicalPath(path: string): string {
  const absolute = resolve(path)
  if (existsSync(absolute)) return realpathSync(absolute)
  const parent = resolve(absolute, '..')
  if (parent === absolute) return absolute
  return resolve(canonicalPath(parent), basename(absolute))
}

function overlap(root: string, child: string): boolean {
  const rel = relative(root, child)
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel))
}

export function assertPrivateDataPath(path: string, isolatedUserDataDir: string): void {
  if (!isAbsolute(path)) throw new Error('Isolated Modly data path must be absolute')
  const root = canonicalPath(isolatedUserDataDir)
  const candidate = canonicalPath(path)
  if (candidate === root || !overlap(root, candidate)) {
    throw new Error('Isolated Modly data path must be beneath its private user data directory')
  }
}

// Probe without terminating a listener. A port race is still possible; Uvicorn
// will fail its own bind if another process takes the port after this check.
export async function assertApiPortAvailable(port: number, serverFactory: () => Server = createServer): Promise<void> {
  const server = serverFactory()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, API_HOST, resolve)
    })
  } catch (error) {
    throw new Error(`Modly API port ${port} is already in use; refusing to stop another process`, { cause: error })
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

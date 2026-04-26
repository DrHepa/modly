import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AutomationCapabilitiesResponse } from './automation-capabilities.ts'
import {
  ProcessRunServiceError,
  type CreateProcessRunRequest,
  type ProcessRunError,
  type ProcessRunSnapshot,
} from './process-runs-service.ts'
import {
  createSceneImportService,
  type SceneImportMeshRequest,
  type SceneImportMeshResult,
} from './scene-import-service.ts'

export const AUTOMATION_HTTP_BRIDGE_HOST = '127.0.0.1'
export const AUTOMATION_HTTP_BRIDGE_PORT = 8766
export const AUTOMATION_HTTP_BRIDGE_PATH = '/automation/capabilities'
export const PROCESS_RUNS_HTTP_BRIDGE_PATH = '/process-runs'
export const SCENE_IMPORT_MESH_HTTP_BRIDGE_PATH = '/scene/import-mesh'

let defaultProcessRunsServicePromise: Promise<import('./process-runs-service.ts').ProcessRunsService> | null = null

type AutomationHttpBridgeDeps = {
  createServer: typeof createServer
  getAutomationCapabilities: () => Promise<AutomationCapabilitiesResponse>
  createProcessRun: (request: CreateProcessRunRequest) => Promise<ProcessRunSnapshot>
  getProcessRun: (runId: string) => Promise<ProcessRunSnapshot> | ProcessRunSnapshot
  cancelProcessRun: (runId: string) => Promise<ProcessRunSnapshot> | ProcessRunSnapshot
  importSceneMesh: (request: SceneImportMeshRequest) => Promise<SceneImportMeshResult>
  logger: {
    info: (message: string) => void
    warn: (message: string) => void
    error: (message: string) => void
  }
}

type AutomationHttpBridgeOptions = Partial<AutomationHttpBridgeDeps> & {
  host?: string
  port?: number
}

const defaultAutomationHttpBridgeDeps: AutomationHttpBridgeDeps = {
  createServer,
  getAutomationCapabilities: async () => {
    const { getAutomationCapabilities } = await import('./automation-capabilities-service.ts')
    return getAutomationCapabilities()
  },
  createProcessRun: async (request) => {
    const service = await getDefaultProcessRunsService()
    return service.createAndStartRun(request)
  },
  getProcessRun: async (runId) => {
    const service = await getDefaultProcessRunsService()
    return service.getRun(runId)
  },
  cancelProcessRun: async (runId) => {
    const service = await getDefaultProcessRunsService()
    return service.cancelRun(runId)
  },
  importSceneMesh: async (request) => createSceneImportService().importMesh(request),
  logger: {
    info: (message) => {
      void import('./logger.ts')
        .then(({ logger }) => {
          logger.info(message)
        })
        .catch(() => {
          console.info(message)
        })
    },
    warn: (message) => {
      void import('./logger.ts')
        .then(({ logger }) => {
          logger.warn(message)
        })
        .catch(() => {
          console.warn(message)
        })
    },
    error: (message) => {
      void import('./logger.ts')
        .then(({ logger }) => {
          logger.error(message)
        })
        .catch(() => {
          console.error(message)
        })
    },
  },
}

async function getDefaultProcessRunsService(): Promise<import('./process-runs-service.ts').ProcessRunsService> {
  if (!defaultProcessRunsServicePromise) {
    defaultProcessRunsServicePromise = import('./process-runs-service.ts').then(({ createProcessRunsService }) => createProcessRunsService())
  }

  return defaultProcessRunsServicePromise
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

function writeProcessRunError(response: ServerResponse, statusCode: number, error: ProcessRunError): void {
  writeJson(response, statusCode, { error })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw.length === 0) return {}

  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new ProcessRunServiceError(400, {
      code: 'INVALID_JSON',
      message: 'Request body must be valid JSON.',
      retryable: false,
    })
  }
}

function assertCreateProcessRunRequest(value: unknown): CreateProcessRunRequest {
  if (!isPlainObject(value)) {
    throw new ProcessRunServiceError(400, {
      code: 'INVALID_JSON',
      message: 'Request body must be a JSON object.',
      retryable: false,
    })
  }

  return {
    process_id: value.process_id as string,
    workspace_path: value.workspace_path as string,
    params: isPlainObject(value.params) ? value.params : undefined,
  }
}

function assertSceneImportMeshRequest(value: unknown): SceneImportMeshRequest {
  if (!isPlainObject(value)) {
    throw new ProcessRunServiceError(400, {
      code: 'INVALID_JSON',
      message: 'Request body must be a JSON object.',
      retryable: false,
    })
  }

  return {
    meshPath: (value.meshPath ?? value.mesh_path) as string,
  }
}

function writeProcessRunSnapshot(response: ServerResponse, statusCode: number, snapshot: ProcessRunSnapshot): void {
  writeJson(response, statusCode, {
    run_id: snapshot.run_id,
    run: snapshot,
  })
}

function isProcessRunPath(pathname: string): boolean {
  return pathname === PROCESS_RUNS_HTTP_BRIDGE_PATH || pathname.startsWith(`${PROCESS_RUNS_HTTP_BRIDGE_PATH}/`)
}

function getProcessRunIdFromPath(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean)
  if (segments[0] !== 'process-runs' || segments.length < 2) return null
  return decodeURIComponent(segments[1] ?? '')
}

export class AutomationHttpBridge {
  private server: Server | null = null
  private startPromise: Promise<void> | null = null
  private readonly host: string
  private readonly port: number
  private readonly deps: AutomationHttpBridgeDeps

  constructor(options: AutomationHttpBridgeOptions = {}) {
    this.host = options.host ?? AUTOMATION_HTTP_BRIDGE_HOST
    this.port = options.port ?? AUTOMATION_HTTP_BRIDGE_PORT
    this.deps = {
      createServer: options.createServer ?? defaultAutomationHttpBridgeDeps.createServer,
      getAutomationCapabilities: options.getAutomationCapabilities ?? defaultAutomationHttpBridgeDeps.getAutomationCapabilities,
      createProcessRun: options.createProcessRun ?? defaultAutomationHttpBridgeDeps.createProcessRun,
      getProcessRun: options.getProcessRun ?? defaultAutomationHttpBridgeDeps.getProcessRun,
      cancelProcessRun: options.cancelProcessRun ?? defaultAutomationHttpBridgeDeps.cancelProcessRun,
      importSceneMesh: options.importSceneMesh ?? defaultAutomationHttpBridgeDeps.importSceneMesh,
      logger: options.logger ?? defaultAutomationHttpBridgeDeps.logger,
    }
  }

  async start(): Promise<void> {
    if (this.server?.listening) return
    if (this.startPromise) return this.startPromise

    this.startPromise = this.listen()

    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null

    if (!server) return

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    })
  }

  getOrigin(): string | null {
    const address = this.server?.address()
    if (!address || typeof address === 'string') return null

    const normalizedHost = address.family === 'IPv6' ? `[${address.address}]` : address.address
    return `http://${normalizedHost}:${address.port}`
  }

  private async listen(): Promise<void> {
    if (this.server?.listening) return

    const server = this.deps.createServer((request, response) => {
      void this.handleRequest(request, response)
    })

    this.server = server

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.port, this.host, () => {
        server.off('error', reject)
        const address = server.address()
        const resolvedHost = address && typeof address !== 'string'
          ? (address.family === 'IPv6' ? `[${address.address}]` : address.address)
          : this.host
        const resolvedPort = address && typeof address !== 'string' ? address.port : this.port
        this.deps.logger.info(`Automation HTTP bridge listening on http://${resolvedHost}:${resolvedPort}${AUTOMATION_HTTP_BRIDGE_PATH}`)
        resolve()
      })
    }).catch((error) => {
      this.server = null
      throw error
    })
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const method = request.method ?? 'GET'
      const url = new URL(request.url ?? '/', `http://${this.host}:${this.port}`)

      if (url.pathname === AUTOMATION_HTTP_BRIDGE_PATH) {
        if (method !== 'GET') {
          response.setHeader('Allow', 'GET')
          writeJson(response, 405, { error: 'Method Not Allowed' })
          return
        }

        const payload = await this.deps.getAutomationCapabilities()

        if (!payload.backend_ready) {
          this.deps.logger.warn('Automation HTTP bridge returned partial capabilities payload with backend_ready=false')
        }

        writeJson(response, 200, payload)
        return
      }

      if (url.pathname === SCENE_IMPORT_MESH_HTTP_BRIDGE_PATH) {
        if (method !== 'POST') {
          response.setHeader('Allow', 'POST')
          writeJson(response, 405, { error: 'Method Not Allowed' })
          return
        }

        const body = await readJsonBody(request)
        const result = await this.deps.importSceneMesh(assertSceneImportMeshRequest(body))
        if (result.ok) {
          writeJson(response, result.statusCode, result.result)
          return
        }

        writeJson(response, result.statusCode, { error: result.error })
        return
      }

      if (!isProcessRunPath(url.pathname)) {
        writeJson(response, 404, { error: 'Not Found' })
        return
      }

      if (url.pathname === PROCESS_RUNS_HTTP_BRIDGE_PATH) {
        if (method !== 'POST') {
          response.setHeader('Allow', 'POST')
          writeJson(response, 405, { error: 'Method Not Allowed' })
          return
        }

        const body = await readJsonBody(request)
        const created = await this.deps.createProcessRun(assertCreateProcessRunRequest(body))
        writeProcessRunSnapshot(response, 201, created)
        return
      }

      const runId = getProcessRunIdFromPath(url.pathname)
      if (!runId) {
        writeJson(response, 404, { error: 'Not Found' })
        return
      }

      if (url.pathname === `${PROCESS_RUNS_HTTP_BRIDGE_PATH}/${encodeURIComponent(runId)}`) {
        if (method !== 'GET') {
          response.setHeader('Allow', 'GET')
          writeJson(response, 405, { error: 'Method Not Allowed' })
          return
        }

        const snapshot = await this.deps.getProcessRun(runId)
        writeProcessRunSnapshot(response, 200, snapshot)
        return
      }

      if (url.pathname === `${PROCESS_RUNS_HTTP_BRIDGE_PATH}/${encodeURIComponent(runId)}/cancel`) {
        if (method !== 'POST') {
          response.setHeader('Allow', 'POST')
          writeJson(response, 405, { error: 'Method Not Allowed' })
          return
        }

        const snapshot = await this.deps.cancelProcessRun(runId)
        writeProcessRunSnapshot(response, 200, snapshot)
        return
      }

      writeJson(response, 404, { error: 'Not Found' })
    } catch (error) {
      if (error instanceof ProcessRunServiceError) {
        writeProcessRunError(response, error.statusCode, error.error)
        return
      }

      this.deps.logger.error(`Automation HTTP bridge request failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)

      if (!response.headersSent) {
        writeProcessRunError(response, 500, {
          code: 'PROCESS_EXECUTION_FAILED',
          message: 'Internal server error.',
          retryable: false,
        })
        return
      }

      response.end()
    }
  }
}

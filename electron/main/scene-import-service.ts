import axios from 'axios'
import { createRequire } from 'node:module'
import { stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, normalize, relative, resolve as resolvePath } from 'node:path'

export const SCENE_IMPORT_MESH_ALLOWED_EXTENSIONS = ['.glb', '.obj', '.stl', '.ply'] as const
export const SCENE_IMPORT_MESH_EVENT = 'scene:importMesh'
const API_BASE_URL = 'http://127.0.0.1:8765'
const require = createRequire(import.meta.url)

export type SceneImportMeshRequest = {
  meshPath: string
}

export type SceneImportMeshPayload = {
  meshPath: string
  url: string
  displayName: string
}

export type SceneImportMeshError = {
  code: string
  field?: string
  message: string
  retryable: boolean
}

export type SceneImportMeshResult =
  | { ok: true; statusCode: 200; result: SceneImportMeshPayload }
  | { ok: false; statusCode: number; error: SceneImportMeshError }

type RendererWindowLike = {
  isDestroyed: () => boolean
  webContents: {
    isDestroyed: () => boolean
    send: (channel: string, payload: unknown) => void
  }
}

type BackendRequest = (method: 'GET' | 'POST', url: string, body?: unknown) => Promise<{ ok: boolean; data?: unknown; status?: number }>

export type SceneImportServiceDeps = {
  resolveWorkspaceDir: () => Promise<string> | string
  backendBaseUrl: string
  backendRequest: BackendRequest
  getRendererWindow: () => RendererWindowLike | null
}

function error(statusCode: number, payload: SceneImportMeshError): SceneImportMeshResult {
  return { ok: false, statusCode, error: payload }
}

function assertWorkspaceRelativeMeshPath(meshPath: unknown): string | SceneImportMeshResult {
  if (typeof meshPath !== 'string' || meshPath.trim().length === 0) {
    return error(400, {
      code: 'INVALID_WORKSPACE_PATH',
      field: 'meshPath',
      message: 'meshPath must be a non-empty workspace-relative string.',
      retryable: false,
    })
  }

  const trimmed = meshPath.trim()
  if (isAbsolute(trimmed)) {
    return error(400, {
      code: 'INVALID_WORKSPACE_PATH',
      field: 'meshPath',
      message: 'meshPath must be workspace-relative; absolute paths are rejected.',
      retryable: false,
    })
  }

  const normalizedPath = normalize(trimmed).replace(/\\/g, '/')
  if (
    normalizedPath === '.'
    || normalizedPath === '..'
    || normalizedPath.startsWith('../')
    || normalizedPath.includes('/../')
  ) {
    return error(400, {
      code: 'INVALID_WORKSPACE_PATH',
      field: 'meshPath',
      message: 'meshPath must stay inside the workspace; traversal is rejected.',
      retryable: false,
    })
  }

  const extension = extname(normalizedPath).toLowerCase()
  if (!SCENE_IMPORT_MESH_ALLOWED_EXTENSIONS.includes(extension as typeof SCENE_IMPORT_MESH_ALLOWED_EXTENSIONS[number])) {
    return error(400, {
      code: 'UNSUPPORTED_MESH_EXTENSION',
      field: 'meshPath',
      message: `meshPath must end with one of: ${SCENE_IMPORT_MESH_ALLOWED_EXTENSIONS.join(', ')}.`,
      retryable: false,
    })
  }

  return normalizedPath
}

function isOutsideWorkspace(absolutePath: string, workspaceDir: string): boolean {
  const normalizedRelative = relative(resolvePath(workspaceDir), resolvePath(absolutePath)).replace(/\\/g, '/')
  return normalizedRelative === '..' || normalizedRelative.startsWith('../') || isAbsolute(normalizedRelative)
}

function getDefaultRendererWindow(): RendererWindowLike | null {
  const { BrowserWindow } = require('electron') as { BrowserWindow: { getAllWindows: () => RendererWindowLike[] } }
  const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  return window ?? null
}

async function defaultBackendRequest(method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ ok: boolean; data?: unknown; status?: number }> {
  const response = method === 'GET'
    ? await axios.get(url, { timeout: 10_000 })
    : await axios.post(url, body, { timeout: 30_000 })

  return { ok: response.status >= 200 && response.status < 300, status: response.status, data: response.data }
}

const defaultSceneImportDeps: SceneImportServiceDeps = {
  resolveWorkspaceDir: async () => {
    const { app } = require('electron') as { app: { getPath: (name: string) => string } }
    const { getSettings } = await import('./settings-store.ts')
    return getSettings(app.getPath('userData')).workspaceDir
  },
  backendBaseUrl: API_BASE_URL,
  backendRequest: defaultBackendRequest,
  getRendererWindow: getDefaultRendererWindow,
}

export function createSceneImportService(options: Partial<SceneImportServiceDeps> = {}) {
  const deps: SceneImportServiceDeps = {
    ...defaultSceneImportDeps,
    ...options,
  }

  return {
    async importMesh(request: SceneImportMeshRequest): Promise<SceneImportMeshResult> {
      const normalizedPath = assertWorkspaceRelativeMeshPath(request.meshPath)
      if (typeof normalizedPath !== 'string') return normalizedPath

      const workspaceDir = resolvePath(await deps.resolveWorkspaceDir())
      const absolutePath = resolvePath(workspaceDir, normalizedPath)
      if (isOutsideWorkspace(absolutePath, workspaceDir)) {
        return error(400, {
          code: 'INVALID_WORKSPACE_PATH',
          field: 'meshPath',
          message: 'meshPath must stay inside the workspace; traversal is rejected.',
          retryable: false,
        })
      }

      try {
        const fileStat = await stat(absolutePath)
        if (!fileStat.isFile()) throw new Error('not a file')
      } catch {
        return error(404, {
          code: 'MESH_FILE_NOT_FOUND',
          field: 'meshPath',
          message: `Mesh file '${normalizedPath}' was not found in the configured workspace.`,
          retryable: false,
        })
      }

      const window = deps.getRendererWindow()
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
        return error(503, {
          code: 'RENDERER_UNAVAILABLE',
          message: 'Renderer window is not available; mesh was not imported into the scene.',
          retryable: true,
        })
      }

      try {
        await deps.backendRequest('GET', `${deps.backendBaseUrl}/health`)
      } catch (cause) {
        return error(503, {
          code: 'BACKEND_NOT_READY',
          message: `Backend runtime is not ready; GET /health failed before scene import. ${cause instanceof Error ? cause.message : String(cause)}`,
          retryable: true,
        })
      }

      let importResponse: { ok: boolean; data?: unknown; status?: number }
      try {
        importResponse = await deps.backendRequest('POST', `${deps.backendBaseUrl}/optimize/import-by-path`, { path: absolutePath })
      } catch (cause) {
        return error(502, {
          code: 'SCENE_IMPORT_BACKEND_FAILED',
          message: `Backend import-by-path request failed. ${cause instanceof Error ? cause.message : String(cause)}`,
          retryable: false,
        })
      }

      const data = importResponse.data as { url?: unknown } | undefined
      if (typeof data?.url !== 'string' || data.url.length === 0) {
        return error(502, {
          code: 'SCENE_IMPORT_BACKEND_FAILED',
          message: 'Backend import-by-path response did not include a mesh URL.',
          retryable: false,
        })
      }

      const payload: SceneImportMeshPayload = {
        meshPath: normalizedPath,
        url: data.url,
        displayName: basename(normalizedPath),
      }

      window.webContents.send(SCENE_IMPORT_MESH_EVENT, payload)
      return { ok: true, statusCode: 200, result: payload }
    },
  }
}

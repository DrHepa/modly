import { appendWorldSceneItem, shouldPendingWorldsSurfacePlacement } from '../worlds/worldsScenePlacement.ts'
import { resolveWorldRenderable } from '../worlds/worldRenderableResolver.ts'
import { parseWorldsSceneManifestText } from '../worlds/worldsSceneManifest.ts'
import { useWorldsSceneStore } from '../worlds/worldsSceneStore.ts'
import { useAppStore } from '../../shared/stores/appStore.ts'
import type { ArtifactKind } from '../../shared/types/artifacts.ts'

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

export async function addWorkflowOutputUrlToWorlds(outputUrl: string, outputKind?: ArtifactKind): Promise<boolean> {
  const workspacePath = resolveWorkflowOutputWorldsWorkspacePath(outputUrl)
  if (!workspacePath) {
    if (outputKind === 'scene') {
      throw new Error('Unable to import workflow scene: output URL must reference a safe workspace path.')
    }
    return false
  }

  const apiUrl = useAppStore.getState().apiUrl
  if (outputKind === 'scene') {
    await replaceWorldsSceneFromWorkflowOutput(workspacePath, apiUrl)
    return true
  }

  const plyKind = await resolveWorkflowOutputPlyKind(workspacePath)
  if (workspacePath.toLowerCase().endsWith('.ply') && !plyKind) return false
  const renderable = resolveWorldRenderable({ workspacePath, apiUrl, ...(plyKind ? { plyKind } : {}) })
  if (!renderable.openable) return false
  const sceneState = useWorldsSceneStore.getState()
  const appended = appendWorldSceneItem(sceneState.sceneItems, renderable.item, {
    sceneItemAnchors: sceneState.sceneItemAnchors,
    selectedSceneItemId: sceneState.selectedSceneItemId,
  })
  useWorldsSceneStore.getState().setScene({
    ...appended,
    collisionSurfaces: sceneState.collisionSurfaces,
    pendingSurfacePlacementItemId: shouldPendingWorldsSurfacePlacement(sceneState.sceneItems, renderable.item)
      ? appended.selectedSceneItemId
      : null,
  })
  return true
}

async function replaceWorldsSceneFromWorkflowOutput(workspacePath: string, apiUrl: string): Promise<void> {
  const configuredApiUrl = apiUrl.trim().replace(/\/+$/, '')
  if (!configuredApiUrl) {
    throw new Error('Unable to fetch workflow scene manifest: Modly API URL is not configured.')
  }

  const encodedWorkspacePath = encodeWorkflowOutputWorldsWorkspacePath(workspacePath)
  const manifestUrl = `${configuredApiUrl}/workspace/${encodedWorkspacePath}`
  let response: Response
  try {
    response = await fetch(manifestUrl)
  } catch (reason: unknown) {
    throw new Error(`Unable to fetch workflow scene manifest "${workspacePath}": ${describeError(reason)}`)
  }

  if (!response.ok) {
    const statusText = response.statusText.trim()
    throw new Error(`Unable to fetch workflow scene manifest "${workspacePath}": HTTP ${response.status}${statusText ? ` ${statusText}` : ''}.`)
  }

  let text: string
  try {
    text = await response.text()
  } catch (reason: unknown) {
    throw new Error(`Unable to read workflow scene manifest "${workspacePath}": ${describeError(reason)}`)
  }

  const parsed = parseWorldsSceneManifestText(text, { apiUrl: configuredApiUrl })
  if (parsed.success !== true) {
    throw new Error(`Unable to parse workflow scene manifest "${workspacePath}": ${parsed.error}`)
  }

  const selectedSceneItemId = parsed.sceneItems.find((item) => item.visible)?.id ?? null
  useWorldsSceneStore.getState().setScene({
    sceneItems: parsed.sceneItems,
    collisionSurfaces: parsed.collisionSurfaces,
    selectedSceneItemId,
    selectedSceneItemIds: selectedSceneItemId ? [selectedSceneItemId] : [],
    selectedCollisionSurfaceId: null,
    pendingSurfacePlacementItemId: null,
    initialView: parsed.manifest.initialView ?? null,
  })
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

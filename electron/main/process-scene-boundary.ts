import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { physicalArtifactPath } from './artifact-registry-service.ts'
import { MAX_SCENE_MANIFEST_BYTES, SCENE_MANIFEST_FILE_NAME } from './bounded-file-reader.ts'
import { validateSceneManifest } from '../../src/areas/workflows/workflowSceneSource.ts'

const MAX_ASSETS = 4096
const MAX_ASSET_BYTES = 16 * 1024 ** 3
const MAX_TOTAL_BYTES = 64 * 1024 ** 3

/** Boundary-time confinement, not an immutable snapshot or an extension sandbox.
 * Mirrors scene_input.py's recognized references and limits. Linux tests do not
 * establish Windows reparse-point parity for the shared physical path helper.
 */
export async function validateProcessScene(workspaceDir: string, scenePath: string): Promise<string> {
  if (typeof scenePath !== 'string' || !scenePath || scenePath !== scenePath.trim()) throw new Error('Scene input requires a path')
  const root = await realpath(workspaceDir)
  const configuredRoot = resolve(workspaceDir)
  let path = scenePath.replace(/\\/g, '/')
  // Keep raw segments until the pure validator has rejected traversal/encoding.
  for (const base of [configuredRoot, root].sort((a, b) => b.length - a.length)) {
    const prefix = base.replace(/\\/g, '/').replace(/\/$/, '') + '/'
    if (path.startsWith(prefix)) { path = path.slice(prefix.length); break }
  }
  const safePath = validateSceneManifest({ schema: 'modly.scene-manifest.v1', sceneRoot: '.', assets: [{ workspacePath: path }] })
  if (!safePath.ok) throw new Error(safePath.error)
  if (basename(path) !== SCENE_MANIFEST_FILE_NAME) {
    if (path.toLowerCase().endsWith('.json')) throw new Error(`Scene input accepts a directory or ${SCENE_MANIFEST_FILE_NAME}`)
    path += '/' + SCENE_MANIFEST_FILE_NAME
  }
  const target = await physicalArtifactPath(workspaceDir, path)
  const file = await open(target.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  let parsed: unknown
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new Error('Scene manifest must be a regular file')
    if (info.size > MAX_SCENE_MANIFEST_BYTES) throw new Error('Scene manifest exceeds the 1 MiB limit')
    const bytes = Buffer.alloc(MAX_SCENE_MANIFEST_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > MAX_SCENE_MANIFEST_BYTES || (await file.stat()).size > MAX_SCENE_MANIFEST_BYTES) throw new Error('Scene manifest exceeds the 1 MiB limit')
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)))
  } finally { await file.close() }

  // Python treats null initialView/up as absent. The renderer's stricter pure
  // validator is reused on a shallow validation copy, without rewriting assets.
  let candidate = parsed
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const value = parsed as Record<string, unknown>
    candidate = { ...value }
    const copy = candidate as Record<string, unknown>
    if (value.initialView === null) delete copy.initialView
    else if (value.initialView && typeof value.initialView === 'object' && !Array.isArray(value.initialView)) {
      const view = value.initialView as Record<string, unknown>
      if (view.up === null) { copy.initialView = { ...view }; delete (copy.initialView as Record<string, unknown>).up }
    }
  }
  const validation = validateSceneManifest(candidate)
  if (!validation.ok) throw new Error(validation.error)
  const { manifest, sceneRoot } = validation
  if (manifest.assets.length > MAX_ASSETS) throw new Error('Scene manifest contains too many asset references')
  const rootRelative = sceneRoot === '.' ? dirname(path) : sceneRoot
  const sceneRootPath = rootRelative === '.' ? root : (await physicalArtifactPath(workspaceDir, rootRelative, 'directory')).absolutePath
  const reference = async (base: string, value: string): Promise<string> => {
    const workspacePath = relative(root, join(base, ...value.replace(/\\/g, '/').split('/'))).split(sep).join('/')
    return (await physicalArtifactPath(root, workspacePath)).absolutePath
  }
  let total = 0
  for (const asset of manifest.assets) {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) continue
    const fields = asset as Record<string, unknown>
    for (const [field, base] of [['workspacePath', root], ['path', sceneRootPath]]) {
      if (!Object.hasOwn(fields, field)) continue
      const size = (await stat(await reference(base, fields[field] as string))).size
      if (size > MAX_ASSET_BYTES) throw new Error('Scene referenced file exceeds the size limit')
      total += size
      if (total > MAX_TOTAL_BYTES) throw new Error('Scene referenced files exceed the total size limit')
    }
  }
  // Canonical Python counts assets, not previews, toward the byte limits.
  for (const field of ['image', 'video'] as const) {
    const value = manifest.preview?.[field]
    if (value !== undefined) await reference(sceneRootPath, value)
  }
  return target.absolutePath
}

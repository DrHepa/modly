import type { CaptureArtifactManifestV1 } from '../../shared/types/artifacts'

export const CAPTURE_MANIFEST_FILE_NAME = 'capture-manifest.json'

type Success = {
  ok: true
  inputWorkspacePath: string
  manifestWorkspacePath: string
  manifestAbsolutePath: string
  captureRoot: string
  kind: 'frames' | 'video'
  manifest: CaptureArtifactManifestV1
}
type Failure = { ok: false; error: string }
export type ResolveCaptureSourceResult = Success | Failure

function absolute(value: string): boolean { return value.startsWith('/') || /^[A-Za-z]:\//.test(value) }
function trimSlash(value: string): string { return value.replace(/\/+$/, '') }
function safeRelative(value: unknown, allowDot = false): value is string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.includes('\u0000')) return false
  const normalized = value.replace(/\\/g, '/')
  if (allowDot && normalized === '.') return true
  if (absolute(normalized) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized)
    || /%(?:25|2e|2f|5c|00)/i.test(normalized) || /%(?![0-9a-f]{2})/i.test(normalized)) return false
  return normalized.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
}
function workspaceRelative(value: string, workspaceDir: string): string | undefined {
  const normalized = value.replace(/\\/g, '/')
  const workspace = trimSlash(workspaceDir.replace(/\\/g, '/'))
  let relative: string | undefined
  if (normalized.startsWith('/workspace/')) relative = normalized.slice('/workspace/'.length)
  else if (normalized.startsWith(`${workspace}/`)) relative = normalized.slice(workspace.length + 1)
  else if (!absolute(normalized)) relative = normalized
  return relative && safeRelative(relative) ? relative : undefined
}
function decode(base64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)))
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function positiveInt(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0
}

function validate(value: unknown): { ok: true; manifest: CaptureArtifactManifestV1 } | Failure {
  if (!object(value) || value.schema !== 'modly.capture-manifest.v1') {
    return { ok: false, error: 'Capture manifest schema must be modly.capture-manifest.v1.' }
  }
  if (!safeRelative(value.captureRoot, true)) return { ok: false, error: 'Capture root must be a safe relative path.' }
  if (!object(value.provenance) || typeof value.provenance.source !== 'string' || !value.provenance.source.trim()
    || (value.provenance.ordering !== 'manifest-index' && value.provenance.ordering !== 'decode-index')) {
    return { ok: false, error: 'Capture provenance requires a source and deterministic ordering.' }
  }
  if (value.kind === 'frames') {
    if (value.provenance.ordering !== 'manifest-index') return { ok: false, error: 'Frame ordering must be manifest-index.' }
    if (!Array.isArray(value.frames) || value.frames.length === 0) return { ok: false, error: 'Frame capture requires ordered frames.' }
    const paths = new Set<string>()
    for (let index = 0; index < value.frames.length; index++) {
      const frame = value.frames[index]
      if (!object(frame) || frame.index !== index || !safeRelative(frame.path)
        || paths.has(frame.path) || !positiveInt(frame.width) || !positiveInt(frame.height) || !positiveInt(frame.byteSize)) {
        return { ok: false, error: 'Capture frames must be contiguous, unique, contained, and dimensioned.' }
      }
      paths.add(frame.path)
    }
    if (value.video !== undefined && value.video !== null) return { ok: false, error: 'Frame capture cannot also declare video.' }
  } else if (value.kind === 'video') {
    if (value.provenance.ordering !== 'decode-index') return { ok: false, error: 'Video ordering must be decode-index.' }
    const video = value.video
    if (!object(video) || !safeRelative(video.path) || !positiveInt(video.width)
      || !positiveInt(video.height) || !positiveInt(video.byteSize) || !positiveInt(video.frameCount)) {
      return { ok: false, error: 'Video capture requires a contained, dimensioned video.' }
    }
    if (value.frames !== undefined && (!Array.isArray(value.frames) || value.frames.length > 0)) {
      return { ok: false, error: 'Video capture cannot also declare frames.' }
    }
  } else return { ok: false, error: 'Capture kind must be frames or video.' }
  return { ok: true, manifest: value as unknown as CaptureArtifactManifestV1 }
}

export async function resolveCaptureSourceManifest(args: {
  capturePath: string
  workspaceDir: string
  readFileBase64: (path: string) => Promise<string>
}): Promise<ResolveCaptureSourceResult> {
  const inputWorkspacePath = workspaceRelative(args.capturePath, args.workspaceDir)
  if (!inputWorkspacePath) return { ok: false, error: 'Load Capture requires a safe workspace-relative path.' }
  const isManifest = inputWorkspacePath === CAPTURE_MANIFEST_FILE_NAME || inputWorkspacePath.endsWith(`/${CAPTURE_MANIFEST_FILE_NAME}`)
  if (!isManifest && inputWorkspacePath.toLowerCase().endsWith('.json')) {
    return { ok: false, error: `Load Capture accepts ${CAPTURE_MANIFEST_FILE_NAME} or a capture directory.` }
  }
  const manifestWorkspacePath = isManifest ? inputWorkspacePath : `${inputWorkspacePath}/${CAPTURE_MANIFEST_FILE_NAME}`
  const workspace = trimSlash(args.workspaceDir.replace(/\\/g, '/'))
  const manifestAbsolutePath = `${workspace}/${manifestWorkspacePath}`
  let parsed: unknown
  try { parsed = JSON.parse(decode(await args.readFileBase64(manifestAbsolutePath))) }
  catch (error) { return { ok: false, error: `Unable to read capture manifest: ${String(error)}` } }
  const checked = validate(parsed)
  if (!checked.ok) return checked
  return {
    ok: true,
    inputWorkspacePath,
    manifestWorkspacePath,
    manifestAbsolutePath,
    captureRoot: checked.manifest.captureRoot,
    kind: checked.manifest.kind,
    manifest: checked.manifest,
  }
}

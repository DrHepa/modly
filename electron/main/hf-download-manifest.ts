export type HfDownloadFile = {
  path: string
  sha256?: string
}

export type HfDownloadDescriptor = {
  repoId: string
  revision: string
  targetSubdir: string
  files: HfDownloadFile[]
}

type RawHfDownloadFile = {
  path?: unknown
  sha256?: unknown
  [key: string]: unknown
}

type RawHfDownloadDescriptor = {
  repo_id?: unknown
  revision?: unknown
  target_subdir?: unknown
  files?: unknown
  [key: string]: unknown
}

const COMMIT_RE = /^[0-9a-f]{40}$/iu
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u
const SHA256_RE = /^[0-9a-f]{64}$/iu
const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

function safeRelativePath(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) {
    throw new Error(`${context} must be a safe relative path`)
  }

  const parts = value.split('/')
  if (
    value.startsWith('/') ||
    parts.some((part) => part.length === 0 || part === '.' || part === '..' || !SAFE_SEGMENT_RE.test(part))
  ) {
    throw new Error(`${context} must be a safe relative path`)
  }

  return parts.join('/')
}

function assertExactFields(value: Record<string, unknown>, expected: ReadonlySet<string>, context: string): void {
  const unknown = Object.keys(value).filter((field) => !expected.has(field))
  if (unknown.length > 0) {
    throw new Error(`${context} has unknown fields: ${unknown.sort().join(', ')}`)
  }
}

export function normalizeHfDownloads(value: unknown, context = 'hf_downloads'): HfDownloadDescriptor[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must be a non-empty array`)
  }

  const destinations = new Set<string>()

  return value.map((candidate, repoIndex) => {
    const repoContext = `${context}[${repoIndex}]`
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`${repoContext} must be an object`)
    }

    const raw = candidate as RawHfDownloadDescriptor
    assertExactFields(raw, new Set(['repo_id', 'revision', 'target_subdir', 'files']), repoContext)

    if (typeof raw.repo_id !== 'string' || !REPO_RE.test(raw.repo_id)) {
      throw new Error(`${repoContext}.repo_id must be a Hugging Face owner/repository ID`)
    }
    if (typeof raw.revision !== 'string' || !COMMIT_RE.test(raw.revision)) {
      throw new Error(`${repoContext}.revision must be a pinned 40-character commit SHA`)
    }

    const targetSubdir = safeRelativePath(raw.target_subdir, `${repoContext}.target_subdir`)
    if (!Array.isArray(raw.files) || raw.files.length === 0) {
      throw new Error(`${repoContext}.files must be a non-empty array`)
    }

    const repoPaths = new Set<string>()
    const files = raw.files.map((candidateFile, fileIndex) => {
      const fileContext = `${repoContext}.files[${fileIndex}]`
      if (!candidateFile || typeof candidateFile !== 'object' || Array.isArray(candidateFile)) {
        throw new Error(`${fileContext} must be an object`)
      }

      const rawFile = candidateFile as RawHfDownloadFile
      assertExactFields(rawFile, new Set(['path', 'sha256']), fileContext)
      const path = safeRelativePath(rawFile.path, `${fileContext}.path`)

      if (repoPaths.has(path)) {
        throw new Error(`${repoContext} contains duplicate file path: ${path}`)
      }
      repoPaths.add(path)

      const destination = `${targetSubdir}/${path}`
      if (destinations.has(destination)) {
        throw new Error(`${context} contains duplicate destination: ${destination}`)
      }
      destinations.add(destination)

      if (rawFile.sha256 !== undefined && (
        typeof rawFile.sha256 !== 'string' || !SHA256_RE.test(rawFile.sha256)
      )) {
        throw new Error(`${fileContext}.sha256 must be a 64-character SHA-256 digest`)
      }

      return {
        path,
        ...(typeof rawFile.sha256 === 'string' ? { sha256: rawFile.sha256.toLowerCase() } : {}),
      }
    })

    return {
      repoId: raw.repo_id,
      revision: raw.revision.toLowerCase(),
      targetSubdir,
      files,
    }
  })
}

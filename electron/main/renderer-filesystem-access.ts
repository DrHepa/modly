import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface RendererFilesystemConfiguredRoots {
  modelsDir: string
  workspaceDir: string
  workflowsDir: string
  extensionsDir: string
}

export interface RendererFilesystemAccessOptions {
  getConfiguredRoots: () => RendererFilesystemConfiguredRoots
  getProtectedRoots: () => {
    userDataDir: string
    agentPrivateTempDir: string
    agentRuntimeSnapshotDir: string
    agentWorkspaceStagingDir: string
  }
}

export class RendererFilesystemAccessError extends Error {
  constructor() {
    super('Path is outside the renderer filesystem capability')
    this.name = 'RendererFilesystemAccessError'
  }
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

async function canonicalDirectory(value: unknown): Promise<string> {
  if (typeof value !== 'string' || value.trim() !== value || !isAbsolute(value)) {
    throw new RendererFilesystemAccessError()
  }
  const absolute = resolve(value)
  try {
    const info = await lstat(absolute)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new RendererFilesystemAccessError()
    const canonical = await realpath(absolute)
    if (canonical !== absolute) throw new RendererFilesystemAccessError()
    return canonical
  } catch (error) {
    if (error instanceof RendererFilesystemAccessError) throw error
    throw new RendererFilesystemAccessError()
  }
}

export class RendererFilesystemAccess {
  readonly #options: RendererFilesystemAccessOptions
  readonly #selectedRoots = new Set<string>()

  constructor(options: RendererFilesystemAccessOptions) {
    this.#options = options
  }

  async #roots(): Promise<RendererFilesystemConfiguredRoots> {
    const roots = this.#options.getConfiguredRoots()
    return {
      modelsDir: await canonicalDirectory(roots.modelsDir),
      workspaceDir: await canonicalDirectory(roots.workspaceDir),
      workflowsDir: await canonicalDirectory(roots.workflowsDir),
      extensionsDir: await canonicalDirectory(roots.extensionsDir),
    }
  }

  async #assertNotProtected(
    candidate: string,
    configured: readonly string[],
    rejectProtectedAncestor = false,
  ): Promise<void> {
    const rawProtected = this.#options.getProtectedRoots()
    const protectedRoot = async (value: string): Promise<string> => {
      try { return await realpath(resolve(value)) } catch { return resolve(value) }
    }
    const agentPrivateTempDir = await protectedRoot(rawProtected.agentPrivateTempDir)
    if (isWithin(agentPrivateTempDir, candidate)
      || (rejectProtectedAncestor && isWithin(candidate, agentPrivateTempDir))) {
      throw new RendererFilesystemAccessError()
    }
    const agentRuntimeSnapshotDir = await protectedRoot(rawProtected.agentRuntimeSnapshotDir)
    if (isWithin(agentRuntimeSnapshotDir, candidate) || isWithin(candidate, agentRuntimeSnapshotDir)) {
      throw new RendererFilesystemAccessError()
    }
    const agentWorkspaceStagingDir = await protectedRoot(rawProtected.agentWorkspaceStagingDir)
    if (isWithin(agentWorkspaceStagingDir, candidate)
      || (rejectProtectedAncestor && isWithin(candidate, agentWorkspaceStagingDir))) {
      throw new RendererFilesystemAccessError()
    }
    const userDataDir = await protectedRoot(rawProtected.userDataDir)
    if (isWithin(userDataDir, candidate) && !configured.some((root) => isWithin(root, candidate))) {
      throw new RendererFilesystemAccessError()
    }
  }

  async grantSelectedDirectory(value: unknown): Promise<string> {
    const candidate = await canonicalDirectory(value)
    const roots = await this.#roots()
    const configured = Object.values(roots)
    await this.#assertNotProtected(candidate, configured)
    this.#selectedRoots.add(candidate)
    return candidate
  }

  async resolveListDirectory(value: unknown): Promise<string> {
    const candidate = await canonicalDirectory(value)
    const roots = await this.#roots()
    const configured = Object.values(roots)
    await this.#assertNotProtected(candidate, configured)
    if (!configured.includes(candidate) && !this.#selectedRoots.has(candidate)) {
      throw new RendererFilesystemAccessError()
    }
    return candidate
  }

  async resolveListFiles(value: unknown): Promise<string> {
    const candidate = await canonicalDirectory(value)
    const roots = await this.#roots()
    const configured = Object.values(roots)
    await this.#assertNotProtected(candidate, configured)
    if (!configured.some((root) => isWithin(root, candidate))
      && ![...this.#selectedRoots].some((root) => isWithin(root, candidate))) {
      throw new RendererFilesystemAccessError()
    }
    return candidate
  }

  async resolveMoveDirectory(value: unknown): Promise<{ src: string, dest: string }> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RendererFilesystemAccessError()
    const raw = value as Record<string, unknown>
    if (Reflect.ownKeys(raw).length !== 2 || !Object.hasOwn(raw, 'src') || !Object.hasOwn(raw, 'dest')) {
      throw new RendererFilesystemAccessError()
    }
    const src = await canonicalDirectory(raw.src)
    const dest = await canonicalDirectory(raw.dest)
    const roots = await this.#roots()
    const mutableRoots = [roots.modelsDir, roots.workspaceDir, roots.workflowsDir]
    await this.#assertNotProtected(src, mutableRoots, true)
    await this.#assertNotProtected(dest, mutableRoots, true)
    if (!mutableRoots.includes(src) || !this.#selectedRoots.has(dest)
      || isWithin(src, dest) || isWithin(dest, src)) {
      throw new RendererFilesystemAccessError()
    }
    return { src, dest }
  }

  async resolveDeleteDirectory(value: unknown): Promise<string> {
    const candidate = await canonicalDirectory(value)
    const roots = await this.#roots()
    const mutableRoots = [roots.modelsDir, roots.workspaceDir, roots.workflowsDir]
    await this.#assertNotProtected(candidate, mutableRoots, true)
    if (!mutableRoots.includes(candidate) && candidate !== join(roots.workspaceDir, 'tmp')) {
      throw new RendererFilesystemAccessError()
    }
    return candidate
  }
}

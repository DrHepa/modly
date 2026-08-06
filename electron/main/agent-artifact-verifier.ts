import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type { ArtifactKind } from '../../src/shared/types/artifacts.ts'
import type { ArtifactRefV1 } from '../../src/shared/types/agentActions.ts'
import { assertArtifactRefV1 } from './agent-trust-contracts.ts'

export type AgentArtifactVerificationErrorCode =
  | 'artifact_missing'
  | 'artifact_symlink'
  | 'artifact_mismatch'
  | 'artifact_unsafe'
  | 'verification_aborted'

export class AgentArtifactVerificationError extends Error {
  readonly code: AgentArtifactVerificationErrorCode

  constructor(code: AgentArtifactVerificationErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause })
    this.name = 'AgentArtifactVerificationError'
    this.code = code
  }
}

export interface AgentArtifactVerifier {
  verify(candidate: ArtifactRefV1, expectedKind: ArtifactKind, signal: AbortSignal): Promise<ArtifactRefV1>
}

export interface WorkspaceAgentArtifactVerifierOptions {
  getWorkspaceRoot: () => string | Promise<string>
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AgentArtifactVerificationError('verification_aborted')
}

function isOutsideRoot(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(path)
}

function isMissingError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error
    && ((error as { code?: unknown }).code === 'ENOENT' || (error as { code?: unknown }).code === 'ENOTDIR'))
}

function statIdentityMatches(
  left: { dev: number | bigint, ino: number | bigint, size: number | bigint, mtimeMs: number },
  right: { dev: number | bigint, ino: number | bigint, size: number | bigint, mtimeMs: number },
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
}

export class WorkspaceAgentArtifactVerifier implements AgentArtifactVerifier {
  private readonly getWorkspaceRoot: () => string | Promise<string>

  constructor(options: WorkspaceAgentArtifactVerifierOptions) {
    this.getWorkspaceRoot = options.getWorkspaceRoot
  }

  async verify(candidateValue: ArtifactRefV1, expectedKind: ArtifactKind, signal: AbortSignal): Promise<ArtifactRefV1> {
    throwIfAborted(signal)
    let candidate: ArtifactRefV1
    try {
      candidate = assertArtifactRefV1(candidateValue)
    } catch (error) {
      throw new AgentArtifactVerificationError('artifact_unsafe', error)
    }
    if (candidate.kind !== expectedKind) throw new AgentArtifactVerificationError('artifact_mismatch')

    let canonicalRoot: string
    try {
      const configuredRoot = await this.getWorkspaceRoot()
      if (typeof configuredRoot !== 'string' || configuredRoot.length === 0 || !isAbsolute(configuredRoot)) {
        throw new AgentArtifactVerificationError('artifact_unsafe')
      }
      canonicalRoot = await realpath(configuredRoot)
      const rootStat = await lstat(canonicalRoot)
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new AgentArtifactVerificationError('artifact_unsafe')
    } catch (error) {
      if (error instanceof AgentArtifactVerificationError) throw error
      throw new AgentArtifactVerificationError(isMissingError(error) ? 'artifact_missing' : 'artifact_unsafe', error)
    }
    throwIfAborted(signal)

    const segments = candidate.workspacePath.split('/')
    const targetPath = resolve(canonicalRoot, ...segments)
    if (isOutsideRoot(canonicalRoot, targetPath)) throw new AgentArtifactVerificationError('artifact_unsafe')

    let cursor = canonicalRoot
    try {
      for (const [index, segment] of segments.entries()) {
        throwIfAborted(signal)
        cursor = join(cursor, segment)
        const info = await lstat(cursor)
        if (info.isSymbolicLink()) throw new AgentArtifactVerificationError('artifact_symlink')
        if (index < segments.length - 1 && !info.isDirectory()) throw new AgentArtifactVerificationError('artifact_unsafe')
        if (index === segments.length - 1 && !info.isFile()) throw new AgentArtifactVerificationError('artifact_unsafe')
      }
      const canonicalTarget = await realpath(targetPath)
      if (canonicalTarget !== targetPath || isOutsideRoot(canonicalRoot, canonicalTarget)) {
        throw new AgentArtifactVerificationError('artifact_symlink')
      }
    } catch (error) {
      if (error instanceof AgentArtifactVerificationError) throw error
      throw new AgentArtifactVerificationError(isMissingError(error) ? 'artifact_missing' : 'artifact_unsafe', error)
    }

    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
    let handle
    try {
      handle = await open(targetPath, constants.O_RDONLY | noFollow)
      const before = await handle.stat()
      if (!before.isFile()) throw new AgentArtifactVerificationError('artifact_unsafe')
      const digest = createHash('sha256')
      const stream = handle.createReadStream({ autoClose: false })
      for await (const chunk of stream) {
        throwIfAborted(signal)
        digest.update(chunk)
      }
      const after = await handle.stat()
      if (!statIdentityMatches(before, after)) throw new AgentArtifactVerificationError('artifact_mismatch')
      const sha256 = digest.digest('hex')
      const sizeBytes = Number(after.size)
      if (!Number.isSafeInteger(sizeBytes)
        || sizeBytes !== candidate.sizeBytes
        || sha256 !== candidate.sha256) {
        throw new AgentArtifactVerificationError('artifact_mismatch')
      }
      return { ...candidate, sha256, sizeBytes }
    } catch (error) {
      if (error instanceof AgentArtifactVerificationError) throw error
      throw new AgentArtifactVerificationError(isMissingError(error) ? 'artifact_missing' : 'artifact_unsafe', error)
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }
}

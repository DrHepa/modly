import { parseWorldCommandBatch } from '../../src/areas/worlds/core/worldCommands.ts'
import { isWorldCanonicalId } from '../../src/areas/worlds/core/worldValidationLimits.ts'
import { parseWorldAiContext, parseWorldAiProposal, WorldAiContractError } from '../../src/areas/worlds/core/worldAiContract.ts'
import type { WorldProjectAiPreviewRequest, WorldProjectAiPreviewResult, WorldProjectAiDiscardRequest, WorldProjectResult } from '../../src/shared/types/worldProjects.ts'
import {
  WORLD_PROJECT_CHANNELS,
  isWorldProjectKey,
  type WorldProjectCommandRequest,
  type WorldProjectCommandResult,
  type WorldProjectCreateRequest,
  type WorldProjectCreateResult,
  type WorldProjectDeleteRequest,
  type WorldProjectDeleteResult,
  type WorldProjectKeyRequest,
  type WorldProjectListResult,
  type WorldProjectOpenResult,
} from '../../src/shared/types/worldProjects.ts'

type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown

export interface WorldProjectsIpcMainLike {
  handle(channel: string, handler: InvokeHandler): void
}

export interface WorldProjectsRepositoryLike {
  previewAi?(request: WorldProjectAiPreviewRequest): Promise<WorldProjectAiPreviewResult>
  discardAi?(request: WorldProjectAiDiscardRequest): Promise<WorldProjectResult<{ discarded: true }>>
  create(request: WorldProjectCreateRequest): Promise<WorldProjectCreateResult>
  list(): Promise<WorldProjectListResult>
  open(request: WorldProjectKeyRequest): Promise<WorldProjectOpenResult>
  previewCommands(request: WorldProjectCommandRequest): Promise<WorldProjectCommandResult>
  applyCommands(request: WorldProjectCommandRequest): Promise<WorldProjectCommandResult>
  delete(request: WorldProjectDeleteRequest): Promise<WorldProjectDeleteResult>
}

export interface WorldProjectsIpcOptions {
  isTrustedSender(event: unknown): boolean
}

class IpcRequestError extends Error {}

export function registerWorldProjectsIpcHandlers(
  ipcMain: WorldProjectsIpcMainLike,
  repository: WorldProjectsRepositoryLike,
  options: WorldProjectsIpcOptions,
): void {
  const register = <T>(
    channel: string,
    argumentCount: number,
    parse: (value: unknown) => T,
    operation: (request: T) => Promise<unknown>,
  ): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!options.isTrustedSender(event)) return unauthorized()
      if (args.length !== argumentCount) return invalidRequest()
      try {
        const request = parse(args[0])
        return await operation(request)
      } catch (error) {
        return error instanceof IpcRequestError || error instanceof WorldAiContractError ? invalidRequest() : internalError()
      }
    })
  }

  register(WORLD_PROJECT_CHANNELS.create, 1, createRequest, (request) => repository.create(request))
  register(WORLD_PROJECT_CHANNELS.list, 0, () => undefined, () => repository.list())
  register(WORLD_PROJECT_CHANNELS.open, 1, keyRequest, (request) => repository.open(request))
  register(WORLD_PROJECT_CHANNELS.previewCommands, 1, commandRequest, (request) => repository.previewCommands(request))
  register(WORLD_PROJECT_CHANNELS.applyCommands, 1, commandRequest, (request) => repository.applyCommands(request))
  register(WORLD_PROJECT_CHANNELS.previewAi, 1, (value) => {
    const record = exactRecord(value, ['proposal'])
    return { proposal: parseWorldAiProposal(record.proposal) }
  }, (request) => repository.previewAi ? repository.previewAi(request) : Promise.resolve(invalidRequest()))
  register(WORLD_PROJECT_CHANNELS.discardAi, 1, (value) => {
    const record = exactRecord(value, ['context', 'authority'])
    if (typeof record.authority !== 'string' || !/^apply_[a-f0-9]{48}$/.test(record.authority)) throw new IpcRequestError()
    return { context: parseWorldAiContext(record.context), authority: record.authority }
  }, (request) => repository.discardAi ? repository.discardAi(request) : Promise.resolve(invalidRequest()))
  register(WORLD_PROJECT_CHANNELS.delete, 1, deleteRequest, (request) => repository.delete(request))
}

function createRequest(value: unknown): WorldProjectCreateRequest {
  const record = exactRecord(value, ['name', 'initialSceneName', 'projectId', 'initialSceneId'])
  const name = nameValue(record.name)
  const initialSceneName = nameValue(record.initialSceneName)
  if (!name || !initialSceneName) throw new IpcRequestError()
  if (record.projectId !== undefined && !isWorldCanonicalId(record.projectId)) throw new IpcRequestError()
  if (record.initialSceneId !== undefined && !isWorldCanonicalId(record.initialSceneId)) throw new IpcRequestError()
  return {
    name,
    initialSceneName,
    ...(record.projectId !== undefined ? { projectId: record.projectId as string } : {}),
    ...(record.initialSceneId !== undefined ? { initialSceneId: record.initialSceneId as string } : {}),
  }
}

function keyRequest(value: unknown): WorldProjectKeyRequest {
  const record = exactRecord(value, ['projectKey'])
  if (!isWorldProjectKey(record.projectKey)) throw new IpcRequestError()
  return { projectKey: record.projectKey }
}

function commandRequest(value: unknown): WorldProjectCommandRequest {
  const record = exactRecord(value, ['projectKey', 'batch', 'aiAuthority'])
  const key = keyRequest({ projectKey: record.projectKey })
  const batch = parseWorldCommandBatch(record.batch)
  if (!batch.success) throw new IpcRequestError()
  let aiAuthority: WorldProjectCommandRequest['aiAuthority']
  if (Object.hasOwn(record, 'aiAuthority')) {
    const authority = exactRecord(record.aiAuthority, ['token', 'context'])
    if (typeof authority.token !== 'string' || !/^apply_[a-f0-9]{48}$/.test(authority.token)) throw new IpcRequestError()
    aiAuthority = { token: authority.token, context: parseWorldAiContext(authority.context) }
  }
  return { ...key, batch: batch.value, ...(aiAuthority ? { aiAuthority } : {}) }
}

function deleteRequest(value: unknown): WorldProjectDeleteRequest {
  const record = exactRecord(value, ['projectKey', 'expectedRevision', 'transactionId'])
  const key = keyRequest({ projectKey: record.projectKey })
  if (
    typeof record.expectedRevision !== 'number' || !Number.isSafeInteger(record.expectedRevision)
    || record.expectedRevision < 0 || !isWorldCanonicalId(record.transactionId)
  ) throw new IpcRequestError()
  return { ...key, expectedRevision: record.expectedRevision, transactionId: record.transactionId }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new IpcRequestError()
  const allowed = new Set(keys)
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.has(key))) throw new IpcRequestError()
  return value
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function nameValue(value: unknown): string | null {
  return typeof value === 'string' && value === value.trim() && value.length > 0
    && value.length <= 512 && !value.includes('\0') ? value : null
}

function invalidRequest() {
  return { ok: false, error: { code: 'invalid_request', message: 'World project request is invalid.', retryable: false } } as const
}

function unauthorized() {
  return { ok: false, error: { code: 'unauthorized', message: 'World project request is unauthorized.', retryable: false } } as const
}

function internalError() {
  return { ok: false, error: { code: 'internal_error', message: 'World project operation failed.', retryable: true } } as const
}

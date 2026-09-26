import {
  WORLD_RENDER_CHANNELS,
  parseWorldRenderCancelRequest,
  parseWorldRenderCreateRequest,
  parseWorldRenderDeleteRequest,
  parseWorldRenderJobKeyRequest,
  type WorldRenderCancelRequest,
  type WorldRenderCreateRequest,
  type WorldRenderDeleteRequest,
  type WorldRenderJobKeyRequest,
  type WorldRendersApi,
} from '../../src/shared/types/worldRenders.ts'

type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown

export interface WorldRendersIpcMainLike {
  handle(channel: string, handler: InvokeHandler): void
}

export interface WorldRendersIpcOptions {
  isTrustedSender(event: unknown): boolean
}

class IpcRequestError extends Error {}

export function registerWorldRendersIpcHandlers(
  ipcMain: WorldRendersIpcMainLike,
  service: WorldRendersApi,
  options: WorldRendersIpcOptions,
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
      try { return await operation(parse(args[0])) }
      catch (error) { return error instanceof IpcRequestError ? invalidRequest() : internalError() }
    })
  }

  register(WORLD_RENDER_CHANNELS.create, 1, createRequest, (request) => service.create(request))
  register(WORLD_RENDER_CHANNELS.list, 0, () => undefined, () => service.list())
  register(WORLD_RENDER_CHANNELS.get, 1, jobRequest, (request) => service.get(request))
  register(WORLD_RENDER_CHANNELS.cancel, 1, cancelRequest, (request) => service.cancel(request))
  register(WORLD_RENDER_CHANNELS.delete, 1, deleteRequest, (request) => service.delete(request))
}

function createRequest(value: unknown): WorldRenderCreateRequest {
  const parsed = parseWorldRenderCreateRequest(value)
  if (!parsed.success) throw new IpcRequestError()
  return parsed.value
}

function jobRequest(value: unknown): WorldRenderJobKeyRequest {
  const parsed = parseWorldRenderJobKeyRequest(value)
  if (!parsed.success) throw new IpcRequestError()
  return parsed.value
}

function cancelRequest(value: unknown): WorldRenderCancelRequest {
  const parsed = parseWorldRenderCancelRequest(value)
  if (!parsed.success) throw new IpcRequestError()
  return parsed.value
}

function deleteRequest(value: unknown): WorldRenderDeleteRequest {
  const parsed = parseWorldRenderDeleteRequest(value)
  if (!parsed.success) throw new IpcRequestError()
  return parsed.value
}

function invalidRequest() {
  return { ok: false, error: { code: 'invalid_request', message: 'World render request is invalid.', retryable: false } } as const
}

function unauthorized() {
  return { ok: false, error: { code: 'unauthorized', message: 'World render request is unauthorized.', retryable: false } } as const
}

function internalError() {
  return { ok: false, error: { code: 'internal_error', message: 'World render operation failed.', retryable: true } } as const
}

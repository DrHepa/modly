import {
  WORLD_RENDER_HOST_CONNECT_CHANNEL,
  WORLD_RENDER_HOST_DEFAULT_TIMEOUT_MS,
  WORLD_RENDER_HOST_MAX_RESOURCE_REQUESTS,
  WORLD_RENDER_HOST_PROTOCOL,
  parseWorldRenderHostCommand,
  parseWorldRenderHostResourcePortResult,
  peekWorldRenderHostMessageIdentity,
  type WorldRenderHostCommand,
  type WorldRenderHostResourcePortRequest,
  type WorldRenderHostResourceRequest,
  type WorldRenderHostResourceResult,
  type WorldRenderHostResponse,
} from '../../../shared/types/worldRenderHost.ts'
import {
  WORLD_WEBM_PROTOCOL,
  parseWorldWebmMainCommand,
  parseWorldWebmMainResponse,
  parseWorldWebmWorkerMessage,
  peekWorldWebmMessageIdentity,
  type WorldWebmMainCommand,
  type WorldWebmMainResponse,
  type WorldWebmFailureCode,
  type WorldWebmWorkerEvent,
} from './worldWebmProtocol.ts'
import {
  OfflineWorldRenderScene,
  WorldRenderGpuContextError,
} from './worldRenderScene.ts'

type RendererState = 'booting' | 'initializing' | 'ready' | 'rendering-frame' | 'rendering-audio' | 'disposing' | 'disposed' | 'failed'

let renderer: OfflineWorldRenderScene | null = null
let state: RendererState = 'booting'
let identity: { jobId: string; generation: string } | null = null
let port: MessagePort | null = null
let lastRequestId = 0
let resourceRequestId = 0
let queue = Promise.resolve()
let activeCommand: WorldRenderHostCommand | null = null
let terminalRendererError: Error | null = null
let lastRespondedRequestId = 0
let webmWorker: Worker | null = null
let webmStart: Extract<WorldWebmMainCommand, { kind: 'start' }> | null = null
const resourcePending = new Map<number, {
  resolve: (result: WorldRenderHostResourceResult) => void
  reject: (error: Error) => void
  cleanup: () => void
}>()
const resourceAbortController = new AbortController()

window.addEventListener('message', (event) => {
  if (event.source !== window || port || event.ports.length !== 1 || !isConnectMessage(event.data)) return
  identity = { jobId: event.data.bootstrap.jobId, generation: event.data.bootstrap.generation }
  port = event.ports[0]
  port.onmessage = ({ data }) => receivePortMessage(data)
  port.onmessageerror = () => failProtocol('World render port received an undecodable message.')
  port.start()
})

function receivePortMessage(value: unknown): void {
  if (isWorldWebmProtocolMessage(value)) {
    receiveWorldWebmMessage(value)
    return
  }
  const messageIdentity = peekWorldRenderHostMessageIdentity(value)
  if (messageIdentity && identity
    && (messageIdentity.jobId !== identity.jobId || messageIdentity.generation !== identity.generation)) return
  const resource = parseWorldRenderHostResourcePortResult(value)
  if (resource) {
    if (!identity || resource.jobId !== identity.jobId || resource.generation !== identity.generation) return
    const pending = resourcePending.get(resource.requestId)
    if (!pending) return
    resourcePending.delete(resource.requestId)
    pending.cleanup()
    pending.resolve(resource.result)
    return
  }
  const command = parseWorldRenderHostCommand(value)
  if (!command) {
    failProtocol('World render port received an invalid message.')
    return
  }
  queue = queue.then(() => handle(command)).catch(() => undefined)
}

function receiveWorldWebmMessage(value: unknown): void {
  const messageIdentity = peekWorldWebmMessageIdentity(value)
  if (!messageIdentity || !identity || messageIdentity.jobId !== identity.jobId
    || messageIdentity.generation !== identity.generation) return
  const command = parseWorldWebmMainCommand(value)
  if (command) {
    if (command.kind === 'abort') {
      abortWorldWebm(command)
      return
    }
    startWorldWebm(command)
    return
  }
  const response = parseWorldWebmMainResponse(value)
  if (response) {
    forwardWorldWebmResponse(response)
    return
  }
  failWorldWebm('protocol-failed', 'World WebM main process sent an invalid message.')
}

function startWorldWebm(command: Extract<WorldWebmMainCommand, { kind: 'start' }>): void {
  if (!port || !identity || state !== 'ready' || webmWorker || webmStart) {
    postWorldWebmFailure(command, 'internal-failed', 'World WebM Worker cannot start in the current renderer state.')
    return
  }
  webmStart = command
  try {
    const worker = new Worker(new URL('./worldWebm.worker.ts', import.meta.url), { type: 'module', name: 'worlds-webm' })
    webmWorker = worker
    worker.onmessage = ({ data }) => receiveWorldWebmWorkerMessage(worker, data)
    worker.onmessageerror = () => failWorldWebm('protocol-failed', 'World WebM Worker returned an undecodable message.')
    worker.onerror = () => failWorldWebm('worker-crashed', 'World WebM Worker crashed.')
    worker.postMessage(command)
  } catch (error) {
    failWorldWebm('worker-crashed', boundedMessage(error))
  }
}

function abortWorldWebm(command: Extract<WorldWebmMainCommand, { kind: 'abort' }>): void {
  const worker = webmWorker
  if (!worker || !webmStart || command.requestId <= webmStart.requestId) return
  try { worker.postMessage(command) } catch { /* termination below is authoritative */ }
  terminateWorldWebmWorker()
}

function forwardWorldWebmResponse(response: WorldWebmMainResponse): void {
  const worker = webmWorker
  if (!worker || !webmStart) return
  try {
    if (response.ok && (response.requestKind === 'read-frame' || response.requestKind === 'read-audio')
      && 'bytes' in response.payload && response.payload.bytes instanceof ArrayBuffer) {
      worker.postMessage(response, [response.payload.bytes])
    } else {
      worker.postMessage(response)
    }
  } catch (error) {
    failWorldWebm('protocol-failed', boundedMessage(error))
  }
}

function receiveWorldWebmWorkerMessage(worker: Worker, value: unknown): void {
  if (worker !== webmWorker || !webmStart || !port || !identity) return
  const messageIdentity = peekWorldWebmMessageIdentity(value)
  if (!messageIdentity || messageIdentity.jobId !== identity.jobId || messageIdentity.generation !== identity.generation) return
  const message = parseWorldWebmWorkerMessage(value)
  if (!message) {
    failWorldWebm('protocol-failed', 'World WebM Worker returned an invalid message.')
    return
  }
  try { port.postMessage(message) }
  catch (error) {
    failWorldWebm('protocol-failed', boundedMessage(error))
    return
  }
  if (message.kind === 'complete' || message.kind === 'error') terminateWorldWebmWorker()
}

function failWorldWebm(
  code: WorldWebmFailureCode,
  message: string,
): void {
  const start = webmStart
  if (start) postWorldWebmFailure(start, code, message)
  terminateWorldWebmWorker()
}

function postWorldWebmFailure(
  start: Extract<WorldWebmMainCommand, { kind: 'start' }>,
  code: WorldWebmFailureCode,
  message: string,
): void {
  if (!port) return
  const event: Extract<WorldWebmWorkerEvent, { kind: 'error' }> = {
    protocol: WORLD_WEBM_PROTOCOL,
    jobId: start.jobId,
    generation: start.generation,
    requestId: start.requestId,
    kind: 'error',
    payload: { code, message: boundedMessage(message) },
  }
  try { port.postMessage(event) } catch { /* main channel close is authoritative */ }
}

function terminateWorldWebmWorker(): void {
  const worker = webmWorker
  webmWorker = null
  webmStart = null
  if (!worker) return
  worker.onmessage = null
  worker.onmessageerror = null
  worker.onerror = null
  worker.terminate()
}

async function handle(command: WorldRenderHostCommand): Promise<void> {
  if (!identity || command.jobId !== identity.jobId || command.generation !== identity.generation) return
  if (command.requestId <= lastRequestId) return
  lastRequestId = command.requestId
  activeCommand = command
  try {
    if (terminalRendererError) throw terminalRendererError
    if (command.kind === 'initialize') {
      if (state !== 'booting') throw new Error('Renderer has already been initialized.')
      state = 'initializing'
      renderer = new OfflineWorldRenderScene(command.payload, readResource, handleRendererFatal)
      await renderer.initialize()
      if (terminalRendererError) throw terminalRendererError
      state = 'ready'
      respond(command, {})
      return
    }
    if (command.kind === 'render-frame') {
      if (state !== 'ready' || !renderer) throw new Error('Renderer is not ready for a frame.')
      state = 'rendering-frame'
      const result = await renderer.renderFrame(command.payload)
      if (terminalRendererError) throw terminalRendererError
      state = 'ready'
      respond(command, result)
      return
    }
    if (command.kind === 'render-audio') {
      if (state !== 'ready' || !renderer) throw new Error('Renderer is not ready for audio.')
      state = 'rendering-audio'
      const result = await renderer.renderAudio()
      if (terminalRendererError) throw terminalRendererError
      state = 'ready'
      respond(command, result)
      return
    }
    if (state === 'disposed') return
    state = 'disposing'
    terminateWorldWebmWorker()
    resourceAbortController.abort()
    renderer?.dispose()
    renderer = null
    state = 'disposed'
    respond(command, {})
  } catch (error) {
    state = 'failed'
    renderer?.dispose()
    renderer = null
    respondFailure(command, error)
  } finally {
    if (activeCommand === command) activeCommand = null
  }
}

function readResource(request: WorldRenderHostResourceRequest): Promise<WorldRenderHostResourceResult> {
  if (!port || !identity) return Promise.reject(new Error('World render resource port is unavailable.'))
  if (resourceAbortController.signal.aborted) return Promise.reject(abortError('Pinned resource request was cancelled.'))
  if (resourceRequestId >= WORLD_RENDER_HOST_MAX_RESOURCE_REQUESTS) {
    return Promise.reject(new Error('Pinned resource request limit was exceeded.'))
  }
  const requestId = ++resourceRequestId
  const message: WorldRenderHostResourcePortRequest = {
    ...request,
    protocol: WORLD_RENDER_HOST_PROTOCOL,
    jobId: identity.jobId,
    generation: identity.generation,
    kind: 'resource-request',
    requestId,
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const controller = new AbortController()
    const onLifetimeAbort = (): void => controller.abort()
    const cleanup = (): void => {
      clearTimeout(timeout)
      resourceAbortController.signal.removeEventListener('abort', onLifetimeAbort)
      controller.signal.removeEventListener('abort', onAbort)
    }
    const timeout = setTimeout(() => controller.abort(), WORLD_RENDER_HOST_DEFAULT_TIMEOUT_MS)
    const onAbort = (): void => {
      if (!resourcePending.delete(requestId)) return
      cleanup()
      rejectPromise(abortError('Pinned resource request was cancelled.'))
    }
    resourceAbortController.signal.addEventListener('abort', onLifetimeAbort, { once: true })
    controller.signal.addEventListener('abort', onAbort, { once: true })
    resourcePending.set(requestId, { resolve: resolvePromise, reject: rejectPromise, cleanup })
    try { port!.postMessage(message) }
    catch (error) {
      resourcePending.delete(requestId)
      cleanup()
      rejectPromise(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function respond(command: WorldRenderHostCommand, payload: object): void {
  if (!port || command.requestId <= lastRespondedRequestId) return
  lastRespondedRequestId = command.requestId
  const response = {
    protocol: WORLD_RENDER_HOST_PROTOCOL,
    jobId: command.jobId,
    generation: command.generation,
    requestId: command.requestId,
    kind: command.kind,
    ok: true,
    payload,
  } as WorldRenderHostResponse
  // Electron 44 delivers `null` to MessagePortMain when a DOM ArrayBuffer is
  // listed as transferable. The direct job port preserves the ArrayBuffer via
  // structured clone and, unlike the retired bridge, never clones it through
  // contextBridge.
  port.postMessage(response)
}

function respondFailure(command: WorldRenderHostCommand, error: unknown): void {
  if (!port || command.requestId <= lastRespondedRequestId) return
  lastRespondedRequestId = command.requestId
  port.postMessage({
    protocol: WORLD_RENDER_HOST_PROTOCOL,
    jobId: command.jobId,
    generation: command.generation,
    requestId: command.requestId,
    kind: command.kind,
    ok: false,
    error: {
      code: error instanceof WorldRenderGpuContextError || (error instanceof Error && error.name === 'WorldRenderGpuContextError')
        ? 'gpu-context-lost'
        : command.kind === 'render-audio' ? 'audio-failed'
        : command.kind === 'render-frame' ? 'render-failed'
          : 'unsupported-resource',
      message: boundedMessage(error),
    },
  } satisfies WorldRenderHostResponse)
}

function handleRendererFatal(error: WorldRenderGpuContextError): void {
  terminalRendererError ??= error
  state = 'failed'
  resourceAbortController.abort()
  terminateWorldWebmWorker()
  renderer?.dispose()
  renderer = null
  if (activeCommand) respondFailure(activeCommand, terminalRendererError)
}

function failProtocol(message: string): void {
  if (state === 'failed' || state === 'disposed') return
  state = 'failed'
  resourceAbortController.abort()
  terminateWorldWebmWorker()
  renderer?.dispose()
  renderer = null
  for (const pending of resourcePending.values()) {
    pending.cleanup()
    pending.reject(new Error(message))
  }
  resourcePending.clear()
  try { port?.close() } catch { /* already closed */ }
  port = null
}

function isConnectMessage(value: unknown): value is {
  channel: typeof WORLD_RENDER_HOST_CONNECT_CHANNEL
  bootstrap: { protocol: typeof WORLD_RENDER_HOST_PROTOCOL; jobId: string; generation: string }
} {
  const record = exactDataRecord(value, ['channel', 'bootstrap'])
  if (!record || record.channel !== WORLD_RENDER_HOST_CONNECT_CHANNEL) return false
  const bootstrap = exactDataRecord(record.bootstrap, ['protocol', 'jobId', 'generation'])
  if (!bootstrap) return false
  return bootstrap.protocol === WORLD_RENDER_HOST_PROTOCOL
    && typeof bootstrap.jobId === 'string' && bootstrap.jobId.startsWith('render-')
    && isLowerHex(bootstrap.jobId.slice(7), 32)
    && typeof bootstrap.generation === 'string' && isLowerHex(bootstrap.generation, 32)
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const source = message || 'World render host failed.'
  let sanitized = ''
  for (let index = 0; index < source.length && sanitized.length < 512; index += 1) {
    const code = source.charCodeAt(index)
    sanitized += code <= 0x1f || code === 0x7f ? ' ' : source[index]
  }
  return sanitized
}

function isLowerHex(value: string, length: number): boolean {
  return value.length === length && [...value].every((character) => (
    (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')
  ))
}

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function exactDataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null
      || Object.getOwnPropertySymbols(value).length) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const ownKeys = Object.keys(descriptors)
    if (ownKeys.length !== keys.length || keys.some((key) => !Object.hasOwn(descriptors, key))) return null
    if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) return null
    return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))
  } catch {
    return null
  }
}

function isWorldWebmProtocolMessage(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'protocol')
    return Boolean(descriptor && 'value' in descriptor && descriptor.value === WORLD_WEBM_PROTOCOL)
  } catch {
    return false
  }
}

window.addEventListener('pagehide', () => failProtocol('World render page was closed.'), { once: true })

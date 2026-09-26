import {
  AudioSample,
  AudioSampleSource,
  Output,
  Quality,
  StreamTarget,
  VideoSample,
  VideoSampleSource,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
} from 'mediabunny'

import {
  assembleWorldWebm,
  WorldWebmTransportFailure,
  type WorldWebmMediaDependencies,
  type WorldWebmTransport,
} from './worldWebmAssembler.ts'
import {
  WORLD_WEBM_DEFAULT_TIMEOUT_MS,
  parseWorldWebmMainCommand,
  parseWorldWebmMainResponse,
  type WorldWebmMainResponse,
  type WorldWebmWorkerEvent,
  type WorldWebmWorkerRequest,
} from './worldWebmProtocol.ts'

interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
}

const scope = self as unknown as WorkerScope
const pending = new Map<number, {
  requestKind: WorldWebmWorkerRequest['kind']
  resolve: (response: WorldWebmMainResponse) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}>()
let lifetime: AbortController | null = null
let started = false
let activeIdentity: { jobId: string; generation: string } | null = null

const dependencies = {
  AudioSample,
  AudioSampleSource,
  Output,
  Quality,
  StreamTarget,
  VideoSample,
  VideoSampleSource,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
  decodePng: async (bytes: ArrayBuffer) => createImageBitmap(new Blob([bytes], { type: 'image/png' })),
} as unknown as WorldWebmMediaDependencies

scope.onmessage = ({ data }) => {
  const response = parseWorldWebmMainResponse(data)
  if (response) {
    if (!activeIdentity || response.jobId !== activeIdentity.jobId || response.generation !== activeIdentity.generation) return
    const entry = pending.get(response.requestId)
    if (!entry || entry.requestKind !== response.requestKind) return
    pending.delete(response.requestId)
    clearTimeout(entry.timeout)
    entry.resolve(response)
    return
  }
  const command = parseWorldWebmMainCommand(data)
  if (!command) return
  if (command.kind === 'abort') {
    if (!activeIdentity || command.jobId !== activeIdentity.jobId || command.generation !== activeIdentity.generation) return
    lifetime?.abort()
    rejectPending(abortError())
    return
  }
  if (started) return
  started = true
  activeIdentity = { jobId: command.jobId, generation: command.generation }
  lifetime = new AbortController()
  const identity = { jobId: command.jobId, generation: command.generation }
  const transport: WorldWebmTransport = {
    request(request, transfer) {
      if (request.jobId !== identity.jobId || request.generation !== identity.generation) {
        return Promise.reject(new WorldWebmTransportFailure('protocol-failed', 'World WebM request identity changed.'))
      }
      if (lifetime?.signal.aborted) return Promise.reject(abortError())
      return new Promise<WorldWebmMainResponse>((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (!pending.delete(request.requestId)) return
          reject(new WorldWebmTransportFailure('worker-timeout', 'World WebM host response timed out.'))
        }, WORLD_WEBM_DEFAULT_TIMEOUT_MS)
        pending.set(request.requestId, { requestKind: request.kind, resolve, reject, timeout })
        try {
          scope.postMessage(request, transfer ? [...transfer] : undefined)
        } catch (error) {
          pending.delete(request.requestId)
          clearTimeout(timeout)
          reject(new WorldWebmTransportFailure(
            'protocol-failed',
            error instanceof Error ? error.message : String(error),
          ))
        }
      })
    },
    emit(event: WorldWebmWorkerEvent) {
      if (event.jobId !== identity.jobId || event.generation !== identity.generation) return
      scope.postMessage(event)
    },
  }
  void assembleWorldWebm(command, dependencies, transport, lifetime.signal)
    .finally(() => rejectPending(abortError()))
}

function rejectPending(error: Error): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timeout)
    entry.reject(error)
  }
  pending.clear()
}

function abortError(): Error {
  const error = new Error('World WebM Worker was cancelled.')
  error.name = 'AbortError'
  return error
}

/// <reference lib="dom" />

import { ipcRenderer } from 'electron'

import {
  WORLD_RENDER_HOST_CONNECT_CHANNEL,
  WORLD_RENDER_HOST_PROTOCOL,
} from '../../src/shared/types/worldRenderHost.ts'

/**
 * This preload exposes no IPC methods. It transfers one job-scoped MessagePort
 * into the isolated page; every subsequent message remains generation-bound.
 */
ipcRenderer.once(WORLD_RENDER_HOST_CONNECT_CHANNEL, (event, bootstrap: unknown) => {
  if (!isBootstrap(bootstrap) || event.ports.length !== 1) return
  window.postMessage({ channel: WORLD_RENDER_HOST_CONNECT_CHANNEL, bootstrap }, '*', [event.ports[0]])
})

function isBootstrap(value: unknown): value is {
  protocol: typeof WORLD_RENDER_HOST_PROTOCOL
  jobId: string
  generation: string
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    if (Object.getOwnPropertySymbols(value).length) return false
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.keys(descriptors).length !== 3
      || !['protocol', 'jobId', 'generation'].every((key) => {
        const descriptor = descriptors[key]
        return descriptor?.enumerable && 'value' in descriptor
      })) return false
    const protocol = descriptors.protocol.value
    const jobId = descriptors.jobId.value
    const generation = descriptors.generation.value
    return protocol === WORLD_RENDER_HOST_PROTOCOL
      && typeof jobId === 'string' && jobId.startsWith('render-') && isLowerHex(jobId.slice(7), 32)
      && typeof generation === 'string' && isLowerHex(generation, 32)
  } catch {
    return false
  }
}

function isLowerHex(value: string, length: number): boolean {
  return value.length === length && [...value].every((character) => (
    (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')
  ))
}

import { Quaternion, Vector3 } from 'three'

import type { WorldAudioSourceComponent } from '../core/worldComponentRegistry.ts'
import type { WorldProjectSnapshotV1, WorldVector3 } from '../core/worldModel.ts'
import { resolveWorldRuntimeEffectiveEnabled } from './worldRuntimeEntityGraph.ts'

export interface WorldAudioPose {
  entityId: string
  position: WorldVector3
  rotation: [number, number, number, number]
}

export interface WorldAudioAuthority {
  prepareScene(snapshot: WorldProjectSnapshotV1, sceneId: string): Promise<void>
  activate(): Promise<void>
  play(componentId: string): Promise<void>
  stopSource(componentId: string): Promise<void>
  update(poses: readonly WorldAudioPose[]): void
  pause(): Promise<void>
  resume(): Promise<void>
  stop(): Promise<void>
}

export interface WebAudioWorldAuthorityOptions {
  createContext(): AudioContext
  fetchArrayBuffer(url: string, signal: AbortSignal): Promise<ArrayBuffer>
  resolveResourceUrl(workspacePath: string): string
}

interface AudioSourceDefinition {
  entityId: string
  component: WorldAudioSourceComponent
  workspacePath: string
}

interface ActiveAudioNode {
  componentId: string
  entityId: string
  source: AudioBufferSourceNode
  gain: GainNode
  panner: PannerNode | null
}

export class WebAudioWorldAuthority implements WorldAudioAuthority {
  private readonly options: WebAudioWorldAuthorityOptions
  private context: AudioContext | null = null
  private abortController: AbortController | null = null
  private sources = new Map<string, AudioSourceDefinition>()
  private buffers = new Map<string, AudioBuffer>()
  private activeNodes = new Set<ActiveAudioNode>()
  private posesByEntity = new Map<string, WorldAudioPose>()
  private listenerEntityId: string | null = null
  private active = false
  private stopped = false

  constructor(options: WebAudioWorldAuthorityOptions) {
    this.options = options
  }

  async prepareScene(snapshot: WorldProjectSnapshotV1, sceneId: string): Promise<void> {
    if (this.context || this.abortController) throw new Error('Audio authority already owns a scene.')
    const scene = snapshot.scenes.find((candidate) => candidate.sceneId === sceneId)
    if (!scene) throw new Error(`Audio scene ${sceneId} does not exist.`)
    this.context = this.options.createContext()
    this.abortController = new AbortController()
    const resources = new Map(snapshot.project.resources.map((resource) => [resource.id, resource]))
    const effectiveEnabled = resolveWorldRuntimeEffectiveEnabled(scene.entities)
    for (const entity of scene.entities) {
      if (!effectiveEnabled.get(entity.id)) continue
      for (const component of entity.components) {
        if (!component.enabled) continue
        if (component.type === 'audio-listener' && component.primary) this.listenerEntityId = entity.id
        if (component.type !== 'audio-source') continue
        const resource = resources.get(component.resourceId)
        if (!resource || resource.type !== 'audio') throw new Error(`Audio resource ${component.resourceId} is unavailable.`)
        this.sources.set(component.id, { entityId: entity.id, component: structuredClone(component), workspacePath: resource.workspacePath })
      }
    }
    await Promise.all([...this.sources.values()].map(async (definition) => {
      const bytes = await this.options.fetchArrayBuffer(this.options.resolveResourceUrl(definition.workspacePath), this.abortController!.signal)
      if (this.stopped) return
      const decoded = await this.context!.decodeAudioData(bytes.slice(0))
      if (!this.stopped) this.buffers.set(definition.component.id, decoded)
    }))
  }

  async activate(): Promise<void> {
    if (this.stopped || !this.context) return
    this.active = true
    if (this.context.state === 'suspended') await this.context.resume()
    for (const definition of this.sources.values()) if (definition.component.autoplay) await this.play(definition.component.id)
  }

  async play(componentId: string): Promise<void> {
    const context = this.context
    const definition = this.sources.get(componentId)
    const buffer = this.buffers.get(componentId)
    if (!this.active || this.stopped || !context || !definition || !buffer) return
    const source = context.createBufferSource()
    const gain = context.createGain()
    source.buffer = buffer
    source.loop = definition.component.loop
    gain.gain.value = definition.component.volume
    let panner: PannerNode | null = null
    if (definition.component.spatial) {
      panner = context.createPanner()
      panner.distanceModel = 'inverse'
      panner.refDistance = 1
      panner.maxDistance = definition.component.maxDistance
      source.connect(gain)
      gain.connect(panner)
      panner.connect(context.destination)
      const pose = this.posesByEntity.get(definition.entityId)
      if (pose) setAudioPosition(panner, pose.position, context.currentTime)
    } else {
      source.connect(gain)
      gain.connect(context.destination)
    }
    const node: ActiveAudioNode = { componentId, entityId: definition.entityId, source, gain, panner }
    this.activeNodes.add(node)
    source.addEventListener('ended', () => this.disconnectNode(node), { once: true })
    source.start()
  }

  async stopSource(componentId: string): Promise<void> {
    if (this.stopped) return
    for (const node of [...this.activeNodes]) {
      if (node.componentId !== componentId) continue
      try { node.source.stop() } catch { /* Source may already have ended. */ }
      this.disconnectNode(node)
    }
  }

  update(poses: readonly WorldAudioPose[]): void {
    const context = this.context
    if (!context || this.stopped) return
    for (const pose of poses) this.posesByEntity.set(pose.entityId, structuredClone(pose))
    const byId = new Map(poses.map((pose) => [pose.entityId, pose]))
    if (this.listenerEntityId) {
      const listenerPose = byId.get(this.listenerEntityId)
      if (listenerPose) updateListener(context.listener, listenerPose, context.currentTime)
    }
    for (const node of this.activeNodes) {
      const pose = byId.get(node.entityId)
      if (pose && node.panner) setAudioPosition(node.panner, pose.position, context.currentTime)
    }
  }

  async pause(): Promise<void> {
    if (this.context && this.context.state !== 'closed') await this.context.suspend()
  }

  async resume(): Promise<void> {
    if (this.context && !this.stopped && this.context.state !== 'closed') await this.context.resume()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.active = false
    this.abortController?.abort('World Play stopped.')
    this.abortController = null
    for (const node of [...this.activeNodes]) {
      try { node.source.stop() } catch { /* Source may already have ended. */ }
      this.disconnectNode(node)
    }
    this.sources.clear()
    this.buffers.clear()
    this.posesByEntity.clear()
    const context = this.context
    this.context = null
    if (context && context.state !== 'closed') await context.close()
  }

  private disconnectNode(node: ActiveAudioNode): void {
    if (!this.activeNodes.delete(node)) return
    try { node.source.disconnect() } catch { /* Already disconnected. */ }
    try { node.gain.disconnect() } catch { /* Already disconnected. */ }
    try { node.panner?.disconnect() } catch { /* Already disconnected. */ }
  }
}

export function createBrowserWorldAudioAuthority(apiUrl: string): WebAudioWorldAuthority {
  const base = apiUrl.trim().replace(/\/+$/, '')
  return new WebAudioWorldAuthority({
    createContext: () => new AudioContext(),
    fetchArrayBuffer: async (url, signal) => {
      const response = await fetch(url, { signal })
      if (!response.ok) throw new Error(`Audio request failed with ${response.status}.`)
      return response.arrayBuffer()
    },
    resolveResourceUrl: (workspacePath) => `${base}/workspace/${workspacePath.split('/').map(encodeURIComponent).join('/')}`,
  })
}

function updateListener(listener: AudioListener, pose: WorldAudioPose, time: number): void {
  setAudioPosition(listener, pose.position, time)
  const quaternion = new Quaternion(...pose.rotation)
  const forward = new Vector3(0, 0, -1).applyQuaternion(quaternion)
  const up = new Vector3(0, 1, 0).applyQuaternion(quaternion)
  if ('forwardX' in listener && listener.forwardX) {
    listener.forwardX.setValueAtTime(forward.x, time)
    listener.forwardY.setValueAtTime(forward.y, time)
    listener.forwardZ.setValueAtTime(forward.z, time)
    listener.upX.setValueAtTime(up.x, time)
    listener.upY.setValueAtTime(up.y, time)
    listener.upZ.setValueAtTime(up.z, time)
  } else {
    listener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z)
  }
}

function setAudioPosition(target: AudioListener | PannerNode, position: WorldVector3, time: number): void {
  if ('positionX' in target && target.positionX) {
    target.positionX.setValueAtTime(position[0], time)
    target.positionY.setValueAtTime(position[1], time)
    target.positionZ.setValueAtTime(position[2], time)
  } else {
    target.setPosition(position[0], position[1], position[2])
  }
}

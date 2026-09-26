import type { WorldCameraComponent, WorldLightComponent } from './core/worldComponentRegistry.ts'
import type { WorldSceneEnvironment, WorldTransform } from './core/worldModel.ts'

export interface WorldsViewportLight {
  entityId: string
  component: WorldLightComponent
  transform: WorldTransform
}

export interface WorldsViewportCamera {
  entityId: string
  component: WorldCameraComponent
  transform: WorldTransform
}

export interface WorldsTimelineViewportPreview {
  timeSeconds: number
  animationStates: readonly { entityId: string; componentId: string; playing: boolean }[]
  activeCamera: WorldsViewportCamera | null
}

export interface WorldsViewportEnvironment extends WorldSceneEnvironment {
  environmentResourceUrl?: string
}

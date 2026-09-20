export interface ArtifactProvenance {
  workflowId?: string
  workflowNodeId?: string
  source?: string
  [key: string]: unknown
}
export interface SceneArtifactManifestPreview { image?: string; video?: string }
export interface SceneArtifactManifestInitialView {
  position: [number, number, number]
  target: [number, number, number]
  up?: [number, number, number]
}
export interface SceneArtifactManifestV1 {
  schema: 'modly.scene-manifest.v1'
  sceneRoot: string
  assets: unknown[]
  preview?: SceneArtifactManifestPreview
  initialView?: SceneArtifactManifestInitialView
}
export interface CaptureFrameV1 {
  index: number
  path: string
  width: number
  height: number
  byteSize: number
  timestampMs?: number
}
export interface CaptureVideoV1 {
  path: string
  width: number
  height: number
  byteSize: number
  frameCount: number
  durationMs?: number
  frameRate?: number
}
export interface CaptureArtifactManifestV1 {
  schema: 'modly.capture-manifest.v1'
  captureRoot: string
  kind: 'frames' | 'video'
  frames?: CaptureFrameV1[]
  video?: CaptureVideoV1
  provenance: { source: string; ordering: 'manifest-index' | 'decode-index'; [key: string]: unknown }
}

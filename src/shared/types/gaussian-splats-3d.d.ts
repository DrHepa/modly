declare module '@mkkellogg/gaussian-splats-3d' {
  import * as THREE from 'three'

  export const SceneFormat: {
    readonly Ply: number
  }

  export interface AbortablePromise<T = void> extends Promise<T> {
    abort: (reason?: unknown) => void
  }

  export interface DropInViewerOptions {
    gpuAcceleratedSort?: boolean
    sharedMemoryForWorkers?: boolean
    sphericalHarmonicsDegree?: number
    selfDrivenMode?: boolean
    useBuiltInControls?: boolean
    rootElement?: HTMLElement | null
    dropInMode?: boolean
    camera?: THREE.Camera
    renderer?: THREE.WebGLRenderer
  }

  export interface AddSplatSceneOptions {
    format?: number
    showLoadingUI?: boolean
    progressiveLoad?: boolean
    position?: [number, number, number]
    rotation?: [number, number, number, number]
    scale?: [number, number, number]
    splatAlphaRemovalThreshold?: number
    onProgress?: (percentComplete: number, percentCompleteLabel: string, loaderStatus: unknown) => void
  }

  export interface GaussianSplatTreeNode {
    min: THREE.Vector3
    max: THREE.Vector3
  }

  export interface GaussianSplatSubTree {
    nodesWithIndexes: GaussianSplatTreeNode[]
  }

  export interface GaussianSplatTree {
    subTrees: GaussianSplatSubTree[]
  }

  export interface GaussianSplatMesh extends THREE.Object3D {
    geometry?: THREE.BufferGeometry
    getSplatTree?: () => GaussianSplatTree | null
    getSplatCount?: () => number
    getSplatCenter?: (index: number, target: THREE.Vector3, transform?: boolean) => void
  }

  export class DropInViewer extends THREE.Group {
    constructor(options?: DropInViewerOptions)
    addSplatScene(path: string, options?: AddSplatSceneOptions): AbortablePromise<void>
    removeSplatScene(index: number, showLoadingUI?: boolean): Promise<void>
    getSceneCount(): number
    getSplatMesh(): GaussianSplatMesh
    dispose(): Promise<void>
  }
}

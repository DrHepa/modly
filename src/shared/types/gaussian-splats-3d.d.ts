declare module '@mkkellogg/gaussian-splats-3d' {
  import * as THREE from 'three'

  export const SceneFormat: {
    readonly Ply: number
    readonly Splat: number
    readonly KSplat: number
    readonly Spz: number
  }

  export interface AbortablePromise<T = void> extends Promise<T> {
    abort: (reason?: unknown) => void
  }

  export interface GaussianSplatsControls {
    target?: THREE.Vector3
    update?: () => void
    autoRotate?: boolean
    autoRotateSpeed?: number
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

  export interface ViewerOptions extends DropInViewerOptions {
    cameraUp?: [number, number, number]
    initialCameraPosition?: [number, number, number]
    initialCameraLookAt?: [number, number, number]
    ignoreDevicePixelRatio?: boolean
    halfPrecisionCovariancesOnGPU?: boolean
    threeScene?: THREE.Scene
    gpuAcceleratedSort?: boolean
    integerBasedSort?: boolean
    dynamicScene?: boolean
    antialiased?: boolean
    kernel2DSize?: number
    sphericalHarmonicsDegree?: number
    enableOptionalEffects?: boolean
    enableSIMDInSort?: boolean
    inMemoryCompressionLevel?: number
    optimizeSplatData?: boolean
    freeIntermediateSplatData?: boolean
    sceneFadeInRateMultiplier?: number
    splatSortDistanceMapPrecision?: number
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

  export class Viewer {
    constructor(options?: ViewerOptions)
    camera?: THREE.PerspectiveCamera
    controls?: GaussianSplatsControls
    renderer?: THREE.WebGLRenderer
    threeScene: THREE.Scene
    splatMesh: GaussianSplatMesh
    addSplatScene(path: string, options?: AddSplatSceneOptions): AbortablePromise<void>
    getSplatMesh(): GaussianSplatMesh
    start(): void
    stop(): void
    render(): void
    dispose(): Promise<void>
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

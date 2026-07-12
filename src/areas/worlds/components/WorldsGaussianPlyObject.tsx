import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { DropInViewer, SceneFormat, type AbortablePromise } from '@mkkellogg/gaussian-splats-3d'

export const WORLDS_GAUSSIAN_PLY_VIEWER_OPTIONS = {
  gpuAcceleratedSort: true,
  sharedMemoryForWorkers: false,
  sphericalHarmonicsDegree: 0,
} as const

export const WORLDS_GAUSSIAN_PLY_SCENE_OPTIONS = {
  format: SceneFormat.Ply,
  progressiveLoad: true,
  showLoadingUI: false,
  position: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const

const gaussianBounds = new THREE.Box3()
const gaussianCenter = new THREE.Vector3()

export function WorldsGaussianPlyObject({
  itemId,
  url,
  onBoundsChange,
}: {
  itemId: string
  url: string
  onBoundsChange: () => void
}): JSX.Element | null {
  const viewerRef = useRef<DropInViewer | null>(null)
  const loadRef = useRef<AbortablePromise<void> | null>(null)
  const mountedRef = useRef(false)
  const [viewer, setViewer] = useState<DropInViewer | null>(null)

  useEffect(() => {
    mountedRef.current = true
    const nextViewer = new DropInViewer(WORLDS_GAUSSIAN_PLY_VIEWER_OPTIONS)
    viewerRef.current = nextViewer
    setViewer(nextViewer)

    nextViewer.userData.worldsSceneItemId = itemId
    nextViewer.raycast = () => null

    const load = nextViewer.addSplatScene(url, {
      ...WORLDS_GAUSSIAN_PLY_SCENE_OPTIONS,
      onProgress: () => {
        if (!mountedRef.current) return
        applyGaussianViewerMetadata(nextViewer, itemId)
        updateGaussianViewerBounds(nextViewer)
        onBoundsChange()
      },
    })
    loadRef.current = load

    load.then(() => {
      if (!mountedRef.current) return
      applyGaussianViewerMetadata(nextViewer, itemId)
      updateGaussianViewerBounds(nextViewer)
      onBoundsChange()
    }).catch((reason: unknown) => {
      if (!mountedRef.current) return
      console.warn('[Worlds] Gaussian PLY render skipped.', reason instanceof Error ? reason.message : 'Unable to load Gaussian PLY.')
    })

    return () => {
      mountedRef.current = false
      loadRef.current?.abort('Worlds Gaussian PLY unmounted.')
      nextViewer.userData.worldsObjectBounds = undefined
      const disposeViewer = async () => {
        try {
          if (nextViewer.getSceneCount() > 0) await nextViewer.removeSplatScene(0, false)
        } catch {
          // Ignore teardown races between progressive load callbacks and viewer removal.
        }
        try {
          await nextViewer.dispose()
        } catch {
          // Fail closed during cleanup.
        }
      }
      void disposeViewer()
      viewerRef.current = null
      loadRef.current = null
      setViewer((current) => (current === nextViewer ? null : current))
    }
  }, [itemId, onBoundsChange, url])

  if (!viewer) return null
  return <primitive object={viewer} />
}

function applyGaussianViewerMetadata(viewer: DropInViewer, itemId: string): void {
  viewer.userData.worldsSceneItemId = itemId
  viewer.traverse((child) => {
    child.userData.worldsSceneItemId = itemId
    child.raycast = () => null
  })
}

export function updateGaussianViewerBounds(viewer: DropInViewer): THREE.Box3 | null {
  const bounds = resolveGaussianViewerBounds(viewer)
  if (!bounds) {
    viewer.userData.worldsObjectBounds = undefined
    return null
  }
  viewer.userData.worldsObjectBounds = bounds.clone()
  return bounds
}

export function resolveGaussianViewerBounds(viewer: DropInViewer): THREE.Box3 | null {
  const splatMesh = viewer.getSplatMesh()
  const tree = splatMesh.getSplatTree?.()
  if (tree) {
    gaussianBounds.makeEmpty()
    for (const subTree of tree.subTrees) {
      for (const node of subTree.nodesWithIndexes) {
        gaussianBounds.expandByPoint(node.min)
        gaussianBounds.expandByPoint(node.max)
      }
    }
    if (!gaussianBounds.isEmpty()) return gaussianBounds.clone()
  }

  const geometry = splatMesh.geometry
  if (geometry) {
    if (!geometry.boundingBox) geometry.computeBoundingBox()
    if (geometry.boundingBox && !geometry.boundingBox.isEmpty()) return geometry.boundingBox.clone()
  }

  const splatCount = splatMesh.getSplatCount?.() ?? 0
  if (splatCount <= 0 || !splatMesh.getSplatCenter) return null

  gaussianBounds.makeEmpty()
  const sampleCount = Math.min(splatCount, 2048)
  const step = Math.max(1, Math.floor(splatCount / sampleCount))
  for (let index = 0; index < splatCount; index += step) {
    splatMesh.getSplatCenter(index, gaussianCenter, true)
    gaussianBounds.expandByPoint(gaussianCenter)
  }

  return gaussianBounds.isEmpty() ? null : gaussianBounds.clone()
}

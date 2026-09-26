import { Mesh, Object3D, Raycaster, Vector2, type BufferGeometry, type Camera, type Intersection } from 'three'
import type { Point, Rect } from './shared.ts'

/** Actual fixture picker raycasts use only locally owned scratch meshes. */
export function withPickerScratch<T>(picker: Object3D, camera: Camera, viewport: Rect,
  observe: (scratch: Mesh[], sourceByScratch: Map<Mesh, Mesh>, hitAt: (point: Point) => Intersection<Object3D> | undefined) => T): T {
  const scratch: Mesh[] = []
  const sourceByScratch = new Map<Mesh, Mesh>()
  const owned: BufferGeometry[] = []
  let failed = false
  try {
    picker.traverse((child) => {
      if (!(child instanceof Mesh)) return
      const geometry = child.geometry.clone()
      owned.push(geometry)
      const copy = new Mesh(geometry, child.material)
      copy.name = child.name; copy.visible = child.visible; copy.matrixWorld.copy(child.matrixWorld)
      scratch.push(copy); sourceByScratch.set(copy, child)
    })
    const hitAt = (point: Point) => {
      const ray = new Raycaster()
      ray.setFromCamera(new Vector2((point.x - viewport.x) / viewport.width * 2 - 1, -(point.y - viewport.y) / viewport.height * 2 + 1), camera)
      return ray.intersectObjects(scratch, false).find((hit) => hit.object.visible)
    }
    return observe(scratch, sourceByScratch, hitAt)
  } catch (error) { failed = true; throw error }
  finally {
    let cleanupFailed = false, cleanupError: unknown
    for (const geometry of owned) {
      try { geometry.dispose() }
      catch (error) { if (!cleanupFailed) { cleanupFailed = true; cleanupError = error } }
    }
    if (cleanupFailed && !failed) throw cleanupError
  }
}

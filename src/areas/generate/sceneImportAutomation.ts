import type { GenerationJob } from '../../shared/stores/appStore'

export type SceneImportMeshPayload = {
  meshPath: string
  url: string
  displayName: string
}

export function buildSceneImportGenerationJob(payload: SceneImportMeshPayload, now = Date.now()): GenerationJob {
  return {
    id: `import-${now}`,
    imageFile: '',
    status: 'done',
    progress: 100,
    outputUrl: payload.url,
    originalOutputUrl: payload.url,
    createdAt: now,
  }
}

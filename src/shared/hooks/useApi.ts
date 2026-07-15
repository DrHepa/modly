import axios from 'axios'
import { useAppStore, type GenerationOptions } from '../stores/appStore.ts'

export type GenerationSubmitRequest =
  | {
    kind: 'none'
  }
  | {
    kind: 'image'
    imagePath: string
    imageData?: string
  }
  | {
    kind: 'text'
    prompt: string
  }
  | { kind: 'scene'; inputPath: string }

type ApiClient = Pick<ReturnType<typeof axios.create>, 'post' | 'get'>

type CreateGenerationApiDeps = {
  client: ApiClient
  readFileBase64: (filePath: string) => Promise<string>
}

function createImageFormData(imagePath: string, options: GenerationOptions, base64: string): FormData {
  const byteArray = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const blob = new Blob([byteArray], { type: 'image/png' })
  const filename = imagePath.split(/[\\/]/).pop() ?? 'image.png'

  const formData = new FormData()
  formData.append('image', blob, filename)
  formData.append('model_id', options.modelId)
  formData.append('remesh', options.remesh)
  formData.append('enable_texture', String(options.enableTexture))
  formData.append('texture_resolution', String(options.textureResolution))
  formData.append('params', JSON.stringify(options.modelParams))
  return formData
}

export function createGenerationApi({ client, readFileBase64 }: CreateGenerationApiDeps) {
  async function generateFromImage(
    imagePath: string,
    options: GenerationOptions,
    imageData?: string,
    signal?: AbortSignal,
  ): Promise<{ jobId: string }> {
    const base64 = imageData ?? await readFileBase64(imagePath)
    const formData = createImageFormData(imagePath, options, base64)
    const { data } = await client.post<{ job_id: string }>('/generate/from-image', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      signal,
    })

    return { jobId: data.job_id }
  }

  async function generateFromNone(
    options: GenerationOptions,
    signal?: AbortSignal,
  ): Promise<{ jobId: string }> {
    const { data } = await client.post<{ job_id: string }>('/generate/from-none', {
      model_id: options.modelId,
      remesh: options.remesh,
      enable_texture: options.enableTexture,
      texture_resolution: options.textureResolution,
      params: options.modelParams,
    }, {
      signal,
    })

    return { jobId: data.job_id }
  }

  async function generateFromText(
    prompt: string,
    options: GenerationOptions,
    signal?: AbortSignal,
  ): Promise<{ jobId: string }> {
    const { data } = await client.post<{ job_id: string }>('/generate/from-text', {
      prompt,
      model_id: options.modelId,
      remesh: options.remesh,
      enable_texture: options.enableTexture,
      texture_resolution: options.textureResolution,
      params: options.modelParams,
    }, {
      signal,
    })

    return { jobId: data.job_id }
  }

  async function submitGeneration(
    request: GenerationSubmitRequest,
    options: GenerationOptions,
    signal?: AbortSignal,
  ): Promise<{ jobId: string }> {
    if (request.kind === 'scene') {
      const { data } = await client.post<{ job_id: string }>('/generate/from-artifact', {
        input_kind: 'scene', input_path: request.inputPath, model_id: options.modelId, params: options.modelParams,
      }, { signal })
      return { jobId: data.job_id }
    }
    if (request.kind === 'none') {
      return generateFromNone(options, signal)
    }
    if (request.kind === 'text') {
      return generateFromText(request.prompt, options, signal)
    }

    return generateFromImage(request.imagePath, options, request.imageData, signal)
  }

  async function pollJobStatus(jobId: string): Promise<{
    status: 'pending' | 'running' | 'done' | 'error' | 'cancelled'
    progress: number
    step?: string
    outputUrl?: string
    outputKind?: 'mesh' | 'scene' | 'image' | 'audio' | 'video'
    error?: string
  }> {
    const { data } = await client.get(`/generate/status/${jobId}`)
    return { ...data, outputUrl: data.output_url, outputKind: data.output_kind }
  }

  async function getModelStatus(): Promise<{
    downloaded: boolean
    name: string
    size_gb: number
    progress?: number
  }> {
    const { data } = await client.get('/model/status')
    return data
  }

  async function getAllModelsStatus(): Promise<{ id: string; name: string; downloaded: boolean }[]> {
    const { data } = await client.get('/model/all')
    return data
  }

  async function downloadModel(
    onProgress?: (pct: number) => void
  ): Promise<void> {
    const response = await client.get('/model/download', {
      responseType: 'stream'
    })

    const reader = response.data
    reader.on('data', (chunk: Buffer) => {
      try {
        const line = chunk.toString().replace('data: ', '').trim()
        if (line) {
          const { progress } = JSON.parse(line)
          onProgress?.(progress)
        }
      } catch {
        // ignore parse errors
      }
    })

    await new Promise<void>((resolve, reject) => {
      reader.on('end', resolve)
      reader.on('error', reject)
    })
  }

  async function optimizeMesh(
    path: string,
    targetFaces: number,
  ): Promise<{ url: string; faceCount: number }> {
    const { data } = await client.post<{ url: string; face_count: number }>('/optimize/mesh', {
      path,
      target_faces: targetFaces,
    })
    return { url: data.url, faceCount: data.face_count }
  }

  async function cancelJob(jobId: string): Promise<void> {
    await client.post(`/generate/cancel/${jobId}`).catch(() => {})
  }

  async function smoothMesh(
    path: string,
    iterations: number,
  ): Promise<{ url: string }> {
    const { data } = await client.post<{ url: string }>('/optimize/smooth', {
      path,
      iterations,
    })
    return { url: data.url }
  }

  async function importMesh(filePath: string): Promise<{ url: string }> {
    const { data } = await client.post<{ url: string }>('/optimize/import-by-path', { path: filePath })
    return { url: data.url }
  }

  // Bakes a world-space 4x4 transform into the GLB geometry.
  // `matrix` is row-major (4 rows of 4), matching the backend's reshape.
  async function transformMesh(
    path: string,
    matrix: number[][],
  ): Promise<{ url: string }> {
    const { data } = await client.post<{ url: string }>('/optimize/transform', {
      path,
      matrix,
    })
    return { url: data.url }
  }

  return { generateFromNone, generateFromImage, generateFromText, submitGeneration, pollJobStatus, cancelJob, getModelStatus, getAllModelsStatus, downloadModel, optimizeMesh, smoothMesh, importMesh, transformMesh }
}

export function useApi() {
  const apiUrl = useAppStore((s) => s.apiUrl)

  const client = axios.create({ baseURL: apiUrl })

  return createGenerationApi({
    client,
    readFileBase64: (filePath) => window.electron.fs.readFileBase64(filePath),
  })
}

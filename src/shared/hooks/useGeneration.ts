import { useCallback, useRef } from 'react'
import { useAppStore, type GenerationOptions } from '../stores/appStore.ts'
import { useExtensionsStore, type ModelExtension } from '../stores/extensionsStore.ts'
import { useApi, type GenerationSubmitRequest } from './useApi.ts'

type ResolveLegacyGenerationRequestArgs = {
  imagePath: string | null | undefined
  selectedImageData: string | null
  generationOptions: GenerationOptions
  modelExtensions: ModelExtension[]
}

function resolveModelInput(modelId: string, modelExtensions: ModelExtension[]): 'image' | 'text' {
  const extension = modelExtensions.find((candidate) => candidate.id === modelId)
  const input = extension?.nodes[0]?.input

  if (!input) {
    throw new Error(`Missing generation input metadata for model ${modelId}`)
  }

  if (input === 'image' || input === 'text') {
    return input
  }

  throw new Error(`Unsupported generation input for model ${modelId}: ${input}`)
}

export function resolveLegacyGenerationRequest({
  imagePath,
  selectedImageData,
  generationOptions,
  modelExtensions,
}: ResolveLegacyGenerationRequestArgs): GenerationSubmitRequest {
  const input = resolveModelInput(generationOptions.modelId, modelExtensions)

  if (input === 'text') {
    return {
      kind: 'text',
      prompt: typeof generationOptions.modelParams.prompt === 'string' ? generationOptions.modelParams.prompt : '',
    }
  }

  if (!imagePath) {
    throw new Error(`Image path is required for image generation model ${generationOptions.modelId}`)
  }

  return {
    kind: 'image',
    imagePath,
    imageData: selectedImageData ?? undefined,
  }
}

export function useGeneration() {
  const { currentJob, setCurrentJob, updateCurrentJob, generationOptions, selectedImageData, pushMeshUrl, clearMeshHistory } = useAppStore()
  const modelExtensions = useExtensionsStore((s) => s.modelExtensions)
  const { submitGeneration, pollJobStatus, cancelJob } = useApi()
  const cancelledRef = useRef(false)
  const abortControllerRef = useRef<AbortController | null>(null)

  const startGeneration = useCallback(
    async (imagePath?: string | null) => {
      cancelledRef.current = false
      abortControllerRef.current = new AbortController()
      clearMeshHistory()
      const request = resolveLegacyGenerationRequest({
        imagePath,
        selectedImageData,
        generationOptions,
        modelExtensions,
      })
      const job = {
        id: crypto.randomUUID(),
        imageFile: request.kind === 'image' ? request.imagePath : '',
        status: 'uploading' as const,
        progress: 0,
        createdAt: Date.now(),
        modelId: generationOptions.modelId,
        generationOptions,
      }
      setCurrentJob(job)

      try {
        const { jobId } = await submitGeneration(request, generationOptions, abortControllerRef.current.signal)

        if (cancelledRef.current) {
          await cancelJob(jobId)
          setCurrentJob(null)
          return
        }

        updateCurrentJob({ status: 'generating', progress: 0 })

        await pollUntilDone(jobId)
      } catch (err) {
        if (cancelledRef.current) {
          setCurrentJob(null)
          return
        }
        let errorMessage: string
        if (err && typeof err === 'object' && 'response' in err) {
          const axiosErr = err as { response?: { data?: { detail?: string } }; message: string }
          errorMessage = axiosErr.response?.data?.detail ?? axiosErr.message
        } else {
          errorMessage = err instanceof Error ? err.message : String(err)
        }
        updateCurrentJob({
          status: 'error',
          error: errorMessage
        })
      }
    },
    [submitGeneration, pollJobStatus, cancelJob, setCurrentJob, updateCurrentJob, generationOptions, selectedImageData, modelExtensions, clearMeshHistory]
  )

  const pollUntilDone = async (jobId: string) => {
    while (true) {
      await new Promise((r) => setTimeout(r, 1000))

      if (cancelledRef.current) {
        await cancelJob(jobId)
        setCurrentJob(null)
        break
      }

      const result = await pollJobStatus(jobId)

      if (result.status === 'cancelled') {
        setCurrentJob(null)
        break
      }

      if (result.status === 'done') {
        updateCurrentJob({ status: 'done', progress: 100, outputUrl: result.outputUrl, originalOutputUrl: result.outputUrl })
        if (result.outputUrl) pushMeshUrl(result.outputUrl)
        break
      }

      if (result.status === 'error') {
        updateCurrentJob({ status: 'error', error: result.error })
        break
      }

      updateCurrentJob({
        progress: result.progress,
        step: result.step,
      })
    }
  }

  const cancelGeneration = useCallback(() => {
    cancelledRef.current = true
    abortControllerRef.current?.abort()
  }, [])

  const reset = useCallback(() => setCurrentJob(null), [setCurrentJob])

  return { currentJob, startGeneration, cancelGeneration, reset }
}

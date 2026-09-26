import type { WorldRendersApi } from '../../src/shared/types/worldRenders.ts'

export interface WorldRenderServiceLifecycle extends WorldRendersApi {
  initialize(): Promise<void>
  shutdown(): Promise<void>
}

export interface WorldRenderExecutorLifecycle {
  shutdown(): Promise<void>
}

export interface WorldRenderSubsystem {
  readonly api: WorldRendersApi
  shutdown(): Promise<void>
}

/** Makes recovery the publication gate and centralizes the shutdown order. */
export async function initializeWorldRenderSubsystem(input: {
  service: WorldRenderServiceLifecycle
  executor: WorldRenderExecutorLifecycle
}): Promise<WorldRenderSubsystem> {
  await input.service.initialize()
  let shutdownPromise: Promise<void> | null = null
  return {
    api: input.service,
    shutdown: async () => {
      shutdownPromise ??= (async () => {
        try { await input.service.shutdown() }
        finally { await input.executor.shutdown() }
      })()
      await shutdownPromise
    },
  }
}

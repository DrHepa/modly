import assert from 'node:assert/strict'
import test from 'node:test'

const { createElectronApi } = await import(new URL('./electron-api.ts', import.meta.url).href)

test('preload model runtimeReadiness invokes the model:runtimeReadiness IPC channel', async () => {
  const invocations: Array<{ channel: string; args: unknown[] }> = []
  const api = createElectronApi({
    send() {},
    on() {},
    removeAllListeners() {},
    async invoke(channel: string, ...args: unknown[]) {
      invocations.push({ channel, args })
      return { success: true, models: {} }
    },
  })

  const result = await api.model.runtimeReadiness(['modly-codex-image-extension/text-to-image'])

  assert.deepEqual(result, { success: true, models: {} })
  assert.deepEqual(invocations, [
    {
      channel: 'model:runtimeReadiness',
      args: [['modly-codex-image-extension/text-to-image']],
    },
  ])
})

import assert from 'node:assert/strict'
import test from 'node:test'

const { createElectronApi } = await import(new URL('./electron-api.ts', import.meta.url).href)

const webFrame = { setZoomFactor() {} }

function createTestApi(ipcRenderer: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: (...args: unknown[]) => void): void
  removeAllListeners(channel: string): void
}) {
  return createElectronApi({ ipcRenderer, webFrame })
}

test('preload model runtimeReadiness invokes the model:runtimeReadiness IPC channel', async () => {
  const invocations: Array<{ channel: string; args: unknown[] }> = []
  const api = createTestApi({
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

test('preload model runtimeReadinessAction invokes the model:runtimeReadinessAction IPC channel', async () => {
  const invocations: Array<{ channel: string; args: unknown[] }> = []
  const api = createTestApi({
    send() {},
    on() {},
    removeAllListeners() {},
    async invoke(channel: string, ...args: unknown[]) {
      invocations.push({ channel, args })
      return { success: true }
    },
  })

  const action = {
    id: 'codex.login.docs',
    kind: 'open_external_url',
    label: 'Open login docs',
    docs_url: 'https://developers.openai.com/codex/auth',
    safety: 'manual',
  }
  const result = await api.model.runtimeReadinessAction(action)

  assert.deepEqual(result, { success: true })
  assert.deepEqual(invocations, [
    {
      channel: 'model:runtimeReadinessAction',
      args: [action],
    },
  ])
})

import assert from 'node:assert/strict'
import test from 'node:test'

const { createElectronApi } = await import(
  new URL('./electron-api.ts', import.meta.url).href
)

const webFrame = { setZoomFactor() {} }

function createTestApi(ipcRenderer: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: (...args: unknown[]) => void): void
  removeAllListeners(channel: string): void
}) {
  return createElectronApi({ ipcRenderer, webFrame })
}

test('preload HTTPS asset download sends only the canonical modelId payload', async () => {
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

  const result = await api.model.downloadHttpsAssets('gaussiangpt/vfront')

  assert.deepEqual(result, { success: true })
  assert.deepEqual(invocations, [{
    channel: 'model:downloadHttpsAssets',
    args: [{ modelId: 'gaussiangpt/vfront' }],
  }])
})

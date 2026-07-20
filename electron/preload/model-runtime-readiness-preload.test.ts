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
  }, { setZoomFactor() {} }, { getPathForFile() { return '/inert/file' } })

  const result = await api.model.runtimeReadiness(['modly-codex-image-extension/text-to-image'])

  assert.deepEqual(result, { success: true, models: {} })
  assert.deepEqual(invocations, [
    {
      channel: 'model:runtimeReadiness',
      args: [['modly-codex-image-extension/text-to-image']],
    },
  ])
})

test('readiness addition preserves the current preload factory and model controls', async () => {
  const calls: Array<[string, ...unknown[]]> = []
  const zoom: number[] = []
  const api = createElectronApi({
    send() {}, on() {}, removeAllListeners() {},
    async invoke(channel: string, ...args: unknown[]) { calls.push([channel, ...args]); return {} },
  }, { setZoomFactor(value: number) { zoom.push(value) } }, { getPathForFile() { return '/inert/file' } })
  api.ui.setZoomFactor(1.25)
  assert.deepEqual(zoom, [1.25])
  await api.window.isMaximized()
  await api.automation.capabilities()
  await api.workspace.library.list()
  await api.model.download('ext/node', 'fp16')
  await api.model.pauseDownload('ext/node')
  await api.model.cancelDownload('ext/node')
  await api.model.sharedGroups('ext')
  await api.model.installedWeightVariants('ext/node')
  assert.deepEqual(calls, [
    ['window:isMaximized'], ['automation:capabilities'], ['workspace:library:list'],
    ['model:download', 'ext/node', 'fp16'], ['model:pauseDownload', 'ext/node'],
    ['model:cancelDownload', 'ext/node'], ['model:sharedGroups', 'ext'],
    ['model:installedWeightVariants', 'ext/node'],
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
  }, { setZoomFactor() {} }, { getPathForFile() { return '/inert/file' } })

  const action = {
    id: 'codex.login.docs',
    kind: 'open_external_url',
    label: 'Open login docs',
    docs_url: 'https://developers.openai.com/codex/auth',
    safety: 'manual',
  } as const
  const result = await api.model.runtimeReadinessAction(action)

  assert.deepEqual(result, { success: true })
  assert.deepEqual(invocations, [
    {
      channel: 'model:runtimeReadinessAction',
      args: [action],
    },
  ])
})

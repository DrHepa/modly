import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const { createElectronApi } = await import(new URL('./electron-api.ts', import.meta.url).href)

test('preload ui.setZoomFactor delegates the exact factor to webFrame', () => {
  const factors: number[] = []
  const api = createElectronApi({
    ipcRenderer: {
      send() {},
      on() {},
      removeAllListeners() {},
      async invoke() {
        return undefined
      },
    },
    webFrame: {
      setZoomFactor(factor: number) {
        factors.push(factor)
      },
    },
  })

  api.ui.setZoomFactor(1.25)

  assert.deepEqual(factors, [1.25])
})

test('preload startup window and system APIs use the correct channels and cleanup', async () => {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const invocations: Array<{ channel: string; args: unknown[] }> = []
  const removed: string[] = []
  const maximizeStates: boolean[] = []
  const api = createElectronApi({
    ipcRenderer: {
      send() {},
      on(channel: string, listener: (...args: unknown[]) => void) {
        listeners.set(channel, listener)
      },
      removeAllListeners(channel: string) {
        removed.push(channel)
      },
      async invoke(channel: string, ...args: unknown[]) {
        invocations.push({ channel, args })
        if (channel === 'window:isMaximized') return true
        if (channel === 'system:memory') return { total: 8, used: 3, available: 5 }
        return undefined
      },
    },
    webFrame: { setZoomFactor() {} },
  })

  assert.equal(await api.window.isMaximized(), true)
  api.window.onMaximizeChange((isMaximized: boolean) => {
    maximizeStates.push(isMaximized)
  })
  listeners.get('window:maximizeChanged')?.({}, 0)
  listeners.get('window:maximizeChanged')?.({}, 'yes')
  api.window.offMaximizeChange()

  assert.deepEqual(await api.system.memory(), { total: 8, used: 3, available: 5 })
  assert.deepEqual(invocations, [
    { channel: 'window:isMaximized', args: [] },
    { channel: 'system:memory', args: [] },
  ])
  assert.deepEqual(maximizeStates, [false, true])
  assert.deepEqual(removed, ['window:maximizeChanged'])
})

test('preload restored fs and extensions APIs use the correct channels', async () => {
  const invocations: Array<{ channel: string; args: unknown[] }> = []
  const api = createElectronApi({
    ipcRenderer: {
      send() {},
      on() {},
      removeAllListeners() {},
      async invoke(channel: string, ...args: unknown[]) {
        invocations.push({ channel, args })
        return channel
      },
    },
    webFrame: { setZoomFactor() {} },
  })

  assert.equal(await api.fs.selectDirectory('/workspace/current'), 'fs:selectDirectory')
  assert.equal(await api.fs.listFiles('/workspace/current', ['png', '.json']), 'fs:listFiles')
  assert.equal(await api.fs.selectTextFile(), 'fs:selectTextFile')
  assert.equal(await api.extensions.installFromLocal(), 'extensions:installFromLocal')
  assert.deepEqual(invocations, [
    { channel: 'fs:selectDirectory', args: ['/workspace/current'] },
    { channel: 'fs:listFiles', args: ['/workspace/current', ['png', '.json']] },
    { channel: 'fs:selectTextFile', args: [] },
    { channel: 'extensions:installFromLocal', args: [] },
  ])
})

test('preload contract requires webFrame and production index wires it', async () => {
  assert.throws(() => createElectronApi({
    ipcRenderer: {
      send() {},
      on() {},
      removeAllListeners() {},
      async invoke() {
        return undefined
      },
    },
    webFrame: undefined as never,
  }), /webFrame\.setZoomFactor/)

  const indexSource = await readFile(new URL('./index.ts', import.meta.url), 'utf-8')
  assert.match(indexSource, /import\s*\{\s*contextBridge\s*,\s*ipcRenderer\s*,\s*webFrame\s*\}\s*from\s*'electron'/)
  assert.match(indexSource, /createElectronApi\(\{\s*ipcRenderer\s*,\s*webFrame\s*\}\)/)
})

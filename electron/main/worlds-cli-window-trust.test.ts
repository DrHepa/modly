import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { getMainWindowDocumentEpoch, installMainWindowNavigationGuard, isTrustedWorldsCliSender, resolveRendererDocumentUrl } from './worlds-cli-window-trust.ts'

function windowFor(url: string) {
  const contents = new EventEmitter() as EventEmitter & { mainFrame: { url: string; origin: string }; getURL(): string }
  contents.mainFrame = { url, origin: new URL(url).origin }
  contents.getURL = () => url
  return { isDestroyed: () => false, webContents: contents }
}

test('exact dev and packaged documents, not broad localhost or file origins, authorize real-shaped IPC sender', () => {
  const dev = resolveRendererDocumentUrl(true, 'http://127.0.0.1:5173/', '/opt/modly/out/renderer/index.html')
  assert.equal(dev, 'http://127.0.0.1:5173/')
  const packed = resolveRendererDocumentUrl(false, undefined, '/opt/modly/out/renderer/index.html')
  assert.equal(packed, pathToFileURL('/opt/modly/out/renderer/index.html').href)
  for (const target of [dev, packed]) {
    const window = windowFor(target)
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    assert.equal(isTrustedWorldsCliSender(event, window, target), true)
    assert.equal(isTrustedWorldsCliSender({ ...event, senderFrame: { ...event.senderFrame, url: target } }, window, target), false)
    window.webContents.mainFrame.url = target.startsWith('file:') ? 'file:///opt/modly/out/renderer/other.html' : 'http://127.0.0.1:5173/other'
    assert.equal(isTrustedWorldsCliSender(event, window, target), false)
  }
  const window = windowFor(dev)
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  window.webContents.mainFrame.origin = 'https://evil.example'
  assert.equal(isTrustedWorldsCliSender(event, window, dev), false)
  window.webContents.mainFrame.origin = new URL(dev).origin
  window.webContents.getURL = () => 'http://127.0.0.1:5174/'
  assert.equal(isTrustedWorldsCliSender(event, window, dev), false)
})

test('actual main-window navigation guard blocks same-window external document and redirect', async () => {
  const target = 'http://127.0.0.1:5173/'
  const window = windowFor(target)
  installMainWindowNavigationGuard(window.webContents, target)
  const fire = (channel: string, url: string) => {
    let blocked = false
    window.webContents.emit(channel, { url, preventDefault: () => { blocked = true } })
    return blocked
  }
  assert.equal(fire('will-navigate', 'https://evil.example/'), true)
  assert.equal(fire('will-navigate', 'http://127.0.0.1:5174/'), true)
  assert.equal(fire('will-navigate', target), false)
  assert.equal(fire('will-redirect', 'https://evil.example/'), true)
  const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8')
  assert.match(source, /installMainWindowNavigationGuard\(mainWindow\.webContents, trustedRendererUrl\)/)
  assert.ok(source.indexOf('installMainWindowNavigationGuard(mainWindow.webContents, trustedRendererUrl)') < source.indexOf('mainWindow.loadURL('))
  assert.ok(source.indexOf('installMainWindowNavigationGuard(mainWindow.webContents, trustedRendererUrl)') < source.indexOf('mainWindow.loadFile('))
  assert.match(source, /resolveRendererDocumentUrl\(is\.dev, process\.env\['ELECTRON_RENDERER_URL'\],/)
})

test('same-URL main-frame reload changes document epoch, but in-document navigation does not', () => {
  const url = 'http://127.0.0.1:5173/'
  const window = windowFor(url)
  installMainWindowNavigationGuard(window.webContents, url)
  const before = getMainWindowDocumentEpoch(window.webContents)
  window.webContents.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: true })
  window.webContents.emit('did-start-navigation', { url, isMainFrame: false, isSameDocument: false })
  assert.equal(getMainWindowDocumentEpoch(window.webContents), before)
  window.webContents.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false })
  assert.equal(getMainWindowDocumentEpoch(window.webContents), before + 1)
})

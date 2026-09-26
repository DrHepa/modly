import { pathToFileURL } from 'node:url'

type NavigationEvent = { url: string; preventDefault(): void }
type NavigationContents = {
  on(channel: 'will-navigate' | 'will-redirect', listener: (event: NavigationEvent) => void): unknown
  on(channel: 'did-start-navigation', listener: (event: { isMainFrame: boolean; isSameDocument: boolean }) => void): unknown
}
const documentEpochs = new WeakMap<object, number>()

export function getMainWindowDocumentEpoch(contents: object): number { return documentEpochs.get(contents) ?? 0 }
export type WorldsCliWindowLike = {
  isDestroyed(): boolean
  webContents: {
    mainFrame: { url: string; origin: string }
    getURL(): string
  }
}

/** One exact document, selected using the same dev/packaged branch as the main window load. */
export function resolveRendererDocumentUrl(dev: boolean, rendererUrl: string | undefined, htmlPath: string): string {
  return dev && rendererUrl ? new URL(rendererUrl).href : pathToFileURL(htmlPath).href
}

/** Electron documents will-navigate as cancellable for renderer-initiated main-frame navigation. */
export function installMainWindowNavigationGuard(contents: NavigationContents, trustedRendererUrl: string): void {
  const guard = (event: NavigationEvent): void => {
    if (event.url !== trustedRendererUrl) event.preventDefault()
  }
  contents.on('will-navigate', guard)
  contents.on('will-redirect', guard)
  contents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) documentEpochs.set(contents, getMainWindowDocumentEpoch(contents) + 1)
  })
}

/** Frame identity alone is insufficient: verify the exact loaded document and its serialized origin. */
export function isTrustedWorldsCliSender(event: unknown, window: WorldsCliWindowLike | null, trustedRendererUrl: string): boolean {
  if (!window || window.isDestroyed() || !event || typeof event !== 'object') return false
  const sender = event as { sender?: unknown; senderFrame?: unknown }
  const contents = window.webContents
  const frame = contents.mainFrame
  let origin: string
  try { origin = new URL(trustedRendererUrl).origin } catch { return false }
  return sender.sender === contents && sender.senderFrame === frame
    && frame.url === trustedRendererUrl && frame.origin === origin
    && contents.getURL() === trustedRendererUrl
}

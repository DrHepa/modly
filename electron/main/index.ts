import { app, BrowserWindow, shell, session } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { setupIpcHandlers, type IpcHandlersLifecycle } from './ipc-handlers'
import { AutomationHttpBridge } from './automation-http-bridge'
import { PythonBridge } from './python-bridge'
import { logger, archiveCurrentSession } from './logger'
import { initAutoUpdater } from './updater'
import { syncBuiltinExtensions } from './builtin-sync'
import { installMainWindowNavigationGuard, resolveRendererDocumentUrl } from './worlds-cli-window-trust'

const rendererHtmlPath = join(__dirname, '../renderer/index.html')
const trustedRendererUrl = resolveRendererDocumentUrl(is.dev, process.env['ELECTRON_RENDERER_URL'], rendererHtmlPath)

let mainWindow: BrowserWindow | null = null
let pythonBridge: PythonBridge | null = null
let automationHttpBridge: AutomationHttpBridge | null = null
let ipcHandlersLifecycle: IpcHandlersLifecycle | null = null
let ipcHandlersSetup: Promise<IpcHandlersLifecycle> | null = null
let isQuitting = false

// When the launching terminal closes, stdout/stderr become broken pipes and
// every console.* write emits an unhandled 'error' (EPIPE) that would loop
// through the uncaughtException handler forever. Swallow stream errors.
process.stdout?.on('error', () => {})
process.stderr?.on('error', () => {})

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: '#111113',
    titleBarStyle: 'hidden',
    icon: join(__dirname, '../../resources/icons/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // Keep the renderer's maximize/restore icon in sync — covers the toolbar
  // button, double-clicking the title bar, and OS window-snap gestures.
  mainWindow.on('maximize',   () => mainWindow?.webContents.send('window:maximizeChanged', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximizeChanged', false))

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isMacQuitShortcut =
      process.platform === 'darwin' &&
      input.type === 'keyDown' &&
      input.key.toLowerCase() === 'q' &&
      input.meta &&
      !input.control &&
      !input.alt

    if (isMacQuitShortcut) {
      event.preventDefault()
      app.quit()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  installMainWindowNavigationGuard(mainWindow.webContents, trustedRendererUrl)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(trustedRendererUrl)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(rendererHtmlPath)
  }
}

app.setName('Modly')

process.on('uncaughtException', (err) => {
  if ((err as NodeJS.ErrnoException).code === 'EPIPE') return
  logger.error(`Uncaught exception: ${err.stack ?? err.message}`)
  mainWindow?.webContents.send('app:error', err.stack ?? err.message)
})

process.on('unhandledRejection', (reason) => {
  const msg = String(reason)
  logger.error(`Unhandled rejection: ${msg}`)
  mainWindow?.webContents.send('app:error', msg)
})

app.whenReady().then(async () => {
  archiveCurrentSession()
  logger.info(`App started — version ${app.getVersion()}`)
  electronApp.setAppUserModelId('com.modly.app')

  // Clear Chromium disk cache on startup to recover from any corruption
  await session.defaultSession.clearCache()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Sync built-in extensions from app resources to userData
  syncBuiltinExtensions()

  // Start Python FastAPI backend
  pythonBridge = new PythonBridge()
  pythonBridge.setWindowGetter(() => mainWindow)
  ipcHandlersSetup = setupIpcHandlers(pythonBridge, () => mainWindow, trustedRendererUrl)
  const configuredIpcLifecycle = await ipcHandlersSetup
  if (isQuitting) {
    await configuredIpcLifecycle.shutdown()
    return
  }
  ipcHandlersLifecycle = configuredIpcLifecycle
  ipcHandlersSetup = null
  automationHttpBridge = new AutomationHttpBridge()
  void automationHttpBridge.start().catch((error) => {
    logger.warn(`Automation HTTP bridge failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  })
  initAutoUpdater(() => mainWindow)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Modly holds a multi-GB Python subprocess; leaving it running in the
  // Dock after the window closes (the Mac default) is the wrong behavior
  // for this app. Closing the window means quit.
  app.quit()
})

app.on('before-quit', (event) => {
  if (isQuitting || (!pythonBridge && !automationHttpBridge && !ipcHandlersLifecycle && !ipcHandlersSetup)) return

  event.preventDefault()

  isQuitting = true
  const ipcShutdown = ipcHandlersLifecycle
    ? ipcHandlersLifecycle.shutdown()
    : ipcHandlersSetup?.then((lifecycle) => lifecycle.shutdown())

  void Promise.allSettled([
    ipcShutdown?.catch((error) => {
      logger.warn(`IPC lifecycle failed to stop cleanly: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    }),
    automationHttpBridge?.stop().catch((error) => {
      logger.warn(`Automation HTTP bridge failed to stop cleanly: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    }),
    pythonBridge?.stop().catch((error) => {
      logger.warn(`Python bridge failed to stop cleanly: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    }),
  ]).finally(() => {
    automationHttpBridge = null
    pythonBridge = null
    ipcHandlersLifecycle = null
    ipcHandlersSetup = null
    app.quit()
  })
})

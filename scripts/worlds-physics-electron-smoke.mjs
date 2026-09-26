import { access, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow } from 'electron'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))
const rendererDir = join(rootDir, 'out', 'renderer')
const rendererIndex = join(rendererDir, 'index.html')
const rendererAssets = join(rendererDir, 'assets')
const workerPattern = /^worldPhysics\.worker-[A-Za-z0-9_-]+\.js$/
const appReadyTimeoutMs = 3_000
const rendererLoadTimeoutMs = 5_000
const workerReadyTimeoutMs = 5_000
const processTimeoutMs = 15_000

let window = null
let exitCode = 1

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox')

const watchdog = setTimeout(() => {
  console.error(`[worlds-physics-electron-smoke] FAIL: Process exceeded ${processTimeoutMs} ms.`)
  app.exit(1)
}, processTimeoutMs)

void runSmoke().then(
  ({ workerFile }) => {
    console.log(`[worlds-physics-electron-smoke] PASS: ${workerFile} reported ready for electron-smoke.`)
    exitCode = 0
  },
  (error) => {
    console.error(`[worlds-physics-electron-smoke] FAIL: ${formatError(error)}`)
  },
).then(shutdown)

async function runSmoke() {
  const workerFile = await findBuiltWorker()
  await withTimeout(
    app.whenReady(),
    appReadyTimeoutMs,
    `Electron app did not become ready within ${appReadyTimeoutMs} ms.`,
  )

  window = new BrowserWindow({
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'worlds-physics-electron-smoke',
      sandbox: false,
    },
  })

  const rendererFailure = new Promise((_, reject) => {
    window.webContents.once('render-process-gone', (_event, details) => {
      reject(new Error(`Renderer exited before the physics Worker became ready (${details.reason}).`))
    })
    window.once('unresponsive', () => {
      reject(new Error('Renderer became unresponsive before the physics Worker became ready.'))
    })
  })

  await withTimeout(
    Promise.race([window.loadFile(rendererIndex), rendererFailure]),
    rendererLoadTimeoutMs,
    `Built renderer index did not finish loading within ${rendererLoadTimeoutMs} ms.`,
  )

  const workerResult = await withTimeout(
    Promise.race([
      window.webContents.executeJavaScript(createRendererSmokeSource(workerFile), true),
      rendererFailure,
    ]),
    workerReadyTimeoutMs + 1_000,
    `Main process timed out after ${workerReadyTimeoutMs + 1_000} ms.`,
  )

  if (workerResult !== 'ready:electron-smoke') {
    throw new Error(`Unexpected smoke result: ${String(workerResult)}`)
  }

  return { workerFile }
}

function shutdown() {
  clearTimeout(watchdog)
  if (window && !window.isDestroyed()) window.destroy()
  app.quit()
  if (exitCode !== 0) app.exit(exitCode)
}

async function findBuiltWorker() {
  await access(rendererIndex)
  const entries = await readdir(rendererAssets, { withFileTypes: true })
  const workerFiles = entries
    .filter((entry) => entry.isFile() && workerPattern.test(entry.name))
    .map((entry) => entry.name)
    .sort()

  if (workerFiles.length !== 1) {
    throw new Error(`Expected exactly one built Worlds physics Worker, found ${workerFiles.length}.`)
  }
  return workerFiles[0]
}

function createRendererSmokeSource(workerFile) {
  const workerRelativeUrl = `./assets/${workerFile}`
  return `new Promise((resolve, reject) => {
    const worker = new Worker(new URL(${JSON.stringify(workerRelativeUrl)}, document.baseURI), {
      name: 'worlds-physics-electron-smoke',
      type: 'module',
    });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.terminate();
      if (error) reject(new Error(error));
      else resolve(value);
    };
    const timeout = setTimeout(() => {
      finish('Physics Worker did not report ready within ${workerReadyTimeoutMs} ms.');
    }, ${workerReadyTimeoutMs});

    worker.addEventListener('error', (event) => {
      event.preventDefault();
      finish('Physics Worker error: ' + (event.message || 'unknown module Worker failure.'));
    });
    worker.addEventListener('messageerror', () => {
      finish('Physics Worker messageerror before ready.');
    });
    worker.addEventListener('message', (event) => {
      const message = event.data;
      if (message && message.version === 1 && message.kind === 'error') {
        finish('Physics Worker protocol error: ' + message.code + ': ' + message.message);
        return;
      }
      if (!message || message.version !== 1 || message.kind !== 'ready'
        || message.generationId !== 1 || !Array.isArray(message.entityIds)
        || message.entityIds.length !== 0) {
        finish('Physics Worker returned an unexpected message before ready.');
        return;
      }
      finish(null, 'ready:electron-smoke');
    });

    worker.postMessage({
      version: 1,
      kind: 'init',
      generationId: 1,
      scene: {
        sceneId: 'electron-smoke',
        gravity: [0, -9.81, 0],
        bodies: [],
      },
    });
  })`
}

function withTimeout(promise, milliseconds, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), milliseconds)
    promise.then((value) => {
      clearTimeout(timeout)
      resolve(value)
    }, (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error)
}

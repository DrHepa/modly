import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'

let loopbackListenSupport

function listenOnLoopback(server, port) {
  return new Promise((resolvePromise, rejectPromise) => {
    const cleanup = () => {
      server.off('listening', onListening)
      server.off('error', onError)
    }
    const onListening = () => {
      cleanup()
      resolvePromise()
    }
    const onError = (error) => {
      cleanup()
      rejectPromise(error)
    }

    server.once('listening', onListening)
    server.once('error', onError)
    try {
      server.listen(port, '127.0.0.1')
    } catch (error) {
      cleanup()
      rejectPromise(error)
    }
  })
}

function closeListeningServer(server) {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => error ? rejectPromise(error) : resolvePromise())
  })
}

async function probeLoopbackListenSupport() {
  const server = createServer()
  try {
    await listenOnLoopback(server, 0)
    return true
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') return false
    throw error
  } finally {
    await closeListeningServer(server)
  }
}

function canListenOnLoopback() {
  return loopbackListenSupport ??= probeLoopbackListenSupport()
}

function ownershipTest(name, body) {
  test(name, async (t) => {
    if (!(await canListenOnLoopback())) {
      t.skip('IPv4 loopback listeners are unavailable on this test host.')
      return
    }

    await body(t)
  })
}

const require = createRequire(import.meta.url)
const root = mkdtempSync(join(tmpdir(), 'modly-python-bridge-ownership-'))
const fakePython = join(root, 'fake-python')
const fakeRunner = join(root, 'fake-runner.js')
writeFileSync(fakeRunner, `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\n`)
writeFileSync(fakePython, `#!/usr/bin/env node
const http = require('node:http')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const port = 8765
const delayMs = Number(process.env.MODLY_TEST_READY_DELAY_MS || 0)
if (process.env.MODLY_TEST_PID_FILE) fs.writeFileSync(process.env.MODLY_TEST_PID_FILE, String(process.pid))
if (process.env.MODLY_TEST_RUNNER_PID_FILE) {
  const runnerEnv = { ...process.env }
  if (process.env.MODLY_TEST_RUNNER_CLEAR_MARKER === '1') delete runnerEnv.MODLY_BRIDGE_LAUNCH_ID
  const runner = spawn(process.execPath, [process.env.MODLY_TEST_RUNNER_SCRIPT], { stdio: 'ignore', env: runnerEnv })
  fs.writeFileSync(process.env.MODLY_TEST_RUNNER_PID_FILE, String(runner.pid))
}
setTimeout(() => {
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ status: 'ok', bridge_instance: process.env.MODLY_BRIDGE_LAUNCH_ID || '' }))
  })
  server.listen(port, '127.0.0.1')
  process.on('SIGTERM', () => {
    if (process.env.MODLY_TEST_IGNORE_TERM === '1') return
    server.close(() => process.exit(0))
  })
}, delayMs)
`, { mode: 0o700 })

const fakeModules = {
  child_process: `export const spawn = (...args) => {
    const child = require('node:child_process').spawn(...args)
    globalThis.__bridgeTestSpawned?.push(child)
    return child
  }`,
  electron: `export const app = { getPath: () => globalThis.__bridgeTestRoot, getAppPath: () => ${JSON.stringify(resolve('.'))}, isPackaged: false }`,
  './settings-store': `export const getSettings = () => ({ modelsDir: globalThis.__bridgeTestRoot, workspaceDir: globalThis.__bridgeTestRoot, extensionsDir: globalThis.__bridgeTestRoot, hfToken: '' })`,
  './logger': `export const logger = { python() {} }`,
  './python-setup': `export const cleanPythonEnv = () => ({ ...process.env }); export const getVenvPythonExe = () => globalThis.__bridgeTestPython`,
  'fs/promises': `export const readFile = (...args) => {
    if (globalThis.__bridgeTestDenyProc && String(args[0]).startsWith('/proc/')) throw Object.assign(new Error('test-denied proc'), { code: 'EACCES' })
    return require('node:fs/promises').readFile(...args)
  }; export const readdir = (...args) => {
    if (globalThis.__bridgeTestDenyProc && String(args[0]) === '/proc') throw Object.assign(new Error('test-denied proc'), { code: 'EACCES' })
    return require('node:fs/promises').readdir(...args)
  }`,
}
const built = await build({
  entryPoints: [resolve('electron/main/python-bridge.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  plugins: [{
    name: 'test-dependencies',
    setup(build) {
      build.onResolve({ filter: /^(electron|\.\/settings-store|\.\/logger|\.\/python-setup|fs\/promises|child_process)$/ }, ({ path }) => ({ path, namespace: 'bridge-test' }))
      build.onLoad({ filter: /.*/, namespace: 'bridge-test' }, ({ path }) => ({ contents: fakeModules[path], loader: 'js' }))
    },
  }],
})
const module = { exports: {} }
new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports)
const { PythonBridge } = module.exports
globalThis.__bridgeTestRoot = root
globalThis.__bridgeTestPython = fakePython

async function waitForLine(child, expected) {
  await Promise.race([
    new Promise((resolvePromise, rejectPromise) => {
      child.stdout.once('data', (chunk) => {
        if (String(chunk).includes(expected)) resolvePromise()
        else rejectPromise(new Error(`Unexpected child output: ${chunk}`))
      })
      child.once('error', rejectPromise)
      child.once('exit', (code) => rejectPromise(new Error(`Child exited before ${expected}: ${code}`)))
    }),
    delay(3_000).then(() => { throw new Error(`Timed out waiting for ${expected}`) }),
  ])
}

async function stopTestChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolvePromise) => child.once('exit', resolvePromise)),
    delay(3_000).then(() => { throw new Error('Test-owned child did not stop') }),
  ])
}

function waitForTrackedChildExit(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    const onExit = () => {
      clearTimeout(timeout)
      resolvePromise()
    }
    const timeout = setTimeout(() => {
      child.off('exit', onExit)
      rejectPromise(new Error('Tracked bridge child did not exit during cleanup'))
    }, 3_000)
    timeout.unref()
    child.once('exit', onExit)
  })
}

async function stopBridgeAndCleanupTrackedChildren(bridge, children) {
  const failures = []
  try { await bridge.stop() } catch (error) { failures.push(error) }
  for (const child of children) {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      if (child.exitCode === null && child.signalCode === null) {
        await waitForTrackedChildExit(child)
      }
      assert.equal(
        child.exitCode === null && child.signalCode === null,
        false,
        'Tracked bridge child must reach an exit state during cleanup',
      )
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Bridge stop and tracked-child cleanup failed')
}

async function waitForFile(path) {
  for (let i = 0; i < 120; i++) {
    if (existsSync(path)) return
    await delay(25)
  }
  throw new Error(`Timed out waiting for test-owned child file: ${path}`)
}

function fixtureProcessAlive(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(') ') + 2, stat.lastIndexOf(') ') + 3) !== 'Z'
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function waitForFixtureExit(pid) {
  for (let i = 0; i < 120; i++) {
    if (!fixtureProcessAlive(pid)) return
    await delay(25)
  }
  throw new Error(`Test-owned process ${pid} did not exit`)
}

async function cleanupFixturePid(pid, marker) {
  if (!pid || !fixtureProcessAlive(pid)) return
  const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
  assert.ok(command.includes(marker), 'Refusing to signal a PID without the test-owned executable marker')
  process.kill(pid, 'SIGKILL')
  await waitForFixtureExit(pid)
}

test.after(() => rmSync(root, { recursive: true, force: true }))

test('tracked-child cleanup propagates an unexpected bridge stop failure after reaping children', async () => {
  const cleanupError = new Error('cleanup regression')
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  let killed = false
  child.kill = (signal) => {
    killed = true
    queueMicrotask(() => {
      child.signalCode = signal
      child.emit('exit', null, signal)
    })
    return true
  }

  await assert.rejects(
    stopBridgeAndCleanupTrackedChildren({ stop: async () => { throw cleanupError } }, [child]),
    (error) => error === cleanupError,
  )
  assert.equal(killed, true)
  assert.equal(child.signalCode, 'SIGKILL')
})

ownershipTest('occupied 127.0.0.1:8765 fails safely without signaling the test-owned listener', async () => {
  const blocker = childProcess.spawn(process.execPath, ['-e', `
    const net = require('node:net')
    const server = net.createServer((socket) => socket.end())
    server.listen(8765, '127.0.0.1', () => process.stdout.write('BOUND\\n'))
    process.on('SIGTERM', () => server.close(() => process.exit(0)))
  `], { stdio: ['ignore', 'pipe', 'pipe'] })
  const realExecSync = childProcess.execSync
  const attemptedCommands = []
  try {
    await waitForLine(blocker, 'BOUND')
    // RED must not execute the old destructive command even against this test-owned PID.
    childProcess.execSync = (command) => { attemptedCommands.push(String(command)); throw new Error('Blocked destructive test command') }
    const bridge = new PythonBridge()
    await assert.rejects(bridge.start(), /port 8765.*(occupied|in use)/i)
    assert.deepEqual(attemptedCommands, [])
    assert.equal(blocker.exitCode, null)
    await bridge.stop()
  } finally {
    childProcess.execSync = realExecSync
    await stopTestChild(blocker)
  }
})

ownershipTest('concurrent startup and shutdown settle without leaving the owned child listening', async () => {
  const previousDelay = process.env.MODLY_TEST_READY_DELAY_MS
  process.env.MODLY_TEST_READY_DELAY_MS = '600'
  const bridge = new PythonBridge()
  try {
    const starting = bridge.start()
    const stopping = bridge.stop()
    await assert.rejects(starting, /stop|cancel|abort/i)
    await stopping
    assert.equal(bridge.isReady(), false)
    const restarted = new PythonBridge()
    process.env.MODLY_TEST_READY_DELAY_MS = '0'
    await restarted.start()
    assert.equal(restarted.isReady(), true)
    await restarted.stop()
  } finally {
    if (previousDelay === undefined) delete process.env.MODLY_TEST_READY_DELAY_MS
    else process.env.MODLY_TEST_READY_DELAY_MS = previousDelay
    await bridge.stop()
  }
})

ownershipTest('shutdown during a spawned but not-yet-ready child cancels and reaps that child', async () => {
  const pidFile = join(root, 'cancelled-owned-pid')
  const previousDelay = process.env.MODLY_TEST_READY_DELAY_MS
  const previousPidFile = process.env.MODLY_TEST_PID_FILE
  process.env.MODLY_TEST_READY_DELAY_MS = '1500'
  process.env.MODLY_TEST_PID_FILE = pidFile
  const bridge = new PythonBridge()
  try {
    const starting = bridge.start()
    const startRejected = assert.rejects(starting, /cancelled by shutdown/i)
    await waitForFile(pidFile)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    await bridge.stop()
    await startRejected
    assert.equal(bridge.isReady(), false)
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  } finally {
    if (previousDelay === undefined) delete process.env.MODLY_TEST_READY_DELAY_MS
    else process.env.MODLY_TEST_READY_DELAY_MS = previousDelay
    if (previousPidFile === undefined) delete process.env.MODLY_TEST_PID_FILE
    else process.env.MODLY_TEST_PID_FILE = previousPidFile
    await bridge.stop()
  }
})

ownershipTest('a foreign health response in the bind race cannot be accepted as the owned backend', async () => {
  const pidFile = join(root, 'racing-owned-pid')
  const previousDelay = process.env.MODLY_TEST_READY_DELAY_MS
  const previousPidFile = process.env.MODLY_TEST_PID_FILE
  process.env.MODLY_TEST_READY_DELAY_MS = '1500'
  process.env.MODLY_TEST_PID_FILE = pidFile
  const bridge = new PythonBridge()
  const decoy = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ status: 'ok', bridge_instance: 'foreign' }))
  })
  try {
    const starting = bridge.start()
    const startRejected = assert.rejects(starting, /port 8765 is occupied by a different service/i)
    await waitForFile(pidFile) // The initial availability probe has closed.
    await new Promise((resolvePromise, rejectPromise) => {
      decoy.once('error', rejectPromise)
      decoy.listen(8765, '127.0.0.1', resolvePromise)
    })
    await startRejected
    assert.equal(bridge.isReady(), false)
  } finally {
    await bridge.stop()
    await new Promise((resolvePromise) => decoy.close(resolvePromise))
    if (previousDelay === undefined) delete process.env.MODLY_TEST_READY_DELAY_MS
    else process.env.MODLY_TEST_READY_DELAY_MS = previousDelay
    if (previousPidFile === undefined) delete process.env.MODLY_TEST_PID_FILE
    else process.env.MODLY_TEST_PID_FILE = previousPidFile
  }
})

ownershipTest('shutdown escalates its unresponsive owned group after a grace period', async () => {
  const pidFile = join(root, 'unresponsive-owned-pid')
  const previousPidFile = process.env.MODLY_TEST_PID_FILE
  const previousIgnore = process.env.MODLY_TEST_IGNORE_TERM
  process.env.MODLY_TEST_PID_FILE = pidFile
  process.env.MODLY_TEST_IGNORE_TERM = '1'
  const bridge = new PythonBridge()
  try {
    await bridge.start()
    const pid = Number(readFileSync(pidFile, 'utf8'))
    const began = Date.now()
    await bridge.stop()
    assert.equal(bridge.isReady(), false)
    assert.ok(Date.now() - began >= 1_400, 'SIGTERM grace period was not observed')
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  } finally {
    if (previousPidFile === undefined) delete process.env.MODLY_TEST_PID_FILE
    else process.env.MODLY_TEST_PID_FILE = previousPidFile
    if (previousIgnore === undefined) delete process.env.MODLY_TEST_IGNORE_TERM
    else process.env.MODLY_TEST_IGNORE_TERM = previousIgnore
    await bridge.stop()
  }
})

ownershipTest('stop reaps a blocked test-owned extension runner after the API parent exits', async () => {
  if (process.platform !== 'linux') return
  const runnerPidFile = join(root, 'owned-runner-pid')
  const previousRunnerFile = process.env.MODLY_TEST_RUNNER_PID_FILE
  const previousRunnerScript = process.env.MODLY_TEST_RUNNER_SCRIPT
  process.env.MODLY_TEST_RUNNER_PID_FILE = runnerPidFile
  process.env.MODLY_TEST_RUNNER_SCRIPT = fakeRunner
  const bridge = new PythonBridge()
  let runnerPid = 0
  try {
    await bridge.start()
    await waitForFile(runnerPidFile)
    runnerPid = Number(readFileSync(runnerPidFile, 'utf8'))
    assert.equal(fixtureProcessAlive(runnerPid), true)
    await bridge.stop()
    await waitForFixtureExit(runnerPid)
  } finally {
    if (previousRunnerFile === undefined) delete process.env.MODLY_TEST_RUNNER_PID_FILE
    else process.env.MODLY_TEST_RUNNER_PID_FILE = previousRunnerFile
    if (previousRunnerScript === undefined) delete process.env.MODLY_TEST_RUNNER_SCRIPT
    else process.env.MODLY_TEST_RUNNER_SCRIPT = previousRunnerScript
    await bridge.stop()
    await cleanupFixturePid(runnerPid, fakeRunner)
  }
})

ownershipTest('restart reaps the old owned runner even if its API parent exited first', async () => {
  if (process.platform !== 'linux') return
  const parentPidFile = join(root, 'restart-parent-pid')
  const runnerPidFile = join(root, 'restart-runner-pid')
  const prior = {
    parent: process.env.MODLY_TEST_PID_FILE,
    runner: process.env.MODLY_TEST_RUNNER_PID_FILE,
    script: process.env.MODLY_TEST_RUNNER_SCRIPT,
  }
  process.env.MODLY_TEST_PID_FILE = parentPidFile
  process.env.MODLY_TEST_RUNNER_PID_FILE = runnerPidFile
  process.env.MODLY_TEST_RUNNER_SCRIPT = fakeRunner
  const bridge = new PythonBridge()
  let oldRunner = 0
  let newRunner = 0
  try {
    await bridge.start()
    oldRunner = Number(readFileSync(runnerPidFile, 'utf8'))
    const parentPid = Number(readFileSync(parentPidFile, 'utf8'))
    process.kill(parentPid, 'SIGTERM') // Verified test-owned direct child from this launch.
    for (let i = 0; i < 120 && bridge.isReady(); i++) await delay(25)
    assert.equal(bridge.isReady(), false)
    assert.equal(fixtureProcessAlive(oldRunner), true)
    await bridge.restart()
    await waitForFixtureExit(oldRunner)
    newRunner = Number(readFileSync(runnerPidFile, 'utf8'))
    assert.notEqual(newRunner, oldRunner)
    assert.equal(fixtureProcessAlive(newRunner), true)
    await bridge.stop()
    await waitForFixtureExit(newRunner)
  } finally {
    for (const [key, value] of Object.entries({
      MODLY_TEST_PID_FILE: prior.parent,
      MODLY_TEST_RUNNER_PID_FILE: prior.runner,
      MODLY_TEST_RUNNER_SCRIPT: prior.script,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await bridge.stop()
    await cleanupFixturePid(oldRunner, fakeRunner)
    await cleanupFixturePid(newRunner, fakeRunner)
  }
})

ownershipTest('an unmarked survivor cannot authorize a group signal after the parent exits', async () => {
  if (process.platform !== 'linux') return
  const parentPidFile = join(root, 'unmarked-parent-pid')
  const runnerPidFile = join(root, 'unmarked-runner-pid')
  const prior = {
    parent: process.env.MODLY_TEST_PID_FILE,
    runner: process.env.MODLY_TEST_RUNNER_PID_FILE,
    script: process.env.MODLY_TEST_RUNNER_SCRIPT,
    clear: process.env.MODLY_TEST_RUNNER_CLEAR_MARKER,
  }
  process.env.MODLY_TEST_PID_FILE = parentPidFile
  process.env.MODLY_TEST_RUNNER_PID_FILE = runnerPidFile
  process.env.MODLY_TEST_RUNNER_SCRIPT = fakeRunner
  process.env.MODLY_TEST_RUNNER_CLEAR_MARKER = '1'
  const bridge = new PythonBridge()
  const realKill = process.kill
  let groupSignals = 0
  let runnerPid = 0
  try {
    await bridge.start()
    runnerPid = Number(readFileSync(runnerPidFile, 'utf8'))
    process.kill(Number(readFileSync(parentPidFile, 'utf8')), 'SIGTERM')
    for (let i = 0; i < 120 && bridge.isReady(); i++) await delay(25)
    assert.equal(bridge.isReady(), false)
    process.kill = (target, signal) => {
      if (target < 0 && signal !== 0) groupSignals++
      return realKill(target, signal)
    }
    await assert.rejects(bridge.stop(), /no owned live member could be verified/i)
    assert.equal(groupSignals, 0)
    assert.equal(fixtureProcessAlive(runnerPid), true)
  } finally {
    process.kill = realKill
    for (const [key, value] of Object.entries({
      MODLY_TEST_PID_FILE: prior.parent,
      MODLY_TEST_RUNNER_PID_FILE: prior.runner,
      MODLY_TEST_RUNNER_SCRIPT: prior.script,
      MODLY_TEST_RUNNER_CLEAR_MARKER: prior.clear,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await cleanupFixturePid(runnerPid, fakeRunner)
    await bridge.stop()
  }
})

ownershipTest('unreadable proc metadata fails before launch without leaving an unmanaged child', async () => {
  if (process.platform !== 'linux') return
  const pidFile = join(root, 'unreadable-proc-pid')
  const previousPidFile = process.env.MODLY_TEST_PID_FILE
  process.env.MODLY_TEST_PID_FILE = pidFile
  globalThis.__bridgeTestDenyProc = true
  globalThis.__bridgeTestSpawned = []
  const bridge = new PythonBridge()
  try {
    await assert.rejects(bridge.start(), /process identity|proc metadata/i)
    assert.equal(globalThis.__bridgeTestSpawned.length, 0, 'No backend should launch when proc metadata is unavailable')
  } finally {
    globalThis.__bridgeTestDenyProc = false
    if (previousPidFile === undefined) delete process.env.MODLY_TEST_PID_FILE
    else process.env.MODLY_TEST_PID_FILE = previousPidFile
    const trackedChildren = globalThis.__bridgeTestSpawned
    try {
      await stopBridgeAndCleanupTrackedChildren(bridge, trackedChildren)
    } finally {
      delete globalThis.__bridgeTestSpawned
    }
  }
})

ownershipTest('proc access lost after launch never causes an unverified group signal', async () => {
  if (process.platform !== 'linux') return
  const pidFile = join(root, 'proc-lost-parent-pid')
  const previousPidFile = process.env.MODLY_TEST_PID_FILE
  process.env.MODLY_TEST_PID_FILE = pidFile
  const bridge = new PythonBridge()
  const realKill = process.kill
  let groupSignals = 0
  try {
    await bridge.start()
    const pid = Number(readFileSync(pidFile, 'utf8'))
    globalThis.__bridgeTestDenyProc = true
    process.kill = (target, signal) => {
      if (target < 0) groupSignals++
      return realKill(target, signal)
    }
    await assert.rejects(bridge.stop(), /verify owned FastAPI process-group metadata/i)
    assert.equal(groupSignals, 0)
    await waitForFixtureExit(pid)
  } finally {
    process.kill = realKill
    globalThis.__bridgeTestDenyProc = false
    if (previousPidFile === undefined) delete process.env.MODLY_TEST_PID_FILE
    else process.env.MODLY_TEST_PID_FILE = previousPidFile
    await bridge.stop()
  }
})

ownershipTest('an exited owned child is not signaled by a later stop and a fresh launch can recover', async () => {
  const bridge = new PythonBridge()
  await bridge.start()
  const pidFile = join(root, 'owned-pid')
  const previousPidFile = process.env.MODLY_TEST_PID_FILE
  try {
    await bridge.stop()
    process.env.MODLY_TEST_PID_FILE = pidFile
    await bridge.start()
    assert.equal(bridge.isReady(), true)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    process.kill(pid, 'SIGTERM') // This PID belongs to this test's direct child.
    for (let i = 0; i < 30 && bridge.isReady(); i++) await delay(25)
    assert.equal(bridge.isReady(), false)
    await bridge.stop()
    await bridge.start()
    assert.equal(bridge.isReady(), true)
  } finally {
    if (previousPidFile === undefined) delete process.env.MODLY_TEST_PID_FILE
    else process.env.MODLY_TEST_PID_FILE = previousPidFile
    await bridge.stop()
  }
})

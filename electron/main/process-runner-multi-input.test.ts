import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import type * as RunnerModule from './process-runner'

import type { ProcessInput } from '../../src/shared/types/electron.d'

// Same CPU-only adapter as the upstream runner suites: no real Electron process.
const require = createRequire(import.meta.url)
const runnerBundle = buildSync({ entryPoints: [new URL('./process-runner.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'] })
const runnerModule = { exports: {} }
vm.runInNewContext(runnerBundle.outputFiles[0].text, {
  module: runnerModule, exports: runnerModule.exports,
  require: (name: string) => name === 'electron' ? { app: { isPackaged: false, getAppPath: () => process.cwd() } } : require(name),
  process, console, Buffer, setTimeout, clearTimeout,
})
const { createRunScopedProcessRunner } = runnerModule.exports as typeof RunnerModule
const { runProcessExtensionWithDeps } = await import(new URL('./run-process-handler.ts', import.meta.url).href)
const { invokeExtensionsRunProcess } = await import(new URL('../preload/run-process-ipc.ts', import.meta.url).href)

const multiInputPayload: ProcessInput = {
  nodeId: 'refiner',
  inputs: {
    reference_image: {
      type: 'image',
      filePath: '/tmp/reference.png',
      sourceNodeId: 'image-source',
    },
    coarse_mesh: {
      type: 'mesh',
      filePath: '/tmp/coarse.glb',
      sourceNodeId: 'mesh-source',
    },
  },
}

test('invokeExtensionsRunProcess forwards multi-input payloads to ipcRenderer.invoke unchanged', async () => {
  const calls: unknown[][] = []
  const expectedResult = { success: true, result: { text: 'ok' } }

  const result = await invokeExtensionsRunProcess(
    async (...args: unknown[]) => {
      calls.push(args)
      return expectedResult
    },
    'mesh-tools',
    multiInputPayload,
    { strength: 0.75 },
  )

  assert.deepEqual(calls, [[
    'extensions:runProcess',
    'mesh-tools',
    multiInputPayload,
    { strength: 0.75 },
  ]])
  assert.deepEqual(result, expectedResult)
})

test('runProcessExtensionWithDeps passes multi-input payloads from IPC into the selected runner unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modly-run-process-handler-'))
  const builtinExtensionsDir = join(root, 'builtin')
  const userExtensionsDir = join(root, 'extensions')
  const workspaceDir = join(root, 'workspace')

  await mkdir(join(userExtensionsDir, 'mesh-tools'), { recursive: true })
  await writeFile(
    join(userExtensionsDir, 'mesh-tools', 'manifest.json'),
    JSON.stringify({ type: 'process', entry: 'processor.js' }),
    'utf8',
  )

  let capturedInput: ProcessInput | undefined
  let capturedParams: Record<string, unknown> | undefined

  try {
    const result = await runProcessExtensionWithDeps({
      extensionId: 'mesh-tools',
      input: multiInputPayload,
      params: { strength: 0.75 },
      getUserDataPath: () => join(root, 'user-data'),
      getTempPath: () => join(root, 'temp'),
      getSettings: () => ({
        extensionsDir: userExtensionsDir,
        workspaceDir,
      }),
      getBuiltinExtensionsDir: () => builtinExtensionsDir,
      getExtPythonExe: () => null,
      getVenvPythonExe: () => '/usr/bin/python3',
      getProcessRunner: () => ({
        run: async (input: ProcessInput, params: Record<string, unknown>) => {
          capturedInput = input
          capturedParams = params
          return { text: 'js-runner-ok' }
        },
        terminate: () => {},
      }),
      getPythonProcessRunner: () => {
        throw new Error('python runner should not be selected for JS entries')
      },
    })

    assert.deepEqual(capturedInput, multiInputPayload)
    assert.deepEqual(capturedParams, { strength: 0.75 })
    assert.deepEqual(result, { success: true, result: { text: 'js-runner-ok' } })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('createRunScopedProcessRunner preserves named inputs for JS processors', { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'modly-js-runner-'))
  const extDir = join(root, 'extension')
  await mkdir(extDir, { recursive: true })
  await writeFile(
    join(extDir, 'processor.js'),
    "module.exports = async function (input, params) { return { text: JSON.stringify({ input, params }) } }",
    'utf8',
  )

  const runner = createRunScopedProcessRunner({
    extDir,
    entry: 'processor.js',
    workspaceDir: join(root, 'workspace'),
    tempDir: join(root, 'temp'),
  })

  try {
    const result = await runner.run(multiInputPayload, { strength: 0.75 })

    assert.ok(result.text)
    assert.deepEqual(JSON.parse(result.text), {
      input: multiInputPayload,
      params: { strength: 0.75 },
    })
  } finally {
    runner.terminate()
    await rm(root, { recursive: true, force: true })
  }
})

test('createRunScopedProcessRunner preserves named inputs for Python processors', { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'modly-python-runner-'))
  const extDir = join(root, 'extension')
  await mkdir(extDir, { recursive: true })
  await writeFile(
    join(extDir, 'processor.py'),
    [
      'import json',
      'import sys',
      '',
      'request = json.loads(sys.stdin.readline())',
      "print(json.dumps({'type': 'done', 'result': {'text': json.dumps(request['input'])}}))",
    ].join('\n'),
    'utf8',
  )

  const runner = createRunScopedProcessRunner({
    extDir,
    entry: 'processor.py',
    workspaceDir: join(root, 'workspace'),
    tempDir: join(root, 'temp'),
    pythonExe: '/usr/bin/python3',
  })

  try {
    const result = await runner.run(multiInputPayload, { strength: 0.75 })

    assert.ok(result.text)
    assert.deepEqual(JSON.parse(result.text), multiInputPayload)
  } finally {
    runner.terminate()
    await rm(root, { recursive: true, force: true })
  }
})

test('the current preload factory forwards named and legacy payloads, preserving other API owners', async () => {
  const { createElectronApi } = await import('../preload/electron-api.ts')
  const calls: unknown[][] = []
  const api = createElectronApi({
    invoke: async (...args: unknown[]) => { calls.push(args); return { success: true, result: { text: 'ok' } } },
    send: () => {}, on: () => {}, removeAllListeners: () => {},
  }, { setZoomFactor: () => {} }, { getPathForFile: () => '' })
  for (const input of [multiInputPayload, { nodeId: 'legacy', filePath: '/mesh.glb', texts: [undefined, 'negative'] }]) {
    await api.extensions.runProcess('mesh-tools', input, {})
    assert.deepEqual(calls.pop(), ['extensions:runProcess', 'mesh-tools', input, {}])
  }
  assert.equal(typeof api.automation.capabilities, 'function')
  assert.equal(typeof api.model.download, 'function')
})

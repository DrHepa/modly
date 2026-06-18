import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildSync } from 'esbuild'
import { createRequire, register } from 'node:module'
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
// Use the same repository resolver as the existing capability service suite;
// native ESM preserves scene-import-service's import.meta authority.
register('../../scripts/node-ts-extensionless-loader.mjs', import.meta.url)
const { runProcessExtensionWithDeps } = await import('./run-process-handler.ts')
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
    world_scene: {
      type: 'scene',
      filePath: '/tmp/world.scene.json',
      sourceNodeId: 'scene-source',
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
  const input = { ...multiInputPayload, inputs: { reference_image: multiInputPayload.inputs!.reference_image, coarse_mesh: multiInputPayload.inputs!.coarse_mesh } }

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
      input,
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

    assert.deepEqual(capturedInput, input)
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

async function sceneHandlerFixture(run: (input: ProcessInput) => Promise<any>, node: NonNullable<import('./automation-capabilities').ParsedManifest['nodes']>[number] = { id: 'scene', input: 'scene', output: 'scene' }) {
  const root = await mkdtemp(join(tmpdir(), 'modly-scene-boundary-'))
  const workspace = join(root, 'workspace')
  const extDir = join(root, 'extensions', 'scene-tools')
  await mkdir(extDir, { recursive: true })
  await mkdir(join(workspace, 'input'), { recursive: true })
  await mkdir(join(workspace, 'output'), { recursive: true })
  const scene = { schema: 'modly.scene-manifest.v1', sceneRoot: '.', assets: [{ path: 'asset.bin' }] }
  for (const name of ['input', 'output']) {
    await writeFile(join(workspace, name, 'scene-manifest.json'), JSON.stringify(scene))
    await writeFile(join(workspace, name, 'asset.bin'), 'opaque fixture')
  }
  await writeFile(join(extDir, 'manifest.json'), JSON.stringify({ id: 'scene-tools', type: 'process', entry: 'processor.js', nodes: [node] }))
  const invoke = (input: ProcessInput = { nodeId: 'scene', filePath: join(workspace, 'input') }) => runProcessExtensionWithDeps({
    extensionId: 'scene-tools', input, params: { untouched: true },
    getUserDataPath: () => root, getTempPath: () => root,
    getSettings: () => ({ extensionsDir: join(root, 'extensions'), workspaceDir: workspace }),
    getBuiltinExtensionsDir: () => join(root, 'builtin'), getExtPythonExe: () => null, getVenvPythonExe: () => '/usr/bin/python3',
    getProcessRunner: () => ({ run, terminate() {} }), getPythonProcessRunner: () => { throw new Error('unexpected Python runner') },
  })
  return { root, workspace, invoke }
}

test('scene handler validates real input assets before worker and canonicalizes both boundaries', async () => {
  let calls = 0
  let captured: ProcessInput | undefined
  const f = await sceneHandlerFixture(async (input) => { calls++; captured = input; return { filePath: join(f.workspace, 'output') } })
  try {
    await rm(join(f.workspace, 'input', 'asset.bin'))
    const bad = await f.invoke()
    assert.equal(bad.success, false)
    assert.equal(calls, 0)
    await writeFile(join(f.workspace, 'input', 'asset.bin'), 'restored fixture')
    const good = await f.invoke()
    assert.equal(good.success, true, good.error)
    assert.equal(calls, 1)
    assert.equal(captured?.filePath, join(f.workspace, 'input', 'scene-manifest.json'))
    assert.equal(good.result?.filePath, join(f.workspace, 'output', 'scene-manifest.json'))
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('declared scene output requires explicit valid output and cannot borrow input or worker kind', async () => {
  let output: any = {}
  const f = await sceneHandlerFixture(async () => output)
  try {
    for (const value of [{}, { outputType: 'mesh', filePath: join(f.workspace, 'output') }, { filePath: join(f.workspace, 'missing') }]) {
      output = value
      assert.equal((await f.invoke()).success, false)
    }
    await rm(join(f.workspace, 'output', 'asset.bin'))
    output = { filePath: join(f.workspace, 'output'), outputType: 'scene' }
    assert.equal((await f.invoke()).success, false)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('scene handler enforces every physical scene slot, rejects spoofed selection and preserves opaque values', async () => {
  let captured: ProcessInput | undefined
  let calls = 0
  const f = await sceneHandlerFixture(async (input) => { calls++; captured = input; return { text: 'ok', outputType: 'opaque-kind' } },
    { id: 'scene', input: 'scene', inputs: ['scene', 'text', 'scene', 'capture'], output: 'capture' })
  try {
    const a = join(f.workspace, 'input'), b = join(f.workspace, 'output')
    const input: ProcessInput = { nodeId: 'scene', filePath: a, inputs: {
      'input-2': { type: 'scene', filePath: b, sourceNodeId: 'b' },
      'input-0': { type: 'scene', filePath: a, sourceNodeId: 'a' },
      'input-1': { type: 'text', text: 'combine', sourceNodeId: 'prompt' },
      'input-3': { type: 'capture', filePath: 'opaque://capture', sourceNodeId: 'capture' },
    } }
    const original = JSON.stringify(input)
    assert.equal((await f.invoke(input)).success, true)
    assert.equal(JSON.stringify(input), original)
    assert.equal(captured?.inputs?.['input-0'].filePath, join(a, 'scene-manifest.json'))
    assert.equal(captured?.inputs?.['input-2'].filePath, join(b, 'scene-manifest.json'))
    assert.deepEqual(captured?.inputs?.['input-3'], input.inputs!['input-3'])
    const before = calls
    const missing = { ...input, inputs: { ...input.inputs } }; delete missing.inputs['input-2']
    for (const invalid of [missing, { ...input, nodeId: 'unknown' }, { nodeId: 'scene', filePath: a },
      { ...input, inputs: { ...input.inputs, 'input-2': { type: 'image', filePath: b, sourceNodeId: 'bad' } } },
      { ...input, inputs: { ...input.inputs, unexpected: { type: 'scene', filePath: a, sourceNodeId: 'bad' } } }]) {
      assert.equal((await f.invoke(invalid)).success, false)
    }
    assert.equal(calls, before)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('scene handler uses complete named contract physical types and permits absent optional scene', async () => {
  let captured: ProcessInput | undefined
  const f = await sceneHandlerFixture(async (input) => { captured = input; return { text: 'ok' } }, {
    id: 'scene', inputs: ['scene', 'scene'], input_contract: [{ name: 'world', type: 'mesh' }, { name: 'optional', required: false }], output: 'text',
  })
  try {
    const input = { nodeId: 'scene', inputs: { world: { type: 'scene', filePath: join(f.workspace, 'input'), sourceNodeId: 'world-source' } } }
    assert.equal((await f.invoke(input)).success, true)
    assert.deepEqual(Object.keys(captured!), ['nodeId', 'inputs'])
    assert.deepEqual(captured?.inputs, { world: { ...input.inputs.world, filePath: join(f.workspace, 'input', 'scene-manifest.json') } })
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

for (const entry of ['processor.js', 'processor.py']) test(`real ${entry} worker round-trips two physical scene slots with a text slot hole`, { timeout: 5000 }, async () => {
  const f = await sceneHandlerFixture(async () => ({ text: 'unused' }))
  const extDir = join(f.root, 'extensions', 'scene-tools')
  await writeFile(join(extDir, entry), entry.endsWith('.js')
    ? 'module.exports = async (input) => ({text: JSON.stringify(input)})'
    : "import json,sys\np=json.loads(sys.stdin.readline())\nprint(json.dumps({'type':'done','result':{'text':json.dumps(p['input'])}}))\n")
  const runner = createRunScopedProcessRunner({ extDir, entry, workspaceDir: f.workspace, tempDir: join(f.root, 'temp'), pythonExe: '/usr/bin/python3' })
  const input: ProcessInput = { nodeId: 'scene', inputs: {
    'input-0': { type: 'scene', filePath: join(f.workspace, 'input', 'scene-manifest.json'), sourceNodeId: 'a' },
    'input-2': { type: 'scene', filePath: join(f.workspace, 'output', 'scene-manifest.json'), sourceNodeId: 'b' },
  } }
  try {
    assert.deepEqual(JSON.parse((await runner.run(input, {})).text!), input)
  } finally { runner.terminate(); await rm(f.root, { recursive: true, force: true }) }
})

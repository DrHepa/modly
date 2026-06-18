import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { ProcessInput } from '../../src/shared/types/electron.d'

const { createRunScopedProcessRunner } = await import(new URL('./process-runner.ts', import.meta.url).href)
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

test('createRunScopedProcessRunner preserves named inputs for JS processors', async () => {
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

test('createRunScopedProcessRunner preserves named inputs for Python processors', async () => {
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

import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { listAgentCapabilities, listVisibleExtensions } from './automation-capabilities.ts'
import { createSharedAgentCapabilityResolver } from './agent-capability-resolver.ts'
import { createDefaultAgentHostRuntimeRegistry } from './agent-host-runtime.ts'

type PythonTestManifest = {
  entry: string
  nodes: Array<{
    agent: {
      process: {
        runtime?: unknown
        runtimeFiles: string[]
      }
    }
  }>
}

async function fixture(withModelAccess = false) {
  const root = await mkdtemp(join(tmpdir(), 'modly-agent-python-discovery-'))
  const builtinDir = join(root, 'builtin')
  const userExtensionsDir = join(root, 'extensions')
  const extensionDir = join(userExtensionsDir, 'python-tools')
  const venvDir = join(extensionDir, 'venv')
  const baseInterpreter = join(root, 'trusted-python')
  await mkdir(builtinDir, { recursive: true })
  await mkdir(join(venvDir, 'bin'), { recursive: true })
  await mkdir(join(venvDir, 'lib'), { recursive: true })
  await writeFile(join(extensionDir, 'processor.py'), 'print("approved")\n')
  await writeFile(baseInterpreter, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  await symlink('python3', join(venvDir, 'bin', 'python'))
  await symlink('../../../../trusted-python', join(venvDir, 'bin', 'python3'))
  await symlink('lib', join(venvDir, 'lib64'))
  await writeFile(join(venvDir, 'pyvenv.cfg'), 'home = /usr\n')
  await writeFile(join(venvDir, 'lib', 'native.so'), 'native-v1')
  for (const path of [venvDir, join(venvDir, 'bin'), join(venvDir, 'lib')]) await chmod(path, 0o700)
  await chmod(join(venvDir, 'pyvenv.cfg'), 0o600)
  await chmod(join(venvDir, 'lib', 'native.so'), 0o600)
  await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify({
    id: 'python-tools', name: 'Python Tools', type: 'process', entry: 'processor.py',
    nodes: [{
      id: 'run', name: 'Run', input: 'text', output: 'text', params_schema: [],
      agent: {
        schema: 'modly.agent-capability-declaration.v1', capability_id: 'python-tools/run',
        display_name: 'Run Python', description: 'Run a Python process.',
        approval: { required: true, scope: 'single_action' },
        process: {
          schema: 'modly.agent-process.v1', runtimeFiles: ['processor.py'], resourceFiles: [],
          runtime: { kind: 'extension-python-venv-v1', interpreter: 'bin/python' },
          ...(withModelAccess ? { modelAccess: {
            schema: 'modly.agent-model-access.v1', profile: 'ollama-responses-json-v1',
          } } : {}),
          artifacts: {
            maxCount: 1, maxTotalBytes: 1024,
            allowed: [{ kind: 'text', mediaTypes: ['text/plain'], maxBytes: 1024 }],
          },
        },
      },
    }],
  }))
  return { root, builtinDir, userExtensionsDir, extensionDir, venvDir, baseInterpreter }
}

test('model access readiness is independently default-deny and excludes only Agent eligibility', async () => {
  const value = await fixture(true)
  try {
    for (const probe of [undefined, async () => false, async () => { throw new Error('unavailable') }]) {
      const inventory = await listAgentCapabilities({
        builtinDir: value.builtinDir,
        userExtensionsDir: value.userExtensionsDir,
        trustedRepos: new Set(),
        processPythonSandboxReadiness: async () => true,
        processPythonExecutable: () => value.baseInterpreter,
        ...(probe ? { processModelAccessReadiness: probe } : {}),
      })
      assert.deepEqual(inventory.capabilities, [])
      assert.equal(inventory.errors.some((error) => error.code === 'PROCESS_MODEL_ACCESS_UNAVAILABLE'), true)
    }
    const ready = await listAgentCapabilities({
      builtinDir: value.builtinDir,
      userExtensionsDir: value.userExtensionsDir,
      trustedRepos: new Set(),
      processPythonSandboxReadiness: async () => true,
      processPythonExecutable: () => value.baseInterpreter,
      processModelAccessReadiness: async () => true,
    })
    assert.equal(ready.capabilities.length, 1)
    assert.deepEqual(ready.capabilities[0].execution?.kind === 'process'
      ? ready.capabilities[0].execution.modelAccess : undefined, {
      schema: 'modly.agent-model-access.v1', profile: 'ollama-responses-json-v1',
    })
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('renderer inventory and Agent actions share one fresh capability discovery resolver with every runtime readiness input', async () => {
  const hostRuntimes = createDefaultAgentHostRuntimeRegistry()
  const mcpSandboxReadiness = async () => true
  const processPythonSandboxReadiness = async () => true
  const processModelAccessReadiness = async () => true
  const processPythonExecutable = () => '/trusted/python'
  const calls: Array<Parameters<typeof listAgentCapabilities>[0]> = []
  let extensionRevision = 0
  let trustRevision = 0

  const shared = createSharedAgentCapabilityResolver({
    discoverCapabilities: async (options) => {
      calls.push(options)
      return { capabilities: [], errors: [] }
    },
    getBuiltinDir: () => '/builtin',
    getUserExtensionsDir: () => `/extensions/${++extensionRevision}`,
    fetchTrustedRepos: async () => new Set([`trusted-${++trustRevision}`]),
    hostRuntimes,
    mcpSandboxReadiness,
    processPythonSandboxReadiness,
    processModelAccessReadiness,
    processPythonExecutable,
  })

  assert.equal(shared.forAgentActions, shared.forRendererIpc)
  await shared.forAgentActions()
  await shared.forRendererIpc()
  assert.deepEqual(await shared.withPrivateSkillBindings(), {
    inventory: { capabilities: [], errors: [] },
    skillBindings: [],
  })

  assert.equal(calls.length, 3)
  assert.notEqual(calls[0], calls[1])
  assert.deepEqual(calls.map((options) => options.userExtensionsDir), ['/extensions/1', '/extensions/2', '/extensions/3'])
  assert.deepEqual(calls.map((options) => [...options.trustedRepos]), [['trusted-1'], ['trusted-2'], ['trusted-3']])
  for (const options of calls) {
    assert.equal(options.hostRuntimes, hostRuntimes)
    assert.equal(options.mcpSandboxReadiness, mcpSandboxReadiness)
    assert.equal(options.processPythonSandboxReadiness, processPythonSandboxReadiness)
    assert.equal(options.processModelAccessReadiness, processModelAccessReadiness)
    assert.equal(options.processPythonExecutable, processPythonExecutable)
  }
  assert.equal(calls[0].skillBindingSink, undefined)
  assert.equal(calls[1].skillBindingSink, undefined)
  assert.equal(typeof calls[2].skillBindingSink, 'function')
})

test('shared renderer inventory exposes model-backed PROCESS capabilities only while private model readiness is true', async () => {
  const value = await fixture(true)
  try {
    const makeResolver = (processModelAccessReadiness: () => Promise<boolean>) => createSharedAgentCapabilityResolver({
      discoverCapabilities: listAgentCapabilities,
      getBuiltinDir: () => value.builtinDir,
      getUserExtensionsDir: () => value.userExtensionsDir,
      fetchTrustedRepos: async () => new Set(),
      hostRuntimes: createDefaultAgentHostRuntimeRegistry(),
      mcpSandboxReadiness: async () => true,
      processPythonSandboxReadiness: async () => true,
      processModelAccessReadiness,
      processPythonExecutable: () => value.baseInterpreter,
    }).forRendererIpc

    for (const readiness of [async () => false, async () => { throw new Error('private model unavailable') }]) {
      const unavailable = await makeResolver(readiness)()
      assert.deepEqual(unavailable.capabilities, [])
      assert.equal(unavailable.errors.some((error) => error.code === 'PROCESS_MODEL_ACCESS_UNAVAILABLE'), true)
    }

    const ready = await makeResolver(async () => true)()
    assert.deepEqual(ready.errors, [])
    assert.deepEqual(ready.capabilities.map((capability) => capability.id), ['python-tools/run'])
    assert.equal(JSON.stringify(ready).includes(value.userExtensionsDir), false)
    assert.equal(JSON.stringify(ready).includes(value.baseInterpreter), false)
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('Python runtime discovery binds the complete venv identity only when sandbox readiness is true', async () => {
  const value = await fixture()
  try {
    const unavailable = await listAgentCapabilities({
      builtinDir: value.builtinDir, userExtensionsDir: value.userExtensionsDir, trustedRepos: new Set(),
      processPythonSandboxReadiness: async () => false,
      processPythonExecutable: () => value.baseInterpreter,
    })
    assert.deepEqual(unavailable.capabilities, [])
    assert.deepEqual(unavailable.errors, [{
      code: 'PROCESS_PYTHON_SANDBOX_UNAVAILABLE',
      message: 'An extension Python Agent capability is unavailable because its production sandbox readiness probe failed.',
      capabilityId: 'python-tools/run',
    }])

    const ready = await listAgentCapabilities({
      builtinDir: value.builtinDir, userExtensionsDir: value.userExtensionsDir, trustedRepos: new Set(),
      processPythonSandboxReadiness: async () => true,
      processPythonExecutable: () => value.baseInterpreter,
    })
    assert.deepEqual(ready.errors, [])
    assert.equal(ready.capabilities.length, 1)
    const execution = ready.capabilities[0].execution
    assert.equal(execution?.kind, 'process')
    if (execution?.kind !== 'process') assert.fail('expected process execution')
    assert.equal(execution.entry, 'processor.py')
    assert.equal(execution.runtime?.kind, 'extension-python-venv-v1')
    assert.equal(execution.runtime?.interpreter, 'bin/python')
    assert.match(execution.runtime?.treeDigest ?? '', /^[a-f0-9]{64}$/)
    assert.match(execution.runtime?.sourceIdentityHash ?? '', /^[a-f0-9]{64}$/)
    assert.match(execution.runtime?.bindingHash ?? '', /^[a-f0-9]{64}$/)
    assert.equal(JSON.stringify(ready).includes(value.extensionDir), false)

    const firstHash = ready.capabilities[0].hash
    await writeFile(join(value.venvDir, 'lib', 'native.so'), 'native-v2-expanded')
    const rebound = await listAgentCapabilities({
      builtinDir: value.builtinDir, userExtensionsDir: value.userExtensionsDir, trustedRepos: new Set(),
      processPythonSandboxReadiness: async () => true,
      processPythonExecutable: () => value.baseInterpreter,
    })
    assert.equal(rebound.capabilities.length, 1)
    assert.notEqual(rebound.capabilities[0].hash, firstHash)
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('missing required venv excludes only Agent eligibility with an actionable code', async () => {
  const value = await fixture()
  try {
    await rm(value.venvDir, { recursive: true, force: true })
    const inventory = await listAgentCapabilities({
      builtinDir: value.builtinDir, userExtensionsDir: value.userExtensionsDir, trustedRepos: new Set(),
      processPythonSandboxReadiness: async () => true,
      processPythonExecutable: () => value.baseInterpreter,
    })
    assert.deepEqual(inventory.capabilities, [])
    assert.deepEqual(inventory.errors, [{
      code: 'PROCESS_PYTHON_RUNTIME_UNAVAILABLE',
      message: 'An extension Python runtime is missing or unsafe and was excluded.',
      capabilityId: 'python-tools/run',
    }])
    const ordinary = await listVisibleExtensions({
      builtinDir: value.builtinDir, userExtensionsDir: value.userExtensionsDir, trustedRepos: new Set(),
    })
    assert.equal(ordinary[0]?.id, 'python-tools')
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('governed Python discovery accepts only one non-executable root processor.py with its declared venv', async (t) => {
  const cases: Array<{
    name: string
    mutate: (value: Awaited<ReturnType<typeof fixture>>, manifest: PythonTestManifest) => Promise<void> | void
    expectedCode?: string
  }> = [
    {
      name: 'missing runtime',
      mutate: (_value, manifest) => { delete manifest.nodes[0].agent.process.runtime },
    },
    {
      name: 'alternate Python filename',
      mutate: async (value, manifest) => {
        await writeFile(join(value.extensionDir, 'worker.py'), 'print("worker")\n')
        manifest.entry = 'worker.py'
        manifest.nodes[0].agent.process.runtimeFiles = ['worker.py']
      },
    },
    {
      name: 'extra Python source',
      mutate: async (value, manifest) => {
        await writeFile(join(value.extensionDir, 'helper.py'), 'VALUE = 1\n')
        manifest.nodes[0].agent.process.runtimeFiles = ['processor.py', 'helper.py']
      },
    },
    {
      name: 'executable Python source',
      mutate: async (value) => { await chmod(join(value.extensionDir, 'processor.py'), 0o700) },
      expectedCode: 'PROCESS_PYTHON_RUNTIME_UNAVAILABLE',
    },
    {
      name: 'hidden Python source',
      mutate: async (value, manifest) => {
        await rename(join(value.extensionDir, 'processor.py'), join(value.extensionDir, '.processor.py'))
        manifest.entry = '.processor.py'
        manifest.nodes[0].agent.process.runtimeFiles = ['.processor.py']
      },
    },
    {
      name: 'Python archive source',
      mutate: async (value, manifest) => {
        await rename(join(value.extensionDir, 'processor.py'), join(value.extensionDir, 'processor.pyz'))
        manifest.entry = 'processor.pyz'
        manifest.nodes[0].agent.process.runtimeFiles = ['processor.pyz']
      },
    },
  ]

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const value = await fixture()
      try {
        const manifestPath = join(value.extensionDir, 'manifest.json')
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PythonTestManifest
        await scenario.mutate(value, manifest)
        await writeFile(manifestPath, JSON.stringify(manifest))
        const inventory = await listAgentCapabilities({
          builtinDir: value.builtinDir,
          userExtensionsDir: value.userExtensionsDir,
          trustedRepos: new Set(),
          processPythonSandboxReadiness: async () => true,
          processPythonExecutable: () => value.baseInterpreter,
        })
        assert.deepEqual(inventory.capabilities, [])
        if (scenario.expectedCode) assert.equal(inventory.errors[0]?.code, scenario.expectedCode)
        else assert.deepEqual(inventory.errors, [])
      } finally {
        await rm(value.root, { recursive: true, force: true })
      }
    })
  }
})

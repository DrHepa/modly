import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { listAgentCapabilities, listVisibleExtensions } from './automation-capabilities.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'modly-agent-python-discovery-'))
  const builtinDir = join(root, 'builtin')
  const userExtensionsDir = join(root, 'extensions')
  const extensionDir = join(userExtensionsDir, 'python-tools')
  const venvDir = join(extensionDir, 'venv')
  const baseInterpreter = join(root, 'trusted-python')
  await mkdir(builtinDir, { recursive: true })
  await mkdir(join(venvDir, 'bin'), { recursive: true })
  await mkdir(join(venvDir, 'lib'), { recursive: true })
  await writeFile(join(extensionDir, 'processor.pyz'), 'PK\u0003\u0004approved')
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
    id: 'python-tools', name: 'Python Tools', type: 'process', entry: 'processor.pyz',
    nodes: [{
      id: 'run', name: 'Run', input: 'text', output: 'text', params_schema: [],
      agent: {
        schema: 'modly.agent-capability-declaration.v1', capability_id: 'python-tools/run',
        display_name: 'Run Python', description: 'Run a Python zipapp.',
        approval: { required: true, scope: 'single_action' },
        process: {
          schema: 'modly.agent-process.v1', runtimeFiles: ['processor.pyz'], resourceFiles: [],
          runtime: { kind: 'extension-python-venv-v1', interpreter: 'bin/python' },
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
    assert.equal(execution.entry, 'processor.pyz')
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

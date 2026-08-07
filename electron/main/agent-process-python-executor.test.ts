import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { AgentActionExecutorRequest } from './agent-actions-service.ts'
import { acquireAgentModelAccessGateway } from './agent-model-access-gateway.ts'
import { listAgentCapabilities } from './automation-capabilities.ts'
import {
  AgentProcessExecutorError,
  createAgentProcessExecutor,
  type AgentProcessExecutorOptions,
} from './agent-process-executor.ts'
import {
  bindExtensionPythonRuntime,
  prepareExtensionPythonRuntimeSnapshot,
} from './agent-process-python-runtime.ts'
import type {
  AgentCapabilitySnapshotV1,
  AgentOllamaModelSnapshotV1,
  ArtifactRefV1,
} from '../../src/shared/types/agentActions.ts'

const model: AgentOllamaModelSnapshotV1 = {
  provider: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'qwen3.6:latest',
  digest: `sha256:${'b'.repeat(64)}`,
}

const processTestLimits = {
  startupMs: 30_000,
  idleMs: 60_000,
  totalMs: 120_000,
  terminationGraceMs: 500,
} as const

const fakeBubblewrap = String.raw`#!${process.execPath}
const { createHash } = require('node:crypto')
const { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const args = process.argv.slice(2)
const triple = (flag, destination) => {
  for (let index = 0; index < args.length - 2; index += 1) {
    if (args[index] === flag && args[index + 2] === destination) return args[index + 1]
  }
  throw new Error('missing sandbox binding: ' + destination)
}
if (!args.includes('--unshare-all') || !args.includes('--disable-userns')) throw new Error('network namespace is not isolated')
if (args.slice(-3).join(' ') !== '-- /runtime/bin/python /app/process.pyz') throw new Error('approved zipapp launch changed')
const entryFd = triple('--ro-bind-fd', '/app/process.pyz')
const resourceFd = triple('--ro-bind-fd', '/resources/0')
const inputFd = triple('--ro-bind-fd', '/input/0')
const snapshotSource = triple('--ro-bind', '/runtime')
const outputSource = triple('--bind', '/output')
writeFileSync(readlinkSync(process.argv[1]) + '.invoked', 'yes')
if (!readFileSync('/proc/self/fd/' + entryFd).length) throw new Error('entry fd is empty')
if (!readFileSync(snapshotSource + '/bin/python').length) throw new Error('snapshot interpreter is missing')
let serialized = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { serialized += chunk })
process.stdin.on('end', async () => {
  try {
    const request = JSON.parse(serialized)
    if (request.trustedContext.dirs.output !== '/output') throw new Error('host output path leaked')
    if (request.trustedContext.resources[0].fdPath !== '/resources/0') throw new Error('resource mount changed')
    if (request.trustedContext.inputArtifacts[0].fdPath !== '/input/0') throw new Error('input mount changed')
    if (request.trustedContext.modelAccess) {
      const gatewaySource = triple('--ro-bind', '/run/modly/model')
      if (!lstatSync(gatewaySource + '/gateway.sock').isSocket()) throw new Error('model gateway socket was not FD-mounted')
      if (request.trustedContext.modelAccess.socketPath !== '/run/modly/model/gateway.sock') throw new Error('sandbox socket path changed')
      if (request.trustedContext.modelAccess.model !== 'approved') throw new Error('model sentinel changed')
      if (!request.trustedContext.modelAccess.bearerToken) throw new Error('model bearer missing')
      if ('endpoint' in request.trustedContext || JSON.stringify(request.trustedContext).includes('127.0.0.1')) throw new Error('raw model endpoint leaked')
      if (!request.trustedContext.proposalHash) throw new Error('proposal binding missing')
    }
    const resource = readFileSync('/proc/self/fd/' + resourceFd, 'utf8').trim()
    const input = readFileSync('/proc/self/fd/' + inputFd, 'utf8').trim()
    writeFileSync(join(outputSource, 'started'), 'ready')
    if (request.arguments.params.mode === 'delay') {
      const release = join(outputSource, 'release')
      const deadline = Date.now() + 60000
      while (!existsSync(release) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      if (!existsSync(release)) throw new Error('timed out waiting for source-drift test release')
    }
    const body = Buffer.from(resource + ':' + input)
    writeFileSync(join(outputSource, 'result.txt'), body)
    process.stdout.write(JSON.stringify({
      schema: 'modly.agent-process-result.v1', type: 'result', artifacts: [{
        path: 'result.txt', kind: 'text', mediaType: 'text/plain', sizeBytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
      }],
    }) + '\n')
  } catch (error) {
    process.stderr.write(String(error && error.stack || error))
    process.exitCode = 1
  }
})
`

async function makeWritableAndRemove(root: string): Promise<void> {
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path).catch(() => undefined)
    if (!info || !info.isDirectory() || info.isSymbolicLink()) return
    await chmod(path, 0o700)
    for (const child of await readdir(path)) await visit(join(path, child))
  }
  await visit(root)
  await rm(root, { recursive: true, force: true })
}

async function fixture(withModelAccess = false) {
  const root = await mkdtemp(join(tmpdir(), 'modly-agent-python-executor-'))
  const builtinDir = join(root, 'builtin')
  const userDir = join(root, 'extensions')
  const extensionDir = join(userDir, 'python-tools')
  const venvDir = join(extensionDir, 'venv')
  const workspaceDir = join(root, 'workspace')
  const privateTempRoot = join(root, 'agent-private')
  const snapshotRoot = join(root, 'user-data', 'agent-process-runtime-snapshots')
  const bwrapPath = join(root, 'fake-bwrap')
  const baseInterpreter = join(root, 'trusted-python')
  await mkdir(join(venvDir, 'bin'), { recursive: true })
  await mkdir(join(venvDir, 'lib', 'python3.11', 'site-packages'), { recursive: true })
  await mkdir(join(extensionDir, 'assets'), { recursive: true })
  await mkdir(builtinDir, { recursive: true })
  await mkdir(workspaceDir, { recursive: true })
  await writeFile(join(extensionDir, 'processor.pyz'), 'PK\u0003\u0004approved-zipapp')
  await writeFile(join(extensionDir, 'assets', 'runtime.txt'), 'resource')
  await writeFile(baseInterpreter, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  await symlink('python3', join(venvDir, 'bin', 'python'))
  await symlink('../../../../trusted-python', join(venvDir, 'bin', 'python3'))
  await symlink('lib', join(venvDir, 'lib64'))
  await writeFile(join(venvDir, 'pyvenv.cfg'), 'home = /usr\n')
  await writeFile(join(venvDir, 'lib', 'python3.11', 'site-packages', 'native.so'), 'native-v1')
  for (const path of [
    venvDir, join(venvDir, 'bin'), join(venvDir, 'lib'), join(venvDir, 'lib', 'python3.11'),
    join(venvDir, 'lib', 'python3.11', 'site-packages'),
  ]) await chmod(path, 0o700)
  await chmod(join(venvDir, 'pyvenv.cfg'), 0o600)
  await chmod(join(venvDir, 'lib', 'python3.11', 'site-packages', 'native.so'), 0o600)
  await writeFile(bwrapPath, fakeBubblewrap, { mode: 0o700 })
  await chmod(bwrapPath, 0o700)
  await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify({
    id: 'python-tools', name: 'Python Tools', version: '1.0.0', type: 'process', entry: 'processor.pyz',
    nodes: [{
      id: 'generate', name: 'Generate', input: 'text', output: 'text',
      params_schema: [{
        id: 'mode', type: 'select', default: 'success',
        options: ['success', 'delay'].map((value) => ({ value, label: value })),
      }],
      agent: {
        schema: 'modly.agent-capability-declaration.v1', capability_id: 'python-tools/generate',
        display_name: 'Run Python', description: 'Run an approved Python zipapp.',
        approval: { required: true, scope: 'single_action' },
        process: {
          schema: 'modly.agent-process.v1', runtimeFiles: ['processor.pyz'], resourceFiles: ['assets/runtime.txt'],
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
  const inventory = await listAgentCapabilities({
    builtinDir, userExtensionsDir: userDir, trustedRepos: new Set(),
    processPythonSandboxReadiness: async () => true,
    processPythonExecutable: () => baseInterpreter,
    ...(withModelAccess ? { processModelAccessReadiness: async () => true } : {}),
  })
  assert.deepEqual(inventory.errors, [])
  assert.equal(inventory.capabilities.length, 1)
  const inputBytes = Buffer.from('input')
  await writeFile(join(workspaceDir, 'input.txt'), inputBytes)
  const input: ArtifactRefV1 = {
    schema: 'modly.artifact-ref.v1', version: 1, id: 'input-python', kind: 'text', mediaType: 'text/plain',
    workspacePath: 'input.txt', sha256: createHash('sha256').update(inputBytes).digest('hex'), sizeBytes: inputBytes.length,
  }
  return {
    root, extensionDir, venvDir, workspaceDir, privateTempRoot, snapshotRoot, bwrapPath, baseInterpreter,
    capability: inventory.capabilities[0], input,
  }
}

async function secondaryRuntime(root: string) {
  const extensionDir = join(root, 'sweep-extension')
  const venvDir = join(extensionDir, 'venv')
  const baseInterpreter = join(root, 'sweep-python')
  await mkdir(join(venvDir, 'bin'), { recursive: true })
  await mkdir(join(venvDir, 'lib'), { recursive: true })
  await writeFile(baseInterpreter, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  await symlink('python3', join(venvDir, 'bin', 'python'))
  await symlink('../../../sweep-python', join(venvDir, 'bin', 'python3'))
  await symlink('lib', join(venvDir, 'lib64'))
  await writeFile(join(venvDir, 'pyvenv.cfg'), 'home = /usr\n')
  await writeFile(join(venvDir, 'lib', 'queued.bin'), Buffer.alloc(2 * 1024 * 1024, 0x51))
  for (const path of [venvDir, join(venvDir, 'bin'), join(venvDir, 'lib')]) await chmod(path, 0o700)
  await chmod(join(venvDir, 'pyvenv.cfg'), 0o600)
  await chmod(join(venvDir, 'lib', 'queued.bin'), 0o600)
  const binding = await bindExtensionPythonRuntime(
    extensionDir,
    { kind: 'extension-python-venv-v1', interpreter: 'bin/python' },
    baseInterpreter,
  )
  return { extensionDir, baseInterpreter, binding }
}

async function waitForStageOutput(privateTempRoot: string, actionId: string): Promise<string> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const stages = await readdir(privateTempRoot).catch(() => [])
    const stage = stages.find((name) => name.startsWith(`${actionId}-`))
    if (stage) {
      const output = join(privateTempRoot, stage, 'output')
      if (await access(join(output, 'started')).then(() => true).catch(() => false)) return output
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${actionId}`)
}

async function seedSnapshotSweep(
  snapshotRoot: string,
  oldestDigest: string,
  retainedDigest: string,
  label: string,
): Promise<void> {
  await utimes(join(snapshotRoot, oldestDigest), new Date(1), new Date(1))
  let created = 0
  for (let index = 0; created < 12; index += 1) {
    const digest = createHash('sha256').update(`${label}-${index}`).digest('hex')
    if (digest === oldestDigest || digest === retainedDigest) continue
    const path = join(snapshotRoot, digest)
    await mkdir(path, { mode: 0o700 })
    await utimes(path, new Date(Date.now() + created * 1_000), new Date(Date.now() + created * 1_000))
    created += 1
  }
}

async function triggerSnapshotSweep(
  snapshotRoot: string,
  runtime: Awaited<ReturnType<typeof secondaryRuntime>>,
): Promise<void> {
  const prepared = await prepareExtensionPythonRuntimeSnapshot(
    runtime.extensionDir, runtime.binding, snapshotRoot, runtime.baseInterpreter,
  )
  prepared.release()
}

function request(
  capability: AgentCapabilitySnapshotV1,
  input: ArtifactRefV1,
  actionId: string,
  mode: 'success' | 'delay',
): AgentActionExecutorRequest {
  return Object.freeze({
    actionId, originSessionId: 'session-python', proposalHash: 'a'.repeat(64), capability,
    arguments: { input: 'approved', params: { mode } }, model, inputArtifacts: [input],
    signal: new AbortController().signal,
  })
}

test('declared model access is default-denied without a provider and an injected lease is FD-mounted then revoked', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux proc-fd and pathname AF_UNIX semantics are required')
  const value = await fixture(true)
  let hostSocketPath = ''
  try {
    const common: AgentProcessExecutorOptions = {
      getWorkspaceRoot: () => value.workspaceDir,
      getPrivateTempRoot: () => value.privateTempRoot,
      getRuntimeSnapshotRoot: () => value.snapshotRoot,
      pythonSandboxReadiness: async () => true,
      bwrapPath: value.bwrapPath,
      systemPaths: ['/usr'],
      resolveTarget: async () => ({ capability: value.capability, extensionDir: value.extensionDir, entry: 'processor.pyz' }),
      resolveCurrentModel: async () => model,
      resolvePythonExecutable: () => value.baseInterpreter,
      limits: processTestLimits,
    }
    await assert.rejects(
      createAgentProcessExecutor(common).ensureReady(value.capability),
      (error: unknown) => error instanceof AgentProcessExecutorError && error.code === 'model_binding_unavailable',
    )
    await assert.rejects(
      createAgentProcessExecutor({ ...common, modelAccessReadiness: async () => true }).ensureReady(value.capability),
      (error: unknown) => error instanceof AgentProcessExecutorError && error.code === 'model_binding_unavailable',
    )

    const executor = createAgentProcessExecutor({
      ...common,
      modelAccessReadiness: async () => true,
      acquireModelAccess: async (input) => {
        const lease = await acquireAgentModelAccessGateway({
          root: input.privateTempRoot,
          actionId: input.actionId,
          proposalHash: input.proposalHash,
          capabilityHash: input.capability.hash,
          digest: input.model.digest,
          approvedModelName: input.model.model,
          declaration: input.capability.execution?.kind === 'process'
            ? input.capability.execution.modelAccess!
            : { schema: 'modly.agent-model-access.v1', profile: 'ollama-responses-json-v1' },
          privateModelAlias: 'modly-private-test',
          signal: input.signal,
          forward: async () => ({ id: 'unused' }),
        })
        hostSocketPath = lease.hostSocketPath
        return lease
      },
    })
    await executor.ensureReady(value.capability)
    const result = await executor.execute(request(value.capability, value.input, 'action-python-model', 'success'))
    assert.equal(await readFile(join(value.workspaceDir, result.artifacts[0].workspacePath), 'utf8'), 'resource:input')
    await assert.rejects(access(hostSocketPath))
    await result.rollback()
  } finally {
    await makeWritableAndRemove(value.root)
  }
})

test('declared Python runtime executes only through the snapshotted zipapp sandbox with FD authority', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux proc-fd semantics are required')
  const value = await fixture()
  let selectorCalls = 0
  try {
    const executor = createAgentProcessExecutor({
      getWorkspaceRoot: () => value.workspaceDir,
      getPrivateTempRoot: () => value.privateTempRoot,
      getRuntimeSnapshotRoot: () => value.snapshotRoot,
      pythonSandboxReadiness: async () => true,
      bwrapPath: value.bwrapPath,
      systemPaths: ['/usr'],
      resolveTarget: async () => ({ capability: value.capability, extensionDir: value.extensionDir, entry: 'processor.pyz' }),
      resolveCurrentModel: async () => model,
      resolvePythonExecutable: () => { selectorCalls += 1; return value.baseInterpreter },
      limits: processTestLimits,
    })
    await executor.ensureReady(value.capability)
    const result = await executor.execute(request(value.capability, value.input, 'action-python-success', 'success'))
    assert.ok(selectorCalls >= 3)
    await access(`${value.bwrapPath}.invoked`)
    assert.equal(await readFile(join(value.workspaceDir, result.artifacts[0].workspacePath), 'utf8'), 'resource:input')
    assert.equal((await lstat(value.snapshotRoot)).mode & 0o077, 0)
    await result.rollback()
  } finally {
    await makeWritableAndRemove(value.root)
  }
})

test('a changed Electron-selected base interpreter is rejected before the fixed launcher can run', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux proc-fd semantics are required')
  const value = await fixture()
  const replacement = join(value.root, 'replacement-python')
  let selected = value.baseInterpreter
  try {
    await writeFile(replacement, '#!/bin/sh\nexit 1\n', { mode: 0o700 })
    const executor = createAgentProcessExecutor({
      getWorkspaceRoot: () => value.workspaceDir,
      getPrivateTempRoot: () => value.privateTempRoot,
      getRuntimeSnapshotRoot: () => value.snapshotRoot,
      pythonSandboxReadiness: async () => true,
      bwrapPath: value.bwrapPath,
      systemPaths: ['/usr'],
      resolveTarget: async () => ({ capability: value.capability, extensionDir: value.extensionDir, entry: 'processor.pyz' }),
      resolveCurrentModel: async () => model,
      resolvePythonExecutable: () => selected,
      limits: processTestLimits,
    })
    await executor.ensureReady(value.capability)
    selected = replacement
    await assert.rejects(
      executor.execute(request(value.capability, value.input, 'action-python-wrong-base', 'success')),
      (error: unknown) => error instanceof AgentProcessExecutorError && error.code === 'capability_stale',
    )
    await assert.rejects(access(`${value.bwrapPath}.invoked`))
  } finally {
    await makeWritableAndRemove(value.root)
  }
})

test('pre-transfer Python sandbox failures release their prepared snapshot lease', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux proc-fd semantics are required')
  const cases = [
    { name: 'bubblewrap lookup', expectedCode: 'runtime_unavailable' as const },
    { name: 'host path validation', expectedCode: 'runtime_unavailable' as const },
    { name: 'immediate runtime revalidation', expectedCode: 'capability_stale' as const },
  ]
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const value = await fixture()
      try {
        const options: AgentProcessExecutorOptions = {
          getWorkspaceRoot: () => value.workspaceDir,
          getPrivateTempRoot: () => value.privateTempRoot,
          getRuntimeSnapshotRoot: () => value.snapshotRoot,
          pythonSandboxReadiness: async () => true,
          bwrapPath: value.bwrapPath,
          systemPaths: ['/usr'],
          resolveTarget: async () => ({ capability: value.capability, extensionDir: value.extensionDir, entry: 'processor.pyz' }),
          resolveCurrentModel: async () => model,
          resolvePythonExecutable: () => value.baseInterpreter,
          limits: processTestLimits,
        }
        if (scenario.name === 'bubblewrap lookup') options.bwrapPath = join(value.root, 'missing-bwrap')
        if (scenario.name === 'host path validation') options.systemPaths = ['/usr', 'relative-host-path']
        if (scenario.name === 'immediate runtime revalidation') {
          Object.defineProperty(options, 'bwrapPath', {
            configurable: true,
            enumerable: true,
            get: () => {
              writeFileSync(join(value.venvDir, 'lib', 'python3.11', 'site-packages', 'native.so'), 'native-version-2')
              return value.bwrapPath
            },
          })
        }
        const executor = createAgentProcessExecutor(options)
        await assert.rejects(
          executor.ensureReady(value.capability),
          (error: unknown) => error instanceof AgentProcessExecutorError && error.code === scenario.expectedCode,
        )
        const execution = value.capability.execution
        if (execution?.kind !== 'process' || !execution.runtime) assert.fail('expected bound Python execution')
        const snapshotPath = join(value.snapshotRoot, execution.runtime.treeDigest)
        await access(snapshotPath)
        const secondary = await secondaryRuntime(value.root)
        await seedSnapshotSweep(
          value.snapshotRoot, execution.runtime.treeDigest, secondary.binding.treeDigest, scenario.name,
        )
        await triggerSnapshotSweep(value.snapshotRoot, secondary)
        await assert.rejects(access(snapshotPath), { code: 'ENOENT' })
      } finally {
        await makeWritableAndRemove(value.root)
      }
    })
  }
})

test('normal returned Python sandbox cleanup releases one lease without consuming another holder', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux proc-fd semantics are required')
  const value = await fixture()
  let held: Awaited<ReturnType<typeof prepareExtensionPythonRuntimeSnapshot>> | undefined
  try {
    const execution = value.capability.execution
    if (execution?.kind !== 'process' || !execution.runtime) assert.fail('expected bound Python execution')
    held = await prepareExtensionPythonRuntimeSnapshot(
      value.extensionDir, execution.runtime, value.snapshotRoot, value.baseInterpreter,
    )
    const executor = createAgentProcessExecutor({
      getWorkspaceRoot: () => value.workspaceDir,
      getPrivateTempRoot: () => value.privateTempRoot,
      getRuntimeSnapshotRoot: () => value.snapshotRoot,
      pythonSandboxReadiness: async () => true,
      bwrapPath: value.bwrapPath,
      systemPaths: ['/usr'],
      resolveTarget: async () => ({ capability: value.capability, extensionDir: value.extensionDir, entry: 'processor.pyz' }),
      resolveCurrentModel: async () => model,
      resolvePythonExecutable: () => value.baseInterpreter,
      limits: processTestLimits,
    })
    await executor.ensureReady(value.capability)
    const secondary = await secondaryRuntime(value.root)
    await seedSnapshotSweep(
      value.snapshotRoot, execution.runtime.treeDigest, secondary.binding.treeDigest, 'normal-cleanup',
    )
    await triggerSnapshotSweep(value.snapshotRoot, secondary)
    await access(held.rootPath)
    held.release()
    held = undefined
    await triggerSnapshotSweep(value.snapshotRoot, secondary)
    await assert.rejects(access(join(value.snapshotRoot, execution.runtime.treeDigest)), { code: 'ENOENT' })
  } finally {
    held?.release()
    await makeWritableAndRemove(value.root)
  }
})

test('running and queued Python snapshot leases survive concurrent cache sweeping', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux proc-fd semantics are required')
  const value = await fixture()
  const secondary = await secondaryRuntime(value.root)
  const prepared: Array<Awaited<ReturnType<typeof prepareExtensionPythonRuntimeSnapshot>>> = []
  try {
    const executor = createAgentProcessExecutor({
      getWorkspaceRoot: () => value.workspaceDir,
      getPrivateTempRoot: () => value.privateTempRoot,
      getRuntimeSnapshotRoot: () => value.snapshotRoot,
      pythonSandboxReadiness: async () => true,
      bwrapPath: value.bwrapPath,
      systemPaths: ['/usr'],
      resolveTarget: async () => ({ capability: value.capability, extensionDir: value.extensionDir, entry: 'processor.pyz' }),
      resolveCurrentModel: async () => model,
      resolvePythonExecutable: () => value.baseInterpreter,
      limits: processTestLimits,
    })
    const running = executor.execute(request(
      value.capability, value.input, 'action-python-leased', 'delay',
    ))
    const output = await waitForStageOutput(value.privateTempRoot, 'action-python-leased')
    const execution = value.capability.execution
    if (execution?.kind !== 'process' || !execution.runtime) assert.fail('expected bound Python execution')
    const activeRoot = join(value.snapshotRoot, execution.runtime.treeDigest)
    await utimes(activeRoot, new Date(1), new Date(1))
    for (let index = 0; index < 12; index += 1) {
      const digest = createHash('sha256').update(`sweep-${index}`).digest('hex')
      const path = join(value.snapshotRoot, digest)
      await mkdir(path, { mode: 0o700 })
      await utimes(path, new Date(Date.now() + index * 1_000), new Date(Date.now() + index * 1_000))
    }
    const [first, queued] = await Promise.all([
      prepareExtensionPythonRuntimeSnapshot(
        secondary.extensionDir, secondary.binding, value.snapshotRoot, secondary.baseInterpreter,
      ),
      prepareExtensionPythonRuntimeSnapshot(
        secondary.extensionDir, secondary.binding, value.snapshotRoot, secondary.baseInterpreter,
      ),
    ])
    prepared.push(first, queued)
    await access(activeRoot)
    await writeFile(join(output, 'release'), 'continue')
    const result = await running
    assert.equal(await readFile(join(value.workspaceDir, result.artifacts[0].workspacePath), 'utf8'), 'resource:input')
    await result.rollback()
  } finally {
    for (const runtime of prepared) runtime.release()
    await makeWritableAndRemove(value.root)
  }
})

test('post-execution source drift denies Python runtime publication', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux proc-fd semantics are required')
  const value = await fixture()
  try {
    const executor = createAgentProcessExecutor({
      getWorkspaceRoot: () => value.workspaceDir,
      getPrivateTempRoot: () => value.privateTempRoot,
      getRuntimeSnapshotRoot: () => value.snapshotRoot,
      pythonSandboxReadiness: async () => true,
      bwrapPath: value.bwrapPath,
      systemPaths: ['/usr'],
      resolveTarget: async () => ({ capability: value.capability, extensionDir: value.extensionDir, entry: 'processor.pyz' }),
      resolveCurrentModel: async () => model,
      resolvePythonExecutable: () => value.baseInterpreter,
      limits: processTestLimits,
    })
    const running = executor.execute(request(value.capability, value.input, 'action-python-stale', 'delay'))
    let stageOutput: string | undefined
    const startDeadline = Date.now() + 30_000
    while (!stageOutput && Date.now() < startDeadline) {
      const stages = await readdir(value.privateTempRoot).catch(() => [])
      for (const stage of stages) {
        const output = join(value.privateTempRoot, stage, 'output')
        const started = await access(join(output, 'started')).then(() => true).catch(() => false)
        if (started) stageOutput = output
      }
      if (!stageOutput) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(stageOutput)
    await writeFile(join(value.venvDir, 'lib', 'python3.11', 'site-packages', 'native.so'), 'native-version-2')
    await writeFile(join(stageOutput, 'release'), 'continue')
    await assert.rejects(running, (error: unknown) => (
      error instanceof AgentProcessExecutorError && error.code === 'capability_stale'
    ))
    await assert.rejects(access(join(value.workspaceDir, 'Workflows', 'agent-actions', 'action-python-stale')))
  } finally {
    await makeWritableAndRemove(value.root)
  }
})

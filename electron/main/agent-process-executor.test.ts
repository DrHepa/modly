import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type {
  AgentActionExecutorRequest,
} from './agent-actions-service.ts'
import { listAgentCapabilities } from './automation-capabilities.ts'
import {
  AgentProcessExecutorError,
  AgentProcessTerminalError,
  createAgentProcessExecutor,
} from './agent-process-executor.ts'
import type {
  AgentCapabilitySnapshotV1,
  AgentOllamaModelSnapshotV1,
  ArtifactRefV1,
} from '../../src/shared/types/agentActions.ts'

const model: AgentOllamaModelSnapshotV1 = {
  provider: 'ollama',
  endpoint: 'http://127.0.0.1:11434',
  model: 'qwen3.6:latest',
  digest: `sha256:${'a'.repeat(64)}`,
}

const processor = String.raw`
import { createHash } from 'node:crypto'
import { readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const request = JSON.parse(await new Promise((resolve) => {
  let value = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => { value += chunk })
  process.stdin.on('end', () => resolve(value))
}))
if (!process.argv[1]?.startsWith('/proc/self/fd/')) throw new Error('runtime was not launched from an inherited fd')
if ('copyPath' in (request.trustedContext.inputArtifacts[0] ?? {})) throw new Error('copied input path was exposed')
if ('inputs' in request.trustedContext.dirs || 'runtime' in request.trustedContext.dirs) throw new Error('mutable staging dirs were exposed')
const resource = JSON.parse(await readFile(request.trustedContext.resources[0].fdPath, 'utf8'))
if (resource.runtime !== true) throw new Error('resource fd was not inherited')
const inputText = await readFile(request.trustedContext.inputArtifacts[0].fdPath, 'utf8')
const mode = request.arguments.params.mode
const out = request.trustedContext.dirs.output
const descriptor = async (path, kind, mediaType, bytes) => {
  const body = Buffer.from(bytes)
  await writeFile(join(out, path), body)
  return { path, kind, mediaType, sizeBytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }
}
if (mode === 'forged') {
  if (request.trustedContext.actionId !== 'action-forged') throw new Error('main context missing')
  if ('trustedContext' in request.arguments) throw new Error('renderer context was accepted')
}
if (mode === 'hang') {
  setInterval(() => {}, 1000)
} else if (mode === 'tree') {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)", 'modly-agent-tree-marker'], { stdio: 'ignore' })
  await writeFile(join(out, 'tree.pid'), String(child.pid))
  process.on('SIGTERM', () => process.exit(0))
  setInterval(() => {}, 1000)
} else if (mode === 'log-flood') {
  process.stdout.write(JSON.stringify({ type: 'log', message: 'x'.repeat(4096) }) + '\n')
} else if (mode.startsWith('terminal-error')) {
  const frame = {
    type: 'error', code: 'model_binding_unavailable',
    message: 'The approved model binding is unavailable.',
    details: { retryable: true, stage: 'model_binding' },
  }
  if (mode === 'terminal-error-code') frame.code = '../escape'
  if (mode === 'terminal-error-message') frame.message = 'unsafe\nmessage'
  if (mode === 'terminal-error-artifacts') frame.artifacts = []
  process.stdout.write(JSON.stringify(frame) + '\n')
  if (mode === 'terminal-error-after') {
    process.stdout.write(JSON.stringify({ type: 'log', message: 'must be rejected' }) + '\n')
  }
  if (mode === 'terminal-error-stderr') process.stderr.write('must be rejected')
} else {
  const plan = await descriptor('plan.md', 'plan', 'text/markdown', '# Plan\n' + inputText)
  const glb = await descriptor('model.glb', 'glb', 'model/gltf-binary', 'glTF')
  if (mode === 'path') glb.path = '../escape.glb'
  if (mode === 'digest') glb.sha256 = '0'.repeat(64)
  if (mode === 'partial') glb.path = 'missing.glb'
  if (mode === 'oversize') {
    await writeFile(join(out, 'model.glb'), Buffer.alloc(2048))
    glb.sizeBytes = 2048
    glb.sha256 = createHash('sha256').update(Buffer.alloc(2048)).digest('hex')
  }
  if (mode === 'symlink') {
    await writeFile(join(out, 'real.glb'), 'glTF')
    await unlink(join(out, 'model.glb'))
    await symlink(join(out, 'real.glb'), join(out, 'model.glb'))
  }
  process.stdout.write(JSON.stringify({
    schema: 'modly.agent-process-result.v1', type: 'result', artifacts: [plan, glb],
  }) + '\n')
  if (mode === 'terminal-after') {
    process.stdout.write(JSON.stringify({ type: 'log', message: 'must be rejected' }) + '\n')
  }
}
`

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'modly-agent-process-executor-'))
  const builtinDir = join(root, 'builtin')
  const userDir = join(root, 'extensions')
  const extensionDir = join(userDir, 'cad-tools')
  const workspaceDir = join(root, 'workspace')
  const privateTempRoot = join(root, 'private-agent-temp')
  await mkdir(builtinDir, { recursive: true })
  await mkdir(join(extensionDir, 'assets'), { recursive: true })
  await mkdir(workspaceDir, { recursive: true })
  await writeFile(join(extensionDir, 'processor.mjs'), processor)
  await writeFile(join(extensionDir, 'assets', 'runtime-data.json'), '{"runtime":true}\n')
  await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify({
    id: 'cad-tools', name: 'CAD Tools', version: '1.0.0', type: 'process', entry: 'processor.mjs',
    nodes: [{
      id: 'generate', name: 'Generate', input: 'text', output: 'mesh',
      params_schema: [{
        id: 'mode', type: 'select', default: 'honest', options: [
          'honest', 'forged', 'path', 'symlink', 'oversize', 'digest', 'partial', 'hang', 'tree', 'log-flood', 'terminal-after',
          'terminal-error', 'terminal-error-code', 'terminal-error-message', 'terminal-error-artifacts',
          'terminal-error-after', 'terminal-error-stderr',
        ].map((value) => ({ value, label: value })),
      }],
      agent: {
        schema: 'modly.agent-capability-declaration.v1', capability_id: 'cad-tools/generate',
        display_name: 'Generate CAD', description: 'Generate governed CAD artifacts.',
        approval: { required: true, scope: 'single_action' },
        process: {
          schema: 'modly.agent-process.v1', runtimeFiles: ['processor.mjs'],
          resourceFiles: ['assets/runtime-data.json'],
          artifacts: {
            maxCount: 2, maxTotalBytes: 2048,
            allowed: [
              { kind: 'plan', mediaTypes: ['text/markdown'], maxBytes: 512 },
              { kind: 'glb', mediaTypes: ['model/gltf-binary'], maxBytes: 1024 },
            ],
          },
        },
      },
    }],
  }))
  const inventory = await listAgentCapabilities({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
  assert.equal(inventory.capabilities.length, 1)
  const inputPath = join(workspaceDir, 'input.txt')
  const inputBytes = Buffer.from('approved input\n')
  await writeFile(inputPath, inputBytes)
  const inputArtifact: ArtifactRefV1 = {
    schema: 'modly.artifact-ref.v1', version: 1, id: 'input-1', kind: 'text', mediaType: 'text/plain',
    workspacePath: 'input.txt', sha256: createHash('sha256').update(inputBytes).digest('hex'), sizeBytes: inputBytes.length,
  }
  return {
    root, builtinDir, userDir, extensionDir, workspaceDir, privateTempRoot, inputPath, inputArtifact,
    capability: inventory.capabilities[0],
  }
}

function request(
  capability: AgentCapabilitySnapshotV1,
  inputArtifact: ArtifactRefV1,
  actionId: string,
  mode: string,
  signal = new AbortController().signal,
): AgentActionExecutorRequest {
  return Object.freeze({
    actionId,
    originSessionId: 'session-governed',
    capability,
    arguments: { input: 'chair', params: { mode } },
    model,
    inputArtifacts: [inputArtifact],
    signal,
  })
}

async function rejectsProcess(promise: Promise<unknown>, code: AgentProcessExecutorError['code']): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AgentProcessExecutorError)
    assert.equal(error.code, code)
    return true
  })
}

test('governed process publishes verified multiple artifacts atomically and rollback is idempotent', async () => {
  const value = await fixture()
  try {
    const executor = createAgentProcessExecutor({
      getWorkspaceRoot: () => value.workspaceDir,
      getPrivateTempRoot: () => value.privateTempRoot,
      resolveTarget: async () => ({ capability: value.capability, extensionDir: value.extensionDir, entry: 'processor.mjs' }),
      resolveCurrentModel: async () => model,
    })
    await executor.ensureReady(value.capability)
    const result = await executor.execute(request(value.capability, value.inputArtifact, 'action-honest', 'honest'))
    assert.deepEqual(result.artifacts.map((artifact) => [artifact.kind, artifact.mediaType]), [
      ['plan', 'text/markdown'], ['glb', 'model/gltf-binary'],
    ])
    assert.equal(await readFile(join(value.workspaceDir, result.artifacts[0].workspacePath), 'utf8'), '# Plan\napproved input\n')
    assert.equal(result.artifacts[1].sha256, createHash('sha256').update('glTF').digest('hex'))
    await result.rollback()
    await result.rollback()
    await assert.rejects(access(join(value.workspaceDir, 'Workflows', 'agent-actions', 'action-honest')))
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('governed process accepts one bounded terminal child error and publishes nothing', async () => {
  const value = await fixture()
  try {
    const executor = createAgentProcessExecutor({
      getWorkspaceRoot: () => value.workspaceDir,
      getPrivateTempRoot: () => value.privateTempRoot,
      resolveTarget: async () => ({ capability: value.capability, extensionDir: value.extensionDir, entry: 'processor.mjs' }),
      resolveCurrentModel: async () => model,
    })
    await assert.rejects(
      executor.execute(request(value.capability, value.inputArtifact, 'action-terminal-error', 'terminal-error')),
      (error: unknown) => {
        assert.ok(error instanceof AgentProcessTerminalError)
        assert.equal(error.code, 'execution_failed')
        assert.deepEqual(error.terminal, {
          code: 'model_binding_unavailable',
          message: 'The approved model binding is unavailable.',
          details: { retryable: true, stage: 'model_binding' },
        })
        return true
      },
    )
    await assert.rejects(access(join(value.workspaceDir, 'Workflows', 'agent-actions', 'action-terminal-error')))
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('governed process rejects reserved context, descriptor forgery, output abuse, caps, hangs, and runtime swaps without publication', async (t) => {
  const modes = [
    ['path', 'invalid_artifact'],
    ['symlink', 'invalid_artifact'],
    ['oversize', 'artifact_too_large'],
    ['digest', 'invalid_artifact'],
    ['partial', 'invalid_artifact'],
    ['log-flood', 'protocol_error'],
    ['terminal-after', 'protocol_error'],
    ['terminal-error-code', 'protocol_error'],
    ['terminal-error-message', 'protocol_error'],
    ['terminal-error-artifacts', 'protocol_error'],
    ['terminal-error-after', 'protocol_error'],
    ['terminal-error-stderr', 'protocol_error'],
    ['hang', 'timeout'],
  ] as const
  for (const [mode, code] of modes) {
    await t.test(mode, async () => {
      const value = await fixture()
      try {
        const executor = createAgentProcessExecutor({
          getWorkspaceRoot: () => value.workspaceDir,
          getPrivateTempRoot: () => value.privateTempRoot,
          resolveTarget: async () => ({ capability: value.capability, extensionDir: value.extensionDir, entry: 'processor.mjs' }),
          resolveCurrentModel: async () => model,
          limits: mode === 'hang'
            ? { startupMs: 5_000, idleMs: 5_000, totalMs: 10_000, terminationGraceMs: 500, maxLogBytes: 256 }
            : { startupMs: 10_000, idleMs: 5_000, totalMs: 15_000, terminationGraceMs: 500, maxLogBytes: 256 },
        })
        if (mode === 'hang') await executor.ensureReady(value.capability)
        await rejectsProcess(executor.execute(request(value.capability, value.inputArtifact, `action-${mode}`, mode)), code)
        await assert.rejects(access(join(value.workspaceDir, 'Workflows', 'agent-actions', `action-${mode}`)))
      } finally {
        await rm(value.root, { recursive: true, force: true })
      }
    })
  }

  await t.test('trustedContext argument', async () => {
    const value = await fixture()
    try {
      const executor = createAgentProcessExecutor({
        getWorkspaceRoot: () => value.workspaceDir,
        getPrivateTempRoot: () => value.privateTempRoot,
        resolveTarget: async () => ({ capability: value.capability, extensionDir: value.extensionDir, entry: 'processor.mjs' }),
        resolveCurrentModel: async () => model,
      })
      const forged = {
        ...request(value.capability, value.inputArtifact, 'action-forged', 'forged'),
        arguments: { trustedContext: { actionId: 'attacker' } },
      } as AgentActionExecutorRequest
      await rejectsProcess(executor.execute(forged), 'invalid_arguments')
    } finally {
      await rm(value.root, { recursive: true, force: true })
    }
  })

  await t.test('runtime swap', async () => {
    const value = await fixture()
    try {
      const executor = createAgentProcessExecutor({
        getWorkspaceRoot: () => value.workspaceDir,
        getPrivateTempRoot: () => value.privateTempRoot,
        resolveTarget: async () => ({ capability: value.capability, extensionDir: value.extensionDir, entry: 'processor.mjs' }),
        resolveCurrentModel: async () => model,
      })
      await executor.ensureReady(value.capability)
      await writeFile(join(value.extensionDir, 'processor.mjs'), `${processor}\n// swapped\n`)
      await rejectsProcess(executor.execute(request(value.capability, value.inputArtifact, 'action-swap', 'honest')), 'capability_stale')
    } finally {
      await rm(value.root, { recursive: true, force: true })
    }
  })

  await t.test('opened runtime and input handles remain authoritative after path replacement', async () => {
    const value = await fixture()
    try {
      let targetResolutions = 0
      let modelResolutions = 0
      const executor = createAgentProcessExecutor({
        getWorkspaceRoot: () => value.workspaceDir,
        getPrivateTempRoot: () => value.privateTempRoot,
        resolveTarget: async () => {
          targetResolutions += 1
          if (targetResolutions === 2) {
            const replacement = join(value.extensionDir, 'replacement.mjs')
            await writeFile(replacement, "throw new Error('replacement runtime executed')\n")
            await rename(replacement, join(value.extensionDir, 'processor.mjs'))
            const resourceReplacement = join(value.extensionDir, 'replacement-resource.json')
            await writeFile(resourceReplacement, '{"runtime":false}\n')
            await rename(resourceReplacement, join(value.extensionDir, 'assets', 'runtime-data.json'))
          }
          return { capability: value.capability, extensionDir: value.extensionDir, entry: 'processor.mjs' }
        },
        resolveCurrentModel: async () => {
          modelResolutions += 1
          if (modelResolutions === 2) {
            const replacement = join(value.workspaceDir, 'replacement-input.txt')
            await writeFile(replacement, 'attacker input\n')
            await rename(replacement, value.inputPath)
          }
          return model
        },
      })
      const result = await executor.execute(request(value.capability, value.inputArtifact, 'action-fd-authority', 'honest'))
      assert.equal(await readFile(join(value.workspaceDir, result.artifacts[0].workspacePath), 'utf8'), '# Plan\napproved input\n')
      await result.rollback()
    } finally {
      await rm(value.root, { recursive: true, force: true })
    }
  })

  await t.test('readiness fails closed off Linux', async () => {
    const value = await fixture()
    try {
      const executor = createAgentProcessExecutor({
        getWorkspaceRoot: () => value.workspaceDir,
        getPrivateTempRoot: () => value.privateTempRoot,
        resolveTarget: async () => ({ capability: value.capability, extensionDir: value.extensionDir, entry: 'processor.mjs' }),
        resolveCurrentModel: async () => model,
        platform: 'darwin',
      })
      await rejectsProcess(executor.ensureReady(value.capability), 'runtime_unavailable')
    } finally {
      await rm(value.root, { recursive: true, force: true })
    }
  })

  await t.test('process-tree cancellation', async () => {
    if (process.platform !== 'linux') return
    const value = await fixture()
    let unrelated: ReturnType<typeof spawn> | undefined
    try {
      const controller = new AbortController()
      const executor = createAgentProcessExecutor({
        getWorkspaceRoot: () => value.workspaceDir,
        getPrivateTempRoot: () => value.privateTempRoot,
        resolveTarget: async () => ({ capability: value.capability, extensionDir: value.extensionDir, entry: 'processor.mjs' }),
        resolveCurrentModel: async () => model,
        limits: { startupMs: 10_000, idleMs: 10_000, totalMs: 20_000, terminationGraceMs: 500 },
      })
      unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'modly-agent-unrelated-marker'], { stdio: 'ignore' })
      const running = executor.execute(request(value.capability, value.inputArtifact, 'action-tree', 'tree', controller.signal))
      let treePid = 0
      const treeStartDeadline = Date.now() + 10_000
      while (treePid === 0 && Date.now() < treeStartDeadline) {
        const stages = await readdir(value.privateTempRoot).catch(() => [])
        const stage = stages.find((name) => name.startsWith('action-tree-'))
        if (stage) {
          assert.deepEqual((await readdir(join(value.privateTempRoot, stage))).sort(), ['output', 'publish'])
          treePid = Number(await readFile(join(value.privateTempRoot, stage, 'output', 'tree.pid'), 'utf8').catch(() => '0'))
        }
        if (!treePid) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.ok(treePid > 0)
      controller.abort()
      await rejectsProcess(running, 'aborted')
      const treeExitDeadline = Date.now() + 10_000
      while (Date.now() < treeExitDeadline) {
        try { process.kill(treePid, 0) } catch { treePid = 0; break }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.equal(treePid, 0)
      assert.doesNotThrow(() => process.kill(unrelated!.pid!, 0))
      unrelated.kill('SIGKILL')
      assert.equal((await stat(value.privateTempRoot)).mode & 0o077, 0)
      const publicationRoot = join(value.workspaceDir, 'Workflows', 'agent-actions')
      assert.deepEqual((await readdir(publicationRoot)).filter((name) => name.includes('action-tree')), [])
    } finally {
      unrelated?.kill('SIGKILL')
      await rm(value.root, { recursive: true, force: true })
    }
  })
})

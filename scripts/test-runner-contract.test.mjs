import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const EXPECTED_TYPESCRIPT_TESTS = [
  'src/shared/types/assetLibrary.test.ts',
  'src/shared/utils/agentModels.test.ts',
  'src/shared/stores/agentSessionsStore.test.ts',
  'src/areas/generate/agentDirectActions.test.ts',
  'src/areas/generate/assetLibraryProjection.test.ts',
  'src/areas/generate/assetLibraryService.test.ts',
  'src/areas/generate/assetLibraryUi.test.ts',
  'src/areas/generate/components/ChatPanel.test.ts',
  'src/areas/settings/components/AgentSection.test.ts',
  'src/areas/workflows/preflight.test.ts',
  'electron/main/agent-actions-ipc.test.ts',
  'electron/main/agent-actions-service.test.ts',
  'electron/main/agent-artifact-verifier.test.ts',
  'electron/main/agent-capability-discovery.test.ts',
  'electron/main/agent-mcp-broker.test.ts',
  'electron/main/agent-mcp-manifest.test.ts',
  'electron/main/agent-model-access-gateway.test.ts',
  'electron/main/agent-model-access-runtime.test.ts',
  'electron/main/agent-model-free-process-composition.test.ts',
  'electron/main/agent-ollama-gpu-device-authority.test.ts',
  'electron/main/agent-ollama-model-store.test.ts',
  'electron/main/agent-ollama-runtime-tree.test.ts',
  'electron/main/agent-ollama-private-daemon.test.ts',
  'electron/main/agent-owned-process.test.ts',
  'electron/main/agent-process-executor.test.ts',
  'electron/main/agent-process-python-discovery.test.ts',
  'electron/main/agent-process-python-executor.test.ts',
  'electron/main/agent-process-python-runtime.test.ts',
  'electron/main/agent-skills-manifest.test.ts',
  'electron/main/agent-workflow-authority.test.ts',
  'electron/main/agent-workflows-ipc.test.ts',
  'electron/main/renderer-filesystem-access.test.ts',
  'electron/main/agent-session-store.test.ts',
  'electron/main/agent-trust-contracts.test.ts',
  'electron/main/artifact-registry-service.test.ts',
  'electron/main/extension-path-guard.test.ts',
  'electron/preload/agent-actions-preload.test.ts',
  'electron/preload/agent-capabilities-preload.test.ts',
  'electron/preload/agent-sessions-preload.test.ts',
  'electron/preload/agent-workflows-preload.test.ts',
  'electron/preload/artifact-registry-preload.test.ts',
]

test('canonical Node test command delegates to the bounded deterministic runner', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const command = packageJson.scripts?.['test:node']

  assert.equal(command, 'node scripts/run-node-tests.mjs')
})

test('deterministic runner awaits each process, inherits output, and propagates the exact failure code', async () => {
  const { runNodeTestPlan } = await import('./run-node-tests.mjs')
  const plan = [
    { phase: 'typescript', file: 'first.test.ts', args: ['--test', 'first.test.ts'] },
    { phase: 'mjs', file: 'second.test.mjs', args: ['--test', 'second.test.mjs'] },
  ]
  const starts = []
  let active = 0
  let maximumActive = 0
  const spawnProcess = (executable, args, options) => {
    assert.equal(executable, process.execPath)
    assert.equal(options.cwd, '/repo')
    assert.equal(options.stdio, 'inherit')
    const child = new EventEmitter()
    starts.push(args.at(-1))
    active += 1
    maximumActive = Math.max(maximumActive, active)
    setImmediate(() => {
      active -= 1
      child.emit('exit', 0, null)
    })
    return child
  }
  const output = []
  await runNodeTestPlan(plan, '/repo', { spawnProcess, write: (value) => output.push(value) })
  assert.deepEqual(starts, ['first.test.ts', 'second.test.mjs'])
  assert.equal(maximumActive, 1)
  assert.equal(output.length, 2)

  await assert.rejects(
    runNodeTestPlan([plan[0]], '/repo', {
      spawnProcess: () => {
        const child = new EventEmitter()
        setImmediate(() => child.emit('exit', 7, null))
        return child
      },
      write: () => undefined,
    }),
    (error) => {
      assert.equal(error.exitCode, 7)
      assert.match(error.message, /first\.test\.ts failed with exit code 7/)
      return true
    },
  )
})

test('deterministic runner includes every canonical suite once and runs both phases serially per file', async () => {
  const { createNodeTestPlan } = await import('./run-node-tests.mjs')
  const plan = await createNodeTestPlan(new URL('..', import.meta.url))
  const typescriptFiles = plan.filter((invocation) => invocation.phase === 'typescript')
    .map((invocation) => invocation.file)
  assert.deepEqual(typescriptFiles, EXPECTED_TYPESCRIPT_TESTS)

  const mjsFiles = plan.filter((invocation) => invocation.phase === 'mjs')
    .map((invocation) => invocation.file)
  assert.ok(mjsFiles.includes('scripts/test-runner-contract.test.mjs'))
  assert.equal(new Set(mjsFiles).size, mjsFiles.length)
  assert.deepEqual(mjsFiles, [...mjsFiles].sort((left, right) => left < right ? -1 : left > right ? 1 : 0))

  assert.equal(plan.length, typescriptFiles.length + mjsFiles.length)
  for (const invocation of plan) {
    assert.deepEqual(invocation.args.slice(0, 2), ['--test', '--test-concurrency=1'])
    assert.equal(invocation.args.some((argument) => argument.startsWith('--test-isolation')), false)
    assert.equal(invocation.args.at(-1), invocation.file)
    assert.equal(invocation.args.filter((argument) => argument === invocation.file).length, 1)
    if (invocation.phase === 'typescript') {
      assert.deepEqual(invocation.args.slice(3, 5), [
        '--experimental-loader',
        './scripts/node-ts-extensionless-loader.mjs',
      ])
    }
  }
})

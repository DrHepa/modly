import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repositoryUrl = new URL('../', import.meta.url)
const projects = ['tsconfig.node.json', 'tsconfig.web.json', 'tsconfig.worlds-integration.json']

test('typecheck command runs the aggregate while preserving individual configured lanes', async () => {
  const { scripts } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(scripts.typecheck, 'node scripts/run-typechecks.mjs')
  for (const [index, lane] of ['node', 'web', 'worlds-integration'].entries()) {
    assert.equal(scripts[`typecheck:${lane}`], `tsc --noEmit -p ${projects[index]}`)
  }
})

test('integration typecheck owns the real test and ambient roots without weakening the web project', async () => {
  const web = JSON.parse(await readFile(new URL('../tsconfig.web.json', import.meta.url), 'utf8'))
  const integration = JSON.parse(await readFile(new URL('../tsconfig.worlds-integration.json', import.meta.url), 'utf8'))
  const diskWorkflowTest = 'src/areas/worlds/components/WorldsWorkbench.diskWorkflow.test.ts'
  const playablePortalLoopMountedTest = 'src/areas/worlds/components/WorldsWorkbench.playablePortalLoop.mounted.test.ts'
  const integrationTest = 'src/areas/worlds/editor/worldEditorRepositoryIntegration.test.ts'
  assert.equal(web.compilerOptions.composite, true)
  assert.deepEqual(web.include, ['src/**/*'])
  assert.deepEqual(web.exclude, [
    'src/areas/workflows/nodes/mesh-exporter',
    'src/areas/workflows/nodes/mesh-optimizer',
    diskWorkflowTest,
    playablePortalLoopMountedTest,
    integrationTest,
  ])
  assert.equal(integration.extends, './tsconfig.web.json')
  assert.deepEqual(integration.compilerOptions, {
    composite: false, incremental: false, noEmit: true, types: ['node'],
  })
  assert.deepEqual(integration.files, [diskWorkflowTest, playablePortalLoopMountedTest, integrationTest])
  assert.deepEqual(integration.include, ['src/vite-env.d.ts', 'src/shared/types/**/*.d.ts'])
  assert.ok(
    !integration.files.some((entry) => entry.includes('*'))
      && !integration.include.some((entry) => entry.includes('*') && /test/i.test(entry)),
    'integration typecheck must own exact heavy tests, not a broad test glob',
  )
  assert.deepEqual(integration.exclude, [])
})

test('typecheck runner awaits each configured project and inherits diagnostics without a shell', async () => {
  const { runTypechecks } = await import('./run-typechecks.mjs')
  const root = join(fileURLToPath(repositoryUrl), 'path with spaces')
  const calls = []
  const children = []
  const output = []
  const completion = runTypechecks(root, {
    spawnProcess: (executable, args, options) => {
      assert.equal(executable, process.execPath)
      assert.deepEqual(args, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', projects[calls.length]])
      assert.deepEqual(options, { cwd: root, env: process.env, stdio: 'inherit' })
      calls.push(args.at(-1))
      const child = new EventEmitter()
      children.push(child)
      return child
    },
    write: (message) => output.push(message),
  })
  for (let index = 0; index < projects.length; index += 1) {
    assert.deepEqual(calls, projects.slice(0, index + 1))
    children[index].emit('close', 0, null)
    await nextTurn()
  }
  assert.equal(await completion, 0)
  assert.deepEqual(output, projects.map((project) => `[typecheck] ${project}`))
})

async function runWithOutcomes(outcomes) {
  const { runTypechecks } = await import('./run-typechecks.mjs')
  const calls = []
  const output = []
  const code = await runTypechecks(fileURLToPath(repositoryUrl), {
    spawnProcess: (_executable, args) => {
      const outcome = outcomes[calls.length]
      calls.push(args.at(-1))
      if (outcome === 'throw') throw new Error('synchronous spawn failure')
      const child = new EventEmitter()
      setImmediate(() => {
        if (outcome === 'error') child.emit('error', new Error('spawn ENOENT'))
        else child.emit('close', outcome === 'signal' ? null : outcome, outcome === 'signal' ? 'SIGTERM' : null)
      })
      return child
    },
    write: (message) => output.push(message),
  })
  assert.deepEqual(calls, projects)
  return { code, output }
}

test('typecheck runner reaches integration after diagnostic failures and retains the first failure code', async () => {
  assert.equal((await runWithOutcomes([2, 1, 0])).code, 2)
})

test('typecheck runner reports an asynchronous spawn failure and still runs later projects', async () => {
  const result = await runWithOutcomes(['error', 0, 0])
  assert.equal(result.code, 1)
  assert.ok(result.output.some((message) => message.includes('tsconfig.node.json') && message.includes('spawn ENOENT')))
})

test('typecheck runner reports a synchronous spawn failure and still runs later projects', async () => {
  const result = await runWithOutcomes(['throw', 0, 0])
  assert.equal(result.code, 1)
  assert.ok(result.output.some((message) => message.includes('synchronous spawn failure')))
})

test('typecheck runner treats a terminated compiler as failure without skipping later projects', async () => {
  const result = await runWithOutcomes(['signal', 0, 0])
  assert.equal(result.code, 1)
  assert.ok(result.output.some((message) => message.includes('SIGTERM')))
})

test('typecheck runner reports success only when all three configured projects pass', async () => {
  assert.equal((await runWithOutcomes([0, 0, 0])).code, 0)
})

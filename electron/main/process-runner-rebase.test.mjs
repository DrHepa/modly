import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Worker } from 'node:worker_threads'
import vm from 'node:vm'

function loadRunner({ packaged = false } = {}) {
  const workers = []
  const children = []
  class FixtureWorker extends EventEmitter {
    constructor() { super(); workers.push(this); this.terminations = 0 }
    postMessage() {}
    terminate() { this.terminations += 1; return Promise.resolve(0) }
  }
  const spawn = (_exe, _args, options) => {
    const proc = new EventEmitter()
    proc.options = options
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.stdin = Object.assign(new EventEmitter(), { write() {}, end() {} })
    proc.kills = 0
    proc.kill = () => { proc.kills += 1; return true }
    children.push(proc)
    return proc
  }
  const require = createRequire(import.meta.url)
  const module = { exports: {} }
  const result = buildSync({
    entryPoints: [resolve(process.env.MODLY_RUNNER_TEST_SOURCE ?? 'electron/main/process-runner.ts')],
    bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'],
  })
  vm.runInNewContext(result.outputFiles[0].text, {
    module, exports: module.exports, Buffer, console,
    process: { env: process.env, execPath: process.execPath, resourcesPath: '/fixture/resources' },
    require: (name) => name === 'electron'
      ? { app: { isPackaged: packaged, getAppPath: () => '/fixture/app' } }
      : name === 'worker_threads' ? { Worker: FixtureWorker }
        : name === 'child_process' ? { spawn } : require(name),
  })
  return { ...module.exports, workers, children }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))
const done = (proc, text = 'done') => proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'done', result: { text } }) + '\n'))

test('JS cancellation owns startup and removes the pending message listener', async () => {
  const { ProcessRunner, workers } = loadRunner()
  const runner = new ProcessRunner('/fixture/ext', 'processor.js', '/fixture/workspace', '/fixture/temp')
  const pending = runner.run({}, {})
  let error
  pending.catch((value) => { error = value })
  runner.terminate()
  await flush()
  assert.match(error?.message ?? '', /terminated/)
  assert.equal(workers[0].terminations, 1)
  assert.equal(workers[0].listenerCount('message'), 0)
})

test('JS mid-run cancellation has one cleanup owner and a later run gets a fresh worker', async () => {
  const { ProcessRunner, workers } = loadRunner()
  const runner = new ProcessRunner('/fixture/ext', 'processor.js', '/fixture/workspace', '/fixture/temp')
  const pending = runner.run({}, {})
  workers[0].emit('message', { type: 'ready' })
  await flush()
  const rejection = assert.rejects(pending, /terminated/)
  runner.terminate()
  await rejection
  assert.equal(workers[0].listenerCount('message'), 0)
  const next = runner.run({}, {})
  workers[1].emit('message', { type: 'ready' })
  await flush()
  workers[0].emit('exit', 1)
  workers[1].emit('message', { type: 'done', result: { text: 'next' } })
  assert.equal((await next).text, 'next')
  runner.terminate()
})

test('a JS worker exit before ready settles startup rather than hanging', async () => {
  const { ProcessRunner, workers } = loadRunner()
  const runner = new ProcessRunner('/fixture/ext', 'processor.js', '/fixture/workspace', '/fixture/temp')
  const pending = runner.run({}, {})
  let error
  pending.catch((value) => { error = value })
  workers[0].emit('exit', 9)
  await flush()
  assert.match(error?.message ?? '', /exited with code 9/)
  runner.terminate()
})

test('late Python close cannot clear the next run cancellation identity', async () => {
  const { PythonProcessRunner, children } = loadRunner()
  const runner = new PythonProcessRunner('fixture-python', '/fixture/ext', 'processor.py', '/fixture/workspace', '/fixture/temp')
  const first = runner.run({}, {})
  done(children[0], 'first')
  assert.equal((await first).text, 'first')
  const second = runner.run({}, {})
  children[0].emit('close', 0)
  const rejection = assert.rejects(second, /terminated/)
  runner.terminate()
  await rejection
  assert.equal(children[1].kills, 1)
})

test('a Python done result still permits run-scoped resource cleanup', async () => {
  const { PythonProcessRunner, children } = loadRunner()
  const runner = new PythonProcessRunner('fixture-python', '/fixture/ext', 'processor.py', '/fixture/workspace', '/fixture/temp')
  const pending = runner.run({}, {})
  done(children[0])
  await pending
  runner.terminate()
  runner.terminate()
  assert.equal(children[0].kills, 1)
})

for (const packaged of [false, true]) {
  test(`Python ${packaged ? 'packaged' : 'development'} env preserves UTF-8 and runtime/workspace paths`, async () => {
    const { PythonProcessRunner, children } = loadRunner({ packaged })
    const runner = new PythonProcessRunner('fixture-python', '/fixture/ext', 'processor.py', '/fixture/workspace', '/fixture/temp')
    const pending = runner.run({}, {})
    const env = children[0].options.env
    done(children[0])
    await pending
    runner.terminate()
    assert.equal(env?.PYTHONUTF8, '1')
    assert.equal(env?.MODLY_API_DIR, packaged ? '/fixture/resources/api' : '/fixture/app/api')
    assert.equal(env?.MODLY_NODE_EXECUTABLE, process.execPath)
    assert.equal(env?.EXTENSION_DIR, '/fixture/ext')
    assert.equal(env?.WORKSPACE_DIR, '/fixture/workspace')
    assert.equal(env?.TEMP_DIR, '/fixture/temp')
  })
}

test('run-scoped factories never share the ordinary cached JS runner', () => {
  const { createRunScopedProcessRunner, getProcessRunner, terminateAllProcessRunners } = loadRunner()
  const options = { extDir: '/fixture/ext', entry: 'processor.js', workspaceDir: '/fixture/workspace', tempDir: '/fixture/temp' }
  const a = createRunScopedProcessRunner(options)
  const b = createRunScopedProcessRunner(options)
  const cached = getProcessRunner('fixture', options.extDir, options.entry, options.workspaceDir, options.tempDir)
  assert.notEqual(a, b)
  assert.notEqual(a, cached)
  a.terminate(); b.terminate(); terminateAllProcessRunners()
})

function bounded(promise, label, timeout = 1500) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeout) }),
  ]).finally(() => clearTimeout(timer))
}

function realWorkerFixture() {
  const workers = []
  class TrackedWorker extends Worker {
    constructor(...args) {
      super(...args)
      workers.push(this)
      this.exited = new Promise((resolve) => this.once('exit', resolve))
    }
  }
  const require = createRequire(import.meta.url)
  const module = { exports: {} }
  const result = buildSync({
    entryPoints: [resolve(process.env.MODLY_RUNNER_TEST_SOURCE ?? 'electron/main/process-runner.ts')],
    bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'],
  })
  vm.runInNewContext(result.outputFiles[0].text, {
    module, exports: module.exports, Buffer, process, console,
    require: (name) => name === 'worker_threads' ? { Worker: TrackedWorker }
      : name === 'electron' ? { app: {} } : require(name),
  })
  const root = mkdtempSync(join(tmpdir(), 'modly-runner-rebase-real-'))
  writeFileSync(join(root, 'processor.js'), `
let runs = 0
module.exports = async (input, params, context) => {
  runs += 1
  context.log(input.text)
  context.progress(25, input.text)
  if (params.hang) return new Promise(() => {})
  if (params.exit) process.exit(7)
  if (params.delay) await new Promise(resolve => setTimeout(resolve, params.delay))
  return { text: input.text + ':' + runs }
}
`)
  const runner = new module.exports.ProcessRunner(root, 'processor.js', root, root)
  return {
    runner, workers,
    async assertStopped() {
      await bounded(Promise.all(workers.map((worker) => worker.exited)), 'Worker cleanup')
      assert.ok(workers.every((worker) => worker.threadId === -1))
      assert.ok(workers.every((worker) => worker.listenerCount('message') === 0))
    },
    async cleanup() {
      // Test-owned fallback cleanup happens after assertions, so it cannot
      // conceal an orphaned Worker from the runner. Even RED leaves no threads.
      runner.terminate()
      await Promise.all(workers.map((worker) => worker.terminate()))
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test('real Workers serialize cold and warm overlapping calls with distinct results and callbacks', { timeout: 5000 }, async () => {
  const fixture = realWorkerFixture()
  const { runner, workers } = fixture
  try {
    for (const [offset, labels] of [[0, ['first', 'second']], [2, ['third', 'fourth']]]) {
      const logs = [[], []]
      const progress = [[], []]
      const calls = labels.map((text, index) => runner.run(
        { text }, { delay: index === 0 ? 40 : 0 },
        (_percent, label) => progress[index].push(label),
        (message) => logs[index].push(message),
      ))
      const results = await bounded(Promise.all(calls), 'Overlapping invocations')
      assert.deepEqual(results.map((result) => result.text), labels.map((label, index) => `${label}:${offset + index + 1}`))
      assert.deepEqual(logs, labels.map((label) => [label]))
      assert.deepEqual(progress, labels.map((label) => [label]))
      assert.equal(workers.length, 1)
    }
    runner.terminate()
    await fixture.assertStopped()
  } finally { await fixture.cleanup() }
})

for (const cancelDuringStartup of [true, false]) {
  test(`real Worker cancellation settles active and queued calls ${cancelDuringStartup ? 'during startup' : 'during execution'} and permits restart`, { timeout: 5000 }, async () => {
    const fixture = realWorkerFixture()
    const { runner, workers } = fixture
    try {
      let signalStarted
      const started = new Promise((resolve) => { signalStarted = resolve })
      const states = ['active', 'queued'].map((text) => runner.run({ text }, { hang: true }, () => signalStarted()).then(
        () => 'unexpected success', (error) => error.message,
      ))
      if (!cancelDuringStartup) await bounded(started, 'Active invocation')
      runner.terminate()
      const results = await bounded(Promise.all(states), 'Canceled invocations')
      assert.ok(results.every((message) => /terminated/.test(message)), JSON.stringify(results))
      await fixture.assertStopped()
      assert.equal(workers.length, 1)
      assert.equal((await bounded(runner.run({ text: 'fresh' }, {}), 'Restart')).text, 'fresh:1')
      assert.equal(workers.length, 2)
      runner.terminate()
      await fixture.assertStopped()
    } finally { await fixture.cleanup() }
  })
}

test('real Worker structured-clone rejection leaves healthy worker owned for queued reuse and cleanup', { timeout: 5000 }, async () => {
  const fixture = realWorkerFixture()
  const { runner, workers } = fixture
  try {
    const invalid = runner.run({}, { uncloneable: () => {} })
    const rejected = assert.rejects(invalid, (error) => /could not be cloned/.test(error.message))
    const valid = runner.run({ text: 'valid' }, {})
    await bounded(rejected, 'Clone failure')
    assert.equal((await bounded(valid, 'Valid queued invocation')).text, 'valid:1')
    assert.equal(workers.length, 1)
    runner.terminate()
    await fixture.assertStopped()
    assert.equal((await bounded(runner.run({ text: 'fresh' }, {}), 'Restart')).text, 'fresh:1')
    runner.terminate()
    await fixture.assertStopped()
  } finally { await fixture.cleanup() }
})

test('real Worker structured-clone rejection remains reachable by terminate without another run', { timeout: 5000 }, async () => {
  const fixture = realWorkerFixture()
  const { runner } = fixture
  try {
    await bounded(assert.rejects(
      runner.run({}, { uncloneable: () => {} }),
      (error) => /could not be cloned/.test(error.message),
    ), 'Clone failure')
    runner.terminate()
    await fixture.assertStopped()
  } finally { await fixture.cleanup() }
})

test('real Worker death rejects its invocation and the queued invocation gets a fresh worker', { timeout: 5000 }, async () => {
  const fixture = realWorkerFixture()
  const { runner, workers } = fixture
  try {
    const failed = assert.rejects(runner.run({ text: 'exiting' }, { exit: true }), /exited with code 7/)
    const next = runner.run({ text: 'next' }, {})
    await bounded(failed, 'Worker exit rejection')
    assert.equal((await bounded(next, 'Queued recovery')).text, 'next:1')
    assert.equal(workers.length, 2)
    runner.terminate()
    await fixture.assertStopped()
  } finally { await fixture.cleanup() }
})

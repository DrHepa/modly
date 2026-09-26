#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { closeSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// A real --test child must start before entering node:test, never recursively inside it.
// Keep the legacy optional MODLY_NODE_RUNNER_EVIDENCE_DIR private/realpath/0700 contract.
// Every captured stream is also published before fixture cleanup, including assertion failure.
export const REQUIRED_AUTHORING_GUARD_TEST_NAMES = Object.freeze([
  'N1 admits only separately reviewed inherited-display mode without native flags',
  'N2 preserves every inherited environment field and never creates display authentication',
  'WSNAV1 WorldSculpt navigation requires inherited display and excludes local AI',
  'WSNAV2 WorldSculpt build input admission rejects aliases nonregular files and invalid GLB bytes',
  'WSNAV3 WorldSculpt runtime contract exposes only one hash-bound private path',
  'WSNAV4 native navigation terminal rejects untrusted input pointer lock GPU and cleanup failures',
  'WSNAV5 renderer observation treats absent OrbitControls as pending without weakening navigation readiness',
  'WSNAV6 durable witness replays actual v2 and retains exact v1 compatibility',
  'N3 numeric evidence rejects no-op, wrong captured owner and unrelated canonical changes',
  'N4 both authored scenes require models, one primary camera, light and a genuinely fresh reopen',
  'F1 binds held and committed transforms to the same final preview, not any nonzero change',
  'F1 rejects cross-axis, rotation, scale, no-op and nonfinite preview leakage',
  'F2 records exact absent paths independently of process exit',
  'F2 fails remaining/replaced paths without deleting files or following a symlink',
  'S1 classifies generated evidence metadata without following targets or hashing regular files',
  'S2 strictly remembers existing resolved filesystem modules and leaves virtual IDs to Vite',
  'S3 rechecks cached and verified input types and still rejects changed file bytes',
  'NS1 rejects ready exact-revision numeric observations while the production pending marker remains',
  'NS2 admits ready exact-revision numeric observations after the pending marker clears',
  'NS3 rejects loading and wrong-revision numeric observations even without a pending marker',
  'NS4 keeps settled Inspector count disability and value errors outside the wait boundary',
  'AI1P local-AI paths materialize only from a canonical relocated repository root',
  'P1 repository admissions bind relocated main and runner consumers before source reads or spawning',
])
export const EXPECTED_AUTHORING_GUARD_TEST_COUNT = 303

export function parseAuthoringGuardTapNames(stdout) {
  return [...stdout.matchAll(/^ok \d+ - (.+)$/gm)].map((match) => match[1])
}

export function parseAuthoringGuardSpecNames(stdout) {
  return [...stdout.matchAll(/^[✔﹣] (.+)$/gm)].map((match) => match[1]
    .replace(/ # .+$/, '')
    .replace(/ \([0-9.]+ms\)$/, ''))
}

export function parseAuthoringGuardObservedNames(stdout) {
  const tapNames = parseAuthoringGuardTapNames(stdout)
  return tapNames.length > 0 ? tapNames : parseAuthoringGuardSpecNames(stdout)
}

export function createAuthoringGuardChildEnvironment(parentEnv, externalRoot) {
  const env = { ...parentEnv, WORLD_AUTHORING_GUARD_SKIP_NETWORK: '1' }
  if (externalRoot === undefined) delete env.WORLD_AUTHORING_GUARD_TEST_ROOT
  else env.WORLD_AUTHORING_GUARD_TEST_ROOT = externalRoot
  return env
}

export function assertRequiredAuthoringGuardNames(actualNames) {
  for (const name of REQUIRED_AUTHORING_GUARD_TEST_NAMES) {
    assert.ok(actualNames.includes(name), `Missing required authoring guard test: ${name}`)
  }
}

export function assertAuthoringGuardInventory(stdout) {
  const actualNames = parseAuthoringGuardObservedNames(stdout)
  assertRequiredAuthoringGuardNames(actualNames)
  assert.equal(actualNames.length, EXPECTED_AUTHORING_GUARD_TEST_COUNT)
  const summary = Object.fromEntries([...stdout.matchAll(/^(?:#|ℹ) (tests|pass|fail|cancelled|skipped) ([0-9]+)$/gm)]
    .map((match) => [match[1], Number(match[2])]))
  assert.equal(summary.tests, EXPECTED_AUTHORING_GUARD_TEST_COUNT)
  assert.equal(summary.fail, 0)
  assert.equal(summary.cancelled, 0)
  assert.equal((summary.pass ?? 0) + (summary.skipped ?? 0), EXPECTED_AUTHORING_GUARD_TEST_COUNT)
  return actualNames
}

async function publish(label, bytes) {
  for (const value of [`[dispatch-proof] BEGIN ${label} bytes=${bytes.length}\n`, bytes,
    `\n[dispatch-proof] END ${label}\n`]) {
    await new Promise((resolveWrite, reject) => process.stdout.write(value, (error) => error ? reject(error) : resolveWrite()))
  }
}

async function collectGuardInventory(invocation, repositoryRoot, scratch) {
  const inventoryArgs = invocation.args.filter((argument) => (
    argument !== '--test' &&
    argument !== '--test-concurrency=1' &&
    argument !== '--test-reporter=tap'
  ))
  const inventoryStdoutPath = join(scratch, 'guard-inventory.stdout.log')
  const inventoryStderrPath = join(scratch, 'guard-inventory.stderr.log')
  const stdoutFd = openSync(inventoryStdoutPath, 'wx')
  const stderrFd = openSync(inventoryStderrPath, 'wx')
  const env = createAuthoringGuardChildEnvironment(process.env)
  assert.equal(process.env.WORLD_AUTHORING_GUARD_SKIP_NETWORK, undefined,
    'Collecting guard inventory must not mutate the parent environment')
  const child = spawn(process.execPath, inventoryArgs, { cwd: repositoryRoot, env, stdio: ['ignore', stdoutFd, stderrFd] })
  let exitCode, exitSignal, childError
  child.once('error', (error) => { childError = error })
  await new Promise((resolve) => child.once('close', (code, signal) => { exitCode = code; exitSignal = signal; resolve() }))
  closeSync(stdoutFd)
  closeSync(stderrFd)
  const out = await readFile(inventoryStdoutPath)
  const err = await readFile(inventoryStderrPath)
  await publish('guard-inventory.stdout.log', out)
  await publish('guard-inventory.stderr.log', err)
  assert.equal(childError, undefined)
  assert.equal(exitSignal, null)
  assert.equal(exitCode, 0, 'The complete guard inventory subprocess must pass before it can verify names')
  assert.ok(out.length > 0, 'The complete guard inventory subprocess must emit observable test names')
  assert.equal(process.env.WORLD_AUTHORING_GUARD_SKIP_NETWORK, undefined,
    'The no-network guard skip must be absent from the parent after inventory collection')
  return { stdout: out.toString('utf8'), stderr: err.toString('utf8') }
}

export async function runNodeTestDispatchProof({ createNodeTestPlan, runNodeTestPlan }) {
  assert.equal(process.env.WORLD_AUTHORING_GUARD_SKIP_NETWORK, undefined,
    'The dispatch proof must not inherit or set WORLD_AUTHORING_GUARD_SKIP_NETWORK on the parent process')
  assert.equal(process.env.NODE_TEST_CONTEXT, undefined,
    'The real dispatch proof requires ordinary Node before node:test; NODE_TEST_CONTEXT must be absent')
  assert.ok(process.platform !== 'win32' && typeof process.getuid === 'function',
    'The complete four-pass ownership/symlink dispatch proof requires POSIX; do not skip assertions')
  const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
  const guardFile = 'scripts/worlds-authoring-electron-fixture/guards.test.mjs'
  const selected = (await createNodeTestPlan()).filter(({ file }) => file === guardFile)
  assert.equal(selected.length, 1, 'Select the real canonical entry without constructing replacement arguments')
  const scratch = await mkdtemp(join(await realpath(tmpdir()), 'modly-guard-dispatch-contract-'))
  const scratchInfo = await lstat(scratch)
  try {
    const evidence = process.env.MODLY_NODE_RUNNER_EVIDENCE_DIR ?? scratch
    assert.equal(await realpath(evidence), evidence)
    const evidenceInfo = await lstat(evidence)
    assert.equal(evidenceInfo.mode & 0o777, 0o700)
    assert.equal(evidenceInfo.isDirectory(), true)
    assert.equal(evidenceInfo.uid, process.getuid())
    let active = 0
    let maximumActive = 0
    const dispatch = async (label, externalRoot) => {
      const started = Date.now()
      const stdout = [], stderr = [], announcements = []
      let outputBytes = 0, overflow = false, timedOut = false, childError
      let exitCode, exitSignal, childPid, spawnCount = 0, closePromise
      let inheritedNodeEnvironment
      let executionError
      try {
        await runNodeTestPlan(selected, repositoryRoot, {
          write: (value) => announcements.push(value),
          spawnProcess(executable, args, options) {
            spawnCount += 1
            assert.equal(executable, process.execPath)
            assert.deepEqual(args, selected[0].args)
            assert.equal(options.cwd, repositoryRoot)
            assert.equal(options.stdio, 'inherit')
            assert.equal(options.env, process.env)
            inheritedNodeEnvironment = Object.fromEntries(['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'NODE_V8_COVERAGE']
              .map((key) => [key, options.env[key] ?? null]))
            assert.equal(options.env.WORLD_AUTHORING_GUARD_SKIP_NETWORK, undefined,
              'The no-network guard skip must not leak through the runner parent environment')
            const env = createAuthoringGuardChildEnvironment(options.env, externalRoot)
            const child = spawn(executable, args, { ...options, env, stdio: ['ignore', 'pipe', 'pipe'] })
            childPid = child.pid
            active += 1
            maximumActive = Math.max(maximumActive, active)
            let killTimer
            const stop = () => {
              child.kill('SIGTERM')
              killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1_000)
            }
            const deadline = setTimeout(() => { timedOut = true; stop() }, 20_000)
            const collect = (chunks) => (chunk) => {
              outputBytes += chunk.length
              if (outputBytes > 1024 * 1024) { overflow = true; stop(); return }
              chunks.push(Buffer.from(chunk))
            }
            child.stdout.on('data', collect(stdout))
            child.stderr.on('data', collect(stderr))
            child.once('error', (error) => { childError = { code: error.code, message: error.message } })
            closePromise = new Promise((resolve) => child.once('close', (code, signal) => {
              exitCode = code; exitSignal = signal; active -= 1
              clearTimeout(deadline); clearTimeout(killTimer)
              resolve()
            }))
            return child
          },
        })
      } catch (error) { executionError = error }
      await closePromise
      const out = Buffer.concat(stdout), err = Buffer.concat(stderr)
      const metadata = { label, executable: process.execPath, args: selected[0].args, cwd: repositoryRoot,
        spawnCount, maximumActive, inheritedNodeEnvironment, externalRoot: externalRoot ?? null, childPid, exitCode, exitSignal,
        parentGuardSkip: process.env.WORLD_AUTHORING_GUARD_SKIP_NETWORK ?? null, childGuardSkip: '1',
        elapsedMs: Date.now() - started, outputBytes, overflow, timedOut, childError: childError ?? null,
        dispatcherError: executionError ? { message: executionError.message, exitCode: executionError.exitCode ?? null } : null }
      await publish(`${label}.stdout.log`, out)
      await publish(`${label}.stderr.log`, err)
      await publish(`${label}.json`, Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`))
      await writeFile(join(evidence, `${label}.stdout.log`), out, { flag: 'wx' })
      await writeFile(join(evidence, `${label}.stderr.log`), err, { flag: 'wx' })
      await writeFile(join(evidence, `${label}.json`), `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' })
      assert.equal(spawnCount, 1)
      assert.ok(childPid > 0 && childPid !== process.pid)
      assert.equal(overflow, false, 'Bounded child output exceeded 1 MiB')
      assert.equal(timedOut, false, 'Real guard child exceeded its 20-second execution bound')
      assert.equal(childError, undefined)
      assert.equal(exitSignal, null)
      assert.deepEqual(announcements, [`[test:node] 1/1 mjs: ${guardFile}\n`])
      return { stdout: out.toString('utf8'), stderr: err.toString('utf8'), metadata, executionError }
    }
    const successful = await dispatch('guard-success')
    assert.equal(successful.executionError, undefined)
    assert.equal(successful.metadata.exitCode, 0)
    assert.equal(process.env.WORLD_AUTHORING_GUARD_SKIP_NETWORK, undefined,
      'The no-network guard skip must be absent from the parent after successful guard dispatch')
    const inventory = await collectGuardInventory(selected[0], repositoryRoot, scratch)
    const actualNames = assertAuthoringGuardInventory(inventory.stdout)
    await publish('guard-name-checks.json', Buffer.from(`${JSON.stringify({ expectedNames: REQUIRED_AUTHORING_GUARD_TEST_NAMES, actualNames, observedCount: actualNames.length, expectedCount: EXPECTED_AUTHORING_GUARD_TEST_COUNT, verified: true })}\n`))
    const hasForwardedGuardTap = successful.stdout.trim().length > 0 || inventory.stdout.trim().length > 0
    const diagnosticOutput = successful.stdout.trim().length > 0 ? successful.stdout : inventory.stdout
    const roots = [...diagnosticOutput.matchAll(/^[#ℹ] Evidence root: ([^\r\n]+); owned=true$/gm)].map((match) => match[1])
    if (hasForwardedGuardTap) {
      assert.equal(roots.length, 1, 'Require the actual owned-root body diagnostic')
      assert.ok(roots[0].startsWith(join(await realpath(tmpdir()), 'modly-worlds-authoring-remediation-')))
      await assert.rejects(lstat(roots[0]), { code: 'ENOENT' })
      const cleanup = Buffer.from(`${JSON.stringify({ root: roots[0], status: 'ENOENT', owned: true })}\n`)
      await writeFile(join(evidence, 'guard-cleanup.json'), cleanup, { flag: 'wx' })
      await publish('guard-cleanup.json', cleanup)
    } else {
      const cleanup = Buffer.from(`${JSON.stringify({ root: null, status: 'stdout-unavailable', owned: true, reason: 'node:test does not forward nested guard diagnostics to a programmatic pipe when the selected child passes' })}\n`)
      await writeFile(join(evidence, 'guard-cleanup.json'), cleanup, { flag: 'wx' })
      await publish('guard-cleanup.json', cleanup)
    }
    const failed = await dispatch('guard-invalid-root', join(scratch, 'invalid-external-evidence-root'))
    assert.equal(process.env.WORLD_AUTHORING_GUARD_SKIP_NETWORK, undefined,
      'The no-network guard skip must be absent from the parent after failed guard dispatch')
    assert.equal(failed.metadata.exitCode, 1, 'An invalid external-root input must fail in the real guard process')
    assert.equal(failed.executionError?.exitCode, 1, 'The actual dispatcher must preserve the child failure code')
    assert.equal(failed.executionError?.message, `${guardFile} failed with exit code 1`)
    assert.equal(active, 0)
    assert.equal(maximumActive, 1)
  } finally {
    // Remove only our still-owned fixture root; never follow a replacement or a caller's evidence root.
    const current = await lstat(scratch)
    assert.equal(await realpath(scratch), scratch)
    assert.equal(current.isDirectory(), true)
    assert.equal(current.uid, process.getuid())
    assert.equal(current.mode & 0o777, 0o700)
    assert.equal(current.dev, scratchInfo.dev)
    assert.equal(current.ino, scratchInfo.ino)
    await rm(scratch, { recursive: true, force: true })
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  try {
    assert.equal(process.argv.length, 2, 'The standalone proof accepts no CLI overrides')
    // The runner has no top-level import back to this module: no mutual-await ESM cycle.
    const { createNodeTestPlan, runNodeTestPlan } = await import('./run-node-tests.mjs')
    await runNodeTestDispatchProof({ createNodeTestPlan, runNodeTestPlan })
    console.log('[dispatch-proof] PASS: expanded guard inventory, owned-root cleanup when observable, invalid-root failure, serial dispatch')
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error)
    process.exitCode = 1
  }
}

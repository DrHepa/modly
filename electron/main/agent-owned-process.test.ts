import assert from 'node:assert/strict'
import { realpath } from 'node:fs/promises'
import test from 'node:test'

import { openPinnedAgentExecutable, startAgentOwnedProcess } from './agent-owned-process.ts'

test('owned process pins the executable, bounds stderr, and reaps its detached process group', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux process-group identity is required')
  const executable = await openPinnedAgentExecutable(await realpath(process.execPath), 'test executable')
  const owned = await startAgentOwnedProcess({
    executable,
    args: ['-e', [
      "const { spawn } = require('node:child_process')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      "console.error('grandchild:' + child.pid + ':' + 'x'.repeat(2048))",
      'setInterval(() => {}, 1000)',
    ].join(';')],
    env: {},
    cwd: '/',
    stderrBytes: 128,
    terminationGraceMs: 50,
    reapTimeoutMs: 1_000,
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 50))
    await owned.revalidate()
    assert.equal(Buffer.byteLength(owned.stderr, 'utf8') <= 128, true)
  } finally {
    await owned.close()
    await owned.close()
    await executable.close()
  }
  const exit = await owned.exited
  assert.notEqual(exit.signal, null)
})

test('owned process reports an early non-zero exit and retains bounded internal stderr', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux process-group identity is required')
  const executable = await openPinnedAgentExecutable(await realpath(process.execPath), 'test executable')
  const owned = await startAgentOwnedProcess({
    executable,
    args: ['-e', "console.error('private-alias-value'); process.exit(7)"],
    env: {},
    cwd: '/',
  })
  try {
    assert.deepEqual(await owned.exited, { code: 7, signal: null })
    await assert.rejects(owned.revalidate(), /unavailable/i)
    assert.match(owned.stderr, /private-alias-value/)
  } finally {
    await owned.close()
    await executable.close()
  }
})

test('owned process refuses to signal a process group after leader identity mismatch', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux process-group identity is required')
  const executable = await openPinnedAgentExecutable(await realpath(process.execPath), 'test executable')
  let groupSignals = 0
  const owned = await startAgentOwnedProcess({
    executable,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    env: {},
    cwd: '/',
    processIdentityMatches: async () => false,
    onGroupSignal: () => { groupSignals += 1 },
  })
  try {
    await owned.close()
    assert.equal(groupSignals, 0)
    assert.doesNotThrow(() => process.kill(owned.pid, 0))
  } finally {
    try { process.kill(-owned.pid, 'SIGKILL') } catch { /* best-effort test cleanup */ }
    await Promise.race([
      owned.exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('owned test process did not exit')), 1_000)),
    ])
    await executable.close()
  }
})

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const setupHooksScript = fileURLToPath(new URL('./setup-hooks.mjs', import.meta.url))
const nestedNodeMarker = 'modly-setup-hooks-nested-node-probe'

let nestedNodeCapability

function canRunNestedNode() {
  if (nestedNodeCapability !== undefined) {
    return nestedNodeCapability
  }

  const result = spawnSync(process.execPath, [
    '-e',
    `process.stdout.write(${JSON.stringify(nestedNodeMarker)})`,
  ], { encoding: 'utf8' })

  if (result.error) {
    if (result.error.code === 'EPERM' || result.error.code === 'EACCES') {
      nestedNodeCapability = false
      return nestedNodeCapability
    }
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error([
      `Nested Node capability probe failed with exit code ${String(result.status)}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'))
  }
  if (result.stdout !== nestedNodeMarker) {
    throw new Error(`Nested Node capability probe returned unexpected output: ${JSON.stringify(result.stdout)}`)
  }

  nestedNodeCapability = true
  return nestedNodeCapability
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    ...options,
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error([
      `${executable} ${args.join(' ')} failed with exit code ${String(result.status)}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'))
  }
  return result
}

test('setup-hooks leaves shared Git config unchanged from a linked worktree', async (t) => {
  if (!canRunNestedNode()) {
    t.skip('Nested Node process execution is unavailable on this test host.')
    return
  }

  const fixtureRoot = await mkdtemp(join(tmpdir(), 'modly-setup-hooks-'))
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }))

  const repository = join(fixtureRoot, 'repository')
  const linkedWorktree = join(fixtureRoot, 'linked-worktree')
  run('git', ['init', repository])
  run('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repository })
  run('git', ['config', 'user.name', 'Modly Test'], { cwd: repository })
  await writeFile(join(repository, 'README.md'), 'fixture\n', 'utf8')
  run('git', ['add', 'README.md'], { cwd: repository })
  run('git', ['commit', '-m', 'test: seed fixture'], { cwd: repository })
  run('git', ['config', '--local', 'core.hooksPath', '.shared-hooks'], { cwd: repository })
  run('git', ['worktree', 'add', '-b', 'test-linked', linkedWorktree], { cwd: repository })

  const before = run('git', ['config', '--local', '--get', 'core.hooksPath'], {
    cwd: repository,
  }).stdout.trim()
  const setup = run(process.execPath, [setupHooksScript], { cwd: linkedWorktree })
  const after = run('git', ['config', '--local', '--get', 'core.hooksPath'], {
    cwd: repository,
  }).stdout.trim()

  assert.equal(before, '.shared-hooks')
  assert.equal(after, before)
  assert.match(setup.stdout, /skipped \(linked worktree\)/)
})

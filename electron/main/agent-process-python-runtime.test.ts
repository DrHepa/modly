import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  AgentProcessPythonRuntimeError,
  bindExtensionPythonRuntime,
  buildExtensionPythonSandboxLaunch,
  prepareExtensionPythonRuntimeSnapshot,
  revalidatePreparedExtensionPythonRuntime,
} from './agent-process-python-runtime.ts'

const execFileAsync = promisify(execFile)

async function runtimeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'modly-process-python-runtime-'))
  const extensionDir = join(root, 'extension')
  const sourceRoot = join(extensionDir, 'venv')
  const cacheRoot = join(root, 'user-data', 'agent-process-runtime-snapshots')
  const baseInterpreter = join(root, 'trusted-python')
  await mkdir(join(sourceRoot, 'bin'), { recursive: true })
  await mkdir(join(sourceRoot, 'lib', 'python3.11', 'site-packages'), { recursive: true })
  await writeFile(baseInterpreter, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  await symlink('python3', join(sourceRoot, 'bin', 'python'))
  await symlink('../../../trusted-python', join(sourceRoot, 'bin', 'python3'))
  await symlink('lib', join(sourceRoot, 'lib64'))
  await writeFile(join(sourceRoot, 'pyvenv.cfg'), 'home = /usr/bin\n')
  await writeFile(join(sourceRoot, 'lib', 'python3.11', 'site-packages', 'native.so'), 'native-v1')
  for (const directory of [sourceRoot, join(sourceRoot, 'bin'), join(sourceRoot, 'lib'),
    join(sourceRoot, 'lib', 'python3.11'), join(sourceRoot, 'lib', 'python3.11', 'site-packages')]) {
    await chmod(directory, 0o770)
  }
  await chmod(join(sourceRoot, 'pyvenv.cfg'), 0o660)
  await chmod(join(sourceRoot, 'lib', 'python3.11', 'site-packages', 'native.so'), 0o660)
  return { root, extensionDir, sourceRoot, cacheRoot, baseInterpreter }
}

async function removeFixture(root: string): Promise<void> {
  const makeWritable = async (path: string): Promise<void> => {
    const info = await lstat(path).catch(() => undefined)
    if (!info || !info.isDirectory() || info.isSymbolicLink()) return
    await chmod(path, 0o700)
    for (const child of await readdir(path)) await makeWritable(join(path, child))
  }
  await makeWritable(root)
  await rm(root, { recursive: true, force: true })
}

test('extension Python runtime binding is complete, deterministic, and interpreter-bound', async () => {
  const value = await runtimeFixture()
  try {
    const binding = await bindExtensionPythonRuntime(value.extensionDir, {
      kind: 'extension-python-venv-v1', interpreter: 'bin/python',
    }, value.baseInterpreter)
    assert.equal(binding.kind, 'extension-python-venv-v1')
    assert.equal(binding.interpreter, 'bin/python')
    assert.match(binding.treeDigest, /^[a-f0-9]{64}$/)
    assert.match(binding.sourceIdentityHash, /^[a-f0-9]{64}$/)
    assert.match(binding.bindingHash, /^[a-f0-9]{64}$/)
    assert.match(binding.baseInterpreter.sha256, /^[a-f0-9]{64}$/)
    assert.equal(binding.baseInterpreter.size, (await stat(value.baseInterpreter)).size)
    assert.ok(binding.entryCount >= 7)
    assert.ok(binding.logicalBytes > 0)

    const rebound = await bindExtensionPythonRuntime(value.extensionDir, {
      kind: 'extension-python-venv-v1', interpreter: 'bin/python',
    }, value.baseInterpreter)
    assert.deepEqual(rebound, binding)
    await assert.rejects(
      bindExtensionPythonRuntime(value.extensionDir, {
        kind: 'extension-python-venv-v1', interpreter: '/usr/bin/python' as 'bin/python',
      }, value.baseInterpreter),
      (error: unknown) => error instanceof AgentProcessPythonRuntimeError && error.code === 'runtime_unavailable',
    )
  } finally {
    await removeFixture(value.root)
  }
})

test('private snapshot preserves native layout, is immutable, and never consumes later source mutation', async () => {
  const value = await runtimeFixture()
  try {
    const binding = await bindExtensionPythonRuntime(value.extensionDir, {
      kind: 'extension-python-venv-v1', interpreter: 'bin/python',
    }, value.baseInterpreter)
    const prepared = await prepareExtensionPythonRuntimeSnapshot(
      value.extensionDir, binding, value.cacheRoot, value.baseInterpreter,
    )
    assert.equal(prepared.rootPath, join(value.cacheRoot, binding.treeDigest))
    assert.equal(prepared.interpreterPath, join(prepared.rootPath, 'bin', 'python'))
    assert.equal(
      await readFile(join(prepared.rootPath, 'lib', 'python3.11', 'site-packages', 'native.so'), 'utf8'),
      'native-v1',
    )
    assert.equal((await stat(prepared.rootPath)).mode & 0o222, 0)
    assert.equal((await stat(prepared.interpreterPath)).mode & 0o222, 0)
    assert.notEqual((await stat(prepared.interpreterPath)).mode & 0o111, 0)
    assert.equal(await readlink(join(prepared.rootPath, 'bin', 'python')), 'python3')
    assert.equal(await readlink(join(prepared.rootPath, 'lib64')), 'lib')
    assert.equal((await lstat(join(prepared.rootPath, 'bin', 'python3'))).isFile(), true)

    await writeFile(join(value.sourceRoot, 'lib', 'python3.11', 'site-packages', 'native.so'), 'native-v2')
    assert.equal(
      await readFile(join(prepared.rootPath, 'lib', 'python3.11', 'site-packages', 'native.so'), 'utf8'),
      'native-v1',
    )
    await assert.rejects(
      revalidatePreparedExtensionPythonRuntime(value.extensionDir, prepared, value.baseInterpreter),
      (error: unknown) => error instanceof AgentProcessPythonRuntimeError && error.code === 'runtime_stale',
    )
    prepared.release()
  } finally {
    await removeFixture(value.root)
  }
})

test('snapshot preparation removes bounded incomplete state and reuses a verified completed digest', async () => {
  const value = await runtimeFixture()
  try {
    const binding = await bindExtensionPythonRuntime(value.extensionDir, {
      kind: 'extension-python-venv-v1', interpreter: 'bin/python',
    }, value.baseInterpreter)
    const partial = join(value.cacheRoot, `${binding.treeDigest}.partial-crashed`)
    await mkdir(partial, { recursive: true, mode: 0o700 })
    await writeFile(join(partial, 'untrusted'), 'partial')
    const first = await prepareExtensionPythonRuntimeSnapshot(
      value.extensionDir, binding, value.cacheRoot, value.baseInterpreter,
    )
    await assert.rejects(stat(partial), { code: 'ENOENT' })
    const second = await prepareExtensionPythonRuntimeSnapshot(
      value.extensionDir, binding, value.cacheRoot, value.baseInterpreter,
    )
    assert.equal(second.rootPath, first.rootPath)
    await revalidatePreparedExtensionPythonRuntime(value.extensionDir, second, value.baseInterpreter)
    first.release()
    second.release()
  } finally {
    await removeFixture(value.root)
  }
})

test('runtime links reject cycles, non-interpreter escapes, and a changed trusted base interpreter', async (t) => {
  await t.test('cycle', async () => {
    const value = await runtimeFixture()
    try {
      await rm(join(value.sourceRoot, 'lib64'))
      await symlink('lib64', join(value.sourceRoot, 'lib64'))
      await assert.rejects(
        bindExtensionPythonRuntime(value.extensionDir, {
          kind: 'extension-python-venv-v1', interpreter: 'bin/python',
        }, value.baseInterpreter),
        (error: unknown) => error instanceof AgentProcessPythonRuntimeError && error.code === 'runtime_unavailable',
      )
    } finally {
      await removeFixture(value.root)
    }
  })

  await t.test('escape', async () => {
    const value = await runtimeFixture()
    try {
      await symlink('../../outside', join(value.sourceRoot, 'escape'))
      await assert.rejects(
        bindExtensionPythonRuntime(value.extensionDir, {
          kind: 'extension-python-venv-v1', interpreter: 'bin/python',
        }, value.baseInterpreter),
        (error: unknown) => error instanceof AgentProcessPythonRuntimeError && error.code === 'runtime_unavailable',
      )
    } finally {
      await removeFixture(value.root)
    }
  })

  await t.test('base replacement', async () => {
    const value = await runtimeFixture()
    try {
      const binding = await bindExtensionPythonRuntime(value.extensionDir, {
        kind: 'extension-python-venv-v1', interpreter: 'bin/python',
      }, value.baseInterpreter)
      const replacement = `${value.baseInterpreter}.replacement`
      await writeFile(replacement, '#!/bin/sh\nexit 1\n', { mode: 0o700 })
      await rename(replacement, value.baseInterpreter)
      await assert.rejects(
        prepareExtensionPythonRuntimeSnapshot(
          value.extensionDir, binding, value.cacheRoot, value.baseInterpreter,
        ),
        (error: unknown) => error instanceof AgentProcessPythonRuntimeError && error.code === 'runtime_stale',
      )
    } finally {
      await removeFixture(value.root)
    }
  })
})

test('active snapshot leases protect concurrent prepared digests from cache sweeping', async () => {
  const fixtures = await Promise.all(Array.from({ length: 12 }, async (_, index) => {
    const value = await runtimeFixture()
    await writeFile(
      join(value.sourceRoot, 'lib', 'python3.11', 'site-packages', 'native.so'),
      `native-${index}`,
    )
    return value
  }))
  const cacheRoot = fixtures[0].cacheRoot
  const prepared: Array<Awaited<ReturnType<typeof prepareExtensionPythonRuntimeSnapshot>>> = []
  try {
    const bindings = await Promise.all(fixtures.map((value) => bindExtensionPythonRuntime(
      value.extensionDir,
      { kind: 'extension-python-venv-v1', interpreter: 'bin/python' },
      value.baseInterpreter,
    )))
    const held = await prepareExtensionPythonRuntimeSnapshot(
      fixtures[0].extensionDir, bindings[0], cacheRoot, fixtures[0].baseInterpreter,
    )
    prepared.push(held)
    const sameDigest = await prepareExtensionPythonRuntimeSnapshot(
      fixtures[0].extensionDir, bindings[0], cacheRoot, fixtures[0].baseInterpreter,
    )
    prepared.push(sameDigest)
    for (let index = 1; index < fixtures.length; index += 1) {
      const current = await prepareExtensionPythonRuntimeSnapshot(
        fixtures[index].extensionDir, bindings[index], cacheRoot, fixtures[index].baseInterpreter,
      )
      current.release()
    }
    await access(held.rootPath)
    held.release()
    await access(sameDigest.rootPath)
    sameDigest.release()
    const trigger = await prepareExtensionPythonRuntimeSnapshot(
      fixtures.at(-1)!.extensionDir,
      bindings.at(-1)!,
      cacheRoot,
      fixtures.at(-1)!.baseInterpreter,
    )
    trigger.release()
  } finally {
    for (const runtime of prepared) runtime.release()
    await Promise.all(fixtures.map((value) => removeFixture(value.root)))
  }
})

test('a real local Python 3.12 venv snapshot launches a tiny zipapp', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux venv and proc-fd semantics are required')
  const root = await mkdtemp(join(tmpdir(), 'modly-process-real-python-'))
  const extensionDir = join(root, 'extension')
  const sourceRoot = join(extensionDir, 'venv')
  const cacheRoot = join(root, 'cache')
  let prepared: Awaited<ReturnType<typeof prepareExtensionPythonRuntimeSnapshot>> | undefined
  try {
    const executable = (await execFileAsync('python3.12', [
      '-c', 'import os,sys; print(os.path.realpath(sys.executable))',
    ])).stdout.trim()
    await mkdir(extensionDir, { recursive: true })
    await execFileAsync('python3.12', ['-m', 'venv', '--without-pip', sourceRoot])
    const appDir = join(root, 'zipapp')
    const pyz = join(root, 'probe.pyz')
    await mkdir(appDir)
    await writeFile(join(appDir, '__main__.py'), 'import json,sys\nprint(json.dumps({"ok": True, "prefix": sys.prefix}))\n')
    await execFileAsync('python3.12', ['-m', 'zipapp', appDir, '-o', pyz])

    const binding = await bindExtensionPythonRuntime(extensionDir, {
      kind: 'extension-python-venv-v1', interpreter: 'bin/python',
    }, executable)
    prepared = await prepareExtensionPythonRuntimeSnapshot(extensionDir, binding, cacheRoot, executable)
    const result = await execFileAsync(prepared.interpreterPath, [pyz])
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, prefix: prepared.rootPath })
    assert.equal(await realpath(prepared.interpreterPath), join(prepared.rootPath, 'bin', 'python3.12'))
  } finally {
    prepared?.release()
    await removeFixture(root)
  }
})

test('Python sandbox launch selects only the snapshotted interpreter and isolates network', () => {
  const launch = buildExtensionPythonSandboxLaunch({
    platform: 'linux', bwrapFd: 9,
    snapshotRootFd: 6, interpreter: 'bin/python',
    entryFd: 3, resourceFds: [4], inputFds: [5], outputDirFd: 7,
    systemPaths: ['/usr', '/bin', '/lib'],
  })
  assert.equal(launch.command, '/proc/self/fd/9')
  assert.equal(launch.shell, false)
  assert.ok(launch.args.includes('--unshare-all'))
  assert.ok(launch.args.includes('--disable-userns'))
  assert.ok(launch.args.some((value, index) => value === '--ro-bind'
    && launch.args[index + 1] === '/proc/self/fd/6' && launch.args[index + 2] === '/runtime'))
  assert.ok(launch.args.some((value, index) => value === '--bind'
    && launch.args[index + 1] === '/proc/self/fd/7' && launch.args[index + 2] === '/output'))
  assert.ok(launch.args.some((value, index) => value === '--ro-bind-fd'
    && launch.args[index + 1] === '3' && launch.args[index + 2] === '/app/process.pyz'))
  assert.deepEqual(launch.args.slice(-2), ['/runtime/bin/python', '/app/process.pyz'])
  assert.equal(JSON.stringify(launch).includes('/extension/venv'), false)
})

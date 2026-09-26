import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const sourceRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, '')

test('both builder configurations copy only the versioned Worlds CLI and skill to the same resource paths', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const offline = JSON.parse(await readFile(new URL('./world-ffmpeg-electron-builder-config.json', import.meta.url), 'utf8'))
  const expected = [
    { from: 'tools/modly-cli/agent.py', to: 'modly-cli/agent.py' },
    { from: 'tools/modly-cli/SKILL.md', to: 'modly-cli/SKILL.md' },
  ]
  for (const builder of [packageJson.build, offline]) {
    assert.deepEqual(builder.extraResources.filter(({ to }) => String(to).startsWith('modly-cli/')), expected)
    assert.equal(builder.beforePack, 'scripts/world-ffmpeg-before-pack.cjs')
    assert.equal(builder.afterPack, 'scripts/after-pack.js')
  }
  const skill = await readFile(new URL('../tools/modly-cli/SKILL.md', import.meta.url), 'utf8')
  assert.match(skill, /world pair/)
  assert.match(skill, /world project list/)
  assert.match(skill, /world plan/)
  assert.match(skill, /world query/)
  assert.match(skill, /world propose/)
  assert.match(skill, /resourcesPath\/modly-cli\/agent\.py/)
  assert.match(skill, /Apply, Reject,\s+Undo, edit, and status commands are not available through the CLI/)
  assert.match(skill, /direct-edit-dispatched.*dispatch only/s)
  assert.match(skill, /fresh `world project open` or `world query`/)
})

test('source and copied Worlds CLI reject missing, tampered and symlinked files', async (t) => {
  const { verifyWorldsCodexCliBundle } = require('./worlds-codex-cli-package.cjs')
  const base = await mkdtemp(join(tmpdir(), 'modly-worlds-cli-package-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const packaged = join(base, 'resources')
  await mkdir(join(packaged, 'modly-cli'), { recursive: true })
  for (const name of ['agent.py', 'SKILL.md']) {
    await cp(new URL(`../tools/modly-cli/${name}`, import.meta.url), join(packaged, 'modly-cli', name))
  }
  assert.deepEqual((await readdir(join(packaged, 'modly-cli'))).sort(), ['SKILL.md', 'agent.py'])
  assert.deepEqual(await verifyWorldsCodexCliBundle(sourceRoot, 'source'), { ok: true })
  assert.deepEqual(await verifyWorldsCodexCliBundle(packaged, 'packaged'), { ok: true })
  await rm(join(packaged, 'modly-cli', 'SKILL.md'))
  assert.match((await verifyWorldsCodexCliBundle(packaged, 'packaged')).code, /missing/)
  await cp(new URL('../tools/modly-cli/SKILL.md', import.meta.url), join(packaged, 'modly-cli', 'SKILL.md'))
  await writeFile(join(packaged, 'modly-cli', 'agent.py'), 'malicious replacement')
  assert.match((await verifyWorldsCodexCliBundle(packaged, 'packaged')).code, /mismatch/)
  await rm(join(packaged, 'modly-cli', 'agent.py'))
  await symlink(fileURLToPath(new URL('../tools/modly-cli/agent.py', import.meta.url)), join(packaged, 'modly-cli', 'agent.py'))
  assert.match((await verifyWorldsCodexCliBundle(packaged, 'packaged')).code, /unsafe/)
})

test('source gate rejects an absent or changed helper before builder copies it', async (t) => {
  const { verifyWorldsCodexCliBundle } = require('./worlds-codex-cli-package.cjs')
  const base = await mkdtemp(join(tmpdir(), 'modly-worlds-cli-source-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const source = join(base, 'tools', 'modly-cli')
  await mkdir(source, { recursive: true })
  await cp(new URL('../tools/modly-cli/SKILL.md', import.meta.url), join(source, 'SKILL.md'))
  assert.equal((await verifyWorldsCodexCliBundle(base, 'source')).code, 'cli-file-missing')
  await cp(new URL('../tools/modly-cli/agent.py', import.meta.url), join(source, 'agent.py'))
  assert.deepEqual(await verifyWorldsCodexCliBundle(base, 'source'), { ok: true })
  await writeFile(join(source, 'agent.py'), 'replacement')
  assert.equal((await verifyWorldsCodexCliBundle(base, 'source')).code, 'cli-file-mismatch')
})

test('copied helper runs outside the source checkout without a credential or API key', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'modly-worlds-cli-external-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const helper = join(base, 'agent.py')
  await cp(new URL('../tools/modly-cli/agent.py', import.meta.url), helper)
  const env = { PATH: process.env.PATH, HOME: base, XDG_RUNTIME_DIR: base, PYTHONPATH: '' }
  const help = spawnSync('python3', ['-I', helper, 'world', '--help'], { cwd: base, env, encoding: 'utf8' })
  assert.equal(help.status, 0, help.stderr)
  for (const command of ['pair', 'project', 'plan', 'query', 'propose']) assert.match(help.stdout, new RegExp(`\\b${command}\\b`))
  assert.match(help.stdout, /five-minute,\s+eight-\s*admission lease/)
  assert.match(help.stdout, /direct-edit-dispatched is dispatch\s+only/)
  assert.match(help.stdout, /verify with a fresh\s+read/)
  assert.match(help.stdout, /Apply, Reject, Undo, edit, and status commands are\s+unsupported/)
  const absent = spawnSync('python3', ['-I', helper, 'world', 'project', 'list'], { cwd: base, env, encoding: 'utf8' })
  assert.notEqual(absent.status, 0)
  assert.equal(JSON.parse(absent.stdout).code, 'WORLD_CLI_UNAVAILABLE')
})

test('copied helper rejects a symlinked parent and invalid resource roots', async (t) => {
  const { verifyWorldsCodexCliBundle } = require('./worlds-codex-cli-package.cjs')
  const base = await mkdtemp(join(tmpdir(), 'modly-worlds-cli-escape-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  await symlink(fileURLToPath(new URL('../tools/modly-cli/', import.meta.url)), join(base, 'modly-cli'))
  assert.match((await verifyWorldsCodexCliBundle(base, 'packaged')).code, /unsafe/)
  await symlink(base, join(base, 'aliased-root'))
  assert.match((await verifyWorldsCodexCliBundle(join(base, 'aliased-root'), 'packaged')).code, /unsafe/)
  await mkdir(join(base, 'real-parent', 'resources'), { recursive: true })
  await symlink(join(base, 'real-parent'), join(base, 'aliased-parent'))
  assert.match((await verifyWorldsCodexCliBundle(join(base, 'aliased-parent', 'resources'), 'packaged')).code, /unsafe/)
  assert.deepEqual(await verifyWorldsCodexCliBundle(`${base}/../`, 'packaged'), { ok: false, code: 'cli-root-invalid' })
  assert.deepEqual(await verifyWorldsCodexCliBundle(base, 'unknown'), { ok: false, code: 'cli-mode-invalid' })
})

test('package hooks fail closed on CLI mismatch, before signing', async () => {
  const { beforePackWith } = require('./world-ffmpeg-before-pack.cjs')
  const { afterPackWith } = require('./after-pack.js')
  let called = false
  await assert.rejects(beforePackWith({ electronPlatformName: 'linux', arch: 1 }, {
    verify: async () => ({ ok: true }),
    verifyCli: async () => ({ ok: false, code: 'cli-file-mismatch' }),
  }), /Packaged Worlds CLI verification failed: cli-file-mismatch/)
  await assert.rejects(afterPackWith({
    electronPlatformName: 'darwin', arch: 3, appOutDir: '/package/mac',
    packager: { appInfo: { productFilename: 'Modly' } },
  }, {
    verify: async () => ({ ok: true }),
    verifyCli: async () => ({ ok: false, code: 'cli-file-mismatch' }),
    codesign: async () => { called = true },
  }), /Packaged Worlds CLI verification failed: cli-file-mismatch/)
  assert.equal(called, false)
})

test('real package hook verifies copied resource bytes before reporting success', async (t) => {
  const { beforePackWith } = require('./world-ffmpeg-before-pack.cjs')
  const { afterPackWith } = require('./after-pack.js')
  const out = await mkdtemp(join(tmpdir(), 'modly-worlds-cli-hook-'))
  t.after(() => rm(out, { recursive: true, force: true }))
  const resources = join(out, 'resources', 'modly-cli')
  await mkdir(resources, { recursive: true })
  for (const name of ['agent.py', 'SKILL.md']) {
    await cp(new URL(`../tools/modly-cli/${name}`, import.meta.url), join(resources, name))
  }
  await beforePackWith({ electronPlatformName: 'linux', arch: 1 }, { verify: async () => ({ ok: true }) })
  const context = { electronPlatformName: 'linux', arch: 1, appOutDir: out,
    packager: { appInfo: { productFilename: 'Modly' } } }
  let ffmpegVerifyCount = 0
  const dependencies = { verify: async () => { ffmpegVerifyCount++; return { ok: true } }, codesign: async () => {} }
  await afterPackWith(context, dependencies)
  assert.equal(ffmpegVerifyCount, 1)
  await writeFile(join(resources, 'SKILL.md'), 'replacement')
  await assert.rejects(afterPackWith(context, dependencies), /Packaged Worlds CLI verification failed: cli-file-mismatch/)
  assert.equal(ffmpegVerifyCount, 1)
})

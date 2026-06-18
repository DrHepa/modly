import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, symlink, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { validateProcessScene } from './process-scene-boundary.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'modly-physical-scene-'))
  await mkdir(join(root, 'scenes', 'one'), { recursive: true })
  const manifestPath = join(root, 'scenes', 'one', 'scene-manifest.json')
  const manifest = { schema: 'modly.scene-manifest.v1', sceneRoot: '.', assets: [{ path: 'asset.bin' }] }
  await writeFile(join(root, 'scenes', 'one', 'asset.bin'), 'opaque asset')
  const write = (value: unknown = manifest) => writeFile(manifestPath, JSON.stringify(value))
  await write()
  return { root, manifestPath, manifest, write, close: () => rm(root, { recursive: true, force: true }) }
}

test('physical scene directory and absolute manifest canonicalize with opaque metadata retained', async () => {
  const f = await fixture()
  try {
    await f.write({ ...f.manifest, assets: [null, 7, 'opaque', { custom: { path: '/not-a-host-reference' } }, ...f.manifest.assets], initialView: null })
    assert.equal(await validateProcessScene(f.root, 'scenes/one'), f.manifestPath)
    assert.equal(await validateProcessScene(f.root, f.manifestPath), f.manifestPath)
    const alias = join(f.root, 'workspace-alias')
    await symlink(f.root, alias)
    assert.equal(await validateProcessScene(alias, join(alias, 'scenes/one')), f.manifestPath)
  } finally { await f.close() }
})

test('sceneRoot is workspace-relative except dot and both asset reference forms keep their distinct bases', async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.root, 'assets'))
    await writeFile(join(f.root, 'assets', 'real.bin'), 'real')
    await f.write({ ...f.manifest, sceneRoot: 'assets', assets: [{ path: 'real.bin', workspacePath: 'scenes/one/asset.bin' }], preview: { image: 'real.bin' } })
    assert.equal(await validateProcessScene(f.root, 'scenes/one'), f.manifestPath)
    await rm(join(f.root, 'assets', 'real.bin'))
    await mkdir(join(f.root, 'scenes', 'one', 'assets'))
    await writeFile(join(f.root, 'scenes', 'one', 'assets', 'real.bin'), 'misleading alternative')
    await assert.rejects(validateProcessScene(f.root, 'scenes/one'))
  } finally { await f.close() }
})

test('physical scene rejects missing references, unsafe paths and malformed schema/cameras', async () => {
  const f = await fixture()
  try {
    for (const field of ['path', 'workspacePath']) for (const path of ['../escape', '/outside', 'a//b', 'https://host/asset', '%2e%2e/asset', '%252e/asset', 'bad%xx', 'missing']) {
      await f.write({ ...f.manifest, assets: [{ [field]: path }] })
      await assert.rejects(validateProcessScene(f.root, 'scenes/one'), `${field}:${path}`)
    }
    for (const value of [null, {}, { ...f.manifest, schema: 'wrong' }, { ...f.manifest, sceneRoot: '../' }, { ...f.manifest, assets: {} },
      { ...f.manifest, preview: { image: 'missing' } }, { ...f.manifest, initialView: { position: [0, 0, 0], target: [0, 0, 0] } },
      { ...f.manifest, initialView: { position: [true, 0, 0], target: [1, 0, 0] } },
      { ...f.manifest, initialView: { position: [0, 0, 0], target: [1, 0, 0], up: [0, 0, 0] } }]) {
      await f.write(value); await assert.rejects(validateProcessScene(f.root, 'scenes/one'))
    }
    await f.write()
    for (const path of ['scenes/../scenes/one', 'scenes/one/other.json', `${f.root}/scenes/../scenes/one`, '/outside/scene-manifest.json']) await assert.rejects(validateProcessScene(f.root, path))
    await writeFile(f.manifestPath, Buffer.from([0xff, 0xfe]))
    await assert.rejects(validateProcessScene(f.root, 'scenes/one'))
  } finally { await f.close() }
})

test('physical scene rejects descendant, leaf, broken and root symlinks and nonregular references', async () => {
  const f = await fixture()
  try {
    await symlink(join(f.root, 'scenes', 'one'), join(f.root, 'linked'))
    await assert.rejects(validateProcessScene(f.root, 'linked'))
    await rm(f.manifestPath)
    await symlink('missing', f.manifestPath)
    await assert.rejects(validateProcessScene(f.root, 'scenes/one'))
    await rm(f.manifestPath); await f.write()
    await symlink('asset.bin', join(f.root, 'scenes', 'one', 'linked.bin'))
    await f.write({ ...f.manifest, assets: [{ path: 'linked.bin' }] })
    await assert.rejects(validateProcessScene(f.root, 'scenes/one'))
    await f.write({ ...f.manifest, sceneRoot: 'linked', assets: [] })
    await assert.rejects(validateProcessScene(f.root, 'scenes/one'))
    await f.write({ ...f.manifest, assets: [{ workspacePath: 'scenes/one' }] })
    await assert.rejects(validateProcessScene(f.root, 'scenes/one'))
    await f.write({ ...f.manifest, sceneRoot: 'scenes/one/asset.bin', assets: [] })
    await assert.rejects(validateProcessScene(f.root, 'scenes/one'))
  } finally { await f.close() }
})

test('physical scene enforces bounded manifest, asset count, per-file and accumulated bytes without charging preview', async () => {
  const f = await fixture()
  try {
    await writeFile(f.manifestPath, ' '.repeat(1024 * 1024 + 1))
    await assert.rejects(validateProcessScene(f.root, 'scenes/one'), /1 MiB/)
    await f.write({ ...f.manifest, assets: new Array(4097).fill(null) })
    await assert.rejects(validateProcessScene(f.root, 'scenes/one'), /too many/)
    const asset = join(f.root, 'scenes', 'one', 'asset.bin')
    await truncate(asset, 16 * 1024 ** 3 + 1) // Sparse fixture; validator only stats referenced assets.
    await f.write()
    await assert.rejects(validateProcessScene(f.root, 'scenes/one'), /size limit/)
    await f.write({ ...f.manifest, assets: [], preview: { image: 'asset.bin' } })
    assert.equal(await validateProcessScene(f.root, 'scenes/one'), f.manifestPath)
    await truncate(asset, 16 * 1024 ** 3)
    await f.write({ ...f.manifest, assets: new Array(5).fill({ path: 'asset.bin' }) })
    await assert.rejects(validateProcessScene(f.root, 'scenes/one'), /total size/)
    await f.write({ ...f.manifest, assets: new Array(4).fill({ path: 'asset.bin' }) })
    assert.equal(await validateProcessScene(f.root, 'scenes/one'), f.manifestPath)
  } finally { await f.close() }
})

test('real CPython canonical validator and Node boundary agree on opaque/null-camera and invalid references', async () => {
  const f = await fixture()
  try {
    const script = `import json,runpy,sys\nv=runpy.run_path('api/services/scene_input.py')['validate_scene_input']\nfrom pathlib import Path\ntry:\n print(json.dumps({'ok':True,'path':str(v(Path(sys.argv[1]),sys.argv[2]))}))\nexcept ValueError:\n print(json.dumps({'ok':False}))`
    for (const value of [f.manifest, { ...f.manifest, assets: [null, 'opaque'], initialView: null },
      { ...f.manifest, initialView: { position: [0, 0, 1], target: [0, 0, 0], up: null } },
      { ...f.manifest, assets: [{ path: 'missing' }] }, { ...f.manifest, assets: [{ path: '../escape' }] }]) {
      await f.write(value)
      const python = JSON.parse(execFileSync('/usr/bin/python3', ['-B', '-c', script, f.root, 'scenes/one'], { timeout: 5000, encoding: 'utf8' }))
      let actual: { ok: boolean; path?: string }
      try { actual = { ok: true, path: await validateProcessScene(f.root, 'scenes/one') } } catch { actual = { ok: false } }
      assert.deepEqual(actual, python)
    }
  } finally { await f.close() }
})

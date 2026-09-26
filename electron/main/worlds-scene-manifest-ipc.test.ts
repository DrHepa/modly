import assert from 'node:assert/strict'
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  isSceneManifestRecord,
  resolveSafeWorkspaceJsonPath,
} from './worlds-scene-manifest-path.ts'
import { writeWorldsSceneManifest } from './worlds-scene-manifest-writer.ts'

const VALID_MANIFEST = {
  schema: 'modly.scene-manifest.v1' as const,
  sceneRoot: '.',
  assets: [],
}

test('resolveSafeWorkspaceJsonPath accepts only safe workspace-relative JSON destinations', () => {
  const workspaceDir = path.resolve('/tmp/modly-workspace')
  assert.deepEqual(resolveSafeWorkspaceJsonPath(workspaceDir, 'Exports/Worlds/scene-manifest.json'), {
    workspacePath: 'Exports/Worlds/scene-manifest.json',
    absolutePath: path.resolve(workspaceDir, 'Exports/Worlds/scene-manifest.json'),
  })

  assert.equal(resolveSafeWorkspaceJsonPath(workspaceDir, '../escape.json'), null)
  assert.equal(resolveSafeWorkspaceJsonPath(workspaceDir, '/tmp/modly-workspace/Exports/scene-manifest.json'), null)
  assert.equal(resolveSafeWorkspaceJsonPath(workspaceDir, 'Exports/Worlds/scene-manifest.txt'), null)
  assert.equal(resolveSafeWorkspaceJsonPath(workspaceDir, 'Exports//scene-manifest.json'), null)

  const projectKey = `world-${'a'.repeat(32)}`
  assert.equal(resolveSafeWorkspaceJsonPath(workspaceDir, 'Worlds/legacy-scene-manifest.json'), null)
  assert.equal(resolveSafeWorkspaceJsonPath(workspaceDir, `Worlds/${projectKey}/project.world-project.json`), null)
  assert.equal(resolveSafeWorkspaceJsonPath(workspaceDir, `Worlds/${projectKey}/scenes/scene-${'b'.repeat(32)}.world-scene.json`), null)
  assert.equal(resolveSafeWorkspaceJsonPath(workspaceDir, `worlds/${projectKey.toUpperCase()}/.modly/state.v1.json`), null)
  assert.equal(resolveSafeWorkspaceJsonPath(workspaceDir, 'C:Worlds/legacy-scene-manifest.json'), null)
  assert.equal(resolveSafeWorkspaceJsonPath(workspaceDir, 'Worlds./legacy-scene-manifest.json'), null)
  assert.equal(resolveSafeWorkspaceJsonPath(workspaceDir, 'Worlds /legacy-scene-manifest.json'), null)
})

test('isSceneManifestRecord verifies only the shared scene manifest contract surface', () => {
  assert.equal(isSceneManifestRecord({ schema: 'modly.scene-manifest.v1', sceneRoot: '.', assets: [] }), true)
  assert.equal(isSceneManifestRecord({ schema: 'modly.scene-manifest.v1', sceneRoot: '.', assets: {} }), false)
  assert.equal(isSceneManifestRecord({ schema: 'wrong', sceneRoot: '.', assets: [] }), false)
  assert.equal(isSceneManifestRecord(null), false)
})

test('scene manifest writer creates ordinary Exports/Worlds parents and writes a synced regular file', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'modly-scene-manifest-writer-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const result = await writeWorldsSceneManifest(root, {
    workspacePath: 'Exports/Worlds/nested/scene-manifest.json',
    manifest: VALID_MANIFEST,
  })
  assert.deepEqual(result, { success: true, workspacePath: 'Exports/Worlds/nested/scene-manifest.json' })
  const output = path.join(root, 'Exports', 'Worlds', 'nested', 'scene-manifest.json')
  assert.equal((await lstat(output)).isFile(), true)
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), VALID_MANIFEST)
})

test('scene manifest writer rejects repository aliases, intermediate links, and final-file symlinks', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'modly-scene-manifest-links-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'Worlds'))
  await mkdir(path.join(root, 'Exports'))
  await symlink(path.join(root, 'Worlds'), path.join(root, 'Exports', 'Worlds'), 'dir')
  const repositoryAlias = await writeWorldsSceneManifest(root, {
    workspacePath: 'Exports/Worlds/scene-manifest.json',
    manifest: VALID_MANIFEST,
  })
  assert.equal(repositoryAlias.success, false)
  await assert.rejects(lstat(path.join(root, 'Worlds', 'scene-manifest.json')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')

  await rm(path.join(root, 'Exports', 'Worlds'))
  await mkdir(path.join(root, 'Exports', 'Worlds'))
  const external = path.join(root, 'external')
  await mkdir(external)
  await symlink(external, path.join(root, 'Exports', 'Worlds', 'linked'), 'dir')
  const intermediate = await writeWorldsSceneManifest(root, {
    workspacePath: 'Exports/Worlds/linked/scene-manifest.json',
    manifest: VALID_MANIFEST,
  })
  assert.equal(intermediate.success, false)
  await assert.rejects(lstat(path.join(external, 'scene-manifest.json')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')

  const canonicalTarget = path.join(root, 'Worlds', 'do-not-touch.json')
  await writeFile(canonicalTarget, 'sentinel')
  const finalPath = path.join(root, 'Exports', 'Worlds', 'final.json')
  await symlink(canonicalTarget, finalPath, 'file')
  const finalLink = await writeWorldsSceneManifest(root, {
    workspacePath: 'Exports/Worlds/final.json',
    manifest: VALID_MANIFEST,
  })
  assert.equal(finalLink.success, false)
  assert.equal(await readFile(canonicalTarget, 'utf8'), 'sentinel')
})

test('scene manifest writer rejects a pre-existing hard-link alias to canonical Worlds data', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'modly-scene-manifest-hard-link-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const canonicalDirectory = path.join(root, 'Worlds', 'world-0123456789abcdef0123456789abcdef')
  const exportDirectory = path.join(root, 'Exports', 'Worlds')
  await mkdir(canonicalDirectory, { recursive: true })
  await mkdir(exportDirectory, { recursive: true })
  const canonicalTarget = path.join(canonicalDirectory, 'project.world-project.json')
  const exportTarget = path.join(exportDirectory, 'scene-manifest.json')
  await writeFile(canonicalTarget, 'canonical-sentinel')
  await link(canonicalTarget, exportTarget)

  const result = await writeWorldsSceneManifest(root, {
    workspacePath: 'Exports/Worlds/scene-manifest.json',
    manifest: VALID_MANIFEST,
  })
  assert.equal(result.success, false)
  assert.equal(await readFile(canonicalTarget, 'utf8'), 'canonical-sentinel')
  assert.equal(await readFile(exportTarget, 'utf8'), 'canonical-sentinel')
})

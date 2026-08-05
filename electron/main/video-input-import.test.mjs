import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

function loadVideoInputModule() {
  const result = buildSync({
    entryPoints: [resolve('electron/main/video-input-import.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  const require = createRequire(import.meta.url)
  const bundleDir = join(tmpdir(), 'modly-video-input-bundle')
  const bundlePath = join(bundleDir, 'video-input-import.cjs')
  return mkdir(bundleDir, { recursive: true })
    .then(() => writeFile(bundlePath, result.outputFiles[0].text, 'utf8'))
    .then(() => require(bundlePath))
}

async function withTemporaryRoot(run) {
  const root = await mkdtemp(join(tmpdir(), 'modly-video-input-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('imports an external video into a collision-safe durable workspace path', async () => {
  await withTemporaryRoot(async (root) => {
    const { importVideoInputToWorkspace } = await loadVideoInputModule()
    const workspaceDir = join(root, 'workspace')
    const sourcePath = join(root, 'My unsafe (clip).MP4')
    await writeFile(sourcePath, 'video-bytes')

    const result = await importVideoInputToWorkspace({
      sourcePath,
      workspaceDir,
      randomUUID: () => '00000000-0000-4000-8000-000000000123',
    })

    assert.deepEqual(result, {
      workspacePath: 'Workflows/Inputs/Videos/00000000-0000-4000-8000-000000000123-My-unsafe-clip.mp4',
      displayName: 'My unsafe (clip).MP4',
    })
    assert.equal(
      await readFile(join(workspaceDir, ...result.workspacePath.split('/')), 'utf8'),
      'video-bytes',
    )
  })
})

test('reuses a canonical video already inside the configured workspace', async () => {
  await withTemporaryRoot(async (root) => {
    const { importVideoInputToWorkspace } = await loadVideoInputModule()
    const workspaceDir = join(root, 'workspace')
    const sourcePath = join(workspaceDir, 'Workflows', 'Inputs', 'existing.webm')
    await mkdir(join(workspaceDir, 'Workflows', 'Inputs'), { recursive: true })
    await writeFile(sourcePath, 'video-bytes')

    const result = await importVideoInputToWorkspace({
      sourcePath,
      workspaceDir,
      randomUUID: () => {
        throw new Error('UUID should not be needed for workspace-owned input')
      },
    })

    assert.deepEqual(result, {
      workspacePath: 'Workflows/Inputs/existing.webm',
      displayName: 'existing.webm',
    })
  })
})

test('copies a video from transient workspace tmp into durable workflow inputs', async () => {
  await withTemporaryRoot(async (root) => {
    const { importVideoInputToWorkspace } = await loadVideoInputModule()
    const workspaceDir = join(root, 'workspace')
    const sourcePath = join(workspaceDir, 'tmp', 'selected.mp4')
    await mkdir(join(workspaceDir, 'tmp'), { recursive: true })
    await writeFile(sourcePath, 'transient-video')

    const result = await importVideoInputToWorkspace({
      sourcePath,
      workspaceDir,
      randomUUID: () => '00000000-0000-4000-8000-000000000321',
    })

    assert.deepEqual(result, {
      workspacePath: 'Workflows/Inputs/Videos/00000000-0000-4000-8000-000000000321-selected.mp4',
      displayName: 'selected.mp4',
    })
    assert.equal(
      await readFile(join(workspaceDir, ...result.workspacePath.split('/')), 'utf8'),
      'transient-video',
    )
  })
})

test('copies an in-workspace symlink whose canonical target escapes the workspace', async () => {
  await withTemporaryRoot(async (root) => {
    const { importVideoInputToWorkspace } = await loadVideoInputModule()
    const workspaceDir = join(root, 'workspace')
    const outsidePath = join(root, 'outside.mp4')
    const linkedPath = join(workspaceDir, 'linked.mp4')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(outsidePath, 'outside-video')
    await symlink(outsidePath, linkedPath)

    const result = await importVideoInputToWorkspace({
      sourcePath: linkedPath,
      workspaceDir,
      randomUUID: () => '00000000-0000-4000-8000-000000000456',
    })

    assert.deepEqual(result, {
      workspacePath: 'Workflows/Inputs/Videos/00000000-0000-4000-8000-000000000456-linked.mp4',
      displayName: 'linked.mp4',
    })
    assert.equal(
      await readFile(join(workspaceDir, ...result.workspacePath.split('/')), 'utf8'),
      'outside-video',
    )
  })
})

test('rejects a destination directory symlink that escapes the workspace', async (t) => {
  await withTemporaryRoot(async (root) => {
    const { importVideoInputToWorkspace } = await loadVideoInputModule()
    const workspaceDir = join(root, 'workspace')
    const inputsDir = join(workspaceDir, 'Workflows', 'Inputs')
    const outsideDirectory = join(root, 'outside-destination')
    const sourcePath = join(root, 'source.mp4')
    await mkdir(inputsDir, { recursive: true })
    await mkdir(outsideDirectory, { recursive: true })
    await writeFile(sourcePath, 'video-bytes')
    try {
      await symlink(outsideDirectory, join(inputsDir, 'Videos'), 'dir')
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
        t.skip('directory symlink creation requires additional privileges on this platform')
        return
      }
      throw error
    }

    await assert.rejects(
      importVideoInputToWorkspace({ sourcePath, workspaceDir }),
      /destination must remain inside the configured workspace/i,
    )
    assert.deepEqual(await readdir(outsideDirectory), [])
  })
})

test('rejects an escaping Workflows symlink before creating destination parents outside the workspace', async (t) => {
  await withTemporaryRoot(async (root) => {
    const { importVideoInputToWorkspace } = await loadVideoInputModule()
    const workspaceDir = join(root, 'workspace')
    const outsideDirectory = join(root, 'outside-workflows')
    const sourcePath = join(root, 'source.mp4')
    await mkdir(workspaceDir, { recursive: true })
    await mkdir(outsideDirectory, { recursive: true })
    await writeFile(sourcePath, 'video-bytes')
    try {
      await symlink(outsideDirectory, join(workspaceDir, 'Workflows'), 'dir')
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
        t.skip('directory symlink creation requires additional privileges on this platform')
        return
      }
      throw error
    }

    await assert.rejects(
      importVideoInputToWorkspace({ sourcePath, workspaceDir }),
      /destination must remain inside the configured workspace/i,
    )
    assert.deepEqual(await readdir(outsideDirectory), [])
  })
})

test('rejects an escaping Inputs symlink before creating destination parents outside the workspace', async (t) => {
  await withTemporaryRoot(async (root) => {
    const { importVideoInputToWorkspace } = await loadVideoInputModule()
    const workspaceDir = join(root, 'workspace')
    const workflowsDir = join(workspaceDir, 'Workflows')
    const outsideDirectory = join(root, 'outside-inputs')
    const sourcePath = join(root, 'source.mp4')
    await mkdir(workflowsDir, { recursive: true })
    await mkdir(outsideDirectory, { recursive: true })
    await writeFile(sourcePath, 'video-bytes')
    try {
      await symlink(outsideDirectory, join(workflowsDir, 'Inputs'), 'dir')
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
        t.skip('directory symlink creation requires additional privileges on this platform')
        return
      }
      throw error
    }

    await assert.rejects(
      importVideoInputToWorkspace({ sourcePath, workspaceDir }),
      /destination must remain inside the configured workspace/i,
    )
    assert.deepEqual(await readdir(outsideDirectory), [])
  })
})

test('imports a regular file without enforcing a hard suffix allowlist', async () => {
  await withTemporaryRoot(async (root) => {
    const { importVideoInputToWorkspace } = await loadVideoInputModule()
    const workspaceDir = join(root, 'workspace')
    const sourcePath = join(root, 'notes.CAPTURE')
    await writeFile(sourcePath, 'video-bytes')

    const result = await importVideoInputToWorkspace({
      sourcePath,
      workspaceDir,
      randomUUID: () => '00000000-0000-4000-8000-000000000789',
    })

    assert.equal(result.workspacePath, 'Workflows/Inputs/Videos/00000000-0000-4000-8000-000000000789-notes.capture')
    assert.equal(result.displayName, 'notes.CAPTURE')
    assert.equal(await readFile(join(workspaceDir, ...result.workspacePath.split('/')), 'utf8'), 'video-bytes')
  })
})

test('fs:selectVideo uses the native video picker and workspace import helper', async () => {
  const source = await readFile(resolve('electron/main/ipc-handlers.ts'), 'utf8')

  assert.match(source, /ipcMain\.handle\('fs:selectVideo', async \(\) =>/)
  assert.match(source, /title:\s*'Select a video'/)
  assert.match(source, /getSettings\(app\.getPath\('userData'\)\)\.workspaceDir/)
  assert.match(source, /await importVideoInputToWorkspace\(\{\s*sourcePath,\s*workspaceDir\s*\}\)/)
  assert.doesNotMatch(source, /fs:selectVideo[\s\S]{0,800}readFileBase64/)
})

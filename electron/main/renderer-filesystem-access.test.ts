import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RendererFilesystemAccess } from './renderer-filesystem-access.ts'

test('renderer filesystem access is limited to canonical configured roots and explicit picker grants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modly-renderer-fs-access-'))
  const userDataDir = join(root, 'user-data')
  const modelsDir = join(userDataDir, 'models')
  const workspaceDir = join(userDataDir, 'workspace')
  const workflowsDir = join(userDataDir, 'workflows')
  const extensionsDir = join(userDataDir, 'extensions')
  const agentPrivateTempDir = join(userDataDir, 'agent-private')
  const agentWorkspaceStagingDir = join(workspaceDir, 'Workflows', 'agent-actions', '.staging')
  const selectedDir = join(root, 'selected')
  const outsideDir = join(root, 'outside')
  const workspacePrefixTrap = `${workspaceDir}-evil`
  for (const path of [modelsDir, workspaceDir, workflowsDir, extensionsDir, userDataDir, agentPrivateTempDir, selectedDir, outsideDir, workspacePrefixTrap]) {
    await mkdir(path, { recursive: true })
  }
  await mkdir(join(workspaceDir, 'tmp'))
  await mkdir(join(workspaceDir, 'Workflows', 'agent-actions'), { recursive: true })
  await mkdir(agentWorkspaceStagingDir, { recursive: true })
  await mkdir(join(selectedDir, 'nested'))
  await symlink(workspaceDir, join(root, 'workspace-link'))

  const access = new RendererFilesystemAccess({
    getConfiguredRoots: () => ({ modelsDir, workspaceDir, workflowsDir, extensionsDir }),
    getProtectedRoots: () => ({ userDataDir, agentPrivateTempDir, agentWorkspaceStagingDir }),
  })

  try {
    assert.equal(await access.resolveListDirectory(modelsDir), modelsDir)
    assert.equal(await access.resolveListDirectory(workspaceDir), workspaceDir)
    await assert.rejects(access.resolveListDirectory(outsideDir))
    await assert.rejects(access.resolveListDirectory(userDataDir))
    await assert.rejects(access.resolveListDirectory(agentPrivateTempDir))
    await assert.rejects(access.resolveListFiles(agentWorkspaceStagingDir))
    await assert.rejects(access.grantSelectedDirectory(agentWorkspaceStagingDir))
    await assert.rejects(access.resolveListDirectory(join(root, 'workspace-link')))

    assert.equal(await access.grantSelectedDirectory(selectedDir), selectedDir)
    assert.equal(await access.resolveListFiles(join(selectedDir, 'nested')), join(selectedDir, 'nested'))
    await assert.rejects(access.grantSelectedDirectory(agentPrivateTempDir))
    await assert.rejects(access.resolveListFiles(workspacePrefixTrap))

    assert.deepEqual(await access.resolveMoveDirectory({ src: modelsDir, dest: selectedDir }), {
      src: modelsDir,
      dest: selectedDir,
    })
    await assert.rejects(access.resolveMoveDirectory({ src: outsideDir, dest: selectedDir }))
    await assert.rejects(access.resolveMoveDirectory({ src: modelsDir, dest: outsideDir }))

    await assert.rejects(access.resolveDeleteDirectory(workspaceDir))
    assert.equal(await access.resolveDeleteDirectory(join(workspaceDir, 'tmp')), join(workspaceDir, 'tmp'))
    await assert.rejects(access.resolveDeleteDirectory(join(workspaceDir, 'Workflows', 'agent-actions')))
    await assert.rejects(access.resolveDeleteDirectory(agentPrivateTempDir))
    await assert.rejects(access.resolveMoveDirectory({ src: workspaceDir, dest: selectedDir }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

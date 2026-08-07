import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  AgentOllamaRuntimeTreeError,
  openAgentOllamaRuntimeTree,
} from './agent-ollama-runtime-tree.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'modly-ollama-runtime-tree-'))
  const runtimeDir = join(root, 'runtime')
  await mkdir(join(runtimeDir, 'cuda_v13'), { recursive: true, mode: 0o755 })
  await writeFile(join(runtimeDir, 'llama-server'), 'runner', { mode: 0o755 })
  await writeFile(join(runtimeDir, 'cuda_v13', 'libllama.so.0.0.1'), 'library', { mode: 0o644 })
  await symlink('cuda_v13/libllama.so.0.0.1', join(runtimeDir, 'libllama.so'))
  return { root, runtimeDir }
}

test('Ollama runtime tree pins one bounded complete directory authority and detects mutation', async (t) => {
  if (process.platform !== 'linux') return t.skip('Ollama runtime trees are Linux-only')
  const value = await fixture()
  t.after(() => rm(value.root, { recursive: true, force: true }))
  const opened = await openAgentOllamaRuntimeTree(value.runtimeDir)
  try {
    assert.equal(opened.identity.entryCount, 5)
    assert.equal(opened.identity.logicalBytes, 13)
    assert.equal(opened.handle.fd >= 3, true)
    await opened.revalidate()
    await writeFile(join(value.runtimeDir, 'llama-server'), 'changed-runner', { mode: 0o755 })
    await assert.rejects(opened.revalidate(), (error: unknown) => (
      error instanceof AgentOllamaRuntimeTreeError && error.code === 'runtime_stale'
    ))
  } finally {
    await opened.close()
  }
  await assert.rejects(opened.revalidate(), /runtime_stale/)
})

test('Ollama runtime tree accepts only relative contained symlinks and safe owner modes', async (t) => {
  if (process.platform !== 'linux') return t.skip('Ollama runtime trees are Linux-only')
  const value = await fixture()
  t.after(() => rm(value.root, { recursive: true, force: true }))
  await writeFile(join(value.root, 'outside'), 'outside', { mode: 0o644 })
  await symlink('../outside', join(value.runtimeDir, 'escape'))
  await assert.rejects(openAgentOllamaRuntimeTree(value.runtimeDir), (error: unknown) => (
    error instanceof AgentOllamaRuntimeTreeError
      && error.code === 'runtime_unavailable'
      && !error.message.includes(value.root)
  ))
  await rm(join(value.runtimeDir, 'escape'))
  await chmod(join(value.runtimeDir, 'llama-server'), 0o775)
  await assert.rejects(openAgentOllamaRuntimeTree(value.runtimeDir), (error: unknown) => (
    error instanceof AgentOllamaRuntimeTreeError && error.code === 'runtime_unavailable'
  ))
})

test('Ollama runtime tree rejects aliases and bounded tree overflow without exposing paths', async (t) => {
  if (process.platform !== 'linux') return t.skip('Ollama runtime trees are Linux-only')
  const value = await fixture()
  t.after(() => rm(value.root, { recursive: true, force: true }))
  const alias = join(value.root, 'runtime-link')
  await symlink(value.runtimeDir, alias)
  await assert.rejects(openAgentOllamaRuntimeTree(alias), (error: unknown) => (
    error instanceof AgentOllamaRuntimeTreeError
      && error.code === 'runtime_unavailable'
      && !error.message.includes(value.root)
  ))
  await assert.rejects(openAgentOllamaRuntimeTree(value.runtimeDir, {
    limits: { maxEntries: 4 },
  }), (error: unknown) => error instanceof AgentOllamaRuntimeTreeError && error.code === 'runtime_unavailable')
  await assert.rejects(openAgentOllamaRuntimeTree(value.runtimeDir, {
    limits: { maxLogicalBytes: 12 },
  }), (error: unknown) => error instanceof AgentOllamaRuntimeTreeError && error.code === 'runtime_unavailable')
  await rm(join(value.runtimeDir, 'llama-server'))
  await assert.rejects(openAgentOllamaRuntimeTree(value.runtimeDir), (error: unknown) => (
    error instanceof AgentOllamaRuntimeTreeError && error.code === 'runtime_unavailable'
  ))
})

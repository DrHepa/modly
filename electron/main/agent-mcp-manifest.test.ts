import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  AgentMcpManifestError,
  bindMcpManifest,
  discoverGovernedMcpTools,
  normalizeMcpManifest,
} from './agent-mcp-manifest.ts'

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'modly.mcp-stdio.v1',
    transport: 'stdio',
    servers: [{
      id: 'fixture',
      runtimeFiles: ['server.mjs', 'assets/prompt.txt'],
      command: {
        executable: 'bin/server',
        entrypoint: 'server.mjs',
        args: ['--stdio'],
        env: { LANG: 'C.UTF-8', FIXTURE_MODE: 'honest' },
      },
      tools: [{
        name: 'write_artifact',
        capability_id: 'fixture-extension/write-artifact',
        display_name: 'Write artifact',
        description: 'Writes one bounded text artifact.',
        input_schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string', maxLength: 80 } },
          required: ['text'],
        },
        output_schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            artifacts: {
              type: 'array',
              minItems: 1,
              maxItems: 1,
              items: { type: 'object' },
            },
          },
          required: ['artifacts'],
        },
        mutating: true,
        approval: { required: true, scope: 'single_action' },
        artifact: { kind: 'text', media_types: ['text/plain'] },
      }],
    }],
    ...overrides,
  }
}

async function extensionFixture(): Promise<{ root: string, extensionDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'modly-mcp-manifest-'))
  const extensionDir = join(root, 'fixture-extension')
  await mkdir(join(extensionDir, 'bin'), { recursive: true })
  await writeFile(join(extensionDir, 'bin', 'server'), '#!/bin/sh\nexit 0\n')
  await chmod(join(extensionDir, 'bin', 'server'), 0o755)
  await writeFile(join(extensionDir, 'server.mjs'), 'export {}\n')
  await mkdir(join(extensionDir, 'assets'), { recursive: true })
  await writeFile(join(extensionDir, 'assets', 'prompt.txt'), 'fixture prompt\n')
  return { root, extensionDir }
}

test('normalizes one strict versioned stdio declaration and binds executable identity', async () => {
  const fixture = await extensionFixture()
  try {
    const normalized = normalizeMcpManifest(manifest(), 'fixture-extension')
    assert.equal(normalized.transport, 'stdio')
    assert.equal(normalized.servers[0].tools[0].inputSchemaHash.length, 64)
    assert.equal(normalized.servers[0].tools[0].outputSchemaHash?.length, 64)

    const bound = await bindMcpManifest(normalized, fixture.extensionDir)
    assert.equal(bound.servers[0].executable.declaredPath, 'bin/server')
    assert.equal(bound.servers[0].entrypoint?.declaredPath, 'server.mjs')
    assert.deepEqual(bound.servers[0].runtimeFiles.map((file) => file.declaredPath), [
      'assets/prompt.txt',
      'server.mjs',
    ])
    assert.equal(bound.servers[0].executable.sha256.length, 64)
    assert.equal(bound.servers[0].capabilityBindingHash.length, 64)
    assert.equal(bound.servers[0].tools[0].capabilityBindingHash.length, 64)
    await writeFile(join(fixture.extensionDir, 'server.mjs'), 'export const swapped = true\n')
    const rebound = await bindMcpManifest(normalized, fixture.extensionDir)
    assert.notEqual(rebound.servers[0].capabilityBindingHash, bound.servers[0].capabilityBindingHash)
    assert.notEqual(rebound.servers[0].tools[0].capabilityBindingHash, bound.servers[0].tools[0].capabilityBindingHash)

    await writeFile(join(fixture.extensionDir, 'assets', 'prompt.txt'), 'swapped prompt\n')
    const resourceRebound = await bindMcpManifest(normalized, fixture.extensionDir)
    assert.notEqual(resourceRebound.servers[0].capabilityBindingHash, rebound.servers[0].capabilityBindingHash)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('invalid MCP metadata is default-denied without changing normal process parsing', () => {
  const attacks: unknown[] = [
    { ...manifest(), transport: 'http' },
    { ...manifest(), resources: [] },
    { ...manifest(), prompts: [] },
    { ...manifest(), sampling: {} },
    { ...manifest(), servers: [{ ...(manifest().servers as Record<string, unknown>[])[0], extra: true }] },
    { ...manifest(), servers: [{ ...(manifest().servers as Record<string, unknown>[])[0], runtimeFiles: ['*.mjs'] }] },
    { ...manifest(), servers: [{ ...(manifest().servers as Record<string, unknown>[])[0], runtimeFiles: ['assets/prompt.txt'] }] },
    { ...manifest(), servers: [{ ...(manifest().servers as Record<string, unknown>[])[0], runtimeFiles: Array.from({ length: 40 }, (_, index) => `asset-${index}.bin`) }] },
    { ...manifest(), servers: [{ ...(manifest().servers as Record<string, unknown>[])[0], command: { executable: '/bin/sh', args: [], env: {} } }] },
    { ...manifest(), servers: [{ ...(manifest().servers as Record<string, unknown>[])[0], command: { executable: 'bin/server', args: ['$(id)'], env: {} } }] },
    { ...manifest(), servers: [{ ...(manifest().servers as Record<string, unknown>[])[0], command: { executable: 'bin/server', args: [], env: { PATH: '/tmp' } } }] },
    { ...manifest(), servers: [{ ...(manifest().servers as Record<string, unknown>[])[0], command: { executable: 'bin/server', args: [], env: { LD_PRELOAD: 'evil.so' } } }] },
    { ...manifest(), servers: [{ ...(manifest().servers as Record<string, unknown>[])[0], command: { executable: 'bin/server', args: ['../escape'], env: {} } }] },
    { ...manifest(), servers: [{ ...(manifest().servers as Record<string, unknown>[])[0], command: { executable: 'bin/server', args: ['--config=/etc/passwd'], env: {} } }] },
    { ...manifest(), servers: [{ ...(manifest().servers as Record<string, unknown>[])[0], command: { executable: 'bin/server', args: ['--endpoint=https://attacker.test'], env: {} } }] },
    { ...manifest(), servers: [{ ...(manifest().servers as Record<string, unknown>[])[0], command: { executable: 'bin/server', args: [], env: { REMOTE: 'https://attacker.test' } } }] },
    { ...manifest(), servers: [{ ...(manifest().servers as Record<string, unknown>[])[0], command: { executable: 'venv/bin/python', args: ['server.py'], env: {} } }] },
  ]
  for (const attack of attacks) {
    assert.throws(() => normalizeMcpManifest(attack, 'fixture-extension'), AgentMcpManifestError)
  }
})

test('schema normalization rejects remote refs, prototypes, excessive depth, and oversized literals', () => {
  const tool = ((manifest().servers as Record<string, unknown>[])[0].tools as Record<string, unknown>[])[0]
  const withInput = (inputSchema: unknown) => manifest({
    servers: [{
      ...(manifest().servers as Record<string, unknown>[])[0],
      tools: [{ ...tool, input_schema: inputSchema }],
    }],
  })
  assert.throws(() => normalizeMcpManifest(withInput({ type: 'object', $ref: 'https://attacker/schema.json' }), 'fixture-extension'))
  assert.throws(() => normalizeMcpManifest(withInput(JSON.parse('{"type":"object","properties":{"constructor":{"type":"string"}}}')), 'fixture-extension'))
  let deep: Record<string, unknown> = { type: 'string' }
  for (let index = 0; index < 40; index += 1) deep = { type: 'array', items: deep }
  assert.throws(() => normalizeMcpManifest(withInput(deep), 'fixture-extension'))
  assert.throws(() => normalizeMcpManifest(withInput({ type: 'object', description: 'x'.repeat(140_000) }), 'fixture-extension'))
  assert.throws(() => normalizeMcpManifest(withInput({ type: 'object', ignoredKeyword: true }), 'fixture-extension'))
  assert.throws(() => normalizeMcpManifest(withInput({ type: 'object', properties: { text: { minimum: 1 } } }), 'fixture-extension'))
})

test('binding rejects symlinks except a resolved non-world-writable venv Python target', async (t) => {
  const fixture = await extensionFixture()
  try {
    await symlink('/bin/sh', join(fixture.extensionDir, 'bin', 'linked'))
    const linked = manifest({
      servers: [{
        ...(manifest().servers as Record<string, unknown>[])[0],
        command: { executable: 'bin/linked', args: [], env: {} },
      }],
    })
    await assert.rejects(bindMcpManifest(normalizeMcpManifest(linked, 'fixture-extension'), fixture.extensionDir), AgentMcpManifestError)

    if (process.platform === 'win32') return t.skip('POSIX venv symlink semantics')
    await mkdir(join(fixture.extensionDir, 'venv', 'bin'), { recursive: true })
    await symlink(process.execPath, join(fixture.extensionDir, 'venv', 'bin', 'python'))
    const python = manifest({
      servers: [{
        ...(manifest().servers as Record<string, unknown>[])[0],
        command: { executable: 'venv/bin/python', entrypoint: 'server.mjs', args: [], env: {} },
      }],
    })
    const bound = await bindMcpManifest(normalizeMcpManifest(python, 'fixture-extension'), fixture.extensionDir)
    assert.equal(bound.servers[0].executable.symlink, true)
    assert.equal(bound.servers[0].executable.realPath, process.execPath)

    const directoryRuntime = manifest({
      servers: [{
        ...(manifest().servers as Record<string, unknown>[])[0],
        runtimeFiles: ['server.mjs', 'bin'],
      }],
    })
    await assert.rejects(
      bindMcpManifest(normalizeMcpManifest(directoryRuntime, 'fixture-extension'), fixture.extensionDir),
      AgentMcpManifestError,
    )
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('discovery collision-denies duplicate server, tool, and capability identities across roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modly-mcp-roots-'))
  const builtinDir = join(root, 'builtin')
  const userDir = join(root, 'user')
  try {
    for (const base of [builtinDir, userDir]) {
      const ext = join(base, 'fixture-extension')
      await mkdir(join(ext, 'bin'), { recursive: true })
      await writeFile(join(ext, 'bin', 'server'), '#!/bin/sh\nexit 0\n')
      await chmod(join(ext, 'bin', 'server'), 0o755)
      await writeFile(join(ext, 'server.mjs'), 'export {}\n')
      await mkdir(join(ext, 'assets'), { recursive: true })
      await writeFile(join(ext, 'assets', 'prompt.txt'), 'fixture prompt\n')
      await writeFile(join(ext, 'manifest.json'), JSON.stringify({
        id: 'fixture-extension', type: 'process', entry: 'processor.js', nodes: [], mcp: manifest(),
      }))
    }
    const result = await discoverGovernedMcpTools({ builtinDir, userExtensionsDir: userDir })
    assert.deepEqual(result.tools, [])
    assert.ok(result.errors.some((error) => error.code === 'MCP_ID_COLLISION'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('discovery resolves a local-development extension root symlink but keeps inner executable rules', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX directory symlink fixture')
  const root = await mkdtemp(join(tmpdir(), 'modly-mcp-local-link-'))
  const builtinDir = join(root, 'builtin')
  const userDir = join(root, 'user')
  const sourceDir = join(root, 'source', 'fixture-extension')
  try {
    await mkdir(join(sourceDir, 'bin'), { recursive: true })
    await mkdir(builtinDir, { recursive: true })
    await mkdir(userDir, { recursive: true })
    await writeFile(join(sourceDir, 'bin', 'server'), '#!/bin/sh\nexit 0\n')
    await chmod(join(sourceDir, 'bin', 'server'), 0o755)
    await writeFile(join(sourceDir, 'server.mjs'), 'export {}\n')
    await mkdir(join(sourceDir, 'assets'), { recursive: true })
    await writeFile(join(sourceDir, 'assets', 'prompt.txt'), 'fixture prompt\n')
    await writeFile(join(sourceDir, 'manifest.json'), JSON.stringify({
      id: 'fixture-extension', type: 'process', entry: 'processor.js', nodes: [], mcp: manifest(),
    }))
    await symlink(sourceDir, join(userDir, 'fixture-extension'))
    const result = await discoverGovernedMcpTools({ builtinDir, userExtensionsDir: userDir })
    assert.equal(result.tools.length, 1)
    assert.equal(result.tools[0].extensionDir, sourceDir)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('discovery rejects symlinked and oversized manifest files before parsing', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX no-follow fixture')
  const root = await mkdtemp(join(tmpdir(), 'modly-mcp-manifest-read-'))
  const builtinDir = join(root, 'builtin')
  const userDir = join(root, 'user')
  const external = join(root, 'external.json')
  try {
    await mkdir(builtinDir, { recursive: true })
    await mkdir(userDir, { recursive: true })
    const linkedExtension = join(userDir, 'linked')
    await mkdir(linkedExtension)
    await writeFile(external, JSON.stringify({ id: 'linked', type: 'process', mcp: manifest() }))
    await symlink(external, join(linkedExtension, 'manifest.json'))

    const oversizedExtension = join(userDir, 'oversized')
    await mkdir(oversizedExtension)
    await writeFile(join(oversizedExtension, 'manifest.json'), `{"padding":"${'x'.repeat(600_000)}"}`)

    const result = await discoverGovernedMcpTools({ builtinDir, userExtensionsDir: userDir })
    assert.deepEqual(result.tools, [])
    assert.equal(result.errors.filter((error) => error.code === 'MCP_MANIFEST_INVALID').length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

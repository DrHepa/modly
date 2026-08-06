import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  AgentMcpManifestError,
  bindMcpManifest,
  discoverGovernedMcpTools,
  mcpInheritedFdRequirement,
  normalizeMcpManifest,
} from './agent-mcp-manifest.ts'
import {
  createAgentHostRuntimeRegistry,
  createDefaultAgentHostRuntimeRegistry,
  inspectAgentHostRuntimeTree,
} from './agent-host-runtime.ts'

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

test('normalization rejects duplicate server ids, tool names, and capability ids', () => {
  const server = (manifest().servers as Record<string, unknown>[])[0]
  const tool = (server.tools as Record<string, unknown>[])[0]
  assert.throws(() => normalizeMcpManifest(manifest({
    servers: [server, {
      ...server,
      tools: [{ ...tool, name: 'second_tool', capability_id: 'fixture-extension/second-tool' }],
    }],
  }), 'fixture-extension'), AgentMcpManifestError)
  assert.throws(() => normalizeMcpManifest(manifest({
    servers: [{
      ...server,
      tools: [tool, { ...tool, capability_id: 'fixture-extension/second-tool' }],
    }],
  }), 'fixture-extension'), AgentMcpManifestError)
  assert.throws(() => normalizeMcpManifest(manifest({
    servers: [{
      ...server,
      tools: [tool, { ...tool, name: 'second_tool' }],
    }],
  }), 'fixture-extension'), AgentMcpManifestError)
})

test('binds typed artifact inputs and bounded file outputs while rejecting a current-owned host runtime', async () => {
  const fixture = await extensionFixture()
  const runtimeRoot = join(fixture.root, 'blender-runtime')
  await mkdir(runtimeRoot, { mode: 0o700 })
  await writeFile(join(runtimeRoot, 'blender'), '#!/bin/sh\nexit 0\n')
  await chmod(join(runtimeRoot, 'blender'), 0o700)
  const server = (manifest().servers as Record<string, unknown>[])[0]
  const tool = (server.tools as Record<string, unknown>[])[0]
  const governed = manifest({
    servers: [{
      ...server,
      hostRuntime: { id: 'blender-5.2', executable: 'blender' },
      artifactOutput: {
        profile: 'relative-files-v1', maxCount: 2,
        maxArtifactBytes: 32 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024,
      },
      tools: [{
        ...tool,
        input_schema: {
          type: 'object', additionalProperties: false,
          properties: { sceneArtifact: { type: 'string', maxLength: 128 } },
          required: ['sceneArtifact'],
        },
        input_artifacts: [{
          argument: 'sceneArtifact', kind: 'blend', media_types: ['application/x-blender'],
        }],
        output_schema: {
          type: 'object', additionalProperties: false,
          properties: { artifacts: { type: 'array', minItems: 1, maxItems: 1, items: { type: 'object' } } },
          required: ['artifacts'],
        },
        artifact: {
          outputs: [{
            path: 'scene.blend', kind: 'blend', media_types: ['application/x-blender'],
            max_bytes: 32 * 1024 * 1024, required: true,
          }],
        },
      }],
    }],
  })
  try {
    const normalized = normalizeMcpManifest(governed, 'fixture-extension')
    assert.deepEqual(normalized.servers[0].tools[0].inputArtifacts, [{
      argument: 'sceneArtifact', kind: 'blend', mediaTypes: ['application/x-blender'], sandboxPath: '/input/0',
    }])
    assert.equal(mcpInheritedFdRequirement(normalized.servers[0]), 9)
    const registry = createAgentHostRuntimeRegistry([{
      id: 'blender-5.2', rootPath: runtimeRoot, ownerPolicy: 'trusted-non-current',
    }])
    await assert.rejects(
      bindMcpManifest(normalized, fixture.extensionDir, { hostRuntimes: registry }),
      (error: unknown) => error instanceof AgentMcpManifestError && error.code === 'runtime_unavailable',
    )

    await assert.rejects(
      bindMcpManifest(normalized, fixture.extensionDir),
      (error: unknown) => error instanceof AgentMcpManifestError && error.code === 'runtime_unavailable',
    )
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('host runtime tree identity is complete, content-bound, bounded, and never trusts the current uid', async () => {
  const root = await mkdtemp(join(process.cwd(), '.modly-host-runtime-test-'))
  const runtimeRoot = join(root, 'runtime')
  const currentUid = process.getuid?.()
  assert.equal(typeof currentUid, 'number')
  const nonOwnerUid = currentUid === 0 ? 1 : currentUid! + 1
  try {
    await mkdir(join(runtimeRoot, 'scripts'), { recursive: true, mode: 0o755 })
    await writeFile(join(runtimeRoot, 'blender'), '#!/bin/sh\nexit 0\n')
    await chmod(join(runtimeRoot, 'blender'), 0o755)
    await writeFile(join(runtimeRoot, 'scripts', 'startup.py'), 'print("first")\n')
    await chmod(join(runtimeRoot, 'scripts', 'startup.py'), 0o644)

    await assert.rejects(
      inspectAgentHostRuntimeTree(runtimeRoot, { currentUid: currentUid! }),
      /current process/i,
    )
    const first = await inspectAgentHostRuntimeTree(runtimeRoot, { currentUid: nonOwnerUid })
    assert.equal(first.entryCount, 4)
    assert.equal(first.entries.some((entry) => entry.relativePath === 'scripts/startup.py' && entry.sha256?.length === 64), true)

    await writeFile(join(runtimeRoot, 'scripts', 'startup.py'), 'print("other")\n')
    await chmod(join(runtimeRoot, 'scripts', 'startup.py'), 0o644)
    const changed = await inspectAgentHostRuntimeTree(runtimeRoot, { currentUid: nonOwnerUid })
    assert.notEqual(changed.treeDigest, first.treeDigest)

    await chmod(join(runtimeRoot, 'scripts', 'startup.py'), 0o666)
    await assert.rejects(inspectAgentHostRuntimeTree(runtimeRoot, { currentUid: nonOwnerUid }), /writable/i)
    await chmod(join(runtimeRoot, 'scripts', 'startup.py'), 0o644)
    await symlink('/etc/passwd', join(runtimeRoot, 'escape'))
    await assert.rejects(inspectAgentHostRuntimeTree(runtimeRoot, { currentUid: nonOwnerUid }), /symlink/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('default Blender registry uses a non-current-owner policy rather than a magic uid', () => {
  const registry = createDefaultAgentHostRuntimeRegistry('linux', 'arm64')
  assert.deepEqual(registry.definitions.get('blender-5.2'), {
    id: 'blender-5.2',
    rootPath: '/opt/blender-5.2.0-aarch64',
    ownerPolicy: 'trusted-non-current',
  })
})

test('artifact bindings and output profiles reject model paths, hashes, unsafe files, and raised legacy defaults', () => {
  const server = (manifest().servers as Record<string, unknown>[])[0]
  const tool = (server.tools as Record<string, unknown>[])[0]
  const withTool = (toolOverride: Record<string, unknown>, serverOverride: Record<string, unknown> = {}) => manifest({
    servers: [{ ...server, ...serverOverride, tools: [{ ...tool, ...toolOverride }] }],
  })
  for (const invalid of [
    withTool({ input_artifacts: [{ argument: 'path', kind: 'text', media_types: ['text/plain'] }] }),
    withTool({ input_artifacts: [{ argument: 'text', kind: 'text', media_types: ['text/plain'], path: '/tmp/x' }] }),
    withTool({ input_artifacts: [{ argument: 'text', kind: 'text', media_types: ['text/plain'], sha256: '0'.repeat(64) }] }),
    withTool({}, { artifactOutput: { profile: 'artifact-v1', maxCount: 5, maxArtifactBytes: 262_144, maxTotalBytes: 1_048_576 } }),
    withTool({ artifact: { outputs: [{ path: 'scene.blend', kind: 'blend', media_types: ['application/x-blender'], max_bytes: 32 * 1024 * 1024, required: true }] } }, {
      artifactOutput: { profile: 'relative-files-v1', maxCount: 2, maxArtifactBytes: 32 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024 },
    }),
    withTool({ artifact: { outputs: [{ path: 'scene.blend', kind: 'blend', media_types: ['application/x-blender'], max_bytes: 16 * 1024 * 1024, required: true }] } }, {
      artifactOutput: { profile: 'relative-files-v1', maxCount: 2, maxArtifactBytes: 32 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 },
    }),
    withTool({ artifact: { outputs: [{ path: '../scene.blend', kind: 'blend', media_types: ['application/x-blender'], max_bytes: 1, required: true }] } }, {
      artifactOutput: { profile: 'relative-files-v1', maxCount: 1, maxArtifactBytes: 33 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 },
    }),
  ]) assert.throws(() => normalizeMcpManifest(invalid, 'fixture-extension'), AgentMcpManifestError)
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

test('discovery collision-denies conflicting extension and server ownership across roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modly-mcp-roots-'))
  const builtinDir = join(root, 'builtin')
  const userDir = join(root, 'user')
  try {
    for (const [index, base] of [builtinDir, userDir].entries()) {
      const ext = join(base, 'fixture-extension')
      await mkdir(join(ext, 'bin'), { recursive: true })
      await writeFile(join(ext, 'bin', 'server'), '#!/bin/sh\nexit 0\n')
      await chmod(join(ext, 'bin', 'server'), 0o755)
      await writeFile(join(ext, 'server.mjs'), 'export {}\n')
      await mkdir(join(ext, 'assets'), { recursive: true })
      await writeFile(join(ext, 'assets', 'prompt.txt'), 'fixture prompt\n')
      await writeFile(join(ext, 'assets', 'alternate.txt'), 'alternate runtime\n')
      const server = (manifest().servers as Record<string, unknown>[])[0]
      const tool = (server.tools as Record<string, unknown>[])[0]
      const declaration = index === 0 ? manifest() : manifest({
        servers: [{
          ...server,
          runtimeFiles: ['server.mjs', 'assets/prompt.txt', 'assets/alternate.txt'],
          artifactOutput: {
            profile: 'relative-files-v1', maxCount: 1,
            maxArtifactBytes: 1024, maxTotalBytes: 1024,
          },
          tools: [{
            ...tool,
            name: 'inspect_scene',
            capability_id: 'fixture-extension/inspect-scene',
            display_name: 'Inspect scene',
            artifact: {
              outputs: [{
                path: 'scene.blend', kind: 'blend', media_types: ['application/x-blender'],
                max_bytes: 1024, required: true,
              }],
            },
          }],
        }],
      })
      await writeFile(join(ext, 'manifest.json'), JSON.stringify({
        id: 'fixture-extension', type: 'process', entry: 'processor.js', nodes: [], mcp: declaration,
      }))
    }
    const result = await discoverGovernedMcpTools({ builtinDir, userExtensionsDir: userDir })
    assert.deepEqual(result.tools, [])
    assert.deepEqual(result.errors.filter((error) => error.code === 'MCP_ID_COLLISION')
      .map((error) => error.capabilityId).sort(), [
      'fixture-extension/inspect-scene',
      'fixture-extension/write-artifact',
    ])
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

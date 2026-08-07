import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import {
  AgentMcpBrokerError,
  OwnedStdioTransport,
  buildBubblewrapLaunch,
  createAgentMcpSandboxReadiness,
  createAgentMcpExecutor,
  validateMcpArguments,
  type McpTransportFactory,
} from './agent-mcp-broker.ts'
import { listAgentCapabilities } from './automation-capabilities.ts'
import type { AgentActionExecutorRequest } from './agent-actions-service.ts'
import type { AgentCapabilitySnapshotV1 } from '../../src/shared/types/agentActions.ts'

const inputSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: { text: { type: 'string', minLength: 1, maxLength: 80 } },
  required: ['text'],
}
const outputSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    artifacts: {
      type: 'array', minItems: 1, maxItems: 2,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string' }, name: { type: 'string' },
          kind: { const: 'text' }, mediaType: { const: 'text/plain' },
          sha256: { type: 'string' }, dataBase64: { type: 'string' },
        },
        required: ['id', 'name', 'kind', 'mediaType', 'sha256', 'dataBase64'],
      },
    },
  },
  required: ['artifacts'],
}
const relativeFileOutputSchema = {
  type: 'object' as const, additionalProperties: false,
  properties: {
    artifacts: {
      type: 'array' as const, minItems: 1, maxItems: 1,
      items: {
        type: 'object' as const, additionalProperties: false,
        properties: {
          id: { type: 'string' as const }, name: { const: 'scene.blend' },
          kind: { const: 'blend' }, mediaType: { const: 'application/x-blender' },
        },
        required: ['id', 'name', 'kind', 'mediaType'],
      },
    },
  },
  required: ['artifacts'],
}
const dualRelativeFileOutputSchema = {
  type: 'object' as const, additionalProperties: false,
  properties: {
    artifacts: {
      type: 'array' as const, minItems: 2, maxItems: 2,
      items: {
        type: 'object' as const, additionalProperties: false,
        properties: {
          id: { type: 'string' as const }, name: { type: 'string' as const },
          kind: { type: 'string' as const }, mediaType: { type: 'string' as const },
        },
        required: ['id', 'name', 'kind', 'mediaType'],
      },
    },
  },
  required: ['artifacts'],
}

interface Fixture {
  root: string
  builtinDir: string
  userDir: string
  workspaceDir: string
  capability: AgentCapabilitySnapshotV1
}

interface FileFixture extends Fixture {
  privateDir: string
  inputArtifact: AgentActionExecutorRequest['inputArtifacts'][number]
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'modly-mcp-broker-'))
  const builtinDir = join(root, 'builtin')
  const userDir = join(root, 'user')
  const workspaceDir = join(root, 'workspace')
  const extensionDir = join(userDir, 'fixture-mcp')
  await mkdir(join(extensionDir, 'bin'), { recursive: true })
  await mkdir(builtinDir, { recursive: true })
  await mkdir(workspaceDir, { recursive: true })
  await writeFile(join(extensionDir, 'bin', 'server'), '#!/bin/sh\nexit 0\n')
  await chmod(join(extensionDir, 'bin', 'server'), 0o755)
  await writeFile(join(extensionDir, 'server.mjs'), 'export {}\n')
  await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify({
    id: 'fixture-mcp', name: 'Fixture MCP', version: '1.0.0', type: 'process', entry: 'processor.js', nodes: [],
    mcp: {
      schema: 'modly.mcp-stdio.v1', transport: 'stdio', servers: [{
        id: 'fixture-server', runtimeFiles: ['server.mjs'],
        command: { executable: 'bin/server', entrypoint: 'server.mjs', args: ['--stdio'], env: { FIXTURE_MODE: 'honest' } },
        tools: [{
          name: 'write_text', capability_id: 'fixture-mcp/write-text', display_name: 'Write text',
          description: 'Writes one bounded text artifact.', input_schema: inputSchema, output_schema: outputSchema,
          mutating: true, approval: { required: true, scope: 'single_action' },
          artifact: { kind: 'text', media_types: ['text/plain'] },
        }],
      }],
    },
  }))
  const inventory = await listAgentCapabilities({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
  assert.equal(inventory.capabilities.length, 1)
  return { root, builtinDir, userDir, workspaceDir, capability: inventory.capabilities[0] }
}

async function fileFixture(options: { outputCount?: 1 | 2 } = {}): Promise<FileFixture> {
  const target = await fixture()
  const outputCount = options.outputCount ?? 1
  const extensionDir = join(target.userDir, 'fixture-mcp')
  const privateDir = join(target.root, 'private')
  await mkdir(privateDir, { mode: 0o700 })
  const source = Buffer.from('approved scene bytes')
  await mkdir(join(target.workspaceDir, 'Workflows', 'sources'), { recursive: true })
  await writeFile(join(target.workspaceDir, 'Workflows', 'sources', 'scene.blend'), source)
  const inputArtifact = {
    schema: 'modly.artifact-ref.v1' as const, version: 1 as const, id: 'approved-scene', kind: 'blend' as const,
    mediaType: 'application/x-blender', workspacePath: 'Workflows/sources/scene.blend',
    sha256: createHash('sha256').update(source).digest('hex'), sizeBytes: source.byteLength,
  }
  const fileInputSchema = {
    type: 'object' as const, additionalProperties: false,
    properties: { sceneArtifact: { type: 'string' as const, maxLength: 128 } },
    required: ['sceneArtifact'],
  }
  await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify({
    id: 'fixture-mcp', name: 'Fixture MCP', version: '1.0.0', type: 'process', entry: 'processor.js', nodes: [],
    mcp: {
      schema: 'modly.mcp-stdio.v1', transport: 'stdio', servers: [{
        id: 'fixture-server', runtimeFiles: ['server.mjs'],
        artifactOutput: {
          profile: 'relative-files-v1', maxCount: outputCount,
          maxArtifactBytes: 32 * 1024 * 1024, maxTotalBytes: outputCount * 32 * 1024 * 1024,
        },
        command: { executable: 'bin/server', entrypoint: 'server.mjs', args: ['--stdio'], env: {} },
        tools: [{
          name: 'render_scene', capability_id: 'fixture-mcp/render-scene', display_name: 'Render scene',
          description: 'Reads one bound scene and emits one broker-owned file.',
          input_schema: fileInputSchema,
          input_artifacts: [{ argument: 'sceneArtifact', kind: 'blend', media_types: ['application/x-blender'] }],
          output_schema: outputCount === 1 ? relativeFileOutputSchema : dualRelativeFileOutputSchema,
          mutating: true, approval: { required: true, scope: 'single_action' },
          artifact: { outputs: [
            {
              path: 'scene.blend', kind: 'blend', media_types: ['application/x-blender'],
              max_bytes: 32 * 1024 * 1024, required: true,
            },
            ...(outputCount === 2 ? [{
              path: 'preview.png', kind: 'image', media_types: ['image/png'],
              max_bytes: 32 * 1024 * 1024, required: true,
            }] : []),
          ] },
        }],
      }],
    },
  }))
  const inventory = await listAgentCapabilities({ builtinDir: target.builtinDir, userExtensionsDir: target.userDir, trustedRepos: new Set() })
  assert.equal(inventory.capabilities.length, 1)
  return { ...target, privateDir, capability: inventory.capabilities[0], inputArtifact }
}

function request(capability: AgentCapabilitySnapshotV1, signal = new AbortController().signal): AgentActionExecutorRequest {
  return {
    actionId: 'action-mcp-fixture', originSessionId: 'session-mcp-fixture', proposalHash: 'f'.repeat(64),
    capability, arguments: { text: 'hello' }, inputArtifacts: [], signal,
    model: {
      provider: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'qwen3.6:latest',
      digest: `sha256:${'a'.repeat(64)}`,
    },
  }
}

function fileRequest(target: FileFixture): AgentActionExecutorRequest {
  return {
    ...request(target.capability),
    arguments: { sceneArtifact: target.inputArtifact.id },
    inputArtifacts: [target.inputArtifact],
  }
}

function embeddedArtifact(text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const data = Buffer.from(text)
  return {
    id: 'answer',
    name: 'answer.txt',
    kind: 'text',
    mediaType: 'text/plain',
    sha256: createHash('sha256').update(data).digest('hex'),
    dataBase64: data.toString('base64'),
    ...overrides,
  }
}

function serverFactory(options: {
  tools?: Array<{ name: string, inputSchema: typeof inputSchema, outputSchema?: typeof outputSchema }>
  onCall: (args: { server: Server, signal: AbortSignal, argumentsValue: unknown }) => Promise<unknown>
  onList?: () => Promise<void>
  capabilities?: NonNullable<ConstructorParameters<typeof Server>[1]>['capabilities']
  onClose?: () => void
}): McpTransportFactory {
  return async (context) => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = new Server(
      { name: 'fixture-server', version: '1.0.0' },
      { capabilities: options.capabilities ?? { tools: {} } },
    )
    const tools = options.tools ?? [{ name: 'write_text', inputSchema, outputSchema }]
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      await options.onList?.()
      return { tools }
    })
    server.setRequestHandler(CallToolRequestSchema, async (requestValue) => options.onCall({
      server, signal: context.signal, argumentsValue: requestValue.params.arguments,
    }) as never)
    await server.connect(serverTransport)
    return {
      transport: clientTransport,
      cancel: async () => { await server.close() },
      close: async () => { options.onClose?.(); await server.close() },
    }
  }
}

test('official SDK client executes an exact tool set and returns only authoritative artifact candidates', async () => {
  const target = await fixture()
  let closed = 0
  try {
    const executor = createAgentMcpExecutor({
      discovery: { builtinDir: target.builtinDir, userExtensionsDir: target.userDir },
      getWorkspaceRoot: async () => target.workspaceDir,
      transportFactory: serverFactory({
        onClose: () => { closed += 1 },
        onCall: async () => ({
          content: [{ type: 'text', text: 'created' }],
          structuredContent: { artifacts: [embeddedArtifact('hello')] },
        }),
      }),
    })
    const result = await executor(request(target.capability)) as {
      artifacts: Array<Record<string, unknown>>
      rollback: () => Promise<void>
    }
    assert.equal(result.artifacts.length, 1)
    assert.equal(result.artifacts[0].workspacePath, 'Workflows/agent-actions/action-mcp-fixture/answer.txt')
    assert.equal(result.artifacts[0].sha256, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    assert.equal(JSON.stringify(result).includes('fixture-server'), false)
    assert.equal(JSON.stringify(result).includes('created'), false)
    assert.equal(await readFile(join(target.workspaceDir, String(result.artifacts[0].workspacePath)), 'utf8'), 'hello')
    assert.equal(closed, 1)
    await result.rollback()
    await assert.rejects(readFile(join(target.workspaceDir, String(result.artifacts[0].workspacePath))), { code: 'ENOENT' })
  } finally {
    await rm(target.root, { recursive: true, force: true })
  }
})

test('typed MCP artifact ids become deterministic read-only input paths and relative files publish only after exit', async () => {
  const target = await fileFixture()
  let outputFile = ''
  let receivedArguments: unknown
  const fileInputSchema = target.capability.execution?.kind === 'mcp_tool'
    ? target.capability.execution.inputSchema as typeof inputSchema
    : inputSchema
  try {
    const baseFactory = serverFactory({
      tools: [{ name: 'render_scene', inputSchema: fileInputSchema, outputSchema: relativeFileOutputSchema as never }],
      onCall: async ({ argumentsValue }) => {
        receivedArguments = argumentsValue
        await writeFile(outputFile, 'rendered scene')
        return {
          content: [{ type: 'text', text: 'created' }],
          structuredContent: { artifacts: [{
            id: 'rendered-scene', name: 'scene.blend', kind: 'blend', mediaType: 'application/x-blender',
          }] },
        }
      },
    })
    const executor = createAgentMcpExecutor({
      discovery: { builtinDir: target.builtinDir, userExtensionsDir: target.userDir },
      getWorkspaceRoot: () => target.workspaceDir,
      transportFactory: async (context) => {
        assert.deepEqual(context.outputFiles?.map((slot) => slot.path), ['scene.blend'])
        outputFile = context.outputFiles?.[0]?.hostPath ?? ''
        assert.ok(outputFile.startsWith(join(target.workspaceDir, 'Workflows', 'agent-actions', '.staging')))
        return baseFactory(context)
      },
    })
    const result = await executor(fileRequest(target)) as { artifacts: Array<Record<string, unknown>>, rollback: () => Promise<void> }
    assert.deepEqual(receivedArguments, { sceneArtifact: '/input/0' })
    assert.equal(result.artifacts[0].kind, 'blend')
    assert.equal(await readFile(join(target.workspaceDir, String(result.artifacts[0].workspacePath)), 'utf8'), 'rendered scene')
    await result.rollback()
  } finally {
    await rm(target.root, { recursive: true, force: true })
  }
})

test('relative-file output rejects hardlinks and rolls back the whole publication', async () => {
  const target = await fileFixture()
  let outputFile = ''
  const fileInputSchema = target.capability.execution?.kind === 'mcp_tool'
    ? target.capability.execution.inputSchema as typeof inputSchema
    : inputSchema
  try {
    const baseFactory = serverFactory({
      tools: [{ name: 'render_scene', inputSchema: fileInputSchema, outputSchema: relativeFileOutputSchema as never }],
      onCall: async () => {
        await writeFile(outputFile, 'unsafe hardlink')
        await link(outputFile, join(outputFile, '..', 'alias.blend'))
        return {
          content: [{ type: 'text', text: 'created' }],
          structuredContent: { artifacts: [{
            id: 'rendered-scene', name: 'scene.blend', kind: 'blend', mediaType: 'application/x-blender',
          }] },
        }
      },
    })
    const executor = createAgentMcpExecutor({
      discovery: { builtinDir: target.builtinDir, userExtensionsDir: target.userDir },
      getWorkspaceRoot: () => target.workspaceDir,
      transportFactory: async (context) => { outputFile = context.outputFiles?.[0]?.hostPath ?? ''; return baseFactory(context) },
    })
    await assert.rejects(executor(fileRequest(target)), AgentMcpBrokerError)
    await assert.rejects(readdir(join(target.workspaceDir, 'Workflows/agent-actions/action-mcp-fixture')), { code: 'ENOENT' })
  } finally {
    await rm(target.root, { recursive: true, force: true })
  }
})

test('production relative-files launch gives two 32 MiB slots the declared 64 MiB process ceiling', async () => {
  const target = await fileFixture({ outputCount: 2 })
  const recordedArgs = join(target.root, 'prlimit-args.txt')
  const bwrapPath = join(target.root, 'fake-bwrap')
  const prlimitPath = join(target.root, 'fake-prlimit')
  try {
    await writeFile(bwrapPath, '#!/bin/sh\nexit 97\n')
    await writeFile(prlimitPath, `#!/bin/sh\nprintf '%s\\n' "$@" > "${recordedArgs}"\nexit 97\n`)
    await chmod(bwrapPath, 0o755)
    await chmod(prlimitPath, 0o755)
    const executor = createAgentMcpExecutor({
      discovery: { builtinDir: target.builtinDir, userExtensionsDir: target.userDir },
      getWorkspaceRoot: () => target.workspaceDir,
      bwrapPath,
      prlimitPath,
      sandboxReadiness: async () => true,
      initializeTimeoutMs: 1_000,
    })
    await assert.rejects(executor(fileRequest(target)), AgentMcpBrokerError)
    const args = (await readFile(recordedArgs, 'utf8')).trim().split('\n')
    assert.deepEqual(args.slice(0, 3), [
      `--fsize=${64 * 1024 * 1024}:${64 * 1024 * 1024}`,
      '--',
      '/proc/self/fd/3',
    ])
  } finally {
    await rm(target.root, { recursive: true, force: true })
  }
})

test('relative-file output still rejects a post-exit file larger than its 32 MiB slot', async () => {
  const target = await fileFixture()
  let outputFile = ''
  const fileInputSchema = target.capability.execution?.kind === 'mcp_tool'
    ? target.capability.execution.inputSchema as typeof inputSchema
    : inputSchema
  try {
    const baseFactory = serverFactory({
      tools: [{ name: 'render_scene', inputSchema: fileInputSchema, outputSchema: relativeFileOutputSchema as never }],
      onCall: async () => {
        await truncate(outputFile, (32 * 1024 * 1024) + 1)
        return {
          content: [{ type: 'text', text: 'created' }],
          structuredContent: { artifacts: [{
            id: 'rendered-scene', name: 'scene.blend', kind: 'blend', mediaType: 'application/x-blender',
          }] },
        }
      },
    })
    const executor = createAgentMcpExecutor({
      discovery: { builtinDir: target.builtinDir, userExtensionsDir: target.userDir },
      getWorkspaceRoot: () => target.workspaceDir,
      transportFactory: async (context) => {
        outputFile = context.outputFiles?.[0]?.hostPath ?? ''
        return baseFactory(context)
      },
    })
    await assert.rejects(executor(fileRequest(target)), (error: unknown) => {
      assert.ok(error instanceof AgentMcpBrokerError)
      assert.equal(error.code, 'artifact_too_large')
      return true
    })
    await assert.rejects(readdir(join(target.workspaceDir, 'Workflows/agent-actions/action-mcp-fixture')), { code: 'ENOENT' })
  } finally {
    await rm(target.root, { recursive: true, force: true })
  }
})

test('schema drift, missing tools, and extra tools fail before tools/call', async () => {
  const target = await fixture()
  try {
    const variants = [
      [{ name: 'write_text', inputSchema: { ...inputSchema, required: [] }, outputSchema }],
      [],
      [
        { name: 'write_text', inputSchema, outputSchema },
        { name: 'unexpected', inputSchema, outputSchema },
      ],
    ]
    for (const tools of variants) {
      let called = false
      const executor = createAgentMcpExecutor({
        discovery: { builtinDir: target.builtinDir, userExtensionsDir: target.userDir },
        getWorkspaceRoot: async () => target.workspaceDir,
        transportFactory: serverFactory({ tools: tools as never, onCall: async () => { called = true; return { content: [] } } }),
      })
      await assert.rejects(executor(request(target.capability)), (error: unknown) => {
        assert.ok(error instanceof AgentMcpBrokerError)
        assert.equal(error.code, 'schema_drift')
        return true
      })
      assert.equal(called, false)
    }
  } finally {
    await rm(target.root, { recursive: true, force: true })
  }
})

test('manifest and entrypoint identity are re-read immediately before tools/call', async () => {
  const target = await fixture()
  let called = false
  try {
    const executor = createAgentMcpExecutor({
      discovery: { builtinDir: target.builtinDir, userExtensionsDir: target.userDir },
      getWorkspaceRoot: async () => target.workspaceDir,
      transportFactory: serverFactory({
        onList: async () => {
          await writeFile(join(target.userDir, 'fixture-mcp', 'server.mjs'), 'export const swapped = true\n')
        },
        onCall: async () => { called = true; return { content: [] } },
      }),
    })
    await assert.rejects(executor(request(target.capability)), (error: unknown) => {
      assert.ok(error instanceof AgentMcpBrokerError)
      assert.equal(error.code, 'capability_stale')
      return true
    })
    assert.equal(called, false)
  } finally {
    await rm(target.root, { recursive: true, force: true })
  }
})

test('a noisy server advertising logging or non-tool surfaces is rejected before tools/call', async () => {
  const target = await fixture()
  let called = false
  try {
    const executor = createAgentMcpExecutor({
      discovery: { builtinDir: target.builtinDir, userExtensionsDir: target.userDir },
      getWorkspaceRoot: async () => target.workspaceDir,
      transportFactory: serverFactory({
        capabilities: { tools: {}, logging: {} },
        onCall: async () => { called = true; return { content: [] } },
      }),
    })
    await assert.rejects(executor(request(target.capability)), (error: unknown) => {
      assert.ok(error instanceof AgentMcpBrokerError)
      assert.equal(error.code, 'protocol_error')
      return true
    })
    assert.equal(called, false)
  } finally {
    await rm(target.root, { recursive: true, force: true })
  }
})

test('strict Ajv validation rejects extra fields, prototype keys, excessive depth, arrays, strings, and request bytes', () => {
  assert.deepEqual(validateMcpArguments(inputSchema, { text: 'ok' }), { text: 'ok' })
  for (const attack of [
    { text: 'ok', extra: true },
    JSON.parse('{"text":"ok","__proto__":{"polluted":true}}'),
    { text: 'x'.repeat(210_000) },
    { text: 'ok', nested: Array.from({ length: 1_100 }, () => 1) },
  ]) {
    assert.throws(() => validateMcpArguments(inputSchema, attack), AgentMcpBrokerError)
  }
  let deep: Record<string, unknown> = { leaf: true }
  for (let index = 0; index < 40; index += 1) deep = { nested: deep }
  assert.throws(() => validateMcpArguments({ type: 'object' }, deep), AgentMcpBrokerError)
  assert.throws(() => validateMcpArguments({ type: 'object', ignoredKeyword: true }, {}), AgentMcpBrokerError)
  assert.throws(() => validateMcpArguments({ type: 'object', properties: { count: { minimum: 1 } } }, {}), AgentMcpBrokerError)
})

test('embedded artifact caps reject oversized bytes without publishing a host file', async () => {
  const target = await fixture()
  try {
    const oversized = Buffer.alloc(300 * 1024, 0x61)
    const executor = createAgentMcpExecutor({
      discovery: { builtinDir: target.builtinDir, userExtensionsDir: target.userDir },
      getWorkspaceRoot: async () => target.workspaceDir,
      transportFactory: serverFactory({
        onCall: async () => ({
          content: [{ type: 'text', text: 'created' }],
          structuredContent: { artifacts: [embeddedArtifact('', {
            sha256: createHash('sha256').update(oversized).digest('hex'),
            dataBase64: oversized.toString('base64'),
          })] },
        }),
      }),
    })
    await assert.rejects(executor(request(target.capability)), (error: unknown) => {
      assert.ok(error instanceof AgentMcpBrokerError)
      assert.equal(error.code, 'artifact_too_large')
      return true
    })
    await assert.rejects(readdir(join(target.workspaceDir, 'Workflows/agent-actions/action-mcp-fixture')), { code: 'ENOENT' })
  } finally {
    await rm(target.root, { recursive: true, force: true })
  }
})

test('path descriptors, malformed bytes, hash drift, raw executable content, and oversized text are rejected', async () => {
  const target = await fixture()
  try {
    const results = [
      {
        content: [{ type: 'resource_link', uri: 'file:///etc/passwd', name: 'secret' }],
        structuredContent: { artifacts: [{ ...embeddedArtifact('hello'), relativePath: '/etc/passwd' }] },
      },
      {
        content: [{ type: 'text', text: 'x'.repeat(70_000) }],
        structuredContent: { artifacts: [embeddedArtifact('hello')] },
      },
      {
        content: [{ type: 'text', text: 'created' }],
        structuredContent: { artifacts: [embeddedArtifact('hello')] },
        rawExecutableData: 'AAECAwQ=',
      },
      {
        content: [{ type: 'text', text: 'created' }],
        structuredContent: { artifacts: [embeddedArtifact('hello', { dataBase64: 'not-base64!' })] },
      },
      {
        content: [{ type: 'text', text: 'created' }],
        structuredContent: { artifacts: [embeddedArtifact('hello', { dataBase64: 'Zh==' })] },
      },
      {
        content: [{ type: 'text', text: 'created' }],
        structuredContent: { artifacts: [embeddedArtifact('hello', { sha256: '0'.repeat(64) })] },
      },
    ]
    for (const response of results) {
      const executor = createAgentMcpExecutor({
        discovery: { builtinDir: target.builtinDir, userExtensionsDir: target.userDir },
        getWorkspaceRoot: async () => target.workspaceDir,
        transportFactory: serverFactory({ onCall: async () => response }),
      })
      await assert.rejects(executor(request(target.capability)), AgentMcpBrokerError)
    }
  } finally {
    await rm(target.root, { recursive: true, force: true })
  }
})

test('timeouts and cancellation close every session and leave no successful result', async () => {
  const target = await fixture()
  let closed = 0
  try {
    const hanging = createAgentMcpExecutor({
      discovery: { builtinDir: target.builtinDir, userExtensionsDir: target.userDir },
      getWorkspaceRoot: async () => target.workspaceDir,
      callTimeoutMs: 30,
      transportFactory: serverFactory({
        onClose: () => { closed += 1 },
        onCall: async () => new Promise(() => undefined),
      }),
    })
    await assert.rejects(hanging(request(target.capability)), (error: unknown) => {
      assert.ok(error instanceof AgentMcpBrokerError)
      assert.equal(error.code, 'timeout')
      return true
    })

    const controller = new AbortController()
    const cancelled = createAgentMcpExecutor({
      discovery: { builtinDir: target.builtinDir, userExtensionsDir: target.userDir },
      getWorkspaceRoot: async () => target.workspaceDir,
      transportFactory: serverFactory({
        onClose: () => { closed += 1 },
        onCall: async () => new Promise(() => undefined),
      }),
    })
    const pending = cancelled(request(target.capability, controller.signal))
    setTimeout(() => controller.abort(), 10)
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof AgentMcpBrokerError)
      assert.equal(error.code, 'cancelled')
      return true
    })
    assert.equal(closed, 2)
  } finally {
    await rm(target.root, { recursive: true, force: true })
  }
})

test('client advertises no roots, sampling, elicitation, or other unsupported capabilities', async () => {
  const target = await fixture()
  let clientCapabilities: unknown
  let rootsRejected = false
  let samplingRejected = false
  try {
    const executor = createAgentMcpExecutor({
      discovery: { builtinDir: target.builtinDir, userExtensionsDir: target.userDir },
      getWorkspaceRoot: async () => target.workspaceDir,
      transportFactory: serverFactory({ onCall: async ({ server }) => {
        clientCapabilities = server.getClientCapabilities()
        try { await server.listRoots() } catch { rootsRejected = true }
        try {
          await server.createMessage({
            messages: [{ role: 'user', content: { type: 'text', text: 'must be rejected' } }],
            maxTokens: 1,
          })
        } catch { samplingRejected = true }
        return {
          content: [{ type: 'text', text: 'created' }],
          structuredContent: { artifacts: [embeddedArtifact('hello')] },
        }
      } }),
    })
    await executor(request(target.capability))
    assert.deepEqual(clientCapabilities, {})
    assert.equal(rootsRejected, true)
    assert.equal(samplingRejected, true)
  } finally {
    await rm(target.root, { recursive: true, force: true })
  }
})

test('bubblewrap launch is direct, no-network, read-only, minimal-env, and fail-closed off Linux', async () => {
  const target = await fixture()
  try {
    assert.throws(() => buildBubblewrapLaunch({
      platform: 'darwin', bwrapFd: 3, executableFd: 4, runtimeFiles: [],
      executable: 'bin/server', args: [], env: {}, systemPaths: [],
    }), (error: unknown) => error instanceof AgentMcpBrokerError && error.code === 'sandbox_unavailable')
    const embeddedLaunch = buildBubblewrapLaunch({
      platform: 'linux', bwrapFd: 3, executableFd: 4,
      runtimeFiles: [{ path: 'server.mjs', fd: 5 }],
      executable: 'bin/server', entrypoint: 'server.mjs', args: ['--stdio'], env: {}, systemPaths: ['/usr'],
    })
    assert.equal(embeddedLaunch.command, '/proc/self/fd/3')
    assert.equal(embeddedLaunch.args.some((argument) => argument.startsWith('--fsize=')), false)
    const launch = buildBubblewrapLaunch({
      platform: 'linux', bwrapFd: 3, executableFd: 4,
      runtimeFiles: [{ path: 'server.mjs', fd: 5 }],
      outputFiles: [{ path: 'scene.blend', fd: 6 }, { path: 'preview.png', fd: 7 }],
      prlimitFd: 8,
      processFileSizeLimitBytes: 64 * 1024 * 1024,
      executable: 'bin/server',
      entrypoint: 'server.mjs', args: ['--stdio'], env: { FIXTURE_MODE: 'honest' }, systemPaths: ['/usr', '/bin', '/lib'],
    })
    assert.equal(launch.command, '/proc/self/fd/8')
    assert.deepEqual(launch.args.slice(0, 3), [
      `--fsize=${64 * 1024 * 1024}:${64 * 1024 * 1024}`,
      '--',
      '/proc/self/fd/3',
    ])
    assert.equal(launch.shell, false)
    assert.ok(launch.args.includes('--unshare-all'))
    assert.ok(launch.args.includes('--unshare-user'))
    assert.ok(launch.args.includes('--disable-userns'))
    assert.ok(launch.args.includes('--die-with-parent'))
    assert.ok(launch.args.includes('--clearenv'))
    assert.ok(launch.args.includes('/app/server.mjs'))
    assert.ok(launch.args.includes('--ro-bind-fd'))
    const outputBind = launch.args.findIndex((value, index) => value === '--bind-fd'
      && launch.args[index + 1] === '6' && launch.args[index + 2] === '/output/scene.blend')
    assert.notEqual(outputBind, -1)
    assert.equal(launch.args.some((value, index) => value === '--bind'
      && launch.args[index + 2] === '/output'), false)
    assert.ok(launch.args.includes('--size'))
    assert.deepEqual(launch.args.slice(launch.args.indexOf('--size'), launch.args.indexOf('--size') + 4), [
      '--size', String(64 * 1024 * 1024), '--tmpfs', '/tmp',
    ])
    assert.ok(launch.args.includes('--dir') && launch.args.includes('/output'))
    assert.equal(launch.args.includes('/extension'), false)
    assert.ok(launch.args.includes('/run/modly/executable'))
    assert.equal(JSON.stringify(launch).includes(process.env.HOME ?? 'impossible'), false)
    assert.deepEqual(Object.keys(launch.env).sort(), ['LANG', 'LC_ALL'])
  } finally {
    await rm(target.root, { recursive: true, force: true })
  }
})

test('sandbox readiness is asynchronous, profile-probed, and cached independently', async () => {
  const probes: string[] = []
  const readiness = createAgentMcpSandboxReadiness({
    platform: 'linux',
    probe: async (profile) => {
      probes.push(profile)
      return profile === 'artifact-v1'
    },
    cacheTtlMs: 30_000,
  })
  assert.equal(await readiness('artifact-v1'), true)
  assert.equal(await readiness('artifact-v1'), true)
  assert.equal(await readiness('relative-files-v1'), false)
  assert.equal(await readiness('relative-files-v1'), false)
  assert.deepEqual(probes, ['artifact-v1', 'relative-files-v1'])
})

test('fixed-output inventory requires its complete readiness profile while basic MCP remains available', async () => {
  const basic = await fixture()
  const fixed = await fileFixture()
  try {
    const partialReadiness = createAgentMcpSandboxReadiness({
      platform: 'linux',
      probe: async (profile) => profile === 'artifact-v1',
    })
    const partialProfiles = {
      'artifact-v1': await partialReadiness('artifact-v1'),
      'relative-files-v1': await partialReadiness('relative-files-v1'),
    }
    const basicInventory = await listAgentCapabilities({
      builtinDir: basic.builtinDir, userExtensionsDir: basic.userDir, trustedRepos: new Set(),
      mcpSandboxReady: partialProfiles,
    })
    const fixedUnavailable = await listAgentCapabilities({
      builtinDir: fixed.builtinDir, userExtensionsDir: fixed.userDir, trustedRepos: new Set(),
      mcpSandboxReady: partialProfiles,
    })
    assert.equal(basicInventory.capabilities.length, 1)
    assert.deepEqual(fixedUnavailable.capabilities, [])
    assert.ok(fixedUnavailable.errors.some((error) => error.code === 'MCP_SANDBOX_UNAVAILABLE'))

    const completeReadiness = createAgentMcpSandboxReadiness({
      platform: 'linux',
      probe: async () => true,
    })
    const completeProfiles = {
      'artifact-v1': await completeReadiness('artifact-v1'),
      'relative-files-v1': await completeReadiness('relative-files-v1'),
    }
    const fixedAvailable = await listAgentCapabilities({
      builtinDir: fixed.builtinDir, userExtensionsDir: fixed.userDir, trustedRepos: new Set(),
      mcpSandboxReady: completeProfiles,
    })
    assert.equal(fixedAvailable.capabilities.length, 1)
  } finally {
    await rm(basic.root, { recursive: true, force: true })
    await rm(fixed.root, { recursive: true, force: true })
  }
})

test('owned stdio transport kills the complete detached process group without orphans', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux process-group and procfd semantics')
  const root = await mkdtemp(join(tmpdir(), 'modly-owned-stdio-'))
  const original = new URL('./fixtures/mcp-process-tree-server.mjs', import.meta.url)
  const pinned = join(root, 'server.mjs')
  const pidFile = join(root, 'pids.json')
  await writeFile(pinned, await readFile(original))
  const transport = new OwnedStdioTransport({
    command: process.execPath,
    args: [pinned, pidFile],
    env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    cwd: process.cwd(),
    terminationGraceMs: 50,
  })
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const client = new Client({ name: 'process-tree-test', version: '1.0.0' }, { capabilities: {} })
  try {
    await client.connect(transport)
    const pending = client.callTool({ name: 'hang', arguments: {} }).catch(() => undefined)
    let pids: { parent: number, child: number } | undefined
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { pids = JSON.parse(await readFile(pidFile, 'utf8')) as { parent: number, child: number }; break } catch {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    assert.ok(pids)
    await transport.close()
    await pending
    for (const pid of [pids.parent, pids.child]) {
      assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH')
    }
  } finally {
    await transport.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

test('owned stdio transport skips group KILL after a verified fast TERM exit and leaves unrelated processes alone', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux process-group identity semantics')
  const signals: NodeJS.Signals[] = []
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
    detached: true,
    stdio: 'ignore',
  })
  const transport = new OwnedStdioTransport({
    command: process.execPath,
    args: ['-e', "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1_000)"],
    env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    cwd: process.cwd(),
    terminationGraceMs: 200,
    onGroupSignal: (signal) => { signals.push(signal) },
  })
  try {
    await transport.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    await transport.close()
    assert.deepEqual(signals, ['SIGTERM'])
    assert.doesNotThrow(() => process.kill(unrelated.pid!, 0))
  } finally {
    if (unrelated.pid !== undefined) {
      try { process.kill(-unrelated.pid, 'SIGKILL') } catch { /* test cleanup */ }
    }
  }
})

test('production executor returns stable sandbox_unavailable instead of an unsandboxed fallback', async () => {
  const target = await fixture()
  try {
    const executor = createAgentMcpExecutor({
      discovery: { builtinDir: target.builtinDir, userExtensionsDir: target.userDir },
      getWorkspaceRoot: async () => target.workspaceDir,
      platform: 'darwin',
      bwrapPath: join(target.root, 'missing-bwrap'),
    })
    await assert.rejects(executor(request(target.capability)), (error: unknown) => {
      assert.ok(error instanceof AgentMcpBrokerError)
      assert.equal(error.code, 'sandbox_unavailable')
      return true
    })
  } finally {
    await rm(target.root, { recursive: true, force: true })
  }
})

test('broker source has no renderer IPC or legacy extensions:runProcess path', async () => {
  const source = await readFile(new URL('./agent-mcp-broker.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /ipcMain|ipcRenderer|extensions:runProcess|runProcessExtensionWithDeps/)
  assert.match(source, /signalOwnedProcessGroup\(pid, startTime, 'SIGTERM'\)/)
  assert.match(source, /signalOwnedProcessGroup\(pid, startTime, 'SIGKILL'\)/)
  assert.match(source, /sha256 !== identity\.sha256/)
  assert.match(source, /inheritedHandles, ownsInheritedHandles: false/)
  assert.match(source, /'--ro-bind-fd'/)
  assert.match(source, /sourceHandle = slot\.handle/)
  assert.doesNotMatch(source, /sourceHandle = await open\(source/)
  const preload = await readFile(new URL('../preload/electron-api.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(preload, /['"]mcp:|callMcp|runMcp|serverId/)
})

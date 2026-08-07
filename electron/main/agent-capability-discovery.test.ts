import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  listAgentCapabilities,
  listVisibleExtensions,
  parseExtensionManifest,
} from './automation-capabilities.ts'
import { discoverGovernedMcpTools, normalizeMcpManifest } from './agent-mcp-manifest.ts'

function declaration(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'modly.agent-capability-declaration.v1',
    capability_id: 'cad-tools/generate',
    display_name: 'Generate CAD',
    description: 'Generate a CAD mesh from text.',
    approval: { required: true, scope: 'single_action' },
    process: {
      schema: 'modly.agent-process.v1',
      runtimeFiles: ['processor.js'],
      resourceFiles: ['assets/runtime-data.json'],
      artifacts: {
        maxCount: 3,
        maxTotalBytes: 4096,
        allowed: [
          { kind: 'glb', mediaTypes: ['model/gltf-binary'], maxBytes: 3072 },
          { kind: 'plan', mediaTypes: ['text/markdown'], maxBytes: 1024 },
        ],
      },
    },
    ...overrides,
  }
}

const OMIT_AGENT = Symbol('omit-agent')

function processManifest(agent: unknown = declaration()) {
  return {
    id: 'cad-tools',
    name: 'CAD Tools',
    version: '1.0.0',
    type: 'process' as const,
    entry: 'processor.js',
    nodes: [{
      id: 'generate', name: 'Generate', input: 'text' as const, output: 'mesh' as const,
      params_schema: [{ id: 'quality', type: 'select', default: 'balanced' }],
      ...(agent === OMIT_AGENT ? {} : { agent }),
    }],
  }
}

test('manifest Agent process declarations are strict opt-in and legacy processes stay normally discoverable', () => {
  const legacy = parseExtensionManifest(processManifest(OMIT_AGENT), 'fallback', new Set())
  assert.equal(legacy.type, 'process')
  assert.equal(legacy.nodes.length, 1)
  assert.equal(legacy.nodes[0].agent, undefined)

  const valid = parseExtensionManifest(processManifest(), 'fallback', new Set())
  assert.deepEqual(valid.nodes[0].agent, declaration())

  const withModelAccess = declaration({
    process: {
      ...declaration().process,
      runtimeFiles: ['processor.pyz'],
      runtime: { kind: 'extension-python-venv-v1', interpreter: 'bin/python' },
      modelAccess: {
        schema: 'modly.agent-model-access.v1',
        profile: 'ollama-responses-json-v1',
      },
    },
  })
  assert.deepEqual(
    parseExtensionManifest({ ...processManifest(withModelAccess), entry: 'processor.pyz' }, 'fallback', new Set()).nodes[0].agent,
    withModelAccess,
  )

  const missingProcess = parseExtensionManifest(processManifest(declaration({ process: undefined })), 'fallback', new Set())
  assert.equal(missingProcess.nodes[0].agent, undefined)

  const model = parseExtensionManifest({ ...processManifest(), type: 'model' as const }, 'fallback', new Set())
  assert.equal(model.nodes[0].agent, undefined)
})

test('malformed, inherited, polluted, and unknown Agent declarations fail closed without hiding the process', () => {
  const inherited = Object.assign(Object.create(declaration()), {})
  const cases: unknown[] = [
    declaration({ capability_id: '../escape' }),
    declaration({ capability_id: 'cad-tools/other' }),
    declaration({ approval: { required: false, scope: 'single_action' } }),
    declaration({ approval: { required: true, scope: 'session' } }),
    declaration({ approval: { required: true, scope: 'single_action', token: 'leak' } }),
    declaration({ command: 'bash' }),
    declaration({ process: {
      ...declaration().process,
      modelAccess: { schema: 'modly.agent-model-access.v1', profile: 'unsupported' },
    } }),
    declaration({ process: {
      ...declaration().process,
      modelAccess: {
        schema: 'modly.agent-model-access.v1', profile: 'ollama-responses-json-v1', endpoint: 'http://127.0.0.1:11434',
      },
    } }),
    declaration({ process: {
      schema: 'modly.agent-process.v1',
      runtimeFiles: ['processor.js', '../escape.js'],
      resourceFiles: [],
      artifacts: { maxCount: 1, maxTotalBytes: 100, allowed: [{ kind: 'glb', mediaTypes: ['model/gltf-binary'], maxBytes: 100 }] },
    } }),
    declaration({ process: {
      schema: 'modly.agent-process.v1',
      runtimeFiles: ['lib/runtime.js'],
      resourceFiles: [],
      artifacts: { maxCount: 1, maxTotalBytes: 100, allowed: [{ kind: 'glb', mediaTypes: ['model/gltf-binary'], maxBytes: 100 }] },
    } }),
    declaration({ process: {
      schema: 'modly.agent-process.v1',
      runtimeFiles: ['processor.js', 'lib/runtime.js'],
      resourceFiles: [],
      artifacts: { maxCount: 1, maxTotalBytes: 100, allowed: [{ kind: 'glb', mediaTypes: ['model/gltf-binary'], maxBytes: 100 }] },
    } }),
    declaration({ process: {
      schema: 'modly.agent-process.v1',
      runtimeFiles: ['processor.js'],
      resourceFiles: ['lib/runtime.js'],
      artifacts: { maxCount: 1, maxTotalBytes: 100, allowed: [{ kind: 'glb', mediaTypes: ['model/gltf-binary'], maxBytes: 100 }] },
    } }),
    JSON.parse(JSON.stringify(declaration()).replace('{', '{"__proto__":{"polluted":true},')),
    inherited,
  ]

  for (const agent of cases) {
    const extension = parseExtensionManifest(processManifest(agent), 'fallback', new Set())
    assert.equal(extension.type, 'process')
    assert.equal(extension.nodes.length, 1)
    assert.equal(extension.nodes[0].agent, undefined)
  }
  assert.equal(({} as { polluted?: boolean }).polluted, undefined)
})

test('only validated opt-in process nodes appear in renderer-safe Agent inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modly-agent-capabilities-'))
  const builtinDir = join(root, 'builtin')
  const userDir = join(root, 'user')
  await mkdir(join(userDir, 'cad-tools'), { recursive: true })
  await mkdir(join(userDir, 'legacy-tools'), { recursive: true })
  await mkdir(join(userDir, 'bad-tools'), { recursive: true })
  await mkdir(builtinDir, { recursive: true })
  await mkdir(join(userDir, 'cad-tools', 'assets'), { recursive: true })
  await writeFile(join(userDir, 'cad-tools', 'processor.js'), 'export {}\n')
  await writeFile(join(userDir, 'cad-tools', 'assets', 'runtime-data.json'), '{"runtime":true}\n')
  await writeFile(join(userDir, 'cad-tools', 'manifest.json'), JSON.stringify(processManifest()))
  await writeFile(join(userDir, 'legacy-tools', 'manifest.json'), JSON.stringify({
    ...processManifest(OMIT_AGENT), id: 'legacy-tools', nodes: [{ id: 'legacy', input: 'mesh', output: 'mesh' }],
  }))
  await writeFile(join(userDir, 'bad-tools', 'manifest.json'), JSON.stringify({
    ...processManifest(declaration({ capability_id: 'bad-tools/not-the-node' })), id: 'bad-tools',
  }))

  try {
    const ordinary = await listVisibleExtensions({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
    assert.deepEqual(ordinary.map((item) => item.id).sort(), ['bad-tools', 'cad-tools', 'legacy-tools'])

    const inventory = await listAgentCapabilities({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
    assert.equal(inventory.capabilities.length, 1)
    const [capability] = inventory.capabilities
    assert.equal(capability.id, 'cad-tools/generate')
    assert.equal(capability.hash.length, 64)
    assert.equal(capability.execution?.kind, 'process')
    if (capability.execution?.kind !== 'process') assert.fail('expected process execution metadata')
    assert.equal(capability.execution.schema, 'modly.agent-process-execution.v1')
    assert.equal(capability.execution.entry, 'processor.js')
    assert.equal(capability.execution.runtimeHash.length, 64)
    assert.deepEqual(capability.execution.runtimeFiles.map((file) => file.path), ['processor.js'])
    assert.deepEqual(capability.execution.resourceFiles.map((file) => file.path), ['assets/runtime-data.json'])
    assert.deepEqual(capability.execution.artifacts.allowed.map((item) => item.kind), ['glb', 'plan'])
    assert.deepEqual(capability.node.paramsSchema, [{ id: 'quality', type: 'select', default: 'balanced' }])
    assert.equal('entry' in capability, false)
    assert.equal('path' in capability, false)
    assert.equal(JSON.stringify(capability).includes(userDir), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runtime files are identity-bound and missing, symlinked, directory, or changed files deny only Agent inventory', async (t) => {
  if (process.platform === 'win32') t.skip('O_NOFOLLOW identity coverage is POSIX-specific')
  const root = await mkdtemp(join(tmpdir(), 'modly-agent-process-runtime-'))
  const builtinDir = join(root, 'builtin')
  const userDir = join(root, 'user')
  await mkdir(builtinDir, { recursive: true })
  const extensionDir = join(userDir, 'cad-tools')
  await mkdir(join(extensionDir, 'assets'), { recursive: true })
  await writeFile(join(extensionDir, 'processor.js'), 'export {}\n')
  await writeFile(join(extensionDir, 'assets', 'runtime-data.json'), '{"version":1}\n')
  await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify(processManifest()))

  try {
    const first = await listAgentCapabilities({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
    assert.equal(first.capabilities.length, 1)
    await writeFile(join(extensionDir, 'assets', 'runtime-data.json'), '{"version":2}\n')
    const second = await listAgentCapabilities({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
    assert.equal(second.capabilities.length, 1)
    assert.notEqual(first.capabilities[0].hash, second.capabilities[0].hash)

    await rm(join(extensionDir, 'assets', 'runtime-data.json'))
    const missing = await listAgentCapabilities({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
    assert.deepEqual(missing.capabilities, [])
    const ordinary = await listVisibleExtensions({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
    assert.equal(ordinary[0]?.type, 'process')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Agent inventory denies duplicate capability IDs across roots and duplicate nodes deterministically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modly-agent-capability-collisions-'))
  const builtinDir = join(root, 'builtin')
  const userDir = join(root, 'user')
  await mkdir(join(builtinDir, 'cad-tools'), { recursive: true })
  await mkdir(join(builtinDir, 'shadow-tools'), { recursive: true })
  await mkdir(join(userDir, 'cad-tools'), { recursive: true })
  await mkdir(join(userDir, 'shadow-tools'), { recursive: true })
  await mkdir(join(userDir, 'duplicate-nodes'), { recursive: true })
  for (const extensionDir of [
    join(builtinDir, 'cad-tools'), join(userDir, 'cad-tools'),
    join(builtinDir, 'shadow-tools'), join(userDir, 'shadow-tools'),
    join(userDir, 'duplicate-nodes'),
  ]) {
    await mkdir(join(extensionDir, 'assets'), { recursive: true })
    await writeFile(join(extensionDir, 'processor.js'), 'export {}\n')
    await writeFile(join(extensionDir, 'assets', 'runtime-data.json'), '{"runtime":true}\n')
  }
  await writeFile(join(builtinDir, 'cad-tools', 'manifest.json'), JSON.stringify(processManifest()))
  await writeFile(join(userDir, 'cad-tools', 'manifest.json'), JSON.stringify(processManifest()))
  await writeFile(join(builtinDir, 'shadow-tools', 'manifest.json'), JSON.stringify({
    ...processManifest(), id: 'shadow-tools', nodes: [{ ...processManifest().nodes[0], agent: declaration({ capability_id: 'shadow-tools/generate' }) }],
  }))
  await writeFile(join(userDir, 'shadow-tools', 'manifest.json'), JSON.stringify({
    ...processManifest(OMIT_AGENT), id: 'shadow-tools', nodes: [{ id: 'generate', input: 'text', output: 'mesh', params_schema: [] }],
  }))
  const duplicateDeclaration = declaration({ capability_id: 'duplicate-nodes/generate' })
  await writeFile(join(userDir, 'duplicate-nodes', 'manifest.json'), JSON.stringify({
    ...processManifest(),
    id: 'duplicate-nodes',
    nodes: [
      { id: 'generate', input: 'text', output: 'mesh', params_schema: [], agent: duplicateDeclaration },
      { id: 'generate', input: 'text', output: 'mesh', params_schema: [], agent: duplicateDeclaration },
    ],
  }))

  try {
    const ordinary = await listVisibleExtensions({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
    assert.equal(ordinary.filter((extension) => extension.id === 'cad-tools').length, 2)
    assert.equal(ordinary.find((extension) => extension.id === 'duplicate-nodes')?.nodes.length, 2)

    const inventory = await listAgentCapabilities({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
    assert.deepEqual(inventory.capabilities, [])
    assert.deepEqual(
      inventory.errors.filter((error) => error.code === 'AGENT_CAPABILITY_ID_COLLISION').map((error) => error.capabilityId),
      ['cad-tools/generate', 'duplicate-nodes/generate', 'shadow-tools/generate'],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('invalid normalized snapshot fields remove only Agent eligibility', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modly-agent-invalid-snapshots-'))
  const builtinDir = join(root, 'builtin')
  const userDir = join(root, 'user')
  await mkdir(builtinDir, { recursive: true })
  const manifests = [
    { ...processManifest(), id: 'bad-name', name: 42, nodes: [{ ...processManifest().nodes[0], agent: declaration({ capability_id: 'bad-name/generate' }) }] },
    { ...processManifest(), id: 'bad-version', version: { major: 1 }, nodes: [{ ...processManifest().nodes[0], agent: declaration({ capability_id: 'bad-version/generate' }) }] },
    { ...processManifest(), id: 'bad-param', nodes: [{ ...processManifest().nodes[0], params_schema: [{ id: 'quality', label: 'Quality', type: 'select', default: 'balanced', executable: '/bin/sh' }], agent: declaration({ capability_id: 'bad-param/generate' }) }] },
    { ...processManifest(), id: 'bad-inputs', nodes: [{ ...processManifest().nodes[0], inputs: [{ name: 'source', type: 'mesh', required: 'yes' }], agent: declaration({ capability_id: 'bad-inputs/generate' }) }] },
    { ...processManifest(), id: 'bad-output', nodes: [{ ...processManifest().nodes[0], output: 'archive', agent: declaration({ capability_id: 'bad-output/generate' }) }] },
  ]
  for (const manifest of manifests) {
    await mkdir(join(userDir, String(manifest.id)), { recursive: true })
    await writeFile(join(userDir, String(manifest.id), 'manifest.json'), JSON.stringify(manifest))
  }

  try {
    const ordinary = await listVisibleExtensions({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
    assert.equal(ordinary.length, manifests.length)
    const inventory = await listAgentCapabilities({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
    assert.deepEqual(inventory.capabilities, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('seven tools from one MCP server retain one server binding and join the governed inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modly-agent-mcp-capability-'))
  const builtinDir = join(root, 'builtin')
  const userDir = join(root, 'user')
  const extensionDir = join(userDir, 'mcp-tools')
  const toolDeclarations = [
    { name: 'inspect_scene', id: 'inspect-scene', displayName: 'Inspect scene', mutating: false },
    { name: 'create_primitive', id: 'create-primitive', displayName: 'Create primitive', mutating: true },
    { name: 'apply_transform', id: 'apply-transform', displayName: 'Apply transform', mutating: true },
    { name: 'assign_material', id: 'assign-material', displayName: 'Assign material', mutating: true },
    { name: 'render_scene', id: 'render-scene', displayName: 'Render scene', mutating: true },
    { name: 'export_scene', id: 'export-scene', displayName: 'Export scene', mutating: true },
    { name: 'save_scene', id: 'save-scene', displayName: 'Save scene', mutating: true },
  ].map((tool) => ({
    name: tool.name,
    capability_id: `mcp-tools/${tool.id}`,
    display_name: tool.displayName,
    description: `${tool.displayName} through one governed Blender-like server.`,
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: { request: { type: 'string', maxLength: 100 } }, required: ['request'],
    },
    mutating: tool.mutating,
    approval: { required: true, scope: 'single_action' },
    artifact: { kind: 'text', media_types: ['text/plain'] },
  }))
  const mcpManifest = {
    schema: 'modly.mcp-stdio.v1', transport: 'stdio', servers: [{
      id: 'private-server',
      runtimeFiles: [],
      command: { executable: 'bin/server', args: ['--stdio'], env: {} },
      tools: toolDeclarations,
    }],
  }
  await mkdir(join(extensionDir, 'bin'), { recursive: true })
  await mkdir(builtinDir, { recursive: true })
  await writeFile(join(extensionDir, 'bin', 'server'), '#!/bin/sh\nexit 0\n')
  await chmod(join(extensionDir, 'bin', 'server'), 0o755)
  const normalized = normalizeMcpManifest(mcpManifest, 'mcp-tools')
  assert.equal(normalized.servers.length, 1)
  assert.equal(normalized.servers[0].tools.length, 7)
  await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify({
    id: 'mcp-tools', name: 'MCP Tools', version: '1.0.0', type: 'process', entry: 'processor.js', nodes: [],
    mcp: mcpManifest,
  }))

  try {
    const discovered = await discoverGovernedMcpTools({ builtinDir, userExtensionsDir: userDir })
    assert.deepEqual(discovered.errors, [])
    assert.equal(discovered.tools.length, 7)
    assert.equal(new Set(discovered.tools.map((candidate) => candidate.server.capabilityBindingHash)).size, 1)
    assert.equal(new Set(discovered.tools.map((candidate) => candidate.tool.capabilityBindingHash)).size, 7)

    const inventory = await listAgentCapabilities({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
    assert.deepEqual(inventory.errors, [])
    assert.deepEqual(inventory.capabilities.map((capability) => capability.id), toolDeclarations
      .map((tool) => tool.capability_id).sort())
    assert.equal(new Set(inventory.capabilities.map((capability) => capability.hash)).size, 7)
    const toolBindingHashes = inventory.capabilities.map((capability) => {
      assert.equal(capability.execution?.kind, 'mcp_tool')
      if (capability.execution?.kind !== 'mcp_tool') assert.fail('expected MCP tool execution')
      assert.equal(capability.execution.inputSchemaHash.length, 64)
      assert.equal(capability.execution.bindingHash.length, 64)
      assert.equal(capability.node.output, 'text')
      return capability.execution.bindingHash
    })
    assert.equal(new Set(toolBindingHashes).size, 7)
    const publicJson = JSON.stringify(inventory.capabilities)
    assert.equal(publicJson.includes('private-server'), false)
    assert.equal(publicJson.includes('inspect_scene'), false)
    assert.equal(publicJson.includes('bin/server'), false)
    assert.equal(publicJson.includes(extensionDir), false)

    const unavailable = await listAgentCapabilities({
      builtinDir, userExtensionsDir: userDir, trustedRepos: new Set(), mcpSandboxReady: false,
    })
    assert.deepEqual(unavailable.capabilities, [])
    assert.ok(unavailable.errors.some((error) => error.code === 'MCP_SANDBOX_UNAVAILABLE'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('invalid MCP metadata leaves the ordinary process visible but default-denies Agent execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modly-agent-invalid-mcp-'))
  const builtinDir = join(root, 'builtin')
  const userDir = join(root, 'user')
  const extensionDir = join(userDir, 'legacy-safe')
  await mkdir(extensionDir, { recursive: true })
  await mkdir(builtinDir, { recursive: true })
  await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify({
    id: 'legacy-safe', name: 'Legacy Safe', type: 'process', entry: 'processor.js',
    nodes: [{ id: 'run', input: 'text', output: 'text' }],
    mcp: { schema: 'modly.mcp-stdio.v1', transport: 'http', servers: [] },
  }))
  try {
    const ordinary = await listVisibleExtensions({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
    assert.equal(ordinary.find((extension) => extension.id === 'legacy-safe')?.type, 'process')
    const inventory = await listAgentCapabilities({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
    assert.deepEqual(inventory.capabilities, [])
    assert.ok(inventory.errors.some((error) => error.code === 'MCP_MANIFEST_INVALID'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

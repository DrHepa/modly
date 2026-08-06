import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  listAgentCapabilities,
  listVisibleExtensions,
  parseExtensionManifest,
} from './automation-capabilities.ts'

function declaration(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'modly.agent-capability-declaration.v1',
    capability_id: 'cad-tools/generate',
    display_name: 'Generate CAD',
    description: 'Generate a CAD mesh from text.',
    approval: { required: true, scope: 'single_action' },
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

test('manifest Agent declarations are strict opt-in and legacy processes stay normally discoverable', () => {
  const legacy = parseExtensionManifest(processManifest(OMIT_AGENT), 'fallback', new Set())
  assert.equal(legacy.type, 'process')
  assert.equal(legacy.nodes.length, 1)
  assert.equal(legacy.nodes[0].agent, undefined)

  const valid = parseExtensionManifest(processManifest(), 'fallback', new Set())
  assert.deepEqual(valid.nodes[0].agent, declaration())

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
    assert.deepEqual(capability.node.paramsSchema, [{ id: 'quality', type: 'select', default: 'balanced' }])
    assert.equal('entry' in capability, false)
    assert.equal('path' in capability, false)
    assert.equal(JSON.stringify(capability).includes('processor.js'), false)
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

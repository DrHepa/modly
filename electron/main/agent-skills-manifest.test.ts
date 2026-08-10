import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { AgentCapabilitySnapshotV1 } from '../../src/shared/types/agentActions.ts'
import { AgentActionsService, AgentActionsServiceError } from './agent-actions-service.ts'
import {
  listAgentCapabilities,
  listVisibleExtensions,
  resolveCanonicalProcessTarget,
} from './automation-capabilities.ts'
import { discoverGovernedMcpTools } from './agent-mcp-manifest.ts'
import {
  AgentSkillsManifestError,
  bindAgentSkillSet,
  normalizeAgentSkillsDeclaration,
  parseAgentSkillDocument,
} from './agent-skills-manifest.ts'
import { assertAgentCapabilitySnapshotV1, canonicalJson } from './agent-trust-contracts.ts'
import { parseStrictJson, StrictJsonError } from './strict-json.ts'

const SKILL_PATH = 'skills/cad-planner.md'

function skillDocument(options: {
  name?: string
  summary?: string
  instruction?: string
  constraint?: string
  examples?: string[]
} = {}): string {
  const examples = options.examples ?? ['Create a 40 mm cube with a centered 10 mm through-hole.']
  return [
    '---',
    `name: ${options.name ?? 'modly-cad-planner-v1'}`,
    'version: 1',
    `summary: ${options.summary ?? 'Plan deterministic CAD operations for an approved capability.'}`,
    '---',
    '',
    '## Instructions',
    `- ${options.instruction ?? 'Interpret dimensions in millimetres.'}`,
    '',
    '## Constraints',
    `- ${options.constraint ?? 'Return only declared artifacts.'}`,
    ...(examples.length > 0 ? ['', '## Examples', ...examples.map((example) => `- ${example}`)] : []),
    '',
  ].join('\n')
}

function skillsDeclaration(file = SKILL_PATH): Record<string, unknown> {
  return { schema: 'modly.agent-skills.v1', file }
}

function processAgent(capabilityId: string, skills?: unknown): Record<string, unknown> {
  return {
    schema: 'modly.agent-capability-declaration.v1',
    capability_id: capabilityId,
    display_name: `Run ${capabilityId.split('/')[1]}`,
    description: 'Run a governed process capability.',
    approval: { required: true, scope: 'single_action' },
    process: {
      schema: 'modly.agent-process.v1',
      runtimeFiles: ['processor.js'],
      resourceFiles: [],
      artifacts: {
        maxCount: 1,
        maxTotalBytes: 4096,
        allowed: [{ kind: 'text', mediaTypes: ['text/plain'], maxBytes: 4096 }],
      },
    },
    ...(skills === undefined ? {} : { skills }),
  }
}

function processNode(extensionId: string, nodeId: string, skills?: unknown): Record<string, unknown> {
  return {
    id: nodeId,
    name: nodeId,
    input: 'text',
    output: 'text',
    params_schema: [],
    agent: processAgent(`${extensionId}/${nodeId}`, skills),
  }
}

function mcpTool(extensionId: string, nodeId: string, skills?: unknown): Record<string, unknown> {
  return {
    name: nodeId,
    capability_id: `${extensionId}/${nodeId}`,
    display_name: `Run ${nodeId}`,
    description: 'Run a governed MCP tool.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    mutating: true,
    approval: { required: true, scope: 'single_action' },
    artifact: { kind: 'text', media_types: ['text/plain'] },
    ...(skills === undefined ? {} : { skills }),
  }
}

function mcpDeclaration(extensionId: string, tools: Record<string, unknown>[]): Record<string, unknown> {
  return {
    schema: 'modly.mcp-stdio.v1',
    transport: 'stdio',
    servers: [{
      id: 'skill-server',
      runtimeFiles: [],
      command: { executable: 'bin/server', args: ['--stdio'], env: {} },
      tools,
    }],
  }
}

async function writeExtension(options: {
  root: string
  id: string
  nodes?: Record<string, unknown>[]
  tools?: Record<string, unknown>[]
  skills?: Record<string, string>
}): Promise<string> {
  const extensionDir = join(options.root, options.id)
  await mkdir(join(extensionDir, 'bin'), { recursive: true })
  await mkdir(join(extensionDir, 'skills'), { recursive: true })
  await writeFile(join(extensionDir, 'processor.js'), 'export {}\n')
  await writeFile(join(extensionDir, 'bin', 'server'), '#!/bin/sh\nexit 0\n')
  await chmod(join(extensionDir, 'bin', 'server'), 0o755)
  for (const [file, content] of Object.entries(options.skills ?? {})) {
    await writeFile(join(extensionDir, 'skills', file), content)
  }
  await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify({
    id: options.id,
    name: options.id,
    version: '1.0.0',
    type: 'process',
    entry: 'processor.js',
    nodes: options.nodes ?? [],
    ...(options.tools ? { mcp: mcpDeclaration(options.id, options.tools) } : {}),
  }))
  return extensionDir
}

async function rejectsCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AgentActionsServiceError)
    assert.equal(error.code, code)
    return true
  })
}

test('Agent Skills v1 declaration and document grammar are exact, deterministic, and host-normalized', () => {
  assert.deepEqual(normalizeAgentSkillsDeclaration(skillsDeclaration()), {
    schema: 'modly.agent-skills.v1',
    file: SKILL_PATH,
  })

  for (const file of [
    '', '/skills/cad.md', 'C:/skills/cad.md', 'skills\\cad.md', './skills/cad.md',
    'skills/../cad.md', 'skills/%2e%2e/cad.md', 'skills//cad.md', 'skills/cad.txt',
    'skills/NUL.md', 'skills/cad.md?raw=1', 'skills/cad.md#fragment',
  ]) {
    assert.throws(() => normalizeAgentSkillsDeclaration(skillsDeclaration(file)), AgentSkillsManifestError, file)
  }
  for (const declaration of [
    { schema: 'modly.agent-skills.v2', file: SKILL_PATH },
    { schema: 'modly.agent-skills.v1', file: SKILL_PATH, hidden: true },
    Object.assign(Object.create(skillsDeclaration()), {}),
  ]) {
    assert.throws(() => normalizeAgentSkillsDeclaration(declaration), AgentSkillsManifestError)
  }

  const normalized = parseAgentSkillDocument(Buffer.from(skillDocument(), 'utf8'))
  assert.deepEqual(normalized, {
    schema: 'modly.agent-skill.v1',
    version: 1,
    name: 'modly-cad-planner-v1',
    summary: 'Plan deterministic CAD operations for an approved capability.',
    instructions: ['Interpret dimensions in millimetres.'],
    constraints: ['Return only declared artifacts.'],
    examples: ['Create a 40 mm cube with a centered 10 mm through-hole.'],
  })

  const reordered = skillDocument().replace(
    'name: modly-cad-planner-v1\nversion: 1',
    'version: 1\nname: modly-cad-planner-v1',
  )
  const invalidDocuments = [
    reordered,
    skillDocument().replace('version: 1', 'version: 1\nversion: 1'),
    skillDocument().replace('version: 1', 'version: 1\nlicense: MIT'),
    skillDocument().replace('## Constraints', '## Unknown'),
    skillDocument({ instruction: '<b>Generate</b> geometry.' }),
    skillDocument({ instruction: '`generate()` geometry.' }),
    skillDocument({ instruction: '[Read this](https://example.invalid).' }),
    skillDocument({ instruction: '![unsafe][reference]' }),
    skillDocument({ instruction: '~~~unsafe fence' }),
    skillDocument({ instruction: 'Use {{ unsafe }} content.' }),
    skillDocument({ instruction: ':::include hidden.md' }),
    skillDocument({ summary: 'Read HTTPS://example.invalid before planning geometry.' }),
    skillDocument({ summary: 'Contact MAILTO:operator@example.invalid before continuing.' }),
    skillDocument({ summary: 'Fetch FTP://example.invalid/shape before planning geometry.' }),
    skillDocument({ instruction: 'Decode data:text/plain,private before continuing.' }),
    skillDocument({ constraint: 'Never execute javascript:alert(1).' }),
    skillDocument({ examples: ['Connect through custom+mesh://example.invalid/session.'] }),
    skillDocument({ examples: ['Connect through wss:example.invalid/session.'] }),
    skillDocument({ instruction: 'Read h t t p s : / / example.invalid before continuing.' }),
    skillDocument({ constraint: 'Never open file：／／tmp／private-data.' }),
    skillDocument({ examples: ['Browse WWW．example.invalid for a worked example.'] }),
    skillDocument({ examples: ['Use h\u200bt\u200bt\u200bp://example.invalid as a reference.'] }),
    skillDocument({ examples: ['Use h\u{E0100}ttps://example.invalid as a reference.'] }),
    skillDocument({ constraint: 'Never execute data\u{E0100}:text/plain,private.' }),
    skillDocument({ name: 'cad-planner-v1' }),
    skillDocument().replace('- Interpret dimensions in millimetres.', 'Interpret dimensions in millimetres.'),
  ]
  for (const document of invalidDocuments) {
    assert.throws(() => parseAgentSkillDocument(Buffer.from(document, 'utf8')), AgentSkillsManifestError)
  }
  const invalidUtf8 = Buffer.concat([Buffer.from(skillDocument(), 'utf8'), Buffer.from([0xff])])
  assert.throws(() => parseAgentSkillDocument(invalidUtf8), AgentSkillsManifestError)

  const versionText = parseAgentSkillDocument(Buffer.from(skillDocument({
    summary: 'Note: support deterministic format version 1.2.3 without external references.',
  }), 'utf8'))
  assert.equal(versionText.summary, 'Note: support deterministic format version 1.2.3 without external references.')
})

test('Agent skill raw-file byte limit accepts exactly 8192 bytes and rejects 8193', () => {
  const document = skillDocument()
  const bytes = Buffer.byteLength(document, 'utf8')
  assert.ok(bytes < 8192)
  const exact = document.replace('\n## Instructions', `${'\n'.repeat(8192 - bytes + 1)}## Instructions`)
  assert.equal(Buffer.byteLength(exact, 'utf8'), 8192)
  assert.equal(parseAgentSkillDocument(Buffer.from(exact)).name, 'modly-cad-planner-v1')
  assert.throws(
    () => parseAgentSkillDocument(Buffer.from(`${exact}\n`)),
    /too large/i,
  )
})

test('Agent skill normalized JSON accepts exactly 6144 bytes and rejects 6145', () => {
  const summary = 'Plan deterministic CAD operations for an approved capability.'
  const instructions = [
    ...Array.from({ length: 11 }, (_, index) => `${String(index).padStart(2, '0')}-${'a'.repeat(497)}`),
    'z'.repeat(392),
  ]
  const document = [
    '---',
    'name: modly-cad-planner-v1',
    'version: 1',
    `summary: ${summary}`,
    '---',
    '',
    '## Instructions',
    ...instructions.map((instruction) => `- ${instruction}`),
    '',
    '## Constraints',
    '- Return only declared artifacts.',
    '',
  ].join('\n')
  assert.ok(Buffer.byteLength(document, 'utf8') <= 8192)
  const normalized = parseAgentSkillDocument(Buffer.from(document))
  assert.equal(Buffer.byteLength(canonicalJson(normalized), 'utf8'), 6144)
  assert.throws(
    () => parseAgentSkillDocument(Buffer.from(document.replace(summary, `${summary}x`))),
    /Normalized Agent skill is too large/,
  )
})

test('strict JSON scanner decodes escaped keys and enforces structural bounds before parsing', () => {
  const limits = { maxBytes: 256, maxDepth: 2, maxProperties: 3, maxArrayLength: 2 }
  assert.deepEqual(parseStrictJson('{"outer":{"file":"skills/a.md"},"items":[1,2]}', limits), {
    outer: { file: 'skills/a.md' },
    items: [1, 2],
  })
  assert.throws(
    () => parseStrictJson('{"outer":{"file":"a","fi\\u006ce":"b"}}', limits),
    StrictJsonError,
  )
  assert.throws(() => parseStrictJson('{"outer":{"nested":{"too":"deep"}}}', {
    ...limits,
    maxProperties: 4,
  }), /too deep/i)
  assert.throws(() => parseStrictJson('{"one":1,"two":2,"three":3,"four":4}', limits), /too many properties/i)
  assert.throws(() => parseStrictJson('[1,2,3]', limits), /array is too large/i)
})

test('Agent skill binding brackets identity, rejects symlinks and special files, and exposes no private material', async (t) => {
  if (process.platform === 'win32') t.skip('POSIX no-follow and special-file coverage')
  const root = await mkdtemp(join(tmpdir(), 'modly-agent-skills-files-'))
  const extensionDir = join(root, 'extension')
  const skillDir = join(extensionDir, 'skills')
  const path = join(skillDir, 'cad-planner.md')
  await mkdir(skillDir, { recursive: true })
  await writeFile(path, skillDocument())
  try {
    const first = await bindAgentSkillSet(extensionDir, normalizeAgentSkillsDeclaration(skillsDeclaration()))
    const second = await bindAgentSkillSet(extensionDir, normalizeAgentSkillsDeclaration(skillsDeclaration()))
    assert.equal(first.skillSetHash, second.skillSetHash)
    assert.deepEqual(first.publicSnapshot, {
      schema: 'modly.agent-skills.v1',
      version: 1,
      hash: first.skillSetHash,
      count: 1,
      items: [{ name: 'modly-cad-planner-v1', version: 1, hash: first.normalizedHash }],
    })
    const publicJson = JSON.stringify(first.publicSnapshot)
    for (const secret of [SKILL_PATH, extensionDir, 'millimetres', 'declared artifacts', 'summary', 'instructions', 'constraints']) {
      assert.equal(publicJson.includes(secret), false, secret)
    }

    const external = join(root, 'external.md')
    await writeFile(external, skillDocument())
    await rm(path)
    await symlink(external, path)
    await assert.rejects(bindAgentSkillSet(extensionDir, normalizeAgentSkillsDeclaration(skillsDeclaration())), /symlink|unsafe/i)

    await rm(path)
    await mkdir(path)
    await assert.rejects(bindAgentSkillSet(extensionDir, normalizeAgentSkillsDeclaration(skillsDeclaration())), /regular file|unsafe/i)

    await rm(path, { recursive: true })
    const fifo = spawnSync('mkfifo', [path])
    assert.equal(fifo.status, 0, fifo.stderr.toString())
    await assert.rejects(bindAgentSkillSet(extensionDir, normalizeAgentSkillsDeclaration(skillsDeclaration())), /regular file|unsafe/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Agent skill binding fails closed on in-place mutation and path replacement hooks', async (t) => {
  if (process.platform === 'win32') t.skip('POSIX identity replacement coverage')
  const root = await mkdtemp(join(tmpdir(), 'modly-agent-skills-races-'))
  const extensionDir = join(root, 'extension')
  const skillDir = join(extensionDir, 'skills')
  const path = join(skillDir, 'cad-planner.md')
  await mkdir(skillDir, { recursive: true })
  await writeFile(path, skillDocument())
  const declaration = normalizeAgentSkillsDeclaration(skillsDeclaration())
  try {
    await assert.rejects(bindAgentSkillSet(extensionDir, declaration, {
      hooks: {
        afterRead: async () => {
          await writeFile(path, skillDocument({ constraint: 'Return one declared artifact.' }))
        },
      },
    }), /changed|stale/i)

    await writeFile(path, skillDocument())
    await assert.rejects(bindAgentSkillSet(extensionDir, declaration, {
      hooks: {
        afterRead: async () => {
          const replacement = join(skillDir, 'replacement.md')
          await writeFile(replacement, skillDocument())
          await rename(replacement, path)
        },
      },
    }), /changed|stale/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('PROCESS and MCP capabilities bind declared skills while invalid skills remove only their Agent eligibility', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modly-agent-skills-discovery-'))
  const builtinDir = join(root, 'builtin')
  const userDir = join(root, 'user')
  await mkdir(builtinDir, { recursive: true })
  const processDir = await writeExtension({
    root: userDir,
    id: 'process-skills',
    nodes: [
      processNode('process-skills', 'valid', skillsDeclaration('skills/valid.md')),
      processNode('process-skills', 'invalid', skillsDeclaration('skills/invalid.md')),
      processNode('process-skills', 'legacy'),
    ],
    skills: {
      'valid.md': skillDocument({ name: 'modly-process-valid-v1' }),
      'invalid.md': skillDocument({ instruction: '<script>unsafe</script>' }),
    },
  })
  const mcpDir = await writeExtension({
    root: userDir,
    id: 'mcp-skills',
    tools: [
      mcpTool('mcp-skills', 'valid', skillsDeclaration('skills/valid.md')),
      mcpTool('mcp-skills', 'invalid', skillsDeclaration('skills/invalid.md')),
      mcpTool('mcp-skills', 'legacy'),
    ],
    skills: {
      'valid.md': skillDocument({ name: 'modly-mcp-valid-v1' }),
      'invalid.md': skillDocument({ instruction: '[unsafe](https://example.invalid)' }),
    },
  })
  try {
    const ordinary = await listVisibleExtensions({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
    assert.deepEqual(ordinary.map((extension) => extension.id).sort(), ['mcp-skills', 'process-skills'])
    const discoveredMcp = await discoverGovernedMcpTools({ builtinDir, userExtensionsDir: userDir })
    assert.equal(discoveredMcp.tools.length, 3)

    const inventory = await listAgentCapabilities({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
    assert.deepEqual(inventory.capabilities.map((capability) => capability.id), [
      'mcp-skills/legacy',
      'mcp-skills/valid',
      'process-skills/legacy',
      'process-skills/valid',
    ])
    const processCapability = inventory.capabilities.find((capability) => capability.id === 'process-skills/valid')
    const mcpCapability = inventory.capabilities.find((capability) => capability.id === 'mcp-skills/valid')
    assert.equal(processCapability?.skills?.items[0]?.name, 'modly-process-valid-v1')
    assert.equal(mcpCapability?.skills?.items[0]?.name, 'modly-mcp-valid-v1')
    assert.equal(inventory.capabilities.find((capability) => capability.id === 'process-skills/legacy')?.skills, undefined)
    assert.equal(inventory.capabilities.find((capability) => capability.id === 'mcp-skills/legacy')?.skills, undefined)
    assert.ok(inventory.errors.filter((error) => error.code === 'AGENT_SKILL_INVALID').length >= 2)

    const publicJson = JSON.stringify(inventory.capabilities)
    for (const secret of [processDir, mcpDir, 'skills/valid.md', 'millimetres', 'declared artifacts']) {
      assert.equal(publicJson.includes(secret), false, secret)
    }
    assertAgentCapabilitySnapshotV1(processCapability)
    assert.throws(() => assertAgentCapabilitySnapshotV1({
      ...processCapability,
      skills: { ...processCapability?.skills, file: 'skills/valid.md' },
    }), /unknown field/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('malformed PROCESS skill declarations preserve normal runtime nodes and report exact Agent errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modly-agent-skills-invalid-declarations-'))
  const builtinDir = join(root, 'builtin')
  const userDir = join(root, 'user')
  await mkdir(builtinDir, { recursive: true })
  const declarations = [
    ['bad-path', { schema: 'modly.agent-skills.v1', file: 'skills/../private.md' }],
    ['bad-schema', { schema: 'modly.agent-skills.v2', file: 'skills/private.md' }],
    ['bad-extension', { schema: 'modly.agent-skills.v1', file: 'skills/private.txt' }],
  ] as const
  for (const [id, declaration] of declarations) {
    await writeExtension({
      root: userDir,
      id,
      nodes: [processNode(id, 'run', declaration)],
    })
  }
  try {
    const ordinary = await listVisibleExtensions({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
    assert.deepEqual(ordinary.map((extension) => extension.id).sort(), declarations.map(([id]) => id).sort())
    for (const [id] of declarations) {
      const extension = ordinary.find((candidate) => candidate.id === id)
      assert.equal(extension?.type, 'process')
      if (!extension || extension.type !== 'process') assert.fail(`${id} PROCESS extension was degraded`)
      assert.equal(extension.entry, 'processor.js')
      assert.deepEqual(extension.nodes.map((node) => node.id), ['run'])
      assert.deepEqual(extension.nodes.map((node) => [node.input, node.output]), [['text', 'text']])
      assert.equal(extension.nodes[0]?.agent, undefined)
      assert.deepEqual(extension.nodes[0]?.agentError, { code: 'AGENT_SKILL_INVALID' })
    }

    const inventory = await listAgentCapabilities({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
    assert.deepEqual(inventory.capabilities, [])
    assert.deepEqual(
      inventory.errors.filter((error) => error.code === 'AGENT_SKILL_INVALID')
        .map((error) => error.capabilityId)
        .sort(),
      declarations.map(([id]) => `${id}/run`).sort(),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('PROCESS and MCP discovery reject duplicate manifest keys, including escaped nested skill fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modly-agent-skills-duplicate-json-'))
  const builtinDir = join(root, 'builtin')
  const userDir = join(root, 'user')
  await mkdir(builtinDir, { recursive: true })
  const processDir = await writeExtension({
    root: userDir,
    id: 'duplicate-process-skill',
    nodes: [
      processNode('duplicate-process-skill', 'run', skillsDeclaration('skills/valid.md')),
      {
        id: 'ordinary',
        name: 'Ordinary process node',
        input: 'mesh',
        output: 'mesh',
        params_schema: [],
      },
    ],
    skills: { 'valid.md': skillDocument({ name: 'modly-duplicate-process-v1' }) },
  })
  const mcpDir = await writeExtension({
    root: userDir,
    id: 'duplicate-mcp-skill',
    tools: [mcpTool('duplicate-mcp-skill', 'run', skillsDeclaration('skills/valid.md'))],
    skills: { 'valid.md': skillDocument({ name: 'modly-duplicate-mcp-v1' }) },
  })
  try {
    const processPath = join(processDir, 'manifest.json')
    const processRaw = await readFile(processPath, 'utf8')
    const processNeedle = '"file":"skills/valid.md"'
    assert.ok(processRaw.includes(processNeedle))
    await writeFile(processPath, processRaw.replace(
      processNeedle,
      '"file":"skills/valid.md","file":"skills/alternate.md"',
    ))

    const mcpPath = join(mcpDir, 'manifest.json')
    const mcpRaw = await readFile(mcpPath, 'utf8')
    assert.ok(mcpRaw.includes(processNeedle))
    await writeFile(mcpPath, mcpRaw.replace(
      processNeedle,
      '"file":"skills/valid.md","fi\\u006ce":"skills/alternate.md"',
    ))

    const ordinary = await listVisibleExtensions({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
    assert.deepEqual(ordinary.map((extension) => extension.id).sort(), [
      'duplicate-mcp-skill',
      'duplicate-process-skill',
    ])
    const ordinaryProcess = ordinary.find((extension) => extension.id === 'duplicate-process-skill')
    assert.equal(ordinaryProcess?.type, 'process')
    assert.equal(ordinaryProcess?.id, 'duplicate-process-skill')
    assert.equal(ordinaryProcess?.name, 'duplicate-process-skill')
    assert.equal(ordinaryProcess?.version, '1.0.0')
    if (!ordinaryProcess || ordinaryProcess.type !== 'process') assert.fail('PROCESS extension identity was degraded')
    assert.equal(ordinaryProcess.entry, 'processor.js')
    assert.deepEqual(ordinaryProcess.nodes.map((node) => node.id), ['run', 'ordinary'])
    assert.deepEqual(ordinaryProcess.nodes.map((node) => [node.input, node.output]), [
      ['text', 'text'],
      ['mesh', 'mesh'],
    ])
    const ordinaryTarget = await resolveCanonicalProcessTarget({
      processId: 'duplicate-process-skill/ordinary',
      builtinDir,
      userExtensionsDir: userDir,
      trustedRepos: new Set(),
    })
    assert.equal(ordinaryTarget.extension.type, 'process')
    assert.equal(ordinaryTarget.extension.id, 'duplicate-process-skill')
    assert.equal(ordinaryTarget.entry, 'processor.js')
    assert.equal(ordinaryTarget.node.id, 'ordinary')
    assert.deepEqual(ordinaryTarget.extension.nodes.map((node) => node.id), ['run', 'ordinary'])
    assert.deepEqual(ordinaryTarget.manifest.nodes?.map((node) => node.id), ['run', 'ordinary'])
    const ordinaryMcp = ordinary.find((extension) => extension.id === 'duplicate-mcp-skill')
    assert.equal(ordinaryMcp?.type, 'process')
    assert.equal(ordinaryMcp?.id, 'duplicate-mcp-skill')
    assert.equal(ordinaryMcp?.name, 'duplicate-mcp-skill')
    assert.equal(ordinaryMcp?.version, '1.0.0')
    if (!ordinaryMcp || ordinaryMcp.type !== 'process') assert.fail('MCP host extension identity was degraded')
    assert.equal(ordinaryMcp.entry, 'processor.js')
    assert.deepEqual(ordinaryMcp.nodes, [])

    const mcp = await discoverGovernedMcpTools({ builtinDir, userExtensionsDir: userDir })
    assert.deepEqual(mcp.tools, [])
    assert.equal(mcp.errors.some((error) => error.code === 'MCP_MANIFEST_INVALID'), true)

    const inventory = await listAgentCapabilities({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
    assert.deepEqual(inventory.capabilities, [])
    assert.equal(inventory.errors.some((error) => error.code === 'AGENT_MANIFEST_INVALID'), true)
    assert.equal(inventory.errors.some((error) => error.code === 'MCP_MANIFEST_INVALID'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('extension cap allows four unique skill files and reuse but rejects five across PROCESS and MCP only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modly-agent-skills-cap-'))
  const builtinDir = join(root, 'builtin')
  const userDir = join(root, 'user')
  await mkdir(builtinDir, { recursive: true })
  const extensionId = 'hybrid-skills'
  const uniquePaths = Array.from({ length: 5 }, (_, index) => `skills/skill-${index + 1}.md`)
  const nodes = [0, 1, 2].map((index) => processNode(extensionId, `process-${index + 1}`, skillsDeclaration(uniquePaths[index])))
  const tools = [3, 4].map((index) => mcpTool(extensionId, `mcp-${index + 1}`, skillsDeclaration(uniquePaths[index])))
  nodes.push(processNode(extensionId, 'legacy'))
  const extensionDir = await writeExtension({
    root: userDir,
    id: extensionId,
    nodes,
    tools,
    skills: Object.fromEntries(uniquePaths.map((path, index) => [
      path.split('/').at(-1) as string,
      skillDocument({ name: `modly-hybrid-skill-${index + 1}-v1` }),
    ])),
  })
  try {
    const overflow = await listAgentCapabilities({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
    assert.deepEqual(overflow.capabilities.map((capability) => capability.id), ['hybrid-skills/legacy'])
    assert.equal(overflow.errors.filter((error) => error.code === 'AGENT_SKILLS_FILE_LIMIT_EXCEEDED').length, 5)
    assert.equal((await listVisibleExtensions({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })).length, 1)

    const fourFileManifest = {
      id: extensionId,
      name: extensionId,
      version: '1.0.0',
      type: 'process',
      entry: 'processor.js',
      nodes: [0, 1, 2].map((index) => processNode(extensionId, `process-${index + 1}`, skillsDeclaration(uniquePaths[index]))).concat([
        processNode(extensionId, 'legacy'),
      ]),
      mcp: mcpDeclaration(extensionId, [
        mcpTool(extensionId, 'mcp-1', skillsDeclaration(uniquePaths[3])),
        mcpTool(extensionId, 'mcp-2', skillsDeclaration(uniquePaths[3])),
      ]),
    }
    await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify(fourFileManifest))
    const bounded = await listAgentCapabilities({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
    assert.equal(bounded.capabilities.length, 6)
    assert.equal(bounded.errors.some((error) => error.code === 'AGENT_SKILLS_FILE_LIMIT_EXCEEDED'), false)

    const manifest = {
      id: extensionId,
      name: extensionId,
      version: '1.0.0',
      type: 'process',
      entry: 'processor.js',
      nodes: [0, 1, 2].map((index) => processNode(extensionId, `process-${index + 1}`, skillsDeclaration(uniquePaths[0]))).concat([
        processNode(extensionId, 'legacy'),
      ]),
      mcp: mcpDeclaration(extensionId, [3, 4].map((index) => mcpTool(extensionId, `mcp-${index - 2}`, skillsDeclaration(uniquePaths[0])))),
    }
    await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify(manifest))
    const reused = await listAgentCapabilities({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
    assert.equal(reused.capabilities.length, 6)
    assert.equal(reused.errors.some((error) => error.code === 'AGENT_SKILLS_FILE_LIMIT_EXCEEDED'), false)
    assert.equal(new Set(reused.capabilities.flatMap((capability) => capability.skills?.hash ?? [])).size, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('skill edits change capability hashes and make proposals and approval stale without changing legacy capability shape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modly-agent-skills-stale-'))
  const builtinDir = join(root, 'builtin')
  const userDir = join(root, 'user')
  await mkdir(builtinDir, { recursive: true })
  const extensionDir = await writeExtension({
    root: userDir,
    id: 'stale-skills',
    nodes: [
      processNode('stale-skills', 'skilled', skillsDeclaration('skills/skilled.md')),
      processNode('stale-skills', 'legacy'),
    ],
    skills: { 'skilled.md': skillDocument({ name: 'modly-stale-skill-v1' }) },
  })
  const selectedModel = {
    provider: 'ollama' as const,
    endpoint: 'http://127.0.0.1:11434',
    model: 'qwen3.6:latest',
    digest: `sha256:${'a'.repeat(64)}`,
  }
  try {
    const first = await listAgentCapabilities({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
    const firstSkilled = first.capabilities.find((capability) => capability.id === 'stale-skills/skilled')
    const firstLegacy = first.capabilities.find((capability) => capability.id === 'stale-skills/legacy')
    assert.ok(firstSkilled)
    assert.ok(firstLegacy)
    assert.equal('skills' in firstLegacy, false)

    let currentCapabilities: AgentCapabilitySnapshotV1[] = first.capabilities
    let nextActionId = 0
    const service = new AgentActionsService({
      createActionId: () => `skill-stale-action-${nextActionId += 1}`,
      resolveCapabilities: async () => ({ capabilities: currentCapabilities, errors: [] }),
      resolveCurrentModel: async () => selectedModel,
      artifactVerifier: { async verify(candidate) { return candidate } },
      executor: async () => ({ artifacts: [] }),
    })
    const proposal = await service.propose({
      originSessionId: 'skill-session',
      capabilityId: firstSkilled.id,
      capabilityHash: firstSkilled.hash,
      arguments: { input: 'cube', params: {} },
      model: selectedModel,
    })

    await writeFile(join(extensionDir, 'skills', 'skilled.md'), skillDocument({
      name: 'modly-stale-skill-v1',
      instruction: 'Interpret dimensions in centimetres.',
    }))
    const second = await listAgentCapabilities({ builtinDir, userExtensionsDir: userDir, trustedRepos: new Set() })
    const secondSkilled = second.capabilities.find((capability) => capability.id === 'stale-skills/skilled')
    const secondLegacy = second.capabilities.find((capability) => capability.id === 'stale-skills/legacy')
    assert.ok(secondSkilled)
    assert.notEqual(secondSkilled.hash, firstSkilled.hash)
    assert.notEqual(secondSkilled.skills?.hash, firstSkilled.skills?.hash)
    assert.deepEqual(secondLegacy, firstLegacy)
    currentCapabilities = second.capabilities

    await rejectsCode(service.propose({
      originSessionId: 'skill-session',
      capabilityId: firstSkilled.id,
      capabilityHash: firstSkilled.hash,
      arguments: { input: 'cube', params: {} },
      model: selectedModel,
    }), 'capability_stale')
    await rejectsCode(service.decide({
      actionId: proposal.id,
      originSessionId: 'skill-session',
      decision: 'approve',
    }), 'capability_stale')
    assert.equal((await service.get({ actionId: proposal.id, originSessionId: 'skill-session' })).status, 'cancelled')

    const approved = await service.propose({
      originSessionId: 'skill-session',
      capabilityId: secondSkilled.id,
      capabilityHash: secondSkilled.hash,
      arguments: { input: 'cube', params: {} },
      model: selectedModel,
    })
    await service.decide({ actionId: approved.id, originSessionId: 'skill-session', decision: 'approve' })
    await writeFile(join(extensionDir, 'skills', 'skilled.md'), skillDocument({
      name: 'modly-stale-skill-v1',
      instruction: 'Interpret dimensions in metres.',
    }))
    currentCapabilities = (await listAgentCapabilities({
      builtinDir,
      userExtensionsDir: userDir,
      trustedRepos: new Set(),
    })).capabilities
    await rejectsCode(service.execute({
      actionId: approved.id,
      originSessionId: 'skill-session',
    }), 'capability_stale')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

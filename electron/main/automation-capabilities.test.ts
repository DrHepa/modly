import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { tmpdir } from 'node:os'

const {
  getUiOnlyNodes,
  parseExtensionManifest,
  readExtensionsFromDir,
  readExtensionsFromDirDetailed,
  readResolvedExtensionsFromDirDetailed,
} = await import(new URL('./automation-capabilities.ts', import.meta.url).href)

type UiOnlyNodeForTest = {
  id: string
}

type ExtensionForTest = {
  id: string
}

type ExtensionDiscoveryErrorForTest = {
  context?: { extension_id?: string }
  message: string
}

type ResolvedExtensionForTest = {
  extension: ExtensionForTest
}

test('parseExtensionManifest preserves legacy process nodes with default non-interactive automation metadata', () => {
  const extension = parseExtensionManifest(
    {
      id: 'legacy-processes',
      type: 'process',
      entry: 'processor.js',
      nodes: [{ id: 'optimize', name: 'Optimize', input: 'mesh', output: 'mesh' }],
    },
    'legacy-processes',
    new Set(),
    false,
  )

  assert.equal(extension.type, 'process')
  assert.deepEqual(extension.nodes[0].automation, {
    boundary: 'electron',
    headless: true,
    pause: { supported: false },
    substitution: { supported: false },
  })
})

test('parseExtensionManifest uses input_contract metadata for legacy string inputs', () => {
  const extension = parseExtensionManifest(
    {
      id: 'kimodo-soma-rp',
      type: 'model',
      nodes: [{
        id: 'animate-rigged-mesh',
        name: 'Animate Rigged Mesh',
        input: 'text',
        output: 'mesh',
        inputs: ['text', 'mesh'],
        input_contract: [
          { name: 'prompt', label: 'Prompt', type: 'text', required: true },
          { name: 'rigged_mesh', label: 'Rigged Mesh', type: 'mesh', required: true },
        ],
      }],
    },
    'kimodo-soma-rp',
    new Set(),
    false,
  )

  assert.deepEqual(extension.nodes[0].inputs, [
    { name: 'prompt', label: 'Prompt', type: 'text', required: true },
    { name: 'rigged_mesh', label: 'Rigged Mesh', type: 'mesh', required: true },
  ])
})

test('parseExtensionManifest falls back to stable typed ports for legacy string inputs without input_contract', () => {
  const extension = parseExtensionManifest(
    {
      id: 'legacy-multi-inputs',
      type: 'model',
      nodes: [{
        id: 'compose',
        name: 'Compose',
        input: 'text',
        output: 'mesh',
        inputs: ['text', 'mesh'],
      }],
    },
    'legacy-multi-inputs',
    new Set(),
    false,
  )

  assert.deepEqual(extension.nodes[0].inputs, [
    { name: 'text', type: 'text', required: true },
    { name: 'mesh', type: 'mesh', required: true },
  ])
})

test('parseExtensionManifest normalizes duplicate legacy fallback names without losing positional slots', () => {
  const extension = parseExtensionManifest(
    {
      id: 'legacy-positional-images',
      type: 'model',
      nodes: [{
        id: 'compose',
        input: 'image',
        output: 'mesh',
        inputs: ['image', 'image', 'mesh', 'image'],
      }],
    },
    'legacy-positional-images',
    new Set(),
    false,
  )

  assert.deepEqual(extension.nodes[0].inputs, [
    { name: 'image', type: 'image', required: true },
    { name: 'image_2', type: 'image', required: true },
    { name: 'mesh', type: 'mesh', required: true },
    { name: 'image_3', type: 'image', required: true },
  ])
})

test('parseExtensionManifest keeps explicit names strict while avoiding explicit-name collisions for legacy fallbacks', () => {
  const extension = parseExtensionManifest(
    {
      id: 'mixed-positional-images',
      type: 'model',
      nodes: [{
        id: 'compose',
        input: 'image',
        output: 'mesh',
        inputs: [
          'image',
          { name: 'image', type: 'image' } as never,
          'image',
        ],
      }],
    },
    'mixed-positional-images',
    new Set(),
    false,
  )

  assert.deepEqual(extension.nodes[0].inputs, [
    { name: 'image_2', type: 'image', required: true },
    { name: 'image', type: 'image', required: true },
    { name: 'image_3', type: 'image', required: true },
  ])

  assert.throws(
    () => parseExtensionManifest(
      {
        id: 'duplicate-explicit-ports',
        type: 'model',
        nodes: [{
          id: 'compose',
          input: 'image',
          output: 'mesh',
          inputs: [
            { name: 'front', type: 'image' },
            { name: 'front', type: 'image' },
          ],
        }],
      },
      'duplicate-explicit-ports',
      new Set(),
      false,
    ),
    /duplicate port name "front"/i,
  )

  assert.deepEqual(
    parseExtensionManifest(
      {
        id: 'trimmed-explicit-ports',
        type: 'model',
        nodes: [{
          id: 'compose',
          input: 'image',
          output: 'mesh',
          inputs: [{ name: ' front ', type: 'image' }],
        }],
      },
      'trimmed-explicit-ports',
      new Set(),
      false,
    ).nodes[0].inputs,
    [{ name: 'front', type: 'image', required: true }],
  )

  assert.throws(
    () => parseExtensionManifest(
      {
        id: 'trimmed-duplicate-explicit-ports',
        type: 'model',
        nodes: [{
          id: 'compose',
          input: 'image',
          output: 'mesh',
          inputs: [
            { name: 'front', type: 'image' },
            { name: ' front ', type: 'image' },
          ],
        }],
      },
      'trimmed-duplicate-explicit-ports',
      new Set(),
      false,
    ),
    /duplicate port name "front"/i,
  )

  assert.throws(
    () => parseExtensionManifest(
      {
        id: 'missing-explicit-port-name',
        type: 'model',
        nodes: [{
          id: 'compose',
          input: 'image',
          output: 'mesh',
          inputs: [{ type: 'image' } as never],
        }],
      },
      'missing-explicit-port-name',
      new Set(),
      false,
    ),
    /name must be a non-empty string/i,
  )
})

test('parseExtensionManifest rejects duplicate or malformed input_contract names instead of silently rerouting them', () => {
  const parse = (inputContract: unknown) => parseExtensionManifest(
    {
      id: 'invalid-input-contract',
      type: 'model',
      nodes: [{
        id: 'compose',
        input: 'image',
        output: 'mesh',
        inputs: ['image', 'image'],
        input_contract: inputContract as never,
      }],
    },
    'invalid-input-contract',
    new Set(),
    false,
  )

  assert.throws(() => parse([{ name: 'content' }, { name: 'content' }]), /duplicate port name "content"/i)
  assert.throws(() => parse([{ name: ' ' }, {}]), /input_contract\[0\]\.name/i)
})

test('parseExtensionManifest rejects malformed explicit object port label and required metadata', () => {
  const parse = (port: unknown) => parseExtensionManifest(
    {
      id: 'invalid-explicit-port-metadata',
      type: 'model',
      nodes: [{
        id: 'compose',
        input: 'image',
        output: 'mesh',
        inputs: [port as never],
      }],
    },
    'invalid-explicit-port-metadata',
    new Set(),
    false,
  )

  assert.throws(() => parse({ name: 'front', type: 'image', label: 42 }), /inputs\[0\]\.label must be a string/i)
  assert.throws(() => parse({ name: 'front', type: 'image', required: 'yes' }), /inputs\[0\]\.required must be a boolean/i)
  assert.deepEqual(parse({ name: 'front', type: 'image', label: 'Front', required: false }).nodes[0].inputs, [
    { name: 'front', label: 'Front', type: 'image', required: false },
  ])
})


test('parseExtensionManifest ignores obsolete model metadata and outputs', () => {
  const legacy = parseExtensionManifest(
    {
      id: 'legacy-image-model',
      type: 'model',
      [obsoleteManifestIoKey]: 'obsolete-contract',
      nodes: [{
        id: 'legacy-four-view',
        input: 'image',
        output: 'image',
        inputs: [
          { name: 'front', type: 'image', required: true },
          { name: 'left', type: 'image', required: false },
          { name: 'back', type: 'image', required: false },
          { name: 'right', type: 'image', required: false },
        ],
        outputs: [{ name: 'provisional_named_output', type: 'image' }],
      }],
    },
    'legacy-image-model',
    new Set(),
    false,
  )

  assert.equal(legacy.nodes[0].input, 'image')
  assert.equal(legacy.nodes[0].output, 'image')
  assert.deepEqual(legacy.nodes[0].inputs, [
    { name: 'front', type: 'image', required: true },
    { name: 'left', type: 'image', required: false },
    { name: 'back', type: 'image', required: false },
    { name: 'right', type: 'image', required: false },
  ])
  assert.equal(('io' + 'Contract') in legacy.nodes[0], false)
  assert.equal('outputs' in legacy.nodes[0], false)
})

test('parseExtensionManifest preserves process named inputs while ignoring obsolete model metadata variants', () => {
  const parse = (node: Record<string, unknown>, obsoleteContract = 'obsolete-contract') => parseExtensionManifest(
    {
      id: 'invalid-named-model',
      type: 'model',
      nodes: [{ id: 'depth', input: 'image', output: 'image', [obsoleteManifestIoKey]: obsoleteContract, ...node }],
    },
    'invalid-named-model',
    new Set(),
    false,
  )

  assert.deepEqual(parse({ inputs: [{ name: 'front', type: 'image' }] }).nodes[0].inputs, [
    { name: 'front', type: 'image', required: true },
  ])
  assert.deepEqual(parse({ inputs: [{ name: 'front', type: 'image' }] }, 'positional-v2').nodes[0].inputs, [
    { name: 'front', type: 'image', required: true },
  ])
})

test('parseExtensionManifest ignores obsolete process metadata and drops obsolete process outputs[]', () => {
  const withContract = parseExtensionManifest({
    id: 'bad-process-contract', type: 'process', [obsoleteManifestIoKey]: 'obsolete-contract', entry: 'processor.js',
    nodes: [{ id: 'run', input: 'image', output: 'image' }],
  }, 'bad-process-contract', new Set(), false)

  assert.equal(withContract.type, 'process')

  const extension = parseExtensionManifest({
    id: 'bad-process-outputs', type: 'process', entry: 'processor.js',
    nodes: [{ id: 'run', input: 'image', output: 'image', outputs: [{ name: 'preview', type: 'image' }] }],
  }, 'bad-process-outputs', new Set(), false)

  assert.equal(extension.type, 'process')
  assert.equal('outputs' in extension.nodes[0], false)
})

test('parseExtensionManifest accepts declarative interactive checkpoint and substitution metadata without making it headless', () => {
  const extension = parseExtensionManifest(
    {
      id: 'review-tools',
      type: 'process',
      entry: 'processor.js',
      nodes: [{
        id: 'review-mesh',
        name: 'Review Mesh',
        input: 'mesh',
        output: 'mesh',
        automation: {
          pause: { supported: true, checkpoint: 'interactive' },
          substitution: { supported: true, artifactKinds: ['mesh'], boundary: 'ui_only' },
        },
      }],
    },
    'review-tools',
    new Set(),
    false,
  )

  assert.equal(extension.type, 'process')
  assert.deepEqual(extension.nodes[0].automation, {
    boundary: 'electron',
    headless: true,
    pause: { supported: true, checkpoint: 'interactive' },
    substitution: { supported: true, artifactKinds: ['mesh'], boundary: 'ui_only', headless: false },
  })
})

test('parseExtensionManifest accepts scene process ports and scene substitution metadata', () => {
  const extension = parseExtensionManifest(
    {
      id: 'world-tools',
      type: 'process',
      entry: 'processor.js',
      nodes: [{
        id: 'stereo',
        name: 'World Stereo',
        input: 'scene',
        output: 'scene',
        inputs: ['scene'],
        input_contract: [{ name: 'world_scene', label: 'World scene', type: 'scene', required: true }],
        automation: {
          substitution: { supported: true, artifactKinds: ['scene'], boundary: 'ui_only' },
        },
      }],
    },
    'world-tools',
    new Set(),
    false,
  )

  assert.equal(extension.type, 'process')
  assert.equal(extension.nodes[0].input, 'scene')
  assert.equal(extension.nodes[0].output, 'scene')
  assert.deepEqual(extension.nodes[0].inputs, [
    { name: 'world_scene', label: 'World scene', type: 'scene', required: true },
  ])
  assert.deepEqual(extension.nodes[0].automation?.substitution, {
    supported: true,
    artifactKinds: ['scene'],
    boundary: 'ui_only',
    headless: false,
  })
})

test('parseExtensionManifest accepts audio process ports and audio substitution metadata', () => {
  const extension = parseExtensionManifest(
    {
      id: 'audio-tools',
      type: 'process',
      entry: 'processor.js',
      nodes: [{
        id: 'normalize-audio',
        name: 'Normalize Audio',
        input: 'audio',
        output: 'audio',
        inputs: ['audio'],
        input_contract: [{ name: 'track', label: 'Track', type: 'audio', required: true }],
        automation: {
          substitution: { supported: true, artifactKinds: ['audio'], boundary: 'ui_only' },
        },
      }],
    },
    'audio-tools',
    new Set(),
    false,
  )

  assert.equal(extension.type, 'process')
  assert.equal(extension.nodes[0].input, 'audio')
  assert.equal(extension.nodes[0].output, 'audio')
  assert.deepEqual(extension.nodes[0].inputs, [
    { name: 'track', label: 'Track', type: 'audio', required: true },
  ])
  assert.deepEqual(extension.nodes[0].automation?.substitution, {
    supported: true,
    artifactKinds: ['audio'],
    boundary: 'ui_only',
    headless: false,
  })
})

test('parseExtensionManifest accepts video process ports and video substitution metadata', () => {
  const extension = parseExtensionManifest(
    {
      id: 'video-tools',
      type: 'process',
      entry: 'processor.js',
      nodes: [{
        id: 'trim-video',
        name: 'Trim Video',
        input: 'video',
        output: 'video',
        inputs: ['video'],
        input_contract: [{ name: 'clip', label: 'Clip', type: 'video', required: true }],
        automation: {
          substitution: { supported: true, artifactKinds: ['video'], boundary: 'ui_only' },
        },
      }],
    },
    'video-tools',
    new Set(),
    false,
  )

  assert.equal(extension.type, 'process')
  assert.equal(extension.nodes[0].input, 'video')
  assert.equal(extension.nodes[0].output, 'video')
  assert.deepEqual(extension.nodes[0].inputs, [
    { name: 'clip', label: 'Clip', type: 'video', required: true },
  ])
  assert.deepEqual(extension.nodes[0].automation?.substitution, {
    supported: true,
    artifactKinds: ['video'],
    boundary: 'ui_only',
    headless: false,
  })
})

test('getUiOnlyNodes declares artifact editing as UI-only and unavailable headlessly', () => {
  const artifactCapability = (getUiOnlyNodes() as UiOnlyNodeForTest[]).find((node) => node.id === 'artifact-substitution')

  assert.deepEqual(artifactCapability, {
    kind: 'ui_only',
    source: 'ui-only',
    id: 'artifact-substitution',
    type: 'artifactSubstitution',
    label: 'Artifact substitution',
    reason: 'Pause/edit/continue is declarative only in automation; artifact editing and replacement remain Electron/UI-owned and are not executable headlessly.',
    automation: {
      boundary: 'ui_only',
      headless: false,
      pause: { supported: true, checkpoint: 'interactive' },
      substitution: { supported: true, artifactKinds: ['image', 'text', 'mesh', 'scene', 'capture', 'audio', 'video'], boundary: 'ui_only', headless: false },
    },
  })
})

test('parseExtensionManifest rejects unsafe ownership identifiers while preserving legitimate ids', () => {
  const parse = (id: string, nodeId: string, ownerId?: string) => parseExtensionManifest(
    {
      id,
      type: 'model',
      nodes: [{
        id: nodeId,
        input: 'text',
        output: 'mesh',
        ...(ownerId === undefined ? {} : { weight_owner_id: ownerId }),
      }],
    },
    'safe-extension',
    new Set(),
    false,
  )

  const valid = parse('image_model.v2', 'Generate_V2', 'shared-weights.v1')
  assert.equal(valid.id, 'image_model.v2')
  assert.equal(valid.nodes[0].capabilityId, 'image_model.v2/Generate_V2')
  assert.equal(valid.nodes[0].weightOwnerId, 'image_model.v2/shared-weights.v1')

  for (const [id, nodeId, ownerId] of [
    ['../escape', 'generate', undefined],
    ['safe-extension', '..', undefined],
    ['safe-extension', 'nested/node', undefined],
    ['safe-extension', 'generate', '../outside'],
    ['safe-extension', 'generate', '..\\outside'],
    ['safe-extension', 'generate', 'bad\u0000owner'],
  ] as Array<[string, string, string | undefined]>) {
    assert.throws(
      () => parse(id, nodeId, ownerId),
      /invalid|absolute path|path separators|control characters|must match/i,
    )
  }
})

test('parseExtensionManifest rejects structured HTTPS plans on shared weight owners', () => {
  assert.throws(
    () => parseExtensionManifest(
      {
        id: 'gaussiangpt',
        type: 'model',
        nodes: [
          {
            id: 'vfront',
            input: 'none',
            output: 'mesh',
            weight_owner_id: 'shared-weights',
            https_downloads: [{
              url: 'https://assets.example/vfront.bin',
              filename: 'vfront.bin',
              size_bytes: 5,
              sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            }],
          },
          {
            id: 'both',
            input: 'none',
            output: 'mesh',
            weight_owner_id: 'shared-weights',
          },
        ],
      },
      'gaussiangpt',
      new Set(),
      false,
    ),
    /https_downloads requires a dedicated weight owner/i,
  )
})

test('parseExtensionManifest rejects unknown input metadata values', () => {
  assert.throws(
    () => parseExtensionManifest(
      {
        id: 'broken-model',
        type: 'model',
        nodes: [{ id: 'generate', input: 'invalid-input' as never, output: 'mesh' }],
      },
      'broken-model',
      new Set(),
      false,
    ),
    /must be one of: image, text, mesh, scene, capture, audio, video, none/i,
  )
})

test('ordinary PROCESS discovery keeps governed-only artifact kinds out of legacy workflow ports', () => {
  for (const kind of ['plan', 'source', 'step', 'glb', 'blend'] as const) {
    assert.throws(
      () => parseExtensionManifest(
        {
          id: `governed-${kind}`,
          type: 'process',
          entry: 'processor.js',
          nodes: [{ id: 'run', input: kind, output: kind }],
        },
        `governed-${kind}`,
        new Set(),
        false,
      ),
      /must be one of: image, text, mesh, scene, capture, audio, video, none/i,
    )
  }

  const legacy = parseExtensionManifest({
    id: 'governed-output', type: 'process', entry: 'processor.js',
    nodes: [{
      id: 'run', input: 'text', output: 'glb',
      automation: { substitution: { supported: true, artifactKinds: ['glb', 'mesh'] } },
    }],
  }, 'governed-output', new Set(), false)
  assert.equal(legacy.nodes[0].output, 'mesh')
  assert.deepEqual(legacy.nodes[0].automation?.substitution.artifactKinds, ['mesh'])
})

test('parseExtensionManifest accepts the installed-shaped Pixal3D five-node capture and scene contract', () => {
  const source = (repo: string, file: string) => ({
    id: file.replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
    provider: 'huggingface',
    repo_id: repo,
    destination: '.',
    checks: [file],
  })
  const extension = parseExtensionManifest({
    id: 'pixal3d',
    version: '0.5.0',
    type: 'model',
    weight_groups: [
      { id: 'pixal3d-base', model_sources: [source('vendor/base', 'base.bin')] },
      { id: 'pixal3d-mv', model_sources: [source('vendor/mv', 'mv.bin')] },
      { id: 'worldsculpt-adapters', model_sources: [source('vendor/ws', 'ws.bin')] },
      { id: 'sam3', model_sources: [source('vendor/sam3', 'sam3.bin')] },
      { id: 'da3-base', model_sources: [source('vendor/da3', 'da3.bin')] },
    ],
    nodes: [
      { id: 'generate', input: 'image', output: 'mesh', weight_groups: ['pixal3d-base'] },
      { id: 'generate-mv', input: 'capture', output: 'mesh', weight_groups: ['pixal3d-base', 'pixal3d-mv'] },
      { id: 'worldsculpt', input: 'scene', output: 'mesh', weight_groups: ['pixal3d-base', 'worldsculpt-adapters'] },
      { id: 'scene-from-estimates', input: 'capture', output: 'scene', weight_groups: ['sam3', 'da3-base'] },
      { id: 'normalize-annotated-scene', input: 'scene', output: 'scene' },
    ],
  }, 'pixal3d', new Set(), false)

  assert.deepEqual(extension.nodes.map((node: { id: string; input?: string; output?: string }) => [node.id, node.input, node.output]), [
    ['generate', 'image', 'mesh'],
    ['generate-mv', 'capture', 'mesh'],
    ['worldsculpt', 'scene', 'mesh'],
    ['scene-from-estimates', 'capture', 'scene'],
    ['normalize-annotated-scene', 'scene', 'scene'],
  ])
  assert.deepEqual(extension.nodes.map((node: { hasModelSources?: boolean }) => node.hasModelSources), [true, true, true, true, undefined])
})

test('ordinary listing projects persisted Agent-only nodes while Agent discovery retains them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modly-agent-listing-projection-'))
  const extensionDir = join(root, 'python-cad')
  const agentNode = (id: string, input: string, output: string, mediaType: string) => ({
    id,
    input,
    output,
    params_schema: [],
    agent: {
      schema: 'modly.agent-capability-declaration.v1',
      capability_id: `python-cad/${id}`,
      display_name: `Create ${id}`,
      description: `Create the ${id} artifact.`,
      approval: { required: true, scope: 'single_action' },
      process: {
        schema: 'modly.agent-process.v1',
        runtimeFiles: ['processor.py'],
        resourceFiles: [],
        runtime: { kind: 'extension-python-venv-v1', interpreter: 'bin/python' },
        artifacts: {
          maxCount: 1,
          maxTotalBytes: 4096,
          allowed: [{ kind: output, mediaTypes: [mediaType], maxBytes: 4096 }],
        },
      },
    },
  })
  await mkdir(extensionDir, { recursive: true })
  await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify({
    id: 'python-cad',
    name: 'Python CAD',
    type: 'process',
    entry: 'processor.py',
    nodes: [
      agentNode('plan', 'text', 'plan', 'application/json'),
      agentNode('source', 'plan', 'source', 'text/x-python'),
      agentNode('glb', 'source', 'glb', 'model/gltf-binary'),
      agentNode('step', 'source', 'step', 'model/step'),
      { id: 'preview', input: 'text', output: 'mesh', params_schema: [] },
    ],
  }))

  try {
    const ordinary = await readExtensionsFromDir(root, false, new Set())
    assert.equal(ordinary[0]?.type, 'process')
    assert.deepEqual(ordinary[0]?.nodes.map((node: { id: string }) => node.id), ['preview'])

    const detailed = await readExtensionsFromDirDetailed(root, false, new Set())
    assert.deepEqual(detailed.errors, [])
    assert.equal(detailed.extensions[0]?.type, 'process')
    assert.deepEqual(detailed.extensions[0]?.nodes.map((node: { id: string }) => node.id), ['preview'])

    const resolvedOrdinary = await readResolvedExtensionsFromDirDetailed(root, false, new Set())
    assert.deepEqual(resolvedOrdinary.errors, [])
    assert.equal(resolvedOrdinary.extensions[0]?.extension.type, 'process')
    assert.deepEqual(
      resolvedOrdinary.extensions[0]?.extension.nodes.map((node: { id: string }) => node.id),
      ['preview'],
    )
    assert.equal(resolvedOrdinary.extensions[0]?.manifest?.nodes?.length, 5)

    const resolvedAgent = await readResolvedExtensionsFromDirDetailed(root, false, new Set(), true)
    assert.deepEqual(resolvedAgent.errors, [])
    assert.equal(resolvedAgent.extensions[0]?.extension.type, 'process')
    assert.deepEqual(
      resolvedAgent.extensions[0]?.extension.nodes.map((node: { id: string }) => node.id),
      ['plan', 'source', 'glb', 'step', 'preview'],
    )
    assert.equal(resolvedAgent.extensions[0]?.extension.nodes.slice(0, 4)
      .every((node: { agent?: unknown }) => node.agent !== undefined), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('parseExtensionManifest rejects input none on process extensions', () => {
  assert.throws(
    () => parseExtensionManifest(
      {
        id: 'broken-process',
        type: 'process',
        entry: 'processor.js',
        nodes: [{ id: 'optimize', input: 'none', output: 'mesh' }],
      },
      'broken-process',
      new Set(),
      false,
    ),
    /may use 'none' only for model extension nodes/i,
  )
})

test('parseExtensionManifest preserves generic json ports instead of normalizing them to scene', () => {
  const extension = parseExtensionManifest(
    {
      id: 'dreamcube-scenes',
      type: 'process',
      entry: 'processor.js',
      nodes: [{
        id: 'generate-scene',
        input: 'image',
        output: 'mesh',
        inputs: ['Json' as never],
        input_contract: [{ name: 'scene_doc', label: 'Scene Doc', type: 'JSON', required: true }],
      }],
    },
    'dreamcube-scenes',
    new Set(),
    false,
  )

  assert.equal(extension.type, 'process')
  assert.deepEqual(extension.nodes[0].inputs, [
    { name: 'scene_doc', label: 'Scene Doc', type: 'JSON', required: true },
  ])
})

test('parseExtensionManifest accepts legacy object ports that use id as the handle alias', () => {
  const extension = parseExtensionManifest(
    {
      id: 'legacy-id-ports',
      type: 'process',
      entry: 'processor.js',
      nodes: [{
        id: 'run',
        input: 'image',
        output: 'mesh',
        inputs: [{ id: 'source_image', type: 'image' } as never],
      }],
    },
    'legacy-id-ports',
    new Set(),
    false,
  )

  assert.deepEqual(extension.nodes[0].inputs, [{ name: 'source_image', type: 'image', required: true }])
  assert.equal('outputs' in extension.nodes[0], false)
})

test('extension discovery preserves valid siblings when one manifest fails semantic parsing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modly-automation-capabilities-'))
  const validDir = join(root, 'valid-ext')
  const invalidDir = join(root, 'invalid-ext')

  await mkdir(validDir)
  await mkdir(invalidDir)
  await writeFile(join(validDir, 'manifest.json'), JSON.stringify({
    id: 'valid-ext',
    type: 'process',
    entry: 'processor.js',
    nodes: [{ id: 'generate', input: 'image', output: 'image' }],
  }), 'utf-8')
  await writeFile(join(invalidDir, 'manifest.json'), JSON.stringify({
    id: 'invalid-ext',
    type: 'process',
    entry: 'processor.js',
    nodes: [{ id: 'broken', input: 'invalid-kind', output: 'mesh' }],
  }), 'utf-8')

  const listed = await readExtensionsFromDir(root, false, new Set())
  assert.equal(listed.length, 2)
  assert.equal(listed.find((extension: ExtensionForTest) => extension.id === 'valid-ext')?.type, 'process')
  assert.deepEqual(listed.find((extension: ExtensionForTest) => extension.id === 'invalid-ext'), {
    type: 'model',
    id: 'invalid-ext',
    name: 'invalid-ext',
    trusted: false,
    builtin: false,
    nodes: [],
  })

  const detailed = await readExtensionsFromDirDetailed(root, false, new Set())
  assert.equal(detailed.extensions.find((extension: ExtensionForTest) => extension.id === 'valid-ext')?.type, 'process')
  assert.match(
    detailed.errors.find((error: ExtensionDiscoveryErrorForTest) => error.context?.extension_id === 'invalid-ext')?.message ?? '',
    /failed to parse manifest\.json/i,
  )

  const resolved = await readResolvedExtensionsFromDirDetailed(root, false, new Set())
  const resolvedValid = resolved.extensions.find((entry: ResolvedExtensionForTest) => entry.extension.id === 'valid-ext')
  const resolvedInvalid = resolved.extensions.find((entry: ResolvedExtensionForTest) => entry.extension.id === 'invalid-ext')
  assert.equal(resolvedValid?.extension.type, 'process')
  assert.equal(resolvedInvalid?.manifest, null)
  assert.match(
    resolved.errors.find((error: ExtensionDiscoveryErrorForTest) => error.context?.extension_id === 'invalid-ext')?.message ?? '',
    /failed to parse manifest\.json/i,
  )
})
const obsoleteManifestIoKey = 'io_' + 'contract'

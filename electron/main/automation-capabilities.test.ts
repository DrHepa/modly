import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
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

type NamedPortForTest = {
  name: string
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


test('parseExtensionManifest exposes inherited named-v1 ports and ignores named outputs for legacy models', () => {
  const named = parseExtensionManifest(
    {
      id: 'sense-depth',
      type: 'model',
      io_contract: 'named-v1',
      nodes: [{
        id: 'depth-six-view',
        input: 'image',
        output: 'image',
        inputs: [
          { name: 'front', type: 'image', required: true },
          { name: 'right', type: 'image', required: false },
          { name: 'back', type: 'image', required: false },
          { name: 'left', type: 'image', required: false },
          { name: 'top', type: 'image', required: false },
          { name: 'bottom', type: 'image', required: false },
        ],
        outputs: [
          { name: 'front_depth', type: 'image' },
          { name: 'right_depth', type: 'image' },
          { name: 'back_depth', type: 'image' },
          { name: 'left_depth', type: 'image' },
          { name: 'top_depth', type: 'image' },
          { name: 'bottom_depth', type: 'image' },
        ],
      }],
    },
    'sense-depth',
    new Set(),
    false,
  )

  assert.equal(named.type, 'model')
  assert.equal(named.nodes[0].ioContract, 'named-v1')
  assert.deepEqual(named.nodes[0].inputs?.map((port: NamedPortForTest) => port.name), [
    'front', 'right', 'back', 'left', 'top', 'bottom',
  ])
  assert.deepEqual(named.nodes[0].outputs?.map((port: NamedPortForTest) => port.name), [
    'front_depth', 'right_depth', 'back_depth', 'left_depth', 'top_depth', 'bottom_depth',
  ])

  const legacy = parseExtensionManifest(
    {
      id: 'legacy-image-model',
      type: 'model',
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

  assert.equal(legacy.nodes[0].ioContract, undefined)
  assert.deepEqual(legacy.nodes[0].outputs, [{ name: 'provisional_named_output', type: 'image', required: true }])
  assert.deepEqual(legacy.nodes[0].inputs?.map((port: NamedPortForTest) => port.name), [
    'front', 'left', 'back', 'right',
  ])
})

test('parseExtensionManifest defaults omitted named-v1 output required to true', () => {
  const extension = parseExtensionManifest(
    {
      id: 'default-required-output',
      type: 'model',
      io_contract: 'named-v1',
      nodes: [{
        id: 'generate',
        input: 'image',
        output: 'image',
        inputs: [{ name: 'source', type: 'image' }],
        outputs: [{ name: 'result', type: 'image' }],
      }],
    },
    'default-required-output',
    new Set(),
    false,
  )

  assert.deepEqual(extension.nodes[0].outputs, [
    { name: 'result', type: 'image', required: true },
  ])
})

test('parseExtensionManifest preserves explicit false for named-v1 output required', () => {
  const extension = parseExtensionManifest(
    {
      id: 'optional-output',
      type: 'model',
      io_contract: 'named-v1',
      nodes: [{
        id: 'generate',
        input: 'image',
        output: 'image',
        inputs: [{ name: 'source', type: 'image' }],
        outputs: [{ name: 'preview', type: 'image', required: false }],
      }],
    },
    'optional-output',
    new Set(),
    false,
  )

  assert.deepEqual(extension.nodes[0].outputs, [
    { name: 'preview', type: 'image', required: false },
  ])
})

test('parseExtensionManifest rejects non-boolean named-v1 output required', () => {
  assert.throws(
    () => parseExtensionManifest(
      {
        id: 'invalid-output-required',
        type: 'model',
        io_contract: 'named-v1',
        nodes: [{
          id: 'generate',
          input: 'image',
          output: 'image',
          inputs: [{ name: 'source', type: 'image' }],
          outputs: [{ name: 'result', type: 'image', required: 'false' as never }],
        }],
      },
      'invalid-output-required',
      new Set(),
      false,
    ),
    /outputs\[0\]\.required must be a boolean/i,
  )
})

test('parseExtensionManifest rejects malformed named-v1 declarations with actionable errors', () => {
  const parse = (node: Record<string, unknown>, ioContract = 'named-v1') => parseExtensionManifest(
    {
      id: 'invalid-named-model',
      type: 'model',
      nodes: [{ id: 'depth', input: 'image', output: 'image', io_contract: ioContract, ...node }],
    },
    'invalid-named-model',
    new Set(),
    false,
  )

  assert.throws(
    () => parse({ inputs: [
      { name: 'front', type: 'image' },
      { name: 'front', type: 'image' },
    ], outputs: [{ name: 'front_depth', type: 'image' }] }),
    /duplicate port name "front"/i,
  )
  assert.deepEqual(
    parse({
      inputs: [{ name: 'front', type: 'depth-map' }],
      outputs: [{ name: 'front_depth', type: 'image' }],
    }).nodes[0].inputs,
    [{ name: 'front', type: 'depth-map', required: true }],
  )
  assert.throws(
    () => parse({
      inputs: [{ name: 'front', type: 'image' }],
      outputs: [{ name: 'front_depth', type: 'image' }],
    }, 'positional-v2'),
    /unsupported io_contract/i,
  )
})

test('parseExtensionManifest accepts one sole ordered repeatable image port under named-v1', () => {
  const extension = parseExtensionManifest({
    id: 'sense-reconstruct',
    type: 'model',
    io_contract: 'named-v1',
    nodes: [{
      id: 'reconstruct',
      input: 'image',
      output: 'mesh',
      inputs: [{
        name: 'images',
        type: 'image',
        required: true,
        multiple: true,
        min_items: 1,
        max_items: 10,
        ordered: true,
      }],
      outputs: [{ name: 'point_cloud', type: 'mesh' }],
    }],
  }, 'sense-reconstruct', new Set(), false)

  assert.equal(extension.nodes[0].ioContract, 'named-v1')
  assert.deepEqual(extension.nodes[0].inputs?.[0], {
    name: 'images', type: 'image', required: true,
    multiple: true, min_items: 1, max_items: 10, ordered: true,
  })

  for (const inputs of [
    [
      { name: 'images', type: 'image', required: true, multiple: true, ordered: true },
      { name: 'mask', type: 'image', required: false },
    ],
    [{ name: 'images', type: 'image', required: false, multiple: true, ordered: true }],
    [{ name: 'images', type: 'image', required: true, multiple: true, ordered: false }],
  ]) {
    assert.throws(() => parseExtensionManifest({
      id: 'invalid-repeatable', type: 'model', io_contract: 'named-v1',
      nodes: [{ id: 'reconstruct', input: 'image', output: 'mesh', inputs: inputs as never, outputs: [{ name: 'point_cloud', type: 'mesh' }] }],
    }, 'invalid-repeatable', new Set(), false), /sole input|required|ordered/i)
  }
})

test('parseExtensionManifest rejects io_contract on process nodes but preserves process outputs[] when present', () => {
  assert.throws(() => parseExtensionManifest({
    id: 'bad-process-contract', type: 'process', io_contract: 'named-v1', entry: 'processor.js',
    nodes: [{ id: 'run', input: 'image', output: 'image' }],
  }, 'bad-process-contract', new Set(), false), /only for model extension nodes/i)

  const extension = parseExtensionManifest({
    id: 'bad-process-outputs', type: 'process', entry: 'processor.js',
    nodes: [{ id: 'run', input: 'image', output: 'image', outputs: [{ name: 'preview', type: 'image' }] }],
  }, 'bad-process-outputs', new Set(), false)

  assert.equal(extension.type, 'process')
  assert.deepEqual(extension.nodes[0].outputs, [{ name: 'preview', type: 'image', required: true }])
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
      substitution: { supported: true, artifactKinds: ['image', 'text', 'mesh', 'scene', 'audio', 'video'], boundary: 'ui_only', headless: false },
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
    /must be one of: image, text, mesh, scene, audio, video, none/i,
  )
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
        outputs: [{ id: 'preview_mesh', type: 'mesh' } as never],
      }],
    },
    'legacy-id-ports',
    new Set(),
    false,
  )

  assert.deepEqual(extension.nodes[0].inputs, [{ name: 'source_image', type: 'image', required: true }])
  assert.deepEqual(extension.nodes[0].outputs, [{ name: 'preview_mesh', type: 'mesh', required: true }])
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

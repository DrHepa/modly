import assert from 'node:assert/strict'
import test from 'node:test'

const {
  getUiOnlyNodes,
  parseExtensionManifest,
} = await import(new URL('./automation-capabilities.ts', import.meta.url).href)

type UiOnlyNodeForTest = {
  id: string
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

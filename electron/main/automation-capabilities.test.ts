import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import type { ParsedManifest } from './automation-capabilities'
register('../../scripts/node-ts-extensionless-loader.mjs', import.meta.url)

const { getProcessTargetPort, getProcessTargetPorts } = await import(
  new URL('../../src/areas/workflows/processPorts.ts', import.meta.url).href,
)
const { buildProcessExecutionInput } = await import(
  new URL('../../src/areas/workflows/processExecution.ts', import.meta.url).href,
)

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
  assert.equal(getProcessTargetPort(extension.nodes[0], 'rigged_mesh')?.type, 'mesh')
  for (const handle of ['input-1', 'mesh', 'wrong', null, undefined]) {
    assert.equal(getProcessTargetPort(extension.nodes[0], handle), undefined)
  }
})

test('parseExtensionManifest preserves positional routing for legacy string inputs without input_contract', () => {
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

  assert.deepEqual(extension.nodes[0].inputs, ['text', 'mesh'])
  assert.deepEqual(getProcessTargetPorts(extension.nodes[0]), [
    { name: 'input-0', type: 'text', required: true, isLegacy: true },
    { name: 'input-1', type: 'mesh', required: true, isLegacy: true },
  ])
  assert.equal(getProcessTargetPort(extension.nodes[0], null)?.name, 'input-0')
  assert.equal(getProcessTargetPort(extension.nodes[0], 'mesh'), undefined)
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

function parseInputNode(node: NonNullable<ParsedManifest['nodes']>[number], type: 'model' | 'process' = 'model') {
  return parseExtensionManifest({ id: 'contract-tests', type, nodes: [node] }, 'fallback', new Set()).nodes[0]
}

for (const type of ['model', 'process'] as const) {
  test(`input_contract opts ${type} into named ports without changing modalities or manifest data`, () => {
    const node = {
      id: 'compose', input: 'mesh', output: 'mesh',
      inputs: ['audio', 'custom-kind', 'text', 'text'],
      input_contract: [
        { name: ' sound ', label: ' Sound ', type: 'scene', required: false },
        { name: 'custom', label: ' ', type: 'mesh' },
        { name: 'first', label: 'First', required: true },
        { name: 'second', label: 'Second', required: false },
      ],
      input_labels: ['Original sound', 'Custom', 'First', 'Second'],
    }
    const before = structuredClone(node)
    const parsed = parseInputNode(node, type)
    assert.deepEqual(parsed.inputs, [
      { name: 'sound', label: 'Sound', type: 'audio', required: false },
      { name: 'custom', type: 'custom-kind', required: true },
      { name: 'first', label: 'First', type: 'text', required: true },
      { name: 'second', label: 'Second', type: 'text', required: false },
    ])
    assert.deepEqual(parsed.inputLabels, node.input_labels)
    assert.deepEqual(node, before)
    assert.notEqual(parsed.inputs, node.inputs)
    assert.equal(getProcessTargetPort(parsed, 'sound')?.type, 'audio')
    assert.equal(getProcessTargetPort(parsed, 'input-0'), undefined)
    assert.equal(getProcessTargetPort(parsed, null), undefined)
  })
}

for (const [label, contract] of [
  ['missing', undefined], ['empty', []], ['null', null], ['object', { name: 'one' }],
  ['string', 'one'], ['short', [{ name: 'one' }]],
  ['long', [{ name: 'one' }, { name: 'two' }, { name: 'three' }]],
  ['null entry', [{ name: 'one' }, null]], ['string entry', [{ name: 'one' }, 'two']],
  ['array entry', [{ name: 'one' }, []]], ['missing name', [{ name: 'one' }, {}]],
  ['blank name', [{ name: 'one' }, { name: '  ' }]], ['numeric name', [{ name: 'one' }, { name: 42 }]],
  ['duplicate name', [{ name: 'one' }, { name: 'one' }]],
  ['trimmed duplicate', [{ name: ' one ' }, { name: 'one' }]],
  ['invalid required', [{ name: 'one', required: 'false' }, { name: 'two' }]],
] as const) {
  test(`input_contract ${label} falls back atomically to repeated positional slots`, () => {
    const node = { id: 'legacy', inputs: ['text', 'text'], input_contract: contract }
    const before = structuredClone(node)
    const parsed = parseInputNode(node as NonNullable<ParsedManifest['nodes']>[number])
    assert.deepEqual(parsed.inputs, ['text', 'text'])
    assert.deepEqual(getProcessTargetPorts(parsed).map((port: { name: string }) => port.name), ['input-0', 'input-1'])
    assert.equal(getProcessTargetPort(parsed, 'one'), undefined)
    assert.equal(getProcessTargetPort(parsed, 'input-1')?.type, 'text')
    assert.deepEqual(node, before)
  })
}

test('input_contract preserves absent and empty inputs rather than synthesizing slots', () => {
  for (const inputs of [undefined, []]) {
    for (const input_contract of [undefined, [], [{ name: 'invented', type: 'scene' }]]) {
      const parsed = parseInputNode({ id: 'empty', input: 'audio', inputs, input_contract })
      assert.deepEqual(parsed.inputs, inputs)
      assert.deepEqual(getProcessTargetPorts(parsed), [{ name: null, type: 'audio', required: true, isLegacy: true }])
    }
  }
})

test('input_contract leaves already named declarations and their default behavior unchanged', () => {
  const inputs = [
    { name: 'first', type: 'custom-kind', label: ' Existing ' },
    { name: 'second', type: 'text', label: '', required: false },
  ]
  const before = structuredClone(inputs)
  const without = parseInputNode({ id: 'named', inputs })
  const withContract = parseInputNode({ id: 'named', inputs, input_contract: [
    { name: 'renamed', type: 'scene', label: 'Wrong', required: false },
    { name: 'renamed', type: 'mesh', label: 'Wrong', required: true },
  ] })
  assert.deepEqual(withContract, without)
  assert.deepEqual(withContract.inputs, [{ ...inputs[0], required: true }, inputs[1]])
  assert.deepEqual(inputs, before)
  assert.notEqual(withContract.inputs?.[0], inputs[0])
})

test('input_contract ignores invalid labels and contradictory types without inventing scene authority', () => {
  const parsed = parseInputNode({ id: 'labels', inputs: ['text', 'mesh'], input_contract: [
    { name: 'prompt', label: 42, type: 'scene', required: null },
    { name: 'rigged_mesh', label: null, type: 'text', required: false },
  ] } as unknown as NonNullable<ParsedManifest['nodes']>[number])
  assert.deepEqual(parsed.inputs, [
    { name: 'prompt', type: 'text', required: true },
    { name: 'rigged_mesh', type: 'mesh', required: false },
  ])
  const scene = { id: 'scene', input: 'scene', inputs: ['scene'], input_contract: [{ name: 'mesh', type: 'mesh' }] }
  assert.throws(() => parseInputNode(scene, 'model'), /scene/i)
  assert.deepEqual(parseInputNode(scene, 'process').inputs, [{ name: 'mesh', type: 'scene', required: true }])
})

test('missing contract retains arbitrary modalities and every repeated slot', () => {
  const inputs = ['image', 'image', 'audio', 'custom-kind', 'text', 'text']
  const parsed = parseInputNode({ id: 'legacy', inputs, input_labels: ['A', 'B'] })
  assert.deepEqual(parsed.inputs, inputs)
  assert.deepEqual(parsed.inputLabels, ['A', 'B'])
  assert.deepEqual(getProcessTargetPorts(parsed).map((port: { name: string; type: string }) => [port.name, port.type]),
    inputs.map((kind, index) => [`input-${index}`, kind]))
})

function processInputFixture(inputContract?: NonNullable<ParsedManifest['nodes']>[number]['input_contract']) {
  const parsed = parseInputNode({ id: 'compose', input: 'text', inputs: ['text', 'mesh'], input_contract: inputContract }, 'process')
  const extension = {
    ...parsed, id: 'contract-tests/compose', extensionId: 'contract-tests', extensionName: 'Contracts',
    extensionAuthor: 'Tests', nodeId: 'compose', description: '', params: [], builtin: false, type: 'process',
  }
  const node = (id: string, type: string, data: Record<string, unknown>) => ({ id, type, data, position: { x: 0, y: 0 } })
  const target = node('target', 'extensionNode', { extensionId: extension.id, enabled: true, params: {} })
  return {
    node: target,
    nodes: [node('prompt-source', 'textNode', {}), node('mesh-source', 'meshNode', {}), target],
    allExtensions: [extension],
    nodeOutputs: new Map([
      ['prompt-source', { text: 'Walk forward', outputType: 'text' }],
      ['mesh-source', { filePath: '/workspace/rig.glb', outputType: 'mesh' }],
    ]),
  }
}

test('parsed legacy ports reach the actual positional PROCESS consumer with indexed text and mesh', () => {
  const fixture = processInputFixture()
  const result = buildProcessExecutionInput({ ...fixture, edges: [
    { id: 'text', source: 'prompt-source', target: 'target', targetHandle: 'input-0' },
    { id: 'mesh', source: 'mesh-source', target: 'target', targetHandle: 'input-1' },
  ] })
  assert.deepEqual(result, { nodeId: 'compose', text: 'Walk forward', filePath: '/workspace/rig.glb', texts: ['Walk forward'] })
})

test('parsed named ports reach the actual PROCESS consumer only through exact handles', () => {
  const fixture = processInputFixture([{ name: 'prompt' }, { name: 'rigged_mesh' }])
  const result = buildProcessExecutionInput({ ...fixture, edges: [
    { id: 'text', source: 'prompt-source', target: 'target', targetHandle: 'prompt' },
    { id: 'mesh', source: 'mesh-source', target: 'target', targetHandle: 'rigged_mesh' },
  ] })
  assert.deepEqual(result, { nodeId: 'compose', inputs: {
    prompt: { type: 'text', sourceNodeId: 'prompt-source', text: 'Walk forward' },
    rigged_mesh: { type: 'mesh', sourceNodeId: 'mesh-source', filePath: '/workspace/rig.glb' },
  } })
  for (const targetHandle of ['input-1', 'mesh', 'wrong', null, undefined]) {
    assert.deepEqual(buildProcessExecutionInput({ ...fixture,
      edges: [{ id: 'wrong', source: 'mesh-source', target: 'target', targetHandle }],
      previousNodeOutput: { filePath: '/workspace/fallback.glb' },
    }), { nodeId: 'compose' })
  }
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

test('parseExtensionManifest validates input shape while preserving custom metadata', () => {
  for (const input of [null, 42, false, [], {}, '', '   ']) {
    assert.throws(
      () => parseExtensionManifest(
        {
          id: 'broken-model',
          type: 'model',
          nodes: [{ id: 'generate', input: input as never, output: 'mesh' }],
        },
        'broken-model',
        new Set(),
        false,
      ),
      /must be a non-empty string/i,
    )
  }

  for (const type of ['model', 'process'] as const) {
    for (const input of ['capture', 'custom-input']) {
      const parsed = parseExtensionManifest(
        { id: 'custom-model', type, nodes: [{ id: 'generate', input, output: 'video' }] },
        'custom-model', new Set(), false,
      )
      assert.equal(parsed.nodes[0].input, input)
    }
    const legacy = parseExtensionManifest(
      { id: 'legacy-model', type, nodes: [{ id: 'generate', output: 'mesh' }] },
      'legacy-model', new Set(), false,
    )
    assert.equal(legacy.nodes[0].input, 'image')
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

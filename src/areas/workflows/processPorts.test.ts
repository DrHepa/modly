import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtensionNode } from '../../shared/types/electron.d'
const {
  getProcessTargetPorts,
  getProcessTargetPort,
  resolveProcessTargetColor,
} = await import(new URL('./processPorts.ts', import.meta.url).href)

const multiInputProcessNode = {
  input: 'image' as const,
  inputs: [
    { name: 'reference_image', type: 'image' as const },
    { name: 'coarse_mesh', type: 'mesh' as const },
  ],
}

test('falls back to one required legacy target port when inputs[] is absent', () => {
  assert.deepEqual(getProcessTargetPorts({ input: 'mesh' }), [
    { name: null, type: 'mesh', required: true, isLegacy: true },
  ])
})

test('looks up named target ports by handle id', () => {
  const port = getProcessTargetPort(
    {
      input: 'image',
      inputs: [
        { name: 'reference_image', type: 'image' },
        { name: 'coarse_mesh', type: 'mesh', required: false },
      ],
    },
    'coarse_mesh',
  )

  assert.deepEqual(port, {
    name: 'coarse_mesh',
    type: 'mesh',
    required: false,
    isLegacy: false,
  })
})

test('defaults declared process ports to required=true', () => {
  assert.deepEqual(getProcessTargetPorts({
    input: 'image',
    inputs: [
      { name: 'reference_image', type: 'image' },
      { name: 'prompt', type: 'text', required: false },
    ],
  }), [
    { name: 'reference_image', type: 'image', required: true, isLegacy: false },
    { name: 'prompt', type: 'text', required: false, isLegacy: false },
  ])
})

test('preserves display labels without replacing named routing handles', () => {
  const ports = getProcessTargetPorts({
    input: 'image',
    inputs: [
      { name: 'front', label: 'Primary image', type: 'image' },
      { name: 'left', label: 'Image 2', type: 'image', required: false },
    ],
  })

  assert.deepEqual(ports, [
    { name: 'front', label: 'Primary image', type: 'image', required: true, isLegacy: false },
    { name: 'left', label: 'Image 2', type: 'image', required: false, isLegacy: false },
  ])
  assert.equal(getProcessTargetPort({ input: 'image', inputs: ports }, 'left')?.name, 'left')
  assert.equal(getProcessTargetPort({ input: 'image', inputs: ports }, 'Image 2'), undefined)
})

test('normalizes only display labels and preserves optional custom named routing ports', () => {
  const owner = { inputs: [
    { name: 'audio-track', label: '  Soundtrack  ', type: 'audio', required: false },
    { name: 'scene-source', label: '', type: 'scene' },
    { name: 'capture-source', label: ' \t ', type: 'capture', required: false },
  ] }
  const original = structuredClone(owner)
  assert.deepEqual(getProcessTargetPorts(owner), [
    { name: 'audio-track', label: 'Soundtrack', type: 'audio', required: false, isLegacy: false },
    { name: 'scene-source', type: 'scene', required: true, isLegacy: false },
    { name: 'capture-source', type: 'capture', required: false, isLegacy: false },
  ])
  assert.equal(getProcessTargetPort(owner, 'Soundtrack'), undefined)
  assert.equal(getProcessTargetPort(owner, 'audio-track')?.type, 'audio')
  assert.equal(getProcessTargetPort(owner, undefined), undefined)
  assert.deepEqual(owner, original)
})

for (const type of ['model', 'process']) {
  test(`${type} manifest boundary tolerates non-string display labels without changing named routing`, async () => {
    const { validateInstallManifest } = await import('../../../electron/main/extension-install-utils.ts')
    const { parseExtensionManifest } = await import('../../../electron/main/automation-capabilities.ts')
    const { buildAllWorkflowExtensions } = await import('./mockExtensions.ts')
    for (const label of [0, 1, false, true, null, {}, ['unexpected']]) {
      const manifest = JSON.parse(JSON.stringify({
        id: 'label-boundary', type, entry: 'processor.js', generator_class: 'Fixture',
        nodes: [{ id: 'run', input: 'image', output: 'mesh', inputs: [
          { name: 'stable-front', type: 'image', required: false, label, extension_metadata: { preserve: 42 } },
          { name: 'required-side', type: 'image', label },
        ] }],
      }))
      const original = structuredClone(manifest)
      validateInstallManifest(manifest, { hasEntryFile: () => true, hasGeneratorFile: () => true }, 'inert label fixture')
      const parsed = parseExtensionManifest(manifest, 'label-boundary', new Set(), false)
      assert.equal(parsed.type, type)
      const [owner] = parsed.type === 'model' ? buildAllWorkflowExtensions([parsed], []) : buildAllWorkflowExtensions([], [parsed])
      const ports = getProcessTargetPorts(owner)
      assert.deepEqual(ports, [
        { name: 'stable-front', type: 'image', required: false, isLegacy: false },
        { name: 'required-side', type: 'image', required: true, isLegacy: false },
      ])
      assert.equal(getProcessTargetPort(owner, 'stable-front')?.required, false)
      assert.equal(getProcessTargetPort(owner, 'required-side')?.required, true)
      assert.equal(getProcessTargetPort(owner, 'unknown'), undefined)
      assert.deepEqual(parsed.nodes[0].inputs, [
        { ...manifest.nodes[0].inputs[0], required: false },
        { ...manifest.nodes[0].inputs[1], required: true },
      ])
      assert.deepEqual(owner.inputs, parsed.nodes[0].inputs)
      assert.deepEqual(manifest, original)
    }
  })
}

test('uses targetHandle to resolve process target colors and preserves legacy fallback', () => {
  assert.equal(resolveProcessTargetColor(multiInputProcessNode, 'coarse_mesh'), '#a78bfa')
  assert.equal(resolveProcessTargetColor(multiInputProcessNode, 'reference_image'), '#38bdf8')
  assert.equal(resolveProcessTargetColor({ input: 'text' }), '#fbbf24')
})

test('keeps positional string ports, repeated types and slot handles distinct from named ports', () => {
  const owner = { input: 'image', inputs: ['image', 'text', 'image', 'audio', 'capture'] }
  assert.deepEqual(getProcessTargetPorts(owner), owner.inputs.map((type, i) => ({
    name: `input-${i}`, type, required: true, isLegacy: true,
  })))
  assert.equal(getProcessTargetPort(owner, 'input-2')?.type, 'image')
  assert.equal(getProcessTargetPort(owner, 'input-3')?.type, 'audio')
  assert.equal(getProcessTargetPort(owner, null)?.name, 'input-0')
  assert.equal(getProcessTargetPort(owner, 'input-8'), undefined)
  assert.equal(resolveProcessTargetColor(owner, 'input-3'), '#34d399')
  assert.equal(resolveProcessTargetColor(owner, 'input-4'), '#52525b')
})

test('workflow discovery keeps defaults and labels for both representations without modifying manifests', async () => {
  const { buildAllWorkflowExtensions } = await import('./mockExtensions.ts')
  const nodes: ExtensionNode[] = [
    { id: 'legacy', name: 'Legacy', input: 'image', inputs: ['image', 'image', 'audio', 'capture'], inputLabels: ['front', 'side', 'sound', 'capture'], output: 'video', paramsSchema: [{ id: 'strength', label: 'Strength', type: 'float', default: 1 }], paramDefaults: { strength: 0 } },
    { id: 'named', name: 'Named', input: 'image', inputs: [{ name: 'front', label: 'Primary image', type: 'image' }], output: 'mesh', paramsSchema: [{ id: 'prompt', label: 'Prompt', type: 'string', default: 'schema' }], paramDefaults: { prompt: '' } },
  ]
  const original = structuredClone(nodes)
  const result = buildAllWorkflowExtensions([], [{ type: 'process', id: 'pack', name: 'Pack', entry: 'processor.js', trusted: false, builtin: false, nodes }])
  assert.deepEqual(result[0].inputs, nodes[0].inputs)
  assert.deepEqual(result[0].inputLabels, nodes[0].inputLabels)
  assert.equal(result[0].params[0].default, 0)
  assert.deepEqual(result[1].inputs, [{ name: 'front', label: 'Primary image', type: 'image', required: true }])
  assert.equal(result[1].params[0].default, '')
  assert.deepEqual(nodes, original)
})

test('resolves scene process ports with the existing pink scene identity, distinct from audio', () => {
  const owner = { input: 'scene', inputs: [{ name: 'world_scene', label: 'World scene', type: 'scene' }] }
  assert.deepEqual(getProcessTargetPorts(owner), [
    { name: 'world_scene', label: 'World scene', type: 'scene', required: true, isLegacy: false },
  ])
  assert.equal(resolveProcessTargetColor(owner, 'world_scene'), '#f472b6')
  assert.equal(resolveProcessTargetColor({ input: 'scene' }), '#f472b6')
  assert.equal(resolveProcessTargetColor({ input: 'audio' }), '#34d399')
})

test('resolves audio process ports and colors as first-class workflow handles', () => {
  const audioProcessNode = {
    input: 'audio' as const,
    inputs: [
      { name: 'track', label: 'Track', type: 'audio' as const },
    ],
  }

  assert.deepEqual(getProcessTargetPorts(audioProcessNode), [
    { name: 'track', label: 'Track', type: 'audio', required: true, isLegacy: false },
  ])
  assert.equal(resolveProcessTargetColor(audioProcessNode, 'track'), '#f472b6')
  assert.equal(resolveProcessTargetColor({ input: 'audio' }), '#f472b6')
})

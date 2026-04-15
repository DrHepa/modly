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
    { id: 'named', name: 'Named', input: 'image', inputs: [{ name: 'front', type: 'image' }], output: 'mesh', paramsSchema: [{ id: 'prompt', label: 'Prompt', type: 'string', default: 'schema' }], paramDefaults: { prompt: '' } },
  ]
  const original = structuredClone(nodes)
  const result = buildAllWorkflowExtensions([], [{ type: 'process', id: 'pack', name: 'Pack', entry: 'processor.js', trusted: false, builtin: false, nodes }])
  assert.deepEqual(result[0].inputs, nodes[0].inputs)
  assert.deepEqual(result[0].inputLabels, nodes[0].inputLabels)
  assert.equal(result[0].params[0].default, 0)
  assert.deepEqual(result[1].inputs, [{ name: 'front', type: 'image', required: true }])
  assert.equal(result[1].params[0].default, '')
  assert.deepEqual(nodes, original)
})

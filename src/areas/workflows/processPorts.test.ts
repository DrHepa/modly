import assert from 'node:assert/strict'
import test from 'node:test'
const {
  getProcessTargetPorts,
  getProcessTargetPort,
  getExtensionSourcePorts,
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
})

test('uses targetHandle to resolve process target colors and preserves legacy fallback', () => {
  assert.equal(resolveProcessTargetColor(multiInputProcessNode, 'coarse_mesh'), '#a78bfa')
  assert.equal(resolveProcessTargetColor(multiInputProcessNode, 'reference_image'), '#38bdf8')
  assert.equal(resolveProcessTargetColor({ input: 'text' }), '#fbbf24')
})

test('resolves scene process ports and colors as first-class workflow handles', () => {
  const sceneProcessNode = {
    input: 'scene' as const,
    inputs: [
      { name: 'world_scene', label: 'World scene', type: 'scene' as const },
    ],
  }

  assert.deepEqual(getProcessTargetPorts(sceneProcessNode), [
    { name: 'world_scene', label: 'World scene', type: 'scene', required: true, isLegacy: false },
  ])
  assert.equal(resolveProcessTargetColor(sceneProcessNode, 'world_scene'), '#34d399')
  assert.equal(resolveProcessTargetColor({ input: 'scene' }), '#34d399')
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


test('resolves video process ports and colors as first-class workflow handles', () => {
  const videoProcessNode = {
    input: 'video' as const,
    inputs: [
      { name: 'clip', label: 'Clip', type: 'video' as const },
    ],
  }

  assert.deepEqual(getProcessTargetPorts(videoProcessNode), [
    { name: 'clip', label: 'Clip', type: 'video', required: true, isLegacy: false },
  ])
  assert.equal(resolveProcessTargetColor(videoProcessNode, 'clip'), '#fb7185')
  assert.equal(resolveProcessTargetColor({ input: 'video' }), '#fb7185')
})


test('keeps six arbitrary named model input and output handles intact', () => {
  const faces = ['front', 'right', 'back', 'left', 'top', 'bottom']
  const targets = getProcessTargetPorts({
    input: 'image',
    inputs: faces.map((name, index) => ({
      name,
      type: 'image',
      required: index === 0,
    })),
  })
  const sources = getExtensionSourcePorts({
    output: 'image',
    outputs: faces.map((name) => ({ name: `${name}_depth`, type: 'image' })),
  })

  assert.deepEqual(targets.map((port: { name: string }) => port.name), faces)
  assert.deepEqual(sources.map((port: { name: string }) => port.name), faces.map((name) => `${name}_depth`))
  assert.equal(sources[0].primary, true)
  assert.equal(sources.slice(1).every((port: { primary: boolean }) => port.primary === false), true)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import type { WorkflowExtension } from './mockExtensions'

const { buildAllWorkflowExtensions } = await import(new URL('./mockExtensions.ts', import.meta.url).href)

test('buildAllWorkflowExtensions keeps 3D workflow identity on ext.id/node.id while bundled models stay owner metadata agnostic', () => {
  const workflowExtensions = buildAllWorkflowExtensions(
    [
      {
        id: 'mesh-models',
        name: 'Mesh Models',
        author: 'Tests',
        description: '3D models',
        builtin: false,
        nodes: [
          {
            id: 'mesh-generator',
            name: 'Mesh Generator',
            input: 'image',
            output: 'mesh',
            paramsSchema: [],
          },
        ],
      },
      {
        id: 'image-bundle',
        name: 'Image Bundle',
        author: 'Tests',
        description: 'Bundled image models',
        builtin: false,
        nodes: [
          {
            id: 'sd15',
            name: 'SD 1.5',
            input: 'image',
            output: 'mesh',
            paramsSchema: [],
          },
        ],
      },
    ],
    [],
  )

  assert.deepEqual(
    workflowExtensions.map((extension: WorkflowExtension) => ({
      id: extension.id,
      extensionId: extension.extensionId,
      nodeId: extension.nodeId,
    })),
    [
      { id: 'mesh-models/mesh-generator', extensionId: 'mesh-models', nodeId: 'mesh-generator' },
      { id: 'image-bundle/sd15', extensionId: 'image-bundle', nodeId: 'sd15' },
    ],
  )
})

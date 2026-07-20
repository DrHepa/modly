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


test('buildAllWorkflowExtensions exposes singleton utility workflow nodes from extension manifests once per capability', () => {
  const workflowExtensions = buildAllWorkflowExtensions(
    [
      {
        id: 'wan-video',
        name: 'Wan Video',
        author: 'Tests',
        description: 'Video generation',
        builtin: false,
        nodes: [],
        workflowNodes: [
          {
            id: 'preview-video',
            name: 'Preview Video',
            description: 'Preview generated video artifacts',
            component: 'video-preview',
            capabilityId: 'modly.workflow.preview.video',
            input: 'video',
            output: 'video',
            singleton: true,
          },
        ],
      },
      {
        id: 'another-video',
        name: 'Another Video',
        author: 'Tests',
        description: 'Another video extension',
        builtin: false,
        nodes: [],
        workflowNodes: [
          {
            id: 'preview-video',
            name: 'Preview Video Duplicate',
            component: 'video-preview',
            capabilityId: 'modly.workflow.preview.video',
            input: 'video',
            output: 'video',
            singleton: true,
          },
        ],
      },
    ],
    [],
  )

  assert.deepEqual(
    workflowExtensions.map((extension: WorkflowExtension) => ({
      id: extension.id,
      type: extension.type,
      workflowNodeType: extension.workflowNodeType,
      capabilityId: extension.capabilityId,
      input: extension.input,
      output: extension.output,
    })),
    [
      {
        id: 'wan-video/preview-video',
        type: 'utility',
        workflowNodeType: 'previewVideoNode',
        capabilityId: 'modly.workflow.preview.video',
        input: 'video',
        output: 'video',
      },
    ],
  )
})


test('buildAllWorkflowExtensions strips obsolete workflow metadata from workflow nodes', () => {
  const [processExtension, modelExtension] = buildAllWorkflowExtensions(
    [{
      id: 'named-model', name: 'Named Model', author: 'Tests', builtin: false,
      nodes: [{
        id: 'analyze', name: 'Analyze', input: 'image', output: 'image',
        inputs: [{ name: 'image', type: 'image' }],
        paramsSchema: [],
      }],
    }],
    [{
      id: 'legacy-process', name: 'Legacy Process', author: 'Tests', builtin: false, entry: 'processor.js',
      nodes: [{
        id: 'run', name: 'Run', input: 'image', output: 'image',
        paramsSchema: [],
      }],
    }],
  )

  assert.equal(processExtension.type, 'process')
  assert.equal(modelExtension.type, 'model')
  assert.equal(('io' + 'Contract') in modelExtension, false)
  assert.equal('outputs' in modelExtension, false)
})

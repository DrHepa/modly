import test from 'node:test'
import assert from 'node:assert/strict'
import axios from 'axios'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildAutomationCapabilities, parseExtensionManifest } from './automation-capabilities.ts'
import {
  getAutomationCapabilitiesWithDeps,
  resolveAutomationCapabilitiesContextWithDeps,
} from './automation-capabilities-service.ts'

async function withTempExtensions(run) {
  const root = await mkdtemp(join(tmpdir(), 'modly-automation-capabilities-'))
  const builtinDir = join(root, 'builtin')
  const userExtensionsDir = join(root, 'user')

  await mkdir(builtinDir, { recursive: true })
  await mkdir(userExtensionsDir, { recursive: true })

  try {
    await run({ root, builtinDir, userExtensionsDir })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function createProcessManifest(baseDir, extensionId, manifest) {
  const extensionDir = join(baseDir, extensionId)
  await mkdir(extensionDir, { recursive: true })
  await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
}

const DEFAULT_PROCESS_AUTOMATION = {
  boundary: 'electron',
  headless: true,
  pause: { supported: false },
  substitution: { supported: false },
}

test('resolveAutomationCapabilitiesContextWithDeps assembles canonical service context', async () => {
  const trustedRepos = new Set(['acme/repo'])

  const context = await resolveAutomationCapabilitiesContextWithDeps({
    getUserDataPath: () => '/tmp/modly-user-data',
    getBuiltinExtensionsDir: () => '/tmp/modly-user-data/builtin-extensions',
    getSettings: (userData) => ({
      modelsDir: `${userData}/models`,
      workspaceDir: `${userData}/workspace`,
      workflowsDir: `${userData}/workflows`,
      extensionsDir: `${userData}/extensions`,
      dependenciesDir: `${userData}/dependencies`,
    }),
    fetchTrustedRepos: async () => trustedRepos,
  })

  assert.deepEqual(context, {
    builtinDir: '/tmp/modly-user-data/builtin-extensions',
    userExtensionsDir: '/tmp/modly-user-data/extensions',
    trustedRepos,
  })
})

test('getAutomationCapabilitiesWithDeps preserves canonical partial-success payloads', async () => {
  const partialResponse = {
    backend_ready: false,
    models: [],
    processes: [
      {
        kind: 'process',
        source: 'electron-manifest',
        id: 'mesh.optimize',
        extension_id: 'mesh-tools',
        node_id: 'optimize',
        name: 'Optimize Mesh',
        extension_name: 'Mesh Tools',
        builtin: true,
        trusted: true,
        entry: 'processor.js',
      },
    ],
    excluded: {
      ui_only_nodes: [],
    },
    errors: [
      {
        source: 'backend-runtime',
        code: 'BACKEND_NOT_READY',
        message: 'GET /health failed',
        retryable: true,
      },
    ],
  }

  const response = await getAutomationCapabilitiesWithDeps({
    getUserDataPath: () => '/tmp/modly-user-data',
    getBuiltinExtensionsDir: () => '/tmp/modly-user-data/builtin-extensions',
    getSettings: (userData) => ({
      modelsDir: `${userData}/models`,
      workspaceDir: `${userData}/workspace`,
      workflowsDir: `${userData}/workflows`,
      extensionsDir: `${userData}/extensions`,
      dependenciesDir: `${userData}/dependencies`,
    }),
    fetchTrustedRepos: async () => new Set(['acme/repo']),
    buildAutomationCapabilities: async (context) => {
      assert.deepEqual(context, {
        builtinDir: '/tmp/modly-user-data/builtin-extensions',
        userExtensionsDir: '/tmp/modly-user-data/extensions',
        trustedRepos: new Set(['acme/repo']),
      })

      return partialResponse
    },
  })

  assert.equal(response.backend_ready, false)
  assert.deepEqual(response, partialResponse)
})

test('buildAutomationCapabilities returns full canonical payload when backend is healthy', async () => {
  await withTempExtensions(async ({ builtinDir, userExtensionsDir }) => {
    await createProcessManifest(builtinDir, 'mesh-tools', {
      id: 'mesh-tools',
      displayName: 'Mesh Tools',
      version: '1.0.0',
      description: 'Built-in mesh helpers',
      source: 'acme/mesh-tools',
      type: 'process',
      entry: 'processor.js',
      nodes: [
        {
          id: 'optimize',
          name: 'Optimize Mesh',
          input: 'mesh',
          output: 'mesh',
          params_schema: [{ key: 'ratio', type: 'number' }],
        },
      ],
    })

    const originalGet = axios.get
    const calls = []
    axios.get = async (url, config = {}) => {
      calls.push({ url, config })

      if (url.endsWith('/health')) return { data: { ok: true } }
      if (url.endsWith('/model/all')) {
        return {
          data: [
            {
              id: 'hf://acme/mesh-gen',
              name: 'Mesh Gen',
              description: 'Canonical model id from backend',
              version: '2.0.0',
              hf_repo: 'acme/mesh-gen',
              tags: ['mesh'],
              downloaded: true,
              loaded: true,
              active: true,
              vram_gb: 4,
            },
          ],
        }
      }
      if (url.endsWith('/model/params')) {
        assert.equal(config.params?.model_id, 'hf://acme/mesh-gen')
        return { data: [{ key: 'prompt', type: 'string' }] }
      }

      throw new Error(`Unexpected URL: ${url}`)
    }

    try {
      const response = await buildAutomationCapabilities({
        builtinDir,
        userExtensionsDir,
        trustedRepos: new Set(['acme/mesh-tools']),
      })

      assert.equal(response.backend_ready, true)
      assert.deepEqual(response.scene, {
        import_mesh: {
          supported: true,
          route: '/scene/import-mesh',
          allowed_extensions: ['.glb', '.obj', '.stl', '.ply'],
          extensions: ['.glb', '.obj', '.stl', '.ply'],
        },
      })
      assert.equal(response.models.length, 1)
      assert.deepEqual(response.models[0], {
        kind: 'model',
        source: 'backend-runtime',
        id: 'hf://acme/mesh-gen',
        name: 'Mesh Gen',
        description: 'Canonical model id from backend',
        version: '2.0.0',
        hf_repo: 'acme/mesh-gen',
        tags: ['mesh'],
        downloaded: true,
        loaded: true,
        active: true,
        vram_gb: 4,
        params_schema: [{ key: 'prompt', type: 'string' }],
      })
      assert.equal(response.processes.length, 1)
      assert.deepEqual(response.processes[0], {
        kind: 'process',
        source: 'electron-manifest',
        id: 'mesh-tools/optimize',
        extension_id: 'mesh-tools',
        node_id: 'optimize',
        name: 'Optimize Mesh',
        extension_name: 'Mesh Tools',
        description: 'Built-in mesh helpers',
        version: '1.0.0',
        builtin: true,
        trusted: true,
        entry: 'processor.js',
        input: 'mesh',
        output: 'mesh',
        params_schema: [{ key: 'ratio', type: 'number' }],
        automation: DEFAULT_PROCESS_AUTOMATION,
        ready: null,
      })
      assert.equal(response.errors, undefined)
      assert.ok(Array.isArray(response.excluded.ui_only_nodes))
      assert.equal(response.excluded.ui_only_nodes.length, 5)
      assert.deepEqual(response.excluded.ui_only_nodes.find((node) => node.label === 'Add to Scene'), {
        kind: 'ui_only',
        source: 'ui-only',
        id: 'outputNode',
        type: 'outputNode',
        label: 'Add to Scene',
        reason: 'Canvas output node from WorkflowsPage; it targets desktop scene composition only and is intentionally excluded from automation discovery.',
      })
      assert.deepEqual(
        calls.map((call) => call.url),
        ['http://127.0.0.1:8765/health', 'http://127.0.0.1:8765/model/all', 'http://127.0.0.1:8765/model/params'],
      )
    } finally {
      axios.get = originalGet
    }
  })
})

test('buildAutomationCapabilities keeps backend_ready=true on partial model param failures', async () => {
  await withTempExtensions(async ({ builtinDir, userExtensionsDir }) => {
    await createProcessManifest(userExtensionsDir, 'user-mesh-tools', {
      id: 'user-mesh-tools',
      displayName: 'User Mesh Tools',
      version: '1.1.0',
      description: 'User process pack',
      source: 'acme/user-mesh-tools',
      type: 'process',
      entry: 'processor.js',
      nodes: [
        {
          id: 'repair',
          name: 'Repair Mesh',
          input: 'mesh',
          output: 'mesh',
          params_schema: [{ key: 'strength', type: 'number' }],
        },
      ],
    })

    const originalGet = axios.get
    axios.get = async (url, config = {}) => {
      if (url.endsWith('/health')) return { data: { ok: true } }
      if (url.endsWith('/model/all')) {
        return {
          data: [
            { id: 'model-ok', name: 'Model OK' },
            { id: 'model-fails', name: 'Model Fails' },
          ],
        }
      }
      if (url.endsWith('/model/params')) {
        if (config.params?.model_id === 'model-ok') return { data: [{ key: 'seed', type: 'number' }] }
        if (config.params?.model_id === 'model-fails') throw new Error('params endpoint exploded')
      }

      throw new Error(`Unexpected URL: ${url}`)
    }

    try {
      const response = await buildAutomationCapabilities({
        builtinDir,
        userExtensionsDir,
        trustedRepos: new Set(['acme/user-mesh-tools']),
      })

      assert.equal(response.backend_ready, true)
      assert.equal(response.models.length, 1)
      assert.equal(response.models[0]?.id, 'model-ok')
      assert.equal(response.processes.length, 1)
      assert.ok(response.errors)
      assert.deepEqual(response.errors, [
        {
          source: 'backend-runtime',
          code: 'MODEL_PARAMS_FAILED',
          message: "Failed to resolve runtime params for model 'model-fails'.",
          retryable: true,
          context: {
            endpoint: '/model/params',
            model_id: 'model-fails',
            error: 'params endpoint exploded',
          },
        },
      ])
      assert.deepEqual(response.excluded.ui_only_nodes.map((node) => node.label), [
        'Image',
        'Text',
        'Load 3D Mesh',
        'Add to Scene',
        'Artifact substitution',
      ])
    } finally {
      axios.get = originalGet
    }
  })
})

test('parseExtensionManifest preserves legacy process nodes without inputs[]', () => {
  const extension = parseExtensionManifest(
    {
      id: 'mesh-tools',
      displayName: 'Mesh Tools',
      type: 'process',
      entry: 'processor.js',
      nodes: [
        {
          id: 'optimize',
          name: 'Optimize Mesh',
          input: 'mesh',
          output: 'mesh',
          params_schema: [{ key: 'ratio', type: 'number' }],
        },
      ],
    },
    'mesh-tools',
    new Set(),
    true,
  )

  assert.equal(extension.type, 'process')
  assert.deepEqual(extension.nodes, [
    {
      id: 'optimize',
      name: 'Optimize Mesh',
      input: 'mesh',
      output: 'mesh',
      paramsSchema: [{ key: 'ratio', type: 'number' }],
      hfRepo: undefined,
      downloadCheck: undefined,
      hfSkipPrefixes: undefined,
      automation: DEFAULT_PROCESS_AUTOMATION,
    },
  ])
})

test('parseExtensionManifest normalizes optional process inputs[] with required=true by default', () => {
  const extension = parseExtensionManifest(
    {
      id: 'mesh-refiners',
      displayName: 'Mesh Refiners',
      type: 'process',
      entry: 'processor.js',
      nodes: [
        {
          id: 'refine',
          name: 'Refine Mesh',
          input: 'mesh',
          output: 'mesh',
          inputs: [
            { name: 'reference_image', type: 'image' },
            { name: 'coarse_mesh', type: 'mesh', required: false },
          ],
          params_schema: [{ key: 'strength', type: 'number' }],
        },
      ],
    },
    'mesh-refiners',
    new Set(),
    false,
  )

  assert.equal(extension.type, 'process')
  assert.deepEqual(extension.nodes[0], {
    id: 'refine',
    name: 'Refine Mesh',
    input: 'mesh',
    output: 'mesh',
    inputs: [
      { name: 'reference_image', type: 'image', required: true },
      { name: 'coarse_mesh', type: 'mesh', required: false },
    ],
    paramsSchema: [{ key: 'strength', type: 'number' }],
    hfRepo: undefined,
    downloadCheck: undefined,
    hfSkipPrefixes: undefined,
    automation: DEFAULT_PROCESS_AUTOMATION,
  })
})

test('buildAutomationCapabilities emits normalized inputs[] for process nodes without breaking legacy io', async () => {
  await withTempExtensions(async ({ builtinDir, userExtensionsDir }) => {
    await createProcessManifest(userExtensionsDir, 'mesh-refiners', {
      id: 'mesh-refiners',
      displayName: 'Mesh Refiners',
      version: '1.2.0',
      description: 'Refine mesh with multiple named inputs',
      source: 'acme/mesh-refiners',
      type: 'process',
      entry: 'processor.js',
      nodes: [
        {
          id: 'refine',
          name: 'Refine Mesh',
          input: 'mesh',
          output: 'mesh',
          inputs: [
            { name: 'reference_image', type: 'image' },
            { name: 'coarse_mesh', type: 'mesh', required: false },
          ],
          params_schema: [{ key: 'strength', type: 'number' }],
        },
      ],
    })

    const originalGet = axios.get
    axios.get = async (url) => {
      if (url.endsWith('/health')) return { data: { ok: true } }
      if (url.endsWith('/model/all')) return { data: [] }
      throw new Error(`Unexpected URL: ${url}`)
    }

    try {
      const response = await buildAutomationCapabilities({
        builtinDir,
        userExtensionsDir,
        trustedRepos: new Set(['acme/mesh-refiners']),
      })

      assert.equal(response.processes.length, 1)
      assert.deepEqual(response.processes[0], {
        kind: 'process',
        source: 'electron-manifest',
        id: 'mesh-refiners/refine',
        extension_id: 'mesh-refiners',
        node_id: 'refine',
        name: 'Refine Mesh',
        extension_name: 'Mesh Refiners',
        description: 'Refine mesh with multiple named inputs',
        version: '1.2.0',
        builtin: false,
        trusted: true,
        entry: 'processor.js',
        input: 'mesh',
        output: 'mesh',
        inputs: [
          { name: 'reference_image', type: 'image', required: true },
          { name: 'coarse_mesh', type: 'mesh', required: false },
        ],
        params_schema: [{ key: 'strength', type: 'number' }],
        automation: DEFAULT_PROCESS_AUTOMATION,
        ready: null,
      })
    } finally {
      axios.get = originalGet
    }
  })
})


test('parseExtensionManifest exposes allowlisted workflow utility nodes from manifests', () => {
  const extension = parseExtensionManifest({
    id: 'wan-video',
    displayName: 'Wan Video',
    type: 'model',
    nodes: [],
    workflow_nodes: [
      {
        id: 'preview-video',
        name: 'Preview Video',
        description: 'Preview generated video artifacts',
        component: 'video-preview',
        capability_id: 'modly.workflow.preview.video',
        singleton: true,
      },
      {
        id: 'unsafe-widget',
        name: 'Unsafe Widget',
        component: 'remote-js-bundle',
        input: 'video',
        output: 'video',
      },
    ],
  }, 'fallback', new Set(), false)

  assert.deepEqual(extension.workflowNodes, [
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
  ])
})

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const projectRoot = path.resolve(import.meta.dirname, '../../..')
const modelsPageEntry = path.join(projectRoot, 'src/areas/models/ModelsPage.tsx')

async function loadModelsPageModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-models-page-'))
  const outfile = path.join(tempDir, 'ModelsPage.bundle.mjs')

  await build({
    entryPoints: [modelsPageEntry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime', 'zustand'],
  })

  const module = await import(pathToFileURL(outfile).href)

  return {
    module,
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

async function renderStatusBanner(props: Record<string, unknown>) {
  const { module, cleanup } = await loadModelsPageModule()

  try {
    return renderToStaticMarkup(createElement(module.GitHubInstallStatusBanner, props))
  } finally {
    await cleanup()
  }
}

async function renderHelpCopy() {
  const { module, cleanup } = await loadModelsPageModule()

  try {
    return renderToStaticMarkup(createElement(module.GitHubRepoHelpCopy))
  } finally {
    await cleanup()
  }
}

test('ModelsPage shows bundle-aware success summary and root-or-bundle help copy', async () => {
  const bannerHtml = await renderStatusBanner({
    installResult: {
      success: true,
      status: 'success',
      installed: [
        { extensionId: 'bundle-model', extension: { id: 'bundle-model', type: 'model' }, status: 'success' },
        { extensionId: 'bundle-process', extension: { id: 'bundle-process', type: 'process' }, status: 'success' },
      ],
      failed: [],
      warnings: [],
      reloaded: true,
    },
    ghErr: null,
  })
  const helpHtml = await renderHelpCopy()

  assert.match(bannerHtml, /Installed 2 extensions from this repo\./)
  assert.match(bannerHtml, /2 of 2 children are ready\./)
  assert.match(helpHtml, /legacy root repo/i)
  assert.match(helpHtml, /extensions\/\*/i)
})

test('ModelsPage shows partial bundle summary with installed and failed child counts', async () => {
  const bannerHtml = await renderStatusBanner({
    installResult: {
      success: true,
      status: 'partial',
      installed: [
        { extensionId: 'bundle-process', extension: { id: 'bundle-process', type: 'process' }, status: 'success' },
      ],
      failed: [
        { extensionId: 'broken-model', stage: 'setup', error: 'setup failed' },
        { extensionId: 'broken-process', stage: 'npm', error: 'npm install failed' },
      ],
      warnings: ['broken-model: setup failed', 'broken-process: npm install failed'],
      reloaded: true,
      error: '2 children failed',
    },
    ghErr: null,
  })

  assert.match(bannerHtml, /Installed 1 of 3 extensions from this repo\./)
  assert.match(bannerHtml, /2 children failed\./)
  assert.match(bannerHtml, /broken-model/i)
})

test('ModelsPage keeps atomic install errors global and explicit', async () => {
  const bannerHtml = await renderStatusBanner({
    installResult: {
      success: false,
      status: 'error',
      installed: [],
      failed: [],
      warnings: [],
      reloaded: false,
      error: 'Missing generator.py in extensions/broken-model',
    },
    ghErr: 'Missing generator.py in extensions/broken-model',
  })

  assert.match(bannerHtml, /Installation failed before any extension was added\./)
  assert.match(bannerHtml, /Missing generator\.py in extensions\/broken-model/)
})

test('ModelsPage routes structured asset plans to their owned endpoints and preserves legacy HF downloads', async () => {
  const { module, cleanup } = await loadModelsPageModule()
  try {
    const calls: string[] = []
    const modelApi = {
      download: async (repoId: string, modelId: string) => {
        calls.push(`legacy:${repoId}:${modelId}`)
        return { success: true }
      },
      downloadAssets: async (modelId: string) => {
        calls.push(`assets:${modelId}`)
        return { success: true }
      },
      downloadSources: async (modelId: string) => {
        calls.push(`sources:${modelId}`)
        return { success: true }
      },
      downloadHttpsAssets: async (modelId: string) => {
        calls.push(`https-assets:${modelId}`)
        return { success: true }
      },
    }

    await module.requestModelNodeDownload({
      id: 'generate',
      name: 'Generate',
      input: 'none',
      output: 'scene',
      paramsSchema: [],
      hfRepo: 'owner/must-not-fallback',
      httpsDownloads: [{
        url: 'https://example.com/gaussiangpt.safetensors',
        filename: 'gaussiangpt.safetensors',
        sizeBytes: 42,
        sha256: 'a'.repeat(64),
      }],
    }, 'gaussiangpt/generate', modelApi)

    await module.requestModelNodeDownload({
      id: 'generate',
      name: 'Generate',
      input: 'text',
      output: 'mesh',
      paramsSchema: [],
      hfRepo: 'owner/legacy',
      hfDownloads: [{
        repoId: 'owner/model',
        revision: 'ef15eda2e413f994e3b4657960b0309487587718',
        targetSubdir: 'cube3d',
        files: [{ path: 'model.pt' }],
      }],
    }, 'cube3d/generate', modelApi)

    await module.requestModelNodeDownload({
      id: 'legacy',
      name: 'Legacy',
      input: 'image',
      output: 'mesh',
      paramsSchema: [],
      hfRepo: 'owner/legacy',
    }, 'legacy/generate', modelApi)

    await module.requestModelNodeDownload({
      id: 'generate',
      name: 'Generate',
      input: 'image',
      output: 'mesh',
      paramsSchema: [],
      hasModelSources: true,
    }, 'pixal3d/generate', modelApi)

    assert.deepEqual(calls, [
      'https-assets:gaussiangpt/generate',
      'assets:cube3d/generate',
      'legacy:owner/legacy:legacy/generate',
      'sources:pixal3d/generate',
    ])
  } finally {
    await cleanup()
  }
})

test('ModelsPage prunes persisted failures when the model is gone or no longer downloadable', async () => {
  const { module, cleanup } = await loadModelsPageModule()
  try {
    const failures = {
      'keep/generate': {
        code: 'hash_mismatch',
        stage: 'verify',
        message: 'keep me',
        retryable: true,
      },
      'drop/generate': {
        code: 'download_failed',
        stage: 'download',
        message: 'drop me',
        retryable: true,
      },
    }
    const extensions = [{
      type: 'model',
      id: 'keep',
      name: 'Keep',
      trusted: true,
      builtin: false,
      nodes: [{
        id: 'generate',
        name: 'Generate',
        input: 'none',
        output: 'mesh',
        paramsSchema: [],
        hfRepo: 'owner/model',
        capabilityId: 'keep/generate',
      }],
    }]

    assert.deepEqual(module.pruneStaleDownloadFailures(failures, extensions), {
      'keep/generate': failures['keep/generate'],
    })
  } finally {
    await cleanup()
  }
})

test('ModelsPage fails closed for malformed persisted failure metadata', async () => {
  const { module, cleanup } = await loadModelsPageModule()
  try {
    assert.equal(module.isValidModelDownloadFailure({ retryable: true }), false)
    assert.equal(module.isValidModelDownloadFailure({
      code: 'download_failed', stage: 'download', message: 'failed', retryable: true, file: 7,
    }), false)
    assert.equal(module.isValidModelDownloadFailure({
      code: 'download_failed', stage: 'download', message: 'failed', retryable: true, file: 'weights/model.bin',
    }), true)
    assert.equal(module.isRetryableModelDownloadFailure({
      code: 'download_failed',
      stage: 'request',
      message: 'temporary failure',
      retryable: true,
    }), true)
    assert.equal(module.isRetryableModelDownloadFailure({
      code: 'download_failed',
      stage: 'request',
      message: 'missing retryability',
    }), false)
  } finally {
    await cleanup()
  }
})

test('ModelsPage runtime readiness dispatcher uses the validated Electron action path only after explicit dispatch', async () => {
  const { module, cleanup } = await loadModelsPageModule()
  try {
    const calls: string[] = []
    const action = {
      id: 'docs',
      kind: 'open_external_url',
      label: 'Open docs',
      docs_url: 'https://developers.openai.com/codex/cli',
      requires_confirmation: true,
      safety: 'confirm',
    }
    const handler = module.createRuntimeReadinessActionDispatcher({
      runRuntimeReadinessAction: async (modelId: string, receivedAction: unknown, options: { dispatch: (a: unknown) => Promise<{ success: boolean }> }) => {
        calls.push(`store:${modelId}:${(receivedAction as { id: string }).id}`)
        const result = await options.dispatch(receivedAction)
        calls.push(`result:${result.success}`)
        return result
      },
      electronRuntimeReadinessAction: async (receivedAction: unknown) => {
        calls.push(`electron:${(receivedAction as { id: string }).id}`)
        return { success: true }
      },
    })

    assert.deepEqual(calls, [])
    const result = await handler('modly-codex-image-extension/text-to-image', action)

    assert.deepEqual(calls, [
      'store:modly-codex-image-extension/text-to-image:docs',
      'electron:docs',
      'result:true',
    ])
    assert.deepEqual(result, { success: true })
  } finally {
    await cleanup()
  }
})


test('ModelsPage uses the declared window.electron model API at the download call site', async () => {
  const source = await readFile(modelsPageEntry, 'utf8')

  assert.match(source, /requestModelNodeDownload\([\s\S]*window\.electron\.model/)
  assert.doesNotMatch(source, /window\.electronAPI/)
})

test('ModelsPage treats cancelled download progress as neutral cleanup', async () => {
  const source = await readFile(modelsPageEntry, 'utf8')

  assert.match(source, /cancelled,[\s\S]*?\}\) => \{[\s\S]*?if \(cancelled\) \{[\s\S]*?delete next\[id\]/)
  assert.match(source, /percent: percent \?\? prev\[id\]\?\.percent \?\? 0/)
  assert.match(source, /\.\.\.\(paused !== undefined \? \{ paused \} : \{\}\)/)
})


test('ModelsPage Install All de-duplicates shared owners without dropping distinct owner assets', async () => {
  const { module, cleanup } = await loadModelsPageModule()
  try {
    const queue = module.buildInstallAllQueue([
      {
        fullId: 'bundle/sd15',
        weightOwnerId: 'bundle/shared-base',
        node: { id: 'sd15', name: 'SD 1.5', input: 'image', output: 'mesh', paramsSchema: [], hfRepo: 'acme/sd15' },
      },
      {
        fullId: 'bundle/sdxl-base',
        weightOwnerId: 'bundle/shared-base',
        node: { id: 'sdxl-base', name: 'SDXL Base', input: 'image', output: 'mesh', paramsSchema: [], hfRepo: 'acme/sdxl-base' },
      },
      {
        fullId: 'bundle/flux',
        weightOwnerId: 'bundle/flux',
        node: { id: 'flux', name: 'Flux', input: 'image', output: 'mesh', paramsSchema: [], hfRepo: 'acme/flux' },
      },
      {
        fullId: 'bundle/ready',
        weightOwnerId: 'bundle/ready',
        node: { id: 'ready', name: 'Ready', input: 'image', output: 'mesh', paramsSchema: [], hfRepo: 'acme/ready' },
      },
    ], ['bundle/ready'], { 'bundle/sdxl-base': { percent: 12 } })

    assert.deepEqual(queue.map((entry: { fullId: string }) => entry.fullId), [
      'bundle/flux',
    ])
  } finally {
    await cleanup()
  }
})

test('ModelsPage Install All queues distinct plans for the same owner sequentially', async () => {
  const { module, cleanup } = await loadModelsPageModule()
  try {
    const queue = module.buildInstallAllQueue([
      {
        fullId: 'bundle/front',
        weightOwnerId: 'bundle/shared-base',
        node: { id: 'front', name: 'Front', input: 'image', output: 'mesh', paramsSchema: [], hfRepo: 'acme/front' },
      },
      {
        fullId: 'bundle/back',
        weightOwnerId: 'bundle/shared-base',
        node: { id: 'back', name: 'Back', input: 'image', output: 'mesh', paramsSchema: [], hfRepo: 'acme/back' },
      },
      {
        fullId: 'bundle/front-alias',
        weightOwnerId: 'bundle/shared-base',
        node: { id: 'front-alias', name: 'Front alias', input: 'image', output: 'mesh', paramsSchema: [], hfRepo: 'acme/front' },
      },
    ], [], {})

    assert.deepEqual(queue.map((entry: { fullId: string }) => entry.fullId), [
      'bundle/front',
      'bundle/back',
    ])
  } finally {
    await cleanup()
  }
})

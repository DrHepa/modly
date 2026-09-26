import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import type { DownloadMap } from './components/extensionShared'

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

  assert.match(bannerHtml, /No extensions completed installation\./)
  assert.match(bannerHtml, /Missing generator\.py in extensions\/broken-model/)
})

test('ModelsPage surfaces registration warnings even when no child setup failed', async () => {
  const html = await renderStatusBanner({
    installResult: { success: true, status: 'partial', installed: [{ extensionId: 'processor' }], failed: [], warnings: ['Backend reload unavailable'], reloaded: false },
    ghErr: null,
  })
  assert.match(html, /Backend reload unavailable/)
  assert.doesNotMatch(html, /0 children failed/)
})

// Exercise the page's real async handler, not a duplicate success predicate.
// The AST assertion binds the form state to the actual banner visibility gate.
async function runGitHubPageHandler(result: Record<string, unknown>) {
  const source = await readFile(modelsPageEntry, 'utf8')
  const tree = ts.createSourceFile(modelsPageEntry, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const handlers: ts.FunctionDeclaration[] = []
  let bannerInsideForm = false
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'handleGHInstall') handlers.push(node)
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === 'GitHubInstallStatusBanner') {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (ts.isBinaryExpression(parent)
            && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
            && parent.left.getText(tree) === 'showGHForm') bannerInsideForm = true
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.equal(handlers.length, 1, 'The exact page install handler must exist')
  assert.equal(bannerInsideForm, true, 'The actual banner is controlled by form visibility')

  const state = {
    showGHForm: true,
    ghUrl: ' https://github.com/acme/bundle ',
    ghErr: null as string | null,
    installResult: null as Record<string, unknown> | null,
    requestedUrls: [] as string[],
  }
  const invoke = new Function(
    'ghUrl', 'setGhErr', 'clearInstall', 'installFromGH', 'setShowGHForm', 'setGhUrl',
    ts.transpileModule(`return (${handlers[0].getText(tree)})();`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText,
  )
  await invoke(
    state.ghUrl,
    (error: string | null) => { state.ghErr = error },
    () => { state.installResult = null },
    async (url: string) => { state.requestedUrls.push(url); state.installResult = result; return result },
    (visible: boolean) => { state.showGHForm = visible },
    (url: string) => { state.ghUrl = url },
  )
  assert.deepEqual(state.requestedUrls, ['https://github.com/acme/bundle'])
  assert.equal(state.installResult, result, 'The result must survive after the request completes')
  return state
}

test('ModelsPage actual install handler preserves form, URL and mixed partial outcome', async () => {
  const result = {
    success: true, status: 'partial', installed: [{ extensionId: 'healthy' }],
    failed: [{ extensionId: 'broken', stage: 'setup', error: 'setup failed' }], warnings: [], reloaded: true,
  }
  const state = await runGitHubPageHandler(result)
  assert.equal(state.showGHForm, true)
  assert.equal(state.ghUrl, ' https://github.com/acme/bundle ')
  assert.equal(state.ghErr, null)
  assert.match(await renderStatusBanner({ installResult: state.installResult, ghErr: state.ghErr }), /broken: setup failed/)
})

test('ModelsPage actual install handler preserves warnings-only partial outcome for an offline backend', async () => {
  const result = {
    success: true, status: 'partial', installed: [{ extensionId: 'js-process' }], failed: [],
    warnings: ['Extension reload failed: backend unavailable'], reloaded: false,
  }
  const state = await runGitHubPageHandler(result)
  assert.equal(state.showGHForm, true)
  assert.equal(state.ghUrl, ' https://github.com/acme/bundle ')
  assert.equal(state.ghErr, null)
  assert.match(await renderStatusBanner({ installResult: state.installResult, ghErr: state.ghErr }), /backend unavailable/)
})

test('ModelsPage actual install handler closes and clears the URL on complete success', async () => {
  const state = await runGitHubPageHandler({ success: true, status: 'success', installed: [{ extensionId: 'healthy' }], failed: [], warnings: [], reloaded: true })
  assert.equal(state.showGHForm, false)
  assert.equal(state.ghUrl, '')
  assert.equal(state.ghErr, null)
})

test('ModelsPage actual install handler retains legacy plain-success closing behavior', async () => {
  const state = await runGitHubPageHandler({ success: true })
  assert.equal(state.showGHForm, false)
  assert.equal(state.ghUrl, '')
  assert.equal(state.ghErr, null)
})

test('ModelsPage actual install handler keeps complete failure visible with the original URL', async () => {
  const state = await runGitHubPageHandler({ success: false, status: 'error', error: 'setup failed' })
  assert.equal(state.showGHForm, true)
  assert.equal(state.ghUrl, ' https://github.com/acme/bundle ')
  assert.equal(state.ghErr, 'setup failed')
})

test('ModelsPage routes structured asset plans to their owned endpoints and preserves legacy HF downloads', async () => {
  const { module, cleanup } = await loadModelsPageModule()
  try {
    const calls: string[] = []
    const modelApi = {
      download: async (modelId: string, variantId?: string) => {
        calls.push(`legacy:${modelId}:${variantId ?? 'default'}`)
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
      'legacy:legacy/generate:default',
      'legacy:pixal3d/generate:default',
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


test('ModelsPage preserves model-owned source, shared group and variant download identities', async () => {
  const { module, cleanup } = await loadModelsPageModule()
  try {
    const calls: unknown[][] = []
    const modelApi = {
      download: async (...args: unknown[]) => { calls.push(args); return { success: true } },
      downloadAssets: async () => { throw new Error('Upstream sources are not pinned asset plans') },
      downloadHttpsAssets: async () => { throw new Error('Upstream sources are not HTTPS asset plans') },
    }
    const node = { id: 'generate', name: 'Generate', input: 'image', output: 'mesh', paramsSchema: [] }
    await module.requestModelNodeDownload({ ...node, hasModelSources: true }, 'sources/generate', modelApi)
    await module.requestModelNodeDownload({ ...node, weightGroups: ['base'] }, 'groups/generate', modelApi)
    await module.requestModelNodeDownload({ ...node, hfRepo: 'owner/repo' }, 'variants/generate', modelApi, 'small')
    assert.deepEqual(calls, [
      ['sources/generate', undefined], ['groups/generate', undefined], ['variants/generate', 'small'],
    ])
  } finally {
    await cleanup()
  }
})

test('ModelsPage actual pause handler preserves later progress and Resume after failed or rejected IPC', async () => {
  const source = await readFile(modelsPageEntry, 'utf8')
  const tree = ts.createSourceFile(modelsPageEntry, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const declarations = new Map<string, ts.FunctionDeclaration>()
  const progressCallbacks: ts.ArrowFunction[] = []
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node)
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'window.electron.model.onProgress') {
      assert.equal(node.arguments.length, 1)
      assert.ok(ts.isArrowFunction(node.arguments[0]), 'Use the actual registered progress callback')
      progressCallbacks.push(node.arguments[0] as ts.ArrowFunction)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.ok(declarations.has('handlePauseDownload'))
  assert.ok(declarations.has('hasDownloadControls'))
  assert.equal(progressCallbacks.length, 1)
  const emit = (text: string) => ts.transpileModule(text, {
    fileName: 'actual-owner.tsx',
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
  }).outputText
  const makePause = new Function('window', 'downloading', 'setDownloading', 'setGhErr', emit(
    `${declarations.get('hasDownloadControls')!.getText(tree)}\nreturn (${declarations.get('handlePauseDownload')!.getText(tree)});`,
  ))
  const makeProgress = new Function('setDownloading', 'setDownloadFailures', 'useExtensionsStore', 'refreshInstalledIds', emit(
    `return (${progressCallbacks[0].getText(tree)});`,
  ))

  // Render the real consumer, not a duplicate paused-to-Resume predicate.
  const controlsEntry = path.join(projectRoot, 'src/areas/models/components/extensionShared.tsx')
  const controlsSource = await readFile(controlsEntry, 'utf8')
  const controlsTree = ts.createSourceFile(controlsEntry, controlsSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const control = controlsTree.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'NodeInstallControl')
  assert.ok(control)
  const NodeInstallControl = new Function('React', emit(
    `return (${control.getText(controlsTree).replace(/^export\s+/, '')});`,
  ))({ createElement })

  const fullId = 'pause-owner/generate'
  const events = [
    undefined,
    { percent: 0, status: 'paused', paused: true },
    { percent: 41, status: 'downloading', paused: false },
    { percent: 42, status: 'Pausing…', paused: true },
    { percent: 100, status: 'done', paused: false },
    { percent: 0, status: 'cancelled', cancelled: true },
  ]
  for (const event of events) for (const outcome of ['failure', 'throw'] as const) {
    const original = { percent: 37, status: 'receiving', file: 'weights.bin', bytesDownloaded: 370, totalBytes: 1000, variantId: 'small' }
    let downloading: DownloadMap = { [fullId]: original }
    const errors: string[] = []
    const requestedIds: string[] = []
    let resolve!: (result: { success: boolean; error?: string }) => void
    let reject!: (error: Error) => void
    const response = new Promise<{ success: boolean; error?: string }>((done, fail) => { resolve = done; reject = fail })
    const setDownloading = (update: (previous: DownloadMap) => DownloadMap) => { downloading = update(downloading) }
    const pause = makePause({ electron: { model: {
      pauseDownload: (id: string) => { requestedIds.push(id); return response },
      cancelDownload: async () => ({ success: true }),
    } } }, downloading, setDownloading, (error: string) => { errors.push(error) })
    const progress = makeProgress(setDownloading, () => {}, { getState: () => ({ modelExtensions: [{
      id: 'pause-owner', nodes: [{ id: 'generate', capabilityId: fullId, hfRepo: 'owner/repo' }],
    }] }) }, async () => {})

    const pending = pause(fullId)
    assert.deepEqual(requestedIds, [fullId])
    assert.equal(downloading[fullId].paused, true)
    assert.equal(downloading[fullId].status, 'Pausing…')
    if (event) progress({ capabilityId: fullId, modelId: fullId, variantId: 'small', ...event })
    await Promise.resolve() // Let the actual completion callback remove its finished entry.
    const physicalRecord = downloading[fullId]
    if (outcome === 'throw') reject(new Error('pause IPC rejected'))
    else resolve({ success: false, error: 'pause IPC failed' })
    await pending

    assert.equal(errors.length, 1)
    assert.match(errors[0], /pause IPC/)
    if (!event) {
      assert.equal(downloading[fullId], original, 'No later event: restore the exact prior object and optional fields')
      assert.equal(Object.hasOwn(downloading[fullId], 'paused'), false)
    } else {
      assert.equal(downloading[fullId], physicalRecord, 'A later progress record or removal must win over a late IPC failure')
      if (event.percent === 100 || 'cancelled' in event) assert.equal(downloading[fullId], undefined)
      if (event.paused) {
        const html = renderToStaticMarkup(createElement(NodeInstallControl, {
          state: { kind: 'downloading', dl: downloading[fullId] },
          onInstall: () => {}, onPause: () => {}, onResume: () => {}, onCancel: () => {},
        }))
        assert.match(html, /title="Resume download"/)
        assert.doesNotMatch(html, /title="Pause download"/)
      }
    }
  }
})

test('ModelsPage treats cancelled download progress as neutral cleanup', async () => {
  const source = await readFile(modelsPageEntry, 'utf8')

  assert.match(source, /if \(cancelled\)[\s\S]*?delete n\[id\]/)
  assert.match(source, /percent: paused \? \(current\?\.percent \?\? percent\) : percent/)
  assert.match(source, /stalledSeconds: stalledSeconds \?\? current\?\.stalledSeconds,[\s\S]*paused,/)
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

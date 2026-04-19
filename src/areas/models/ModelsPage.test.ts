import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

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

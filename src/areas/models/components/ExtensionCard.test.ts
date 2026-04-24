import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RuntimeReadiness } from '../../../shared/types/electron.d'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const extensionCardEntry = path.join(projectRoot, 'src/areas/models/components/ExtensionCard.tsx')

async function loadExtensionCardModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-extension-card-'))
  const outfile = path.join(tempDir, 'ExtensionCard.bundle.mjs')

  await build({
    entryPoints: [extensionCardEntry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    external: ['react', 'react/jsx-runtime'],
  })

  const module = await import(pathToFileURL(outfile).href)

  return {
    module,
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

function createReadiness(machine_code: string, label_hint?: RuntimeReadiness['label_hint'], ok = false): RuntimeReadiness {
  return {
    ok,
    machine_code,
    ...(label_hint ? { label_hint } : {}),
    checked_at: '2026-04-24T00:00:00.000Z',
  }
}

async function renderCard(runtimeReadinessById: Record<string, RuntimeReadiness | undefined>, hfRepo?: string) {
  const { module, cleanup } = await loadExtensionCardModule()
  try {
    return renderToStaticMarkup(createElement(module.ExtensionCard, {
      ext: {
        type: 'model',
        id: 'modly-codex-image-extension',
        name: 'Codex',
        trusted: true,
        builtin: true,
        nodes: [
          {
            id: 'text-to-image',
            name: 'Text to Image',
            input: 'text',
            output: 'image',
            paramsSchema: [],
            ...(hfRepo ? { hfRepo } : {}),
          },
        ],
      },
      installedIds: [],
      downloading: {},
      runtimeReadinessById,
      onInstall: () => undefined,
      onUninstall: () => undefined,
    }))
  } finally {
    await cleanup()
  }
}

test('ExtensionCard maps runtime readiness to Codex iteration-one labels', async () => {
  const cases: Array<[RuntimeReadiness, string]> = [
    [createReadiness('preflight/codex_missing', 'Setup Codex'), 'Setup Codex'],
    [createReadiness('preflight/not_authenticated', 'Login'), 'Login'],
    [createReadiness('preflight/unsupported_version', 'Update Codex'), 'Update Codex'],
    [createReadiness('ready', 'Ready', true), 'Ready'],
  ]

  for (const [readiness, expectedLabel] of cases) {
    const html = await renderCard({ 'modly-codex-image-extension/text-to-image': readiness })
    assert.match(html, new RegExp(`>${expectedLabel}<`))
  }
})

test('ExtensionCard preserves no-HF and HF download behavior when readiness is absent', async () => {
  const noHfHtml = await renderCard({})
  assert.match(noHfHtml, />Ready</)
  assert.doesNotMatch(noHfHtml, />Setup Codex</)

  const hfHtml = await renderCard({}, 'acme/model-weights')
  assert.match(hfHtml, />Download</)
  assert.doesNotMatch(hfHtml, />Ready</)
})

test('ExtensionCard treats unsupported runtime readiness as absent for legacy no-HF and HF nodes', async () => {
  const unsupported = createReadiness('unsupported_contract', 'Checking failed')

  const noHfHtml = await renderCard({ 'modly-codex-image-extension/text-to-image': unsupported })
  assert.match(noHfHtml, />Ready</)
  assert.doesNotMatch(noHfHtml, />Checking failed</)

  const hfHtml = await renderCard({ 'modly-codex-image-extension/text-to-image': unsupported }, 'acme/model-weights')
  assert.match(hfHtml, />Download</)
  assert.doesNotMatch(hfHtml, />Checking failed</)
})

test('ExtensionCard shows non-blocking checking-failed readiness without starting install flows', async () => {
  const html = await renderCard({
    'modly-codex-image-extension/text-to-image': createReadiness('checking_failed', 'Checking failed'),
  })

  assert.match(html, />Checking failed</)
  assert.doesNotMatch(html, />Download</)
})

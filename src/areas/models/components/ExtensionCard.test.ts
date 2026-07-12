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

function createActionReadiness(): RuntimeReadiness {
  return {
    ...createReadiness('preflight/codex_missing', 'Setup Codex'),
    actions: [
      {
        id: 'setup-guidance',
        kind: 'show_guidance',
        label: 'Setup Codex',
        guidance: 'Install Codex manually from official docs, then refresh readiness.',
        safety: 'manual',
      },
      {
        id: 'setup-docs',
        kind: 'open_external_url',
        label: 'Open docs',
        docs_url: 'https://developers.openai.com/codex/cli',
        safety: 'confirm',
        requires_confirmation: true,
        confirmation: {
          title: 'Open Codex docs?',
          body: 'This opens official Codex documentation in your browser.',
          confirm_label: 'Open docs',
        },
      },
      {
        id: 'runtime-details',
        kind: 'show_details',
        label: 'Details',
        safety: 'manual',
      },
      {
        id: 'refresh',
        kind: 'refresh_readiness',
        label: 'Refresh',
        safety: 'non_destructive',
      },
    ],
    details: {
      title: 'Codex runtime details',
      summary: 'Codex is not available on PATH.',
      diagnostics: {
        runtime_source: 'missing',
        platform_key: 'linux-x64',
      },
      guidance: 'Modly does not install Codex silently.',
    },
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

test('ExtensionCard treats HTTPS plans as owned assets without optimistic installed-id fallback', async () => {
  const { module, cleanup } = await loadExtensionCardModule()
  try {
    const html = renderToStaticMarkup(createElement(module.ExtensionCard, {
      ext: {
        type: 'model',
        id: 'gaussiangpt',
        name: 'GaussianGPT',
        trusted: false,
        builtin: false,
        nodes: [{
          id: 'generate',
          name: 'Generate',
          input: 'none',
          output: 'scene',
          paramsSchema: [],
          httpsDownloads: [{
            url: 'https://example.com/gaussiangpt.safetensors',
            filename: 'gaussiangpt.safetensors',
            sizeBytes: 42,
            sha256: 'a'.repeat(64),
          }],
        }],
      },
      installedIds: ['gaussiangpt/generate'],
      downloading: {},
      onInstall: () => undefined,
      onUninstall: () => undefined,
    }))

    assert.match(html, />Download</)
    assert.doesNotMatch(html, />Ready</)
  } finally {
    await cleanup()
  }
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

test('ExtensionCard treats checking-failed readiness as non-blocking for functional no-HF nodes', async () => {
  const html = await renderCard({
    'modly-codex-image-extension/text-to-image': createReadiness('checking_failed', 'Checking failed'),
  })

  assert.match(html, />Ready</)
  assert.doesNotMatch(html, />Checking failed</)
  assert.doesNotMatch(html, />Download</)
})

test('ExtensionCard keeps weight downloads available when runtime readiness checking fails before weights are installed', async () => {
  const html = await renderCard({
    'modly-codex-image-extension/text-to-image': createReadiness('checking_failed', 'Checking failed'),
  }, 'acme/model-weights')

  assert.match(html, />Download</)
  assert.doesNotMatch(html, />Checking failed</)
})

test('ExtensionCard keeps downloaded model nodes ready when runtime readiness checking fails', async () => {
  const { module, cleanup } = await loadExtensionCardModule()
  try {
    const html = renderToStaticMarkup(createElement(module.ExtensionCard, {
      ext: {
        type: 'model',
        id: 'modly-codex-image-extension',
        name: 'Codex',
        trusted: true,
        builtin: true,
        nodes: [{
          id: 'text-to-image',
          name: 'Text to Image',
          input: 'text',
          output: 'image',
          paramsSchema: [],
          hfRepo: 'acme/model-weights',
        }],
      },
      installedIds: [],
      downloading: {},
      ownershipStateById: {
        'modly-codex-image-extension/text-to-image': {
          capabilityId: 'modly-codex-image-extension/text-to-image',
          bundleId: 'modly-codex-image-extension',
          weightOwnerId: 'modly-codex-image-extension/text-to-image',
          legacyPaths: ['modly-codex-image-extension/text-to-image'],
          downloaded: true,
          isOwnerDownloading: false,
          installDisabled: true,
          deleteDisabled: false,
          ownerPeerCapabilityIds: [],
          badges: [],
          warning: null,
        },
      },
      runtimeReadinessById: {
        'modly-codex-image-extension/text-to-image': createReadiness('checking_failed', 'Checking failed'),
      },
      onInstall: () => undefined,
      onUninstall: () => undefined,
    }))

    assert.match(html, />Text to Image</)
    assert.doesNotMatch(html, />Checking failed</)
    assert.doesNotMatch(html, />Download</)
  } finally {
    await cleanup()
  }
})

test('ExtensionCard shows persisted structured asset failure with retry for hf_downloads nodes', async () => {
  const { module, cleanup } = await loadExtensionCardModule()
  try {
    const html = renderToStaticMarkup(createElement(module.ExtensionCard, {
      ext: {
        type: 'model',
        id: 'cube3d',
        name: 'Cube3D',
        trusted: false,
        builtin: false,
        nodes: [{
          id: 'generate',
          name: 'Generate',
          input: 'text',
          output: 'mesh',
          paramsSchema: [],
          hfDownloads: [{
            repoId: 'owner/model',
            revision: 'ef15eda2e413f994e3b4657960b0309487587718',
            targetSubdir: 'cube3d',
            files: [{ path: 'model.pt' }],
          }],
        }],
      },
      installedIds: [],
      downloading: {},
      downloadFailures: {
        'cube3d/generate': {
          code: 'hash_mismatch',
          stage: 'verify',
          message: 'Downloaded file failed verification',
          file: 'cube3d/model.pt',
          retryable: true,
        },
      },
      onInstall: () => undefined,
      onUninstall: () => undefined,
    }))

    assert.match(html, />Retry</)
    assert.match(html, /verify: Downloaded file failed verification/)
    assert.match(html, /cube3d\/model\.pt/)
    assert.doesNotMatch(html, />Ready</)
  } finally {
    await cleanup()
  }
})

test('ExtensionCard static markup renders readiness label and actions without inline details diagnostics', async () => {
  const html = await renderCard({
    'modly-codex-image-extension/text-to-image': createActionReadiness(),
  })

  assert.match(html, />Setup Codex</)
  assert.match(html, /<button[^>]*>Open docs<\/button>/)
  assert.match(html, /<button[^>]*>Refresh<\/button>/)
  assert.doesNotMatch(html, /<button[^>]*>Setup Codex<\/button>/)
  assert.doesNotMatch(html, /<button[^>]*>Details<\/button>/)
  assert.doesNotMatch(html, /Codex runtime details/)
  assert.doesNotMatch(html, /Codex is not available on PATH\./)
  assert.doesNotMatch(html, /Modly does not install Codex silently\./)
  assert.doesNotMatch(html, /runtime_source/)
  assert.doesNotMatch(html, /platform_key/)
  assert.doesNotMatch(html, /linux-x64/)
})

test('ExtensionCard action planner requires explicit user intent before dispatching readiness actions', async () => {
  const { module, cleanup } = await loadExtensionCardModule()
  try {
    assert.equal(module.resolveRuntimeReadinessActionIntent({
      id: 'guide',
      kind: 'show_guidance',
      label: 'Setup Codex',
      guidance: 'Manual setup guidance',
      safety: 'manual',
    }), 'show_modal')
    assert.equal(module.resolveRuntimeReadinessActionIntent({
      id: 'details',
      kind: 'show_details',
      label: 'Details',
      safety: 'manual',
    }), 'show_modal')
    assert.equal(module.resolveRuntimeReadinessActionIntent({
      id: 'docs',
      kind: 'open_external_url',
      label: 'Open docs',
      docs_url: 'https://developers.openai.com/codex/cli',
      requires_confirmation: true,
      safety: 'confirm',
    }), 'confirm_then_dispatch')
    assert.equal(module.resolveRuntimeReadinessActionIntent({
      id: 'refresh',
      kind: 'refresh_readiness',
      label: 'Refresh',
      safety: 'non_destructive',
    }), 'dispatch')
    assert.equal(module.resolveRuntimeReadinessActionIntent({
      id: 'unsupported',
      kind: 'show_details',
      label: 'Unsupported',
      disabled: true,
      reason: 'This platform is unsupported.',
      safety: 'manual',
    }), 'disabled')
  } finally {
    await cleanup()
  }
})

test('ExtensionCard filters readiness diagnostics to safe display fields only', async () => {
  const { module, cleanup } = await loadExtensionCardModule()
  try {
    const filtered = module.filterRuntimeReadinessDetailsForDisplay({
      title: 'Details',
      summary: 'Safe summary',
      diagnostics: {
        runtime_version: '0.122.0',
        supported_versions: '0.122.0',
        raw_command_output: 'SECRET_TOKEN=abc /home/user/.codex',
        runtime_source: '/home/user/bin/codex',
        api_key: 'sk-secret',
      },
      evidence: {
        auth_state: 'authenticated',
        extension_import_state: 'imported',
        command_output: 'raw output should not render',
      },
      guidance: 'Safe manual guidance',
    })

    assert.deepEqual(filtered.diagnostics, {
      runtime_version: '0.122.0',
      supported_versions: '0.122.0',
    })
    assert.deepEqual(filtered.evidence, {
      auth_state: 'authenticated',
      extension_import_state: 'imported',
    })
  } finally {
    await cleanup()
  }
})

test('ExtensionCard renders disabled readiness actions but not full readiness details inline', async () => {
  const html = await renderCard({
    'modly-codex-image-extension/text-to-image': {
      ...createReadiness('preflight/unsupported_platform', 'Unsupported'),
      actions: [
        {
          id: 'unsupported',
          kind: 'show_details',
          label: 'Unsupported',
          disabled: true,
          reason: 'This platform is unsupported.',
          safety: 'manual',
        },
      ],
      details: {
        title: 'Unsupported platform',
        diagnostics: {
          platform_supported: 'false',
          platform_key: 'linux-arm64',
          runtime_source: '/home/user/bin/codex',
        },
      },
    },
  })

  assert.match(html, />Unsupported</)
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Unsupported<\/button>/)
  assert.doesNotMatch(html, /This platform is unsupported\./)
  assert.doesNotMatch(html, /Unsupported platform/)
  assert.doesNotMatch(html, /platform_supported/)
  assert.doesNotMatch(html, /linux-arm64/)
  assert.doesNotMatch(html, /\/home\/user\/bin\/codex/)
})

test('ExtensionCard preserves permanent download failures without rendering a Retry action', async () => {
  const { module, cleanup } = await loadExtensionCardModule()
  try {
    const html = renderToStaticMarkup(createElement(module.ExtensionCard, {
      ext: {
        type: 'model',
        id: 'cube3d',
        name: 'Cube3D',
        trusted: false,
        builtin: false,
        nodes: [{
          id: 'generate',
          name: 'Generate',
          input: 'text',
          output: 'mesh',
          paramsSchema: [],
          hfDownloads: [{
            repoId: 'owner/model',
            revision: 'ef15eda2e413f994e3b4657960b0309487587718',
            targetSubdir: 'cube3d',
            files: [{ path: 'model.pt' }],
          }],
        }],
      },
      installedIds: [],
      downloading: {},
      downloadFailures: {
        'cube3d/generate': {
          code: 'invalid_manifest',
          stage: 'manifest',
          message: 'Model manifest is permanently invalid',
          retryable: false,
        },
      },
      onInstall: () => {
        throw new Error('permanent failures must not dispatch install')
      },
      onUninstall: () => undefined,
    }))

    assert.match(html, /manifest: Model manifest is permanently invalid/)
    assert.match(html, />Download unavailable</)
    assert.doesNotMatch(html, />Retry</)
    assert.doesNotMatch(html, /Download cube3d|Download Generate weights/)
  } finally {
    await cleanup()
  }
})

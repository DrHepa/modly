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

async function renderCard(runtimeReadinessById: Record<string, RuntimeReadiness | undefined>, hfRepo?: string, nodePatch: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
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
            ...nodePatch,
          },
        ],
      },
      installedIds: [],
      downloading: {},
      runtimeReadinessById,
      onInstall: () => undefined,
      onInstallAll: () => undefined,
      onPauseDownload: () => undefined,
      onCancelDownload: () => undefined,
      onOpen: () => undefined,
      ...props,
    }))
  } finally {
    await cleanup()
  }
}

test('ExtensionCard maps runtime failures to Codex iteration-one labels', async () => {
  const cases: Array<[RuntimeReadiness, string]> = [
    [createReadiness('preflight/codex_missing', 'Setup Codex'), 'Setup Codex'],
    [createReadiness('preflight/not_authenticated', 'Login'), 'Login'],
    [createReadiness('preflight/unsupported_version', 'Update Codex'), 'Update Codex'],
  ]

  for (const [readiness, expectedLabel] of cases) {
    const html = await renderCard({ 'modly-codex-image-extension/text-to-image': readiness })
    assert.match(html, new RegExp(`>${expectedLabel}<`))
  }
})

test('ExtensionCard preserves no-HF and HF download behavior when readiness is absent', async () => {
  const noHfHtml = await renderCard({})
  assert.match(noHfHtml, />All nodes ready</)
  assert.doesNotMatch(noHfHtml, />Setup Codex</)

  const hfHtml = await renderCard({}, 'acme/model-weights')
  assert.match(hfHtml, />Install</)
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
  assert.match(noHfHtml, />All nodes ready</)
  assert.doesNotMatch(noHfHtml, />Checking failed</)

  const hfHtml = await renderCard({ 'modly-codex-image-extension/text-to-image': unsupported }, 'acme/model-weights')
  assert.match(hfHtml, />Install</)
  assert.doesNotMatch(hfHtml, />Checking failed</)
})

test('ExtensionCard treats checking-failed readiness as non-blocking for functional no-HF nodes', async () => {
  const html = await renderCard({
    'modly-codex-image-extension/text-to-image': createReadiness('checking_failed', 'Checking failed'),
  })

  assert.match(html, />All nodes ready</)
  assert.doesNotMatch(html, />Checking failed</)
  assert.doesNotMatch(html, />Install</)
})

test('ExtensionCard keeps source/group installs without a misleading runtime success label', async () => {
  const id = 'modly-codex-image-extension/text-to-image'
  for (const patch of [{ hasModelSources: true }, { weightGroups: ['base'] }]) {
    const html = await renderCard({ [id]: createReadiness('ready', 'Ready', true) }, undefined, patch)
    assert.doesNotMatch(html, /aria-label="Runtime: Ready"/)
    assert.match(html, />Install</)
    assert.match(html, /Install all/)
    assert.match(html, /0\/1 nodes installed/)
  }
  const html = await renderCard({ [id]: createReadiness('preflight/not_authenticated', 'Login') }, 'org/repo', {}, {
    downloading: { [id]: { percent: 25, paused: true } },
  })
  assert.match(html, />Login</)
  assert.match(html, /Resume download/)
  assert.match(html, /Cancel download/)
})

test('ExtensionCard never presents stale runtime success as current readiness', async () => {
  const html = await renderCard({
    'modly-codex-image-extension/text-to-image': { ...createReadiness('ready', 'Ready', true), stale: true },
  }, 'org/repo')
  assert.match(html, /Checking failed \(stale\)/)
  assert.doesNotMatch(html, /aria-label="Runtime: Ready"/)
  assert.match(html, />Install</)
})

test('ExtensionCard keeps weight downloads available when runtime readiness checking fails before weights are installed', async () => {
  const html = await renderCard({
    'modly-codex-image-extension/text-to-image': createReadiness('checking_failed', 'Checking failed'),
  }, 'acme/model-weights')

  assert.match(html, />Install</)
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
      installedIds: ['modly-codex-image-extension/text-to-image'],
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
    assert.doesNotMatch(html, />Install</)
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

test('ExtensionCard confirms refresh when requested and rejects unknown action kinds', async () => {
  const { module, cleanup } = await loadExtensionCardModule()
  try {
    assert.equal(module.resolveRuntimeReadinessActionIntent({
      id: 'refresh', kind: 'refresh_readiness', label: 'Refresh', safety: 'confirm',
    }), 'confirm_then_dispatch')
    assert.equal(module.resolveRuntimeReadinessActionIntent({
      id: 'repair', kind: 'repair_extension', label: 'Repair', safety: 'manual',
    }), 'disabled')
  } finally { await cleanup() }
})

test('ExtensionCard renders capability-scoped pending actions without invoking any operation', async () => {
  const calls: string[] = []
  const html = await renderCard({ 'canonical/node': createActionReadiness() }, undefined, {
    capabilityId: 'canonical/node', hasModelSources: true,
  }, {
    runtimeReadinessActionLoadingById: { 'canonical/node:setup-docs': true },
    onRuntimeReadinessAction: () => { calls.push('action'); return { success: true } },
    onInstall: () => calls.push('install'), onInstallAll: () => calls.push('install-all'),
    onOpen: () => calls.push('open'),
  })
  assert.deepEqual(calls, [])
  assert.match(html, /<button[^>]*disabled=""[^>]*>Open docs<\/button>/)
  assert.match(html, /Install all/)
})

test('readiness confirmation dialog exposes a named native modal without dispatch during rendering', async () => {
  const { module, cleanup } = await loadExtensionCardModule()
  const calls: string[] = []
  try {
    const html = renderToStaticMarkup(createElement(module.RuntimeReadinessDialog, {
      modal: { mode: 'confirmation', title: 'Open docs?', modelId: 'ext/node', guidance: 'Opens a browser.' },
      onClose: () => calls.push('close'), onConfirm: () => calls.push('confirm'),
    }))
    assert.match(html, /<dialog[^>]*aria-labelledby="[^"]+"[^>]*aria-modal="true"/)
    assert.match(html, /<h2[^>]*>Open docs\?<\/h2>/)
    assert.match(html, /autofocus=""/)
    assert.deepEqual(calls, [])
  } finally { await cleanup() }
})

test('readiness card omits inline details while retaining safe detail filtering and query-link affordances', async () => {
  const { module, cleanup } = await loadExtensionCardModule()
  const calls: string[] = []
  try {
    for (const path of [
      'C:/Users/Example/AppData/Local/codex.exe',
      'C:\\Users\\Example\\AppData\\Local\\codex.exe',
      'C:/Users\\Example/AppData/Local/codex.exe',
      '/home/example/bin/codex',
      'Located at C:/Users/Example/codex.exe',
      '(z:/Users/Example/codex.exe)',
      '"C:\\Users\\Example\\codex.exe"',
    ]) {
      const details = {
        title: path, summary: 'Runtime at ' + path, guidance: path,
        diagnostics: { runtime_source: path, auth_state: 'authenticated', runtime_version: '0.122.0' },
        evidence: { runtime_source: 'path', runtime_name: path },
      }
      assert.deepEqual(module.filterRuntimeReadinessDetailsForDisplay(details), {
        diagnostics: { auth_state: 'authenticated', runtime_version: '0.122.0' },
        evidence: { runtime_source: 'path' },
      })
      const html = await renderCard({ 'modly-codex-image-extension/text-to-image': {
        ...createReadiness('ready', 'Ready', true),
        details,
        actions: [{
          id: 'docs.query', kind: 'open_external_url', label: 'Platform docs', safety: 'manual',
          docs_url: 'https://example.invalid/docs?tab=linux&version=0.122.0#install',
        }],
      } }, undefined, {}, { onRuntimeReadinessAction: () => { calls.push('dispatch'); return { success: true } } })
      assert.equal(html.includes(path), false)
      assert.doesNotMatch(html, /authenticated/)
      assert.doesNotMatch(html, /0\.122\.0/)
      assert.match(html, />Platform docs<\/button>/)
      assert.deepEqual(calls, [])
    }
  } finally { await cleanup() }
})

test('ExtensionCard exposes only link and refresh actions without an optional label hint', async () => {
  const id = 'modly-codex-image-extension/text-to-image'
  const calls: string[] = []
  const actions: NonNullable<RuntimeReadiness['actions']> = [
    { id: 'guide', kind: 'show_guidance', label: 'Setup guide', safety: 'manual', guidance: 'Follow the runtime setup guide.' },
    { id: 'details', kind: 'show_details', label: 'Runtime details', safety: 'manual' },
    { id: 'docs', kind: 'open_external_url', label: 'Read docs', safety: 'confirm', docs_url: 'https://example.invalid/docs?tab=linux#install' },
    { id: 'refresh', kind: 'refresh_readiness', label: 'Refresh runtime', safety: 'non_destructive' },
  ]
  const details = { title: 'Runtime needs setup', summary: 'See https://example.invalid/docs for help.' }
  for (const content of [{ actions, details }, { actions }, { details }]) {
    const html = await renderCard({ [id]: {
      ...createReadiness('preflight/runtime_missing'), ...content,
    } }, 'acme/model-weights', {}, {
      onRuntimeReadinessAction: () => { calls.push('action'); return { success: true } },
      onInstall: () => calls.push('install'), onInstallAll: () => calls.push('install-all'),
    })
    for (const action of actions) {
      const visible = 'actions' in content && (action.kind === 'open_external_url' || action.kind === 'refresh_readiness')
      assert.equal(html.includes('>' + action.label + '</button>'), visible)
    }
    assert.doesNotMatch(html, /<p[^>]*>See https:\/\/example.invalid\/docs for help\.<\/p>/)
    assert.equal(html.includes(details.title), false)
    assert.doesNotMatch(html, /aria-label="Runtime:/)
    assert.match(html, />Install</)
    assert.match(html, /Install all/)
    assert.deepEqual(calls, [])
  }
})

test('ExtensionCard suppresses absent unsupported or empty runtime content without changing installs', async () => {
  const id = 'modly-codex-image-extension/text-to-image'
  for (const readiness of [
    undefined,
    createReadiness('preflight/runtime_missing'),
    { ...createReadiness('preflight/runtime_missing'), actions: [], details: { summary: 'C:/Users/Example/runtime.exe' } },
    { ...createActionReadiness(), machine_code: 'unsupported_contract' },
  ]) {
    const html = await renderCard({ [id]: readiness }, 'acme/model-weights')
    assert.doesNotMatch(html, /aria-label="Runtime:|<summary|>Setup Codex<|>Open docs<|>Refresh<|Codex runtime details|C:\/Users/)
    assert.match(html, />Install</)
    assert.match(html, /Install all/)
  }
})

test('readiness helpers preserve HTTPS prose while the card hides guidance and inline details', async () => {
  const { module, cleanup } = await loadExtensionCardModule()
  try {
    for (const text of [
      'See https://example.invalid/docs for help.',
      'https://example.invalid/docs',
      'Docs (https://example.invalid/docs#install).',
    ]) {
      const details = { title: text, summary: text, guidance: text }
      assert.deepEqual(module.filterRuntimeReadinessDetailsForDisplay(details), details)
      const html = await renderCard({ 'modly-codex-image-extension/text-to-image': {
        ...createReadiness('preflight/runtime_missing', 'Setup Codex'),
        details,
        actions: [{ id: 'guide', kind: 'show_guidance', label: 'Setup guide', safety: 'manual', guidance: text }],
      } })
      assert.equal(html.includes(text), false)
      assert.doesNotMatch(html, />Setup guide<\/button>/)
      const dialog = renderToStaticMarkup(createElement(module.RuntimeReadinessDialog, {
        modal: { mode: 'details', title: 'Runtime details', modelId: 'ext/node', details },
        onClose: () => undefined, onConfirm: () => assert.fail('Rendering details must not dispatch'),
      }))
      assert.equal(dialog.includes(text), true)
      assert.match(dialog, /<dialog[^>]*aria-modal="true"/)
    }
  } finally { await cleanup() }
})

test('ExtensionCard retains disabled visible actions and capability-scoped pending errors', async () => {
  const readiness = createActionReadiness()
  readiness.actions = readiness.actions?.map((action) => action.kind === 'open_external_url'
    ? { ...action, disabled: true, reason: 'Documentation is unavailable.' } : action)
  const html = await renderCard({ 'canonical/node': readiness }, undefined, { capabilityId: 'canonical/node' }, {
    runtimeReadinessActionLoadingById: { 'canonical/node:refresh': true },
    runtimeReadinessActionErrorById: {
      'canonical/node:refresh': 'Refresh failed.',
      'canonical/node:setup-guidance': 'Hidden guidance error.',
    },
  })
  assert.match(html, /<button[^>]*disabled=""[^>]*title="Documentation is unavailable\."[^>]*>Open docs<\/button>/)
  assert.match(html, /<button[^>]*disabled=""[^>]*aria-busy="true"[^>]*>Refresh<\/button>/)
  assert.match(html, /<p[^>]*role="alert"[^>]*>Refresh failed\.<\/p>/)
  assert.doesNotMatch(html, /Hidden guidance error/)
})

test('ExtensionCard keeps installed sources groups variants and active download controls after simplification', async () => {
  const id = 'modly-codex-image-extension/text-to-image'
  for (const node of [
    { hasModelSources: true },
    { weightGroups: ['base'] },
    { hfRepo: 'org/repo', weightVariants: { param: 'variant', default: 'one', options: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] } },
  ]) {
    const html = await renderCard({ [id]: createActionReadiness() }, undefined, node, { installedIds: [id] })
    assert.match(html, /Installed/)
    assert.match(html, /All nodes ready/)
    assert.doesNotMatch(html, /Install all/)
    assert.match(html, />Open docs<\/button>/)
    if ('weightVariants' in node) assert.match(html, /2 variants/)
  }
  for (const paused of [false, true]) {
    const html = await renderCard({ [id]: createActionReadiness() }, undefined, { hasModelSources: true }, {
      downloading: { [id]: { percent: 25, paused } },
    })
    assert.equal(html.includes(paused ? 'Resume download' : 'Pause download'), true)
    assert.match(html, /Cancel download/)
    assert.doesNotMatch(html, /Install all/)
    assert.match(html, />Refresh<\/button>/)
  }
})

test('ExtensionCard suppresses runtime success for installed and genuinely weightless nodes', async () => {
  const id = 'modly-codex-image-extension/text-to-image'
  const readiness = { [id]: createReadiness('ready', 'Ready', true) }
  const weightless = await renderCard(readiness)
  assert.match(weightless, />All nodes ready</)
  assert.doesNotMatch(weightless, /Runtime:|>Install</)

  const installed = await renderCard(readiness, undefined, { hasModelSources: true, weightGroups: ['base'] }, { installedIds: [id] })
  assert.match(installed, /Installed/)
  assert.match(installed, />All nodes ready</)
  assert.doesNotMatch(installed, /Runtime:|Install all/)
})

test('ExtensionCard runtime success cannot complete missing private groups or variant weights', async () => {
  const id = 'modly-codex-image-extension/text-to-image'
  for (const patch of [
    { hasModelSources: true },
    { weightGroups: ['distinct-group'] },
    { hasModelSources: true, weightGroups: ['distinct-group'] },
    { hfRepo: 'org/repo', weightVariants: { param: 'variant', default: 'small', options: [{ id: 'small', label: 'Small' }] } },
  ]) {
    const html = await renderCard({ [id]: createReadiness('ready', 'Ready', true) }, undefined, patch)
    assert.match(html, />Install</)
    assert.match(html, /Install all/)
    assert.match(html, /0\/1 nodes installed/)
    assert.doesNotMatch(html, /Runtime:|All nodes ready|>Installed</)
  }
})

test('ExtensionCard keeps shared-owner siblings independently installed and warnings quiet after runtime success', async () => {
  const { deriveModelOwnershipState } = await import(pathToFileURL(path.join(projectRoot, 'src/areas/models/modelOwnershipState.ts')).href)
  const capabilities = ['complete', 'incomplete'].map((id) => ({
    capabilityId: `bundle/${id}`, bundleId: 'bundle', weightOwnerId: 'bundle/private', sharedOwner: true,
    legacyPaths: ['bundle/complete', 'bundle/incomplete'],
  }))
  const installedIds = ['bundle/complete']
  const ownershipStateById = deriveModelOwnershipState(capabilities, new Set(['bundle/private']), new Set(), new Set(installedIds))
  const nodes = capabilities.map((capability, index) => ({
    id: index ? 'incomplete' : 'complete', name: index ? 'Incomplete node' : 'Complete node',
    input: 'text', output: 'image', paramsSchema: [], hasModelSources: true,
    weightGroups: [index ? 'missing-group' : 'complete-group'], ...capability,
  }))
  const html = await renderCard(Object.fromEntries(capabilities.map(({ capabilityId }) => [capabilityId, createReadiness('ready', 'Ready', true)])), undefined, {}, {
    ext: { type: 'model', id: 'bundle', name: 'Bundle', trusted: true, builtin: false, nodes },
    installedIds, ownershipStateById,
  })
  assert.match(html, /Complete node[\s\S]*?Installed[\s\S]*?Incomplete node[\s\S]*?>Install</)
  assert.match(html, /1\/2 nodes installed/)
  assert.doesNotMatch(html, /Runtime:|All nodes ready/)
  assert.equal(ownershipStateById['bundle/incomplete'].downloaded, false)
  assert.equal(ownershipStateById['bundle/incomplete'].installDisabled, false)
  assert.equal(ownershipStateById['bundle/complete'].deleteDisabled, true)
  assert.match(html, /title="Downloading this node also prepares shared weights for another node in this extension\."/)
  assert.doesNotMatch(html, /<p[^>]*>Shared weights|<p[^>]*>Downloading this node/)
})

test('ExtensionCard preserves installed weight status beside runtime failures and stale success', async () => {
  const id = 'modly-codex-image-extension/text-to-image'
  for (const [readiness, label] of [
    [createReadiness('checking_failed', 'Checking failed'), 'Checking failed'],
    [createReadiness('preflight/not_authenticated', 'Login'), 'Login'],
    [{ ...createReadiness('ready', 'Ready', true), stale: true }, 'Checking failed (stale)'],
  ] as const) {
    const html = await renderCard({ [id]: readiness }, undefined, { hasModelSources: true, weightGroups: ['base'] }, { installedIds: [id] })
    if (readiness.machine_code === 'checking_failed') {
      assert.doesNotMatch(html, /aria-label="Runtime: Checking failed"/)
    } else {
      assert.ok(html.includes(`aria-label="Runtime: ${label}"`))
    }
    assert.match(html, /Installed/)
    assert.match(html, />All nodes ready</)
    assert.doesNotMatch(html, /aria-label="Runtime: Ready"/)
  }
})

test('ExtensionCard keeps only explicit URL and refresh actions when the runtime success label is hidden', async () => {
  const readiness = { ...createActionReadiness(), ...createReadiness('ready', 'Ready', true) }
  const html = await renderCard({ 'canonical/node': readiness }, undefined, { capabilityId: 'canonical/node', hasModelSources: true }, {
    runtimeReadinessActionLoadingById: { 'canonical/node:refresh': true },
    runtimeReadinessActionErrorById: { 'canonical/node:refresh': 'Refresh failed.', 'canonical/node:runtime-details': 'Hidden details error.' },
  })
  assert.doesNotMatch(html, /Runtime:|>Setup Codex<\/button>|>Details<\/button>|Hidden details error/)
  assert.match(html, />Open docs<\/button>/)
  assert.match(html, /<button[^>]*disabled=""[^>]*aria-busy="true"[^>]*>Refresh<\/button>/)
  assert.match(html, /role="alert"[^>]*>Refresh failed\./)
  assert.match(html, />Install</)
})

test('ExtensionCard keeps pause resume and cancel controls while runtime success is hidden', async () => {
  const id = 'modly-codex-image-extension/text-to-image'
  for (const paused of [false, true]) {
    const html = await renderCard({ [id]: createReadiness('ready', 'Ready', true) }, 'org/repo', {}, {
      downloading: { [id]: { percent: 25, paused, variantId: 'small' } },
    })
    assert.ok(html.includes(paused ? 'Resume download' : 'Pause download'))
    assert.match(html, /Cancel download/)
    assert.doesNotMatch(html, /Runtime:|Install all/)
  }
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


test('ExtensionCard does not advertise legacy pause or cancel controls for structured asset endpoints', async () => {
  const html = await renderCard({}, undefined, {
    hfDownloads: [{ repoId: 'owner/model', revision: 'a'.repeat(40), targetSubdir: 'assets', files: [{ path: 'model.pt' }] }],
  }, { downloading: { 'modly-codex-image-extension/text-to-image': { percent: 25, file: 'assets/model.pt', fileIndex: 2, totalFiles: 4, repoIndex: 1, totalRepos: 3 } } })
  assert.match(html, /R1\/3 · 2\/4 · 25%/)
  assert.match(html, /model\.pt/)
  assert.doesNotMatch(html, /Pause download|Resume download|Cancel download/)
})

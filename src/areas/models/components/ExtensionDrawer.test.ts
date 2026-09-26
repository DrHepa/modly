import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const projectRoot = path.resolve(import.meta.dirname, '../../../..')
const drawerEntry = path.join(projectRoot, 'src/areas/models/components/ExtensionDrawer.tsx')

async function loadDrawerModule() {
  const tempDir = await mkdtemp(path.join(projectRoot, '.tmp-extension-drawer-'))
  const outfile = path.join(tempDir, 'ExtensionDrawer.bundle.mjs')
  await build({
    entryPoints: [drawerEntry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    tsconfig: path.join(projectRoot, 'tsconfig.web.json'),
    external: ['react', 'react/jsx-runtime', 'zustand'],
  })
  const module = await import(pathToFileURL(outfile).href)
  return {
    module,
    async cleanup() { await rm(tempDir, { recursive: true, force: true }) },
  }
}

function drawerProps(downloadFailures: Record<string, unknown>, ownershipStateById: Record<string, unknown> = {}) {
  const installedIds: string[] = []
  const ext = {
    type: 'model',
    id: 'demo',
    name: 'Demo',
    nodes: [
      { id: 'permanent', name: 'Permanent', input: 'image', output: 'mesh', paramsSchema: [], hfRepo: 'org/permanent' },
      { id: 'retryable', name: 'Retryable', input: 'image', output: 'mesh', paramsSchema: [], hfRepo: 'org/retryable' },
    ],
  }
  return {
    ext,
    installedIds,
    downloading: {},
    downloadFailures,
    ownershipStateById,
    onInstall: () => undefined,
    onInstallAll: () => undefined,
    onPauseDownload: () => undefined,
    onCancelDownload: () => undefined,
    onUninstallNode: () => undefined,
    onUninstall: () => undefined,
    onRepaired: () => undefined,
    onSynced: () => undefined,
    onClose: () => undefined,
  }
}

test('ExtensionDrawer disables a permanently failed node but keeps Install all for retryable nodes', async () => {
  const { module, cleanup } = await loadDrawerModule()
  try {
    const html = renderToStaticMarkup(createElement(module.ExtensionDrawer, drawerProps({
      'demo/permanent': { code: 'source_plan_invalid', stage: 'validate', message: 'unsafe', retryable: false },
      'demo/retryable': { code: 'download_failed', stage: 'download', message: 'timeout', retryable: true },
    })))
    assert.match(html, /Install all nodes/)
    assert.match(html, /disabled=""/)
    assert.match(html, /source_plan_invalid · validate/)
    assert.match(html, /unsafe/)
  } finally {
    await cleanup()
  }
})

test('ExtensionDrawer gates per-node deletion for shared-owner weights', async () => {
  const { module, cleanup } = await loadDrawerModule()
  try {
    const props = drawerProps({}, {
      'demo/permanent': {
        capabilityId: 'demo/permanent', bundleId: 'demo', weightOwnerId: 'demo/permanent',
        sharedOwner: true, legacyPaths: [], downloaded: true, isOwnerDownloading: false,
        installDisabled: true, deleteDisabled: true, ownerPeerCapabilityIds: ['demo/retryable'],
        badges: ['Shared weights'], warning: 'Shared weights are used by another node.',
      },
    })
    props.installedIds = ['demo/permanent']
    const html = renderToStaticMarkup(createElement(module.ExtensionDrawer, props))
    assert.match(html, /title="Shared weights are used by another node\."/)
    assert.match(html, /disabled="" title="Shared weights are used by another node\."/)
  } finally {
    await cleanup()
  }
})

test('ExtensionDrawer removes Install all when every available node has a permanent failure', async () => {
  const { module, cleanup } = await loadDrawerModule()
  try {
    const html = renderToStaticMarkup(createElement(module.ExtensionDrawer, drawerProps({
      'demo/permanent': { code: 'source_plan_invalid', stage: 'validate', message: 'unsafe', retryable: false },
      'demo/retryable': { code: 'source_plan_invalid', stage: 'validate', message: 'unsafe', retryable: false },
    })))
    assert.doesNotMatch(html, /Install all nodes/)
  } finally {
    await cleanup()
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function loadModule() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'modly-model-plan-module-')), 'model-plan.cjs')
  const require = createRequire(import.meta.url)
  const result = buildSync({
    entryPoints: [resolve('electron/main/model-download-plan.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  writeFileSync(outfile, result.outputFiles[0].text, 'utf8')
  return require(outfile)
}

function setupExtension(manifest) {
  const root = mkdtempSync(join(tmpdir(), 'modly-action-plan-'))
  const user = join(root, 'user')
  const builtin = join(root, 'builtin')
  const extension = join(user, manifest.id)
  mkdirSync(extension, { recursive: true })
  mkdirSync(builtin)
  const manifestPath = join(extension, 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  return { root, user, builtin, manifestPath }
}

test('re-reads the installed manifest for each action and resolves only node-owned sources', async () => {
  const { resolveInstalledModelDownloadPlan } = loadModule()
  const manifest = {
    id: 'pixal3d',
    type: 'model',
    nodes: [{
      id: 'generate',
      model_sources: [{
        id: 'primary', provider: 'huggingface', repo_id: 'org/old',
        destination: '.', checks: ['model.safetensors'],
      }],
    }],
  }
  const fixture = setupExtension(manifest)
  const args = {
    modelId: 'pixal3d/generate',
    userExtensionsDir: fixture.user,
    builtinExtensionsDir: fixture.builtin,
  }
  try {
    const first = await resolveInstalledModelDownloadPlan(args)
    assert.equal(first.kind, 'multi-source')
    assert.equal(first.sources[0].repo_id, 'org/old')

    manifest.nodes[0].model_sources[0].repo_id = 'org/new'
    writeFileSync(fixture.manifestPath, JSON.stringify(manifest))
    const second = await resolveInstalledModelDownloadPlan(args)
    assert.equal(second.sources[0].repo_id, 'org/new')
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('resolves Pixal3D shared weight groups to extension-scoped non-duplicating targets', async () => {
  const { resolveInstalledModelDownloadPlan } = loadModule()
  const modelSource = (id, repo, check) => ({
    id, provider: 'huggingface', repo_id: repo, destination: '.', checks: [check],
  })
  const fixture = setupExtension({
    id: 'pixal3d',
    type: 'model',
    weight_groups: [
      { id: 'pixal3d-base', model_sources: [modelSource('base', 'org/base', 'base.bin')] },
      { id: 'pixal3d-mv', model_sources: [modelSource('mv', 'org/mv', 'mv.bin')] },
    ],
    nodes: [
      { id: 'generate', weight_groups: ['pixal3d-base'] },
      { id: 'generate-mv', weight_groups: ['pixal3d-base', 'pixal3d-mv'] },
    ],
  })
  try {
    const plan = await resolveInstalledModelDownloadPlan({
      modelId: 'pixal3d/generate-mv',
      userExtensionsDir: fixture.user,
      builtinExtensionsDir: fixture.builtin,
    })
    assert.equal(plan.kind, 'multi-source')
    assert.deepEqual(plan.sources, [])
    assert.deepEqual(plan.sharedGroups.map((group) => ({
      id: group.id,
      targetId: group.targetId,
      dependentModelIds: group.dependentModelIds,
    })), [
      { id: 'pixal3d-base', targetId: 'pixal3d/_shared/pixal3d-base', dependentModelIds: ['pixal3d/generate', 'pixal3d/generate-mv'] },
      { id: 'pixal3d-mv', targetId: 'pixal3d/_shared/pixal3d-mv', dependentModelIds: ['pixal3d/generate-mv'] },
    ])
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('returns a terminal structured failure for an invalid installed source plan', async () => {
  const { resolveInstalledModelDownloadPlan } = loadModule()
  const fixture = setupExtension({
    id: 'pixal3d',
    type: 'model',
    nodes: [{
      id: 'generate',
      model_sources: [{
        id: 'primary', provider: 'huggingface', repo_id: 'org/main',
        destination: '../outside', checks: ['model.safetensors'],
      }],
    }],
  })
  try {
    await assert.rejects(
      resolveInstalledModelDownloadPlan({
        modelId: 'pixal3d/generate',
        userExtensionsDir: fixture.user,
        builtinExtensionsDir: fixture.builtin,
      }),
      (error) => {
        assert.equal(error.failure.code, 'source_plan_invalid')
        assert.equal(error.failure.stage, 'validate')
        assert.equal(error.failure.retryable, false)
        return true
      },
    )
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('wraps missing installed extensions in the terminal validation failure contract', async () => {
  const { resolveInstalledModelDownloadPlan } = loadModule()
  const root = mkdtempSync(join(tmpdir(), 'modly-missing-extension-'))
  const user = join(root, 'user')
  const builtin = join(root, 'builtin')
  mkdirSync(user)
  mkdirSync(builtin)
  try {
    await assert.rejects(
      resolveInstalledModelDownloadPlan({ modelId: 'missing/generate', userExtensionsDir: user, builtinExtensionsDir: builtin }),
      (error) => error.failure.code === 'source_plan_invalid' && error.failure.stage === 'validate' && error.failure.retryable === false,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

for (const [label, node] of [
  ['HF', {
    id: 'generate',
    hf_downloads: [{
      repo_id: 'owner/repo',
      revision: 'not-a-commit',
      target_subdir: 'weights',
      files: [{ path: 'model.bin' }],
    }],
  }],
  ['HTTPS', {
    id: 'generate',
    https_downloads: [{
      url: 'https://assets.example.com/model.bin',
      filename: '../model.bin',
      size_bytes: 5,
      sha256: 'a'.repeat(64),
    }],
  }],
]) {
  test(`returns a terminal structured failure for malformed installed ${label} plans`, async () => {
    const { resolveInstalledModelDownloadPlan } = loadModule()
    const fixture = setupExtension({ id: 'invalid-plan', type: 'model', nodes: [node] })
    try {
      await assert.rejects(
        resolveInstalledModelDownloadPlan({
          modelId: 'invalid-plan/generate',
          userExtensionsDir: fixture.user,
          builtinExtensionsDir: fixture.builtin,
        }),
        (error) => {
          assert.equal(error.failure.code, 'source_plan_invalid')
          assert.equal(error.failure.stage, 'validate')
          assert.equal(error.failure.retryable, false)
          return true
        },
      )
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
}

test('keeps legacy literal prefix filters and rejects traversal checks', async () => {
  const { resolveInstalledModelDownloadPlan } = loadModule()
  const fixture = setupExtension({
    id: 'triposplat',
    type: 'model',
    nodes: [{
      id: 'projection',
      hf_repo: 'VAST-AI/TripoSplat',
      download_check: 'diffusion_models/triposplat_fp16.safetensors',
      hf_skip_prefixes: ['weights/**', 'assets/*'],
      hf_include_prefixes: ['diffusion_models/', 'configs/'],
    }],
  })
  try {
    const plan = await resolveInstalledModelDownloadPlan({ modelId: 'triposplat/projection', userExtensionsDir: fixture.user, builtinExtensionsDir: fixture.builtin })
    assert.equal(plan.kind, 'legacy')
    assert.equal(plan.downloadCheck, 'diffusion_models/triposplat_fp16.safetensors')
    assert.deepEqual(plan.skipPrefixes, ['weights/**', 'assets/*'])
    assert.deepEqual(plan.includePrefixes, ['diffusion_models/', 'configs/'])
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

for (const [label, node] of [
  ['non-string hf_repo', { id: 'generate', hf_repo: 42 }],
  ['non-string download_check', { id: 'generate', hf_repo: 'owner/repo', download_check: 42 }],
  ['non-array skip prefixes', { id: 'generate', hf_repo: 'owner/repo', hf_skip_prefixes: 'weights/' }],
  ['non-string include prefix', { id: 'generate', hf_repo: 'owner/repo', hf_include_prefixes: ['weights/', 7] }],
  ['padded hf_repo', { id: 'generate', hf_repo: ' owner/repo' }],
  ['padded download_check', { id: 'generate', hf_repo: 'owner/repo', download_check: ' model.bin' }],
  ['traversal download_check', { id: 'generate', hf_repo: 'owner/repo', download_check: '../model.bin' }],
  ['empty skip prefix', { id: 'generate', hf_repo: 'owner/repo', hf_skip_prefixes: [''] }],
  ['whitespace include prefix', { id: 'generate', hf_repo: 'owner/repo', hf_include_prefixes: ['   '] }],
]) {
  test(`returns a terminal structured failure for malformed legacy ${label}`, async () => {
    const { resolveInstalledModelDownloadPlan } = loadModule()
    const fixture = setupExtension({ id: 'invalid-legacy', type: 'model', nodes: [node] })
    try {
      await assert.rejects(
        resolveInstalledModelDownloadPlan({
          modelId: 'invalid-legacy/generate',
          userExtensionsDir: fixture.user,
          builtinExtensionsDir: fixture.builtin,
        }),
        (error) => error.failure.code === 'source_plan_invalid' && error.failure.retryable === false,
      )
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
}

test('rejects structured assets mixed with the legacy hf_repo plan', async () => {
  const { resolveInstalledModelDownloadPlan } = loadModule()
  const revision = 'ef15eda2e413f994e3b4657960b0309487587718'
  const fixture = setupExtension({
    id: 'cube3d',
    type: 'model',
    nodes: [{
      id: 'generate',
      hf_repo: 'owner/legacy-must-not-win',
      download_check: 'legacy.bin',
      hf_downloads: [{
        repo_id: 'owner/structured',
        revision,
        target_subdir: 'weights',
        files: [{ path: 'model.bin' }],
      }],
    }],
  })
  try {
    await assert.rejects(
      resolveInstalledModelDownloadPlan({
        modelId: 'cube3d/generate',
        userExtensionsDir: fixture.user,
        builtinExtensionsDir: fixture.builtin,
      }),
      (error) => error.failure.code === 'source_plan_invalid' && error.failure.retryable === false,
    )
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('rejects conflicting HTTPS, structured HF, and legacy plans', async () => {
  const { resolveInstalledModelDownloadPlan } = loadModule()
  const revision = 'ef15eda2e413f994e3b4657960b0309487587718'
  const fixture = setupExtension({
    id: 'gaussiangpt',
    type: 'model',
    nodes: [{
      id: 'generate',
      hf_repo: 'owner/legacy-must-not-win',
      hf_downloads: [{
        repo_id: 'owner/hf-must-not-win',
        revision,
        target_subdir: 'weights',
        files: [{ path: 'model.bin' }],
      }],
      https_downloads: [{
        url: 'https://assets.example.com/model.bin',
        filename: 'model.bin',
        size_bytes: 5,
        sha256: 'a'.repeat(64),
      }],
    }],
  })
  try {
    await assert.rejects(
      resolveInstalledModelDownloadPlan({
        modelId: 'gaussiangpt/generate',
        userExtensionsDir: fixture.user,
        builtinExtensionsDir: fixture.builtin,
      }),
      (error) => error.failure.code === 'source_plan_invalid' && error.failure.retryable === false,
    )
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

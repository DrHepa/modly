import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type {
  CommitPostCopyContext,
  DownloadTarballInput,
  ExtractTarballInput,
  FailedExtensionResult,
  InstallGitHubExtensionRepoProgress,
  InstalledExtensionResult,
  RunExtensionSetupInput,
  RunNpmInstallInput,
} from './github-extension-install.ts'
import type { ListedExtension, ListedExtensionNode } from './automation-capabilities.ts'

const serviceModuleUrl = new URL('./github-extension-install.ts', import.meta.url).href
const automationModuleUrl = new URL('./automation-capabilities.ts', import.meta.url).href

const fixturesRoot = fileURLToPath(new URL('../../tests/fixtures/github-install/', import.meta.url))

async function withFixtureRepo(fixtureName: string, run: (repoDir: string) => Promise<void>) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'modly-github-install-'))
  const repoDir = join(tempRoot, 'repo')

  try {
    await cp(join(fixturesRoot, fixtureName), repoDir, { recursive: true })
    await run(repoDir)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function readDirNames(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort((left, right) => left.localeCompare(right))
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf-8'))
}

test('discoverInstallCandidates + validateInstallCandidates keep legacy root repos on the single-extension path', async () => {
  const { discoverInstallCandidates, validateInstallCandidates } = await import(serviceModuleUrl)

  await withFixtureRepo('legacy-root', async (repoDir) => {
      const discovery = await discoverInstallCandidates(repoDir)
      assert.equal(discovery.mode, 'legacy')
      assert.equal(discovery.candidates.length, 1)

      const plan = await validateInstallCandidates({
        repoDir,
        sourceRepo: 'https://github.com/acme/legacy-root-model/',
        discovery,
      })

      assert.equal(plan.mode, 'legacy')
      assert.equal(plan.reloadCount, 1)
      assert.deepEqual(
        plan.candidates.map((candidate: { id: string; relativePath: string; manifest: { source?: string } }) => ({
          id: candidate.id,
          relativePath: candidate.relativePath,
          source: candidate.manifest.source,
        })),
        [{
          id: 'legacy-root-model',
          relativePath: '.',
          source: 'https://github.com/acme/legacy-root-model',
        }],
      )

      const persistedManifest = JSON.parse(await readFile(join(repoDir, 'manifest.json'), 'utf-8'))
      assert.equal(persistedManifest.source, 'https://example.com/not-canonical')
    })
})

test('discoverInstallCandidates + validateInstallCandidates accept valid bundled children under extensions/* only', async () => {
  const { discoverInstallCandidates, validateInstallCandidates } = await import(serviceModuleUrl)

  await withFixtureRepo('bundle-valid', async (repoDir) => {
      const discovery = await discoverInstallCandidates(repoDir)
      assert.equal(discovery.mode, 'bundle')
      assert.deepEqual(discovery.candidates.map((candidate: { relativePath: string }) => candidate.relativePath), [
        'extensions/image-model',
        'extensions/mesh-process',
      ])

      const plan = await validateInstallCandidates({
        repoDir,
        sourceRepo: 'https://github.com/acme/bundle-valid',
        discovery,
      })

      assert.equal(plan.mode, 'bundle')
      assert.equal(plan.reloadCount, 1)
      assert.deepEqual(plan.candidates.map((candidate: { id: string }) => candidate.id), ['image-model', 'mesh-process'])
      assert.deepEqual(
        plan.candidates.map((candidate: { manifest: { source?: string } }) => candidate.manifest.source),
        ['https://github.com/acme/bundle-valid', 'https://github.com/acme/bundle-valid'],
      )
    })
})

test('validateInstallCandidates fails atomically when any bundled child is structurally invalid', async () => {
  const { discoverInstallCandidates, validateInstallCandidates } = await import(serviceModuleUrl)

  await withFixtureRepo('bundle-invalid', async (repoDir) => {
      const discovery = await discoverInstallCandidates(repoDir)

      await assert.rejects(
        () => validateInstallCandidates({
          repoDir,
          sourceRepo: 'https://github.com/acme/bundle-invalid',
          discovery,
        }),
        /generator\.py missing.*broken-model/i,
      )
    })
})

test('validateInstallCandidates fails atomically when bundled children repeat the same id', async () => {
  const { discoverInstallCandidates, validateInstallCandidates } = await import(serviceModuleUrl)

  await withFixtureRepo('bundle-duplicate-ids', async (repoDir) => {
      const discovery = await discoverInstallCandidates(repoDir)

      await assert.rejects(
        () => validateInstallCandidates({
          repoDir,
          sourceRepo: 'https://github.com/acme/bundle-duplicate-ids',
          discovery,
        }),
        /duplicate extension id "shared-id"/i,
      )
    })
})

test('validateInstallCandidates plans a single reload for a multi-child bundle', async () => {
  const { discoverInstallCandidates, validateInstallCandidates } = await import(serviceModuleUrl)

  await withFixtureRepo('bundle-valid', async (repoDir) => {
      const discovery = await discoverInstallCandidates(repoDir)
      const plan = await validateInstallCandidates({
        repoDir,
        sourceRepo: 'https://github.com/acme/one-reload-only',
        discovery,
      })

      assert.equal(plan.mode, 'bundle')
      assert.equal(plan.candidates.length, 2)
      assert.equal(plan.reloadCount, 1)
    })
})

test('commitInstallPlan rejects bundled children that collide with builtin ids before any write', async () => {
  const { discoverInstallCandidates, validateInstallCandidates, commitInstallPlan } = await import(serviceModuleUrl)

  await withFixtureRepo('bundle-valid', async (repoDir) => {
    const discovery = await discoverInstallCandidates(repoDir)
    const plan = await validateInstallCandidates({
      repoDir,
      sourceRepo: 'https://github.com/acme/bundle-valid',
      discovery,
    })

    const extensionsDir = await mkdtemp(join(tmpdir(), 'modly-installed-extensions-'))

    try {
      await assert.rejects(
        () => commitInstallPlan({
          plan,
          extensionsDir,
          builtinExtensionIds: new Set(['image-model']),
        }),
        /builtin extension id "image-model" cannot be replaced/i,
      )

      assert.deepEqual(await readDirNames(extensionsDir), [])
    } finally {
      await rm(extensionsDir, { recursive: true, force: true })
    }
  })
})

test('commitInstallPlan restores replaced user extensions when copy fails during replacement', async () => {
  const { discoverInstallCandidates, validateInstallCandidates, commitInstallPlan } = await import(serviceModuleUrl)

  await withFixtureRepo('bundle-valid', async (repoDir) => {
    const discovery = await discoverInstallCandidates(repoDir)
    const plan = await validateInstallCandidates({
      repoDir,
      sourceRepo: 'https://github.com/acme/bundle-valid',
      discovery,
    })

    const extensionsDir = await mkdtemp(join(tmpdir(), 'modly-installed-extensions-'))
    const existingDir = join(extensionsDir, 'image-model')
    await cp(join(fixturesRoot, 'bundle-valid/extensions/image-model'), existingDir, { recursive: true })
    await writeFile(join(existingDir, 'user-owned.txt'), 'keep-me', 'utf-8')

    try {
      await assert.rejects(
        () => commitInstallPlan({
          plan,
          extensionsDir,
            builtinExtensionIds: new Set(),
            operations: {
            async copyDirectory(sourceDir: string, targetDir: string) {
              if (targetDir.includes('.modly-staging-image-model-')) {
                throw new Error(`simulated copy failure for ${sourceDir}`)
              }
              await cp(sourceDir, targetDir, { recursive: true })
            },
          },
        }),
        /simulated copy failure/i,
      )

      assert.equal(await stat(existingDir).then(() => true, () => false), true)
      assert.equal(await readFile(join(existingDir, 'user-owned.txt'), 'utf-8'), 'keep-me')
      const restoredManifest = await readJson(join(existingDir, 'manifest.json')) as { id?: string }
      assert.equal(restoredManifest.id, 'image-model')
      assert.deepEqual(await readDirNames(extensionsDir), ['image-model'])
    } finally {
      await rm(extensionsDir, { recursive: true, force: true })
    }
  })
})

test('commitInstallPlan removes incomplete fresh children when a post-copy step fails', async () => {
  const { discoverInstallCandidates, validateInstallCandidates, commitInstallPlan } = await import(serviceModuleUrl)

  await withFixtureRepo('bundle-valid', async (repoDir) => {
    const discovery = await discoverInstallCandidates(repoDir)
    const plan = await validateInstallCandidates({
      repoDir,
      sourceRepo: 'https://github.com/acme/bundle-valid',
      discovery,
    })

    const extensionsDir = await mkdtemp(join(tmpdir(), 'modly-installed-extensions-'))

    try {
      await assert.rejects(
        () => commitInstallPlan({
          plan,
          extensionsDir,
          builtinExtensionIds: new Set(),
          postCopyStep: async ({ candidateId }: CommitPostCopyContext) => {
            if (candidateId === 'image-model') {
              throw new Error('simulated setup failure after copy')
            }
          },
        }),
        /simulated setup failure after copy/i,
      )

      assert.equal(await stat(join(extensionsDir, 'image-model')).then(() => true, () => false), false)
      assert.equal(await stat(join(extensionsDir, 'mesh-process')).then(() => true, () => false), false)

      assert.deepEqual(await readDirNames(extensionsDir), [])

    } finally {
      await rm(extensionsDir, { recursive: true, force: true })
    }
  })
})

test('installGitHubExtensionRepo returns legacy-compatible success output and reloads exactly once for a single installed child', async () => {
  const { installGitHubExtensionRepo } = await import(serviceModuleUrl)

  await withFixtureRepo('legacy-root', async (repoDir) => {
    const extensionsDir = await mkdtemp(join(tmpdir(), 'modly-installed-extensions-'))
    const progressEvents: InstallGitHubExtensionRepoProgress[] = []
    let reloadCalls = 0

    try {
      const result = await installGitHubExtensionRepo({
        githubUrl: 'https://github.com/acme/legacy-root-model',
        extensionsDir,
        builtinExtensionIds: new Set(),
        trustedRepos: new Set(['https://github.com/acme/legacy-root-model']),
        emitProgress: (event: InstallGitHubExtensionRepoProgress) => {
          progressEvents.push(event)
        },
        operations: {
          async downloadTarball({ onProgress }: DownloadTarballInput) {
            onProgress({ loaded: 100, total: 100 })
          },
          async extractTarball({ extractDir }: ExtractTarballInput) {
            await cp(repoDir, extractDir, { recursive: true })
          },
          async reloadExtensions(capabilities: Array<{ extensionId: string }>) {
            reloadCalls += 1
            return { reloaded: true, models: capabilities.map((c) => `${c.extensionId}/${c.extensionId === 'legacy-root-model' ? 'generate-mesh' : 'generate'}`), errors: {} }
          },
        },
      })

      assert.equal(result.success, true)
      assert.equal(result.status, 'success')
      assert.equal(result.extensionId, 'legacy-root-model')
      assert.equal(result.extension?.id, 'legacy-root-model')
      assert.equal(result.installed.length, 1)
      assert.equal(result.installed[0]?.status, 'success')
      assert.equal(result.failed.length, 0)
      assert.deepEqual(result.warnings, [])
      assert.equal(result.reloaded, true)
      assert.equal(reloadCalls, 1)

      const finalEvent = progressEvents.at(-1)
      assert.equal(finalEvent?.step, 'done')
      assert.equal(finalEvent?.status, 'success')
      assert.equal(finalEvent?.extensionId, 'legacy-root-model')
      assert.equal(finalEvent?.reloaded, true)
    } finally {
      await rm(extensionsDir, { recursive: true, force: true })
    }
  })
})

test('installGitHubExtensionRepo installs bundled children as flattened top-level extensions and keeps discovery compatible with one reload', async () => {
  const { installGitHubExtensionRepo } = await import(serviceModuleUrl)
  const { listVisibleExtensions } = await import(automationModuleUrl)

  await withFixtureRepo('bundle-valid', async (repoDir) => {
    const extensionsDir = await mkdtemp(join(tmpdir(), 'modly-installed-extensions-'))
    const builtinDir = await mkdtemp(join(tmpdir(), 'modly-builtin-extensions-'))
    const progressEvents: InstallGitHubExtensionRepoProgress[] = []
    let reloadCalls = 0

    try {
      const result = await installGitHubExtensionRepo({
        githubUrl: 'https://github.com/acme/bundle-valid',
        extensionsDir,
        builtinExtensionIds: new Set(),
        trustedRepos: new Set(['https://github.com/acme/bundle-valid']),
        emitProgress: (event: InstallGitHubExtensionRepoProgress) => {
          progressEvents.push(event)
        },
        operations: {
          async downloadTarball() {},
          async extractTarball({ extractDir }: ExtractTarballInput) {
            await cp(repoDir, extractDir, { recursive: true })
          },
          async reloadExtensions(capabilities: Array<{ extensionId: string }>) {
            reloadCalls += 1
            return { reloaded: true, models: capabilities.map((c) => `${c.extensionId}/${c.extensionId === 'legacy-root-model' ? 'generate-mesh' : 'generate'}`), errors: {} }
          },
        },
      })

      assert.equal(result.success, true)
      assert.equal(result.status, 'success')
      assert.equal(result.extensionId, undefined)
      assert.deepEqual(
        result.installed.map((entry: InstalledExtensionResult) => ({ extensionId: entry.extensionId, status: entry.status })),
        [
          { extensionId: 'image-model', status: 'success' },
          { extensionId: 'mesh-process', status: 'success' },
        ],
      )
      assert.deepEqual(result.failed, [])
      assert.deepEqual(result.warnings, [])
      assert.equal(result.reloaded, true)
      assert.equal(reloadCalls, 1)
      assert.deepEqual(await readDirNames(extensionsDir), ['image-model', 'mesh-process'])

      const installedModelManifest = await readJson(join(extensionsDir, 'image-model', 'manifest.json')) as { id?: string; source?: string }
      const installedProcessManifest = await readJson(join(extensionsDir, 'mesh-process', 'manifest.json')) as { id?: string; source?: string }
      assert.deepEqual(installedModelManifest, {
        id: 'image-model',
        type: 'model',
        generator_class: 'ImageModel',
        source: 'https://github.com/acme/bundle-valid',
        nodes: [
          {
            id: 'generate',
            input: 'image',
            output: 'mesh',
          },
        ],
      })
      assert.deepEqual(installedProcessManifest, {
        id: 'mesh-process',
        type: 'process',
        entry: 'processor.js',
        source: 'https://github.com/acme/bundle-valid',
        nodes: [
          {
            id: 'clean',
            input: 'mesh',
            output: 'mesh',
          },
        ],
      })

      const discovered = await listVisibleExtensions({
        builtinDir,
        userExtensionsDir: extensionsDir,
        trustedRepos: new Set(['https://github.com/acme/bundle-valid']),
      })
      assert.deepEqual(
        discovered.map((extension: ListedExtension) => ({ id: extension.id, type: extension.type })),
        [
          { id: 'image-model', type: 'model' },
          { id: 'mesh-process', type: 'process' },
        ],
      )
      assert.deepEqual(discovered[0]?.nodes.map((node: ListedExtensionNode) => node.capabilityId), ['image-model/generate'])
      assert.deepEqual(discovered[1]?.nodes.map((node: ListedExtensionNode) => node.id), ['clean'])

      const finalEvent = progressEvents.at(-1)
      assert.equal(finalEvent?.step, 'done')
      assert.equal(finalEvent?.status, 'success')
      assert.equal(finalEvent?.reloaded, true)
    } finally {
      await rm(builtinDir, { recursive: true, force: true })
      await rm(extensionsDir, { recursive: true, force: true })
    }
  })
})

test('installGitHubExtensionRepo never reports failed setup or npm children as installed', async () => {
  const { installGitHubExtensionRepo } = await import(serviceModuleUrl)

  await withFixtureRepo('bundle-valid', async (repoDir) => {
    await writeFile(join(repoDir, 'extensions', 'image-model', 'setup.py'), 'print("setup")\n', 'utf-8')
    await writeFile(join(repoDir, 'extensions', 'mesh-process', 'package.json'), '{"name":"mesh-process"}\n', 'utf-8')

    const extensionsDir = await mkdtemp(join(tmpdir(), 'modly-installed-extensions-'))
    const progressEvents: InstallGitHubExtensionRepoProgress[] = []
    let reloadCalls = 0

    try {
      const result = await installGitHubExtensionRepo({
        githubUrl: 'https://github.com/acme/bundle-valid',
        extensionsDir,
        builtinExtensionIds: new Set(),
        trustedRepos: new Set(['https://github.com/acme/bundle-valid']),
        emitProgress: (event: InstallGitHubExtensionRepoProgress) => {
          progressEvents.push(event)
        },
        operations: {
          async downloadTarball() {},
          async extractTarball({ extractDir }: ExtractTarballInput) {
            await cp(repoDir, extractDir, { recursive: true })
          },
          async runExtensionSetup({ candidateId }: RunExtensionSetupInput) {
            if (candidateId === 'image-model') {
              throw new Error('simulated setup failure')
            }
          },
          async runNpmInstall({ candidateId }: RunNpmInstallInput) {
            if (candidateId === 'mesh-process') {
              throw new Error('simulated npm failure')
            }
          },
          async reloadExtensions(capabilities: Array<{ extensionId: string }>) {
            reloadCalls += 1
            return { reloaded: true, models: capabilities.map((c) => `${c.extensionId}/${c.extensionId === 'legacy-root-model' ? 'generate-mesh' : 'generate'}`), errors: {} }
          },
        },
      })

      assert.equal(result.success, false)
      assert.equal(result.status, 'error')
      assert.equal(result.extensionId, undefined)
      assert.equal(result.installed.length, 0)
      assert.deepEqual(result.installed, [])
      assert.deepEqual(
        result.failed.map((entry: FailedExtensionResult) => ({ extensionId: entry.extensionId, stage: entry.stage })),
        [
          { extensionId: 'image-model', stage: 'setup' },
          { extensionId: 'mesh-process', stage: 'npm' },
        ],
      )
      assert.equal(result.warnings.length, 0)
      assert.equal(result.reloaded, false)
      assert.equal(reloadCalls, 0)

      const childStatuses = progressEvents
        .filter((event) => event.step === 'child_result')
        .map((event) => ({ extensionId: event.extensionId, status: event.status }))
      assert.deepEqual(childStatuses, [
        { extensionId: 'image-model', status: 'error' },
        { extensionId: 'mesh-process', status: 'error' },
      ])

      const finalEvent = progressEvents.at(-1)
      assert.equal(finalEvent?.step, 'error')
      assert.equal(finalEvent?.status, 'error')
      assert.equal(finalEvent?.reloaded, false)
    } finally {
      await rm(extensionsDir, { recursive: true, force: true })
    }
  })
})

test('installGitHubExtensionRepo reports explicit mixed partial results when one bundled child succeeds and another fails setup', async () => {
  const { installGitHubExtensionRepo } = await import(serviceModuleUrl)

  await withFixtureRepo('bundle-valid', async (repoDir) => {
    await writeFile(join(repoDir, 'extensions', 'image-model', 'setup.py'), 'print("setup")\n', 'utf-8')

    const extensionsDir = await mkdtemp(join(tmpdir(), 'modly-installed-extensions-'))
    const progressEvents: InstallGitHubExtensionRepoProgress[] = []
    let reloadCalls = 0

    try {
      const result = await installGitHubExtensionRepo({
        githubUrl: 'https://github.com/acme/bundle-valid',
        extensionsDir,
        builtinExtensionIds: new Set(),
        trustedRepos: new Set(['https://github.com/acme/bundle-valid']),
        emitProgress: (event: InstallGitHubExtensionRepoProgress) => {
          progressEvents.push(event)
        },
        operations: {
          async downloadTarball() {},
          async extractTarball({ extractDir }: ExtractTarballInput) {
            await cp(repoDir, extractDir, { recursive: true })
          },
          async runExtensionSetup({ candidateId }: RunExtensionSetupInput) {
            if (candidateId === 'image-model') {
              throw new Error('simulated setup failure')
            }
          },
          async reloadExtensions(capabilities: Array<{ extensionId: string }>) {
            reloadCalls += 1
            return { reloaded: true, models: capabilities.map((c) => `${c.extensionId}/${c.extensionId === 'legacy-root-model' ? 'generate-mesh' : 'generate'}`), errors: {} }
          },
        },
      })

      assert.equal(result.success, true)
      assert.equal(result.status, 'partial')
      assert.deepEqual(
        result.installed.map((entry: InstalledExtensionResult) => ({ extensionId: entry.extensionId, status: entry.status })),
        [
          { extensionId: 'mesh-process', status: 'success' },
        ],
      )
      assert.deepEqual(
        result.failed.map((entry: FailedExtensionResult) => ({ extensionId: entry.extensionId, stage: entry.stage })),
        [{ extensionId: 'image-model', stage: 'setup' }],
      )
      assert.deepEqual(result.warnings, [])
      assert.equal(result.reloaded, true)
      assert.equal(reloadCalls, 1)
      assert.deepEqual(await readDirNames(extensionsDir), ['mesh-process'])

      const childStatuses = progressEvents
        .filter((event) => event.step === 'child_result')
        .map((event) => ({ extensionId: event.extensionId, status: event.status }))
      assert.deepEqual(childStatuses, [
        { extensionId: 'image-model', status: 'error' },
        { extensionId: 'mesh-process', status: 'success' },
      ])
    } finally {
      await rm(extensionsDir, { recursive: true, force: true })
    }
  })
})

test('installGitHubExtensionRepo returns aggregate error output without reload when no child can be committed', async () => {
  const { installGitHubExtensionRepo } = await import(serviceModuleUrl)

  await withFixtureRepo('legacy-root', async (repoDir) => {
    const extensionsDir = await mkdtemp(join(tmpdir(), 'modly-installed-extensions-'))
    const progressEvents: InstallGitHubExtensionRepoProgress[] = []
    let reloadCalls = 0

    try {
      const result = await installGitHubExtensionRepo({
        githubUrl: 'https://github.com/acme/legacy-root-model',
        extensionsDir,
        builtinExtensionIds: new Set(['legacy-root-model']),
        trustedRepos: new Set(['https://github.com/acme/legacy-root-model']),
        emitProgress: (event: InstallGitHubExtensionRepoProgress) => {
          progressEvents.push(event)
        },
        operations: {
          async downloadTarball() {},
          async extractTarball({ extractDir }: ExtractTarballInput) {
            await cp(repoDir, extractDir, { recursive: true })
          },
          async reloadExtensions(capabilities: Array<{ extensionId: string }>) {
            reloadCalls += 1
            return { reloaded: true, models: capabilities.map((c) => `${c.extensionId}/${c.extensionId === 'legacy-root-model' ? 'generate-mesh' : 'generate'}`), errors: {} }
          },
        },
      })

      assert.equal(result.success, false)
      assert.equal(result.status, 'error')
      assert.equal(result.extensionId, undefined)
      assert.deepEqual(result.installed, [])
      assert.deepEqual(
        result.failed.map((entry: FailedExtensionResult) => ({ extensionId: entry.extensionId, stage: entry.stage })),
        [{ extensionId: 'legacy-root-model', stage: 'commit' }],
      )
      assert.equal(result.reloaded, false)
      assert.equal(reloadCalls, 0)
      assert.match(result.error ?? '', /builtin extension id "legacy-root-model" cannot be replaced/i)

      const finalEvent = progressEvents.at(-1)
      assert.equal(finalEvent?.step, 'error')
      assert.equal(finalEvent?.status, 'error')
      assert.equal(finalEvent?.reloaded, false)
    } finally {
      await rm(extensionsDir, { recursive: true, force: true })
    }
  })
})

// Regression: registration is validation, not merely a best-effort reload.
test('a missing expected model rolls back its replacement while a healthy sibling survives', async () => {
  const { installGitHubExtensionRepo } = await import(serviceModuleUrl)
  await withFixtureRepo('bundle-valid', async (repoDir) => {
    const root = await mkdtemp(join(tmpdir(), 'modly-bundle-registration-'))
    try {
      await cp(join(repoDir, 'extensions/image-model'), join(root, 'image-model'), { recursive: true })
      await writeFile(join(root, 'image-model/previous.txt'), 'healthy previous version')
      let reloadCalls = 0
      const result = await installGitHubExtensionRepo({
        githubUrl: 'https://github.com/acme/bundle', extensionsDir: root,
        builtinExtensionIds: new Set(), trustedRepos: new Set(),
        operations: {
          async downloadTarball() {},
          async extractTarball({ extractDir }: ExtractTarballInput) { await cp(repoDir, extractDir, { recursive: true }) },
          async reloadExtensions() {
            reloadCalls++
            return { reloaded: true, models: reloadCalls === 1 ? [] : ['image-model/generate'], errors: {} }
          },
        },
      })
      assert.equal(result.status, 'partial')
      assert.deepEqual(result.installed.map((entry: InstalledExtensionResult) => entry.extensionId), ['mesh-process'])
      assert.equal(result.failed[0]?.stage, 'reload')
      assert.equal(await readFile(join(root, 'image-model/previous.txt'), 'utf8'), 'healthy previous version')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

test('bundle validation uses the current host manifest contract and rejects unsafe identifiers', async () => {
  const { discoverInstallCandidates, validateInstallCandidates } = await import(serviceModuleUrl)
  await withFixtureRepo('legacy-root', async (repoDir) => {
    const manifestPath = join(repoDir, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    for (const id of ['../escape', 'nested/root', 'node\\escape']) {
      await writeFile(manifestPath, JSON.stringify({ ...manifest, id }))
      await assert.rejects(async () => validateInstallCandidates({ repoDir, sourceRepo: 'https://github.com/acme/test', discovery: await discoverInstallCandidates(repoDir) }))
    }
  })
})

test('one aggregate reload validates every model child and keeps pending backups until validation', async () => {
  const { installGitHubExtensionRepo } = await import(serviceModuleUrl)
  const { activeExtensionInstalls } = await import(automationModuleUrl)
  await withFixtureRepo('bundle-valid', async (repoDir) => {
    const secondDir = join(repoDir, 'extensions/second-model')
    await cp(join(repoDir, 'extensions/image-model'), secondDir, { recursive: true })
    const second = JSON.parse(await readFile(join(secondDir, 'manifest.json'), 'utf8'))
    second.id = 'second-model'; second.nodes.push({ id: 'alternate', input: 'capture', output: 'video' })
    await writeFile(join(secondDir, 'manifest.json'), JSON.stringify(second))
    const root = await mkdtemp(join(tmpdir(), 'modly-bundle-all-models-'))
    try {
      await cp(join(repoDir, 'extensions/image-model'), join(root, 'image-model'), { recursive: true })
      await writeFile(join(root, 'image-model/old.txt'), 'previous')
      let reloads = 0
      const result = await installGitHubExtensionRepo({
        githubUrl: 'https://github.com/acme/all-models', extensionsDir: root,
        builtinExtensionIds: new Set(), trustedRepos: new Set(),
        operations: {
          async downloadTarball() {},
          async extractTarball({ extractDir }: ExtractTarballInput) { await cp(repoDir, extractDir, { recursive: true }) },
          async reloadExtensions(capabilities: Array<{ extensionId: string; stateName: string }>) {
            reloads++
            assert.deepEqual(capabilities.map((c) => c.extensionId), ['image-model', 'second-model'])
            assert.ok(activeExtensionInstalls.has('image-model'))
            assert.ok((await readDirNames(root)).some((name) => name.startsWith('.modly-backup-image-model-')))
            for (const capability of capabilities) assert.equal((await readJson(join(root, capability.stateName)) as { consumed: boolean }).consumed, false)
            return { reloaded: true, models: ['image-model/generate', 'second-model/generate', 'second-model/alternate'], errors: {} }
          },
        },
      })
      assert.equal(result.status, 'success')
      assert.equal(reloads, 1)
      assert.deepEqual(result.installed.map((entry: InstalledExtensionResult) => entry.extensionId), ['image-model', 'mesh-process', 'second-model'])
      assert.equal(activeExtensionInstalls.has('image-model'), false)
      assert.deepEqual(await readDirNames(root), ['image-model', 'mesh-process', 'second-model'])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

test('failed setup restores a healthy previous version and does not expose a failed replacement', async () => {
  const { installGitHubExtensionRepo } = await import(serviceModuleUrl)
  await withFixtureRepo('legacy-root', async (repoDir) => {
    const root = await mkdtemp(join(tmpdir(), 'modly-bundle-setup-rollback-'))
    try {
      await cp(repoDir, join(root, 'legacy-root-model'), { recursive: true })
      await writeFile(join(root, 'legacy-root-model/old.txt'), 'previous')
      await writeFile(join(repoDir, 'setup.py'), 'fixture only')
      const result = await installGitHubExtensionRepo({
        githubUrl: 'https://github.com/acme/legacy', extensionsDir: root, builtinExtensionIds: new Set(), trustedRepos: new Set(),
        operations: {
          async downloadTarball() {},
          async extractTarball({ extractDir }: ExtractTarballInput) { await cp(repoDir, extractDir, { recursive: true }) },
          async runExtensionSetup({ destinationDir }: RunExtensionSetupInput) { assert.equal(destinationDir, join(root, 'legacy-root-model')); throw new Error('fixture setup failed') },
          async reloadExtensions() { return { reloaded: true, models: ['legacy-root-model/generate-mesh'], errors: {} } },
        },
      })
      assert.deepEqual(result.installed, [])
      assert.equal(result.failed[0]?.stage, 'setup')
      assert.equal(await readFile(join(root, 'legacy-root-model/old.txt'), 'utf8'), 'previous')
      assert.deepEqual(await readDirNames(root), ['legacy-root-model'])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

test('registration transport failure preserves previous installs and quarantines fresh models', async () => {
  const { installGitHubExtensionRepo } = await import(serviceModuleUrl)
  await withFixtureRepo('legacy-root', async (repoDir) => {
    const root = await mkdtemp(join(tmpdir(), 'modly-bundle-reload-failure-'))
    try {
      const result = await installGitHubExtensionRepo({
        githubUrl: 'https://github.com/acme/legacy', extensionsDir: root, builtinExtensionIds: new Set(), trustedRepos: new Set(),
        operations: {
          async downloadTarball() {},
          async extractTarball({ extractDir }: ExtractTarballInput) { await cp(repoDir, extractDir, { recursive: true }) },
          async reloadExtensions() { throw new Error('fixture backend unavailable') },
        },
      })
      assert.equal(result.success, false)
      assert.equal(result.reloaded, false)
      assert.deepEqual(result.installed, [])
      assert.ok((await readDirNames(root)).some((name) => name.startsWith('.modly-registration-pending-legacy-root-model-')))
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

test('source validation rejects escape links, overlapping child roots, missing ids and current-contract violations', async () => {
  const { discoverInstallCandidates, validateInstallCandidates } = await import(serviceModuleUrl)
  const { symlink } = await import('node:fs/promises')
  await withFixtureRepo('bundle-valid', async (repoDir) => {
    const validate = async () => validateInstallCandidates({ repoDir, sourceRepo: 'https://github.com/acme/test', discovery: await discoverInstallCandidates(repoDir) })
    await symlink('../mesh-process', join(repoDir, 'extensions/image-model/outside-child'))
    await assert.rejects(validate, /escapes its root/)
    await rm(join(repoDir, 'extensions/image-model/outside-child'))
    await symlink('image-model', join(repoDir, 'extensions/alias'))
    await assert.rejects(validate, /Duplicate|overlap/)
    await rm(join(repoDir, 'extensions/alias'))
    const path = join(repoDir, 'extensions/image-model/manifest.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    const { id: _id, ...withoutId } = manifest
    await writeFile(path, JSON.stringify(withoutId))
    await assert.rejects(validate, /"id" missing/)
    await writeFile(path, JSON.stringify({ ...manifest, model_sources: [] }))
    await assert.rejects(validate, /model_sources must be declared on a model node/)
  })
})

test('overlapping active installs are rejected without replacing or releasing another reservation', async () => {
  const { installGitHubExtensionRepo } = await import(serviceModuleUrl)
  const { activeExtensionInstalls } = await import(automationModuleUrl)
  await withFixtureRepo('legacy-root', async (repoDir) => {
    const root = await mkdtemp(join(tmpdir(), 'modly-bundle-active-'))
    activeExtensionInstalls.add('legacy-root-model')
    try {
      const result = await installGitHubExtensionRepo({
        githubUrl: 'https://github.com/acme/legacy', extensionsDir: root, builtinExtensionIds: new Set(), trustedRepos: new Set(),
        operations: {
          async downloadTarball() {},
          async extractTarball({ extractDir }: ExtractTarballInput) { await cp(repoDir, extractDir, { recursive: true }) },
          async reloadExtensions() { throw new Error('must not reload') },
        },
      })
      assert.equal(result.success, false)
      assert.match(result.error ?? '', /already active/)
      assert.deepEqual(await readDirNames(root), [])
      assert.ok(activeExtensionInstalls.has('legacy-root-model'))
    } finally { activeExtensionInstalls.delete('legacy-root-model'); await rm(root, { recursive: true, force: true }) }
  })
})

test('an unrelated root manifest does not hide valid bundled children', async () => {
  const { discoverInstallCandidates, validateInstallCandidates } = await import(serviceModuleUrl)
  await withFixtureRepo('bundle-valid', async (repoDir) => {
    await writeFile(join(repoDir, 'manifest.json'), JSON.stringify({ name: 'repository metadata' }))
    const plan = await validateInstallCandidates({ repoDir, sourceRepo: 'https://github.com/acme/bundle', discovery: await discoverInstallCandidates(repoDir) })
    assert.equal(plan.mode, 'bundle')
    assert.deepEqual(plan.candidates.map((c: { id: string }) => c.id), ['image-model', 'mesh-process'])
  })
})

test('a registered first model cannot mask a missing second model in the aggregate response', async () => {
  const { installGitHubExtensionRepo } = await import(serviceModuleUrl)
  await withFixtureRepo('bundle-valid', async (repoDir) => {
    const secondDir = join(repoDir, 'extensions/second-model')
    await cp(join(repoDir, 'extensions/image-model'), secondDir, { recursive: true })
    const manifest = JSON.parse(await readFile(join(secondDir, 'manifest.json'), 'utf8'))
    manifest.id = 'second-model'
    await writeFile(join(secondDir, 'manifest.json'), JSON.stringify(manifest))
    const root = await mkdtemp(join(tmpdir(), 'modly-missing-second-'))
    try {
      let reloads = 0
      const result = await installGitHubExtensionRepo({
        githubUrl: 'https://github.com/acme/bundle', extensionsDir: root, builtinExtensionIds: new Set(), trustedRepos: new Set(),
        operations: {
          async downloadTarball() {},
          async extractTarball({ extractDir }: ExtractTarballInput) { await cp(repoDir, extractDir, { recursive: true }) },
          async reloadExtensions() { reloads++; return { reloaded: true, models: ['image-model/generate'], errors: {} } },
        },
      })
      assert.equal(result.status, 'partial')
      assert.deepEqual(result.installed.map((entry: InstalledExtensionResult) => entry.extensionId), ['image-model', 'mesh-process'])
      assert.deepEqual(result.failed.map((entry: FailedExtensionResult) => entry.extensionId), ['second-model'])
      assert.match(result.failed[0].error, /missing model ID.*second-model\/generate/)
      assert.equal(reloads, 2, 'only failure recovery gets an additional reload')
      assert.ok((await readDirNames(root)).some((name) => name.startsWith('.modly-registration-pending-second-model-')))
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

test('a failed update restores a local symlink without touching its developer source tree', async () => {
  const { installGitHubExtensionRepo } = await import(serviceModuleUrl)
  const { symlink, lstat } = await import('node:fs/promises')
  await withFixtureRepo('legacy-root', async (repoDir) => {
    const root = await mkdtemp(join(tmpdir(), 'modly-local-link-update-'))
    const developerSource = join(root, 'source')
    const installedRoot = join(root, 'installed')
    const { mkdir } = await import('node:fs/promises')
    try {
      await mkdir(installedRoot)
      await cp(repoDir, developerSource, { recursive: true })
      await symlink(developerSource, join(installedRoot, 'legacy-root-model'))
      const original = await readFile(join(developerSource, 'manifest.json'), 'utf8')
      await writeFile(join(repoDir, 'setup.py'), 'fixture')
      const result = await installGitHubExtensionRepo({
        githubUrl: 'https://github.com/acme/legacy', extensionsDir: installedRoot, builtinExtensionIds: new Set(), trustedRepos: new Set(),
        operations: {
          async downloadTarball() {},
          async extractTarball({ extractDir }: ExtractTarballInput) { await cp(repoDir, extractDir, { recursive: true }) },
          async runExtensionSetup() { throw new Error('fixture setup failed') },
          async reloadExtensions() { return { reloaded: true, models: ['legacy-root-model/generate-mesh'], errors: {} } },
        },
      })
      assert.equal(result.success, false)
      assert.ok((await lstat(join(installedRoot, 'legacy-root-model'))).isSymbolicLink())
      assert.equal(await readFile(join(developerSource, 'manifest.json'), 'utf8'), original)
      assert.deepEqual(await readDirNames(developerSource), ['generator.py', 'manifest.json'])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

test('recovery must confirm that quarantined failed model IDs are absent', async () => {
  const { installGitHubExtensionRepo } = await import(serviceModuleUrl)
  await withFixtureRepo('legacy-root', async (repoDir) => {
    const root = await mkdtemp(join(tmpdir(), 'modly-quarantine-confirmation-'))
    try {
      let reloads = 0
      const result = await installGitHubExtensionRepo({
        githubUrl: 'https://github.com/acme/legacy', extensionsDir: root, builtinExtensionIds: new Set(), trustedRepos: new Set(),
        operations: {
          async downloadTarball() {},
          async extractTarball({ extractDir }: ExtractTarballInput) { await cp(repoDir, extractDir, { recursive: true }) },
          async reloadExtensions() { reloads++; return { reloaded: true, models: reloads === 1 ? [] : ['legacy-root-model/generate-mesh'], errors: {} } },
        },
      })
      assert.equal(result.success, false)
      assert.equal(result.reloaded, false)
      assert.match(result.warnings.join('; '), /still registered/)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

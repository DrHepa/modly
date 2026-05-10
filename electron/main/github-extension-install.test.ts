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
        /broken-model.*generator\.py missing/i,
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

test('validateInstallCandidates rejects bundled children with traversal ids before commit', async () => {
  const { discoverInstallCandidates, validateInstallCandidates } = await import(serviceModuleUrl)

  await withFixtureRepo('bundle-valid', async (repoDir) => {
    await writeFile(join(repoDir, 'extensions', 'image-model', 'manifest.json'), `${JSON.stringify({
      id: '../escape',
      type: 'model',
      generator_class: 'ImageModel',
      nodes: [{ id: 'generate', input: 'image', output: 'mesh' }],
    }, null, 2)}\n`, 'utf-8')

    const discovery = await discoverInstallCandidates(repoDir)

    await assert.rejects(
      () => validateInstallCandidates({
        repoDir,
        sourceRepo: 'https://github.com/acme/bundle-valid',
        discovery,
      }),
      /path separators|must match|absolute path/i,
    )
  })
})

test('discoverInstallCandidates drops legacy root manifests with absolute ids from the installable path', async () => {
  const { discoverInstallCandidates, validateInstallCandidates } = await import(serviceModuleUrl)

  await withFixtureRepo('legacy-root', async (repoDir) => {
    await writeFile(join(repoDir, 'manifest.json'), `${JSON.stringify({
      id: '/abs/path',
      type: 'model',
      generator_class: 'LegacyRootModel',
      source: 'https://example.com/not-canonical',
      nodes: [{ id: 'generate-mesh', input: 'image', output: 'mesh' }],
    }, null, 2)}\n`, 'utf-8')

    const discovery = await discoverInstallCandidates(repoDir)

    assert.equal(discovery.candidates.length, 0)
    await assert.rejects(
      () => validateInstallCandidates({
        repoDir,
        sourceRepo: 'https://github.com/acme/legacy-root-model/',
        discovery,
      }),
      /No installable extensions found in repository/i,
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
    await cp(join(fixturesRoot, 'legacy-root'), existingDir, { recursive: true })
    await writeFile(join(existingDir, 'user-owned.txt'), 'keep-me', 'utf-8')

    try {
      await assert.rejects(
        () => commitInstallPlan({
          plan,
          extensionsDir,
            builtinExtensionIds: new Set(),
            operations: {
            async copyDirectory(sourceDir: string, targetDir: string) {
              if (targetDir === join(extensionsDir, 'image-model')) {
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
      assert.equal(restoredManifest.id, 'legacy-root-model')
      assert.deepEqual(await readDirNames(extensionsDir), ['image-model'])
    } finally {
      await rm(extensionsDir, { recursive: true, force: true })
    }
  })
})

test('commitInstallPlan rejects unsafe candidate ids before copying', async () => {
  const { commitInstallPlan } = await import(serviceModuleUrl)

  const extensionsDir = await mkdtemp(join(tmpdir(), 'modly-installed-extensions-'))
  let copied = false

  try {
    await assert.rejects(
      () => commitInstallPlan({
        plan: {
          mode: 'legacy',
          reloadCount: 1,
          sourceRepo: 'https://github.com/acme/legacy-root-model',
          candidates: [{
            id: '../escape',
            type: 'model',
            sourceDir: fixturesRoot,
            relativePath: '.',
            manifest: { id: '../escape', type: 'model', generator_class: 'Fake', nodes: [{ id: 'generate', input: 'image', output: 'mesh' }] },
            entryFile: 'generator.py',
            requiresSetup: false,
          }],
        },
        extensionsDir,
        builtinExtensionIds: new Set(),
        operations: {
          async copyDirectory() {
            copied = true
          },
        },
      }),
      /path separators/i,
    )

    assert.equal(copied, false)
  } finally {
    await rm(extensionsDir, { recursive: true, force: true })
  }
})

test('commitInstallPlan keeps committed children installed when a post-copy step fails', async () => {
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

      assert.equal(await stat(join(extensionsDir, 'image-model')).then(() => true, () => false), true)
      assert.equal(await stat(join(extensionsDir, 'mesh-process')).then(() => true, () => false), false)

      const copiedManifest = await readJson(join(extensionsDir, 'image-model', 'manifest.json')) as { id?: string; source?: string }
      assert.equal(copiedManifest.id, 'image-model')
      assert.equal(copiedManifest.source, 'https://github.com/acme/bundle-valid')
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
          async reloadExtensions() {
            reloadCalls += 1
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
          async reloadExtensions() {
            reloadCalls += 1
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

test('installGitHubExtensionRepo reports partial aggregate results when copied children fail setup or npm install and still reloads once', async () => {
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
          async reloadExtensions() {
            reloadCalls += 1
          },
        },
      })

      assert.equal(result.success, true)
      assert.equal(result.status, 'partial')
      assert.equal(result.extensionId, undefined)
      assert.equal(result.installed.length, 2)
      assert.deepEqual(
        result.installed.map((entry: InstalledExtensionResult) => ({ extensionId: entry.extensionId, status: entry.status })),
        [
          { extensionId: 'image-model', status: 'partial' },
          { extensionId: 'mesh-process', status: 'partial' },
        ],
      )
      assert.deepEqual(
        result.failed.map((entry: FailedExtensionResult) => ({ extensionId: entry.extensionId, stage: entry.stage })),
        [
          { extensionId: 'image-model', stage: 'setup' },
          { extensionId: 'mesh-process', stage: 'npm' },
        ],
      )
      assert.equal(result.warnings.length, 2)
      assert.equal(result.reloaded, true)
      assert.equal(reloadCalls, 1)

      const childStatuses = progressEvents
        .filter((event) => event.step === 'child_result')
        .map((event) => ({ extensionId: event.extensionId, status: event.status }))
      assert.deepEqual(childStatuses, [
        { extensionId: 'image-model', status: 'partial' },
        { extensionId: 'mesh-process', status: 'partial' },
      ])

      const finalEvent = progressEvents.at(-1)
      assert.equal(finalEvent?.step, 'done')
      assert.equal(finalEvent?.status, 'partial')
      assert.equal(finalEvent?.reloaded, true)
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
          async reloadExtensions() {
            reloadCalls += 1
          },
        },
      })

      assert.equal(result.success, true)
      assert.equal(result.status, 'partial')
      assert.deepEqual(
        result.installed.map((entry: InstalledExtensionResult) => ({ extensionId: entry.extensionId, status: entry.status })),
        [
          { extensionId: 'image-model', status: 'partial' },
          { extensionId: 'mesh-process', status: 'success' },
        ],
      )
      assert.deepEqual(
        result.failed.map((entry: FailedExtensionResult) => ({ extensionId: entry.extensionId, stage: entry.stage })),
        [{ extensionId: 'image-model', stage: 'setup' }],
      )
      assert.deepEqual(result.warnings, ['image-model: simulated setup failure'])
      assert.equal(result.reloaded, true)
      assert.equal(reloadCalls, 1)
      assert.deepEqual(await readDirNames(extensionsDir), ['image-model', 'mesh-process'])

      const childStatuses = progressEvents
        .filter((event) => event.step === 'child_result')
        .map((event) => ({ extensionId: event.extensionId, status: event.status }))
      assert.deepEqual(childStatuses, [
        { extensionId: 'image-model', status: 'partial' },
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
          async reloadExtensions() {
            reloadCalls += 1
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

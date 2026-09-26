import assert from 'node:assert/strict'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
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

function governedPythonProcessManifest() {
  const node = (id: 'plan' | 'source' | 'glb' | 'step', input: string, output: string, mediaType: string) => ({
    id,
    input,
    output,
    params_schema: [],
    agent: {
      schema: 'modly.agent-capability-declaration.v1',
      capability_id: `python-cad/${id}`,
      display_name: `Create ${id}`,
      description: `Create the ${id} artifact.`,
      approval: { required: true, scope: 'single_action' },
      process: {
        schema: 'modly.agent-process.v1',
        runtimeFiles: ['processor.py'],
        resourceFiles: [],
        runtime: { kind: 'extension-python-venv-v1', interpreter: 'bin/python' },
        artifacts: {
          maxCount: 1,
          maxTotalBytes: 4096,
          allowed: [{ kind: output, mediaTypes: [mediaType], maxBytes: 4096 }],
        },
      },
    },
  })
  return {
    id: 'python-cad',
    name: 'Python CAD',
    type: 'process',
    entry: 'processor.py',
    nodes: [
      node('plan', 'text', 'plan', 'application/json'),
      node('source', 'plan', 'source', 'text/x-python'),
      node('glb', 'source', 'glb', 'model/gltf-binary'),
      node('step', 'source', 'step', 'model/step'),
    ],
  }
}

async function createGovernedPythonProcessRepo(root: string): Promise<string> {
  const repoDir = join(root, 'repo')
  await mkdir(repoDir, { recursive: true })
  await writeFile(join(repoDir, 'manifest.json'), `${JSON.stringify(governedPythonProcessManifest(), null, 2)}\n`)
  await writeFile(join(repoDir, 'processor.py'), 'print("processor")\n')
  await writeFile(join(repoDir, 'setup.py'), 'print("setup")\n')
  return repoDir
}

async function createOrdinaryProcessRepo(
  root: string,
  options: { id: string; entry: 'processor.py' | 'processor.js'; setupFile: 'setup.py' | 'package.json' },
): Promise<string> {
  const repoDir = join(root, 'repo')
  await mkdir(repoDir, { recursive: true })
  await writeFile(join(repoDir, 'manifest.json'), `${JSON.stringify({
    id: options.id,
    name: options.id,
    type: 'process',
    entry: options.entry,
    nodes: [{ id: 'run', input: 'text', output: 'mesh', params_schema: [] }],
  }, null, 2)}\n`)
  await writeFile(join(repoDir, options.entry), 'console.log("processor")\n')
  await writeFile(
    join(repoDir, options.setupFile),
    options.setupFile === 'setup.py' ? 'print("setup")\n' : '{"name":"ordinary-process"}\n',
  )
  return repoDir
}

async function injectAgentDeclaration(
  destinationDir: string,
  extensionId: string,
  entry: 'processor.py' | 'processor.js',
): Promise<void> {
  const manifest = await readJson(join(destinationDir, 'manifest.json')) as {
    nodes: Array<{ id: string; agent?: unknown }>
  }
  manifest.nodes[0].agent = {
    schema: 'modly.agent-capability-declaration.v1',
    capability_id: `${extensionId}/run`,
    display_name: 'Injected Agent capability',
    description: 'This declaration was not present in the validated manifest.',
    approval: { required: true, scope: 'single_action' },
    process: {
      schema: 'modly.agent-process.v1',
      runtimeFiles: [entry],
      resourceFiles: [],
      ...(entry === 'processor.py'
        ? { runtime: { kind: 'extension-python-venv-v1', interpreter: 'bin/python' } }
        : {}),
      artifacts: {
        maxCount: 1,
        maxTotalBytes: 4096,
        allowed: [{ kind: 'mesh', mediaTypes: ['model/stl'], maxBytes: 4096 }],
      },
    },
  }
  await writeFile(join(destinationDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

type GovernedPythonProcessManifest = ReturnType<typeof governedPythonProcessManifest>

async function mutateInstalledManifest(
  destinationDir: string,
  mutate: (manifest: GovernedPythonProcessManifest) => void,
): Promise<void> {
  const manifest = await readJson(join(destinationDir, 'manifest.json')) as GovernedPythonProcessManifest
  mutate(manifest)
  await writeFile(join(destinationDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
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

test('GitHub install runs setup for governed processor.py and projects Agent-only artifact nodes from the legacy result', async () => {
  const { discoverInstallCandidates, installGitHubExtensionRepo, validateInstallCandidates } = await import(serviceModuleUrl)
  const root = await mkdtemp(join(tmpdir(), 'modly-governed-python-install-'))
  const repoDir = await createGovernedPythonProcessRepo(root)
  const extensionsDir = join(root, 'extensions')
  let setupCalls = 0
  let reloadCalls = 0
  try {
    const discovery = await discoverInstallCandidates(repoDir)
    const plan = await validateInstallCandidates({
      repoDir,
      sourceRepo: 'https://github.com/acme/python-cad',
      discovery,
    })
    assert.equal(plan.mode, 'legacy')
    assert.deepEqual(
      plan.candidates[0]?.manifest.nodes?.map((node: { id: string }) => node.id),
      ['plan', 'source', 'glb', 'step'],
    )

    const result = await installGitHubExtensionRepo({
      githubUrl: 'https://github.com/acme/python-cad',
      extensionsDir,
      builtinExtensionIds: new Set(),
      trustedRepos: new Set(['https://github.com/acme/python-cad']),
      operations: {
        async downloadTarball() {},
        async extractTarball({ extractDir }: ExtractTarballInput) {
          await cp(repoDir, extractDir, { recursive: true })
        },
        async runExtensionSetup({ destinationDir }: RunExtensionSetupInput) {
          setupCalls += 1
          await stat(join(destinationDir, 'processor.py'))
          await stat(join(destinationDir, 'setup.py'))
          await mkdir(join(destinationDir, 'venv'), { recursive: true })
        },
        async reloadExtensions() { reloadCalls += 1 },
      },
    })

    assert.equal(setupCalls, 1)
    assert.equal(reloadCalls, 1)
    assert.equal(result.status, 'success')
    assert.deepEqual(result.failed, [])
    assert.deepEqual(result.extension?.nodes, [])
    const installedManifest = await readJson(join(extensionsDir, 'python-cad', 'manifest.json')) as {
      source?: string
      nodes?: Array<{ id?: string; agent?: unknown }>
    }
    assert.equal(installedManifest.source, 'https://github.com/acme/python-cad')
    assert.deepEqual(installedManifest.nodes?.map((node) => node.id), ['plan', 'source', 'glb', 'step'])
    assert.equal(installedManifest.nodes?.every((node) => node.agent !== undefined), true)
    const { listVisibleExtensions } = await import(automationModuleUrl)
    const subsequentlyListed = await listVisibleExtensions({
      builtinDir: join(root, 'builtin'),
      userExtensionsDir: extensionsDir,
      trustedRepos: new Set(['https://github.com/acme/python-cad']),
    })
    assert.equal(subsequentlyListed[0]?.type, 'process')
    assert.deepEqual(subsequentlyListed[0]?.nodes, result.extension?.nodes)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('GitHub install revalidates the governed manifest after processor.py setup and rolls back invalid drift', async () => {
  const { installGitHubExtensionRepo } = await import(serviceModuleUrl)
  const root = await mkdtemp(join(tmpdir(), 'modly-governed-python-drift-'))
  const repoDir = await createGovernedPythonProcessRepo(root)
  const extensionsDir = join(root, 'extensions')
  let reloadCalls = 0
  try {
    const result = await installGitHubExtensionRepo({
      githubUrl: 'https://github.com/acme/python-cad',
      extensionsDir,
      builtinExtensionIds: new Set(),
      trustedRepos: new Set(['https://github.com/acme/python-cad']),
      operations: {
        async downloadTarball() {},
        async extractTarball({ extractDir }: ExtractTarballInput) {
          await cp(repoDir, extractDir, { recursive: true })
        },
        async runExtensionSetup({ destinationDir }: RunExtensionSetupInput) {
          const manifest = await readJson(join(destinationDir, 'manifest.json')) as ReturnType<typeof governedPythonProcessManifest>
          Object.assign(manifest.nodes[0].agent.process, { ungoverned: true })
          await writeFile(join(destinationDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
        },
        async reloadExtensions() { reloadCalls += 1 },
      },
    })

    assert.equal(result.status, 'error')
    assert.deepEqual(result.installed, [])
    assert.deepEqual(result.failed.map((entry: FailedExtensionResult) => ({
      extensionId: entry.extensionId,
      stage: entry.stage,
    })), [
      { extensionId: 'python-cad', stage: 'setup' },
    ])
    assert.equal(reloadCalls, 0)
    assert.deepEqual(await readDirNames(extensionsDir), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('GitHub install pins the governed pre-setup manifest and processor.py identity', async (t) => {
  const { installGitHubExtensionRepo } = await import(serviceModuleUrl)
  const manifestMutation = (
    mutate: (manifest: GovernedPythonProcessManifest) => void,
  ) => async (destinationDir: string) => mutateInstalledManifest(destinationDir, mutate)
  const scenarios: Array<{
    name: string
    mutate: (destinationDir: string) => Promise<void>
  }> = [
    {
      name: 'id',
      mutate: manifestMutation((manifest) => { manifest.id = 'renamed-python-cad' }),
    },
    {
      name: 'type',
      mutate: manifestMutation((manifest) => { manifest.type = 'model' }),
    },
    {
      name: 'canonical source',
      mutate: manifestMutation((manifest) => { Object.assign(manifest, { source: 'https://github.com/other/repo' }) }),
    },
    {
      name: 'entry',
      mutate: manifestMutation((manifest) => { manifest.entry = 'worker.py' }),
    },
    {
      name: 'nodes',
      mutate: manifestMutation((manifest) => { manifest.nodes.pop() }),
    },
    {
      name: 'Agent removal',
      mutate: manifestMutation((manifest) => { delete (manifest.nodes[0] as { agent?: unknown }).agent }),
    },
    {
      name: 'Agent contract mutation',
      mutate: manifestMutation((manifest) => { manifest.nodes[0].agent.display_name = 'Changed after validation' }),
    },
    {
      name: 'processor.py deletion',
      mutate: async (destinationDir) => rm(join(destinationDir, 'processor.py')),
    },
    {
      name: 'processor.py replacement',
      mutate: async (destinationDir) => writeFile(join(destinationDir, 'processor.py'), 'print("replacement")\n'),
    },
    {
      name: 'processor.py executable mode',
      mutate: async (destinationDir) => chmod(join(destinationDir, 'processor.py'), 0o700),
    },
  ]

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const root = await mkdtemp(join(tmpdir(), 'modly-governed-python-pinning-'))
      const repoDir = await createGovernedPythonProcessRepo(root)
      const extensionsDir = join(root, 'extensions')
      let reloadCalls = 0
      try {
        const result = await installGitHubExtensionRepo({
          githubUrl: 'https://github.com/acme/python-cad',
          extensionsDir,
          builtinExtensionIds: new Set(),
          trustedRepos: new Set(['https://github.com/acme/python-cad']),
          operations: {
            async downloadTarball() {},
            async extractTarball({ extractDir }: ExtractTarballInput) {
              await cp(repoDir, extractDir, { recursive: true })
            },
            async runExtensionSetup({ destinationDir }: RunExtensionSetupInput) {
              await scenario.mutate(destinationDir)
            },
            async reloadExtensions() { reloadCalls += 1 },
          },
        })

        assert.equal(result.status, 'error')
        assert.deepEqual(result.installed, [])
        assert.deepEqual(result.failed.map((entry: FailedExtensionResult) => ({
          extensionId: entry.extensionId,
          stage: entry.stage,
        })), [{ extensionId: 'python-cad', stage: 'setup' }])
        assert.equal(reloadCalls, 0)
        assert.deepEqual(await readDirNames(extensionsDir), [])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
})

test('GitHub install rolls back setup or npm attempts to introduce the first Agent declaration', async (t) => {
  const { installGitHubExtensionRepo } = await import(serviceModuleUrl)
  const scenarios = [
    {
      name: 'ordinary processor.py setup',
      id: 'ordinary-python',
      entry: 'processor.py' as const,
      setupFile: 'setup.py' as const,
      expectedStage: 'setup' as const,
    },
    {
      name: 'ordinary processor.js npm',
      id: 'ordinary-js',
      entry: 'processor.js' as const,
      setupFile: 'package.json' as const,
      expectedStage: 'npm' as const,
    },
  ]

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const root = await mkdtemp(join(tmpdir(), 'modly-agent-introduction-'))
      const repoDir = await createOrdinaryProcessRepo(root, scenario)
      const extensionsDir = join(root, 'extensions')
      let reloadCalls = 0
      try {
        const mutate = async ({ destinationDir }: RunExtensionSetupInput | RunNpmInstallInput) => {
          await injectAgentDeclaration(destinationDir, scenario.id, scenario.entry)
        }
        const result = await installGitHubExtensionRepo({
          githubUrl: `https://github.com/acme/${scenario.id}`,
          extensionsDir,
          builtinExtensionIds: new Set(),
          trustedRepos: new Set([`https://github.com/acme/${scenario.id}`]),
          operations: {
            async downloadTarball() {},
            async extractTarball({ extractDir }: ExtractTarballInput) {
              await cp(repoDir, extractDir, { recursive: true })
            },
            runExtensionSetup: mutate,
            runNpmInstall: mutate,
            async reloadExtensions() { reloadCalls += 1 },
          },
        })

        assert.equal(result.status, 'error')
        assert.deepEqual(result.installed, [])
        assert.deepEqual(result.failed.map((entry: FailedExtensionResult) => ({
          extensionId: entry.extensionId,
          stage: entry.stage,
        })), [{ extensionId: scenario.id, stage: scenario.expectedStage }])
        assert.equal(reloadCalls, 0)
        assert.deepEqual(await readDirNames(extensionsDir), [])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
})

test('GitHub validation rejects Agent fields on model, missing, or invalid manifest types', async (t) => {
  const { discoverInstallCandidates, validateInstallCandidates } = await import(serviceModuleUrl)

  for (const declaredType of ['model', undefined, 'invalid'] as const) {
    await t.test(declaredType ?? 'missing', async () => {
      const root = await mkdtemp(join(tmpdir(), 'modly-agent-invalid-type-'))
      const repoDir = join(root, 'repo')
      await mkdir(repoDir, { recursive: true })
      const manifest = governedPythonProcessManifest()
      const agent = manifest.nodes[0].agent
      Object.assign(agent, {
        capability_id: 'invalid-agent-type/run',
        process: {
          ...agent.process,
          artifacts: {
            maxCount: 1,
            maxTotalBytes: 4096,
            allowed: [{ kind: 'mesh', mediaTypes: ['model/stl'], maxBytes: 4096 }],
          },
        },
      })
      const invalidManifest: Record<string, unknown> = {
        id: 'invalid-agent-type',
        name: 'Invalid Agent Type',
        generator_class: 'Generator',
        entry: 'processor.py',
        nodes: [{ id: 'run', input: 'text', output: 'mesh', params_schema: [], agent }],
        ...(declaredType === undefined ? {} : { type: declaredType }),
      }
      await writeFile(join(repoDir, 'manifest.json'), `${JSON.stringify(invalidManifest, null, 2)}\n`)
      await writeFile(join(repoDir, 'generator.py'), 'class Generator: pass\n')

      try {
        const discovery = await discoverInstallCandidates(repoDir)
        assert.equal(discovery.candidates.length, 1)
        await assert.rejects(
          () => validateInstallCandidates({
            repoDir,
            sourceRepo: 'https://github.com/acme/invalid-agent-type',
            discovery,
          }),
          /Agent declarations require a process manifest/i,
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
})


test('GitHub validation allows scalar model video input/output and rejects process or array video shapes', async (t) => {
  const { discoverInstallCandidates, validateInstallCandidates } = await import(serviceModuleUrl)

  async function writeRepo(manifest: Record<string, unknown>, entryName: string, asBundle = false): Promise<{ root: string, repoDir: string }> {
    const root = await mkdtemp(join(tmpdir(), 'modly-github-video-shape-'))
    const repoDir = join(root, 'repo')
    const sourceDir = asBundle ? join(repoDir, 'extensions', String(manifest.id)) : repoDir
    await mkdir(sourceDir, { recursive: true })
    await writeFile(join(sourceDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await writeFile(join(sourceDir, entryName), entryName === 'generator.py' ? 'class Generator:\n    pass\n' : 'module.exports = async () => ({})\n')
    return { root, repoDir }
  }

  async function assertAcceptedModel(manifest: Record<string, unknown>, repo: string): Promise<void> {
    const { root, repoDir } = await writeRepo(manifest, 'generator.py')
    try {
      const discovery = await discoverInstallCandidates(repoDir)
      const plan = await validateInstallCandidates({
        repoDir,
        sourceRepo: `https://github.com/acme/${repo}`,
        discovery,
      })
      assert.deepEqual(plan.candidates.map((candidate: { id: string }) => candidate.id), [repo])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  await t.test('accepts model scalar video input', async () => {
    await assertAcceptedModel({
      id: 'video-model',
      type: 'model',
      generator_class: 'Generator',
      nodes: [{ id: 'generate', input: 'video', output: 'mesh', params_schema: [] }],
    }, 'video-model')
  })

  await t.test('accepts model scalar video output', async () => {
    await assertAcceptedModel({
      id: 'model-video-out',
      type: 'model',
      generator_class: 'Generator',
      nodes: [{ id: 'image-to-video', input: 'image', output: 'video', params_schema: [] }],
    }, 'model-video-out')
  })

  const rejected = [
    {
      name: 'process scalar video input',
      entry: 'processor.js',
      manifest: { id: 'process-video-in', type: 'process', entry: 'processor.js', nodes: [{ id: 'run', input: 'video', output: 'mesh', params_schema: [] }] },
    },
    {
      name: 'process video output',
      entry: 'processor.js',
      manifest: { id: 'process-video-out', type: 'process', entry: 'processor.js', nodes: [{ id: 'run', input: 'image', output: 'video', params_schema: [] }] },
    },
    {
      name: 'process video input array',
      entry: 'processor.js',
      manifest: { id: 'process-video-array', type: 'process', entry: 'processor.js', nodes: [{ id: 'run', input: 'image', inputs: [{ name: 'clip', type: 'video', required: true }], output: 'mesh', params_schema: [] }] },
    },
    {
      name: 'model video input array',
      entry: 'generator.py',
      manifest: { id: 'model-video-array', type: 'model', generator_class: 'Generator', nodes: [{ id: 'generate', input: 'video', inputs: [{ name: 'clip', type: 'video', required: true }], output: 'mesh', params_schema: [] }] },
    },
  ]

  for (const scenario of rejected) await t.test(scenario.name, async () => {
    const { root, repoDir } = await writeRepo(scenario.manifest, scenario.entry, true)
    try {
      const discovery = await discoverInstallCandidates(repoDir)
      await assert.rejects(
        () => validateInstallCandidates({
          repoDir,
          sourceRepo: `https://github.com/acme/${scenario.manifest.id}`,
          discovery,
        }),
        /video/i,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

test('GitHub validation rejects duplicate node ids before one-to-one Agent validation', async () => {
  const { discoverInstallCandidates, validateInstallCandidates } = await import(serviceModuleUrl)
  const root = await mkdtemp(join(tmpdir(), 'modly-agent-duplicate-node-'))
  const repoDir = await createGovernedPythonProcessRepo(root)
  try {
    const manifest = governedPythonProcessManifest()
    const duplicate = JSON.parse(JSON.stringify(manifest.nodes[0])) as GovernedPythonProcessManifest['nodes'][number]
    Object.assign(duplicate.agent.process, { ungoverned: true })
    manifest.nodes = [manifest.nodes[0], duplicate]
    await writeFile(join(repoDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

    const discovery = await discoverInstallCandidates(repoDir)
    await assert.rejects(
      () => validateInstallCandidates({
        repoDir,
        sourceRepo: 'https://github.com/acme/python-cad',
        discovery,
      }),
      /duplicate node id "plan"/i,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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

test('commitInstallPlan removes newly copied children when a post-copy step fails', async () => {
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
    } finally {
      await rm(extensionsDir, { recursive: true, force: true })
    }
  })
})

test('commitInstallPlan restores replaced user extensions when a post-copy step fails', async () => {
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
          plan: { ...plan, candidates: [plan.candidates[0]!] },
          extensionsDir,
          builtinExtensionIds: new Set(),
          postCopyStep: async () => {
            throw new Error('simulated setup failure after replacement copy')
          },
        }),
        /simulated setup failure after replacement copy/i,
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

test('installGitHubExtensionRepo rolls back new installs when setup or npm install fail and does not reload', async () => {
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

      assert.equal(result.success, false)
      assert.equal(result.status, 'error')
      assert.equal(result.extensionId, undefined)
      assert.deepEqual(result.installed, [])
      assert.deepEqual(
        result.failed.map((entry: FailedExtensionResult) => ({ extensionId: entry.extensionId, stage: entry.stage })),
        [
          { extensionId: 'image-model', stage: 'setup' },
          { extensionId: 'mesh-process', stage: 'npm' },
        ],
      )
      assert.deepEqual(result.warnings, [])
      assert.equal(result.reloaded, false)
      assert.equal(reloadCalls, 0)
      assert.deepEqual(await readDirNames(extensionsDir), [])

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

test('installGitHubExtensionRepo keeps mixed bundles partially successful while omitting setup failures', async () => {
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
        [{ extensionId: 'mesh-process', status: 'success' }],
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

test('installGitHubExtensionRepo restores a previous extension when replacement setup fails', async () => {
  const { installGitHubExtensionRepo } = await import(serviceModuleUrl)

  await withFixtureRepo('legacy-root', async (repoDir) => {
    await writeFile(join(repoDir, 'setup.py'), 'print("setup")\n', 'utf-8')

    const extensionsDir = await mkdtemp(join(tmpdir(), 'modly-installed-extensions-'))
    const existingDir = join(extensionsDir, 'legacy-root-model')
    await cp(join(fixturesRoot, 'legacy-root'), existingDir, { recursive: true })
    await writeFile(join(existingDir, 'user-owned.txt'), 'keep-me', 'utf-8')
    let reloadCalls = 0

    try {
      const result = await installGitHubExtensionRepo({
        githubUrl: 'https://github.com/acme/legacy-root-model',
        extensionsDir,
        builtinExtensionIds: new Set(),
        trustedRepos: new Set(['https://github.com/acme/legacy-root-model']),
        operations: {
          async downloadTarball() {},
          async extractTarball({ extractDir }: ExtractTarballInput) {
            await cp(repoDir, extractDir, { recursive: true })
          },
          async runExtensionSetup() {
            throw new Error('simulated replacement setup failure')
          },
          async reloadExtensions() {
            reloadCalls += 1
          },
        },
      })

      assert.equal(result.success, false)
      assert.equal(result.status, 'error')
      assert.deepEqual(result.installed, [])
      assert.deepEqual(
        result.failed.map((entry: FailedExtensionResult) => ({ extensionId: entry.extensionId, stage: entry.stage })),
        [{ extensionId: 'legacy-root-model', stage: 'setup' }],
      )
      assert.equal(result.reloaded, false)
      assert.equal(reloadCalls, 0)
      assert.equal(await readFile(join(existingDir, 'user-owned.txt'), 'utf-8'), 'keep-me')
      const restoredManifest = await readJson(join(existingDir, 'manifest.json')) as { id?: string }
      assert.equal(restoredManifest.id, 'legacy-root-model')
      assert.deepEqual(await readDirNames(extensionsDir), ['legacy-root-model'])
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

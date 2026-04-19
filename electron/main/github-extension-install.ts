import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import axios from 'axios'
import { buildSync } from 'esbuild'
import * as tar from 'tar'
import { parseExtensionManifest, type ListedExtension, type ParsedManifest } from './automation-capabilities.ts'

export type InstallCandidateType = 'model' | 'process'

export type InstallCandidate = {
  id: string
  type: InstallCandidateType
  sourceDir: string
  relativePath: string
  manifest: ParsedManifest
  entryFile: string
  requiresSetup: boolean
}

export type InstallDiscovery = {
  mode: 'legacy' | 'bundle'
  candidates: InstallCandidate[]
}

export type ValidatedInstallPlan = {
  mode: 'legacy' | 'bundle'
  candidates: InstallCandidate[]
  reloadCount: 1
  sourceRepo: string
}

export type CommitInstallPlanInput = {
  plan: ValidatedInstallPlan
  extensionsDir: string
  builtinExtensionIds: ReadonlySet<string>
  operations?: Partial<InstallCommitOperations>
  postCopyStep?: (context: CommitPostCopyContext) => Promise<void>
}

export type InstallAggregateStatus = 'success' | 'partial' | 'error'

export type InstalledExtensionResult = {
  extensionId: string
  extension: ListedExtension
  status: Extract<InstallAggregateStatus, 'success' | 'partial'>
}

export type FailedExtensionResult = {
  extensionId: string
  stage: 'download' | 'extract' | 'validate' | 'commit' | 'setup' | 'npm' | 'reload'
  error: string
}

export type InstallGitHubExtensionRepoResult = {
  success: boolean
  status: InstallAggregateStatus
  installed: InstalledExtensionResult[]
  failed: FailedExtensionResult[]
  warnings: string[]
  reloaded: boolean
  extensionId?: string
  extension?: ListedExtension
  error?: string
}

export type InstallGitHubExtensionRepoProgress = InstallGitHubExtensionRepoResult & {
  step: 'downloading' | 'extracting' | 'validating' | 'setting_up' | 'child_result' | 'done' | 'error'
  percent?: number
  message?: string
}

export type DownloadTarballInput = {
  sourceRepo: string
  tarPath: string
  onProgress: (progress: { loaded: number; total?: number }) => void
}

export type ExtractTarballInput = {
  tarPath: string
  extractDir: string
}

export type RunExtensionSetupInput = {
  candidate: InstallCandidate
  candidateId: string
  destinationDir: string
  onLog?: (line: string) => void
}

export type RunNpmInstallInput = {
  candidate: InstallCandidate
  candidateId: string
  destinationDir: string
  onLog?: (line: string) => void
}

export type CompileTypeScriptEntryInput = {
  candidate: InstallCandidate
  destinationDir: string
  entryFile: string
}

export type InstallGitHubExtensionRepoInput = {
  githubUrl: string
  extensionsDir: string
  builtinExtensionIds: ReadonlySet<string>
  trustedRepos: Set<string>
  emitProgress?: (event: InstallGitHubExtensionRepoProgress) => void
  operations?: Partial<InstallGitHubExtensionRepoOperations>
}

export type InstallGitHubExtensionRepoOperations = {
  createTempDirectory(prefix: string): Promise<string>
  removeDirectory(dirPath: string): Promise<void>
  removeFile(filePath: string): Promise<void>
  ensureDirectory(dirPath: string): Promise<void>
  writeBinaryFile(filePath: string, content: Buffer): Promise<void>
  writeTextFile(filePath: string, content: string): Promise<void>
  downloadTarball(input: DownloadTarballInput): Promise<void>
  extractTarball(input: ExtractTarballInput): Promise<void>
  runExtensionSetup(input: RunExtensionSetupInput): Promise<void>
  runNpmInstall(input: RunNpmInstallInput): Promise<void>
  reloadExtensions(): Promise<void>
  compileTypeScriptEntry(input: CompileTypeScriptEntryInput): Promise<string>
}

export type CommitPostCopyContext = {
  candidate: InstallCandidate
  candidateId: string
  destinationDir: string
  replacedExisting: boolean
}

export type InstallCommitOperations = {
  ensureDirectory(dirPath: string): Promise<void>
  createTempDirectory(prefix: string): Promise<string>
  copyDirectory(sourceDir: string, targetDir: string): Promise<void>
  moveDirectory(sourceDir: string, targetDir: string): Promise<void>
  removeDirectory(dirPath: string): Promise<void>
  writeTextFile(filePath: string, content: string): Promise<void>
}

type ValidateInstallCandidatesInput = {
  repoDir: string
  sourceRepo: string
  discovery: InstallDiscovery
}

export async function discoverInstallCandidates(repoDir: string): Promise<InstallDiscovery> {
  const rootManifestPath = join(repoDir, 'manifest.json')
  if (existsSync(rootManifestPath)) {
    const rootManifest = await readManifest(rootManifestPath)
    const rootCandidate = createCandidate(repoDir, '.', rootManifest)

    if (isStructurallyValidCandidate(rootCandidate)) {
      return {
        mode: 'legacy',
        candidates: [rootCandidate],
      }
    }
  }

  const bundleDir = join(repoDir, 'extensions')
  if (!existsSync(bundleDir)) {
    return { mode: 'bundle', candidates: [] }
  }

  const entries = await readdir(bundleDir, { withFileTypes: true })
  const directories = entries.filter((entry) => entry.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))
  const candidates = await Promise.all(
    directories.map(async (entry) => {
      const relativePath = join('extensions', entry.name)
      const sourceDir = join(repoDir, relativePath)
      const manifest = await readManifest(join(sourceDir, 'manifest.json'))
      return createCandidate(sourceDir, relativePath, manifest)
    }),
  )

  return {
    mode: 'bundle',
    candidates,
  }
}

export async function validateInstallCandidates({ repoDir: _repoDir, sourceRepo, discovery }: ValidateInstallCandidatesInput): Promise<ValidatedInstallPlan> {
  if (discovery.candidates.length === 0) {
    throw new Error('No installable extensions found in repository')
  }

  const seenIds = new Set<string>()
  const candidates = discovery.candidates.map((candidate) => {
    validateCandidate(candidate)

    if (seenIds.has(candidate.id)) {
      throw new Error(`Duplicate extension id "${candidate.id}" found in install bundle`)
    }
    seenIds.add(candidate.id)

    return {
      ...candidate,
      manifest: {
        ...candidate.manifest,
        source: canonicalizeGitHubRepoUrl(sourceRepo),
      },
    }
  })

  return {
    mode: discovery.mode,
    candidates,
    reloadCount: 1,
    sourceRepo: canonicalizeGitHubRepoUrl(sourceRepo),
  }
}

export async function commitInstallPlan({
  plan,
  extensionsDir,
  builtinExtensionIds,
  operations,
  postCopyStep,
}: CommitInstallPlanInput): Promise<void> {
  for (const candidate of plan.candidates) {
    if (builtinExtensionIds.has(candidate.id)) {
      throw new Error(`Builtin extension id "${candidate.id}" cannot be replaced`)
    }
  }

  const fsOps = resolveInstallCommitOperations(operations)
  await fsOps.ensureDirectory(extensionsDir)

  const stagingRoot = await fsOps.createTempDirectory(join(tmpdir(), 'modly-github-install-stage-'))

  try {
    for (const candidate of plan.candidates) {
      const stagedDir = join(stagingRoot, candidate.id)
      await fsOps.copyDirectory(candidate.sourceDir, stagedDir)
      await persistCandidateManifest(fsOps, join(stagedDir, 'manifest.json'), candidate.manifest)

      await commitStagedCandidate({
        candidate,
        stagedDir,
        extensionsDir,
        fsOps,
        postCopyStep,
      })
    }
  } finally {
    await fsOps.removeDirectory(stagingRoot)
  }
}

export async function installGitHubExtensionRepo({
  githubUrl,
  extensionsDir,
  builtinExtensionIds,
  trustedRepos,
  emitProgress,
  operations,
}: InstallGitHubExtensionRepoInput): Promise<InstallGitHubExtensionRepoResult> {
  const fsOps = resolveGitHubInstallOperations(operations)
  const installed: InstalledExtensionResult[] = []
  const failed: FailedExtensionResult[] = []
  const warnings: string[] = []
  let reloaded = false

  const emit = (step: InstallGitHubExtensionRepoProgress['step'], extra?: Partial<InstallGitHubExtensionRepoProgress>) => {
    emitProgress?.({
      step,
      ...buildAggregateResult({ installed, failed, warnings, reloaded }),
      ...extra,
    })
  }

  let tempRoot = ''
  let tarPath = ''
  let extractDir = ''

  try {
    const sourceRepo = canonicalizeGitHubRepoUrl(githubUrl)
    tempRoot = await fsOps.createTempDirectory(join(tmpdir(), 'modly-github-install-'))
    tarPath = join(tempRoot, 'repo.tar.gz')
    extractDir = join(tempRoot, 'repo')

    emit('downloading', { percent: 0 })
    await fsOps.downloadTarball({
      sourceRepo,
      tarPath,
      onProgress: ({ loaded, total }) => {
        const percent = total ? Math.round((loaded / total) * 80) : 40
        emit('downloading', { percent })
      },
    })

    emit('extracting')
    await fsOps.extractTarball({ tarPath, extractDir })

    emit('validating')
    const discovery = await discoverInstallCandidates(extractDir)
    const plan = await validateInstallCandidates({
      repoDir: extractDir,
      sourceRepo,
      discovery,
    })

    const builtinCollisions = plan.candidates
      .filter((candidate) => builtinExtensionIds.has(candidate.id))
      .map<FailedExtensionResult>((candidate) => ({
        extensionId: candidate.id,
        stage: 'commit',
        error: `Builtin extension id "${candidate.id}" cannot be replaced`,
      }))

    if (builtinCollisions.length > 0) {
      failed.push(...builtinCollisions)
      const result = buildAggregateResult({ installed, failed, warnings, reloaded })
      emit('error', { status: result.status, error: result.error, message: result.error })
      return result
    }

    for (const candidate of plan.candidates) {
      try {
        await commitInstallPlan({
          plan: { ...plan, candidates: [candidate] },
          extensionsDir,
          builtinExtensionIds,
        })

        const settledCandidate = await settleCommittedCandidate({
          candidate,
          destinationDir: join(extensionsDir, candidate.id),
          trustedRepos,
          emitProgress,
          operations: fsOps,
        })

        installed.push(settledCandidate.installed)
        if (settledCandidate.failed) {
          failed.push(settledCandidate.failed)
        }
        if (settledCandidate.warning) {
          warnings.push(settledCandidate.warning)
        }

        emit('child_result', {
          extensionId: candidate.id,
          status: settledCandidate.installed.status,
          message: settledCandidate.failed?.error,
        })
      } catch (error) {
        const commitError = stringifyError(error)
        failed.push({
          extensionId: candidate.id,
          stage: 'commit',
          error: commitError,
        })

        emit('child_result', {
          extensionId: candidate.id,
          status: 'error',
          message: commitError,
        })
      }
    }

    if (installed.length > 0) {
      try {
        await fsOps.reloadExtensions()
        reloaded = true
      } catch (error) {
        warnings.push(`Extension reload failed: ${stringifyError(error)}`)
      }
    }

    const result = buildAggregateResult({ installed, failed, warnings, reloaded })
    emit(result.status === 'error' ? 'error' : 'done', {
      status: result.status,
      error: result.error,
      message: result.error,
      extensionId: result.extensionId,
      extension: result.extension,
      reloaded: result.reloaded,
    })
    return result
  } catch (error) {
    failed.push({
      extensionId: 'repository',
      stage: extractDir ? 'validate' : tarPath ? 'extract' : 'download',
      error: stringifyError(error),
    })

    const result = buildAggregateResult({ installed, failed, warnings, reloaded })
    emit('error', { status: result.status, error: result.error, message: result.error })
    return result
  } finally {
    if (tarPath && existsSync(tarPath)) {
      await fsOps.removeFile(tarPath)
    }
    if (extractDir && existsSync(extractDir)) {
      await fsOps.removeDirectory(extractDir)
    }
    if (tempRoot && existsSync(tempRoot)) {
      await fsOps.removeDirectory(tempRoot)
    }
  }
}

async function readManifest(manifestPath: string): Promise<ParsedManifest> {
  const raw = await readFile(manifestPath, 'utf-8')
  return JSON.parse(raw) as ParsedManifest
}

function createCandidate(sourceDir: string, relativePath: string, manifest: ParsedManifest): InstallCandidate {
  const type = manifest.type === 'process' ? 'process' : 'model'
  const id = manifest.id ?? fallbackIdFromRelativePath(relativePath)
  const entryFile = type === 'process' ? manifest.entry ?? 'processor.js' : 'generator.py'

  return {
    id,
    type,
    sourceDir,
    relativePath,
    manifest: {
      ...manifest,
      id,
      type,
    },
    entryFile,
    requiresSetup: existsSync(join(sourceDir, 'setup.py')),
  }
}

function fallbackIdFromRelativePath(relativePath: string): string {
  if (relativePath === '.') return 'manifest'
  const parts = relativePath.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? 'manifest'
}

function isStructurallyValidCandidate(candidate: InstallCandidate): boolean {
  try {
    validateCandidate(candidate)
    return true
  } catch {
    return false
  }
}

function validateCandidate(candidate: InstallCandidate): void {
  if (!candidate.manifest.id) {
    throw new Error(`${candidate.relativePath}: manifest.json missing required field "id"`)
  }

  if (!candidate.manifest.nodes?.length) {
    throw new Error(`${candidate.id}: manifest.json missing required field "nodes" or nodes is empty`)
  }

  if (candidate.type === 'process') {
    if (!existsSync(join(candidate.sourceDir, candidate.entryFile))) {
      throw new Error(`${candidate.id}: entry file "${candidate.entryFile}" missing`)
    }
    return
  }

  if (!existsSync(join(candidate.sourceDir, 'generator.py'))) {
    throw new Error(`${candidate.id}: generator.py missing`)
  }

  if (!candidate.manifest.generator_class) {
    throw new Error(`${candidate.id}: manifest.json missing required field "generator_class"`)
  }
}

function canonicalizeGitHubRepoUrl(sourceRepo: string): string {
  const parsed = new URL(sourceRepo.trim())
  if (parsed.hostname !== 'github.com') {
    throw new Error('Invalid GitHub source repo URL')
  }

  const parts = parsed.pathname.split('/').filter(Boolean)
  if (parts.length < 2) {
    throw new Error('Invalid GitHub source repo URL')
  }

  return `https://github.com/${parts[0]}/${parts[1]}`
}

async function settleCommittedCandidate({
  candidate,
  destinationDir,
  trustedRepos,
  emitProgress,
  operations,
}: {
  candidate: InstallCandidate
  destinationDir: string
  trustedRepos: Set<string>
  emitProgress?: (event: InstallGitHubExtensionRepoProgress) => void
  operations: InstallGitHubExtensionRepoOperations
}): Promise<{
  installed: InstalledExtensionResult
  failed?: FailedExtensionResult
  warning?: string
}> {
  const emitSetupLog = (line: string) => {
    emitProgress?.({
      step: 'setting_up',
      ...buildAggregateResult({ installed: [], failed: [], warnings: [], reloaded: false }),
      extensionId: candidate.id,
      message: line,
    })
  }

  let manifest = await readManifest(join(destinationDir, 'manifest.json'))

  try {
    if (candidate.type === 'process') {
      const currentEntry = manifest.entry ?? candidate.entryFile

      if (currentEntry.endsWith('.ts')) {
        const compiledEntry = await operations.compileTypeScriptEntry({
          candidate,
          destinationDir,
          entryFile: currentEntry,
        })
        manifest = { ...manifest, entry: compiledEntry }
        await operations.writeTextFile(join(destinationDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
      }

      const resolvedEntry = manifest.entry ?? candidate.entryFile
      if (resolvedEntry.endsWith('.py') && existsSync(join(destinationDir, 'setup.py'))) {
        await operations.runExtensionSetup({
          candidate,
          candidateId: candidate.id,
          destinationDir,
          onLog: emitSetupLog,
        })
      } else if (existsSync(join(destinationDir, 'package.json'))) {
        await operations.runNpmInstall({
          candidate,
          candidateId: candidate.id,
          destinationDir,
          onLog: emitSetupLog,
        })
      }
    } else if (existsSync(join(destinationDir, 'setup.py'))) {
      await operations.runExtensionSetup({
        candidate,
        candidateId: candidate.id,
        destinationDir,
        onLog: emitSetupLog,
      })
    }

    const extension = parseExtensionManifest(manifest, candidate.id, trustedRepos)
    return {
      installed: {
        extensionId: candidate.id,
        extension,
        status: 'success',
      },
    }
  } catch (error) {
    const stage = candidate.type === 'process' && existsSync(join(destinationDir, 'package.json')) ? 'npm' : 'setup'
    const extension = parseExtensionManifest(manifest, candidate.id, trustedRepos)
    const errorMessage = stringifyError(error)

    return {
      installed: {
        extensionId: candidate.id,
        extension,
        status: 'partial',
      },
      failed: {
        extensionId: candidate.id,
        stage,
        error: errorMessage,
      },
      warning: `${candidate.id}: ${errorMessage}`,
    }
  }
}

async function commitStagedCandidate({
  candidate,
  stagedDir,
  extensionsDir,
  fsOps,
  postCopyStep,
}: {
  candidate: InstallCandidate
  stagedDir: string
  extensionsDir: string
  fsOps: InstallCommitOperations
  postCopyStep?: (context: CommitPostCopyContext) => Promise<void>
}): Promise<void> {
  const destinationDir = join(extensionsDir, candidate.id)
  const backupDir = existsSync(destinationDir) ? join(extensionsDir, `.modly-backup-${candidate.id}-${Date.now()}`) : null

  try {
    if (backupDir) {
      await fsOps.moveDirectory(destinationDir, backupDir)
    }

    await fsOps.copyDirectory(stagedDir, destinationDir)

    if (backupDir) {
      await fsOps.removeDirectory(backupDir)
    }
  } catch (error) {
    await restoreBackupIfNeeded(fsOps, backupDir, destinationDir)
    throw error
  }

  if (postCopyStep) {
    await postCopyStep({
      candidate,
      candidateId: candidate.id,
      destinationDir,
      replacedExisting: backupDir !== null,
    })
  }
}

async function restoreBackupIfNeeded(fsOps: InstallCommitOperations, backupDir: string | null, destinationDir: string): Promise<void> {
  await fsOps.removeDirectory(destinationDir)

  if (backupDir) {
    await fsOps.moveDirectory(backupDir, destinationDir)
  }
}

async function persistCandidateManifest(fsOps: InstallCommitOperations, manifestPath: string, manifest: ParsedManifest): Promise<void> {
  await fsOps.writeTextFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

function resolveInstallCommitOperations(overrides?: Partial<InstallCommitOperations>): InstallCommitOperations {
  return {
    ensureDirectory: overrides?.ensureDirectory ?? (async (dirPath) => {
      await mkdir(dirPath, { recursive: true })
    }),
    createTempDirectory: overrides?.createTempDirectory ?? (async (prefix) => mkdtemp(prefix)),
    copyDirectory: overrides?.copyDirectory ?? (async (sourceDir, targetDir) => {
      await cp(sourceDir, targetDir, { recursive: true })
    }),
    moveDirectory: overrides?.moveDirectory ?? (async (sourceDir, targetDir) => {
      await rename(sourceDir, targetDir)
    }),
    removeDirectory: overrides?.removeDirectory ?? (async (dirPath) => {
      await rm(dirPath, { recursive: true, force: true })
    }),
    writeTextFile: overrides?.writeTextFile ?? (async (filePath, content) => {
      await writeFile(filePath, content, 'utf-8')
    }),
  }
}

function buildAggregateResult({
  installed,
  failed,
  warnings,
  reloaded,
}: {
  installed: InstalledExtensionResult[]
  failed: FailedExtensionResult[]
  warnings: string[]
  reloaded: boolean
}): InstallGitHubExtensionRepoResult {
  const status: InstallAggregateStatus = installed.length === 0
    ? 'error'
    : failed.length > 0 || warnings.length > 0 || !reloaded
      ? 'partial'
      : 'success'

  const legacyExtension = installed.length === 1 ? installed[0] : null

  return {
    success: status !== 'error',
    status,
    installed: [...installed],
    failed: [...failed],
    warnings: [...warnings],
    reloaded,
    extensionId: legacyExtension?.extensionId,
    extension: legacyExtension?.extension,
    error: failed[0]?.error,
  }
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function resolveGitHubInstallOperations(overrides?: Partial<InstallGitHubExtensionRepoOperations>): InstallGitHubExtensionRepoOperations {
  return {
    createTempDirectory: overrides?.createTempDirectory ?? (async (prefix) => mkdtemp(prefix)),
    removeDirectory: overrides?.removeDirectory ?? (async (dirPath) => {
      await rm(dirPath, { recursive: true, force: true })
    }),
    removeFile: overrides?.removeFile ?? (async (filePath) => {
      await rm(filePath, { force: true })
    }),
    ensureDirectory: overrides?.ensureDirectory ?? (async (dirPath) => {
      await mkdir(dirPath, { recursive: true })
    }),
    writeBinaryFile: overrides?.writeBinaryFile ?? (async (filePath, content) => {
      await writeFile(filePath, content)
    }),
    writeTextFile: overrides?.writeTextFile ?? (async (filePath, content) => {
      await writeFile(filePath, content, 'utf-8')
    }),
    downloadTarball: overrides?.downloadTarball ?? (async ({ sourceRepo, tarPath, onProgress }) => {
      const [owner, repo] = new URL(sourceRepo).pathname.split('/').filter(Boolean)
      const tarballUrl = `https://api.github.com/repos/${owner}/${repo}/tarball/HEAD`
      const response = await axios.get(tarballUrl, {
        responseType: 'arraybuffer',
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'Modly-App',
        },
        onDownloadProgress: (event) => {
          onProgress({ loaded: event.loaded, total: event.total })
        },
      })

      await writeFile(tarPath, Buffer.from(response.data as ArrayBuffer))
    }),
    extractTarball: overrides?.extractTarball ?? (async ({ tarPath, extractDir }) => {
      await mkdir(extractDir, { recursive: true })
      await tar.x({ file: tarPath, cwd: extractDir, strip: 1 })
    }),
    runExtensionSetup: overrides?.runExtensionSetup ?? (async () => {}),
    runNpmInstall: overrides?.runNpmInstall ?? defaultRunNpmInstall,
    reloadExtensions: overrides?.reloadExtensions ?? (async () => {}),
    compileTypeScriptEntry: overrides?.compileTypeScriptEntry ?? (async ({ destinationDir, entryFile }) => {
      const compiledEntry = entryFile.replace(/\.ts$/, '.js')
      buildSync({
        entryPoints: [join(destinationDir, entryFile)],
        outfile: join(destinationDir, compiledEntry),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
      })
      return compiledEntry
    }),
  }
}

async function defaultRunNpmInstall({ destinationDir, onLog }: RunNpmInstallInput): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const child = spawn(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: destinationDir,
      stdio: 'pipe',
    })

    let buffered = ''
    const handleChunk = (chunk: Buffer) => {
      buffered += chunk.toString()
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''

      for (const rawLine of lines) {
        const line = rawLine.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '').trim()
        if (line) {
          onLog?.(line)
        }
      }
    }

    child.stdout?.on('data', handleChunk)
    child.stderr?.on('data', handleChunk)
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`npm install failed (exit ${code})`)))
    child.on('error', reject)
  })
}

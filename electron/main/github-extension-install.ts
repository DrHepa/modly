import { existsSync, realpathSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, lstat, realpath, rm, writeFile } from 'node:fs/promises'
import { join, isAbsolute, relative, resolve, win32 } from 'node:path'
import { tmpdir } from 'node:os'
import axios from 'axios'
import { buildSync } from 'esbuild'
import * as tar from 'tar'
import { parseExtensionManifest, type ListedExtension, type ParsedManifest } from './automation-capabilities'
import { activeExtensionInstalls } from './automation-capabilities'
import { validateInstallManifest, validateExistingExtensionReplacement, expectedModelIds, validateExtensionReloadPayload, validateExtensionQuarantinePayload } from './extension-install-utils'
import { assertSafeExtensionId, resolveExtensionPathWithinRoot, buildExtensionBackupPath, buildExtensionStagingPath, EXT_INCOMPLETE_MARKER, EXT_REGISTRATION_PENDING_MARKER, EXT_VALIDATED_MARKER } from './extension-path-guard'
import { beginExtensionRegistrationTransaction, cleanupValidatedExtensionBackups, clearExtensionRegistrationTransaction, restoreExtensionBackup, renameWithRetry, rmWithRetry, validateExtensionDestinationRegistration, type ExtensionRegistrationValidationCapability } from './extension-install-recovery'

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
  beforeActivate?: (candidateId: string) => void
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
  reloadExtensions(capabilities: ExtensionRegistrationValidationCapability[]): Promise<unknown>
  terminateProcessRunner(extensionId: string): void
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

// Source containment allows internal symlinks, but never follows a link outside
// the individual install root. Copying dereferences validated links so they do
// not retain temporary extraction paths after the repository is removed.
function confinedPath(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel)
}

async function validateSourceTree(root: string, current = root, ancestors = new Set<string>()): Promise<void> {
  const physicalRoot = await realpath(root)
  const physical = await realpath(current)
  if (!confinedPath(physicalRoot, physical)) throw new Error(`Extension source escapes its root: ${current}`)
  const info = await lstat(current)
  const target = info.isSymbolicLink() ? await lstat(physical) : info
  if (!target.isDirectory() && !target.isFile()) throw new Error(`Unsupported extension source entry: ${current}`)
  if (!target.isDirectory()) return
  if (ancestors.has(physical)) throw new Error(`Cyclic extension source link: ${current}`)
  const next = new Set(ancestors).add(physical)
  for (const entry of await readdir(current)) await validateSourceTree(root, join(current, entry), next)
}

function entryExists(root: string, entry: string): boolean {
  if (typeof entry !== 'string' || !entry || isAbsolute(entry) || win32.isAbsolute(entry)
      || entry.split(/[\\/]/).includes('..')) return false
  const path = join(root, entry)
  try { return confinedPath(realpathSync(root), realpathSync(path)) && statSync(path).isFile() }
  catch { return false }
}

async function readManifest(path: string): Promise<ParsedManifest> {
  const manifest: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest.json must be an object')
  return manifest as ParsedManifest
}

function createCandidate(sourceDir: string, relativePath: string, manifest: ParsedManifest): InstallCandidate {
  return {
    id: manifest.id ?? '', type: manifest.type === 'process' ? 'process' : 'model',
    sourceDir, relativePath, manifest,
    entryFile: manifest.type === 'process' ? manifest.entry ?? 'processor.js' : 'generator.py',
    requiresSetup: existsSync(join(sourceDir, 'setup.py')),
  }
}

function validateCandidate(candidate: InstallCandidate): void {
  const validated = validateInstallManifest(candidate.manifest, {
    hasEntryFile: (entry) => entryExists(candidate.sourceDir, entry),
    hasGeneratorFile: () => entryExists(candidate.sourceDir, 'generator.py'),
  }, candidate.relativePath)
  assertSafeExtensionId(validated.id)
  if (!validated.hasNodes) throw new Error(`${candidate.id}: manifest.json required field "nodes" missing or empty`)
}

export async function discoverInstallCandidates(repoDir: string): Promise<InstallDiscovery> {
  if (existsSync(join(repoDir, 'manifest.json'))) {
    const candidate = createCandidate(repoDir, '.', await readManifest(join(repoDir, 'manifest.json')))
    // A valid root extension takes precedence. Repository metadata at the root
    // need not prevent a bundle, but a broken standalone extension still fails.
    try {
      validateCandidate(candidate)
      return { mode: 'legacy', candidates: [candidate] }
    } catch (error) {
      if (!existsSync(join(repoDir, 'extensions'))) throw error
    }
  }
  const bundleDir = join(repoDir, 'extensions')
  if (!existsSync(bundleDir)) return { mode: 'bundle', candidates: [] }
  if (!confinedPath(await realpath(repoDir), await realpath(bundleDir))) throw new Error('Bundle root escapes repository')
  const entries = (await readdir(bundleDir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const candidates: InstallCandidate[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const sourceDir = join(bundleDir, entry.name)
    if (!confinedPath(await realpath(repoDir), await realpath(sourceDir))) throw new Error('Bundle child escapes repository')
    if (!(await lstat(await realpath(sourceDir))).isDirectory()) continue
    const manifest = await readManifest(join(sourceDir, 'manifest.json'))
    candidates.push(createCandidate(sourceDir, `extensions/${entry.name}`, manifest))
  }
  return { mode: 'bundle', candidates }
}

export async function validateInstallCandidates({ repoDir, sourceRepo, discovery }: ValidateInstallCandidatesInput): Promise<ValidatedInstallPlan> {
  if (!discovery.candidates.length) throw new Error('No installable extensions found in repository')
  const seen = new Set<string>()
  const roots: string[] = []
  const candidates: InstallCandidate[] = []
  for (const candidate of discovery.candidates) {
    validateCandidate(candidate)
    const id = assertSafeExtensionId(candidate.manifest.id)
    if (seen.has(id)) throw new Error(`Duplicate extension id "${id}" found in install bundle`)
    seen.add(id)
    const root = await realpath(candidate.sourceDir)
    if (!confinedPath(await realpath(repoDir), root)) throw new Error('Extension source escapes repository')
    if (roots.some((other) => confinedPath(other, root) || confinedPath(root, other))) throw new Error('Install candidate roots overlap')
    roots.push(root)
    await validateSourceTree(candidate.sourceDir)
    const manifest = { ...candidate.manifest, id, source: canonicalizeGitHubRepoUrl(sourceRepo) }
    parseExtensionManifest(manifest, id, new Set(), false)
    candidates.push({ ...candidate, id, manifest })
  }
  return { mode: discovery.mode, candidates, sourceRepo: canonicalizeGitHubRepoUrl(sourceRepo), reloadCount: 1 }
}

function canonicalizeGitHubRepoUrl(url: string): string {
  const parsed = new URL(url.trim())
  const parts = parsed.pathname.split('/').filter(Boolean)
  if (parsed.hostname !== 'github.com' || parts.length < 2) throw new Error('Invalid GitHub source repo URL')
  return `https://github.com/${parts[0]}/${parts[1]}`
}

type PreparedInstall = {
  candidate: InstallCandidate
  destinationDir: string
  backupDir: string | null
  validationCapability: ExtensionRegistrationValidationCapability
  previousManifest?: ParsedManifest
}

async function validateDestination(candidate: InstallCandidate, extensionsDir: string): Promise<ParsedManifest | undefined> {
  const destinationDir = resolveExtensionPathWithinRoot(extensionsDir, candidate.id)
  // lstat catches a dangling local link as well as an existing install.
  const exists = await lstat(destinationDir).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error })
  if (!exists) return undefined
  let json: string
  try { json = await readFile(join(destinationDir, 'manifest.json'), 'utf8') }
  catch (error) { throw new Error(`Cannot safely replace extension "${candidate.id}": manifest.json missing or unreadable. Uninstall it first. ${String(error)}`) }
  validateExistingExtensionReplacement(json, candidate.manifest, {
    hasEntryFile: (entry) => entryExists(destinationDir, entry),
    hasGeneratorFile: () => entryExists(destinationDir, 'generator.py'),
  }, 'existing extension folder')
  return JSON.parse(json) as ParsedManifest
}

function assertMutation(result: { ok: true } | { ok: false; error: unknown; stage?: string }, label: string): void {
  if (!result.ok) throw new Error(`${label}: ${String(result.error)}. Restart Modly to retry recovery.`)
}

async function rollbackPrepared(transaction: PreparedInstall, extensionsDir: string, registrationFailure: boolean): Promise<void> {
  if (transaction.backupDir) {
    assertMutation(await restoreExtensionBackup(transaction.destinationDir, transaction.backupDir), 'Could not restore the previous extension')
    assertMutation(await clearExtensionRegistrationTransaction(extensionsDir, transaction.candidate.id), 'Could not clear recovery state')
  } else if (!registrationFailure) {
    assertMutation(await rmWithRetry(transaction.destinationDir, 'ext-install'), 'Could not remove incomplete extension')
    assertMutation(await clearExtensionRegistrationTransaction(extensionsDir, transaction.candidate.id), 'Could not clear recovery state')
  }
  // Fresh registration failures retain the host-owned pending sidecar: neither
  // manifest discovery nor the registry may treat an unvalidated child as ready.
}

export async function commitInstallPlan({ plan, extensionsDir, builtinExtensionIds, operations, postCopyStep, beforeActivate }: CommitInstallPlanInput): Promise<PreparedInstall[]> {
  for (const candidate of plan.candidates) {
    assertSafeExtensionId(candidate.id)
    if (builtinExtensionIds.has(candidate.id)) throw new Error(`Builtin extension id "${candidate.id}" cannot be replaced`)
    await validateDestination(candidate, extensionsDir)
  }
  const copy = operations?.copyDirectory ?? (async (from: string, to: string) => { await cp(from, to, { recursive: true, dereference: true, errorOnExist: true, force: false }) })
  await mkdir(extensionsDir, { recursive: true })
  const transactions: PreparedInstall[] = []
  for (const candidate of plan.candidates) {
    const destinationDir = resolveExtensionPathWithinRoot(extensionsDir, candidate.id)
    const previousManifest = await validateDestination(candidate, extensionsDir)
    // A collision cannot merge into another attempt's staging tree.
    const suffix = String(Date.now())
    const stagingDir = buildExtensionStagingPath(extensionsDir, candidate.id, suffix)
    const backupDir = previousManifest ? buildExtensionBackupPath(extensionsDir, candidate.id, suffix) : null
    if (existsSync(stagingDir) || (backupDir && existsSync(backupDir))) throw new Error('Install transaction path already exists; retry installation')
    let transaction: PreparedInstall | undefined
    let activated = false
    let parked = false
    try {
      await copy(candidate.sourceDir, stagingDir)
      for (const marker of [EXT_REGISTRATION_PENDING_MARKER, EXT_VALIDATED_MARKER]) await rm(join(stagingDir, marker), { recursive: true, force: true })
      await writeFile(join(stagingDir, 'manifest.json'), JSON.stringify(candidate.manifest, null, 2), 'utf8')
      await writeFile(join(stagingDir, EXT_INCOMPLETE_MARKER), new Date().toISOString(), 'utf8')
      const pending = await beginExtensionRegistrationTransaction(extensionsDir, candidate.id, suffix)
      if (!pending.ok) { assertMutation(pending, 'Could not mark registration pending'); throw new Error('Registration pending failed') }
      transaction = { candidate, destinationDir, backupDir, validationCapability: pending.validationCapability, previousManifest }
      beforeActivate?.(candidate.id)
      if (backupDir) { assertMutation(await renameWithRetry(destinationDir, backupDir, 'ext-install'), 'Current extension folder is locked'); parked = true }
      assertMutation(await renameWithRetry(stagingDir, destinationDir, 'ext-install'), 'Could not activate staged extension')
      activated = true
      await postCopyStep?.({ candidate, candidateId: candidate.id, destinationDir, replacedExisting: !!backupDir })
      await validateExtensionDestinationRegistration(destinationDir, async () => {}, 'ext-install')
      transactions.push(transaction)
    } catch (error) {
      if (transaction) {
        if (activated || parked) await rollbackPrepared(transaction, extensionsDir, false)
        else assertMutation(await clearExtensionRegistrationTransaction(extensionsDir, candidate.id), 'Could not clear recovery state')
      }
      throw error
    } finally {
      await rmWithRetry(stagingDir, 'ext-install')
    }
  }
  return transactions
}

export async function installGitHubExtensionRepo({ githubUrl, extensionsDir, builtinExtensionIds, trustedRepos, emitProgress, operations }: InstallGitHubExtensionRepoInput): Promise<InstallGitHubExtensionRepoResult> {
  const ops = resolveGitHubInstallOperations(operations)
  const installed: InstalledExtensionResult[] = []
  const failed: FailedExtensionResult[] = []
  const warnings: string[] = []
  const reserved: string[] = []
  const prepared: PreparedInstall[] = []
  const restoredModels: ParsedManifest[] = []
  let reloaded = false
  let tempRoot = ''
  let stage: FailedExtensionResult['stage'] = 'download'
  const emit = (step: InstallGitHubExtensionRepoProgress['step'], extra: Partial<InstallGitHubExtensionRepoProgress> = {}) => emitProgress?.({ step, ...buildAggregateResult({ installed, failed, warnings, reloaded }), ...extra })
  const fail = (id: string, failureStage: FailedExtensionResult['stage'], error: unknown) => {
    failed.push({ extensionId: id, stage: failureStage, error: stringifyError(error) })
    emit('child_result', { extensionId: id, status: 'error', message: stringifyError(error) })
  }
  try {
    const sourceRepo = canonicalizeGitHubRepoUrl(githubUrl)
    tempRoot = await ops.createTempDirectory(join(tmpdir(), 'modly-github-install-'))
    const tarPath = join(tempRoot, 'repo.tar.gz')
    const extractDir = join(tempRoot, 'repo')
    emit('downloading', { percent: 0 })
    await ops.downloadTarball({ sourceRepo, tarPath, onProgress: ({ loaded, total }) => emit('downloading', { percent: total ? Math.round(loaded / total * 80) : 40 }) })
    stage = 'extract'
    emit('extracting')
    await ops.extractTarball({ tarPath, extractDir })
    stage = 'validate'
    emit('validating')
    const plan = await validateInstallCandidates({ repoDir: extractDir, sourceRepo, discovery: await discoverInstallCandidates(extractDir) })
    // All identity, replacement and builtin checks precede destination writes.
    stage = 'commit'
    for (const candidate of plan.candidates) {
      if (builtinExtensionIds.has(candidate.id)) {
        fail(candidate.id, 'commit', `Builtin extension id "${candidate.id}" cannot be replaced`)
        const result = buildAggregateResult({ installed, failed, warnings, reloaded })
        emit('error', { error: result.error, message: result.error })
        return result
      }
      if (activeExtensionInstalls.has(candidate.id)) throw new Error(`Installation already active for "${candidate.id}"`)
      await validateDestination(candidate, extensionsDir)
    }
    // Check and reserve synchronously after async preflight to prevent overlap.
    if (plan.candidates.some((candidate) => activeExtensionInstalls.has(candidate.id))) throw new Error('An extension in this repository is already being installed')
    for (const candidate of plan.candidates) { activeExtensionInstalls.add(candidate.id); reserved.push(candidate.id) }
    for (const candidate of plan.candidates) {
      let childStage: FailedExtensionResult['stage'] = 'commit'
      const previous = await validateDestination(candidate, extensionsDir)
      try {
        const transactions = await commitInstallPlan({
          plan: { ...plan, candidates: [candidate] }, extensionsDir, builtinExtensionIds,
          beforeActivate: ops.terminateProcessRunner,
          async postCopyStep({ destinationDir }) {
            const log = (message: string) => emit('setting_up', { extensionId: candidate.id, message })
            if (candidate.type === 'process' && candidate.entryFile.endsWith('.ts')) {
              const entry = await ops.compileTypeScriptEntry({ candidate, destinationDir, entryFile: candidate.entryFile })
              candidate.manifest.entry = entry
              await ops.writeTextFile(join(destinationDir, 'manifest.json'), JSON.stringify(candidate.manifest, null, 2))
            }
            const python = candidate.type === 'model' || candidate.entryFile.endsWith('.py')
            if (python && existsSync(join(destinationDir, 'setup.py'))) {
              childStage = 'setup'
              await ops.runExtensionSetup({ candidate, candidateId: candidate.id, destinationDir, onLog: log })
            } else if (!python && existsSync(join(destinationDir, 'package.json'))) {
              childStage = 'npm'
              await ops.runNpmInstall({ candidate, candidateId: candidate.id, destinationDir, onLog: log })
            }
          },
        })
        prepared.push(...transactions)
      } catch (error) {
        fail(candidate.id, childStage, error)
        if (previous?.type !== 'process' && previous) restoredModels.push(previous)
      }
    }
    let payload: unknown
    let reloadError: unknown
    if (prepared.length || restoredModels.length) {
      try { payload = await ops.reloadExtensions(prepared.filter((t) => t.candidate.type === 'model').map((t) => t.validationCapability)); reloaded = true }
      catch (error) { reloadError = error; warnings.push(`Extension reload failed: ${stringifyError(error)}`) }
    }
    let recoveryNeeded = false
    const quarantineChecks: Array<{ extensionId: string; forbiddenIds: string[] }> = []
    for (const transaction of prepared) {
      const { candidate } = transaction
      try {
        if (candidate.type === 'model') {
          if (reloadError) throw reloadError
          validateExtensionReloadPayload(payload, candidate.id, expectedModelIds(candidate.manifest))
        }
        const extension = parseExtensionManifest(candidate.manifest, candidate.id, trustedRepos)
        assertMutation(await cleanupValidatedExtensionBackups(extensionsDir, candidate.id), 'Could not commit validated registration cleanup')
        installed.push({ extensionId: candidate.id, extension, status: 'success' })
        emit('child_result', { extensionId: candidate.id, status: 'success' })
      } catch (error) {
        // A failed cleanup may already have removed the rollback copy. Its
        // validated marker owns startup recovery; never delete the destination.
        if (transaction.backupDir && !existsSync(transaction.backupDir)) {
          fail(candidate.id, 'reload', error)
          continue
        }
        try {
          await rollbackPrepared(transaction, extensionsDir, true)
          if (transaction.previousManifest?.type !== 'process' && transaction.previousManifest) restoredModels.push(transaction.previousManifest)
        } catch (rollbackError) { warnings.push(stringifyError(rollbackError)) }
        fail(candidate.id, 'reload', error)
        if (candidate.type === 'model') {
          recoveryNeeded = true
          const previousIds = new Set(transaction.previousManifest ? expectedModelIds(transaction.previousManifest) : [])
          quarantineChecks.push({ extensionId: candidate.id, forbiddenIds: expectedModelIds(candidate.manifest).filter((id) => !previousIds.has(id)) })
        }
      }
    }
    // One aggregate validation reload on success. Failure recovery is a separate
    // reload: it evicts partially registered children and reactivates backups.
    if (recoveryNeeded) {
      try {
        payload = await ops.reloadExtensions([])
        for (const check of quarantineChecks) validateExtensionQuarantinePayload(payload, check.extensionId, check.forbiddenIds)
        for (const entry of installed) {
          const manifest = prepared.find((transaction) => transaction.candidate.id === entry.extensionId)!.candidate.manifest
          if (manifest.type !== 'process') validateExtensionReloadPayload(payload, entry.extensionId, expectedModelIds(manifest))
        }
        reloaded = true
      }
      catch (error) { reloaded = false; warnings.push(`Recovery reload failed: ${stringifyError(error)}`) }
    }
    if (reloaded) {
      for (const manifest of restoredModels) {
        try { validateExtensionReloadPayload(payload, manifest.id!, expectedModelIds(manifest)) }
        catch (error) { reloaded = false; warnings.push(`Previous extension restored on disk but runtime validation failed: ${stringifyError(error)}`) }
      }
    }
  } catch (error) { fail('repository', stage, error) }
  finally {
    for (const id of reserved) activeExtensionInstalls.delete(id)
    if (tempRoot) {
      try { await ops.removeDirectory(tempRoot) }
      catch (error) { warnings.push(`Temporary repository cleanup failed: ${stringifyError(error)}`) }
    }
  }
  const result = buildAggregateResult({ installed, failed, warnings, reloaded })
  emit(result.status === 'error' ? 'error' : 'done', { error: result.error, message: result.error, extensionId: result.extensionId, extension: result.extension })
  return result
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
    runExtensionSetup: overrides?.runExtensionSetup ?? (async () => { throw new Error('Python setup launcher is unavailable') }),
    runNpmInstall: overrides?.runNpmInstall ?? defaultRunNpmInstall,
    reloadExtensions: overrides?.reloadExtensions ?? (async () => { throw new Error('Runtime registration validator is unavailable') }),
    terminateProcessRunner: overrides?.terminateProcessRunner ?? (() => {}),
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
    const child = spawn(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts=false'], {
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

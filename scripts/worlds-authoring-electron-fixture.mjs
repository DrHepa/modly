#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inspect } from 'node:util'
import { build as esbuild, transform as esTransform } from 'esbuild'
import { build as viteBuild } from 'vite'
import { LOCAL_AI_PATH_ADMISSION, WORLD_SCULPT_BUNDLED_RELATIVE_PATH, WORLD_SCULPT_WORKSPACE_RELATIVE_PATH, createLocalAiConfig, parseReviewedAiModel, validateLocalAiConfig } from './worlds-authoring-electron-fixture/shared.ts'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureSource = path.join(repositoryRoot, 'scripts/worlds-authoring-electron-fixture')
const digest = (bytes) => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
export async function readWorldSculptBuildInput(sourcePath, expectedSha256) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath) || path.resolve(sourcePath) !== sourcePath || /[\0\r\n]/.test(sourcePath)) throw new Error('Canonical absolute WorldSculpt source required')
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('Lowercase WorldSculpt source digest required')
  const before = await lstat(sourcePath)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('WorldSculpt source must be a regular non-symlink file')
  if (await realpath(sourcePath) !== sourcePath) throw new Error('WorldSculpt source alias is forbidden')
  const handle = await open(sourcePath, 'r')
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('WorldSculpt source identity changed before read')
    const bytes = await handle.readFile()
    const after = await lstat(sourcePath)
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino || await realpath(sourcePath) !== sourcePath) throw new Error('WorldSculpt source identity changed during read')
    const actual = digest(bytes)
    if (actual.sha256 !== expectedSha256) throw new Error('WorldSculpt source digest mismatch')
    if (bytes.length < 12 || bytes.subarray(0, 4).toString('ascii') !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new Error('WorldSculpt source is not a canonical GLB v2 payload')
    return {
      bytes,
      sourceIdentity: Object.freeze({
        bytes: actual.bytes,
        sha256: actual.sha256,
        device: String(opened.dev),
        inode: String(opened.ino),
        uid: opened.uid,
        mode: opened.mode & 0o777,
      }),
    }
  } finally {
    await handle.close()
  }
}
export function materializeLocalAiConfig(root, admission = LOCAL_AI_PATH_ADMISSION) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root || root.includes('\0')) throw new Error('Canonical repository root required for local-AI paths')
  if (!admission || typeof admission !== 'object' || Array.isArray(admission)
    || Object.keys(admission).length !== 2 || !Object.hasOwn(admission, 'apiRootRelative') || !Object.hasOwn(admission, 'pythonPathRelative')
    || admission.apiRootRelative !== LOCAL_AI_PATH_ADMISSION.apiRootRelative
    || admission.pythonPathRelative !== LOCAL_AI_PATH_ADMISSION.pythonPathRelative) throw new Error('Invalid local-AI path admission')
  const materialize = (relative) => {
    if (typeof relative !== 'string' || !relative || relative.includes('\0') || path.isAbsolute(relative)
      || path.normalize(relative) !== relative || relative.split(path.sep).includes('..')) throw new Error('Invalid relative local-AI path admission')
    const absolute = path.resolve(root, relative)
    if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error('Local-AI path escaped repository root')
    return absolute
  }
  return createLocalAiConfig(materialize(admission.apiRootRelative), materialize(admission.pythonPathRelative))
}
const repositoryLocalAiConfig = materializeLocalAiConfig(repositoryRoot)
export function parseBuildArguments(args) {
  const keys = args.map((arg) => arg.split('=')[0])
  const identities = ['--ai-model', '--ai-model-digest', '--ai-tools-reviewed']
  const worldSculpt = args.includes('--worldsculpt-navigation')
  const allowedFlag = (arg) => ['--build-only', '--inherited-display', '--local-ai', '--ai-tools-reviewed', '--worldsculpt-navigation'].includes(arg)
    || /^--ai-model(?:-digest)?=.+$/.test(arg)
    || /^--worldsculpt-(?:source|sha256)=.+$/.test(arg)
  if (args.length > 6 || new Set(keys).size !== keys.length || args.some((arg) => !allowedFlag(arg)) || (args.includes('--local-ai') && !args.includes('--inherited-display'))) throw new Error('Usage: build-only [--inherited-display --local-ai --ai-model=<name> --ai-model-digest=sha256:<digest> --ai-tools-reviewed] OR build-only --inherited-display --worldsculpt-navigation --worldsculpt-source=<absolute-glb> --worldsculpt-sha256=<digest>. This entry NEVER launches native processes.')
  const identityCount = identities.filter((key) => keys.includes(key)).length
  if (worldSculpt) {
    const sourceArg = args.find((arg) => arg.startsWith('--worldsculpt-source='))
    const shaArg = args.find((arg) => arg.startsWith('--worldsculpt-sha256='))
    if (args.length !== 5 || !args.includes('--build-only') || !args.includes('--inherited-display') || args.includes('--local-ai') || identityCount
      || !sourceArg || !shaArg) throw new Error('WorldSculpt navigation requires one inherited-display build-only source and digest, without local AI')
    const source = sourceArg.slice('--worldsculpt-source='.length)
    const sha256 = shaArg.slice('--worldsculpt-sha256='.length)
    if (!path.isAbsolute(source) || path.resolve(source) !== source || /[\0\r\n]/.test(source) || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('WorldSculpt navigation requires a canonical absolute source and lowercase SHA-256')
    return { buildOnly: true, nativeMode: 'inherited-display', runtimeMode: 'worldsculpt-navigation', worldSculptSource: { path: source, sha256 } }
  }
  if (keys.some((key) => key.startsWith('--worldsculpt-'))) throw new Error('WorldSculpt source identity is forbidden outside its navigation lane')
  if (identityCount && (!args.includes('--local-ai') || identityCount !== 3)) throw new Error('Reviewed identity requires all three explicit local-AI fields')
  const reviewedAiModel = identityCount ? parseReviewedAiModel({ name: args.find((arg) => arg.startsWith('--ai-model=')).slice('--ai-model='.length), digest: args.find((arg) => arg.startsWith('--ai-model-digest=')).slice('--ai-model-digest='.length), toolsReviewed: args.includes('--ai-tools-reviewed') }) : null
  if (args.includes('--local-ai')) return { buildOnly: true, nativeMode: 'inherited-display', runtimeMode: 'local-ai', localAi: repositoryLocalAiConfig, ...(reviewedAiModel ? { reviewedAiModel } : {}) }
  return { buildOnly: true, nativeMode: args.includes('--inherited-display') ? 'inherited-display' : 'owned-xvfb' }
}
async function files(directory, prefix = '') {
  const result = []
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name)
    if (entry.isDirectory()) result.push(...await files(directory, relative))
    else if (entry.isFile()) result.push(relative)
    else throw new Error(`Unexpected build input/output type ${relative}`)
  }
  return result.sort()
}
const git = (args) => execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
export function createSourceCustody(root) {
  const sources = new Map(), incidentalArtifacts = new Map()
  const evidencePrefix = path.join(root, 'docs', 'worlds-engine-evidence') + path.sep
  const authenticationInput = (filename) => /(?:^|\.)xauthority(?:\.|$)/i.test(path.basename(filename))
  const sessionDataInput = (filename) => /\.ses$/i.test(path.basename(filename))
  const keyMaterialDataInput = (filename) => /\.(?:pem|key|p12|pfx)$/i.test(path.basename(filename))
  const forbiddenInput = (filename) => authenticationInput(filename) || sessionDataInput(filename) || keyMaterialDataInput(filename) || filename.startsWith(evidencePrefix)
  async function inspectInput(filename, canonicalEnumeration = false) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || path.resolve(filename) !== filename || filename.includes('\0')) throw new Error('Forbidden source input ' + filename)
    if (authenticationInput(filename) && !(canonicalEnumeration && filename.startsWith(evidencePrefix))) throw new Error('Forbidden source input ' + filename)
    if ((sessionDataInput(filename) || keyMaterialDataInput(filename)) && !canonicalEnumeration) throw new Error('Forbidden source input ' + filename)
    const info = await lstat(filename)
    if (canonicalEnumeration && (sessionDataInput(filename) || keyMaterialDataInput(filename) || filename.startsWith(evidencePrefix))) {
      incidentalArtifacts.set(filename, {
        path: filename, relativePath: path.relative(root, filename), classification: filename.startsWith(evidencePrefix) ? 'incidental-generated-evidence' : sessionDataInput(filename) ? 'incidental-session-data' : 'incidental-key-material-data',
        type: info.isFile() ? 'regular-file' : info.isSymbolicLink() ? 'symlink-not-followed' : info.isDirectory() ? 'directory' : 'other-nonregular',
        device: String(info.dev), inode: String(info.ino), uid: info.uid, mode: info.mode, lstatSize: info.size,
      })
      return false
    }
    if (!info.isFile()) throw new Error(`Nonregular source input ${filename}`)
    const resolved = await realpath(filename)
    if (forbiddenInput(filename) || forbiddenInput(resolved) || resolved !== filename) throw new Error('Forbidden source input ' + filename)
    return true
  }
  async function remember(filename, { canonicalEnumeration = false } = {}) {
    // Policy and type checks precede cache admission and every byte-read.
    if (!await inspectInput(filename, canonicalEnumeration)) return
    if (sources.has(filename)) return
    sources.set(filename, { path: filename, ...digest(await readFile(filename)) })
  }
  async function rememberResolvedModule(id) {
    const filename = id.split('?')[0]
    if (!path.isAbsolute(filename) || id.includes('\0')) return
    if (authenticationInput(filename) || sessionDataInput(filename) || keyMaterialDataInput(filename)) throw new Error('Forbidden source input ' + filename)
    // Missing/virtual IDs remain Vite's resolver responsibility. Existing filesystem
    // inputs always use strict custody, even when enumeration classified them incidental.
    const info = await lstat(filename).catch((error) => { if (error.code === 'ENOENT') return null; throw error })
    if (info) await remember(filename)
  }
  async function verifySources() {
    const inventory = [...sources.values()].map((entry) => ({ ...entry }))
    // Validate the COMPLETE inventory before even an ordinary-first byte-read.
    for (const entry of inventory) {
      await inspectInput(entry.path)
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid source input pins ' + entry.path)
    }
    for (const entry of inventory) {
      await inspectInput(entry.path)
      const current = digest(await readFile(entry.path))
      if (current.bytes !== entry.bytes || current.sha256 !== entry.sha256) throw new Error(`Source input changed during build: ${entry.path}`)
    }
  }
  return { sources, incidentalArtifacts, remember, rememberResolvedModule, verifySources }
}
export function mainModuleUrlPlugin(remember, warnings, load = readFile, translate = true) {
  return { name: translate ? 'worlds-authoring-main-source-module-url' : 'worlds-authoring-preload-source-custody', setup(build) {
    build.onLoad({ filter: /.*/, namespace: 'file' }, async (args) => {
      const translates = translate && /\.[cm]?[jt]sx?$/.test(args.path)
      if (translates && (!path.isAbsolute(args.path) || !args.path.startsWith(`${repositoryRoot}/`))) throw new Error('Canonical main module source required')
      await remember(args.path)
      // Guard ALL filesystem default loaders; only main JS/TS enters URL translation.
      if (!translates) return null
      const contents = await load(args.path, 'utf8'), extension = path.extname(args.path)
      const loader = /[cm]?ts$/.test(extension) ? 'ts' : extension === '.tsx' ? 'tsx' : extension === '.jsx' ? 'jsx' : 'js'
      const original = { contents, loader, resolveDir: path.dirname(args.path) }
      if (!contents.includes('import')) return original
      const options = { loader, sourcefile: args.path, format: 'esm', target: 'es2022', jsx: 'preserve', logLevel: 'silent' }
      // The real parser ignores literal extension-worker programs; no textual import.meta rewrite.
      const parsed = await esTransform(contents, { ...options, supported: { 'import-meta': false } })
      if (!parsed.warnings.some((warning) => warning.id === 'empty-import-meta')) return original
      const translated = await esTransform(contents, { ...options, define: { 'import.meta.url': JSON.stringify(pathToFileURL(args.path).href) } })
      const checked = await esTransform(translated.code, { ...options, loader: loader.endsWith('x') ? 'jsx' : 'js', supported: { 'import-meta': false } })
      if (checked.warnings.some((warning) => warning.id === 'empty-import-meta')) throw Object.assign(new Error(`Unsupported main import.meta semantics: ${args.path}`), { warnings: checked.warnings })
      warnings.push(...translated.warnings.map((warning) => ({ source: args.path, stage: 'source-url-translation', warning })),
        ...checked.warnings.map((warning) => ({ source: args.path, stage: 'residual-meta-check', warning })))
      return { ...original, contents: translated.code }
    })
  } }
}
export async function buildWorldsAuthoringFixture(nativeMode = 'owned-xvfb', localAi = null, reviewedIdentity = null, worldSculptSource = null) {
  if (!['owned-xvfb', 'inherited-display'].includes(nativeMode)) throw new Error('Unknown native mode')
  if (localAi) { validateLocalAiConfig(localAi, repositoryLocalAiConfig); if (nativeMode !== 'inherited-display') throw new Error('Local-AI requires separately owned inherited-display admission') }
  if (worldSculptSource) {
    if (nativeMode !== 'inherited-display' || localAi || reviewedIdentity !== null
      || !worldSculptSource || typeof worldSculptSource !== 'object' || Array.isArray(worldSculptSource)
      || Object.keys(worldSculptSource).length !== 2 || !Object.hasOwn(worldSculptSource, 'path') || !Object.hasOwn(worldSculptSource, 'sha256')) throw new Error('WorldSculpt navigation requires its exclusive inherited-display source admission')
  }
  const reviewedAiModel = localAi ? parseReviewedAiModel(reviewedIdentity) : null
  if (!localAi && reviewedIdentity !== null) throw new Error('Reviewed AI identity is forbidden outside local-AI mode')
  if (await realpath(process.cwd()) !== repositoryRoot) throw new Error(`Canonical build cwd required: ${repositoryRoot}`)
  if (process.env.WORLD_FFMPEG_BUILD_TRUST_FILE) throw new Error('This authoring fixture refuses inherited FFmpeg build trust')
  const outputDirectory = await mkdtemp('/tmp/modly-worlds-authoring-ui-')
  await chmod(outputDirectory, 0o700)
  console.log(`worlds-authoring-build: private output=${outputDirectory}`)
  let initialHead, initialBranch
  const { sources, incidentalArtifacts, remember, rememberResolvedModule, verifySources } = createSourceCustody(repositoryRoot)
  const moduleGraphs = []
  async function verify() {
    await verifySources()
    if (git(['rev-parse', 'HEAD']).trim() !== initialHead || git(['branch', '--show-current']).trim() !== initialBranch) throw new Error('Canonical Git identity changed during build')
  }
  try {
    initialHead = git(['rev-parse', 'HEAD']).trim(); initialBranch = git(['branch', '--show-current']).trim()
    if (initialHead !== '2111f62cf2042e8ca8826f2e5dc99e3bd8dc9b61' || initialBranch !== 'codex/worlds-engine') throw new Error('This reviewed fixture is pinned to the canonical source lane; re-review before rebuilding elsewhere')
    const worldSculpt = worldSculptSource ? await readWorldSculptBuildInput(worldSculptSource.path, worldSculptSource.sha256) : null
    if (worldSculpt) {
      const bundledPath = path.join(outputDirectory, WORLD_SCULPT_BUNDLED_RELATIVE_PATH)
      await mkdir(path.dirname(bundledPath), { mode: 0o700 })
      await writeFile(bundledPath, worldSculpt.bytes, { flag: 'wx', mode: 0o600 })
    }
    // Also hashes CSS scan inputs and config dependencies, not just a hand-written entrypoint list.
    const canonicalPaths = [...new Set(git(['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean))].sort()
    for (const relative of canonicalPaths) await remember(path.join(repositoryRoot, relative), { canonicalEnumeration: true })
    for (const relative of await files(fixtureSource)) await remember(path.join(fixtureSource, relative))
    const configPath = path.join(repositoryRoot, 'electron.vite.config.ts')
    const { default: appConfig } = await import(pathToFileURL(configPath).href)
    const renderer = appConfig.renderer
    if (!renderer || !Array.isArray(renderer.plugins) || typeof renderer.worker?.plugins !== 'function') throw new Error('Production Vite renderer/Worker plugin contract changed')
    function graphPlugin(label) {
      const graph = new Map()
      return {
        name: `worlds-authoring-input-evidence-${label}`, enforce: 'pre',
        async load(id) {
          await rememberResolvedModule(id)
          return null
        },
        moduleParsed(info) { graph.set(info.id, { id: info.id, importedIds: info.importedIds, dynamicallyImportedIds: info.dynamicallyImportedIds, transformedCode: digest(Buffer.from(info.code ?? '')) }) },
        generateBundle() {
          const nodes = [...this.getModuleIds()].map((id) => graph.get(id) ?? { id, importedIds: this.getModuleInfo(id)?.importedIds ?? [], dynamicallyImportedIds: this.getModuleInfo(id)?.dynamicallyImportedIds ?? [], transformedCode: digest(Buffer.from(this.getModuleInfo(id)?.code ?? '')) }).sort((a, b) => a.id.localeCompare(b.id))
          moduleGraphs.push({ label, nodes, ...digest(Buffer.from(JSON.stringify(nodes))) })
        },
      }
    }
    const mainTranslationWarnings = []
    const common = { bundle: true, metafile: true, logLevel: 'silent', tsconfig: path.join(fixtureSource, 'tsconfig.json'), target: 'es2022', external: ['electron'] }
    const builds = await Promise.all([
      esbuild({ ...common, entryPoints: [path.join(fixtureSource, 'main.ts')], outfile: path.join(outputDirectory, 'main.cjs'), platform: 'node', format: 'cjs', plugins: [mainModuleUrlPlugin(remember, mainTranslationWarnings)] }),
      esbuild({ ...common, entryPoints: [path.join(fixtureSource, 'preload.ts')], outfile: path.join(outputDirectory, 'preload.cjs'), platform: 'browser', format: 'cjs', plugins: [mainModuleUrlPlugin(remember, [], undefined, false)] }),
    ])
    for (const built of builds) for (const input of Object.keys(built.metafile.inputs)) await remember(path.resolve(repositoryRoot, input))
    if (builds[0].warnings.some((warning) => warning.id === 'empty-import-meta')) throw Object.assign(new Error('Unsupported main import.meta semantics in final bundle'), { warnings: builds[0].warnings })
    for (const [index, built] of builds.entries()) if (built.warnings.length) console.warn(`worlds-authoring-${index === 0 ? 'main' : 'preload'}-compiler-warnings: ${JSON.stringify(built.warnings)}`)
    if (mainTranslationWarnings.length) console.warn(`worlds-authoring-main-translation-warnings: ${JSON.stringify(mainTranslationWarnings)}`)
    await viteBuild({
      configFile: false, envFile: false, root: fixtureSource, publicDir: false,
      cacheDir: path.join(outputDirectory, 'vite-cache'), base: './', logLevel: 'warn',
      resolve: renderer.resolve, plugins: [graphPlugin('renderer'), ...renderer.plugins],
      worker: { ...renderer.worker, plugins: () => [graphPlugin('worker'), ...renderer.worker.plugins()] },
      build: { target: renderer.build.target, outDir: path.join(outputDirectory, 'renderer'), emptyOutDir: false, minify: false, sourcemap: false, rollupOptions: { input: path.join(fixtureSource, 'index.html') } },
    })
    await copyFile(path.join(fixtureSource, 'run.mjs'), path.join(outputDirectory, 'run.mjs'))
    await copyFile(path.join(fixtureSource, 'display-resources.mjs'), path.join(outputDirectory, 'display-resources.mjs'))
    const nodePath = await realpath(process.execPath), electronPath = path.join(repositoryRoot, 'node_modules/electron/dist/electron')
    for (const filename of [nodePath, electronPath, ...(nativeMode === 'owned-xvfb' ? ['/usr/bin/Xvfb'] : [])]) await remember(filename)
    let pythonIdentity = null
    if (localAi) {
      const info = await lstat(localAi.pythonPath), resolvedPath = await realpath(localAi.pythonPath)
      if (!info.isSymbolicLink()) throw new Error('Reviewed logical venv Python must remain a symlink')
      pythonIdentity = { logicalPath: localAi.pythonPath, resolvedPath, linkTarget: await readlink(localAi.pythonPath), device: String(info.dev), inode: String(info.ino), mode: info.mode }
      await remember(resolvedPath); await remember(path.join(localAi.apiRoot, '.venv/pyvenv.cfg'))
      for (const relative of ['uvicorn/__init__.py', 'uvicorn/main.py', 'uvicorn/server.py', 'uvicorn/config.py']) await remember(path.join(localAi.apiRoot, '.venv/lib/python3.12/site-packages', relative))
    }
    const versions = {}
    for (const name of ['electron', 'esbuild', 'vite', 'react', 'react-dom', 'three', 'three-stdlib', '@react-three/fiber', '@react-three/drei', '@dimforge/rapier3d']) {
      const filename = path.join(repositoryRoot, 'node_modules', name, 'package.json'); await remember(filename)
      versions[name] = JSON.parse(await readFile(filename, 'utf8')).version
    }
    const requiredModules = ['components/WorldsWorkbench.tsx', 'components/WorldsSceneDock.tsx', 'components/WorldsInspector.tsx', 'components/WorldsViewer.tsx', 'components/WorldsViewportModeControl.tsx', 'components/WorldsViewportNavigationControls.tsx', 'worldCameraNavigation.ts', 'editor/useWorldEditorController.ts', 'editor/worldEditorController.ts', 'editor/worldEditorTransformAdmission.ts', 'editor/useWorldEditorProjectionBridge.ts', 'core/worldSessions.ts', 'worldProjectService.ts']
    const rendererIds = new Set(moduleGraphs.filter((graph) => graph.label === 'renderer').flatMap((graph) => graph.nodes.map((node) => node.id.split('?')[0])))
    for (const relative of requiredModules) if (!rendererIds.has(path.join(repositoryRoot, 'src/areas/worlds', relative))) throw new Error(`Production module absent from actual Vite graph: ${relative}`)
    if (localAi) {
      for (const relative of ['components/WorldsAiDrawer.tsx', 'editor/worldAiChatAdapter.ts', 'editor/worldAiCommandBridge.ts', 'editor/worldEditorCommandPort.ts']) if (!rendererIds.has(path.join(repositoryRoot, 'src/areas/worlds', relative))) throw new Error(`Actual AI renderer graph missing: ${relative}`)
      if (!rendererIds.has(path.join(repositoryRoot, 'src/areas/generate/components/ChatPanel.tsx'))) throw new Error('Actual shared ChatPanel graph missing')
      const mainIds = new Set(Object.keys(builds[0].metafile.inputs).map((input) => path.resolve(repositoryRoot, input)))
      for (const relative of ['scripts/worlds-authoring-electron-fixture/ai-driver.ts', 'src/areas/worlds/core/worldAiCreationCompiler.ts', 'electron/main/world-projects-ipc.ts', 'electron/main/world-project-repository.ts', 'electron/main/world-ai-resource-observations.ts']) if (!mainIds.has(path.join(repositoryRoot, relative))) throw new Error(`Actual AI main graph missing: ${relative}`)
    }
    if (![...rendererIds].some((id) => id.endsWith('/@react-three/drei/core/Gltf.js'))) throw new Error('Current lazy Inspector Gltf graph is missing')
    if (!moduleGraphs.some((graph) => graph.label === 'worker' && graph.nodes.some((node) => node.id.includes('worldPhysics.worker.ts')))) throw new Error('Actual production physics Worker graph is missing')
    if (!moduleGraphs.some((graph) => graph.label === 'worker' && graph.nodes.some((node) => node.id.includes('/@dimforge/rapier3d/rapier_wasm3d')))) throw new Error('Actual dynamic Rapier Worker/WASM graph is missing')
    await writeFile(path.join(outputDirectory, 'module-graphs.json'), `${JSON.stringify(moduleGraphs, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await writeFile(path.join(outputDirectory, 'esbuild-metafiles.json'), `${JSON.stringify(builds.map((value) => value.metafile), null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await verify()
    const outputs = {}
    for (const relative of await files(outputDirectory)) outputs[relative] = digest(await readFile(path.join(outputDirectory, relative)))
    const repositoryAdmission = { schema: 'modly.worlds-authoring-repository-admission.v1', root: repositoryRoot, head: initialHead, branch: initialBranch }
    const manifest = {
      schema: 'modly.worlds-authoring-build.v1', scope: 'source-level-full-Workbench-native-authoring', execution: 'NOT_RUN', nativeMode,
      ...(localAi ? { runtimeMode: 'local-ai', localAi, pythonIdentity, reviewedAiModel, aiAcceptance: 'NOT_RUN; two actual tool-query/proposal chats, native Reject/Apply and fresh geometry/disk witnesses required; operator tool-review acknowledgement is not runtime capability proof' } : {}),
      ...(worldSculpt ? { runtimeMode: 'worldsculpt-navigation', worldSculptInput: { schema: 'modly.worlds-authoring-worldsculpt-input.v1', sourceIdentity: worldSculpt.sourceIdentity, bundled: { relativePath: WORLD_SCULPT_BUNDLED_RELATIVE_PATH, ...digest(worldSculpt.bytes) }, workspaceRelativePath: WORLD_SCULPT_WORKSPACE_RELATIVE_PATH }, worldSculptAcceptance: 'NOT_RUN; production-library add plus trusted native Inspect/Fly/Run evidence and fresh durable reopen required' } : {}),
      builtAt: new Date().toISOString(), repositoryRoot, repositoryAdmission, outputDirectory, initialHead, initialBranch, nodePath, electronPath, versions,
      outputs, sourceInputs: [...sources.values()].sort((a, b) => a.path.localeCompare(b.path)),
      compilerDiagnostics: { schema: 'modly.worlds-authoring-compiler-diagnostics.v1', esbuild: builds.map((built, index) => ({ entry: index === 0 ? 'main' : 'preload', warnings: built.warnings })), mainTranslationWarnings },
      incidentalArtifacts: [...incidentalArtifacts.values()].sort((a, b) => a.path.localeCompare(b.path)),
      graphDigests: moduleGraphs.map(({ label, sha256, bytes }) => ({ label, sha256, bytes })),
      productionWorkerEntry: 'src/areas/worlds/runtime/worldPhysics.worker.ts',
      rendererPlugins: renderer.plugins.flat(Infinity).filter(Boolean).map((plugin) => plugin.name),
      workerPlugins: renderer.worker.plugins().flat(Infinity).filter(Boolean).map((plugin) => plugin.name),
      runAuthorization: 'Deferred. Requires fresh review of source, source/output hashes and this exact independent command. One exclusive run marker; no retry or environment workaround.',
      limits: { mainWatchdogSeconds: localAi?.mainWatchdogSeconds ?? 120, runnerWatchdogSeconds: localAi?.runnerWatchdogSeconds ?? 125, positiveCanvasSeconds: 8, proposedOuterSeconds: localAi?.outerSeconds ?? 145, killAfterSeconds: 5 },
      performance: 'NOT_TESTED. Artificially gated. Existing 857 ms command p95 FAIL is unchanged.',
    }
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), buildSha256 = digest(manifestBytes).sha256
    await writeFile(path.join(outputDirectory, 'fixture-build.json'), manifestBytes, { flag: 'wx', mode: 0o600 })
    const launchEnvironment = nativeMode === 'owned-xvfb' ? '/usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 ' : ''
    const nextCommand = `/usr/bin/timeout --signal=TERM --kill-after=5s ${localAi?.outerSeconds ?? 145}s ${launchEnvironment}${quote(nodePath)} ${quote(path.join(outputDirectory, 'run.mjs'))} --reviewed-build-sha256=${buildSha256}${nativeMode === 'inherited-display' ? ' --inherited-display' : ''}${localAi ? ' --local-ai' : ''}${worldSculpt ? ' --worldsculpt-navigation' : ''}`
    await writeFile(path.join(outputDirectory, 'next-command.txt'), `${nextCommand}\n`, { flag: 'wx', mode: 0o600 })
    return { status: 'BUILT_ONLY', execution: 'NOT_RUN', outputDirectory, buildSha256, nextCommand, graphDigests: manifest.graphDigests, sourceInputCount: sources.size }
  } catch (error) {
    await writeFile(path.join(outputDirectory, 'build-failure.txt'), `${inspect(error, { depth: null, colors: false, maxStringLength: null, maxArrayLength: null })}\n`, { flag: 'wx', mode: 0o600 })
    throw new Error(`Build-only fixture failed; no retry or native run. Evidence retained: ${outputDirectory}`, { cause: error })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const { nativeMode, localAi, reviewedAiModel, worldSculptSource } = parseBuildArguments(process.argv.slice(2)); console.log(JSON.stringify(await buildWorldsAuthoringFixture(nativeMode, localAi, reviewedAiModel, worldSculptSource), null, 2)) }
  catch (error) { console.error(error); process.exitCode = 1 }
}

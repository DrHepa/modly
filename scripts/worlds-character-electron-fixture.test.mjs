import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import ts from 'typescript'

import { buildWorldsCharacterFixture, parseBuildArguments } from './worlds-character-electron-fixture.mjs'
import { assertSandboxLaunch } from './worlds-character-electron-fixture/shared.ts'
import { createValidWorldSnapshot } from '../src/areas/worlds/core/_testFixtures.ts'

const dracoInput = 'node_modules/three-stdlib/loaders/DRACOLoader.js'
const physicsOwnership = /worldPhysics(?:\.worker|Runtime)|worldRapierRuntime|@dimforge\/rapier/i

async function installedDecoderSource() {
  const source = await readFile(new URL(`../${dracoInput}`, import.meta.url), 'utf8')
  assert.equal(createHash('sha256').update(source).digest('hex'), '73b3dbf76cbdac8ac7999a20414f49774149103050798355ebc8e1ae6500ce9c', 'Re-review decoder ownership when the installed source changes')
  return source
}

function parseJavaScript(source) {
  const file = ts.createSourceFile('fixture.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  assert.equal(file.parseDiagnostics.length, 0, 'Worker ownership requires parseable JavaScript')
  return file
}

function decoderScope(source) {
  const decoder = parseJavaScript(source).statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === 'DRACOLoader')
  assert.ok(decoder, 'Installed decoder class is required')
  return `var init_DRACOLoader = __esm({ "${dracoInput}"() {
    "use strict"; init_three_module(); _taskCache = new WeakMap();
    DRACOLoader = ${decoder.getText().replace('class DRACOLoader', 'class')};
  } });`
}

// Compare executable syntax, not module comments; normalize only proven local esbuild bindings.
function syntaxShape(root) {
  const bindings = new Map()
  const declarations = new Map()
  const trackedNames = ['resolve', 'resolve2', 'i', 'i2']
  let declarationID = 0
  const visit = (node, callback) => { callback(node); ts.forEachChild(node, (child) => { visit(child, callback) }) }
  visit(root, (node) => {
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && trackedNames.includes(node.name.text)) assert.fail('Unsupported decoder binding pattern')
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name && trackedNames.includes(node.name.text)) assert.fail('Unsupported named decoder binding')
    if (!(ts.isParameter(node) || ts.isVariableDeclaration(node)) || !ts.isIdentifier(node.name) || !trackedNames.includes(node.name.text)) return
    let method = node.parent
    while (method && !ts.isMethodDeclaration(method)) method = method.parent
    const name = node.name.text
    const resolver = ['resolve', 'resolve2'].includes(name) && ['decodeGeometry', '_loadLibrary'].includes(method?.name?.getText()) && ts.isParameter(node) && ts.isArrowFunction(node.parent)
    const index = ['i', 'i2'].includes(name) && ['_createGeometry', 'dispose'].includes(method?.name?.getText()) && ts.isVariableDeclaration(node) && ts.isForStatement(node.parent?.parent)
    let scope = node.parent
    if (ts.isVariableDeclaration(node) && !ts.isCatchClause(scope)) {
      assert.ok(ts.isVariableDeclarationList(scope), 'Unsupported decoder declaration scope')
      const blockScoped = (scope.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0
      scope = scope.parent
      while (scope && !(blockScoped ? ts.isBlock(scope) || ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope) : ts.isFunctionLike(scope))) scope = scope.parent
    }
    assert.ok(scope && (ts.isFunctionLike(scope) || ts.isBlock(scope) || ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope) || ts.isCatchClause(scope)), 'Unproven decoder lexical scope')
    if (!bindings.has(scope)) bindings.set(scope, new Map())
    assert.equal(bindings.get(scope).has(name), false, 'Ambiguous decoder declaration identity')
    const binding = ['binding', declarationID++, resolver ? 'resolver' : index ? 'index' : name]
    bindings.get(scope).set(name, binding)
    declarations.set(node.name, binding)
  })
  const identifier = (node) => {
    if ((ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) || ((ts.isPropertyAssignment(node.parent) || ts.isMethodDeclaration(node.parent) || ts.isPropertyDeclaration(node.parent) || ts.isGetAccessorDeclaration(node.parent) || ts.isSetAccessorDeclaration(node.parent)) && node.parent.name === node)) return node.text
    if (declarations.has(node)) return declarations.get(node)
    for (let scope = node.parent; scope; scope = scope.parent) {
      if (bindings.get(scope)?.has(node.text)) return bindings.get(scope).get(node.text)
    }
    return trackedNames.includes(node.text) ? ['free', node.text] : node.text
  }
  const shape = (node) => {
    if (ts.isShorthandPropertyAssignment(node) && !node.objectAssignmentInitializer) {
      return [ts.SyntaxKind.PropertyAssignment, null, null, 0, [ts.SyntaxKind.Identifier, node.name.text, null, 0], shape(node.name)]
    }
    const children = []
    ts.forEachChild(node, (child) => { children.push(shape(child)) })
    const text = ts.isIdentifier(node) ? identifier(node) : ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) ? node.text : null
    return [node.kind, text, node.operator ?? null, ts.isVariableDeclarationList(node) ? node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const) : 0, ...children]
  }
  return shape(root)
}

function assertAuthoringWorkerOwnership(renderer, sourceInputs, decoderSource) {
  assert.ok(Array.isArray(sourceInputs) && sourceInputs.length > 0, 'Authoritative build source-input graph is required')
  const inputs = sourceInputs.map((input) => { assert.equal(typeof input, 'string'); return input.replaceAll('\\', '/') })
  for (const input of inputs) assert.doesNotMatch(input, physicsOwnership, 'Authoring must exclude physics execution inputs')
  const file = parseJavaScript(renderer)
  const references = []
  const scopes = []
  const visit = (node) => {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
      assert.doesNotMatch(node.text, physicsOwnership, 'Authoring must exclude physics execution identifiers and URLs')
      if (node.text === 'Worker' && (ts.isIdentifier(node) || (ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node))) references.push(node)
    }
    if (ts.isVariableStatement(node) && node.parent === file && node.declarationList.declarations.some((declaration) => declaration.name.getText() === 'init_DRACOLoader')) scopes.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (references.length === 0) return
  assert.equal(references.length, 1, 'Only the installed dormant decoder may reference Worker; aliases are forbidden')
  assert.ok(inputs.includes(dracoInput), 'Decoder permission requires its real build input, not a module comment')
  assert.equal(scopes.length, 1, 'Decoder permission requires its exact top-level esbuild binding')
  assert.deepEqual(syntaxShape(scopes[0]), syntaxShape(parseJavaScript(decoderScope(decoderSource)).statements[0]), 'Decoder class body and executable scope must match installed source')
  const reference = references[0]
  assert.ok(ts.isNewExpression(reference.parent) && reference.parent.expression === reference, 'Worker aliases and indirect construction are forbidden')
  let method = reference.parent
  while (method && !ts.isMethodDeclaration(method)) method = method.parent
  assert.equal(method?.name?.getText(), '_getWorker', 'Worker must belong to the installed decoder method')
  let scope = method
  while (scope && scope !== scopes[0]) scope = scope.parent
  assert.equal(scope, scopes[0], 'No Worker construction outside the proven decoder scope')
}

test('character authoring Worker guard allows only installed dormant Draco syntax and rejects physics ownership or unexpected constructors', async () => {
  const decoderSource = await installedDecoderSource()
  const benign = decoderScope(decoderSource)
  const inputs = [dracoInput, 'src/areas/worlds/runtime/worldBehaviorRuntime.ts', 'src/areas/worlds/runtime/worldRuntimeEntityGraph.ts']
  const guard = (source, graph = inputs) => assertAuthoringWorkerOwnership(source, graph, decoderSource)
  assert.doesNotThrow(() => guard(benign))
  const bundledLocals = benign.replaceAll('(resolve, reject)', '(resolve2, reject)').replace('{ resolve, reject }', '{ resolve: resolve2, reject }').replace('loader.load(url, resolve,', 'loader.load(url, resolve2,').replace(/\bi\b/g, 'i2')
  assert.doesNotThrow(() => guard(bundledLocals))
  assert.doesNotThrow(() => guard('// new Worker("data");\nconst data = "new Worker(fake)";', ['authoring.js']))
  const shadowed = 'class Decoder { _loadLibrary() { return (resolve) => (resolve2) => resolve; } }'
  assert.notDeepEqual(syntaxShape(parseJavaScript(shadowed).statements[0]), syntaxShape(parseJavaScript(shadowed.replace('=> resolve;', '=> resolve2;')).statements[0]), 'Captured outer and shadowing inner declarations must have different identities')
  for (const input of ['src/areas/worlds/runtime/worldPhysics.worker.ts', 'src/areas/worlds/runtime/worldPhysicsRuntime.ts', 'src/areas/worlds/runtime/worldRapierRuntime.ts', 'node_modules/@dimforge/rapier3d/rapier.js', 'src\\areas\\worlds\\runtime\\worldPhysics.worker.ts']) {
    assert.throws(() => guard('const minified = 1;', [...inputs, input]), /physics execution inputs/)
  }
  assert.throws(() => guard(benign, ['authoring.js']), /real build input/)
  assert.throws(() => guard(benign, []), /source-input graph/)
  for (const source of [
    `${benign}\nnew Worker('worldPhysics.worker.js');`, `${benign}\nnew Worker('other.js');`,
    `${benign}\nconst Alias = Worker; new Alias('other.js');`, `${benign}\nnew globalThis['Worker']('other.js');`,
    benign.replace('_getWorker(taskID, taskCost)', 'otherMethod(taskID, taskCost)'),
    benign.replace('new Worker(this.workerSourceURL)', 'new Worker(this.changedReceiver)'),
    benign.replace('const worker2 = new Worker', 'new Worker(this.workerSourceURL); const worker2 = new Worker'),
    benign.replace('worker2._taskLoad = 0', 'worker2._taskLoad = 1'), benign.replace('class extends Loader', 'class extends OtherLoader'),
    bundledLocals.replace('._callbacks[message.id].resolve(message)', '._callbacks[message.id].resolve2(message)'),
    benign.replaceAll('(resolve, reject)', '(resolve2, reject)'), benign.replaceAll('let i = 0', 'let i2 = 0'),
    bundledLocals.replace('loader.load(url, resolve2,', 'loader.load(url, resolve,'), bundledLocals.replace('geometryData.attributes[i2]', 'geometryData.attributes[i]'),
    bundledLocals.replace('{ resolve: resolve2, reject }', '{ resolve, reject }'),
    bundledLocals.replace('worker._callbacks[taskID] =', 'const resolve = reject; worker._callbacks[taskID] =').replace('{ resolve: resolve2, reject }', '{ resolve, reject }'),
    `function changedScope() { ${benign} }`, `// ${dracoInput}\nclass Spoof { _getWorker() { return new Worker(this.workerSourceURL); } }`,
    benign.replace('init_DRACOLoader', 'spoofBinding'), benign.replace('"use strict";', '"use strict"; this.changedScope = true;'),
  ]) assert.throws(() => guard(source))
  assert.throws(() => guard('new Worker("other.js");'), /exact top-level esbuild binding/)
})

test('character fixture requires an explicit build-only invocation and has no launch mode', () => {
  assert.deepEqual(parseBuildArguments(['--build-only']), { buildOnly: true })
  for (const args of [[], ['--run'], ['--build-only', '--run'], ['--build-only', '--out-dir', '/tmp/existing']]) {
    assert.throws(() => parseBuildArguments(args), /--build-only/)
  }
})

test('character fixture refuses sandbox-disabling flags and ambient Node injection', () => {
  assert.doesNotThrow(() => assertSandboxLaunch(['electron', '/tmp/fixture/main.cjs'], {}))
  for (const flag of ['--no-sandbox', '--no-zygote', '--disable-setuid-sandbox', '--disable-gpu-sandbox', '--no-sandbox=true']) {
    assert.throws(() => assertSandboxLaunch(['electron', 'main.cjs', flag], {}), /sandbox/i)
  }
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_DISABLE_SANDBOX']) {
    assert.throws(() => assertSandboxLaunch(['electron', 'main.cjs'], { [name]: '1' }), /environment/i)
  }
})

test('character fixture builds real production UI, IPC and persistence into an isolated temp directory without running Electron', async () => {
  const result = await buildWorldsCharacterFixture()
  console.log(`Character fixture build evidence: ${result.outputDirectory}`)
  assert.match(path.basename(result.outputDirectory), /^modly-worlds-character-ui-/)
  assert.equal(result.execution, 'NOT_RUN')
  assert.equal(result.scope, 'source-level-character-authoring')
  assert.match(result.nextCommand, /\/usr\/bin\/xvfb-run -a/)
  assert.match(result.nextCommand, /--kill-after=5s 135s/)
  assert.doesNotMatch(result.nextCommand, /DISPLAY=:1|--no-sandbox|--no-zygote/)
  const files = await readdir(result.outputDirectory)
  for (const filename of ['main.cjs', 'preload.cjs', 'renderer.js', 'renderer.css', 'index.html', 'fixture-build.json']) {
    assert.ok(files.includes(filename), `Missing build output: ${filename}`)
    assert.ok(result.outputs[filename]?.bytes > 0 || filename === 'fixture-build.json')
  }
  assert.equal(files.some((filename) => filename.startsWith('run-')), false, 'Build must not initialize an Electron run')
  const main = await readFile(path.join(result.outputDirectory, 'main.cjs'), 'utf8')
  const preload = await readFile(path.join(result.outputDirectory, 'preload.cjs'), 'utf8')
  const renderer = await readFile(path.join(result.outputDirectory, 'renderer.js'), 'utf8')
  const html = await readFile(path.join(result.outputDirectory, 'index.html'), 'utf8')
  assert.match(main, /enableSandbox\(\)/)
  assert.match(main, /sandbox: true/)
  assert.match(main, /contextIsolation: true/)
  assert.match(main, /nodeIntegration: false/)
  assert.match(main, /report\.requestedWebPreferences = requestedWebPreferences/)
  assert.match(main, /registerWorldProjectsIpcHandlers/)
  assert.match(main, /WorldProjectRepository/)
  assert.match(main, /sendInputEvent/)
  assert.match(main, /insertText/)
  assert.doesNotMatch(main, /appendSwitch\(/)
  assert.doesNotMatch(main, /requestSingleInstanceLock\(|new PythonBridge|setupIpcHandlers\(/)
  assert.match(preload, /require\(["']electron["']\)/)
  assert.match(preload, /createElectronApi/)
  assert.match(preload, /sandboxed: process\.sandboxed/)
  assert.match(renderer, /WorldsInspector/)
  assert.match(renderer, /WorldsProjectBar/)
  assert.match(renderer, /createWorldEditorController/)
  assertAuthoringWorkerOwnership(renderer, result.sourceInputs, await installedDecoderSource())
  assert.match(html, /connect-src 'none'/)
})

test('character fixture keeps page evaluation read-only and all edits on native UI and production IPC paths', async () => {
  const source = (filename) => readFile(new URL(`./worlds-character-electron-fixture/${filename}`, import.meta.url), 'utf8')
  const driver = await source('driver.ts')
  const renderer = await source('renderer.tsx')
  const preload = await source('preload.ts')
  assert.equal((driver.match(/executeJavaScript\(/g) ?? []).length, 2, 'Only locator/scroll and read-only state output may evaluate in the page')
  const domEvidence = await source('domEvidence.ts')
  assert.doesNotMatch(`${driver}\n${domEvidence}`, /dispatchEvent\(|\.click\(|\.focus\(|\.(?:value|selectionStart|selectionEnd)\s*=(?!=)|__react|\.dispatchUiCommands\(|\.applyCommands\(/)
  assert.match(driver, /sendInputEvent\(/)
  assert.match(driver, /insertText\(/)
  assert.match(driver, /contents\.reload\(\)/)
  assert.match(driver, /nativeInputs\.untrusted, 0/)
  assert.match(renderer, /editor\.dispatchUiCommands\(commands, scope/)
  assert.match(renderer, /controller\.undo\(\)/)
  assert.match(renderer, /controller\.redo\(\)/)
  assert.match(preload, /workspace: \{ worlds: \{ projects: api\.workspace\.worlds\.projects \} \}/)
  assert.doesNotMatch(preload, /exposeInMainWorld\(['"](?:ipcRenderer|require|process)['"]|exposeInMainWorld\(['"]electron['"],\s*api\)/)
})

test('character fixture rejects revision-only progress and unintended snapshot changes per operation', async () => {
  const { assertFixtureSnapshotDelta } = await import('./worlds-character-electron-fixture/driver.ts')
  assert.equal(typeof assertFixtureSnapshotDelta, 'function')
  const before = createValidWorldSnapshot()
  const update = (snapshot) => { snapshot.scenes[0].entities[0].transform.position[0] = 0.45 }
  const expected = structuredClone(before)
  expected.project.revision += 1
  update(expected)
  assert.doesNotThrow(() => assertFixtureSnapshotDelta(expected, before, update))
  const noOp = structuredClone(before)
  noOp.project.revision += 1
  assert.throws(() => assertFixtureSnapshotDelta(noOp, before, update))
  const appended = structuredClone(expected)
  appended.scenes[0].entities[0].transform.position[0] = 0.35045
  assert.throws(() => assertFixtureSnapshotDelta(appended, before, update))
  const unrelated = structuredClone(expected)
  unrelated.project.name = 'Unrequested edit'
  assert.throws(() => assertFixtureSnapshotDelta(unrelated, before, update))
})

test('character fixture acknowledges target focus, empty and inserted DOM values, and guards overlay Tab only', async () => {
  const driver = await readFile(new URL('./worlds-character-electron-fixture/driver.ts', import.meta.url), 'utf8')
  const renderer = await readFile(new URL('./worlds-character-electron-fixture/renderer.tsx', import.meta.url), 'utf8')
  assert.match(driver, /waitForControl/)
  assert.match(driver, /await key\(contents, 'Backspace'\)/)
  assert.match(driver, /control\.value === ''/)
  assert.match(driver, /control\.value === value/)
  assert.match(driver, /focusByTab/)
  assert.match(renderer, /if \(event\.key === 'Tab'\) trapWorldsOverlayFocus\(event\)/)
  assert.match(renderer, /setTrace/)
})

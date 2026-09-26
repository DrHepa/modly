import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { EventEmitter, getEventListeners } from 'node:events'
import { parseBuildArguments } from './worlds-graphics-electron-fixture.mjs'
import { assertSandboxLaunch } from './worlds-physics-electron-fixture/shared.ts'

test('graphics recovery builder accepts build-only and never provides a launch mode', () => {
  assert.deepEqual(parseBuildArguments(['--build-only']), { buildOnly: true })
  for (const args of [[], ['--run'], ['--build-only', '--run'], ['--no-sandbox']]) assert.throws(() => parseBuildArguments(args))
  assert.throws(() => assertSandboxLaunch(['electron', '--no-sandbox'], {}))
})

test('graphics recovery is a separate source-level lane using real production contracts', async () => {
  const [builder, main, renderer, driver] = await Promise.all([
    readFile(new URL('./worlds-graphics-electron-fixture.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./worlds-graphics-electron-fixture/main.ts', import.meta.url), 'utf8'),
    readFile(new URL('./worlds-graphics-electron-fixture/renderer.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./worlds-graphics-electron-fixture/driver.ts', import.meta.url), 'utf8'),
  ])
  assert.match(builder, /execution: 'NOT_RUN'/)
  assert.doesNotMatch(builder, /spawn\(|execFile\(|disableHardwareAcceleration|ignore-gpu-blocklist|enable-unsafe-swiftshader/)
  assert.match(main, /scope: 'source-level-graphics-recovery'/)
  assert.match(main, /app\.enableSandbox\(\)/)
  assert.match(main, /WorldProjectRepository/)
  assert.match(driver, /sendInputEvent/)
  assert.match(driver, /assert\.deepEqual\(view\.editorSession, original/)
  assert.match(renderer, /WorldViewportBoundary/)
  assert.match(renderer, /WorldRuntimeViewport/)
  assert.match(renderer, /createWorldPlayController/)
  assert.match(renderer, /createBrowserWorldPhysicsRuntime/)
  assert.match(renderer, /createBrowserWorldAudioAuthority/)
  assert.doesNotMatch(renderer, /dispatchEvent\(|prototype\.getContext|mock|fake/i)
})

test('supported runtime is one explicit strict build-only case, with no runtime or fallback mode', async () => {
  const builder = await import('./worlds-graphics-electron-fixture.mjs')
  assert.deepEqual(parseBuildArguments(['--build-only', '--case=supported-runtime']), { buildOnly: true, case: 'supported-runtime' })
  assert.deepEqual(parseBuildArguments(['--case=supported-runtime', '--build-only']), { buildOnly: true, case: 'supported-runtime' })
  for (const args of [['--case=supported-runtime'], ['--build-only', '--case=unknown'], ['--build-only', '--case=supported-runtime', '--case=supported-runtime'], ['--build-only', '--build-only'], ['--build-only', '--case=supported-runtime', '--run']]) assert.throws(() => parseBuildArguments(args))
  assert.equal(typeof builder.declareGraphicsCase, 'function', 'Missing positive phase declaration')
  assert.deepEqual(builder.declareGraphicsCase('supported-runtime'), { case: 'supported-runtime', scope: 'small-scene-hardware-context-admission', mainDeadlineMs: 125000, outerDeadlineSeconds: 145 })
  assert.throws(() => builder.declareGraphicsCase('unknown'))
})

test('hardware and scene-pixel admission execute the real driver guards on controlled DTOs', async () => {
  const driver = await import('./worlds-graphics-electron-fixture/driver.ts')
  assert.equal(typeof driver.assertHardwareAdmission, 'function', 'Missing actual hardware admission guard')
  const context = { version: 'WebGL 2.0', renderer: 'ANGLE (NVIDIA, GPU)', vendor: 'NVIDIA', debugRenderer: 'NVIDIA GPU', lost: false, width: 640, height: 480 }
  const gpu = { features: { webgl: 'enabled' }, devices: { gpuDevice: [{ active: true, vendorId: 4318, deviceId: 123 }] } }
  driver.assertHardwareAdmission(context, gpu)
  for (const bad of [{ ...context, debugRenderer: null }, { ...context, debugRenderer: 'SwiftShader' }, { ...context, lost: true }, { ...context, width: 0 }, { ...context, version: 'WebGL 1.0' }]) assert.throws(() => driver.assertHardwareAdmission(bad, gpu), /CONTEXT_UNSUPPORTED/)
  for (const bad of [{ ...gpu, features: { webgl: 'disabled_software' } }, { ...gpu, devices: { gpuDevice: [] } }]) assert.throws(() => driver.assertHardwareAdmission(context, bad), /CONTEXT_UNSUPPORTED/)
  assert.equal(typeof driver.compareSceneBitmaps, 'function', 'Missing actual scene-pixel guard')
  const before = Buffer.from([0, 0, 200, 255, 30, 30, 30, 255]), after = Buffer.from([30, 30, 30, 255, 0, 0, 200, 255])
  assert.deepEqual(driver.compareSceneBitmaps(before, after), { changedPixels: 2, markerPixelsBefore: 1, markerPixelsAfter: 1 })
  assert.throws(() => driver.compareSceneBitmaps(before, before))
  assert.throws(() => driver.compareSceneBitmaps(Buffer.alloc(8), after))
  assert.throws(() => driver.compareSceneBitmaps(before, after.subarray(0, 4)))
})

test('main executes an AST-extracted exact phase binding and refuses missing or substituted output manifests', async () => {
  const ts = (await import('typescript')).default
  const source = await readFile(new URL('./worlds-graphics-electron-fixture/main.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const functions = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'assertGraphicsBuildPhase')
  assert.equal(functions.length, 1, 'Missing unique executable main phase-binding guard')
  const emitted = ts.transpileModule(functions[0].getText(ast).replace(/^export /, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } })
  assert.equal(emitted.diagnostics?.length ?? 0, 0)
  const guard = new Function('assert', `${emitted.outputText}; return assertGraphicsBuildPhase`)(assert)
  const outputs = Object.fromEntries(['main.cjs', 'preload.cjs', 'renderer/index.html', 'renderer/assets/entry.js', 'renderer/assets/worldPhysics.worker-A.js'].map(file => [file, { sha256: 'a'.repeat(64), bytes: 1 }]))
  const build = { case: 'supported-runtime', scope: 'small-scene-hardware-context-admission', mainDeadlineMs: 125000, outerDeadlineSeconds: 145, outputs, outputInventory: Object.keys(outputs), workerFiles: ['renderer/assets/worldPhysics.worker-A.js'], productionWorkerEntry: 'src/areas/worlds/runtime/worldPhysics.worker.ts' }
  guard(build, 'supported-runtime', build.outputInventory)
  for (const bad of [{ ...build, case: 'recovery' }, { ...build, scope: 'source-level-graphics-recovery' }, { ...build, mainDeadlineMs: 126000 }, { ...build, outerDeadlineSeconds: 146 }, { ...build, outputs: {} }]) assert.throws(() => guard(bad, 'supported-runtime', build.outputInventory))
  assert.throws(() => guard(build, 'unknown', build.outputInventory))
})

test('review repro: stationary marker and unrelated background changes never satisfy posed marker repaint', async () => {
  const { compareSceneBitmaps } = await import('./worlds-graphics-electron-fixture/driver.ts')
  const before = Buffer.alloc(800), after = Buffer.alloc(800)
  for (let pixel = 0; pixel < 200; pixel++) { before[pixel*4+3] = after[pixel*4+3] = 255; if (pixel < 100) before[pixel*4+2] = after[pixel*4+2] = 200; else after[pixel*4] = 100 }
  assert.throws(() => compareSceneBitmaps(before, after, 200), /marker|scene|pose/i)
  const moved = Buffer.from(before); moved.fill(0); for (let pixel = 100; pixel < 200; pixel++) { moved[pixel*4+2] = 200; moved[pixel*4+3] = 255 }
  assert.deepEqual(compareSceneBitmaps(before, moved, 200), { changedPixels: 200, markerPixelsBefore: 100, markerPixelsAfter: 100 })
  assert.throws(() => compareSceneBitmaps(moved, before, 200), /marker|pose/i)
  assert.throws(() => compareSceneBitmaps(before, moved, 0))
})

test('review repro: real main guard closes emitted coverage through actual enumeration and required entries', async () => {
  const ts = (await import('typescript')).default, path = (await import('node:path')).default
  const source = await readFile(new URL('./worlds-graphics-electron-fixture/main.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const extract = (name, bindings) => { const nodes = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name); assert.equal(nodes.length, 1); const emitted = ts.transpileModule(nodes[0].getText(ast).replace(/^export /, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }); return new Function(...Object.keys(bindings), `${emitted.outputText}; return ${name}`)(...Object.values(bindings)) }
  const guard = extract('assertGraphicsBuildPhase', { assert })
  const mainOnly = { case: 'supported-runtime', scope: 'small-scene-hardware-context-admission', mainDeadlineMs: 125000, outerDeadlineSeconds: 145, outputs: { 'main.cjs': { sha256: 'a'.repeat(64), bytes: 1 } } }
  assert.throws(() => guard(mainOnly, 'supported-runtime', ['main.cjs']))
  const visited = [], tree = { '/owned': ['main.cjs', 'preload.cjs', 'fixture-build.json', 'renderer'], '/owned/renderer': ['index.html', 'assets'], '/owned/renderer/assets': ['entry.js', 'worldPhysics.worker-A.js'] }
  const enumerate = extract('enumerateGraphicsOutputs', { path, assert, readdirSync: directory => { visited.push(directory); return tree[directory].map(name => ({ name, isDirectory: () => ['renderer', 'assets'].includes(name), isFile: () => !['renderer', 'assets'].includes(name) })) } })
  const actual = enumerate('/owned'), outputs = Object.fromEntries(actual.map(file => [file, { sha256: 'a'.repeat(64), bytes: 1 }]))
  const build = { ...mainOnly, outputs, outputInventory: actual, workerFiles: ['renderer/assets/worldPhysics.worker-A.js'], productionWorkerEntry: 'src/areas/worlds/runtime/worldPhysics.worker.ts' }
  guard(build, 'supported-runtime', actual); assert.deepEqual(visited, ['/owned', '/owned/renderer', '/owned/renderer/assets'])
  assert.match(source, /assertGraphicsBuildPhase\(build, __GRAPHICS_CASE__, enumerateGraphicsOutputs\(bundleDirectory\)\)/)
  for (const omitted of ['preload.cjs', 'renderer/index.html', 'renderer/assets/entry.js', 'renderer/assets/worldPhysics.worker-A.js']) { const reduced = { ...outputs }; delete reduced[omitted]; assert.throws(() => guard({ ...build, outputs: reduced, outputInventory: Object.keys(reduced) }, 'supported-runtime', actual)) }
  for (const extra of ['unexpected.js', '../escape.js', 'renderer/../escape.js']) assert.throws(() => guard({ ...build, outputs: { ...outputs, [extra]: { sha256: 'a'.repeat(64), bytes: 1 } }, outputInventory: [...actual, extra] }, 'supported-runtime', [...actual, extra]))
  assert.throws(() => guard(build, 'supported-runtime', [...actual, 'renderer/assets/unlisted.js']))
  assert.throws(() => guard({ ...build, outputInventory: [...actual, actual[0]] }, 'supported-runtime', actual))
  assert.throws(() => guard({ ...build, workerFiles: [...build.workerFiles, ...build.workerFiles] }, 'supported-runtime', actual))
  assert.throws(() => guard({ ...build, productionWorkerEntry: 'other.ts' }, 'supported-runtime', actual))
})

test('raw Electron unknown GPU devices fail closed without fabricated or mutated attribution', async () => {
  const { assertHardwareAdmission } = await import('./worlds-graphics-electron-fixture/driver.ts')
  const context = { version: 'WebGL 2.0', renderer: 'ANGLE (NVIDIA, GPU)', vendor: 'NVIDIA', debugRenderer: 'NVIDIA GPU', lost: false, width: 640, height: 480 }
  for (const devices of [undefined, null, 123, [], {}, { gpuDevice: {} }, { gpuDevice: [null] }, { gpuDevice: [{ active: true, vendorId: '4318', deviceId: 123 }] }, { gpuDevice: [{ active: true, vendorId: 4318, deviceId: 0 }] }]) assert.throws(() => assertHardwareAdmission(context, { features: { webgl: 'enabled' }, devices }), /CONTEXT_UNSUPPORTED/)
  const devices = { gpuDevice: [{ active: true, vendorId: 4318, deviceId: 123, driverVersion: 'observed' }], auxAttributes: { retained: true } }, raw = { features: { webgl: 'enabled' }, devices }
  const original = JSON.stringify(raw); assertHardwareAdmission(context, raw); assert.equal(JSON.stringify(raw), original); assert.equal(raw.devices, devices)
})

// Execute the actual main helper and admission/GPU/driver statements, never Electron startup.
async function controlledFocusFixture(options = {}) {
  const ts = (await import('typescript')).default
  const source = await readFile(new URL('./worlds-graphics-electron-fixture/main.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const find = name => ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  const helpers = find('admitGraphicsNativeFocus')
  assert.equal(helpers.length, 1, 'Missing executable bounded native focus admission helper')
  const emit = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  const timers = new Map(), delays = [], window = new EventEmitter(), contents = new EventEmitter()
  const counts = { show: 0, focus: 0, page: 0, gpu: 0, driver: 0, input: 0, settled: 0 }
  const owner = new AbortController(), unrelated = () => {}
  const rendererFailure = new Promise((_resolve, reject) => { options.captureRaceReject?.(reject) })
  let focused = options.focused ?? false, destroyed = options.destroyed ?? false, timerId = 0
  window.webContents = contents
  window.isFocused = () => focused
  window.isDestroyed = contents.isDestroyed = () => destroyed
  window.show = () => { counts.show++; options.onShow?.(lab) }
  window.focus = () => { counts.focus++; options.onRequest?.(lab) }
  contents.focus = () => { counts.page++; options.onPage?.(lab) }
  window.destroy = () => { destroyed = true; window.emit('closed'); contents.emit('destroyed') }
  window.on('closed', unrelated); contents.on('render-process-gone', unrelated)
  const lab = {
    window, contents, owner, counts, timers, delays,
    acquire: (state = true) => { focused = state; window.emit('focus') },
    lose: () => { focused = false },
    deadline: () => { assert.equal(timers.size, 1); [...timers.values()][0]() },
    clean: () => {
      assert.equal(timers.size, 0)
      assert.deepEqual(window.eventNames().sort(), ['closed'])
      assert.deepEqual(window.listeners('closed'), [unrelated])
      assert.deepEqual(contents.eventNames(), ['render-process-gone'])
      assert.deepEqual(contents.listeners('render-process-gone'), [unrelated])
      assert.equal(getEventListeners(owner.signal, 'abort').length, 0)
      assert.equal(counts.settled, 1)
    },
  }
  const admit = new Function('setTimeout', 'clearTimeout', `${emit(helpers[0].getText(ast).replace(/^export /, ''))}; return admitGraphicsNativeFocus`)(
    (callback, delay) => { delays.push(delay); timers.set(++timerId, callback); return timerId }, id => timers.delete(id),
  )
  const run = find('run')[0]; assert.ok(run?.body)
  const statements = run.body.statements
  const admission = statements.filter(node => ts.isTryStatement(node) && node.getText(ast).includes('admitGraphicsNativeFocus'))
  assert.equal(admission.length, 1, 'Missing cancellable owner focus race')
  const declaration = name => statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(ast) === name))
  const gpu = declaration('gpu'), result = declaration('result')
  assert.ok(gpu && result)
  assert.ok(admission[0].pos < gpu.pos && gpu.pos < result.pos, 'Admission must precede GPU/driver work')
  const runner = new Function('admitGraphicsNativeFocus', 'window', 'focusAdmissionOwner', 'rendererFailure', 'positive', 'app', 'recordCheck', 'verifyRepository', 'capture', 'runSupportedGraphicsInteractions', 'runGraphicsInteractions',
    emit(`return (async () => { ${[admission[0], gpu, result].map(node => node.getText(ast)).join('\n')}; return result })()`))
  if (options.cancelBefore) owner.abort(new Error('controlled cancellation'))
  const driver = () => { counts.driver++; counts.input++; return {} }
  lab.start = () => {
    const promise = runner(admit, window, owner, rendererFailure, true,
      { getGPUFeatureStatus: () => { counts.gpu++; return {} }, getGPUInfo: async () => { counts.gpu++; return {} } }, () => {}, () => {}, () => {}, driver, driver)
    lab.outcome = promise.then(value => { counts.settled++; return { value } }, error => { counts.settled++; return { error } })
    return lab.outcome
  }
  return lab
}

async function assertRejectedFocus(lab, reason, requests = 1, pages = 0) {
  const outcome = await lab.outcome
  assert.match(outcome.error?.message ?? '', reason)
  assert.deepEqual([lab.counts.show, lab.counts.focus, lab.counts.page], [requests, requests, pages])
  assert.deepEqual([lab.counts.gpu, lab.counts.driver, lab.counts.input], [0, 0, 0])
  lab.clean()
  lab.acquire(); lab.window.destroy(); await Promise.resolve()
  assert.deepEqual([lab.counts.show, lab.counts.focus, lab.counts.page, lab.counts.settled], [requests, requests, pages, 1])
  assert.deepEqual([lab.counts.gpu, lab.counts.driver, lab.counts.input], [0, 0, 0])
}

for (const [name, options, requests] of [
  ['already focused', { focused: true }, 0],
  ['synchronous event acquisition', { onRequest: lab => lab.acquire() }, 1],
  ['synchronous state acquisition', { onRequest: lab => { lab.window.isFocused = () => true } }, 1],
  ['delayed acquisition', {}, 1],
]) test(`native focus admission: ${name}, single request and final destruction`, async () => {
  const lab = await controlledFocusFixture(options); lab.start()
  if (name === 'delayed acquisition') { await Promise.resolve(); assert.equal(lab.counts.page, 0); lab.acquire() }
  assert.equal((await lab.outcome).error, undefined)
  assert.deepEqual([lab.counts.show, lab.counts.focus, lab.counts.page], [requests, requests, 1])
  assert.deepEqual([lab.counts.gpu, lab.counts.driver, lab.counts.input], [2, 1, 1])
  assert.ok(lab.delays.every(delay => delay === 8000)); lab.clean()
  lab.window.destroy(); lab.acquire(); await Promise.resolve(); lab.clean()
  assert.equal(lab.counts.page, 1); assert.equal(lab.counts.driver, 1)
})

test('native focus admission: false focus event cannot admit; deadline disposes late events', async () => {
  const lab = await controlledFocusFixture(); lab.start(); lab.acquire(false)
  await Promise.resolve(); assert.equal(lab.counts.settled, 0); assert.equal(lab.counts.page, 0)
  assert.deepEqual(lab.delays, [8000]); lab.deadline()
  await assertRejectedFocus(lab, /FOCUS_ADMISSION.*deadline/i)
})

for (const [name, fail, reason] of [
  ['closed', lab => lab.window.emit('closed'), /FOCUS_ADMISSION.*closed/i],
  ['destroyed window', lab => lab.window.destroy(), /FOCUS_ADMISSION.*closed|destroyed/i],
  ['destroyed contents', lab => lab.contents.emit('destroyed'), /FOCUS_ADMISSION.*destroyed/i],
  ['renderer exited', lab => lab.contents.emit('render-process-gone', {}, { reason: 'crashed' }), /FOCUS_ADMISSION.*crashed/i],
  ['preload error', lab => lab.contents.emit('preload-error', {}, '/owned/preload', new Error('preload broke')), /FOCUS_ADMISSION.*preload broke/i],
  ['unresponsive', lab => lab.window.emit('unresponsive'), /FOCUS_ADMISSION.*unresponsive/i],
  ['owner cancellation', lab => lab.owner.abort(new Error('controlled cancellation')), /FOCUS_ADMISSION.*cancel/i],
]) test(`native focus admission: ${name} rejects before GPU/driver/input`, async () => {
  const lab = await controlledFocusFixture(); lab.start(); fail(lab)
  await assertRejectedFocus(lab, reason)
})

for (const [name, options, reason] of [
  ['cancelled before request', { cancelBefore: true }, /FOCUS_ADMISSION.*cancel/i],
  ['destroyed before request', { destroyed: true }, /FOCUS_ADMISSION.*destroyed/i],
]) test(`native focus admission: ${name} makes no request`, async () => {
  const lab = await controlledFocusFixture(options); lab.start()
  await assertRejectedFocus(lab, reason, 0)
})

test('native focus admission: cancellation during request cannot continue into page focus', async () => {
  const lab = await controlledFocusFixture({ onRequest: lab => { lab.owner.abort(); lab.acquire() } }); lab.start()
  await assertRejectedFocus(lab, /FOCUS_ADMISSION.*cancel/i)
})

test('native focus admission: focus lost during page focus fails final native check', async () => {
  const lab = await controlledFocusFixture({ onRequest: lab => lab.acquire(), onPage: lab => lab.lose() }); lab.start()
  await assertRejectedFocus(lab, /FOCUS_ADMISSION.*lost/i, 1, 1)
})

test('native focus admission: losing enclosing race actively cancels pending listeners and deadline', async () => {
  let rejectRace
  const lab = await controlledFocusFixture({ captureRaceReject: reject => { rejectRace = reject } }); lab.start()
  rejectRace(new Error('controlled enclosing lifecycle failure'))
  await assertRejectedFocus(lab, /controlled enclosing lifecycle failure/)
  assert.equal(lab.owner.signal.aborted, true)
})

test('native focus admission owner wiring cancels lifecycle/race/finally and retains durable watchdog order', async () => {
  const source = await readFile(new URL('./worlds-graphics-electron-fixture/main.ts', import.meta.url), 'utf8')
  assert.match(source, /focusAdmissionOwner\.abort\(error\); reject\(error\)/)
  assert.match(source, /finally \{ focusAdmissionOwner\.abort/)
  const terminal = source.slice(source.indexOf('}).finally(async () => {'))
  assert.ok(terminal.indexOf('focusAdmissionOwner.abort') < terminal.indexOf('fixtureWindow.destroy()'))
  assert.ok(terminal.indexOf('await persist()') < terminal.indexOf('clearTimeout(watchdog)'))
  assert.doesNotMatch(source, /removeAllListeners|moveTop|alwaysOnTop|ready-to-show|setInterval/)
})

test('SOURCE_LAYOUT_INVARIANT: absolute runtime viewport is contained below separate shell targets', async () => {
  const ts = (await import('typescript')).default, postcss = (await import('postcss')).default
  const [renderer, fixtureCss, productionCss] = await Promise.all([
    readFile(new URL('./worlds-graphics-electron-fixture/renderer.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./worlds-physics-electron-fixture/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/areas/worlds/WorldsWorkbench.css', import.meta.url), 'utf8'),
  ])
  assert.match(renderer, /import '\.\.\/worlds-physics-electron-fixture\/styles\.css'/)
  const ast = ts.createSourceFile('renderer.tsx', renderer, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), elements = []
  const visit = node => { if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) elements.push(node); ts.forEachChild(node, visit) }; visit(ast)
  const opening = node => ts.isJsxElement(node) ? node.openingElement : node
  const tag = node => opening(node).tagName.getText(ast)
  const className = node => opening(node).attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.text === 'className')?.initializer?.text
  const uniqueClass = name => { const matches = elements.filter(node => className(node) === name); assert.equal(matches.length, 1); return matches[0] }
  const inside = (node, ancestor) => { for (let current = node; current; current = current.parent) if (current === ancestor) return true; return false }
  const shell = uniqueClass('physics-fixture'), heading = uniqueClass('physics-fixture__heading'), viewport = uniqueClass('physics-fixture__viewport')
  const status = shell.children.filter(node => ts.isJsxElement(node) && className(node) === 'physics-fixture__status')
  assert.equal(status.length, 1); assert.ok(heading.pos < status[0].pos && status[0].pos < viewport.pos)
  assert.ok(inside(heading, shell) && inside(status[0], shell) && inside(viewport, shell))
  const runtime = elements.filter(node => tag(node) === 'WorldRuntimeViewport'), buttons = elements.filter(node => tag(node) === 'button')
  assert.equal(runtime.length, 1); assert.ok(inside(runtime[0], viewport))
  assert.equal(buttons.length, 5)
  for (const button of buttons) assert.ok(inside(button, status[0]) && !inside(button, viewport), 'Shell native targets must remain outside the runtime overlay')
  const declarations = (css, selector) => {
    const rules = []; postcss.parse(css).walkRules(rule => { if (rule.selector === selector) rules.push(rule) }); assert.equal(rules.length, 1)
    return Object.fromEntries(rules[0].nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value]))
  }
  const absolute = declarations(productionCss, '.world-runtime-viewport'), containingBlock = declarations(fixtureCss, '.physics-fixture__viewport')
  assert.equal(absolute.position, 'absolute'); assert.equal(absolute.inset, '0')
  assert.equal(containingBlock.height, '650px'); assert.equal(containingBlock['min-height'], '300px')
  // Source/CSS topology only: no DOM rectangles, browser layout or native hit-test proof.
  assert.equal(containingBlock.position, 'relative', 'SOURCE_LAYOUT_INVARIANT: fixture viewport requires its positioned containing block')
})

'use strict'
// Standalone startup boundary: only Node builtins and Electron load before validation.
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
let runtimeFailure = null
let failureDirectory = null
let startupFailed = false
function handleFailure(error) {
  if (runtimeFailure) { runtimeFailure(error); return }
  if (startupFailed) return
  startupFailed = true
  let message = 'Unknown startup failure.'
  try { message = String(error?.stack ?? error).slice(0, 8192) } catch { /* Bounded fallback. */ }
  try {
    if (failureDirectory) fs.writeFileSync(path.join(failureDirectory, 'startup-failure.json'), JSON.stringify({ status: 'FAIL', phase: 'startup', error: message }), { flag: 'wx', mode: 0o600 })
    else process.stderr.write(`${message}\n`)
  } catch { try { process.stderr.write(`${message}\n`) } catch { /* Exit must not depend on logging. */ } }
  finally { app.exit(1) }
}
process.on('uncaughtException', handleFailure)
process.on('unhandledRejection', handleFailure)

try {
  const bundleDirectory = path.resolve(__dirname)
  assert.equal(path.dirname(bundleDirectory), '/tmp')
  assert.match(path.basename(bundleDirectory), /^modly-worlds-ai-ui-[A-Za-z0-9_-]+$/)
  function directory(filename) {
    assert.equal(fs.realpathSync(filename), filename)
    const info = fs.lstatSync(filename)
    assert.ok(info.isDirectory() && !info.isSymbolicLink())
    assert.equal(info.uid, process.getuid()); assert.equal(info.mode & 0o777, 0o700)
  }
  directory(bundleDirectory)
  const paths = { stateRoot: path.join(bundleDirectory, 'native-state') }
  directory(paths.stateRoot); failureDirectory = paths.stateRoot
  for (const name of ['userData', 'sessionData', 'crashDumps', 'home', 'config', 'cache', 'tmp']) paths[name] = path.join(paths.stateRoot, name)
  paths.agentSessions = path.join(paths.userData, 'agent-sessions')
  const preparedDirectories = Object.values(paths).map((filename) => {
    directory(filename); return { path: filename, uid: process.getuid(), mode: 0o700 }
  })
  const environment = { HOME: paths.home, XDG_CONFIG_HOME: paths.config, XDG_CACHE_HOME: paths.cache, TMPDIR: paths.tmp,
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', DBUS_SESSION_BUS_ADDRESS: 'disabled:' }
  const argv = [process.execPath, path.join(bundleDirectory, 'bootstrap.cjs'), `--user-data-dir=${paths.userData}`]
  const launch = { paths, environment, argv, preparedDirectories }
  assert.equal(__filename, argv[1]); assert.equal(path.basename(process.execPath), 'electron')
  assert.equal(fs.realpathSync(process.execPath), process.execPath)
  assert.equal(JSON.stringify(process.argv), JSON.stringify(argv), 'Reject every extra or mismatched raw argument, including unsafe file-access flags.')
  for (const [name, expected] of Object.entries(environment)) assert.equal(process.env[name], expected, name)
  assert.equal(process.env.DBUS_SESSION_BUS_ADDRESS, 'disabled:', 'DBUS_SESSION_BUS_ADDRESS')
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_DISABLE_SANDBOX', 'SESSION_MANAGER']) assert.equal(Object.hasOwn(process.env, name), false, name)
  assert.match(process.env.DISPLAY ?? '', /^:(?:[9][0-9]|[1-9][0-9]{2,})(?:\.0)?$/)
  assert.equal(app.commandLine.getSwitchValue('user-data-dir'), paths.userData)
  for (const flag of ['no-sandbox', 'no-zygote', 'disable-setuid-sandbox', 'disable-gpu-sandbox', 'disable-web-security']) assert.equal(app.commandLine.hasSwitch(flag), false, flag)
  assert.equal(process.versions.electron, '44.1.1')
  assert.equal(fs.readdirSync(bundleDirectory).some((name) => name.startsWith('run-')), false)
  for (const name of ['startup-attempt.json', 'startup-failure.json']) assert.equal(fs.existsSync(path.join(paths.stateRoot, name)), false, 'Prepared native state is single-use.')
  const manifestPath = path.join(bundleDirectory, 'fixture-build.json')
  assert.equal(fs.realpathSync(manifestPath), manifestPath)
  const manifestInfo = fs.lstatSync(manifestPath)
  assert.ok(manifestInfo.isFile() && manifestInfo.size <= 2 * 1024 * 1024)
  assert.equal(manifestInfo.uid, process.getuid()); assert.equal(manifestInfo.mode & 0o777, 0o600)
  const build = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  assert.equal(build.schema, 'modly.worlds-ai-ui-build.v1'); assert.equal(build.execution, 'NOT_RUN'); assert.equal(build.outputDirectory, bundleDirectory)
  assert.equal(build.versions.electron, process.versions.electron)
  assert.equal(JSON.stringify(build.launch), JSON.stringify(launch))
  const files = Object.entries(build.outputs)
  assert.ok(files.length >= 8 && files.length <= 64)
  for (const name of ['bootstrap.cjs', 'main.cjs', 'preload.cjs', 'renderer/index.html', 'backend/backend.py', 'backend/routers/agent.py', 'backend/routers/world_ai.py', 'backend/routers/__init__.py', 'backend/services/__init__.py', 'backend/services/agent_providers/__init__.py', 'backend/services/agent_providers/openai.py']) assert.ok(Object.hasOwn(build.outputs, name))
  for (const [relative, expected] of files) {
    assert.match(relative, /^(?:(?:bootstrap|main|preload)\.cjs|renderer\/index\.html|renderer\/assets\/[A-Za-z0-9_.-]+\.(?:js|css)|backend\/backend\.py|backend\/routers\/(?:agent|world_ai|__init__)\.py|backend\/services\/(?:__init__\.py|agent_providers\/(?:__init__|openai)\.py))$/)
    const filename = path.join(bundleDirectory, relative)
    assert.equal(fs.realpathSync(filename), filename)
    const info = fs.lstatSync(filename); assert.ok(info.isFile()); assert.equal(info.uid, process.getuid()); assert.equal(info.size, expected.bytes)
    assert.equal(createHash('sha256').update(fs.readFileSync(filename)).digest('hex'), expected.sha256, relative)
  }
  fs.writeFileSync(path.join(paths.stateRoot, 'startup-attempt.json'), JSON.stringify({ pid: process.pid, argv: process.argv, environment }), { flag: 'wx', mode: 0o600 })
  assert.equal(app.isReady(), false)
  assert.equal(app.getPath('userData'), paths.userData, 'Exec-time CLI must already select the same private userData.')
  app.setName('Worlds AI fixture — provider STUB')
  for (const name of ['userData', 'sessionData', 'crashDumps']) { app.setPath(name, paths[name]); assert.equal(app.getPath(name), paths[name]) }
  app.enableSandbox()
  // Electron 44.1.1 appends this internally. Raw supplied flags remain rejected.
  const builtinFileAccess = app.commandLine.hasSwitch('allow-file-access-from-files')
  const runtime = require(path.join(bundleDirectory, 'main.cjs'))
  if (!startupFailed) {
    assert.equal(typeof runtime.startFixture, 'function')
    runtime.startFixture(Object.freeze({ bundleDirectory, build, launch, builtinFileAccess,
      takeOwnership(fail) { assert.equal(runtimeFailure, null); assert.equal(typeof fail, 'function'); runtimeFailure = fail } }))
    assert.equal(typeof runtimeFailure, 'function', 'Runtime must explicitly assume failure ownership.')
  }
} catch (error) { handleFailure(error) }

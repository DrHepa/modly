// Portable Python test runner.
// `python3` is the macOS/Linux name but does not exist on Windows (where the
// interpreter is `python` or the `py` launcher). Try each candidate until one
// actually runs, then run the legacy unittest suite followed by focused pytest
// coverage that unittest discovery cannot collect.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { constants as osConstants } from 'node:os'

const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'api')

const localPython = process.platform === 'win32'
  ? join(apiDir, '.venv', 'Scripts', 'python.exe')
  : join(apiDir, '.venv', 'bin', 'python')
const legacyLocalPython = process.platform === 'win32'
  ? join(apiDir, 'venv', 'Scripts', 'python.exe')
  : join(apiDir, 'venv', 'bin', 'python')

const candidates = [
  [localPython, []],
  [legacyLocalPython, []],
  ['python3', []],
  ['python', []],
  ['py', ['-3']],
]

function works(cmd, prefix) {
  try {
    const r = spawnSync(cmd, [...prefix, '-c', 'import fastapi, pytest, PIL'], { stdio: 'ignore' })
    return r.status === 0
  } catch {
    return false
  }
}

function childExitCode(result, phase) {
  if (typeof result.status === 'number') return result.status
  if (result.error) {
    console.error(`[run-pytests] ${phase} failed to start: ${result.error.message}`)
    return 1
  }
  if (result.signal) {
    console.error(`[run-pytests] ${phase} terminated by ${result.signal}.`)
    const signalNumber = osConstants.signals[result.signal]
    return typeof signalNumber === 'number' ? 128 + signalNumber : 1
  }
  return 1
}

const found = candidates.find(([cmd, prefix]) => works(cmd, prefix))
if (!found) {
  console.error(
    '[run-pytests] No Python interpreter with the API test dependencies was found '
      + '(tried api/.venv, api/venv, python3, python, py -3).',
  )
  process.exit(1)
}

const [cmd, prefix] = found
const cliTestsResult = spawnSync(cmd, [...prefix, '-m', 'unittest', 'discover', '-s', join(apiDir, '..', 'tools', 'modly-cli'), '-p', 'test*.py'], {
  cwd: join(apiDir, '..'),
  stdio: 'inherit',
})
const cliTestsStatus = childExitCode(cliTestsResult, 'Modly CLI unittest')
if (cliTestsStatus !== 0) process.exit(cliTestsStatus)
const unittestResult = spawnSync(cmd, [...prefix, '-m', 'unittest', 'discover', '-s', 'tests'], {
  cwd: apiDir,
  stdio: 'inherit',
})
const unittestStatus = childExitCode(unittestResult, 'unittest')
if (unittestStatus !== 0) process.exit(unittestStatus)

const pytestResult = spawnSync(cmd, [
  ...prefix,
  '-m',
  'pytest',
  'tests/test_agent.py',
  'tests/test_agent_direct_actions.py',
  'tests/test_agent_worlds.py',
  'tests/test_collection_safety.py',
  'tests/test_generation_inputs.py',
  'tests/test_hf_download_assets.py',
  'tests/test_https_download_assets.py',
  'tests/test_secondary_image_custody.py',
  'tests/test_video_generation.py',
  'tests/test_workspace_route_security.py',
  '-q',
], {
  cwd: apiDir,
  stdio: 'inherit',
})
process.exit(childExitCode(pytestResult, 'focused pytest'))

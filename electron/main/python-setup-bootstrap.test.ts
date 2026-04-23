import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildManagedVenvInstallArgs,
  PYTHON_SETUP_VERSION,
} from './python-setup-bootstrap.ts'

test('buildManagedVenvInstallArgs upgrades packaging tools before requirements install', () => {
  const requirementsPath = '/tmp/modly/api/requirements.txt'

  assert.deepEqual(buildManagedVenvInstallArgs(requirementsPath), [
    '-m',
    'pip',
    'install',
    '--upgrade',
    'pip',
    'setuptools',
    'wheel',
    '-r',
    requirementsPath,
    '--no-warn-script-location',
    '--progress-bar',
    'off',
  ])
})

test('PYTHON_SETUP_VERSION invalidates pre-bootstrap managed environments', () => {
  assert.equal(PYTHON_SETUP_VERSION, 4)
})

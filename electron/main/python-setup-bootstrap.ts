export const PYTHON_SETUP_VERSION = 4
const PACKAGING_BOOTSTRAP_PACKAGES = ['pip', 'setuptools', 'wheel'] as const

export function buildManagedVenvInstallArgs(requirementsPath: string): string[] {
  return [
    '-m',
    'pip',
    'install',
    '--upgrade',
    ...PACKAGING_BOOTSTRAP_PACKAGES,
    '-r',
    requirementsPath,
    '--no-warn-script-location',
    '--progress-bar',
    'off',
  ]
}

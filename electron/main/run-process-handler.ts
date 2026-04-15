import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'

import type { ProcessInput, ProcessResult } from '../../src/shared/types/electron.d'
import type { ParsedManifest } from './automation-capabilities'
import type { IProcessRunner, ProcessRunner, PythonProcessRunner } from './process-runner'

type RunProcessSettings = {
  extensionsDir: string
  workspaceDir: string
}

type RunProcessResponse = {
  success: boolean
  result?: ProcessResult
  error?: string
}

type RunProcessRunnerFactory = (
  extensionId: string,
  extDir: string,
  entry: string,
  workspaceDir: string,
  tempDir: string,
) => ProcessRunner | IProcessRunner

type RunPythonProcessRunnerFactory = (
  extensionId: string,
  pythonExe: string,
  extDir: string,
  entry: string,
  workspaceDir: string,
  tempDir: string,
) => PythonProcessRunner | IProcessRunner

export type RunProcessExtensionDeps = {
  extensionId: string
  input: ProcessInput
  params: Record<string, unknown>
  getUserDataPath: () => string
  getTempPath: () => string
  getSettings: (userData: string) => RunProcessSettings
  getBuiltinExtensionsDir: () => string
  getExtPythonExe: (extDir: string) => string | null
  getVenvPythonExe: (userData: string) => string
  getProcessRunner: RunProcessRunnerFactory
  getPythonProcessRunner: RunPythonProcessRunnerFactory
}

export async function runProcessExtensionWithDeps(deps: RunProcessExtensionDeps): Promise<RunProcessResponse> {
  const userData = deps.getUserDataPath()
  const { extensionsDir, workspaceDir } = deps.getSettings(userData)

  const builtinExtDir = join(deps.getBuiltinExtensionsDir(), deps.extensionId)
  const userExtDir = join(extensionsDir, deps.extensionId)
  const extDir = existsSync(builtinExtDir) ? builtinExtDir : userExtDir

  if (!existsSync(extDir)) {
    return { success: false, error: `Extension "${deps.extensionId}" not found` }
  }

  try {
    const manifestRaw = await readFile(join(extDir, 'manifest.json'), 'utf-8')
    const manifest = JSON.parse(manifestRaw) as ParsedManifest
    if (manifest.type !== 'process') {
      return { success: false, error: `Extension "${deps.extensionId}" is not a process extension` }
    }

    const entry = manifest.entry ?? 'processor.js'
    const tempDir = deps.getTempPath()
    const runner = entry.endsWith('.py')
      ? deps.getPythonProcessRunner(
        deps.extensionId,
        deps.getExtPythonExe(extDir) ?? deps.getVenvPythonExe(userData),
        extDir,
        entry,
        workspaceDir,
        tempDir,
      )
      : deps.getProcessRunner(deps.extensionId, extDir, entry, workspaceDir, tempDir)

    const result = await runner.run(deps.input, deps.params)
    return { success: true, result }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

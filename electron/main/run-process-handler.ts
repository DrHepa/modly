import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'

import type { ProcessInput, ProcessResult } from '../../src/shared/types/electron.d'
import { parseExtensionManifest, type ParsedManifest } from './automation-capabilities'
import { getProcessTargetPorts, hasNamedProcessInputs } from '../../src/areas/workflows/processPorts'
import { validateProcessScene } from './process-scene-boundary'
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

    const hasScene = (node: NonNullable<ParsedManifest['nodes']>[number]) => node.input === 'scene' || node.output === 'scene'
      || node.inputs?.some((port) => (typeof port === 'string' ? port : port.type) === 'scene')
    const suppliedScene = Object.values(deps.input.inputs ?? {}).some((value) => value?.type === 'scene')
    const matches = (manifest.nodes ?? []).filter((node) => node.id === deps.input.nodeId)
    const sceneBoundary = suppliedScene || matches.some(hasScene)
      || (matches.length !== 1 && manifest.nodes?.some(hasScene))
    let input = deps.input
    let sceneOutput = false
    if (sceneBoundary) {
      if (matches.length !== 1) throw new Error('Scene process requires an unambiguous selected nodeId')
      const selected = parseExtensionManifest({ ...manifest, nodes: matches }, deps.extensionId, new Set()).nodes[0]
      sceneOutput = selected.output === 'scene'
      const named = hasNamedProcessInputs(selected.inputs)
      const ports = getProcessTargetPorts(selected)
      const values = { ...deps.input.inputs }
      input = { ...deps.input, ...(deps.input.inputs ? { inputs: values } : {}) }
      for (const [name, value] of Object.entries(values)) {
        if (value?.type === 'scene' && !ports.some((port) => (port.name ?? 'input-0') === name && port.type === 'scene')) {
          throw new Error(`Scene input does not match declared port "${name}"`)
        }
      }
      for (const port of ports) {
        if (port.type !== 'scene') continue
        const name = port.name ?? 'input-0'
        const value = Object.hasOwn(values, name) ? values[name] : undefined
        // Legacy fallback is only unambiguous for a genuinely single scene slot.
        const legacy = !named && ports.length === 1 && !value && deps.input.inputs === undefined
        if (!value && !legacy && !port.required) continue
        const sourcePath = legacy ? input.filePath : value?.filePath
        if ((!legacy && value?.type !== 'scene') || !sourcePath) {
          throw new Error(`Required scene port "${name}" has no scene file`)
        }
        const canonical = await validateProcessScene(workspaceDir, sourcePath)
        if (legacy) input.filePath = canonical
        else {
          Object.defineProperty(values, name, { enumerable: true, configurable: true, writable: true, value: { ...value, filePath: canonical } })
          if (!named && input.filePath === sourcePath) input.filePath = canonical
        }
      }
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

    let result = await runner.run(input, deps.params)
    if (sceneOutput) {
      if (!result.filePath || (result.outputType !== undefined && result.outputType !== 'scene')) {
        throw new Error('Scene process must return an explicit scene manifest output')
      }
      result = { ...result, filePath: await validateProcessScene(workspaceDir, result.filePath) }
    }
    return { success: true, result }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

import { isAbsolute, normalize, relative, resolve as resolvePath } from 'node:path'

function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value)
}

export function resolveWorkspaceOutputDir(workspaceDir: string, outputPath: string): string {
  const trimmed = outputPath.trim()
  if (!trimmed) return resolvePath(workspaceDir, 'Exports')

  const normalizedInput = trimmed.replace(/\\/g, '/')
  if (isAbsolute(normalizedInput) || isWindowsAbsolutePath(normalizedInput)) {
    throw new Error('mesh-exporter: output_path must be workspace-relative; absolute paths are rejected')
  }

  const normalizedRelative = normalize(normalizedInput).replace(/\\/g, '/')
  if (
    normalizedRelative === '.'
    || normalizedRelative === '..'
    || normalizedRelative.startsWith('../')
    || normalizedRelative.includes('/../')
  ) {
    throw new Error('mesh-exporter: output_path must stay inside the workspace; traversal is rejected')
  }

  const resolvedWorkspaceDir = resolvePath(workspaceDir)
  const resolvedOutputDir = resolvePath(resolvedWorkspaceDir, normalizedRelative)
  const relativeToWorkspace = relative(resolvedWorkspaceDir, resolvedOutputDir).replace(/\\/g, '/')
  if (
    relativeToWorkspace === '..'
    || relativeToWorkspace.startsWith('../')
    || isAbsolute(relativeToWorkspace)
  ) {
    throw new Error('mesh-exporter: output_path escapes the workspace and was rejected')
  }

  return resolvedOutputDir
}

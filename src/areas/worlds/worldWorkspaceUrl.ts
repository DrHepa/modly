export function createWorldWorkspaceUrl(apiUrl: string, workspacePath: string): string {
  const encodedPath = workspacePath.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  const base = apiUrl.trim().replace(/\/+$/, '')
  return `${base}/workspace/${encodedPath}`
}

export function resolveWorkflowOutputWorldsWorkspacePath(outputUrl: string): string | null {
  const trimmed = outputUrl.trim()
  if (!trimmed) return null

  const path = (() => {
    if (trimmed.startsWith('/workspace/')) return trimmed.slice('/workspace/'.length)
    try {
      const url = new URL(trimmed)
      return url.pathname.startsWith('/workspace/') ? url.pathname.slice('/workspace/'.length) : null
    } catch {
      return null
    }
  })()

  if (!path) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(path).replace(/\\/g, '/').replace(/^\.\//, '')
  } catch {
    return null
  }
  if (!decoded || decoded.startsWith('/') || /^[A-Za-z]:\//.test(decoded) || decoded.includes('\0')) return null
  if (/%2e|%2f|%5c/i.test(decoded)) return null
  if (decoded.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return null
  return decoded
}

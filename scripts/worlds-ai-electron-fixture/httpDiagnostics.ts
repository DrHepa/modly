const VISIBLE_HEADER_LIMIT = 160
const SAFE_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const SAFE_HEADER_NAMES = new Set(['accept', 'accept-language', 'content-language', 'content-type'])

export function safeFixtureRequest(url: string, method: string, apiOrigin: string, error?: string): Record<string, unknown> {
  let pathLabel = '<redacted>'
  try {
    const parsed = new URL(url)
    if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.origin === apiOrigin && parsed.pathname === '/agent/chat') pathLabel = '/agent/chat'
  } catch { pathLabel = '<redacted>' }
  const methodLabel = safeMethod(method) ?? '<redacted>'
  const result: Record<string, unknown> = { path: pathLabel, method: methodLabel }
  if (error) result.error = error.includes('CORS') ? 'cors_or_network' : 'network'
  return result
}

export function safeResponseCorsHeaders(headers: Record<string, string[] | undefined> | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const name of ['access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-max-age']) {
    const value = getHeaderValue(headers, name)
    if (value === undefined) continue
    if (name === 'access-control-allow-origin') result[name] = safeOrigin(value)
    else if (name === 'access-control-allow-methods') result[name] = value.split(',').map((entry) => safeMethod(entry.trim()) ?? '<redacted>')
    else if (name === 'access-control-allow-headers') result[name] = safeHeaderNames(value)
    else if (name === 'access-control-max-age') result[name] = /^\d{1,8}$/.test(value) ? value : '<redacted>'
  }
  return result
}

export function safeOrigin(value: unknown): Record<string, string> {
  const text = safeVisibleText(value)
  if (text === null) return { kind: value === undefined || value === null ? 'absent' : 'redacted' }
  if (text === 'null') return { kind: 'null' }
  if (text === '*') return { kind: 'wildcard' }
  if (text === 'file://') return { kind: 'file', value: 'file://' }
  try {
    const parsed = new URL(text)
    if (parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.port
      && Number.isInteger(Number(parsed.port)) && Number(parsed.port) >= 1024 && Number(parsed.port) <= 65535
      && parsed.username === '' && parsed.password === '' && parsed.pathname === '/' && parsed.search === '' && parsed.hash === '') {
      return { kind: 'loopback', value: `http://127.0.0.1:${parsed.port}` }
    }
  } catch { return { kind: 'redacted' } }
  return { kind: 'redacted' }
}

function safeMethod(value: unknown): string | null {
  const text = safeVisibleText(value)
  if (text === null) return null
  const method = text.toUpperCase()
  return SAFE_METHODS.has(method) ? method : null
}

function safeHeaderNames(value: unknown): string[] {
  const text = safeVisibleText(value)
  if (text === null) return ['<redacted>']
  return text.split(',').slice(0, 12).map((raw) => {
    const name = raw.trim().toLowerCase()
    return SAFE_HEADER_NAMES.has(name) ? name : '<redacted>'
  }).filter((name) => name.length > 0)
}

function getHeaderValue(headers: Record<string, string[] | undefined> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const entry = Object.entries(headers).find(([candidate]) => candidate.toLowerCase() === name)
  const value = entry?.[1]?.[0]
  return safeVisibleText(value) ?? '<redacted>'
}

function safeVisibleText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > VISIBLE_HEADER_LIMIT || /[\u0000-\u001f\u007f]/.test(value)) return null
  return value
}

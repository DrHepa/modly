import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const indexHtmlPath = resolve(currentDirectory, '../src/index.html')

async function readCspDirectives() {
  const indexHtml = await readFile(indexHtmlPath, 'utf8')
  const cspMatch = indexHtml.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/>/)

  assert.ok(cspMatch, 'expected Content-Security-Policy meta tag in src/index.html')

  return Object.fromEntries(
    cspMatch[1]
      .split(';')
      .map((directive) => directive.trim())
      .filter(Boolean)
      .map((directive) => {
        const [name, ...values] = directive.split(/\s+/)
        return [name, values.join(' ')]
      }),
  )
}

test('src/index.html allows FastAPI preview images only from the verified img-src origin', async () => {
  const directives = await readCspDirectives()

  assert.equal(directives['img-src'], "'self' data: blob: file: http://127.0.0.1:8765")
})

test('src/index.html keeps every non-img-src CSP directive unchanged', async () => {
  const directives = await readCspDirectives()

  assert.deepEqual(
    Object.fromEntries(Object.entries(directives).filter(([name]) => name !== 'img-src')),
    {
      'default-src': "'self'",
      'script-src': "'self' 'wasm-unsafe-eval'",
      'style-src': "'self' 'unsafe-inline' https://fonts.googleapis.com",
      'font-src': "'self' https://fonts.gstatic.com",
      'connect-src': "'self' blob: http://127.0.0.1:8765 http://localhost:8080 https://api.github.com",
      'worker-src': "'self' blob:",
    },
  )
})

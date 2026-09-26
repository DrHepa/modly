import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const indexHtmlPath = resolve(currentDirectory, '../src/index.html')
const worldRenderHtmlPath = resolve(currentDirectory, '../src/world-render.html')
const worldRenderEntryPath = resolve(currentDirectory, '../src/areas/worlds/render/worldRenderEntry.ts')

async function readCspDirectives(path = indexHtmlPath) {
  const indexHtml = await readFile(path, 'utf8')
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

test('hidden world renderer keeps a network-denying isolated CSP', async () => {
  const directives = await readCspDirectives(worldRenderHtmlPath)

  assert.deepEqual(directives, {
    'default-src': "'none'",
    'script-src': "'self'",
    'style-src': "'self' 'unsafe-inline'",
    'img-src': "'self' data: blob:",
    'media-src': 'blob:',
    'connect-src': "'none'",
    'worker-src': "'self'",
    'font-src': "'none'",
    'object-src': "'none'",
    'frame-src': "'none'",
    'base-uri': "'none'",
    'form-action': "'none'",
  })
})

test('hidden world renderer launches only its bundled module WebM worker', async () => {
  const source = await readFile(worldRenderEntryPath, 'utf8')
  assert.match(source, /new Worker\(new URL\('\.\/worldWebm\.worker\.ts', import\.meta\.url\), \{ type: 'module', name: 'worlds-webm' \}\)/)
  assert.doesNotMatch(source, /createObjectURL|data:|eval\(|new Function/)
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

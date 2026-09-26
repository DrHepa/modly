/**
 * Compile built-in extensions (TypeScript → CommonJS JS) and copy manifests.
 * Output: out/builtin-extensions/{id}/processor.js + manifest.json
 */

import { execFileSync }                                       from 'child_process'
import { readdirSync, existsSync, cpSync, mkdirSync, statSync } from 'fs'
import { join, dirname }                                      from 'path'
import { fileURLToPath }                                      from 'url'

const root   = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src', 'areas', 'workflows', 'nodes')
const outDir = join(root, 'out', 'builtin-extensions')

function runNpm(args, cwd) {
  const options = { cwd, stdio: 'inherit' }
  if (process.env.npm_execpath) {
    execFileSync(process.execPath, [process.env.npm_execpath, ...args], options)
    return
  }
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, options)
}

if (!existsSync(srcDir)) {
  console.log('[build-builtins] No builtin-extensions directory found, skipping.')
  process.exit(0)
}

// 1. Compile TypeScript
console.log('[build-builtins] Compiling TypeScript…')
execFileSync(process.execPath, [
  join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
  '-p',
  'tsconfig.builtins.json',
], { cwd: root, stdio: 'inherit' })

// 2. Copy manifests and lockfile-backed packages, then run npm ci.
for (const id of readdirSync(srcDir)) {
  const extSrcDir = join(srcDir, id)
  if (!statSync(extSrcDir).isDirectory()) continue
  // Only process extension folders (those with a manifest.json)
  if (!existsSync(join(extSrcDir, 'manifest.json'))) continue

  const extOutDir = join(outDir, id)
  mkdirSync(extOutDir, { recursive: true })

  const manifestSrc = join(extSrcDir, 'manifest.json')
  if (existsSync(manifestSrc)) {
    cpSync(manifestSrc, join(extOutDir, 'manifest.json'))
    console.log(`[build-builtins] ${id}: manifest.json copied`)
  } else {
    console.warn(`[build-builtins] ${id}: manifest.json missing — skipping`)
  }

  const pkgSrc = join(extSrcDir, 'package.json')
  if (existsSync(pkgSrc)) {
    const lockSrc = join(extSrcDir, 'package-lock.json')
    if (!existsSync(lockSrc)) {
      throw new Error(`[build-builtins] ${id}: package-lock.json is required`)
    }
    cpSync(pkgSrc, join(extOutDir, 'package.json'))
    cpSync(lockSrc, join(extOutDir, 'package-lock.json'))
    console.log(`[build-builtins] ${id}: Installing locked npm dependencies with npm ci…`)
    runNpm(['ci', '--offline', '--omit=dev', '--no-audit', '--no-fund'], extOutDir)
    console.log(`[build-builtins] ${id}: npm ci done`)
  }

  // Copy any Python processor files
  for (const file of readdirSync(extSrcDir)) {
    if (file.endsWith('.py')) {
      cpSync(join(extSrcDir, file), join(extOutDir, file))
      console.log(`[build-builtins] ${id}: ${file} copied`)
    }
  }
}

console.log('[build-builtins] Done.')

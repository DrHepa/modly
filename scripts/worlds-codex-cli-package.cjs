'use strict'

const { createHash } = require('node:crypto')
const { constants } = require('node:fs')
const { lstat, open } = require('node:fs/promises')
const { isAbsolute, join, parse, resolve, sep } = require('node:path')

// These are source-owned package inputs, not credentials or a remote trust root.
// A reviewed CLI or skill edit must update its exact byte receipt here.
const FILES = Object.freeze([
  Object.freeze({ name: 'agent.py', size: 82680, sha256: 'b357faf33f17a3ae3c8c57ee20456e8881898f39994a6bb221406fedd35c1a97' }),
  Object.freeze({ name: 'SKILL.md', size: 10411, sha256: '8c5818dc17d0de694ef2462193d4158082eb269030edb9e99431f817a66af05d' }),
])

function safeRoot(root) {
  return typeof root === 'string' && isAbsolute(root) && root === resolve(root)
    && !root.includes('\0') && !/[\r\n]/.test(root)
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
}

async function safeDirectories(root, subdirectory) {
  const driveRoot = parse(root).root
  const parts = [
    ...root.slice(driveRoot.length).split(sep).filter(Boolean),
    ...subdirectory.split('/'),
  ]
  let current = driveRoot
  for (const part of ['', ...parts]) {
    if (part) current = join(current, part)
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) return false
  }
  return true
}

async function verifyFile(root, subdirectory, entry) {
  if (!await safeDirectories(root, subdirectory)) return { ok: false, code: 'cli-path-unsafe' }
  const filePath = join(root, ...subdirectory.split('/'), entry.name)
  const before = await lstat(filePath)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    return { ok: false, code: 'cli-path-unsafe' }
  }
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let digest
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameIdentity(before, opened)
      || opened.size !== entry.size || opened.nlink !== 1) {
      return { ok: false, code: 'cli-file-mismatch' }
    }
    digest = createHash('sha256').update(await handle.readFile()).digest('hex')
    const after = await lstat(filePath)
    if (!sameIdentity(before, after) || !await safeDirectories(root, subdirectory)) {
      return { ok: false, code: 'cli-path-unsafe' }
    }
  } finally {
    await handle.close()
  }
  return digest === entry.sha256
    ? { ok: true }
    : { ok: false, code: 'cli-file-mismatch' }
}

async function verifyWorldsCodexCliBundle(root, mode) {
  if (mode !== 'source' && mode !== 'packaged') return { ok: false, code: 'cli-mode-invalid' }
  if (!safeRoot(root)) return { ok: false, code: 'cli-root-invalid' }
  const subdirectory = mode === 'source' ? 'tools/modly-cli' : 'modly-cli'
  for (const entry of FILES) {
    try {
      const result = await verifyFile(root, subdirectory, entry)
      if (!result.ok) return result
    } catch (error) {
      if (error && error.code === 'ENOENT') return { ok: false, code: 'cli-file-missing' }
      return { ok: false, code: 'cli-path-unsafe' }
    }
  }
  return { ok: true }
}

module.exports = { verifyWorldsCodexCliBundle }

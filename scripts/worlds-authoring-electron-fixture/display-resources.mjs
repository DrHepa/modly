// Read-only guards for the two exact filesystem paths allocated by the owned Xvfb.
// No server launch, global display enumeration, symlink following or unlink capability.
import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'

function identity(filename, info) {
  return { path: filename, device: String(info.dev), inode: String(info.ino), uid: Number(info.uid), mode: Number(info.mode), ctimeNs: String(info.ctimeNs), type: info.isSocket() ? 'socket' : info.isFile() ? 'file' : info.isSymbolicLink() ? 'symlink-not-followed' : 'other' }
}
async function observe(filename) {
  try { return identity(filename, await lstat(filename, { bigint: true })) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
export async function captureOwnedDisplayResources(paths, pid, uid) {
  const socket = await observe(paths.socket), lock = await observe(paths.lock)
  assert.equal(socket?.type, 'socket', 'Owned display socket is not a socket')
  assert.equal(socket.uid, uid, 'Owned display socket UID changed')
  assert.equal(lock?.type, 'file', 'Owned display lock is not a regular file')
  assert.equal(lock.uid, uid, 'Owned display lock UID changed')
  // NONBLOCK prevents a swapped FIFO from blocking; fstat rejects it before any read.
  const handle = await open(paths.lock, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let lockPid
  try {
    const info = await handle.stat({ bigint: true })
    assert.deepEqual(identity(paths.lock, info), lock, 'Owned display lock identity changed while opening')
    assert.ok(info.size > 0n && info.size < 64n, 'Unexpected X lock size')
    const buffer = Buffer.alloc(64), result = await handle.read(buffer, 0, buffer.length, 0)
    const value = buffer.subarray(0, result.bytesRead).toString('utf8').trim()
    assert.match(value, /^[1-9][0-9]*$/, 'Invalid X lock PID')
    lockPid = Number(value)
    assert.equal(lockPid, pid, 'The chosen display is not owned by the spawned Xvfb')
  } finally { await handle.close() }
  assert.deepEqual(await observe(paths.socket), socket, 'Owned display socket identity changed during capture')
  assert.deepEqual(await observe(paths.lock), lock, 'Owned display lock identity changed during capture')
  return { capturedAt: new Date().toISOString(), pid, uid, socket, lock, lockPid }
}
export async function waitForDisplayResourcesAbsent(paths, timeoutMs = 1000) {
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 1000, 'Display cleanup check must be bounded to one second')
  const startedAt = new Date().toISOString(), deadline = Date.now() + timeoutMs, observations = []
  // Bound attempts independently of the wall clock. Presence, including replacement/symlink, is failure.
  for (let attempt = 0; attempt <= Math.ceil(timeoutMs / 40); attempt += 1) {
    const resources = { socket: await observe(paths.socket), lock: await observe(paths.lock) }
    observations.push({ at: new Date().toISOString(), ...resources })
    if (!resources.socket && !resources.lock) return { status: 'ABSENT', scope: 'exact-filesystem-paths-only', startedAt, timeoutMs, observations }
    if (Date.now() >= deadline || attempt === Math.ceil(timeoutMs / 40)) break
    await new Promise((resolve) => setTimeout(resolve, Math.min(40, Math.max(0, deadline - Date.now()))))
  }
  return { status: 'REMAINS', scope: 'exact-filesystem-paths-only', startedAt, timeoutMs, observations }
}

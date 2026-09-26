import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux', 'win32'])

/**
 * Flush a completed regular file. Callers that wrote through an existing
 * handle should flush that handle directly; this authority is for copied or
 * linked files whose creating handle is no longer available.
 */
export async function syncWorldFfmpegFile(path, options = {}) {
  const openFile = options.openFile ?? open
  const handle = await openFile(path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('World FFmpeg durability target is not a regular file.')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Node/libuv cannot portably obtain a Windows directory handle that
 * FlushFileBuffers accepts. Every file is flushed before this point and all
 * publication operations remain exclusive/no-overwrite. POSIX directory
 * metadata is additionally fsynced; Windows records the explicit unsupported
 * boundary instead of attempting a known-invalid O_RDONLY directory fsync.
 */
export async function syncWorldFfmpegDirectory(path, options = {}) {
  const platform = options.platform ?? process.platform
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error('World FFmpeg directory durability platform is unsupported.')
  }
  const supported = platform !== 'win32'
  const event = Object.freeze({ path, platform, supported })
  options.onDirectorySync?.(event)
  if (!supported) return event

  const openDirectory = options.openDirectory ?? open
  const handle = await openDirectory(path, constants.O_RDONLY)
  try {
    const info = await handle.stat()
    if (!info.isDirectory()) throw new Error('World FFmpeg durability target is not a directory.')
    await handle.sync()
  } finally {
    await handle.close()
  }
  return event
}

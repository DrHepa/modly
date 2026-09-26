let custodyTail = Promise.resolve()

export async function runWithWorldFfmpegCwdCustody(directory, operation) {
  if (typeof directory !== 'string' || directory.length < 1 || directory.includes('\0')
    || typeof operation !== 'function') {
    throw new Error('World FFmpeg working-directory custody input is invalid.')
  }
  const previous = custodyTail
  let releaseCustody
  custodyTail = new Promise((resolvePromise) => { releaseCustody = resolvePromise })
  await previous
  const originalCwd = process.cwd()
  try {
    process.chdir(directory)
    return await operation()
  } finally {
    try {
      process.chdir(originalCwd)
    } finally {
      releaseCustody()
    }
  }
}

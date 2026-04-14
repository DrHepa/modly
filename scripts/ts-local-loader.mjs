import { access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function resolve(specifier, context, defaultResolve) {
  try {
    return await defaultResolve(specifier, context, defaultResolve)
  } catch (error) {
    if (
      !error
      || typeof error !== 'object'
      || !('code' in error)
      || error.code !== 'ERR_MODULE_NOT_FOUND'
      || !context.parentURL
      || (!specifier.startsWith('./') && !specifier.startsWith('../'))
    ) {
      throw error
    }

    const parentDir = path.dirname(fileURLToPath(context.parentURL))
    const candidatePath = path.resolve(parentDir, `${specifier}.ts`)

    try {
      await access(candidatePath)
      return defaultResolve(pathToFileURL(candidatePath).href, context, defaultResolve)
    } catch {
      throw error
    }
  }
}

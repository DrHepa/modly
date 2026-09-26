import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { randomUUID as systemRandomUUID } from 'node:crypto'
import { basename, extname, isAbsolute, join, relative } from 'node:path'


export interface VideoInputSelection {
  workspacePath: string
  displayName: string
}

export type ImportVideoInputArgs = {
  sourcePath: string
  workspaceDir: string
  randomUUID?: () => string
}

const MAX_VIDEO_BYTES = 8 * 1024 ** 3
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi'])
const DURABLE_WORKSPACE_ROOTS = new Set(['Workflows', 'Exports'])

function isWithinWorkspace(filePath: string, workspaceDir: string): boolean {
  const relativePath = relative(workspaceDir, filePath)
  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(relativePath)
}

function isWithinDurableWorkspaceRoot(filePath: string, workspaceDir: string): boolean {
  if (!isWithinWorkspace(filePath, workspaceDir)) return false
  const [root] = relative(workspaceDir, filePath).split(/[\\/]/)
  return DURABLE_WORKSPACE_ROOTS.has(root)
}

function toWorkspacePath(workspaceDir: string, filePath: string): string {
  return relative(workspaceDir, filePath).replace(/\\/g, '/')
}

function safeVideoName(displayName: string): string {
  const extension = extname(displayName).toLowerCase()
  const stem = basename(displayName, extname(displayName))
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 96)
  return `${stem || 'video'}${extension}`
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code
}

function validateVideoFileInfo(info: { isFile(): boolean; size: number }, sourcePath: string): void {
  if (!info.isFile()) throw new Error('Selected video path must reference a regular file.')
  if (info.size <= 0 || info.size > MAX_VIDEO_BYTES) throw new Error('Selected video must be between 1 byte and 8 GiB.')
  if (!VIDEO_EXTENSIONS.has(extname(sourcePath).toLowerCase())) throw new Error('Selected video uses an unsupported extension.')
}

async function ensureSafeDestinationDirectory(
  parentDirectory: string,
  directoryName: string,
  canonicalWorkspace: string,
): Promise<string> {
  const directoryPath = join(parentDirectory, directoryName)
  try {
    await mkdir(directoryPath)
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) throw error
  }

  const canonicalDirectory = await realpath(directoryPath)
  if (!isWithinWorkspace(canonicalDirectory, canonicalWorkspace)) {
    throw new Error('Video input destination must remain inside the configured workspace.')
  }
  if (!(await stat(canonicalDirectory)).isDirectory()) {
    throw new Error('Video input destination must reference a directory.')
  }
  return canonicalDirectory
}

export async function importVideoInputToWorkspace({
  sourcePath,
  workspaceDir,
  randomUUID = systemRandomUUID,
}: ImportVideoInputArgs): Promise<VideoInputSelection> {
  if (typeof sourcePath !== 'string' || sourcePath.trim().length === 0 || !isAbsolute(sourcePath)) {
    throw new Error('Video selection must be a non-empty absolute file path.')
  }
  if (typeof workspaceDir !== 'string' || workspaceDir.trim().length === 0) {
    throw new Error('Configured workspace path is required.')
  }

  const displayName = basename(sourcePath)
  const sourceLinkInfo = await lstat(sourcePath)
  if (sourceLinkInfo.isSymbolicLink()) throw new Error('Selected video path must not be a symbolic link.')
  validateVideoFileInfo(sourceLinkInfo, sourcePath)

  await mkdir(workspaceDir, { recursive: true })
  const canonicalWorkspace = await realpath(workspaceDir)
  const canonicalSource = await realpath(sourcePath)

  const sourceStat = await stat(canonicalSource)
  validateVideoFileInfo(sourceStat, sourcePath)

  if (isWithinDurableWorkspaceRoot(canonicalSource, canonicalWorkspace)) {
    return {
      workspacePath: toWorkspacePath(canonicalWorkspace, canonicalSource),
      displayName,
    }
  }

  const canonicalWorkflowsDirectory = await ensureSafeDestinationDirectory(
    canonicalWorkspace,
    'Workflows',
    canonicalWorkspace,
  )
  const canonicalDestinationDirectory = await ensureSafeDestinationDirectory(
    canonicalWorkflowsDirectory,
    'Imported Videos',
    canonicalWorkspace,
  )

  const uniqueName = `${randomUUID()}-${safeVideoName(displayName)}`
  const destinationPath = join(canonicalDestinationDirectory, uniqueName)
  await copyFile(canonicalSource, destinationPath, constants.COPYFILE_EXCL)
  const copied = await lstat(destinationPath)
  if (!copied.isFile() || copied.size !== sourceStat.size) throw new Error('Imported video copy could not be verified.')

  return {
    workspacePath: toWorkspacePath(canonicalWorkspace, destinationPath),
    displayName,
  }
}

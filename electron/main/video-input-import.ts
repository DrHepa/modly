import { constants } from 'node:fs'
import { copyFile, mkdir, realpath, stat } from 'node:fs/promises'
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

  await mkdir(workspaceDir, { recursive: true })
  const canonicalWorkspace = await realpath(workspaceDir)
  const canonicalSource = await realpath(sourcePath)

  const sourceStat = await stat(canonicalSource)
  if (!sourceStat.isFile()) {
    throw new Error('Selected video path must reference a regular file.')
  }

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
  const canonicalInputsDirectory = await ensureSafeDestinationDirectory(
    canonicalWorkflowsDirectory,
    'Inputs',
    canonicalWorkspace,
  )
  const canonicalDestinationDirectory = await ensureSafeDestinationDirectory(
    canonicalInputsDirectory,
    'Videos',
    canonicalWorkspace,
  )

  const uniqueName = `${randomUUID()}-${safeVideoName(displayName)}`
  const destinationPath = join(canonicalDestinationDirectory, uniqueName)
  await copyFile(canonicalSource, destinationPath, constants.COPYFILE_EXCL)

  return {
    workspacePath: toWorkspacePath(canonicalWorkspace, destinationPath),
    displayName,
  }
}

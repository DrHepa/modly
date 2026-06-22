import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { basename, join } from 'path'

export type StoredWorkflow = { id?: unknown; name?: unknown; updatedAt?: unknown; [key: string]: unknown }

export interface WorkflowListDiagnostics {
  filenameIdMismatches: Array<{ file: string; fileId: string; workflowId: string }>
  duplicateIds: Array<{ workflowId: string; files: string[] }>
  corruptedFiles: Array<{ file: string; error: string }>
}

interface WorkflowFileRecord {
  file: string
  fileId: string
  workflowId: string
  workflow: StoredWorkflow
  mtimeMs: number
}

export async function listStoredWorkflows(workflowsDir: string): Promise<{ workflows: StoredWorkflow[]; diagnostics: WorkflowListDiagnostics }> {
  await mkdir(workflowsDir, { recursive: true })
  const files = (await readdir(workflowsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
  const diagnostics: WorkflowListDiagnostics = { filenameIdMismatches: [], duplicateIds: [], corruptedFiles: [] }
  const records: WorkflowFileRecord[] = []

  await Promise.all(files.map(async (file) => {
    try {
      const absolutePath = join(workflowsDir, file)
      const raw = await readFile(absolutePath, 'utf-8')
      const workflow = JSON.parse(raw) as StoredWorkflow
      const workflowId = typeof workflow.id === 'string' ? workflow.id : ''
      if (!workflowId) throw new Error('Workflow is missing a string id')
      const fileId = file.replace(/\.json$/, '')
      const fileStat = await stat(absolutePath)
      if (fileId !== workflowId) diagnostics.filenameIdMismatches.push({ file, fileId, workflowId })
      records.push({ file, fileId, workflowId, workflow, mtimeMs: fileStat.mtimeMs })
    } catch (error) {
      diagnostics.corruptedFiles.push({ file, error: String(error) })
    }
  }))

  const grouped = new Map<string, WorkflowFileRecord[]>()
  for (const record of records) {
    const group = grouped.get(record.workflowId)
    if (group) group.push(record)
    else grouped.set(record.workflowId, [record])
  }

  const selected: WorkflowFileRecord[] = []
  for (const [workflowId, group] of grouped) {
    if (group.length > 1) diagnostics.duplicateIds.push({ workflowId, files: group.map((record) => record.file).sort() })
    selected.push(selectBestWorkflowRecord(group))
  }

  return {
    workflows: selected
      .map((record) => record.workflow)
      .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''))),
    diagnostics,
  }
}

export async function saveWorkflowWithBackup(workflowsDir: string, workflow: StoredWorkflow, now = new Date()): Promise<{ success: boolean; backupPath?: string; error?: string }> {
  try {
    await mkdir(workflowsDir, { recursive: true })
    const id = typeof workflow.id === 'string' ? workflow.id : ''
    if (!id) throw new Error('Workflow is missing a string id')
    const target = join(workflowsDir, `${id}.json`)
    let backupPath: string | undefined
    if (existsSync(target)) {
      const backupDir = join(workflowsDir, '.backups', formatBackupTimestamp(now))
      await mkdir(backupDir, { recursive: true })
      backupPath = join(backupDir, `${id}.json`)
      await copyFile(target, backupPath)
    }
    await writeFile(target, JSON.stringify(workflow, null, 2), 'utf-8')
    return { success: true, ...(backupPath ? { backupPath } : {}) }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

export async function importWorkflowAvoidingIdCollision(workflowsDir: string, sourceFilePath: string): Promise<{ success: boolean; workflow?: StoredWorkflow; originalId?: string; error?: string }> {
  try {
    const raw = await readFile(sourceFilePath, 'utf-8')
    const workflow = JSON.parse(raw) as StoredWorkflow
    if (!workflow.id || !Array.isArray(workflow.nodes)) return { success: false, error: 'Invalid workflow file' }
    const originalId = String(workflow.id)
    const existing = await listStoredWorkflows(workflowsDir)
    const existingIds = new Set(existing.workflows.map((item) => typeof item.id === 'string' ? item.id : '').filter(Boolean))
    if (existingIds.has(originalId)) {
      workflow.id = randomUUID()
      workflow.name = typeof workflow.name === 'string' ? `${workflow.name} (imported)` : `${basename(sourceFilePath, '.json')} (imported)`
      workflow.createdAt = new Date().toISOString()
      workflow.updatedAt = workflow.createdAt
    }
    const result = await saveWorkflowWithBackup(workflowsDir, workflow)
    if (!result.success) return result
    return { success: true, workflow, ...(workflow.id !== originalId ? { originalId } : {}) }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

function selectBestWorkflowRecord(records: WorkflowFileRecord[]): WorkflowFileRecord {
  return [...records].sort((left, right) => {
    const leftCanonical = left.fileId === left.workflowId ? 1 : 0
    const rightCanonical = right.fileId === right.workflowId ? 1 : 0
    if (leftCanonical !== rightCanonical) return rightCanonical - leftCanonical
    const updated = String(right.workflow.updatedAt ?? '').localeCompare(String(left.workflow.updatedAt ?? ''))
    if (updated !== 0) return updated
    return right.mtimeMs - left.mtimeMs
  })[0]
}

function formatBackupTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

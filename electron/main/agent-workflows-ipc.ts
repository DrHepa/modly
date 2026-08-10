import type { AgentWorkflowCreateResult } from '../../src/shared/types/agentWorkflows.ts'
import type { AgentWorkflowAuthorityLike } from './agent-workflow-authority.ts'

export interface AgentWorkflowsIpcMainLike {
  handle(channel: string, handler: (...args: unknown[]) => unknown): void
}

export function registerAgentWorkflowsIpcHandlers(
  ipcMain: AgentWorkflowsIpcMainLike,
  authority: AgentWorkflowAuthorityLike,
): void {
  ipcMain.handle('agentWorkflows:create', async (_event, request): Promise<AgentWorkflowCreateResult> => {
    try {
      return await authority.create(request)
    } catch {
      return { ok: false, error: { code: 'write_failed' } }
    }
  })
}

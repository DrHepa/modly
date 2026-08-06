import type {
  AgentActionListResult,
  AgentActionMutationResult,
  AgentActionPublicErrorCode,
} from '../../src/shared/types/agentActions.ts'
import {
  AgentActionsServiceError,
  type AgentActionsServiceLike,
} from './agent-actions-service.ts'

type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown

export interface AgentActionsIpcMainLike {
  handle(channel: string, handler: InvokeHandler): void
}

function publicError(error: unknown): { code: AgentActionPublicErrorCode } {
  return {
    code: error instanceof AgentActionsServiceError ? error.code : 'internal_error',
  }
}

async function mutate(operation: () => ReturnType<AgentActionsServiceLike['propose']>): Promise<AgentActionMutationResult> {
  try {
    return { ok: true, action: await operation() }
  } catch (error) {
    return { ok: false, error: publicError(error) }
  }
}

export function registerAgentActionsIpcHandlers(
  ipcMain: AgentActionsIpcMainLike,
  service: AgentActionsServiceLike,
): void {
  ipcMain.handle('agentActions:propose', (_event, request) => mutate(() => service.propose(request as never)))
  ipcMain.handle('agentActions:get', (_event, request) => mutate(() => service.get(request as never)))
  ipcMain.handle('agentActions:list', async (): Promise<AgentActionListResult> => {
    try {
      return { ok: true, actions: await service.list() }
    } catch (error) {
      return { ok: false, error: publicError(error) }
    }
  })
  ipcMain.handle('agentActions:decide', (_event, request) => mutate(() => service.decide(request as never)))
  ipcMain.handle('agentActions:execute', (_event, request) => mutate(() => service.execute(request as never)))
  ipcMain.handle('agentActions:cancel', (_event, request) => mutate(() => service.cancel(request as never)))
}

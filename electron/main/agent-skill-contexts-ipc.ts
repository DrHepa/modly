import type { AgentSkillContextResolveResultV1 } from '../../src/shared/types/agentActions.ts'

type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown

export interface AgentSkillContextsIpcMainLike {
  handle(channel: string, handler: InvokeHandler): void
}

export interface AgentSkillContextAuthorityLike {
  resolveSkillContexts(request: unknown): Promise<AgentSkillContextResolveResultV1>
}

export function registerAgentSkillContextsIpcHandlers(
  ipcMain: AgentSkillContextsIpcMainLike,
  authority: AgentSkillContextAuthorityLike,
  options: { isTrustedSender(event: unknown): boolean },
): void {
  ipcMain.handle('agentCapabilities:resolveSkillContexts', (event, request: unknown) => {
    if (!options.isTrustedSender(event)) throw new TypeError('Agent skill contexts require a trusted renderer sender')
    return authority.resolveSkillContexts(request)
  })
}

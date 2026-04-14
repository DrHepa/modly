import type { AutomationCapabilitiesResponse } from './automation-capabilities'
import type { AppSettings } from './settings-store'

type Awaitable<T> = T | Promise<T>

export type AutomationCapabilitiesContext = {
  builtinDir: string
  userExtensionsDir: string
  trustedRepos: Set<string>
}

export type AutomationCapabilitiesServiceDeps = {
  getUserDataPath: () => Awaitable<string>
  getBuiltinExtensionsDir: () => Awaitable<string>
  getSettings: (userData: string) => Awaitable<AppSettings>
  fetchTrustedRepos: () => Promise<Set<string>>
  buildAutomationCapabilities: (context: AutomationCapabilitiesContext) => Promise<AutomationCapabilitiesResponse>
}

const defaultAutomationCapabilitiesServiceDeps: AutomationCapabilitiesServiceDeps = {
  getUserDataPath: async () => {
    const { app } = await import('electron')
    return app.getPath('userData')
  },
  getBuiltinExtensionsDir: async () => {
    const { getBuiltinExtensionsDir } = await import('./builtin-sync')
    return getBuiltinExtensionsDir()
  },
  getSettings: async (userData) => {
    const { getSettings } = await import('./settings-store')
    return getSettings(userData)
  },
  fetchTrustedRepos: async () => {
    const { fetchTrustedRepos } = await import('./trusted-repos')
    return fetchTrustedRepos()
  },
  buildAutomationCapabilities: async (context) => {
    const { buildAutomationCapabilities } = await import('./automation-capabilities')
    return buildAutomationCapabilities(context)
  },
}

export async function resolveAutomationCapabilitiesContextWithDeps(
  deps: Pick<AutomationCapabilitiesServiceDeps, 'getUserDataPath' | 'getBuiltinExtensionsDir' | 'getSettings' | 'fetchTrustedRepos'>,
): Promise<AutomationCapabilitiesContext> {
  const userData = await deps.getUserDataPath()
  const userExtensionsDir = (await deps.getSettings(userData)).extensionsDir
  const builtinDir = await deps.getBuiltinExtensionsDir()
  const trustedRepos = await deps.fetchTrustedRepos()

  return {
    builtinDir,
    userExtensionsDir,
    trustedRepos,
  }
}

export async function getAutomationCapabilitiesWithDeps(
  deps: AutomationCapabilitiesServiceDeps,
): Promise<AutomationCapabilitiesResponse> {
  return deps.buildAutomationCapabilities(await resolveAutomationCapabilitiesContextWithDeps(deps))
}

export async function resolveAutomationCapabilitiesContext(): Promise<AutomationCapabilitiesContext> {
  return resolveAutomationCapabilitiesContextWithDeps(defaultAutomationCapabilitiesServiceDeps)
}

export async function getAutomationCapabilities(): Promise<AutomationCapabilitiesResponse> {
  return getAutomationCapabilitiesWithDeps(defaultAutomationCapabilitiesServiceDeps)
}

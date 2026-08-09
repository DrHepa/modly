import type { listAgentCapabilities } from './automation-capabilities.ts'

type AgentCapabilityDiscovery = typeof listAgentCapabilities
type AgentCapabilityDiscoveryOptions = Parameters<AgentCapabilityDiscovery>[0]
type AgentCapabilityInventory = Awaited<ReturnType<AgentCapabilityDiscovery>>
type AgentCapabilityResolver = (...ignored: unknown[]) => Promise<AgentCapabilityInventory>

export interface SharedAgentCapabilityResolverDependencies {
  discoverCapabilities: AgentCapabilityDiscovery
  getBuiltinDir: () => string
  getUserExtensionsDir: () => string
  fetchTrustedRepos: () => Promise<Set<string>>
  hostRuntimes: NonNullable<AgentCapabilityDiscoveryOptions['hostRuntimes']>
  mcpSandboxReadiness: NonNullable<AgentCapabilityDiscoveryOptions['mcpSandboxReadiness']>
  processPythonSandboxReadiness: NonNullable<AgentCapabilityDiscoveryOptions['processPythonSandboxReadiness']>
  processModelAccessReadiness: NonNullable<AgentCapabilityDiscoveryOptions['processModelAccessReadiness']>
  processPythonExecutable: NonNullable<AgentCapabilityDiscoveryOptions['processPythonExecutable']>
}

export interface SharedAgentCapabilityResolver {
  readonly forAgentActions: AgentCapabilityResolver
  readonly forRendererIpc: AgentCapabilityResolver
}

export function createSharedAgentCapabilityResolver(
  dependencies: SharedAgentCapabilityResolverDependencies,
): SharedAgentCapabilityResolver {
  const resolveCapabilities: AgentCapabilityResolver = async () => dependencies.discoverCapabilities({
    builtinDir: dependencies.getBuiltinDir(),
    userExtensionsDir: dependencies.getUserExtensionsDir(),
    trustedRepos: await dependencies.fetchTrustedRepos(),
    hostRuntimes: dependencies.hostRuntimes,
    mcpSandboxReadiness: dependencies.mcpSandboxReadiness,
    processPythonSandboxReadiness: dependencies.processPythonSandboxReadiness,
    processModelAccessReadiness: dependencies.processModelAccessReadiness,
    processPythonExecutable: dependencies.processPythonExecutable,
  })

  return Object.freeze({
    forAgentActions: resolveCapabilities,
    forRendererIpc: resolveCapabilities,
  })
}

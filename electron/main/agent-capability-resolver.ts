import type { listAgentCapabilities } from './automation-capabilities.ts'
import type { AgentCapabilityInventoryResult } from '../../src/shared/types/agentActions.ts'
import type { BoundAgentSkillSetV1 } from './agent-skills-manifest.ts'

type AgentCapabilityDiscovery = typeof listAgentCapabilities
type AgentCapabilityDiscoveryOptions = Parameters<AgentCapabilityDiscovery>[0]
type AgentCapabilityInventory = Awaited<ReturnType<AgentCapabilityDiscovery>>
type AgentCapabilityResolver = (...ignored: unknown[]) => Promise<AgentCapabilityInventory>

export interface AgentCapabilityPrivateSkillBindingV1 {
  capabilityId: string
  extensionDir: string
  bound: BoundAgentSkillSetV1
}

export interface AgentCapabilityInventoryWithSkillBindingsV1 {
  inventory: AgentCapabilityInventoryResult
  skillBindings: AgentCapabilityPrivateSkillBindingV1[]
}

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
  readonly withPrivateSkillBindings: () => Promise<AgentCapabilityInventoryWithSkillBindingsV1>
}

export function createSharedAgentCapabilityResolver(
  dependencies: SharedAgentCapabilityResolverDependencies,
): SharedAgentCapabilityResolver {
  const discoveryOptions = async (): Promise<AgentCapabilityDiscoveryOptions> => ({
    builtinDir: dependencies.getBuiltinDir(),
    userExtensionsDir: dependencies.getUserExtensionsDir(),
    trustedRepos: await dependencies.fetchTrustedRepos(),
    hostRuntimes: dependencies.hostRuntimes,
    mcpSandboxReadiness: dependencies.mcpSandboxReadiness,
    processPythonSandboxReadiness: dependencies.processPythonSandboxReadiness,
    processModelAccessReadiness: dependencies.processModelAccessReadiness,
    processPythonExecutable: dependencies.processPythonExecutable,
  })
  const resolveCapabilities: AgentCapabilityResolver = async () => dependencies.discoverCapabilities(await discoveryOptions())

  const withPrivateSkillBindings = async (): Promise<AgentCapabilityInventoryWithSkillBindingsV1> => {
    const skillBindings: AgentCapabilityPrivateSkillBindingV1[] = []
    const inventory = await dependencies.discoverCapabilities({
      ...await discoveryOptions(),
      skillBindingSink: ({ capability, extensionDir, bound }) => {
        skillBindings.push({ capabilityId: capability.id, extensionDir, bound })
      },
    })
    return {
      inventory,
      skillBindings: skillBindings.sort((left, right) => (
        left.capabilityId < right.capabilityId ? -1 : left.capabilityId > right.capabilityId ? 1 : 0
      )),
    }
  }

  return Object.freeze({
    forAgentActions: resolveCapabilities,
    forRendererIpc: resolveCapabilities,
    withPrivateSkillBindings,
  })
}

import type {
  AgentCapabilitySnapshotV1,
  AgentSkillContextResolveRequestV1,
  AgentSkillContextResolveResultV1,
  AgentSkillContextV1,
  AgentSkillNormalizedBodyV1,
} from '../../src/shared/types/agentActions.ts'
import {
  type AgentCapabilityInventoryWithSkillBindingsV1,
  type AgentCapabilityPrivateSkillBindingV1,
} from './agent-capability-resolver.ts'
import type { BoundAgentSkillSetV1 } from './agent-skills-manifest.ts'
import { canonicalJson, sha256Canonical } from './agent-trust-contracts.ts'

export type { AgentCapabilityPrivateSkillBindingV1 } from './agent-capability-resolver.ts'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CAPABILITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const MAX_CAPABILITY_REFS = 32
const MAX_USER_CODE_UNITS = 4_096
const MAX_USER_BYTES = 8_192
const MAX_USER_TOKENS = 128
const MAX_TOKEN_CODE_POINTS = 64
const MAX_CONTEXTS = 2
const MAX_NORMALIZED_BODY_BYTES = 6_144
const MAX_TOTAL_NORMALIZED_BODY_BYTES = 12_288
const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu
const STOP_WORDS = new Set([
  'a', 'al', 'all', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'con', 'de', 'del', 'do', 'el', 'en',
  'for', 'from', 'hacer', 'i', 'in', 'is', 'it', 'la', 'las', 'le', 'lo', 'los', 'me', 'mi', 'my', 'of',
  'on', 'or', 'para', 'por', 'please', 'que', 'the', 'to', 'un', 'una', 'use', 'using', 'with', 'y', 'you',
])
const GENERIC_ACTION_WORDS = new Set([
  'add', 'añadir', 'agregar', 'aplicar', 'apply', 'build', 'construir', 'create', 'crear', 'edit', 'editar',
  'execute', 'ejecutar', 'generate', 'generar', 'hacer', 'make', 'modify', 'modificar', 'produce', 'producir',
  'run', 'usar', 'use',
])

type CommitResult = 'committed' | 'inactive' | 'commit_failed'

export interface AgentSkillContextAuthorityDependencies {
  resolveCapabilitiesWithSkillBindings(): Promise<AgentCapabilityInventoryWithSkillBindingsV1>
  rebindSkillSet(binding: AgentCapabilityPrivateSkillBindingV1): Promise<BoundAgentSkillSetV1>
  commitIfOriginSessionActive(originSessionId: string, operation: () => Promise<void>): Promise<CommitResult>
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value)
  const allowed = new Set(expected)
  return keys.length === expected.length
    && keys.every((key) => typeof key === 'string' && allowed.has(key))
    && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

function normalizeRequest(value: unknown): AgentSkillContextResolveRequestV1 {
  if (!isPlainRecord(value) || !exactKeys(value, ['originSessionId', 'userText', 'capabilities'])) {
    throw new TypeError('Invalid Agent skill context request')
  }
  if (typeof value.originSessionId !== 'string' || !SAFE_ID.test(value.originSessionId)) {
    throw new TypeError('Invalid Agent skill context request origin')
  }
  if (typeof value.userText !== 'string' || value.userText.length < 1
    || value.userText.length > MAX_USER_CODE_UNITS || hasLoneSurrogate(value.userText)
    || Buffer.byteLength(value.userText, 'utf8') > MAX_USER_BYTES) {
    throw new TypeError('Invalid Agent skill context request text')
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.length > MAX_CAPABILITY_REFS) {
    throw new TypeError('Invalid Agent skill context capability refs')
  }
  const capabilities = value.capabilities.map((candidate) => {
    if (!isPlainRecord(candidate) || !exactKeys(candidate, ['id', 'hash', 'skillsHash'])
      || typeof candidate.id !== 'string' || !CAPABILITY_ID.test(candidate.id)
      || candidate.id.split('/').some((segment) => ['__proto__', 'prototype', 'constructor'].includes(segment))
      || typeof candidate.hash !== 'string' || !SHA256.test(candidate.hash)
      || typeof candidate.skillsHash !== 'string' || !SHA256.test(candidate.skillsHash)) {
      throw new TypeError('Invalid Agent skill context capability ref')
    }
    return { id: candidate.id, hash: candidate.hash, skillsHash: candidate.skillsHash }
  })
  if (new Set(capabilities.map((candidate) => candidate.id)).size !== capabilities.length) {
    throw new TypeError('Invalid duplicate Agent skill context capability ref')
  }
  return { originSessionId: value.originSessionId, userText: value.userText, capabilities }
}

function normalizedSearchText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
}

function tokenSet(value: string): Set<string> {
  const tokens = new Set<string>()
  for (const match of normalizedSearchText(value).matchAll(TOKEN_PATTERN)) {
    const token = match[0]
    if (STOP_WORDS.has(token) || [...token].length > MAX_TOKEN_CODE_POINTS) continue
    tokens.add(token)
    if (tokens.size >= MAX_USER_TOKENS) break
  }
  return tokens
}

function addWeightedMatches(score: number, userTokens: ReadonlySet<string>, value: string, weight: number): number {
  for (const token of tokenSet(value)) {
    if (userTokens.has(token)) score += weight
  }
  return score
}

function phraseMentioned(userText: string, phrase: string): boolean {
  const normalizedPhrase = normalizedSearchText(phrase)
  return normalizedPhrase.length >= 3 && (` ${userText} `).includes(` ${normalizedPhrase} `)
}

function relevanceFields(capability: AgentCapabilitySnapshotV1, bound: BoundAgentSkillSetV1): string[] {
  return [
    capability.id,
    capability.displayName,
    capability.description,
    capability.node.input,
    capability.node.output,
    ...(capability.node.outputs ?? []),
    ...(capability.node.inputs ?? []).map((input) => `${input.name} ${input.label ?? ''} ${input.type}`),
    bound.normalized.name,
    bound.normalized.summary,
  ]
}

function relevance(capability: AgentCapabilitySnapshotV1, bound: BoundAgentSkillSetV1, userText: string): number {
  const normalizedUser = normalizedSearchText(userText)
  const userTokens = tokenSet(userText)
  if (userTokens.size === 0) return 0
  const skill = bound.normalized
  const explicitMention = [capability.id, capability.displayName, skill.name]
    .some((phrase) => phraseMentioned(normalizedUser, phrase))
  const candidateTokens = new Set(relevanceFields(capability, bound).flatMap((field) => [...tokenSet(field)]))
  const overlaps = [...userTokens].filter((token) => candidateTokens.has(token))
  if (!explicitMention && (overlaps.length < 2 || !overlaps.some((token) => !GENERIC_ACTION_WORDS.has(token)))) {
    return 0
  }
  let score = 0
  if (explicitMention) score += 1_000
  score = addWeightedMatches(score, userTokens, capability.id, 8)
  score = addWeightedMatches(score, userTokens, capability.displayName, 8)
  score = addWeightedMatches(score, userTokens, skill.name, 8)
  score = addWeightedMatches(score, userTokens, capability.description, 3)
  score = addWeightedMatches(score, userTokens, skill.summary, 4)
  score = addWeightedMatches(score, userTokens, capability.node.input, 2)
  score = addWeightedMatches(score, userTokens, capability.node.output, 2)
  for (const output of capability.node.outputs ?? []) score = addWeightedMatches(score, userTokens, output, 2)
  for (const input of capability.node.inputs ?? []) {
    score = addWeightedMatches(score, userTokens, `${input.name} ${input.label ?? ''} ${input.type}`, 2)
  }
  return score
}

function samePublicBinding(capability: AgentCapabilitySnapshotV1, binding: BoundAgentSkillSetV1): boolean {
  const skills = capability.skills
  if (!skills || skills.count !== 1 || skills.items.length !== 1) return false
  const item = skills.items[0]
  return binding.skillSetHash === skills.hash
    && binding.normalizedHash === item.hash
    && binding.normalized.name === item.name
    && binding.normalized.version === item.version
    && canonicalJson(binding.publicSnapshot) === canonicalJson(skills)
}

function sameAuthoritativeFileBinding(left: BoundAgentSkillSetV1, right: BoundAgentSkillSetV1): boolean {
  return left.skillSetHash === right.skillSetHash
    && left.normalizedHash === right.normalizedHash
    && canonicalJson(left.declaration) === canonicalJson(right.declaration)
    && canonicalJson(left.identity) === canonicalJson(right.identity)
}

function contextFrom(
  capability: AgentCapabilitySnapshotV1,
  binding: BoundAgentSkillSetV1,
  resolutionHash: string,
): { context: AgentSkillContextV1, bodyBytes: number } | null {
  if (!samePublicBinding(capability, binding)) return null
  const bodyCanonical = canonicalJson(binding.normalized)
  const bodyBytes = Buffer.byteLength(bodyCanonical, 'utf8')
  if (bodyBytes > MAX_NORMALIZED_BODY_BYTES) return null
  const body = JSON.parse(bodyCanonical) as AgentSkillNormalizedBodyV1
  const unsigned = {
    schema: 'modly.agent-skill-context.v1' as const,
    version: 1 as const,
    capabilityId: capability.id,
    capabilityHash: capability.hash,
    skillsHash: capability.skills!.hash,
    resolutionHash,
    skill: { ...capability.skills!.items[0] },
    body,
  }
  return { context: { ...unsigned, contextHash: sha256Canonical(unsigned) }, bodyBytes }
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareCapabilityRefs(
  left: AgentSkillContextResolveRequestV1['capabilities'][number],
  right: AgentSkillContextResolveRequestV1['capabilities'][number],
): number {
  return codeUnitCompare(left.id, right.id)
    || codeUnitCompare(left.hash, right.hash)
    || codeUnitCompare(left.skillsHash, right.skillsHash)
}

export function agentSkillResolutionBinding(request: AgentSkillContextResolveRequestV1) {
  return {
    schema: 'modly.agent-skill-resolution.v1' as const,
    version: 1 as const,
    originSessionId: request.originSessionId,
    userText: request.userText,
    capabilities: request.capabilities
      .map((capability) => ({ ...capability }))
      .sort(compareCapabilityRefs),
  }
}

export function agentSkillResolutionHash(request: AgentSkillContextResolveRequestV1): string {
  return sha256Canonical(agentSkillResolutionBinding(request))
}

export class AgentSkillContextAuthority {
  private readonly dependencies: AgentSkillContextAuthorityDependencies

  constructor(dependencies: AgentSkillContextAuthorityDependencies) {
    this.dependencies = dependencies
  }

  async resolveSkillContexts(value: unknown): Promise<AgentSkillContextResolveResultV1> {
    const request = normalizeRequest(value)
    const resolutionHash = agentSkillResolutionHash(request)
    let resolved: AgentSkillContextResolveResultV1 = { resolutionHash, contexts: [] }
    const commit = await this.dependencies.commitIfOriginSessionActive(request.originSessionId, async () => {
      const current = await this.dependencies.resolveCapabilitiesWithSkillBindings()
      const capabilities = new Map(current.inventory.capabilities.map((capability) => [capability.id, capability]))
      const bindings = new Map(current.skillBindings.map((binding) => [binding.capabilityId, binding]))
      const candidates = request.capabilities.flatMap((ref) => {
        const capability = capabilities.get(ref.id)
        const privateBinding = bindings.get(ref.id)
        if (!capability || !privateBinding || capability.hash !== ref.hash
          || capability.skills?.hash !== ref.skillsHash
          || !samePublicBinding(capability, privateBinding.bound)) return []
        const score = relevance(capability, privateBinding.bound, request.userText)
        return score > 0 ? [{ capability, privateBinding, score }] : []
      }).sort((left, right) => (
        right.score - left.score
        || codeUnitCompare(left.capability.id, right.capability.id)
        || codeUnitCompare(left.privateBinding.bound.normalized.name, right.privateBinding.bound.normalized.name)
      ))
      const contexts: AgentSkillContextV1[] = []
      let totalBodyBytes = 0
      for (const candidate of candidates) {
        if (contexts.length >= MAX_CONTEXTS) break
        let rebound: BoundAgentSkillSetV1
        try {
          rebound = await this.dependencies.rebindSkillSet(candidate.privateBinding)
        } catch {
          continue
        }
        if (!sameAuthoritativeFileBinding(candidate.privateBinding.bound, rebound)) continue
        const resolvedContext = contextFrom(candidate.capability, rebound, resolutionHash)
        if (!resolvedContext || totalBodyBytes + resolvedContext.bodyBytes > MAX_TOTAL_NORMALIZED_BODY_BYTES) continue
        contexts.push(resolvedContext.context)
        totalBodyBytes += resolvedContext.bodyBytes
      }
      resolved = { resolutionHash, contexts }
    })
    return commit === 'committed' ? resolved : { resolutionHash, contexts: [] }
  }
}

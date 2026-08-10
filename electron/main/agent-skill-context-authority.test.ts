import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import type { AgentCapabilitySnapshotV1 } from '../../src/shared/types/agentActions.ts'
import type { BoundAgentSkillSetV1 } from './agent-skills-manifest.ts'
import {
  AgentSkillContextAuthority,
  agentSkillResolutionBinding,
  agentSkillResolutionHash,
  type AgentCapabilityPrivateSkillBindingV1,
} from './agent-skill-context-authority.ts'
import { canonicalJson, sha256Canonical } from './agent-trust-contracts.ts'

const HASH_A = 'a'.repeat(64)

function capability(id: string, options: {
  hash?: string
  skillSetHash?: string
  skillHash?: string
  displayName?: string
  description?: string
  input?: 'text' | 'mesh'
  output?: 'mesh' | 'scene'
  skillName?: string
} = {}): AgentCapabilitySnapshotV1 {
  const [extensionId, nodeId] = id.split('/')
  return {
    schema: 'modly.agent-capability.v1', version: 1, id,
    displayName: options.displayName ?? nodeId,
    description: options.description ?? `Operate ${nodeId}`,
    extension: { id: extensionId, name: extensionId },
    node: {
      id: nodeId,
      input: options.input ?? 'text',
      output: options.output ?? 'mesh',
      paramsSchema: [],
    },
    skills: {
      schema: 'modly.agent-skills.v1', version: 1,
      hash: options.skillSetHash ?? 'b'.repeat(64), count: 1,
      items: [{
        name: options.skillName ?? `modly-${extensionId}-${nodeId}-v1`,
        version: 1,
        hash: options.skillHash ?? 'c'.repeat(64),
      }],
    },
    approval: { required: true, scope: 'single_action' },
    hash: options.hash ?? HASH_A,
  }
}

function binding(cap: AgentCapabilitySnapshotV1, options: {
  summary?: string
  instruction?: string
  normalizedHash?: string
  skillSetHash?: string
} = {}): AgentCapabilityPrivateSkillBindingV1 {
  const normalized = {
    schema: 'modly.agent-skill.v1' as const,
    version: 1 as const,
    name: cap.skills!.items[0].name,
    summary: options.summary ?? cap.description,
    instructions: [options.instruction ?? `Use ${cap.displayName}.`],
    constraints: ['Remain within the declared capability.'],
  }
  const bound = {
    declaration: { schema: 'modly.agent-skills.v1' as const, file: `skills/${cap.node.id}.md` },
    identity: {
      path: `skills/${cap.node.id}.md`, device: '1', inode: '2', uid: 1000, gid: 1000,
      mode: 0o600, size: 100, nlink: 1, mtimeNs: '3', ctimeNs: '4', sha256: 'd'.repeat(64),
    },
    normalized,
    normalizedHash: options.normalizedHash ?? cap.skills!.items[0].hash,
    skillSetHash: options.skillSetHash ?? cap.skills!.hash,
    publicSnapshot: cap.skills!,
  } satisfies BoundAgentSkillSetV1
  return { capabilityId: cap.id, extensionDir: `/private/${cap.extension.id}`, bound }
}

function request(capabilities: AgentCapabilitySnapshotV1[], userText: string, originSessionId = 'session-a') {
  return {
    originSessionId,
    userText,
    capabilities: capabilities.map((cap) => ({
      id: cap.id,
      hash: cap.hash,
      skillsHash: cap.skills!.hash,
    })),
  }
}

function authority(input: {
  capabilities: AgentCapabilitySnapshotV1[]
  bindings?: AgentCapabilityPrivateSkillBindingV1[]
  rebind?: (candidate: AgentCapabilityPrivateSkillBindingV1) => Promise<BoundAgentSkillSetV1>
  commit?: (origin: string, operation: () => Promise<void>) => Promise<'committed' | 'inactive' | 'commit_failed'>
}) {
  const bindings = input.bindings ?? input.capabilities.map((cap) => binding(cap))
  return new AgentSkillContextAuthority({
    resolveCapabilitiesWithSkillBindings: async () => ({
      inventory: { capabilities: input.capabilities, errors: [] },
      skillBindings: bindings,
    }),
    rebindSkillSet: input.rebind ?? (async (candidate) => candidate.bound),
    commitIfOriginSessionActive: input.commit ?? (async (_origin, operation) => {
      await operation()
      return 'committed'
    }),
  })
}

test('skill contexts are main-resolved by relevant current refs, deterministic ties, Unicode user text, and max two', async () => {
  const beta = capability('cad/beta', { displayName: 'Sphere Builder', description: 'Create a precise sphere.' })
  const alpha = capability('cad/alpha', { hash: 'e'.repeat(64), skillSetHash: 'f'.repeat(64), skillHash: '1'.repeat(64), displayName: 'Sphere Builder', description: 'Create a precise sphere.' })
  const unrelated = capability('mesh/repair', { hash: '2'.repeat(64), skillSetHash: '3'.repeat(64), skillHash: '4'.repeat(64), displayName: 'Mesh Repair' })
  const result = await authority({
    capabilities: [beta, unrelated, alpha],
    bindings: [
      binding(beta, { summary: 'Create a precise sphere.' }),
      binding(unrelated, { summary: 'Repair topology defects.' }),
      binding(alpha, { summary: 'Create a precise sphere.' }),
    ],
  }).resolveSkillContexts(request([beta, unrelated, alpha], 'Please create a SPHERE with cafe dimensions: café.'))

  assert.deepEqual(result.contexts.map((context) => context.capabilityId), ['cad/alpha', 'cad/beta'])
  assert.equal(result.contexts.every((context) => {
    const { contextHash, ...unsigned } = context
    return contextHash === sha256Canonical(unsigned)
  }), true)
  assert.equal(result.contexts.every((context) => context.resolutionHash === result.resolutionHash), true)
  assert.equal(JSON.stringify(result).includes('/private/'), false)
  assert.equal(JSON.stringify(result).includes('.md'), false)
  assert.equal(result.resolutionHash, agentSkillResolutionHash(request(
    [beta, unrelated, alpha], 'Please create a SPHERE with cafe dimensions: café.',
  )))
})

test('resolution hash canonicalization matches the shared cross-language fixture', async () => {
  const fixture = JSON.parse(await readFile(
    new URL('../../tests/fixtures/agent-skill-resolution-v1.json', import.meta.url),
    'utf8',
  )) as {
    originSessionId: string
    userText: string
    capabilities: Array<{ id: string, hash: string, skillsHash: string }>
    canonical: string
    resolutionHash: string
  }
  const input = {
    originSessionId: fixture.originSessionId,
    userText: fixture.userText,
    capabilities: fixture.capabilities,
  }
  assert.equal(canonicalJson(agentSkillResolutionBinding(input)), fixture.canonical)
  assert.equal(agentSkillResolutionHash(input), fixture.resolutionHash)
})

test('relevance requires an exact mention or two overlaps with a distinctive term', async () => {
  const cad = capability('cad/shape', {
    hash: '5'.repeat(64), skillSetHash: '6'.repeat(64), skillHash: '7'.repeat(64),
    displayName: 'Parametric Shape', description: 'Create solid geometry.',
  })
  const blender = capability('mesh/author', {
    hash: '8'.repeat(64), skillSetHash: '9'.repeat(64), skillHash: '0'.repeat(64),
    displayName: 'Mesh Authoring', description: 'Edit scene geometry.', output: 'scene',
  })
  const bindings = [
    binding(cad, { summary: 'Create a cube and subtract a centered hole.' }),
    binding(blender, { summary: 'Add a primitive and assign a material.' }),
  ]
  const subject = authority({ capabilities: [cad, blender], bindings })

  assert.deepEqual((await subject.resolveSkillContexts(request([cad, blender], 'create'))).contexts, [])
  assert.deepEqual(
    (await subject.resolveSkillContexts(request([cad, blender], 'Use cad/shape'))).contexts.map((item) => item.capabilityId),
    ['cad/shape'],
  )
  assert.deepEqual(
    (await subject.resolveSkillContexts(request([cad, blender], 'Create a cube with a hole'))).contexts.map((item) => item.capabilityId),
    ['cad/shape'],
  )
  assert.deepEqual(
    (await subject.resolveSkillContexts(request([cad, blender], 'Add a primitive with material'))).contexts.map((item) => item.capabilityId),
    ['mesh/author'],
  )
})

test('skill contexts omit unrelated, unavailable, stale, edited, replaced, and inactive-session candidates', async () => {
  const cap = capability('cad/plan', { displayName: 'CAD Planner', description: 'Plan CAD geometry.' })
  const currentBinding = binding(cap)
  assert.deepEqual((await authority({ capabilities: [cap], bindings: [currentBinding] })
    .resolveSkillContexts(request([cap], 'tell me a joke'))).contexts, [])

  assert.deepEqual((await authority({ capabilities: [], bindings: [currentBinding] })
    .resolveSkillContexts(request([cap], 'use cad planner'))).contexts, [])

  assert.deepEqual((await authority({ capabilities: [cap], bindings: [currentBinding] })
    .resolveSkillContexts({ ...request([cap], 'use cad planner'), capabilities: [{
      id: cap.id, hash: '9'.repeat(64), skillsHash: cap.skills!.hash,
    }] })).contexts, [])

  let rebound = 0
  const edited = await authority({
    capabilities: [cap], bindings: [currentBinding],
    rebind: async (candidate) => {
      rebound += 1
      return { ...candidate.bound, normalizedHash: '8'.repeat(64) }
    },
  }).resolveSkillContexts(request([cap], 'use cad planner'))
  assert.equal(rebound, 1)
  assert.deepEqual(edited.contexts, [])

  const sameBytesReplacement = await authority({
    capabilities: [cap], bindings: [currentBinding],
    rebind: async (candidate) => ({
      ...candidate.bound,
      identity: { ...candidate.bound.identity, inode: 'replacement-inode', ctimeNs: '5' },
    }),
  }).resolveSkillContexts(request([cap], 'use cad planner'))
  assert.deepEqual(sameBytesReplacement.contexts, [])

  const inactive = authority({
    capabilities: [cap], bindings: [currentBinding],
    commit: async () => 'inactive',
  })
  const inactiveResult = await inactive.resolveSkillContexts(request([cap], 'use cad planner'))
  assert.deepEqual(inactiveResult.contexts, [])

  let resolvedBeforeSwitch = false
  const switchedAfterResolution = authority({
    capabilities: [cap], bindings: [currentBinding],
    commit: async (_origin, operation) => {
      await operation()
      resolvedBeforeSwitch = true
      return 'inactive'
    },
  })
  assert.deepEqual((await switchedAfterResolution.resolveSkillContexts(request([cap], 'use cad planner'))).contexts, [])
  assert.equal(resolvedBeforeSwitch, true)
})

test('skill context resolution is bounded, exact, and does not truncate normalized bodies', async () => {
  const cap = capability('cad/plan', { displayName: 'CAD Planner' })
  const oversized = binding(cap, { instruction: `CAD ${'x'.repeat(6_200)}` })
  assert.deepEqual((await authority({ capabilities: [cap], bindings: [oversized] })
    .resolveSkillContexts(request([cap], 'use cad planner'))).contexts, [])

  await assert.rejects(
    authority({ capabilities: [cap] }).resolveSkillContexts({
      ...request([cap], 'use cad planner'),
      extra: true,
    } as never),
    /invalid/i,
  )
  await assert.rejects(
    authority({ capabilities: [cap] }).resolveSkillContexts({
      ...request([cap], 'use cad planner'),
      capabilities: [...request([cap], 'use cad planner').capabilities, ...request([cap], 'use cad planner').capabilities],
    }),
    /invalid/i,
  )
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { registerAgentSkillContextsIpcHandlers } from './agent-skill-contexts-ipc.ts'

test('skill context IPC is exact, trusted-sender-only, and returns no private error material', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const calls: unknown[] = []
  registerAgentSkillContextsIpcHandlers({
    handle(channel, handler) { handlers.set(channel, handler) },
  }, {
    async resolveSkillContexts(request) {
      calls.push(request)
      return { resolutionHash: 'c'.repeat(64), contexts: [] }
    },
  }, {
    isTrustedSender: (event) => event === 'trusted',
  })

  assert.deepEqual([...handlers.keys()], ['agentCapabilities:resolveSkillContexts'])
  const request = {
    originSessionId: 'session-a', userText: 'Create CAD geometry',
    capabilities: [{ id: 'cad/plan', hash: 'a'.repeat(64), skillsHash: 'b'.repeat(64) }],
  }
  assert.deepEqual(await handlers.get('agentCapabilities:resolveSkillContexts')?.('trusted', request), {
    resolutionHash: 'c'.repeat(64), contexts: [],
  })
  assert.deepEqual(calls, [request])
  await assert.rejects(
    async () => handlers.get('agentCapabilities:resolveSkillContexts')?.('untrusted', request),
    /trusted/i,
  )
  assert.equal(calls.length, 1)
})

test('production skill context IPC binds the exact live main frame and active session authority', async () => {
  const source = await readFile(new URL('./ipc-handlers.ts', import.meta.url), 'utf8')
  assert.match(source, /event\.sender === window\.webContents/)
  assert.match(source, /event\.senderFrame === window\.webContents\.mainFrame/)
  assert.match(source, /commitIfOriginSessionActive:[\s\S]*agentSessionStore\.commitIfActive/)
  assert.match(source, /resolveCapabilitiesWithSkillBindings:\s*sharedAgentCapabilityResolver\.withPrivateSkillBindings/)
})

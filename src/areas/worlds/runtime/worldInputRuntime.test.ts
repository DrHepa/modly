import assert from 'node:assert/strict'
import test from 'node:test'

import { createRuntimeWorldSnapshot } from './_testFixtures.ts'
import { WorldInputSampler } from './worldInputRuntime.ts'
import { createValidWorldSnapshot } from '../core/_testFixtures.ts'
import { applyWorldCommandBatch } from '../core/worldCommands.ts'
import { buildCharacterControllerPresetCommands } from '../editor/worldAuthoringModel.ts'
import { createDeterministicWorldEditorIdentityGenerator } from '../editor/worldEditorCommandBuilders.ts'

test('authored character input IDs sample WASD opposites, Space edges and attached blur cleanup', () => {
  const snapshot = createValidWorldSnapshot()
  const commands = buildCharacterControllerPresetCommands({ snapshot, projectKey: `world-${'a'.repeat(32)}`, activeSceneId: 'scene:one', identities: createDeterministicWorldEditorIdentityGenerator('input-character') }, 'entity:hero')
  const authored = applyWorldCommandBatch(snapshot, { schema: 'modly.world-command-batch.v1', transactionId: 'tx:input-character', projectId: snapshot.project.projectId, baseRevision: snapshot.project.revision, origin: 'ui', commands })
  assert.ok(authored.success)
  const character = authored.snapshot.scenes[0].entities[0].components.find((component) => component.type === 'character-controller')!
  assert.ok(character.jumpActionId)
  const sampler = new WorldInputSampler(authored.snapshot.project.inputActions)
  const element = new EventTarget()
  const detach = sampler.attach(element as HTMLElement)
  const key = (type: 'keydown' | 'keyup', code: string) => element.dispatchEvent(Object.assign(new Event(type), { code, key: code }))
  key('keydown', 'KeyW')
  key('keydown', 'KeyD')
  key('keydown', 'Space')
  const first = sampler.sample()
  assert.deepEqual(first.actions[character.moveActionId]?.value, [1, 1])
  assert.equal(first.actions[character.jumpActionId]?.pressed, true)
  assert.equal(sampler.sample().actions[character.jumpActionId]?.pressed, false)
  key('keydown', 'KeyA')
  key('keydown', 'KeyS')
  assert.deepEqual(sampler.sample().actions[character.moveActionId]?.value, [0, 0])
  element.dispatchEvent(new Event('blur'))
  assert.equal(sampler.sample().actions[character.jumpActionId]?.released, true)
  key('keydown', 'KeyW')
  assert.deepEqual(sampler.sample().actions[character.moveActionId]?.value, [0, 1])
  detach()
  key('keydown', 'KeyD')
  assert.deepEqual(sampler.sample().actions[character.moveActionId]?.value, [0, 0])
  sampler.dispose()
})

test('named inputs sample values and pressed/held/released edges deterministically', () => {
  const sampler = new WorldInputSampler(createRuntimeWorldSnapshot().project.inputActions)
  sampler.setControl('keyboard', 'KeyW', 1)
  sampler.setControl('keyboard', 'KeyD', 1)
  sampler.setControl('keyboard', 'Space', 1)
  const first = sampler.sample()
  assert.deepEqual(first.actions['input:move'], { value: [1, 1], held: true, pressed: true, released: false })
  assert.deepEqual(first.actions['input:jump'], { value: 1, held: true, pressed: true, released: false })
  assert.equal(sampler.sample().actions['input:jump']?.pressed, false)
  sampler.clear()
  const released = sampler.sample()
  assert.equal(released.actions['input:jump']?.released, true)
  assert.equal(released.actions['input:move']?.released, true)
})

test('detaching or blur cleanup clears every scoped control', () => {
  const sampler = new WorldInputSampler(createRuntimeWorldSnapshot().project.inputActions)
  sampler.setControl('keyboard', 'Space', 1)
  sampler.sample()
  sampler.dispose()
  assert.equal(sampler.sample().actions['input:jump']?.released, true)
})

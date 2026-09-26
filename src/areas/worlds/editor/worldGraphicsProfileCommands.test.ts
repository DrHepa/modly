import assert from 'node:assert/strict'
import test from 'node:test'
import type { WorldGraphicsProfile } from '../core/worldModel.ts'
import { createRuntimeWorldSnapshot } from '../runtime/_testFixtures.ts'
import { buildWorldGraphicsProfileSelectionCommands } from './worldGraphicsProfileCommands.ts'

test('stored/custom graphics profiles are preserved and same choice is a no-op', () => {
  const snapshot = createRuntimeWorldSnapshot()
  snapshot.project.graphicsProfiles.push({ id: 'graphics:custom', name: 'Custom', renderScale: 1.25, shadowQuality: 'low', antialiasing: 'off' })
  const commands = buildWorldGraphicsProfileSelectionCommands(snapshot, { kind: 'profile', profileId: 'graphics:custom' })
  assert.equal(commands.length, 1)
  assert.equal(commands[0]?.type, 'replace-graphics-profiles')
  if (commands[0]?.type !== 'replace-graphics-profiles') return
  assert.deepEqual(commands[0].graphicsProfiles, snapshot.project.graphicsProfiles)
  assert.equal(commands[0].activeGraphicsProfileId, 'graphics:custom')
  assert.deepEqual(buildWorldGraphicsProfileSelectionCommands({ ...snapshot, project: { ...snapshot.project, activeGraphicsProfileId: 'graphics:custom' } }, { kind: 'profile', profileId: 'graphics:custom' }), [])
})

test('presets reuse exact factory/legacy records or append collision-safe ids with one canonical command', () => {
  const snapshot = createRuntimeWorldSnapshot()
  snapshot.project.resources.push({ id: 'graphics:integrated', type: 'model', name: 'Collision', workspacePath: 'a.glb', format: 'glb' })
  const integrated = buildWorldGraphicsProfileSelectionCommands(snapshot, { kind: 'preset', preset: 'integrated' })
  assert.equal(integrated.length, 1)
  if (integrated[0]?.type !== 'replace-graphics-profiles') throw new Error('Expected replace-graphics-profiles')
  assert.equal(integrated[0].activeGraphicsProfileId, 'graphics:integrated-2')
  assert.equal(integrated[0].graphicsProfiles.at(-1)?.renderScale, 0.75)
  assert.equal(integrated[0].graphicsProfiles.at(-1)?.antialiasing, 'fxaa')

  const dedicatedProfile: WorldGraphicsProfile = { id: 'graphics:legacy-balanced', name: 'Dedicated', renderScale: 1, shadowQuality: 'high', antialiasing: 'msaa' }
  const withDedicated = { ...snapshot, project: { ...snapshot.project, graphicsProfiles: [...snapshot.project.graphicsProfiles, dedicatedProfile] } }
  const dedicated = buildWorldGraphicsProfileSelectionCommands(withDedicated, { kind: 'preset', preset: 'dedicated' })
  assert.equal(dedicated.length, 1)
  if (dedicated[0]?.type !== 'replace-graphics-profiles') throw new Error('Expected replace-graphics-profiles')
  assert.equal(dedicated[0].activeGraphicsProfileId, 'graphics:legacy-balanced')
  assert.equal(dedicated[0].graphicsProfiles.length, withDedicated.project.graphicsProfiles.length)
})

test('unknown stored profile choices fail closed instead of silently migrating', () => {
  assert.throws(() => buildWorldGraphicsProfileSelectionCommands(createRuntimeWorldSnapshot(), { kind: 'profile', profileId: 'graphics:missing' }), /does not exist/)
})

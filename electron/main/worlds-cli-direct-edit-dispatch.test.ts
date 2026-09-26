import assert from 'node:assert/strict'
import test from 'node:test'

import { createWorldsCliDirectEditDispatch } from './worlds-cli-direct-edit-dispatch.ts'

test('late-bound dispatch reserves the exact pending proposal, executes once, and leaves successful custody to the broker', async () => {
  const calls: string[] = []
  const reservation = { finish: async () => { calls.push('finish'); return { ok: true } } }
  const transport = { async reserveDirectEdit(proposalId: string) {
    calls.push(`reserve:${proposalId}`)
    return { ok: true as const, reservation: reservation as never }
  } }
  const broker = { async execute(value: unknown) {
    calls.push(value === reservation ? 'execute' : 'wrong')
    return { ok: true as const, editIntent: `edit_${'a'.repeat(48)}`, expiresAt: 123 }
  } }
  const dispatch = createWorldsCliDirectEditDispatch(() => transport as never, broker as never)
  assert.deepEqual(await dispatch(`proposal_${'b'.repeat(48)}`), {
    ok: true, editIntent: `edit_${'a'.repeat(48)}`, expiresAt: 123,
  })
  assert.deepEqual(calls, [`reserve:proposal_${'b'.repeat(48)}`, 'execute'])
})

test('late binding fails closed and execute failure finishes exactly once without retry', async () => {
  const absent = createWorldsCliDirectEditDispatch(() => null, { execute: async () => { throw new Error('must not run') } } as never)
  assert.deepEqual(await absent(`proposal_${'c'.repeat(48)}`), { ok: false, code: 'UNAVAILABLE' })

  let reserves = 0
  let executes = 0
  let finishes = 0
  const reservation = { finish: async () => { finishes++; throw new Error('best effort') } }
  const dispatch = createWorldsCliDirectEditDispatch(() => ({
    async reserveDirectEdit() { reserves++; return { ok: true as const, reservation: reservation as never } },
  }) as never, {
    async execute() { executes++; throw new Error('dispatch failed') },
  } as never)
  assert.deepEqual(await dispatch(`proposal_${'d'.repeat(48)}`), { ok: false, code: 'UNAVAILABLE' })
  assert.equal(reserves, 1)
  assert.equal(executes, 1)
  assert.equal(finishes, 1)

  const rejectedReservation = { finish: async () => { finishes++ } }
  const rejected = createWorldsCliDirectEditDispatch(() => ({
    async reserveDirectEdit() { return { ok: true as const, reservation: rejectedReservation as never } },
  }) as never, { async execute() { return { ok: false as const, code: 'STALE' as const } } })
  assert.deepEqual(await rejected(`proposal_${'e'.repeat(48)}`), { ok: false, code: 'STALE' })
  assert.equal(finishes, 2)
})

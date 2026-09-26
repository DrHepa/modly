import assert from 'node:assert/strict'
import test from 'node:test'

import { NAV_PAGES, useNavStore, registerWorldsLeaveGuard, type Page } from './navStore.ts'

test('nav store declares worlds as a first-class app page', () => {
  assert.deepEqual(NAV_PAGES, ['generate', 'workflows', 'worlds', 'models', 'settings'])
})

test('SPA leave waits for Worlds Apply cancellation ACK and fails closed', async () => {
  const previousPage = useNavStore.getState().currentPage
  useNavStore.getState().navigate('worlds')
  let release!: (accepted: boolean) => void
  const guard = new Promise<boolean>((resolve) => { release = resolve })
  const unregister = registerWorldsLeaveGuard(() => guard)
  try {
    const leaving = useNavStore.getState().navigate('generate')
    assert.equal(useNavStore.getState().currentPage, 'worlds')
    release(false)
    assert.equal(await leaving, false)
    assert.equal(useNavStore.getState().currentPage, 'worlds')
    assert.match(useNavStore.getState().navigationError ?? '', /cancellation was not verified/i)
  } finally {
    unregister()
    await useNavStore.getState().navigate(previousPage)
  }
})

test('a later navigation intent cannot be replaced by an older cancellation ACK', async () => {
  const previousPage = useNavStore.getState().currentPage
  await useNavStore.getState().navigate('worlds')
  let release!: (accepted: boolean) => void
  const gate = new Promise<boolean>((resolve) => { release = resolve })
  const unregister = registerWorldsLeaveGuard(() => gate)
  try {
    const stale = useNavStore.getState().navigate('generate')
    await useNavStore.getState().navigate('worlds')
    release(true)
    assert.equal(await stale, false)
    assert.equal(useNavStore.getState().currentPage, 'worlds')
  } finally {
    unregister()
    await useNavStore.getState().navigate(previousPage)
  }
})

test('rejected cancellation also leaves Worlds open with an accessible warning state', async () => {
  const previousPage = useNavStore.getState().currentPage
  await useNavStore.getState().navigate('worlds')
  const unregister = registerWorldsLeaveGuard(async () => { throw new Error('IPC unavailable') })
  try {
    assert.equal(await useNavStore.getState().navigate('generate'), false)
    assert.equal(useNavStore.getState().currentPage, 'worlds')
    assert.match(useNavStore.getState().navigationError ?? '', /cancellation was not verified/i)
  } finally {
    unregister()
    useNavStore.getState().dismissNavigationError()
    await useNavStore.getState().navigate(previousPage)
  }
})

test('nav store accepts worlds as a first-class app page', () => {
  const previousPage = useNavStore.getState().currentPage

  try {
    useNavStore.getState().navigate('worlds' satisfies Page)

    assert.equal(useNavStore.getState().currentPage, 'worlds')
  } finally {
    useNavStore.getState().navigate(previousPage)
  }
})

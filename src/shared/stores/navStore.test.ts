import assert from 'node:assert/strict'
import test from 'node:test'

import { NAV_PAGES, useNavStore, type Page } from './navStore.ts'

test('nav store declares worlds as a first-class app page', () => {
  assert.deepEqual(NAV_PAGES, ['generate', 'workflows', 'worlds', 'models', 'settings'])
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

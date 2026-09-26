import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeWorldWireValue, validateWorldWireValue } from './worldWireValidation.ts'

test('wire validation accepts ordinary and null-prototype JSON data records', () => {
  assert.equal(validateWorldWireValue({ nested: { values: [1, 'two', true, null] } }).success, true)
  const nullPrototype = Object.assign(Object.create(null), { id: 'safe', nested: Object.assign(Object.create(null), { enabled: true }) })
  assert.equal(validateWorldWireValue(nullPrototype).success, true)
})

test('wire validation rejects prototype, accessor, pollution-key, symbol, and array-shape attacks without invoking getters', () => {
  let getterCalls = 0
  const accessor = { safe: true }
  Object.defineProperty(accessor, 'secret', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'not-read'
    },
  })

  class RecordSubclass {
    safe = true
  }
  class ArraySubclass extends Array<number> {}
  const sparse = new Array<number>(2)
  sparse[0] = 1
  const namedArray = [1, 2]
  Object.defineProperty(namedArray, 'named', { enumerable: true, value: true })
  const symbolRecord = { safe: true, [Symbol('hidden')]: true }

  for (const value of [accessor, new RecordSubclass(), new Date(), new ArraySubclass(1, 2), sparse, namedArray, symbolRecord]) {
    assert.equal(validateWorldWireValue(value).success, false)
  }
  assert.equal(getterCalls, 0)

  for (const key of ['__proto__', 'prototype', 'constructor']) {
    const polluted = Object.assign(Object.create(null), { safe: true })
    Object.defineProperty(polluted, key, { enumerable: true, value: { polluted: true } })
    const result = validateWorldWireValue(polluted)
    assert.equal(result.success, false)
    if (result.success === false) assert.ok(result.issues.some((issue) => issue.code === 'wire-key'))
  }
})

test('wire validation aborts cyclic and excessively wide graphs with bounded deterministic issues', () => {
  const cyclic: Record<string, unknown> = { safe: true }
  cyclic.self = cyclic
  const firstCycle = validateWorldWireValue(cyclic)
  const secondCycle = validateWorldWireValue(cyclic)
  assert.equal(firstCycle.success, false)
  assert.deepEqual(firstCycle, secondCycle)
  if (firstCycle.success === false) {
    assert.ok(firstCycle.issues.length <= 2)
    assert.equal(firstCycle.issues[0].code, 'wire-limit')
    assert.equal(firstCycle.issues[0].path, 'value.self')
  }

  const wide = Object.create(null) as Record<string, unknown>
  for (let index = 0; index < 5_000; index += 1) wide[`key-${String(index).padStart(4, '0')}`] = index
  const firstWide = validateWorldWireValue(wide)
  const secondWide = validateWorldWireValue(wide)
  assert.equal(firstWide.success, false)
  assert.deepEqual(firstWide, secondWide)
  if (firstWide.success === false) {
    assert.ok(firstWide.issues.length <= 2)
    assert.equal(firstWide.issues[0].code, 'wire-limit')
    assert.equal(firstWide.issues[0].path, 'value')
  }
})

test('wire normalization rejects transparent and throwing wrappers without leaking parser exceptions', () => {
  const source = { nested: { value: 1 } }
  let reads = 0
  const transparent = new Proxy(source, {
    get(target, property, receiver) {
      reads += 1
      return Reflect.get(target, property, receiver)
    },
  })
  const transparentResult = normalizeWorldWireValue(transparent, 'wrapped')
  assert.equal(transparentResult.success, false)
  assert.equal(reads, 0)

  const throwing = new Proxy(source, {
    getPrototypeOf() {
      throw new Error('wrapper trap')
    },
  })
  assert.doesNotThrow(() => normalizeWorldWireValue(throwing, 'wrapped'))
  const first = normalizeWorldWireValue(throwing, 'wrapped')
  const second = normalizeWorldWireValue(throwing, 'wrapped')
  assert.deepEqual(first, second)
  assert.equal(first.success, false)
})

test('wire validation rejects overlong property names with bounded issues', () => {
  const result = validateWorldWireValue({ ['x'.repeat(257)]: true })
  assert.equal(result.success, false)
  if (result.success === false) {
    assert.ok(result.issues.length <= 16)
    assert.equal(result.issues[0].code, 'wire-limit')
  }
})

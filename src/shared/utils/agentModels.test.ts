import assert from 'node:assert/strict'
import test from 'node:test'

import { parseOllamaModelNames } from './agentModels.ts'

const digest = (character = 'a') => `sha256:${character.repeat(64)}`

test('agent model parser accepts only canonical authoritative objects and sorts by code unit', () => {
  assert.deepEqual(parseOllamaModelNames({
    models: [
      { name: 'alpha:latest', digest: digest('a') },
      { name: 'Zeta:latest', digest: digest('b') },
      { name: 'alpha:latest', digest: digest('c') },
      { name: 'devstral:latest', digest: digest('d') },
    ],
  }), ['Zeta:latest', 'alpha:latest', 'devstral:latest'])
})

test('agent model parser enforces the 256-entry response bound', () => {
  const models = Array.from({ length: 256 }, (_, index) => ({
    name: `model-${String(index).padStart(3, '0')}:latest`,
    digest: digest('a'),
  }))
  assert.equal(parseOllamaModelNames({ models }).length, 256)
  assert.deepEqual(parseOllamaModelNames({ models: [...models, models[0]] }), [])
})

test('agent model parser drops legacy strings and malformed or non-exact entries', () => {
  const valid = { name: 'safe:latest', digest: digest('f') }
  const inherited = Object.assign(Object.create({ polluted: true }), valid)
  const extraOwnKey = { ...valid, size: 42 }
  const ownProtoKey = JSON.parse(`{"name":"unsafe:latest","digest":"${digest('e')}","__proto__":{"polluted":true}}`)
  const malformed = [
    'legacy-untrusted-string',
    inherited,
    extraOwnKey,
    ownProtoKey,
    { ...valid, name: '' },
    { ...valid, name: ' leading:latest' },
    { ...valid, name: 'trailing:latest ' },
    { ...valid, name: 'bad\nname:latest' },
    { ...valid, name: 'x'.repeat(201) },
    { ...valid, name: 42 },
    { ...valid, digest: 'f'.repeat(64) },
    { ...valid, digest: `sha256:${'F'.repeat(64)}` },
    { ...valid, digest: `sha512:${'f'.repeat(64)}` },
    { ...valid, digest: `sha256:${'f'.repeat(63)}` },
  ]

  assert.deepEqual(parseOllamaModelNames({ models: [valid, ...malformed] }), ['safe:latest'])
})

test('agent model parser never invokes response, array, or entry accessors', () => {
  let accessorCalls = 0
  const entryWithAccessor = Object.create(null) as Record<string, unknown>
  Object.defineProperty(entryWithAccessor, 'name', {
    enumerable: true,
    get() { accessorCalls += 1; return 'unsafe:latest' },
  })
  Object.defineProperty(entryWithAccessor, 'digest', {
    enumerable: true,
    value: digest('a'),
  })

  const modelsWithAccessor: unknown[] = []
  Object.defineProperty(modelsWithAccessor, '0', {
    enumerable: true,
    get() { accessorCalls += 1; return { name: 'unsafe:latest', digest: digest('a') } },
  })
  modelsWithAccessor.length = 1

  const responseWithAccessor = Object.create(null) as Record<string, unknown>
  Object.defineProperty(responseWithAccessor, 'models', {
    enumerable: true,
    get() { accessorCalls += 1; return [{ name: 'unsafe:latest', digest: digest('a') }] },
  })

  assert.deepEqual(parseOllamaModelNames({ models: [
    { name: 'safe:latest', digest: digest('b') },
    entryWithAccessor,
  ] }), ['safe:latest'])
  assert.deepEqual(parseOllamaModelNames({ models: modelsWithAccessor }), [])
  assert.deepEqual(parseOllamaModelNames(responseWithAccessor), [])
  assert.equal(accessorCalls, 0)
})

test('agent model parser rejects malformed response containers safely', () => {
  const pollutedResponse = Object.create({ models: [{ name: 'unsafe:latest', digest: digest('a') }] })
  const extraResponseKey = {
    models: [{ name: 'unsafe:latest', digest: digest('a') }],
    extra: true,
  }
  const modelsWithExtraKey = [{ name: 'unsafe:latest', digest: digest('a') }]
  Object.defineProperty(modelsWithExtraKey, 'polluted', { value: true, enumerable: true })

  for (const value of [
    null,
    [],
    { models: 'not-an-array' },
    pollutedResponse,
    extraResponseKey,
    { models: modelsWithExtraKey },
  ]) {
    assert.deepEqual(parseOllamaModelNames(value), [])
  }
})

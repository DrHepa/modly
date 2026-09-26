import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WORLD_RENDER_CHANNELS,
  type WorldRendersApi,
} from '../../src/shared/types/worldRenders.ts'
import { registerWorldRendersIpcHandlers } from './world-renders-ipc.ts'

const PROJECT_KEY = 'world-0123456789abcdef0123456789abcdef'
const JOB_ID = 'render-0123456789abcdef0123456789abcdef'

function setup(options: { trusted?: boolean } = {}) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const calls: string[] = []
  const service: WorldRendersApi = {
    create: async () => { calls.push('create'); return failure('executor_unavailable') },
    list: async () => { calls.push('list'); return { ok: true, value: { jobs: [] } } },
    get: async () => { calls.push('get'); return failure('job_not_found') },
    cancel: async () => { calls.push('cancel'); return failure('job_not_found') },
    delete: async () => { calls.push('delete'); return failure('job_not_found') },
  }
  registerWorldRendersIpcHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
  }, service, { isTrustedSender: () => options.trusted !== false })
  return { handlers, calls }
}

test('render IPC registers the exact five centralized channels and forwards exact requests', async () => {
  const { handlers, calls } = setup()
  assert.deepEqual([...handlers.keys()], Object.values(WORLD_RENDER_CHANNELS))
  const create = {
    projectKey: PROJECT_KEY,
    expectedRevision: 7,
    sceneId: 'scene:main',
    sequenceId: 'sequence:intro',
    preset: { width: 1920, height: 1080, fps: 30 },
  } as const
  await handlers.get(WORLD_RENDER_CHANNELS.create)!({}, create)
  await handlers.get(WORLD_RENDER_CHANNELS.list)!({})
  await handlers.get(WORLD_RENDER_CHANNELS.get)!({}, { jobId: JOB_ID })
  await handlers.get(WORLD_RENDER_CHANNELS.cancel)!({}, { jobId: JOB_ID })
  await handlers.get(WORLD_RENDER_CHANNELS.delete)!({}, { jobId: JOB_ID })
  assert.deepEqual(calls, ['create', 'list', 'get', 'cancel', 'delete'])
})

test('render IPC rejects untrusted senders, wrong arity, exotic prototypes, accessors, and path-bearing create requests', async () => {
  const untrusted = setup({ trusted: false })
  assert.deepEqual(await untrusted.handlers.get(WORLD_RENDER_CHANNELS.list)!({}), {
    ok: false,
    error: { code: 'unauthorized', message: 'World render request is unauthorized.', retryable: false },
  })
  assert.deepEqual(untrusted.calls, [])

  const { handlers, calls } = setup()
  const create = handlers.get(WORLD_RENDER_CHANNELS.create)!
  for (const args of [
    [],
    [{ projectKey: PROJECT_KEY, expectedRevision: 0, sceneId: 'scene:main', sequenceId: 'sequence:intro' }, 'extra'],
    [{ projectKey: PROJECT_KEY, expectedRevision: 0, sceneId: 'scene:main', sequenceId: 'sequence:intro', outputPath: '/tmp/out.webm' }],
    [Object.assign(Object.create({ inherited: true }), { projectKey: PROJECT_KEY, expectedRevision: 0, sceneId: 'scene:main', sequenceId: 'sequence:intro' })],
  ]) {
    const result = await create({}, ...args)
    assert.deepEqual(result, failure('invalid_request'))
  }
  let getterRead = false
  const accessor = { projectKey: PROJECT_KEY, expectedRevision: 0, sceneId: 'scene:main', sequenceId: 'sequence:intro' }
  Object.defineProperty(accessor, 'outputPath', { get: () => { getterRead = true; return '/tmp/out.webm' } })
  assert.deepEqual(await create({}, accessor), failure('invalid_request'))
  assert.equal(getterRead, false)
  assert.deepEqual(calls, [])
})

test('render IPC converts thrown implementation errors to one bounded public failure', async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  registerWorldRendersIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    create: async () => { throw new Error('/private/secret') },
    list: async () => { throw new Error('/private/secret') },
    get: async () => { throw new Error('/private/secret') },
    cancel: async () => { throw new Error('/private/secret') },
    delete: async () => { throw new Error('/private/secret') },
  }, { isTrustedSender: () => true })
  const result = await handlers.get(WORLD_RENDER_CHANNELS.list)!({})
  assert.deepEqual(result, failure('internal_error'))
  assert.equal(JSON.stringify(result).includes('/private'), false)
})

function failure(code: 'invalid_request' | 'job_not_found' | 'executor_unavailable' | 'internal_error') {
  const message = code === 'invalid_request' ? 'World render request is invalid.'
    : code === 'job_not_found' ? 'World render job was not found.'
      : code === 'executor_unavailable' ? 'World render executor is unavailable.'
        : 'World render operation failed.'
  return { ok: false as const, error: { code, message, retryable: code === 'executor_unavailable' || code === 'internal_error' } }
}

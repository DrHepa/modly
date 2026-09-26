import assert from 'node:assert/strict'
import { open as openFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { processOrderedSettledCohorts, readBoundedOpenedFile, readOpenedFileRange, WorldRepositoryIoError } from './world-repository-io.ts'

type CohortAdmission = Parameters<typeof processOrderedSettledCohorts<number, Buffer>>[3]
const typedSyncAdmission: CohortAdmission = () => undefined
// @ts-expect-error async admission callbacks must not satisfy the synchronous admission contract.
const typedAsyncAdmission: CohortAdmission = async () => undefined
void typedSyncAdmission
void typedAsyncAdmission

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

type FakeRead = { bytesRead: number; buffer: Buffer }

class FakeReader {
  readonly calls: Array<{ offset: number; length: number; position: number }> = []
  failAtCall?: number
  impossibleBytesRead?: number
  private readonly source: Buffer
  private readonly chunkSize: number

  constructor(source: Buffer, chunkSize = Number.POSITIVE_INFINITY) {
    this.source = source
    this.chunkSize = chunkSize
  }

  async read(buffer: Buffer, offset: number, length: number, position: number): Promise<FakeRead> {
    this.calls.push({ offset, length, position })
    if (this.failAtCall === this.calls.length) throw new Error('read failed')
    if (this.impossibleBytesRead !== undefined) return { bytesRead: this.impossibleBytesRead, buffer }
    const available = Math.max(0, this.source.byteLength - position)
    const bytesRead = Math.min(length, available, this.chunkSize)
    if (bytesRead > 0) this.source.copy(buffer, offset, position, position + bytesRead)
    return { bytesRead, buffer }
  }
}

test('readBoundedOpenedFile uses positional partial reads and returns owned initialized bytes', async () => {
  const source = Buffer.from('abcdef', 'utf8')
  const reader = new FakeReader(source, 2)
  const bytes = await readBoundedOpenedFile(reader, 10, 6)
  assert.equal(bytes.toString('utf8'), 'abcdef')
  source.fill(0)
  assert.equal(bytes.toString('utf8'), 'abcdef')
  assert.deepEqual(reader.calls, [
    { offset: 0, length: 6, position: 0 },
    { offset: 2, length: 4, position: 2 },
    { offset: 4, length: 2, position: 4 },
    { offset: 0, length: 1, position: 6 },
  ])
})

test('readBoundedOpenedFile handles empty, exact-bound, EOF shrink, and one growth probe', async () => {
  assert.equal((await readBoundedOpenedFile(new FakeReader(Buffer.alloc(0)), 4, 0)).byteLength, 0)
  assert.equal((await readBoundedOpenedFile(new FakeReader(Buffer.from('abcd')), 4, 4)).toString('utf8'), 'abcd')
  assert.equal((await readBoundedOpenedFile(new FakeReader(Buffer.from('abc')), 8, 6)).toString('utf8'), 'abc')
  await assert.rejects(
    () => readBoundedOpenedFile(new FakeReader(Buffer.from('abcde')), 4, 4),
    (error) => error instanceof WorldRepositoryIoError && error.code === 'invalid_document',
  )
})

test('readBoundedOpenedFile rejects unsafe sizes, impossible byte counts, and read failures', async () => {
  await assert.rejects(() => readBoundedOpenedFile(new FakeReader(Buffer.alloc(0)), 4, 5), WorldRepositoryIoError)
  await assert.rejects(() => readBoundedOpenedFile(new FakeReader(Buffer.alloc(0)), -1, 0), WorldRepositoryIoError)
  const negative = new FakeReader(Buffer.from('abc'))
  negative.impossibleBytesRead = -1
  await assert.rejects(() => readBoundedOpenedFile(negative, 10, 3), WorldRepositoryIoError)
  const tooLarge = new FakeReader(Buffer.from('abc'))
  tooLarge.impossibleBytesRead = 4
  await assert.rejects(() => readBoundedOpenedFile(tooLarge, 10, 3), WorldRepositoryIoError)
  const failed = new FakeReader(Buffer.from('abc'))
  failed.failAtCall = 1
  await assert.rejects(() => readBoundedOpenedFile(failed, 10, 3), /read failed/)
})

test('readBoundedOpenedFile supports an actual temporary regular FileHandle', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modly-world-io-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'result.v1.json')
  await writeFile(path, 'regular bytes')
  const handle = await openFile(path, 'r')
  try {
    const bytes = await readBoundedOpenedFile(handle, 64, 13)
    assert.equal(bytes.toString('utf8'), 'regular bytes')
  } finally {
    await handle.close()
  }
})

test('readOpenedFileRange uses bounded positional reads without whole-file buffering', async () => {
  const source = Buffer.from('0123456789', 'utf8')
  const reader = new FakeReader(source, 2)
  const bytes = await readOpenedFileRange(reader, 3, 5)
  assert.equal(bytes.toString('utf8'), '34567')
  assert.deepEqual(reader.calls, [
    { offset: 0, length: 5, position: 3 },
    { offset: 2, length: 3, position: 5 },
    { offset: 4, length: 1, position: 7 },
  ])
})

test('readOpenedFileRange rejects invalid ranges and truncated opened files', async () => {
  await assert.rejects(() => readOpenedFileRange(new FakeReader(Buffer.alloc(0)), -1, 1), WorldRepositoryIoError)
  await assert.rejects(() => readOpenedFileRange(new FakeReader(Buffer.alloc(0)), 0, 0), WorldRepositoryIoError)
  await assert.rejects(() => readOpenedFileRange(new FakeReader(Buffer.from('abc')), 1, 4), WorldRepositoryIoError)
})

test('processOrderedSettledCohorts runs width-four settled cohorts with source-ordered admission', async () => {
  const gates = Array.from({ length: 5 }, () => deferred<Buffer>())
  const events: string[] = []
  const work = processOrderedSettledCohorts([0, 1, 2, 3, 4], 4, (item) => {
    events.push(`read-start:${item}`)
    return gates[item].promise
  }, (bytes, item) => {
    events.push(`admit:${item}:${bytes.toString('utf8')}`)
  })
  await Promise.resolve()
  assert.deepEqual(events, ['read-start:0', 'read-start:1', 'read-start:2', 'read-start:3'])
  gates[3].resolve(Buffer.from('three'))
  gates[2].resolve(Buffer.from('two'))
  await Promise.resolve()
  assert.deepEqual(events, ['read-start:0', 'read-start:1', 'read-start:2', 'read-start:3'])
  gates[1].resolve(Buffer.from('one'))
  gates[0].resolve(Buffer.from('zero'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, [
    'read-start:0', 'read-start:1', 'read-start:2', 'read-start:3',
    'admit:0:zero', 'admit:1:one', 'admit:2:two', 'admit:3:three', 'read-start:4',
  ])
  gates[4].resolve(Buffer.from('four'))
  await work
  assert.deepEqual(events.at(-1), 'admit:4:four')
})

test('processOrderedSettledCohorts preserves earliest source-order raw and semantic failures', async () => {
  const rawLater = new Error('raw later')
  const semanticFirst = new Error('semantic first')
  const admitted: number[] = []
  await assert.rejects(
    () => processOrderedSettledCohorts([0, 1, 2, 3], 4, (item) => item === 1
      ? Promise.reject(rawLater)
      : Promise.resolve(Buffer.from(String(item))), (bytes, item) => {
      admitted.push(item)
      if (item === 0) throw semanticFirst
    }),
    semanticFirst,
  )
  assert.deepEqual(admitted, [0])

  let caught: unknown = Symbol('not caught')
  try {
    await processOrderedSettledCohorts([0, 1], 4, (item) => item === 0
      ? Promise.reject(undefined)
      : Promise.resolve(Buffer.from(String(item))), () => { admitted.push(9) })
  } catch (error) {
    caught = error
  }
  assert.equal(caught, undefined)
})

test('processOrderedSettledCohorts waits for accidental async admission fulfillment before rejecting', async () => {
  const gate = deferred<void>()
  const events: string[] = []
  let outcome: 'pending' | 'fulfilled' | 'rejected' = 'pending'
  const unsafeAsyncAdmission = (((_bytes: Buffer, item: number) => {
    events.push(`admit-start:${item}`)
    return gate.promise.then(() => { events.push(`admit-after-await:${item}`) })
  }) as unknown) as CohortAdmission
  const work = processOrderedSettledCohorts([0], 1, async () => Buffer.from('0'), unsafeAsyncAdmission)
    .then(() => { outcome = 'fulfilled' }, () => { outcome = 'rejected' })
  try {
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(outcome, 'pending')
  } finally {
    gate.resolve()
    await work
  }
  assert.equal(outcome, 'rejected')
  assert.deepEqual(events, ['admit-start:0', 'admit-after-await:0'])
})

test('processOrderedSettledCohorts handles accidental async admission rejection without unhandled rejection', async () => {
  const gate = deferred<void>()
  const late = new Error('late async admission rejection')
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  let outcome: 'pending' | 'fulfilled' | 'rejected' = 'pending'
  const unsafeAsyncAdmission = ((() => gate.promise.then(() => { throw late })) as unknown) as CohortAdmission
  const work = processOrderedSettledCohorts([0], 1, async () => Buffer.from('0'), unsafeAsyncAdmission)
    .then(() => { outcome = 'fulfilled' }, () => { outcome = 'rejected' })
  try {
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(outcome, 'pending')
    gate.resolve()
    await work
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(outcome, 'rejected')
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
    gate.resolve()
    await work.catch(() => undefined)
  }
})

test('processOrderedSettledCohorts settles sync reader throws and rejects async admission leaks', async () => {
  const syncFailure = new Error('sync reader')
  await assert.rejects(
    () => processOrderedSettledCohorts([0, 1], 4, (item) => {
      if (item === 0) throw syncFailure
      return Promise.resolve(Buffer.from('later'))
    }, () => undefined),
    syncFailure,
  )

  const admitted: number[] = []
  const unsafeAsyncAdmission = (((_bytes: Buffer, item: number) => {
    admitted.push(item)
    return Promise.resolve()
  }) as unknown) as CohortAdmission
  await assert.rejects(
    () => processOrderedSettledCohorts([0, 1], 4, async (item) => Buffer.from(String(item)), unsafeAsyncAdmission),
    /synchronous/,
  )
  assert.deepEqual(admitted, [0])
  await assert.rejects(() => processOrderedSettledCohorts([0], 0, async () => Buffer.alloc(0), () => undefined), WorldRepositoryIoError)
  await processOrderedSettledCohorts([], 4, async () => Buffer.alloc(0), () => { throw new Error('unreachable') })
})

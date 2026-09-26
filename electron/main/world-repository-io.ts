export class WorldRepositoryIoError extends Error {
  readonly code: 'invalid_document'

  constructor(message: string, code: 'invalid_document' = 'invalid_document') {
    super(message)
    this.name = 'WorldRepositoryIoError'
    this.code = code
  }
}

export interface PositionalReadFile {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number; buffer: Buffer }>
}

export async function readBoundedOpenedFile(
  file: PositionalReadFile,
  maximum: number,
  openedSize: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new WorldRepositoryIoError('Invalid maximum byte limit')
  if (!Number.isSafeInteger(openedSize) || openedSize < 0) throw new WorldRepositoryIoError('Invalid opened byte size')
  if (openedSize > maximum) throw new WorldRepositoryIoError('Opened file exceeds maximum byte limit')

  const selectedBound = openedSize
  const bytes = Buffer.allocUnsafe(selectedBound)
  let used = 0
  while (used < selectedBound) {
    const length = selectedBound - used
    const result = await file.read(bytes, used, length, used)
    assertPossibleBytesRead(result.bytesRead, length)
    if (result.bytesRead === 0) break
    used += result.bytesRead
  }

  const probe = Buffer.allocUnsafe(1)
  const overflow = await file.read(probe, 0, 1, selectedBound)
  assertPossibleBytesRead(overflow.bytesRead, 1)
  if (overflow.bytesRead !== 0) throw new WorldRepositoryIoError('Opened file grew beyond selected byte bound')

  return Buffer.from(bytes.subarray(0, used))
}

export async function readOpenedFileRange(
  file: PositionalReadFile,
  offset: number,
  length: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new WorldRepositoryIoError('Invalid range offset')
  if (!Number.isSafeInteger(length) || length <= 0) throw new WorldRepositoryIoError('Invalid range length')

  const bytes = Buffer.allocUnsafe(length)
  let used = 0
  while (used < length) {
    const requested = length - used
    const result = await file.read(bytes, used, requested, offset + used)
    assertPossibleBytesRead(result.bytesRead, requested)
    if (result.bytesRead === 0) throw new WorldRepositoryIoError('Opened file ended before requested range')
    used += result.bytesRead
  }
  return Buffer.from(bytes)
}

function assertPossibleBytesRead(bytesRead: number, requested: number): void {
  if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > requested) {
    throw new WorldRepositoryIoError('File read returned an impossible byte count')
  }
}

export async function processOrderedSettledCohorts<T, R>(
  items: readonly T[],
  width: number,
  reader: (item: T, index: number) => Promise<R>,
  admit: (value: R, item: T, index: number) => undefined,
): Promise<void> {
  if (!Number.isSafeInteger(width) || width < 1) throw new WorldRepositoryIoError('Invalid settled cohort width')
  for (let offset = 0; offset < items.length; offset += width) {
    const cohort = items.slice(offset, offset + width)
    const settled = await Promise.allSettled(cohort.map((item, index) => Promise.resolve().then(() => reader(item, offset + index))))
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index]
      if (result.status === 'rejected') throw result.reason
      const admissionResult = admit(result.value, cohort[index], offset + index)
      if (isPromiseLike(admissionResult)) {
        try { await admissionResult } catch { /* async admission is still a sync-contract violation */ }
        throw new WorldRepositoryIoError('Ordered cohort admission must be synchronous')
      }
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value) && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { then?: unknown }).then === 'function'
}

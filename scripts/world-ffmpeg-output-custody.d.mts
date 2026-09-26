export interface WorldFfmpegOutputDirectoryIdentity {
  readonly dev: string
  readonly ino: string
}

export interface WorldFfmpegOutputFileReceipt {
  readonly name: string
  readonly dev: string
  readonly ino: string
  readonly size: number
  readonly sha256: string
}

export interface WorldFfmpegOutputCustodyReceipt {
  readonly schema: 'modly.world-ffmpeg-output-custody-receipt.v1'
  readonly operation: 'directory' | 'hash' | 'read' | 'write' | 'snapshot'
  readonly rootIdentity: WorldFfmpegOutputDirectoryIdentity
  readonly directoryIdentity: WorldFfmpegOutputDirectoryIdentity
  readonly file?: WorldFfmpegOutputFileReceipt
  readonly bytesBase64?: string
  readonly files?: readonly Readonly<{
    segments: readonly string[]
    file: WorldFfmpegOutputFileReceipt
    mode: number
    bytesBase64: string
  }>[]
  readonly hashFiles?: readonly Readonly<{
    segments: readonly string[]
    file: WorldFfmpegOutputFileReceipt
    mode: number
  }>[]
  readonly directories?: readonly Readonly<{
    segments: readonly string[]
    mode: number
    entries: readonly Readonly<{
      name: string
      kind: 'file' | 'directory'
      dev: string
      ino: string
      size: number
      mode: number
    }>[]
  }>[]
}

export interface WorldFfmpegOutputCustodyRequest {
  readonly operation: 'directory' | 'hash' | 'read' | 'write' | 'snapshot'
  readonly directory: string
  readonly expectedDirectoryIdentity?: WorldFfmpegOutputDirectoryIdentity
  readonly segments?: readonly string[]
  readonly name?: string
  readonly maximumBytes?: number
  readonly bytes?: Buffer
  readonly files?: readonly Readonly<{
    segments: readonly string[]
    name: string
    maximumBytes: number
  }>[]
  readonly hashFiles?: readonly Readonly<{
    segments: readonly string[]
    name: string
    maximumBytes: number
  }>[]
  readonly directories?: readonly Readonly<{ segments: readonly string[] }>[]
  readonly environment?: Readonly<Record<string, string | undefined>>
}

export function runWorldFfmpegOutputCustody(
  input: WorldFfmpegOutputCustodyRequest,
  dependencies?: Readonly<Record<string, unknown>>,
): Promise<WorldFfmpegOutputCustodyReceipt>

export function _testOnlyRunWorldFfmpegOutputCustodyInProcess(
  input: WorldFfmpegOutputCustodyRequest,
  dependencies?: Readonly<{ afterRootOpen?: () => void | Promise<void> }>,
): Promise<WorldFfmpegOutputCustodyReceipt>

export function validateWorldFfmpegOutputFileReceipt(
  value: unknown,
): value is WorldFfmpegOutputFileReceipt

export function sameWorldFfmpegOutputFileReceipt(
  left: unknown,
  right: unknown,
): boolean

export function sameWorldFfmpegOutputDirectoryIdentity(
  left: unknown,
  right: unknown,
): boolean

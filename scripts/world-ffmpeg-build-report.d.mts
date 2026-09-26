export interface WorldFfmpegBuildReportIdentityInput {
  readonly target: string
  readonly supplyChainBytes: Uint8Array
  readonly manifestBytes: Uint8Array
  readonly signatureBytes: Uint8Array
  readonly trustBytes: Uint8Array
  readonly signingKeyId: string
  readonly runtimeRpath?: string
  readonly configure?: unknown
  readonly linkerEnvironment?: unknown
  readonly tools?: unknown
}

export function validateWorldFfmpegBuildReport(
  value: unknown,
  input: WorldFfmpegBuildReportIdentityInput,
): boolean

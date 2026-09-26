export interface WorldFfmpegLoadedBuildTrust {
  readonly keys: Readonly<Record<string, string>>
  readonly keyId: string
  readonly bytes: Buffer
  readonly sha256: string
}

export interface WorldFfmpegCreatedBuildTrust {
  readonly keyId: string
  readonly privateKeyFile: string
  readonly trustFile: string
  readonly trustSha256: string
  readonly publicKeySha256: string
}

export function createWorldFfmpegBuildTrust(input: {
  readonly outputDirectory: string
  readonly keyId: string
  readonly privateKeyFile?: string
}): Promise<WorldFfmpegCreatedBuildTrust>

export function loadWorldFfmpegBuildTrust(path: string): Promise<WorldFfmpegLoadedBuildTrust>
export function loadWorldFfmpegBuildTrustSync(path: string): WorldFfmpegLoadedBuildTrust

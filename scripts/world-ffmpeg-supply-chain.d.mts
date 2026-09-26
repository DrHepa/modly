export interface WorldFfmpegDistributionFile {
  readonly path: string
  readonly sha256: string
}

export interface WorldFfmpegSupplyChainContract {
  readonly ffmpegVersion: '7.1.1'
  readonly distributionFiles: readonly WorldFfmpegDistributionFile[]
}

export function loadWorldFfmpegSupplyChain(path?: string): Promise<WorldFfmpegSupplyChainContract>

export function worldFfmpegTargetFor(
  platform: string,
  arch: string,
): 'linux-arm64' | 'linux-x64' | 'darwin-arm64' | 'win32-x64' | null

export function verifyWorldFfmpegPackagedDistributionFiles(
  contract: WorldFfmpegSupplyChainContract,
  resourcesDirectory: string,
): Promise<
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly code: 'distribution-tree-invalid' | 'distribution-file-invalid'
      readonly path: string | null
    }
>

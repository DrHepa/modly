export interface WorldFfmpegNativeCase {
  readonly id: string
  readonly fps: 24 | 25 | 30 | 60
  readonly duration: { readonly numerator: number; readonly denominator: number }
}

export interface WorldFfmpegNativeCasePlan {
  readonly fps: 24 | 25 | 30 | 60
  readonly frameCount: number
  readonly audioSampleCount: number
  readonly duration: { readonly numerator: number; readonly denominator: number }
  readonly finalFrameDuration: { readonly numerator: number; readonly denominator: number }
}

export const WORLD_FFMPEG_NATIVE_CASES: readonly WorldFfmpegNativeCase[]
export function worldFfmpegNativeCasePlan(input: WorldFfmpegNativeCase): WorldFfmpegNativeCasePlan

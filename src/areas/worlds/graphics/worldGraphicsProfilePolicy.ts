import type { WorldGraphicsProfile, WorldProjectDocumentV1 } from '../core/worldModel.ts'

export type WorldGraphicsViewportKind = 'editor' | 'play'

export interface WorldGraphicsViewportMetrics {
  cssWidth: number
  cssHeight: number
}

export interface WorldGraphicsSampleSupport {
  colorInternalFormat: 'RGBA16F'
  depthInternalFormat: 'DEPTH_COMPONENT24'
  colorSamples: readonly number[]
  depthSamples: readonly number[]
}

export interface WorldGraphicsCapabilities {
  webgl2: boolean
  maxTextureSize: number
  maxCubeMapTextureSize: number
  maxRenderbufferSize: number
  maxViewportDims: readonly [number, number]
  maxSamples: number
  halfFloatRenderTarget: boolean
  renderTargetSamples: WorldGraphicsSampleSupport
}

export interface EffectiveWorldGraphicsProfile {
  profileId: string
  profileName: string
  requested: WorldGraphicsProfile
  dpr: number
  drawingBufferWidth: number
  drawingBufferHeight: number
  shadows: { enabled: boolean; mapSize: number; clamped: boolean }
  limits: { maxTextureSize: number; maxRenderbufferSize: number; maxViewportWidth: number; maxViewportHeight: number }
  aa: { mode: 'off' | 'fxaa' | 'msaa'; fxaa: boolean; samples: 0 | 2 | 4; degraded: boolean }
  diagnostics: string[]
}

export type ResolveWorldGraphicsProfileResult =
  | { ok: true; value: EffectiveWorldGraphicsProfile }
  | { ok: false; diagnostic: string }

const SHADOW_FACE_SIZES = Object.freeze({ off: 0, low: 512, medium: 1024, high: 2048 })

export function resolveWorldGraphicsProfile(
  project: WorldProjectDocumentV1,
  metrics: WorldGraphicsViewportMetrics,
  caps: WorldGraphicsCapabilities,
): ResolveWorldGraphicsProfileResult {
  const activeProfileId = project.activeGraphicsProfileId
  const requested = project.graphicsProfiles.find((profile) => profile.id === activeProfileId)
  if (!requested) return { ok: false, diagnostic: `Active graphics profile ${activeProfileId} is unavailable.` }

  const diagnostics: string[] = []
  const cssWidth = normalizeCssPixels(metrics.cssWidth)
  const cssHeight = normalizeCssPixels(metrics.cssHeight)
  if (cssWidth === 0 || cssHeight === 0) {
    diagnostics.push('Viewport has zero CSS size; no graphics targets or frame will be rendered.')
    return {
      ok: true,
      value: {
        profileId: requested.id,
        profileName: requested.name,
        requested: structuredClone(requested),
        dpr: 0,
        drawingBufferWidth: 0,
        drawingBufferHeight: 0,
        shadows: { enabled: false, mapSize: 0, clamped: false },
        aa: { mode: 'off', fxaa: false, samples: 0, degraded: requested.antialiasing !== 'off' },
        limits: { maxTextureSize: caps.maxTextureSize, maxRenderbufferSize: caps.maxRenderbufferSize, maxViewportWidth: caps.maxViewportDims[0], maxViewportHeight: caps.maxViewportDims[1] },
        diagnostics,
      },
    }
  }

  if (!caps.halfFloatRenderTarget) return { ok: false, diagnostic: 'RGBA16F half-float render targets are unsupported by this graphics context.' }

  const targetLimitWidth = finitePositive(Math.min(caps.maxRenderbufferSize, caps.maxTextureSize, caps.maxViewportDims[0]))
  const targetLimitHeight = finitePositive(Math.min(caps.maxRenderbufferSize, caps.maxTextureSize, caps.maxViewportDims[1]))
  const requestedDpr = Math.max(0.25, Math.min(2, requested.renderScale))
  const maxDprByWidth = targetLimitWidth / cssWidth
  const maxDprByHeight = targetLimitHeight / cssHeight
  const dpr = Math.max(1 / Math.max(cssWidth, cssHeight), Math.min(requestedDpr, maxDprByWidth, maxDprByHeight))
  const drawingBufferWidth = Math.max(1, Math.floor(cssWidth * dpr))
  const drawingBufferHeight = Math.max(1, Math.floor(cssHeight * dpr))
  if (dpr < requestedDpr) diagnostics.push(`Render scale ${formatNumber(requested.renderScale)} was clamped to ${formatNumber(dpr)} by render target limits.`)

  const shadows = resolveShadowPolicy(requested.shadowQuality, caps, diagnostics)
  const aa = resolveAntialiasingPolicy(requested.antialiasing, caps, diagnostics)

  return {
    ok: true,
    value: {
      profileId: requested.id,
      profileName: requested.name,
      requested: structuredClone(requested),
      dpr,
      drawingBufferWidth,
      drawingBufferHeight,
      shadows,
      aa,
      limits: { maxTextureSize: caps.maxTextureSize, maxRenderbufferSize: caps.maxRenderbufferSize, maxViewportWidth: caps.maxViewportDims[0], maxViewportHeight: caps.maxViewportDims[1] },
      diagnostics,
    },
  }
}

export function resolveWorldGraphicsMsaaSamples(caps: Pick<WorldGraphicsCapabilities, 'webgl2' | 'renderTargetSamples'>): 0 | 2 | 4 {
  if (!caps.webgl2) return 0
  const color = new Set(caps.renderTargetSamples.colorSamples)
  const depth = new Set(caps.renderTargetSamples.depthSamples)
  const maxSamples = Number.isFinite((caps as { maxSamples?: number }).maxSamples) ? Number((caps as { maxSamples?: number }).maxSamples) : 4
  for (const samples of [4, 2] as const) {
    if (samples <= maxSamples && color.has(samples) && depth.has(samples)) return samples
  }
  return 0
}

export function resolveWorldGraphicsShadowMapSize(
  quality: WorldGraphicsProfile['shadowQuality'],
  caps: Pick<WorldGraphicsCapabilities, 'maxTextureSize' | 'maxRenderbufferSize'> & Partial<Pick<WorldGraphicsCapabilities, 'maxViewportDims'>>,
): { enabled: boolean; mapSize: number; clamped: boolean } {
  const requested = SHADOW_FACE_SIZES[quality]
  if (requested === 0) return { enabled: false, mapSize: 0, clamped: false }
  const mapSize = Math.max(1, Math.floor(Math.min(
    requested,
    finitePositive(caps.maxTextureSize),
    finitePositive(caps.maxRenderbufferSize),
    finitePositive(caps.maxViewportDims?.[0] ?? Number.MAX_SAFE_INTEGER),
    finitePositive(caps.maxViewportDims?.[1] ?? Number.MAX_SAFE_INTEGER),
  )))
  return { enabled: true, mapSize, clamped: mapSize !== requested }
}

function resolveShadowPolicy(
  quality: WorldGraphicsProfile['shadowQuality'],
  caps: WorldGraphicsCapabilities,
  diagnostics: string[],
): EffectiveWorldGraphicsProfile['shadows'] {
  const shadows = resolveWorldGraphicsShadowMapSize(quality, caps)
  if (shadows.clamped) diagnostics.push(`Shadow map size was clamped to ${shadows.mapSize}px per face by texture/renderbuffer limits.`)
  return shadows
}

function resolveAntialiasingPolicy(
  antialiasing: WorldGraphicsProfile['antialiasing'],
  caps: WorldGraphicsCapabilities,
  diagnostics: string[],
): EffectiveWorldGraphicsProfile['aa'] {
  if (antialiasing === 'off') return { mode: 'off', fxaa: false, samples: 0, degraded: false }
  if (antialiasing === 'fxaa') return { mode: 'fxaa', fxaa: true, samples: 0, degraded: false }
  const samples = resolveWorldGraphicsMsaaSamples(caps)
  if (samples > 0) return { mode: 'msaa', fxaa: false, samples, degraded: false }
  diagnostics.push('MSAA is unavailable for RGBA16F + DEPTH_COMPONENT24 targets; falling back to FXAA.')
  return { mode: 'fxaa', fxaa: true, samples: 0, degraded: true }
}

function normalizeCssPixels(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function finitePositive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

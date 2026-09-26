import assert from 'node:assert/strict'
import test from 'node:test'
import type { WorldGraphicsProfile, WorldProjectDocumentV1 } from '../core/worldModel.ts'
import {
  resolveWorldGraphicsMsaaSamples,
  resolveWorldGraphicsProfile,
  resolveWorldGraphicsShadowMapSize,
  type WorldGraphicsCapabilities,
} from './worldGraphicsProfilePolicy.ts'

function project(profile: WorldGraphicsProfile, activeGraphicsProfileId = profile.id): WorldProjectDocumentV1 {
  return {
    schema: 'modly.world-project.v1', projectId: 'project:graphics', name: 'Graphics', revision: 1,
    resources: [], scenes: [], startSceneId: 'scene:one', inputActions: [], graphicsProfiles: [profile], activeGraphicsProfileId,
  }
}

function caps(overrides: Partial<WorldGraphicsCapabilities> = {}): WorldGraphicsCapabilities {
  return {
    webgl2: true,
    maxTextureSize: 8192,
    maxCubeMapTextureSize: 8192,
    maxRenderbufferSize: 4096,
    maxViewportDims: [4096, 4096],
    maxSamples: 4,
    halfFloatRenderTarget: true,
    renderTargetSamples: { colorInternalFormat: 'RGBA16F', depthInternalFormat: 'DEPTH_COMPONENT24', colorSamples: [2, 4], depthSamples: [4] },
    ...overrides,
  }
}

test('resolves only the active canonical graphics profile and reports missing active ids', () => {
  const result = resolveWorldGraphicsProfile(project({ id: 'graphics:one', name: 'One', renderScale: 1, shadowQuality: 'medium', antialiasing: 'fxaa' }, 'graphics:missing'), { cssWidth: 800, cssHeight: 600 }, caps())
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.diagnostic, /graphics:missing/)
})

test('renderScale is CSS-relative DPR and truthfully clamps target dimensions', () => {
  const result = resolveWorldGraphicsProfile(project({ id: 'graphics:integrated', name: 'Integrated', renderScale: 0.75, shadowQuality: 'off', antialiasing: 'off' }), { cssWidth: 1920, cssHeight: 1080 }, caps({ maxRenderbufferSize: 1000, maxViewportDims: [1000, 900] }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.drawingBufferWidth <= 1000, true)
  assert.equal(result.value.drawingBufferHeight <= 900, true)
  assert.equal(result.value.dpr < 0.75, true)
  assert.match(result.value.diagnostics.join('\n'), /clamped/)
})

test('zero CSS size allocates no targets or frame', () => {
  const result = resolveWorldGraphicsProfile(project({ id: 'graphics:one', name: 'One', renderScale: 1, shadowQuality: 'high', antialiasing: 'msaa' }), { cssWidth: 0, cssHeight: 600 }, caps())
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.dpr, 0)
  assert.equal(result.value.drawingBufferWidth, 0)
  assert.equal(result.value.aa.samples, 0)
  assert.equal(result.value.shadows.enabled, false)
})

test('MSAA uses RGBA16F and DEPTH_COMPONENT24 sample intersection, otherwise degrades to FXAA', () => {
  assert.equal(resolveWorldGraphicsMsaaSamples(caps().renderTargetSamples ? caps() : caps()), 4)
  assert.equal(resolveWorldGraphicsMsaaSamples(caps({ renderTargetSamples: { colorInternalFormat: 'RGBA16F', depthInternalFormat: 'DEPTH_COMPONENT24', colorSamples: [2, 4], depthSamples: [2] } })), 2)
  assert.equal(resolveWorldGraphicsMsaaSamples(caps({ renderTargetSamples: { colorInternalFormat: 'RGBA16F', depthInternalFormat: 'DEPTH_COMPONENT24', colorSamples: [4], depthSamples: [2] } })), 0)
  const result = resolveWorldGraphicsProfile(project({ id: 'graphics:dedicated', name: 'Dedicated', renderScale: 1, shadowQuality: 'high', antialiasing: 'msaa' }), { cssWidth: 640, cssHeight: 480 }, caps({ renderTargetSamples: { colorInternalFormat: 'RGBA16F', depthInternalFormat: 'DEPTH_COMPONENT24', colorSamples: [4], depthSamples: [2] } }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.value.aa, { mode: 'fxaa', fxaa: true, samples: 0, degraded: true })
  assert.match(result.value.diagnostics.join('\n'), /RGBA16F \+ DEPTH_COMPONENT24/)
})

test('shadow quality clamps arbitrary per-face map sizes including point-light 4x2 atlas limits', () => {
  assert.deepEqual(resolveWorldGraphicsShadowMapSize('off', caps()), { enabled: false, mapSize: 0, clamped: false })
  assert.deepEqual(resolveWorldGraphicsShadowMapSize('high', caps({ maxTextureSize: 1024, maxRenderbufferSize: 1024, maxViewportDims: [1024, 1024] })), { enabled: true, mapSize: 1024, clamped: true })
})

test('target dimensions include texture limits and unsupported HalfFloat targets fail truthfully', () => {
  const clipped = resolveWorldGraphicsProfile(project({ id: 'graphics:two', name: 'Two', renderScale: 2, shadowQuality: 'off', antialiasing: 'off' }), { cssWidth: 1200, cssHeight: 600 }, caps({ maxTextureSize: 900, maxRenderbufferSize: 4096, maxViewportDims: [4096, 4096] }))
  assert.equal(clipped.ok, true)
  if (!clipped.ok) return
  assert.equal(clipped.value.drawingBufferWidth <= 900, true)
  const unsupported = resolveWorldGraphicsProfile(project({ id: 'graphics:one', name: 'One', renderScale: 1, shadowQuality: 'off', antialiasing: 'off' }), { cssWidth: 640, cssHeight: 480 }, caps({ halfFloatRenderTarget: false }))
  assert.equal(unsupported.ok, false)
  assert.match(unsupported.ok ? '' : unsupported.diagnostic, /RGBA16F half-float/)
})

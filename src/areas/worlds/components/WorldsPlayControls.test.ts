import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

test('project bar and workbench expose compact accessible Play lifecycle controls', async () => {
  const bar = await readFile(path.join(import.meta.dirname, 'WorldsProjectBar.tsx'), 'utf8')
  const workbench = await readFile(path.join(import.meta.dirname, 'WorldsWorkbench.tsx'), 'utf8')
  const css = await readFile(path.join(import.meta.dirname, '../WorldsWorkbench.css'), 'utf8')
  assert.match(bar, /aria-label="Play World"/)
  assert.match(bar, /aria-label="Pause World"/)
  assert.match(bar, /aria-label="Resume World"/)
  assert.match(bar, /aria-label="Stop World"/)
  assert.match(bar, /<Tooltip content="Play"/)
  assert.match(bar, /onPointerDown={onPlayIntent}/)
  assert.match(workbench, /onPlayIntent={handlePlayIntent}/)
  assert.match(workbench, /window\.setTimeout\([\s\S]*renewEditViewport\(\)/)
  assert.match(workbench, /window\.addEventListener\('pointerup'/)
  assert.match(workbench, /cancelPendingPlayIntent\(\)[\s\S]*revokeEditViewport\(\)[\s\S]*playController\.start/)
  assert.match(workbench, /revokeEditViewport\(\)[\s\S]*playController\.start/)
  assert.match(workbench, /if \(!viewportCommitAuthority\.isCurrent\(viewportCommitLeaseRef\.current\)\) renewEditViewport\(\)/)
  assert.match(workbench, /<WorldRuntimeViewport/)
  assert.match(workbench, /loadWorldGeometrySource/)
  assert.match(workbench, /geometry: \{ apiUrl, loadModelGeometry: loadWorldGeometrySource \}/)
  assert.match(workbench, /playState\.lifecycle === 'edit'/)
  assert.match(workbench, /if \(playFailure\) announceError\(playFailure\.message\)/)
  assert.match(workbench, /runtime-load-cancelled/)
  assert.match(css, /\.worlds-play-controls/)
  assert.match(css, /min-height:\s*32px/)
})

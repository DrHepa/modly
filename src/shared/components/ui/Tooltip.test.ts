import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  TOOLTIP_POINTER_DELAY_MS,
  reduceTooltipVisibility,
  placeTooltip,
} from './tooltipModel.ts'

test('tooltip state machine delays pointer by exactly two seconds and focuses immediately', () => {
  assert.equal(TOOLTIP_POINTER_DELAY_MS, 2_000)
  assert.deepEqual(reduceTooltipVisibility({ visible: false, pointerPending: false }, { type: 'pointer-enter' }), { visible: false, pointerPending: true })
  assert.deepEqual(reduceTooltipVisibility({ visible: false, pointerPending: true }, { type: 'pointer-delay-elapsed' }), { visible: true, pointerPending: false })
  assert.deepEqual(reduceTooltipVisibility({ visible: false, pointerPending: true }, { type: 'focus' }), { visible: true, pointerPending: false })
  assert.deepEqual(reduceTooltipVisibility({ visible: true, pointerPending: false }, { type: 'escape' }), { visible: false, pointerPending: false })
})

test('tooltip placement remains within narrow viewport and flips from the right edge', () => {
  assert.deepEqual(placeTooltip({ left: 280, right: 310, top: 80, height: 30 }, { width: 320, height: 200 }, { width: 220, height: 48 }),
    { left: 50, top: 95, side: 'left' })
  const narrow = placeTooltip({ left: 40, right: 70, top: 40, height: 20 }, { width: 180, height: 100 }, { width: 180, height: 40 })
  assert.ok(narrow.left >= 8 && narrow.left + 164 <= 172)
  assert.equal(narrow.side, 'none')
  const bottom = placeTooltip({ left: 280, right: 310, top: 88, height: 16 }, { width: 320, height: 100 }, { width: 220, height: 60 })
  assert.deepEqual(bottom, { left: 50, top: 62, side: 'left' })
  const tallerThanViewport = placeTooltip({ left: 40, right: 70, top: 88, height: 16 }, { width: 180, height: 70 }, { width: 164, height: 140 })
  assert.equal(tallerThanViewport.top, 35)
})

test('tooltip markup has a stable description relationship without native title', async () => {
  const source = await readFile(path.join(import.meta.dirname, 'Tooltip.tsx'), 'utf8')
  assert.match(source, /aria-describedby/)
  assert.match(source, /role="tooltip"/)
  assert.match(source, /React\.useId\(\)/)
  assert.doesNotMatch(source, /\btitle\s*=/)
  assert.match(source, /onBlur=/)
  assert.match(source, /event\.key === 'Escape'/)
  assert.match(source, /tooltipRef\.current\?\.getBoundingClientRect\(\)/)
  assert.match(source, /coords\.side === 'left'/)
  assert.match(source, /coords\.side === 'left'[\s\S]*?left-full[\s\S]*?border-l-zinc-700/)
  assert.match(source, /coords\.side === 'right'[\s\S]*?right-full[\s\S]*?border-r-zinc-700/)
  assert.match(source, /max-h-\[calc\(100dvh-16px\)\] overflow-y-auto/)
})

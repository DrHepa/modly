import type { KeyboardInputEvent } from 'electron'

export function nativeKeySequence(keyCode: string, modifiers: KeyboardInputEvent['modifiers'] = []): KeyboardInputEvent[] {
  const sequence: KeyboardInputEvent[] = [{ type: 'keyDown', keyCode, modifiers }]
  // Electron 44 keyDown is RawKeyDown. Native Enter activation requires a separate
  // char before keyUp, which otherwise resets Chromium's keydown suppression.
  if (keyCode === 'Enter' && modifiers.length === 0) sequence.push({ type: 'char', keyCode: 'Enter', modifiers })
  sequence.push({ type: 'keyUp', keyCode, modifiers })
  return sequence
}

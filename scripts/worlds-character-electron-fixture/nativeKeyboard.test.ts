import assert from 'node:assert/strict'
import test from 'node:test'
import type { KeyboardInputEvent } from 'electron'
import { nativeKeySequence } from './nativeKeyboard.ts'

test('native fixture Enter emits exactly one named char between keyDown and keyUp', () => {
  const expected = [
    { type: 'keyDown', keyCode: 'Enter', modifiers: [] },
    { type: 'char', keyCode: 'Enter', modifiers: [] },
    { type: 'keyUp', keyCode: 'Enter', modifiers: [] },
  ]
  assert.deepEqual(nativeKeySequence('Enter'), expected)
  assert.deepEqual(nativeKeySequence('Enter', []), expected)
})

test('native fixture modified Enter never synthesizes a char event', () => {
  const modifiers: NonNullable<KeyboardInputEvent['modifiers']> = [
    'shift', 'control', 'ctrl', 'alt', 'meta', 'command', 'cmd', 'iskeypad', 'isautorepeat',
    'leftbuttondown', 'middlebuttondown', 'rightbuttondown', 'capslock', 'numlock', 'left', 'right',
  ]
  for (const modifier of modifiers) {
    assert.deepEqual(nativeKeySequence('Enter', [modifier]), [
      { type: 'keyDown', keyCode: 'Enter', modifiers: [modifier] },
      { type: 'keyUp', keyCode: 'Enter', modifiers: [modifier] },
    ])
  }
  assert.deepEqual(nativeKeySequence('Enter', ['control', 'shift']).map((event) => event.type), ['keyDown', 'keyUp'])
})

test('native fixture navigation, Backspace and select-all remain char-free', () => {
  for (const keyCode of ['Tab', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'Backspace', 'Escape', 'A']) {
    assert.deepEqual(nativeKeySequence(keyCode), [
      { type: 'keyDown', keyCode, modifiers: [] },
      { type: 'keyUp', keyCode, modifiers: [] },
    ])
  }
  for (const [keyCode, modifiers] of [['A', ['control']], ['Tab', ['shift']]] as const) {
    assert.deepEqual(nativeKeySequence(keyCode, [...modifiers]), [
      { type: 'keyDown', keyCode, modifiers: [...modifiers] },
      { type: 'keyUp', keyCode, modifiers: [...modifiers] },
    ])
  }
})

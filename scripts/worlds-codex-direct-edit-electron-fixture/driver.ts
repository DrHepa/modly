import assert from 'node:assert/strict'
import { chmod, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { WebContents } from 'electron'

import { nativeKeySequence } from '../worlds-character-electron-fixture/nativeKeyboard.ts'
import {
  RENAMED_ENTITY_NAME,
  SCENE_ID,
  TARGET_ENTITY_ID,
  TARGET_ENTITY_NAME,
  type FixtureRendererView,
} from './shared.ts'

const STEP_TIMEOUT_MS = 12_000

export async function readFixtureView(contents: WebContents): Promise<FixtureRendererView | null> {
  return contents.executeJavaScript("(() => { const text = document.getElementById('worlds-c3-fixture-state')?.textContent; return text ? JSON.parse(text) : null; })()")
}

export async function waitForFixtureView(
  contents: WebContents,
  description: string,
  predicate: (view: FixtureRendererView) => boolean,
): Promise<FixtureRendererView> {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  let last: FixtureRendererView | null = null
  while (Date.now() < deadline) {
    last = await readFixtureView(contents)
    if (last?.error) throw new Error(`${description}: ${last.error}`)
    if (last && predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(last?.controller ?? null)}`)
}

async function sendTrustedKey(contents: WebContents, keyCode: string): Promise<void> {
  const sequence = (await readFixtureView(contents))?.trace.at(-1)?.sequence ?? 0
  for (const event of nativeKeySequence(keyCode)) contents.sendInputEvent(event)
  const expected = keyCode === 'Tab' ? 'Tab' : keyCode
  await waitForFixtureView(contents, `trusted ${keyCode}`, (view) => view.trace.some((entry) => (
    entry.sequence > sequence && entry.type === 'keyup' && entry.trusted && entry.key?.toLowerCase() === expected.toLowerCase()
  )))
}

async function focusedControl(contents: WebContents, label: string) {
  return contents.executeJavaScript(`(() => {
    const matches = [...document.querySelectorAll('button')].filter((element) => element.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (matches.length !== 1) return { count: matches.length, focused: false, visible: false, disabled: true, label: '' };
    const element = matches[0], rectangle = element.getBoundingClientRect(), style = getComputedStyle(element);
    return { count: 1, focused: document.activeElement === element, disabled: element.disabled,
      visible: rectangle.width > 0 && rectangle.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
      label: element.getAttribute('aria-label') ?? '', outline: style.outlineStyle };
  })()`)
}

async function focusByTab(contents: WebContents, label: string): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const control = await focusedControl(contents, label)
    assert.equal(control.count, 1, `Expected one ${label} control.`)
    assert.equal(control.disabled, false, `${label} must be enabled.`)
    if (control.focused) {
      assert.equal(control.visible, true, `${label} must be visible.`)
      assert.equal(control.label, label, `${label} must keep its accessible name.`)
      assert.notEqual(control.outline, 'none', `${label} requires a visible focus style.`)
      return
    }
    await sendTrustedKey(contents, 'Tab')
  }
  throw new Error(`Native Tab could not reach ${label}.`)
}

async function activateByKeyboard(contents: WebContents, label: string): Promise<void> {
  await focusByTab(contents, label)
  await sendTrustedKey(contents, 'Enter')
  await waitForFixtureView(contents, `trusted activation of ${label}`, (view) => view.trace.some((entry) => (
    entry.type === 'click' && entry.trusted && entry.label === label
  )))
}

export function hasEntityName(view: FixtureRendererView, name: string): boolean {
  return view.controller.entityNames.some((entity) => entity.id === TARGET_ENTITY_ID && entity.name === name)
}

export async function waitForInitialEditor(contents: WebContents, baseRevision: number): Promise<FixtureRendererView> {
  const view = await waitForFixtureView(contents, 'initial production Workbench', (candidate) => (
    candidate.page === 'worlds' && candidate.controller.lifecycle === 'ready'
    && candidate.controller.activeSceneId === SCENE_ID
    && candidate.controller.revision === baseRevision && hasEntityName(candidate, TARGET_ENTITY_NAME)
  ))
  assert.deepEqual(view.environment, { sandboxed: true, contextIsolated: true })
  assert.equal(view.requireType, 'undefined')
  assert.equal(view.processType, 'undefined')
  return view
}

export async function waitForAppliedEditor(contents: WebContents, revision: number): Promise<FixtureRendererView> {
  return waitForFixtureView(contents, 'applied production successor', (view) => (
    view.controller.lifecycle === 'ready' && view.controller.activeSceneId === SCENE_ID && view.controller.revision === revision
    && hasEntityName(view, RENAMED_ENTITY_NAME) && view.controller.undo.length === 1
    && view.controller.redo.length === 0 && view.controller.externalCliUndoTransactionId === view.controller.undo[0]
  ))
}

export async function waitForLostReplyReconciliation(contents: WebContents, revision: number): Promise<FixtureRendererView> {
  return waitForFixtureView(contents, 'lost-reply authoritative reconciliation', (view) => (
    view.controller.lifecycle === 'ready' && view.controller.activeSceneId === SCENE_ID && view.controller.revision === revision
    && hasEntityName(view, RENAMED_ENTITY_NAME) && view.controller.undo.length === 0
    && view.controller.redo.length === 0 && view.controller.externalCliUndoTransactionId === null
  ))
}

export async function activateProductionUndo(contents: WebContents): Promise<void> {
  await activateByKeyboard(contents, 'Undo')
}

export async function waitForUndoRestored(contents: WebContents, revision: number): Promise<FixtureRendererView> {
  return waitForFixtureView(contents, 'production Undo restoration', (view) => (
    view.controller.lifecycle === 'ready' && view.controller.activeSceneId === SCENE_ID && view.controller.revision === revision
    && hasEntityName(view, TARGET_ENTITY_NAME) && view.controller.redo.length === 1
    && view.controller.externalCliUndoTransactionId === null
  ))
}

export async function activateLeaveWorlds(contents: WebContents): Promise<void> {
  await activateByKeyboard(contents, 'Leave Worlds')
}

export async function waitForNavigationComplete(contents: WebContents): Promise<FixtureRendererView> {
  return waitForFixtureView(contents, 'navigation-complete', (view) => (
    view.navigationResult === true && view.page === 'generate'
    && view.trace.some((entry) => entry.type === 'navigation' && entry.label === 'navigation-request')
    && view.trace.some((entry) => entry.type === 'navigation' && entry.label === 'navigation-complete')
  ))
}

export async function reloadAndWaitRestored(contents: WebContents, revision: number): Promise<FixtureRendererView> {
  contents.reload()
  return waitForFixtureView(contents, 'reopened production Workbench', (view) => (
    view.controller.lifecycle === 'ready' && view.controller.activeSceneId === SCENE_ID && view.controller.revision === revision
    && hasEntityName(view, TARGET_ENTITY_NAME) && view.controller.undo.length === 0
    && view.controller.redo.length === 0 && view.controller.externalCliUndoTransactionId === null
  ))
}

export async function scanVisibleWorkbench(contents: WebContents, expectedName: string) {
  const scan = await contents.executeJavaScript(`(() => {
    const visible = (element) => { const r = element.getBoundingClientRect(), s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
    const text = [...document.querySelectorAll('body *')].filter(visible).map((element) => element.childElementCount ? '' : element.textContent ?? '').join(' ').replace(/\\s+/g, ' ').trim();
    return { text, dialogs: [...document.querySelectorAll('dialog,[role=dialog]')].filter(visible).length,
      targetNames: [...document.querySelectorAll('.worlds-tree-name')].filter(visible).map((element) => element.textContent?.trim()),
      modal: !!document.querySelector('[aria-modal=true]'), title: document.title };
  })()`)
  assert.equal(scan.dialogs, 0)
  assert.equal(scan.modal, false)
  assert.ok(scan.targetNames.includes(expectedName), `Visible hierarchy is missing ${expectedName}.`)
  assert.doesNotMatch(scan.text, /\b(?:Review|CLI|pairing|terminal)\b/i)
  return scan
}

export async function captureScreenshot(contents: WebContents, evidenceDirectory: string,
  name: 'applied-visible.png' | 'undo-restored.png' | 'reopened.png' | 'failure.png'): Promise<{ path: string; bytes: number }> {
  const image = await contents.capturePage()
  const bytes = image.toPNG()
  assert.ok(bytes.length > 1_024, `Screenshot ${name} is unexpectedly empty.`)
  const filename = path.join(evidenceDirectory, name)
  await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 })
  await chmod(filename, 0o600)
  return { path: filename, bytes: bytes.length }
}

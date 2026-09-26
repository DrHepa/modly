import assert from 'node:assert/strict'
import type { WebContents } from 'electron'
import type { WorldProjectSnapshotV1 } from '../../src/areas/worlds/core/worldModel.ts'
import { nativeKeySequence } from '../worlds-character-electron-fixture/nativeKeyboard.ts'
import { PROMPT, TARGET_NAME, REVIEWED_NAME, type FixtureView } from './shared.ts'

const SELECTORS = {
  toggle: 'button[aria-controls="worlds-ai-content"]',
  prompt: 'textarea[aria-label="Ask Worlds AI"]',
  model: 'button[aria-controls="agent-model-picker"]',
  undo: 'button[aria-label="Undo AI change"]',
  history: '#worlds-ai-content .overflow-y-auto > button.self-start',
} as const
type Control = keyof typeof SELECTORS
export interface PageView extends FixtureView {
  ui: { activeTag: string; activeText: string; activeLabel: string; statusFocused: boolean;
    expanded: boolean; loading: boolean; modelSelectorCount: number; modelPickerCount: number; modelPickerText: string;
    modelPickerBounds: { left: number; right: number; top: number; bottom: number } | null;
    paneCount: number; forbiddenUiCount: number; forbiddenText: boolean;
    viewport: { width: number; height: number; scrollWidth: number; scrollHeight: number };
    tooltips: Array<{ left: number; right: number; top: number; bottom: number }>;
    transcript: Array<{ role: string; content: string; rendered: boolean }>; collapsedHistory: string | null;
    buttons: Array<{ label: string; text: string; disabled: boolean }>; alerts: string[] }
}

export function assertSinglePane(view: PageView): void {
  assert.equal(view.ui.paneCount, 1, 'Worlds AI must have one integrated assistant pane.')
  assert.equal(view.ui.forbiddenUiCount, 0, 'Removed review/CLI controls must not be mounted.')
  assert.equal(view.ui.forbiddenText, false, 'Removed review/CLI copy must not be visible.')
  assert.equal(view.ui.modelSelectorCount, 1, 'Use the existing single compact model selector.')
  assert.ok(view.ui.modelPickerCount <= 1, 'The model menu must not be duplicated.')
}

export async function readView(contents: WebContents): Promise<PageView | null> {
  // Observation only: no functions, controllers or store setters are exposed by the fixture.
  return contents.executeJavaScript(`(() => {
    const raw = document.getElementById('worlds-ai-fixture-state')?.textContent;
    if (!raw) return null;
    const active = document.activeElement;
    const picker = document.getElementById('agent-model-picker');
    const rectangle = (element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
    const assistant = document.querySelector('.worlds-ai-drawer');
    return { ...JSON.parse(raw), ui: {
      activeTag: active?.tagName ?? '', activeText: active?.textContent?.trim() ?? '', activeLabel: active?.getAttribute('aria-label') ?? '',
      statusFocused: active === document.querySelector('.worlds-ai-drawer__status'),
      expanded: document.querySelector('[aria-controls="worlds-ai-content"]')?.getAttribute('aria-expanded') === 'true',
      loading: !!document.querySelector('[aria-label="Cancel Worlds AI request"]'),
      paneCount: document.querySelectorAll('.worlds-ai-drawer__content').length,
      modelSelectorCount: document.querySelectorAll(${JSON.stringify(SELECTORS.model)}).length,
      modelPickerCount: document.querySelectorAll('#agent-model-picker').length,
      modelPickerText: picker?.innerText ?? '', modelPickerBounds: picker ? rectangle(picker) : null,
      forbiddenUiCount: document.querySelectorAll('.worlds-ai-drawer__review, [aria-label="Apply Worlds proposal"], [aria-label="Reject Worlds proposal"], [aria-label="Local CLI access"]').length,
      forbiddenText: /Local CLI access|External CLI proposals|Proposed changes appear here|Start CLI pairing/.test(assistant?.innerText ?? ''),
      viewport: { width: typeof window === 'undefined' ? 0 : window.innerWidth, height: typeof window === 'undefined' ? 0 : window.innerHeight,
        scrollWidth: document.documentElement?.scrollWidth ?? 0, scrollHeight: document.documentElement?.scrollHeight ?? 0 },
      tooltips: [...document.querySelectorAll('[role="tooltip"]')].map(rectangle),
      collapsedHistory: document.querySelector(${JSON.stringify(SELECTORS.history)})?.textContent?.trim() ?? null,
      transcript: [...document.querySelectorAll('#worlds-ai-content .px-4.py-3.gap-5 > div')].flatMap(item => {
        const user = item.querySelector('.items-end > .rounded-br-sm');
        const prose = user ?? item.querySelector('.gap-3 > .leading-relaxed');
        if (!prose) return [];
        const rect = prose.getBoundingClientRect();
        return [{ role: user ? 'user' : 'assistant', content: prose.innerText,
          rendered: rect.width > 0 && rect.height > 0 && prose.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) }];
      }),
      buttons: [...document.querySelectorAll('button')].map(item => ({ label: item.getAttribute('aria-label') ?? '', text: item.textContent?.trim() ?? '', disabled: item.disabled })),
      alerts: [...document.querySelectorAll('[role="alert"]')].map(item => item.textContent?.trim() ?? '')
    }};
  })()`)
}

async function locate(contents: WebContents, control: Control) {
  return contents.executeJavaScript(`(() => {
    const matches = document.querySelectorAll(${JSON.stringify(SELECTORS[control])});
    if (matches.length !== 1) throw new Error('Expected one native fixture control');
    const element = matches[0];
    const rect = element.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
    const style = getComputedStyle(element);
    return { focused: document.activeElement === element, disabled: !!element.disabled,
      label: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '', value: element.value ?? null,
      visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden',
      obscured: !element.contains(document.elementFromPoint(x,y)), width: rect.width, height: rect.height,
      outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  })()`) as Promise<{ focused: boolean; disabled: boolean; label: string; value: string | null; visible: boolean; obscured: boolean; width: number; height: number; outlineStyle: string; outlineWidth: string }>
}

async function wait(contents: WebContents, name: string, predicate: (view: PageView) => boolean): Promise<PageView> {
  const deadline = Date.now() + 8_000
  let last: PageView | null = null
  while (Date.now() < deadline) {
    last = await readView(contents)
    if (last?.error || last?.ui.alerts.length) throw new Error(`${name}: ${last.error ?? last.ui.alerts.join('; ')}`)
    if (last && predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Native fixture step timed out: ${name}; AI=${last?.ai.status}, revision=${last?.snapshot?.project.revision}`)
}

async function key(contents: WebContents, keyCode: string): Promise<void> {
  const sequence = (await readView(contents))?.trace.at(-1)?.sequence ?? 0
  for (const event of nativeKeySequence(keyCode)) contents.sendInputEvent(event)
  await wait(contents, `trusted ${keyCode} acknowledgement`, (view) => view.trace.some((entry) => entry.sequence > sequence && entry.type === 'keyup' && entry.trusted && entry.key === keyCode))
}

async function focusByTab(contents: WebContents, control: Control): Promise<Awaited<ReturnType<typeof locate>>> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const current = await locate(contents, control)
    assert.equal(current.disabled, false, `${control} must be enabled`)
    if (current.focused) {
      assert.ok(current.visible && !current.obscured, `${control} must be visibly focused and unobscured`)
      assert.ok(current.label.length > 0, `${control} must have an accessible control name`)
      assert.notEqual(current.outlineStyle, 'none', `${control} requires visible focus`)
      return current
    }
    await key(contents, 'Tab')
  }
  throw new Error(`Native Tab could not reach ${control}`)
}

export function assertNameDelta(actual: WorldProjectSnapshotV1, before: WorldProjectSnapshotV1, targetId: string, name: string): void {
  const expected = structuredClone(before)
  expected.project.revision += 1
  const target = expected.scenes.flatMap((scene) => scene.entities).find((entity) => entity.id === targetId)
  assert.ok(target); assert.notEqual(target.name, name)
  target.name = name
  assert.deepEqual(actual, expected, 'A revision increment is insufficient: require the exact complete canonical delta.')
}

/** DOM evidence is independent from the hidden session-store observation. */
export function hasRenderedTranscript(view: PageView | null, expected: ReadonlyArray<{ role: string; content: string }>): boolean {
  return !!view && view.ui.transcript.length === expected.length && view.ui.transcript.every((message, index) =>
    message.rendered && message.role === expected[index].role && message.content === expected[index].content)
}

export async function waitForTranscript(contents: WebContents, messages: FixtureView['messages'], activate: (control: Control) => Promise<void>): Promise<PageView> {
  // ChatPanel intentionally collapses history after four messages. Expand through
  // its real keyboard control only after its local transcript has hydrated.
  const view = await wait(contents, 'rendered chat hydration', (candidate) => hasRenderedTranscript(candidate, messages)
    || (messages.length > 4 && candidate.ui.collapsedHistory === `${messages.length - 4} previous messages`
      && hasRenderedTranscript(candidate, messages.slice(-4))))
  if (view.ui.collapsedHistory) await activate('history')
  return wait(contents, 'complete rendered transcript', (candidate) => !candidate.ui.collapsedHistory && hasRenderedTranscript(candidate, messages))
}

export async function runAiInteractions(contents: WebContents,
  checkpoint: (name: string, view: PageView) => Promise<void>,
  screenshot: (name: string) => Promise<void>,
) {
  const focusedControls: Array<{ control: Control; evidence: Awaited<ReturnType<typeof locate>> }> = []
  const activate = async (control: Control) => { focusedControls.push({ control, evidence: await focusByTab(contents, control) }); await key(contents, 'Enter') }
  let view = await wait(contents, 'initial World', (candidate) => !candidate.initializing && !!candidate.snapshot)
  assert.deepEqual(view.environment, { sandboxed: true, contextIsolated: true })
  assert.equal(view.requireType, 'undefined'); assert.equal(view.processType, 'undefined')
  const initial = structuredClone(view.snapshot!)
  const target = initial.scenes.flatMap((scene) => scene.entities).find((entity) => entity.name === TARGET_NAME)
  assert.ok(target)
  await checkpoint('initial', view)
  await activate('toggle')
  view = await wait(contents, 'chat session hydration', (candidate) => candidate.ui.expanded && candidate.sessionInitialized && !!candidate.sessionId)
  assertSinglePane(view)
  assert.equal(view.messages.length, 0)
  const sessionId = view.sessionId

  await activate('model')
  view = await wait(contents, 'single compact model menu', (candidate) => candidate.ui.modelPickerCount === 1
    && candidate.ui.modelPickerText.includes('Ollama · worlds-fixture-stub'))
  assertSinglePane(view)
  assert.match(view.ui.modelPickerText, /OpenAI/)
  assert.doesNotMatch(view.ui.modelPickerText, /Ollama models unavailable|Checking local models/)
  assert.ok(view.ui.modelPickerBounds)
  assert.ok(view.ui.modelPickerBounds!.left >= 0 && view.ui.modelPickerBounds!.right <= view.ui.viewport.width,
    'The model menu must remain inside the viewport.')
  await checkpoint('model-menu', view); await screenshot('model-menu')
  await key(contents, 'Escape')
  view = await wait(contents, 'closed model menu', (candidate) => candidate.ui.modelPickerCount === 0)

  const edit = async (number: number, before: WorldProjectSnapshotV1) => {
    focusedControls.push({ control: 'prompt', evidence: await focusByTab(contents, 'prompt') })
    assert.equal((await locate(contents, 'prompt')).value, '')
    const sequence = (await readView(contents))!.trace.at(-1)?.sequence ?? 0
    await contents.insertText(PROMPT)
    await wait(contents, 'trusted prompt input', (candidate) => candidate.trace.some((entry) => entry.sequence > sequence && entry.type === 'input' && entry.trusted && entry.label === 'Ask Worlds AI'))
    assert.equal((await locate(contents, 'prompt')).value, PROMPT)
    await key(contents, 'Enter')
    const result = await wait(contents, `direct edit ${number}`, (candidate) => candidate.ai.status === 'applied' && !candidate.ui.loading && candidate.messages.length === number * 2)
    assertSinglePane(result)
    assertNameDelta(result.snapshot!, before, target.id, REVIEWED_NAME)
    assert.equal((await locate(contents, 'undo')).disabled, false)
    await checkpoint(`applied-${number}`, result)
    await screenshot(`applied-${number}`)
    return result
  }

  view = await edit(1, initial)
  const firstApplied = structuredClone(view.snapshot!)
  await activate('undo')
  view = await wait(contents, 'canonical Undo', (candidate) => candidate.ai.status === 'idle' && candidate.snapshot?.project.revision === initial.project.revision + 2)
  assertNameDelta(view.snapshot!, firstApplied, target.id, TARGET_NAME)
  const undone = structuredClone(view.snapshot!)
  await checkpoint('undone-1', view)

  view = await edit(2, undone)
  const secondApplied = structuredClone(view.snapshot!)
  await activate('undo')
  view = await wait(contents, 'second canonical Undo', (candidate) => candidate.ai.status === 'idle' && candidate.snapshot?.project.revision === undone.project.revision + 2)
  assertNameDelta(view.snapshot!, secondApplied, target.id, TARGET_NAME)
  const secondUndone = structuredClone(view.snapshot!)
  await checkpoint('undone-2', view)

  view = await edit(3, secondUndone)
  const retained = structuredClone(view.snapshot!)
  const messages = structuredClone(view.messages)
  assert.deepEqual(messages.map(({ role, content }) => ({ role, content })), Array.from({ length: 3 }, () => [
    { role: 'user', content: PROMPT },
    { role: 'assistant', content: 'Changes applied. Undo is available.' },
  ]).flat())
  view = await waitForTranscript(contents, messages, activate)
  const oldBoot = view.bootId
  assert.equal(view.untrusted, 0)
  const beforeReloadTrace = view.trace
  contents.reload()
  await wait(contents, 'fresh renderer and reopened World', (candidate) => candidate.bootId !== oldBoot && !candidate.initializing && !!candidate.snapshot)
  await activate('toggle')
  view = await wait(contents, 'reopened chat hydration', (candidate) => candidate.sessionInitialized && candidate.sessionId === sessionId && candidate.messages.length === messages.length)
  view = await waitForTranscript(contents, messages, activate)
  assertSinglePane(view)
  assert.deepEqual(view.snapshot, retained); assert.deepEqual(view.messages, messages)
  assert.equal(view.ai.status, 'idle')
  assert.equal(view.untrusted, 0)
  await checkpoint('reopened', view); await screenshot('reopened')
  return { finalView: view, beforeReloadTrace, focusedControls, targetId: target.id, sessionId,
    inputEvidence: 'trusted-native-keyboard-and-insertText', accessibility: 'focus/control observations only; no screen-reader or global WCAG verdict',
    knownInheritedGap: 'Screen-reader behavior remains untested; this fixture proves keyboard focus only.' }
}

/** Keep evidence from distinct UI states distinct; the picker hides a focus tooltip. */
export function responsiveEvidence(mode: string,
  tooltipView: Pick<PageView, 'ui'>, modelView: Pick<PageView, 'ui'>) {
  return { mode, viewport: modelView.ui.viewport, picker: modelView.ui.modelPickerBounds,
    tooltips: tooltipView.ui.tooltips }
}

export async function runResponsiveChecks(contents: WebContents,
  configure: (width: number, height: number, zoom: number) => Promise<void>,
  checkpoint: (name: string, view: PageView) => Promise<void>,
  screenshot: (name: string) => Promise<void>,
): Promise<Array<{ mode: string; viewport: PageView['ui']['viewport']; picker: PageView['ui']['modelPickerBounds']; tooltips: PageView['ui']['tooltips'] }>> {
  const result = []
  for (const mode of [{ name: 'minimum-window', width: 800, height: 600, zoom: 1 },
    { name: 'zoom-200', width: 1024, height: 768, zoom: 2 }]) {
    await configure(mode.width, mode.height, mode.zoom)
    let view = await wait(contents, `${mode.name} viewport`, (candidate) => candidate.ui.viewport.width > 0 && candidate.ui.viewport.width <= mode.width / mode.zoom)
    assertSinglePane(view)
    assert.ok(view.ui.viewport.scrollWidth <= view.ui.viewport.width + 1, `${mode.name} must not create horizontal page overflow.`)
    await focusByTab(contents, 'toggle')
    view = await wait(contents, `${mode.name} keyboard tooltip`, (candidate) => candidate.ui.tooltips.length > 0)
    for (const tip of view.ui.tooltips) {
      assert.ok(tip.left >= -1 && tip.right <= view.ui.viewport.width + 1 && tip.top >= -1 && tip.bottom <= view.ui.viewport.height + 1,
        `${mode.name} keyboard tooltip must fit the viewport.`)
    }
    const tooltipView = view
    await checkpoint(`${mode.name}-tooltip`, view); await screenshot(`${mode.name}-tooltip`)
    await focusByTab(contents, 'model'); await key(contents, 'Enter')
    view = await wait(contents, `${mode.name} model menu`, (candidate) => candidate.ui.modelPickerCount === 1
      && candidate.ui.modelPickerText.includes('Ollama · worlds-fixture-stub'))
    assertSinglePane(view)
    assert.ok(view.ui.modelPickerBounds)
    assert.ok(view.ui.modelPickerBounds!.left >= -1 && view.ui.modelPickerBounds!.right <= view.ui.viewport.width + 1
      && view.ui.modelPickerBounds!.top >= -1 && view.ui.modelPickerBounds!.bottom <= view.ui.viewport.height + 1,
    `${mode.name} model menu must fit the viewport.`)
    await checkpoint(`${mode.name}-model`, view); await screenshot(`${mode.name}-model`)
    result.push(responsiveEvidence(mode.name, tooltipView, view))
    await key(contents, 'Escape')
    await wait(contents, `${mode.name} close menu`, (candidate) => candidate.ui.modelPickerCount === 0)
  }
  return result
}

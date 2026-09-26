import assert from 'node:assert/strict'
import type { KeyboardInputEvent, WebContents } from 'electron'
import type { WorldProjectSnapshotV1 } from '../../src/areas/worlds/core/worldModel.ts'
import { describeFixtureControl } from './domEvidence.ts'
import { nativeKeySequence } from './nativeKeyboard.ts'
import { FIXTURE_PROJECT_KEY, FIXTURE_TARGET_NAME, type FixtureCheckpoint, type FixtureLocator, type FixtureView } from './shared.ts'

const STEP_TIMEOUT_MS = 8_000

/** This function is serialized into the page. It only locates, scrolls and reads DOM nodes. */
function locateInPage(locator: FixtureLocator | null, scroll: boolean, describe: typeof describeFixtureControl, includeCandidates: boolean) {
  const text = (element: Element | null) => element?.textContent?.trim() ?? ''
  let matches: Element[] = []
  if (!locator) {
    matches = document.activeElement ? [document.activeElement] : []
  } else if (locator.kind === 'button') {
    matches = [...document.querySelectorAll('button')].filter((item) => item.getAttribute('aria-label') === locator.label)
  } else if (locator.kind === 'summary') {
    matches = [...document.querySelectorAll('summary')].filter((item) => text(item) === locator.text)
  } else {
    let scope: Element | undefined = [...document.querySelectorAll('section.worlds-inspector-section')]
      .find((item) => text(item.querySelector(':scope > .worlds-inspector-section__heading > h3')) === locator.section)
    if (locator.legend) scope = [...(scope?.querySelectorAll('fieldset') ?? [])]
      .find((item) => text(item.querySelector(':scope > legend')) === locator.legend)
    if (locator.binding !== undefined) scope = [...(scope?.querySelectorAll('fieldset') ?? [])]
      .find((item) => text(item.querySelector(':scope > legend')).startsWith(`Binding ${locator.binding} · `))
    matches = [...(scope?.querySelectorAll('label') ?? [])].flatMap((label) => {
      const span = label.querySelector(':scope > span')
      const name = [...(span?.childNodes ?? [])].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join('').trim()
      return name === locator.label && label.control ? [label.control] : []
    })
  }
  if (matches.length !== 1) throw new Error(`Expected exactly one fixture control, found ${matches.length}: ${JSON.stringify(locator)}`)
  const element = matches[0]
  if (!(element instanceof HTMLElement)) throw new Error('Fixture control is not an HTML element.')
  if (scroll) element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
  const rectangle = element.getBoundingClientRect()
  const x = Math.round(rectangle.left + rectangle.width / 2)
  const y = Math.round(rectangle.top + rectangle.height / 2)
  let withinClosedDetails = false
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement && !parent.open && !parent.querySelector(':scope > summary')?.contains(element)) withinClosedDetails = true
  }
  const trapRoot = element.closest('.character-fixture__inspector')
  // Mirrors the production helper's selector for diagnostics only; nothing is focused or filtered here.
  const candidates = includeCandidates && trapRoot ? [...trapRoot.querySelectorAll<HTMLElement>([
    'button:not(:disabled)', 'select:not(:disabled)', 'input:not(:disabled)', 'textarea:not(:disabled)',
    'a[href]', 'summary:not([tabindex="-1"])', '[tabindex]:not([tabindex="-1"])',
  ].join(','))] : []
  const focusCandidates = includeCandidates ? {
    root: describe(trapRoot), total: candidates.length, truncated: candidates.length > 128,
    active: describe(document.activeElement),
    candidates: candidates.slice(0, 128).map((candidate) => {
      const closedDetailsAncestors = []
      for (let parent = candidate.parentElement; parent; parent = parent.parentElement) {
        if (parent instanceof HTMLDetailsElement && !parent.open) {
          const firstSummary = parent.querySelector(':scope > summary')
          closedDetailsAncestors.push({
            summary: describe(firstSummary), directChild: candidate.parentElement === parent,
            isFirstSummary: candidate === firstSummary, withinFirstSummary: firstSummary?.contains(candidate) ?? false,
          })
        }
      }
      const style = getComputedStyle(candidate)
      return {
        control: describe(candidate), active: document.activeElement === candidate,
        rectCount: candidate.getClientRects().length,
        isFirstDirectSummary: candidate.tagName === 'SUMMARY' && candidate.parentElement instanceof HTMLDetailsElement
          && candidate.parentElement.querySelector(':scope > summary') === candidate,
        closedDetailsAncestors, computedVisibility: style.visibility, computedDisplay: style.display,
        computedContentVisibility: style.contentVisibility,
        checkVisibility: typeof candidate.checkVisibility === 'function' ? candidate.checkVisibility() : null,
      }
    }),
  } : null
  return {
    x, y, tagName: element.tagName, focused: document.activeElement === element,
    disabled: 'disabled' in element && !!element.disabled,
    visible: !withinClosedDetails && rectangle.width > 0 && rectangle.height > 0,
    obscured: !element.contains(document.elementFromPoint(x, y)),
    withinClosedDetails,
    detailsOpen: element.tagName === 'SUMMARY' && element.parentElement instanceof HTMLDetailsElement ? element.parentElement.open : null,
    control: describe(element), active: describe(document.activeElement),
    focusCandidates,
    value: element instanceof HTMLInputElement || element instanceof HTMLSelectElement ? element.value : null,
    options: element instanceof HTMLSelectElement ? [...element.options].map((option) => option.value) : null,
  }
}

async function locate(contents: WebContents, locator: FixtureLocator | null, scroll = false, includeCandidates = false): Promise<ReturnType<typeof locateInPage>> {
  return contents.executeJavaScript(`(${locateInPage.toString()})(${JSON.stringify(locator)}, ${scroll}, ${describeFixtureControl.toString()}, ${includeCandidates})`)
}

export const readFocusedControl = (contents: WebContents) => locate(contents, null)

export async function readFixtureView(contents: WebContents): Promise<FixtureView | null> {
  // No controller, setter or React instance is available through this read-only DOM output.
  return contents.executeJavaScript("(() => { const value = document.getElementById('fixture-state')?.textContent; return value ? JSON.parse(value) : null; })()")
}

async function waitForView(contents: WebContents, description: string, predicate: (view: FixtureView) => boolean): Promise<FixtureView> {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  let last: FixtureView | null = null
  while (Date.now() < deadline) {
    last = await readFixtureView(contents)
    if (last?.error) throw new Error(`${description}: ${last.error}`)
    if (last && predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error(`Timed out waiting for ${description}; last lifecycle=${last?.lifecycle}, revision=${last?.savedRevision}.`)
}

async function key(contents: WebContents, keyCode: string, modifiers: KeyboardInputEvent['modifiers'] = []): Promise<void> {
  const before = await readFixtureView(contents)
  const sequence = before?.trace.at(-1)?.sequence ?? 0
  for (const event of nativeKeySequence(keyCode, modifiers)) contents.sendInputEvent(event)
  const expectedKey = ({ Down: 'ArrowDown', Up: 'ArrowUp' } as Record<string, string>)[keyCode] ?? keyCode
  await waitForView(contents, `trusted native ${keyCode} key acknowledgement`, (view) => view.trace.some((event) => event.sequence > sequence && event.type === 'keyup' && event.trusted && event.key?.toLowerCase() === expectedKey.toLowerCase()))
}

async function waitForControl(contents: WebContents, locator: FixtureLocator, description: string, predicate: (control: ReturnType<typeof locateInPage>) => boolean) {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  let control = await locate(contents, locator)
  while (Date.now() < deadline) {
    if (predicate(control)) return control
    await new Promise((resolve) => setTimeout(resolve, 30))
    control = await locate(contents, locator)
  }
  throw new Error(`${description}: ${JSON.stringify({ locator, control })}`)
}

async function focusByTab(contents: WebContents, locator: FixtureLocator): Promise<void> {
  // A native Tab focuses a CLOSED select; no popup click or page focus setter is used.
  const deadline = Date.now() + STEP_TIMEOUT_MS
  for (let count = 0; count < 128 && Date.now() < deadline; count += 1) {
    if ((await locate(contents, locator)).focused) return
    await key(contents, 'Tab')
    const active = await readFocusedControl(contents)
    assert.equal(active.withinClosedDetails, false, `Tab must not enter closed details: ${JSON.stringify(active)}`)
  }
  throw new Error(`Native Tab did not reach ${JSON.stringify(locator)}; active=${JSON.stringify(await readFocusedControl(contents))}`)
}

async function verifyEnterActivation(contents: WebContents, locator: FixtureLocator, cancelled = false): Promise<void> {
  const target = await locate(contents, locator)
  assert.equal(target.focused, true, 'Enter activation requires native focus on the exact control.')
  const before = await readFixtureView(contents)
  const sequence = before?.trace.at(-1)?.sequence ?? 0
  await key(contents, 'Enter')
  const after = await readFixtureView(contents)
  assert.ok(after)
  const events = after.trace.filter((event) => event.sequence > sequence && event.target?.tagName === target.tagName && event.target?.label === target.control?.label)
  const keyboard = events.filter((event) => ['keydown', 'keypress', 'keyup'].includes(event.type))
  assert.deepEqual(keyboard.map((event) => event.type), cancelled ? ['keydown', 'keyup'] : ['keydown', 'keypress', 'keyup'], JSON.stringify(events))
  assert.ok(events.every((event) => event.trusted), 'Enter evidence must contain only trusted native events.')
  assert.equal(events.filter((event) => event.type === 'click').length, cancelled ? 0 : 1, 'Enter must activate exactly once unless keydown was cancelled.')
  if (cancelled) {
    assert.equal(keyboard[0].defaultPrevented, true, 'Capture must report preventDefault after React propagation.')
    assert.equal(after.cancelledEnterClicks, 0, 'Cancelled keydown must suppress char activation before keyUp.')
  } else {
    assert.equal(keyboard[1].key, 'Enter')
    assert.equal(keyboard[1].charCode, 13, 'Native Enter activation must use the browser keypress contract.')
  }
}

async function click(contents: WebContents, locator: FixtureLocator): Promise<void> {
  const { x, y, visible, disabled, obscured } = await locate(contents, locator, true)
  assert.ok(visible && !disabled && !obscured, `Native pointer target must be visible and enabled: ${JSON.stringify(locator)}`)
  contents.sendInputEvent({ type: 'mouseMove', x, y })
  contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
}

async function replaceField(contents: WebContents, locator: FixtureLocator, value: string): Promise<void> {
  await click(contents, locator)
  await waitForControl(contents, locator, 'Native pointer did not focus field', (control) => control.focused)
  await key(contents, 'A', ['control'])
  await key(contents, 'Backspace')
  await waitForControl(contents, locator, 'Native clear did not empty focused field', (control) => control.focused && control.value === '')
  await contents.insertText(value)
  await waitForControl(contents, locator, 'Native insertion did not produce exact requested value', (control) => control.focused && control.value === value)
  // Production NumericCommitField/TextCommitField commit on blur; Enter performs that blur.
  await key(contents, 'Enter')
}

async function selectValue(contents: WebContents, locator: FixtureLocator, value: string): Promise<void> {
  await focusByTab(contents, locator)
  const control = await waitForControl(contents, locator, 'Native Tab did not focus select', (candidate) => candidate.focused)
  assert.ok(control.options)
  const current = control.options.indexOf(control.value ?? '')
  const desired = control.options.indexOf(value)
  assert.ok(current >= 0 && desired >= 0, 'Native select must contain the current and desired values.')
  assert.notEqual(current, desired, 'Fixture select must exercise a real change.')
  assert.equal(Math.abs(desired - current), 1, 'This bounded scenario must perform one select change per canonical transaction.')
  await key(contents, desired > current ? 'Down' : 'Up')
  await waitForControl(contents, locator, 'Closed native select did not acknowledge requested value', (candidate) => candidate.focused && candidate.value === value)
}

function snapshotOf(view: FixtureView): WorldProjectSnapshotV1 {
  assert.ok(view.snapshot, 'Canonical editor snapshot must exist.')
  return view.snapshot
}

function targetOf(snapshot: WorldProjectSnapshotV1) {
  const target = snapshot.scenes.flatMap((scene) => scene.entities).find((entity) => entity.name === FIXTURE_TARGET_NAME)
  assert.ok(target, 'Fixture target must exist.')
  return target
}

function characterOf(snapshot: WorldProjectSnapshotV1) {
  const character = targetOf(snapshot).components.find((component) => component.type === 'character-controller')
  assert.ok(character)
  return character
}

function capsuleOf(snapshot: WorldProjectSnapshotV1) {
  const collider = targetOf(snapshot).components.find((component) => component.id === characterOf(snapshot).colliderComponentId)
  assert.ok(collider?.type === 'collider' && collider.shape === 'capsule')
  return collider
}

function assertContentEqual(actual: WorldProjectSnapshotV1, expected: WorldProjectSnapshotV1): void {
  const compared = structuredClone(expected)
  compared.project.revision = actual.project.revision
  assert.deepEqual(actual, compared)
}

export function assertFixtureSnapshotDelta(actual: WorldProjectSnapshotV1, before: WorldProjectSnapshotV1, edit: (expected: WorldProjectSnapshotV1) => void): void {
  const expected = structuredClone(before)
  expected.project.revision += 1
  edit(expected)
  assert.deepEqual(actual, expected, 'Each native operation must commit exactly its requested complete snapshot delta.')
}

export async function runCharacterInteractions(
  contents: WebContents,
  checkpoint: (entry: FixtureCheckpoint) => Promise<void>,
  diagnostic: (name: string, evidence: ReturnType<typeof locateInPage>) => Promise<void>,
): Promise<{ finalView: FixtureView; nativeInputs: FixtureView['inputs'] }> {
  let view = await waitForView(contents, 'initial project open', (candidate) => !candidate.initializing && candidate.lifecycle === 'ready' && candidate.snapshot !== null)
  assert.deepEqual(view.environment, { sandboxed: true, contextIsolated: true })
  assert.equal(view.requireType, 'undefined')
  assert.equal(view.processType, 'undefined')
  assert.equal(view.projectKey, FIXTURE_PROJECT_KEY)
  assert.equal(targetOf(snapshotOf(view)).components.length, 0, 'Only an empty entity may be seeded.')
  assert.equal(snapshotOf(view).project.inputActions.length, 0, 'Character inputs must be created by the UI.')
  assert.equal(view.canUndo, false)

  const record = async (name: string) => {
    const latest = await readFixtureView(contents)
    assert.ok(latest)
    view = latest
    const snapshot = snapshotOf(view)
    assert.equal(view.savedRevision, snapshot.project.revision)
    await checkpoint({ name, revision: snapshot.project.revision, bootId: view.bootId, inputs: view.inputs,
      environment: view.environment, requireType: view.requireType, processType: view.processType,
      cancelledEnterClicks: view.cancelledEnterClicks, trace: view.trace, snapshot })
  }
  const mutate = async (name: string, interaction: () => Promise<void>, edit: (expected: WorldProjectSnapshotV1) => void) => {
    const before = structuredClone(snapshotOf(view))
    await interaction()
    view = await waitForView(contents, name, (candidate) => candidate.lifecycle === 'ready' && candidate.savedRevision !== null && candidate.savedRevision > before.project.revision)
    assertFixtureSnapshotDelta(snapshotOf(view), before, edit)
    await record(name)
  }
  await record('empty-target-opened')
  const untouched = structuredClone(snapshotOf(view))
  const cancellationProbe: FixtureLocator = { kind: 'button', label: 'Cancelled Enter probe' }
  await focusByTab(contents, cancellationProbe)
  await verifyEnterActivation(contents, cancellationProbe, true)
  await record('native-enter-cancelled-without-click')
  assert.deepEqual(snapshotOf(view), untouched, 'Fixture-owned cancellation must not edit the World document.')
  const summary: FixtureLocator = { kind: 'summary', text: 'Character' }
  const presetMove: FixtureLocator = { kind: 'field', section: 'Add component', label: 'Move input' }
  const presetJump: FixtureLocator = { kind: 'field', section: 'Add component', label: 'Jump input' }
  assert.equal((await locate(contents, summary)).detailsOpen, false)
  assert.equal((await locate(contents, presetMove)).visible, false)
  await focusByTab(contents, summary)
  await key(contents, 'Tab')
  await diagnostic('after-tab-from-closed-character-summary', await locate(contents, null, false, true))
  assert.equal((await readFocusedControl(contents)).withinClosedDetails, false)
  assert.equal((await locate(contents, presetMove)).focused, false)
  await key(contents, 'Tab', ['shift'])
  assert.equal((await locate(contents, summary)).focused, true, 'Reverse Tab must return to the native Character summary.')
  await record('overlay-helper-closed-summary-reachable-descendants-skipped')
  await verifyEnterActivation(contents, summary)
  await waitForControl(contents, summary, 'Native Enter did not open Character disclosure', (control) => control.detailsOpen === true)
  await record('native-enter-opens-character-once')
  await verifyEnterActivation(contents, summary)
  await waitForControl(contents, summary, 'Second native Enter did not close Character disclosure', (control) => control.detailsOpen === false)
  assert.equal((await locate(contents, presetMove)).visible, false)
  await record('native-enter-closes-character-once')
  await verifyEnterActivation(contents, summary)
  await waitForControl(contents, summary, 'Third native Enter did not reopen Character disclosure', (control) => control.detailsOpen === true)
  await key(contents, 'Tab')
  assert.equal((await locate(contents, presetMove)).focused, true, 'Opened Move input must be next in Tab order.')
  await key(contents, 'Tab')
  assert.equal((await locate(contents, presetJump)).focused, true, 'Opened Jump input must be reachable.')
  await key(contents, 'Tab')
  assert.equal((await locate(contents, { kind: 'button', label: 'Add Character' })).focused, true)
  await record('overlay-helper-enter-opens-character-fields-reachable')
  assert.deepEqual(snapshotOf(view), untouched, 'Disclosure activation must not edit the World document.')
  const empty = structuredClone(snapshotOf(view))
  await key(contents, 'Enter')
  view = await waitForView(contents, 'character-created-through-ui', (candidate) => candidate.lifecycle === 'ready' && candidate.savedRevision === empty.project.revision + 1)
  const added = structuredClone(snapshotOf(view))
  assert.equal(targetOf(added).components.length, 3)
  assert.equal(targetOf(added).components.find((component) => component.type === 'rigid-body')?.bodyType, 'kinematic-position')
  assert.equal(capsuleOf(added).radius, 0.35)
  assert.equal(capsuleOf(added).halfHeight, 0.55)
  assert.equal(characterOf(added).speed, 4)
  const movement = added.project.inputActions.find((action) => action.id === characterOf(added).moveActionId)
  assert.ok(movement?.valueType === 'axis2d')
  assert.equal(movement.bindings.length, 4)
  assert.ok(characterOf(added).jumpActionId)
  assertFixtureSnapshotDelta(added, empty, (expected) => {
    // New IDs are generated by the production UI; only these validated additions may differ.
    targetOf(expected).components = structuredClone(targetOf(added).components)
    expected.project.inputActions = structuredClone(added.project.inputActions)
  })
  assert.deepEqual(movement.bindings, [
    { kind: 'axis2d', device: 'keyboard', control: 'KeyA', targetAxis: 'x', scale: -1 },
    { kind: 'axis2d', device: 'keyboard', control: 'KeyD', targetAxis: 'x', scale: 1 },
    { kind: 'axis2d', device: 'keyboard', control: 'KeyW', targetAxis: 'y', scale: 1 },
    { kind: 'axis2d', device: 'keyboard', control: 'KeyS', targetAxis: 'y', scale: -1 },
  ])
  assert.equal(added.project.inputActions.length, 2)
  assert.deepEqual(added.project.inputActions.find((action) => action.id === characterOf(added).jumpActionId)?.bindings, [{ kind: 'button', device: 'keyboard', control: 'Space' }])
  await record('character-created-through-ui')
  const movementField = (label: string): FixtureLocator => ({ kind: 'field', section: 'Project inputs', legend: `${movement.name} · 2D axis`, binding: 1, label })
  const componentField = (section: string, label: string): FixtureLocator => ({ kind: 'field', section, label })

  const firstMovementBinding = (snapshot: WorldProjectSnapshotV1) => {
    const binding = snapshot.project.inputActions.find((action) => action.id === movement.id)?.bindings[0]
    assert.ok(binding?.kind === 'axis2d')
    return binding
  }
  await mutate('movement-key-edited', () => replaceField(contents, movementField('Keyboard code'), 'KeyJ'), (expected) => { firstMovementBinding(expected).control = 'KeyJ' })
  await mutate('movement-axis-edited', () => selectValue(contents, movementField('Target axis'), 'y'), (expected) => { firstMovementBinding(expected).targetAxis = 'y' })
  await mutate('movement-scale-edited', () => replaceField(contents, movementField('Scale'), '-0.5'), (expected) => { firstMovementBinding(expected).scale = -0.5 })
  await mutate('character-speed-edited', () => replaceField(contents, componentField('Character controller', 'Speed'), '6.5'), (expected) => { characterOf(expected).speed = 6.5 })
  await mutate('capsule-radius-edited', () => replaceField(contents, componentField('Collider', 'Radius'), '0.45'), (expected) => { capsuleOf(expected).radius = 0.45 })
  await mutate('capsule-half-height-edited', () => replaceField(contents, componentField('Collider', 'Half height'), '0.65'), (expected) => { capsuleOf(expected).halfHeight = 0.65 })

  const expected = structuredClone(added)
  const expectedMovement = expected.project.inputActions.find((action) => action.id === movement.id)!
  const firstBinding = expectedMovement.bindings[0]
  assert.ok(firstBinding.kind === 'axis2d')
  expectedMovement.bindings[0] = { ...firstBinding, control: 'KeyJ', targetAxis: 'y', scale: -0.5 }
  characterOf(expected).speed = 6.5
  capsuleOf(expected).radius = 0.45
  capsuleOf(expected).halfHeight = 0.65
  assertContentEqual(snapshotOf(view), expected)
  const beforeClear = structuredClone(snapshotOf(view))
  await mutate('jump-cleared-to-none', () => selectValue(contents, componentField('Character controller', 'Jump input'), ''), (expected) => { delete characterOf(expected).jumpActionId })
  assert.equal(Object.hasOwn(characterOf(snapshotOf(view)), 'jumpActionId'), false)
  delete characterOf(expected).jumpActionId
  assertContentEqual(snapshotOf(view), expected)
  await mutate('toolbar-undo', () => click(contents, { kind: 'button', label: 'Undo' }), (expected) => { characterOf(expected).jumpActionId = characterOf(beforeClear).jumpActionId })
  assertContentEqual(snapshotOf(view), beforeClear)
  assert.equal(view.canRedo, true)
  await mutate('toolbar-redo', () => click(contents, { kind: 'button', label: 'Redo' }), (expected) => { delete characterOf(expected).jumpActionId })
  assertContentEqual(snapshotOf(view), expected)
  const finalSnapshot = structuredClone(snapshotOf(view))
  const oldBoot = view.bootId
  const nativeInputs = structuredClone(view.inputs)
  assert.equal(nativeInputs.untrusted, 0, 'Only trusted browser input events may drive this fixture.')
  assert.ok(nativeInputs.pointerdown > 0 && nativeInputs.keydown > 0 && nativeInputs.input >= 5 && nativeInputs.change >= 2)

  contents.reload()
  view = await waitForView(contents, 'fresh renderer reopens saved project', (candidate) => candidate.bootId !== oldBoot && !candidate.initializing && candidate.lifecycle === 'ready' && candidate.snapshot !== null)
  assert.deepEqual(view.environment, { sandboxed: true, contextIsolated: true })
  assert.deepEqual(snapshotOf(view), finalSnapshot)
  assert.equal(view.canUndo, false, 'Reload must use a fresh controller, not a retained session.')
  assert.equal(view.canRedo, false)
  await record('fresh-controller-reopened-persisted-snapshot')
  await locate(contents, componentField('Character controller', 'Speed'), true)
  return { finalView: view, nativeInputs }
}

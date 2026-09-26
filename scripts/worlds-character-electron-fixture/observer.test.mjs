import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

// Execute only the actual observer effect with a manual timer, not a simulated UI.
async function observerProbe() {
  const source = await readFile(new URL('./renderer.tsx', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('renderer.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const effects = []
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'useEffect') effects.push(node.arguments[0])
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.equal(effects.length, 1, 'The fixture observer must remain one bounded effect.')
  assert.doesNotMatch(effects[0].getText(parsed), /queueMicrotask|Promise\./, 'Observation must flush in a later task, not a microtask.')
  const script = ts.transpileModule(`const install = ${effects[0].getText(parsed)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const listeners = new Map()
  const timers = []
  class Element { constructor(value) { this.value = value } }
  let inputs = { pointerdown: 0, keydown: 0, input: 0, change: 0, untrusted: 0 }
  let trace = []
  let writes = 0
  const environment = {
    document: { activeElement: null, addEventListener: (kind, callback) => listeners.set(kind, callback), removeEventListener: (kind) => listeners.delete(kind) },
    window: { setTimeout: (callback) => timers.push(callback), clearTimeout: (id) => { timers[id - 1] = null } },
    setInputs: (update) => { writes += 1; inputs = update(inputs) },
    setTrace: (update) => { writes += 1; trace = update(trace) },
    eventSequence: { current: 0 }, describeFixtureControl: (element) => element ? { value: element.value } : null,
    KeyboardEvent: class {}, InputEvent: class {}, Element,
  }
  const cleanup = new Function(...Object.keys(environment), `${script}\nreturn install();`)(...Object.values(environment))
  return {
    observe: (event) => listeners.get(event.type)(event),
    flush: () => { const pending = timers.splice(0); for (const callback of pending) callback?.() },
    value: () => ({ inputs, trace, writes }), cleanup, Element,
  }
}

test('fixture observer performs no React writes during capture and preserves capture values plus post-propagation cancellation', async () => {
  const probe = await observerProbe()
  const target = new probe.Element('captured')
  const event = { type: 'input', isTrusted: true, target, defaultPrevented: false }
  probe.observe(event)
  assert.equal(probe.value().writes, 0, 'Capture must not schedule any React update before bubble change extraction.')
  target.value = 'later'
  event.defaultPrevented = true
  probe.flush()
  assert.equal(probe.value().inputs.input, 1)
  assert.equal(probe.value().trace[0].target.value, 'captured')
  assert.equal(probe.value().trace[0].defaultPrevented, true)
  probe.cleanup()
})

test('fixture observer keeps uncapped aggregate counters independent of its 200-event trace', async () => {
  const probe = await observerProbe()
  for (let count = 0; count < 225; count += 1) {
    probe.observe({ type: 'input', isTrusted: true, defaultPrevented: false })
    probe.observe({ type: 'keydown', isTrusted: true, defaultPrevented: false })
  }
  for (let count = 0; count < 3; count += 1) probe.observe({ type: 'click', isTrusted: false, defaultPrevented: false })
  probe.flush()
  assert.deepEqual(probe.value().inputs, { pointerdown: 0, keydown: 225, input: 225, change: 0, untrusted: 3 })
  assert.equal(probe.value().trace.length, 200)
  probe.observe({ type: 'change', isTrusted: true, defaultPrevented: false })
  probe.observe({ type: 'pointerdown', isTrusted: false, defaultPrevented: false })
  probe.flush()
  assert.deepEqual(probe.value().inputs, { pointerdown: 1, keydown: 225, input: 225, change: 1, untrusted: 4 })
  assert.equal(probe.value().trace.length, 200)
  probe.cleanup()
})

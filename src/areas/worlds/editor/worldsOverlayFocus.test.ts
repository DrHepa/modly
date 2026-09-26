import assert from 'node:assert/strict'
import test from 'node:test'

import { trapWorldsOverlayFocus } from './worldsOverlayFocus.ts'

type FixtureTag = 'button' | 'summary' | 'input' | 'select' | 'details' | 'div' | 'span'
interface TargetOptions {
  parent?: HTMLElement
  open?: boolean
  inert?: boolean
  ariaHidden?: boolean
  rectCount?: number
  canFocus?: boolean
}

function focusFixture() {
  let active: HTMLElement | null = null
  let prevented = 0
  const candidates: Array<{ element: HTMLElement; tag: FixtureTag }> = []
  const childLists = new Map<HTMLElement, HTMLElement[]>()
  const attempted: HTMLElement[] = []
  const target = (tag: FixtureTag, options: TargetOptions = {}): HTMLElement => {
    const children: HTMLElement[] = []
    const attributes = new Map<string, string>()
    if (options.open) attributes.set('open', '')
    if (options.inert) attributes.set('inert', '')
    if (options.ariaHidden) attributes.set('aria-hidden', 'true')
    // DOM-method doubles reproduce rectful but unfocusable descendants, not native key dispatch.
    const methods: Pick<HTMLElement, 'isConnected' | 'tagName' | 'parentElement' | 'children' | 'getAttribute' | 'hasAttribute' | 'contains' | 'getClientRects' | 'focus'> & {
      closest(selector: string): Element | null
    } = {
      isConnected: true,
      tagName: tag.toUpperCase(),
      parentElement: options.parent ?? null,
      children: Object.assign(children, { item: (index: number) => children[index] ?? null, namedItem: () => null }),
      getAttribute: (name) => attributes.get(name) ?? null,
      hasAttribute: (name) => attributes.has(name),
      contains: (other) => {
        for (let current = other; current; current = current.parentElement) {
          if (current === element) return true
        }
        return false
      },
      closest: (selector) => {
        for (let current: HTMLElement | null = element; current; current = current.parentElement) {
          if (selector === '[inert]' && current.hasAttribute('inert')) return current
        }
        return null
      },
      getClientRects: () => Object.assign(new Array<DOMRect>(options.rectCount ?? 1), { item: () => null }),
      focus: () => {
        attempted.push(element)
        if (options.canFocus !== false) active = element
      },
    }
    const element = methods as HTMLElement
    childLists.set(element, children)
    if (options.parent) childLists.get(options.parent)!.push(element)
    candidates.push({ element, tag })
    return element
  }
  const root = {
    querySelectorAll: (selector: string) => candidates
      .filter(({ tag }) => selector.split(',').some((part) => part.trim().split(':')[0] === tag))
      .map(({ element }) => element),
  } as unknown as HTMLDivElement
  return {
    target, attempted,
    get active() { return active },
    get prevented() { return prevented },
    tab(shiftKey = false) {
      trapWorldsOverlayFocus({ currentTarget: root, shiftKey, preventDefault: () => { prevented += 1 } }, active)
    },
  }
}

test('compact overlay Tab skips rectful closed Character fields instead of stalling on summary', () => {
  const fixture = focusFixture()
  const previous = fixture.target('button')
  const details = fixture.target('details')
  const summary = fixture.target('summary', { parent: details })
  const hidden = [
    fixture.target('select', { parent: details, canFocus: false }),
    fixture.target('select', { parent: details, canFocus: false }),
    fixture.target('button', { parent: details, canFocus: false }),
  ]
  const next = fixture.target('input')
  assert.equal(hidden.every((element) => element.getClientRects().length === 1), true)
  previous.focus()
  fixture.tab()
  assert.equal(fixture.active, summary)
  fixture.tab()
  assert.equal(fixture.active, next)
  assert.equal(hidden.some((element) => fixture.attempted.includes(element)), false)
  assert.equal(fixture.prevented, 2)
})

test('closed details keeps only its first direct summary and focusable summary subtree eligible', () => {
  const fixture = focusFixture()
  const previous = fixture.target('button')
  const details = fixture.target('details')
  const wrapper = fixture.target('div', { parent: details })
  fixture.target('summary', { parent: wrapper, canFocus: false })
  const summary = fixture.target('summary', { parent: details })
  const summaryText = fixture.target('span', { parent: summary })
  const summaryButton = fixture.target('button', { parent: summaryText })
  fixture.target('summary', { parent: details, canFocus: false })
  fixture.target('input', { parent: details, canFocus: false })
  const next = fixture.target('button')
  previous.focus()
  for (const expected of [summary, summaryButton, next]) {
    fixture.tab()
    assert.equal(fixture.active, expected)
  }
  fixture.tab(true)
  assert.equal(fixture.active, summaryButton)
})

for (const innerOpen of [false, true]) {
  test(`outer closed details excludes the ${innerOpen ? 'open' : 'closed'} nested details summary and contents`, () => {
    const fixture = focusFixture()
    const outer = fixture.target('details')
    const outerSummary = fixture.target('summary', { parent: outer })
    const inner = fixture.target('details', { parent: outer, open: innerOpen })
    fixture.target('summary', { parent: inner, canFocus: false })
    fixture.target('input', { parent: inner, canFocus: false })
    const next = fixture.target('button')
    outerSummary.focus()
    fixture.tab()
    assert.equal(fixture.active, next)
    fixture.tab(true)
    assert.equal(fixture.active, outerSummary)
  })
}

test('open outer details still excludes a nested closed details body but keeps its summary', () => {
  const fixture = focusFixture()
  const outer = fixture.target('details', { open: true })
  const outerSummary = fixture.target('summary', { parent: outer })
  const inner = fixture.target('details', { parent: outer })
  const innerSummary = fixture.target('summary', { parent: inner })
  fixture.target('input', { parent: inner, canFocus: false })
  const next = fixture.target('button')
  outerSummary.focus()
  fixture.tab()
  assert.equal(fixture.active, innerSummary)
  fixture.tab()
  assert.equal(fixture.active, next)
})

test('closed details without a direct summary excludes every descendant', () => {
  const fixture = focusFixture()
  const previous = fixture.target('button')
  const details = fixture.target('details')
  fixture.target('input', { parent: details, canFocus: false })
  const next = fixture.target('button')
  previous.focus()
  fixture.tab()
  assert.equal(fixture.active, next)
})

test('open details contents remain focusable while wrapping and inert or hidden filtering stay intact', () => {
  const fixture = focusFixture()
  const previous = fixture.target('button')
  const details = fixture.target('details', { open: true })
  const summary = fixture.target('summary', { parent: details })
  const input = fixture.target('input', { parent: details })
  const inert = fixture.target('div', { parent: details, inert: true })
  fixture.target('button', { parent: inert, canFocus: false })
  fixture.target('button', { parent: details, ariaHidden: true, canFocus: false })
  fixture.target('button', { parent: details, rectCount: 0, canFocus: false })
  const next = fixture.target('button')
  previous.focus()
  for (const expected of [summary, input, next, previous]) {
    fixture.tab()
    assert.equal(fixture.active, expected)
  }
  for (const expected of [next, input, summary, previous]) {
    fixture.tab(true)
    assert.equal(fixture.active, expected)
  }
})

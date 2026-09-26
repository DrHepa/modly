import type { FixtureControlEvidence } from './shared.ts'

/** Read-only and self-contained so the native driver can serialize this DOM probe. */
export function describeFixtureControl(element: Element | null): FixtureControlEvidence | null {
  if (!element) return null
  const text = (node: Element | null) => node?.textContent?.trim() ?? ''
  const label = element.closest('label')
  const span = label?.querySelector(':scope > span')
  const labelText = span
    ? [...span.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join('').trim()
    : text(label)
  const section = element.closest('section.worlds-inspector-section')
  const legends: string[] = []
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName === 'FIELDSET') legends.unshift(text(parent.querySelector(':scope > legend')))
  }
  const input = element instanceof HTMLInputElement ? element : null
  return {
    tagName: element.tagName,
    label: (element.getAttribute('aria-label') ?? labelText) || (element.tagName === 'SUMMARY' ? text(element) : ''),
    section: text(section?.querySelector(':scope > .worlds-inspector-section__heading > h3') ?? null),
    legends,
    value: input ? input.value : element instanceof HTMLSelectElement ? element.value : null,
    selectionStart: input?.selectionStart ?? null,
    selectionEnd: input?.selectionEnd ?? null,
  }
}

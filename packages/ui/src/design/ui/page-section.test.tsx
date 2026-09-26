import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { Button } from './button'
import { GroupLabel } from './group-label'
import { KeyValueRow, SummaryItem, SummaryList } from './key-value'
import { SectionHead } from '../patterns/Settings'
import { Section } from './section'

/*
 * The page grammar: a `Section` that owns its spacing, a `GroupLabel` that is
 * the one group heading, and a `SummaryList` that holds several facts about
 * one thing in one card. jsdom lays nothing out, so these hold the contract
 * the markup and the classes make; `e2e/ui-system/page-grammar.spec.ts`
 * measures the result in the real engine.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const draw = (node: ReactNode): HTMLElement => {
  act(() => root.render(node))
  const found = container.firstElementChild
  if (!(found instanceof HTMLElement)) throw new Error('nothing rendered')
  return found
}

const classes = (node: Element | null | undefined): string[] => (node?.getAttribute('class') ?? '').split(/\s+/)

it('a titled Section is a named region with a group label over its content', () => {
  const section = draw(
    <Section title="Ceiling" description="What it may do without asking.">
      <p>the card</p>
    </Section>,
  )
  expect(section.tagName).toBe('SECTION')
  expect(section.getAttribute('aria-label')).toBe('Ceiling')
  expect(section.dataset['variant']).toBe('page')
  expect(container.querySelector('section[aria-label="Ceiling"]')).toBe(section)
  const label = section.querySelector('[data-slot="group-label"]')
  expect(label?.tagName).toBe('H2')
  expect(label?.textContent).toBe('Ceiling')
  expect(section.querySelector('[data-slot="section-description"]')?.textContent).toBe('What it may do without asking.')
  // The content follows the head, as a sibling, so the section's own gap spaces it.
  expect(section.lastElementChild?.textContent).toBe('the card')
})

it('a Section owns its spacing: 8px from head to card, 32px between sections, and no child margin', () => {
  const section = draw(<Section title="File"><p>card</p></Section>)
  const own = classes(section)
  expect(own).toContain('gap-(--hd-space-2)')
  expect(own).toContain('mt-(--hd-space-8)')
  expect(own).toContain('first:mt-0')
  // A card's or a note's own margin cannot reopen the gap the section decided.
  expect(own).toContain('*:my-0!')
  // The head sits on its card: a taller action grows upward.
  expect(classes(section.querySelector('[data-slot="section-head"]'))).toContain('items-end')
})

it('a Section action sits in the head, after the label', () => {
  const section = draw(
    <Section title="Seats" action={<Button variant="outline" size="sm">Add a seat…</Button>}>
      <p>card</p>
    </Section>,
  )
  const head = section.querySelector('[data-slot="section-head"]')
  const action = head?.querySelector('[data-slot="section-action"]')
  expect(action?.textContent).toBe('Add a seat…')
  expect(head?.lastElementChild).toBe(action)
  expect(section.querySelector('[data-slot="section-description"]')).toBeNull()
})

it('an untitled Section is still the boxed region it was', () => {
  const section = draw(<Section variant="quiet">aside</Section>)
  expect(section.dataset['variant']).toBe('quiet')
  expect(section.hasAttribute('aria-label')).toBe(false)
  expect(section.querySelector('[data-slot="section-head"]')).toBeNull()
})

it('GroupLabel is 13px, secondary ink and sentence case, and never uppercases', () => {
  const label = draw(<GroupLabel>Built in</GroupLabel>)
  const own = classes(label)
  expect(own).toContain('text-(length:--hd-text-sm)')
  expect(own).toContain('text-(--hd-secondary-foreground)')
  expect(own.some((one) => /uppercase|tracking/.test(one))).toBe(false)
  expect(label.tagName).toBe('SPAN')
})

it('SummaryList is one card whose items share a key, a value and an action column', () => {
  const wrap = draw(
    <SummaryList aria-label="Facts">
      <SummaryItem label="Ceiling" note="May change files and commit in its own checkout." action={<Button size="sm" variant="outline">Update…</Button>}>
        Edit
      </SummaryItem>
      <SummaryItem label="File" kind="path">~/work/storefront/.harnessdesk/agents/code-reviewer/AGENT.md</SummaryItem>
      <SummaryItem label="Seats" numeric>3</SummaryItem>
    </SummaryList>,
  )
  expect(wrap.dataset['slot']).toBe('summary-list')
  const list = wrap.querySelector('dl')
  expect(list?.getAttribute('aria-label')).toBe('Facts')
  // One card, drawn from the same tokens a `Rows` card reads.
  expect(list?.className).toContain('bg-[var(--hd-card-fill,var(--hd-card))]')
  expect(list?.className).toContain('rounded-[var(--hd-card-radius,var(--hd-radius-lg))]')
  expect(list?.className).toContain('grid-cols-[auto_minmax(0,1fr)_auto]')
  const items = [...(list?.querySelectorAll('[data-slot="summary-item"]') ?? [])]
  expect(items).toHaveLength(3)
  for (const item of items) expect(item.className).toContain('grid-cols-subgrid')

  const [ceiling, file, seats] = items
  // The key column: muted, at least 5rem, the same classes KeyValue's keys wear.
  expect(ceiling?.querySelector('dt')?.className).toContain('text-(--hd-muted-foreground)')
  expect(ceiling?.querySelector('dt')?.className).toContain('min-w-20')
  expect(ceiling?.querySelector('[data-slot="summary-value"]')?.textContent).toContain('Edit')
  expect(ceiling?.querySelector('[data-slot="summary-note"]')?.textContent).toBe('May change files and commit in its own checkout.')
  expect(ceiling?.querySelector('[data-slot="summary-action"] button')?.textContent).toBe('Update…')
  // A path gives up its middle; a number is right-aligned on tabular figures.
  expect(file?.querySelector('[data-slot="middle-truncate"]')).not.toBeNull()
  expect(file?.getAttribute('data-kind')).toBe('path')
  expect(seats?.hasAttribute('data-numeric')).toBe(true)
  expect(seats?.querySelector('[data-slot="summary-value"]')?.className).toContain('text-right')
  expect(seats?.querySelector('[data-slot="summary-value"]')?.className).toContain('tabular-nums')
  expect(file?.querySelector('[data-slot="summary-value"]')?.className).toContain('text-left')
  expect(seats?.querySelector('[data-slot="summary-action"]')).toBeNull()
  // With no action of its own, the value takes the action's column too.
  expect(seats?.querySelector('[data-slot="summary-value"]')?.className).toContain('col-span-2')
  expect(ceiling?.querySelector('[data-slot="summary-value"]')?.className).not.toContain('col-span-2')
})

it('SummaryList keys match KeyValue keys, so the two lists are one vocabulary', () => {
  const inspector = draw(
    <dl>
      <KeyValueRow label="Key">Value</KeyValueRow>
    </dl>,
  )
  const keyValueKey = classes(inspector.querySelector('dt'))
  act(() => root.render(<SummaryList><SummaryItem label="Key">Value</SummaryItem></SummaryList>))
  const summaryKey = classes(container.querySelector('dt'))
  for (const one of ['text-start', 'text-(--hd-muted-foreground)', 'min-w-20']) {
    expect(keyValueKey).toContain(one)
    expect(summaryKey).toContain(one)
  }
})

it('a SummaryList composes inside a Section with no margin of its own', () => {
  const section = draw(
    <Section title="Agent">
      <SummaryList>
        <SummaryItem label="File">AGENT.md</SummaryItem>
      </SummaryList>
    </Section>,
  )
  const wrap = section.querySelector('[data-slot="summary-list"]')
  expect(wrap?.parentElement).toBe(section)
  expect(classes(wrap).some((one) => /^-?m[tbyxlr]?-/.test(one))).toBe(false)
})

it('a section head\'s card inset is earned only over a Rows card, not a Note or a button body', () => {
  const overRows = draw(
    <Section title="Backup">
      <div data-slot="rows">card</div>
    </Section>,
  )
  const overNote = draw(
    <Section title="Triggers">
      <p>Read from the committed file. Nothing runs until you arm it.</p>
    </Section>,
  )
  // The class is conditional (`has-[+…]`), present on both heads; only its
  // own `:has()` decides whether it resolves to a padding, which jsdom does
  // not lay out — `e2e/ui-system/page-grammar.spec.ts` measures that part in
  // the real engine. This pins the selector the condition is keyed on.
  const insetClass = 'has-[+[data-slot=rows]]:px-[calc(var(--hd-border-width)+var(--hd-inset-card))]'
  expect(classes(overRows.querySelector('[data-slot="section-head"]'))).toContain(insetClass)
  expect(classes(overNote.querySelector('[data-slot="section-head"]'))).toContain(insetClass)
  // The Note itself never grows the `rows` slot the class is keyed on.
  expect(overNote.querySelector('[data-slot="rows"]')).toBeNull()
})

it('a SectionHead inside a titled Section heads a group of it: an h3, where alone it is an h2', () => {
  const page = draw(
    <div>
      <SectionHead name="Rules" />
      <Section title="Approvals">
        <SectionHead name="Alpha" />
        <p>card</p>
      </Section>
    </div>,
  )
  const [alone, grouped] = [...page.querySelectorAll('[data-slot="section-name"]')]
  expect(alone?.tagName).toBe('H2')
  expect(grouped?.tagName).toBe('H3')
  expect(page.querySelector('section[aria-label="Approvals"] [data-slot="group-label"]')?.tagName).toBe('H2')
})

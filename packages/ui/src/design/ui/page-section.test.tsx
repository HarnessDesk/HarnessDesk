import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { Button } from './button'
import { GroupLabel } from './group-label'
import { Section } from './section'

/*
 * The page grammar: a `Section` that owns its spacing, a `GroupLabel` that is
 * the one group heading, and a `SummaryList` that holds several facts about
 * one thing in one card (its tests arrive with it). jsdom lays nothing out, so these hold the contract
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

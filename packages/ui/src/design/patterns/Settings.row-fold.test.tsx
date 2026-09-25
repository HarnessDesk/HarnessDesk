import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { RowButton, Rows } from './Settings'

/**
 * A row that opens something and also folds what it holds. Pinned: two
 * sibling targets on one line; the fold wears the trailing disclosure mark
 * (down folded, up open), never the drill-in chevron; it is a toggle, not a
 * menu, so open and folded draw the same box; and the pair draws one rule,
 * under itself, only while something follows it in the card.
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

const Card = () => {
  const [open, setOpen] = useState(false)
  return (
    <Rows>
      <RowButton
        title="Codex"
        onClick={() => {}}
        chevron={false}
        fold={{ open, onToggle: () => setOpen((was) => !was), label: `${open ? 'Hide' : 'Show'} the accounts` }}
      />
      {open && <RowButton title="An account" onClick={() => {}} />}
    </Rows>
  )
}

const fold = (): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((node) => node.hasAttribute('aria-expanded'))
  if (!found) throw new Error('no fold')
  return found as HTMLButtonElement
}
const pair = (): HTMLElement => container.querySelector('[data-slot="row-folding"]') as HTMLElement
const opener = (): HTMLElement => pair().querySelector('button:not([aria-expanded])') as HTMLElement

it('draws the fold beside the button, as its own target at the row end', () => {
  act(() => root.render(<Card />))
  expect(opener().contains(fold())).toBe(false)
  expect(pair().lastElementChild?.contains(fold())).toBe(true)
  expect(fold().getAttribute('aria-label')).toBe('Show the accounts')
})

it('points down while folded and up while open, never as the drill-in chevron', async () => {
  act(() => root.render(<Card />))
  const mark = () => fold().querySelector('[data-slot="disclosure-chevron"]')
  expect(mark()?.getAttribute('data-placement')).toBe('trailing')
  expect(mark()?.hasAttribute('data-open')).toBe(false)
  expect(fold().getAttribute('aria-expanded')).toBe('false')
  await act(async () => fold().click())
  expect(mark()?.hasAttribute('data-open')).toBe(true)
  expect(fold().getAttribute('aria-expanded')).toBe('true')
})

it('draws the same box open and folded — a toggle, not a menu', async () => {
  act(() => root.render(<Card />))
  const folded = fold().className
  await act(async () => fold().click())
  expect(fold().className).toBe(folded)
  expect(folded).not.toMatch(/aria-expanded:/)
})

// The one rule (open) and no rule (folded) are measured in the real engine,
// e2e/ui-system/row-fold.spec.ts: jsdom resolves no `var()` border.

it('stands a row\u2019s one action beside its opener, in the chevron\u2019s place, never inside it', async () => {
  let opened = 0
  let acted = 0
  await act(async () => {
    root.render(
      <Rows>
        <RowButton title="Qwen Code" onClick={() => { opened += 1 }} action={<button type="button" onClick={() => { acted += 1 }}>Sign in</button>} />
        <RowButton title="Codex" onClick={() => {}} />
      </Rows>,
    )
  })
  const pair = container.querySelector('[data-slot="row-folding"]')
  const opener = pair?.querySelector(':scope > button') as HTMLButtonElement
  const action = pair?.querySelector('[data-slot="row-action"] button') as HTMLButtonElement
  // Siblings: a button inside the row's own button is no button at all.
  expect(opener.contains(action)).toBe(false)
  // The action takes the chevron's place; the row without one keeps its chevron.
  expect(opener.querySelector('.lucide-chevron-right')).toBeNull()
  expect(container.querySelectorAll('.lucide-chevron-right')).toHaveLength(1)
  // A row that only acts has nothing to fold, and says nothing about opening.
  expect(pair?.hasAttribute('data-open')).toBe(false)
  await act(async () => action.click())
  expect([opened, acted]).toEqual([0, 1])
  await act(async () => opener.click())
  expect([opened, acted]).toEqual([1, 1])
  // The inset around the action is lit with the row, so it opens the row too.
  await act(async () => (pair?.querySelector('[data-slot="row-action"]') as HTMLElement).click())
  expect([opened, acted]).toEqual([2, 1])
})

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

import css from './timeline-cards.module.css?raw'
import { TimelineCard, TimelineCards, TimelineCardWords, TimelineDocument } from './timeline-cards'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mount = (node: React.ReactNode) => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(node))
  return { container, done: () => { act(() => root.unmount()); container.remove() } }
}

/** A rule's body, braces balanced, with its comments taken out. */
const blockAfter = (opening: string): string => {
  const at = css.indexOf(opening)
  expect(at, `${opening} is gone from this stylesheet`).toBeGreaterThan(-1)
  const start = css.indexOf('{', at)
  let depth = 0
  for (let index = start; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    if (css[index] === '}' && --depth === 0) return css.slice(start, index + 1).replace(/\/\*[\s\S]*?\*\//g, '')
  }
  throw new Error(`${opening} never closes`)
}

it('lays a round out by its column: two across, three across, and a list beyond three', () => {
  // jsdom implements no container queries, so the rules are held to the stylesheet; the group is the container.
  expect(blockAfter('.cards')).toContain('container-type: inline-size')
  expect(blockAfter('.grid {')).toContain('grid-template-columns: minmax(0, 1fr)')
  const two = blockAfter('@container (min-width: 29rem)')
  expect(two).toContain('.grid[data-count="2"]')
  expect(two).toContain('repeat(2, minmax(0, 1fr))')
  expect(two).not.toContain('data-count="3"')
  const three = blockAfter('@container (min-width: 43rem)')
  expect(three).toContain('.grid[data-count="3"]')
  expect(three).toContain('repeat(3, minmax(0, 1fr))')
  // Nothing names four or more, so such a round stays the one-column list; and a column never lets a card outgrow its track.
  expect(css).not.toMatch(/data-count="[4-9]"/)
  expect(blockAfter('.card {')).toContain('min-width: 0')
})

it('says how many cards a round holds, and draws no card of its own', () => {
  const { container, done } = mount(<TimelineCards count={3} aria-label="Round 2"><i /><i /><i /></TimelineCards>)
  try {
    const group = container.querySelector('[data-slot="timeline-cards"]')!
    expect(group.getAttribute('aria-label')).toBe('Round 2')
    expect(group.querySelector('[data-slot="timeline-card-grid"]')?.getAttribute('data-count')).toBe('3')
    expect(group.querySelectorAll('i')).toHaveLength(3)
  } finally { done() }
})

it('draws a card’s header, body and footer, and leaves out the parts it was not given', () => {
  const { container, done } = mount(<>
    <TimelineCard data-row="a" lead={<span data-lead>face</span>} name="Attempt A" meta="Seat label" actions={<button>Run again…</button>} footer={<span>facts</span>}><TimelineCardWords>Caches the ranked results.</TimelineCardWords></TimelineCard>
    <TimelineCard data-row="b" name="Bare" />
  </>)
  try {
    const [full, bare] = [...container.querySelectorAll('[data-slot="timeline-card"]')]
    expect(full!.querySelector('[data-slot="timeline-card-head"]')?.textContent).toContain('Attempt A')
    expect(full!.querySelector('[data-slot="timeline-card-head"]')?.textContent).toContain('Seat label')
    expect(full!.querySelector('[data-slot="timeline-card-head"] [data-lead]')).not.toBeNull()
    expect(full!.querySelector('[data-slot="timeline-card-body"]')?.textContent).toBe('Caches the ranked results.')
    expect(full!.querySelector('[data-slot="timeline-card-footer"]')?.textContent).toBe('facts')
    expect(bare!.querySelector('[data-slot="timeline-card-body"]')).toBeNull()
    expect(bare!.querySelector('[data-slot="timeline-card-footer"]')).toBeNull()
    expect(bare!.querySelector('[data-slot="timeline-card-actions"]')).toBeNull()
  } finally { done() }
})

it('selects from the name and from the card, but never from a control in it, and says which is selected', () => {
  const select = vi.fn()
  const again = vi.fn()
  const { container, done } = mount(<TimelineCard name="Attempt A" selected onSelect={select} actions={<button onClick={again}>Run again…</button>} footer={<span data-fact>facts</span>}><TimelineCardWords>words</TimelineCardWords></TimelineCard>)
  try {
    const card = container.querySelector('[data-slot="timeline-card"]')!
    expect(card.getAttribute('aria-current')).toBe('true')
    expect(card.hasAttribute('data-selected')).toBe(true)
    const name = [...card.querySelectorAll('button')].find(one => one.textContent === 'Attempt A')!
    act(() => name.click())
    expect(select).toHaveBeenCalledTimes(1)
    act(() => (card.querySelector('[data-slot="timeline-card-body"]') as HTMLElement).click())
    expect(select).toHaveBeenCalledTimes(2)
    act(() => (card.querySelector('[data-fact]') as HTMLElement).click())
    expect(select).toHaveBeenCalledTimes(3)
    act(() => [...card.querySelectorAll('button')].find(one => one.textContent === 'Run again…')!.click())
    expect(again).toHaveBeenCalledTimes(1)
    expect(select).toHaveBeenCalledTimes(3)
  } finally { done() }
})

it('is a plain card with one tab stop for its name, and none when nothing can select it', () => {
  const { container, done } = mount(<><TimelineCard name="Selectable" onSelect={() => {}} /><TimelineCard name="Plain" /></>)
  try {
    const [selectable, plain] = [...container.querySelectorAll('[data-slot="timeline-card"]')]
    expect(selectable!.querySelectorAll('button')).toHaveLength(1)
    expect(plain!.querySelectorAll('button')).toHaveLength(0)
    expect(plain!.hasAttribute('aria-current')).toBe(false)
  } finally { done() }
})

it('shows a committed document with its path and what its commit says, and keeps its words out of the code face', () => {
  const { container, done } = mount(<TimelineDocument path="docs/findings/checkout-fridays.md" meta="committed at 9e1f2aa · +84"><p data-words>The export runs at 02:00.</p></TimelineDocument>)
  try {
    const document = container.querySelector('[data-slot="timeline-document"]')!
    expect(document.textContent).toContain('docs/findings/checkout-fridays.md')
    expect(document.textContent).toContain('committed at 9e1f2aa · +84')
    // The path is code; the words are prose.
    const code = [...document.querySelectorAll('[data-slot="code-text"]')]
    expect(code).toHaveLength(1)
    expect(code[0]!.textContent).toContain('checkout-fridays.md')
    expect(document.querySelector('[data-words]')!.closest('[data-slot="code-text"]')).toBeNull()
    expect(document.querySelector('[data-slot="timeline-document-body"]')?.textContent).toBe('The export runs at 02:00.')
  } finally { done() }
})

it('draws a document with no words yet as its head alone', () => {
  const { container, done } = mount(<TimelineDocument path="docs/plans/session-store.md" />)
  try {
    expect(container.querySelector('[data-slot="timeline-document-body"]')).toBeNull()
    expect(container.textContent).toContain('docs/plans/session-store.md')
  } finally { done() }
})

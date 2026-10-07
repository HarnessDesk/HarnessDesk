import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { runTimeline } from '../lib/run-timeline'
import { shapeFixture } from '../preview/run-shapes-fixture'
import { RunView } from './RunView'
import { RunInspector } from './RunInspector'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const mount = (element: React.ReactNode) => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); act(() => root.render(element))
  return { container, close: () => { act(() => root.unmount()); container.remove() } }
}
it('lays out competitors and per-attempt checks, keeps the pick visible, and selects a card', () => {
  const input = shapeFixture('comparison'); const onSelect = vi.fn()
  const view = mount(<RunView number={1} model={runTimeline(input)} execution={input.execution} selectedRow={null} onSelect={onSelect} />)
  try {
    expect(view.container.querySelectorAll('[data-slot="timeline-card-grid"][data-count="2"]')).toHaveLength(2)
    expect(view.container.textContent).toContain('on Attempt A')
    expect(view.container.textContent).toContain('on Attempt B')
    expect(view.container.querySelector('[data-row="card-1-1"]')?.getAttribute('data-keep')).toBe('kept')
    expect(view.container.querySelector('[data-row="card-1-2"]')?.getAttribute('data-keep')).toBe('not-kept')
    expect(view.container.querySelector('[data-row="card-3-5"]')?.textContent).toContain('Picked')
    act(() => (view.container.querySelector('[data-row="card-1-1"] button') as HTMLButtonElement).click())
    expect(onSelect).toHaveBeenCalledWith('card-1-1')
  } finally { view.close() }
})
it('shows the checkout-qualified attempt beside each result when revisions agree', () => {
  const input = shapeFixture('comparison')
  input.evidence = { ...input.evidence!, cards: input.evidence!.cards.map(card => ({ ...card, facts: card.facts.map(view => ({
    ...view, record: { ...view.record, fact: view.record.fact.kind === 'diff' ? { ...view.record.fact, to: 'a'.repeat(40) }
      : view.record.fact.kind === 'check' ? { ...view.record.fact, at: 'a'.repeat(40) } : view.record.fact },
  })) })) }
  const view = mount(<RunView number={1} model={runTimeline(input)} execution={input.execution} selectedRow={null} onSelect={() => {}} />)
  try {
    expect(view.container.querySelector('[data-row="check-2-3"]')?.textContent).toContain('on Attempt A')
    expect(view.container.querySelector('[data-row="check-2-3"]')?.textContent).toContain('Passed')
    expect(view.container.querySelector('[data-row="check-2-4"]')?.textContent).toContain('on Attempt B')
    expect(view.container.querySelector('[data-row="check-2-4"]')?.textContent).toContain('Failed')
  } finally { view.close() }
})
it('puts answered progress in the title and the blind explanation once under the cards', () => {
  const input = shapeFixture('independent-review')
  const view = mount(<RunView number={1} model={runTimeline(input)} selectedRow={null} onSelect={() => {}} />)
  try {
    expect(view.container.querySelector('[data-slot="timeline-item"]:has([data-row="round-2"]) [role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('1')
    expect(view.container.textContent?.match(/Blind until the round closes/g)).toHaveLength(1)
    expect(view.container.querySelector('[data-row="round-2"]')?.closest('li')?.textContent).toContain('1 of 3 answered')
  } finally { view.close() }
})
it('keeps a person card in the story and later rounds pending', () => {
  const input = shapeFixture('alignment')
  const view = mount(<RunView number={1} model={runTimeline(input)} selectedRow={null} onSelect={() => {}} />)
  try {
    expect(view.container.querySelector('[data-kind="person"][data-slot="timeline-card"]')?.textContent).toContain('You')
    expect(view.container.querySelector('[data-kind="ahead"]')?.closest('li')?.getAttribute('data-state')).toBe('pending')
    expect(view.container.querySelector('[data-slot="run-need"]')).not.toBeNull()
  } finally { view.close() }
})
it('lists attempts and their pick states in Run details', () => {
  const input = shapeFixture('comparison')
  const seats = [1, 2, 5].map(id => ({ id: `seat-${id}`, name: `Agent ${id}` }))
  const view = mount(<RunInspector input={input} seats={seats} selectedRow={null} />)
  try { expect(view.container.textContent).toContain('Attempt A'); expect(view.container.textContent).toContain('Picked'); expect(view.container.textContent).toContain('Not kept') }
  finally { view.close() }
})

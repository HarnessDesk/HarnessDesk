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
  const view = mount(<RunView number={1} model={runTimeline(input)} stepsInput={input} execution={input.execution} selectedRow={null} onSelect={onSelect} />)
  try {
    expect(view.container.querySelectorAll('[data-slot="timeline-card-grid"]')).toHaveLength(0)
    expect(view.container.querySelectorAll('[data-step-row][data-flow-state]:not([data-flow-state="future"])')).toHaveLength(4)
    expect(view.container.querySelector('[data-row="card-1-1"]')?.textContent).toContain('Competitor')
    expect(view.container.querySelector('[data-row="card-3-5"]')?.textContent).toContain('Picked')
    act(() => (view.container.querySelector('[data-row="card-1-1"] button') as HTMLButtonElement).click())
    expect(onSelect).toHaveBeenCalledWith('card-1-1')
  } finally { view.close() }
})
it('keeps checkout-qualified results in Details when the Timeline folds a check step', () => {
  const input = shapeFixture('comparison')
  input.evidence = { ...input.evidence!, cards: input.evidence!.cards.map(card => ({ ...card, facts: card.facts.map(view => ({
    ...view, record: { ...view.record, fact: view.record.fact.kind === 'diff' ? { ...view.record.fact, to: 'a'.repeat(40) }
      : view.record.fact.kind === 'check' ? { ...view.record.fact, at: 'a'.repeat(40) } : view.record.fact },
  })) })) }
  const views = ['check-2-3', 'check-2-4'].map(selectedRow => mount(<RunInspector input={input} seats={[]} selectedRow={selectedRow} />))
  try {
    expect(views[0]!.container.textContent).toContain('/repo/attempt-0')
    expect(views[0]!.container.textContent).toContain('Passed')
    expect(views[1]!.container.textContent).toContain('/repo/attempt-1')
    expect(views[1]!.container.textContent).toContain('Failed')
  } finally { views.forEach(view => view.close()) }
})
it('keeps answered progress and the blind explanation on the flat step’s second line', () => {
  const input = shapeFixture('independent-review')
  const view = mount(<RunView number={1} model={runTimeline(input)} stepsInput={input} selectedRow={null} onSelect={() => {}} />)
  try {
    expect(view.container.querySelectorAll('[data-slot="timeline-card"]')).toHaveLength(0)
    expect(view.container.querySelectorAll('[data-step-row][data-flow-state]:not([data-flow-state="future"])')).toHaveLength(2)
    expect(view.container.textContent).toContain('1 of 3 answered')
    expect(view.container.textContent?.match(/Blind until the round closes/g)).toHaveLength(1)
  } finally { view.close() }
})
it('keeps a person card in the story and later rounds pending', () => {
  const input = shapeFixture('alignment')
  const view = mount(<RunView number={1} model={runTimeline(input)} stepsInput={input} selectedRow={null} onSelect={() => {}} />)
  try {
    expect(view.container.querySelector('[data-kind="person"][data-step-row]')?.textContent).toContain('Person')
    expect(view.container.querySelector('[data-kind="ahead"]')).toBeNull()
    expect(view.container.textContent).toContain('Not reached')
    expect(view.container.querySelector('[data-slot="run-steps"] [data-step-row][data-flow-state="future"]')).not.toBeNull()
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

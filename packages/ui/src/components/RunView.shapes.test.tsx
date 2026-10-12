import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { runTimeline } from '../lib/run-timeline'
import { DOCUMENT_DIFF, shapeFixture } from '../preview/run-shapes-fixture'
import { RunView } from './RunView'
import { RunInspector } from './RunInspector'
import { StoreProvider } from '../state/context'
import { runTeamStore } from '../preview/run-view-fixture'
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

it('exposes every recorded card in a selected parallel round with a real selection callback', () => {
  const input = shapeFixture('comparison'), onSelect = vi.fn()
  const view = mount(<RunInspector input={input} seats={[]} selectedRow="check-2-3" onSelect={onSelect} teamState="wrapped" />)
  try {
    const choices = view.container.querySelectorAll('[data-slot="timeline-card"]')
    expect(choices).toHaveLength(2)
    expect(choices[0]?.textContent).toContain('on Attempt A')
    expect(choices[0]?.textContent).toContain('Passed')
    expect(choices[1]?.textContent).toContain('on Attempt B')
    expect(choices[1]?.textContent).toContain('Failed')
    act(() => choices[1]!.querySelector<HTMLButtonElement>('button')!.click())
    expect(onSelect).toHaveBeenCalledWith('check-2-4')
    expect(view.container.querySelectorAll('button')).not.toContainEqual(expect.objectContaining({ textContent: 'Run again…' }))
  } finally { view.close() }
})

it('reads the committed investigation answer from the selected card in Details', async () => {
  const input = shapeFixture('investigation'), store = runTeamStore(), reads = vi.fn(async (method: string) => {
    if (method === 'git/diffRange') return { diff: DOCUMENT_DIFF }
    if (method === 'git/fileAtRevision') return { text: '# Investigation answer\n\nKeep the session store behind a flag.\n', bytes: 65 }
    throw new Error('Unexpected synthetic read')
  })
  const fixture = new Proxy(store, { get(target, key) { return key === 'transport' ? { request: reads } : Reflect.get(target, key) } })
  const container = document.createElement('div'), root = createRoot(container)
  try {
    await act(async () => root.render(<StoreProvider store={fixture}><RunInspector input={input} seats={[]} selectedRow="card-1-1" /></StoreProvider>))
    expect(container.querySelector('[data-slot="timeline-document"]')?.textContent).toContain('docs/answer.md')
    expect(container.querySelector('[data-slot="timeline-document-body"]')?.textContent).toContain('Investigation answer')
    expect(reads).toHaveBeenCalledWith('git/fileAtRevision', { root: '/repo', sha: 'a'.repeat(40), path: 'docs/answer.md' })
  } finally { act(() => root.unmount()) }
})

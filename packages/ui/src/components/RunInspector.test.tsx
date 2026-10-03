import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { runFixture } from '../preview/run-view-fixture'
import { RunInspector, type RunInspectorProps } from './RunInspector'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const render = (props: Partial<RunInspectorProps> = {}) => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const fixture = runFixture('person')
  act(() => root.render(<RunInspector input={fixture} selectedRow={null} seats={[]} {...props} />))
  return { container, close: () => act(() => root.unmount()) }
}
it('reads the Run, its frozen base, budget and Seats without inventing absent facts', () => {
  const fixture = runFixture()
  const view = render({ input: { ...fixture, execution: { ...fixture.execution, base: { remote: 'origin', branch: 'main', at: 'abc123' } } },
    seats: [{ id: 'seat-0', name: 'Alpha', override: 'Balanced · Medium', cost: { unit: 'turns', value: 3, estimated: false } }] })
  try {
    for (const text of ['Brief', fixture.execution.brief!, 'Build and review', '3f9a1c', 'Alpha', 'Balanced · Medium', 'origin · main · abc123', 'Started by you', 'Rounds', 'Rounds without progress', '3 turns']) expect(view.container.textContent).toContain(text)
    expect(view.container.textContent).toContain('Not recorded')
  } finally { view.close() }
})
it('shows card input and predecessor handoffs, findings and review before its conversation link', () => {
  const fixture = runFixture()
  const onOpen = vi.fn()
  const view = render({ input: { ...fixture, cards: fixture.cards.map(card => ({ ...card, dependsOn: card.id === 3 ? [1] : [], detail: card.id === 3 ? 'Review the bounded retry' : null, handoff: card.id === 1 ? 'Added a ceiling' : null })) }, selectedRow: 'card-3-3', seats: [{ id: 'seat-1', name: 'Beta', onOpen }],
    publication: { round: 3, state: 'local', reason: 'Posting is off for this Team.', pr: null, cards: [3] } })
  try {
    for (const text of ['Input', 'Review the bounded retry', 'Added a ceiling', 'Handoff', 'Findings', 'Cap the attempts.', 'Not posted', 'Posting is off for this Team.', 'Cost']) expect(view.container.textContent).toContain(text)
    const buttons = [...view.container.querySelectorAll('button')]
    expect(buttons.at(-1)?.textContent).toBe('Open the conversation')
    act(() => buttons.at(-1)!.click())
    expect(onOpen).toHaveBeenCalledOnce()
  } finally { view.close() }
})
it('keeps markup literal and removes terminal escape sequences from handoffs and findings', () => {
  const fixture = runFixture()
  const unsafe = '<img src=x onerror="alert(1)">\u001b[31mred\u001b[0m\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007'
  const view = render({ input: { ...fixture, cards: fixture.cards.map(card => ({ ...card, handoff: unsafe })), findings: fixture.findings.map(finding => ({ ...finding, body: unsafe })) }, selectedRow: 'card-3-3' })
  try {
    expect(view.container.textContent).toContain('<img src=x onerror="alert(1)">redlink')
    expect(view.container.textContent).not.toContain('\u001b')
    expect(view.container.querySelector('img,script,a')).toBeNull()
  } finally { view.close() }
})
it('shows the latest matching check command, recorded location, limit, mapping and output', () => {
  const fixture = runFixture()
  const record = fixture.evidence.cards[0]!.facts[0]!.record
  if (record.fact.kind !== 'check') throw new Error('Expected a check fixture')
  const checkFact = record.fact
  const view = render({ input: { ...fixture, evidence: { ...fixture.evidence, cards: [{ ...fixture.evidence.cards[0]!, facts: [{ ...fixture.evidence.cards[0]!.facts[0]!, record: { ...record, checkout: { cwd: 'project', branch: 'test' }, fact: { ...checkFact, tail: '12 tests passed' } } }] }] } }, selectedRow: 'check-2-2' })
  try {
    for (const text of ['pnpm verify', 'project', '600 seconds', 'Exit 0 → Pass', 'Latest result', 'Passed', '12 tests passed']) expect(view.container.textContent).toContain(text)
  } finally { view.close() }
})
it('does not show another round’s check output as the selected result', () => {
  const fixture = runFixture()
  const view = render({ input: { ...fixture, cards: fixture.cards.map(card => ({ ...card, outcome: null })), evidence: { ...fixture.evidence, cards: [{ ...fixture.evidence.cards[0]!, facts: fixture.evidence.cards[0]!.facts.map(fact => ({ ...fact, record: { ...fact.record, round: 99 } })) }] } }, selectedRow: 'check-2-2' })
  try { expect(view.container.textContent).toContain('Output is not kept for this check'); expect(view.container.textContent).toContain('Result unavailable') } finally { view.close() }
})
it('reads a person’s sentence and declared outcomes as inert text', () => {
  const fixture = runFixture('person')
  const view = render({ input: fixture, selectedRow: 'person-4-4' })
  try { expect(view.container.textContent).toContain('Answer the review'); expect(view.container.textContent).toContain('Approved'); expect(view.container.querySelector('button')).toBeNull() } finally { view.close() }
})
it('reads findings rows and falls back to the Run when the selected card is gone', () => {
  const fixture = runFixture()
  const view = render({ input: fixture, selectedRow: 'findings-3' })
  try { expect(view.container.textContent).toContain('Cap the attempts.') } finally { view.close() }
  const missing = render({ input: fixture, selectedRow: 'card-99-99' })
  try { expect(missing.container.textContent).toContain('Brief') } finally { missing.close() }
})

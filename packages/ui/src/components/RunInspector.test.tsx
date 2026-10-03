import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { runFixture } from '../preview/run-view-fixture'
import { RunInspector, type RunInspectorProps } from './RunInspector'
import type { FindingRunState } from '@harnessdesk/protocol'

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
it('shows only recorded dependency handoffs, including a nonadjacent source round', () => {
  const fixture = runFixture()
  const view = render({ input: { ...fixture, cards: fixture.cards.map(card => ({ ...card,
    dependsOn: card.id === 3 ? [1] : [],
    handoff: card.id === 1 ? 'Handed source package' : card.id === 2 ? 'Unrelated check package' : null,
  })) }, selectedRow: 'card-3-3' })
  try {
    expect(view.container.textContent).toContain('Handed source package')
    expect(view.container.textContent).not.toContain('Unrelated check package')
  } finally { view.close() }
})
it('does not invent input for an independently opened round with no dependencies', () => {
  const fixture = runFixture()
  const view = render({ input: { ...fixture, cards: fixture.cards.map(card => ({ ...card,
    dependsOn: [], handoff: card.id === 2 ? 'Earlier but not handed' : null,
  })) }, selectedRow: 'card-3-3' })
  try { expect(view.container.textContent).not.toContain('Earlier but not handed') } finally { view.close() }
})
const completion = 'Finish this with complete_claim and an outcome of exactly one of: approved, request-changes.'
const split = 'Finish this with complete_claim\'s split as well: the agreed split of files for the "writer" round, one list of path patterns for each of its 2 cards, in card order, no two overlapping. Each of those cards will own only its own list.'
it.each(['card', 'person'] as const)('shows the %s sentence without host-added completion and split instructions', kind => {
  const fixture = runFixture(kind === 'person' ? 'person' : 'running')
  const id = kind === 'person' ? 4 : 3
  const sentence = 'Keep <strong>the last failure</strong> visible.\u001b[31m Read the complete_claim contract in the guide.\u001b[0m'
  const view = render({ input: { ...fixture, cards: fixture.cards.map(card => ({ ...card,
    detail: card.id === id ? [sentence, completion, split, split.replace('"writer"', '"reviewer"')].join('\n\n') : null,
  })) }, selectedRow: `${kind}-${id}-${id}` })
  try {
    expect(view.container.textContent).toContain('Keep <strong>the last failure</strong> visible. Read the complete_claim contract in the guide.')
    expect(view.container.textContent).not.toContain('Finish this with')
    expect(view.container.textContent).not.toContain('\u001b')
    expect(view.container.querySelector('strong')).toBeNull()
  } finally { view.close() }
})
it.each(['card', 'person'] as const)('uses the %s fallback when detail contains only host-added instructions', kind => {
  const fixture = runFixture(kind === 'person' ? 'person' : 'running')
  const id = kind === 'person' ? 4 : 3
  const view = render({ input: { ...fixture, cards: fixture.cards.map(card => ({ ...card,
    detail: card.id === id ? `${completion}\n\n${split}` : null,
  })) }, selectedRow: `${kind}-${id}-${id}` })
  try {
    expect(view.container.textContent).toContain(kind === 'person' ? 'Answer the review' : 'No input recorded')
    expect(view.container.textContent).not.toContain('complete_claim')
  } finally { view.close() }
})
// A Flow's `detail: |` block keeps one trailing newline, and the host then joins
// its own paragraphs with a blank line: three newlines are stored before them.
const block = 'Fix the retry loop.\n\nOpen a pull request for it when it is done and working.\n'
const withDetail = (kind: 'card' | 'person', detail: string) => {
  const fixture = runFixture(kind === 'person' ? 'person' : 'running')
  const id = kind === 'person' ? 4 : 3
  return render({ input: { ...fixture, cards: fixture.cards.map(card => ({ ...card, detail: card.id === id ? detail : null })) }, selectedRow: `${kind}-${id}-${id}` })
}
it.each(['card', 'person'] as const)('strips the host instructions after a %s sentence written as a YAML block', kind => {
  const detail = [block, completion].join('\n\n')
  expect(detail).toContain('working.\n\n\nFinish this with')
  const view = withDetail(kind, detail)
  try {
    expect(view.container.textContent).toContain('Open a pull request for it when it is done and working.')
    expect(view.container.textContent).not.toContain('Finish this with')
    expect(view.container.textContent).not.toContain('complete_claim')
  } finally { view.close() }
})
it.each(['card', 'person'] as const)('strips the completion and every split paragraph after a %s block sentence', kind => {
  const view = withDetail(kind, [block, completion, split, split.replace('"writer"', '"reviewer"')].join('\n\n'))
  try {
    expect(view.container.textContent).toContain('Fix the retry loop.')
    expect(view.container.textContent).not.toContain('Finish this with')
    expect(view.container.textContent).not.toContain('agreed split')
  } finally { view.close() }
})
it('strips a split paragraph that follows a block sentence with no completion line', () => {
  const view = withDetail('card', [block, split].join('\n\n'))
  try {
    expect(view.container.textContent).toContain('Open a pull request for it when it is done and working.')
    expect(view.container.textContent).not.toContain('agreed split')
  } finally { view.close() }
})
it('keeps the blank lines inside an authored sentence exactly as written', () => {
  const view = withDetail('card', ['First.\n\n\nSecond, after two blank lines.\n', completion].join('\n\n'))
  try {
    expect(view.container.textContent).toContain('First.\n\n\nSecond, after two blank lines.')
    expect(view.container.textContent).not.toContain('Finish this with')
  } finally { view.close() }
})
it('does not strip an instruction-shaped paragraph that is not the last one', () => {
  const view = withDetail('card', [completion, 'Then say what you changed.'].join('\n\n'))
  try {
    expect(view.container.textContent).toContain('Finish this with complete_claim')
    expect(view.container.textContent).toContain('Then say what you changed.')
  } finally { view.close() }
})
const findingsState = (extraRound: FindingRunState['extraRound']): FindingRunState => ({
  version: 1, budget: { rounds: 3, withoutProgress: 2 }, closedRounds: [1, 2, 3, 4], idleRounds: 1,
  progress: [], series: [], stopped: null, extraRound, overrides: [], lastDecision: null,
})
it.each([
  { extra: { after: 3, count: 2, reason: 'Finish the repair' }, limit: 5 },
  // Older recorded authorizations have no count and authorize one round.
  { extra: { after: 3, reason: 'Finish the repair' } as FindingRunState['extraRound'], limit: 4 },
  { extra: { after: 1, count: 1, reason: 'Read the repaired ledger' }, limit: 3 },
  { extra: null, limit: 3 },
])('reads the effective round budget as $limit', ({ extra, limit }) => {
  const fixture = runFixture()
  const view = render({ input: { ...fixture, execution: { ...fixture.execution, findings: findingsState(extra) } } })
  try {
    expect(view.container.textContent).toContain(`Rounds: 4 of ${limit}`)
    expect(view.container.textContent).toContain('Rounds without progress: 1 · Limit 2')
    if (extra) {
      expect(view.container.textContent).toContain(extra.reason)
      expect(view.container.textContent).toContain('Authorized after round')
    }
  } finally { view.close() }
})
const sectionText = (container: HTMLElement, title: string): string =>
  [...container.querySelectorAll('section')].find(one => one.textContent?.startsWith(title))?.textContent ?? ''
it.each([
  { name: 'declares no budget', budget: undefined },
  // A Flow's declared budget is what a new Run would freeze, not what this one recorded.
  { name: 'declares a budget', budget: { rounds: 7, withoutProgress: 4 } },
])('says the limit was not recorded for an agents-format Run with no findings record, whose Flow $name', ({ budget }) => {
  const fixture = runFixture()
  const { document } = fixture.execution
  if (document.format !== 'agents') throw new Error('Expected an agents-format fixture')
  const execution = { ...fixture.execution, document: { ...document, flow: { ...document.flow, ...(budget ? { budget } : {}) } } }
  expect(execution.findings).toBeUndefined()
  const view = render({ input: { ...fixture, execution } })
  try {
    const budgets = sectionText(view.container, 'Budgets')
    expect(budgets).toContain('Rounds: 3 · Limit not recorded')
    expect(budgets).toContain('Rounds without progress: Not recorded')
    expect(budgets).not.toContain(' of ')
    expect(budgets).not.toContain('Limit 2')
    expect(budgets).not.toMatch(/Limit \d/)
  } finally { view.close() }
})
it('still reads the limits a Run recorded', () => {
  const fixture = runFixture()
  const view = render({ input: { ...fixture, execution: { ...fixture.execution, findings: findingsState(null) } } })
  try {
    const budgets = sectionText(view.container, 'Budgets')
    expect(budgets).toContain('Rounds: 4 of 3')
    expect(budgets).toContain('Rounds without progress: 1 · Limit 2')
    expect(budgets).not.toContain('not recorded')
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

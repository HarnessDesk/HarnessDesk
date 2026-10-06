import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { runFixture } from '../preview/run-view-fixture'
import { RunInspector, type RunInspectorProps } from './RunInspector'
import type { Evidence, FindingRunState, FlowCheckAttempt, Freshness } from '@harnessdesk/protocol'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const render = (props: Partial<RunInspectorProps> = {}) => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const fixture = runFixture('person')
  act(() => root.render(<RunInspector input={fixture} selectedRow={null} seats={[]} {...props} />))
  return { container, root, close: () => act(() => root.unmount()) }
}
it('reads the stopped card state in its header and keeps Abandon as a board release', async () => {
  const fixture = runFixture('running')
  const input = { ...fixture, execution: { ...fixture.execution, state: 'stopped' as const, endedAt: Date.now() } }
  const onAbandon = vi.fn(async () => {})
  const view = render({ input, selectedRow: 'card-4-4', onAbandon })
  try {
    expect(view.container.textContent).toContain('Stopped')
    const abandon = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === 'Abandon card…')!
    expect(abandon.title).toBe('Releases this card on the board; no further step starts.')
    act(() => abandon.click())
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(one => one.textContent === 'Abandon card')!
    await act(async () => confirm.click())
    expect(onAbandon).toHaveBeenCalledWith(4)
  } finally { view.close() }
})
it('reads the Run, its frozen base, budget and Seats without inventing absent facts', () => {
  const fixture = runFixture()
  const view = render({ input: { ...fixture, execution: { ...fixture.execution, base: { remote: 'origin', branch: 'main', at: 'abc123' } } },
    seats: [{ id: 'seat-0', name: 'Alpha', override: 'Balanced · Medium', cost: { unit: 'turns', value: 3, estimated: false } }] })
  try {
    for (const text of ['Brief', fixture.execution.brief!, 'Build and review', '3f9a1c', 'Alpha', 'Balanced · Medium', 'origin · main · abc123', 'Started by you', 'rounds', '3 turns']) expect(view.container.textContent).toContain(text)
    expect(view.container.textContent).toContain('This Run did not record: budget, Seat details, Seat costs.')
  } finally { view.close() }
})
it('shows card input and predecessor handoffs, findings and review before its conversation link', () => {
  const fixture = runFixture()
  const onOpen = vi.fn()
  const view = render({ input: { ...fixture, cards: fixture.cards.map(card => ({ ...card, dependsOn: card.id === 3 ? [1] : [], detail: card.id === 3 ? 'Review the bounded retry' : null, handoff: card.id === 1 ? 'Added a ceiling' : null })) }, selectedRow: 'card-3-3', seats: [{ id: 'seat-1', name: 'Beta', onOpen }],
    publication: { round: 3, state: 'local', reason: 'Posting is off for this Team.', pr: null, cards: [3] } })
  try {
    for (const text of ['Input', 'Review the bounded retry', 'Added a ceiling', 'Handoff', 'Findings', 'Cap the attempts.', 'Kept on the desk', 'Posting is off for this Team.', 'Cost']) expect(view.container.textContent).toContain(text)
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
    expect(view.container.textContent).toContain(`Budget4 of ${limit} rounds`)
    expect(view.container.textContent).toContain('Without progress1 of 2 rounds')
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
    const budgets = sectionText(view.container, 'Run')
    expect(view.container.querySelector('[data-slot=run-recording-gaps]')?.textContent).toContain('budget')
    expect(budgets).not.toContain('Budget')
    expect(budgets).not.toContain(' of ')
    expect(budgets).not.toContain('Limit 2')
    expect(budgets).not.toMatch(/Limit \d/)
  } finally { view.close() }
})
it('still reads the limits a Run recorded', () => {
  const fixture = runFixture()
  const view = render({ input: { ...fixture, execution: { ...fixture.execution, findings: findingsState(null) } } })
  try {
    const budgets = sectionText(view.container, 'Run')
    expect(budgets).toContain('Budget4 of 3 rounds')
    expect(budgets).toContain('Without progress1 of 2 rounds')
    expect(budgets).not.toContain('not recorded')
  } finally { view.close() }
})
const READING = 'Reading findings…'
const UNREAD = 'Findings could not be read'
const NONE = 'No findings recorded'
it.each([
  { name: 'have not landed', findings: undefined, findingsRead: undefined, shown: READING },
  { name: 'have not landed and are being read', findings: undefined, findingsRead: 'reading' as const, shown: READING },
  { name: 'have not landed and could not be read', findings: undefined, findingsRead: 'failed' as const, shown: UNREAD },
  { name: 'were all read and there are none', findings: [], findingsRead: undefined, shown: NONE },
  // None here yet is not none: the rest of them may be on a page still to come, or the read may have failed.
  { name: 'are only partly read and none is here yet', findings: [], findingsRead: 'reading' as const, shown: READING },
  { name: 'could not be read and none is here', findings: [], findingsRead: 'failed' as const, shown: UNREAD },
])('says "$shown" for a card whose findings $name', ({ findings, findingsRead, shown }) => {
  const view = render({ input: { ...runFixture(), findings }, findingsRead, selectedRow: 'card-3-3' })
  try {
    expect(sectionText(view.container, 'Findings')).toContain(shown)
    for (const other of [READING, UNREAD, NONE]) if (other !== shown) expect(view.container.textContent).not.toContain(other)
  } finally { view.close() }
})
// The findings row exists only because there are findings, and a card shows the ones that are its own.
it.each([
  ...[undefined, 'reading' as const, 'failed' as const].map(findingsRead => ({ selectedRow: 'card-3-3', findingsRead })),
  ...[undefined, 'reading' as const, 'failed' as const].map(findingsRead => ({ selectedRow: 'findings-3', findingsRead })),
])('shows the finding it has on $selectedRow when the read is $findingsRead', ({ selectedRow, findingsRead }) => {
  const view = render({ input: runFixture(), findingsRead, selectedRow })
  try {
    expect(sectionText(view.container, 'Findings')).toContain('Cap the attempts.')
    for (const placeholder of [READING, UNREAD, NONE]) expect(view.container.textContent).not.toContain(placeholder)
  } finally { view.close() }
})
it('does not call a card’s findings none while the ones read so far are another card’s', () => {
  const fixture = runFixture()
  const view = render({ input: fixture, findingsRead: 'reading', selectedRow: 'card-1-1' })
  try {
    expect(sectionText(view.container, 'Findings')).toContain(READING)
    expect(view.container.textContent).not.toContain('Cap the attempts.')
    expect(view.container.textContent).not.toContain(NONE)
  } finally { view.close() }
  const read = render({ input: fixture, selectedRow: 'card-1-1' })
  try {
    expect(sectionText(read.container, 'Findings')).toContain(NONE)
    expect(read.container.textContent).not.toContain(READING)
  } finally { read.close() }
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
it('does not assign a round publication to a card the round record does not name', () => {
 const view=render({input:runFixture(),selectedRow:'card-3-3',publication:{round:3,state:'posted',reason:null,pr:7,cards:[99]}})
 try {
  expect(sectionText(view.container,'Review')).toContain('No review recorded')
  expect(sectionText(view.container,'Review')).not.toContain('Posted to #7')
 } finally {view.close()}
})

/*
 * A check run again: the inspector lists what the desk recorded each time it
 * ran, with each attempt's output kept as it was, and offers *Run again…* last.
 */
const gate = (patch: { state?: 'running' | 'stalled' | 'settled' | 'stopped'; operation?: 'started' | 'finished' | 'uncertain' | null } = {}) => {
  const fixture = runFixture()
  const operations = patch.operation === null ? [] : [{ key: 'check:2:0', kind: 'check' as const, state: patch.operation ?? 'finished', card: 2, seat: null }]
  return { ...fixture, execution: { ...fixture.execution, state: patch.state ?? 'running', operations: [...fixture.execution.operations, ...operations] } }
}
const attempt = (n: number, patch: Partial<FlowCheckAttempt> = {}): FlowCheckAttempt =>
  ({ id: `attempt-${n}`, n, at: Date.now() - (3 - n) * 600_000, commit: `c0ffee${n}`, exit: n === 1 ? 1 : 0, timedOut: false, outcome: n === 1 ? 'fail' : 'pass', tail: `output of attempt ${n}`, ...patch })
const button = (container: HTMLElement, label: string) => [...container.querySelectorAll('button')].find(one => one.textContent === label)

it('lists each recorded attempt newest first, with its output behind a link and the earlier output exactly as recorded', () => {
  const input = { ...gate(), attempts: new Map([[2, [attempt(1), attempt(2)]]]) }
  const view = render({ input, selectedRow: 'check-2-2' })
  try {
    const attempts = sectionText(view.container, 'Attempts')
    expect(attempts.indexOf('Attempt 2')).toBeGreaterThan(-1)
    expect(attempts.indexOf('Attempt 2')).toBeLessThan(attempts.indexOf('Attempt 1'))
    for (const text of ['Failed', 'Passed', 'Exit 1', 'Exit 0', 'c0ffee1', 'c0ffee2']) expect(attempts).toContain(text)
    expect(attempts).not.toContain('output of attempt')
    const first = view.container.querySelector('[data-attempt="1"]') as HTMLElement
    const show = button(first, 'Show output')!
    expect(show.getAttribute('aria-expanded')).toBe('false')
    act(() => show.click())
    expect(first.textContent).toContain('output of attempt 1')
    expect(view.container.querySelector('[data-attempt="2"]')!.textContent).not.toContain('output of attempt 2')
    act(() => button(first, 'Hide output')!.click())
    expect(first.textContent).not.toContain('output of attempt 1')
  } finally { view.close() }
})

it('names the commit an attempt ran at by its first twelve characters, and the whole of it on hover', () => {
  const sha = 'a1b2c3d4e5f6'.repeat(3) + 'a1b2'
  const view = render({ input: { ...gate(), attempts: new Map([[2, [attempt(1, { commit: sha }), attempt(2)]]]) }, selectedRow: 'check-2-2' })
  try {
    const one = view.container.querySelector('[data-attempt="1"]') as HTMLElement
    expect(one.textContent).toContain('a1b2c3d4e5f6')
    expect(one.textContent).not.toContain('a1b2c3d4e5f6a')
    expect(one.querySelector(`[title="${sha}"]`)).not.toBeNull()
  } finally { view.close() }
})

it('has no Attempts section for a check with one result or none, which the Latest result already reads', () => {
  for (const attempts of [new Map([[2, [attempt(1)]]]), new Map([[2, []]]), undefined]) {
    const view = render({ input: { ...gate(), ...(attempts ? { attempts } : {}) }, selectedRow: 'check-2-2' })
    try { expect(view.container.textContent).not.toContain('Attempts') } finally { view.close() }
  }
})

it.each([
  { read: 'reading' as const, shown: 'Reading attempts…' },
  { read: 'failed' as const, shown: 'Earlier attempts could not be read' },
])('says "$shown" while a check’s attempts are not here, and never calls them none', ({ read, shown }) => {
  const view = render({ input: gate(), attemptsRead: read, selectedRow: 'check-2-2' })
  try {
    expect(sectionText(view.container, 'Attempts')).toContain(shown)
    expect(view.container.textContent).not.toContain('Attempt 1')
  } finally { view.close() }
  // The read of another check's attempts is not this one's: a card with none of its own still says it is reading.
  const other = render({ input: { ...gate(), attempts: new Map([[9, [attempt(1), attempt(2)]]]) }, attemptsRead: read, selectedRow: 'check-2-2' })
  try { expect(sectionText(other.container, 'Attempts')).toContain(shown) } finally { other.close() }
})

it('shows readable attempts and says when the history is incomplete', () => {
  const view = render({ input: { ...gate(), attempts: new Map([[2, [attempt(1, { n: null })] ]]), incompleteAttempts: new Set([2]) }, selectedRow: 'check-2-2' })
  try {
    const attempts = sectionText(view.container, 'Attempts')
    expect(attempts).toContain('Recorded result')
    expect(attempts).not.toContain('Attempt 1')
    expect(attempts).toContain('Attempt history could not be read completely.')
  } finally { view.close() }
})

it.each(['reading', 'failed'] as const)('shows the attempts it has whatever the read of them says, and says nothing of a check it already knows ran once (%s)', read => {
  const some = render({ input: { ...gate(), attempts: new Map([[2, [attempt(1), attempt(2)]]]) }, attemptsRead: read, selectedRow: 'check-2-2' })
  try {
    expect(sectionText(some.container, 'Attempts')).toContain('Attempt 2')
    expect(some.container.textContent).not.toContain('Reading attempts…')
    expect(some.container.textContent).not.toContain('could not be read')
  } finally { some.close() }
  const once = render({ input: { ...gate(), attempts: new Map([[2, [attempt(1)]]]) }, attemptsRead: read, selectedRow: 'check-2-2' })
  try {
    expect(once.container.textContent).not.toContain('Attempts')
    expect(once.container.textContent).not.toContain('could not be read')
  } finally { once.close() }
})

it('keeps markup literal and removes terminal escape sequences from an attempt’s output, as it does for the latest', () => {
  const unsafe = '<img src=x onerror="alert(1)">\u001b[31mred\u001b[0m\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007<script>1</script> & more'
  const input = { ...gate(), attempts: new Map([[2, [attempt(1, { tail: unsafe }), attempt(2, { tail: unsafe })]]]) }
  const view = render({ input, selectedRow: 'check-2-2' })
  try {
    for (const one of [1, 2]) act(() => button(view.container.querySelector(`[data-attempt="${one}"]`) as HTMLElement, 'Show output')!.click())
    const shown = [...view.container.querySelectorAll('[data-attempt] [data-slot="code-text"]')].map(one => one.textContent)
    expect(shown).toHaveLength(2)
    for (const one of shown) expect(one).toBe('<img src=x onerror="alert(1)">redlink<script>1</script> & more')
    expect(view.container.textContent).not.toContain('\u001b')
    expect(view.container.querySelector('img,script,a')).toBeNull()
  } finally { view.close() }
})

it('puts Run again… last in a check’s inspector, enabled while the Run and the check allow it', () => {
  const input = { ...gate(), attempts: new Map([[2, [attempt(1), attempt(2)]]]) }
  const view = render({ input, selectedRow: 'check-2-2' })
  try {
    const buttons = [...view.container.querySelectorAll('button')]
    expect(buttons.at(-1)!.textContent).toBe('Run again…')
    expect(buttons.at(-1)!.disabled).toBe(false)
    expect(view.container.textContent).not.toContain('Start a new run')
  } finally { view.close() }
})

it.each([
  { name: 'settled Run', patch: { state: 'settled' as const }, reason: 'This run is settled. Start a new run to run this check again.' },
  { name: 'stopped Run', patch: { state: 'stopped' as const, operation: 'uncertain' as const }, reason: 'This run is stopped. Start a new run to run this check again.' },
  { name: 'check still running', patch: { operation: 'started' as const }, reason: 'This check is not waiting to be run again.' },
])('keeps the host’s reason and only an actionable refused control for a $name', ({ patch, reason }) => {
  const view = render({ input: gate(patch), selectedRow: 'check-2-2' })
  try {
    const again = button(view.container, 'Run again…')
    if ('state' in patch) expect(again).toBeUndefined()
    else expect(again!.hasAttribute('disabled') || again!.getAttribute('aria-disabled') === 'true').toBe(true)
    const shown = [...view.container.querySelectorAll('*')].filter(one => one.children.length === 0 && one.textContent === reason)
    expect(shown.some(one => !one.closest('.sr-only'))).toBe(true)
  } finally { view.close() }
})

/** The controls the connected view hands the inspector; none are present unless a caller gives them. */
const buttonsOf = (container: HTMLElement) => [...container.querySelectorAll('button')].map(one => one.textContent)

it('keeps an abandon question and its late refusal with the Run and card it belongs to (#1342)', async () => {
  const fixture = runFixture()
  let refuse!: (error: Error) => void
  const pending = new Promise<void>((_resolve, reject) => { refuse = reject })
  const onAbandon = vi.fn(() => pending)
  const input = { ...fixture, cards: fixture.cards.map(card => [3, 4].includes(card.id) ? { ...card, state: 'open' as const, claim: null } : card) }
  const view = render({ input, selectedRow: 'card-4-4', onAbandon })
  const draw = (next: typeof input, selectedRow: string) => act(() => view.root.render(<RunInspector input={next} selectedRow={selectedRow} seats={[]} onAbandon={onAbandon} />))
  const button = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(one => one.textContent === label)!
  const question = () => document.body.querySelector('[role="alertdialog"]')
  try {
    act(() => view.container.querySelector<HTMLButtonElement>('button')!.click())
    act(() => button('Abandon card').click())
    expect(onAbandon).toHaveBeenCalledWith(4)
    const completed = { ...input, cards: input.cards.map(card => card.id === 4 ? { ...card, state: 'done' as const } : card) }
    draw(completed, 'card-4-4')
    expect(question()).toBeNull()
    draw(completed, 'card-3-3')
    expect(question()).toBeNull()
    act(() => view.container.querySelector<HTMLButtonElement>('button')!.click())
    expect(question()?.textContent).toContain('Abandon card #3?')
    await act(async () => { refuse(new Error('Late refusal for #4')); await pending.catch(() => {}) })
    expect(question()?.textContent).not.toContain('Late refusal')
    expect(button('Abandon card').disabled).toBe(false)
    // A reused card number in another Run also starts with a fresh question.
    draw({ ...completed, execution: { ...completed.execution, id: 'another-run' } }, 'card-3-3')
    expect(question()).toBeNull()
  } finally { view.close() }
})
it('offers abandoning a card that has not finished, before its conversation link', () => {
  const fixture = runFixture()
  const onAbandon = vi.fn().mockResolvedValue(undefined)
  const view = render({ input: fixture, selectedRow: 'card-4-4', seats: [{ id: 'seat-0', name: 'Alpha', onOpen: () => {} }], onAbandon })
  try {
    expect(buttonsOf(view.container)).toEqual(['Abandon card…', 'Open the conversation'])
    act(() => [...view.container.querySelectorAll('button')][0]!.click())
    const dialog = document.body.querySelector('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('Abandon card #4?')
    // The fixture Run's frozen Flow carries the rule `written`, which hands a writer's round to the verify check.
    expect(dialog?.querySelector('[data-slot="confirm-body"] p')?.textContent).toBe('The rule that follows the writer role still fires, so abandoning this card opens the verify check.')
    expect(dialog?.textContent).toContain('Alpha holds this card now.')
  } finally {
    act(() => [...document.body.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(one => one.textContent === 'Keep it')?.click())
    view.close()
  }
})
it('offers no abandoning for a card that has finished, or when nothing can abandon', () => {
  const fixture = runFixture()
  const done = render({ input: fixture, selectedRow: 'card-3-3', seats: [{ id: 'seat-1', name: 'Beta', onOpen: () => {} }], onAbandon: vi.fn() })
  try { expect(buttonsOf(done.container)).toEqual(['Open the conversation']) } finally { done.close() }
  const none = render({ input: fixture, selectedRow: 'card-4-4', seats: [{ id: 'seat-0', name: 'Alpha', onOpen: () => {} }] })
  try { expect(buttonsOf(none.container)).toEqual(['Open the conversation']) } finally { none.close() }
})
it.each(['person', 'check'] as const)('offers to abandon an unfinished %s card from its inspector', async kind => {
  const fixture = kind === 'person' ? runFixture('person') : runFixture()
  const cardId = kind === 'person' ? 4 : 2
  const input = kind === 'person' ? fixture : {
    ...fixture,
    execution: { ...fixture.execution, rounds: fixture.execution.rounds.map(round => round.n === 2 ? { ...round, state: 'running' as const } : round) },
    cards: fixture.cards.map(card => card.id === cardId ? { ...card, state: 'open' as const, outcome: null } : card),
  }
  const onAbandon = vi.fn().mockResolvedValue(undefined)
  const view = render({ input, selectedRow: kind === 'person' ? 'person-4-4' : 'check-2-2', onAbandon })
  try {
    const abandon = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Abandon card…')
    expect(abandon).toBeDefined()
    act(() => abandon!.click())
    const dialog = document.body.querySelector('[role="alertdialog"]')!
    expect(dialog.textContent).toContain(`Abandon card #${cardId}?`)
    await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Abandon card')!.click())
    expect(onAbandon).toHaveBeenCalledWith(cardId)
  } finally {
    act(() => [...document.body.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(button => button.textContent === 'Keep it')?.click())
    view.close()
  }
})
it('answers a person’s step from its inspector with the words its role declares', async () => {
  const fixture = runFixture('person')
  const onAnswer = vi.fn().mockResolvedValue(undefined)
  const view = render({ input: fixture, selectedRow: 'person-4-4', onAnswer, onOpenBoard: () => {} })
  try {
    expect(view.container.textContent).toContain('Answer the review')
    expect(view.container.textContent).toContain('Approved finishes the Run.')
    expect(view.container.textContent).not.toContain('Outcomes')
    expect(buttonsOf(view.container)).toEqual(['Approved'])
    await act(async () => view.container.querySelector('button')!.click())
    expect(onAnswer).toHaveBeenCalledWith(4, 'approved', '')
  } finally { view.close() }
})
it('keeps a person’s answered step as text, with the answer it was given', () => {
  const fixture = runFixture('person')
  const answered = { ...fixture, cards: fixture.cards.map(card => card.id === 4 ? { ...card, state: 'done' as const, outcome: 'approved' } : card) }
  const view = render({ input: answered, selectedRow: 'person-4-4', onAnswer: vi.fn(), onOpenBoard: () => {} })
  try {
    expect(view.container.textContent).toContain('Outcomes')
    expect(view.container.textContent).toContain('Answer')
    expect(view.container.querySelector('button')).toBeNull()
  } finally { view.close() }
})
it('sends a person’s review step to the board', async () => {
  const fixture = runFixture('person')
  const review = { ...fixture, execution: { ...fixture.execution, document: { ...fixture.execution.document, flow: { ...fixture.execution.document.flow,
    rules: [{ id: 'land', on: 'person', when: { every: ['approved'], evidence: [{ review: 'approved' }] }, then: { role: 'writer', title: 'Merge' } }] } } } } as unknown as typeof fixture
  const onOpenBoard = vi.fn()
  const view = render({ input: review, selectedRow: 'person-4-4', onAnswer: vi.fn(), onOpenBoard })
  try {
    expect(buttonsOf(view.container)).toEqual(['Pick an attempt on the board'])
    await act(async () => view.container.querySelector('button')!.click())
    expect(onOpenBoard).toHaveBeenCalledOnce()
  } finally { view.close() }
})

it('isolates answer state when selection changes while the previous card is waiting on a refusal', async () => {
  const fixture = runFixture('person')
  const input = {
    ...fixture,
    execution: { ...fixture.execution, rounds: fixture.execution.rounds.map(round => round.n === 4 ? { ...round, cards: [4, 5] } : round) },
    cards: [...fixture.cards, { ...fixture.cards[3]!, id: 5, title: 'Second person step', createdAt: fixture.cards[3]!.createdAt + 1, updatedAt: fixture.cards[3]!.updatedAt + 1 }],
  }
  let refuse!: (error: Error) => void
  const onAnswer = vi.fn((card: number) => card === 4 ? new Promise<void>((_resolve, reject) => { refuse = reject }) : Promise.resolve())
  const view = render({ input, selectedRow: 'person-4-4', onAnswer, onOpenBoard: () => {} })
  try {
    const note = () => view.container.querySelector<HTMLInputElement>('input[aria-label="Note"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('no value setter — typing would be a no-op')
    act(() => { setter.call(note(), 'first card note'); note().dispatchEvent(new Event('input', { bubbles: true })) })
    const firstAnswer = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Approved')!
    act(() => firstAnswer.click())
    expect(onAnswer).toHaveBeenCalledWith(4, 'approved', 'first card note')

    act(() => view.root.render(<RunInspector input={input} selectedRow="person-4-5" seats={[]} onAnswer={onAnswer} onOpenBoard={() => {}} />))
    const secondAnswer = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Approved')!
    expect(note().value).toBe('')
    expect(secondAnswer.disabled).toBe(false)

    await act(async () => { refuse(new Error('This card was already answered.')); await Promise.resolve() })
    expect(view.container.querySelector('[role="alert"]')).toBeNull()
    expect(secondAnswer.disabled).toBe(false)
    expect(note().value).toBe('')
  } finally { view.close() }
})

it('shortens the selected check command and keeps the full command on hover', () => {
  const input = runFixture('live-polish')
  const view = render({ input, selectedRow: 'check-2-2', home: '/home/dev' })
  try {
    expect(view.container.textContent).toContain('PATH=/usr/bin:~/bin node ~/tools/land.mjs --check')
    expect(view.container.querySelector('[title="PATH=/usr/bin:/home/dev/bin node /home/dev/tools/land.mjs --check"]')).not.toBeNull()
  } finally { view.close() }
})

it('uses cards, toned Seat states and two-column facts for the Run summary', () => {
  const fixture = runFixture()
  const view = render({ input: { ...fixture, execution: { ...fixture.execution, base: { remote: 'origin', branch: 'main', at: 'abc123' } } },
    seats: [{ id: 'seat-0', name: 'Alpha', override: 'Balanced · Medium', cost: { unit: 'turns', value: 3, estimated: false } }] })
  try {
    expect([...view.container.querySelectorAll('[data-slot="card-title"]')].map(one => one.textContent)).toEqual(['Brief', 'Seats 2', 'Run'])
    expect(view.container.querySelector('[data-slot="icon-tile"]')?.getAttribute('data-tint')).toBe('violet')
    expect(view.container.querySelector('[data-slot="chip"][data-tone="info"]')?.textContent).toBe('Working')
    expect(view.container.querySelector('[data-slot="key-value"]')).not.toBeNull()
    expect(view.container.querySelector('[data-slot="inspector-footer"]')).not.toBeNull()
  } finally { view.close() }
})
it('omits the Seats card when the Run recorded no Seat details', () => {
  const fixture = runFixture()
  const view = render({ input: fixture, seats: [] })
  try {
    expect([...view.container.querySelectorAll('[data-slot="card-title"]')].some(one => /^Seats\b/.test(one.textContent ?? ''))).toBe(false)
    expect(view.container.querySelector('[data-slot="run-recording-gaps"]')?.textContent).toContain('Seat details')
  } finally { view.close() }
})
it('gives the observed pull request its state and check counts, and the recorded budgets labelled meters', () => {
  const fixture = runFixture()
  const facts = [
    { kind: 'pr' as const, number: 412, head: 'abc123', state: 'open' as const, url: 'https://example.com/pull/412' },
    { kind: 'ci' as const, at: 'abc123', checks: [{ name: 'Verify', state: 'failed' as const, url: null }, { name: 'Build', state: 'passed' as const, url: null }] },
    { kind: 'diff' as const, files: 3, added: 177, removed: 82, from: 'base123', to: 'abc123' },
  ]
  const input = { ...fixture, execution: { ...fixture.execution, findings: { version: 1 as const, budget: { rounds: 24, withoutProgress: 3 }, closedRounds: [1, 2, 3], idleRounds: 1, progress: [], series: [], stopped: null, extraRound: null, overrides: [], lastDecision: null } },
    evidence: { ...fixture.evidence, cards: [{ card: 1, running: [], facts: facts.map((fact, n) => ({ by: null, freshness: { state: 'fresh' as const }, record: { id: `summary-${n}`, observedAt: n, round: 1, fact, checkout: { root: '/work/demo', cwd: '/work/demo', commonDir: '/work/demo/.git', head: 'abc123', branch: 'fix/checkout' } } })) }] } }
  const view = render({ input, flowFile: <button>Flow file</button> })
  try {
    const cards = [...view.container.querySelectorAll('[data-slot="card"]')]
    expect(cards.map(one => one.querySelector('[data-slot="card-title"]')?.textContent)).toEqual(['Brief', 'Pull request #412Open', 'Run'])
    const pr = cards[1]!
    expect(pr.querySelector('[data-slot="chip"][data-tone="success"]')?.textContent).toBe('Open')
    expect(pr.querySelector('[data-slot="card-action"]')?.textContent).toBe('Open')
    expect(pr.querySelector('[data-slot="code-text"]')?.textContent).toBe('fix/checkout')
    expect(pr.querySelector('[data-slot="text"][data-tone="danger"]')?.textContent).toBe('1 failed')
    expect(pr.querySelector('[data-slot="change-stats"]')).not.toBeNull()
    for (const [label, value, max, reading] of [['Budget', 3, 24, '3 of 24 rounds'], ['Without progress', 1, 3, '1 of 3 rounds']] as const) {
      const meter = view.container.querySelector(`[role="progressbar"][aria-label="${label}"]`)
      expect(meter?.getAttribute('aria-valuenow')).toBe(String(value))
      expect(meter?.getAttribute('aria-valuemax')).toBe(String(max))
      expect(meter?.textContent).toContain(reading)
    }
    expect(cards[2]!.querySelector('[data-slot="card-action"]')?.textContent).toBe('Flow file')
  } finally { view.close() }
})
it('omits unavailable summary facts and names the missing recordings once', () => {
  const fixture = runFixture()
  const view = render({ input: { ...fixture, execution: { ...fixture.execution, brief: null, revision: null, base: undefined, findings: undefined } } })
  try {
    expect(view.container.querySelectorAll('[data-slot="run-recording-gaps"]')).toHaveLength(1)
    expect(view.container.textContent).not.toContain('No brief recorded')
    expect(view.container.textContent).not.toContain('Revision not recorded')
    expect(view.container.textContent).not.toContain('Limit not recorded')
    expect(view.container.textContent).not.toContain('Seat not recorded')
  } finally { view.close() }
})

it('uses the wrapped Team state to omit the check retry act even if its Run is still running', () => {
  const view = render({ input: runFixture('running'), selectedRow: 'check-2-2', teamState: 'wrapped' })
  try {
    expect(view.container.textContent).toContain('This Team is wrapped')
    expect([...view.container.querySelectorAll('button')].some(one => one.textContent === 'Run again…')).toBe(false)
  } finally { view.close() }
})
it('uses a singular footer for a Run with one round', () => {
  const fixture = runFixture()
  const view = render({ input: { ...fixture, execution: { ...fixture.execution, rounds: fixture.execution.rounds.slice(0, 1) } } })
  try {
    expect(view.container.querySelector('[data-slot="inspector-footer"]')?.textContent).toContain('1 round')
    expect(view.container.querySelector('[data-slot="inspector-footer"]')?.textContent).not.toContain('1 rounds')
  } finally { view.close() }
})

it.each(['other Run', 'restored', 'stale CI', 'other-head CI', 'dirty diff', 'other-head diff', 'stale diff'] as const)(
  'keeps newer %s evidence out of the Run summary', scenario => {
    const fixture = runFixture()
    const current: Evidence[] = [
      { kind: 'pr', number: 412, head: 'abc123', state: 'open', url: 'https://example.com/pull/412' },
      { kind: 'ci', at: 'abc123', checks: [{ name: 'Verify', state: 'passed', url: null }] },
      { kind: 'diff', files: 3, added: 177, removed: 82, from: 'base123', to: 'abc123' },
    ]
    const observe = (fact: Evidence, n: number, freshness: Freshness = { state: 'fresh' }) => ({ by: null, freshness,
      record: { id: `scope-${n}`, observedAt: n, round: 1, fact,
        checkout: { root: '/work/demo', cwd: '/work/demo', commonDir: '/work/demo/.git', head: 'abc123', branch: 'fix/current' } } })
    const foreign: Evidence = scenario === 'other Run' || scenario === 'restored'
      ? { kind: 'pr', number: 999, head: 'other123', state: 'closed', url: 'https://example.com/pull/999' }
      : scenario.endsWith('CI')
        ? { kind: 'ci', at: scenario === 'other-head CI' ? 'other123' : 'abc123', checks: [{ name: 'Foreign', state: 'failed', url: null }] }
        : { kind: 'diff', files: 90, added: 999, removed: 888, from: 'base123', to: scenario === 'other-head diff' ? 'other123' : 'abc123', dirty: scenario === 'dirty diff' }
    const newer = observe(foreign, 100, scenario.startsWith('stale') ? { state: 'behind', commits: 1 } : { state: 'fresh' })
    const input = { ...fixture, evidence: { ...fixture.evidence, cards: [
      { card: 1, running: [], facts: current.map((fact, n) => observe(fact, n)) },
      { card: scenario === 'other Run' ? 999 : 1, running: [], facts: [{ ...newer,
        record: { ...newer.record, ...(scenario === 'restored' ? { restored: { at: 101 } } : {}) } }] },
    ] } }
    const view = render({ input })
    try {
      const pr = [...view.container.querySelectorAll('[data-slot="card"]')].find(card => card.querySelector('[data-slot="card-title"]')?.textContent?.startsWith('Pull request'))!
      expect(pr.querySelector('[data-slot="card-title"]')?.textContent).toBe('Pull request #412Open')
      expect(pr.textContent).toContain('1 passed')
      expect(pr.textContent).not.toContain('failed')
      expect(pr.querySelector('[data-slot="change-stats"]')?.textContent).toBe('+177−82')
    } finally { view.close() }
  },
)

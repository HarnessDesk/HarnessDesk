import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { runFixture, equivalentRunFixture } from '../preview/run-view-fixture'
import { shapeFixture } from '../preview/run-shapes-fixture'
import { runTimeline, type RunTimelineInput } from '../lib/run-timeline'
import { RunSteps } from './RunSteps'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const repeated = equivalentRunFixture
const mount = (input: RunTimelineInput, selectedRow: string | null = null) => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const onSelect = vi.fn()
  const render = (selected = selectedRow) => act(() => root.render(<RunSteps input={input} selectedRow={selected} onSelect={onSelect}
    renderRound={n => <button data-original-round={n} onClick={() => onSelect(`round-${n}`)}>Original round {n}</button>} />))
  render()
  return { container, onSelect, render, done: () => { act(() => root.unmount()); container.remove() } }
}

it('folds equal completed neighbors despite generated ids and times, and expansion retains every original action', () => {
  const { container, onSelect, done } = mount(repeated())
  try {
    const group = container.querySelector('[data-round-group]')!
    expect(group).not.toBeNull()
    expect(group.getAttribute('data-expanded')).toBe('false')
    expect(container.querySelectorAll('[data-original-round]')).toHaveLength(0)
    act(() => group.querySelector<HTMLButtonElement>('button')!.click())
    expect([...container.querySelectorAll('[data-original-round]')].map(one => one.getAttribute('data-original-round'))).toEqual(['1', '2'])
    act(() => container.querySelector<HTMLButtonElement>('[data-original-round="2"]')!.click())
    expect(onSelect).toHaveBeenCalledWith('round-2')
  } finally { done() }
})

it('reveals the selected original card and keeps expansion across selection changes', () => {
  const { container, render, done } = mount(repeated(), 'card-2-2')
  try {
    expect(container.querySelector('[data-round-group]')?.getAttribute('data-expanded')).toBe('true')
    expect(container.querySelector('[data-original-round="2"]')).not.toBeNull()
    render('round-1')
    expect(container.querySelector('[data-original-round="1"]')).not.toBeNull()
  } finally { done() }
})

it.each(['different-number', 'raw-outcome', 'failed', 'working', 'incomplete', 'missing-card', 'missing-outcome', 'attention'])('keeps %s records separate', reason => {
  let input = repeated()
  const cards = [...input.cards]
  if (reason === 'different-number') cards[1] = { ...cards[1]!, note: 'Published 13 checks' }
  if (reason === 'raw-outcome') cards[1] = { ...cards[1]!, outcome: 'published<script>different</script>' }
  if (reason === 'failed') cards[1] = { ...cards[1]!, outcome: 'fail' }
  if (reason === 'working') cards[1] = { ...cards[1]!, state: 'claimed', outcome: null }
  if (reason === 'missing-outcome') cards[1] = { ...cards[1]!, outcome: null }
  if (reason === 'missing-card') cards.splice(1, 1)
  if (reason === 'attention') input = { ...input, execution: { ...input.execution, state: 'stalled', end: { kind: 'unrouted', card: 2, outcome: 'published' } } }
  input = { ...input, cards, ...(reason === 'incomplete' ? { incompleteAttempts: new Set([2]) } : {}) }
  const { container, done } = mount(input)
  try {
    expect(container.querySelector('[data-round-group]')).toBeNull()
    expect(container.querySelectorAll('[data-original-round]')).toHaveLength(2)
  } finally { done() }
})

it.each(['failed-check', 'incomplete', 'working', 'unavailable'])('never folds equivalent %s visits', state => {
  const source = repeated()
  let input = source
  if (state === 'incomplete') input = { ...source, incompleteAttempts: new Set([1, 2]) }
  if (state === 'working') input = { ...source, cards: source.cards.map(card => ({ ...card, state: 'claimed', outcome: null })) }
  if (state === 'unavailable') input = { ...source, cards: [] }
  if (state === 'failed-check') input = { ...source,
    execution: { ...source.execution, rounds: source.execution.rounds.map(round => ({ ...round, role: 'verify', seats: [] })) },
    cards: source.cards.map(card => ({ ...card, title: 'Verify', outcome: 'fail' })),
    evidence: { room: source.execution.goal, stamp: 1, checks: [], refused: [], unreadable: null,
      cards: [1, 2].map(card => ({ card, running: [], facts: [{ by: null, freshness: { state: 'fresh' }, record: {
        id: `failed-${card}`, observedAt: card * 1000, round: card,
        fact: { kind: 'check', name: 'verify', run: 'pnpm verify', exit: 1, timedOut: false, dirty: false, at: 'abc123', tail: 'Failed 12 checks' },
      } }] })) },
  }
  const { container, done } = mount(input)
  try {
    expect(container.querySelector('[data-round-group]')).toBeNull()
    expect(container.querySelectorAll('[data-original-round]')).toHaveLength(2)
  } finally { done() }
})

const passedChecks = (): RunTimelineInput => {
  const source = shapeFixture('comparison')
  return { ...source, findings: [], execution: { ...source.execution, state: 'settled', end: { kind: 'complete' },
    rounds: [source.execution.rounds[0]!, ...[3, 4].map((card, index) => ({ ...source.execution.rounds[1]!, n: index + 2, cards: [card], state: 'closed' as const }))],
    operations: source.execution.operations.filter(one => one.card !== null && one.card <= 4),
  }, cards: source.cards.filter(card => card.id <= 4).map(card => card.id > 2 ? { ...card, state: 'done', outcome: 'pass', title: 'Verify the change', note: 'Tests passed' } : card),
    evidence: { ...source.evidence!, cards: source.evidence!.cards.filter(card => card.card <= 4).map(card => ({ ...card, facts: card.facts.map(view => ({
      ...view, record: { ...view.record, round: card.card > 2 ? card.card - 1 : 1,
        fact: view.record.fact.kind === 'diff' ? { ...view.record.fact, to: 'a'.repeat(40) }
          : view.record.fact.kind === 'check' ? { ...view.record.fact, at: 'a'.repeat(40), exit: 0, tail: 'Tests passed' } : view.record.fact },
    })) })) },
  }
}
it.each(['subject', 'checkout', 'branch'])('retains differing check %s provenance at the same revision, exit and output', context => {
  let input = passedChecks()
  if (context !== 'subject') input = { ...input, execution: { ...input.execution, rounds: input.execution.rounds.slice(1) },
    cards: input.cards.map(card => ({ ...card, dependsOn: [] })), evidence: { ...input.evidence!, cards: input.evidence!.cards.map(card => ({ ...card,
      facts: card.facts.map(view => ({ ...view, record: { ...view.record, checkout: context === 'branch'
        ? { cwd: '/repo/same-checkout', branch: `check-${card.card}` } : view.record.checkout } })),
    })) } }
  const checks = runTimeline(input).rows.filter(row => row.kind === 'check')
  expect(checks.map(row => row.status)).toEqual(['Passed', 'Passed'])
  if (context === 'subject') expect(checks.map(row => row.on)).toEqual(['Attempt A', 'Attempt B'])
  else expect(checks.map(row => row.on)).toEqual([null, null])
  const { container, done } = mount(input)
  try { expect(container.querySelector('[data-round-group]')).toBeNull() }
  finally { done() }
})
it('still folds passed neighboring checks with the same recorded subject and checkout', () => {
  const source = passedChecks()
  const input: RunTimelineInput = { ...source, execution: { ...source.execution, rounds: source.execution.rounds.slice(1) },
    cards: source.cards.map(card => ({ ...card, dependsOn: [] })),
    evidence: { ...source.evidence!, cards: source.evidence!.cards.map(card => ({ ...card, facts: card.facts.map(view => ({ ...view,
      record: { ...view.record, checkout: { cwd: '/repo/same-checkout', branch: 'checks' } },
    })) })) },
  }
  const { container, done } = mount(input)
  try { expect(container.querySelector('[data-round-group]')).not.toBeNull() }
  finally { done() }
})
it('retains recorded check history revisions and ordinals even when the latest result agrees', () => {
  const source = passedChecks()
  const input: RunTimelineInput = { ...source, execution: { ...source.execution, rounds: source.execution.rounds.slice(1) },
    cards: source.cards.map(card => ({ ...card, dependsOn: [] })),
    evidence: { ...source.evidence!, cards: source.evidence!.cards.map(card => ({ ...card, facts: card.facts.map(view => ({ ...view,
      record: { ...view.record, checkout: { cwd: '/repo/same-checkout', branch: 'checks' } },
    })) })) },
    attempts: new Map([3, 4].map(card => [card, [{ id: `history-${card}`, n: card - 2, at: card * 1000,
      commit: `earlier-revision-${card}`, exit: 0, timedOut: false, outcome: 'pass', tail: 'Tests passed' }]])),
  }
  const { container, done } = mount(input)
  try { expect(container.querySelector('[data-round-group]')).toBeNull() }
  finally { done() }
})

const reviewVisits = (state: 'partial' | 'uncertain' | 'local' | 'posted'): RunTimelineInput => {
  const source = repeated()
  return { ...source, execution: { ...source.execution, rounds: source.execution.rounds.map(round => ({ ...round, role: 'reviewer' })) },
    cards: source.cards.map(card => ({ ...card, outcome: 'approve', title: 'Review the change' })), publicationOn: true,
    findingRun: { run: source.execution.id, goal: source.execution.goal, round: 2, finished: 2, total: 2, embargoed: false,
      open: 0, blocking: 0, reason: 'The reviews remain readable.', ceilingStop: false, stamp: 'review-visits', publication: state,
      rounds: [1, 2].map(round => ({ round, state, reason: 'The reviews remain readable.', pr: state === 'local' ? null : 128, cards: [round] })),
      reviewersFinished: 2, reviewersTotal: 2, pendingExceptions: [], repair: null,
      boundPr: { repo: 'acme/storefront', pr: 128 }, unbound: null, undecidable: null,
    },
  }
}
it.each(['partial', 'uncertain', 'local'] as const)('keeps equivalent approved closed reviews separate when %s publication needs attention', state => {
  const input = reviewVisits(state)
  const reviews = runTimeline(input).rows.filter(row => row.kind === 'card')
  expect(reviews.every(row => !row.attention && row.publication?.needsYou)).toBe(true)
  const { container, done } = mount(input)
  try { expect(container.querySelector('[data-round-group]')).toBeNull(); expect(container.querySelectorAll('[data-original-round]')).toHaveLength(2) }
  finally { done() }
})
it('still folds equivalent completed reviews when their recorded publication is posted', () => {
  const { container, done } = mount(reviewVisits('posted'))
  try { expect(container.querySelector('[data-round-group]')).not.toBeNull() }
  finally { done() }
})

it('keeps repeated rounds, future steps, their states and selection in shared step rows', () => {
  const fixture = runFixture()
  const container = document.createElement('div')
  const root = createRoot(container)
  const select = vi.fn()
  const future = vi.fn()
  try {
    act(() => root.render(<RunSteps input={fixture} selectedRow={null} onSelect={select} onSelectStep={future} />))
    expect(container.querySelectorAll('[data-step-row]')).toHaveLength(5)
    expect(container.textContent).toContain('Taken')
    expect(container.textContent).toContain('Not reached')
    expect(container.textContent).toContain('Round 4')
    expect(container.querySelector('[data-selected]')).toBeNull()
    expect(container.querySelector('[data-slot="inspector-footer"]')).toBeNull()
    const buttons = [...container.querySelectorAll('button')]
    act(() => buttons[0]!.click())
    expect(select).toHaveBeenCalledWith('round-1')
    act(() => buttons.at(-1)!.click())
    expect(future).toHaveBeenCalledWith('person')
    expect(container.querySelector('[data-slot="inspector-footer"]')).toBeNull()
  } finally { act(() => root.unmount()) }
})
it('keeps check attempt counts unknown when the attempts read failed', () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() => root.render(<RunSteps input={runFixture('attempts')} attemptsRead="failed" selectedRow={null} onSelect={() => {}} />))
    const check = container.querySelectorAll('[data-step-row]')[1]!
    expect(check.querySelector('[data-slot="list-row-trail"]')?.textContent).toBe('Pass2m · —')
    expect(check.querySelector('[title="Run count unavailable"]')?.textContent).toBe('—')
    expect(check.querySelector('[data-slot="list-row-trail"]')?.textContent).not.toContain('2 runs')
  } finally { act(() => root.unmount()) }
})
it('uses kind tiles and chips, toned outcomes, and trailing time and counts while Round stays the second line', () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() => root.render(<RunSteps input={runFixture('attempts')} selectedRow={null} onSelect={() => {}} />))
    const rows = [...container.querySelectorAll('[data-step-row]')]
    expect(rows).toHaveLength(5)
    const chips = (row: Element) => [...row.querySelectorAll('[data-slot="chip"]')].map(chip => [chip.textContent, chip.getAttribute('data-tone')])
    expect(chips(rows[0]!)).toContainEqual(['Published', 'success'])
    expect(chips(rows[1]!)).toContainEqual(['Pass', 'success'])
    expect(chips(rows[2]!)).toContainEqual(['Request changes', 'warning'])
    expect(chips(rows[3]!)).toContainEqual(['Working', 'info'])
    expect(chips(rows[4]!)).toContainEqual(['Not reached', 'neutral'])
    expect(rows[1]!.querySelector('[data-slot="icon-tile"]')).toBeNull()
    expect(rows[1]!.querySelector('[data-slot="flow-row-mark"] svg')).not.toBeNull()
    expect(rows[4]!.querySelector('[data-slot="icon-tile"]')).toBeNull()
    expect(rows[4]!.querySelector('[data-slot="flow-row-mark"] svg')).not.toBeNull()
    expect(rows[1]!.querySelector('[data-slot="list-row-subtitle"]')?.textContent).toBe('Round 2')
    expect(rows[1]!.querySelector('[data-slot="list-row-trail"]')?.textContent).toContain('2 runs')
    expect(rows[1]!.querySelector('[data-slot="list-row-title"]')?.textContent).toContain('Check')
  } finally { act(() => root.unmount()) }
})
it('does not give a stopped step a live clock or a working chip', () => {
  const fixture = runFixture('running')
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() => root.render(<RunSteps input={{ ...fixture, execution: { ...fixture.execution, state: 'stopped', currentEndedAt: fixture.execution.startedAt! + 900_000 } }} selectedRow={null} onSelect={() => {}} />))
    expect(container.textContent).toContain('Stopped')
    expect(container.textContent).not.toContain('Working')
    expect(container.textContent).not.toContain('so far')
  } finally { act(() => root.unmount()) }
})

it('advances a running step on the clock and cancels its timer on unmount', () => {
  vi.useFakeTimers()
  const fixture = runFixture('running')
  const container = document.createElement('div')
  const root = createRoot(container)
  vi.setSystemTime(fixture.cards.at(-1)!.claim!.at + 60_000)
  try {
    act(() => root.render(<RunSteps input={fixture} selectedRow={null} onSelect={() => {}} />))
    const trail = () => container.querySelector('[data-step-row][data-state="working"] [data-slot="list-row-trail"]')?.textContent
    const before = trail()
    expect(before).toContain('1m')
    act(() => vi.advanceTimersByTime(60_000))
    expect(trail()).toContain('2m')
    expect(trail()).not.toBe(before)
  } finally {
    act(() => root.unmount())
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  }
})

it('a one-step Flow has no retired tool footer', () => {
  const fixture = runFixture()
  if (fixture.execution.document.format !== 'agents') throw new Error('expected an Agents Flow')
  const input = { ...fixture, execution: { ...fixture.execution, document: { format: 'agents' as const,
    flow: { ...fixture.execution.document.flow, roles: [fixture.execution.document.flow.roles[0]!], rules: [] } } } }
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() => root.render(<RunSteps input={input} selectedRow={null} onSelect={() => {}} />))
    expect(container.querySelector('[data-slot="inspector-footer"]')).toBeNull()
    expect(container.querySelector('[data-step-row="writer"]')).not.toBeNull()
  } finally { act(() => root.unmount()) }
})


it('Timeline selection follows every visit to the selected Flow step and preserves each round target', () => {
  const input = runFixture()
  const container = document.createElement('div'), root = createRoot(container), select = vi.fn()
  try {
    act(() => root.render(<RunSteps timeline input={input} selectedRow="round-1" onSelect={select} />))
    const visits = [...container.querySelectorAll('[data-step-row="writer"]')]
    expect(visits.length).toBeGreaterThan(1)
    for (const visit of visits) expect(visit.getAttribute('data-selected')).toBe('true')
    expect(container.querySelector('[data-step-row="verify"]')?.hasAttribute('data-selected')).toBe(false)
    act(() => visits.at(-1)!.querySelector<HTMLButtonElement>('button')!.click())
    expect(select).toHaveBeenCalledWith('card-4-4')
  } finally { act(() => root.unmount()) }
})

it('keeps a check interrupted by the desk distinct from a finished check on the Timeline', () => {
  const input = runFixture('stalled'), container = document.createElement('div'), root = createRoot(container)
  try {
    act(() => root.render(<RunSteps timeline input={input} selectedRow={null} onSelect={vi.fn()} />))
    expect(container.querySelector('[data-row="check-4-4"]')?.getAttribute('data-state')).toBe('warning')
    expect(container.querySelector('[data-row="check-2-2"]')?.getAttribute('data-state')).toBe('done')
  } finally { act(() => root.unmount()) }
})

it('keeps a review’s verdict as its line when the publication only says it stayed on this desk', () => {
  const input = { ...reviewVisits('local'), publicationOn: false }
  expect(runTimeline(input).rows.filter(row => row.kind === 'card').every(row => row.publication?.label === 'This desk only' && !row.publication.needsYou)).toBe(true)
  const container = document.createElement('div'), root = createRoot(container)
  try {
    act(() => root.render(<RunSteps input={input} selectedRow={null} onSelect={() => {}} recent={3} />))
    expect(container.textContent).not.toContain('This desk only')
    expect(container.textContent?.toLowerCase()).toContain('approve')
  } finally { act(() => root.unmount()); container.remove() }
})

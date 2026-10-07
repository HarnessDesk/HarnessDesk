import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { sessionId, sessionKey, turnId, WAITING_FINDINGS, type Session } from '@harnessdesk/protocol'
import { runTimeline } from '../lib/run-timeline'
import { overviewRun } from '../preview/team-overview-fixture'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { RunView } from './RunView'
import { runFixture } from '../preview/run-view-fixture'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('keeps a resumed Run Working with a ticking duration and doing line', () => {
  vi.useFakeTimers()
  const fixture = runFixture('running')
  const since = fixture.cards[3]!.claim!.at
  vi.setSystemTime(since + 60_000)
  const model = runTimeline({ ...fixture, execution: { ...fixture.execution, endedAt: since - 60_000, currentEndedAt: null } })
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() => root.render(<RunView model={model} number={1} selectedRow="card-4-4" onSelect={() => {}} doing={new Map([['seat-0', 'Editing the retry']])} />))
    const card = container.querySelector('[data-row="card-4-4"]')!
    expect(card.textContent).toContain('Working')
    expect(card.textContent).toContain('1m so far')
    expect(card.textContent).toContain('Editing the retry')
    act(() => vi.advanceTimersByTime(60_000))
    expect(card.textContent).toContain('2m so far')
  } finally { act(() => root.unmount()); vi.useRealTimers() }
})

it('shows a stopped claimed card as quiet Stopped with a frozen clock and no doing line', () => {
  vi.useFakeTimers()
  const fixture = runFixture('running')
  const since = fixture.cards[3]!.claim!.at
  const model = runTimeline({ ...fixture, execution: { ...fixture.execution, state: 'stopped', endedAt: since + 60_000, currentEndedAt: since + 60_000, end: { kind: 'stopped', by: 'person' } } })
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() => root.render(<RunView model={model} number={1} selectedRow="card-4-4" onSelect={() => {}} doing={new Map([['seat-0', 'Editing the retry']])} />))
    const card = container.querySelector('[data-row="card-4-4"]')!
    expect(card.textContent).toContain('Stopped')
    expect(card.textContent).toContain('1m')
    expect(card.querySelector('[data-slot="chip"]')).toBeNull()
    expect(card.textContent).not.toMatch(/Working|so far|Editing the retry/)
    const frozen = card.textContent
    act(() => vi.advanceTimersByTime(60_000))
    expect(card.textContent).toBe(frozen)
  } finally { act(() => root.unmount()); vi.useRealTimers() }
})

it('selects a stable row id and sanitizes the brief and in-flight words', () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const onSelect = vi.fn()
  const execution = { ...overviewRun(), operations: [{ key: 'seat-1', kind: 'seat' as const, state: 'finished' as const, card: 1, seat: 'seat-0' }], brief: '<script>secret</script>Retry <b>the call</b>' }
  const model = runTimeline({ execution, cards: [{ id: 1, title: 'Build', state: 'claimed', files: [], dependsOn: [], createdAt: 1, updatedAt: 1 }] })
  try {
    act(() => root.render(<RunView model={model} number={1} selectedRow={null} onSelect={onSelect} doing={new Map([['seat-0', 'Editing src/retry.ts']])} />))
    expect(container.textContent).toContain('Run 1')
    expect(container.textContent).toContain('Retry the call')
    expect(container.textContent).not.toContain('secret')
    expect(container.textContent).toContain('Editing src/retry.ts')
    act(() => (container.querySelector('[data-row="card-1-1"]') as HTMLButtonElement).click())
    expect(onSelect).toHaveBeenCalledWith('card-1-1')
  } finally { act(() => root.unmount()); container.remove() }
})

it('shows the empty timeline when the Run has a brief but no rounds yet', () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const model = runTimeline({ execution: { ...overviewRun(), brief: 'Retry the call', rounds: [] }, cards: [] })
  try {
    act(() => root.render(<RunView model={model} number={1} selectedRow={null} onSelect={() => {}} />))
    expect(container.textContent).toContain('No rounds have opened yet')
  } finally { act(() => root.unmount()) }
})

it('reads Start with the existing short clock, without seconds or a raw locale date', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 3, 12, 45))
  const container = document.createElement('div')
  const root = createRoot(container)
  const model = runTimeline({ execution: { ...overviewRun(), startedAt: new Date(2026, 9, 3, 12, 34, 56).getTime() }, cards: [] })
  try {
    act(() => root.render(<RunView model={model} number={1} selectedRow={null} onSelect={() => {}} />))
    const start = container.querySelector('[data-kind="start"]')!.textContent
    expect(start).toContain('12:34')
    expect(start).not.toContain('12:34:56')
    expect(start).not.toContain('/2026')
  } finally { act(() => root.unmount()); vi.useRealTimers() }
})

const withFlow = (props: Partial<Parameters<typeof RunView>[0]> = {}) => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const model = runTimeline({ execution: { ...overviewRun(), brief: 'Retry the call' }, cards: [{ id: 1, title: 'Build', state: 'claimed', files: [], dependsOn: [], createdAt: 1, updatedAt: 1 }] })
  act(() => root.render(<RunView model={model} number={1} selectedRow={null} onSelect={() => {}} flow={<p data-testid="the-flow">The drawing</p>} {...props} />))
  return { container, done: () => { act(() => root.unmount()); container.remove() } }
}

it.each(['running', 'stopped', 'settled', 'stalled'] as const)('offers Stop run… in the header only when the Run is running (%s)', state => {
  const onStop = vi.fn()
  const { container, done } = withFlow({ model: runTimeline({ execution: overviewRun(state), cards: [] }), onStop })
  try {
    const stop = [...container.querySelectorAll<HTMLButtonElement>('[data-slot="run-header"] button')].find(one => one.textContent === 'Stop run…')
    if (state === 'running') { expect(stop).toBeDefined(); act(() => stop!.click()); expect(onStop).toHaveBeenCalledOnce() }
    else expect(stop).toBeUndefined()
  } finally { done() }
})
it('does not invent a new ending door for a legacy Run without an end kind', () => {
  const { container, done } = withFlow({ model: runTimeline({ execution: { ...runFixture('stopped').execution, end: undefined }, cards: [] }), onRunAgain: () => {} })
  try { expect(container.querySelectorAll('[data-slot="run-ending"] button')).toHaveLength(1); expect(container.querySelector('[data-slot="run-ending"] button')?.textContent).toBe('End') } finally { done() }
})
const choice = (container: HTMLElement, name: string): HTMLButtonElement =>
  [...container.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Show the Run as"] [role="radio"]')].find(one => one.textContent === name)!

it('keeps recorded Run facts and controls in the header on both views', () => {
  const execution = { ...runFixture('running').execution, startedAt: 1000 }
  const { container, done } = withFlow({ model: runTimeline(runFixture('running')), execution, cost: 'Seat cost $1.20', onStop: vi.fn() })
  try {
    const header = container.querySelector('[data-slot="run-header"]')!
    const facts = header.querySelector('[data-slot="run-facts"]')!
    expect(facts.textContent).toContain('Started')
    expect(facts.textContent).toContain('Elapsed')
    expect(facts.textContent).toContain('Round 4')
    expect(facts.textContent).toContain('Seat cost $1.20')
    const actions = header.querySelector('[data-slot="run-actions"]')!
    expect(actions.textContent).toMatch(/Stop run…TimelineFlow/)
    act(() => choice(container, 'Flow').click())
    expect(header.querySelector('[data-slot="run-facts"]')).toBe(facts)
    expect(header.querySelector('[data-slot="run-actions"]')).toBe(actions)
  } finally { done() }
})

it('keeps round times above their selectable titles and ticks the active duration', () => {
  const { container, done } = withFlow({ model: runTimeline(runFixture('running')) })
  try {
    for (const round of container.querySelectorAll('[data-kind="round"]')) {
      expect(round.querySelector('[data-slot="timeline-heading"]')!.textContent).not.toMatch(/\d+m|so far/)
    }
    expect(container.querySelector('[data-row="round-4"] [data-slot="timeline-meta"]')!.textContent).toContain('so far')
  } finally { done() }
})

it('raises one need card with the recorded reason and existing recovery actions above both views', () => {
  const model = runTimeline(runFixture('stalled'))
  const onReviewCheck = vi.fn()
  const { container, done } = withFlow({ model, onReviewCheck })
  try {
    const need = container.querySelector('[data-slot="run-need"]')!
    expect(need.textContent).toContain('The desk stopped while the check ran')
    expect(need.querySelectorAll('button')).toHaveLength(1)
    expect(need.querySelector('button')!.getAttribute('data-variant')).toBe('default')
    act(() => need.querySelector('button')!.click())
    expect(onReviewCheck).toHaveBeenCalledOnce()
    expect(container.querySelector('[data-slot="run-ending"]')!.textContent).not.toContain('The desk stopped while the check ran')
    expect(container.querySelector('[data-slot="run-header"]')!.textContent).not.toContain('Needs you')
    act(() => choice(container, 'Flow').click())
    expect(container.querySelector('[data-slot="run-need"]')).not.toBeNull()
  } finally { done() }
})

it('offers a person step once and opens its existing inspector', () => {
  const model = runTimeline(runFixture('person'))
  const onSelect = vi.fn()
  const { container, done } = withFlow({ model, onSelect })
  try {
    const need = container.querySelector('[data-slot="run-need"]')!
    expect(need.textContent).toContain('Answer the review')
    act(() => need.querySelector('button')!.click())
    expect(onSelect).toHaveBeenCalledWith('person-4-4')
    expect(container.querySelector('[data-kind="person"]')!.textContent).not.toContain('Needs you')
  } finally { done() }
})

it.each([
  ['complete', 'Wrap'], ['settled', 'Run again…'], ['stopped', 'Run again…'], ['stalled', 'Review and run again…'],
] as const)('gives %s an ending summary and an independent door', (scene, label) => {
  const onRunAgain = vi.fn(), onWrap = vi.fn(), onBoard = vi.fn(), onReviewCheck = vi.fn(), onSelect = vi.fn()
  const { container, done } = withFlow({ model: runTimeline(runFixture(scene)), onRunAgain, onWrap, onBoard, onReviewCheck, onSelect })
  try {
    const banner = container.querySelector('[data-slot="run-ending"]')!
    expect(banner).not.toBeNull()
    const actions = container.querySelector('[data-slot="run-need"]') ?? banner
    const button = [...actions.querySelectorAll('button')].find(one => one.textContent === label)!
    expect(button.parentElement?.closest('button')).toBeNull()
    act(() => button.click())
    expect(scene === 'complete' ? onWrap : scene === 'stalled' ? onReviewCheck : onRunAgain).toHaveBeenCalledOnce()
    if (scene === 'settled') {
      act(() => [...actions.querySelectorAll('button')].find(one => one.textContent === 'Board')!.click())
      expect(onBoard).toHaveBeenCalledOnce()
    }
    expect(onSelect).not.toHaveBeenCalled()
  } finally { done() }
})

it.each(['rounds', 'without-progress'] as const)('names the %s budget and its recorded count even without a reason', which => {
  const execution = { ...runFixture('stalled').execution, operations: [], end: { kind: 'budget' as const, which, used: 7 }, reason: null }
  const { container, done } = withFlow({ model: runTimeline({ execution, cards: [] }), onRunAgain: () => {} })
  try {
    expect(container.querySelector('[data-slot="run-need"]')!.textContent).toContain('7')
    expect(container.querySelector('[data-slot="run-need"]')!.textContent).toContain('Run again…')
  } finally { done() }
})

it('opens the frozen Flow from the revision button', () => {
  const { container, done } = withFlow()
  try {
    const revision = container.querySelector<HTMLButtonElement>('[data-slot="run-revision"]')!
    expect(revision).not.toBeNull()
    act(() => revision.click())
    expect(container.querySelector('[data-testid="the-flow"]')).not.toBeNull()
  } finally { done() }
})

it('has no switch when there is no Flow to show', () => {
  const { container, done } = withFlow({ flow: undefined })
  try {
    expect(container.querySelector('[role="radiogroup"]')).toBeNull()
    expect(container.querySelector('[aria-label="Run timeline"]')).not.toBeNull()
  } finally { done() }
})

it('opens on the timeline, with the Flow one choice away in the header', () => {
  const { container, done } = withFlow()
  try {
    const header = container.querySelector('[data-slot="run-header"]')!
    expect([...header.querySelectorAll('[role="radio"]')].map(one => one.textContent)).toEqual(['Timeline', 'Flow'])
    expect(choice(container, 'Timeline').getAttribute('aria-checked')).toBe('true')
    expect(container.querySelector('[aria-label="Run timeline"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="the-flow"]')).toBeNull()
  } finally { done() }
})

it('swaps the timeline for the Flow, keeps the header, and swaps back', () => {
  const { container, done } = withFlow()
  try {
    act(() => choice(container, 'Flow').click())
    expect(container.querySelector('[data-testid="the-flow"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Run timeline"]')).toBeNull()
    expect(container.querySelector('[data-slot="run-header"]')!.textContent).toContain('Run 1')
    act(() => choice(container, 'Timeline').click())
    expect(container.querySelector('[data-testid="the-flow"]')).toBeNull()
    expect(container.querySelector('[aria-label="Run timeline"]')).not.toBeNull()
  } finally { done() }
})

it('answers to a caller that chooses the view, and says what was chosen', () => {
  const onView = vi.fn()
  const { container, done } = withFlow({ view: 'flow', onView })
  try {
    expect(container.querySelector('[data-testid="the-flow"]')).not.toBeNull()
    expect(choice(container, 'Flow').getAttribute('aria-checked')).toBe('true')
    act(() => choice(container, 'Timeline').click())
    expect(onView).toHaveBeenCalledWith('timeline')
    expect(container.querySelector('[data-testid="the-flow"]')).not.toBeNull()
  } finally { done() }
})

/*
 * A check run again: its row offers *Run again…* beside it, and a check with
 * more than one result draws each under the card. The control is the row's
 * sibling and never inside it (a button inside a button), and pressing it asks
 * the host, never selecting the row.
 */
const GATE = (patch: Partial<ReturnType<typeof overviewRun>> = {}) => ({ ...overviewRun(), brief: null,
  rounds: [{ n: 1, role: 'verify', cards: [1], seats: [], evidence: [], state: 'closed' as const, cause: 'seed' }],
  operations: [{ key: 'check:1:0', kind: 'check' as const, state: 'finished' as const, card: 1, seat: null }],
  document: { format: 'agents' as const, flow: { version: 2 as const, name: 'Gate', inputs: [], messaging: 'board-only' as const, wait: 1, rules: [], seed: { role: 'verify', title: 'Check' },
    roles: [{ id: 'verify', kind: 'check' as const, check: { run: 'pnpm verify', timeout: 60, exits: { '0': 'pass' }, otherwise: 'fail' } }] } },
  ...patch })
const DONE = { id: 1, title: 'Verify', state: 'done' as const, outcome: 'pass', files: [], dependsOn: [], createdAt: 1, updatedAt: 2 }
const ATTEMPTS = new Map([[1, [
  { id: 'attempt-1', n: 1, at: Date.now() - 600_000, commit: 'abc', exit: 1, timedOut: false, outcome: 'fail', tail: 'FAIL' },
  { id: 'attempt-2', n: 2, at: Date.now() - 60_000, commit: 'abc', exit: 0, timedOut: false, outcome: 'pass', tail: 'ok' },
]]])

const mountGate = (execution: ReturnType<typeof GATE>, extra: Partial<Parameters<typeof runTimeline>[0]> = {}, selectedRows?: readonly string[]) => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const previewFlowRetry = vi.fn(async () => new Promise<never>(() => {}))
  const store = { subscribe: () => () => {}, getSnapshot: () => emptySnapshot(), previewFlowRetry } as unknown as AppStore
  const onSelect = vi.fn()
  const model = runTimeline({ execution, cards: [DONE], ...extra })
  act(() => root.render(<StoreProvider store={store}><RunView model={model} number={1} selectedRow={null} selectedRows={selectedRows} onSelect={onSelect} /></StoreProvider>))
  return { container, onSelect, previewFlowRetry, done: () => { act(() => root.unmount()); container.remove() } }
}

it('offers Run again… beside a check that may be asked again — outside the row’s own button, and without selecting it', () => {
  const { container, onSelect, previewFlowRetry, done } = mountGate(GATE())
  try {
    const again = [...container.querySelectorAll('button')].find(one => one.textContent === 'Run again…')!
    const row = container.querySelector('[data-row="check-1-1"]') as HTMLButtonElement
    expect(again).toBeDefined()
    expect(row.querySelector('[data-slot="list-row-trail"]')?.contains(again)).toBe(true)
    expect(again.closest('button')?.parentElement?.closest('button')).toBeNull()
    expect(row.closest('[data-slot="run-view"]')!.contains(again)).toBe(true)
    act(() => again.click())
    expect(previewFlowRetry).toHaveBeenCalledWith(GATE().id, 1)
    expect(onSelect).not.toHaveBeenCalled()
  } finally { done() }
})

it('shows no Run again… on a check that cannot be asked again, and none on a row that is not a check', () => {
  for (const execution of [GATE({ state: 'settled' }), GATE({ operations: [] }), { ...GATE(), rounds: [{ ...GATE().rounds[0]!, role: 'writer' }] }]) {
    const { container, done } = mountGate(execution)
    try { expect([...container.querySelectorAll('button')].some(one => one.textContent === 'Run again…')).toBe(false) } finally { done() }
  }
})

it('draws each attempt under a check that ran more than once, oldest first, as plain rows that select nothing', () => {
  const { container, onSelect, done } = mountGate(GATE(), { attempts: ATTEMPTS })
  try {
    const order = [...container.querySelectorAll('[data-row]')].map(one => one.getAttribute('data-row'))
    expect(order).toEqual(['start', 'round-1', 'check-1-1', 'attempt-1-1-1', 'attempt-1-1-2'])
    const [first, second] = ['attempt-1-1-1', 'attempt-1-1-2'].map(id => container.querySelector(`[data-row="${id}"]`) as HTMLElement) as [HTMLElement, HTMLElement]
    expect(first.textContent).toContain('Attempt 1')
    expect(first.textContent).toContain('Failed')
    expect(second.textContent).toContain('Attempt 2')
    expect(second.textContent).toContain('Passed')
    expect(first.tagName).not.toBe('BUTTON')
    act(() => first.click())
    expect(onSelect).not.toHaveBeenCalled()
  } finally { done() }
})

it('draws no attempt rows for a check with one result', () => {
  const { container, done } = mountGate(GATE(), { attempts: new Map([[1, ATTEMPTS.get(1)!.slice(0, 1)]]) })
  try { expect(container.querySelector('[data-kind="attempt"]')).toBeNull() } finally { done() }
})

it('highlights the passive attempt rows with their selected Flow step without making them controls', () => {
  const selected = ['round-1', 'check-1-1', 'attempt-1-1-1', 'attempt-1-1-2']
  const { container, onSelect, done } = mountGate(GATE(), { attempts: ATTEMPTS }, selected)
  try {
    expect([...container.querySelectorAll('[aria-current="true"]')].map(one => one.getAttribute('data-row'))).toEqual(selected)
    const attempt = container.querySelector<HTMLElement>('[data-row="attempt-1-1-1"]')!
    expect(attempt.tagName).not.toBe('BUTTON')
    act(() => attempt.click())
    expect(onSelect).not.toHaveBeenCalled()
  } finally { done() }
})

it.each(['complete','stopped','stalled'] as const)('keeps %s status in the header and one selectable ending summary',scene=>{
 const model=runTimeline(runFixture(scene))
 const onSelect=vi.fn()
 const {container,done}=withFlow({model,onSelect})
 try {
  const ending=container.querySelector('[data-slot="run-ending"]')!
  expect(ending.querySelectorAll('[data-slot="chip"]')).toHaveLength(0)
  expect(ending.textContent).not.toContain(scene==='complete'?'Settled':scene==='stopped'?'Stopped':'Needs you')
  expect(container.querySelectorAll('[data-row="end"]')).toHaveLength(1)
  expect(ending.querySelector('[data-slot="timeline-heading"]')).not.toBeNull()
  expect(ending.querySelectorAll('[data-tone="warning"]')).toHaveLength(0)
  expect(container.querySelectorAll('[data-slot="run-need"]')).toHaveLength(scene==='stalled'?1:0)
  act(()=> (ending.querySelector('[data-slot="timeline-heading"] button') as HTMLButtonElement).click())
  expect(onSelect).toHaveBeenCalledWith('end')
  if(scene==='complete')expect(ending.textContent).toContain('Nothing waits.')
 } finally {done()}
})

it('shortens the Timeline check command while keeping its full hover title', () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() => root.render(<RunView model={runTimeline(runFixture('live-polish'))} home="/home/dev" number={1} selectedRow={null} onSelect={() => {}} />))
    const check = container.querySelector('[data-row="check-2-2"]')!
    expect(check.textContent).toContain('PATH=/usr/bin:~/bin node ~/tools/land.mjs --check')
    expect(check.querySelector('[title="PATH=/usr/bin:/home/dev/bin node /home/dev/tools/land.mjs --check"]')).not.toBeNull()
  } finally { act(() => root.unmount()) }
})

it('keeping the portalled Run again dialog does not select its check row', async () => {
  const { container, onSelect, done } = mountGate(GATE())
  try {
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === 'Run again…')!.click())
    const keep = [...document.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === 'Keep')!
    expect(keep).toBeDefined()
    await act(async () => keep.click())
    expect(onSelect).not.toHaveBeenCalled()
  } finally { done() }
})

it('a retryable check has a named row button independent of Run again',()=>{
 const {container,onSelect,done}=mountGate(GATE())
 try {
  const row=container.querySelector('[data-row="check-1-1"]')!
  const open=row.querySelector<HTMLButtonElement>('[data-slot="list-row-title"] button')
  expect(open).not.toBeNull()
  expect(open!.hasAttribute('aria-label')).toBe(false)
  expect(open!.textContent).toContain('Pass')
  act(()=>open!.click())
  expect(onSelect).toHaveBeenCalledOnce()
 } finally {done()}
})

it('groups quiet records under a step and puts the recorded time above its title', () => {
  const model = runTimeline(runFixture('running'))
  const { container, done } = withFlow({ model })
  try {
    const timeline = container.querySelector('ol[data-slot="timeline"]')
    expect(timeline).not.toBeNull()
    const round = container.querySelector('[data-row="round-1"]')!
    const step = round.closest('[data-slot="timeline-item"]')!
    expect(step.querySelector('[data-row="card-1-1"]')).not.toBeNull()
    const summary = step.querySelector('[data-slot="timeline-summary"]')!
    expect([...summary.children].map(child => child.getAttribute('data-slot'))).toEqual(['timeline-meta', 'timeline-heading', 'timeline-detail'])
    expect(summary.querySelector('[data-slot="timeline-meta"]')!.textContent).toContain('·')
    expect(container.querySelector('[data-slot="run-time"]')).toBeNull()
    expect(container.querySelector('[data-row="round-4"]')!.closest('[data-slot="timeline-item"]')!.getAttribute('data-state')).toBe('active')
    expect(step.getAttribute('data-state')).toBe('done')
  } finally { done() }
})

it('omits unavailable timeline times and gives an unreached step a pending ring', () => {
  const source = runTimeline(runFixture('running'))
  const model = { ...source, rows: source.rows.map(row => ({ ...row, since: null, durationMs: null, working: false, status: row.kind === 'card' ? 'Waiting' : row.status })) }
  const { container, done } = withFlow({ model })
  try {
    expect(container.querySelector('[data-slot="timeline-meta"]')).toBeNull()
    expect(container.querySelector('[data-slot="timeline"]')!.textContent).not.toMatch(/Unknown|—/)
    expect(container.querySelector('[data-row="round-4"]')!.closest('[data-slot="timeline-item"]')!.getAttribute('data-state')).toBe('pending')
  } finally { done() }
})

it.each(['stalled', 'person'] as const)('puts the %s attention state on the step ring', scene => {
  const { container, done } = withFlow({ model: runTimeline(runFixture(scene)) })
  try {
    const step = container.querySelector('[data-row="round-4"]')!.closest('[data-slot="timeline-item"]')!
    expect(step.getAttribute('data-state')).toBe('warning')
    expect(step.querySelector('[data-slot="timeline-indicator"]')!.getAttribute('aria-label')).toBe('Needs attention')
  } finally { done() }
})

it('judges a retried check by its current result while keeping failed attempts visible', () => {
  const fixture = runFixture('attempts')
  const { container, done } = withFlow({ model: runTimeline(fixture), execution: fixture.execution })
  try {
    const step = container.querySelector('[data-row="round-2"]')!.closest('[data-slot="timeline-item"]')!
    expect(step.querySelector('[data-kind="check"]')!.textContent).toContain('Passed')
    expect(step.querySelector('[data-row="attempt-2-2-1"]')!.textContent).toContain('Failed')
    expect(step.getAttribute('data-state')).toBe('done')
    expect(step.querySelector('[data-slot="timeline-indicator"]')!.getAttribute('aria-label')).toBe('Finished')
  } finally { done() }
})

it.each([false, true])('keeps a round stopped mid-work pending even though Stop closed it (live turn: %s)', busy => {
  const fixture = runFixture('running')
  const execution = { ...fixture.execution, state: 'stopped' as const, end: { kind: 'stopped' as const, by: 'person' as const },
    currentEndedAt: fixture.execution.startedAt! + 900_000, rounds: fixture.execution.rounds.map(round => ({ ...round, state: 'closed' as const })) }
  const claim = fixture.cards[3]!.claim!
  const session: Session = { runtime: claim.runtime, id: sessionId(claim.sessionId), cwd: '/repo', createdAt: claim.at, updatedAt: claim.at,
    itemsLoaded: true, status: { type: busy ? 'active' : 'idle' },
    turns: [{ id: turnId('stopped-turn'), startedAt: claim.at, status: busy ? 'inProgress' : 'completed', items: [] }] }
  const sessions = new Map([[sessionKey(claim.runtime, claim.sessionId), session]])
  const { container, done } = withFlow({ model: runTimeline({ ...fixture, execution, sessions }), execution })
  try {
    const step = container.querySelector('[data-row="round-4"]')!.closest('[data-slot="timeline-item"]')!
    expect(step.textContent).toContain('0 of 1 answered')
    expect(step.querySelector('[data-kind="card"]')!.textContent).toContain(busy ? 'Stopping' : 'Stopped')
    expect(step.getAttribute('data-state')).toBe('pending')
    expect(step.querySelector('[data-slot="timeline-indicator"]')!.getAttribute('aria-label')).toBe('Pending')
  } finally { done() }
})

it.each(['running', 'person'] as const)('keeps the closed %s round pending after Stop leaves its card open', scene => {
  const fixture = runFixture(scene)
  const execution = { ...fixture.execution, state: 'stopped' as const, end: { kind: 'stopped' as const, by: 'person' as const },
    currentEndedAt: fixture.execution.startedAt! + 900_000, rounds: fixture.execution.rounds.map(round => ({ ...round, state: 'closed' as const })) }
  const cards = fixture.cards.map(card => card.id === 4 ? { ...card, state: 'open' as const, claim: null, outcome: null } : card)
  const model = runTimeline({ ...fixture, execution, cards })
  // The round fact also works for callers that only have the timeline model.
  for (const recorded of [execution, undefined]) {
    const { container, done } = withFlow({ model, execution: recorded })
    try {
      const step = container.querySelector('[data-row="round-4"]')!.closest('[data-slot="timeline-item"]')!
      expect(step.textContent).toContain('0 of 1 answered')
      expect(step.querySelector(`[data-kind="${scene === 'person' ? 'person' : 'card'}"]`)!.textContent).toContain('Waiting')
      expect(step.getAttribute('data-state')).toBe('pending')
      expect(step.querySelector('[data-slot="timeline-indicator"]')!.getAttribute('aria-label')).toBe('Pending')
      expect(container.querySelector('[data-row="round-1"]')!.closest('[data-slot="timeline-item"]')!.getAttribute('data-state')).toBe('done')
    } finally { done() }
  }
})

it.each(['fail', 'failed', 'timed out', 'did not finish'])('tones an agent outcome %s as a failed step', outcome => {
  const fixture = runFixture('running')
  const cards = fixture.cards.map(card => card.id === 3 ? { ...card, outcome } : card)
  const { container, done } = withFlow({ model: runTimeline({ ...fixture, cards }), execution: fixture.execution })
  try {
    const step = container.querySelector('[data-row="round-3"]')!.closest('[data-slot="timeline-item"]')!
    expect(step.getAttribute('data-state')).toBe('danger')
    expect(step.querySelector('[data-slot="timeline-indicator"]')!.getAttribute('aria-label')).toBe('Failed')
  } finally { done() }
})

it.each([null, WAITING_FINDINGS(2)])('keeps a started evidence wait visible (%s)', reason => {
  const fixture = runFixture('running')
  const execution = { ...fixture.execution, reason, rounds: fixture.execution.rounds.map(round => round.n === 4 ? { ...round, state: 'waiting-evidence' as const } : round) }
  const cards = fixture.cards.map(card => card.id === 4 ? { ...card, state: 'done' as const, outcome: 'published' } : card)
  const model = runTimeline({ ...fixture, execution, cards })
  const { container, done } = withFlow({ model, execution })
  try {
    const step = container.querySelector('[data-row="round-4"]')!.closest('[data-slot="timeline-item"]')!
    expect(step.textContent).toContain('1 of 1 answered')
    expect(step.getAttribute('data-state')).toBe(reason ? 'warning' : 'active')
    if (reason) expect(container.querySelector('[data-slot="run-need"]')!.textContent).toContain(reason)
    else expect(container.querySelector('[data-slot="run-need"]')).toBeNull()
  } finally { done() }
})

it('keeps End selectable with plain title styling and independent actions', () => {
  const onSelect = vi.fn()
  const { container, done } = withFlow({ model: runTimeline(runFixture('complete')), onSelect, onWrap: vi.fn() })
  try {
    const end = container.querySelector('[data-kind="end"]')!
    const title = end.querySelector<HTMLButtonElement>('[data-slot="timeline-heading"] button')!
    expect(title.textContent).toBe('End')
    expect(title.getAttribute('data-variant')).toBe('row')
    act(() => title.click())
    expect(onSelect).toHaveBeenCalledWith('end')
    expect(title.querySelector('button')).toBeNull()
  } finally { done() }
})


it('keeps the ended person step out of Answer and preserves both unrouted doors', () => {
  const fixture = runFixture('person')
  const execution = { ...fixture.execution, state: 'settled' as const, end: { kind: 'unrouted' as const, card: 4, outcome: 'no-pr' }, reason: 'No rule follows this answer.' }
  const cards = fixture.cards.map(card => card.id === 4 ? { ...card, state: 'done' as const, outcome: 'no-pr' } : card)
  const onRunAgain = vi.fn(), onBoard = vi.fn(), onSelect = vi.fn()
  const { container, done } = withFlow({ model: runTimeline({ ...fixture, execution, cards }), onRunAgain, onBoard, onSelect })
  try {
    const need = container.querySelector('[data-slot="run-need"]')!
    const buttons = [...need.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons.map(button => button.textContent)).toEqual(['Run again…', 'Board'])
    act(() => buttons[0]!.click())
    act(() => buttons[1]!.click())
    expect(onRunAgain).toHaveBeenCalledOnce()
    expect(onBoard).toHaveBeenCalledOnce()
    expect(onSelect).not.toHaveBeenCalled()
    expect(need.textContent).toContain('No rule follows this answer.')
  } finally { done() }
})

it('preserves Wrap in the need card when a complete Run has a waiting publication', () => {
  const source = runTimeline(runFixture('complete'))
  const model = { ...source, header: { ...source.header, needsYou: true } }
  const onWrap = vi.fn()
  const { container, done } = withFlow({ model, onWrap })
  try {
    const wrap = container.querySelector<HTMLButtonElement>('[data-slot="run-need"] button')!
    expect(wrap.textContent).toBe('Wrap')
    act(() => wrap.click())
    expect(onWrap).toHaveBeenCalledOnce()
  } finally { done() }
})

it('says what a person step waits for and omits a round fact before any round opens', () => {
  const waiting = withFlow({ model: runTimeline(runFixture('person')) })
  try { expect(waiting.container.querySelector('[data-slot="run-need"]')!.textContent).toContain('Waiting for your answer') } finally { waiting.done() }
})

it('omits a round fact before any round opens', () => {
  const empty = withFlow({ model: runTimeline(runFixture('empty')) })
  try { expect(empty.container.querySelector('[data-slot="run-facts"]')!.textContent).not.toContain('Round') } finally { empty.done() }
})

it.each([0, 86_400_000])('uses the same dated clock in the header and timeline (%s ms old)', age => {
  vi.useFakeTimers()
  const now = new Date('2026-10-06T12:34:00').getTime()
  vi.setSystemTime(now)
  const fixture = runFixture('complete')
  const at = now - age
  const execution = { ...fixture.execution, startedAt: at, endedAt: at, currentEndedAt: at }
  const { container, done } = withFlow({ model: runTimeline({ ...fixture, execution }), execution })
  try {
    const clock = age === 0 ? new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    expect(container.querySelector('[data-slot="run-facts"]')!.textContent).toContain(`Started ${clock}`)
    expect(container.querySelector('[data-kind="start"] [data-slot="timeline-meta"]')!.textContent).toContain(clock)
    expect(container.querySelector('[data-kind="end"] [data-slot="timeline-meta"]')!.textContent).toContain(clock)
  } finally { done(); vi.useRealTimers() }
})

it.each(['settled', 'stopped'] as const)('keeps the timeline consent mounted when its Run becomes %s', async state => {
  const fixture = runFixture('running')
  const retryFlowCheck = vi.fn(async () => ({}))
  const store = {
    subscribe: () => () => {}, getSnapshot: () => emptySnapshot(), retryFlowCheck,
    previewFlowRetry: vi.fn(async () => ({ token: 'consent-1', commands: [], problems: [] })),
  } as unknown as AppStore
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const onSelect = vi.fn()
  const render = async (ended: boolean) => {
    const execution = ended ? { ...fixture.execution, state } : fixture.execution
    await act(async () => root.render(<StoreProvider store={store}><RunView model={runTimeline({ ...fixture, execution })} number={1} selectedRow={null} onSelect={onSelect} /></StoreProvider>))
  }
  try {
    await render(false)
    const opener = [...container.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === 'Run again…')!
    await act(async () => opener.click())
    const dialog = document.querySelector('[role="alertdialog"]')!
    expect(dialog).not.toBeNull()
    await render(true)
    expect(document.querySelector('[role="alertdialog"]')).toBe(dialog)
    expect(dialog.textContent).toContain(`This run is ${state}. Start a new run to run this check again.`)
    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === 'Run again')!
    expect(confirm.disabled).toBe(true)
    await act(async () => confirm.click())
    expect(retryFlowCheck).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
    await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === 'Keep')!.click())
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(container.textContent).not.toContain('Run again…')
  } finally { act(() => root.unmount()); container.remove() }
})

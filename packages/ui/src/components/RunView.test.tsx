import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
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

it.each([
  ['complete', 'Wrap'], ['settled', 'Run again…'], ['stopped', 'Run again…'], ['stalled', 'Review and run again…'],
] as const)('gives %s an ending summary and an independent door', (scene, label) => {
  const onRunAgain = vi.fn(), onWrap = vi.fn(), onBoard = vi.fn(), onReviewCheck = vi.fn(), onSelect = vi.fn()
  const { container, done } = withFlow({ model: runTimeline(runFixture(scene)), onRunAgain, onWrap, onBoard, onReviewCheck, onSelect })
  try {
    const banner = container.querySelector('[data-slot="run-ending"]')!
    expect(banner).not.toBeNull()
    const button = [...banner.querySelectorAll('button')].find(one => one.textContent === label)!
    expect(button.parentElement?.closest('button')).toBeNull()
    act(() => button.click())
    expect(scene === 'complete' ? onWrap : scene === 'stalled' ? onReviewCheck : onRunAgain).toHaveBeenCalledOnce()
    if (scene === 'settled') {
      act(() => [...banner.querySelectorAll('button')].find(one => one.textContent === 'Board')!.click())
      expect(onBoard).toHaveBeenCalledOnce()
    }
    expect(onSelect).not.toHaveBeenCalled()
  } finally { done() }
})

it.each(['rounds', 'without-progress'] as const)('names the %s budget and its recorded count even without a reason', which => {
  const execution = { ...runFixture('stalled').execution, operations: [], end: { kind: 'budget' as const, which, used: 7 }, reason: null }
  const { container, done } = withFlow({ model: runTimeline({ execution, cards: [] }), onRunAgain: () => {} })
  try {
    expect(container.querySelector('[data-slot="run-ending"]')!.textContent).toContain('7')
    expect(container.querySelector('[data-slot="run-ending"]')!.textContent).toContain('Run again…')
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
    expect(row.contains(again)).toBe(false)
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
  expect(ending.querySelector('[data-row="end"] [data-slot="list-row-title"]')).not.toBeNull()
  expect(ending.querySelectorAll('[data-tone="warning"]')).toHaveLength(scene==='stalled'?1:0)
  act(()=> (ending.querySelector('[data-row="end"] button') as HTMLButtonElement).click())
  expect(onSelect).toHaveBeenCalledWith('end')
  if(scene==='complete')expect(ending.textContent).toContain('Nothing waits.')
 } finally {done()}
})

import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import type { AppSnapshot, AppStore } from '../state/store'
import { emptyFindingsState, type FindingsListState } from '../lib/findings'
import { overviewReport } from '../preview/team-overview-fixture'
import { runFixture, runTeamStore } from '../preview/run-view-fixture'
import { runTimeline } from '../lib/run-timeline'
import { TeamRunView } from './TeamRunView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('Try again retries the inspector’s failed review read and clears its warning', async () => {
  const fixture = runFixture()
  const execution = { ...fixture.execution, findings: { version: 1 as const, budget: { rounds: 3, withoutProgress: 2 }, closedRounds: [], idleRounds: 0, progress: [], series: [], stopped: null, extraRound: null, overrides: [], lastDecision: null } }
  const base = runTeamStore()
  const read = vi.fn().mockRejectedValueOnce(new Error('Read unavailable')).mockResolvedValue(undefined)
  const retryTimeline = vi.fn()
  const store = new Proxy(base, { get(target, key) { if (key === 'loadFindingRun') return read; return Reflect.get(target, key) } })
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => root.render(<StoreProvider store={store}><TeamRunView execution={execution} origin={null} onOpenSeat={() => {}}
      model={runTimeline({ ...fixture, execution })} number={1} selectedRow={null} onSelect={() => {}} onRetry={retryTimeline} /></StoreProvider>))
    expect(container.textContent).toContain('Review details could not be read.')
    const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Try again')!
    await act(async () => retry.click())
    expect(retryTimeline).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledTimes(2)
    expect(container.textContent).not.toContain('Review details could not be read.')
  } finally { act(() => root.unmount()) }
})

/** The Run fixture's store, with the parts of its snapshot and the verbs a test varies. */
const storeWith = (change: (snapshot: AppSnapshot) => Partial<AppSnapshot> = () => ({}), verbs: Record<string, unknown> = {}): AppStore => {
  const base = runTeamStore()
  const snapshot = { ...base.getSnapshot(), ...change(base.getSnapshot()) }
  return new Proxy(base, { get(target, key) {
    if (key === 'getSnapshot') return () => snapshot
    if (typeof key === 'string' && key in verbs) return verbs[key]
    return Reflect.get(target, key)
  } })
}
const mount = async (store: AppStore, props: Partial<ComponentProps<typeof TeamRunView>> = {}) => {
  const fixture = runFixture('complete')
  const container = document.createElement('div')
  const root = createRoot(container)
  /** Renders the view again with other props, as a Run that moves to another Goal would. */
  const show = (next: Partial<ComponentProps<typeof TeamRunView>> = {}) => act(async () => root.render(<StoreProvider store={store}><TeamRunView execution={fixture.execution} origin={null} onOpenSeat={() => {}}
    model={runTimeline(fixture)} number={1} selectedRow="card-3-3" onSelect={() => {}} {...props} {...next} /></StoreProvider>))
  await show()
  return { container, show, close: () => act(() => root.unmount()) }
}
const sectionText = (container: HTMLElement, title: string): string =>
  [...container.querySelectorAll('section')].find(one => one.textContent?.startsWith(title))?.textContent ?? ''

it('totals each recorded Seat once in the Run header rather than borrowing the Goal total', async () => {
  const store = storeWith(snapshot => ({ runtimes: snapshot.runtimes.map(runtime => ({ ...runtime,
    capabilities: { ...runtime.capabilities, metered: true } })) }))
  const view = await mount(store)
  try {
    expect(view.container.querySelector('[data-slot="run-facts"]')!.textContent).toContain('Seat cost $0.85')
  } finally { view.close() }
})

it('qualifies the header cost when a Run Seat has no recorded usage', async () => {
  const fixture = runFixture('complete')
  const execution = { ...fixture.execution, rounds: fixture.execution.rounds.map((round, index) =>
    index === 0 ? { ...round, seats: [...round.seats, 'unrecorded-seat'] } : round) }
  const view = await mount(storeWith(), { execution, model: runTimeline({ ...fixture, execution }) })
  try {
    expect(view.container.querySelector('[data-slot="run-facts"]')!.textContent).toContain('Seat cost 96 turns · partial')
  } finally { view.close() }
})

it.each(['member', 'answer', 'missing'] as const)('reads wrapped Run Seats with a conversation %s pointer', async pointer => {
  const open = vi.fn()
  const store = storeWith(snapshot => {
    const goal = snapshot.goals.get('overview-team')!
    const reviewer = goal.members[1]!
    const receipt = {
      version: 1 as const, id: 'wrapped-run-receipt', goal: goal.goal.id, sentence: goal.goal.sentence,
      wrappedAt: 2, summary: 'Reviewed.', cards: [], seats: goal.members.map(seat => seat.id),
      members: goal.members.map(seat => ({ seat: seat.id, agent: seat.agent?.name ?? null, seatLabel: seat.seatLabel,
        ...(pointer === 'member' && seat.id === reviewer.id ? { session: seat.session } : {}) })),
      answers: pointer === 'answer' ? [{ seat: reviewer.id, session: reviewer.session, turn: null, text: 'Reviewed.', partial: false, stopReason: null }] : [],
      evidence: [], lanes: [], revisions: [], citations: [], gaps: [],
    }
    return { goals: new Map([[goal.goal.id, { ...goal, goal: { ...goal.goal, state: 'wrapped', receipt: receipt.id }, members: [], receipt }]]) }
  })
  const view = await mount(store, { selectedRow: 'run', onOpenSeat: open })
  try {
    expect(sectionText(view.container, 'Seats')).toContain('Alpha')
    expect(sectionText(view.container, 'Seats')).toContain('Beta')
    await view.show({ selectedRow: 'card-3-3' })
    const inspector = view.container.querySelector('[data-slot="run-inspector"]')!
    const button = [...inspector.querySelectorAll('button')].find(one => one.textContent === 'Open the conversation')
    if (pointer === 'missing') {
      expect(button).toBeUndefined()
      expect(inspector.textContent).toContain('Conversation not kept')
    } else {
      expect(button).toBeDefined()
      await act(async () => button!.click())
      expect(open).toHaveBeenCalledWith('codex\0overview-1')
      expect(costOf(view.container)).not.toContain('Not recorded')
    }
  } finally { view.close() }
})
it('keeps both receipt Seats when one conversation worked in earlier and later rounds', async () => {
  const open = vi.fn()
  const store = storeWith(snapshot => {
    const goal = snapshot.goals.get('overview-team')!
    const writer = goal.members[0]!
    const receipt = {
      version: 1 as const, id: 'repeated-seat-receipt', goal: goal.goal.id, sentence: goal.goal.sentence,
      wrappedAt: 2, summary: 'Reviewed.', cards: [], seats: ['seat-0', 'seat-1'],
      members: [
        { seat: 'seat-0', agent: 'Earlier writer', seatLabel: 'First Seat', session: writer.session },
        { seat: 'seat-1', agent: 'Later reviewer', seatLabel: 'Second Seat', session: writer.session },
      ], answers: [], evidence: [], lanes: [], revisions: [], citations: [], gaps: [],
    }
    return { goals: new Map([[goal.goal.id, { ...goal, goal: { ...goal.goal, state: 'wrapped', receipt: receipt.id }, members: [], receipt }]]),
      runtimes: snapshot.runtimes.map(runtime => ({ ...runtime, capabilities: { ...runtime.capabilities, metered: true } })) }
  })
  const view = await mount(store, { selectedRow: 'run', onOpenSeat: open })
  try {
    expect(sectionText(view.container, 'Seats')).toContain('Earlier writer')
    expect(sectionText(view.container, 'Seats')).toContain('Later reviewer')
    expect(sectionText(view.container, 'Seats')).toContain('First Seat')
    expect(sectionText(view.container, 'Seats')).toContain('Second Seat')
    expect(view.container.textContent).not.toContain('Seat not recorded')
    for (const [row, cost] of [['card-1-1', '$0.64'], ['card-3-3', '$0.21']]) {
      await view.show({ selectedRow: row })
      expect(costOf(view.container)).toContain(cost)
      const inspector = view.container.querySelector('[data-slot="run-inspector"]')!
      const button = [...inspector.querySelectorAll('button')].find(one => one.textContent === 'Open the conversation')!
      expect(button).toBeDefined()
      await act(async () => button.click())
      expect(open).toHaveBeenLastCalledWith('codex\0overview-0')
    }
  } finally { view.close() }
})
it.each(['breakdown', 'seat', 'missing'] as const)('shows known usage for a receipt Seat without a conversation (runtime from %s)', async source => {
  let report = overviewReport()
  const store = storeWith(snapshot => {
    const goal = snapshot.goals.get('overview-team')!
    if (source !== 'breakdown') {
      report = { ...report, seats: source === 'seat' ? goal.members : [],
        breakdowns: report.breakdowns.map(partition => ({ ...partition, rows: partition.rows.map(row => ({ ...row, session: null })) })) }
    }
    const receipt = {
      version: 1 as const, id: 'unlinked-seat-receipt', goal: goal.goal.id, sentence: goal.goal.sentence,
      wrappedAt: 2, summary: 'Reviewed.', cards: [], seats: ['seat-1'],
      members: [{ seat: 'seat-1', agent: 'Beta', seatLabel: 'Reviewer' }],
      answers: [], evidence: [], lanes: [], revisions: [], citations: [], gaps: [],
    }
    return { goals: new Map([[goal.goal.id, { ...goal, goal: { ...goal.goal, state: 'wrapped', receipt: receipt.id }, members: [], receipt }]]),
      runtimes: snapshot.runtimes.map(runtime => ({ ...runtime, capabilities: { ...runtime.capabilities, metered: true } })) }
  }, { readGoalInsight: async () => report })
  const view = await mount(store)
  try {
    expect(costOf(view.container)).toContain(source === 'missing' ? '38 turns' : '$0.21')
    expect(view.container.textContent).toContain('Conversation not kept')
    expect(view.container.textContent).not.toContain('Open the conversation')
  } finally { view.close() }
})
const tryAgain = (container: HTMLElement): HTMLButtonElement =>
  [...container.querySelectorAll('button')].find(button => button.textContent === 'Try again')!

it('reads the cards from the Team, as the timeline beside the inspector does', async () => {
  const store = storeWith(snapshot => {
    const goal = snapshot.goals.get('overview-team')!
    // The Goal's own copy of the board is behind the Team's: its card has an older title.
    const stale = { ...goal.board, intents: goal.board.intents.map(card => card.id === 3 ? { ...card, title: 'An older title from the Goal copy' } : card) }
    return { goals: new Map([['overview-team', { ...goal, board: stale }]]) }
  })
  const view = await mount(store)
  try {
    expect(view.container.querySelector('[data-slot="run-inspector"]')?.textContent).toContain('#3 · Review the change')
    expect(view.container.textContent).not.toContain('An older title from the Goal copy')
  } finally { view.close() }
})
it('falls back to the Goal’s board when the Team has not been heard from', async () => {
  const store = storeWith(snapshot => ({ teams: new Map([...snapshot.teams].filter(([id]) => id !== 'overview-team')) }))
  const view = await mount(store)
  try { expect(view.container.querySelector('[data-slot="run-inspector"]')?.textContent).toContain('#3 · Review the change') } finally { view.close() }
})

const costOf = (container: HTMLElement): string => sectionText(container, 'Cost')
it('keeps a Seat’s cost on screen while the report is read again', async () => {
  const insight = vi.fn().mockResolvedValueOnce(overviewReport()).mockImplementation(() => new Promise(() => {}))
  const view = await mount(storeWith(() => ({}), { readGoalInsight: insight }), { problem: 'Some reads failed.', onRetry: () => {} })
  try {
    expect(costOf(view.container)).not.toContain('Not recorded')
    const recorded = costOf(view.container)
    await act(async () => tryAgain(view.container).click())
    expect(insight).toHaveBeenCalledTimes(2)
    expect(costOf(view.container)).toBe(recorded)
  } finally { view.close() }
})
it('keeps a Seat’s cost on screen when reading the report again fails', async () => {
  const insight = vi.fn().mockResolvedValueOnce(overviewReport()).mockRejectedValue(new Error('Usage is unavailable'))
  const view = await mount(storeWith(() => ({}), { readGoalInsight: insight }), { problem: 'Some reads failed.', onRetry: () => {} })
  try {
    const recorded = costOf(view.container)
    expect(recorded).not.toContain('Not recorded')
    await act(async () => tryAgain(view.container).click())
    expect(insight).toHaveBeenCalledTimes(2)
    expect(costOf(view.container)).toBe(recorded)
  } finally { view.close() }
})
it('says a Seat’s cost is not recorded when the first read of the report fails', async () => {
  const view = await mount(storeWith(() => ({}), { readGoalInsight: vi.fn().mockRejectedValue(new Error('Usage is unavailable')) }))
  try { expect(costOf(view.container)).toContain('Not recorded') } finally { view.close() }
})
it('does not show one Goal’s cost under another while the other’s report is being read', async () => {
  const insight = vi.fn().mockResolvedValueOnce(overviewReport()).mockImplementation(() => new Promise(() => {}))
  const store = storeWith(snapshot => {
    // The same Team under a second id, for the Run to move to.
    const team = snapshot.teams.get('overview-team')!
    const goal = snapshot.goals.get('overview-team')!
    const other = { ...team, id: 'other-team' }
    return { teams: new Map([...snapshot.teams, [other.id, other]]),
      goals: new Map([...snapshot.goals, [other.id, { ...goal, goal: { ...goal.goal, id: other.id }, board: other }]]) }
  }, { readGoalInsight: insight })
  const view = await mount(store)
  try {
    expect(costOf(view.container)).not.toContain('Not recorded')
    await view.show({ execution: { ...runFixture('complete').execution, goal: 'other-team' } })
    expect(insight).toHaveBeenLastCalledWith('other-team')
    expect(costOf(view.container)).toContain('Not recorded')
  } finally { view.close() }
})

const READING = 'Reading findings…'
const UNREAD = 'Findings could not be read'
const NONE = 'No findings recorded'
const list = (change: Partial<FindingsListState>): FindingsListState => ({ ...emptyFindingsState('all'), ...change })
/** What a successful read of a Goal with no findings leaves: the host answers real totals, never a bare empty list. */
const read = { totals: { all: 0, open: 0, blocking: 0 } }
const withFindings = (state: FindingsListState | undefined) =>
  storeWith(() => ({ findings: new Map<string, FindingsListState>(state ? [['overview-team', state]] : []) }))
const onlySays = (container: HTMLElement, shown: string): void => {
  expect(sectionText(container, 'Findings')).toContain(shown)
  for (const other of [READING, UNREAD, NONE]) if (other !== shown) expect(container.textContent).not.toContain(other)
}
// The room reads every finding of the Goal; until that list has landed and is whole, none here is not none.
it.each([
  { name: 'has not been asked for', state: undefined, shown: READING },
  { name: 'is loading its first page', state: list({ loading: true }), shown: READING },
  { name: 'is the list of another filter', state: { ...emptyFindingsState('open'), ...read }, shown: READING },
  { name: 'is loading a further page', state: list({ loadingMore: true, next: 'page-3', ...read }), shown: READING },
  { name: 'is loading a page and has no cursor to say which', state: list({ loadingMore: true, ...read }), shown: READING },
  { name: 'has pages still to read', state: list({ next: 'page-2', ...read }), shown: READING },
  { name: 'failed with nothing read', state: list({ error: 'Read unavailable', stale: true }), shown: UNREAD },
  { name: 'cannot be shown as complete', state: list({ problem: 'Some evidence records could not be read.' }), shown: UNREAD },
  { name: 'was read whole and is empty', state: list(read), shown: NONE },
  // A reload keeps what the read before it found, so an empty ledger does not flicker to "reading" each time it is asked again.
  { name: 'is being reloaded after it was read whole and found empty', state: list({ ...read, loading: true }), shown: NONE },
])('reads the findings as "$shown" when their list $name', async ({ state, shown }) => {
  const view = await mount(withFindings(state))
  try { onlySays(view.container, shown) } finally { view.close() }
})
it.each([
  { name: 'is being reloaded', state: { loading: true } },
  { name: 'is being added to', state: { loadingMore: true, next: 'page-3' } },
  { name: 'failed to reload', state: { error: 'Read unavailable', stale: true } },
  { name: 'has pages still to read', state: { next: 'page-2' } },
])('keeps showing the findings it already has when their list $name', async ({ state }) => {
  // Rows from the running scene belong to the same Run (the fixtures share its id).
  const view = await mount(withFindings(list({ ...read, ...state, rows: runFixture('running').findings })))
  try {
    expect(sectionText(view.container, 'Findings')).toContain('Cap the attempts.')
    for (const placeholder of [READING, UNREAD, NONE]) expect(view.container.textContent).not.toContain(placeholder)
  } finally { view.close() }
})
it('does not read another filter’s list as the Goal’s findings', async () => {
  // An "open" list is only some of them, so the card waits for the list of all of them rather than show part.
  const view = await mount(withFindings({ ...emptyFindingsState('open'), ...read, rows: runFixture('running').findings }))
  try {
    onlySays(view.container, READING)
    expect(view.container.textContent).not.toContain('Cap the attempts.')
  } finally { view.close() }
})
it('does not call a card’s findings none while more of them remain to be read', async () => {
  // The rows in hand are another card’s: this card’s may be on a page not yet read.
  const rows = runFixture('running').findings
  const partial = await mount(withFindings(list({ ...read, rows, next: 'page-2' })), { selectedRow: 'card-1-1' })
  try { onlySays(partial.container, READING) } finally { partial.close() }
  const whole = await mount(withFindings(list({ ...read, rows })), { selectedRow: 'card-1-1' })
  try { onlySays(whole.container, NONE) } finally { whole.close() }
  // Asked again after a push, the whole list read before it still says what it found.
  const reloading = await mount(withFindings(list({ ...read, rows, loading: true })), { selectedRow: 'card-1-1' })
  try { onlySays(reloading.container, NONE) } finally { reloading.close() }
})

const flowing = { flow: <p data-testid="the-flow">The drawing</p> }
const choice = (container: HTMLElement, name: string): HTMLButtonElement =>
  [...container.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Show the Run as"] [role="radio"]')].find(one => one.textContent === name)!
it('gives the Flow the whole pane: the inspector steps aside on the Flow tab and returns with the timeline', async () => {
  const view = await mount(storeWith(), flowing)
  try {
    expect(view.container.querySelector('[data-slot="run-inspector"]')).not.toBeNull()
    expect(view.container.textContent).toContain('Run details')
    await act(async () => choice(view.container, 'Flow').click())
    expect(view.container.querySelector('[data-testid="the-flow"]')).not.toBeNull()
    expect(view.container.querySelector('[data-slot="run-inspector"]')).toBeNull()
    expect(view.container.textContent).toContain('Run details')
    await act(async () => choice(view.container, 'Timeline').click())
    expect(view.container.querySelector('[data-testid="the-flow"]')).toBeNull()
    expect(view.container.querySelector('[data-slot="run-inspector"]')).not.toBeNull()
  } finally { view.close() }
})
it('keeps the inspector beside the timeline when there is no Flow to show', async () => {
  const view = await mount(storeWith())
  try {
    expect(view.container.querySelector('[role="radiogroup"]')).toBeNull()
    expect(view.container.querySelector('[data-slot="run-inspector"]')).not.toBeNull()
  } finally { view.close() }
})
it('answers to a caller that chooses the tab, and keeps the pane its own while it does', async () => {
  const onView = vi.fn()
  const view = await mount(storeWith(), { ...flowing, view: 'flow', onView })
  try {
    expect(view.container.querySelector('[data-testid="the-flow"]')).not.toBeNull()
    expect(view.container.querySelector('[data-slot="run-inspector"]')).toBeNull()
    await act(async () => choice(view.container, 'Timeline').click())
    expect(onView).toHaveBeenCalledWith('timeline')
    // The caller has not moved the tab, so neither has the pane.
    expect(view.container.querySelector('[data-testid="the-flow"]')).not.toBeNull()
    expect(view.container.querySelector('[data-slot="run-inspector"]')).toBeNull()
    await view.show({ view: 'timeline' })
    expect(view.container.querySelector('[data-slot="run-inspector"]')).not.toBeNull()
  } finally { view.close() }
})

it('hands the attempts it was given, and why they are missing, to the check’s inspector', async () => {
  const attempt = (n: number) => ({ id: `attempt-${n}`, n, at: Date.now() - (3 - n) * 600_000, commit: `c0ffee${n}`, exit: n === 1 ? 1 : 0, timedOut: false, outcome: n === 1 ? 'fail' : 'pass', tail: `output ${n}` })
  const view = await mount(storeWith(), { selectedRow: 'check-2-2', attempts: new Map([[2, [attempt(1), attempt(2)]]]) })
  try {
    expect(sectionText(view.container, 'Attempts')).toContain('Attempt 2')
    expect(sectionText(view.container, 'Attempts')).toContain('Attempt 1')
    await view.show({ attempts: new Map([[2, [attempt(1), attempt(2)]]]), incompleteAttempts: new Set([2]) })
    expect(sectionText(view.container, 'Attempts')).toContain('Attempt history could not be read completely.')
    expect(sectionText(view.container, 'Attempts')).toContain('Recorded result')
    expect(sectionText(view.container, 'Attempts')).not.toContain('Attempt 1')
    await view.show({ attempts: undefined, attemptsRead: 'reading' })
    expect(sectionText(view.container, 'Attempts')).toContain('Reading attempts…')
    await view.show({ attempts: undefined, attemptsRead: 'failed' })
    expect(sectionText(view.container, 'Attempts')).toContain('Earlier attempts could not be read')
    await view.show({ attempts: undefined, attemptsRead: undefined })
    expect(view.container.textContent).not.toContain('Attempts')
  } finally { view.close() }
})

/** The store with another scene of the Run fixture on the Team's board, as the running Team holds it. */
const sceneStore = (scene: 'running' | 'person', verbs: Record<string, unknown> = {}): AppStore => storeWith(snapshot => {
  const fixture = runFixture(scene)
  const team = { ...snapshot.teams.get('overview-team')!, intents: fixture.cards, channel: fixture.signals }
  return { teams: new Map([[team.id, team]]), flowExecutions: new Map([[fixture.execution.id, fixture.execution]]) }
}, verbs)
const mountScene = async (scene: 'running' | 'person', store: AppStore, props: Partial<ComponentProps<typeof TeamRunView>>) => {
  const fixture = runFixture(scene)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(<StoreProvider store={store}><TeamRunView execution={fixture.execution} origin={null} onOpenSeat={() => {}}
    model={runTimeline(fixture)} number={1} selectedRow={scene === 'person' ? 'person-4-4' : 'card-4-4'} onSelect={() => {}} {...props} /></StoreProvider>))
  return { container, close: () => { act(() => root.unmount()); container.remove() } }
}
const press = (label: string, within: ParentNode = document.body) =>
  act(async () => ([...within.querySelectorAll('button')].find(one => one.textContent === label) as HTMLButtonElement).click())

it('abandons a card from its inspector with the request the board makes', async () => {
  const teamIntent = vi.fn().mockResolvedValue(undefined)
  const view = await mountScene('running', sceneStore('running', { teamIntent }), {})
  try {
    await press('Abandon card…', view.container)
    expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain('Abandon card #4?')
    expect(teamIntent).not.toHaveBeenCalled()
    await press('Abandon card')
    // The board's own menu calls `teamIntent(room, id, 'abandon')` and nothing else.
    expect(teamIntent).toHaveBeenCalledTimes(1)
    expect(teamIntent).toHaveBeenCalledWith('overview-team', 4, 'abandon')
  } finally { view.close() }
})
it('leaves the keyed abandon question for the Run’s stop question without abandoning its card', async () => {
  const teamIntent = vi.fn()
  const onStop = vi.fn()
  const view = await mountScene('running', sceneStore('running', { teamIntent }), { onStop })
  try {
    await press('Abandon card…', view.container)
    await press('Stop the run instead')
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
    expect(onStop).toHaveBeenCalledOnce()
    expect(teamIntent).not.toHaveBeenCalled()
  } finally { view.close() }
})
it('answers a person\'s step from its inspector with the request the board makes', async () => {
  const teamIntent = vi.fn().mockResolvedValue(undefined)
  const onOpenBoard = vi.fn()
  const view = await mountScene('person', sceneStore('person', { teamIntent }), { onOpenBoard })
  try {
    await press('Approved', view.container)
    expect(teamIntent).toHaveBeenCalledWith('overview-team', 4, 'done', undefined, 'approved')
  } finally { view.close() }
})
it('keeps a person\'s step as text when the pane gives it no way to the board', async () => {
  const view = await mountScene('person', sceneStore('person'), {})
  try { expect([...view.container.querySelectorAll('button')].map(one => one.textContent)).not.toContain('Approved') } finally { view.close() }
})
it('gives the note written in the inspector as the context the next round reads', async () => {
  const teamIntent = vi.fn().mockResolvedValue(undefined)
  const view = await mountScene('person', sceneStore('person', { teamIntent }), { onOpenBoard: () => {} })
  try {
    const note = view.container.querySelector<HTMLInputElement>('input[aria-label="Note"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => { setter.call(note, 'Looks right.'); note.dispatchEvent(new Event('input', { bubbles: true })) })
    await press('Approved', view.container)
    expect(teamIntent).toHaveBeenCalledWith('overview-team', 4, 'done', undefined, 'approved', 'Looks right.')
  } finally { view.close() }
})

it('uses the separately read check history for the Flow count and keeps incomplete history unknown', async () => {
  const attempts = new Map([[2, [1000, 2000].map((at, i) => ({ id: `result-${i + 1}`, at, n: i + 1, commit: '3f9a1c', exit: 0, timedOut: false, outcome: 'passes', tail: 'Passed' }))]])
  const view = await mount(storeWith(), { drawFlow: true, view: 'flow', attempts })
  try {
    const check = () => view.container.querySelector('[data-step="verify"]')!
    expect(check().textContent).toContain('×2')
    await view.show({ incompleteAttempts: new Set([2]) })
    expect(check().textContent).not.toContain('×2')
    expect(view.container.querySelector('[data-step-row="verify"] [title="Run count unavailable"]')?.textContent).toBe('—')
  } finally { view.close() }
})


it('keeps a check count unknown when a failed refresh retains older results, and restores it after recovery', async () => {
  const attempts = new Map([[2, [1000, 2000].map((at, i) => ({ id: `result-${i + 1}`, at, n: i + 1, commit: '3f9a1c', exit: 0, timedOut: false, outcome: 'passes', tail: 'Passed' }))]])
  const view = await mount(storeWith(), { drawFlow: true, view: 'flow', attempts })
  try {
    const check = () => view.container.querySelector('[data-step="verify"]')!
    expect(check().textContent).toContain('×2')
    await view.show({ attemptsRead: 'failed' })
    expect(check().textContent).not.toContain('×2')
    expect(view.container.querySelector('[data-step-row="verify"] [title="Run count unavailable"]')?.textContent).toBe('—')
    await view.show({ attemptsRead: undefined })
    expect(check().textContent).toContain('×2')
    expect(view.container.querySelector('[data-step-row="verify"] [data-slot="list-row-trail"]')?.textContent).toContain('2 runs')
    expect(view.container.querySelector('[data-step-row="verify"] [title="Run count unavailable"]')).toBeNull()
  } finally { view.close() }
})


it('omits check retry in a wrapped Team even while its Run still reads running', async () => {
  const fixture = runFixture('running')
  const store = storeWith(snapshot => {
    const goal = snapshot.goals.get(fixture.execution.goal)!
    return { goals: new Map([[goal.goal.id, { ...goal, goal: { ...goal.goal, state: 'wrapped' } }]]) }
  })
  const view = await mount(store, { execution: fixture.execution, model: runTimeline(fixture), selectedRow: 'check-2-2' })
  try {
    const inspector = view.container.querySelector('[data-slot="run-inspector"]')!
    expect(inspector.textContent).toContain('This Team is wrapped')
    expect([...inspector.querySelectorAll('button')].some(one => one.textContent === 'Run again…')).toBe(false)
  } finally { view.close() }
})

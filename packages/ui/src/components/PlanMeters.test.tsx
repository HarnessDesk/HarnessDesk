import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import {
  sessionKey,
  type AccountStatus,
  type RuntimeInfo,
  type Session,
  type UsageLane,
  type UsageReport,
} from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { PlanMeters } from './PlanMeters'

/**
 * The strip's contract, through the DOM.
 *
 * The claims the design rests on: the strip costs the same at six agents as at
 * two, the bar in front of you belongs to the conversation you are in, the
 * token beside it says whether anything else is in the way without being
 * opened, an agent that is out can buy a chip, the bar is filled with what is
 * *left* — the difference between a useful bar and one that contradicts its own
 * figure — and the panel behind the token is the roster the token stands for.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  // The popover renders into the body, so its panel outlives the container.
  document.querySelectorAll('[data-hd-popover], [role="menu"]').forEach((node) => node.remove())
})

const HOUR = 3_600_000

const runtime = (id: string, name: string): RuntimeInfo =>
  ({ id, name, capabilities: {}, presentation: { name } }) as unknown as RuntimeInfo

const report = (id: string, lanes: readonly UsageLane[], over: Partial<UsageReport> = {}): UsageReport =>
  ({
    runtime: id,
    account: null,
    plan: null,
    lanes,
    credits: null,
    spend: null,
    reached: null,
    source: { kind: 'api', label: 'from a test' },
    fetchedAt: Date.now(),
    staleAfterMs: 60_000,
    error: null,
    ...over,
  }) as UsageReport

/** A weekly plan with a share left and nothing else to say about it. */
const at = (id: string, left: number, over: Partial<UsageReport> = {}): UsageReport =>
  report(id, [{ id: 'weekly', label: 'Weekly', usedPercent: 100 - left, windowMinutes: 10_080, resetsAt: null }], over)

/** A weekly plan that is over, with a reset to count down to. */
const spent = (id: string, backIn: number): UsageReport =>
  report(
    id,
    [{ id: 'weekly', label: 'Weekly', usedPercent: 100, windowMinutes: 10_080, resetsAt: Date.now() + backIn }],
    { reached: 'weekly' },
  )

/** An agent someone is signed in to, so the strip has nothing to ask for. */
const account = (): AccountStatus =>
  ({ accounts: [{ kind: 'oauth', label: 'someone' }], signInMethods: [] }) as unknown as AccountStatus

const storeOf = (snapshot: AppSnapshot): AppStore =>
  ({ subscribe: () => () => {}, getSnapshot: () => snapshot }) as unknown as AppStore

/** The conversation the header belongs to, which is what anchors the strip. */
const conversationWith = (id: string): Pick<AppSnapshot, 'sessions' | 'activeSessionKey'> => {
  const key = sessionKey(id, 'one')
  return {
    sessions: new Map([[key, { id: 'one', runtime: id, title: 'A conversation', turns: [] } as unknown as Session]]),
    activeSessionKey: key,
  }
}

const mount = (over: Partial<AppSnapshot>): void => {
  const snapshot: AppSnapshot = { ...emptySnapshot(), ...over }
  act(() => {
    root.render(
      <StoreProvider store={storeOf(snapshot)}>
        <PlanMeters onOpen={() => {}} onSignIn={() => {}} />
      </StoreProvider>,
    )
  })
}

const bars = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('button [data-tone]')]
const triggers = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('button')]
const titles = (): (string | null)[] => triggers().map((button) => button.getAttribute('title'))

/** Six agents, which is the roster the old one-bar-per-agent strip died on. */
const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => runtime(id, `Agent ${id.toUpperCase()}`))

it('costs the same at six agents as at two', () => {
  mount({
    runtimes: six,
    usage: six.map((info, index) => at(info.id, 90 - index * 4)),
    ...conversationWith('c'),
  })
  // One bar for the conversation's agent, one token for the other five.
  expect(bars()).toHaveLength(2)
  expect(bars().map((bar) => bar.textContent)).toEqual(['82%', '70%'])
})

it('gives the bar to the conversation own agent, not the one in the most trouble', () => {
  mount({ runtimes: six, usage: [at('a', 6), at('b', 88)], ...conversationWith('b') })
  expect(titles()[0]).toBe('Agent B — Weekly, 88% left')
  expect(bars()[0]?.textContent).toBe('88%')
})

it('shows the binding lane, not the roomiest one', () => {
  mount({
    runtimes: [runtime('a', 'Agent A')],
    usage: [
      report('a', [
        { id: 'session', label: 'Session', usedPercent: 5, windowMinutes: 300, resetsAt: null },
        { id: 'weekly', label: 'Weekly', usedPercent: 88, windowMinutes: 10_080, resetsAt: null },
      ]),
    ],
    ...conversationWith('a'),
  })
  expect(titles()[0]).toBe('Agent A — Weekly, 12% left')
  expect(bars()[0]?.textContent).toBe('12%')
})

it('answers with the countdown once there is nothing left', () => {
  mount({ runtimes: [runtime('a', 'Agent A')], usage: [spent('a', 2 * HOUR)], ...conversationWith('a') })
  const bar = bars()[0]
  expect(bar?.textContent).toBe('2h')
  expect(bar?.getAttribute('data-tone')).toBe('bad')
})

it('colours what is left, not what pace predicts', () => {
  // Nearly the whole weekly window still to run and 71% left: the card calls
  // this amber because the pace will not last, and the strip must not — a bar
  // with no room for a sentence has no way to explain a prediction.
  mount({
    runtimes: [runtime('a', 'Agent A')],
    usage: [
      report('a', [
        { id: 'weekly', label: 'Weekly', usedPercent: 29, windowMinutes: 10_080, resetsAt: Date.now() + 6 * 24 * HOUR },
      ]),
    ],
    ...conversationWith('a'),
  })
  const bar = bars()[0]
  expect(bar?.getAttribute('data-tone')).toBe('good')
  expect(bar?.hasAttribute('data-low')).toBe(false)
})

it('fills the bar with what is left, the way the figure beside it reads', () => {
  mount({ runtimes: [runtime('a', 'Agent A')], usage: [at('a', 96)], ...conversationWith('a') })
  // 4% used is 96% left. A bar drawn from what had been *spent* left the
  // roomiest account on the strip looking like the emptiest one.
  const fill = container.querySelector<HTMLElement>('[data-tone] span[style]')
  expect(fill?.style.width).toBe('96%')
  expect(triggers()[0]?.textContent).toContain('96%')
})

it('says in the token whether anything else is in the way, without being opened', () => {
  mount({
    runtimes: six,
    usage: [at('a', 70), spent('b', HOUR), spent('c', HOUR), spent('d', HOUR), at('e', 44)],
    ...conversationWith('a'),
  })
  const token = bars()[bars().length - 1]
  expect(token?.textContent).toBe('3 out')
  expect(token?.getAttribute('data-tone')).toBe('bad')
  expect(titles()[titles().length - 1]).toBe(
    '5 other agents — 3 out of quota, least left 44%, 1 needs sign-in',
  )
})

it('gives an out-of-quota agent a chip, because the token cannot say who', () => {
  mount({ runtimes: six, usage: [at('a', 70), spent('b', 2 * HOUR)], ...conversationWith('a') })
  expect(bars().map((bar) => bar.textContent)).toEqual(['70%', '2h', '1 out'])
  expect(bars()[1]?.hasAttribute('data-promoted')).toBe(true)
  // The chip is the one member of the strip that is news rather than ambience,
  // so it is the one the narrow header drops — the token already counts it.
  expect(bars()[0]?.hasAttribute('data-promoted')).toBe(false)
})

it('opens the roster behind the token, named account by account', () => {
  mount({
    runtimes: six,
    usage: [at('a', 70), at('b', 51, { account: 'work' }), at('b', 12, { account: 'personal' })],
    ...conversationWith('a'),
  })
  const token = triggers()[triggers().length - 1]
  act(() => token?.click())
  const rows = [...document.querySelectorAll('[role="menu"] button')]
  expect(rows.map((row) => row.textContent)).toEqual([
    'Agent Bwork51% left',
    'Agent Bpersonal12% left',
    'Agent CNeeds sign-in',
    'Agent DNeeds sign-in',
    'Agent ENeeds sign-in',
    'Agent FNeeds sign-in',
  ])
})

it('says nothing at all when a signed-in agent reports no usage', () => {
  mount({
    runtimes: [runtime('a', 'Agent A')],
    usage: [],
    accountsByRuntime: { a: account() } as AppSnapshot['accountsByRuntime'],
    ...conversationWith('a'),
  })
  expect(container.querySelector('[aria-label="Plan usage"]')).toBeNull()
})

/**
 * An agent with no account has no lane and so used to be left out entirely,
 * which made the strip quietly wrong about what could run. The one that stops
 * *this* conversation says so; the others are the token's business, because a
 * name per signed-out agent is the same unbounded row of chrome by another
 * shape.
 */
it('names the agent this conversation uses when it has no account', () => {
  mount({
    runtimes: [runtime('a', 'Agent A'), runtime('b', 'Agent B')],
    usage: [],
    accountsByRuntime: { b: account() } as AppSnapshot['accountsByRuntime'],
    ...conversationWith('a'),
  })
  expect(triggers().map((chip) => chip.textContent)).toEqual(['Agent A', '1'])
})

it('leaves another agent sign-in to the token, which is where a count belongs', () => {
  mount({
    runtimes: [runtime('a', 'Agent A'), runtime('b', 'Agent B'), runtime('c', 'Agent C')],
    usage: [at('a', 55)],
    accountsByRuntime: { a: account() } as AppSnapshot['accountsByRuntime'],
    ...conversationWith('a'),
  })
  expect(bars().map((bar) => bar.textContent)).toEqual(['55%', '2'])
  expect(titles()[1]).toBe('2 other agents — 2 needs sign-in')
})

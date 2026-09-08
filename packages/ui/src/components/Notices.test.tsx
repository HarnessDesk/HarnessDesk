import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import type { RuntimeInfo, UsageReport } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { afterDismiss, withMuted, type NoticeIdentity } from '../lib/notice-policy'
import { StatusBanner } from './Notices'

/**
 * The two things a persistent banner must do besides be true: go away, and
 * stay gone for as long as the user meant.
 *
 * A card that states a condition, offers one filled button and no way out
 * reads as a demand rather than as information — the "run out before it
 * refills" one offered another agent and looked like being pushed off the one
 * you had chosen. And the dismissal has to hold: the sentence carries a
 * countdown that moves every minute, so a banner that remembered the sentence
 * rather than the fact would come back a minute later.
 *
 * What these add is the case the window-keyed dismissal never covered. A
 * five-hour lane turns over five times a day, so the same warning arrives at
 * nearly every launch, honestly keyed each time. By the third one the user has
 * said what they think of it twice, and the × has to offer more than a fourth
 * chance to say it again.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  window.localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** A fixed reset, the way a source that reports an absolute time gives one. */
const RESETS_AT = Date.now() + 6.5 * DAY

const runtime = (id: string, name: string): RuntimeInfo =>
  ({
    id,
    name,
    capabilities: { account: true, metered: true },
    presentation: { name },
  }) as unknown as RuntimeInfo

/** Half a day into a seven-day window and 40% spent: on course to run dry. */
const racing = (id: string, resetsAt = RESETS_AT): UsageReport =>
  ({
    runtime: id,
    account: null,
    plan: null,
    lanes: [
      {
        id: 'weekly',
        label: 'Weekly',
        usedPercent: 40,
        windowMinutes: 10_080,
        resetsAt,
        usageKnown: true,
      },
    ],
    credits: null,
    spend: null,
    reached: null,
    source: { kind: 'api', label: 'from a test' },
    fetchedAt: Date.now(),
    staleAfterMs: 60_000,
    error: null,
  }) as unknown as UsageReport

/**
 * A store that actually keeps what it is told.
 *
 * The policy is the thing under test, so a stub that swallowed
 * `dismissStanding` would prove only that clicking a × hides a card in the
 * render it was clicked in — which is what the old `localStorage` version did
 * and is exactly the part that was never the problem.
 */
const makeStore = (over: Partial<AppSnapshot>) => {
  const info = runtime('a', 'Agent A')
  let snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: info.id,
    runtimes: [info],
    preferencesLoaded: true,
    ...over,
  }
  const listeners = new Set<() => void>()
  const patch = (next: Partial<AppSnapshot>): void => {
    snapshot = { ...snapshot, ...next }
    for (const listener of listeners) listener()
  }
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    dismissStanding: (identity: NoticeIdentity) =>
      patch({ noticePolicy: afterDismiss(snapshot.noticePolicy, identity, Date.now()) }),
    setNoticeMuted: (kind: string, muted: boolean) =>
      patch({ noticePolicy: withMuted(snapshot.noticePolicy, kind, muted) }),
    /** What the host would have been asked to write down. */
    policy: () => snapshot.noticePolicy,
  } as unknown as AppStore & { policy: () => AppSnapshot['noticePolicy'] }
}

const mount = (over: Partial<AppSnapshot>): ReturnType<typeof makeStore> => {
  const store = makeStore(over)
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <StatusBanner onSignIn={() => {}} />
      </StoreProvider>,
    )
  })
  return store
}

const dismiss = (): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')

const menuItem = (label: string): HTMLElement | null =>
  [...container.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(
    (row) => row.textContent?.includes(label) ?? false,
  ) ?? null

it('offers a way out of a warning that is only a prediction', () => {
  mount({ usage: [racing('a')] })
  expect(container.textContent).toContain('will run out before it refills')
  expect(dismiss()).not.toBeNull()
})

it('puts the warning away and keeps it away', () => {
  const store = mount({ usage: [racing('a')] })
  act(() => dismiss()?.click())
  expect(container.textContent).not.toContain('will run out before it refills')

  // A fresh window a while later reads the same host state, so the same fact
  // stays put away — which is the half that `localStorage` also managed.
  act(() => root.unmount())
  root = createRoot(container)
  mount({ usage: [racing('a')], noticePolicy: store.policy() })
  expect(container.textContent).not.toContain('will run out before it refills')
})

it('says it again when the window turns over, because that much is new', () => {
  const store = mount({ usage: [racing('a')] })
  act(() => dismiss()?.click())

  act(() => root.unmount())
  root = createRoot(container)
  // A reset in a different hour is a different window and a different key.
  // Two hours rather than a whole window because `now` is fixed here: pushing
  // the reset out by seven days would put this reading before its own window
  // started, and there would be no projection left to warn about.
  mount({ usage: [racing('a', RESETS_AT + 2 * HOUR)], noticePolicy: store.policy() })
  expect(container.textContent).toContain('will run out before it refills')
})

it('offers to stop showing a kind the reader has put away twice', () => {
  // Two windows already dismissed; this is the third sighting.
  const twice = { records: { 'usage:pace': { count: 2, at: Date.now() } }, muted: [], seen: [] }
  const store = mount({ usage: [racing('a')], noticePolicy: twice })

  act(() => dismiss()?.click())
  expect(menuItem('Stop showing this')).not.toBeNull()
  expect(menuItem('Dismiss')).not.toBeNull()
  // The card is still up: the × opened a menu rather than answering for the user.
  expect(container.textContent).toContain('will run out before it refills')

  act(() => menuItem('Stop showing this')?.click())
  expect(store.policy().muted).toContain('usage:pace')
  expect(container.textContent).not.toContain('will run out before it refills')
})

it('keeps a silenced kind away in a window it has never been dismissed in', () => {
  // No `seen` key for this window at all — the mute is what holds it.
  mount({ usage: [racing('a')], noticePolicy: { muted: ['usage:pace'], records: {}, seen: [] } })
  expect(container.textContent).not.toContain('will run out before it refills')
})

it('leaves the plain × alone until it has been earned', () => {
  mount({ usage: [racing('a')] })
  act(() => dismiss()?.click())
  expect(menuItem('Stop showing this')).toBeNull()
})

it('never offers to silence a dropped connection', () => {
  const store = mount({
    status: 'reconnecting',
    noticePolicy: { records: { link: { count: 9, at: Date.now() } }, muted: [], seen: [] },
  })
  expect(container.textContent).toContain('Reconnecting to HarnessDesk')

  act(() => dismiss()?.click())
  expect(menuItem('Stop showing this')).toBeNull()
  expect(container.textContent).not.toContain('Reconnecting to HarnessDesk')
  // Nothing written down: the next drop is news again, in this window or any other.
  expect(store.policy().seen).toEqual([])
  expect(store.policy().muted).toEqual([])
})

it('waits for the host before drawing anything it might have to hide', () => {
  mount({ usage: [racing('a')], preferencesLoaded: false })
  expect(container.textContent).toBe('')
})

it('lets an agent with no account say so, and be put away too', () => {
  mount({
    account: { accounts: [], signInMethods: [{ flow: 'apiKey' }] } as unknown as AppSnapshot['account'],
  })
  expect(container.textContent).toContain('is not signed in')
  act(() => dismiss()?.click())
  expect(container.textContent).not.toContain('is not signed in')
})

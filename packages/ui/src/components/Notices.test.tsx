import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { PersonNotice, RuntimeHealth, RuntimeInfo, TeamState, UsageReport } from '@harnessdesk/protocol'
import { sessionKey } from '@harnessdesk/protocol'

import { PaneProvider, StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import type { Notice as StoreNotice } from '../state/snapshot'
import { emptyWorkbench, type Workbench } from '../state/workbench'
import type { PaneView } from '../state/layout'
import { afterDismiss, emptyNoticePolicy, withKept, withMuted, withoutKept, withSurface, type NoticeIdentity } from '../lib/notice-policy'
import { kept as keptInInbox, type InboxEntry } from '../lib/inbox'
import { ShellProvider } from '../panels/views'
import { ComposerNotices, Notices, NoticeStripOutlet, useInboxMessages } from './Notices'

const showToast = vi.fn()
vi.mock('../design', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../design')>()),
  showToast: (...args: Parameters<typeof import('../design').showToast>) => showToast(...args),
}))

/* What the one banner used to be, now two surfaces: a dropped link on the
   strip, and an agent's own condition on the composer (their defaults). */
const StatusBanner = ({ onSignIn }: { onSignIn: () => void }) => (
  <ShellProvider actions={{ chooseProject: () => {}, signIn: onSignIn, openUsage: () => {}, openRuntimes: () => {}, openAgents: () => {}, reviewImports: () => {} }}>
    <NoticeStripOutlet host />
    <ComposerNotices />
  </ShellProvider>
)

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
  showToast.mockClear()
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
    markNoticeKept: (key: string) => patch({ noticePolicy: withKept(snapshot.noticePolicy, key) }),
    clearNoticeKept: (key: string) => patch({ noticePolicy: withoutKept(snapshot.noticePolicy, key) }),
    keep: (entry: Omit<InboxEntry, 'read'>) => patch({ inbox: keptInInbox(snapshot.inbox, entry) }),
    dismissAgentNotice: (id: string) => patch({ agentNotices: snapshot.agentNotices.filter((entry) => entry.id !== id) }),
    dismissNotice: (id: string) => patch({ notices: snapshot.notices.filter((entry) => entry.id !== id) }),
    /** What `store.notice()` would append — a fresh random id each time, exactly like the real one. */
    pushNotice: (notice: Omit<StoreNotice, 'id'>) =>
      patch({ notices: [...snapshot.notices, { ...notice, id: Math.random().toString(36) }] }),
    setAccount: (account: AppSnapshot['account']) => patch({ account }),
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
  [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(
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
  const twice = { records: { 'usage:pace': { count: 2, at: Date.now() } }, muted: [], seen: [], surfaces: {}, kept: [] }
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
  mount({ usage: [racing('a')], noticePolicy: { muted: ['usage:pace'], records: {}, seen: [], surfaces: {}, kept: [] } })
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
    noticePolicy: { records: { link: { count: 9, at: Date.now() } }, muted: [], seen: [], surfaces: {}, kept: [] },
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

it('reads the pane runtime health rather than singular default agent health (#385)', () => {
  const agentA = runtime('a', 'Agent A')
  const agentB = runtime('b', 'Agent B')

  // Default agent A is unavailable; Agent B is ready
  const store = makeStore({
    activeRuntime: agentA.id,
    runtimes: [agentA, agentB],
    health: { state: 'unavailable', message: 'Agent A CLI exited.' } as RuntimeHealth,
    healthByRuntime: {
      [agentA.id]: { state: 'unavailable', message: 'Agent A CLI exited.' } as RuntimeHealth,
      [agentB.id]: { state: 'ready' } as RuntimeHealth,
    },
  })

  // Mounting StatusBanner inside a pane for Agent B
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <PaneProvider
          scope={{
            paneId: 'p1' as never,
            view: { kind: 'conversation', session: null },
            sessionKey: sessionKey(agentB.id as never, 's1' as never),
          }}
        >
          <StatusBanner onSignIn={() => {}} />
        </PaneProvider>
      </StoreProvider>,
    )
  })

  // Should NOT display Agent A's error in Agent B's pane
  expect(container.textContent).not.toContain('Agent A CLI exited.')

  // Now when Agent B is unavailable, it SHOULD display Agent B's error in Agent B's pane
  const store2 = makeStore({
    activeRuntime: agentA.id,
    runtimes: [agentA, agentB],
    health: { state: 'ready' } as RuntimeHealth,
    healthByRuntime: {
      [agentA.id]: { state: 'ready' } as RuntimeHealth,
      [agentB.id]: { state: 'unavailable', message: 'Agent B crashed.' } as RuntimeHealth,
    },
  })

  act(() => {
    root.render(
      <StoreProvider store={store2}>
        <PaneProvider
          scope={{
            paneId: 'p1' as never,
            view: { kind: 'conversation', session: null },
            sessionKey: sessionKey(agentB.id as never, 's1' as never),
          }}
        >
          <StatusBanner onSignIn={() => {}} />
        </PaneProvider>
      </StoreProvider>,
    )
  })

  expect(container.textContent).toContain('Agent B crashed.')
})

it('reads the pane runtime account rather than singular default agent account', () => {
  const agentA = runtime('a', 'Agent A')
  const agentB = runtime('b', 'Agent B')

  // Default agent A has an account; Agent B has no accounts
  const store = makeStore({
    activeRuntime: agentA.id,
    runtimes: [agentA, agentB],
    account: { accounts: [{ kind: 'api_key', label: 'API Key' }], signInMethods: [{ flow: 'apiKey' }] } as unknown as AppSnapshot['account'],
    accountsByRuntime: {
      [agentA.id]: { accounts: [{ kind: 'api_key', label: 'API Key' }], signInMethods: [{ flow: 'apiKey' }] },
      [agentB.id]: { accounts: [], signInMethods: [{ flow: 'apiKey' }] },
    } as unknown as AppSnapshot['accountsByRuntime'],
  })

  act(() => {
    root.render(
      <StoreProvider store={store}>
        <PaneProvider
          scope={{
            paneId: 'p1' as never,
            view: { kind: 'conversation', session: null },
            sessionKey: sessionKey(agentB.id as never, 's1' as never),
          }}
        >
          <StatusBanner onSignIn={() => {}} />
        </PaneProvider>
      </StoreProvider>,
    )
  })

  expect(container.textContent).toContain('Agent B is not signed in')
})


/**
 * The layout, not a registry, decides where a standing condition and a
 * dropped-link strip are drawn — see `mainNoticeHost`/`focusedComposerVisible`
 * in `state/workbench.ts`. These mount the real `ComposerNotices` and
 * `NoticeStripOutlet` twice at once, the way a split actually would, and ask
 * only one of them ever draws the shared message.
 */
const workbenchFocusedOn = (paneId: string, view: PaneView): Workbench => ({
  ...emptyWorkbench(),
  main: { root: { kind: 'pane', id: paneId, view }, focused: paneId, expanded: null },
})

it('a standing condition shows on the composer that is focused, and on no other one beside it', () => {
  const store = makeStore({
    account: { accounts: [], signInMethods: [{ flow: 'apiKey' }] } as unknown as AppSnapshot['account'],
    workbench: workbenchFocusedOn('focused-pane', { kind: 'conversation', session: null }),
  })
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <ShellProvider actions={{ chooseProject: () => {}, signIn: () => {}, openUsage: () => {}, openRuntimes: () => {}, openAgents: () => {}, reviewImports: () => {} }}>
          <div data-testid="focused">
            <PaneProvider scope={{ paneId: 'focused-pane' as never, view: { kind: 'conversation', session: null }, sessionKey: null }}>
              <ComposerNotices />
            </PaneProvider>
          </div>
          <div data-testid="beside">
            <PaneProvider scope={{ paneId: 'other-pane' as never, view: { kind: 'conversation', session: null }, sessionKey: null }}>
              <ComposerNotices />
            </PaneProvider>
          </div>
        </ShellProvider>
      </StoreProvider>,
    )
  })
  expect(container.querySelector('[data-testid="focused"]')?.textContent).toContain('is not signed in')
  expect(container.querySelector('[data-testid="beside"]')?.textContent).toBe('')
})

it('falls back to the strip when the focused mount is not a composer that can be seen, and never draws it twice when it is', () => {
  const notComposer = makeStore({
    account: { accounts: [], signInMethods: [{ flow: 'apiKey' }] } as unknown as AppSnapshot['account'],
    // The focused pane is a tool, not a composer — a board-only layout, in
    // effect — so no `ComposerNotices` is mounted anywhere for it, exactly as
    // the real app would not mount one inside a board or an activity view.
    // Only the strip is on screen.
    workbench: workbenchFocusedOn('p1', { kind: 'activity' }),
  })
  act(() => {
    root.render(
      <StoreProvider store={notComposer}>
        <ShellProvider actions={{ chooseProject: () => {}, signIn: () => {}, openUsage: () => {}, openRuntimes: () => {}, openAgents: () => {}, reviewImports: () => {} }}>
          <div data-testid="strip">
            <NoticeStripOutlet host />
          </div>
        </ShellProvider>
      </StoreProvider>,
    )
  })
  expect(container.querySelector('[data-testid="strip"]')?.textContent).toContain('is not signed in')

  // Now the focused pane genuinely is a composer: the strip has nothing left
  // to fall back for, and the composer says it exactly once.
  const seated = sessionKey('a' as never, 's1' as never)
  const withComposer = makeStore({
    account: { accounts: [], signInMethods: [{ flow: 'apiKey' }] } as unknown as AppSnapshot['account'],
    // A real session this time: an empty conversation pane is not a composer
    // any more than a tool is, so the fallback would otherwise still fire.
    workbench: workbenchFocusedOn('p1', { kind: 'conversation', session: seated }),
  })
  act(() => {
    root.render(
      <StoreProvider store={withComposer}>
        <ShellProvider actions={{ chooseProject: () => {}, signIn: () => {}, openUsage: () => {}, openRuntimes: () => {}, openAgents: () => {}, reviewImports: () => {} }}>
          <div data-testid="strip">
            <NoticeStripOutlet host />
          </div>
          <PaneProvider scope={{ paneId: 'p1' as never, view: { kind: 'conversation', session: seated }, sessionKey: seated }}>
            <div data-testid="composer">
              <ComposerNotices />
            </div>
          </PaneProvider>
        </ShellProvider>
      </StoreProvider>,
    )
  })
  expect(container.querySelector('[data-testid="strip"]')?.textContent).toBe('')
  expect(container.querySelector('[data-testid="composer"]')?.textContent).toContain('is not signed in')
})

it('a NoticeStripOutlet whose caller says it is not the layout’s host draws nothing, even carrying the same dropped link', () => {
  const store = makeStore({ status: 'reconnecting' })
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <ShellProvider actions={{ chooseProject: () => {}, signIn: () => {}, openUsage: () => {}, openRuntimes: () => {}, openAgents: () => {}, reviewImports: () => {} }}>
          <div data-testid="not-host">
            <NoticeStripOutlet host={false} />
          </div>
          <div data-testid="host">
            <NoticeStripOutlet host />
          </div>
        </ShellProvider>
      </StoreProvider>,
    )
  })
  expect(container.querySelector('[data-testid="not-host"]')?.textContent).toBe('')
  expect(container.querySelector('[data-testid="host"]')?.textContent).toContain('Reconnecting to HarnessDesk')
})

it('a room’s composer speaks for its own seats, not the window’s active session', () => {
  const codexId = 'codex' as unknown as AppSnapshot['activeRuntime']
  const inRoom: PersonNotice = {
    id: 'n1',
    from: { runtime: codexId as never, sessionId: 'in-room' as never, name: 'Reviewer' },
    where: 'composer',
    title: 'Ready to merge?',
    at: 1,
  }
  const notInRoom: PersonNotice = {
    id: 'n2',
    from: { runtime: codexId as never, sessionId: 'elsewhere' as never, name: 'Someone else' },
    where: 'composer',
    title: 'A different conversation entirely',
    at: 2,
  }
  const teams = new Map<string, TeamState>([
    [
      'room-1',
      {
        id: 'room-1',
        name: 'Room',
        updatedAt: 0,
        members: [sessionKey(codexId as never, 'in-room' as never)],
        root: '/repo',
        intents: [],
        channel: [],
        messaging: true,
      } as unknown as TeamState,
    ],
  ])
  const store = makeStore({
    activeSessionKey: sessionKey(codexId as never, 'elsewhere' as never),
    agentNotices: [inRoom, notInRoom],
    teams,
  })
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <ShellProvider actions={{ chooseProject: () => {}, signIn: () => {}, openUsage: () => {}, openRuntimes: () => {}, openAgents: () => {}, reviewImports: () => {} }}>
          <PaneProvider scope={{ paneId: 'room-pane' as never, view: { kind: 'room', room: 'room-1' } as never, sessionKey: null }}>
            <ComposerNotices />
          </PaneProvider>
        </ShellProvider>
      </StoreProvider>,
    )
  })
  expect(container.textContent).toContain('Ready to merge?')
  expect(container.textContent).not.toContain('A different conversation entirely')
})

it('a conversation composer with no pane context still speaks for the window’s active session, and a dismiss removes its question', () => {
  const codexId = 'codex' as unknown as AppSnapshot['activeRuntime']
  const active = sessionKey(codexId as never, 's1' as never)
  const notice: PersonNotice = {
    id: 'd1',
    from: { runtime: codexId as never, sessionId: 's1' as never, name: 'Checkout hardening' },
    where: 'composer',
    title: 'A or B?',
    at: 1,
  }
  const store = makeStore({ activeSessionKey: active, agentNotices: [notice] })
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <ShellProvider actions={{ chooseProject: () => {}, signIn: () => {}, openUsage: () => {}, openRuntimes: () => {}, openAgents: () => {}, reviewImports: () => {} }}>
          <ComposerNotices />
        </ShellProvider>
      </StoreProvider>,
    )
  })
  expect(container.textContent).toContain('A or B?')
  act(() => (store as unknown as { dismissAgentNotice(id: string): void }).dismissAgentNotice('d1'))
  expect(container.textContent).not.toContain('A or B?')
})

it('a deliberate retry of the same failing action replaces the toast on screen instead of stacking a second one', () => {
  const store = makeStore({})
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <Notices />
      </StoreProvider>,
    )
  })
  act(() => (store as unknown as { pushNotice(notice: Omit<StoreNotice, 'id'>): void }).pushNotice({ level: 'error', message: 'The lockfile could not be saved.', at: 1 }))
  act(() => (store as unknown as { pushNotice(notice: Omit<StoreNotice, 'id'>): void }).pushNotice({ level: 'error', message: 'The lockfile could not be saved.', at: 2 }))
  expect(showToast).toHaveBeenCalledTimes(2)
  const [firstCall, secondCall] = showToast.mock.calls
  expect(firstCall![0].id).toBe(secondCall![0].id)
})

it('an action toast still keeps its own id per occurrence, so two archives in a row leave two ways back', () => {
  const store = makeStore({})
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <Notices />
      </StoreProvider>,
    )
  })
  const push = (at: number) =>
    (store as unknown as { pushNotice(notice: Omit<StoreNotice, 'id'>): void }).pushNotice({
      level: 'info',
      message: 'Archived "Checkout hardening".',
      at,
      action: { label: 'Undo', run: () => {} },
    })
  act(() => push(1))
  act(() => push(2))
  expect(showToast).toHaveBeenCalledTimes(2)
  const [firstCall, secondCall] = showToast.mock.calls
  expect(firstCall![0].id).not.toBe(secondCall![0].id)
})

it('keeps a standing notice moved to "Inbox only" from Notices alone, with no composer mounted anywhere', () => {
  const policy = withSurface(emptyNoticePolicy(), 'agent:signin', 'inbox')
  const store = makeStore({
    account: { accounts: [], signInMethods: [{ flow: 'apiKey' }] } as unknown as AppSnapshot['account'],
    noticePolicy: policy,
  })
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <ShellProvider actions={{ chooseProject: () => {}, signIn: () => {}, openUsage: () => {}, openRuntimes: () => {}, openAgents: () => {}, reviewImports: () => {} }}>
          <Notices />
        </ShellProvider>
      </StoreProvider>,
    )
  })
  expect(store.getSnapshot().inbox.map((entry) => entry.title)).toEqual(['Agent A is not signed in.'])
  expect(store.getSnapshot().inbox[0]?.read).toBe(false)
})

it('a kept sign-in notice is kept again the next time the agent signs out, once it has signed back in between', () => {
  const signedOut = { accounts: [], signInMethods: [{ flow: 'apiKey' }] } as unknown as AppSnapshot['account']
  const signedIn = { accounts: [{ kind: 'api_key', label: 'API Key' }], signInMethods: [{ flow: 'apiKey' }] } as unknown as AppSnapshot['account']
  const policy = withSurface(emptyNoticePolicy(), 'agent:signin', 'inbox')
  const store = makeStore({ account: signedOut, noticePolicy: policy })
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <ShellProvider actions={{ chooseProject: () => {}, signIn: () => {}, openUsage: () => {}, openRuntimes: () => {}, openAgents: () => {}, reviewImports: () => {} }}>
          <Notices />
        </ShellProvider>
      </StoreProvider>,
    )
  })
  expect(store.getSnapshot().inbox.map((entry) => entry.read)).toEqual([false])

  // Signs in, in the same window: the condition clears, and its stale kept
  // key goes with it — `useKeptOnce`'s own effect catches the transition.
  const setAccount = (store as unknown as { setAccount(account: AppSnapshot['account']): void }).setAccount
  act(() => setAccount(signedIn))
  expect(store.policy().kept).toEqual([])

  // Signs out again: the same key is kept once more, unread — not refused
  // for still being on a list nothing ever took it off before.
  act(() => setAccount(signedOut))
  expect(store.getSnapshot().inbox.map((entry) => entry.read)).toEqual([false])
})

/** Renders each kept message's `go`, when it has one, as a pressable row named for the title. */
const InboxHarness = () => {
  const messages = useInboxMessages()
  return (
    <>
      {messages.map((message) => (
        <button key={message.id} onClick={() => message.go?.()}>
          {String(message.title)}
        </button>
      ))}
    </>
  )
}

it('a kept offer sends a person to the Library, and a kept sign-in notice to that agent’s sign-in', () => {
  const reviewImports = () => {
    calls.push('library')
  }
  const signIn = (id?: string) => {
    calls.push(`signin:${id}`)
  }
  const calls: string[] = []
  const store = makeStore({
    inbox: [
      { id: 'offer', tone: 'info', title: 'Skills to share', at: 1, read: false, open: 'settings:library' },
      { id: 'signin', tone: 'warning', title: 'Codex is not signed in.', at: 2, read: false, open: 'runtime:codex:signin' },
    ],
  })
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <ShellProvider actions={{ chooseProject: () => {}, signIn, openUsage: () => {}, openRuntimes: () => {}, openAgents: () => {}, reviewImports }}>
          <InboxHarness />
        </ShellProvider>
      </StoreProvider>,
    )
  })
  act(() => container.querySelector('button')?.click())
  act(() => [...container.querySelectorAll('button')][1]?.click())
  expect(calls).toEqual(['library', 'signin:codex'])
})

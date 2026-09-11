import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  sessionId,
  sessionKey,
  type RuntimeInfo,
  type Session,
  type SessionKey,
  type TeamPeerInfo,
  type TeamState,
} from '@harnessdesk/protocol'

import { MountProvider } from '../panels/mount'
import { views } from '../panels/views'
import '../panels/builtins'
import { StoreProvider, usePane } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { TeamRoomPane } from './TeamRoomPane'

/**
 * The team room: a list of agents, then the conversations you can have with
 * them.
 *
 * The claims worth pinning are the ones the surface exists for, and each of
 * them was got wrong once:
 *
 *   - the rail lists who is on the board, and says what each is holding;
 *   - a row whose conversation has no name of its own is titled by its agent,
 *     and does not spend its second line saying that agent's name twice;
 *   - pressing an agent shows *that agent's* conversation, scoped to exactly
 *     its session — the room federates conversations, it does not summarise
 *     them;
 *   - Board opens here, in the right half, and not as a second pane, which at
 *     a split left the room as a strip of names with nowhere to read them;
 *   - a message addressed to one agent never becomes a broadcast because that
 *     agent left while it was being written.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The real conversation is the app's largest component and needs a live host;
   what this surface owes it is a scope, so the double reports the scope. */
vi.mock('./Conversation', () => ({
  Conversation: () => {
    const pane = usePane()
    return <div data-testid="conversation">conversation for {String(pane?.sessionKey)}</div>
  },
}))

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
})

const ROOM = 'room-1'

const state: TeamState = {
  id: ROOM,
  name: 'Checkout rewrite',
  root: '/repo',
  members: [sessionKey('codex', 'c1'), sessionKey('claude', 'k1')],
  messaging: true,
  intents: [
    {
      id: 1,
      title: 'Migrate auth callers',
      detail: null,
      state: 'claimed',
      files: ['src/api/**'],
      dependsOn: [],
      claim: { runtime: 'codex', sessionId: 'c1', at: 1 } as never,
      blockedReason: null,
      handoff: null,
      note: null,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 2,
      title: 'Integration tests',
      detail: null,
      state: 'open',
      files: [],
      dependsOn: [],
      claim: null,
      blockedReason: null,
      handoff: null,
      note: null,
      createdAt: 2,
      updatedAt: 2,
    },
  ],
  channel: [],
}

const CODEX: TeamPeerInfo = {
  runtime: 'codex' as never,
  sessionId: 'c1',
  title: 'API migration',
  agent: 'Codex',
  busy: false,
  nickname: 'Codex',
  here: true,
  inbound: 'accept',
}

/** A conversation nobody has named: the row is titled by its nickname, which
    the host assigns on sight precisely so this case has a name at all. */
const CLAUDE: TeamPeerInfo = {
  runtime: 'claude' as never,
  sessionId: 'k1',
  title: null,
  agent: 'Claude Code',
  busy: false,
  nickname: 'Opus',
  here: true,
  inbound: 'accept',
}

const rig = (
  roster: readonly TeamPeerInfo[] = [CODEX, CLAUDE],
  /* What each runtime can do. Defaulted so every existing test is unchanged,
     and overridable because whether a member can reach the board is a property
     of its runtime — there is no other way to write that case. */
  runtimes: readonly unknown[] = [
    { id: 'codex', presentation: { name: 'Codex' }, capabilities: { pluginTools: true } },
    { id: 'claude', presentation: { name: 'Claude Code' }, capabilities: { pluginTools: true } },
  ],
  /* The board this room is looking at. Defaulted so every existing test is
     unchanged; overridable because "has this member done anything" only means
     something once there is something to do. */
  board: Partial<TeamState> = {},
) => {
  const session = {
    id: 'c1',
    runtime: 'codex',
    title: 'API migration',
    cwd: '/repo',
    /* Mid-turn. Whether a member is working is the fact the rail exists to
       show without anything being opened, so the fixture has one that is —
       and it is read from *here*, live, rather than from the roster's copy,
       which goes stale the moment a turn starts or ends. */
    status: { type: 'active' },
    // A real session always has turns; the rail reads them to say whether
    // this agent is mid-turn, live, rather than trusting the roster's copy.
    turns: [],
  } as unknown as Session
  let peers = roster
  let team = { ...state, ...board }
  const snapshotOf = (): AppSnapshot =>
    ({
      ...emptySnapshot(),
      status: 'open',
      workspace: { path: '/repo', name: 'repo', lastOpenedAt: 1 },
      runtimes: runtimes as unknown as RuntimeInfo[],
      sessions: new Map([[sessionKey('codex', 'c1'), session]]),
      teams: new Map([[ROOM, team]]),
    }) as AppSnapshot
  let snapshot = snapshotOf()
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    teamPost: vi.fn().mockResolvedValue(undefined),
    teamHandout: vi.fn().mockResolvedValue({ batch: 'b1', delivered: 1, queued: 0, refused: 0 }),
    teamAdd: vi.fn().mockResolvedValue(undefined),
    teamIntent: vi.fn().mockResolvedValue(undefined),
    teamMessaging: vi.fn().mockResolvedValue(undefined),
    teamPeers: vi.fn(async () => peers),
    openTeamBoard: vi.fn(),
    openSession: vi.fn().mockResolvedValue(undefined),
    setRoomWatching: vi.fn(),
    leaveRoom: vi.fn().mockResolvedValue(undefined),
    setTeamInbound: vi.fn().mockResolvedValue(undefined),
  } as unknown as AppStore
  /** Something new is said in the room, from outside this surface. */
  const says = async (text: string): Promise<void> => {
    team = {
      ...team,
      channel: [
        ...team.channel,
        {
          id: `m-${team.channel.length}`,
          at: 10 + team.channel.length,
          kind: 'message',
          from: { kind: 'agent', runtime: 'codex', sessionId: 'c1', title: 'API migration' },
          text,
          state: 'delivered',
          reason: null,
          envelope: null,
        } as never,
      ],
    }
    snapshot = snapshotOf()
    act(() => {
      root.render(
        <StoreProvider store={store}>
          <TeamRoomPane room={ROOM} />
        </StoreProvider>,
      )
    })
    await act(async () => {})
  }

  /** One sentence to everyone, stored the way the host stores it: a row each. */
  const broadcasts = async (text: string): Promise<void> => {
    team = {
      ...team,
      channel: [
        ...team.channel,
        ...[CODEX, CLAUDE].map((peer, index) => ({
          id: `b-${team.channel.length}-${index}`,
          at: 20 + team.channel.length,
          kind: 'message',
          from: { kind: 'user' },
          to: { runtime: peer.runtime, sessionId: peer.sessionId, title: peer.title, nickname: peer.nickname },
          text,
          state: 'delivered',
          reason: null,
          envelope: null,
        })),
      ] as never,
    }
    snapshot = snapshotOf()
    act(() => {
      root.render(
        <StoreProvider store={store}>
          <TeamRoomPane room={ROOM} />
        </StoreProvider>,
      )
    })
    await act(async () => {})
  }

  /** The board says something happened. A signal is an entry, not a message. */
  const signals = async (): Promise<void> => {
    team = {
      ...team,
      channel: [
        ...team.channel,
        {
          id: `s-${team.channel.length}`,
          at: 30 + team.channel.length,
          kind: 'signal',
          by: { kind: 'agent', runtime: 'codex', sessionId: 'c1', title: 'API migration' },
          signal: 'claimed',
          intent: 1,
          title: 'Migrate auth callers',
          detail: null,
        } as never,
      ],
    }
    snapshot = snapshotOf()
    act(() => {
      root.render(
        <StoreProvider store={store}>
          <TeamRoomPane room={ROOM} />
        </StoreProvider>,
      )
    })
    await act(async () => {})
  }

  /** An agent ends its session: the roster shrinks and the channel says so. */
  const leaves = (gone: TeamPeerInfo): void => {
    peers = peers.filter((one) => one.sessionId !== gone.sessionId)
    team = {
      ...team,
      channel: [
        ...team.channel,
        {
          id: `s-${gone.sessionId}`,
          at: 9,
          kind: 'signal',
          by: { kind: 'agent', runtime: gone.runtime, sessionId: gone.sessionId, title: gone.title },
          signal: 'released',
          intent: 1,
          title: 'Migrate auth callers',
          detail: null,
        } as never,
      ],
    }
    snapshot = snapshotOf()
  }
  return { store, leaves, says, broadcasts, signals }
}

/** Mounts, then flushes the roster fetch so the rail is populated. */
const render = async (store: AppStore, at = ROOM): Promise<void> => {
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <TeamRoomPane room={at} />
      </StoreProvider>,
    )
  })
  await act(async () => {})
}

/* React tracks the value setter, so assigning `.value` and firing `input` is
   a change React never hears. Both helpers go through the prototype's setter,
   which is what a keystroke does. */
const type = (box: HTMLTextAreaElement, text: string): void => {
  /* Throws rather than chaining past a missing descriptor: `?.set?.` reads as
     caution and is the opposite — without it every test that types would put
     nothing in the box and pass. */
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (!setter) throw new Error('no value setter on HTMLTextAreaElement — typing would be a no-op')
  setter.call(box, text)
  box.dispatchEvent(new Event('input', { bubbles: true }))
}

/* The audience anchor, and the menu it opens. The menu is portalled to the
   body — a fixed panel inside an overflowing pane is a panel with a scrollbar
   — so it is looked for there rather than in the pane. */
const audience = (): HTMLButtonElement =>
  container.querySelector(
    '[data-slot="composer-tools"] button[aria-haspopup="menu"]',
  ) as HTMLButtonElement

const menuRows = (): readonly HTMLButtonElement[] =>
  [...document.body.querySelectorAll('[role="menu"] button')] as HTMLButtonElement[]

const menuRow = (text: string): HTMLButtonElement => {
  const found = menuRows().find((one) => one.textContent?.includes(text))
  if (!found) throw new Error(`no menu row containing ${text}`)
  return found
}

const row = (text: string): HTMLElement => {
  const found = [...container.querySelectorAll('[data-slot="list-row"]')].find((entry) =>
    entry.textContent?.includes(text),
  )
  if (!found) throw new Error(`no row containing ${text}`)
  return found as HTMLElement
}

it('the rail is the roster: who is here, and what each of them is holding', async () => {
  const { store } = rig()
  await render(store)

  expect(container.textContent).toContain('2 here')
  // The row is titled by the member's nickname; a conversation that has a name
  // of its own keeps it on the earned line, beside what it holds.
  const named = row('API migration')
  expect(named.textContent).toContain('Codex')
  expect(named.textContent).toContain('#1 Migrate auth callers')
  // An untitled conversation used to read as its agent, which is why a room of
  // three Cursor sessions drew three rows saying "Cursor". It now reads as the
  // name the host gave it, and the agent is carried by the brand mark instead
  // of being spelled a second time.
  const unnamed = row('Opus')
  expect(unnamed.textContent).not.toContain('Claude Code')
})

it('pressing an agent shows that agent’s own conversation, scoped to its session', async () => {
  const { store } = rig()
  await render(store)

  act(() => row('API migration').click())
  await act(async () => {})

  const shown = container.querySelector('[data-testid="conversation"]')
  expect(shown?.textContent).toContain(sessionKey('codex', 'c1'))
})

it('Board opens in the right half, not as a second pane', async () => {
  const { store } = rig()
  await render(store)

  act(() => row('Board').click())
  await act(async () => {})

  // The board's own columns, here.
  expect(container.textContent).toContain('Migrate auth callers')
  expect(container.textContent).toContain('Integration tests')
  expect(store.openTeamBoard).not.toHaveBeenCalled()
})

it('a post goes to the conversation the audience names', async () => {
  const { store } = rig()
  await render(store)

  // Everyone until somebody is named — the default, and the common case.
  expect(audience().textContent).toContain('Everyone')

  act(() => audience().click())
  /* Never the runtime id: the menu says what the person called the thing.
     The nickname is the label because it is unique on the board by
     construction and it is what an agent is addressed by; the conversation's
     own name is the line under it, when it has one. */
  const rows = menuRows().map((one) => one.textContent)
  expect(rows[0]).toContain('Everyone in the room')
  expect(rows[1]).toContain('Codex')
  expect(rows[1]).toContain('API migration')
  expect(rows[2]).toContain('Opus')

  act(() => menuRow('Codex').click())
  const box = container.querySelector('textarea') as HTMLTextAreaElement
  act(() => type(box, 'the ledger rounds down'))
  act(() =>
    (container.querySelector('[data-slot="composer-send"]') as HTMLButtonElement).click(),
  )
  await act(async () => {})

  expect(store.teamPost).toHaveBeenCalledWith(ROOM, 'the ledger rounds down', {
    runtime: 'codex',
    sessionId: 'c1',
  })
  // One recipient is a post, never a hand-out: one row, one delivery state.
  expect(store.teamHandout).not.toHaveBeenCalled()
})

it('an agent that leaves the board leaves the rail and the audience', async () => {
  const { store, leaves } = rig()
  await render(store)

  expect(container.textContent).toContain('2 here')
  act(() => audience().click())
  act(() => menuRow('Codex').click())
  expect(audience().textContent).toContain('Codex')

  // Codex ends its session. Both places that named it must stop naming it —
  // a rail still listing an agent that has gone is a room you cannot trust,
  // and an audience holding it is a message with nowhere to land.
  leaves(CODEX)
  await render(store)

  expect(container.textContent).toContain('1 here')
  expect(container.textContent).not.toContain('API migration — Codex')
  expect(() => row('API migration')).toThrow()
  /* Back to everyone rather than to a name that has gone. The chip goes with
     it: an audience the reader can still see but the host cannot reach is the
     one state this guard exists to prevent. */
  expect(audience().textContent).toContain('Everyone')
  expect(container.querySelector('[data-slot="composer-chip"]')).toBeNull()
})

/* ---------------------------------------------------------------------------
 * What the Team panel used to hold
 *
 * These three moved here when the panel was merged away. Each is something a
 * person can only find out from this surface, and losing any of them in the
 * merge would have been a quiet regression rather than a visible one.
 */

it('board-only is one press from the room’s header, and says which way it is set', async () => {
  const { store } = rig()
  await render(store)

  const toggle = [...container.querySelectorAll('button')].find(
    (one) => one.textContent?.trim() === 'messaging on',
  )
  if (!toggle) throw new Error('no messaging switch')
  act(() => toggle.click())
  expect(store.teamMessaging).toHaveBeenCalledWith(ROOM, false)
})

it('a failed post keeps the words in the box and says so', async () => {
  const { store } = rig()
  ;(store.teamPost as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no'))
  await render(store)

  const box = container.querySelector('textarea') as HTMLTextAreaElement
  act(() => type(box, 'the words'))
  act(() => (container.querySelector('[data-slot="composer-send"]') as HTMLButtonElement).click())
  await act(async () => {})

  // The person's sentence is still where they typed it — a post that failed
  // and cleared the field is a message they have to write twice, and they
  // would not know it failed until they looked.
  expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('the words')
  expect(container.textContent).toContain('still here')
})

it('re-reads the roster when the room’s membership moves', async () => {
  /* Joining takes neither a new conversation nor a message, so a fetch keyed
     only on those two was stale for the life of the pane: the rail said
     "Nobody here yet" beside a sidebar drawing the two members the room had
     just gained. Caught by a recording, not by a test.

     Also pins the sentence itself. It used to end "one joins the room when it
     takes a turn", which was true while a folder was a board — nothing joins
     by itself now, and pointing at a wait that will never end is worse than
     saying nothing. */
  const { store } = rig([], undefined, { members: [] })
  const snapshot = store.getSnapshot()
  await render(store)
  expect(container.textContent).toContain('No agents in this room yet')
  expect(container.textContent).not.toContain('takes a turn')

  // The host says somebody joined; the pane must ask again.
  ;(store.teamPeers as ReturnType<typeof vi.fn>).mockResolvedValue([CODEX])
  ;(snapshot.teams as Map<string, TeamState>).set(ROOM, {
    ...state,
    members: [sessionKey('codex', sessionId('c1'))],
  })
  await render(store)

  expect(container.textContent).not.toContain('Nobody here yet')
  expect(container.textContent).toContain('API migration')
})

it('the room’s channel says it is the room’s, not the project’s', async () => {
  // A project holds several rooms; "everyone on this project reads this" was
  // true of a folder board and is now a promise the channel does not keep.
  const { store } = rig()
  await render(store)
  expect(container.textContent).not.toContain('Everyone on this project')
  expect(container.textContent).toContain('Everyone in this room')
})

it('the host’s own problem with the board is said on the surface', async () => {
  const { store } = rig()
  await render(store)
  expect(container.textContent).not.toContain('could not be saved')

  const { store: broken } = rig()
  ;(broken.getSnapshot().teams as Map<string, TeamState>).set(ROOM, {
    ...state,
    problem: 'The board could not be saved; what you see may not survive a restart.',
  } as TeamState)
  await render(broken)

  // Not the same failure as "your last press did not land", and it must not
  // be folded into it: this one says the record itself is at risk.
  expect(container.textContent).toContain('could not be saved')
})

it('a claimed intent is matched on the runtime too, not the session id alone', async () => {
  // Session ids are unique per runtime, not globally. `CLAUDE` here holds the
  // same id as no one; the fixture gives it Codex's id on a different runtime,
  // which is exactly the collision that put one claim on two rows.
  const collision: TeamPeerInfo = { ...CLAUDE, sessionId: 'c1' }
  const { store } = rig([CODEX, collision])
  await render(store)

  expect(row('API migration').textContent).toContain('#1 Migrate auth callers')
  expect(row('Opus').textContent).not.toContain('Migrate auth callers')
})

/**
 * The door, said out loud.
 *
 * From a live run: an agent listed the board's tools, called them twice, and was
 * refused both times. From the agent's seat the tools existed; from the
 * person's, nothing happened, and nothing on screen said why. HarnessDesk's
 * tools reach an agent through a server the agent has to accept, and one that
 * refused it can see nothing on the board and claim nothing — a fact that was
 * discoverable only by an agent walking into it.
 */
it('a member that cannot reach the board says so on its row', async () => {
  const { store } = rig(
    [CODEX, CLAUDE],
    [
      { id: 'codex', presentation: { name: 'Codex' }, capabilities: { pluginTools: true } },
      { id: 'claude', presentation: { name: 'Claude Code' }, capabilities: { pluginTools: false } },
    ],
  )
  await render(store)

  // The one that can is not made to say so — the expected case stays quiet.
  expect(row('API migration').textContent).not.toContain('cannot take jobs')
  // The one that cannot says it before anything is asked of it.
  expect(row('Opus').textContent).toContain('cannot take jobs')
})

/**
 * A zero says what it counted.
 *
 * "Open one in this workspace and it joins" was read by somebody who had two
 * conversations open in that workspace, in front of a roster saying none. The
 * rule is real — a conversation joins when it is attached to its agent — and it
 * was applied invisibly, which nobody can tell apart from a broken feature.
 */
it('an empty roster says how many conversations it looked at', async () => {
  const { store } = rig([])
  await render(store)
  const text = container.textContent ?? ''
  expect(text).toContain('conversation')
  // Never the old phrasing, which said only what it wanted.
  expect(text).not.toContain('Open one in this workspace and it joins')
})

/**
 * Two transcripts, one roof.
 *
 * The commit that made a conversation main-only withdrew the right-dock mount
 * and paid for it with a promise: "the need is met inside the room, where the
 * member columns show several transcripts at once". This is that promise. It
 * was a sentence in a commit message for several commits, which is the failure
 * these tests exist to make impossible to repeat.
 */
/**
 * How wide the pane is, said out loud.
 *
 * jsdom gives every element a zero-width box, so a surface that measures itself
 * is untestable until the width is stated. Stating it is also the point: the
 * cap is a function of width, and a test that could not vary the width could
 * not check the rule.
 */
const paneWidth = (px: number): void => {
  const real = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function measured(this: HTMLElement) {
    if (this.hasAttribute('data-columns')) return { width: px, height: 800 } as DOMRect
    return real.call(this)
  }
}

it('watches a second member beside the first, headed by whose it is', async () => {
  paneWidth(1400)
  const { store } = rig()
  await render(store)

  /* Every member offers to be watched, before anything is on screen and
     after. The verb used to appear only once a member was already up, on the
     theory that with nothing there is nothing to sit beside — true of the
     *second* column and false of the first, so a person who wanted two members
     up had to open one the ordinary way and then discover a control that had
     not existed a moment earlier.

     Named by its label rather than by its glyph: the roster's own "add an
     agent" control is a `+` too, and matching on the character made this pass
     for the wrong reason and then fail for another wrong one. */
  const watchVerbs = (): readonly string[] =>
    [...container.querySelectorAll('button')]
      .map((one) => one.getAttribute('aria-label') ?? '')
      .filter((label) => label.startsWith('Watch '))
  expect(watchVerbs()).toHaveLength(2)

  act(() => row('API migration').click())
  expect(container.querySelectorAll('[data-columns]')).toHaveLength(1)
  expect(container.querySelector('[data-columns]')?.getAttribute('data-columns')).toBe('1')

  // Now a second can join it, and the verb appears on the members that are not up.
  const add = [...container.querySelectorAll('button')].find(
    (one) => one.getAttribute('aria-label')?.startsWith('Watch Opus'),
  )
  expect(add, 'the members not on screen offer to join the ones that are').toBeDefined()
  act(() => add?.click())

  expect(container.querySelector('[data-columns]')?.getAttribute('data-columns')).toBe('2')
  // Each column says whose it is — two conversations on one agent and one
  // account are told apart here or nowhere.
  expect(container.textContent).toContain('Codex')
  expect(container.textContent).toContain('Opus')
})

it('a column can be put away, and the last one keeps no close', async () => {
  paneWidth(1400)
  const { store } = rig()
  await render(store)
  act(() => row('API migration').click())
  const add = [...container.querySelectorAll('button')].find((one) =>
    one.getAttribute('aria-label')?.startsWith('Watch Opus'),
  )
  act(() => add?.click())

  const close = [...container.querySelectorAll('button')].filter((one) =>
    one.getAttribute('aria-label')?.startsWith('Stop watching'),
  )
  // Two columns, two ways to put one away; one column offers none, because
  // closing the only thing on screen leaves the pane with nothing to say.
  expect(close).toHaveLength(2)
  act(() => close[1]?.click())
  expect(container.querySelector('[data-columns]')?.getAttribute('data-columns')).toBe('1')
  expect(
    [...container.querySelectorAll('button')].filter((one) =>
      one.getAttribute('aria-label')?.startsWith('Stop watching'),
    ),
  ).toHaveLength(0)
})

/**
 * A pane too narrow for two says so by holding one.
 *
 * A transcript and its composer stop being readable together under about
 * 420px, so the cap is what the pane can actually hold rather than a constant.
 * Picking a second member in a pane with room for one replaces what is there —
 * it does not squeeze two into a width where neither can be read.
 */
it('holds one column when only one fits, and replaces rather than squeezes', async () => {
  paneWidth(500)
  const { store } = rig()
  await render(store)

  act(() => row('API migration').click())
  expect(container.querySelector('[data-columns]')?.getAttribute('data-columns')).toBe('1')

  const add = [...container.querySelectorAll('button')].find((one) =>
    one.getAttribute('aria-label')?.startsWith('Watch Opus'),
  )
  act(() => add?.click())

  // Still one column, and it is the newly picked member — not two unreadable
  // halves, and not a press that silently did nothing.
  expect(container.querySelector('[data-columns]')?.getAttribute('data-columns')).toBe('1')
  expect(container.textContent).toContain('Opus')
})

/**
 * The columns are the view's, not the pane's.
 *
 * The middle is a slot: opening a conversation replaces the room and unmounts
 * it. While what-is-being-watched lived in component state, two columns
 * arranged on purpose were thrown away by the next click, and Back — which
 * exists so the slot does not lose your place — handed back an empty room.
 */
it('opens the members the view says it was watching', async () => {
  paneWidth(1400)
  const { store } = rig()
  const scope = {
    area: 'main' as const,
    id: 'pane-1',
    view: {
      kind: 'room' as const,
      room: ROOM,
      watching: [sessionKey('codex', 'c1'), sessionKey('claude', 'k1')],
    },
  }
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <MountProvider scope={scope}>
          <TeamRoomPane room={ROOM} />
        </MountProvider>
      </StoreProvider>,
    )
  })
  await act(async () => { await Promise.resolve() })

  expect(container.querySelector('[data-columns]')?.getAttribute('data-columns')).toBe('2')
  expect(container.textContent).toContain('API migration')
})

it('writes what it is watching back to the view', async () => {
  const { store } = rig()
  const setRoomWatching = vi.fn()
  const withWriter = { ...store, setRoomWatching } as unknown as AppStore
  const scope = { area: 'main' as const, id: 'pane-1', view: { kind: 'room' as const, room: ROOM } }
  await act(async () => {
    root.render(
      <StoreProvider store={withWriter}>
        <MountProvider scope={scope}>
          <TeamRoomPane room={ROOM} />
        </MountProvider>
      </StoreProvider>,
    )
  })
  await act(async () => { await Promise.resolve() })

  act(() => row('API migration').click())
  expect(setRoomWatching).toHaveBeenCalledWith('pane-1', [sessionKey('codex', 'c1')])
})

/**

 * Holding the reader's place is only half of it.
 *
 * A chat that yanks the reader to the floor takes away the line they were
 * reading; a chat that holds them there in silence hides the answer to the
 * question they asked two minutes ago. The count is what makes staying put a
 * decision rather than a failure to notice.
 */
it('holds the reader’s place when new things are said, and says how many', async () => {
  const { store, says } = rig()
  await render(store)

  const stream = container.querySelector('[data-slot="room-stream"]') as HTMLDivElement
  /* jsdom lays nothing out, so the scroll geometry is supplied: 600px above
     the floor of a 1000px stream, which is what "reading something" looks
     like. */
  Object.defineProperty(stream, 'scrollHeight', { value: 1000, configurable: true })
  Object.defineProperty(stream, 'clientHeight', { value: 400, configurable: true })
  stream.scrollTop = 0
  act(() => stream.dispatchEvent(new Event('scroll', { bubbles: true })))

  await says('the gateway tests are green')
  expect(container.textContent).toContain('1 new message')

  await says('and the migration landed')
  expect(container.textContent).toContain('2 new messages')

  const back = [...container.querySelectorAll('button')].find((one) =>
    one.textContent?.includes('new messages'),
  )
  if (!back) throw new Error('no way back to the floor')
  act(() => back.click())
  expect(container.textContent).not.toContain('new messages')
})

/**
 * A room with no board at all must not spin.
 *
 * `team?.channel ?? []` minted a new array on every render, `readChannel`
 * memoised on it, the effect that follows the floor re-ran on the fresh rows,
 * and it wrote a new `behind` object — which rendered again. A room opened on
 * a project that has no board sat at 100% of a core doing nothing, and the
 * failing roster request is what put people there.
 */
it('does not spin on a project that has no board', async () => {
  const { store } = rig()
  ;(store.teamPeers as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('the host is gone'))

  /* Renders are counted rather than timed: a loop is not "slow", it is
     unbounded, and a timer would only report that the machine was busy.
     `useSyncExternalStore` reads the snapshot on every render, so counting
     those reads counts renders — a settled tree does none.

     The counter goes in *before* the first render and throws at a ceiling,
     rather than asserting a total afterwards. A cascade of effects saturates
     the microtask queue, so with the bug present nothing downstream of it ever
     runs: not the sleep below, not vitest's own per-test timeout. Reading the
     count after the fact meant the worker hung and had to be killed from
     outside, which is a red run with no name on it. Throwing from inside the
     cascade stops it where it happens and fails this test by name. */
  let reads = 0
  const real = store.getSnapshot.bind(store)
  const CEILING = 100
  ;(store as { getSnapshot: () => unknown }).getSnapshot = () => {
    reads += 1
    if (reads > CEILING) {
      throw new Error(`the room re-rendered ${reads} times on a project with no board`)
    }
    return real()
  }

  // A workspace the host has never made a board for: `teams` has no entry.
  await render(store, '/elsewhere')
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200))
  })

  expect(reads).toBeLessThan(CEILING)
  // And it settled saying the honest empty thing rather than nothing at all.
  expect(container.textContent).toContain('Nothing said yet')
})

/**
 * The rail's zero-state is a claim about the room, so silence must not make it.
 *
 * A failed roster request used to empty the roster, and the rail then said —
 * in a full sentence — that there were no conversations in a project that had
 * two of them a second earlier. Nothing is said about who is here until the
 * host has said something.
 */
it('says nothing about the roster when the request for it fails', async () => {
  const { store } = rig()
  ;(store.teamPeers as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('the host is gone'))
  await render(store)

  const text = container.textContent ?? ''
  expect(text).not.toContain('No conversations in this project yet')
  expect(text).not.toContain('not attached to their agents')
  /* And the head does not invent a count it was never given. `0 here` from a
     failed request is the same sentence as `0 here` from an empty room, and
     only one of them is true — so neither is drawn. What the board knows, the
     board still says. */
  expect(text).not.toContain('0 here')
  expect(text).not.toContain('2 here')
  expect(text).not.toContain('1 working')
  // What the board knows, the board still says.
  expect(text).toContain('claimed')
})

/**
 * A room is a room *for a project*, and almost everything it holds is about
 * that project.
 *
 * Which conversations are being watched, the roster filter, a half-written
 * message and who it was addressed to, how far behind the reader is. None of
 * it is a prop, so pointing the same pane at another project carried all of it
 * across: Room A's conversation still drawn as a column under Room B's name —
 * and then written back into Room B's `watching`, where the next launch would
 * read it as its own.
 *
 * The fix is at the mount site, and so is the test: `RoomView` keys the pane by
 * the room, because a list of things to clear on a change is a list somebody
 * has to remember to add to, and the two found here were found one at a time.
 * By room rather than by root, which is the same fix one notch finer — two
 * rooms in one project are exactly the pair a root key cannot tell apart, and
 * they are the ordinary case now.
 */
it('starts a different room fresh, rather than wearing the last one’s', async () => {
  paneWidth(1400)
  const { store } = rig()
  const Room = views.get('room')?.component
  if (!Room) throw new Error('the room view is not registered')

  const mount = (room: string, watching: readonly SessionKey[]) => ({
    area: 'main' as const,
    id: 'pane-1',
    view: { kind: 'room' as const, room, watching },
  })

  // Room A, watching one of its conversations.
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <MountProvider scope={mount(ROOM, [sessionKey('codex', 'c1')])}>
          <Room />
        </MountProvider>
      </StoreProvider>,
    )
  })
  await act(async () => {})
  expect(container.querySelector('[data-columns]')?.getAttribute('data-columns')).toBe('1')

  /* The same pane id, pointed at another room *in the same project* — the
     case a root key was blind to. Without the key React keeps the instance
     and its state, so Room A's column survived into Room B. */
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <MountProvider scope={mount('room-2', [])}>
          <Room />
        </MountProvider>
      </StoreProvider>,
    )
  })
  await act(async () => {})

  expect(container.querySelector('[data-columns]')).toBeNull()
  expect(container.textContent).not.toContain('conversation for')
})

/**
 * A roster belongs to the room it was fetched for.
 *
 * This pane is reused when it is pointed at another room, so state about the
 * last one is read under the new one's name. Harmless while a failed request
 * emptied the roster; the moment failure started *preserving* it, Room B wore
 * Room A's agents, its head count and its recipient menu.
 */
it('a half-written message does not follow you into the next room', async () => {
  const { store } = rig()
  await render(store)

  const box = container.querySelector('textarea') as HTMLTextAreaElement
  act(() => type(box, 'not for this room'))
  expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('not for this room')

  /* The same pane, pointed at a different room. The audience prunes itself
     against the new roster either way — but the words would have come along,
     one keystroke from being sent to people they were never written for. */
  await render(store, '/other')
  expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('')
})

it('never wears the last room’s roster under this room’s name', async () => {
  const { store } = rig()
  await render(store)
  expect(container.textContent).toContain('2 here')
  expect(container.textContent).toContain('API migration')

  // The same pane, pointed somewhere else, whose roster request fails.
  ;(store.teamPeers as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('the host is gone'))
  await render(store, '/other')

  const text = container.textContent ?? ''
  expect(text).not.toContain('API migration')
  expect(text).not.toContain('Opus')
  expect(text).not.toContain('2 here')
  // And the audience menu is not offering the other project's conversations.
  act(() => audience().click())
  const menu = document.body.querySelector('[role="menu"]')?.textContent ?? ''
  expect(menu).not.toContain('API migration')
  expect(menu).not.toContain('Opus')
  /* A roster that never arrived is not an empty room, and only one of those
     two is a claim this surface may make on the host's behalf. */
  expect(menu).toContain('Still asking the host who is in the room')
})

/**
 * The pill counts what the reader will see, and calls it what it is.
 *
 * It counted raw channel entries. A post to everyone is stored once per
 * recipient and drawn once, so one sentence to two agents said "2 new
 * messages" over one new row — and a signal, which is an entry too, was
 * counted as a message. Both are the same mistake: counting the record instead
 * of the reading.
 */
it('counts one broadcast once, and does not call a signal a message', async () => {
  const { store, broadcasts, signals } = rig()
  await render(store)

  const stream = container.querySelector('[data-slot="room-stream"]') as HTMLDivElement
  Object.defineProperty(stream, 'scrollHeight', { value: 1000, configurable: true })
  Object.defineProperty(stream, 'clientHeight', { value: 400, configurable: true })
  stream.scrollTop = 0
  act(() => stream.dispatchEvent(new Event('scroll', { bubbles: true })))

  // Two stored entries, one thing said.
  await broadcasts('ship it when the gate is green')
  expect(container.textContent).toContain('1 new message')
  expect(container.textContent).not.toContain('2 new')

  // A claim is not a message, so the batch stops calling itself one.
  await signals()
  expect(container.textContent).toContain('2 new updates')
  expect(container.textContent).not.toContain('2 new messages')
})

/**
 * The roster answers "is anything running" without anything being opened.
 *
 * The old row spent its one grey line joining three facts with a middle dot
 * and then truncated, so whether an agent was mid-turn survived only when it
 * happened to be the shortest of the three. It is a light now — and the head
 * counts the same fact, from the same list, so the two cannot disagree.
 */
it('says which members are working, and counts them in the head', async () => {
  const { store } = rig()
  await render(store)

  expect(container.textContent).toContain('1 working')
  /* Read as text, not as a class: the CSS module is stubbed to nothing in this
     environment, so asserting on the light's class name would pass whether or
     not the light was drawn. What is asserted is the half that has to be right
     anyway — what the row says to a reader who cannot see a colour. */
  expect(row('API migration').textContent).toContain('working')
  expect(row('Opus').textContent).not.toContain('working')
})

/**
 * Watching beside is one verb, and a verb that appears and disappears is a
 * verb nobody learns.
 *
 * It used to be drawn only once a member was already up, on the theory that
 * with nothing on screen there is nothing to sit beside — which is true of the
 * second column and false of the first.
 */
it('offers “watch beside” before anything is being watched', async () => {
  const { store } = rig()
  await render(store)

  const watch = [...container.querySelectorAll('button')].filter((one) =>
    one.getAttribute('aria-label')?.startsWith('Watch '),
  )
  expect(watch).toHaveLength(2)

  act(() => (watch[1] as HTMLButtonElement).click())
  await act(async () => {})
  expect(container.querySelector('[data-columns]')?.getAttribute('data-columns')).toBe('1')
})

/**
 * A member that advertises the board and never touches it.
 *
 * The rail's "cannot take jobs" chip reads `capabilities.pluginTools`, which is
 * the runtime's claim about itself. A real member advertised the tools, listed
 * them back accurately when asked, and could not invoke one — so the chip built
 * for exactly that case stayed silent and the board simply looked unpopular.
 */
it('says when a member has not used the board, once there is something to take', async () => {
  const idle: TeamPeerInfo = { ...CLAUDE, usedBoard: false }
  const busyOne: TeamPeerInfo = { ...CODEX, usedBoard: true }
  const { store } = rig([busyOne, idle])
  await render(store)

  expect(row('Opus').textContent).toContain('has not used the board')
  expect(row('Codex').textContent).not.toContain('has not used the board')
})

it('says nothing about board use while the board is empty', async () => {
  // Nothing has been asked of anyone, so nobody has failed to answer.
  const { store } = rig([{ ...CODEX, usedBoard: false }], undefined, { intents: [], channel: [] })
  await render(store)
  expect(container.textContent).not.toContain('has not used the board')
})

/**
 * The room's one top row.
 *
 * It replaced three stacked bars: the pane's strip printing `Room — <name>`,
 * the rail's head printing `<name>` again under it, and the chat's head
 * printing back the rail row that had just been pressed. Each of the four
 * claims below is one of the things that were true of that arrangement and
 * must not become true again.
 */
it('names the room once, on a row that is also the window’s handle', async () => {
  const { store } = rig()
  await render(store)

  const bar = container.querySelector('header')
  if (!bar) throw new Error('no top row')
  // The room's name, its live counts and the switch, all on one row.
  expect(bar.textContent).toContain('Checkout rewrite')
  expect(bar.textContent).toContain('1 working')
  expect(bar.textContent).toContain('messaging on')
  // Said once. The name used to be printed by the strip above and the rail
  // head below it, so a room called "Checkout rewrite" said so twice before
  // anything in it had been read.
  const named = container.textContent?.split('Checkout rewrite').length ?? 1
  expect(named - 1, 'the room is named once').toBe(1)
  // A top row moves the window, like the conversation's header and the
  // sidebar's title bar. Read as a class rather than a computed style: the
  // property is Electron's and jsdom has never heard of it.
  expect(bar.className).toContain('hd-drag')
  // And its controls opt back out, or the press is eaten by the drag.
  const toggle = [...bar.querySelectorAll('button')].find(
    (one) => one.textContent?.trim() === 'messaging on',
  )
  expect(toggle?.closest('.hd-no-drag'), 'the switch is out of the drag region').not.toBeNull()
})

it('draws the chat with no header of its own', async () => {
  const { store } = rig()
  await render(store)

  // The rail's row says "Chat / Everyone in this room"; the head that used to
  // sit over the stream said "Chat / Everyone in this room reads this" — the
  // destination repeated back to the person who had just chosen it.
  expect(container.textContent).not.toContain('Everyone in this room reads this')
  const rows = [...container.querySelectorAll('[data-slot="list-row"]')].filter((entry) =>
    entry.textContent?.startsWith('Chat'),
  )
  expect(rows, 'Chat is a rail row and nothing else').toHaveLength(1)
})

it('carries the panel’s verbs on its own row, so the pane draws no strip', async () => {
  const { store } = rig()
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <MountProvider scope={{ area: 'main', id: 'pane-1', view: { kind: 'room', room: ROOM } }}>
          <TeamRoomPane room={ROOM} />
        </MountProvider>
      </StoreProvider>,
    )
  })
  await act(async () => {})

  // In the middle, "the whole area" is what a room already has — so the verb
  // it is offered is the one that means something.
  const bar = container.querySelector('header')
  expect(bar?.querySelector('[aria-label="Fill the window"]')).not.toBeNull()
  // And the registry agrees, which is what stops `Panes` drawing a strip above
  // this row. `chrome.test.ts` holds the other half of that bargain.
  expect(views.get('room')?.ownsChrome).toBe(true)
})

/**
 * The one failure the top row can have, said out loud.
 *
 * Board-only used to live in the chat's own header, where the chat's trouble
 * line was there to carry a refusal. It is on the room's row now, one surface
 * up — so a switch that failed while the *board* was open had nowhere at all
 * to say so, and the control simply sprang back with no explanation. The
 * redesign claimed this line; nothing pinned it until review asked.
 */
it('says so when the host will not take the board-only switch', async () => {
  const { store } = rig()
  const refusing = {
    ...store,
    teamMessaging: vi.fn().mockRejectedValue(new Error('nope')),
  } as unknown as AppStore
  await render(refusing)

  const toggle = [...container.querySelectorAll('button')].find(
    (one) => one.textContent?.trim() === 'messaging on',
  )
  if (!toggle) throw new Error('no messaging switch')
  await act(async () => {
    toggle.click()
  })
  await act(async () => {})

  const alert = container.querySelector('[role="alert"]')
  expect(alert?.textContent).toContain('The host did not take the change')
  // And the switch still reads as it really is, rather than as it was pressed.
  expect(container.textContent).toContain('messaging on')
})

/**
 * The room after a quit: every member still on the rail, none of them open.
 *
 * The bug this pins was reported as chat history not being stored. The history
 * was stored; the roster was not drawn. A room's members are persisted, and
 * the desk holds no conversation until somebody opens one — so the rail read
 * "Nobody here yet" over a channel full of what those members had said, beside
 * a sidebar that drew every one of them under the room's own row. Two surfaces,
 * one room, and only one of them was right.
 */
it('draws the members of a room the desk has not opened, and says they are not open', async () => {
  const { store } = rig([
    { ...CODEX, here: false },
    { ...CLAUDE, here: false },
  ])
  await render(store)

  /* The sentence goes on the row that has nothing more specific to say. The
     other one is holding #1, which is the more specific fact and keeps the
     line — a row shows one, and what a member is working on outranks why it
     looks quiet. Its away-ness is on the mark and in the sr-only run. */
  expect(row('Opus').textContent).toContain('not open — a message opens it')
  expect(row('Codex').textContent).toContain('Migrate auth callers')
  expect(row('Codex').textContent).toContain('not open')
  expect(row('Codex').querySelector('[data-away]')).not.toBeNull()
  // And the head counts both facts rather than collapsing them into one.
  expect(container.textContent).toContain('0 of 2 here')
  expect(container.textContent).not.toContain('No agents in this room yet')
})

/**
 * "Has not used the board" is evidence from *this* run, and a member nobody
 * has opened this run has provided none. Without the gate, the first launch of
 * the day accused every member of every room of ignoring the board.
 */
it('does not accuse a member that is not open of ignoring the board', async () => {
  const { store } = rig([{ ...CLAUDE, here: false, usedBoard: false }])
  await render(store)
  expect(container.textContent).not.toContain('has not used the board')
})

/**
 * Leaving is a gesture now, because it stopped being a side effect.
 *
 * Membership used to end whenever a conversation stopped being open, which is
 * what emptied every room after a relaunch. A room keeps its members, so the
 * way out has to be something a person does — `team/room/leave` had been on
 * the wire the whole time with nothing to press. On the card with Open and
 * Watch, never on the row: a destructive verb one pixel from the thing it
 * destroys is how a roster gets emptied by accident.
 */
it('takes a member out of the room from its card, and leaves the conversation alone', async () => {
  vi.useFakeTimers()
  const { store } = rig()
  await render(store)

  // The whole row is the trigger, so it holds the row rather than sitting in it.
  const trigger = row('Codex').closest('[data-slot="hover-card-trigger"]')
  expect(trigger).not.toBeNull()
  act(() => {
    ;(trigger as Element).dispatchEvent(
      new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }),
    )
  })
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  const remove = [...document.body.querySelectorAll('button')].find(
    (one) => one.textContent?.trim() === 'Take out of the room',
  )
  expect(remove).toBeDefined()

  act(() => (remove as HTMLButtonElement).click())
  expect(store.leaveRoom).toHaveBeenCalledWith(ROOM, 'codex', 'c1')
  // The conversation itself is untouched: nothing here closes or deletes it.
  expect(store.openSession).not.toHaveBeenCalled()
  vi.useRealTimers()
})

/**
 * A column opens the conversation it is about to draw.
 *
 * Every other surface that puts a transcript on screen opens it first. This
 * one never had to: the rail could only list a member the desk was already
 * holding, so the session was always in the snapshot by the time a column
 * mounted. Listing members that are *not* open broke that assumption, and
 * without the fix a click on one mounted `Conversation` over nothing — the
 * generic empty state, in a column headed by the member's own name.
 *
 * `reveal: false` is the load-without-navigating half: the column already is
 * the pane, and revealing would replace the room around it.
 */
it('opens an away member’s conversation when it goes into a column', async () => {
  const { store } = rig([{ ...CLAUDE, here: false }])
  await render(store)

  act(() => row('Opus').click())
  await act(async () => {})

  expect(store.openSession).toHaveBeenCalledWith('k1', { runtime: 'claude', reveal: false })
})

it('does not re-open a member the desk already holds', async () => {
  // CODEX is `here`, and the rig's snapshot carries its session.
  const { store } = rig([CODEX])
  await render(store)

  act(() => row('Codex').click())
  await act(async () => {})

  expect(store.openSession).not.toHaveBeenCalled()
})

/**
 * A column that failed to open tries again when it is put up again.
 *
 * The guard remembered the *attempt*, not the outcome, so one transient
 * failure — the agent briefly down, a timeout — was permanent for the life of
 * the pane: the agent comes back, the person closes the column and reopens
 * it, and nothing asks a second time. The column sits on the conversation's
 * own empty state with no way back but a remount. Both round-two reviewers
 * found this independently.
 */
it('asks again for a member whose conversation failed to open', async () => {
  const { store } = rig([{ ...CLAUDE, here: false }])
  ;(store.openSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('the agent is down'))
  await render(store)

  // Open it — the attempt fails.
  act(() => row('Opus').click())
  await act(async () => {})
  expect(store.openSession).toHaveBeenCalledTimes(1)

  // Close the column and open it again: the guard must not still be holding
  // the failure from a moment ago.
  act(() => row('Chat').click())
  await act(async () => {})
  act(() => row('Opus').click())
  await act(async () => {})
  expect(store.openSession).toHaveBeenCalledTimes(2)
})

/**
 * One member set to hold, in a room where the others may talk.
 *
 * Board-only is this decision taken for everybody at once, and it was the
 * only one on offer: `team/inbound` carried the per-conversation setting the
 * whole time with nothing anywhere to press. A room is rarely uniform — one
 * member is mid-refactor and the other nine may be interrupted — and saying
 * so used to mean silencing the room.
 */
it('sets one member’s inbound from its card, leaving the room’s own switch alone', async () => {
  vi.useFakeTimers()
  const { store } = rig()
  await render(store)

  const trigger = row('Codex').closest('[data-slot="hover-card-trigger"]')
  act(() => {
    ;(trigger as Element).dispatchEvent(
      new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }),
    )
  })
  act(() => {
    vi.advanceTimersByTime(1000)
  })

  /* A setting with three states, shown as one — not three verbs beside Open
     and Watch beside. The card shows which state it is in, which a list of
     verbs cannot, and the verbs row stops overflowing the card. */
  const group = document.body.querySelector('[aria-label="Messages"]')
  expect(group, 'the inbound band is on the card').toBeTruthy()
  const modes = [...(group?.querySelectorAll('button') ?? [])].map((one) => one.textContent?.trim())
  expect(modes).toEqual(['Accept', 'Hold', 'Refuse'])

  const hold = [...(group?.querySelectorAll('button') ?? [])].find(
    (one) => one.textContent?.trim() === 'Hold',
  )
  act(() => (hold as HTMLButtonElement).click())
  await act(async () => {})

  expect(store.setTeamInbound).toHaveBeenCalledWith('codex', 'c1', 'hold')
  // Not the room-wide switch, which is the whole distinction being drawn.
  expect(store.teamMessaging).not.toHaveBeenCalled()
  /* And the room is still the room. A React portal's events bubble through
     the React *tree*, so a press on the card used to reach the row it hung
     off, and picking an inbound mode navigated away to that member's own
     conversation — the chat replaced by a transcript. Photographed on the
     real app. The card hangs off the whole row now, so its portal sits beside
     the row rather than inside it; this keeps the press that went wrong. */
  expect(container.textContent).toContain('Nothing said yet')
  vi.useRealTimers()
})

/* A pointer coming to rest on one spot, and leaving it — the way Radix hears
   a hover, and the way the two tests above open a card. */
const rest = (spot: Element): void => {
  act(() => {
    spot.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
  })
  act(() => {
    vi.advanceTimersByTime(1000)
  })
}

const leave = (spot: Element): void => {
  act(() => {
    spot.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }))
  })
  act(() => {
    vi.advanceTimersByTime(1000)
  })
}

/** The element holding these words: what a pointer is on when it rests on them. */
const textAt = (within: Element, text: string): Element => {
  const walker = document.createTreeWalker(within, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.trim() === text && node.parentElement) return node.parentElement
  }
  throw new Error(`nothing here reads “${text}”`)
}

/**
 * The words open the card, not only the tile.
 *
 * The rail's card hung off the member's mark alone, so resting on the nickname
 * — or on the line under it, "has not used the board" — did nothing, while the
 * icon a few pixels to the left opened it. The whole row is the trigger now.
 */
it('opens a member’s card from its name and the line under it, as from its mark', async () => {
  vi.useFakeTimers()
  // Not open, so the row is certain to have a second line to rest on.
  const { store } = rig([CODEX, { ...CLAUDE, here: false }])
  await render(store)

  const opus = row('Opus')
  const subtitle = opus.querySelector('[data-slot="list-row-subtitle"]')
  const spots = [textAt(opus, 'Opus'), subtitle?.querySelector('span') ?? subtitle]
  const trigger = opus.closest('[data-slot="hover-card-trigger"]')
  for (const spot of spots) {
    expect(spot, 'a line to rest on').toBeTruthy()
    rest(spot as Element)
    expect(trigger?.getAttribute('data-state')).toBe('open')
    expect(document.querySelector('[data-slot="agent-card"]')?.textContent).toContain('Opus')
    leave(spot as Element)
    expect(trigger?.getAttribute('data-state')).toBe('closed')
  }
  vi.useRealTimers()
})

/**
 * Pressing a member opens it, and takes the card away as it does.
 *
 * Bound to the whole row, the card is open under the very pointer that presses
 * the row, so the press has to close it — or the conversation it opens arrives
 * with a card floating over it.
 */
it('pressing a member opens it and takes its card away', async () => {
  vi.useFakeTimers()
  const { store } = rig()
  await render(store)

  const name = textAt(row('Opus'), 'Opus')
  const trigger = row('Opus').closest('[data-slot="hover-card-trigger"]')
  rest(name)
  expect(trigger?.getAttribute('data-state')).toBe('open')

  act(() => {
    name.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))
    ;(name as HTMLElement).click()
  })
  await act(async () => {})
  act(() => {
    vi.advanceTimersByTime(1000)
  })

  expect(trigger?.getAttribute('data-state')).toBe('closed')
  expect(container.querySelector('[data-testid="conversation"]')?.textContent).toContain('k1')

  // And it comes back for the next rest: leaving the row ends the hold.
  leave(name)
  rest(name)
  expect(trigger?.getAttribute('data-state')).toBe('open')
  vi.useRealTimers()
})

/**
 * The + is the row's other verb, and resting on it asks about that verb.
 *
 * Its title says which column a pick will take away, and a card opened beside
 * that sentence would be saying something else. So resting on it summons no
 * card, reaching it puts an open one away — and pressing it still watches.
 */
it('the plus beside a member opens no card, puts an open one away, and still watches', async () => {
  vi.useFakeTimers()
  const { store } = rig()
  await render(store)

  const opus = row('Opus')
  const name = textAt(opus, 'Opus')
  const trigger = opus.closest('[data-slot="hover-card-trigger"]')
  const watch = opus.querySelector('button[aria-label^="Watch Opus"]')
  if (!watch) throw new Error('no watch control on the row')

  rest(name)
  expect(trigger?.getAttribute('data-state')).toBe('open')
  act(() => {
    watch.dispatchEvent(
      new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', relatedTarget: name }),
    )
  })
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  expect(trigger?.getAttribute('data-state')).toBe('closed')

  act(() => (watch as HTMLButtonElement).click())
  await act(async () => {})
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  expect(trigger?.getAttribute('data-state')).toBe('closed')
  expect(container.querySelector('[data-columns]')?.getAttribute('data-columns')).toBe('1')
  vi.useRealTimers()
})

it('opens a column’s card from the name at its head, as from its mark', async () => {
  vi.useFakeTimers()
  const { store } = rig()
  await render(store)

  act(() => row('Opus').click())
  await act(async () => {})
  const head = [...container.querySelectorAll('section header')].find((one) =>
    one.textContent?.includes('Opus'),
  )
  if (!head) throw new Error('no column head for Opus')

  rest(textAt(head, 'Opus'))
  expect(document.querySelector('[data-slot="agent-card"]')?.textContent).toContain('Opus')
  vi.useRealTimers()
})

it('a held member says so on its row, and an accepting one says nothing', async () => {
  const { store } = rig([{ ...CODEX, inbound: 'hold' }, CLAUDE])
  await render(store)

  expect(row('Codex').textContent).toContain('messages held')
  /* The control, and the reason `accept` has no words: it is the default on
     every member of every room, and a row that announced it would announce it
     forever. */
  expect(row('Opus').textContent).not.toContain('messages')
})

it('a refused member outranks what it is holding, because it explains the silence', async () => {
  /* The one second line somebody chose. A member set to refuse that is also
     on a task used to show the task and hide the reason its messages were
     going nowhere — which is the state this control exists to make visible. */
  const { store } = rig([{ ...CODEX, inbound: 'refuse' }, CLAUDE])
  await render(store)
  // Codex holds intent #1 in this fixture, so the row has two things it
  // could say and this asserts which one wins.
  expect(row('Codex').textContent).toContain('messages refused')
  expect(row('Codex').textContent).not.toContain('Migrate auth callers')
})

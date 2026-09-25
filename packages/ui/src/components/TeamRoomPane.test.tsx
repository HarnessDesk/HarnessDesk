import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  sessionId,
  sessionKey,
  type FlowExecution,
  type RuntimeInfo,
  type GoalView,
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
import styles from './TeamRoomPane.module.css'

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
  updatedAt: 1,
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
  goal: GoalView | null = null,
  /** Cached runs already in the store — a reused Goal's own id can carry more than one across its lifetime. */
  flowExecutions: ReadonlyMap<string, FlowExecution> = new Map(),
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
      goals: new Map(goal ? [[ROOM, goal]] : []),
      flowExecutions,
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
    /* A room with no flow, which is every room these tests are about. */
    loadFlowRuns: vi.fn().mockResolvedValue(undefined),
    loadBoardEvidence: vi.fn().mockResolvedValue(undefined),
    setRoomWatching: vi.fn(),
    releaseGoal: vi.fn().mockResolvedValue(undefined),
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
  /** The host pushes the room's state again, the way it does after any change. */
  const pushes = async (board: Partial<TeamState>): Promise<void> => {
    team = { ...team, ...board }
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
  return { store, leaves, says, broadcasts, signals, pushes }
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
    '[data-slot="composer-tools"] button[aria-haspopup="dialog"]',
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

/**
 * A trigger seats an agent under its own name, so an untitled conversation's
 * nickname and its title are the same word — "Triager" the agent, "Triager"
 * the conversation nobody renamed. The row used to print both: "Triager
 * Triager", the name and the role read back as if they were two facts.
 */
it('does not repeat the conversation’s title when it is the same word as the agent’s own nickname', async () => {
  const TRIAGER: TeamPeerInfo = {
    runtime: 'codex' as never,
    // Not 'c1': the rig's own live session carries that id with a title of
    // its own ('API migration'), which — since a live conversation's title
    // wins over the roster's — would mask the exact case this pins: no live
    // session yet, so the roster's own answer is all there is.
    sessionId: 't1',
    title: 'Triager',
    agent: 'Triager',
    busy: false,
    nickname: 'Triager',
    here: true,
    inbound: 'accept',
  }
  const { store } = rig([TRIAGER])
  await render(store)

  const named = row('Triager')
  expect(named.textContent?.match(/Triager/g)?.length, 'said once, not "Triager Triager"').toBe(1)
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

const GOAL: GoalView = {
  goal: { id: ROOM, root: '/repo', cwd: '/repo', sentence: 'Checkout rewrite', state: 'open', revision: 1, checkout: 'shared', dependsOn: [], origin: { kind: 'person' }, createdAt: 1, updatedAt: 1, receipt: null },
  activity: 'working', waitingOn: [], members: [], board: state, receipt: null, problem: null,
} as unknown as GoalView

const FLOW_DOCUMENT = { format: 'agents' as const, flow: { version: 2 as const, name: 'Review', inputs: [], roles: [], rules: [], seed: { role: 'reviewer', title: 'Go' }, messaging: 'board-only' as const, wait: 240 } }

/**
 * The commit a review run is pinned to, in the header's own meta line — moved
 * here from `FlowRunStatus` once #905 gave every Goal or room one header, so
 * the fact is said once rather than in two places that could disagree.
 */
it('names the pinned revision in the header’s meta, from the run’s own target', async () => {
  const execution: FlowExecution = {
    version: 2, id: 'run-1', goal: ROOM, document: FLOW_DOCUMENT, state: 'running',
    rounds: [], operations: [], legacyRun: null, reason: null,
    target: { kind: 'branch', label: 'feature', base: null, head: 'a1b2c3d4e5f6', pr: null, dirty: false },
  }
  const { store } = rig(undefined, undefined, {}, GOAL, new Map([['run-1', execution]]))
  await render(store)

  const facts = container.querySelector(`.${styles.barFacts}`)
  expect(facts?.textContent).toContain('at a1b2c3d on feature')
  // The full sha is still reachable, on hover, behind the short one shown.
  expect(facts?.querySelector('[title="a1b2c3d4e5f6"]')).not.toBeNull()
})

/** A Goal pinned directly — a front-door review with no flow driving it — names its commit the same way, without a branch to join it to. */
it('names the pinned revision from Goal.at when there is no flow run to name it', async () => {
  const PINNED_GOAL: GoalView = {
    ...GOAL,
    goal: { ...GOAL.goal, at: 'deadbeefcafe' },
  } as unknown as GoalView
  const { store } = rig(undefined, undefined, {}, PINNED_GOAL)
  await render(store)

  const facts = container.querySelector(`.${styles.barFacts}`)
  expect(facts?.textContent).toContain('at deadbee')
  expect(facts?.textContent).not.toContain('on ')
})

/** An ordinary Goal, working wherever its checkout does, has nothing to pin. */
it('names no pinned revision for a Goal with neither a flow target nor Goal.at', async () => {
  const { store } = rig(undefined, undefined, {}, GOAL)
  await render(store)

  const facts = container.querySelector(`.${styles.barFacts}`)
  expect(facts?.textContent).not.toContain(' at ')
})

it('Findings joins only a Goal’s own navigation; a loose conversation keeps none of it', async () => {
  const { store } = rig(undefined, undefined, {}, GOAL)
  const loadFindings = vi.fn().mockResolvedValue(undefined)
  Object.assign(store, { loadFindings })
  await render(store)

  act(() => row('Findings').click())
  await act(async () => {})
  expect(container.textContent).toContain('Findings')
  expect(loadFindings).toHaveBeenCalledWith(ROOM, 'all')

  // Board and Chat, the rail's other two destinations, are unaffected.
  act(() => row('Board').click())
  await act(async () => {})
  expect(container.textContent).toContain('Migrate auth callers')
})

it('a reused empty Goal reads the run its reservation names after a reload, and a plain Goal reads none', async () => {
  const reserved = { ...GOAL, reservation: { run: 'flow-reused-1' } } as GoalView
  const { store } = rig(undefined, undefined, {}, reserved)
  const readFlowExecution = vi.fn().mockResolvedValue(undefined)
  Object.assign(store, { readFlowExecution })
  await render(store)
  expect(readFlowExecution).toHaveBeenCalledWith('flow-reused-1')

  const plain = rig(undefined, undefined, {}, GOAL)
  const none = vi.fn().mockResolvedValue(undefined)
  Object.assign(plain.store, { readFlowExecution: none })
  await render(plain.store)
  expect(none).not.toHaveBeenCalled()
})

it('a reused Goal with an earlier stopped run prefers the reservation’s own run, never an older one merely sharing the Goal’s id', async () => {
  const FLOW = { version: 2 as const, name: 'Fix', inputs: [], roles: [], rules: [], seed: { role: 'fixer', title: 'Go' }, messaging: 'board-only' as const, wait: 240 }
  // The Goal's own id is reused across incarnations, so an earlier run can
  // still be cached under the same `.goal` — inserted first, so a plain
  // "find the one sharing this Goal id" reads it before the current one.
  const older: FlowExecution = {
    version: 2, id: 'flow-old-1', goal: ROOM, document: { format: 'agents', flow: FLOW },
    state: 'stopped', rounds: [], operations: [], legacyRun: null, reason: 'Stopped.',
  }
  const current: FlowExecution = { ...older, id: 'flow-reused-1', state: 'running', reason: null }
  const reserved = { ...GOAL, reservation: { run: 'flow-reused-1' } } as GoalView
  const { store } = rig(undefined, undefined, {}, reserved, new Map([[older.id, older], [current.id, current]]))

  await render(store)

  expect(container.textContent).toContain('Running')
  expect(container.textContent).not.toContain('Stopped')
})

it('while the reservation’s own run has not loaded yet, the pane asks for it rather than falling back to an older cached run sharing the Goal’s id', async () => {
  const FLOW = { version: 2 as const, name: 'Fix', inputs: [], roles: [], rules: [], seed: { role: 'fixer', title: 'Go' }, messaging: 'board-only' as const, wait: 240 }
  const older: FlowExecution = {
    version: 2, id: 'flow-old-1', goal: ROOM, document: { format: 'agents', flow: FLOW },
    state: 'stopped', rounds: [], operations: [], legacyRun: null, reason: 'Stopped.',
  }
  const reserved = { ...GOAL, reservation: { run: 'flow-reused-2' } } as GoalView
  // Only the older, unrelated run is cached — the reservation's own run
  // ("flow-reused-2") has not been read yet.
  const { store } = rig(undefined, undefined, {}, reserved, new Map([[older.id, older]]))
  const readFlowExecution = vi.fn().mockResolvedValue(undefined)
  Object.assign(store, { readFlowExecution })

  await render(store)

  // Never the older run's own words, and the reservation's run is asked for.
  expect(container.textContent).not.toContain('Stopped')
  expect(readFlowExecution).toHaveBeenCalledWith('flow-reused-2')
})

it('a plain conversation room shows no Findings row and never asks for one', async () => {
  const { store } = rig(undefined, undefined, {}, null)
  const loadFindings = vi.fn().mockResolvedValue(undefined)
  Object.assign(store, { loadFindings })
  await render(store)

  expect([...container.querySelectorAll('[data-slot="list-row"]')].some((one) => one.textContent?.includes('Findings'))).toBe(false)
  expect(loadFindings).not.toHaveBeenCalled()
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

  const toggle = container.querySelector('[aria-label="Hold messages at the board"]') as HTMLButtonElement | null
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

it('matches sessions running in the project using Windows-style paths (#664)', async () => {
  const winRoot = 'C:\\repo\\project'
  const winCwd = 'c:\\Repo\\Project\\sub'
  const session = {
    id: 'c1',
    runtime: 'codex',
    title: 'API migration',
    cwd: winCwd,
    status: { type: 'idle' },
    turns: [],
  } as unknown as Session
  const { store } = rig([CODEX], undefined, { root: winRoot })
  const snapshot = {
    ...store.getSnapshot(),
    sessions: new Map([[sessionKey('codex', 'c1'), session]]),
  }
  const customStore = { ...store, getSnapshot: () => snapshot } as unknown as AppStore
  await render(customStore)

  const text = container.textContent ?? ''
  expect(text).toContain('1 here')
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
 * happened to be the shortest of the three. It is a light now. The head used
 * to count the same fact beside two others ("1 working · 2 here · 1
 * claimed"); it keeps one — who is here — since who is working is the
 * thread's own live line and what is claimed is the board's.
 */
it('says which members are working on their rows, and keeps one presence fact in the head', async () => {
  const { store } = rig()
  await render(store)

  const bar = container.querySelector('header')!
  expect(bar.textContent).toContain('2 here')
  expect(bar.textContent).not.toContain('working')
  expect(bar.textContent).not.toContain('claimed')
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

it('shows the claimed task rather than “has not used the board” when a member holds a claim (#375)', async () => {
  // A member that has not used the board this run (e.g. after restart), but holds a claimed intent on the board
  const onClaim: TeamPeerInfo = { ...CODEX, usedBoard: false }
  const { store } = rig([onClaim, CLAUDE])
  await render(store)

  expect(row('Codex').textContent).toContain('#1')
  expect(row('Codex').textContent).toContain('Migrate auth callers')
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
  expect(bar.textContent).toContain('2 here')
  const toggle = bar.querySelector('[aria-label="Hold messages at the board"]')
  expect(toggle, 'the messaging toggle is on this row').not.toBeNull()
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
  expect(toggle?.closest('.hd-no-drag'), 'the switch is out of the drag region').not.toBeNull()
})

/**
 * A Goal or room page used to stack two headers: a `DetailHead` naming the
 * Goal, its state and its full folder — the folder run across two visible
 * lines — directly over this row naming the room again with its own facts.
 * Redesigned into the one row above: this pins that the page now renders
 * exactly one `<header>`, that it names the Goal once, and that no absolute
 * folder path ever appears as visible text — the project's own short name is
 * what shows, and its home-shortened path is one hover away.
 */
it('renders exactly one header, naming the Goal once, with the project’s short name and no absolute path as visible text', async () => {
  const { store } = rig(undefined, undefined, { root: '/Users/dev/work/widgets' }, GOAL)
  // `useSyncExternalStore` needs a stable reference back for an unchanged
  // snapshot, so this is computed once rather than on every read.
  const withHome = { ...store.getSnapshot(), home: '/Users/dev' }
  Object.assign(store, { getSnapshot: () => withHome })
  await render(store)

  const headers = container.querySelectorAll('header')
  expect(headers.length, 'exactly one header').toBe(1)
  const bar = headers[0]!
  expect(container.textContent?.split('Checkout rewrite').length ?? 1, 'named once').toBe(2)
  // The state, on the header's own line, as a chip.
  expect(bar.textContent).toContain('Running')
  // The project's short name is visible; its absolute path is not, anywhere.
  expect(bar.textContent).toContain('widgets')
  expect(container.textContent).not.toContain('/Users/dev/work/widgets')
  const projectMark = [...bar.querySelectorAll('[title]')].find((one) => one.textContent === 'widgets')
  expect(projectMark?.getAttribute('title'), 'the full path is one hover away').toBe('/Users/dev/work/widgets')
})

it('a trigger Goal’s header is named by its subject and carries its origin as a chip, its hover card naming the source in full', async () => {
  const TRIGGER_GOAL: GoalView = {
    ...GOAL,
    goal: { ...GOAL.goal, sentence: 'Issue #43, from trigger triage-issue', origin: { kind: 'trigger', trigger: 'triage-issue', event: 'e1' } },
  }
  const { store } = rig(undefined, undefined, {}, TRIGGER_GOAL)
  const triggerGoal = vi.fn(async () => ({
    goal: ROOM, trigger: 'triage-issue', source: 'issue' as const, label: 'from issue #43',
    url: 'https://github.com/acme/widgets/issues/43', budget: null, waits: [],
  }))
  Object.assign(store, { triggerGoal })
  await render(store)
  await act(async () => {})

  const bar = container.querySelector('header')!
  // The title is the Goal's subject — never the trigger's own id, which is
  // the desk's bookkeeping, and the origin is the chip's to say, not the
  // title's to repeat.
  const name = bar.querySelector('[title="Issue #43"]')
  expect(name?.textContent).toBe('Issue #43')
  expect(bar.textContent).not.toContain('triage-issue')
  expect(bar.textContent).not.toContain('from trigger')
  // The bare number, on the chip itself — the full sentence is one hover away.
  expect(bar.textContent).toContain('#43')
  expect(bar.textContent).not.toContain('Opened from issue #43')
  expect(triggerGoal).toHaveBeenCalledWith(ROOM)

  // Hovering the chip opens the full sentence and an Open link.
  const trigger = bar.querySelector('[data-slot="hover-card-trigger"]') as HTMLElement
  expect(trigger).toBeTruthy()
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse' }))
    trigger.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)) })
  const card = document.body.querySelector('[data-slot="hover-card-content"]')!
  expect(card.textContent).toContain('Started this Goal')
  // The heading names the source; the line under it does not say it again.
  expect(card.textContent?.split('Issue #43').length).toBe(2)
  const open = [...document.body.querySelectorAll('button')].find((one) => one.textContent === 'Open')!
  expect(open).toBeTruthy()
})

/**
 * One chip, one vocabulary: `FlowRunStatus` used to draw a second chip in
 * the body, in different words, that never actually disagreed with this
 * one. A pending approval for any member of the room pulses it — the same
 * fact the composer's own approval card and the room's live line both read.
 */
it('the header\'s one state chip reads "Needs you" and pulses while a member\'s approval is pending', async () => {
  const { store } = rig(undefined, undefined, {}, GOAL)
  const withApproval = {
    ...store.getSnapshot(),
    approvals: [{ key: sessionKey('codex', 'c1'), approval: { id: 'a1', type: 'command', kind: 'shell', command: 'ls -la', cwd: '/repo' } }] as never,
  }
  Object.assign(store, { getSnapshot: () => withApproval })
  await render(store)

  const bar = container.querySelector('header')!
  const chip = [...bar.querySelectorAll('[data-slot="chip"]')].find((one) => one.textContent?.includes('Needs you'))
  expect(chip, 'the one state chip reads Needs you').toBeTruthy()
  expect(chip?.querySelector('[data-pulse]'), 'and it pulses').toBeTruthy()
})

/**
 * The thread's own tail, at the room's default (plain-chat) view: one live
 * line, naming whoever is on it and for how long — or what it is waiting on
 * a person for, which outranks merely working (the header's own rule,
 * repeated here for the one line under the chat that reads the same fact).
 */
it("the room's own live line names who is working, with the elapsed time once there is a turn to read it from", async () => {
  // The default rig's Codex session is already `status: 'active'`, so the
  // roster already reads it as busy; a turn is what the elapsed reading
  // needs, and this session starts with none.
  const { store } = rig()
  const base = store.getSnapshot()
  const withTurn = {
    ...base,
    sessions: new Map(base.sessions).set(sessionKey('codex', 'c1'), {
      ...base.sessions.get(sessionKey('codex', 'c1')),
      turns: [{ id: 't1', status: 'inProgress', startedAt: Date.now() - 42_000, items: [] }],
    } as never),
  }
  Object.assign(store, { getSnapshot: () => withTurn })
  await render(store)

  expect(container.textContent).toContain('Codex is working')
  expect(container.textContent).toMatch(/Codex is working · \d+(\.\d+)?s/)
})

it("the room's own live line names who is waiting for your approval, ahead of anyone merely working", async () => {
  const { store } = rig()
  const withApproval = {
    ...store.getSnapshot(),
    approvals: [{ key: sessionKey('codex', 'c1'), approval: { id: 'a1', type: 'command', kind: 'shell', command: 'ls -la', cwd: '/repo' } }] as never,
  }
  Object.assign(store, { getSnapshot: () => withApproval })
  await render(store)

  const line = container.querySelector('[data-slot="room-live-line"]')!
  expect(line.textContent).toBe('Codex is waiting for your approval')
})

/**
 * The owner's own design for #905's four body elements: nothing sits between
 * the one-row header and the conversation — the origin line, the budget
 * sentence and the "Needs you" card are gone from the page body outright.
 */
it('has no body elements between the header and the conversation — the origin, budget and Needs-you card are gone', async () => {
  const TRIGGER_GOAL: GoalView = {
    ...GOAL,
    goal: { ...GOAL.goal, origin: { kind: 'trigger', trigger: 'triage-issue', event: 'e1' } },
  }
  const { store } = rig(undefined, undefined, {}, TRIGGER_GOAL)
  const triggerGoal = vi.fn(async () => ({
    goal: ROOM, trigger: 'triage-issue', source: 'issue' as const, label: 'from issue #42',
    url: 'https://github.com/acme/widgets/issues/42',
    budget: {
      goal: ROOM, startedAt: Date.now() - 12 * 60_000, deadline: Date.now() + 48 * 60_000,
      budget: { usd: 5, rounds: 1, hours: 1, withoutProgress: 1 },
      spentMicros: 1_200_000, reservedMicros: 0, provenance: 'vendorMetered' as const,
      closedRounds: [], idleRounds: 0, stop: null,
    },
    waits: [{
      id: 'wait-1', goal: ROOM, trigger: 'triage-issue', kind: 'approval' as const,
      waitingOn: { kind: 'person' as const, label: 'you' }, sentence: 'Codex is waiting for your approval: run ls -la',
      action: 'open-goal' as const, createdAt: 1, resolvedAt: null, notification: 'delivered' as const,
    }],
  }))
  Object.assign(store, { triggerGoal })
  await render(store)
  await act(async () => {})

  const header = container.querySelector('header')!
  const afterHeader = header.nextElementSibling
  expect(afterHeader, 'nothing between the header and the split view').toBe(container.querySelector(`.${styles.split}`))
  expect(container.textContent).not.toContain('Opened from issue #42')
  expect(container.textContent).not.toContain('Up to $5')
  // The wait is named once, at the thread's tail — its live line — not in a
  // card between the header and the conversation.
  expect(container.querySelector('[data-slot="room-live-line"]')?.textContent).toBe('Codex is waiting for your approval: run ls -la')
  expect(container.textContent?.split('is waiting for your approval: run ls -la').length).toBe(2)
})

/**
 * The composer's own footer meter: filled with what is left, and its hover
 * card carries the exact numbers the ring itself rounds away — spend,
 * rounds and time, each read as used of its own total.
 */
it("the composer's own budget meter reads what is left, and its hover card has the exact rows", async () => {
  const TRIGGER_GOAL: GoalView = {
    ...GOAL,
    goal: { ...GOAL.goal, origin: { kind: 'trigger', trigger: 'triage-issue', event: 'e1' } },
  }
  const { store } = rig(undefined, undefined, {}, TRIGGER_GOAL)
  const triggerGoal = vi.fn(async () => ({
    goal: ROOM, trigger: 'triage-issue', source: 'issue' as const, label: 'from issue #42',
    url: 'https://github.com/acme/widgets/issues/42',
    budget: {
      goal: ROOM, startedAt: Date.now() - 12 * 60_000, deadline: Date.now() + 48 * 60_000,
      budget: { usd: 5, rounds: 1, hours: 1, withoutProgress: 1 },
      spentMicros: 1_200_000, reservedMicros: 0, provenance: 'vendorMetered' as const,
      closedRounds: [], idleRounds: 0, stop: null,
    },
    waits: [],
  }))
  Object.assign(store, { triggerGoal })
  await render(store)
  await act(async () => {})

  expect(container.textContent).toContain('$3.80 left')

  const trigger = [...container.querySelectorAll('[data-slot="hover-card-trigger"]')].find((one) => one.textContent?.includes('$3.80 left'))!
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse' }))
    trigger.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)) })

  expect(document.body.textContent).toContain('$1.20 of $5')
  // The same meaning as the footer's own "Round 1 of 1": the round being
  // worked, never a count of rounds used beside it.
  const rows = [...document.body.querySelectorAll('[data-slot="key-value-row"]')].map((one) => one.textContent)
  expect(rows).toContain('Round1 of 1')
  expect(rows.some((one) => one?.startsWith('Rounds'))).toBe(false)
  expect(document.body.textContent).toContain('12 of 60 min')
  expect(document.body.textContent).toContain('Stops after a round with no progress.')
})

/**
 * The composer's own slot: a pending approval takes it, the same live
 * `Approvals` surface a conversation's own pane draws — numbered choices
 * answer to keys 1, 2 and 3 pressed in the card, and answering any of them
 * clears the approval and brings the composer back. Focus is not handed to
 * it: nobody was in it when the card arrived (see the mid-sentence test).
 */
it("the composer's own slot is a pending approval; a numbered choice answers it, and the composer comes back", async () => {
  const { store } = rig()
  const base = store.getSnapshot()
  const pendingApprovals = [{
    key: sessionKey('codex', 'c1'),
    approval: {
      id: 'a1', type: 'command', kind: 'shell', command: 'ls -la', cwd: '/repo',
      options: [
        { id: 'yes', label: 'Yes', intent: 'approve' },
        { id: 'always', label: 'Yes, always', intent: 'approveAlways' },
        { id: 'no', label: 'No, tell it instead', intent: 'deny' },
      ],
    },
  }]
  // `useSyncExternalStore` needs a stable reference back for an unchanged
  // snapshot, so the object is cached and only replaced when `approvals`
  // itself changes — a fresh literal on every read is an infinite loop.
  let snapshot: typeof base = { ...base, approvals: pendingApprovals as never }
  // Every component that calls `useSnapshot()` subscribes independently —
  // `TeamRoomPane`, `Room` and `Approvals` all have their own listener. A
  // mock that only remembers the *last* one silently drops the others, so
  // only the deepest subscriber ever re-renders and its ancestors' own
  // props (`pendingApproval`) go stale — exactly the bug this test exists
  // to catch, so the mock itself must not reproduce a smaller version of it.
  const listeners = new Set<() => void>()
  const respondToApproval = vi.fn(() => {
    snapshot = { ...snapshot, approvals: [] as never }
    for (const listener of listeners) listener()
  })
  Object.assign(store, {
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    getSnapshot: () => snapshot,
    respondToApproval,
  })
  await render(store)

  expect(container.textContent).toContain('Run this command?')
  expect(container.querySelector('textarea')!.closest('[hidden]')).not.toBeNull()

  const three = [...document.body.querySelectorAll('button')].find((one) => one.textContent?.includes('No, tell it instead'))!
  expect(three.textContent).toContain('3')
  act(() => three.click())
  expect(respondToApproval).toHaveBeenCalledWith(sessionKey('codex', 'c1'), 'a1', { type: 'option', optionId: 'no' })

  // Answered — the approval clears, and the composer is back.
  await act(async () => {})
  expect(container.textContent).not.toContain('Run this command?')
  const textarea = container.querySelector('textarea')
  expect(textarea).not.toBeNull()
  expect(textarea!.closest('[hidden]')).toBeNull()
})

/** A pending command approval for Codex's member, with three numbered answers. */
const PENDING = [{
  key: sessionKey('codex', 'c1'),
  approval: {
    id: 'a1', type: 'command', kind: 'shell', command: 'ls -la', cwd: '/repo',
    options: [
      { id: 'yes', label: 'Yes', intent: 'approve' },
      { id: 'always', label: 'Yes, always', intent: 'approveAlways' },
      { id: 'no', label: 'No, tell it instead', intent: 'deny' },
    ],
  },
}]

/** A trigger's Goal with a live budget, and a store whose approvals can be answered. */
const triggerRig = (approvals: readonly unknown[], budget: Record<string, unknown> = {}, waits: readonly unknown[] = []) => {
  const TRIGGER_GOAL: GoalView = {
    ...GOAL,
    goal: { ...GOAL.goal, origin: { kind: 'trigger', trigger: 'triage-issue', event: 'e1' } },
  }
  const { store } = rig(undefined, undefined, {}, TRIGGER_GOAL)
  const base = store.getSnapshot()
  let snapshot: typeof base = { ...base, approvals: approvals as never }
  const listeners = new Set<() => void>()
  const respondToApproval = vi.fn(() => {
    snapshot = { ...snapshot, approvals: [] as never }
    for (const listener of listeners) listener()
  })
  const triggerGoal = vi.fn(async () => ({
    goal: ROOM, trigger: 'triage-issue', source: 'issue' as const, label: 'from issue #42',
    url: 'https://github.com/acme/widgets/issues/42',
    budget: {
      goal: ROOM, startedAt: Date.now() - 12 * 60_000, deadline: Date.now() + 48 * 60_000,
      budget: { usd: 5, rounds: 1, hours: 1, withoutProgress: 1 },
      spentMicros: 1_200_000, reservedMicros: 0, provenance: 'vendorMetered' as const,
      closedRounds: [], idleRounds: 0, stop: null,
      ...budget,
    },
    waits: waits as never,
  }))
  Object.assign(store, {
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    getSnapshot: () => snapshot,
    respondToApproval,
    triggerGoal,
  })
  /** A member's approval arriving while the room is already open. */
  const raise = (next: readonly unknown[]): void => {
    snapshot = { ...snapshot, approvals: next as never }
    for (const listener of listeners) listener()
  }
  return { store, respondToApproval, raise }
}

/** A key pressed where focus actually is — the event starts at that element and bubbles, as a real keystroke does. */
const press = (at: Element, key: string): void => {
  act(() => { at.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
}

/** An editable field somewhere else in the window — another pane's box, the sidebar's search. */
const elsewhere = (): HTMLInputElement => {
  const input = document.createElement('input')
  document.body.append(input)
  input.focus()
  return input
}

/**
 * The approval takes the composer's slot, not the pane: a card in normal
 * flow where the composer stood, with the thread above it whole — no scrim,
 * no dialog, nothing inert or hidden from a screen reader. A room is
 * everyone's conversation; one member's question does not cover it.
 */
it('draws a pending approval in flow, in the composer’s slot — not a dialog, no scrim, the thread still readable', async () => {
  const { store } = triggerRig(PENDING)
  await render(store)
  await act(async () => {})

  const card = container.querySelector<HTMLElement>('[data-slot="approval-card"]')
  expect(card, 'the approval is drawn as a docked card').not.toBeNull()
  expect(card?.getAttribute('role')).not.toBe('dialog')
  expect(card?.getAttribute('aria-modal')).toBeNull()
  // In the room's own tree, where the composer stood — never portalled.
  expect(container.contains(card)).toBe(true)
  // The composer gives up its slot, but stays mounted — hidden, so what was
  // being written survives the approval.
  const box = container.querySelector('textarea')
  expect(box, 'the composer stays mounted').not.toBeNull()
  expect(box!.closest('[hidden]'), 'and is hidden while the card holds the slot').not.toBeNull()
  expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull()
  expect(document.querySelector('[data-slot="dialog-overlay"], [data-slot="approval-dialog-scope"]')).toBeNull()
  // The thread above it stays in the accessibility tree, and interactive.
  const stream = container.querySelector<HTMLElement>('[data-slot="room-stream"]')!
  expect(stream.closest('[inert]')).toBeNull()
  expect(stream.closest('[aria-hidden="true"]')).toBeNull()
  // Its choices are numbered, and exactly one is the filled act.
  const choices = [...card!.querySelectorAll<HTMLElement>('[data-slot="approval-choices"] button')]
  expect(choices.map((one) => one.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['No, tell it instead3', 'Yes, always2', 'Yes1'])
  expect(choices.filter((one) => one.hasAttribute('data-filled'))).toHaveLength(1)
  // The folder is named like any other folder: the project's short name,
  // the full path on hover.
  const folder = card!.querySelector('[data-slot="approval-meta"][data-kind="folder"]')
  expect(folder?.textContent).toBe('inrepo')
  expect(folder?.getAttribute('title')).toBe('/repo')
})

it.each([
  ['1', 'yes'],
  ['2', 'always'],
  ['3', 'no'],
])('key %s pressed in the docked card answers it with its numbered choice', async (key, optionId) => {
  const { store, respondToApproval } = triggerRig(PENDING)
  await render(store)
  await act(async () => {})

  const card = container.querySelector<HTMLElement>('[data-slot="approval-card"]')!
  act(() => card.focus())
  press(card, key)
  expect(respondToApproval).toHaveBeenCalledWith(sessionKey('codex', 'c1'), 'a1', { type: 'option', optionId })
  await act(async () => {})
  expect(container.querySelector('[data-slot="approval-card"]')).toBeNull()
})

/**
 * The docked card is not a dialog and traps nothing, so its keys are its own:
 * a digit or an Escape typed in any other field in the window — the rail's
 * filter, the sidebar's search, another pane's composer — is that field's.
 * A denial cannot be taken back.
 */
it.each(['1', '2', '3', 'Escape'])('key %s typed in a field outside the docked card never answers it', async (key) => {
  const { store, respondToApproval } = triggerRig(PENDING)
  await render(store)
  await act(async () => {})

  const input = elsewhere()
  press(input, key)
  expect(respondToApproval).not.toHaveBeenCalled()
  expect(container.querySelector('[data-slot="approval-card"]')).not.toBeNull()
  input.remove()
})

it('a key on the room’s own thread, outside the card, does not answer it either', async () => {
  const { store, respondToApproval } = triggerRig(PENDING)
  await render(store)
  await act(async () => {})
  press(container.querySelector('[data-slot="room-stream"]')!, '1')
  press(document.body, '1')
  expect(respondToApproval).not.toHaveBeenCalled()
})

/**
 * An approval arriving mid-sentence neither throws the sentence away nor
 * lets the next keystroke of it answer a command nobody has read. Focus moves
 * to the card only because it was in the composer the card replaced, a digit
 * typed straight after is still the sentence's, and answering puts the
 * person back in the composer with every word where it was.
 */
it('an approval arriving mid-sentence keeps the draft, swallows the keystroke in flight, and returns to the composer', async () => {
  const { store, respondToApproval, raise } = triggerRig([])
  await render(store)
  await act(async () => {})

  const box = container.querySelector<HTMLTextAreaElement>('textarea')!
  act(() => box.focus())
  act(() => type(box, 'half a thought about step 3'))
  raise(PENDING)
  await act(async () => {})

  const card = container.querySelector<HTMLElement>('[data-slot="approval-card"]')!
  expect(document.activeElement, 'focus was in the composer, so it follows the slot').toBe(card)
  press(card, '3')
  expect(respondToApproval, 'a digit already on its way is not an answer').not.toHaveBeenCalled()

  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 650)) })
  press(card, '1')
  expect(respondToApproval).toHaveBeenCalledWith(sessionKey('codex', 'c1'), 'a1', { type: 'option', optionId: 'yes' })
  await act(async () => {})

  const back = container.querySelector<HTMLTextAreaElement>('textarea')!
  expect(back).toBe(box)
  expect(back.value).toBe('half a thought about step 3')
  expect(back.closest('[hidden]')).toBeNull()
  expect(document.activeElement).toBe(back)
})

it('an approval arriving while the person works elsewhere takes no focus, and gives none back to the composer', async () => {
  const { store, raise } = triggerRig([])
  await render(store)
  await act(async () => {})

  const input = elsewhere()
  raise(PENDING)
  await act(async () => {})
  expect(document.activeElement, 'the card does not steal focus').toBe(input)

  const allow = [...container.querySelectorAll<HTMLButtonElement>('[data-slot="approval-choices"] button')].find((one) => one.textContent?.startsWith('Yes1'))!
  act(() => allow.click())
  await act(async () => {})
  expect(document.activeElement, 'nor hand it to the composer on the way out').toBe(input)
  input.remove()
})

/**
 * The composer's footer strip carries the budget, and stays put under
 * whichever of the two holds the slot: what a run has left is as true while
 * it waits on a person as while it works.
 */
it('keeps the budget in the footer strip with and without a pending approval', async () => {
  const { store } = triggerRig(PENDING)
  await render(store)
  await act(async () => {})

  const waiting = container.querySelector<HTMLElement>('[data-slot="room-budget"]')
  expect(waiting?.textContent).toBe('$3.80 left · Round 1 of 1')
  // The ring fills with what is left — $3.80 of $5 is 76% — in the ink a
  // meter with plenty left wears, so a full ring never reads as an empty one.
  const ring = waiting!.querySelector<HTMLElement>('[data-slot="progress-ring"]')!
  expect(ring.getAttribute('aria-valuenow')).toBe('76')
  expect(ring.style.getPropertyValue('--progress-ring-fill')).toBe('76%')
  expect(ring.getAttribute('data-tone')).toBe('brand')
  // Under the card, not above it.
  const card = container.querySelector('[data-slot="approval-card"]')!
  expect(card.compareDocumentPosition(waiting!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

  const card2 = container.querySelector<HTMLElement>('[data-slot="approval-card"]')!
  act(() => card2.focus())
  press(card2, '1')
  await act(async () => {})
  const working = container.querySelector<HTMLElement>('[data-slot="room-budget"]')
  expect(working?.textContent).toBe('$3.80 left · Round 1 of 1')
  expect(container.querySelector('textarea')!.compareDocumentPosition(working!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

const wait = (over: Record<string, unknown>) => ({
  id: 'w1', goal: ROOM, trigger: 'triage-issue', kind: 'message', waitingOn: { kind: 'person', label: 'you' },
  sentence: 'A message is held for your review before it sends.', action: 'open-goal',
  createdAt: 1, resolvedAt: null, notification: 'delivered', ...over,
})

/**
 * A trigger's own named waits — a held message, a held action, a question
 * nobody answered — have one home in the new design: the thread's live line
 * says which, and the header's one chip reads Needs you for it. A wait
 * already resolved is history and says nothing.
 */
it.each([
  ['a held message', wait({}), 'A message is held for your review before it sends.'],
  ['a held action', wait({ id: 'w2', kind: 'approval', sentence: 'An action is held for your approval.' }), 'An action is held for your approval.'],
  ['a question nobody answered', wait({ id: 'w3', kind: 'question', sentence: 'A Seat asked a question and nobody answered in time.' }), 'A Seat asked a question and nobody answered in time.'],
])('%s reads Needs you in the header and names itself on the live line', async (_name, one, sentence) => {
  const { store } = triggerRig([], {}, [one, wait({ id: 'old', sentence: 'Answered long ago.', resolvedAt: 5 })])
  await render(store)
  await act(async () => {})

  const chip = [...container.querySelector('header')!.querySelectorAll('[data-slot="chip"]')].find((c) => c.textContent?.includes('Needs you'))
  expect(chip).toBeTruthy()
  const line = container.querySelector('[data-slot="room-live-line"]')!
  expect(line.textContent).toBe(sentence)
  expect(container.textContent).not.toContain('Answered long ago.')
})

/**
 * A budget stop names its exact reason where the run's state is read — the
 * live line, and "Stopped" in the header — and the footer keeps what was
 * spent: the partial work stands, the meter says what it cost.
 */
it('a budget stop names its exact reason on the live line, reads Stopped, and keeps the meter', async () => {
  const { store } = triggerRig([], { stop: { reason: 'out of budget', detail: 'The daily cap was reached before this round closed.', at: Date.now() } }, [
    wait({ id: 'wb', kind: 'budget', waitingOn: { kind: 'service', label: 'the daily cap' }, sentence: 'This Goal stopped: out of budget.', action: 'open-usage' }),
  ])
  await render(store)
  await act(async () => {})

  expect(container.querySelector('header')!.textContent).toContain('Stopped')
  expect(container.querySelector('[data-slot="room-live-line"]')!.textContent).toBe('Out of budget. The daily cap was reached before this round closed.')
  expect(container.querySelector('[data-slot="room-budget"]')!.textContent).toContain('$3.80 left')
})

/**
 * The host stops a run whose spend it cannot read (`budgetRefusal`: "Spend is
 * unknown"), so a meter that read an unknown spend as nothing spent — a full
 * ring and "$5.00 left" — said the opposite of what the run was about to do.
 */
it('says spend is unknown, with an unfilled ring, when the host cannot read it', async () => {
  const { store } = triggerRig([], { spentMicros: null })
  await render(store)
  await act(async () => {})

  const footer = container.querySelector<HTMLElement>('[data-slot="room-budget"]')!
  expect(footer.textContent).toBe('Spend unknown · Round 1 of 1')
  expect(footer.textContent).not.toContain('left')
  const ring = footer.querySelector<HTMLElement>('[data-slot="progress-ring"]')!
  expect(ring.hasAttribute('data-unknown')).toBe(true)
  expect(ring.getAttribute('aria-valuenow')).toBeNull()

  const trigger = footer.querySelector('[data-slot="hover-card-trigger"]')!
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse' }))
    trigger.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)) })
  const card = document.body.querySelector('[data-slot="hover-card-content"]')!
  expect(card.textContent).toContain('Unknown of $5.00')
  expect(card.textContent).toContain('The run stops while its spend cannot be read.')
})

/**
 * The removed `DetailHead` used to show `goal.cwd` directly; folded into one
 * header row, that fact had nowhere left until a review of #905 asked for it
 * back — an own checkout or a subfolder is a different folder than the
 * project's own root, and a person working in one needs to be able to tell.
 */
it('names the Goal\'s own working folder on the project fact\'s hover, when it differs from the Goal\'s root', async () => {
  const OWN_CHECKOUT: GoalView = {
    ...GOAL,
    goal: { ...GOAL.goal, root: '/repo', cwd: '/repo/.harnessdesk/agents/reviewer/checkout' },
  }
  const { store } = rig(undefined, undefined, { root: '/repo' }, OWN_CHECKOUT)
  await render(store)

  const bar = container.querySelector('header')!
  const projectMark = [...bar.querySelectorAll('[title]')].find((one) => one.textContent === 'repo')
  expect(projectMark?.getAttribute('title')).toBe('/repo — working in /repo/.harnessdesk/agents/reviewer/checkout')
})

it('says nothing extra on the hover when the Goal works at its own root, unchanged from before', async () => {
  const { store } = rig(undefined, undefined, { root: '/repo' }, GOAL)
  await render(store)

  const bar = container.querySelector('header')!
  const projectMark = [...bar.querySelectorAll('[title]')].find((one) => one.textContent === 'repo')
  expect(projectMark?.getAttribute('title')).toBe('/repo')
})

/**
 * The bar's own Wrap button used to be tested only for its presence; a
 * review of #905 pointed out nothing pinned when it is refused — wrapped,
 * still wrapping, or the board could not be saved (the one case
 * `goalActions` itself does not cover, read straight off `problem`).
 */
it('disables the bar\'s Wrap for a Goal that is wrapped, wrapping, or has a problem — and only then', async () => {
  const wrapButton = (): HTMLButtonElement => {
    const found = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Wrap')
    if (!found) throw new Error('no Wrap button')
    return found
  }

  const { store: open } = rig(undefined, undefined, {}, GOAL)
  await render(open)
  expect(wrapButton().disabled).toBe(false)

  const { store: wrapped } = rig(undefined, undefined, {}, { ...GOAL, goal: { ...GOAL.goal, state: 'wrapped' } })
  await render(wrapped)
  expect(wrapButton().disabled).toBe(true)

  const { store: wrapping } = rig(undefined, undefined, {}, { ...GOAL, goal: { ...GOAL.goal, state: 'wrapping' } })
  await render(wrapping)
  expect(wrapButton().disabled).toBe(true)

  const { store: problem } = rig(undefined, undefined, {}, { ...GOAL, problem: 'The board could not be saved.' })
  await render(problem)
  expect(wrapButton().disabled).toBe(true)
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

  const toggle = container.querySelector('[aria-label="Hold messages at the board"]') as HTMLButtonElement | null
  if (!toggle) throw new Error('no messaging switch')
  await act(async () => {
    toggle.click()
  })
  await act(async () => {})

  const alert = container.querySelector('[role="alert"]')
  expect(alert?.textContent).toContain('The host did not take the change')
  // And the switch still reads as it really is, rather than as it was pressed.
  expect(container.querySelector('[aria-label="Hold messages at the board"]')).not.toBeNull()
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
 * way out has to be something a person does — release the durable Goal Seat.
 * On the card with Open and
 * Watch, never on the row: a destructive verb one pixel from the thing it
 * destroys is how a roster gets emptied by accident.
 */
it('releases a Goal member from its card, and leaves the conversation alone', async () => {
  vi.useFakeTimers()
  const goal = {
    goal: { id: ROOM, root: '/repo', cwd: '/repo', sentence: 'Checkout rewrite', state: 'open', revision: 1, checkout: 'shared', dependsOn: [], origin: { kind: 'person' }, createdAt: 1, updatedAt: 1, receipt: null },
    activity: 'working', waitingOn: [],
    members: [{ id: 'seat-1', closed: null, session: { runtime: 'codex', sessionId: 'c1' } }],
    board: state, receipt: null, problem: null,
  } as unknown as GoalView
  const { store } = rig(undefined, undefined, {}, goal)
  await render(store)

  // The whole row is the trigger, so it holds the row rather than sitting in it.
  const trigger = row('Codex').closest('[data-slot="hover-card-trigger"]')
  expect(trigger).not.toBeNull()
  act(() => {
    ;(trigger as Element).dispatchEvent(
      new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }),
    )
    ;(trigger as Element).dispatchEvent(new MouseEvent('mouseenter'))
  })
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  const remove = [...document.body.querySelectorAll('button')].find(
    (one) => one.textContent?.trim() === 'Take out of the room',
  )
  expect(remove).toBeDefined()

  act(() => (remove as HTMLButtonElement).click())
  expect(store.releaseGoal).toHaveBeenCalledWith(ROOM, 'seat-1')
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
    ;(trigger as Element).dispatchEvent(new MouseEvent('mouseenter'))
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

/* A mouse entering emits both pointer compatibility and native mouse events.
   Base UI owns the latter; HarnessDesk's control exclusion owns the former. */
const rest = (spot: Element): void => {
  act(() => {
    spot.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
    spot.closest('[data-slot="hover-card-trigger"]')?.dispatchEvent(new MouseEvent('mouseenter'))
  })
  act(() => {
    vi.advanceTimersByTime(1000)
  })
}

const leave = (spot: Element): void => {
  act(() => {
    spot.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }))
    const trigger = spot.closest('[data-slot="hover-card-trigger"]') ?? spot
    trigger.dispatchEvent(
      new MouseEvent('mouseleave', { relatedTarget: document.body, clientX: -1, clientY: -1 }),
    )
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: -1, clientY: -1 }))
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
    expect(trigger?.hasAttribute('data-popup-open')).toBe(true)
    expect(document.querySelector('[data-slot="agent-card"]')?.textContent).toContain('Opus')
    leave(spot as Element)
    expect(trigger?.hasAttribute('data-popup-open') ?? false).toBe(false)
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
  expect(trigger?.hasAttribute('data-popup-open')).toBe(true)

  act(() => {
    name.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))
    ;(name as HTMLElement).click()
  })
  await act(async () => {})
  act(() => {
    vi.advanceTimersByTime(1000)
  })

  expect(trigger?.hasAttribute('data-popup-open') ?? false).toBe(false)
  expect(container.querySelector('[data-testid="conversation"]')?.textContent).toContain('k1')

  // And it comes back for the next rest: leaving the row ends the hold.
  leave(name)
  rest(name)
  expect(trigger?.hasAttribute('data-popup-open')).toBe(true)
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
  expect(trigger?.hasAttribute('data-popup-open')).toBe(true)
  act(() => {
    watch.dispatchEvent(
      new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', relatedTarget: name }),
    )
  })
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  expect(trigger?.hasAttribute('data-popup-open') ?? false).toBe(false)

  act(() => (watch as HTMLButtonElement).click())
  await act(async () => {})
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  expect(trigger?.hasAttribute('data-popup-open') ?? false).toBe(false)
  expect(container.querySelector('[data-columns]')?.getAttribute('data-columns')).toBe('1')
  vi.useRealTimers()
})

/** The pointer moving on within a row, from one part of it to another. */
const move = (from: Element, to: Element): void => {
  act(() => {
    from.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: to }))
    to.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', relatedTarget: from }))
  })
  act(() => {
    vi.advanceTimersByTime(1000)
  })
}

/**
 * The + is at the row's trailing edge, the edge a pointer coming from the chat
 * crosses first, so arriving over it is an ordinary way into a row — and the
 * card has to be there once the pointer reaches the name.
 */
it('a pointer that comes in over the plus gets the card once it reaches the name', async () => {
  vi.useFakeTimers()
  const { store } = rig()
  await render(store)

  const opus = row('Opus')
  const name = textAt(opus, 'Opus')
  const trigger = opus.closest('[data-slot="hover-card-trigger"]')
  const watch = opus.querySelector('button[aria-label^="Watch Opus"]')
  if (!watch) throw new Error('no watch control on the row')

  rest(watch)
  expect(trigger?.hasAttribute('data-popup-open') ?? false).toBe(false)
  move(watch, name)
  expect(trigger?.hasAttribute('data-popup-open')).toBe(true)
  vi.useRealTimers()
})

/**
 * A keyboard stepping down the rail lands on every row's +. The row says it
 * holds controls, so that step opens no card.
 */
it('tabbing to the plus opens no card', async () => {
  vi.useFakeTimers()
  const { store } = rig()
  await render(store)

  const opus = row('Opus')
  const trigger = opus.closest('[data-slot="hover-card-trigger"]')
  const watch = opus.querySelector<HTMLButtonElement>('button[aria-label^="Watch Opus"]')
  if (!watch) throw new Error('no watch control on the row')

  act(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' }))
  })
  act(() => watch.focus())
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  expect(document.activeElement).toBe(watch)
  expect(trigger?.hasAttribute('data-popup-open') ?? false).toBe(false)
  vi.useRealTimers()
})

/**
 * A rail row is one tab stop, and that stop is its +.
 *
 * The row refuses focus for its card (`openOnFocus={false}`), which is safe
 * only while nothing in the row but its + can be tabbed to: `ListRow` is a
 * plain `div`, and the trigger around it stays out of the tab order. The day
 * either becomes a stop, a keyboard lands on a row whose card never opens for
 * it — and this is what fails that day.
 */
it('a rail row is one tab stop, and that stop is its plus', async () => {
  const { store } = rig()
  await render(store)

  const opus = row('Opus')
  const trigger = opus.closest<HTMLElement>('[data-slot="hover-card-trigger"]')
  const watch = opus.querySelector('button[aria-label^="Watch Opus"]')
  if (!trigger || !watch) throw new Error('the row is missing its parts')
  const stops = [trigger, ...trigger.querySelectorAll<HTMLElement>('*')].filter((one) => one.tabIndex >= 0)
  expect(stops).toHaveLength(1)
  expect(stops[0]).toBe(watch)
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

it('the room’s top row carries the window’s own controls when the sidebar is not beside it', async () => {
  /* A room is the other thing the middle can show, and in a window too narrow
     for the sidebar's column this row is the only way back to the sidebar —
     without the controls a room was somewhere to arrive and not leave but by
     ⌘B, which a phone does not have. */
  const { store } = rig()
  const bar = (): Element | null => container.querySelector('header')
  const toggle = (): Element | null => bar()?.querySelector('button[aria-label="Show sidebar"]') ?? null

  await render(store)
  expect(toggle()).toBeNull()

  const snapshot = { ...store.getSnapshot(), narrowWindow: true }
  await render({ ...store, getSnapshot: () => snapshot } as unknown as AppStore)
  expect(toggle()).not.toBeNull()
})

it('a name or a mode set in another view is drawn here when the room’s state arrives', async () => {
  /* Two panes on one room, or two windows, or another client: the one that
     sets a member to hold is told by its own answer, and every other view only
     by the room's state. The roster is a pull, and before the state carried
     the mode the others kept drawing the old one. */
  const { store, pushes } = rig()
  await render(store)
  // The control: the roster as fetched, holding nothing.
  expect(row('Codex').textContent).not.toContain('messages held')

  await pushes({
    nicknames: { [sessionKey('codex', 'c1')]: 'Mender' },
    inbound: { [sessionKey('codex', 'c1')]: 'hold' },
  })
  expect(row('Mender').textContent).toContain('messages held')
  // From the push alone: the roster was not asked for again.
  expect(store.teamPeers).toHaveBeenCalledTimes(1)
})

/*
 * A wrapped Goal's receipt is where its unresolved findings are carried
 * from, and where each is opened: the carry action and the finding's own
 * history are reached from there, not from anywhere a live Goal draws.
 */
it('a wrapped Goal’s receipt offers to carry its unresolved findings and opens a finding’s history', async () => {
  const A = 'a'.repeat(40)
  const unresolved = {
    id: 'finding-open', origin: { goal: ROOM, run: 'run-1', round: 2, card: 1, seat: 'seat-1', at: A }, ownerGoal: ROOM,
    title: 'Still open', body: '', category: 'ordinary', blocking: true, related: null, anchor: null,
    lifecycle: { state: 'open', confirmed: false, repairs: [] }, sequence: 1, evidence: [], posted: [], restored: false, problem: null,
  }
  const receipt = {
    version: 1, id: 'receipt-1', goal: ROOM, sentence: 'Checkout rewrite', wrappedAt: 1, summary: 'Done.',
    cards: [], seats: [], evidence: [], answers: [], lanes: [], citations: [], gaps: [], revisions: [],
    findings: { version: 1, evidence: [], overrides: [], findings: [unresolved] },
  }
  const goal = {
    goal: { id: ROOM, root: '/repo', cwd: '/repo', sentence: 'Checkout rewrite', state: 'wrapped', revision: 5, checkout: 'shared', dependsOn: [], origin: { kind: 'person' }, createdAt: 1, updatedAt: 1, receipt: 'receipt-1' },
    activity: null, waitingOn: [], members: [], board: state, receipt, problem: null,
  } as unknown as GoalView
  const { store } = rig(undefined, undefined, {}, goal)
  Object.assign(store, { readFinding: vi.fn(async () => ({ finding: unresolved, records: [], seat: null, next: null, problem: null })) })
  await render(store)
  const carry = [...document.body.querySelectorAll('button')].find((one) => one.textContent === 'Carry unresolved findings…')
  expect(carry).toBeDefined()
  const opener = [...document.body.querySelectorAll('button')].find((one) => one.textContent?.includes('finding-open'))!
  await act(async () => { opener.click() })
  expect(store.readFinding).toHaveBeenCalledWith(ROOM, 'finding-open')
})

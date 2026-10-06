import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  runtimeId,
  sessionId,
  sessionKey,
  type FlowExecution,
  type FindingPublicationsView,
  type Intent,
  type InsightReport,
  type RuntimeInfo,
  type GoalView,
  type Session,
  type SessionKey,
  type TeamPeerInfo,
  type TeamState,
} from '@harnessdesk/protocol'

import { MountProvider, type MountScope } from '../panels/mount'
import { views } from '../panels/views'
import '../panels/builtins'
import { toStored, type SideBySideState, type StoredSideBySide } from '../lib/side-by-side'
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
    return <div data-testid="conversation">conversation for {String(pane?.sessionKey)}<div data-slot="composer" /></div>
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
  flowStopProblems: ReadonlyMap<string, { reason: string; message: string }> = new Map(),
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
  let team = { ...state, members: roster.map(one => sessionKey(one.runtime, one.sessionId)), ...board }
  let savedView: { readonly watching?: readonly SessionKey[]; readonly sideBySide?: StoredSideBySide } = {}
  const snapshotOf = (): AppSnapshot =>
    ({
      ...emptySnapshot(),
      status: 'open',
      workspace: { path: '/repo', name: 'repo', lastOpenedAt: 1 },
      runtimes: runtimes as unknown as RuntimeInfo[],
      sessions: new Map([[sessionKey('codex', 'c1'), session]]),
      teams: new Map([[ROOM, team]]),
      goals: new Map(goal ? [[ROOM, goal]] : []),
      flowExecutions: new Map(flowExecutions),
      flowStopProblems: new Map(flowStopProblems),
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
    loadTeamRuns: vi.fn().mockResolvedValue(undefined),
    continueFlowAnswer: vi.fn().mockResolvedValue(undefined),
    loadBoardEvidence: vi.fn().mockResolvedValue(undefined),
    // This navigation rig has no publication service; match the host's empty read for that desk.
    readFindingPublications: vi.fn(async (goal: string, run: string): Promise<FindingPublicationsView> => ({
      goal, run, items: [], backfill: null, backfillRefusal: 'This desk posts nothing to a pull request.',
    })),
    setRoomWatching: vi.fn((_id: string, watching: readonly SessionKey[]) => {
      savedView = { ...savedView, watching }
    }),
    setRoomSideBySide: vi.fn((_id: string, grid: SideBySideState) => {
      const sideBySide = toStored(grid)
      const { sideBySide: _old, ...rest } = savedView
      savedView = sideBySide ? { ...rest, sideBySide } : rest
    }),
    lastView: () => savedView,
    releaseGoal: vi.fn().mockResolvedValue(undefined),
    setTeamInbound: vi.fn().mockResolvedValue(undefined),
  } as unknown as AppStore & { lastView: () => { readonly watching?: readonly SessionKey[]; readonly sideBySide?: StoredSideBySide } }
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
      members: peers.map(one => sessionKey(one.runtime, one.sessionId)),
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

const clickElement = (element: Element): void => act(() => {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})

const memberList = (): HTMLElement => {
  const trigger = container.querySelector<HTMLButtonElement>('button[title="Team members"]')!
  if (trigger.getAttribute('aria-expanded') !== 'true') act(() => trigger.click())
  const found = document.querySelector<HTMLElement>('[data-slot="team-members"]')
  if (!found) throw new Error('Team members did not open')
  return found
}
const row = (text: string): HTMLElement => {
  const tab = [...container.querySelectorAll<HTMLElement>('[data-team-page]')].find(one => one.textContent?.startsWith(text))
  if (tab) return tab
  if (text === 'Side by side') return container.querySelector<HTMLElement>('button[aria-label="Side by side"]')!
  const found = [...memberList().querySelectorAll<HTMLElement>('[data-slot="list-row"]')].find(entry => entry.textContent?.includes(text))
  if (!found) throw new Error(`no row containing ${text}`)
  return found
}

it('the rail is the roster: who is here, and what each of them is holding', async () => {
  const { store } = rig()
  await render(store)

  expect(container.querySelector('[data-slot="avatar-stack"]')?.getAttribute('aria-label')).toBe('2 members')
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
 * A member's name in the rail is drawn in the navigation pair (13/400) today,
 * the same as the sidebar's rows. jsdom has no stylesheet, so this pins the
 * role the row declares; the names rule in `e2e/ui-system/rules.spec.ts`
 * measures the pair in a browser.
 */
it('draws a member’s name in the rail in the navigation role', async () => {
  const { store } = rig()
  await render(store)

  const title = row('API migration').querySelector('[data-slot="list-row-title"]')
  expect(title?.getAttribute('data-role')).toBe('navigation')
  expect(title?.className).toContain('font-normal')
  expect(title?.className).not.toContain('font-semibold')
})

it.each([
  ['task', true, true, 'accept', '#1 Migrate auth callers'],
  ['away', false, true, 'accept', 'not open — a message opens it'],
  ['unreachable tools', true, false, 'accept', 'cannot take jobs — tools not reachable'],
  ['held messages', true, true, 'hold', 'messages held'],
] as const)('keeps a long conversation title in the wrapping subtitle alongside %s', async (kind, here, pluginTools, inbound, reason) => {
  const title = 'Check retry behaviour when the checkout request fails again'
  const peer = { ...CODEX, sessionId: 'long-title', nickname: 'Assistant', title, here, inbound }
  const { store } = rig([peer], [{ id: 'codex', presentation: { name: 'Assistant' }, capabilities: { pluginTools } }], {
    intents: kind === 'task' ? [{ ...state.intents[0]!, claim: { ...state.intents[0]!.claim!, sessionId: peer.sessionId } }] : [],
  })
  await render(store)

  const member = row('Assistant')
  const name = member.querySelector('[data-slot="list-row-title"]')!
  expect(name.textContent).not.toContain(title)
  const subtitle = member.querySelector('[data-slot="list-row-subtitle"]')!
  expect(subtitle.textContent).toContain(title)
  expect(subtitle.textContent).toContain(reason)
  expect(subtitle.hasAttribute('data-wrap-subtitle')).toBe(true)
  expect(member.querySelectorAll('[data-slot="list-row-subtitle"]')).toHaveLength(1)
})

it('keeps the conversation title when a refusal replaces its matching task title', async () => {
  const peer = { ...CODEX, sessionId: 'refused-title', nickname: 'Assistant', title: state.intents[0]!.title, inbound: 'hold' as const }
  const { store } = rig([peer], undefined, {
    intents: [{ ...state.intents[0]!, claim: { ...state.intents[0]!.claim!, sessionId: peer.sessionId } }],
  })
  await render(store)
  const subtitle = row('Assistant').querySelector('[data-slot="list-row-subtitle"]')!
  expect(subtitle.textContent).toBe(`messages held · ${peer.title}`)
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

  memberList()
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

it.each(['Overview', 'Run'])('stops the %s Run with only its open Seats, from capabilities rather than the runtime’s identity', async door => {
  const members = [
    { id: 'alpha', session: { runtime: 'codex', sessionId: 'c1' }, agent: { name: 'Alpha' }, openedAt: 1, closed: null },
    { id: 'beta', session: { runtime: 'claude', sessionId: 'k1' }, agent: { name: 'Beta' }, openedAt: 1, closed: null },
    { id: 'closed', session: { runtime: 'codex', sessionId: 'old' }, agent: { name: 'Closed Seat' }, openedAt: 1, closed: { at: 2 } },
    { id: 'other-run', session: { runtime: 'codex', sessionId: 'other' }, agent: { name: 'Other Run Seat' }, openedAt: 1, closed: null },
  ] as unknown as GoalView['members']
  const execution: FlowExecution = { version: 2, id: 'stop-me', goal: ROOM, document: FLOW_DOCUMENT, state: 'running',
    reason: null, operations: [], legacyRun: null,
    rounds: [{ n: 1, role: 'reviewer', cards: [], seats: ['alpha', 'beta', 'closed'], state: 'running', cause: 'seed', evidence: [] }] }
  const runs = new Map([[execution.id, execution]])
  const { store, pushes } = rig([], [
    { id: 'codex', presentation: { name: 'Agent A' }, capabilities: { interrupt: false } },
    { id: 'claude', presentation: { name: 'Agent B' }, capabilities: { interrupt: true } },
  ], { members: [] }, { ...GOAL, members }, runs)
  const stopping = vi.fn(async (_run: string, reason: string) => {
    const stopped: FlowExecution = { ...execution, state: 'stopped', reason, end: { kind: 'stopped', by: 'person' } }
    runs.set(execution.id, stopped)
    await pushes({ updatedAt: 2 })
    return stopped
  })
  store.stopFlowExecution = stopping
  await render(store)
  if (door === 'Run') { act(() => row('Run').click()); await act(async () => {}) }
  const frame = container.querySelector(door === 'Run' ? '[data-slot="run-header"]' : '[aria-label="Run"]')!
  act(() => [...frame.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === 'Stop run…')!.click())
  const question = document.body.querySelector('[role="alertdialog"]')!
  expect([...question.querySelectorAll('[data-stop-seat]')].map(one => one.textContent)).toEqual([
    'Alphastops when its current turn ends', 'Betastops now',
  ])
  await act(async () => [...question.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === 'Stop run')!.click())
  expect(stopping).toHaveBeenCalledWith('stop-me', 'You stopped this Run. No further step starts.')
  expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
  expect(container.textContent).not.toContain('Stop run…')
  if (door === 'Run') expect(container.textContent).toContain('By you')
})

it.each(['Close', 'Escape'])('keeps cleanup retry after a stopped push, late rejection and %s dismissal, even after reopening the pane', async dismissal => {
  const execution: FlowExecution = { version: 2, id: 'stop-me', goal: ROOM, document: FLOW_DOCUMENT, state: 'running',
    reason: null, operations: [], legacyRun: null, rounds: [] }
  const runs = new Map([[execution.id, execution]])
  const problems = new Map<string, { reason: string; message: string }>()
  const { store, pushes } = rig([], [], { members: [] }, GOAL, runs, problems)
  let reject!: (error: Error) => void
  const stopped: FlowExecution = { ...execution, state: 'stopped', reason: 'The brief changed.', end: { kind: 'stopped', by: 'person' } }
  const stopping = vi.fn().mockImplementationOnce(() => new Promise<void>((_yes, no) => { reject = no })).mockImplementationOnce(async () => {
    problems.delete(execution.id)
    await pushes({ updatedAt: 4 })
    return stopped
  })
  store.stopFlowExecution = stopping
  await render(store)
  const click = (scope: Element, name: string) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === name)!.click()
  act(() => click(container, 'Stop run…'))
  let question = document.body.querySelector('[role="alertdialog"]')!
  act(() => {
    const input = question.querySelector('input')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'The brief changed.')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => click(question, 'Stop run'))
  runs.set(execution.id, stopped)
  await pushes({ updatedAt: 2 })
  expect(container.textContent).not.toContain('Stop run…')
  problems.set(execution.id, { reason: 'The brief changed.', message: 'One Seat could not be released.' })
  await pushes({ updatedAt: 3 })
  await act(async () => reject(new Error('One Seat could not be released.')))
  expect(question.textContent).toContain('One Seat could not be released.')
  await act(async () => {
    if (dismissal === 'Close') click(question, 'Close')
    else question.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
  act(() => root.render(null))
  await render(store)
  expect(container.textContent).toContain('One Seat could not be released.')
  act(() => click(container, 'Retry stop…'))
  question = document.body.querySelector('[role="alertdialog"]')!
  expect(question.querySelector('input')?.value).toBe('The brief changed.')
  expect(question.textContent).not.toContain('Keep running')
  expect(question.textContent).toContain('One Seat could not be released.')
  await act(async () => click(question, 'Retry stop'))
  expect(stopping).toHaveBeenLastCalledWith('stop-me', 'The brief changed.')
  expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
  expect(container.textContent).not.toContain('Retry stop…')
  expect(container.textContent).not.toContain('One Seat could not be released.')
})

/**
 * The commit a review run is pinned to, in the header's own meta line — moved
 * here from `FlowRunStatus` once #905 gave every Goal or room one header, so
 * the fact is said once rather than in two places that could disagree.
 */
it('names the pinned revision in the header’s meta, from the run’s own target', async () => {
  const execution: FlowExecution = {
    version: 2, id: 'run-1', goal: ROOM, document: FLOW_DOCUMENT, state: 'running',
    rounds: [], operations: [], legacyRun: null, reason: null,
    // The host's own label for a branch target, verbatim (authoring/start.ts): "branch <name>", never the bare name.
    target: { kind: 'branch', label: 'branch feature', base: null, head: 'a1b2c3d4e5f6', pr: null, dirty: false },
  }
  const { store } = rig(undefined, undefined, {}, GOAL, new Map([['run-1', execution]]))
  await render(store)

  const facts = container.querySelector(`.${styles.barFacts}`)
  expect(facts?.textContent).toContain('at a1b2c3d on branch feature')
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

it('a flow-opened Goal whose run was dropped and a new one reserved reads the reserved run, as its Findings pane does (#890)', async () => {
  const FLOW = { version: 2 as const, name: 'Fix', inputs: [], roles: [], rules: [], seed: { role: 'fixer', title: 'Go' }, messaging: 'board-only' as const, wait: 240 }
  const dropped: FlowExecution = {
    version: 2, id: 'flow-opened-1', goal: ROOM, document: { format: 'agents', flow: FLOW },
    state: 'stopped', rounds: [], operations: [], legacyRun: null, reason: 'Stopped.',
  }
  const current: FlowExecution = { ...dropped, id: 'flow-reserved-1', state: 'running', reason: null }
  const view = { ...GOAL, goal: { ...GOAL.goal, origin: { kind: 'flow', run: 'flow-opened-1' } }, reservation: { run: 'flow-reserved-1' } } as GoalView
  const { store } = rig(undefined, undefined, {}, view, new Map([[dropped.id, dropped], [current.id, current]]))

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

  expect(container.querySelector('[data-slot="avatar-stack"]')?.getAttribute('aria-label')).toBe('2 members')
  act(() => audience().click())
  act(() => menuRow('Codex').click())
  expect(audience().textContent).toContain('Codex')

  // Codex ends its session. Both places that named it must stop naming it —
  // a rail still listing an agent that has gone is a room you cannot trust,
  // and an audience holding it is a message with nowhere to land.
  leaves(CODEX)
  await render(store)

  expect(container.querySelector('[title="1 of 1 here"]')).not.toBeNull()
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
  expect(memberList().textContent).toContain('No agents in this Team yet')
  expect(container.textContent).not.toContain('takes a turn')

  // The host says somebody joined; the pane must ask again.
  ;(store.teamPeers as ReturnType<typeof vi.fn>).mockResolvedValue([CODEX])
  ;(snapshot.teams as Map<string, TeamState>).set(ROOM, {
    ...state,
    members: [sessionKey('codex', sessionId('c1'))],
  })
  await render(store)

  expect(container.textContent).not.toContain('Nobody here yet')
  expect(memberList().textContent).toContain('API migration')
})

it('the room’s channel says it is the room’s, not the project’s', async () => {
  // A project holds several Teams; the audience belongs in the Chat row's
  // hover title, where it no longer costs a permanent second line.
  const { store } = rig()
  await render(store)
  expect(container.textContent).not.toContain('Everyone on this project')
  expect(container.textContent).not.toContain('Everyone in this room')
  const title = row('Chat')
  expect(title?.getAttribute('title')).toBe('Everyone in this Team')
  expect(row('Chat').querySelector('[data-slot="list-row-subtitle"]')).toBeNull()
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
  // Drawn as the conversation draws an action that failed, and spoken.
  const alert = [...container.querySelectorAll('[role="alert"]')].find((one) => one.textContent?.includes('could not be saved'))
  expect(alert?.getAttribute('data-slot')).toBe('alert')
  expect(alert?.getAttribute('data-tone')).toBe('danger')
})

it('says a press that did not land as a spoken failure, in the danger tone', async () => {
  const { store } = rig()
  ;(store.getSnapshot().teams as Map<string, TeamState>).set(ROOM, {
    ...state,
    channel: [{
      id: 'held-1', at: Date.now(), kind: 'message', from: { kind: 'agent', runtime: 'codex', sessionId: 'c1', title: 'API migration' },
      text: 'Picking up #4.', state: 'held', reason: 'Held for you.', envelope: null,
    }],
  } as unknown as TeamState)
  Object.assign(store, { teamDeliver: vi.fn(async () => { throw new Error('The release did not reach the host.') }) })
  await render(store)
  const deliver = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Deliver now')!
  await act(async () => { deliver.click() })
  await act(async () => {})
  const alert = [...container.querySelectorAll('[role="alert"]')].find((one) => one.textContent?.includes('did not reach the host'))
  expect(alert?.getAttribute('data-slot')).toBe('alert')
  expect(alert?.getAttribute('data-tone')).toBe('danger')
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
  const text = memberList().textContent ?? ''
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
    if (this.getAttribute('data-slot') === 'side-by-side-grid') return { width: px, height: 800 } as DOMRect
    return real.call(this)
  }
}

type RoomRenderOptions = {
  readonly members?: readonly string[]
  readonly width?: number
  readonly view?: { readonly watching?: readonly SessionKey[]; readonly sideBySide?: StoredSideBySide }
}

const renderRoom = async ({ members, width = 1200, view = {} }: RoomRenderOptions = {}) => {
  const peers = members?.map((value) => {
    const [runtime = 'codex', id = value] = value.split('\u0000')
    const base = runtime === 'codex' ? CODEX : runtime === 'claude' ? CLAUDE : { ...CLAUDE, runtime: runtime as never, agent: runtime }
    return { ...base, runtime: runtime as never, sessionId: id, title: id, nickname: id }
  })
  const { store } = rig(peers)
  paneWidth(width)
  const scope: MountScope = {
    area: 'main',
    id: 'pane-1',
    view: { kind: 'room', room: ROOM, ...view },
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
  await act(async () => {})
  return { pane: container, store }
}

const clickRailWatch = async (pane: HTMLElement, nickname: string): Promise<void> => {
  const button = [...memberList().querySelectorAll<HTMLButtonElement>('button')].find((one) =>
    one.getAttribute('aria-label')?.startsWith(`Watch ${nickname} `),
  )
  if (!button) throw new Error(`no Watch control for ${nickname}`)
  await act(async () => { button.click() })
  await act(async () => {})
}

const clickRailOpen = async (pane: HTMLElement, nickname: string): Promise<void> => {
  const watch = [...memberList().querySelectorAll<HTMLButtonElement>('button[aria-label^="Watch "]')].find((one) =>
    one.getAttribute('aria-label')?.startsWith(`Watch ${nickname} `),
  )
  const target = watch?.closest<HTMLElement>('[data-slot="list-row"]')
  if (!target) throw new Error(`no room row for ${nickname}`)
  act(() => target.click())
  await act(async () => {})
}

it('Watch puts a member on a Side by side tile and opens the destination', async () => {
  const { pane, store } = await renderRoom({ members: ['codex\u0000a', 'claude\u0000b'] })
  await clickRailWatch(pane, 'a')
  await clickRailWatch(pane, 'b')
  expect(pane.querySelectorAll('[data-slot="side-by-side-tile"]')).toHaveLength(2)
  expect(store.lastView().sideBySide?.tiles).toEqual(['codex\u0000a', 'claude\u0000b'])
})

it('greys Watch, and says why, when no tile is free', async () => {
  const keys = ['codex\u0000a', 'claude\u0000b', 'cursor\u0000c', 'acp\u0000d'] as SessionKey[]
  const { pane, store } = await renderRoom({
    members: [...keys, 'codex\u0000e'],
    view: { sideBySide: { tiles: keys, pinned: keys.slice(0, 3), focused: keys[3] } },
  })
  const watch = memberList().querySelector<HTMLButtonElement>('button[aria-label="Watch e: no tile is free"]')
  expect(watch?.getAttribute('aria-disabled')).toBe('true')
  await act(async () => { watch!.click() })
  expect(pane.querySelectorAll('[data-slot="side-by-side-tile"]')).toHaveLength(4)
  expect(pane.textContent).toContain('No tile is free: the others are pinned. Unpin one to make room for e.')
  expect(store.lastView().sideBySide?.tiles ?? keys).toEqual(keys)
})

it('clears a non-empty old watching list once it has become tiles', async () => {
  const { store } = await renderRoom({
    members: ['codex\u0000a', 'claude\u0000b'],
    view: { watching: ['codex\u0000a', 'claude\u0000b'] as SessionKey[] },
  })
  expect(store.setRoomWatching).toHaveBeenCalledTimes(1)
  expect(store.lastView().watching).toEqual([])
  expect(store.lastView().sideBySide?.tiles).toEqual(['codex\u0000a', 'claude\u0000b'])
})

it('selects the row of the member opened on its own, and only that one', async () => {
  const { pane } = await renderRoom({ members: ['codex\u0000a', 'claude\u0000b'] })
  await clickRailOpen(pane, 'a')
  const current = [...memberList().querySelectorAll('[data-slot="list-row"][aria-current="true"]')].map((one) => one.textContent ?? '')
  expect(current).toHaveLength(1)
  expect(current[0]).toContain('a')
})

it('drops a tile whose member is missing from the room’s answer, with nothing left by hand', async () => {
  const { pane } = await renderRoom({
    members: ['codex\u0000a'],
    view: { sideBySide: { tiles: ['codex\u0000a', 'claude\u0000gone'] as SessionKey[] } },
  })
  expect([...pane.querySelectorAll<HTMLElement>('[data-slot="side-by-side-tile"]')].map((tile) => tile.dataset.sessionKey)).toEqual(['codex\u0000a'])
})

it('Open shows one member’s full conversation, not a tile', async () => {
  const { pane } = await renderRoom({ members: ['codex\u0000a'] })
  await clickRailOpen(pane, 'a')
  expect(pane.querySelector('[data-slot="side-by-side-tile"]')).toBeNull()
  expect(pane.querySelector('[data-slot="composer"]')).not.toBeNull()
})

it('a narrowed room keeps all four tiles in its view', async () => {
  const { pane, store } = await renderRoom({
    members: ['codex\u0000a', 'claude\u0000b', 'cursor\u0000c', 'acp\u0000d'],
    width: 500,
  })
  for (const name of ['a', 'b', 'c', 'd']) await clickRailWatch(pane, name)
  expect(store.lastView().sideBySide?.tiles).toHaveLength(4)
})

it('restores tiles from the view and migrates an old watching list', async () => {
  const { pane } = await renderRoom({
    members: ['codex\u0000a', 'claude\u0000b'],
    view: { watching: ['codex\u0000a', 'claude\u0000b'] as SessionKey[] },
  })
  expect(pane.querySelectorAll('[data-slot="side-by-side-tile"]')).toHaveLength(2)
})

it('Watch places members on Side by side tiles with their identities', async () => {
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
    [...memberList().querySelectorAll('button')]
      .map((one) => one.getAttribute('aria-label') ?? '')
      .filter((label) => label.startsWith('Watch '))
  expect(watchVerbs()).toHaveLength(2)

  // Each row can be watched directly; Open remains a separate verb.
  await clickRailWatch(container, 'Opus')

  expect(container.querySelectorAll('[data-slot="side-by-side-tile"]')).toHaveLength(1)
  await clickRailWatch(container, 'Codex')
  expect(container.querySelectorAll('[data-slot="side-by-side-tile"]')).toHaveLength(2)
  expect(memberList().textContent).toContain('API migration')
  expect(container.textContent).toContain('Opus')
})

it('a tile can be taken off the grid without closing its conversation', async () => {
  paneWidth(1400)
  const { store } = rig()
  await render(store)
  await clickRailWatch(container, 'Codex')
  const actions = container.querySelector<HTMLButtonElement>('button[aria-label="Codex actions"]')!
  clickElement(actions)
  const menu = document.body.querySelector<HTMLElement>('[role="menu"]')!
  const takeOff = [...menu.querySelectorAll<HTMLElement>('*')].find((one) => one.textContent?.trim() === 'Take off the grid')!
  clickElement(takeOff)
  expect(container.querySelector('[data-slot="side-by-side-tile"]')).toBeNull()
  const sideBySide = row('Side by side')
  expect(sideBySide.getAttribute('aria-pressed')).toBe('false')
  expect(sideBySide.querySelector('[data-slot="list-row-subtitle"]')).toBeNull()
  expect(store.getSnapshot().sessions.has(sessionKey('codex', 'c1'))).toBe(true)
})

/**
 * A narrow pane changes what is displayed, not which tiles are kept.
 */
it('keeps every watched tile in the view when the room is narrow', async () => {
  paneWidth(500)
  const { store } = rig()
  await render(store)

  const watch = (name: string) => row(name).querySelector<HTMLButtonElement>('button[aria-label^="Watch"]')!
  memberList()
  act(() => watch('API migration').click())
  memberList()
  act(() => watch('Opus').click())
  expect(container.querySelectorAll('[data-slot="side-by-side-tile"]')).toHaveLength(2)
  expect(container.querySelectorAll('[data-slot="side-by-side-tile"][data-hidden]')).toHaveLength(1)
})

/**
 * The columns are the view's, not the pane's.
 *
 * The middle is a slot: opening a conversation replaces the room and unmounts
 * it. While what-is-being-watched lived in component state, two columns
 * arranged on purpose were thrown away by the next click, and Back — which
 * exists so the slot does not lose your place — handed back an empty room.
 */
it('opens the tiles stored in the room view', async () => {
  paneWidth(1400)
  const { store } = rig()
  const scope = {
    area: 'main' as const,
    id: 'pane-1',
    view: {
      kind: 'room' as const,
      room: ROOM,
      sideBySide: { tiles: [sessionKey('codex', 'c1'), sessionKey('claude', 'k1')] },
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

  expect(container.querySelectorAll('[data-slot="side-by-side-tile"]')).toHaveLength(2)
  expect(memberList().textContent).toContain('API migration')
})

it('clears the old watching field once and writes the grid to the room view', async () => {
  const { store } = rig()
  const setRoomWatching = vi.fn()
  const setRoomSideBySide = vi.fn()
  const withWriter = { ...store, setRoomWatching, setRoomSideBySide } as unknown as AppStore
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

  const watch = row('API migration').querySelector<HTMLButtonElement>('button[aria-label^="Watch"]')!
  act(() => watch.click())
  expect(setRoomWatching).toHaveBeenCalledTimes(1)
  expect(setRoomWatching).toHaveBeenCalledWith('pane-1', [])
  expect(setRoomSideBySide).toHaveBeenLastCalledWith('pane-1', expect.objectContaining({ tiles: [sessionKey('codex', 'c1')] }))
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
  /* A runaway is thousands, not a hundred. A settled room reads the snapshot
     about 110 times (the notice hosts register, then measure, before the tree
     is still); the bound is far enough above that to be a ceiling on a loop. */
  const CEILING = 200
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
  expect(container.querySelector('[data-slot="room-stream"] [data-slot="empty-state"]')?.getAttribute('data-variant')).toBe('inline')
  expect(container.textContent).not.toContain('Signals — a claim, a completion — land here too.')
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
  act(()=>row('Board').click()); await act(async()=>{})
  expect(container.querySelector('[data-slot="board-column"]')).not.toBeNull()
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
  expect(container.querySelector('[data-slot="avatar-stack"]')?.getAttribute('aria-label')).toBe('1 member')
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

  const mount = (room: string, tiles: readonly SessionKey[]) => ({
    area: 'main' as const,
    id: 'pane-1',
    view: { kind: 'room' as const, room, sideBySide: { tiles } },
  })

  // Room A, showing one of its conversations as a tile.
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
  expect(container.querySelectorAll('[data-slot="side-by-side-tile"]')).toHaveLength(1)

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

  expect(container.querySelector('[data-slot="side-by-side-tile"]')).toBeNull()
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
  expect(container.querySelector('[data-slot="avatar-stack"]')?.getAttribute('aria-label')).toBe('2 members')
  expect(memberList().textContent).toContain('API migration')

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
  expect(bar.querySelector('[data-slot="avatar-stack"]')?.getAttribute('aria-label')).toBe('2 members')
  expect(bar.textContent).not.toContain('working')
  expect(bar.textContent).not.toContain('claimed')
  /* Read as text, and as the system's presence light — never as a class: the
     CSS module is stubbed to nothing in this environment. What is asserted
     first is the half that has to be right anyway — what the row says to a
     reader who cannot see a colour. */
  expect(row('API migration').textContent).toContain('working')
  expect(row('Opus').textContent).not.toContain('working')
  const light = (name: string): Element | null => row(name).querySelector('[data-slot="dot"][data-variant="presence"]')
  expect(light('API migration')?.getAttribute('data-state')).toBe('ready')
  expect(light('API migration')?.getAttribute('aria-hidden')).toBe('true')
  expect(light('API migration')?.hasAttribute('data-pulse'), 'working, so it pulses').toBe(true)
  expect(light('Opus')).toBeNull()
  // The room's top row is the window's bar, as a header.
  expect(bar.getAttribute('data-slot')).toBe('tool-pane-header')
})

/**
 * Watching beside is one verb, and a verb that appears and disappears is a
 * verb nobody learns.
 *
 * It used to be drawn only once a member was already up, on the theory that
 * with nothing on screen there is nothing to sit beside — which is true of the
 * second column and false of the first.
 */
it('offers Watch before anything is being watched', async () => {
  const { store } = rig()
  await render(store)

  const watch = [...memberList().querySelectorAll('button')].filter((one) =>
    one.getAttribute('aria-label')?.startsWith('Watch '),
  )
  expect(watch).toHaveLength(2)

  act(() => (watch[1] as HTMLButtonElement).click())
  await act(async () => {})
  expect(container.querySelectorAll('[data-slot="side-by-side-tile"]')).toHaveLength(1)
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

it('says the board caution once, for the group, when every agent shown would carry it', async () => {
  // One open card and nobody on it: both members are equally idle on the board.
  const open = state.intents.filter((one) => one.state === 'open')
  const { store } = rig([{ ...CODEX, usedBoard: false }, { ...CLAUDE, usedBoard: false }], undefined, { intents: open })
  await render(store)

  expect(memberList().textContent).toContain('None of these agents has used the board yet.')
  expect(row('Opus').textContent).not.toContain('has not used the board')
  expect(row('Codex').textContent).not.toContain('has not used the board')
})

it('the shared caution leaves each member\u2019s own card saying it', async () => {
  // The rail says it once; the card is read one member at a time, so it keeps it.
  const open = state.intents.filter((one) => one.state === 'open')
  const { store } = rig([{ ...CODEX, usedBoard: false }, { ...CLAUDE, usedBoard: false }], undefined, { intents: open })
  await render(store)
  expect(row('Opus').textContent).not.toContain('has not used the board')
  // The row is the card's trigger: hovering it opens the member's card.
  const target = row('Opus')
  const trigger = target.closest('[data-slot="hover-card-trigger"]') ?? target.querySelector('[data-slot="hover-card-trigger"]') ?? target
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
    trigger.dispatchEvent(new MouseEvent('mouseenter'))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1000)) })
  const card = document.body.querySelector('[data-slot="agent-card"]')
  expect(card, 'the member card opened').not.toBeNull()
  expect(card!.textContent).toContain('Reachable, but has taken nothing from the board this run.')
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
  expect(bar.querySelector('[data-slot="avatar-stack"]')?.getAttribute('aria-label')).toBe('2 members')
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
  expect(bar.getAttribute('title')).toBe('/Users/dev/work/widgets — working in /repo')
  expect(container.textContent).not.toContain('/Users/dev/work/widgets')
  const projectMark = bar
  expect(projectMark?.getAttribute('title'), 'both paths are one hover away').toBe('/Users/dev/work/widgets — working in /repo')
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

/**
 * The tail under the chat speaks in one voice: who is working and what
 * sending will do are both the transcript's live line, in its one box, size
 * and ink — not a 14px line over a 12px one.
 */
it("draws the room's tail — the live line and the composer's notice — as one line, in one box", async () => {
  const { store } = rig()
  await render(store)
  const line = container.querySelector<HTMLElement>('[data-slot="room-live-line"]')
  const notice = container.querySelector<HTMLElement>('[data-slot="room-composer-notice"]')
  const tail = container.querySelector('[data-slot="composer-tail"]')
  expect(tail?.contains(line)).toBe(true)
  expect(tail?.contains(notice)).toBe(true)
  expect(line?.textContent).toContain('is working')
  expect(notice?.textContent).toContain('is working — that copy waits')
  expect(notice?.getAttribute('role')).toBe('status')
  expect(notice?.hasAttribute('data-settled')).toBe(true)
  // A copy that waits is not a warning: it is the live line's own muted ink.
  expect(notice?.querySelector('[data-tone]')).toBeNull()
  // One part draws both, so their box is one box.
  expect(notice?.className).toBe(line?.className)
})

/**
 * The clock ticks every second and the live region must not: a screen reader
 * would read it out once a second. Only who is working is announced, when
 * that changes; the elapsed reading sits beside the region.
 */
it("the room's working line announces who is working, never the seconds ticking", async () => {
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

  const line = container.querySelector('[data-slot="room-live-line"]')!
  const live = line.querySelector('[role="status"]')!
  expect(line.getAttribute('role'), 'the line itself is not the region').toBeNull()
  expect(live.textContent).toBe('Codex is working')
  const before = line.textContent
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_100)) })
  expect(line.textContent, 'the clock did tick').not.toBe(before)
  expect(live.textContent, 'and the region did not').toBe('Codex is working')
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
  // A person is needed, so it leads with the tail's one light, pulsing.
  expect(line.querySelector('[data-slot="dot"][data-pulse]')).not.toBeNull()
})

/** More than one member holding a question is a count, not a fact the line drops (#917). */
it("the room's own live line counts every waiting member, not only the first", async () => {
  const { store } = rig()
  const withApprovals = {
    ...store.getSnapshot(),
    approvals: [
      { key: sessionKey('codex', 'c1'), approval: { id: 'a1', type: 'command', kind: 'shell', command: 'ls -la', cwd: '/repo' } },
      { key: sessionKey('claude', 'k1'), approval: { id: 'a2', type: 'command', kind: 'shell', command: 'rm -rf tmp', cwd: '/repo' } },
    ] as never,
  }
  Object.assign(store, { getSnapshot: () => withApprovals })
  await render(store)
  act(() => row('Chat').click())
  await act(async () => {})

  const line = container.querySelector('[data-slot="room-live-line"]')!
  expect(line.textContent).toBe('Codex is waiting for your approval · 1 more')
  expect(line.getAttribute('title')).toBe('Codex\nOpus')
})

it('keeps a running idle Run’s waiting reason in the production Overview', async () => {
  const reason = 'waiting for recorded evidence for round 2'
  const execution: FlowExecution = {
    version: 2, id: 'run-1', goal: ROOM, document: FLOW_DOCUMENT, state: 'running',
    rounds: [], operations: [], legacyRun: null, reason,
  }
  const { store } = rig([CLAUDE], undefined, { intents: [] }, GOAL, new Map([[execution.id, execution]]))
  await render(store)
  const run = container.querySelector('[data-slot="team-overview"] [aria-label="Run"]')!
  expect(run.textContent).toContain('Waiting for recorded evidence for round 2')
  expect(run.textContent?.split('Waiting for recorded evidence for round 2')).toHaveLength(2)
})

it('keeps an unrouted settled Run’s reason in the production Overview', async () => {
  const reason = 'Review the change (#2) answered revise; no rule continues from reviewer, so this waits for you'
  const execution: FlowExecution = {
    version: 2, id: 'run-1', goal: ROOM, document: FLOW_DOCUMENT, state: 'settled',
    rounds: [], operations: [], legacyRun: null, reason,
    end: { kind: 'unrouted', card: 2, outcome: 'revise' },
  }
  const { store } = rig([CLAUDE], undefined, { intents: [] }, GOAL, new Map([[execution.id, execution]]))
  await render(store)
  const run = container.querySelector('[data-slot="team-overview"] [aria-label="Run"]')!
  expect(run.textContent).toContain(reason)
  expect(run.textContent?.split(reason)).toHaveLength(2)
})

it('reads a retained claim as Stopping in Overview, the timeline and inspector after Stop', async () => {
  const execution: FlowExecution = {
    version: 2, id: 'run-1', goal: ROOM, document: FLOW_DOCUMENT, state: 'stopped', endedAt: 60_001, currentEndedAt: 60_001,
    rounds: [{ n: 1, role: 'writer', cards: [1], seats: [], state: 'closed', cause: 'seed', evidence: [] }],
    operations: [], legacyRun: null, reason: null,
  }
  const { store } = rig(undefined, undefined, {}, GOAL, new Map([[execution.id, execution]]))
  await render(store)
  const overview = container.querySelector('[data-slot="team-overview"] [aria-label="Run"]')!
  expect(overview.textContent).toContain('#1 · Migrate auth callers · Stopping · 1m')
  expect(overview.textContent).not.toContain('is working')
  const nav = row('Run') as HTMLButtonElement
  await act(async () => nav.click())
  const card = container.querySelector<HTMLButtonElement>('[data-row="card-1-1"]')!
  expect(card.textContent).toContain('Stopping')
  expect(card.textContent).not.toMatch(/Working|so far/)
  await act(async () => card.click())
  expect(container.querySelector('[data-slot="run-inspector"] [data-slot="inspector-tools"]')?.textContent).toContain('Stopping')
})

/**
 * A flow a person started carries no trigger status, so its own stop reason
 * is what the live line has left to read (#917). The host's own default —
 * `stop(id, why = 'the person stopped this flow')` in flow-execution.ts — is
 * a lowercase fragment, not a sentence, so the live line reads it as one.
 */
it("names a person-started flow's own stop reason on the live line, as a proper sentence, since no trigger status carries one for it", async () => {
  const execution: FlowExecution = {
    version: 2, id: 'run-1', goal: ROOM, document: FLOW_DOCUMENT, state: 'stopped',
    rounds: [], operations: [], legacyRun: null, reason: 'the person stopped this flow',
  }
  const { store } = rig(undefined, undefined, {}, GOAL, new Map([['run-1', execution]]))
  await render(store)
  expect(container.querySelector('[data-slot="team-overview"] [data-kind="stop"]')?.textContent).toBe('The person stopped this flow')
  expect(container.querySelector('[data-slot="team-overview"] [aria-label="Run"]')?.textContent?.split('The person stopped this flow')).toHaveLength(2)
  act(() => row('Chat').click())
  await act(async () => {})

  const line = container.querySelector('[data-slot="room-live-line"]')!
  expect(line.textContent).toBe('The person stopped this flow')
  expect(line.getAttribute('data-kind')).toBe('stop')
  // A stop is a state, not motion: the live line settled, no shimmer.
  expect(line.hasAttribute('data-settled')).toBe(true)
  expect(line.querySelector('[data-slot="dot"]')).toBeNull()
})

/**
 * A run stalled on a round's Seat that would not open read "Needs you" in the
 * header and said nothing about why anywhere in the room; a card's own
 * "Give this to…" was the only way on in sight. The live line now carries the
 * run's own reason — the refusal, the siblings its round held back, the next
 * step — each line as the host wrote it.
 */
it("names a stalled run's own reason on the live line, lines kept, as a wait on you", async () => {
  const reason = 'The Seat for card #1 could not be opened: Claude did not offer to pass a lane environment to a session when it started.\n' +
    'A round’s cards start together, so card #2 was not started either.\n' +
    'Next: wrap this Goal, which stops this run, then fix what stopped card #1 and start the flow again in a new Goal.'
  const execution: FlowExecution = {
    version: 2, id: 'run-1', goal: ROOM, document: FLOW_DOCUMENT, state: 'stalled',
    rounds: [], operations: [], legacyRun: null, reason,
  }
  const { store } = rig(undefined, undefined, {}, GOAL, new Map([['run-1', execution]]))
  await render(store)
  expect(container.querySelector('[data-slot="team-overview"] [data-kind="stall"] .whitespace-pre-line')?.textContent).toBe(reason)
  expect(container.querySelector('[data-slot="team-overview"] [aria-label="Run"]')?.textContent?.split(reason)).toHaveLength(2)
  act(() => row('Chat').click())
  await act(async () => {})

  expect(container.querySelector('header')!.textContent).toContain('Needs you')
  const line = container.querySelector('[data-slot="room-live-line"]')!
  expect(line.getAttribute('data-kind')).toBe('stall')
  expect(line.hasAttribute('data-settled')).toBe(true)
  // It waits on you: it leads with the same pulsing light a question does.
  expect(line.querySelector('[data-slot="dot"]')).not.toBeNull()
  const words = line.querySelector<HTMLElement>('.whitespace-pre-line')!
  expect(words.textContent).toBe(reason)
})

it('offers to continue a kept answer and disables the action with the visible refusal when its Seat is gone', async () => {
  const reason = 'The Seat for card #1 is no longer recorded, so it cannot be handed your answer. Start a new run to pick up the work.'
  const execution: FlowExecution = {
    version: 2, id: 'run-1', goal: ROOM, document: FLOW_DOCUMENT, state: 'stalled',
    rounds: [], operations: [], legacyRun: null, reason: 'Card #1: your answer could not be handed to its Seat after two attempts: it started another turn first. It is kept on this run.',
    keptAnswer: { card: 1, seat: 'seat-1', question: 'Which base branch?', answer: 'main', at: 1, canContinue: false, refusal: reason },
  }
  const { store } = rig(undefined, undefined, {}, GOAL, new Map([['run-1', execution]]))
  await render(store)
  const overviewButton = container.querySelector<HTMLButtonElement>('[data-slot="team-overview"] [data-kind="stall"] button')
  expect(overviewButton?.disabled).toBe(true)
  expect(overviewButton?.title).toBe(reason)
  act(() => row('Chat').click())
  await act(async () => {})
  const button = document.querySelector<HTMLButtonElement>('[data-kind="stall"] button')!
  expect(button.textContent).toBe('Continue with this answer')
  expect(button.disabled).toBe(true)
  expect(button.title).toBe(reason)
  expect(document.querySelector('[data-kind="stall"]')?.textContent).toContain(reason)
})

it('sends an enabled kept answer through the store verb with its run id', async () => {
  const execution: FlowExecution = {
    version: 2, id: 'run-1', goal: ROOM, document: FLOW_DOCUMENT, state: 'stalled',
    rounds: [], operations: [], legacyRun: null, reason: 'Card #1: your answer could not be handed to its Seat after two attempts: it started another turn first. It is kept on this run.',
    keptAnswer: { card: 1, seat: 'seat-1', question: 'Which base branch?', answer: 'main', at: 1, canContinue: true, refusal: null },
  }
  const { store } = rig(undefined, undefined, {}, GOAL, new Map([['run-1', execution]]))
  await render(store)
  const overviewButton = container.querySelector<HTMLButtonElement>('[data-slot="team-overview"] [data-kind="stall"] button')
  expect(overviewButton).not.toBeNull()
  act(() => overviewButton!.click())
  expect(store.continueFlowAnswer).toHaveBeenCalledWith('run-1')
  vi.mocked(store.continueFlowAnswer).mockClear()
  act(() => row('Chat').click())
  await act(async () => {})
  const button = document.querySelector<HTMLButtonElement>('[data-kind="stall"] button')!
  act(() => button.click())
  expect(store.continueFlowAnswer).toHaveBeenCalledWith('run-1')
})

/**
 * A release still waiting on a Seat's turn to end names the card and the
 * Seat on a line of its own, whatever the run above it is doing (#1027;
 * review #1050 finding 3, round 3). None of the branches above ever read a
 * settled run's own `reason` at all, so before this the pending release went
 * unsaid entirely for exactly this run — its own line is the only place it
 * ever reaches the screen.
 */
it('shows a pending release’s own sentence on its own line for a settled run, whose own reason no branch above ever names', async () => {
  const note = 'Waiting for Codex’s turn to end before releasing card #1.'
  const execution: FlowExecution = {
    version: 2, id: 'run-1', goal: ROOM, document: FLOW_DOCUMENT, state: 'settled',
    rounds: [], operations: [], legacyRun: null, reason: 'no rule continues from it, so this waits for you',
    pendingReleaseNote: note,
  }
  const { store } = rig(undefined, undefined, {}, GOAL, new Map([['run-1', execution]]))
  await render(store)
  expect(container.querySelector('[data-slot="team-overview"] [data-slot="room-pending-release-line"]')?.textContent).toBe(note)
  act(() => row('Chat').click())
  await act(async () => {})

  // The primary line still says whatever it would without the pending release at all — here, the roster's own default, a member at work — and never the settled run's own reason.
  expect(container.querySelector('[data-slot="room-live-line"]')?.textContent).not.toContain('no rule continues')
  const line = container.querySelector('[data-slot="room-pending-release-line"]')!
  expect(line.textContent).toBe(note)
  expect(line.hasAttribute('data-settled')).toBe(true)
})

/**
 * A trigger-started run stopped on its own time or round budget reads the
 * trigger's own stop line, never the run's `reason` (`stopText`, above) —
 * the #1027 case the fix is for. The pending release's sentence names the
 * card and the Seat on its own line regardless, right under it.
 */
it('shows a pending release’s own sentence for a trigger-stopped run too, alongside the trigger’s own stop line', async () => {
  const note = 'Card #1 is still claimed by Codex, whose turn has not ended, so it could not be released. Stop that Seat’s turn, or release card #1 by hand.'
  const detail = 'Timed out: this Goal reached its time budget.'
  const execution: FlowExecution = {
    version: 2, id: 'run-1', goal: ROOM, document: FLOW_DOCUMENT, state: 'stopped',
    rounds: [], operations: [], legacyRun: null, reason: 'Timed out: this Goal reached its time budget.',
    pendingReleaseNote: note,
  }
  const { store } = triggerRig([], { stop: { reason: 'timed out', detail, at: Date.now() } }, [], new Map([['run-1', execution]]))
  await render(store)
  act(() => row('Chat').click())
  await act(async () => {})

  const stop = container.querySelector('[data-slot="room-live-line"]')!
  expect(stop.getAttribute('data-kind')).toBe('stop')
  expect(stop.textContent).toBe(detail)
  const pending = container.querySelector('[data-slot="room-pending-release-line"]')!
  expect(pending.textContent).toBe(note)
})

/**
 * The header reads "Needs you" over "Stopped" for an open person wait
 * (`runState`'s own ternary order); the live line now agrees, rather than
 * naming the stop while the header already moved past it.
 */
it('agrees with the header rather than naming a stop reason when a stopped run still has an open person wait', async () => {
  const { store } = triggerRig([], { stop: { reason: 'needs a person', detail: 'It needs a person.', at: Date.now() } }, [
    wait({ id: 'w1', kind: 'question', waitingOn: { kind: 'person', label: 'you' }, sentence: 'A Seat asked a question and nobody answered in time.' }),
  ])
  await render(store)
  act(() => row('Chat').click())
  await act(async () => {})
  await act(async () => {})

  expect(container.querySelector('header')!.textContent).toContain('Needs you')
  const line = container.querySelector('[data-slot="room-live-line"]')!
  expect(line.getAttribute('data-kind')).toBe('wait')
  expect(line.textContent).toContain('A Seat asked a question and nobody answered in time.')
  expect(line.textContent).not.toContain('It needs a person.')
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
  const afterHeader = header.nextElementSibling?.nextElementSibling
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
const triggerRig = (
  approvals: readonly unknown[],
  budget: Record<string, unknown> = {},
  waits: readonly unknown[] = [],
  /** A reused Goal's own cached runs — see `rig`'s own last parameter. */
  flowExecutions: ReadonlyMap<string, FlowExecution> = new Map(),
) => {
  const TRIGGER_GOAL: GoalView = {
    ...GOAL,
    goal: { ...GOAL.goal, origin: { kind: 'trigger', trigger: 'triage-issue', event: 'e1' } },
  }
  const { store } = rig(undefined, undefined, {}, TRIGGER_GOAL, flowExecutions)
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
  /** A `trigger/attention` push landing in `snapshot.triggerAttention`, the way the real one does. */
  const raiseAttention = (attention: { readonly id: string }): void => {
    snapshot = { ...snapshot, triggerAttention: { ...snapshot.triggerAttention, [attention.id]: attention as never } }
    for (const listener of listeners) listener()
  }
  return { store, respondToApproval, raise, raiseAttention, triggerGoal }
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
  // The live line is the tail's first line and stays, where it says who is waiting;
  // the notice about what sending would do goes with the box it describes.
  const live = container.querySelector('[data-slot="room-live-line"]')
  expect(live, 'the live line stays mounted').not.toBeNull()
  expect(live!.closest('[hidden]'), 'and stays visible under the approval').toBeNull()
  expect(container.querySelector('[data-slot="room-composer-notice"]'), 'the composer notice is not drawn under the approval').toBeNull()
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

/**
 * Inside the card too, a field's keys are the field's. No card draws one
 * today, and that is exactly why this is pinned: the first question with a
 * free-text answer would otherwise turn a typed "1" into a command approved.
 */
it.each(['input', 'textarea', 'contenteditable'])('a key typed in a %s inside the docked card never answers it', async (kind) => {
  const { store, respondToApproval } = triggerRig(PENDING)
  await render(store)
  await act(async () => {})
  const card = container.querySelector<HTMLElement>('[data-slot="approval-card"]')!
  const field = kind === 'contenteditable' ? document.createElement('div') : document.createElement(kind)
  if (kind === 'contenteditable') field.setAttribute('contenteditable', 'true')
  card.append(field)
  act(() => field.focus())
  for (const key of ['1', '2', 'Escape']) press(field, key)
  expect(respondToApproval).not.toHaveBeenCalled()
  // The control: the same key on the card itself answers.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 650)) })
  press(card, '1')
  expect(respondToApproval).toHaveBeenCalledOnce()
})

/**
 * The card hands focus back to the composer only if the person left it where
 * the card put it. Moving on — to another field, another pane — is a choice,
 * and the answer vanishing must not undo it.
 */
it('gives focus back to the composer only if the person has not moved it since', async () => {
  const { store, raise } = triggerRig([])
  await render(store)
  await act(async () => {})

  const box = container.querySelector<HTMLTextAreaElement>('textarea')!
  act(() => box.focus())
  raise(PENDING)
  await act(async () => {})
  expect(document.activeElement, 'the card took it from the composer').toBe(
    container.querySelector('[data-slot="approval-card"]'),
  )

  const input = elsewhere()
  const allow = [...container.querySelectorAll<HTMLButtonElement>('[data-slot="approval-choices"] button')].find((one) => one.textContent?.startsWith('Yes1'))!
  act(() => allow.click())
  await act(async () => {})
  expect(container.querySelector('[data-slot="approval-card"]')).toBeNull()
  expect(document.activeElement, 'where the person put it, not the composer').toBe(input)
  input.remove()
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

it('keeps a trigger action and pending release in Overview alongside an actionable findings wait',async()=>{
  const evidenceReason='Waiting for 3 open blocking findings to be confirmed resolved.'
  const triggerReason='Review this project’s trigger permission before the next firing.'
  const releaseReason='Waiting for a Seat to finish before releasing its checkout.'
  const execution:FlowExecution={version:2,id:'run-1',goal:ROOM,document:FLOW_DOCUMENT,state:'running',
    rounds:[{n:1,role:'writer',cards:[1],seats:[],state:'waiting-evidence',cause:'seed',evidence:[]}],
    operations:[],legacyRun:null,reason:`Rule after-review: ${evidenceReason}`,pendingReleaseNote:releaseReason}
  const {store}=triggerRig([],{},[wait({sentence:triggerReason,action:'open-permissions'})],new Map([[execution.id,execution]]))
  const askSettings=vi.fn();Object.assign(store,{askSettings})
  await render(store)
  const overview=container.querySelector('[data-slot="team-overview"]')!
  for(const sentence of [evidenceReason,triggerReason,releaseReason])expect(overview.textContent?.split(sentence)).toHaveLength(2)
  const action=overview.querySelector<HTMLButtonElement>('[data-slot="room-live-line"] button')!
  expect(action.textContent).toBe('Open')
  act(()=>action.click());expect(askSettings).toHaveBeenCalledWith('permissions','ceilings')
  expect(overview.querySelector('[aria-label="Needs you"]')?.textContent).toContain('Open findings')
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
  // Each of these waits on a person, so each leads with the pulsing light.
  expect(line.querySelector('[data-slot="dot"][data-pulse]')).not.toBeNull()
})

/**
 * A wait on a service is a fact, not a call for a person: no light. And a
 * wait the reader can act on keeps its "Open" beside the words, outside the
 * live region — a control is not news.
 */
it('leads a wait with the light only when a person is needed, and keeps its Open beside the words', async () => {
  const { store } = triggerRig([], {}, [
    wait({ id: 'w9', kind: 'limit', waitingOn: { kind: 'service', label: 'the usage window' }, sentence: 'Waiting for the usage window to reset.', action: 'open-usage' }),
  ])
  await render(store)
  await act(async () => {})
  const line = container.querySelector('[data-slot="room-live-line"]')!
  expect(line.getAttribute('data-kind')).toBe('wait')
  expect(line.querySelector('[data-slot="dot"]')).toBeNull()
  const open = [...line.querySelectorAll('button')].find((one) => one.textContent === 'Open')
  expect(open, 'the wait keeps its Open').toBeDefined()
  expect(open?.closest('[data-mark="turn-work-live-trail"]')).not.toBeNull()
  expect(open?.closest('[role="status"]')).toBeNull()
})

/**
 * A budget stop names its exact reason where the run's state is read — the
 * live line, and "Stopped" in the header — and the footer keeps what was
 * spent: the partial work stands, the meter says what it cost.
 *
 * A real host pairs every budget stop with a person-kind wait of its own
 * (`packages/server/src/intake/waits.ts`'s own `if (input.stop)` branch), so
 * that is the fixture here: the wait's sentence is what shows, the same rule
 * that reads Needs you in the header for any other person-kind wait.
 */
it('a budget stop shows the person-kind wait a real host pairs with it, and reads Stopped in the header', async () => {
  const detail = 'Out of budget: this Goal reached its round limit.'
  const { store } = triggerRig([], { stop: { reason: 'out of budget', detail, at: Date.now() } }, [
    wait({
      id: 'wb', kind: 'budget', waitingOn: { kind: 'person', label: 'you' },
      sentence: `This Goal stopped: ${detail} Its cards, answers and findings are kept.`,
      action: 'open-usage',
    }),
  ])
  await render(store)
  await act(async () => {})

  expect(container.querySelector('header')!.textContent).toContain('Needs you')
  const line = container.querySelector('[data-slot="room-live-line"]')!
  // The label appears exactly once, inside the host's own sentence — never a
  // second time from intakeStopWords's own fallback label (#917). The
  // budget wait's own action ("open-usage") also draws an Open link, so the
  // sentence is checked as a prefix rather than the row's whole text.
  expect(line.textContent).toContain(`This Goal stopped: ${detail} Its cards, answers and findings are kept.`)
  expect(line.textContent?.match(/Out of budget/g)).toHaveLength(1)
  expect(container.querySelector('[data-slot="room-budget"]')!.textContent).toContain('$3.80 left')
})

/**
 * A `trigger/attention` push for this Goal re-asks right away rather than
 * waiting out the slow poll — without shortening that poll itself, which
 * still exists at its own 60s (never a faster interval added beside it).
 */
it("refreshes this Goal's waits the moment a trigger/attention push touches it, not once a minute", async () => {
  const { store, triggerGoal, raiseAttention } = triggerRig([])
  await render(store)
  await act(async () => {})
  const before = triggerGoal.mock.calls.length

  act(() => raiseAttention(wait({})))
  await act(async () => {})

  expect(triggerGoal.mock.calls.length).toBeGreaterThan(before)
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
  const projectMark = bar
  expect(projectMark?.getAttribute('title')).toBe('/repo — working in /repo/.harnessdesk/agents/reviewer/checkout')
})

it('says nothing extra on the hover when the Goal works at its own root, unchanged from before', async () => {
  const { store } = rig(undefined, undefined, { root: '/repo' }, GOAL)
  await render(store)

  const bar = container.querySelector('header')!
  const projectMark = bar
  expect(projectMark?.getAttribute('title')).toBe('/repo')
})

/**
 * The bar's own Wrap button used to be tested only for its presence; a
 * review of #905 pointed out nothing pinned when it is refused — wrapped,
 * still wrapping, or the board could not be saved (the one case
 * `goalActions` itself does not cover, read straight off `problem`).
 */
it('keeps Wrap in More, hides it after wrapping, and refuses it while wrapping or when a problem remains', async () => {
  const wrapItem = (): HTMLElement | undefined => {
    const more = container.querySelector<HTMLButtonElement>('header button[title="More"]')!
    if (more.getAttribute('aria-expanded') !== 'true') act(() => more.click())
    return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(one => one.textContent === 'Wrap…')
  }
  const { store: open } = rig(undefined, undefined, {}, GOAL)
  await render(open)
  expect(wrapItem()?.getAttribute('aria-disabled')).not.toBe('true')
  const { store: wrapped } = rig(undefined, undefined, {}, { ...GOAL, goal: { ...GOAL.goal, state: 'wrapped' } })
  await render(wrapped)
  expect(wrapItem()).toBeUndefined()
  const { store: wrapping } = rig(undefined, undefined, {}, { ...GOAL, goal: { ...GOAL.goal, state: 'wrapping' } })
  await render(wrapping)
  expect(wrapItem()?.getAttribute('aria-disabled')).toBe('true')
  const { store: problem } = rig(undefined, undefined, {}, { ...GOAL, problem: 'The board could not be saved.' })
  await render(problem)
  expect(wrapItem()?.getAttribute('aria-disabled')).toBe('true')
})

/**
 * A validator frame at 760px (a docked room rail, not the window's own
 * width) showed the bar's own `overflow: hidden` clipping the whole verbs
 * group off entirely rather than folding it — actions, unlike the muted
 * facts beside them, that must stay reachable at any width. A first pass
 * folded only Wrap, and a re-shot frame at the same width still showed
 * nothing: the messaging toggle beside it was exactly as fixed-width, so the
 * row still overflowed by its own icon button's worth. Both the full row and
 * a two-item ⋯ menu exist in the DOM at once, and `hd-header` (a real
 * `@container` query, not asserted here) decides which is visible; this pins
 * that the menu calls the same presses, so it cannot drift from the buttons
 * it stands in for.
 */
it('keeps messaging and Wrap reachable through one ⋯ menu when the bar is too narrow for their own buttons, calling the same presses', async () => {
  const { store } = rig(undefined, undefined, {}, GOAL)
  await render(store)

  const bar = container.querySelector('header')!
  const fullWrap = [...bar.querySelectorAll('button')].find((one) => one.textContent === 'Wrap')
  expect(fullWrap).toBeUndefined()
  const fullMessaging = bar.querySelector('[aria-label="Hold messages at the board"]')
  expect(fullMessaging).not.toBeNull()

  const more = [...bar.querySelectorAll('[title="More"]')][0] as HTMLElement | undefined
  expect(more, 'a compact ⋯ trigger stands beside the full buttons').not.toBeUndefined()
  act(() => more!.click())

  const wrapItem = [...document.body.querySelectorAll('[role="menuitem"], button')].find((one) => one.textContent === 'Wrap…')
  expect(wrapItem, 'the menu offers the same Wrap action').not.toBeUndefined()
  const messagingItem = [...document.body.querySelectorAll('[role="menuitem"], button')].find(
    (one) => one.textContent === 'Hold messages at the board',
  )
  expect(messagingItem, 'the menu offers the same messaging toggle').not.toBeUndefined()

  act(() => (wrapItem as HTMLElement).click())
  // GoalWrap only mounts once wrapping is asked for — the same effect the
  // full button's own onClick has.
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
})

it('draws the chat with no header of its own', async () => {
  const { store } = rig()
  await render(store)

  // The destination is the single Chat rail row; the audience hint is only on
  // its title, not repeated as a visible line in the stream or rail.
  expect(container.textContent).not.toContain('Everyone in this room reads this')
  expect(container.textContent).not.toContain('Everyone in this room')
  const rows = [...container.querySelectorAll('[data-team-page="room"]')]
  expect(rows, 'Chat is one section tab').toHaveLength(1)
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
  act(() => (bar!.querySelector('[title="More"]') as HTMLButtonElement).click())
  expect([...document.querySelectorAll('[role="menuitem"]')].some(one => one.textContent === 'Fill the window')).toBe(true)
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
  expect(container.querySelector('[title="0 of 2 here"]')).not.toBeNull()
  expect(container.textContent).not.toContain('No agents in this Team yet')
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

it('sends the body back to the chat when the member opened on its own is released', async () => {
  const goal = {
    goal: { id: ROOM, root: '/repo', cwd: '/repo', sentence: 'Checkout rewrite', state: 'open', revision: 1, checkout: 'shared', dependsOn: [], origin: { kind: 'person' }, createdAt: 1, updatedAt: 1, receipt: null },
    activity: 'working', waitingOn: [],
    members: [{ id: 'seat-1', closed: null, session: { runtime: 'codex', sessionId: 'c1' } }],
    board: state, receipt: null, problem: null,
  } as unknown as GoalView
  const { store } = rig(undefined, undefined, {}, goal)
  await render(store)
  memberList()
  await act(async () => { row('Codex').click() })
  memberList()
  expect(row('Codex').closest('[data-slot="list-row"]')?.getAttribute('aria-current')).toBe('true')

  vi.useFakeTimers()
  const trigger = row('Codex').closest('[data-slot="hover-card-trigger"]') as Element
  act(() => {
    trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
    trigger.dispatchEvent(new MouseEvent('mouseenter'))
  })
  act(() => { vi.advanceTimersByTime(1000) })
  const remove = [...document.body.querySelectorAll('button')].find((one) => one.textContent?.trim() === 'Take out of the room')!
  vi.useRealTimers()
  await act(async () => { remove.click() })
  await act(async () => {})
  expect(row('Chat').getAttribute('aria-selected')).toBe('true')
})

it('takes a released member’s tile off the grid with it', async () => {
  const goal = {
    goal: { id: ROOM, root: '/repo', cwd: '/repo', sentence: 'Checkout rewrite', state: 'open', revision: 1, checkout: 'shared', dependsOn: [], origin: { kind: 'person' }, createdAt: 1, updatedAt: 1, receipt: null },
    activity: 'working', waitingOn: [],
    members: [{ id: 'seat-1', closed: null, session: { runtime: 'codex', sessionId: 'c1' } }],
    board: state, receipt: null, problem: null,
  } as unknown as GoalView
  const { store } = rig(undefined, undefined, {}, goal)
  await render(store)
  const watch = row('Codex').querySelector<HTMLButtonElement>('button[aria-label^="Watch"]')!
  await act(async () => { watch.click() })
  expect(container.querySelectorAll('[data-slot="side-by-side-tile"]')).toHaveLength(1)

  vi.useFakeTimers()
  const trigger = row('Codex').closest('[data-slot="hover-card-trigger"]') as Element
  act(() => {
    trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
    trigger.dispatchEvent(new MouseEvent('mouseenter'))
  })
  act(() => { vi.advanceTimersByTime(1000) })
  const remove = [...document.body.querySelectorAll('button')].find((one) => one.textContent?.trim() === 'Take out of the room')!
  vi.useRealTimers()
  await act(async () => { remove.click() })
  await act(async () => {})
  expect(container.querySelectorAll('[data-slot="side-by-side-tile"]')).toHaveLength(0)
  expect(store.lastView().sideBySide).toBeUndefined()
  // The rail and the body agree: the room's chat is open, not an empty Side by side.
  expect(row('Chat').getAttribute('aria-selected')).toBe('true')
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

  memberList()
  act(() => row('Opus').click())
  await act(async () => {})

  expect(store.openSession).toHaveBeenCalledWith('k1', { runtime: 'claude', reveal: false })
})

it('does not re-open a member the desk already holds', async () => {
  // CODEX is `here`, and the rig's snapshot carries its session.
  const { store } = rig([CODEX])
  await render(store)

  memberList()
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
  memberList()
  act(() => row('Opus').click())
  await act(async () => {})
  expect(store.openSession).toHaveBeenCalledTimes(1)

  // Close the column and open it again: the guard must not still be holding
  // the failure from a moment ago.
  act(() => row('Chat').click())
  await act(async () => {})
  memberList()
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
  const again = row('Opus').querySelector('[data-slot="list-row-title"]')!
  leave(again)
  rest(again)
  expect(row('Opus').closest('[data-slot="hover-card-trigger"]')?.hasAttribute('data-popup-open')).toBe(true)
  vi.useRealTimers()
})

/**
 * The + is the row's other verb, and resting on it asks about that verb.
 *
 * Its title says which column a pick will take away, and a card opened beside
 * that sentence would be saying something else. So resting on it summons no
 * card, reaching it puts an open one away — and pressing it still watches.
 */
it('the Watch control opens no card and puts the member on the grid', async () => {
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
  expect(container.querySelectorAll('[data-slot="side-by-side-tile"]')).toHaveLength(1)
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

it('opens the room member card from a tile identity', async () => {
  vi.useFakeTimers()
  const { store } = rig()
  await render(store)

  memberList()
  act(() => row('Opus').querySelector<HTMLButtonElement>('button[aria-label^="Watch"]')?.click())
  await act(async () => {})
  const head = [...container.querySelectorAll('[data-slot="side-by-side-tile"] header')].find((one) =>
    one.textContent?.includes('Opus'),
  )
  if (!head) throw new Error('no tile head for Opus')

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

it('lists Flow Seats from the Goal when the older roster is empty, and defaults to Overview', async () => {
 const view = { ...GOAL, members: [
  { id:'writer-seat', session:{runtime:'codex',sessionId:'c1'}, role:'writer', openedAt:1, closed:null, agent:{name:'Writer'} },
  { id:'reviewer-seat', session:{runtime:'claude',sessionId:'k1'}, role:'reviewer', openedAt:1, closed:null, agent:{name:'Reviewer'} },
 ] } as unknown as GoalView
 const execution = {version:2,id:'overview-run',goal:ROOM,state:'settled',reason:null,legacyRun:null,operations:[],rounds:[],document:{format:'agents',flow:{name:'Build and review',roles:[],rules:[]}}} as unknown as FlowExecution
 const {store}=rig([],undefined,{members:[],intents:[]},view,new Map([[execution.id,execution]]))
 await render(store)
 expect(container.querySelector('[data-slot="team-overview"]')).not.toBeNull()
 expect(memberList().querySelectorAll('[data-slot="hover-card-trigger"]')).toHaveLength(2)
 expect(container.textContent).not.toContain('No agents in this Team yet')
 expect(container.textContent).toContain('Agents · 2')
})

it('opens Overview when the cached Run arrives, and preserves a later choice of Chat', async () => {
  const runs = new Map<string, FlowExecution>()
  const { store, pushes } = rig([], undefined, { members: [] }, GOAL, runs)
  await render(store)
  expect(container.querySelector('[data-slot="team-overview"]')).toBeNull()
  const execution = {
    version: 2, id: 'later-run', goal: ROOM, state: 'settled', reason: null,
    legacyRun: null, operations: [], rounds: [],
    document: { format: 'agents', flow: { name: 'Build and review', roles: [], rules: [] } },
  } as unknown as FlowExecution
  runs.set(execution.id, execution)
  await pushes({ updatedAt: 2 })
  expect(container.querySelector('[data-slot="team-overview"]')).not.toBeNull()
  const chat = row('Chat')
  await act(async () => { chat.click() })
  await pushes({ updatedAt: 3 })
  expect(container.querySelector('[data-slot="team-overview"]')).toBeNull()
})

it('keeps a finished Seat on the rail with a quiet Done state after its process rests', async () => {
  const view = { ...GOAL, members: [{
    id: 'reviewer-seat', session: { runtime: 'claude', sessionId: 'k1' },
    role: 'reviewer', openedAt: 1, closed: null, agent: { name: 'Reviewer' },
  }] } as unknown as GoalView
  const finished = { ...state.intents[0]!, state: 'done', claim: null } as Intent
  const { store } = rig([], undefined, { members: [], intents: [finished], channel: [{
    id: 'completed-review', kind: 'signal', at: 2, signal: 'completed', intent: finished.id, title: finished.title,
    by: { kind: 'agent', runtime: runtimeId('claude'), sessionId: 'k1', title: 'Reviewer' },
  }] }, view)
  await render(store)
  const rail = memberList()!
  expect(rail.textContent).toContain('Reviewer')
  expect(rail.textContent).toContain('Done')
  expect([...rail.querySelectorAll('[data-slot="chip"]')].some(one => one.textContent === 'Done')).toBe(false)
})

it('includes recorded spend from earlier Seats using the runtime capabilities already in the window', async () => {
  const execution = {
    version: 2, id: 'spend-run', goal: ROOM, state: 'settled', reason: null,
    legacyRun: null, operations: [], rounds: [],
    document: { format: 'agents', flow: { name: 'Build and review', roles: [], rules: [] } },
  } as unknown as FlowExecution
  const metric = (value: number) => ({ value, quality: 'exact', coverage: 'complete', basis: 'vendorMetered' })
  const usage = {
    goal: ROOM, provenance: { state: 'available' }, totals: { turns: metric(3) }, seats: [],
    breakdowns: [{ dimension: 'seat', rows: [{
      goal: ROOM, seat: 'earlier-writer', session: { runtime: 'codex', sessionId: 'earlier-session' },
      amounts: { usd: metric(0.8) },
    }] }],
  } as unknown as InsightReport
  const { store } = rig([], [{ id: 'codex', presentation: { name: 'Assistant' }, capabilities: { metered: true } }],
    { members: [] }, GOAL, new Map([[execution.id, execution]]))
  Object.assign(store, { readGoalInsight: vi.fn(async () => usage) })
  await render(store)
  expect(container.querySelector('[aria-label="Run"]')?.textContent).toContain('$0.80')
})

it('reads usage only while Overview is selected and stops polling when it is left', async () => {
 const runs = new Map<string,FlowExecution>()
 const {store,pushes}=rig([],undefined,{members:[]},GOAL,runs)
 const readGoalInsight=vi.fn(async()=>null)
 Object.assign(store,{readGoalInsight})
 await render(store)
 expect(readGoalInsight).not.toHaveBeenCalled()
 const pick=async(label:string)=>{
  const button=[...container.querySelectorAll('[data-team-page]')].find(one=>one.textContent?.startsWith(label)) as HTMLButtonElement
  await act(async()=>{button.click()})
 }
 await pick('Overview')
 expect(readGoalInsight).toHaveBeenCalledTimes(1)
 await pick('Chat')
 await pushes({intents:state.intents.map(one=>({...one,state:'done',claim:null})) as Intent[]})
 expect(readGoalInsight).toHaveBeenCalledTimes(1)
 runs.set('usage-run',{version:2,id:'usage-run',goal:ROOM,state:'running',reason:null,legacyRun:null,operations:[],rounds:[],document:{format:'agents',flow:{name:'Build',roles:[],rules:[]}}} as unknown as FlowExecution)
 await pushes({updatedAt:3})
 expect(readGoalInsight).toHaveBeenCalledTimes(1)
 vi.useFakeTimers()
 try {
  await pick('Overview')
  expect(readGoalInsight).toHaveBeenCalledTimes(2)
  await act(async()=>{await vi.advanceTimersByTimeAsync(60_000)})
  expect(readGoalInsight).toHaveBeenCalledTimes(3)
  await pick('Chat')
  await act(async()=>{await vi.advanceTimersByTimeAsync(60_000)})
  expect(readGoalInsight).toHaveBeenCalledTimes(3)
 } finally {vi.useRealTimers()}
})

it('opens a read-only Run from the rail and Overview, and keeps selection in the pane', async () => {
  const execution = { version: 2, id: 'timeline-run', goal: ROOM, state: 'running', brief: 'Retry the request', startedAt: 1, reason: null, legacyRun: null, operations: [], rounds: [{ n: 1, role: 'writer', cards: [1], seats: [], evidence: [], state: 'running', cause: 'seed' }], document: { format: 'agents', flow: { name: 'Build and review', roles: [], rules: [] } } } as unknown as FlowExecution
  const { store } = rig([], undefined, { members: [] }, GOAL, new Map([[execution.id, execution]]))
  Object.assign(store, { loadFindings: vi.fn().mockResolvedValue(undefined) })
  await render(store)
  const nav = row('Run') as HTMLButtonElement
  expect(nav, 'Run has a rail destination').toBeTruthy()
  expect(nav.textContent).toContain('1')
  await act(async () => nav.click())
  const card = container.querySelector('[data-row="card-1-1"]') as HTMLButtonElement
  expect(card).not.toBeNull()
  await act(async () => card.click())
  expect(store.readFindingPublications).toHaveBeenCalledWith(ROOM, execution.id)
  expect(container.querySelector('[data-row="card-1-1"][aria-current="true"]')).not.toBeNull()
  const overview = [...container.querySelectorAll('[data-team-page]')].find(one => one.textContent === 'Overview') as HTMLButtonElement
  await act(async () => overview.click())
  const strip = container.querySelector('[aria-label="Run"] button') as HTMLButtonElement
  expect(strip, 'the Run strip opens the same timeline').not.toBeNull()
  await act(async () => strip.click())
  expect(container.querySelector('[data-row="card-1-1"][aria-current="true"]')).not.toBeNull()
})

it('warns when a Run reads only part of the findings ledger', async () => {
  const execution = { version: 2, id: 'partial-run', goal: ROOM, state: 'running', reason: null, operations: [], rounds: [], document: { format: 'agents', flow: { name: 'Build', roles: [], rules: [] } } } as unknown as FlowExecution
  const { store } = rig([], undefined, { members: [] }, GOAL, new Map([[execution.id, execution]]))
  const snapshot = { ...store.getSnapshot(), findings: new Map([[ROOM, { rows: [], filter: 'all' as const, next: null, loading: false, error: null, problem: 'One finding could not be read.' }]]) }
  Object.assign(store, { getSnapshot: () => snapshot, loadFindings: vi.fn().mockResolvedValue(undefined) })
  await render(store)
  const nav = row('Run') as HTMLButtonElement
  await act(async () => nav.click())
  expect(container.querySelector('[data-slot="run-view"]')?.textContent).toContain('One finding could not be read.')
})

it('an unrouted settled Run says Needs you once and keeps its Overview reason', async () => {
  const execution = { version: 2, id: 'unrouted-run', goal: ROOM, state: 'settled', end: { kind: 'unrouted', card: 1, outcome: 'no-pr' }, reason: 'No rule follows no-pr.', operations: [], rounds: [], document: { format: 'agents', flow: { name: 'Build', roles: [], rules: [] } } } as unknown as FlowExecution
  const { store } = rig([], undefined, { members: [] }, GOAL, new Map([[execution.id, execution]]))
  await render(store)
  expect(container.querySelector('[data-slot="room-head"]')?.textContent ?? container.textContent).toContain('Needs you')
  expect(container.querySelector('[aria-label="Run"]')?.textContent).toContain('No rule follows no-pr.')
  expect(container.querySelector('[aria-label="Run"] [data-slot="chip"]')).toBeNull()
})

it('does not carry a Run again dialog into another Team in the same pane', async () => {
  const execution = { version: 2, id: 'stopped-run', goal: ROOM, state: 'stopped', end: { kind: 'stopped', by: 'person' }, reason: 'Stopped.', operations: [], rounds: [], document: { format: 'agents', flow: { name: 'Build', roles: [], rules: [] } } } as unknown as FlowExecution
  const { store } = rig([], undefined, { members: [] }, GOAL, new Map([[execution.id, execution]]))
  Object.assign(store, { flowExecutionSource: vi.fn(() => new Promise(() => {})) })
  await render(store)
  const nav = row('Run') as HTMLButtonElement
  await act(async () => nav.click())
  await act(async () => ([...container.querySelectorAll<HTMLButtonElement>('[data-slot="run-ending"] button')].find(button => button.textContent === 'Run again…')!).click())
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Run again')
  const snapshot = store.getSnapshot()
  const next = { ...snapshot, teams: new Map(snapshot.teams).set('room-2', { ...state, id: 'room-2', members: [] }),
    goals: new Map(snapshot.goals).set('room-2', { ...GOAL, goal: { ...GOAL.goal, id: 'room-2' } }) }
  Object.assign(store, { getSnapshot: () => next })
  await render(store, 'room-2')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await render(store)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('loads older Runs for the rail count and keeps each Run’s own selected row', async () => {
  const execution = { version: 2, id: 'new-run', goal: ROOM, state: 'running', startedAt: 2, reason: null, operations: [], rounds: [{ n: 1, role: 'writer', cards: [1], seats: [], evidence: [], state: 'running', cause: 'seed' }], document: { format: 'agents', flow: { name: 'Build', roles: [], rules: [] } } } as unknown as FlowExecution
  const runs = new Map([[execution.id, execution]])
  const { store, pushes } = rig([], undefined, { members: [] }, GOAL, runs)
  const loadTeamRuns = vi.fn(async () => { runs.set('old-run', { ...execution, id: 'old-run', state: 'settled', startedAt: 1 }) })
  Object.assign(store, { loadTeamRuns, loadFindings: vi.fn().mockResolvedValue(undefined) })
  await render(store)
  expect(loadTeamRuns).toHaveBeenCalledWith(ROOM)
  await pushes({ updatedAt: 3 })
  const nav = row('Run') as HTMLButtonElement
  expect(nav.textContent).toContain('2')
  await act(async () => nav.click())
  const choose = async (label: string) => { await act(async () => { ([...container.querySelectorAll('[aria-label="Choose a Run"] button')].find(one => one.textContent === label) as HTMLButtonElement).click() }) }
  await choose('Run 1')
  await act(async () => (container.querySelector('[data-row="card-1-1"]') as HTMLButtonElement).click())
  expect(store.readFindingPublications).toHaveBeenLastCalledWith(ROOM, 'old-run')
  await choose('Run 2')
  expect(container.querySelector('[aria-current="true"][data-row]')).toBeNull()
  await choose('Run 1')
  expect(container.querySelector('[data-row="card-1-1"][aria-current="true"]')).not.toBeNull()
})

it.each(['running', 'settled'] as const)('discovers an uncached %s Run when opening a trigger Team', async state => {
  const goal: GoalView = { ...GOAL, reservation: undefined,
    goal: { ...GOAL.goal, origin: { kind: 'trigger', trigger: 'triage-issue', event: 'e1' } } }
  const runs = new Map<string, FlowExecution>()
  const { store, pushes } = rig([], undefined, { members: [] }, goal, runs)
  const execution = { version: 2, id: 'trigger-run', goal: ROOM, state, startedAt: 1, reason: null,
    operations: [], rounds: [], document: { format: 'agents', flow: { name: 'Triage', roles: [], rules: [] } } } as unknown as FlowExecution
  const loadTeamRuns = vi.fn(async () => { runs.set(execution.id, execution) })
  Object.assign(store, { loadTeamRuns, triggerGoal: vi.fn().mockResolvedValue(null), loadFindings: vi.fn().mockResolvedValue(undefined) })
  await render(store)
  expect(loadTeamRuns).toHaveBeenCalledWith(ROOM)
  await pushes({ updatedAt: 3 })
  const nav = row('Run') as HTMLButtonElement
  expect(nav.textContent).toContain('1')
  await act(async () => nav.click())
  expect(container.querySelector('[data-slot="run-view"]')?.textContent).toContain('Triage')
})

it('draws a check run more than once with each attempt under it, and asks the desk for them only while the Run is on show', async () => {
  const gate = { version: 2, id: 'gate-run', goal: ROOM, state: 'running', startedAt: 1, reason: null, legacyRun: null,
    operations: [{ key: 'check:1:0', kind: 'check', state: 'finished', card: 1, seat: null }],
    rounds: [{ n: 1, role: 'verify', cards: [1], seats: [], evidence: [], state: 'closed', cause: 'seed' }],
    document: { format: 'agents', flow: { name: 'Gate', rules: [], roles: [{ id: 'verify', kind: 'check', check: { run: 'pnpm verify', timeout: 60, exits: { '0': 'pass' }, otherwise: 'fail' } }] } } } as unknown as FlowExecution
  const card = { id: 1, title: 'Verify', state: 'done', outcome: 'pass', files: [], dependsOn: [], createdAt: 1, updatedAt: 2 }
  const { store } = rig([], undefined, { members: [], intents: [card] } as never, GOAL, new Map([[gate.id, gate]]))
  const attempts = [
    { id: 'attempt-1', n: 1, at: Date.now() - 600_000, commit: 'c0ffee1', exit: 1, timedOut: false, outcome: 'fail', tail: 'FAIL: one test' },
    { id: 'attempt-2', n: 2, at: Date.now() - 60_000, commit: 'c0ffee2', exit: 0, timedOut: false, outcome: 'pass', tail: 'ok' },
  ]
  const readCheckAttempts = vi.fn(async () => ({ attempts, complete: true }))
  Object.assign(store, { loadFindings: vi.fn().mockResolvedValue(undefined), readCheckAttempts })
  await render(store)
  expect(readCheckAttempts, 'the Overview is on show, not the Run').not.toHaveBeenCalled()
  const nav = row('Run') as HTMLButtonElement
  await act(async () => nav.click())
  expect(readCheckAttempts).toHaveBeenCalledWith('gate-run', 1)
  expect([...container.querySelectorAll('[data-row]')].map(one => one.getAttribute('data-row'))).toEqual(['start', 'round-1', 'check-1-1', 'attempt-1-1-1', 'attempt-1-1-2'])
  expect([...container.querySelectorAll('button')].some(one => one.textContent === 'Run again…')).toBe(true)
  await act(async () => (container.querySelector('[data-row="check-1-1"]') as HTMLButtonElement).click())
  const inspector = container.querySelector('[data-slot="run-inspector"]')!
  expect([...inspector.querySelectorAll('section')].find(one => one.textContent?.startsWith('Attempts'))?.textContent).toContain('Attempt 2')
})

it('says a check’s attempts could not be read — in the Run’s warning and in the check’s inspector — rather than that it ran once', async () => {
  const gate = { version: 2, id: 'gate-run', goal: ROOM, state: 'running', startedAt: 1, reason: null, legacyRun: null,
    operations: [{ key: 'check:1:0', kind: 'check', state: 'finished', card: 1, seat: null }],
    rounds: [{ n: 1, role: 'verify', cards: [1], seats: [], evidence: [], state: 'closed', cause: 'seed' }],
    document: { format: 'agents', flow: { name: 'Gate', rules: [], roles: [{ id: 'verify', kind: 'check', check: { run: 'pnpm verify', timeout: 60, exits: { '0': 'pass' }, otherwise: 'fail' } }] } } } as unknown as FlowExecution
  const card = { id: 1, title: 'Verify', state: 'done', outcome: 'pass', files: [], dependsOn: [], createdAt: 1, updatedAt: 2 }
  const { store } = rig([], undefined, { members: [], intents: [card] } as never, GOAL, new Map([[gate.id, gate]]))
  let answer: (() => void) | null = null
  const readCheckAttempts = vi.fn(() => new Promise<never[]>((_resolve, reject) => { answer = () => reject(new Error('The desk did not answer.')) }))
  Object.assign(store, { loadFindings: vi.fn().mockResolvedValue(undefined), readCheckAttempts })
  await render(store)
  const nav = row('Run') as HTMLButtonElement
  await act(async () => nav.click())
  await act(async () => (container.querySelector('[data-row="check-1-1"]') as HTMLButtonElement).click())
  const inspector = () => container.querySelector('[data-slot="run-inspector"]')!.textContent ?? ''
  expect(inspector()).toContain('Reading attempts…')
  await act(async () => { answer!() })
  expect(inspector()).toContain('Earlier attempts could not be read')
  expect(container.querySelector('[data-slot="run-view"]')!.textContent).toContain('Earlier attempts of a check could not be read.')
})

it('a new attempt appears under the check when its result lands, and the earlier attempts stay as they were', async () => {
  const gate = { version: 2, id: 'gate-run', goal: ROOM, state: 'running', startedAt: 1, reason: null, legacyRun: null,
    operations: [{ key: 'check:1:0', kind: 'check', state: 'finished', card: 1, seat: null }],
    rounds: [{ n: 1, role: 'verify', cards: [1], seats: [], evidence: [], state: 'closed', cause: 'seed' }],
    document: { format: 'agents', flow: { name: 'Gate', rules: [], roles: [{ id: 'verify', kind: 'check', check: { run: 'pnpm verify', timeout: 60, exits: { '0': 'pass' }, otherwise: 'fail' } }] } } } as unknown as FlowExecution
  const card = { id: 1, title: 'Verify', state: 'done', outcome: 'pass', files: [], dependsOn: [], createdAt: 1, updatedAt: 2 }
  const { store } = rig([], undefined, { members: [], intents: [card] } as never, GOAL, new Map([[gate.id, gate]]))
  const attempt = (n: number) => ({ id: `attempt-${n}`, n, at: n * 1000, commit: `c0ffee${n}`, exit: n === 2 ? 0 : 1, timedOut: false, outcome: n === 2 ? 'pass' : 'fail', tail: `output ${n}` })
  let recorded = [attempt(1), attempt(2)]
  const readCheckAttempts = vi.fn(async () => ({ attempts: recorded, complete: true }))
  const evidenceWith = (id: string) => ({ room: ROOM, stamp: 1, checks: [], refused: [], unreadable: null, cards: [{ card: 1, running: [], facts: [{ freshness: { state: 'fresh' }, by: null,
    record: { id, observedAt: 1, round: 1, fact: { kind: 'check', name: 'verify', run: 'pnpm verify', exit: 0, timedOut: false, at: 'abc', dirty: false, tail: '' } } }] }] })
  const base = store.getSnapshot()
  // One snapshot per state of the board, as the store holds them: a new object on every read is a store that never settles.
  const snapshotWith = (id: string) => ({ ...base, boardEvidence: new Map([[ROOM, evidenceWith(id)]]) })
  let snapshot = snapshotWith('f2')
  Object.assign(store, { loadFindings: vi.fn().mockResolvedValue(undefined), readCheckAttempts, getSnapshot: () => snapshot })
  await render(store)
  const nav = row('Run') as HTMLButtonElement
  await act(async () => nav.click())
  const rows = () => [...container.querySelectorAll('[data-kind="attempt"]')].map(one => one.getAttribute('data-row'))
  expect(rows()).toEqual(['attempt-1-1-1', 'attempt-1-1-2'])
  // The person ran it again; its result lands as new evidence on the card, and the pane asks again.
  recorded = [...recorded, attempt(3)]
  snapshot = snapshotWith('f3')
  await render(store)
  expect(readCheckAttempts).toHaveBeenCalledTimes(2)
  expect(rows()).toEqual(['attempt-1-1-1', 'attempt-1-1-2', 'attempt-1-1-3'])
  await act(async () => (container.querySelector('[data-row="check-1-1"]') as HTMLButtonElement).click())
  const attempts = container.querySelector('[data-slot="run-inspector"] [data-attempt="1"]')!
  await act(async () => { [...attempts.querySelectorAll('button')].find(one => one.textContent === 'Show output')!.click() })
  expect(attempts.textContent).toContain('output 1')
})

/**
 * What needs you, answered from the Overview. Each answer is the request the
 * surface that already answers it makes — the board's menu for a person's
 * card, the docked approval for a request — so whichever door answers first
 * wins, and the host sees one request either way.
 */
const personRun = (rules: readonly unknown[] = [], extraRoles: readonly unknown[] = []): FlowExecution => ({
  version: 2, id: 'run-1', goal: ROOM, state: 'running', startedAt: 1, reason: null, legacyRun: null, operations: [],
  rounds: [{ n: 1, role: 'decide', cards: [5], seats: [], evidence: [], state: 'running', cause: 'seed' }],
  document: { format: 'agents', flow: {
    version: 2, name: 'Ship', inputs: [], roles: [{ id: 'decide', kind: 'person', outcomes: ['approved', 'request-changes'] }, ...extraRoles],
    rules, seed: { role: 'decide', title: 'Go' }, messaging: 'board-only', wait: 240,
  } },
} as unknown as FlowExecution)
const personCard = { ...state.intents[1]!, id: 5, title: 'Decide whether to ship', state: 'open', role: 'decide', claim: null } as Intent
const needsYouRow = (): HTMLElement => container.querySelector('[aria-label="Needs you"]') as HTMLElement
const inNeedsYou = (label: string): HTMLButtonElement =>
  [...needsYouRow().querySelectorAll('button')].find((one) => one.textContent === label) as HTMLButtonElement

it("answers a person's step from the Overview with the request the board's own menu makes", async () => {
  const execution = personRun([{ id: 'ship', on: 'decide', when: { every: ['approved'] }, then: { role: 'decide', title: 'Again' } }])
  const { store } = rig(undefined, undefined, { intents: [personCard] }, GOAL, new Map([[execution.id, execution]]))
  await render(store)
  expect(needsYouRow().textContent).toContain('Decide whether to ship')
  expect(needsYouRow().textContent).toContain('Approved opens a step for you.')
  expect(needsYouRow().textContent).toContain('Request changes ends the Run without a next step.')
  await act(async () => inNeedsYou('Approved').click())
  expect(store.teamIntent).toHaveBeenCalledTimes(1)
  const fromOverview = vi.mocked(store.teamIntent).mock.lastCall
  expect(fromOverview).toEqual([ROOM, 5, 'done', undefined, 'approved'])

  // The board's menu, for the same card and the same word.
  act(() => row('Board').click())
  await act(async () => {})
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="What to do with #5"]')!
  act(() => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    trigger.click()
  })
  await act(async () => {})
  const item = [...document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]')].find((one) => one.textContent?.includes('Answer approved'))!
  act(() => item.click())
  await act(async () => {})
  expect(store.teamIntent).toHaveBeenCalledTimes(2)
  expect(vi.mocked(store.teamIntent).mock.lastCall).toEqual(fromOverview)
})

it('gives the note the person wrote as the context the next round reads, and shows the host\'s refusal', async () => {
  const execution = personRun()
  const { store } = rig(undefined, undefined, { intents: [personCard] }, GOAL, new Map([[execution.id, execution]]))
  vi.mocked(store.teamIntent).mockRejectedValueOnce(new Error('This card was already answered.'))
  await render(store)
  const note = needsYouRow().querySelector<HTMLInputElement>('input')!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => { setter.call(note, 'Ship it once the retry has a ceiling.'); note.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => inNeedsYou('Request changes').click())
  expect(store.teamIntent).toHaveBeenCalledWith(ROOM, 5, 'done', undefined, 'request-changes', 'Ship it once the retry has a ceiling.')
  expect(needsYouRow().querySelector('[role="alert"]')?.textContent).toBe('This card was already answered.')
  expect(inNeedsYou('Request changes').disabled).toBe(true)
})

it('sends a review step to the board, where its attempt is chosen', async () => {
  const execution = personRun(
    [{ id: 'land', on: 'decide', when: { every: ['approved'], evidence: [{ review: 'approved' }] }, then: { role: 'merge', title: 'Merge' } }],
    [{ id: 'merge', kind: 'person', outcomes: ['merged'] }],
  )
  const { store } = rig(undefined, undefined, { intents: [personCard] }, GOAL, new Map([[execution.id, execution]]))
  await render(store)
  expect(inNeedsYou('Approved')).toBeUndefined()
  await act(async () => inNeedsYou('Pick an attempt on the board').click())
  expect(container.querySelector('[data-slot="board-column"]')).not.toBeNull()
  expect(store.teamIntent).not.toHaveBeenCalled()
})

it("answers an approval from the Overview with the call the docked card makes", async () => {
  const execution = personRun()
  const { store } = rig(undefined, undefined, {}, GOAL, new Map([[execution.id, execution]]))
  const approvals = [{
    key: sessionKey('codex', 'c1'),
    approval: {
      id: 'a1', sessionId: 'c1', requestedAt: 5, type: 'command', kind: 'command', command: 'pnpm verify', cwd: '/repo', actions: [],
      options: [
        { id: 'yes', label: 'Yes', intent: 'approve' },
        { id: 'always', label: 'Yes, always', intent: 'approveAlways' },
        { id: 'no', label: 'No, tell it instead', intent: 'deny' },
      ],
    },
  }]
  const snapshot = { ...store.getSnapshot(), approvals: approvals as never }
  const respondToApproval = vi.fn().mockResolvedValue({ ok: true })
  Object.assign(store, { getSnapshot: () => snapshot, respondToApproval })
  await render(store)
  expect(needsYouRow().textContent).toContain('pnpm verify')
  expect([...needsYouRow().querySelectorAll('button')].map((one) => one.textContent)).toEqual(['No, tell it instead', 'Yes, always', 'Yes'])
  await act(async () => inNeedsYou('Yes').click())
  const fromOverview = respondToApproval.mock.lastCall
  expect(fromOverview).toEqual([sessionKey('codex', 'c1'), 'a1', { type: 'option', optionId: 'yes' }])

  // The docked card in the chat, for the same request, sends the same thing.
  act(() => row('Chat').click())
  await act(async () => {})
  const docked = [...container.querySelectorAll<HTMLButtonElement>('[data-slot="approval-card"] button')].find((one) => /^Yes\d?$/.test(one.textContent ?? ''))!
  act(() => docked.click())
  expect(respondToApproval).toHaveBeenCalledTimes(2)
  expect(respondToApproval.mock.lastCall).toEqual(fromOverview)
})

it('answers a person\'s step and sends a review to the board from the Run inspector too', async () => {
  const execution = personRun()
  const { store } = rig(undefined, undefined, { intents: [personCard] }, GOAL, new Map([[execution.id, execution]]))
  Object.assign(store, { loadFindings: vi.fn().mockResolvedValue(undefined) })
  await render(store)
  const nav = row('Run') as HTMLButtonElement
  await act(async () => nav.click())
  await act(async () => (container.querySelector('[data-row="person-1-5"]') as HTMLButtonElement).click())
  const inspector = container.querySelector('[data-slot="run-inspector"]')!
  await act(async () => ([...inspector.querySelectorAll('button')].find(one => one.textContent === 'Request changes') as HTMLButtonElement).click())
  expect(store.teamIntent).toHaveBeenCalledWith(ROOM, 5, 'done', undefined, 'request-changes')
})

it('sends a review step to the board from the Run inspector', async () => {
  const execution = personRun(
    [{ id: 'land', on: 'decide', when: { every: ['approved'], evidence: [{ review: 'approved' }] }, then: { role: 'merge', title: 'Merge' } }],
    [{ id: 'merge', kind: 'person', outcomes: ['merged'] }],
  )
  const { store } = rig(undefined, undefined, { intents: [personCard] }, GOAL, new Map([[execution.id, execution]]))
  Object.assign(store, { loadFindings: vi.fn().mockResolvedValue(undefined) })
  await render(store)
  const nav = row('Run') as HTMLButtonElement
  await act(async () => nav.click())
  await act(async () => (container.querySelector('[data-row="person-1-5"]') as HTMLButtonElement).click())
  const pick = [...container.querySelector('[data-slot="run-inspector"]')!.querySelectorAll('button')].find(one => one.textContent === 'Pick an attempt on the board') as HTMLButtonElement
  await act(async () => pick.click())
  expect(container.querySelector('[data-slot="board-column"]')).not.toBeNull()
  expect(container.querySelector('[data-slot="run-inspector"]')).toBeNull()
})

it('a wrapped Team keeps receipt Seats and its Run readable while dispatching verbs are disabled', async () => {
 const execution = {version:2,id:'wrapped-run',goal:ROOM,state:'settled',reason:null,operations:[],rounds:[],document:{format:'agents',flow:{name:'Completed review',roles:[],rules:[]}}} as unknown as FlowExecution
 const goal: GoalView = {...GOAL,goal:{...GOAL.goal,state:'wrapped',origin:{kind:'flow',run:execution.id}},members:[],receipt:{version:1,id:'receipt',goal:ROOM,sentence:GOAL.goal.sentence,summary:'Reviewed.',wrappedAt:2,cards:[],seats:['kept','lost'],members:[{seat:'kept',agent:'Writer',seatLabel:'Alpha',session:{runtime:'codex',sessionId:'c1'}},{seat:'lost',agent:null,seatLabel:'Gamma'}],answers:[],evidence:[],lanes:[],revisions:[],citations:[],gaps:[]}}
 const {store}=rig([],undefined,{members:[]},goal,new Map([[execution.id,execution]]))
 await render(store)
 expect(memberList()?.textContent).toContain('Writer')
 expect(memberList()?.textContent).toContain('Gamma')
 expect(memberList().querySelector('[title="Conversation not kept"]')).toBeTruthy()
 for (const label of ['Hold messages at the board']) {
  const button=container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  expect(button?.disabled).toBe(true);expect(button?.title).toBe('This Team is wrapped')
 }
 const pick=async(label:string)=>{const button=[...container.querySelectorAll<HTMLButtonElement>('[data-team-page]')].find(one=>(label==='Run'?one.textContent?.startsWith(label):one.textContent===label));expect(button).toBeTruthy();act(()=>button!.click());await act(async()=>{})}
 await pick('Run');expect(container.querySelector('[data-slot="run-view"]')?.textContent).toContain('Completed review')
 await pick('Receipt');expect(container.textContent).toContain('this page shows the Team as it was then')
 memberList();act(()=>row('Writer').click());await act(async()=>{})
 expect(container.querySelector('[data-testid="conversation"]')?.textContent).toContain(String(sessionKey('codex','c1')))
})

/* A wrapped Team's receipt, as the host keeps it: every Seat that was ever retained, each with the conversation it
   had (or, on an older receipt, none). */
const receiptGoal = (seats: readonly string[], members: readonly unknown[]): GoalView => ({
 ...GOAL, goal: { ...GOAL.goal, state: 'wrapped' }, members: [],
 receipt: { version: 1, id: 'receipt', goal: ROOM, sentence: GOAL.goal.sentence, summary: 'Reviewed.', wrappedAt: 2, cards: [], seats, members, answers: [], evidence: [], lanes: [], revisions: [], citations: [], gaps: [] },
} as unknown as GoalView)

/** The rail's rows, as a person reads them. */
const railRows = (): string[] => [...memberList().querySelectorAll('[data-slot="list-row"]')].map(one => one.textContent ?? '')

/* A conversation can be seated more than once in a Team's life, and the receipt keeps every Seat. The rail lists
   conversations, so it names each one once — and does not draw two rows under one React key (#1317, round 1). */
it('a wrapped Team lists a conversation once however many Seats were retained for it', async () => {
 const goal = receiptGoal(['first', 'again', 'other'], [
  { seat: 'first', agent: 'Writer', seatLabel: 'Alpha', session: { runtime: 'codex', sessionId: 'c1' } },
  { seat: 'again', agent: 'Reviewer', seatLabel: 'Alpha again', session: { runtime: 'codex', sessionId: 'c1' } },
  { seat: 'other', agent: 'Judge', seatLabel: 'Beta', session: { runtime: 'codex', sessionId: 'c2' } },
 ])
 const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
 try {
  const { store } = rig([], undefined, { members: [] }, goal)
  await render(store)
  // The latest Seat to hold the conversation names it: `Writer` held it first and is not a second row.
  expect(railRows().filter(text => /Writer|Reviewer|Judge/.test(text))).toHaveLength(2)
  expect(railRows().some(text => text.includes('Reviewer'))).toBe(true)
  expect(railRows().some(text => text.includes('Judge'))).toBe(true)
  expect(railRows().some(text => text.includes('Writer'))).toBe(false)
  // And the roster counts conversations, as it lists them.
  expect(memberList()?.textContent).toContain('Agents2')
  expect(errors.mock.calls.map(call => String(call[0])).filter(text => text.includes('same key'))).toEqual([])
 } finally { errors.mockRestore() }
})

/* An older receipt may keep Seats without a conversation: the rail lists each as a name and says the conversation
   was not kept. It cannot also say there are no Agents — it is looking at them (#1317, round 1). */
it('an older receipt whose Seats were all kept without a conversation lists them and does not say there are none', async () => {
 const goal = receiptGoal(['lost', 'lost-too'], [
  { seat: 'lost', agent: 'Writer', seatLabel: 'Alpha' },
  { seat: 'lost-too', agent: null, seatLabel: 'Gamma' },
 ])
 const { store } = rig([], undefined, { members: [] }, goal)
 await render(store)
 const rail = memberList()!.textContent ?? ''
 expect(railRows().filter(text => /Writer|Gamma/.test(text))).toHaveLength(2)
 expect(memberList().querySelectorAll('[title="Conversation not kept"]')).toHaveLength(2)
 expect(rail).not.toContain('No Agents were kept')
})

it('a receipt that kept no Seat at all still says so', async () => {
 const { store } = rig([], undefined, { members: [] }, receiptGoal([], []))
 await render(store)
 expect(memberList()?.textContent).toContain('No Agents were kept in this Team’s receipt.')
})

/* The pane is two columns at width and one at a time without it, and `data-showing` names the one on show. A wrapped
   Team opens on its Receipt, so in a narrow pane the Receipt has to be the half that shows — whether or not the Team
   ever had a Run. A Team with no Run used to start on the Agents list, as an open one does, and a person-made Team
   that wrapped read as a list of names with the record behind a way back (#1317). `receiptGoal` is exactly that Team:
   made by a person, never given a Flow. */
const showing = (): string | null => container.querySelector('[data-team-page][aria-selected="true"]')?.getAttribute('data-team-page') ?? null
const KEPT = [{ seat: 'kept', agent: 'Writer', seatLabel: 'Alpha', session: { runtime: 'codex', sessionId: 'c1' } }]

it('a wrapped Team that never had a Run opens on its Receipt, not on the Agents list, in a narrow pane', async () => {
 const { store } = rig([], undefined, { members: [] }, receiptGoal(['kept'], KEPT))
 await render(store)
 expect(showing()).toBe(container.querySelector('[data-slot="goal-receipt"]') ? 'receipt' : 'board')
 expect(row('Receipt').getAttribute('aria-selected')).toBe('true')
 expect(container.textContent).toContain('this page shows the Team as it was then')
})

it('an open Team without a Run shows Chat at narrow widths', async () => {
 const { store } = rig([], undefined, { members: [] }, GOAL)
 await render(store)
 expect(showing()).toBe('room')
 expect(container.querySelector('aside')).toBeNull()
})

it('a Team without a Run moves from its default Chat to its Receipt when wrapped', async () => {
 const { store } = rig([], undefined, { members: [] }, GOAL)
 await render(store)
 expect(showing()).toBe('room')
 expect(container.querySelector('aside')).toBeNull()
 const open = store.getSnapshot()
 const wrapped = { ...open, goals: new Map([[ROOM, receiptGoal(['kept'], KEPT)]]) }
 Object.assign(store, { getSnapshot: () => wrapped })
 await render(store)
 expect(showing()).toBe(container.querySelector('[data-slot="goal-receipt"]') ? 'receipt' : 'board')
 expect(row('Receipt').getAttribute('aria-selected')).toBe('true')
})

it('a person who already chose where to look is not moved when a Team with no Run wraps', async () => {
 const { store } = rig([], undefined, { members: [] }, GOAL)
 await render(store)
 act(() => row('Board').click())
 await act(async () => {})
 expect(row('Board').getAttribute('aria-selected')).toBe('true')
 const open = store.getSnapshot()
 const wrapped = { ...open, goals: new Map([[ROOM, receiptGoal(['kept'], KEPT)]]) }
 Object.assign(store, { getSnapshot: () => wrapped })
 await render(store)
 expect(row('Board').getAttribute('aria-selected')).toBe('true')
 expect(showing()).toBe(container.querySelector('[data-slot="goal-receipt"]') ? 'receipt' : 'board')
})

it('a wrapped receipt has one state, a reading gutter, and a rail without moot controls', async () => {
 const { store } = rig([], undefined, { members: [] }, receiptGoal(['kept'], KEPT))
 await render(store)
 expect(container.textContent).toContain('Wrapped')
 expect(container.textContent).not.toContain('This Team is wrapped. Its receipt is kept here.')
 expect(container.querySelector('button[aria-label="Seat an Agent in this Goal"]')).toBeNull()
 expect(railRows().some(text => text.includes('Side by side'))).toBe(false)
 expect(railRows().some(text => text.includes('unclaimed'))).toBe(false)
 expect([...container.querySelectorAll('button')].some(one => one.textContent === 'Wrap')).toBe(false)
 expect(container.querySelector('[data-slot="tool-pane-header-divider"]')).toBeNull()
 expect(container.querySelector('[data-slot="goal-receipt"]')?.closest('[data-inset="reading"]')).toBeTruthy()
 expect(memberList().querySelector('[data-slot="member-done"]')).toBeNull()
 const kept = railRows().find(text => text.includes('Writer'))!
 expect(kept).not.toContain('conversation')
})

it('wrapped Agent destinations are native keyboard buttons', async () => {
 const { store } = rig([], undefined, { members: [] }, receiptGoal(['kept'], KEPT))
 await render(store)
 const kept = [...memberList().querySelectorAll<HTMLElement>('[data-slot="list-row"]')].find(one => one.textContent?.includes('Writer'))!
 expect(kept.tagName).toBe('BUTTON')
 expect(kept.tabIndex).toBe(0)
})

it('the Team frame has one content column and section tabs instead of a navigation rail', async () => {
 const {store}=rig(undefined,undefined,{},GOAL)
 await render(store)
 expect(container.querySelector('aside')).toBeNull()
 expect([...container.querySelectorAll('[role="tab"]')].map(one=>one.getAttribute('data-team-page'))).toEqual(['overview','run','board','room','findings'])
 act(()=>row('Overview').click()); await act(async()=>{})
 expect(container.querySelector('[data-slot="team-overview"]')).not.toBeNull()
 expect(container.querySelector('header [data-slot="icon-tile"]')).toBeNull()
 expect(container.querySelector('header [data-slot="avatar-stack"]')).not.toBeNull()
})

it('the bar toggle opens Seat conversations and returns to the selected page when turned off', async () => {
 const {store}=rig(undefined,undefined,{},GOAL)
 await render(store)
 const board=container.querySelector<HTMLButtonElement>('[data-team-page="board"]')!
 act(()=>board.click()); await act(async()=>{})
 const toggle=container.querySelector<HTMLButtonElement>('button[aria-label="Side by side"]')!
 expect(toggle.getAttribute('aria-pressed')).toBe('false')
 act(()=>toggle.click()); await act(async()=>{})
 expect(toggle.getAttribute('aria-pressed')).toBe('true')
 expect(container.querySelector('[data-slot="side-by-side-grid"]')).not.toBeNull()
 expect(board.getAttribute('aria-selected')).toBe('true')
 act(()=>toggle.click()); await act(async()=>{})
 expect(toggle.getAttribute('aria-pressed')).toBe('false')
 expect(container.querySelector('[data-slot="board-column"]')).not.toBeNull()
})

it('a ready Team puts its Wrap button on Overview, while the bar keeps Wrap in More', async () => {
 const {store}=rig(undefined,undefined,{},{...GOAL,activity:'ready-to-wrap'})
 await render(store)
 expect([...container.querySelectorAll('header button')].some(one=>one.textContent==='Wrap')).toBe(false)
 const overview=container.querySelector('[data-slot="team-overview"]')!
 expect([...overview.querySelectorAll('button')].some(one=>one.textContent==='Wrap')).toBe(true)
})


it('leaves every page tab unmarked while one member conversation is open', async () => {
 const {store}=rig(undefined,undefined,{},GOAL)
 await render(store)
 act(()=>row('Overview').click()); await act(async()=>{})
 const member = memberList().querySelector<HTMLElement>('[data-slot="list-row"]')!
 act(()=>member.click()); await act(async()=>{})
 expect(container.querySelector('[data-team-page][aria-selected="true"]')).toBeNull()
})

it('explains why a Team has no Run to open', async () => {
 const {store}=rig()
 await render(store)
 const run=container.querySelector<HTMLButtonElement>('[data-team-page="run"]')!
 expect(run.getAttribute('aria-disabled')).toBe('true')
 expect(run.title).toBe('This Team has no Run yet')
})

it('draws held board messages in warning ink while keeping the pressed state', async () => {
 const {store}=rig(undefined,undefined,{messaging:false},GOAL)
 await render(store)
 const hold=container.querySelector<HTMLElement>('button[aria-label="Hold messages at the board"]')!
 expect(hold.getAttribute('aria-pressed')).toBe('true')
 expect(hold.getAttribute('data-variant')).toBe('warning')
})

it('counts all retained members in the same denominator as its hover text', async () => {
 const members=[{id:'missing',session:{runtime:'codex',sessionId:'missing'},agent:{name:'Gamma'},openedAt:1,closed:null}]
 const {store}=rig(undefined,undefined,{}, {...GOAL,members:members as unknown as GoalView['members']})
 await render(store)
 const count=container.querySelector<HTMLElement>('header [data-team-members-count]')!
 expect(count).not.toBeNull()
 expect(count.textContent).toBe('3')
 expect(count.title).toBe('2 of 3 here')
})

it('keeps members without conversations in the hover denominator after wrapping',async()=>{
 const {store}=rig([],undefined,{members:[]},receiptGoal(['lost','lost-too'],[
  {seat:'lost',agent:'Writer',seatLabel:'Alpha'},
  {seat:'lost-too',agent:null,seatLabel:'Gamma'},
 ]))
 await render(store)
 const count=container.querySelector<HTMLElement>('header [data-team-members-count]')!
 expect(count.textContent).toBe('2')
 expect(count.title).toBe('0 of 2 here')
})

it('keeps the members trigger on the target floor even before any Agent is seated',async()=>{
 const {store}=rig([],undefined,{members:[]},GOAL)
 await render(store)
 const trigger=container.querySelector<HTMLElement>('header button[title="Team members"]')!
 expect(trigger.className).toContain('min-w-(--hd-target-min)')
 expect(trigger.querySelector('svg')).not.toBeNull()
})

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  sessionKey,
  wrapContext,
  type RuntimeId,
  type RuntimeInfo,
  type Session,
  type TeamEntry,
  type TeamState,
} from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { ChannelStream, nameSome, readChannel } from './Channel'

/**
 * The channel: what the board's traffic looks like once it is read rather
 * than stored.
 *
 * The host keeps every attempt, because a message that did not land is exactly
 * what this surface exists to show. What the reader needs is not that record
 * verbatim — it is the *story*: a refusal and its successful retry are one
 * thing that happened, a broadcast stored per recipient is one sentence the
 * person typed once, and three messages in a minute are one person talking.
 * Every derivation below was a real surface bug first, and each is a place a
 * future edit could quietly put the duplicate back.
 *
 * Delivery is the other half: held, refused, queued and delivered are all said
 * out loud, a held message is one press from delivered, and the envelope opens
 * the exact words the receiver saw — because the whole job of this surface is
 * that nothing about the traffic is implied.
 *
 * These lived against the Team panel, which drew the channel alongside a board
 * and a composer. The room pane draws all three now, so the panel is gone and
 * the tests point at the stream itself.
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
})

const ENVELOPE = wrapContext('Message from Codex — “API migration”', 'the exact words')

const state: TeamState = {
  id: 'room-1',
  name: 'Checkout rewrite',
  root: '/repo',
  members: [],
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
  channel: [
    {
      id: 'm1',
      at: 3,
      kind: 'message',
      from: { kind: 'agent', runtime: 'codex', sessionId: 'c1', title: 'API migration' } as never,
      to: { runtime: 'claude', sessionId: 'k1', title: 'Auth refactor' } as never,
      text: 'verifyToken moved',
      state: 'delivered',
      reason: null,
      envelope: ENVELOPE,
    },
    {
      id: 'm2',
      at: 4,
      kind: 'message',
      from: { kind: 'agent', runtime: 'codex', sessionId: 'c1', title: 'API migration' } as never,
      to: { runtime: 'claude', sessionId: 'k1', title: 'Auth refactor' } as never,
      text: 'held words',
      state: 'held',
      reason: 'The user releases held messages from the Team panel.',
      envelope: ENVELOPE,
    },
    {
      id: 's1',
      at: 5,
      kind: 'signal',
      by: { kind: 'agent', runtime: 'codex', sessionId: 'c1', title: 'API migration' } as never,
      signal: 'claimed',
      intent: 1,
      title: 'Migrate auth callers',
      detail: null,
    },
  ],
}

const rig = (over: Partial<TeamState> = {}) => {
  const codexSession = {
    id: 'c1',
    runtime: 'codex',
    title: 'API migration',
    cwd: '/repo',
    status: { type: 'idle' },
  } as unknown as Session
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    workspace: { path: '/repo', name: 'repo', lastOpenedAt: 1 },
    runtimes: [
      { id: 'codex', presentation: { name: 'Codex' } },
      { id: 'claude', presentation: { name: 'Claude Code' } },
    ] as unknown as RuntimeInfo[],
    sessions: new Map([[sessionKey('codex', 'c1'), codexSession]]),
    teams: new Map([['room-1', { ...state, ...over }]]),
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    teamDeliver: vi.fn().mockResolvedValue(undefined),
  } as unknown as AppStore
  return { store, entries: { ...state, ...over }.channel }
}

/** Mounts the stream on its own, which is all this file is about. */
const render = async (store: AppStore, entries?: readonly TeamEntry[]): Promise<void> => {
  const channel = entries ?? (store.getSnapshot().teams.get('room-1')?.channel ?? [])
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <ChannelStream entries={channel} room="room-1" onTrouble={() => {}} />
      </StoreProvider>,
    )
  })
  await act(async () => {})
}

const button = (text: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === text || entry.getAttribute('aria-label') === text,
  )
  if (!found) throw new Error(`no button labelled ${text}`)
  return found
}

it('a held message is one press from delivered', async () => {
  const { store } = rig()
  await render(store)

  act(() => button('Deliver now').click())
  expect(store.teamDeliver).toHaveBeenCalledWith('room-1', 'm2')
})

it('the envelope control opens the exact words the receiver saw', async () => {
  const { store } = rig()
  await render(store)

  expect(container.textContent).not.toContain('the exact words')
  // Named by its own visible text rather than an aria-label on a glyph: the
  // control says "Envelope", so that is what a reader and a screen reader
  // both get.
  const peek = [...container.querySelectorAll('button')].find(
    (one) => one.textContent?.trim() === 'Envelope',
  )
  if (!peek) throw new Error('no envelope button')
  act(() => peek.click())
  expect(container.textContent).toContain('the exact words')
  expect(container.textContent).toContain('Message from Codex')
})

it('a refusal followed by the same text delivered is one row, with the failure kept', async () => {
  const twice = {
    ...state,
    channel: [
      {
        id: 'r1',
        at: 10,
        kind: 'message',
        from: { kind: 'agent', runtime: 'codex', sessionId: 'c1', title: 'API migration' },
        text: 'the whole review',
        state: 'refused',
        reason: 'no conversation in this room is named “(untitled)”.',
        envelope: null,
      },
      {
        id: 'r2',
        at: 11,
        kind: 'message',
        from: { kind: 'agent', runtime: 'codex', sessionId: 'c1', title: 'API migration' },
        to: { runtime: 'claude', sessionId: 'k1', title: 'Auth refactor' },
        text: 'the whole review',
        state: 'delivered',
        reason: null,
        envelope: null,
      },
    ],
  } as unknown as TeamState
  const { store } = rig(twice)
  await render(store)

  // Said once…
  expect(container.textContent?.match(/the whole review/g)).toHaveLength(1)
  // …and the refusal is still on the record, with the host's reason.
  expect(container.textContent).toContain('First attempt refused')
  expect(container.textContent).toContain('named “(untitled)”')
})

it('a refusal with no successful retry keeps its own row', async () => {
  const refusedOnly = {
    ...state,
    channel: [
      {
        id: 'r1',
        at: 10,
        kind: 'message',
        from: { kind: 'agent', runtime: 'codex', sessionId: 'c1', title: 'API migration' },
        text: 'never landed',
        state: 'refused',
        reason: 'no conversation in this room is named “ghost”.',
        envelope: null,
      },
    ],
  } as unknown as TeamState
  const { store } = rig(refusedOnly)
  await render(store)

  expect(container.textContent).toContain('never landed')
  expect(container.textContent).toContain('refused')
  expect(container.textContent).not.toContain('First attempt refused')
})

it('a run of delivered messages from one sender groups; trouble always introduces itself', async () => {
  const run = {
    ...state,
    channel: [
      {
        id: 'g1',
        at: 100_000,
        kind: 'message',
        from: { kind: 'agent', runtime: 'codex', sessionId: 'c1', title: 'API migration' },
        text: 'first',
        state: 'delivered',
        reason: null,
        envelope: null,
      },
      {
        id: 'g2',
        at: 101_000,
        kind: 'message',
        from: { kind: 'agent', runtime: 'codex', sessionId: 'c1', title: 'API migration' },
        text: 'second',
        state: 'delivered',
        reason: null,
        envelope: null,
      },
      {
        id: 'g3',
        at: 102_000,
        kind: 'message',
        from: { kind: 'agent', runtime: 'codex', sessionId: 'c1', title: 'API migration' },
        text: 'third, and it did not land',
        state: 'refused',
        reason: 'board-only is on.',
        envelope: null,
      },
    ],
  } as unknown as TeamState
  const { store } = rig(run)
  await render(store)

  // Three bodies, one repeated header for the pair that grouped, and the
  // refused row named again because it carries a state of its own.
  expect(container.textContent).toContain('first')
  expect(container.textContent).toContain('second')
  expect(container.textContent?.match(/API migration \(Codex\)/g)).toHaveLength(2)
})

it('a broadcast stored per recipient is one row, naming everyone it reached', async () => {
  const broadcast = {
    ...state,
    channel: [
      {
        id: 'b1',
        at: 20,
        kind: 'message',
        from: { kind: 'user' },
        to: { runtime: 'codex', sessionId: 'c1', title: 'API migration' },
        text: 'ship it when green',
        state: 'delivered',
        reason: null,
        envelope: null,
      },
      {
        id: 'b2',
        at: 20,
        kind: 'message',
        from: { kind: 'user' },
        to: { runtime: 'claude', sessionId: 'k1', title: 'Auth refactor' },
        text: 'ship it when green',
        state: 'delivered',
        reason: null,
        envelope: null,
      },
    ],
  } as unknown as TeamState
  const { store } = rig(broadcast)
  await render(store)

  expect(container.textContent?.match(/ship it when green/g)).toHaveLength(1)
  expect(container.textContent).toContain('API migration, Auth refactor')
})

it('a broadcast to three with one laggard is one row, naming the laggard', async () => {
  // A sentence typed once appears once. The record holds a copy per recipient,
  // because a delivery state belongs to a delivery, but the reader typed one
  // message: repeating its words to report an outcome reads as the app having
  // sent it twice. The exception is the news, so the exception is what is
  // printed — a chip and the name it applies to.
  const mixed = {
    ...state,
    channel: [
      {
        id: 'b1', at: 20, kind: 'message', from: { kind: 'user' },
        to: { runtime: 'codex', sessionId: 'c1', nickname: 'GPT', title: 'API migration' },
        text: 'who is free?', state: 'delivered', reason: null, envelope: null,
      },
      {
        id: 'b2', at: 20, kind: 'message', from: { kind: 'user' },
        to: { runtime: 'claude', sessionId: 'k1', nickname: 'Haiku', title: 'Auth refactor' },
        text: 'who is free?', state: 'queued', reason: null, envelope: null,
      },
      {
        id: 'b3', at: 20, kind: 'message', from: { kind: 'user' },
        to: { runtime: 'cursor', sessionId: 'g1', nickname: 'Gemini', title: 'Totals' },
        text: 'who is free?', state: 'delivered', reason: null, envelope: null,
      },
    ],
  } as unknown as TeamState
  const { store } = rig(mixed)
  await render(store)

  // Once. Not once per recipient, and not once per outcome.
  expect(container.textContent?.match(/who is free\?/g)).toHaveLength(1)
  // Everyone it went to is in the header, in the order the host stored them.
  expect(container.textContent).toContain('GPT, Haiku, Gemini')
  // And the one it has not reached yet is named, with what became of it.
  expect(container.textContent).toContain('queued')
  const chips = [...container.querySelectorAll('*')].filter(
    (el) => el.textContent?.trim() === 'queued',
  )
  expect(chips.length).toBeGreaterThan(0)
})

it('a broadcast that half landed is one row, and says which half', async () => {
  const split = {
    ...state,
    channel: [
      {
        id: 'b1',
        at: 20,
        kind: 'message',
        from: { kind: 'user' },
        to: { runtime: 'codex', sessionId: 'c1', title: 'API migration' },
        text: 'ship it when green',
        state: 'delivered',
        reason: null,
        envelope: null,
      },
      {
        id: 'b2',
        at: 20,
        kind: 'message',
        from: { kind: 'user' },
        to: { runtime: 'claude', sessionId: 'k1', title: 'Auth refactor' },
        text: 'ship it when green',
        state: 'refused',
        reason: 'that conversation closed.',
        envelope: null,
      },
    ],
  } as unknown as TeamState
  const { store } = rig(split)
  await render(store)

  // The words once; the failure named. Both recipients are in the header, and
  // the one that refused is called out under it with the host's reason.
  expect(container.textContent?.match(/ship it when green/g)).toHaveLength(1)
  expect(container.textContent).toContain('API migration, Auth refactor')
  expect(container.textContent).toContain('refused')
  expect(container.textContent).toContain('Auth refactor')
})

/**
 * Agents write markdown, so the channel reads it.
 *
 * Every agent in a room writes the same way it writes in its own transcript:
 * bold for the file under discussion, backticks for an identifier, a list of
 * findings, a fence around the command it ran, a quote of what the board
 * answered. Printed as plain text, a real review read `**limiter.js:**` and a
 * claim read as a wall of asterisks — the agents' output looking worse in the
 * room than in the transcript two panes over.
 */
it('renders what agents actually write: bold, code, lists, fences, quotes', async () => {
  const written = [
    '**src/limiter.js**: refill multiplies by `perSecond` without dividing by 1000.',
    '',
    '- one finding',
    '- another finding',
    '',
    '```bash',
    'node --test test/totals.test.js',
    '```',
    '',
    '> Refused: #2 is already claimed by Gemini.',
  ].join('\n')
  const { store } = rig({
    channel: [
      {
        id: 'm1', at: 20, kind: 'message',
        from: { kind: 'agent', runtime: 'codex', sessionId: 'c1', title: 'API migration', nickname: 'GPT' },
        to: null, text: written, state: 'shown', reason: null, envelope: null,
      },
    ] as unknown as readonly TeamEntry[],
  })
  await render(store)

  // The markup is markup, not characters on screen.
  expect(container.querySelector('strong')?.textContent).toBe('src/limiter.js')
  expect(container.querySelectorAll('li')).toHaveLength(2)
  expect(container.querySelector('pre code')?.textContent).toContain('node --test')
  expect(container.querySelector('blockquote')?.textContent).toContain('already claimed')
  expect([...container.querySelectorAll('code')].some((el) => el.textContent === 'perSecond')).toBe(true)
  // And the source characters are gone from the reading.
  expect(container.textContent).not.toContain('**')
  expect(container.textContent).not.toContain('```')
})
it('keeps two refusals apart when they were refused for different reasons', async () => {
  // `state` is not the whole outcome. Keying the grouping on it alone put two
  // refusals under one chip and dropped the second reason — removing exactly
  // the actionable difference this surface exists to preserve.
  const split = {
    ...state,
    channel: [
      {
        id: 'r1', at: 20, kind: 'message', from: { kind: 'user' },
        to: { runtime: 'codex', sessionId: 'c1', nickname: 'GPT', title: 'API migration' },
        text: 'ship it', state: 'delivered', reason: null, envelope: null,
      },
      {
        id: 'r2', at: 20, kind: 'message', from: { kind: 'user' },
        to: { runtime: 'claude', sessionId: 'k1', nickname: 'Haiku', title: 'Auth refactor' },
        text: 'ship it', state: 'refused', reason: 'the conversation had closed', envelope: null,
      },
      {
        id: 'r3', at: 20, kind: 'message', from: { kind: 'user' },
        to: { runtime: 'cursor', sessionId: 'g1', nickname: 'Gemini', title: 'Totals' },
        text: 'ship it', state: 'refused', reason: 'the agent stopped before it was read', envelope: null,
      },
    ],
  } as unknown as TeamState
  const { store } = rig(split)
  await render(store)

  // Still one sentence...
  expect(container.textContent?.match(/ship it/g)).toHaveLength(1)
  // ...but both reasons survive, each against the member it happened to.
  expect(container.textContent).toContain('the conversation had closed')
  expect(container.textContent).toContain('the agent stopped before it was read')
  expect(container.textContent).toContain('Haiku')
  expect(container.textContent).toContain('Gemini')
})

/**
 * A run is one sender speaking to one audience.
 *
 * Found by a room of 138 members each handed its own page: the addressed posts
 * went out a second apart from the same sender, so every one after the first
 * joined the run and lost its header — and the header is the only place the
 * recipient is named. The channel read as one wall of near-identical text with
 * no way to tell which member any paragraph was for.
 */
const AT = 1_700_000_000_000
const member = (n: number) => ({ runtime: 'cursor' as RuntimeId, sessionId: `s${n}`, title: `/page-${n}`, nickname: `Gemini ${n}` })
const post = (id: string, text: string, to: ReturnType<typeof member> | null, offset = 0): TeamEntry => ({
  id,
  at: AT + offset,
  kind: 'message',
  from: { kind: 'user' },
  to,
  text,
  state: 'delivered',
})
const runs = (entries: readonly TeamEntry[]) =>
  readChannel(entries).flatMap((row) => (row.kind === 'message' ? [`${row.entry.id}:${row.grouped ? 'grouped' : 'introduced'}`] : []))

it('an addressed post introduces its recipient even inside a run of the same sender', () => {
  expect(runs([post('a', 'Audit /about', member(1), 0), post('b', 'Audit /admin', member(2), 1000), post('c', 'Audit /blog', member(3), 2000)]))
    .toEqual(['a:introduced', 'b:introduced', 'c:introduced'])
})

it('two posts to the same member still read as one run', () => {
  expect(runs([post('a', 'Start with the header', member(1), 0), post('b', 'Then the footer', member(1), 1000)]))
    .toEqual(['a:introduced', 'b:grouped'])
})

it('posts to everyone still group, and one to a member after them starts afresh', () => {
  expect(runs([
    post('a', 'Morning, all', null, 0),
    post('b', 'Stand-up in five', null, 1000),
    post('c', 'You take the limiter', member(4), 2000),
    post('d', 'Thanks, everyone', null, 3000),
  ])).toEqual(['a:introduced', 'b:grouped', 'c:introduced', 'd:introduced'])
})

it('a hand-out stored per member is one row, showing the template and naming everyone', async () => {
  const batch = { id: 'hb-1', size: 2, template: 'Take card #{{card}} — {{title}}.' }
  const handout = {
    ...state,
    channel: [
      {
        id: 'h1',
        at: 30,
        kind: 'message',
        from: { kind: 'user' },
        to: { runtime: 'codex', sessionId: 'c1', title: 'API migration' },
        text: 'Take card #1 — Audit /about.',
        state: 'delivered',
        reason: null,
        envelope: null,
        batch,
      },
      {
        id: 'h2',
        at: 30,
        kind: 'message',
        from: { kind: 'user' },
        to: { runtime: 'claude', sessionId: 'k1', title: 'Auth refactor' },
        text: 'Take card #2 — Audit /admin.',
        state: 'delivered',
        reason: null,
        envelope: null,
        batch,
      },
    ],
  } as unknown as TeamState
  const { store } = rig(handout)
  await render(store)

  // Two members, two different sentences, one row: the template is what was
  // said, and the names are who it reached.
  expect(container.textContent).toContain('Take card #{{card}} — {{title}}.')
  expect(container.textContent).not.toContain('Take card #1')
  expect(container.textContent).toContain('API migration, Auth refactor')
})

it('a fan-out to many names three and counts the rest', () => {
  expect(nameSome(['Gemini', 'Gemini 2'])).toBe('Gemini, Gemini 2')
  expect(nameSome(['a', 'b', 'c', 'd'])).toBe('a, b, c, d')
  expect(nameSome(Array.from({ length: 138 }, (_, n) => (n === 0 ? 'Gemini' : `Gemini ${n + 1}`)))).toBe(
    'Gemini, Gemini 2, Gemini 3 and 135 more',
  )
})

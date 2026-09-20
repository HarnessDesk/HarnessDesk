import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  sessionKey,
  type BoardEvidence,
  type RuntimeInfo,
  type Session,
  type TeamState,
} from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { dismissOverlays } from '../design'
import { cardEvidence, checkView, ciView, PREVIEW_UNSEEN, prView } from '../preview/evidence-fixture'
import { ARM_MS } from './RunCheck'
import { TeamBoardPane } from './TeamBoardPane'

/**
 * The board.
 *
 * The referee's verbs used to live on the Team panel's list, and the panel is
 * gone — so they are pinned here, where they moved to. **The user's word is
 * final over any claim**: `release` takes work back off an agent, `done` and
 * `abandon` settle it, `reopen` puts it back in play, and each of them reaches
 * the host with the intent it names.
 *
 * `abandon` is here because merging the panel away would otherwise have lost
 * it. A board with only `Done` makes the reader lie to it to clear a card, and
 * "we are not doing this" is a different fact about the work than "this is
 * finished" — the kind of difference a board exists to keep.
 *
 * And the edge that makes this a board rather than a chart: a claimed card
 * names the conversation holding it, and pressing that opens exactly it.
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

const intent = (over: Record<string, unknown>) =>
  ({
    id: 1,
    title: 'Migrate auth callers',
    detail: null,
    state: 'open',
    files: ['src/api/**'],
    dependsOn: [],
    claim: null,
    blockedReason: null,
    handoff: null,
    note: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }) as never

const ROOM = 'room-1'

const state = (intents: readonly unknown[], extra: Partial<TeamState> = {}): TeamState =>
  ({
    id: ROOM,
    name: 'Checkout rewrite',
    root: '/repo',
    members: [sessionKey('codex', 'c1')],
    messaging: true,
    intents,
    channel: [],
    ...extra,
  }) as unknown as TeamState

/* `extra` carries the parts of the board state a test needs to vary — the
   nicknames, so far, because who holds a card is a property of the board and
   there is no other way to write that case. */
const rig = (intents: readonly unknown[], extra: Partial<TeamState> = {}, evidence?: BoardEvidence) => {
  /* `turns` and `itemsLoaded` are not decoration: every real session carries
     them, and anything reading a transcript — `isBusy`, `currentTurn` — reads
     `turns` without asking. A fixture that leaves them out passes until the
     first component that looks. */
  const held = {
    id: 'c1',
    runtime: 'codex',
    title: 'API migration',
    cwd: '/repo',
    status: { type: 'idle' },
    createdAt: 1,
    updatedAt: 1,
    turns: [],
    itemsLoaded: true,
  } as unknown as Session
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    workspace: { path: '/repo', name: 'repo', lastOpenedAt: 1 },
    /* `capabilities` is on every runtime the host sends; leaving it off makes
       a fixture that answers `undefined` to a question no real runtime can. */
    runtimes: [
      { id: 'codex', presentation: { name: 'Codex' }, capabilities: {} },
    ] as unknown as RuntimeInfo[],
    sessions: new Map([[sessionKey('codex', 'c1'), held]]),
    teams: new Map([[ROOM, state(intents, extra)]]),
    boardEvidence: new Map(evidence ? [[ROOM, evidence]] : []),
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    teamAdd: vi.fn().mockResolvedValue(undefined),
    teamIntent: vi.fn().mockResolvedValue(undefined),
    teamPost: vi.fn().mockResolvedValue(undefined),
    /* Asked for by the add dialog, whose last field can put a message in front
       of one member. Two here, so the "ask somebody" case has somebody. */
    teamPeers: vi.fn().mockResolvedValue([
      { runtime: 'codex', sessionId: 'c1', title: 'API migration', agent: 'Codex', nickname: 'Alpha', busy: false, here: true },
    ]),
    openSession: vi.fn().mockResolvedValue(undefined),
    /* A board with no flow, which is what every test in this file is about:
       no card carries a role, nothing here holds one, and the pane behaves
       exactly as it did before flows existed. */
    loadFlowRuns: vi.fn().mockResolvedValue(undefined),
    loadBoardEvidence: vi.fn().mockResolvedValue(undefined),
    runCheck: vi.fn().mockResolvedValue({ kind: 'started' }),
  } as unknown as AppStore
  return { store, snapshot }
}

const render = async (store: AppStore): Promise<void> => {
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <TeamBoardPane room={ROOM} />
      </StoreProvider>,
    )
  })
  await act(async () => {})
}

const button = (text: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === text,
  )
  if (!found) throw new Error(`no button labelled ${text}`)
  return found
}

it('columns are what is known about the work, so no card has to repeat its own', async () => {
  const { store } = rig([
    intent({ id: 1, state: 'open' }),
    intent({ id: 2, state: 'claimed', title: 'Integration tests' }),
  ])
  await render(store)

  expect([...container.querySelectorAll('[data-slot="board-column"] h3')].map((one) => one.textContent)).toEqual([
    'To do',
    'Working',
    'Needs you',
    'In review',
    'Ready',
  ])
  expect(column('To do').textContent).toContain('#1')
  expect(column('Working').textContent).toContain('Integration tests')
  expect(container.textContent).toContain('src/api/**')
})

/**
 * The verbs, as the rebuild reaches them.
 *
 * They used to be three ghost buttons across the foot of every card, which
 * spent the width the title needed and named all four actions whether or not
 * they applied. They are one menu now — so these open it, which is also the
 * proof that a keyboard can still reach every verb a drag performs.
 */
const menuItems = async (id: number): Promise<HTMLElement[]> => {
  const trigger = container.querySelector<HTMLButtonElement>(
    `button[aria-label="What to do with #${id}"]`,
  )
  if (!trigger) throw new Error(`no menu on #${id}`)
  /* A native button activated with Enter emits a click after keydown. jsdom
     does not synthesize that browser default, so deliver both parts of the
     keyboard activation sequence that Base UI receives in Chromium. */
  act(() => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    trigger.click()
  })
  await act(async () => {})
  /* Portalled, so the menu is in the document and not in the mount. */
  return [...document.querySelectorAll('[data-slot="dropdown-menu-item"]')] as HTMLElement[]
}

const pick = async (id: number, label: string): Promise<void> => {
  const items = await menuItems(id)
  const found = items.find((one) => one.textContent?.includes(label))
  if (!found) {
    throw new Error(
      `no menu item like “${label}” on #${id}; saw ${items.map((one) => one.textContent).join(' | ')}`,
    )
  }
  act(() => found.click())
  await act(async () => {})
}

/* jsdom has no `DragEvent`, so the transfer object is supplied. What is being
   tested is the pane's rules about where a card may land, not the browser's
   drag implementation. */
const drag = (type: string): Event => {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: { setData: () => {}, dropEffect: '', effectAllowed: '' },
  })
  return event
}

const card = (title: string): HTMLElement => {
  const found = [...container.querySelectorAll('[data-slot="board-card"]')].find((one) =>
    one.textContent?.includes(title),
  )
  if (!found) throw new Error(`no card for ${title}`)
  return found as HTMLElement
}

const column = (name: string): HTMLElement => {
  const found = [...container.querySelectorAll('[data-slot="board-column"]')].find((one) =>
    one.querySelector('h3')?.textContent?.trim().startsWith(name),
  )
  if (!found) throw new Error(`no column named ${name}`)
  return found as HTMLElement
}

it('the referee wins: release on a claimed intent reaches the host', async () => {
  const { store } = rig([
    intent({ state: 'claimed', claim: { runtime: 'codex', sessionId: 'c1', at: 1 } }),
  ])
  await render(store)

  await pick(1, 'Take it back off')
  expect(store.teamIntent).toHaveBeenCalledWith(ROOM, 1, 'release')
})

it('abandoning is offered, and is not the same act as finishing', async () => {
  const { store } = rig([intent({ state: 'open' })])
  await render(store)

  await pick(1, 'Abandon')
  expect(store.teamIntent).toHaveBeenCalledWith(ROOM, 1, 'abandon')

  await pick(1, 'Mark done')
  expect(store.teamIntent).toHaveBeenLastCalledWith(ROOM, 1, 'done')
})

it('settled work can be put back in play', async () => {
  const { store } = rig([intent({ state: 'done' })])
  await render(store)

  await pick(1, 'Put back in play')
  expect(store.teamIntent).toHaveBeenCalledWith(ROOM, 1, 'reopen')
})

it('what a drop did is in the card’s menu: done, and taking work back off its holder', async () => {
  const { store } = rig([
    intent({ id: 1, state: 'open' }),
    intent({ id: 2, state: 'claimed', title: 'Round the totals', claim: { runtime: 'codex', sessionId: 'c1', at: 1 } }),
  ])
  await render(store)
  await pick(1, 'Mark done')
  expect(store.teamIntent).toHaveBeenCalledWith(ROOM, 1, 'done')
  await pick(2, 'Take it back off')
  expect(store.teamIntent).toHaveBeenLastCalledWith(ROOM, 2, 'release')
})

/**
 * Stopping work, and the question the drop asks first.
 *
 * The Blocked column existed before the user had any way to put anything in
 * it: `release(blocked)` belongs to whoever holds the claim, so a person who
 * knew a job should not be worked could only abandon it — a different sentence,
 * and a permanent one.
 *
 * The reason is asked for rather than hoped for, because a card in Blocked
 * that does not say what stopped it sends the next reader to the channel, which
 * is the trip the board exists to save.
 */
it('stopping a card asks why before it stops anything', async () => {
  const { store } = rig([intent({ state: 'open' })])
  await render(store)

  await pick(1, 'Stop it — say why')
  await act(async () => {})

  // Nothing has happened yet — the question is the point.
  expect(store.teamIntent).not.toHaveBeenCalled()
  const why = document.querySelector<HTMLInputElement>('input[aria-label="Why it is stopped"]')
  if (!why) throw new Error('nobody was asked why')
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      why,
      'waiting on the rename',
    )
    why.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const stop = [...document.querySelectorAll('button')].find(
    (one) => one.textContent?.trim() === 'Stop it',
  )
  act(() => stop?.click())
  await act(async () => {})

  expect(store.teamIntent).toHaveBeenCalledWith(ROOM, 1, 'block', 'waiting on the rename')
})

it('cancelling the question leaves the card where it was', async () => {
  const { store } = rig([intent({ state: 'open' })])
  await render(store)

  await pick(1, 'Stop it — say why')

  const cancel = [...document.querySelectorAll('button')].find(
    (one) => one.textContent?.trim() === 'Cancel',
  )
  act(() => cancel?.click())
  await act(async () => {})

  expect(store.teamIntent).not.toHaveBeenCalled()
  expect(document.querySelector('input[aria-label="Why it is stopped"]')).toBeNull()
  expect(column('To do').textContent).toContain('Migrate auth callers')
})

it('offers the same stop from the card’s own menu', async () => {
  const { store } = rig([intent({ state: 'open' })])
  await render(store)

  await pick(1, 'Stop it — say why')
  expect(document.querySelector('input[aria-label="Why it is stopped"]')).not.toBeNull()
  expect(store.teamIntent).not.toHaveBeenCalled()
})

/**
 * Adding work, asking for what work actually has.
 *
 * The field this replaces took a title and nothing else, so `files` — the
 * patterns a claim owns, and therefore the entire reason two agents can work
 * one repository without fighting — could only ever be set by an agent calling
 * `add_intent`. The person who knows which directory a job lives in is usually
 * the person adding it.
 */
/**
 * Two doors, and the small one is the common one.
 *
 * A title typed into the header and pressed once is how most work goes up, and
 * that path must not get slower because a longer one exists beside it.
 */
/**
 * The long form, and everything that opens it.
 *
 * The dialog's own behaviour is pinned in AddWork.test.tsx; what the pane owes
 * it is the roster it needs for the field that can ask somebody to take the
 * job, and a door that is a button rather than an ellipsis hidden inside a
 * text field. There are two, and they are the two states of the same screen —
 * the header's while there is work, the empty board's while there is not.
 */
it('opens the long form from the header, and hands it who is in the room', async () => {
  const { store } = rig([intent({})])
  await render(store)

  const door = [...container.querySelectorAll('button')].find((one) =>
    one.textContent?.trim() === 'New job',
  )
  if (!door) throw new Error('no way to the long form')

  /* WCAG 2.5.3, Label in Name: the accessible name has to *contain* the
     visible one, or "click New job" reaches nothing. The label is hidden by a
     container query below 26rem and the glyph carries the button alone, so it
     needs an `aria-label` — and the first one replaced the visible label
     instead of leading with it. */
  expect(door.getAttribute('aria-label')).toContain(door.textContent?.trim())

  /* And the glyph, which is the half a test can otherwise never see: jsdom
     evaluates no container query, so the `@[26rem]/board` that hides the label
     in a narrow pane never fires here. Without an icon the button would be an
     empty rectangle at that width and every assertion above would still
     pass. */
  expect(door.querySelector('svg'), 'the button has no glyph to fall back on').not.toBeNull()

  act(() => door.click())
  await act(async () => {})

  expect(document.body.textContent).toContain('Files it will own')
  expect(store.teamPeers).toHaveBeenCalledWith(ROOM)
  // The roster is what makes "ask somebody to pick it up" a real choice.
  expect(document.body.textContent).toContain('Alpha')
})

it('offers the same long form from an empty board', async () => {
  const { store } = rig([])
  await render(store)

  const door = [...container.querySelectorAll('button')].find(
    (one) => one.textContent?.trim() === 'Add the first job',
  )
  if (!door) throw new Error('an empty board offers no way to start')
  act(() => door.click())
  await act(async () => {})
  expect(document.body.textContent).toContain('Files it will own')
})

/**
 * The quick path is a shortcut and never a mode.
 *
 * It opens from one click, so it has to close from one key — otherwise a
 * person who pressed it to see what it was is left with a field they have to
 * work out how to leave.
 */

it('the claiming harness is pressable straight through to its conversation', async () => {
  const { store } = rig([
    intent({ state: 'claimed', claim: { runtime: 'codex', sessionId: 'c1', at: 1 } }),
  ])
  await render(store)

  const holder = [...container.querySelectorAll('button')].find((one) =>
    one.textContent?.includes('API migration'),
  )
  if (!holder) throw new Error('no holder control')
  act(() => holder.click())
  expect(store.openSession).toHaveBeenCalledWith('c1', { runtime: 'codex' })
})

/**
 * The holder answers to its name, as it does to its face.
 *
 * The face was the whole trigger, and the name beside it — the part a reader
 * actually rests on — opened nothing.
 */
it('opens the holder’s card from its name as well as its face', async () => {
  vi.useFakeTimers()
  const { store } = rig(
    [intent({ state: 'claimed', claim: { runtime: 'codex', sessionId: 'c1', at: 1 } })],
    { nicknames: { [sessionKey('codex', 'c1')]: 'Gemini' } },
  )
  await render(store)

  const holder = [...container.querySelectorAll('button')].find((one) =>
    one.textContent?.includes('Gemini'),
  )
  const name = [...(holder?.querySelectorAll('span') ?? [])].find(
    (one) => one.textContent === 'Gemini',
  )
  if (!name) throw new Error('no holder name to rest on')
  act(() => {
    name.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
    name.closest('[data-slot="hover-card-trigger"]')?.dispatchEvent(new MouseEvent('mouseenter'))
  })
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  expect(document.querySelector('[data-slot="agent-card"]')?.textContent).toContain('API migration')
  vi.useRealTimers()
})

/**
 * The holder button says where it goes once.
 *
 * Its tooltip and the card on its names answer the same rest. With the
 * conversation loaded, the card says who holds this and opens it, so the
 * sentence becomes the description a screen reader reads; with nothing loaded
 * there is no card, and it stays the tooltip.
 */
it('says where the holder goes once: on the card when the conversation is loaded, as a tooltip when it is not', async () => {
  const { store } = rig([
    intent({ state: 'claimed', claim: { runtime: 'codex', sessionId: 'c1', at: 1 } }),
    intent({ id: 2, title: 'Cap the backoff', state: 'claimed', claim: { runtime: 'codex', sessionId: 'c9', at: 1 } }),
  ])
  await render(store)

  const holders = [...container.querySelectorAll('button')].filter((one) =>
    (one.getAttribute('title') ?? one.getAttribute('aria-description') ?? '').startsWith('Open the conversation'),
  )
  expect(holders).toHaveLength(2)
  const loaded = holders.find((one) => one.textContent?.includes('API migration'))
  const unloaded = holders.find((one) => one !== loaded)
  expect(loaded?.getAttribute('title')).toBeNull()
  expect(loaded?.getAttribute('aria-description')).toMatch(/^Open the conversation /)
  expect(unloaded?.getAttribute('title')).toMatch(/^Open the conversation /)
  expect(unloaded?.hasAttribute('aria-description')).toBe(false)
})

/**
 * Nothing inside the holder says it again.
 *
 * The conversation's title beside the holder's name is drawn inside the card's
 * trigger, and the card's heading is that same title — so a tooltip of its own
 * on the title is a second box on the same rest, the thing the button's own
 * sentence stopped being. A name is given here, so the title is drawn beside it.
 */
it('draws the conversation’s title beside the holder without a tooltip of its own while a card can show', async () => {
  const { store } = rig(
    [intent({ state: 'claimed', claim: { runtime: 'codex', sessionId: 'c1', at: 1 } })],
    { nicknames: { [sessionKey('codex', 'c1')]: 'Gemini' } },
  )
  await render(store)

  const holder = [...container.querySelectorAll('button')].find((one) => one.textContent?.includes('Gemini'))
  if (!holder) throw new Error('no holder control')
  // The control: the title is drawn, beside the name.
  expect([...holder.querySelectorAll('span')].some((one) => one.textContent === 'API migration')).toBe(true)
  const tooltips = [holder, ...holder.querySelectorAll('*')].filter((one) => one.hasAttribute('title'))
  expect(tooltips.map((one) => one.getAttribute('title'))).toEqual([])
})

it('separates work waiting on its dependencies from work somebody stopped', async () => {
  const waiting = {
    id: 1,
    title: 'Review the rounding change',
    state: 'blocked',
    blockedBy: 'graph',
    files: [],
    dependsOn: [2],
    createdAt: 0,
    updatedAt: 0,
  }
  const stopped = {
    id: 2,
    title: 'Migrate the pricing table',
    state: 'blocked',
    blockedBy: 'hand',
    blockedReason: 'needs a staging dump first',
    files: [],
    dependsOn: [],
    createdAt: 0,
    updatedAt: 0,
  }
  const { store } = rig([waiting, stopped] as never)
  await render(store)

  expect(column('To do').textContent).toContain('Review the rounding change')
  expect(column('To do').textContent).not.toContain('Migrate the pricing table')
  expect(column('Needs you').textContent).toContain('Migrate the pricing table')
  expect(column('Needs you').textContent).not.toContain('Review the rounding change')
})

/**
 * A card does not repeat its own state.
 *
 * The board's whole claim over a list is that the column says the state, so
 * nothing on the card has to. `blocked` was a chip as well as a column, which
 * was merely redundant until Waiting became a column of its own — then the chip
 * sat inside Waiting saying "blocked", contradicting the heading above it.
 *
 * `abandoned` stays a chip, and is the one thing that should: it shares the
 * Done column with work that actually finished, and the difference is the news.
 */
it('says what the column cannot: why a card needs you — and work set aside needs no chip to say so', async () => {
  const { store } = rig([
    intent({ id: 1, state: 'blocked', blockedBy: 'graph', title: 'Waits on the graph' }),
    intent({ id: 2, state: 'blocked', blockedBy: 'hand', title: 'Somebody stopped it' }),
    intent({ id: 3, state: 'abandoned', title: 'Given up on' }),
  ] as never)
  await render(store)

  expect(column('To do').textContent).toContain('Waits on the graph')
  expect(column('To do').textContent).not.toContain('blocked')
  expect(column('Needs you').textContent).toContain('Somebody stopped it')
  expect(column('Needs you').textContent).toContain('stopped')
  expect(column('Set aside').textContent).toContain('Given up on')
  expect(card('Given up on').textContent).not.toContain('abandoned')
})

/**
 * A stranded claim looks stranded.
 *
 * The card stays in Claimed, because on paper the work still has an owner —
 * and the whole point is that the paper has gone stale. Moving it out would
 * hide the one thing worth seeing: the difference between "somebody is on it"
 * and "somebody was".
 */
it('a claim that has run out needs you, and says how long', async () => {
  const stale = intent({
    id: 1,
    state: 'claimed',
    title: 'Migrate the callers',
    claim: { runtime: 'codex', sessionId: 'gone', at: 1, leaseUntil: Date.now() - 3 * 60 * 60 * 1000 },
  })
  const live = intent({
    id: 2,
    state: 'claimed',
    title: 'Round the totals',
    claim: { runtime: 'codex', sessionId: 'c1', at: 1, leaseUntil: Date.now() + 60 * 60 * 1000 },
  })
  const { store } = rig([stale, live] as never)
  await render(store)

  expect(column('Needs you').textContent).toContain('Migrate the callers')
  expect(column('Needs you').textContent).toContain('stranded 3h')
  expect(column('Working').textContent).toContain('Round the totals')
  expect(container.textContent?.match(/stranded/g) ?? []).toHaveLength(1)
})

/**
 * "Stranded" means the work can be taken over, so it has to mean what the host
 * means by it.
 *
 * The host's rule is two facts: the lease is in the past **and** the holder is
 * no longer a live peer. Reading the clock alone put the chip on every card
 * whose agent was simply mid-thought past the deadline, while the server went
 * on refusing the takeover the chip had just advertised.
 */
it('does not call a claim stranded while its holder is still here', async () => {
  const overdue = intent({
    id: 1,
    state: 'claimed',
    title: 'Migrate the callers',
    // Two hours past its lease, and its holder is in the room.
    claim: { runtime: 'codex', sessionId: 'c1', at: 1, leaseUntil: Date.now() - 2 * 60 * 60 * 1000 },
  })
  const { store } = rig([overdue] as never)
  await render(store)

  expect(container.textContent).toContain('Migrate the callers')
  expect(container.textContent).not.toContain('stranded')
})

/**
 * Being in the room is not being here, and only one of the two is the host's
 * test for a stranded claim.
 *
 * The roster answers with every member now, open or not — so a chip that read
 * membership would call an overdue claim held by a member nobody has opened
 * "still here", and the takeover the board refuses to advertise is one the
 * host would allow. The direction that matters: the chip must appear.
 */
it('calls a claim stranded when its holder is a member the desk does not have open', async () => {
  const overdue = intent({
    id: 1,
    state: 'claimed',
    title: 'Migrate the callers',
    claim: { runtime: 'codex', sessionId: 'c1', at: 1, leaseUntil: Date.now() - 2 * 60 * 60 * 1000 },
  })
  const { store } = rig([overdue] as never)
  ;(store.teamPeers as ReturnType<typeof vi.fn>).mockResolvedValue([
    { runtime: 'codex', sessionId: 'c1', title: 'API migration', agent: 'Codex', nickname: 'Alpha', busy: false, here: false },
  ])
  await render(store)

  expect(container.textContent).toContain('stranded')
})

/**
 * A failed request is not an answer.
 *
 * The first version of the fix above caught the rejection and wrote `[]`,
 * which is the same mistake one level down: an empty roster reads as "nobody
 * is here", so a poll that failed while the holder was very much alive put
 * "stranded" back on the card and advertised a takeover the host still
 * refuses.
 */
it('does not read a failed roster request as an empty room', async () => {
  const overdue = intent({
    id: 1,
    state: 'claimed',
    title: 'Migrate the callers',
    claim: { runtime: 'codex', sessionId: 'c1', at: 1, leaseUntil: Date.now() - 2 * 60 * 60 * 1000 },
  })
  const { store } = rig([overdue] as never)
  ;(store.teamPeers as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('the host is gone'))
  await render(store)

  expect(container.textContent).toContain('Migrate the callers')
  expect(container.textContent).not.toContain('stranded')
})

it('says nothing about stranding until the host has said who is here', async () => {
  const overdue = intent({
    id: 1,
    state: 'claimed',
    title: 'Migrate the callers',
    claim: { runtime: 'codex', sessionId: 'gone', at: 1, leaseUntil: Date.now() - 2 * 60 * 60 * 1000 },
  })
  const { store } = rig([overdue] as never)
  // The roster never answers. An empty list would be read as "nobody is here",
  // which is the one reading that makes every lapsed lease look abandonable.
  ;(store.teamPeers as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}))
  await render(store)

  expect(container.textContent).toContain('Migrate the callers')
  expect(container.textContent).not.toContain('stranded')
})

/**
 * A card names its holder the way the room does.
 *
 * The cover read the conversation's own title and fell back to "(untitled)" —
 * which is what an ACP conversation always is until its agent names it. So a
 * live Cursor agent that had just claimed a job appeared on the card as
 * "(untitled) Cursor", in the one place the board most needs to say who.
 */
it('shows the holder by its room name, not by a title it may not have', async () => {
  const held = intent({
    id: 1,
    state: 'claimed',
    title: 'Define the tax contract',
    claim: { runtime: 'codex', sessionId: 'c1', at: 1 },
  })
  const { store } = rig([held] as never, {
    nicknames: { ['codex\u0000c1']: 'Gemini' },
  })
  await render(store)

  expect(container.textContent).toContain('Gemini')
  expect(container.textContent).not.toContain('(untitled)')
})

/**
 * A goal can be finished; a Room cannot.
 *
 * The band above the work is the only line on the board that can ever say
 * "done" — and the refusal, when something is still live, is read there rather
 * than thrown away, because it is an answer the person needs.
 */
it('offers to wrap a goal only when nothing on it is still live', async () => {
  const live = intent({ id: 1, state: 'claimed', title: 'In progress', plan: 1 })
  const settled = intent({ id: 2, state: 'done', title: 'Finished', plan: 1 })
  const { store } = rig([live, settled] as never, {
    plans: [{ id: 1, goal: 'Round half-up to whole cents', state: 'running', createdAt: 0 }],
  } as never)
  await render(store)

  expect(container.textContent).toContain('Round half-up to whole cents')
  expect(container.textContent).toContain('1 live')
  const wrap = [...container.querySelectorAll('button')].find(
    (one) => one.textContent === 'Wrap up',
  )
  expect(wrap?.disabled).toBe(true)
})

it('a goal with nothing live says so, and the button works', async () => {
  const settled = intent({ id: 1, state: 'done', title: 'Finished', plan: 1 })
  const { store } = rig([settled] as never, {
    plans: [{ id: 1, goal: 'Ship the migration', state: 'running', createdAt: 0 }],
  } as never)
  await render(store)

  expect(container.textContent).toContain('all done')
  const wrap = [...container.querySelectorAll('button')].find(
    (one) => one.textContent === 'Wrap up',
  )
  expect(wrap?.disabled).toBe(false)
})

it('a wrapped goal leaves the band, and its work stays on the board', async () => {
  const settled = intent({ id: 1, state: 'done', title: 'Finished', plan: 1 })
  const { store } = rig([settled] as never, {
    plans: [{ id: 1, goal: 'Already put away', state: 'wrapped', createdAt: 0, wrappedAt: 1 }],
  } as never)
  await render(store)

  // The heading has said what it had to say; a band that grew forever would
  // push the work off the screen.
  expect(container.textContent).not.toContain('Already put away')
  // The record does not go anywhere.
  expect(container.textContent).toContain('Finished')
})

/**
 * A card's menu is a floating panel, and it owes what every floating panel owes:
 * it goes when something takes the screen (#214).
 *
 * It is drawn at `--hd-z-popover`, above the modal layer — as a menu opened
 * *inside* Settings has to be — and it is modal in its own right, with a focus
 * scope. Left open over the Settings window, the Usage window or a sidebar
 * floating over a narrow window, it covered a surface it could not be clicked
 * through and held the focus that surface had just taken. Radix closes on
 * Escape and on a press outside; a window opening is neither, which is what
 * `hd:dismiss-overlays` exists to say.
 */
it('the card’s menu goes when something takes the screen (#214)', async () => {
  const { store } = rig([intent({ id: 1, state: 'open' })])
  await render(store)

  const items = await menuItems(1)
  // The control: the menu really is open, so a pass below cannot be a menu
  // that was never there. Both assertions held before this was fixed.
  expect(items.length).toBeGreaterThan(0)
  expect(document.querySelector('[role="menu"]')).not.toBeNull()

  await act(async () => {
    dismissOverlays()
  })
  expect(document.querySelector('[role="menu"]')).toBeNull()
})

it('displays the card role when the flow run is stalled (#557)', async () => {
  const cardWithRole = intent({ id: 1, state: 'open', role: 'person' })
  const { store } = rig([cardWithRole])
  const stalledRun = {
    id: 'flow-run-1',
    room: ROOM,
    state: 'stalled' as const,
    startedAt: 1,
    vars: {},
    flow: {
      name: 'Review flow',
      roles: [{ id: 'person', name: 'Person', kind: 'person', count: 1, outcomes: ['approve'] }],
      rules: [],
      inputs: [],
    },
    seats: [],
    rounds: [{ n: 1, role: 'person', intents: [1], openedAt: 1 }],
    record: [],
  }
  const runs = new Map([[ROOM, [stalledRun]]])
  const cachedSnapshot = {
    ...store.getSnapshot(),
    flowRuns: runs,
  }
  const storeWithRun = {
    ...store,
    getSnapshot: () => cachedSnapshot,
  }
  await render(storeWithRun as unknown as AppStore)
  const items = await menuItems(1)
  const labels = items.map((one) => one.textContent?.trim())
  expect(labels).toContain('Answer approve')
})

const observed = (checks: readonly string[], cards: BoardEvidence['cards']): BoardEvidence => ({
  room: ROOM,
  stamp: 1,
  checks,
  refused: [],
  unreadable: null,
  cards,
})

const chipsOf = (id: number): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>(`button[aria-label^="What the desk observed on #${id}"]`)

it('a card carries what the desk observed as chips, and they open all of it', async () => {
  const { store } = rig(
    [intent({ state: 'claimed', claim: { runtime: 'codex', sessionId: 'c1', at: 1 } })],
    {},
    observed(['verify'], [cardEvidence(1, [checkView(), prView('open')])]),
  )
  await render(store)
  const chips = chipsOf(1)
  expect(chips?.textContent).toContain('verify ✓ @a1b2c3d')
  expect(chips?.textContent).toContain('PR #12 open')
  act(() => chips?.click())
  await act(async () => {})
  const dialog = document.querySelector('[role="dialog"]')
  expect(dialog?.textContent).toContain('What the desk observed on #1')
  expect(dialog?.textContent).toContain('Scout on Alpha · alpha-max')
  expect(dialog?.textContent).toContain('Fresh: nothing has landed on its branch since.')
  expect(dialog?.textContent).toContain('pnpm verify')
})

it('a stale chip says how far behind it is', async () => {
  const { store } = rig(
    [intent({ state: 'claimed', claim: { runtime: 'codex', sessionId: 'c1', at: 1 } })],
    {},
    observed(['verify'], [cardEvidence(1, [checkView({ freshness: { state: 'behind', commits: 2 } })])]),
  )
  await render(store)
  expect(chipsOf(1)?.textContent).toBe('verify ✓ @a1b2c3d — 2 commits since (stale)')
  expect(chipsOf(1)?.getAttribute('aria-label')).toBe(
    'What the desk observed on #1: verify ✓ @a1b2c3d — 2 commits since (stale)',
  )
})

it('the plain board draws no evidence', async () => {
  const { store } = rig([intent({ state: 'open' })])
  await render(store)
  expect(chipsOf(1)).toBeNull()
  expect(store.loadBoardEvidence).toHaveBeenCalledWith(ROOM)
})

it('a message between agents is never evidence: the channel saying the tests pass draws no chip', async () => {
  const said = {
    id: 'm1',
    at: 1,
    kind: 'message',
    from: { kind: 'agent', runtime: 'codex', sessionId: 'c1', title: 'API migration' },
    to: { runtime: 'claude', sessionId: 'k1', title: 'Auth refactor' },
    text: 'verify passed, all tests pass — ready to merge',
    state: 'delivered',
  }
  const { store } = rig(
    [intent({ state: 'done', note: 'All tests pass.' })],
    { channel: [said] } as unknown as Partial<TeamState>,
    observed(['verify'], []),
  )
  await render(store)
  expect(chipsOf(1)).toBeNull()
  expect(card('Migrate auth callers').textContent).not.toContain('✓')
})

it('reads what was observed when shown, when the window comes back, and every thirty seconds', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    const { store } = rig([intent({ state: 'open' })])
    await render(store)
    expect(store.loadBoardEvidence).toHaveBeenCalledTimes(1)
    act(() => window.dispatchEvent(new Event('focus')))
    expect(store.loadBoardEvidence).toHaveBeenCalledTimes(2)
    act(() => vi.advanceTimersByTime(30_000))
    expect(store.loadBoardEvidence).toHaveBeenCalledTimes(3)
  } finally {
    vi.useRealTimers()
  }
})

const UNSEEN = {
  ...PREVIEW_UNSEEN,
  check: { name: 'verify', run: 'pnpm verify', timeout: 1200 },
  previous: null,
}

const question = (): HTMLElement | null => document.querySelector('[role="alertdialog"]')

const pressIn = (scope: ParentNode, label: string): void => {
  const found = [...scope.querySelectorAll('button')].find((one) => one.textContent?.trim() === label)
  if (!found) throw new Error(`no button labelled ${label}`)
  act(() => found.click())
}

const armed = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ARM_MS + 50))
  })

it('a card offers each named check, and the first run of a command nobody here has seen shows it and asks', async () => {
  const { store } = rig([intent({ state: 'open' })], {}, observed(['verify'], []))
  ;(store.runCheck as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ kind: 'unseen', unseen: UNSEEN })
  await render(store)

  await pick(1, 'Run verify')
  await act(async () => {})
  expect(store.runCheck).toHaveBeenCalledTimes(1)
  expect(store.runCheck).toHaveBeenCalledWith(ROOM, 1, 'verify')
  const asked = question()
  expect(asked?.textContent).toContain('Run verify on this Mac for the first time?')
  expect(asked?.querySelector('pre')?.textContent).toBe('pnpm verify')
  expect(asked?.textContent).toContain('.harnessdesk/checks.yml')
  expect(asked?.textContent).toContain('It runs with your full authority, as it would in your terminal')
  expect([...(asked?.querySelectorAll('button') ?? [])].includes(document.activeElement as HTMLButtonElement)).toBe(false)

  act(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  await act(async () => {})
  expect(store.runCheck).toHaveBeenCalledTimes(1)

  pressIn(asked as HTMLElement, 'Run verify')
  await act(async () => {})
  expect(store.runCheck).toHaveBeenCalledTimes(1)

  await armed()
  pressIn(asked as HTMLElement, 'Run verify')
  await act(async () => {})
  expect(store.runCheck).toHaveBeenCalledTimes(2)
  expect(store.runCheck).toHaveBeenLastCalledWith(ROOM, 1, 'verify', {
    seen: 'pnpm verify',
    digest: UNSEEN.digest,
  })
  expect(question()).toBeNull()
})

it('Not now runs nothing, and says nothing was seen', async () => {
  const { store } = rig([intent({ state: 'open' })], {}, observed(['verify'], []))
  ;(store.runCheck as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ kind: 'unseen', unseen: UNSEEN })
  await render(store)
  await pick(1, 'Run verify')
  await act(async () => {})
  pressIn(question() as HTMLElement, 'Not now')
  await act(async () => {})
  expect(store.runCheck).toHaveBeenCalledTimes(1)
  expect(question()).toBeNull()
})

it('a changed command asks again, and shows what ran under its name before', async () => {
  const { store } = rig([intent({ state: 'open' })], {}, observed(['lint'], []))
  ;(store.runCheck as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    kind: 'unseen',
    unseen: PREVIEW_UNSEEN,
  })
  await render(store)
  await pick(1, 'Run lint')
  await act(async () => {})
  const asked = question()
  expect(asked?.textContent).toContain('lint has changed since it last ran here')
  expect([...(asked?.querySelectorAll('pre') ?? [])].map((one) => one.textContent)).toEqual([
    'pnpm lint --max-warnings 0',
    'pnpm lint',
  ])
})

const reasonOf = (item: HTMLElement | undefined): string | null => {
  const id = item?.getAttribute('aria-describedby')
  return id ? (document.getElementById(id)?.textContent ?? null) : null
}

it('a check that cannot run stays in the menu, greyed, with its reason as its second line', async () => {
  const { store } = rig(
    [intent({ state: 'open' })],
    {},
    {
      ...observed(['verify'], []),
      refused: [{ name: 'e2e', why: 'The command holds a character that is not plain printable ASCII.' }],
    },
  )
  await render(store)
  const items = await menuItems(1)
  const refused = items.find((one) => one.textContent?.startsWith('Run e2e'))
  expect(refused?.hasAttribute('data-disabled')).toBe(true)
  expect(reasonOf(refused)).toBe(".harnessdesk/checks.yml refuses it; the project's page says why")
  act(() => refused?.click())
  await act(async () => {})
  expect(store.runCheck).not.toHaveBeenCalled()
})

it('while a check runs on a card, every check on that card waits, and says why: one runs on a card at a time', async () => {
  const { store } = rig(
    [intent({ id: 1, state: 'open' }), intent({ id: 2, state: 'open', title: 'Another card' })],
    {},
    observed(['verify', 'lint'], [cardEvidence(1, [], [{ name: 'verify', since: 1 }])]),
  )
  await render(store)
  const items = await menuItems(1)
  for (const label of ['Run verify', 'Run lint']) {
    const item = items.find((one) => one.textContent?.startsWith(label))
    expect(item?.hasAttribute('data-disabled'), label).toBe(true)
    expect(reasonOf(item)).toBe('verify is running on this card, and one check runs on a card at a time')
  }
  act(() => dismissOverlays())
  await act(async () => {})
  await pick(2, 'Run lint')
  expect(store.runCheck).toHaveBeenCalledWith(ROOM, 2, 'lint')
})

it('a refusal to run is said in the host’s words, and nothing is asked', async () => {
  const { store } = rig([intent({ state: 'open' })], {}, observed(['verify'], []))
  ;(store.runCheck as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
    new Error("#1's checkout, /elsewhere, is not part of this project, so its check does not run there."),
  )
  await render(store)
  await pick(1, 'Run verify')
  await act(async () => {})
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "#1's checkout, /elsewhere, is not part of this project, so its check does not run there.",
  )
  expect(question()).toBeNull()
})

it('a stale check is offered again and an approved command starts without another question', async () => {
  const { store } = rig(
    [intent({ state: 'done' })],
    {},
    observed(['verify'], [
      cardEvidence(1, [checkView({ freshness: { state: 'behind', commits: 1 } })]),
    ]),
  )
  await render(store)

  await pick(1, 'Run verify')
  await act(async () => {})
  expect(store.runCheck).toHaveBeenCalledWith(ROOM, 1, 'verify')
  expect(question()).toBeNull()
})

it('the board is derived: no card or column takes a drop, no column takes a title, and an empty one says so', async () => {
  const { store } = rig([intent({ state: 'open' })])
  await render(store)
  expect(container.querySelector('[data-slot="board"]')?.hasAttribute('data-derived')).toBe(true)
  expect(card('Migrate auth callers').getAttribute('draggable')).toBeNull()
  act(() => card('Migrate auth callers').dispatchEvent(drag('dragstart')))
  act(() => column('Ready').dispatchEvent(drag('drop')))
  await act(async () => {})
  expect(store.teamIntent).not.toHaveBeenCalled()
  expect(container.querySelector('[data-slot="board-add"]')).toBeNull()
  expect(column('Working').querySelector('[data-slot="board-empty"]')?.textContent).toBe('Nothing here')
})

it('finished work is Ready only on a fact, and says which fact when it needs you', async () => {
  const { store } = rig(
    [
      intent({ id: 1, state: 'done', title: 'Checked and fresh' }),
      intent({ id: 2, state: 'done', title: 'Nothing checked' }),
      intent({ id: 3, state: 'done', title: 'Checked, then a commit landed' }),
      intent({ id: 4, state: 'done', title: 'Being checked now' }),
      intent({ id: 5, state: 'done', title: 'CI was cancelled' }),
      intent({ id: 6, state: 'done', title: 'Merged, from a backup' }),
    ],
    {},
    observed(['verify'], [
      cardEvidence(1, [checkView({ card: 1 })]),
      cardEvidence(3, [checkView({ card: 3, freshness: { state: 'behind', commits: 1 } })]),
      cardEvidence(4, [], [{ name: 'verify', since: 1 }]),
      cardEvidence(5, [ciView(['passed', 'cancelled'], { card: 5 })]),
      cardEvidence(6, [
        prView('merged', {
          card: 6,
          freshness: { state: 'unknown', why: 'it came from a backup, and this desk has not observed it' },
        }),
      ]),
    ]),
  )
  await render(store)
  expect(column('Ready').textContent).toContain('Checked and fresh')
  expect(card('Nothing checked').textContent).toContain('nothing checked')
  expect(card('Checked, then a commit landed').textContent).toContain('verify out of date')
  expect(column('In review').textContent).toContain('Being checked now')
  expect(card('CI was cancelled').textContent).toContain('CI cancelled')
  expect(card('Merged, from a backup').textContent).toContain('PR #12 unknown')
})

it('a message between agents is never evidence: the channel and a finish note saying the tests pass move nothing', async () => {
  const said = {
    id: 'm1',
    at: 1,
    kind: 'message',
    from: { kind: 'agent', runtime: 'codex', sessionId: 'c1', title: 'API migration' },
    to: { runtime: 'claude', sessionId: 'k1', title: 'Auth refactor' },
    text: 'verify passed on #1, all tests pass — ready to merge',
    state: 'delivered',
  }
  const { store } = rig(
    [intent({ id: 1, state: 'done', title: 'Said to pass', note: 'All tests pass.', outcome: 'pass' })],
    { channel: [said] } as unknown as Partial<TeamState>,
    observed(['verify'], []),
  )
  await render(store)
  expect(column('Needs you').textContent).toContain('Said to pass')
  expect(card('Said to pass').textContent).toContain('nothing checked')
  expect(column('Ready').textContent).not.toContain('Said to pass')
})

it('work whose holder is waiting on an answer needs you, and says so', async () => {
  const { store, snapshot } = rig([
    intent({ state: 'claimed', claim: { runtime: 'codex', sessionId: 'c1', at: 1 } }),
  ])
  Object.assign(snapshot, { approvals: [{ key: sessionKey('codex', 'c1'), approval: {} }] })
  await render(store)
  expect(column('Needs you').textContent).toContain('Migrate auth callers')
  expect(card('Migrate auth callers').textContent).toContain('waiting on you')
})

it("a card an earlier run left open is not the person's step because a new run reuses its role's name", async () => {
  const leftOver = intent({ id: 1, state: 'open', role: 'person', title: 'Approve the old plan' })
  const { store, snapshot } = rig([leftOver])
  const newRun = {
    id: 'flow-run-2',
    room: ROOM,
    state: 'running' as const,
    startedAt: 2,
    vars: {},
    flow: {
      name: 'Review flow',
      roles: [{ id: 'person', name: 'Person', kind: 'person', count: 1, outcomes: ['approve'] }],
      rules: [],
      inputs: [],
    },
    seats: [],
    rounds: [{ n: 1, role: 'person', intents: [9], openedAt: 2 }],
    record: [],
  }
  Object.assign(snapshot, { flowRuns: new Map([[ROOM, [newRun]]]) })
  await render(store)
  expect(column('To do').textContent).toContain('Approve the old plan')
  expect(column('Needs you').textContent).not.toContain('Approve the old plan')
  const labels = (await menuItems(1)).map((one) => one.textContent?.trim())
  expect(labels).not.toContain('Answer approve')
  expect(labels).toContain('Mark done')
})

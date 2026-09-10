import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  sessionKey,
  type RuntimeInfo,
  type Session,
  type TeamState,
} from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
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
const rig = (intents: readonly unknown[], extra: Partial<TeamState> = {}) => {
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
  } as unknown as AppStore
  return { store }
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

it('columns are the states, so no card has to repeat its own', async () => {
  const { store } = rig([
    intent({ id: 1, state: 'open' }),
    intent({ id: 2, state: 'claimed', title: 'Integration tests' }),
  ])
  await render(store)

  /* "Ready", not "Open": once Waiting is a column of its own, "Open" stops
     saying which of the two it means. The engine's state is still `open` —
     a label and a state name do not have to be the same word. */
  expect(container.textContent).toContain('Ready')
  expect(container.textContent).toContain('Claimed')
  expect(container.textContent).toContain('#1')
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
  /* Enter on the trigger rather than a click: it is the keyboard path, and it
     is the one Radix opens with in jsdom, which has no pointer capture. */
  act(() => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
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

/** React tracks the value setter, so a bare assignment is a change it never hears. */
const typeInto = (box: HTMLInputElement, text: string): void => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(box, text)
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/**
 * The quick path, which lives at the foot of Ready and not in the header.
 *
 * It is a slot until it is pressed, so opening it is part of the act: a
 * composer that were always a field would be a field sitting in a column,
 * which is the shape this replaced.
 */
const openQuickAdd = (): HTMLInputElement => {
  const slot = [...container.querySelectorAll<HTMLButtonElement>(
    '[data-slot="board-add"]',
  )].find((one) => one.tagName === 'BUTTON')
  if (!slot) throw new Error('no add slot at the foot of Ready')
  act(() => slot.click())
  return quickAdd()
}

const quickAdd = (): HTMLInputElement => {
  const found = container.querySelector<HTMLInputElement>(
    '[data-slot="board-add"][data-open] input',
  )
  if (!found) throw new Error('the add slot is not open')
  return found
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

/**
 * Moving work by dragging it.
 *
 * The shortcut, and the reason the board is a board: a card's column is its
 * state, so moving the card is the whole of saying what happened to it. Every
 * drop is one of the same four verbs the menu offers — nothing here can do
 * something a keyboard cannot.
 */
it('dropping a card on Done marks it done', async () => {
  const { store } = rig([intent({ state: 'open' })])
  await render(store)

  act(() => card('Migrate auth callers').dispatchEvent(drag('dragstart')))
  const done = column('Done')
  act(() => done.dispatchEvent(drag('dragover')))
  act(() => done.dispatchEvent(drag('drop')))
  await act(async () => {})

  expect(store.teamIntent).toHaveBeenCalledWith(ROOM, 1, 'done')
})

it('dropping a claimed card on Ready takes it back off its holder', async () => {
  const { store } = rig([
    intent({ state: 'claimed', claim: { runtime: 'codex', sessionId: 'c1', at: 1 } }),
  ])
  await render(store)

  act(() => card('Migrate auth callers').dispatchEvent(drag('dragstart')))
  const ready = column('Ready')
  act(() => ready.dispatchEvent(drag('dragover')))
  act(() => ready.dispatchEvent(drag('drop')))
  await act(async () => {})

  expect(store.teamIntent).toHaveBeenCalledWith(ROOM, 1, 'release')
})

/**
 * The honest half.
 *
 * Three of the five columns are the user's to fill and two are not: `claimed`
 * is taken by an agent, not handed out, and `waiting` belongs to the dependency
 * graph. A drop that silently did nothing would teach the reader the board is
 * broken rather than that the rule exists, so the rule is a sentence, drawn on
 * the column while the card is still in the air.
 */
it('says why a column will not take the card, while the card is in the air', async () => {
  const { store } = rig([intent({ state: 'open' })])
  await render(store)

  expect(column('Claimed').textContent).not.toContain('never handed out')
  act(() => card('Migrate auth callers').dispatchEvent(drag('dragstart')))

  expect(column('Claimed').textContent).toContain('never handed out')
  expect(column('Waiting').textContent).toContain('dependency graph')
  // And the columns that will take it name the verb rather than saying "drop
  // here": four columns do four different things to a card.
  expect(column('Done').textContent).toContain('Mark #1 done')
  expect(column('Blocked').textContent).toContain('Stop #1')

  // A drop where it is refused changes nothing.
  act(() => column('Claimed').dispatchEvent(drag('drop')))
  await act(async () => {})
  expect(store.teamIntent).not.toHaveBeenCalled()
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
it('dropping a card on Blocked asks why before it stops anything', async () => {
  const { store } = rig([intent({ state: 'open' })])
  await render(store)

  act(() => card('Migrate auth callers').dispatchEvent(drag('dragstart')))
  const blocked = column('Blocked')
  act(() => blocked.dispatchEvent(drag('dragover')))
  act(() => blocked.dispatchEvent(drag('drop')))
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

  act(() => card('Migrate auth callers').dispatchEvent(drag('dragstart')))
  act(() => column('Blocked').dispatchEvent(drag('drop')))
  await act(async () => {})

  const cancel = [...document.querySelectorAll('button')].find(
    (one) => one.textContent?.trim() === 'Cancel',
  )
  act(() => cancel?.click())
  await act(async () => {})

  expect(store.teamIntent).not.toHaveBeenCalled()
  expect(document.querySelector('input[aria-label="Why it is stopped"]')).toBeNull()
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
it('adds work from the slot at the foot of Ready', async () => {
  const { store } = rig([intent({})])
  await render(store)

  const add = openQuickAdd()
  typeInto(add, 'Ship the docs')
  act(() => add.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  await act(async () => {})

  expect(store.teamAdd).toHaveBeenCalledWith(ROOM, { title: 'Ship the docs' })
  await act(async () => {})
  // Cleared, and still open: boards are filled in runs, and closing after the
  // first card would make the second one a second click.
  expect(quickAdd().value).toBe('')
})

it('a title the host refuses is said back, in the words that were typed', async () => {
  const { store } = rig([intent({})])
  ;(store.teamAdd as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no'))
  await render(store)

  const add = openQuickAdd()
  typeInto(add, 'Ship the docs')
  act(() => add.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  await act(async () => {})

  /* The field clears the moment it hands the title over and does not wait for
     the host, because a composer that waits eats the next card typed into it
     — and this one is meant to be typed into four times in a row. So the words
     are not held in the box; they are quoted back in the pane's trouble line,
     which is where the answer to "did that land" belongs anyway. */
  expect(container.textContent).toContain('Ship the docs')
  expect(container.textContent).toContain('the board is as it was')
})

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
it('Escape leaves the quick add, and takes the half-typed title with it', async () => {
  const { store } = rig([intent({})])
  await render(store)

  const add = openQuickAdd()
  typeInto(add, 'Half a thought')
  act(() => add.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await act(async () => {})

  expect(container.querySelector('[data-slot="board-add"][data-open]')).toBeNull()
  expect(store.teamAdd).not.toHaveBeenCalled()
})

it('abandoned work is settled but does not sit in Done looking finished', async () => {
  const { store } = rig([intent({ state: 'abandoned' })])
  await render(store)

  // It folds into the last column — and says which it is.
  expect(container.textContent).toContain('abandoned')
})

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
  })
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  expect(document.querySelector('[data-slot="agent-card"]')?.textContent).toContain('API migration')
  vi.useRealTimers()
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

  const columns = [...container.querySelectorAll('[data-slot="board-column"]')]
  const named = (title: string) =>
    columns.find((column) => column.textContent?.startsWith(title))
  expect(named('Waiting')?.textContent).toContain('Review the rounding change')
  expect(named('Waiting')?.textContent).not.toContain('Migrate the pricing table')
  expect(named('Blocked')?.textContent).toContain('Migrate the pricing table')
  expect(named('Blocked')?.textContent).not.toContain('Review the rounding change')
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
it('says the state in the column, not on the card — except where the column cannot', async () => {
  const { store } = rig([
    intent({ id: 1, state: 'blocked', blockedBy: 'graph', title: 'Waits on the graph' }),
    intent({ id: 2, state: 'blocked', blockedBy: 'hand', title: 'Somebody stopped it' }),
    intent({ id: 3, state: 'abandoned', title: 'Given up on' }),
  ] as never)
  await render(store)

  const columns = [...container.querySelectorAll('[data-slot="board-column"]')]
  const named = (title: string) => columns.find((one) => one.textContent?.startsWith(title))

  // Neither blocked card wears a "blocked" chip; their columns already said it.
  expect(named('Waiting')?.textContent).toContain('Waits on the graph')
  expect(named('Waiting')?.textContent).not.toContain('blocked')
  expect(named('Blocked')?.textContent).toContain('Somebody stopped it')
  expect(named('Blocked')?.textContent?.match(/blocked/gi) ?? []).toHaveLength(1) // the heading only

  // Abandoned still says so: it is sitting in Done, which would otherwise read
  // as finished.
  expect(named('Done')?.textContent).toContain('abandoned')
})

/**
 * A stranded claim looks stranded.
 *
 * The card stays in Claimed, because on paper the work still has an owner —
 * and the whole point is that the paper has gone stale. Moving it out would
 * hide the one thing worth seeing: the difference between "somebody is on it"
 * and "somebody was".
 */
it('says when a claim has run out, and leaves it where it was', async () => {
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

  const columns = [...container.querySelectorAll('[data-slot="board-column"]')]
  const claimed = columns.find((one) => one.textContent?.startsWith('Claimed'))
  // Both are still owned, so both are still in Claimed.
  expect(claimed?.textContent).toContain('Migrate the callers')
  expect(claimed?.textContent).toContain('Round the totals')
  // Only the lapsed one says so, and says how long.
  expect(claimed?.textContent).toContain('stranded 3h')
  expect(claimed?.textContent?.match(/stranded/g) ?? []).toHaveLength(1)
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


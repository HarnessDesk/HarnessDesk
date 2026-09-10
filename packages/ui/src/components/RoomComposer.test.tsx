import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { sessionKey, type SessionKey, type TeamPeerInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { RoomComposer, type RoomComposerHandle, type RoomMember } from './RoomComposer'

/**
 * The room's composer.
 *
 * Five claims, and each of them is something the box used to get wrong:
 *
 *   - `@` addresses a member rather than opening a file picker, and the token
 *     it matched leaves the text — a chip is the audience, not a word in the
 *     sentence;
 *   - two recipients is one hand-out and not two posts, because two posts are
 *     two board writes and two rows for one thing the person did once;
 *   - a recipient mid-turn is said *before* the send, on the coin, because
 *     the host is going to queue it and the row saying so arrives afterwards;
 *   - board-only stops the agents, not the person — this box disabled itself
 *     over a switch that never applied to it;
 *   - the audience survives the message, because a room conversation is a run
 *     of lines to the same people far more often than it is one line to one.
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

const ROOM = 'room-1'
/** One snapshot object for every rig — see the note in `rig`. */
const snapshot = emptySnapshot()

const peer = (
  runtime: string,
  id: string,
  nickname: string,
  extra: Partial<TeamPeerInfo> = {},
): TeamPeerInfo =>
  ({
    runtime,
    sessionId: id,
    title: null,
    agent: 'Codex',
    busy: false,
    nickname,
    // Open, unless a test says otherwise: a member that is not open still
    // takes the message, and the composer says so before the press.
    here: true,
    ...extra,
  }) as TeamPeerInfo

const member = (one: TeamPeerInfo, extra: Partial<RoomMember> = {}): RoomMember => ({
  key: sessionKey(one.runtime, one.sessionId as never),
  peer: one,
  brand: null,
  busy: one.busy,
  canUseBoard: true,
  title: one.title,
  ...extra,
})

const OPUS = member(peer('claude', 'k1', 'Opus', { title: 'Review the diff' }))
const GPT = member(peer('codex', 'c1', 'GPT'))
const GEMINI = member(peer('cursor', 'g1', 'Gemini'))

/* One snapshot object for every rig. `useSyncExternalStore` compares identity,
   so a getter that mints a fresh snapshot re-renders forever — the same trap
   the room pane keeps `NO_ENTRIES` for. */
const rig = (members: readonly RoomMember[] | null = [OPUS, GPT, GEMINI], messaging = true) => {
  const store = {
    subscribe: () => () => {},
    getSnapshot: (): AppSnapshot => snapshot,
    teamPost: vi.fn().mockResolvedValue(undefined),
    teamHandout: vi.fn().mockResolvedValue({ batch: 'b1', delivered: 2, queued: 0, refused: 0 }),
  } as unknown as AppStore
  const trouble = vi.fn()
  const posted = vi.fn()
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <RoomComposer
          room={ROOM}
          members={members}
          messaging={messaging}
          onTrouble={trouble}
          onPosted={posted}
        />
      </StoreProvider>,
    )
  })
  return { store, trouble, posted }
}

const box = (): HTMLTextAreaElement => container.querySelector('textarea') as HTMLTextAreaElement

/* React tracks the value setter, so assigning `.value` and firing `input` is a
   change React never hears. This goes through the prototype's setter, which is
   what a keystroke does.
   
   It throws rather than optional-chaining past a missing descriptor. `?.set?.`
   reads as caution and is the opposite: if jsdom ever stopped defining it,
   every test in this file would type nothing into an empty box and pass. A
   test rig may fail; it may not quietly stop testing. */
const setValue = (node: HTMLTextAreaElement, text: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (!setter) throw new Error('no value setter on HTMLTextAreaElement — typing would be a no-op')
  setter.call(node, text)
}

const type = (text: string): void => {
  const node = box()
  setValue(node, text)
  node.dispatchEvent(new Event('input', { bubbles: true }))
}

const press = (key: string, init: KeyboardEventInit & { isComposing?: boolean } = {}): void => {
  /* `isComposing` is on the event and not in jsdom's init, so it is defined on
     the instance — which is what React reads through `nativeEvent`. */
  const { isComposing, ...rest } = init
  const event = new KeyboardEvent('keydown', { key, bubbles: true, ...rest })
  if (isComposing) Object.defineProperty(event, 'isComposing', { value: true })
  box().dispatchEvent(event)
}

const send = (): HTMLButtonElement =>
  container.querySelector('[data-slot="composer-send"]') as HTMLButtonElement

const chips = (): readonly string[] =>
  [...container.querySelectorAll('[data-slot="composer-chip"]')].map(
    (one) => one.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  )

const menu = (): HTMLElement | null => container.querySelector('[role="listbox"]')

/* The audience anchor and the menu it opens. The menu is portalled to the body
   — a fixed panel inside an overflowing pane is a panel with a scrollbar — so
   it is looked for there rather than in the composer. */
const anchor = (): HTMLButtonElement =>
  container.querySelector(
    '[data-slot="composer-tools"] button[aria-haspopup="menu"]',
  ) as HTMLButtonElement

const audienceMenu = (): HTMLElement | null => document.body.querySelector('[role="menu"]')

const audienceRow = (text: string): HTMLButtonElement => {
  const found = [...(audienceMenu()?.querySelectorAll('button') ?? [])].find((one) =>
    one.textContent?.includes(text),
  )
  if (!found) throw new Error(`no audience row containing ${text}`)
  return found as HTMLButtonElement
}

const options = (): readonly string[] =>
  [...(menu()?.querySelectorAll('[role="option"]') ?? [])].map((one) => one.textContent ?? '')

it('@ addresses a member, and the token it matched leaves the words', () => {
  rig()

  act(() => type('take this one @op'))
  expect(options()).toHaveLength(1)
  expect(options()[0]).toContain('Opus')

  act(() => press('Enter'))
  expect(chips()).toEqual(['Opus'])
  /* The text is the message, and the mention was addressing rather than
     writing. Leaving `@op` in it would send a half-typed name to the agent. */
  expect(box().value).toBe('take this one ')
  expect(menu()).toBeNull()
})

it('an @ that matches nobody says so rather than offering everybody', () => {
  rig()
  act(() => type('@nobody'))
  expect(menu()?.textContent).toContain('Nobody here by that name')
})

it('an email address is not an attempt to address somebody', () => {
  rig()
  act(() => type('write to shane@example.com'))
  expect(menu()).toBeNull()
})

it('Escape puts the menu away and leaves the words alone', () => {
  rig()
  act(() => type('@op'))
  expect(menu()).not.toBeNull()
  act(() => press('Escape'))
  expect(menu()).toBeNull()
  expect(box().value).toBe('@op')
})

it('Enter over a menu that matches nobody puts it away rather than sending', () => {
  const { store } = rig()
  act(() => type('take a look @nobdy'))
  expect(menu()?.textContent).toContain('Nobody here by that name')

  /* The defect this pins: the whole keyboard block was guarded on there being
     something to pick, so this Enter fell straight through to the send and
     broadcast a half-written line — `@nobdy` and all — to every member. */
  act(() => press('Enter'))
  expect(store.teamPost).not.toHaveBeenCalled()
  expect(menu()).toBeNull()
  expect(box().value).toBe('take a look @nobdy')

  // And the second Enter, with the menu gone, is the send it always was.
  act(() => press('Enter'))
  expect(store.teamPost).toHaveBeenCalledWith(ROOM, 'take a look @nobdy')
})

it('Enter that ends an IME composition is not a pick', () => {
  /* The member has to *match* what is being composed, or the menu is empty and
     the old code fell through to the send — which checks `isComposing` and
     does nothing. The bug lives on the pick path, so the test has to reach it:
     a roster with Sakura in it, and `@sak` in the box. */
  rig([member(peer('claude', 'k1', 'Sakura')), GPT])
  act(() => type('@sak'))
  expect(options()).toHaveLength(1)

  /* Committing a candidate in Japanese, Chinese or Korean *is* Enter, and the
     browser says so with `isComposing`. Taking it as a pick addressed the
     highlighted member and ate the half-typed word with it. */
  act(() => press('Enter', { isComposing: true }))
  expect(chips()).toEqual([])
  expect(box().value).toBe('@sak')

  // The Enter that follows the composition is an ordinary one, and picks.
  act(() => press('Enter'))
  expect(chips()).toEqual(['Sakura'])
})

it('the space a pick leaves closes up in front of punctuation', () => {
  rig()
  act(() => type('Hey @op'))
  act(() => press('Enter'))
  expect(box().value).toBe('Hey ')

  // `Hey , could you…` is what the orphan space reads as. One keystroke, one
  // of five characters, straight onto the space a pick left.
  act(() => type('Hey ,'))
  expect(box().value).toBe('Hey,')

  // And an ordinary word still gets its space.
  act(() => type('@gp'))
  act(() => press('Enter'))
  act(() => type('Hey, take a look'))
  expect(box().value).toBe('Hey, take a look')
})

it('a mention that starts a new line leaves the line break where it was', () => {
  rig()
  act(() => type('first line\n@op'))
  expect(options()).toHaveLength(1)
  act(() => press('Enter'))
  expect(chips()).toEqual(['Opus'])
  /* The strip kept a space and nothing else, so `@op` picked on a line of
     its own took the newline with it and the two lines ran together (#87). */
  expect(box().value).toBe('first line\n')

  // The gap-closer exists for `Hey @op` then `,`; it does not pull punctuation
  // up across a line break.
  act(() => type('first line\n,'))
  expect(box().value).toBe('first line\n,')
})

it('one recipient is a post; two are one hand-out', async () => {
  const { store } = rig()

  act(() => type('@op'))
  act(() => press('Enter'))
  act(() => type('@gp'))
  act(() => press('Enter'))
  expect(chips()).toEqual(['Opus', 'GPT'])

  act(() => type('compare your findings'))
  act(() => send().click())
  await act(async () => {})

  /* One action, one board write, one row in the channel naming everyone it
     reached — where a loop of posts would be three of each. */
  expect(store.teamPost).not.toHaveBeenCalled()
  expect(store.teamHandout).toHaveBeenCalledWith(ROOM, 'compare your findings', [
    { runtime: 'claude', sessionId: 'k1' },
    { runtime: 'codex', sessionId: 'c1' },
  ])
})

it('nobody addressed is a broadcast the host resolves for itself', async () => {
  const { store } = rig()
  act(() => type('everyone: stand by'))
  act(() => send().click())
  await act(async () => {})

  /* Not a hand-out naming all three: the host's roster at send time is one
     fewer thing this renderer can be wrong about between a fetch and a
     keystroke. */
  expect(store.teamPost).toHaveBeenCalledWith(ROOM, 'everyone: stand by')
  expect(store.teamHandout).not.toHaveBeenCalled()
})

it('the audience survives the message', async () => {
  const { store } = rig()
  act(() => type('@op'))
  act(() => press('Enter'))
  act(() => type('first line'))
  act(() => send().click())
  await act(async () => {})

  expect(box().value).toBe('')
  expect(chips()).toEqual(['Opus'])

  act(() => type('second line'))
  act(() => send().click())
  await act(async () => {})
  expect((store.teamPost as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual([
    ROOM,
    'second line',
    { runtime: 'claude', sessionId: 'k1' },
  ])
})

it('a failed post keeps the words in the box', async () => {
  const { store, trouble } = rig()
  ;(store.teamPost as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('gone'))
  act(() => type('the ledger rounds down'))
  act(() => send().click())
  await act(async () => {})

  expect(box().value).toBe('the ledger rounds down')
  expect(trouble).toHaveBeenCalledWith('The host did not take that. Your words are still here.')
})

it('a recipient mid-turn is said before the send, not after', () => {
  rig([member(peer('claude', 'k1', 'Opus'), { busy: true }), GPT])
  act(() => type('@op'))
  act(() => press('Enter'))
  act(() => type('when you are free'))

  expect(container.textContent).toContain('Opus is working — this waits for the turn to end')
  /* The conversation's own weight for a message a turn is ahead of. It is not
     disabled: the message will be sent, and saying "later" is not saying no. */
  expect(send().dataset['when']).toBe('later')
  expect(send().disabled).toBe(false)
})

it('a broadcast that reaches most of the room now does not claim to wait', () => {
  rig([member(peer('claude', 'k1', 'Opus'), { busy: true }), GPT, GEMINI])
  act(() => type('everyone: stand by'))

  /* One of three is mid-turn. Two get it now, so the coin is a send — and the
     line says which copy is held rather than claiming the message waits. */
  expect(send().dataset['when']).toBe('now')
  expect(container.textContent).toContain('Opus is working — that copy waits')
  expect(container.textContent).toContain('The rest go now')
})

it('every recipient working is the whole message waiting', () => {
  rig([member(peer('claude', 'k1', 'Opus'), { busy: true }), member(peer('codex', 'c1', 'GPT'), { busy: true })])
  act(() => type('when you are both free'))

  expect(send().dataset['when']).toBe('later')
  expect(container.textContent).toContain('Opus, GPT are working — this waits for the turns to end')
})

it('the box empties before the host answers, so a second press sends nothing', async () => {
  const { store } = rig()
  let release: (() => void) | undefined
  ;(store.teamPost as ReturnType<typeof vi.fn>).mockImplementation(
    () => new Promise<void>((resolve) => { release = resolve }),
  )
  act(() => type('only once'))
  act(() => send().click())
  /* Still in the air. The conversation's composer clears here too, and for the
     same reason: a box that empties only on success takes the same words twice
     while the first send is unanswered — and a hand-out doubles N messages. */
  expect(box().value).toBe('')
  act(() => send().click())
  act(() => release?.())
  await act(async () => {})

  expect((store.teamPost as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
})

it('a recipient that cannot reach the tools is said before the send — and honestly', () => {
  rig([member(peer('cursor', 'g1', 'Gemini'), { canUseBoard: false }), GPT])
  act(() => type('@gem'))
  act(() => press('Enter'))
  act(() => type('take card #3'))

  /* It *does* receive this: the user's post is an ordinary turn and
     `Team.post` consults no capability. What it cannot do is act on the board,
     which is what a message like this usually asks for. An earlier draft said
     "cannot take messages", which was wrong in the direction that stops a
     person sending something that would have worked. */
  expect(container.textContent).toContain('Gemini will read this, but cannot claim work')
  expect(send().disabled).toBe(false)
})

it('board-only stops the agents, not the person', () => {
  rig([OPUS, GPT], false)
  act(() => type('carry on'))

  /* The switch holds agents' messages; `Team.post` has no messaging check at
     all. This box used to disable itself over it and tell the one participant
     who can always talk that messages were off. */
  expect(box().disabled).toBe(false)
  expect(send().disabled).toBe(false)
  expect(container.textContent).toContain('Board-only is on')
  expect(container.textContent).toContain('You still can')
})

it('counts towards the limit only near it, and refuses to send past it', () => {
  rig()
  act(() => type('x'.repeat(14_000)))
  expect(container.textContent).not.toContain('/ 16,000')

  act(() => type('x'.repeat(15_500)))
  expect(container.textContent).toContain('15,500 / 16,000')
  expect(send().disabled).toBe(false)

  act(() => type('x'.repeat(16_001)))
  expect(send().disabled).toBe(true)
  expect(container.textContent).toContain("the room's limit is 16,000")
})

it('an empty room says so, and a roster not yet answered does not', () => {
  rig([])
  expect(container.textContent).toContain('No agents in this room yet')

  act(() => root.render(<div />))
  const fresh = rig(null)
  expect(container.textContent).not.toContain('No agents in this room yet')
  expect(fresh.store).toBeDefined()
})

/**
 * A member that is not open is a recipient, and the box says what sending does.
 *
 * The whole state after a relaunch: every member of the room is a stored
 * conversation nobody has opened, the post reaches all of them by reopening
 * them, and the composer used to refuse — "Nobody is live in this room yet" —
 * over a room that was completely intact. Reopening is free and the sending
 * is what was asked for, so the box takes the message and says what it is
 * about to do rather than standing in the way.
 */
it('says that sending will open the members that are not open', () => {
  rig([member(peer('claude', 'k1', 'Opus', { here: false })), GPT])
  const text = container.textContent ?? ''
  expect(text).not.toContain('No agents in this room yet')
  expect(text).toContain('Opus is not open')
  // The other one is open, so this is the "and them too" wording.
  expect(text).toContain('sending opens it too')
})

it('a room where nothing is open says so as the whole of the audience', () => {
  rig([member(peer('claude', 'k1', 'Opus', { here: false })), member(peer('codex', 'c1', 'GPT', { here: false }))])
  expect(container.textContent).toContain('sending opens those conversations and delivers')
})

it('an addressed member that leaves takes its chip with it', () => {
  const { store } = rig([OPUS, GPT])
  act(() => type('@op'))
  act(() => press('Enter'))
  expect(chips()).toEqual(['Opus'])

  act(() => {
    root.render(
      <StoreProvider store={store}>
        <RoomComposer
          room={ROOM}
          members={[GPT]}
          messaging
          onTrouble={vi.fn()}
          onPosted={vi.fn()}
        />
      </StoreProvider>,
    )
  })
  expect(chips()).toEqual([])
})

it('a hand-out that was partly refused says how many, and keeps the trouble', async () => {
  const { store, trouble } = rig()
  ;(store.teamHandout as ReturnType<typeof vi.fn>).mockResolvedValue({
    batch: 'b1',
    delivered: 1,
    queued: 0,
    refused: 1,
  })
  act(() => type('@op'))
  act(() => press('Enter'))
  act(() => type('@gp'))
  act(() => press('Enter'))
  act(() => type('both of you'))
  act(() => send().click())
  await act(async () => {})

  expect(trouble).toHaveBeenCalledWith('1 of 2 did not take it. The row in the channel says why.')
  /* And the success path's `onTrouble(null)` must not wipe it on the way past:
     a sentence cleared in the same tick it was written is a sentence nobody
     reads. */
  expect(trouble).not.toHaveBeenCalledWith(null)
})

it('Shift+Enter is a newline, not a send', () => {
  const { store } = rig()
  act(() => type('first line'))
  act(() => press('Enter', { shiftKey: true }))
  expect(store.teamPost).not.toHaveBeenCalled()
})

it('an audience of one names it on the anchor; three name two and a count', () => {
  rig()
  const anchor = (): string =>
    container.querySelector('[data-slot="composer-tools"] button[aria-haspopup="menu"]')
      ?.textContent ?? ''
  expect(anchor()).toContain('Everyone')

  act(() => type('@op'))
  act(() => press('Enter'))
  expect(anchor()).toContain('Opus')

  act(() => type('@gp'))
  act(() => press('Enter'))
  act(() => type('@gem'))
  act(() => press('Enter'))
  expect(anchor()).toContain('Opus, GPT +1')
})

const key = (one: RoomMember): SessionKey => one.key
it('the audience menu toggles members without closing under the pointer', () => {
  rig()
  act(() => anchor().click())
  expect(audienceMenu()).not.toBeNull()

  /* A switch is not a decision to leave, so picking a second member must not
     mean re-opening the menu. This is the affordance the `<select>` could not
     have at all: an audience built one member at a time. */
  act(() => audienceRow('Opus').click())
  expect(chips()).toEqual(['Opus'])
  expect(audienceMenu()).not.toBeNull()

  act(() => audienceRow('GPT').click())
  expect(chips()).toEqual(['Opus', 'GPT'])
  expect(audienceMenu()).not.toBeNull()
  expect(anchor().textContent).toContain('Opus, GPT')

  // And the switch goes back: a toggle that only added would be a one-way door.
  act(() => audienceRow('Opus').click())
  expect(chips()).toEqual(['GPT'])

  /* Everyone is the one row that *is* a decision, so it closes — and it clears
     the audience rather than adding to it. */
  act(() => audienceRow('Everyone in the room').click())
  expect(chips()).toEqual([])
  expect(anchor().textContent).toContain('Everyone')
})

it('the audience menu says whether a member is working, beside its name', () => {
  rig([member(peer('claude', 'k1', 'Opus'), { busy: true }), member(peer('cursor', 'g1', 'Gemini'), { canUseBoard: false })])
  act(() => anchor().click())

  /* Two facts in two places: who this is on the line under the name, what is
     true of it right now at the end of the row. Joined by a middle dot they
     truncate each other. */
  expect(audienceRow('Opus').textContent).toContain('working')
  expect(audienceRow('Gemini').textContent).toContain('no tools')
})

it('a chip carries the room’s own name card, and the ✕ stays outside it', () => {
  /* A set, not a log: a render prop is called once per render, and the box
     renders again the moment the chip changes the audience. Counting calls
     would be counting renders. */
  const seen = new Set<string>()
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    teamPost: vi.fn().mockResolvedValue(undefined),
    teamHandout: vi.fn().mockResolvedValue({ batch: 'b1', delivered: 1, queued: 0, refused: 0 }),
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <RoomComposer
          room={ROOM}
          members={[OPUS, GPT]}
          messaging
          /* The pane's own reader turns a member into card facts; this only
             proves the composer asks for one per chip and wraps what it is
             given. A card built in here would be the second reader the rail
             and the chat share one of. */
          card={(key, node) => {
            seen.add(key)
            return <span data-testid="card">{node}</span>
          }}
          onTrouble={vi.fn()}
          onPosted={vi.fn()}
        />
      </StoreProvider>,
    )
  })

  act(() => type('@op'))
  act(() => press('Enter'))
  expect([...seen]).toEqual([OPUS.key])
  const chip = container.querySelector('[data-slot="composer-chip"]') as HTMLElement
  expect(chip.querySelector('[data-testid="card"]')?.textContent).toBe('Opus')
  /* Outside the card: a card opening over the button that removes the chip
     would be a card in the way of the one verb the chip already has. */
  expect(chip.querySelector('[data-testid="card"] button')).toBeNull()
  expect(chip.querySelector('button[aria-label="Remove"]')).not.toBeNull()
})

it('a composer with no card given draws the chip unwrapped', () => {
  rig()
  act(() => type('@op'))
  act(() => press('Enter'))
  // Optional, so a preview or a mock mounts the box without inventing a card.
  expect(chips()).toEqual(['Opus'])
})

it('another surface in the room can address a member through the handle', () => {
  const handle = { current: null as RoomComposerHandle | null }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    teamPost: vi.fn().mockResolvedValue(undefined),
    teamHandout: vi.fn().mockResolvedValue({ batch: 'b1', delivered: 1, queued: 0, refused: 0 }),
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <RoomComposer
          ref={handle}
          room={ROOM}
          members={[OPUS, GPT]}
          messaging
          onTrouble={vi.fn()}
          onPosted={vi.fn()}
        />
      </StoreProvider>,
    )
  })

  /* What a name card hanging off a message in the chat needs: Message on an
     agent lands in the audience, the same act picking it from `@` performs. */
  act(() => handle.current?.address(OPUS.key))
  expect(chips()).toEqual(['Opus'])
  // Idempotent, so two presses of Message are one recipient.
  act(() => handle.current?.address(OPUS.key))
  expect(chips()).toEqual(['Opus'])

  /* And it survives the roster moving under it — a member joining is the
     ordinary case, and a handle captured against the old list would either go
     stale or be re-made on every turn that changes a busy light. */
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <RoomComposer
          ref={handle}
          room={ROOM}
          members={[OPUS, GPT, GEMINI]}
          messaging
          onTrouble={vi.fn()}
          onPosted={vi.fn()}
        />
      </StoreProvider>,
    )
  })
  act(() => handle.current?.address(GEMINI.key))
  expect(chips()).toEqual(['Opus', 'Gemini'])
})

it('every member has a key of its own', () => {
  expect(new Set([OPUS, GPT, GEMINI].map(key)).size).toBe(3)
})

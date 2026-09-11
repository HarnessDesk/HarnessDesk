import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { RuntimeInfo } from '@harnessdesk/protocol'
import { sessionKey, type SessionSummary, type TeamPeerInfo } from '@harnessdesk/protocol'

import { AgentCard } from '../design/patterns/AgentCard'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { AgentHoverCard, MemberHoverCard, SessionHoverCard, type MemberCardFacts } from './AgentCards'

/**
 * What a *closed* name card is allowed to cost.
 *
 * Every mark in the session tree, every author name in the channel and every
 * row of a room rail mounts one of these wrappers, and they are closed
 * essentially all of the time. The first version of this file built the card's
 * subject eagerly in the wrapper, which meant each one subscribed to the store
 * and ran a `setInterval(…, 1000)` for the turn timer — some 160 of them for a
 * sixty-session tree beside a fifty-message room, all recomputing on the
 * second, for cards nobody was looking at. In an Electron window that is
 * enough to keep the CPU out of its low-power states all day. Three reviewers
 * called it, independently, as the one thing blocking merge.
 *
 * So the two assertions below are the fix, stated as things that must stay
 * true rather than as a description of the code:
 *
 *   No clock.   A closed card starts no timer. One card is open at a time, so
 *               the app's timer count for this feature is 0 or 1, never N.
 *   No store.   A closed card reads nothing. Asserted by rendering with **no
 *               `StoreProvider` at all** — `useStore` throws without one, so a
 *               wrapper that reaches for app state fails here loudly instead
 *               of quietly costing a subscription per row.
 *
 * Neither is a style rule. Both are the difference between a feature that
 * scales with the number of rows and one that does not.
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
  vi.restoreAllMocks()
  /* A test that fails part-way never reaches its own `useRealTimers` or
     `unstubAllGlobals`, and the fakes it left would fail the next test for a
     reason that has nothing to do with it. */
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const MEMBER: MemberCardFacts = {
  peer: {
    runtime: 'claude-code',
    sessionId: 'sess-1',
    title: null,
    agent: 'Claude Code',
    busy: false,
    nickname: 'Sonnet',
  } as TeamPeerInfo,
  /* Built by the protocol's own function, never spelled out. A `SessionKey`
     is `runtime` NUL `sessionId`, and writing that literally puts a raw 0x00
     in the source: git then calls the file binary, GitHub renders the diff as
     `Binary files … differ`, and a reviewer cannot read the test at all.
     Three reviewers hit exactly that here. The byte is invisible in every
     editor that will ever show this line, which is the whole problem. */
  key: sessionKey('claude-code', 'sess-1' as SessionSummary['id']),
  busy: false,
  here: true,
  canUseBoard: true,
  idleOnBoard: false,
  task: null,
  title: null,
}

const SESSION = {
  id: 'sess-1',
  runtime: 'claude-code',
  title: 'A chat about the limiter',
  cwd: '/repo',
  status: { type: 'idle' },
  createdAt: 1,
  updatedAt: 2,
} as unknown as SessionSummary

/** Many rows, the way the tree and the channel actually mount them. */
const manyRows = (): React.ReactNode => (
  <>
    {Array.from({ length: 40 }, (_, index) => (
      <MemberHoverCard key={`m${index}`} member={MEMBER}>
        <span>mark</span>
      </MemberHoverCard>
    ))}
    {Array.from({ length: 40 }, (_, index) => (
      <SessionHoverCard key={`s${index}`} session={SESSION}>
        <span>glyph</span>
      </SessionHoverCard>
    ))}
  </>
)

it('starts no timer for cards nobody has opened', () => {
  const interval = vi.spyOn(window, 'setInterval')
  act(() => root.render(manyRows()))
  expect(container.querySelectorAll('span').length).toBeGreaterThan(0)
  expect(interval).not.toHaveBeenCalled()
})

it('reads no app state until a card is opened', () => {
  // No StoreProvider anywhere above these. A wrapper that called `useStore` or
  // `useSnapshot` would throw during this render and fail the test by name.
  expect(() => act(() => root.render(manyRows()))).not.toThrow()
})

it('draws no card at all for a conversation the renderer has not loaded', () => {
  // The board knows of claims held by conversations it has never opened. A
  // card built from what little it has would be a reading, and an invented
  // reading is worse than none — so the mark renders bare.
  act(() =>
    root.render(
      <SessionHoverCard session={null}>
        <span data-testid="bare">mark</span>
      </SessionHoverCard>,
    ),
  )
  const mark = container.querySelector('[data-testid="bare"]')
  expect(mark).not.toBeNull()
  expect(mark?.closest('[data-slot="hover-card-trigger"]')).toBeNull()
})

/* ── And what an *open* one does ──────────────────────────────────────── */

/**
 * Radix opens on a real `pointerover` after its delay, and jsdom will deliver
 * one — so the rest of this file drives the card the way a pointer does rather
 * than reaching into its state. Review asked for exactly this: the lazy
 * footprint was covered and the behaviour was not.
 */
const rest = (trigger: Element): void => {
  act(() => {
    trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
  })
  act(() => {
    vi.advanceTimersByTime(1000)
  })
}

const trigger = (): Element => {
  const found = container.querySelector('[data-slot="hover-card-trigger"]')
  if (!found) throw new Error('no trigger rendered')
  return found
}

const openCard = (): Element | null => document.querySelector('[data-slot="agent-card"]')

it('a verb dismisses the card that offered it', () => {
  vi.useFakeTimers()
  const open = vi.fn()
  act(() =>
    root.render(
      <AgentHoverCard
        body={() => (
          <AgentCard
            subject={{
              kind: 'session',
              name: 'A chat about the limiter',
              tint: 'blue',
              mark: <svg />,
              actions: [{ label: 'Open', onSelect: open, primary: true }],
            }}
          />
        )}
      >
        <span>mark</span>
      </AgentHoverCard>,
    ),
  )
  rest(trigger())
  expect(openCard()).not.toBeNull()

  const verb = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Open')
  act(() => verb?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

  expect(open).toHaveBeenCalledOnce()
  // The verb opened something behind this card; the card does not stay over it.
  expect(trigger().getAttribute('data-state')).toBe('closed')
  vi.useRealTimers()
})

it('reading the card does not dismiss it', () => {
  vi.useFakeTimers()
  act(() =>
    root.render(
      <AgentHoverCard
        body={() => (
          <AgentCard
            subject={{
              kind: 'session',
              name: 'A chat about the limiter',
              tint: 'blue',
              mark: <svg />,
              on: { where: '~/code-shane/checkout-api · main' },
              actions: [{ label: 'Open', onSelect: () => {} }],
            }}
          />
        )}
      >
        <span>mark</span>
      </AgentHoverCard>,
    ),
  )
  rest(trigger())
  // A press on the path — the thing somebody opened the card to read — is not
  // a verb, and must not take the card away mid-read.
  const path = [...document.querySelectorAll('div')].find((d) =>
    d.textContent === '~/code-shane/checkout-api · main',
  )
  act(() => path?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(trigger().getAttribute('data-state')).toBe('open')
  vi.useRealTimers()
})

it('leaves the row its own click', () => {
  // The marks these wrap sit inside rows that are already buttons. The trigger
  // is a `span` for that reason; this is the regression test review asked for.
  const rowClicked = vi.fn()
  act(() =>
    root.render(
      <button type="button" onClick={rowClicked}>
        <SessionHoverCard session={SESSION}>
          <span data-testid="mark">mark</span>
        </SessionHoverCard>
      </button>,
    ),
  )
  const mark = container.querySelector('[data-testid="mark"]')
  act(() => mark?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(rowClicked).toHaveBeenCalledOnce()
})

it('starts exactly one clock when a card opens, and stops it when it closes', () => {
  vi.useFakeTimers()
  const live = new Set<unknown>()
  const realSet = window.setInterval
  const realClear = window.clearInterval
  vi.spyOn(window, 'setInterval').mockImplementation(((fn: never, ms: number, ...rest: never[]) => {
    const handle = realSet(fn, ms, ...rest)
    if (ms === 1000) live.add(handle)
    return handle
  }) as never)
  vi.spyOn(window, 'clearInterval').mockImplementation(((handle: never) => {
    live.delete(handle)
    return realClear(handle)
  }) as never)

  const snapshot = {
    ...emptySnapshot(),
    runtimes: [
      { id: 'claude-code', presentation: { name: 'Claude Code' }, capabilities: {} },
    ] as unknown as RuntimeInfo[],
  } as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore

  act(() =>
    root.render(
      <StoreProvider store={store}>
        <MemberHoverCard member={MEMBER}>
          <span>mark</span>
        </MemberHoverCard>
      </StoreProvider>,
    ),
  )
  expect(live.size).toBe(0)

  rest(trigger())
  expect(openCard()).not.toBeNull()
  expect(live.size).toBe(1)

  act(() => {
    trigger().dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }))
  })
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  // Not merely "no longer counting up": the handle is cleared, so a card
  // opened and closed a hundred times leaves nothing behind.
  expect(live.size).toBe(0)
  vi.useRealTimers()
})

/* ── What opens a card, and where ─────────────────────────────────────── */

/**
 * A row, the way a rail draws a member: a mark, a name, and a control of its
 * own — the +, whose title says which column a pick will take.
 *
 * Triggers grew from a mark to the whole of an identity, so a row's trigger
 * now holds things focus lands on, and things with tooltips of their own. It
 * says so the way the rail does, with `openOnFocus={false}`.
 */
const withAControl = (): React.ReactNode => (
  <AgentHoverCard
    as="div"
    openOnFocus={false}
    body={() => (
      <AgentCard
        subject={{ kind: 'session', name: 'A chat about the limiter', tint: 'blue', mark: <svg /> }}
      />
    )}
  >
    <span>mark</span> <span>Codex</span>
    <button type="button" data-no-card="">
      Watch beside
    </button>
  </AgentHoverCard>
)

/** A chip, the way a publication is drawn: one thing to focus — a link. */
const chip = (as?: 'span' | 'div'): React.ReactNode => (
  <AgentHoverCard
    {...(as ? { as } : {})}
    body={() => (
      <AgentCard
        subject={{ kind: 'session', name: 'A chat about the limiter', tint: 'blue', mark: <svg /> }}
      />
    )}
  >
    <a href="#pr">acme/widgets #7</a>
  </AgentHoverCard>
)

const press = (target: Element, pointerType = 'mouse'): void => {
  act(() => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType }))
  })
}

const leave = (target: Element, pointerType = 'mouse'): void => {
  act(() => {
    target.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType }))
  })
  act(() => {
    vi.advanceTimersByTime(1000)
  })
}

/** Focus moved to something outside every trigger. */
const focusElsewhere = (): void => {
  const away = document.createElement('button')
  document.body.appendChild(away)
  act(() => away.focus())
  away.remove()
}

/** A keyboard reaching something: a key goes down, and only then does focus land. */
const tabTo = (target: HTMLElement): void => {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' }))
  })
  act(() => target.focus())
}

/** The pointer moving on from one part of a trigger to another, without leaving it. */
const move = (from: Element, to: Element): void => {
  act(() => {
    from.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: to }))
    to.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', relatedTarget: from }))
  })
}

const wait = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

/** The trigger's box, where the layout jsdom does not do would put it. */
const spans = (left: number, right: number): void => {
  vi.spyOn(trigger(), 'getBoundingClientRect').mockReturnValue({
    left,
    right,
    top: 100,
    bottom: 140,
    width: right - left,
    height: 40,
    x: left,
    y: 100,
    toJSON: () => ({}),
  } as DOMRect)
}

/* The viewport: the root element's width, and a visual viewport as wide — the
   two the side is decided against. The app always has both, so every side
   test measures through both, as the app does; jsdom lays nothing out and has
   no visual viewport, so neither is there until a test says otherwise. */
const viewport = (width: number, height = 768): void => {
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(width)
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(height)
  vi.stubGlobal('visualViewport', {
    width,
    height,
    offsetLeft: 0,
    offsetTop: 0,
    scale: 1,
    addEventListener: () => {},
    removeEventListener: () => {},
  })
}

const side = (): string | null | undefined =>
  document.querySelector('[data-slot="hover-card-content"]')?.getAttribute('data-side')

/**
 * A `ResizeObserver` driven by hand. jsdom's own never calls back; this one
 * records what each observer watches, so a test can resize one element and
 * reach exactly the observers watching it. The positioner observes the
 * trigger too, and hearing it only makes it measure again.
 */
const observeByHand = (): { resized: (target: Element) => void } => {
  const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly watching = new Set<Element>()
      constructor(callback: ResizeObserverCallback) {
        observers.push({ callback, targets: this.watching })
      }
      observe(target: Element): void {
        this.watching.add(target)
      }
      unobserve(target: Element): void {
        this.watching.delete(target)
      }
      disconnect(): void {
        this.watching.clear()
      }
    },
  )
  return {
    resized: (target) => {
      act(() => {
        for (const { callback, targets } of observers) {
          if (targets.has(target)) callback([], {} as ResizeObserver)
        }
      })
    },
  }
}

it('a row’s own controls take focus without opening its card — or closing it', () => {
  vi.useFakeTimers()
  act(() => root.render(withAControl()))
  const control = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Watch beside')
  if (!control) throw new Error('no control inside the trigger')

  // Tabbing down a rail lands on the + in every row. That is a keyboard step,
  // and a card at each one is the cost the mark-only rule used to avoid.
  tabTo(control)
  wait(1000)
  expect(document.activeElement).toBe(control)
  expect(openCard()).toBeNull()

  // And the other way: a card the pointer is resting on stays when Tab moves on
  // out of the row. The pointer has not moved, and nothing would reopen it.
  rest(trigger())
  expect(trigger().getAttribute('data-state')).toBe('open')
  tabTo(control)
  focusElsewhere()
  wait(1000)
  expect(trigger().getAttribute('data-state')).toBe('open')
  vi.useRealTimers()
})

it('a chip — one thing to focus — opens its card for a keyboard, and closes it when focus leaves', () => {
  vi.useFakeTimers()
  act(() => root.render(chip()))
  const link = container.querySelector('a')
  if (!link) throw new Error('no link inside the chip')

  tabTo(link)
  wait(1000)
  expect(trigger().getAttribute('data-state')).toBe('open')

  focusElsewhere()
  wait(1000)
  expect(trigger().getAttribute('data-state')).toBe('closed')
  vi.useRealTimers()
})

it('opens for a keyboard whatever element the trigger is', () => {
  vi.useFakeTimers()
  // A chip laid out as a block: still one thing to focus, only in a div. What
  // refuses focus is a trigger saying it holds controls, not the element.
  act(() => root.render(chip('div')))
  const link = container.querySelector('a')
  if (!link) throw new Error('no link inside the chip')

  tabTo(link)
  wait(1000)
  expect(trigger().getAttribute('data-state')).toBe('open')
  vi.useRealTimers()
})

it.each(['touch', 'pen'] as const)('a %s tap never opens a card, not even by the focus it leaves behind', (pointerType) => {
  vi.useFakeTimers()
  act(() => root.render(chip()))
  const link = container.querySelector('a')
  if (!link) throw new Error('no link inside the chip')

  // A tap, in the order a touch screen sends it, a stylus's included: the
  // pointer arrives, presses, lifts and leaves at once — and only then does
  // focus land on what it hit.
  act(() => {
    link.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType }))
  })
  press(link, pointerType)
  act(() => {
    link.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType }))
  })
  leave(link, pointerType)
  act(() => link.focus())
  wait(1000)
  expect(openCard()).toBeNull()

  // That was the press's focus, not a keyboard's: when a keyboard arrives,
  // the card opens.
  focusElsewhere()
  tabTo(link)
  wait(1000)
  expect(openCard()).not.toBeNull()
  vi.useRealTimers()
})

it('a tap that leaves no focus behind does not cost the next keyboard its card', () => {
  vi.useFakeTimers()
  act(() => root.render(chip()))
  const link = container.querySelector('a')
  if (!link) throw new Error('no link inside the chip')

  // A tap after which focus stays where it was, so nothing inside the chip
  // ever blurs to say the tap is over.
  act(() => {
    link.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'touch' }))
  })
  press(link, 'touch')
  act(() => {
    link.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }))
  })
  leave(link, 'touch')
  expect(document.activeElement).not.toBe(link)

  tabTo(link)
  wait(1000)
  expect(openCard()).not.toBeNull()
  vi.useRealTimers()
})

it('a press anywhere makes the next focus a press’s, and a key anywhere makes it a keyboard’s', () => {
  vi.useFakeTimers()
  const elsewhere = document.createElement('button')
  document.body.appendChild(elsewhere)
  act(() => root.render(chip()))
  const link = container.querySelector('a')
  if (!link) throw new Error('no link inside the chip')

  // A press on something that is no trigger, then focus arriving on the chip
  // from a script: the last thing done was a press, so it opens nothing.
  press(elsewhere)
  act(() => link.focus())
  wait(1000)
  expect(openCard()).toBeNull()

  // A key on that same other thing, and the same focus is a keyboard's.
  focusElsewhere()
  act(() => {
    elsewhere.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Shift' }))
  })
  act(() => link.focus())
  wait(1000)
  expect(openCard()).not.toBeNull()
  elsewhere.remove()
  vi.useRealTimers()
})

it('a press on a chip holds its card shut, even against the focus the press leaves', () => {
  vi.useFakeTimers()
  act(() => root.render(chip()))
  const link = container.querySelector('a')
  if (!link) throw new Error('no link inside the chip')

  rest(link)
  expect(trigger().getAttribute('data-state')).toBe('open')
  // A click focuses the link it lands on, and focus opens a chip's card — so
  // without the hold the card would be back 420ms after the click.
  press(link)
  act(() => link.focus())
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  expect(trigger().getAttribute('data-state')).toBe('closed')

  leave(link)
  rest(link)
  expect(trigger().getAttribute('data-state')).toBe('open')
  vi.useRealTimers()
})

it('a control marked data-no-card opens no card, and reaching one puts an open card away', () => {
  vi.useFakeTimers()
  act(() => root.render(withAControl()))
  const control = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Watch beside')
  const name = [...container.querySelectorAll('span')].find((s) => s.textContent === 'Codex')
  if (!control || !name) throw new Error('the row is missing its parts')

  // Arriving straight on the control: its own tooltip is what that rest asks for.
  rest(control)
  expect(openCard()).toBeNull()
  leave(control)

  // Resting on the name opens the card; moving on to the control puts it away,
  // and it stays away while the pointer is on the control.
  rest(name)
  expect(trigger().getAttribute('data-state')).toBe('open')
  move(name, control)
  wait(1000)
  expect(trigger().getAttribute('data-state')).toBe('closed')
  vi.useRealTimers()
})

it('a pointer that arrives on a data-no-card control gets its card once it moves on to the name', () => {
  vi.useFakeTimers()
  act(() => root.render(withAControl()))
  const control = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Watch beside')
  const name = [...container.querySelectorAll('span')].find((s) => s.textContent === 'Codex')
  if (!control || !name) throw new Error('the row is missing its parts')

  // A rail's + sits at the row's trailing edge, the edge a pointer coming from
  // the chat crosses first, so arriving on it is an ordinary way in.
  rest(control)
  expect(openCard()).toBeNull()

  // On to the name without leaving the row. The trigger hears no second
  // arrival, so the card is asked for again — after the delay of any rest, so
  // a pointer passing over the name on its way elsewhere opens nothing.
  move(control, name)
  wait(200)
  expect(trigger().getAttribute('data-state')).toBe('closed')
  wait(800)
  expect(trigger().getAttribute('data-state')).toBe('open')

  // And back on to the control puts it away again.
  move(name, control)
  expect(trigger().getAttribute('data-state')).toBe('closed')
  vi.useRealTimers()
})

it('an open cancels the re-ask that was pending, so it cannot land on the card later', () => {
  vi.useFakeTimers()
  act(() => root.render(<div data-testid="list">{withAControl()}</div>))
  const control = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Watch beside')
  const name = [...container.querySelectorAll('span')].find((s) => s.textContent === 'Codex')
  if (!control || !name) throw new Error('the row is missing its parts')

  // In over the name, which starts Radix's own delay, then on to the control
  // and back before it runs out — which leaves a re-ask pending as well.
  act(() => {
    name.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
  })
  wait(100)
  move(name, control)
  wait(100)
  move(control, name)
  wait(250)
  expect(trigger().getAttribute('data-state')).toBe('open')

  /* Radix's request opened the card, and the re-ask comes due later. Left
     pending, it lands on whatever the card is by then: an open card has its
     side settled again, and one closed since — here, by its list scrolling —
     opens again under a pointer that has not moved. The second is the one a
     test can see at once: the side only shows when the positioner's answer
     lands, and a check made before then would pass either way. */
  act(() => {
    container.querySelector('[data-testid="list"]')?.dispatchEvent(new Event('scroll'))
  })
  expect(trigger().getAttribute('data-state')).toBe('closed')
  wait(400)
  expect(trigger().getAttribute('data-state')).toBe('closed')
  vi.useRealTimers()
})

it('a press takes the card away, and it stays away until the pointer leaves', () => {
  vi.useFakeTimers()
  act(() => root.render(withAControl()))
  rest(trigger())
  expect(trigger().getAttribute('data-state')).toBe('open')

  // The press is the row's: it opened something, and the card must not float
  // over that — not now, and not a beat later off the focus the press gave the
  // trigger, which is how Radix would bring it straight back.
  press(trigger())
  act(() => (trigger() as HTMLElement).focus())
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  expect(trigger().getAttribute('data-state')).toBe('closed')

  // Leaving and coming back is a new rest, and a new rest opens it.
  leave(trigger())
  rest(trigger())
  expect(trigger().getAttribute('data-state')).toBe('open')
  vi.useRealTimers()
})

it('a press inside the open delay means the card never opens', () => {
  vi.useFakeTimers()
  act(() => root.render(withAControl()))
  // A pass and then a click, quicker than the delay: the timer Radix started
  // on the way in must not open a card over whatever the click opened.
  act(() => {
    trigger().dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
  })
  act(() => {
    vi.advanceTimersByTime(200)
  })
  press(trigger())
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  expect(openCard()).toBeNull()
  vi.useRealTimers()
})

/**
 * No card opens while something is being dragged.
 *
 * The board's cards are dragged natively, and the order Chromium sends that
 * in was measured in this app's shell: `pointerdown`, `dragstart` 18ms later,
 * `pointercancel` 5ms after that, and nothing more from the pointer until
 * `dragend`. The drag has to outlast that `pointercancel`, or the gate holds
 * for five milliseconds.
 */
it('opens no card while something is being dragged, in the order a browser sends a drag, and opens one once it is over', () => {
  vi.useFakeTimers()
  act(() => root.render(withAControl()))
  const control = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Watch beside')
  const name = [...container.querySelectorAll('span')].find((s) => s.textContent === 'Codex')
  if (!control || !name) throw new Error('the row is missing its parts')
  const elsewhere = document.createElement('div')
  document.body.appendChild(elsewhere)
  /* A board card picked up somewhere else in the window. */
  const dragBegins = (): void => {
    press(elsewhere)
    act(() => {
      window.dispatchEvent(new Event('dragstart'))
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerType: 'mouse' }))
    })
  }

  // A card is asked for — a re-ask, armed by moving off the control on to the
  // name — and a drag begins before it comes due.
  rest(control)
  move(control, name)
  dragBegins()
  // A pointer moving with its button held is still the drag.
  act(() => {
    window.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', buttons: 1 }))
  })
  wait(1000)
  expect(openCard()).toBeNull()

  // Over the ordinary way, and the next rest opens the card.
  act(() => {
    window.dispatchEvent(new Event('dragend'))
  })
  leave(name)
  rest(name)
  expect(trigger().getAttribute('data-state')).toBe('open')
  leave(name)

  // A drag whose source went away mid-gesture ends with neither `dragend` nor
  // `drop`. The pointer moving again with no button held is the end of it…
  dragBegins()
  act(() => {
    window.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', buttons: 0 }))
  })
  rest(name)
  expect(trigger().getAttribute('data-state')).toBe('open')
  leave(name)

  // …and so is the pointer let go.
  dragBegins()
  act(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'mouse' }))
  })
  rest(name)
  expect(trigger().getAttribute('data-state')).toBe('open')
  elsewhere.remove()
})

it('opens beside a trigger with room beside it, and under one without', () => {
  vi.useFakeTimers()
  act(() => root.render(withAControl()))
  viewport(1024)

  // A mark near the left of the window: beside it, where it asked to go.
  spans(20, 60)
  rest(trigger())
  expect(side()).toBe('right')
  leave(trigger())

  // No room on the right but plenty on the left: the card opens on the left,
  // the side it will actually take, rather than asking for the right and
  // leaving the trade to the positioner — which could trade it back under an
  // open card.
  spans(1024 - 60, 1024 - 20)
  rest(trigger())
  expect(side()).toBe('left')
  leave(trigger())

  // A row the whole window wide — the rail of a narrow room. Beside it is off
  // the window on both sides, and the positioner only ever trades a side for
  // its opposite, so the card goes under.
  spans(0, 1024)
  rest(trigger())
  expect(side()).toBe('bottom')
  vi.useRealTimers()
})

it('measures the room beside a trigger inside a scrollbar, where the positioner measures it', () => {
  vi.useFakeTimers()
  act(() => root.render(withAControl()))
  /* A classic scrollbar: the window is 1024 wide and the page inside it 1009.
     The card is kept inside the page, so that is where it has to fit — 288px
     and its 8px gap. Here there are 300px to the window's edge and 285 to the
     page's. */
  expect(window.innerWidth).toBe(1024)
  viewport(1009)
  spans(0, 724)
  rest(trigger())
  expect(side()).toBe('bottom')
  vi.useRealTimers()
})

it('measures against the root where the visual viewport is a fraction wider, as a zoom can leave them', () => {
  vi.useFakeTimers()
  act(() => root.render(withAControl()))
  /* Zoomed, the root's width is a whole number and the visual viewport's a
     fraction, and either can be the narrower. Here the root is 1009 and the
     visual viewport 1009.5 — 295.75px to the root's edge, 296.25 to the
     viewport's, and the card needs 296 — so it is the root that says no. */
  viewport(1009)
  vi.stubGlobal('visualViewport', {
    width: 1009.5,
    height: 768,
    offsetLeft: 0,
    offsetTop: 0,
    scale: 1,
    addEventListener: () => {},
    removeEventListener: () => {},
  })
  spans(0, 713.25)
  rest(trigger())
  expect(side()).toBe('bottom')
})

/**
 * An open card keeps its side; it closes when it no longer fits there.
 *
 * The positioner answers asynchronously. Round 1 of #148 moved an open card
 * to its new side instead, and an answer for the old side could land after
 * the one for the new side — measured, a card settled below and drawn on the
 * left. Closing leaves nothing in flight to land, and the card is asked for
 * again, so a reader who has not moved gets it back where it fits.
 */
it('closes when the window narrows until it no longer fits, and comes back where it fits for a reader still resting', () => {
  vi.useFakeTimers()
  act(() => root.render(withAControl()))
  viewport(1024)
  spans(20, 60)
  rest(trigger())
  expect(side()).toBe('right')

  // The control: the window changes size, and the card still fits beside the row.
  viewport(900)
  act(() => {
    window.dispatchEvent(new Event('resize'))
  })
  expect(trigger().getAttribute('data-state')).toBe('open')

  // Narrowed until the row is all of it: the card goes at once…
  viewport(400)
  spans(0, 400)
  act(() => {
    window.dispatchEvent(new Event('resize'))
  })
  expect(trigger().getAttribute('data-state')).toBe('closed')

  // …and the pointer, still resting, has it back after the delay of any rest,
  // under the row.
  wait(1000)
  expect(trigger().getAttribute('data-state')).toBe('open')
  expect(side()).toBe('bottom')

  // A pointer that has gone by then gets nothing back.
  leave(trigger())
  viewport(1024)
  spans(20, 60)
  rest(trigger())
  expect(side()).toBe('right')
  viewport(400)
  spans(0, 400)
  act(() => {
    window.dispatchEvent(new Event('resize'))
  })
  leave(trigger())
  expect(trigger().getAttribute('data-state')).toBe('closed')
  vi.useRealTimers()
})

it('keeps the side it opened on: closes when that side stops fitting though the other fits, and comes back on that one', () => {
  vi.useFakeTimers()
  act(() => root.render(withAControl()))
  viewport(1024)
  // Room on the left only, so it opens on the left.
  spans(1024 - 60, 1024 - 20)
  rest(trigger())
  expect(side()).toBe('left')

  /* The row ends up at the window's other edge: the left no longer fits, and
     the right does. Left open, the card would be the positioner's to trade
     back across its own trigger, under the reader. */
  spans(20, 60)
  act(() => {
    window.dispatchEvent(new Event('resize'))
  })
  expect(trigger().getAttribute('data-state')).toBe('closed')
  wait(1000)
  expect(trigger().getAttribute('data-state')).toBe('open')
  expect(side()).toBe('right')

  /* Settled there, it is watched afresh: a resize it fits through, then the
     row back where only the left fits — closed and asked for again, as the
     first time, rather than refused as a second close in a row. */
  act(() => {
    window.dispatchEvent(new Event('resize'))
  })
  expect(trigger().getAttribute('data-state')).toBe('open')
  spans(1024 - 60, 1024 - 20)
  act(() => {
    window.dispatchEvent(new Event('resize'))
  })
  expect(trigger().getAttribute('data-state')).toBe('closed')
  wait(1000)
  expect(side()).toBe('left')
  vi.useRealTimers()
})

/**
 * A card that lost the room on its side is taken away at once.
 *
 * Presence keeps a closing card mounted until its exit animation ends, and the
 * positioner keeps placing it meanwhile — for a card that has just lost the
 * room on its side, somewhere it does not fit. Measured in the real app: the
 * narrowing window drew the closing card at x = −47, off the window, for its
 * last 150ms. jsdom runs no animations, so here the card is given an exit:
 * its animation's name changes as it closes, and no `animationend` comes.
 */
it('takes a card that lost the room on its side away at once, where one put away by the pointer or a scroll fades', () => {
  const realStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
    const style = realStyle(element, pseudo)
    if (!(element instanceof HTMLElement) || element.dataset['slot'] !== 'hover-card-content') return style
    return new Proxy(style, {
      get: (target, key) => {
        if (key === 'animationName') return element.dataset['state'] === 'closed' ? 'exit' : 'enter'
        const value: unknown = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  })
  const content = (): Element | null => document.querySelector('[data-slot="hover-card-content"]')
  vi.useFakeTimers()
  act(() => root.render(<div data-testid="list">{withAControl()}</div>))
  viewport(1024)
  spans(20, 60)
  rest(trigger())
  expect(side()).toBe('right')

  // The controls: put away by the pointer leaving, the card stays mounted to
  // fade, which is what makes the case below a difference…
  leave(trigger())
  expect(content()?.getAttribute('data-state')).toBe('closed')

  // …and so does one its list's scroll put away.
  rest(trigger())
  act(() => {
    container.querySelector('[data-testid="list"]')?.dispatchEvent(new Event('scroll'))
  })
  expect(content()?.getAttribute('data-state')).toBe('closed')

  rest(trigger())
  expect(content()?.getAttribute('data-state')).toBe('open')
  viewport(400)
  spans(0, 400)
  act(() => {
    window.dispatchEvent(new Event('resize'))
  })
  expect(content()).toBeNull()

  // Back for the reader still resting, below the row — and put away by the
  // pointer from there, it fades again like any other.
  wait(1000)
  expect(content()?.getAttribute('data-state')).toBe('open')
  expect(side()).toBe('bottom')
  leave(trigger())
  expect(content()?.getAttribute('data-state')).toBe('closed')
  vi.useRealTimers()
})

it('closes when the trigger itself narrows under it, as when a panel opens beside the room', () => {
  const hand = observeByHand()
  try {
    vi.useFakeTimers()
    act(() => root.render(withAControl()))
    viewport(1024)
    spans(20, 60)
    rest(trigger())
    expect(trigger().getAttribute('data-state')).toBe('open')

    // The window has not changed; the row has, and it is the whole window now.
    spans(0, 1024)
    hand.resized(trigger())
    expect(trigger().getAttribute('data-state')).toBe('closed')
  } finally {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }
})

it('follows a trigger drawn again while its card is open, for that trigger’s own resizes', () => {
  const hand = observeByHand()
  try {
    vi.useFakeTimers()
    act(() => root.render(chip('span')))
    viewport(1024)
    spans(20, 60)
    rest(trigger())
    expect(trigger().getAttribute('data-state')).toBe('open')

    // The same card with a new element under it — nothing does this today —
    // which then widens to the whole window.
    act(() => root.render(chip('div')))
    expect(trigger().tagName).toBe('DIV')
    spans(0, 1024)
    hand.resized(trigger())
    expect(trigger().getAttribute('data-state')).toBe('closed')
  } finally {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }
})

/**
 * A card beside its trigger is checked again whenever the positioner moves it.
 *
 * The positioner follows the trigger by itself — through a resize of the
 * window, of the trigger, and through a move with neither, such as the
 * sidebar's seam dragged beside a room — and can trade the card's side as it
 * goes. A move alone reaches none of the card's own listeners, so the card
 * listens to the positioner too. jsdom has no positioner worth the name here
 * (no layout, no IntersectionObserver), so its output is written by hand, the
 * way it writes it: a new transform on the card's wrapper, a new `data-side`.
 */
it('checks its side again when the positioner moves it, and closes when that side has lost its room', async () => {
  /* React answers a flushSync it will not run with a console error and a
     scheduled update — which would pass every check below a frame late. */
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.useFakeTimers()
  act(() => root.render(withAControl()))
  viewport(1024)
  // Room on the left only, so it opens on the left.
  spans(1024 - 60, 1024 - 20)
  rest(trigger())
  expect(side()).toBe('left')
  const wrapper = document.querySelector('[data-slot="hover-card-content"]')?.parentElement
  if (!wrapper) throw new Error('no wrapper around the card')
  // The element the watch observes is the positioner's own wrapper.
  expect(wrapper.hasAttribute('data-radix-popper-content-wrapper')).toBe(true)

  // The control: placed again with nothing moved, and it stays.
  await act(async () => {
    wrapper.style.transform = 'translate(668px, 100px)'
  })
  expect(trigger().getAttribute('data-state')).toBe('open')

  // The row slides to the window's other edge at the same width — no resize
  // anywhere — and the positioner follows it.
  spans(20, 60)
  await act(async () => {
    wrapper.style.transform = 'translate(68px, 100px)'
  })
  expect(trigger().getAttribute('data-state')).toBe('closed')
  wait(1000)
  expect(side()).toBe('right')
  expect(errors).not.toHaveBeenCalled()
})

it('closes when the positioner trades its side, whatever moved', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.useFakeTimers()
  act(() => root.render(withAControl()))
  viewport(1024)
  spans(20, 60)
  rest(trigger())
  expect(side()).toBe('right')

  await act(async () => {
    document.querySelector('[data-slot="hover-card-content"]')?.setAttribute('data-side', 'left')
  })
  expect(trigger().getAttribute('data-state')).toBe('closed')
  expect(errors).not.toHaveBeenCalled()
})

/**
 * A trade is not asked for again.
 *
 * It would be the positioner and this code disagreeing about the same
 * geometry, and measuring again only disagrees again. So a traded card is
 * closed and waits for the pointer to come back, whatever passes meanwhile,
 * rather than being opened, traded and closed, unseen, for as long as the
 * pointer rests.
 */
it('closes a card the positioner trades, and does not ask for it again until the pointer comes back', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  const hand = observeByHand()
  vi.useFakeTimers()
  act(() => root.render(withAControl()))
  viewport(1024)
  // A row with room on both sides: this code asks for the right.
  spans(400, 440)
  rest(trigger())
  expect(side()).toBe('right')

  // The positioner draws it on the left instead.
  await act(async () => {
    document.querySelector('[data-slot="hover-card-content"]')?.setAttribute('data-side', 'left')
  })
  expect(trigger().getAttribute('data-state')).toBe('closed')

  // Nothing brings it back while the pointer rests: not the delay of a rest,
  // and not the trigger measured again in the meantime.
  wait(500)
  hand.resized(trigger())
  wait(1000)
  expect(trigger().getAttribute('data-state')).toBe('closed')

  // A new visit asks afresh, on the side this code measures.
  leave(trigger())
  rest(trigger())
  expect(trigger().getAttribute('data-state')).toBe('open')
  expect(side()).toBe('right')
  expect(errors).not.toHaveBeenCalled()
})

it('a card that settled below, then came back beside its trigger, is still asked for again when it loses its room', () => {
  vi.useFakeTimers()
  act(() => root.render(withAControl()))
  const control = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Watch beside')
  const name = [...container.querySelectorAll('span')].find((s) => s.textContent === 'Codex')
  if (!control || !name) throw new Error('the row is missing its parts')
  viewport(1024)
  spans(20, 60)
  rest(name)
  expect(side()).toBe('right')

  // Narrowed until the row is all of it: closed, and back below.
  viewport(400)
  spans(0, 400)
  act(() => {
    window.dispatchEvent(new Event('resize'))
  })
  wait(1000)
  expect(side()).toBe('bottom')

  // Wider again; the pointer crosses the + and comes back to the name, and the
  // card is asked for beside the row. Nothing watched it while it was below.
  viewport(1024)
  spans(20, 60)
  move(name, control)
  move(control, name)
  wait(1000)
  expect(side()).toBe('right')

  // Narrowed once more: closed, and asked for again, as the first time.
  viewport(400)
  spans(0, 400)
  act(() => {
    window.dispatchEvent(new Event('resize'))
  })
  expect(trigger().getAttribute('data-state')).toBe('closed')
  wait(1000)
  expect(trigger().getAttribute('data-state')).toBe('open')
  expect(side()).toBe('bottom')
})

it('measures the room on the right against the visual viewport where that is narrower than the root', () => {
  vi.useFakeTimers()
  act(() => root.render(withAControl()))
  /* The positioner keeps a card inside the visual viewport. Where that is a
     little narrower than the root element — a zoom that rounds the root's width
     up — the room has to be found there too, or the positioner trades a side
     this code chose. Here the root is 1024 wide and the visual viewport 1000:
     300px to the root's edge, 276 to the viewport's. */
  viewport(1024)
  vi.stubGlobal('visualViewport', {
    width: 1000,
    height: 768,
    offsetLeft: 0,
    offsetTop: 0,
    scale: 1,
    addEventListener: () => {},
    removeEventListener: () => {},
  })
  spans(0, 724)
  rest(trigger())
  expect(side()).toBe('bottom')
})

it('measures the room on the left from the visual viewport’s left edge, where that starts inside the root', () => {
  vi.useFakeTimers()
  act(() => root.render(withAControl()))
  /* Zoomed and panned, the visual viewport starts to the right of the root's
     left edge, and the positioner keeps a card inside it. Here it starts at
     80: from the trigger, 340px to the root's left edge, 260 to the
     viewport's, and 224 to the right-hand edge — too little on either side. */
  viewport(1024)
  spans(340, 800)
  // The control: nothing panned, so the left has room.
  rest(trigger())
  expect(side()).toBe('left')
  leave(trigger())
  vi.stubGlobal('visualViewport', {
    width: 944,
    height: 768,
    offsetLeft: 80,
    offsetTop: 0,
    scale: 1,
    addEventListener: () => {},
    removeEventListener: () => {},
  })
  rest(trigger())
  expect(side()).toBe('bottom')
})

/**
 * The watch reads the card's side as it starts, not only the changes after.
 *
 * It hears the positioner by observing it, and an observer reports changes
 * from the moment it is attached — so an answer already written by then (the
 * positioner's first, for a card just drawn) is heard only if the watch reads
 * what is there as it starts. In the app, a ResizeObserver's first report
 * happened to do that. Here no observer reports anything at all, and the
 * watch is started again, over a side already traded, by drawing the trigger
 * again.
 */
it('reads the side the positioner drew a card on as its watch starts, not only the changes after', () => {
  observeByHand()
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe(): void {}
      disconnect(): void {}
      takeRecords(): MutationRecord[] {
        return []
      }
    },
  )
  vi.useFakeTimers()
  act(() => root.render(chip('span')))
  viewport(1024)
  spans(20, 60)
  rest(trigger())
  expect(side()).toBe('right')

  // The control: the watch started again over the side the card opened on.
  act(() => root.render(chip('div')))
  expect(trigger().getAttribute('data-state')).toBe('open')

  // The positioner's answer, where no observer reports it; the watch, started
  // again, reads it — and a trade is not asked for again.
  document.querySelector('[data-slot="hover-card-content"]')?.setAttribute('data-side', 'left')
  act(() => root.render(chip('span')))
  expect(trigger().getAttribute('data-state')).toBe('closed')
  wait(1000)
  expect(trigger().getAttribute('data-state')).toBe('closed')
})

it('a re-ask opens on the side asked for now, not the side asked for when it was armed', () => {
  vi.useFakeTimers()
  const row = (wanted: 'right' | 'bottom'): React.ReactNode => (
    <AgentHoverCard
      as="div"
      openOnFocus={false}
      side={wanted}
      body={() => (
        <AgentCard
          subject={{ kind: 'session', name: 'A chat about the limiter', tint: 'blue', mark: <svg /> }}
        />
      )}
    >
      <span>mark</span> <span>Codex</span>
      <button type="button" data-no-card="">
        Watch beside
      </button>
    </AgentHoverCard>
  )
  act(() => root.render(row('right')))
  const control = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Watch beside')
  const name = [...container.querySelectorAll('span')].find((s) => s.textContent === 'Codex')
  if (!control || !name) throw new Error('the row is missing its parts')
  viewport(1024)
  spans(20, 60)

  // In over the control, then on to the name: a re-ask is armed. Before it
  // comes due, the caller asks for below instead.
  rest(control)
  move(control, name)
  act(() => root.render(row('bottom')))
  wait(1000)
  expect(side()).toBe('bottom')
})

/**
 * Only a scroll that moves the trigger closes the card.
 *
 * The room's chat follows every new message, and a listener that took any
 * scroll in the window shut the card whenever an agent spoke. Measured in the
 * real app: resting on a member's name while the room was answering, the
 * stream scrolled three times in 1.4s and the card never stayed open.
 */
it('stays open through a scroll elsewhere, and closes when its own list or the page scrolls', () => {
  vi.useFakeTimers()
  const elsewhere = document.createElement('div')
  document.body.appendChild(elsewhere)
  act(() => root.render(<div data-testid="list">{withAControl()}</div>))
  rest(trigger())
  expect(trigger().getAttribute('data-state')).toBe('open')

  // The chat following a new message: a scroller the trigger is not inside.
  act(() => {
    elsewhere.dispatchEvent(new Event('scroll'))
  })
  expect(trigger().getAttribute('data-state')).toBe('open')

  // The control: the list the trigger sits in scrolls, and the card goes.
  act(() => {
    container.querySelector('[data-testid="list"]')?.dispatchEvent(new Event('scroll'))
  })
  expect(trigger().getAttribute('data-state')).toBe('closed')

  // And the page: the document holds every trigger, so its scroll moves this
  // one too — it needs no case of its own.
  leave(trigger())
  rest(trigger())
  expect(trigger().getAttribute('data-state')).toBe('open')
  act(() => {
    document.dispatchEvent(new Event('scroll'))
  })
  expect(trigger().getAttribute('data-state')).toBe('closed')
  elsewhere.remove()
  vi.useRealTimers()
})

it('reads its trigger as it is now, so a trigger drawn again while open still closes for its list’s scroll', () => {
  vi.useFakeTimers()
  const inList = (as: 'span' | 'div'): React.ReactNode => <div data-testid="list">{chip(as)}</div>
  act(() => root.render(inList('span')))
  rest(trigger())
  expect(trigger().getAttribute('data-state')).toBe('open')

  // The same card with a new element under it — nothing does this today, and
  // a trigger read once as the card opened would be a detached node here,
  // contained by nothing.
  act(() => root.render(inList('div')))
  expect(trigger().tagName).toBe('DIV')
  expect(trigger().getAttribute('data-state')).toBe('open')

  act(() => {
    container.querySelector('[data-testid="list"]')?.dispatchEvent(new Event('scroll'))
  })
  expect(trigger().getAttribute('data-state')).toBe('closed')
  vi.useRealTimers()
})

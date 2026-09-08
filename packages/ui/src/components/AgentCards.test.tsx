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

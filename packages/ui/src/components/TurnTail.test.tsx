import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, sessionId, turnId, type Session, type Turn } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { TurnTail } from './TurnTail'

/**
 * The line under a turn, and what a turn says when it has nothing to show.
 *
 * A failed turn names its reason with the alert every failed action uses, so
 * it reads, and is announced, the way a failed commit or checkout is. A turn
 * that finished silently says so in the same drawing, but politely: it
 * interrupts nothing, because nothing the person did was refused.
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
  vi.useRealTimers()
})

const render = async (turn: Turn) => {
  const snapshot = { ...emptySnapshot(), status: 'open' } as unknown as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, setDetailsTab: vi.fn() } as unknown as AppStore
  const session = { cwd: '/work/storefront', turns: [turn], usage: null } as unknown as Session
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <TurnTail turn={turn} session={session} />
      </StoreProvider>,
    )
  })
  return container.querySelector<HTMLElement>('[data-slot="alert"]')
}

it('names the reason a turn failed with the alert every failed action uses', async () => {
  const alert = await render({
    id: turnId('t1'),
    items: [],
    status: 'failed',
    diff: null,
    error: { message: 'Internal error: the session is owned by another process', retrying: true },
  } as Turn)

  expect(alert?.getAttribute('role')).toBe('alert')
  expect(alert?.querySelector('[data-slot="alert-content"]')?.textContent).toBe(
    'Internal error: the session is owned by another process Retrying…',
  )
})

it('says a silent turn ended with nothing, in the same drawing, without interrupting', async () => {
  const alert = await render({ id: turnId('t1'), items: [], status: 'completed', diff: null } as Turn)

  expect(alert?.getAttribute('role')).toBe('status')
  expect(alert?.textContent).toBe('The agent finished this turn without any output.')
})

it('leaves only actions and time visible, with the turn figures on the time tooltip', () => {
  vi.useFakeTimers()
  const completedAt = Date.UTC(2026, 8, 18, 20, 15)
  const turn: Turn = {
    id: turnId('turn-1'),
    status: 'completed',
    durationMs: 25_000,
    completedAt,
    diff: null,
    items: [
      {
        id: 'command-1', type: 'command', command: 'pnpm test', cwd: '/work', origin: 'agent',
        actions: [{ type: 'unknown', command: 'pnpm test' }], status: 'failed', exitCode: 1, output: 'failed',
      } as never,
      { id: 'answer-1', type: 'assistantMessage', text: 'I found the cause.', phase: 'final' } as never,
    ],
  }
  const session = {
    id: sessionId('session-1'),
    runtime: runtimeId('codex'),
    cwd: '/work',
    status: { type: 'idle' },
    createdAt: completedAt - 60_000,
    updatedAt: completedAt,
    turns: [turn],
    itemsLoaded: true,
    usage: {
      total: { totalTokens: 2400, inputTokens: 2000, cachedInputTokens: 1800, cacheWriteTokens: 100, outputTokens: 400, reasoningOutputTokens: 0 },
      last: { totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 900, cacheWriteTokens: 100, outputTokens: 200, reasoningOutputTokens: 0 },
    },
  } as Session
  const snapshot = emptySnapshot()
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    queue: vi.fn(),
    notice: vi.fn(),
  } as unknown as AppStore

  act(() => {
    root.render(
      <StoreProvider store={store}>
        <TurnTail turn={turn} session={session} answer="I found the cause." />
      </StoreProvider>,
    )
  })

  expect(container.textContent).not.toContain('1 command')
  expect(container.textContent).not.toContain('1 step failed')
  expect(container.querySelector('[data-testid="turn-time"]')).not.toBeNull()
  expect(container.querySelector('[aria-label="Copy this message"]')).not.toBeNull()

  const time = container.querySelector('[data-testid="turn-time"]')
  act(() => {
    ;(time as HTMLElement | null)?.focus()
    vi.advanceTimersByTime(1000)
  })
  expect(document.body.textContent).toContain('1 step · 25.0s · 1K in · 200 out · 90% cached')
})

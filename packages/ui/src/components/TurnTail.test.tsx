import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runtimeId, sessionId, sessionKey, turnId, type GoalView, type RuntimeInfo, type Session, type Turn } from '@harnessdesk/protocol'

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

it('keeps a wrapped answer readable while disabling its retry dispatch', async () => {
  const key = sessionKey('fake', 'kept-answer')
  const snapshot = { ...emptySnapshot(), activeSessionKey: key, goals: new Map([['record', {
    goal: { state: 'wrapped' }, members: [], receipt: { members: [{ session: { runtime: 'fake', sessionId: 'kept-answer' } }] },
  } as unknown as GoalView]]) }
  const queue = vi.fn()
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, queue } as unknown as AppStore
  await act(async () => root.render(<StoreProvider store={store}><TurnTail turn={{ id: turnId('answer'), items: [], status: 'completed' } as unknown as Turn} session={{ turns: [] } as unknown as Session} answer="The work is finished." /></StoreProvider>))
  const retry = container.querySelector<HTMLButtonElement>('button[aria-label="Ask the runtime to try again"]')!
  expect(retry.disabled).toBe(true)
  expect(retry.title).toBe('This Team is wrapped')
  act(() => retry.click())
  expect(queue).not.toHaveBeenCalled()
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="Copy this message"]')?.disabled).toBe(false)
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
  expect(alert?.textContent).toBe('The runtime finished this turn without any output.')
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

/**
 * A failed turn offers the one thing that helps, chosen by the kind of
 * failure the adapter named — the same for every agent, worded from the
 * runtime's presentation and gated on what it can do.
 */
describe('the remedy beside a failed turn', () => {
  const agent = runtimeId('fake')
  const info = (capabilities: { account?: boolean; metered?: boolean } = {}) => ({
    id: agent,
    presentation: { name: 'Fake Agent' },
    capabilities: { account: true, metered: true, ...capabilities },
  }) as unknown as RuntimeInfo
  const failedTurn = (code: string | undefined, extra: Partial<Turn> = {}): Turn => ({
    id: turnId('t-failed'),
    status: 'failed',
    diff: null,
    items: [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Fix the build', deskContext: { kind: 'person' } }] } as never],
    error: { message: 'The turn failed.', ...(code ? { code } : {}) },
    ...extra,
  } as Turn)

  const renderFailed = async (turn: Turn, runtime: RuntimeInfo | null = info(), turns?: Turn[]) => {
    const snapshot = { ...emptySnapshot(), runtimes: runtime ? [runtime] : [] } as unknown as AppSnapshot
    const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, queue: vi.fn(), askSeatFix: vi.fn() }
    const session = { id: sessionId('s1'), runtime: agent, cwd: '/work', turns: turns ?? [turn], usage: null } as unknown as Session
    await act(async () => root.render(
      <StoreProvider store={store as unknown as AppStore}><TurnTail turn={turn} session={session} /></StoreProvider>,
    ))
    const alert = container.querySelector<HTMLElement>('[data-slot="alert"]')
    return { store, alert, button: alert?.querySelector<HTMLButtonElement>('button') ?? null }
  }

  it.each([
    ['auth', 'Sign in to Fake Agent', { kind: 'signIn', runtime: 'fake' }],
    ['credits', 'See when it resets', { kind: 'usage', runtime: 'fake' }],
    ['rateLimit', 'See when it resets', { kind: 'usage', runtime: 'fake' }],
    ['versionGate', 'Open Fake Agent in Settings', { kind: 'runtime', runtime: 'fake' }],
    ['runtimeUnavailable', 'Open Fake Agent in Settings', { kind: 'runtime', runtime: 'fake' }],
  ])('%s takes the person where it is fixed', async (code, label, fix) => {
    const { store, button } = await renderFailed(failedTurn(code))
    expect(button?.textContent).toBe(label)
    act(() => button!.click())
    expect(store.askSeatFix).toHaveBeenCalledWith(fix)
    expect(store.queue).not.toHaveBeenCalled()
  })

  it.each(['network', 'protocol', 'unknown'])('%s offers another try with the turn’s own prompt', async (code) => {
    const { store, button } = await renderFailed(failedTurn(code))
    expect(button?.textContent).toBe('Try again')
    act(() => button!.click())
    // The person's words again, without the provenance of the first sending.
    expect(store.queue).toHaveBeenCalledWith([{ type: 'text', text: 'Fix the build' }], sessionKey(agent, sessionId('s1')))
  })

  it.each(['interrupted', 'sandboxDenied', undefined])('%s offers nothing', async (code) => {
    const { alert, button } = await renderFailed(failedTurn(code))
    expect(alert?.textContent).toContain('The turn failed.')
    expect(button).toBeNull()
  })

  it('offers nothing while the runtime is retrying on its own', async () => {
    const turn = failedTurn('rateLimit')
    const { button } = await renderFailed({ ...turn, error: { ...turn.error!, retrying: true } })
    expect(button).toBeNull()
  })

  it('gates each door on what the runtime can do, never on which it is', async () => {
    expect((await renderFailed(failedTurn('auth'), info({ account: false }))).button).toBeNull()
    expect((await renderFailed(failedTurn('credits'), info({ metered: false }))).button).toBeNull()
    expect((await renderFailed(failedTurn('runtimeUnavailable'), null)).button).toBeNull()
  })

  it('offers another try only on the last turn, and not where the conversation cannot run', async () => {
    const earlier = failedTurn('network')
    const later = { ...failedTurn('network'), id: turnId('t-later') }
    expect((await renderFailed(earlier, info(), [earlier, later])).button).toBeNull()
    expect((await renderFailed(failedTurn('network'), null)).button, 'its runtime is not installed').toBeNull()
  })
})

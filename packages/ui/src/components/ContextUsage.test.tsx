import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { sessionKey, type RuntimeInfo, type Session, type SessionUsage } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { ContextUsage } from './ContextUsage'

/**
 * The ring's contract, through the DOM: absent until the runtime has said
 * anything, a fill only from `contextUsed / contextWindow`, a dashed ring
 * and a sentence in the agent's name when there is no window, and a panel
 * whose rows come from the session and the active runtime's limits alone.
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

const runtime = (id: string, name: string, metered: boolean): RuntimeInfo =>
  ({
    id,
    name,
    capabilities: { metered } as RuntimeInfo['capabilities'],
    presentation: { name },
  }) as RuntimeInfo

const session = (runtimeId: string, usage: SessionUsage | null): Session =>
  ({
    id: 's1',
    runtime: runtimeId,
    cwd: '/w',
    status: { type: 'idle' },
    createdAt: 0,
    updatedAt: 0,
    turns: [],
    itemsLoaded: true,
    usage,
  }) as unknown as Session

const tokens = (
  totalTokens: number,
  inputTokens = totalTokens,
  cachedInputTokens = 0,
  outputTokens = 0,
  reasoningOutputTokens = 0,
  /** Left off entirely by default — the shape every agent had before §38. */
  cacheWriteTokens?: number,
) => ({
  totalTokens,
  inputTokens,
  cachedInputTokens,
  outputTokens,
  reasoningOutputTokens,
  ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
})

/** A store that is only a snapshot; the component never writes. */
const storeOf = (snapshot: AppSnapshot): AppStore =>
  ({
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  }) as unknown as AppStore

const mount = (over: Partial<AppSnapshot>): void => {
  const snapshot: AppSnapshot = { ...emptySnapshot(), ...over }
  act(() => {
    root.render(
      <StoreProvider store={storeOf(snapshot)}>
        <ContextUsage />
      </StoreProvider>,
    )
  })
}

const withSession = (info: RuntimeInfo, usage: SessionUsage | null, extra: Partial<AppSnapshot> = {}): Partial<AppSnapshot> => {
  const key = sessionKey(info.id, 's1')
  return {
    runtimes: [info],
    activeRuntime: info.id,
    sessions: new Map([[key, session(info.id, usage)]]),
    activeSessionKey: key,
    ...extra,
  }
}

const ring = (): HTMLElement | null => container.querySelector('button [role="img"]')
const open = (): void => {
  const trigger = container.querySelector('button')
  if (!trigger) throw new Error('no trigger')
  act(() => {
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}
const panelText = (): string => document.querySelector('[role="menu"]')?.textContent ?? ''

describe('ContextUsage', () => {
  it('is absent until the runtime has reported anything', () => {
    mount(withSession(runtime('alpha', 'Alpha Agent', false), null))
    expect(container.querySelector('button')).toBeNull()
    mount({})
    expect(container.querySelector('button')).toBeNull()
  })

  it('fills from contextUsed over contextWindow, never the session total', () => {
    mount(
      withSession(runtime('alpha', 'Alpha Agent', false), {
        total: tokens(2_000_000, 1_900_000, 0, 100_000),
        last: tokens(50_000, 48_000, 40_000, 2000, 300),
        contextUsed: 171_000,
        contextWindow: 258_000,
        cost: { amount: 1.25, currency: 'USD' },
      }),
    )
    const glyph = ring()
    expect(glyph?.getAttribute('aria-label')).toBe('Context window 66% full — 171K of 258K tokens')
    expect(glyph?.dataset['tone']).toBe('good')
    expect(glyph?.hasAttribute('data-unknown')).toBe(false)
    expect(glyph?.style.getPropertyValue('--ring-fill')).toMatch(/^66\.2/)

    open()
    const text = panelText()
    expect(text).toContain('66% full')
    expect(text).toContain('171K of 258K tokens in context')
    expect(text).toContain('Last turn')
    expect(text).toContain('Input48K83% cached')
    expect(text).toContain('Output2K')
    expect(text).toContain('Thinking300')
    expect(text).toContain('This session')
    expect(text).toContain('Tokens2M100K out')
    expect(text).toMatch(/Cost\$1\.25/)
    expect(text).toContain('Reported by Alpha Agent.')
    expect(text).not.toContain('Plan usage')
  })

  it('turns amber, then red, as the window fills', () => {
    const at = (used: number): string | undefined => {
      mount(withSession(runtime('alpha', 'Alpha', false), { total: tokens(1), last: tokens(1), contextUsed: used, contextWindow: 100 }))
      return ring()?.dataset['tone']
    }
    expect(at(50)).toBe('good')
    expect(at(75)).toBe('warn')
    expect(at(95)).toBe('bad')
  })

  it('draws a dashed ring and says so, in the agent\'s name, when there is no window', () => {
    mount(withSession(runtime('beta', 'Beta Agent', false), { total: tokens(1280, 1200, 0, 80), last: tokens(1280, 1200, 0, 80) }))
    const glyph = ring()
    expect(glyph?.hasAttribute('data-unknown')).toBe(true)
    expect(glyph?.getAttribute('aria-label')).toBe('1.3K tokens this session — Beta Agent does not report its context window')
    open()
    expect(panelText()).toContain('Beta Agent does not report its context window size.')
    expect(panelText()).toContain('Tokens1.3K80 out')
  })

  it('shows the plan windows only for the active, metered runtime', () => {
    const limits = {
      windows: [
        { label: '5-hour', usedPercent: 54, windowMinutes: 300, resetsAt: null },
        { label: 'Weekly', usedPercent: 45, windowMinutes: 10080, resetsAt: null },
      ],
    }
    const usage: SessionUsage = { total: tokens(10), last: tokens(10), contextUsed: 10, contextWindow: 100 }
    mount(withSession(runtime('alpha', 'Alpha', true), usage, { limits }))
    open()
    expect(panelText()).toContain('Plan usage')
    // Left, not used: the same scale and the same direction as the sidebar
    // footer, the header strip and the Dashboard. A panel that said "54%
    // used" beside a footer saying "46% left" made a reader convert one into
    // the other before they could tell the two agreed.
    expect(panelText()).toContain('5-hour46% left')
    expect(panelText()).toContain('Weekly55% left')

    // Not metered: the same limits are somebody else's.
    mount(withSession(runtime('alpha', 'Alpha', false), usage, { limits }))
    open()
    expect(panelText()).not.toContain('Plan usage')

    // Metered, but the pane is on another runtime than the active one.
    const other = runtime('gamma', 'Gamma', true)
    const key = sessionKey(other.id, 's1')
    mount({
      runtimes: [other, runtime('alpha', 'Alpha', true)],
      activeRuntime: 'alpha' as RuntimeInfo['id'],
      sessions: new Map([[key, session(other.id, usage)]]),
      activeSessionKey: key,
      limits,
    })
    open()
    expect(panelText()).not.toContain('Plan usage')
  })
  it('an agent that reports cache misses gets a verdict', () => {
    // Reads and writes both known: the panel can say the cache was cold, and
    // a cold cache is a bill, not an absence.
    mount(
      withSession(runtime('alpha', 'Alpha', false), {
        total: tokens(200_000),
        last: tokens(180_000, 180_000, 0, 500, 0, 180_000),
        contextUsed: 180_000,
        contextWindow: 258_000,
      }),
    )
    open()
    expect(panelText()).toContain('Input180Kcold cache')
  })

  it('an agent that reports only hits keeps the share it can vouch for, never a verdict', () => {
    // The same turn, from a runtime that has not been taught to report cache
    // writes. It gets the number it can stand behind and no more — see
    // `lib/cache-health.ts` for why the two must not read the same.
    mount(
      withSession(runtime('alpha', 'Alpha', false), {
        total: tokens(200_000),
        last: tokens(180_000, 180_000, 90_000, 500),
        contextUsed: 180_000,
        contextWindow: 258_000,
      }),
    )
    open()
    expect(panelText()).toContain('50% cached')
    expect(panelText()).not.toContain('cold cache')
  })

  it('splits the session total where a child spent part of it, and stays quiet otherwise', () => {
    mount(
      withSession(runtime('alpha', 'Alpha', false), {
        total: tokens(1_000_000, 900_000, 0, 100_000),
        last: tokens(50_000),
        contextUsed: 50_000,
        contextWindow: 258_000,
        delegated: tokens(400_000, 350_000, 0, 50_000),
      }),
    )
    open()
    expect(panelText()).toContain('Delegated400K40% of the session')

    // No delegated figure is the ordinary case; the row must not appear as a
    // zero, which would claim the session delegated nothing.
    mount(
      withSession(runtime('alpha', 'Alpha', false), {
        total: tokens(1_000_000),
        last: tokens(50_000),
        contextUsed: 50_000,
        contextWindow: 258_000,
      }),
    )
    open()
    expect(panelText()).not.toContain('Delegated')
  })
})

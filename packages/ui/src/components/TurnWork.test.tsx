import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { turnId, type AgentItem, type Turn } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { TurnWork } from './TurnWork'

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

it('keeps a failed turn and its failed step closed until each is opened', () => {
  const command = {
    id: 'command-1',
    type: 'command',
    command: 'pnpm test',
    cwd: '/work',
    origin: 'agent',
    actions: [{ type: 'unknown', command: 'pnpm test' }],
    status: 'failed',
    exitCode: 1,
    output: 'one suite failed',
  } as unknown as AgentItem
  const turn: Turn = {
    id: turnId('turn-1'),
    items: [command],
    status: 'failed',
    durationMs: 25_000,
    diff: null,
  }
  const snapshot = emptySnapshot()
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  } as unknown as AppStore

  act(() => {
    root.render(
      <StoreProvider store={store}>
        <TurnWork turn={turn} work={[command]} root="/work" />
      </StoreProvider>,
    )
  })

  const fold = container.querySelector<HTMLButtonElement>('[data-testid="turn-work"] > button')
  expect(fold?.getAttribute('aria-expanded')).toBe('false')
  expect(fold?.textContent).toContain('· 1 failed')
  expect(container.textContent).not.toContain('one suite failed')

  act(() => fold?.click())
  const step = [...container.querySelectorAll<HTMLButtonElement>('button')].find((entry) =>
    entry.textContent?.includes('pnpm test'),
  )
  expect(step?.textContent).toContain('failed')
  expect(step?.getAttribute('aria-expanded')).toBe('false')
  expect(container.textContent).not.toContain('one suite failed')

  act(() => step?.click())
  expect(container.textContent).toContain('one suite failed')
})

it('keeps an expanded step surface-free in the light work register', () => {
  const command = {
    id: 'command-1',
    type: 'command',
    command: 'pnpm test',
    cwd: '/work',
    origin: 'agent',
    actions: [{ type: 'unknown', command: 'pnpm test' }],
    status: 'completed',
    output: 'all clear',
  } as unknown as AgentItem
  const turn: Turn = {
    id: turnId('turn-1'),
    items: [command],
    status: 'completed',
    durationMs: 25_000,
    diff: null,
  }
  const snapshot = emptySnapshot()
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  } as unknown as AppStore

  act(() => {
    root.render(
      <StoreProvider store={store}>
        <TurnWork turn={turn} work={[command]} root="/work" />
      </StoreProvider>,
    )
  })

  const fold = container.querySelector<HTMLButtonElement>('[data-testid="turn-work"] > button')
  act(() => fold?.click())

  const row = container.querySelector<HTMLElement>('[data-testid="turn-work"] [class*="_row_"]')
  expect(row?.className).not.toContain('rounded-(--hd-radius)')
  expect(row?.className).not.toContain('bg-(--hd-card)')
  expect(row?.className).not.toContain('shadow-(--hd-hairline)')
})

it('says a running turn is running in its ink, its live line, and its fold', () => {
  const command = {
    id: 'command-2',
    type: 'command',
    command: 'cat src/c.ts',
    cwd: '/work',
    origin: 'agent',
    actions: [{ type: 'read', command: 'cat src/c.ts', name: 'c.ts', path: 'src/c.ts' }],
    status: 'inProgress',
    output: '',
  } as unknown as AgentItem
  const running: Turn = { id: turnId('turn-3'), items: [command], status: 'inProgress', startedAt: Date.now() - 3000, diff: null } as Turn
  const done: Turn = { ...running, id: turnId('turn-4'), status: 'completed', durationMs: 3000, items: [{ ...command, status: 'completed' } as unknown as AgentItem] }
  const snapshot = emptySnapshot()
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore
  const label = () => container.querySelector<HTMLElement>('[data-slot="turn-work-header-label"]')

  act(() => {
    root.render(
      <StoreProvider store={store}>
        <TurnWork turn={running} work={running.items} root="/work" />
      </StoreProvider>,
    )
  })
  expect(label()?.dataset['state']).toBe('running')
  expect(label()?.className).toContain('text-(--hd-secondary-foreground)')
  expect(container.querySelector('[data-testid="turn-work"]')?.hasAttribute('data-running')).toBe(true)
  expect(container.querySelector('[data-slot="turn-work-live"]')?.getAttribute('role')).toBe('status')
  // Open while it runs, and the chevron says so.
  expect(container.querySelector('[data-slot="disclosure-chevron"]')?.hasAttribute('data-open')).toBe(true)

  act(() => {
    root.render(
      <StoreProvider store={store}>
        <TurnWork turn={done} work={done.items} root="/work" />
      </StoreProvider>,
    )
  })
  expect(label()?.dataset['state']).toBe('done')
  expect(label()?.className).not.toContain('text-(')
  expect(container.querySelector('[data-slot="turn-work-live"]')).toBeNull()
})

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { turnId, type AgentItem, type Session, type Turn } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Trajectory } from './Trajectory'
import styles from './Trajectory.module.css'
import sheet from './Trajectory.module.css?raw'

/**
 * The trajectory ledger, as a reader meets it.
 *
 * Each claim here is one the panel once got wrong: roles in capitals, labels
 * cut at a character count with no ellipsis, a turn heading that scrolled
 * away with its rows, and the wire's own spelling of a turn's state and of
 * the kinds it had no word for.
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

const item = (id: string, rest: Record<string, unknown>): AgentItem => ({ id, ...rest }) as unknown as AgentItem

const LONG =
  'The worktree list is showing branches that were deleted on the remote. Can you find where we read them and only keep the ones that still resolve?'

const render = async (turns: readonly Turn[], query = '') => {
  const session = { id: 's1', cwd: '/work/storefront', turns, usage: null } as unknown as Session
  const snapshot = {
    ...emptySnapshot(),
    activeSessionKey: 'k1',
    sessions: new Map([['k1', session]]),
  } as unknown as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <Trajectory query={query} timedOnly={false} onFoot={vi.fn()} />
      </StoreProvider>,
    )
  })
}

const TURN = {
  id: turnId('t1'),
  status: 'inProgress',
  diff: null,
  items: [
    item('i1', { type: 'userMessage', content: [{ type: 'text', text: LONG }] }),
    item('i2', { type: 'command', command: 'git worktree list --porcelain', status: 'completed', durationMs: 1400, actions: [] }),
    item('i3', { type: 'subagent', action: 'spawn', status: 'completed', prompt: null, members: [{ sessionId: 'c1', nickname: 'Reviewer' }] }),
    item('i4', {
      type: 'publication',
      reference: { kind: 'pullRequest', action: 'opened', repo: 'o/r', number: 12, url: 'https://example.com/12', via: 'gh', state: 'open', title: 'Retry on 502' },
    }),
  ],
} as unknown as Turn

const rows = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-slot="inspector-row"]')]
const leads = (): string[] => rows().map((row) => row.firstElementChild?.textContent ?? '')

it('says who produced each step in sentence case, never in capitals', async () => {
  await render([TURN])
  expect(leads()).toEqual(['You', 'Shell', 'Sub-agent', 'Post'])
  for (const row of rows()) {
    const lead = row.firstElementChild as HTMLElement
    expect(lead.dataset['role']).toBe('meta')
    // Nothing in the row sets its words in capitals, however it is spelled.
    expect(row.querySelectorAll('[class*="uppercase"]')).toHaveLength(0)
    expect(lead.className).not.toContain('uppercase')
  }
})

it('keeps a message whole and lets the row ellipsise it, rather than cutting it at 80 characters', async () => {
  await render([TURN])
  const label = rows()[0]?.querySelector(`.${styles.label}`)
  expect(label?.textContent).toBe(LONG)
  // The cut is the stylesheet's, at whatever width the panel has.
  expect(sheet).toMatch(/\.label\s*\{[^}]*text-overflow:\s*ellipsis/s)
  expect(sheet).toMatch(/\.label\s*\{[^}]*white-space:\s*nowrap/s)
})

it('keeps each turn heading on the panel while its rows scroll, with its state in words', async () => {
  await render([TURN, { ...TURN, id: turnId('t2'), status: 'interrupted' } as Turn])
  const heads = [...container.querySelectorAll<HTMLElement>('[data-slot="inspector-group"][data-sticky]')]
  expect(heads.map((head) => head.textContent)).toEqual(['Turn 1running', 'Turn 2stopped'])
  expect(container.textContent).not.toContain('inProgress')
  expect(container.textContent).not.toContain('interrupted')
})

it('names a sub-agent and a publication in words, not by their wire type', async () => {
  await render([TURN])
  const titles = rows().map((row) => row.getAttribute('title'))
  expect(titles[2]).toBe('Handed to Reviewer')
  expect(titles[3]).toBe('Opened a pull request #12 · Retry on 502')
  expect(container.textContent).not.toMatch(/\bsubagent\b|\bpublication\b|\bspawn\b/)
})

it('finds a step by the role a reader sees, in any case', async () => {
  await render([TURN], 'SHELL')
  expect(leads()).toEqual(['Shell'])
})

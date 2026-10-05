import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { turnId, wrapContext, type AgentItem, type Session, type Turn } from '@harnessdesk/protocol'

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

const render = async (turns: readonly Turn[], query = '', timedOnly = false, onFoot = vi.fn()) => {
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
        <Trajectory query={query} timedOnly={timedOnly} onFoot={onFoot} />
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

it('keeps a message whole and allows the sentence to wrap instead of ellipsising it', async () => {
  await render([TURN])
  const label = rows()[0]?.querySelector(`.${styles.label}`)
  expect(label?.textContent).toBe(LONG)
  expect(sheet).toMatch(/\.messageLabel\s*\{[^}]*-webkit-line-clamp:\s*3/s)
  expect(sheet).not.toMatch(/\.messageLabel\s*\{[^}]*text-overflow:\s*ellipsis/s)
  expect(rows()[0]?.getAttribute('title')).toBe(LONG)
})

it('uses summed turn wall time and shows the waiting remainder beside measured commands', async () => {
  const timed = {
    ...TURN,
    status: 'completed',
    durationMs: 60 * 60_000,
    items: [
      item('command-1', { type: 'command', command: 'first', durationMs: 20 * 60_000 }),
      item('command-2', { type: 'command', command: 'second', durationMs: 16 * 60_000 }),
    ],
  } as unknown as Turn
  const onFoot = vi.fn()
  await render([timed], '', false, onFoot)
  const overview = container.querySelector('[aria-label="Where the time went"]')
  expect(overview?.textContent).toContain('60m · 36m in commands')
  expect(overview?.textContent).toContain('Model and waiting24m')
  const parts = [...(overview?.querySelectorAll<HTMLElement>('[data-slot="progress-stack-part"]') ?? [])]
  expect(parts.map((part) => part.style.width)).toEqual(['60%', '40%'])
  expect(onFoot).toHaveBeenLastCalledWith('2 steps', '60m · 36m in commands')
})

it('caps measured time at wall time and names overlapping measurements in the title', async () => {
  const timed = {
    ...TURN,
    status: 'completed',
    durationMs: 30 * 60_000,
    items: [item('command-1', { type: 'command', command: 'long', durationMs: 45 * 60_000 })],
  } as unknown as Turn
  const onFoot = vi.fn()
  await render([timed], '', false, onFoot)
  const overview = container.querySelector('[aria-label="Where the time went"]')
  expect(overview?.textContent).toContain('30m · 30m in commands')
  expect(overview?.textContent).not.toContain('Model and waiting')
  expect(overview?.querySelector('[data-slot="progress-stack"]')?.getAttribute('title')).toMatch(/overlap/i)
  expect(onFoot).toHaveBeenLastCalledWith('1 step', '30m · 30m in commands')
})

it('caps overlap independently for completed turns with different overlap ratios', async () => {
  const first = {
    ...TURN,
    id: turnId('first-overlap'),
    status: 'completed',
    durationMs: 10 * 60_000,
    items: [item('first-command', { type: 'command', command: 'first', durationMs: 20 * 60_000 })],
  } as unknown as Turn
  const second = {
    ...TURN,
    id: turnId('second-overlap'),
    status: 'completed',
    durationMs: 20 * 60_000,
    items: [item('second-command', { type: 'command', command: 'second', durationMs: 30 * 60_000 })],
  } as unknown as Turn
  await render([first, second])
  const overview = container.querySelector('[aria-label="Where the time went"]')
  expect(overview?.textContent).toContain('30m · 30m in commands')
  expect(overview?.querySelector('[data-slot="progress-stack"]')?.getAttribute('title')).toMatch(/overlap/i)
})

it('keeps the item-based measured summary when turn wall time is unavailable', async () => {
  const timed = {
    ...TURN,
    items: [item('command-1', { type: 'command', command: 'first', durationMs: 36 * 60_000 })],
  } as unknown as Turn
  const onFoot = vi.fn()
  await render([timed], '', false, onFoot)
  expect(container.querySelector('[aria-label="Where the time went"]')).toBeNull()
  expect(onFoot).toHaveBeenLastCalledWith('1 step', '')
})

it('uses the ACP turn wall time as the remainder when ACP items have no durations', async () => {
  // ACP tool updates carry status, not item durationMs; the turn has its own
  // wall clock duration from send() through completion.
  const acpTurn = {
    ...TURN,
    status: 'completed',
    durationMs: 10 * 60_000,
    items: [
      item('acp-user', { type: 'userMessage', content: [{ type: 'text', text: 'inspect this issue' }] }),
      item('acp-tool', { type: 'toolCall', tool: 'Read', source: { kind: 'builtin' }, status: 'completed', args: {} }),
    ],
  } as unknown as Turn
  await render([acpTurn])
  const overview = container.querySelector('[aria-label="Where the time went"]')
  expect(overview?.textContent).toContain('10m · no measured steps')
  expect(overview?.textContent).toContain('Not measured10m')
  expect(overview?.textContent).not.toContain('0m measured')
})

it('keeps model and waiting as the remainder when every timeable step was timed', async () => {
  const acpTurn = {
    ...TURN,
    status: 'completed',
    durationMs: 10 * 60_000,
    items: [
      item('timed-tool', { type: 'toolCall', tool: 'Read', source: { kind: 'builtin' }, status: 'completed', durationMs: 2 * 60_000 }),
    ],
  } as unknown as Turn
  await render([acpTurn])
  const overview = container.querySelector('[aria-label="Where the time went"]')
  expect(overview?.textContent).toContain('Model and waiting8m')
  expect(overview?.textContent).not.toContain('Not measured')
})

it('keeps a running turn out of both sides of the time reconciliation', async () => {
  const completed = {
    ...TURN,
    status: 'completed',
    durationMs: 60 * 60_000,
    items: [item('done-command', { type: 'command', command: 'completed', durationMs: 20 * 60_000 })],
  } as unknown as Turn
  const running = {
    ...TURN,
    id: turnId('running'),
    status: 'inProgress',
    durationMs: 8 * 60_000,
    items: [item('running-command', { type: 'command', command: 'still running', durationMs: 8 * 60_000 })],
  } as unknown as Turn
  await render([completed, running])
  const overview = container.querySelector('[aria-label="Where the time went"]')
  expect(overview?.textContent).toContain('60m · 20m in commands')
  expect(overview?.textContent).toContain('Model and waiting40m')
  expect(overview?.textContent).not.toContain('68m')
})

it('shows the first line of an ACP thought body, and folds only empty thoughts', async () => {
  const acpThought = item('acp-thought', {
    type: 'reasoning', summary: [], content: ['Considering the failing branch.\nSecond private line.'],
  })
  const emptyThought = item('acp-empty-thought', { type: 'reasoning', summary: [], content: [] })
  await render([{ ...TURN, items: [acpThought, emptyThought] } as unknown as Turn])
  expect(rows().map((row) => row.textContent)).toEqual([
    'ThinkingConsidering the failing branch.',
    'Thinking1 step, no summary given',
  ])
})

it('folds consecutive reasoning without summaries, while summary rows break the fold', async () => {
  const reasoning = (id: string, summary: string[] = [], durationMs?: number) => item(id, {
    type: 'reasoning', summary, content: [], ...(durationMs === undefined ? {} : { durationMs }),
  })
  const turn = { ...TURN, items: [
    reasoning('r1', [], 100), reasoning('r2', [], 200), reasoning('r3', []),
    reasoning('r4', [' ', 'Useful summary']), reasoning('r5', []), reasoning('r6', []),
  ] } as unknown as Turn
  await render([turn])
  expect(leads()).toEqual(['Thinking', 'Thinking', 'Thinking'])
  expect(rows().map((row) => row.textContent)).toEqual([
    'Thinking3 steps, no summary given300ms',
    'ThinkingUseful summary',
    'Thinking2 steps, no summary given',
  ])
})

it('filters and times folded reasoning rows while the footer counts their real items', async () => {
  const turn = { ...TURN, items: [
    item('r1', { type: 'reasoning', summary: [], content: [], durationMs: 100 }),
    item('r2', { type: 'reasoning', summary: [], content: [], durationMs: 200 }),
    item('r3', { type: 'command', command: 'other', durationMs: 10 }),
  ] } as unknown as Turn
  const onFoot = vi.fn()
  await render([turn], 'no summary', true, onFoot)
  expect(rows()).toHaveLength(1)
  expect(rows()[0]?.textContent).toContain('2 steps, no summary given')
  expect(onFoot).toHaveBeenLastCalledWith('2 steps', '')
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

it('strips shared context envelopes from user labels across runtime transcripts', async () => {
  const turn = {
    ...TURN,
    items: [item('wrapped-user', {
      type: 'userMessage',
      content: [{ type: 'text', text: `${wrapContext('Git', 'On branch main')}\n\nFix the stale branch filter.` }],
    })],
  } as unknown as Turn
  await render([turn])
  expect(rows()[0]?.textContent).toContain('Fix the stale branch filter.')
  expect(rows()[0]?.textContent).not.toContain('<context source=')
  expect(rows()[0]?.getAttribute('title')).toBe('Fix the stale branch filter.')
})

it('keeps a recorded lookalike in the person’s trajectory label', async () => {
  const raw = `${wrapContext('Git', 'my words')}\n\nExplain it`
  await render([{ ...TURN, items: [item('forged-user', { type: 'userMessage',
    content: [{ type: 'text', text: raw, deskContext: { prefix: '' } }],
  })] } as unknown as Turn])
  expect(rows()[0]?.getAttribute('title')).toBe(raw)
})

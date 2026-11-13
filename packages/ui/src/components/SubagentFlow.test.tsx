import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { itemId, turnId, type AgentItem, type Session, type SubagentItem } from '@harnessdesk/protocol'

import { PaneProvider, StoreProvider } from '../state/context'
import { previewStore, PREVIEW_SESSION_KEY } from '../preview/harness'
import type { AppStore } from '../state/store'
import { ReadOnlyTranscript } from './Items'
import { SubagentCard, SubagentLanes, SubagentStrip } from './SubagentFlow'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const call = (id: string, action: string, status: SubagentItem['status'], members: SubagentItem['members'], extra: Partial<SubagentItem> = {}): SubagentItem =>
  ({ id: itemId(id), type: 'subagent', action, status, members, ...extra })

const NOW = Date.now()
const SPAWNS: AgentItem[] = [
  call('s1', 'spawnAgent', 'completed', [{ sessionId: 'thread-a', nickname: 'explorer', role: 'scout', state: 'running' }], { prompt: 'Find the parser', model: 'model-a', startedAt: NOW - 60_000 }),
  call('s2', 'spawnAgent', 'completed', [{ sessionId: 'thread-b', nickname: 'worker', state: 'running' }], { prompt: 'Run the tests', startedAt: NOW - 50_000 }),
  call('s3', 'spawn', 'failed', [{ sessionId: 'toolu_c', nickname: 'reviewer', state: 'failed', openable: false }], { startedAt: NOW - 40_000, completedAt: NOW - 20_000 }),
  call('w1', 'wait', 'inProgress', [{ sessionId: 'thread-a', state: 'running' }, { sessionId: 'thread-b', state: 'running' }], { startedAt: NOW - 10_000 }),
]

const storeWith = (items: readonly AgentItem[], busy = true): AppStore => {
  const seed = previewStore().getSnapshot()
  const base = seed.sessions.get(PREVIEW_SESSION_KEY)!
  const session: Session = {
    ...base,
    status: busy ? { type: 'active' } : { type: 'idle' },
    turns: [{ id: turnId('t1'), status: busy ? 'inProgress' : 'completed', items: [...items] }],
  }
  return previewStore({ ...seed, activeSessionKey: PREVIEW_SESSION_KEY, sessions: new Map([[PREVIEW_SESSION_KEY, session]]) })
}

const render = (store: AppStore, node: React.ReactNode) =>
  act(() => root.render(<StoreProvider store={store}><PaneProvider scope={{ paneId: 'p', view: { kind: 'conversation', session: PREVIEW_SESSION_KEY }, sessionKey: PREVIEW_SESSION_KEY }}>{node}</PaneProvider></StoreProvider>))

it('draws one card for every call in a stretch, with an honest rollup and a fan-in line', () => {
  const store = storeWith(SPAWNS)
  render(store, <SubagentCard items={SPAWNS} />)
  const card = container.querySelector('[data-slot="agent-flow-card"]')!
  expect(card.textContent).toContain('Started 3 sub-agents')
  expect(card.textContent).toContain('2 working')
  expect(card.textContent).toContain('1 failed')
  expect(card.querySelectorAll('[data-slot="agent-flow-child"]')).toHaveLength(3)
  expect([...card.querySelectorAll('[data-slot="agent-flow-child"]')].map(row => row.getAttribute('data-phase'))).toEqual(['working', 'working', 'failed'])
  expect(card.querySelector('[data-slot="agent-flow-waiting"]')?.textContent).toBe('Waiting for 2 agents')
  expect(card.textContent).toContain('model-a')
})

it('opens a child that has a conversation, and offers nothing for one that has none', () => {
  const store = storeWith(SPAWNS)
  const openSession = vi.fn()
  Object.assign(store, { openSession })
  render(store, <SubagentCard items={SPAWNS} />)
  const opens = [...container.querySelectorAll('button')].filter(button => button.textContent === 'Open')
  expect(opens).toHaveLength(2)
  act(() => opens[0]!.click())
  expect(openSession).toHaveBeenCalledWith('thread-a', expect.objectContaining({ runtime: expect.any(String) }))
})

it('shows what a child was asked when its name is pressed', () => {
  render(storeWith(SPAWNS), <SubagentCard items={SPAWNS} />)
  expect(container.textContent).not.toContain('Find the parser')
  const name = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('explorer'))!
  act(() => name.click())
  expect(container.textContent).toContain('Find the parser')
})

it('offers no Open in a read-only transcript', () => {
  render(storeWith(SPAWNS), <ReadOnlyTranscript><SubagentCard items={SPAWNS} /></ReadOnlyTranscript>)
  expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Open')).toBe(false)
})

it('ends the children of a settled conversation rather than showing them working for ever', () => {
  const stale = SPAWNS.slice(0, 2)
  render(storeWith(stale, false), <SubagentCard items={stale} />)
  expect(container.textContent).toContain('2 ended')
  expect(container.querySelector('[data-slot="agent-flow-card"]')?.hasAttribute('data-working')).toBe(false)
})

it('puts a strip over the composer only while children work, naming them', () => {
  const store = storeWith(SPAWNS)
  const openDetailsTab = vi.fn()
  Object.assign(store, { openDetailsTab })
  render(store, <SubagentStrip />)
  expect(container.textContent).toContain('2 sub-agents working.')
  expect(container.textContent).toContain('explorer, worker')
  act(() => [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Show'))!.click())
  expect(openDetailsTab).toHaveBeenCalledWith('agents')

  const returned = (SPAWNS.slice(2) as SubagentItem[]).map(item => (item.status === 'inProgress' ? { ...item, status: 'completed' as const } : item))
  render(storeWith(returned, false), <SubagentStrip />)
  expect(container.textContent).toBe('')
})

it('lays the children on one clock, a lane each', () => {
  render(storeWith(SPAWNS), <SubagentLanes />)
  const lanes = container.querySelectorAll('[data-slot="agent-lane"]')
  expect([...lanes].map(lane => lane.getAttribute('data-phase'))).toEqual(['working', 'working', 'failed'])
  const bars = [...container.querySelectorAll<HTMLElement>('[data-slot="agent-lane"] [data-phase]')]
  expect(bars[0]?.style.getPropertyValue('--lane-start')).toBe('0%')
  // The failed child ended halfway along the clock.
  expect(Number.parseFloat(bars[2]!.style.getPropertyValue('--lane-start'))).toBeCloseTo(33.3, 0)
  expect(container.textContent).toContain('now')
})

it('draws no lanes for a single child', () => {
  render(storeWith(SPAWNS.slice(0, 1)), <SubagentLanes />)
  expect(container.querySelector('[data-slot="agent-lanes"]')).toBeNull()
})

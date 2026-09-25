import { beforeEach, expect, it, vi } from 'vitest'

import type { FindingPage, FindingView, GoalView, HostMethodName, WireNotification } from '@harnessdesk/protocol'

import { AppStore } from './store'

const goalView = (id: string, findingPublication?: boolean): GoalView => ({
  goal: {
    id, root: '/repo', cwd: '/repo', sentence: `Finish ${id}`, state: 'open', revision: 1,
    checkout: 'shared', dependsOn: [], origin: { kind: 'person' }, createdAt: 1, updatedAt: 1, receipt: null,
    ...(findingPublication !== undefined ? { findingPublication } : {}),
  },
  activity: 'working', waitingOn: [], members: [],
  board: { id, name: `Finish ${id}`, root: '/repo', updatedAt: 1, members: [], messaging: true, intents: [], channel: [] },
  receipt: null, problem: null,
})

const findingView = (id: string): FindingView => ({
  id, origin: { goal: 'g1', run: 'run-1', round: 1, card: 1, seat: 'seat-1', at: 'a'.repeat(40) },
  ownerGoal: 'g1', title: id, body: '', category: 'ordinary', blocking: true, related: null, anchor: null,
  lifecycle: { state: 'open', confirmed: false, repairs: [] }, sequence: 1, evidence: [`ev-${id}`], posted: [],
  restored: false, problem: null,
})

const page = (rows: readonly FindingView[], next: string | null = null): FindingPage => ({
  goal: 'g1', stamp: 'stamp', rows, next, totals: { all: rows.length, open: rows.length, blocking: rows.length }, problem: null,
})

const notify = (store: AppStore, notification: WireNotification): void => {
  const transport = store.transport as unknown as { handlers: { onNotification(notification: WireNotification): void } }
  transport.handlers.onNotification(notification)
}

let store: AppStore

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
})

it('a later filter’s response wins over an earlier request answered after it', async () => {
  const answers = new Map<string, (value: FindingPage) => void>()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: { filter?: string }) => {
    if (method === 'finding/list') {
      return new Promise((resolve) => { answers.set(params.filter ?? 'all', resolve as (value: FindingPage) => void) })
    }
    throw new Error(`unexpected ${method}`)
  }) as never)

  const first = store.loadFindings('g1', 'all')
  const second = store.loadFindings('g1', 'open')

  // Resolved in reverse order: the later request (open) answers first.
  answers.get('open')!(page([findingView('open-1')]))
  await second
  expect(store.getSnapshot().findings.get('g1')?.filter).toBe('open')
  expect(store.getSnapshot().findings.get('g1')?.rows.map((one) => one.id)).toEqual(['open-1'])

  // The stale, superseded response for the earlier filter must not overwrite the current cache.
  answers.get('all')!(page([findingView('all-1'), findingView('all-2')]))
  await first
  expect(store.getSnapshot().findings.get('g1')?.filter).toBe('open')
  expect(store.getSnapshot().findings.get('g1')?.rows.map((one) => one.id)).toEqual(['open-1'])
})

it('a stale cursor answered after a fresh reload does not overwrite it', async () => {
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'finding/list') return page([findingView('f1')], 'cursor-1')
    throw new Error(`unexpected ${method}`)
  }) as never)
  await store.loadFindings('g1', 'all')
  expect(store.getSnapshot().findings.get('g1')?.next).toBe('cursor-1')

  let releaseMore!: (value: FindingPage) => void
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'finding/list') return new Promise((resolve) => { releaseMore = resolve })
    throw new Error(`unexpected ${method}`)
  }) as never)
  const more = store.loadFindings('g1', 'all', 'cursor-1')
  // A fresh (no-cursor) reload for the same Goal supersedes the in-flight "load more".
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'finding/list') return page([findingView('fresh-1')])
    throw new Error(`unexpected ${method}`)
  }) as never)
  await store.loadFindings('g1', 'all')
  releaseMore(page([findingView('f2')]))
  await more
  expect(store.getSnapshot().findings.get('g1')?.rows.map((one) => one.id)).toEqual(['fresh-1'])
})

it('a refused publication preference leaves the confirmed value in place', async () => {
  notify(store, { method: 'goal/changed', params: { view: goalView('g1', true) } })
  expect(store.getSnapshot().goals.get('g1')?.goal.findingPublication).toBe(true)

  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'finding/publication') throw new Error('This Goal changed. Read it again before saving.')
    throw new Error(`unexpected ${method}`)
  }) as never)

  await expect(store.setFindingPublication('g1', 1, false)).rejects.toThrow(/changed/)
  // Never optimistically written: the cached Goal still shows the confirmed value.
  expect(store.getSnapshot().goals.get('g1')?.goal.findingPublication).toBe(true)
})

it('a successful publication preference keeps the read-back Goal', async () => {
  notify(store, { method: 'goal/changed', params: { view: goalView('g1', true) } })
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'finding/publication') return goalView('g1', false)
    throw new Error(`unexpected ${method}`)
  }) as never)
  const result = await store.setFindingPublication('g1', 1, false)
  expect(result.goal.findingPublication).toBe(false)
  expect(store.getSnapshot().goals.get('g1')?.goal.findingPublication).toBe(false)
})

it('finding/changed coalesces into one reload of the affected Goal only, and never a Goal it is not caching', async () => {
  let calls = 0
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: { goal?: string }) => {
    if (method === 'finding/list') { calls += 1; return page([findingView(`f${calls}`)]) }
    throw new Error(`unexpected ${method}`)
  }) as never)
  await store.loadFindings('g1', 'all')
  expect(calls).toBe(1)

  // A burst of three notifications for the cached Goal, and one for a Goal nobody is looking at.
  notify(store, { method: 'finding/changed', params: { goal: 'g1', revision: 1 } })
  notify(store, { method: 'finding/changed', params: { goal: 'g1', revision: 2 } })
  notify(store, { method: 'finding/changed', params: { goal: 'g1', revision: 3 } })
  notify(store, { method: 'finding/changed', params: { goal: 'g-not-open', revision: 1 } })
  await new Promise((resolve) => setTimeout(resolve, 60))
  expect(calls, 'the burst reloaded g1 once, not three times, and never fetched the Goal nobody is caching').toBe(2)
})

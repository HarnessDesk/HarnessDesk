import { beforeEach, expect, it, vi } from 'vitest'

import type {
  GoalView,
  HostMethodName,
  Lane,
  LanePreferences,
  SeatRecord,
  WireNotification,
} from '@harnessdesk/protocol'

import { AppStore } from './store'

const view = (id: string, revision = 1, root = '/repo', activity: GoalView['activity'] = 'working'): GoalView => ({
  goal: {
    id, root, cwd: root, sentence: `Finish ${id}`, state: 'open', revision,
    checkout: 'shared', dependsOn: [], origin: { kind: 'person' }, createdAt: 1,
    updatedAt: revision, receipt: null,
  },
  activity,
  waitingOn: [],
  members: [],
  board: { id, name: `Finish ${id}`, root, updatedAt: revision, members: [], messaging: true, intents: [], channel: [] },
  receipt: null,
  problem: null,
})

const changed = (store: AppStore, next: GoalView): void => {
  const transport = store.transport as unknown as { handlers: { onNotification(notification: WireNotification): void } }
  transport.handlers.onNotification({ method: 'goal/changed', params: { view: next } })
}

let store: AppStore

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
})

it('does not let an old list or lower revision regress a live Goal and refreshes equal activity', async () => {
  let answer!: (rows: GoalView[]) => void
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'goal/list') return new Promise(resolve => { answer = resolve as typeof answer })
    return null
  }) as never)

  const pending = store.loadGoals('/repo')
  changed(store, view('g', 2, '/repo', 'needs-you'))
  answer([view('g', 1)])
  await pending
  expect(store.getSnapshot().goals.get('g')?.goal.revision).toBe(2)
  expect(store.getSnapshot().goals.get('g')?.activity).toBe('needs-you')

  changed(store, view('g', 2, '/repo', 'ready-to-wrap'))
  expect(store.getSnapshot().goals.get('g')?.activity).toBe('ready-to-wrap')
  changed(store, view('g', 1, '/repo', 'working'))
  expect(store.getSnapshot().goals.get('g')?.goal.revision).toBe(2)
  expect(store.getSnapshot().teams.get('g')?.name).toBe('Finish g')
})

it('replaces only the loaded root and keeps known rows on failure', async () => {
  const lists = new Map<string | undefined, GoalView[]>([
    ['/one', [view('one', 1, '/one')]],
    ['/two', [view('two', 1, '/two')]],
  ])
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: { root?: string }) => {
    if (method === 'goal/list') return lists.get(params.root) ?? []
    return null
  }) as never)
  await store.loadGoals('/one')
  await store.loadGoals('/two')
  lists.set('/one', [view('one-new', 1, '/one')])
  await store.loadGoals('/one')
  expect([...store.getSnapshot().goals.keys()].sort()).toEqual(['one-new', 'two'])

  vi.mocked(store.transport.request).mockRejectedValueOnce(new Error('Goal storage is unavailable.'))
  await expect(store.loadGoals('/one')).rejects.toThrow('Goal storage is unavailable.')
  expect([...store.getSnapshot().goals.keys()].sort()).toEqual(['one-new', 'two'])
  expect(store.getSnapshot().goalProblem).toBe('Goal storage is unavailable.')
})

it('uses exact Goal and lane requests and refreshes host-owned membership', async () => {
  const created = view('created')
  const seat = { id: 'seat-1', board: 'created' } as SeatRecord
  const prefs: LanePreferences = { start: 30000, width: 20, browserProfile: true }
  const lane = { id: 'lane-1', goal: 'created', seat: null, cwd: '/repo', branch: 'lane', ports: { start: 30000, end: 30019 }, browserProfile: null, state: 'retained', createdAt: 1 } as Lane
  const spy = vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    if (method === 'goal/create') return created
    if (method === 'goal/update' || method === 'goal/read') return created
    if (method === 'goal/seat' || method === 'goal/assign') return seat
    if (method === 'lane/preferences') return prefs
    if (method === 'lane/preferences/set') return params
    if (method === 'lane/list') return [lane]
    if (method === 'lane/release') return { ...lane, state: 'released' }
    return null
  }) as never)

  await store.createGoal({ root: '/repo', sentence: 'Ship it', checkout: 'isolated' })
  await store.updateGoal('created', 1, { sentence: 'Ship this' })
  await store.seatGoal({ goal: 'created', agent: 'builder' })
  await store.assignGoal('created', 3, { runtime: 'codex', sessionId: 's1' })
  await store.releaseGoal('created', 'seat-1')
  await store.loadLanePreferences()
  await store.saveLanePreferences({ start: 31000, width: 10, browserProfile: false })
  await store.releaseLane('lane-1')
  await store.ackGoalMigration()

  expect(spy.mock.calls).toEqual(expect.arrayContaining([
    ['goal/create', { root: '/repo', sentence: 'Ship it', checkout: 'isolated' }],
    ['goal/update', { goal: 'created', revision: 1, sentence: 'Ship this' }],
    ['goal/seat', { goal: 'created', agent: 'builder' }],
    ['goal/assign', { goal: 'created', card: 3, session: { runtime: 'codex', sessionId: 's1' } }],
    ['goal/release', { goal: 'created', seat: 'seat-1' }],
    ['lane/preferences', {}], ['lane/list', {}],
    ['lane/preferences/set', { start: 31000, width: 10, browserProfile: false }],
    ['lane/release', { lane: 'lane-1' }],
    ['goal/migration/ack', {}],
  ]))
  expect(spy.mock.calls.filter(([method]) => method === 'goal/read')).toHaveLength(3)
  expect(store.getSnapshot().lanePreferences).toEqual({ start: 31000, width: 10, browserProfile: false })
  expect(store.getSnapshot().lanes[0]?.state).toBe('released')
})

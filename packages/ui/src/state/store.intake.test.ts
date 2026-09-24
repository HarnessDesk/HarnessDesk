import { beforeEach, expect, it, vi } from 'vitest'

import type { WireNotification } from '@harnessdesk/protocol'

import {
  triggerArmPreview,
  triggerGoalStatus,
  triggerHistoryPage,
  triggerPreferences,
  triggerProjectView,
  triggerView,
} from '../preview/intake-fixture'
import { AppStore } from './store'

const ROOT = '/home/dev/work/storefront'

let store: AppStore
let request: ReturnType<typeof vi.fn>

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
  request = vi.fn(async () => null)
  vi.spyOn(store.transport, 'request').mockImplementation(request as never)
})

const push = (notification: WireNotification): void => {
  const transport = store.transport as unknown as {
    handlers: { onNotification(notification: WireNotification): void }
  }
  transport.handlers.onNotification(notification)
}

it("a project's triggers are read from the host, and the revision they carry is kept for invalidation", async () => {
  const view = triggerProjectView({ revision: 3 })
  request.mockResolvedValueOnce(view)
  await expect(store.projectTriggers(ROOT)).resolves.toBe(view)
  expect(request).toHaveBeenCalledWith('trigger/list', { root: ROOT })
  expect(store.getSnapshot().triggerRevisions[ROOT]).toBe(3)
})

it('previewing, arming, disarming and paging history call the exact host route', async () => {
  const preview = triggerArmPreview()
  request.mockResolvedValueOnce(preview)
  await expect(store.previewTrigger(ROOT, 'review-pr')).resolves.toBe(preview)
  expect(request).toHaveBeenLastCalledWith('trigger/preview', { root: ROOT, id: 'review-pr' })

  const armed = triggerView({ armed: true, state: 'armed' })
  request.mockResolvedValueOnce(armed)
  await expect(store.armTrigger(ROOT, 'review-pr', 'token-1')).resolves.toBe(armed)
  expect(request).toHaveBeenLastCalledWith('trigger/arm', { root: ROOT, id: 'review-pr', token: 'token-1' })

  const off = triggerView({ armed: false, state: 'off' })
  request.mockResolvedValueOnce(off)
  await expect(store.disarmTrigger(ROOT, 'review-pr')).resolves.toBe(off)
  expect(request).toHaveBeenLastCalledWith('trigger/disarm', { root: ROOT, id: 'review-pr' })

  const page = triggerHistoryPage()
  request.mockResolvedValueOnce(page)
  await expect(store.triggerHistory(ROOT, 'review-pr')).resolves.toBe(page)
  expect(request).toHaveBeenLastCalledWith('trigger/history', { root: ROOT, id: 'review-pr' })

  const page2 = triggerHistoryPage({ next: null })
  request.mockResolvedValueOnce(page2)
  await store.triggerHistory(ROOT, 'review-pr', 'cursor-1')
  expect(request).toHaveBeenLastCalledWith('trigger/history', { root: ROOT, id: 'review-pr', cursor: 'cursor-1' })
})

it("arming and disarming nudge this project's revision forward without waiting for the push", async () => {
  request.mockResolvedValueOnce(triggerView({ armed: true }))
  await store.armTrigger(ROOT, 'review-pr', 'token-1')
  const after = store.getSnapshot().triggerRevisions[ROOT]
  expect(after).toBeGreaterThan(-1)

  request.mockResolvedValueOnce(triggerView({ armed: false }))
  await store.disarmTrigger(ROOT, 'review-pr')
  expect(store.getSnapshot().triggerRevisions[ROOT]).toBeGreaterThan(after!)
})

it("a trigger/changed push only moves this project's revision forward, never back", () => {
  push({ method: 'trigger/changed', params: { project: ROOT, revision: 5 } })
  expect(store.getSnapshot().triggerRevisions[ROOT]).toBe(5)
  push({ method: 'trigger/changed', params: { project: ROOT, revision: 2 } })
  expect(store.getSnapshot().triggerRevisions[ROOT]).toBe(5)
  push({ method: 'trigger/changed', params: { project: ROOT, revision: 9 } })
  expect(store.getSnapshot().triggerRevisions[ROOT]).toBe(9)
})

it('older root reply cannot undo a newer arm', async () => {
  let answer!: (value: unknown) => void
  request.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
  const delayed = store.projectTriggers(ROOT)

  // Another window's arm is announced before this window's own list answers.
  push({ method: 'trigger/changed', params: { project: ROOT, revision: 5 } })

  // This window also arms, which bumps the revision further ahead locally.
  request.mockResolvedValueOnce(triggerView({ armed: true }))
  await store.armTrigger(ROOT, 'review-pr', 'token-1')
  const advanced = store.getSnapshot().triggerRevisions[ROOT]!
  expect(advanced).toBeGreaterThanOrEqual(6)

  // The stale list request, started before any of that, finally answers with
  // the old revision it read at the time — it must not walk the count back.
  answer(triggerProjectView({ revision: 1 }))
  await delayed
  expect(store.getSnapshot().triggerRevisions[ROOT]).toBe(advanced)
})

it('a project switch is unaffected by another project’s revision', () => {
  push({ method: 'trigger/changed', params: { project: ROOT, revision: 4 } })
  push({ method: 'trigger/changed', params: { project: '/home/dev/work/other', revision: 1 } })
  expect(store.getSnapshot().triggerRevisions[ROOT]).toBe(4)
  expect(store.getSnapshot().triggerRevisions['/home/dev/work/other']).toBe(1)
})

it('a failed arm or disarm throws in the host’s words and leaves the revision untouched', async () => {
  request.mockRejectedValueOnce(new Error('This preview has expired. Review it again before arming.'))
  await expect(store.armTrigger(ROOT, 'review-pr', 'stale-token')).rejects.toThrow('This preview has expired.')
  expect(store.getSnapshot().triggerRevisions[ROOT]).toBeUndefined()
})

it("this machine's trigger preferences are read and written with their revision, and a failed write leaves the last value", async () => {
  const prefs = triggerPreferences({ revision: 2, paused: false, dailyUsd: 20 })
  request.mockResolvedValueOnce(prefs)
  await expect(store.triggerPreferences()).resolves.toBe(prefs)
  expect(request).toHaveBeenLastCalledWith('trigger/preferences', {})

  const paused = triggerPreferences({ revision: 3, paused: true, dailyUsd: 20 })
  request.mockResolvedValueOnce(paused)
  await expect(store.setTriggerPreferences(2, true, 20)).resolves.toBe(paused)
  expect(request).toHaveBeenLastCalledWith('trigger/preferences/set', { revision: 2, paused: true, dailyUsd: 20 })
  expect(store.getSnapshot().triggerPreferences).toBe(paused)

  request.mockRejectedValueOnce(new Error('That revision is behind what is saved. Read the current value and try again.'))
  await expect(store.setTriggerPreferences(2, false, 20)).rejects.toThrow('That revision is behind')
  expect(store.getSnapshot().triggerPreferences).toBe(paused)
})

it("a trigger Goal's status is read from the host as it is, including null for an ordinary Goal", async () => {
  const status = triggerGoalStatus()
  request.mockResolvedValueOnce(status)
  await expect(store.triggerGoal('goal-pr-12')).resolves.toBe(status)
  expect(request).toHaveBeenLastCalledWith('trigger/goal', { goal: 'goal-pr-12' })

  request.mockResolvedValueOnce(null)
  await expect(store.triggerGoal('goal-ordinary')).resolves.toBeNull()
})

it('every named wait arrives keyed by its durable id, and a replayed id replaces rather than duplicates', () => {
  push({
    method: 'trigger/attention',
    params: {
      attention: {
        id: 'wait-1', goal: 'goal-pr-12', trigger: 'review-pr', kind: 'budget',
        waitingOn: { kind: 'service', label: 'the daily cap' },
        sentence: 'This Goal stopped: out of budget.', action: 'open-usage',
        createdAt: 1, resolvedAt: null, notification: 'delivered',
      },
    },
  })
  expect(Object.keys(store.getSnapshot().triggerAttention)).toEqual(['wait-1'])
  push({
    method: 'trigger/attention',
    params: {
      attention: {
        id: 'wait-1', goal: 'goal-pr-12', trigger: 'review-pr', kind: 'budget',
        waitingOn: { kind: 'service', label: 'the daily cap' },
        sentence: 'This Goal stopped: out of budget.', action: 'open-usage',
        createdAt: 1, resolvedAt: 2, notification: 'delivered',
      },
    },
  })
  expect(Object.keys(store.getSnapshot().triggerAttention)).toEqual(['wait-1'])
  expect(store.getSnapshot().triggerAttention['wait-1']!.resolvedAt).toBe(2)
})

it('setting the unattended ceiling preserves whatever the watched preference already held', async () => {
  request.mockResolvedValueOnce({ unheldCeilings: { watched: 'seat' } })
  request.mockResolvedValueOnce(null)
  await store.setUnattendedCeilings('seat')
  expect(request).toHaveBeenLastCalledWith('app/state/set', { patch: { unheldCeilings: { watched: 'seat', unattended: 'seat' } } })
})

it('setting the unattended ceiling with no prior watched value writes only what it knows', async () => {
  request.mockResolvedValueOnce({})
  request.mockResolvedValueOnce(null)
  await store.setUnattendedCeilings('refuse')
  expect(request).toHaveBeenLastCalledWith('app/state/set', { patch: { unheldCeilings: { unattended: 'refuse' } } })
})

it('reading the unattended ceiling defaults to refuse and never throws', async () => {
  request.mockResolvedValueOnce({ unheldCeilings: { watched: 'refuse', unattended: 'seat' } })
  await expect(store.loadUnattendedCeilings()).resolves.toBe('seat')

  request.mockRejectedValueOnce(new Error('offline'))
  await expect(store.loadUnattendedCeilings()).resolves.toBe('refuse')
})

it('reconnecting leaves recorded trigger attention and revisions as they were', () => {
  push({ method: 'trigger/changed', params: { project: ROOT, revision: 3 } })
  const transport = store.transport as unknown as { handlers: { onStatus(status: 'open' | 'closed'): void } }
  transport.handlers.onStatus('closed')
  transport.handlers.onStatus('open')
  expect(store.getSnapshot().triggerRevisions[ROOT]).toBe(3)
})

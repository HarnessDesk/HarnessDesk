import { beforeEach, expect, it, vi } from 'vitest'

import type { CaptureHealth, HostMethodName, WireNotification } from '@harnessdesk/protocol'

import { AppStore } from './store'

const ROOT = '/work/project'
const SHA = 'a'.repeat(40)
const health = (over: Partial<CaptureHealth> = {}): CaptureHealth => ({
  project: ROOT, enabled: true, state: 'healthy', reason: 'Current.', nextStep: 'None.', checkedAt: 1, lastCapturedAt: 1, pending: 0, gaps: 0, revision: 1, ...over,
})

let store: AppStore
let request: ReturnType<typeof vi.fn>
const notify = (notification: WireNotification) => (store.transport as unknown as { handlers: { onNotification(value: WireNotification): void } }).handlers.onNotification(notification)
const handlers = () => (store.transport as unknown as { handlers: { onStatus(value: 'open' | 'closed' | 'reconnecting'): void } }).handlers
const push = (value: CaptureHealth) => notify({ method: 'provenance/changed', params: { project: value.project, revision: value.revision, health: value } })
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
  request = vi.fn(async (_method: HostMethodName) => null)
  vi.spyOn(store.transport, 'request').mockImplementation(request as never)
})

it('uses typed provenance verbs and retains health supplied by a commit batch', async () => {
  const page = { project: ROOT, revision: 1, health: health(), commits: [] }
  request.mockResolvedValueOnce(page)
  await expect(store.readProvenance(ROOT, [SHA])).resolves.toBe(page)
  expect(request).toHaveBeenLastCalledWith('provenance/commits', { root: ROOT, shas: [SHA] })
  expect(store.getSnapshot().captureHealth.get(ROOT)).toBe(page.health)
  await store.readProvenanceSeat(ROOT, 'seat-1')
  expect(request).toHaveBeenLastCalledWith('provenance/seat', { root: ROOT, seat: 'seat-1' })
})

it('rejects an older pushed health revision and persists capture actions through their own verbs', async () => {
  const newest = health({ revision: 3, state: 'degraded' })
  notify({ method: 'provenance/changed', params: { project: ROOT, revision: 3, health: newest } })
  notify({ method: 'provenance/changed', params: { project: ROOT, revision: 2, health: health({ revision: 2 }) } })
  expect(store.getSnapshot().captureHealth.get(ROOT)).toBe(newest)
  request.mockResolvedValueOnce(health({ revision: 4, enabled: false, state: 'stopped' }))
  await store.setCapture(ROOT, false)
  expect(request).toHaveBeenLastCalledWith('provenance/capture', { root: ROOT, enabled: false })
  request.mockResolvedValueOnce(health({ revision: 5 }))
  await store.retryCapture(ROOT)
  expect(request).toHaveBeenLastCalledWith('provenance/retry', { root: ROOT })
})

it('a late status read and an older notification cannot replace newer health', async () => {
  const pending = deferred<readonly CaptureHealth[]>()
  request.mockReturnValueOnce(pending.promise)
  const read = store.loadCaptureHealth(ROOT)
  const newest = health({ revision: 5, state: 'degraded' })
  push(newest); push(health({ revision: 4 })); pending.resolve([health({ revision: 1 })])
  await read
  expect(store.getSnapshot().captureHealth.get(ROOT)).toBe(newest)
  expect(store.getSnapshot().provenanceRevision.get(ROOT)).toBe(5)
})

it('an authoritative list removes forgotten projects but preserves notifications received during its read', async () => {
  push(health()); push(health({ project: '/work/forgotten' }))
  const pending = deferred<readonly CaptureHealth[]>(); request.mockReturnValueOnce(pending.promise)
  const read = store.loadCaptureHealth()
  const arrived = health({ project: '/work/new', revision: 2 }); push(arrived)
  pending.resolve([health()]); await read
  expect([...store.getSnapshot().captureHealth.keys()].sort()).toEqual(['/work/new', ROOT])
  expect(store.getSnapshot().provenanceRevision.has('/work/forgotten')).toBe(false)
})

it('disconnect clears health and rejects stale response application; reconnect reads once', async () => {
  push(health({ revision: 50 }))
  const pending = deferred<readonly CaptureHealth[]>(); request.mockReturnValueOnce(pending.promise)
  const read = store.loadCaptureHealth(); handlers().onStatus('reconnecting'); pending.resolve([health({ revision: 90 })]); await read
  expect(store.getSnapshot().captureHealth.size).toBe(0)
  request.mockResolvedValue( [health({ revision: 1 })] )
  const before = request.mock.calls.length; handlers().onStatus('open'); handlers().onStatus('open'); await Promise.resolve()
  expect(request.mock.calls.length - before).toBe(1)
  expect(store.getSnapshot().provenanceRevision.get(ROOT)).toBe(1)
})

it('a later complete list owns pruning even when an earlier request arrives last', async () => {
  const first = deferred<readonly CaptureHealth[]>(); request.mockReturnValueOnce(first.promise)
  const old = store.loadCaptureHealth(); request.mockResolvedValueOnce([health()]); await store.loadCaptureHealth()
  first.resolve([health({ project: '/work/forgotten', revision: 20 })]); await old
  expect([...store.getSnapshot().captureHealth.keys()]).toEqual([ROOT])
})

it('status errors reject to the view without manufacturing healthy capture', async () => {
  request.mockRejectedValueOnce(new Error('private path'))
  await expect(store.loadCaptureHealth(ROOT)).rejects.toThrow('private path')
  expect(store.getSnapshot().captureHealth.size).toBe(0)
})

it('preference writes keep the saved setting until success and leave it intact on failure', async () => {
  const off = health({ enabled: false, state: 'stopped' }); push(off)
  const pending = deferred<CaptureHealth>(); request.mockReturnValueOnce(pending.promise)
  const write = store.setCapture(ROOT, true); expect(store.getSnapshot().captureHealth.get(ROOT)).toBe(off)
  pending.reject(new Error('read only')); await expect(write).rejects.toThrow('read only')
  expect(store.getSnapshot().captureHealth.get(ROOT)).toBe(off)
  const on = health({ revision: 2 }); request.mockResolvedValueOnce(on)
  await expect(store.setCapture(ROOT, true)).resolves.toBe(on)
  expect(request).toHaveBeenLastCalledWith('provenance/capture', { root: ROOT, enabled: true })
  expect(store.getSnapshot().captureHealth.get(ROOT)).toBe(on)
})

it('retry uses its own verb and an action response from a disconnected generation is discarded', async () => {
  const pending = deferred<CaptureHealth>(); request.mockReturnValueOnce(pending.promise)
  const action = store.retryCapture(ROOT); expect(request).toHaveBeenLastCalledWith('provenance/retry', { root: ROOT })
  handlers().onStatus('closed'); pending.resolve(health({ revision: 99 })); await action
  expect(store.getSnapshot().captureHealth.size).toBe(0)
})

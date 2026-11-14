import { expect, it, vi } from 'vitest'
import { AppStore } from './store'

it('projects acknowledged feature choices and fences services on a host problem', async () => {
  const store = new AppStore('ws://localhost:0/')
  let acknowledged: import('@harnessdesk/protocol').DeskFeatureState = { lead: true, mobile: true }
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'lead/chats/control') return { project: null, chats: [] }
    if (method === 'phone/state') return { enabled: true, deskName: 'Studio', deskId: 'demo', port: 4455, relay: 'off', devices: [], pending: [] }
    return acknowledged
  }) as never)
  await store.setFeature('lead', true)
  expect(request).toHaveBeenCalledWith('app/features/set', { feature: 'lead', enabled: true })
  expect(store.getSnapshot().features).toEqual({ lead: true, mobile: true })
  acknowledged = { lead: true, mobile: true, problem: { kind: 'transition', message: 'Repair required.' } }
  await store.loadFeatures()
  expect(store.getSnapshot().leadAvailable).toBe(false)
  expect(store.getSnapshot().phoneLink).toBe(false)
  expect(store.phone.state.enabled).toBe(false)
})
it('propagates a failed save without changing the acknowledged choice', async () => {
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockRejectedValue(new Error('Could not save.'))
  await expect(store.setFeature('mobile', true)).rejects.toThrow('Could not save.')
  expect(store.getSnapshot().features).toBeNull()
})
it('remote changes supersede an in-flight hydration and clear clients immediately', async () => {
  const store = new AppStore('ws://localhost:0/')
  let resolve!: (state: { lead: boolean; mobile: boolean }) => void
  vi.spyOn(store.transport, 'request').mockImplementation((async () => new Promise(yes => { resolve = yes })) as never)
  const read = store.loadFeatures()
  const emit = (store.transport as unknown as { handlers: { onNotification(value: unknown): void } }).handlers.onNotification
  emit({ method: 'app/features/changed', params: { lead: false, mobile: false } })
  resolve({ lead: true, mobile: true }); await read
  expect(store.getSnapshot().features).toEqual({ lead: false, mobile: false })
  expect(store.phone.state.enabled).toBe(false)
})

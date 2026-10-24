import { expect, it, vi } from 'vitest'
import { AppStore } from './store'
it('keeps HarnessDesk mutations separate from runtime account credentials', async () => {
  const store = new AppStore('ws://localhost:0/')
  const status = { status: 'signedIn', account: { name: 'Jane Doe', email: 'jane@example.com', pictureUrl: null }, desk: { name: 'Demo desk', reachable: true }, phones: [] }
  const request = vi.spyOn(store.transport, 'request').mockResolvedValue(status as never)
  await store.signInToHarnessDesk()
  expect(request).toHaveBeenLastCalledWith('account/signIn', {})
  expect(store.getSnapshot().harnessDeskAccount).toEqual(status)
  await store.renameHarnessDesk('Demo laptop')
  expect(request).toHaveBeenLastCalledWith('account/renameDesk', { name: 'Demo laptop' })
  await store.setHarnessDeskReachable(false)
  expect(request).toHaveBeenLastCalledWith('account/setReachable', { reachable: false })
  await store.unlinkHarnessDeskPhone('AAAAAAAAAAAAAAAAAAAAAA')
  expect(request).toHaveBeenLastCalledWith('account/unlinkPhone', { deviceId: 'AAAAAAAAAAAAAAAAAAAAAA' })
  await store.signOutOfHarnessDesk()
  expect(request).toHaveBeenLastCalledWith('account/signOut', {})
  expect(store.getSnapshot().accountsByRuntime).toEqual({})
})

it('does not replace a pushed sign-in with an older status read', async () => {
  const store = new AppStore('ws://localhost:0/')
  let resolve!: (value: unknown) => void
  vi.spyOn(store.transport, 'request').mockImplementation(() => new Promise(done => { resolve = done }) as never)
  const reading = store.loadHarnessDeskAccount()
  const status = { status: 'signedIn', account: { name: 'Jane Doe', email: 'jane@example.com', pictureUrl: null }, desk: { name: 'Demo desk', reachable: false }, phones: [] }
  const handlers = (store.transport as unknown as { handlers: { onNotification: (value: unknown) => void } }).handlers
  handlers.onNotification({ method: 'account/changed', params: { status } })
  resolve({ status: 'signedOut', desk: status.desk, phones: [] })
  await reading
  expect(store.getSnapshot().harnessDeskAccount).toEqual(status)
})

it('refreshes the HarnessDesk account after the socket reconnects', async () => {
  const store = new AppStore('ws://localhost:0/')
  const load = vi.spyOn(store, 'loadHarnessDeskAccount').mockResolvedValue()
  vi.spyOn(store, 'loadCaptureHealth').mockResolvedValue()
  const handlers = (store.transport as unknown as { handlers: { onStatus: (value: string) => void } }).handlers
  handlers.onStatus('reconnecting')
  handlers.onStatus('open')
  expect(load).toHaveBeenCalledOnce()
})

it('opens the local desk without waiting for a cloud account status read', async () => {
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'connect').mockImplementation(() => {})
  vi.spyOn(store.transport, 'status', 'get').mockReturnValue('open')
  vi.spyOn(store.transport, 'request').mockResolvedValue({ runtimes: [] } as never)
  for (const method of ['loadHistory', 'loadPreferences', 'refreshRuntime', 'loadWorkspaces', 'loadPlugins', 'loadAccounts', 'loadGoals', 'loadUsage'] as const) {
    vi.spyOn(store, method).mockResolvedValue(undefined as never)
  }
  const cloud = vi.spyOn(store, 'loadHarnessDeskAccount').mockImplementation(() => new Promise(() => {}))
  let opened = false
  void store.connect().then(() => { opened = true })
  for (let pass = 0; pass < 20; pass += 1) await Promise.resolve()
  expect(cloud).toHaveBeenCalledOnce()
  expect(opened).toBe(true)
})

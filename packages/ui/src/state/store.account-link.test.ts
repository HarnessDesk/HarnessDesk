import { expect, it, vi } from 'vitest'
import type { WireNotification } from '@harnessdesk/protocol'
import { AppStore } from './store'

const rig = () => {
  const store = new AppStore('ws://localhost:0/')
  const handlers = (store.transport as unknown as { handlers: { onStatus(s: string): void; onNotification(n: WireNotification): void } }).handlers
  vi.spyOn(store.transport, 'connect').mockImplementation(() => handlers.onStatus('open'))
  vi.spyOn(store.transport, 'status', 'get').mockReturnValue('open')
  for (const method of ['loadHistory', 'loadPreferences', 'refreshRuntime', 'loadWorkspaces', 'loadPlugins', 'loadAccounts', 'loadGoals', 'loadUsage', 'loadCaptureHealth'] as const) vi.spyOn(store, method).mockResolvedValue(undefined as never)
  const request = vi.spyOn(store.transport, 'request').mockResolvedValue(null as never)
  return { store, handlers, request }
}
it('reads account state only with the hello capability and handles pushed states', async () => {
  for (const available of [false, true]) {
    const { store, handlers, request } = rig()
    request.mockImplementation((async (method: string) => method === 'host/hello' ? { runtimes: [], capabilities: available ? { accountLink: true } : {} } : { status: 'idle' }) as never)
    await store.connect()
    expect(store.getSnapshot().accountLinkAvailable).toBe(available)
    expect(request.mock.calls.some(([method]) => method === 'account/link/state')).toBe(available)
    if (available) {
      handlers.onNotification({ method: 'account/link/changed', params: { status: 'linked', deskId: 'desk', linkedAt: 1 } })
      expect(store.accountLink.state.status).toBe('linked')
    }
    handlers.onStatus('closed'); expect(store.getSnapshot().accountLinkAvailable).toBe(false); expect(store.accountLink.state.status).toBe('unavailable')
  }
})
it('a hello response arriving after disconnect cannot enable account linking', async () => {
  const { store, handlers, request } = rig()
  let resolve!: (value: unknown) => void
  request.mockImplementation((async (method: string) => method === 'host/hello' ? new Promise(r => { resolve = r }) : null) as never)
  const connecting = store.connect()
  await vi.waitFor(() => expect(resolve).toBeDefined())
  handlers.onStatus('closed'); resolve({ runtimes: [], capabilities: { accountLink: true } }); await connecting
  expect(store.getSnapshot().accountLinkAvailable).toBe(false)
  expect(request.mock.calls.some(([method]) => method === 'account/link/state')).toBe(false)
})

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtimeId, type HostMethodName } from '@harnessdesk/protocol'
import { AppStore } from './store'
import { dockViews } from './workbench'

beforeEach(() => {
  vi.stubGlobal('innerWidth', 1440)
  vi.stubGlobal('innerHeight', 900)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
const rig = async () => {
  const store = new AppStore('ws://localhost:0/')
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'workspace/open') return { path: '/work/storefront', name: 'Storefront', lastOpenedAt: 1 }
    if (method === 'terminal/open') return { terminalId: 'fixture-pty', runtime: runtimeId('fixture') }
    return null
  }) as never)
  await store.selectRuntime(runtimeId('fixture'))
  await store.openWorkspace('/work/storefront')
  return { store, request }
}
it('initial viewport and height-only changes are atomic; width compatibility preserves height', async () => {
  const { store } = await rig()
  expect(store.getSnapshot().windowHeight).toBe(900)
  store.setWindowSize(1440, 239)
  expect(store.getSnapshot()).toMatchObject({ windowWidth: 1440, windowHeight: 239 })
  store.setWindowWidth(1000)
  expect(store.getSnapshot()).toMatchObject({ windowWidth: 1000, windowHeight: 239, narrowWindow: false })
})
it('239 refuses before allocating a PTY, while 240 admits it', async () => {
  const { store, request } = await rig()
  store.setWindowSize(1440, 239)
  await store.openTerminal()
  expect(request.mock.calls.filter(([method]) => method === 'terminal/open')).toHaveLength(0)
  expect(store.getSnapshot().notices.at(-1)?.message).toBe('The terminal needs a window at least 240px tall.')
  store.setWindowSize(1440, 240)
  await store.openTerminal()
  expect(dockViews(store.getSnapshot().workbench.bottom)[0]?.view).toMatchObject({ terminalId: 'fixture-pty' })
})
it('passive shrink retains an existing PTY and a pending admission without releasing them', async () => {
  const { store, request } = await rig()
  await store.openTerminal()
  const held = dockViews(store.getSnapshot().workbench.bottom)[0]!
  const requested = store.getSnapshot().workbench.bottom.size
  store.setWindowSize(1440, 239)
  expect(dockViews(store.getSnapshot().workbench.bottom)[0]).toBe(held)
  expect(store.getSnapshot().workbench.bottom.size).toBe(requested)
  expect(request.mock.calls.filter(([method]) => method === 'terminal/close')).toHaveLength(0)
  store.setWindowSize(1440, 900)
  let resolve!: (value: unknown) => void
  request.mockImplementation((async (method: HostMethodName) => method === 'terminal/open' ? await new Promise(done => { resolve = done }) : null) as never)
  const opening = store.openTerminal()
  store.setWindowSize(1440, 239)
  await store.openTerminal() // Refused admission must not invalidate the already pending epoch.
  resolve({ terminalId: 'fixture-pending-pty', runtime: runtimeId('fixture') })
  await opening
  expect(dockViews(store.getSnapshot().workbench.bottom)).toHaveLength(2)
  expect(request.mock.calls.filter(([method]) => method === 'terminal/close')).toHaveLength(0)
  store.setWindowSize(1440, 900)
  expect(store.getSnapshot().workbench.bottom.size).toBe(requested)
})

import { afterEach, expect, it, vi } from 'vitest'
import { AppStore } from './store'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('renegotiates on reconnect and fences the previous connection reply', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000)
  const store = new AppStore('ws://localhost:0/')
  const handlers = (store.transport as unknown as { handlers: { onStatus(status: string): void } }).handlers
  vi.spyOn(store.transport, 'status', 'get').mockReturnValue('open')
  const replies: ((value: unknown) => void)[] = []
  const request = vi.spyOn(store.transport, 'request').mockImplementation(((method: string) => {
    if (method === 'host/hello') return Promise.resolve({ capabilities: { hostClock: true } })
    if (method === 'host/clock') return new Promise(resolve => replies.push(resolve))
    return Promise.reject(new Error('not used'))
  }) as never)
  handlers.onStatus('reconnecting'); handlers.onStatus('open')
  await Promise.resolve(); await Promise.resolve()
  expect(request.mock.calls.filter(([method]) => method === 'host/clock')).toHaveLength(1)
  handlers.onStatus('reconnecting'); handlers.onStatus('open')
  await Promise.resolve(); await Promise.resolve()
  expect(request.mock.calls.filter(([method]) => method === 'host/clock')).toHaveLength(2)
  replies[0]!({ hostNowMs: 100_000, clockEpoch: 'old' }); await Promise.resolve()
  expect(store.hostTime()).toBeNull()
  replies[1]!({ hostNowMs: 200_000, clockEpoch: 'new' }); await Promise.resolve()
  expect(store.hostTime()?.lowerMs).toBe(200_000)
  handlers.onStatus('closed')
})

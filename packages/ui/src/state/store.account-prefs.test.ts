import { beforeEach, expect, it, vi } from 'vitest'

import type { HostMethodName } from '@harnessdesk/protocol'

import { AppStore } from './store'

let store: AppStore
let writes: unknown[]

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
  writes = []
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    if (method === 'app/state/set') writes.push(params)
    return null
  }) as never)
})

it('persists a pinned usage lane and clears it back to automatic', () => {
  const key = 'claude:oauth:dev@example.com'
  store.setAccountPrefs(key, { pinLaneId: 'weekly' })

  expect(store.getSnapshot().accountPrefs[key]).toEqual({ pinLaneId: 'weekly' })
  expect(writes.at(-1)).toEqual({ patch: { accountPrefs: { [key]: { pinLaneId: 'weekly' } } } })

  store.setAccountPrefs(key, { pinLaneId: '' })

  expect(store.getSnapshot().accountPrefs[key]).toBeUndefined()
  expect(writes.at(-1)).toEqual({ patch: { accountPrefs: {} } })
})

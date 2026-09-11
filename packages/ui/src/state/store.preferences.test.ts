import { beforeEach, expect, it, vi } from 'vitest'

import type { HostMethodName } from '@harnessdesk/protocol'

import { AppStore } from './store'

/**
 * A preference that does not reach the host says so.
 *
 * Every setting is applied locally first, so for a moment the window is
 * showing a value the host has not accepted. The host's answer used to be
 * thrown away — `.catch(() => {})` on every write — so a refused write or a
 * socket that dropped mid-write left the new value on screen and the old one
 * in the file, and nothing said so until a relaunch put the old value back
 * (#203). The value stays where the user put it; what changes is that the
 * window stops claiming it is saved.
 */

let store: AppStore
let refuse: boolean

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
  refuse = false
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'app/state/set' && refuse) throw new Error('the host is not taking writes')
    return null
  }) as never)
})

const messages = (): string[] => store.getSnapshot().notices.map((notice) => notice.message)

it('says so when a preference does not reach the host', async () => {
  refuse = true
  store.setTheme('dark')
  await vi.waitFor(() => expect(messages()).toHaveLength(1))

  expect(messages()[0]).toContain('The theme could not be saved')
  expect(messages()[0]).toContain('the next launch will not have it')
  // Still where the user put it: this reports a failure, it does not fight
  // the hand that moved the control.
  expect(store.getSnapshot().theme).toBe('dark')
})

it('says nothing when the write lands', async () => {
  // The control. Same setter, same assertion shape, host accepting: if this
  // ever fails, the test above is passing for the wrong reason.
  store.setTheme('dark')
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(messages()).toEqual([])
  expect(store.getSnapshot().theme).toBe('dark')
})

it('reports every preference, not just one of them', async () => {
  // The reason this is one helper rather than a fix to one setter: whichever
  // setting nobody had got to would be the one that still failed in silence.
  refuse = true
  store.setAccent('violet')
  store.setProfile({ name: 'Jane Doe' })
  store.setBrowserPrefs({ placement: 'window' })
  await vi.waitFor(() => expect(messages()).toHaveLength(3))

  expect(messages()[0]).toContain('The accent colour could not be saved')
  expect(messages()[1]).toContain('Your profile could not be saved')
  expect(messages()[2]).toContain('The browser settings could not be saved')
})

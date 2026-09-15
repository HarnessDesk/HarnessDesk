import { beforeEach, expect, it, vi } from 'vitest'

import type { HostMethodName } from '@harnessdesk/protocol'

import type { DesktopBridge } from '../lib/desktop'
import { AppStore } from './store'

/**
 * Your name and face, as the store keeps them.
 *
 * The host merges preferences one level deep, so what matters is the shape of
 * each write: the whole profile every time, or a name sent on its own would
 * become the whole stored profile and the face would be forgotten on the next
 * launch. Pinned too: a change that changes nothing is not written, and
 * "Reset" writes the default desk, `{}`.
 */

let store: AppStore
let calls: { method: HostMethodName; params: unknown }[]
/** What the host answers, per method. Everything else is `null`. */
let answers: Partial<Record<HostMethodName, unknown>>
let setDockIcon: ReturnType<typeof vi.fn>

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
  calls = []
  answers = {}
  setDockIcon = vi.fn()
  ;(window as { harnessdesk?: Partial<DesktopBridge> }).harnessdesk = {
    setDockIcon,
  } as Partial<DesktopBridge> as DesktopBridge
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    calls.push({ method, params })
    return answers[method] ?? null
  }) as never)
})

const writes = (): unknown[] =>
  calls.filter((call) => call.method === 'app/state/set').map((call) => call.params)

it('starts as the default desk', () => {
  expect(store.getSnapshot().profile).toEqual({})
})

it('writes the whole profile, so a name sent alone cannot drop the face', () => {
  store.setProfile({ avatar: 'wizard' })
  store.setProfile({ name: 'Jane' })
  expect(store.getSnapshot().profile).toEqual({ name: 'Jane', avatar: 'wizard' })
  expect(writes()).toEqual([
    { patch: { profile: { avatar: 'wizard' } } },
    { patch: { profile: { name: 'Jane', avatar: 'wizard' } } },
  ])
})

it('writes nothing for a change that changes nothing', () => {
  store.setProfile({ name: 'Jane' })
  store.setProfile({ name: '  Jane ' })
  store.setProfile({ avatar: null })
  store.setProfile({})
  expect(writes()).toHaveLength(1)
})

it('resets to the default desk', () => {
  store.setProfile({ name: 'Jane', avatar: 'dj' })
  store.setProfile({ name: null, avatar: null })
  expect(store.getSnapshot().profile).toEqual({})
  expect(writes().at(-1)).toEqual({ patch: { profile: {} } })
})

it('syncs avatar changes and reset with the optional desktop Dock bridge', () => {
  store.setProfile({ avatar: 'wizard' })
  store.setProfile({ name: 'Jane' })
  store.setProfile({ avatar: null })
  expect(setDockIcon).toHaveBeenCalledWith('wizard')
  expect(setDockIcon).toHaveBeenLastCalledWith(null)
  expect(setDockIcon).toHaveBeenCalledTimes(2)
})

it('persists the profile when the optional desktop Dock bridge throws', () => {
  setDockIcon.mockImplementationOnce(() => {
    throw new Error('Dock unavailable')
  })
  store.setProfile({ avatar: 'wizard' })
  expect(store.getSnapshot().profile).toEqual({ avatar: 'wizard' })
  expect(writes()).toEqual([{ patch: { profile: { avatar: 'wizard' } } }])
})

it('reapplies a stored avatar when preferences load', async () => {
  answers['app/state/get'] = { profile: { avatar: 'dj' } }
  await store.loadPreferences()
  expect(setDockIcon).toHaveBeenLastCalledWith('dj')
})

it('comes back on the next launch, and a file it cannot read is the default desk', async () => {
  answers['app/state/get'] = { profile: { name: 'Jane', avatar: 'wizard' } }
  await store.loadPreferences()
  expect(store.getSnapshot().profile).toEqual({ name: 'Jane', avatar: 'wizard' })

  // A hand edit this build cannot read: the seat still draws.
  answers['app/state/get'] = { profile: { name: 42 } }
  await store.loadPreferences()
  expect(store.getSnapshot().profile).toEqual({})
})

it('writes back what a later build stored, whatever this one changes', async () => {
  answers['app/state/get'] = { profile: { name: 'Jane', avatar: 'pirate', account: { id: 'a1' } } }
  await store.loadPreferences()
  store.setProfile({ name: 'JD' })
  expect(writes().at(-1)).toEqual({ patch: { profile: { name: 'JD', avatar: 'pirate', account: { id: 'a1' } } } })
})

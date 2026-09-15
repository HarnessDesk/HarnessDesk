import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  AVATAR_IDS,
  avatarResourcePath,
  createDockIconSetter,
  defaultIconPath,
} from './dock-icon.mjs'

test('maps every shipped avatar to its packaged PNG', () => {
  for (const avatar of AVATAR_IDS) {
    assert.equal(
      avatarResourcePath(avatar, '/resources/avatars/128'),
      `/resources/avatars/128/${avatar}.png`,
    )
  }
})

test('rejects malformed ids and uses the default path for reset', () => {
  assert.equal(avatarResourcePath('../secret', '/resources/avatars/128'), null)
  assert.equal(avatarResourcePath('pirate', '/resources/avatars/128'), null)
  assert.equal(
    defaultIconPath({ packaged: true, resourcesPath: '/resources', here: '/dev/electron' }),
    '/resources/app.icns',
  )
  assert.equal(
    defaultIconPath({ packaged: false, resourcesPath: '/resources', here: '/dev/electron' }),
    '/dev/build/icon.icns',
  )
})

test('sets and resets a macOS Dock icon, but ignores other platforms', () => {
  const calls = []
  const nativeImage = { createFromPath: (path) => ({ path, isEmpty: () => false }) }
  const app = { dock: { setIcon: (image) => calls.push(image.path) } }
  const set = createDockIconSetter({
    platform: 'darwin',
    app,
    nativeImage,
    avatarRoot: '/avatars',
    defaultIcon: '/default.icns',
  })

  set('wizard')
  set(null)
  assert.deepEqual(calls, ['/avatars/wizard.png', '/default.icns'])

  createDockIconSetter({
    platform: 'linux',
    app,
    nativeImage,
    avatarRoot: '/avatars',
    defaultIcon: '/default.icns',
  })('wizard')
  assert.deepEqual(calls, ['/avatars/wizard.png', '/default.icns'])
})


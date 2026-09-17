import assert from 'node:assert/strict'
import { openSync, readSync, closeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import {
  AVATAR_IDS,
  avatarResourcePath,
  createDockIconSetter,
  defaultIconPath,
} from './dock-icon.mjs'

/** The first eight bytes of every PNG, which is what Chromium looks for too. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Whether a file on disk is a PNG — the format `nativeImage` can actually decode. */
const isPng = (path) => {
  const head = Buffer.alloc(PNG.length)
  const file = openSync(path, 'r')
  try {
    return readSync(file, head, 0, head.length, 0) === head.length && head.equals(PNG)
  } finally {
    closeSync(file)
  }
}

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
  assert.equal(defaultIconPath('/app/electron/assets'), '/app/electron/assets/dockIcon.png')
})

// Every path the setter can produce is handed to `nativeImage.createFromPath`,
// which decodes PNG and JPEG and nothing else: an .icns is read as an empty
// image and silently dropped, which is how clearing a profile picture once left
// the avatar sitting on the Dock. The stubs above cannot see that, so this reads
// the files the app ships.
test('every icon the Dock can be set to is a raster nativeImage can decode', () => {
  const here = import.meta.dirname
  const defaultIcon = defaultIconPath(join(here, 'assets'))
  assert.ok(isPng(defaultIcon), `${defaultIcon} is not a PNG — a reset would be dropped`)

  const avatarRoot = resolve(here, '../../../assets/avatars/128')
  for (const avatar of AVATAR_IDS) {
    const path = avatarResourcePath(avatar, avatarRoot)
    assert.ok(isPng(path), `${path} is not a PNG`)
  }
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

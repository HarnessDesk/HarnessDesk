import assert from 'node:assert/strict'
import { openSync, readFileSync, readSync, closeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import {
  AVATAR_IDS,
  MARK_IDS,
  WHALE_IDS,
  avatarResourcePath,
  createDockIconSetter,
  defaultIconPath,
} from './dock-icon.mjs'

/** Where the two families' pictures are in the checkout, at the Dock's size. */
const ROOTS = {
  marks: resolve(import.meta.dirname, '../../../assets/brand/faces/384'),
  whales: resolve(import.meta.dirname, '../../../assets/avatars/384'),
}

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

test('maps every shipped avatar to the folder its family lives in', () => {
  const roots = { marks: '/resources/faces/384', whales: '/resources/avatars/384' }
  for (const avatar of MARK_IDS) {
    assert.equal(avatarResourcePath(avatar, roots), `/resources/faces/384/${avatar}.png`)
  }
  for (const avatar of WHALE_IDS) {
    assert.equal(avatarResourcePath(avatar, roots), `/resources/avatars/384/${avatar}.png`)
  }
  assert.deepEqual(AVATAR_IDS, [...MARK_IDS, ...WHALE_IDS])
})

// This list is a copy of the renderer's table (the comment at the top of
// dock-icon.mjs says why it has to be), and a copy is only as good as what
// holds it: a face added there and forgotten here draws on the seat and leaves
// the Dock on whatever it had. The table is TypeScript the shell cannot import,
// so it is read as text — the ids are the only thing needed, and they are one
// per line.
test('offers exactly the faces the renderer offers, in the same order', () => {
  const table = readFileSync(resolve(import.meta.dirname, '../../ui/src/lib/avatars.ts'), 'utf8')
  const ids = [...table.matchAll(/^ {2}\{ id: '([^']+)'/gmu)].map((match) => match[1])
  assert.ok(ids.length > 0, 'no ids found in the renderer table — has it moved?')
  assert.deepEqual(AVATAR_IDS, ids)
})

test('rejects malformed ids and uses the default path for reset', () => {
  const roots = { marks: '/resources/faces/384', whales: '/resources/avatars/384' }
  assert.equal(avatarResourcePath('../secret', roots), null)
  assert.equal(avatarResourcePath('pirate', roots), null)
  assert.equal(avatarResourcePath('mark-gold', roots), null)
  assert.equal(defaultIconPath('/app/electron/assets'), '/app/electron/assets/dockIcon.png')
})

// Every path the setter can produce is handed to `nativeImage.createFromPath`,
// which decodes PNG and JPEG and nothing else: an .icns is read as an empty
// image and silently dropped, which is how clearing a profile picture once left
// the avatar sitting on the Dock. The stubs above cannot see that, so this reads
// the files the app ships.
test('every icon the Dock can be set to is a raster nativeImage can decode', () => {
  const defaultIcon = defaultIconPath(join(import.meta.dirname, 'assets'))
  assert.ok(isPng(defaultIcon), `${defaultIcon} is not a PNG — a reset would be dropped`)

  for (const avatar of AVATAR_IDS) {
    const path = avatarResourcePath(avatar, ROOTS)
    assert.ok(isPng(path), `${path} is not a PNG`)
  }
})

test('sets and resets a macOS Dock icon, but ignores other platforms', () => {
  const calls = []
  const nativeImage = { createFromPath: (path) => ({ path, isEmpty: () => false }) }
  const app = { dock: { setIcon: (image) => calls.push(image.path) } }
  const avatarRoots = { marks: '/faces', whales: '/avatars' }
  const set = createDockIconSetter({
    platform: 'darwin',
    app,
    nativeImage,
    avatarRoots,
    defaultIcon: '/default.png',
  })

  set('wizard')
  set('mark-ink')
  set(null)
  assert.deepEqual(calls, ['/avatars/wizard.png', '/faces/mark-ink.png', '/default.png'])

  createDockIconSetter({
    platform: 'linux',
    app,
    nativeImage,
    avatarRoots,
    defaultIcon: '/default.png',
  })('wizard')
  assert.deepEqual(calls, ['/avatars/wizard.png', '/faces/mark-ink.png', '/default.png'])
})

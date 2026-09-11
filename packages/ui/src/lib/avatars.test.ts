import { expect, it } from 'vitest'

import { AVATARS, SHIPPED_FACES, avatarOf, avatarSrc, isAvatarId } from './avatars'

/**
 * The picker's table against the folder it draws from.
 *
 * The words are hand-written and the files are generated (`pnpm run avatars`),
 * so the two can part company silently: a face added to the folder that no
 * one can pick, or a row whose picture is gone and draws as a broken image in
 * the seat. This holds them together, with the one face left out on purpose.
 *
 * The folder is listed by the bundler rather than by `node:fs` — the renderer
 * has no filesystem, its tests included (`pnpm layering`) — and the listing is
 * the folder's, not the table's: `black`, which the table leaves out, can only
 * have come from the disk.
 */
const onDisk = Object.keys(import.meta.glob('../../../../assets/avatars/128/*.png'))
  .map((file) => file.slice(file.lastIndexOf('/') + 1, -'.png'.length))
  .sort()

it('offers every face in the folder but the one a dark surface swallows', () => {
  expect(onDisk).toContain('black')
  expect([...AVATARS.map((entry) => entry.id), 'black'].sort()).toEqual(onDisk)
})

it('can draw every face it offers', () => {
  for (const { id } of AVATARS) expect(avatarSrc(id), id).toMatch(new RegExp(`/${id}\\.png$`))
})

it('names each face once', () => {
  expect(new Set(AVATARS.map((entry) => entry.id)).size).toBe(AVATARS.length)
  expect(new Set(AVATARS.map((entry) => entry.label)).size).toBe(AVATARS.length)
  expect(avatarOf('dj')?.label).toBe('DJ')
})

it('recognises a stored id only when this build ships it', () => {
  expect(isAvatarId('wizard')).toBe(true)
  expect(isAvatarId('black')).toBe(false)
  expect(isAvatarId('Wizard')).toBe(false)
  expect(isAvatarId(42)).toBe(false)
})

it('ships exactly the faces it offers, and not the one it leaves out', () => {
  expect(SHIPPED_FACES).toEqual(AVATARS.map((entry) => entry.id).sort())
  expect(SHIPPED_FACES).not.toContain('black')
})

it('answers anything it does not ship with no picture', () => {
  for (const stored of ['black', 'pirate', { kind: 'image' }, 42, undefined, null]) expect(avatarSrc(stored)).toBeNull()
})

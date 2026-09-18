import { expect, it } from 'vitest'

import { AVATARS, SHIPPED_FACES, avatarOf, avatarSrc, isAvatarId } from './avatars'

/**
 * The picker's tables against the folders they draw from.
 *
 * The words are hand-written and the files are generated (`pnpm run avatars`
 * for the whales, `pnpm run icons` for the mark's colourways), so the two can
 * part company silently: a face added to a folder that no one can pick, or a
 * row whose picture is gone and draws as a broken image in the seat. This
 * holds them together, with the one face left out on purpose.
 *
 * The folders are listed by the bundler rather than by `node:fs` — the renderer
 * has no filesystem, its tests included (`pnpm layering`) — and the listing is
 * the folder's, not the table's: `black`, which the table leaves out, can only
 * have come from the disk.
 */
const names = (files: Readonly<Record<string, unknown>>): readonly string[] =>
  Object.keys(files)
    .map((file) => file.slice(file.lastIndexOf('/') + 1, -'.png'.length))
    .sort()

const onDisk = names(import.meta.glob('../../../../assets/avatars/128/*.png'))
const marksOnDisk = names(import.meta.glob('../../../../assets/brand/faces/128/*.png'))

it('offers every face in the folders but the one a dark surface swallows', () => {
  expect(onDisk).toContain('black')
  expect(
    [...AVATARS.map((entry) => entry.id).filter((id) => !id.startsWith('mark-')), 'black'].sort(),
  ).toEqual(onDisk)
  expect(AVATARS.map((entry) => entry.id).filter((id) => id.startsWith('mark-')).sort()).toEqual(marksOnDisk)
})

it('reads the colourways first and the whales after, which is the order the picker draws', () => {
  const ids = AVATARS.map((entry) => entry.id)
  expect(ids.slice(0, marksOnDisk.length).every((id) => id.startsWith('mark-'))).toBe(true)
  expect(ids.slice(marksOnDisk.length).some((id) => id.startsWith('mark-'))).toBe(false)
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
  expect(isAvatarId('mark-steel')).toBe(true)
  expect(isAvatarId('mark-gold')).toBe(false)
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

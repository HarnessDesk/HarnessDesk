import { describe, expect, it } from 'vitest'

import {
  applyProfile,
  DEFAULT_PROFILE_NAME,
  isDefaultProfile,
  PROFILE_NAME_MAX,
  profileName,
  readProfile,
  sameProfile,
} from './profile'

/**
 * The profile: a name and a face, stored only where they differ from the
 * default. What is pinned is what the seat and the page lean on — that the
 * default reads "HarnessDesk", that clearing a field is the way back, that a
 * value equal to the default is never stored (or "Reset" would offer to undo
 * nothing), and that a preferences file the user can edit cannot break the
 * seat.
 */

describe('the name shown', () => {
  it('is HarnessDesk until one is chosen', () => {
    expect(profileName({})).toBe(DEFAULT_PROFILE_NAME)
    expect(DEFAULT_PROFILE_NAME).toBe('HarnessDesk')
  })

  it('is the chosen one', () => {
    expect(profileName({ name: 'Jane' })).toBe('Jane')
  })
})

describe('a change', () => {
  it('tidies the name the way a person meant it', () => {
    expect(applyProfile({}, { name: '  Jane   Doe \n' })).toEqual({ name: 'Jane Doe' })
  })

  it('treats an empty name as the way back to the default', () => {
    expect(applyProfile({ name: 'Jane' }, { name: '   ' })).toEqual({})
    expect(applyProfile({ name: 'Jane' }, { name: null })).toEqual({})
  })

  it('does not store the default, so there is nothing to reset', () => {
    const profile = applyProfile({}, { name: DEFAULT_PROFILE_NAME })
    expect(profile).toEqual({})
    expect(isDefaultProfile(profile)).toBe(true)
  })

  it('cuts a long name at a character, never inside one', () => {
    const profile = applyProfile({}, { name: '🐳'.repeat(PROFILE_NAME_MAX + 10) })
    expect(profile.name).toBe('🐳'.repeat(PROFILE_NAME_MAX))
  })

  it('keeps the field it does not mention', () => {
    expect(applyProfile({ name: 'Jane' }, { avatar: 'wizard' })).toEqual({ name: 'Jane', avatar: 'wizard' })
    expect(applyProfile({ name: 'Jane', avatar: 'wizard' }, { name: 'JD' })).toEqual({
      name: 'JD',
      avatar: 'wizard',
    })
  })

  it('puts the face back to the mark on null', () => {
    expect(applyProfile({ name: 'Jane', avatar: 'wizard' }, { avatar: null })).toEqual({ name: 'Jane' })
  })
})

describe('what was stored', () => {
  it('reads anything unreadable as the default', () => {
    for (const raw of [undefined, null, 'Jane', 3, [], {}, { name: 7 }, { avatar: '' }, { avatar: null }]) {
      expect(readProfile(raw)).toEqual({})
    }
  })

  it('keeps a face this build does not ship, for the build that does', () => {
    // `black` is in the folder and not on offer here; `pirate` is a later build's.
    expect(readProfile({ name: 'Jane', avatar: 'black' })).toEqual({ name: 'Jane', avatar: 'black' })
    expect(readProfile({ avatar: 'pirate' })).toEqual({ avatar: 'pirate' })
  })

  it('keeps what a later build stored through an edit, because the write is whole', () => {
    const later = readProfile({ name: 'Jane', avatar: { kind: 'image', src: 'a.png' }, account: { id: 'a1' } })
    expect(later).toEqual({ name: 'Jane', avatar: { kind: 'image', src: 'a.png' }, account: { id: 'a1' } })
    expect(applyProfile(later, { name: 'JD' })).toEqual({
      name: 'JD',
      avatar: { kind: 'image', src: 'a.png' },
      account: { id: 'a1' },
    })
    // Choosing a face here replaces theirs — a choice, not a loss.
    expect(applyProfile(later, { avatar: 'dj' })).toEqual({ name: 'Jane', avatar: 'dj', account: { id: 'a1' } })
  })

  it('reads a real one back as it was written', () => {
    const written = applyProfile({}, { name: 'Jane', avatar: 'astronaut' })
    expect(readProfile(JSON.parse(JSON.stringify(written)))).toEqual(written)
  })
})

it('tells two profiles apart by what they show', () => {
  expect(sameProfile({ name: 'A', avatar: 'dj' }, { name: 'A', avatar: 'dj' })).toBe(true)
  expect(sameProfile({ name: 'A' }, { name: 'A', avatar: 'dj' })).toBe(false)
  expect(isDefaultProfile({ avatar: 'dj' })).toBe(false)
})

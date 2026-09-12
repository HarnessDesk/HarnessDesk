import { describe, expect, it } from 'vitest'

import {
  applyProfile,
  DEFAULT_PROFILE_NAME,
  editName,
  isDefaultProfile,
  PROFILE_NAME_MAX,
  profileName,
  readProfile,
  sameProfile,
  storedProfile,
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

  it('counts a flag as one character, the way a person does', () => {
    expect(applyProfile({}, { name: '🇺🇸'.repeat(45) }).name).toBe('🇺🇸'.repeat(PROFILE_NAME_MAX))
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
    for (const raw of [undefined, null, 'Jane', 3, [], {}, { name: 7 }, { name: '' }, { name: ' \n ' }, { avatar: '' }, { avatar: null }]) {
      expect(readProfile(raw)).toEqual({})
    }
  })

  it('keeps a face this build does not ship, for the build that does', () => {
    // `black` is in the folder and not on offer here; `pirate` is a later build's.
    expect(readProfile({ name: 'Jane', avatar: 'black' })).toEqual({ name: 'Jane', avatar: 'black' })
    expect(readProfile({ avatar: 'pirate' })).toEqual({ avatar: 'pirate' })
  })

  it('keeps what a later build stored through an edit, because the write is whole', () => {
    const stored = { name: 'Jane', avatar: { kind: 'image', src: 'a.png' }, account: { id: 'a1' } }
    const later = readProfile(stored)
    expect(later).toEqual({ name: 'Jane', avatar: { kind: 'image', src: 'a.png' }, later: { account: { id: 'a1' } } })
    // Written back as it was read, flat.
    expect(storedProfile(later)).toEqual(stored)
    expect(storedProfile(applyProfile(later, { name: 'JD' }))).toEqual({ ...stored, name: 'JD' })
    // Choosing a face here replaces theirs — a choice, not a loss.
    expect(storedProfile(applyProfile(later, { avatar: 'dj' }))).toEqual({ ...stored, avatar: 'dj' })
  })

  it('keeps a name as a later build wrote it — only an edit made here is held to this build’s rules', () => {
    // Its cap, its spacing, even the default's own spelling are that build's
    // business. Cutting, folding or dropping them on the read would lose them
    // on the next write of anything else, because the write is whole.
    const long = 'x'.repeat(PROFILE_NAME_MAX + 20)
    for (const name of [long, 'Jane  Doe', DEFAULT_PROFILE_NAME]) {
      const read = readProfile({ name, avatar: 'wizard' })
      expect(read).toEqual({ name, avatar: 'wizard' })
      expect(storedProfile(applyProfile(read, { avatar: 'dj' }))).toEqual({ name, avatar: 'dj' })
    }
    expect(applyProfile(readProfile({ name: long }), { name: long })).toEqual({ name: 'x'.repeat(PROFILE_NAME_MAX) })
  })

  it('reads a real one back as it was written', () => {
    const written = applyProfile({}, { name: 'Jane', avatar: 'astronaut' })
    expect(readProfile(JSON.parse(JSON.stringify(written)))).toEqual(written)
  })
})

/**
 * Which invisible controls a name may carry (#235).
 *
 * Two directions, and the second matters more. The controls that reorder the
 * text around them or hide inside it come out wherever a name is read — typed
 * here, read from the file, and one day supplied by an account — because no
 * name needs them. The two that are spelling stay, and a blunt "strip every
 * zero-width and bidi control" would pass everything in the first block below
 * while silently mangling every name in the second.
 */
describe('the controls a name may not carry', () => {
  const banned: [string, string][] = [
    ['left-to-right embedding', '‪'],
    ['right-to-left embedding', '‫'],
    ['pop directional formatting', '‬'],
    ['left-to-right override', '‭'],
    ['right-to-left override', '‮'],
    ['left-to-right isolate', '⁦'],
    ['right-to-left isolate', '⁧'],
    ['first strong isolate', '⁨'],
    ['pop directional isolate', '⁩'],
    ['zero-width space', '​'],
  ]

  it.each(banned)('drops the %s from a stored name', (_what, control) => {
    expect(readProfile({ name: `Jane${control}Doe` })).toEqual({ name: 'JaneDoe' })
  })

  it.each(banned)('drops the %s from a name typed here', (_what, control) => {
    expect(applyProfile({}, { name: `Jane${control}Doe` })).toEqual({ name: 'JaneDoe' })
  })

  it.each(banned)('never draws the %s, whatever path put it in the field', (_what, control) => {
    // The drawing read, for the name an account will one day hand straight to
    // the snapshot without passing `readProfile` or an edit made here.
    expect(profileName({ name: `Jane${control}Doe` })).toBe('JaneDoe')
  })

  it('reads a name that was nothing else as the default', () => {
    expect(readProfile({ name: '​‮⁩' })).toEqual({})
    expect(applyProfile({ name: 'Jane' }, { name: '⁦ ⁩' })).toEqual({})
  })

  it('sees the default through them, so "Reset" is still offered for something', () => {
    expect(applyProfile({}, { name: 'Harness​Desk' })).toEqual({})
  })

  it('spends the cap on characters a person can see', () => {
    // They come out before the forty are counted, or a name could carry ten of
    // them and lose ten of its own letters to make room.
    expect(applyProfile({}, { name: '​'.repeat(10) + 'x'.repeat(PROFILE_NAME_MAX) }).name).toBe(
      'x'.repeat(PROFILE_NAME_MAX),
    )
  })
})

describe('the controls a real name needs', () => {
  // Kept, and the reason the blunt rule was rejected: 👨‍👩‍👧 is a
  // zero-width-joiner sequence, and می‌خواهم is misspelled without the
  // non-joiner. Both must read exactly as they did before any of this existed.
  const family = '👨‍👩‍👧'
  const persian = 'می‌خواهم'

  it('holds those two examples itself, so a mangled source file cannot pass quietly', () => {
    expect([...family].filter((character) => character === '‍')).toHaveLength(2)
    expect(persian).toContain('‌')
  })

  it.each([
    ['a family emoji', family],
    ['a Persian name', persian],
  ])('keeps %s whole — read, typed and drawn', (_what, name) => {
    expect(readProfile({ name })).toEqual({ name })
    expect(applyProfile({}, { name })).toEqual({ name })
    expect(profileName({ name })).toBe(name)
  })
})

it('tells two profiles apart by what they show', () => {
  expect(sameProfile({ name: 'A', avatar: 'dj' }, { name: 'A', avatar: 'dj' })).toBe(true)
  expect(sameProfile({ name: 'A' }, { name: 'A', avatar: 'dj' })).toBe(false)
  expect(isDefaultProfile({ avatar: 'dj' })).toBe(false)
})

it('sees what a later build stored when it decides whether anything changed', () => {
  const later = { account: { id: 'a1' } }
  expect(sameProfile({ name: 'A', later }, { name: 'A', later })).toBe(true)
  expect(sameProfile({ name: 'A', later }, { name: 'A', later: { account: { id: 'a2' } } })).toBe(false)
})

it('compares what two profiles hold, not which object holds it', () => {
  // A later build's fields, or a face this build cannot draw, read twice are
  // two objects with one meaning; the store must not write for the difference.
  expect(
    sameProfile(
      { name: 'A', later: { account: { id: 'a1', plan: 'team' } } },
      { name: 'A', later: { account: { plan: 'team', id: 'a1' } } },
    ),
  ).toBe(true)
  expect(sameProfile({ avatar: { kind: 'image', src: 'a.png' } }, { avatar: { src: 'a.png', kind: 'image' } })).toBe(true)
  expect(sameProfile({ name: 'A', later: { account: { id: 'a1' } } }, { name: 'A', later: { account: { id: 'a2' } } })).toBe(false)
  expect(sameProfile({ avatar: { kind: 'image', src: 'a.png' } }, { avatar: { kind: 'image', src: 'b.png' } })).toBe(false)
})

describe('an edit in the name field', () => {
  const full = 'x'.repeat(PROFILE_NAME_MAX)
  const name39 = 'Jane Doe'.padEnd(39, '.')
  const mixed = 'a'.repeat(10) + 'b'.repeat(5) + 'c'.repeat(25)
  const whales = '🐳'.repeat(PROFILE_NAME_MAX)
  // What the field held, what it holds after the edit, where the caret sits
  // after it — and what is kept, with the caret put back where it belongs.
  const cases: [string, string, string, number | null, string, number][] = [
    ['a name under the cap goes through untouched', 'Jane', 'Jane D', 6, 'Jane D', 6],
    ['typing at the end of a full field changes nothing', full, `${full}y`, 41, full, 40],
    ['typing at the front of a full field changes nothing', full, `y${full}`, 1, full, 0],
    ['three pasted at the front of 39 keep one, and the whole name', name39, `XYZ${name39}`, 3, `X${name39}`, 1],
    ['a paste over the whole name keeps the first forty of it', full, 'y'.repeat(45), 45, 'y'.repeat(40), 40],
    ['twenty pasted over five in the middle keep five', mixed, 'a'.repeat(10) + 'y'.repeat(20) + 'c'.repeat(25), 30, 'a'.repeat(10) + 'y'.repeat(5) + 'c'.repeat(25), 15],
    ['one Backspace on a sixty-character name goes through', 'x'.repeat(60), 'x'.repeat(59), 59, 'x'.repeat(59), 59],
    ['typing into a longer name is refused, the caret back where it was', 'x'.repeat(45), `${'x'.repeat(10)}y${'x'.repeat(35)}`, 11, 'x'.repeat(45), 10],
    ['a paste of the same letter into the middle is refused', 'a'.repeat(40), 'a'.repeat(43), 23, 'a'.repeat(40), 20],
    ['a whale typed after the twentieth of forty is refused', whales, '🐳'.repeat(41), 42, whales, 40],
    ['no caret reported reads as the end', full, `${full}y`, null, full, 40],
    ['a pasted flag counts as one character; the caret is in UTF-16 units', '', '🇺🇸'.repeat(45), null, '🇺🇸'.repeat(40), 160],
  ]
  it.each(cases)('%s', (_what, was, next, caret, value, after) => {
    expect(editName(was, next, caret)).toEqual({ value, caret: after })
  })
})

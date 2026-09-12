import { describe, expect, it } from 'vitest'

import appSource from '../app/App.tsx?raw'
import { SHORTCUTS, chordOf, shortcutFor } from './shortcuts'

/**
 * The one table, and the handler that is supposed to dispatch from it.
 *
 * `shortcuts.ts` says it is read by two places — the app shell's handler and
 * the Keyboard shortcuts page — and the page is generated from the table, so
 * that half cannot drift. The handler is a `switch` written by hand, and
 * nothing held the two together: a row could be added here, printed on the
 * settings page as a key that works, and answered by nothing at all. That is
 * the shape #254 was reported in — `navigateBack` and `navigateForward` had no
 * key, and adding one is worth exactly as much as the dispatch behind it.
 *
 * The App is read as text rather than rendered for the reason `chrome.test.ts`
 * gives: what is asserted is that the code *says* something, and mounting the
 * whole shell against a fake host to find it out would be a worse test of it.
 */

const chord = (key: string): { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean } => ({
  key,
  metaKey: true,
  ctrlKey: false,
  shiftKey: false,
})

const row = (action: string) => {
  const found = SHORTCUTS.find((one) => one.action === action)
  if (!found) throw new Error(`no ${action} row in the table`)
  return found
}

describe('the shortcut table', () => {
  it('carries Back and Forward on ⌘[ and ⌘]', () => {
    expect(row('nav-back').key).toBe('[')
    expect(row('nav-forward').key).toBe(']')
    // Neither holds Shift: ⌘{ and ⌘} are a different chord and not ours.
    expect(row('nav-back').shift).toBeUndefined()
    expect(row('nav-forward').shift).toBeUndefined()
  })

  it('matches those chords, and only with the modifier held', () => {
    expect(shortcutFor(chord('['))?.action).toBe('nav-back')
    expect(shortcutFor(chord(']'))?.action).toBe('nav-forward')
    // Control: the same keys typed into a document are not a shortcut.
    expect(shortcutFor({ ...chord('['), metaKey: false })).toBeNull()
    expect(shortcutFor({ ...chord(']'), metaKey: false })).toBeNull()
    // Control: the matcher still answers for a chord that was always here.
    expect(shortcutFor(chord('b'))?.action).toBe('toggle-sidebar')
  })

  it('prints the brackets as themselves, where a letter is upper-cased', () => {
    expect(chordOf(row('nav-back'))).toBe('⌘[')
    expect(chordOf(row('nav-forward'))).toBe('⌘]')
    // Controls: the two shapes the bracket rows sit between.
    expect(chordOf(row('toggle-sidebar'))).toBe('⌘B')
    expect(chordOf(row('show-changes'))).toBe('⇧⌘D')
  })
})

describe('the handler behind the table', () => {
  it('answers every action the table declares', () => {
    const unanswered = SHORTCUTS.filter((one) => !appSource.includes(`case '${one.action}':`))
    expect(
      unanswered.map((one) => one.action),
      'these chords are printed on the shortcuts page and dispatched by nothing',
    ).toEqual([])
    // The table is not empty, so the assertion above had something to check.
    expect(SHORTCUTS.length).toBeGreaterThan(8)
  })

  it('and the two new ones reach the store verbs they exist for', () => {
    // A `case` alone would pass the check above while calling nothing, which
    // is exactly the dead command #254 warns about.
    expect(appSource).toMatch(/case 'nav-back':\s*\n\s*void store\.navigateBack\(\)/)
    expect(appSource).toMatch(/case 'nav-forward':\s*\n\s*void store\.navigateForward\(\)/)
    // Controls: the source really was loaded, and the matcher can tell the
    // two verbs apart rather than passing on any `case` it finds.
    expect(appSource).toContain("case 'toggle-sidebar':")
    expect(appSource).not.toMatch(/case 'nav-back':\s*\n\s*void store\.navigateForward\(\)/)
  })
})

describe('a chord the focused surface already answered', () => {
  it('is not the window’s to run a second time', () => {
    expect(shortcutFor({ ...chord('['), defaultPrevented: true })).toBeNull()
    expect(shortcutFor({ ...chord(']'), defaultPrevented: true })).toBeNull()
    // Controls: unspent, the same two chords are still ours — the rule reads
    // the flag rather than withdrawing the keys.
    expect(shortcutFor(chord('['))?.action).toBe('nav-back')
    expect(shortcutFor(chord(']'))?.action).toBe('nav-forward')
  })

  it('holds for the whole table, not only the two that collide today', () => {
    // ⌘[ in the editor is the instance; the class is any window-wide chord
    // firing on top of a surface that has already spent the key.
    for (const one of SHORTCUTS) {
      const spent = {
        key: one.key,
        metaKey: true,
        ctrlKey: false,
        shiftKey: Boolean(one.shift),
        defaultPrevented: true,
      }
      expect(shortcutFor(spent), `${one.action} ran on an event something else had handled`).toBeNull()
    }
    // Control: with the flag down every row in the table still matches, so the
    // loop above cannot pass by the table being empty or the matcher broken.
    for (const one of SHORTCUTS) {
      const fresh = { key: one.key, metaKey: true, ctrlKey: false, shiftKey: Boolean(one.shift) }
      expect(shortcutFor(fresh)?.action).toBe(one.action)
    }
  })

  it('and the window hands the event over whole, so the flag can be read', () => {
    // Destructuring the key and modifiers at the call site would drop the one
    // field that says somebody else got there first.
    expect(appSource).toMatch(/const shortcut = shortcutFor\(event\)/)
  })
})

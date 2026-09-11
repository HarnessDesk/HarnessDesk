import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { applyProfile, type Profile, type ProfilePatch } from '../lib/profile'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { ProfileSection } from './SettingsYou'

/**
 * Settings › Profile: your name and your face.
 *
 * The page is its own preview, so what is pinned is the loop between the
 * field, the head and the store: the head follows the keys, the store only
 * hears a name once the field is let go (Enter, a click away, the page
 * closing), Escape takes an edit back, the picker is one radio group walked
 * with the arrow keys, and Reset is there exactly while there is something
 * to reset.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** A store that holds a profile and says when it changes — the page reads its own writes back. */
const mount = (initial: Profile = {}) => {
  let snapshot = { ...emptySnapshot(), status: 'open', profile: initial } as AppSnapshot
  const listeners = new Set<() => void>()
  const setProfile = vi.fn((patch: ProfilePatch) => {
    snapshot = { ...snapshot, profile: applyProfile(snapshot.profile, patch) }
    for (const listener of listeners) listener()
  })
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => snapshot,
    setProfile,
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <ProfileSection />
      </StoreProvider>,
    )
  })
  return { setProfile, profile: () => snapshot.profile }
}

const field = (): HTMLInputElement => {
  const found = container.querySelector<HTMLInputElement>('input[aria-label="Your name"]')
  if (!found) throw new Error('no name field')
  return found
}

/**
 * Types into the field the way a person does: focused, one value at a time,
 * and the caret where the edit left it — the end, unless said. A browser puts
 * it after what went in; setting a value in jsdom puts it at the end, which
 * for an edit in the middle would be a caret no browser reports.
 */
const type = (value: string, caret = value.length): void => {
  const input = field()
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    input.focus()
    setValue?.call(input, value)
    input.setSelectionRange(caret, caret)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const press = (element: Element, key: string): void => {
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

const click = (element: Element): void => {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const heading = (): string => container.querySelector('[class*="detailName"]')?.textContent ?? ''
const headFace = (): HTMLImageElement | null => container.querySelector('[class*="detailHead"] img')
const button = (name: string): HTMLButtonElement | null =>
  [...container.querySelectorAll('button')].find((element) => element.textContent?.trim() === name) ?? null
const tiles = (): HTMLButtonElement[] => [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
const worn = (): HTMLButtonElement => {
  const found = container.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')
  if (!found) throw new Error('no face is checked')
  return found
}

it('is HarnessDesk and the house mark until you choose', () => {
  mount()
  expect(heading()).toBe('HarnessDesk')
  expect(field().value).toBe('')
  expect(field().placeholder).toBe('HarnessDesk')
  expect(headFace()).toBeNull()
  expect(container.querySelector('[class*="detailHead"] .brand-harnessdesk')).not.toBeNull()
  expect(worn().getAttribute('aria-label')).toBe('Default')
  expect(button('Reset to default')).toBeNull()
})

it('previews a name as it is typed, and keeps it once the field is let go', () => {
  const { setProfile, profile } = mount()
  type('  Jane   Doe ')
  // The head follows the keys; the store has heard nothing yet.
  expect(heading()).toBe('Jane Doe')
  expect(setProfile).not.toHaveBeenCalled()
  expect(button('Reset to default')).not.toBeNull()

  act(() => field().blur())
  expect(profile()).toEqual({ name: 'Jane Doe' })
  // The field shows what was kept, tidied.
  expect(field().value).toBe('Jane Doe')
})

it('keeps a name on Enter, and takes an edit back on Escape', () => {
  const { profile } = mount({ name: 'Jane' })
  type('JD')
  press(field(), 'Enter')
  expect(profile()).toEqual({ name: 'JD' })

  type('Somebody else')
  press(field(), 'Escape')
  expect(profile()).toEqual({ name: 'JD' })
  expect(field().value).toBe('JD')
  expect(heading()).toBe('JD')
})

it('goes back to HarnessDesk when the field is emptied', () => {
  const { profile } = mount({ name: 'Jane' })
  type('')
  expect(heading()).toBe('HarnessDesk')
  act(() => field().blur())
  expect(profile()).toEqual({})
})

it('keeps what was typed when the page closes with the field still held', () => {
  const { profile } = mount()
  type('Jane')
  act(() => root.unmount())
  expect(profile()).toEqual({ name: 'Jane' })
  // afterEach unmounts again; give it a root that is still there.
  root = createRoot(container)
})

it('wears the face you pick, and walks the faces with the arrow keys', () => {
  const { profile } = mount()
  expect(tiles()).toHaveLength(24)
  // One stop on the tab order, not twenty-four: the face you wear.
  expect(tiles().filter((tile) => tile.tabIndex === 0).map((tile) => tile.getAttribute('aria-label'))).toEqual([
    'Default',
  ])

  const wizard = tiles().find((tile) => tile.getAttribute('aria-label') === 'Wizard')
  if (!wizard) throw new Error('no Wizard')
  click(wizard)
  expect(profile()).toEqual({ avatar: 'wizard' })
  expect(headFace()?.getAttribute('src')).toMatch(/\/wizard\.png$/)
  expect(worn().tabIndex).toBe(0)

  press(worn(), 'ArrowRight')
  expect(profile().avatar).toBe('samurai')
  expect(document.activeElement).toBe(worn())
  // Down is a row of eight; past the last row it stays put.
  press(worn(), 'ArrowDown')
  expect(profile().avatar).toBe('alien')
  press(worn(), 'ArrowDown')
  expect(profile().avatar).toBe('alien')
  press(worn(), 'ArrowUp')
  expect(profile().avatar).toBe('samurai')
  // Home and End choose nothing: in a group that chooses as it moves, a stray
  // Home would be a silent reset.
  press(worn(), 'Home')
  press(worn(), 'End')
  expect(profile().avatar).toBe('samurai')
})

it('offers a reset only while there is something to reset, and it resets both', () => {
  const { profile } = mount({ name: 'Jane', avatar: 'dj' })
  expect(heading()).toBe('Jane')
  const reset = button('Reset to default')
  if (!reset) throw new Error('no reset')
  click(reset)
  expect(profile()).toEqual({})
  expect(heading()).toBe('HarnessDesk')
  expect(field().value).toBe('')
  expect(worn().getAttribute('aria-label')).toBe('Default')
  expect(button('Reset to default')).toBeNull()
})

it('takes back a name nobody committed when Reset is pressed', () => {
  const { profile } = mount({ avatar: 'dj' })
  // Typed and still held — no blur has committed it.
  type('Jane')
  const reset = button('Reset to default')
  if (!reset) throw new Error('no reset')
  click(reset)
  expect(profile()).toEqual({})
  expect(field().value).toBe('')
  expect(heading()).toBe('HarnessDesk')
  // Leaving afterwards writes nothing back.
  act(() => root.unmount())
  root = createRoot(container)
  expect(profile()).toEqual({})
})

it('holds forty characters, counted the way a person counts them', () => {
  const { profile } = mount()
  // No `maxLength`: it counts UTF-16 units, and would stop an emoji name at twenty.
  expect(field().maxLength).toBe(-1)
  type('🐳'.repeat(45))
  expect(Array.from(field().value)).toHaveLength(40)
  act(() => field().blur())
  expect(profile()).toEqual({ name: '🐳'.repeat(40) })
})

it('writes a held name when the window goes away', () => {
  const { profile } = mount()
  type('Jane')
  act(() => {
    window.dispatchEvent(new Event('pagehide'))
  })
  expect(profile()).toEqual({ name: 'Jane' })
})

it('checks no face when it holds one it cannot draw, says so, and keeps it until you choose', () => {
  for (const kept of ['pirate', { kind: 'image', src: 'a.png' }]) {
    const { profile } = mount({ name: 'Jane', avatar: kept })
    expect(container.querySelector('[role="radio"][aria-checked="true"]')).toBeNull()
    // Still one stop on the tab order, on the first face.
    expect(tiles().filter((tile) => tile.tabIndex === 0).map((tile) => tile.getAttribute('aria-label'))).toEqual([
      'Default',
    ])
    expect(container.textContent).toContain('cannot draw')
    // The note is the group's description, so a screen reader landing on an
    // unchecked group hears why.
    const group = container.querySelector('[role="radiogroup"]')
    expect(document.getElementById(group?.getAttribute('aria-describedby') ?? '')?.textContent).toContain('cannot draw')
    expect(button('Reset to default')).not.toBeNull()
    const wizard = tiles().find((tile) => tile.getAttribute('aria-label') === 'Wizard')
    if (!wizard) throw new Error('no Wizard')
    click(wizard)
    expect(profile()).toEqual({ name: 'Jane', avatar: 'wizard' })
    expect(container.textContent).not.toContain('cannot draw')
    expect(container.querySelector('[role="radiogroup"]')?.hasAttribute('aria-describedby')).toBe(false)
    act(() => root.unmount())
    root = createRoot(container)
  }
})

it('refuses an insert into a full field rather than dropping its last character', () => {
  const { profile } = mount()
  const full = '🐳'.repeat(40)
  type(full)
  const whales = Array.from(full)
  // X typed after the twentieth whale: the caret sits just after it.
  type([...whales.slice(0, 20), 'X', ...whales.slice(20)].join(''), whales.slice(0, 20).join('').length + 1)
  expect(field().value).toBe(full)
  act(() => field().blur())
  expect(profile()).toEqual({ name: full })
})

it('counts a flag in the field as one character, as the store does', () => {
  const { profile } = mount()
  type('🇺🇸'.repeat(45))
  act(() => field().blur())
  expect(profile()).toEqual({ name: '🇺🇸'.repeat(40) })
})

it('chooses nothing with an arrow that has nowhere to go', () => {
  // Holding a face this build cannot draw, the tab stop is the first tile and
  // nothing is checked: a Left there that chose would reset the kept face with
  // a key that moved nowhere.
  const { setProfile, profile } = mount({ avatar: 'pirate' })
  const first = tiles()[0]
  if (!first) throw new Error('no first face')
  press(first, 'ArrowLeft')
  press(first, 'ArrowUp')
  expect(setProfile).not.toHaveBeenCalled()
  expect(profile()).toEqual({ avatar: 'pirate' })
  // The control: a key with somewhere to go still chooses as it moves.
  press(first, 'ArrowRight')
  expect(profile()).toEqual({ avatar: 'blue' })
})

it('chooses nothing with Right or Down on the last face', () => {
  const { setProfile } = mount({ avatar: 'beach' })
  press(worn(), 'ArrowRight')
  press(worn(), 'ArrowDown')
  expect(setProfile).not.toHaveBeenCalled()
})

it('keeps as much of a paste over the whole name as fits, rather than putting the old name back', () => {
  const { profile } = mount({ name: 'x'.repeat(40) })
  // Select all, paste: one input event carrying a value past the cap.
  type('y'.repeat(45))
  expect(field().value).toBe('y'.repeat(40))
  act(() => field().blur())
  expect(profile()).toEqual({ name: 'y'.repeat(40) })
})

it('keeps the end of the name when a paste lands at its front, and the caret after what went in', async () => {
  const name = 'Jane Doe'.padEnd(39, '.')
  mount({ name })
  // Three characters pasted before a thirty-nine-character name: room for one.
  type(`XYZ${name}`, 3)
  expect(field().value).toBe(`X${name}`)
  // Setting a value puts the caret at its end; the field puts it back.
  await act(async () => {})
  expect(field().selectionStart).toBe(1)
})

it('leaves a name it was given as it is, unless you edit it', () => {
  // A later build may allow more than forty. Looking at the field is not an edit.
  const long = 'x'.repeat(60)
  const { setProfile, profile } = mount({ name: long })
  expect(field().value).toBe(long)
  expect(heading()).toBe(long)
  act(() => field().focus())
  act(() => field().blur())
  expect(setProfile).not.toHaveBeenCalled()
  // Taking a character away is an edit, and always goes through; what is kept
  // is held to this build's cap.
  type('x'.repeat(59))
  expect(field().value).toBe('x'.repeat(59))
  act(() => field().blur())
  expect(profile()).toEqual({ name: 'x'.repeat(40) })
})

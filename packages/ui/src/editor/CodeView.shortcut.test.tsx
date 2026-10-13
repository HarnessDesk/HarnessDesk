import { act } from 'react'
import { EditorView } from '@codemirror/view'
import { openSearchPanel, SearchQuery, setSearchQuery } from '@codemirror/search'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { shortcutFor } from '../lib/shortcuts'
import { CodeView } from './CodeView'

/**
 * A window-wide chord, and the surface that already answered it.
 *
 * ⌘[ and ⌘] step the desk back and forward. The file editor binds the same
 * pair to outdent and indent — CodeMirror's `defaultKeymap` has `Mod-[` and
 * `Mod-]` — so without a rule, one press outdents a line *and* navigates away
 * from the file it was typed in.
 *
 * The rule is not "the editor is special". It is that a chord the focused
 * surface has already spent is not the window's to run a second time, and the
 * DOM already records that: anything that handles a key event marks it
 * handled. `shortcutFor` reads the mark, so the editor needs no registration
 * and the window needs no list of surfaces.
 *
 * Which way each surface goes, and why:
 *
 * - **The file editor keeps the pair** while it has focus, because it answers
 *   it. Asserted below against the real component, and the editor's document
 *   is checked to have actually moved — an event that merely vanished would
 *   be a different bug wearing the same green.
 * - **A read-only editor does not**, because nothing there can indent and the
 *   binding declines. Nothing is being edited, so navigating is the better
 *   answer, and this pins that it is the deliberate one.
 * - **A textarea, an input, a contenteditable and a plain element** bind
 *   neither bracket, so the desk still navigates from them. That is the
 *   control in the other direction: the fix must not buy its correctness by
 *   making the chord dead where it is the only route — the composer, the
 *   sidebar, the board, an empty desk.
 *
 * The browser pane is the fourth surface and is not mounted here: it stops
 * the event in the capture phase, so it is not a question this handler can
 * ever see. It is unchanged by this test and by the rule.
 *
 * The fixture reports macOS before CodeMirror resolves `Mod-`, so the
 * Command shortcuts below exercise the shipping platform's real bindings.
 */

vi.hoisted(() => {
  Object.defineProperty(window.navigator, 'platform', { configurable: true, value: 'MacIntel' })
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The window's own handler, as `App` installs it: dispatch from the table. */
const desk = (): { ran: string[]; stop: () => void } => {
  const ran: string[] = []
  const onKeyDown = (event: KeyboardEvent): void => {
    const shortcut = shortcutFor(event)
    if (!shortcut) return
    event.preventDefault()
    ran.push(shortcut.action)
  }
  document.addEventListener('keydown', onKeyDown)
  return { ran, stop: () => document.removeEventListener('keydown', onKeyDown) }
}

const press = (from: EventTarget, key: string): void => {
  from.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true }))
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const editor = async (readOnly: boolean): Promise<HTMLElement> => {
  await act(async () => {
    root.render(
      <CodeView
        value={'    indented line'}
        path="notes.txt"
        readOnly={readOnly}
        dark={false}
        look={{ fontFamily: 'monospace', fontSize: 13, lineHeight: 1.5 }}
      />,
    )
  })
  const content = container.querySelector('.cm-content')
  if (!(content instanceof HTMLElement)) throw new Error('the editor did not mount')
  content.focus()
  return content
}

it('leaves the brackets to the editor that answered them', async () => {
  const content = await editor(false)
  const before = content.textContent
  const { ran, stop } = desk()

  // Each press is checked where it lands, because the pair is symmetrical:
  // outdent then indent returns the line to where it started, and reading the
  // document only at the end would call that "nothing happened".
  press(content, '[')
  const outdented = content.textContent
  press(content, ']')
  stop()

  expect(ran, 'the desk navigated on a chord the editor had already answered').toEqual([])
  // The editor really took them. An event that merely went missing would
  // leave `ran` empty too, while the person's outdent did nothing at all.
  expect(outdented, 'the editor never outdented, so it never claimed ⌘[').not.toBe(before)
  expect(content.textContent, 'the editor never indented, so it never claimed ⌘]').not.toBe(outdented)
})

it('still answers the brackets from a surface that binds neither', async () => {
  // The other direction. Each of these is a place the header's arrows may have
  // folded away, so a dead chord here is the bug #254 was filed for.
  for (const element of [
    document.createElement('textarea'),
    Object.assign(document.createElement('input'), { type: 'text' }),
    Object.assign(document.createElement('div'), { contentEditable: 'true' }),
    document.createElement('div'),
  ]) {
    document.body.appendChild(element)
    element.focus()
    const { ran, stop } = desk()
    press(element, '[')
    press(element, ']')
    stop()
    expect(ran, `${element.tagName.toLowerCase()} swallowed a chord it does not bind`).toEqual([
      'nav-back',
      'nav-forward',
    ])
    element.remove()
  }
})

it('answers them from a read-only editor, which binds them and declines', async () => {
  const content = await editor(true)
  const before = content.textContent
  const { ran, stop } = desk()
  press(content, '[')
  stop()

  // Nothing there can indent, so nothing claims the key and the desk keeps it.
  expect(ran).toEqual(['nav-back'])
  expect(content.textContent).toBe(before)
})

for (const modifier of ['ctrlKey', 'metaKey'] as const) {
  for (const key of ['g', 'l']) {
    it(`leaves ${modifier} ${key} to the app from the editor and search field`, async () => {
      const content = await editor(false)
      const view = EditorView.findFromDOM(content)!
      openSearchPanel(view)
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'line' })) })
      const searchField = container.querySelector<HTMLInputElement>('input[name="search"]')!
      const before = view.state.selection.toJSON()
      const received: string[] = []
      const listener = (event: KeyboardEvent): void => {
        if (!event.defaultPrevented && event.key === key) received.push(event.key)
      }
      document.addEventListener('keydown', listener)
      try {
        for (const target of [content, searchField]) {
          target.dispatchEvent(new KeyboardEvent('keydown', { key, [modifier]: true, bubbles: true, cancelable: true }))
          expect(view.state.selection.toJSON(), `${key} changed the selection before the app could answer`).toEqual(before)
        }
        expect(received).toEqual([key, key])
        expect(container.querySelector('.cm-gotoLine')).toBeNull()
      } finally {
        document.removeEventListener('keydown', listener)
      }
    })
  }
}

it.each(['editor', 'search field'])('opens the Command palette from the %s with Command K', async (scope) => {
  const content = await editor(false)
  const view = EditorView.findFromDOM(content)!
  openSearchPanel(view)
  const target = scope === 'editor'
    ? content
    : container.querySelector<HTMLInputElement>('input[name="search"]')!
  const before = view.state.selection.toJSON()
  const { ran, stop } = desk()
  try {
    press(target, 'k')
    expect(ran).toEqual(['palette'])
    expect(view.state.selection.toJSON()).toEqual(before)
  } finally {
    stop()
  }
})

it('finds the next match with F3 and with Enter in the search field', async () => {
  const content = await editor(false)
  const view = EditorView.findFromDOM(content)!
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'match first match last' } })
  openSearchPanel(view)
  const searchField = container.querySelector<HTMLInputElement>('input[name="search"]')!
  searchField.value = 'match'
  searchField.dispatchEvent(new KeyboardEvent('keyup', { key: 'h', bubbles: true }))
  searchField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }))
  expect(view.state.selection.main.from).toBe(0)
  expect(view.state.selection.main.to).toBe(5)
  content.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', bubbles: true, cancelable: true }))
  expect(view.state.selection.main.from).toBe(12)
  expect(view.state.selection.main.to).toBe(17)
})

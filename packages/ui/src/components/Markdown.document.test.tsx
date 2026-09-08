import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { Markdown } from './Markdown'

/**
 * A file is not a chat message.
 *
 * `breaks: true` — a lone newline becomes a `<br>` — is right for an agent's
 * streamed output and wrong for a Markdown file, which a person wrote in an
 * editor and hard-wrapped at some column width they chose. Rendered with
 * breaks on, every wrapped paragraph in a real `SKILL.md` comes out snapped
 * at the author's margin, and it reads as a defect in the skill rather than
 * in the renderer showing it.
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

/* `Markdown` reads the theme to pick a highlighting palette, and the theme
   comes off the store — so even a pure-render test needs one under it. */
const snapshot = emptySnapshot()
const store = {
  subscribe: () => () => {},
  // Held, not rebuilt: `useSyncExternalStore` compares by reference, so a
  // `getSnapshot` that returns a fresh object every call re-renders forever.
  getSnapshot: () => snapshot,
} as unknown as AppStore

const render = (node: React.ReactElement): void => {
  act(() => root.render(<StoreProvider store={store}>{node}</StoreProvider>))
}

// One paragraph, wrapped the way a person writes a file.
const wrapped = 'A bug that changes behaviour outranks\nevery style note in the file.'

it('a document keeps a hard-wrapped paragraph as one paragraph', () => {
  render(<Markdown text={wrapped} document />)
  expect(container.querySelectorAll('br')).toHaveLength(0)
  expect(container.querySelectorAll('p')).toHaveLength(1)
})

it('agent output still takes a lone newline as a line break', () => {
  // The default must not change: a model laying out lines means them.
  render(<Markdown text={wrapped} />)
  expect(container.querySelectorAll('br').length).toBeGreaterThan(0)
})

it('a document still gets every other GFM feature', () => {
  render(<Markdown text={'# Head\n\n1. one\n2. two\n\n- bullet'} document />)
  expect(container.querySelector('h1')?.textContent).toBe('Head')
  expect(container.querySelectorAll('ol li')).toHaveLength(2)
  expect(container.querySelectorAll('ul li')).toHaveLength(1)
})

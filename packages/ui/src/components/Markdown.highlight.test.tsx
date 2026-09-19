import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { Markdown } from './Markdown'

/**
 * A code block is coloured once its grammar lands, even when nothing else
 * about the message changes.
 *
 * Grammars load after the first paint, so a block renders plain and the
 * renderer is told when to try again. The retry re-rendered the component but
 * handed back the HTML it had already built, so a finished message — whose
 * text never changes again — kept its code plain for good. Only a message
 * still streaming ever got colour, and only by luck of a later chunk.
 */

const grammar = vi.hoisted(() => ({ landed: false, listeners: new Set<() => void>() }))

vi.mock('../lib/highlight', () => ({
  ensureHighlighter: () => {},
  onHighlighterReady: (listener: () => void) => {
    grammar.listeners.add(listener)
    return () => grammar.listeners.delete(listener)
  },
  highlight: (code: string) => (grammar.landed ? `<pre class="shiki"><code>${code}</code></pre>` : null),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  grammar.landed = false
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const snapshot = emptySnapshot()
const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore

it('colours a finished message once its grammar lands', () => {
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <Markdown text={'Here:\n\n```ts\nconst opened = true\n```'} />
      </StoreProvider>,
    )
  })
  expect(container.querySelector('pre.shiki')).toBeNull()
  expect(container.querySelector('pre code')?.textContent).toContain('const opened = true')

  act(() => {
    grammar.landed = true
    for (const listener of grammar.listeners) listener()
  })
  expect(container.querySelector('pre.shiki')?.textContent).toContain('const opened = true')
})

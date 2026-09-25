import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { ChangesView, TrajectoryView } from './Details'

/**
 * Staged and Timed are filters you press, drawn as the one drawing for that
 * (`PanelPill`): each says whether it is pressed, and pressing flips it.
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

const snapshot = emptySnapshot()
const store = {
  subscribe: () => () => {},
  getSnapshot: () => snapshot,
  transport: { request: async () => null },
  notice: () => {},
} as unknown as AppStore

const toggle = (title: string): HTMLButtonElement => {
  const button = container.querySelector<HTMLButtonElement>(`button[title^="${title}"]`)
  if (!button) throw new Error(`no toggle titled ${title}`)
  return button
}

for (const [name, View, title] of [
  ['Staged', ChangesView, 'Show what is staged'],
  ['Timed', TrajectoryView, 'Show only steps the runtime timed'],
] as const) {
  it(`${name} is a pressed-or-not filter pill`, () => {
    act(() => root.render(<StoreProvider store={store}><View /></StoreProvider>))
    const button = toggle(title)
    expect(button.textContent).toBe(name)
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.hasAttribute('data-on')).toBe(false)

    act(() => button.click())
    expect(toggle(title).getAttribute('aria-pressed')).toBe('true')
    expect(toggle(title).hasAttribute('data-on')).toBe(true)
    expect(toggle(title).className).toContain('bg-(--hd-accent-dim)')

    act(() => toggle(title).click())
    expect(toggle(title).getAttribute('aria-pressed')).toBe('false')
  })
}

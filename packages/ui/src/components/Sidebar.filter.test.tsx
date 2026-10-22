import { previewStore } from '../preview/harness'
import type { Section } from './Settings'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Sidebar } from './Sidebar'

/**
 * The sidebar's filter and the Escape key.
 *
 * A filter with words in it spends the key clearing them and says so, with
 * `preventDefault`, so a sidebar floating over a narrow window stays open for
 * the list the filter just gave back. An empty filter has nothing to clear:
 * it lets the key go on to whatever it would have closed — it used to spend
 * it on leaving the field, and the sidebar took a second press to put away.
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

const mount = (): HTMLInputElement => {
  const snapshot = { ...emptySnapshot(), status: 'open' } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    searchHistory: vi.fn(async () => {}),
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <Sidebar
          onOpenSettings={() => {}}
          onOpenTeams={() => {}} onOpenAgents={() => {}}
          onOpenUsage={() => {}}
          onBrowseFolders={() => {}}
          onSignIn={() => {}}
          onSearch={() => {}}
        />
      </StoreProvider>,
    )
  })
  const filter = container.querySelector<HTMLInputElement>('input[aria-label="Filter this list"]')
  if (!filter) throw new Error('no filter')
  return filter
}

const escape = (target: Element): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

const type = (input: HTMLInputElement, text: string): void => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setValue?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('an empty filter lets Escape go on to what it would close; one with words spends it clearing them', () => {
  const filter = mount()
  act(() => filter.focus())
  expect(escape(filter).defaultPrevented).toBe(false)

  act(() => filter.focus())
  type(filter, 'retry')
  expect(filter.value).toBe('retry')
  expect(filter.placeholder).toBe('Filter by title')
  expect(container.querySelector('[data-left-projects-head]')?.textContent).toContain('Filtered')
  const clear = container.querySelector<HTMLButtonElement>('button[aria-label="Clear list filter"]')
  expect(clear).not.toBeNull()
  act(() => clear?.click())
  expect(filter.value).toBe('')
  expect(container.querySelector('[data-left-projects-head]')?.textContent).not.toContain('Filtered')

  type(filter, 'retry')
  expect(escape(filter).defaultPrevented).toBe(true)
  expect(filter.value).toBe('')
})

it('two mounted columns share a filter and only work owns history search', async () => {
  vi.useFakeTimers()
  const store = previewStore()
  const search = vi.fn(async () => {})
  store.searchHistory = search
  const common = {
    onOpenSettings: () => {}, onOpenAgents: () => {}, onOpenTeams: () => {},
    onOpenUsage: () => {}, onBrowseFolders: () => {}, onSignIn: () => {}, onSearch: () => {},
  }
  const Fixture = () => {
    const [query, setQuery] = useState('retry')
    const [section, setSection] = useState<false | Section>(false)
    const listFilter = { value: query, onChange: setQuery }
    return <StoreProvider store={store}>
      <button aria-label="Visit preferences" onClick={() => setSection('general')}>Visit preferences</button>
      <Sidebar {...common} active={section === false} listFilter={listFilter} />
      {section !== false && <Sidebar {...common} listFilter={listFilter} sessionsOwner={false}
        settings={{ section, onSection: setSection, onBack: () => setSection(false) }} />}
    </StoreProvider>
  }
  try {
    await act(async () => { root.render(<Fixture />) })
    await act(async () => { await vi.advanceTimersByTimeAsync(221) })
    search.mockClear()
    const original = container.querySelector<HTMLElement>('[data-left-column] [data-region="sidebar-content"]')!
    original.scrollTop = 40
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Visit preferences"]')!.click())
    await act(async () => { await vi.advanceTimersByTimeAsync(221) })
    expect(search).not.toHaveBeenCalled()
    const active = [...container.querySelectorAll<HTMLElement>('[data-left-column]')].find(node => !node.hidden)!
    act(() => active.querySelector<HTMLButtonElement>('[data-left-settings] button[aria-label="Back"]')!.click())
    expect(container.querySelector('[data-left-column] [data-region="sidebar-content"]')).toBe(original)
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Filter this list"]')!.value).toBe('retry')
    expect(original.scrollTop).toBe(40)
  } finally { vi.useRealTimers() }
})

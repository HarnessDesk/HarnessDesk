import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
import { DiffView } from './DiffView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const host = document.createElement('div')
document.body.append(host)
let root = createRoot(host)
afterEach(() => { act(() => root.unmount()); root = createRoot(host) })
const diff = '@@ -1,2 +1,2 @@\n-old middle slow\n-const a = 1\n+new middle fast\n+const  a = 1'

it('toggles the drawing, shares choices with other diffs, and restores them in a fresh window', async () => {
  const store = new AppStore('ws://localhost:0/')
  const stored: Record<string, unknown> = {}
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { patch?: object }) => {
    if (method === 'app/state/set') Object.assign(stored, params.patch)
    return method === 'app/state/get' ? stored : null
  }) as never)
  act(() => root.render(<StoreProvider store={store}><DiffView diff={diff} /><DiffView diff={diff} /></StoreProvider>))
  expect([...host.querySelectorAll('[data-changed-word]')].map(node => node.textContent)).toEqual(['old', 'slow', ' ', 'new', 'fast', '  ', 'old', 'slow', ' ', 'new', 'fast', '  '])
  const toggle = async (label: string) => {
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Diff view options"]')!.click())
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(node => node.textContent === label)
    expect(item).toBeDefined()
    await act(async () => item!.click())
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  }
  await toggle('Word wrap')
  expect(host.querySelector('[data-wrap]')).toBeNull()
  await toggle('Highlight changed words')
  expect(host.querySelector('[data-changed-word]')).toBeNull()
  await toggle('Hide whitespace changes')
  expect(host.querySelectorAll('tbody tr')).toHaveLength(4)
  await vi.waitFor(() => expect(stored['diffPrefs']).toEqual(expect.objectContaining({ wrap: false, highlightWords: false, hideWhitespace: true })))
  const fresh = new AppStore('ws://localhost:0/')
  vi.spyOn(fresh.transport, 'request').mockImplementation((async (method: string) => method === 'app/state/get' ? stored : null) as never)
  await fresh.loadPreferences()
  expect(fresh.getSnapshot().diffPrefs).toEqual(store.getSnapshot().diffPrefs)
})

it('collapses and expands files and keeps a grouped, hideable file list', async () => {
  const files = ['src/one.ts', 'test/one.ts', 'src/two.ts'].map(path => ({ path, diff: '@@ -1 +1 @@\n-before\n+after' }))
  act(() => root.render(<DiffView diff={files.map(file => `diff --git a/${file.path} b/${file.path}\n${file.diff}`).join('\n')} />))
  const choose = async (label: string, role: string) => {
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Diff view options"]')!.click())
    const item = [...document.querySelectorAll<HTMLElement>(`[role="${role}"]`)].find(node => node.textContent === label)
    expect(item).toBeDefined()
    await act(async () => item!.click())
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  }
  expect(host.querySelectorAll('table')).toHaveLength(3)
  await choose('Collapse all files', 'menuitem')
  expect(host.querySelector('table')).toBeNull()
  expect(host.textContent).toContain('+1 −1')
  await choose('Expand all files', 'menuitem')
  expect(host.querySelectorAll('table')).toHaveLength(3)
  await choose('Group files by folder', 'menuitemcheckbox')
  const list = host.querySelector('nav[aria-label="Changed files"]')!
  expect(list.querySelectorAll('[data-diff-folder]')).toHaveLength(2)
  expect([...list.querySelectorAll('button')].map(node => node.textContent)).toEqual(['src/one.ts', 'src/two.ts', 'test/one.ts'])
  await choose('Show files', 'menuitemcheckbox')
  expect(host.querySelector('nav')).toBeNull()
  expect(host.querySelectorAll('table')).toHaveLength(3)
})

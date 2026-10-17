import { act } from 'react'
import css from './PageOptions.module.css?raw'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { PageOptions } from './PageOptions'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
test('a page head names the page once beside its own choices and verb', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<PageOptions title="Library" action={{ label: 'New skill', run: () => {} }} />))
    const heading = host.querySelector('h1')
    expect(heading?.textContent).toBe('Library')
    expect(heading?.getAttribute('data-role')).toBe('page')
    expect(heading?.parentElement?.querySelector('button')?.textContent).toBe('New skill')
    expect(host.querySelectorAll('h1')).toHaveLength(1)
  } finally { await act(async () => root.unmount()); host.remove() }
})
test('body choices print their current value and preserve the change callback', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), change = vi.fn(), refresh = vi.fn()
  try {
    await act(async () => root.render(<PageOptions choices={[{ id: 'layout', label: 'How to show the library', value: 'list',
      items: [{ value: 'list', label: 'List' }, { value: 'matrix', label: 'Matrix' }], change }]}
      read="Read just now" action={{ label: 'Refresh', run: refresh }} />))
    const select = host.querySelector<HTMLSelectElement>('select')!
    expect(select.value).toBe('list')
    await act(async () => { select.value = 'matrix'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(change).toHaveBeenCalledWith('matrix')
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
    expect(refresh).toHaveBeenCalledOnce()
    expect(host.querySelector('[data-slot="page-options"]')?.textContent).toContain('Read just now')
  } finally { await act(async () => root.unmount()); host.remove() }
})

test('the page verb starts the row and a disabled verb keeps its reason', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), run = vi.fn()
  try {
    await act(async () => root.render(<PageOptions choices={[{ id: 'kind', label: 'Library sections', value: 'skill',
      items: [{ value: 'skill', label: 'Skills' }], change: () => {} }]}
      action={{ label: 'New skill', disabled: 'The library has not been read.', run }} />))
    const row = host.querySelector('[data-slot="page-options"]')!
    expect(row.firstElementChild?.textContent).toBe('New skill')
    const action = row.querySelector<HTMLButtonElement>('button')!
    expect(action.disabled).toBe(true)
    expect(action.title).toBe('The library has not been read.')
    act(() => action.click()); expect(run).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); host.remove() }
})

test('a page head is one bar tall, the sidebar brand row\'s counterpart', () => {
  expect(css).toMatch(/\.head\s*\{[^}]*min-height:\s*var\(--hd-bar-h\)/)
})

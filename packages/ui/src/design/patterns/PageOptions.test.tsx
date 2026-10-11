import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { PageOptions } from './PageOptions'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
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

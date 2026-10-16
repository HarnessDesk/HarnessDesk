import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { TopBar } from '../design'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('ancestor navigation is reachable from More and never spends bar width', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  const settings = vi.fn(), runtimes = vi.fn(), alpha = vi.fn()
  try {
    act(() => root.render(<TopBar place="Jane Doe" parents={[{ label: 'Settings', run: settings }, { label: 'Runtimes', run: runtimes }, { label: 'Alpha', run: alpha }]} more={() => null} />))
    expect(host.querySelectorAll('[data-topbar="place"] button')).toHaveLength(0)
    await act(async () => host.querySelector<HTMLButtonElement>('[data-topbar="more"] button')!.click())
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(items.map(node => node.textContent)).toEqual(['Settings', 'Runtimes', 'Alpha'])
    await act(async () => items[1]!.click())
    expect(runtimes).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="menu"]')).toBeNull()
  } finally { act(() => root.unmount()); host.remove() }
})

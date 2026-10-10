import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { StatusBar } from './StatusBar'

it('exposes named fact actions and exactly one terminal control at the app foot', () => {
  const host = document.createElement('div'), root = createRoot(host), run = vi.fn()
  document.body.append(host)
  try {
    act(() => root.render(<StatusBar usage={<span>Plan usage</span>} facts={[
      { id: 'tasks', label: '2 background tasks', run },
      { id: 'sync', label: 'Reconnecting', detail: 'Connection to the host' },
      { id: 'updates', label: 'Downloading Update…', run, disabled: true },
    ]} terminal={<button>Open terminal</button>} />))
    const button = [...host.querySelectorAll('button')].find(one => one.textContent === '2 background tasks')!
    act(() => button.click())
    expect(run).toHaveBeenCalledOnce()
    expect([...host.querySelectorAll('button')].filter(one => one.textContent === 'Open terminal')).toHaveLength(1)
    expect(host.querySelector('footer')?.textContent).toContain('Plan usage')
    expect(host.querySelector('[title="Connection to the host"]')?.textContent).toBe('Reconnecting')
    expect([...host.querySelectorAll('button')].find(one => one.textContent === 'Downloading Update…')?.disabled).toBe(true)
  } finally { act(() => root.unmount()); host.remove() }
})

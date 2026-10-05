import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { SettingsRowMenu } from './SettingsRowMenu'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('names the row, carries a destructive trash item, and returns focus on Escape', async () => {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const remove = vi.fn()
  try {
    await act(async () => root.render(<SettingsRowMenu name="Jane Doe" location="~/.agent-work" onRemove={remove} />))
    const trigger = container.querySelector('button')!
    expect(trigger.getAttribute('aria-label')).toBe('Jane Doe actions · ~/.agent-work')
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    await act(async () => trigger.click())
    const item = document.querySelector<HTMLElement>('[role="menuitem"]')!
    expect(item.textContent).toBe('Remove…')
    expect(item.dataset['variant']).toBe('destructive')
    expect(item.querySelector('.lucide-trash-2')).toBeTruthy()
    await act(async () => item.click())
    expect(remove).toHaveBeenCalledOnce()
    await act(async () => trigger.click())
    await act(async () => document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  } finally { act(() => root.unmount()); container.remove() }
})

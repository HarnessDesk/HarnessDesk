import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { previewStore } from '../preview/harness'
import { WorkTools } from './WorkTools'
import { Menu } from '../design'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('explains that draft Changes is available after the first message and leaves other tools usable', () => {
  const host = document.createElement('div'), root = createRoot(host)
  document.body.append(host)
  try {
    act(() => root.render(<StoreProvider store={previewStore()}><WorkTools draft /></StoreProvider>))
    const changes = host.querySelector<HTMLButtonElement>('[aria-label="Changes"]')!
    expect(changes.disabled).toBe(true)
    expect(changes.title).toBe('Available after the first message')
    for (const label of ['Terminal', 'Browser', 'Files']) {
      const tool = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
      expect(tool.disabled).toBe(false)
      expect(tool.title).toBe(label)
    }
  } finally { act(() => root.unmount()); host.remove() }
})

it('keeps every folded tool actionable with the same callbacks and draft Changes refusal', () => {
  const host = document.createElement('div'), root = createRoot(host)
  document.body.append(host)
  const store = previewStore(), close = vi.fn()
  const browser = vi.spyOn(store, 'openBrowser').mockResolvedValue(undefined)
  const choose = vi.spyOn(store, 'chooseWorkTool').mockImplementation(() => {})
  const rail = vi.spyOn(store, 'toggleWorkRail').mockImplementation(() => {})
  try {
    act(() => root.render(<StoreProvider store={store}><Menu close={close}><WorkTools menu draft close={close} /></Menu></StoreProvider>))
    const rows = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    const row = (label: string) => rows.find(one => one.querySelector('[data-menu-label]')?.textContent === label)!
    expect(rows.map(one => one.querySelector('[data-menu-label]')?.textContent)).toEqual(['Toggle rail', 'Terminal', 'Changes', 'Browser', 'Files'])
    expect(row('Changes').getAttribute('aria-disabled')).toBe('true')
    expect(document.getElementById(row('Changes').getAttribute('aria-describedby')!)?.textContent).toBe('Available after the first message')
    act(() => row('Changes').click())
    expect(choose).not.toHaveBeenCalled()
    act(() => row('Browser').click())
    expect(browser).toHaveBeenCalledOnce()
    act(() => row('Files').click())
    expect(choose).toHaveBeenCalledWith('files', 'files', true)
    act(() => row('Terminal').click())
    expect(choose).toHaveBeenCalledWith('terminal', 'terminal', true)
    act(() => row('Toggle rail').click())
    expect(rail).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalled()
  } finally { act(() => root.unmount()); host.remove(); vi.restoreAllMocks() }
})

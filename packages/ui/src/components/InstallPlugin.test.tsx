import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { InstallPlugin } from './InstallPlugin'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('E7 install and confirm use shared Dialog slots with no title icon and footer actions', async () => {
  const box = document.createElement('div'); document.body.append(box)
  const root = createRoot(box), close = vi.fn()
  const request = vi.fn(async (method: string) => method === 'plugin/inspect'
    ? { id: 'sample', name: 'Sample plugin', description: 'Synthetic permissions example.', permissions: ['Read workspace files'], alreadyInstalled: true }
    : undefined)
  const store = { subscribe: () => () => {}, getSnapshot: emptySnapshot, transport: { request }, loadPlugins: vi.fn(), notice: vi.fn() } as unknown as AppStore
  try {
    await act(async () => root.render(<StoreProvider store={store}><InstallPlugin onClose={close} /></StoreProvider>))
    const dialog = document.querySelector('[role="dialog"]')!
    const head = dialog.querySelector('[data-slot="dialog-head"]')!
    expect(head.querySelector(':scope > span > svg')).toBeNull()
    expect(dialog.querySelector('[data-slot="modal-dialog-body"]')).toBeTruthy()
    const footer = dialog.querySelector('[data-slot="dialog-footer"]')!
    expect([...footer.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Continue', 'Cancel'])
    const input = dialog.querySelector('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '/work/plugins/sample')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => [...footer.querySelectorAll('button')].find(button => button.textContent === 'Continue')!.click())
    expect(request).toHaveBeenCalledWith('plugin/inspect', { specifier: '/work/plugins/sample' })
    expect(dialog.textContent).toContain('Read workspace files')
    expect(dialog.textContent).toContain('will be replaced')
    expect([...footer.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Install and enable', 'Back'])
    await act(async () => [...footer.querySelectorAll('button')].find(button => button.textContent === 'Install and enable')!.click())
    expect(request).toHaveBeenCalledWith('plugin/install', { specifier: '/work/plugins/sample' })
    expect(close).toHaveBeenCalledOnce()
  } finally { await act(async () => root.unmount()); box.remove() }
})

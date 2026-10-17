import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { StoreProvider } from '../state/context'
import { previewStore } from '../preview/harness'
import { WorkTools } from './WorkTools'

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

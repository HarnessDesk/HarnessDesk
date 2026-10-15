import { installTopBarTestLayout } from '../test/top-bar-layout'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { AppStore } from '../state/store'
import { StoreProvider } from '../state/context'
import * as harness from './harness'
import { NativeServersPreview } from './native-servers'

installTopBarTestLayout()

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('the real native-server Agent preview retains its registered Start handler and server content', async () => {
  const outer = harness.previewStore()
  const start = vi.spyOn(AppStore.prototype, 'startAsAgent').mockResolvedValue(null)
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<StoreProvider store={outer}><NativeServersPreview /></StoreProvider>))
    const entry = harness.PREVIEW_AGENTS[0]!
    const label = `Start a conversation as ${entry.definition!.name}`
    const button = [...host.querySelectorAll<HTMLButtonElement>('[data-slot="toolbar"] button')].find(button => button.textContent === label)
    expect(button).toBeTruthy()
    expect(button?.textContent).toBe(label)
    expect([...host.querySelectorAll('[data-slot="summary-item"]')].find(one => one.textContent?.startsWith('Native servers'))?.textContent).toBe('Native serversNone')
    expect(host.textContent).toContain(entry.definition!.description)
    await act(async () => button!.click())
    expect(start).toHaveBeenCalledWith(entry.id)
    expect(host.querySelectorAll('[data-slot="top-bar"]')).toHaveLength(1)
    expect(host.querySelector('[data-topbar-title]')).toBeNull()
    expect(host.querySelector('h1[data-role="page"]')?.textContent).toBe(entry.definition!.name)
    expect(host.querySelectorAll('[data-slot="detail-title"]')).toHaveLength(0)
  } finally {
    act(() => root.unmount()); host.remove(); start.mockRestore()
  }
})

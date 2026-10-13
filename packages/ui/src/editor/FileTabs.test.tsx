import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FileTabs } from './FileTabs'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })
it('selects and keeps preview tabs, with separate fixed trailing close slots', () => {
  const select = vi.fn(), keep = vi.fn(), close = vi.fn()
  act(() => root.render(<FileTabs tabs={[{ path: '/work/README.md', view: 'preview' }, { path: '/work/src/code.ts', view: 'source' }]}
    active="/work/src/code.ts" preview="/work/README.md" dirty={new Set(['/work/src/code.ts'])} onSelect={select} onKeep={keep} onClose={close} />))
  const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  expect(tabs.map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'true'])
  expect(tabs[0]?.getAttribute('data-preview')).toBe('')
  expect(tabs[1]?.getAttribute('aria-label')).toBe('code.ts, unsaved')
  expect(host.querySelectorAll('[data-slot="file-tab-trailing"]')).toHaveLength(2)
  expect(host.querySelectorAll('[data-slot="file-tab-unsaved"]')).toHaveLength(1)
  act(() => tabs[0]!.click()); expect(select).toHaveBeenCalledWith('/work/README.md')
  act(() => tabs[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))); expect(keep).toHaveBeenCalledWith('/work/README.md')
  const button = host.querySelector<HTMLButtonElement>('[aria-label="Close code.ts"]')!
  expect(button.closest('[role="tab"]')).toBeNull()
  act(() => button.click()); expect(close).toHaveBeenCalledWith('/work/src/code.ts')
})

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { LeftColumnGroup, LeftColumnRow } from './LeftColumn'
import { FolderIcon } from '../../components/Icons'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement, root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })
const mount = (node: ReactNode) => act(() => root.render(node))
const button = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!

test('a missing icon reserves its column; the only trailing action does not open its row', () => {
  const open = vi.fn(), more = vi.fn()
  mount(<LeftColumnGroup label="Projects">
    <LeftColumnRow label="Release notes · 長い会話名" onClick={open}
      trailing={{ kind: 'count', value: 3, label: '3 held messages' }}
      action={{ label: 'Actions for Release notes', onClick: more }} />
    <LeftColumnRow label="Another conversation" icon={<FolderIcon size={16} />} onClick={open} />
  </LeftColumnGroup>)
  expect(container.querySelectorAll('[data-slot="sidebar-menu-icon"]')).toHaveLength(2)
  expect(container.querySelectorAll('[data-left-trailing]')).toHaveLength(2)
  act(() => button('Actions for Release notes').click())
  expect(more).toHaveBeenCalledOnce()
  expect(open).not.toHaveBeenCalled()
  expect(container.querySelector('button button')).toBeNull()
  act(() => button('Another conversation').click())
  expect(open).toHaveBeenCalledOnce()
})

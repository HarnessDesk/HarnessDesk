import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { SubjectActionsMenu } from './SubjectActionsMenu'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

test('subject More preserves callbacks, refusal and Messages choice without controls in facts', () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const open = vi.fn(), refused = vi.fn(), change = vi.fn()
  try {
    act(() => root.render(<SubjectActionsMenu label="Scout" actions={[
      { label: 'Open', onSelect: open }, { label: 'Remove', disabled: 'This record cannot be changed.', onSelect: refused },
    ]} choice={{ label: 'Messages', value: 'hold', options: [
      { value: 'accept', label: 'Accept' }, { value: 'hold', label: 'Hold' }, { value: 'refuse', label: 'Refuse', disabled: 'This record cannot be changed.' },
    ], onChange: change }} />))
    act(() => container.querySelector('button')!.click())
    const row = (text: string) => [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(one => one.textContent?.startsWith(text))!
    const actionMenu = document.querySelector<HTMLElement>('[role="menu"]')!
    expect(actionMenu.closest('[data-popup-kind]')?.getAttribute('data-menu-icons')).toBe('all')
    expect([...actionMenu.querySelectorAll<HTMLElement>('[data-menu-row]')].every(item => item.querySelector('[data-menu-icon]'))).toBe(true)
    expect(row('Remove').getAttribute('aria-disabled')).toBe('true')
    act(() => row('Remove').click())
    act(() => row('Messages').click())
    const choiceMenu = [...document.querySelectorAll<HTMLElement>('[role="menu"]')].at(-1)!
    expect(choiceMenu.closest('[data-popup-kind]')?.getAttribute('data-menu-icons')).toBe('none')
    expect([...choiceMenu.querySelectorAll<HTMLElement>('[data-menu-row]')].every(item => !item.querySelector('[data-menu-icon]'))).toBe(true)
    act(() => row('Refuse').click())
    expect(refused).not.toHaveBeenCalled()
    expect(change).not.toHaveBeenCalled()
    act(() => row('Accept').click())
    expect(change).toHaveBeenCalledExactlyOnceWith('accept')
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    act(() => row('Messages').click())
    act(() => row('Open').click())
    expect(open).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="menu"]')).toBeNull()
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})

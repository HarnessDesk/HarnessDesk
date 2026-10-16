import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test } from 'vitest'
import { TopBar } from './TopBar'
import { Dot } from './Settings'
import { MenuItem } from './Menu'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

test('one bar keeps work state before its title and moves legacy controls into More', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  try {
    act(() => root.render(<TopBar place="Checkout retry" state={<Dot title="Working" pulse />} placeMenu={() => <MenuItem icon={<span />} label="Rename" onSelect={() => {}} />}
      parent={{ label: 'Teams', run: () => {} }} tabs={[{ value: 'board', label: 'Board', run: () => {} }]} tab="board"
      verb={{ label: 'Start a Team', run: () => {} }} view={{ content: () => <MenuItem icon={<span />} label="Thread" onSelect={() => {}} /> }} more={() => null} />))
    const bar = host.querySelector('[data-slot="top-bar"]')!
    expect(bar.querySelector('[role="tablist"]')).toBeNull()
    expect(bar.querySelector('[data-topbar="verb"] button')).toBeNull()
    expect(bar.querySelector('[data-topbar="view"] button')).toBeNull()
    expect(bar.querySelector('[data-topbar="place"] > button')).toBeNull()
    expect(bar.querySelector('[data-topbar="state"]')?.nextElementSibling?.hasAttribute('data-topbar-title')).toBe(true)
    await act(async () => host.querySelector<HTMLButtonElement>('[data-topbar="more"] button')!.click())
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Start a Team')
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Teams')
  } finally { act(() => root.unmount()); host.remove() }
})

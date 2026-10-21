import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { DestinationPageScope } from './destination-page'
import { TopBarProvider, TopBarOutlet } from './top-bar'
import { LibraryBar } from './library-bar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it.each(['skill', 'mcp'] as const)('%s keeps shared Customize sections and the appropriate action menus', async kind => {
  const box = document.createElement('div'); document.body.append(box)
  const root = createRoot(box), importing = vi.fn(), rescan = vi.fn(), check = vi.fn(), change = vi.fn(), author = vi.fn(), github = vi.fn()
  const snapshot = emptySnapshot(), openDestination = vi.fn()
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, openDestination } as unknown as AppStore
  const click = async (name: string, role = 'menuitem') => {
    const node = [...document.body.querySelectorAll<HTMLElement>(`[role="${role}"]`)].find(n => n.textContent === name)!
    expect(node).toBeTruthy()
    await act(async () => node.click())
  }
  const more = async () => act(async () => box.querySelector<HTMLButtonElement>('[aria-label="More"]')!.click())
  const add = async () => act(async () => box.querySelector<HTMLButtonElement>('[title="Add skill"]')!.click())
  try {
    await act(async () => root.render(<StoreProvider store={store}><TopBarProvider>
      <DestinationPageScope owner="destination:library" active><LibraryBar kind={kind} counts={{ skill: 4, mcp: 2 }} change={change} loaded loading={false}
        author={author} importing={importing} github={github} checking={false} check={check} rescan={rescan} /></DestinationPageScope>
      <TopBarOutlet owner="destination:library" fallback={{ place: 'Fallback', more: () => null }} />
    </TopBarProvider></StoreProvider>))
    expect(box.querySelector('[data-topbar-title]')).toBeNull()
    expect(box.querySelector('h1')?.textContent).toBe('Customize')
    expect(box.querySelector('[aria-label="Customize sections"] [aria-checked="true"]')?.textContent).toBe(kind === 'skill' ? 'Skills' : 'MCP')
    if (kind === 'skill') {
      await add()
      expect([...document.querySelectorAll('[role="menuitem"]')].map(n => n.textContent)).toEqual(['Write a skill', 'From GitHub…', 'Copy from another runtime…'])
      await click('Write a skill'); expect(author).toHaveBeenCalledOnce()
      await add(); await click('From GitHub…'); expect(github).toHaveBeenCalledOnce()
      await add(); await click('Copy from another runtime…'); expect(importing).toHaveBeenCalledOnce()
    } else {
      await act(async () => [...box.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === 'Import server')!.click())
      expect(importing).toHaveBeenCalledOnce()
      expect(author).not.toHaveBeenCalled()
    }
    await more()
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map(n => n.textContent)
    expect(labels).toEqual(['Check for updates', 'Rescan', 'Changes made here…'])
    await click('Check for updates'); expect(check).toHaveBeenCalledOnce()
    await more(); await click('Rescan'); expect(rescan).toHaveBeenCalledOnce()
    const choice = [...box.querySelectorAll<HTMLElement>('[aria-label="Customize sections"] [role="radio"]')].find(n => n.textContent === (kind === 'skill' ? 'MCP' : 'Skills'))!
    await act(async () => choice.click()); expect(change).toHaveBeenCalledWith(kind === 'skill' ? 'mcp' : 'skill')
    const plugins = [...box.querySelectorAll<HTMLElement>('[aria-label="Customize sections"] [role="radio"]')].find(n => n.textContent === 'Plugins')!
    await act(async () => plugins.click())
    expect(openDestination).toHaveBeenCalledWith({ kind: 'plugins', section: 'installed', id: null })
  } finally { act(() => root.unmount()); box.remove() }
})
it('disables Add skill and Check for updates until the library has been read', async () => {
  const box = document.createElement('div'); document.body.append(box)
  const root = createRoot(box), github = vi.fn()
  const snapshot = emptySnapshot(), openDestination = vi.fn()
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, openDestination } as unknown as AppStore
  try {
    await act(async () => root.render(<StoreProvider store={store}><TopBarProvider>
      <DestinationPageScope owner="destination:library" active><LibraryBar kind="skill" counts={{skill:0,mcp:0}} change={()=>{}} loaded={false} loading
        author={()=>{}} importing={()=>{}} github={github} checking={false} check={()=>{}} rescan={()=>{}} /></DestinationPageScope>
      <TopBarOutlet owner="destination:library" fallback={{place:'Fallback',more:()=>null}} />
    </TopBarProvider></StoreProvider>))
    expect(box.querySelector<HTMLButtonElement>('[title="Skills have not been read."]')?.disabled).toBe(true)
    await act(async () => box.querySelector<HTMLButtonElement>('[aria-label="More"]')!.click())
    const check = [...document.querySelectorAll('[role="menuitem"]')].find(n => n.textContent === 'Check for updates')!
    expect(check.getAttribute('aria-disabled')).toBe('true')
    expect(github).not.toHaveBeenCalled()
  } finally { act(() => root.unmount()); box.remove() }
})

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { DestinationPageScope } from './destination-page'
import { TopBarProvider, TopBarOutlet } from './top-bar'
import { LibraryBar } from './library-bar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('names Library in the body beside its verb and counted sections', async () => {
  const box = document.createElement('div'); document.body.append(box)
  const root = createRoot(box), importing = vi.fn(), rescan = vi.fn(), change = vi.fn(), author = vi.fn(), github = vi.fn()
  const snapshot = emptySnapshot()
  const store = {subscribe:()=>()=>{},getSnapshot:()=>snapshot} as unknown as AppStore
  try {
    await act(async () => root.render(<StoreProvider store={store}><TopBarProvider>
      <DestinationPageScope owner="destination:library" active><LibraryBar kind="skill" counts={{skill:4,mcp:2}}
        change={change} loaded loading={false} author={author} importing={importing} github={github} rescan={rescan}/></DestinationPageScope>
      <TopBarOutlet owner="destination:library" fallback={{place:'Fallback',more:()=>null}}/>
    </TopBarProvider></StoreProvider>))
    expect(box.querySelector('[data-topbar-title]')).toBeNull()
    expect(box.querySelector('[data-topbar="place"]')?.textContent).not.toContain('Settings')
    expect(box.querySelector('[data-slot="top-bar"] [role="tab"]')).toBeNull()
    const controls = box.querySelector('[data-slot="page-options"]')!
    expect(controls).not.toBeNull()
    expect(controls.querySelector('h1')?.textContent).toBe('Library')
    expect(controls.querySelector('[data-page-head] button')?.textContent).toBe('New skill')
    expect(controls.querySelector('[title="Library sections"]')?.textContent).toBe('Skills4')
    await act(async () => controls.querySelector<HTMLButtonElement>('button')!.click())
    expect(author).toHaveBeenCalledOnce()
    await act(async () => controls.querySelector<HTMLButtonElement>('[title="Library sections"]')!.click())
    const sections = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
    expect(sections.map(node => node.textContent)).toEqual(['Skills4', 'MCP servers2'])
    await act(async () => sections.find(node => node.textContent?.startsWith('MCP servers'))!.click())
    expect(change).toHaveBeenCalledWith('mcp')
    await act(async () => box.querySelector<HTMLButtonElement>('[aria-label="More"]')!.click())
    const actions = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    const labels = actions.map(node=>node.textContent)
    expect(labels.filter(label=>label==='Import')).toHaveLength(1)
    expect(labels.filter(label=>label==='Rescan')).toHaveLength(1)
    expect(labels.indexOf('Add from GitHub…')).toBe(labels.indexOf('Import') + 1)
    await act(async () => actions.find(node=>node.textContent==='Add from GitHub…')!.click())
    expect(github).toHaveBeenCalledOnce()
    await act(async () => box.querySelector<HTMLButtonElement>('[aria-label="More"]')!.click())
    expect(labels).not.toContain('Terminal')
    expect(labels).not.toContain(['Back', 'to', 'app'].join(' '))
    await act(async () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node=>node.textContent==='Import')!.click())
    expect(importing).toHaveBeenCalledOnce()
    expect(rescan).not.toHaveBeenCalled()
  } finally { act(() => root.unmount()); box.remove() }
})

it('disables GitHub and Import until the library has been read', async () => {
  const box = document.createElement('div'); document.body.append(box)
  const root = createRoot(box), github = vi.fn()
  const snapshot = emptySnapshot()
  const store = {subscribe:()=>()=>{},getSnapshot:()=>snapshot} as unknown as AppStore
  try {
    await act(async () => root.render(<StoreProvider store={store}><TopBarProvider>
      <DestinationPageScope owner="destination:library" active><LibraryBar kind="skill" counts={{skill:0,mcp:0}}
        change={()=>{}} loaded={false} loading author={()=>{}} importing={()=>{}} github={github} rescan={()=>{}} /></DestinationPageScope>
      <TopBarOutlet owner="destination:library" fallback={{place:'Fallback',more:()=>null}}/>
    </TopBarProvider></StoreProvider>))
    await act(async () => box.querySelector<HTMLButtonElement>('[aria-label="More"]')!.click())
    for (const label of ['Import', 'Add from GitHub…']) {
      const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(n=>n.textContent===label)!
      expect(item).toBeTruthy()
      expect(item.getAttribute('aria-disabled')).toBe('true')
      await act(async () => item.click())
    }
    expect(github).not.toHaveBeenCalled()
  } finally { act(() => root.unmount()); box.remove() }
})

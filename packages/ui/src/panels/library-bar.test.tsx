import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { DestinationPageScope } from './destination-page'
import { TopBarProvider, TopBarOutlet } from './top-bar'
import { LibraryBar } from './library-bar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('keeps the Library title in its bar and starts the body with its verb and counted sections', async () => {
  const box = document.createElement('div'); document.body.append(box)
  const root = createRoot(box), importing = vi.fn(), rescan = vi.fn(), change = vi.fn(), author = vi.fn()
  const snapshot = emptySnapshot()
  const store = {subscribe:()=>()=>{},getSnapshot:()=>snapshot} as unknown as AppStore
  try {
    await act(async () => root.render(<StoreProvider store={store}><TopBarProvider>
      <DestinationPageScope owner="destination:library" active><LibraryBar kind="skill" counts={{skill:4,mcp:2}}
        change={change} loaded loading={false} author={author} importing={importing} rescan={rescan}/></DestinationPageScope>
      <TopBarOutlet owner="destination:library" fallback={{place:'Fallback',more:()=>null}}/>
    </TopBarProvider></StoreProvider>))
    expect(box.querySelector('[data-topbar-title]')?.textContent).toBe('Library')
    expect(box.querySelector('[data-topbar="place"]')?.textContent).not.toContain('Settings')
    expect(box.querySelector('[data-slot="top-bar"] [role="tab"]')).toBeNull()
    const controls = box.querySelector('[data-slot="page-options"]')!
    expect(controls).not.toBeNull()
    expect(controls.firstElementChild?.textContent).toBe('New skill')
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
    expect(labels).not.toContain('Terminal')
    expect(labels).not.toContain(['Back', 'to', 'app'].join(' '))
    await act(async () => actions.find(node=>node.textContent==='Import')!.click())
    expect(importing).toHaveBeenCalledOnce()
    expect(rescan).not.toHaveBeenCalled()
  } finally { act(() => root.unmount()); box.remove() }
})

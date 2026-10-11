import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TopBar } from '../design'
import { FRAME } from '../design/frame'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root, constrained = false, worded = false, budgetOnly = false
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  constrained = false; worded = false; budgetOnly = false
  const computed = getComputedStyle
  vi.spyOn(globalThis,'getComputedStyle').mockImplementation((node,pseudo) => {
    const css = computed(node,pseudo)
    return node.matches('[data-slot="top-bar"]') ? new Proxy(css,{get(target,key) {
      if (key==='getPropertyValue') return (name:string) => name==='--hd-bar-title-min' ? `${FRAME.bar.titleMin}px` : name==='--hd-bar-gap' ? '6px' : target.getPropertyValue(name)
      const value = Reflect.get(target,key,target); return typeof value==='function' ? value.bind(target) : value
    }}) : css
  })
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement) {
    const row = this.closest('[data-slot="top-bar"]'), fold = Number(row?.getAttribute('data-fold'))
    const parents = row?.querySelectorAll('[data-topbar="place"] button').length ?? 0
    if (this.matches('[data-topbar-title]')) return new DOMRect(0,0,budgetOnly ? 200 : constrained && (parents>1 || worded && fold<3) ? 80 : 200,40)
    if (this.matches('[data-topbar="place"]')) return new DOMRect(0,0,budgetOnly ? 360 : 720,40)
    if (this.matches('[data-topbar-mark]')) return new DOMRect(0,0,16,16)
    if (this.matches('button')) return new DOMRect(0,0,60,28)
    return new DOMRect(0,0,720,40)
  })
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks() })
const mount = () => {
  const settings=vi.fn(), runtimes=vi.fn(), alpha=vi.fn(), verb=vi.fn()
  act(() => root.render(<TopBar place="Jane Doe" mark={<span data-testid="agent-mark" />} parents={[
    {label:'Settings',run:settings},{label:'Runtimes',run:runtimes},{label:'Alpha',run:alpha},
  ]} verb={worded ? {label:'Start a conversation',run:verb} : undefined} more={()=>null} />))
  return {settings,runtimes,alpha,verb}
}
it('shows linked ancestors and the mark before the title when there is room', () => {
  const callbacks=mount()
  const place=host.querySelector('[data-topbar="place"]')!
  expect([...place.querySelectorAll('button')].map(node=>node.textContent)).toEqual(['Settings ›','Runtimes ›','Alpha ›'])
  expect(place.querySelector('[data-topbar-mark]')?.nextElementSibling?.hasAttribute('data-topbar-title')).toBe(true)
  act(()=>place.querySelectorAll<HTMLButtonElement>('button')[1]!.click())
  expect(callbacks.runtimes).toHaveBeenCalledOnce()
})
for (const fold of [2,3]) it(`retains the immediate parent and older More actions at fold ${fold}`, async () => {
  constrained=true; worded=fold===3
  const callbacks=mount()
  expect(host.querySelector('[data-slot="top-bar"]')?.getAttribute('data-fold')).toBe(String(fold))
  const links=[...host.querySelectorAll<HTMLButtonElement>('[data-topbar="place"] button')]
  expect(links.map(node=>node.textContent)).toEqual(['Alpha ›'])
  act(()=>links[0]!.click()); expect(callbacks.alpha).toHaveBeenCalledOnce()
  await act(async()=>host.querySelector<HTMLButtonElement>('[data-topbar="more"] button')!.click())
  const items=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  expect(items.map(node=>node.textContent?.trim())).toEqual(fold===3 ? ['Start a conversation','Settings','Runtimes'] : ['Settings','Runtimes'])
  if (fold===3) expect(items[0]!.nextElementSibling?.getAttribute('role')).toBe('separator')
  await act(async()=>items.find(node=>node.textContent==='Settings')!.click())
  expect(callbacks.settings).toHaveBeenCalledOnce()
  expect(document.querySelector('[role="menu"]')).toBeNull()
})
it('includes every ancestor and the mark in the available title budget', () => {
  budgetOnly=true
  mount()
  expect(host.querySelector('[data-slot="top-bar"]')?.getAttribute('data-fold')).toBe('2')
  expect(host.querySelectorAll('[data-topbar="place"] button')).toHaveLength(1)
})

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PanelActionMenuItems } from './PanelActions'
import { Menu } from '../design'
import type { MountControls } from './mount'

const { control } = vi.hoisted(() => ({ control: { current: null as MountControls | null } }))
vi.mock('./mount', () => ({ useMountControls: () => control.current }))
vi.mock('./views', () => ({ useViewTitle: () => () => 'Team' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let box: HTMLDivElement
beforeEach(() => {
 box = document.createElement('div'); document.body.append(box); root = createRoot(box)
 control.current = { chrome:'own', zoom:null, zoomScope:'window', destinations:['right'], canClose:true,
  view:{kind:'room',room:'demo'}, setZoom:vi.fn(), moveTo:vi.fn(), close:vi.fn() } as unknown as MountControls
})
afterEach(() => { act(() => root.unmount()); box.remove() })
const render = () => {
 const close = vi.fn()
 act(() => root.render(<Menu close={close}><PanelActionMenuItems /></Menu>))
 return close
}
const press = (label: string) => {
 const item = [...box.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(one => one.textContent === label)!
 act(() => item.click())
}
it('puts the mount’s fill, move and close actions in the existing menu', () => {
 const close = render()
 press('Fill the window'); expect(control.current!.setZoom).toHaveBeenCalledWith('window')
 press('To the right panel'); expect(control.current!.moveTo).toHaveBeenCalledWith('right')
 press('Close Team'); expect(control.current!.close).toHaveBeenCalledOnce()
 expect(close).toHaveBeenCalledTimes(3)
})
it('restores the scope already held, including a window zoom on a dock', () => {
 control.current = {...control.current!, zoom:'window', zoomScope:'content', canClose:false, destinations:[]}
 render(); press('Back to the layout')
 expect(control.current.setZoom).toHaveBeenCalledWith('window')
 expect(box.textContent).not.toContain('Close'); expect(box.textContent).not.toContain('Move')
})
it('leaves the actions to panel chrome, and draws nothing outside a mount', () => {
 control.current = {...control.current!, chrome:'panel'}; render()
 expect(box.textContent).toBe('')
 control.current = null; render(); expect(box.textContent).toBe('')
})

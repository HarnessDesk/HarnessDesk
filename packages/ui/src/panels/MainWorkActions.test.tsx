import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MainWorkActions } from './MainWorkActions'
import type { MountControls } from './mount'
const { control } = vi.hoisted(() => ({ control: { current: null as MountControls | null } }))
vi.mock('./mount', () => ({ useMountControls: () => control.current }))
vi.mock('./views', () => ({ useViewTitle: () => () => 'Team' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, box: HTMLDivElement
beforeEach(() => { box = document.createElement('div'); document.body.append(box); root = createRoot(box)
 control.current = { area:'main', zoom:null, zoomScope:'window', canClose:true, view:{kind:'room',room:'demo'}, setZoom:vi.fn(), close:vi.fn() } as unknown as MountControls })
afterEach(() => { act(() => root.unmount()); box.remove() })
const render = () => act(() => root.render(<MainWorkActions />))
const press = (label: string) => act(() => box.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click())
it('keeps work Fill and close while retiring arrangement actions', () => {
 render(); press('Fill the window'); expect(control.current!.setZoom).toHaveBeenCalledWith('window')
 press('Close Team'); expect(control.current!.close).toHaveBeenCalledOnce()
 expect(box.querySelectorAll('button')).toHaveLength(2)
})
it('restores the scope actually held and excludes a meaningless close', () => {
 control.current = {...control.current!, zoom:'content', canClose:false}; render(); press('Back to the layout')
 expect(control.current.setZoom).toHaveBeenCalledWith('content'); expect(box.textContent).not.toContain('Close')
})
it('does not give fixed or transitional side tools arrangement controls', () => {
 for (const area of ['right','bottom','sidebar'] as const) { control.current = {...control.current!, area}; render(); expect(box.childElementCount).toBe(0) }
 control.current = null; render(); expect(box.childElementCount).toBe(0)
})

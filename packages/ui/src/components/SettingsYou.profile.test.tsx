import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { AppearanceSection } from './SettingsYou'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement, root: Root
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === name)!
const mount = (appIcon: unknown = null) => {
 let snapshot = { ...emptySnapshot(), appIcon }
 const listeners = new Set<() => void>()
 const setAppIcon = vi.fn((appIcon: unknown) => { snapshot = { ...snapshot, appIcon }; listeners.forEach(one => one()) })
 const store = { getSnapshot: () => snapshot, subscribe: (one: () => void) => { listeners.add(one); return () => listeners.delete(one) }, setAppIcon } as unknown as AppStore
 act(() => root.render(<StoreProvider store={store}><AppearanceSection /></StoreProvider>))
 act(() => button('Change…').click())
 return { setAppIcon, value: () => snapshot.appIcon }
}
const radios = () => [...document.querySelectorAll<HTMLButtonElement>('[data-slot="picture-choices"] [role="radio"]')]
const selected = () => radios().find(one => one.getAttribute('aria-checked') === 'true')!
const press = (node: HTMLElement, key: string) => {
 const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
 act(() => node.dispatchEvent(event)); return event.defaultPrevented
}
it('keeps one keyboard stop and chooses artwork with arrows in the existing eight-column grid', () => {
 const { value } = mount()
 expect(radios().filter(one => one.tabIndex === 0)).toEqual([selected()])
 press(selected(), 'ArrowRight'); expect(value()).toBe('mark-paper')
 press(selected(), 'ArrowDown'); expect(selected()).toBe(radios()[9])
 expect(document.activeElement).toBe(selected())
})
it.each(['future-icon', { kind: 'image', src: 'a.png' }])('retains unknown app artwork without checking Default: %s', kept => {
 const { setAppIcon, value } = mount(kept)
 expect(radios().filter(one => one.getAttribute('aria-checked') === 'true')).toHaveLength(0)
 expect(radios().filter(one => one.tabIndex === 0)).toEqual([radios()[0]])
 const group = document.querySelector('[data-slot="picture-choices"]')!
 expect(document.getElementById(group.getAttribute('aria-describedby')!)?.textContent).toContain('cannot draw')
 expect(press(radios()[0]!, 'ArrowLeft')).toBe(true); expect(press(radios()[0]!, 'ArrowUp')).toBe(true)
 expect(press(radios()[0]!, 'Home')).toBe(false); expect(press(radios()[0]!, 'End')).toBe(false)
 expect(setAppIcon).not.toHaveBeenCalled(); expect(value()).toEqual(kept)
 act(() => radios().find(one => one.getAttribute('aria-label') === 'Wizard')!.click())
 expect(value()).toBe('wizard'); expect(group.hasAttribute('aria-describedby')).toBe(false)
})
it('does not choose with Right/Down at the last tile or Left/Up at the first', () => {
 const { setAppIcon } = mount('beach')
 expect(press(selected(), 'ArrowRight')).toBe(true); expect(press(selected(), 'ArrowDown')).toBe(true)
 expect(setAppIcon).not.toHaveBeenCalled()
})
it('Restore default writes an explicit null and Done closes the dialog', () => {
 const { setAppIcon } = mount('wizard')
 act(() => button('Restore default').click()); expect(setAppIcon).toHaveBeenLastCalledWith(null)
 expect(selected().getAttribute('aria-label')).toBe('Default')
 act(() => button('Done').click()); expect(document.querySelector('[role="dialog"]')).toBeNull()
})

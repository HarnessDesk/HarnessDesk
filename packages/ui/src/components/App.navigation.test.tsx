import { App } from '../app/App'
import { installTopBarTestLayout } from '../test/top-bar-layout'
import { frameDestinationStore } from '../preview/frame-destination-store'
import { previewStore } from '../preview/harness'
import { StoreProvider } from '../state/context'
import { useEscapeSurface } from '../design'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
installTopBarTestLayout()
let container: HTMLDivElement, root: ReturnType<typeof createRoot>
beforeEach(() => { container=document.createElement('div'); document.body.append(container); root=createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })
const escape = async (target: Document | Window = document) => { const event=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}); await act(async () => { target.dispatchEvent(event) }); return event.defaultPrevented }
const menu = () => document.querySelector('[data-slot="popover-popup"]')
it('the surface on top answers, and the pane below hears that the key is spent (#206)', async () => {
  const under = vi.fn()
  const over = vi.fn()
  const Surface = ({ close }: { close: () => void }) => {
    useEscapeSurface(true, close)
    return null
  }
  await act(async () => {
    root.render(
      <>
        <Surface close={under} />
        <Surface close={over} />
      </>,
    )
  })

  // Stands in for the approval card: a window listener added in an effect,
  // which is to say after the stack's own.
  const spent: boolean[] = []
  const inThePane = (event: KeyboardEvent): void => void spent.push(event.defaultPrevented)
  window.addEventListener('keydown', inThePane)

  expect(await escape(window)).toBe(true)
  // The one opened last is the one being looked at.
  expect(over).toHaveBeenCalledTimes(1)
  expect(under).not.toHaveBeenCalled()
  expect(spent).toEqual([true])

  act(() => root.unmount())
  root = createRoot(container)
  await escape()
  // Left the stack with the surfaces: an unmounted window answers nothing.
  expect(over).toHaveBeenCalledTimes(1)
  expect(spent).toEqual([true, false])
  window.removeEventListener('keydown', inThePane)
})

it('the main Settings column spends Escape on its menu and float while retaining the page', async () => {
  const store=frameDestinationStore(previewStore())
  store.setWindowSize(720,900)
  store.openDestination({kind:'settings',route:{kind:'section',section:'appearance',focus:null}})
  const frame=()=>act(async()=>{await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))})
  await act(async()=>root.render(<StoreProvider store={store}><App/></StoreProvider>));await frame()
  const show=container.querySelector<HTMLButtonElement>('button[aria-label="Show sidebar"]')!
  act(()=>show.focus())
  await act(async()=>show.click());await frame()
  const column=container.querySelector<HTMLElement>('[data-left-column]')!
  await act(async()=>column.querySelector<HTMLButtonElement>('[data-left-seat] [data-slot="popover-trigger"]')!.click())
  expect(menu()).not.toBeNull()
  expect(await escape()).toBe(true);await frame();expect(menu()).toBeNull()
  expect(store.getSnapshot().sidebarFloating).toBe(true)
  expect(await escape()).toBe(true);await frame();expect(store.getSnapshot().sidebarFloating).toBe(false)
  expect(document.activeElement).toBe(show)
  expect(store.getSnapshot().workbench.navigation.current.kind).toBe('settings')
  expect(await escape()).toBe(true)
  expect(store.getSnapshot().workbench.navigation.current.kind).toBe('work')
  expect(container.querySelector('[data-slot="app-window"]')).toBeNull()
})

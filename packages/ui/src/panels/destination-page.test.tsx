import { emptySnapshot } from '../state/store'
import { dock } from '../state/workbench'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { StoreProvider } from '../state/context'
import { previewStore } from '../preview/harness'
import { installTopBarTestLayout } from '../test/top-bar-layout'
import { TopBarOutlet, TopBarProvider, useRegisteredOwner } from './top-bar'
import { DestinationBar, DestinationPageScope, useDestinationActive } from './destination-page'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
installTopBarTestLayout()
let host: HTMLDivElement, root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })
const Claim = () => <span data-registered={useRegisteredOwner('destination:library')} />
const Activity = () => <output>{String(useDestinationActive())}</output>
it('shared readers default to active and follow page deactivation and return', () => {
  act(() => root.render(<Activity />))
  expect(host.textContent).toBe('true')
  for (const active of [false, true]) {
    act(() => root.render(<DestinationPageScope owner="destination:settings" active={active}><Activity /></DestinationPageScope>))
    expect(host.textContent).toBe(String(active))
  }
})
it('withdraws an inactive page claim and restores it on the next visit', () => {
  const store = previewStore()
  const render = (active: boolean) => act(() => root.render(<StoreProvider store={store}><TopBarProvider>
    <DestinationPageScope owner="destination:library" active={active}><DestinationBar place="Library" /></DestinationPageScope>
    <DestinationPageScope owner="destination:agents" active={false}><DestinationBar place="Agents" more={() => <span>Page actions</span>} /></DestinationPageScope>
    <Claim /><TopBarOutlet owner="destination:library" fallback={{place:'Fallback',more:()=>null}} />
  </TopBarProvider></StoreProvider>))
  render(true)
  expect(host.querySelector('[data-registered]')?.getAttribute('data-registered')).toBe('true')
  expect(host.querySelector('[data-topbar-title]')).toBeNull()
  render(false)
  expect(host.querySelector('[data-registered]')?.getAttribute('data-registered')).toBe('false')
  expect(host.querySelector('[data-topbar-title]')?.textContent).toBe('Fallback')
  render(true)
  expect(host.querySelector('[data-topbar-title]')).toBeNull()
})
for (const width of [720,1440]) it(`uses the existing work lead and corner policy at ${width}`, () => {
  const store = previewStore({windowWidth:width,narrowWindow:width<1000,sidebarCollapsed:true,sidebarFloating:false})
  store.setWindowSize(width, 900)
  act(() => root.render(<StoreProvider store={store}><TopBarProvider>
    <DestinationPageScope owner="destination:library" active><DestinationBar place="Library" /></DestinationPageScope>
    <TopBarOutlet owner="destination:library" fallback={{place:'Fallback',more:()=>null}} />
  </TopBarProvider></StoreProvider>))
  const labels = [...host.querySelectorAll('[data-topbar="lead"] button')].map(node=>node.getAttribute('aria-label'))
  expect(labels).toEqual(['Show sidebar'])
  expect(host.querySelector('[data-slot="bar"]')?.hasAttribute('data-corner')).toBe(true)
  expect(host.querySelectorAll('[data-work-tool], [data-topbar="view"] button')).toHaveLength(0)
})

it('folderless page omits retained terminals, Settings leaves its title in the body, and review uses its root', async () => {
  const base = emptySnapshot()
  const store = previewStore({ workspace: null, workbench: dock(base.workbench, 'bottom', { kind: 'terminal', terminalId: 'retained-pty', runtime: 'fixture' as never, cwd: '/synthetic/shell' }) })
  store.patch({ workbench: { ...store.getSnapshot().workbench, navigation: { ...base.workbench.navigation, current: { kind: 'agents', id: null } } } })
  const render = (owner: string) => act(() => root.render(<StoreProvider store={store}><TopBarProvider>
    <DestinationPageScope owner={owner} active><DestinationBar place="Agents" more={() => <span>Page actions</span>} /></DestinationPageScope>
    <TopBarOutlet owner={owner} fallback={{ place: 'Fallback', more: () => null }} />
  </TopBarProvider></StoreProvider>))
  render('destination:agents')
  const more = host.querySelector<HTMLButtonElement>('[data-topbar="more"] button')
  expect(more).not.toBeNull()
  await act(async () => more!.click())
  expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(0)
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('Terminal')
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('Page actions')
  await act(async () => more!.click())
  act(() => store.patch({ workbench: { ...store.getSnapshot().workbench, navigation: { ...base.workbench.navigation,
    current: { kind: 'settings', route: { kind: 'section', section: 'general', focus: null } } } } }))
  render('destination:settings')
  expect(host.querySelector('[data-topbar="more"] button')).toBeNull()
  expect(host.querySelector('[data-topbar-title]')).toBeNull()
  act(() => store.patch({ workbench: { ...store.getSnapshot().workbench, navigation: { ...base.workbench.navigation,
    current: { kind: 'changes-review', root: '/synthetic/review', returnTo: { kind: 'conversation', session: null } } } } }))
  render('destination:changes-review')
  await act(async () => host.querySelector<HTMLButtonElement>('[data-topbar="more"] button')!.click())
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('Terminal')
  expect(document.querySelector('[role="menuitemradio"]')?.textContent).toContain('Terminal')
})

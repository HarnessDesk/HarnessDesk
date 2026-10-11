import { StrictMode, act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
import type { SettingsRoute } from '../state/destinations'

const native = vi.hoisted(() => ({run: (_action: string) => {}}))
vi.mock('../lib/desktop', () => ({ desktop: () => undefined, isDesktop: () => false,
  onOpenGoal: () => () => {}, onOpenSession: () => () => {}, onShortcut: (run: (action:string)=>void) => { native.run=run; return () => {} }, setTraySummary: () => {}, setWindowTitle: () => {} }))
vi.mock('../panels/Workbench', () => ({ Workbench: ({sidebar, pages, pageActive}: {sidebar:ReactNode;pages:ReactNode;pageActive:boolean}) =>
  <>{sidebar}<div data-slot="retained-work" hidden={pageActive} inert={pageActive}><input defaultValue="Remembered draft" /></div>{pages}</> }))
vi.mock('../components/Sidebar', () => ({ Sidebar: (props: Record<string, unknown>) => <div data-sidebar>
  {['Settings','Agents','Teams','Library','Plugins','Dashboard'].map((label, at) => <button key={label} onClick={() =>
    (props[['onOpenSettings','onOpenAgents','onOpenTeams','onOpenLibrary','onOpenPlugins','onOpenUsage'][at]!] as () => void)()}>{label}</button>)}
  <output data-selected>{String(props.activeDestination ?? '')}</output><output data-settings>{JSON.stringify(props.settings ? (props.settings as {section:string}).section : null)}</output>
</div> }))
vi.mock('../components/Notices', () => ({ Notices: () => null }))
vi.mock('../design', async importOriginal => ({...await importOriginal<object>(), Toaster: () => null}))
vi.mock('../state/theme', () => ({ useTheme: () => 'light' }))
vi.mock('../components/Settings', async importOriginal => {
  const { useShell } = await import('../panels/views')
  const { useDestinationActive } = await import('../panels/destination-page')
  return { ...await importOriginal<object>(), Settings: ({ route }: {route:SettingsRoute}) => {
    const shell = useShell(), active = useDestinationActive()
    return <div><output data-settings-route>{JSON.stringify(route)}</output><output data-active>{String(active)}</output>
      <button onClick={() => shell.openAgents('fixture-reviewer')}>Open its Agent</button><button onClick={shell.reviewImports}>Review imports</button></div>
  }}
})
vi.mock('../components/AgentsWindow', () => ({ AgentsWindow: ({focus}:{focus:string|null}) => <output data-agent-focus>{focus ?? 'Agent overview'}</output> }))
import { MAIN_PAGE_ENTRIES } from './main-page-entries'
import { App } from './App'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement, root: ReturnType<typeof createRoot>
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
})
afterEach(() => { act(() => root.unmount()); container.remove() })
const routedStore = (focus?: string) => {
  const store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), {status:'open',...(focus ? {settingsFor:'workspaces',settingsFocus:focus} : {})})
  store.refreshCatalogIfStale = vi.fn(async () => {})
  store.transport.request = vi.fn(async (method, params) => method==='workspace/open' ? {path:(params as {path:string}).path,name:'Synthetic project'} : method==='workspace/recent' ? [] : {}) as typeof store.transport.request
  return store
}
const settle = () => act(async()=>{await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))})
const click = async (label: string) => {await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(one=>one.textContent===label)!.click());await settle()}
it('keeps a project detail after consuming its one-shot request and mounts Settings in main', async () => {
  const store = routedStore('/synthetic/project')
  await act(async () => root.render(<StrictMode><StoreProvider store={store}><App /></StoreProvider></StrictMode>))
  expect(store.getSnapshot().workbench.navigation.current).toEqual({kind:'settings',route:{kind:'project',root:'/synthetic/project'}})
  expect(store.getSnapshot().settingsFor).toBeNull()
  expect(container.querySelector('[data-page-destination="settings"]')).not.toBeNull()
  expect(container.querySelector('[data-slot="retained-work"]')?.hasAttribute('hidden')).toBe(true)
})
it('an Agent destination deactivates retained Settings readers', async () => {
  const store = routedStore('/synthetic/project')
  await act(async () => root.render(<StoreProvider store={store}><App /></StoreProvider>))
  await settle()
  await click('Open its Agent')
  expect(container.querySelector('[data-agent-focus]')?.textContent).toBe('fixture-reviewer')
  expect(container.querySelector('[data-page-destination="settings"]')?.hasAttribute('hidden')).toBe(true)
  expect(container.querySelector('[data-active]')?.textContent).toBe('false')
})
for (const kind of ['dashboard','agents','teams','library','plugins'] as const) it(`all normal ${kind} doors use registration, normal selection and real Back/Forward`, async () => {
  const label = {dashboard:'Dashboard',agents:'Agents',teams:'Teams',library:'Library',plugins:'Plugins'}[kind]
  const previous=MAIN_PAGE_ENTRIES[kind]
  MAIN_PAGE_ENTRIES[kind] = ({page}) => <output data-future-page>{page.kind}</output>
  try {
    const store = routedStore()
    await act(async () => root.render(<StoreProvider store={store}><App /></StoreProvider>))
    await settle()
    const input = container.querySelector('input')!
    input.value = 'Draft retained across pages'
    await click(label)
    expect(store.getSnapshot().workbench.navigation.current.kind).toBe(kind)
    expect(container.querySelector('[data-selected]')?.textContent).toBe(kind)
    expect(container.querySelector('[data-settings]')?.textContent).toBe('null')
    expect(container.querySelector(`[data-page-destination="${kind}"]`)?.hasAttribute('hidden')).toBe(false)
    await act(async () => { await store.navigateBack() });await settle()
    expect(store.getSnapshot().workbench.navigation.current.kind).toBe('work')
    expect(container.querySelector('input')).toBe(input)
    expect(input.value).toBe('Draft retained across pages')
    await act(async () => { await store.navigateForward() });await settle()
    expect(store.getSnapshot().workbench.navigation.current.kind).toBe(kind)
  } finally { MAIN_PAGE_ENTRIES[kind]=previous }
})
it('page Escape remains on Settings while Command-W returns to retained work', async () => {
  const store = routedStore('/synthetic/project')
  await act(async () => root.render(<StoreProvider store={store}><App /></StoreProvider>))
  act(() => document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})))
  expect(store.getSnapshot().workbench.navigation.current.kind).toBe('settings')
  await settle()
  act(() => document.dispatchEvent(new KeyboardEvent('keydown',{key:'w',metaKey:true,bubbles:true,cancelable:true})))
  await settle()
  expect(store.getSnapshot().workbench.navigation.current.kind).toBe('work')
})

it('the native Dashboard command enters the common registered page boundary', async () => {
  const previous=MAIN_PAGE_ENTRIES.dashboard
  MAIN_PAGE_ENTRIES.dashboard = ({page}) => <output>{page.kind}</output>
  try {
    const store = routedStore()
    await act(async () => root.render(<StoreProvider store={store}><App /></StoreProvider>))
    act(() => native.run('usage'))
    expect(store.getSnapshot().workbench.navigation.current).toEqual({kind:'dashboard',view:'overview',scope:null})
  } finally { MAIN_PAGE_ENTRIES.dashboard=previous }
})

it('repeated compatibility requests route Library and Plugins through the retained registry',async()=>{
  const saved={library:MAIN_PAGE_ENTRIES.library,plugins:MAIN_PAGE_ENTRIES.plugins}
  MAIN_PAGE_ENTRIES.library=({libraryImportIntent})=><output data-import-intent>{libraryImportIntent}</output>
  MAIN_PAGE_ENTRIES.plugins=()=> <output data-plugins>Plugins</output>
  try {
    const store=routedStore()
    await act(async()=>root.render(<StoreProvider store={store}><App/></StoreProvider>))
    await click('Settings');await click('Review imports')
    expect(store.getSnapshot().workbench.navigation.current).toEqual({kind:'library',section:'skill'})
    expect(container.querySelector('[data-import-intent]')?.textContent).toBe('1')
    expect(container.querySelector('[data-active]')?.textContent).toBe('false')
    for(const section of ['plugins','library','plugins'] as const) {
      await act(async()=>store.askSettings(section));await settle();await settle()
      expect(container.querySelector(`[data-page-destination="${section}"]`)?.hasAttribute('hidden')).toBe(false)
      expect(store.getSnapshot().settingsFor).toBeNull()
    }
    await act(async()=>store.returnToWork());await click('Settings')
    expect(container.querySelector('[data-active]')?.textContent).toBe('true')
  } finally { Object.assign(MAIN_PAGE_ENTRIES,saved) }
})
it('real bracket history remains available at720 with the column closed',async()=>{
  const store=routedStore();store.setWindowSize(720,900)
  await act(async()=>root.render(<StoreProvider store={store}><App/></StoreProvider>))
  await click('Settings')
  expect(store.getSnapshot().sidebarFloating).toBe(false)
  await act(async()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'[',metaKey:true,bubbles:true,cancelable:true})));await settle()
  expect(store.getSnapshot().workbench.navigation.current.kind).toBe('work')
  await act(async()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:']',metaKey:true,bubbles:true,cancelable:true})));await settle()
  expect(store.getSnapshot().workbench.navigation.current.kind).toBe('settings')
  expect(store.getSnapshot().sidebarFloating).toBe(false)
})
it('a native new draft reveals work while deactivating the retained Agent page',async()=>{
  const store=routedStore('/synthetic/project')
  await act(async()=>root.render(<StoreProvider store={store}><App/></StoreProvider>));await settle();await click('Open its Agent')
  expect(container.querySelector('[data-agent-focus]')).not.toBeNull()
  await act(async()=>native.run('new-session'));await settle()
  expect(store.getSnapshot().workbench.navigation.current.kind).toBe('work')
  expect(container.querySelector('[data-page-destination="agents"]')?.hasAttribute('hidden')).toBe(true)
})

it('E9 delivers separate Library import events and resets the counter with the project', async () => {
  const previous = MAIN_PAGE_ENTRIES.library
  MAIN_PAGE_ENTRIES.library = ({libraryImportIntent}) => <output data-import-intent>{libraryImportIntent}</output>
  try {
    const store = routedStore()
    await act(async () => root.render(<StoreProvider store={store}><App /></StoreProvider>))
    await click('Settings'); await click('Review imports')
    expect(container.querySelector('[data-import-intent]')?.textContent).toBe('1')
    await click('Settings'); await click('Review imports')
    expect(container.querySelector('[data-import-intent]')?.textContent).toBe('2')
    await act(async () => { await store.openWorkspace('/synthetic/second') }); await settle()
    await click('Library')
    expect(container.querySelector('[data-import-intent]')?.textContent).toBe('0')
  } finally { MAIN_PAGE_ENTRIES.library = previous }
})
